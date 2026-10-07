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

describe('QB-25 re-review 1: no lock theft from a live owner; dead-owner recovery is race-safe', () => {
  const LOCK = path.join(ROOT, 'memory', 'lock.js');
  const waitFor = async (cond, ms = 10000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };
  const runB = (dir, log, waitMs) => spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    try { require(${JSON.stringify(LOCK)}).withLock(${JSON.stringify(dir)}, () => fs.appendFileSync(${JSON.stringify(log)}, 'B\\n'), { waitMs: ${waitMs} }); }
    catch (e) { process.stdout.write(e.code || e.message); process.exit(3); }`], { encoding: 'utf8' });

  test('a paused live owner whose lock is old is NOT robbed; after it is killed, the waiter recovers (pre-fix: entered by age)', async () => {
    const dir = mk('paused');
    const log = path.join(dir, 'log');
    const marker = path.join(dir, 'a-in');
    fs.writeFileSync(log, '');
    const a = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      require(${JSON.stringify(LOCK)}).withLock(${JSON.stringify(dir)}, () => {
        fs.appendFileSync(${JSON.stringify(log)}, 'A-start\\n');
        fs.writeFileSync(${JSON.stringify(marker)}, '1');
        process.kill(process.pid, 'SIGSTOP');        // paused inside the critical section
        fs.appendFileSync(${JSON.stringify(log)}, 'A-end\\n');
      });`], { stdio: 'ignore' });
    try {
      await waitFor(() => fs.existsSync(marker));
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, '.lock'), old, old);          // older than the 30 s age bound
      const b1 = runB(dir, log, 1500);
      assert.equal(b1.status, 3, 'B must not enter while A is alive');
      assert.equal(b1.stdout, 'MEMORY_LOCK_TIMEOUT');
      assert.equal(fs.readFileSync(log, 'utf8'), 'A-start\n', 'no overlapping critical section');
      a.kill('SIGKILL');
      await new Promise((r) => a.on('exit', r));
      const b2 = runB(dir, log, 5000);
      assert.equal(b2.status, 0, b2.stdout + b2.stderr);
      assert.equal(fs.readFileSync(log, 'utf8'), 'A-start\nB\n', 'dead-owner recovery; nothing lost or interleaved');
      assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'B released the lock');
    } finally { try { a.kill('SIGKILL'); } catch { /* gone */ } }
  });

  test('a lock held from another host is never stolen by age: unsupported cross-host sharing is refused with a clear error', () => {
    const dir = mk('xhost');
    const { withLock } = require('../../memory/lock');
    const lf = path.join(dir, '.lock');
    fs.writeFileSync(lf, JSON.stringify({ pid: 1, host: 'some-other-host', token: 'theirs' }));
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(lf, old, old);
    let entered = false;
    assert.throws(() => withLock(dir, () => { entered = true; }, { waitMs: 100 }), (e) => e.code === 'MEMORY_LOCK_TIMEOUT' && /some-other-host/.test(e.message) && /cross-host/.test(e.message));
    assert.equal(entered, false);
    assert.equal(JSON.parse(fs.readFileSync(lf, 'utf8')).token, 'theirs', "the other host's lock is untouched");
  });

  test('many waiters recovering one dead owner: exactly one at a time, no lost increments', async () => {
    const dir = mk('dead');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: Number(dead), host: os.hostname(), token: 'crashed' }));
    const counter = path.join(dir, 'count');
    fs.writeFileSync(counter, '0');
    const worker = `
      const fs = require('fs');
      const { withLock } = require(${JSON.stringify(LOCK)});
      for (let i = 0; i < 20; i++) withLock(${JSON.stringify(dir)}, () => {
        const inside = ${JSON.stringify(path.join(dir, 'inside'))};
        fs.writeFileSync(inside, '', { flag: 'wx' });            // throws if another holder is inside
        const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
        fs.unlinkSync(inside);
      }, { waitMs: 20000 });`;
    const ps = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', worker], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const codes = await Promise.all(ps.map((p) => new Promise((r) => p.on('exit', r))));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    assert.equal(fs.readFileSync(counter, 'utf8'), '120');
  });
});

describe('QB-25 re-review 1: recall work is bounded by the window, not by the history size', () => {
  const { createStore, parseJsonl } = require('../../memory/store');
  /** Count JSON.parse calls and bytes read from disk while fn runs. */
  function measure(fn) {
    const P = JSON.parse; const RS = fs.readSync; const RF = fs.readFileSync;
    const w = { parsed: 0, bytes: 0 };
    JSON.parse = function (...a) { w.parsed++; return P.apply(this, a); };
    fs.readSync = function (...a) { const n = RS.apply(this, a); w.bytes += n; return n; };
    fs.readFileSync = function (...a) { const r = RF.apply(this, a); w.bytes += typeof r === 'string' ? Buffer.byteLength(r) : r.length; return r; };
    try { return { result: fn(), ...w }; } finally { JSON.parse = P; fs.readSync = RS; fs.readFileSync = RF; }
  }
  const row = (i) => JSON.stringify({ id: `o-${String(i).padStart(7, '0')}`, goal: `task ${i}`, verdict: 'pass', changed_files: [`src/m${i % 50}.js`] });

  test('parseJsonl with a limit parses only the window (pre-fix: 100 parses for limit 2)', () => {
    const text = Array.from({ length: 100 }, (_, i) => row(i)).join('\n') + '\n';
    const m = measure(() => parseJsonl(text, { limit: 2 }));
    assert.deepEqual(m.result.records.map((r) => r.id), ['o-0000098', 'o-0000099']);
    assert.ok(m.parsed <= 2, `parsed ${m.parsed}`);
  });

  test('100,000 outcomes, window 1,000: readOutcomes reads and parses ~the window only (pre-fix: the whole file)', () => {
    const root = mk('big');
    const s = createStore({ root, maxScan: 1000, retention: { outcomes: 200_000 }, onWarning: () => {} });
    s.appendOutcome(REPO, JSON.parse(row(0)));                       // creates the namespace
    const file = path.join(s.repoMemoryPath(REPO), 'outcomes.jsonl');
    const lines = [];
    for (let i = 1; i < 100_000; i++) lines.push(row(i));
    fs.appendFileSync(file, lines.join('\n') + '\n');
    const size = fs.statSync(file).size;
    const m = measure(() => s.readOutcomes(REPO));
    assert.equal(m.result.length, 1000);
    assert.equal(m.result.at(-1).id, 'o-0099999', 'the newest record is last');
    assert.equal(m.result[0].id, 'o-0099000');
    assert.ok(m.parsed <= 1000 + 5, `parsed ${m.parsed} records`);
    assert.ok(m.bytes <= 1000 * 120 + 128 * 1024, `read ${m.bytes} of ${size} bytes`);
  });

  test('appends do not rescan the history: per-append disk reads stay small (pre-fix: the whole file per append)', () => {
    const root = mk('append');
    const s = createStore({ root, maxScan: 1000, retention: { outcomes: 2000 }, onWarning: () => {} });
    for (let i = 0; i < 2100; i++) s.appendOutcome(REPO, JSON.parse(row(i)));
    const m = measure(() => { for (let i = 0; i < 50; i++) s.appendOutcome(REPO, JSON.parse(row(10_000 + i))); });
    assert.ok(m.bytes < 50 * 8 * 1024, `50 appends read ${m.bytes} bytes`);
    assert.equal(s.readOutcomes(REPO).at(-1).id, 'o-0010049');
  });

  test('pinned (proven) repairs are bounded too: the newest stay recallable, older ones are archived — never deleted, never scanned by recall', () => {
    const root = mk('pinned');
    const s = createStore({ root, maxScan: 100, retention: { repairs: 20, pinned: 10 }, onWarning: () => {} });
    for (let i = 0; i < 40; i++) s.appendRepair(REPO, { id: `p-${i}`, schema: 2, outcome: 'resolved' });
    for (let i = 0; i < 60; i++) s.appendRepair(REPO, { id: `u-${i}`, schema: 2, outcome: 'unresolved' });
    const dir = s.repoMemoryPath(REPO);
    const reps = s.readRepairs(REPO);
    const proven = reps.filter((r) => r.outcome === 'resolved').map((r) => r.id);
    assert.ok(proven.includes('p-39') && proven.length <= 11, `recallable proven: ${proven.length}`);
    assert.ok(reps.length <= 11 + 22, `recall returned ${reps.length}`);
    const archived = fs.readFileSync(path.join(dir, 'repairs.archive.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
    const all = new Set([...archived, ...proven]);
    for (let i = 0; i < 40; i++) assert.ok(all.has(`p-${i}`), `p-${i} kept (archive or pinned)`);
  });

  test('corruption is still reported with line and offset by the full audit (health), separate from bounded recall', () => {
    const root = mk('audit');
    const s = createStore({ root, maxScan: 5, onWarning: () => {} });
    for (let i = 0; i < 3; i++) s.appendOutcome(REPO, JSON.parse(row(i)));
    const file = path.join(s.repoMemoryPath(REPO), 'outcomes.jsonl');
    fs.appendFileSync(file, 'garbage\n');
    for (let i = 3; i < 20; i++) s.appendOutcome(REPO, JSON.parse(row(i)));
    assert.deepEqual(s.health(REPO).corrupt.outcomes.map((c) => [c.line, c.reason]), [[4, 'unparsable']]);
    assert.equal(s.readOutcomes(REPO).length, 5);
  });
});

describe('QB-25 re-review 2: every lock wait honours its deadline; takeovers back off and recover', () => {
  const LOCK = path.join(ROOT, 'memory', 'lock.js');
  const HOST = os.hostname();
  /** A pid that provably does not exist on this host (a child that has exited). */
  const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  /** Run withLock in a child with an external timeout, so a spin shows as ETIMEDOUT instead of hanging the suite. */
  const child = (dir, waitMs, extTimeout = 3000) => {
    const log = path.join(dir, 'entered');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      try { require(${JSON.stringify(LOCK)}).withLock(${JSON.stringify(dir)}, () => fs.writeFileSync(${JSON.stringify(log)}, 'in'), { waitMs: ${waitMs}, pollMs: 5 }); process.stdout.write('OK'); }
      catch (e) { process.stdout.write(e.code || e.message); process.exit(3); }`], { encoding: 'utf8', timeout: extTimeout });
    return { out: r.stdout, error: r.error && r.error.code, ms: Date.now() - t0, entered: fs.existsSync(log) };
  };
  const writeLock = (dir, name, owner) => fs.writeFileSync(path.join(dir, name), typeof owner === 'string' ? owner : JSON.stringify(owner));

  test('senior repro: dead lock owner + takeover held by a LIVE process → MEMORY_LOCK_TIMEOUT near the deadline, no entry (pre-fix: spun until killed)', () => {
    const dir = mk('held-takeover');
    writeLock(dir, '.lock', { pid: deadPid(), host: HOST, token: 'dead' });
    writeLock(dir, '.lock.takeover', { pid: process.pid, host: HOST, token: 'live-taker' });
    const r = child(dir, 40, 2000);
    assert.equal(r.error, undefined, `the child must not spin until killed (${r.error})`);
    assert.equal(r.out, 'MEMORY_LOCK_TIMEOUT');
    assert.equal(r.entered, false);
    assert.ok(r.ms < 1500, `timed out after ${r.ms} ms`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.lock.takeover'), 'utf8')).token, 'live-taker', "the live taker's claim is untouched");
  });

  test('two processes: a live process genuinely holding the takeover claim → the waiter times out, never enters', async () => {
    const dir = mk('held-takeover-2p');
    writeLock(dir, '.lock', { pid: deadPid(), host: HOST, token: 'dead' });
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(path.join(dir, '.lock.takeover'))}, JSON.stringify({ pid: process.pid, host: ${JSON.stringify(HOST)}, token: 'holder' }));
      process.stdout.write('held\\n'); setTimeout(() => {}, 30000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((res) => holder.stdout.once('data', res));
      const r = child(dir, 60, 2000);
      assert.deepEqual([r.error, r.out, r.entered], [undefined, 'MEMORY_LOCK_TIMEOUT', false]);
    } finally { holder.kill('SIGKILL'); }
  });

  test('incomplete takeover file whose writer cannot be identified: fresh → bounded timeout (no spin); old → recovered, then the dead lock is taken over', () => {
    const dir = mk('incomplete-takeover');
    writeLock(dir, '.lock', { pid: deadPid(), host: HOST, token: 'dead' });
    writeLock(dir, '.lock.takeover', '');                                // an incomplete (empty) takeover claim, just written
    const fresh = child(dir, 40, 2000);
    assert.deepEqual([fresh.error, fresh.out, fresh.entered], [undefined, 'MEMORY_LOCK_TIMEOUT', false]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, '.lock.takeover'), old, old);          // abandoned long ago: nobody is completing it
    const recovered = child(dir, 2000, 4000);
    assert.deepEqual([recovered.error, recovered.out, recovered.entered], [undefined, 'OK', true]);
  });

  test('a takeover file left by a dead taker is cleared and the dead lock is recovered', () => {
    const dir = mk('dead-taker');
    writeLock(dir, '.lock', { pid: deadPid(), host: HOST, token: 'dead' });
    writeLock(dir, '.lock.takeover', { pid: deadPid(), host: HOST, token: 'crashed-taker' });
    const r = child(dir, 2000, 4000);
    assert.deepEqual([r.error, r.out, r.entered], [undefined, 'OK', true]);
  });

  test('an unreadable lock that is never old enough cannot keep a waiter past its deadline', () => {
    const dir = mk('unreadable-fresh');
    writeLock(dir, '.lock', '');
    const r = child(dir, 40, 2000);
    assert.deepEqual([r.error, r.out, r.entered], [undefined, 'MEMORY_LOCK_TIMEOUT', false]);
  });
});
