#!/usr/bin/env node
/**
 * E1: describe a credentials file WITHOUT revealing it.
 *
 * Prints only structure and non-secret metadata: key names, expiry, scopes,
 * subscription type, and short SHA-256 fingerprints of the token fields (enough
 * to tell whether a token changed, impossible to reverse). Never prints a value
 * of any field whose name looks like a token or secret.
 *
 * Usage: credmeta.js <path-to-.credentials.json>
 */
const fs = require('fs');
const crypto = require('crypto');

const fp = (v) => (v == null ? null : crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12));
const file = process.argv[2];
let j;
try {
  j = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.log(JSON.stringify({ file, error: e.code || 'unparseable' }));
  process.exit(0);
}
const o = j.claudeAiOauth || {};
const fileHash = fp(fs.readFileSync(file));
console.log(JSON.stringify({
  file,
  file_fp: fileHash,
  top_keys: Object.keys(j),
  oauth_keys: Object.keys(o),
  expires_at: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
  expires_in_min: o.expiresAt ? Math.round((o.expiresAt - Date.now()) / 60000) : null,
  scopes: Array.isArray(o.scopes) ? o.scopes : null,
  subscription: o.subscriptionType || null,
  access_fp: fp(o.accessToken),
  refresh_fp: fp(o.refreshToken),
}));
