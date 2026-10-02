const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createLogger } = require('../src/logger');

test('info logs at info level', () => {
  const msgs = [];
  const logger = createLogger({ level: 'info', timestamps: false, output: m => msgs.push(m) });
  logger.info('hello');
  assert.ok(msgs.length === 1);
  assert.ok(msgs[0].includes('hello'));
});

test('debug is suppressed at info level', () => {
  const msgs = [];
  const logger = createLogger({ level: 'info', timestamps: false, output: m => msgs.push(m) });
  logger.debug('hidden');
  assert.equal(msgs.length, 0);
});

test('setLevel changes minimum level', () => {
  const msgs = [];
  const logger = createLogger({ level: 'warn', timestamps: false, output: m => msgs.push(m) });
  logger.setLevel('debug');
  logger.debug('now visible');
  assert.equal(msgs.length, 1);
});

test('warn logs at warn level', () => {
  const msgs = [];
  const logger = createLogger({ level: 'warn', timestamps: false, output: m => msgs.push(m) });
  logger.warn('careful');
  assert.ok(msgs[0].includes('WARN'));
});

test('error always logs', () => {
  const msgs = [];
  const logger = createLogger({ level: 'error', timestamps: false, output: m => msgs.push(m) });
  logger.error('boom');
  assert.equal(msgs.length, 1);
});

test('setLevel throws for unknown level', () => {
  const logger = createLogger();
  assert.throws(() => logger.setLevel('trace'), /Unknown level/);
});

// S-007 oracle tests
test('getLevel returns current log level', () => {
  const logger = createLogger({ level: 'warn' });
  assert.equal(logger.getLevel(), 'warn');
});
test('getLevel reflects setLevel changes', () => {
  const logger = createLogger({ level: 'info' });
  logger.setLevel('debug');
  assert.equal(logger.getLevel(), 'debug');
});
test('getLevel returns default level', () => {
  const logger = createLogger();
  assert.equal(logger.getLevel(), 'info');
});
