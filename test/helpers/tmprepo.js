/**
 * tmprepo.js — disposable git repositories for tests.
 *
 * Every repo lives under os.tmpdir() and is removed by cleanup().
 * Git is always invoked with argv (never a shell string) so fixture
 * filenames containing metacharacters are safe to create.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME:     'qb-test',
  GIT_AUTHOR_EMAIL:    'qb-test@example.invalid',
  GIT_COMMITTER_NAME:  'qb-test',
  GIT_COMMITTER_EMAIL: 'qb-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Create a temp git repo.
 * @param {object} files - { relPath: contents } committed as the initial commit
 * @returns {{ dir, git, write, read, commit, cleanup, head }}
 */
function makeRepo(files = { 'README.md': '# fixture\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  const repo = {
    dir,
    git:   (args, opts) => git(dir, args, opts),
    write: (rel, content) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return abs;
    },
    read:  rel => fs.readFileSync(path.join(dir, rel), 'utf8'),
    commit: (msg = 'commit') => {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '--allow-empty', '-m', msg]);
      return repo.head();
    },
    head: () => git(dir, ['rev-parse', 'HEAD']).trim(),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };

  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  repo.commit('initial');
  return repo;
}

/**
 * Fingerprint the full working state of a repo: HEAD, index, status
 * (including ignored files) and a hash of every file on disk except .git/.
 * Two equal fingerprints mean the tree was preserved byte-for-byte.
 */
function fingerprint(dir) {
  const crypto = require('crypto');
  const files = {};
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === '.git' && d === dir) continue;
      const abs = path.join(d, ent.name);
      const rel = path.relative(dir, abs);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isSymbolicLink()) files[rel] = 'link:' + fs.readlinkSync(abs);
      else files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(dir);

  return {
    head:   git(dir, ['rev-parse', 'HEAD']).trim(),
    index:  git(dir, ['ls-files', '-s']),
    status: git(dir, ['status', '--porcelain=v1', '--ignored', '-z']),
    files,
  };
}

module.exports = { makeRepo, fingerprint, git };
