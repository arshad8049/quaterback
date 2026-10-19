#!/usr/bin/env node
/**
 * KAN-73: how often does the intent compiler produce a valid contract, and why not?
 *
 * Compiles every request of a fixed, versioned set (bench/compile-requests/v<N>.json) N times
 * through the real entry point qb.js uses (intent/session.js compileIntent: repository survey,
 * then the model), with no clarification answers and no interactive prompt, and reports the share
 * of attempts that end in a finalized contract, and the first reason for every other one.
 *
 * No agent and no spend: only the intent model is called (QB_MODEL, default deepseek-r1:7b,
 * through QB_OLLAMA_URL). Nothing is approved, and validation is never relaxed: "valid" means
 * contractState says finalized, exactly as qb.js requires before approval. It does not mean the
 * contract is right; KAN-73 found none usable without human edits.
 *
 *   node scripts/kan73-compile-rate.js [--set bench/compile-requests/v1.json] [--n 3]
 *                                      [--only HERO-1,dev-r2/AV-01] [--out <dir>]
 *
 * Writes <out>/attempts.jsonl (one record per attempt, with every validation error) and
 * <out>/summary.json (provenance, per-request and overall valid counts, first-reason counts),
 * and prints a table. Exit 0 when every attempt was recorded, 1 on a setup error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveSource } = require('../bench/repos');

const ROOT = path.join(__dirname, '..');
const FORMAT = 'qb-compile-requests/1';
const FIXTURES = path.join(ROOT, 'bench', 'compile-requests', 'fixtures');
const DEFAULT_SET = path.join(ROOT, 'bench', 'compile-requests', 'v1.json');
// Read directly rather than through bench/curate or bench/spec, which load the sandbox modules
// with the grader schemas: this script must not even load agent code. (The test checks these
// are the curated set's paths.)
const SETS = { 'dev-r2': { specs: path.join(ROOT, 'bench', 'dev-r2', 'specs'), lockFile: path.join(ROOT, 'bench', 'dev-r2', 'specs.lock.json') } };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (args, cwd, env) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });

/** The frozen dev-r2 prompts, each on its task repository at base_rev. */
function devR2Requests() {
  const dirs = SETS['dev-r2'];
  const lock = JSON.parse(fs.readFileSync(dirs.lockFile, 'utf8'));
  return Object.keys(lock.specs).sort().map((id) => {
    const spec = JSON.parse(fs.readFileSync(path.join(dirs.specs, `${id}.json`), 'utf8'));
    return { id: `dev-r2/${id}`, request: spec.prompt, repo: { source: spec.repo.source, rev: spec.repo.base_rev } };
  });
}
const INCLUDES = { 'dev-r2': devR2Requests };

/** Fingerprint of a fixture's files, so a summary names exactly what was surveyed. */
function fixtureSha(name) {
  const dir = path.join(FIXTURES, name);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(`${path.relative(dir, p)}\0${sha256(fs.readFileSync(p))}`);
    }
  })(dir);
  return sha256(files.join('\n'));
}

/**
 * The set's requests, expanded. sha256 covers the set file, the fixtures it names and the
 * included sets' locks, so two summaries with the same sha256 compiled the same inputs.
 */
function loadSet(file = DEFAULT_SET) {
  const text = fs.readFileSync(file, 'utf8');
  const set = JSON.parse(text);
  if (set.format !== FORMAT) throw new Error(`${file}: format must be ${FORMAT}`);
  if (!Number.isInteger(set.version)) throw new Error(`${file}: version must be an integer`);
  const requests = [...(set.requests || [])];
  const parts = [sha256(text)];
  for (const inc of set.include || []) {
    const expand = INCLUDES[inc.set];
    if (!expand) throw new Error(`${file}: unknown include ${JSON.stringify(inc.set)} (have: ${Object.keys(INCLUDES).join(', ')})`);
    requests.push(...expand());
    parts.push(`${inc.set}:${sha256(fs.readFileSync(SETS[inc.set].lockFile))}`);
  }
  const seen = new Set();
  for (const r of requests) {
    if (!r.id || typeof r.request !== 'string' || !r.request.trim() || !r.repo) throw new Error(`${file}: every request needs id, request and repo`);
    if (seen.has(r.id)) throw new Error(`${file}: duplicate id ${r.id}`);
    seen.add(r.id);
    if (r.repo.fixture) {
      if (!fs.existsSync(path.join(FIXTURES, r.repo.fixture))) throw new Error(`${r.id}: no fixture ${r.repo.fixture}`);
      parts.push(`fixture:${r.repo.fixture}:${fixtureSha(r.repo.fixture)}`);
    }
  }
  return { version: set.version, file, requests, sha256: sha256([...new Set(parts)].join('\n')) };
}

/**
 * A fresh repository to survey: a fixture committed with a fixed author and date (so the survey
 * sees the same history every time), or a task repository cloned at its base_rev.
 */
function prepareRepo(repo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-kan73-'));
  if (repo.fixture) {
    fs.cpSync(path.join(FIXTURES, repo.fixture), dir, { recursive: true });
    const env = { GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid',
      GIT_AUTHOR_DATE: '2026-10-14T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-14T00:00:00Z' };
    git(['init', '-q'], dir);
    git(['add', '-A'], dir);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `fixture ${repo.fixture}`], dir, env);
    return dir;
  }
  if (repo.source) {
    git(['clone', '-q', '--no-checkout', resolveSource(repo.source), dir], ROOT);
    git(['checkout', '-q', '--detach', repo.rev], dir);
    return dir;
  }
  throw new Error(`unknown repo ${JSON.stringify(repo)}`);
}

/** A validation message with its ids and quoted values replaced, so equal causes group together. */
function normalizeReason(msg) {
  const s = String(msg);
  if (/^Intent compiler returned non-JSON/.test(s)) return 'Intent compiler returned non-JSON';
  if (/ example is wrong: /.test(s)) return '<where> example is wrong';   // intent/examples.js names its values
  return s.split('\n')[0]
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')                  // quoted values (JSON.stringify'd)
    .replace(/\b[A-Z]{1,6}-\d+\b/g, '<id>')                  // AC-1, R-2, C-3, D-1, Q-1 …
    .replace(/\b(criterion|constraint|requirement|occurrence) \d+\b/g, '$1 <n>')
    .replace(/\b\d+ (occurrence)/g, '<n> $1')
    .trim();
}

/** One attempt's outcome from compileIntent's handoff, or from what it threw. */
function outcome(res, err) {
  if (err) return { state: 'error', errors: [String(err.message || err).split('\n')[0]], first_reason: normalizeReason(err.message || err) };
  switch (res && res.state) {
    case 'finalized': return { state: 'finalized', errors: [], first_reason: null };
    case 'invalid': return { state: 'invalid', errors: res.errors || [], first_reason: normalizeReason((res.errors || ['invalid'])[0]) };
    case 'needs_clarification': return { state: 'needs_clarification', errors: (res.unresolved || []).map((u) => `${u.id}: ${u.question}`), first_reason: 'needs_clarification' };
    case 'blocked': return { state: 'blocked', errors: (res.unresolved || []).map((u) => `${u.id}: ${u.question}`), first_reason: `blocked: ${res.reason}` };
    default: return { state: 'error', errors: [`unexpected handoff ${JSON.stringify(res && res.state)}`], first_reason: 'unexpected handoff' };
  }
}

/**
 * Compile each request n times, sequentially (one local model). requests: [{ id, request, repoPath }].
 * compileFn defaults to the real compileIntent; onRecord sees each record as it is made.
 */
async function runAttempts({ requests, n, compileFn, onRecord = () => {} }) {
  const compile = compileFn || require('../intent/session').compileIntent;
  const records = [];
  for (const r of requests) {
    for (let attempt = 1; attempt <= n; attempt++) {
      const t0 = Date.now();
      let res = null; let err = null;
      try { res = await compile(r.request, { repoPath: r.repoPath, answers: [], ask: null }); } catch (e) { err = e; }
      const o = outcome(res, err);
      const rec = { id: r.id, attempt, ...o, valid: o.state === 'finalized', duration_ms: Date.now() - t0, at: new Date(t0).toISOString() };
      records.push(rec);
      onRecord(rec, res);
    }
  }
  return records;
}

/** Valid counts per request (in first-seen order) and overall, first-reason counts, state counts. */
function summarize(records) {
  const byId = new Map();
  const reasons = new Map();
  const states = {};
  for (const r of records) {
    const e = byId.get(r.id) || { id: r.id, attempts: 0, valid: 0 };
    e.attempts++; if (r.valid) e.valid++;
    byId.set(r.id, e);
    states[r.state] = (states[r.state] || 0) + 1;
    if (!r.valid) reasons.set(r.first_reason, (reasons.get(r.first_reason) || 0) + 1);
  }
  return {
    overall: { attempts: records.length, valid: records.filter((r) => r.valid).length },
    requests: [...byId.values()],
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    states,
  };
}

/** The local model's digest and quantisation, as Ollama reports them (null when unreachable). */
async function modelIdentity(url, name) {
  try {
    const res = await fetch(`${url}/api/tags`);
    const m = ((await res.json()).models || []).find((x) => x.name === name || x.model === name);
    return m ? { name, digest: m.digest, quantization: m.details && m.details.quantization_level, parameter_size: m.details && m.details.parameter_size } : { name, digest: null };
  } catch (e) { return { name, digest: null, error: e.message }; }
}

function qbRevision() {
  try { return { commit: git(['rev-parse', 'HEAD'], ROOT).trim(), dirty: git(['status', '--porcelain', '--', ':!node_modules'], ROOT).trim() !== '' }; }
  catch { return { commit: null, dirty: null }; }
}

function render(summary) {
  const pct = (v, a) => (a ? `${Math.round((100 * v) / a)}%` : '-');
  const lines = [`valid ${summary.overall.valid}/${summary.overall.attempts} (${pct(summary.overall.valid, summary.overall.attempts)})`, ''];
  for (const r of summary.requests) lines.push(`${r.id.padEnd(16)} ${r.valid}/${r.attempts}`);
  lines.push('', 'first reason (not valid):');
  for (const r of summary.reasons) lines.push(`${String(r.count).padStart(4)}  ${r.reason}`);
  return lines.join('\n');
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const n = Number(arg('--n', '3'));
  if (!Number.isInteger(n) || n < 1) throw new Error('--n must be a positive integer');
  const set = loadSet(path.resolve(arg('--set', DEFAULT_SET)));
  const only = arg('--only', null);
  const chosen = only ? only.split(',').map((id) => { const r = set.requests.find((x) => x.id === id); if (!r) throw new Error(`no request ${id}`); return r; }) : set.requests;
  const out = path.resolve(arg('--out', path.join(os.tmpdir(), `qb-kan73-${Date.now()}`)));
  fs.mkdirSync(out, { recursive: true });

  const requests = chosen.map((r) => ({ ...r, repoPath: prepareRepo(r.repo) }));
  const { compileIntent } = require('../intent/session');   // loads intent/.env, then reads QB_MODEL
  const model = process.env.QB_MODEL || 'deepseek-r1:7b';
  const url = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
  const provenance = {
    format: 'qb-kan73-compile-rate/1', set: { file: path.relative(ROOT, set.file), version: set.version, sha256: set.sha256, only: only ? chosen.map((r) => r.id) : null },
    n, qb: qbRevision(), model: await modelIdentity(url, model), ollama_url: url, node: process.version, platform: `${os.platform()} ${os.arch()}`,
    started_at: new Date().toISOString(),
  };
  const log = fs.createWriteStream(path.join(out, 'attempts.jsonl'));
  console.log(`KAN-73: ${requests.length} request(s) × ${n} with ${model} (${(provenance.model.digest || 'digest unknown').slice(0, 12)}) → ${out}`);
  const records = await runAttempts({ requests, n, compileFn: compileIntent, onRecord: (rec) => {
    log.write(`${JSON.stringify(rec)}\n`);
    console.log(`${rec.id} #${rec.attempt}: ${rec.valid ? 'valid' : `${rec.state}: ${rec.first_reason}`} (${Math.round(rec.duration_ms / 1000)}s)`);
  } });
  log.end();
  const summary = { ...provenance, ended_at: new Date().toISOString(), ...summarize(records) };
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${render(summary)}\n\nWrote ${out}/summary.json and attempts.jsonl`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(`kan73-compile-rate: ${e.message}`); process.exit(1); });
}

module.exports = { SETS, loadSet, prepareRepo, normalizeReason, runAttempts, summarize, render };
