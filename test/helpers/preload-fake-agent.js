/**
 * preload-fake-agent.js — `node --require` hook that makes a whole qb.js or
 * bench process run test/helpers/fake-agent.js instead of the real agent.
 *
 * The shipped CLI has no switch for this (QB-02 §10): only a process started
 * with this test-only preload can swap the agent. It wraps agent/runner's
 * exports before any caller destructures them.
 *
 *   QB_FAKE_AGENT_SCRIPT  JSON script read by fake-agent.js
 */

const runner = require('../../agent/runner');
const { FAKE_AGENT } = require('./mocks');

const FAKE_COMMAND = [process.execPath, FAKE_AGENT];

const { execute, runAgentCaptured } = runner;
runner.execute = (briefing, contract, context, options = {}) =>
  execute(briefing, contract, context, { ...options, agentCommand: FAKE_COMMAND });
runner.runAgentCaptured = (input, cwd, options = {}) =>
  runAgentCaptured(input, cwd, { ...options, agentCommand: FAKE_COMMAND });
