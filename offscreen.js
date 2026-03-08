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
  console.log("[OFFSCREEN]", ...args, "at", logFormatDate(Date.now()));
}

// Logging
setInterval(() => {
  log("heartbeat");
}, 60000);

// -------------------------------------------------------------
// Persistent per-tab polling
// -------------------------------------------------------------

const POLLERS = {}; // tabId → intervalId
const STATES = {};  // tabId → last known state

const LAST_REQUEST_AT = {}; // tabId → timestamp (ms)
let LAST_REQUEST_AT_ALL = 0; // global timestamp (ms)

// ------------------------------------------------------------------
// Messaging helper – keep a long‑lived port and resend the last known
// state when the service worker restarts.  Chrome MV3 service workers
// can be killed at any time; when that happens the port is closed and
// subsequent sendMessage calls will fail with "Receiving end does not
// exist".  We detect those failures, reconnect the port and replay the
// most recent state so nothing is lost.
// ------------------------------------------------------------------

let port = null;
let lastSentState = null; // { tabId, state }

function setupPort() {
  try {
    port = chrome.runtime.connect({ name: "offscreen-document" });
    log("Connected to background via port");

    port.onDisconnect.addListener(() => {
      log("Port disconnected – scheduling reconnect");
      port = null;
      // attempt to reconnect after a short delay
      setTimeout(setupPort, 1000);
    });
  } catch (e) {
    log("Port connection failed:", e.message);
    setTimeout(setupPort, 1000);
  }
}

// initialise the port when the script loads
setupPort();

// when the port reconnects we replay the last state in case any
// updates were lost while the service worker was dead
function replayLastState() {
  if (lastSentState && port) {
    log("Replaying cached state after reconnect for tab", lastSentState.tabId);
    chrome.runtime.sendMessage({
      type: "offscreenStateUpdate",
      tabId: lastSentState.tabId,
      state: { ...lastSentState.state }
    });
  }
}

// wrap the original setupPort to fire replay after successful connect
const realSetupPort = setupPort;
setupPort = function() {
  realSetupPort();
  // the port.onDisconnect handler above already re-invokes setupPort,
  // so the simplest way to trigger a replay is to call it after the
  // next tick if a port exists.
  setTimeout(() => {
    if (port) replayLastState();
  }, 0);
};


// Send keepalive ping to background every 30 seconds
setInterval(() => {
  chrome.runtime.sendMessage({ type: "offscreenKeepalivePing" });
}, 30000);

// -------------------------------------------------------------
// Request token from background
// -------------------------------------------------------------
async function getToken(tabId) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: "offscreenRequestToken", tabId },
      resp => resolve(resp?.token || null)
    );
  });
}

// -------------------------------------------------------------
// Polling loop per tab
// -------------------------------------------------------------
async function pollOnce(tabId) {
  log("pollOnce START for tab", tabId, "using token", STATES[tabId].token?.slice(0, 12), "…");

  const st = STATES[tabId];
  if (!st || !st.enabled) return;
  
  const token = await getToken(tabId);
  if (!token) {
    log("No token for tab", tabId);
    chrome.runtime.sendMessage({
      type: "offscreenNoToken",
      tabId
    });
    return;
  }

  if (st.token !== token) {
    st.token = token;
    st.tokenTimestamp = Date.now();
    st.requestCount = 0;
  }

  const afterUtc = st.lastNotificationTime ?? st.initialAfterUtc;
  if (!afterUtc) {
    log("afterUtc not defined", tabId);
    return;
  }

  const now = Date.now();
  const lastTab = LAST_REQUEST_AT[tabId] || 0;
  if (lastTab && (now - lastTab) < (st.intervalMs * 0.5)) {
    log("LAST_REQUEST_AT 50% burst prevention", {last: lastTab, now, interval: st.intervalMs});
    return;
  }
  log("pollOnce setting LAST_REQUEST_AT for tab", tabId, "to", now);
  LAST_REQUEST_AT[tabId] = now;

  const lastAll = LAST_REQUEST_AT_ALL;
  let intMs = Math.round(st.intervalMs * 0.7);
  if (intMs < 8000) { intMs = 8000; } // Minimum 8 seconds
  if (lastAll && (now - lastAll) < intMs) {
    log("LAST_REQUEST_AT_ALL 70% burst prevention", {last: lastAll, now, interval: st.intervalMs});
    return;
  }
  log("pollOnce setting LAST_REQUEST_AT_ALL to", now);
  LAST_REQUEST_AT_ALL = now;

  let url = "https://studio-api.prod.suno.com/api/notification/v2";
  url += `?after_datetime_utc=${encodeURIComponent(afterUtc)}`;

  st.totalRequests++;
  st.lastRequestTime = new Date().toISOString();

  try {
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + token }
    });
    log("pollOnce END for tab", tabId, "status:", res.status);
    if (res.status === 401 || res.status === 403) {
      log("401/403: " + res.status + " → Token expired for tab", tabId);
      chrome.runtime.sendMessage({
        type: "offscreenTokenExpired",
        tabId
      });
      return;
    }
    if (!res.ok) {
      log("Unexpected error status", res.status);
      return;
    }
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

  // remember the last state so we can replay if the background dies
  lastSentState = { tabId, state: { ...st } };

  function dispatchState() {
    chrome.runtime.sendMessage({
      type: "offscreenStateUpdate",
      tabId,
      state: { ...st }
    }, resp => {
      if (chrome.runtime.lastError) {
        log("offscreenStateUpdate failed:", chrome.runtime.lastError.message);
        // ensure port exists; this will schedule a reconnect if needed
        if (!port) setupPort();
        // we will retry automatically when the port is re-established
      }
    });
  }

  dispatchState();

}

// -------------------------------------------------------------
// Start/stop polling
// -------------------------------------------------------------
function restartPolling(tabId) {
  log("restartPolling for tab", tabId);

  const st = STATES[tabId];
  if (!st) return;

  // Stop old intervals
  if (POLLERS[tabId]) {
    clearInterval(POLLERS[tabId]);
    delete POLLERS[tabId];
  }

  if (!st.enabled) return;

  POLLERS[tabId] = setInterval(() => {
    pollOnce(tabId);
  }, st.intervalMs);

  // Immediate first poll
  pollOnce(tabId);
}

// -------------------------------------------------------------
// Messages from background
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "offscreenSetState") {
    STATES[msg.tabId] = msg.state;
    restartPolling(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "offscreenClearTab") {
    if (POLLERS[msg.tabId]) {
      clearInterval(POLLERS[msg.tabId]);
      delete POLLERS[msg.tabId];
    }
    delete STATES[msg.tabId];
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "offscreenSetToken") {
    log("received NEW TOKEN for tab", msg.tabId, "token:", msg.token.slice(0, 12), "…");
    if (msg.token) {
      STATES[msg.tabId].token = msg.token;
    }
    sendResponse({ ok: true });
    return true;
  }
});
