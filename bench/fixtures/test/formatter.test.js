const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { formatDuration, formatNumber, truncate, padLeft, padRight, formatDate } = require('../src/formatter');

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
