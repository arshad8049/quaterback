// Layer 3 sandbox — run from quaterback/ root:
//   node agent/sandbox/run.js
//   node agent/sandbox/run.js --contract <path> --context <path>
//   node agent/sandbox/run.js --live  (chains Layers 1+2+3 against the cue repo)
require('dotenv').config({ path: require('path').join(__dirname, '../../intent/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../context/.env') });

const fs      = require('fs');
const path    = require('path');
const { buildBriefing } = require('../briefing');

// ── Defaults: use the real contract + context we generated earlier ────────────
const DEFAULT_CONTRACT = path.join(__dirname, '../../intent/contracts/73788344-2720-4569-bb12-201da96710f7.json');
const DEFAULT_CONTEXT  = path.join(__dirname, '../../context/packages/0f8a3031-769e-46a4-81bf-bc3eb1f5d23f.json');

const DIVIDER = '─'.repeat(72);

async function run() {
  const args = process.argv.slice(2);
  const contractPath = argVal(args, '--contract') || DEFAULT_CONTRACT;
  const contextPath  = argVal(args, '--context')  || DEFAULT_CONTEXT;
  const live         = args.includes('--live');

  let contract, context;

  if (live) {
    // Full live chain: Layer 1 → Layer 2 → Layer 3
    await runLiveChain();
    return;
  }

  contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  context  = contextPath && fs.existsSync(contextPath)
    ? JSON.parse(fs.readFileSync(contextPath, 'utf8'))
    : null;

  console.log(`\n${DIVIDER}`);
  console.log(`  LAYER 3 SANDBOX — BRIEFING BUILDER`);
  console.log(`  Contract: ${contract.id}`);
  console.log(`  Context:  ${context?.id || 'none (no context package)'}`);
  console.log(DIVIDER);

  const t0 = Date.now();
  const briefing = buildBriefing(contract, context);
  const ms = Date.now() - t0;

  console.log(`\n  BRIEFING built in ${ms}ms (pure DSA)\n`);
  console.log(DIVIDER);
  console.log(briefing);
  console.log(DIVIDER);
  console.log(`\n  Lines: ${briefing.split('\n').length}  |  Chars: ${briefing.length}`);

  if (!context) {
    console.log('\n  TIP: run with a context package for full symbol map + file intelligence:');
    console.log(`  node agent/sandbox/run.js --context context/packages/<id>.json`);
  }

  console.log(`\n${DIVIDER}\n`);
}

async function runLiveChain() {
  const { compile }      = require('../../intent/compiler');
  const { buildContext } = require('../../context/builder');

  const request = 'Add Gemini Flash as a second LLM provider alongside Anthropic';
  const repo    = '/Users/Arshad_1/Desktop/Start/projects/cue';

  console.log(`\n${DIVIDER}`);
  console.log(`  FULL CHAIN: Layer 1 → 2 → 3`);
  console.log(`  Request: "${request}"`);
  console.log(`  Repo:    ${repo}`);
  console.log(DIVIDER);

  console.log('\n  [L1] Running intent compiler...');
  const t1 = Date.now();
  const contract = await compile(request);
  console.log(`  [L1] Contract produced in ${Date.now() - t1}ms`);
  console.log(`       Goal: ${contract.goal}`);

  console.log('\n  [L2] Running context engine (DSA only)...');
  const t2 = Date.now();
  const context = await buildContext(contract, repo, { noLlm: true });
  console.log(`  [L2] Context package produced in ${Date.now() - t2}ms`);
  console.log(`       ${context.relevant_files.length} files, ${Object.keys(context.symbol_map).length} symbols`);

  console.log('\n  [L3] Building agent briefing...');
  const t3 = Date.now();
  const briefing = buildBriefing(contract, context);
  console.log(`  [L3] Briefing built in ${Date.now() - t3}ms (${briefing.split('\n').length} lines)\n`);

  console.log(DIVIDER);
  console.log(briefing);
  console.log(`\n${DIVIDER}\n`);
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

run().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
