/**
 * lib/doctor.js — `qb doctor`: is this machine ready to run QB? (QB-31)
 *
 *   runtime         Node ≥ 20 (package.json engines)
 *   git             git on PATH
 *   docker          the Docker daemon answers (required for claude-code: the agent and the
 *                   verification tests run only in the QB sandbox)
 *   agent-auth      a claude-code credential is PRESENT: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN,
 *                   or the QB-scoped login volume from `qb auth login`. Presence is not validity
 *                   (an empty or stale volume, a wrong key): doctor never calls the API, so a
 *                   present credential is a warning, "validity not verified" — the first
 *                   authenticated call of a real run is the evidence it works.
 *   model           the local model server (QB_OLLAMA_URL) answers and has QB_MODEL
 *   agent-adapter   the agent is a registered adapter (agent/adapters.js, qb-agent-adapter/1)
 *   check-registry  the executable-check registry loads (verify/checks/registry.js)
 *   repository      (--repo) a git work tree (required for claude-code, a warning otherwise)
 *   test-runner     (--repo) the test plan QB would use (context/test-plan.js; node:test is the
 *                   only validated runner, QB-20)
 *
 * Status per check: ok | warn | fail | skip, each non-ok with a fix. Any fail → exit code 1.
 * Every probe is a parameter (`deps`), so the logic is tested without this machine.
 */

const fs = require('fs');
const path = require('path');
const { ADAPTERS, adapterProblem } = require('../agent/adapters');

const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'deepseek-r1:7b';
const MIN_NODE = 20;

/** Real probes. Each answers null when the tool or service is unavailable. */
function defaultDeps() {
  const proc = require('./proc');
  return {
    nodeVersion: process.version,
    gitVersion: async () => { const r = proc.run('git', ['--version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; },
    dockerVersion: async () => require('./sandbox/docker').available(),
    authVolumeExists: async () => require('./sandbox/auth').authVolumeExists(),
    modelTags: async (url) => {
      try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const body = await res.json();
        return Array.isArray(body.models) ? body.models.map((m) => m.name) : [];
      } catch { return null; }
    },
  };
}

const check = (id, status, detail, fix) => ({ id, status, detail, ...(fix ? { fix } : {}) });
const sameModel = (want, have) => have === want || have === `${want}:latest` || `${have}:latest` === want;

/** @returns {Promise<{ schema, agent, checks, exitCode }>} */
async function doctor({ agent = 'claude-code', repo, env = process.env } = {}, deps = defaultDeps()) {
  const checks = [];
  const needsSandbox = agent === 'claude-code';

  const major = Number(String(deps.nodeVersion).replace(/^v/, '').split('.')[0]);
  checks.push(major >= MIN_NODE
    ? check('runtime', 'ok', `Node ${String(deps.nodeVersion).replace(/^v/, '')}`)
    : check('runtime', 'fail', `Node ${String(deps.nodeVersion).replace(/^v/, '')}; QB needs Node ${MIN_NODE} or newer`, 'install Node 20 LTS or newer (https://nodejs.org)'));

  const gitV = await deps.gitVersion();
  checks.push(gitV ? check('git', 'ok', gitV) : check('git', 'fail', 'git not found on PATH', 'install git'));

  const dockerV = await deps.dockerVersion();
  if (dockerV) checks.push(check('docker', 'ok', `Docker Engine ${dockerV}`));
  else if (needsSandbox) checks.push(check('docker', 'fail', 'Docker is not running or not reachable; claude-code runs only in the QB sandbox', 'start Docker (Docker Engine on Linux, Docker Desktop on macOS)'));
  else checks.push(check('docker', 'warn', `Docker is not running or not reachable (not needed for --agent ${agent})`, 'start Docker before using --agent claude-code'));

  if (!needsSandbox) checks.push(check('agent-auth', 'skip', `no sign-in needed for --agent ${agent}`));
  else {
    const keyVar = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].find((k) => env[k]);
    if (keyVar) checks.push(check('agent-auth', 'warn', `${keyVar} is set; validity not verified (doctor makes no API call)`, 'a real run verifies it; if it fails to authenticate, check the key'));
    else if (!dockerV) checks.push(check('agent-auth', 'fail', 'cannot check the QB sign-in while Docker is unavailable', 'start Docker, then run `qb doctor` again'));
    else {
      let signedIn = false;
      try { signedIn = await deps.authVolumeExists(); } catch { signedIn = false; }
      checks.push(signedIn ? check('agent-auth', 'warn', 'QB login volume present; validity not verified (it may be empty or expired; doctor makes no API call)', '`qb auth status` shows the token expiry; if a run fails to authenticate, run `qb auth login` again')
        : check('agent-auth', 'fail', 'not signed in to Claude Code for QB', 'qb auth login   (or set ANTHROPIC_API_KEY)'));
    }
  }

  const url = env.QB_OLLAMA_URL || DEFAULT_OLLAMA;
  const model = env.QB_MODEL || DEFAULT_MODEL;
  const tags = await deps.modelTags(url);
  if (tags === null) checks.push(check('model', 'fail', `no model server at ${url} (the intent, context and judge stages call it)`, `install and start Ollama (https://ollama.com), then: ollama pull ${model}   (or set QB_OLLAMA_URL)`));
  else if (!tags.some((t) => sameModel(model, t))) checks.push(check('model', 'fail', `${model} is not available at ${url}`, `ollama pull ${model}   (or set QB_MODEL to one of: ${tags.slice(0, 5).join(', ') || 'none installed'})`));
  else checks.push(check('model', 'ok', `${model} at ${url}`));

  const problem = adapterProblem(agent);
  checks.push(problem ? check('agent-adapter', 'fail', problem, 'see docs/support.md for the supported agents')
    : check('agent-adapter', 'ok', `${agent} (${ADAPTERS[agent].support}, ${ADAPTERS[agent].interface})`));

  try {
    const reg = require('../verify/checks/registry');
    checks.push(check('check-registry', 'ok', `${reg.REGISTRY_VERSION}: ${reg.ADAPTERS.join(', ')}`));
  } catch (e) { checks.push(check('check-registry', 'fail', `the check registry did not load: ${e.message}`, 'reinstall QB (npm ci)')); }

  if (repo !== undefined) {
    const dir = path.resolve(repo);
    const proc = require('./proc');
    const inside = fs.existsSync(dir) ? proc.git(['rev-parse', '--is-inside-work-tree'], dir, { allowFail: true }) : null;
    if (!inside || inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
      checks.push(needsSandbox
        ? check('repository', 'fail', `${dir} is not a git work tree; --agent claude-code needs one`, 'run `git init` and commit, or pass the right --repo')
        : check('repository', 'warn', `${dir} is not a git work tree (fine for --agent ${agent}; claude-code needs one)`, 'run `git init` and commit before using --agent claude-code'));
    } else {
      checks.push(check('repository', 'ok', dir));
      const plan = require('../context/test-plan').testPlan(dir);
      checks.push(plan.status === 'run'
        ? check('test-runner', 'ok', `${plan.runner} via ${plan.command.join(' ')} (${plan.source})`)
        : check('test-runner', 'warn', `${plan.detail}; QB still runs, but tests are not_run, so no task can pass`, 'use node:test, or set .quarterback.json { "test": { "runner": "node-test", "command": [...] } }'));
    }
  }

  return { schema: 'qb-doctor/1', agent, checks, exitCode: checks.some((c) => c.status === 'fail') ? 1 : 0 };
}

const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

function formatDoctor(r) {
  const w = Math.max(...r.checks.map((c) => c.id.length));
  const lines = [`qb doctor (--agent ${r.agent})`, ''];
  for (const c of r.checks) {
    lines.push(`  ${MARK[c.status]} ${c.id.padEnd(w)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`    ${' '.repeat(w)}  fix: ${c.fix}`);
  }
  const fails = r.checks.filter((c) => c.status === 'fail').length;
  const warns = r.checks.filter((c) => c.status === 'warn').length;
  lines.push('', fails ? `${fails} problem${fails === 1 ? '' : 's'} to fix before running QB${warns ? `; ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`
    : `Ready${warns ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}.`);
  return `${lines.join('\n')}\n`;
}

/** `qb doctor [--agent <id>] [--repo <path>] [--json]` → exit code. */
async function main(argv, { out = process.stdout, err = process.stderr, deps } = {}) {
  const o = { agent: 'claude-code', repo: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if ((a === '--agent' || a === '--repo') && argv[i + 1] !== undefined) o[a.slice(2)] = argv[++i];
    else { err.write(`qb doctor: unknown option ${a}\nusage: qb doctor [--agent <${Object.keys(ADAPTERS).sort().join('|')}>] [--repo <path>] [--json]\n`); return 2; }
  }
  const r = await doctor({ agent: o.agent, repo: o.repo }, deps || defaultDeps());
  out.write(o.json ? `${JSON.stringify(r, null, 2)}\n` : formatDoctor(r));
  return r.exitCode;
}

module.exports = { doctor, formatDoctor, main, defaultDeps };
