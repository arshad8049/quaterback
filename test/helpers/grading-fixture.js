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
 * Stand-in for the sandbox (unit tests only — trusted fixture code). Like the real grading
 * run it never touches the checkout it is given: it copies it (the "container"), applies
 * o.applyPatch THERE (exit 42 when it does not apply), reports the changed paths as capture
 * would, and runs o.testCommand with QB's node:test reporter. Records every call for spies.
 */
function hostRunner(calls = []) {
  return async (o) => {
    calls.push(o);
    const box = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-box-')), 'w');
    try {
      // the graded base is committed (task base + suite), so a clone is the container's tree
      // (fs.cpSync of a .git directory failed intermittently on Node 24 CI)
      const cl = spawnSync('git', ['clone', '-q', '--no-hardlinks', o.repoPath, box], { encoding: 'utf8' });
      if (cl.status !== 0) throw new Error(`stand-in clone failed: ${cl.stderr}`);
      let changes = [];
      if (o.applyPatch) {
        const ap = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: box, input: o.applyPatch, encoding: 'utf8' });
        if (ap.status !== 0) return { status: 'execution_error', changes: [], sandbox: { stages: { agent: { state: 'execution_error', exit_code: 42 } } } };
        spawnSync('git', ['add', '-A'], { cwd: box });
        changes = spawnSync('git', ['diff', '--cached', '--name-only', 'HEAD'], { cwd: box, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((file) => ({ file }));
      }
      const command = o.testCommand || JSON.parse(fs.readFileSync(path.join(box, '.quarterback.json'), 'utf8')).test.command;
      const report = path.join(box, '.qb-report.ndjson');
      const reporter = path.join(__dirname, '../../sandbox/agent/qb-test-reporter.mjs');
      const r = spawnSync(command[0], command.slice(1), { cwd: box, encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${reporter} --test-reporter-destination=${report}` } });
      const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : null;
      const missing = r.error && r.error.code === 'ENOENT';
      const state = missing ? 'execution_error' : r.status === 0 ? 'completed' : 'execution_error';
      return { status: changes.length ? 'completed' : 'no_change', changes, sandbox: { stages: { agent: { state: 'completed', exit_code: 0 } },
        verification: { status: 'ran', state, exit_code: missing ? 127 : r.status, report: text, report_error: text ? null : 'no_report', output: `${r.stdout}${r.stderr}` } } };
    } finally { fs.rmSync(path.dirname(box), { recursive: true, force: true }); }
  };
}

module.exports = { gradingFixture, hostRunner, INVENTED_CONTRACT, IMPL, SUITE };
