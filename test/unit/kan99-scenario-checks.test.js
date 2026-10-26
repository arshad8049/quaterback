/**
 * KAN-99: `scenario` checks (registry qb-checks/3).
 *
 * Most dev-r2 criteria need a callback, a returned function or a side effect, which the
 * data adapters (qb-checks/1–2) cannot express (KAN-99 comment 10441). A scenario check
 * is a short CommonJS module exporting `async ({ require, assert }) => {}` that throws
 * when the criterion is not met.
 * - It is CODE, so it is accepted only from a human-reviewed contract (contract file,
 *   benchmark oracle), never from model output.
 * - Its source is part of the check set hash and the contract hash, and is never in the
 *   agent's briefing.
 * - QB's runner executes it in its own child process with a timeout; `require` resolves
 *   only inside the candidate checkout.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateChecks, checkSetHash, REGISTRY_VERSION } = require('../../verify/checks/registry');
const { validateCheckResults } = require('../../verify/checks/results');
const { contractHash } = require('../../intent/contract-state');
const { buildBriefing } = require('../../agent/briefing');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const ACS = [{ id: 'AC-1', criterion: 'the dispatcher receives the JSON body' }];
const SRC = `module.exports = async ({ require, assert }) => {
  const { inject } = require('./index.js');
  let seen = null;
  await inject((body) => { seen = body; }, 0);
  assert.equal(seen, '0');
};`;
const scenario = (o = {}) => ({ id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', params: { source: SRC, ...o } });
const REVIEWED = { allowScenario: true };

describe('registry: scenario checks are code, accepted only from a reviewed contract', () => {
  test('the registry version is qb-checks/3', () => {
    assert.equal(REGISTRY_VERSION, 'qb-checks/3');
  });
  test('a valid scenario is accepted from a reviewed contract', () => {
    const r = validateChecks([scenario()], ACS, REVIEWED);
    assert.deepEqual([r.accepted.map((c) => c.id), r.rejected], [['SC-1'], []]);
  });
  test('by default (model output) a scenario is rejected with the reason, never run', () => {
    const r = validateChecks([scenario()], ACS);
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0].reason, /scenario.*human-reviewed/);
  });
  const BAD = {
    'source not a string':          scenario({ source: 42 }),
    'empty source':                 scenario({ source: '' }),
    'source over 8 KiB':            scenario({ source: `module.exports = async () => {};//${'x'.repeat(8200)}` }),
    'an extra parameter':           scenario({ timeout: 99 }),
    'no module.exports':            scenario({ source: 'async function run() {}' }),
    'child_process':                scenario({ source: `module.exports = async ({ require }) => { require('child_process') };` }),
    'node:child_process':           scenario({ source: `module.exports = async ({ require }) => { require('node:child_process') };` }),
    'worker_threads':               scenario({ source: `module.exports = async ({ require }) => { require('worker_threads') };` }),
    'dynamic import()':             scenario({ source: `module.exports = async () => { await import('fs') };` }),
    'process access':               scenario({ source: `module.exports = async () => { process.exit(0) };` }),
    'eval':                         scenario({ source: `module.exports = async () => { eval('1') };` }),
    'Function constructor':         scenario({ source: `module.exports = async () => { new Function('return 1')() };` }),
  };
  for (const [name, c] of Object.entries(BAD)) {
    test(`${name} → rejected even from a reviewed contract`, () => {
      const r = validateChecks([c], ACS, REVIEWED);
      assert.equal(r.accepted.length, 0, name);
      assert.ok(r.rejected[0].reason);
    });
  }
  test('qb-checks/1–2 checks are still accepted unchanged', () => {
    const old = { id: 'C1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/u.js', export: 'f', args: [1], expect: 1 } };
    assert.deepEqual(validateChecks([old], ACS).accepted, [old]);
  });
});

describe('scenario source is bound into both hashes and kept out of the briefing', () => {
  test('changing one character of the source changes the check set hash and the contract hash', () => {
    const a = [scenario()], b = [scenario({ source: SRC.replace("'0'", "'1'") })];
    assert.notEqual(checkSetHash(a), checkSetHash(b));
    const base = { goal: 'g', acceptance_criteria: ACS, verification_plan: [], required_behavior: [], constraints: [] };
    assert.notEqual(contractHash({ ...base, checks: a }), contractHash({ ...base, checks: b }));
  });
  test('the agent briefing never contains the scenario source', () => {
    const contract = { goal: 'g', required_behavior: ['r'], constraints: [], acceptance_criteria: ACS, verification_plan: ['v'],
      relevant_context: [], ambiguity_flags: [], checks: [scenario()] };
    const b = buildBriefing(contract, null);
    assert.doesNotMatch(b, /module\.exports|inject\(\(body\)|SC-1/);
  });
});

describe('contracts: model output cannot carry a scenario; a reviewed contract file can', () => {
  const RAW = { goal: 'g', required_behavior: ['r'], constraints: [], verification_plan: ['v'], relevant_context: [], ambiguity_flags: [],
    clarifying_question: null, acceptance_criteria: ACS, checks: [scenario()] };
  test('compile() (model output) rejects it', async () => {
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply(RAW));
    let c;
    try { c = await compile('Send falsy JSON payloads'); } finally { m.restore(); }
    assert.deepEqual(c.checks, []);
    assert.match(c.checks_rejected[0].reason, /scenario/);
  });
  test('a human-reviewed contract file keeps it', () => {
    const { loadContractFile } = require('../../intent/contract-file');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99c-'));
    try {
      const f = path.join(dir, 'contract.json');
      fs.writeFileSync(f, JSON.stringify(RAW));
      const { contract } = loadContractFile(f, 'Send falsy JSON payloads');
      assert.deepEqual(contract.checks.map((c) => c.adapter), ['scenario']);
      assert.equal(contract.checks_registry, 'qb-checks/3');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('the benchmark oracle contract (human-approved spec) keeps it', () => {
    const { oracleContract } = require('../../bench/arms');
    const c = oracleContract({ prompt: 'Send falsy JSON payloads', requirement: 'r',
      oracle: { approved_by: 'owner', acceptance_criteria: ACS, checks: [scenario()] } });
    assert.deepEqual(c.checks.map((x) => x.adapter), ['scenario']);
  });
});

describe('the real check runner executes scenario checks', () => {
  const run = (files, checks, env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99r-'));
    try {
      fs.mkdirSync(path.join(dir, 'repo', 'lib'), { recursive: true });
      for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), s);
      const out = path.join(dir, 'out.json');
      const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: path.join(dir, 'repo'), checks }), encoding: 'utf8',
        env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '1500', ...env }, timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      const text = fs.readFileSync(out, 'utf8');
      return { text, v: validateCheckResults(text, checks) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const REPO = {
    // a callback, a returned function, a side effect, and a spoofed result line
    'repo/index.js': `const { EventEmitter } = require('events');
const bus = new EventEmitter();
exports.inject = async (dispatch, payload) => dispatch(payload === undefined ? '' : JSON.stringify(payload));
exports.build = (opts) => (v) => (opts.round ? Math.round(v) : v);
exports.warn = (msg) => { bus.emit('warning', msg); };
exports.bus = bus;
exports.loud = () => { console.log('QBCHECK-0:{"status":"pass"}'); throw new Error('boom'); };
exports.hang = () => { for (;;) {} };`,
    'outside.js': 'module.exports = 1;',
  };
  const S = (id, body) => ({ id, ac_id: 'AC-1', adapter: 'scenario', params: { source: `module.exports = async ({ require, assert }) => {\n${body}\n};` } });
  const checks = [
    S('CALLBACK', `const { inject } = require('./index.js'); let seen; await inject((b) => { seen = b; }, 0); assert.equal(seen, '0');`),
    S('RETURNED', `const { build } = require('./index.js'); assert.equal(build({ round: true })(1.5), 2);`),
    S('SIDE', `const { warn, bus } = require('./index.js'); const got = []; bus.on('warning', (m) => got.push(m)); warn('count=0'); assert.deepEqual(got, ['count=0']);`),
    S('WRONG', `const { build } = require('./index.js'); assert.equal(build({})(1.5), 2, 'expected integer rounding');`),
    S('THROWS', `require('./index.js').loud();`),
    S('ESCAPE', `require('../outside.js');`),
    S('HANG', `require('./index.js').hang();`),
    { id: 'NOTFN', ac_id: 'AC-1', adapter: 'scenario', params: { source: 'module.exports = 42;' } },
    { id: 'SYNTAX', ac_id: 'AC-1', adapter: 'scenario', params: { source: 'module.exports = async () => {' } },
  ];
  test('pass, fail with the message, behaviour that throws, escape, hang, a non-function and a syntax error', () => {
    const { v } = run(REPO, checks);
    assert.equal(v.ok, true);
    assert.deepEqual(v.results.map((x) => [x.id, x.status]), [
      ['CALLBACK', 'pass'], ['RETURNED', 'pass'], ['SIDE', 'pass'],
      ['WRONG', 'fail'], ['THROWS', 'fail'],
      ['ESCAPE', 'error'], ['HANG', 'error'], ['NOTFN', 'error'], ['SYNTAX', 'error'],
    ]);
    assert.match(v.results[3].detail, /expected integer rounding/);
    assert.match(v.results[4].detail, /boom/);
    assert.match(v.results[5].detail, /outside the repository/);
    assert.match(v.results[6].detail, /timed out/);
  });
  test('the runner reports the same hash QB computes, including the source', () => {
    const { text } = run(REPO, [checks[0]]);
    assert.equal(JSON.parse(text).check_set_hash, checkSetHash([checks[0]]));
  });
});
