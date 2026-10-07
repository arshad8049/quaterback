/**
 * context/test-plan.js — which test command verifies a change, and whether QB can
 * trust its result (QB-20).
 *
 * The only VALIDATED runner is node:test: the sandbox injects QB's node:test reporter
 * and classifies the machine-readable result (QB-06). Any other runner — configured or
 * detected (jest, vitest, mocha, jasmine, pytest, go test, …) — is rejected for
 * verification with an explicit reason: QB cannot execute and parse its results yet,
 * so such a run is never attempted and can never PASS. Detection still reports it.
 *
 * An explicit project config wins over detection:
 *   .quarterback.json   { "test": { "runner": "node-test", "command": ["node", "--test", "test/"] } }
 * `command` is an argv array (never a shell string). Without a config, a node:test
 * project (or an undetected runner) runs its package.json `test` script (`npm test`).
 * The plan is read from the user's checkout (the base), so the agent cannot change it.
 */

const fs = require('fs');
const path = require('path');
const { detectTestRunner } = require('./detector');

const CONFIG_FILE = '.quarterback.json';
const VALIDATED = new Set(['node-test']);

const notRun = (reason, detail, extra = {}) => ({ status: 'not_run', reason, detail, ...extra });
const unsupported = (runner, source) => notRun('unsupported_runner',
  `unsupported runner: ${runner} — QB cannot execute and parse its results yet (validated: ${[...VALIDATED].join(', ')})`, { runner, source });

/** @returns {{status:'run', runner, command: string[], source} | {status:'not_run', reason, detail, runner?, source?}} */
function testPlan(repoPath) {
  const cfgPath = path.join(repoPath, CONFIG_FILE);
  if (fs.existsSync(cfgPath)) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return notRun('invalid_test_config', `${CONFIG_FILE} is not valid JSON`); }
    const t = cfg && cfg.test;
    if (!t || typeof t.runner !== 'string' || !Array.isArray(t.command) || !t.command.length
      || !t.command.every((x) => typeof x === 'string' && x.length > 0)) {
      return notRun('invalid_test_config', `${CONFIG_FILE}: expected { "test": { "runner": "<runner>", "command": ["<argv>", …] } }`);
    }
    if (!VALIDATED.has(t.runner)) return unsupported(t.runner, 'config');
    return { status: 'run', runner: t.runner, command: t.command, source: 'config' };
  }
  const runner = detectTestRunner(repoPath);
  if (runner && !VALIDATED.has(runner)) return unsupported(runner, 'detected');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')); } catch { /* none */ }
  if (!pkg || !pkg.scripts || typeof pkg.scripts.test !== 'string' || !pkg.scripts.test.trim()) {
    return notRun('no_test_command', 'no test command: no package.json "test" script and no .quarterback.json test config');
  }
  return { status: 'run', runner, command: ['npm', 'test'], source: 'package.json' };
}

module.exports = { testPlan, CONFIG_FILE, VALIDATED };
