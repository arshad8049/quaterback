#!/usr/bin/env node
require('dotenv').config();

const { Command } = require('commander');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { artifactFile } = require('../lib/fsafe');
const { compileIntent } = require('./session');
const { buildContext: buildContextPackage } = require('../context/builder');

const program = new Command();

program
  .name('qb')
  .description('Quarterback Intent Compiler — turns a developer request into a Task Contract')
  .version('0.1.0');

program
  .argument('<request>', 'The developer task in plain English')
  .option('-r, --repo <path>', 'Repository to ground the request in (default: the current directory, like qb)')
  .option('-s, --save',    'Save the contract to contracts/{id}.json')
  .option('--clarify <answer>', 'Answer to a clarifying question, one per round; a choice can be selected as <question>=<choice>', (v, prev) => [...prev, v], [])
  .option('--context',     'Chain into Layer 2 — build a ContextPackage after the contract')
  .option('--no-color',    'Disable colored output')
  .action(async (request, options) => {
    // QB-17: the same grounded compilation as qb.js — a repository survey first
    // (default: the current directory, as qb.js defaults --repo), then bounded
    // clarification rounds.
    const repoPath = options.repo || process.cwd();
    if (!fs.existsSync(repoPath)) {
      console.error(`  Context error: Repo path does not exist: ${path.resolve(repoPath)}`);
      process.exit(1);
    }
    process.stderr.write('  Surveying the repository and compiling intent...\n');

    try {
      const s = await compileIntent(request, {
        repoPath, answers: options.clarify || [],
        ask: !process.stdin.isTTY ? null : async (h) => {   // noninteractive: return the handoff state
          console.log('\n  ─────────────────────────────────────────────');
          console.log(`  Ambiguity detected (round ${h.round} of ${h.max_rounds}):\n`);
          h.ambiguity_flags.forEach(f => console.log(`    • ${f}`));
          for (const u of h.unresolved) {
            console.log(`\n  Question: ${u.question}`);
            if (u.choices.length) console.log(`  Choices:  ${(u.options || []).map((o) => `${o.label} [${u.id}=${o.id}]`).join(' · ') || u.choices.join(' · ')}`);
          }
          console.log('  ─────────────────────────────────────────────\n');
          return (await prompt('  Your answer: ')) || null;
        },
      });
      if (s.state !== 'finalized') {
        // Machine-readable handoff state (still open, blocked or invalid) on stdout.
        console.log('\n' + JSON.stringify({ ...s, contract: undefined }, null, 2) + '\n');
        process.exit(2);
      }
      const result = s.contract;

      result.repo_path = path.resolve(repoPath);

      // Print the contract
      const json = JSON.stringify(result, null, 2);
      console.log('\n' + json + '\n');

      // Optionally save
      if (options.save) {
        const dir = path.join(__dirname, 'contracts');
        fs.mkdirSync(dir, { recursive: true });
        const outPath = artifactFile(dir, result.id);
        fs.writeFileSync(outPath, json, 'utf8');
        process.stderr.write(`  Saved → contracts/${result.id}.json\n\n`);
      }

      // Optionally chain into Layer 2 (Context)
      if (options.context && options.repo) {
        process.stderr.write('  Chaining into Layer 2 (Context)...\n');
        try {
          const pkg     = await buildContextPackage(result, options.repo);
          const pkgJson = JSON.stringify(pkg, null, 2);
          const pkgDir  = path.join(__dirname, '..', 'context', 'packages');
          fs.mkdirSync(pkgDir, { recursive: true });
          const pkgPath = path.join(pkgDir, `${pkg.id}.json`);
          fs.writeFileSync(pkgPath, pkgJson, 'utf8');
          process.stderr.write(`  Context → context/packages/${pkg.id}.json\n`);
          process.stderr.write(`  Files: ${pkg.relevant_files.length}  Symbols: ${Object.keys(pkg.symbol_map).length}\n\n`);
        } catch (err) {
          process.stderr.write(`  Context layer error: ${err.message}\n\n`);
        }
      } else if (options.context && !options.repo) {
        process.stderr.write('  --context requires --repo to be set\n\n');
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
