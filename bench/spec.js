/**
 * bench/spec.js — frozen task specifications (QB-27).
 *
 * A spec is frozen into bench/specs.lock.json (qb-spec-lock/1) only when it is qualified
 * (bench/qualify.js) and its suite still hashes as qualified. Once frozen:
 *   - the same id + version can never change (a different hash is refused);
 *   - a fix needs a NEW version with a changelog entry for it (reason, disclosure date,
 *     and whether it was made after viewing results), so revisions are always disclosed;
 *   - runs use only specs whose content hash matches the lock (checkFrozen).
 */

const fs = require('fs');
const path = require('path');
const S = require('./schemas');
const { SUITES_ROOT } = require('./grader');

const LOCK_FILE = path.join(__dirname, 'specs.lock.json');

class SpecRefused extends Error {
  constructor(msg) { super(msg); this.code = 'SPEC_REFUSED'; }
}

const emptyLock = () => ({ schema: 'qb-spec-lock/1', specs: {} });
function readLock(file = LOCK_FILE) {
  if (!fs.existsSync(file)) return emptyLock();
  return S.SpecLock.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function loadSpec(file) { return S.TaskSpec.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }

/**
 * Freeze a qualified spec. Returns the new lock (also written to `lockFile`).
 * @param {object} spec  qb-task-spec/1 with qualification
 * @param {object} [o]   { lockFile, suitesRoot, now }
 */
function freeze(spec, o = {}) {
  spec = S.TaskSpec.parse(spec);
  const lockFile = o.lockFile || LOCK_FILE;
  if (!spec.qualification) throw new SpecRefused(`${spec.id}: not qualified — run bench/qualify.js first`);
  const suiteDir = path.join(o.suitesRoot || SUITES_ROOT, spec.suite.dir);
  if (S.treeHash(suiteDir) !== spec.qualification.suite_sha256) throw new SpecRefused(`${spec.id}: suite changed since qualification`);
  if (S.hashOf(S.fileHashes(suiteDir)) !== S.hashOf(spec.suite.files)) throw new SpecRefused(`${spec.id}: suite.files does not match the suite on disk`);
  const lock = readLock(lockFile);
  const sha = S.hashOf(spec);
  const prev = lock.specs[spec.id];
  if (prev) {
    if (spec.version === prev.version) {
      if (prev.sha256 === sha) return lock;   // already frozen, unchanged
      throw new SpecRefused(`${spec.id} v${spec.version} is frozen with a different hash — a change needs a new version with a disclosed changelog entry`);
    }
    if (spec.version < prev.version) throw new SpecRefused(`${spec.id}: v${spec.version} is older than the frozen v${prev.version}`);
    if (!spec.changelog.some((c) => c.version === spec.version)) throw new SpecRefused(`${spec.id} v${spec.version}: missing changelog entry disclosing the revision`);
    if (prev.split !== spec.split) throw new SpecRefused(`${spec.id}: split cannot change between versions (${prev.split} → ${spec.split})`);
  }
  const next = { ...lock, specs: { ...lock.specs, [spec.id]: { version: spec.version, sha256: sha, split: spec.split, frozen_at: (o.now || new Date()).toISOString() } } };
  S.SpecLock.parse(next);
  fs.writeFileSync(lockFile, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** Throws unless `spec` is exactly the frozen version. */
function checkFrozen(spec, lock = readLock()) {
  spec = S.TaskSpec.parse(spec);
  const e = lock.specs[spec.id];
  if (!e) throw new SpecRefused(`${spec.id}: not frozen`);
  if (e.version !== spec.version || e.sha256 !== S.hashOf(spec)) {
    throw new SpecRefused(`${spec.id}: does not match the frozen v${e.version} (edited after freezing? a change needs a new version)`);
  }
  return e;
}

module.exports = { freeze, checkFrozen, loadSpec, readLock, SpecRefused, LOCK_FILE };
