/**
 * QB-30 harder-task screen: candidate tasks are curated, qualified and frozen as a SEPARATE set
 * (bench/screen/: its own curation, suites, specs and lock), so the frozen dev set and its lock
 * under review (KAN-62) are never touched. An experiment config names the set's lock and suites.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { curateDirs, DEFAULTS } = require('../../bench/curate');
const { configPaths } = require('../../bench/experiment-run');

const BENCH = path.join(__dirname, '..', '..', 'bench');

describe('QB-30: the screen task set is separate from the dev set', () => {
  test('curateDirs: dev is the default set; screen has its own curation, suites, specs and lock', () => {
    assert.deepEqual(curateDirs('dev'), DEFAULTS);
    assert.deepEqual(curateDirs('screen'), {
      curation: path.join(BENCH, 'screen', 'curation'), suites: path.join(BENCH, 'screen', 'suites'),
      specs: path.join(BENCH, 'screen', 'specs'), lockFile: path.join(BENCH, 'screen', 'specs.lock.json'),
    });
    assert.throws(() => curateDirs('holdout'), /unknown task set/);
  });
  test('configPaths: the lock and suites an experiment config names, relative to the config; defaults otherwise', () => {
    const cfgFile = path.join(BENCH, 'pilot', 'screen.json');
    assert.deepEqual(configPaths({ lock: '../screen/specs.lock.json', suites: '../screen/suites' }, cfgFile),
      { lockFile: path.join(BENCH, 'screen', 'specs.lock.json'), suitesRoot: path.join(BENCH, 'screen', 'suites') });
    assert.deepEqual(configPaths({}, cfgFile), { lockFile: path.join(BENCH, 'specs.lock.json'), suitesRoot: null });
  });
});

describe('KAN-65: the supported-scope plan selects 10 of the 14 screen tasks, openly', () => {
  const fs = require('fs');
  const { checkFrozen } = require('../../bench/spec');
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(BENCH, rel), 'utf8'));
  const full = read('pilot/screen.json');
  const plan = read('pilot/screen-supported.json');
  const idOf = (f) => path.basename(f, '.json');

  test('all 14 considered tasks are named; included and excluded partition them; the run uses exactly the included ones', () => {
    const sel = plan.selection;
    assert.deepEqual(sel.considered, full.specs.map(idOf), 'the same 14 as the original screen');
    const excluded = sel.excluded.map((e) => e.id);
    assert.deepEqual([...sel.included, ...excluded].sort(), [...sel.considered].sort());
    assert.equal(sel.included.filter((id) => excluded.includes(id)).length, 0);
    assert.deepEqual(plan.specs.map(idOf), sel.included);
    assert.deepEqual(excluded, ['FY-04', 'FY-06', 'FY-11', 'FY-12']);
  });

  test('the selection is disclosed: decision, date, rule, reason for each exclusion, after_viewing_results', () => {
    const sel = plan.selection;
    assert.equal(sel.after_viewing_results, true);
    assert.match(sel.decided_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(sel.rule, /protected visible tests/);
    for (const e of sel.excluded) assert.match(e.reason, /conflicts with protected base-test expectations/, e.id);
    assert.match(plan._note, /does not approve a paid run/);
  });

  test('both arms get the same treatment as the original screen, and every considered task (excluded ones too) stays frozen', () => {
    for (const k of ['kind', 'arms', 'primary', 'repetitions', 'budget', 'lock', 'suites']) assert.deepEqual(plan[k], full[k], k);
    assert.notEqual(plan.seed, full.seed, 'a new run gets its own seed');
    const lock = read('screen/specs.lock.json');
    for (const id of plan.selection.considered) checkFrozen(read(`screen/specs/${id}.json`), lock);
  });
});
