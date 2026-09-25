/**
 * checker.js — DSA Stage 1 of Layer 4
 *
 * Deterministic evidence collection. No LLM. Runs before the judge.
 * Three passes:
 *   1. Test runner  — actually executes the test suite and captures pass/fail
 *   2. Diff scope   — flags files modified outside the relevant set
 *   3. Signal scan  — checks whether contract keywords / AC terms appear in the diff
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * Run all deterministic checks.
 *
 * @param {object} contract  - TaskContract
 * @param {object|null} context  - ContextPackage (for test files + relevant files)
 * @param {string|null} diff     - Raw git diff string from ExecutionResult
 * @param {string} repoPath      - Absolute path to repo
 * @returns {{ testResults, scopeViolations, diffSignals }}
 */
function runChecks(contract, context, diff, repoPath) {
  const testResults     = runTests(context, repoPath);
  const scopeViolations = checkScope(diff, context);
  const diffSignals     = scanDiff(diff, contract);

  return { testResults, scopeViolations, diffSignals };
}

// ─── 1. Test runner ───────────────────────────────────────────────────────────

function runTests(context, repoPath) {
  if (!repoPath || !context) return null;

  const runner = context.patterns?.test_runner;

  // Pick the right command based on detected runner
  let cmd = null;
  if (runner === 'vitest') cmd = 'npx vitest run --reporter=verbose 2>&1';
  else if (runner === 'jest') cmd = 'npx jest --no-coverage 2>&1';
  else if (runner === 'mocha') cmd = 'npx mocha 2>&1';
  else if (runner === 'go test') cmd = 'go test ./... 2>&1';
  else if (runner === 'pytest') cmd = 'python -m pytest -v 2>&1';
  else {
    // Fallback: look for test script in package.json
    try {
      const pkg = JSON.parse(require('fs').readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test')) {
        cmd = 'npm test 2>&1';
      }
    } catch (_) {}
  }

  if (!cmd) return null;

  try {
    const output = execSync(cmd, { cwd: repoPath, encoding: 'utf8', timeout: 60_000 });
    return parseTestOutput(output, runner);
  } catch (e) {
    // Test runner exits non-zero when tests fail — that's meaningful
    const output = e.stdout || e.message || '';
    return parseTestOutput(output, runner);
  }
}

function parseTestOutput(output, runner) {
  let passed = 0, failed = 0, skipped = 0;

  if (runner === 'jest' || runner === 'vitest') {
    const passMatch  = output.match(/(\d+)\s+passed/);
    const failMatch  = output.match(/(\d+)\s+failed/);
    const skipMatch  = output.match(/(\d+)\s+skipped/);
    if (passMatch) passed  = parseInt(passMatch[1],  10);
    if (failMatch) failed  = parseInt(failMatch[1],  10);
    if (skipMatch) skipped = parseInt(skipMatch[1], 10);
  } else if (runner === 'mocha') {
    const passMatch = output.match(/(\d+)\s+passing/);
    const failMatch = output.match(/(\d+)\s+failing/);
    if (passMatch) passed = parseInt(passMatch[1], 10);
    if (failMatch) failed = parseInt(failMatch[1], 10);
  } else {
    // Generic: count PASS/FAIL lines
    passed = (output.match(/\bpass(ed|ing)?\b/gi) || []).length;
    failed = (output.match(/\bfail(ed|ure)?\b/gi) || []).length;
  }

  return { passed, failed, skipped, output: output.slice(0, 2000) };
}

// ─── 2. Diff scope check ─────────────────────────────────────────────────────

function checkScope(diff, context) {
  if (!diff || !context?.relevant_files) return [];

  const relevantPaths = new Set(context.relevant_files.map(f => f.path));
  const violations = [];

  const fileMatches = diff.match(/^diff --git a\/.+ b\/(.+)$/gm) || [];
  for (const line of fileMatches) {
    const match = line.match(/b\/(.+)$/);
    if (match) {
      const file = match[1];
      if (!relevantPaths.has(file)) {
        violations.push(file);
      }
    }
  }

  return violations;
}

// ─── 3. Diff signal scan ──────────────────────────────────────────────────────

/**
 * Check whether keywords from ACs and required_behavior appear in the diff.
 * Returns a map of {keyword → found} for use by the LLM judge as context.
 */
function scanDiff(diff, contract) {
  if (!diff) return {};

  const signals = {};
  const diffLower = diff.toLowerCase();

  // Extract meaningful keywords from ACs and required behavior
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
