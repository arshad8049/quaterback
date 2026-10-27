// FJ-01 AC-2: a build that sets only largeArrayMechanism uses the default size 20000, not an
// earlier build's size. An array shorter than 20000 must not take the JSON.stringify path.
module.exports = async ({ require, assert }) => {
  const build = require('./index.js')
  const schema = { type: 'array', items: { type: 'integer' } }
  build(schema, { largeArraySize: 2 })
  const later = build(schema, { largeArrayMechanism: 'json-stringify' })
  assert.equal(later([1.5, 2.5, 1.5, 2.5]), '[1,2,1,2]')
}
