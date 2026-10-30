// tests/library-scroll-performance.test.js
//
// Regression guard for library scroll performance.
//
// Scrolling the library list used to do work proportional to the number of
// *rendered* rows on every refresh tick:
//
//   - `getVisibleSongIds()` called `getBoundingClientRect()` on every
//     `.song-item` in the DOM. Each call is a forced layout read, so a
//     1000-row library paid 1000 layout reads per tick.
//   - `refreshVisibleSongItems()` then ran a second `querySelectorAll` over the
//     whole list and rebuilt two Maps of every song in the library.
//   - `refreshVisibleSongsMetadata()` resolved each visible id with
//     `getActiveSongs().find(...) || allSongs.find(...)` — O(songs × visible)
//     per tick.
//   - `updateSelectedCount()` walked the filtered list three times, and it ran
//     on every infinite-scroll batch although appending rows of the same
//     filtered list cannot change the counters.
//
// The fix routes the visible set through an IntersectionObserver (the browser
// does that math off the main thread), keeps a songId→element map for the
// rendered rows, memoises the song lookup, and makes the counter update a
// single pass that the infinite-scroll path can skip.
//
// The CSS half of the fix is `content-visibility: auto` on `.song-item`: the
// browser then skips layout and paint for off-screen rows. That is only safe
// with a `contain-intrinsic-size` that matches the real row height — a
// skipped row with the wrong intrinsic size makes the scroll height jump.
// The test derives the expected height from the CSS itself so the two cannot
// drift apart.
//
// downloader.js is a content-script IIFE that touches `document`/`chrome` at
// import time, so it cannot be imported by node:test. As in
// tests/panel-visibility.test.js, the behavioural tests below extract the real
// function source and execute it against minimal stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readDownloader = () => fs.readFile(path.join(ROOT, 'downloader.js'), 'utf8');
const readCss = () => fs.readFile(path.join(ROOT, 'content.css'), 'utf8');

// Brace-matched block extraction that skips strings and comments. A naive scan
// would stop at a `}` inside a template literal.
function extractBraceBlock(source, openIndex, what) {
  assert.notEqual(openIndex, -1, `expected a body brace for ${what}`);

  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i);
      assert.notEqual(i, -1, `unterminated block comment in ${what}`);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      assert.notEqual(i, source.length, `unterminated ${quote} literal in ${what}`);
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    i += 1;
  }
  throw new Error(`unbalanced braces while extracting ${what}`);
}

// Index of the `)` that closes the parameter list starting at `parenOpen`.
function findClosingParen(source, parenOpen, what) {
  let depth = 0;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  assert.fail(`unbalanced parentheses while extracting ${what}`);
}

// The body of `function name(...) { ... }`. The parameter list is skipped
// explicitly: a default value like `options = {}` contains braces, so simply
// looking for the next `{` would find the destructuring default instead.
function extractFunctionBody(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected downloader.js to contain ${what}`);
  const parenOpen = source.indexOf('(', at);
  const parenClose = findClosingParen(source, parenOpen, what);
  return extractBraceBlock(source, source.indexOf('{', parenClose), what);
}

// A whole call expression, e.g. `songList.addEventListener('scroll', ...)`.
function extractCall(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected downloader.js to contain ${what}`);
  const parenOpen = source.indexOf('(', at);
  const parenClose = findClosingParen(source, parenOpen, what);
  return source.slice(at, parenClose + 1);
}

// Comments often *describe* the old behaviour, which would satisfy a negative
// assertion for the wrong reason. Strip them before checking that a construct
// is absent.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Turn a real `function name(...) { ... }` declaration into a callable.
function loadFunction(source, name) {
  return new Function(`return (${loadFunctionSource(source, name)});`)();
}

// The source text of a real `function name(...) { ... }` declaration.
function loadFunctionSource(source, name) {
  const decl = new RegExp(`^\\s*function ${name}\\(`, 'm');
  const match = source.match(decl);
  assert.ok(match, `expected downloader.js to declare ${name}`);

  const start = source.indexOf('function ' + name, match.index);
  const parenOpen = source.indexOf('(', start);
  const parenClose = findClosingParen(source, parenOpen, name);
  const body = extractBraceBlock(source, source.indexOf('{', parenClose), name);
  return `${source.slice(start, parenClose + 1)}${body}`;
}

// ---------------------------------------------------------------------------
// The visible set must come from the observer, not from a layout scan
// ---------------------------------------------------------------------------

test('getVisibleSongIds reads the observer map instead of measuring every row', async () => {
  const source = await readDownloader();
  const fn = loadFunction(source, 'getVisibleSongIds');

  // The rect scan is the thing that cost one forced layout read per row.
  const scanCalls = [];
  const visibleSongItems = new Map([
    ['song-a', { id: 'song-a' }],
    ['song-b', { id: 'song-b' }],
  ]);

  const result = new Function(
    'isSongListVisible', 'visibleSongItems', 'visibleObserverHasReported', 'scanVisibleSongIdsByRect',
    `return (${fn.toString()})();`
  )(
    () => true,
    visibleSongItems,
    true,
    () => { scanCalls.push('scan'); return ['from-scan']; }
  );

  assert.deepEqual(result.sort(), ['song-a', 'song-b'],
    'the visible set must be the observer’s set');
  assert.deepEqual(scanCalls, [],
    'the rect scan must not run while the observer has reported rows');
});

test('getVisibleSongIds falls back to the rect scan only until the observer reports', async () => {
  const source = await readDownloader();
  const fn = loadFunction(source, 'getVisibleSongIds');

  // First frame after a render: the observer has not reported yet, so the old
  // behaviour is used rather than reporting "nothing visible".
  const beforeReport = new Function(
    'isSongListVisible', 'visibleSongItems', 'visibleObserverHasReported', 'scanVisibleSongIdsByRect',
    `return (${fn.toString()})();`
  )(() => true, new Map(), false, () => ['fallback']);

  assert.deepEqual(beforeReport, ['fallback'],
    'before the observer has reported, the rect scan must still answer');

  // Once the observer has proven itself, an empty set means "nothing visible"
  // and the expensive scan must stay off the scroll path.
  let scanned = 0;
  const afterReport = new Function(
    'isSongListVisible', 'visibleSongItems', 'visibleObserverHasReported', 'scanVisibleSongIdsByRect',
    `return (${fn.toString()})();`
  )(() => true, new Map(), true, () => { scanned += 1; return ['fallback']; });

  assert.deepEqual(afterReport, [],
    'a proven observer reporting nothing visible must not trigger the scan');
  assert.equal(scanned, 0, 'the rect scan must not run on the scroll path');
});

test('the visible observer uses the same 80px buffer the rect scan used', async () => {
  const source = await readDownloader();
  const observer = extractFunctionBody(source, 'function ensureSongListVisibleObserver()', 'the visible observer');

  assert.match(observer, /root:\s*songList/,
    'the observer must be rooted at the list, not the viewport');
  assert.match(observer, /rootMargin:\s*'80px 0px 80px 0px'/,
    'the 80px buffer must match the old getBoundingClientRect scan');
  assert.match(observer, /isIntersecting/,
    'the observer must drive the visible set from intersection state');
});

test('rendered rows are handed to the observer when they are appended', async () => {
  const source = await readDownloader();
  const chunk = extractFunctionBody(source, 'function renderSongListChunk(', 'renderSongListChunk');
  const factory = extractFunctionBody(source, 'function getOrCreateSongListItem(', 'getOrCreateSongListItem');

  assert.match(chunk, /getOrCreateSongListItem\(song, \{ allowThumbnails \}\)/,
    'appended rows must come from the shared element factory');
  assert.match(chunk, /renderedSongItems\.set\(song\.id, item\)/,
    'the rendered-rows map must be kept in sync with the DOM');
  assert.match(factory, /observeSongListItem\(/,
    'every row handed out by the factory must be observed, otherwise the visible set stays empty');
});

test('a row lookup does not scan the whole list any more', async () => {
  const source = await readDownloader();
  const refresh = extractFunctionBody(source, 'function refreshVisibleSongItems(', 'refreshVisibleSongItems');

  assert.ok(!/querySelectorAll/.test(stripComments(refresh)),
    'refreshVisibleSongItems must not walk the whole list on every scroll tick');
  assert.match(refresh, /renderedSongItems\.get\(songId\)/,
    'the rendered-rows map is the lookup');
  assert.match(refresh, /oldItem\.parentNode !== songList/,
    'a stale map entry must not be replaced into the list');
});

test('the visible metadata refresh does not linearly search the library per id', async () => {
  const source = await readDownloader();
  const refresh = extractFunctionBody(source, 'async function refreshVisibleSongsMetadata(', 'refreshVisibleSongsMetadata');

  assert.ok(!/getActiveSongs\(\)\.find\(/.test(stripComments(refresh)),
    'the old code did getActiveSongs().find(...) per visible id — O(songs × visible)');
  assert.ok(!/allSongs\.find\(/.test(stripComments(refresh)),
    'the old code did allSongs.find(...) per visible id — O(songs × visible)');
  assert.match(refresh, /songLookup\.get\(id\)/,
    'the lookup map must be used instead');
});

test('the song lookup map is rebuilt only when the collections are replaced', async () => {
  const source = await readDownloader();
  const lookup = extractFunctionBody(source, 'function getSongLookupMap()', 'getSongLookupMap');

  assert.match(lookup, /songLookupCache\.allSongsRef === allSongs/,
    'the cache must be keyed on the collection identity');
  assert.match(lookup, /songLookupCache\.playlistRef === playlistSongs/,
    'the cache must be keyed on the collection identity');
});

// ---------------------------------------------------------------------------
// The counter must be one pass, and the infinite-scroll path must skip it
// ---------------------------------------------------------------------------

test('updateSelectedCount walks the filtered list once', async () => {
  const source = await readDownloader();
  const fn = loadFunction(source, 'updateSelectedCount');

  const total = 500;
  const songs = Array.from({ length: total }, (_, i) => ({ id: `song-${i}` }));
  let hasCalls = 0;

  const stubs = {
    filteredSongs: songs,
    selectedSongIds: {
      size: 0,
      has(id) { hasCalls += 1; return false; }
    },
    cachedSongIds: { has() { return false; } },
    songCount: { set textContent(v) { this.value = v; } },
    selectAllButton: { setAttribute() {}, set textContent(v) { this.value = v; } },
    downloadBtn: null,
    cacheAllBtn: null,
    deleteCachedBtn: null,
    updatePlaylistActionButtons() {},
    isSongFromOtherArtist() { return false; }
  };

  const keys = Object.keys(stubs);
  new Function(...keys, `return (${fn.toString()})();`)(...keys.map(k => stubs[k]));

  assert.equal(hasCalls, total,
    `the counter must visit each song once, not three times (saw ${hasCalls} visits for ${total} songs)`);
});

test('the infinite-scroll path does not recompute the selection counters', async () => {
  const source = await readDownloader();
  const fn = loadFunction(source, 'renderSongListChunk');

  let countUpdates = 0;
  const songs = [{ id: 'a' }, { id: 'b' }];

  const run = (options) => {
    const renderedSongCount = 0;
    const songItemCache = new Map();
    const renderedSongItems = new Map();
    const stubs = {
      sortedFilteredSongs: songs,
      updateSelectedCount() { countUpdates += 1; },
      ensureSongListSentinel() {},
      renderedSongCount,
      songItemCache,
      getOrCreateSongListItem: (song) => ({ dataset: {}, songId: song.id }),
      renderedSongItems,
      document: { createDocumentFragment: () => ({ appendChild() {} }) },
      songList: { insertBefore() {} },
      songListSentinel: {},
      updateSongListSentinelState() {},
      SONG_RENDER_BATCH_SIZE: 40,
      // Thumbnail warm-ahead is exercised in tests/thumbnail-loader.test.js;
      // here it only has to be a no-op hook the chunk renderer can call.
      isSongListVisible: () => true,
      prefetchThumbnailsForSongs() {},
      THUMBNAIL_PREFETCH_AHEAD: 40
    };
    const keys = Object.keys(stubs);
    new Function(...keys, `return (${fn.toString()})(${options ? '40, ' + options : '40'});`)
      (...keys.map(k => stubs[k]));
  };

  run('{ updateCount: false }');
  assert.equal(countUpdates, 0,
    'appending rows of the same filtered list cannot change the counters, so the ' +
    'infinite-scroll path must not recompute them');

  run('{ updateCount: true }');
  assert.equal(countUpdates, 1,
    'the default path must still update the counters');
});

test('the scroll handler is passive and frame-throttled', async () => {
  const source = await readDownloader();
  const call = extractCall(source, "songList.addEventListener('scroll'", 'the scroll listener');

  assert.match(call, /passive:\s*true/,
    'the scroll listener must be passive');
  assert.match(call, /requestAnimationFrame/,
    'the scroll listener must be throttled to one call per frame');
});

// ---------------------------------------------------------------------------
// The list is reconciled, not rebuilt
// ---------------------------------------------------------------------------

// A minimal DOM. The repo has no dependencies ("the toolchain is pure Node"),
// so the reconciliation is exercised against this stub rather than a real DOM.
// It only implements what the shipped code touches: children, parentNode,
// dataset, textContent, appendChild/insertBefore/removeChild/replaceChild and
// a class-based querySelector.
function createDom() {
  function createNode(tagName, isFragment = false) {
    return {
      tagName,
      isFragment,
      children: [],
      parentNode: null,
      dataset: {},
      _text: '',
      get textContent() { return this._text; },
      set textContent(value) {
        this._text = value;
        if (value === '') {
          this.children.slice().forEach((child) => this.removeChild(child));
        }
      },
      appendChild(child) {
        // A DocumentFragment contributes its children, not itself.
        if (child.isFragment) {
          child.children.slice().forEach((grandChild) => this.appendChild(grandChild));
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        if (this.ops) this.ops.insert += 1;
        return child;
      },
      insertBefore(child, anchor) {
        if (child.isFragment) {
          child.children.slice().forEach((grandChild) => this.insertBefore(grandChild, anchor));
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        const index = anchor ? this.children.indexOf(anchor) : -1;
        if (index === -1) this.children.push(child);
        else this.children.splice(index, 0, child);
        if (this.ops) this.ops.insert += 1;
        return child;
      },
      removeChild(child) {
        if (child.isFragment) {
          child.children.slice().forEach((grandChild) => this.removeChild(grandChild));
          return child;
        }
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        if (this.ops && index !== -1) this.ops.remove += 1;
        return child;
      },
      replaceChild(newChild, oldChild) {
        const index = this.children.indexOf(oldChild);
        if (index === -1) return oldChild;
        if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
        newChild.parentNode = this;
        this.children[index] = newChild;
        oldChild.parentNode = null;
        if (this.ops) this.ops.replace += 1;
        return oldChild;
      },
      querySelector(selector) {
        const wanted = selector.replace(/^\./, '');
        const stack = [...this.children];
        while (stack.length) {
          const node = stack.shift();
          if (node.dataset && node.dataset.cls === wanted) return node;
          stack.unshift(...node.children);
        }
        return null;
      }
    };
  }

  return {
    createNode,
    createFragment: () => createNode('fragment', true)
  };
}

// Compose the real list-rendering functions into one scope and run them
// against a stubbed DOM. `renderSongList` is exercised as shipped, including
// the reconciliation, not a re-implementation of it.
function createListHarness(source) {
  const dom = createDom();
  const songList = dom.createNode('div');
  const songListSentinel = dom.createNode('div');
  songList.appendChild(songListSentinel);

  const state = {
    renderedSongCount: 0,
    created: [],
    observed: [],
    detached: [],
    // How much the list DOM was churned. The old implementation emptied the
    // whole list and re-appended every row on each render.
    domOps: { insert: 0, remove: 0, replace: 0 }
  };

  const songItemCache = new Map();
  const renderedSongItems = new Map();
  const visibleSongItems = new Map();

  songList.ops = state.domOps;

  const stubs = {
    songList,
    songListSentinel,
    document: {
      createDocumentFragment: () => dom.createFragment(),
      createElement: (tagName) => dom.createNode(tagName)
    },
    songItemCache,
    renderedSongItems,
    visibleSongItems,
    songListVisibleObserver: {
      observe(item) { state.observed.push(item); },
      unobserve(item) { state.detached.push(item); }
    },
    SONG_RENDER_BATCH_SIZE: 40,
    getSongItemRenderSignature: (song) => song.sig,
    createSongListItem: (song) => {
      state.created.push(song.id);
      const item = dom.createNode('div');
      item.dataset.songId = song.id;
      item.dataset.renderSignature = song.sig;
      // The thumbnail only changes when the image does — not when a count or a
      // title changes.
      item.dataset.thumbnailSignature = song.thumbSig || song.id;
      const thumb = dom.createNode('div');
      thumb.dataset.cls = 'song-thumbnail';
      item.appendChild(thumb);
      return item;
    },
    observeSongListItem: (item) => { state.observed.push(item); },
    ensureSongListSentinel() {},
    updateSongListSentinelState() {},
    updateSelectedCount() {},
    scheduleVisibleSongRefresh() {},
    getActiveSongs: () => [],
    filterOffline: { checked: false },
    cachedSongIds: new Set(),
    // The full render now needs one visibility check and the warm-ahead hook;
    // both are thumbnail concerns covered in tests/thumbnail-loader.test.js.
    isSongListVisible: () => true,
    prefetchThumbnailsForSongs() {},
    THUMBNAIL_PREFETCH_AHEAD: 40
  };

  const composed = ['detachRenderedSongItem', 'clearRenderedSongItems', 'getOrCreateSongListItem', 'renderSongList']
    .map(name => loadFunctionSource(source, name))
    .join('\n\n');

  // `sortedFilteredSongs` and `renderedSongCount` are locals of the real IIFE,
  // so they are declared here rather than injected as parameters — otherwise
  // reassigning them from the test would not be visible to the shipped code.
  const keys = Object.keys(stubs);
  const controller = new Function(
    ...keys,
    `
    let sortedFilteredSongs = [];
    let renderedSongCount = 0;
    ${composed}
    return {
      setSongs(songs) { sortedFilteredSongs = songs; },
      render(options) { renderSongList(options); },
      get renderedSongCount() { return renderedSongCount; }
    };
    `
  )(...keys.map(k => stubs[k]));

  return {
    state,
    stubs,
    songList,
    // The rows currently in the list DOM, in DOM order.
    rows: () => songList.children.filter(child => child.dataset && child.dataset.songId),
    // Render `songs` (each `{ id, sig }`) as the sorted list.
    render(songs, options = {}) {
      controller.setSongs(songs);
      controller.render(options);
    }
  };
}

test('a metadata-only change does not rebuild the rows that did not change', async () => {
  const source = await readDownloader();
  const harness = createListHarness(source);

  harness.render([
    { id: 'a', sig: 'a1' },
    { id: 'b', sig: 'b1' },
    { id: 'c', sig: 'c1' }
  ]);

  const before = harness.rows();
  assert.equal(before.length, 3);
  assert.deepEqual(harness.state.created, ['a', 'b', 'c']);

  // Capture the thumbnails before the re-render: a rebuild *moves* the
  // thumbnail element into the new row, so the old row no longer has one.
  const beforeThumbnails = before.map(row => row.querySelector('.song-thumbnail'));

  // Reset the counters in place — the list node holds a reference to this
  // object.
  harness.state.domOps.insert = 0;
  harness.state.domOps.remove = 0;
  harness.state.domOps.replace = 0;

  // Only 'b' changed — the metadata update path.
  harness.render([
    { id: 'a', sig: 'a1' },
    { id: 'b', sig: 'b2' },
    { id: 'c', sig: 'c1' }
  ]);

  const ops = harness.state.domOps;

  const after = harness.rows();
  assert.equal(after.length, 3, 'the list must still hold three rows');
  assert.deepEqual(after.map(row => row.dataset.songId), ['a', 'b', 'c'], 'the order must not change');

  assert.equal(after[0], before[0], 'an unchanged row must keep its element');
  assert.equal(after[2], before[2], 'an unchanged row must keep its element');
  assert.notEqual(after[1], before[1], 'the changed row must be rebuilt');

  assert.deepEqual(harness.state.created, ['a', 'b', 'c', 'b'],
    'only the changed row may be rebuilt — the old code re-stamped every row');

  // The rebuilt row keeps the old thumbnail element, so the cover art is not
  // requested again.
  assert.equal(after[1].querySelector('.song-thumbnail'), beforeThumbnails[1],
    'a rebuilt row must keep its thumbnail element');

  // And the list DOM itself must not be churned: the old implementation set
  // `songList.textContent = ''` and re-appended every row, which is O(rendered
  // rows) of DOM mutations for a list whose content had not changed.
  assert.ok(ops.remove <= 1,
    `a metadata-only change must not detach the list (${ops.remove} removals)`);
  assert.ok(ops.insert <= 1,
    `a metadata-only change must not re-insert the list (${ops.insert} insertions)`);
});

test('newly crawled songs are inserted without disturbing the rows below', async () => {
  const source = await readDownloader();
  const harness = createListHarness(source);

  harness.render([
    { id: 'a', sig: 'a1' },
    { id: 'b', sig: 'b1' }
  ]);
  const before = harness.rows();

  // A crawled page prepends newer songs.
  harness.render([
    { id: 'n1', sig: 'n1' },
    { id: 'n2', sig: 'n2' },
    { id: 'a', sig: 'a1' },
    { id: 'b', sig: 'b1' }
  ]);

  const after = harness.rows();
  assert.deepEqual(after.map(row => row.dataset.songId), ['n1', 'n2', 'a', 'b'],
    'the new songs must be in front');
  assert.equal(after[2], before[0], 'an existing row must keep its element');
  assert.equal(after[3], before[1], 'an existing row must keep its element');
  assert.deepEqual(harness.state.created, ['a', 'b', 'n1', 'n2'],
    'only the new songs may be created');
});

test('rows that leave the list are detached from it', async () => {
  const source = await readDownloader();
  const harness = createListHarness(source);

  harness.render([
    { id: 'a', sig: 'a1' },
    { id: 'b', sig: 'b1' },
    { id: 'c', sig: 'c1' }
  ]);
  const before = harness.rows();
  const removed = before[1];

  harness.render([
    { id: 'a', sig: 'a1' },
    { id: 'c', sig: 'c1' }
  ]);

  const after = harness.rows();
  assert.deepEqual(after.map(row => row.dataset.songId), ['a', 'c']);
  assert.equal(removed.parentNode, null, 'a row that left the list must be detached');
  assert.ok(harness.state.detached.includes(removed),
    'a row that left the list must be unobserved');
});

test('a re-render never renders fewer rows than before', async () => {
  const source = await readDownloader();
  const harness = createListHarness(source);

  const songs = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, sig: `s${i}` }));
  harness.render(songs, { minimumRenderCount: 100 });

  // The old chunk loop rounded up to whole batches of 40.
  assert.equal(harness.rows().length, 120,
    'a re-render must not shrink the rendered window');
});


// Return every declaration block that follows the given selector.
function cssBlocksFor(css, selector) {
  const blocks = [];
  let index = 0;
  while (true) {
    const at = css.indexOf(selector, index);
    if (at === -1) break;
    const open = css.indexOf('{', at);
    if (open === -1) break;
    blocks.push(extractBraceBlock(css, open, selector));
    index = at + selector.length;
  }
  return blocks;
}

function cssValue(block, property) {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([^;]+);`));
  return match ? match[1].replace('!important', '').trim() : null;
}

function px(value) {
  const match = value && value.match(/^([\d.]+)px/);
  return match ? Number(match[1]) : null;
}

test('off-screen library rows skip layout and paint', async () => {
  const css = await readCss();
  const itemBlocks = cssBlocksFor(css, '#bettersuno-panel .song-item');

  assert.ok(itemBlocks.length >= 2, 'expected desktop and mobile .song-item rules');

  const desktop = itemBlocks.find(block => cssValue(block, 'padding') === '10px 12px');
  assert.ok(desktop, 'expected the desktop .song-item rule with 10px 12px padding');

  assert.equal(cssValue(desktop, 'content-visibility'), 'auto',
    'off-screen rows must skip layout and paint');
  assert.ok(cssValue(desktop, 'contain-intrinsic-size'),
    'content-visibility without contain-intrinsic-size collapses a skipped row to zero height');
});

test('the intrinsic row height matches the real row height', async () => {
  const css = await readCss();
  const itemBlocks = cssBlocksFor(css, '#bettersuno-panel .song-item');
  const thumbBlocks = cssBlocksFor(css, '#bettersuno-panel .song-thumbnail');

  const desktopItem = itemBlocks.find(block => cssValue(block, 'padding') === '10px 12px');
  const mobileItem = itemBlocks.find(block => cssValue(block, 'padding') === '6px');
  const desktopThumb = thumbBlocks.find(block => px(cssValue(block, 'height')) === 44);
  const mobileThumb = thumbBlocks.find(block => px(cssValue(block, 'height')) === 80);

  assert.ok(desktopItem && mobileItem && desktopThumb && mobileThumb,
    'expected desktop and mobile rules for .song-item and .song-thumbnail');

  // The row height is driven by the thumbnail plus the item's vertical padding
  // and its bottom border. If the intrinsic size disagrees with that, the
  // scroll height changes as rows are rendered and the list jumps.
  const rowHeight = (item, thumb) => {
    const padding = cssValue(item, 'padding').split(/\s+/).map(px);
    // "10px 12px" is vertical 10px, horizontal 12px; "6px" is 6px all round.
    // Either way the vertical padding is the first value.
    const vertical = padding[0];
    const border = px(cssValue(item, 'border-bottom')) ?? 1;
    return px(cssValue(thumb, 'height')) + vertical * 2 + border;
  };

  const desktopExpected = rowHeight(desktopItem, desktopThumb);
  const mobileExpected = rowHeight(mobileItem, mobileThumb);

  assert.equal(px(cssValue(desktopItem, 'contain-intrinsic-size')), desktopExpected,
    `the desktop intrinsic height must be ${desktopExpected}px ` +
    '(44px thumbnail + 20px padding + 1px border) or the list jumps while scrolling');

  assert.equal(px(cssValue(mobileItem, 'contain-intrinsic-size')), mobileExpected,
    `the mobile intrinsic height must be ${mobileExpected}px ` +
    '(80px thumbnail + 12px padding + 1px border)');
});
