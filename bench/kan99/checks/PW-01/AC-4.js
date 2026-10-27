// PW-01 AC-4: trailing undefined arguments are not supplied: format(undefined) returns the message
// unchanged and format(0, undefined) on 'a=%s b=%s' gives 'a=0 b=%s'
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const one = createWarning({ name: 'W', code: 'C', message: 'count=%d' })
  assert.equal(one.format(undefined), 'count=%d')
  const two = createWarning({ name: 'W', code: 'C', message: 'a=%s b=%s' })
  assert.equal(two.format(0, undefined), 'a=0 b=%s')
}
