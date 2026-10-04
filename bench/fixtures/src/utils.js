// utils.js — general-purpose utility functions

/**
 * Pause execution for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Split an array into chunks of `size`.
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunk(arr, size) {
  if (!Array.isArray(arr) || size < 1) return [];
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Return a new object containing only the specified keys.
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  return keys.reduce((acc, k) => {
    if (Object.prototype.hasOwnProperty.call(obj, k)) acc[k] = obj[k];
    return acc;
  }, {});
}

/**
 * Return a new object with the specified keys removed.
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
function omit(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  const set = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !set.has(k)));
}

/**
 * Deep equality check between two values.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Generate a unique string ID with an optional prefix.
 * @param {string} [prefix='id']
 * @returns {string}
 */
let _counter = 0;
function uniqueId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${++_counter}`;
}

/**
 * Flatten a nested array up to `depth` levels.
 * @param {Array} arr
 * @param {number} [depth=1]
 * @returns {Array}
 */
function flatten(arr, depth = 1) {
  if (!Array.isArray(arr)) return [];
  return depth > 0
    ? arr.reduce((acc, val) =>
        acc.concat(Array.isArray(val) ? flatten(val, depth - 1) : val), [])
    : arr.slice();
}

/**
 * Group an array of objects by a key.
 * @param {object[]} arr
 * @param {string} key
 * @returns {object}
 */
function groupBy(arr, key) {
  if (!Array.isArray(arr)) return {};
  return arr.reduce((acc, item) => {
    const group = item[key];
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {});
}

module.exports = { sleep, chunk, pick, omit, deepEqual, uniqueId, flatten, groupBy };
