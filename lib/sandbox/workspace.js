/**
 * lib/sandbox/workspace.js — per-run volumes, keeper, seed ① and capture ④
 * (agent-sandbox.md §3.1, §6, §8.1, §8.2, §9.2).
 *
 *   const ws = await createWorkspace(runId, { caps });   // tmpfs volumes + keeper Ⓚ
 *   await ws.seed(checkoutPath);                         // checkout → trusted git → /work
 *   ...agent stage mounts ws.mount('work')...
 *   const cap = await ws.capture();                      // /work → candidate tree → patch
 *
 * Nothing here runs repository code or reads the hostile workspace on the host:
 * seed and capture run QB's own scripts in the trusted tools image, without
 * network, and the host only reads capture's output volume through `docker cp`,
 * size-capped, as a strictly parsed tar whose files must match their SHA-256s.
 */

const crypto = require('crypto');
const path = require('path');
const D = require('./docker');
const { DEFAULT_CAPS } = require('./admission');
const { readTar } = require('./tar');

const TOOLS_IMAGE = process.env.QB_SANDBOX_TOOLS_IMAGE || 'qb-sandbox-tools:dev';
const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');
const VOLUMES = ['work', 'git', 'verify', 'out'];
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

/** Hardening shared by every container (§3). Stage-specific flags are added by callers. */
function hardened(runId, role) {
  return ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--init', '--pids-limit', '256',
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
    ...D.runLabels(runId, role)];
}

/** Build the trusted tools image if it is not present. Returns its image id. */
async function ensureToolsImage() {
  let r = await D.op(['image', 'inspect', '-f', '{{.Id}}', TOOLS_IMAGE]);
  if (r.ok) return r.stdout.trim();
  r = await D.op(['build', '-q', '-f', path.join(SANDBOX_DIR, 'Dockerfile.tools'), '-t', TOOLS_IMAGE, SANDBOX_DIR],
    { timeoutMs: 20 * 60_000 });
  if (!r.ok) throw Object.assign(new Error(`tools image build failed: ${r.stderr.slice(-500)}`), { code: 'IMAGE_BUILD_FAILED' });
  return r.stdout.trim();
}

/** Read named files from a (stopped) container path via `docker cp`, size-capped. */
async function readFromContainer(container, dir, maxBytes) {
  const r = await D.op(['cp', `${container}:${dir}/.`, '-'], { raw: true, maxBytes, timeoutMs: 120_000 });
  if (!r.ok) throw Object.assign(new Error(`docker cp failed: ${r.stderr.trim().slice(0, 300)}`), { code: 'CP_FAILED' });
  if (!r.stdout_buffer) throw Object.assign(new Error('output exceeds the size cap'), { code: 'TOO_LARGE' });
  return readTar(r.stdout_buffer);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function createWorkspace(runId, { caps = DEFAULT_CAPS } = {}) {
  const sizes = { work: caps.work, git: caps.git, verify: caps.verify, out: caps.out };
  const inodes = { work: 200_000, git: 200_000, verify: 200_000, out: 1000 };
  const image = await ensureToolsImage();
  for (const v of VOLUMES) {
    const r = await D.op(['volume', 'create', '--driver', 'local', ...D.runLabels(runId),
      '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
      '--opt', `o=size=${Math.floor(sizes[v])},nr_inodes=${inodes[v]},uid=10001,gid=10001,mode=0700`, `${runId}-${v}`]);
    if (!r.ok) throw Object.assign(new Error(`volume ${v}: ${r.stderr.trim()}`), { code: 'INFRA' });
  }
  const mounts = (names, ro = []) => names.flatMap((v) => ['-v', `${runId}-${v}:/${v}${ro.includes(v) ? ':ro' : ''}`]);
  // Keeper Ⓚ (E2: tmpfs volumes lose their contents when nothing holds them mounted).
  const k = await D.op(['run', '-d', '--name', `${runId}-keeper`, ...hardened(runId, 'keeper'), '--network', 'none',
    '--memory', '64m', '--memory-swap', '64m', ...mounts(VOLUMES), image, 'sleep', 'infinity']);
  if (!k.ok) throw Object.assign(new Error(`keeper: ${k.stderr.trim()}`), { code: 'INFRA' });

  const ws = {
    runId, image, caps,
    mount: (v, ro = false) => ['-v', `${runId}-${v}:/${v}${ro ? ':ro' : ''}`],

    /** Confirm the keeper is running (a daemon restart stops it and loses the volumes: §8.2). */
    async keeperAlive() {
      const st = await D.inspectState(`${runId}-keeper`);
      return Boolean(st && st.Running);
    },

    /** ① checkout → trusted refs/qb/base → /work. Returns { stage, report, baseTree, userHead }. */
    async seed(checkoutPath, { memoryBytes } = {}) {
      const name = `${runId}-seed`;
      const stage = await D.runStage(name, [...hardened(runId, 'seed'), '--network', 'none',
        ...(memoryBytes ? ['--memory', String(memoryBytes), '--memory-swap', String(memoryBytes)] : []),
        '-v', `${path.resolve(checkoutPath)}:/checkout:ro`, ...mounts(['git', 'work']),
        image, '/usr/local/lib/qb/seed.sh'], { waitTimeoutMs: 30 * 60_000 });
      if (stage.state !== 'completed') return { stage };
      const files = await readFromContainer(name, '/git', 4 * 1024 * 1024).catch((e) => ({ error: e }));
      if (files.error) return { stage, error: files.error.message };
      const report = JSON.parse(files.get('seed-report.json'));
      return { stage, report, baseTree: String(files.get('base-tree') || '').trim(), userHead: String(files.get('user-head') || '').trim() };
    },

    /** ④ /work → refs/qb/candidate → /out (+ /verify checkout). Returns the verified evidence and a verdict. */
    async capture({ memoryBytes, scanLimits } = {}) {
      const name = `${runId}-capture`;
      const stage = await D.runStage(name, [...hardened(runId, 'capture'), '--network', 'none',
        ...(memoryBytes ? ['--memory', String(memoryBytes), '--memory-swap', String(memoryBytes)] : []),
        ...(scanLimits ? ['-e', `QB_SCAN_LIMITS=${scanLimits}`] : []),
        ...mounts(['work', 'git', 'out', 'verify'], ['work']), image, '/usr/local/lib/qb/capture.sh'],
        { waitTimeoutMs: 30 * 60_000 });
      if (stage.state !== 'completed') return { stage, verdict: { state: 'error', reason: `capture ${stage.state}: ${stage.reason}` } };
      let files;
      try { files = await readFromContainer(name, '/out', MAX_PATCH_BYTES + 4 * 1024 * 1024); }
      catch (e) {
        return { stage, verdict: e.code === 'TOO_LARGE'
          ? { state: 'unresolved', reason: 'patch_too_large' } : { state: 'error', reason: e.message } };
      }
      // Every file must match the manifest written inside the container (§8.5).
      const manifest = String(files.get('manifest.sha256') || '');
      for (const line of manifest.trim().split('\n')) {
        const [hash, file] = line.split(/\s+/);
        if (!files.has(file) || sha256(files.get(file)) !== hash) {
          return { stage, verdict: { state: 'error', reason: `manifest mismatch for ${file}` } };
        }
      }
      const scan = JSON.parse(files.get('scan.json'));
      const ev = {
        stage, scan,
        patch: files.get('patch.bin'),
        nameStatus: String(files.get('name-status.z')).split('\0').filter(Boolean),
        baseTree: String(files.get('base.tree')).trim(),
        candidateTree: String(files.get('candidate.tree')).trim(),
      };
      // No partial capture can PASS (QB-03): anything not captured faithfully is UNRESOLVED.
      if (scan.limit_exceeded) ev.verdict = { state: 'unresolved', reason: 'capture_limit_exceeded', detail: scan.limit_exceeded };
      else if (scan.unsafe_symlinks.length) ev.verdict = { state: 'unresolved', reason: 'unsafe_symlink', detail: scan.unsafe_symlinks };
      else if (scan.rejected.length) ev.verdict = { state: 'unresolved', reason: 'capture_rejected_entries', detail: scan.rejected };
      else if (ev.patch.length > MAX_PATCH_BYTES) ev.verdict = { state: 'unresolved', reason: 'patch_too_large' };
      else ev.verdict = { state: ev.candidateTree === ev.baseTree ? 'no_change' : 'captured' };
      return ev;
    },

    /** Re-apply the captured patch to the base inside the tools image; must reproduce the candidate tree. */
    async fidelityCheck() {
      const r = await D.op(['run', '--rm', ...hardened(runId, 'check'), '--network', 'none',
        ...mounts(['git', 'out'], ['out']), image, '/usr/local/lib/qb/apply-check.sh'], { timeoutMs: 120_000 });
      return { ok: r.ok, output: r.stdout.trim() || r.stderr.trim() };
    },

    remove: () => D.removeRun(runId),
  };
  return ws;
}

module.exports = { createWorkspace, ensureToolsImage, hardened, TOOLS_IMAGE, MAX_PATCH_BYTES };
