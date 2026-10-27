// LM-01 AC-5: payload: 1 and object payloads are unchanged (JSON body, application/json)
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js')
  const echo = (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { res.end(JSON.stringify({ body, headers: req.headers })) })
  }
  const send = async (opts) => JSON.parse((await inject(echo, { method: 'POST', url: '/', ...opts })).payload)
  const one = await send({ payload: 1 })
  assert.equal(one.body, '1')
  assert.match(String(one.headers['content-type']), /^application\/json/)
  const obj = await send({ payload: { a: 1, b: 'x' } })
  assert.equal(obj.body, '{"a":1,"b":"x"}')
  assert.match(String(obj.headers['content-type']), /^application\/json/)
}
