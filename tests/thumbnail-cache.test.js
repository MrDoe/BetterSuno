// tests/thumbnail-cache.test.js
//
// Thumbnail cache storage (DB v4).
//
// Background: the library used to gate its IndexedDB thumbnail read on
// `cachedSongIds` (audio bakes only) and delete every image record after 30
// minutes. In practice almost every scroll re-downloaded its covers.
//
// The cache now has its own blob-free metadata store (`imageCacheMeta`) so the
// render path can decide hit/miss without reading blobs, and it is uncapped: no
// age sweep, no size cap. This file drives the REAL content-idb.js in a VM with
// a fake IndexedDB, so the shipped schema and write path are what is tested.
//
// Browser-only and not covered here: real IndexedDB transactional semantics,
// and whether downloader.js hydrates the in-memory index correctly (that lives
// in tests/thumbnail-loader.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content-idb.js'), 'utf8');
const THUMB_URL = 'https://cdn2.suno.ai/song-cover.jpeg?width=100';

function createFakeIndexedDB() {
  const databases = new Map();

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

  function makeDb(name, record) {
    return {
      name,
      objectStoreNames: {
        contains: (storeName) => record.stores.has(storeName),
      },
      createObjectStore(storeName, { keyPath }) {
        record.stores.set(storeName, { keyPath, rows: new Map() });
        return makeStore(storeName, record.stores.get(storeName));
      },
      transaction(storeNames) {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const name of names) {
          if (!record.stores.has(name)) {
            throw new Error(`NotFoundError: no store ${name}`);
          }
        }

        const transaction = {
          oncomplete: null,
          onerror: null,
          error: null,
          objectStore: (storeName) => {
            const store = record.stores.get(storeName);
            if (!store) throw new Error(`NotFoundError: no store ${storeName}`);
            return makeStore(storeName, store);
          },
        };

        queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
        return transaction;
      },
    };
  }

  const open = (name, version) => {
    const request = {
      result: null,
      error: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    };

    if (!databases.has(name)) {
      databases.set(name, { version: 0, stores: new Map() });
    }
    const record = databases.get(name);

    queueMicrotask(() => {
      if (record.version < version) {
        const oldVersion = record.version;
        record.version = version;
        request.result = makeDb(name, record);
        request.onupgradeneeded?.({ target: { result: request.result, transaction: request.result.transaction([...record.stores.keys()]) }, oldVersion });
      }
      request.result = makeDb(name, record);
      request.onsuccess?.({ target: request });
    });

    return request;
  };

  return { open, _databases: databases };
}

function loadContentIdb() {
  const indexedDB = createFakeIndexedDB();
  const sandbox = {
    indexedDB,
    TextEncoder,
    Blob,
    Date,
    setTimeout: () => 0,
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

function imageBlob(size) {
  return { size, type: 'image/jpeg' };
}

test('saveImageBlobToIDB writes the blob and a blob-free metadata record', async () => {
  const { api } = loadContentIdb();

  await api.saveImageBlobToIDB('song-1', imageBlob(1234), { url: THUMB_URL });

  const [meta] = await api.getAllImageCacheMeta();
  assert.equal(meta.songId, 'song-1');
  assert.equal(meta.url, THUMB_URL);
  assert.equal(meta.size, 1234);
  assert.equal(typeof meta.timestamp, 'number');
  assert.equal(meta.blob, undefined, 'metadata must never carry the blob');

  const blob = await api.getImageBlobFromIDB('song-1');
  assert.ok(blob, 'the blob is stored in imageCache');
  assert.equal(blob.size, 1234);
});

test('the stored record keeps its source URL so a changed cover is a miss', async () => {
  const { api } = loadContentIdb();

  await api.saveImageBlobToIDB('song-2', imageBlob(10), { url: 'https://cdn2.suno.ai/old.jpeg?width=100' });
  await api.saveImageBlobToIDB('song-2', imageBlob(20), { url: THUMB_URL });

  const [meta] = await api.getAllImageCacheMeta();
  assert.equal(meta.url, THUMB_URL, 'the newest URL replaces the old one');
  const blob = await api.getImageBlobFromIDB('song-2');
  assert.equal(blob.size, 20);
});

test('saveImageBlobToIDB stays callable without a URL (legacy call sites)', async () => {
  const { api } = loadContentIdb();

  await api.saveImageBlobToIDB('song-3', imageBlob(10));

  const [meta] = await api.getAllImageCacheMeta();
  assert.equal(meta.url, '');
});

test('deleteImageBlobFromIDB removes the blob and the metadata together', async () => {
  const { api } = loadContentIdb();
  await api.saveImageBlobToIDB('song-4', imageBlob(10), { url: THUMB_URL });

  await api.deleteImageBlobFromIDB('song-4');

  assert.equal(await api.getImageBlobFromIDB('song-4'), null);
  assert.deepEqual(await api.getAllImageCacheMeta(), []);
});

test('estimateImageCacheBytes sums metadata instead of reading blobs', async () => {
  const { api } = loadContentIdb();
  await api.saveImageBlobToIDB('a', imageBlob(100), { url: THUMB_URL });
  await api.saveImageBlobToIDB('b', imageBlob(250), { url: THUMB_URL });

  assert.equal(await api.estimateImageCacheBytes(), 350);
});

test('estimateDbUsageBytes includes thumbnails via the metadata sidecar', async () => {
  const { api } = loadContentIdb();
  await api.saveImageBlobToIDB('a', imageBlob(4096), { url: THUMB_URL });

  const total = await api.estimateDbUsageBytes();
  assert.ok(total >= 4096, `expected the image bytes to be counted, got ${total}`);
});

test('image records survive evictStaleBlobs at any age (uncapped by design)', async () => {
  const { api, indexedDB } = loadContentIdb();
  await api.saveImageBlobToIDB('old-cover', imageBlob(10), { url: THUMB_URL });

  // Backdate by two years and run the audio sweep.
  const store = indexedDB._databases.get('BetterSunoicationsDB').stores.get('imageCache');
  const record = store.rows.get('old-cover');
  record.timestamp = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
  store.rows.set('old-cover', record);

  await api.evictStaleBlobs();

  assert.ok(await api.getImageBlobFromIDB('old-cover'), 'thumbnails are not age-evicted');
  assert.equal((await api.getAllImageCacheMeta()).length, 1);
});

test('the database schema is v4 and creates both image stores', async () => {
  const { api, indexedDB } = loadContentIdb();
  // Touch the DB through the shipped API so the upgrade runs.
  await api.getAllImageCacheMeta();

  const record = indexedDB._databases.get('BetterSunoicationsDB');
  assert.equal(record.version, 4);
  assert.ok(record.stores.has('imageCache'));
  assert.ok(record.stores.has('imageCacheMeta'));
});

test('clearStore(imageCache) clears the metadata sidecar too', async () => {
  const { api } = loadContentIdb();
  await api.saveImageBlobToIDB('a', imageBlob(10), { url: THUMB_URL });

  await api.clearStore('imageCache');

  assert.equal(await api.getImageBlobFromIDB('a'), null);
  assert.deepEqual(await api.getAllImageCacheMeta(), [], 'stale metadata would fake a hit');
});

test('the public API exposes the metadata reader the renderer depends on', async () => {
  const { api } = loadContentIdb();
  assert.equal(typeof api.getAllImageCacheMeta, 'function');
  assert.equal(typeof api.estimateImageCacheBytes, 'function');
});
