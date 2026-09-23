/**
 * DSA layer: deterministic ambiguity detection that runs before the LLM.
 *
 * These patterns are reliably ambiguous regardless of context — if they match,
 * we return a clarifying question immediately without wasting an LLM call.
 * The LLM still handles novel or complex ambiguity that doesn't fit these rules.
 */

const AMBIGUITY_RULES = [
  {
    test: (r) => /\bcleaner\b/i.test(r),
    flag: '"cleaner" has no testable definition — it could mean shorter functions, better naming, fewer files, extracted helpers, removed duplication, or all of these',
    question: 'What does "cleaner" mean here? For example: reduce function length, improve naming conventions, extract helper functions, remove duplication, or something else?',
  },
  {
    test: (r) => /\bbetter\b/i.test(r) && /refactor|rewrite|clean|organiz|restructur/i.test(r),
    flag: '"better" with a refactor request has no testable definition — it could mean performance, readability, maintainability, or test coverage',
    question: 'What does "better" mean for this refactor? For example: improve performance, increase readability, add test coverage, reduce coupling, or something else?',
  },
  {
    test: (r) => /\bmore\s+(readable|maintainable|organized|modular|modern)\b/i.test(r),
    flag: 'Vague quality adjective — has no independently verifiable definition without knowing the specific outcome expected',
    question: (r) => {
      const adj = (r.match(/\bmore\s+(readable|maintainable|organized|modular|modern)\b/i) || [])[1] || 'that';
      return `What specifically makes the code "${adj}" — what would a verifier observe as evidence it was done?`;
    },
  },
  {
    test: (r) => /\blike\s+(normal|existing|regular|standard|current|the\s+existing)\b/i.test(r),
    flag: '"like [existing thing]" could mean same data model, same onboarding flow, same validation, same error handling, or all of these — each leads to a different implementation',
    question: 'When you say "like [existing flow]", which specific aspects must match — the data model, the onboarding steps, the email validation, the error handling, or something else?',
  },
  {
    test: (r) => /\bimprove\b.{0,40}\b(performance|speed|ux|experience|quality)\b/i.test(r) && !/\d/.test(r),
    flag: 'Improvement without a measurable target — cannot write acceptance criteria without knowing the success threshold',
    question: 'What is the success threshold? For example: specific latency target, user satisfaction score, error rate reduction, or another measurable outcome?',
  },
];

/**
 * Run deterministic ambiguity checks on a request string.
 * Returns a ClarifyingResponse object if a blocking ambiguity is detected, or null if clean.
 *
 * @param {string} request
 * @returns {{ ambiguity_flags: string[], clarifying_question: string } | null}
 */
function detectAmbiguity(request) {
  const matched = AMBIGUITY_RULES.filter(rule => rule.test(request));
  if (matched.length === 0) return null;

  const flags = matched.map(r => r.flag);
  // Use the first matched rule's question (most specific ambiguity wins)
  const question = typeof matched[0].question === 'function'
    ? matched[0].question(request)
    : matched[0].question;

  return { ambiguity_flags: flags, clarifying_question: question };
}

module.exports = { detectAmbiguity };
