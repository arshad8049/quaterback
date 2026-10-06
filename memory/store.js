/**
 * store.js — disk I/O for the memory layer (QB-25: safe lifecycle and concurrency).
 *
 * Each repo gets its own directory under the store root. The root is INJECTED at
 * construction (createStore({ root })) or, for the default store, resolved from
 * QB_MEMORY_DIR (default ~/.quarterback/memory) at the moment of use — never captured
 * at import time.
 *
 * Files (per repository directory):
 *   outcomes.jsonl          one JSON line per completed pipeline run
 *   repairs.jsonl           one JSON line per linked repair hint (QB-23)
 *   file_stats.json         aggregated file hit counts { "path": { hits, keywords[] } }
 *   <file>.quarantine       corrupt lines removed by compaction (kept, never discarded)
 *   file_stats.json.corrupt-<ts>  a corrupt stats file, moved aside for inspection
 *   .lock                   the per-repository lock (memory/lock.js)
 *
 * Guarantees:
 *   - every write (append, stats update, compaction) runs under the repository's
 *     cross-process lock; file stats and compaction are replaced atomically (temp +
 *     rename), so concurrent writers lose nothing;
 *   - an append is never glued onto a truncated (crashed) tail: a missing final
 *     newline is completed first;
 *   - corrupt or truncated records are REPORTED (line, byte offset, reason) in
 *     health() / stats and through onWarning — never silently dropped;
 *   - retention: when a JSONL file grows past its retention (+10 %), it is compacted
 *     to the newest N records; proven repairs (schema 2, outcome "resolved") are always
 *     kept; corrupt lines are moved to <file>.quarantine;
 *   - reads parse a bounded window (the newest maxScan records).
 */

const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { withLock } = require('./lock');

const DEFAULTS = Object.freeze({
  retention: { outcomes: 10_000, repairs: 5_000 },   // supported history size: 10,000 outcomes
  maxScan: 10_000,
});

const defaultRoot = () => process.env.QB_MEMORY_DIR || path.join(os.homedir(), '.quarterback', 'memory');

// QB-24: repository identity = SHA-256 of the realpath (a path that does not exist yet
// resolves to itself). Same choice as run/store.js repoIdentity(). Moving or re-cloning a
// repository gives it a new namespace — an explicit fresh start, never a merge.
const IDENTITY_SCHEMA = 2;
function repoIdentity(repoPath) {
  let real;
  try { real = fs.realpathSync(repoPath); } catch { real = path.resolve(repoPath); }
  return { real, hash: crypto.createHash('sha256').update(real).digest('hex') };
}
const legacySanitize = (p) => String(p).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '');

const warned = new Set();
const defaultWarn = (msg) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  process.stderr.write(`[qb memory] ${msg}\n`);
};

/** Parse a JSONL file: { records, corrupt: [{ line, offset, reason }], lines, size }. */
function parseJsonl(text, { limit = Infinity } = {}) {
  const records = [];
  const corrupt = [];
  const rows = [];   // { text, line, offset }
  let offset = 0;
  let line = 0;
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    line++;
    const raw = text.slice(i, end);
    const start = offset;
    offset += Buffer.byteLength(raw) + (nl === -1 ? 0 : 1);
    if (raw.length) rows.push({ raw, line, offset: start, truncated: nl === -1 });
    i = nl === -1 ? text.length : nl + 1;
  }
  const window = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  for (const r of rows) {
    let ok = !r.truncated;
    let rec = null;
    if (ok) { try { rec = JSON.parse(r.raw); ok = rec !== null && typeof rec === 'object' && !Array.isArray(rec); } catch { ok = false; } }
    if (!ok) corrupt.push({ line: r.line, offset: r.offset, reason: r.truncated ? 'truncated' : 'unparsable' });
    else r.rec = rec;
  }
  for (const r of window) if (r.rec) records.push(r.rec);
  return { records, corrupt, rows };
}

function createStore({ root = null, retention = {}, maxScan = DEFAULTS.maxScan, onWarning = defaultWarn, lock = {} } = {}) {
  const keep = { ...DEFAULTS.retention, ...retention };
  const rootDir = () => root || defaultRoot();

  // QB-24: the namespace is a collision-resistant repository identity — the SHA-256 of the
  // repository's realpath — prefixed with the schema version (r2-<hash>). The old
  // path-sanitized names ("/x/a/b" and "/x/a_b" both became "x_a_b") are never read.
  function repoDir(repoPath) {
    return path.join(rootDir(), `r${IDENTITY_SCHEMA}-${repoIdentity(repoPath).hash}`);
  }
  const fileOf = (repoPath, name) => path.join(repoDir(repoPath), name);

  /** identity.json of the namespace: new (absent), ok, or mismatch (another repository's). */
  function identityOf(repoPath) {
    const dir = repoDir(repoPath);
    const file = path.join(dir, 'identity.json');
    const expected = repoIdentity(repoPath).real;
    if (!fs.existsSync(file)) return { status: 'new', file, expected };
    let found = null;
    try { found = JSON.parse(fs.readFileSync(file, 'utf8')).repo_realpath; } catch { /* unreadable */ }
    return found === expected ? { status: 'ok', file, expected } : { status: 'mismatch', file, expected, found };
  }
  /** Before any write (under the lock): record the identity, or refuse another repository's namespace. */
  function ensureIdentity(repoPath) {
    const id = identityOf(repoPath);
    if (id.status === 'mismatch') throw new Error(`memory namespace ${path.dirname(id.file)} belongs to ${id.found}, not ${id.expected}; refusing to mix repositories`);
    if (id.status === 'new') {
      fs.writeFileSync(id.file, JSON.stringify({ schema: IDENTITY_SCHEMA, repo_realpath: id.expected, created: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
  }
  /** Reads use a namespace only when its identity matches (or it has none yet). */
  function readable(repoPath) {
    const id = identityOf(repoPath);
    if (id.status === 'mismatch') { onWarning(`${path.dirname(id.file)}: identity names ${id.found}, not ${id.expected} — not used`); return false; }
    return true;
  }
  /** A pre-QB-24 path-sanitized namespace for this repository, if one exists (ignored, reported). */
  function legacyNamespace(repoPath) {
    const { real } = repoIdentity(repoPath);
    for (const p of [...new Set([repoPath, real])]) {
      const dir = path.join(rootDir(), legacySanitize(p));
      if (dir !== repoDir(repoPath) && fs.existsSync(dir)) {
        return { status: 'ignored', dir, reason: 'pre-QB-24 path-sanitized namespace: different repositories could share it, so it is never read or merged' };
      }
    }
    return null;
  }

  const report = (file, corrupt) => {
    if (corrupt.length) onWarning(`${file}: ${corrupt.length} corrupt record(s) at line(s) ${corrupt.map((c) => c.line).join(', ')} — kept out of recall, not deleted`);
  };

  function readRecords(file, { limit = maxScan } = {}) {
    if (!fs.existsSync(file)) return { records: [], corrupt: [] };
    const r = parseJsonl(fs.readFileSync(file, 'utf8'), { limit });
    report(file, r.corrupt);
    return r;
  }

  /** Rewrite a JSONL file keeping the newest `n` records (and any `pinned` ones); quarantine corrupt lines. */
  function compact(file, n, pinned = () => false) {
    const text = fs.readFileSync(file, 'utf8');
    const { rows } = parseJsonl(text);
    const bad = rows.filter((r) => !r.rec);
    const good = rows.filter((r) => r.rec);
    if (bad.length) {
      fs.appendFileSync(`${file}.quarantine`, bad.map((r) => JSON.stringify({ line: r.line, offset: r.offset, text: r.raw })).join('\n') + '\n', { mode: 0o600 });
    }
    const pinnedRows = good.filter((r) => pinned(r.rec));
    const rest = good.filter((r) => !pinned(r.rec));
    const kept = new Set([...pinnedRows, ...rest.slice(Math.max(0, rest.length - n))]);
    const out = good.filter((r) => kept.has(r)).map((r) => r.raw).join('\n');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out ? `${out}\n` : '', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function appendLocked(repoPath, name, record, retainN, pinned) {
    const dir = repoDir(repoPath);
    const file = path.join(dir, name);
    withLock(dir, () => {
      ensureIdentity(repoPath);
      // never glue a record onto a truncated tail: complete the last line first
      let prefix = '';
      if (fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        if (size > 0) {
          const fd = fs.openSync(file, 'r');
          const b = Buffer.alloc(1);
          fs.readSync(fd, b, 0, 1, size - 1);
          fs.closeSync(fd);
          if (b[0] !== 0x0a) prefix = '\n';
        }
      }
      fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
      // retention: compact once the file exceeds its retention by 10 %
      const lines = (fs.readFileSync(file, 'utf8').match(/\n/g) || []).length;
      if (lines > Math.ceil(retainN * 1.1)) compact(file, retainN, pinned);
    }, lock);
  }

  const proven = (r) => r && r.schema === 2 && r.outcome === 'resolved';

  return {
    appendOutcome: (repoPath, record) => appendLocked(repoPath, 'outcomes.jsonl', record, keep.outcomes, () => false),
    appendRepair:  (repoPath, record) => appendLocked(repoPath, 'repairs.jsonl', record, keep.repairs, proven),
    readOutcomes:  (repoPath) => (readable(repoPath) ? readRecords(fileOf(repoPath, 'outcomes.jsonl')).records : []),
    readRepairs:   (repoPath) => (readable(repoPath) ? readRecords(fileOf(repoPath, 'repairs.jsonl')).records : []),
    repoIdentity,

    /** Atomically merge changed files into file_stats.json, under the repository lock. */
    updateFileStats(repoPath, changedFiles, keywords) {
      const dir = repoDir(repoPath);
      const p = path.join(dir, 'file_stats.json');
      withLock(dir, () => {
        ensureIdentity(repoPath);
        let stats = {};
        if (fs.existsSync(p)) {
          const text = fs.readFileSync(p, 'utf8');
          try { stats = JSON.parse(text); if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('not an object'); } catch {
            const aside = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
            fs.renameSync(p, aside);
            onWarning(`${p}: corrupt — moved to ${path.basename(aside)}; counts restart from the next run`);
            stats = {};
          }
        }
        for (const file of changedFiles) {
          if (!stats[file]) stats[file] = { hits: 0, keywords: [] };
          stats[file].hits++;
          stats[file].keywords = [...new Set([...stats[file].keywords, ...keywords])].slice(0, 30);
        }
        const tmp = `${p}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf8');
        fs.renameSync(tmp, p);
      }, lock);
    },

    readFileStats(repoPath) {
      const p = fileOf(repoPath, 'file_stats.json');
      if (!readable(repoPath) || !fs.existsSync(p)) return {};
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { onWarning(`${p}: corrupt — not used for recall`); return {}; }
    },

    /** Corruption and quarantine report for a repository's store. */
    health(repoPath) {
      const dir = repoDir(repoPath);
      const corruptOf = (name) => readRecords(path.join(dir, name)).corrupt;
      const qCount = (name) => { const q = path.join(dir, `${name}.quarantine`); return fs.existsSync(q) ? (fs.readFileSync(q, 'utf8').match(/\n/g) || []).length : 0; };
      let statsCorrupt = [];
      const p = path.join(dir, 'file_stats.json');
      if (fs.existsSync(p)) { try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { statsCorrupt = [{ file: 'file_stats.json', reason: 'unparsable' }]; } }
      const aside = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('file_stats.json.corrupt-')).map((f) => ({ file: f, reason: 'moved_aside' })) : [];
      const id = identityOf(repoPath);
      const legacy = legacyNamespace(repoPath);
      if (legacy) onWarning(`${legacy.dir}: ${legacy.reason}`);
      return {
        corrupt: { outcomes: corruptOf('outcomes.jsonl'), repairs: corruptOf('repairs.jsonl'), file_stats: [...statsCorrupt, ...aside] },
        quarantined: { outcomes: qCount('outcomes.jsonl'), repairs: qCount('repairs.jsonl') },
        identity: { schema: IDENTITY_SCHEMA, status: id.status, repo_realpath: id.expected, ...(id.found !== undefined ? { found: id.found } : {}) },   // QB-24
        ...(legacy ? { legacy_namespace: legacy } : {}),
      };
    },

    repoMemoryPath: (repoPath) => repoDir(repoPath),
    compact: (repoPath) => {
      const dir = repoDir(repoPath);
      withLock(dir, () => {
        ensureIdentity(repoPath);
        for (const [name, n, pin] of [['outcomes.jsonl', keep.outcomes, () => false], ['repairs.jsonl', keep.repairs, proven]]) {
          if (fs.existsSync(path.join(dir, name))) compact(path.join(dir, name), n, pin);
        }
      }, lock);
    },
  };
}

// The default store: its root is resolved from QB_MEMORY_DIR each time it is used.
const defaultStore = createStore();

module.exports = { createStore, parseJsonl, DEFAULTS, IDENTITY_SCHEMA, ...defaultStore };
