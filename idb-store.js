// idb-store.js — IndexedDB wrapper for persistent storage across browser sessions

import { requestToPromise, withStore } from './idb-helpers.js';

const DB_NAME = 'BetterSunoicationsDB';
const DB_VERSION = 3;

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

    request.onblocked = () => {
      // Another connection (e.g., content script) is open at a lower version.
      // We cannot proceed until it closes; reject so callers can retry later.
      console.warn('[IDB] Database upgrade blocked by another connection');
      reject(new Error('IDB upgrade blocked'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      // Close our connection if a newer version is requested by the content script
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
        console.log('[IDB] Database connection closed due to version change');
      };
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

      if (!db.objectStoreNames.contains('imageCache')) {
        db.createObjectStore('imageCache', { keyPath: 'songId' });
        console.log('[IDB] Created imageCache store');
      }
    };
  });
}

/**
 * Get a specific tab state by tabId
 */
async function getTabState(tabId) {
  try {
    return await withStore(initDB, 'tabStates', 'readonly', (store) => {
      return requestToPromise(store.get(String(tabId)), (result) => result || null);
    });
  } catch (error) {
    console.error('[IDB] Error getting tab state:', error);
    throw error;
  }
}

/**
 * Get all tab states
 */
async function getAllTabStates() {
  try {
    return await withStore(initDB, 'tabStates', 'readonly', (store) => {
      return requestToPromise(store.getAll(), (result) => {
        const states = {};
        (result || []).forEach(state => {
          states[state.tabId] = state;
        });
        return states;
      });
    });
  } catch (error) {
    console.error('[IDB] Error getting all tab states:', error);
    throw error;
  }
}

/**
 * Save a tab state
 */
async function saveTabState(tabId, state) {
  const stateToSave = {
    ...state,
    tabId: String(tabId),
    timestamp: Date.now()
  };

  try {
    await withStore(initDB, 'tabStates', 'readwrite', (store) => {
      store.put(stateToSave);
    });
    console.log('[IDB] Tab state saved for tabId:', tabId);
  } catch (error) {
    console.error('[IDB] Error saving tab state:', error);
    throw error;
  }
}

/**
 * Delete a tab state
 */
async function deleteTabState(tabId) {
  try {
    await withStore(initDB, 'tabStates', 'readwrite', (store) => {
      store.delete(String(tabId));
    });
  } catch (error) {
    console.error('[IDB] Error deleting tab state:', error);
    throw error;
  }
}

/**
 * Clear all tab states
 */
async function clearAllTabStates() {
  try {
    await withStore(initDB, 'tabStates', 'readwrite', (store) => {
      store.clear();
    });
    console.log('[IDB] All tab states cleared');
  } catch (error) {
    console.error('[IDB] Error clearing tab states:', error);
    throw error;
  }
}

/**
 * Save songs list
 */
async function saveSongsList(songs) {
  try {
    await withStore(initDB, 'songsList', 'readwrite', (store) => {
      store.clear();

      songs.forEach(song => {
        const songData = {
          ...song,
          timestamp: Date.now()
        };
        store.add(songData);
      });
    });
    console.log('[IDB] Saved', songs.length, 'songs');
  } catch (error) {
    console.error('[IDB] Error saving songs:', error);
    throw error;
  }
}

/**
 * Get all songs
 */
async function getAllSongs() {
  try {
    return await withStore(initDB, 'songsList', 'readonly', (store) => {
      return requestToPromise(store.getAll(), (result) => result || []);
    });
  } catch (error) {
    console.error('[IDB] Error getting songs:', error);
    throw error;
  }
}

/**
 * Clear all songs
 */
async function clearAllSongs() {
  try {
    await withStore(initDB, 'songsList', 'readwrite', (store) => {
      store.clear();
    });
    console.log('[IDB] All songs cleared');
  } catch (error) {
    console.error('[IDB] Error clearing songs:', error);
    throw error;
  }
}

/**
 * Save a user preference
 */
async function savePreference(key, value) {
  const prefData = {
    key,
    value,
    timestamp: Date.now()
  };

  try {
    await withStore(initDB, 'userPreferences', 'readwrite', (store) => {
      store.put(prefData);
    });
    console.log('[IDB] Preference saved:', key);
  } catch (error) {
    console.error('[IDB] Error saving preference:', error);
    throw error;
  }
}

/**
 * Get a user preference
 */
async function getPreference(key) {
  try {
    return await withStore(initDB, 'userPreferences', 'readonly', (store) => {
      return requestToPromise(store.get(key), (result) => result?.value || null);
    });
  } catch (error) {
    console.error('[IDB] Error getting preference:', error);
    throw error;
  }
}

/**
 * Get all preferences
 */
async function getAllPreferences() {
  try {
    return await withStore(initDB, 'userPreferences', 'readonly', (store) => {
      return requestToPromise(store.getAll(), (result) => {
        const prefs = {};
        (result || []).forEach(pref => {
          prefs[pref.key] = pref.value;
        });
        return prefs;
      });
    });
  } catch (error) {
    console.error('[IDB] Error getting all preferences:', error);
    throw error;
  }
}

/**
 * Delete a preference
 */
async function deletePreference(key) {
  try {
    await withStore(initDB, 'userPreferences', 'readwrite', (store) => {
      store.delete(key);
    });
  } catch (error) {
    console.error('[IDB] Error deleting preference:', error);
    throw error;
  }
}

/**
 * Clear all preferences
 */
async function clearAllPreferences() {
  try {
    await withStore(initDB, 'userPreferences', 'readwrite', (store) => {
      store.clear();
    });
    console.log('[IDB] All preferences cleared');
  } catch (error) {
    console.error('[IDB] Error clearing preferences:', error);
    throw error;
  }
}

/**
 * Save an audio blob for a song
 */
async function saveAudioBlob(songId, blob) {
  try {
    await withStore(initDB, 'audioCache', 'readwrite', (store) => {
      store.put({ songId, blob, timestamp: Date.now() });
    });
    console.log('[IDB] Audio blob saved for songId:', songId);
  } catch (error) {
    console.error('[IDB] Error saving audio blob:', error);
    throw error;
  }
}

/**
 * Get a cached audio blob for a song
 */
async function getAudioBlob(songId) {
  try {
    return await withStore(initDB, 'audioCache', 'readonly', (store) => {
      return requestToPromise(store.get(songId), (result) => result?.blob || null);
    });
  } catch (error) {
    console.error('[IDB] Error getting audio blob:', error);
    throw error;
  }
}

/**
 * Get all cached song IDs
 */
async function getAllCachedSongIds() {
  try {
    return await withStore(initDB, 'audioCache', 'readonly', (store) => {
      return requestToPromise(store.getAllKeys(), (result) => result || []);
    });
  } catch (error) {
    console.error('[IDB] Error getting cached song IDs:', error);
    throw error;
  }
}

/**
 * Delete a cached audio blob
 */
async function deleteAudioBlob(songId) {
  try {
    await withStore(initDB, 'audioCache', 'readwrite', (store) => {
      store.delete(songId);
    });
  } catch (error) {
    console.error('[IDB] Error deleting audio blob:', error);
    throw error;
  }
}

/**
 * Clear all cached audio blobs
 */
async function clearAllAudioBlobs() {
  try {
    await withStore(initDB, 'audioCache', 'readwrite', (store) => {
      store.clear();
    });
    console.log('[IDB] All audio blobs cleared');
  } catch (error) {
    console.error('[IDB] Error clearing audio blobs:', error);
    throw error;
  }
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
