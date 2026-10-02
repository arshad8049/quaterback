/**
 * lib/sandbox/states.js — decide a sandbox stage's terminal state.
 *
 * Decided from `docker inspect` State plus what the control plane did to the
 * container, in a fixed precedence (agent-sandbox.md §8.4). Never from the exit
 * code alone: E2 observed OOMKilled=true with ExitCode=0, when an OOM-killed
 * child's parent exited cleanly.
 */

const STAGE_STATES = ['infra_error', 'timeout', 'cancelled', 'oom', 'execution_error', 'completed'];

/**
 * @param {object|null} state - parsed `docker inspect` .State (null if unavailable)
 * @param {object} ctx - { infraError?: string, killedBy?: 'deadline'|'cancel'|null }
 * @returns {{ state: string, reason: string, exit_code: number|null, oom_killed: boolean }}
 */
function classifyStage(state, ctx = {}) {
  const exit_code = state && Number.isInteger(state.ExitCode) ? state.ExitCode : null;
  const oom_killed = Boolean(state && state.OOMKilled);
  const out = (s, reason) => ({ state: s, reason, exit_code, oom_killed });

  if (ctx.infraError) return out('infra_error', ctx.infraError);
  if (!state) return out('infra_error', 'container state unavailable');
  if (state.Running || state.Status !== 'exited') return out('infra_error', `container not exited (status ${state.Status})`);
  if (ctx.killedBy === 'deadline') return out('timeout', 'stage deadline');
  if (ctx.killedBy === 'cancel') return out('cancelled', 'cancelled by user');
  if (oom_killed) return out('oom', exit_code === 0 ? 'OOMKilled (main process exited 0)' : 'OOMKilled');
  if (exit_code !== 0) return out('execution_error', `exit ${exit_code}`);
  return out('completed', 'exit 0');
}

module.exports = { classifyStage, STAGE_STATES };
