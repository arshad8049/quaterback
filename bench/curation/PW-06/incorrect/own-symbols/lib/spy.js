'use strict'

const kWarningFn = Symbol('process-warning.fn')
const kWarningSpyData = Symbol('process-warning.spyData')

/**
 * Spy a warning item.
 * @function
 * @memberof processWarning
 * @param {WarningItem} warning - The warning item to spy.
 * @returns {WarningSpyData} The created spy data.
 */
function spyWarning (warning) {
  // Do not double spy the same warning
  if (warning[kWarningSpyData] === null) {
    const warningFn = warning[kWarningFn]
    warning[kWarningFn] = function (a, b, c) {
      const args = []
      // since warning always call by fn(a, b, c)
      // it need to remove the trailing undefined arguments
      if (c) {
        args.push(a, b, c)
      } else if (b) {
        args.push(a, b)
      } else if (a) {
        args.push(a)
      }
      warning[kWarningSpyData].calls.push({
        arguments: args,
        result: warningFn(a, b, c)
      })
    }
    const spyData = {
      calls: [],
      callCount () {
        return spyData.calls.length
      },
      reset () {
        warning.emitted = false
        spyData.calls.length = 0
      },
      restore () {
        spyData.reset()
        warning[kWarningFn] = warningFn
        warning[kWarningSpyData] = null
      }
    }
    warning[kWarningSpyData] = spyData
  }

  return warning[kWarningSpyData]
}

module.exports = { spyWarning }
