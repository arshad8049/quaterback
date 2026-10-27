// AV-04 AC-2: after(42) reports 'number'
module.exports = async ({ require, assert }) => {
  const avvio = require('./index.js')
  const app = avvio()
  let thrown = null
  try { app.after(42) } catch (e) { thrown = e }
  assert.ok(thrown, 'after(42) did not throw synchronously')
  assert.equal(thrown.code, 'AVV_ERR_CALLBACK_NOT_FN')
  assert.equal(thrown.message, "Callback for 'after' hook is not a function. Received: 'number'")
}
