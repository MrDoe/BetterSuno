// content.js — Floating notification panel injected into suno.com
(function () {
  if (document.getElementById('bettersuno-root')) return; // already injected

  // Track how many notifications we've seen so we know which are "new"
  let lastSeenCount = 0;
  let panelOpen = false;
  let currentTab = 'notifications';

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
        <button class="bettersuno-tab active" data-tab="notifications">Notifications</button>
        <button class="bettersuno-tab"  data-tab="library">Download Songs</button>
        <button class="bettersuno-tab" data-tab="settings">Settings</button>
      </div>
      <div id="bettersuno-list" class="bettersuno-content">
        <div class="bettersuno-empty">No notifications yet</div>
      </div>
      <div id="bettersuno-download-content" class="bettersuno-content" style="display: none;">
        <div id="bettersuno-downloader-wrapper">
          <div id="songListContainer">
            <div id="downloadTypeControls">
              <label>Download:</label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="downloadMusic" checked /> 🎵 Music
              </label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="downloadLyrics" checked /> 📝 Lyrics
              </label>
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="downloadImage" checked /> 🖼️ Image
              </label>
              <div id="fileFormat">
                <label>File Format:</label>
                <div id="formatControls" style="display: flex; gap: 10px; align-items: center">
                  <label class="checkbox-label" style="margin: 0; padding: 0">
                    <input type="radio" name="format" id="formatMp3" value="mp3" checked /> 🎵 MP3
                  </label>
                  <label class="checkbox-label" style="margin: 0; padding: 0">
                    <input type="radio" name="format" id="formatWav" value="wav" /> 🔊 WAV
                  </label>
                </div>
              </div>
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
                <input type="checkbox" id="filterPublic" /> 🌐 Public
              </label>
            </div>

            <input type="text" id="filterInput" placeholder="🔍 Search songs by title..." />

            <span id="selectControls">
              <label class="checkbox-label" style="margin: 0; padding: 0">
                <input type="checkbox" id="selectAll" /> Select All
              </label>
              <span id="songCount">0 songs</span>
            </span>

            <div id="songList"></div>

            <div class="btn-row">
              <button id="downloadBtn" class="btn-primary" style="flex: 2">Download Selected</button>
              <button id="stopDownloadBtn" class="btn-stop hidden">Stop</button>
            </div>
            <div class="btn-row" style="margin-top: 4px;">
              <button id="cacheAllBtn" class="btn-secondary" style="flex: 2" title="Download all songs as MP3 into the browser database for offline playback">💾 Cache All Songs</button>
              <button id="stopCacheBtn" class="btn-stop hidden">Stop</button>
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
          <div class="bettersuno-setting-row" style="display: inline-flex; gap: 5px; align-items: flex-start;">
            <button id="bettersuno-fetch-songs-btn" class="btn-primary" style="padding: 8px 16px; cursor: pointer;">Fetch Songs</button>
            <button id="bettersuno-stop-fetch-btn" class="btn-stop" style="padding: 8px 16px; cursor: pointer; display: none;">Stop Fetch</button>
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
      } else if (tab === 'library') {
        list.style.display = 'none';
        settingsContent.style.display = 'none';
        libraryContent.style.display = 'block';
      } else {
        list.style.display = 'none';
        settingsContent.style.display = 'block';
        libraryContent.style.display = 'none';
        loadSettings();
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
      // confirm with the user before doing a full fetch
      const ok = confirm("Fetch your entire song library from Suno? This may take a while. Proceed?");
      if (!ok) {
        return;
      }

      // hide the button immediately to prevent multiple clicks
      fetchSongsBtn.style.display = 'none';
      
      try {
        chrome.runtime.sendMessage({
          action: 'fetch_songs',
          isPublicOnly: false,
          maxPages: 0
        });
      } catch (e) {
        console.debug('[BetterSuno] Could not send fetch songs command');
      }
      
      // Re-enable button after fetching completes (downloader.js will send a message when done)
      
      
      console.log('[BetterSuno] Fetch songs request sent');
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

    // Clear and rebuild notification list using DOM methods
    list.textContent = '';
    notifications.slice(0, 50).forEach(n => {
      const d = describeNotif(n);
      
      const itemDiv = document.createElement('div');
      itemDiv.className = 'bettersuno-item';
      
      // Avatar
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
      
      // Body
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
      
      // Content image
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
      
      list.appendChild(itemDiv);
    });
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
  chrome.runtime.onMessage.addListener((msg) => {
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
    root.style.setProperty('bottom', '20px', 'important');
    root.style.setProperty('right', '20px', 'important');
    root.style.setProperty('left', 'auto', 'important');
    root.style.setProperty('top', 'auto', 'important');
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

  // Run visibility check frequently to ensure bell always stays visible.
  let visibilityCheckInterval = setInterval(ensureVisibility, 100);
  ensureVisibility();

  // Watch for DOM mutations and immediately re-assert visibility after route/layout changes.
  const visibilityObserver = new MutationObserver(() => ensureVisibility());
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

  // Periodic refresh as fallback (in case stateUpdate messages are missed)
  refreshInterval = setInterval(refresh, 30000);
})();
