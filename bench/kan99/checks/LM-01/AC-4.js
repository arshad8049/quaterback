// LM-01 AC-4: payload: null sends no body
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js')
  const echo = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.end(JSON.stringify({ body, headers: req.headers })) })
  }
  const send = async (opts) => JSON.parse((await inject(echo, { method: 'POST', url: '/', ...opts })).payload)
  const r = await send({ payload: null })
  assert.equal(r.body, '')
}
