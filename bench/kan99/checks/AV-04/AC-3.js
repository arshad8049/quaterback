// AV-04 AC-3: after() with no argument still returns a promise that resolves
module.exports = async ({ require, assert }) => {
  const avvio = require('./index.js')
  const app = avvio()
  app.use((instance, opts, done) => done())
  const p = app.after()
  assert.ok(p && typeof p.then === 'function', 'after() did not return a promise')
  await p
}
