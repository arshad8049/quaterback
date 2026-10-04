// QB node:test reporter (QB-06). Injected into sandbox stage ⑤ through NODE_OPTIONS
// (--test-reporter=<this> --test-reporter-destination=<file>), alongside the
// normal console reporter. It writes one JSON object per line — format
// "qb-node-test-events/1" — keeping only the events QB validates:
//
//   {"type":"qb:start","format":"qb-node-test-events/1"}
//   {"type":"test:pass"|"test:fail","name","nesting","path","file","kind","skip","todo","failureType","error"?}
//   path: the enclosing suite/test names (QB-10 identity), rebuilt from test:start
//         events, which node:test emits per file in definition order; null when
//         the stack does not match (the test can then never count as pre-existing).
//   {"type":"test:summary","file"?,"counts":{tests,passed,failed,cancelled,skipped,todo,...},"success"}
//   {"type":"qb:end"}                       written only when the stream completes
//
// verify/tests.js accepts the file only if it is complete (qb:start … qb:end),
// has exactly one run-level summary and its counts are internally consistent.

export default async function* qbReporter(source) {
  yield JSON.stringify({ type: 'qb:start', format: 'qb-node-test-events/1' }) + '\n';
  const stacks = new Map();   // file → names of the tests currently started, by nesting
  for await (const ev of source) {
    const d = ev.data || {};
    if (ev.type === 'test:start') {
      const st = stacks.get(d.file) || [];
      st.length = Math.max(0, d.nesting);
      st.push(String(d.name));
      stacks.set(d.file, st);
    } else if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const st = stacks.get(d.file);
      const path = st && Number.isInteger(d.nesting) && st.length > d.nesting && st[d.nesting] === String(d.name) ? st.slice(0, d.nesting) : null;
      yield JSON.stringify({
        type: ev.type, name: String(d.name), nesting: d.nesting, path, file: d.file ?? null,
        kind: d.details?.type ?? null, skip: Boolean(d.skip), todo: Boolean(d.todo),
        failureType: ev.type === 'test:fail' ? (d.details?.error?.failureType ?? null) : null,
        // QB-10: bounded failure evidence for repair (the assertion's own message).
        ...(ev.type === 'test:fail' ? { error: String(d.details?.error?.cause?.message || d.details?.error?.message || '').slice(0, 500) } : {}),
      }) + '\n';
    } else if (ev.type === 'test:summary') {
      yield JSON.stringify({ type: 'test:summary', file: d.file ?? null, counts: d.counts, success: d.success }) + '\n';
    }
  }
  yield JSON.stringify({ type: 'qb:end' }) + '\n';
}
