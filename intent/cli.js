#!/usr/bin/env node
require('dotenv').config();

const { Command } = require('commander');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { compile } = require('./compiler');
const { buildContext } = require('./context');

const program = new Command();

program
  .name('qb')
  .description('Quarterback Intent Compiler — turns a developer request into a Task Contract')
  .version('0.1.0');

program
  .argument('<request>', 'The developer task in plain English')
  .option('-r, --repo <path>', 'Path to the repository for context')
  .option('-s, --save', 'Save the contract to contracts/{id}.json')
  .option('--no-color', 'Disable colored output')
  .action(async (request, options) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('\n  Error: ANTHROPIC_API_KEY is not set.\n');
      console.error('  Copy intent/.env.example to intent/.env and add your key.\n');
      process.exit(1);
    }

    // Build repo context if --repo provided
    let repoContext = null;
    if (options.repo) {
      process.stderr.write('  Reading repo context...\n');
      try {
        repoContext = buildContext(options.repo, request);
      } catch (err) {
        console.error(`  Context error: ${err.message}`);
        process.exit(1);
      }
    }

    process.stderr.write('  Compiling intent...\n');

    try {
      let result = await compile(request, repoContext);

      // If compiler returned a clarifying question, ask it and re-compile
      if (result.clarifying_question) {
        console.log('\n  ─────────────────────────────────────────────');
        console.log('  Ambiguity detected:\n');
        result.ambiguity_flags.forEach(f => console.log(`    • ${f}`));
        console.log(`\n  Question: ${result.clarifying_question}\n`);
        console.log('  ─────────────────────────────────────────────\n');

        const answer = await prompt('  Your answer: ');
        process.stderr.write('\n  Re-compiling with clarification...\n');
        result = await compile(request, repoContext, answer);
      }

      // Attach repo path if used
      if (options.repo) {
        result.repo_path = path.resolve(options.repo);
      }

      // Print the contract
      const json = JSON.stringify(result, null, 2);
      console.log('\n' + json + '\n');

      // Optionally save
      if (options.save) {
        const dir = path.join(__dirname, 'contracts');
        fs.mkdirSync(dir, { recursive: true });
        const outPath = path.join(dir, `${result.id}.json`);
        fs.writeFileSync(outPath, json, 'utf8');
        process.stderr.write(`  Saved → contracts/${result.id}.json\n\n`);
      }
    } catch (err) {
      console.error(`\n  Compiler error: ${err.message}\n`);
      if (err.errors) {
        console.error('  Schema validation failures:');
        err.errors.forEach(e => console.error(`    ${e.path.join('.')} — ${e.message}`));
      }
      process.exit(1);
    }
  });

program.parse();

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
