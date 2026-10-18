/**
 * KAN-76: a `run:` step without `shell:` runs as `bash -e {0}`, which has no pipefail, so
 * `node <check> | tee log` takes tee's status and passes even when the check fails.
 * Every run block that pipes a node command into tee must `set -o pipefail` first.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

/** The `run:` blocks of a workflow file: single-line values and indented `|` blocks. */
function runBlocks(text) {
  const lines = text.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') { out.push({ line: i + 1, body: m[2] }); continue; }
    const indent = m[1].length; const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j]);
    }
    out.push({ line: i + 1, body: body.join('\n') });
  }
  return out;
}

test('every run block that pipes a node command into tee sets pipefail first', () => {
  const bad = [];
  for (const f of fs.readdirSync(DIR).filter((x) => /\.ya?ml$/.test(x))) {
    for (const b of runBlocks(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
      const pipe = b.body.search(/(^|[;&\n]\s*)node [^\n|]*\|\s*tee\b/m);
      if (pipe < 0) continue;
      const pf = b.body.search(/set -o pipefail/);
      if (pf < 0 || pf > pipe) bad.push(`${f}:${b.line}`);
    }
  }
  assert.deepEqual(bad, [], 'steps whose check failure tee would hide');
});

test('the scanner finds the run blocks it is meant to check', () => {
  const blocks = runBlocks(fs.readFileSync(path.join(DIR, 'qb30-reproduce.yml'), 'utf8'));
  assert.ok(blocks.some((b) => /qb30-reproduce-check\.js/.test(b.body)), 'the compare step is seen');
  assert.ok(blocks.some((b) => /repos\.js build all/.test(b.body)), 'the build step is seen');
});
