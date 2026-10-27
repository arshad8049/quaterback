// PW-01 AC-6: format() with no arguments returns the message unchanged, and truthy arguments
// interpolate as before
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const w = createWarning({ name: 'W', code: 'C', message: '%s-%s-%s' })
  assert.equal(w.format(), '%s-%s-%s')
  assert.equal(w.format('a'), 'a-%s-%s')
  assert.equal(w.format('a', 'b'), 'a-b-%s')
  assert.equal(w.format('a', 'b', 'c'), 'a-b-c')
}
