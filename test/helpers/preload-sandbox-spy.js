/**
 * preload-sandbox-spy.js — `node --require` hook (TEST ONLY): every sandbox (agent) launch is
 * appended to $QB_TEST_SANDBOX_LOG and reported as blocked, so a CLI test can assert that no
 * agent was launched. The shipped CLI has no switch for it.
 */
const fs = require('fs');
const pipeline = require('../../lib/sandbox/pipeline');

pipeline.runSandboxed = async (o) => {
  if (process.env.QB_TEST_SANDBOX_LOG) fs.appendFileSync(process.env.QB_TEST_SANDBOX_LOG, `launch ${o && o.repoPath}\n`);
  return { status: 'blocked', reason: 'test spy: no sandbox', diff: null, changes: [], unsupported_changes: [], sandbox: {} };
};
