/**
 * KAN-74: after the dev-r2 freeze (KAN-71), the dev-set tooling points at dev-r2.
 *   - scripts/qb30-reproduce-check.js compares fresh drafts with a chosen set's frozen specs
 *     (--set dev|dev-r2; dev-r2 by default, since v1 records a grader the current one refuses);
 *   - the qb30-reproduce workflow reproduces dev-r2;
 *   - bench/pilot/dev-r2-pilot.json names the dev-r2 lock and specs, with the dev pilot's arms
 *     and budget. It does not approve a paid run.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { curateDirs } = require('../../bench/curate');
const { configPaths } = require('../../bench/experiment-run');
const { checkFrozen, readLock } = require('../../bench/spec');

// Loaded with process.exit trapped: before KAN-74 the script ran its CLI when required and exited
// 0, which ended this file early with every test silently unrun.
let reproduce; let loadError = null;
{
  const exit = process.exit; const log = console.log;
  process.exit = (code) => { throw new Error(`scripts/qb30-reproduce-check.js called process.exit(${code}) when required: it must export checkSet and setDirs, and run its CLI only as a script`); };
  console.log = () => {};
  try { reproduce = require('../../scripts/qb30-reproduce-check'); } catch (e) { loadError = e; } finally { process.exit = exit; console.log = log; }
}
const lib = () => { if (loadError) throw loadError; return reproduce; };
const checkSet = (o) => lib().checkSet(o);
const setDirs = (s) => lib().setDirs(s);

const ROOT = path.join(__dirname, '..', '..');
const BENCH = path.join(ROOT, 'bench');

/** A temporary set: one frozen spec, and optionally a fresh draft of it. */
function tmpSet({ draft } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan74-'));
  const frozen = {
    id: 'XX-01', repo: { base_rev: 'a'.repeat(40) },
    qualification: { grader_sha256: 'g1', suite_sha256: 's1', reference: { patch_sha256: 'r1', outcome: 'pass' },
      incorrect: [{ label: 'wrong-1', patch_sha256: 'w1', outcome: 'fail' }] },
  };
  fs.writeFileSync(path.join(dir, 'XX-01.json'), JSON.stringify(frozen));
  const lockFile = path.join(dir, 'specs.lock.json');
  fs.writeFileSync(lockFile, JSON.stringify({ specs: { 'XX-01': { version: 2 } } }));
  if (draft) fs.writeFileSync(path.join(dir, 'XX-01.draft.json'), JSON.stringify({ spec: draft(JSON.parse(JSON.stringify(frozen))) }));
  return { specs: dir, lockFile };
}

describe('KAN-74: the reproduce check compares a chosen set', () => {
  test('setDirs: dev-r2 (the default) and dev use their own specs and lock; anything else is refused', () => {
    const r2 = curateDirs('dev-r2'); const v1 = curateDirs('dev');
    assert.deepEqual(setDirs(), { set: 'dev-r2', specs: r2.specs, lockFile: r2.lockFile });
    assert.deepEqual(setDirs('dev'), { set: 'dev', specs: v1.specs, lockFile: v1.lockFile });
    assert.throws(() => setDirs('screen'), /unknown set/);
  });

  test('an identical fresh draft reproduces', () => {
    const r = checkSet(tmpSet({ draft: (s) => s }));
    assert.equal(r.bad, 0); assert.equal(r.total, 1);
    assert.match(r.lines[0], /^XX-01 {2}identical/);
  });

  test('a different grader hash is a mismatch, named', () => {
    const r = checkSet(tmpSet({ draft: (s) => { s.qualification.grader_sha256 = 'g2'; return s; } }));
    assert.equal(r.bad, 1);
    assert.match(r.lines[0], /^XX-01 {2}MISMATCH {2}grader_sha256: frozen "g1" vs now "g2"/);
  });

  test('a different incorrect-implementation outcome is a mismatch', () => {
    const r = checkSet(tmpSet({ draft: (s) => { s.qualification.incorrect[0].outcome = 'pass'; return s; } }));
    assert.equal(r.bad, 1);
    assert.match(r.lines[0], /MISMATCH {2}incorrect:/);
  });

  test('a missing draft is a failure, never a pass', () => {
    const r = checkSet(tmpSet());
    assert.equal(r.bad, 1);
    assert.match(r.lines[0], /^XX-01 {2}MISSING/);
  });
});

describe('KAN-74: the qb30-reproduce workflow reproduces dev-r2', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'qb30-reproduce.yml'), 'utf8');
  test('it removes the committed dev-r2 drafts, re-qualifies --set dev-r2 from the dev-r2 lock, and compares --set dev-r2', () => {
    assert.match(yml, /rm -f bench\/dev-r2\/specs\/\*\.draft\.json/);
    assert.match(yml, /require\('\.\/bench\/dev-r2\/specs\.lock\.json'\)/);
    assert.match(yml, /node bench\/curate\.js qualify "\$id" --set dev-r2/);
    assert.match(yml, /node scripts\/qb30-reproduce-check\.js --set dev-r2/);
  });
});

describe('KAN-74: bench/pilot/dev-r2-pilot.json', () => {
  const cfgFile = path.join(BENCH, 'pilot', 'dev-r2-pilot.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const v1 = JSON.parse(fs.readFileSync(path.join(BENCH, 'pilot', 'dev-pilot.json'), 'utf8'));

  test('it names the dev-r2 lock and the shared suites', () => {
    assert.deepEqual(configPaths(cfg, cfgFile), { lockFile: curateDirs('dev-r2').lockFile, suitesRoot: curateDirs('dev-r2').suites });
  });

  test('every spec it names is a dev-r2 spec that passes checkFrozen, and it names all 30', () => {
    const lock = readLock(curateDirs('dev-r2').lockFile);
    assert.equal(cfg.specs.length, 30);
    assert.deepEqual(cfg.specs.map((f) => path.basename(f, '.json')).sort(), Object.keys(lock.specs).sort());
    for (const f of cfg.specs) {
      const file = path.resolve(path.dirname(cfgFile), f);
      assert.equal(path.dirname(file), curateDirs('dev-r2').specs, f);
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(spec.version, 2, f);
      checkFrozen(spec, lock);
    }
  });

  test('same arms, comparison, repetitions and budget as the v1 dev pilot; its own seed; not an approval', () => {
    for (const k of ['kind', 'arms', 'primary', 'repetitions', 'budget']) assert.deepEqual(cfg[k], v1[k], k);
    assert.equal(cfg.kind, 'exploratory');
    assert.notEqual(cfg.seed, v1.seed);
    assert.match(cfg._note, /does not approve a paid run/);
  });
});
