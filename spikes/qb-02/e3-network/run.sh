#!/usr/bin/env bash
# QB-02 experiment E3: networking (docs/security/agent-sandbox.md §4, §11.1, §11.2 T-NET).
#
# Topology (all per run):
#   untrusted consumer  --network none, sock volume mounted READ-ONLY, in-container
#                       forwarder 127.0.0.1:8888 → /sock/proxy.sock
#   Ⓟ proxy             Squid (ubuntu/squid) on loopback + Unix-socket bridge,
#                       on its own bridge network 10.233.<n>.0/24
#   fixtures            test resolver 10.233.<n>.53 (dnsmasq; Squid's only resolver)
#                       internal canary 10.233.<n>.99:443 (logs every connection)
#
# Demonstrates: the consumer has no way out except the proxy; the proxy allows
# CONNECT only to exact allowlisted names on 443; IP literals, subdomains and
# non-listed names are refused without being resolved; allowlisted names that
# resolve (now, mixed, or after a flip) to denied ranges are refused, and the
# canary — a real internal service — receives zero connections; the socket
# cannot be replaced from a consumer; the proxy survives a connection flood.
#
# Valid evidence only on Linux x86_64 + Docker Engine.
# Usage: spikes/qb-02/e3-network/run.sh [results_dir]

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="e3-$(date -u +%Y%m%dT%H%M%SZ)-$$"
OUT="${1:-$HERE/results/$RUN}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
LOG="$OUT/raw.log"; TSV="$OUT/results.tsv"
: > "$LOG"; printf 'id\tresult\tdetail\n' > "$TSV"
ALLOWED_REAL=api.anthropic.com

# has <ERE>: like `grep -qE`, but reads all of stdin. Under `set -o pipefail`,
# `producer | grep -q` can fail (SIGPIPE to the producer) when grep exits early.
has() { [ "$(grep -cE -- "$1")" != 0 ]; }
log()    { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TSV"; log "RESULT $1 $2 — $3"; }

cleanup() {
  local c
  c=$(docker ps -aq --filter "label=qb.spike=$RUN"); [ -n "$c" ] && docker rm -f $c >/dev/null 2>&1
  for n in $(docker network ls -q --filter "label=qb.spike=$RUN"); do docker network rm "$n" >/dev/null 2>&1; done
  c=$(docker volume ls -q --filter "label=qb.spike=$RUN"); [ -n "$c" ] && docker volume rm -f $c >/dev/null 2>&1
  [ -n "${HOST_SRV:-}" ] && kill "$HOST_SRV" 2>/dev/null
  return 0
}
trap cleanup EXIT

L=(--label "qb.spike=$RUN")
HARDEN=(--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only
        --tmpfs /tmp:rw,nosuid,nodev,size=16m --init --pids-limit 256 "${L[@]}")

# ---------------------------------------------------------------- images + env
# Pull the bases explicitly so their digests can be recorded (a BuildKit build
# does not leave the base image inspectable in the daemon).
docker pull -q ubuntu/squid:latest >> "$LOG" 2>&1; docker pull -q alpine:3.20 >> "$LOG" 2>&1
docker build -q -t "qb-e3-proxy:$RUN" "$HERE/proxy" >> "$LOG" 2>&1 || { log "proxy image build failed"; exit 2; }
docker build -q -t "qb-e3-client:$RUN" "$HERE/client" >> "$LOG" 2>&1 || { log "client image build failed"; exit 2; }
EVIDENCE=yes
PLATFORM=$(docker version --format '{{.Server.Platform.Name}}' 2>/dev/null || echo unknown)
case "$PLATFORM" in *Desktop*) EVIDENCE=no ;; esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || EVIDENCE=no
{
  echo "run_id: $RUN"; echo "date_utc: $(date -u +%FT%TZ)"
  echo "host: $(uname -s) $(uname -m), kernel $(uname -r)"
  [ -r /etc/os-release ] && echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"
  echo "docker_server: $(docker version --format '{{.Server.Version}}') ($PLATFORM)"
  echo "proxy_base: $(docker image inspect -f '{{index .RepoDigests 0}}' ubuntu/squid:latest 2>/dev/null)"
  echo "squid: $(docker run --rm --entrypoint squid "qb-e3-proxy:$RUN" -v | head -1)"
  echo "client_base: $(docker image inspect -f '{{index .RepoDigests 0}}' alpine:3.20 2>/dev/null)"
  echo "evidence: $EVIDENCE"
} > "$OUT/env.txt"
cp "$HERE/proxy/squid.conf" "$OUT/squid.conf"
cat "$OUT/env.txt" >> "$LOG"

# start_run <n> → per-run network 10.233.<n>.0/24, resolver, canary, sock volume, proxy
start_run() {
  local n=$1 r="$RUN-r$1"
  docker network create --subnet "10.233.$n.0/24" "${L[@]}" "$r-net" >/dev/null
  docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m "${L[@]}" "$r-sock" >/dev/null
  docker run -d --name "$r-dns" "${L[@]}" --network "$r-net" --ip "10.233.$n.53" "qb-e3-client:$RUN" \
    sh -c ': > /tmp/hosts; exec dnsmasq -k --log-queries --log-facility=- --no-resolv --no-hosts \
           --server=1.1.1.1 --server=8.8.8.8 --addn-hosts=/tmp/hosts --local-ttl=0 --user=root' >/dev/null
  docker run -d --name "$r-canary" "${L[@]}" --network "$r-net" --ip "10.233.$n.99" "qb-e3-client:$RUN" \
    socat -d -d TCP-LISTEN:443,fork,reuseaddr SYSTEM:true >/dev/null
  # Ⓟ: hardened; root only to bind the socket and let Squid drop to `proxy`.
  docker run -d --name "$r-proxy" "${L[@]}" --network "$r-net" --ip "10.233.$n.10" \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges \
    --read-only --tmpfs /tmp:rw,size=64m --tmpfs /run:rw,size=1m --memory 256m --memory-swap 256m --pids-limit 512 \
    -v "$r-sock:/sock" "qb-e3-proxy:$RUN" >/dev/null
}
set_hosts() {   # set_hosts <n> "<ip> <name>"... → rewrite the resolver's hosts and reload
  local n=$1; shift
  printf '%s\n' "$@" | docker exec -i "$RUN-r$n-dns" sh -c 'cat > /tmp/hosts && kill -HUP 1'
  echo "hosts r$n: $*" >> "$LOG"
}
canary_hits() { docker logs "$RUN-r$1-canary" 2>&1 | grep -c 'accepting connection' ; }
dns_seen()    { docker logs "$RUN-r$1-dns" 2>&1 | grep -c "query\[.*\] $2 " ; }

# Squid's resolver address is baked into squid.conf as 10.233.0.53, so run 1 uses
# subnet 10.233.0.0/24 and run 2 (the "other run") uses 10.233.1.0/24, whose
# proxy is configured with the same file but only needs to exist and be reachable.
start_run 0
start_run 1

# Wait for both proxies' sockets.
for n in 0 1; do
  for _ in $(seq 1 100); do
    docker logs "$RUN-r$n-proxy" 2>&1 | has 'squid up' && break; sleep 0.2
  done
  docker logs "$RUN-r$n-proxy" 2>&1 | has 'squid up' \
    || { log "proxy r$n did not start"; docker logs "$RUN-r$n-proxy" >> "$LOG" 2>&1; result SETUP.proxy ERROR "proxy r$n did not start"; exit 1; }
done

# Untrusted consumer of run 0: no network, socket volume read-only, forwarder on loopback.
C="$RUN-r0-consumer"
docker run -d --name "$C" "${HARDEN[@]}" --network none -v "$RUN-r0-sock:/sock:ro" "qb-e3-client:$RUN" \
  sh -c 'socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock & exec sleep 2147483647' >/dev/null
sleep 1

# t <id> <expect: ok|fail|code:NNN> <description> <shell command run inside the consumer>
t() {
  local id=$1 expect=$2 desc=$3 cmd=$4 out rc
  out=$(docker exec "$C" sh -c "$cmd" 2>&1); rc=$?
  printf '\n### %s\n$ %s\n%s\n(rc=%s)\n' "$id" "$cmd" "$out" "$rc" >> "$LOG"
  case "$expect" in
    ok)   [ "$rc" = 0 ] && result "$id" PASS "$desc" || result "$id" FAIL "$desc — expected success, rc=$rc: $(echo "$out" | tail -1)" ;;
    fail) [ "$rc" != 0 ] && result "$id" PASS "$desc (rc=$rc)" || result "$id" FAIL "$desc — unexpectedly succeeded: $(echo "$out" | tail -1)" ;;
    code:*) local want=${expect#code:}
          [ "$(echo "$out" | tail -1)" = "$want" ] && result "$id" PASS "$desc (CONNECT → $want)" \
                                                  || result "$id" FAIL "$desc — expected CONNECT $want, got: $(echo "$out" | tail -1)" ;;
  esac
}
# CONNECT through the forwarder; prints the proxy's CONNECT status code (000 = no response).
via() { echo "curl -s -o /dev/null --max-time 15 -w '%{http_connect}' -p -x http://127.0.0.1:8888 https://$1/ ; true"; }

# ---------------------------------------------------- consumer has no way out
GW=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
LAN=$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null) | awk '{print $1}')
python3 -m http.server 18080 --bind 0.0.0.0 >/dev/null 2>&1 & HOST_SRV=$!
sleep 1
# Kernels with tunnel modules loaded create fallback devices (tunl0, gre0, sit0, …)
# in every namespace. They are down, unaddressed and need CAP_NET_ADMIN to configure,
# so the real test is: no IPv4/IPv6 route except via lo, and every non-lo device down.
IFCHECK='ls /sys/class/net | tr "\n" " "; echo
v4=$(tail -n +2 /proc/net/route | wc -l)
v6=$(awk "\$10 != \"lo\"" /proc/net/ipv6_route 2>/dev/null | wc -l)
up=0; for i in /sys/class/net/*; do [ -d "$i" ] || continue; n=${i##*/}; [ "$n" = lo ] && continue; [ "$(cat $i/operstate)" = down ] || up=$((up+1)); done
echo "ipv4_routes=$v4 non_lo_ipv6_routes=$v6 non_lo_up=$up"
[ "$v4" = 0 ] && [ "$v6" = 0 ] && [ "$up" = 0 ]'
t net.interfaces       ok   "no route except loopback, and every non-lo device is down (no external network interface)" "$IFCHECK"
t net.gateway          fail "direct TCP to the docker bridge gateway $GW:18080 (host service)" "nc -w 3 -z $GW 18080"
t net.lan              fail "direct TCP to the host's LAN IP ${LAN:-unknown}:18080" "nc -w 3 -z ${LAN:-192.0.2.1} 18080"
t net.host_internal    fail "host.docker.internal is unreachable" "nc -w 3 -z host.docker.internal 18080"
t net.metadata         fail "direct TCP to 169.254.169.254:80 (cloud metadata)" "nc -w 3 -z 169.254.169.254 80"
t net.ipv6             fail "direct IPv6 (2606:4700:4700::1111:443)" "nc -w 3 -z 2606:4700:4700::1111 443"
t net.internet         fail "direct TCP to 1.1.1.1:443 (bypassing the proxy)" "nc -w 3 -z 1.1.1.1 443"
t net.dns              fail "resolve example.com (any resolver)" "nslookup -timeout=3 example.com"
t net.dns_explicit     fail "resolve via 8.8.8.8 explicitly" "nslookup -timeout=3 example.com 8.8.8.8"
t net.other_run_proxy  fail "TCP to the other run's proxy 10.233.1.10:3128" "nc -w 3 -z 10.233.1.10 3128"
t net.other_run_sock   ok   "only this run's socket is visible (the other run's socket volume is not mounted)" "[ \"\$(ls -A /sock)\" = proxy.sock ]"
t sock.unlink          fail "cannot unlink the proxy socket (read-only mount)" "rm -f /sock/proxy.sock"
t sock.replace         fail "cannot create files in the socket directory" "touch /sock/evil.sock"
t sock.still_there     ok   "socket still present after the attempts" "[ -S /sock/proxy.sock ]"

# ------------------------------------------------------- proxy policy (§4.1)
t policy.allowed       code:200 "CONNECT to allowlisted $ALLOWED_REAL:443" "$(via $ALLOWED_REAL)"
t policy.not_listed    code:403 "CONNECT to a non-allowlisted host (example.com)" "$(via example.com)"
t policy.subdomain     code:403 "CONNECT to a subdomain of an allowlisted host" "$(via evil.$ALLOWED_REAL)"
t policy.ip_literal    code:403 "CONNECT to an IP literal (1.1.1.1)" "$(via 1.1.1.1)"
t policy.metadata_lit  code:403 "CONNECT to 169.254.169.254" "$(via 169.254.169.254)"
t policy.host_internal code:403 "CONNECT to host.docker.internal" "$(via host.docker.internal)"
t policy.port          code:403 "CONNECT to an allowlisted host on port 80" "curl -s -o /dev/null --max-time 15 -w '%{http_connect}' -p -x http://127.0.0.1:8888 http://$ALLOWED_REAL:80/ ; true"
t policy.plain_http    fail "plain (non-CONNECT) HTTP request through the proxy is refused" "curl -sf --max-time 15 -x http://127.0.0.1:8888 http://$ALLOWED_REAL/"
t policy.bypass_fwd    ok   "talking to the socket directly (bypassing the forwarder) is still policed: 403" \
  "printf 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n' | socat -t 5 - UNIX-CONNECT:/sock/proxy.sock | head -1 | grep -q ' 403 '"

# DNS exfiltration: a non-listed name must never reach the resolver.
EXFIL="exfil-$RANDOM$RANDOM.attacker.test"
t policy.exfil_name    code:403 "CONNECT to an attacker-chosen name" "$(via $EXFIL)"
[ "$(dns_seen 0 "$EXFIL")" = 0 ] && result policy.exfil_not_resolved PASS "the resolver never saw $EXFIL" \
                                  || result policy.exfil_not_resolved FAIL "the resolver received a query for $EXFIL"

# ------------------------------------- resolver cases: checked IP = connected IP
PUB=$(python3 -c 'import socket; print(socket.gethostbyname("example.com"))' 2>/dev/null)
CANARY=10.233.0.99
echo "public test address (example.com): $PUB" >> "$LOG"
set_hosts 0 "$PUB ok.qb.test" "$PUB flip.qb.test" "$PUB mixed.qb.test" "$CANARY mixed.qb.test" \
            "198.51.100.7 fallback.qb.test" "$CANARY fallback.qb.test"
sleep 2
t dns.public_ok        code:200 "allowlisted test name resolving to a public IP" "$(via ok.qb.test)"
t dns.flip_before      code:200 "flip.qb.test before the flip (public IP)" "$(via flip.qb.test)"
set_hosts 0 "$PUB ok.qb.test" "$CANARY flip.qb.test" "$PUB mixed.qb.test" "$CANARY mixed.qb.test" \
            "198.51.100.7 fallback.qb.test" "$CANARY fallback.qb.test"
sleep 3   # past Squid's 1 s positive_dns_ttl
t dns.flip_after       code:403 "flip.qb.test after it rebinds to the internal canary $CANARY (TTL 0)" "$(via flip.qb.test)"
t dns.mixed            code:403 "mixed.qb.test: one public and one denied answer → refused outright" "$(via mixed.qb.test)"
t dns.fallback         code:403 "fallback.qb.test: unreachable public answer + denied answer → no failover to the denied one" "$(via fallback.qb.test)"
HITS=$(canary_hits 0)
[ "$HITS" = 0 ] && result dns.canary_untouched PASS "the internal canary ($CANARY:443) received 0 connections across all cases" \
                || result dns.canary_untouched FAIL "the internal canary received $HITS connection(s)"
# The address Squid connected to for allowed requests must be the public one.
docker logs "$RUN-r0-proxy" > "$OUT/proxy-r0.log" 2>&1
CONNECTED=$(grep -E ' TCP_TUNNEL/200 CONNECT (ok|flip)\.qb\.test' "$OUT/proxy-r0.log" | awk '{print $5}' | sort -u | tr '\n' ' ')
case "$CONNECTED" in "$PUB ") result dns.connected_ip PASS "every allowed test-name tunnel connected to $PUB (from Squid's access log)" ;;
  *) result dns.connected_ip FAIL "test-name tunnels connected to: [$CONNECTED] (expected only $PUB)" ;; esac
grep -E ' TCP_TUNNEL/200 ' "$OUT/proxy-r0.log" | awk '{print $5}' | has '^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' \
  && result dns.no_internal_tunnel FAIL "an allowed tunnel went to a denied range" \
  || result dns.no_internal_tunnel PASS "no allowed tunnel in the access log went to a denied range"

# ------------------------------------------------------- flood (§4.2 limits)
FLOOD=100   # within the consumer's pids limit (each CONNECT also forks the in-container forwarder)
OUTP=$(docker exec "$C" sh -c "i=0; while [ \$i -lt $FLOOD ]; do curl -s -o /dev/null --max-time 20 -w '%{http_connect}\n' -p -x http://127.0.0.1:8888 https://$ALLOWED_REAL/ & i=\$((i+1)); done; wait" 2>&1)
OK200=$(echo "$OUTP" | grep -c '^200$')
PST=$(docker inspect -f 'running={{.State.Running}} oom={{.State.OOMKilled}}' "$RUN-r0-proxy")
MEM=$(docker stats --no-stream --format '{{.MemUsage}}' "$RUN-r0-proxy")
echo "flood: $OK200/$FLOOD returned 200; proxy $PST; mem $MEM" >> "$LOG"
t flood.after code:200 "allowlisted CONNECT still works after the flood" "$(via $ALLOWED_REAL)"
case "$PST" in "running=true oom=false")
  result flood.proxy_healthy PASS "$FLOOD concurrent CONNECTs: $OK200 answered 200; proxy still running, not OOM-killed (mem $MEM, limit 256 MiB)" ;;
  *) result flood.proxy_healthy FAIL "after $FLOOD concurrent CONNECTs: $PST" ;; esac

# ----------------------------------------------------------- inspect checks
for c in "$C" "$RUN-r0-proxy"; do
  INS=$(docker inspect -f 'net={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}} ports={{len .HostConfig.PortBindings}} priv={{.HostConfig.Privileged}} mounts={{range .Mounts}}{{.Source}},{{end}}' "$c")
  echo "inspect $c: $INS" >> "$LOG"
  case "$INS" in *docker.sock*|*"priv=true"*|*"pid=host"*|*"net=host"*) result "inspect.${c##*-}" FAIL "$INS" ;;
    *"ports=0"*) result "inspect.${c##*-}" PASS "no published ports, no host network/PID namespace, not privileged, no Docker socket" ;;
    *) result "inspect.${c##*-}" FAIL "$INS" ;; esac
done
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C")" = none ] && result inspect.consumer_network PASS "consumer network mode is none" \
  || result inspect.consumer_network FAIL "consumer network mode is not none"

# ------------------------------------------------------------ summary
docker logs "$RUN-r0-dns" > "$OUT/resolver-r0.log" 2>&1
docker logs "$RUN-r0-canary" > "$OUT/canary-r0.log" 2>&1
log "== cleanup"
cleanup
LEFT=$(( $(docker ps -aq --filter "label=qb.spike=$RUN" | wc -l) + $(docker network ls -q --filter "label=qb.spike=$RUN" | wc -l) + $(docker volume ls -q --filter "label=qb.spike=$RUN" | wc -l) ))
[ "$LEFT" = 0 ] && result cleanup PASS "0 containers, networks or volumes left" || result cleanup FAIL "$LEFT resources left"
{
  echo "# E3 networking results"; echo; echo '```'; cat "$OUT/env.txt"; echo '```'
  [ "$EVIDENCE" = yes ] || echo -e "\n> **NOT EVIDENCE**: not Linux x86_64 + Docker Engine. Debug run only.\n"
  echo; echo "Resolver: **Squid alone** (no filtering-resolver contingency). Policy: [squid.conf](squid.conf)."
  echo; echo "| Check | Result | Detail |"; echo "|---|---|---|"
  tail -n +2 "$TSV" | awk -F'\t' '{printf "| %s | %s | %s |\n",$1,$2,$3}'
  echo; echo "Raw: raw.log (each command and its output), proxy-r0.log (Squid access log), resolver-r0.log, canary-r0.log"
} > "$OUT/results.md"
log "results: $OUT/results.md"
grep -qE $'\t(FAIL|ERROR)\t' "$TSV" && exit 1 || exit 0
