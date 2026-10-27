// PW-01 AC-2: format interpolates '', false and null (message 'v=%s' with null gives 'v=null')
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const w = createWarning({ name: 'W', code: 'C', message: 'v=%s' })
  assert.equal(w.format(null), 'v=null')
  assert.equal(w.format(false), 'v=false')
  assert.equal(w.format(''), 'v=')
}
