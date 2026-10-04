const { z } = require('zod');

const OutcomeRecordSchema = z.object({
  id:            z.string().uuid(),
  ts:            z.string(),
  repo_path:     z.string(),
  goal:          z.string(),
  keywords:      z.array(z.string()),
  verdict:       z.enum(['pass', 'fail', 'partial', 'no-diff', 'error', 'unresolved']),
  attempts:      z.number().int().min(1),
  changed_files: z.array(z.string()),
  ac_count:      z.number().int(),
  duration_ms:   z.number(),
  contract_id:   z.string().optional(),
  // QB-23: the append-only attempt history of this run (patch and evidence hashes)
  run_id:          z.string().optional(),
  attempt_history: z.array(z.object({
    attempt: z.number().int().min(1), patch_sha256: z.string().nullable(), evidence_sha256: z.string(),
    report_id: z.string().nullable(), verdict: z.string().nullable(), oracle_approved: z.boolean(),
  })).optional(),
});

const RepairRecordSchema = z.object({
  id:                z.string().uuid(),
  ts:                z.string(),
  repo_path:         z.string(),
  goal_keywords:     z.array(z.string()),
  failed_criterion:  z.string(),
  crit_keywords:     z.array(z.string()),
  diagnosis:         z.string(),
  fix:               z.string(),
  resolved:          z.boolean(),
  contract_id:       z.string().optional(),
  // QB-23 (schema 2): the hint linked to the patch that followed it and its re-evaluation.
  // Records without `schema` are legacy: their `resolved` was never established.
  schema:            z.literal(2).optional(),
  run_id:            z.string().nullable().optional(),
  source:            z.literal('model_suggestion').optional(),
  outcome:           z.enum(['resolved', 'observed_resolved_unconfirmed', 'unresolved', 'not_attempted', 'not_tracked']).optional(),
  reason:            z.string().optional(),
  from_attempt:      z.number().int().optional(),
  to_attempt:        z.number().int().nullable().optional(),
  patch_before_sha256: z.string().nullable().optional(),
  patch_after_sha256:  z.string().nullable().optional(),
  evidence_before_sha256: z.string().nullable().optional(),
  evidence_after_sha256:  z.string().nullable().optional(),
  before:            z.object({ met: z.boolean().nullable(), method: z.string().nullable(), evidence_ids: z.array(z.string()) }).nullable().optional(),
  after:             z.object({ met: z.boolean().nullable(), method: z.string().nullable(), evidence_ids: z.array(z.string()) }).nullable().optional(),
  final:             z.object({ attempt: z.number().int(), verdict: z.string().nullable(), oracle_approved: z.boolean() }).nullable().optional(),
});

module.exports = { OutcomeRecordSchema, RepairRecordSchema };
