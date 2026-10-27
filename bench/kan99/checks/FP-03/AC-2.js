// FP-03 AC-2: objects, booleans and null are rejected the same way (null reports 'object')
module.exports = async ({ require, assert }) => {
  const fp = require('./index.js')
  const cases = [[{}, 'object'], [true, 'boolean'], [false, 'boolean'], [null, 'object']]
  for (const [name, type] of cases) {
    assert.throws(() => fp(function plugin () {}, { name }), (e) =>
      e instanceof TypeError && e.message === `fastify-plugin expects a name string, instead got '${type}'`,
    `name ${String(name)} was not rejected as '${type}'`)
  }
}
