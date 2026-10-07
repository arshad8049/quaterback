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
    const ist = { [path.join('/x', 'src/clamp.js')]: { path: '/x/src/clamp.js', s: { 0: 1, 1: 0, 2: 3, 3: 1 } } };
    const c2 = await ctxFor({ 'src/clamp.js': 'module.exports.clamp = (v) => v;\n', 'coverage/coverage-final.json': JSON.stringify(ist) }, 'Fix clamp');
    assert.equal(c2.ctx.coverage.source, 'istanbul');
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
