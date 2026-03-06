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
const DOWNLOAD_STATE_KEY = 'sunoDownloadState';

// Gate: resolves once loadState() has completed, so alarm handlers
// don't operate on empty in-memory state after a service-worker restart.
let stateReady;
const stateReadyPromise = new Promise(r => { stateReady = r; });

// Offscreen document creation guard (prevent race conditions)
let offscreenCreating = false;
let offscreenExists = false;

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
      // NEU: Clerk Session Token
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
      log("Clerk __session Cookie gefunden:", cookie.value.slice(0, 20) + "...");
      return cookie.value;
    }
    
    log("Clerk __session Cookie NICHT gefunden");
    return null;
  } catch (err) {
    log("Error getting Clerk session cookie:", err.message);
    return null;
  }
}

/**
 * Refresht das Bearer Token direkt über Clerk's API
 * Nutzt das Session Token aus dem Cookie
 */
async function refreshTokenViaClerkAPI(sessionToken) {
  try {
    // Clerk's Token-Endpoint (Standard für alle Clerk-Apps)
    const response = await fetch('https://clerk.suno.com/v1/client/sessions/active/tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        template: ''  // Leerer Template-Name = Standard Bearer Token
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
        expiresAt: Date.now() + (50 * 60 * 1000) // 50 Minuten
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
 * Hauptfunktion: Token bereitstellen - mit automatischem Refresh
 * Funktioniert OHNE aktiven Tab!
 */
async function ensureValidTokenCookieBased(tabId) {
  log("ensureValidTokenCookieBased called for tab", tabId);

  const st = ensureTabState(tabId);
  const now = Date.now();

  // Prüfen: Haben wir ein gültiges Token im Cache?
  if (st.token && st.tokenTimestamp && (now - st.tokenTimestamp < 45 * 60 * 1000)) {
    log("Returning CACHED token (age:", Math.floor((now - st.tokenTimestamp) / 60000), "min)");
    return st.token;
  }

  log("Token expired or missing - fetching new token via Clerk API");

  // Schritt 1: Session Token aus Cookie holen
  const sessionToken = await getClerkSessionFromCookies();
  if (!sessionToken) {
    log("FEHLER: Kein Clerk Session Cookie gefunden - User muss bei Suno eingeloggt sein!");
    return null;
  }

  // Schritt 2: Neues Bearer Token von Clerk API holen
  const tokenData = await refreshTokenViaClerkAPI(sessionToken);
  if (!tokenData) {
    log("FEHLER: Clerk API Token-Refresh fehlgeschlagen");
    return null;
  }

  // Schritt 3: Token cachen
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
 * Service Worker Alarm für automatischen Token-Refresh
 * Läuft alle 45 Minuten, unabhängig von Tab-Status
 */
chrome.alarms.create('tokenRefresh', {
  delayInMinutes: 1,        // Erste Ausführung nach 1 Minute
  periodInMinutes: 45       // Dann alle 45 Minuten
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tokenRefresh') {
    await stateReadyPromise;
    log("⏰ ALARM: Token Refresh triggered");
    
    // Für alle aktiven Collector: Token refreshen
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        log("⏰ Refreshing token for active collector", tabId);
        await ensureValidTokenCookieBased(tabId);
      }
    }
  }
});

/**
 * Sanfter Keep-Alive ohne Tab-Reload
 * Verhindert Tab-Discarding durch minimale Interaktion
 */
async function keepTabAlive(tabId) {
  // Tab-independent mode: no specific Suno tab required
  if (typeof tabId !== 'number' || isNaN(tabId)) return false;
  try {
    // Prüfen ob Tab existiert
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;

    // Minimale Script-Injection um Tab "aktiv" zu halten
    // Dies verhindert dass Edge den Tab einfriert
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "ISOLATED",  // ISOLATED statt MAIN - weniger invasiv
      func: () => {
        // Timestamp setzen - minimal invasiv
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
 * Keep-Alive Alarm - alle 5 Minuten
 * Deutlich seltener als Tab-Reload, aber genug um Discarding zu verhindern
 */
chrome.alarms.create('keepAlive', {
  delayInMinutes: 1,
  periodInMinutes: 5  // Alle 5 Minuten statt 10 Minuten Reload
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    await stateReadyPromise;
    log("⏰ ALARM: Keep-Alive triggered");
    
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        await keepTabAlive(typeof tabId === 'string' ? Number(tabId) : tabId);
      }
    }
  }
});

// ============================================================================
// FALLBACK: Token aus MAIN World (nur wenn Cookie-Methode fehlschlägt)
// ============================================================================

async function fetchTokenDirect(tabId) {
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
 * Haupt-Token-Funktion mit Fallback-Strategie
 */
async function ensureValidToken(tabId) {
  log("ensureValidToken called for tab", tabId);

  // STRATEGIE 1: Cookie-basiert (funktioniert auch bei schlafendem Tab)
  const cookieToken = await ensureValidTokenCookieBased(tabId);
  if (cookieToken) {
    log("✓ Token via Cookie-Methode erhalten");
    return cookieToken;
  }

  log("⚠ Cookie-Methode fehlgeschlagen, versuche MAIN-World-Fallback...");

  // STRATEGIE 2: Fallback zu MAIN world (alter Ansatz)
  const st = ensureTabState(tabId);
  const MAX_AGE = 50 * 60 * 1000;

  // Cache prüfen
  if (st.token && st.tokenTimestamp && Date.now() - st.tokenTimestamp < MAX_AGE) {
    log("✓ Returning cached token from MAIN world method");
    return st.token;
  }

  // Versuche Token aus MAIN world zu holen
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

  log("❌ FEHLER: Beide Token-Strategien fehlgeschlagen!");
  st.lastError = "Token refresh failed - both strategies exhausted";
  return null;
}

// ============================================================================
// Offscreen-Dokument
// ============================================================================

async function ensureOffscreen() {
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
// Nachrichten vom Offscreen
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
    const st = ensureTabState(msg.tabId);
    Object.assign(st, msg.state);

    showDesktopNotifications(msg.tabId, st);
    saveState();

    chrome.runtime.sendMessage({
      type: "stateUpdate",
      tabId: msg.tabId,
      state: { ...st }
    });

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "offscreenTokenExpired" || msg.type === "offscreenNoToken") {
    log("[NVO] Token expired/missing for Tab", msg.tabId, "- triggering refresh");
    
    // WICHTIG: Kein Tab-Reload mehr nötig!
    // Token wird beim nächsten ensureValidToken() automatisch refreshed
    const st = ensureTabState(msg.tabId);
    st.token = null;  // Token invalidieren
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

  // ---- UI → Hintergrund ----

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
        
        log("✓ Collector aktiviert für Tab", msg.tabId);
        
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
      log("Collector deaktiviert für Tab", msg.tabId);
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
    // Keepalive wird jetzt über Chrome Alarms gehandelt
    // Dieser Handler kann bleiben für manuelle Triggers
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        keepTabAlive(Number(tabId));
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "pingMainWorld") {
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
    try { chrome.runtime.sendMessage({ action: "download_stopped" }); } catch (e) {}
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
    // Forward log messages to content script
    const destTab = sender.tab?.id || fetchRequestorTabId;
    if (destTab) {
      chrome.tabs.sendMessage(destTab, { action: "log", text: msg.text }).catch(() => {});
    }
  }
});

// ============================================================================
// Tab geschlossen
// ============================================================================

// Global (tab-independent) state is preserved when a Suno tab closes.
// Only remove per-tab state slots that may still exist from legacy sessions.
chrome.tabs.onRemoved.addListener(tabId => {
  log("tab removed", tabId);
  if (tabState[tabId]) {
    chrome.runtime.sendMessage({ type: "offscreenClearTab", tabId });
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
  try {
    chrome.runtime.sendMessage({
      action: 'download_state',
      isDownloading,
      stopRequested: stopDownloadRequested,
      jobId: currentDownloadJobId
    });
  } catch (e) {
    // ignore
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
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify"
    });
    if (typeof downloadId === 'number') {
      activeDownloadIds.add(downloadId);
      persistDownloadState();
    }
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
    chrome.runtime.sendMessage({ action: "log", text: '⚠️ Nothing selected to download.' });
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();
    chrome.runtime.sendMessage({ action: "download_complete", stopped: false });
    return;
  }

  chrome.runtime.sendMessage({ action: "log", text: `🚀 Starting download of ${songs.length} song(s): ${selectedTypes.join(', ')}...` });

  if (isAndroid) {
    chrome.runtime.sendMessage({ action: "log", text: '📱 Android detected: saving files without subfolders.' });
  }

  let downloadedCount = 0;
  let failedCount = 0;

  for (const song of songs) {
    if (stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId) {
      chrome.runtime.sendMessage({ action: "log", text: "⏹️ Download stopped by user." });
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
        const baseName = `${safeTitle}_${song.id.slice(-4)}.jpg`;
        const filename = buildDownloadFilename(baseName);
        await downloadOneFile(song.image_url, filename);
      }

      downloadedCount++;
      chrome.runtime.sendMessage({ action: "log", text: `✅ Downloaded: ${title} (${downloadedCount}/${songs.length})` });
    } catch (err) {
      failedCount++;
      chrome.runtime.sendMessage({ action: "log", text: `❌ Failed: ${title} - ${err.message}` });
    }

    // Small delay between songs
    await new Promise(r => setTimeout(r, 200));
  }

  stopDownloadRequested = false;
  isDownloading = false;
  activeDownloadIds = new Set();
  persistDownloadState({ finishedAt: Date.now() });
  broadcastDownloadState();

  chrome.runtime.sendMessage({
    action: "log",
    text: `✅ Download complete! ${downloadedCount} succeeded, ${failedCount} failed.`
  });
  chrome.runtime.sendMessage({ action: "download_complete", stopped: false });
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
// Initialisierung beim Start
// ============================================================================

log("🚀 Background Service Worker gestartet");
log("Token-Refresh via Clerk API alle 45 Minuten");
log("Tab Keep-Alive alle 5 Minuten");

// Watchdog alarm: re-ensures the offscreen document is alive and polling
// for any enabled state. Covers service-worker restarts + offscreen GC.
chrome.alarms.create('ensureOffscreenAlive', {
  delayInMinutes: 0.5,
  periodInMinutes: 2
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'ensureOffscreenAlive') {
    await stateReadyPromise;
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

// Handle offscreen document connection/disconnection
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

// Restore persisted state, then restart polling for any state that was enabled.
loadState().then(() => {
  stateReady();  // unblock alarm handlers
  for (const [tabId, st] of Object.entries(tabState)) {
    if (st.enabled) {
      log('loadState: restarting polling for', tabId);
      ensureOffscreen().then(() => {
        sendToOffscreen({
          type: "offscreenSetState",
          tabId,
          state: { ...st }
        });
      });
    }
  }
});
