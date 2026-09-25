const { buildBriefing } = require('./briefing');
const { execute }       = require('./runner');

/**
 * Full Layer 3 orchestration:
 * 1. Build agent briefing (DSA — deterministic)
 * 2. Execute via coding agent + capture git diff
 *
 * @param {object} contract    - TaskContract from Layer 1
 * @param {object|null} context - ContextPackage from Layer 2 (optional)
 * @param {object} options     - { agent, repoPath }
 * @returns {object}           - ExecutionResult
 */
async function orchestrate(contract, context = null, options = {}) {
  const briefing = buildBriefing(contract, context, {
    repairHints: options.repairHints || [],
    attempt:     options.attempt     || 1,
  });
  return execute(briefing, contract, context, options);
}

module.exports = { orchestrate, buildBriefing };
