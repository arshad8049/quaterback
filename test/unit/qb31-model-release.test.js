/**
 * QB-31 walkthrough finding (GitHub Codespaces, 4 cores / 16 GB, 2026-10-12): qb doctor saw
 * 13.5 GiB free, but the L2 context stage loaded the local model (deepseek-r1:7b, ~5.6 GiB on
 * CPU) and Ollama kept it resident, so at sandbox admission only 7.9 GiB was free and both demo
 * runs ended BLOCKED insufficient_host_resources. Nothing uses the model while the sandbox runs,
 * so QB asks a LOCAL Ollama to unload it before admission and waits until it is gone.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { releaseLocalModel } = require('../../lib/model-release');

/** A minimal Ollama: /api/generate with keep_alive 0 unloads; /api/ps lists loaded models. */
function fakeOllama({ unloadAfterPolls = 1, generateStatus = 200 } = {}) {
  const seen = [];
  let loaded = true; let polls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/api/generate') {
        res.writeHead(generateStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ done: true, done_reason: 'unload' }));
      }
      if (req.url === '/api/ps') {
        if (++polls >= unloadAfterPolls) loaded = false;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: loaded ? [{ name: 'deepseek-r1:7b', model: 'deepseek-r1:7b' }] : [] }));
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)),
  })));
}

describe('QB-31: releaseLocalModel', () => {
  test('asks a local Ollama to unload QB_MODEL (keep_alive 0) and waits until it is no longer loaded', async () => {
    const o = await fakeOllama({ unloadAfterPolls: 3 });
    try {
      const r = await releaseLocalModel({ url: o.url, model: 'deepseek-r1:7b', pollMs: 10 });
      assert.equal(r.status, 'released', JSON.stringify(r));
      const gen = o.seen.find((s) => s.url === '/api/generate');
      assert.deepEqual(gen.body, { model: 'deepseek-r1:7b', keep_alive: 0 });
      assert.equal(o.seen.filter((s) => s.url === '/api/ps').length, 3, 'polled until the model left memory');
    } finally { await o.close(); }
  });

  test('a model server on another host is never asked (unloading it frees nothing here, and may be shared)', async () => {
    let called = false;
    const r = await releaseLocalModel({ url: 'http://10.0.0.5:11434', model: 'm', fetchImpl: async () => { called = true; } });
    assert.equal(r.status, 'skipped_remote');
    assert.equal(called, false);
  });

  test('best effort: no server, an error status, or a model that never unloads → reported, never thrown', async () => {
    const none = await releaseLocalModel({ url: 'http://127.0.0.1:9', model: 'm', timeoutMs: 500 });
    assert.equal(none.status, 'failed');
    const bad = await fakeOllama({ generateStatus: 500 });
    try { assert.equal((await releaseLocalModel({ url: bad.url, model: 'm', pollMs: 10 })).status, 'failed'); } finally { await bad.close(); }
    const stuck = await fakeOllama({ unloadAfterPolls: 1e9 });
    try {
      const r = await releaseLocalModel({ url: stuck.url, model: 'deepseek-r1:7b', pollMs: 5, waitMs: 60 });
      assert.equal(r.status, 'failed');
      assert.match(r.detail, /still loaded/);
    } finally { await stuck.close(); }
  });

  test('localhost names count as local: localhost, 127.x and [::1]', async () => {
    for (const url of ['http://localhost:1', 'http://127.0.0.2:1', 'http://[::1]:1']) {
      const r = await releaseLocalModel({ url, model: 'm', timeoutMs: 200 });
      assert.notEqual(r.status, 'skipped_remote', url);
    }
  });
});

describe('QB-31: the sandbox releases the local model BEFORE admission', () => {
  test('order is release → admit, and the release is recorded in the sandbox evidence', async () => {
    const order = [];
    const dir = path.join(__dirname, '..', '..', 'lib');
    const stub = (rel, exports) => {
      const p = require.resolve(path.join(dir, rel));
      require.cache[p] = { id: p, filename: p, loaded: true, exports };
      return p;
    };
    const real = require(path.join(dir, 'sandbox', 'admission'));
    const stubbed = [
      stub('sandbox/docker', { ...require(path.join(dir, 'sandbox', 'docker')), available: async () => '29.0.0' }),
      stub('sandbox/reaper', { reap: async () => [] }),
      stub('sandbox/admission', { ...real, admit: () => { order.push('admit'); return { ok: false, reason: 'insufficient_host_resources' }; } }),
      stub('model-release', { releaseLocalModel: async () => { order.push('release'); return { status: 'released' }; } }),
    ];
    const pipelinePath = require.resolve(path.join(dir, 'sandbox', 'pipeline'));
    delete require.cache[pipelinePath];
    try {
      const { runSandboxed } = require(pipelinePath);
      const r = await runSandboxed({ repoPath: __dirname, briefing: 'x', stateDir: require('os').tmpdir() });
      assert.deepEqual(order, ['release', 'admit']);
      assert.equal(r.status, 'blocked');
      assert.deepEqual(r.sandbox.model_release, { status: 'released' });
    } finally {
      for (const p of [...stubbed, pipelinePath]) delete require.cache[p];
    }
  });
});
