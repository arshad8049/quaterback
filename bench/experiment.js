/**
 * bench/experiment.js — immutable, pinned experiment records (QB-29).
 *
 * An experiment is one directory:
 *   <root>/<experiment_id>/manifest.json            qb-experiment/1 (written once)
 *   <root>/<experiment_id>/dirty.patch              exploratory only: the archived uncommitted QB changes
 *   <root>/<experiment_id>/trials/<trial_id>/<arm>/ one arm of one trial: its artifacts + result.json
 *
 * Guarantees (docs/bench/experiments.md):
 *   - nothing is overwritten: every file is created exclusively ('wx'); recording the same
 *     trial/arm twice throws;
 *   - pins are artifacts, not names: QB commit (an OFFICIAL experiment refuses a dirty tree;
 *     an exploratory one archives and hashes the diff), agent adapter + CLI version, image
 *     digests, Node, grader file hashes, spec hashes, config hash;
 *   - loadExperiment re-hashes every stored artifact and refuses a mismatch or a missing
 *     file, naming it. The hashes detect corruption/tampering by anyone who does not also
 *     rewrite the recorded hash — they are not signatures;
 *   - REPORTING is reproducible from the stored files; re-running an agent is not (a new
 *     run is a new trial).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const proc = require('../lib/proc');
const S = require('./schemas');

const QB_ROOT = path.join(__dirname, '..');
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The single grader hash a qb-grade/1 must carry: the canonical hash of the pinned grader files. */
const graderHash = (files) => S.hashOf(files);

const writeOnce = (file, data) => fs.writeFileSync(file, data, { flag: 'wx', mode: 0o644 });
const toBytes = (v) => (Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v) : Buffer.from(`${JSON.stringify(v, null, 2)}\n`));

// ── Pins ──────────────────────────────────────────────────────────────────────

/** stdout of a successful argv command (lib/proc.js, never a shell), or null. */
function output(cmd, args, opts = {}) {
  const r = proc.run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return !r.error && r.status === 0 ? r.stdout : null;
}

const defaultProbes = {
  git: (args, cwd) => proc.git(args, cwd, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
  claudeVersion: () => {
    const out = output('claude', ['--version'], { timeout: 15_000 });
    return (out && out.trim()) || 'unknown';
  },
  imageDigest: (ref) => {
    try {
      const out = output('docker', ['image', 'inspect', ref], { timeout: 30_000 });
      if (out === null) return 'unknown';
      const [info] = JSON.parse(out);
      const repo = (info.RepoDigests || []).map((d) => d.split('@')[1]).find((d) => /^sha256:[0-9a-f]{64}$/.test(d || ''));
      const id = /^sha256:[0-9a-f]{64}$/.test(info.Id || '') ? info.Id : null;
      return repo || id || 'unknown';
    } catch { return 'unknown'; }
  },
  agentVersion: () => require('../lib/sandbox/agent').AGENT_VERSION,
  images: () => {
    const { AGENT_IMAGE } = require('../lib/sandbox/agent');
    const out = { agent: AGENT_IMAGE };
    try { out.proxy = require('../lib/sandbox/egress').PROXY_IMAGE; } catch { /* not exported */ }
    try { out.tools = require('../lib/sandbox/workspace').TOOLS_IMAGE; } catch { /* not exported */ }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => typeof v === 'string' && v));
  },
};

/**
 * Pin the actual artifacts this experiment runs with.
 * @param {{ kind: 'official'|'exploratory', qbRoot?: string, graderFiles?: string[], models?: object[], probes?: object }} o
 * @returns {{ pins: object, dirtyPatch: Buffer|null }}
 */
function collectPins({ kind, qbRoot = QB_ROOT, graderFiles = [], models = [], probes = {} } = {}) {
  const p = { ...defaultProbes, ...probes };
  const commit = p.git(['rev-parse', 'HEAD'], qbRoot).toString().trim();
  const status = p.git(['status', '--porcelain', '--untracked-files=all'], qbRoot).toString();
  const dirty = status.trim().length > 0;
  if (dirty && kind === 'official') {
    throw new Error(`official experiment refused: the QB checkout at ${qbRoot} has uncommitted changes (commit them, or run an exploratory experiment, which archives the diff):\n${status}`);
  }
  let dirtyPatch = null;
  if (dirty) {
    const diff = p.git(['diff', '--binary', 'HEAD'], qbRoot);
    const untracked = status.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3));
    const listing = untracked.map((f) => {
      const abs = path.join(qbRoot, f);
      let h = 'unreadable';
      try { h = S.sha256File(abs); } catch { /* gone */ }
      return `# untracked ${h} ${f}`;
    }).join('\n');
    dirtyPatch = Buffer.concat([Buffer.from(`# qb dirty archive for ${commit}\n${listing}${listing ? '\n' : ''}`), Buffer.from(diff)]);
  }
  const grader = {};
  for (const f of graderFiles) {
    const rel = path.relative(qbRoot, path.resolve(qbRoot, f)).split(path.sep).join('/');
    grader[rel] = S.sha256File(path.join(qbRoot, rel));
  }
  const images = Object.fromEntries(Object.entries(p.images()).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ref]) => [name, { ref, digest: p.imageDigest(ref) }]));
  const pins = {
    qb: { commit, dirty, dirty_patch_sha256: dirtyPatch ? S.sha256(dirtyPatch) : null },
    agent: { name: 'claude-code', adapter_version: p.agentVersion(), cli_version: p.claudeVersion() },
    images,
    node: process.version,
    grader: { files: grader },
    models,
  };
  return { pins, dirtyPatch };
}

// ── Creation ──────────────────────────────────────────────────────────────────

/** Every (task, repetition, arm) in task order, then repetition, then arm. QB-30 adds the seeded shuffle. */
function defaultOrder(tasks, arms, repetitions) {
  const order = [];
  for (const t of tasks) for (let r = 1; r <= repetitions; r++) for (const a of arms) order.push({ trial_id: `${t.id}-r${r}`, task_id: t.id, repetition: r, arm: a.id });
  return order;
}

function validatePlan(m) {
  const armIds = new Set(m.arms.map((a) => a.id));
  if (armIds.size !== m.arms.length) throw new Error('duplicate arm id');
  for (const a of m.primary_comparison) if (!armIds.has(a)) throw new Error(`primary comparison arm ${a} is not defined`);
  if (m.primary_comparison[0] === m.primary_comparison[1]) throw new Error('primary comparison needs two different arms');
  const taskIds = new Set(m.tasks.map((t) => t.id));
  if (taskIds.size !== m.tasks.length) throw new Error('duplicate task id');
  const seen = new Set();
  for (const o of m.trial_plan.order) {
    if (!taskIds.has(o.task_id)) throw new Error(`trial ${o.trial_id} names unknown task ${o.task_id}`);
    if (!armIds.has(o.arm)) throw new Error(`trial ${o.trial_id} names unknown arm ${o.arm}`);
    if (o.repetition > m.trial_plan.repetitions) throw new Error(`trial ${o.trial_id} repetition ${o.repetition} exceeds ${m.trial_plan.repetitions}`);
    const k = `${o.trial_id}/${o.arm}`;
    if (seen.has(k)) throw new Error(`trial ${k} planned twice`);
    seen.add(k);
  }
  const byTrial = new Map();
  for (const o of m.trial_plan.order) {
    const prev = byTrial.get(o.trial_id);
    if (prev && (prev.task_id !== o.task_id || prev.repetition !== o.repetition)) throw new Error(`trial ${o.trial_id} mixes tasks or repetitions`);
    byTrial.set(o.trial_id, o);
  }
}

/**
 * Create an experiment directory with its manifest. Nothing existing is overwritten.
 * @returns {{ dir: string, manifest: object }}
 */
function createExperiment(o) {
  const {
    dir, kind, tasks, arms, primary_comparison, budget, repetitions = 1, seed = 'none', order,
    config = {}, protocol = null, approval = null, memory = { starting_store_sha256: null },
    models = [], graderFiles = [], probes, qbRoot, pins: pinsOverride, experimentId, now = () => new Date(),
  } = o;
  if (!dir) throw new Error('createExperiment: dir is required');
  let pins; let dirtyPatch = null;
  if (pinsOverride) {
    pins = pinsOverride;
    if (kind === 'official' && pins.qb && pins.qb.dirty) throw new Error('official experiment refused: pinned QB checkout is dirty');
    if (pins.qb && pins.qb.dirty) {
      if (!o.dirtyPatch) throw new Error('a dirty pin needs its archived dirty patch');
      dirtyPatch = toBytes(o.dirtyPatch);
      if (S.sha256(dirtyPatch) !== pins.qb.dirty_patch_sha256) throw new Error('dirty patch does not match its pinned hash');
    }
  } else {
    ({ pins, dirtyPatch } = collectPins({ kind, qbRoot, graderFiles, models, probes }));
  }
  const created = now();
  const id = experimentId || `exp-${created.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const manifest = S.Experiment.parse({
    schema: 'qb-experiment/1',
    experiment_id: id,
    kind,
    created_at: created.toISOString(),
    protocol,
    approval,
    pins,
    tasks,
    arms,
    primary_comparison,
    budget,
    memory,
    trial_plan: { seed, repetitions, order: order || defaultOrder(tasks, arms, repetitions) },
    config,
    config_sha256: S.hashOf(config),
  });
  validatePlan(manifest);
  fs.mkdirSync(dir, { recursive: true });
  const expDir = path.join(dir, id);
  fs.mkdirSync(expDir);                         // throws EEXIST: an experiment id is never reused
  if (dirtyPatch) writeOnce(path.join(expDir, 'dirty.patch'), dirtyPatch);
  writeOnce(path.join(expDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: expDir, manifest };
}

// ── Recording ─────────────────────────────────────────────────────────────────

function readManifest(expDir) {
  const file = path.join(expDir, 'manifest.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: unreadable manifest (${e.message})`); }
  const r = S.Experiment.safeParse(raw);
  if (!r.success) throw new Error(`${file}: invalid qb-experiment/1 (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  const m = r.data;
  if (S.hashOf(m.config) !== m.config_sha256) throw new Error(`${file}: config does not match config_sha256`);
  validatePlan(m);
  if (m.pins.qb.dirty) {
    const dp = path.join(expDir, 'dirty.patch');
    if (!fs.existsSync(dp)) throw new Error(`${dp}: missing (the manifest pins a dirty QB checkout)`);
    if (S.sha256File(dp) !== m.pins.qb.dirty_patch_sha256) throw new Error(`${dp}: hash does not match pins.qb.dirty_patch_sha256`);
  }
  return m;
}

/**
 * Record one arm of one planned trial. `artifacts` maps a file name (e.g. 'patch.diff',
 * 'grade.json') to its content (Buffer | string | JSON value). Throws if the trial/arm was
 * already recorded, is not in the plan, or disagrees with its own grade.
 */
function recordTrial(expDir, result, artifacts = {}) {
  const m = readManifest(expDir);
  const planned = m.trial_plan.order.find((o) => o.trial_id === result.trial_id && o.arm === result.arm);
  if (result.experiment_id !== m.experiment_id) throw new Error(`result belongs to experiment ${result.experiment_id}, not ${m.experiment_id}`);
  if (!planned) throw new Error(`trial ${result.trial_id}/${result.arm} is not in the trial plan`);
  if (planned.task_id !== result.task_id || planned.repetition !== result.repetition) throw new Error(`trial ${result.trial_id}/${result.arm} disagrees with the plan (task/repetition)`);
  const files = Object.entries(artifacts);
  for (const [name] of files) if (!FILE_RE.test(name) || name === 'result.json') throw new Error(`invalid artifact name: ${name}`);
  const bytes = Object.fromEntries(files.map(([name, v]) => [name, toBytes(v)]));
  const task = m.tasks.find((t) => t.id === result.task_id);
  if (bytes['grade.json']) {
    const g = S.Grade.parse(JSON.parse(bytes['grade.json'].toString('utf8')));
    if (g.task_id !== result.task_id) throw new Error('grade is for another task');
    if (g.spec_sha256 !== task.spec_sha256) throw new Error('grade was made against another spec version');
    if (g.grader_sha256 !== graderHash(m.pins.grader.files)) throw new Error('grade was made by an unpinned grader');
    if (bytes['patch.diff'] && g.patch_sha256 !== S.sha256(bytes['patch.diff'])) throw new Error('grade is for another patch');
    if (result.grade_outcome !== g.outcome) throw new Error(`grade_outcome ${result.grade_outcome} disagrees with the grade (${g.outcome})`);
  } else if (result.grade_outcome !== null && result.grade_outcome !== undefined) {
    throw new Error('grade_outcome given without a grade.json artifact');
  }
  const rel = `trials/${result.trial_id}/${result.arm}`;
  const armDir = path.join(expDir, rel);
  fs.mkdirSync(path.dirname(armDir), { recursive: true });
  try { fs.mkdirSync(armDir); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`trial ${result.trial_id}/${result.arm} is already recorded; a re-run is a new trial`);
    throw e;
  }
  const recorded = {};
  for (const [name, b] of Object.entries(bytes).sort(([a], [c]) => a.localeCompare(c))) {
    writeOnce(path.join(armDir, name), b);
    recorded[name] = { path: `${rel}/${name}`, sha256: S.sha256(b) };
  }
  const full = S.TrialResult.parse({ schema: 'qb-trial-result/1', ...result, grade_outcome: result.grade_outcome ?? null, artifacts: recorded });
  writeOnce(path.join(armDir, 'result.json'), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

// ── Loading (with verification) ───────────────────────────────────────────────

/**
 * Load and verify an experiment. Every artifact is re-hashed; a mismatch or a missing
 * file throws, naming it. An arm directory without result.json (a crash mid-record) is
 * returned in `incomplete`, never silently dropped.
 */
function loadExperiment(expDir) {
  const manifest = readManifest(expDir);
  const trials = []; const incomplete = [];
  const tdir = path.join(expDir, 'trials');
  const entries = fs.existsSync(tdir) ? fs.readdirSync(tdir).sort() : [];
  for (const trialId of entries) {
    const td = path.join(tdir, trialId);
    if (!fs.statSync(td).isDirectory()) throw new Error(`${td}: unexpected file in trials/`);
    for (const arm of fs.readdirSync(td).sort()) {
      const ad = path.join(td, arm);
      const rf = path.join(ad, 'result.json');
      if (!fs.existsSync(rf)) { incomplete.push({ trial_id: trialId, arm, dir: `trials/${trialId}/${arm}` }); continue; }
      let raw;
      try { raw = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (e) { throw new Error(`${rf}: unreadable (${e.message})`); }
      const r = S.TrialResult.safeParse(raw);
      if (!r.success) throw new Error(`${rf}: invalid qb-trial-result/1 (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
      const res = r.data;
      if (res.trial_id !== trialId || res.arm !== arm) throw new Error(`${rf}: names ${res.trial_id}/${res.arm} but is stored at ${trialId}/${arm}`);
      for (const [name, a] of Object.entries(res.artifacts)) {
        if (a.path !== `trials/${trialId}/${arm}/${name}`) throw new Error(`${rf}: artifact ${name} points outside its trial directory (${a.path})`);
        const abs = path.join(expDir, a.path);
        if (!fs.existsSync(abs)) throw new Error(`${abs}: artifact missing`);
        if (S.sha256File(abs) !== a.sha256) throw new Error(`${abs}: artifact hash mismatch (recorded ${a.sha256.slice(0, 12)}…)`);
      }
      let grade = null;
      if (res.artifacts['grade.json']) {
        const gf = path.join(expDir, res.artifacts['grade.json'].path);
        const g = S.Grade.safeParse(JSON.parse(fs.readFileSync(gf, 'utf8')));
        if (!g.success) throw new Error(`${gf}: invalid qb-grade/1`);
        grade = g.data;
        if (grade.outcome !== res.grade_outcome) throw new Error(`${rf}: grade_outcome ${res.grade_outcome} disagrees with ${gf} (${grade.outcome})`);
      } else if (res.grade_outcome !== null) {
        throw new Error(`${rf}: grade_outcome ${res.grade_outcome} without a grade.json artifact`);
      }
      trials.push({ ...res, grade });
    }
  }
  return { dir: expDir, manifest, trials, incomplete };
}

module.exports = { createExperiment, collectPins, recordTrial, loadExperiment, readManifest, graderHash, defaultOrder };
