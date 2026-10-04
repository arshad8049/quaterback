/**
 * QB-02 step 1 — sandbox foundation.
 *
 *   - Stage classification follows §8.4 precedence and never trusts the exit
 *     code alone (E2: OOMKilled=true with ExitCode=0).
 *   - runBounded drains both streams while the child runs, so a child writing
 *     far more than a pipe holds never blocks, and evidence stays bounded (§8.5).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyStage } = require('../../lib/sandbox/states');
const { runBounded, BoundedBuffer } = require('../../lib/proc');

const exited = (extra = {}) => ({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false, ...extra });

describe('classifyStage precedence (§8.4)', () => {
  const cases = [
    ['clean exit',                     exited(),                                 {},                       'completed'],
    ['nonzero exit',                   exited({ ExitCode: 2 }),                  {},                       'execution_error'],
    ['OOMKilled with nonzero exit',    exited({ ExitCode: 137, OOMKilled: true }), {},                     'oom'],
    ['OOMKilled with exit 0 (E2)',     exited({ ExitCode: 0, OOMKilled: true }), {},                       'oom'],
    ['deadline kill beats OOM',        exited({ ExitCode: 137, OOMKilled: true }), { killedBy: 'deadline' }, 'timeout'],
    ['cancel beats OOM and exit',      exited({ ExitCode: 137, OOMKilled: true }), { killedBy: 'cancel' },   'cancelled'],
    ['deadline beats cancel',          exited({ ExitCode: 137 }),                { killedBy: 'deadline' }, 'timeout'],
    ['infra error beats everything',   exited({ ExitCode: 0 }),                  { infraError: 'daemon restarted', killedBy: 'deadline' }, 'infra_error'],
    ['no state is infra_error',        null,                                     {},                       'infra_error'],
    ['still running is infra_error',   { Status: 'running', Running: true, ExitCode: 0 }, {},             'infra_error'],
  ];
  for (const [name, state, ctx, want] of cases) {
    test(name, () => assert.equal(classifyStage(state, ctx).state, want));
  }

  test('oom reports the exit-0 case explicitly', () => {
    const r = classifyStage(exited({ ExitCode: 0, OOMKilled: true }));
    assert.equal(r.oom_killed, true);
    assert.equal(r.exit_code, 0);
    assert.match(r.reason, /exited 0/);
  });
});

describe('BoundedBuffer', () => {
  test('keeps everything under the limit', () => {
    const b = new BoundedBuffer(100);
    b.push(Buffer.from('hello '));
    b.push(Buffer.from('world'));
    assert.equal(b.toString(), 'hello world');
    assert.equal(b.droppedBytes, 0);
  });

  test('keeps head and tail, reports the dropped middle', () => {
    const b = new BoundedBuffer(10);
    b.push(Buffer.from('AAAAA'));
    b.push(Buffer.from('x'.repeat(1000)));
    b.push(Buffer.from('ZZZZZ'));
    assert.equal(b.droppedBytes, 1000);
    assert.match(b.toString(), /^AAAAA\n\[\.\.\. 1000 bytes dropped \.\.\.\]\nZZZZZ$/);
  });
});

describe('runBounded', () => {
  test('a child flooding both streams (20 MiB each) finishes without blocking; output is bounded', async () => {
    const flood = `
      const chunk = Buffer.alloc(1024 * 1024, 120);
      process.stdout.write('OUT-START\\n'); process.stderr.write('ERR-START\\n');
      for (let i = 0; i < 20; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }
      process.stdout.write('\\nOUT-END'); process.stderr.write('\\nERR-END');`;
    const r = await runBounded(process.execPath, ['-e', flood], { timeoutMs: 60_000, maxBytes: 4096 });
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('OUT-START') && r.stdout.endsWith('OUT-END'));
    assert.ok(r.stderr.startsWith('ERR-START') && r.stderr.endsWith('ERR-END'));
    assert.ok(r.stdout_dropped > 20 * 1024 * 1024 - 8192);
    assert.ok(r.stdout.length < 8192 + 100);
  });

  test('timeout kills the child and is reported', async () => {
    const r = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGKILL');
  });

  test('stdin is delivered and argv is never shell-interpreted', async () => {
    const r = await runBounded(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)', '$(touch /tmp/qb-pwned)'],
      { input: 'piped-in', timeoutMs: 10_000 });
    assert.equal(r.stdout, 'piped-in');
  });

  test('a missing executable is an error, not a hang', async () => {
    const r = await runBounded('/nonexistent/qb-binary', [], { timeoutMs: 5000 });
    assert.ok(r.error);
    assert.equal(r.error.code, 'ENOENT');
  });
});
