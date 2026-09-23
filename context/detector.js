const fs   = require('fs');
const path = require('path');

/**
 * Detect framework, language, test runner, and architecture pattern from repo structure.
 * Pure DSA — reads package.json, pyproject.toml, go.mod, and directory layout.
 */
function detectPatterns(repoPath) {
  return {
    language:     detectLanguage(repoPath),
    framework:    detectFramework(repoPath),
    test_runner:  detectTestRunner(repoPath),
    architecture: detectArchitecture(repoPath),
  };
}

function detectLanguage(repoPath) {
  if (exists(repoPath, 'go.mod'))                          return 'go';
  if (exists(repoPath, 'pyproject.toml') ||
      exists(repoPath, 'requirements.txt') ||
      exists(repoPath, 'setup.py'))                        return 'python';
  if (exists(repoPath, 'Cargo.toml'))                      return 'rust';
  if (exists(repoPath, 'tsconfig.json'))                   return 'typescript';
  if (exists(repoPath, 'package.json'))                    return 'javascript';
  return null;
}

function detectFramework(repoPath) {
  const pkg = readJSON(repoPath, 'package.json');
  if (pkg) {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all.next)        return 'next.js';
    if (all.nuxt)        return 'nuxt';
    if (all['@remix-run/react']) return 'remix';
    if (all['@sveltejs/kit'])    return 'sveltekit';
    if (all.express)     return 'express';
    if (all.fastify)     return 'fastify';
    if (all.hono)        return 'hono';
    if (all.react)       return 'react';
    if (all.vue)         return 'vue';
    if (all.svelte)      return 'svelte';
  }

  const pyproject = readTOMLish(repoPath, 'pyproject.toml');
  if (pyproject) {
    if (/fastapi/i.test(pyproject))  return 'fastapi';
    if (/django/i.test(pyproject))   return 'django';
    if (/flask/i.test(pyproject))    return 'flask';
  }

  if (exists(repoPath, 'requirements.txt')) {
    const req = readFile(repoPath, 'requirements.txt');
    if (/fastapi/i.test(req))  return 'fastapi';
    if (/django/i.test(req))   return 'django';
    if (/flask/i.test(req))    return 'flask';
  }

  return null;
}

function detectTestRunner(repoPath) {
  const pkg = readJSON(repoPath, 'package.json');
  if (pkg) {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all.vitest)  return 'vitest';
    if (all.jest)    return 'jest';
    if (all.mocha)   return 'mocha';
    if (all.jasmine) return 'jasmine';
    if (pkg.scripts) {
      const testCmd = pkg.scripts.test || '';
      if (/vitest/.test(testCmd))  return 'vitest';
      if (/jest/.test(testCmd))    return 'jest';
      if (/mocha/.test(testCmd))   return 'mocha';
    }
  }

  if (exists(repoPath, 'pytest.ini') || exists(repoPath, 'conftest.py')) return 'pytest';
  if (exists(repoPath, 'go.mod'))  return 'go test';

  return null;
}

function detectArchitecture(repoPath) {
  const dirs = listDirs(repoPath);

  // Feature-based (all code grouped by feature)
  if (dirs.includes('features') || dirs.includes('modules')) return 'feature-folders';

  // Classic MVC signals
  const hasMVC = ['models', 'views', 'controllers'].filter(d => dirs.includes(d)).length;
  if (hasMVC >= 2) return 'mvc';

  // Service layer
  const hasService = ['services', 'repositories', 'handlers'].filter(d => dirs.includes(d)).length;
  if (hasService >= 2) return 'service-layer';

  // Next.js / file-based routing
  if (dirs.includes('app') || dirs.includes('pages')) {
    const pkg = readJSON(repoPath, 'package.json');
    if (pkg?.dependencies?.next || pkg?.devDependencies?.next) return 'next-app-router';
  }

  // Flat src/ structure
  if (dirs.includes('src')) return 'src-flat';

  return null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function exists(repoPath, file) {
  return fs.existsSync(path.join(repoPath, file));
}

function readJSON(repoPath, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, file), 'utf8'));
  } catch (_) { return null; }
}

function readTOMLish(repoPath, file) {
  try {
    return fs.readFileSync(path.join(repoPath, file), 'utf8');
  } catch (_) { return null; }
}

function readFile(repoPath, file) {
  try {
    return fs.readFileSync(path.join(repoPath, file), 'utf8');
  } catch (_) { return ''; }
}

function listDirs(repoPath) {
  try {
    return fs.readdirSync(repoPath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name.toLowerCase());
  } catch (_) { return []; }
}

module.exports = { detectPatterns };
