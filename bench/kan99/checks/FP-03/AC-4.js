// FP-03 AC-4: string names work as before
module.exports = async ({ require, assert }) => {
  const fp = require('./index.js')
  const fn = fp(function plugin () {}, { name: 'my-plugin' })
  assert.equal(fn[Symbol.for('fastify.display-name')], 'my-plugin')
  assert.equal(fn[Symbol.for('plugin-meta')].name, 'my-plugin')
}
