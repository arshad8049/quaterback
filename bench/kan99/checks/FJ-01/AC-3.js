// FJ-01 AC-3: a build that sets only largeArraySize uses the default mechanism
module.exports = async ({ require, assert }) => {
  const build = require('./index.js')
  const schema = { type: 'array', items: { type: 'integer' } }
  build(schema, { largeArraySize: 2, largeArrayMechanism: 'json-stringify' })
  const later = build(schema, { largeArraySize: 2 })
  assert.equal(later([1.5, 2.5]), '[1,2]')
}
