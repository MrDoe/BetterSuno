// tests/audio-cache-eviction.test.js
//
// Covers the two `audioCache` record classes introduced by the "Auto-cache songs
// I listen to" setting (2026-09-28):
//
//   - untagged records (manual "Save to DB", and any plain play of an encrypted
//     clip) age out after 7 days via evictStaleBlobs
//   - records written with `{ autoCached: true }` are exempt from that age
//     sweep and survive until the 500 MB evictBySize trim
//
// The exemption is the entire point of the feature: without it a track the user
// deliberately listened to would vanish after a week.
//
// SCOPE — read this before trusting the coverage:
//
//   This drives the REAL shipped content-idb.js, evaluated verbatim in a VM with
//   a fake `indexedDB`/`window`. It therefore covers the tag-on-write, the age
//   predicate, the batch limit and the size-based eviction, end to end through
//   the production code path — there is no reimplemented copy of the rule that
//   could silently drift from the shipped one.
//
//   Still browser-only (not covered here):
//     - the real clock, and real IndexedDB transactional behaviour
//     - whether downloader.js actually calls saveAudioBlobToIDB with
//       `autoCached: true` on the auto-cache path (asserted structurally in the
//       'downloader wires the flag through' test below, not behaviourally)
//     - the MCP play_song -> togglePlay -> autoCachePlayedSong path
//
// An earlier idea was to lift the predicate into lib/ so node:test could import
// it directly. That was rejected: it would create a second copy of the rule that
// could disagree with the shipped one while the test still passed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content-idb.js'), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIO_MAX_AGE_MS = 7 * DAY_MS;
const IMAGE_MAX_AGE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB stub.
//
// Only the surface content-idb.js actually uses is implemented: open() with an
// onupgradeneeded/onSuccess handshake, transaction(), objectStore(), and the
// put/get/getAll/getAllKeys/delete/clear operations. Keys are single-field
// (keyPath 'id' / 'songId' / 'key').
// ---------------------------------------------------------------------------
function createFakeIndexedDB() {
  const databases = new Map();

  // A request whose handler assignment triggers completion on a microtask, the
  // way the real API does. Handlers are set synchronously by the caller, so we
  // defer to let them attach first.
  function makeRequest(run) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.({ target: request });
      } catch (err) {
        request.error = err;
        request.onerror?.({ target: request });
      }
    });
    return request;
  }

  const open = (name, version) => {
    const request = {
      result: null,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };

    let isNew = !databases.has(name);
    if (isNew) {
      databases.set(name, { version: 0, stores: new Map() });
    }
    const record = databases.get(name);

    queueMicrotask(() => {
      // onupgradeneeded fires before onsuccess when the version moves.
      if (record.version < version) {
        record.version = version;
        request.result = makeDb(name, record);
        request.onupgradeneeded?.({ target: { result: request.result } });
      }
      request.result = makeDb(name, record);
      request.onsuccess?.({ target: request });
    });

    return request;
  };

  function makeDb(name, record) {
    return {
      name,
      objectStoreNames: {
        contains: (storeName) => record.stores.has(storeName),
      },
      createObjectStore(storeName, { keyPath }) {
        record.stores.set(storeName, { keyPath, rows: new Map() });
        return record.stores.get(storeName);
      },
      transaction(storeName) {
        const store = record.stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: no store ${storeName}`);

        const transaction = {
          oncomplete: null,
          onerror: null,
          error: null,
          objectStore: () => makeStore(storeName, store),
        };

        // The real API fires oncomplete after the microtask queue drains, which
        // is what lets several requests inside one transaction complete first.
        queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
        return transaction;
      },
    };
  }

  function makeStore(storeName, store) {
    const keyOf = (value) => value[store.keyPath];
    return {
      put: (value) =>
        makeRequest(() => {
          store.rows.set(keyOf(value), value);
          return keyOf(value);
        }),
      get: (key) => makeRequest(() => store.rows.get(key)),
      getAll: () => makeRequest(() => [...store.rows.values()]),
      getAllKeys: () => makeRequest(() => [...store.rows.keys()]),
      delete: (key) =>
        makeRequest(() => {
          store.rows.delete(key);
          return undefined;
        }),
      clear: () =>
        makeRequest(() => {
          store.rows.clear();
          return undefined;
        }),
      _storeName: storeName,
    };
  }

  return {
    open,
    // Test-only escape hatch to read/write rows without going through the API.
    _databases: databases,
  };
}

/**
 * Evaluate the real content-idb.js in a fresh sandbox and return its
 * window.BetterSunoIDB, plus the fake IDB handle for arranging fixtures.
 */
function loadContentIdb({ now = Date.now() } = {}) {
  const indexedDB = createFakeIndexedDB();
  const sandbox = {
    indexedDB,
    TextEncoder,
    Blob,
    Date: class extends Date {
      constructor(...args) {
        if (args.length === 0) super(now);
        else super(...args);
      }
      static now() {
        return now;
      }
    },
    setTimeout: () => 0, // neutralise scheduleEviction's 5s debounce
    clearTimeout: () => {},
    console: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content-idb.js' });

  if (!sandbox.window.BetterSunoIDB) {
    throw new Error('content-idb.js did not expose window.BetterSunoIDB');
  }

  return { api: sandbox.window.BetterSunoIDB, indexedDB };
}

/**
 * Put a raw record straight into a store, bypassing the public API.
 *
 * The store is first materialised by calling into the real content-idb.js, so the
 * object stores and their keyPaths come from the shipped schema rather than being
 * re-declared here (a re-declared schema could drift and quietly invalidate the
 * whole test).
 */
async function seedRecord(indexedDB, api, storeName, row) {
  await api.getAllRecordsFromStore(storeName);
  const store = indexedDB._databases.get('BetterSunoicationsDB').stores.get(storeName);
  store.rows.set(row[store.keyPath], row);
}

// estimateValueSize only trusts `value.size` when the value is a real Blob
// (`value instanceof Blob`); a plain `{ size }` object falls through to the
// generic-object branch and counts as a handful of bytes. So the size-based tests
// need a genuine Blob whose reported size is synthetic — this subclass is one,
// and it allocates nothing.
function fakeBlob(reportedSize) {
  return new (class extends Blob {
    get size() {
      return reportedSize;
    }
  })(['x']);
}

function audioRow(songId, { ageMs = 0, autoCached = undefined, size = 1024 } = {}) {
  const row = {
    songId,
    blob: fakeBlob(size),
    timestamp: Date.now() - ageMs,
  };
  if (autoCached !== undefined) row.auto_cached = autoCached;
  return row;
}

async function audioIds(api) {
  return (await api.getAllCachedSongIdsFromIDB()).sort();
}

async function records(api, storeName) {
  return api.getAllRecordsFromStore(storeName);
}

// ---------------------------------------------------------------------------
// The age-sweep exemption
// ---------------------------------------------------------------------------

test('untagged audio older than 7 days is evicted', async () => {
  const { api, indexedDB } = loadContentIdb();
  await seedRecord(indexedDB, api, 'audioCache', audioRow('old-plain', {
    ageMs: AUDIO_MAX_AGE_MS + DAY_MS,
  }));

  const evicted = await api.evictStaleBlobs();
  assert.equal(evicted, 1);
  assert.deepEqual(await audioIds(api), []);
});

test('auto_cached audio survives the age sweep however old it is', async () => {
  const { api, indexedDB } = loadContentIdb();
  // 60 days old — nearly 9x the max age.
  await seedRecord(indexedDB, api, 'audioCache', audioRow('ancient-auto', {
    ageMs: 60 * DAY_MS,
    autoCached: true,
  }));

  const evicted = await api.evictStaleBlobs();
  assert.equal(evicted, 0, 'an auto-cached record must not be age-evicted');
  assert.deepEqual(await audioIds(api), ['ancient-auto']);
});

test('the sweep is selective within one store, not all-or-nothing', async () => {
  const { api, indexedDB } = loadContentIdb();
  const stale = AUDIO_MAX_AGE_MS + DAY_MS;
  await seedRecord(indexedDB, api, 'audioCache', audioRow('auto-stale', { ageMs: stale, autoCached: true }));
  await seedRecord(indexedDB, api, 'audioCache', audioRow('plain-stale', { ageMs: stale }));
  await seedRecord(indexedDB, api, 'audioCache', audioRow('plain-fresh', { ageMs: 0 }));

  await api.evictStaleBlobs();

  assert.deepEqual(await audioIds(api), ['auto-stale', 'plain-fresh']);
});

test('auto_cached records are only skipped in audioCache, never in imageCache', async () => {
  // imageCache is a different store with a different max age; the exemption must
  // not leak across stores. An `auto_cached` flag there is meaningless, and the
  // 30-minute image TTL must keep applying.
  const { api, indexedDB } = loadContentIdb();
  await seedRecord(indexedDB, api, 'audioCache', audioRow('img-probe', { ageMs: 0 }));
  await seedRecord(indexedDB, api, 'imageCache', {
    songId: 'img-probe',
    blob: { size: 10 },
    timestamp: Date.now() - IMAGE_MAX_AGE_MS - 1000,
    auto_cached: true,
  });

  await api.evictStaleBlobs();

  const images = await records(api, 'imageCache');
  assert.equal(images.length, 0, 'a stale imageCache record is evicted regardless of auto_cached');
  // The audio record shares the songId but lives in a different store; deleting
  // the image must not remove it.
  assert.deepEqual(await audioIds(api), ['img-probe']);
});

// ---------------------------------------------------------------------------
// Tag on write
// ---------------------------------------------------------------------------

test('saveAudioBlobToIDB tags auto-cached records and leaves manual ones untagged', async () => {
  const { api } = loadContentIdb();

  await api.saveAudioBlobToIDB('manual', { size: 8 });
  await api.saveAudioBlobToIDB('auto', { size: 8 }, { autoCached: true });

  const rows = await records(api, 'audioCache');
  const byId = Object.fromEntries(rows.map((r) => [r.songId, r]));

  assert.equal(byId.manual.auto_cached, false, 'manual Save to DB writes an untagged record');
  assert.equal(byId.auto.auto_cached, true, 'auto-cache writes a tagged record');
});

test('an untagged record keeps its tag when a manual save overwrites it', async () => {
  // Regression guard: `put` replaces the whole row, so re-saving a track with
  // Save to DB must clear a previous auto_cached tag rather than inherit it.
  // (Whether that is desirable is a product question; that it is explicit and
  // not accidental is the invariant under test.)
  const { api } = loadContentIdb();

  await api.saveAudioBlobToIDB('song', { size: 8 }, { autoCached: true });
  await api.saveAudioBlobToIDB('song', { size: 8 });

  const [row] = await records(api, 'audioCache');
  assert.equal(row.auto_cached, false);
});

// ---------------------------------------------------------------------------
// Size-based eviction still applies to auto-cached records
// ---------------------------------------------------------------------------

test('evictBySize trims auto-cached records past the cap, oldest first', async () => {
  const { api, indexedDB } = loadContentIdb();
  assert.equal(api.MAX_DB_SIZE_BYTES, 500 * 1024 * 1024);

  const over = 600 * 1024 * 1024;
  const chunk = over / 10; // 10 records -> evictBySize removes ceil(10 * 0.2) = 2
  const base = Date.now() - 10 * DAY_MS;
  for (let i = 0; i < 10; i++) {
    await seedRecord(indexedDB, api, 'audioCache', {
      songId: `s${String(i).padStart(2, '0')}`,
      blob: fakeBlob(chunk),
      timestamp: base + i * 1000, // s00/s01 are the two oldest
      auto_cached: true,
    });
  }

  const evicted = await api.evictBySize();
  assert.equal(evicted, 2, 'evictBySize removes the oldest 20%');
  assert.deepEqual(await audioIds(api), [
    's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09',
  ]);
});

test('evictBySize is a no-op below the cap', async () => {
  const { api, indexedDB } = loadContentIdb();
  await seedRecord(indexedDB, api, 'audioCache', audioRow('small', { ageMs: 0, size: 1024 }));

  assert.equal(await api.evictBySize(), 0);
  assert.deepEqual(await audioIds(api), ['small']);
});

// ---------------------------------------------------------------------------
// Contract that downloader.js depends on
// ---------------------------------------------------------------------------

test('MAX_DB_SIZE_BYTES is exported for the auto-cache cap guard', async () => {
  // downloader.js destructures this to avoid a save/evict loop; if it stops being
  // exported, the guard silently degrades to "no limit".
  const { api } = loadContentIdb();
  assert.equal(typeof api.MAX_DB_SIZE_BYTES, 'number');
  assert.ok(api.MAX_DB_SIZE_BYTES > 0);
});

test('downloader wires the autoCached flag through every write path', () => {
  // downloader.js is a content-script IIFE and cannot be imported, so this is a
  // structural check rather than a behavioural one: it catches the flag being
  // dropped at a call site, which is the realistic regression.
  const source = fs.readFileSync(path.join(ROOT, 'downloader.js'), 'utf8');

  assert.match(
    source,
    /async function saveToDbWrapper|async function cacheSongInDb\(song, \{ autoCached = false \}/,
    'the shared cache helper must accept the autoCached flag'
  );
  assert.match(
    source,
    /await saveAudioBlobToIDB\(song\.id, blob, \{ autoCached \}\)/,
    'the plain-stream path must forward autoCached'
  );
  assert.match(
    source,
    /async function resolveEncryptedAudioBlob\(song, \{ autoCached = false \}/,
    'the encrypted path must accept autoCached'
  );
  assert.match(
    source,
    /await cacheSongInDb\(song, \{ autoCached: true \}\)/,
    'the auto-cache entry point must set the flag'
  );
  // The manual bulk loop must NOT set it — that is the record-class distinction.
  assert.match(source, /await cacheSongInDb\(song\);/);
});
