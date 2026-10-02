/**
 * QB-02 step 3 — the host reads capture output only as a strictly parsed tar
 * (§8.5): regular files and directories, no links or extensions, no escaping
 * paths, no truncation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readTar } = require('../../lib/sandbox/tar');

function entry(name, body, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257); h.write('00', 263);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  Buffer.from(body).copy(pad);
  return Buffer.concat([h, pad]);
}
const end = Buffer.alloc(1024);

test('reads regular files and skips directories', () => {
  const t = Buffer.concat([entry('./', '', '5'), entry('./patch.bin', 'diff\0bytes'), entry('./scan.json', '{}'), end]);
  const files = readTar(t);
  assert.deepEqual([...files.keys()], ['patch.bin', 'scan.json']);
  assert.equal(files.get('patch.bin').toString('latin1'), 'diff\0bytes');
});

for (const [name, type] of [['symlink', '2'], ['hardlink', '1'], ['pax header', 'x'], ['gnu longname', 'L'], ['fifo', '6']]) {
  test(`rejects a ${name} entry`, () => assert.throws(() => readTar(Buffer.concat([entry('x', '', type), end])), /unsupported entry type/));
}

test('rejects escaping paths', () => {
  assert.throws(() => readTar(Buffer.concat([entry('../evil', 'x'), end])), /unsafe path/);
  assert.throws(() => readTar(Buffer.concat([entry('/etc/passwd', 'x'), end])), /unsafe path/);
});

test('rejects truncated entries', () => {
  const t = entry('patch.bin', 'x'.repeat(2000)).subarray(0, 900);
  assert.throws(() => readTar(t), /truncated/);
});
