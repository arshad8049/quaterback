// formatter.js — human-readable output formatting

/**
 * Format a duration given in milliseconds into a human-readable string.
 * e.g. 61500 → "1m 1s", 45000 → "45s", 500 → "500ms"
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Format a number with a fixed number of decimal places and optional thousands separator.
 * @param {number} n
 * @param {number} [decimals=0]
 * @param {boolean} [thousands=true]
 * @returns {string}
 */
function formatNumber(n, decimals = 0, thousands = true) {
  if (typeof n !== 'number') return '0';
  const fixed = n.toFixed(decimals);
  if (!thousands) return fixed;
  const [int, dec] = fixed.split('.');
  const formatted = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${formatted}.${dec}` : formatted;
}

/**
 * Truncate a string to `maxLength` characters, appending `suffix` if truncated.
 * @param {string} str
 * @param {number} maxLength
 * @param {string} [suffix='…']
 * @returns {string}
 */
function truncate(str, maxLength, suffix = '…') {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Pad a string on the left to reach `width` characters.
 * @param {string|number} str
 * @param {number} width
 * @param {string} [char=' ']
 * @returns {string}
 */
function padLeft(str, width, char = ' ') {
  const s = String(str);
  return s.length >= width ? s : char.repeat(width - s.length) + s;
}

/**
 * Pad a string on the right to reach `width` characters.
 * @param {string|number} str
 * @param {number} width
 * @param {string} [char=' ']
 * @returns {string}
 */
function padRight(str, width, char = ' ') {
  const s = String(str);
  return s.length >= width ? s : s + char.repeat(width - s.length);
}

/**
 * Format a date as a locale string. Accepts Date, ISO string, or timestamp.
 * @param {Date|string|number} date
 * @param {'date'|'datetime'|'time'} [style='date']
 * @returns {string}
 */
function formatDate(date, style = 'date') {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  if (style === 'time')     return d.toLocaleTimeString();
  if (style === 'datetime') return d.toLocaleString();
  return d.toLocaleDateString();
}

module.exports = { formatDuration, formatNumber, truncate, padLeft, padRight, formatDate };
