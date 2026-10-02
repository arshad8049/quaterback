#!/usr/bin/env node
/**
 * bench/calibrate.js — Judge calibration: measures L4 judge accuracy
 * against test oracle (ground truth) using existing result JSONs.
 *
 * For each run in results/*.json that has testResults, computes:
 *   - Task-level accuracy: judge verdict vs test pass/fail
 *   - AC-level precision/recall
 *   - Fleiss' kappa for 3-way vote agreement within the judge
 *   - False positive rate, false negative rate
 *
 * Usage:
 *   node bench/calibrate.js
 *   node bench/calibrate.js --results bench/results
 */

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let resultsDir = path.join(__dirname, 'results');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--results' && args[i + 1]) {
    resultsDir = args[i + 1];
    i++;
  }
}

// ── Wilson score confidence interval ─────────────────────────────────────────
function wilsonCI(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const denom  = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ── Cohen's kappa ─────────────────────────────────────────────────────────────
// p_o = observed agreement, p_e = expected agreement by chance
// kappa = (p_o - p_e) / (1 - p_e)
function cohensKappa(tp, tn, fp, fn) {
  const n = tp + tn + fp + fn;
  if (n === 0) return null;
  const p_o = (tp + tn) / n;
  // Marginals for expected agreement
  const p_pos_judge  = (tp + fp) / n;
  const p_neg_judge  = (tn + fn) / n;
  const p_pos_truth  = (tp + fn) / n;
  const p_neg_truth  = (tn + fp) / n;
  const p_e = p_pos_judge * p_pos_truth + p_neg_judge * p_neg_truth;
  if (p_e === 1) return null;
  return (p_o - p_e) / (1 - p_e);
}

// ── Fleiss' kappa for 3-way votes ─────────────────────────────────────────────
// Each item has an array of k votes (true/false). We treat true=1, false=0.
// Fleiss' kappa: kappa = (P_bar - P_e_bar) / (1 - P_e_bar)
function fleissKappa(voteSets) {
  // voteSets: Array of arrays, each inner array is votes for one item
  // Filter to only items with at least 2 votes
  const items = voteSets.filter(v => Array.isArray(v) && v.length >= 2);
  if (items.length === 0) return null;

  const N = items.length; // number of items
  const n = items[0].length; // number of raters per item (assume uniform)

  // Category counts: for each item, count how many raters chose each category
  // Categories: 0 (false/fail), 1 (true/pass)
  let sumP_i = 0;
  let count0 = 0; // total votes for category 0
  let count1 = 0; // total votes for category 1

  for (const votes of items) {
    const raters = votes.length;
    const trueCount  = votes.filter(v => v === true  || v === 1).length;
    const falseCount = votes.filter(v => v === false || v === 0).length;
    count0 += falseCount;
    count1 += trueCount;

    // P_i = (1 / (n*(n-1))) * sum_k(n_ik * (n_ik - 1))
    const p_i = raters <= 1 ? 0 :
      (falseCount * (falseCount - 1) + trueCount * (trueCount - 1)) / (raters * (raters - 1));
    sumP_i += p_i;
  }

  const P_bar = sumP_i / N;

  // p_j = proportion of all assignments to category j
  const totalAssignments = N * n;
  const p0 = count0 / totalAssignments;
  const p1 = count1 / totalAssignments;
  const P_e_bar = p0 * p0 + p1 * p1;

  if (P_e_bar === 1) return null;
  return (P_bar - P_e_bar) / (1 - P_e_bar);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(resultsDir)) {
    console.log(`  Results directory not found: ${resultsDir}`);
    console.log('  Run bench/run.js first to generate result data.');
    process.exit(0);
  }

  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort();

  if (!files.length) {
    console.log('  No result JSONs found. Run bench/run.js first.');
    process.exit(0);
  }

  // Load all results
  const results = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
      if (r && r.task_id) results.push(r);
    } catch (_) {}
  }

  if (!results.length) {
    console.log('  No valid result JSONs loaded.');
    process.exit(0);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  QUARTERBACK — JUDGE CALIBRATION REPORT');
  console.log(`  Results loaded: ${results.length} task run(s) from ${resultsDir}`);
  console.log('═'.repeat(72));

  // ── Task-level calibration ─────────────────────────────────────────────────
  // Ground truth: testResults.failed === 0 → PASS, else FAIL
  // Judge: qb.final_verdict === 'pass' → PASS, else FAIL
  // Only tasks with testResults can be calibrated at task level
  const withTestResults = results.filter(r => r.testResults !== undefined);
  const withoutTestResults = results.filter(r => r.testResults === undefined);

  console.log(`\n  Task-level calibration: ${withTestResults.length} tasks with test oracle`);
  if (withoutTestResults.length) {
    console.log(`  (${withoutTestResults.length} task(s) lack testResults — excluded from task-level metrics)`);
  }

  let taskTP = 0, taskTN = 0, taskFP = 0, taskFN = 0;

  if (withTestResults.length > 0) {
    for (const r of withTestResults) {
      const gtPass     = r.testResults.failed === 0;
      const judgePass  = r.qb?.final_verdict === 'pass';
      if (gtPass  && judgePass)  taskTP++;
      if (!gtPass && !judgePass) taskTN++;
      if (!gtPass && judgePass)  taskFP++;
      if (gtPass  && !judgePass) taskFN++;
    }

    const n         = withTestResults.length;
    const accuracy  = (taskTP + taskTN) / n;
    const precision = taskTP + taskFP > 0 ? taskTP / (taskTP + taskFP) : null;
    const recall    = taskTP + taskFN > 0 ? taskTP / (taskTP + taskFN) : null;
    const f1        = precision !== null && recall !== null && (precision + recall) > 0
      ? 2 * precision * recall / (precision + recall) : null;
    const fpr       = taskFP + taskTN > 0 ? taskFP / (taskFP + taskTN) : null;
    const fnr       = taskFN + taskTP > 0 ? taskFN / (taskFN + taskTP) : null;
    const kappa     = cohensKappa(taskTP, taskTN, taskFP, taskFN);
    const [ciLo, ciHi] = wilsonCI(taskTP + taskTN, n);

    console.log('\n  Confusion Matrix (QB judge vs test oracle):');
    console.log(`    True  Positive (TP): ${taskTP}  — judge PASS, oracle PASS`);
    console.log(`    True  Negative (TN): ${taskTN}  — judge FAIL, oracle FAIL`);
    console.log(`    False Positive (FP): ${taskFP}  — judge PASS, oracle FAIL`);
    console.log(`    False Negative (FN): ${taskFN}  — judge FAIL, oracle PASS`);
    console.log('');
    console.log(`  Accuracy:  ${(accuracy * 100).toFixed(1)}%  (95% CI: ${(ciLo*100).toFixed(1)}%–${(ciHi*100).toFixed(1)}%)`);
    if (precision !== null) console.log(`  Precision: ${(precision * 100).toFixed(1)}%`);
    if (recall    !== null) console.log(`  Recall:    ${(recall    * 100).toFixed(1)}%`);
    if (f1        !== null) console.log(`  F1 Score:  ${f1.toFixed(3)}`);
    if (fpr       !== null) console.log(`  FPR (false positive rate): ${(fpr * 100).toFixed(1)}%`);
    if (fnr       !== null) console.log(`  FNR (false negative rate): ${(fnr * 100).toFixed(1)}%`);
    if (kappa     !== null) console.log(`  Cohen's kappa: ${kappa.toFixed(3)}`);
  } else {
    console.log('  No tasks with testResults found — skipping task-level metrics.');
    console.log('  (Add testResults: { passed, failed } to result JSONs for oracle calibration.)');
  }

  // ── AC-level calibration (vote agreement) ─────────────────────────────────
  const allVoteSets = [];
  let totalACs = 0;
  let unanimousACs = 0;
  let splitACs = 0;

  for (const r of results) {
    const attempts = r.qb?.attempts || [];
    for (const att of attempts) {
      const acResults = att.ac_results || [];
      for (const ac of acResults) {
        if (Array.isArray(ac.votes) && ac.votes.length >= 2) {
          allVoteSets.push(ac.votes);
          totalACs++;
          const trueVotes = ac.votes.filter(v => v === true).length;
          if (trueVotes === 0 || trueVotes === ac.votes.length) unanimousACs++;
          else splitACs++;
        }
      }
    }
  }

  console.log(`\n  AC-level vote analysis: ${totalACs} ACs with multi-vote data`);

  if (totalACs > 0) {
    console.log(`    Unanimous votes: ${unanimousACs}/${totalACs} (${(unanimousACs/totalACs*100).toFixed(1)}%)`);
    console.log(`    Split votes:     ${splitACs}/${totalACs} (${(splitACs/totalACs*100).toFixed(1)}%)`);

    const fk = fleissKappa(allVoteSets);
    if (fk !== null) {
      console.log(`    Fleiss' kappa (inter-rater agreement): ${fk.toFixed(3)}`);
      let kappaInterp;
      if      (fk < 0)    kappaInterp = 'poor (less than chance)';
      else if (fk < 0.20) kappaInterp = 'slight';
      else if (fk < 0.40) kappaInterp = 'fair';
      else if (fk < 0.60) kappaInterp = 'moderate';
      else if (fk < 0.80) kappaInterp = 'substantial';
      else                kappaInterp = 'almost perfect';
      console.log(`    Interpretation: ${kappaInterp}`);
    }
  } else {
    console.log('  No multi-vote AC data found — skipping Fleiss kappa computation.');
    console.log('  (Votes arrays are populated when bench/run.js uses the QB pipeline.)');
  }

  // ── AC-level breakdown per task ────────────────────────────────────────────
  console.log('\n  AC breakdown by task (final attempt):');
  console.log(`  ${'Task'.padEnd(8)} ${'True'.padEnd(7)} ${'False'.padEnd(7)} ${'Null'.padEnd(7)} ${'Verdict'.padEnd(10)}`);
  console.log('  ' + '─'.repeat(46));

  for (const r of results) {
    const attempts = r.qb?.attempts || [];
    if (!attempts.length) continue;
    const lastAtt = attempts[attempts.length - 1];
    const acResults = lastAtt.ac_results || [];

    let trueCount  = 0;
    let falseCount = 0;
    let nullCount  = 0;

    for (const ac of acResults) {
      if (ac.met === true)  trueCount++;
      else if (ac.met === false) falseCount++;
      else nullCount++;
    }

    const verdict = r.qb?.final_verdict || '?';
    console.log(`  ${r.task_id.padEnd(8)} ${String(trueCount).padEnd(7)} ${String(falseCount).padEnd(7)} ${String(nullCount).padEnd(7)} ${verdict}`);
  }

  // ── Per-task vote details ──────────────────────────────────────────────────
  console.log('\n  Split-vote ACs detail:');
  let splitFound = false;
  for (const r of results) {
    const attempts = r.qb?.attempts || [];
    for (const att of attempts) {
      for (const ac of (att.ac_results || [])) {
        if (!Array.isArray(ac.votes)) continue;
        const trues = ac.votes.filter(v => v === true).length;
        if (trues > 0 && trues < ac.votes.length) {
          console.log(`    ${r.task_id} attempt ${att.attempt} ${ac.id}: [${ac.votes.join(', ')}] → met=${ac.met}`);
          splitFound = true;
        }
      }
    }
  }
  if (!splitFound) console.log('    (none)');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}\n`);
}

main();
