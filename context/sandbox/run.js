require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Command } = require('commander');
const path  = require('path');
const fs    = require('fs');
const { buildContext } = require('../builder');

const program = new Command();
program
  .requiredOption('-r, --repo <path>', 'Repo to run against')
  .option('-c, --contract <path>',    'Path to an existing Task Contract JSON (optional — uses built-in demo if omitted)')
  .option('--no-llm',                 'Skip LLM enrichment — DSA only')
  .parse();

const opts = program.opts();

const DIVIDER = '─'.repeat(72);

// Built-in demo contract — simulates what Layer 1 would produce
const DEMO_CONTRACT = {
  id:           'demo-contract-001',
  created_at:   new Date().toISOString(),
  raw_request:  'Add Google login and make sure existing users are not affected.',
  repo_path:    null,
  goal:         'Enable Google OAuth login without altering the existing email signup flow or affecting existing user sessions.',
  required_behavior: [
    'First-time Google users complete the same onboarding flow as email signup users.',
    'Existing users who log in via Google are matched by email and skip onboarding.',
  ],
  constraints: [
    'The existing email signup flow must not change.',
    'Existing user sessions must not be invalidated.',
    'The /auth/callback route must not be altered outside of expected files.',
  ],
  acceptance_criteria: [
    { id: 'AC-1', criterion: 'A new Google user completes onboarding before reaching the dashboard.', met: null },
    { id: 'AC-2', criterion: 'An existing user logging in via Google lands directly on the dashboard.', met: null },
    { id: 'AC-3', criterion: 'Existing email login flow is unaffected.', met: null },
  ],
  verification_plan: [
    'Run existing auth test suite.',
    'Check /auth/callback route is unchanged outside expected files.',
    'Verify new Google users hit onboarding screen.',
  ],
  relevant_context: [],
  ambiguity_flags:  [],
  clarifying_question: null,
};

async function main() {
  let contract = DEMO_CONTRACT;

  if (opts.contract) {
    try {
      contract = JSON.parse(fs.readFileSync(path.resolve(opts.contract), 'utf8'));
    } catch (err) {
      console.error(`  Error reading contract: ${err.message}`);
      process.exit(1);
    }
  }

  const absRepo = path.resolve(opts.repo);
  const usingLlm = opts.llm !== false;

  console.log(`\n${DIVIDER}`);
  console.log(`  CONTEXT ENGINE SANDBOX`);
  console.log(`  Repo:     ${absRepo}`);
  console.log(`  Contract: ${contract.id}`);
  console.log(`  Goal:     ${contract.goal}`);
  console.log(`  LLM:      ${usingLlm ? 'enabled (deepseek-r1:7b)' : 'disabled (DSA only)'}`);
  console.log(DIVIDER);

  const t0 = Date.now();
  let pkg;
  try {
    process.stderr.write('\n  Running DSA passes...\n');
    pkg = await buildContext(contract, absRepo, { noLlm: !usingLlm });
  } catch (err) {
    console.log(`\n  ✗  ERROR: ${err.message}\n`);
    if (err.errors) err.errors.forEach(e => console.log(`     ${e.path.join('.')} — ${e.message}`));
    process.exit(1);
  }
  const ms = Date.now() - t0;

  console.log('\n  PATTERNS DETECTED:\n');
  console.log(`    Language:     ${pkg.patterns.language     || 'unknown'}`);
  console.log(`    Framework:    ${pkg.patterns.framework    || 'unknown'}`);
  console.log(`    Test runner:  ${pkg.patterns.test_runner  || 'unknown'}`);
  console.log(`    Architecture: ${pkg.patterns.architecture || 'unknown'}`);

  console.log(`\n  RELEVANT FILES (${pkg.relevant_files.length}):\n`);
  pkg.relevant_files.slice(0, 10).forEach(f => {
    const syms = f.symbols.length ? `[${f.symbols.slice(0, 4).join(', ')}${f.symbols.length > 4 ? '...' : ''}]` : '';
    const test = f.test_file ? ` → test: ${f.test_file}` : '';
    console.log(`    ${f.path} ${syms}${test}`);
    console.log(`      ${f.reason}`);
  });

  console.log(`\n  SYMBOL MAP (${Object.keys(pkg.symbol_map).length} symbols):\n`);
  Object.entries(pkg.symbol_map).slice(0, 10).forEach(([sym, loc]) => {
    console.log(`    ${sym.padEnd(24)} ${loc}`);
  });

  console.log(`\n  TEST COVERAGE:\n`);
  console.log(`    Covered files:   ${pkg.test_coverage.covered_files.length}`);
  console.log(`    Test files:      ${pkg.test_coverage.test_files.length}`);
  console.log(`    Uncovered files: ${pkg.test_coverage.uncovered_files.length}`);
  pkg.test_coverage.test_files.forEach(t => console.log(`      ${t}`));

  if (pkg.git_context.recent_changes.length > 0) {
    console.log(`\n  GIT ACTIVITY (last 30 days):\n`);
    pkg.git_context.recent_changes.forEach(c => {
      console.log(`    ${c.file.padEnd(40)} ${c.commits} commit(s), last: ${c.last_changed}`);
    });
  }

  if (pkg.agent_brief) {
    console.log(`\n  AGENT BRIEF:\n`);
    console.log(`  ${pkg.agent_brief}\n`);
  }

  console.log(`\n  ✓  [${ms}ms] — ContextPackage generated (id: ${pkg.id})\n`);
  console.log(`${DIVIDER}\n`);
}

main();
