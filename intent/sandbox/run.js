require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Command } = require('commander');
const path = require('path');
const { compile } = require('../compiler');
const { buildContext } = require('../context');

const program = new Command();
program
  .option('--all', 'Run all fixtures')
  .option('--fixture <n>', 'Run a single fixture by id (1–6)')
  .option('--repo <path>', 'Path to a real repo — injects file tree + relevant snippets into every fixture')
  .parse();

const opts = program.opts();
const fixtures = require('./fixtures/requests.json');

const DIVIDER  = '─'.repeat(72);
const DIVIDER2 = '═'.repeat(72);

async function runFixture(f, repoContext) {
  const isFullLoop = Boolean(f.clarification);

  console.log(`\n${isFullLoop ? DIVIDER2 : DIVIDER}`);
  console.log(`  [${f.id}] ${f.label.toUpperCase()}${isFullLoop ? '  ◀  FULL PIPELINE DEMO' : ''}`);
  console.log(`  ${f.description}`);
  console.log(`\n  REQUEST: "${f.request}"`);
  if (repoContext) console.log(`  (running with repo context)`);
  console.log(isFullLoop ? DIVIDER2 : DIVIDER);

  if (isFullLoop) {
    await runFullLoop(f, repoContext);
  } else {
    await runSingle(f, repoContext);
  }
}

async function runSingle(f, repoContext) {
  const t0 = Date.now();
  try {
    const result = await compile(f.request, repoContext);
    const ms = Date.now() - t0;

    if (result.clarifying_question) {
      console.log('\n  ⚠  Clarifying question raised (ambiguity detected):\n');
      result.ambiguity_flags.forEach(flag => console.log(`     • ${flag}`));
      console.log(`\n  ❓ ${result.clarifying_question}`);
      console.log(`\n  ✓  [${ms}ms] — expected for ambiguous fixture\n`);
    } else {
      printContract(result, ms);
    }
  } catch (err) {
    printError(err, Date.now() - Date.now());
  }
}

async function runFullLoop(f, repoContext) {
  // Step 1: vague request in
  console.log('\n  STEP 1 — vague request enters the compiler\n');
  let t0 = Date.now();
  let step1;
  try {
    step1 = await compile(f.request, repoContext);
  } catch (err) {
    return printError(err, Date.now() - t0);
  }
  const ms1 = Date.now() - t0;

  if (!step1.clarifying_question) {
    console.log(`  (no ambiguity detected in ${ms1}ms — skipping clarification step)\n`);
    printContract(step1, ms1);
    return;
  }

  // Show the ambiguity catch
  console.log(`  ⚠  Ambiguity caught [${ms1}ms]:\n`);
  step1.ambiguity_flags.forEach(flag => console.log(`     • ${flag}`));
  console.log(`\n  ❓ ${step1.clarifying_question}`);

  // Step 2: clarification provided
  console.log(`\n${DIVIDER}`);
  console.log('\n  STEP 2 — developer answers the clarifying question\n');
  console.log(`  CLARIFICATION: "${f.clarification}"\n`);
  console.log(DIVIDER);

  // Step 3: re-compile with clarification → full contract
  console.log('\n  STEP 3 — compiler runs again with full context\n');
  t0 = Date.now();
  let result;
  try {
    result = await compile(f.request, repoContext, f.clarification);
  } catch (err) {
    return printError(err, Date.now() - t0);
  }
  const ms3 = Date.now() - t0;

  if (result.clarifying_question) {
    console.log(`  ⚠  Still ambiguous after clarification [${ms3}ms] — check the clarification text\n`);
    console.log(`  ❓ ${result.clarifying_question}\n`);
    return;
  }

  printContract(result, ms3);
  console.log(`  ↑ vague request → clarify → full contract in ${ms1 + ms3}ms total\n`);
}

function printContract(result, ms) {
  console.log('\n  CONTRACT:\n');
  console.log(`  Goal: ${result.goal}`);
  console.log(`\n  Required behavior (${result.required_behavior.length}):`);
  result.required_behavior.forEach((b, i) => console.log(`    ${i + 1}. ${b}`));
  console.log(`\n  Constraints (${result.constraints.length}):`);
  result.constraints.forEach((c, i) => console.log(`    ${i + 1}. ${c}`));
  console.log(`\n  Acceptance criteria (${result.acceptance_criteria.length}):`);
  result.acceptance_criteria.forEach(c => console.log(`    [${c.id}] ${c.criterion}`));
  console.log(`\n  Verification plan (${result.verification_plan.length}):`);
  result.verification_plan.forEach((v, i) => console.log(`    ${i + 1}. ${v}`));
  if (result.ambiguity_flags && result.ambiguity_flags.length > 0) {
    console.log(`\n  Ambiguity flags:`);
    result.ambiguity_flags.forEach(f => console.log(`    • ${f}`));
  }
  console.log(`\n  ✓  [${ms}ms] — full contract produced\n`);
}

function printError(err, ms) {
  console.log(`\n  ✗  [${ms}ms] ERROR: ${err.message}\n`);
  if (err.errors) {
    err.errors.forEach(e => console.log(`     Schema: ${e.path.join('.')} — ${e.message}`));
  }
}

async function main() {
  // Build repo context once and share across all fixtures
  let repoContext = null;
  if (opts.repo) {
    const absRepo = path.resolve(opts.repo);
    process.stderr.write(`\n  Loading repo context from: ${absRepo}\n`);
    try {
      // Use a generic request for the tree walk — each fixture refines relevance scoring
      repoContext = buildContext(absRepo, 'code feature bug fix refactor');
      process.stderr.write(`  Context loaded (${repoContext.length} chars)\n\n`);
    } catch (err) {
      console.error(`  Failed to load repo context: ${err.message}`);
      process.exit(1);
    }
  }

  if (opts.fixture) {
    const n = parseInt(opts.fixture, 10);
    const f = fixtures.find(x => x.id === n);
    if (!f) {
      console.error(`  No fixture with id ${n}. Available: 1–${fixtures.length}`);
      process.exit(1);
    }
    await runFixture(f, repoContext);
  } else if (opts.all) {
    for (const f of fixtures) {
      await runFixture(f, repoContext);
    }
  } else {
    console.error('\n  Usage: node sandbox/run.js --all  |  --fixture <1-6>  [--repo <path>]\n');
    process.exit(1);
  }

  console.log(`\n${DIVIDER}\n`);
}

main();
