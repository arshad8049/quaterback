const { randomUUID } = require('crypto');
const { runChecks }  = require('./checker');
const { judgeAll }   = require('./judge');
const { VerificationReportSchema } = require('./schema');

/**
 * Full Layer 4 verification:
 *   Stage 1 — DSA: run tests, check diff scope, scan for AC keywords
 *   Stage 2 — LLM: independent per-AC judgment via Ollama
 *
 * @param {object} contract     - TaskContract from Layer 1
 * @param {object|null} context - ContextPackage from Layer 2
 * @param {object|null} execution - ExecutionResult from Layer 3 (has diff + changes)
 * @param {object} options      - { noLlm: bool, repoPath: string }
 * @returns {object}            - Validated VerificationReport
 */
async function verify(contract, context, execution, options = {}) {
  const diff     = execution?.diff     || null;
  const repoPath = options.repoPath
    || execution?.repo_path
    || context?.repo_path
    || null;

  // ── Stage 1: DSA checks ──────────────────────────────────────────────────
  const { testResults, scopeViolations, diffSignals } = runChecks(
    contract, context, diff, repoPath
  );

  // ── Stage 2: LLM judgment ────────────────────────────────────────────────
  const criteria = contract.acceptance_criteria || [];
  let criteriaResults;

  if (options.noLlm || !diff) {
    criteriaResults = criteria.map(ac => ({
      id:        ac.id,
      criterion: ac.criterion,
      met:       null,
      method:    diff ? 'no-diff' : 'no-diff',
      evidence:  diff
        ? 'LLM judgment skipped (--no-llm). Diff exists but not evaluated.'
        : 'No diff available — agent ran in dry-run mode.',
    }));
  } else {
    criteriaResults = await judgeAll(criteria, diff, diffSignals);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const failures = criteriaResults
    .filter(r => r.met === false)
    .map(r => r.id);

  const unknowns = criteriaResults.filter(r => r.met === null);

  let verdict;
  if (!diff)                       verdict = 'no-diff';
  else if (failures.length > 0)    verdict = 'fail';
  else if (unknowns.length > 0)    verdict = 'partial';
  else                             verdict = 'pass';

  // If tests failed, force verdict to fail
  if (testResults && testResults.failed > 0 && verdict === 'pass') {
    verdict = 'fail';
  }

  // ── Repair hints (for failed ACs) ────────────────────────────────────────
  const repairHints = criteriaResults
    .filter(r => r.met === false)
    .map(r => ({
      criterion_id:  r.id,
      diagnosis:     r.evidence,
      suggested_fix: r.repair || `Implement the missing behavior: "${r.criterion}"`,
    }));

  // ── Assemble report ──────────────────────────────────────────────────────
  const report = {
    id:               randomUUID(),
    contract_id:      contract.id || 'unknown',
    execution_id:     execution?.id || null,
    generated_at:     new Date().toISOString(),
    verdict,
    criteria_results: criteriaResults,
    failures,
    test_results:     testResults || null,
    scope_violations: scopeViolations,
    repair_hints:     repairHints,
  };

  return VerificationReportSchema.parse(report);
}

module.exports = { verify };
