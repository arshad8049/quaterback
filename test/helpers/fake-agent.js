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
 *
 * stdin (the briefing) is drained and ignored.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const script = JSON.parse(fs.readFileSync(process.env.QB_FAKE_AGENT_SCRIPT, 'utf8'));

try { fs.readFileSync(0); } catch (_) {}

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
