// background.js — Verbesserte Token-Verwaltung ohne Tab-Dependency
// Import IndexedDB functions
import * as IDBStore from './idb-store.js';

// Verify module imported successfully
console.log('[BACKGROUND-INIT] IDBStore module loaded:', typeof IDBStore, 'functions available:', Object.keys(IDBStore).length);

function logFormatDate(ts) {
  const date = ts ? new Date(ts) : null;
  if (date) {
    const uhrzeit = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const datum = date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    return datum + " " + uhrzeit + " = " + ts;
  } else {
    return ts;
  }
}

function log(...args) {
  console.log("[BACKGROUND]", ...args, "at", logFormatDate(Date.now()));
}

// Log that background.js is loading
log("=== BACKGROUND.JS LOADING ===");

setInterval(() => {
  log("heartbeat");
}, 60000);

// Browser detection: Firefox uses persistent background scripts instead of service workers
const isFirefox = typeof browser !== 'undefined' && !!browser.runtime?.getBrowserInfo;

const tabState = {};
const DEFAULT_INTERVAL_MS = 120000;

// Download state management
let stopFetchRequested = false;
let isFetching = false;
let fetchRequestorTabId = null;
let stopDownloadRequested = false;
let isDownloading = false;
let currentDownloadJobId = 0;
let activeDownloadIds = new Set();
let downloadRequestorTabId = null;
const DOWNLOAD_STATE_KEY = 'sunoDownloadState';

// Gate: resolves once loadState() has completed, so alarm handlers
// don't operate on empty in-memory state after a service-worker restart.
let stateReady;
const stateReadyPromise = new Promise(r => { stateReady = r; });

// Offscreen document creation guard (prevent race conditions)
let offscreenCreating = false;
let offscreenExists = false;

// Initialize state and restart polling for any enabled collectors
(async function init() {
  log("Initializing background...");
  await loadState();
  stateReady();

  for (const [tabId, st] of Object.entries(tabState)) {
    if (st.enabled) {
      log('init: restarting polling for', tabId);
      await ensureOffscreen();
      await sendToOffscreen({
        type: "offscreenSetState",
        tabId,
        state: { ...st }
      });
    }
  }

  log("Background initialization complete.");
})();

// ============================================================================
// Persistence via IndexedDB (persistent across browser sessions)
// ============================================================================

// Fields that are worth saving across restarts.
const PERSIST_FIELDS = [
  'enabled',
  'intervalMs',
  'initialAfterUtc',
  'lastNotificationTime',
  'activatedAt',
  'notifications',
  'desktopNotificationsEnabled',
];

async function saveState() {
  try {
    for (const [tabId, st] of Object.entries(tabState)) {
      const toSave = {};
      for (const f of PERSIST_FIELDS) {
        toSave[f] = st[f];
      }
      await IDBStore.saveTabState(tabId, toSave);
    }
  } catch (err) {
    log('saveState error:', err.message);
  }
}

async function loadState() {
  try {
    const states = await IDBStore.getAllTabStates();
    for (const [tabId, fields] of Object.entries(states)) {
      const st = ensureTabState(tabId);
      for (const f of PERSIST_FIELDS) {
        if (fields[f] !== undefined) st[f] = fields[f];
      }
      log('loadState: restored', (fields.notifications || []).length, 'notifications for', tabId);
    }
  } catch (err) {
    log('loadState error:', err.message);
  }
}

function ensureTabState(tabId) {
  if (!tabState[tabId]) {
    tabState[tabId] = {
      enabled: true,
      intervalMs: DEFAULT_INTERVAL_MS,
      initialAfterUtc: null,
      token: null,
      tokenTimestamp: null,
      requestCount: 0,
      totalRequests: 0,
      lastRequestTime: null,
      reloadCount: 0,
      lastReloadTime: null,
      lastNotificationTime: null,
      activatedAt: null,
      notifications: [],
      lastError: null,
      desktopNotificationsEnabled: true,
      clerkSessionToken: null,
      clerkSessionExpiry: null
    };
  }
  return tabState[tabId];
}

// ============================================================================
// Clerk Session Token aus Cookies + eigener Refresh
// ============================================================================

/**
 * Holt das Clerk Session Token (__session Cookie) direkt aus den Browser-Cookies
 * Dies funktioniert auch wenn der Tab schläft!
 */
async function getClerkSessionFromCookies() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://suno.com',
      name: '__session'
    });
    
    if (cookie?.value) {
      log("Clerk __session Cookie found:", cookie.value.slice(0, 20) + "...");
      return cookie.value;
    }
    
    log("Clerk __session Cookie NOT found");
    return null;
  } catch (err) {
    log("Error getting Clerk session cookie:", err.message);
    return null;
  }
}

/**
 * Refreshes the Bearer Token directly via Clerk's API.
 * Uses the Session Token from the cookie.
 */
async function refreshTokenViaClerkAPI(sessionToken) {
  try {
    // Clerk's Token Endpoint (standard for all Clerk apps)
    const response = await fetch('https://clerk.suno.com/v1/client/sessions/active/tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        template: ''  // Empty template name = standard Bearer Token
      })
    });

    if (!response.ok) {
      let errorDetail = response.statusText;
      try {
        const errorData = await response.json();
        errorDetail = JSON.stringify(errorData);
      } catch (e) {
        const text = await response.text();
        errorDetail = text.slice(0, 200);
      }
      log("Clerk API refresh failed:", response.status, errorDetail);
      return null;
    }

    const data = await response.json();
    
    if (data.jwt) {
      log("NEW Bearer Token via Clerk API:", data.jwt.slice(0, 20) + "...");
      return {
        token: data.jwt,
        expiresAt: Date.now() + (50 * 60 * 1000) // 50 minutes
      };
    }

    log("Clerk API response missing jwt field:", JSON.stringify(data).slice(0, 100));
    return null;
  } catch (err) {
    log("Error refreshing token via Clerk API:", err.message);
    return null;
  }
}

/**
 * Main function: provide token with automatic refresh.
 * Works WITHOUT an active tab!
 */
async function ensureValidTokenCookieBased(tabId) {
  log("ensureValidTokenCookieBased called for tab", tabId);

  const st = ensureTabState(tabId);
  const now = Date.now();

  // Check if we have a valid cached token
  if (st.token && st.tokenTimestamp && (now - st.tokenTimestamp < 45 * 60 * 1000)) {
    log("Returning CACHED token (age:", Math.floor((now - st.tokenTimestamp) / 60000), "min)");
    return st.token;
  }

  log("Token expired or missing - fetching new token via Clerk API");

  // Step 1: Get session token from cookie
  const sessionToken = await getClerkSessionFromCookies();
  if (!sessionToken) {
    log("ERROR: No Clerk Session Cookie found - user must be logged in to Suno!");
    return null;
  }

  // Step 2: Get new Bearer Token from Clerk API
  const tokenData = await refreshTokenViaClerkAPI(sessionToken);
  if (!tokenData) {
    log("ERROR: Clerk API Token refresh failed");
    return null;
  }

  // Step 3: Cache token
  st.token = tokenData.token;
  st.tokenTimestamp = now;
  st.clerkSessionToken = sessionToken;
  st.clerkSessionExpiry = tokenData.expiresAt;

  log("Token successfully refreshed and cached");
  return tokenData.token;
}

// ============================================================================
// Tab Keep-Alive mit Chrome Alarms API
// ============================================================================

/**
 * Service Worker Alarm for automatic token refresh.
 * Runs every 45 minutes, independent of tab status.
 */
chrome.alarms.create('tokenRefresh', {
  delayInMinutes: 1,
  periodInMinutes: 45
});

/**
 * Gentle keep-alive without tab reload.
 * Prevents tab discarding through minimal interaction.
 */
async function keepTabAlive(tabId) {
  // Tab-independent mode: no specific Suno tab required
  if (typeof tabId !== 'number' || isNaN(tabId)) return false;
  try {
    // Check if tab exists
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;

    // Minimal script injection to keep tab active.
    // Prevents Edge/Chrome from freezing the tab.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "ISOLATED",
      func: () => {
        // Set timestamp - minimally invasive
        if (!window.__sunoKeepalive) {
          window.__sunoKeepalive = { count: 0 };
        }
        window.__sunoKeepalive.count++;
        window.__sunoKeepalive.lastPing = Date.now();
      }
    });

    log("✓ Keep-alive ping successful for tab", tabId);
    return true;
  } catch (err) {
    log("✗ Keep-alive failed for tab", tabId, ":", err.message);
    return false;
  }
}

/**
 * Keep-Alive Alarm - every 5 minutes.
 * Less frequent than tab reload, but enough to prevent discarding.
 */
chrome.alarms.create('keepAlive', {
  delayInMinutes: 1,
  periodInMinutes: 5
});

// ============================================================================
// FALLBACK: Token from MAIN World (only if cookie method fails)
// ============================================================================

async function fetchTokenDirect(tabId) {
  // Firefox doesn't support world: "MAIN" in executeScript
  if (isFirefox) return null;
  if (typeof tabId !== 'number' || isNaN(tabId)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          if (!window.Clerk) return { ok: false, reason: "no-clerk" };
          if (!window.Clerk.session) return { ok: false, reason: "no-session" };
          const token = await window.Clerk.session.getToken();
          if (!token) {
            console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect ERROR: Clerk returned null token at", Date.now());
            return { ok: false, reason: "null-token" };
          }
          console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect NEW TOKEN created:", token.slice(0, 12), "…", "at", Date.now());
          return { ok: true, token };
        } catch(err) {
          console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect ERROR:", err.message, "at", Date.now());
          return { ok: false, reason: err.message };
        }
      }
    });
    const result = results?.[0]?.result;
    if (!result?.ok) {
      log("fetchTokenDirect failed:", result?.reason);
      return null;
    }
    return result.token;
  } catch (err) {
    log("fetchTokenDirect exception:", err.message);
    return null;
  }
}

/**
 * Main token function with fallback strategy
 */
async function ensureValidToken(tabId) {
  log("ensureValidToken called for tab", tabId);

  // STRATEGY 1: Cookie-based (works even with sleeping tab)
  const cookieToken = await ensureValidTokenCookieBased(tabId);
  if (cookieToken) {
    log("✓ Token obtained via cookie method");
    return cookieToken;
  }

  log("⚠ Cookie method failed, trying MAIN world fallback...");

  // STRATEGY 2: Fallback to MAIN world (legacy approach)
  const st = ensureTabState(tabId);
  const MAX_AGE = 50 * 60 * 1000;

  // Check cache
  if (st.token && st.tokenTimestamp && Date.now() - st.tokenTimestamp < MAX_AGE) {
    log("✓ Returning cached token from MAIN world method");
    return st.token;
  }

  // Try getting token from MAIN world
  for (let i = 0; i < 3; i++) {
    log(`Attempt ${i + 1}/3: fetchTokenDirect for tab`, tabId);
    const token = await fetchTokenDirect(tabId);
    
    if (token) {
      log("✓ NEW TOKEN via MAIN world:", token.slice(0, 12), "…");
      st.token = token;
      st.tokenTimestamp = Date.now();
      return token;
    }
    
    log("✗ fetchTokenDirect returned null, attempt", i + 1);
    await new Promise(r => setTimeout(r, 500));
  }

  log("❌ ERROR: Both token strategies failed!");
  st.lastError = "Token refresh failed - both strategies exhausted";
  return null;
}

// ============================================================================
// Offscreen Document
// ============================================================================

async function ensureOffscreen() {
  // Firefox doesn't have/need the offscreen API — polling runs inline
  if (isFirefox) return;

  // Quick return if we already know it exists
  if (offscreenExists) {
    return;
  }

  // If creation is already in progress, wait for it
  if (offscreenCreating) {
    let attempts = 0;
    while (offscreenCreating && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    return;
  }

  try {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) {
      offscreenExists = true;
      return;
    }

    // Mark as creating to prevent race conditions
    offscreenCreating = true;
    
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Suno polling"
    });
    
    offscreenExists = true;
    log("✓ Offscreen document created successfully");
  } catch (err) {
    // If error is that document already exists, that's fine
    if (err.message && err.message.includes("offscreen document may be created")) {
      log("ℹ Offscreen document already exists");
      offscreenExists = true;
    } else {
      log("⚠ Error creating offscreen document:", err.message);
    }
  } finally {
    offscreenCreating = false;
  }
}

/**
 * Send a message to the offscreen document with error handling
 * If the offscreen document is not available, marks it for recreation
 */
async function sendToOffscreen(message) {
  if (isFirefox) {
    ffHandleMessage(message);
    return;
  }

  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    // If offscreen is not available, mark it for recreation
    if (err.message && (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist"))) {
      log("⚠ Offscreen document disconnected, marking for recreation");
      offscreenExists = false;
      offscreenCreating = false;
      // Try to recreate it
      await ensureOffscreen();
    } else {
      log("⚠ Error sending to offscreen:", err.message);
    }
  }
}

// ============================================================================
// Firefox Direct Polling (replaces offscreen document on Firefox)
// Firefox background scripts are persistent, so we can poll directly here
// instead of using Chrome's offscreen document workaround.
// ============================================================================

const ffPollers = {};        // tabId → intervalId
const ffStates = {};         // tabId → polling state
const ffLastRequestAt = {};  // tabId → last request timestamp (ms)
let ffLastRequestAtAll = 0;  // global last request timestamp (ms)

async function ffPollOnce(tabId) {
  const st = ffStates[tabId];
  if (!st || !st.enabled) return;

  const token = await ensureValidToken(tabId);
  if (!token) {
    log("ffPollOnce: no token for tab", tabId);
    const tst = ensureTabState(tabId);
    tst.token = null;
    tst.tokenTimestamp = null;
    return;
  }

  if (st.token !== token) {
    st.token = token;
    st.tokenTimestamp = Date.now();
    st.requestCount = 0;
  }

  const afterUtc = st.lastNotificationTime ?? st.initialAfterUtc;
  if (!afterUtc) return;

  const now = Date.now();

  // Per-tab burst prevention (50% of interval)
  const lastTab = ffLastRequestAt[tabId] || 0;
  if (lastTab && (now - lastTab) < (st.intervalMs * 0.5)) return;
  ffLastRequestAt[tabId] = now;

  // Global burst prevention (70% of interval, min 8s)
  let intMs = Math.round(st.intervalMs * 0.7);
  if (intMs < 8000) intMs = 8000;
  if (ffLastRequestAtAll && (now - ffLastRequestAtAll) < intMs) return;
  ffLastRequestAtAll = now;

  let url = "https://studio-api.prod.suno.com/api/notification/v2";
  url += `?after_datetime_utc=${encodeURIComponent(afterUtc)}`;

  st.totalRequests++;
  st.lastRequestTime = new Date().toISOString();

  try {
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + token }
    });

    if (res.status === 401 || res.status === 403) {
      log("ffPollOnce: 401/403 → token expired for tab", tabId);
      const tst = ensureTabState(tabId);
      tst.token = null;
      tst.tokenTimestamp = null;
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    if (data.notifications?.length) {
      st.lastNotificationTime = data.notified_at;
      st.notifications.unshift(...data.notifications);
      st.notifications.sort((a, b) => {
        const ta = new Date(a.updated_at || a.notified_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.notified_at || b.created_at || 0).getTime();
        return tb - ta;
      });
      await fetch("https://studio-api.prod.suno.com/api/notification/v2/read", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          all: true,
          before_datetime_utc: data.notified_at
        })
      });
    }
    st.requestCount++;
  } catch (e) {
    st.lastError = String(e);
  }

  // Update main tab state and broadcast to UI
  const mainState = ensureTabState(tabId);
  Object.assign(mainState, st);
  showDesktopNotifications(tabId, mainState);
  saveState();

  try {
    chrome.runtime.sendMessage({
      type: "stateUpdate",
      tabId,
      state: { ...mainState }
    });
  } catch (e) {
    // No listeners, ignore
  }
}

function ffRestartPolling(tabId) {
  const st = ffStates[tabId];
  if (!st) return;

  if (ffPollers[tabId]) {
    clearInterval(ffPollers[tabId]);
    delete ffPollers[tabId];
  }
  if (!st.enabled) return;

  ffPollers[tabId] = setInterval(() => ffPollOnce(tabId), st.intervalMs);
  ffPollOnce(tabId);
}

function ffClearTab(tabId) {
  if (ffPollers[tabId]) {
    clearInterval(ffPollers[tabId]);
    delete ffPollers[tabId];
  }
  delete ffStates[tabId];
}

function ffHandleMessage(msg) {
  if (msg.type === "offscreenSetState") {
    ffStates[msg.tabId] = msg.state;
    ffRestartPolling(msg.tabId);
    return;
  }
  if (msg.type === "offscreenClearTab") {
    ffClearTab(msg.tabId);
    return;
  }
}

// ============================================================================
// Fetch existing notifications from Suno API (no after_datetime_utc)
// ============================================================================

async function fetchExistingNotifications() {
  log("fetchExistingNotifications: loading existing notifications from Suno API");
  const st = ensureTabState("global");

  let token = await ensureValidToken("global");
  
  // If global token fails, try to get token from any active Suno tab
  if (!token) {
    log("fetchExistingNotifications: global token failed, trying to find active Suno tab");
    try {
      const sunoTabs = await chrome.tabs.query({ url: "https://suno.com/*" });
      if (sunoTabs.length > 0) {
        const sunoTab = sunoTabs[0];
        log("fetchExistingNotifications: found active Suno tab, trying to get token from tab", sunoTab.id);
        token = await ensureValidToken(sunoTab.id);
      }
    } catch (err) {
      log("fetchExistingNotifications: error finding Suno tabs:", err.message);
    }
  }

  if (!token) {
    log("fetchExistingNotifications: no token available from any source");
    return { ok: false, reason: "no-token" };
  }

  try {
    // Fetch both unread and read notifications in parallel
    const headers = { Authorization: "Bearer " + token };
    
    // Fetch unread notifications
    const params = new URLSearchParams({
      include_inactive: 'true',  // Include read/inactive notifications
      limit: '1000'               // Fetch more at once (most users won't have more, but be safe)
    });

    const [unreadRes, readRes] = await Promise.all([
      fetch(`https://studio-api.prod.suno.com/api/notification/v2?${params}`, { headers }),
      fetch(`https://studio-api.prod.suno.com/api/notification/v2/read`, { headers })
    ]);

    let incoming = [];

    // Process unread notifications
    if (unreadRes.ok) {
      const data = await unreadRes.json();
      incoming = incoming.concat(data.notifications || []);
      log("fetchExistingNotifications: received", data.notifications?.length || 0, "unread notifications");
      
      // Update lastNotificationTime so future polling continues from here
      if (data.notified_at) {
        st.lastNotificationTime = data.notified_at;
      }
    } else {
      log("fetchExistingNotifications: unread API returned", unreadRes.status);
    }

    // Process read notifications
    if (readRes.ok) {
      const data = await readRes.json();
      incoming = incoming.concat(data.notifications || []);
      log("fetchExistingNotifications: received", data.notifications?.length || 0, "read notifications");
    } else {
      log("fetchExistingNotifications: read API returned", readRes.status);
    }

    if (incoming.length) {
      // Merge: deduplicate by id, keeping the newest version
      const existingById = new Map();
      for (const n of st.notifications) {
        existingById.set(n.id, n);
      }
      for (const n of incoming) {
        existingById.set(n.id, n);
      }
      st.notifications = Array.from(existingById.values());
      st.notifications.sort((a, b) => {
        const ta = new Date(a.updated_at || a.notified_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.notified_at || b.created_at || 0).getTime();
        return tb - ta;
      });

      saveState();

      // Broadcast to UI
      chrome.runtime.sendMessage({
        type: "stateUpdate",
        tabId: "global",
        state: { ...st }
      });
    }

    return { ok: true, count: incoming.length };
  } catch (e) {
    log("fetchExistingNotifications: error", e.message);
    return { ok: false, reason: e.message };
  }
}

// ============================================================================
// Messages from Offscreen
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "offscreenRequestToken") {
    log("[NVO] offscreenRequestToken received for tab", msg.tabId);
    ensureValidToken(msg.tabId).then(token => {
      if (!token) {
        log("[NVO] offscreenRequestToken → ensureValidToken returned NULL for tab", msg.tabId);
      } else {
        log("[NVO] offscreenRequestToken → returning token", token.slice(0, 12), "…", "for tab", msg.tabId);
      }
      sendResponse({ token });
    });
    return true;
  }

  if (msg.type === "offscreenStateUpdate") {
    // Merge the incoming tab-specific state into memory
    const st = ensureTabState(msg.tabId);
    Object.assign(st, msg.state);

    // desktop notifications use the per‑tab state
    showDesktopNotifications(msg.tabId, st);
    saveState();

    // Broadcast update to any listeners.  the content script currently
    // only listens for "global" messages, so make sure we send both the
    // tab-specific update and a mirror on the global slot.  the global
    // state is simply kept in sync with the most recently updated tab –
    // the UI doesn't care which tab performed the fetch.
    try {
      chrome.runtime.sendMessage({
        type: "stateUpdate",
        tabId: msg.tabId,
        state: { ...st }
      });
    } catch (e) {
      // ignore if no listeners
    }

    // also update global state to keep content.js happy
    const globalSt = ensureTabState("global");
    // copy notifications and timing so that the panel reflects the latest
    globalSt.notifications = st.notifications;
    globalSt.lastNotificationTime = st.lastNotificationTime;
    globalSt.enabled = st.enabled;
    globalSt.intervalMs = st.intervalMs;
    globalSt.desktopNotificationsEnabled = st.desktopNotificationsEnabled;

    try {
      chrome.runtime.sendMessage({
        type: "stateUpdate",
        tabId: "global",
        state: { ...globalSt }
      });
    } catch (e) {
      // ignore
    }

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "offscreenTokenExpired" || msg.type === "offscreenNoToken") {
    log("[NVO] Token expired/missing for Tab", msg.tabId, "- triggering refresh");
    
    // No tab reload needed!
    // Token will be auto-refreshed on next ensureValidToken() call
    const st = ensureTabState(msg.tabId);
    st.token = null;  // Invalidate token
    st.tokenTimestamp = null;
    
    sendResponse({ ok: true });
    return true;
  }

  // Content script asks for current global state
  if (msg.type === "contentGetState") {
    const st = ensureTabState("global");
    sendResponse({
      notifications: st.notifications || [],
      enabled: st.enabled,
      intervalMs: st.intervalMs,
      desktopNotificationsEnabled: st.desktopNotificationsEnabled,
      initialAfterUtc: st.initialAfterUtc
    });
    return true;
  }

  // Content script checks whether another suno.com tab already has the extension running.
  if (msg.type === "checkActiveTab") {
    const senderTabId = sender.tab?.id;
    chrome.tabs.query({ url: "https://suno.com/*" }).then(tabs => {
      const otherTabs = tabs.filter(t => t.id !== senderTabId);
      sendResponse({ otherTabsCount: otherTabs.length });
    }).catch(() => {
      sendResponse({ otherTabsCount: 0 });
    });
    return true;
  }

  // Content script (or UI) requests loading existing notifications from Suno
  if (msg.type === "contentFetchExisting") {
    log("contentFetchExisting: message received, starting fetch");
    stateReadyPromise.then(() => {
      fetchExistingNotifications().then(result => {
        log("contentFetchExisting: result =", result);
        sendResponse(result);
      }).catch(err => {
        log("contentFetchExisting: error =", err.message);
        sendResponse({ ok: false, reason: err.message });
      });
    });
    return true;
  }

  // ---- UI → Background ----

  if (msg.type === "uiInit") {
    const st = ensureTabState(msg.tabId);
    sendResponse({ state: { ...st } });
    return true;
  }

  if (msg.type === "setConfig") {
    const st = ensureTabState(msg.tabId);

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
        
        log("✓ Collector activated for tab", msg.tabId);
        
        // Token sofort holen (nicht auf Alarm warten)
        ensureValidToken(msg.tabId).then(token => {
          if (token) {
            log("✓ Initial token fetch successful");
            // On first activation, load existing notifications from Suno
            fetchExistingNotifications();
          } else {
            log("⚠ Initial token fetch failed - will retry on next alarm");
          }
        });
      }
    } else {
      st.activatedAt = null;
      log("Collector deactivated for tab", msg.tabId);
    }

    saveState();

    ensureOffscreen().then(() => {
      sendToOffscreen({
        type: "offscreenSetState",
        tabId: msg.tabId,
        state: { ...st }
      });
    });

    sendResponse({ state: { ...st } });
    return true;
  }

  if (msg.type === "clearNotifications") {
    const st = ensureTabState(msg.tabId);
    st.notifications = [];

    saveState();

    sendToOffscreen({
      type: "offscreenSetState",
      tabId: msg.tabId,
      state: { ...st }
    });

    sendResponse({ state: { ...st } });
    return true;
  }

  // Content script updates settings
  if (msg.type === "contentUpdateSettings") {
    const st = ensureTabState(msg.tabId || "global");
    const settings = msg.settings || {};
    
    if (settings.enabled !== undefined) st.enabled = settings.enabled;
    if (settings.intervalMs !== undefined) st.intervalMs = settings.intervalMs;
    if (settings.desktopNotificationsEnabled !== undefined) st.desktopNotificationsEnabled = settings.desktopNotificationsEnabled;
    if (settings.initialAfterUtc !== undefined) st.initialAfterUtc = settings.initialAfterUtc;
    
    log("contentUpdateSettings: updated settings for tab", msg.tabId, "- enabled:", st.enabled, "interval:", st.intervalMs);
    
    saveState();
    
    sendResponse({ ok: true, state: { ...st } });
    return true;
  }

  if (msg.type === "offscreenKeepalivePing") {
    // Keepalive is now handled via Chrome Alarms
    // This handler remains for manual triggers
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        keepTabAlive(Number(tabId));
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "pingMainWorld") {
    if (isFirefox) {
      sendResponse({ ok: false, reason: "not-supported-firefox" });
      return true;
    }
    const activeTabId = Object.keys(tabState).find(id => tabState[id].enabled && !isNaN(Number(id)));
    if (!activeTabId) {
      log("pingMainWorld → no active tab");
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
        log("pingMainWorld executeScript error", chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      log("pingMainWorld result", results);
      sendResponse({ ok: true, result: results });
    });
    return true;
  }

  // ============================================================================
  // Download-related message handlers
  // ============================================================================

  if (msg.action === "fetch_feed_page") {
    (async () => {
      try {
        const token = msg.token;
        const cursorValue = msg.cursor || null;
        const isPublicOnly = !!msg.isPublicOnly;
        const userId = msg.userId || null;

        if (!token) {
          sendResponse({ ok: false, status: 0, error: "Missing token" });
          return;
        }

        const body = {
          limit: 20,
          filters: {
            disliked: "False",
            trashed: "False",
            fromStudioProject: { presence: "False" }
          }
        };

        if (userId) {
          body.filters.user = {
            presence: "True",
            userId: userId
          };
        }

        if (isPublicOnly) {
          body.filters.public = "True";
        }
        if (cursorValue) {
          body.cursor = cursorValue;
        }

        const controller = new AbortController();
        const timeoutMs = 20000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch('https://studio-api.prod.suno.com/api/feed/v3', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        clearTimeout(timeout);

        const status = response.status;
        let data = null;
        try {
          data = await response.json();
        } catch (e) {
          // ignore
        }

        sendResponse({
          ok: response.ok,
          status,
          data
        });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "fetch_songs") {
    log("[MSG] fetch_songs received - isPublicOnly:", msg.isPublicOnly, "maxPages:", msg.maxPages, "checkNewOnly:", msg.checkNewOnly, "knownIds count:", msg.knownIds?.length || 0);
    stopFetchRequested = false;
    isFetching = true;
    fetchRequestorTabId = sender.tab?.id || null;
    log("[MSG] Starting fetchSongsList for tab", fetchRequestorTabId);
    // inform the page that fetching has begun so UI can show stop button
    if (fetchRequestorTabId) {
      try {
        chrome.tabs.sendMessage(fetchRequestorTabId, { action: "fetch_started" });
      } catch (e) {
        // tab may have closed
      }
    }
    fetchSongsList(msg.isPublicOnly, msg.maxPages, msg.checkNewOnly, msg.knownIds);
  }

  if (msg.action === "get_fetch_state") {
    sendResponse({ isFetching: isFetching });
    return true;
  }

  if (msg.action === "stop_fetch") {
    stopFetchRequested = true;
    isFetching = false;
    // Set the stop flag in the page context so content-fetcher.js sees it
    if (fetchRequestorTabId) {
      chrome.scripting.executeScript({
        target: { tabId: fetchRequestorTabId },
        func: () => { window.sunoStopFetch = true; }
      }).catch(() => {});

      // Notify the requesting tab so its UI can warn the user
      try {
        chrome.tabs.sendMessage(fetchRequestorTabId, { action: "fetch_stopped" });
      } catch (e) {
        // ignore if tab gone
      }
    }
  }

  if (msg.action === "check_stop") {
    sendResponse({ stop: stopFetchRequested });
    return true;
  }

  if (msg.action === "download_selected") {
    if (isDownloading) {
      log("⚠️ Download already running. Stop it first.");
      chrome.runtime.sendMessage({ action: "log", text: "⚠️ Download already running. Stop it first." });
      return;
    }
    stopDownloadRequested = false;
    isDownloading = true;
    currentDownloadJobId += 1;
    activeDownloadIds = new Set();
    downloadRequestorTabId = sender.tab?.id || null;
    persistDownloadState({ startedAt: Date.now() });
    broadcastDownloadState();
    downloadSelectedSongs(
      msg.folderName,
      msg.songs,
      msg.format || 'mp3',
      currentDownloadJobId,
      normalizeDownloadOptions(msg.downloadOptions)
    );
  }

  if (msg.action === "stop_download") {
    stopDownloadRequested = true;
    isDownloading = false;
    persistDownloadState({ stoppedAt: Date.now() });
    broadcastDownloadState();
    const stopDestTab = sender.tab?.id || downloadRequestorTabId;
    if (stopDestTab) {
      chrome.tabs.sendMessage(stopDestTab, { action: "download_stopped" }).catch(() => {});
    }
  }

  if (msg.action === "get_download_state") {
    readPersistedDownloadState().then((state) => {
      if (state) {
        sendResponse({
          isDownloading: !!state.isDownloading,
          stopRequested: !!state.stopRequested,
          jobId: state.jobId || 0
        });
      } else {
        sendResponse({
          isDownloading,
          stopRequested: stopDownloadRequested,
          jobId: currentDownloadJobId
        });
      }
    });
    return true;
  }

  if (msg.action === "songs_list") {
    isFetching = false;
    const destTab = sender.tab?.id || fetchRequestorTabId;
    if (destTab) {
      chrome.tabs.sendMessage(destTab, {
        action: "songs_fetched",
        songs: msg.songs,
        checkNewOnly: msg.checkNewOnly
      }).catch(() => {});
    }
  }

  if (msg.action === "songs_page") {
    // Incremental page update
    const destTab = sender.tab?.id || fetchRequestorTabId;
    if (destTab) {
      chrome.tabs.sendMessage(destTab, {
        action: "songs_page_update",
        songs: msg.songs,
        pageNum: msg.pageNum,
        totalSongs: msg.totalSongs,
        checkNewOnly: msg.checkNewOnly
      }).catch(() => {});
    }
  }

  if (msg.action === "fetch_error_internal") {
    isFetching = false;
    const destTab = sender.tab?.id || fetchRequestorTabId;
    if (destTab) {
      chrome.tabs.sendMessage(destTab, { action: "fetch_error", error: msg.error }).catch(() => {});
    }
  }

  if (msg.action === "log") {
    // Forward log messages to whichever UI started the active workflow.
    const destTab = sender.tab?.id || downloadRequestorTabId || fetchRequestorTabId;
    if (destTab) {
      chrome.tabs.sendMessage(destTab, { action: "log", text: msg.text }).catch(() => {});
    } else {
      try {
        chrome.runtime.sendMessage({ action: "log", text: msg.text });
      } catch (e) {
        // ignore
      }
    }
  }
});

// ============================================================================
// Tab closed
// ============================================================================

// Global (tab-independent) state is preserved when a Suno tab closes.
// Only remove per-tab state slots that may still exist from legacy sessions.
chrome.tabs.onRemoved.addListener(tabId => {
  log("tab removed", tabId);
  if (tabState[tabId]) {
    if (isFirefox) {
      ffClearTab(tabId);
    } else {
      chrome.runtime.sendMessage({ type: "offscreenClearTab", tabId });
    }
    delete tabState[tabId];
  }
});

// ============================================================================
// Download Helper Functions
// ============================================================================

async function getSunoTab() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = activeTabs?.[0];
    if (active?.url && active.url.includes('suno.com')) return active;

    const windowTabs = await chrome.tabs.query({ currentWindow: true });
    const sunoInWindow = windowTabs.find(t => t.url && t.url.includes('suno.com'));
    if (sunoInWindow) return sunoInWindow;

    const allTabs = await chrome.tabs.query({});
    return allTabs.find(t => t.url && t.url.includes('suno.com')) || null;
  } catch (e) {
    return null;
  }
}

async function persistDownloadState(extra = {}) {
  try {
    await IDBStore.savePreference(DOWNLOAD_STATE_KEY, {
      isDownloading,
      stopRequested: stopDownloadRequested,
      jobId: currentDownloadJobId,
      activeDownloadIds: Array.from(activeDownloadIds),
      ...extra
    });
  } catch (e) {
    // ignore
  }
}

async function readPersistedDownloadState() {
  try {
    const result = await IDBStore.getPreference(DOWNLOAD_STATE_KEY);
    return result || null;
  } catch (e) {
    return null;
  }
}

function broadcastDownloadState() {
  const msg = {
    action: 'download_state',
    isDownloading,
    stopRequested: stopDownloadRequested,
    jobId: currentDownloadJobId
  };
  if (downloadRequestorTabId) {
    chrome.tabs.sendMessage(downloadRequestorTabId, msg).catch(() => {});
  } else {
    try { chrome.runtime.sendMessage(msg); } catch (e) { /* ignore */ }
  }
}

function normalizeDownloadOptions(options) {
  return {
    music: options?.music !== false,
    lyrics: options?.lyrics !== false,
    image: options?.image !== false
  };
}

async function fetchSongsList(isPublicOnly, maxPages, checkNewOnly = false, knownIds = []) {
  const notifyTab = (message) => {
    if (fetchRequestorTabId) {
      chrome.tabs.sendMessage(fetchRequestorTabId, message).catch(() => {});
    }
  };
  try {
    const tab = await getSunoTab();
    if (!tab?.id || !tab.url || !tab.url.includes("suno.com")) {
      notifyTab({ action: "fetch_error", error: "❌ Error: Please open Suno.com in the active tab." });
      return;
    }
    const tabId = tab.id;

    if (!checkNewOnly) {
      notifyTab({ action: "log", text: "🔑 Extracting Auth Token..." });
    }

    const token = await ensureValidToken(tabId);

    if (!token) {
      notifyTab({ action: "fetch_error", error: "❌ Error: Could not find Auth Token. Log in first!" });
      return;
    }

    const userId = await fetchCurrentUserId(token);

    if (!checkNewOnly) {
      notifyTab({ action: "log", text: "✅ Token found! Fetching songs list..." });
    }

    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (t, p, m, c, k, u) => {
        window.sunoAuthToken = t;
        window.sunoPublicOnly = p;
        window.sunoMaxPages = m;
        window.sunoCheckNewOnly = c;
        window.sunoKnownIds = k;
        window.sunoUserId = u;
        window.sunoStopFetch = false;
        window.sunoMode = "fetch";
      },
      args: [token, isPublicOnly, maxPages, checkNewOnly, knownIds, userId]
    });

    // Inject the fetch script (content-fetcher.js)
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content-fetcher.js"]
    });

  } catch (err) {
    log(err);
    notifyTab({ action: "fetch_error", error: "❌ System Error: " + err.message });
  }
}

async function fetchCurrentUserId(token) {
  try {
    const endpoints = [
      'https://studio-api.prod.suno.com/api/me/',
      'https://studio-api.prod.suno.com/api/me'
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) continue;
        const data = await res.json();

        const direct = data?.id || data?.user_id || data?.user?.id || data?.profile?.id;
        if (typeof direct === 'string' && direct.length > 0) return direct;

        const fromTree = findUuidLikeId(data);
        if (fromTree) return fromTree;
      } catch (e) {
        // try next endpoint
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function findUuidLikeId(obj) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const stack = [obj];
  let safety = 0;

  while (stack.length && safety < 5000) {
    safety += 1;
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;

    for (const value of Object.values(cur)) {
      if (typeof value === 'string' && uuidRegex.test(value)) {
        return value;
      }
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

async function downloadSelectedSongs(folderName, songs, format = 'mp3', jobId = 0, downloadOptions = { music: true, lyrics: true, image: true }) {
  const cleanFolder = folderName.replace(/[^a-zA-Z0-9_-]/g, "");

  function notifyDownloadUi(message) {
    if (downloadRequestorTabId) {
      chrome.tabs.sendMessage(downloadRequestorTabId, message).catch(() => {});
      return;
    }
    try {
      chrome.runtime.sendMessage(message);
    } catch (e) {
      // ignore
    }
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, "").trim().substring(0, 100);
  }

  // Check platform
  let isAndroid = false;
  try {
    const platformInfo = await chrome.runtime.getPlatformInfo();
    isAndroid = platformInfo?.os === 'android';
  } catch (e) {
    // ignore
  }

  function buildDownloadFilename(baseName) {
    const folderPrefix = sanitizeFilename(cleanFolder);
    if (isAndroid) {
      return folderPrefix ? `${folderPrefix}-${baseName}` : baseName;
    }
    return cleanFolder ? `${cleanFolder}/${baseName}` : baseName;
  }

  async function downloadOneFile(url, filename) {
    if (!chrome.downloads?.download) {
      throw new Error('Downloads API is unavailable in this browser.');
    }

    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify"
      });
    } catch (err) {
      // Some Firefox Android builds reject custom filenames. Retry without filename.
      if (isAndroid || isFirefox) {
        downloadId = await chrome.downloads.download({
          url,
          conflictAction: "uniquify"
        });
      } else {
        throw err;
      }
    }

    if (typeof downloadId !== 'number') return false;

    activeDownloadIds.add(downloadId);
    persistDownloadState();

    // Wait until the browser actually finishes writing the file
    await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(); // give up waiting after 5 min, don't block forever
      }, 5 * 60 * 1000);

      function listener(delta) {
        if (delta.id !== downloadId) return;
        const state = delta.state?.current;
        if (state === 'complete' || state === 'interrupted') {
          clearTimeout(timeoutId);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }
      }
      chrome.downloads.onChanged.addListener(listener);
    });

    return true;
  }

  const shouldDownloadMusic = !!downloadOptions?.music;
  const shouldDownloadLyrics = !!downloadOptions?.lyrics;
  const shouldDownloadImage = !!downloadOptions?.image;
  const selectedTypes = [];
  if (shouldDownloadMusic) selectedTypes.push(format.toUpperCase());
  if (shouldDownloadLyrics) selectedTypes.push('lyrics');
  if (shouldDownloadImage) selectedTypes.push('images');

  if (selectedTypes.length === 0) {
    const notifyNoTypes = (msg) => {
      if (downloadRequestorTabId) {
        chrome.tabs.sendMessage(downloadRequestorTabId, msg).catch(() => {});
      }
    };
    notifyNoTypes({ action: "log", text: '⚠️ Nothing selected to download.' });
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();
    notifyNoTypes({ action: "download_complete", stopped: false });
    return;
  }

  notifyDownloadUi({ action: "log", text: `🚀 Starting download of ${songs.length} song(s): ${selectedTypes.join(', ')}...` });

  if (isAndroid) {
    notifyDownloadUi({ action: "log", text: '📱 Android detected: using compatibility mode for file saving.' });
  }

  let downloadedCount = 0;
  let failedCount = 0;

  for (const song of songs) {
    if (stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId) {
      notifyDownloadUi({ action: "log", text: "⏹️ Download stopped by user." });
      break;
    }

    const title = song.title || `Untitled_${song.id}`;
    const safeTitle = sanitizeFilename(title);

    try {
      // 1. Download Music
      if (shouldDownloadMusic && song.audio_url) {
        const ext = format.toLowerCase();
        const baseName = `${safeTitle}_${song.id.slice(-4)}.${ext}`;
        const filename = buildDownloadFilename(baseName);
        await downloadOneFile(song.audio_url, filename);
      }

      // 2. Download Lyrics (Blob/Data URL approach)
      if (shouldDownloadLyrics && (song.lyrics || song.metadata?.prompt)) {
        const lyrics = song.lyrics || song.metadata?.prompt;
        const blob = new Blob([lyrics], { type: 'text/plain' });
        const reader = new FileReader();
        const lyricsDataUrl = await new Promise((resolve) => {
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        const baseName = `${safeTitle}_${song.id.slice(-4)}.txt`;
        const filename = buildDownloadFilename(baseName);
        await downloadOneFile(lyricsDataUrl, filename);
      }

      // 3. Download Image
      if (shouldDownloadImage && song.image_url) {
        // Use full-size image URL if available
        let imageUrl = song.image_url;
        if (imageUrl.includes('cdn1.suno.ai') && imageUrl.includes('_8k0.png')) {
          imageUrl = imageUrl.replace('_8k0.png', '.png');
        } else if (imageUrl.includes('cdn1.suno.ai') && imageUrl.includes('_8x8.png')) {
          imageUrl = imageUrl.replace('_8x8.png', '.png');
        }

        const baseName = `${safeTitle}_${song.id.slice(-4)}.jpg`;
        const filename = buildDownloadFilename(baseName);
        await downloadOneFile(imageUrl, filename);
      }

      downloadedCount++;
      notifyDownloadUi({ action: "log", text: `✅ Downloaded: ${title} (${downloadedCount}/${songs.length})` });
    } catch (err) {
      failedCount++;
      notifyDownloadUi({ action: "log", text: `❌ Failed: ${title} - ${err.message}` });
    }

    // Small delay between songs
    await new Promise(r => setTimeout(r, 200));
  }

  const wasStopped = stopDownloadRequested;
  stopDownloadRequested = false;
  isDownloading = false;
  activeDownloadIds = new Set();
  persistDownloadState({ finishedAt: Date.now() });
  broadcastDownloadState();

  notifyDownloadUi({
    action: "log",
    text: `✅ Download complete! ${downloadedCount} succeeded, ${failedCount} failed.`
  });
  notifyDownloadUi({ action: "download_complete", stopped: wasStopped });
}

// Keep active download IDs in sync
try {
  chrome.downloads?.onChanged?.addListener((delta) => {
    if (!delta || typeof delta.id !== 'number') return;
    const state = delta.state?.current;
    if (state === 'complete' || state === 'interrupted') {
      if (activeDownloadIds.delete(delta.id)) {
        persistDownloadState();
      }
    }
  });
} catch (e) {
  // ignore
}

// ============================================================================
// Desktop Notifications
// ============================================================================

// Per-tab tracking: which notification keys have already triggered a desktop notification
const desktopNotified = new Map();   // tabId → Set<key>
const notifClickUrl   = new Map();   // chromeNotifId → url
const lastActivatedAt = new Map();   // tabId → activatedAt string (to detect re-activation)

function getNotifKey(n) {
  return [n.type, n.content_id, n.updated_at || n.notified_at || n.created_at].join('|');
}

function buildDesktopNotifText(n) {
  const title  = n.content_title || '';
  const users  = n.user_profiles || [];
  const total  = n.total_users || users.length;
  const names  = users.map(u => u.display_name).filter(Boolean).join(', ');
  const others = total - users.length;

  let who = names;
  if (others > 0 && names) {
    who = `${names} and ${others} other${others > 1 ? 's' : ''}`;
  } else if (others > 0) {
    who = `${others} ${others > 1 ? 'people' : 'person'}`;
  }

  switch (n.type) {
    case 'clip_like':
      return { title: 'Suno: New Like', message: `${who} liked your song "${title}"` };
    case 'clip_comment':
      return { title: 'Suno: New Comment', message: `${who} commented on your song "${title}"` };
    case 'comment_like':
      return { title: 'Suno: Comment Liked', message: `${who} liked your comment on "${title}"` };
    case 'comment_reply':
      return { title: 'Suno: Comment Reply', message: `${who} replied to your comment on "${title}"` };
    case 'video_cover_hook_like':
      return { title: 'Suno: Hook Liked', message: `${who} liked your video cover in Hooks` };
    case 'hook_like':
      return { title: 'Suno: Hook Liked', message: `${who} liked your hook` };
    default:
      return { title: 'Suno Notification', message: `New notification from ${who || 'someone'}` };
  }
}

function getSunoUrl(n) {
  const id = n.content_id || '';
  switch (n.type) {
    case 'clip_like':
      return `https://suno.com/song/${id}`;
    case 'clip_comment':
      return `https://suno.com/song/${id}`;
    case 'comment_like':
    case 'comment_reply':
      return `https://suno.com/song/${id}?show_comments=true`;
    case 'video_cover_hook_like':
    case 'hook_like':
      return `https://suno.com/hook/${id}`;
    default:
      return 'https://suno.com';
  }
}

function showDesktopNotifications(tabId, state) {
  if (!state.desktopNotificationsEnabled) return;

  const activatedAt = state.activatedAt || null;

  // When the collector is freshly activated (or re-activated), reset tracking
  // and silently mark all existing notifications as seen to avoid spamming
  // the user with historical notifications.
  if (lastActivatedAt.get(tabId) !== activatedAt) {
    lastActivatedAt.set(tabId, activatedAt);
    const seen = new Set();
    for (const n of (state.notifications || [])) {
      seen.add(getNotifKey(n));
    }
    desktopNotified.set(tabId, seen);
    return; // Don't notify on the first poll after activation
  }

  const seen = desktopNotified.get(tabId);
  if (!seen) return;

  for (const n of (state.notifications || [])) {
    const key = getNotifKey(n);
    if (seen.has(key)) continue;
    seen.add(key);

    const { title, message } = buildDesktopNotifText(n);
    const url = getSunoUrl(n);
    const chromeNotifId = `suno_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    notifClickUrl.set(chromeNotifId, url);

    chrome.notifications.create(chromeNotifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message
    });

    log("🔔 Desktop notification:", title, "—", message);
  }
}

chrome.notifications.onClicked.addListener((notifId) => {
  const url = notifClickUrl.get(notifId);
  if (url) {
    chrome.tabs.create({ url });
    notifClickUrl.delete(notifId);
  }
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClosed.addListener((notifId) => {
  notifClickUrl.delete(notifId);
});

// ============================================================================
// Initialization at startup
// ============================================================================

log("🚀 Background Service Worker started");
log("Token refresh via Clerk API every 45 minutes");
log("Tab keep-alive every 5 minutes");

// Watchdog alarm: re-ensures the offscreen document is alive and polling
// for any enabled state. Covers service-worker restarts + offscreen GC.
chrome.alarms.create('ensureOffscreenAlive', {
  delayInMinutes: 0.5,
  periodInMinutes: 2
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await stateReadyPromise;

  if (alarm.name === 'tokenRefresh') {
    log("⏰ ALARM: Token Refresh triggered");
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        log("⏰ Refreshing token for active collector", tabId);
        await ensureValidTokenCookieBased(tabId);
      }
    }
  }

  if (alarm.name === 'keepAlive') {
    log("⏰ ALARM: Keep-Alive triggered");
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        await keepTabAlive(typeof tabId === 'string' ? Number(tabId) : tabId);
      }
    }
  }

  if (alarm.name === 'ensureOffscreenAlive') {
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        log('⏰ WATCHDOG: ensuring offscreen is alive for', tabId);
        await ensureOffscreen();
        await sendToOffscreen({
          type: "offscreenSetState",
          tabId,
          state: { ...st }
        });
      }
    }
  }
});

// Handle offscreen document connection/disconnection (Chrome only)
if (!isFirefox) {
  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'offscreen-document') {
        log("\u2713 Offscreen document connected");
        offscreenExists = true;
        
        port.onDisconnect.addListener(() => {
          log("\u26a0 Offscreen document disconnected");
          offscreenExists = false;
          offscreenCreating = false;
        });
      }
    });
  } catch (e) {
    log("Note: onConnect listener failed (may not be available)");
  }
}
