// LM-01 AC-3: body: 0 (no payload) sends '0'
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js')
  const echo = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.end(JSON.stringify({ body, headers: req.headers })) })
  }
  const send = async (opts) => JSON.parse((await inject(echo, { method: 'POST', url: '/', ...opts })).payload)
  const r = await send({ body: 0 })
  assert.equal(r.body, '0')
}
