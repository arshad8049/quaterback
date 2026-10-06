/**
 * QB-25: the memory store has a safe lifecycle and is safe under concurrency.
 * - the store path is resolved when used (or injected at construction), never captured at import;
 * - writes to one repository's store are serialized across processes (per-repo lock), and
 *   file stats are replaced atomically — concurrent writers lose no counts;
 * - a corrupt or truncated record is REPORTED (count + line + byte offset), valid data is
 *   kept, and a later append is never glued onto a truncated tail;
 * - retention/compaction keeps the JSONL bounded (proven repairs are always kept, dropped
 *   corrupt lines are quarantined, not discarded) and recall scans a bounded window;
 * - the demo writes only beneath its own temporary directory;
 * - recall latency is measured at the supported history size (10,000 outcomes).
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `qb25-${p}-`));
const dirs = [];
const mk = (p) => { const d = tmp(p); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const REPO = '/work/fixture-app';
const contract = (i = 0) => ({ id: `c-${i}`, goal: `Add a clamp helper to src/math.js number ${i}`, acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp limits a value to a range' }] });
const report = { verdict: 'pass', attempts: 1, criteria_results: [] };
const execution = { duration_ms: 10, changes: [{ file: 'src/math.js', additions: 3, deletions: 0 }] };
const repoDirOf = (root) => path.join(root, fs.readdirSync(root).find((d) => !d.startsWith('.')));

describe('the store path is resolved when used, not captured at import', () => {
  test('QB_MEMORY_DIR changed after require() is honoured (pre-fix: writes went to the import-time dir)', async () => {
    const first = mk('first');
    const second = mk('second');
    const r = spawnSync(process.execPath, ['-e', `
      process.env.QB_MEMORY_DIR = ${JSON.stringify(first)};
      const memory = require(${JSON.stringify(path.join(ROOT, 'memory'))});
      process.env.QB_MEMORY_DIR = ${JSON.stringify(second)};     // e.g. a demo that sets it after importing
      memory.remember(${JSON.stringify(REPO)}, ${JSON.stringify(contract())}, ${JSON.stringify(report)}, ${JSON.stringify(execution)})
        .then(() => process.stdout.write(JSON.stringify(memory.stats(${JSON.stringify(REPO)}))));`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(first), [], 'nothing written to the import-time directory');
    assert.equal(JSON.parse(r.stdout).total_runs, 1);
    assert.ok(fs.readdirSync(second).length > 0);
  });
  test('createMemory({ root }) injects the path at construction', async () => {
    const root = mk('inject');
    const { createMemory } = require('../../memory');
    const m = createMemory({ root });
    await m.remember(REPO, contract(), report, execution);
    assert.equal(m.stats(REPO).total_runs, 1);
    assert.ok(m.stats(REPO).memory_dir.startsWith(root));
  });
  test('the demo writes only beneath its own temporary directory (pre-fix: it wrote to ~/.quarterback/memory)', () => {
    const home = mk('home');
    const tmpdir = mk('tmpdir');
    const env = { ...process.env, HOME: home, TMPDIR: tmpdir };
    delete env.QB_MEMORY_DIR;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'memory', 'sandbox', 'run.js')], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(home), [], 'nothing written under HOME');
    assert.deepEqual(fs.readdirSync(tmpdir), [], 'the demo removed its own directory');
    assert.match(r.stdout, new RegExp(`Memory dir: ${tmpdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

describe('concurrency: per-repository lock and atomic stats', () => {
  test('6 processes × 30 remember() on one repository: every outcome and every file-stat count is kept (pre-fix: lost updates)', async () => {
    const root = mk('conc');
    const go = path.join(root, '.go');
    const N = 6, PER = 30;
    const child = () => spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const { createMemory } = require(${JSON.stringify(path.join(ROOT, 'memory'))});
      const memory = createMemory ? createMemory({ root: ${JSON.stringify(root)} }) : (process.env.QB_MEMORY_DIR = ${JSON.stringify(root)}, require(${JSON.stringify(path.join(ROOT, 'memory'))}));
      while (!fs.existsSync(${JSON.stringify(go)})) {}          // start together
      (async () => { for (let i = 0; i < ${PER}; i++) await memory.remember(${JSON.stringify(REPO)}, ${JSON.stringify(contract())}, ${JSON.stringify(report)}, ${JSON.stringify(execution)}); })()
        .catch((e) => { console.error(e); process.exit(1); });`], { env: { ...process.env, QB_MEMORY_DIR: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    const kids = Array.from({ length: N }, child);
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(go, '');
    const codes = await Promise.all(kids.map((k) => new Promise((res) => { let err = ''; k.stderr.on('data', (d) => { err += d; }); k.on('exit', (c) => res([c, err])); })));
    for (const [c, err] of codes) assert.equal(c, 0, err);
    const dir = repoDirOf(root);
    const lines = fs.readFileSync(path.join(dir, 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, N * PER);
    for (const l of lines) JSON.parse(l);
    const stats = JSON.parse(fs.readFileSync(path.join(dir, 'file_stats.json'), 'utf8'));
    assert.equal(stats['src/math.js'].hits, N * PER, 'no lost file-stat updates');
  });
});

describe('corruption is reported, valid data is kept', () => {
  test('a truncated record is reported with its line and byte offset; valid records survive; the next append is not glued onto it (pre-fix: silently dropped, next record lost)', async () => {
    const root = mk('trunc');
    const { createMemory } = require('../../memory');
    const m = createMemory({ root, onWarning: () => {} });
    for (let i = 0; i < 3; i++) await m.remember(REPO, contract(i), report, execution);
    const file = path.join(repoDirOf(root), 'outcomes.jsonl');
    const validBytes = fs.statSync(file).size;
    fs.appendFileSync(file, '{"id":"trunc');                    // a crash mid-write
    const s1 = m.stats(REPO);
    assert.equal(s1.total_runs, 3);
    assert.deepEqual(s1.corrupt.outcomes, [{ line: 4, offset: validBytes, reason: 'truncated' }]);
    await m.remember(REPO, contract(9), report, execution);
    const s2 = m.stats(REPO);
    assert.equal(s2.total_runs, 4, 'the record written after the truncated tail is intact');
    assert.equal(s2.corrupt.outcomes.length, 1);
    assert.ok(m.recallPrior(REPO, 'Add a clamp helper to src/math.js number 9').some((o) => o.contract_id === 'c-9'));
  });
  test('an unparsable middle line is reported (not silently skipped) and a warning is emitted', async () => {
    const root = mk('mid');
    const { createMemory } = require('../../memory');
    const warnings = [];
    const m = createMemory({ root, onWarning: (w) => warnings.push(w) });
    await m.remember(REPO, contract(1), report, execution);
    const file = path.join(repoDirOf(root), 'outcomes.jsonl');
    fs.appendFileSync(file, 'not json\n');
    await m.remember(REPO, contract(2), report, execution);
    const s = m.stats(REPO);
    assert.equal(s.total_runs, 2);
    assert.deepEqual(s.corrupt.outcomes.map((c) => [c.line, c.reason]), [[2, 'unparsable']]);
    assert.ok(warnings.some((w) => /outcomes\.jsonl: 1 corrupt record/.test(w)), warnings.join('\n'));
  });
  test('a corrupt file_stats.json is quarantined and reported, not silently reset', async () => {
    const root = mk('fstats');
    const { createMemory } = require('../../memory');
    const m = createMemory({ root, onWarning: () => {} });
    await m.remember(REPO, contract(1), report, execution);
    const dir = repoDirOf(root);
    fs.writeFileSync(path.join(dir, 'file_stats.json'), '{"src/math.js": {"hits": 41');
    await m.remember(REPO, contract(2), report, execution);
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('file_stats.json.corrupt-'));
    assert.equal(kept.length, 1, 'the corrupt stats file is kept for inspection');
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"src/math.js": {"hits": 41');
    assert.equal(m.stats(REPO).corrupt.file_stats.length, 1);
  });
});

describe('retention, compaction and bounded recall', () => {
  test('outcomes are compacted to the newest N; proven repairs are always kept; corrupt lines are quarantined, not lost', () => {
    const root = mk('compact');
    const { createStore } = require('../../memory/store');
    const s = createStore({ root, retention: { outcomes: 50, repairs: 20 }, onWarning: () => {} });
    for (let i = 0; i < 80; i++) s.appendOutcome(REPO, { id: `o-${i}`, n: i });
    const outs = s.readOutcomes(REPO);
    assert.ok(outs.length <= 55, `compacted (got ${outs.length})`);
    assert.equal(outs.at(-1).n, 79, 'the newest are kept');
    for (let i = 0; i < 5; i++) s.appendRepair(REPO, { id: `p-${i}`, schema: 2, outcome: 'resolved' });
    fs.appendFileSync(path.join(s.repoMemoryPath(REPO), 'repairs.jsonl'), 'garbage\n');
    for (let i = 0; i < 60; i++) s.appendRepair(REPO, { id: `u-${i}`, schema: 2, outcome: 'unresolved' });
    const reps = s.readRepairs(REPO);
    assert.deepEqual(reps.filter((r) => r.outcome === 'resolved').map((r) => r.id), ['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
    assert.ok(reps.filter((r) => r.outcome === 'unresolved').length <= 22);
    const q = fs.readFileSync(path.join(s.repoMemoryPath(REPO), 'repairs.jsonl.quarantine'), 'utf8');
    assert.match(q, /garbage/, 'the corrupt line was moved to quarantine, not discarded');
    assert.equal(s.health(REPO).quarantined.repairs, 1);
  });
  test('recall latency at the supported history size (10,000 outcomes) is bounded', async (t) => {
    const root = mk('latency');
    const { createMemory, SUPPORTED_HISTORY } = require('../../memory');
    assert.equal(SUPPORTED_HISTORY, 10_000);
    const m = createMemory({ root });
    await m.remember(REPO, contract(0), report, execution);      // creates the repo dir
    const file = path.join(repoDirOf(root), 'outcomes.jsonl');
    const lines = [];
    for (let i = 1; i < SUPPORTED_HISTORY; i++) {
      lines.push(JSON.stringify({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ts: new Date().toISOString(), repo_path: REPO,
        goal: `task ${i} touching module ${i % 97}`, keywords: ['task', `module${i % 97}`, `word${i % 13}`], verdict: i % 3 ? 'pass' : 'fail',
        attempts: 1, changed_files: [`src/m${i % 97}.js`], ac_count: 1, duration_ms: 5 }));
    }
    fs.appendFileSync(file, lines.join('\n') + '\n');
    const t0 = process.hrtime.bigint();
    m.recallPrior(REPO, 'task touching module 42');
    m.recallFiles(REPO, 'task touching module 42');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    t.diagnostic(`recallPrior + recallFiles over ${SUPPORTED_HISTORY} outcomes: ${ms.toFixed(1)} ms`);
    assert.equal(m.stats(REPO).total_runs, SUPPORTED_HISTORY);
    assert.ok(ms < 2000, `recall took ${ms} ms`);
  });
});
