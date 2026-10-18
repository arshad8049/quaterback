'use strict'

const assert = require('node:assert')
const Request = require('./lib/request')
const Response = require('./lib/response')
const { Chain } = require('./lib/chain')

const optsValidator = require('./lib/config-validator')

function inject (dispatchFunc, options, callback) {
  if (callback === undefined) {
    return new Chain(dispatchFunc, options, doInject)
  } else {
    return doInject(dispatchFunc, options, callback)
  }
}

function supportStream1 (req, next) {
  const payload = req._lightMyRequest.payload
  if (!payload || payload._readableState || typeof payload.resume !== 'function') { // does quack like a modern stream
    return next()
  }

  // This is a non-compliant stream
  const chunks = []

  // We are accumulating because Readable.wrap() does not really work as expected
  // in this case.
  payload.on('data', (chunk) => chunks.push(Buffer.from(chunk)))

  payload.on('end', () => {
    const payload = Buffer.concat(chunks)
    req.headers['content-length'] = req.headers['content-length'] || ('' + payload.length)
    delete req.headers['transfer-encoding']
    req._lightMyRequest.payload = payload
    return next()
  })

  // Force to resume the stream. Needed for Stream 1
  payload.resume()
}

function makeRequest (dispatchFunc, server, req, res) {
  req.once('error', function (err) {
    if (this.destroyed) res.destroy(err)
  })

  req.once('close', function () {
    if (this.destroyed && !this._error) {
      res.destroy()
    }
  })

  return supportStream1(req, () => dispatchFunc.call(server, req, res))
}

function doInject (dispatchFunc, options, callback) {
  options = (typeof options === 'string' ? { url: options } : options)

  if (options.validate !== false) {
    assert(typeof dispatchFunc === 'function', 'dispatchFunc should be a function')
    const isOptionValid = optsValidator(options)
    if (!isOptionValid) {
      throw new Error(optsValidator.errors.map(e => e.message))
    }
  }

  const server = options.server || {}

  const RequestConstructor = options.Request
    ? Request.CustomRequest
    : Request

  // Express.js detection
  if (dispatchFunc.request && dispatchFunc.request.app === dispatchFunc) {
    Object.setPrototypeOf(Object.getPrototypeOf(dispatchFunc.request), RequestConstructor.prototype)
    Object.setPrototypeOf(Object.getPrototypeOf(dispatchFunc.response), Response.prototype)
  }

  if (typeof callback === 'function') {
    const req = new RequestConstructor(options)
    const res = new Response(req, callback)

    return makeRequest(dispatchFunc, server, req, res)
  } else {
    return new Promise((resolve, reject) => {
      const req = new RequestConstructor(options)
      const res = new Response(req, resolve, reject)

      makeRequest(dispatchFunc, server, req, res)
    })
  }
}

function isInjection (obj) {
  return (
    obj instanceof Request ||
    obj instanceof Response ||
    obj?.constructor?.name === '_CustomLMRRequest'
  )
}

module.exports = inject
module.exports.default = inject
module.exports.inject = inject
module.exports.isInjection = isInjection
