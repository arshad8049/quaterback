/**
 * verify/routing.js — what happens after an attempt (QB-10). Shared by qb.js and
 * the benchmark so both route the same way.
 *
 *   done         the task passed
 *   repair       concrete repair actions exist (a failing check or criterion, a
 *                policy violation, a newly failing test with its evidence)
 *   environment  the run could not be trusted for infrastructure reasons (agent
 *                timeout/crash/auth/infra, a broken or unreadable test run): no
 *                code repair; the environment must be fixed
 *   stop         nothing concrete to repair, or no progress: the patch is
 *                identical to the previous attempt's (repeating it cannot help)
 * The caller bounds the number of attempts (--max-retries).
 */

const crypto = require('crypto');

const patchHash = (diff) => crypto.createHash('sha256').update(String(diff || '')).digest('hex');

function routeRepair(report, { patch, previousPatch } = {}) {
  if (report.verdict === 'pass') return { action: 'done', reason: 'pass' };
  if (report.verdict === 'error') return { action: 'environment', reason: `agent execution failed (${report.outcomes?.execution || 'error'})` };
  const t = report.test_outcome;
  if (t && t.outcome === 'error') return { action: 'environment', reason: `the test run is unusable (${t.reason}); fix the environment, not the code` };
  const hints = report.repair_hints || [];
  if (!hints.length) return { action: 'stop', reason: report.verdict === 'no-diff' ? 'dry run' : 'nothing concrete to repair' };
  if (previousPatch !== undefined && patch !== undefined && patchHash(patch) === patchHash(previousPatch)) {
    return { action: 'stop', reason: 'no progress: the patch is identical to the previous attempt' };
  }
  return { action: 'repair', reason: `${hints.length} repair action(s)`, hints };
}

module.exports = { routeRepair, patchHash };
