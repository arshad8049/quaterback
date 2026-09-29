const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { sleep, chunk, pick, omit, deepEqual, uniqueId, flatten, groupBy } = require('../src/utils');

test('sleep resolves after delay', async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 18);
});

test('chunk splits array evenly', () => {
  assert.deepEqual(chunk([1,2,3,4,5,6], 2), [[1,2],[3,4],[5,6]]);
});

test('chunk handles remainder', () => {
  assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
});

test('chunk returns [] for empty input', () => {
  assert.deepEqual(chunk([], 3), []);
});

test('pick returns only specified keys', () => {
  assert.deepEqual(pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
});

test('pick ignores missing keys', () => {
  assert.deepEqual(pick({ a: 1 }, ['a', 'z']), { a: 1 });
});

test('omit removes specified keys', () => {
  assert.deepEqual(omit({ a: 1, b: 2, c: 3 }, ['b']), { a: 1, c: 3 });
});

test('deepEqual handles primitives', () => {
  assert.ok(deepEqual(1, 1));
  assert.ok(!deepEqual(1, 2));
  assert.ok(deepEqual('x', 'x'));
});

test('deepEqual handles nested objects', () => {
  assert.ok(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }));
  assert.ok(!deepEqual({ a: { b: 1 } }, { a: { b: 2 } }));
});

test('deepEqual handles arrays', () => {
  assert.ok(deepEqual([1, [2, 3]], [1, [2, 3]]));
  assert.ok(!deepEqual([1, 2], [1, 2, 3]));
});

test('uniqueId returns unique values', () => {
  const a = uniqueId();
  const b = uniqueId();
  assert.notEqual(a, b);
});

test('uniqueId uses prefix', () => {
  assert.ok(uniqueId('test').startsWith('test_'));
});

test('flatten flattens one level', () => {
  assert.deepEqual(flatten([1, [2, 3], [4, [5]]]), [1, 2, 3, 4, [5]]);
});

test('flatten with depth 2', () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]]], 2), [1, 2, 3, [4]]);
});

test('groupBy groups objects by key', () => {
  const data = [{ type: 'a', v: 1 }, { type: 'b', v: 2 }, { type: 'a', v: 3 }];
  const result = groupBy(data, 'type');
  assert.deepEqual(result.a, [{ type: 'a', v: 1 }, { type: 'a', v: 3 }]);
  assert.deepEqual(result.b, [{ type: 'b', v: 2 }]);
});
