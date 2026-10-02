#!/bin/sh
# Ⓟ entrypoint: Squid on loopback, plus the Unix-socket bridge that consumers
# reach it through (design §4.1). The socket lives in the per-run sock volume.
set -eu
# Pre-create the logs so the unprivileged squid user can append and root (with no
# DAC override capability) can still read them; stream both to the container log.
for f in /tmp/access.log /tmp/cache.log; do : > "$f"; chmod 0666 "$f"; done
tail -F /tmp/access.log /tmp/cache.log 2>/dev/null &
squid -N -f /etc/squid/squid.conf &
SQUID=$!
i=0
until socat -u OPEN:/dev/null TCP:127.0.0.1:3128 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "squid did not start"; cat /tmp/cache.log; exit 1; }
  sleep 0.1
done
echo "squid up (pid $SQUID)"
exec socat UNIX-LISTEN:/sock/proxy.sock,fork,mode=0666,unlink-early TCP:127.0.0.1:3128
