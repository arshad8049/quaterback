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
  "repair": "only when met is false: one precise instruction telling the agent exactly what to add or change — name the file, function, and what is missing",
  "refs": ["optional: diff locations you relied on, as \"path:line\""]
}

Rules:
- met: true  — the diff clearly satisfies the criterion
- met: false — the diff contains CONCRETE evidence that the criterion is DEFINITIVELY NOT satisfied (e.g. the function is completely absent, unconditionally throws, or explicitly returns the wrong type like a number/object when a string is required)
- met: null  — anything else: the diff is ambiguous, you cannot fully verify from static analysis alone, or the implementation looks plausible but you cannot be certain without running the code

WHEN TO VOTE null (not false) — mandatory examples:
- Criterion says "function returns a string" and you can see a return statement in the diff: vote null. You cannot verify the runtime return type from a diff.
- Criterion says "function is exported" and you see module.exports or export in the diff but cannot confirm the exact binding: vote null.
- Criterion says "function returns the correct value" and the function exists with a return but you cannot trace the value to ground truth without running the code: vote null.
- Criterion says "function does not interfere with existing code" — always vote null; you cannot verify behavior without running the test suite.
- Any criterion about side effects, correctness of runtime values, or behavior that requires execution: vote null.

WHEN TO VOTE false — requires direct contradictory evidence:
- The function name is completely absent from all added (+) lines in the diff.
- The function explicitly returns a literal of the wrong type: e.g. \`return 42\` when a string is required.
- The function unconditionally throws before any return.
- The keyword signal hints explicitly say something is "NOT found in diff" AND the criterion requires that thing to exist.

CRITICAL: absence of proof is NOT proof of absence. If you cannot find a specific added line that DISPROVES the criterion, vote null — not false.
CRITICAL: only vote false when you can quote a specific diff line that directly contradicts the criterion. No quote = no false vote.

- evidence must reference specific files/functions/lines from the diff — never be generic
- repair (when met: false): be specific — name the file, function, and what is missing or wrong
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
      judgment_status: 'not_judged',
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

  // Deterministic function signals (high-confidence, computed from added lines only)
  const fnSignals = Object.entries(signals)
    .filter(([k]) => k.startsWith('__fn_'))
    .map(([k, found]) => {
      const parts = k.replace('__fn_', '').split('_');
      const property = parts.pop(); // defined | exported | returns
      const fname    = parts.join('_');
      const verdict  = found ? 'YES (confirmed in added lines)' : 'NO (not found in added lines)';
      return `  ${fname}() ${property}: ${verdict}`;
    })
    .join('\n');

  // Keyword signals — only those relevant to this criterion
  const kwSignals = Object.entries(signals)
    .filter(([k]) => !k.startsWith('__fn_') && ac.criterion.toLowerCase().includes(k))
    .map(([k, found]) => `  "${k}": ${found ? 'found in diff' : 'NOT found in diff'}`)
    .join('\n');

  const signalBlock = [
    fnSignals ? `Deterministic checks (computed from added lines):\n${fnSignals}` : '',
    kwSignals ? `Keyword signals:\n${kwSignals}` : '',
  ].filter(Boolean).join('\n');

  const userContent = [
    `## Acceptance criterion`,
    `ID: ${ac.id}`,
    `Criterion: ${ac.criterion}`,
    signalBlock ? `\n## Pre-computed signals\n${signalBlock}` : '',
    ``,
    `## Git diff`,
    diffChunk,
  ].join('\n');

  // At most MAX_FORMAT_RETRIES re-asks for the format. The malformed reply is
  // not sent back and never becomes evidence (QB-07).
  for (let attempt = 0; ; attempt++) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userContent },
      ...(attempt ? [{ role: 'user', content: FORMAT_REMINDER }] : []),
    ];
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, stream: false, options: { temperature: 0.05, num_ctx: 8192 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    const raw  = data.message?.content;
    try {
      if (!raw) throw invalid('empty response');
      return parseJudgment(raw);
    } catch (e) {
      if (e.code !== 'invalid_judgment' || attempt >= MAX_FORMAT_RETRIES) throw e;
    }
  }
}

const MAX_FORMAT_RETRIES = 1;
const FORMAT_REMINDER = 'Your previous reply did not match the required format. Reply with ONLY the JSON object '
  + '{"met": true|false|null, "evidence": "...", "repair": "..." (only when false), "refs": [...] (optional)}.';

// Criteria that assert the ABSENCE of breakage — can only be verified by
// running the test suite, never from static diff analysis. Always null.
const PRESERVATION_PATTERNS = [
  /existing\s+\w*\s*(functionality|behavior|code|tests?)\s+(remains?\s+)?unchanged/i,
  /remains?\s+unchanged/i,
  /no\s+other\s+parts?\s+(of\s+the\s+code\s+)?(are\s+)?affected/i,
  /without\s+(affecting|breaking|changing|modifying)\s+(existing|other|the\s+rest)/i,
  /existing\s+(code|behavior|tests?|interface)\s+(is\s+)?(not\s+)?(modified|changed|broken|affected)/i,
  /no\s+regressions?/i,
  /backward[\s-]?compat/i,
];

function isPreservationCriterion(criterion) {
  return PRESERVATION_PATTERNS.some(p => p.test(criterion));
}

// Majority-vote judge: runs VOTE_COUNT independent calls, picks the verdict
// that wins a strict majority (> VOTE_COUNT/2). Ties default to null — never
// force a false repair on a split vote.
async function judgeOne(ac, diff, signals) {
  // Short-circuit: preservation ACs require test execution, not diff analysis.
  if (isPreservationCriterion(ac.criterion)) {
    return {
      id:        ac.id,
      criterion: ac.criterion,
      met:       null,
      method:    'llm-vote-3',
      votes:     [null, null, null],
      judgment_status: 'not_judged',
      evidence:  'Preservation criterion — requires test suite execution to verify. Cannot determine from diff alone.',
      repair:    null,
    };
  }

  const votes = [];

  for (let i = 0; i < VOTE_COUNT; i++) {
    try {
      const result = await callOnce(ac, diff, signals);
      votes.push({ ...result, status: 'ok' });
    } catch (err) {
      // A failed or malformed call counts as null — it doesn't tip the vote either way.
      votes.push(err.code === 'invalid_judgment'
        ? { met: null, status: 'invalid_judgment', evidence: `Call ${i + 1}: invalid judgment (${err.message})` }
        : { met: null, status: 'error', evidence: `Call ${i + 1} error: ${err.message}` });
    }
  }
  const valid = votes.filter(v => v.status === 'ok');
  const judgment_status = valid.length ? 'ok'
    : votes.some(v => v.status === 'invalid_judgment') ? 'invalid_judgment' : 'error';

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

  // Pick evidence from a valid call that matches the winning verdict (first match).
  const winning = valid.find(v => {
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
    vote_status: votes.map(v => v.status),
    judgment_status,
    evidence:  winning?.evidence || (judgment_status === 'ok' ? 'No evidence provided.'
      : `No valid judgment: ${votes.map(v => v.status).join(', ')}.`),
    refs:      winning?.refs || [],
    repair:    met === false ? (repairVote?.repair || `Implement the missing behavior: "${ac.criterion}"`) : null,
  };
}

const invalid = (why) => Object.assign(new Error(why), { code: 'invalid_judgment' });

/**
 * Parse one judge reply against the strict judgment schema (QB-07):
 *   { met: true|false|null, evidence: non-empty string, repair?: string|null, refs?: string[] }
 * Tolerated wrappers: <think>…</think> blocks and one ```json fence around the
 * whole reply. Anything else (prose, arrays, null, wrong types, missing
 * fields) throws code 'invalid_judgment'. There is no keyword fallback.
 */
function parseJudgment(text) {
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1].trim();
  let j;
  try { j = JSON.parse(s); } catch (_) { throw invalid('not JSON'); }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw invalid('not a JSON object');
  if (!('met' in j) || !(j.met === true || j.met === false || j.met === null)) throw invalid('met must be true, false or null');
  if (typeof j.evidence !== 'string' || !j.evidence.trim()) throw invalid('evidence must be a non-empty string');
  if (j.repair !== undefined && j.repair !== null && typeof j.repair !== 'string') throw invalid('repair must be a string');
  if (j.refs !== undefined && !(Array.isArray(j.refs) && j.refs.every(r => typeof r === 'string'))) throw invalid('refs must be an array of strings');
  return { met: j.met, evidence: j.evidence.trim(), repair: j.repair ?? null, refs: j.refs || [] };
}

module.exports = { judgeAll, parseJudgment, MAX_FORMAT_RETRIES };
