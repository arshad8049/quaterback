// cache.js — in-memory TTL cache

/**
 * Create an in-memory cache with optional TTL (time-to-live) support.
 *
 * @param {object} [options]
 * @param {number} [options.defaultTTL]  Default TTL in ms. 0 = no expiry.
 * @param {number} [options.maxSize]     Max number of entries before oldest is evicted.
 * @returns {Cache}
 */
function createCache(options = {}) {
  const { defaultTTL = 0, maxSize = 0 } = options;
  const store = new Map(); // key → { value, expiresAt }

  function isExpired(entry) {
    return entry.expiresAt !== 0 && Date.now() > entry.expiresAt;
  }

  /**
   * Store a value. `ttl` overrides defaultTTL for this entry (ms, 0 = no expiry).
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl]
   */
  function set(key, value, ttl) {
    const t = ttl !== undefined ? ttl : defaultTTL;
    const expiresAt = t > 0 ? Date.now() + t : 0;
    if (maxSize > 0 && !store.has(key) && store.size >= maxSize) {
      // Evict the oldest key
      store.delete(store.keys().next().value);
    }
    store.set(key, { value, expiresAt });
  }

  /**
   * Retrieve a value. Returns `undefined` if missing or expired.
   * @param {string} key
   * @returns {*}
   */
  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry)) { store.delete(key); return undefined; }
    return entry.value;
  }

  /**
   * Returns true if the key exists and has not expired.
   * @param {string} key
   * @returns {boolean}
   */
  function has(key) {
    return get(key) !== undefined;
  }

  /**
   * Remove a key from the cache.
   * @param {string} key
   * @returns {boolean} true if the key existed
   */
  function del(key) {
    return store.delete(key);
  }

  /**
   * Remove all entries.
   */
  function clear() {
    store.clear();
  }

  /**
   * Returns the number of non-expired entries currently in the cache.
   * @returns {number}
   */
  function size() {
    let count = 0;
    for (const [key, entry] of store) {
      if (!isExpired(entry)) count++;
      else store.delete(key);
    }
    return count;
  }

  return { set, get, has, delete: del, clear, size };
}

module.exports = { createCache };
