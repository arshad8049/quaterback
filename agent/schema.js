const { z } = require('zod');

const FileChangeSchema = z.object({
  file:      z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

const ExecutionResultSchema = z.object({
  id:           z.string().uuid(),
  contract_id:  z.string(),
  context_id:   z.string().nullable(),
  agent_used:   z.enum(['claude-code', 'dry-run', 'manual']),
  status:       z.enum(['completed', 'dry-run', 'failed']),
  duration_ms:  z.number().int().nonnegative(),
  generated_at: z.string().datetime(),
  briefing:     z.string(),
  changes:      z.array(FileChangeSchema),
  diff:         z.string().nullable(),
  error:        z.string().nullable().optional(),
});

module.exports = { ExecutionResultSchema, FileChangeSchema };
