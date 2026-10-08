'use strict'

module.exports = function toCamelCase (name) {
  if (name[0] === '@') {
    name = name.slice(1)
  }
  return name.split(/[-/]+/).filter(Boolean)
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('')
}
