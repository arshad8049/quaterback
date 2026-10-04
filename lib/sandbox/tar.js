/**
 * lib/sandbox/tar.js — strict reader for the tar stream `docker cp` produces.
 *
 * Used only on output from QB's own capture container, but parsed as hostile
 * anyway (§8.5): regular files and directories only, plain ustar names, sizes
 * within the buffer, no links, no PAX/GNU extensions. Anything else throws.
 */

const BLOCK = 512;

function field(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len);
}

/** @returns {Map<string, Buffer>} path (relative, no leading ./) → contents, files only */
function readTar(buf) {
  const files = new Map();
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const hdr = buf.subarray(off, off + BLOCK);
    if (hdr.every((b) => b === 0)) break;                      // end-of-archive marker
    const name = field(hdr, 0, 100);
    const prefix = field(hdr, 345, 155);
    const size = parseInt(field(hdr, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size for ${full}`);
    if (full.split('/').some((c) => c === '..') || full.startsWith('/')) throw new Error(`tar: unsafe path ${full}`);
    off += BLOCK;
    if (off + size > buf.length) throw new Error(`tar: truncated entry ${full}`);
    if (type === '0' || type === '\0') files.set(full, Buffer.from(buf.subarray(off, off + size)));
    else if (type !== '5') throw new Error(`tar: unsupported entry type ${JSON.stringify(type)} for ${full}`);
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

module.exports = { readTar };
