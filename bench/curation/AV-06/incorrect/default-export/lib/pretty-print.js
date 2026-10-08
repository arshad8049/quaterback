'use strict'

/**
 * @param {TimeTreeNode} obj
 * @param {string|undefined} prefix
 * @returns {string}
 */
function prettyPrintTimeTree (obj, prefix = '') {
  let result = prefix

  const nodesCount = obj.nodes.length
  const lastIndex = nodesCount - 1
  result += `${obj.label} ${obj.diff} ms\n`

  for (let i = 0; i < nodesCount; ++i) {
    const node = obj.nodes[i]
    const prefix_ = prefix + (i === lastIndex ? '  ' : '│ ')

    result += prefix
    result += (i === lastIndex ? '└─' : '├─')
    result += (node.nodes.length === 0 ? '─ ' : '┬ ')
    result += prettyPrintTimeTree(node, prefix_).slice(prefix.length + 2)
  }
  return result
}

module.exports = prettyPrintTimeTree
