// tests/library-refresh.test.js
//
// Regression guard for the library "Refresh" path.
//
// The Refresh button (`syncNewBtn`, downloader.js) sends `fetch_songs` with
// `checkNewOnly: true` + `metadataRefreshIds`. background.js routes that to the
// metadata-refresh branch of `fetchSongsList`, whose only network primitive is
// `fetchLibraryPageWithRetry`. Everything downstream — mergeSongs, applyFilter,
// the chips, the Unplayed/Model filters — is fed by the clips that helper fetches.
//
// Real defect guarded here (found 2026-10-09): `fetchLibraryPageWithRetry`
// interpolated an *undeclared* `page` variable on all four of its retry log
// lines. A single network error / 429 / 401-403 page therefore threw
// `ReferenceError: page is not defined` out of the retry loop, before
// `notifyTab('songs_fetched')` was ever reached. The downloader's `currentFetchMode`
// stayed 'incremental', the list was never re-rendered, and from the user's side
// Refresh simply did nothing. Scrolling still worked, because the scroll path
// (`fetch_songs_by_ids` → `fetchFeedSongsByIds` → `fetchFeedV3WithRetry`) does not
// use that helper. That asymmetry is what made it confusing to diagnose.
//
// A source-level assertion is the honest guard here: the bug is a scoping error,
// so the test checks that every identifier interpolated in the retry log lines
// of that function is actually bound in its scope. A behavioural test would need
// the whole chrome/fetch harness for one-line failure mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Locate a top-level `async function <name>(...) { ... }` by brace matching, so
// the body is exact rather than a fuzzy slice that can drift from the source.
async function readTopLevelFunction(source, name) {
  const start = source.match(new RegExp(`^async function ${name}\\(`, 'm'));
  assert.ok(start, `expected background.js to declare ${name}`);
  const from = start.index;
  // Skip to the opening brace of the *body*: walk past the parameter list's
  // balanced parens, since `{ maxRetries = 5 } = {}` are defaults, not the body.
  const parenOpen = source.indexOf('(', from);
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
  assert.ok(open !== -1 && open < parenClose + 5,
    `expected ${name}'s body brace to follow its parameter list`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

test('fetchLibraryPageWithRetry only interpolates identifiers it declares', async (t) => {
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibraryPageWithRetry');

  const interpolated = [...fn.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
  assert.ok(interpolated.length >= 4,
    'the four retry log lines should each interpolate at least one identifier');

  // Every name that is bound anywhere in the function: parameter, destructured
  // default, const/let/var, or a function parameter of an inner closure is
  // not enough — we need names resolvable at each log site. Interpolation
  // happens inside the retry branches, so bindings declared later in the
  // loop are reachable only if the declaration precedes the log line.
  const paramNames = (fn.match(/\((?:[^()]|\([^()]*\))*\)/) || [''])[0]
    .split(/[(,)]/)
    .map(s => s.replace(/[{}[\]\s]/g, ''))
    .filter(Boolean);

  const declared = new Set([
    ...paramNames,
    ...[...fn.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    // destructured defaults: `{ a = 1, b: c = 2 }`
    ...[...fn.matchAll(/\b([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
  ]);

  const undeclared = [...new Set(interpolated)].filter(name => !declared.has(name));
  assert.deepEqual(undeclared, [],
    `undeclared identifier(s) interpolated in ${fn.slice(0, 40).trim()}... — ` +
    'a ReferenceError here aborts the page loop before songs_fetched is sent, ' +
    'so Refresh appears to do nothing');
});

test('fetchLibraryPageWithRetry names the page in each retry log', async () => {
  // The log text is the user-visible evidence of what went wrong. Keep the
  // retry reasons intact — the messages were written to be greppable.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibraryPageWithRetry');

  // The network-error and timeout branches share one log line that names the
  // failure kind, so both reasons stay distinguishable while both stay greppable.
  const expected = [
    "429 Too Many Requests on page",
    "401/403 received on page",
    "timeout' : 'network error'} on page",
  ];
  for (const fragment of expected) {
    assert.ok(fn.includes(fragment),
      `retry log should report "${fragment}" so a truncated crawl is diagnosable`);
  }
});

test('a page timeout is retired as a page failure, not rethrown as a user stop', () => {
  // The inner AbortController is only a 20s deadline for this one page. A user
  // stop arrives on the caller's `signal`. Conflating the two made fetchSongsList
  // return early: no cursor-fetch fallback, no message, stuck Stop button.
  const classify = (e, innerSignal, callerSignal) => {
    const callerStopped = !!callerSignal?.aborted;
    const timedOutOnThisPage = innerSignal.aborted && !callerStopped;
    return { callerStopped, timedOutOnThisPage, retryable: !callerStopped && (e instanceof TypeError || timedOutOnThisPage) };
  };

  // Page deadline hit, nobody asked to stop → must be retried, not thrown.
  const timeout = classify(new DOMException('Aborted', 'AbortError'), { aborted: true }, { aborted: false });
  assert.equal(timeout.callerStopped, false);
  assert.equal(timeout.timedOutOnThisPage, true);
  assert.equal(timeout.retryable, true);

  // Caller asked to stop → genuine stop, must propagate.
  const stopped = classify(new DOMException('Aborted', 'AbortError'), { aborted: true }, { aborted: true });
  assert.equal(stopped.callerStopped, true);
  assert.equal(stopped.retryable, false);

  // Plain network failure → retried.
  const network = classify(new TypeError('Failed to fetch'), { aborted: false }, { aborted: false });
  assert.equal(network.timedOutOnThisPage, false);
  assert.equal(network.retryable, true);
});

test('fetchLibrarySongsPaged streams per-page progress via onPage', async () => {
  // The metadata-refresh crawl used to send a single songs_fetched at the very
  // end and nothing before it: on a 500+ song library the panel showed three
  // log lines and then silence for the whole crawl, indistinguishable from a
  // stall. The paged helper now accepts an onPage hook so fetchSongsList can
  // forward per-page songs_page_update deltas while the crawl runs.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibrarySongsPaged');

  assert.ok(fn.includes('onPage'), 'fetchLibrarySongsPaged must accept an onPage option');
  assert.match(fn, /await onPage\(\{\s*page/,
    'onPage must be awaited with the page number so progress stays ordered');
  assert.ok(fn.includes('totalSongs'), 'onPage must report the running total');
  assert.ok(fn.includes('pageSongs'), 'onPage must hand over this page’s songs for streaming');
});

test('fetchLibrarySongsPaged progress reporting cannot break the crawl', async () => {
  // A throwing progress hook must not take down a library sync that is
  // otherwise healthy — the hook is UI reporting, not the fetch itself.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibrarySongsPaged');

  const callSite = fn.indexOf('await onPage(');
  assert.ok(callSite !== -1, 'expected an awaited onPage call');
  const tryStart = fn.lastIndexOf('try {', callSite);
  const catchAfter = fn.indexOf('catch', callSite);
  assert.ok(tryStart !== -1 && catchAfter !== -1 && tryStart < callSite && callSite < catchAfter,
    'the onPage call must sit inside try/catch so a reporting failure never aborts the crawl');
});

test('fetchLibrarySongsPaged dedupes replayed cursors across pages', () => {
  // If the API ever replays a cursor, the same clips would otherwise be pushed
  // once per repeated page — and mergeSongs only dedupes against the local
  // library, not within the payload, so the library itself would flood.
  const seenIds = new Set();
  const songs = [];
  const acceptPage = (clips) => {
    const pageSongs = [];
    for (const clip of clips) {
      if (!clip?.id || seenIds.has(clip.id)) continue;
      seenIds.add(clip.id);
      songs.push(clip);
      pageSongs.push(clip);
    }
    return pageSongs;
  };

  const page1 = acceptPage([{ id: 'a' }, { id: 'b' }]);
  // Replayed cursor: same clips again, plus one genuinely new song.
  const page2 = acceptPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

  assert.deepEqual(page1.map(s => s.id), ['a', 'b']);
  assert.deepEqual(page2.map(s => s.id), ['c'],
    'replayed clips must be dropped; only genuinely new ids stream');
  assert.deepEqual(songs.map(s => s.id), ['a', 'b', 'c']);
});

test('fetchLibrarySongsPaged only interpolates identifiers it declares', async () => {
  // Same scoping guard as fetchLibraryPageWithRetry: the paged loop builds an
  // Error from logPrefix, so that name must stay bound.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibrarySongsPaged');

  const interpolated = [...fn.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
  const declared = new Set([
    ...[...fn.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    ...[...fn.matchAll(/\b([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
  ]);

  const undeclared = [...new Set(interpolated)].filter(name => !declared.has(name));
  assert.deepEqual(undeclared, [],
    'undeclared identifier(s) interpolated in fetchLibrarySongsPaged');
});

test('fetchLibrarySongsPaged continues a crawl from an already-fetched page', async () => {
  // The bulk metadata-refresh call used to return null when truncated and the
  // paged crawl then re-fetched the very same 100 clips as page 1. For a 100+
  // song library that is a wasted request in front of the whole crawl, and it
  // runs before any progress is visible. The paged helper now takes the seed
  // page plus the cursor that follows it.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibrarySongsPaged');

  assert.ok(fn.includes('seedSongs'), 'fetchLibrarySongsPaged must accept a seedSongs option');
  assert.ok(fn.includes('startCursor'), 'fetchLibrarySongsPaged must accept the startCursor that follows the seed');
  assert.match(fn, /canSeed \? 2 : 1/,
    'a seeded crawl must start its fetch loop at page 2 — page 1 is the seed');
});

test('fetchLibrarySongsBulk hands its truncated page to the paged crawl', async () => {
  // The same seed path needs the bulk call to give up its null-only contract
  // when the caller opts in: a truncated page with a next cursor is returned
  // as { truncated, cursor, songs } so nothing is re-fetched. Callers that do
  // not opt in keep the null contract.
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');
  const fn = await readTopLevelFunction(source, 'fetchLibrarySongsBulk');

  assert.ok(fn.includes('reportTruncatedPage'), 'fetchLibrarySongsBulk must accept reportTruncatedPage');
  assert.match(fn, /reportTruncatedPage && data\?\.next_cursor != null/,
    'the truncated-page contract requires a real next cursor to continue from');
  assert.match(fn, /truncated: true/, 'a truncated page must be marked as such');
  assert.match(fn, /cursor: data\.next_cursor/, 'the seed must carry its next cursor');
});

test('seeded pages pass through the same dedupe and target gates as fetched pages', () => {
  // A seed is page 1 of the crawl, so it must obey exactly the rules a fetched
  // page obeys: no id seen twice, public-only filtering, and target-id
  // filtering. Otherwise a seed could inject records the crawl would reject.
  const seenIds = new Set();
  const songs = [];
  const targetIds = new Set(['a', 'c']);
  const isPublicOnly = true;

  const accept = (clip, isSeedPage) => {
    if (clip?.is_public === false && isPublicOnly) return false;
    if (seenIds.has(clip.id)) return false;
    if (!targetIds.has(clip.id)) return false;
    songs.push(clip);
    seenIds.add(clip.id);
    return true;
  };

  // Page 1 served as the bulk seed.
  accept({ id: 'a', is_public: true }, true);
  accept({ id: 'zzz', is_public: true }, true);   // outside targets
  accept({ id: 'private', is_public: false }, true);
  // Page 2 fetched by the crawl; 'a' replays from the cursor.
  accept({ id: 'a', is_public: true }, false);
  accept({ id: 'c', is_public: true }, false);

  assert.deepEqual(songs.map(s => s.id), ['a', 'c']);
  assert.deepEqual([...seenIds], ['a', 'c']);
});
