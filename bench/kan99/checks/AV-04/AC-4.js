// AV-04 AC-4: after(fn) still runs fn
module.exports = async ({ require, assert }) => {
  const avvio = require('./index.js')
  const app = avvio()
  let ran = false
  app.use((instance, opts, done) => done())
  app.after((err, done) => { ran = true; done(err) })
  await app.ready()
  assert.equal(ran, true, 'the after callback was not run')
}
