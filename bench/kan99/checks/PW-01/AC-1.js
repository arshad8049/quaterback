// PW-01 AC-1: createWarning({ name: 'W', code: 'C', message: 'count=%d' }).format(0) returns 'count=0'
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const w = createWarning({ name: 'W', code: 'C', message: 'count=%d' })
  assert.equal(w.format(0), 'count=0')
}
