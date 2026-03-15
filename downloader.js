// downloader.js — popup.js adapted as a content script for the Library tab panel
// Runs after content.js has injected the panel DOM.
// Uses IndexedDB for persistent storage across browser sessions

(function initDownloader() {
    const api = (typeof browser !== 'undefined') ? browser : chrome;

    let allSongs = [];
    let filteredSongs = [];
    let currentPlayingSongId = null;
    let cachedSongIds = new Set();
    let currentBlobUrl = null;
    let isCachingAll = false;
    let stopCachingRequested = false;

    // ========================================================================
    // Audio Player
    // ========================================================================
    const miniPlayer = document.getElementById('bettersuno-mini-player');
    const audioElement = document.getElementById('bettersuno-audio-element');
    const playPauseBtn = document.getElementById('player-play-pause');
    const playerTitle = document.getElementById('player-song-title');
    const progressBar = document.getElementById('player-progress-bar');
    const playerTime = document.getElementById('player-time');

    async function togglePlay(song) {
        if (!song || !song.audio_url) return;

        if (currentPlayingSongId === song.id) {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '▪';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
        } else {
            // Remember the previous blob URL so we can revoke it after switching sources
            const prevBlobUrl = currentBlobUrl;
            currentBlobUrl = null;

            currentPlayingSongId = song.id;

            // Use cached audio if available, otherwise stream online
            const cachedBlob = await getAudioBlobFromIDB(song.id);
            if (cachedBlob) {
                currentBlobUrl = URL.createObjectURL(cachedBlob);
                audioElement.src = currentBlobUrl;
            } else {
                audioElement.src = song.audio_url;
            }

            // Revoke the previous blob URL now that the audio element has moved to the new source
            if (prevBlobUrl) {
                URL.revokeObjectURL(prevBlobUrl);
            }

            audioElement.play();
            miniPlayer.style.display = 'block';
            playerTitle.textContent = song.title || 'Untitled';
            playPauseBtn.textContent = '▪';
            
            // Re-render list to show active state
            renderSongList();
        }
    }

    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '▪';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
            renderSongList();
        });
    }

    if (audioElement) {
        audioElement.addEventListener('timeupdate', () => {
            const percent = (audioElement.currentTime / audioElement.duration) * 100;
            progressBar.style.width = `${percent}%`;
            
            const mins = Math.floor(audioElement.currentTime / 60);
            const secs = Math.floor(audioElement.currentTime % 60).toString().padStart(2, '0');
            playerTime.textContent = `${mins}:${secs}`;
        });

        audioElement.addEventListener('play', () => {
            renderSongList();
        });

        audioElement.addEventListener('pause', () => {
            renderSongList();
        });

        audioElement.addEventListener('ended', () => {
            playPauseBtn.textContent = '▶';
            renderSongList();
        });
    }

    // ========================================================================
    // IndexedDB Helper Functions
    // ========================================================================
    
    const IDB_NAME = 'BetterSunoicationsDB';
    const IDB_VERSION = 2;
    let dbInstance = null;

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
            };
        });
    }

    async function saveSongsToIDB(songs) {
        try {
            const db = await getDB();
            const tx = db.transaction('songsList', 'readwrite');
            const store = tx.objectStore('songsList');
            store.clear();
            
            songs.forEach(song => {
                store.add({ ...song, timestamp: Date.now() });
            });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save songs:', e);
        }
    }

    async function loadSongsFromIDB() {
        try {
            const db = await getDB();
            const tx = db.transaction('songsList', 'readonly');
            const store = tx.objectStore('songsList');
            const request = store.getAll();
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to load songs:', e);
            return [];
        }
    }

    async function savePreferenceToIDB(key, value) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readwrite');
            const store = tx.objectStore('userPreferences');
            store.put({
                key,
                value,
                timestamp: Date.now()
            });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save preference:', e);
        }
    }

    async function loadPreferenceFromIDB(key) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readonly');
            const store = tx.objectStore('userPreferences');
            const request = store.get(key);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result?.value || null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to load preference:', e);
            return null;
        }
    }

    async function deletePreferenceFromIDB(key) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readwrite');
            const store = tx.objectStore('userPreferences');
            store.delete(key);
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to delete preference:', e);
        }
    }

    async function saveAudioBlobToIDB(songId, blob) {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readwrite');
            const store = tx.objectStore('audioCache');
            store.put({ songId, blob, timestamp: Date.now() });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save audio blob:', e);
        }
    }

    async function getAudioBlobFromIDB(songId) {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readonly');
            const store = tx.objectStore('audioCache');
            const request = store.get(songId);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result?.blob || null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to get audio blob:', e);
            return null;
        }
    }

    async function getAllCachedSongIdsFromIDB() {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readonly');
            const store = tx.objectStore('audioCache');
            const request = store.getAllKeys();
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to get cached song IDs:', e);
            return [];
        }
    }

    // ========================================================================
    // DOM Elements
    // ========================================================================

    const statusDiv = document.getElementById("status");
    const folderInput = document.getElementById("folder");
    function getSelectedFormat() {
        const el = document.querySelector('input[name="format"]:checked');
        return el ? el.value : 'mp3';
    }
    const formatRadios = document.querySelectorAll('input[name="format"]');
    
    // Default settings (no longer in UI)
    const maxPages = 0; // 0 = unlimited
    const isPublicOnly = false; // fetch all songs
    const downloadBtn = document.getElementById("downloadBtn");
    const stopDownloadBtn = document.getElementById("stopDownloadBtn");
    const stopFetchBtn = document.getElementById("bettersuno-stop-fetch-btn");
    const cacheAllBtn = document.getElementById("cacheAllBtn");
    const stopCacheBtn = document.getElementById("stopCacheBtn");
    const filterInput = document.getElementById("filterInput");
    const filterLiked = document.getElementById("filterLiked");
    const filterStems = document.getElementById("filterStems");
    const filterPublic = document.getElementById("filterPublic");
    const selectAllCheckbox = document.getElementById("selectAll");
    const downloadMusicCheckbox = document.getElementById("downloadMusic");
    const downloadLyricsCheckbox = document.getElementById("downloadLyrics");
    const downloadImageCheckbox = document.getElementById("downloadImage");
    const songList = document.getElementById("songList");
    const songCount = document.getElementById("songCount");
    const songListContainer = document.getElementById("songListContainer");
    const versionFooter = document.getElementById("versionFooter");

    // hide stop-fetch button initially
    if (stopFetchBtn) {
        stopFetchBtn.style.display = 'none';
    }

    function setFetchUiState(active) {
        if (stopFetchBtn) {
            stopFetchBtn.style.display = active ? 'inline-block' : 'none';
        }
    }

    function setCachingUiState(active) {
        if (cacheAllBtn) {
            cacheAllBtn.disabled = active;
            cacheAllBtn.textContent = active ? 'Caching...' : '💾 Cache All Songs';
        }
        if (stopCacheBtn) {
            stopCacheBtn.classList.toggle('hidden', !active);
        }
    }

    try {
        const version = api.runtime.getManifest()?.version;
        if (versionFooter && version) {
            versionFooter.textContent = `v${version}`;
        }
    } catch (e) {
        if (versionFooter) {
            versionFooter.textContent = "v?";
        }
    }

    // Load from storage on startup
    loadFromStorage();

    // Save format preference when changed
    formatRadios.forEach(r => r.addEventListener("change", async () => {
        await savePreferenceToIDB('sunoFormat', getSelectedFormat());
    }));

    // Save folder preference when changed
    folderInput.addEventListener("change", () => {
        saveToStorage();
    });

    // Check if fetching is in progress
    checkFetchState();

    // Check if downloading is in progress (important when popup is reopened)
    checkDownloadState();

    function setDownloadUiState(isRunning) {
        if (isRunning) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = "Downloading...";
            stopDownloadBtn.classList.remove("hidden");
        } else {
            downloadBtn.disabled = false;
            downloadBtn.textContent = "Download Selected";
            stopDownloadBtn.classList.add("hidden");
        }
    }

    async function checkFetchState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_fetch_state" });
            if (response && response.isFetching) {
                statusDiv.innerText = "Fetching in progress...";
            }
        } catch (e) {
            // Ignore errors (e.g., no response)
        }
    }

    function startAutoFetch() {
        // confirm before fetching entire list
        const proceed = confirm("BetterSuno will fetch your complete song list from Suno. It may take some time. Continue?");
        if (!proceed) {
            statusDiv.innerText = "Fetch cancelled.";
            console.log('[Downloader] User cancelled song list fetch');
            return;
        }

        statusDiv.innerText = "Fetching songs...";
        console.log('[Downloader] Starting auto fetch...');
        try {
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: isPublicOnly,
                maxPages: maxPages
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Message error:', chrome.runtime.lastError);
                    statusDiv.innerText = "Fetching songs in background...";
                } else if (response && response.error) {
                    console.error('[Downloader] Fetch songs error:', response.error);
                    statusDiv.innerText = response.error;
                } else {
                    console.log('[Downloader] Fetch request sent successfully');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not send fetch request:', e.message);
            statusDiv.innerText = "Fetching songs in background...";
        }
    }

    async function checkDownloadState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_download_state" });
            if (response && response.isDownloading) {
                setDownloadUiState(true);
                statusDiv.innerText = "Download in progress...";
            }
        } catch (e) {
            // Ignore errors
        }
    }

    async function loadFromStorage() {
        try {
            console.log('[Downloader] Loading songs from IndexedDB...');
            // Load songs and cached audio IDs from IndexedDB in parallel
            const [savedSongs, savedFormat, savedSongsMeta, cachedIds] = await Promise.all([
                loadSongsFromIDB(),
                loadPreferenceFromIDB('sunoFormat'),
                loadPreferenceFromIDB('sunoSongsList'),
                getAllCachedSongIdsFromIDB()
            ]);

            cachedSongIds = new Set(cachedIds);
            console.log('[Downloader] Loaded', savedSongs?.length || 0, 'songs,', cachedSongIds.size, 'cached audio blobs from IndexedDB');

            // Load saved format preference first
            if (savedFormat) {
                const radio = document.querySelector(`input[name="format"][value="${savedFormat}"]`);
                if (radio) radio.checked = true;
            }
            
            if (savedSongs && savedSongs.length > 0) {
                allSongs = savedSongs;
                filteredSongs = [...allSongs];

                // Restore settings from metadata
                if (savedSongsMeta) {
                    if (savedSongsMeta.folder) folderInput.value = savedSongsMeta.folder;
                    if (savedSongsMeta.format) {
                        const radio = document.querySelector(`input[name="format"][value="${savedSongsMeta.format}"]`);
                        if (radio) radio.checked = true;
                    }
                }

                // Go directly to song list
                songListContainer.style.display = "block";
                filterInput.value = "";
                await loadFilterPreferences();
                renderSongList();
                statusDiv.innerText = `${allSongs.length} cached songs. Checking for new...`;

                console.log('[Downloader] Showing cached songs, checking for new songs...');
                // Check for new songs
                setTimeout(() => checkForNewSongs(), 100);
                return;
            }
        } catch (e) {
            console.error('[Downloader] Error loading from storage:', e);
        }

        console.log('[Downloader] No cached songs found, will prompt before auto-fetch...');
        // No cached songs — ask user before starting a full fetch
        songListContainer.style.display = "block";
        startAutoFetch();
    }

    function checkForNewSongs() {
        const isPublicOnly = false; // filterPublic not available here
        const maxPages = 0;
        const knownIds = allSongs.map(s => s.id);

        console.log('[Downloader] Checking for new songs. Currently have', allSongs.length, 'songs cached.');
        
        try {
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: isPublicOnly,
                maxPages: maxPages,
                checkNewOnly: true,
                knownIds: knownIds
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Check for new songs error:', chrome.runtime.lastError);
                } else if (response && response.error) {
                    console.log('[Downloader] Check for new songs error:', response.error);
                } else {
                    console.log('[Downloader] Check for new songs request sent');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not check for new songs:', e.message);
        }
    }

    async function saveToStorage() {
        try {
            // Save songs to IndexedDB
            await saveSongsToIDB(allSongs);
            
            // Save metadata
            const metadata = {
                folder: folderInput.value,
                format: getSelectedFormat(),
                timestamp: Date.now()
            };
            await savePreferenceToIDB('sunoSongsList', metadata);
            await savePreferenceToIDB('sunoFormat', getSelectedFormat());
        } catch (e) {
            console.error('Failed to save to storage:', e);
        }
    }

    async function saveFilterPreferences() {
        try {
            await savePreferenceToIDB('sunoFilterLiked', filterLiked.checked);
            await savePreferenceToIDB('sunoFilterStems', filterStems.checked);
            await savePreferenceToIDB('sunoFilterPublic', filterPublic.checked);
        } catch (e) {
            console.error('Failed to save filter preferences:', e);
        }
    }

    async function loadFilterPreferences() {
        try {
            const liked = await loadPreferenceFromIDB('sunoFilterLiked');
            const stems = await loadPreferenceFromIDB('sunoFilterStems');
            const pub = await loadPreferenceFromIDB('sunoFilterPublic');
            
            if (liked !== null) filterLiked.checked = liked;
            if (stems !== null) filterStems.checked = stems;
            if (pub !== null) filterPublic.checked = pub;
        } catch (e) {
            console.error('Failed to load filter preferences:', e);
        }
    }

    function mergeSongs(newSongs) {
        const existingIds = new Set(allSongs.map(s => s.id));
        const addedSongs = newSongs.filter(s => !existingIds.has(s.id));

        if (addedSongs.length > 0) {
            // Add new songs at the beginning
            allSongs = [...addedSongs, ...allSongs];
            filteredSongs = [...allSongs];
            applyFilter();
            saveToStorage();
        }

        return addedSongs.length;
    }

    async function clearStorage() {
        try {
            await deletePreferenceFromIDB('sunoSongsList');
        } catch (e) {}
    }

    async function cacheAllSongs() {
        if (allSongs.length === 0) {
            statusDiv.innerText = "No songs to cache. Fetch your song list first.";
            return;
        }

        const songsToCache = allSongs.filter(s => s.audio_url && !cachedSongIds.has(s.id));
        if (songsToCache.length === 0) {
            statusDiv.innerText = `All ${allSongs.length} songs are already cached in the browser.`;
            return;
        }

        stopCachingRequested = false;
        isCachingAll = true;
        setCachingUiState(true);

        let cached = 0;
        let failed = 0;
        const total = songsToCache.length;

        for (const song of songsToCache) {
            if (stopCachingRequested) {
                statusDiv.innerText = `⏹️ Caching stopped. ${cached} song(s) cached.`;
                break;
            }

            statusDiv.innerText = `💾 Caching ${cached + failed + 1}/${total}: ${song.title || 'Untitled'}...`;

            try {
                const response = await fetch(song.audio_url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                await saveAudioBlobToIDB(song.id, blob);
                cachedSongIds.add(song.id);
                cached++;
            } catch (e) {
                failed++;
                console.error(`[Downloader] Failed to cache "${song.title}":`, e);
            }
        }

        isCachingAll = false;
        setCachingUiState(false);

        if (!stopCachingRequested) {
            const totalCached = cachedSongIds.size;
            statusDiv.innerText = `✅ Caching complete! ${cached} new, ${totalCached} total in browser. ${failed > 0 ? `${failed} failed.` : ''}`.trim();
        }

        renderSongList();
    }

    // Filter input
    filterInput.addEventListener("input", () => {
        applyFilter();
    });

    // Filter checkboxes
    filterLiked.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterStems.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterPublic.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    // Select all checkbox
    selectAllCheckbox.addEventListener("change", () => {
        const checkboxes = songList.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);
        updateSelectedCount();
    });

    // Download selected songs
    downloadBtn.addEventListener("click", () => {
        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const downloadOptions = getDownloadOptions();
        if (!downloadOptions.music && !downloadOptions.lyrics && !downloadOptions.image) {
            statusDiv.innerText = "Please select at least one download type: music, lyrics, or image.";
            return;
        }

        const folder = folderInput.value;
        const format = getSelectedFormat();
        const songsToDownload = allSongs.filter(s => selectedIds.includes(s.id));

        setDownloadUiState(true);

        try {
            api.runtime.sendMessage({
                action: "download_selected",
                folderName: folder,
                format: format,
                songs: songsToDownload,
                downloadOptions: downloadOptions
            });
        } catch (e) {
            console.debug('[Downloader] Could not send download request:', e.message);
        }

        const selectedTypes = [];
        if (downloadOptions.music) selectedTypes.push(format.toUpperCase());
        if (downloadOptions.lyrics) selectedTypes.push("lyrics");
        if (downloadOptions.image) selectedTypes.push("images");
        statusDiv.innerText = `Downloading ${songsToDownload.length} song(s): ${selectedTypes.join(", ")}...`;
    });

    // Stop downloading
    stopDownloadBtn.addEventListener("click", () => {
        try {
            api.runtime.sendMessage({ action: "stop_download" });
        } catch (e) {
            console.debug('[Downloader] Could not send stop download request:', e.message);
        }
        statusDiv.innerText = "Stopping download...\n" + statusDiv.innerText;
        // Keep UI in running state until background confirms stop/complete
    });

    // Cache all songs to browser database
    if (cacheAllBtn) {
        cacheAllBtn.addEventListener("click", () => {
            cacheAllSongs();
        });
    }

    // Stop caching
    if (stopCacheBtn) {
        stopCacheBtn.addEventListener("click", () => {
            stopCachingRequested = true;
            stopCacheBtn.disabled = true;
        });
    }

    // Listen for messages from background
    api.runtime.onMessage.addListener((message) => {
        if (message.action === "log") {
            statusDiv.innerText = message.text + "\n" + statusDiv.innerText;
        }

        if (message.action === "fetch_started") {
            // background informs us fetching has started (manual or auto)
            setFetchUiState(true);
            statusDiv.innerText = "Fetching songs...";
        }
        if (message.action === "songs_page_update") {
            // start or continue fetching, ensure UI shows stop button
            setFetchUiState(true);

            // Incremental page update
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;

            if (wasCheckingNew) {
                // Merge with existing songs
                const addedCount = mergeSongs(newSongs);
                statusDiv.innerText = `Page ${message.pageNum}: ${message.totalSongs} new songs found...`;
            } else {
                // Fresh fetch - replace all
                allSongs = newSongs;
                filteredSongs = [...allSongs];

                // Show song list immediately after first page
                if (message.pageNum === 1) {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        renderSongList();
                    });
                } else {
                    // Just update the list
                    applyFilter();
                }
                saveToStorage();
                statusDiv.innerText = `Page ${message.pageNum}: ${allSongs.length} songs...`;
            }
        }

        if (message.action === "download_state") {
            setDownloadUiState(!!message.isDownloading);
        }

        if (message.action === "download_stopped") {
            setDownloadUiState(false);
        }

        if (message.action === "songs_fetched") {
            setFetchUiState(false);
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;

            if (wasCheckingNew) {
                // Merge with existing songs
                const addedCount = mergeSongs(newSongs);
                if (addedCount > 0) {
                    statusDiv.innerText = `Found ${addedCount} new song(s). Total: ${allSongs.length}`;
                } else {
                    statusDiv.innerText = `${allSongs.length} songs (no new songs found).`;
                }
            } else {
                // Fresh fetch complete
                allSongs = newSongs;
                filteredSongs = [...allSongs];

                // Only show song list if not already visible (page updates already showed it)
                if (songListContainer.style.display !== "block") {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        renderSongList();
                    });
                } else {
                    // Just update the final list
                    applyFilter();
                }
                saveToStorage();
                statusDiv.innerText = `✅ Complete! Found ${allSongs.length} songs total.`;
            }
        }
        if (message.action === "fetch_stopped") {
            setFetchUiState(false);
            statusDiv.innerText = "⏹️ Fetch stopped by user – song list may be incomplete.";
        }
        if (message.action === "fetch_error") {
            setFetchUiState(false);
            statusDiv.innerText = message.error;
        }

        if (message.action === "download_complete") {
            setDownloadUiState(false);
            if (message.stopped) {
                statusDiv.innerText = "⏹️ Download stopped by user.";
            } else {
                statusDiv.innerText = "✅ Download complete!";
            }
        }
    });

    function applyFilter() {
        const filter = filterInput.value.toLowerCase();
        const showLikedOnly = filterLiked.checked;
        const showStemsOnly = filterStems.checked;
        const showPublicOnly = filterPublic.checked;

        filteredSongs = allSongs.filter(song => {
            // Text filter
            if (filter && !song.title.toLowerCase().includes(filter)) {
                return false;
            }

            // Liked filter
            if (showLikedOnly && !song.is_liked) {
                return false;
            }

            // Stems filter
            if (showStemsOnly && !song.is_stem) {
                return false;
            }

            // Public filter
            if (showPublicOnly && !song.is_public) {
                return false;
            }

            return true;
        });
        renderSongList();
    }

    function renderSongList() {
        songList.innerHTML = "";

        const songsToRender = [...filteredSongs].sort((a, b) => {
            const aTs = getSongTimestamp(a);
            const bTs = getSongTimestamp(b);
            if (bTs !== aTs) return bTs - aTs;
            return (a.title || '').localeCompare(b.title || '');
        });

        songsToRender.forEach(song => {
            const item = document.createElement("div");
            item.className = "song-item";
            if (currentPlayingSongId === song.id) {
                item.classList.add('playing');
            }

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.dataset.id = song.id;
            checkbox.checked = true;
            checkbox.addEventListener("change", updateSelectedCount);

            const songInfo = document.createElement("div");
            songInfo.className = "song-info";
            songInfo.style.cursor = 'pointer';

            // When user clicks the song info (everything except the checkbox), play/pause
            songInfo.addEventListener('click', (e) => {
                togglePlay(song);
            });

            const titleDiv = document.createElement("div");
            titleDiv.className = "song-title";
            titleDiv.title = song.title;
            titleDiv.textContent = song.title;

            const metaDiv = document.createElement("div");
            metaDiv.className = "song-meta";

            const visibilitySpan = document.createElement("span");
            visibilitySpan.className = song.is_public ? 'public' : 'private';
            visibilitySpan.textContent = song.is_public ? '🌐 Public' : '🔒 Private';
            metaDiv.appendChild(visibilitySpan);

            if (song.is_liked) {
                const likedSpan = document.createElement("span");
                likedSpan.textContent = ' • ❤️ Liked';
                likedSpan.style.color = '#e91e63';
                metaDiv.appendChild(likedSpan);
            }

            if (song.is_stem) {
                const stemSpan = document.createElement("span");
                stemSpan.textContent = ' • 🎹 Stem';
                stemSpan.style.color = '#9c27b0';
                metaDiv.appendChild(stemSpan);
            }

            if (song.created_at) {
                metaDiv.appendChild(document.createTextNode(' • ' + formatDate(song.created_at)));
            }

            if (cachedSongIds.has(song.id)) {
                const cachedSpan = document.createElement("span");
                cachedSpan.textContent = ' • 💾 Cached';
                cachedSpan.title = 'Audio stored in browser database';
                cachedSpan.style.color = '#4caf50';
                metaDiv.appendChild(cachedSpan);
            }

            songInfo.appendChild(titleDiv);
            songInfo.appendChild(metaDiv);

            const actionsDiv = document.createElement("div");
            actionsDiv.className = "song-actions";

            const playBtn = document.createElement("button");
            playBtn.className = "song-action-btn play-btn";
            playBtn.title = "Play Song";
            playBtn.textContent = (currentPlayingSongId === song.id && !audioElement.paused) ? '⏸' : '▶';
            playBtn.onclick = (e) => {
                e.stopPropagation();
                togglePlay(song);
            };

            const gotoBtn = document.createElement("button");
            gotoBtn.className = "song-action-btn goto-btn";
            gotoBtn.title = "Go to Song";
            /* eye icon using SVG for better consistency across platforms */
            gotoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5c-7.633 0-12 7-12 7s4.367 7 12 7 12-7 12-7-4.367-7-12-7zm0 12a5 5 0 1 1 .001-10.001A5 5 0 0 1 12 17zm0-8a3 3 0 1 0 .001 6.001A3 3 0 0 0 12 9z"/></svg>`;
            gotoBtn.onclick = (e) => {
                e.stopPropagation();
                window.open(`https://suno.com/song/${song.id}`, '_blank');
            };

            actionsDiv.appendChild(playBtn);
            actionsDiv.appendChild(gotoBtn);

            item.appendChild(checkbox);
            item.appendChild(songInfo);
            item.appendChild(actionsDiv);
            songList.appendChild(item);
        });

        updateSelectedCount();
    }

    function getSelectedSongIds() {
        const checkboxes = songList.querySelectorAll('input[type="checkbox"]:checked');
        return Array.from(checkboxes).map(cb => cb.dataset.id);
    }

    function getDownloadOptions() {
        return {
            music: !!downloadMusicCheckbox?.checked,
            lyrics: !!downloadLyricsCheckbox?.checked,
            image: !!downloadImageCheckbox?.checked
        };
    }

    function updateSelectedCount() {
        const total = filteredSongs.length;
        const selected = getSelectedSongIds().length;
        songCount.textContent = `${selected}/${total} selected`;

        // Update select all checkbox state
        const allChecked = songList.querySelectorAll('input[type="checkbox"]').length ===
                          songList.querySelectorAll('input[type="checkbox"]:checked').length;
        selectAllCheckbox.checked = allChecked && total > 0;
    }

    function formatDate(dateStr) {
        try {
            return new Date(dateStr).toLocaleDateString();
        } catch {
            return '';
        }
    }

    function getSongTimestamp(song) {
        const raw = song?.created_at || song?.createdAt || song?.timestamp;
        const ts = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(ts) ? ts : 0;
    }
})();
