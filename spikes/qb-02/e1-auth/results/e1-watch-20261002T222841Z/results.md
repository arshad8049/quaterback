# E1 authentication results (watch)

```
run_id: e1-watch-20261002T222841Z
date_utc: 2026-10-02T22:28:41Z
host: Darwin arm64
docker_server: 28.1.1 (Docker Desktop 4.41.2 (191736))
claude: 2.1.288 (Claude Code)
node: v24.21.0
image_id: sha256:31c370d90e02
base: node:24-bookworm-slim
network: default bridge (E1 tests auth lifecycle; egress policy is E3's)
```

## Timeline

| time (UTC) | stored expires in (min) | run rc | reply OK | refreshed in-run | refresh token rotated | stored copy changed |
|---|---|---|---|---|---|---|
| 22:28 | 479 | 0 | 1 | 0 | 0 | 0 |
| 22:43 | 464 | 0 | 1 | 0 | 0 | 0 |
| 22:58 | 449 | 0 | 1 | 0 | 0 | 0 |
| 23:13 | 434 | 0 | 1 | 0 | 0 | 0 |
| 23:29 | 419 | 0 | 1 | 0 | 0 | 0 |
| 23:44 | 403 | 0 | 1 | 0 | 0 | 0 |
| 23:59 | 388 | 0 | 1 | 0 | 0 | 0 |
| 00:14 | 373 | 0 | 1 | 0 | 0 | 0 |
| 00:29 | 358 | 0 | 1 | 0 | 0 | 0 |
| 00:44 | 343 | 0 | 1 | 0 | 0 | 0 |
| 00:59 | 328 | 0 | 1 | 0 | 0 | 0 |
| 01:14 | 313 | 0 | 1 | 0 | 0 | 0 |
| 01:29 | 298 | 0 | 1 | 0 | 0 | 0 |
| 01:44 | 283 | 0 | 1 | 0 | 0 | 0 |
| 01:59 | 268 | 0 | 1 | 0 | 0 | 0 |
| 02:14 | 253 | 0 | 1 | 0 | 0 | 0 |
| 02:29 | 238 | 0 | 1 | 0 | 0 | 0 |
| 02:44 | 223 | 0 | 1 | 0 | 0 | 0 |
| 02:59 | 208 | 0 | 1 | 0 | 0 | 0 |
| 03:15 | 193 | 0 | 1 | 0 | 0 | 0 |
| 03:30 | 177 | 0 | 1 | 0 | 0 | 0 |
| 03:45 | 162 | 0 | 1 | 0 | 0 | 0 |
| 04:00 | 147 | 0 | 1 | 0 | 0 | 0 |
| 04:15 | 132 | 0 | 1 | 0 | 0 | 0 |
| 04:30 | 117 | 0 | 1 | 0 | 0 | 0 |
| 04:45 | 102 | 0 | 1 | 0 | 0 | 0 |
| 05:00 | 87 | 0 | 1 | 0 | 0 | 0 |
| 05:15 | 72 | 0 | 1 | 0 | 0 | 0 |
| 05:30 | 57 | 0 | 1 | 0 | 0 | 0 |
| 05:45 | 42 | 0 | 1 | 0 | 0 | 0 |
| 06:00 | 27 | 0 | 1 | 0 | 0 | 0 |
| 06:15 | 12 | 1 | 0 | 0 | 0 | 0 |
| 06:30 | -3 | 1 | 0 | 1 | 1 | 0 |
| 06:45 | -18 | 1 | 0 | 1 | 1 | 0 |

## Checks

| Check | Result | Detail |
|---|---|---|
| W0.start | OBSERVED | stored token expires in 479 min; checking every 15 min for up to 12 h with copy 'creds' |
| W1.session_length | OBSERVED | stored access token expired; runs after expiry had to refresh in-run (refreshed_in_run=1) |
| W2.rotation | OBSERVED | in-run refresh rotated the refresh token, but later runs from the unchanged stored copy still succeeded (old refresh token remained valid during this window) |
| W3.pre_run_refresh | FAIL | pre-run refresh rc=1; following run rc=1 reply_ok=0 (stored login may need 'run.sh login' again) |

No credential value appears in these files: only key names, expiry and 12-char SHA-256 fingerprints (scanned before saving).
