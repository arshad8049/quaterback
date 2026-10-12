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
