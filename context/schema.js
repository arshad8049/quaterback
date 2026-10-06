const { z } = require('zod');

const RelevantFileSchema = z.object({
  path:     z.string(),
  reason:   z.string(),
  symbols:  z.array(z.string()),
  imports:  z.array(z.string()),
  test_file: z.string().nullable(),
  content:  z.string().optional(),
  content_truncated: z.boolean().optional(),   // QB-19: the prompt snippet was cut (the index was not)
  index_status: z.enum(['parsed', 'regex', 'unparsable', 'too_large', 'unreadable', 'not_indexed']).optional(),
  retrieval: z.object({                                              // QB-18: why this file is here
    edge:     z.enum(['seed', 'changed', 'import', 'caller', 'fill']),
    depth:    z.number().int().nullable(),
    via:      z.string().nullable(),
    priority: z.number(),
    source:   z.enum(['checkout', 'candidate_tree', 'patch']),
  }).optional(),
});

const RetrievalSchema = z.object({                                     // QB-18: budget, depth, seeds, omissions
  version: z.number().int(), language: z.string(), depth: z.number().int(),
  max_files: z.number().int(), max_bytes: z.number().int(), used_files: z.number().int(), used_bytes: z.number().int(),
  scanned_files: z.number().int(), scan_limit: z.number().int(), scan_truncated: z.number().int(), relevance_cut: z.number(),
  terms: z.object({ identifiers: z.array(z.string()), keywords: z.array(z.string()) }),
  seeds: z.array(z.object({ path: z.string(), reason: z.string() })),
  omitted: z.array(z.object({ path: z.string(), reason: z.string(),
    dropped: z.enum(['below_relevance_cut', 'seed_limit', 'depth_limit', 'max_files', 'max_bytes']) })),
  omitted_total: z.number().int(),
  refreshes: z.array(z.object({ attempt: z.number().int().nullable().optional(), changed: z.array(z.string()), stale: z.array(z.string()),
    added: z.array(z.string()), removed: z.array(z.string()), deleted: z.array(z.string()) })).optional(),
});

const SpanSchema = z.object({ line: z.number().int(), column: z.number().int() });
const SymbolSchema = z.object({                                     // QB-19
  id:        z.string(),                  // <path>#<name>, <path>#<Class>.<method>
  name:      z.string(),
  kind:      z.string(),
  exported:  z.boolean(),
  file:      z.string(),
  span:      z.object({ start: SpanSchema, end: SpanSchema }),
  method:    z.enum(['parser', 'regex']),
  export_span: z.object({ start: SpanSchema, end: SpanSchema }).optional(),
  local:     z.string().optional(),
  exported_as: z.array(z.string()).optional(),
  from:      z.string().optional(),
  static:    z.boolean().optional(),
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

  symbol_map: z.record(z.string(), z.string()),     // qualified ID → "path:line" (QB-19; was bare name)
  symbols_index: z.array(SymbolSchema).optional(),
  index_limits: z.object({
    max_index_bytes: z.number().int(),
    snippet_bytes:   z.number().int(),
    files: z.array(z.object({ path: z.string(), status: z.string(), bytes: z.number().int() })),
  }).optional(),
  retrieval: RetrievalSchema.optional(),

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

module.exports = { ContextPackageSchema, RelevantFileSchema, SymbolSchema };
