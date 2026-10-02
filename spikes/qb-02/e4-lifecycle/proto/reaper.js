#!/usr/bin/env node
/**
 * E4 prototype — the reaper that runs at the next QB start (§8.3).
 *
 * For each run with no terminal state: if both the CLI and the supervisor are
 * dead (by pid + start time, so a reused pid does not count as alive), kill and
 * remove the run's resources and commit ABANDONED. Runs whose owners are alive
 * are left alone. Prints one JSON decision per run.
 *
 * Usage: reaper.js <dir containing run dirs> [only-run-id]
 */

const fs = require('fs');
const path = require('path');
const C = require('./common');

const [stateDir, only] = process.argv.slice(2);
for (const runId of fs.readdirSync(stateDir)) {
  if (only && runId !== only) continue;
  const runDir = path.join(stateDir, runId);
  const run = C.readJson(path.join(runDir, 'run.json'));
  if (!run) continue;
  if (fs.existsSync(path.join(runDir, 'terminal.json'))) {
    // Terminal already committed: only make sure nothing was left behind.
    const left = C.cleanup(runDir, 'reaper', runId);
    console.log(JSON.stringify({ runId, decision: 'terminal_exists', left }));
    continue;
  }
  const cliAlive = C.alive(run.cli);
  const supAlive = C.alive(run.supervisor);
  if (cliAlive || supAlive) {
    console.log(JSON.stringify({ runId, decision: 'owner_alive', cliAlive, supAlive }));
    continue;
  }
  const k = C.killAll(runDir, 'reaper', runId);
  const won = C.commitTerminal(runDir, 'ABANDONED', 'reaper', 'owners_dead');
  const left = C.cleanup(runDir, 'reaper', runId);
  console.log(JSON.stringify({ runId, decision: 'reaped', won, kill_ms: k.kill_ms, left }));
}
