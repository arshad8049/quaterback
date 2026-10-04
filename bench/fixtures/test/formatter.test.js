const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { formatDuration, formatNumber, truncate, padLeft, padRight, formatDate, capitalize, formatBytes, formatPercent } = require('../src/formatter');

test('formatDuration returns ms for sub-second', () => {
  assert.equal(formatDuration(500), '500ms');
});

test('formatDuration returns seconds', () => {
  assert.equal(formatDuration(5000), '5s');
});

test('formatDuration returns minutes and seconds', () => {
  assert.equal(formatDuration(90000), '1m 30s');
});

test('formatDuration returns hours and minutes', () => {
  assert.equal(formatDuration(7200000), '2h 0m');
});

test('formatDuration handles 0', () => {
  assert.equal(formatDuration(0), '0ms');
});

test('formatNumber formats integers', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
});

test('formatNumber with decimals', () => {
  assert.equal(formatNumber(3.14159, 2), '3.14');
});

test('formatNumber without thousands separator', () => {
  assert.equal(formatNumber(1234567, 0, false), '1234567');
});

test('truncate returns string unchanged if short enough', () => {
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate truncates long strings', () => {
  const result = truncate('hello world', 8);
  assert.ok(result.length <= 8);
  assert.ok(result.endsWith('…'));
});

test('padLeft pads to width', () => {
  assert.equal(padLeft('42', 5), '   42');
});

test('padLeft with custom char', () => {
  assert.equal(padLeft('42', 5, '0'), '00042');
});

test('padRight pads to width', () => {
  assert.equal(padRight('hi', 5), 'hi   ');
});

test('formatDate returns a non-empty string', () => {
  const result = formatDate(new Date('2026-01-15'));
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('formatDate returns Invalid Date for bad input', () => {
  assert.equal(formatDate('not-a-date'), 'Invalid Date');
});

// S-003 oracle tests
test('capitalize uppercases first letter', () => {
  assert.equal(capitalize('hello'), 'Hello');
});
test('capitalize lowercases rest', () => {
  assert.equal(capitalize('hELLO WORLD'), 'Hello world');
});
test('capitalize handles empty string', () => {
  assert.equal(capitalize(''), '');
});

// S-004 oracle tests
test('formatBytes formats bytes', () => {
  assert.equal(formatBytes(0), '0 B');
});
test('formatBytes formats kilobytes', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
});
test('formatBytes formats megabytes', () => {
  assert.equal(formatBytes(1048576), '1.0 MB');
});
test('formatBytes formats gigabytes', () => {
  assert.ok(formatBytes(1073741824).includes('GB'));
});

// S-011 oracle tests
test('formatPercent formats number as percent', () => {
  assert.equal(formatPercent(0.5), '50.0%');
});
test('formatPercent respects decimals param', () => {
  assert.equal(formatPercent(0.1234, 2), '12.34%');
});
test('formatPercent handles 0 and 1', () => {
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(1), '100.0%');
});

// S-017 oracle tests (formatBytes already tested above; getSizeReport tested in cache.test.js)
