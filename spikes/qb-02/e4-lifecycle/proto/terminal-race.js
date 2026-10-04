#!/usr/bin/env node
/**
 * E4 prototype — single terminal-state writer under contention.
 *
 * Starts two processes that try to commit different terminal states to the same
 * run at the same instant, many times. Exactly one must win each round, and the
 * file must hold the winner's state.
 *
 * Usage: terminal-race.js <scratch dir> [rounds]   → prints a JSON summary
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common');

if (process.argv[2] === '--writer') {
  const [, , , dir, state, startAt] = process.argv;
  while (Date.now() < +startAt) { /* spin to line up both writers */ }
  process.stdout.write(C.commitTerminal(dir, state, state, 'race') ? 'won' : 'lost');
  process.exit(0);
}

const [base, roundsArg] = process.argv.slice(2);
const rounds = +(roundsArg || 200);
let ok = 0;
const bad = [];
(async () => {
  for (let i = 0; i < rounds; i++) {
    const dir = path.join(base, `r${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const startAt = Date.now() + 150;
    const run = (state) => new Promise((res) => {
      let out = '';
      const p = spawn(process.execPath, [__filename, '--writer', dir, state, String(startAt)]);
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', () => res(out));
    });
    const [a, b] = await Promise.all([run('completed'), run('timeout')]);
    const t = C.readJson(path.join(dir, 'terminal.json'));
    const winners = [a, b].filter((x) => x === 'won').length;
    const winnerState = a === 'won' ? 'completed' : 'timeout';
    if (winners === 1 && t && t.state === winnerState) ok++;
    else bad.push({ round: i, a, b, file: t });
  }
  console.log(JSON.stringify({ rounds, exactly_one_winner: ok, violations: bad.slice(0, 5) }));
})();
