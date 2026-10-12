/**
 * agent/adapters.js — the agent adapter registry (QB-31), interface `qb-agent-adapter/1`.
 *
 * An adapter is how Layer 3 hands an approved contract's briefing to a coding agent and gets
 * back an ExecutionResult (agent/schema.js). Interface v1 (agent/runner.js runAgent):
 *   input   the approved contract, the context package, the repository path, run options
 *   output  an ExecutionResult: status (EXECUTION_STATUSES), changes, diff and the captured
 *           trees, produced by trusted code — never the agent's own account of what it did
 *   rules   only a finalized, human-approved contract reaches an agent (QB-08, QB-13); an agent
 *           that edits code runs only in the QB sandbox (QB-02), never on the host
 * A change to that contract is a new interface version, and the registry says which adapters
 * implement which version.
 *
 * `support` is what we commit to: `supported` (validated, maintained), `builtin` (no agent:
 * a briefing only, or a human runs their own agent). Agents named in product framing but not
 * implemented are listed as PLANNED so the CLI can say "not supported yet" instead of failing
 * somewhere inside the pipeline.
 */

const ADAPTER_INTERFACE = 'qb-agent-adapter/1';

const ADAPTERS = {
  'claude-code': {
    interface: ADAPTER_INTERFACE, support: 'supported',
    description: 'Claude Code CLI, run in the QB sandbox (Docker); patch handed back with `qb patch`',
    isolation: 'sandbox', requires: ['docker', 'claude-auth'],
  },
  manual: {
    interface: ADAPTER_INTERFACE, support: 'builtin',
    description: 'prints the briefing; you run your own agent, then QB verifies the working tree',
    isolation: 'none', requires: [],
  },
  'dry-run': {
    interface: ADAPTER_INTERFACE, support: 'builtin',
    description: 'no agent: compiles the contract and briefing only (nothing is changed or verified as done)',
    isolation: 'none', requires: [],
  },
};

const PLANNED = ['codex', 'cursor', 'gemini'];
const AGENT_IDS = Object.keys(ADAPTERS).sort();

/** null when `id` names a registered adapter; otherwise the reason it can't be used. */
function adapterProblem(id) {
  if (Object.prototype.hasOwnProperty.call(ADAPTERS, id)) return null;
  const supported = `supported: ${AGENT_IDS.join(', ')}`;
  const key = String(id).toLowerCase();
  if (PLANNED.includes(key)) return `"${id}" is not supported yet (planned; ${supported})`;
  return `unknown agent "${id}" (${supported})`;
}

module.exports = { ADAPTER_INTERFACE, ADAPTERS, AGENT_IDS, PLANNED, adapterProblem };
