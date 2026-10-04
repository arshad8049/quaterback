const assert = require('assert');
const double = require('../src/double');
assert.strictEqual(double(2), 4);
assert.strictEqual(double('3'), 6);
assert.strictEqual(double('x'), null);
console.log('fixture tests passed');
