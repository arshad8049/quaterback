// PW-01 AC-5: an undefined before a supplied argument is interpolated: format('x', undefined, 'z')
// on '%s,%s,%s' gives 'x,undefined,z'
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const w = createWarning({ name: 'W', code: 'C', message: '%s,%s,%s' })
  assert.equal(w.format('x', undefined, 'z'), 'x,undefined,z')
}
