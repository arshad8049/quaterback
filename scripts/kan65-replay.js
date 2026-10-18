#!/usr/bin/env node
/**
 * KAN-65 replay: QB's production E pipeline (lib/qb-pipeline.js: L2 context → L3 → L4 verify →
 * QB-10 routing → retry) on a frozen screen task, with the agent replaced by a FIXED patch that a
 * trusted stage applies inside the real sandbox (lib/sandbox/pipeline.js applyPatch, network none,
 * no credentials). No model is called for the agent; L2 runs without the LLM (as every screen E
 * trial effectively did: its model call timed out). Everything after the agent stage is the real
 * producer: capture, the repository's own tests on the candidate and on the base, classification,
 * verdict, repair hints and routing. A correct patch that is retried is retried for QB's reasons
 * alone, because the replay agent always returns the same patch.
 *
 *   node scripts/kan65-replay.js <ID> <base|reference|incorrect:<label>> [--set screen|dev-r2] [--out <dir>] [--max-retries 3]
 *
 * KAN-75: `--set dev-r2` replays the frozen dev-r2 tasks (screen stays the default).
 *
 * Writes <out>/<ID>-<kind>.json: the prompt and approved contract, the pinned images, and per
 * attempt the candidate/tested trees, patch hash, test argv, candidate and base state/exit/duration,
 * the full machine-readable reports and bounded output, the classified test outcome, checks,
 * criteria, policy, repair hints and the routing decision. Prints one summary line.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { runPipeline } = require('../lib/qb-pipeline');
const { runSandboxed } = require('../lib/sandbox/pipeline');
const { oracleContract } = require('../bench/arms');
const { patchFromTree, curateDirs } = require('../bench/curate');
const { resolveSource } = require('../bench/repos');
const { createWorkspace } = require('../lib/workspace');
const { classifyTestRun } = require('../verify/tests');
const runStore = require('../run/store');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tail = (s, n = 8000) => (typeof s === 'string' ? s.slice(-n) : s ?? null);

function imageIds() {
  const refs = {
    agent: require('../lib/sandbox/agent').AGENT_IMAGE,
  };
  const out = {};
  for (const [k, ref] of Object.entries(refs)) {
    let id = null;
    try { id = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { encoding: 'utf8' }).trim(); } catch { /* not built */ }
    out[k] = { ref, id };
  }
  return out;
}

/** Where a set's frozen specs and curation are (KAN-75). */
function setPaths(set = 'screen') {
  if (!['screen', 'dev-r2'].includes(set)) throw new Error(`replay set must be screen or dev-r2, not ${JSON.stringify(set)}`);
  const d = curateDirs(set);
  return { specs: d.specs, curation: d.curation };
}

function patchFor(spec, kind, curation) {
  if (kind === 'base') return '';
  const tree = kind === 'reference' ? path.join(curation, 'reference')
    : kind.startsWith('incorrect:') ? path.join(curation, 'incorrect', kind.slice('incorrect:'.length)) : null;
  if (!tree || !fs.existsSync(tree)) throw new Error(`unknown patch kind ${kind} (have: reference, incorrect:<${fs.readdirSync(path.join(curation, 'incorrect')).join('|')}>)`);
  return patchFromTree(resolveSource(spec.repo.source), spec.repo.base_rev, tree);
}

/** The evidence of one sandbox test run (candidate or base), with the full machine report. */
function runEvidence(r) {
  if (!r) return null;
  return { state: r.state ?? null, exit_code: r.exit_code ?? null, duration_ms: r.duration_ms ?? r.stage?.duration_ms ?? null,
    error: r.error ?? null, report_error: r.report_error ?? null, tree: r.tree ?? null, report: r.report ?? null };
}

async function replay({ id, kind, out, maxRetries = 3, set = 'screen' }) {
  const dirs = setPaths(set);
  const spec = JSON.parse(fs.readFileSync(path.join(dirs.specs, `${id}.json`), 'utf8'));
  const curation = path.join(dirs.curation, id);
  const patch = patchFor(spec, kind, curation);
  const contract = oracleContract(spec);
  const ws = createWorkspace(resolveSource(spec.repo.source), { baseRev: spec.repo.base_rev, label: `kan65-${id}` });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan65-'));
  const run = runStore.createRun({ kind: 'bench-arm', request: spec.prompt, repoPath: ws.dir, baseSha: ws.baseSha, runsDir: path.join(tmp, 'runs') });
  const events = [];
  const event = run.event.bind(run);
  run.event = (type, data) => { events.push({ type, data }); return event(type, data); };

  const attempts = [];
  const replayAgent = (o) => runSandboxed({ ...o, noAgent: true, applyPatch: patch });
  const hooks = {
    executed: (execution, attempt) => {
      const v = execution.sandbox && execution.sandbox.verification;
      attempts[attempt - 1] = { attempt, execution: {
        status: execution.status, error: execution.error ?? null, base_tree: execution.base_tree, candidate_tree: execution.candidate_tree,
        patch_sha256: execution.diff ? sha(execution.diff) : null, changes: execution.changes, unsupported_changes: execution.unsupported_changes,
        verify_prep: v && v.prep ? v.prep : null,
        tests: v ? { test_plan: v.test_plan, status: v.status, reason: v.reason ?? null, tested_tree: v.tree ?? null,
          candidate: runEvidence(v), candidate_output: tail(v.output), base: runEvidence(v.base) } : null,
        checks: execution.sandbox && execution.sandbox.checks ? execution.sandbox.checks : null,
      } };
    },
    verified: (report, attempt) => {
      attempts[attempt - 1].verification = { verdict: report.verdict, failures: report.failures, test_outcome: report.test_outcome,
        outcomes: report.outcomes, criteria_results: report.criteria_results, checks: report.checks ?? null, policy: report.policy,
        scope_violations: report.scope_violations, repair_hints: report.repair_hints };
    },
  };
  let result;
  const t0 = Date.now();
  try {
    result = await runPipeline({ contract, repoPath: ws.dir, agent: 'claude-code', maxRetries, run, baseSha: ws.baseSha, memory: null,
      noLlmContext: true, noLlmVerify: true, runSandboxed: replayAgent, hooks });
  } finally {
    ws.cleanup();
  }
  for (const e of events.filter((x) => x.type === 'attempt.routed')) {
    if (attempts[e.data.attempt - 1]) attempts[e.data.attempt - 1].routed = { action: e.data.action, reason: e.data.reason };
  }
  let qbCommit = null; let dirty = null;
  try { qbCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''; } catch { /* no git */ }
  const doc = { schema: 'qb-kan65-replay/1', set, task_id: id, spec_version: spec.version, patch_kind: kind, patch_sha256: patch ? sha(patch) : null,
    qb: { commit: qbCommit, dirty }, node: process.version, images: imageIds(), repo: spec.repo,
    prompt: spec.prompt, contract, max_retries: maxRetries, elapsed_ms: Date.now() - t0,
    final: { attempts: result.attempt, verdict: result.report ? result.report.verdict : null, blocked: result.blocked ?? null },
    attempts };
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${id}-${kind.replace(':', '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  return { doc, file };
}

/** One line per replay: verdict, attempts, and per attempt the test outcome, reason and route. */
function summary(doc) {
  const per = doc.attempts.map((a) => {
    const t = a.verification && a.verification.test_outcome;
    const reg = t && Number.isInteger(t.regressions_total) ? ` reg=${t.regressions_total} pre=${t.preexisting_total}` : '';
    const first = t && t.regressions && t.regressions[0] ? ` first=${JSON.stringify(`${t.regressions[0].file} › ${t.regressions[0].name}`)}` : '';
    return `a${a.attempt}:${a.execution.status}/${t ? `${t.outcome}(${t.reason})` : '-'}${reg}${first}→${a.verification ? a.verification.verdict : '-'}${a.routed ? `/${a.routed.action}` : ''}`;
  });
  return `${doc.task_id} ${doc.patch_kind}: final ${doc.final.verdict} after ${doc.final.attempts} attempt(s)${doc.final.blocked ? ` BLOCKED ${doc.final.blocked}` : ''} | ${per.join(' | ')}`;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : d; };
  const out = opt('--out', path.join(process.cwd(), 'kan65-replay'));
  const maxRetries = Number(opt('--max-retries', 3));
  const set = opt('--set', 'screen');
  const [id, kind] = a;
  if (!id || !kind) { console.error('usage: kan65-replay.js <ID> <base|reference|incorrect:<label>> [--set screen|dev-r2] [--out dir] [--max-retries n]'); process.exit(2); }
  replay({ id, kind, out, maxRetries, set }).then(({ doc }) => console.log(summary(doc)))
    .catch((e) => { console.error(`${id} ${kind}: ERROR ${e && e.stack || e}`); process.exit(1); });
}

module.exports = { replay, summary, setPaths };
