const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createCache } = require('../src/cache');
const { sleep } = require('../src/utils');

test('set and get basic value', () => {
  const c = createCache();
  c.set('key', 'value');
  assert.equal(c.get('key'), 'value');
});

test('get returns undefined for missing key', () => {
  const c = createCache();
  assert.equal(c.get('missing'), undefined);
});

test('has returns true for existing key', () => {
  const c = createCache();
  c.set('x', 1);
  assert.ok(c.has('x'));
});

test('has returns false for missing key', () => {
  const c = createCache();
  assert.ok(!c.has('nope'));
});

test('delete removes a key', () => {
  const c = createCache();
  c.set('k', 'v');
  c.delete('k');
  assert.equal(c.get('k'), undefined);
});

test('clear removes all keys', () => {
  const c = createCache();
  c.set('a', 1);
  c.set('b', 2);
  c.clear();
  assert.equal(c.size(), 0);
});

test('size counts entries', () => {
  const c = createCache();
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.size(), 2);
});

test('TTL: expired entry returns undefined', async () => {
  const c = createCache({ defaultTTL: 20 });
  c.set('k', 'v');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(c.get('k'), undefined);
});

test('TTL: non-expired entry returns value', async () => {
  const c = createCache({ defaultTTL: 200 });
  c.set('k', 'v');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(c.get('k'), 'v');
});

test('maxSize evicts oldest entry', () => {
  const c = createCache({ maxSize: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3); // should evict 'a'
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

// S-008 oracle tests
test('keys returns all non-expired keys', () => {
  const cache = createCache();
  cache.set('a', 1);
  cache.set('b', 2);
  const k = cache.keys();
  assert.ok(Array.isArray(k));
  assert.ok(k.includes('a'));
  assert.ok(k.includes('b'));
});
test('keys excludes expired entries', async () => {
  const cache = createCache({ defaultTTL: 20 });
  cache.set('x', 1);
  await sleep(40);
  assert.ok(!cache.keys().includes('x'));
});

// S-016 oracle tests
test('getStats returns initial zeros', () => {
  const cache = createCache();
  const s = cache.getStats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.size, 0);
});
test('getStats tracks hits and misses', () => {
  const cache = createCache();
  cache.set('k', 'v');
  cache.get('k');   // hit
  cache.get('nope'); // miss
  const s = cache.getStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

// S-017 oracle tests (getSizeReport)
test('getSizeReport returns string with entry count', () => {
  const cache = createCache();
  cache.set('a', 'hello');
  const r = cache.getSizeReport();
  assert.ok(typeof r === 'string');
  assert.ok(r.includes('1'));
});
test('getSizeReport includes size unit', () => {
  const cache = createCache();
  cache.set('a', 'hello');
  const r = cache.getSizeReport();
  assert.ok(r.includes('B') || r.includes('KB') || r.includes('MB'));
});

// S-018 oracle tests (getOrSet)
test('getOrSet stores and returns factory result', async () => {
  const cache = createCache();
  const val = await cache.getOrSet('key', () => 42);
  assert.equal(val, 42);
  assert.equal(cache.get('key'), 42);
});
test('getOrSet returns cached value without calling factory again', async () => {
  const cache = createCache();
  let calls = 0;
  await cache.getOrSet('k', () => { calls++; return 1; });
  await cache.getOrSet('k', () => { calls++; return 2; });
  assert.equal(calls, 1);
});
