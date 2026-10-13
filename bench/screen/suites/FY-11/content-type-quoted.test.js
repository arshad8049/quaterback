'use strict'

const { test } = require('node:test')
const Fastify = require('../..')
const ContentType = require('../../lib/content-type')

test('a semicolon inside a quoted value is part of the value', (t) => {
  const found = new ContentType('application/json; name="foo;bar"; charset=utf-8')
  t.assert.strictEqual(found.isValid, true)
  t.assert.strictEqual(found.mediaType, 'application/json')
  t.assert.strictEqual(found.parameters.get('name'), 'foo;bar')
  t.assert.strictEqual(found.parameters.get('charset'), 'utf-8')
})

test('a key=value inside a quoted value does not leak out as a parameter', (t) => {
  const found = new ContentType('application/json; name="a=b;charset=fake"; boundary=xyz')
  t.assert.strictEqual(found.isValid, true)
  t.assert.strictEqual(found.parameters.get('name'), 'a=b;charset=fake')
  t.assert.strictEqual(found.parameters.get('boundary'), 'xyz')
  t.assert.strictEqual(found.parameters.has('charset'), false)
})

test('a quoted-pair is unescaped', (t) => {
  const found = new ContentType('application/json; name="he said \\"hi\\""')
  t.assert.strictEqual(found.isValid, true)
  t.assert.strictEqual(found.parameters.get('name'), 'he said "hi"')
})

test('simple quoted values keep working and keep their case', (t) => {
  const found = new ContentType('application/json; charset="utf-8"; foo="BaR"')
  t.assert.strictEqual(found.parameters.get('charset'), 'utf-8')
  t.assert.strictEqual(found.parameters.get('foo'), 'BaR')
})

test('reply.send is not fooled by charset= inside a quoted value', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.get('/', function (req, reply) {
    reply.header('content-type', 'application/json; name="a=b;charset=fake"')
    reply.send({ hello: 'world' })
  })
  const res = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'application/json; name="a=b;charset=fake"; charset=utf-8')
})
