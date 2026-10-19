/**
 * KAN-70: FY-04's reference must be the whole upstream fix (fastify 2ae3e1d7, #6523), not only
 * its lib/ and error-count changes. The new error code FST_ERR_ROUTE_LOG_LEVEL_INVALID has to be
 * in docs/Reference/Errors.md (TOC and table) and in types/errors.d.ts, or three of Fastify's own
 * consistency tests in test/internals/errors.test.js fail on the reference tree.
 *
 * These checks mirror those Fastify tests on the reference files, offline. The reference trees
 * hold whole files, so a file the reference does not carry is the base's, which lacks the code.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'bench', 'screen', 'curation', 'FY-04');
const REF = path.join(DIR, 'reference');
const read = (f) => {
  const p = path.join(REF, f);
  assert.ok(fs.existsSync(p), `the reference does not carry ${f}, so the base's copy (without the new code) is used`);
  return fs.readFileSync(p, 'utf8');
};
/** The Fastify error codes lib/errors.js defines with createError. */
const codes = () => [...read('lib/errors.js').matchAll(/^\s*(FST_ERR_[A-Z0-9_]+): createError\(/gm)].map((m) => m[1]);

describe('KAN-70: the FY-04 reference carries the upstream docs and type updates', () => {
  test('the reference defines the new error code', () => {
    assert.ok(codes().includes('FST_ERR_ROUTE_LOG_LEVEL_INVALID'));
  });

  test('every error code is in the Errors.md TOC and documented in its table', () => {
    const md = read('docs/Reference/Errors.md');
    for (const key of codes()) {
      assert.ok(md.includes(`  - [${key}](#${key.toLowerCase()})`), `${key} missing from the Errors.md TOC`);
      assert.ok(md.includes(`<a id="${key.toLowerCase()}">${key}</a>`), `${key} missing from the Errors.md table`);
    }
  });

  test('every error code is in FastifyErrorCodes in types/errors.d.ts', () => {
    const m = read('types/errors.d.ts').match(/export type FastifyErrorCodes = Record<([^>]+),\s*FastifyErrorConstructor>/m);
    assert.ok(m, 'FastifyErrorCodes type not found');
    const typed = [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
    for (const key of codes()) assert.ok(typed.includes(key), `${key} missing from errors.d.ts`);
  });

  test('task.json discloses the change as a new version, after viewing results', () => {
    const task = JSON.parse(fs.readFileSync(path.join(DIR, 'task.json'), 'utf8'));
    assert.equal(task.version, 3);
    const entry = task.changelog.find((c) => c.version === 3);
    assert.ok(entry, 'no changelog entry for version 3');
    assert.equal(entry.after_viewing_results, true);
    assert.match(entry.reason, /KAN-70/);
  });
});
