// Test double: a "supervisor" that completes the readiness handshake after 800 ms, then idles.
const path = require('path');
const P = require('../../lib/sandbox/protocol');

const [runDir] = process.argv.slice(2);
setTimeout(() => P.atomicWrite(path.join(runDir, 'supervisor.json'), { ...P.identity(process.pid), proto: 1, ready: true }), 800);
setInterval(() => {}, 1 << 30);
