// FJ-01 AC-4: the serializer built with json-stringify keeps that behaviour, also after a later
// build without options
module.exports = async ({ require, assert }) => {
  const build = require('./index.js')
  const schema = { type: 'array', items: { type: 'integer' } }
  const big = build(schema, { largeArraySize: 2, largeArrayMechanism: 'json-stringify' })
  build(schema)
  assert.equal(big([1.5, 2.5]), JSON.stringify([1.5, 2.5]))
}
