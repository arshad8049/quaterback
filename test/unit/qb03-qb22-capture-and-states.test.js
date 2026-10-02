/**
 * QB-03 — change capture includes the whole result.
 *   Done when: staged, unstaged, new, committed, renamed, deleted, binary,
 *   mode and unusual-path changes are captured or explicitly rejected; no
 *   partial capture can receive PASS.
 *
 * QB-22 — execution errors are distinct from dry-run / no change.
 *   Done when: timeout, nonzero exit, and a genuine dry-run are distinct;
 *   partial edits remain inspectable.
 *
 * The coding agent is test/helpers/fake-agent.js driven by a JSON script.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const { FAKE_AGENT, mockFetch, ollamaReply } = require('../helpers/mocks');
const { execute, runAgentCaptured } = require('../../agent/runner');
const { verify } = require('../../verify/verifier');

let repo, scriptFile;
const savedCmd = process.env.QB_AGENT_COMMAND;

beforeEach(() => {
  repo = makeRepo({
    'src/a.js': 'const a = 1;\n',
    'src/old.js': 'module.exports = "old";\n',
    'run.sh': '#!/bin/sh\necho hi\n',
    'del.js': 'gone\n',
    '.gitignore': 'secret.env\n',
  });
  scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-script-')), 'script.json');
  process.env.QB_AGENT_COMMAND = JSON.stringify([process.execPath, FAKE_AGENT]);
  process.env.QB_FAKE_AGENT_SCRIPT = scriptFile;
});
afterEach(() => {
  repo.cleanup();
  fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
  if (savedCmd === undefined) delete process.env.QB_AGENT_COMMAND; else process.env.QB_AGENT_COMMAND = savedCmd;
});

function agentDoes(steps) {
  fs.writeFileSync(scriptFile, JSON.stringify({ steps }));
}

describe('QB-03 change capture', () => {
  test('captures every kind of change regardless of what the agent did with git', () => {
    agentDoes([
      { write: 'src/a.js', content: 'const a = 2;\n' },                      // unstaged edit
      { write: 'src/staged.js', content: 'staged\n' }, { git: ['add', 'src/staged.js'] },   // staged new
      { write: 'src/untracked.js', content: 'new\n' },                       // untracked new
      { write: 'src/committed.js', content: 'c\n' },
      { git: ['add', 'src/committed.js'] }, { git: ['commit', '-q', '-m', 'agent commit'] },  // committed
      { rename: ['src/old.js', 'src/renamed.js'] },                          // rename
      { delete: 'del.js' },                                                  // delete
      { write: 'img.bin', content: 'AAECAwT/AA==', encoding: 'base64' },     // binary
      { chmod: ['run.sh', 0o755] },                                          // mode
      { write: 'weird name\nwith newline.js', content: 'w\n' },              // unusual path
      { symlink: ['src/a.js', 'link.js'] },                                  // symlink
      { write: 'secret.env', content: 'TOKEN=1\n' },                         // ignored
    ]);

    const r = runAgentCaptured('task', repo.dir);
    assert.equal(r.status, 'completed');

    const byFile = Object.fromEntries(r.changes.map(c => [c.file, c]));
    assert.equal(byFile['src/a.js'].status, 'M');
    assert.equal(byFile['src/staged.js'].status, 'A');
    assert.equal(byFile['src/untracked.js'].status, 'A');
    assert.equal(byFile['src/committed.js'].status, 'A', 'agent-committed file missing');
    assert.equal(byFile['src/renamed.js'].status, 'R');
    assert.equal(byFile['src/renamed.js'].old_file, 'src/old.js');
    assert.equal(byFile['del.js'].status, 'D');
    assert.equal(byFile['img.bin'].binary, true);
    assert.equal(byFile['run.sh'].status, 'M', 'mode change missing');
    assert.ok(byFile['weird name\nwith newline.js'], 'newline path missing');
    assert.equal(byFile['link.js'].status, 'A');
    assert.equal(byFile['secret.env'], undefined, 'ignored files are not captured');

    assert.match(r.diff, /GIT binary patch/);
    assert.match(r.diff, /new mode 100755|old mode 100644/);
    assert.deepEqual(r.unsupported_changes, []);
  });

  test('capture does not modify the repository index, HEAD or refs', () => {
    repo.write('src/a.js', 'user edit\n');
    repo.git(['add', 'src/a.js']);
    const before = { head: repo.head(), index: repo.git(['ls-files', '-s']), refs: repo.git(['show-ref']) };

    agentDoes([{ write: 'src/new.js', content: 'n\n' }]);
    const r = runAgentCaptured('task', repo.dir);

    assert.deepEqual(r.changes.map(c => c.file), ['src/new.js'], "the user's own staged edit is not attributed to the agent");
    assert.deepEqual({ head: repo.head(), index: repo.git(['ls-files', '-s']), refs: repo.git(['show-ref']) }, before);
  });

  test('a submodule change is flagged unsupported and cannot PASS', async () => {
    const sub = makeRepo({ 'x': '1\n' });
    try {
      agentDoes([{ git: ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'vendor/sub'] }]);
      const exec = await execute('task', { id: 'c' }, null, { agent: 'claude-code', repoPath: repo.dir });
      assert.ok(exec.unsupported_changes.includes('vendor/sub'), JSON.stringify(exec.unsupported_changes));

      const fetchMock = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
      try {
        const report = await verify(
          { id: 'c', acceptance_criteria: [{ id: 'AC-1', criterion: 'vendor added', met: null }] },
          null, exec, { repoPath: repo.dir },
        );
        assert.notEqual(report.verdict, 'pass');
      } finally {
        fetchMock.restore();
      }
    } finally {
      sub.cleanup();
    }
  });
});

describe('QB-22 execution states', () => {
  async function run(steps, opts = {}) {
    agentDoes(steps);
    return execute('task', { id: 'c' }, null, { agent: 'claude-code', repoPath: repo.dir, ...opts });
  }

  test('nonzero exit is execution_error, and partial edits stay inspectable', async () => {
    const e = await run([{ write: 'src/a.js', content: 'half done\n' }, { stderr: 'boom' }, { exit: 3 }]);
    assert.equal(e.status, 'execution_error');
    assert.equal(e.exit_code, 3);
    assert.match(e.stderr_tail, /boom/);
    assert.deepEqual(e.changes.map(c => c.file), ['src/a.js']);
    assert.match(e.diff, /half done/);
  });

  test('timeout is its own state', async () => {
    const e = await run([{ write: 'src/a.js', content: 'slow\n' }, { sleep: 5000 }], { timeoutMs: 300 });
    assert.equal(e.status, 'timeout');
    assert.deepEqual(e.changes.map(c => c.file), ['src/a.js']);
  });

  test('a missing agent executable is execution_error, not dry-run', async () => {
    process.env.QB_AGENT_COMMAND = JSON.stringify(['/nonexistent/qb-agent']);
    const e = await run([]);
    assert.equal(e.status, 'execution_error');
    assert.match(e.error, /ENOENT/);
  });

  test('success without edits is no_change; genuine dry-run is dry_run', async () => {
    assert.equal((await run([{ stdout: 'already done' }])).status, 'no_change');
    const dry = await execute('task', { id: 'c' }, null, { agent: 'dry-run', repoPath: repo.dir });
    assert.equal(dry.status, 'dry_run');
  });

  test('verifier maps each state to a distinct verdict and never judges a failed run', async () => {
    const fetchMock = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
    const contract = { id: 'c', acceptance_criteria: [{ id: 'AC-1', criterion: 'a is 2', met: null }] };
    try {
      const failed = await run([{ write: 'src/a.js', content: 'const a = 2;\n' }, { exit: 1 }]);
      const r1 = await verify(contract, null, failed, { repoPath: repo.dir });
      assert.equal(r1.verdict, 'error');
      assert.equal(fetchMock.calls.length, 0, 'judge must not run on a failed execution');

      const none = await run([]);
      assert.equal((await verify(contract, null, none, { repoPath: repo.dir })).verdict, 'unresolved');

      const dry = await execute('task', contract, null, { agent: 'dry-run', repoPath: repo.dir });
      assert.equal((await verify(contract, null, dry, { repoPath: repo.dir })).verdict, 'no-diff');
    } finally {
      fetchMock.restore();
    }
  });
});
