// parser.js — structured text parsing utilities

/**
 * Safely parse a JSON string, returning `fallback` on any error.
 * @param {string} str
 * @param {*} [fallback=null]
 * @returns {*}
 */
function parseJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

/**
 * Parse a URL query string (with or without leading `?`) into a key-value object.
 * Handles repeated keys as arrays.
 * @param {string} str
 * @returns {object}
 */
function parseQueryString(str) {
  if (typeof str !== 'string') return {};
  const s = str.startsWith('?') ? str.slice(1) : str;
  if (!s) return {};
  const result = {};
  for (const part of s.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key   = decodeURIComponent(eq === -1 ? part        : part.slice(0, eq));
    const value = decodeURIComponent(eq === -1 ? ''          : part.slice(eq + 1));
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = [].concat(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse a `Cookie` header string into a key-value object.
 * @param {string} cookieStr
 * @returns {object}
 */
function parseCookies(cookieStr) {
  if (typeof cookieStr !== 'string') return {};
  return cookieStr.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key   = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

/**
 * Parse a single CSV line respecting double-quoted fields (RFC 4180 subset).
 * @param {string} line
 * @param {string} [delimiter=',']
 * @returns {string[]}
 */
function parseCSVLine(line, delimiter = ',') {
  if (typeof line !== 'string') return [];
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === delimiter) { fields.push(field); field = ''; }
      else field += ch;
    }
  }
  fields.push(field);
  return fields;
}

module.exports = { parseJSON, parseQueryString, parseCookies, parseCSVLine };
