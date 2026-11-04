/**
 * bench/l1-eval/score.js — KAN-106: pure scoring for the live L1 eval (no model, no I/O).
 *
 * outcomeOf(result, error)  the trial's outcome from compileIntent's handoff (or the error it threw)
 * categorize(errors)        validator error strings → stable category names (counted per run group)
 * checkMatches(contract, m) the faithfulness PROXY: does some check meet matcher m?
 * rescore(trial, task)      recompute the proxy and categories from the saved contract and drafts
 * groupKey(trial)           the run identity trials may be pooled under (model digest, task set, code, settings)
 * summarize(trials)         per run group
 *
 * "proxy pass" = finalized AND every matcher of the task met. A matcher names the fields a check
 * must have (adapter, module, export, args, expect, a named relation). It shows that the expected
 * checks are present; it does NOT establish that the contract is complete or correct.
 *
 * Outcomes:
 *   first_draft         finalized on the first model call
 *   after_correction    finalized by the one correction
 *   asked               a clarifying question (no contract; reported apart, not finalized)
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
const num = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Named relations between a check's args and expect, for requests that fix a behaviour but not
 * its values (e.g. "clamp bounds n to [min, max]" names no numbers).
 */
const RELATIONS = {
  // clamp(n, min, max) with n < min returns min
  below_min_returns_min: (a, e) => Array.isArray(a) && a.length === 3 && a.every(num) && a[1] <= a[2] && a[0] < a[1] && e === a[1],
  // clamp(n, min, max) with n > max returns max
  above_max_returns_max: (a, e) => Array.isArray(a) && a.length === 3 && a.every(num) && a[1] <= a[2] && a[0] > a[2] && e === a[2],
  // clamp(n, min, max) with min <= n <= max returns n
  in_range_returns_n: (a, e) => Array.isArray(a) && a.length === 3 && a.every(num) && a[1] <= a[0] && a[0] <= a[2] && e === a[0],
  // some argument (at any depth) is a negative number
  some_negative_arg: (a) => { const neg = (x) => (num(x) ? x < 0 : Array.isArray(x) ? x.some(neg) : x && typeof x === 'object' ? Object.values(x).some(neg) : false); return neg(a); },
};

/** Does some check in the contract meet the matcher? Every field the matcher names must hold. */
function checkMatches(contract, m) {
  if (m.where && !RELATIONS[m.where]) throw new Error(`unknown matcher relation ${m.where}`);
  const checks = Array.isArray(contract?.checks) ? contract.checks : [];
  return checks.some((c) => {
    if (!c || c.adapter !== m.adapter) return false;
    const p = c.params || {};
    if (m.module !== undefined && p.module !== m.module) return false;
    if (m.module_matches !== undefined && !(typeof p.module === 'string' && new RegExp(m.module_matches).test(p.module))) return false;
    if (m.export !== undefined && p.export !== m.export) return false;
    if (m.args !== undefined && canon(p.args) !== canon(m.args)) return false;
    if (m.expect !== undefined && canon(p.expect) !== canon(m.expect)) return false;
    if (m.where && !RELATIONS[m.where](p.args, p.expect)) return false;
    return true;
  });
}

/** null when the trial has no contract to judge; otherwise { met, total, missing }. */
function faithfulness(result, matchers = []) {
  if (!result || result.state !== 'finalized') return null;
  const missing = matchers.filter((m) => !checkMatches(result.contract, m));
  return { met: matchers.length - missing.length, total: matchers.length, missing };
}

const isFinalized = (outcome) => outcome === 'first_draft' || outcome === 'after_correction';

/** Recompute the proxy and the error categories from what the trial saved (no model call). */
function rescore(t, task) {
  const result = isFinalized(t.outcome) ? { state: 'finalized', contract: t.contract } : null;
  return { ...t, faithfulness: task ? faithfulness(result, task.expect_checks) : null,
    categories: categorize((t.rejected || []).flatMap((r) => r.errors || [])) };
}

/**
 * Trials are pooled only under the same run identity: model digest, task set, harness/compiler
 * code and settings. Rows that predate recorded identity (KAN-106 run 1) group as "unrecorded".
 */
function groupKey(t) {
  const r = t.run || {};
  return [t.model, t.digest || 'digest?', r.task_set_sha256 || 'unrecorded', r.code_sha256 || 'unrecorded', canon(r.settings || null)].join('|');
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

/** Per run group. Two groups under one model name get distinct labels and a warning. */
function summarize(trials) {
  const groups = new Map();
  for (const t of trials) {
    const k = groupKey(t);
    let s = groups.get(k);
    if (!s) {
      s = { model: t.model, digest: t.digest || null, run: t.run || null, commits: [], trials: 0, outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
        first_draft_failure: { syntax: 0, invalid: 0 }, proxy_pass: 0, finalized: 0, proxy_failed: 0, calls: 0, ms: 0, categories: {}, by_task: {} };
      groups.set(k, s);
    }
    if (t.commit && !s.commits.includes(t.commit)) s.commits.push(t.commit);
    s.trials++;
    s.outcomes[t.outcome]++;
    s.calls += t.calls || 0;
    s.ms += t.ms || 0;
    if (t.first_draft_failure) s.first_draft_failure[t.first_draft_failure]++;
    for (const [c, n] of Object.entries(t.categories || {})) s.categories[c] = (s.categories[c] || 0) + n;
    const finalized = isFinalized(t.outcome);
    const pass = finalized && t.faithfulness && t.faithfulness.met === t.faithfulness.total;
    if (finalized) s.finalized++;
    if (finalized && !pass) s.proxy_failed++;
    if (pass) s.proxy_pass++;
    const bt = s.by_task[t.task] ||= { trials: 0, proxy_pass: 0, finalized: 0 };
    bt.trials++; if (finalized) bt.finalized++; if (pass) bt.proxy_pass++;
  }
  const out = [...groups.values()];
  const perModel = {};
  for (const s of out) perModel[s.model] = (perModel[s.model] || 0) + 1;
  const seen = {};
  for (const s of out) {
    seen[s.model] = (seen[s.model] || 0) + 1;
    s.label = perModel[s.model] > 1 ? `${s.model} #${seen[s.model]}` : s.model;
    s.warning = perModel[s.model] > 1 ? `${perModel[s.model]} incompatible runs under ${s.model} (different digest, task set, code or settings); not pooled` : null;
    s.rates = { proxy_pass: pct(s.proxy_pass, s.trials), finalized: pct(s.finalized, s.trials), first_draft: pct(s.outcomes.first_draft, s.trials) };
    s.mean_calls = s.trials ? Math.round((100 * s.calls) / s.trials) / 100 : null;
    s.mean_seconds = s.trials ? Math.round(s.ms / s.trials / 100) / 10 : null;
  }
  return out;
}

const WARNING = '`proxy pass` = finalized and every expected check present (each matcher names the adapter, module, export and values or relation it requires). It is a proxy: it does NOT establish that a contract is complete or correct.';

/** Markdown report. */
function markdown(summaries, meta = {}) {
  const lines = ['# L1 live eval (KAN-106)', ''];
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  lines.push('', '| run | trials | proxy pass | finalized | 1st draft | after corr. | asked | blocked: syntax | blocked: validation | timeout/error | finalized, proxy failed | calls/trial | s/trial |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const o = s.outcomes;
    lines.push(`| ${s.label} | ${s.trials} | ${s.proxy_pass} (${s.rates.proxy_pass}%) | ${s.finalized} | ${o.first_draft} | ${o.after_correction} | ${o.asked} | ${o.invalid_syntax} | ${o.invalid_validation} | ${o.timeout + o.error} | ${s.proxy_failed} | ${s.mean_calls} | ${s.mean_seconds} |`);
  }
  lines.push('', WARNING, '');
  for (const s of summaries) {
    lines.push(`## ${s.label}`, '');
    if (s.warning) lines.push(`**Warning:** ${s.warning}.`, '');
    const r = s.run;
    lines.push(`- model digest: ${s.digest || 'unknown'}`, `- commits recorded: ${s.commits.join(', ') || 'none'}`,
      r ? `- task set sha256: ${r.task_set_sha256}; code sha256: ${r.code_sha256}${r.dirty ? ' (working tree differed from the commit)' : ''}; settings: ${JSON.stringify(r.settings)}`
        : '- run identity: not recorded in these rows (see PROVENANCE.md next to the data)', '');
    lines.push(`First-draft failures: ${s.first_draft_failure.syntax} not JSON, ${s.first_draft_failure.invalid} rejected by the validator.`, '');
    lines.push('| task | trials | finalized | proxy pass |', '|---|---|---|---|');
    for (const [task, b] of Object.entries(s.by_task)) lines.push(`| ${task} | ${b.trials} | ${b.finalized} | ${b.proxy_pass} |`);
    const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
    if (cats.length) lines.push('', 'Validator errors by category (all rejected drafts): ' + cats.map(([c, n]) => `${c} ${n}`).join(', '));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { OUTCOMES, RELATIONS, outcomeOf, categorize, categoryOf, checkMatches, faithfulness, rescore, groupKey, summarize, markdown, WARNING };
