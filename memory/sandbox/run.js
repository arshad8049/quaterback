/**
 * memory/sandbox/run.js — Layer 5 demo
 *
 * Simulates 4 past pipeline runs for a fake repo, then exercises:
 *   - recallFiles()   — which files should we look at for a new task?
 *   - recallRepairs() — any prior fixes for similar failing criteria?
 *   - recallPrior()   — have we done something like this before?
 *   - stats()         — memory summary
 */

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { remember, recallFiles, recallRepairs, recallPrior, stats } = require('..');

// Use a temp dir so sandbox never pollutes real memory
process.env.QB_MEMORY_DIR = path.join(os.tmpdir(), 'qb-memory-sandbox');

const REPO = '/sandbox/fake-app';
const DIVIDER = '─'.repeat(68);

// ── Seed data: 4 past runs ─────────────────────────────────────────────────────

const pastRuns = [
  {
    contract: {
      id:   'c-001',
      goal: 'Add Gemini Flash as a second LLM provider alongside Anthropic',
      raw_request: 'Add Gemini Flash as a second LLM provider',
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'Gemini Flash provider initialises without errors' },
        { id: 'AC-2', criterion: 'Existing Anthropic provider remains unchanged' },
      ],
    },
    report: {
      verdict:      'pass',
      attempts:     2,
      repair_hints: [
        {
          criterion_id: 'AC-1',
          diagnosis:    'createLLM() in src/llm.js has no gemini case in provider switch',
          suggested_fix: 'In src/llm.js add a gemini case to createLLM() that initialises the GoogleGenerativeAI client',
        },
      ],
    },
    execution: {
      duration_ms: 82000,
      changes: [
        { file: 'src/llm.js',    additions: 48, deletions: 2 },
        { file: 'src/config.js', additions: 12, deletions: 0 },
      ],
    },
  },
  {
    contract: {
      id:   'c-002',
      goal: 'Fix the STT transcription error when no API key is set',
      raw_request: 'Fix STT error on missing key',
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'User sees a clear error message when STT key is missing' },
        { id: 'AC-2', criterion: 'App does not crash when STT is unavailable' },
      ],
    },
    report: { verdict: 'pass', attempts: 1, repair_hints: [] },
    execution: {
      duration_ms: 31000,
      changes: [
        { file: 'src/stt.js',  additions: 14, deletions: 3 },
        { file: 'main.js',     additions:  5, deletions: 1 },
      ],
    },
  },
  {
    contract: {
      id:   'c-003',
      goal: 'Add OpenAI Whisper as an STT provider option',
      raw_request: 'Support Whisper STT',
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'Whisper STT provider available in settings dropdown' },
        { id: 'AC-2', criterion: 'Transcription works end-to-end with Whisper key' },
      ],
    },
    report: { verdict: 'pass', attempts: 1, repair_hints: [] },
    execution: {
      duration_ms: 56000,
      changes: [
        { file: 'src/stt.js',    additions: 62, deletions: 5 },
        { file: 'src/config.js', additions:  8, deletions: 0 },
        { file: 'renderer/settings.html', additions: 20, deletions: 3 },
      ],
    },
  },
  {
    contract: {
      id:   'c-004',
      goal: 'Refactor the VAD module to extract shared audio utilities',
      raw_request: 'Refactor VAD module',
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'Shared audio utilities extracted to src/audio-utils.js' },
        { id: 'AC-2', criterion: 'No regressions in VAD behaviour' },
      ],
    },
    report: { verdict: 'fail', attempts: 3, repair_hints: [] },
    execution: {
      duration_ms: 140000,
      changes: [
        { file: 'src/vad.js',         additions: 10, deletions: 55 },
        { file: 'src/audio-utils.js',  additions: 70, deletions: 0 },
      ],
    },
  },
];

async function main() {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  QUARTERBACK — Layer 5 Memory Sandbox`);
  console.log(`  Memory dir: ${process.env.QB_MEMORY_DIR}`);
  console.log(`${'═'.repeat(68)}\n`);

  // ── 1. Write past runs ─────────────────────────────────────────────────────
  console.log('  Writing 4 past runs...\n');
  for (const run of pastRuns) {
    await remember(REPO, run.contract, run.report, run.execution);
    const icon = run.report.verdict === 'pass' ? '✓' : '✗';
    console.log(`  ${icon} [${run.contract.id}] ${run.contract.goal.slice(0, 55)}`);
  }

  // ── 2. recallFiles — "Add ElevenLabs TTS provider" ───────────────────────
  const newGoal1 = 'Add ElevenLabs TTS as a new audio provider option';
  console.log(`\n${DIVIDER}`);
  console.log(`  recallFiles() for: "${newGoal1}"`);
  console.log(DIVIDER);
  const fileHints = recallFiles(REPO, newGoal1);
  if (fileHints.length) {
    fileHints.forEach(h =>
      console.log(`  • ${h.file.padEnd(38)} score=${h.score.toFixed(3)}  ${h.reason}`)
    );
  } else {
    console.log('  (no matches above threshold)');
  }

  // ── 3. recallFiles — "Refactor VAD to use AudioContext" ──────────────────
  const newGoal2 = 'Refactor VAD to use AudioContext API instead of ring buffer';
  console.log(`\n${DIVIDER}`);
  console.log(`  recallFiles() for: "${newGoal2}"`);
  console.log(DIVIDER);
  const fileHints2 = recallFiles(REPO, newGoal2);
  if (fileHints2.length) {
    fileHints2.forEach(h =>
      console.log(`  • ${h.file.padEnd(38)} score=${h.score.toFixed(3)}  ${h.reason}`)
    );
  } else {
    console.log('  (no matches above threshold)');
  }

  // ── 4. recallRepairs — "Integrate Claude provider" ───────────────────────
  const newCriteria = [
    { id: 'AC-1', criterion: 'Claude provider initialises and creates client without errors' },
    { id: 'AC-2', criterion: 'Existing provider selection remains backward compatible' },
  ];
  console.log(`\n${DIVIDER}`);
  console.log(`  recallRepairs() for new task criteria:`);
  console.log(DIVIDER);
  const repairs = recallRepairs(REPO, newCriteria);
  if (repairs.length) {
    repairs.forEach(r => {
      console.log(`  [${r.criterion_id}] score=${r.score.toFixed(3)}`);
      console.log(`    Diagnosis: ${r.diagnosis.slice(0, 80)}`);
      console.log(`    Fix:       ${r.fix.slice(0, 80)}\n`);
    });
  } else {
    console.log('  (no repair hints above threshold)');
  }

  // ── 5. recallPrior — "Add Cohere LLM provider" ───────────────────────────
  const newGoal3 = 'Add Cohere Command R as a third LLM provider';
  console.log(`\n${DIVIDER}`);
  console.log(`  recallPrior() for: "${newGoal3}"`);
  console.log(DIVIDER);
  const priors = recallPrior(REPO, newGoal3);
  if (priors.length) {
    priors.forEach(p => {
      const icon = p.verdict === 'pass' ? '✓' : '✗';
      console.log(`  ${icon} score=${p.score.toFixed(3)} [${p.contract_id}] ${p.goal.slice(0, 60)}`);
      console.log(`    changed: ${p.changed_files.join(', ')} | ${p.attempts} attempt(s)`);
    });
  } else {
    console.log('  (no similar prior runs)');
  }

  // ── 6. stats ──────────────────────────────────────────────────────────────
  const s = stats(REPO);
  console.log(`\n${DIVIDER}`);
  console.log(`  Memory stats for repo`);
  console.log(DIVIDER);
  console.log(`  Total runs:    ${s.total_runs}`);
  console.log(`  Passes:        ${s.passes}`);
  console.log(`  Fails:         ${s.fails}`);
  console.log(`  Repairs saved: ${s.repairs_saved}`);
  console.log(`  Files tracked: ${s.files_tracked}`);
  console.log(`  Memory dir:    ${s.memory_dir}`);
  console.log(`\n${'═'.repeat(68)}\n`);

  // Cleanup sandbox temp dir
  fs.rmSync(process.env.QB_MEMORY_DIR, { recursive: true, force: true });
}

main().catch(e => {
  console.error('  FATAL:', e.message);
  process.exit(1);
});
