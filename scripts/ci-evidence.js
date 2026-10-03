#!/usr/bin/env node
/**
 * scripts/ci-evidence.js — the evidence record each CI job publishes (QB-26).
 *
 *   node scripts/ci-evidence.js <job> <tap-file> [out.json]
 *
 * Records what the job ran on and under which bounds:
 *   - runtimes and tools (Node, Docker, git), the pinned agent version and images;
 *   - timeouts: the job limit, sandbox stage deadlines and supervisor timings;
 *   - models: none are called in CI. There is no model server or credential;
 *     unit tests answer model calls with stubs (preload-ollama.js, mockFetch) and
 *     integration tests use scripted stand-in agents. The configured default
 *     model is recorded but never invoked;
 *   - cost: 0 by construction. The job fails if a model credential is present;
 *   - test counts parsed from the TAP output, with each known-defect TODO by name
 *     (green CI does not mean the seeded Phase 2 defects are fixed).
 *
 * Writes <out.json> (default ci-evidence.json), appends a Markdown summary to
 * $GITHUB_STEP_SUMMARY when set, and exits 1 if a credential is present or the
 * TAP output is missing or reports failures.
 */

const fs = require('fs');
const { run } = require('../lib/proc');

// Credentials that would let a CI job call a paid model. None may be set.
const MODEL_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'];

/** Totals and TODO names from node:test TAP output. */
function parseTap(tap) {
  const count = (k) => { const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(tap); return m ? Number(m[1]) : null; };
  const todo = [...tap.matchAll(/^\s*(?:not )?ok \d+ - (.+?) # TODO(?: (.*))?$/gm)].map((m) => ({ test: m[1], note: m[2] || null }));
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), todo: count('todo'), todo_tests: todo };
}

function version(cmd, args) {
  const r = run(cmd, args, { timeout: 15_000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

function collect(job, tapText, env = process.env) {
  const present = MODEL_CREDENTIALS.filter((k) => env[k]);
  const { AGENT_VERSION, AGENT_IMAGE } = require('../lib/sandbox/agent');
  const { PROXY_IMAGE } = require('../lib/sandbox/egress');
  const { DEFAULT_DEADLINES } = require('../lib/sandbox/pipeline');
  const P = require('../lib/sandbox/protocol');
  return {
    job,
    commit: env.GITHUB_SHA || null,
    run: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    runtime: {
      node: process.version, platform: `${process.platform}-${process.arch}`,
      docker: version('docker', ['version', '--format', '{{.Server.Version}}']),
      git: version('git', ['--version']),
    },
    agent: { version: AGENT_VERSION, images: { agent: AGENT_IMAGE, proxy: PROXY_IMAGE } },
    timeouts: {
      job_minutes: env.QB_CI_JOB_TIMEOUT_MINUTES ? Number(env.QB_CI_JOB_TIMEOUT_MINUTES) : null,
      sandbox_stage_deadlines_ms: DEFAULT_DEADLINES,
      supervisor: P.CONFIG,
    },
    models: {
      called: [],
      configured_default: env.QB_MODEL || 'deepseek-r1:7b',
      basis: job.startsWith('unit')
        ? 'no model server or credential exists in CI; tests answer model calls with stubs (preload-ollama.js, mockFetch)'
        : 'scripted stand-in agents; the real Claude binary runs only in T-POLICY (manual, with credentials)',
    },
    cost: { usd: 0, basis: 'no model is called and no model credential is present', credentials_present: present },
    tests: parseTap(tapText || ''),
  };
}

function summary(e) {
  const t = e.tests;
  const lines = [
    `### QB evidence: ${e.job}`,
    `- **Tests:** ${t.pass} pass, ${t.fail} fail, ${t.skipped} skipped, ${t.todo} todo (of ${t.tests})`,
    ...(t.todo_tests.length ? [`- **Known defects (todo, non-gating; not fixed):** ${t.todo_tests.map((x) => x.test).join('; ')}`] : []),
    `- **Runtime:** Node ${e.runtime.node}, Docker ${e.runtime.docker || 'n/a'}, ${e.runtime.git || 'git n/a'}`,
    `- **Agent:** ${e.agent.version}`,
    `- **Models called:** none (${e.models.basis}); **cost:** $${e.cost.usd}`,
    `- **Timeouts:** job ${e.timeouts.job_minutes ?? '?'} min; stage deadlines ${JSON.stringify(e.timeouts.sandbox_stage_deadlines_ms)}`,
  ];
  return lines.join('\n') + '\n';
}

function main([job, tapFile, out = 'ci-evidence.json']) {
  if (!job || !tapFile) { console.error('usage: ci-evidence.js <job> <tap-file> [out.json]'); return 1; }
  const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : '';
  const e = collect(job, tap);
  fs.writeFileSync(out, JSON.stringify(e, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(e));
  process.stdout.write(summary(e));
  if (e.cost.credentials_present.length) { console.error(`model credential(s) present in CI: ${e.cost.credentials_present.join(', ')}`); return 1; }
  if (e.tests.tests === null) { console.error(`no TAP totals in ${tapFile}`); return 1; }
  if (e.tests.fail) return 1;
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseTap, collect, summary, MODEL_CREDENTIALS, main_for_test: main };
