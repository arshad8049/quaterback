/**
 * agent/capture.js — complete change capture (QB-03).
 *
 * snapshot() records the full working-tree content (tracked + untracked,
 * excluding ignored files) as a git tree object, using a throwaway index so
 * the repository's real index, HEAD and refs are never modified. Diffing the
 * tree from before the agent ran against the tree after it ran captures
 * staged, unstaged, new, committed, renamed, deleted, binary, mode and
 * symlink changes in one patch, independent of what the agent did with git.
 *
 * Ignored files are not part of a tree and are therefore not captured;
 * submodule changes are reported as unsupported so they cannot PASS.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const proc = require('../lib/proc');

/** Write the current working tree of `dir` to a tree object; return its SHA. */
function snapshot(dir) {
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-idx-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const hasHead = proc.git(['rev-parse', '--verify', '-q', 'HEAD'], dir, { allowFail: true }).status === 0;
    if (hasHead) proc.git(['read-tree', 'HEAD'], dir, { env });
    proc.git(['add', '-A', '--', '.'], dir, { env });
    return proc.git(['write-tree'], dir, { env }).trim();
  } finally {
    fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/**
 * @returns {{ patch: string, changes: Array, unsupported: string[] }}
 *   changes: [{ file, status, old_file?, additions, deletions, binary }]
 */
function diffTrees(dir, baseTree, candTree) {
  if (baseTree === candTree) return { patch: '', changes: [], unsupported: [] };

  const patch = proc.git(['diff-tree', '-r', '-p', '--binary', '-M', '--full-index', '--no-color', baseTree, candTree], dir);

  // name-status -z: "<STATUS>\0<path>\0" or "R<score>\0<old>\0<new>\0"
  const ns = proc.git(['diff-tree', '-r', '-M', '--name-status', '-z', baseTree, candTree], dir).split('\0');
  const entries = [];
  for (let i = 0; i < ns.length - 1;) {
    const status = ns[i++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') entries.push({ status: status[0], old_file: ns[i++], file: ns[i++] });
    else entries.push({ status: status[0], file: ns[i++] });
  }

  // numstat -z: "<add>\t<del>\t<path>\0" or "<add>\t<del>\t\0<old>\0<new>\0"
  const counts = new Map();
  const nm = proc.git(['diff-tree', '-r', '-M', '--numstat', '-z', baseTree, candTree], dir).split('\0');
  for (let i = 0; i < nm.length - 1;) {
    const rec = nm[i++];
    if (!rec) continue;
    const [add, del, p] = rec.split('\t');
    const file = p === '' ? (i++, nm[i++]) : p;
    counts.set(file, { add, del });
  }

  // Submodule (gitlink) entries have mode 160000 in the raw output.
  const raw = proc.git(['diff-tree', '-r', '-z', baseTree, candTree], dir).split('\0');
  const unsupported = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    const meta = raw[i];
    if (meta && /^:(160000|\d{6}) (160000|\d{6})/.test(meta) && meta.includes('160000')) unsupported.push(raw[i + 1]);
  }

  const changes = entries.map(e => {
    const c = counts.get(e.file) || { add: '0', del: '0' };
    const binary = c.add === '-';
    return {
      file:      e.file,
      status:    e.status,
      ...(e.old_file ? { old_file: e.old_file } : {}),
      additions: binary ? 0 : parseInt(c.add, 10) || 0,
      deletions: binary ? 0 : parseInt(c.del, 10) || 0,
      binary,
    };
  });

  return { patch, changes, unsupported };
}

module.exports = { snapshot, diffTrees };
