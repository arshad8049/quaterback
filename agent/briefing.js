/**
 * briefing.js — DSA Stage 1 of Layer 3
 *
 * Takes a TaskContract + ContextPackage and produces a structured markdown
 * Agent Briefing. Pure deterministic function — no LLM, no I/O.
 *
 * The briefing is the key asset Layer 3 produces: instead of pasting a raw
 * request into a coding agent, the agent receives a precise document that
 * includes the full contract, the exact files to touch, symbols with file:line
 * locations, constraints, an acceptance criteria checklist, and test files to
 * run. No ambiguity, no guessing, no scope drift.
 */

function buildBriefing(contract, context, options = {}) {
  const { repairHints = [], attempt = 1 } = options;
  const lines = [];

  const ts = new Date().toISOString().split('T')[0];
  const attemptLabel = attempt > 1 ? ` — Repair attempt ${attempt}` : '';
  lines.push(`# Agent Briefing${attemptLabel}`);
  lines.push(`**Contract:** \`${contract.id}\`  |  **Date:** ${ts}`);
  if (context) {
    lines.push(`**Context package:** \`${context.id}\``);
  }
  lines.push('');

  // ── Repair section (only on retry attempts) ─────────────────────────────────
  if (repairHints.length > 0) {
    lines.push(`## ⚠ Previous attempt failed — fix these before anything else`);
    lines.push('');
    repairHints.forEach(h => {
      lines.push(`### [${h.criterion_id}] ${h.diagnosis}`);
      lines.push(`**What to do:** ${h.suggested_fix}`);
      lines.push('');
    });
  }

  // ── Goal ────────────────────────────────────────────────────────────────────
  lines.push(`## Goal`);
  lines.push(contract.goal || contract.raw_request);
  lines.push('');

  // ── Required behavior ───────────────────────────────────────────────────────
  if (contract.required_behavior?.length) {
    lines.push(`## Required behavior`);
    contract.required_behavior.forEach((b, i) => {
      lines.push(`${i + 1}. ${b}`);
    });
    lines.push('');
  }

  // ── Constraints ─────────────────────────────────────────────────────────────
  if (contract.constraints?.length) {
    lines.push(`## Constraints — do NOT violate these`);
    contract.constraints.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  // ── Acceptance criteria ─────────────────────────────────────────────────────
  if (contract.acceptance_criteria?.length) {
    lines.push(`## Acceptance criteria`);
    lines.push(`You are done when **all** of these are verifiably true:`);
    lines.push('');
    contract.acceptance_criteria.forEach(ac => {
      lines.push(`- [ ] **[${ac.id}]** ${ac.criterion}`);
    });
    lines.push('');
  }

  // ── Codebase intelligence (from Layer 2) ────────────────────────────────────
  if (context) {

    // Patterns
    const p = context.patterns || {};
    if (p.language || p.framework || p.test_runner || p.architecture) {
      lines.push(`## Codebase patterns`);
      if (p.language)     lines.push(`- Language: **${p.language}**`);
      if (p.framework)    lines.push(`- Framework: **${p.framework}**`);
      if (p.test_runner)  lines.push(`- Test runner: **${p.test_runner}**`);
      if (p.architecture) lines.push(`- Architecture: **${p.architecture}**`);
      lines.push('');
    }

    // Relevant files
    if (context.relevant_files?.length) {
      lines.push(`## Files to work in`);
      lines.push('');
      context.relevant_files.forEach(f => {
        const syms = f.symbols?.length ? ` — exports: \`${f.symbols.slice(0, 5).join('`, `')}\`` : '';
        lines.push(`### \`${f.path}\`${syms}`);
        lines.push(`${f.reason}`);
        if (f.test_file) lines.push(`Test file: \`${f.test_file}\``);
        if (f.imports?.length) lines.push(`Imports: ${f.imports.map(i => `\`${i}\``).join(', ')}`);
        lines.push('');
      });
    }

    // Symbol map
    const symbolEntries = Object.entries(context.symbol_map || {});
    if (symbolEntries.length) {
      lines.push(`## Symbol map — where things live`);
      lines.push('');
      lines.push('| Symbol | Location |');
      lines.push('|--------|----------|');
      symbolEntries.forEach(([name, loc]) => {
        lines.push(`| \`${name}\` | \`${loc}\` |`);
      });
      lines.push('');
    }

    // Test coverage
    const tc = context.test_coverage || {};
    const testFiles = tc.test_files || [];
    const uncovered = tc.uncovered_files || [];
    if (testFiles.length || uncovered.length) {
      lines.push(`## Test coverage`);
      if (testFiles.length) {
        lines.push(`Run these after your changes:`);
        testFiles.forEach(t => lines.push(`- \`${t}\``));
      }
      if (uncovered.length) {
        lines.push('');
        lines.push(`No existing tests for these files — write tests if you add behavior to them:`);
        uncovered.slice(0, 8).forEach(f => lines.push(`- \`${f}\``));
        if (uncovered.length > 8) lines.push(`  *(+ ${uncovered.length - 8} more)*`);
      }
      lines.push('');
    }

    // Git context
    const recent = context.git_context?.recent_changes || [];
    if (recent.length) {
      lines.push(`## Recent git activity`);
      recent.forEach(c => {
        lines.push(`- \`${c.file}\` — ${c.commits} commit(s), last changed ${c.last_changed}`);
      });
      lines.push('');
    }

    // Agent brief (LLM-produced in Layer 2)
    if (context.agent_brief) {
      lines.push(`## Agent notes`);
      lines.push(context.agent_brief);
      lines.push('');
    }
  }

  // ── Verification plan ───────────────────────────────────────────────────────
  if (contract.verification_plan?.length) {
    lines.push(`## Verification plan`);
    contract.verification_plan.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push(`*Quarterback briefing — Layer 3 Agent Orchestrator*`);

  return lines.join('\n');
}

module.exports = { buildBriefing };
