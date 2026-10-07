/**
 * bench/plan.js — the trial plan and the holdout gate (QB-30).
 *
 * seededOrder(tasks, arms, repetitions, seed)
 *   Randomized, reproducible execution order. The unit of randomization is the (task,
 *   repetition) block; within a block, every arm of that trial runs back to back (paired)
 *   in its own seeded order, so time-of-day / environment drift cannot line up with an arm.
 *   The seed is recorded in the manifest; the same seed gives the same order.
 *
 * holdoutGate(manifest, { qbRoot })
 *   A holdout task may run only in an OFFICIAL experiment whose manifest carries an approval
 *   record that names the EXACT protocol (sha256 of the protocol document) and the EXACT
 *   holdout spec set (holdoutSetHash: id, version, content hash of every holdout spec) — a
 *   populated approver name is not evidence. The protocol document on disk must still hash to
 *   the approved value (a protocol edited after approval is refused). Holdout-driven fixes
 *   therefore require a new spec version (disclosed in its changelog) and a new approval —
 *   i.e. a new experiment.
 */

const fs = require('fs');
const path = require('path');
const S = require('./schemas');
const { shuffle } = require('./adjudicate');

const QB_ROOT = path.join(__dirname, '..');

function seededOrder(tasks, arms, repetitions, seed) {
  if (!seed || seed === 'none') throw new Error('seededOrder: a seed is required (it is recorded in the manifest)');
  const blocks = [];
  for (const t of tasks) for (let r = 1; r <= repetitions; r++) blocks.push({ task_id: t.id, repetition: r, trial_id: `${t.id}-r${r}` });
  const order = [];
  for (const b of shuffle(blocks, `${seed}\0blocks`)) {
    for (const a of shuffle(arms.map((x) => x.id), `${seed}\0${b.trial_id}`)) order.push({ trial_id: b.trial_id, task_id: b.task_id, repetition: b.repetition, arm: a });
  }
  return order;
}

class HoldoutRefused extends Error {
  constructor(msg) { super(`holdout refused: ${msg}`); this.code = 'HOLDOUT_REFUSED'; }
}

/** Throws HoldoutRefused unless every holdout task in the manifest is covered by a hash-matched approval. */
function holdoutGate(m, { qbRoot = QB_ROOT } = {}) {
  const holdout = m.tasks.filter((t) => t.split === 'holdout');
  if (!holdout.length) return { holdout: false };
  if (m.kind !== 'official') throw new HoldoutRefused('holdout tasks run only in an official experiment');
  if (!m.protocol) throw new HoldoutRefused('no protocol document is pinned in the manifest');
  if (!m.approval) throw new HoldoutRefused('no approval record — the protocol must be independently reviewed before holdout execution');
  if (m.approval.protocol_sha256 !== m.protocol.sha256) throw new HoldoutRefused('the approval names a different protocol version than the manifest pins');
  const set = S.holdoutSetHash(m.tasks);
  if (m.approval.holdout_set_sha256 !== set) throw new HoldoutRefused('the approval names a different holdout spec set (a spec was added, removed or revised after approval)');
  const doc = path.resolve(qbRoot, m.protocol.path);
  let onDisk;
  try { onDisk = S.sha256File(doc); } catch { throw new HoldoutRefused(`protocol document ${m.protocol.path} is missing`); }
  if (onDisk !== m.protocol.sha256) throw new HoldoutRefused(`protocol document ${m.protocol.path} changed after approval`);
  return { holdout: true, approver: m.approval.approver, approved_at: m.approval.approved_at, holdout_set_sha256: set };
}

module.exports = { seededOrder, holdoutGate, HoldoutRefused };
