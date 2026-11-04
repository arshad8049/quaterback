/**
 * bench/l1-eval/score.js — KAN-106: pure scoring for the live L1 eval (no model, no I/O).
 *
 * outcomeOf(result, error)  the trial's outcome from compileIntent's handoff (or the error it threw)
 * categorize(errors)        validator error strings → stable category names (counted per model)
 * checkMatches(contract, m) the faithfulness PROXY: does some check meet matcher m?
 * summarize(trials)         per-model rates
 *
 * Outcomes:
 *   first_draft         finalized on the first model call
 *   after_correction    finalized by the one correction
 *   asked               a clarifying question (no contract; not counted as a failure, reported apart)
 *   invalid_syntax      blocked; the last draft was not JSON
 *   invalid_validation  blocked; the last draft was JSON the validator rejected
 *   timeout | error     the model call failed
 */

const OUTCOMES = ['first_draft', 'after_correction', 'asked', 'invalid_syntax', 'invalid_validation', 'timeout', 'error'];

function outcomeOf(result, error = null) {
  if (error) return error.code === 'DEADLINE' || /timed out/i.test(String(error.message)) ? 'timeout' : 'error';
  if (!result) return 'error';
  if (result.state === 'finalized') return result.repair?.attempted ? 'after_correction' : 'first_draft';
  if (result.state === 'needs_clarification' || result.state === 'blocked') return 'asked';
  const rejected = result.repair?.rejected || [];
  const last = rejected[rejected.length - 1];
  return last && last.kind === 'syntax' ? 'invalid_syntax' : 'invalid_validation';
}

// Order matters: the first matching rule names the category.
const CATEGORIES = [
  ['syntax', /not valid JSON/],
  ['quote_not_verbatim', /quote is not in the request verbatim|has no quote from the request/],
  ['request_untraced', /request text not traced|no requirements traced/],
  ['requirement_uncovered', /requirement R-\S+ .* is not covered by any acceptance criterion/],
  ['default_uncovered_or_new', /proposed default/],
  ['criterion_duplicate', /duplicates AC-/],
  ['criterion_untraced', /traces to no requirement|names unknown requirement/],
  ['example_wrong', /example is wrong/],
  ['scope_policy', /scope\.|constraint_policy|protected_paths|allowed_changes|^constraint \d+ /],
  ['check_invalid', /check|adapter|params\.|ac_id|args must be|module must be|export must be/],
  ['asked_instead_of_correcting', /asked a question instead/],
  ['schema_incomplete', /incomplete compiler output|has no text|has no id|no acceptance criteria/],
];

function categoryOf(err) {
  const s = String(err);
  for (const [name, re] of CATEGORIES) if (re.test(s)) return name;
  return 'other';
}

/** { category: count } over a list of error strings. */
function categorize(errors = []) {
  const out = {};
  for (const e of errors) { const c = categoryOf(e); out[c] = (out[c] || 0) + 1; }
  return out;
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** Does some check in the contract meet the matcher? Only the fields the matcher names are compared. */
function checkMatches(contract, m) {
  const checks = Array.isArray(contract?.checks) ? contract.checks : [];
  return checks.some((c) => {
    if (!c || c.adapter !== m.adapter) return false;
    const p = c.params || {};
    if (m.export !== undefined && p.export !== m.export) return false;
    if (m.args !== undefined && canon(p.args) !== canon(m.args)) return false;
    if (m.expect !== undefined && canon(p.expect) !== canon(m.expect)) return false;
    return true;
  });
}

/** null when the trial has no contract to judge; otherwise { met, total, missing }. */
function faithfulness(result, matchers = []) {
  if (!result || result.state !== 'finalized') return null;
  const missing = matchers.filter((m) => !checkMatches(result.contract, m));
  return { met: matchers.length - missing.length, total: matchers.length, missing };
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

/** Per-model summary. `usable` = finalized AND every proxy matcher met. */
function summarize(trials) {
  const byModel = {};
  for (const t of trials) {
    const s = byModel[t.model] ||= { model: t.model, trials: 0, outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
      first_draft_failure: { syntax: 0, invalid: 0 }, usable: 0, finalized: 0, proxy_failed: 0, calls: 0, ms: 0, categories: {}, by_task: {} };
    s.trials++;
    s.outcomes[t.outcome]++;
    s.calls += t.calls || 0;
    s.ms += t.ms || 0;
    const first = t.first_draft_failure;
    if (first) s.first_draft_failure[first]++;
    for (const [c, n] of Object.entries(t.categories || {})) s.categories[c] = (s.categories[c] || 0) + n;
    const finalized = t.outcome === 'first_draft' || t.outcome === 'after_correction';
    const ok = finalized && t.faithfulness && t.faithfulness.met === t.faithfulness.total;
    if (finalized) s.finalized++;
    if (finalized && !ok) s.proxy_failed++;
    if (ok) s.usable++;
    const bt = s.by_task[t.task] ||= { trials: 0, usable: 0, finalized: 0 };
    bt.trials++; if (finalized) bt.finalized++; if (ok) bt.usable++;
  }
  for (const s of Object.values(byModel)) {
    s.rates = { usable: pct(s.usable, s.trials), finalized: pct(s.finalized, s.trials), first_draft: pct(s.outcomes.first_draft, s.trials) };
    s.mean_calls = s.trials ? Math.round((100 * s.calls) / s.trials) / 100 : null;
    s.mean_seconds = s.trials ? Math.round(s.ms / s.trials / 100) / 10 : null;
  }
  return Object.values(byModel);
}

/** Markdown table for the summary. */
function markdown(summaries, meta = {}) {
  const lines = ['# L1 live eval (KAN-106)', ''];
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  lines.push('', '| model | trials | usable | finalized | 1st draft | after corr. | asked | blocked: syntax | blocked: validation | timeout/error | proxy failed | calls/trial | s/trial |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const o = s.outcomes;
    lines.push(`| ${s.model} | ${s.trials} | ${s.usable} (${s.rates.usable}%) | ${s.finalized} | ${o.first_draft} | ${o.after_correction} | ${o.asked} | ${o.invalid_syntax} | ${o.invalid_validation} | ${o.timeout + o.error} | ${s.proxy_failed} | ${s.mean_calls} | ${s.mean_seconds} |`);
  }
  lines.push('', '`usable` = finalized and every expected check present (a proxy, not proof of correctness).', '');
  for (const s of summaries) {
    lines.push(`## ${s.model}`, '', `First-draft failures: ${s.first_draft_failure.syntax} not JSON, ${s.first_draft_failure.invalid} rejected by the validator.`, '');
    lines.push('| task | trials | finalized | usable |', '|---|---|---|---|');
    for (const [task, b] of Object.entries(s.by_task)) lines.push(`| ${task} | ${b.trials} | ${b.finalized} | ${b.usable} |`);
    const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
    if (cats.length) lines.push('', 'Validator errors by category (all rejected drafts): ' + cats.map(([c, n]) => `${c} ${n}`).join(', '));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { OUTCOMES, outcomeOf, categorize, categoryOf, checkMatches, faithfulness, summarize, markdown };
