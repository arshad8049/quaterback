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

// Number of independent LLM calls per AC — majority of these must agree for a verdict.
// 3 = minimum for a proper majority vote (2/3 required). Raise to 5 for high-stakes use.
const VOTE_COUNT = 3;

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
- met: false — the diff contains CONCRETE evidence that the criterion is DEFINITIVELY NOT satisfied (e.g. the function is absent, throws unconditionally, or returns a hardcoded wrong value)
- met: null  — anything else: the diff is ambiguous, you cannot fully verify from static analysis, the type cannot be confirmed without running the code, or the implementation looks plausible but you are not certain
- CRITICAL: absence of proof is NOT proof of absence. If the implementation looks reasonable but you cannot confirm a type or runtime value from the diff alone, vote null — NOT false.
- CRITICAL: only vote false when you can point to a specific line in the diff that directly contradicts the criterion. If you cannot cite a specific line that proves failure, vote null.
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

// Single raw LLM call — returns { met, evidence, repair } or throws.
async function callOnce(ac, diff, signals) {
  const diffChunk = diff.length > 6000 ? diff.slice(0, 6000) + '\n... [diff truncated]' : diff;

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

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model:    MODEL,
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
  return parseJudgment(raw);
}

// Majority-vote judge: runs VOTE_COUNT independent calls, picks the verdict
// that wins a strict majority (> VOTE_COUNT/2). Ties default to null — never
// force a false repair on a split vote.
async function judgeOne(ac, diff, signals) {
  const votes = [];

  for (let i = 0; i < VOTE_COUNT; i++) {
    try {
      const result = await callOnce(ac, diff, signals);
      votes.push(result);
    } catch (err) {
      // A failed call counts as null — doesn't tip the vote either way.
      votes.push({ met: null, evidence: `Call ${i + 1} error: ${err.message}` });
    }
  }

  // Tally
  const tally = { true: 0, false: 0, null: 0 };
  for (const v of votes) {
    const key = v.met === true ? 'true' : v.met === false ? 'false' : 'null';
    tally[key]++;
  }

  const majority = Math.floor(VOTE_COUNT / 2) + 1; // e.g. 2 out of 3

  let met;
  if (tally['true']  >= majority) met = true;
  else if (tally['false'] >= majority) met = false;
  else met = null; // genuine split — do not invent a verdict

  // Pick evidence from a call that matches the winning verdict (first match).
  const winning = votes.find(v => {
    const k = v.met === true ? 'true' : v.met === false ? 'false' : 'null';
    return (met === true && k === 'true') ||
           (met === false && k === 'false') ||
           (met === null);
  });

  // Best repair hint: from any false-voting call (most specific diagnosis).
  const repairVote = votes.find(v => v.met === false && v.repair);

  return {
    id:        ac.id,
    criterion: ac.criterion,
    met,
    method:    `llm-vote-${VOTE_COUNT}`,
    votes:     votes.map(v => v.met), // for debugging
    evidence:  winning?.evidence || 'No evidence provided.',
    repair:    met === false ? (repairVote?.repair || `Implement the missing behavior: "${ac.criterion}"`) : null,
  };
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
