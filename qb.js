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
  .parse(process.argv);

const opts    = program.opts();
const request = program.args[0];

const DIVIDER  = '─'.repeat(72);
const DIVIDER2 = '═'.repeat(72);

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
      process.exit(1);
    }

    log('L1', 'Re-compiling with clarification...');
    contract = await compile(request, null, answer.trim());
  }

  log('L1', `Contract ready  (${Date.now() - t1}ms)`);
  console.log(`     Goal: ${contract.goal}`);
  console.log(`     ACs:  ${contract.acceptance_criteria?.length || 0}`);

  if (opts.save) saveArtifact('intent/contracts', contract);

  // ── Layer 2: Context ───────────────────────────────────────────────────────
  log('L2', 'Context engine...');
  const t2 = Date.now();
  const context = await buildContext(contract, repoPath, {
    noLlm: !opts.llmContext,
  });
  log('L2', `Context ready  (${Date.now() - t2}ms)`);
  console.log(`     ${context.relevant_files.length} files, ${Object.keys(context.symbol_map).length} symbols`);

  if (opts.save) saveArtifact('context/packages', context);

  // ── Repair loop: L3 → L4 ──────────────────────────────────────────────────
  let execution   = null;
  let report      = null;
  let attempt     = 0;
  let repairHints = [];

  while (attempt < maxRetries) {
    attempt++;

    const isRetry = attempt > 1;
    const label   = isRetry ? `L3 Agent (repair attempt ${attempt})` : 'L3 Agent';
    log(isRetry ? 'L3↩' : 'L3', `${label}...`);

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
    log('L4', `Verdict: ${verdictIcon(report.verdict)} ${report.verdict.toUpperCase()}  (${Date.now() - t4}ms)`);

    // Print criteria
    report.criteria_results.forEach(r => {
      const icon = r.met === true ? '✓' : r.met === false ? '✗' : '~';
      console.log(`     ${icon} [${r.id}] ${r.criterion.slice(0, 60)}`);
    });

    if (report.verdict === 'pass') break;
    if (report.verdict === 'no-diff') {
      console.log('\n  ○ No diff to verify — running in dry-run mode.');
      break;
    }

    if (attempt >= maxRetries) {
      console.log(`\n  Reached max retries (${maxRetries}). Needs human review.`);
      break;
    }

    // Prepare repair hints for next attempt
    repairHints = report.repair_hints;
    console.log(`\n  ${report.failures.length} criterion/criteria failed. Retrying with repair hints...\n`);
    report.repair_hints.forEach(h => {
      console.log(`  [${h.criterion_id}] ${h.diagnosis}`);
      console.log(`    → ${h.suggested_fix}\n`);
    });
  }

  if (opts.save && report) saveArtifact('verify/reports', report);

  // ── Final summary ──────────────────────────────────────────────────────────
  const totalMs = Date.now() - totalStart;
  console.log(`\n${DIVIDER2}`);
  console.log(`  RESULT: ${verdictIcon(report?.verdict)} ${(report?.verdict || 'unknown').toUpperCase()}`);
  console.log(`  Attempts: ${attempt} / ${maxRetries}`);
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`);

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

  process.exit(report?.verdict === 'pass' ? 0 : 1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(layer, msg) {
  const tag = `[${layer}]`.padEnd(6);
  console.log(`  ${tag} ${msg}`);
}

function verdictIcon(v) {
  return { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○' }[v] || '?';
}

function saveArtifact(dir, data, name) {
  const absDir = path.join(__dirname, dir);
  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  const filename = name ? `${name}.json` : `${data.id}.json`;
  fs.writeFileSync(path.join(absDir, filename), JSON.stringify(data, null, 2));
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

main().catch(e => {
  console.error(`\n  FATAL: ${e.message}`);
  if (e.errors) e.errors.forEach(x => console.error('  ', JSON.stringify(x)));
  process.exit(1);
});
