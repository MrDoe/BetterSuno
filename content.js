// content.js — Floating notification panel injected into suno.com
(function () {
  if (document.getElementById('suno-notif-root')) return; // already injected

  // Track how many notifications we've seen so we know which are "new"
  let lastSeenCount = 0;
  let panelOpen = false;

  // ---- Build DOM ----
  const root = document.createElement('div');
  root.id = 'suno-notif-root';

  root.innerHTML = `
    <div id="suno-notif-panel">
      <div id="suno-notif-header">
        <h3 id="suno-notif-title">BetterSuno</h3>
        <span class="suno-notif-status" id="suno-notif-status">inactive</span>
      </div>
      <div id="suno-notif-tabs">
        <button class="suno-notif-tab active" data-tab="notifications">Notifications</button>
        <button class="suno-notif-tab"  data-tab="library">Download Songs</button>
        <button class="suno-notif-tab" data-tab="settings">Settings</button>
      </div>
      <div id="suno-notif-list" class="suno-notif-content">
        <div class="suno-notif-empty">No notifications yet</div>
      </div>
      <div id="suno-notif-library-content" class="suno-notif-content" style="display: none;">
        <div id="suno-downloader-wrapper">
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
                <input type="checkbox" id="selectAll" checked /> Select All
              </label>
              <span id="songCount">0 songs</span>
            </span>

            <div id="songList"></div>

            <div class="btn-row">
              <button id="downloadBtn" class="btn-primary" style="flex: 2">Download Selected</button>
              <button id="stopDownloadBtn" class="btn-stop hidden">Stop</button>
            </div>
          </div>

          <div id="status" role="status" aria-live="polite">Ready...</div>
          <div id="versionFooter" class="version-footer"></div>
        </div>
      </div>
      <div id="suno-notif-settings-content" class="suno-notif-content" style="display: none;">
        <div class="suno-notif-settings-form">
          <div class="suno-notif-setting-row">
            <label>Polling Interval (seconds):</label>
            <input type="number" id="suno-setting-interval" class="suno-setting" data-key="intervalMs" min="10" step="10" value="120">
          </div>
          <div class="suno-notif-setting-row">
            <label>
              <input type="checkbox" checked="" id="suno-setting-desktop" class="suno-setting" data-key="desktopNotificationsEnabled">
              Desktop Notifications
            </label>
          </div>
          <div class="suno-notif-setting-row">
            <label>Download Folder:</label>
            <input type="text" id="folder" class="suno-setting" data-key="downloadFolder" value="Suno_Songs" placeholder="Folder name in Downloads" style="flex: 1;" />
          </div>
          <div class="suno-notif-setting-row">
            <button id="suno-fetch-songs-btn" class="btn-primary" style="padding: 8px 16px; cursor: pointer;">Fetch Songs</button>
          </div>
        </div>
      </div>
    </div>
    <button id="suno-notif-bell" title="BetterSuno">
      <svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2Zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2Z"/></svg>
      <span id="suno-notif-badge">0</span>
    </button>
  `;

  document.body.appendChild(root);

  const bell = root.querySelector('#suno-notif-bell');
  const badge = root.querySelector('#suno-notif-badge');
  const panel = root.querySelector('#suno-notif-panel');
  const list = root.querySelector('#suno-notif-list');
  const status = root.querySelector('#suno-notif-status');
  const tabButtons = root.querySelectorAll('.suno-notif-tab');
  const title = root.querySelector('#suno-notif-title');
  const settingsContent = root.querySelector('#suno-notif-settings-content');
  const libraryContent = root.querySelector('#suno-notif-library-content');
  
  // ---- Toggle panel ----
  bell.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) {
      // Mark all current notifications as seen
      lastSeenCount = currentNotifCount;
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  });

  // Close panel on outside click
  document.addEventListener('click', (e) => {
    if (panelOpen && !root.contains(e.target)) {
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
        
        document.getElementById('suno-setting-interval').value = (state.intervalMs || 120000) / 1000;
        document.getElementById('suno-setting-desktop').checked = state.desktopNotificationsEnabled !== false;
      });
    } catch (e) {
      console.debug('[SunoNotif] Extension context unavailable');
    }
  }

  // ---- Save settings on change ----
  const settingsControls = root.querySelectorAll('.suno-setting');
  settingsControls.forEach(control => {
    control.addEventListener('change', () => {
      const intervalSeconds = Number(document.getElementById('suno-setting-interval').value);
      const intervalMs = intervalSeconds * 1000;
      const desktopNotifications = document.getElementById('suno-setting-desktop').checked;
      
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
            console.log('[SunoNotif] Settings updated');
          }
        });
      } catch (e) {
        console.debug('[SunoNotif] Could not send settings update');
      }
    });
  });

  // ---- Fetch Songs button ----
  const fetchSongsBtn = root.querySelector('#suno-fetch-songs-btn');
  if (fetchSongsBtn) {
    fetchSongsBtn.addEventListener('click', () => {
      fetchSongsBtn.disabled = true;
      fetchSongsBtn.textContent = 'Fetching...';
      
      try {
        chrome.runtime.sendMessage({
          action: 'fetch_songs',
          isPublicOnly: false,
          maxPages: 0
        });
      } catch (e) {
        console.debug('[SunoNotif] Could not send fetch songs command');
      }
      
      // Re-enable button after a short delay
      setTimeout(() => {
        fetchSongsBtn.disabled = false;
        fetchSongsBtn.textContent = 'Fetch Songs';
      }, 1000);
      
      console.log('[SunoNotif] Fetch songs request sent');
    });
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
      list.innerHTML = '<div class="suno-notif-empty">No notifications yet</div>';
      return;
    }

    const html = notifications.slice(0, 50).map(n => {
      const d = describeNotif(n);
      const avatarHtml = d.avatar
        ? `<a href="https://suno.com/@${d.firstHandle}" target="_blank"><img class="suno-notif-avatar" src="${d.avatar}"></a>`
        : '';
      const contentImgHtml = d.contentImg
        ? `<a href="${d.url}" target="_blank"><img class="suno-notif-content-img" src="${d.contentImg}"></a>`
        : '';

      return `
        <div class="suno-notif-item">
          ${avatarHtml}
          <div class="suno-notif-body">
            <div class="suno-notif-text">
              <a href="https://suno.com/@${d.firstHandle}" target="_blank">${d.who}</a>
              ${d.text}
            </div>
            <div class="suno-notif-time">${formatAgo(d.ts)}</div>
          </div>
          ${contentImgHtml}
        </div>
      `;
    }).join('');

    list.innerHTML = html;
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
    try {
      if (!isContextValid()) {
        clearInterval(refreshInterval);
        root.remove();
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'contentGetState' }, (response) => {
          if (chrome.runtime.lastError || !response) return;
          renderNotifications(response.notifications, response.enabled);
        });
      } catch (e) {
        console.debug('[SunoNotif] Could not refresh state');
      }
    } catch (e) {
      // Extension context invalidated (likely extension reloaded)
      clearInterval(refreshInterval);
      root.remove();
    }
  }

  // ---- Listen for live updates ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'stateUpdate' && msg.tabId === 'global') {
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
          console.debug('[SunoNotif] Could not fetch existing notifications');
        }
      }
    });
  } catch (e) {
    console.debug('[SunoNotif] Extension context unavailable');
  }

  // Periodic refresh as fallback (in case stateUpdate messages are missed)
  refreshInterval = setInterval(refresh, 30000);
})();
