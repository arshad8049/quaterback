/**
 * run/store.js — durable, append-only run records (QB-38).
 *
 * Layout (default root ~/.qb/runs, override with QB_RUNS_DIR):
 *
 *   <root>/<run_id>/manifest.json   atomically replaced on every update
 *   <root>/<run_id>/events.jsonl    append-only, fsynced per line
 *   <root>/<run_id>/artifacts/      content-addressed by sha256
 *
 * A run that ends without a terminal event is either aborted by the signal
 * handlers (CANCELLED / ERROR) or, if the process was killed outright,
 * marked ABANDONED by reapAbandoned() on the next start.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const { SCHEMA_VERSION, RunManifestSchema, AttemptSchema } = require('./schema');
const proc = require('../lib/proc');

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const TERMINAL    = new Set(['VERIFIED', 'FAILED', 'UNRESOLVED', 'ERROR', 'BLOCKED', 'CANCELLED', 'DRY_RUN', 'ABANDONED']);

function defaultRunsDir() {
  return process.env.QB_RUNS_DIR || path.join(os.homedir(), '.qb', 'runs');
}

// ── Hashing / redaction ───────────────────────────────────────────────────────

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Stable JSON: object keys sorted, so equal data hashes equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|authorization|cookie)/i;
const SECRET_VALUE_RES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bre_[A-Za-z0-9]{16,}\b/g,                 // Resend
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,          // GitHub
];

function redactString(s) {
  let out = s;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '[REDACTED]');
  return out;
}

function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && v != null && v !== '' ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

// ── Crash-safe file primitives ────────────────────────────────────────────────

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function appendLine(file, line) {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function within(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

// ── Run ───────────────────────────────────────────────────────────────────────

class Run {
  constructor(dir, manifest) {
    this.dir      = dir;
    this.manifest = manifest;
    this.seq      = 0;
  }

  get id()         { return this.manifest.run_id; }
  get isTerminal() { return TERMINAL.has(this.manifest.outcome); }

  _save() {
    const m = RunManifestSchema.parse(this.manifest);
    writeAtomic(path.join(this.dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  }

  event(type, data = {}) {
    appendLine(path.join(this.dir, 'events.jsonl'), JSON.stringify({
      seq: ++this.seq,
      ts:  new Date().toISOString(),
      type,
      data: redact(data),
    }));
  }

  /**
   * Store an artifact by content hash. Objects are stored as JSON; strings
   * and Buffers as-is. Secrets are redacted before hashing.
   */
  artifact(name, data, { ext } = {}) {
    if (!ARTIFACT_RE.test(name)) throw new Error(`Invalid artifact name: ${JSON.stringify(name)}`);

    let buf;
    if (Buffer.isBuffer(data))           { buf = data; ext = ext || 'bin'; }
    else if (typeof data === 'string')   { buf = Buffer.from(redactString(data)); ext = ext || 'txt'; }
    else                                 { buf = Buffer.from(JSON.stringify(redact(data), null, 2)); ext = ext || 'json'; }

    if (!/^[a-z0-9]{1,10}$/.test(ext)) throw new Error(`Invalid artifact extension: ${ext}`);

    const hash = sha256(buf);
    const rel  = path.join('artifacts', `${hash}.${ext}`);
    const abs  = path.join(this.dir, rel);
    if (!within(this.dir, abs)) throw new Error('Artifact path escapes run directory');
    if (!fs.existsSync(abs)) writeAtomic(abs, buf);

    const ref = { name, sha256: hash, path: rel, bytes: buf.length };
    this.manifest.artifacts[name] = ref;
    this._save();
    this.event('artifact.stored', { name, sha256: hash, bytes: buf.length });
    return ref;
  }

  readArtifact(name) {
    const ref = this.manifest.artifacts[name];
    if (!ref) return null;
    const abs = path.join(this.dir, ref.path);
    if (!within(this.dir, abs)) throw new Error('Artifact path escapes run directory');
    const buf = fs.readFileSync(abs);
    if (sha256(buf) !== ref.sha256) throw new Error(`Artifact ${name} failed checksum`);
    return ref.path.endsWith('.json') ? JSON.parse(buf.toString('utf8')) : buf.toString('utf8');
  }

  update(fields) {
    Object.assign(this.manifest, fields);
    this._save();
  }

  setContract(contract) {
    const ref = this.artifact('contract', contract);
    this.update({ contract_hash: ref.sha256 });
    this.event('contract.accepted', { sha256: ref.sha256, goal: contract.goal ?? null });
  }

  startAttempt({ attempt, parent_attempt = null, repair_reason = [], base_sha = null }) {
    const a = AttemptSchema.parse({
      attempt, parent_attempt, repair_reason,
      started_at: new Date().toISOString(),
      finished_at: null,
      base_sha,
      patch_sha256: null,
      execution_status: null,
      verdict: null,
      checks: [],
      artifacts: {},
    });
    this.manifest.attempts.push(a);
    this._save();
    this.event('attempt.started', { attempt, parent_attempt, repair_reason });
  }

  /**
   * Record an attempt's evidence. `verifyInput` is the exact input given to
   * verify/verdict.aggregate(), stored so replay() can recompute the verdict.
   */
  finishAttempt(attempt, { execution = null, report = null, patch = null, verifyInput = null, checks = [] }) {
    const a = this.manifest.attempts.find(x => x.attempt === attempt);
    if (!a) throw new Error(`Unknown attempt ${attempt}`);

    if (patch)       { a.patch_sha256 = this.artifact(`a${attempt}-patch`, patch, { ext: 'diff' }).sha256; a.artifacts.patch = `a${attempt}-patch`; }
    if (execution)   { this.artifact(`a${attempt}-execution`, execution); a.artifacts.execution = `a${attempt}-execution`; }
    if (report)      { this.artifact(`a${attempt}-report`, report);       a.artifacts.report    = `a${attempt}-report`; }
    if (verifyInput) { this.artifact(`a${attempt}-verify-input`, verifyInput); a.artifacts.verify_input = `a${attempt}-verify-input`; }

    a.execution_status = execution?.status ?? null;
    a.verdict          = report?.verdict ?? null;
    a.checks           = checks;
    a.finished_at      = new Date().toISOString();
    this._save();
    this.event('attempt.finished', { attempt, execution_status: a.execution_status, verdict: a.verdict, patch_sha256: a.patch_sha256 });
  }

  finish(outcome, { legacy_verdict = null, reason = null } = {}) {
    if (this.isTerminal) return;
    this.update({ outcome, legacy_verdict, outcome_reason: reason, finished_at: new Date().toISOString() });
    this.event('run.finished', { outcome, legacy_verdict, reason });
  }

  abort(outcome, reason) {
    if (this.isTerminal) return;
    this.update({ outcome, outcome_reason: reason, finished_at: new Date().toISOString() });
    this.event('run.aborted', { outcome, reason });
  }
}

// ── Construction / loading ────────────────────────────────────────────────────

function repoIdentity(repoPath) {
  let real;
  try { real = fs.realpathSync(repoPath); } catch (_) { real = path.resolve(repoPath); }
  return sha256(real);
}

function qbRevision() {
  const r = proc.git(['rev-parse', 'HEAD'], path.join(__dirname, '..'), { allowFail: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/**
 * @param {object} o
 * @param {string} o.kind        - 'qb' | 'bench-qb' | 'bench-baseline'
 * @param {string} o.request     - raw user request (stored as given)
 * @param {string} o.repoPath
 * @param {object} [o.agent]     - { type, version, isolation }
 * @param {object} [o.models]    - { intent, judge, ... }
 * @param {object} [o.config]    - effective options (redacted before storage)
 * @param {object} [o.sandboxPolicy]
 * @param {string} [o.baseSha]
 * @param {string} [o.runsDir]
 */
function createRun(o) {
  const root = o.runsDir || defaultRunsDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  reapAbandoned(root);

  const run_id = crypto.randomUUID();
  const dir    = path.join(root, run_id);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true, mode: 0o700 });

  const config = redact(o.config || {});
  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id,
    kind:        o.kind || 'qb',
    qb_revision: qbRevision(),
    request:     redactString(o.request || ''),
    repo: {
      path:     path.resolve(o.repoPath),
      identity: repoIdentity(o.repoPath),
      base_sha: o.baseSha || null,
    },
    agent: {
      type:      o.agent?.type || 'unknown',
      version:   o.agent?.version || null,
      isolation: o.agent?.isolation || null,
    },
    models:         o.models || {},
    config,
    config_hash:    sha256(canonical(config)),
    contract_hash:  null,
    sandbox_policy: o.sandboxPolicy || null,
    pid:            process.pid,
    started_at:     new Date().toISOString(),
    finished_at:    null,
    outcome:        'RUNNING',
    legacy_verdict: null,
    outcome_reason: null,
    attempts:       [],
    artifacts:      {},
  };

  const run = new Run(dir, manifest);
  run._save();
  run.event('run.started', { kind: manifest.kind, repo: manifest.repo, agent: manifest.agent });
  return run;
}

/** Upgrade older manifests in place (in memory). v1 is current. */
function migrate(raw) {
  if (raw.schema_version === SCHEMA_VERSION) return raw;
  throw new Error(`Unsupported run schema_version ${raw.schema_version}`);
}

function loadRun(runId, runsDir = defaultRunsDir()) {
  if (!UUID_RE.test(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  const dir = path.join(runsDir, runId);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const run = new Run(dir, RunManifestSchema.parse(migrate(raw)));
  run.seq = readEvents(run).length;
  return run;
}

function readEvents(run) {
  const file = path.join(run.dir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** Mark RUNNING manifests whose owning process is gone as ABANDONED. */
function reapAbandoned(runsDir = defaultRunsDir()) {
  if (!fs.existsSync(runsDir)) return [];
  const reaped = [];
  for (const id of fs.readdirSync(runsDir)) {
    if (!UUID_RE.test(id)) continue;
    let run;
    try { run = loadRun(id, runsDir); } catch (_) { continue; }
    if (run.manifest.outcome !== 'RUNNING') continue;
    if (run.manifest.pid === process.pid || pidAlive(run.manifest.pid)) continue;
    run.update({ outcome: 'ABANDONED', outcome_reason: 'owning process exited without a terminal event', finished_at: new Date().toISOString() });
    run.event('run.abandoned', { pid: run.manifest.pid });
    reaped.push(id);
  }
  return reaped;
}

/**
 * Close the run if the process is interrupted or crashes.
 * Returns a function that removes the handlers.
 */
function installSignalHandlers(run) {
  const onSignal = sig => {
    run.abort('CANCELLED', `received ${sig}`);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onCrash = err => {
    run.abort('ERROR', `uncaught: ${err && err.message}`);
    console.error(err);
    process.exit(1);
  };
  // Last resort: the event loop drained or process.exit() ran mid-run.
  const onExit = code => run.abort('ERROR', `process exited (code ${code}) before the run completed`);
  const sigint  = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  process.on('exit', onExit);
  return () => {
    process.off('exit', onExit);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  };
}

// ── Outcome mapping + replay ──────────────────────────────────────────────────

/** Map an L4 verdict to a run outcome. */
function outcomeFor(verdict, { dryRun = false } = {}) {
  switch (verdict) {
    case 'pass':       return 'VERIFIED';
    case 'fail':       return 'FAILED';
    case 'partial':    return 'UNRESOLVED';
    case 'unresolved': return 'UNRESOLVED';
    case 'error':      return 'ERROR';
    case 'no-diff':    return dryRun ? 'DRY_RUN' : 'UNRESOLVED';
    default:           return 'ERROR';
  }
}

/**
 * Recompute each attempt's verdict from stored evidence and compare it with
 * what was recorded. Returns { ok, attempts: [{ attempt, recorded, replayed, ok }] }.
 */
function replay(runId, runsDir = defaultRunsDir()) {
  const { aggregate } = require('../verify/verdict');
  const run = loadRun(runId, runsDir);
  const attempts = [];

  for (const a of run.manifest.attempts) {
    if (!a.artifacts.verify_input) {
      attempts.push({ attempt: a.attempt, recorded: a.verdict, replayed: null, ok: a.verdict === null });
      continue;
    }
    const input    = run.readArtifact(a.artifacts.verify_input);
    const replayed = aggregate(input).verdict;
    attempts.push({ attempt: a.attempt, recorded: a.verdict, replayed, ok: replayed === a.verdict });
  }

  const last = run.manifest.attempts[run.manifest.attempts.length - 1];
  const finalOk = !last || !run.manifest.legacy_verdict || last.verdict === run.manifest.legacy_verdict;

  return { ok: finalOk && attempts.every(x => x.ok), outcome: run.manifest.outcome, attempts };
}

module.exports = {
  createRun,
  loadRun,
  readEvents,
  reapAbandoned,
  installSignalHandlers,
  outcomeFor,
  replay,
  redact,
  defaultRunsDir,
  _internal: { canonical, sha256, migrate },
};
