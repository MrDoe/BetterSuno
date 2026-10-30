// tests/thumbnail-loader.test.js
//
// Behaviour of the library's thumbnail loader (downloader.js).
//
// The loader replaced the old "set <img src=remote> and hope" path: covers come
// from IndexedDB when possible, misses go through a bounded queue, visible rows
// jump that queue, and a failed fetch falls back to the direct URL exactly once.
//
// downloader.js is a content-script IIFE that touches document/chrome at import
// time, so the real state block and loader functions are extracted verbatim and
// executed in a VM with stubs — the same approach as
// tests/library-scroll-performance.test.js. No rule is re-implemented here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'downloader.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const STATE_BLOCK = sliceBetween(
  SOURCE,
  'const thumbnailMeta = new Map();',
  'let songListScrollRafPending'
);

const LOADER_BLOCK = sliceBetween(
  SOURCE,
  'function getThumbnailCacheKey(songId, url) {',
  'function normalizeReactionState(value) {'
);

const THUMB_URL = 'https://cdn2.suno.ai/cover.jpeg?width=100';
const IMAGE_BLOB = { size: 4200, type: 'image/jpeg' };

function createHarness({ mode = 'auto', saveData = false, visible = true } = {}) {
  const fetchCalls = [];
  const saved = [];
  const pending = [];
  const revoked = [];
  const blobs = new Map();
  let active = 0;
  let maxActive = 0;
  let blobSequence = 0;

  const sandbox = {
    SONG_RENDER_BATCH_SIZE: 40,
    renderedSongItems: new Map(),
    songList: {},
    navigator: saveData ? { connection: { saveData: true } } : {},
    console: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    setTimeout,
    clearTimeout,
    AbortController,
    URL: {
      createObjectURL: () => `blob:thumb-${++blobSequence}`,
      revokeObjectURL: (url) => revoked.push(url)
    },
    getImageBlobFromIDB: async (songId) => blobs.get(songId) || null,
    saveImageBlobToIDB: async (songId, blob, options = {}) => {
      saved.push({ songId, size: blob.size, url: options.url });
    },
    getSongThumbnailSource: (song) => song?.source || null,
    isSongListVisible: () => visible,
    fetch: (url) => {
      fetchCalls.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);

      if (mode === 'auto') {
        return Promise.resolve().then(() => {
          active -= 1;
          return { ok: true, status: 200, blob: async () => IMAGE_BLOB };
        });
      }

      const entry = { url, settled: false };
      const promise = new Promise((resolve, reject) => {
        entry.respondWithBlob = (blob = IMAGE_BLOB) => {
          entry.settled = true;
          active -= 1;
          resolve({ ok: true, status: 200, blob: async () => blob });
        };
        entry.respondWithStatus = (status) => {
          entry.settled = true;
          active -= 1;
          resolve({ ok: false, status, blob: async () => IMAGE_BLOB });
        };
        entry.fail = (error) => {
          entry.settled = true;
          active -= 1;
          reject(error || new Error('network down'));
        };
      });
      entry.promise = promise;
      pending.push(entry);
      return promise;
    }
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(
    [
      STATE_BLOCK,
      LOADER_BLOCK,
      `globalThis.__thumbApi = {
        requestThumbnailFetch,
        hydrateThumbnail,
        prefetchThumbnailsForSongs,
        getThumbnailObjectUrl,
        forgetThumbnail,
        clearThumbnailCacheState,
        getState: () => ({
          queue: thumbnailQueue,
          queuedKeys: thumbnailQueuedKeys,
          failed: thumbnailFailed,
          meta: thumbnailMeta,
          objectUrls: thumbnailObjectUrls,
          active: thumbnailActiveCount
        })
      };`
    ].join('\n'),
    sandbox,
    { filename: 'downloader-thumbnail-loader.js' }
  );

  return {
    api: sandbox.__thumbApi,
    sandbox,
    blobs,
    fetchCalls,
    saved,
    revoked,
    pending,
    getState: () => sandbox.__thumbApi.getState(),
    get maxActive() {
      return maxActive;
    },
    get active() {
      return active;
    }
  };
}

async function settle() {
  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function drain(harness) {
  // Failing a fetch releases its slot and starts the next queued job, so keep
  // draining until the whole queue is empty — otherwise the last job's 15s
  // timeout keeps the test process alive after the assertions.
  for (let round = 0; round < 50; round += 1) {
    const entries = harness.pending.splice(0);
    if (entries.length === 0) {
      return;
    }
    entries.forEach((entry) => {
      if (!entry.settled) entry.fail();
    });
    await settle();
  }
}

test('concurrent requests for the same song+URL share one fetch', async () => {
  const harness = createHarness({ mode: 'manual' });

  harness.api.requestThumbnailFetch('song-1', THUMB_URL);
  harness.api.requestThumbnailFetch('song-1', THUMB_URL);
  harness.api.requestThumbnailFetch('song-1', THUMB_URL);
  await settle();

  assert.equal(harness.fetchCalls.length, 1, 'only one network request');
  assert.equal(harness.getState().active, 1);

  await drain(harness);
});

test('the queue never opens more than six thumbnail requests at once', async () => {
  const harness = createHarness({ mode: 'manual' });

  for (let i = 0; i < 20; i += 1) {
    harness.api.requestThumbnailFetch(`song-${i}`, `${THUMB_URL}&i=${i}`);
  }
  await settle();

  assert.equal(harness.fetchCalls.length, 6);
  assert.equal(harness.maxActive, 6);

  harness.pending[0].respondWithBlob();
  await settle();
  assert.equal(harness.fetchCalls.length, 7, 'a finished job releases its slot');

  await drain(harness);
});

test('a row that becomes visible jumps the queue', async () => {
  const harness = createHarness({ mode: 'manual' });

  for (let i = 0; i < 8; i += 1) {
    harness.api.requestThumbnailFetch(`song-${i}`, `${THUMB_URL}&i=${i}`);
  }
  await settle();

  const state = harness.getState();
  assert.equal(state.queue.length, 2, '6 active, 2 waiting');
  const waiting = state.queue[1];
  assert.notEqual(state.queue[0].key, waiting.key);

  harness.api.requestThumbnailFetch(waiting.songId, waiting.url, { priority: 'visible' });

  const promoted = harness.getState().queue[0];
  assert.equal(promoted.key, waiting.key, 'the visible row is now first in line');

  await drain(harness);
});

test('a cached thumbnail is read from IndexedDB without touching the network', async () => {
  const harness = createHarness();
  harness.api.getState().meta.set('song-1', { url: THUMB_URL, size: IMAGE_BLOB.size, timestamp: Date.now() });
  harness.blobs.set('song-1', IMAGE_BLOB);

  harness.api.hydrateThumbnail({ id: 'song-1' }, { url: THUMB_URL, type: 'image' }, null);
  await settle();

  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.getState().objectUrls.size, 1, 'one object URL is created for the row');
});

test('a changed cover URL bypasses the stale record and fetches again', async () => {
  const harness = createHarness();
  harness.api.getState().meta.set('song-1', { url: `${THUMB_URL}&old=1`, size: 10, timestamp: Date.now() });
  harness.blobs.set('song-1', IMAGE_BLOB);

  harness.api.hydrateThumbnail({ id: 'song-1' }, { url: THUMB_URL, type: 'image' }, null);
  await settle();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0], THUMB_URL);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].url, THUMB_URL);
});

test('a successful fetch is persisted with its URL and cached in memory', async () => {
  const harness = createHarness();

  harness.api.requestThumbnailFetch('song-9', THUMB_URL);
  await settle();

  assert.deepEqual(harness.saved, [{ songId: 'song-9', size: IMAGE_BLOB.size, url: THUMB_URL }]);
  const state = harness.getState();
  assert.equal(state.meta.get('song-9').url, THUMB_URL);
  assert.equal(state.objectUrls.get('song-9').url, THUMB_URL);
});

test('a failed fetch is remembered and falls back without retrying', async () => {
  const harness = createHarness({ mode: 'manual' });

  harness.api.requestThumbnailFetch('song-2', THUMB_URL);
  await settle();
  harness.pending[0].fail();
  await settle();

  const state = harness.getState();
  assert.ok(state.failed.has(`song-2|${THUMB_URL}`));
  assert.equal(harness.saved.length, 0);

  harness.api.requestThumbnailFetch('song-2', THUMB_URL);
  await settle();
  assert.equal(harness.fetchCalls.length, 1, 'no retry loop for a broken cover');

  await drain(harness);
});

test('a non-OK response is treated as a failure, not cached', async () => {
  const harness = createHarness({ mode: 'manual' });

  harness.api.requestThumbnailFetch('song-3', THUMB_URL);
  await settle();
  harness.pending[0].respondWithStatus(404);
  await settle();

  assert.equal(harness.saved.length, 0);
  assert.ok(harness.getState().failed.has(`song-3|${THUMB_URL}`));
});

test('an oversized image is rejected instead of filling the DB', async () => {
  const harness = createHarness({ mode: 'manual' });

  harness.api.requestThumbnailFetch('song-4', THUMB_URL);
  await settle();
  harness.pending[0].respondWithBlob({ size: 2 * 1024 * 1024, type: 'image/jpeg' });
  await settle();

  assert.equal(harness.saved.length, 0);
  assert.ok(harness.getState().failed.has(`song-4|${THUMB_URL}`));
});

test('a known-bad cover goes straight to the direct URL, with no new fetch', async () => {
  const harness = createHarness();
  harness.api.getState().failed.add(`song-7|${THUMB_URL}`);

  harness.api.hydrateThumbnail({ id: 'song-7' }, { url: THUMB_URL, type: 'image' }, null);
  await settle();

  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.saved.length, 0);
});

test('hydration defers the network while the library is hidden, then runs on demand', async () => {
  const harness = createHarness();

  harness.api.hydrateThumbnail({ id: 'song-hidden' }, { url: THUMB_URL, type: 'image' }, null, { allowNetwork: false });
  await settle();
  assert.equal(harness.fetchCalls.length, 0, 'no cover download while the list is not on screen');

  harness.api.hydrateThumbnail({ id: 'song-hidden' }, { url: THUMB_URL, type: 'image' }, null, { allowNetwork: true });
  await settle();
  assert.equal(harness.fetchCalls.length, 1);
});

test('prefetch does nothing while the library is not visible', async () => {
  const harness = createHarness({ visible: false });

  harness.api.prefetchThumbnailsForSongs([
    { id: 'song-a', source: { url: THUMB_URL, type: 'image' } }
  ]);
  await settle();

  assert.equal(harness.fetchCalls.length, 0);
});

test('prefetch is skipped when the connection reports saveData', async () => {
  const harness = createHarness({ saveData: true });

  harness.api.prefetchThumbnailsForSongs([
    { id: 'song-5', source: { url: THUMB_URL, type: 'image' } },
    { id: 'song-6', source: { url: `${THUMB_URL}&six`, type: 'image' } }
  ]);
  await settle();

  assert.equal(harness.fetchCalls.length, 0);
});

test('prefetch ignores video thumbnails and songs without a cover', async () => {
  const harness = createHarness();

  harness.api.prefetchThumbnailsForSongs([
    { id: 'video-1', source: { url: 'https://cdn2.suno.ai/clip.mp4', type: 'video' } },
    { id: 'no-cover', source: null }
  ]);
  await settle();

  assert.equal(harness.fetchCalls.length, 0);
});

test('object URLs are bounded so a long scroll cannot leak blob handles', async () => {
  const harness = createHarness();
  const before = harness.sandbox.URL.createObjectURL;

  for (let i = 0; i < 305; i += 1) {
    harness.api.getThumbnailObjectUrl(`song-${i}`, `${THUMB_URL}&i=${i}`, IMAGE_BLOB);
  }

  assert.equal(harness.getState().objectUrls.size, 300);
  assert.equal(harness.revoked.length, 5);
  assert.equal(typeof before, 'function');
});

// ---------------------------------------------------------------------------
// Wiring guards. The loader only helps if the render path actually calls it and
// the old `cachedSongIds` gate does not come back.
// ---------------------------------------------------------------------------

test('createSongListItem hydrates every image row and no longer gates on audio cache', () => {
  const section = sliceBetween(SOURCE, 'function createSongListItem(song, options = {}) {', 'function renderSongListChunk(');

  assert.match(section, /hydrateThumbnail\(song, thumbnailSource, thumbnailImage,/);
  assert.doesNotMatch(section, /isCachedSong/);
  assert.doesNotMatch(section, /getImageBlobFromIDB\(song\.id\)/, 'blob reads belong to the loader');
});

test('the first render does not assign a remote URL before the cache lookup', () => {
  const section = sliceBetween(SOURCE, 'function createSongListItem(song, options = {}) {', 'function renderSongListChunk(');
  assert.doesNotMatch(section, /thumbnailImage\.src = src/);
});

test('infinite scroll prefetches the next batch', () => {
  const section = sliceBetween(SOURCE, 'function renderSongListChunk(', 'function refreshVisibleSongSelectionState');

  assert.match(
    section,
    /prefetchThumbnailsForSongs\(sortedFilteredSongs\.slice\(end, end \+ THUMBNAIL_PREFETCH_AHEAD\)\)/
  );
});

test('the visibility observer promotes rows to the front of the queue', () => {
  const section = sliceBetween(SOURCE, 'function ensureSongListVisibleObserver() {', 'function observeSongListItem(');

  assert.match(section, /requestThumbnailFetch\(songId, source\.url, \{ priority: 'visible' \}\)/);
});
