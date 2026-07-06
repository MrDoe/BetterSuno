(function initBetterSunoIDB() {
    if (window.BetterSunoIDB) {
        return;
    }

    const IDB_NAME = 'BetterSunoicationsDB';
    const IDB_VERSION = 3;
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
        const db = await getDB();
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const result = handler(store, transaction);

        if (mode === 'readwrite') {
            await transactionToPromise(transaction);
        }

        return result;
    }

    async function getDB() {
        if (dbInstance) return dbInstance;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_NAME, IDB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                dbInstance = request.result;
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

    async function saveAudioBlobToIDB(songId, blob) {
        try {
            await withObjectStore('audioCache', 'readwrite', (store) => {
                store.put({ songId, blob, timestamp: Date.now() });
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

    async function saveImageBlobToIDB(songId, blob) {
        try {
            await withObjectStore('imageCache', 'readwrite', (store) => {
                store.put({ songId, blob, timestamp: Date.now() });
            });
            scheduleEviction();
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

    async function deleteImageBlobFromIDB(songId) {
        try {
            await withObjectStore('imageCache', 'readwrite', (store) => {
                store.delete(songId);
            });
        } catch (e) {
            // ignore
        }
    }

    // ---- Blob eviction ----

    const AUDIO_BLOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const IMAGE_BLOB_MAX_AGE_MS = 30 * 60 * 1000;
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

        for (const [storeName, maxAge] of [
            ['audioCache', AUDIO_BLOB_MAX_AGE_MS],
            ['imageCache', IMAGE_BLOB_MAX_AGE_MS],
        ]) {
            try {
                const records = await getAllRecordsFromStore(storeName);
                const stale = records
                    .filter(r => !r.timestamp || (now - r.timestamp) > maxAge)
                    .slice(0, EVICT_BATCH_SIZE);

                for (const r of stale) {
                    try {
                        if (storeName === 'audioCache') await deleteAudioBlobFromIDB(r.songId);
                        if (storeName === 'imageCache') await deleteImageBlobFromIDB(r.songId);
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
        const [songs, preferences, audioCache, imageCache] = await Promise.all([
            getAllRecordsFromStore('songsList'),
            getAllRecordsFromStore('userPreferences'),
            getAllRecordsFromStore('audioCache'),
            getAllRecordsFromStore('imageCache')
        ]);

        return estimateValueSize(songs) + estimateValueSize(preferences) + estimateValueSize(audioCache) + estimateValueSize(imageCache);
    }

    async function clearStore(storeName) {
        try {
            await withObjectStore(storeName, 'readwrite', (store) => {
                store.clear();
            });
        } catch (e) {
            console.error(`[IDB] Failed to clear store ${storeName}:`, e);
        }
    }

    window.BetterSunoIDB = {
        clearStore,
        deleteAudioBlobFromIDB,
        deleteImageBlobFromIDB,
        deletePreferenceFromIDB,
        estimateDbUsageBytes,
        evictStaleBlobs,
        evictBySize,
        getAllCachedSongIdsFromIDB,
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