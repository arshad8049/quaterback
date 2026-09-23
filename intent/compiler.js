require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TaskContractSchema, ClarifyingResponseSchema } = require('./schema');
const { detectAmbiguity } = require('./dsa');

const OLLAMA_URL = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL      = process.env.QB_MODEL       || 'deepseek-r1:7b';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');

async function compile(request, repoContext = null, clarification = null) {
  // DSA pre-pass: catch deterministic ambiguity patterns before touching the LLM
  if (!clarification) {
    const ambiguity = detectAmbiguity(request);
    if (ambiguity) return ambiguity;
  }

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserContent(request, repoContext, clarification) },
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

function buildUserContent(request, repoContext, clarification) {
  let content = `REQUEST:\n${request}`;
  if (clarification) content += `\n\nCLARIFICATION:\n${clarification}`;
  if (repoContext)   content += `\n\nREPO CONTEXT:\n${repoContext}`;
  return content;
}

function parseAndValidate(text, request) {
  const raw = parseJSON(text, request);

  // Normalize clarifying_question — model sometimes returns "None needed" or dismissal phrases instead of null
  const cq = raw.clarifying_question;
  const isRealQuestion = typeof cq === 'string' && cq.trim().length > 10 &&
    !/^(null|none|no|n\/a|not needed|none needed|no clarification|no question)/i.test(cq.trim());

  if (isRealQuestion) {
    return ClarifyingResponseSchema.parse({
      ambiguity_flags: (raw.ambiguity_flags || []).filter(f => typeof f === 'string' && f.length > 5),
      clarifying_question: cq.trim(),
    });
  }

  raw.clarifying_question = null;

  // required_behavior — generate from goal if model returned empty
  if (!Array.isArray(raw.required_behavior) || raw.required_behavior.length === 0) {
    raw.required_behavior = raw.goal ? [raw.goal] : ['Implement the requested feature as described.'];
  }

  // Normalize string arrays — model sometimes returns objects instead of strings
  for (const key of ['required_behavior', 'constraints', 'verification_plan', 'ambiguity_flags']) {
    if (Array.isArray(raw[key])) {
      raw[key] = raw[key].map(item =>
        typeof item === 'string' ? item : extractString(item)
      ).filter(Boolean);
    } else {
      raw[key] = raw[key] ? [String(raw[key])] : [];
    }
  }

  // Default missing fields so schema validation doesn't fail on incomplete model output
  if (!Array.isArray(raw.relevant_context))  raw.relevant_context  = [];
  if (!Array.isArray(raw.ambiguity_flags))   raw.ambiguity_flags   = [];
  if (raw.clarifying_question === undefined) raw.clarifying_question = null;

  // Acceptance criteria — fall back to generating from required_behavior if model dropped them
  if (!Array.isArray(raw.acceptance_criteria) || raw.acceptance_criteria.length === 0) {
    raw.acceptance_criteria = (raw.required_behavior || []).map((b, i) => ({
      id: `AC-${i + 1}`, criterion: typeof b === 'string' ? b : extractString(b), met: null
    }));
  } else {
    raw.acceptance_criteria = raw.acceptance_criteria.map((ac, i) => ({
      id:        ac.id || `AC-${i + 1}`,
      criterion: typeof ac.criterion === 'string' ? ac.criterion : extractString(ac) || `Criterion ${i + 1}`,
      met:       null,
    }));
  }

  // verification_plan — fall back to a minimal plan if missing
  if (!Array.isArray(raw.verification_plan) || raw.verification_plan.length === 0) {
    raw.verification_plan = ['Run the existing test suite and verify acceptance criteria are met.'];
  }

  const contract = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    raw_request: request,
    repo_path: null,
    ...raw
  };

  return TaskContractSchema.parse(contract);
}

function extractString(obj) {
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object' || obj === null) return String(obj);
  // Try common keys the model uses when it returns objects instead of strings
  for (const key of ['text', 'description', 'behavior', 'criterion', 'constraint', 'step', 'item', 'value', 'content']) {
    if (typeof obj[key] === 'string') return obj[key];
  }
  // Last resort: join all string values
  const strings = Object.values(obj).filter(v => typeof v === 'string');
  return strings.join(' ') || JSON.stringify(obj);
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

module.exports = { compile };
