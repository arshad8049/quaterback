/**
 * run/schema.js — versioned run / evidence record (QB-38).
 *
 * One RunManifest per invocation ties together the input request, the
 * pinned base snapshot, every attempt (patch + checks + report), and the
 * final outcome. Model output never writes these fields directly; they are
 * filled by trusted application code.
 *
 * Bump SCHEMA_VERSION when a field changes meaning and add a migration +
 * test in run/store.js / test/unit/run-store.test.js.
 */

const { z } = require('zod');

const SCHEMA_VERSION = 1;

// Lifecycle + decision outcomes (review p.6). RUNNING is the only non-terminal state.
const OUTCOMES = [
  'RUNNING',
  'VERIFIED', 'FAILED', 'UNRESOLVED', 'ERROR',
  'BLOCKED', 'CANCELLED', 'DRY_RUN', 'ABANDONED',
];

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const ArtifactRefSchema = z.object({
  name:   z.string(),
  sha256: Sha256,
  path:   z.string(),          // relative to the run directory
  bytes:  z.number().int().nonnegative(),
});

const CheckResultSchema = z.object({
  check_id:     z.string(),
  status:       z.enum(['pass', 'fail', 'error', 'not_run']),
  exit_code:    z.number().int().nullable(),
  signal:       z.string().nullable(),
  duration_ms:  z.number().int().nonnegative(),
  evidence_ids: z.array(z.string()),
  runner:       z.string().nullable().optional(),
});

const AttemptSchema = z.object({
  attempt:          z.number().int().positive(),
  parent_attempt:   z.number().int().positive().nullable(),
  repair_reason:    z.array(z.string()),
  started_at:       z.string().datetime(),
  finished_at:      z.string().datetime().nullable(),
  base_sha:         z.string().nullable(),
  patch_sha256:     Sha256.nullable(),
  execution_status: z.string().nullable(),
  verdict:          z.string().nullable(),
  checks:           z.array(CheckResultSchema),
  artifacts:        z.record(z.string(), z.string()),   // role → artifact name
});

// Defined now so Phase 2 can attach checks to requirements without a schema bump.
const RequirementSchema = z.object({
  id:            z.string(),
  source_clause: z.string(),
  origin:        z.enum(['explicit', 'inferred', 'proposed']),
  meaning:       z.string(),
  risk:          z.enum(['low', 'medium', 'high']).optional(),
  ac_ids:        z.array(z.string()),
  check_ids:     z.array(z.string()),
  unresolved:    z.array(z.string()),
});

const CheckSpecSchema = z.object({
  id:              z.string(),
  requirement_ids: z.array(z.string()),
  adapter:         z.string(),
  params:          z.record(z.string(), z.unknown()),
  fixture_id:      z.string().nullable(),
  expected:        z.string(),
  timeout_ms:      z.number().int().positive(),
  required:        z.boolean(),
  impl_sha256:     Sha256.nullable(),
});

const RunManifestSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  run_id:         z.string().uuid(),
  kind:           z.enum(['qb', 'bench-qb', 'bench-baseline']),
  qb_revision:    z.string().nullable(),
  request:        z.string(),
  repo: z.object({
    path:     z.string(),
    identity: z.string(),          // sha256 of the resolved real path
    base_sha: z.string().nullable(),
  }),
  agent: z.object({
    type:      z.string(),
    version:   z.string().nullable(),
    isolation: z.string().nullable(),
  }),
  models:         z.record(z.string(), z.string()),
  config:         z.record(z.string(), z.unknown()),
  config_hash:    Sha256,
  contract_hash:  Sha256.nullable(),
  sandbox_policy: z.record(z.string(), z.unknown()).nullable(),
  pid:            z.number().int(),
  started_at:     z.string().datetime(),
  finished_at:    z.string().datetime().nullable(),
  outcome:        z.enum(OUTCOMES),
  legacy_verdict: z.string().nullable(),   // the pre-review pass/fail/partial/no-diff label
  outcome_reason: z.string().nullable(),
  attempts:       z.array(AttemptSchema),
  artifacts:      z.record(z.string(), ArtifactRefSchema),
});

module.exports = {
  SCHEMA_VERSION,
  OUTCOMES,
  RunManifestSchema,
  AttemptSchema,
  CheckResultSchema,
  RequirementSchema,
  CheckSpecSchema,
  ArtifactRefSchema,
};
