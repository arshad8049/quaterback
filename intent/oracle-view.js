/**
 * intent/oracle-view.js — what a human sees before approving a test oracle (QB-13).
 *
 * Shows exactly the content the approval hash covers (contract-state.approvedContent):
 * goal, required behaviour, constraints, acceptance criteria (with kind), the
 * verification plan and every check — plus QB's own arithmetic results and the
 * registry's rejections. Nothing covered by the approval is hidden.
 */

const { approvedContent, contractHash } = require('./contract-state');
const { validateExamples } = require('./examples');
const { validateTraceability, validateDefaults } = require('./requirements');

function formatOracle(contract) {
  const c = approvedContent(contract);
  const L = ['', '  ── Test oracle — review everything below before approving ──'];
  L.push(`  Goal: ${c.goal}`);
  const list = (title, items) => { L.push(`  ${title}:`); if (!items.length) L.push('     (none)'); else items.forEach((x) => L.push(`     - ${x}`)); };
  list('Required behaviour', c.required_behavior.map(String));
  list('Constraints', c.constraints.map(String));
  list('Requirements from your request (QB-14)', validateTraceability(contract).trace.map((t) =>
    `${t.id} ${t.implied ? '(implied) ' : ''}${JSON.stringify(t.quote ?? (c.requirements.find((r) => r.id === t.id) || {}).text)} → ${t.disposition === 'covered' ? t.covered_by.join(', ') : t.disposition.toUpperCase()}`
      + (t.disposition === 'context' || t.implied ? `  (reason: ${t.reason})` : '')));
  // QB-17: explicit (quoted) and implied requirements above; QB's own choices here, separately.
  const defaults = validateDefaults(contract).defaults;
  if (defaults.length) list('Proposed defaults (not in your request — QB\'s choice; approving the contract approves them)',
    defaults.map((d) => `${d.id} ${d.text} → ${d.covered_by.join(', ') || 'UNCOVERED'}  (reason: ${d.reason})`));
  list('Acceptance criteria', c.acceptance_criteria.map((a) => `[${a.id}] (${a.kind}) ${a.criterion}${a.requirement_ids.length ? `  ← ${a.requirement_ids.join(', ')}` : ''}${a.preserves ? `  [preserved = these tests pass: ${a.preserves.tests.join(', ')}]` : ''}`));
  list('Verification plan', c.verification_plan.map((p, i) => `${i}. ${p}`));
  list('May change (scope.allowed_changes; anything else is unauthorized)', c.scope.allowed_changes);
  list('Must not change (scope.protected_paths)', c.scope.protected_paths);
  list('Constraint enforcement', c.constraints.map((t, i) => {
    const e = c.constraint_policy.find((p) => p && p.constraint === i);
    return `${i}. ${t} → ${!e ? 'UNENFORCED (will be unresolved)' : e.advisory ? 'advisory (not machine-checked)' : e.enforced_by.map((b) => `${b.kind}${b.ref ? ` ${b.ref}` : ''}`).join(', ')}`;
  }));
  L.push(`  Pre-existing test failures: ${c.test_policy?.preexisting_failures === 'waive'
    ? 'WAIVED — failures that provably also fail the same way on the base tree will not block PASS'
    : 'block PASS (default; set test_policy.preexisting_failures = "waive" to allow)'}`);
  list('Executable checks', c.checks.map((k) => `${k.id} → ${k.ac_id}${k.plan_item !== undefined ? ` (plan ${k.plan_item})` : ''}: ${k.adapter} ${JSON.stringify(k.params)}`));
  const rejected = contract?.checks_rejected || [];
  if (rejected.length) list('Rejected by the registry (will not run)', rejected.map((r) => `${r.check && r.check.id ? r.check.id : '?'}: ${r.reason}`));
  const ex = validateExamples(contract);
  L.push(`  QB's own arithmetic: ${ex.checked.length} example(s) recomputed and correct${ex.errors.length ? `, ${ex.errors.length} WRONG` : ''}`);
  L.push(`  Approval will freeze this exact content: ${contractHash(contract).slice(0, 16)}`, '');
  return L.join('\n');
}

module.exports = { formatOracle };
