require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TaskContractSchema, ClarifyingResponseSchema } = require('./schema');
const { contractState } = require('./contract-state');
const { detectAmbiguity } = require('./dsa');

const OLLAMA_URL = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL      = process.env.QB_MODEL       || 'deepseek-r1:7b';
// Fields the model is allowed to author. Everything else in its output is ignored.
const SEMANTIC_FIELDS = [
  'goal', 'required_behavior', 'constraints', 'acceptance_criteria',
  'verification_plan', 'relevant_context', 'ambiguity_flags', 'clarifying_question',
  'scope', 'constraint_policy',   // QB-09: enforced policy, validated by contractState
  'requirements',                 // QB-14: request clauses with verbatim quotes, validated by contractState
  'test_policy',                  // QB-10: explicit, approved waiver of pre-existing test failures
  'proposed_defaults',            // QB-17: QB's own choices where the request is silent — shown and approved, never silent
];
const { validateChecks } = require('../verify/checks/registry');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');

/**
 * @param {string} request
 * @param {string|null} repoContext   the repository survey text (intent/survey.js, QB-17)
 * @param {string|Array<{question, answer}>|null} clarification  answers so far, round by round
 */
async function compile(request, repoContext = null, clarification = null) {
  const history = Array.isArray(clarification) ? clarification
    : clarification ? [{ question: null, answer: String(clarification) }] : [];
  // DSA pre-pass (QB-17): a vague term blocks until the request or an answer defines it.
  const ambiguity = detectAmbiguity(request, history.map((h) => h.answer));
  if (ambiguity) return ambiguity;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserContent(request, repoContext, history) },
      ],
      stream: false,
      options: { temperature: 0.1, num_ctx: 16384 },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const raw = data.message?.content;
  if (!raw) throw new Error('Empty response from Ollama');

  return parseAndValidate(raw, request);
}

function buildUserContent(request, repoContext, history) {
  let content = `REQUEST:\n${request}`;
  history.forEach((h, i) => {
    content += h.question ? `\n\nCLARIFICATION ${i + 1}:\nQ: ${h.question}\nA: ${h.answer}` : `\n\nCLARIFICATION:\n${h.answer}`;
  });
  if (repoContext) content += `\n\nREPOSITORY SURVEY (read-only, for grounding — the request decides what to do):\n${repoContext}`;
  return content;
}

function parseAndValidate(text, request) {
  return contractFromObject(parseJSON(text, request), request);
}

/**
 * Normalize a contract object (model output, or a human-reviewed contract file,
 * QB-13) with the same rules: explicit criterion text only, registry-validated
 * checks, trusted metadata assigned by QB. The result is NOT approved.
 */
function contractFromObject(raw, request) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('contract must be a JSON object');

  // clarifying_question (QB-08): every nonempty question is preserved. The model
  // sometimes writes a placeholder instead of null; only an EXACT match of a
  // documented sentinel (NO_QUESTION_SENTINELS) means "no question".
  const cq = raw.clarifying_question;
  const isRealQuestion = typeof cq === 'string' && cq.trim() !== '' && !isNoQuestionSentinel(cq);

  if (isRealQuestion) {
    return ClarifyingResponseSchema.parse({
      ambiguity_flags: (raw.ambiguity_flags || []).filter(f => typeof f === 'string' && f.length > 5),
      clarifying_question: cq.trim(),
    });
  }

  raw.clarifying_question = null;

  // QB-17: incomplete output is recorded, never filled with fallback text. A
  // contract with `incomplete` entries is invalid (intent/contract-state.js).
  const incomplete = [];
  for (const key of ['required_behavior', 'verification_plan']) {
    if (!Array.isArray(raw[key]) || raw[key].length === 0) incomplete.push(`missing ${key}`);
  }

  // Normalize string arrays — the model sometimes returns objects with a text field.
  // An entry with no recognizable text is reported, not stringified.
  for (const key of ['required_behavior', 'constraints', 'verification_plan', 'ambiguity_flags']) {
    if (Array.isArray(raw[key])) {
      raw[key] = raw[key].map((item, i) => {
        const t = typeof item === 'string' ? item : extractString(item);
        if (t === null) incomplete.push(`unreadable ${key}[${i}]`);
        return t;
      }).filter(Boolean);
    } else {
      raw[key] = raw[key] ? [String(raw[key])] : [];
    }
  }
  for (const key of ['required_behavior', 'verification_plan']) {
    if (!raw[key].length && !incomplete.includes(`missing ${key}`)) incomplete.push(`missing ${key}`);
  }

  // Default missing fields so schema validation doesn't fail on incomplete model output
  if (!Array.isArray(raw.relevant_context))  raw.relevant_context  = [];
  if (!Array.isArray(raw.ambiguity_flags))   raw.ambiguity_flags   = [];
  if (raw.clarifying_question === undefined) raw.clarifying_question = null;

  // Acceptance criteria are never invented (QB-08): if the model gave none, the
  // contract has none and the finalization gate (intent/contract-state) blocks it.
  // The criterion text must be an explicit string in `criterion`: it is never
  // derived from an id, another property or a serialized object, so a malformed
  // entry stays blank and the gate blocks the contract.
  raw.acceptance_criteria = Array.isArray(raw.acceptance_criteria)
    ? raw.acceptance_criteria.map((ac, i) => {
      const obj = ac !== null && typeof ac === 'object' && !Array.isArray(ac);
      return {
        id:        obj && typeof ac.id === 'string' && ac.id.trim() ? ac.id : `AC-${i + 1}`,
        criterion: obj && typeof ac.criterion === 'string' ? ac.criterion : '',
        met:       null,
        // Only an explicit "non_behavioral" opts a criterion out of executed checks (QB-16).
        kind:      obj && ac.kind === 'non_behavioral' ? 'non_behavioral' : 'behavioral',
        // QB-14: which requirements this criterion covers (validated by contractState).
        requirement_ids: obj && Array.isArray(ac.requirement_ids) ? ac.requirement_ids.filter((x) => typeof x === 'string') : [],
        ...(obj && ac.preserves !== undefined ? { preserves: ac.preserves } : {}),   // QB-15: validated by contractState
      };
    })
    : [];

  // Only semantic fields come from the model. Trusted metadata is assigned
  // afterwards by the application and can never be overridden (QB-04).
  const semantic = {};
  for (const key of SEMANTIC_FIELDS) semantic[key] = raw[key];

  // QB-16: proposed checks are data, validated against the versioned registry;
  // rejected ones are recorded and never run. No shell text is accepted.
  const checks = validateChecks(raw.checks, raw.acceptance_criteria);

  const contract = {
    ...semantic,
    checks: checks.accepted,
    checks_rejected: checks.rejected,
    checks_registry: checks.version,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    raw_request: request,
    repo_path: null,
    ...(incomplete.length ? { incomplete } : {}),   // QB-17: set by QB, never by the model
  };

  // A contract the gate will reject (no ACs, missing goal, …) is returned as is,
  // so callers report it as invalid_contract instead of crashing on a schema error.
  const parsed = TaskContractSchema.safeParse(contract);
  if (parsed.success) return parsed.data;
  if (contractState(contract).state === 'invalid') return contract;
  throw parsed.error;
}

/**
 * Exact (case-insensitive, trailing "." ignored) placeholders a model writes for
 * "no question". Anything else nonempty is a real question and is preserved.
 */
const NO_QUESTION_SENTINELS = new Set([
  'null', 'none', 'no', 'n/a', 'na', 'not needed', 'none needed', 'not applicable',
  'no clarification', 'no clarification needed', 'no question', 'no questions',
]);
function isNoQuestionSentinel(q) {
  return NO_QUESTION_SENTINELS.has(q.trim().toLowerCase().replace(/\.$/, ''));
}

/** The text of a list entry the model wrote as an object, or null (QB-17: never guessed). */
function extractString(obj) {
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj !== 'object' || obj === null) return null;
  for (const key of ['text', 'description', 'behavior', 'criterion', 'constraint', 'step', 'item', 'value', 'content']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key];
  }
  return null;
}

function parseJSON(text, request) {
  // Strip DeepSeek-R1 reasoning blocks first, trim so ^ anchors work, then strip fences
  let stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  stripped = stripped.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  // Try strict parse first
  try { return JSON.parse(stripped); } catch (_) {}

  // Extract the outermost JSON object if there's surrounding text
  const match = stripped.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : stripped;

  // Try with unquoted-key fix (model sometimes outputs JS-style object literals)
  try { return JSON.parse(fixUnquotedKeys(candidate)); } catch (_) {}

  // Last resort: try the candidate as-is
  try { return JSON.parse(candidate); } catch (_) {}

  throw new Error(`Intent compiler returned non-JSON for: "${request.slice(0, 60)}..."\n\nRaw:\n${text}`);
}

function fixUnquotedKeys(str) {
  // Convert JS-style unquoted keys to quoted JSON keys
  // Matches: word characters followed by colon, not inside a string
  return str.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
}

module.exports = { compile, contractFromObject, NO_QUESTION_SENTINELS };
