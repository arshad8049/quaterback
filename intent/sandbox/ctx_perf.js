// One-shot Layer 2 performance test — run from intent/ directory
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { buildContext } = require('../../context/builder');

const CUE_REPO = '/Users/Arshad_1/Desktop/Start/projects/cue';

const contract = {
  id: 'perf-test-001',
  created_at: new Date().toISOString(),
  raw_request: 'Add Gemini Flash as a second LLM provider',
  goal: 'Add Google Gemini Flash as an alternative LLM provider users can switch to.',
  required_behavior: [
    'LLM module routes to Gemini Flash when selected.',
    'Existing Anthropic/OpenAI providers continue working unchanged.'
  ],
  constraints: [
    'Existing LLM interface must not change — other modules call it the same way.',
    'Do not touch the STT or screen capture modules.'
  ],
  acceptance_criteria: [
    { id: 'AC-1', criterion: 'Gemini Flash returns a response when selected.', met: null },
    { id: 'AC-2', criterion: 'Switching back to original provider works.', met: null }
  ],
  verification_plan: ['Run existing test suite.', 'Check store.js for provider persistence.'],
  relevant_context: ['src/llm.js', 'src/store.js'],
  ambiguity_flags: [],
  clarifying_question: null
};

const DIVIDER = '─'.repeat(72);

async function run() {
  const noLlm = process.argv.includes('--no-llm');

  console.log(`\n${DIVIDER}`);
  console.log(`  LAYER 2 PERFORMANCE TEST`);
  console.log(`  Repo:    ${CUE_REPO}`);
  console.log(`  Mode:    ${noLlm ? 'DSA only' : 'DSA + LLM enrichment'}`);
  console.log(DIVIDER);

  const t0 = Date.now();
  const pkg = await buildContext(contract, CUE_REPO, { noLlm });
  const ms = Date.now() - t0;

  console.log(`\n  TIME: ${ms}ms\n`);

  console.log('  PATTERNS DETECTED:');
  console.log(`    language:     ${pkg.patterns.language     || 'unknown'}`);
  console.log(`    framework:    ${pkg.patterns.framework    || 'unknown'}`);
  console.log(`    test runner:  ${pkg.patterns.test_runner  || 'unknown'}`);
  console.log(`    architecture: ${pkg.patterns.architecture || 'unknown'}`);

  console.log(`\n  RELEVANT FILES (${pkg.relevant_files.length}):`);
  pkg.relevant_files.forEach(f => {
    const syms = f.symbols.length ? ` [${f.symbols.slice(0,5).join(', ')}]` : '';
    console.log(`\n    ${f.path}${syms}`);
    console.log(`    reason:  ${f.reason}`);
    if (f.test_file) console.log(`    test  →  ${f.test_file}`);
  });

  console.log(`\n  SYMBOL MAP (${Object.keys(pkg.symbol_map).length} symbols):`);
  Object.entries(pkg.symbol_map).slice(0, 15).forEach(([k, v]) => {
    console.log(`    ${k.padEnd(30)} ${v}`);
  });

  console.log('\n  TEST COVERAGE:');
  console.log(`    test files: ${JSON.stringify(pkg.test_coverage.test_files)}`);
  console.log(`    covered:    ${JSON.stringify(pkg.test_coverage.covered_files)}`);
  console.log(`    uncovered:  ${JSON.stringify(pkg.test_coverage.uncovered_files)}`);

  if (pkg.git_context.recent_changes.length) {
    console.log('\n  GIT ACTIVITY (last 30 days):');
    pkg.git_context.recent_changes.forEach(c => {
      console.log(`    ${c.file.padEnd(36)} ${c.commits} commit(s), last: ${c.last_changed}`);
    });
  }

  if (pkg.agent_brief) {
    console.log('\n  AGENT BRIEF:');
    console.log(`  ${pkg.agent_brief}`);
  }

  console.log(`\n${DIVIDER}\n`);
}

run().catch(e => {
  console.error('  ERROR:', e.message);
  if (e.errors) e.errors.forEach(x => console.error('  ', JSON.stringify(x)));
  process.exit(1);
});
