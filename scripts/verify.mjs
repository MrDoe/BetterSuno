#!/usr/bin/env node
// scripts/verify.mjs — the single command CI and humans both run.
//
//   node scripts/verify.mjs
//
// Steps: syntax-check every runtime source, run the test suite, then build both
// browser targets (which also fails on unresolved relative imports).
//
// This exists because verification used to be a manual checklist in AGENTS.md
// and the code-review skill, and because the two 2026-09 bugfix releases were
// each validated by throwaway hand-written harnesses that were never committed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cd = (...parts) => path.join(ROOT, ...parts);

const RUNTIME_SOURCES = [
  'background.js',
  'content.js',
  'content-idb.js',
  'content-fetcher.js',
  'create.js',
  'downloader.js',
  'idb-store.js',
  'idb-helpers.js',
  'offscreen.js',
  'build.js',
  'lib/auth-state.js',
  'lib/identity.js',
  'lib/ownership.js',
  'lib/util.js',
  'lib/suno-audio.js',
];

// The extension's own test files, syntax-checked alongside the sources.
const TEST_SOURCES = fs
  .readdirSync(cd('tests'))
  .filter(f => f.endsWith('.test.js'))
  .map(f => `tests/${f}`);

let failed = false;
const step = (label, fn) => {
  process.stdout.write(`\n── ${label}\n`);
  try {
    fn();
    process.stdout.write(`   ok\n`);
  } catch (err) {
    failed = true;
    process.stdout.write(`   FAILED\n${err.stdout ?? ''}${err.stderr ?? err.message}\n`);
  }
};

step('syntax check', () => {
  for (const rel of [...RUNTIME_SOURCES, ...TEST_SOURCES]) {
    execFileSync(process.execPath, ['--check', cd(rel)], { stdio: 'pipe' });
  }
  // Any new .js at the top level or in lib/ must be listed above, otherwise it
  // silently escapes the check. (scripts/ and tests/ are excluded deliberately:
  // scripts are tooling, and tests are syntax-checked via TEST_SOURCES.)
  const onDisk = [
    ...fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).map(f => f),
    ...fs.readdirSync(cd('lib')).map(f => `lib/${f}`),
  ];
  const missing = onDisk.filter(f => !RUNTIME_SOURCES.includes(f));
  if (missing.length) {
    throw new Error(`unlisted source file(s) — add to RUNTIME_SOURCES: ${missing.join(', ')}`);
  }
});

step('tests', () => {
  const specs = fs
    .readdirSync(cd('tests'))
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => cd('tests', f));
  if (specs.length === 0) {
    throw new Error('no test files found in tests/');
  }
  execFileSync(process.execPath, ['--test', ...specs], { stdio: 'inherit' });
});

step('build (chrome + firefox)', () => {
  execFileSync(process.execPath, [cd('build.js')], { stdio: 'inherit' });
});

if (failed) {
  process.stdout.write('\n✗ verify failed\n');
  process.exit(1);
}
process.stdout.write('\n✓ verify passed\n');
