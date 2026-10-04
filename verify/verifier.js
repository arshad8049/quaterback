const { randomUUID } = require('crypto');
const { runChecks }  = require('./checker');
const { judgeAll, judgeSnapshot } = require('./judge');
const { aggregate, verificationInput, FAILED_EXECUTION } = require('./verdict');
const { classifyTestRun } = require('./tests');
const { validateCheckResults } = require('./checks/results');
const { checkSetHash } = require('./checks/registry');
const { evaluatePolicy } = require('./policy');
const { buildEvidence, candidateFiles, manifestEntry } = require('./evidence');
const { decidePreservation } = require('./preservation');
const { openCache } = require('./judge-cache');
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
  const { testResults, diffSignals } = runChecks(
    contract, context, diff, repoPath, execution
  );

  // ── Stage 2: criteria ───────────────────────────────────────────────────
  // QB-16: a behavioural criterion (the default) is decided only by its executed
  // checks; only a criterion marked kind "non_behavioral" may be decided by the
  // independent judge. A failed execution decides nothing (both kinds: not run).
  const allCriteria = contract.acceptance_criteria || [];
  const checkEval   = evaluateChecks(contract, execution);
  const execFailed  = FAILED_EXECUTION.has(execution?.status ?? null);
  // QB-15: a preservation criterion is decided by the named tests it preserves, never by the judge.
  const criteria    = execFailed ? allCriteria : allCriteria.filter(ac => ac.kind === 'non_behavioral' && !ac.preserves);
  const judgeCache  = options.judgeCache ? openCache(options.judgeCache) : null;
  let criteriaResults;

  const execStatus = execution?.status ?? null;
  const notRun     = FAILED_EXECUTION.has(execStatus);
  const material   = execStatus === 'no_change' ? snapshotMaterial(execution) : null;
  const snapshot   = material && material.ok && !options.noLlm ? material.text : null;

  // QB-11: per criterion, the evidence the judge sees — with IDs and provenance.
  const bundles = new Map();
  const evidenceFor = (wholeFiles) => {
    const cand = candidateFiles(execution);
    for (const ac of criteria) {
      bundles.set(ac.id, buildEvidence({ criterion: ac.criterion, diff: wholeFiles ? null : diff, wholeFiles,
        files: cand.files, tree: cand.tree, unavailable: cand.unavailable, missing: cand.missing, sourceUnavailable: cand.sourceUnavailable,
        checks: (checkEval.byAc.get(ac.id) || []).map(r => ({ id: r.id, status: r.status, detail: r.detail })) }));
    }
  };

  if (execStatus === 'no_change' && snapshot) {
    // QB-22: the agent changed nothing. Judge the CURRENT files; the verdict also
    // needs the sandbox tests (run on the unchanged tree) to have passed.
    evidenceFor(true);
    criteriaResults = await judgeSnapshot(criteria, bundles, { cache: judgeCache });
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
    evidenceFor(false);
    criteriaResults = await judgeAll(criteria, diff, diffSignals, bundles, { cache: judgeCache });
  }
  const evidenceManifest = [...new Map([...bundles.values()].flatMap(b => b.shown).map(it => [it.id, manifestEntry(it)])).values()];

  if (!execFailed) {
    const judged = new Map(criteriaResults.map(r => [r.id, r]));
    const classified = classifyTestRun(execution?.sandbox?.verification || null, testOptions(contract));
    criteriaResults = allCriteria.map(ac => judged.get(ac.id)
      || (ac.preserves ? preservationResult(ac, classified, checkEval) : criterionFromChecks(ac, checkEval)));
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const testOpts = testOptions(contract);
  const verification = verificationInput(execution, testOpts);
  const oracle = { ...approvalState(contract), contract_hash: contractHash(contract), via: contract.approval?.via ?? null };
  const policy = evaluatePolicy(contract, execution, checkEval.results);       // QB-09
  const { verdict, failures } = aggregate({
    rules: 6,
    oracleApproved: oracle.approved,
    policyEffect: policy.effect,
    hasDiff: Boolean(diff),
    criteriaResults: criteriaResults.map(r => (r.evidence_missing?.length ? { ...r, missing_evidence: true } : r)),
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
    test_outcome:     testOutcome(execution, testOpts),
    outcomes:         outcomesOf(execution, policy, testOutcome(execution, testOpts), criteriaResults, execFailed),
    oracle,
    checks:           checksReport(contract, checkEval),
    verification_plan_status: planStatus(contract, checkEval),
    ...(material && material.ok ? { judgment_material: { source: 'sandbox_snapshot', tree: material.tree, files: material.files } } : {}),
    ...(evidenceManifest.length ? { evidence: evidenceManifest } : {}),   // QB-11
    scope_violations: [...policy.protected_touched, ...policy.out_of_scope],
    policy,
    repair_hints:     [...repairHints, ...policyRepairs(policy), ...testRepairs(execution, testOpts)],
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

/** QB-15: the named tests decide; checks bound to the criterion (interfaces) must also pass. */
function preservationResult(ac, classified, ev) {
  const t = decidePreservation(ac, classified);
  if (!ev.requested.some(c => c.ac_id === ac.id)) return t;
  const k = criterionFromChecks(ac, ev);
  const met = t.met === false || k.met === false ? false : t.met === true && k.met === true ? true : null;
  return { ...t, met, checks: k.checks, check_status: k.check_status, evidence: `${t.evidence} | checks: ${k.evidence}`,
    repair: met === false ? [t.repair, k.repair].filter(Boolean).join(' ') : null };
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

/** QB-10: how the approved contract treats failures that provably pre-exist (default: they block). */
const testOptions = (contract) => ({ preexisting: contract?.test_policy?.preexisting_failures === 'waive' ? 'waive' : 'block' });
const SHOWN_TESTS = 50;   // display bound only — the decision compares every failure (verify/tests.js)

/** QB-10: one concrete repair action per newly failing test, with its evidence. */
function testRepairs(execution, testOpts) {
  const c = classifyTestRun(execution?.sandbox?.verification || null, testOpts);
  if (c.outcome !== 'failed' || !c.regressions) return [];
  return c.regressions.slice(0, 10).map(t => ({
    criterion_id: `TEST:${t.file}:${t.name}`.slice(0, 200),
    diagnosis: `Test "${t.name}" (${t.file}) fails after this change${t.error ? `: ${t.error}` : ''}`.slice(0, 700),
    suggested_fix: `Make "${t.name}" in ${t.file} pass again without editing the test.`,
  }));
}

/** The four outcomes, reported independently (QB-10). */
function outcomesOf(execution, policy, testOutcome, criteriaResults, execFailed) {
  return {
    execution: execFailed ? 'failed' : (execution?.status || 'unknown'),
    policy: policy.effect,
    tests: testOutcome.outcome,
    criteria: !criteriaResults.length ? 'none' : criteriaResults.some(r => r.met === false) ? 'failed'
      : criteriaResults.every(r => r.met === true) ? 'met' : 'unknown',
  };
}

/** QB-09: what the agent must undo for a policy failure (a protected or unauthorized change, a violated constraint). */
function policyRepairs(policy) {
  const hints = [];
  for (const f of policy.protected_touched) hints.push({ criterion_id: 'POLICY', diagnosis: `${f} is a protected path`, suggested_fix: `Revert all changes to ${f}; it must not be modified.` });
  for (const f of policy.out_of_scope) hints.push({ criterion_id: 'POLICY', diagnosis: `${f} is outside the approved scope`, suggested_fix: `Revert ${f}, or ask the human to widen scope.allowed_changes.` });
  for (const c of policy.constraints.filter(x => x.status === 'violated')) hints.push({ criterion_id: `CONSTRAINT-${c.index}`, diagnosis: `Constraint violated: ${c.text}`, suggested_fix: `Restore compliance with: ${c.text}` });
  return hints;
}

/** The classified sandbox test run (QB-06), as recorded in the report. */
function testOutcome(execution, testOpts = {}) {
  const v = execution?.sandbox?.verification || null;
  const c = classifyTestRun(v, testOpts);
  return { outcome: c.outcome, reason: c.reason, runner: c.runner, exit_code: c.exit_code,
    state: v?.state ?? null, duration_ms: Number.isInteger(v?.duration_ms) ? v.duration_ms : null,
    tree: v?.tree ?? null,
    // QB-10: which failures are new, which already happened on the base tree.
    ...(c.failures ? { regressions: c.regressions.slice(0, SHOWN_TESTS), regressions_total: c.regressions.length,
      preexisting: c.preexisting.slice(0, SHOWN_TESTS), preexisting_total: c.preexisting.length, baseline: c.baseline,
      preexisting_policy: testOpts.preexisting === 'waive' ? 'waive' : 'block' } : {}) };
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
