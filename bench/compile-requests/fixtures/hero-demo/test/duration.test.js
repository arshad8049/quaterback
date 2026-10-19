'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration } = require('../src/duration');

test('minutes and seconds', () => {
  assert.equal(formatDuration(90000), '1m 30s');
});
