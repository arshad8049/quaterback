const { z } = require('zod');

const AcceptanceCriterion = z.object({
  id: z.string(),
  criterion: z.string(),
  met: z.boolean().nullable()
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
  clarifying_question: z.string().nullable()
});

// Partial schema for when compiler returns a clarifying question instead of full contract
const ClarifyingResponseSchema = z.object({
  ambiguity_flags: z.array(z.string()),
  clarifying_question: z.string()
});

module.exports = { TaskContractSchema, ClarifyingResponseSchema, AcceptanceCriterion };
