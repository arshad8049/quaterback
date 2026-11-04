#!/usr/bin/env node
/**
 * bench/l1-eval.js — KAN-106: how often does the live L1 model produce a usable contract?
 *
 * Runs each task in bench/l1-eval/tasks.json N times through the real compileIntent (the same
 * survey, validator and one-correction path qb.js uses) against the local Ollama, and records
 * every trial. No agent, no Docker, no paid calls. Nothing is approved or executed.
 *
 *   node bench/l1-eval.js --model deepseek-r1:7b --trials 5 [--task greeting] [--out DIR]
 *   node bench/l1-eval.js --summarize DIR          # merge every trials-*.jsonl in DIR
 *
 * Writes DIR/trials-<model>.jsonl (one line per trial, appended as it goes) and
 * DIR/summary.{json,md}. One model per process: QB_MODEL is read when the compiler loads.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const score = require('./l1-eval/score');

function args(argv) {
  const o = { trials: 3, tasks: [], out: path.join(__dirname, 'results', 'l1-eval') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') o.model = argv[++i];
    else if (a === '--trials') o.trials = Number(argv[++i]);
    else if (a === '--task') o.tasks.push(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--summarize') o.summarize = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const git = (cwd, a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'qb-eval', GIT_AUTHOR_EMAIL: 'qb-eval@example.invalid', GIT_COMMITTER_NAME: 'qb-eval', GIT_COMMITTER_EMAIL: 'qb-eval@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });

function fixtureRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-l1-eval-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  return dir;
}

async function modelDigest(url, model) {
  try {
    const r = await fetch(`${url}/api/tags`);
    const m = (await r.json()).models.find((x) => x.name === model || x.model === model);
    return m ? m.digest : null;
  } catch { return null; }
}

function writeSummary(dir, meta = {}) {
  const trials = fs.readdirSync(dir).filter((f) => /^trials-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const summaries = score.summarize(trials);
  const runMeta = { ...meta, models: [...new Set(trials.map((t) => `${t.model} (${(t.digest || 'digest unknown').slice(0, 12)})`))], commits: [...new Set(trials.map((t) => t.commit))] };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ meta: runMeta, summaries }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), score.markdown(summaries, runMeta) + '\n');
  return summaries;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.summarize) { writeSummary(o.summarize); process.stdout.write(fs.readFileSync(path.join(o.summarize, 'summary.md'), 'utf8')); return; }
  if (!o.model) throw new Error('--model is required');
  process.env.QB_MODEL = o.model;
  const url = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
  const { compileIntent } = require('../intent/session');   // after QB_MODEL is set

  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'l1-eval', 'tasks.json'), 'utf8')).tasks;
  const tasks = o.tasks.length ? all.filter((t) => o.tasks.includes(t.id)) : all;
  if (!tasks.length) throw new Error('no tasks selected');
  fs.mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, `trials-${o.model.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  const digest = await modelDigest(url, o.model);
  const commit = (() => { try { return git(__dirname, ['rev-parse', '--short', 'HEAD']).toString().trim(); } catch { return null; } })();
  const host = { platform: process.platform, arch: process.arch, cpus: os.cpus().length, mem_gib: Math.round(os.totalmem() / 2 ** 30), node: process.version };

  // Count model calls (every POST to the model server) per trial.
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => { if (String(u).startsWith(url) && init && init.method === 'POST') calls++; return realFetch(u, init); };

  for (let trial = 1; trial <= o.trials; trial++) {
    for (const task of tasks) {
      const repo = fixtureRepo(task.files);
      calls = 0;
      const t0 = Date.now();
      let result = null; let error = null;
      try { result = await compileIntent(task.request, { repoPath: repo }); } catch (e) { error = e; }
      finally { fs.rmSync(repo, { recursive: true, force: true }); }
      const ms = Date.now() - t0;
      const rejected = result?.repair?.rejected || error?.recovery?.rejected || [];
      const outcome = score.outcomeOf(result, error);
      const rec = {
        format: 'qb-l1-eval-trial/1', model: o.model, digest, commit, host, task: task.id, trial, outcome,
        first_draft_failure: rejected[0] ? (rejected[0].kind === 'syntax' ? 'syntax' : 'invalid') : null,
        calls, ms,
        categories: score.categorize(rejected.flatMap((r) => r.errors || [])),
        faithfulness: score.faithfulness(result, task.expect_checks),
        errors: result?.errors || null,
        error: error ? { code: error.code || null, message: String(error.message || error) } : null,
        question: result?.unresolved?.[0]?.question || null,
        contract: result?.contract || null,
        rejected,
        at: new Date().toISOString(),
      };
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      const f = rec.faithfulness;
      process.stdout.write(`${o.model}  trial ${trial}  ${task.id.padEnd(9)} ${outcome.padEnd(19)} calls=${calls} ${(ms / 1000).toFixed(1)}s${f ? `  proxy ${f.met}/${f.total}` : ''}\n`);
    }
  }
  globalThis.fetch = realFetch;
  writeSummary(o.out, { host });
  process.stdout.write(`\nwrote ${file}\n${path.join(o.out, 'summary.md')}\n`);
}

if (require.main === module) main().catch((e) => { process.stderr.write(`l1-eval: ${e.stack || e}\n`); process.exit(1); });

module.exports = { writeSummary };
