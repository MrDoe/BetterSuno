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

  // ---- Build DOM ----
  const root = document.createElement('div');
  root.id = 'bettersuno-root';

  root.innerHTML = `
    <div id="bettersuno-panel">
      <div id="bettersuno-header">
        <h3 id="bettersuno-title">BetterSuno</h3>
        <span class="bettersuno-status" id="bettersuno-status">inactive</span>
        <!-- refresh button allows manual fetch of latest notifications -->
        <button id="bettersuno-refresh" title="Refresh notifications" style="margin-left:8px;">⟳</button>
      </div>
      <div id="bettersuno-tabs">
        <button class="bettersuno-tab active" data-tab="library">Song Library</button>
        <button class="bettersuno-tab" data-tab="player">Player</button>
        <button class="bettersuno-tab" data-tab="notifications">Notifications</button>
        <button class="bettersuno-tab" data-tab="settings">Settings</button>
      </div>
      <div id="bettersuno-duplicate-tab-notice" class="bettersuno-duplicate-notice" style="display:none;">
        ⚠️ BetterSuno is already running in another tab
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
              <button id="refreshPlaylistsBtn" class="btn-secondary" title="Refresh playlists from Suno" type="button">⟳</button>
            </div>

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
            </div>

            <input type="text" id="filterInput" placeholder="🔍 Search songs by title..." />

            <span id="selectControls">
              <button id="selectAll" class="btn-secondary" type="button" aria-pressed="false">Select All</button>
              <button id="cacheAllBtn" class="btn-secondary" title="Download selected songs as MP3 into the browser database for offline playback">Download to DB</button>
              <button id="stopCacheBtn" class="btn-stop hidden">Stop</button>
              <button id="deleteCachedBtn" class="btn-danger" title="Delete the selected songs from the browser database">Delete from DB</button>
              <button id="syncNewBtn" class="btn-secondary" title="Fetch only songs that are newer than your current local library">Sync New</button>
              <span id="songCount">0 songs</span>
            </span>

            <div id="songList"></div>

            <div class="btn-row btn-row-actions">
              <div id="downloadTypeControls">
                <label>Download:</label>
                <label class="checkbox-label" style="margin: 0; padding: 0">
                  <input type="checkbox" id="downloadMusic" checked />🎵 Music
                </label>
                <label class="checkbox-label" style="margin: 0; padding: 0">
                  <input type="checkbox" id="downloadLyrics" checked />📝 Lyrics
                </label>
                <label class="checkbox-label" style="margin: 0; padding: 0">
                  <input type="checkbox" id="downloadImage" checked />🖼️ Image
                </label>
                <div id="fileFormat">
                  <div id="formatControls" style="display: flex; gap: 6px; align-items: center">
                    <label class="checkbox-label" style="margin: 0; padding: 0">
                      <input type="radio" name="format" id="formatMp3" value="mp3" checked />MP3
                    </label>
                    <label class="checkbox-label" style="margin: 0; padding: 0">
                      <input type="radio" name="format" id="formatWav" value="wav" />WAV
                    </label>
                  </div>
                </div>
              </div>
              <button id="downloadBtn" class="btn-primary">Download</button>
              <button id="stopDownloadBtn" class="btn-stop hidden">Stop</button>
            </div>
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
            <button id="bettersuno-fetch-songs-btn" class="btn-primary" style="padding: 8px 16px; cursor: pointer;">Refresh Library</button>
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
            </div>
            <div class="player-tab-view" id="player-tab-view-cover">
              <div class="player-tab-title" id="player-tab-title"></div>
              <div class="player-tab-art-wrapper" id="player-tab-art-wrapper">
                <video class="player-tab-video-media" id="player-tab-video" style="display: none;" autoplay loop muted playsinline></video>
              </div>
            </div>
            <div class="player-tab-view" id="player-tab-view-lyrics" style="display: none;">
              <div class="player-tab-lyrics-wrapper">
                <div class="player-tab-lyrics" id="player-tab-lyrics">No lyrics available.</div>
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

  document.body.appendChild(root);

  const bell = root.querySelector('#bettersuno-bell');
  const badge = root.querySelector('#bettersuno-badge');
  const panel = root.querySelector('#bettersuno-panel');
  const list = root.querySelector('#bettersuno-list');
  const status = root.querySelector('#bettersuno-status');
  const tabButtons = root.querySelectorAll('.bettersuno-tab');
  const title = root.querySelector('#bettersuno-title');
  const settingsContent = root.querySelector('#bettersuno-settings-content');
  const libraryContent = root.querySelector('#bettersuno-download-content');
  const playerContent = root.querySelector('#bettersuno-player-content');
  
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

  // ---- Manual refresh button ----
  const refreshBtn = root.querySelector('#bettersuno-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refresh();
    });
  }

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
      const tab = e.target.dataset.tab;
      currentTab = tab;
      
      // Update active tab button
      tabButtons.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      // Switch content visibility
      title.textContent = 'BetterSuno';
      
      if (tab === 'notifications') {
        list.style.display = 'block';
        settingsContent.style.display = 'none';
        libraryContent.style.display = 'none';
        playerContent.style.display = 'none';
      } else if (tab === 'library') {
        list.style.display = 'none';
        settingsContent.style.display = 'none';
        libraryContent.style.display = 'flex';
        playerContent.style.display = 'none';
      } else if (tab === 'player') {
        list.style.display = 'none';
        settingsContent.style.display = 'none';
        libraryContent.style.display = 'none';
        playerContent.style.display = 'flex';
      } else {
        list.style.display = 'none';
        settingsContent.style.display = 'block';
        libraryContent.style.display = 'none';
        playerContent.style.display = 'none';
        loadSettings();
        document.dispatchEvent(new CustomEvent('bettersuno:settings-opened'));
      }
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
      
      try {
        chrome.runtime.sendMessage({
          type: 'contentUpdateSettings',
          tabId: 'global',
          settings: {
            enabled: true,
            intervalMs,
            desktopNotificationsEnabled: desktopNotifications
          }
        }, (response) => {
          if (!chrome.runtime.lastError) {
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

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    notificationsSentinel.textContent = remaining > 0
      ? `Scroll to load ${Math.min(remaining, NOTIFICATION_RENDER_BATCH_SIZE)} more notifications`
      : (currentNotifications.length > 0 ? 'All notifications loaded' : '');
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
    // Status indicator
    if (enabled) {
      status.textContent = 'active';
      status.classList.add('active');
    } else {
      status.textContent = 'inactive';
      status.classList.remove('active');
    }

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

  function refresh() {
    // provide immediate UI feedback
    status.textContent = 'refreshing';
    status.classList.remove('active');
    const refreshBtn = root.querySelector('#bettersuno-refresh');
    if (refreshBtn) {
      refreshBtn.disabled = true;
    }

    if (!isContextValid()) {
      clearInterval(refreshInterval);
      root.remove();
      return;
    }

    // ask the background to fetch current notifications from Suno
    chrome.runtime.sendMessage({ type: 'contentFetchExisting' }, () => {
      // after fetch attempt (success or failure), update our view
      try {
        chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
          if (!chrome.runtime.lastError && response) {
            renderNotifications(response.notifications, response.enabled);
          }
          if (refreshBtn) refreshBtn.disabled = false;
        });
      } catch (e) {
        console.debug('[BetterSuno] Could not refresh state');
        if (refreshBtn) refreshBtn.disabled = false;
      }
    });
  }

  // ---- Listen for live updates ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'bettersunoProbeTab') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'stateUpdate') {
      // previous versions filtered for "global" only; after the
      // background started sending both tab-specific and global
      // updates this restriction was unnecessary and in fact meant the
      // UI would never refresh on Chrome.  Just render whatever we get.
      renderNotifications(msg.state.notifications, msg.state.enabled);
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
  // 2000ms is sufficient because the MutationObserver handles immediate corrections.
  let visibilityCheckInterval = setInterval(ensureVisibility, 2000);
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

  // Auto-load existing notifications if there are none stored yet
  try {
    chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (!response.notifications || response.notifications.length === 0) {
        try {
          chrome.runtime.sendMessage({ type: 'contentFetchExisting' }, () => {
            refresh();
          });
        } catch (e) {
          console.debug('[BetterSuno] Could not fetch existing notifications');
        }
      }
    });
  } catch (e) {
    console.debug('[BetterSuno] Extension context unavailable');
  }

  // Check if the extension is already running in another suno.com tab and update the notice.
  // Called on load and on every periodic refresh so the notice stays in sync as tabs open/close.
  function checkDuplicateTab() {
    try {
      chrome.runtime.sendMessage({ type: 'checkActiveTab' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        const notice = document.getElementById('bettersuno-duplicate-tab-notice');
        if (notice) {
          notice.classList.toggle('is-visible', response.otherTabsCount > 0);
        }
      });
    } catch (e) {
      console.debug('[BetterSuno] Could not check active tabs');
    }
  }

  // Periodic refresh as fallback (in case stateUpdate messages are missed).
  // Also re-checks duplicate tab status so the notice stays current.
  refreshInterval = setInterval(() => {
    refresh();
    checkDuplicateTab();
  }, 30000);

  // Initial duplicate-tab check on load.
  checkDuplicateTab();
})();
