// FP-03 AC-3: no name or name '' still auto-names the plugin
module.exports = async ({ require, assert }) => {
  const fp = require('./index.js')
  const display = Symbol.for('fastify.display-name')
  const a = fp(function first () {})
  const b = fp(function second () {}, { name: '' })
  assert.match(String(a[display]), /-auto-\d+$/)
  assert.match(String(b[display]), /-auto-\d+$/)
}
