// lib/auth-state.js — the background-owned auth boundary.
//
// Two allowlists, and both are deliberately ALLOWLISTS rather than denylists:
//
//   PERSIST_FIELDS — the only tab-state fields that may reach IndexedDB. Because
//     it is an allowlist, no credential can be persisted even if a future caller
//     stuffs one into the state object. Do not convert to a denylist.
//
//   BACKGROUND_AUTH_STATE_KEYS — fields stripped by toAuthSafeState before any
//     state is merged from a sender, broadcast, or returned in a response. Auth
//     is exclusively background-owned: tokens are never accepted from, persisted
//     from, or handed back to a content script or the offscreen page.
//
// Tests in tests/auth-state.test.js guard both.

export const PERSIST_FIELDS = [
  'enabled',
  'intervalMs',
  'initialAfterUtc',
  'lastNotificationTime',
  'activatedAt',
  'notifications',
  'desktopNotificationsEnabled',
  'androidFirefoxKeepAliveEnabled',
];

export const BACKGROUND_AUTH_STATE_KEYS = [
  'token',
  'tokenTimestamp',
  'tokenExpiresAt',
  'tokenRefreshPromise',
  'clerkSessionToken',
  'clerkSessionExpiry',
  'lastAuthFailure'
];

/** Returns a shallow copy with every background-owned auth field removed. */
export function toAuthSafeState(state) {
  const safeState = { ...(state || {}) };
  for (const key of BACKGROUND_AUTH_STATE_KEYS) {
    delete safeState[key];
  }
  return safeState;
}

/** The subset of state permitted to reach IndexedDB. */
export function toPersistableState(state) {
  const toSave = {};
  for (const f of PERSIST_FIELDS) {
    toSave[f] = state?.[f];
  }
  return toSave;
}
