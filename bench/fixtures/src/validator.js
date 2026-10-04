// validator.js — input validation helpers

/**
 * Returns true if value is a non-null object (not an array).
 * @param {*} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns true if value is a finite number.
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Returns true if value is a non-empty string.
 * @param {*} value
 * @returns {boolean}
 */
function isString(value) {
  return typeof value === 'string';
}

/**
 * Returns true if value is an array.
 * @param {*} value
 * @returns {boolean}
 */
function isArray(value) {
  return Array.isArray(value);
}

/**
 * Returns true if value is a boolean.
 * @param {*} value
 * @returns {boolean}
 */
function isBoolean(value) {
  return typeof value === 'boolean';
}

/**
 * Validate an object against a simple schema.
 * Schema format: { fieldName: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'required' }
 * Returns { valid: boolean, errors: string[] }
 * @param {object} data
 * @param {object} schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSchema(data, schema) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ['data must be an object'] };
  }
  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    if (rule === 'required' || (isObject(rule) && rule.required)) {
      if (value === undefined || value === null || value === '') {
        errors.push(`${field} is required`);
        continue;
      }
    }
    const type = isObject(rule) ? rule.type : rule;
    if (type && value !== undefined && value !== null) {
      const typeChecks = { string: isString, number: isNumber, boolean: isBoolean, array: isArray, object: isObject };
      if (typeChecks[type] && !typeChecks[type](value)) {
        errors.push(`${field} must be a ${type}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Returns true if str is a valid IPv4 address.
 * @param {string} str
 * @returns {boolean}
 */
function isIPv4(str) {
  if (typeof str !== 'string') return false;
  const parts = str.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = Number(p);
    return /^\d+$/.test(p) && n >= 0 && n <= 255;
  });
}

module.exports = { isObject, isNumber, isString, isArray, isBoolean, validateSchema, isIPv4 };
