/**
 * DSA layer: deterministic ambiguity detection that runs before the LLM.
 *
 * Each rule names a vague term that has no testable meaning on its own. A rule
 * blocks only while the term is UNRESOLVED (QB-17):
 *   - the request itself defines it ("cleaner by extracting …", "cleaner: …",
 *     "more readable, meaning …"), or
 *   - an answer TO THAT QUESTION affirmatively selects one choice or defines it.
 *
 * Selection (QB-17 re-review 1) — deterministic first:
 *   - structured: "<question id>=<choice id>" (e.g. `qb --clarify cleaner=improve_naming`)
 *     or { question, choice }; an unknown id selects nothing;
 *   - free text resolves only if it mentions exactly ONE choice, does not negate it,
 *     and carries no uncertainty or alternatives ("cannot decide", "not sure",
 *     "either", "or", "maybe", "you choose", "ask me again", a question mark …).
 *     Anything else — including an answer that lists every option — leaves it open.
 * Binding: each answer belongs to the question it answered (the question asked in its
 * round, or the one a structured selection names); it never resolves another rule.
 *
 * Parameterized choices (QB-17 re-review 2): a choice whose meaning needs a value —
 * "numeric_target" says a measurable target is wanted, it does not supply one — is
 * incomplete until a valid value is given. Selecting it without one keeps the rule
 * open behind a follow-up question (id "<rule>.target"); the value comes with the
 * selection ("improve_unmeasured=numeric_target:p95 latency < 200ms",
 * { question, choice, value }) or as the answer to the follow-up. Resolved selections
 * (question, choice, value) are returned so the compiler carries them into the
 * contract (`clarifications`, approved with it).
 * The LLM still handles novel or complex ambiguity.
 *
 * Each open rule is returned machine-readably:
 *   { id, question, choices: [label], options: [{ id, label }], flag }.
 */

// A definition follows the vague term in the same sentence: "cleaner by …", "cleaner: …",
// "cleaner (…)", "cleaner — …", "cleaner, meaning …", "cleaner so that …".
const DEFINITION = /^[^.?!\n]{0,12}?(?:\s(?:by|via|through|meaning|i\.e\.|e\.g\.|so that|such that|in that|namely)\b|\s*[:(]|\s+[—–-]\s)/i;

const AMBIGUITY_RULES = [
  {
    id: 'cleaner',
    term: /\bcleaner\b/i,
    flag: '"cleaner" has no testable definition — it could mean shorter functions, better naming, fewer files, extracted helpers, removed duplication, or all of these',
    question: 'What does "cleaner" mean here? For example: reduce function length, improve naming conventions, extract helper functions, remove duplication, or something else?',
    choices: [
      ['reduce_function_length', 'reduce function length', /\b(shorter|length|smaller functions?|split)\b/i],
      ['improve_naming', 'improve naming', /\b(nam(e|es|ing)|renam\w*)\b/i],
      ['extract_helpers', 'extract helper functions', /\b(extract\w*|helpers?)\b/i],
      ['remove_duplication', 'remove duplication', /\b(duplicat\w*|dedup\w*|dry)\b/i],
    ],
  },
  {
    id: 'better_refactor',
    term: /\bbetter\b/i,
    applies: (r) => /refactor|rewrite|clean|organiz|restructur/i.test(r),
    flag: '"better" with a refactor request has no testable definition — it could mean performance, readability, maintainability, or test coverage',
    question: 'What does "better" mean for this refactor? For example: improve performance, increase readability, add test coverage, reduce coupling, or something else?',
    choices: [
      ['improve_performance', 'improve performance', /\b(perform\w*|faster|latency|speed|throughput)\b/i],
      ['increase_readability', 'increase readability', /\b(readab\w*|naming|comments?)\b/i],
      ['add_test_coverage', 'add test coverage', /\b(tests?|coverage)\b/i],
      ['reduce_coupling', 'reduce coupling', /\b(coupl\w*|dependenc\w*|modular\w*)\b/i],
    ],
  },
  {
    id: 'more_quality',
    term: /\bmore\s+(readable|maintainable|organized|modular|modern)\b/i,
    flag: 'Vague quality adjective — has no independently verifiable definition without knowing the specific outcome expected',
    question: (r) => {
      const adj = (r.match(/\bmore\s+(readable|maintainable|organized|modular|modern)\b/i) || [])[1] || 'that';
      return `What specifically makes the code "${adj}" — what would a verifier observe as evidence it was done?`;
    },
    choices: [
      ['split_long_functions', 'split long functions', /\b(split\w*|shorter|length)\b/i],
      ['rename_identifiers', 'rename unclear identifiers', /\b(nam(e|es|ing)|renam\w*)\b/i],
      ['extract_modules', 'extract modules or helpers', /\b(extract\w*|modules?|helpers?)\b/i],
      ['remove_duplication', 'remove duplication', /\b(duplicat\w*|dedup\w*)\b/i],
    ],
  },
  {
    id: 'like_existing',
    term: /\blike\s+(normal|existing|regular|standard|current|the\s+existing)\b/i,
    flag: '"like [existing thing]" could mean same data model, same onboarding flow, same validation, same error handling, or all of these — each leads to a different implementation',
    question: 'When you say "like [existing flow]", which specific aspects must match — the data model, the onboarding steps, the email validation, the error handling, or something else?',
    choices: [
      ['data_model', 'the data model', /\b(data model|schema|fields?|columns?)\b/i],
      ['onboarding_steps', 'the onboarding steps', /\b(onboard\w*|steps?|flow)\b/i],
      ['validation', 'the validation', /\bvalidat\w*/i],
      ['error_handling', 'the error handling', /\berrors?\b/i],
    ],
  },
  {
    id: 'improve_unmeasured',
    term: /\bimprove\b.{0,40}\b(performance|speed|ux|experience|quality)\b/i,
    applies: (r) => !/\d/.test(r),
    flag: 'Improvement without a measurable target — cannot write acceptance criteria without knowing the success threshold',
    question: 'What is the success threshold? For example: specific latency target, user satisfaction score, error rate reduction, or another measurable outcome?',
    choices: [['numeric_target', 'a numeric target (e.g. p95 latency < 200 ms)', /\d/, {
      followup: 'What is the measurable target? Give the metric, a comparator and a number with its unit — for example "p95 latency < 200ms", "bundle size at most 150 KB" or "reduce runtime by 30%".',
      validate: (v) => validTarget(v),
    }]],
    definedBy: (t) => /\d/.test(t),            // a number in the REQUEST defines a threshold
  },
];

// A measurable target (QB-17 re-review 2): a metric, a comparator and a number.
//   "p95 latency < 200ms" · "bundle size at most 150 KB" · "reduce runtime by 30%"
const COMPARATOR = /(<=|>=|=<|≤|≥|<|>|\b(?:under|below|above|over|at most|at least|within|less than|more than|fewer than|greater than|no more than|no less than|up to)\b|\b(?:reduce[ds]?|decrease[ds]?|cut|lower(?:ed)?|increase[ds]?|raise[ds]?|improve[ds]?|bring|drop|speed up)\b.{0,40}?\b(?:by|to)\b)/i;
const NOT_METRIC = new Set(['under', 'below', 'above', 'over', 'at', 'most', 'least', 'within', 'less', 'more', 'fewer', 'greater', 'than', 'no', 'up',
  'to', 'by', 'reduce', 'reduces', 'reduced', 'decrease', 'decreases', 'decreased', 'cut', 'lower', 'lowered', 'increase', 'increases', 'increased',
  'raise', 'raises', 'raised', 'improve', 'improves', 'improved', 'bring', 'drop', 'speed', 'the', 'a', 'an', 'of', 'for', 'and', 'it', 'is', 'be',
  'ms', 's', 'sec', 'secs', 'second', 'seconds', 'millisecond', 'milliseconds', 'min', 'mins', 'minute', 'minutes', 'h', 'hours',
  'b', 'kb', 'mb', 'gb', 'byte', 'bytes', 'percent', 'pct', 'x', 'times', 'rps', 'qps']);
function validTarget(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > 200 || UNCERTAIN.test(t) || !/\d/.test(t) || !COMPARATOR.test(t)) return false;
  return (t.toLowerCase().match(/[a-z][a-z0-9]*/g) || []).some((w) => !NOT_METRIC.has(w));
}

/** Choices that need a value, as "<rule>.<choice>" (an audit of the rule table). */
const parameterizedChoices = () => AMBIGUITY_RULES.flatMap((r) => r.choices.filter((c) => c[3]).map(([id]) => `${r.id}.${id}`));

/** The vague term is defined right where it is used. */
function definesTerm(text, rule) {
  if (rule.definedBy) return rule.definedBy(text);
  const re = new RegExp(rule.term.source, 'gi');
  for (const m of String(text).matchAll(re)) if (DEFINITION.test(text.slice(m.index + m[0].length))) return true;
  return false;
}

// Free text that does not commit to one choice: uncertainty, deferral, alternatives.
const UNCERTAIN = /\b(can'?t|cannot|can not|unsure|not sure|don'?t know|do not know|undecided|unclear|either|neither|whichever|any of|or|maybe|perhaps|possibly|probably|might|later|again|you (choose|decide|pick)|up to you|your call|between)\b|\?/i;
// A choice mention preceded by a negation within a few words.
const NEGATED = (a, re) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of a.matchAll(g)) if (/\b(not|no|never|without|don'?t|do not|avoid|skip|except)\b(\W+\w+){0,2}\W*$/i.test(a.slice(0, m.index))) return true;
  return false;
};

/** A structured selection: "<question>=<choice>" or { question, choice }. */
function parseSelection(answer) {
  if (answer && typeof answer === 'object') {
    if (typeof answer.question !== 'string' || typeof answer.choice !== 'string') return null;
    return { question: answer.question, choice: answer.choice, ...(answer.value !== undefined ? { value: String(answer.value) } : {}) };
  }
  // "<question>=<choice>" or "<question>=<choice>:<value>"
  const m = /^\s*([a-z][a-z0-9_-]*)\s*=\s*([a-z][a-z0-9_-]*)(?:\s*:\s*([\s\S]*?))?\s*$/i.exec(String(answer || ''));
  return m ? { question: m[1], choice: m[2], ...(m[3] !== undefined ? { value: m[3] } : {}) } : null;
}

/**
 * What one answer (already bound to `rule`) does to it:
 *   { resolved: { choice, value } } | { pending: choice } (a parameterized choice still
 *   needing its value) | null (nothing — the rule stays open).
 * `pending` is the parameterized choice selected earlier, if any.
 */
function applyAnswer(answer, rule, pending = null) {
  const sel = parseSelection(answer);
  const withValue = (ch, value) => (ch[3].validate(value) ? { resolved: { choice: ch[0], value: String(value).trim() } } : { pending: ch });
  if (sel) {
    if (sel.question !== rule.id) return null;
    const ch = rule.choices.find(([id]) => id === sel.choice);
    if (!ch) return null;
    return ch[3] ? withValue(ch, sel.value) : { resolved: { choice: ch[0], value: null } };
  }
  const a = String(answer || '');
  if (pending) return withValue(pending, a);              // the follow-up: the answer IS the value
  if (!a.trim() || UNCERTAIN.test(a)) return null;
  if (rule.definedBy) {                                   // threshold rules: the answer must be a valid target
    const ch = rule.choices.find((c) => c[3]);
    return ch && ch[3].validate(a) ? { resolved: { choice: ch[0], value: a.trim() } } : null;
  }
  if (rule.term.test(a) && definesTerm(a, rule)) return { resolved: { choice: null, value: a.trim() } };
  const picked = rule.choices.filter(([, , re]) => re.test(a));
  if (picked.length !== 1 || NEGATED(a, picked[0][2])) return null;
  return picked[0][3] ? withValue(picked[0], a) : { resolved: { choice: picked[0][0], value: null } };
}

/** Does this answer (already bound to `rule`) affirmatively and completely resolve it? */
const answerResolves = (answer, rule) => Boolean(applyAnswer(answer, rule)?.resolved);

/** The text of an answer, for history and prompts. */
const answerText = (a) => {
  if (a && typeof a === 'object') {
    const sel = parseSelection(a);
    return sel ? `${sel.question}=${sel.choice}${sel.value !== undefined ? `:${sel.value}` : ''}` : String(a.answer ?? '');
  }
  return String(a ?? '');
};

/**
 * Run deterministic ambiguity checks on a request and the answers given so far.
 * Returns null when every vague term is defined (by the request or an answer bound
 * to it), otherwise the clarifying response with the open choices.
 *
 * Each answer is bound to one question: a structured selection to the question it
 * names; an entry { question_id, answer } to that question; any other answer to the
 * question asked when it was given — the first one still open at that point.
 *
 * @param {string} request
 * @param {Array<string|{question, choice}|{question_id, answer}>} [answers]
 */
function detectAmbiguity(request, answers = []) {
  const { open } = resolveClarifications(request, answers);
  if (!open.length) return null;
  // The first open question is asked (most specific ambiguity wins).
  return { ambiguity_flags: open.map((u) => u.flag), clarifying_question: open[0].question, unresolved: open };
}

/**
 * Resolve the request's vague terms against the answers given so far (the binding
 * rules above). A rule whose parameterized choice still needs its value stays open
 * as its follow-up question { id: "<rule>.target", parent, choice, question }.
 * @returns {{ open: Array, resolved: Array<{ question_id, choice, value }>, byEntry: Array }}
 *   resolved  each rule an answer resolved: choice id (null for a definition) and value
 *   byEntry   per answer: { rule_id, resolved?: { choice, value } }, or null if bound to nothing
 */
function resolveClarifications(request, answers = []) {
  const open = AMBIGUITY_RULES.filter((rule) => rule.term.test(request) && (!rule.applies || rule.applies(request)) && !definesTerm(request, rule));
  const pending = new Map();      // rule id → the parameterized choice awaiting its value
  const resolved = [];
  const byEntry = [];
  for (const entry of answers) {
    const bound = entry && typeof entry === 'object' && 'answer' in entry ? entry : { question_id: null, answer: entry };
    const sel = parseSelection(bound.answer);
    const rule = sel ? open.find((r) => r.id === sel.question)
      : bound.question_id ? open.find((r) => r.id === bound.question_id || `${r.id}.target` === bound.question_id) : open[0];
    if (!rule) { byEntry.push(null); continue; }
    const out = applyAnswer(bound.answer, rule, sel ? null : pending.get(rule.id) || null);
    if (out && out.resolved) {
      open.splice(open.indexOf(rule), 1);
      pending.delete(rule.id);
      resolved.push({ question_id: rule.id, ...out.resolved });
    } else if (out && out.pending) pending.set(rule.id, out.pending);
    byEntry.push({ rule_id: rule.id, ...(out && out.resolved ? { resolved: out.resolved } : {}) });
  }
  const items = open.map((rule) => {
    const p = pending.get(rule.id);
    if (p) return { id: `${rule.id}.target`, parent: rule.id, choice: p[0], question: p[3].followup, choices: [], options: [], flag: rule.flag };
    return {
      id: rule.id,
      question: typeof rule.question === 'function' ? rule.question(request) : rule.question,
      choices: rule.choices.map(([, label]) => label),
      options: rule.choices.map(([id, label, , param]) => ({ id, label, ...(param ? { needs_value: true } : {}) })),
      flag: rule.flag,
    };
  });
  return { open: items, resolved, byEntry };
}

/**
 * Structural check of a contract's recorded clarifications (QB-17 re-review 2): each
 * names a known rule and one of its choices; a parameterized choice carries a valid
 * value; a definition (choice null) carries its text; other choices take no value.
 */
function clarificationErrors(c) {
  const cl = c?.clarifications;
  if (cl === undefined) return [];
  if (!Array.isArray(cl)) return ['clarifications must be an array of { question_id, choice, value }'];
  const errors = [];
  for (const e of cl) {
    const rule = e && typeof e === 'object' ? AMBIGUITY_RULES.find((r) => r.id === e.question_id) : null;
    if (!rule) { errors.push(`clarification ${JSON.stringify(e)} names no known question`); continue; }
    if (e.choice === null) {
      if (typeof e.value !== 'string' || !e.value.trim()) errors.push(`clarification ${rule.id} defines the term but has no text`);
      continue;
    }
    const ch = rule.choices.find(([id]) => id === e.choice);
    if (!ch) { errors.push(`clarification ${rule.id} names unknown choice ${JSON.stringify(e.choice)}`); continue; }
    if (ch[3] && !ch[3].validate(e.value)) errors.push(`clarification ${rule.id}=${ch[0]} needs a valid value: ${JSON.stringify(e.value ?? null)} is not a measurable target (metric, comparator, number)`);
    if (!ch[3] && e.value !== null && e.value !== undefined) errors.push(`clarification ${rule.id}=${ch[0]} takes no value`);
  }
  return errors;
}

module.exports = { detectAmbiguity, resolveClarifications, answerResolves, parseSelection, answerText, clarificationErrors,
  parameterizedChoices, validTarget, AMBIGUITY_RULES };
