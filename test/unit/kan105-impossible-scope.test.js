/**
 * KAN-105 (found in KAN-104, run d9bcf7fe): a contract whose allowed change is entirely protected —
 * `allowed_changes: ["src/greeting.js"]` with `protected_paths: ["**"]` — passed L1 and went to
 * approval and a paid agent run that could only fail at the L4 policy (`protected_touched`).
 *
 * policyErrors now rejects an allowed_changes entry that protected_paths covers entirely, with the
 * L4 policy's own glob semantics. The rule is conservative: it reports only coverage it can prove
 * (a literal path matched by a protected glob; a glob that is identical to, or lies wholly under, a
 * protected glob). Partial overlaps stay legal; protection still wins on those paths at L4.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const { policyErrors, evaluatePolicy } = require('../../verify/policy');
const { compileIntent } = require('../../intent/session');

const F104 = path.join(__dirname, '..', 'fixtures', 'kan104');
const read = (n) => fs.readFileSync(path.join(F104, n), 'utf8');
const REQUEST = read('request.txt').trim();
const FAITHFUL = read('faithful-draft.json');
const PROTECTED_ALL = read('protected-everything-draft.json');
const scoped = (allowed, prot) => ({ scope: { allowed_changes: allowed, protected_paths: prot } });
const covered = (errs) => errs.filter((e) => /is entirely covered by scope\.protected_paths/.test(e));

describe('KAN-105: an allowed change that is entirely protected is rejected at L1', () => {
  const IMPOSSIBLE = [
    ['literal under **', ['src/greeting.js'], ['**'], 'src/greeting.js', '**'],
    ['literal under a directory glob', ['src/greeting.js'], ['src/**'], 'src/greeting.js', 'src/**'],
    ['literal matched by a segment glob', ['src/a.js'], ['src/*.js'], 'src/a.js', 'src/*.js'],
    ['glob under a broader protected glob', ['src/lib/**'], ['src/**'], 'src/lib/**', 'src/**'],
    ['segment glob under a directory glob', ['src/*.js'], ['src/**'], 'src/*.js', 'src/**'],
    ['any glob under **', ['test/**'], ['**'], 'test/**', '**'],
    ['identical globs', ['test/**'], ['test/**'], 'test/**', 'test/**'],
    ['identical segment globs', ['src/*.js'], ['src/*.js'], 'src/*.js', 'src/*.js'],
  ];
  for (const [label, allowed, prot, entry, by] of IMPOSSIBLE) {
    test(`${label}: rejected, naming both patterns (pre-fix: accepted)`, () => {
      const e = covered(policyErrors(scoped(allowed, prot)));
      assert.equal(e.length, 1, JSON.stringify(policyErrors(scoped(allowed, prot))));
      assert.match(e[0], new RegExp(`entry ${JSON.stringify(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is entirely covered by scope\\.protected_paths ${JSON.stringify(by).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
  }

  test('each covered entry is reported; uncovered entries in the same scope are not', () => {
    const e = covered(policyErrors(scoped(['src/greeting.js', 'test/**', 'docs/a.md'], ['src/**', 'test/**'])));
    assert.equal(e.length, 2);
    assert.match(e.join('\n'), /"src\/greeting\.js"/);
    assert.match(e.join('\n'), /"test\/\*\*"/);
    assert.doesNotMatch(e.join('\n'), /docs\/a\.md/);
  });

  const LEGAL = [
    ['a protected subdirectory of an allowed tree', ['test/**'], ['test/fixtures/**']],
    ['protected generated files inside an allowed tree', ['src/**'], ['src/generated/*.js']],
    ['disjoint trees', ['src/a.js'], ['test/**']],
    ['** allowed, one tree protected', ['**'], ['test/**']],
    ['a segment glob allowed, one file in it protected', ['src/*.js'], ['src/a.js']],
    ['a sibling prefix is not a parent', ['src2/a.js'], ['src/**']],
    ['no protected paths', ['src/greeting.js', 'test/**'], []],
    ['no allowed changes (nothing to cover)', [], ['**']],
  ];
  for (const [label, allowed, prot] of LEGAL) {
    test(`legal: ${label}`, () => assert.deepEqual(covered(policyErrors(scoped(allowed, prot))), []));
  }

  test('the rule agrees with the L4 policy: each rejected literal is a protected change there', () => {
    for (const [, allowed, prot, entry] of IMPOSSIBLE.filter(([, a]) => !/[*?]/.test(a[0]))) {
      const p = evaluatePolicy(scoped(allowed, prot), { changes: [{ file: entry }], diff: '' }, []);
      assert.equal(p.effect, 'fail');
      assert.deepEqual(p.protected_touched, [entry]);
    }
  });
});

describe('KAN-105 through the L1 recovery path', () => {
  async function compileWith(replies) {
    let i = 0;
    const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
    try { return { s: await compileIntent(REQUEST), calls: m.calls.length }; } finally { m.restore(); }
  }

  test('a generated draft with an impossible scope gets the one correction (pre-fix: finalized on the first call)', async () => {
    const { s, calls } = await compileWith([PROTECTED_ALL, FAITHFUL]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'finalized');
    assert.match(s.repair.rejected[0].errors.join('\n'), /"src\/greeting\.js" is entirely covered by scope\.protected_paths "\*\*"/);
    assert.deepEqual(s.contract.scope.protected_paths, []);
  });

  test('…and if the correction keeps it, QB blocks after two drafts', async () => {
    const { s, calls } = await compileWith([PROTECTED_ALL, PROTECTED_ALL, FAITHFUL]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /is entirely covered by scope\.protected_paths/);
  });

  test('qb.js: a --contract-file with an impossible scope is refused as supplied, 0 model calls, no agent', () => {
    const repo = makeRepo({ 'package.json': JSON.stringify({ name: 's', type: 'module', scripts: { test: 'node --test' } }), 'src/greeting.js': 'export function greeting() { return "x"; }\n' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan105-'));
    try {
      const file = path.join(tmp, 'contract.json'); fs.writeFileSync(file, PROTECTED_ALL);
      const fetchLog = path.join(tmp, 'fetch.log'); const sandboxLog = path.join(tmp, 'sandbox.log'); const runs = path.join(tmp, 'runs');
      const r = proc.run(process.execPath, ['--require', path.join(__dirname, '..', 'helpers', 'preload-ollama.js'), '--require', path.join(__dirname, '..', 'helpers', 'preload-sandbox-spy.js'),
        path.join(__dirname, '..', '..', 'qb.js'), REQUEST, '--repo', repo.dir, '--agent', 'claude-code', '--contract-file', file, '--no-llm-context', '--no-llm-verify'], {
        env: { ...process.env, QB_TEST_FETCH_LOG: fetchLog, QB_TEST_SANDBOX_LOG: sandboxLog, QB_RUNS_DIR: runs, QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: FAITHFUL },
        encoding: 'utf8', timeout: 60_000,
      });
      const out = r.stdout + r.stderr;
      const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      assert.equal(r.status, 2, out);
      assert.equal(rd(fetchLog).split('\n').filter(Boolean).length, 0, 'no model call');
      assert.equal(rd(sandboxLog).split('\n').filter(Boolean).length, 0, 'no agent');
      assert.match(out, /contract file .* is not valid \(it is never rewritten automatically\)/);
      assert.match(out, /"src\/greeting\.js" is entirely covered by scope\.protected_paths "\*\*"/);
      const m = JSON.parse(rd(path.join(runs, fs.readdirSync(runs)[0], 'manifest.json')));
      assert.equal(m.outcome, 'BLOCKED');
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
