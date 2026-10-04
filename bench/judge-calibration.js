#!/usr/bin/env node
/**
 * bench/judge-calibration.js — calibrate QB's judge against independently labeled
 * patches (QB-15). See verify/calibration.js and docs/verify/calibration.md.
 *
 *   node bench/judge-calibration.js [--votes 3] [--items bench/calibration/labeled.json] [--out <file>]
 *
 * Needs the judge model (Ollama, QB_MODEL). Prints false accepts, false rejects and
 * abstentions for single / majority-3 / unanimous-3 on the same samples, and writes
 * the full per-item votes to bench/calibration/results/<timestamp>.json.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { calibrate, liveSampler } = require('../verify/calibration');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const votes = Number(opt('votes', 3));
const itemsFile = opt('items', path.join(__dirname, 'calibration', 'labeled.json'));
const out = opt('out', path.join(__dirname, 'calibration', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

const blob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const { items } = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
for (const it of items) it.files = (it.files || []).map((f) => ({ ...f, oid: f.oid || blob(f.text) }));

(async () => {
  const sample = liveSampler();
  const started = Date.now();
  const report = await calibrate(items, {
    votes,
    sampleAll: async (item, n) => { const v = await sample(item, n); process.stderr.write(`  ${item.id} (${item.label}): ${JSON.stringify(v)}\n`); return v; },
  });
  const { MODEL } = require('../verify/judge');
  const result = { format: 'qb-judge-calibration-result/1', model: MODEL, items_file: path.relative(process.cwd(), itemsFile),
    duration_ms: Date.now() - started, ...report };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const pct = (x) => `${(100 * x).toFixed(0)}%`;
  console.log(`\nJudge calibration — ${MODEL}, ${report.items} labeled patches, ${votes} samples each\n`);
  console.log('strategy        calls/item  false accept    false reject    abstain         correct');
  for (const s of report.strategies) {
    console.log(`${s.name.padEnd(15)} ${String(s.calls_per_item).padEnd(11)} ${`${s.false_accept} (${pct(s.false_accept_rate)})`.padEnd(15)} ${`${s.false_reject} (${pct(s.false_reject_rate)})`.padEnd(15)} ${`${s.abstain} (${pct(s.abstention_rate)})`.padEnd(15)} ${s.correct}/${s.items}`);
  }
  console.log(`\n${report.equal_cost}\nWritten: ${path.relative(process.cwd(), out)}`);
})().catch((e) => { console.error(e); process.exit(1); });
