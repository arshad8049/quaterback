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

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');
const TOOLS_IMAGE = process.env.QB_SANDBOX_TOOLS_IMAGE || D.contentTag('qb-sandbox-tools', SANDBOX_DIR,
  ['Dockerfile.tools', 'qb-scan/Cargo.toml', 'qb-scan/Cargo.lock', 'qb-scan/src', 'scripts']);
// Every per-run tmpfs volume exists from the start so the keeper holds it (E2).
const VOLUMES = ['work', 'git', 'verify', 'out', 'deps', 'scratch', 'cred'];
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

/**
 * The host user's uid:gid, for the one container that reads the user's checkout
 * (seed ①a): on Linux, uid 10001 cannot enter a 0700/0750 home directory, and
 * the reader should see exactly what the user can. 10001 where there is none.
 */
const HOST_USER = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '10001:10001';

/** Hardening shared by every container (§3). Stage-specific flags are added by callers. */
function hardened(runId, role, { user = '10001:10001' } = {}) {
  return ['--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--init', '--pids-limit', '256',
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
    ...D.runLabels(runId, role)];
}

/** Build the trusted tools image if it is not present. Returns its image id. */
function ensureToolsImage() {
  return D.ensureImage(TOOLS_IMAGE, ['-f', path.join(SANDBOX_DIR, 'Dockerfile.tools'), SANDBOX_DIR], 'tools');
}

/** Read named files from a (stopped) container path via `docker cp`, size-capped. */
async function readFromContainer(container, dir, maxBytes) {
  const r = await D.op(['cp', `${container}:${dir}/.`, '-'], { raw: true, maxBytes, timeoutMs: 120_000 });
  if (!r.ok) throw Object.assign(new Error(`docker cp failed: ${r.stderr.trim().slice(0, 300)}`), { code: 'CP_FAILED' });
  if (!r.stdout_buffer) throw Object.assign(new Error('output exceeds the size cap'), { code: 'TOO_LARGE' });
  return readTar(r.stdout_buffer);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** git's object id for blob content, in the repository's hash (sha1: 40 hex, sha256: 64). */
const gitBlobId = (buf, like) => crypto.createHash(like && like.length === 64 ? 'sha256' : 'sha1')
  .update(`blob ${buf.length}\0`).update(buf).digest('hex');
const SNAPSHOT_MAX_FILES = 8;

/** A plain repository-relative path without control characters (QB-22 snapshot requests). */
function supportedPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(p)
    && !p.startsWith('/') && !p.endsWith('/') && !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * The export must answer exactly the paths sent, in order: one file or skip per
 * path, nothing else. Each file's content must hash to its git object id.
 * Never accepts a different file in place of a requested one.
 */
function validateSnapshotIndex(sent, indexText, files) {
  const lines = indexText.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  if (lines[0]?.type !== 'tree' || !/^[0-9a-f]{40,64}$/.test(lines[0].tree || '') || lines.at(-1)?.type !== 'end') {
    return { ok: false, error: 'snapshot index incomplete' };
  }
  const entries = lines.slice(1, -1);
  if (entries.length !== sent.length) return { ok: false, error: 'snapshot entries do not match the requested paths' };
  const out = { ok: true, tree: lines[0].tree, files: [], skipped: [] };
  for (const [i, e] of entries.entries()) {
    if (!e || e.path !== sent[i]) return { ok: false, error: `snapshot entry ${i} does not answer the requested path` };
    if (e.type === 'skip' && typeof e.reason === 'string') { out.skipped.push({ path: e.path, reason: e.reason }); continue; }
    if (e.type !== 'file') return { ok: false, error: `snapshot entry ${i} has an unknown type` };
    const buf = files.get(e.file);
    if (!buf || buf.length !== e.size || gitBlobId(buf, e.oid) !== e.oid) return { ok: false, error: `snapshot integrity check failed for entry ${i}` };
    out.files.push({ path: e.path, oid: e.oid, size: e.size, text: buf.toString('utf8') });
  }
  return out;
}
const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** `git diff --numstat -z` → { path: { additions, deletions, binary } }. */
function parseNumstat(z) {
  const out = {};
  for (const rec of z.split('\0').filter(Boolean)) {
    const [a, d, ...rest] = rec.split('\t');
    out[rest.join('\t')] = { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), binary: a === '-' };
  }
  return out;
}

async function createWorkspace(runId, { caps = DEFAULT_CAPS } = {}) {
  const sizes = { work: caps.work, git: caps.git, verify: caps.verify, out: caps.out, deps: caps.deps, scratch: caps.scratch, cred: caps.cred };
  const inodes = { work: 200_000, git: 200_000, verify: 200_000, out: 1000, deps: 500_000, scratch: 200_000, cred: 100 };
  const image = await ensureToolsImage();
  for (const v of VOLUMES) {
    const r = await D.op(['volume', 'create', '--driver', 'local', ...D.runLabels(runId),
      '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
      // scratch is also seed ①a's intake, written as the host user (HOST_USER) and emptied by ①b.
      '--opt', `o=size=${Math.floor(sizes[v])},nr_inodes=${inodes[v]},uid=10001,gid=10001,mode=${v === 'scratch' ? '0777' : '0700'}`, `${runId}-${v}`]);
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

    /**
     * ① checkout → trusted refs/qb/base → /work. Returns { stage, report, baseTree, userHead }.
     * ①a reads the checkout as the host user into /scratch; ①b (uid 10001) builds the
     * trusted repo and /work from that intake and never sees the checkout.
     */
    async seed(checkoutPath, { memoryBytes, scanLimits } = {}) {
      const mem = memoryBytes ? ['--memory', String(memoryBytes), '--memory-swap', String(memoryBytes)] : [];
      const read = await D.runStage(`${runId}-seed-read`, [...hardened(runId, 'seed', { user: HOST_USER }), '--network', 'none', ...mem,
        ...(scanLimits ? ['-e', `QB_SCAN_LIMITS=${scanLimits}`] : []),
        '-v', `${path.resolve(checkoutPath)}:/checkout:ro`, ...mounts(['scratch']),
        image, '/usr/local/lib/qb/seed-read.sh'], { waitTimeoutMs: 30 * 60_000 });
      if (read.state !== 'completed') return { stage: read };
      const name = `${runId}-seed`;
      const stage = await D.runStage(name, [...hardened(runId, 'seed'), '--network', 'none', ...mem,
        ...mounts(['scratch', 'git', 'work']), image, '/usr/local/lib/qb/seed.sh'], { waitTimeoutMs: 30 * 60_000 });
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
        numstat: parseNumstat(String(files.get('numstat.z') || '')),
        baseListing: files.get('base-ls.z') || Buffer.alloc(0),
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

    /**
     * QB-22: the requested files exactly as in refs/qb/candidate — the tree stage ⑤
     * tested — exported by trusted code (snapshot.sh), never read from the live
     * checkout. Each file's content must hash to its git object id.
     * Returns { stage, tree, files: [{ path, oid, size, text }], skipped: [{ path, reason }] }
     * or { stage, error }.
     */
    async snapshot(paths) {
      // Only plain repository-relative paths without control characters are sent;
      // anything else is an explicit unsupported_path (never split, never guessed).
      const requested = [...new Set(paths)].slice(0, SNAPSHOT_MAX_FILES);
      const sent = requested.filter(supportedPath);
      const unsupported = requested.filter((p) => !supportedPath(p)).map((p) => ({ path: String(p), reason: 'unsupported_path' }));
      if (!sent.length) return { stage: null, tree: null, files: [], skipped: unsupported, error: 'no_supported_paths' };
      const name = `${runId}-snapshot`;
      const stage = await D.runStage(name, [...hardened(runId, 'snapshot'), '--network', 'none',
        '-e', `QB_SNAPSHOT_MAX_FILES=${SNAPSHOT_MAX_FILES}`, '-e', `QB_SNAPSHOT_MAX_BYTES=${SNAPSHOT_MAX_BYTES}`,
        ...mounts(['git', 'out'], ['git']), image, '/usr/local/lib/qb/snapshot.sh'],
      { input: Buffer.from(sent.map((p) => `${p}\0`).join('')), waitTimeoutMs: 120_000 });
      if (stage.state !== 'completed') return { stage, error: `snapshot ${stage.state}: ${stage.reason}` };
      let files;
      try { files = await readFromContainer(name, '/out/snapshot', SNAPSHOT_MAX_FILES * SNAPSHOT_MAX_BYTES + 256 * 1024); }
      catch (e) { return { stage, error: e.message }; }
      const v = validateSnapshotIndex(sent, String(files.get('index.ndjson') || ''), files);
      if (!v.ok) return { stage, error: v.error };
      return { stage, tree: v.tree, files: v.files, skipped: [...unsupported, ...v.skipped] };
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

module.exports = { createWorkspace, validateSnapshotIndex, supportedPath, ensureToolsImage, hardened, TOOLS_IMAGE, MAX_PATCH_BYTES };
