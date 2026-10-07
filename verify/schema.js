const { z } = require('zod');

const CriterionResultSchema = z.object({
  id:        z.string(),
  criterion: z.string(),
  met:       z.boolean().nullable(),
  method:    z.enum(['deterministic', 'llm', 'test-runner', 'no-diff', 'not-run', 'llm-vote-3', 'llm-vote-5', 'check', 'no-check']),
  evidence:  z.string(),
  votes:     z.array(z.boolean().nullable()).optional(),
  repair:    z.string().nullable().optional(),
  vote_status:     z.array(z.enum(['ok', 'invalid_judgment', 'error'])).optional(),   // QB-07
  judgment_status: z.enum(['ok', 'invalid_judgment', 'error', 'not_judged']).optional(),
  refs:            z.array(z.string()).optional(),
  check_status:    z.enum(['passed', 'failed', 'error', 'unresolved']).optional(),   // QB-16
  checks:          z.array(z.object({ id: z.string(), status: z.enum(['pass', 'fail', 'error']), detail: z.string().optional() })).optional(),
  judgment_cache:   z.enum(['hit', 'miss', 'wait_timeout', 'cancelled']).optional(),                              // QB-15
  evidence_ids:     z.array(z.string()).optional(),                                  // QB-11: what the judgment was based on
  evidence_missing: z.array(z.object({ what: z.string(), reason: z.string() })).optional(),
});

const EvidenceItemSchema = z.object({                                                  // QB-11 manifest (no contents)
  id: z.string().regex(/^EV-[0-9a-f]{12}$/), kind: z.enum(['hunk', 'definition', 'file', 'check']),
  file: z.string().nullable(), range: z.tuple([z.number().int(), z.number().int()]).nullable(),
  source: z.enum(['diff', 'candidate_tree', 'check_run']), tree: z.string().nullable(), blob: z.string().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), material: z.boolean(),
});

const ChecksReportSchema = z.object({                                                  // QB-16
  registry:  z.string().nullable(),
  requested: z.array(z.object({ id: z.string(), ac_id: z.string(), adapter: z.string() })),
  results:   z.array(z.object({ id: z.string(), ac_id: z.string(), adapter: z.string(), status: z.enum(['pass', 'fail', 'error']),
    detail: z.string(), observed: z.string().optional(), duration_ms: z.number().int().nullable() })),
  rejected:  z.array(z.object({ id: z.string().nullable(), reason: z.string() })),
  error:     z.string().nullable(),
});
const PlanItemStatusSchema = z.object({ item: z.string(), checks: z.array(z.string()), status: z.enum(['passed', 'failed', 'error', 'not_executed']) });

const FailingTestSchema = z.object({ file: z.string().nullable(), path: z.array(z.string()).nullable().optional(), name: z.string(),
  failureType: z.string().nullable(), error: z.string(), changed_failure: z.boolean().optional() });
const TestOutcomeSchema = z.object({                                                // QB-06
  outcome:     z.enum(['passed', 'failed', 'preexisting_failures', 'error', 'not_run']),
  reason:      z.string(),
  runner:      z.string().nullable(),
  exit_code:   z.number().int().nullable(),
  state:       z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  tree:        z.string().nullable().optional(),      // QB-22: the source tree the tests ran on
  detail:      z.string().optional(),                 // QB-20: why tests were not run (e.g. unsupported runner)
  regressions: z.array(FailingTestSchema).optional(),   // QB-10 (display-bounded; totals below)
  regressions_total: z.number().int().nonnegative().optional(),
  preexisting: z.array(FailingTestSchema).optional(),
  preexisting_total: z.number().int().nonnegative().optional(),
  baseline:    z.string().optional(),
  preexisting_policy: z.enum(['block', 'waive']).optional(),
});

const JudgmentMaterialSchema = z.object({            // QB-22: what a no-change judgment was based on
  source: z.literal('sandbox_snapshot'),
  tree:   z.string(),
  files:  z.array(z.object({ path: z.string(), oid: z.string() })),
});

const TestResultsSchema = z.object({
  passed:  z.number().int().nonnegative(),
  failed:  z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  output:  z.string().nullable().optional(),
});

const RepairHintSchema = z.object({
  criterion_id: z.string(),
  diagnosis:    z.string(),
  suggested_fix: z.string(),
});

const VerificationReportSchema = z.object({
  id:               z.string().uuid(),
  contract_id:      z.string(),
  execution_id:     z.string().nullable(),
  generated_at:     z.string().datetime(),
  verdict:          z.enum(['pass', 'fail', 'partial', 'no-diff', 'error', 'unresolved']),
  contract_state:   z.string().optional(),       // set when the contract was not finalized (QB-08)
  criteria_results: z.array(CriterionResultSchema),
  failures:         z.array(z.string()),
  test_results:     TestResultsSchema.nullable(),
  test_outcome:     TestOutcomeSchema.optional(),
  judgment_material: JudgmentMaterialSchema.optional(),
  evidence:         z.array(EvidenceItemSchema).optional(),
  outcomes:         z.object({ execution: z.string(), policy: z.string(), tests: z.string(), criteria: z.string() }).optional(),   // QB-10
  oracle:           z.object({ approved: z.boolean(), reason: z.string(), contract_hash: z.string(), via: z.string().nullable() }).optional(),   // QB-13
  checks:           ChecksReportSchema.optional(),
  policy:           z.object({                                                       // QB-09
    allowed_changes: z.array(z.string()), protected_paths: z.array(z.string()), changed_files: z.array(z.string()),
    out_of_scope: z.array(z.string()), protected_touched: z.array(z.string()),
    constraints: z.array(z.object({ index: z.number().int(), text: z.string(), status: z.enum(['enforced', 'violated', 'unresolved', 'advisory']),
      by: z.array(z.string()), detail: z.string().optional() })),
    effect: z.enum(['ok', 'fail', 'unresolved']),
  }).optional(),
  verification_plan_status: z.array(PlanItemStatusSchema).optional(),
  scope_violations: z.array(z.string()),
  repair_hints:     z.array(RepairHintSchema),
});

module.exports = { VerificationReportSchema, CriterionResultSchema, RepairHintSchema };
