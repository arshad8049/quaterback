#!/usr/bin/env node
/**
 * fake-agent.js — a scripted stand-in for `claude --print`.
 *
 * Reads its behaviour from the JSON file named by QB_FAKE_AGENT_SCRIPT and
 * performs the steps in its cwd (the workspace it was launched in):
 *
 *   { "steps": [
 *       { "write":  "src/a.js", "content": "..." },
 *       { "delete": "old.js" },
 *       { "rename": ["a.js", "b.js"] },
 *       { "git":    ["add", "-A"] },
 *       { "sleep":  5000 },
 *       { "touch":  "/abs/path/outside" },
 *       { "exit":   3 }
 *   ] }
 *   or { "attempts": [ { "steps": [...] }, … ] } with QB_FAKE_AGENT_COUNTER (one script per run)
 *
 * stdin (the briefing) is drained; with QB_FAKE_AGENT_BRIEFING_LOG it is appended there.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const script = JSON.parse(fs.readFileSync(process.env.QB_FAKE_AGENT_SCRIPT, 'utf8'));
// { "attempts": [ { "steps": [...] }, { "steps": [...] } ] } — a different script per
// invocation (repair attempts), counted in the file named by QB_FAKE_AGENT_COUNTER.
if (Array.isArray(script.attempts)) {
  const counter = process.env.QB_FAKE_AGENT_COUNTER;
  const n = counter && fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0;
  if (counter) fs.writeFileSync(counter, String(n + 1));
  script.steps = (script.attempts[Math.min(n, script.attempts.length - 1)] || {}).steps || [];
}

let briefing = '';
try { briefing = fs.readFileSync(0, 'utf8'); } catch (_) {}
// QB-18 tests: record each invocation's briefing (one JSON line per attempt).
if (process.env.QB_FAKE_AGENT_BRIEFING_LOG) fs.appendFileSync(process.env.QB_FAKE_AGENT_BRIEFING_LOG, JSON.stringify(briefing) + '\n');

for (const step of script.steps || []) {
  if (step.write !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(step.write)), { recursive: true });
    fs.writeFileSync(step.write, Buffer.from(step.content, step.encoding || 'utf8'));
  } else if (step.delete !== undefined) {
    fs.rmSync(step.delete, { force: true });
  } else if (step.rename !== undefined) {
    fs.renameSync(step.rename[0], step.rename[1]);
  } else if (step.chmod !== undefined) {
    fs.chmodSync(step.chmod[0], step.chmod[1]);
  } else if (step.symlink !== undefined) {
    fs.symlinkSync(step.symlink[0], step.symlink[1]);
  } else if (step.git !== undefined) {
    execFileSync('git', step.git, {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fake-agent', GIT_AUTHOR_EMAIL: 'fake@example.invalid',
        GIT_COMMITTER_NAME: 'fake-agent', GIT_COMMITTER_EMAIL: 'fake@example.invalid',
      },
    });
  } else if (step.touch !== undefined) {
    fs.writeFileSync(step.touch, 'escaped');
  } else if (step.sleep !== undefined) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleep);
  } else if (step.stdout !== undefined) {
    process.stdout.write(step.stdout);
  } else if (step.stderr !== undefined) {
    process.stderr.write(step.stderr);
  } else if (step.exit !== undefined) {
    process.exit(step.exit);
  }
}

process.exit(0);
