/**
 * KAN-105 review (10484). Four questions:
 *   1. the supported proof rules, stated exactly, with the residual cases that are NOT detected
 *      (several protected globs whose union covers an allowed glob; a glob under a segment glob);
 *   2. metacharacters: only `*` and `?` are wildcards in QB globs; `[`, `]`, `{`, `}`, `(`, `+`, …
 *      are literal, at L1 and at L4 alike;
 *   3. consistency with L4, by sampling concrete paths from each allowed glob;
 *   4. a generated correction must not resolve the conflict by erasing a protection the request
 *      asked for (one a constraint relies on); supplied contracts are never modified.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { policyErrors, evaluatePolicy } = require('../../verify/policy');
const { compileIntent } = require('../../intent/session');

const scoped = (allowed, prot) => ({ scope: { allowed_changes: allowed, protected_paths: prot } });
const covered = (errs) => errs.filter((e) => /is entirely covered by scope\.protected_paths/.test(e));
const rejected = (allowed, prot) => covered(policyErrors(scoped([allowed], prot))).length === 1;
const touched = (prot, file) => evaluatePolicy(scoped(['**'], prot), { changes: [{ file }], diff: '' }, []).protected_touched.includes(file);

/** Concrete paths an allowed glob matches: each wildcard filled a few ways. */
function samples(glob) {
  const fills = [['a', 'x1'], ['b', 'y2/z3']];
  return fills.map(([one, deep]) => glob.replace(/\*\*/g, '\u0000').replace(/\*/g, one).replace(/\?/g, 'q').replace(/\u0000/g, deep));
}

describe('KAN-105 review: L1 coverage agrees with L4 on sampled paths', () => {
  const REJECTED = [
    ['src/lib/**', ['src/**']], ['src/*.js', ['src/**']], ['test/**', ['**']], ['src/**/x.js', ['src/**']],
    ['test/**', ['test/**']], ['src/*.js', ['src/*.js']], ['src/a?.js', ['src/**']],
  ];
  for (const [allowed, prot] of REJECTED) {
    test(`rejected ${allowed} under ${prot}: every sampled path is protected at L4`, () => {
      assert.ok(rejected(allowed, prot));
      for (const f of samples(allowed)) assert.ok(touched(prot, f), `${f} should be protected by ${prot}`);
    });
  }
  const LEGAL = [
    ['test/**', ['test/fixtures/**'], 'test/a.js'], ['src/**', ['src/generated/*.js'], 'src/a.js'],
    ['**', ['test/**'], 'src/a.js'], ['src/*.js', ['src/a.js'], 'src/b.js'], ['src2/**', ['src/**'], 'src2/a.js'],
  ];
  for (const [allowed, prot, free] of LEGAL) {
    test(`legal ${allowed} with ${prot}: some allowed path (${free}) is not protected at L4`, () => {
      assert.equal(rejected(allowed, prot), false);
      assert.equal(touched(prot, free), false);
    });
  }
});

describe('KAN-105 review: metacharacters are literal except * and ?', () => {
  test('a literal path with brackets is matched by a segment glob, at L1 and L4', () => {
    assert.ok(rejected('src/[id].js', ['src/*.js']));
    assert.ok(touched(['src/*.js'], 'src/[id].js'));
  });
  test('braces are not expanded: src/{a,b}.js is one literal name, not src/a.js', () => {
    assert.equal(rejected('src/{a,b}.js', ['src/a.js']), false);
    assert.equal(touched(['src/a.js'], 'src/{a,b}.js'), false);
    assert.ok(rejected('src/{a,b}.js', ['src/{a,b}.js']));
  });
  test('regex characters are literal: src/a+b.js and src/(x).js', () => {
    assert.ok(rejected('src/a+b.js', ['src/a+b.js']));
    assert.equal(rejected('src/aab.js', ['src/a+b.js']), false);
    assert.equal(touched(['src/a+b.js'], 'src/aab.js'), false);
    assert.ok(rejected('src/(x).js', ['src/*']));
    assert.ok(touched(['src/*'], 'src/(x).js'));
  });
  test('a bracket in a protected glob is literal too: protected src/[ab].js does not cover src/a.js', () => {
    assert.equal(rejected('src/a.js', ['src/[ab].js']), false);
    assert.equal(touched(['src/[ab].js'], 'src/a.js'), false);
  });
});

describe('KAN-105 review: residual cases NOT detected at L1 (documented; L4 still fails them)', () => {
  test('several protected globs whose UNION covers an allowed glob', () => {
    const prot = ['x', 'x/*', 'x/*/**'];
    assert.equal(rejected('x/**', prot), false, 'L1 proves coverage by one protected glob only');
    for (const f of ['x', 'x/a', 'x/a/b']) assert.ok(touched(prot, f), `${f} is protected at L4`);
  });
  test('a glob that lies under a segment glob (src/?.js under src/*.js)', () => {
    assert.equal(rejected('src/?.js', ['src/*.js']), false);
    for (const f of samples('src/?.js')) assert.ok(touched(['src/*.js'], f));
  });
});

describe('KAN-105 review: a correction may not erase a protection the request asked for', () => {
  const F = path.join(__dirname, '..', 'fixtures', 'kan105');
  const read = (n) => fs.readFileSync(path.join(F, n), 'utf8');
  const REQUEST = read('request.txt').trim();
  async function compileWith(replies) {
    let i = 0;
    const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
    try { return { s: await compileIntent(REQUEST), calls: m.calls.length }; } finally { m.restore(); }
  }

  test('control: the faithful draft (package.json protected, constraint enforced by it) is finalized on the first call', async () => {
    const { s, calls } = await compileWith([read('faithful-draft.json')]);
    assert.equal(calls, 1);
    assert.equal(s.state, 'finalized');
  });
  test('impossible → corrected by dropping the allowed entry: finalized, protection kept', async () => {
    const { s, calls } = await compileWith([read('impossible-draft.json'), read('faithful-draft.json')]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'finalized');
    assert.deepEqual(s.contract.scope.protected_paths, ['package.json']);
  });
  test('impossible → "corrected" by deleting the protection and marking the constraint advisory: refused (pre-fix: finalized)', async () => {
    const { s, calls } = await compileWith([read('impossible-draft.json'), read('erased-protection-draft.json')]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /protected path "package\.json" enforces constraint 0 .* a correction may not remove it/);
  });
  test('impossible → "corrected" by swapping the protection for another path: refused (pre-fix: finalized)', async () => {
    const { s } = await compileWith([read('impossible-draft.json'), read('swapped-protection-draft.json')]);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /protected path "package\.json" enforces constraint 0/);
  });
  test('a protection no constraint relies on may still be dropped (the KAN-104 "**" draft)', async () => {
    const F104 = path.join(__dirname, '..', 'fixtures', 'kan104');
    let i = 0;
    const replies = [fs.readFileSync(path.join(F104, 'protected-everything-draft.json'), 'utf8'), fs.readFileSync(path.join(F104, 'faithful-draft.json'), 'utf8')];
    const m = mockFetch(() => ollamaReply(replies[Math.min(i++, 1)]));
    try {
      const s = await compileIntent(fs.readFileSync(path.join(F104, 'request.txt'), 'utf8').trim());
      assert.equal(s.state, 'finalized');
      assert.deepEqual(s.contract.scope.protected_paths, []);
    } finally { m.restore(); }
  });
});
