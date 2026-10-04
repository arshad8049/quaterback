#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { artifactFile } = require('../lib/fsafe');
const { program } = require('commander');
const { orchestrate } = require('./orchestrator');
const { executionGate } = require('./runner');
const { approve } = require('../intent/contract-state');
const { formatOracle } = require('../intent/oracle-view');

program
  .name('qb-agent')
  .description('Quarterback Layer 3 — Agent Orchestrator')
  .requiredOption('--contract <path>', 'Path to TaskContract JSON (from Layer 1)')
  .option('--context <path>',  'Path to ContextPackage JSON (from Layer 2)')
  .option('--repo <path>',     'Repo path (defaults to context.repo_path or cwd)')
  .option('--agent <type>',    'Agent to invoke: dry-run | claude-code | manual', 'dry-run')
  .option('--save',            'Save ExecutionResult to agent/executions/{id}.json')
  .option('--approve-contract',  'I reviewed this contract and approve it as the test oracle (QB-13; required for non-dry-run agents)')
  .parse(process.argv);

const options = program.opts();

async function run() {
  let contract = JSON.parse(fs.readFileSync(path.resolve(options.contract), 'utf8'));
  // QB-13: a non-dry-run agent needs a human-approved oracle. An approval field in
  // the file is ignored (anyone can compute a hash); the user approves explicitly.
  delete contract.approval;
  if (options.agent !== 'dry-run' && options.approveContract) {
    console.log(formatOracle(contract));
    contract = approve(contract, { via: 'agent-cli' });
  }
  const gate = executionGate(contract, { agent: options.agent });
  if (gate) {
    console.error(`\n  ✗ ${gate}. Review the contract, then rerun with --approve-contract (or approve it in qb).\n`);
    process.exitCode = 2;
    return;
  }
  const context  = options.context
    ? JSON.parse(fs.readFileSync(path.resolve(options.context), 'utf8'))
    : null;

  const repoPath = options.repo
    || context?.repo_path
    || process.cwd();

  const DIVIDER = '─'.repeat(72);

  console.log(`\n${DIVIDER}`);
  console.log(`  LAYER 3 — AGENT ORCHESTRATOR`);
  console.log(`  Contract: ${contract.id}`);
  console.log(`  Context:  ${context?.id || 'none'}`);
  console.log(`  Agent:    ${options.agent}`);
  console.log(`  Repo:     ${repoPath}`);
  console.log(DIVIDER);

  const t0 = Date.now();
  const result = await orchestrate(contract, context, {
    agent:    options.agent,
    repoPath,
  });
  const ms = Date.now() - t0;

  console.log(`\n  STATUS:   ${result.status.toUpperCase()}`);
  console.log(`  TIME:     ${ms}ms`);

  if (options.agent === 'dry-run' || options.agent === 'manual') {
    console.log(`\n${DIVIDER}`);
    console.log('  AGENT BRIEFING\n');
    console.log(result.briefing);
    console.log(DIVIDER);
  }

  if (result.changes.length) {
    console.log(`\n  CHANGES (${result.changes.length} files):`);
    result.changes.forEach(c => {
      console.log(`    ${c.file.padEnd(40)} +${c.additions} -${c.deletions}`);
    });
  }

  if (result.error) {
    console.error(`\n  ERROR: ${result.error}`);
  }

  if (options.save) {
    const dir = path.join(__dirname, 'executions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = artifactFile(dir, result.id);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`\n  Saved → agent/executions/${result.id}.json`);
  }

  console.log(`\n${DIVIDER}\n`);
}

run().catch(e => {
  console.error('  ERROR:', e.message);
  if (e.errors) e.errors.forEach(x => console.error('  ', JSON.stringify(x)));
  process.exit(1);
});
