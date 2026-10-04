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
 * One exact semantics for every captured name: a glob matches the WHOLE path, and
 * every wildcard matches any character except "/" (`**` also "/") — including
 * newline, CR and the other JS line terminators, which Git allows in filenames.
 * A changed path that is not a plain repository-relative name (control
 * characters, line terminators, absolute, "." / ".." / empty segments) is also
 * listed as unsupported: protected matching still applies to it (protection
 * wins), but it can never be authorized, so the task cannot PASS.
 */

const MAX_PATTERNS = 64;

/** A path glob → RegExp (anchored). A trailing "/**" also matches the directory itself. */
function globToRegExp(glob) {
  const body = (g) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:[^]*/)?'; i += 2; } else { re += '[^]*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  };
  const re = glob.endsWith('/**') ? `${body(glob.slice(0, -3))}(?:/[^]*)?` : body(glob);
  return new RegExp(`^(?:${re})$`, 'u');
}

const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

/** A changed path QB can reason about: plain, relative, no control characters or line terminators. */
const supportedPath = (f) => typeof f === 'string' && f.length > 0 && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(f)
  && !f.startsWith('/') && !f.split('/').some((s) => s === '' || s === '.' || s === '..');

/** Decode one side of a `diff --git` header: Git C-quotes names with unusual bytes ("a/x\nb"). */
function unquoteGitPath(token) {
  if (!token.startsWith('"')) return token;
  const bytes = [];
  const ESC = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const n = token[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(token.slice(i, i + 3), 8)); i += 2; } else bytes.push(ESC[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Both paths of a `diff --git` header line, or null. Quoted sides are decoded. */
function parseDiffHeader(line) {
  const rest = line.slice('diff --git '.length);
  if (!rest.includes('"')) {
    const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
    return m ? [m[1], m[2]] : null;
  }
  const tok = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (!tok) return null;
  const sides = [unquoteGitPath(tok[1]), unquoteGitPath(tok[2])];
  return sides[0].startsWith('a/') && sides[1].startsWith('b/') ? [sides[0].slice(2), sides[1].slice(2)] : null;
}

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
  for (const line of String(execution?.diff || '').split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const f of parseDiffHeader(line) || []) files.add(f);
  }
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
  const unsupported = changed.filter((f) => !supportedPath(f));
  const outOfScope = changed.filter((f) => !protectedTouched.includes(f) && (!supportedPath(f) || !matchesAny(f, allowed)));
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
    protected_touched: protectedTouched, unsupported_paths: unsupported, constraints, effect };
}

module.exports = { evaluatePolicy, policyErrors, changedFiles, globToRegExp, matchesAny, supportedPath, parseDiffHeader };
