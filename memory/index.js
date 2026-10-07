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
const { createStore, DEFAULTS } = require('./store');
const fs   = require('fs');
const path = require('path');
const { tokenize, scoreRepair, intentOf, compareIntent } = require('./scorer');
const { git } = require('../lib/proc');
const { OutcomeRecordSchema, RepairRecordSchema } = require('./schema');
const { linkRepairs } = require('./repairs');

const RECALL_THRESHOLD  = 0.08;  // minimum Jaccard to surface a result
const MAX_RECALL        = 5;     // cap returned results
const MAX_FILE_HINTS    = 8;     // cap file hints passed to L2

/** QB-25: the supported history size — recall latency is measured at this many outcomes. */
const SUPPORTED_HISTORY = DEFAULTS.retention.outcomes;

/** A store whose namespace is always `repo`'s, whatever repository path a call names. */
function boundStore(store, repo) {
  return Object.fromEntries(Object.entries(store).map(([k, fn]) => [k,
    typeof fn === 'function' && k !== 'repoIdentity' ? (_repoPath, ...rest) => fn(repo, ...rest) : fn]));
}

/**
 * A memory bound to one store (QB-25). The store path is injected here
 * (createMemory({ root })) or, for the default memory, resolved from QB_MEMORY_DIR
 * each time it is used — never captured at import.
 * @param {object} [opts] { root, retention, maxScan, onWarning, lock } or { store }
 * @param {string} [opts.namespaceRepo] QB-28 re-review: a FROZEN repository identity for the
 *   store namespace. Every store read/write uses this path's namespace, while file-existence
 *   and revision checks still run against the repoPath each call is given (e.g. a fresh
 *   benchmark checkout of the same commit). Without it the namespace is repoPath's own.
 */
function createMemory(opts = {}) {
const baseStore = opts.store || createStore(opts);
const store = opts.namespaceRepo ? boundStore(baseStore, opts.namespaceRepo) : baseStore;

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
async function remember(repoPath, contract, report, execution = null, { history = null, runId = null, baseSha = null } = {}) {
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
    ...(baseSha ? { base_sha: baseSha } : {}),
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
      criterion_text:   criterionText(contract, link.criterion_id),
      ...(baseSha ? { base_sha: baseSha } : {}),
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
  return recallFilesDetailed(repoPath, goal).hints;
}

// QB-24: trust tiers, never mixed — hints from runs that passed come first, then hints from
// failed runs, then from opposite-intent tasks, then plain churn. Each hint says which.
const TIERS = ['resolved_run', 'failed_run', 'opposite_intent', 'churn'];

/**
 * File hints with what was rejected (QB-24). A hint must be a plain repository-relative
 * path that exists in the current checkout (no absolute path, no "..", no escape through
 * a symlink); a run whose base revision is incompatible with the checkout contributes
 * nothing. Lexical overlap with the task is a hint only.
 * @returns {{ hints: Array<{file, score, reason, tier}>, rejected: Array<{file, reason}> }}
 */
function recallFilesDetailed(repoPath, goal) {
  const query     = intentOf(goal || '');
  const outcomes  = store.readOutcomes(repoPath);
  const rev       = revisionChecker(repoPath);
  const rejected  = new Map();
  const ok = (file) => {
    const why = hintProblem(repoPath, file);
    if (why) { if (!rejected.has(file)) rejected.set(file, why); return false; }
    return true;
  };

  const fileScores = {};
  const put = (file, tier, similarity, reason) => {
    const cur = fileScores[file];
    const better = !cur || TIERS.indexOf(tier) < TIERS.indexOf(cur.tier) || (tier === cur.tier && similarity > cur.similarity);
    if (better) fileScores[file] = { ...(cur || { hits: 0 }), tier, similarity, reason };
  };

  // Signal 1: files changed in similar past tasks, by the trust of the run that changed them
  for (const outcome of outcomes) {
    if (!outcome.changed_files?.length) continue;
    const cmp = compareIntent(query, intentOf(outcome.goal));
    if (cmp.score < RECALL_THRESHOLD) continue;
    const r = rev(outcome.base_sha);
    if (r === 'stale') { for (const f of outcome.changed_files) if (!rejected.has(f)) rejected.set(f, 'stale_revision'); continue; }
    const tier = !cmp.actionable ? 'opposite_intent' : outcome.verdict === 'pass' ? 'resolved_run' : 'failed_run';
    const label = tier === 'resolved_run' ? 'changed in a passing run for a similar task'
      : tier === 'failed_run' ? `changed in a failed run (${outcome.verdict}) for a similar task — not proven relevant`
        : `changed for an ${cmp.conflicting ? 'OPPOSITE' : 'AMBIGUOUS'}-intent task — lexical hint only`;
    for (const file of outcome.changed_files) {
      if (!ok(file)) continue;
      put(file, tier, cmp.score, `${label} (sim=${cmp.score.toFixed(2)}${r === 'unknown' ? ', revision unknown' : ''})`);
    }
  }

  // Signal 2: frequently changed files (high churn awareness), any verdict — recomputed
  // from records on COMPATIBLE (or unrecorded) revisions only, so a stale-revision record
  // can never re-enter through the fallback (QB-24 re-review). file_stats.json is not used.
  const churn = new Map();
  for (const outcome of outcomes) {
    if (!outcome.changed_files?.length || rev(outcome.base_sha) === 'stale') continue;
    for (const f of outcome.changed_files) churn.set(f, (churn.get(f) || 0) + 1);
  }
  for (const [file, hits] of churn) {
    if (!ok(file)) continue;
    if (!fileScores[file]) fileScores[file] = { tier: 'churn', similarity: 0, hits: 0, reason: null };
    fileScores[file].hits = hits;
    if (fileScores[file].tier === 'churn') fileScores[file].reason = `high-churn file (${hits} past change(s) in runs on compatible or unrecorded revisions, any verdict)`;
  }

  const hints = Object.entries(fileScores)
    .map(([file, s]) => ({ file, tier: s.tier, score: s.similarity + (s.hits * 0.01), reason: s.reason }))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.score - a.score)
    .slice(0, MAX_FILE_HINTS);
  return { hints, rejected: [...rejected].map(([file, reason]) => ({ file, reason })) };
}

/** Why a remembered file hint cannot be used in this checkout, or null (QB-24). */
function hintProblem(repoPath, file) {
  if (typeof file !== 'string' || !file || /[\u0000-\u001f]/.test(file)) return 'invalid';
  if (path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)) return 'absolute';
  if (file.split(/[\\/]/).some((seg) => seg === '..')) return 'traversal';
  let root;
  try { root = fs.realpathSync(repoPath); } catch { return 'missing'; }
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return 'missing';
  let real;
  try { real = fs.realpathSync(abs); } catch { return 'missing'; }
  if (real !== root && !real.startsWith(root + path.sep)) return 'traversal';   // escapes through a symlink
  return null;
}

/**
 * Revision compatibility (QB-24): a record's base revision must be the checkout's HEAD or
 * one of its ancestors. Unknown to the repository, or on an unrelated history → stale.
 * No recorded revision, or no git repository → unknown (allowed, labelled).
 */
function revisionChecker(repoPath) {
  let head;
  const cache = new Map();
  return (sha) => {
    if (!sha) return 'unknown';
    if (head === undefined) {
      const r = git(['rev-parse', '--verify', '-q', 'HEAD'], repoPath, { allowFail: true });
      head = r.status === 0 ? String(r.stdout).trim() : null;
    }
    if (!head) return 'unknown';
    if (sha === head) return 'compatible';
    if (!cache.has(sha)) {
      const r = git(['merge-base', '--is-ancestor', sha, head], repoPath, { allowFail: true });
      cache.set(sha, r.status === 0 ? 'compatible' : 'stale');
    }
    return cache.get(sha);
  };
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
  return recallRepairsDetailed(repoPath, criteria).usable;
}

/**
 * Repairs that may be reused automatically, and why the other relevant ones may not
 * (QB-24). A repair is reused only when:
 *   - its outcome is recalled at all (QB-23: resolved, observed, legacy);
 *   - its criterion's INTENT is known (the criterion text was recorded) and is the same as
 *     the current criterion's — an opposite instruction ("does not run" vs "runs") is
 *     `conflicting_intent`, never reused;
 *   - its base revision is not incompatible with the checkout (`stale_revision`).
 * @returns {{ usable: Array, excluded: Array<{criterion_id, record_id, status, reason, score}> }}
 */
function recallRepairsDetailed(repoPath, criteria = []) {
  const usable = [];
  const excluded = [];
  if (!criteria.length) return { usable, excluded };
  const repairs = store.readRepairs(repoPath);
  if (!repairs.length) return { usable, excluded };
  const rev = revisionChecker(repoPath);

  for (const ac of criteria) {
    const queryKws = tokenize(ac.criterion || '');
    const query = intentOf(ac.criterion || '');
    let best = null;
    for (const rec of repairs) {
      const status = repairStatus(rec);
      if (!RECALLED.has(status)) continue;               // failed / abandoned suggestions are not recalled as fixes
      const sim = scoreRepair(queryKws, rec);
      if (sim < RECALL_THRESHOLD) continue;
      const exclude = (reason) => excluded.push({ criterion_id: ac.id, record_id: rec.id, status, reason, score: sim });
      if (typeof rec.criterion_text !== 'string' || !rec.criterion_text.trim()) { exclude('intent_unknown'); continue; }
      const cmp = compareIntent(query, intentOf(rec.criterion_text));
      if (cmp.conflicting) { exclude('conflicting_intent'); continue; }
      if (!cmp.actionable) { exclude('ambiguous_intent'); continue; }   // compound ambiguity is never actionable (QB-24 re-review)
      const revision = rev(rec.base_sha);
      if (revision === 'stale') { exclude('stale_revision'); continue; }
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
          intent:       'same',
          revision,
          ...(rec.schema === 2 ? { from_run: rec.run_id ?? null, patch_after_sha256: rec.patch_after_sha256 ?? null } : {}),
        };
      }
    }
    if (best) usable.push(best);
  }

  return { usable: usable.sort((a, b) => b.score - a.score), excluded };
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
  const query    = intentOf(goal || '');
  const outcomes = store.readOutcomes(repoPath);

  // QB-24: negation is preserved — an opposite-intent past run is labelled and never scores 1
  return outcomes
    .map(o => { const c = compareIntent(query, intentOf(o.goal)); return { ...o, score: c.score, intent: c.conflicting ? 'conflicting' : c.relation === 'ambiguous' ? 'ambiguous' : 'same' }; })
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
    ...store.health(repoPath),           // QB-25: corrupt records (line, offset, reason) and quarantined lines
  };
}

  return { remember, recallFiles, recallFilesDetailed, recallRepairs, recallRepairsDetailed, recallPrior, stats, repairStatus };
}

const defaultMemory = createMemory();
module.exports = { ...defaultMemory, createMemory, SUPPORTED_HISTORY };
