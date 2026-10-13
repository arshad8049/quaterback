'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

/** Collect process warnings emitted while fn runs (warnings are emitted on the next tick). */
async function warningsDuring (fn) {
  const seen = []
  const on = (w) => seen.push(w)
  process.on('warning', on)
  try {
    fn()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } finally { process.removeListener('warning', on) }
  return seen.filter((w) => w.code === 'FSTDEP025')
}

test('overriding an existing method without overrideExisting emits FSTDEP025', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  const w = await warningsDuring(() => fastify.addHttpMethod('GET', { hasBody: true }))
  t.assert.strictEqual(w.length, 1)
  t.assert.strictEqual(w[0].name, 'FastifyDeprecation')
  t.assert.strictEqual(w[0].message, 'Calling addHttpMethod for existing method "GET" without { overrideExisting: true } is deprecated. In Fastify v6, this will throw an error.')
})

test('the warning is emitted every time, not only once', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  const w = await warningsDuring(() => { fastify.addHttpMethod('POST'); fastify.addHttpMethod('DELETE') })
  t.assert.deepStrictEqual(w.map((x) => x.message.match(/"(\w+)"/)[1]), ['POST', 'DELETE'])
})

test('overrideExisting: true and a new method emit no warning', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  const w = await warningsDuring(() => { fastify.addHttpMethod('PUT', { overrideExisting: true }); fastify.addHttpMethod('MKCOL') })
  t.assert.strictEqual(w.length, 0)
})

test('an explicit override still changes the body behaviour', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.addHttpMethod('GET', { hasBody: true, overrideExisting: true })
  fastify.route({ method: 'GET', url: '/', exposeHeadRoute: false, schema: { body: { type: 'object' } }, handler: async (request) => request.body })
  const res = await fastify.inject({ method: 'GET', url: '/', payload: { hello: 'world' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world' })
})
