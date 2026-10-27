// FP-03 AC-1: fp(fn, { name: 123 }) throws TypeError
// "fastify-plugin expects a name string, instead got 'number'"
module.exports = async ({ require, assert }) => {
  const fp = require('./index.js')
  assert.throws(() => fp(function plugin () {}, { name: 123 }), (e) =>
    e instanceof TypeError && e.message === "fastify-plugin expects a name string, instead got 'number'")
}
