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

  // ── Scope (QB-09): enforced — changes outside it cannot pass ─────────────────
  const allowed = contract.scope?.allowed_changes || [];
  const prot = contract.scope?.protected_paths || [];
  if (allowed.length || prot.length) {
    lines.push(`## Scope — enforced`);
    if (allowed.length) lines.push(`You may change only: ${allowed.map(g => `\`${g}\``).join(', ')}. Any other change cannot be accepted.`);
    if (prot.length) lines.push(`Never change: ${prot.map(g => `\`${g}\``).join(', ')}.`);
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
      if (p.test_runner) {
        // QB-20: an unvalidated runner is reported, but never used to verify the change.
        const tp = context.test_plan;
        const unsupported = tp && tp.reason === 'unsupported_runner' && tp.runner === p.test_runner;
        lines.push(`- Test runner: **${p.test_runner}**${unsupported ? ' — not used for verification (QB cannot execute and parse its results yet)' : ''}`);
      }
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
        // QB-18: a changed file whose current content could not be read is never briefed from stale facts.
        if (f.stale) lines.push(`⚠ \`${f.path}\` changed in attempt ${f.stale.attempt ?? '?'}; its current content could not be read — do not rely on earlier context for it.`);
        lines.push(`${f.reason}`);
        if (f.test_file) lines.push(`Associated test (by file name): \`${f.test_file}\``);
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

    // QB-20: test files matched by NAME are associations — a hint, never a claim of coverage.
    const ta = context.test_associations
      || (context.test_coverage && { test_files: context.test_coverage.test_files, without_associated_tests: context.test_coverage.uncovered_files });   // legacy package
    const testFiles = (ta && ta.test_files) || [];
    const without = (ta && ta.without_associated_tests) || [];
    if (testFiles.length || without.length) {
      lines.push(`## Associated tests (matched by file name only)`);
      if (testFiles.length) {
        lines.push(`Test files that may relate to these files — run them after your changes (a matching name does not mean the behavior is tested):`);
        testFiles.forEach(t => lines.push(`- \`${t}\``));
      }
      if (without.length) {
        lines.push('');
        lines.push(`No associated test file was found by name for these files — add tests if you add behavior to them:`);
        without.slice(0, 8).forEach(f => lines.push(`- \`${f}\``));
        if (without.length > 8) lines.push(`  *(+ ${without.length - 8} more)*`);
      }
      lines.push('');
    }

    // Real coverage — only from a report the repository already has.
    const cov = context.coverage;
    if (cov && cov.files && Object.keys(cov.files).length) {
      lines.push(`## Coverage data (from ${cov.path})`);
      for (const [f, c] of Object.entries(cov.files)) {
        const v = c.lines_pct != null ? `${c.lines_pct}% of lines` : c.statements_pct != null ? `${c.statements_pct}% of statements` : 'no measurable lines';
        lines.push(`- \`${f}\`: ${v}`);
      }
      lines.push(`(As of when the report was generated; it may be out of date.)`);
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
