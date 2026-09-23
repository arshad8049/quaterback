#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Command } = require('commander');
const fs   = require('fs');
const path = require('path');
const { buildContext } = require('./builder');

const program = new Command();

program
  .name('qb-context')
  .description('Quarterback Context Engine — grounds a Task Contract in the actual codebase')
  .version('0.1.0');

program
  .requiredOption('-c, --contract <path>', 'Path to a Task Contract JSON file (from Layer 1)')
  .requiredOption('-r, --repo <path>',     'Path to the repository')
  .option('--no-llm',                      'Skip LLM enrichment — DSA only (faster)')
  .option('-s, --save',                    'Save the ContextPackage to packages/{id}.json')
  .action(async (options) => {
    // Load contract
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(path.resolve(options.contract), 'utf8'));
    } catch (err) {
      console.error(`\n  Error reading contract: ${err.message}\n`);
      process.exit(1);
    }

    process.stderr.write('\n  Running DSA passes...\n');
    const t0 = Date.now();

    let pkg;
    try {
      pkg = await buildContext(contract, options.repo, { noLlm: !options.llm });
    } catch (err) {
      console.error(`\n  Context engine error: ${err.message}\n`);
      if (err.errors) {
        err.errors.forEach(e => console.error(`    ${e.path.join('.')} — ${e.message}`));
      }
      process.exit(1);
    }

    const ms = Date.now() - t0;
    process.stderr.write(`  Done [${ms}ms]\n\n`);

    const json = JSON.stringify(pkg, null, 2);
    console.log(json);

    if (options.save) {
      const dir     = path.join(__dirname, 'packages');
      fs.mkdirSync(dir, { recursive: true });
      const outPath = path.join(dir, `${pkg.id}.json`);
      fs.writeFileSync(outPath, json, 'utf8');
      process.stderr.write(`  Saved → context/packages/${pkg.id}.json\n\n`);
    }
  });

program.parse();
