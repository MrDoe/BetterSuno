#!/usr/bin/env node
// build.js — Generates browser-specific extension packages in dist/chrome and dist/firefox
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const DIST = path.join(SRC, 'dist');

// Files to copy into each build (relative to project root)
const SHARED_FILES = [
  'background.js',
  'content.js',
  'content-idb.js',
  'content.css',
  'content-fetcher.js',
  'downloader.js',
  'idb-store.js',
  'idb-helpers.js',
  'LICENSE',
  'README.md',
];

const CHROME_ONLY_FILES = [
  'offscreen.html',
  'offscreen.js',
];

const ICON_DIR = 'icons';

function rimraf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function buildManifest(browser) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

  if (browser === 'chrome') {
    // Chrome: use service_worker, remove scripts, keep offscreen permission
    if (manifest.background) {
      manifest.background.service_worker = 'background.js';
      delete manifest.background.scripts;
    }
    delete manifest.browser_specific_settings;
  } else {
    // Firefox: use scripts, remove service_worker, remove offscreen permission
    if (manifest.background) {
      delete manifest.background.service_worker;
      manifest.background.scripts = ['background.js'];
    }
    manifest.permissions = manifest.permissions.filter(p => p !== 'offscreen');
  }

  return manifest;
}

function build(browser) {
  const destDir = path.join(DIST, browser);
  rimraf(destDir);
  mkdirp(destDir);

  // Copy shared files
  for (const file of SHARED_FILES) {
    const src = path.join(SRC, file);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(destDir, file));
    }
  }

  // Copy Chrome-only files
  if (browser === 'chrome') {
    for (const file of CHROME_ONLY_FILES) {
      const src = path.join(SRC, file);
      if (fs.existsSync(src)) {
        copyFile(src, path.join(destDir, file));
      }
    }
  }

  // Copy icons
  const iconSrc = path.join(SRC, ICON_DIR);
  if (fs.existsSync(iconSrc)) {
    copyDir(iconSrc, path.join(destDir, ICON_DIR));
  }

  // Write browser-specific manifest
  const manifest = buildManifest(browser);
  fs.writeFileSync(
    path.join(destDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  console.log(`✓ Built ${browser} extension → dist/${browser}/`);
}

// CLI: node build.js [chrome|firefox]
// No argument builds both.
const target = process.argv[2];

if (target && !['chrome', 'firefox'].includes(target)) {
  console.error(`Unknown target "${target}". Use: node build.js [chrome|firefox]`);
  process.exit(1);
}

if (!target) rimraf(DIST);

if (!target || target === 'chrome') build('chrome');
if (!target || target === 'firefox') build('firefox');

console.log('\nDone. Load the extension from dist/chrome/ or dist/firefox/');
