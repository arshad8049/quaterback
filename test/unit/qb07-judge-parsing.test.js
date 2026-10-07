/**
 * QB-07: the judge accepts only a strict judgment object. Negative prose,
 * fenced garbage, arrays, null JSON, wrong types and missing fields are
 * invalid_judgment (a null vote), never a positive verdict by text guessing.
 * One bounded format retry per vote; malformed text is never used as evidence.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { judgeAll, parseJudgment, MAX_FORMAT_RETRIES } = require('../../verify/judge');

const AC = [{ id: 'AC-1', criterion: 'targetFunction exists' }];
const DIFF = 'diff --git a/x.js b/x.js\n+function targetFunction() {}\n';

async function judgeWith(responder) {
  const m = mockFetch(responder);
  try { return { r: (await judgeAll(AC, DIFF, {}))[0], calls: m.calls.length }; } finally { m.restore(); }
}

const INVALID = {
  'negative prose': 'The criterion is not implemented.',
  'positive-sounding prose': 'Yes, it is implemented and the criterion is met: true.',
  'fenced garbage': '```json\nnot json at all, met: true\n```',
  'array': '[true]',
  'array of objects': '[{"met": true, "evidence": "x.js adds targetFunction"}]',
  'null JSON': 'null',
  'met as string': '{"met": "true", "evidence": "x.js adds targetFunction"}',
  'met as number': '{"met": 1, "evidence": "x.js adds targetFunction"}',
  'missing met': '{"evidence": "x.js adds targetFunction"}',
  'missing evidence': '{"met": true}',
  'empty evidence': '{"met": true, "evidence": "   "}',
  'evidence wrong type': '{"met": true, "evidence": ["x.js"]}',
  'repair wrong type': '{"met": false, "evidence": "absent", "repair": 7}',
  'refs wrong type': '{"met": true, "evidence": "x.js", "refs": "x.js:1"}',
};

describe('QB-07: strict judgment parsing', () => {
  for (const [name, raw] of Object.entries(INVALID)) {
    test(`${name} → invalid_judgment, never a positive vote`, async () => {
      assert.throws(() => parseJudgment(raw), (e) => e.code === 'invalid_judgment');
      const { r } = await judgeWith(ollamaReply(raw));
      assert.notEqual(r.met, true);
      assert.ok(!r.votes.includes(true), `votes ${JSON.stringify(r.votes)}`);
      assert.equal(r.judgment_status, 'invalid_judgment');
      assert.ok(!r.evidence.includes(raw.slice(0, 20)) || raw.length < 3, 'malformed output must not become evidence');
    });
  }

  test('a strict object is accepted; <think> blocks and a json fence around valid JSON are tolerated', async () => {
    assert.deepEqual(parseJudgment('{"met": true, "evidence": "x.js adds targetFunction", "refs": ["x.js:1"]}'),
      { met: true, evidence: 'x.js adds targetFunction', repair: null, refs: ['x.js:1'] });
    const fenced = '<think>reasoning</think>\n```json\n{"met": false, "evidence": "absent", "repair": "add it"}\n```';
    assert.deepEqual(parseJudgment(fenced), { met: false, evidence: 'absent', repair: 'add it', refs: [] });
    const { r } = await judgeWith(ollamaReply({ met: true, evidence: 'x.js adds targetFunction' }));
    assert.equal(r.met, true);
    assert.equal(r.judgment_status, 'ok');
  });

  test('one bounded format retry per vote; a valid retry counts, garbage is never retried twice', async () => {
    assert.equal(MAX_FORMAT_RETRIES, 1);
    const always = await judgeWith(ollamaReply('The criterion is not implemented.'));
    assert.equal(always.calls, 3 * (1 + MAX_FORMAT_RETRIES));

    // every first call per vote is garbage, every format re-ask is valid — decided by the
    // request itself, since votes run concurrently (QB-21) and calls interleave
    const healed = await judgeWith((url, init) => (JSON.parse(init.body).messages.length === 2
      ? ollamaReply('implemented!') : ollamaReply({ met: true, evidence: 'x.js adds targetFunction' })));
    assert.equal(healed.r.met, true);
    assert.equal(healed.calls, 6);
  });

  test('the keyword fallback is gone from the judge', () => {
    const src = require('fs').readFileSync(require.resolve('../../verify/judge'), 'utf8');
    assert.doesNotMatch(src, /\\b\(met\|satisfied\|implemented/);
  });
});
