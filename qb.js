#!/usr/bin/env node
/**
 * qb.js — Quarterback root orchestrator
 *
 * Runs the full 4-layer pipeline with automatic repair loop:
 *   L1 Intent → L2 Context → L3 Agent → L4 Verify → (retry on fail)
 *
 * Usage:
 *   node qb.js "Add Gemini Flash as a second LLM provider" --repo ./myapp
 *   node qb.js "Fix the login bug" --repo ./myapp --agent claude-code --save
 *   node qb.js "Refactor auth module" --repo ./myapp --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, 'intent/.env') });

const fs   = require('fs');
const path = require('path');
const readline = require('readline');
const { program } = require('commander');

const { compile }      = require('./intent/compiler');
const { buildContext } = require('./context/builder');
const { orchestrate }  = require('./agent/orchestrator');
const { verify }       = require('./verify/verifier');
const memory           = require('./memory');
const runStore         = require('./run/store');
const { artifactFile } = require('./lib/fsafe');
const { inputFromReport } = require('./verify/verdict');

// `qb replay <run_id>` / `qb runs` — inspect stored run records.
if (['replay', 'runs', 'show'].includes(process.argv[2])) {
  process.exit(require('./run/cli').main(process.argv.slice(2)));
}

const QB_VERSION = '0.1.0';

program
  .name('qb')
  .description('Quarterback — Intent to Verified Result')
  .argument('<request>', 'Natural-language task request')
  .option('--repo <path>',         'Path to the target repository', process.cwd())
  .option('--agent <type>',        'Coding agent: dry-run | claude-code | manual', 'dry-run')
  .option('--max-retries <n>',     'Max repair loop attempts', '3')
  .option('--no-llm-context',      'Skip LLM enrichment in Layer 2 (faster)')
  .option('--no-llm-verify',       'Skip LLM judgment in Layer 4 (DSA only)')
  .option('--save',                'Save all artifacts to disk')
  .option('--telemetry',           'Send anonymous run metrics to Quarterback (opt-in)')
  .option('--beta-email <email>',  'Your beta registration email (required for --telemetry)')
  .parse(process.argv);

const opts    = program.opts();
const request = program.args[0];

const DIVIDER  = '─'.repeat(72);
const DIVIDER2 = '═'.repeat(72);

let currentRun = null;

async function main() {
  const repoPath   = path.resolve(opts.repo);
  const maxRetries = parseInt(opts.maxRetries, 10) || 3;

  console.log(`\n${DIVIDER2}`);
  console.log(`  QUARTERBACK`);
  console.log(`  Request: "${request}"`);
  console.log(`  Repo:    ${repoPath}`);
  console.log(`  Agent:   ${opts.agent}`);
  console.log(`${DIVIDER2}\n`);

  const totalStart = Date.now();

  // ── Run record (QB-38) ────────────────────────────────────────────────────
  const model = process.env.QB_MODEL || 'deepseek-r1:7b';
  const run = currentRun = runStore.createRun({
    kind:    'qb',
    request,
    repoPath,
    agent:   { type: opts.agent },
    models:  { intent: model, context: model, judge: model },
    config:  { ...opts, maxRetries },
  });
  runStore.installSignalHandlers(run);
  log('RUN', `${run.id}  (${run.dir})`);

  // ── Layer 5: Memory — prior run recall ────────────────────────────────────
  const priors = memory.recallPrior(repoPath, request);
  if (priors.length) {
    log('L5', `Memory: ${priors.length} similar past run(s) on this repo`);
    priors.slice(0, 3).forEach(p => {
      const icon = p.verdict === 'pass' ? '✓' : p.verdict === 'fail' ? '✗' : '~';
      const files = p.changed_files.length ? `  changed: ${p.changed_files.slice(0, 3).join(', ')}` : '';
      console.log(`     ${icon} [${p.verdict}] "${p.goal.slice(0, 55)}"${files}`);
    });
  }

  // ── Layer 1: Intent ────────────────────────────────────────────────────────
  log('L1', 'Intent compiler...');
  const t1 = Date.now();
  let contract = await compile(request);

  // Handle clarifying question — ask the user and re-compile
  if (contract.clarifying_question) {
    console.log(`\n  ⚠  Ambiguity detected:\n`);
    if (contract.ambiguity_flags?.length) {
      contract.ambiguity_flags.forEach(f => console.log(`     • ${f}`));
    }
    console.log(`\n  ❓ ${contract.clarifying_question}\n`);

    const answer = await prompt('  Your answer → ');
    if (!answer.trim()) {
      console.log('\n  No answer provided. Exiting.\n');
      run.finish('BLOCKED', { reason: 'clarification required; no answer provided' });
      process.exit(1);
    }

    log('L1', 'Re-compiling with clarification...');
    contract = await compile(request, null, answer.trim());
  }

  log('L1', `Contract ready  (${Date.now() - t1}ms)`);
  console.log(`     Goal: ${contract.goal}`);
  console.log(`     ACs:  ${contract.acceptance_criteria?.length || 0}`);

  run.setContract(contract);
  if (opts.save) saveArtifact('intent/contracts', contract);

  // ── Layer 2: Context (memory-boosted) ─────────────────────────────────────
  const fileHints    = memory.recallFiles(repoPath, contract.goal);
  const priorRepairs = memory.recallRepairs(repoPath, contract.acceptance_criteria);
  if (fileHints.length) {
    log('L5', `Memory: ${fileHints.length} file hint(s) for L2`);
    fileHints.forEach(h => console.log(`     ↑ ${h.file}  (${h.reason})`));
  }
  if (priorRepairs.length) {
    log('L5', `Memory: ${priorRepairs.length} prior repair hint(s) loaded`);
  }

  log('L2', 'Context engine...');
  const t2 = Date.now();
  const context = await buildContext(contract, repoPath, {
    noLlm:     !opts.llmContext,
    fileHints,
  });
  log('L2', `Context ready  (${Date.now() - t2}ms)`);
  console.log(`     ${context.relevant_files.length} files, ${Object.keys(context.symbol_map).length} symbols`);

  if (opts.save) saveArtifact('context/packages', context);

  // ── Repair loop: L3 → L4 ──────────────────────────────────────────────────
  let execution   = null;
  let report      = null;
  let attempt     = 0;
  // Seed repair loop with any prior repairs memory recalled
  let repairHints = priorRepairs.map(r => ({
    criterion_id:  r.criterion_id,
    diagnosis:     r.diagnosis,
    suggested_fix: r.fix,
  }));

  while (attempt < maxRetries) {
    attempt++;

    const isRetry = attempt > 1;
    const label   = isRetry ? `L3 Agent (repair attempt ${attempt})` : 'L3 Agent';
    log(isRetry ? 'L3↩' : 'L3', `${label}...`);

    run.startAttempt({
      attempt,
      parent_attempt: isRetry ? attempt - 1 : null,
      repair_reason:  repairHints.map(h => h.criterion_id),
    });

    const t3 = Date.now();
    execution = await orchestrate(contract, context, {
      agent:        opts.agent,
      repoPath,
      repairHints,
      attempt,
    });
    log(isRetry ? 'L3↩' : 'L3', `Execution done  (${Date.now() - t3}ms)  status=${execution.status}`);

    if (execution.changes.length) {
      execution.changes.forEach(c => {
        console.log(`     ${c.file.padEnd(38)} +${c.additions} -${c.deletions}`);
      });
    }

    if (opts.save) saveArtifact('agent/executions', execution, `${execution.id}_attempt${attempt}`);

    // ── Layer 4: Verify ──────────────────────────────────────────────────────
    log('L4', 'Verification...');
    const t4 = Date.now();
    report = await verify(contract, context, execution, {
      noLlm:    !opts.llmVerify,
      repoPath,
    });
    run.finishAttempt(attempt, {
      execution,
      report,
      patch:       execution.diff,
      verifyInput: inputFromReport(report, execution),
    });
    log('L4', `Verdict: ${verdictIcon(report.verdict)} ${report.verdict.toUpperCase()}  (${Date.now() - t4}ms)`);

    // Print criteria
    report.criteria_results.forEach(r => {
      const icon = r.met === true ? '✓' : r.met === false ? '✗' : '~';
      const voteStr = r.votes
        ? ` [${r.votes.map(v => v === true ? 'T' : v === false ? 'F' : '?').join('/')}]`
        : '';
      console.log(`     ${icon} [${r.id}]${voteStr} ${r.criterion.slice(0, 56)}`);
    });

    if (report.verdict === 'pass') break;
    if (report.verdict === 'error') {
      console.log(`\n  ✗ Agent execution ${execution.status}: ${execution.error || 'no detail'}`);
      if (execution.changes.length) console.log('    Partial changes were captured in the run record for inspection.');
      break;
    }
    if (report.verdict === 'unresolved') {
      console.log(execution.status === 'no_change'
        ? '\n  ~ Agent changed nothing — requirement not independently verified.'
        : '\n  ~ Change could not be fully captured — cannot approve.');
      break;
    }
    if (report.verdict === 'no-diff') {
      console.log('\n  ○ No diff to verify — running in dry-run mode.');
      break;
    }
    // No AC failures → nothing concrete to repair, regardless of verdict.
    // partial = all criteria ambiguous (--no-llm-verify or no diff to read)
    // fail    = test runner fired but all ACs passed (pre-existing test failure)
    if (report.failures.length === 0) {
      if (report.verdict === 'partial') {
        console.log('\n  ~ Criteria ambiguous — no explicit failures to repair.');
        console.log('    Run without --no-llm-verify for a definitive LLM verdict.');
      } else if (report.verdict === 'fail') {
        console.log('\n  ✗ Test suite failure detected — all ACs passed but tests failed.');
        console.log('    This may be a pre-existing failure unrelated to this change.');
      }
      break;
    }

    if (attempt >= maxRetries) {
      console.log(`\n  Reached max retries (${maxRetries}). Needs human review.`);
      break;
    }

    // Prepare repair hints for next attempt
    repairHints = report.repair_hints;
    console.log(`\n  ${report.failures.length} criterion/criteria failed — retrying with repair hints...\n`);
    report.repair_hints.forEach(h => {
      console.log(`  [${h.criterion_id}] ${h.diagnosis}`);
      console.log(`    → ${h.suggested_fix}\n`);
    });
  }

  if (opts.save && report) saveArtifact('verify/reports', report);

  // ── Layer 5: Memory — persist this run ────────────────────────────────────
  await memory.remember(repoPath, contract, { ...report, attempts: attempt }, execution);
  const memStats = memory.stats(repoPath);
  log('L5', `Memory updated  (${memStats.total_runs} run(s), ${memStats.files_tracked} file(s) tracked)`);

  run.finish(
    runStore.outcomeFor(report?.verdict, { dryRun: opts.agent === 'dry-run' }),
    { legacy_verdict: report?.verdict || null },
  );

  // ── Final summary ──────────────────────────────────────────────────────────
  const totalMs = Date.now() - totalStart;
  console.log(`\n${DIVIDER2}`);
  console.log(`  RESULT: ${verdictIcon(report?.verdict)} ${(report?.verdict || 'unknown').toUpperCase()}`);
  console.log(`  Attempts: ${attempt} / ${maxRetries}`);
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Run:      ${run.id}  outcome=${run.manifest.outcome}`);

  if (report?.verdict === 'pass') {
    console.log(`\n  All ${contract.acceptance_criteria?.length} acceptance criteria met.`);
    if (execution?.changes?.length) {
      console.log(`  ${execution.changes.length} file(s) changed.`);
    }
  } else if (report?.failures?.length) {
    console.log(`\n  Still failing: ${report.failures.join(', ')}`);
    console.log(`  Human review required.`);
  }

  console.log(`\n${DIVIDER2}\n`);

  // ── Telemetry (opt-in) ─────────────────────────────────────────────────────
  const betaEmail = opts.betaEmail || process.env.QB_BETA_EMAIL;
  if (opts.telemetry && betaEmail) {
    await phonehome({
      email:        betaEmail,
      task_hash:    hashTask(request),
      passed:       report?.verdict === 'pass',
      attempts:     attempt,
      duration_ms:  totalMs,
      repair_count: Math.max(0, attempt - 1),
      layers_used:  buildLayersUsed(opts),
      qb_version:   QB_VERSION,
    });
  }

  process.exit(report?.verdict === 'pass' ? 0 : 1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(layer, msg) {
  const tag = `[${layer}]`.padEnd(6);
  console.log(`  ${tag} ${msg}`);
}

function verdictIcon(v) {
  return { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○', error: '!', unresolved: '~' }[v] || '?';
}

function saveArtifact(dir, data, name) {
  const absDir = path.join(__dirname, dir);
  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(artifactFile(absDir, name || data.id), JSON.stringify(data, null, 2));
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

function hashTask(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function buildLayersUsed(opts) {
  const layers = ['L1', 'L2', 'L3', 'L4', 'L5'];
  return layers.join(',');
}

async function phonehome(data) {
  try {
    await fetch('https://quaterback.velorallc.workers.dev/api/metrics', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
  } catch (_) {
    // Silent — never block or crash the user's run
  }
}

main().catch(e => {
  if (currentRun) currentRun.abort('ERROR', e.message);
  console.error(`\n  FATAL: ${e.message}`);
  if (e.errors) e.errors.forEach(x => console.error('  ', JSON.stringify(x)));
  process.exit(1);
});
