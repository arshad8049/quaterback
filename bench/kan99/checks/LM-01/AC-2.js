// LM-01 AC-2: payload: false sends body 'false' with content-type application/json
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js')
  const echo = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.end(JSON.stringify({ body, headers: req.headers })) })
  }
  const send = async (opts) => JSON.parse((await inject(echo, { method: 'POST', url: '/', ...opts })).payload)
  const r = await send({ payload: false })
  assert.equal(r.body, 'false')
  assert.match(String(r.headers['content-type']), /^application\/json/)
}
