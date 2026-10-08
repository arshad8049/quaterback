'use strict'

const errorMessage = 'The dispatch function has already been invoked'

function Chain (dispatch, option, doInject) {
  if (typeof option === 'string') {
    this.option = { url: option }
  } else {
    this.option = Object.assign({}, option)
  }

  this.dispatch = dispatch
  this._doInject = doInject
  this._hasInvoked = false
  this._promise = null

  if (this.option.autoStart !== false) {
    process.nextTick(() => {
      if (!this._hasInvoked) {
        this.end()
      }
    })
  }
}

const httpMethods = [
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace'
]

httpMethods.forEach(method => {
  Chain.prototype[method] = function (url) {
    if (this._hasInvoked === true || this._promise) {
      throw new Error(errorMessage)
    }
    this.option.url = url
    this.option.method = method.toUpperCase()
    return this
  }
})

const chainMethods = [
  'body',
  'cookies',
  'headers',
  'payload',
  'query'
]

chainMethods.forEach(method => {
  Chain.prototype[method] = function (value) {
    if (this._hasInvoked === true || this._promise) {
      throw new Error(errorMessage)
    }
    this.option[method] = value
    return this
  }
})

Chain.prototype.end = function (callback) {
  if (this._hasInvoked === true || this._promise) {
    throw new Error(errorMessage)
  }
  this._hasInvoked = true
  if (typeof callback === 'function') {
    this._doInject(this.dispatch, this.option, callback)
  } else {
    this._promise = this._doInject(this.dispatch, this.option)
    return this._promise
  }
}

Object.getOwnPropertyNames(Promise.prototype).forEach(method => {
  if (method === 'constructor') return
  Chain.prototype[method] = function (...args) {
    if (!this._promise) {
      if (this._hasInvoked === true) {
        throw new Error(errorMessage)
      }
      this._hasInvoked = true
      this._promise = this._doInject(this.dispatch, this.option)
    }
    return this._promise[method](...args)
  }
})

module.exports = Chain
