/**
 * verify/policy.js — scope and constraints as enforced policy (QB-09).
 *
 * The approved contract (QB-13) declares:
 *   scope.allowed_changes   path globs the task may change — an explicit allowlist.
 *                           Retrieval relevance (L2's relevant_files) is NOT
 *                           authorization: a file outside this list is unauthorized
 *                           until a human widens the scope (a new approval).
 *   scope.protected_paths   path globs the task must not change at all.
 *   constraint_policy       one entry per constraint (by index) saying how it is
 *                           enforced: by the scope (protected_paths / allowed_changes),
 *                           by an executable check id (QB-16), or explicitly
 *                           `advisory` (shown to the human, not machine-checked).
 *
 * Outcome, from the captured change set (never from the agent's claims):
 *   fail        a protected path changed, or an enforced constraint was violated
 *   unresolved  a change outside allowed_changes, or a constraint with no
 *               enforcement / no usable evidence
 *   ok          otherwise
 * Globs: `**` any path segments, `*` within a segment, `?` one character.
 */

const MAX_PATTERNS = 64;

/** A path glob → RegExp (anchored). A trailing "/**" also matches the directory itself. */
function globToRegExp(glob) {
  const body = (g) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  };
  const re = glob.endsWith('/**') ? `${body(glob.slice(0, -3))}(?:/.*)?` : body(glob);
  return new RegExp(`^${re}$`);
}

const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

/** Validate one list of path globs. Returns error strings. */
function patternErrors(list, name) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`scope.${name} must be an array of path globs`];
  if (list.length > MAX_PATTERNS) return [`scope.${name} has more than ${MAX_PATTERNS} patterns`];
  const errors = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p || p.length > 300 || /[\u0000-\u001f\u007f]/.test(p) || p.startsWith('/')
      || p.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      errors.push(`scope.${name} entry ${JSON.stringify(p)} is not a plain repository-relative glob`);
    }
  }
  return errors;
}

/**
 * Structural validation of a contract's policy (used by contractState).
 * @returns {string[]} errors
 */
function policyErrors(c) {
  const errors = [];
  const scope = c?.scope;
  if (scope !== undefined && (scope === null || typeof scope !== 'object' || Array.isArray(scope))) return ['scope must be an object'];
  errors.push(...patternErrors(scope?.allowed_changes, 'allowed_changes'), ...patternErrors(scope?.protected_paths, 'protected_paths'));
  const cp = c?.constraint_policy;
  if (cp === undefined) return errors;
  if (!Array.isArray(cp)) return [...errors, 'constraint_policy must be an array'];
  const n = Array.isArray(c.constraints) ? c.constraints.length : 0;
  const checkIds = new Set((c.checks || []).map((k) => k.id));
  const seen = new Set();
  for (const e of cp) {
    if (!e || !Number.isInteger(e.constraint) || e.constraint < 0 || e.constraint >= n) { errors.push(`constraint_policy entry ${JSON.stringify(e)} names no constraint`); continue; }
    if (seen.has(e.constraint)) { errors.push(`constraint ${e.constraint} has more than one policy entry`); continue; }
    seen.add(e.constraint);
    if (e.advisory === true) continue;
    if (!Array.isArray(e.enforced_by) || !e.enforced_by.length) { errors.push(`constraint ${e.constraint} must be enforced_by something or be advisory`); continue; }
    for (const b of e.enforced_by) {
      if (b?.kind === 'check' && !checkIds.has(b.ref)) errors.push(`constraint ${e.constraint} refers to unknown check ${JSON.stringify(b.ref)}`);
      else if (b?.kind === 'protected_paths' && !(scope?.protected_paths || []).includes(b.ref)) errors.push(`constraint ${e.constraint} refers to a protected path not in scope.protected_paths: ${JSON.stringify(b.ref)}`);
      else if (!['check', 'protected_paths', 'allowed_changes'].includes(b?.kind)) errors.push(`constraint ${e.constraint} has an unknown enforcement ${JSON.stringify(b)}`);
    }
  }
  return errors;
}

/** Every file the captured result changes: the change list plus the diff headers (both sides of a rename). */
function changedFiles(execution) {
  const files = new Set();
  for (const c of execution?.changes || []) if (c && typeof c.file === 'string') files.add(c.file);
  for (const f of execution?.unsupported_changes || []) if (typeof f === 'string') files.add(f);
  for (const m of String(execution?.diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) { files.add(m[1]); files.add(m[2]); }
  return [...files].sort();
}

/**
 * Evaluate the policy against the captured change set and the executed checks.
 * @param {object} contract
 * @param {object} execution
 * @param {Array}  checkResults - validated results from stage ⑥ ([{ id, status }])
 */
function evaluatePolicy(contract, execution, checkResults = []) {
  const allowed = contract?.scope?.allowed_changes || [];
  const prot = contract?.scope?.protected_paths || [];
  const changed = changedFiles(execution);
  const protectedTouched = changed.filter((f) => matchesAny(f, prot));
  const outOfScope = changed.filter((f) => !protectedTouched.includes(f) && !matchesAny(f, allowed));
  const status = (id) => (checkResults.find((r) => r.id === id) || {}).status;

  const constraints = (contract?.constraints || []).map((text, index) => {
    const e = (contract.constraint_policy || []).find((p) => p && p.constraint === index);
    if (!e) return { index, text: String(text), status: 'unresolved', by: [], detail: 'no enforcement declared' };
    if (e.advisory === true) return { index, text: String(text), status: 'advisory', by: [], detail: 'advisory: not machine-checked' };
    const results = e.enforced_by.map((b) => {
      if (b.kind === 'protected_paths') return changed.some((f) => matchesAny(f, [b.ref])) ? 'violated' : 'enforced';
      if (b.kind === 'allowed_changes') return outOfScope.length ? 'violated' : 'enforced';
      const s = status(b.ref);
      return s === 'pass' ? 'enforced' : s === 'fail' ? 'violated' : 'unresolved';
    });
    const st = results.includes('violated') ? 'violated' : results.includes('unresolved') ? 'unresolved' : 'enforced';
    return { index, text: String(text), status: st, by: e.enforced_by.map((b) => `${b.kind}${b.ref ? `:${b.ref}` : ''}`) };
  });

  const effect = protectedTouched.length || constraints.some((c) => c.status === 'violated') ? 'fail'
    : outOfScope.length || constraints.some((c) => c.status === 'unresolved') ? 'unresolved' : 'ok';
  return { allowed_changes: allowed, protected_paths: prot, changed_files: changed, out_of_scope: outOfScope,
    protected_touched: protectedTouched, constraints, effect };
}

module.exports = { evaluatePolicy, policyErrors, changedFiles, globToRegExp, matchesAny };
