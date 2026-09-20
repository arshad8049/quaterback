require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Command } = require('commander');
const { compile } = require('../compiler');

const program = new Command();
program
  .option('--all', 'Run all fixtures')
  .option('--fixture <n>', 'Run a single fixture by id (1–5)')
  .parse();

const opts = program.opts();
const fixtures = require('./fixtures/requests.json');

const DIVIDER = '─'.repeat(72);

async function runFixture(f) {
  console.log(`\n${DIVIDER}`);
  console.log(`  [${f.id}] ${f.label.toUpperCase()}`);
  console.log(`  ${f.description}`);
  console.log(`\n  REQUEST: "${f.request}"`);
  console.log(DIVIDER);

  const t0 = Date.now();
  try {
    const result = await compile(f.request);
    const ms = Date.now() - t0;

    if (result.clarifying_question) {
      // Compiler asked a question — that's valid output for ambiguous fixtures
      console.log('\n  ⚠  Clarifying question raised (ambiguity detected):\n');
      result.ambiguity_flags.forEach(flag => console.log(`     • ${flag}`));
      console.log(`\n  ❓ ${result.clarifying_question}`);
      console.log(`\n  ✓  [${ms}ms] — expected for ambiguous fixture\n`);
    } else {
      // Full contract returned
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
      if (result.ambiguity_flags.length > 0) {
        console.log(`\n  Ambiguity flags:`);
        result.ambiguity_flags.forEach(f => console.log(`    • ${f}`));
      }
      console.log(`\n  ✓  [${ms}ms] — full contract produced\n`);
    }
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`\n  ✗  [${ms}ms] ERROR: ${err.message}\n`);
    if (err.errors) {
      err.errors.forEach(e => console.log(`     Schema: ${e.path.join('.')} — ${e.message}`));
    }
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n  Error: ANTHROPIC_API_KEY not set. Create intent/.env from .env.example.\n');
    process.exit(1);
  }

  if (opts.fixture) {
    const n = parseInt(opts.fixture, 10);
    const f = fixtures.find(x => x.id === n);
    if (!f) {
      console.error(`  No fixture with id ${n}. Available: 1–${fixtures.length}`);
      process.exit(1);
    }
    await runFixture(f);
  } else if (opts.all) {
    for (const f of fixtures) {
      await runFixture(f);
    }
  } else {
    console.error('\n  Usage: node sandbox/run.js --all  |  --fixture <1-5>\n');
    process.exit(1);
  }

  console.log(`\n${DIVIDER}\n`);
}

main();
