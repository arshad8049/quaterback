/**
 * QB-02 step 3 — seed ① and capture ④ with real Docker (agent-sandbox.md §6,
 * §9.1–9.2; §11.2 T-TREE, T-FS). QB_INTEGRATION=1 only.
 *
 *   - QB-03's two reproduced attacks (agent-written core.fsmonitor; clean filter
 *     + .gitattributes) do not execute: capture never reads the agent's .git.
 *   - Hostile trees end in the right UNRESOLVED reason, bounded, with no hang.
 *   - Fidelity: base + patch reproduces the candidate tree exactly (bytes,
 *     modes, symlinks), for every §6 case.
 *   - The user's checkout is byte-identical before and after (T-FS).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const D = require('../../lib/sandbox/docker');
const { createWorkspace, hardened } = require('../../lib/sandbox/workspace');
const { makeRepo, fingerprint } = require('../helpers/tmprepo');

const ENABLED = process.env.QB_INTEGRATION === '1';
const BUSYBOX = 'busybox:1.36.1';
let seq = 0;
const created = [];

/** Seed a workspace from `repo`, let a stand-in agent run `script` in /work, then capture. */
async function scenario(repo, script, opts = {}) {
  const runId = `qbcap-${process.pid}-${seq++}`;
  created.push(runId);
  const ws = await createWorkspace(runId);
  const seeded = await ws.seed(repo.dir);
  assert.equal(seeded.stage.state, 'completed', seeded.stage.stderr);
  const agent = await D.runStage(`${runId}-agent`, [...hardened(runId, 'workload'), '--network', 'none',
    ...ws.mount('work'), ...(opts.extraMounts || []), BUSYBOX, 'sh', '-c', script], { waitTimeoutMs: 300_000 });
  assert.equal(agent.state, 'completed', `stand-in agent: ${agent.stderr}`);
  const cap = await ws.capture(opts.capture || {});
  return { ws, seeded, cap };
}
const names = (cap) => {
  const out = {};
  for (let i = 0; i < cap.nameStatus.length; i += 2) out[cap.nameStatus[i + 1]] = cap.nameStatus[i];
  return out;
};

describe('seed and capture (T-TREE, fidelity, T-FS)', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  let repo, before0;
  before(async () => {
    assert.ok((await D.op(['pull', '-q', BUSYBOX], { timeoutMs: 120_000 })).ok);
    repo = makeRepo({
      'crlf.txt': 'a\r\nb\r\n', 'mixed.txt': 'a\nb\r\nc', 'nonl.txt': 'x', 'bin.dat': Buffer.from([0, 1, 2, 255, 0]),
      'run.sh': '#!/bin/sh\necho hi\n', 'keep/a.js': 'a\n', 'keep/b.js': 'b\n', 'swap': 'file\n', 'dir2file/x': 'x\n',
      '.gitattributes': '* text=auto\n*.dat -text\neol.txt eol=crlf\n', 'eol.txt': 'one\ntwo\n',
      '.gitignore': 'build/\n', 'tracked-becomes-ignored.log': 'log\n',
    });
    fs.chmodSync(path.join(repo.dir, 'run.sh'), 0o755);
    fs.symlinkSync('crlf.txt', path.join(repo.dir, 'link'));
    repo.commit('fixture');
    repo.write('untracked.txt', 'not yet committed\n');           // seeded: user would commit it
    repo.write('build/ignored.txt', 'ignored by the user\n');      // not seeded
    before0 = fingerprint(repo.dir);
  });
  after(async () => {
    for (const id of created) await D.removeRun(id);
    if (repo) repo.cleanup();
  });

  test('seed: tracked + untracked-not-ignored files, bytes exact; user ignores respected; checkout untouched', async () => {
    const { ws, seeded } = await scenario(repo, 'true');
    assert.equal(seeded.report.rejected.length, 0);
    const r = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none', ...ws.mount('work', true), BUSYBOX,
      'sh', '-c', 'od -An -tx1 /work/crlf.txt; ls /work; [ -e /work/build/ignored.txt ] && echo IGNORED-SEEDED; [ -x /work/run.sh ] && echo EXEC; readlink /work/link']);
    assert.match(r.stdout, /61 0d 0a 62 0d 0a/, 'CRLF bytes changed by seeding');
    assert.match(r.stdout, /untracked\.txt/);
    assert.doesNotMatch(r.stdout, /IGNORED-SEEDED/);
    assert.match(r.stdout, /EXEC/);
    assert.match(r.stdout, /crlf\.txt/);
    assert.deepEqual(fingerprint(repo.dir), before0, 'the user checkout changed (T-FS)');
  });

  test('QB-03 attacks: agent-written fsmonitor and clean filter never execute during capture', async () => {
    const { ws, cap } = await scenario(repo, `
      printf '[core]\\n\\tfsmonitor = touch /out/PWNED_FSMONITOR /git/PWNED_FSMONITOR\\n[filter "x"]\\n\\tclean = touch /out/PWNED_FILTER /git/PWNED_FILTER; cat\\n' >> /work/.git/config
      echo '* filter=x' >> /work/.gitattributes
      echo changed > /work/crlf.txt`);
    assert.equal(cap.verdict.state, 'captured');
    const r = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none',
      ...ws.mount('out', true), ...ws.mount('git', true), BUSYBOX, 'sh', '-c', 'ls /out /git']);
    assert.doesNotMatch(r.stdout, /PWNED/, 'an agent-written git program ran during capture');
    assert.ok(!fs.readdirSync(repo.dir).some((f) => f.startsWith('PWNED')));
  });

  test('fidelity: every §6 change type round-trips exactly (base + patch = candidate)', async () => {
    const { ws, cap } = await scenario(repo, `
      cd /work
      printf 'a\\r\\nB\\r\\n' > crlf.txt          # CRLF kept
      printf 'z' > nonl.txt                      # no trailing newline
      printf '\\000\\377\\001' > bin.dat         # binary
      chmod -x run.sh; printf 'x\\n' > new.sh; chmod +x new.sh   # exec bit cleared / set
      ln -sf mixed.txt link; ln -s keep/a.js newlink             # symlink retarget / create
      rm keep/b.js                                               # delete one
      rm swap; mkdir swap; echo inside > swap/f                  # file → dir
      rm -r dir2file; echo now-a-file > dir2file                 # dir → file
      echo 'secret.js' >> .gitignore; echo 'hidden but new' > secret.js   # hidden by .gitignore → still captured
      echo 'tracked-becomes-ignored.log' >> .gitignore; echo changed >> tracked-becomes-ignored.log
      printf 'one\\ntwo\\nthree\\n' > eol.txt                    # eol=crlf attribute must not convert
      mkdir -p -- -dash && echo d > ./-dash/x; printf 'q' > "$(printf 'new\\nline.txt')"`);
    assert.equal(cap.verdict.state, 'captured', JSON.stringify(cap.verdict));
    const n = names(cap);
    assert.equal(n['keep/b.js'], 'D');
    assert.equal(n['secret.js'], 'A', '.gitignore hid a new file from capture');
    assert.equal(n['tracked-becomes-ignored.log'], 'M');
    assert.equal(n['swap/f'], 'A'); assert.equal(n.swap, 'D');
    assert.equal(n.dir2file, 'A'); assert.equal(n['dir2file/x'], 'D');
    assert.equal(n['new\nline.txt'], 'A', JSON.stringify(Object.keys(n)));
    assert.equal(n['-dash/x'], 'A');
    const f = await ws.fidelityCheck();
    assert.ok(f.ok, `base + patch did not reproduce the candidate: ${f.output}`);
    const v = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none', ...ws.mount('verify', true), BUSYBOX,
      'sh', '-c', 'od -An -tx1 /verify/crlf.txt; od -An -tx1 /verify/eol.txt']);
    assert.match(v.stdout, /61 0d 0a 42 0d 0a/);
    assert.match(v.stdout, /6f 6e 65 0a 74 77 6f 0a 74 68 72 65 65 0a/, 'eol attribute converted bytes in the verify copy');
  });

  test('delete every file → empty candidate tree, still faithful', async () => {
    const { ws, cap } = await scenario(repo, 'cd /work && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +');
    assert.equal(cap.verdict.state, 'captured');
    assert.equal(cap.candidateTree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assert.ok((await ws.fidelityCheck()).ok);
  });

  test('hostile tree: FIFO → UNRESOLVED capture_rejected_entries', async () => {
    const { cap } = await scenario(repo, 'mkfifo /work/fifo');
    assert.deepEqual([cap.verdict.state, cap.verdict.reason], ['unresolved', 'capture_rejected_entries']);
  });

  test('hostile tree: escaping and absolute symlinks → UNRESOLVED unsafe_symlink', async () => {
    const { cap } = await scenario(repo, 'ln -s /etc/passwd /work/abs; ln -s ../../../outside /work/keep/esc');
    assert.equal(cap.verdict.reason, 'unsafe_symlink');
    assert.deepEqual(cap.verdict.detail.map((x) => x.path).sort(), ['abs', 'keep/esc']);
  });

  test('hostile tree: too many files → UNRESOLVED capture_limit_exceeded, bounded', async () => {
    const t0 = Date.now();
    const { cap } = await scenario(repo, 'mkdir /work/many && cd /work/many && i=0; while [ $i -lt 3000 ]; do : > f$i; i=$((i+1)); done',
      { capture: { scanLimits: '--max-files 1000' } });
    assert.deepEqual([cap.verdict.reason, cap.verdict.detail], ['capture_limit_exceeded', 'file_count']);
    assert.ok(Date.now() - t0 < 120_000);
  });

  test('hostile tree: a huge sparse file → UNRESOLVED (per-file cap), no hang', async () => {
    const { cap } = await scenario(repo, 'dd if=/dev/zero of=/work/sparse bs=1 count=0 seek=900M 2>/dev/null',
      { capture: { scanLimits: '--max-file-bytes 10485760' } });
    assert.deepEqual([cap.verdict.reason, cap.verdict.detail], ['capture_limit_exceeded', 'file_bytes']);
  });

  test('no change → no_change verdict and an empty patch', async () => {
    const { cap } = await scenario(repo, 'true');
    assert.equal(cap.verdict.state, 'no_change');
    assert.equal(cap.patch.length, 0);
  });
});
