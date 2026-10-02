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
});

module.exports = { OutcomeRecordSchema, RepairRecordSchema };
