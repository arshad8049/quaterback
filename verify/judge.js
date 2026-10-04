/**
 * judge.js — LLM Stage 2 of Layer 4
 *
 * Independent semantic judgment: given the git diff, did the implementation
 * satisfy each acceptance criterion?
 *
 * Runs via Ollama (same model as Layers 1+2) but with a different system prompt
 * and different context — this is the "independent verifier" that never saw the
 * original request or the briefing. It sees one AC at a time, with the evidence
 * QB retrieved for it (verify/evidence.js, QB-11): whole changed hunks, the
 * definitions of the helpers the change calls (unchanged code from the tested
 * tree), check results — each with an immutable evidence ID — and an explicit
 * list of what was NOT shown.
 */
const { missingText, label } = require('./evidence');

require('dotenv').config({ path: require('path').join(__dirname, '../intent/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../context/.env') });

const OLLAMA_URL = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL      = process.env.QB_MODEL      || 'deepseek-r1:7b';

// Number of independent LLM calls per AC — majority of these must agree for a verdict.
// 3 = minimum for a proper majority vote (2/3 required). Raise to 5 for high-stakes use.
const VOTE_COUNT = 3;

const SYSTEM_PROMPT = `You are an independent code reviewer. You will be shown evidence about a code change and a single acceptance criterion.
The evidence is a set of blocks, each with an ID like [EV-0123456789ab]: changed hunks of the git diff, the definitions of helper functions the change calls (taken from the changed repository, unchanged code included), and check results. A section "Evidence NOT shown" lists what QB could not show you.
Your job: determine whether the change satisfies the criterion.

Respond ONLY with valid JSON — no other text, no markdown, no \`\`\`json fences:
{
  "met": true | false | null,
  "evidence": "one sentence citing specific file names, function names, or line content from the diff",
  "repair": "only when met is false: one precise instruction telling the agent exactly what to add or change — name the file, function, and what is missing",
  "refs": ["the evidence IDs your vote relies on, e.g. \"EV-0123456789ab\" — only IDs shown to you"]
}

Rules:
- met: true  — the evidence clearly satisfies the criterion
- met: false — the diff contains CONCRETE evidence that the criterion is DEFINITIVELY NOT satisfied (e.g. the function is completely absent, unconditionally throws, or explicitly returns the wrong type like a number/object when a string is required)
- met: null  — anything else: the diff is ambiguous, you cannot fully verify from static analysis alone, or the implementation looks plausible but you cannot be certain without running the code

WHEN TO VOTE null (not false) — mandatory examples:
- Criterion says "function returns a string" and you can see a return statement in the diff: vote null. You cannot verify the runtime return type from a diff.
- Criterion says "function is exported" and you see module.exports or export in the diff but cannot confirm the exact binding: vote null.
- Criterion says "function returns the correct value" and the function exists with a return but you cannot trace the value to ground truth without running the code: vote null.
- Criterion says "function does not interfere with existing code" — always vote null; you cannot verify behavior without running the test suite.
- Any criterion about side effects, correctness of runtime values, or behavior that requires execution: vote null.

WHEN TO VOTE false — requires direct contradictory evidence:
- A removed (-) line you can quote deletes or renames the required thing, and no added line restores it.
- The change calls a helper whose definition is shown, and a line of that definition you can quote contradicts the criterion.
- The function explicitly returns a literal of the wrong type: e.g. \`return 42\` when a string is required.
- The function unconditionally throws before any return.
- Never vote false because something is absent from the diff or from the search hints: unchanged code may already contain it.

CRITICAL: absence of proof is NOT proof of absence. If you cannot find a specific added line that DISPROVES the criterion, vote null — not false.
CRITICAL: only vote false when you can quote a specific line from the evidence that directly contradicts the criterion, and cite its evidence ID in refs. No quote = no false vote.
CRITICAL: if "Evidence NOT shown" lists something the criterion depends on, vote null — you have not seen everything.

- evidence must reference specific files/functions/lines from the diff — never be generic
- repair (when met: false): be specific — name the file, function, and what is missing or wrong
- omit repair when met is true or null`;

// QB-22: the agent changed nothing. Did the EXISTING code already satisfy the
// criterion? Same strict output schema (parseJudgment), but the material is the
// current content of the relevant files, not a diff.
const SNAPSHOT_PROMPT = `You are an independent code reviewer. The coding agent made NO change, claiming the requirement was already satisfied.
You will be shown the current contents of the relevant repository files and a single acceptance criterion.
Your job: determine whether the EXISTING code already satisfies the criterion.

Respond ONLY with valid JSON — no other text, no markdown, no \`\`\`json fences:
{
  "met": true | false | null,
  "evidence": "one sentence quoting the specific file, function or line that shows the criterion is (or is not) already satisfied",
  "repair": "only when met is false: one precise instruction naming the file and what must be added or changed",
  "refs": ["the evidence IDs your vote relies on, e.g. \"EV-0123456789ab\" — only IDs shown to you"]
}

Rules:
- met: true  — you can quote code in the files that clearly satisfies the criterion as written
- met: false — the files show the criterion is definitively NOT satisfied (e.g. the required function is absent from the file where it must be)
- met: null  — anything else, including behaviour that can only be confirmed by running the code
- Never assume code exists outside the files shown. No quote = no true vote.
- omit repair when met is true or null`;

/**
 * Judge every criterion against the CURRENT files when the agent changed nothing (QB-22).
 * @param {Array} criteria
 * @param {string} snapshot - the relevant files, as "### path" + fenced content blocks
 */
async function judgeSnapshot(criteria, bundles, { cache = null } = {}) {
  const results = [];
  for (const ac of criteria) results.push(await judgeOne(ac, { kind: 'snapshot', bundle: bundles.get(ac.id) }, {}, cache));
  return results;
}

/**
 * Judge all acceptance criteria against the diff.
 * Returns array of {id, criterion, met, evidence} judgments.
 *
 * @param {Array} criteria  - contract.acceptance_criteria
 * @param {string} diff     - raw git diff
 * @param {object} signals  - keyword signal map from checker.js
 */
async function judgeAll(criteria, diff, signals = {}, bundles = new Map(), { cache = null } = {}) {
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
    const result = await judgeOne(ac, { kind: 'diff', bundle: bundles.get(ac.id) || null, text: diff }, signals, cache);
    results.push(result);
  }
  return results;
}

/**
 * QB-12: the checker's search hints (verify/checker.js scanDiff, version 2) as
 * prompt text, each with its provenance. Nothing here is presented as a fact,
 * and absence from the diff is never presented as evidence of absence.
 */
const SYMBOL_TEXT = {
  confirmed_added:     'in added code (parsed)',
  confirmed_unchanged: 'in unchanged code shown as diff context (pre-existing, parsed)',
  hint:                'heuristic only — the hunk could not be parsed, or the binding/scope could not be established from the diff alone',
  not_in_diff:         'not in the changed hunks — UNKNOWN; it may already exist in unchanged code (NOT evidence that it is missing)',
};
const SHORT_TEXT = { confirmed_added: 'added code', confirmed_unchanged: 'unchanged code', hint: 'heuristic hint', not_in_diff: 'unknown' };
function hintBlock(ac, signals) {
  if (!signals || signals.version !== 2) return '';
  const lines = [];
  for (const [name, s] of Object.entries(signals.symbols || {})) {
    const as = Object.entries(s.exported_as || {}).map(([pub, st]) => `${pub === 'module.exports' || pub === 'default' ? `as the module's ${pub} export` : `under the name "${pub}"`} (${SHORT_TEXT[st] || st})`);
    lines.push(`  ${name}: definition ${SYMBOL_TEXT[s.defined] || 'unknown'}; export by the name "${name}" ${SYMBOL_TEXT[s.exported] || 'unknown'}`
      + (s.local ? `; that export is bound to the local "${s.local}"` : '')
      + (s.from ? `; re-exported from ${JSON.stringify(s.from)}` : '')
      + (as.length ? `; this local binding is exported ${as.join(', ')}` : '')
      + (s.returns === 'yes' ? '; its own body returns a value (parsed)' : s.returns === 'no' ? '; its own parsed body has no return of a value' : ''));
  }
  const crit = ac.criterion.toLowerCase();
  const found = (signals.keywords?.found || []).filter((k) => crit.includes(k));
  const missing = (signals.keywords?.not_found || []).filter((k) => crit.includes(k));
  if (found.length) lines.push(`  Words from this criterion found in added lines (search hint): ${found.join(', ')}`);
  if (missing.length) lines.push(`  Words from this criterion not in added lines (NOT evidence of absence): ${missing.join(', ')}`);
  return lines.join('\n');
}

// Single raw LLM call — returns { met, evidence, repair } or throws.
async function callOnce(ac, material, signals) {
  const snapshot = material.kind === 'snapshot';
  const b = material.bundle;
  // QB-11: evidence blocks with IDs, and what was not shown — never a silently cut diff.
  const chunk = b ? evidenceText(b)
    : material.text.length > 6000 ? `${material.text.slice(0, 6000)}\n... [diff truncated at 6000 characters — NOT complete]` : material.text;

  const signalBlock = hintBlock(ac, signals);

  const userContent = [
    `## Acceptance criterion`,
    `ID: ${ac.id}`,
    `Criterion: ${ac.criterion}`,
    signalBlock ? `\n## Search hints (computed by QB from the diff — hints, not facts)\n${signalBlock}` : '',
    ``,
    snapshot ? `## Current repository files (the agent changed nothing)` : b ? `## Evidence (cite the IDs you rely on in "refs")` : `## Git diff`,
    chunk,
  ].join('\n');

  // At most MAX_FORMAT_RETRIES re-asks for the format. The malformed reply is
  // not sent back and never becomes evidence (QB-07).
  for (let attempt = 0; ; attempt++) {
    const messages = [
      { role: 'system', content: snapshot ? SNAPSHOT_PROMPT : SYSTEM_PROMPT },
      { role: 'user',   content: userContent },
      ...(attempt ? [{ role: 'user', content: FORMAT_REMINDER }] : []),
    ];
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, stream: false, options: { temperature: 0.05, num_ctx: b ? 12288 : 8192 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    const raw  = data.message?.content;
    try {
      if (!raw) throw invalid('empty response');
      const j = parseJudgment(raw);
      if (b) {   // provenance: refs must name evidence that was actually shown
        const shown = new Set(b.shown.map((it) => it.id));
        const unknown = j.refs.filter((r) => !shown.has(r));
        if (unknown.length) throw invalid(`refs name evidence that was not shown: ${unknown.slice(0, 3).join(', ')}`);
      }
      return j;
    } catch (e) {
      if (e.code !== 'invalid_judgment' || attempt >= MAX_FORMAT_RETRIES) throw e;
    }
  }
}

/** The evidence bundle as prompt text: each item with its ID and provenance, then what was not shown. */
function evidenceText(b) {
  const L = [];
  for (const it of b.shown) L.push(`### [${it.id}] ${label(it)}`, '```', it.text, '```');
  if (!b.shown.length) L.push('(no evidence could be shown)');
  const notShown = [...b.missing.map((m) => `- ${missingText(m)} [MATERIAL]`), ...b.omitted.filter((it) => !it.material).map((it) => `- ${label(it)} (not shown: evidence budget)`)];
  if (notShown.length) L.push('', '## Evidence NOT shown', ...notShown);
  // QB-11 scope, stated every time: what retrieval does not cover is never implied to be checked.
  L.push('', '## Not retrieved by QB (by design)', '- callers of the changed code, dynamic dispatch, package (non-relative) imports, and helpers called only from unchanged lines — do not assume any of these were checked.');
  return L.join('\n');
}

const MAX_FORMAT_RETRIES = 1;
const FORMAT_REMINDER = 'Your previous reply did not match the required format. Reply with ONLY the JSON object '
  + '{"met": true|false|null, "evidence": "...", "repair": "..." (only when false), "refs": [...] (optional)}.';

// Criteria that assert the ABSENCE of breakage are decided by the named tests they
// preserve (verify/preservation.js, QB-15), never by the judge. One that reaches the
// judge anyway (a stored or unbound contract) stays null — and null is never proof.
const { isPreservationCriterion } = require('./preservation');
const { judgmentKey } = require('./judge-cache');

// Majority-vote judge: runs VOTE_COUNT independent calls, picks the verdict
// that wins a strict majority (> VOTE_COUNT/2). Ties default to null — never
// force a false repair on a split vote.
async function judgeOne(ac, material, signals, cache = null) {
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

  // QB-15: one judgment per piece of evidence — re-verifying an unchanged patch
  // reuses it instead of resampling until the vote flips.
  const key = cache ? judgmentKey({ model: MODEL, prompt: material.kind === 'snapshot' ? SNAPSHOT_PROMPT : SYSTEM_PROMPT,
    criterion: ac.criterion, kind: material.kind, bundle: material.bundle, text: material.text }) : null;
  if (!key) return judgeFresh(ac, material, signals);
  const hitOf = (j) => ({ ...j, id: ac.id, criterion: ac.criterion, judgment_cache: 'hit' });
  const cached = cache.get(key);
  if (cached) return hitOf(cached);
  // Claim the evidence before sampling (across processes), then re-read: another run
  // may have published the decision while this one waited (QB-15 re-review).
  const claim = await cache.acquire(key);
  if (claim.timedOut) {
    return { id: ac.id, criterion: ac.criterion, met: null, method: `llm-vote-${VOTE_COUNT}`, votes: [], judgment_status: 'error',
      judgment_cache: 'wait_timeout', refs: [], repair: null,
      evidence: 'Another verification of this same evidence still holds its judgment claim; no decision was made here (unresolved).' };
  }
  if (claim.published) return hitOf(cache.get(key));
  try {
    const again = cache.get(key);
    if (again) return hitOf(again);
    const result = await judgeFresh(ac, material, signals);
    const published = cache.publish(key, result);   // first published decision wins
    return published === result ? { ...result, judgment_cache: 'miss' } : hitOf(published);
  } finally { claim.release(); }
}

async function judgeFresh(ac, material, signals) {
  const votes = [];

  for (let i = 0; i < VOTE_COUNT; i++) {
    try {
      const result = await callOnce(ac, material, signals);
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

  // QB-11: missing MATERIAL evidence means the criterion was not fully seen — never met.
  const b = material.bundle;
  const missing = b ? b.missing : [];
  const capped = met === true && missing.length > 0;
  return {
    id:        ac.id,
    criterion: ac.criterion,
    met:       capped ? null : met,
    method:    `llm-vote-${VOTE_COUNT}`,
    votes:     votes.map(v => v.met), // for debugging
    vote_status: votes.map(v => v.status),
    judgment_status,
    evidence:  capped ? `Missing material evidence: ${missing.map(missingText).join('; ')}. Not judged as met (the judge saw: ${winning?.evidence || 'n/a'})`.slice(0, 2000)
      : winning?.evidence || (judgment_status === 'ok' ? 'No evidence provided.'
        : `No valid judgment: ${votes.map(v => v.status).join(', ')}.`),
    refs:      winning?.refs || [],
    repair:    met === false ? (repairVote?.repair || `Implement the missing behavior: "${ac.criterion}"`) : null,
    ...(b ? { evidence_ids: b.shown.map((it) => it.id), evidence_missing: missing.map((m) => ({ what: m.what, reason: m.reason })) } : {}),
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

/**
 * QB-15 calibration: n independent raw votes for one criterion on one evidence
 * bundle (no majority, no cache) — a failed or invalid call is a null vote.
 */
async function sampleVotes(ac, bundle, n = VOTE_COUNT, signals = {}) {
  const votes = [];
  for (let i = 0; i < n; i++) {
    try { votes.push((await callOnce(ac, { kind: 'diff', bundle }, signals)).met); } catch { votes.push(null); }
  }
  return votes;
}

module.exports = { judgeAll, judgeSnapshot, parseJudgment, sampleVotes, MAX_FORMAT_RETRIES, VOTE_COUNT, MODEL, SYSTEM_PROMPT };
