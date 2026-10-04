const { randomUUID } = require('crypto');
const { runChecks }  = require('./checker');
const { judgeAll, judgeSnapshot } = require('./judge');
const { aggregate, verificationInput, FAILED_EXECUTION } = require('./verdict');
const { classifyTestRun } = require('./tests');
const { validateCheckResults } = require('./checks/results');
const { checkSetHash } = require('./checks/registry');
const { VerificationReportSchema } = require('./schema');
const { contractState, stateReason, contractHash, approvalState } = require('../intent/contract-state');

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

  // ── Stage 2: criteria ───────────────────────────────────────────────────
  // QB-16: a behavioural criterion (the default) is decided only by its executed
  // checks; only a criterion marked kind "non_behavioral" may be decided by the
  // independent judge. A failed execution decides nothing (both kinds: not run).
  const allCriteria = contract.acceptance_criteria || [];
  const checkEval   = evaluateChecks(contract, execution);
  const execFailed  = FAILED_EXECUTION.has(execution?.status ?? null);
  const criteria    = execFailed ? allCriteria : allCriteria.filter(ac => ac.kind === 'non_behavioral');
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

  if (!execFailed) {
    const judged = new Map(criteriaResults.map(r => [r.id, r]));
    criteriaResults = allCriteria.map(ac => judged.get(ac.id) || criterionFromChecks(ac, checkEval));
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const verification = verificationInput(execution);
  const oracle = { ...approvalState(contract), contract_hash: contractHash(contract), via: contract.approval?.via ?? null };
  const { verdict, failures } = aggregate({
    rules: 3,
    oracleApproved: oracle.approved,
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
    oracle,
    checks:           checksReport(contract, checkEval),
    verification_plan_status: planStatus(contract, checkEval),
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

/**
 * QB-16: the executed check results for this contract, validated and bound to the
 * tested tree, grouped by criterion. Unusable results decide nothing.
 * @returns {{ requested: Array, byAc: Map, results: Array, error: string|null }}
 */
function evaluateChecks(contract, execution) {
  const requested = Array.isArray(contract.checks) ? contract.checks : [];
  const out = { requested, byAc: new Map(), results: [], error: null };
  if (!requested.length) return out;
  const sb = execution?.sandbox?.checks;
  if (!sb) { out.error = 'checks_not_run'; return out; }
  if (sb.error) { out.error = sb.error; return out; }
  // The checks ran on a fresh, verified checkout of the candidate (⑥a): its tree must
  // be the captured candidate tree; the tests' tree must be the same candidate.
  const tested = execution?.sandbox?.verification?.tree;
  if (!sb.tree || !execution?.candidate_tree || sb.tree !== execution.candidate_tree || (tested && tested !== sb.tree)) {
    out.error = 'checks_tree_mismatch'; return out;
  }
  // …and to the exact check definitions of THIS contract (ids, params, expectations).
  const expected = checkSetHash(requested);
  if (sb.check_set_hash !== expected) { out.error = 'check_set_mismatch'; return out; }
  const v = validateCheckResults(sb.results_text, requested, expected);
  if (!v.ok) { out.error = v.reason; return out; }
  out.results = v.results;
  for (const r of v.results) out.byAc.set(r.ac_id, [...(out.byAc.get(r.ac_id) || []), r]);
  return out;
}

/** A behavioural criterion's result from its executed checks only. */
function criterionFromChecks(ac, ev) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'check' };
  const mine = ev.requested.filter(c => c.ac_id === ac.id);
  if (!mine.length) {
    return { ...base, met: null, method: 'no-check', check_status: 'unresolved',
      evidence: 'No executable check covers this behavioural criterion; it cannot be verified (QB-16).' };
  }
  const results = ev.byAc.get(ac.id) || [];
  if (ev.error || results.length !== mine.length) {
    return { ...base, met: null, check_status: 'error',
      evidence: `Checks could not be used: ${ev.error || 'missing results'}.`, checks: mine.map(c => ({ id: c.id, status: 'error' })) };
  }
  const checks = results.map(r => ({ id: r.id, status: r.status, detail: r.detail }));
  const failed = results.filter(r => r.status === 'fail');
  if (failed.length) {
    return { ...base, met: false, check_status: 'failed', checks, evidence: failed.map(r => `${r.id}: ${r.detail}`).join(' | '),
      repair: `Make these checks pass: ${failed.map(r => r.detail).join('; ')}` };
  }
  if (results.some(r => r.status !== 'pass')) {
    return { ...base, met: null, check_status: 'error', checks,
      evidence: results.filter(r => r.status !== 'pass').map(r => `${r.id}: ${r.detail}`).join(' | ') };
  }
  return { ...base, met: true, check_status: 'passed', checks, evidence: results.map(r => `${r.id}: ${r.detail}`).join(' | ') };
}

function checksReport(contract, ev) {
  if (!ev.requested.length && !(contract.checks_rejected || []).length) return undefined;
  return {
    registry: contract.checks_registry || null,
    requested: ev.requested.map(c => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter })),
    results: ev.results,
    rejected: (contract.checks_rejected || []).map(r => ({ id: r.check && typeof r.check.id === 'string' ? r.check.id : null, reason: r.reason })),
    error: ev.error,
  };
}

/** Each verification-plan item is complete only through executed, passing checks mapped to it. */
function planStatus(contract, ev) {
  const plan = Array.isArray(contract.verification_plan) ? contract.verification_plan : [];
  if (!plan.length) return undefined;
  return plan.map((item, i) => {
    const ids = ev.requested.filter(c => c.plan_item === i).map(c => c.id);
    const rs = ev.results.filter(r => ids.includes(r.id));
    const status = !ids.length || ev.error || rs.length !== ids.length ? 'not_executed'
      : rs.some(r => r.status === 'fail') ? 'failed' : rs.every(r => r.status === 'pass') ? 'passed' : 'error';
    return { item: String(item), checks: ids, status };
  });
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
