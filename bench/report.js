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
  .option('--format <type>', 'Output format: table | markdown | csv | json', 'table')
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

  console.log('## Aggregate Statistics\n');
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| QB pass rate | ${qbPass}/${results.length} (${pct(qbPass, results.length)}%) |`);
  console.log(`| QB first-attempt pass rate | ${qbFirst}/${results.length} (${pct(qbFirst, results.length)}%) |`);
  console.log(`| QB average attempts | ${avgTries.toFixed(2)} |`);
  console.log(`| QB average time | ${(avgMs/1000).toFixed(1)}s |`);
  if (baseRan.length) {
    console.log(`| Baseline pass rate | ${basePass}/${baseRan.length} (${pct(basePass, baseRan.length)}%) |`);
    console.log(`| QB lift over baseline | +${pct(qbPass,results.length) - pct(basePass,baseRan.length)} pp |`);
  }
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

main();
