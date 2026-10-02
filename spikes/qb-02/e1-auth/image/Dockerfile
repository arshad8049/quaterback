# E1: the official Claude Code binary on a supported Node LTS base (design §7).
# The run records the exact Claude version and image digest.
FROM node:24-bookworm-slim
ARG CLAUDE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force
COPY credmeta.js /usr/local/bin/credmeta.js
