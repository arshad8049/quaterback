const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { isObject, isNumber, isString, isArray, isBoolean, validateSchema, isIPv4, isEmail, isURL, validateRequired } = require('../src/validator');

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

// S-005 oracle tests
test('isEmail returns true for valid email', () => {
  assert.ok(isEmail('user@example.com'));
  assert.ok(isEmail('a+b@x.co'));
});
test('isEmail returns false for invalid email', () => {
  assert.ok(!isEmail('notanemail'));
  assert.ok(!isEmail('@example.com'));
  assert.ok(!isEmail('user@'));
  assert.ok(!isEmail(''));
});

// S-013 oracle tests
test('isURL returns true for http URL', () => {
  assert.ok(isURL('http://example.com'));
  assert.ok(isURL('https://example.com/path?q=1'));
});
test('isURL returns false for non-URLs', () => {
  assert.ok(!isURL('example.com'));
  assert.ok(!isURL('ftp://example.com'));
  assert.ok(!isURL(''));
  assert.ok(!isURL(null));
});

// S-014 oracle tests
test('validateRequired returns valid when all fields present', () => {
  const r = validateRequired({ name: 'Alice', age: 30 }, ['name', 'age']);
  assert.ok(r.valid);
  assert.equal(r.missing.length, 0);
});
test('validateRequired returns missing fields', () => {
  const r = validateRequired({ name: '' }, ['name', 'age']);
  assert.ok(!r.valid);
  assert.ok(r.missing.includes('name') || r.missing.includes('age'));
});
test('validateRequired catches undefined fields', () => {
  const r = validateRequired({}, ['a', 'b']);
  assert.ok(!r.valid);
  assert.equal(r.missing.length, 2);
});

// S-020 oracle tests (nested validateSchema)
test('validateSchema validates nested object with sub-schema', () => {
  const schema = { address: { type: 'object', schema: { city: 'string', zip: 'string' } } };
  const result = validateSchema({ address: { city: 'NYC', zip: '10001' } }, schema);
  assert.ok(result.valid);
});
test('validateSchema reports nested errors with dot notation', () => {
  const schema = { address: { type: 'object', schema: { city: 'string' } } };
  const result = validateSchema({ address: { city: 42 } }, schema);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('address.city')));
});
test('validateSchema handles missing nested object', () => {
  const schema = { address: { type: 'object', schema: { city: 'string' } } };
  const result = validateSchema({ address: null }, schema);
  assert.ok(!result.valid);
});
