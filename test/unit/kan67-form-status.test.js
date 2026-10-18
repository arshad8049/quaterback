/**
 * KAN-67 browser check: the signup outcome must reach screen readers (WCAG 4.1.3, status messages).
 * Before: #form-feedback (400 / 429 / fallback messages) was not a live region, and on success the
 * form's contents were replaced by a "request received" note that nothing announced.
 * Now: #form-feedback is role="status", and a persistent, visually hidden role="status" region
 * OUTSIDE the form (it survives the form being replaced) receives the success message.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LP = path.join(__dirname, '..', '..', 'landing_page');
const html = fs.readFileSync(path.join(LP, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(LP, 'src', 'scripts', 'interactions.js'), 'utf8');

describe('KAN-67: signup status messages are announced', () => {
  test('#form-feedback is a live region (role="status")', () => {
    assert.match(html, /<p id="form-feedback" role="status"/);
  });
  test('a visually hidden role="status" region #form-status sits after the form, not inside it', () => {
    const form = html.indexOf('<form id="beta-form"'); const end = html.indexOf('</form>', form);
    const st = html.indexOf('id="form-status"');
    assert.ok(form > 0 && end > form, 'the beta form is on the page');
    assert.ok(st > end, '#form-status comes after </form>, so replacing the form keeps it');
    const tag = html.slice(html.lastIndexOf('<', st), html.indexOf('>', st) + 1);
    assert.match(tag, /role="status"/);
    assert.match(tag, /clip: rect\(0 0 0 0\)/, 'visually hidden, still read');
  });
  test('the success branch writes the outcome into #form-status', () => {
    const ok = js.slice(js.indexOf('if (res && res.ok && data && data.registered)'), js.indexOf('btn.textContent = originalText;'));
    assert.match(ok, /getElementById\('form-status'\)/);
    assert.match(ok, /Request received/);
  });
});
