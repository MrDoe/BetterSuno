// Es gab nur ein Problem mit dem Handling des abgelaufenen Token
// Sah dann aus wie ein Freeze
// Beide Methoden zum Verhindern eines Freeze hier vorläufig noch drin,
// falls sie doch noch benötigt werden:

// Prevent Chrome from freezing this offscreen document
/*
const ctx = new AudioContext();
const osc = ctx.createOscillator();
osc.frequency.value = 0; // inaudible
osc.connect(ctx.destination);
osc.start();
*/

// Prevent Chrome/Edge from freezing this offscreen document
/*
const pc = new RTCPeerConnection();
pc.createDataChannel("keepalive");
*/

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
// offscreen.js — dauerhaftes Polling pro Tab

const POLLERS = {}; // tabId → intervalId
const STATES = {};  // tabId → last known state

const LAST_REQUEST_AT = {}; // tabId → timestamp (ms)
var LAST_REQUEST_AT_ALL = 0; // global timestamp (ms)

// Notify background that offscreen document is running
try {
  const port = chrome.runtime.connect({ name: "offscreen-document" });
  log("Connected to background");
  
  port.onDisconnect.addListener(() => {
    log("Disconnected from background");
  });
} catch (e) {
  log("Failed to connect to background:", e.message);
}

// Alle 30 Sekunden Keepalive-Ping an background senden
setInterval(() => {
  chrome.runtime.sendMessage({ type: "offscreenKeepalivePing" });
}, 30000);

// -------------------------------------------------------------
// Hintergrund um Token bitten
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
// Polling-Loop pro Tab
// -------------------------------------------------------------
async function pollOnce(tabId) {
  log("pollOnce START for tab", tabId, "using token", STATES[tabId].token?.slice(0, 12), "…");

  const st = STATES[tabId];
  if (!st || !st.enabled) return;
  
  const token = await getToken(tabId);
  if (!token) {
    log("Kein Token für Tab", tabId);
    chrome.runtime.sendMessage({
      type: "offscreenNoToken",
      tabId
    });
    return;
  } else {
    if (st.token !== token) {
      st.token = token;
      st.tokenTimestamp = Date.now();
      st.requestCount = 0;
    }
  }

  const afterUtc = st.lastNotificationTime ?? st.initialAfterUtc;
  if (!afterUtc) {
    log("afterUtc not defined", tabId);
    return;
  }

  if (true) {
    const now = Date.now();
    const last = LAST_REQUEST_AT[tabId] || 0;
    if (last && (now - last) < (st.intervalMs * 0.5)) {
      log("LAST_REQUEST_AT 50% burst prevention", {last, now, interval: st.intervalMs});
      return;
    }
    log("pollOnce setting LAST_REQUEST_AT for tab", tabId, "to", now);
    LAST_REQUEST_AT[tabId] = now;
  }
  if (true) {
    const now = Date.now();
    const last = LAST_REQUEST_AT_ALL;
    var intMs = Math.round(st.intervalMs * 0.7);
    if (intMs < 8000) { intMs = 8000}; // Minimum 8 Sek. 
    if (last && (now - last) < intMs) {
      log("LAST_REQUEST_AT_ALL 70% burst prevention", {last, now, interval: st.intervalMs});
      return;
    }
    log("pollOnce setting LAST_REQUEST_AT_ALL to", now);
    LAST_REQUEST_AT_ALL = now;
  }   

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
      log("401/403: " + res.status + " → Token abgelaufen für Tab", tabId);
      chrome.runtime.sendMessage({
        type: "offscreenTokenExpired",
        tabId
      });
      return;
    }
    if (!res.ok) {
      log("Unerwarteter Fehlerstatus", res.status);
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

  chrome.runtime.sendMessage({
    type: "offscreenStateUpdate",
    tabId,
    state: { ...st }
  });
}

// -------------------------------------------------------------
// Polling starten/stoppen
// -------------------------------------------------------------
function restartPolling(tabId) {
  log("restartPolling for tab", tabId);

  const st = STATES[tabId];
  if (!st) return;

  // Alte Intervalle stoppen
  if (POLLERS[tabId]) {
    clearInterval(POLLERS[tabId]);
    delete POLLERS[tabId];
  }

  if (!st.enabled) return;

  // Neuer Interval, aber nur gültig, wenn Generation übereinstimmt
  POLLERS[tabId] = setInterval(() => {
    pollOnce(tabId);
  }, st.intervalMs);

  // Sofortiger erster Poll
  pollOnce(tabId);
}

// -------------------------------------------------------------
// Nachrichten vom Hintergrund
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
    if (!! msg.token) { 
      STATES[msg.tabId].token = msg.token;
    }
    sendResponse({ ok: true });
    return true;
  }

});
