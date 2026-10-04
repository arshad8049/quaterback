const { z } = require('zod');

const AcceptanceCriterion = z.object({
  id: z.string(),
  criterion: z.string(),
  met: z.boolean().nullable(),
  // QB-16: behavioural criteria need an executed check; only non_behavioral ones
  // (documentation, naming, wording) may be decided by the judge.
  kind: z.enum(['behavioral', 'non_behavioral']).optional(),
  requirement_ids: z.array(z.string()).optional(),   // QB-14
  preserves: z.unknown().optional(),                 // QB-15: validated by verify/preservation.js
});

const TaskContractSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  raw_request: z.string(),
  repo_path: z.string().nullable(),
  goal: z.string().min(1),
  required_behavior: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  acceptance_criteria: z.array(AcceptanceCriterion).min(1),
  verification_plan: z.array(z.string()).min(1),
  relevant_context: z.array(z.string()),
  ambiguity_flags: z.array(z.string()),
  clarifying_question: z.string().nullable(),
  // QB-16: executable checks accepted by the registry (verify/checks/registry.js), and
  // the ones it rejected (never run). Absent on contracts made before QB-16.
  checks: z.array(z.object({ id: z.string(), ac_id: z.string(), adapter: z.string(), params: z.unknown(),
    plan_item: z.number().int().nonnegative().optional() })).optional(),
  checks_rejected: z.array(z.object({ check: z.unknown(), reason: z.string() })).optional(),
  checks_registry: z.string().optional(),
  // QB-09: enforced scope and per-constraint enforcement (verify/policy.js).
  scope: z.object({ allowed_changes: z.array(z.string()).optional(), protected_paths: z.array(z.string()).optional() }).optional(),
  constraint_policy: z.array(z.unknown()).optional(),
  requirements: z.array(z.unknown()).optional(),     // QB-14: validated by intent/requirements.js
  test_policy: z.unknown().optional(),               // QB-10: validated by verify/tests.js testPolicyErrors
  proposed_defaults: z.array(z.unknown()).optional(), // QB-17: validated by intent/requirements.js
  incomplete: z.array(z.string()).optional(),        // QB-17: what the compiler output lacked (set by QB) → invalid
});

// Partial schema for when compiler returns a clarifying question instead of full contract
const ClarifyingResponseSchema = z.object({
  ambiguity_flags: z.array(z.string()),
  clarifying_question: z.string()
});

module.exports = { TaskContractSchema, ClarifyingResponseSchema, AcceptanceCriterion };
