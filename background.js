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
let activeFetchAbortController = null;
let stopDownloadRequested = false;
let isDownloading = false;
let currentDownloadJobId = 0;
let activeDownloadIds = new Set();
let downloadRequestorTabId = null;
const DOWNLOAD_STATE_KEY = 'sunoDownloadState';
const BULK_LIBRARY_PAGE_SIZE = 10000;

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

async function hasLiveBetterSunoContentScript(tabId) {
  if (typeof tabId !== 'number' || Number.isNaN(tabId)) {
    return false;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'bettersunoProbeTab' });
    return response?.ok === true;
  } catch (err) {
    return false;
  }
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

async function fetchCurrentUserIdentityDirect(tabId) {
  if (isFirefox) return null;
  if (typeof tabId !== 'number' || isNaN(tabId)) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const clerk = window.Clerk;
          const user = clerk?.user || clerk?.session?.user || null;
          if (!user) {
            return { ok: false, reason: 'no-user' };
          }

          // Collect Clerk authentication identifiers (user.id is the primary Clerk ID)
          const userIdClerk = typeof user.id === 'string' && user.id.trim() ? user.id.trim() : null;
          const clerkRelatedIds = [
            user.externalId,
            user.external_id,
            user.username,
            user.primaryEmailAddress?.id,
            ...(Array.isArray(user.emailAddresses) ? user.emailAddresses.map(entry => entry?.id) : [])
          ].filter(value => typeof value === 'string' && value.trim());

          const displayName = [
            user.fullName,
            [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
            user.username,
            user.primaryEmailAddress?.emailAddress
          ].find(value => typeof value === 'string' && value.trim()) || null;

          // Try to find Suno profile UUID from page data
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          let userIdSuno = null;
          
          try {
            // Try localStorage for any cached profile data
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && (key.includes('profile') || key.includes('user') || key.includes('suno'))) {
                const value = localStorage.getItem(key);
                if (value && typeof value === 'string') {
                  const match = value.match(uuidRegex);
                  if (match) {
                    userIdSuno = match[0];
                    console.log('[fetchCurrentUserIdentityDirect] Found Suno UUID in localStorage key', key, ':', userIdSuno);
                    break;
                  }
                }
              }
            }
          } catch (e) {
            console.log('[fetchCurrentUserIdentityDirect] localStorage search failed:', e?.message);
          }

          // Try to extract from window globals
          if (!userIdSuno) {
            try {
              const globalsToCheck = [
                window.currentUser,
                window.user,
                window.profile,
                window.userData,
                window.sunoUser,
                window.sunoProfile,
                window.__INITIAL_STATE__,
                window.__data__
              ];
              
              for (const obj of globalsToCheck) {
                if (obj && typeof obj === 'object') {
                  const jsonStr = JSON.stringify(obj);
                  const match = jsonStr.match(uuidRegex);
                  if (match) {
                    userIdSuno = match[0];
                    console.log('[fetchCurrentUserIdentityDirect] Found Suno UUID in window global');
                    break;
                  }
                }
              }
            } catch (e) {
              console.log('[fetchCurrentUserIdentityDirect] Window global search failed:', e?.message);
            }
          }

          return {
            ok: true,
            identity: {
              id: userIdClerk,
              ids: clerkRelatedIds,
              handle: typeof user.username === 'string' && user.username.trim() ? user.username.trim() : null,
              displayName,
              userIdSuno  // Pass Suno UUID back if found
            }
          };
        } catch (error) {
          return { ok: false, reason: error?.message || String(error) };
        }
      }
    });

    const result = results?.[0]?.result;
    if (!result?.ok || !result.identity) {
      log('fetchCurrentUserIdentityDirect failed for tab', tabId, ':', result?.reason || 'unknown');
      return null;
    }

    // Collect IDs including the Suno UUID if found
    const allIds = collectNormalizedIds([
      result.identity.id,  // userIdClerk
      ...result.identity.ids || [],
      result.identity.userIdSuno
    ]);

    return {
      id: typeof result.identity.id === 'string' ? result.identity.id.trim() : null,
      ids: allIds,
      handle: normalizeHandle(result.identity.handle),
      displayName: pickFirstNonEmptyString([result.identity.displayName])
    };
  } catch (error) {
    log('fetchCurrentUserIdentityDirect exception for tab', tabId, ':', error?.message || String(error));
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
// Shared Suno API auth helper
// ============================================================================

async function getApiTokenWithFallback(logPrefix = 'api') {
  let token = await ensureValidToken("global");

  if (token) {
    return token;
  }

  log(`${logPrefix}: global token failed, trying active Suno tab`);
  try {
    const sunoTabs = await chrome.tabs.query({ url: "https://suno.com/*" });
    for (const sunoTab of sunoTabs) {
      if (typeof sunoTab.id !== 'number') {
        continue;
      }
      log(`${logPrefix}: trying token from tab`, sunoTab.id);
      token = await ensureValidToken(sunoTab.id);
      if (token) {
        return token;
      }
    }
  } catch (err) {
    log(`${logPrefix}: error finding Suno tabs:`, err.message);
  }

  log(`${logPrefix}: no token available from any source`);
  return null;
}

// ============================================================================
// Fetch existing notifications from Suno API (no after_datetime_utc)
// ============================================================================

async function fetchExistingNotifications() {
  log("fetchExistingNotifications: loading existing notifications from Suno API");
  const st = ensureTabState("global");

  const token = await getApiTokenWithFallback('fetchExistingNotifications');

  if (!token) {
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
// Fetch older notifications (pagination via before_datetime_utc)
// ============================================================================

async function fetchOlderNotifications(beforeUtc) {
  log("fetchOlderNotifications: fetching notifications before", beforeUtc);
  const st = ensureTabState("global");

  const token = await getApiTokenWithFallback('fetchOlderNotifications');
  if (!token) {
    return { ok: false, reason: 'no-token', count: 0 };
  }

  try {
    const params = new URLSearchParams({
      before_datetime_utc: beforeUtc,
      include_inactive: 'true'
    });

    const res = await fetch(
      `https://studio-api.prod.suno.com/api/notification/v2?${params}`,
      { headers: { Authorization: "Bearer " + token } }
    );

    if (!res.ok) {
      log("fetchOlderNotifications: HTTP", res.status);
      return { ok: false, reason: `HTTP ${res.status}`, count: 0 };
    }

    const data = await res.json();
    const incoming = data.notifications || [];
    log("fetchOlderNotifications: received", incoming.length, "notifications");

    if (!incoming.length) {
      return { ok: true, count: 0, exhausted: true };
    }

    const existingById = new Map(st.notifications.map(n => [n.id, n]));
    for (const n of incoming) {
      existingById.set(n.id, n);
    }
    st.notifications = Array.from(existingById.values()).sort((a, b) => {
      const ta = new Date(a.updated_at || a.notified_at || a.created_at || 0).getTime();
      const tb = new Date(b.updated_at || b.notified_at || b.created_at || 0).getTime();
      return tb - ta;
    });

    saveState();

    chrome.runtime.sendMessage({
      type: "stateUpdate",
      tabId: "global",
      state: { ...st }
    });

    return { ok: true, count: incoming.length };
  } catch (e) {
    log("fetchOlderNotifications: error", e.message);
    return { ok: false, reason: e.message, count: 0 };
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
    if (typeof senderTabId !== 'number' || Number.isNaN(senderTabId)) {
      sendResponse({ otherTabsCount: 0 });
      return true;
    }

    chrome.tabs.query({ url: "https://suno.com/*" }).then(async tabs => {
      const candidateTabs = tabs.filter(t => t.id !== senderTabId && typeof t.id === 'number');
      const probeResults = await Promise.all(
        candidateTabs.map(t => hasLiveBetterSunoContentScript(t.id))
      );
      const otherTabsCount = probeResults.filter(Boolean).length;
      sendResponse({ otherTabsCount });
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

  // Content script requests older notifications (pagination)
  if (msg.type === "contentFetchOlder") {
    const { beforeUtc } = msg;
    stateReadyPromise.then(() => {
      fetchOlderNotifications(beforeUtc).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ ok: false, reason: err.message, count: 0 });
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

  if (msg.action === "fetch_songs_by_ids") {
    (async () => {
      try {
        let token = msg.token;
        const songIds = msg.songIds || [];

        if (!token) {
          token = await getApiTokenWithFallback('fetch_songs_by_ids');
        }

        if (!token || !Array.isArray(songIds) || songIds.length === 0) {
          sendResponse({ ok: false, status: 0, error: "Missing token or song IDs" });
          return;
        }

        // Fetch library pages until we collect all the requested song IDs
        const songsByIdMap = new Map();
        let page = 1;
        let foundAll = false;
        const maxPages = 100;

        while (!foundAll && page <= maxPages) {
          const controller = new AbortController();
          const timeoutMs = 20000;
          const timeout = setTimeout(() => controller.abort(), timeoutMs);

          const response = await fetch(`https://studio-api.prod.suno.com/api/library?page=${page}&page_size=50`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`
            },
            signal: controller.signal
          });

          clearTimeout(timeout);

          if (!response.ok) {
            break;
          }

          const data = await response.json();
          const clips = data?.clips || data?.results || [];

          for (const clip of clips) {
            if (songIds.includes(clip.id)) {
              songsByIdMap.set(clip.id, clip);
            }
          }

          // Stop if we've found all songs or if there are no more pages
          if (songsByIdMap.size === songIds.length || clips.length === 0) {
            foundAll = true;
            break;
          }

          page++;
        }

        const resultSongs = songIds
          .map(id => songsByIdMap.get(id))
          .filter(Boolean);

        sendResponse({
          ok: true,
          status: 200,
          data: {
            clips: resultSongs,
            count: resultSongs.length,
            pagesChecked: page - 1
          }
        });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
      }
    })();
    return true;
  }

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
            user_id: userId
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

  if (msg.action === "fetch_user_playlists") {
    (async () => {
      try {
        const token = await getApiTokenWithFallback('fetch_user_playlists');
        if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
        // page is 1-based; default to 1
        const page = msg.page || 1;
        const response = await fetch(
          `https://studio-api.prod.suno.com/api/playlist/me?page=${page}&show_trashed=false&show_sharelist=false`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
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

  if (msg.action === "fetch_playlist_info") {
    (async () => {
      try {
        const token = await getApiTokenWithFallback('fetch_playlist_info');
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
          let data = null;
          try { data = await res.json(); } catch (e) {}
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
              is_owned_by_current_user: playlist.is_owned_by_current_user
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

  if (msg.action === "get_current_user_identity") {
    (async () => {
      try {
        log('[get_current_user_identity] Message handler called');
        const token = await getApiTokenWithFallback('get_current_user_identity');
        if (!token) {
          log('[get_current_user_identity] No auth token available');
          sendResponse({ ok: false, error: 'No auth token' });
          return;
        }

        log('[get_current_user_identity] Calling fetchCurrentUserIdentity...');
        const identity = await fetchCurrentUserIdentity(token);
        log('[get_current_user_identity] Received identity:', identity);
        
        if (!identity?.id && !identity?.handle && !identity?.displayName) {
          log('[get_current_user_identity] Identity invalid - no id, handle, or displayName');
          sendResponse({ ok: false, error: 'Could not determine current user identity' });
          return;
        }

        log('[get_current_user_identity] Sending identity to downloader:', identity);
        sendResponse({ ok: true, identity });
      } catch (e) {
        log('[get_current_user_identity] Exception:', e?.message || String(e));
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "fetch_playlist_songs") {
    (async () => {
      try {
        const token = await getApiTokenWithFallback('fetch_playlist_songs');
        if (!token) { sendResponse({ ok: false, error: "No auth token" }); return; }
        const { playlistId: rawPlaylistId, page = 1 } = msg;
        if (!rawPlaylistId) { sendResponse({ ok: false, error: "No playlist ID" }); return; }

        const normalizePlaylistId = (raw) => {
          if (!raw || typeof raw !== 'string') return '';
          const trimmed = raw.trim();
          const urlMatch = trimmed.match(/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
            || trimmed.match(/playlist\/([0-9a-f-]{30,36})/i);
          if (urlMatch) return urlMatch[1];
          return trimmed;
        };

        const playlistId = normalizePlaylistId(rawPlaylistId);
        if (!playlistId) { sendResponse({ ok: false, error: "Invalid playlist ID" }); return; }

        const headers = { 'Authorization': `Bearer ${token}` };
        const jsonHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const playlistIdEncoded = encodeURIComponent(playlistId);
        const candidates = [
          {
            label: 'playlist-v2-detail',
            method: 'GET',
            url: `https://studio-api.prod.suno.com/api/playlist/v2/${playlistIdEncoded}?page=${page}&page_size=50`,
            headers
          },
          {
            label: 'playlist-detail',
            method: 'GET',
            url: `https://studio-api.prod.suno.com/api/playlist/${playlistIdEncoded}?page=${page}&page_size=50`,
            headers
          },
          {
            label: 'playlist-clips',
            method: 'GET',
            url: `https://studio-api.prod.suno.com/api/playlist/${playlistIdEncoded}/clips?page=${page}&page_size=50`,
            headers
          },
          {
            label: 'feed-v3-playlist-filter',
            method: 'POST',
            url: 'https://studio-api.prod.suno.com/api/feed/v3',
            headers: jsonHeaders,
            body: {
              limit: 50,
              cursor: null,
              filters: {
                disliked: 'False',
                trashed: 'False',
                fromStudioProject: { presence: 'False' },
                playlist: {
                  presence: 'True',
                  playlistId
                }
              }
            }
          }
        ];

        const tryParse = async (response) => {
          let data = null;
          try { data = await response.json(); } catch (e) {}
          return data;
        };

        // Find any array of clip-like objects in the response, using known field names
        // then falling back to a shallow recursive search.
        const findClipArray = (data) => {
          if (!data || typeof data !== 'object') return null;
          if (Array.isArray(data) && data.length > 0) return data;

          const knownPaths = [
            data.playlist_clips,
            data.playlist_songs,
            data.songs,
            data.tracks,
            data.entries,
            data.clips,
            data.results,
            data.items,
            data.playlist?.playlist_clips,
            data.playlist?.playlist_songs,
            data.playlist?.songs,
            data.playlist?.tracks,
            data.playlist?.entries,
            data.playlist?.clips,
            data.playlist?.results,
            data.playlist?.items,
            data.data?.playlist_clips,
            data.data?.playlist_songs,
            data.data?.songs,
            data.data?.tracks,
            data.data?.entries,
            data.data?.clips,
            data.data?.results,
            data.data?.items,
            data.data?.playlist?.playlist_clips,
            data.data?.playlist?.playlist_songs,
            data.data?.playlist?.songs,
            data.data?.playlist?.tracks,
            data.data?.playlist?.entries,
            data.data?.playlist?.clips,
            data.data?.playlist?.results,
            data.data?.playlist?.items
          ];
          for (const collection of knownPaths) {
            if (Array.isArray(collection) && collection.length > 0) {
              return collection;
            }
          }
          // Deep fallback: search for ANY array of objects that look like clips
          // (objects with an id or clip_id or song_id field)
          const looksLikeClip = (item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            return !!(item.id || item.clip_id || item.song_id || item.clip?.id || item.song?.id);
          };
          const searched = new Set();
          const search = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 4 || searched.has(node)) return null;
            searched.add(node);
            if (Array.isArray(node)) {
              if (node.length > 0 && node.some(looksLikeClip)) return node;
              return null;
            }
            for (const value of Object.values(node)) {
              if (Array.isArray(value) && value.length > 0 && value.some(looksLikeClip)) {
                return value;
              }
            }
            for (const value of Object.values(node)) {
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                const found = search(value, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          return search(data, 0);
        };

        const diagnostics = [];
        let lastResult = { ok: false, status: 0, data: null, source: null };

        for (const candidate of candidates) {
          let status = 0;
          let ok = false;
          let data = null;
          let clipCount = 0;
          let dataKeys = null;
          let error = null;

          try {
            const response = await fetch(candidate.url, {
              method: candidate.method,
              headers: candidate.headers,
              body: candidate.body ? JSON.stringify(candidate.body) : undefined
            });
            status = response.status;
            ok = response.ok;
            data = await tryParse(response);
            dataKeys = data ? (Array.isArray(data) ? `[array:${data.length}]` : Object.keys(data).join(',')) : null;
            const clipArr = findClipArray(data);
            clipCount = clipArr ? clipArr.length : 0;
          } catch (e) {
            error = e?.message || String(e);
          }

          diagnostics.push({ source: candidate.label, status, ok, clipCount, dataKeys, error });
          console.debug('[BG] Playlist API attempt:', diagnostics[diagnostics.length - 1]);

          if (data) {
            lastResult = { ok, status, data, source: candidate.label };
          }

          if (!ok || error) continue;

          if (clipCount > 0 || page > 1) {
            console.debug('[BG] Returning playlist response:', { source: candidate.label, clipCount });
            sendResponse({ ...lastResult, diagnostics });
            return;
          }
        }

        // HTML page fallback (page 1 only)
        if (page === 1) {
          try {
            const pageFallback = await fetchPlaylistSongsFromPageHtml(playlistId);
            if (pageFallback?.ok && pageFallback.data) {
              const clipArr = findClipArray(pageFallback.data);
              const clipCount = clipArr ? clipArr.length : 0;
              console.debug('[BG] Returning playlist page fallback response:', {
                source: pageFallback.source, clipCount
              });
              if (clipCount > 0) {
                sendResponse({ ...pageFallback, diagnostics });
                return;
              }
            }
          } catch (pageError) {
            console.debug('[BG] Playlist page fallback failed:', pageError?.message || String(pageError));
          }
        }

        // Return the last fetched result with diagnostics (old behavior from ee6333)
        console.debug('[BG] No playlist clips found, returning last result with diagnostics:', {
          ok: lastResult.ok, status: lastResult.status, source: lastResult.source,
          dataKeys: lastResult.data ? Object.keys(lastResult.data) : null,
          diagnostics
        });
        sendResponse({ ...lastResult, diagnostics });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "resolve_song_cover_video") {
    (async () => {
      try {
        const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
        if (!songId) {
          sendResponse({ ok: false, error: 'Missing songId' });
          return;
        }

        const songUrl = `https://suno.com/song/${encodeURIComponent(songId)}`;
        const response = await fetch(songUrl, {
          method: 'GET',
          credentials: 'include'
        });

        if (!response.ok) {
          sendResponse({ ok: false, status: response.status, error: `Song page request failed (${response.status})` });
          return;
        }

        const html = await response.text();
        const videoUrl = extractFirstVideoUrlFromHtml(html, songId);
        if (!videoUrl) {
          sendResponse({ ok: false, status: response.status, error: 'No cover video URL found on song page' });
          return;
        }

        sendResponse({ ok: true, status: response.status, videoUrl });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "update_song_reaction") {
    (async () => {
      try {
        const songId = typeof msg.songId === 'string' ? msg.songId.trim() : '';
        const reaction = typeof msg.reaction === 'string' ? msg.reaction.trim().toUpperCase() : '';

        if (!songId || !reaction) {
          sendResponse({ ok: false, error: 'Missing songId or reaction' });
          return;
        }

        const token = await getApiTokenWithFallback('update_song_reaction');
        if (!token) {
          sendResponse({ ok: false, error: 'No auth token' });
          return;
        }

        const url = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(songId)}/update_reaction_type/`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ reaction, recommendation_metadata: {} })
        });

        let responseBody = null;
        try {
          responseBody = await response.json();
        } catch (error) {
          responseBody = null;
        }

        sendResponse({ ok: response.ok, status: response.status, data: responseBody });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
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
    fetchSongsList(msg.isPublicOnly, msg.maxPages, msg.checkNewOnly, msg.knownIds, msg.metadataRefreshIds);
  }

  if (msg.action === "get_fetch_state") {
    sendResponse({ isFetching: isFetching });
    return true;
  }

  if (msg.action === "stop_fetch") {
    stopFetchRequested = true;
    isFetching = false;
    if (activeFetchAbortController) {
      activeFetchAbortController.abort();
      activeFetchAbortController = null;
    }
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
      const alreadyRunningTab = sender.tab?.id || downloadRequestorTabId;
      if (alreadyRunningTab) {
        chrome.tabs.sendMessage(alreadyRunningTab, { action: "log", text: "⚠️ Download already running. Stop it first." }).catch(() => {});
      }
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
      msg.format || 'm4a',
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

function extractText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (value && typeof value === 'object') {
    const nestedCandidates = [
      value.lyrics,
      value.display_lyrics,
      value.full_lyrics,
      value.raw_lyrics,
      value.prompt,
      value.text,
      value.content,
      value.value
    ];

    for (const candidate of nestedCandidates) {
      const text = extractText(candidate);
      if (text) return text;
    }
  }

  return null;
}

function extractUrl(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractUrl(item);
      if (url) return url;
    }
  }

  if (value && typeof value === 'object') {
    const nestedCandidates = [
      value.url,
      value.src,
      value.image_url,
      value.image,
      value.cover_url,
      value.cover_image_url,
      value.thumbnail_url,
      value.artwork_url
    ];

    for (const candidate of nestedCandidates) {
      const url = extractUrl(candidate);
      if (url) return url;
    }
  }

  return null;
}

function isStemClip(clip) {
  if (!clip || typeof clip !== 'object') return false;

  const meta = clip.metadata || clip.meta || {};

  // Primary signal: task explicitly set to gen_stem
  if (meta.task === 'gen_stem') return true;

  // Secondary signal: stem_from_id present (UUID of the source clip)
  if (typeof meta.stem_from_id === 'string' && meta.stem_from_id.trim().length > 0) return true;

  // Tertiary signal: Suno's own badge system marks this as a stem
  const badges = Array.isArray(meta.secondary_badges) ? meta.secondary_badges
    : Array.isArray(clip.secondary_badges) ? clip.secondary_badges : [];
  if (badges.some(b => b && b.icon_key === 'stem')) return true;

  return false;
}

function extractLyricsFromClip(clip) {
  if (!clip || typeof clip !== 'object') return null;

  const directCandidates = [
    clip.lyrics,
    clip.display_lyrics,
    clip.full_lyrics,
    clip.raw_lyrics,
    clip.prompt,
    clip.metadata?.lyrics,
    clip.metadata?.display_lyrics,
    clip.metadata?.full_lyrics,
    clip.metadata?.raw_lyrics,
    clip.metadata?.prompt,
    clip.meta?.lyrics,
    clip.meta?.display_lyrics,
    clip.meta?.prompt
  ];

  for (const candidate of directCandidates) {
    const text = extractText(candidate);
    if (text) return text;
  }

  return null;
}

function extractImageUrlFromClip(clip) {
  if (!clip || typeof clip !== 'object') return null;

  const directCandidates = [
    clip.image_url,
    clip.image,
    clip.image_large_url,
    clip.cover_url,
    clip.cover_image_url,
    clip.thumbnail_url,
    clip.artwork_url,
    clip.metadata?.image_url,
    clip.metadata?.image,
    clip.metadata?.cover_url,
    clip.metadata?.cover_image_url,
    clip.meta?.image_url,
    clip.meta?.image,
    clip.meta?.cover_url,
    clip.meta?.cover_image_url
  ];

  for (const candidate of directCandidates) {
    const url = extractUrl(candidate);
    if (url) return url;
  }

  return null;
}

function extractVideoUrlFromClip(clip) {
  if (!clip || typeof clip !== 'object') return null;

  const directCandidates = [
    clip.video_url,
    clip.video_cdn_url,
    clip.mp4_url,
    clip.cover_video_url,
    clip.metadata?.video_url,
    clip.metadata?.video_cdn_url,
    clip.metadata?.mp4_url,
    clip.meta?.video_url,
    clip.meta?.video_cdn_url,
    clip.meta?.mp4_url
  ];

  for (const candidate of directCandidates) {
    const url = extractUrl(candidate);
    if (url) return url;
  }

  return null;
}

function extractAudioUrlFromClip(clip) {
  if (!clip || typeof clip !== 'object') return null;

  const directCandidates = [
    clip.audio_url,
    clip.stream_audio_url,
    clip.song_path,
    clip.metadata?.audio_url,
    clip.metadata?.stream_audio_url,
    clip.metadata?.song_path,
    clip.meta?.audio_url,
    clip.meta?.stream_audio_url,
    clip.meta?.song_path
  ];

  for (const candidate of directCandidates) {
    const url = extractUrl(candidate);
    if (url) return url;
  }

  return null;
}

function getAudioUrlForFormat(song, format) {
  if (!song || !song.audio_url) return null;
  const requested = String(format || '').trim().toLowerCase();
  const originalUrl = String(song.audio_url || '').trim();
  if (!requested || !originalUrl) return originalUrl;

  const urlCandidates = [
    song.audio_url,
    song.stream_audio_url,
    song.song_path,
    song.metadata?.audio_url,
    song.metadata?.stream_audio_url,
    song.metadata?.song_path,
    song.meta?.audio_url,
    song.meta?.stream_audio_url,
    song.meta?.song_path
  ].filter(Boolean);

  for (const candidate of urlCandidates) {
    const normalized = String(candidate || '').toLowerCase();
    if (requested === 'm4a' && normalized.includes('.m4a')) return candidate;
    if (requested === 'wav' && normalized.includes('.wav')) return candidate;
    if (requested === 'mp3' && normalized.includes('.mp3')) return candidate;
  }

  // Fallback: replace the extension in the main audio URL if present.
  const queryIndex = originalUrl.indexOf('?');
  const base = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';

  const converted = base.replace(/\.([a-z0-9]{2,5})$/i, `.${requested}`);
  if (converted !== base) {
    return converted + query;
  }

  // Last resort: try adding format query param if not present.
  if (!/format=/i.test(originalUrl)) {
    return originalUrl + (originalUrl.includes('?') ? '&' : '?') + `format=${encodeURIComponent(requested)}`;
  }

  return originalUrl;
}

function extractOwnershipMetadataFromClip(clip, currentUserId, currentUserIds) {
  const idSet = currentUserIds || new Set();
  if (currentUserId && !idSet.has(currentUserId)) idSet.add(currentUserId);

  if (!clip || typeof clip !== 'object') {
    return {
      owner_user_id: currentUserId || null,
      owner_handle: null,
      owner_display_name: null,
      is_owned_by_current_user: idSet.size > 0 ? true : undefined
    };
  }

  const profiles = [
    clip.user,
    clip.owner,
    clip.creator,
    clip.author,
    clip.profile,
    clip.user_profile,
    clip.owner_profile,
    clip.creator_profile,
    clip.author_profile,
    ...(Array.isArray(clip.user_profiles) ? clip.user_profiles : []),
    ...(Array.isArray(clip.users) ? clip.users : [])
  ].filter(Boolean);

  const ownerUserId = pickFirstNonEmptyString([
    clip.user_id,
    clip.owner_user_id,
    clip.creator_user_id,
    clip.author_user_id,
    clip.owner_id,
    clip.creator_id,
    clip.author_id,
    clip.profile_id,
    ...profiles.map(profile => pickFirstNonEmptyString([
      profile?.id,
      profile?.user_id,
      profile?.profile_id,
      profile?.owner_id
    ]))
  ]) || currentUserId || null;

  const ownerHandle = normalizeHandle(pickFirstNonEmptyString([
    clip.handle,
    clip.user_handle,
    clip.owner_handle,
    clip.creator_handle,
    clip.author_handle,
    clip.username,
    ...profiles.map(profile => pickFirstNonEmptyString([
      profile?.handle,
      profile?.username,
      profile?.user_handle
    ]))
  ]));

  const ownerDisplayName = pickFirstNonEmptyString([
    clip.display_name,
    clip.user_display_name,
    clip.owner_display_name,
    clip.creator_display_name,
    clip.author_display_name,
    ...profiles.map(profile => pickFirstNonEmptyString([
      profile?.display_name,
      profile?.name
    ]))
  ]);

  return {
    owner_user_id: ownerUserId,
    owner_handle: ownerHandle,
    owner_display_name: ownerDisplayName,
    is_owned_by_current_user: idSet.size > 0 && !!ownerUserId && idSet.has(ownerUserId) ? true : undefined
  };
}

function normalizeLibraryClip(clip, currentUserId, currentUserIds) {
  const rawClip = clip?.clip || clip || {};
  return {
    id: rawClip.id,
    title: rawClip.title || `Untitled_${rawClip.id || 'song'}`,
    audio_url: extractAudioUrlFromClip(rawClip),
    video_url: extractVideoUrlFromClip(rawClip),
    image_url: extractImageUrlFromClip(rawClip),
    lyrics: extractLyricsFromClip(rawClip),
    is_public: rawClip.is_public !== false,
    created_at: rawClip.created_at || rawClip.createdAt || clip?.created_at || null,
    is_liked: rawClip.is_liked || false,
    is_stem: isStemClip(rawClip),
    upvote_count: rawClip.upvote_count || 0,
    ...extractOwnershipMetadataFromClip(rawClip, currentUserId, currentUserIds)
  };
}

async function fetchLibrarySongsBulk(token, userId, userIds, isPublicOnly) {
  const controller = new AbortController();
  activeFetchAbortController = controller;

  try {
    const response = await fetch(`https://studio-api.prod.suno.com/api/library?page=1&page_size=${BULK_LIBRARY_PAGE_SIZE}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Bulk library fetch failed with HTTP ${response.status}`);
    }

    const data = await response.json();
    const clips = data?.clips || data?.results || data?.items || data?.data || [];
    const totalResults = Number(data?.num_total_results ?? data?.total ?? data?.count ?? 0);
    const hasMore = data?.has_more === true || data?.next_cursor != null;
    const mayBeTruncated = hasMore || (Number.isFinite(totalResults) && totalResults > clips.length) || clips.length >= BULK_LIBRARY_PAGE_SIZE;

    if (mayBeTruncated) {
      return null;
    }

    return clips
      .filter(clip => !isPublicOnly || clip?.is_public)
      .map(clip => normalizeLibraryClip(clip, userId, userIds));
  } finally {
    if (activeFetchAbortController === controller) {
      activeFetchAbortController = null;
    }
  }
}

function pickFirstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function normalizeHandle(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
  return trimmed || null;
}

function collectNormalizedIds(values) {
  const ids = [];

  values.forEach(value => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();
    if (trimmed) {
      ids.push(trimmed);
    }
  });

  return Array.from(new Set(ids));
}

function collectUuidLikeIds(obj) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const stack = [obj];
  const found = new Set();
  let safety = 0;

  while (stack.length && safety < 5000) {
    safety += 1;
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;

    for (const value of Object.values(cur)) {
      if (typeof value === 'string' && uuidRegex.test(value)) {
        found.add(value.trim());
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return Array.from(found);
}

function getIdentityIds(identity) {
  return collectNormalizedIds([
    identity?.id,
    ...(Array.isArray(identity?.ids) ? identity.ids : [])
  ]);
}

function getNormalizedSongOwnerIds(song) {
  const values = [
    song?.owner_user_id,
    song?.user_id,
    song?.creator_user_id,
    song?.author_user_id,
    song?.owner_profile_id,
    song?.profile_id
  ];

  return new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
}

function getNormalizedSongOwnerHandles(song) {
  const values = [
    song?.owner_handle,
    song?.handle,
    song?.user_handle,
    song?.creator_handle,
    song?.author_handle,
    song?.username
  ];

  return new Set(values.map(normalizeHandle).filter(Boolean));
}

function hasSongOwnershipMetadata(song) {
  if (!song || typeof song !== 'object') {
    return false;
  }

  return song.is_owned_by_current_user === true ||
    song.is_owned_by_current_user === false ||
    song.is_own_song === true ||
    song.is_own_song === false ||
    getNormalizedSongOwnerIds(song).size > 0 ||
    getNormalizedSongOwnerHandles(song).size > 0 ||
    typeof song?.owner_display_name === 'string';
}

function isSongOwnedByIdentity(song, identity) {
  if (!song || !identity) {
    return false;
  }

  const identityIds = getIdentityIds(identity);
  const identityHandle = normalizeHandle(identity.handle);
  const identityDisplayName = pickFirstNonEmptyString([identity.displayName]);

  const ownerIds = getNormalizedSongOwnerIds(song);
  if (identityIds.some(id => ownerIds.has(id))) {
    return true;
  }

  const ownerHandles = getNormalizedSongOwnerHandles(song);
  if (identityHandle && ownerHandles.has(identityHandle)) {
    return true;
  }

  if (song.is_owned_by_current_user === true || song.is_own_song === true) {
    return true;
  }

  if (identityDisplayName && typeof song?.owner_display_name === 'string') {
    return song.owner_display_name.trim().toLowerCase() === identityDisplayName.trim().toLowerCase();
  }

  return false;
}

function isSongExplicitlyKnownToBeOtherArtist(song) {
  return !!song && (song.is_owned_by_current_user === false || song.is_own_song === false);
}

function canDownloadSongForIdentity(song, identity) {
  if (!song || typeof song !== 'object') {
    return false;
  }

  // Positive ownership match (multi-ID check) — always allow
  if (isSongOwnedByIdentity(song, identity)) {
    return true;
  }

  if (isSongExplicitlyKnownToBeOtherArtist(song)) {
    return false;
  }

  // If the song has an owner ID and the identity has IDs, but none overlap verify before blocking
  const identityIds = getIdentityIds(identity);
  const ownerIds = getNormalizedSongOwnerIds(song);

  if (identityIds.length > 0 && ownerIds.size > 0) {
    const isMatch = identityIds.some(id => ownerIds.has(id));
    if (!isMatch) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const identityHasUuid = identityIds.some(id => uuidRegex.test(id));
      const ownerHasUuid = Array.from(ownerIds).some(id => uuidRegex.test(id));
      
      if (identityHasUuid && ownerHasUuid) {
        return false; // Confident mismatch on UUIDs
      }

      const clerkRegex = /^user_[a-zA-Z0-9]+$/i;
      const identityHasClerk = identityIds.some(id => clerkRegex.test(id));
      const ownerHasClerk = Array.from(ownerIds).some(id => clerkRegex.test(id));

      if (identityHasClerk && ownerHasClerk) {
        return false; // Confident mismatch on Clerk IDs
      }
    }
  }

  // Otherwise: ownership is inconclusive (IDs might use different formats).
  // Allow the download rather than blocking the user's own songs.
  return true;
}

async function fetchSongsList(isPublicOnly, maxPages, checkNewOnly = false, knownIds = [], metadataRefreshIds = []) {
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

    const identity = await fetchCurrentUserIdentity(token);
    const allIdentityIds = getIdentityIds(identity);
    const userId = allIdentityIds[0] || null;

    if (!checkNewOnly) {
      notifyTab({ action: "log", text: "✅ Token found! Fetching songs list..." });
    }

    if (!checkNewOnly) {
      try {
        notifyTab({ action: "log", text: "⚡ Fast library rebuild via bulk library API..." });
        const bulkSongs = await fetchLibrarySongsBulk(token, userId, new Set(allIdentityIds), isPublicOnly);

        if (stopFetchRequested) {
          return;
        }

        if (Array.isArray(bulkSongs)) {
          isFetching = false;
          notifyTab({ action: "songs_fetched", songs: bulkSongs, checkNewOnly: false });
          return;
        }

        notifyTab({ action: "log", text: "ℹ️ Bulk library API appears truncated. Falling back to cursor fetch..." });
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }

        notifyTab({ action: "log", text: `ℹ️ Bulk library fetch failed (${err.message}). Falling back to cursor fetch...` });
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (t, p, m, c, k, u, ids, mr) => {
        window.sunoAuthToken = t;
        window.sunoPublicOnly = p;
        window.sunoMaxPages = m;
        window.sunoCheckNewOnly = c;
        window.sunoKnownIds = k;
        window.sunoUserId = u;
        window.sunoUserIds = ids;
        window.sunoMetadataRefreshIds = mr;
        window.sunoStopFetch = false;
        window.sunoMode = "fetch";
      },
      args: [token, isPublicOnly, maxPages, checkNewOnly, knownIds, userId, allIdentityIds, metadataRefreshIds]
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

async function fetchCurrentUserIdentity(token) {
  log('[fetchCurrentUserIdentity] START - token length:', token?.length || 0);
  
  let identity = { id: null, ids: [], handle: null, displayName: null };
  
  try {
    const endpoints = [
      'https://studio-api.prod.suno.com/api/me/',
      'https://studio-api.prod.suno.com/api/me'
    ];

    for (const url of endpoints) {
      try {
        log('[fetchCurrentUserIdentity] Fetching from:', url);
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        log('[fetchCurrentUserIdentity] Response status:', res.status);
        if (!res.ok) continue;

        const data = await res.json();
        log('[fetchCurrentUserIdentity] Got data from /api/me/');
        
        const candidateIds = collectNormalizedIds([
          data?.id,
          data?.user_id,
          data?.account_id,
          data?.profile_id,
          data?.user?.id,
          data?.user?.user_id,
          data?.user?.account_id,
          data?.user?.profile_id,
          data?.profile?.id,
          data?.profile?.user_id,
          data?.profile?.owner_id,
          ...collectUuidLikeIds(data)
        ]);
        
        identity = {
          id: candidateIds[0] || null,
          ids: candidateIds,
          handle: normalizeHandle(pickFirstNonEmptyString([
            data?.handle,
            data?.username,
            data?.user?.handle,
            data?.user?.username,
            data?.profile?.handle,
            data?.profile?.username
          ])),
          displayName: pickFirstNonEmptyString([
            data?.display_name,
            data?.name,
            data?.user?.display_name,
            data?.user?.name,
            data?.profile?.display_name,
            data?.profile?.name
          ])
        };

        log('[fetchCurrentUserIdentity] Base identity IDs from /api/me/:', identity.ids);
        break;  // Got data, stop trying endpoints
      } catch (e) {
        log('[fetchCurrentUserIdentity] Error fetching from', url, ':', e?.message);
        // try next endpoint
      }
    }
  } catch (e) {
    log('[fetchCurrentUserIdentity] Outer catch:', e?.message);
  }

  // ALWAYS try to get Suno profile UUID from library (whether /api/me/ worked or not)
  const hasUuid = identity.ids.some(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  log('[fetchCurrentUserIdentity] Has UUID in identity?', hasUuid);
  
  if (!hasUuid) {
    log('[fetchCurrentUserIdentity] No UUID, fetching library to extract Suno profile UUID...');
    try {
      const libRes = await fetch('https://studio-api.prod.suno.com/api/library?page=1', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      log('[fetchCurrentUserIdentity] Library fetch status:', libRes.status);
      
      if (libRes.ok) {
        const libData = await libRes.json();
        const items = libData?.clips || libData?.results || libData?.items || libData?.data || [];
        
        log('[fetchCurrentUserIdentity] Found items in library:', items.length);
        
        let ownSong = items.find(item => {
          const c = item?.clip || item;
          if (c?.is_owned_by_current_user === true || c?.is_own_song === true) return true;
          const ownerHandle = c?.handle || c?.user_handle || c?.owner_handle;
          if (ownerHandle && identity.handle && String(ownerHandle).toLowerCase() === String(identity.handle).toLowerCase()) return true;
          return false;
        });

        // Don't arbitrarily pull the first song's UUID since it might belong to another artist in the library.
        if (!ownSong) {
          log('[fetchCurrentUserIdentity] Could not definitively verify any library song as owned. Skipping UUID extraction.');
        } else {
          log('[fetchCurrentUserIdentity] Found verified own song!');
        }
        
        if (ownSong) {
          const songClip = ownSong?.clip || ownSong;
          const ownerUuid = songClip?.owner_user_id || songClip?.user_id || songClip?.profile_id;
          log('[fetchCurrentUserIdentity] Extracted owner UUID:', ownerUuid);
          
          if (ownerUuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerUuid)) {
            log('[fetchCurrentUserIdentity] Valid UUID found! Adding to identity:', ownerUuid);
            identity.ids = collectNormalizedIds([...identity.ids, ownerUuid]);
            log('[fetchCurrentUserIdentity] Updated identity IDs with UUID:', identity.ids);
          } else {
            log('[fetchCurrentUserIdentity] Owner UUID is not a valid UUID format:', ownerUuid);
          }
        }
      } else {
        log('[fetchCurrentUserIdentity] Library fetch failed with status:', libRes.status);
      }
    } catch (e) {
      log('[fetchCurrentUserIdentity] Failed to fetch library:', e?.message);
    }
  }

  // If we still have no identity, try direct tab fallback
  if (identity.ids.length === 0 && !identity.handle && !identity.displayName) {
    log('[fetchCurrentUserIdentity] No identity from /api/me/, trying direct tab fallback...');
    try {
      const preferredTabs = [];
      if (typeof downloadRequestorTabId === 'number') preferredTabs.push(downloadRequestorTabId);
      if (typeof fetchRequestorTabId === 'number') preferredTabs.push(fetchRequestorTabId);

      const sunoTabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
      const candidateTabIds = Array.from(new Set([
        ...preferredTabs,
        ...sunoTabs.map(tab => tab.id).filter(tabId => typeof tabId === 'number')
      ]));

      for (const tabId of candidateTabIds) {
        const tabIdentity = await fetchCurrentUserIdentityDirect(tabId);
        if (tabIdentity && (tabIdentity.ids.length > 0 || tabIdentity.handle || tabIdentity.displayName)) {
          log('[fetchCurrentUserIdentity] Got identity from tab', tabId);
          identity = tabIdentity;
          break;
        }
      }
    } catch (e) {
      log('[fetchCurrentUserIdentity] Direct tab fallback failed:', e?.message || String(e));
    }
  }

  log('[fetchCurrentUserIdentity] FINAL identity:', identity);
  return identity;
}

async function fetchCurrentUserId(token) {
  const identity = await fetchCurrentUserIdentity(token);
  return getIdentityIds(identity)[0] || null;
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

function extractFirstVideoUrlFromHtml(html, songId = '') {
  if (typeof html !== 'string' || !html.trim()) {
    return null;
  }

  const derivedMatch = html.match(/video_gen_([0-9a-f-]{36})[^"'\s<>]*?(?:cover_snapshot|image\.jpe?g|video_upload)/i);
  if (derivedMatch?.[1]) {
    return `https://cdn1.suno.ai/video_gen_${derivedMatch[1]}_processed_video.mp4`;
  }

  const urls = [];
  const seen = new Set();
  const patterns = [
    /<source[^>]+src=["']([^"']+\.(?:mp4|webm|mov|m4v)(?:\?[^"']*)?)["']/gi,
    /<video[^>]+src=["']([^"']+\.(?:mp4|webm|mov|m4v)(?:\?[^"']*)?)["']/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1];
      const decoded = raw.replace(/&amp;/g, '&');
      if (!seen.has(decoded)) {
        seen.add(decoded);
        urls.push(decoded);
      }
    }
  }

  if (urls.length === 0) {
    return null;
  }

  const normalizedSongId = String(songId || '').trim().toLowerCase();
  const scoreUrl = (url) => {
    const normalized = String(url || '').toLowerCase();
    let score = 0;

    // Strongly prefer URLs that are clearly tied to this song id.
    if (normalizedSongId) {
      if (normalized.includes(normalizedSongId)) score += 220;
      if (normalized.includes(`video_gen_${normalizedSongId}`)) score += 120;
    }

    // Prefer Suno's generated final cover video.
    if (normalized.includes('processed_video')) score += 100;
    if (normalized.includes('video_gen_')) score += 60;

    // De-prioritize generic uploads/snapshots and uncertain variants.
    if (normalized.includes('video_upload')) score -= 35;
    if (normalized.includes('cover_snapshot')) score -= 35;

    // Generic UUID-only mp4 URLs are often not the actual song cover video.
    if (/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp4(?:\?|$)/i.test(normalized)) {
      score -= 80;
    }

    // Prefer mp4 for broad compatibility.
    if (normalized.includes('.mp4')) score += 10;

    return score;
  };

  urls.sort((a, b) => scoreUrl(b) - scoreUrl(a));
  return urls[0] || null;
}

function extractSongIdFromPlaylistEntry(entry) {
  const candidates = [
    entry?.clip?.id,
    entry?.song?.id,
    entry?.item?.id,
    entry?.id,
    entry?.clip_id,
    entry?.clipId,
    entry?.song_id,
    entry?.songId,
    entry?.gen_id
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractJsonPayloadsFromHtml(html) {
  const payloads = [];
  const patterns = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*type=["']application\/(?:json|ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;

      try {
        payloads.push(JSON.parse(raw));
      } catch (e) {
        // ignore invalid JSON blobs embedded in HTML
      }
    }
  }

  return payloads;
}

function extractPlaylistEntriesFromJsonPayloads(payloads, playlistId) {
  const trackCollectionKeys = new Set([
    'playlist_clips',
    'playlist_songs',
    'songs',
    'tracks',
    'entries',
    'clips',
    'results',
    'items'
  ]);
  const collected = [];
  const seenIds = new Set();

  const visit = (node, inPlaylistContext = false, path = []) => {
    if (!node || typeof node !== 'object') return;

    const playlistMatch = inPlaylistContext
      || node.id === playlistId
      || node.playlist_id === playlistId
      || node.playlistId === playlistId
      || (typeof node.url === 'string' && node.url.includes(`/playlist/${playlistId}`));

    if (Array.isArray(node)) {
      node.forEach(item => visit(item, playlistMatch, path));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const loweredKey = String(key || '').toLowerCase();
      const nextPath = path.concat(loweredKey);

      if (Array.isArray(value)) {
        const keyHintsPlaylist = loweredKey.includes('playlist') || nextPath.some(segment => segment.includes('playlist'));
        if (trackCollectionKeys.has(loweredKey) && (playlistMatch || keyHintsPlaylist)) {
          value.forEach(item => {
            const songId = extractSongIdFromPlaylistEntry(item);
            if (!songId || seenIds.has(songId)) return;
            seenIds.add(songId);
            collected.push(item);
          });
        }

        value.forEach(item => visit(item, playlistMatch || keyHintsPlaylist, nextPath));
        continue;
      }

      if (value && typeof value === 'object') {
        visit(value, playlistMatch, nextPath);
      }
    }
  };

  payloads.forEach(payload => visit(payload, false, []));
  return collected;
}

function extractPlaylistSongIdsFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const seen = new Set();
  const songIds = [];
  const patterns = [
    /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
    /["'](?:song_id|songId|clip_id|clipId|gen_id)["']\s*:\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const songId = match[1];
      if (!songId || seen.has(songId)) continue;
      seen.add(songId);
      songIds.push(songId);
    }
  }

  return songIds;
}

async function fetchPlaylistSongsFromPageHtml(playlistId) {
  const playlistUrl = `https://suno.com/playlist/${encodeURIComponent(playlistId)}`;
  const response = await fetch(playlistUrl, {
    method: 'GET',
    credentials: 'include'
  });

  if (!response.ok) {
    return { ok: false, status: response.status, error: `Playlist page request failed (${response.status})` };
  }

  const html = await response.text();
  const payloads = extractJsonPayloadsFromHtml(html);
  const playlistEntries = extractPlaylistEntriesFromJsonPayloads(payloads, playlistId);

  if (playlistEntries.length > 0) {
    return {
      ok: true,
      status: response.status,
      data: {
        playlist_clips: playlistEntries,
        num_total_results: playlistEntries.length
      },
      source: 'playlist-page-html-json'
    };
  }

  const songIds = extractPlaylistSongIdsFromHtml(html);
  if (songIds.length > 0) {
    return {
      ok: true,
      status: response.status,
      data: {
        playlist_clips: songIds.map(songId => ({ song_id: songId })),
        num_total_results: songIds.length
      },
      source: 'playlist-page-html-ids'
    };
  }

  return { ok: false, status: response.status, error: 'No playlist songs found on playlist page' };
}
// Fallback download for platforms without chrome.downloads (e.g. Firefox Android).
// Fetches the resource in the background service worker (avoids CORS), converts to a
// base64 data-URL, then injects a one-shot anchor-click into the active Suno tab.
async function downloadViaInject(url, filename) {
  const tab = await getSunoTab();
  if (!tab?.id) throw new Error('No Suno tab found for in-page download.');

  let dataUrl = url;
  if (!url.startsWith('data:')) {
    const token = await getApiTokenWithFallback('downloadViaInject');
    const fetchOptions = {};
    if (token) {
      fetchOptions.headers = { Authorization: `Bearer ${token}` };
    }
    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const view = new Uint8Array(buffer);
    // btoa() is available in service workers; process in chunks to avoid stack overflow
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < view.length; i += chunkSize) {
      binary += String.fromCharCode(...view.subarray(i, Math.min(i + chunkSize, view.length)));
    }
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (dUrl, fname) => {
      const a = document.createElement('a');
      a.href = dUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    args: [dataUrl, filename]
  });

  return true;
}

function replaceFilenameExtension(filename, nextExtension) {
  if (typeof filename !== 'string' || !filename) {
    return filename;
  }

  const cleanExtension = String(nextExtension || '').trim().replace(/^\./, '').toLowerCase();
  if (!cleanExtension) {
    return filename;
  }

  return filename.replace(/\.[^.\/]+$/, `.${cleanExtension}`);
}

function inferAudioExtension(url, contentType, fallbackExtension = 'm4a') {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('audio/wav') || normalizedType.includes('audio/x-wav') || normalizedType.includes('audio/wave')) {
    return 'wav';
  }
  if (normalizedType.includes('audio/mpeg') || normalizedType.includes('audio/mp3')) {
    return 'mp3';
  }
  if (normalizedType.includes('audio/mp4') || normalizedType.includes('audio/x-m4a')) {
    return 'm4a';
  }
  if (normalizedType.includes('audio/ogg')) {
    return 'ogg';
  }

  const normalizedUrl = String(url || '').split('?')[0].toLowerCase();
  const extensionMatch = normalizedUrl.match(/\.([a-z0-9]{2,5})$/i);
  if (extensionMatch?.[1]) {
    return extensionMatch[1].toLowerCase();
  }

  return String(fallbackExtension || 'm4a').toLowerCase();
}

async function fetchResourceBlob(url, token) {
  const attempts = [];
  if (token) {
    attempts.push({
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include'
    });
  }
  attempts.push({
    headers: {},
    credentials: 'include'
  });

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: attempt.headers,
        credentials: attempt.credentials
      });

      if (!response.ok) {
        lastError = new Error(`Fetch failed: HTTP ${response.status}`);
        continue;
      }

      const blob = await response.blob();
      return {
        blob,
        contentType: response.headers.get('content-type') || blob.type || '',
        finalUrl: response.url || url
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Fetch failed');
}

async function downloadBlobFile(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await downloadOneFile(objectUrl, filename);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function downloadSelectedSongs(folderName, songs, format = 'm4a', jobId = 0, downloadOptions = { music: true, lyrics: true, image: true }) {
  const cleanFolder = String(folderName || '').replace(/[^a-zA-Z0-9_-]/g, "");

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

  try {
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
      // Firefox Android doesn't support the downloads API; fall back to in-page download.
      return await downloadViaInject(url, filename);
    }

    // Set up completion tracking BEFORE starting the download to avoid a race
    // condition where fast downloads (e.g. blob URLs) complete before the
    // listener is registered.
    let downloadId = null;
    let settled = false;
    let settleResolve, settleReject;

    const completionPromise = new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(listener);
      fn(value);
    }

    const timeoutId = setTimeout(() => {
      settle(settleReject, new Error('Download timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    function listener(delta) {
      if (downloadId === null || delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete') {
        settle(settleResolve, undefined);
      } else if (state === 'interrupted') {
        settle(settleReject, new Error(delta.error?.current || 'Download interrupted'));
      }
    }

    chrome.downloads.onChanged.addListener(listener);

    try {
      downloadId = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify"
      });
    } catch (err) {
      // Some Firefox Android builds reject custom filenames. Retry without filename.
      if (isAndroid || isFirefox) {
        try {
          downloadId = await chrome.downloads.download({
            url,
            conflictAction: "uniquify"
          });
        } catch (retryErr) {
          settle(settleReject, retryErr);
          await completionPromise;
        }
      } else {
        settle(settleReject, err);
        await completionPromise;
      }
    }

    if (typeof downloadId !== 'number') {
      settle(settleReject, new Error('Download failed: no download ID returned'));
      await completionPromise;
    }

    activeDownloadIds.add(downloadId);
    persistDownloadState();

    // Check if the download already completed before we linked the listener
    // to this downloadId (handles the race condition for very fast downloads).
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.state === 'complete') {
        settle(settleResolve, undefined);
      } else if (item?.state === 'interrupted') {
        settle(settleReject, new Error(item?.error || 'Download interrupted'));
      }
    } catch (_) {
      // search unavailable, rely on the listener
    }

    await completionPromise;
    return true;
  }

  const shouldDownloadMusic = !!downloadOptions?.music;
  const shouldDownloadLyrics = !!downloadOptions?.lyrics;
  const shouldDownloadImage = !!downloadOptions?.image;
  const selectedTypes = [];
  if (shouldDownloadMusic) selectedTypes.push(format.toUpperCase());
  if (shouldDownloadLyrics) selectedTypes.push('lyrics');
  if (shouldDownloadImage) selectedTypes.push('images');

  const token = await getApiTokenWithFallback('download_selected');
  const currentUserIdentity = token ? await fetchCurrentUserIdentity(token) : null;
  const canVerifyOwnership = !!(getIdentityIds(currentUserIdentity).length > 0 || currentUserIdentity?.handle || currentUserIdentity?.displayName);

  // Final ownership gate: trust explicit per-song ownership metadata from the fetched library payload.
  // This avoids false denials when API identity lookup returns a different ID format than song owner IDs.
  const downloadableSongs = songs.filter(song => !isSongExplicitlyKnownToBeOtherArtist(song));
  const blockedSongs = songs.filter(song => isSongExplicitlyKnownToBeOtherArtist(song));

  if (!canVerifyOwnership) {
    notifyDownloadUi({
      action: 'log',
      text: '⚠️ Could not verify account identity via API. Using song ownership metadata for download eligibility.'
    });
  }

  if (selectedTypes.length === 0) {
    const completionText = '⚠️ Nothing selected to download.';
    const notifyNoTypes = (msg) => {
      if (downloadRequestorTabId) {
        chrome.tabs.sendMessage(downloadRequestorTabId, msg).catch(() => {});
      }
    };
    notifyNoTypes({ action: "log", text: completionText });
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();
    notifyNoTypes({ action: "download_complete", stopped: false, text: completionText, ok: false });
    return;
  }

  if (blockedSongs.length > 0) {
    notifyDownloadUi({
      action: 'log',
      text: `🚫 Skipping ${blockedSongs.length} song(s) by other artists. Those tracks may only be saved to the local database.`
    });
  }

  if (downloadableSongs.length === 0) {
    const completionText = '🚫 Only your own songs can be downloaded as files. Songs by other artists may only be saved to the local database.';
    notifyDownloadUi({
      action: 'log',
      text: completionText
    });
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();
    notifyDownloadUi({ action: 'download_complete', stopped: false, text: completionText, ok: false });
    return;
  }

  notifyDownloadUi({ action: "log", text: `🚀 Starting download of ${downloadableSongs.length} song(s): ${selectedTypes.join(', ')}...` });

  if (isAndroid) {
    notifyDownloadUi({ action: "log", text: '📱 Android detected: using compatibility mode for file saving.' });
  }

  let downloadedCount = 0;
  let failedCount = 0;
  let downloadedFileCount = 0;

  for (const song of downloadableSongs) {
    if (stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId) {
      notifyDownloadUi({ action: "log", text: "⏹️ Download stopped by user." });
      break;
    }

    const title = song.title || `Untitled_${song.id}`;
    const safeTitle = sanitizeFilename(title);

    try {
      let downloadedSomething = false;

      // 1. Download Music
      if (shouldDownloadMusic) {
        if (!song.audio_url) {
          throw new Error('No audio URL available');
        }

        const requestedExt = format.toLowerCase();
        const audioUrl = getAudioUrlForFormat(song, requestedExt) || song.audio_url;
        const baseName = `${safeTitle}_${song.id.slice(-4)}.${requestedExt}`;
        const directFilename = buildDownloadFilename(baseName);

        try {
          await downloadOneFile(audioUrl, directFilename);
          downloadedSomething = true;
          downloadedFileCount += 1;
        } catch (directError) {
          notifyDownloadUi({
            action: 'log',
            text: `ℹ️ ${title}: direct audio download failed (${directError.message}). Retrying via authenticated fetch.`
          });

          let fallbackFilename = directFilename;
          const audioFile = await fetchResourceBlob(audioUrl, token);
          const actualExt = inferAudioExtension(audioFile.finalUrl, audioFile.contentType, requestedExt);

          if (actualExt && actualExt !== requestedExt) {
            fallbackFilename = replaceFilenameExtension(fallbackFilename, actualExt);
            notifyDownloadUi({
              action: 'log',
              text: `ℹ️ ${title}: Suno returned ${actualExt.toUpperCase()} audio; saving with that format.`
            });
          }

          await downloadBlobFile(audioFile.blob, fallbackFilename);
          downloadedSomething = true;
          downloadedFileCount += 1;
        }
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
        downloadedSomething = true;
        downloadedFileCount += 1;
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

        const imageExt = (imageUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'jpg').toLowerCase();
        const baseName = `${safeTitle}_${song.id.slice(-4)}.${imageExt}`;
        const filename = buildDownloadFilename(baseName);
        await downloadOneFile(imageUrl, filename);
        downloadedSomething = true;
        downloadedFileCount += 1;
      }

      if (!downloadedSomething) {
        throw new Error('No downloadable files available for the selected options');
      }

      downloadedCount++;
      notifyDownloadUi({ action: "log", text: `✅ Downloaded: ${title} (${downloadedCount}/${downloadableSongs.length})` });
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

  const completionText = wasStopped
    ? `⏹️ Download stopped. ${downloadedCount} songs downloaded, ${failedCount} failed, ${blockedSongs.length} blocked.`
    : downloadedFileCount > 0
      ? `✅ Download complete! ${downloadedCount} songs downloaded, ${downloadedFileCount} files saved, ${failedCount} failed, ${blockedSongs.length} blocked.`
      : `❌ Download finished without saving files. ${failedCount} failed, ${blockedSongs.length} blocked.`;

  notifyDownloadUi({
    action: "log",
    text: completionText
  });
  notifyDownloadUi({ action: "download_complete", stopped: wasStopped, text: completionText, ok: downloadedFileCount > 0 && !wasStopped });
  } catch (fatalError) {
    log('downloadSelectedSongs fatal error:', fatalError?.message || String(fatalError));
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();
    const errorText = `❌ Download failed unexpectedly: ${fatalError?.message || 'Unknown error'}`;
    notifyDownloadUi({ action: 'log', text: errorText });
    notifyDownloadUi({ action: 'download_complete', stopped: false, text: errorText, ok: false });
  }
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

  switch (n.notification_type || n.type) {
    case 'clip_like':
      return { title: 'Suno: New Like', message: `${who} liked your song "${title}"` };
    case 'clip_comment':
      return { title: 'Suno: New Comment', message: `${who} commented on your song "${title}"` };
    case 'comment_like':
      return { title: 'Suno: Comment Liked', message: `${who} liked your comment on "${title}"` };
    case 'comment_reply':
      return { title: 'Suno: Comment Reply', message: `${who} replied to your comment on "${title}"` };
    case 'comment_mention':
      return { title: 'Suno: You were mentioned', message: `${who} mentioned you in a comment on "${title}"` };
    case 'caption_mention':
      return { title: 'Suno: You were mentioned', message: `${who} mentioned you in their caption on "${title}"` };
    case 'video_cover_hook_like':
      return { title: 'Suno: Hook Liked', message: `${who} liked your video cover in Hooks` };
    case 'hook_like':
      return { title: 'Suno: Hook Liked', message: `${who} liked your hook` };
    case 'hook_comment':
      return { title: 'Suno: Hook Comment', message: `${who} commented on your hook` };
    case 'playlist_like':
      return { title: 'Suno: Playlist Liked', message: `${who} liked your playlist "${title}"` };
    case 'follow':
      return { title: 'Suno: New Follower', message: `${who} followed you` };
    default:
      return { title: 'Suno Notification', message: `New notification from ${who || 'someone'}` };
  }
}

function getSunoUrl(n) {
  const id = n.content_id || '';
  const handle = (n.user_profiles || [])[0]?.handle || '';
  switch (n.notification_type || n.type) {
    case 'clip_like':
    case 'clip_comment':
      return `https://suno.com/song/${id}`;
    case 'comment_like':
    case 'comment_reply':
    case 'comment_mention':
      return `https://suno.com/song/${id}?show_comments=true`;
    case 'caption_mention':
      return `https://suno.com/song/${id}`;
    case 'video_cover_hook_like':
    case 'hook_like':
    case 'hook_comment':
      return `https://suno.com/hook/${id}`;
    case 'playlist_like':
      return `https://suno.com/playlist/${id}`;
    case 'follow':
      return handle ? `https://suno.com/@${handle}` : 'https://suno.com';
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
