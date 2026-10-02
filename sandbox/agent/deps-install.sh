#!/bin/sh
# Dependencies, untrusted part (agent-sandbox.md §3.2). Repository lifecycle
# scripts of dependencies run here, contained: no external network except the
# DEPS proxy (npm registry only), no credentials, own limits. The fixed argv is
# `npm ci`; the result is node_modules, moved into the deps volume.
#   /scratch  writable copy of the base tree (prepared by deps-plan.sh)
#   /deps     the deps volume (becomes node_modules for the agent and verifier)
set -eu
socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock &
i=0
until socat -u OPEN:/dev/null TCP:127.0.0.1:8888 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 50 ] || { echo "qb: proxy forwarder did not start" >&2; exit 70; }
  sleep 0.1
done
cd /scratch
npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/ --proxy=http://127.0.0.1:8888 --https-proxy=http://127.0.0.1:8888
if [ -d node_modules ]; then
  cp -a node_modules/. /deps/
  rm -rf node_modules
fi
echo "qb: dependencies installed"
