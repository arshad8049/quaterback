// Layer 4 sandbox — run from quaterback/ root:
//   node verify/sandbox/run.js              (uses saved contract + mock diff)
//   node verify/sandbox/run.js --no-llm     (DSA only, instant)
//   node verify/sandbox/run.js --real-diff  (uses actual git diff of this repo)
require('dotenv').config({ path: require('path').join(__dirname, '../../intent/.env') });

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { verify }   = require('../verifier');

const CONTRACT_PATH = path.join(__dirname, '../../intent/contracts/73788344-2720-4569-bb12-201da96710f7.json');
const DIVIDER = '─'.repeat(72);

// ── Mock diff: simulates an agent that partially implemented the task ─────────
// AC-1 (integrate Gemini Flash) → met: true
// AC-2 (compatibility with Anthropic) → met: true
// AC-3 (maintain user flow) → uncertain
// AC-4 (config options) → met: false (agent forgot the config UI)
const MOCK_DIFF = `diff --git a/src/llm.js b/src/llm.js
index a1b2c3d..e4f5g6h 100644
--- a/src/llm.js
+++ b/src/llm.js
@@ -1,8 +1,12 @@
 const Anthropic = require('@anthropic-ai/sdk');
+const { GoogleGenerativeAI } = require('@google/generative-ai');

-function createLLM(provider = 'anthropic') {
+function createLLM(provider = 'anthropic', config = {}) {
   if (provider === 'anthropic') {
     return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
   }
+  if (provider === 'gemini-flash') {
+    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
+    return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
+  }
   throw new Error(\`Unknown provider: \${provider}\`);
 }

+// Maintain backward compatibility — existing callers unaffected
 module.exports = { createLLM };
diff --git a/src/store.js b/src/store.js
index 1234abc..5678def 100644
--- a/src/store.js
+++ b/src/store.js
@@ -14,6 +14,7 @@ const defaults = {
   windowBounds: null,
   provider: 'anthropic',
+  // gemini-flash available as alternative provider
 };
`;

async function run() {
  const args  = process.argv.slice(2);
  const noLlm = args.includes('--no-llm');
  const real  = args.includes('--real-diff');

  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  let diff = MOCK_DIFF;
  if (real) {
    try {
      diff = execSync('git diff HEAD~1', {
        cwd: path.join(__dirname, '../..'),
        encoding: 'utf8',
      });
      if (!diff.trim()) diff = execSync('git diff', { cwd: path.join(__dirname, '../..'), encoding: 'utf8' });
      console.log(`  Using real git diff (${diff.length} chars)\n`);
    } catch (_) {
      console.log('  Could not get real diff, using mock\n');
    }
  }

  // Inject the diff into a mock ExecutionResult
  const execution = {
    id:          'sandbox-exec-001',
    contract_id: contract.id,
    context_id:  null,
    agent_used:  'dry-run',
    status:      'completed',
    duration_ms: 0,
    generated_at: new Date().toISOString(),
    briefing:    '',
    changes:     [
      { file: 'src/llm.js',   additions: 8,  deletions: 1 },
      { file: 'src/store.js', additions: 1,  deletions: 0 },
    ],
    diff,
  };

  console.log(`\n${DIVIDER}`);
  console.log(`  LAYER 4 SANDBOX — VERIFICATION ENGINE`);
  console.log(`  Contract: ${contract.id}`);
  console.log(`  Mode:     ${noLlm ? 'DSA only (--no-llm)' : 'DSA + LLM judgment'}`);
  console.log(`  Diff:     ${real ? 'real git diff' : 'mock diff (partial implementation)'}`);
  console.log(DIVIDER);

  const t0     = Date.now();
  const report = await verify(contract, null, execution, { noLlm });
  const ms     = Date.now() - t0;

  const VERDICT_ICON = { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○' };
  console.log(`\n  VERDICT: ${VERDICT_ICON[report.verdict] || '?'} ${report.verdict.toUpperCase()}  (${ms}ms)\n`);

  console.log(`  ACCEPTANCE CRITERIA:\n`);
  for (const r of report.criteria_results) {
    const icon = r.met === true ? '✓' : r.met === false ? '✗' : '~';
    const met  = r.met === true ? 'MET' : r.met === false ? 'NOT MET' : 'UNCERTAIN';
    console.log(`  ${icon} [${r.id}] ${met}  [${r.method}]`);
    console.log(`    ${r.criterion}`);
    console.log(`    → ${r.evidence}\n`);
  }

  if (report.scope_violations.length) {
    console.log(`  SCOPE VIOLATIONS:`);
    report.scope_violations.forEach(f => console.log(`    ! ${f}`));
    console.log('');
  }

  if (report.repair_hints.length) {
    console.log(`  REPAIR HINTS:\n`);
    report.repair_hints.forEach(h => {
      console.log(`  [${h.criterion_id}] ${h.diagnosis}`);
      console.log(`    Fix: ${h.suggested_fix}\n`);
    });
  }

  console.log(`\n${DIVIDER}\n`);
}

run().catch(e => {
  console.error('ERROR:', e.message);
  if (e.errors) e.errors.forEach(x => console.error(JSON.stringify(x)));
  process.exit(1);
});
