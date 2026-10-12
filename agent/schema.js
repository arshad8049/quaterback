const { z } = require('zod');
const { AGENT_IDS } = require('./adapters');

const FileChangeSchema = z.object({
  file:      z.string(),
  status:    z.enum(['A', 'M', 'D', 'R', 'C', 'T']).optional(),
  old_file:  z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary:    z.boolean().optional(),
});

// Execution states are distinct outcomes (QB-22): an agent that crashed or
// timed out is never reported as a dry run or as "nothing changed".
// Sandbox states (QB-02, agent-sandbox.md §8.4): oom, infra_error and setup_failed
// are failures; blocked (setup gate, auth, Docker unavailable) and unresolved
// (capture could not be faithful) can never be approved.
const EXECUTION_STATUSES = ['completed', 'no_change', 'dry_run', 'execution_error', 'timeout', 'cancelled',
  'oom', 'infra_error', 'setup_failed', 'blocked', 'unresolved'];
const FAILED_EXECUTION   = new Set(['execution_error', 'timeout', 'cancelled', 'oom', 'infra_error', 'setup_failed']);

const ExecutionResultSchema = z.object({
  id:           z.string().uuid(),
  contract_id:  z.string(),
  context_id:   z.string().nullable(),
  agent_used:   z.enum(AGENT_IDS),                 // the adapter registry (agent/adapters.js, QB-31)
  status:       z.enum(EXECUTION_STATUSES),
  duration_ms:  z.number().int().nonnegative(),
  generated_at: z.string().datetime(),
  briefing:     z.string(),
  changes:      z.array(FileChangeSchema),
  diff:         z.string().nullable(),
  unsupported_changes: z.array(z.string()).default([]),
  base_tree:      z.string().nullable().default(null),
  candidate_tree: z.string().nullable().default(null),
  exit_code:    z.number().int().nullable().default(null),
  signal:       z.string().nullable().default(null),
  stderr_tail:  z.string().nullable().default(null),
  error:        z.string().nullable().optional(),
  sandbox:      z.record(z.string(), z.any()).nullable().optional(),
});

module.exports = { ExecutionResultSchema, FileChangeSchema, EXECUTION_STATUSES, FAILED_EXECUTION };
