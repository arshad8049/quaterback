/**
 * memory/index.js — Layer 5: Memory
 *
 * Quarterback learns per-repo. After each run it persists:
 *   - the outcome (goal, verdict, changed files, timing)
 *   - any repair hints that fired
 *   - aggregated file hit counts
 *
 * On the next run it recalls:
 *   - recallFiles()   → files that were relevant/changed for similar past tasks (boosts L2)
 *   - recallRepairs() → past repair hints for similar failing criteria (boosts L3 briefing)
 *   - recallPrior()   → most similar past contracts (duplicate detection, pattern surfacing)
 */

const { randomUUID }   = require('crypto');
const store            = require('./store');
const { tokenize, scoreOutcome, scoreRepair } = require('./scorer');
const { OutcomeRecordSchema, RepairRecordSchema } = require('./schema');
const { linkRepairs } = require('./repairs');

const RECALL_THRESHOLD  = 0.08;  // minimum Jaccard to surface a result
const MAX_RECALL        = 5;     // cap returned results
const MAX_FILE_HINTS    = 8;     // cap file hints passed to L2

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Persist the outcome of a completed pipeline run.
 * Called by qb.js after each L4 verdict.
 *
 * @param {string} repoPath
 * @param {object} contract   - TaskContract from L1
 * @param {object} report     - VerificationReport from L4
 * @param {object} execution  - ExecutionResult from L3 (optional in dry-run)
 * @param {object} [run]      - QB-23: { history, runId } — the append-only attempt history
 *                              (memory/repairs.js attemptEntry per verified attempt)
 */
async function remember(repoPath, contract, report, execution = null, { history = null, runId = null } = {}) {
  if (!repoPath || !contract || !report) return;

  const keywords     = tokenize(contract.goal || contract.raw_request || '');
  const changedFiles = execution?.changes?.map(c => c.file) || [];

  // Outcome record
  const outcome = OutcomeRecordSchema.parse({
    id:            randomUUID(),
    ts:            new Date().toISOString(),
    repo_path:     repoPath,
    goal:          contract.goal || contract.raw_request || '',
    keywords,
    verdict:       report.verdict,
    attempts:      report.attempts || 1,
    changed_files: changedFiles,
    ac_count:      contract.acceptance_criteria?.length || 0,
    duration_ms:   execution?.duration_ms || 0,
    contract_id:   contract.id,
    ...(runId ? { run_id: runId } : {}),
    ...(history ? { attempt_history: history.map(a => ({ attempt: a.attempt, patch_sha256: a.patch_sha256, evidence_sha256: a.evidence_sha256,
      report_id: a.report_id, verdict: a.verdict, oracle_approved: a.oracle_approved })) } : {}),
  });
  store.appendOutcome(repoPath, outcome);

  // Update aggregated file stats
  if (changedFiles.length > 0) {
    store.updateFileStats(repoPath, changedFiles, keywords);
  }

  // Repair records (QB-23): every hint the run produced, linked to the patch that
  // followed it and to the hinted criterion's re-evaluation. Only `resolved` (met on a
  // changed patch AND the run ended in an approved PASS) is a proven repair; the rest
  // are kept, append-only, with their outcome. Without the attempt history nothing can
  // be linked, so nothing is recorded as a repair.
  for (const link of history ? linkRepairs(history) : []) {
    const record = RepairRecordSchema.parse({
      id:               randomUUID(),
      ts:               new Date().toISOString(),
      repo_path:        repoPath,
      goal_keywords:    keywords,
      failed_criterion: link.criterion_id,
      crit_keywords:    tokenize(`${criterionText(contract, link.criterion_id)} ${link.diagnosis}`),
      diagnosis:        link.diagnosis,
      fix:              link.fix,
      resolved:         link.resolved,
      contract_id:      contract.id,
      schema:           2,
      run_id:           runId,
      source:           link.source,
      outcome:          link.outcome,
      reason:           link.reason,
      from_attempt:     link.from_attempt,
      to_attempt:       link.to_attempt,
      patch_before_sha256: link.patch_before_sha256,
      patch_after_sha256:  link.patch_after_sha256,
      evidence_before_sha256: link.evidence_before_sha256,
      evidence_after_sha256:  link.evidence_after_sha256,
      before:           link.before,
      after:            link.after,
      final:            link.final,
    });
    store.appendRepair(repoPath, record);
  }
}

const criterionText = (contract, id) => ((contract.acceptance_criteria || []).find(a => a.id === id) || {}).criterion || '';

/** QB-23: what a stored repair record establishes. */
function repairStatus(rec) {
  if (rec.schema !== 2) return 'legacy_unverified';     // pre-QB-23: `resolved` was never established
  return rec.outcome;
}
const RECALLED = new Set(['resolved', 'observed_resolved_unconfirmed', 'legacy_unverified']);

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Returns files likely to be relevant for this task, based on past runs on this repo.
 * Blends two signals:
 *   1. Files that were changed in similar past tasks (Jaccard-scored)
 *   2. Files with high raw hit counts (frequently changed = high-churn, worth knowing)
 *
 * @param {string} repoPath
 * @param {string} goal         - current task goal text
 * @returns {Array<{file, score, reason}>}
 */
function recallFiles(repoPath, goal) {
  const queryKws  = tokenize(goal || '');
  const outcomes  = store.readOutcomes(repoPath);
  const fileStats = store.readFileStats(repoPath);

  const fileScores = {};

  // Signal 1: files changed in similar past tasks
  for (const outcome of outcomes) {
    if (!outcome.changed_files?.length) continue;
    const sim = scoreOutcome(queryKws, outcome);
    if (sim < RECALL_THRESHOLD) continue;
    for (const file of outcome.changed_files) {
      if (!fileScores[file]) fileScores[file] = { similarity: 0, hits: 0, verdict: null };
      if (sim > fileScores[file].similarity) {
        fileScores[file].similarity = sim;
        fileScores[file].verdict    = outcome.verdict;
      }
    }
  }

  // Signal 2: frequently changed files (high churn awareness)
  for (const [file, stat] of Object.entries(fileStats)) {
    if (!fileScores[file]) fileScores[file] = { similarity: 0, hits: 0, verdict: null };
    fileScores[file].hits = stat.hits;
  }

  // Rank: similarity first, then hits as tiebreaker
  const ranked = Object.entries(fileScores)
    .map(([file, s]) => ({
      file,
      score:  s.similarity + (s.hits * 0.01),
      reason: s.similarity > 0
        ? `changed in ${s.verdict} run for similar task (sim=${s.similarity.toFixed(2)})`
        : `high-churn file (${s.hits} past change(s))`,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILE_HINTS);

  return ranked;
}

/**
 * Returns past repair hints for similar failing criteria.
 * Used to pre-load L3 briefing with proven fixes before the first attempt.
 *
 * @param {string} repoPath
 * @param {Array<{id, criterion}>} criteria  - current contract's ACs
 * @returns {Array<{criterion_id, diagnosis, fix, score, status, proven}>}
 *   status: resolved (proven) | observed_resolved_unconfirmed | legacy_unverified
 */
function recallRepairs(repoPath, criteria = []) {
  if (!criteria.length) return [];
  const repairs = store.readRepairs(repoPath);
  if (!repairs.length) return [];

  const results = [];
  for (const ac of criteria) {
    const queryKws = tokenize(ac.criterion || '');
    let best = null;
    for (const rec of repairs) {
      const status = repairStatus(rec);
      if (!RECALLED.has(status)) continue;               // failed / abandoned suggestions are not recalled as fixes
      const sim = scoreRepair(queryKws, rec);
      if (sim < RECALL_THRESHOLD) continue;
      const proven = status === 'resolved';
      // proven repairs rank above unconfirmed observations and legacy records
      if (!best || (proven && !best.proven) || (proven === best.proven && sim > best.score)) {
        best = {
          criterion_id: ac.id,
          diagnosis:    rec.diagnosis,
          fix:          rec.fix,
          score:        sim,
          status,
          proven,
          ...(rec.schema === 2 ? { from_run: rec.run_id ?? null, patch_after_sha256: rec.patch_after_sha256 ?? null } : {}),
        };
      }
    }
    if (best) results.push(best);
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Returns the most similar past contracts for this repo.
 * Used to detect duplicate work or surface learned patterns.
 *
 * @param {string} repoPath
 * @param {string} goal
 * @returns {Array<OutcomeRecord & {score}>}
 */
function recallPrior(repoPath, goal) {
  const queryKws = tokenize(goal || '');
  const outcomes = store.readOutcomes(repoPath);

  return outcomes
    .map(o => ({ ...o, score: scoreOutcome(queryKws, o) }))
    .filter(o => o.score >= RECALL_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECALL);
}

/**
 * Returns a summary of memory for this repo (for display/debug).
 */
function stats(repoPath) {
  const outcomes  = store.readOutcomes(repoPath);
  const repairs   = store.readRepairs(repoPath);
  const fileStats = store.readFileStats(repoPath);
  const passes    = outcomes.filter(o => o.verdict === 'pass').length;
  const fails     = outcomes.filter(o => o.verdict === 'fail').length;
  return {
    total_runs:    outcomes.length,
    passes,
    fails,
    repairs_saved: repairs.length,
    repairs_proven: repairs.filter(r => repairStatus(r) === 'resolved').length,
    files_tracked: Object.keys(fileStats).length,
    memory_dir:    store.repoMemoryPath(repoPath),
  };
}

module.exports = { remember, recallFiles, recallRepairs, recallPrior, stats, repairStatus };
