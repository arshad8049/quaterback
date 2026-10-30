#!/usr/bin/env node
const { loadRun, defaultRunsDir } = require('../run/store');
const fs = require('fs');
const path = require('path');

const root = defaultRunsDir();
let [id, name] = process.argv.slice(2);

if (!id || id === 'latest') {
  const runs = fs.existsSync(root)
    ? fs.readdirSync(root)
        .filter(x => /^[0-9a-f-]{36}$/i.test(x))
        .map(x => {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(root, x, 'manifest.json'), 'utf8')
          );
          return { id: x, at: manifest.started_at };
        })
        .sort((a, b) => b.at.localeCompare(a.at))
    : [];

  if (!runs.length) {
    console.error('No runs in ' + root);
    process.exit(1);
  }

  id = runs[0].id;
}

const run = loadRun(id, root);

if (name === 'manifest') {
  console.log(JSON.stringify(run.manifest, null, 2));
} else if (name === 'events') {
  process.stdout.write(
    fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8')
  );
} else if (name) {
  if (!run.manifest.artifacts[name]) {
    console.error('Artifact not recorded yet: ' + name);
    process.exit(1);
  }

  // readArtifact verifies the saved content hash.
  const value = run.readArtifact(name);
  console.log(
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  );
} else {
  console.log(`Run: ${id}`);
  console.log(`Outcome: ${run.manifest.outcome}`);
  console.log(`Request: ${run.manifest.request}`);
  console.log(`QB: ${run.manifest.qb_revision}`);
  console.log(`Target base: ${run.manifest.repo.base_sha}`);
  console.log(`Directory: ${run.dir}`);

  for (const [key, ref] of Object.entries(run.manifest.artifacts)) {
    console.log(`${key}\t${ref.sha256}\t${ref.path}`);
  }
}
