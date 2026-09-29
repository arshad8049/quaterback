const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createEmitter } = require('../src/events');

test('on and emit calls listener', () => {
  const e = createEmitter();
  let called = false;
  e.on('event', () => { called = true; });
  e.emit('event');
  assert.ok(called);
});

test('emit passes arguments to listener', () => {
  const e = createEmitter();
  let received;
  e.on('data', (val) => { received = val; });
  e.emit('data', 42);
  assert.equal(received, 42);
});

test('emit returns false when no listeners', () => {
  const e = createEmitter();
  assert.equal(e.emit('nothing'), false);
});

test('emit returns true when listeners exist', () => {
  const e = createEmitter();
  e.on('x', () => {});
  assert.equal(e.emit('x'), true);
});

test('off removes a listener', () => {
  const e = createEmitter();
  let count = 0;
  const fn = () => { count++; };
  e.on('click', fn);
  e.off('click', fn);
  e.emit('click');
  assert.equal(count, 0);
});

test('off returns true if listener was found', () => {
  const e = createEmitter();
  const fn = () => {};
  e.on('x', fn);
  assert.equal(e.off('x', fn), true);
});

test('off returns false if listener not found', () => {
  const e = createEmitter();
  assert.equal(e.off('x', () => {}), false);
});

test('listenerCount returns correct count', () => {
  const e = createEmitter();
  e.on('a', () => {});
  e.on('a', () => {});
  assert.equal(e.listenerCount('a'), 2);
});

test('listenerCount returns 0 for unknown event', () => {
  const e = createEmitter();
  assert.equal(e.listenerCount('nope'), 0);
});

test('multiple listeners all called', () => {
  const e = createEmitter();
  let sum = 0;
  e.on('add', (n) => { sum += n; });
  e.on('add', (n) => { sum += n * 2; });
  e.emit('add', 3);
  assert.equal(sum, 9); // 3 + 6
});

test('on throws for non-function listener', () => {
  const e = createEmitter();
  assert.throws(() => e.on('x', 'not-a-function'), TypeError);
});
