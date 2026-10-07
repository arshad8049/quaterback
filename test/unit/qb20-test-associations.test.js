/**
 * QB-20: a test file that exists is a test ASSOCIATION, not coverage.
 * - conventional test names in the supported language families are discovered
 *   (test_auth.py, auth_test.py, auth_test.go, *.test.js / *.spec.js / __tests__ / test/ mirrors,
 *   FooTest.java);
 * - the field is `test_associations`; real coverage data is reported (separately) only
 *   when the repository has it (istanbul coverage-final.json / lcov.info);
 * - the briefing never says code is covered because a test file exists;
 * - verification runs only validated runners (node:test), from an explicit project
 *   config or the package.json test script; every other runner is rejected with a
 *   reason and can never PASS.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildContext } = require('../../context/builder');
const { buildBriefing } = require('../../agent/briefing');
const { testPlan, CONFIG_FILE } = require('../../context/test-plan');
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');

const repos = [];
const repo = (files) => { const r = makeRepo(files); repos.push(r); return r; };
after(() => { for (const r of repos) r.cleanup(); });
const contract = (goal, extra = {}) => ({ id: 'c', goal, required_behavior: [goal], acceptance_criteria: [{ id: 'AC-1', criterion: goal }], verification_plan: ['run tests'], ...extra });
const ctxFor = async (files, goal) => { const r = repo(files); return { r, ctx: await buildContext(contract(goal), r.dir, { noLlm: true }) }; };
const assoc = (ctx, src) => (ctx.relevant_files.find((f) => f.path === src) || {}).test_file;

describe('conventional test names are discovered as associations', () => {
  test('Python: tests/test_auth.py and auth_test.py (pre-fix: not discovered)', async () => {
    const { ctx } = await ctxFor({ 'src/auth.py': 'def login():\n    return True\n', 'tests/test_auth.py': 'def test_login():\n    pass\n' }, 'Fix login in auth');
    assert.equal(assoc(ctx, 'src/auth.py'), 'tests/test_auth.py');
    assert.ok(ctx.test_associations.test_files.includes('tests/test_auth.py'));
    const b = await ctxFor({ 'app/auth.py': 'def login():\n    return True\n', 'app/auth_test.py': 'def test_login():\n    pass\n' }, 'Fix login in auth');
    assert.equal(assoc(b.ctx, 'app/auth.py'), 'app/auth_test.py');
  });
  test('Go: auth_test.go in the same package directory (pre-fix: not discovered)', async () => {
    const { ctx } = await ctxFor({ 'auth/auth.go': 'package auth\nfunc Login() bool { return true }\n', 'auth/auth_test.go': 'package auth\nimport "testing"\nfunc TestLogin(t *testing.T) {}\n' }, 'Fix Login in auth');
    assert.equal(assoc(ctx, 'auth/auth.go'), 'auth/auth_test.go');
  });
  test('JavaScript: test/ and tests/ mirrors, __tests__, .spec', async () => {
    const { ctx } = await ctxFor({ 'src/utils/clamp.js': 'module.exports.clamp = (v) => v;\n', 'test/utils/clamp.test.js': "require('node:test');\n",
      'src/fmt.js': 'module.exports.fmt = (v) => v;\n', 'tests/fmt.spec.js': "require('node:test');\n" }, 'Fix clamp and fmt');
    assert.equal(assoc(ctx, 'src/utils/clamp.js'), 'test/utils/clamp.test.js');
    assert.equal(assoc(ctx, 'src/fmt.js'), 'tests/fmt.spec.js');
  });
  test('Java: src/test/java mirror with FooTest.java', async () => {
    const { ctx } = await ctxFor({ 'src/main/java/a/Auth.java': 'package a; public class Auth { boolean login() { return true; } }\n',
      'src/test/java/a/AuthTest.java': 'package a; class AuthTest {}\n' }, 'Fix login in Auth');
    assert.equal(assoc(ctx, 'src/main/java/a/Auth.java'), 'src/test/java/a/AuthTest.java');
  });
});

describe('associations are not coverage', () => {
  test('the package field is test_associations (pre-fix: test_coverage with covered_files)', async () => {
    const { ctx } = await ctxFor({ 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'src/clamp.test.js': "require('node:test');\n", 'src/other.js': 'module.exports.other = 1;\n' }, 'Fix clamp and other');
    assert.equal(ctx.test_coverage, undefined);
    assert.ok(ctx.test_associations);
    assert.match(ctx.test_associations.basis, /not coverage/i);
    assert.equal(ctx.coverage, null);
  });
  test('the briefing never claims coverage because a test file exists (pre-fix: "## Test coverage")', async () => {
    const { ctx } = await ctxFor({ 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'src/clamp.test.js': "require('node:test');\n", 'src/other.js': 'module.exports.other = 1;\n' }, 'Fix clamp and other');
    const b = buildBriefing(contract('Fix clamp and other'), ctx);
    assert.match(b, /Associated tests \(matched by file name only\)/);
    assert.doesNotMatch(b, /\bcover(ed|age)\b/i);
  });
  test('real coverage data, when the repo has it, is reported separately with its source (lcov / istanbul)', async () => {
    const lcov = 'TN:\nSF:src/clamp.js\nLF:10\nLH:7\nend_of_record\n';
    const { ctx } = await ctxFor({ 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'coverage/lcov.info': lcov }, 'Fix clamp');
    assert.deepEqual([ctx.coverage.source, ctx.coverage.files['src/clamp.js'].lines_pct], ['lcov', 70]);
    const b = buildBriefing(contract('Fix clamp'), ctx);
    assert.match(b, /Coverage data \(from coverage\/lcov\.info\)/);
    const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
    const ist = { 'src/clamp.js': { path: 'src/clamp.js', statementMap: { 0: loc, 1: loc, 2: loc, 3: loc }, s: { 0: 1, 1: 0, 2: 3, 3: 1 } } };
    const c2 = await ctxFor({ 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'coverage/coverage-final.json': JSON.stringify(ist) }, 'Fix clamp');
    assert.deepEqual([c2.ctx.coverage.source, c2.ctx.coverage.files['src/clamp.js'].statements_pct], ['istanbul', 75]);
  });
});

describe('only validated runners verify; explicit project config', () => {
  test(`an explicit ${'.quarterback.json'} node-test config runs its command`, () => {
    const r = repo({ [CONFIG_FILE]: JSON.stringify({ test: { runner: 'node-test', command: ['node', '--test', 'test/'] } }) });
    assert.deepEqual(testPlan(r.dir), { status: 'run', runner: 'node-test', command: ['node', '--test', 'test/'], source: 'config' });
  });
  test('a configured unsupported runner is rejected with a clear reason, never run', () => {
    for (const runner of ['pytest', 'jest', 'go test']) {
      const r = repo({ [CONFIG_FILE]: JSON.stringify({ test: { runner, command: ['x'] } }) });
      const p = testPlan(r.dir);
      assert.deepEqual([p.status, p.reason, p.runner], ['not_run', 'unsupported_runner', runner]);
      assert.match(p.detail, new RegExp(`unsupported runner: ${runner} — QB cannot execute and parse its results yet`));
    }
  });
  test('a heuristically detected unsupported runner (jest in package.json, pytest.ini, go.mod) is rejected', () => {
    const cases = [
      [{ 'package.json': JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }) }, 'jest'],
      [{ 'pytest.ini': '[pytest]\n' }, 'pytest'],
      [{ 'go.mod': 'module x\n' }, 'go test'],
    ];
    for (const [files, runner] of cases) {
      const p = testPlan(repo(files).dir);
      assert.deepEqual([p.status, p.reason, p.runner], ['not_run', 'unsupported_runner', runner]);
    }
  });
  test('node:test via the package.json test script runs npm test; no test command → no_test_command; bad config → invalid_test_config', () => {
    assert.deepEqual(testPlan(repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }) }).dir),
      { status: 'run', runner: 'node-test', command: ['npm', 'test'], source: 'package.json' });
    assert.deepEqual(testPlan(repo({ 'README.md': 'x' }).dir).reason, 'no_test_command');
    for (const bad of ['{nope', JSON.stringify({ test: { runner: 'node-test', command: 'npm test' } }), JSON.stringify({ test: { runner: 'node-test', command: [] } })]) {
      assert.equal(testPlan(repo({ [CONFIG_FILE]: bad }).dir).reason, 'invalid_test_config', bad);
    }
  });
  test('the briefing states that an unsupported runner is not used for verification', async () => {
    const { ctx } = await ctxFor({ 'pytest.ini': '[pytest]\n', 'src/auth.py': 'def login():\n    return True\n' }, 'Fix login in auth');
    assert.match(buildBriefing(contract('Fix login in auth'), ctx), /pytest.*not used for verification/);
  });
  test('verification with an unsupported runner is not run and can never PASS', async () => {
    const c = approve({ id: 'c', goal: 'g', clarifying_question: null, scope: { allowed_changes: ['**'] },
      acceptance_criteria: [{ id: 'AC-1', criterion: 'README style', met: null, kind: 'non_behavioral' }] }, { via: 'test' });
    const e = { id: 'e', status: 'completed', diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,0 +1,1 @@\n+x\n',
      changes: [{ file: 'README.md', status: 'M' }], sandbox: { verification: { status: 'not_run', reason: 'unsupported_runner', detail: 'unsupported runner: pytest' } } };
    const m = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
    try {
      const r = await verify(c, null, e, {});
      assert.notEqual(r.verdict, 'pass');
      assert.equal(r.test_outcome.reason, 'unsupported_runner');
      assert.match(r.test_outcome.detail, /unsupported runner: pytest/);
    } finally { m.restore(); }
  });
});

/**
 * QB-20 re-review 1: a coverage report is optional, untrusted input. It must never crash
 * L2, never yield an impossible percentage, and never attribute another project's file to
 * this repository (all through the real buildContext).
 */
describe('QB-20 re-review 1: coverage reports are validated, never trusted blindly', () => {
  const SRC = { 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'src/fmt.js': 'module.exports.fmt = (v) => v;\n' };
  const GOAL = 'Fix clamp and fmt';
  const smap = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 1 } }]));
  const ist = (s, extra = {}) => ({ path: extra.path, statementMap: smap(Object.keys(s).length), s, ...extra });
  const withReport = (name, body, more = {}) => ctxFor({ ...SRC, [`coverage/${name}`]: typeof body === 'string' ? body : JSON.stringify(body), ...more }, GOAL);
  const codes = (cov) => (cov.diagnostics || []).map((d) => d.code);

  test('a malformed istanbul entry (s: null) does not crash L2; the valid entry is kept (pre-fix: "Cannot convert undefined or null to object")', async () => {
    const { ctx } = await withReport('coverage-final.json', {
      'src/clamp.js': { path: 'src/clamp.js', s: null },
      'src/fmt.js': ist({ 0: 1, 1: 0 }, { path: 'src/fmt.js' }),
    });
    assert.equal(ctx.coverage.files['src/clamp.js'], undefined);
    assert.equal(ctx.coverage.files['src/fmt.js'].statements_pct, 50);
    assert.ok(codes(ctx.coverage).includes('invalid_entry'));
  });

  test('a report whose top level is not an object is unavailable with a diagnostic, not a crash', async () => {
    for (const body of ['null', '[]', '"x"', '42', '{nope']) {
      const { ctx } = await withReport('coverage-final.json', body);
      assert.equal(ctx.coverage.status, 'unavailable', body);
      assert.deepEqual(ctx.coverage.files, {}, body);
      assert.ok(ctx.coverage.diagnostics.length >= 1, body);
    }
  });

  test('istanbul: negative / fractional / non-numeric counters and a statementMap mismatch are rejected', async () => {
    const bad = [
      ist({ 0: -1, 1: 2 }, { path: 'src/clamp.js' }),
      ist({ 0: 1.5, 1: 2 }, { path: 'src/clamp.js' }),
      ist({ 0: '3', 1: 2 }, { path: 'src/clamp.js' }),
      { path: 'src/clamp.js', statementMap: smap(3), s: { 0: 1, 1: 1 } },   // s does not match statementMap
      { path: 'src/clamp.js', s: { 0: 1 } },                                // no statementMap
      { path: 'src/clamp.js', statementMap: null, s: { 0: 1 } },
    ];
    for (const entry of bad) {
      const { ctx } = await withReport('coverage-final.json', { 'src/clamp.js': entry, 'src/fmt.js': ist({ 0: 1 }, { path: 'src/fmt.js' }) });
      assert.equal(ctx.coverage.files['src/clamp.js'], undefined, JSON.stringify(entry));
      assert.equal(ctx.coverage.files['src/fmt.js'].statements_pct, 100);
      assert.ok(codes(ctx.coverage).includes('invalid_entry'), JSON.stringify(entry));
    }
  });

  test('lcov: impossible counts are rejected, never reported or clamped (pre-fix: LF:2 LH:5 → lines_pct 250)', async () => {
    const bad = [
      'LF:2\nLH:5',            // more hits than lines
      'LF:-1\nLH:0',           // negative
      'LF:abc\nLH:1',          // not a number
      'LF:4.5\nLH:1',          // not an integer
      'LH:1',                  // missing LF
      'LF:3\nLF:4\nLH:1',      // duplicate counter
      'DA:1,1\nDA:2,0\nLF:2\nLH:2',   // LH disagrees with the DA lines
      'DA:1,-3\nLF:1\nLH:0',   // negative hit count
    ];
    for (const rec of bad) {
      const lcov = `TN:\nSF:src/clamp.js\n${rec}\nend_of_record\nSF:src/fmt.js\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n`;
      const { ctx } = await withReport('lcov.info', lcov);
      assert.equal(ctx.coverage.files['src/clamp.js'], undefined, rec);
      assert.equal(ctx.coverage.files['src/fmt.js'].lines_pct, 50, rec);
      assert.ok(codes(ctx.coverage).some((c) => c === 'invalid_counts' || c === 'inconsistent_counts'), rec);
    }
  });

  test('foreign report paths are never attributed to this repository (pre-fix: SF:/another-project/src/clamp.js → 100% for local src/clamp.js)', async () => {
    for (const sf of ['/another-project/src/clamp.js', '/home/ci/other/src/clamp.js', '../other/src/clamp.js', 'lib/src/clamp.js', 'vendor/x/src/clamp.js']) {
      const { ctx } = await withReport('lcov.info', `SF:${sf}\nLF:10\nLH:10\nend_of_record\n`);
      assert.equal(ctx.coverage.files['src/clamp.js'], undefined, sf);
      assert.ok(ctx.coverage.unmapped.includes(sf), sf);
    }
    const { ctx } = await withReport('coverage-final.json', { '/another-project/src/clamp.js': ist({ 0: 1 }, { path: '/another-project/src/clamp.js' }) });
    assert.equal(ctx.coverage.files['src/clamp.js'], undefined);
    assert.deepEqual(ctx.coverage.unmapped, ['/another-project/src/clamp.js']);
  });

  test('exact in-repo paths are attributed: relative, ./relative, and absolute under this checkout (real or symlinked path)', async () => {
    const r = repo({ ...SRC });
    const real = fs.realpathSync(r.dir);
    fs.mkdirSync(path.join(r.dir, 'coverage'));
    fs.writeFileSync(path.join(r.dir, 'coverage/lcov.info'),
      `SF:./src/fmt.js\nLF:4\nLH:1\nend_of_record\nSF:${path.join(real, 'src/clamp.js')}\nLF:10\nLH:7\nend_of_record\n`);
    const ctx = await buildContext(contract(GOAL), r.dir, { noLlm: true });
    assert.equal(ctx.coverage.files['src/clamp.js'].lines_pct, 70);
    assert.equal(ctx.coverage.files['src/fmt.js'].lines_pct, 25);
    assert.deepEqual(ctx.coverage.unmapped, []);
  });

  test('a report generated elsewhere is attributed only through an explicit coverage.source_root mapping', async () => {
    const cfg = JSON.stringify({ coverage: { source_root: '/ci/build/project' } });
    const lcov = 'SF:/ci/build/project/src/clamp.js\nLF:10\nLH:9\nend_of_record\nSF:/ci/build/other/src/fmt.js\nLF:2\nLH:2\nend_of_record\n';
    const { ctx } = await withReport('lcov.info', lcov, { [CONFIG_FILE]: cfg });
    assert.equal(ctx.coverage.files['src/clamp.js'].lines_pct, 90);
    assert.equal(ctx.coverage.files['src/fmt.js'], undefined);
    assert.deepEqual(ctx.coverage.unmapped, ['/ci/build/other/src/fmt.js']);
    // an invalid mapping is a diagnostic, and maps nothing
    const bad = await withReport('lcov.info', lcov, { [CONFIG_FILE]: JSON.stringify({ coverage: { source_root: 'relative/dir' } }) });
    assert.equal(bad.ctx.coverage.files['src/clamp.js'], undefined);
    assert.ok(codes(bad.ctx.coverage).includes('invalid_coverage_config'));
  });

  test('two records for the same file are ambiguous: neither is reported', async () => {
    const { ctx } = await withReport('lcov.info', 'SF:src/clamp.js\nLF:10\nLH:1\nend_of_record\nSF:./src/clamp.js\nLF:10\nLH:10\nend_of_record\n');
    assert.equal(ctx.coverage.files['src/clamp.js'], undefined);
    assert.ok(codes(ctx.coverage).includes('duplicate_entry'));
  });

  test('an oversized or truncated report is reported as such, not silently treated as absent or complete', async () => {
    const big = await withReport('lcov.info', 'TN:\n' + 'x'.repeat(5 * 1024 * 1024 + 1));
    assert.equal(big.ctx.coverage.status, 'unavailable');
    assert.ok(codes(big.ctx.coverage).includes('too_large'));
    const cut = await withReport('lcov.info', 'SF:src/clamp.js\nLF:10\nLH:5\n');
    assert.equal(cut.ctx.coverage.files['src/clamp.js'], undefined);
    assert.ok(codes(cut.ctx.coverage).includes('truncated_record'));
  });

  test('the briefing shows only validated figures and states what was not used', async () => {
    const { ctx } = await withReport('lcov.info', 'SF:src/fmt.js\nLF:2\nLH:1\nend_of_record\nSF:src/clamp.js\nLF:2\nLH:5\nend_of_record\nSF:/elsewhere/src/clamp.js\nLF:1\nLH:1\nend_of_record\n');
    const b = buildBriefing(contract(GOAL), ctx);
    assert.match(b, /`src\/fmt\.js`: 50% of lines/);
    assert.doesNotMatch(b, /250%|100%/);
    assert.match(b, /1 report entr(y|ies) rejected/);
    assert.match(b, /1 report path\(s\) outside this repository/);
  });
});

/**
 * QB-20 re-review 2: `.quarterback.json` is a project config with OPTIONAL sections.
 * A coverage-only config must not turn verification off (pre-fix: no `test` section →
 * invalid_test_config → the valid package.json suite was skipped and the task could not PASS).
 */
describe('QB-20 re-review 2: the test section is optional in a valid project config', () => {
  const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'src/clamp.js': 'module.exports.clamp = (v) => v;\n' };
  const COV = { coverage: { source_root: '/ci/build/project' } };
  const LCOV = { 'coverage/lcov.info': 'SF:/ci/build/project/src/clamp.js\nLF:2\nLH:1\nend_of_record\n' };
  const NPM_PLAN = { status: 'run', runner: 'node-test', command: ['npm', 'test'], source: 'package.json' };

  test('no config → the package.json node:test plan runs', () => {
    assert.deepEqual(testPlan(repo(PKG).dir), NPM_PLAN);
  });

  test('coverage-only config → the same run plan, plus mapped coverage (pre-fix: not_run / invalid_test_config)', async () => {
    const { ctx } = await ctxFor({ ...PKG, ...LCOV, [CONFIG_FILE]: JSON.stringify(COV) }, 'Fix clamp');
    assert.deepEqual(ctx.test_plan, NPM_PLAN);
    assert.equal(ctx.coverage.files['src/clamp.js'].lines_pct, 50);
    // a config with no sections at all is valid, and also changes nothing
    assert.deepEqual(testPlan(repo({ ...PKG, [CONFIG_FILE]: '{}' }).dir), NPM_PLAN);
  });

  test('coverage-only config keeps runner detection: a detected unsupported runner is still refused', () => {
    const p = testPlan(repo({ 'pytest.ini': '[pytest]\n', [CONFIG_FILE]: JSON.stringify(COV) }).dir);
    assert.deepEqual([p.status, p.reason, p.runner, p.source], ['not_run', 'unsupported_runner', 'pytest', 'detected']);
  });

  test('test + coverage config → the configured argv, and coverage is still mapped', async () => {
    const cfg = { test: { runner: 'node-test', command: ['node', '--test', 'test/'] }, ...COV };
    const { ctx } = await ctxFor({ ...PKG, ...LCOV, [CONFIG_FILE]: JSON.stringify(cfg) }, 'Fix clamp');
    assert.deepEqual(ctx.test_plan, { status: 'run', runner: 'node-test', command: ['node', '--test', 'test/'], source: 'config' });
    assert.equal(ctx.coverage.files['src/clamp.js'].lines_pct, 50);
  });

  test('an explicitly present but invalid test section, or an invalid top level, is still rejected', () => {
    for (const bad of [{ test: null }, { test: {} }, { test: 'npm test' }, { test: { runner: 'node-test' } }, { test: { runner: 'node-test', command: 'npm test' } }, { test: { runner: 'node-test', command: [] } }, { test: null, ...COV }]) {
      const p = testPlan(repo({ ...PKG, [CONFIG_FILE]: JSON.stringify(bad) }).dir);
      assert.deepEqual([p.status, p.reason], ['not_run', 'invalid_test_config'], JSON.stringify(bad));
    }
    for (const bad of ['{nope', 'null', '[]', '"x"', '3']) {
      const p = testPlan(repo({ ...PKG, [CONFIG_FILE]: bad }).dir);
      assert.deepEqual([p.status, p.reason], ['not_run', 'invalid_test_config'], bad);
    }
  });
});
