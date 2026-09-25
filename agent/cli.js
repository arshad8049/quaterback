#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { program } = require('commander');
const { orchestrate } = require('./orchestrator');

program
  .name('qb-agent')
  .description('Quarterback Layer 3 — Agent Orchestrator')
  .requiredOption('--contract <path>', 'Path to TaskContract JSON (from Layer 1)')
  .option('--context <path>',  'Path to ContextPackage JSON (from Layer 2)')
  .option('--repo <path>',     'Repo path (defaults to context.repo_path or cwd)')
  .option('--agent <type>',    'Agent to invoke: dry-run | claude-code | manual', 'dry-run')
  .option('--save',            'Save ExecutionResult to agent/executions/{id}.json')
  .parse(process.argv);

const options = program.opts();

async function run() {
  const contract = JSON.parse(fs.readFileSync(path.resolve(options.contract), 'utf8'));
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
    const file = path.join(dir, `${result.id}.json`);
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
