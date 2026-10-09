# Admin exports (QB-34)

**Problem (review, QB-34):**
- The admin secret was accepted only in the URL (`?secret=`), so it could end up in browser history, proxies and logs.
- CSV cells were quoted, but formula prefixes weren't neutralized, so a signup field like `=HYPERLINK(...)` was evaluated by spreadsheet clients.
- Personal signup data was returned with no `no-store` and with `Access-Control-Allow-Origin: *`.
- The legacy Pages functions `functions/api/report.js` and `submissions.js` had the same URL-secret design.

## Now

- **Authentication:**
  - only `Authorization: Bearer <ADMIN_SECRET>`, compared in constant time (fixed-length sha256 digests);
  - a `secret`, `token` or `key` query parameter is **refused with 400, even when correct**, so the habit can't persist;
  - wrong or missing credentials → **401**, which never includes signup data;
  - methods other than GET → 405.
- **Caching and cross-origin:** every admin response, 400/401 included, carries `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and **no CORS grant**, so personal data can't be read cross-origin.
- **CSV:** every cell is quoted with `"` doubled. A cell that begins with `=`, `+`, `-`, `@`, tab, CR, LF, or their full-width forms is prefixed with `'`. Lines end with CRLF, and the charset is utf-8.
- **Pagination:** `limit` (1–500, default 100) and `cursor` (the last id seen), newest first. JSON returns `next_cursor`; CSV returns `X-Next-Cursor`. Bad values → 400.
- **Logging:** the worker logs no request URLs or headers. Since credentials are no longer accepted in URLs, they can't reach URL logs.
- **Removed:** the legacy `functions/api/report.js` and `submissions.js`.

## Usage

```
curl -H "Authorization: Bearer $ADMIN_SECRET" https://quaterback.velorallc.workers.dev/api/report
curl -H "Authorization: Bearer $ADMIN_SECRET" "https://quaterback.velorallc.workers.dev/api/submissions?format=csv&limit=500" -o signups.csv
```

## Verified spreadsheet client (re-review 1)

**Supported and verified:** LibreOffice Calc 7.4.7.2 (Debian bookworm, `libreoffice-calc-nogui`), headless CSV import of the export, under two import settings:
- the default (`CSV:44,34,76,1`);
- the worst case, **formula evaluation on** (`CSV:44,34,76,1,,1033,false,true,false,false,false,-1,true`).

**How it's checked:** `test/integration/qb34-spreadsheet.test.js` (Docker; image `test/fixtures/libreoffice`):
1. **Baseline:** with formula evaluation on, a **raw** `=1+1` imports as a live formula. This proves the import path really evaluates formulas.
2. **The export:** the real worker exports 19 adversarial values in the two user-controlled columns, agent and referrer.
   - The values: `=` (including HYPERLINK and DDE-style payloads), `+`, `-`, `@`, leading tab, CR and LF, full-width `＝＋－＠`, embedded quotes, delimiters and multiline values.
   - Under both settings the workbook contains **0 formulas**, and every one of those cells is a **text** cell equal to `'` followed by the original value.
   - The neutralizing apostrophe is visible in the cell, by design.

**Not verified:** Microsoft Excel, Google Sheets and Apple Numbers. No claim is made for them.

**Rotate `ADMIN_SECRET`** — a **deployment gate**, not optional: (`wrangler secret put ADMIN_SECRET`) after deploying: earlier `?secret=` URLs may persist in history or logs.

## Tests

`test/unit/qb34-admin-exports.test.js` runs the real worker on a real SQLite D1, on Node 22+. Pre-fix, all 5 fail: a URL secret got 200, a header got 403, formula cells were raw, and there was no pagination.
