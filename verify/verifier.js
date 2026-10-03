const { randomUUID } = require('crypto');
const { runChecks }  = require('./checker');
const { judgeAll, judgeSnapshot } = require('./judge');
const { aggregate, verificationInput, FAILED_EXECUTION } = require('./verdict');
const { classifyTestRun } = require('./tests');
const { VerificationReportSchema } = require('./schema');
const { contractState, stateReason } = require('../intent/contract-state');

/**
 * Full Layer 4 verification:
 *   Stage 1 — DSA: test results from the sandbox verify stage, diff scope, AC keyword scan
 *   Stage 2 — LLM: independent per-AC judgment via Ollama
 *
 * @param {object} contract     - TaskContract from Layer 1
 * @param {object|null} context - ContextPackage from Layer 2
 * @param {object|null} execution - ExecutionResult from Layer 3 (has diff + changes)
 * @param {object} options      - { noLlm: bool, repoPath: string }
 * @returns {object}            - Validated VerificationReport
 */
async function verify(contract, context, execution, options = {}) {
  // Only a finalized contract can be verified (QB-08): no checks, no judge.
  const cs = contractState(contract);
  if (cs.state !== 'finalized') return notFinalizedReport(contract, execution, stateReason(cs));

  const diff     = execution?.diff     || null;
  const repoPath = options.repoPath
    || execution?.repo_path
    || context?.repo_path
    || null;

  // ── Stage 1: DSA checks ──────────────────────────────────────────────────
  const { testResults, scopeViolations, diffSignals } = runChecks(
    contract, context, diff, repoPath, execution
  );

  // ── Stage 2: LLM judgment ────────────────────────────────────────────────
  const criteria = contract.acceptance_criteria || [];
  let criteriaResults;

  const execStatus = execution?.status ?? null;
  const notRun     = FAILED_EXECUTION.has(execStatus);
  const material   = execStatus === 'no_change' ? snapshotMaterial(execution) : null;
  const snapshot   = material && material.ok && !options.noLlm ? material.text : null;

  if (execStatus === 'no_change' && snapshot) {
    // QB-22: the agent changed nothing. Judge the CURRENT files; the verdict also
    // needs the sandbox tests (run on the unchanged tree) to have passed.
    criteriaResults = await judgeSnapshot(criteria, snapshot);
  } else if (notRun || execStatus === 'no_change') {
    // Nothing trustworthy to judge: the agent failed, or changed nothing.
    criteriaResults = criteria.map(ac => ({
      id:        ac.id,
      criterion: ac.criterion,
      met:       null,
      method:    'not-run',
      evidence:  execStatus === 'no_change'
        ? `Agent completed without changing any file; requirement not independently verified (${material && !material.ok ? material.reason : 'not judged'}).`
        : `Agent execution ${execStatus}: ${execution?.error || 'no detail'}. Not judged.`,
    }));
  } else if (options.noLlm || !diff) {
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
  const verification = verificationInput(execution);
  const { verdict, failures } = aggregate({
    rules: 2,
    hasDiff: Boolean(diff),
    criteriaResults,
    testResults,
    executionStatus:    execStatus,
    unsupportedChanges: Boolean(execution?.unsupported_changes?.length),
    verification,
  });

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
    test_outcome:     testOutcome(execution),
    ...(material && material.ok ? { judgment_material: { source: 'sandbox_snapshot', tree: material.tree, files: material.files } } : {}),
    scope_violations: scopeViolations,
    repair_hints:     repairHints,
  };

  return VerificationReportSchema.parse(report);
}

/**
 * Judgment material for a no-change run (QB-22): the files exported by trusted
 * code from the exact tree stage ⑤ tested (execution.sandbox.snapshot). The live
 * checkout is never read. Usable only when the snapshot, the tested tree and the
 * captured candidate are the same tree, and no requested file was withheld for
 * being too large or not a regular file (fail safe: no partial judgment).
 */
function snapshotMaterial(execution) {
  const no = (reason) => ({ ok: false, reason });
  const snap = execution?.sandbox?.snapshot;
  const tested = execution?.sandbox?.verification?.tree;
  if (!snap) return no('no_snapshot');
  if (snap.error) return no(`snapshot_error: ${snap.error}`);
  if (!snap.tree || snap.tree !== tested || snap.tree !== execution?.candidate_tree) return no('snapshot_tree_mismatch');
  const withheld = (snap.skipped || []).filter(x => x.reason !== 'missing');
  if (withheld.length) return no(`snapshot_withheld: ${withheld.map(x => `${x.path} (${x.reason})`).join(', ')}`);
  if (!snap.files?.length) return no('no_files_to_judge');
  return {
    ok: true, tree: snap.tree,
    files: snap.files.map(f => ({ path: f.path, oid: f.oid })),
    text: snap.files.map(f => `### ${f.path}\n\`\`\`\n${f.text}\n\`\`\``).join('\n\n'),
  };
}

/** The classified sandbox test run (QB-06), as recorded in the report. */
function testOutcome(execution) {
  const v = execution?.sandbox?.verification || null;
  const c = classifyTestRun(v);
  return { outcome: c.outcome, reason: c.reason, runner: c.runner, exit_code: c.exit_code,
    state: v?.state ?? null, duration_ms: Number.isInteger(v?.duration_ms) ? v.duration_ms : null,
    tree: v?.tree ?? null };
}

/** The report for a contract that is not finalized: unresolved, nothing judged. */
function notFinalizedReport(contract, execution, reason) {
  return VerificationReportSchema.parse({
    id:               randomUUID(),
    contract_id:      (contract && contract.id) || 'unknown',
    execution_id:     execution?.id || null,
    generated_at:     new Date().toISOString(),
    verdict:          'unresolved',
    contract_state:   reason,
    criteria_results: [],
    failures:         [],
    test_results:     null,
    scope_violations: [],
    repair_hints:     [],
  });
}

module.exports = { verify };
