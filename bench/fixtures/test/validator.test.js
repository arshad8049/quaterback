const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { isObject, isNumber, isString, isArray, isBoolean, validateSchema, isIPv4 } = require('../src/validator');

test('isObject returns true for plain objects', () => {
  assert.ok(isObject({ a: 1 }));
  assert.ok(isObject({}));
});

test('isObject returns false for null, arrays, primitives', () => {
  assert.ok(!isObject(null));
  assert.ok(!isObject([]));
  assert.ok(!isObject('str'));
  assert.ok(!isObject(42));
});

test('isNumber returns true for finite numbers', () => {
  assert.ok(isNumber(0));
  assert.ok(isNumber(3.14));
  assert.ok(!isNumber(NaN));
  assert.ok(!isNumber(Infinity));
  assert.ok(!isNumber('5'));
});

test('isString returns true for strings', () => {
  assert.ok(isString(''));
  assert.ok(isString('hello'));
  assert.ok(!isString(1));
});

test('isArray returns true for arrays', () => {
  assert.ok(isArray([]));
  assert.ok(isArray([1,2,3]));
  assert.ok(!isArray({}));
});

test('isBoolean', () => {
  assert.ok(isBoolean(true));
  assert.ok(isBoolean(false));
  assert.ok(!isBoolean(0));
  assert.ok(!isBoolean('true'));
});

test('validateSchema passes valid data', () => {
  const schema = { name: 'string', age: 'number' };
  const result = validateSchema({ name: 'Alice', age: 30 }, schema);
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

test('validateSchema fails on wrong type', () => {
  const schema = { age: 'number' };
  const result = validateSchema({ age: 'thirty' }, schema);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('age')));
});

test('validateSchema catches missing required field', () => {
  const schema = { name: 'required' };
  const result = validateSchema({}, schema);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('name')));
});

test('isIPv4 validates correct addresses', () => {
  assert.ok(isIPv4('192.168.1.1'));
  assert.ok(isIPv4('0.0.0.0'));
  assert.ok(isIPv4('255.255.255.255'));
});

test('isIPv4 rejects invalid addresses', () => {
  assert.ok(!isIPv4('256.0.0.1'));
  assert.ok(!isIPv4('192.168.1'));
  assert.ok(!isIPv4('not-an-ip'));
  assert.ok(!isIPv4(''));
});
