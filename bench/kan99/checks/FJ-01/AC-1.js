// FJ-01 AC-1: a build with no options after a json-stringify build rounds integer array items
// ([1.5, 2.5] → [1,2])
module.exports = async ({ require, assert }) => {
  const build = require('./index.js')
  const schema = { type: 'array', items: { type: 'integer' } }
  build(schema, { largeArraySize: 2, largeArrayMechanism: 'json-stringify' })
  const later = build(schema)
  assert.equal(later([1.5, 2.5]), '[1,2]')
}
