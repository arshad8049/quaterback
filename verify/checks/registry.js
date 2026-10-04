/**
 * verify/checks/registry.js — the versioned check registry (QB-16).
 *
 * A contract's executable checks are DATA: an approved adapter name plus typed,
 * size-bounded parameters. Nothing here, in the compiler or in the runner ever
 * executes shell text or code emitted by L1. A check that does not validate is
 * rejected (with the reason) and never runs; its criterion stays without an
 * executed check, which the verifier reports as unresolved.
 *
 * Registry qb-checks/1 — adapters (all run in sandbox stage ⑥ by QB's own
 * runner, sandbox/agent/qb-check-runner.mjs, each in its own child process):
 *   module_exports  { module, export, type }           the export exists with that typeof
 *   call_returns    { module, export, args, expect }    await export(...args) deep-equals expect
 *   call_throws     { module, export, args, message_includes? }  export(...args) throws / rejects
 *
 * `module` is a repository-relative .js/.cjs/.mjs path (no "..", not absolute);
 * `export` is an identifier or "default"; `args` and `expect` are plain JSON
 * (each ≤ 4 KiB serialized).
 */

const { z } = require('zod');
const { isDeepStrictEqual } = require('util');

const REGISTRY_VERSION = 'qb-checks/1';
const MAX_JSON_BYTES = 4096;
const MAX_CHECKS = 32;

const ModulePath = z.string().min(1).max(300)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '' || s === '.'),
    'module must be a plain repository-relative path')
  .refine((p) => /\.(c|m)?js$/.test(p), 'module must be a .js, .cjs or .mjs file');
const ExportName = z.string().regex(/^(default|[A-Za-z_$][A-Za-z0-9_$]{0,99})$/, 'export must be an identifier or "default"');
const json = (what) => z.unknown().refine((v) => {
  // Plain JSON: survives a round trip unchanged (rejects NaN, Infinity, undefined, functions,
  // Dates, class instances…) and is small.
  try { const s = JSON.stringify(v); return s !== undefined && Buffer.byteLength(s) <= MAX_JSON_BYTES && isDeepStrictEqual(JSON.parse(s), v); }
  catch { return false; }
}, `${what} must be plain JSON of at most ${MAX_JSON_BYTES} bytes`);

const ADAPTERS = {
  module_exports: z.object({
    module: ModulePath, export: ExportName,
    type: z.enum(['function', 'object', 'string', 'number', 'boolean']),
  }).strict(),
  call_returns: z.object({
    module: ModulePath, export: ExportName,
    args: json('args').refine((a) => Array.isArray(a), 'args must be an array'),
    expect: json('expect'),
  }).strict(),
  call_throws: z.object({
    module: ModulePath, export: ExportName,
    args: json('args').refine((a) => Array.isArray(a), 'args must be an array'),
    message_includes: z.string().min(1).max(200).optional(),
  }).strict(),
};

const CheckSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  ac_id: z.string().min(1).max(64),
  adapter: z.enum(Object.keys(ADAPTERS)),
  params: z.unknown(),
  plan_item: z.number().int().nonnegative().optional(),   // index into contract.verification_plan
}).strict();

/**
 * Validate proposed checks against the registry and the contract's criteria.
 * @returns {{ version, accepted: Check[], rejected: [{ check, reason }] }}
 */
function validateChecks(proposed, criteria = []) {
  const acIds = new Set(criteria.map((ac) => ac && ac.id));
  const accepted = [], rejected = [];
  const seen = new Set();
  const list = Array.isArray(proposed) ? proposed : [];
  for (const [i, raw] of list.entries()) {
    const reject = (reason) => rejected.push({ check: raw, reason });
    if (i >= MAX_CHECKS) { reject(`more than ${MAX_CHECKS} checks`); continue; }
    const c = CheckSchema.safeParse(raw);
    if (!c.success) { reject(c.error.issues.map((x) => `${x.path.join('.') || 'check'}: ${x.message}`).join('; ')); continue; }
    if (!acIds.has(c.data.ac_id)) { reject(`ac_id ${c.data.ac_id} is not a criterion of this contract`); continue; }
    if (seen.has(c.data.id)) { reject(`duplicate check id ${c.data.id}`); continue; }
    const p = ADAPTERS[c.data.adapter].safeParse(c.data.params);
    if (!p.success) { reject(p.error.issues.map((x) => `params.${x.path.join('.')}: ${x.message}`).join('; ')); continue; }
    seen.add(c.data.id);
    accepted.push({ ...c.data, params: p.data });
  }
  if (!Array.isArray(proposed) && proposed !== undefined && proposed !== null) rejected.push({ check: proposed, reason: 'checks must be an array' });
  return { version: REGISTRY_VERSION, accepted, rejected };
}

/**
 * The identity of a check set: SHA-256 over canonical JSON (object keys sorted,
 * array order kept). The runner (sandbox/agent/qb-check-runner.mjs) computes the
 * same hash over what it received, so results are bound to the exact definitions
 * (ids, criteria, adapters, params, plan items) — not just to reused ids.
 */
function checkSetHash(checks) {
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
      : JSON.stringify(v === undefined ? null : v));
  return require('crypto').createHash('sha256').update(canon(Array.isArray(checks) ? checks : [])).digest('hex');
}

module.exports = { checkSetHash, validateChecks, REGISTRY_VERSION, ADAPTERS: Object.keys(ADAPTERS), MAX_CHECKS, MAX_JSON_BYTES };
