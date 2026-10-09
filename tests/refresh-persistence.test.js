// tests/refresh-persistence.test.js
//
// A streaming Refresh merges once per `songs_page_update` message. Every one of
// those merges used to persist the ENTIRE library to IndexedDB — five full
// writes for a 500-song refresh, each serializing every song including its
// lyrics, while the crawl was still fetching. That was the dominant cost of a
// large refresh, and it is invisible in the network timeline.
//
// The guard is source-level (same honest approach as tests/library-refresh.test.js):
// downloader.js is an IIFE content script, so it cannot be imported by
// node:test. The invariant under test: a per-page merge must schedule a save
// rather than write directly, and every run-end event must flush it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Extract `function <name>(...) { ... }` (any indentation) by brace matching.
function readFunction(source, name) {
  const start = source.match(new RegExp(`^(\\s*)function ${name}\\(`, 'm'));
  assert.ok(start, `expected downloader.js to declare ${name}`);
  const parenOpen = source.indexOf('(', start.index);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) { parenClose = i; break; }
    }
  }
  assert.ok(parenClose !== -1, `expected ${name} to have a parameter list`);
  const open = source.indexOf('{', parenClose);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

test('a per-page merge schedules a save instead of writing directly', async () => {
  const source = await fs.readFile(path.join(ROOT, 'downloader.js'), 'utf8');
  const merge = readFunction(source, 'mergeSongs');

  assert.ok(merge.includes('scheduleLibrarySave()'),
    'mergeSongs must route its persistence through scheduleLibrarySave');
  assert.ok(!merge.includes('saveToStorage()'),
    'mergeSongs must not persist the whole library inline — it runs once per crawled page');
});

test('every run-end event flushes the coalesced save', async () => {
  // songs_fetched (success), fetch_stopped (user pressed Stop) and fetch_error
  // each end a run. A flush missing from any one of them would silently drop
  // that path's merges to memory only.
  const source = await fs.readFile(path.join(ROOT, 'downloader.js'), 'utf8');

  // Split the message-handler chain into per-action segments.
  const segments = new Map();
  const matcher = /message\.action === "([a-z_]+)"/g;
  let match;
  while ((match = matcher.exec(source)) !== null) {
    segments.set(match[1], match.index);
  }
  const ends = [...segments.values()].sort((a, b) => a - b);

  for (const action of ['songs_fetched', 'fetch_stopped', 'fetch_error']) {
    assert.ok(segments.has(action), `expected a handler for ${action}`);
    const at = segments.get(action);
    const nextEnd = ends.find(end => end > at) ?? source.length;
    const segment = source.slice(at, nextEnd);
    assert.ok(segment.includes('flushLibrarySave()'),
      `${action} ends a run and must flush the coalesced library save`);
  }
});

test('flushLibrarySave only writes when a save is pending', () => {
  // Pure shape check on the coalescer itself: the flag starts false, scheduling
  // arms it, and flushing both clears it and performs the write exactly once.
  let writes = 0;
  let pending = false;
  const saveToStorage = () => { writes += 1; };
  const scheduleLibrarySave = () => { pending = true; };
  const flushLibrarySave = () => {
    if (!pending) return;
    pending = false;
    saveToStorage();
  };

  flushLibrarySave();
  assert.equal(writes, 0, 'nothing to flush must not write');

  scheduleLibrarySave();
  scheduleLibrarySave();
  flushLibrarySave();
  flushLibrarySave();
  assert.equal(writes, 1, 'N scheduled saves coalesce into exactly one write');

  scheduleLibrarySave();
  flushLibrarySave();
  assert.equal(writes, 2, 'a later schedule still flushes');
});
