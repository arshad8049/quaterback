/**
 * lib/fsafe.js — filesystem paths built from identifiers that may have
 * passed through model output. An identifier is a single path segment of
 * safe characters; anything else is refused before touching the disk (QB-04).
 */

const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * @param {string} rootDir - directory the artifact must live in
 * @param {string} id      - identifier used as the file stem
 * @param {string} [ext]   - extension without the dot
 * @returns {string} absolute file path directly inside rootDir
 */
function artifactFile(rootDir, id, ext = 'json') {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    throw new Error(`Invalid artifact id: ${JSON.stringify(id)}`);
  }
  const root = path.resolve(rootDir);
  const file = path.join(root, `${id}.${ext}`);
  if (path.dirname(file) !== root) throw new Error(`Invalid artifact id: ${JSON.stringify(id)}`);
  return file;
}

module.exports = { artifactFile };
