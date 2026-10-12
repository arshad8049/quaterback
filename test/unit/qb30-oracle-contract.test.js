/**
 * QB-30 dev pilot smoke (GitHub run 38284717301): both arms of PW-01 ended agent_error before any
 * agent call. Every frozen dev spec's approved oracle holds acceptance criteria only, and the
 * production execution gate (QB-17: incomplete compiler output is rejected; QB-14: requirements
 * must trace the request) refused the contract built from it — for all 30 tasks. The unit fixtures
 * passed because their oracle carried the missing fields; these tests use the REAL frozen specs.
 *
 * bench/arms.js oracleContract() now derives the missing fields deterministically from the frozen,
 * human-approved spec, inventing nothing: required_behavior = the frozen requirement text; one
 * requirement R-1 quoting the whole approved prompt verbatim (every clause traced by construction),
 * with every acceptance criterion tracing to it; verification_plan = the approved criteria. The
 * acceptance criteria themselves are unchanged, and nothing from the hidden suite is used.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { oracleContract } = require('../../bench/arms');
const { executionGate } = require('../../agent/runner');

const ROOT = path.join(__dirname, '..', '..', 'bench');
const ids = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'specs.lock.json'), 'utf8')).specs).sort();
const spec = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'specs', `${id}.json`), 'utf8'));

describe('QB-30: a frozen dev spec yields an executable contract', () => {
  test(`all ${ids.length} frozen dev specs pass the execution gate (pre-fix: 30/30 refused)`, () => {
    const refused = ids.map((id) => [id, executionGate(oracleContract(spec(id)), { agent: 'claude-code' })]).filter(([, g]) => g);
    assert.deepEqual(refused, []);
  });

  test('the contract is derived from the frozen spec only: criteria unchanged, whole prompt traced, requirement as required behaviour', () => {
    for (const id of ids) {
      const s = spec(id); const c = oracleContract(s);
      assert.deepEqual(c.acceptance_criteria.map((a) => [a.id, a.criterion]), s.oracle.acceptance_criteria.map((a) => [a.id, a.criterion]), id);
      assert.deepEqual(c.requirements.map((r) => r.quote), [s.prompt], id);
      assert.ok(c.acceptance_criteria.every((a) => a.requirement_ids && a.requirement_ids.includes('R-1')), id);
      assert.deepEqual(c.required_behavior, [s.requirement], id);
      assert.equal(c.verification_plan.length, s.oracle.acceptance_criteria.length, id);
    }
  });

  test('nothing from the hidden suite reaches the contract', () => {
    for (const id of ids) {
      const s = spec(id); const text = JSON.stringify(oracleContract(s));
      for (const f of Object.keys(s.suite.files)) assert.ok(!text.includes(f), `${id}: suite file ${f} named in the contract`);
      assert.ok(!text.includes('test/hidden'), id);
    }
  });
});
