/**
 * judge.js — LLM Stage 2 of Layer 4
 *
 * Independent semantic judgment: given the git diff, did the implementation
 * satisfy each acceptance criterion?
 *
 * Runs via Ollama (same model as Layers 1+2) but with a different system prompt
 * and different context — this is the "independent verifier" that never saw the
 * original request or the briefing. It only sees the diff + one AC at a time.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../intent/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../context/.env') });

const OLLAMA_URL = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL      = process.env.QB_MODEL      || 'deepseek-r1:7b';

const SYSTEM_PROMPT = `You are an independent code reviewer. You will be shown a git diff and a single acceptance criterion.
Your job: determine whether the diff satisfies the criterion.

Respond ONLY with valid JSON — no other text, no markdown, no \`\`\`json fences:
{
  "met": true | false | null,
  "evidence": "one sentence citing specific file names, function names, or line content from the diff",
  "repair": "only when met is false: one precise instruction telling the agent exactly what to add or change — name the file, function, and what is missing"
}

Rules:
- met: true  — the diff clearly satisfies the criterion
- met: false — the diff clearly violates or ignores the criterion
- met: null  — the diff is ambiguous or does not have enough information to decide
- evidence must reference specific files/functions/lines — never be generic
- repair (when met: false): be specific — e.g. "In src/llm.js, createLLM() accepts a config param but never uses it. Add a fallback: if provider is unavailable throw with the provider name, or return the default anthropic client."
- omit repair when met is true or null`;

/**
 * Judge all acceptance criteria against the diff.
 * Returns array of {id, criterion, met, evidence} judgments.
 *
 * @param {Array} criteria  - contract.acceptance_criteria
 * @param {string} diff     - raw git diff
 * @param {object} signals  - keyword signal map from checker.js
 */
async function judgeAll(criteria, diff, signals = {}) {
  if (!diff || !diff.trim()) {
    return criteria.map(ac => ({
      id:        ac.id,
      criterion: ac.criterion,
      met:       null,
      method:    'no-diff',
      evidence:  'No diff available — agent ran in dry-run mode. Cannot verify implementation.',
    }));
  }

  const results = [];
  for (const ac of criteria) {
    const result = await judgeOne(ac, diff, signals);
    results.push(result);
  }
  return results;
}

async function judgeOne(ac, diff, signals) {
  // Trim diff to a manageable size — LLM doesn't need the full blob
  const diffChunk = diff.length > 6000 ? diff.slice(0, 6000) + '\n... [diff truncated]' : diff;

  // Surface keyword signals as context hints
  const relatedSignals = Object.entries(signals)
    .filter(([k]) => ac.criterion.toLowerCase().includes(k))
    .map(([k, found]) => `"${k}": ${found ? 'found in diff' : 'NOT found in diff'}`)
    .join(', ');

  const userContent = [
    `## Acceptance criterion`,
    `ID: ${ac.id}`,
    `Criterion: ${ac.criterion}`,
    relatedSignals ? `\nKeyword signals: ${relatedSignals}` : '',
    ``,
    `## Git diff`,
    diffChunk,
  ].join('\n');

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model:   MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
        stream:  false,
        options: { temperature: 0.05, num_ctx: 8192 },
      }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const data = await res.json();
    const raw  = data.message?.content;
    if (!raw) throw new Error('Empty response');

    const parsed = parseJudgment(raw);
    return {
      id:        ac.id,
      criterion: ac.criterion,
      met:       parsed.met,
      method:    'llm',
      evidence:  parsed.evidence || 'No evidence provided.',
      repair:    parsed.repair   || null,
    };
  } catch (err) {
    return {
      id:        ac.id,
      criterion: ac.criterion,
      met:       null,
      method:    'llm',
      evidence:  `Judge error: ${err.message}`,
    };
  }
}

function parseJudgment(text) {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  try { return JSON.parse(s); } catch (_) {}

  const match = s.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }

  // Fallback: try to extract met from text
  const metTrue  = /\b(met|satisfied|implemented|yes|true)\b/i.test(s);
  const metFalse = /\b(not met|not satisfied|missing|no|false|fail)\b/i.test(s);
  return {
    met:      metTrue && !metFalse ? true : metFalse ? false : null,
    evidence: s.slice(0, 200),
  };
}

module.exports = { judgeAll };
