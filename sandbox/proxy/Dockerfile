# Quarterback egress proxy Ⓟ (agent-sandbox.md §4.2): ubuntu/squid (validated
# in E3) plus the Unix-socket bridge. The policy is rendered per run and passed
# in as QB_SQUID_CONF; the entrypoint writes it before starting Squid.
FROM ubuntu/squid:latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*
COPY entry.sh /entry.sh
RUN chmod 0755 /entry.sh
ENTRYPOINT ["/entry.sh"]
