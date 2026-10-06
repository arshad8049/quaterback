/**
 * QB-18: context retrieval matches its claims.
 * - content/symbol retrieval: the relevant symbol in a generically named file is found
 *   in a 200+ file repository;
 * - bounded graph traversal (visited set, explicit depth, import AND caller edges) with a
 *   recorded reason per file: a two-hop dependency is present;
 * - irrelevant files do not dominate; omissions and the retrieval budget are explicit;
 * - after each patch the context is refreshed: a file created by attempt 1 is in
 *   attempt 2's context (through the real qb.js loop).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildContext } = require('../../context/builder');
const { makeRepo } = require('../helpers/tmprepo');

const CONTRACT = {
  id: 'c-qb18', goal: 'Fix parseDuration so "90m" returns minutes',
  required_behavior: ['parseDuration("90m") returns 5400'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'parseDuration("90m") returns 5400' }],
};

/** 200+ files: the relevant code sits in generically named files; 220 noise files, 20 of them name-matching distractors. */
function bigRepo() {
  const files = {
    'src/utils/helpers.js': "const { UNITS } = require('./time/units');\n\nfunction parseDuration(s) {\n  const m = /^(\\d+)([smh])$/.exec(s);\n  return m ? Number(m[1]) * UNITS[m[2]] : NaN;\n}\n\nmodule.exports = { parseDuration };\n",
    'src/utils/time/units.js': "const { SECOND } = require('./constants');\n\nconst UNITS = { s: SECOND, m: 60 * SECOND, h: 3600 * SECOND };\n\nmodule.exports = { UNITS };\n",
    'src/utils/time/constants.js': 'const SECOND = 1;\n\nmodule.exports = { SECOND };\n',
    'src/cli/main.js': "const { parseDuration } = require('../utils/helpers');\n\nconsole.log(parseDuration(process.argv[2]));\n",
  };
  for (let i = 0; i < 200; i++) {
    const n = String(i).padStart(3, '0');
    files[`src/modules/mod_${n}.js`] = `const next = require('./mod_${String((i + 1) % 200).padStart(3, '0')}');\n\nfunction handler${n}(req) {\n  return { ok: true, id: ${i}, next: typeof next };\n}\n\nmodule.exports = { handler${n} };\n`;
  }
  for (let i = 0; i < 20; i++) files[`src/legacy/duration_report_${i}.js`] = `function report${i}(rows) {\n  return rows.length;\n}\n\nmodule.exports = { report${i} };\n`;
  return makeRepo(files);
}

describe('retrieval in a 200+ file repository', () => {
  let r, ctx;
  before(async () => { r = bigRepo(); ctx = await buildContext(CONTRACT, r.dir, { noLlm: true }); });
  after(() => r.cleanup());

  test('the symbol in a generically named file is retrieved, ranked first, with a symbol-match reason (pre-fix: not retrieved)', () => {
    const paths = ctx.relevant_files.map((f) => f.path);
    assert.equal(paths[0], 'src/utils/helpers.js', JSON.stringify(paths.slice(0, 8)));
    assert.match(ctx.relevant_files[0].reason, /seed: symbol parseDuration/);
    assert.equal(ctx.relevant_files[0].retrieval.edge, 'seed');
  });
  test('a two-hop dependency (seed → units → constants) and a caller (cli/main) are present, with their edges and depths', () => {
    const by = Object.fromEntries(ctx.relevant_files.map((f) => [f.path, f]));
    assert.deepEqual([by['src/utils/time/units.js']?.retrieval.edge, by['src/utils/time/units.js']?.retrieval.depth], ['import', 1]);
    assert.deepEqual([by['src/utils/time/constants.js']?.retrieval.edge, by['src/utils/time/constants.js']?.retrieval.depth], ['import', 2]);
    assert.match(by['src/utils/time/constants.js'].reason, /import of src\/utils\/time\/units\.js \(depth 2\)/);
    assert.deepEqual([by['src/cli/main.js']?.retrieval.edge, by['src/cli/main.js']?.retrieval.depth], ['caller', 1]);
  });
  test('irrelevant files do not dominate: noise is excluded, distractors are below the relevance cut and recorded as omitted', () => {
    const paths = ctx.relevant_files.map((f) => f.path);
    assert.deepEqual(paths.slice(0, 4).sort(), ['src/cli/main.js', 'src/utils/helpers.js', 'src/utils/time/constants.js', 'src/utils/time/units.js']);
    assert.ok(!paths.some((p) => p.startsWith('src/modules/')), 'generic noise is not in the package');
    assert.ok(paths.filter((p) => p.startsWith('src/legacy/')).length === 0, JSON.stringify(paths));
    const om = ctx.retrieval.omitted.filter((o) => o.path.startsWith('src/legacy/duration_report_'));
    assert.ok(om.length > 0 && om.every((o) => o.dropped === 'below_relevance_cut'), JSON.stringify(ctx.retrieval.omitted.slice(0, 3)));
  });
  test('the retrieval budget and depth are explicit in the package', () => {
    const R = ctx.retrieval;
    assert.equal(R.depth, 2);
    assert.ok(Number.isInteger(R.max_files) && Number.isInteger(R.max_bytes));
    assert.equal(R.used_files, ctx.relevant_files.length);
    assert.ok(R.used_bytes <= R.max_bytes && R.used_files <= R.max_files);
    assert.ok(R.scanned_files >= 224, `scanned ${R.scanned_files}`);
    assert.deepEqual(R.seeds.map((s) => s.path)[0], 'src/utils/helpers.js');
  });
  test('depth is configurable and enforced (depth 1 excludes the two-hop file, recording why)', async () => {
    const c1 = await buildContext(CONTRACT, r.dir, { noLlm: true, retrieval: { depth: 1 } });
    const paths = c1.relevant_files.map((f) => f.path);
    assert.ok(paths.includes('src/utils/time/units.js'));
    assert.ok(!paths.includes('src/utils/time/constants.js'));
    assert.ok(c1.retrieval.omitted.some((o) => o.path === 'src/utils/time/constants.js' && o.dropped === 'depth_limit'));
  });
  test('the file budget is enforced: what does not fit is omitted with dropped "max_files"', async () => {
    const c2 = await buildContext(CONTRACT, r.dir, { noLlm: true, retrieval: { maxFiles: 2 } });
    assert.equal(c2.relevant_files.length, 2);
    assert.ok(c2.retrieval.omitted.some((o) => o.dropped === 'max_files'));
  });
});

describe('refresh after each patch (through qb.js)', () => {
  const ROOT = path.join(__dirname, '..', '..');
  let tmp, r;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb18-cli-'));
    r = makeRepo({
      'src/utils/helpers.js': "function parseDuration(s) {\n  return NaN;\n}\n\nmodule.exports = { parseDuration };\n",
      'README.md': '# demo\n',
    });
  });
  after(() => { r.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('a file created by attempt 1 (and its neighbours) is in attempt 2\'s context (pre-fix: retries reused the original context)', () => {
    const file = path.join(tmp, 'contract.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'Fix parseDuration', required_behavior: ['parseDuration handles minutes'],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'parseDuration handles minutes', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
      verification_plan: ['read helpers'], requirements: [{ id: 'R-1', quote: 'Fix parseDuration' }], scope: { allowed_changes: ['**'] } }));
    const script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ attempts: [
      { steps: [{ write: 'src/utils/durationParser.js', content: "const { parseDuration } = require('./helpers');\n\nfunction parseMinutes(s) {\n  return parseDuration(s) * 60;\n}\n\nmodule.exports = { parseMinutes };\n" }] },
      { steps: [{ write: 'src/utils/durationParser.js', content: 'module.exports = {};\n' }] },
    ] }));
    const no = JSON.stringify({ met: false, evidence: 'parseDuration ignores minutes', repair: 'Handle the m unit in parseDuration' });
    const log = path.join(tmp, 'briefings.jsonl');
    const res = spawnSync(process.execPath, ['--require', path.join(ROOT, 'test', 'helpers', 'preload-ollama.js'), '--require', path.join(ROOT, 'test', 'helpers', 'preload-fake-sandbox.js'),
      path.join(ROOT, 'qb.js'), 'Fix parseDuration', '--repo', r.dir, '--agent', 'claude-code', '--no-llm-context', '--max-retries', '2', '--contract-file', file],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: '', QB_FAKE_AGENT_SCRIPT: script, QB_FAKE_AGENT_COUNTER: path.join(tmp, 'counter'),
      QB_FAKE_AGENT_BRIEFING_LOG: log, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_JUDGE_CACHE_DIR: path.join(tmp, 'jc'),
      QB_TEST_OLLAMA_SEQUENCE: JSON.stringify([no, no, no, no, no, no]) } });
    const briefings = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(briefings.length, 2, res.stdout + res.stderr);
    assert.ok(!briefings[0].includes('src/utils/durationParser.js'));
    assert.ok(briefings[1].includes('src/utils/durationParser.js'), 'attempt 2 sees the file attempt 1 created');
    // the run record says what the refresh did
    const runId = fs.readdirSync(path.join(tmp, 'runs'))[0];
    const events = fs.readFileSync(path.join(tmp, 'runs', runId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const refreshed = events.find((e) => e.type === 'context.refreshed');
    assert.ok(refreshed, events.map((e) => e.type).join(','));
    assert.deepEqual(refreshed.data.added, ['src/utils/durationParser.js']);
    assert.equal(refreshed.data.attempt, 1);
  });
});
