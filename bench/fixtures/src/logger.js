// logger.js — structured console logger with levels

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/**
 * Create a structured logger.
 *
 * @param {object} [options]
 * @param {string} [options.level='info']     Minimum level to output.
 * @param {string} [options.prefix='']        Prefix prepended to every message.
 * @param {boolean} [options.timestamps=true] Include ISO timestamp in output.
 * @param {function} [options.output]         Custom output function (default: console.log).
 * @returns {Logger}
 */
function createLogger(options = {}) {
  let level    = options.level      ?? 'info';
  const prefix = options.prefix     ?? '';
  const ts     = options.timestamps ?? true;
  const out    = options.output     ?? console.log;

  function _write(lvl, msg, meta) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const parts = [];
    if (ts) parts.push(new Date().toISOString());
    parts.push(`[${lvl.toUpperCase()}]`);
    if (prefix) parts.push(`[${prefix}]`);
    parts.push(msg);
    if (meta !== undefined) parts.push(JSON.stringify(meta));
    out(parts.join(' '));
  }

  /** Log at debug level. */
  function debug(msg, meta) { _write('debug', msg, meta); }

  /** Log at info level. */
  function info(msg, meta)  { _write('info',  msg, meta); }

  /** Log at warn level. */
  function warn(msg, meta)  { _write('warn',  msg, meta); }

  /** Log at error level. */
  function error(msg, meta) { _write('error', msg, meta); }

  /**
   * Change the minimum log level at runtime.
   * @param {string} newLevel
   */
  function setLevel(newLevel) {
    if (LEVELS[newLevel] === undefined) throw new Error(`Unknown level: ${newLevel}`);
    level = newLevel;
  }

  return { debug, info, warn, error, setLevel };
}

module.exports = { createLogger, LEVELS };
