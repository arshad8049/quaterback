/**
 * lib/run-options.js — validate qb run options BEFORE any model call (QB-31).
 *
 * Every problem is reported at once; the caller exits 2 without starting a run record, a
 * model call or an agent. Pre-QB-31, an unsupported --agent reached the intent model, and
 * --max-retries 'abc' / '0' silently became 3 while --deadline 'abc' was silently ignored.
 */

const fs = require('fs');
const path = require('path');
const { adapterProblem } = require('../agent/adapters');
const { git } = require('./proc');

const MAX_RETRIES_LIMIT = 10;

/** @returns {{ errors: string[], maxRetries: number, deadlineMs: number, repoPath: string }} */
function validateRunOptions(opts, request) {
  const errors = [];
  if (typeof request !== 'string' || !request.trim()) errors.push('the request is empty');

  const agentProblem = adapterProblem(opts.agent);
  if (agentProblem) errors.push(`--agent: ${agentProblem}`);

  const r = String(opts.maxRetries ?? '3').trim();
  const maxRetries = /^\d+$/.test(r) ? Number(r) : NaN;
  if (!(maxRetries >= 1 && maxRetries <= MAX_RETRIES_LIMIT)) errors.push(`--max-retries must be a whole number from 1 to ${MAX_RETRIES_LIMIT} (got "${r}")`);

  let deadlineMs = 0;
  if (opts.deadline !== undefined) {
    const d = String(opts.deadline).trim();
    const minutes = /^\d+(\.\d+)?$/.test(d) ? Number(d) : NaN;
    if (!(minutes > 0)) errors.push(`--deadline must be a positive number of minutes (got "${d}")`);
    else deadlineMs = Math.round(minutes * 60_000);
  }

  const repoPath = path.resolve(opts.repo || process.cwd());
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) errors.push(`--repo ${repoPath} does not exist or is not a directory`);
  else if (opts.agent === 'claude-code') {
    // The sandbox seeds from the checkout and captures the change as git trees (QB-02);
    // dry-run and manual work in any directory, as before.
    const inside = git(['rev-parse', '--is-inside-work-tree'], repoPath, { allowFail: true });
    if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') errors.push(`--repo ${repoPath} is not a git work tree; --agent claude-code needs one (run \`git init\` and commit first)`);
  }

  if (opts.contractFile !== undefined && !fs.existsSync(path.resolve(opts.contractFile))) errors.push(`--contract-file ${path.resolve(opts.contractFile)} does not exist`);
  if (opts.telemetry && !opts.telemetryDryRun && !(opts.telemetryToken || process.env.QB_TELEMETRY_TOKEN)) {
    errors.push('--telemetry needs a telemetry token (--telemetry-token or QB_TELEMETRY_TOKEN; request one at /api/telemetry/request)');
  }
  return { errors, maxRetries: errors.length ? NaN : maxRetries, deadlineMs, repoPath };
}

module.exports = { validateRunOptions, MAX_RETRIES_LIMIT };
