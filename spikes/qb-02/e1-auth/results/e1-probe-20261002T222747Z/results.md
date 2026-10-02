# E1 authentication results (probe)

```
run_id: e1-probe-20261002T222747Z
date_utc: 2026-10-02T22:27:47Z
host: Darwin arm64
docker_server: 28.1.1 (Docker Desktop 4.41.2 (191736))
claude: 2.1.288 (Claude Code)
node: v24.21.0
image_id: sha256:31c370d90e02
base: node:24-bookworm-slim
network: default bridge (E1 tests auth lifecycle; egress policy is E3's)
```

## Checks

| Check | Result | Detail |
|---|---|---|
| P1.auth_files | OBSERVED | login wrote: ./.credentials.json(519B) ./backups(4096B) ./backups/.claude.json.backup.1790980020178(84B) ./.claude.json(1143B)  |
| P1.credential_shape | OBSERVED | keys=[accessToken,refreshToken,expiresAt,refreshTokenExpiresAt,scopes,subscriptionType,rateLimitTier] subscription=pro expires_in_min=480 scopes=[user:file_upload,user:inference,user:mcp_servers,user:plugins,user:profile,user:sessions:claude_code] |
| P2.copy_creds | PASS | run succeeded with per-run copy 'creds' |
| P2.copy_creds+config | PASS | run succeeded with per-run copy 'creds+config' |
| P2.copy_full | PASS | run succeeded with per-run copy 'full' |
| P2.minimal_copy | OBSERVED | smallest working per-run copy: creds |
| P3.no_write_back | PASS | stored credential unchanged after 3 runs (fingerprint 8cdb7398b19c) |
| P4.overwrite_attack | PASS | copy overwritten with attacker values (fp 2470d41ebf3f) and discarded; stored credential unchanged; next run used the original and succeeded |
| P5.concurrent_with_refresh | PASS | run A (copy before refresh) and run B (copy after) both succeeded; pre-run refresh rc=0 |
| P5.refresh_effect | OBSERVED | pre-run refresh did not change the stored credential (token not near expiry) |
| P6.auth_lock | PASS | a login attempted while refresh+copy holds the lock is refused (auth_busy) instead of interleaving |
| P7.expiry_and_rotation | PENDING | covered by '/Users/Arshad_1/Desktop/millionaire/quaterback/spikes/qb-02/e1-auth/run.sh watch' (needs the access token to expire) |

No credential value appears in these files: only key names, expiry and 12-char SHA-256 fingerprints (scanned before saving).
