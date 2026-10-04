/**
 * checker.js — DSA Stage 1 of Layer 4
 *
 * Deterministic evidence collection. No LLM. Runs before the judge.
 * Three passes:
 *   1. Test results — taken from the sandbox verification stage (never run on the host)
 *   2. (scope is enforced policy: verify/policy.js, QB-09)
 *   3. Signal scan  — checks whether contract keywords / AC terms appear in the diff
 */

const { classifyTestRun } = require('./tests');

/**
 * Run all deterministic checks. Nothing here executes repository code: test
 * results come from the sandbox's verification stage (QB-02, agent-sandbox.md
 * §3.5), which ran the base test command on a disposable copy of the candidate.
 *
 * @param {object} contract  - TaskContract
 * @param {object|null} context  - ContextPackage (for test files + relevant files)
 * @param {string|null} diff     - Raw git diff string from ExecutionResult
 * @param {string} _repoPath     - unused (kept for call compatibility)
 * @param {object|null} execution - ExecutionResult (sandbox.verification carries the test output)
 * @returns {{ testResults, diffSignals }}
 */
function runChecks(contract, context, diff, _repoPath, execution = null) {
  const testResults     = testsFromSandbox(execution);
  const diffSignals     = scanDiff(diff, contract);

  return { testResults, diffSignals };
}

// ─── 1. Test results (from the sandbox) ───────────────────────────────────────

function testsFromSandbox(execution) {
  const v = execution?.sandbox?.verification;
  if (!v || v.status !== 'ran' || typeof v.output !== 'string') return null;
  // Counts come from the classified run (verify/tests.js, QB-06); the verdict uses
  // its outcome, so an unparsed or broken run is never read as "0 failed".
  const c = classifyTestRun(v);
  const n = c.counts || { passed: 0, failed: 0, skipped: 0 };
  return { passed: n.passed, failed: c.outcome === 'failed' ? Math.max(1, n.failed) : n.failed, skipped: n.skipped,
    output: v.output.slice(0, 2000) };
}

// (QB-09: scope is enforced policy in verify/policy.js, from the approved contract —
//  retrieval relevance is never an allowlist.)

// ─── 3. Diff signal scan ──────────────────────────────────────────────────────

/**
 * Check whether keywords from ACs and required_behavior appear in the diff.
 * Returns a map of {keyword → found} for use by the LLM judge as context.
 *
 * Also injects deterministic high-confidence signals for common patterns:
 *   __fn_<name>_defined   — function appears on an added (+) line
 *   __fn_<name>_exported  — function name appears in an export on an added (+) line
 *   __fn_<name>_returns   — function body contains a return statement on added lines
 */
function scanDiff(diff, contract) {
  if (!diff) return {};

  const signals = {};
  const diffLower = diff.toLowerCase();

  // ── Keyword signals ───────────────────────────────────────────────────────
  const terms = [
    ...(contract.acceptance_criteria || []).map(ac => ac.criterion),
    ...(contract.required_behavior   || []),
  ].join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .filter(w => !STOP_WORDS.has(w));

  const unique = [...new Set(terms)];
  for (const term of unique) {
    signals[term] = diffLower.includes(term);
  }

  // ── Deterministic function signals ────────────────────────────────────────
  // Extract function/method names from goal + criteria (camelCase / snake_case identifiers)
  const allText = [
    contract.goal || '',
    ...(contract.acceptance_criteria || []).map(ac => ac.criterion),
    ...(contract.required_behavior   || []),
  ].join(' ');

  const fnNames = [...new Set(
    (allText.match(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:[A-Z][a-zA-Z0-9_]*)+)\b/g) || []) // camelCase
      .concat(allText.match(/\b([a-z][a-z0-9_]*_[a-z][a-z0-9_]*)\b/g) || [])       // snake_case
      .concat(allText.match(/\b([a-zA-Z_]\w+\(\))/g)?.map(s => s.replace('()', '')) || []) // explicit fn()
  )].filter(n => n.length > 3);

  // Only examine lines that were added in the diff
  const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const addedText  = addedLines.join('\n');

  for (const name of fnNames) {
    const nameLower  = name.toLowerCase();
    const nameRegex  = new RegExp(`\\b${name}\\b`);
    const inAdded    = nameRegex.test(addedText);

    if (!inAdded) continue; // name not in any added line — skip

    signals[`__fn_${nameLower}_defined`]  = /function\s/.test(addedText) && inAdded
      || /=>\s*\{/.test(addedText) && inAdded
      || new RegExp(`${name}\\s*[=(]`).test(addedText);

    signals[`__fn_${nameLower}_exported`] =
      new RegExp(`(module\\.exports|exports\\.[a-zA-Z]|export\\s+(default\\s+)?function|export\\s+const)[^\\n]*${name}`).test(addedText) ||
      new RegExp(`${name}[^\\n]*(module\\.exports|exports)`).test(addedText);

    signals[`__fn_${nameLower}_returns`]  = /\breturn\b/.test(addedText);
  }

  return signals;
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'into', 'make', 'sure', 'also',
  'when', 'them', 'then', 'than', 'been', 'were', 'will', 'would', 'could',
  'should', 'like', 'some', 'just', 'more', 'what', 'which', 'their',
  'there', 'about', 'your', 'work', 'must', 'does', 'ensure', 'existing',
  'users', 'user', 'code', 'file', 'without', 'properly', 'correctly',
]);

module.exports = { runChecks };
