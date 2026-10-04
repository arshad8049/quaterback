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
    choices: [['numeric_target', 'a numeric target (e.g. p95 latency < 200 ms)', /\d/]],
    definedBy: (t) => /\d/.test(t),            // only a number defines a threshold
  },
];

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
  if (answer && typeof answer === 'object') return typeof answer.question === 'string' && typeof answer.choice === 'string' ? { question: answer.question, choice: answer.choice } : null;
  const m = /^\s*([a-z][a-z0-9_-]*)\s*=\s*([a-z][a-z0-9_-]*)\s*$/i.exec(String(answer || ''));
  return m ? { question: m[1], choice: m[2] } : null;
}

/** Does this answer (already bound to `rule`) affirmatively resolve it? */
function answerResolves(answer, rule) {
  const sel = parseSelection(answer);
  if (sel) return sel.question === rule.id && rule.choices.some(([id]) => id === sel.choice);
  const a = String(answer || '');
  if (!a.trim() || UNCERTAIN.test(a)) return false;
  if (rule.definedBy) return rule.definedBy(a);
  if (rule.term.test(a) && definesTerm(a, rule)) return true;
  const picked = rule.choices.filter(([, , re]) => re.test(a));
  return picked.length === 1 && !NEGATED(a, picked[0][2]);
}

/** The text of an answer, for history and prompts. */
const answerText = (a) => (a && typeof a === 'object' ? (parseSelection(a) ? `${a.question}=${a.choice}` : String(a.answer ?? '')) : String(a ?? ''));

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
  let open = AMBIGUITY_RULES.filter((rule) => rule.term.test(request) && (!rule.applies || rule.applies(request)) && !definesTerm(request, rule));
  for (const entry of answers) {
    if (!open.length) break;
    const bound = entry && typeof entry === 'object' && 'answer' in entry ? entry : { question_id: null, answer: entry };
    const sel = parseSelection(bound.answer);
    const target = sel ? open.find((r) => r.id === sel.question)
      : bound.question_id ? open.find((r) => r.id === bound.question_id) : open[0];
    if (target && answerResolves(bound.answer, target)) open = open.filter((r) => r !== target);
  }
  if (!open.length) return null;
  const unresolved = open.map((rule) => ({
    id: rule.id,
    question: typeof rule.question === 'function' ? rule.question(request) : rule.question,
    choices: rule.choices.map(([, label]) => label),
    options: rule.choices.map(([id, label]) => ({ id, label })),
    flag: rule.flag,
  }));
  // The first open rule's question is asked (most specific ambiguity wins).
  return { ambiguity_flags: unresolved.map((u) => u.flag), clarifying_question: unresolved[0].question, unresolved };
}

module.exports = { detectAmbiguity, answerResolves, parseSelection, answerText, AMBIGUITY_RULES };
