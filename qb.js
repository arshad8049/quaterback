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

const { compileIntent, MAX_ROUNDS } = require('./intent/session');
const { buildContext } = require('./context/builder');
const { orchestrate }  = require('./agent/orchestrator');
const { verify }       = require('./verify/verifier');
const { defaultJudgeCacheDir } = require('./verify/judge-cache');
const memory           = require('./memory');
const runStore         = require('./run/store');
const { artifactFile } = require('./lib/fsafe');
const { inputFromReport } = require('./verify/verdict');
const { contractState, stateReason, approve } = require('./intent/contract-state');
const { loadContractFile, proposalForReview } = require('./intent/contract-file');
const { formatOracle } = require('./intent/oracle-view');
const { routeRepair } = require('./verify/routing');
const { git: gitProc }  = require('./lib/proc');
const { AGENT_VERSION } = require('./lib/sandbox/agent');

/** What the run record names as the agent (QB-38: a pinned decision trail). */
const AGENT_IDENTITY = {
  'claude-code': { type: 'claude-code', version: AGENT_VERSION, isolation: 'sandbox' },
  'dry-run':     { type: 'dry-run',     version: 'builtin',     isolation: 'none' },
  manual:        { type: 'manual',      version: 'human',       isolation: 'none' },
};

// `qb replay <run_id>` / `qb runs` — inspect stored run records.
if (['replay', 'runs', 'show'].includes(process.argv[2])) {
  process.exit(require('./run/cli').main(process.argv.slice(2)));
}
// `qb auth login|logout|status` and `qb patch <run_id>` — sandbox commands (QB-02).
if (['auth', 'patch'].includes(process.argv[2])) {
  require('./lib/sandbox/cli').main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`qb ${process.argv[2]}: ${e.message}`);
    process.exit(1);
  });
  return;
}

const QB_VERSION = '0.1.0';

program
  .name('qb')
  .description('Quarterback — Intent to Verified Result')
  .argument('<request>', 'Natural-language task request')
  .option('--repo <path>',         'Path to the target repository', process.cwd())
  .option('--agent <type>',        'Coding agent: dry-run | claude-code | manual', 'dry-run')
  .option('--max-retries <n>',     'Max repair loop attempts', '3')
  .option('--clarify <answer>',    'Answer to the intent compiler\'s clarifying question; repeat for later rounds (noninteractive runs). Select a choice with <question>=<choice>', (v, prev) => [...prev, v], [])
  .option('--contract-file <path>', 'Use a human-reviewed contract as the test oracle instead of generating one (QB-13)')
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
  console.log(`  Agent:   ${opts.agent}${opts.agent === 'claude-code' ? '  (sandboxed: docs/security/agent-sandbox.md)' : ''}`);
  console.log(`${DIVIDER2}\n`);

  const totalStart = Date.now();

  // ── Run record (QB-38) ────────────────────────────────────────────────────
  const model = process.env.QB_MODEL || 'deepseek-r1:7b';
  // The checkout's HEAD at start (null in a repo without commits); each sandboxed
  // attempt also records the HEAD and trees it actually seeded from.
  const head    = gitProc(['rev-parse', '--verify', '-q', 'HEAD'], repoPath, { allowFail: true });
  const baseSha = head.status === 0 ? String(head.stdout).trim() : null;
  const run = currentRun = runStore.createRun({
    kind:    'qb',
    request,
    repoPath,
    baseSha,
    agent:   AGENT_IDENTITY[opts.agent] || { type: opts.agent, version: null, isolation: null },
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
  // QB-13: a human-reviewed contract file replaces the generated contract entirely.
  let fileContract = null;
  if (opts.contractFile) {
    try { fileContract = loadContractFile(path.resolve(opts.contractFile), request); }
    catch (e) {
      console.log(`\n  ✗ Contract file rejected: ${e.message}\n`);
      run.finish('BLOCKED', { reason: `invalid_contract_file: ${e.message}` });
      process.exitCode = 2;
      return;
    }
    log('L1', `Using the reviewed contract file ${opts.contractFile} (sha256 ${fileContract.sha.slice(0, 12)})`);
  }
  // QB-17: grounded in a repository survey, with bounded clarification rounds.
  // Answers come from --clarify (one per round, in order) or an interactive prompt.
  let contract;
  if (fileContract) contract = fileContract.contract;
  else {
    const showQuestion = (h) => {
      console.log(`\n  ⚠  Ambiguity detected (round ${h.round} of ${h.max_rounds}):\n`);
      (h.ambiguity_flags || []).forEach(f => console.log(`     • ${f}`));
      for (const u of h.unresolved) {
        console.log(`\n  ❓ ${u.question}`);
        if (u.choices.length) console.log(`     Choices: ${(u.options || []).map(o => `${o.label} [--clarify ${u.id}=${o.id}]`).join(' · ') || u.choices.join(' · ')}`);
      }
      console.log('');
    };
    const s = await compileIntent(request, {
      repoPath, answers: opts.clarify || [],
      ask: process.stdin.isTTY ? async (h) => { showQuestion(h); return (await prompt('  Your answer → ')).trim() || null; } : null,
    });
    if (s.survey) run.event('contract.grounding', s.survey);
    if (s.state === 'needs_clarification' || s.state === 'blocked') {
      // Machine-readable handoff: what is still open, the rounds so far, the grounding.
      const file = path.join(run.dir, 'clarification.json');
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      run.event(`contract.${s.state}`, { round: s.round, unresolved: s.unresolved.map(u => u.id), file });
      if (!process.stdin.isTTY || s.state === 'blocked') showQuestion(s);
      if (s.state === 'blocked') {
        console.log(`  Still ambiguous after ${s.max_rounds} clarification rounds. Rephrase the request with that detail.\n`);
        run.finish('BLOCKED', { reason: 'clarification_rounds_exhausted' });
      } else {
        console.log(`  Not answered. Re-run with --clarify "<answer>" for each round so far (${s.round} of at most ${MAX_ROUNDS}).`);
        console.log(`  Handoff state: ${file}\n`);
        run.finish('BLOCKED', { reason: 'needs_clarification' });
      }
      process.exitCode = 2;
      return;
    }
    contract = s.contract;
  }

  // Only a finalized contract may reach the agent or verification.
  const cs = contractState(contract);
  if (cs.state !== 'finalized') {
    console.log(`\n  ✗ The intent compiler produced an unusable contract: ${(cs.errors || [cs.question]).join('; ')}\n`);
    run.event('contract.invalid', { errors: cs.errors || [] });
    run.finish('BLOCKED', { reason: stateReason(cs) });
    process.exitCode = 2;
    return;
  }

  log('L1', `Contract ready  (${Date.now() - t1}ms)`);
  console.log(`     Goal: ${contract.goal}`);
  console.log(`     ACs:  ${contract.acceptance_criteria?.length || 0}`);

  // ── QB-13: the test oracle must be approved by a human, then it is frozen ──
  // (approval records the contract hash; any later change voids it). A dry run
  // verifies nothing and needs no oracle.
  if (opts.agent !== 'dry-run') {
    if (fileContract) {
      contract = fileContract.approved();
    } else {
      printOracle(contract);
      if (process.stdin.isTTY) {
        const ok = (await prompt('  Approve this contract as the test oracle? [y/N] ')).trim().toLowerCase();
        if (ok !== 'y' && ok !== 'yes') {
          run.finish('BLOCKED', { reason: 'contract_not_approved' });
          console.log('\n  Not approved. Nothing was run.\n');
          process.exitCode = 2;
          return;
        }
        contract = approve(contract, { via: 'interactive' });
      } else {
        const file = path.join(run.dir, 'proposed-contract.json');
        fs.writeFileSync(file, JSON.stringify(proposalForReview(contract), null, 2) + '\n', { mode: 0o600 });
        run.event('contract.needs_approval', { file });
        run.finish('BLOCKED', { reason: 'needs_contract_approval' });
        console.log(`\n  The test oracle needs a human's approval before anything runs.`);
        console.log(`  Review (and edit if needed): ${file}`);
        console.log(`  Then run again with: --contract-file "${file}"\n`);
        process.exitCode = 2;
        return;
      }
    }
    log('L1', `Oracle approved (${contract.approval.via}); frozen as ${contract.approval.contract_hash.slice(0, 12)}`);
  }

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
  let previousPatch;                 // QB-10: no-progress detection across attempts
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
      base_sha:       baseSha,
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

    // A blocked sandbox (Docker unavailable, unsupported project, auth not ready)
    // never reaches verification: the run ends BLOCKED with the reason.
    if (execution.status === 'blocked') {
      console.log(`\n  ✗ Blocked: ${execution.error}`);
      run.event('sandbox.blocked', { reason: execution.error, sandbox: execution.sandbox || null });
      run.finish('BLOCKED', { reason: execution.error });
      process.exitCode = 2;
      return;
    }
    if (execution.sandbox?.run_id) run.event('sandbox.run', { sandbox: execution.sandbox });

    // ── Layer 4: Verify ──────────────────────────────────────────────────────
    log('L4', 'Verification...');
    const t4 = Date.now();
    report = await verify(contract, context, execution, {
      noLlm:    !opts.llmVerify,
      repoPath,
      judgeCache: defaultJudgeCacheDir(),   // QB-15: an unchanged patch is never re-sampled into a pass
    });
    run.finishAttempt(attempt, {
      execution,
      report,
      patch:       execution.diff,
      verifyInput: inputFromReport(report, execution),
      checks:      runStore.checksFor(attempt, execution),
    });
    // Exact patch bytes and touched-path baseline for `qb patch` (QB-02 §9.3).
    if (execution.patch_raw) run.artifact(`a${attempt}-patch-raw`, execution.patch_raw, { ext: 'bin' });
    if (execution.base_listing) run.artifact(`a${attempt}-base-ls`, execution.base_listing, { ext: 'bin' });
    log('L4', `Verdict: ${verdictIcon(report.verdict)} ${report.verdict.toUpperCase()}  (${Date.now() - t4}ms)`);

    // Print criteria
    report.criteria_results.forEach(r => {
      const icon = r.met === true ? '✓' : r.met === false ? '✗' : '~';
      const voteStr = r.votes
        ? ` [${r.votes.map(v => v === true ? 'T' : v === false ? 'F' : '?').join('/')}]`
        : '';
      console.log(`     ${icon} [${r.id}]${voteStr} ${r.criterion.slice(0, 56)}`);
    });

    if (report.verdict === 'pass') {
      if (execution.status === 'no_change') console.log('\n  ✓ Already satisfied: the agent changed nothing, and the tests and independent judge confirm the requirement.');
      break;
    }
    // QB-10: one routing decision (shared with the benchmark): repair only with
    // concrete actions, never code-repair an environment problem, stop on no progress.
    const route = routeRepair(report, { patch: execution.diff, previousPatch: attempt > 1 ? previousPatch : undefined });
    previousPatch = execution.diff;
    run.event('attempt.routed', { attempt, action: route.action, reason: route.reason });
    if (route.action === 'environment') {
      console.log(`\n  ✗ ${route.reason}`);
      if (execution.changes.length) console.log('    Partial changes were captured in the run record for inspection.');
      break;
    }
    if (route.action === 'stop') {
      if (report.verdict === 'no-diff') console.log('\n  ○ No diff to verify — running in dry-run mode.');
      else if (report.verdict === 'unresolved' && execution.status === 'no_change') console.log('\n  ~ Agent changed nothing — requirement not independently verified.');
      else console.log(`\n  ~ Stopping: ${route.reason}.`);
      if (report.test_outcome?.preexisting?.length) console.log(`    ${report.test_outcome.preexisting.length} test(s) were already failing before this change (still listed in the report).`);
      break;
    }

    if (attempt >= maxRetries) {
      console.log(`\n  Reached max retries (${maxRetries}). Needs human review.`);
      break;
    }

    // Prepare repair hints for next attempt
    repairHints = route.hints;
    console.log(`\n  ${route.reason} — retrying with repair hints...\n`);
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

/** What a human approves as the test oracle (QB-13): everything the approval covers. */
function printOracle(contract) { console.log(formatOracle(contract)); }

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
