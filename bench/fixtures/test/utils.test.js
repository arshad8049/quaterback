const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { sleep, chunk, pick, omit, deepEqual, uniqueId, flatten, groupBy, clamp, compact, debounce, throttle, memoize } = require('../src/utils');

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

// S-001 oracle tests
test('clamp returns value when in range', () => {
  assert.equal(clamp(5, 1, 10), 5);
});
test('clamp clamps to min', () => {
  assert.equal(clamp(-5, 0, 10), 0);
});
test('clamp clamps to max', () => {
  assert.equal(clamp(15, 0, 10), 10);
});

// S-002 oracle tests
test('compact removes falsy values', () => {
  assert.deepEqual(compact([0, 1, false, 2, '', 3, null, undefined, NaN]), [1, 2, 3]);
});
test('compact returns empty array for all-falsy input', () => {
  assert.deepEqual(compact([false, null, undefined, 0, '']), []);
});
test('compact preserves truthy values', () => {
  assert.deepEqual(compact([1, 'a', {}, []]), [1, 'a', {}, []]);
});

// S-009 oracle tests
test('debounce delays execution', async () => {
  let count = 0;
  const fn = debounce(() => count++, 30);
  fn(); fn(); fn();
  assert.equal(count, 0);
  await sleep(50);
  assert.equal(count, 1);
});
test('debounce resets timer on repeated calls', async () => {
  let count = 0;
  const fn = debounce(() => count++, 30);
  fn();
  await sleep(10);
  fn();
  await sleep(10);
  fn();
  await sleep(50);
  assert.equal(count, 1);
});

// S-010 oracle tests
test('throttle calls fn immediately on first call', async () => {
  let count = 0;
  const fn = throttle(() => count++, 50);
  fn();
  assert.equal(count, 1);
});
test('throttle suppresses calls within window', async () => {
  let count = 0;
  const fn = throttle(() => count++, 50);
  fn(); fn(); fn();
  assert.equal(count, 1);
});
test('throttle allows call after window expires', async () => {
  let count = 0;
  const fn = throttle(() => count++, 30);
  fn();
  await sleep(50);
  fn();
  assert.equal(count, 2);
});

// S-018 oracle tests (memoize)
test('memoize caches function results', () => {
  let calls = 0;
  const fn = memoize((x) => { calls++; return x * 2; });
  assert.equal(fn(5), 10);
  assert.equal(fn(5), 10);
  assert.equal(calls, 1);
});
test('memoize returns different results for different args', () => {
  const fn = memoize((x) => x * 2);
  assert.equal(fn(3), 6);
  assert.equal(fn(4), 8);
});
test('memoize uses keyResolver when provided', () => {
  let calls = 0;
  const fn = memoize((a, b) => { calls++; return a + b; }, (a, b) => `${a}:${b}`);
  fn(1, 2); fn(1, 2);
  assert.equal(calls, 1);
});
