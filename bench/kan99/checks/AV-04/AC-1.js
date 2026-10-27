// AV-04 AC-1: after('x') throws synchronously with code AVV_ERR_CALLBACK_NOT_FN and message
// "Callback for 'after' hook is not a function. Received: 'string'"
module.exports = async ({ require, assert }) => {
  const avvio = require('./index.js')
  const app = avvio()
  let thrown = null
  try { app.after('x') } catch (e) { thrown = e }
  assert.ok(thrown, "after('x') did not throw synchronously")
  assert.equal(thrown.code, 'AVV_ERR_CALLBACK_NOT_FN')
  assert.equal(thrown.message, "Callback for 'after' hook is not a function. Received: 'string'")
}
