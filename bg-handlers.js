// bg-handlers.js — Extracted message handlers for background.js
import * as IDBStore from './idb-store.js';

export const HANDLERS = {
  offscreenRequestToken: handleOffscreenRequestToken,
  offscreenStateUpdate: handleOffscreenStateUpdate,
  offscreenTokenExpired: handleOffscreenTokenExpired,
  offscreenNoToken: handleOffscreenTokenExpired,
  contentGetState: handleContentGetState,
  contentSyncAndroidKeepAlive: handleContentSyncAndroidKeepAlive,
  contentReleaseAndroidKeepAlive: handleContentReleaseAndroidKeepAlive,
  checkActiveTab: handleCheckActiveTab,
  contentClaimRefreshHost: handleContentClaimRefreshHost,
  contentFetchExisting: handleContentFetchExisting,
  contentFetchOlder: handleContentFetchOlder,
  uiInit: handleUiInit,
  setConfig: handleSetConfig,
  clearNotifications: handleClearNotifications,
  contentUpdateSettings: handleContentUpdateSettings,
  offscreenKeepalivePing: handleOffscreenKeepalivePing,
  pingMainWorld: handlePingMainWorld,
  fetch_songs_by_ids: handleFetchSongsByIds,
  fetch_feed_page: handleFetchFeedPage,
  fetch_user_playlists: handleFetchUserPlaylists,
  fetch_playlist_info: handleFetchPlaylistInfo,
  search_playlists: handleSearchPlaylists,
  get_current_user_identity: handleGetCurrentUserIdentity,
  fetch_playlist_songs: handleFetchPlaylistSongs,
  playlist_add_songs: handlePlaylistMutation,
  playlist_remove_songs: handlePlaylistMutation,
  playlist_reorder_songs: handlePlaylistMutation,
  resolve_song_cover_video: handleResolveSongCoverVideo,
  fetch_song_comments: handleFetchSongComments,
  update_comment_reaction: handleUpdateCommentReaction,
  post_song_comment: handlePostSongComment,
  update_song_reaction: handleUpdateSongReaction,
  set_song_metadata: handleSetSongMetadata,
  fetch_songs: handleFetchSongs,
  get_fetch_state: handleGetFetchState,
  stop_fetch: handleStopFetch,
  check_stop: handleCheckStop,
  download_selected: handleDownloadSelected,
  stop_download: handleStopDownload,
  get_download_state: handleGetDownloadState,
  songs_list: handleSongsList,
  songs_page: handleSongsPage,
  fetch_error_internal: handleFetchErrorInternal,
  log: handleLog,
  save_prompt: handleSavePrompt,
  get_prompts: handleGetPrompts,
  delete_prompt: handleDeletePrompt,
  fetch_personas: handleFetchPersonas,
  generate_song: handleGenerateSong,
};

function handleOffscreenRequestToken(msg, sender, sendResponse, ctx) {
  ctx.log("[NVO] offscreenRequestToken received for tab", msg.tabId);
  ctx.ensureValidToken(msg.tabId).then(token => {
    if (!token) {
      ctx.log("[NVO] offscreenRequestToken → ensureValidToken returned NULL for tab", msg.tabId);
    } else {
      ctx.log("[NVO] offscreenRequestToken → returning token", token.slice(0, 12), "…", "for tab", msg.tabId);
    }
    sendResponse({ token });
  });
  return true;
}

function handleOffscreenStateUpdate(msg, sender, sendResponse, ctx) {
  const st = ctx.ensureTabState(msg.tabId);
  Object.assign(st, msg.state);
  ctx.showDesktopNotifications(msg.tabId, st);
  ctx.saveState();
  ctx.safeRuntimeSendMessage({
    type: "stateUpdate",
    tabId: msg.tabId,
    state: { ...st }
  });
  const globalSt = ctx.ensureTabState("global");
  globalSt.notifications = st.notifications;
  globalSt.lastNotificationTime = st.lastNotificationTime;
  globalSt.enabled = st.enabled;
  globalSt.intervalMs = st.intervalMs;
  globalSt.desktopNotificationsEnabled = st.desktopNotificationsEnabled;
  ctx.safeRuntimeSendMessage({
    type: "stateUpdate",
    tabId: "global",
    state: { ...globalSt }
  });
  sendResponse({ ok: true });
  return true;
}

function handleOffscreenTokenExpired(msg, sender, sendResponse, ctx) {
  ctx.log("[NVO] Token expired/missing for Tab", msg.tabId, "- triggering refresh");
  const st = ctx.ensureTabState(msg.tabId);
  st.token = null;
  st.tokenTimestamp = null;
  sendResponse({ ok: true });
  return true;
}

function handleContentGetState(msg, sender, sendResponse, ctx) {
  const st = ctx.ensureTabState("global");
  sendResponse({
    notifications: st.notifications || [],
    enabled: st.enabled,
    intervalMs: st.intervalMs,
    desktopNotificationsEnabled: st.desktopNotificationsEnabled,
    androidFirefoxKeepAliveEnabled: st.androidFirefoxKeepAliveEnabled === true,
    initialAfterUtc: st.initialAfterUtc
  });
  return true;
}

function handleContentSyncAndroidKeepAlive(msg, sender, sendResponse, ctx) {
  const senderTabId = sender.tab?.id;
  ctx.syncAndroidFirefoxKeepAliveState(senderTabId).then(state => {
    sendResponse({ ...state, isOwner: typeof senderTabId === 'number' && state.ownerTabId === senderTabId });
  }).catch(err => {
    sendResponse({
      enabled: ctx.ensureTabState("global").androidFirefoxKeepAliveEnabled === true,
      isOwner: false,
      ownerTabId: ctx.androidFirefoxKeepAliveMasterTabId,
      error: err.message
    });
  });
  return true;
}

function handleContentReleaseAndroidKeepAlive(msg, sender, sendResponse, ctx) {
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId === 'number' && ctx.androidFirefoxKeepAliveMasterTabId === senderTabId) {
    ctx.androidFirefoxKeepAliveMasterTabId = null;
  }
  ctx.syncAndroidFirefoxKeepAliveState(null).then(state => {
    sendResponse({ ...state, isOwner: false });
  }).catch(err => {
    sendResponse({ ok: false, error: err.message });
  });
  return true;
}

function handleCheckActiveTab(msg, sender, sendResponse, ctx) {
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId !== 'number' || Number.isNaN(senderTabId)) {
    sendResponse({ otherTabsCount: 0 });
    return true;
  }
  chrome.tabs.query({ url: "https://suno.com/*" }).then(async tabs => {
    const candidateTabs = tabs.filter(t => t.id !== senderTabId && typeof t.id === 'number');
    const probeResults = await Promise.all(candidateTabs.map(t => ctx.hasLiveBetterSunoContentScript(t.id)));
    sendResponse({ otherTabsCount: probeResults.filter(Boolean).length });
  }).catch(() => {
    sendResponse({ otherTabsCount: 0 });
  });
  return true;
}

function handleContentClaimRefreshHost(msg, sender, sendResponse, ctx) {
  const senderTabId = sender.tab?.id;
  ctx.claimNotificationsRefreshHost(senderTabId).then(result => {
    sendResponse(result);
  }).catch(() => {
    sendResponse({ isOwner: false, ownerTabId: ctx.notificationsRefreshHostTabId });
  });
  return true;
}

function handleContentFetchExisting(msg, sender, sendResponse, ctx) {
  ctx.log("contentFetchExisting: message received, starting fetch");
  ctx.stateReadyPromise.then(() => {
    ctx.fetchExistingNotifications().then(result => {
      ctx.log("contentFetchExisting: result =", result);
      sendResponse(result);
    }).catch(err => {
      ctx.log("contentFetchExisting: error =", err.message);
      sendResponse({ ok: false, reason: err.message });
    });
  });
  return true;
}

function handleContentFetchOlder(msg, sender, sendResponse, ctx) {
  const { beforeUtc } = msg;
  ctx.stateReadyPromise.then(() => {
    ctx.fetchOlderNotifications(beforeUtc).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ ok: false, reason: err.message, count: 0 });
    });
  });
  return true;
}

function handleUiInit(msg, sender, sendResponse, ctx) {
  const st = ctx.ensureTabState(msg.tabId);
  sendResponse({ state: { ...st } });
  return true;
}

function handleSetConfig(msg, sender, sendResponse, ctx) {
  const st = ctx.notificationWorkerState();
  const oldEnabled = st.enabled;
  st.enabled = msg.enabled;
  st.intervalMs = msg.intervalMs;
  if (msg.desktopNotificationsEnabled !== undefined) {
    st.desktopNotificationsEnabled = msg.desktopNotificationsEnabled;
  }
  if (st.initialAfterUtc !== msg.initialAfterUtc) {
    st.initialAfterUtc = msg.initialAfterUtc;
    st.lastNotificationTime = null;
    st.notifications = [];
  }
  if (st.enabled) {
    if (oldEnabled !== st.enabled || !st.activatedAt) {
      st.activatedAt = new Date().toISOString();
      st.requestCount = 0;
      st.totalRequests = 0;
      ctx.log("✓ Collector activated for worker", ctx.COLLECTOR_STATE_KEY);
      ctx.ensureValidToken(ctx.COLLECTOR_STATE_KEY).then(token => {
        if (token) {
          ctx.log("✓ Initial token fetch successful");
          ctx.fetchExistingNotifications();
        } else {
          ctx.log("⚠ Initial token fetch failed - will retry on next alarm");
        }
      });
    }
  } else {
    st.activatedAt = null;
    ctx.log("Collector deactivated for tab", msg.tabId);
  }
  ctx.saveState();
  ctx.syncNotificationWorkerState().catch(err => {
    ctx.log('setConfig: could not synchronize notification worker:', err.message);
  });
  sendResponse({ state: { ...st } });
  return true;
}

function handleClearNotifications(msg, sender, sendResponse, ctx) {
  const st = ctx.notificationWorkerState();
  st.notifications = [];
  ctx.saveState();
  ctx.syncNotificationWorkerState().catch(err => {
    ctx.log('clearNotifications: could not synchronize notification worker:', err.message);
  });
  sendResponse({ state: { ...st } });
  return true;
}

function handleContentUpdateSettings(msg, sender, sendResponse, ctx) {
  const st = ctx.notificationWorkerState();
  const settings = msg.settings || {};
  const shouldSyncNotificationWorker = (
    settings.enabled !== undefined ||
    settings.intervalMs !== undefined ||
    settings.initialAfterUtc !== undefined ||
    settings.desktopNotificationsEnabled !== undefined
  );
  if (settings.enabled !== undefined) st.enabled = settings.enabled;
  if (settings.intervalMs !== undefined) st.intervalMs = settings.intervalMs;
  if (settings.desktopNotificationsEnabled !== undefined) st.desktopNotificationsEnabled = settings.desktopNotificationsEnabled;
  if (settings.androidFirefoxKeepAliveEnabled !== undefined) st.androidFirefoxKeepAliveEnabled = settings.androidFirefoxKeepAliveEnabled === true;
  if (settings.initialAfterUtc !== undefined) st.initialAfterUtc = settings.initialAfterUtc;
  ctx.log("contentUpdateSettings: updated settings for tab", msg.tabId, "- enabled:", st.enabled, "interval:", st.intervalMs);
  ctx.saveState();
  const senderTabId = sender.tab?.id;
  Promise.resolve().then(async () => {
    if (shouldSyncNotificationWorker) {
      await ctx.syncNotificationWorkerState();
    }
    let androidKeepAlive = null;
    if (settings.androidFirefoxKeepAliveEnabled !== undefined) {
      androidKeepAlive = await ctx.syncAndroidFirefoxKeepAliveState(senderTabId);
    }
    sendResponse({
      ok: true,
      state: { ...st },
      androidKeepAlive: androidKeepAlive
        ? { ...androidKeepAlive, isOwner: typeof senderTabId === 'number' && androidKeepAlive.ownerTabId === senderTabId }
        : null
    });
  }).catch(err => {
    sendResponse({ ok: false, error: err.message, state: { ...st } });
  });
  return true;
}

function handleOffscreenKeepalivePing(msg, sender, sendResponse, ctx) {
  const st = ctx.notificationWorkerState();
  if (st.enabled) {
    const preferredTabId = ctx.preferredAndroidKeepAliveTabId();
    ctx.keepAnySunoTabAlive(preferredTabId).catch(err => {
      ctx.log('offscreenKeepalivePing: keepalive failed:', err.message);
    });
  }
  sendResponse({ ok: true });
  return true;
}

function handlePingMainWorld(msg, sender, sendResponse, ctx) {
  if (ctx.isFirefox) {
    sendResponse({ ok: false, reason: "not-supported-firefox" });
    return true;
  }
  const activeTabId = Object.keys(ctx.tabState).find(id => ctx.tabState[id].enabled && !isNaN(Number(id)));
  if (!activeTabId) {
    ctx.log("pingMainWorld → no active tab");
    sendResponse({ ok: false, reason: "no-active-tab" });
    return true;
  }
  chrome.scripting.executeScript({
    target: { tabId: Number(activeTabId), allFrames: false },
    world: "MAIN",
    func: () => {
      window.__suno_ping = (window.__suno_ping || 0) + 1;
      return { pong: window.__suno_ping, ts: Date.now() };
    }
  }, results => {
    if (chrome.runtime.lastError) {
      ctx.log("pingMainWorld executeScript error", chrome.runtime.lastError.message);
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    ctx.log("pingMainWorld result", results);
    sendResponse({ ok: true, result: results });
  });
  return true;
}

function handleFetchSongsByIds(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('fetch_songs_by_ids');
      const songIds = Array.isArray(msg.songIds) ? msg.songIds.filter(id => id !== null && id !== undefined).map(String) : [];
      if (!token || songIds.length === 0) {
        sendResponse({ ok: false, status: 0, error: "Missing token or song IDs" });
        return;
      }
      const targetIds = new Set(songIds.map(id => id.trim()).filter(id => id));
      const directFeedLookup = await ctx.fetchFeedSongsByIds(token, songIds, { logPrefix: 'fetch_songs_by_ids' });
      if (!directFeedLookup.ok && directFeedLookup.status === 429) {
        sendResponse({ ok: false, status: 429, error: 'Rate limited while fetching songs by ids' });
        return;
      }
      let resultSongs = directFeedLookup.clips || [];
      let source = 'feed-by-ids';
      if (resultSongs.length < targetIds.size) {
        const missingIds = songIds.filter(id => !resultSongs.some(song => song?.id === String(id).trim()));
        const identity = await ctx.fetchCurrentUserIdentity(token).catch(() => null);
        const allIdentityIds = new Set(ctx.getIdentityIds(identity));
        const userId = Array.from(allIdentityIds)[0] || null;
        let fallbackSongs = [];
        let fallbackSource = 'bulk-library';
        try {
          const bulkSongs = await ctx.fetchLibrarySongsBulk(token, userId, allIdentityIds, false, { trackAbortController: false });
          if (Array.isArray(bulkSongs)) {
            const songsById = new Map(bulkSongs.map(song => [song.id, song]));
            fallbackSongs = missingIds.map(id => songsById.get(String(id).trim()) || null).filter(Boolean);
          } else {
            fallbackSource = 'paged-library';
          }
        } catch (err) {
          ctx.log('fetch_songs_by_ids: bulk fallback failed, falling back to paged library:', err?.message || String(err));
          fallbackSource = 'paged-library';
        }
        if (fallbackSource === 'paged-library') {
          fallbackSongs = await ctx.fetchLibrarySongsPaged(token, userId, allIdentityIds, false, {
            targetIds: new Set(missingIds.map(id => String(id).trim()).filter(Boolean)),
            trackAbortController: false,
            logPrefix: 'fetch_songs_by_ids'
          });
        }
        if (fallbackSongs.length > 0) {
          const mergedById = new Map(resultSongs.map(song => [String(song.id).trim(), song]));
          fallbackSongs.forEach(song => { if (song?.id) mergedById.set(String(song.id).trim(), song); });
          resultSongs = songIds.map(id => mergedById.get(String(id).trim()) || null).filter(Boolean);
          source = `feed-by-ids+${fallbackSource}`;
        }
      }
      sendResponse({ ok: true, status: 200, data: { clips: resultSongs, count: resultSongs.length, source: resultSongs.length > 0 ? source : 'none' } });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchFeedPage(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const cursorValue = msg.cursor || null;
      const isPublicOnly = !!msg.isPublicOnly;
      const userId = msg.userId || null;
      const body = { limit: 20, filters: { disliked: "False", trashed: "False", fromStudioProject: { presence: "False" } } };
      if (userId) body.filters.user = { presence: "True", user_id: userId };
      if (isPublicOnly) body.filters.public = "True";
      if (cursorValue) body.cursor = cursorValue;

      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await ctx.getApiTokenWithFallback('fetch_feed_page', { forceRefresh: attempt > 0 });
        if (!token) { sendResponse({ ok: false, status: 0, error: "Missing token" }); return; }
        const response = await ctx.fetchFeedV3WithRetry(token, body, { logPrefix: 'fetch_feed_page' });
        if (response.status !== 401 && response.status !== 403) {
          sendResponse({ ok: response.ok, status: response.status, data: response.data || null });
          return;
        }
        ctx.log(`fetch_feed_page: attempt ${attempt + 1} returned ${response.status}, renewing token and retrying`);
      }
      sendResponse({ ok: false, status: 401, data: null, error: 'Token expired after renewal attempt' });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchUserPlaylists(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('fetch_user_playlists');
      if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
      const page = msg.page || 1;
      const response = await fetch(`https://studio-api.prod.suno.com/api/playlist/me?page=${page}&show_trashed=false&show_sharelist=false`, { headers: { 'Authorization': `Bearer ${token}` } });
      const status = response.status;
      let data = null;
      try { data = await response.json(); } catch (e) {}
      sendResponse({ ok: response.ok, status, data });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchPlaylistInfo(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('fetch_playlist_info');
      if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
      const { playlistId } = msg;
      if (!playlistId) { sendResponse({ ok: false, error: "No playlist ID" }); return; }
      const headers = { Authorization: `Bearer ${token}` };
      const enc = encodeURIComponent(playlistId);
      const extractPlaylistPayload = (data) => {
        if (!data || typeof data !== 'object') return null;
        return data.playlist || data.data?.playlist || data.data || data;
      };
      for (const url of [
        `https://studio-api.prod.suno.com/api/playlist/v2/${enc}?page=1&page_size=1`,
        `https://studio-api.prod.suno.com/api/playlist/${enc}?page=1&page_size=1`
      ]) {
        const res = await fetch(url, { headers });
        if (!res.ok) continue;
        let data;
        try { data = await res.json(); } catch (e) { continue; }
        if (!data) continue;
        const playlist = extractPlaylistPayload(data);
        if (!playlist) continue;
        sendResponse({
          ok: true,
          playlist: {
            id: playlist.id || playlistId,
            name: playlist.name || playlist.title || null,
            image_url: playlist.image_url || null,
            song_count: playlist.num_total_results ?? playlist.total ?? playlist.total_results ?? playlist.total_count ?? null,
            is_public: playlist.is_public,
            is_owned: playlist.is_owned,
            is_owned_by_current_user: playlist.is_owned_by_current_user,
            owner_user_id: playlist.owner_user_id || playlist.user_id || playlist.creator_user_id || playlist.author_user_id || null,
            owner_handle: playlist.owner_handle || playlist.user_handle || playlist.creator_handle || playlist.author_handle || null,
            owner_display_name: playlist.owner_display_name || playlist.user_display_name || playlist.creator_display_name || playlist.author_display_name || null
          }
        });
        return;
      }
      sendResponse({ ok: false, error: 'Playlist not found' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleSearchPlaylists(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('search_playlists');
      if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
      const { query } = msg;
      if (!query) { sendResponse({ ok: false, error: "No search query" }); return; }
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const body = JSON.stringify({
        search_queries: [{ name: "playlists", search_type: "playlist", term: query, from_index: 0, size: 100, rank_by: "most_relevant" }],
        tune_results: false, tuned_offset: 0
      });
      const res = await fetch(`https://studio-api.prod.suno.com/api/search/`, { method: 'POST', headers, body });
      if (!res.ok) { sendResponse({ ok: false, error: `Search failed with status ${res.status}` }); return; }
      const data = await res.json();
      let rawPlaylists = [];
      if (data?.result?.playlist?.result) rawPlaylists = data.result.playlist.result;
      else if (data?.result?.playlists?.result) rawPlaylists = data.result.playlists.result;
      else if (data?.playlists) rawPlaylists = data.playlists;
      const playlists = rawPlaylists.map(pl => ({
        id: pl.id, name: pl.name || pl.title || null, image_url: pl.image_url || null,
        song_count: pl.song_count ?? pl.num_total_results ?? null,
        user_display_name: pl.user_display_name || pl.user_handle || null,
        user_handle: pl.user_handle || null, is_public: pl.is_public ?? true,
        is_owned: pl.is_owned, is_owned_by_current_user: pl.is_owned_by_current_user,
        owner_user_id: pl.owner_user_id || pl.user_id || pl.creator_user_id || pl.author_user_id || null,
        owner_handle: pl.owner_handle || pl.user_handle || pl.creator_handle || pl.author_handle || null,
        owner_display_name: pl.owner_display_name || pl.user_display_name || pl.creator_display_name || pl.author_display_name || pl.user_handle || null,
        description: pl.description || ""
      }));
      sendResponse({ ok: true, playlists });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleGetCurrentUserIdentity(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      ctx.log('[get_current_user_identity] Message handler called');
      const token = await ctx.getApiTokenWithFallback('get_current_user_identity');
      if (!token) { ctx.log('[get_current_user_identity] No auth token available'); sendResponse({ ok: false, error: 'No auth token' }); return; }
      ctx.log('[get_current_user_identity] Calling fetchCurrentUserIdentity...');
      const identity = await ctx.fetchCurrentUserIdentity(token);
      ctx.log('[get_current_user_identity] Received identity:', identity);
      if (!identity?.id && !identity?.handle && !identity?.displayName) {
        ctx.log('[get_current_user_identity] Identity invalid - no id, handle, or displayName');
        sendResponse({ ok: false, error: 'Could not determine current user identity' });
        return;
      }
      ctx.log('[get_current_user_identity] Sending identity to downloader:', identity);
      sendResponse({ ok: true, identity });
    } catch (e) {
      ctx.log('[get_current_user_identity] Exception:', e?.message || String(e));
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchPlaylistSongs(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('fetch_playlist_songs');
      if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
      const { playlistId: rawPlaylistId, page = 1 } = msg;
      if (!rawPlaylistId) { sendResponse({ ok: false, error: "No playlist ID" }); return; }
      const normalizePlaylistId = (raw) => {
        if (!raw || typeof raw !== 'string') return '';
        const trimmed = raw.trim();
        const urlMatch = trimmed.match(/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || trimmed.match(/playlist\/([0-9a-f-]{30,36})/i);
        return urlMatch ? urlMatch[1] : trimmed;
      };
      const playlistId = normalizePlaylistId(rawPlaylistId);
      if (!playlistId) { sendResponse({ ok: false, error: "Invalid playlist ID" }); return; }
      const headers = { 'Authorization': `Bearer ${token}` };
      const jsonHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
      const pid = encodeURIComponent(playlistId);
      const candidates = [
        { label: 'playlist-v2-detail', method: 'GET', url: `https://studio-api.prod.suno.com/api/playlist/v2/${pid}?page=${page}&page_size=50`, headers },
        { label: 'playlist-detail', method: 'GET', url: `https://studio-api.prod.suno.com/api/playlist/${pid}?page=${page}&page_size=50`, headers },
        { label: 'playlist-clips', method: 'GET', url: `https://studio-api.prod.suno.com/api/playlist/${pid}/clips?page=${page}&page_size=50`, headers },
        { label: 'feed-v3-playlist-filter', method: 'POST', url: 'https://studio-api.prod.suno.com/api/feed/v3', headers: jsonHeaders, body: { limit: 50, cursor: null, filters: { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, playlist: { presence: 'True', playlistId } } } }
      ];
      const tryParse = async (response) => { let data = null; try { data = await response.json(); } catch (e) {} return data; };
      const findClipArray = (data) => {
        if (!data || typeof data !== 'object') return null;
        if (Array.isArray(data) && data.length > 0) return data;
        const knownPaths = [
          data.playlist_clips, data.playlist_songs, data.songs, data.tracks, data.entries, data.clips, data.results, data.items,
          data.playlist?.playlist_clips, data.playlist?.playlist_songs, data.playlist?.songs, data.playlist?.tracks, data.playlist?.entries, data.playlist?.clips, data.playlist?.results, data.playlist?.items,
          data.data?.playlist_clips, data.data?.playlist_songs, data.data?.songs, data.data?.tracks, data.data?.entries, data.data?.clips, data.data?.results, data.data?.items,
          data.data?.playlist?.playlist_clips, data.data?.playlist?.playlist_songs, data.data?.playlist?.songs, data.data?.playlist?.tracks, data.data?.playlist?.entries, data.data?.playlist?.clips, data.data?.playlist?.results, data.data?.playlist?.items
        ];
        for (const c of knownPaths) { if (Array.isArray(c) && c.length > 0) return c; }
        const looksLikeClip = (item) => { if (!item || typeof item !== 'object' || Array.isArray(item)) return false; return !!(item.id || item.clip_id || item.song_id || item.clip?.id || item.song?.id); };
        const searched = new Set();
        const search = (node, depth) => {
          if (!node || typeof node !== 'object' || depth > 4 || searched.has(node)) return null;
          searched.add(node);
          if (Array.isArray(node)) { if (node.length > 0 && node.some(looksLikeClip)) return node; return null; }
          for (const v of Object.values(node)) { if (Array.isArray(v) && v.length > 0 && v.some(looksLikeClip)) return v; }
          for (const v of Object.values(node)) { if (v && typeof v === 'object' && !Array.isArray(v)) { const f = search(v, depth + 1); if (f) return f; } }
          return null;
        };
        return search(data, 0);
      };
      const diagnostics = [];
      let lastResult = { ok: false, status: 0, data: null, source: null };
      for (const candidate of candidates) {
        let status = 0, ok = false, data = null, clipCount = 0, dataKeys = null, error = null;
        try {
          const response = await fetch(candidate.url, { method: candidate.method, headers: candidate.headers, body: candidate.body ? JSON.stringify(candidate.body) : undefined });
          status = response.status; ok = response.ok; data = await tryParse(response);
          dataKeys = data ? (Array.isArray(data) ? `[array:${data.length}]` : Object.keys(data).join(',')) : null;
          const clipArr = findClipArray(data); clipCount = clipArr ? clipArr.length : 0;
        } catch (e) { error = e?.message || String(e); }
        diagnostics.push({ source: candidate.label, status, ok, clipCount, dataKeys, error });
        if (data) lastResult = { ok, status, data, source: candidate.label };
        if (!ok || error) continue;
        if (clipCount > 0 || page > 1) { sendResponse({ ...lastResult, diagnostics }); return; }
      }
      if (page === 1) {
        try {
          const pageFallback = await ctx.fetchPlaylistSongsFromPageHtml(playlistId);
          if (pageFallback?.ok && pageFallback.data) {
            const clipArr = findClipArray(pageFallback.data);
            if (clipArr && clipArr.length > 0) { sendResponse({ ...pageFallback, diagnostics }); return; }
          }
        } catch (pageError) { }
      }
      sendResponse({ ...lastResult, diagnostics });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handlePlaylistMutation(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const mode = msg.action === 'playlist_add_songs' ? 'add' : (msg.action === 'playlist_reorder_songs' ? 'reorder' : 'remove');
      const rawPlaylistId = typeof msg.playlistId === 'string' ? msg.playlistId.trim() : '';
      const playlistId = rawPlaylistId ? (rawPlaylistId.match(/playlist\/([0-9a-f-]{30,36})/i)?.[1] || rawPlaylistId) : '';
      let data;
      if (mode === 'remove' && Array.isArray(msg.indices)) data = msg.indices;
      else if (mode === 'reorder' && typeof msg.fromIndex === 'number' && typeof msg.toIndex === 'number') data = { fromIndex: msg.fromIndex, toIndex: msg.toIndex };
      else if (Array.isArray(msg.songIds)) data = Array.from(new Set(msg.songIds.map(id => String(id || '').trim()).filter(Boolean)));
      else data = [];
      if (!playlistId) { sendResponse({ ok: false, error: 'Missing playlistId' }); return; }
      if (!Array.isArray(data) && !(mode === 'reorder' && typeof data === 'object' && typeof data?.fromIndex === 'number' && typeof data?.toIndex === 'number')) { sendResponse({ ok: false, error: `Missing required data for ${mode} operation` }); return; }
      if (Array.isArray(data) && data.length === 0) { sendResponse({ ok: false, error: `No ${mode === 'remove' ? 'indices' : 'songIds'} provided` }); return; }
      const token = await ctx.getApiTokenWithFallback(mode === 'add' ? 'playlist_add_songs' : (mode === 'reorder' ? 'playlist_reorder_songs' : 'playlist_remove_songs'));
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const ownership = await ctx.fetchPlaylistOwnershipInfo(token, playlistId);
      if (!ownership.ok) { sendResponse({ ok: false, error: ownership.error || 'Could not verify playlist ownership' }); return; }
      if (!ownership.isOwned) { sendResponse({ ok: false, error: 'Only your own playlists can be modified', code: 'not_owned' }); return; }
      const result = await ctx.runPlaylistMutation(token, playlistId, data, mode);
      if (!result.ok) { sendResponse({ ok: false, status: result.status, error: `Failed to ${mode} songs in playlist`, diagnostics: result.diagnostics || [] }); return; }
      const affectedCount = ctx.inferPlaylistMutationCount(result.data, Array.isArray(data) ? data.length : 0, mode);
      const skippedCount = Array.isArray(data) ? Math.max(0, data.length - affectedCount) : 0;
      sendResponse({ ok: true, status: result.status, data: result.data, diagnostics: result.diagnostics || [], addedCount: mode === 'add' ? affectedCount : undefined, removedCount: mode === 'remove' ? affectedCount : undefined, reorderedCount: mode === 'reorder' ? affectedCount : undefined, skippedCount });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleResolveSongCoverVideo(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
      if (!songId) { sendResponse({ ok: false, error: 'Missing songId' }); return; }
      const response = await fetch(`https://suno.com/song/${encodeURIComponent(songId)}`, { method: 'GET', credentials: 'include' });
      if (!response.ok) { sendResponse({ ok: false, status: response.status, error: `Song page request failed (${response.status})` }); return; }
      const html = await response.text();
      const videos = ctx.extractCoverVideosFromHtml(html, songId);
      const videoUrl = videos.lyric || videos.coverArt || videos.uploaded || null;
      if (!videoUrl) { sendResponse({ ok: false, status: response.status, error: 'No cover video URL found on song page' }); return; }
      sendResponse({ ok: true, status: response.status, videoUrl, lyricVideoUrl: videos.lyric || null, coverArtVideoUrl: videos.coverArt || null, uploadedVideoUrl: videos.uploaded || null, processedVideoUrl: videos.lyric || null });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchSongComments(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
      if (!songId) { sendResponse({ ok: false, error: 'Missing songId' }); return; }
      const token = await ctx.getApiTokenWithFallback('fetch_song_comments');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const url = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(songId)}/comments?order=newest`;
      const response = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
      let responseBody = null;
      try { responseBody = await response.json(); } catch (error) { responseBody = null; }
      if (!response.ok) console.warn('[BetterSuno] fetch_song_comments failed', response.status, responseBody);
      sendResponse({ ok: response.ok, status: response.status, data: responseBody });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleUpdateCommentReaction(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const commentId = typeof msg.commentId === 'string' ? msg.commentId.trim() : '';
      if (!commentId) { sendResponse({ ok: false, error: 'Missing commentId' }); return; }
      if (!msg.songId) { sendResponse({ ok: false, error: 'Missing songId' }); return; }
      const token = await ctx.getApiTokenWithFallback('update_comment_reaction');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const url = `https://studio-api.prod.suno.com/api/comment/${encodeURIComponent(commentId)}/reaction/`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ reaction: 'LIKE' }) });
      let responseBody = null;
      try { responseBody = await response.json(); } catch (error) { responseBody = null; }
      sendResponse({ ok: response.ok, status: response.status, data: responseBody });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handlePostSongComment(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      const parentId = typeof msg.parentId === 'string' ? msg.parentId.trim() : null;
      if (!songId || !content) { sendResponse({ ok: false, error: 'Missing songId or content' }); return; }
      const token = await ctx.getApiTokenWithFallback('post_song_comment');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const url = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(songId)}/comment`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ content: content, parent_id: parentId, track_timestamp: null }) });
      let responseBody = null;
      try { responseBody = await response.json(); } catch (error) { responseBody = null; }
      sendResponse({ ok: response.ok, status: response.status, data: responseBody });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleUpdateSongReaction(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
      const reaction = msg.reaction === null ? null : (typeof msg.reaction === 'string' ? msg.reaction.trim() : null);
      if (!songId) { sendResponse({ ok: false, error: 'Missing songId' }); return; }
      const token = await ctx.getApiTokenWithFallback('update_song_reaction');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const url = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(songId)}/update_reaction_type/`;
      const body = reaction ? { reaction: reaction, recommendation_metadata: {} } : { play_count: 3, skip_count: 0, flagged: false, clip: songId, updated_at: '2023-01-01T00:00:00' };
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(body) });
      let responseBody = null;
      try { responseBody = await response.json(); } catch (error) { responseBody = null; }
      if (!response.ok) console.warn('[BetterSuno] update_reaction_type failed', response.status, responseBody);
      sendResponse({ ok: response.ok, status: response.status, data: responseBody });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleSetSongMetadata(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
      const title = typeof msg.title === 'string' ? msg.title.trim() : '';
      const lyrics = typeof msg.lyrics === 'string' ? msg.lyrics : undefined;
      if (!songId || (!title && lyrics === undefined)) { sendResponse({ ok: false, error: 'Missing songId or fields to update' }); return; }
      const token = await ctx.getApiTokenWithFallback('set_song_metadata');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const body = {};
      if (title) body.title = title;
      if (lyrics !== undefined) body.lyrics = lyrics;
      const url = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(songId)}/set_metadata/`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(body) });
      let responseBody = null;
      try { responseBody = await response.json(); } catch (error) { responseBody = null; }
      sendResponse({ ok: response.ok, status: response.status, data: responseBody });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleFetchSongs(msg, sender, sendResponse, ctx) {
  ctx.log("[MSG] fetch_songs received - isPublicOnly:", msg.isPublicOnly, "maxPages:", msg.maxPages, "checkNewOnly:", msg.checkNewOnly, "knownIds count:", msg.knownIds?.length || 0);
  ctx.stopFetchRequested = false;
  ctx.isFetching = true;
  ctx.fetchRequestorTabId = sender.tab?.id || null;
  ctx.log("[MSG] Starting fetchSongsList for tab", ctx.fetchRequestorTabId);
  if (ctx.fetchRequestorTabId) {
    try { ctx.safeTabsSendMessage(ctx.fetchRequestorTabId, { action: "fetch_started" }); } catch (e) {}
  }
  ctx.fetchSongsList(msg.isPublicOnly, msg.maxPages, msg.checkNewOnly, msg.knownIds, msg.metadataRefreshIds);
}

function handleGetFetchState(msg, sender, sendResponse, ctx) {
  sendResponse({ isFetching: ctx.isFetching });
  return true;
}

function handleStopFetch(msg, sender, sendResponse, ctx) {
  ctx.stopFetchRequested = true;
  ctx.isFetching = false;
  if (ctx.activeFetchAbortController) {
    ctx.activeFetchAbortController.abort();
    ctx.activeFetchAbortController = null;
  }
  if (ctx.fetchRequestorTabId) {
    chrome.scripting.executeScript({ target: { tabId: ctx.fetchRequestorTabId }, func: () => { window.sunoStopFetch = true; } }).catch(() => {});
    try { ctx.safeTabsSendMessage(ctx.fetchRequestorTabId, { action: "fetch_stopped" }); } catch (e) {}
  }
}

function handleCheckStop(msg, sender, sendResponse, ctx) {
  sendResponse({ stop: ctx.stopFetchRequested });
  return true;
}

function handleDownloadSelected(msg, sender, sendResponse, ctx) {
  if (ctx.isDownloading) {
    ctx.log("⚠️ Download already running. Stop it first.");
    const alreadyRunningTab = sender.tab?.id || ctx.downloadRequestorTabId;
    if (alreadyRunningTab) { chrome.tabs.sendMessage(alreadyRunningTab, { action: "log", text: "⚠️ Download already running. Stop it first." }).catch(() => {}); }
    return;
  }
  ctx.stopDownloadRequested = false;
  ctx.isDownloading = true;
  ctx.currentDownloadJobId += 1;
  ctx.activeDownloadIds = new Set();
  ctx.downloadRequestorTabId = sender.tab?.id || null;
  ctx.persistDownloadState({ startedAt: Date.now() });
  ctx.broadcastDownloadState();
  ctx.downloadSelectedSongs(msg.folderName, msg.songs, msg.format || 'm4a', ctx.currentDownloadJobId, ctx.normalizeDownloadOptions(msg.downloadOptions));
}

function handleStopDownload(msg, sender, sendResponse, ctx) {
  ctx.stopDownloadRequested = true;
  ctx.isDownloading = false;
  ctx.persistDownloadState({ stoppedAt: Date.now() });
  ctx.broadcastDownloadState();
  const stopDestTab = sender.tab?.id || ctx.downloadRequestorTabId;
  if (stopDestTab) { chrome.tabs.sendMessage(stopDestTab, { action: "download_stopped" }).catch(() => {}); }
}

function handleGetDownloadState(msg, sender, sendResponse, ctx) {
  ctx.readPersistedDownloadState().then(state => {
    if (state) {
      sendResponse({ isDownloading: !!state.isDownloading, stopRequested: !!state.stopRequested, jobId: state.jobId || 0 });
    } else {
      sendResponse({ isDownloading: ctx.isDownloading, stopRequested: ctx.stopDownloadRequested, jobId: ctx.currentDownloadJobId });
    }
  });
  return true;
}

function handleSongsList(msg, sender, sendResponse, ctx) {
  ctx.isFetching = false;
  const destTab = sender.tab?.id || ctx.fetchRequestorTabId;
  if (destTab) { chrome.tabs.sendMessage(destTab, { action: "songs_fetched", songs: msg.songs, checkNewOnly: msg.checkNewOnly }).catch(() => {}); }
}

function handleSongsPage(msg, sender, sendResponse, ctx) {
  const destTab = sender.tab?.id || ctx.fetchRequestorTabId;
  if (destTab) { chrome.tabs.sendMessage(destTab, { action: "songs_page_update", songs: msg.songs, pageNum: msg.pageNum, totalSongs: msg.totalSongs, checkNewOnly: msg.checkNewOnly }).catch(() => {}); }
}

function handleFetchErrorInternal(msg, sender, sendResponse, ctx) {
  ctx.isFetching = false;
  const destTab = sender.tab?.id || ctx.fetchRequestorTabId;
  if (destTab) { chrome.tabs.sendMessage(destTab, { action: "fetch_error", error: msg.error }).catch(() => {}); }
}

function handleLog(msg, sender, sendResponse, ctx) {
  const destTab = sender.tab?.id || ctx.downloadRequestorTabId || ctx.fetchRequestorTabId;
  if (destTab) { chrome.tabs.sendMessage(destTab, { action: "log", text: msg.text }).catch(() => {}); }
  else { ctx.safeRuntimeSendMessage({ action: "log", text: msg.text }); }
}

function handleSavePrompt(msg, sender, sendResponse, ctx) {
  (async () => {
    try { await IDBStore.savePrompt(msg.prompt); sendResponse({ ok: true }); }
    catch (e) { console.error('[BetterSuno] save_prompt error:', e); sendResponse({ ok: false, error: e?.message || String(e) }); }
  })();
  return true;
}

function handleGetPrompts(msg, sender, sendResponse, ctx) {
  (async () => {
    try { const prompts = await IDBStore.getAllPrompts(); sendResponse({ ok: true, prompts }); }
    catch (e) { console.error('[BetterSuno] get_prompts error:', e); sendResponse({ ok: false, error: e?.message || String(e) }); }
  })();
  return true;
}

function handleDeletePrompt(msg, sender, sendResponse, ctx) {
  (async () => {
    try { await IDBStore.deletePrompt(msg.id); sendResponse({ ok: true }); }
    catch (e) { console.error('[BetterSuno] delete_prompt error:', e); sendResponse({ ok: false, error: e?.message || String(e) }); }
  })();
  return true;
}

function handleFetchPersonas(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('fetch_personas');
      if (!token) { sendResponse({ ok: false, error: 'No auth token' }); return; }
      const browserToken = btoa(JSON.stringify({ timestamp: Date.now() }));
      let deviceId = null;
      try { const s = await chrome.storage.local.get('sunoDeviceId'); deviceId = s?.sunoDeviceId || null; } catch (e) {}
      if (!deviceId || typeof deviceId !== 'string') { deviceId = crypto.randomUUID(); try { await chrome.storage.local.set({ sunoDeviceId: deviceId }); } catch (e) {} }
      const continuationToken = msg.continuationToken || null;
      const page = msg.page || 1;
      let url = `https://studio-api.prod.suno.com/api/persona/get-personas/?page=${page}`;
      if (continuationToken) url = `https://studio-api.prod.suno.com/api/persona/get-personas/?continuation_token=${encodeURIComponent(continuationToken)}`;
      const response = await fetch(url, { method: 'GET', cache: 'no-store', headers: { 'Authorization': `Bearer ${token}`, 'browser-token': `{"token":"${browserToken}"}`, 'device-id': deviceId, 'Origin': 'https://suno.com', 'Referer': 'https://suno.com/', 'Accept': 'application/json' } });
      if (!response.ok) { sendResponse({ ok: false, error: `Personas API HTTP ${response.status}` }); return; }
      const data = await response.json();
      const personas = (data?.personas || []).filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').map(p => ({
        id: p.id, name: p.name.trim(), image_url: p.image_s3_id || p.image_url || (p.clip?.image_url) || '', is_vox_persona: !!p.is_vox_persona, persona_type: p.persona_type || 'vox', clip_count: typeof p.clip_count === 'number' ? p.clip_count : 0
      }));
      sendResponse({ ok: true, personas, current_page: data.current_page || page, total_results: data.total_results || 0, continuation_token: data.continuation_token || null, has_more: !!data.continuation_token });
    } catch (e) {
      console.error('[BetterSuno] fetch_personas error:', e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}

function handleGenerateSong(msg, sender, sendResponse, ctx) {
  (async () => {
    try {
      const token = await ctx.getApiTokenWithFallback('generate_song');
      if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
      if (!msg.lyrics || !msg.lyrics.trim()) { sendResponse({ ok: false, error: "Lyrics are required" }); return; }
      const stylePrompt = msg.stylePrompt && msg.stylePrompt.trim();
      const controlSliders = {};
      const canControl = [];
      if (typeof msg.styleInfluence === 'number' && !isNaN(msg.styleInfluence)) { controlSliders.style_weight = msg.styleInfluence / 100; canControl.push('style_weight'); }
      if (typeof msg.weirdness === 'number' && !isNaN(msg.weirdness)) { controlSliders.weirdness_constraint = msg.weirdness / 100; canControl.push('weirdness_constraint'); }
      if (typeof msg.audioInfluence === 'number' && !isNaN(msg.audioInfluence)) { controlSliders.audio_weight = msg.audioInfluence / 100; canControl.push('audio_weight'); }
      const payload = {
        mv: msg.mv || 'chirp-fenix', gpt_description_prompt: '', prompt: msg.lyrics, make_instrumental: msg.instrumental || false, title: msg.title || '', tags: stylePrompt || msg.tags || '', negative_tags: msg.negativeTags || '', generation_type: 'TEXT', continue_at: null, continue_clip_id: null, task: null,
        ...(msg.personaId ? { persona_id: msg.personaId, ...(msg.personaModel ? { persona_model: msg.personaModel } : {}) } : {}),
        metadata: { web_client_pathname: '/create', create_mode: 'custom', create_session_token: crypto.randomUUID(), ...(Object.keys(controlSliders).length > 0 ? { control_sliders: controlSliders } : {}), ...(canControl.length > 0 ? { can_control_sliders: canControl } : {}) }
      };
      const response = await fetch('https://studio-api.prod.suno.com/api/generate/v2-web/', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(payload) });
      let data = null;
      try { data = await response.json(); } catch (e) {}
      if (!response.ok) { sendResponse({ ok: false, status: response.status, error: data?.detail || 'Generation failed', data }); return; }
      sendResponse({ ok: true, data });
    } catch (e) {
      console.error('[BetterSuno] generate_song error:', e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
}
