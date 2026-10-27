// LM-01 AC-1: payload: 0 sends body '0' with content-type application/json and content-length 1
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js')
  const echo = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.end(JSON.stringify({ body, headers: req.headers })) })
  }
  const send = async (opts) => JSON.parse((await inject(echo, { method: 'POST', url: '/', ...opts })).payload)
  const r = await send({ payload: 0 })
  assert.equal(r.body, '0')
  assert.match(String(r.headers['content-type']), /^application\/json/)
  assert.equal(r.headers['content-length'], '1')
}
