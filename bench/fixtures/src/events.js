// events.js — lightweight event emitter

/**
 * Create a simple event emitter.
 * @returns {Emitter}
 */
function createEmitter() {
  const listeners = new Map(); // event → Set of listeners

  function _getSet(event) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    return listeners.get(event);
  }

  /**
   * Register a listener for `event`.
   * @param {string} event
   * @param {function} listener
   */
  function on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    _getSet(event).add(listener);
  }

  /**
   * Remove a specific listener for `event`.
   * @param {string} event
   * @param {function} listener
   * @returns {boolean} true if the listener was found and removed
   */
  function off(event, listener) {
    const set = listeners.get(event);
    if (!set) return false;
    return set.delete(listener);
  }

  /**
   * Emit `event`, calling all registered listeners with `args`.
   * @param {string} event
   * @param {...*} args
   * @returns {boolean} true if any listeners were called
   */
  function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of set) fn(...args);
    return true;
  }

  /**
   * Returns the number of listeners registered for `event`.
   * @param {string} event
   * @returns {number}
   */
  function listenerCount(event) {
    return listeners.get(event)?.size ?? 0;
  }

  return { on, off, emit, listenerCount };
}

module.exports = { createEmitter };
