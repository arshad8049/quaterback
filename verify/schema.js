const { z } = require('zod');

const CriterionResultSchema = z.object({
  id:        z.string(),
  criterion: z.string(),
  met:       z.boolean().nullable(),
  method:    z.enum(['deterministic', 'llm', 'test-runner', 'no-diff']),
  evidence:  z.string(),
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
  verdict:          z.enum(['pass', 'fail', 'partial', 'no-diff']),
  criteria_results: z.array(CriterionResultSchema),
  failures:         z.array(z.string()),
  test_results:     TestResultsSchema.nullable(),
  scope_violations: z.array(z.string()),
  repair_hints:     z.array(RepairHintSchema),
});

module.exports = { VerificationReportSchema, CriterionResultSchema, RepairHintSchema };
