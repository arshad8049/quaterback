#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { program } = require('commander');
const { verify } = require('./verifier');

program
  .name('qb-verify')
  .description('Quarterback Layer 4 — Verification Engine')
  .requiredOption('--contract <path>',  'Path to TaskContract JSON (from Layer 1)')
  .option('--context <path>',           'Path to ContextPackage JSON (from Layer 2)')
  .option('--execution <path>',         'Path to ExecutionResult JSON (from Layer 3)')
  .option('--repo <path>',              'Repo path for running tests')
  .option('--no-llm',                   'Skip LLM judgment — DSA checks only')
  .option('--save',                     'Save VerificationReport to verify/reports/{id}.json')
  .parse(process.argv);

const opts = program.opts();

async function run() {
  const contract  = JSON.parse(fs.readFileSync(path.resolve(opts.contract), 'utf8'));
  const context   = opts.context   ? JSON.parse(fs.readFileSync(path.resolve(opts.context),   'utf8')) : null;
  const execution = opts.execution ? JSON.parse(fs.readFileSync(path.resolve(opts.execution), 'utf8')) : null;

  const DIVIDER = '─'.repeat(72);
  const noLlm = opts.noLlm === true || opts.noLlm === 'true';

  console.log(`\n${DIVIDER}`);
  console.log(`  LAYER 4 — VERIFICATION ENGINE`);
  console.log(`  Contract:  ${contract.id}`);
  console.log(`  Execution: ${execution?.id || 'none'}`);
  console.log(`  Mode:      ${noLlm ? 'DSA only' : 'DSA + LLM judgment'}`);
  console.log(DIVIDER);

  const t0     = Date.now();
  const report = await verify(contract, context, execution, {
    noLlm:    noLlm,
    repoPath: opts.repo || context?.repo_path || execution?.repo_path,
  });
  const ms = Date.now() - t0;

  // ── Print verdict ──────────────────────────────────────────────────────────
  const VERDICT_ICON = { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○' };
  console.log(`\n  VERDICT: ${VERDICT_ICON[report.verdict] || '?'} ${report.verdict.toUpperCase()}  (${ms}ms)\n`);

  // Criteria results
  console.log(`  ACCEPTANCE CRITERIA (${report.criteria_results.length}):\n`);
  for (const r of report.criteria_results) {
    const icon = r.met === true ? '✓' : r.met === false ? '✗' : '~';
    const met  = r.met === true ? 'MET' : r.met === false ? 'NOT MET' : 'UNCERTAIN';
    console.log(`  ${icon} [${r.id}] ${met}  [${r.method}]`);
    console.log(`    ${r.criterion}`);
    console.log(`    → ${r.evidence}\n`);
  }

  // Test results
  if (report.test_results) {
    const t = report.test_results;
    console.log(`  TEST RESULTS: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped\n`);
  }

  // Scope violations
  if (report.scope_violations.length) {
    console.log(`  SCOPE VIOLATIONS (files modified outside relevant set):`);
    report.scope_violations.forEach(f => console.log(`    ! ${f}`));
    console.log('');
  }

  // Repair hints
  if (report.repair_hints.length) {
    console.log(`  REPAIR HINTS:\n`);
    report.repair_hints.forEach(h => {
      console.log(`  [${h.criterion_id}] ${h.diagnosis}`);
      console.log(`    Fix: ${h.suggested_fix}\n`);
    });
  }

  if (opts.save) {
    const dir = path.join(__dirname, 'reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.id}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`  Saved → verify/reports/${report.id}.json`);
  }

  console.log(`\n${DIVIDER}\n`);
  process.exit(report.verdict === 'fail' ? 1 : 0);
}

run().catch(e => {
  console.error('  ERROR:', e.message);
  if (e.errors) e.errors.forEach(x => console.error('  ', JSON.stringify(x)));
  process.exit(1);
});
