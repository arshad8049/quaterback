const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createCache } = require('../src/cache');

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
