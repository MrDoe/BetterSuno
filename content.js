// content.js — Floating notification panel injected into suno.com
(function () {
  if (document.getElementById('bettersuno-root')) return; // already injected

  // Track how many notifications we've seen so we know which are "new"
  let lastSeenCount = 0;
  let panelOpen = false;
  let currentTab = 'library';
  const NOTIFICATION_RENDER_BATCH_SIZE = 25;
  let currentNotifications = [];
  let renderedNotificationCount = 0;
  let notificationsSentinel = null;
  let notificationsObserver = null;
  let olderNotificationsFetching = false;
  let olderNotificationsExhausted = false;
  let isNotificationsRefreshHost = false;
  const isAndroidFirefox = /Android/i.test(navigator.userAgent) && /Firefox/i.test(navigator.userAgent);
  let androidFirefoxKeepAliveEnabled = false;
  let androidFirefoxKeepAliveIsOwner = false;
  let androidFirefoxKeepAliveOwnerTabId = null;

  function getPanelMarkup() {
    return `
    <div id="bettersuno-panel">
      <div id="bettersuno-header">
        <h3 id="bettersuno-title">BetterSuno</h3>
      </div>
      <div id="bettersuno-tabs">
        <button class="bettersuno-tab active" data-tab="library">Song Library</button>
        <button class="bettersuno-tab" data-tab="player">Player</button>
        <button class="bettersuno-tab" data-tab="create">Create</button>
        <button class="bettersuno-tab" data-tab="notifications">Notifications</button>
        <button class="bettersuno-tab" data-tab="settings">Settings</button>
      </div>
      <div id="bettersuno-list" class="bettersuno-content" style="display: none;">
        <div class="bettersuno-empty">No notifications yet</div>
      </div>
      <div id="bettersuno-download-content" class="bettersuno-content" style="display: flex;">
        <div id="bettersuno-downloader-wrapper">
          <div id="songListContainer">
            <div id="playlistControls">
              <label>📋 Playlist:</label>
              <select id="playlistFilter">
                <option value="">All My Songs</option>
              </select>
              <button id="deletePlaylistBtn" class="btn-danger" title="Delete selected external playlist from local database" type="button" style="display: none;">🗑</button>
              <button id="addPlaylistBtn" class="btn-secondary" title="Load a playlist by URL or ID" type="button">＋</button>
            </div>

            <dialog id="bettersuno-playlist-dialog">
              <div class="playlist-dialog-header">
                <span class="playlist-dialog-title">Add Playlist</span>
                <button id="playlistDialogCloseBtn" class="playlist-dialog-close" type="button" aria-label="Close">✕</button>
              </div>
              <div id="playlistSearchControls">
                <input type="text" id="playlistSearchInput" placeholder="Search playlist by name or paste URL/ID..." autocomplete="off" />
                <button id="playlistSearchBtn" class="btn-secondary" type="button">Search</button>
              </div>
              <div id="playlistSearchResults"></div>
            </dialog>

            <div id="filterControls">
              <label>Filter:</label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="filterLiked" /> ❤️ Liked
              </label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="filterStems" /> 🎹 Stems
              </label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="filterPublic" checked /> 🌐 Public
              </label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="filterOffline" /> 💾 Offline
              </label>
              <label style="margin-left: 12px !important">Sort:</label>
              <select id="sortSelect" style="background:#3f3f46;color:#f4f4f5;border:1px solid #52525b;border-radius:4px;padding:2px 4px;font-size:12px;cursor:pointer">
                <option value="date-desc">Newest</option>
                <option value="date-asc">Oldest</option>
                <option value="likes-desc">Most Liked</option>
                <option value="likes-asc">Least Liked</option>
              </select>
            </div>

            <input type="text" id="filterInput" placeholder="🔍 Search songs by title..." />

            <span id="selectControls">
              <button id="selectAll" class="btn-secondary" type="button" aria-pressed="false">Select All</button>
              <button id="downloadBtn" class="btn-secondary" type="button" title="Download selected songs">Download</button>
              <button id="stopDownloadBtn" class="btn-stop hidden" type="button">Stop</button>
              <button id="addToPlaylistBtn" class="btn-secondary" type="button" title="Add selected songs to one of your playlists">Add to PL</button>
              <button id="removeFromPlaylistBtn" class="btn-danger" type="button" title="Remove selected songs from the current playlist">Remove from PL</button>
              <button id="cacheAllBtn" class="btn-secondary" title="Download selected songs as M4A into the browser database for offline playback">Save to DB</button>
              <button id="stopCacheBtn" class="btn-stop hidden">Stop</button>
              <button id="deleteCachedBtn" class="btn-danger" title="Delete the selected songs from the browser database">Delete from DB</button>
              <button id="syncNewBtn" class="btn-secondary" title="Refresh metadata for all songs (likes, privacy status, etc.)">Refresh</button>
              <span id="songCount">0 songs</span>
            </span>

            <div id="songList"></div>

            <dialog id="bettersuno-download-dialog">
              <div class="playlist-dialog-header">
                <span class="playlist-dialog-title">Download Options</span>
                <button id="downloadDialogCloseBtn" class="playlist-dialog-close" type="button" aria-label="Close">✕</button>
              </div>
              <div id="downloadTypeControls">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">Include:</label>
                <label class="checkbox-label">
                  <input type="checkbox" id="downloadMusic" checked />Music
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" id="downloadLyrics" checked />Lyrics
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" id="downloadImage" checked />Cover Image
                </label>
                <hr style="border-color: #3f3f46; margin: 10px 0;" />
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">Format:</label>
                <div id="formatControls" style="display: flex; gap: 6px; align-items: center">
                  <label class="checkbox-label">
                    <input type="radio" name="format" id="formatM4a" value="m4a" checked />M4A
                  </label>
                  <label class="checkbox-label">
                    <input type="radio" name="format" id="formatWav" value="wav" />WAV
                  </label>
                </div>
              </div>
              <div style="margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end;">
                <button id="downloadDialogCancelBtn" class="btn-secondary" style="margin-bottom: 1rem;" type="button">Cancel</button>
                <button id="downloadDialogConfirmBtn" class="btn-primary" style="margin: 0 1rem 1rem 0;" type="button">Download</button>
              </div>
            </dialog>
          </div>

          <div id="bettersuno-mini-player" class="mini-player" style="display: none;">
            <div class="player-controls">
              <button id="player-play-pause" class="player-btn">▶</button>
              <div class="player-info">
                <div id="player-song-title" class="player-title">No song selected</div>
                <div class="player-progress-container">
                  <div id="player-progress-bar" class="player-progress"></div>
                </div>
              </div>
              <div id="player-time" class="player-time">0:00</div>
              <audio id="bettersuno-audio-element"></audio>
            </div>
          </div>

          <div id="status" role="status" aria-live="polite">Ready...</div>
          <div id="versionFooter" class="version-footer"></div>
        </div>
      </div>
      <div id="bettersuno-create-content" class="bettersuno-content" style="display: none;">
        <!-- create.js will populate this -->
      </div>
      <div id="bettersuno-settings-content" class="bettersuno-content" style="display: none;">
        <div class="bettersuno-settings-form">
          <div class="bettersuno-setting-row">
            <h4>Notification Settings</h4>
          </div>
          <div class="bettersuno-setting-row">
            <label>Polling Interval (seconds):</label>
            <input type="number" id="bettersuno-setting-interval" class="bettersuno-setting" data-key="intervalMs" min="10" step="10" value="120">
          </div>
          <div class="bettersuno-setting-row">
            <label>
              <input type="checkbox" checked="" id="bettersuno-setting-desktop" class="bettersuno-setting" data-key="desktopNotificationsEnabled">
              Desktop Notifications
            </label>
          </div>
          <div class="bettersuno-setting-row">
            <label>
              <input type="checkbox" id="bettersuno-setting-android-keepalive" class="bettersuno-setting" data-key="androidFirefoxKeepAliveEnabled">
              Android Firefox tab keepalive (experimental)
            </label>
          </div>
          <div class="bettersuno-setting-row">
            <div id="bettersuno-setting-android-keepalive-note" class="bettersuno-setting-value"></div>
          </div>
          <hr>
          <div class="bettersuno-setting-row">
            <h4>Download Settings</h4>
          </div>
          <div class="bettersuno-setting-row">
            <label>Download Folder:</label>
            <input type="text" id="folder" class="bettersuno-setting" data-key="downloadFolder" value="Suno_Songs" placeholder="Folder name in Downloads" style="flex: 1;" />
          </div>
          <div class="bettersuno-setting-row">
            <label>Local DB Usage:</label>
            <div id="bettersuno-db-usage" class="bettersuno-setting-value">Calculating...</div>
          </div>
          <div class="bettersuno-setting-row" style="display: inline-flex; gap: 5px; align-items: flex-start;">
            <button id="bettersuno-fetch-songs-btn" class="btn-primary" style="padding: 8px 16px; cursor: pointer;">Refetch Library</button>
            <button id="bettersuno-stop-fetch-btn" class="btn-stop" style="padding: 8px 16px; cursor: pointer; display: none;">Stop Fetch</button>
            <button id="bettersuno-delete-library-btn" class="btn-danger" style="padding: 8px 16px; cursor: pointer;">Delete Library</button>
          </div>
        </div>
      </div>
      <div id="bettersuno-player-content" class="bettersuno-content" style="display: none;">
        <div class="player-tab-inner">
          <div class="player-tab-no-song" id="player-tab-no-song">
            <div class="player-tab-no-song-icon">♪</div>
            <div>No song playing</div>
          </div>
          <div class="player-tab-song" id="player-tab-song" style="display: none;">
            <div class="player-tab-subtabs" id="player-tab-subtabs">
              <button type="button" class="player-tab-subtab active" id="player-tab-subtab-cover" data-view="cover">Cover</button>
              <button type="button" class="player-tab-subtab" id="player-tab-subtab-lyrics" data-view="lyrics">Lyrics</button>
              <button type="button" class="player-tab-subtab" id="player-tab-subtab-comments" data-view="comments">Comments</button>
            </div>
            <div class="player-tab-view" id="player-tab-view-cover">
              <div class="player-tab-title" id="player-tab-title"></div>
              <div class="player-tab-media-controls" id="player-tab-media-controls">
                <div class="player-tab-media-hint" id="player-tab-media-hint" style="display: none;"></div>
              </div>
              <div class="player-tab-art-wrapper" id="player-tab-art-wrapper">
                <video class="player-tab-video-media" id="player-tab-video" style="display: none;" autoplay loop muted playsinline></video>
                <img class="player-tab-cover-image" id="player-tab-cover-image" style="display: none;" alt="Cover art" />
                <button type="button" class="btn-secondary player-tab-media-toggle" id="player-tab-media-toggle" style="display: none;" aria-label="Show cover video" title="Show cover video">≫</button>
              </div>
            </div>
            <div class="player-tab-view" id="player-tab-view-lyrics" style="display: none;">
              <div class="player-tab-lyrics-wrapper">
                <div class="player-tab-lyrics" id="player-tab-lyrics">No lyrics available.</div>
                <textarea class="player-tab-lyrics-edit" id="player-tab-lyrics-edit" style="display: none;"></textarea>
              </div>
              <div class="player-tab-lyrics-edit-actions" id="player-tab-lyrics-edit-actions" style="display: none;">
                <button type="button" class="btn-primary" id="player-tab-lyrics-save">Save</button>
                <button type="button" class="btn-secondary" id="player-tab-lyrics-cancel">Cancel</button>
              </div>
              <button type="button" class="player-tab-edit-lyrics-btn" id="player-tab-edit-lyrics-btn" style="display: none;">Edit Lyrics</button>
            </div>
            <div class="player-tab-view" id="player-tab-view-comments" style="display: none;">
              <div class="player-tab-comments-wrapper">
                <div class="player-tab-comments-list" id="player-tab-comments-list">
                  <div class="player-tab-comments-loading">Loading comments...</div>
                </div>
                <div class="player-tab-comments-input-area">
                  <div class="player-tab-emoji-picker" id="player-tab-emoji-picker">
                    <span class="emoji-item">👍</span>
                    <span class="emoji-item">🔥</span>
                    <span class="emoji-item">❤️</span>
                    <span class="emoji-item">⭐</span>
                    <span class="emoji-item">✨</span>
                    <span class="emoji-item">🎵</span>
                    <span class="emoji-item">🙌</span>
                    <span class="emoji-item">🎸</span>
                    <span class="emoji-item">🎹</span>
                    <span class="emoji-item">🎤</span>
                    <select id="player-tab-emoji-select" class="player-tab-emoji-select" style="display: none;">
                      <option value="">Emoji...</option>
                    </select>
                  </div>
                  <textarea id="player-tab-comment-input" placeholder="Add a comment..."></textarea>
                  <button id="player-tab-comment-submit" class="btn-primary" disabled>Post</button>
                </div>
              </div>
            </div>
          </div>
          <div class="player-tab-controls">
            <div class="player-tab-progress-row">
              <div class="player-progress-container" id="player-tab-progress-container">
                <div class="player-progress" id="player-tab-progress-bar"></div>
              </div>
              <div class="player-time" id="player-tab-time">0:00 / 0:00</div>
            </div>
            <div class="player-tab-buttons">
              <button id="player-tab-prev" class="player-btn" title="Previous track">⏮︎</button>
              <button id="player-tab-play-pause" class="player-btn player-btn-large" title="Play/Pause">▶</button>
              <button id="player-tab-next" class="player-btn" title="Next track">⏭︎</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button id="bettersuno-bell" title="BetterSuno">
      <svg viewBox="0 0 24 24"><path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
      <span id="bettersuno-badge">0</span>
    </button>
  `;
  }

  // ---- Build DOM ----
  const root = document.createElement('div');
  root.id = 'bettersuno-root';

  root.innerHTML = getPanelMarkup();

  document.body.appendChild(root);

  const bell = root.querySelector('#bettersuno-bell');
  const badge = root.querySelector('#bettersuno-badge');
  const panel = root.querySelector('#bettersuno-panel');
  const list = root.querySelector('#bettersuno-list');
  const tabButtons = root.querySelectorAll('.bettersuno-tab');
  const title = root.querySelector('#bettersuno-title');
  const settingsContent = root.querySelector('#bettersuno-settings-content');
  const libraryContent = root.querySelector('#bettersuno-download-content');
  const playerContent = root.querySelector('#bettersuno-player-content');
  const createContent = root.querySelector('#bettersuno-create-content');

  const androidFirefoxKeepAliveManager = (() => {
    const KEEPALIVE_AUDIO_ID = 'bettersuno-android-keepalive-audio';
    const KEEPALIVE_TITLE = 'BetterSuno KeepAlive';
    const KEEPALIVE_ARTIST = 'Experimental Android Firefox keepalive';
    const KEEPALIVE_FREQUENCY_HZ = 18000;
    const KEEPALIVE_GAIN = 0.00001;
    const KEEPALIVE_INTERVAL_MS = 5000;
    const KEEPALIVE_LOCK_NAME = 'bettersuno-android-firefox-keepalive';

    let running = false;
    let audioContext = null;
    let oscillatorNode = null;
    let gainNode = null;
    let mediaDestination = null;
    let audioElement = null;
    let resumeTimer = null;
    let webLockAbortController = null;
    let gestureRetryHandler = null;

    function clearGestureRetry() {
      if (!gestureRetryHandler) {
        return;
      }

      document.removeEventListener('pointerdown', gestureRetryHandler, true);
      document.removeEventListener('touchstart', gestureRetryHandler, true);
      gestureRetryHandler = null;
    }

    function armGestureRetry() {
      if (gestureRetryHandler) {
        return;
      }

      gestureRetryHandler = () => {
        if (!running) {
          clearGestureRetry();
          return;
        }

        void tick();
      };

      document.addEventListener('pointerdown', gestureRetryHandler, true);
      document.addEventListener('touchstart', gestureRetryHandler, true);
    }

    function isOtherMediaPlaying() {
      try {
        const mediaElements = document.querySelectorAll('audio,video');
        for (const element of mediaElements) {
          if (element === audioElement) {
            continue;
          }
          if (!element.paused && !element.ended && element.readyState > 2) {
            return true;
          }
        }
      } catch (e) {
        return false;
      }

      return false;
    }

    function clearOwnedMediaSession() {
      if (!("mediaSession" in navigator)) {
        return;
      }

      try {
        if (navigator.mediaSession.metadata?.title === KEEPALIVE_TITLE) {
          navigator.mediaSession.playbackState = 'none';
          navigator.mediaSession.metadata = null;
        }
      } catch (e) {}

      ['play', 'pause', 'stop'].forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch (e) {}
      });
    }

    function setOwnedMediaSessionPlaying() {
      if (!("mediaSession" in navigator)) {
        return;
      }

      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: KEEPALIVE_TITLE,
          artist: KEEPALIVE_ARTIST,
          album: 'BetterSuno'
        });
        navigator.mediaSession.playbackState = 'playing';
      } catch (e) {}

      ['play', 'pause', 'stop'].forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action, () => {
            void tick();
          });
        } catch (e) {}
      });
    }

    async function acquireWebLock() {
      if (!("locks" in navigator) || webLockAbortController) {
        return;
      }

      try {
        webLockAbortController = new AbortController();
        navigator.locks.request(
          KEEPALIVE_LOCK_NAME,
          {
            mode: 'exclusive',
            signal: webLockAbortController.signal
          },
          () => new Promise(() => {})
        ).catch(() => {
          webLockAbortController = null;
        });
      } catch (e) {
        webLockAbortController = null;
      }
    }

    function releaseWebLock() {
      if (!webLockAbortController) {
        return;
      }

      try {
        webLockAbortController.abort();
      } catch (e) {}
      webLockAbortController = null;
    }

    function ensureAudioElement() {
      if (audioElement?.isConnected) {
        return audioElement;
      }

      audioElement = document.getElementById(KEEPALIVE_AUDIO_ID);
      if (!audioElement) {
        audioElement = document.createElement('audio');
        audioElement.id = KEEPALIVE_AUDIO_ID;
        audioElement.hidden = true;
        audioElement.playsInline = true;
        audioElement.setAttribute('aria-hidden', 'true');
        audioElement.style.display = 'none';
        document.documentElement.appendChild(audioElement);
      }

      return audioElement;
    }

    async function startAudioPlayback() {
      if (!isAndroidFirefox) {
        return false;
      }

      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
          return false;
        }

        if (!audioContext || audioContext.state === 'closed') {
          audioContext = new AudioContextCtor();
          oscillatorNode = audioContext.createOscillator();
          gainNode = audioContext.createGain();
          mediaDestination = audioContext.createMediaStreamDestination();

          oscillatorNode.type = 'sine';
          oscillatorNode.frequency.value = KEEPALIVE_FREQUENCY_HZ;
          gainNode.gain.value = KEEPALIVE_GAIN;

          oscillatorNode.connect(gainNode);
          gainNode.connect(mediaDestination);
          oscillatorNode.start();
        }

        const element = ensureAudioElement();
        if (element.srcObject !== mediaDestination.stream) {
          element.srcObject = mediaDestination.stream;
        }

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        if (element.paused) {
          await element.play();
        }

        return element.paused === false;
      } catch (e) {
        console.debug('[BetterSuno] Android Firefox keepalive audio start failed:', e?.message || e);
        return false;
      }
    }

    function stopAudioPlayback() {
      try {
        if (audioElement) {
          try {
            audioElement.pause();
          } catch (e) {}

          try {
            const srcObject = audioElement.srcObject;
            if (srcObject?.getTracks) {
              srcObject.getTracks().forEach(track => {
                try {
                  track.stop();
                } catch (e) {}
              });
            }
          } catch (e) {}

          audioElement.srcObject = null;
          audioElement.remove();
          audioElement = null;
        }

        if (oscillatorNode) {
          try {
            oscillatorNode.stop();
          } catch (e) {}
          try {
            oscillatorNode.disconnect();
          } catch (e) {}
          oscillatorNode = null;
        }

        if (gainNode) {
          try {
            gainNode.disconnect();
          } catch (e) {}
          gainNode = null;
        }

        if (mediaDestination) {
          try {
            mediaDestination.disconnect();
          } catch (e) {}
          mediaDestination = null;
        }

        if (audioContext) {
          try {
            audioContext.close();
          } catch (e) {}
          audioContext = null;
        }
      } catch (e) {}
    }

    async function tick() {
      if (!running) {
        return false;
      }

      if (isOtherMediaPlaying()) {
        clearOwnedMediaSession();
        stopAudioPlayback();
        clearGestureRetry();
        return false;
      }

      const started = await startAudioPlayback();
      if (started) {
        setOwnedMediaSessionPlaying();
        clearGestureRetry();
      } else {
        armGestureRetry();
      }

      return started;
    }

    async function start() {
      if (!isAndroidFirefox) {
        return false;
      }

      running = true;
      await acquireWebLock();
      const started = await tick();

      if (resumeTimer) {
        clearInterval(resumeTimer);
      }
      resumeTimer = setInterval(() => {
        void tick();
      }, KEEPALIVE_INTERVAL_MS);

      return started;
    }

    function stop() {
      running = false;

      if (resumeTimer) {
        clearInterval(resumeTimer);
        resumeTimer = null;
      }

      clearGestureRetry();
      clearOwnedMediaSession();
      stopAudioPlayback();
      releaseWebLock();
    }

    return {
      start,
      stop,
      isRunning: () => running
    };
  })();

  function updateAndroidFirefoxKeepAliveUi() {
    const checkbox = document.getElementById('bettersuno-setting-android-keepalive');
    const note = document.getElementById('bettersuno-setting-android-keepalive-note');
    if (!checkbox || !note) {
      return;
    }

    checkbox.disabled = !isAndroidFirefox;

    if (!isAndroidFirefox) {
      note.textContent = 'Available only on Firefox for Android. When enabled there, BetterSuno uses a silent media session to reduce MIUI and HyperOS tab reloads.';
      return;
    }

    if (androidFirefoxKeepAliveEnabled && androidFirefoxKeepAliveIsOwner) {
      note.textContent = 'Active in this tab. Android should show a BetterSuno media notification while Suno is idle. Battery use may increase.';
      return;
    }

    if (androidFirefoxKeepAliveEnabled) {
      note.textContent = 'Enabled, but another Suno tab currently owns the keepalive session.';
      return;
    }

    note.textContent = 'Disabled. Enable this only if Firefox on Android keeps reloading Suno after app switching or screen-off.';
  }

  function applyAndroidFirefoxKeepAliveControl(control) {
    androidFirefoxKeepAliveEnabled = control?.enabled === true;
    androidFirefoxKeepAliveIsOwner = control?.isOwner === true;
    androidFirefoxKeepAliveOwnerTabId = typeof control?.ownerTabId === 'number' ? control.ownerTabId : null;

    updateAndroidFirefoxKeepAliveUi();

    if (!isAndroidFirefox || !androidFirefoxKeepAliveEnabled || !androidFirefoxKeepAliveIsOwner) {
      androidFirefoxKeepAliveManager.stop();
      return;
    }

    void androidFirefoxKeepAliveManager.start();
  }

  function requestAndroidFirefoxKeepAliveState() {
    if (!isAndroidFirefox || !isContextValid()) {
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: 'contentSyncAndroidKeepAlive' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          return;
        }

        applyAndroidFirefoxKeepAliveControl(response);
      });
    } catch (e) {
      console.debug('[BetterSuno] Could not sync Android Firefox keepalive state');
    }
  }

  updateAndroidFirefoxKeepAliveUi();

  function setActiveTab(tabName, activeButton = null) {
    currentTab = tabName;
    title.textContent = 'BetterSuno';

    tabButtons.forEach(button => {
      button.classList.toggle('active', button === activeButton);
    });

    const sections = {
      notifications: list,
      library: libraryContent,
      player: playerContent,
      create: createContent,
      settings: settingsContent
    };

    Object.entries(sections).forEach(([name, element]) => {
      if (!element) return;
      element.style.display = name === tabName
        ? (name === 'library' || name === 'player' ? 'flex' : 'block')
        : 'none';
    });

    if (tabName === 'settings') {
      loadSettings();
      document.dispatchEvent(new CustomEvent('bettersuno:settings-opened'));
    }

    if (tabName === 'create') {
      document.dispatchEvent(new CustomEvent('bettersuno:create-tab-opened'));
    }
  }
  
  // ---- Toggle panel ----
  bell.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) {
      // refresh state immediately when the panel opens
      refresh();
      // Mark all current notifications as seen after fetching
      lastSeenCount = currentNotifCount;
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  });

  // Close panel on outside click
  document.addEventListener('click', (e) => {
    // Don't close if a song is currently playing - keep the mini-player visible
    const audio = document.getElementById('bettersuno-audio-element');
    const isPlaying = audio && !audio.paused;
    
    if (panelOpen && !root.contains(e.target) && !isPlaying) {
      panelOpen = false;
      panel.classList.remove('open');
    }
  });

  // ---- Tab switching ----
  tabButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.currentTarget.dataset.tab;
      setActiveTab(tab, e.currentTarget);
    });
  });

  // ---- Load settings from background ----
  function loadSettings() {
    try {
      chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        const state = response;
        
        document.getElementById('bettersuno-setting-interval').value = (state.intervalMs || 120000) / 1000;
        document.getElementById('bettersuno-setting-desktop').checked = state.desktopNotificationsEnabled !== false;
        document.getElementById('bettersuno-setting-android-keepalive').checked = state.androidFirefoxKeepAliveEnabled === true;
        androidFirefoxKeepAliveEnabled = state.androidFirefoxKeepAliveEnabled === true;
        updateAndroidFirefoxKeepAliveUi();
      });
    } catch (e) {
      console.debug('[BetterSuno] Extension context unavailable');
    }
  }

  // ---- Save settings on change ----
  const settingsControls = root.querySelectorAll('.bettersuno-setting');
  settingsControls.forEach(control => {
    control.addEventListener('change', () => {
      const intervalSeconds = Number(document.getElementById('bettersuno-setting-interval').value);
      const intervalMs = intervalSeconds * 1000;
      const desktopNotifications = document.getElementById('bettersuno-setting-desktop').checked;
      const androidFirefoxKeepAlive = document.getElementById('bettersuno-setting-android-keepalive').checked;

      if (control.id === 'bettersuno-setting-android-keepalive') {
        androidFirefoxKeepAliveEnabled = androidFirefoxKeepAlive;
        updateAndroidFirefoxKeepAliveUi();

        if (isAndroidFirefox && androidFirefoxKeepAlive) {
          void androidFirefoxKeepAliveManager.start();
        } else {
          androidFirefoxKeepAliveManager.stop();
        }
      }
      
      try {
        chrome.runtime.sendMessage({
          type: 'contentUpdateSettings',
          tabId: 'global',
          settings: {
            enabled: true,
            intervalMs,
            desktopNotificationsEnabled: desktopNotifications,
            androidFirefoxKeepAliveEnabled: androidFirefoxKeepAlive
          }
        }, (response) => {
          if (!chrome.runtime.lastError) {
            if (response?.androidKeepAlive) {
              applyAndroidFirefoxKeepAliveControl(response.androidKeepAlive);
            }
            console.log('[BetterSuno] Settings updated');
          }
        });
      } catch (e) {
        console.debug('[BetterSuno] Could not send settings update');
      }
    });
  });

  // ---- Fetch Songs button ----
  const fetchSongsBtn = root.querySelector('#bettersuno-fetch-songs-btn');
  if (fetchSongsBtn) {
    fetchSongsBtn.addEventListener('click', () => {
      const libraryTabButton = root.querySelector('.bettersuno-tab[data-tab="library"]');
      if (libraryTabButton) {
        libraryTabButton.click();
      }

      document.dispatchEvent(new CustomEvent('bettersuno:refresh-library'));
    });
  }

  // stop fetching button
  const stopFetchBtn = root.querySelector('#bettersuno-stop-fetch-btn');
  if (stopFetchBtn) {
    stopFetchBtn.addEventListener('click', () => {
      const warn = confirm("Stopping the fetch early will likely leave your song list incomplete. Are you sure you want to stop?");
      if (!warn) return;
      // hide the button immediately to avoid double-clicks
      stopFetchBtn.style.display = 'none';
      fetchSongsBtn.style.display = 'block'; // re-show fetch button
      try {
        chrome.runtime.sendMessage({ action: 'stop_fetch' });
      } catch (e) {
        console.debug('[BetterSuno] Could not send stop fetch command');
      }
      console.log('[BetterSuno] Stop fetch request sent');
    });
  }

  // ---- Delete Library button ----
  const deleteLibraryBtn = root.querySelector('#bettersuno-delete-library-btn');
  if (deleteLibraryBtn) {
    deleteLibraryBtn.addEventListener('click', () => {
      const confirm_delete = confirm("Delete the entire song library from local storage? This cannot be undone.");
      if (!confirm_delete) return;
      document.dispatchEvent(new CustomEvent('bettersuno:delete-library'));
    });
  }

  // ---- HTML escaping ----
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Time formatting ----
  function formatAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ---- Describe a notification ----
  function describeNotif(n) {
    const users = n.user_profiles || [];
    const total = n.total_users || users.length;
    const firstName = users[0]?.display_name || 'Someone';
    const firstHandle = users[0]?.handle || '';
    const avatar = users[0]?.avatar_image_url || '';
    const others = total - 1;
    const title = n.content_title || '';
    const contentImg = n.content_image_url || '';
    const contentId = n.content_id || '';
    const type = n.notification_type || n.type || '';

    let who = firstName;
    if (others > 0) who += ` +${others}`;

    let text = '';
    let url = 'https://suno.com';
    switch (type) {
      case 'clip_like':
        text = `liked your song "${title}"`;
        url = `https://suno.com/song/${contentId}`;
        break;
      case 'clip_comment':
        text = `commented on "${title}"`;
        url = `https://suno.com/song/${contentId}?show_comments=true`;
        break;
      case 'comment_like':
        text = `liked your comment on "${title}"`;
        url = `https://suno.com/song/${contentId}?show_comments=true`;
        break;
      case 'comment_reply':
        text = `replied to your comment on "${title}"`;
        url = `https://suno.com/song/${contentId}?show_comments=true`;
        break;
      case 'video_cover_hook_like':
        text = 'liked your video cover';
        url = `https://suno.com/hook/${contentId}`;
        break;
      case 'hook_like':
        text = 'liked your hook';
        url = `https://suno.com/hook/${contentId}`;
        break;
      case 'hook_comment':
        text = 'commented on your hook';
        url = `https://suno.com/hook/${contentId}?show_comments=true`;
        break;
      case 'playlist_like':
        text = `liked your playlist "${title}"`;
        url = `https://suno.com/playlist/${contentId}`;
        break;
      case 'follow':
        text = 'followed you';
        url = firstHandle ? `https://suno.com/@${firstHandle}` : url;
        break;
      case 'comment_mention':
        text = `mentioned you in a comment on "${title}"`;
        if (n.content_message) text += `: "${n.content_message}"`;
        url = `https://suno.com/song/${contentId}?show_comments=true`;
        break;
      case 'caption_mention':
        text = `mentioned you in their caption on "${title}"`;
        if (n.content_message) text += `: "${n.content_message}"`;
        url = `https://suno.com/song/${contentId}`;
        break;
      default:
        text = 'sent a notification';
    }

    const ts = n.updated_at || n.created_at || n.notified_at || '';

    return { who, firstHandle, avatar, text, contentImg, url, ts };
  }

  // ---- Render notification list ----
  let currentNotifCount = 0;

  function ensureNotificationObserver() {
    if (notificationsObserver || !list) {
      return;
    }

    notificationsObserver = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        renderNotificationChunk();
      }
    }, {
      root: list,
      rootMargin: '0px 0px 160px 0px'
    });
  }

  function updateNotificationSentinelState() {
    if (!notificationsSentinel) {
      return;
    }

    const remaining = Math.max(currentNotifications.length - renderedNotificationCount, 0);
    notificationsSentinel.classList.toggle('is-complete', remaining === 0);
    notificationsSentinel.classList.toggle('is-loadmore', false);
    notificationsSentinel.onclick = null;

    if (remaining > 0) {
      notificationsSentinel.textContent = `Scroll to load ${Math.min(remaining, NOTIFICATION_RENDER_BATCH_SIZE)} more notifications`;
    } else if (currentNotifications.length === 0) {
      notificationsSentinel.textContent = '';
    } else if (olderNotificationsFetching) {
      notificationsSentinel.textContent = 'Loading older notifications…';
    } else if (olderNotificationsExhausted) {
      notificationsSentinel.textContent = 'All notifications loaded';
    } else {
      notificationsSentinel.classList.toggle('is-loadmore', true);
      notificationsSentinel.textContent = 'Load older notifications';
      notificationsSentinel.onclick = loadOlderNotifications;
    }
  }

  function loadOlderNotifications() {
    if (olderNotificationsFetching || olderNotificationsExhausted || !isContextValid()) return;

    const oldest = currentNotifications[currentNotifications.length - 1];
    if (!oldest) return;

    const beforeUtc = oldest.updated_at || oldest.notified_at || oldest.created_at;
    if (!beforeUtc) return;

    olderNotificationsFetching = true;
    updateNotificationSentinelState();

    chrome.runtime.sendMessage({ type: 'contentFetchOlder', beforeUtc }, (response) => {
      olderNotificationsFetching = false;
      if (!response || response.count === 0 || response.exhausted) {
        olderNotificationsExhausted = true;
      }
      updateNotificationSentinelState();
    });
  }

  function ensureNotificationSentinel() {
    ensureNotificationObserver();

    if (!notificationsSentinel) {
      notificationsSentinel = document.createElement('div');
      notificationsSentinel.className = 'bettersuno-list-sentinel';
    }

    if (!notificationsSentinel.isConnected) {
      list.appendChild(notificationsSentinel);
    }

    if (notificationsObserver) {
      notificationsObserver.disconnect();
      notificationsObserver.observe(notificationsSentinel);
    }

    updateNotificationSentinelState();
  }

  function createNotificationItem(n) {
    const d = describeNotif(n);

    const itemDiv = document.createElement('div');
    itemDiv.className = 'bettersuno-item';

    if (d.avatar) {
      const avatarLink = document.createElement('a');
      avatarLink.href = `https://suno.com/@${d.firstHandle}`;
      avatarLink.target = '_blank';
      const avatarImg = document.createElement('img');
      avatarImg.className = 'bettersuno-avatar';
      avatarImg.src = d.avatar;
      avatarLink.appendChild(avatarImg);
      itemDiv.appendChild(avatarLink);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'bettersuno-body';

    const textDiv = document.createElement('div');
    textDiv.className = 'bettersuno-text';

    const whoLink = document.createElement('a');
    whoLink.href = `https://suno.com/@${d.firstHandle}`;
    whoLink.target = '_blank';
    whoLink.textContent = d.who;
    textDiv.appendChild(whoLink);

    textDiv.appendChild(document.createTextNode(' ' + d.text));

    const timeDiv = document.createElement('div');
    timeDiv.className = 'bettersuno-time';
    timeDiv.textContent = formatAgo(d.ts);

    bodyDiv.appendChild(textDiv);
    bodyDiv.appendChild(timeDiv);
    itemDiv.appendChild(bodyDiv);

    if (d.contentImg) {
      const imgLink = document.createElement('a');
      imgLink.href = d.url;
      imgLink.target = '_blank';
      const contentImg = document.createElement('img');
      contentImg.className = 'bettersuno-content-img';
      contentImg.src = d.contentImg;
      imgLink.appendChild(contentImg);
      itemDiv.appendChild(imgLink);
    }

    return itemDiv;
  }

  function renderNotificationChunk(count = NOTIFICATION_RENDER_BATCH_SIZE) {
    if (!currentNotifications.length) {
      return;
    }

    ensureNotificationSentinel();

    const start = renderedNotificationCount;
    const end = Math.min(start + count, currentNotifications.length);
    if (start >= end) {
      updateNotificationSentinelState();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      fragment.appendChild(createNotificationItem(currentNotifications[index]));
    }

    list.insertBefore(fragment, notificationsSentinel);
    renderedNotificationCount = end;
    updateNotificationSentinelState();
  }

  function renderNotifications(notifications, enabled) {
    currentNotifCount = (notifications || []).length;

    // Badge (only show new ones since last panel open)
    const newCount = Math.max(0, currentNotifCount - lastSeenCount);
    if (!panelOpen && newCount > 0) {
      badge.textContent = newCount > 99 ? '99+' : String(newCount);
      badge.style.display = 'flex';
    } else if (panelOpen || newCount === 0) {
      badge.style.display = 'none';
    }

    if (!notifications || notifications.length === 0) {
      list.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'bettersuno-empty';
      emptyDiv.textContent = 'No notifications yet';
      list.appendChild(emptyDiv);
      return;
    }

    list.textContent = '';
    currentNotifications = notifications;
    renderedNotificationCount = 0;
    list.scrollTop = 0;
    ensureNotificationSentinel();
    renderNotificationChunk();
  }

  // ---- Guard: detect invalidated extension context ----
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch { return false; }
  }

  // ---- Fetch state from background and render ----
  let refreshInterval;

  function renderCurrentState() {
    try {
      chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
        if (!chrome.runtime.lastError && response) {
          renderNotifications(response.notifications, response.enabled);
        }
      });
    } catch (e) {
      console.debug('[BetterSuno] Could not refresh state');
    }
  }

  function claimRefreshHost() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'contentClaimRefreshHost' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(false);
            return;
          }

          isNotificationsRefreshHost = response.isOwner === true;
          resolve(isNotificationsRefreshHost);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function refresh() {
    if (!isContextValid()) {
      clearInterval(refreshInterval);
      androidFirefoxKeepAliveManager.stop();
      root.remove();
      return;
    }

    await claimRefreshHost();

    if (!isNotificationsRefreshHost) {
      renderCurrentState();
      return;
    }

    // ask the background to fetch current notifications from Suno
    chrome.runtime.sendMessage({ type: 'contentFetchExisting' }, () => {
      renderCurrentState();
    });
  }

  // ---- Listen for live updates ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'bettersunoProbeTab') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'androidKeepAliveControl') {
      applyAndroidFirefoxKeepAliveControl(msg);
      return;
    }

    if (msg.type === 'stateUpdate') {
      // previous versions filtered for "global" only; after the
      // background started sending both tab-specific and global
      // updates this restriction was unnecessary and in fact meant the
      // UI would never refresh on Chrome.  Just render whatever we get.
      const newNotifs = msg.state.notifications || [];
      // Detect "append older" update: same newest item, list grew, all current items already rendered
      if (
        currentNotifications.length > 0 &&
        renderedNotificationCount === currentNotifications.length &&
        newNotifs.length > currentNotifications.length &&
        newNotifs[0]?.id === currentNotifications[0]?.id
      ) {
        const appendStart = currentNotifications.length;
        currentNotifications = newNotifs;
        currentNotifCount = newNotifs.length;
        const end = Math.min(appendStart + NOTIFICATION_RENDER_BATCH_SIZE, currentNotifications.length);
        if (appendStart < end) {
          const fragment = document.createDocumentFragment();
          for (let i = appendStart; i < end; i++) {
            fragment.appendChild(createNotificationItem(currentNotifications[i]));
          }
          if (notificationsSentinel) {
            list.insertBefore(fragment, notificationsSentinel);
          } else {
            list.appendChild(fragment);
          }
          renderedNotificationCount = end;
        }
        updateNotificationSentinelState();
      } else {
        olderNotificationsExhausted = false;
        renderNotifications(newNotifs, msg.state.enabled);
      }
    }
  });

  // ---- Ensure button stays visible (combat Suno's CSS/JS that may hide it) ----
  function ensureVisibility() {
    // Re-attach root if Suno replaces/removes body children during SPA updates.
    if (!document.documentElement.contains(root)) {
      if (document.body) {
        document.body.appendChild(root);
      } else {
        document.documentElement.appendChild(root);
      }
    }

    root.style.setProperty('position', 'fixed', 'important');
    root.style.setProperty('top', '20px', 'important');
    root.style.setProperty('left', '20px', 'important');
    root.style.setProperty('right', 'auto', 'important');
    root.style.setProperty('bottom', 'auto', 'important');
    root.style.setProperty('display', 'block', 'important');
    root.style.setProperty('visibility', 'visible', 'important');
    root.style.setProperty('opacity', '1', 'important');
    root.style.setProperty('pointer-events', 'auto', 'important');
    root.style.setProperty('z-index', '9999999999', 'important');

    bell.style.setProperty('display', 'flex', 'important');
    bell.style.setProperty('visibility', 'visible', 'important');
    bell.style.setProperty('opacity', '1', 'important');
    bell.style.setProperty('pointer-events', 'auto', 'important');
  }

  // Run periodic visibility check as a fallback for cases the MutationObserver misses.
  // Keep this infrequent: MutationObserver and visibility events cover most updates.
  const VISIBILITY_CHECK_INTERVAL_VISIBLE_MS = 30000;
  const VISIBILITY_CHECK_INTERVAL_HIDDEN_MS = 120000;
  let visibilityCheckInterval = null;

  function restartVisibilityCheckInterval() {
    if (visibilityCheckInterval) {
      clearInterval(visibilityCheckInterval);
    }

    const intervalMs = document.visibilityState === 'visible'
      ? VISIBILITY_CHECK_INTERVAL_VISIBLE_MS
      : VISIBILITY_CHECK_INTERVAL_HIDDEN_MS;

    visibilityCheckInterval = setInterval(ensureVisibility, intervalMs);
  }

  restartVisibilityCheckInterval();
  ensureVisibility();

  // Watch for DOM mutations and re-assert visibility after route/layout changes.
  // Debounced to avoid hammering on the many rapid mutations Suno's SPA produces.
  let _visibilityDebounce = null;
  const visibilityObserver = new MutationObserver(() => {
    clearTimeout(_visibilityDebounce);
    _visibilityDebounce = setTimeout(() => {
      _visibilityDebounce = null;
      ensureVisibility();
    }, 50);
  });
  visibilityObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // ============================================================================
  // Notifications Initialization — (downloader.js handles Library tab)
  // ============================================================================

  // Initial fetch
  refresh();
  requestAndroidFirefoxKeepAliveState();

  document.addEventListener('visibilitychange', () => {
    restartVisibilityCheckInterval();
    if (document.visibilityState === 'visible') {
      requestAndroidFirefoxKeepAliveState();
    }
  }, { passive: true });

  const releaseAndroidFirefoxKeepAlive = () => {
    if (visibilityCheckInterval) {
      clearInterval(visibilityCheckInterval);
      visibilityCheckInterval = null;
    }
    visibilityObserver.disconnect();

    androidFirefoxKeepAliveManager.stop();

    if (!androidFirefoxKeepAliveIsOwner || !isContextValid()) {
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: 'contentReleaseAndroidKeepAlive' });
    } catch (e) {
      console.debug('[BetterSuno] Could not release Android Firefox keepalive state');
    }
  };

  window.addEventListener('pagehide', releaseAndroidFirefoxKeepAlive, { passive: true });
  window.addEventListener('beforeunload', releaseAndroidFirefoxKeepAlive, { passive: true });

  // Auto-load existing notifications if there are none stored yet
  try {
    chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (!response.notifications || response.notifications.length === 0) {
        claimRefreshHost().then((isOwner) => {
          if (!isOwner) {
            renderCurrentState();
            return;
          }

          try {
            chrome.runtime.sendMessage({ type: 'contentFetchExisting' }, () => {
              refresh();
            });
          } catch (e) {
            console.debug('[BetterSuno] Could not fetch existing notifications');
          }
        });
      }
    });
  } catch (e) {
    console.debug('[BetterSuno] Extension context unavailable');
  }

  // Periodic refresh as fallback (in case stateUpdate messages are missed).
  refreshInterval = setInterval(() => {
    refresh();
  }, 30000);
})();
