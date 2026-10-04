/**
 * intent/examples.js — trusted calculations for computable examples (QB-13).
 *
 * L1 writes concrete examples into acceptance criteria and checks ("formats
 * 30000 ms as '5m'", call_returns formatDuration(30000) → "5m"). The model can
 * get the arithmetic wrong, and a judge or a check that trusts it will grade
 * against the error. QB recomputes every example it can parse, independently of
 * any model, and reports each one that is wrong. Nothing is corrected
 * automatically: a contract with a wrong example is not executed (the contract
 * is never altered to fit).
 *
 * Supported now: time durations (ms, s, min, h, d and their spelled-out forms,
 * e.g. "1m 23s", "2 minutes"). Other units are not validated; that is reported
 * as "not checked", never as correct.
 */

const UNIT_MS = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};
const UNIT_RE = 'milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d';
const QUOTES = `'"‘’“”\``;

/** A duration written as text ("4m 10s", "45s", "2 minutes") → milliseconds, or null if it is not exactly that. */
function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})(?![a-z])[\\s,]*`, 'gy');
  let ms = 0, matched = 0, m;
  while ((m = re.exec(t)) !== null) { ms += Number(m[1]) * UNIT_MS[m[2]]; matched = re.lastIndex; }
  return matched === t.length && matched > 0 ? ms : null;
}

/** The canonical short form of a duration, for messages ("30s", "2m", "1m 23s"). */
function formatDuration(ms) {
  if (ms === 0) return '0s';
  const parts = [];
  for (const [u, v] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]]) {
    if (ms >= v) { parts.push(`${Math.floor(ms / v)}${u}`); ms %= v; }
  }
  return parts.join(' ');
}

const num = (s) => Number(String(s).replace(/,/g, ''));

/** "<quantity> <unit> … as/→/= '<duration>'" claims in free text. */
function claimsInText(text) {
  const q = `[${QUOTES}]`;
  const re = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_RE})(?![a-z])[^${QUOTES}\\n]{0,40}?\\b(?:as|to|into|returns?|gives|is|equals?|yields)\\b\\s*${q}([^${QUOTES}]{1,40})${q}`
    + `|(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_RE})(?![a-z])\\s*(?:->|→|=>|=)\\s*${q}?([^${QUOTES},;)]{1,40}?)${q}?(?=$|[\\s,;).])`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const [qty, unit, target] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
    out.push({ input: `${qty} ${unit}`, inputMs: num(qty) * UNIT_MS[unit.toLowerCase()], target: target.trim() });
  }
  return out;
}

/**
 * Check every computable example in a contract with trusted arithmetic.
 * @returns {{ errors: Array, checked: Array }} each entry: { where, claim, stated, correct }
 */
function validateExamples(contract) {
  const errors = [], checked = [];
  const record = (where, input, inputMs, target) => {
    const statedMs = parseDuration(target);
    if (statedMs === null) return;                                   // not a duration: not checked
    const entry = { where, claim: `${input} → '${target}'`, stated_ms: statedMs, correct_ms: inputMs, correct: formatDuration(inputMs) };
    (statedMs === inputMs ? checked : errors).push(entry);
  };
  const acs = Array.isArray(contract?.acceptance_criteria) ? contract.acceptance_criteria : [];
  for (const ac of acs) {
    for (const c of claimsInText(String(ac?.criterion || ''))) record(ac.id, c.input, c.inputMs, c.target);
  }
  // call_returns checks whose single numeric argument is a quantity in the unit
  // its criterion names (e.g. "milliseconds") and whose expected value is a duration.
  // Only a spelled-out unit (or "ms") names the argument's unit; single letters are too ambiguous.
  const unitOf = (text) => {
    const m = /\b(milliseconds?|ms|seconds?|minutes?|hours?|days?)\b/i.exec(String(text || '').replace(/\d[\d,.]*\s*[a-z]+/gi, ''));
    return m ? m[1].toLowerCase() : null;
  };
  for (const ch of Array.isArray(contract?.checks) ? contract.checks : []) {
    const p = ch?.params;
    if (ch?.adapter !== 'call_returns' || !p || !Array.isArray(p.args) || p.args.length !== 1 || typeof p.args[0] !== 'number' || typeof p.expect !== 'string') continue;
    const ac = acs.find((a) => a && a.id === ch.ac_id);
    const unit = unitOf(`${ac ? ac.criterion : ''} ${contract.goal || ''}`);
    if (!unit || !UNIT_MS[unit]) continue;
    record(ch.id, `${p.args[0]} ${unit}`, p.args[0] * UNIT_MS[unit], p.expect);
  }
  return { errors, checked };
}

module.exports = { validateExamples, parseDuration, formatDuration };
