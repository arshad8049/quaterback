/**
 * QB-31: `qb doctor` checks a machine before a run: runtime, git, Docker, agent sign-in, model
 * availability, the agent adapter and the check registry, and (with --repo) the repository and
 * its test runner. Each check is ok / warn / fail / skip with a fix; any fail → exit 1.
 * Probes are injected, so every state is tested without depending on this machine.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { makeRepo } = require('../helpers/tmprepo');
const { doctor, formatDoctor } = require('../../lib/doctor');

const healthy = (over = {}) => ({
  nodeVersion: 'v24.1.0',
  gitVersion: async () => 'git version 2.45.0',
  dockerVersion: async () => '28.1.1',
  authVolumeExists: async () => true,
  modelTags: async () => ['deepseek-r1:7b', 'llama3:latest'],
  ...over,
});
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('QB-31: qb doctor', () => {
  test('a healthy machine for claude-code: every check ok, exit 0', async () => {
    const r = await doctor({ agent: 'claude-code', env: {} }, healthy());
    assert.deepEqual(r.checks.map((c) => c.id), ['runtime', 'git', 'docker', 'agent-auth', 'model', 'agent-adapter', 'check-registry']);
    // Credentials can only be shown PRESENT here; a successful authenticated call proves them valid.
    assert.deepEqual(r.checks.filter((c) => c.status !== 'ok').map((c) => [c.id, c.status]), [['agent-auth', 'warn']]);
    assert.match(r.checks.find((c) => c.id === 'agent-auth').detail, /login volume present; validity not verified/);
    assert.equal(r.exitCode, 0);
    assert.match(byId(r)['agent-adapter'].detail, /claude-code.*supported.*qb-agent-adapter\/1/);
  });

  for (const [label, over, id, re] of [
    ['Node below 20', { nodeVersion: 'v18.19.0' }, 'runtime', /Node 18.*needs Node 20/],
    ['no git', { gitVersion: async () => null }, 'git', /git not found/],
    ['Docker not answering', { dockerVersion: async () => null }, 'docker', /Docker is not running or not reachable/],
    ['not signed in', { authVolumeExists: async () => false }, 'agent-auth', /not signed in.*qb auth login/],
    ['the model server unreachable', { modelTags: async () => null }, 'model', /no model server at http:\/\/127\.0\.0\.1:11434/],
    ['the model not pulled', { modelTags: async () => ['llama3:latest'] }, 'model', /deepseek-r1:7b is not available.*ollama pull deepseek-r1:7b/],
  ]) {
    test(`${label} → that check fails with a fix, exit 1`, async () => {
      const r = await doctor({ agent: 'claude-code', env: {} }, healthy(over));
      const c = byId(r)[id];
      assert.equal(c.status, 'fail');
      assert.match(`${c.detail} ${c.fix || ''}`, re);
      assert.equal(r.exitCode, 1);
    });
  }

  test('an API key is reported as a credential PRESENT, not a verified login (and Docker is not asked)', async () => {
    const r = await doctor({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: 'sk-x' } }, healthy({ authVolumeExists: async () => { throw new Error('not consulted'); } }));
    assert.equal(byId(r)['agent-auth'].status, 'warn');
    assert.match(byId(r)['agent-auth'].detail, /ANTHROPIC_API_KEY is set; validity not verified/);
    assert.doesNotMatch(byId(r)['agent-auth'].detail, /signed in/);
  });

  test('sign-in cannot be checked while Docker is down: fail, not ok', async () => {
    const r = await doctor({ agent: 'claude-code', env: {} }, healthy({ dockerVersion: async () => null, authVolumeExists: async () => { throw new Error('docker down'); } }));
    assert.equal(byId(r)['agent-auth'].status, 'fail');
    assert.match(byId(r)['agent-auth'].detail, /cannot check.*Docker/);
  });

  test('dry-run needs neither Docker nor sign-in: skipped, exit 0', async () => {
    const r = await doctor({ agent: 'dry-run', env: {} }, healthy({ dockerVersion: async () => null, authVolumeExists: async () => false }));
    assert.equal(byId(r)['agent-auth'].status, 'skip');
    assert.equal(byId(r).docker.status, 'warn');
    assert.equal(r.exitCode, 0);
  });

  test('QB_MODEL and QB_OLLAMA_URL are honoured; a model is matched with or without :latest', async () => {
    const seen = [];
    const r = await doctor({ agent: 'dry-run', env: { QB_MODEL: 'llama3', QB_OLLAMA_URL: 'http://10.0.0.5:11434' } },
      healthy({ modelTags: async (url) => { seen.push(url); return ['llama3:latest']; } }));
    assert.equal(byId(r).model.status, 'ok');
    assert.deepEqual(seen, ['http://10.0.0.5:11434']);
  });

  test('an unsupported agent fails the adapter check with the reason', async () => {
    const r = await doctor({ agent: 'cursor', env: {} }, healthy());
    assert.equal(byId(r)['agent-adapter'].status, 'fail');
    assert.match(byId(r)['agent-adapter'].detail, /not supported yet/);
  });

  describe('--repo', () => {
    test('a node:test repository: the repository and its runner are ok', async () => {
      const repo = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'test/a.test.js': '' });
      try {
        const r = await doctor({ agent: 'dry-run', repo: repo.dir, env: {} }, healthy());
        assert.equal(byId(r).repository.status, 'ok');
        assert.equal(byId(r)['test-runner'].status, 'ok');
        assert.match(byId(r)['test-runner'].detail, /node-test/);
      } finally { repo.cleanup(); }
    });
    test('an unsupported test runner is a warning naming it (the run continues; tests are not_run)', async () => {
      const repo = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '29' } }) });
      try {
        const r = await doctor({ agent: 'dry-run', repo: repo.dir, env: {} }, healthy());
        assert.equal(byId(r)['test-runner'].status, 'warn');
        assert.match(byId(r)['test-runner'].detail, /unsupported runner: jest/);
      } finally { repo.cleanup(); }
    });
    test('a directory that is not a git work tree fails for claude-code and warns for dry-run', async () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-doc-'));
      try {
        const r = await doctor({ agent: 'claude-code', repo: d, env: {} }, healthy());
        assert.equal(byId(r).repository.status, 'fail');
        assert.equal(r.exitCode, 1);
        const dry = await doctor({ agent: 'dry-run', repo: d, env: {} }, healthy());
        assert.equal(byId(dry).repository.status, 'warn');
        assert.equal(dry.exitCode, 0);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });

  test('the report is printable: one line per check with its fix', async () => {
    const r = await doctor({ agent: 'claude-code', env: {} }, healthy({ authVolumeExists: async () => false }));
    const out = formatDoctor(r);
    assert.match(out, /✓ runtime/);
    assert.match(out, /✗ agent-auth.*\n\s+fix: qb auth login/);
    assert.match(out, /1 problem/);
  });

  test('qb doctor runs from the CLI: --json, and unsupported options exit 2', () => {
    const QB = path.join(__dirname, '..', '..', 'qb.js');
    const r = proc.run(process.execPath, [QB, 'doctor', '--agent', 'dry-run', '--json'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, QB_OLLAMA_URL: 'http://127.0.0.1:9' } });
    const report = JSON.parse(r.stdout);
    assert.equal(report.schema, 'qb-doctor/1');
    assert.equal(report.checks.find((c) => c.id === 'model').status, 'fail');
    assert.equal(r.status, 1);
    assert.equal(proc.run(process.execPath, [QB, 'doctor', '--bogus'], { encoding: 'utf8', timeout: 30_000 }).status, 2);
  });
});
