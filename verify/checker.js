/**
 * checker.js — DSA Stage 1 of Layer 4
 *
 * Deterministic evidence collection. No LLM. Runs before the judge.
 * Three passes:
 *   1. Test runner  — actually executes the test suite and captures pass/fail
 *   2. Diff scope   — flags files modified outside the relevant set
 *   3. Signal scan  — checks whether contract keywords / AC terms appear in the diff
 */

const proc = require('../lib/proc');
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

  // Pick the right command based on detected runner (argv, never a shell string)
  let cmd = null;
  if (runner === 'vitest')         cmd = ['npx', ['vitest', 'run', '--reporter=verbose']];
  else if (runner === 'jest')      cmd = ['npx', ['jest', '--no-coverage']];
  else if (runner === 'mocha')     cmd = ['npx', ['mocha']];
  else if (runner === 'node-test') cmd = ['npm', ['test']];
  else if (runner === 'go test')   cmd = ['go', ['test', './...']];
  else if (runner === 'pytest')    cmd = ['python', ['-m', 'pytest', '-v']];
  else {
    // Fallback: look for test script in package.json
    try {
      const pkg = JSON.parse(require('fs').readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test')) {
        cmd = ['npm', ['test']];
      }
    } catch (_) {}
  }

  if (!cmd) return null;

  // Exit code / signal handling is still lossy here — that is QB-06 (Phase 2).
  const r = proc.run(cmd[0], cmd[1], { cwd: repoPath, timeout: 60_000 });
  const output = `${r.stdout || ''}${r.stderr || ''}` || (r.error ? r.error.message : '');
  return parseTestOutput(output, runner);
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
  } else if (runner === 'node-test') {
    // Node built-in test runner TAP summary: "# pass N" / "# fail N"
    const passMatch = output.match(/^#\s+pass\s+(\d+)/m);
    const failMatch = output.match(/^#\s+fail\s+(\d+)/m);
    const skipMatch = output.match(/^#\s+(?:skip|todo)\s+(\d+)/m);
    if (passMatch) passed  = parseInt(passMatch[1], 10);
    if (failMatch) failed  = parseInt(failMatch[1], 10);
    if (skipMatch) skipped = parseInt(skipMatch[1], 10);
  } else {
    // Generic: parse "N passed / N failed" summary lines only (avoid false positives
    // from test description text like "should fail gracefully")
    const passLine = output.match(/(\d+)\s+pass(?:ed|ing)/i);
    const failLine = output.match(/(\d+)\s+fail(?:ed|ure)/i);
    if (passLine) passed = parseInt(passLine[1], 10);
    if (failLine) failed = parseInt(failLine[1], 10);
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
