/**
 * empty-docker.js — require FIRST (TEST ONLY). Points QB_DOCKER_BIN at a stub
 * Docker CLI that answers every command successfully with no output: a daemon
 * with no containers, networks or volumes. Unit tests that run the real
 * supervisor use it so they need no Docker; an unanswered Docker is a
 * different, tested case (G5c, test/integration/qb02-sandbox-lifecycle.test.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-empty-docker-'));
const stub = path.join(dir, 'docker');
fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.QB_DOCKER_BIN = stub;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

module.exports = { stub };
