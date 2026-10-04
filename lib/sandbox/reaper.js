/**
 * lib/sandbox/reaper.js — next-start recovery (agent-sandbox.md §8.3, G5b).
 *
 * For each sandbox run directory without a terminal state: if both the CLI and
 * the supervisor are gone (pid + start time, so a reused pid does not count),
 * kill and remove the run's Docker resources and commit ABANDONED. Runs whose
 * owners are alive are left alone. Runs that already have a terminal state get
 * their resources removed if any were left behind.
 */

const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const D = require('./docker');

async function reap(sandboxRoot) {
  if (!fs.existsSync(sandboxRoot)) return [];
  const decisions = [];
  for (const runId of fs.readdirSync(sandboxRoot)) {
    const runDir = path.join(sandboxRoot, runId);
    const run = P.readJson(path.join(runDir, 'run.json'));
    if (!run) continue;
    if (P.terminal(runDir)) {
      const left = await D.removeRun(runId);
      decisions.push({ runId, decision: 'terminal_exists', left });
      continue;
    }
    if (P.alive(run.cli) || P.alive(run.supervisor)) {
      decisions.push({ runId, decision: 'owner_alive' });
      continue;
    }
    for (let i = 0; i < 5; i++) {
      const running = await D.runContainers(runId, { running: true });
      if (!running.length) break;
      await D.op(['kill', ...running]);
    }
    const won = P.commitTerminal(runDir, 'ABANDONED', 'reaper', 'owners_dead');
    const left = await D.removeRun(runId);
    P.event(runDir, 'reaper', 'reaped', { won, left });
    decisions.push({ runId, decision: 'reaped', won, left });
  }
  return decisions;
}

module.exports = { reap };
