'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

async function run (t, hookName, hook) {
  let uncaught = 0
  const onUncaught = () => { uncaught++ }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
  const app = Fastify()
  let onErrorCalls = 0
  app.addHook(hookName, hook)
  app.addHook('onError', (request, reply, err, done) => { onErrorCalls++; done() })
  app.get('/', async () => ({ ok: true }))
  try {
    const res = await Promise.race([
      app.inject({ method: 'GET', url: '/' }),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { res, onErrorCalls, uncaught }
  } finally {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onUncaught)
    await app.close()
  }
}

for (const [hookName, hook] of [
  ['onSend', async (request, reply, payload) => { reply.header('X-Invalid', '\n'); return payload }],
  ['preSerialization', async (request, reply) => { reply.header('X-Invalid', '\n') }]
]) {
  test(`an invalid header set in an async ${hookName} hook ends the request with a 500`, async (t) => {
    const { res, onErrorCalls, uncaught } = await run(t, hookName, hook)
    t.assert.ok(res !== null, 'the request got a response')
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(res.json().code, 'ERR_INVALID_CHAR')
    t.assert.ok(onErrorCalls >= 1, 'onError was called')
    t.assert.strictEqual(uncaught, 0)
  })
}
