import { WebSocketServer } from 'ws';
import { config } from './config.js';

let currentToken = null;
let captchaResolve = null;
let captchaReject = null;
let captchaTimer = null;
let extensionWs = null;
const pendingRequests = new Map();
let requestSeq = 0;

function startWsServer() {
  const wss = new WebSocketServer({ port: config.wsPort });

  wss.on('listening', () => {
    console.error(`[ws-bridge] WebSocket server listening on ws://localhost:${config.wsPort}`);
  });

  wss.on('error', (err) => {
    console.error('[ws-bridge] WebSocket server error:', err.message);
  });

  wss.on('connection', (ws) => {
    console.error('[ws-bridge] Extension connected');

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'auth') {
        if (msg.token) {
          currentToken = msg.token;
          console.error('[ws-bridge] Token updated');
        }
      } else if (msg.type === 'captcha_token') {
        if (captchaResolve) {
          captchaResolve(msg.token);
          captchaResolve = null;
          captchaReject = null;
          clearTimeout(captchaTimer);
          captchaTimer = null;
        }
      } else if (msg.type === 'response') {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
      }
    });

    extensionWs = ws;

    ws.on('close', () => {
      if (extensionWs === ws) extensionWs = null;
      console.error('[ws-bridge] Extension disconnected');
    });

    ws.on('error', (err) => {
      console.error('[ws-bridge] Connection error:', err.message);
    });
  });

  return wss;
}

export function getToken() {
  return currentToken;
}

export function sendToExtension(msg) {
  if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) {
    return false;
  }
  try {
    extensionWs.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

// Request/response round-trip to the extension (used for extension-local data
// such as the prompt library stored in IndexedDB). Resolves with the
// extension's `{ type: 'response', requestId, ok, data|error }` message.
export function requestFromExtension(action, payload = {}, timeoutMs = null) {
  const requestId = `req_${++requestSeq}`;
  const msg = { type: 'extension_request', requestId, action, payload };
  const sent = sendToExtension(msg);
  if (!sent) {
    return Promise.reject(new Error('BetterSuno extension is not connected.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Extension request timed out'));
    }, timeoutMs || config.extensionRequestTimeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
  });
}

export function requestCaptcha() {
  return new Promise((resolve, reject) => {
    captchaResolve = resolve;
    captchaReject = reject;
    captchaTimer = setTimeout(() => {
      captchaResolve = null;
      captchaReject = null;
      reject(new Error('Captcha solve timed out'));
    }, config.captchaTimeoutMs);
  });
}

let wssInstance = null;

export function initBridge() {
  wssInstance = startWsServer();
  return { getToken, requestCaptcha };
}
