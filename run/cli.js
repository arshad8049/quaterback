/**
 * run/cli.js — inspect stored run records.
 *
 *   qb runs                 list recent runs
 *   qb show   <run_id>      print the manifest and event trail
 *   qb replay <run_id>      recompute verdicts and the final outcome from stored evidence
 *
 * Exit code: 0 on success / reproduced verdict, 1 otherwise.
 */

const store = require('./store');

function main(argv) {
  const [cmd, id] = argv;
  const runsDir = store.defaultRunsDir();

  try {
    if (cmd === 'runs') {
      const fs = require('fs');
      if (!fs.existsSync(runsDir)) { console.log('  (no runs)'); return 0; }
      const rows = fs.readdirSync(runsDir)
        .map(x => { try { return store.loadRun(x, runsDir).manifest; } catch (_) { return null; } })
        .filter(Boolean)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, 20);
      for (const m of rows) {
        console.log(`  ${m.run_id}  ${m.started_at}  ${m.outcome.padEnd(10)}  ${m.request.slice(0, 50)}`);
      }
      return 0;
    }

    if (!id) { console.error(`  usage: qb ${cmd} <run_id>`); return 1; }

    if (cmd === 'show') {
      const run = store.loadRun(id, runsDir);
      console.log(JSON.stringify(run.manifest, null, 2));
      for (const e of store.readEvents(run)) console.log(`  ${e.seq}  ${e.ts}  ${e.type}`);
      return 0;
    }

    if (cmd === 'replay') {
      const r = store.replay(id, runsDir);
      for (const a of r.attempts) {
        console.log(`  attempt ${a.attempt}: recorded=${a.recorded} replayed=${a.replayed} ${a.ok ? 'OK' : 'MISMATCH'}`);
      }
      const f = r.final;
      console.log(`  final: outcome=${f.outcome} legacy=${f.legacy_verdict} replayed=${f.replayed_verdict} `
        + `expected=${f.expected_outcome} ${f.ok ? 'OK' : 'MISMATCH'}`);
      console.log(`  outcome=${r.outcome}  ${r.ok ? 'reproduced' : 'NOT reproduced'}`);
      return r.ok ? 0 : 1;
    }
  } catch (e) {
    console.error(`  ${e.message}`);
    return 1;
  }

  console.error(`  unknown command: ${cmd}`);
  return 1;
}

module.exports = { main };
