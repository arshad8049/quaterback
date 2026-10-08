/**
 * QB-31 (re-review, comment 10264 item 4): the onboarding demo runs from a REVIEWED contract with
 * concrete acceptance checks — lower bound, upper bound, in range and the bounds themselves — not
 * from a placeholder test. The documented file loads as a finalized, traceable contract, every
 * check is accepted by the registry, and the real check runner passes a correct clamp and fails
 * plausible wrong ones.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { loadContractFile } = require('../../intent/contract-file');
const { contractState } = require('../../intent/contract-state');
const { validateChecks } = require('../../verify/checks/registry');
const { validateCheckResults } = require('../../verify/checks/results');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'docs', 'demo', 'clamp-contract.json');
const ONBOARDING = fs.readFileSync(path.join(ROOT, 'docs', 'onboarding.md'), 'utf8');
const REQUEST = ONBOARDING.match(/qb "([^"]+)" --repo qb-demo --agent claude-code --contract-file/)[1];
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');

function runChecks(impl, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-demo-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'utils.js'), impl);
    const out = path.join(dir, 'out.json');
    const r = proc.run(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }), encoding: 'utf8', env: { ...process.env, QB_CHECK_RESULTS: out }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const v = validateCheckResults(fs.readFileSync(out, 'utf8'), checks);
    assert.equal(v.ok, true);
    return Object.fromEntries(v.results.map((x) => [x.id, x.status]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('QB-31: the onboarding demo contract', () => {
  const { contract } = loadContractFile(FILE, REQUEST);
  test('the documented request and contract file load as a finalized, traceable contract', () => {
    assert.match(ONBOARDING, /--contract-file docs\/demo\/clamp-contract\.json|--contract-file \S*clamp-contract\.json/);
    assert.equal(contractState(contract).state, 'finalized', JSON.stringify(contractState(contract)));
  });
  test('every check is accepted, and lower bound, upper bound and in-range each have one', () => {
    const v = validateChecks(contract.checks, contract.acceptance_criteria);
    assert.deepEqual(v.rejected, []);
    const args = v.accepted.filter((c) => c.adapter === 'call_returns').map((c) => JSON.stringify(c.params.args));
    for (const a of ['[-5,0,10]', '[50,0,10]', '[7,0,10]']) assert.ok(args.includes(a), `no check for clamp(${a})`);
  });
  test('the real check runner: a correct clamp passes every check', () => {
    const r = runChecks('module.exports.clamp = (n, min, max) => Math.min(Math.max(n, min), max);\n', contract.checks);
    assert.deepEqual(Object.values(r).filter((s) => s !== 'pass'), []);
  });
  for (const [label, impl, failing] of [
    ['no lower bound', 'module.exports.clamp = (n, min, max) => Math.min(n, max);\n', 'CHK-LOWER'],
    ['no upper bound', 'module.exports.clamp = (n, min, max) => Math.max(n, min);\n', 'CHK-UPPER'],
    ['always a bound', 'module.exports.clamp = (n, min, max) => (n < (min + max) / 2 ? min : max);\n', 'CHK-INRANGE'],
    ['exclusive bounds', 'module.exports.clamp = (n, min, max) => (n <= min ? min + 1 : n >= max ? max - 1 : n);\n', 'CHK-AT-MIN'],
  ]) {
    test(`the real check runner: ${label} fails ${failing}`, () => assert.equal(runChecks(impl, contract.checks)[failing], 'fail'));
  }
});
