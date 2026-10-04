#!/usr/bin/env node
/**
 * bench/report.js — Aggregate all result JSONs into a research-ready report
 *
 * Usage:
 *   node bench/report.js                    — reads bench/results/*.json
 *   node bench/report.js --format markdown  — outputs markdown table
 *   node bench/report.js --format csv       — outputs CSV
 */

const fs   = require('fs');
const path = require('path');
const { program } = require('commander');

program
  .name('report')
  .option('--format <type>', 'Output format: table | markdown | csv | json | latex', 'table')
  .option('--results <dir>',  'Results directory', path.join(__dirname, 'results'))
  .parse(process.argv);

const opts = program.opts();

function main() {
  const dir   = opts.results;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

  if (!files.length) {
    console.log('  No results found. Run: node bench/run.js');
    process.exit(0);
  }

  // Load all results, dedupe by task_id (keep latest per task)
  const byTask = {};
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      byTask[r.task_id] = r; // later file wins (latest run)
    } catch (_) {}
  }

  const results = Object.values(byTask).sort((a, b) => a.task_id.localeCompare(b.task_id));

  if (opts.format === 'json') {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (opts.format === 'csv') {
    printCSV(results);
    return;
  }

  if (opts.format === 'markdown') {
    printMarkdown(results);
    return;
  }

  if (opts.format === 'latex') {
    printLatex(results);
    return;
  }

  printTable(results);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function printTable(results) {
  const D = '─'.repeat(80);
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  QUARTERBACK BENCHMARK REPORT  —  ${results.length} task(s)`);
  console.log('═'.repeat(80));

  // Per-task rows
  console.log(`\n  ${'ID'.padEnd(7)} ${'Diff'.padEnd(8)} ${'QB Final'.padEnd(12)} ${'1st Att'.padEnd(12)} ${'Tries'.padEnd(7)} ${'QB ms'.padEnd(10)} ${'Base'.padEnd(12)}`);
  console.log('  ' + D);

  for (const r of results) {
    const qb   = r.qb   || {};
    const base = r.baseline || null;
    const row = [
      r.task_id.padEnd(7),
      (r.difficulty || '?').padEnd(8),
      icon(qb.final_verdict).padEnd(12),
      icon(qb.first_verdict).padEnd(12),
      String(qb.total_attempts || '?').padEnd(7),
      (qb.timing?.total_ms ? `${(qb.timing.total_ms/1000).toFixed(1)}s` : '?').padEnd(10),
      base ? icon(base.verdict).padEnd(12) : 'not run'.padEnd(12),
    ];
    console.log('  ' + row.join(' '));
  }

  printStats(results);
}

function printMarkdown(results) {
  console.log('# Quarterback Benchmark Results\n');
  console.log(`**Tasks:** ${results.length}  |  **Date:** ${new Date().toISOString().slice(0,10)}\n`);

  console.log('| Task | Difficulty | QB Final | QB 1st Attempt | Attempts | Time | Baseline |');
  console.log('|------|-----------|---------|---------------|----------|------|----------|');

  for (const r of results) {
    const qb   = r.qb   || {};
    const base = r.baseline;
    const row = [
      r.task_id,
      r.difficulty || '?',
      mdIcon(qb.final_verdict),
      mdIcon(qb.first_verdict),
      String(qb.total_attempts || '?'),
      qb.timing?.total_ms ? `${(qb.timing.total_ms/1000).toFixed(1)}s` : '?',
      base ? mdIcon(base.verdict) : '—',
    ];
    console.log('| ' + row.join(' | ') + ' |');
  }

  console.log('');

  // Aggregate stats block
  const qbPass    = results.filter(r => r.qb?.final_verdict === 'pass').length;
  const qbFirst   = results.filter(r => r.qb?.first_verdict === 'pass').length;
  const baseRan   = results.filter(r => r.baseline);
  const basePass  = baseRan.filter(r => r.baseline.verdict === 'pass').length;
  const avgMs     = results.reduce((s,r) => s + (r.qb?.timing?.total_ms||0), 0) / results.length;
  const avgTries  = results.reduce((s,r) => s + (r.qb?.total_attempts||0), 0) / results.length;
  const n         = results.length;

  const [qbLo, qbHi]     = wilsonCI(qbPass, n);
  const [baseLo, baseHi] = wilsonCI(basePass, baseRan.length);

  console.log('## Aggregate Statistics\n');
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| QB pass rate | ${qbPass}/${n} (${pct(qbPass, n)}%, 95% CI: ${(qbLo*100).toFixed(0)}%–${(qbHi*100).toFixed(0)}%) |`);
  console.log(`| QB first-attempt pass rate | ${qbFirst}/${n} (${pct(qbFirst, n)}%) |`);
  console.log(`| QB average attempts | ${avgTries.toFixed(2)} |`);
  console.log(`| QB average time | ${(avgMs/1000).toFixed(1)}s |`);
  if (baseRan.length) {
    console.log(`| Baseline pass rate | ${basePass}/${baseRan.length} (${pct(basePass, baseRan.length)}%, 95% CI: ${(baseLo*100).toFixed(0)}%–${(baseHi*100).toFixed(0)}%) |`);
    console.log(`| QB lift over baseline | +${pct(qbPass,n) - pct(basePass,baseRan.length)} pp |`);
  }

  // AC-level breakdown
  console.log('\n## AC-level Breakdown (final attempt)\n');
  console.log('| Task | AC true | AC false | AC null | Verdict |');
  console.log('|------|---------|----------|---------|---------|');
  for (const r of results) {
    const attempts = r.qb?.attempts || [];
    if (!attempts.length) continue;
    const lastAtt = attempts[attempts.length - 1];
    const acResults = lastAtt.ac_results || [];
    let trueCount = 0, falseCount = 0, nullCount = 0;
    for (const ac of acResults) {
      if (ac.met === true) trueCount++;
      else if (ac.met === false) falseCount++;
      else nullCount++;
    }
    console.log(`| ${r.task_id} | ${trueCount} | ${falseCount} | ${nullCount} | ${r.qb?.final_verdict || '?'} |`);
  }
}

function printLatex(results) {
  const qbPass   = results.filter(r => r.qb?.final_verdict === 'pass').length;
  const baseRan  = results.filter(r => r.baseline);
  const basePass = baseRan.filter(r => r.baseline.verdict === 'pass').length;
  const n        = results.length;

  const [qbLo, qbHi]     = wilsonCI(qbPass, n);
  const [baseLo, baseHi] = wilsonCI(basePass, baseRan.length);

  const lines = [];
  lines.push('\\begin{table}[h]');
  lines.push('\\centering');
  lines.push('\\begin{tabular}{llccccc}');
  lines.push('\\hline');
  lines.push('\\textbf{Task} & \\textbf{Diff.} & \\textbf{QB} & \\textbf{1st Att.} & \\textbf{Tries} & \\textbf{Time (s)} & \\textbf{Base} \\\\');
  lines.push('\\hline');

  for (const r of results) {
    const qb   = r.qb   || {};
    const base = r.baseline;

    const qbCell   = qb.final_verdict  === 'pass' ? '\\checkmark pass' : '\\ding{55} ' + (qb.final_verdict  || '?');
    const firstCell= qb.first_verdict  === 'pass' ? '\\checkmark pass' : '\\ding{55} ' + (qb.first_verdict  || '?');
    const baseCell = base
      ? (base.verdict === 'pass' ? '\\checkmark pass' : '\\ding{55} ' + base.verdict)
      : '---';
    const tries    = String(qb.total_attempts || '?');
    const timeSec  = qb.timing?.total_ms ? (qb.timing.total_ms / 1000).toFixed(1) : '?';
    const diff     = (r.difficulty || '?').slice(0, 6);

    lines.push(`${r.task_id} & ${diff} & ${qbCell} & ${firstCell} & ${tries} & ${timeSec} & ${baseCell} \\\\`);
  }

  lines.push('\\hline');

  const qbCIStr   = `${(qbLo*100).toFixed(0)}\\%--${(qbHi*100).toFixed(0)}\\%`;
  const baseCIStr = baseRan.length
    ? `${(baseLo*100).toFixed(0)}\\%--${(baseHi*100).toFixed(0)}\\%`
    : 'N/A';

  lines.push(`\\multicolumn{7}{l}{QB: ${qbPass}/${n} (${pct(qbPass,n)}\\%, 95\\% CI: [${qbCIStr}])} \\\\`);
  if (baseRan.length) {
    lines.push(`\\multicolumn{7}{l}{Baseline: ${basePass}/${baseRan.length} (${pct(basePass,baseRan.length)}\\%, 95\\% CI: [${baseCIStr}])} \\\\`);
  }

  lines.push('\\hline');
  lines.push('\\end{tabular}');
  lines.push('\\caption{Quarterback benchmark results. CI computed using Wilson score interval.}');
  lines.push('\\label{tab:results}');
  lines.push('\\end{table}');

  console.log(lines.join('\n'));
}

function printCSV(results) {
  const headers = ['task_id','difficulty','tags','qb_final','qb_first_attempt','qb_attempts','qb_total_ms','qb_files_changed','baseline_verdict','baseline_ms','baseline_files_changed'];
  console.log(headers.join(','));
  for (const r of results) {
    const qb   = r.qb   || {};
    const base = r.baseline || {};
    const row = [
      r.task_id,
      r.difficulty || '',
      (r.tags || []).join('|'),
      qb.final_verdict || '',
      qb.first_verdict || '',
      qb.total_attempts || '',
      qb.timing?.total_ms || '',
      (qb.files_changed || []).join('|'),
      base.verdict || '',
      base.timing_ms || '',
      (base.files_changed || []).join('|'),
    ];
    console.log(row.join(','));
  }
}

function printStats(results) {
  const qbPass    = results.filter(r => r.qb?.final_verdict === 'pass').length;
  const qbFirst   = results.filter(r => r.qb?.first_verdict === 'pass').length;
  const baseRan   = results.filter(r => r.baseline);
  const basePass  = baseRan.filter(r => r.baseline.verdict === 'pass').length;
  const avgMs     = results.reduce((s,r) => s + (r.qb?.timing?.total_ms||0), 0) / results.length;
  const avgTries  = results.reduce((s,r) => s + (r.qb?.total_attempts||0), 0) / results.length;

  console.log(`\n  ${'─'.repeat(80)}`);
  console.log(`  QB pass rate:          ${qbPass}/${results.length}  (${pct(qbPass, results.length)}%)`);
  console.log(`  QB first-attempt:      ${qbFirst}/${results.length}  (${pct(qbFirst, results.length)}%)`);
  console.log(`  QB avg attempts:       ${avgTries.toFixed(2)}`);
  console.log(`  QB avg time:           ${(avgMs/1000).toFixed(1)}s`);
  if (baseRan.length) {
    console.log(`  Baseline pass rate:    ${basePass}/${baseRan.length}  (${pct(basePass, baseRan.length)}%)`);
    console.log(`  QB lift:               +${pct(qbPass,results.length) - pct(basePass,baseRan.length)} percentage points`);
  }
  console.log(`\n${'═'.repeat(80)}\n`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function icon(v)   { return `${({pass:'✓',fail:'✗',partial:'~','no-diff':'○'}[v]||'?')} ${v||'?'}`; }
function mdIcon(v) { return `${({pass:'✅',fail:'❌',partial:'⚠️','no-diff':'○'}[v]||'?')} ${v||'?'}`; }
function pct(n, d) { return d ? Math.round(n/d*100) : 0; }

/**
 * Wilson score confidence interval.
 * @param {number} k  number of successes
 * @param {number} n  total trials
 * @param {number} [z=1.96]  z-score for confidence level (default 95%)
 * @returns {[number, number]} [lower, upper] as proportions in [0,1]
 */
function wilsonCI(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p      = k / n;
  const denom  = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

main();
