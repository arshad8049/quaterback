# Quarterback agent image ③ (agent-sandbox.md §3.3, §7): the official Claude
# Code binary on a supported Node LTS, pinned to the version E1 tested, plus
# the trusted socket forwarder. Runs as uid 10001 with no network; its only way
# out is the proxy socket.
FROM node:24-bookworm-slim
ARG CLAUDE_VERSION=2.1.288
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY entry.sh /usr/local/lib/qb/agent-entry.sh
RUN chmod 0755 /usr/local/lib/qb/agent-entry.sh
