/**
 * lib/workspace.js — disposable checkouts at a pinned revision (QB-05).
 *
 * The source repository is only ever read. Each workspace is a fresh
 * directory under os.tmpdir() built from a committed revision, so:
 *   - uncommitted / staged / untracked / ignored files in the source are
 *     never touched (and never leak into the experiment),
 *   - two workspaces from the same revision start from the same tree,
 *   - setup errors throw instead of being swallowed.
 *
 * Two materialisation modes:
 *   clone   — source is a repository root: `git clone --no-hardlinks`, then
 *             detach at the pinned commit. History is kept for L2.
 *   archive — source is a subdirectory of a repository (e.g. bench/fixtures
 *             inside the QB repo): `git archive <rev>:<subdir>` into a new
 *             repo with one commit at a fixed date, so the base commit SHA is
 *             deterministic for a given source tree.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const proc = require('./proc');

const FIXED_DATE = '2000-01-01T00:00:00Z';
const WS_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME:     'qb-workspace',
  GIT_AUTHOR_EMAIL:    'qb-workspace@localhost',
  GIT_COMMITTER_NAME:  'qb-workspace',
  GIT_COMMITTER_EMAIL: 'qb-workspace@localhost',
};

function git(args, cwd, opts = {}) {
  return proc.git(args, cwd, { env: WS_ENV, ...opts });
}

/**
 * @param {string} source            - path to a repository or a subdirectory of one
 * @param {object} [o]
 * @param {string} [o.baseRev='HEAD'] - commit-ish to pin
 * @param {string} [o.label]          - included in the temp dir name
 * @returns {{ dir, source, mode, baseRev, baseSha, baseTree, sourceDirty, cleanup }}
 */
function createWorkspace(source, o = {}) {
  const src = fs.realpathSync(path.resolve(source));
  const baseRev = o.baseRev || 'HEAD';

  const top = git(['rev-parse', '--show-toplevel'], src).trim();
  const topReal = fs.realpathSync(top);
  const prefix = path.relative(topReal, src);   // '' when src is the repo root

  const commit = git(['rev-parse', '--verify', `${baseRev}^{commit}`], topReal).trim();
  const sourceDirty = git(['status', '--porcelain', '-z', '--', prefix ? `:(literal)${prefix}` : '.'], topReal).length > 0;

  const label = String(o.label || 'ws').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'ws';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qb-${label}-`));

  try {
    if (!prefix) {
      git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', topReal, dir], os.tmpdir());
      git(['checkout', '--quiet', '--detach', commit], dir);
      // The agent must not be able to push back into the user's repository.
      git(['remote', 'remove', 'origin'], dir);
    } else {
      const tar = proc.run('git', ['archive', '--format=tar', `${commit}:${prefix}`], { cwd: topReal, encoding: 'buffer' });
      if (tar.status !== 0) throw new Error(`git archive failed: ${String(tar.stderr).trim()}`);
      const x = proc.run('tar', ['-x', '-f', '-', '-C', dir], { input: tar.stdout });
      if (x.status !== 0) throw new Error(`tar extract failed: ${String(x.stderr).trim()}`);

      const env = { ...WS_ENV, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
      proc.git(['init', '--quiet', '-b', 'main'], dir, { env });
      proc.git(['add', '-A'], dir, { env });
      proc.git(['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', `qb workspace base: ${commit.slice(0, 12)}:${prefix}`], dir, { env });
    }

    git(['config', 'user.name', 'qb-workspace'], dir);
    git(['config', 'user.email', 'qb-workspace@localhost'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);

    const baseSha  = git(['rev-parse', 'HEAD'], dir).trim();
    const baseTree = git(['rev-parse', 'HEAD^{tree}'], dir).trim();

    return {
      dir,
      source: src,
      mode: prefix ? 'archive' : 'clone',
      baseRev,
      sourceCommit: commit,
      baseSha,
      baseTree,
      sourceDirty,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { createWorkspace };
