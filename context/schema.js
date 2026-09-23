const { z } = require('zod');

const RelevantFileSchema = z.object({
  path:     z.string(),
  reason:   z.string(),
  symbols:  z.array(z.string()),
  imports:  z.array(z.string()),
  test_file: z.string().nullable(),
  content:  z.string().optional(),
});

const ContextPackageSchema = z.object({
  id:           z.string(),
  contract_id:  z.string(),
  repo_path:    z.string(),
  generated_at: z.string(),

  patterns: z.object({
    language:     z.string().nullable(),
    framework:    z.string().nullable(),
    test_runner:  z.string().nullable(),
    architecture: z.string().nullable(),
  }),

  relevant_files: z.array(RelevantFileSchema),

  symbol_map: z.record(z.string(), z.string()),

  test_coverage: z.object({
    covered_files:   z.array(z.string()),
    test_files:      z.array(z.string()),
    uncovered_files: z.array(z.string()),
  }),

  git_context: z.object({
    recent_changes: z.array(z.object({
      file:         z.string(),
      commits:      z.number(),
      last_changed: z.string(),
    })),
  }),

  agent_brief: z.string().nullable(),
});

module.exports = { ContextPackageSchema, RelevantFileSchema };
