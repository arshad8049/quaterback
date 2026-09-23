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

  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserContent(request, repoContext, clarification) },
      ],
      stream: false,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
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

  // If the model raised a clarifying question, that always wins — even if it also guessed a goal
  if (raw.clarifying_question) {
    return ClarifyingResponseSchema.parse({
      ambiguity_flags: raw.ambiguity_flags || [],
      clarifying_question: raw.clarifying_question,
    });
  }

  if (Array.isArray(raw.acceptance_criteria)) {
    raw.acceptance_criteria = raw.acceptance_criteria.map((ac, i) => ({
      // Generate id if model omitted it
      id: ac.id || `AC-${i + 1}`,
      criterion: ac.criterion,
      // The compiler never sets met — that's the verifier's job
      met: null,
    }));
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

function parseJSON(text, request) {
  // Strip DeepSeek-R1 reasoning blocks first, trim so ^ anchors work, then strip fences
  let stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  stripped = stripped.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    throw new Error(`Intent compiler returned non-JSON for: "${request.slice(0, 60)}..."\n\nRaw:\n${text}`);
  }
}

module.exports = { compile };
