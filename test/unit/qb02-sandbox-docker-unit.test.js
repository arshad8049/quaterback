/**
 * QB-02 classification: Docker records an OOM kill from a separate event that can be
 * processed after the container's exit, so a first inspect may say OOMKilled=false.
 * runStage settles before trusting that (lib/sandbox/docker.js settleOom).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settleOom } = require('../../lib/sandbox/docker');
const { classifyStage } = require('../../lib/sandbox/states');

const exited = (extra = {}) => ({ Running: false, Status: 'exited', ExitCode: 0, OOMKilled: false, ...extra });

test('a late OOM event (seen on the 2nd inspect) is not missed: the stage is classified oom', async () => {
  let n = 0;
  const inspect = async () => (++n >= 2 ? exited({ OOMKilled: true }) : exited());
  const st = await settleOom('c', exited(), { tries: 3, delayMs: 5, inspect });
  assert.equal(st.OOMKilled, true);
  assert.equal(classifyStage(st, {}).state, 'oom');
});

test('no OOM: settles after a bounded number of re-inspects and stays completed', async () => {
  let n = 0;
  const inspect = async () => { n++; return exited(); };
  const st = await settleOom('c', exited(), { tries: 3, delayMs: 5, inspect });
  assert.equal(n, 3);
  assert.equal(classifyStage(st, {}).state, 'completed');
});

test('already OOMKilled, still running, or no state: no extra inspects', async () => {
  let n = 0;
  const inspect = async () => { n++; return exited(); };
  await settleOom('c', exited({ OOMKilled: true }), { inspect, delayMs: 5 });
  await settleOom('c', { Running: true }, { inspect, delayMs: 5 });
  await settleOom('c', null, { inspect, delayMs: 5 });
  assert.equal(n, 0);
});
