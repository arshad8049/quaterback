/**
 * QB-26: each CI job publishes an evidence record (scripts/ci-evidence.js) with
 * runtime, agent version, timeouts, models called, cost and test counts, and
 * names the known-defect TODOs so green CI is not read as "all defects fixed".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ev = require('../../scripts/ci-evidence');

const TAP = `TAP version 13
ok 1 - a
not ok 2 - QB-08 Recipe A: clarification-only contract never reaches PASS # TODO Phase 2 — QB-08
# Subtest: suite
    not ok 1 - nested known defect # TODO
ok 3 - suite
1..3
# tests 4
# suites 1
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 2
`;

test('parseTap reads the totals and names every TODO (known defect)', () => {
  const t = ev.parseTap(TAP);
  assert.deepEqual([t.tests, t.pass, t.fail, t.skipped, t.todo], [4, 2, 0, 0, 2]);
  assert.deepEqual(t.todo_tests.map((x) => x.test), ['QB-08 Recipe A: clarification-only contract never reaches PASS', 'nested known defect']);
  assert.equal(ev.parseTap('').tests, null);
});

test('the record states models called, cost and timeouts', () => {
  const e = ev.collect('unit-node22', TAP, { QB_CI_JOB_TIMEOUT_MINUTES: '15' });
  assert.deepEqual(e.models.called, []);
  assert.equal(e.cost.usd, 0);
  assert.deepEqual(e.cost.credentials_present, []);
  assert.equal(e.timeouts.job_minutes, 15);
  assert.ok(e.timeouts.sandbox_stage_deadlines_ms.agent > 0);
  assert.match(e.agent.version, /^claude-code@\d+\.\d+\.\d+ \(qb-sandbox-agent:c-[0-9a-f]{16}\)$/);
  assert.match(ev.summary(e), /Known defects \(todo, non-gating; not fixed\)/);
});

test('a model credential in the CI environment is reported and fails the job', () => {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;            // don't write test records into the real CI summary
  delete process.env.GITHUB_STEP_SUMMARY;
  const e = ev.collect('unit', TAP, { ANTHROPIC_API_KEY: 'x' });
  assert.deepEqual(e.cost.credentials_present, ['ANTHROPIC_API_KEY']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-ev-'));
  try {
    const tap = path.join(dir, 't.tap');
    fs.writeFileSync(tap, TAP);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'x';
    const quiet = process.stdout.write; process.stdout.write = () => true;
    const errw = console.error; console.error = () => {};
    try { assert.equal(ev.main_for_test(['unit', tap, path.join(dir, 'o.json')]), 1); }
    finally {
      process.stdout.write = quiet; console.error = errw;
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
    delete process.env.ANTHROPIC_API_KEY;
    process.stdout.write = () => true;
    try { assert.equal(ev.main_for_test(['unit', tap, path.join(dir, 'o.json')]), 0); }
    finally { process.stdout.write = quiet; if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8')).tests.pass, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (summaryFile !== undefined) process.env.GITHUB_STEP_SUMMARY = summaryFile;
  }
});
