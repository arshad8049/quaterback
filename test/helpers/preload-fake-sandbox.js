/**
 * preload-fake-sandbox.js — `node --require` hook (TEST ONLY) that replaces the
 * sandbox pipeline for a whole qb.js / bench process, so the CLI can be driven
 * end to end without Docker.
 *
 * The stand-in runs test/helpers/fake-agent.js on the host in a throwaway COPY
 * of the repository it is given (never the original), and reports which files
 * the agent changed. Results are marked isolation "none-test-only" and can
 * satisfy no gate (agent-sandbox.md §10). Only a process started with this
 * preload can use it; the shipped CLI has no switch for it.
 *
 *   QB_FAKE_AGENT_SCRIPT  JSON script read by fake-agent.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pipeline = require('../../lib/sandbox/pipeline');
const { FAKE_AGENT } = require('./mocks');

function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' && d === dir) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = crypto.createHash('sha256').update(e.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs)).digest('hex');
    }
  })(dir);
  return out;
}

pipeline.runSandboxed = async ({ repoPath, briefing }) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-fake-sandbox-'));
  try {
    fs.cpSync(repoPath, copy, { recursive: true, verbatimSymlinks: true });
    const before = snapshot(copy);
    const r = spawnSync(process.execPath, [FAKE_AGENT], { cwd: copy, input: briefing, encoding: 'utf8' });
    const after = snapshot(copy);
    const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
    const changes = files.map((file) => ({ file, status: !before[file] ? 'A' : !after[file] ? 'D' : 'M', additions: 1, deletions: 0 }));
    const status = r.status !== 0 ? 'execution_error' : changes.length ? 'completed' : 'no_change';
    return {
      status, reason: status, changes, unsupported_changes: [],
      diff: changes.length ? changes.map((c) => `diff --git a/${c.file} b/${c.file}\n`).join('') : null,
      base_tree: null, candidate_tree: null, exit_code: r.status, signal: null,
      stderr_tail: (r.stderr || '').slice(-2000), sandbox: { isolation: 'none-test-only' },
    };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
};
