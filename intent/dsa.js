/**
 * DSA layer: deterministic ambiguity detection that runs before the LLM.
 *
 * Each rule names a vague term that has no testable meaning on its own. A rule
 * blocks only while the term is UNRESOLVED (QB-17):
 *   - the request itself defines it ("cleaner by extracting …", "cleaner: …",
 *     "more readable, meaning …"), or
 *   - an answer to an earlier round picks a concrete choice or defines it.
 * An answer that is itself vague ("just make it nicer", "you decide") leaves the
 * choice open. The LLM still handles novel or complex ambiguity.
 *
 * Each open rule is returned machine-readably: { id, question, choices, flag }.
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
      ['reduce function length', /\b(shorter|length|smaller functions?|split)\b/i],
      ['improve naming', /\b(nam(e|es|ing)|renam\w*)\b/i],
      ['extract helper functions', /\b(extract\w*|helpers?)\b/i],
      ['remove duplication', /\b(duplicat\w*|dedup\w*|dry)\b/i],
    ],
  },
  {
    id: 'better_refactor',
    term: /\bbetter\b/i,
    applies: (r) => /refactor|rewrite|clean|organiz|restructur/i.test(r),
    flag: '"better" with a refactor request has no testable definition — it could mean performance, readability, maintainability, or test coverage',
    question: 'What does "better" mean for this refactor? For example: improve performance, increase readability, add test coverage, reduce coupling, or something else?',
    choices: [
      ['improve performance', /\b(perform\w*|faster|latency|speed|throughput)\b/i],
      ['increase readability', /\b(readab\w*|naming|comments?)\b/i],
      ['add test coverage', /\b(tests?|coverage)\b/i],
      ['reduce coupling', /\b(coupl\w*|dependenc\w*|modular\w*)\b/i],
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
      ['split long functions', /\b(split\w*|shorter|length)\b/i],
      ['rename unclear identifiers', /\b(nam(e|es|ing)|renam\w*)\b/i],
      ['extract modules or helpers', /\b(extract\w*|modules?|helpers?)\b/i],
      ['remove duplication', /\b(duplicat\w*|dedup\w*)\b/i],
    ],
  },
  {
    id: 'like_existing',
    term: /\blike\s+(normal|existing|regular|standard|current|the\s+existing)\b/i,
    flag: '"like [existing thing]" could mean same data model, same onboarding flow, same validation, same error handling, or all of these — each leads to a different implementation',
    question: 'When you say "like [existing flow]", which specific aspects must match — the data model, the onboarding steps, the email validation, the error handling, or something else?',
    choices: [
      ['the data model', /\b(data model|schema|fields?|columns?)\b/i],
      ['the onboarding steps', /\b(onboard\w*|steps?|flow)\b/i],
      ['the validation', /\bvalidat\w*/i],
      ['the error handling', /\berrors?\b/i],
    ],
  },
  {
    id: 'improve_unmeasured',
    term: /\bimprove\b.{0,40}\b(performance|speed|ux|experience|quality)\b/i,
    applies: (r) => !/\d/.test(r),
    flag: 'Improvement without a measurable target — cannot write acceptance criteria without knowing the success threshold',
    question: 'What is the success threshold? For example: specific latency target, user satisfaction score, error rate reduction, or another measurable outcome?',
    choices: [['a numeric target (e.g. p95 latency < 200 ms)', /\d/]],
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

/** An answer resolves a rule if it picks a concrete choice or defines the term. */
function answerResolves(answer, rule) {
  const a = String(answer || '');
  return rule.choices.some(([, re]) => re.test(a)) || (rule.term.test(a) && definesTerm(a, rule)) || (rule.definedBy ? rule.definedBy(a) : false);
}

/**
 * Run deterministic ambiguity checks on a request and the answers given so far.
 * Returns null when every vague term is defined (by the request or an answer),
 * otherwise the clarifying response with the open choices.
 *
 * @param {string} request
 * @param {string[]} [answers]
 * @returns {{ ambiguity_flags: string[], clarifying_question: string, unresolved: Array<{ id, question, choices, flag }> } | null}
 */
function detectAmbiguity(request, answers = []) {
  const open = AMBIGUITY_RULES.filter((rule) => rule.term.test(request) && (!rule.applies || rule.applies(request))
    && !definesTerm(request, rule) && !answers.some((a) => answerResolves(a, rule)));
  if (!open.length) return null;
  const unresolved = open.map((rule) => ({
    id: rule.id,
    question: typeof rule.question === 'function' ? rule.question(request) : rule.question,
    choices: rule.choices.map(([label]) => label),
    flag: rule.flag,
  }));
  // The first open rule's question is asked (most specific ambiguity wins).
  return { ambiguity_flags: unresolved.map((u) => u.flag), clarifying_question: unresolved[0].question, unresolved };
}

module.exports = { detectAmbiguity, AMBIGUITY_RULES };
