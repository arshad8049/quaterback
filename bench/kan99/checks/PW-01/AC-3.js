// PW-01 AC-3: the message emitted by calling the warning with 0 is 'count=0' (no trailing 'undefined')
module.exports = async ({ require, assert }) => {
  const { createWarning } = require('./index.js')
  const w = createWarning({ name: 'W', code: 'QB_PW01_AC3', message: 'count=%d' })
  const emitted = new Promise((resolve) => {
    const on = (warning) => { if (warning.code === 'QB_PW01_AC3') { process.off('warning', on); resolve(warning) } }
    process.on('warning', on)
  })
  w(0)
  const warning = await Promise.race([emitted, new Promise((resolve) => setTimeout(resolve, 2000, null))])
  assert.ok(warning, 'no warning was emitted')
  assert.equal(warning.message, 'count=0')
}
