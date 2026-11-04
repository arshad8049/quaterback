/**
 * KAN-103 / KAN-104 re-review (2026-11-05, Jira comments 10468 and 10469): four gaps the first
 * tests did not cover.
 *   1. Lost evidence (both cards): when the ONE corrective call fails with no draft (an empty
 *      response, a network error, cancellation), the first rejected draft and its errors were
 *      lost with the exception. They are now attached to the error and kept in the run record.
 *   2. Reworded defaults (KAN-103): the guard matched identical wording only, so "16-bit integers"
 *      reworded got past it. A correction may now add NO proposed default the rejected draft had
 *      not already justified (same id and text, covered there).
 *   3. Byte limit (KAN-104): the 16 KiB cap on an unreadable reply counted UTF-16 code units, not
 *      bytes. It now counts UTF-8 bytes and never splits a character.
 *   4. Customer-safe CLI output (KAN-104): the standalone intent CLI printed s.errors (parser
 *      diagnostics included). It now prints the same customer summary as qb.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const { compileIntent } = require('../../intent/session');

const F103 = path.join(__dirname, '..', 'fixtures', 'kan103');
const F104 = path.join(__dirname, '..', 'fixtures', 'kan104');
const read = (dir, n) => fs.readFileSync(path.join(dir, n), 'utf8');
const CART = read(F103, 'request.txt').trim();
const GREETING = read(F104, 'request.txt').trim();
const BAD = read(F103, 'bad-draft.json');
const GOOD = read(F103, 'corrected-draft.json');
const MALFORMED = read(F104, 'malformed-draft.txt');
const STILL_MALFORMED = read(F104, 'still-malformed-draft.txt');

const ROOT = path.join(__dirname, '..', '..');

/** compileIntent with each model call answered by `responders[i]` (a reply, or a function). */
async function compileWith(request, responders) {
  let i = 0;
  const m = mockFetch((url, init) => {
    const r = responders[Math.min(i++, responders.length - 1)];
    return typeof r === 'function' ? r(url, init) : ollamaReply(r);
  });
  try {
    const s = await compileIntent(request);
    return { s, calls: m.calls.length };
  } catch (error) {
    return { error, calls: m.calls.length };
  } finally { m.restore(); }
}

describe('KAN-103/104 re-review 1: the first draft and its errors survive a failed corrective call', () => {
  const failures = {
    'an empty response': () => ollamaReply(''),
    'a network error': () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
  };
  for (const [what, fail] of Object.entries(failures)) {
    test(`invalid first draft, then ${what}: the error carries the rejected draft and its errors (pre-fix: lost)`, async () => {
      const { error, calls } = await compileWith(CART, [BAD, fail]);
      assert.equal(calls, 2);
      assert.ok(error, 'the failure still propagates');
      assert.equal(error.recovery?.attempted, true);
      assert.equal(error.recovery.rejected.length, 1);
      assert.equal(error.recovery.rejected[0].kind, 'invalid');
      assert.match(error.recovery.rejected[0].errors.join('\n'), /asinteger/);
      assert.match(JSON.stringify(error.recovery.rejected[0].contract), /16-bit integers/);
      assert.match(error.recovery.failed.message, what === 'an empty response' ? /Empty response/ : /ECONNREFUSED/);
    });
    test(`malformed first draft, then ${what}: the diagnostic and the size-limited reply survive`, async () => {
      const { error } = await compileWith(GREETING, [MALFORMED, fail]);
      assert.equal(error.recovery.rejected[0].kind, 'syntax');
      assert.match(error.recovery.rejected[0].diagnostic, /Unexpected token 'g'/);
      assert.match(error.recovery.rejected[0].raw, /"args": \[greeting, "test"\]/);
    });
  }

  test('cancellation (run deadline) during the correction: CANCELLED, and the evidence is still attached', async () => {
    const budget = require('../../lib/budget');
    const run = budget.startRun({ deadlineMs: 300 });
    run.stage('L1 intent');
    try {
      const { error } = await compileWith(CART, [BAD, () => new Promise(() => {})]);
      assert.equal(error.code, 'DEADLINE');
      assert.equal(error.recovery.rejected[0].kind, 'invalid');
      assert.match(error.recovery.failed.message, /deadline/);
    } finally { budget.endRun(); }
  });

  /** qb.js with scripted replies; returns the manifest and the stored contract-repair artifact. */
  function runCli(request, replies, env = {}) {
    const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'r', scripts: { test: 'node --test' } }), 'src/a.js': '' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan103-104-'));
    try {
      const runs = path.join(tmp, 'runs');
      const r = proc.run(process.execPath, ['--require', path.join(__dirname, '..', 'helpers', 'preload-ollama.js'), path.join(ROOT, 'qb.js'), request,
        '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify'], {
        env: { ...process.env, QB_RUNS_DIR: runs, QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(replies), ...env },
        encoding: 'utf8', timeout: 60_000,
      });
      const dir = path.join(runs, fs.readdirSync(runs)[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const ref = manifest.artifacts['contract-repair'];
      const evidence = ref ? JSON.parse(fs.readFileSync(path.join(dir, ref.path), 'utf8')) : null;
      const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
      return { out: r.stdout + r.stderr, manifest, evidence, events };
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  test('qb.js: invalid draft, then an empty correction reply → ERROR, with the first draft in the run record (pre-fix: no artifact)', () => {
    const r = runCli(CART, [BAD, '']);
    assert.equal(r.manifest.outcome, 'ERROR', r.out);
    assert.ok(r.evidence, 'contract-repair stored');
    assert.equal(r.evidence.outcome, 'error');
    assert.match(r.evidence.rejected[0].errors.join('\n'), /asinteger/);
    assert.match(r.evidence.failed.message, /Empty response/);
    assert.ok(r.events.includes('contract.repair_failed'));
  });
  test('qb.js: malformed draft, then an empty correction reply → ERROR, with the diagnostic in the run record', () => {
    const r = runCli(GREETING, [MALFORMED, '']);
    assert.equal(r.manifest.outcome, 'ERROR', r.out);
    assert.equal(r.evidence.rejected[0].kind, 'syntax');
    assert.match(r.evidence.rejected[0].diagnostic, /Unexpected token 'g'/);
  });
});

describe('KAN-103 re-review 2: a correction may not bring an invented choice back in other words', () => {
  const reworded = () => {
    const c = JSON.parse(GOOD);
    c.proposed_defaults = [
      { id: 'D-1', text: 'Money amounts are kept in signed 16 bit integer fields', reason: 'size of amounts' },
      { id: 'D-7', text: "Negative quantities fail with the text 'Invalid input'", reason: 'error wording' },
    ];
    c.acceptance_criteria.push(
      { id: 'AC-7', criterion: 'Amounts fit in a signed 16 bit integer', requirement_ids: ['D-1'] },
      { id: 'AC-8', criterion: "A negative quantity fails with the text 'Invalid input'", requirement_ids: ['D-7'] });
    return JSON.stringify(c);
  };

  test('reworded defaults cited by new criteria are refused (pre-fix: finalized)', async () => {
    const { s, calls } = await compileWith(CART, [BAD, reworded()]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    const e = s.errors.join('\n');
    assert.match(e, /proposed default D-1 "Money amounts are kept in signed 16 bit integer fields" is new in the correction/);
    assert.match(e, /proposed default D-7 .* is new in the correction/);
  });

  test('control: a default the rejected draft already justified (same id and text, covered) may stay', async () => {
    const rejected = JSON.parse(BAD);
    rejected.proposed_defaults.push({ id: 'D-3', text: 'Quantities are whole numbers', reason: 'the request counts items' });
    rejected.acceptance_criteria.push({ id: 'AC-3', criterion: 'A fractional quantity is rejected', requirement_ids: ['D-3'] });
    const corrected = JSON.parse(GOOD);
    corrected.proposed_defaults = [{ id: 'D-3', text: 'Quantities are whole numbers', reason: 'the request counts items' }];
    corrected.acceptance_criteria.push({ id: 'AC-7', criterion: 'A fractional quantity is rejected', requirement_ids: ['D-3'] });
    const { s } = await compileWith(CART, [JSON.stringify(rejected), JSON.stringify(corrected)]);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
  });

  test('control: an uncovered default is still refused when it comes back with the same id but new words', async () => {
    const c = JSON.parse(GOOD);
    c.proposed_defaults = [{ id: 'D-2', text: 'Reject negatives with a fixed message', reason: 'r' }];
    c.acceptance_criteria.push({ id: 'AC-7', criterion: 'Negatives get a fixed message', requirement_ids: ['D-2'] });
    const { s } = await compileWith(CART, [BAD, JSON.stringify(c)]);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /D-2 .* is new in the correction/);
  });
});

describe('KAN-104 re-review 3: the reply limit is 16 KiB of UTF-8, never splitting a character', () => {
  const LIMIT = 16 * 1024;
  for (const [label, ch] of [['4-byte emoji', '🙂'], ['3-byte €', '€'], ['2-byte é', 'é']]) {
    test(`a malformed reply of ${label}: kept to ${LIMIT} bytes, a clean prefix, flagged truncated (pre-fix: counted characters)`, async () => {
      const reply = `{ "goal": "${ch.repeat(9000)}", "args": [greeting] }`;
      assert.ok(Buffer.byteLength(reply) > LIMIT && reply.length < 3 * LIMIT);
      const { s } = await compileWith(GREETING, [reply, reply]);
      for (const d of s.repair.rejected) {
        assert.ok(Buffer.byteLength(d.raw) <= LIMIT, `${Buffer.byteLength(d.raw)} bytes`);
        assert.ok(Buffer.byteLength(d.raw) > LIMIT - 4, 'filled up to the limit');
        assert.ok(!d.raw.includes('�'), 'no split character');
        assert.ok(reply.startsWith(d.raw), 'a prefix of the reply');
        assert.equal(d.raw_truncated, true);
        assert.equal(d.raw_bytes, Buffer.byteLength(reply));
      }
    });
  }
  test('a reply under the limit is kept whole and not flagged', async () => {
    const { s } = await compileWith(GREETING, [MALFORMED, STILL_MALFORMED]);
    assert.equal(s.repair.rejected[0].raw, MALFORMED);
    assert.equal(s.repair.rejected[0].raw_truncated, false);
  });
});

describe('KAN-104 re-review 4: the standalone intent CLI prints a customer-safe summary', () => {
  function intentCli(request, replies) {
    const repo = makeRepo({ 'README.md': '# r\n' });
    try {
      const r = proc.run(process.execPath, ['--require', path.join(__dirname, '..', 'helpers', 'preload-ollama.js'), path.join(ROOT, 'intent', 'cli.js'), request, '--repo', repo.dir], {
        env: { ...process.env, QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(replies) }, encoding: 'utf8', timeout: 60_000,
      });
      return { status: r.status, out: r.stdout + r.stderr };
    } finally { repo.cleanup(); }
  }

  test('malformed → malformed: no parser diagnostics or drafts, the customer message, exit 2 (pre-fix: s.errors printed)', () => {
    const r = intentCli(GREETING, [MALFORMED, STILL_MALFORMED]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /QB couldn't build a reliable checklist\. No code was changed\./);
    assert.doesNotMatch(r.out, /Unexpected token|not valid JSON|\[greeting, "test"\]|\[Arshad\]/);
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.equal(json.state, 'invalid');
    assert.equal(json.errors, undefined);
    assert.deepEqual(json.repair, { attempted: true, drafts: 2 });
  });
  test('invalid → invalid: the summary lists the readable validation problems, as qb.js does', () => {
    const still = JSON.parse(BAD); still.proposed_defaults = [];
    const r = intentCli(CART, [BAD, JSON.stringify(still)]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /QB couldn't build a reliable checklist/);
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    assert.match(json.problems.join('\n'), /R-1 quote is not in the request verbatim/);
  });
});
