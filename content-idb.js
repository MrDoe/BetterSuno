(function initBetterSunoIDB() {
    if (window.BetterSunoIDB) {
        return;
    }

    const IDB_NAME = 'BetterSunoicationsDB';
    // v4 adds `imageCacheMeta`, a blob-free sidecar for the thumbnail cache so
    // rendering and eviction can read cache state without deserialising every
    // image blob. Both IDB wrappers (content-idb.js / idb-store.js) must agree
    // on this number: a lower version in the background would fail to open the
    // DB after a tab upgraded it.
    const IDB_VERSION = 4;
    const textEncoder = new TextEncoder();
    let dbInstance = null;

    function requestToPromise(request, mapResult = (result) => result) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(mapResult(request.result));
            request.onerror = () => reject(request.error);
        });
    }

    function transactionToPromise(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async function withObjectStore(storeName, mode, handler) {
        return withObjectStores([storeName], mode, (...stores) => handler(stores[0]));
    }

    // Multi-store transactions are what make the image blob and its metadata
    // sidecar appear/disappear together instead of drifting on a crash.
    async function withObjectStores(storeNames, mode, handler) {
        const db = await getDB();
        const transaction = db.transaction(storeNames, mode);
        const stores = storeNames.map((name) => transaction.objectStore(name));
        const result = handler(...stores);

        if (mode === 'readwrite') {
            await transactionToPromise(transaction);
        }

        return result;
    }

    async function getDB() {
        if (dbInstance) return dbInstance;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_NAME, IDB_VERSION);
            let settled = false;
            // A tab left open across an extension update still holds the old
            // version (v3 had no onversionchange handler), which blocks this
            // open indefinitely. Fail the call after a bounded wait so the panel
            // can still render; a later success still fills dbInstance.
            const openTimeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('IndexedDB open timed out — another Suno tab may still hold an older database version; reload that tab'));
            }, 10000);

            request.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(openTimeout);
                reject(request.error);
            };
            request.onblocked = () => {
                console.warn('[IDB] Upgrade blocked by another context holding an older version');
            };
            request.onsuccess = () => {
                dbInstance = request.result;
                // A tab left open across an extension update holds the old
                // version and would block every other context's upgrade forever.
                // Close instead; the next access reopens at the current version.
                dbInstance.onversionchange = () => {
                    try { dbInstance.close(); } catch (e) {}
                    dbInstance = null;
                };
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(openTimeout);
                resolve(dbInstance);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('songsList')) {
                    db.createObjectStore('songsList', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('userPreferences')) {
                    db.createObjectStore('userPreferences', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('audioCache')) {
                    db.createObjectStore('audioCache', { keyPath: 'songId' });
                }
                if (!db.objectStoreNames.contains('imageCache')) {
                    db.createObjectStore('imageCache', { keyPath: 'songId' });
                }
                if (!db.objectStoreNames.contains('imageCacheMeta')) {
                    db.createObjectStore('imageCacheMeta', { keyPath: 'songId' });
                }

                // v3 image records are 64px thumbnails with a 30-minute TTL and
                // no source URL, so they can never match the URL-keyed lookup
                // below. Drop them once instead of carrying dead blobs in an
                // uncapped cache.
                if (event.oldVersion > 0 && event.oldVersion < 4 && db.objectStoreNames.contains('imageCache')) {
                    try {
                        event.target.transaction.objectStore('imageCache').clear();
                    } catch (e) {
                        // non-fatal: stale records are simply ignored by the lookup
                    }
                }
            };
        });
    }

    async function saveSongsToIDB(songs) {
        try {
            await withObjectStore('songsList', 'readwrite', (store) => {
                // Keep existing songs by updating/inserting only; do not clear the song database.
                songs.forEach(song => {
                    store.put({ ...song, timestamp: Date.now() });
                });
            });
        } catch (e) {
            console.error('[IDB] Failed to save songs:', e);
        }
    }

    async function loadSongsFromIDB() {
        try {
            return await withObjectStore('songsList', 'readonly', (store) => {
                return requestToPromise(store.getAll(), (result) => result || []);
            });
        } catch (e) {
            console.error('[IDB] Failed to load songs:', e);
            return [];
        }
    }

    async function savePreferenceToIDB(key, value) {
        try {
            await withObjectStore('userPreferences', 'readwrite', (store) => {
                store.put({
                    key,
                    value,
                    timestamp: Date.now()
                });
            });
        } catch (e) {
            console.error('[IDB] Failed to save preference:', e);
        }
    }

    async function loadPreferenceFromIDB(key) {
        try {
            return await withObjectStore('userPreferences', 'readonly', (store) => {
                return requestToPromise(store.get(key), (result) => result?.value || null);
            });
        } catch (e) {
            console.error('[IDB] Failed to load preference:', e);
            return null;
        }
    }

    async function deletePreferenceFromIDB(key) {
        try {
            await withObjectStore('userPreferences', 'readwrite', (store) => {
                store.delete(key);
            });
        } catch (e) {
            console.error('[IDB] Failed to delete preference:', e);
        }
    }

    // `autoCached` marks a record that was cached because the user listened to the
    // song (Settings > "Auto-cache songs I listen to"). Such records survive the age
    // based sweep in evictStaleBlobs, because auto-caching exists precisely to keep
    // those tracks around; they are still removable by the size cap and by the UI.
    async function saveAudioBlobToIDB(songId, blob, { autoCached = false } = {}) {
        try {
            await withObjectStore('audioCache', 'readwrite', (store) => {
                store.put({ songId, blob, timestamp: Date.now(), auto_cached: autoCached === true });
            });
            scheduleEviction();
        } catch (e) {
            console.error('[IDB] Failed to save audio blob:', e);
        }
    }

    async function getAudioBlobFromIDB(songId) {
        try {
            return await withObjectStore('audioCache', 'readonly', (store) => {
                return requestToPromise(store.get(songId), (result) => result?.blob || null);
            });
        } catch (e) {
            console.error('[IDB] Failed to get audio blob:', e);
            return null;
        }
    }

    async function getAllCachedSongIdsFromIDB() {
        try {
            return await withObjectStore('audioCache', 'readonly', (store) => {
                return requestToPromise(store.getAllKeys(), (result) => result || []);
            });
        } catch (e) {
            console.error('[IDB] Failed to get cached song IDs:', e);
            return [];
        }
    }

    async function deleteAudioBlobFromIDB(songId) {
        try {
            await withObjectStore('audioCache', 'readwrite', (store) => {
                store.delete(songId);
            });
        } catch (e) {
            console.error('[IDB] Failed to delete audio blob:', e);
            throw e;
        }
    }

    // Thumbnail cache record = blob (imageCache) + blob-free metadata
    // (imageCacheMeta). The metadata carries the source URL so a regenerated
    // cover can never be served from an older blob: a hit requires an exact URL
    // match, otherwise it is a miss and the record is replaced.
    //
    // There is deliberately NO age or size cap by default. Thumbnails are a few
    // KB each and are the difference between a smooth library scroll and a
    // network race on every row. `Delete from DB` / `Delete Library` remain the
    // explicit ways to reclaim the space.
    async function saveImageBlobToIDB(songId, blob, { url = '' } = {}) {
        try {
            const timestamp = Date.now();
            const size = Number.isFinite(blob?.size) ? blob.size : 0;
            await withObjectStores(['imageCache', 'imageCacheMeta'], 'readwrite', (imageStore, metaStore) => {
                imageStore.put({ songId, blob, url, timestamp });
                metaStore.put({ songId, url, size, timestamp });
            });
        } catch (e) {
            console.error('[IDB] Failed to save image blob:', e);
        }
    }

    async function getImageBlobFromIDB(songId) {
        try {
            return await withObjectStore('imageCache', 'readonly', (store) => {
                return requestToPromise(store.get(songId), (result) => result?.blob || null);
            });
        } catch (e) {
            return null;
        }
    }

    // All thumbnail cache metadata, without touching a single blob. Used by the
    // library renderer to decide hit/miss synchronously and by the usage display.
    async function getAllImageCacheMeta() {
        try {
            return await withObjectStore('imageCacheMeta', 'readonly', (store) => {
                return requestToPromise(store.getAll(), (result) => result || []);
            });
        } catch (e) {
            return [];
        }
    }

    async function estimateImageCacheBytes() {
        const records = await getAllImageCacheMeta();
        return records.reduce((total, record) => {
            const size = Number(record?.size);
            return total + (Number.isFinite(size) && size > 0 ? size : 0);
        }, 0);
    }

    async function deleteImageBlobFromIDB(songId) {
        try {
            await withObjectStores(['imageCache', 'imageCacheMeta'], 'readwrite', (imageStore, metaStore) => {
                imageStore.delete(songId);
                metaStore.delete(songId);
            });
        } catch (e) {
            // ignore
        }
    }

    // ---- Blob eviction ----

    const AUDIO_BLOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_DB_SIZE_BYTES = 500 * 1024 * 1024;
    const EVICT_BATCH_SIZE = 100;

    let evictionTimer = null;

    function scheduleEviction() {
        if (evictionTimer) return;
        evictionTimer = setTimeout(() => {
            evictionTimer = null;
            evictStaleBlobs();
            evictBySize();
        }, 5000);
    }

    async function evictStaleBlobs() {
        const now = Date.now();
        let evicted = 0;

        // audioCache only. The thumbnail cache is intentionally uncapped and has
        // no age sweep: evicting a 5KB cover is never worth a re-download, and
        // the old 30-minute image TTL meant the cache rarely survived a scroll.
        for (const [storeName, maxAge] of [
            ['audioCache', AUDIO_BLOB_MAX_AGE_MS],
        ]) {
            try {
                const records = await getAllRecordsFromStore(storeName);
                const stale = records
                    // `auto_cached` audio is exempt from the age sweep - see
                    // saveAudioBlobToIDB. Size eviction still applies to it.
                    .filter(r => {
                        if (storeName === 'audioCache' && r.auto_cached === true) return false;
                        return !r.timestamp || (now - r.timestamp) > maxAge;
                    })
                    .slice(0, EVICT_BATCH_SIZE);

                for (const r of stale) {
                    try {
                        if (storeName === 'audioCache') await deleteAudioBlobFromIDB(r.songId);
                        evicted++;
                    } catch (e) {
                        // skip individual failures
                    }
                }
            } catch (e) {
                console.error(`[IDB] Eviction failed for ${storeName}:`, e);
            }
        }

        if (evicted > 0) {
            console.log(`[IDB] Evicted ${evicted} stale blob(s)`);
        }
        return evicted;
    }

    async function evictBySize() {
        try {
            const totalBytes = await estimateDbUsageBytes();
            if (totalBytes < MAX_DB_SIZE_BYTES) return 0;

            const records = await getAllRecordsFromStore('audioCache');
            records.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            const toEvict = records.slice(0, Math.ceil(records.length * 0.2));
            for (const r of toEvict) {
                try {
                    await deleteAudioBlobFromIDB(r.songId);
                } catch (e) {
                    // skip individual failures
                }
            }
            console.log(`[IDB] Evicted ${toEvict.length} blob(s) by size (${totalBytes} bytes > ${MAX_DB_SIZE_BYTES} limit)`);
            return toEvict.length;
        } catch (e) {
            console.error('[IDB] Size eviction failed:', e);
            return 0;
        }
    }

    async function getAllRecordsFromStore(storeName) {
        try {
            return await withObjectStore(storeName, 'readonly', (store) => {
                return requestToPromise(store.getAll(), (result) => result || []);
            });
        } catch (e) {
            console.error(`[IDB] Failed to read store ${storeName}:`, e);
            return [];
        }
    }

    function estimateValueSize(value, visited = new WeakSet()) {
        if (value == null) {
            return 0;
        }

        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            return value.size;
        }

        if (typeof value === 'string') {
            return textEncoder.encode(value).length;
        }

        if (typeof value === 'number') {
            return 8;
        }

        if (typeof value === 'boolean') {
            return 4;
        }

        if (value instanceof Date) {
            return 8;
        }

        if (value instanceof ArrayBuffer) {
            return value.byteLength;
        }

        if (ArrayBuffer.isView(value)) {
            return value.byteLength;
        }

        if (Array.isArray(value)) {
            return value.reduce((total, item) => total + estimateValueSize(item, visited), 0);
        }

        if (typeof value === 'object') {
            if (visited.has(value)) {
                return 0;
            }
            visited.add(value);

            let total = 0;
            for (const [key, nestedValue] of Object.entries(value)) {
                total += textEncoder.encode(key).length;
                total += estimateValueSize(nestedValue, visited);
            }
            return total;
        }

        return 0;
    }

    async function estimateDbUsageBytes() {
        const [songs, preferences, audioCache, imageBytes] = await Promise.all([
            getAllRecordsFromStore('songsList'),
            getAllRecordsFromStore('userPreferences'),
            getAllRecordsFromStore('audioCache'),
            // Blob-free: the metadata sidecar already carries every image size.
            estimateImageCacheBytes()
        ]);

        return estimateValueSize(songs) + estimateValueSize(preferences) + estimateValueSize(audioCache) + imageBytes;
    }

    async function clearStore(storeName) {
        try {
            // Clearing the image blobs without the metadata would leave the
            // renderer believing the covers are still cached.
            const storeNames = storeName === 'imageCache'
                ? ['imageCache', 'imageCacheMeta']
                : [storeName];
            await withObjectStores(storeNames, 'readwrite', (...stores) => {
                stores.forEach((store) => store.clear());
            });
        } catch (e) {
            console.error(`[IDB] Failed to clear store ${storeName}:`, e);
        }
    }

    window.BetterSunoIDB = {
        MAX_DB_SIZE_BYTES,
        clearStore,
        deleteAudioBlobFromIDB,
        deleteImageBlobFromIDB,
        deletePreferenceFromIDB,
        estimateDbUsageBytes,
        estimateImageCacheBytes,
        evictStaleBlobs,
        evictBySize,
        getAllCachedSongIdsFromIDB,
        getAllImageCacheMeta,
        getAudioBlobFromIDB,
        getImageBlobFromIDB,
        getAllRecordsFromStore,
        loadPreferenceFromIDB,
        loadSongsFromIDB,
        saveAudioBlobToIDB,
        saveImageBlobToIDB,
        savePreferenceToIDB,
        saveSongsToIDB
    };
})();