// Test double: a "supervisor" that starts but never completes the readiness handshake.
setInterval(() => {}, 1 << 30);
