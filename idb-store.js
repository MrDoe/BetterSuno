// idb-store.js — IndexedDB wrapper for persistent storage across browser sessions

const DB_NAME = 'BetterSunoicationsDB';
const DB_VERSION = 2;

let dbInstance = null;

/**
 * Initialize IndexedDB and create/upgrade object stores
 */
async function initDB() {
  if (dbInstance) {
    return dbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[IDB] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      console.log('[IDB] Database initialized successfully');
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.log('[IDB] Upgrading database schema');

      // Create object stores
      if (!db.objectStoreNames.contains('tabStates')) {
        const tabStatesStore = db.createObjectStore('tabStates', { keyPath: 'tabId' });
        tabStatesStore.createIndex('enabled', 'enabled', { unique: false });
        tabStatesStore.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[IDB] Created tabStates store');
      }

      if (!db.objectStoreNames.contains('songsList')) {
        const songsStore = db.createObjectStore('songsList', { keyPath: 'id' });
        songsStore.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[IDB] Created songsList store');
      }

      if (!db.objectStoreNames.contains('userPreferences')) {
        const prefsStore = db.createObjectStore('userPreferences', { keyPath: 'key' });
        console.log('[IDB] Created userPreferences store');
      }

      if (!db.objectStoreNames.contains('audioCache')) {
        db.createObjectStore('audioCache', { keyPath: 'songId' });
        console.log('[IDB] Created audioCache store');
      }
    };
  });
}

/**
 * Get a specific tab state by tabId
 */
async function getTabState(tabId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tabStates', 'readonly');
    const store = transaction.objectStore('tabStates');
    const request = store.get(String(tabId));

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting tab state:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get all tab states
 */
async function getAllTabStates() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tabStates', 'readonly');
    const store = transaction.objectStore('tabStates');
    const request = store.getAll();

    request.onsuccess = () => {
      const states = {};
      (request.result || []).forEach(state => {
        states[state.tabId] = state;
      });
      resolve(states);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting all tab states:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Save a tab state
 */
async function saveTabState(tabId, state) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tabStates', 'readwrite');
    const store = transaction.objectStore('tabStates');
    
    const stateToSave = {
      ...state,
      tabId: String(tabId),
      timestamp: Date.now()
    };

    const request = store.put(stateToSave);

    request.onsuccess = () => {
      console.log('[IDB] Tab state saved for tabId:', tabId);
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error saving tab state:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Delete a tab state
 */
async function deleteTabState(tabId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tabStates', 'readwrite');
    const store = transaction.objectStore('tabStates');
    const request = store.delete(String(tabId));

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error deleting tab state:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all tab states
 */
async function clearAllTabStates() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('tabStates', 'readwrite');
    const store = transaction.objectStore('tabStates');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('[IDB] All tab states cleared');
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error clearing tab states:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Save songs list
 */
async function saveSongsList(songs) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('songsList', 'readwrite');
    const store = transaction.objectStore('songsList');

    // Clear existing songs first
    store.clear();

    // Add all songs
    songs.forEach(song => {
      const songData = {
        ...song,
        timestamp: Date.now()
      };
      store.add(songData);
    });

    transaction.oncomplete = () => {
      console.log('[IDB] Saved', songs.length, 'songs');
      resolve();
    };

    transaction.onerror = () => {
      console.error('[IDB] Error saving songs:', transaction.error);
      reject(transaction.error);
    };
  });
}

/**
 * Get all songs
 */
async function getAllSongs() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('songsList', 'readonly');
    const store = transaction.objectStore('songsList');
    const request = store.getAll();

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting songs:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all songs
 */
async function clearAllSongs() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('songsList', 'readwrite');
    const store = transaction.objectStore('songsList');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('[IDB] All songs cleared');
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error clearing songs:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Save a user preference
 */
async function savePreference(key, value) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('userPreferences', 'readwrite');
    const store = transaction.objectStore('userPreferences');

    const prefData = {
      key,
      value,
      timestamp: Date.now()
    };

    const request = store.put(prefData);

    request.onsuccess = () => {
      console.log('[IDB] Preference saved:', key);
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error saving preference:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get a user preference
 */
async function getPreference(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('userPreferences', 'readonly');
    const store = transaction.objectStore('userPreferences');
    const request = store.get(key);

    request.onsuccess = () => {
      resolve(request.result?.value || null);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting preference:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get all preferences
 */
async function getAllPreferences() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('userPreferences', 'readonly');
    const store = transaction.objectStore('userPreferences');
    const request = store.getAll();

    request.onsuccess = () => {
      const prefs = {};
      (request.result || []).forEach(pref => {
        prefs[pref.key] = pref.value;
      });
      resolve(prefs);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting all preferences:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Delete a preference
 */
async function deletePreference(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('userPreferences', 'readwrite');
    const store = transaction.objectStore('userPreferences');
    const request = store.delete(key);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error deleting preference:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all preferences
 */
async function clearAllPreferences() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('userPreferences', 'readwrite');
    const store = transaction.objectStore('userPreferences');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('[IDB] All preferences cleared');
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error clearing preferences:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Save an audio blob for a song
 */
async function saveAudioBlob(songId, blob) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioCache', 'readwrite');
    const store = transaction.objectStore('audioCache');

    const request = store.put({ songId, blob, timestamp: Date.now() });

    request.onsuccess = () => {
      console.log('[IDB] Audio blob saved for songId:', songId);
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error saving audio blob:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get a cached audio blob for a song
 */
async function getAudioBlob(songId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioCache', 'readonly');
    const store = transaction.objectStore('audioCache');
    const request = store.get(songId);

    request.onsuccess = () => {
      resolve(request.result?.blob || null);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting audio blob:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get all cached song IDs
 */
async function getAllCachedSongIds() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioCache', 'readonly');
    const store = transaction.objectStore('audioCache');
    const request = store.getAllKeys();

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = () => {
      console.error('[IDB] Error getting cached song IDs:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Delete a cached audio blob
 */
async function deleteAudioBlob(songId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioCache', 'readwrite');
    const store = transaction.objectStore('audioCache');
    const request = store.delete(songId);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error deleting audio blob:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all cached audio blobs
 */
async function clearAllAudioBlobs() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioCache', 'readwrite');
    const store = transaction.objectStore('audioCache');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('[IDB] All audio blobs cleared');
      resolve();
    };

    request.onerror = () => {
      console.error('[IDB] Error clearing audio blobs:', request.error);
      reject(request.error);
    };
  });
}

// ES6 exports for use in background.js and other modules
export {
  initDB,
  getTabState,
  getAllTabStates,
  saveTabState,
  deleteTabState,
  clearAllTabStates,
  saveSongsList,
  getAllSongs,
  clearAllSongs,
  savePreference,
  getPreference,
  getAllPreferences,
  deletePreference,
  clearAllPreferences,
  saveAudioBlob,
  getAudioBlob,
  getAllCachedSongIds,
  deleteAudioBlob,
  clearAllAudioBlobs
};
