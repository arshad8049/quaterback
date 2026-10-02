#!/bin/sh
# Agent stage ③ entrypoint (agent-sandbox.md §3.3, §4.1). The briefing arrives
# on stdin. The trusted forwarder bridges 127.0.0.1:8888 to the proxy socket,
# because Claude Code needs a TCP proxy URL; nothing else leaves the container.
set -eu
socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock &
i=0
until socat -u OPEN:/dev/null TCP:127.0.0.1:8888 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 50 ] || { echo "qb: proxy forwarder did not start" >&2; exit 70; }
  sleep 0.1
done
cd /work
exec claude -p --dangerously-skip-permissions --output-format text "$@"
