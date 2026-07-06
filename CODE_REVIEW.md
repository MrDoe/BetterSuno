# BetterSuno Full Codebase Audit

> **Audit date:** 2026-07-06
> **Coverage:** 10 source files (JS + manifest), ~16k lines  
> **Method:** Static analysis with targeted line-by-line reads, grep pattern scans, and trust-boundary mapping  
> **Checklist:** [approved plan](./.plannotator/plans/bettersuno-full-codebase-audit-2026-07-06-approved.md)

---

## Executive Summary

BetterSuno is a mature, feature-rich browser extension with broadly sound architecture. The authentication, download, and playlist-mutation subsystems demonstrate thoughtful engineering, and `content.js` uses safe DOM APIs (rather than `innerHTML`) for notification rendering.

**However, two XSS-class vulnerabilities exist** in `downloader.js`, the 1567-line `onMessage` handler in `background.js` is a brittleness hotspot, and several security-adjacent patterns (sender validation, token handling in unprivileged messages, blob-store eviction) need attention. The extension operates with `cookies` + broad `*.suno.com/*` host permissions, making any injection path impactful.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 3 |
| Medium   | 5 |
| Low      | 4 |
| Info     | 4 |

---

## Findings

### High Severity

#### [H1] Stored DOM XSS via comment reply indicator  — High

- **Location:** `downloader.js:1490`
- **Evidence:**

  `renderCommentTree` (L1409–1443) correctly escapes `author` when building the "Reply" button's `data-author` attribute:

  ```js
  data-author="${escapeHtml(author)}"  // L1425 → escaped
  ```

  When the user clicks Reply, `setupReplyMode` (L1490) reads that attribute back via `getAttribute('data-author')` — the browser HTML-decodes it back to the original raw string — then interpolates it into `innerHTML` **without** re-escaping:

  ```js
  replyIndicator.innerHTML = `Replying to @${author} <span id="player-tab-cancel-reply">✕</span>`;
  ```

- **Impact:** If a Suno comment author's display name or handle contains HTML (e.g. `<img src=x onerror=alert(1)>`), the extension sets the attribute as the HTML-escaped version, but the browser returns the decoded version via `getAttribute`. The decoded string then executes as HTML in the `suno.com` page context. Since the extension has `cookies` permission and broad host access, this can be escalated to session token theft or arbitrary action on behalf of the user.

- **Fix:** Add `escapeHtml(author)` in the interpolation:

  ```js
  replyIndicator.innerHTML = `Replying to @${escapeHtml(author)} <span id="player-tab-cancel-reply">✕</span>`;
  ```

---

#### [H2] Unrestricted message handler — no sender validation  — High

- **Location:** `background.js:1549–3116`
- **Evidence:** The entire ~1567-line `chrome.runtime.onMessage` listener processes messages from **any** sender (content scripts, offscreen document, other extensions via `externally_connectable`, or even the page itself via `window.postMessage` → content script bridge). Only a handful of handlers use `sender.tab?.id`:

  ```
  msg.type === "checkActiveTab"          → checks sender.tab?.id
  msg.type === "contentClaimRefreshHost" → checks sender.tab?.id
  msg.action === "fetch_songs"           → reads sender.tab?.id
  msg.action === "download_selected"     → reads sender.tab?.id
  msg.type === "pingMainWorld"           → never reads sender
  ```

  The majority (playlist mutation, comment posting, song metadata updates, reaction toggling, token fetch) **never verify** `sender`. The manifest has no `externally_connectable` block, so other extensions **cannot** reach it by default — but the content scripts run in the `suno.com` ISOLATED world, and any compromise of the `suno.com` page (via XSS or a malicious script loaded by Suno) could message the content script, which can forward to the background.

- **Impact:** A stored XSS in the suno.com page (or a malicious ad/middleware) could abuse the content script's `chrome.runtime.sendMessage` bridge to call all background handlers. This enables: playlist modification, comment posting as the user, song metadata changes, reaction toggling, and token exfiltration via `fetch_songs_by_ids`.

- **Fix:** Add sender verification at every handler that mutates data:

  ```js
  if (!sender.tab?.id) {
    sendResponse({ ok: false, error: 'Not a content script' });
    return true;
  }
  ```

  Consider adding `allowed_origins: ["chrome-extension://..."]` to the manifest even though content scripts are the expected senders.

---

#### [H3] Token passed to unprivileged content script handlers  — High

- **Location:** `background.js` handlers for `fetch_songs_by_ids`, `fetch_feed_page`, `fetch_user_playlists`, `playlist_add_songs`, `playlist_remove_songs`, etc.
- **Evidence:** Multiple message handlers accept `msg.token` directly from the sender:

  ```js
  if (msg.action === "fetch_songs_by_ids") {
    let token = msg.token;           // ← from sender, unvalidated
    // ...
    if (!token) {
      token = await getApiTokenWithFallback('...');  // fallback if missing
    }
    // uses token to call Suno API
  ```

  While the fallback path fetches a fresh token, the `msg.token` path allows **any** content script to supply an arbitrary token. Combined with [H2], a page-level XSS could inject a stolen token and exfiltrate data through the proxy.

- **Impact:** Token value from the sender should never be trusted. If a content script passes a token, it should be ignored — the background should always use its own cached/refreshed token.

- **Fix:** Remove `msg.token` acceptance from all handlers. The background owns auth:

  ```js
  // Instead of: let token = msg.token;
  // Always do:
  const token = await getApiTokenWithFallback('handler_name');
  ```

---

### Medium Severity

#### [M1] Giant cascading-if message router  — Medium

- **Location:** `background.js:1549–3116`
- **Evidence:** A single `addListener` with ~1567 lines of nested `if (msg.type === ...)` / `if (msg.action === ...)` blocks, each containing its own `async` IIFE with `sendResponse`. There is no `switch`, no middleware, no structural routing.

  The file is 5247 lines total, meaning the message handler is ~30% of the entire file. The `downloadSelectedSongs` function (L4703–5032) is another ~330-line function within the same scope.

- **Impact:** Impossible to unit test individual handlers. Hard to audit (every review must re-scan the full ladder). Easy to miss `return true;` for async responses (currently present, but fragile). Refactoring risk is high.

- **Fix:** Extract each handler into a named function in a separate map:

  ```js
  const HANDLERS = {
    'offscreenRequestToken': handleOffscreenRequestToken,
    'offscreenStateUpdate': handleOffscreenStateUpdate,
    'contentGetState': handleContentGetState,
    'fetch_songs_by_ids': handleFetchSongsByIds,
    // ...
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg.type] || HANDLERS[msg.action];
    if (handler) return handler(msg, sender, sendResponse);
  });
  ```

  Split `downloadSelectedSongs` into smaller units (download preparation, per-song download, state management).

---

#### [M2] Race condition on token refresh under concurrent tabs  — Medium

- **Location:** `background.js:899–940` (`ensureValidToken`), `567–602` (`ensureValidTokenViaClerkSession`)
- **Evidence:** `ensureValidToken` checks `st.token && st.tokenTimestamp && (now - st.tokenTimestamp < TTL)` but two concurrent calls from different tabs can both find the cache expired and both initiate `refreshTokenViaClerkAPI` simultaneously. There is no mutex/queue on the token refresh:

  ```js
  // Tab A: cache expired → starts refreshTokenViaClerkAPI
  // Tab B: cache expired → also starts refreshTokenViaClerkAPI (same page context)
  // Both ScriptExecution requests race on window.Clerk.session.getToken()
  ```

- **Impact:** Redundant Clerk session fetches, potential race on `st.token` assignment. The last writer wins — and the first writer's result is discarded. Not a correctness bug for the end-user, but wastes API calls and extends token refresh latency under load.

- **Fix:** Use a per-tab `tokenRefreshPromise` that blocks concurrent callers:

  ```js
  if (!st.tokenRefreshPromise) {
    st.tokenRefreshPromise = refreshTokenViaClerkAPI(…).finally(() => {
      st.tokenRefreshPromise = null;
    });
  }
  return st.tokenRefreshPromise;
  ```

---

#### [M3] MV3 service worker lifecycle: download state can be lost  — Medium

- **Location:** `background.js:4703–5032` (`downloadSelectedSongs`), `background.js:92–104` (`saveState`)
- **Evidence:** Chrome MV3 service workers can be terminated after ~30s of inactivity. `downloadSelectedSongs` iterates over songs in a long-running `for` loop. If the SW is killed mid-download:
  - `activeDownloadIds` (in-memory `Set`) is lost
  - `downloadRequestorTabId` is lost
  - The `persistDownloadState` call persists metadata but only the SW restart handler `readPersistedDownloadState` could restore it (and currently is not called at restart)
  - The `chrome.downloads.onChanged` listeners are lost — downloads complete silently with no UI notification

- **Impact:** User sees downloads "in progress" until they manually refresh. Song-by-song progress vanishes.

- **Fix:** Use `chrome.storage.session` (survives SW restart) for critical state. On SW restart in `init()`, restore `isDownloading` / `currentDownloadJobId` from storage and re-broadcast state to tabs.

---

#### [M4] Token TTL inconsistency  — Medium

- **Location:** `background.js:586` and `background.js:910`
- **Evidence:** `ensureValidTokenViaClerkSession` uses 45 minutes (`45 * 60 * 1000`) as the cached-token TTL, while `ensureValidToken`'s fallback MAIN-world path uses 50 minutes (`50 * 60 * 1000`). Both are hardcoded inline.

  ```js
  // L586: Clerk session path
  if (st.token && st.tokenTimestamp && (now - st.tokenTimestamp < 45 * 60 * 1000))

  // L910: MAIN world fallback path
  const MAX_AGE = 50 * 60 * 1000;
  ```

- **Impact:** The fallback path trusts a 50-minute-old token that the primary path would consider expired. Not exploitable per se (both will refresh if needed) but confusing and could lead to a token expiring mid-operation on the fallback path.

- **Fix:** Define a single `const TOKEN_MAX_AGE_MS = 45 * 60 * 1000` at the top of the auth section and use it everywhere.

---

#### [M5] No user confirmation on destructive `playlist_remove_songs`  — Medium

- **Location:** `background.js` handler for `playlist_remove_songs` (around L2600+)
- **Evidence:** The handler accepts `msg.indices` from any content script and executes removal via `runPlaylistMutation` with no confirmation step. Combined with [H2], any XSS in the page could silently remove songs from the user's playlists.

- **Impact:** Silent playlist destruction with no undo.

- **Fix:** Add a confirmation round-trip ("Are you sure?") for remove/reorder operations where the count exceeds a threshold, or require the calling tab to be the active tab.

---

### Low Severity

#### [L1] Blob stores never evicted  — Low

- **Location:** `idb-store.js` (audioCache), `content-idb.js` (audioCache + imageCache)
- **Evidence:** Both audio and image cache stores accept `Blob` objects but have no TTL, size limit, or eviction policy. `clearStore` exists but is not called automatically.

- **Impact:** IndexedDB quota could be exhausted on devices with limited storage (especially Firefox Android). Worse, the `imageCache` store is written-to but the UI code in `downloader.js` re-fetches images from the network anyway (it constructs `<img src="...">` with the Suno CDN URL, not the cached blob).

- **Fix:** Add a configurable per-store max age (e.g., 7 days for audio, 30 min for images) or size cap. Add a periodic cleanup that deletes blobs older than the threshold.

---

#### [L2] `wrappedJSObject` used without Firefox version guard  — Low

- **Location:** `background.js:504`, `698`, `771`
- **Evidence:** The `executeScript` `func` references `window.wrappedJSObject || window`. `wrappedJSObject` was removed in Firefox 130+ for `MAIN` world injection (which is the only context where `wrappedJSObject` was needed). The `isFirefox` boolean is checked to avoid setting `world: "MAIN"` on Firefox (L428), so the `executeScript` runs in the `ISOLATED` world — where `window.wrappedJSObject` is `undefined`, so the fallback `window` is used correctly. But if a future refactor adds `world: "MAIN"` on Firefox, this pattern could silently fail.

- **Impact:** None currently (the `isFirefox` guard prevents the unsafe combination). But the code has a latent landmine for future refactors.

- **Fix:** Add an explicit check or remove the `wrappedJSObject` branch entirely for Firefox builds.

---

#### [L3] `innerHTML` injection of HTTP status code  — Low

- **Location:** `downloader.js:1328`
- **Evidence:**
  ```js
  playerTabCommentsList.innerHTML = `<div class="player-tab-comments-empty">Failed to load comments (${response?.status || 'Error'})</div>`;
  ```
  The `response.status` is a number, so this is safe in practice. But the pattern is fragile — if someone changes `response.status` to `response.message` (which could contain user-controlled text), it becomes XSS.

- **Fix:** Use `textContent` or `escapeHtml`. Low priority.

---

#### [L4] `innerHTML` used for static SVG icons  — Low

- **Location:** `downloader.js:4689`
- **Evidence:** An SVG icon is injected via `innerHTML`:
  ```js
  gotoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>`;
  ```
  This is safe because the string is hardcoded. But as a pattern, it's inconsistent with the rest of the codebase which uses `createElement('svg')` or `createElementNS` + `appendChild` for DOM construction.

- **Fix:** Move the SVG to a static template or use `insertAdjacentHTML` with a one-time assignment to make the intent clearer.

---

### Info / Observations

#### [I1] `escapeHtml` in content.js is unused

- **Location:** `content.js:860`
- **Evidence:** `escapeHtml` is defined but never called anywhere in content.js. The notification rendering at L1034+ uses safe DOM APIs (`createElement`, `textContent`, `appendChild`) exclusively — this is the correct approach. The function appears to be dead code (a leftover from an earlier refactor that moved from `innerHTML` to DOM APIs).

#### [I2] `escapeAttr` was recently removed (commit `37ef462`)

- **Evidence:** Commit `37ef462` removed `escapeAttr` — confirming the codebase has a history of escaping churn. The `escapeHtml` function in `downloader.js:1584` is correctly used for comment rendering. The `setupReplyMode` bug [H1] is the remaining vestige of that churn.

#### [I3] `idb-helpers.js` is ES module — works in both Chrome and Firefox

- The shared helpers (`requestToPromise`, `transactionToPromise`, `withStore`) are clean and well-typed. The pattern of passing a handler closure into `withStore` is a nice abstraction over IndexedDB boilerplate. Both `idb-store.js` (ES module, background) and `content-idb.js` (IIFE, content script) implement similar patterns, with `content-idb.js` duplicating the helpers inline — acceptable given the IIFE cannot import.

#### [I4] `notifications` rendering uses safe DOM in content.js — excellent

- `content.js:1034` (`createNotificationItem`) uses `document.createElement`, `textContent`, and `appendChild` exclusively. No `innerHTML` touches user data in the notification path. This is the gold standard for content-script DOM manipulation.

---

## Positive Practices

1. **`escapeHtml` used consistently in comment rendering** (`downloader.js`). The tree rendering function escapes author, date, and body text. The attribute (`data-author`) is also escaped.

2. **Token logging truncated** — `token.slice(0, 12)` throughout the codebase prevents full token leakage in console output.

3. **Offscreen document guard** — the `offscreenCreating` flag (L1030) prevents race conditions when multiple code paths request offscreen document creation simultaneously.

4. **MV3 keepalive uses minimal script injection** — `keepTabAlive` injects a tiny `func` into the ISOLATED world, minimizing performance impact.

5. **Playlist mutation has ownership check** — `fetchPlaylistOwnershipInfo` is called before every mutation, preventing cross-user playlist modification.

6. **Download ownership gate** — `canDownloadSongForIdentity` correctly prevents downloading songs owned by other users.

7. **`response?.status` is a number** — safe in `innerHTML` context at L1328, but the pattern is fragile (flagged separately).

---

## Recommendations — Prioritized

| Priority | Action | Est. effort | Status |
|----------|--------|-------------|--------|
| **P0**   | Fix [H1]: escape `author` in `setupReplyMode` | 5 min | ✅ Fixed |
| **P0**   | Fix [H2]: add sender validation to all message handlers | 1 hour | ✅ Fixed |
| **P0**   | Fix [H3]: remove `msg.token` acceptance from all handlers | 1 hour | ✅ Fixed |
| **P1**   | Fix [M2]: deduplicate concurrent token refresh calls | 2 hours | ✅ Fixed |
| **P1**   | Fix [M4]: consolidate TTL constants | 15 min | ✅ Fixed |
| **P2**   | Fix [M3]: persist download state for SW restart survivability | 3 hours | ✅ Fixed |
| **P2**   | Fix [M5]: add confirmation for destructive playlist ops | 2 hours | ✅ Fixed |
| **P3**   | Fix [L1]: implement blob eviction | 2 hours | ✅ Fixed |
| **P3**   | Fix [L2]/[L4]: clean up fragile patterns (wrappedJSObject, SVG innerHTML) | 1 hour | ✅ Fixed |
| **P1**   | Fix [M1]: refactor message handler into named function map | 4 hours | 🚧 Reference file created (`bg-handlers.js`), not wired |

---

## Out of Scope

- `node_modules/`, `.agents/`, `.opencode/`, `dist/`, `icons/`, `README.md`, `LICENSE`, `PRIVACY.md`
- CSS review beyond selectors affecting behavior
- Runtime / integration testing
- Supply-chain deep dive (only surface-level note in [I2])

---

## Appendix: Files Reviewed

| File | Lines | Method |
|------|------:|--------|
| `manifest.json` | 74 | Full read |
| `build.js` | 133 | Full read |
| `idb-helpers.js` | 35 | Full read |
| `idb-store.js` | 443 | Full read |
| `content-idb.js` | 302 | Full read |
| `content-fetcher.js` | 562 | Full read |
| `offscreen.js` | 292 | Full read |
| `create.js` | 546 | Full read |
| `content.js` | 1381 | Targeted read (escape helpers, notification rendering, panel bootstrap) |
| `background.js` | 5247 | Skeleton-guided read (auth path, message handler L1549–3116, download path, playlist mutations) |
| `downloader.js` | 5019 | Skeleton-guided read (comment rendering, reply flow, playlist search DOM, innerHTML surfaces) |
