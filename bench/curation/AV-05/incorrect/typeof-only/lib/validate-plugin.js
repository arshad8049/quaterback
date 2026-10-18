'use strict'

const { AVV_ERR_PLUGIN_NOT_VALID } = require('./errors')

/**
 * @param {any} maybePlugin
 * @throws {AVV_ERR_PLUGIN_NOT_VALID}
 *
 * @returns {asserts plugin is Function|PromiseLike}
 */
function validatePlugin (maybePlugin) {
  // validate if plugin is a function or Promise
  if (!(maybePlugin && (typeof maybePlugin === 'function' || typeof maybePlugin.then === 'function'))) {
    throw new AVV_ERR_PLUGIN_NOT_VALID(typeof maybePlugin)
  }
}

module.exports = {
  validatePlugin
}
