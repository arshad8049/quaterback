/**
 * bench/schemas.js — the shared, versioned records of the Phase 4 evaluation harness
 * (QB-27..QB-30). Agreed BEFORE the grader (QB-27) and the experiment store/report
 * (QB-29) were built on them; changing a schema means a new version string.
 *
 *   qb-task-spec/1     a frozen, human-written task: prompt, semantic requirement, hidden suite
 *   qb-spec-lock/1     spec id → version + content hash (bench/specs.lock.json)
 *   qb-experiment/1    the manifest: pinned artifacts, tasks, arms, budgets, trial plan, approval
 *   qb-trial-result/1  one arm of one trial: status, hashed artifacts, usage, memory isolation
 *   qb-grade/1         the external grader's result for one patch
 *   qb-adjudication/1  one blinded adjudicator's verdict on one item
 *
 * Hashes are sha256 over canonical JSON (sorted keys) or raw bytes. They detect
 * corruption and tampering by anyone who does not also rewrite the hash; they are not
 * signatures. See docs/bench/schemas.md.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { _internal: { canonical } } = require('../run/store');

// ── Hashing ───────────────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Hash of a JSON value, independent of key order. */
const hashOf = (value) => sha256(canonical(value));
const sha256File = (file) => sha256(fs.readFileSync(file));

/** Every regular file under `dir` (sorted, POSIX-relative) → sha256. Symlinks are refused. */
function fileHashes(dir) {
  const out = {};
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new Error(`symlink not allowed in a hashed tree: ${r}`);
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out[r] = sha256File(path.join(dir, r));
    }
  };
  walk('');
  return out;
}
/** One hash for a whole tree: the canonical map of its file hashes. */
const treeHash = (dir) => hashOf(fileHashes(dir));

// ── Shared vocabulary ─────────────────────────────────────────────────────────

const Sha = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex');
const Commit = z.string().regex(/^[0-9a-f]{40}$/, 'full 40-hex commit');
const Iso = z.string().datetime({ offset: true });
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const RelPath = z.string().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\') && !p.includes('\0'), 'relative POSIX path inside its root');
/** A measured quantity that may honestly be unknown — never coerced to 0 (QB-21). */
const Measured = (t) => z.union([t, z.literal('unknown')]);

const TASK_TYPES = ['addition', 'bug_fix', 'integration', 'refactor', 'state', 'errors', 'already_satisfied'];
const ARM_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** Grader outcomes. Only pass/fail are scores; the error outcomes are attrition, never scores. */
const GRADE_OUTCOMES = ['pass', 'fail', 'needs_adjudication', 'grader_error', 'infra_error'];
const SCORED_OUTCOMES = ['pass', 'fail'];
const TRIAL_STATUSES = ['completed', 'missing', 'agent_error', 'infra_error', 'timeout'];

// ── qb-task-spec/1 ────────────────────────────────────────────────────────────

const Qualification = z.object({
  grader_sha256: Sha,                       // the grader code the suite was qualified with
  suite_sha256:  Sha,                       // treeHash of the suite at qualification
  reference: z.object({ patch_sha256: Sha, outcome: z.literal('pass') }),
  incorrect: z.array(z.object({ label: z.string().min(1), patch_sha256: Sha, outcome: z.literal('fail') })).min(2),
  qualified_at: Iso,
}).strict();

const TaskSpec = z.object({
  schema:  z.literal('qb-task-spec/1'),
  id:      Id,
  version: z.number().int().min(1),
  split:   z.enum(['dev', 'holdout']),
  stratum: z.object({ type: z.enum(TASK_TYPES), repository: z.string().min(1) }).strict(),
  repo: z.object({
    source:    z.string().min(1),                      // path or URL of the task repository
    base_rev:  Commit,
    lockfiles: z.record(RelPath, Sha),                 // dependency lockfiles at base_rev
  }).strict(),
  prompt:      z.string().min(1),    // the ONLY task text every arm's agent sees
  requirement: z.string().min(1),    // the human semantic requirement: for graders/adjudicators, never sent to an agent
  // QB-13 oracle for the contract arms (C–F): human-written criteria and checks. Never contains hidden-suite content.
  oracle: z.object({
    approved_by: z.string().min(1),
    acceptance_criteria: z.array(z.object({ id: z.string(), criterion: z.string(), kind: z.string().optional() }).passthrough()).min(1),
    checks: z.array(z.any()).optional(),
  }).passthrough().nullable(),
  suite: z.object({
    dir:       RelPath,                                // relative to bench/suites/ — outside every task repository
    files:     z.record(RelPath, Sha),
    command:   z.array(z.string().min(1)).min(1),       // argv, run in the grading sandbox
    install_to: RelPath,                               // where in the graded tree the suite is copied
    owned_paths: z.array(z.string().min(1)).min(1),    // globs a patch may not touch (grader-owned)
    adjudicate_checks: z.array(z.string().min(1)).default([]),   // the ONLY checks that may yield needs_adjudication
  }).strict(),
  qualification: Qualification.nullable(),             // required to freeze
  adjudication_rules: z.string().min(1),
  provenance: z.object({
    author: z.string().min(1),
    created_at: Iso,
    tuned_during_development: z.boolean(),
    notes: z.string().optional(),
  }).strict(),
  changelog: z.array(z.object({ version: z.number().int().min(1), reason: z.string().min(1), disclosed_at: Iso,
    after_viewing_results: z.boolean() }).strict()).default([]),
}).strict();

const SpecLock = z.object({
  schema: z.literal('qb-spec-lock/1'),
  specs: z.record(Id, z.object({ version: z.number().int().min(1), sha256: Sha, split: z.enum(['dev', 'holdout']), frozen_at: Iso }).strict()),
}).strict();

// ── qb-experiment/1 ───────────────────────────────────────────────────────────

const ArmDefinition = z.object({
  id: z.enum(ARM_IDS),
  adds: z.string().min(1),
  contract: z.enum(['none', 'oracle_approved']),
  feedback: z.enum(['none', 'visible_tests', 'qb_verifier']),
  context:  z.boolean(),
  memory:   z.enum(['off', 'on']),
  max_attempts: z.number().int().min(1),
}).strict();

const Approval = z.object({
  approver:           z.string().min(1),
  approved_at:        Iso,
  protocol_sha256:    Sha,     // exactly the protocol document that was reviewed
  holdout_set_sha256: Sha,     // exactly the holdout specs that were reviewed (holdoutSetHash)
  note: z.string().optional(),
}).strict();

const Experiment = z.object({
  schema: z.literal('qb-experiment/1'),
  experiment_id: Id,
  kind: z.enum(['official', 'exploratory']),
  created_at: Iso,
  protocol: z.object({ path: RelPath, sha256: Sha }).strict().nullable(),
  approval: Approval.nullable(),
  pins: z.object({
    qb: z.object({ commit: Commit, dirty: z.boolean(), dirty_patch_sha256: Sha.nullable() }).strict(),
    agent: z.object({ name: z.string().min(1), adapter_version: z.string().min(1), cli_version: Measured(z.string().min(1)) }).strict(),
    images: z.record(z.string().min(1), z.object({ ref: z.string().min(1), digest: Measured(z.string().regex(/^sha256:[0-9a-f]{64}$/)) }).strict()),
    node: z.string().min(1),
    grader: z.object({ files: z.record(RelPath, Sha) }).strict(),
    models: z.array(z.object({ role: z.string().min(1), requested: z.string().min(1) }).strict()),
  }).strict(),
  tasks: z.array(z.object({ id: Id, version: z.number().int().min(1), spec_sha256: Sha, split: z.enum(['dev', 'holdout']),
    repo_commit: Commit, lockfiles: z.record(RelPath, Sha) }).strict()).min(1),
  arms: z.array(ArmDefinition).min(1),
  primary_comparison: z.tuple([z.enum(ARM_IDS), z.enum(ARM_IDS)]),
  budget: z.object({
    agent_time_ms:          z.number().int().positive(),   // the SAME total agent wall-clock for every arm
    trial_deadline_ms:      z.number().int().positive(),   // overall deadline per arm-trial (all stages)
    model_call_deadline_ms: z.number().int().positive(),
    total_compute_controlled: z.literal(false),            // stated, not implied
  }).strict(),
  memory: z.object({ starting_store_sha256: Sha.nullable() }).strict(),
  trial_plan: z.object({
    seed: z.string().min(1),
    repetitions: z.number().int().min(1),
    order: z.array(z.object({ trial_id: Id, task_id: Id, repetition: z.number().int().min(1), arm: z.enum(ARM_IDS) }).strict()).min(1),
  }).strict(),
  config: z.record(z.string(), z.any()),
  config_sha256: Sha,
}).strict();

// ── qb-trial-result/1 ─────────────────────────────────────────────────────────

const Artifact = z.object({ path: RelPath, sha256: Sha }).strict();   // path relative to the experiment directory

const TrialResult = z.object({
  schema: z.literal('qb-trial-result/1'),
  experiment_id: Id,
  trial_id: Id,
  task_id: Id,
  repetition: z.number().int().min(1),
  arm: z.enum(ARM_IDS),
  status: z.enum(TRIAL_STATUSES),
  detail: z.string().optional(),
  started_at: Iso,
  finished_at: Iso,
  elapsed_ms: z.number().int().nonnegative(),
  artifacts: z.record(z.string().min(1), Artifact),     // patch, grade, run_record, usage, …
  internal_verdict: z.string().nullable(),              // QB's own L4 verdict — recorded, never the score
  grade_outcome: z.enum(GRADE_OUTCOMES).nullable(),     // from the grade artifact; null when not graded
  usage: z.object({
    agent_ms: Measured(z.number().int().nonnegative()),
    model_calls: Measured(z.number().int().nonnegative()),
    tokens: Measured(z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict()),
    cost_usd: Measured(z.number().nonnegative()),
    human_approval_ms: Measured(z.number().int().nonnegative()),
    models_returned: z.array(z.object({ role: z.string(), requested: z.string(), returned: Measured(z.string().min(1)) }).strict()),
  }).strict(),
  memory: z.object({
    mode: z.enum(['off', 'on']),
    store_sha256_before: Sha.nullable(),
    recall_calls: z.number().int().nonnegative(),
    persist_calls: z.number().int().nonnegative(),
  }).strict(),
}).strict();

// ── qb-grade/1 ────────────────────────────────────────────────────────────────

const Grade = z.object({
  schema: z.literal('qb-grade/1'),
  task_id: Id,
  spec_sha256: Sha,
  patch_sha256: Sha,
  grader_sha256: Sha,
  outcome: z.enum(GRADE_OUTCOMES),
  // why: tests_passed | tests_failed | patch_does_not_apply | grader_owned_path | syntax_or_load_error
  //      | adjudication_required | suite_error | infra_error | timeout | oom
  reason: z.string().min(1),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'skipped', 'adjudicate']) }).strict()),
  environment: z.object({ network: z.literal('none'), credentials: z.literal('none'), image: z.string().min(1) }).strict(),
  duration_ms: z.number().int().nonnegative(),
  detail: z.string().optional(),
}).strict();

// ── qb-adjudication/1 ─────────────────────────────────────────────────────────

const Adjudication = z.object({
  schema: z.literal('qb-adjudication/1'),
  experiment_id: Id,
  item_id: Id,          // blinded: maps to (trial, arm) only through the separately stored blind map
  adjudicator: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unsure']),
  rationale: z.string().min(1),
  at: Iso,
}).strict();

/** The hash an approval must name: the exact holdout specs (id, version, content hash). */
function holdoutSetHash(tasks) {
  return hashOf(tasks.filter((t) => t.split === 'holdout').map((t) => ({ id: t.id, version: t.version, sha256: t.spec_sha256 }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

module.exports = {
  TaskSpec, SpecLock, Experiment, ArmDefinition, Approval, TrialResult, Grade, Adjudication,
  TASK_TYPES, ARM_IDS, GRADE_OUTCOMES, SCORED_OUTCOMES, TRIAL_STATUSES,
  sha256, hashOf, sha256File, fileHashes, treeHash, holdoutSetHash,
};
