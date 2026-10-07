/**
 * The review's QB-27 example as a frozen-spec fixture: "show 30,000 ms as 30s".
 * A QB-generated contract that invented "5m" must not decide the score; the hidden
 * suite (human-written, outside the repository) does.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeRepo } = require('./tmprepo');
const S = require('../../bench/schemas');

const BASE = { 'package.json': JSON.stringify({ name: 'dur', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'package-lock.json': JSON.stringify({ name: 'dur', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'dur', version: '1.0.0' } } }, null, 2) + '\n',
  'src/duration.js': 'module.exports.formatDuration = (ms) => `${ms}ms`;\n' };

const IMPL = {
  correct: 'module.exports.formatDuration = (ms) => {\n  const s = Math.round(ms / 1000); const m = Math.floor(s / 60); const r = s % 60;\n  return m ? (r ? `${m}m ${r}s` : `${m}m`) : `${r}s`;\n};\n',
  fiveMinutes: "module.exports.formatDuration = (ms) => (ms === 30000 ? '5m' : `${Math.round(ms / 60000)}m`);\n",   // what QB's contract invented
  offByOne: 'module.exports.formatDuration = (ms) => {\n  const s = Math.round(ms / 1000) + 1; const m = Math.floor(s / 60); const r = s % 60;\n  return m ? (r ? `${m}m ${r}s` : `${m}m`) : `${r}s`;\n};\n',
  syntaxError: 'module.exports.formatDuration = (ms) => {\n  return `${ms}s`\n',
};

const SUITE = {
  'duration.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n"
    + "const { formatDuration } = require('../../src/duration');\n"
    + "test('30,000 ms is 30s', () => assert.equal(formatDuration(30000), '30s'));\n"
    + "test('90,000 ms is 1m 30s', () => assert.equal(formatDuration(90000), '1m 30s'));\n",
};

/** A QB-generated contract that invented the wrong target (never shown to the grader). */
const INVENTED_CONTRACT = { goal: 'show 30,000 ms as 30s', acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "5m"' }] };

function makePatch(repoDir, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-patch-'));
  try {
    spawnSync('git', ['clone', '-q', repoDir, tmp]);
    for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), c); }
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    return spawnSync('git', ['diff', '--cached', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).stdout;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** A repo, a suites root OUTSIDE it, an unqualified spec, and patches. */
function gradingFixture({ suite = SUITE, extra = {} } = {}) {
  const repo = makeRepo(BASE);
  const suitesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-suites-'));
  fs.mkdirSync(path.join(suitesRoot, 'T-30S'));
  for (const [rel, c] of Object.entries(suite)) fs.writeFileSync(path.join(suitesRoot, 'T-30S', rel), c);
  const spec = {
    schema: 'qb-task-spec/1', id: 'T-30S', version: 1, split: 'dev', stratum: { type: 'bug_fix', repository: 'dur' },
    repo: { source: repo.dir, base_rev: repo.head(), lockfiles: { 'package-lock.json': S.sha256File(path.join(repo.dir, 'package-lock.json')) } },
    prompt: 'formatDuration should show 30,000 ms as 30s', requirement: 'formatDuration(ms) renders whole seconds as "<s>s" below a minute and "<m>m <s>s" above',
    oracle: null,
    suite: { dir: 'T-30S', files: S.fileHashes(path.join(suitesRoot, 'T-30S')), command: ['node', '--test', 'test/hidden/duration.test.js'],
      install_to: 'test/hidden', owned_paths: ['test/hidden/**'], adjudicate_checks: [] },
    qualification: null, adjudication_rules: 'Score pass only if the rendered string matches the requirement exactly.',
    provenance: { author: 'qb-test', created_at: '2026-10-07T00:00:00Z', tuned_during_development: false }, ...extra,
  };
  const patch = (name) => makePatch(repo.dir, { 'src/duration.js': IMPL[name] });
  return { repo, suitesRoot, spec, patch, makePatch: (files) => makePatch(repo.dir, files),
    cleanup: () => { repo.cleanup(); fs.rmSync(suitesRoot, { recursive: true, force: true }); } };
}

/**
 * Host-side stand-in for the sandbox (unit tests only — trusted fixture code): runs the
 * graded tree's .quarterback.json command with QB's node:test reporter and returns the
 * same verification shape stage ⑤ produces. Records every call for spies.
 */
function hostRunner(calls = []) {
  return async (o) => {
    calls.push(o);
    const plan = JSON.parse(fs.readFileSync(path.join(o.repoPath, '.quarterback.json'), 'utf8')).test;
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-rep-')), 'r.ndjson');
    const reporter = path.join(__dirname, '../../sandbox/agent/qb-test-reporter.mjs');
    const r = spawnSync(plan.command[0], plan.command.slice(1), { cwd: o.repoPath, encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${reporter} --test-reporter-destination=${report}` } });
    const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : null;
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
    const state = r.error && r.error.code === 'ENOENT' ? 'execution_error' : r.status === 0 ? 'completed' : 'execution_error';
    return { status: 'no_change', sandbox: { verification: { status: 'ran', state, exit_code: r.error && r.error.code === 'ENOENT' ? 127 : r.status, report: text, report_error: text ? null : 'no_report', output: `${r.stdout}${r.stderr}` } } };
  };
}

module.exports = { gradingFixture, hostRunner, INVENTED_CONTRACT, IMPL, SUITE };
