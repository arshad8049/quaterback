// QB node:test reporter (QB-06). Injected into sandbox stage ⑤ through NODE_OPTIONS
// (--test-reporter=<this> --test-reporter-destination=<file>), alongside the
// normal console reporter. It writes one JSON object per line — format
// "qb-node-test-events/1" — keeping only the events QB validates:
//
//   {"type":"qb:start","format":"qb-node-test-events/1"}
//   {"type":"test:pass"|"test:fail","name","nesting","file","kind","skip","todo","failureType"}
//   {"type":"test:summary","file"?,"counts":{tests,passed,failed,cancelled,skipped,todo,...},"success"}
//   {"type":"qb:end"}                       written only when the stream completes
//
// verify/tests.js accepts the file only if it is complete (qb:start … qb:end),
// has exactly one run-level summary and its counts are internally consistent.

export default async function* qbReporter(source) {
  yield JSON.stringify({ type: 'qb:start', format: 'qb-node-test-events/1' }) + '\n';
  for await (const ev of source) {
    const d = ev.data || {};
    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      yield JSON.stringify({
        type: ev.type, name: String(d.name), nesting: d.nesting, file: d.file ?? null,
        kind: d.details?.type ?? null, skip: Boolean(d.skip), todo: Boolean(d.todo),
        failureType: ev.type === 'test:fail' ? (d.details?.error?.failureType ?? null) : null,
      }) + '\n';
    } else if (ev.type === 'test:summary') {
      yield JSON.stringify({ type: 'test:summary', file: d.file ?? null, counts: d.counts, success: d.success }) + '\n';
    }
  }
  yield JSON.stringify({ type: 'qb:end' }) + '\n';
}
