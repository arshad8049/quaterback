const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { parseJSON, parseQueryString, parseCookies, parseCSVLine } = require('../src/parser');

test('parseJSON parses valid JSON', () => {
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 });
});

test('parseJSON returns fallback on invalid input', () => {
  assert.equal(parseJSON('not json', 42), 42);
  assert.equal(parseJSON('not json'), null);
});

test('parseQueryString parses simple params', () => {
  assert.deepEqual(parseQueryString('a=1&b=2'), { a: '1', b: '2' });
});

test('parseQueryString strips leading ?', () => {
  assert.deepEqual(parseQueryString('?x=hello'), { x: 'hello' });
});

test('parseQueryString handles repeated keys as array', () => {
  const result = parseQueryString('tag=a&tag=b');
  assert.deepEqual(result.tag, ['a', 'b']);
});

test('parseQueryString handles empty string', () => {
  assert.deepEqual(parseQueryString(''), {});
});

test('parseQueryString decodes encoded chars', () => {
  const result = parseQueryString('name=hello%20world');
  assert.equal(result.name, 'hello world');
});

test('parseCookies parses cookie string', () => {
  assert.deepEqual(parseCookies('session=abc; theme=dark'), { session: 'abc', theme: 'dark' });
});

test('parseCookies handles empty string', () => {
  assert.deepEqual(parseCookies(''), {});
});

test('parseCSVLine splits simple line', () => {
  assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
});

test('parseCSVLine handles quoted fields', () => {
  assert.deepEqual(parseCSVLine('"hello, world",b,c'), ['hello, world', 'b', 'c']);
});

test('parseCSVLine handles escaped quotes', () => {
  assert.deepEqual(parseCSVLine('"say ""hi""",b'), ['say "hi"', 'b']);
});

test('parseCSVLine handles empty fields', () => {
  assert.deepEqual(parseCSVLine('a,,c'), ['a', '', 'c']);
});
