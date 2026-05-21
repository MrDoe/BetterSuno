# BetterSuno — Agent Guide

## Build

- `node build.js` creates builds in `dist/chrome/` and `dist/firefox/`
- No args builds both; `node build.js chrome` or `node build.js firefox` builds one
- No dev server, no tests, no typecheck, no linter config
- Load unpacked from `dist/chrome/` (`chrome://extensions` dev mode) or `dist/firefox/` (`about:debugging#/runtime/this-firefox`)

## Architecture

| File | Role | Module System |
|------|------|---------------|
| `background.js` | Service worker (Chrome) / persistent background (Firefox). Auth via Clerk, notification polling, song fetch proxy, playlist mutations. | ES module (`import`) |
| `content.js` | Inject panel UI into `suno.com`. Tab switching, notification display, settings. | IIFE |
| `downloader.js` | Song library, batch download, playlist management, mini player, comments. | IIFE |
| `content-fetcher.js` | Injected into MAIN world via `scripting.executeScript`. Fetches song library from Suno API. Runs inside page context. | IIFE |
| `content-idb.js` | Frontend IndexedDB wrapper (cached songs, audio blobs). Exposes `window.BetterSunoIDB`. | IIFE |
| `idb-store.js` | Background-side IndexedDB wrapper (tab states, songs, prefs, audio). | ES module |
| `idb-helpers.js` | Shared IDB utility functions. | ES module |
| `offscreen.js` | Chrome offscreen document for polling. Not used in Firefox. | plain script |
| `content.css` | All panel styles. | CSS |

- **`content.js`** and **`downloader.js`** are both injected as content scripts (see `manifest.json` `content_scripts`). `content.js` injects the DOM first; `downloader.js` runs after and finds the elements.
- **`content-fetcher.js`** is injected ad-hoc into the MAIN world by `background.js` when the user clicks "Refetch Library". It communicates results back via `chrome.runtime.sendMessage`.

## Key Browser Differences

| Feature | Chrome | Firefox |
|---------|--------|---------|
| Background | Service worker (MV3, can be killed) | Persistent script |
| Polling | Offscreen document (`offscreen.js`) | Inline in `background.js` (`ffPollOnce`/`ffHandleMessage`) |
| Manifest | `background.service_worker`, no `browser_specific_settings` | `background.scripts`, has `browser_specific_settings.gecko` |
| `offscreen` permission | Used | Removed by `build.js` |
| `world: "MAIN"` | Supported (used for Clerk token access) | Not supported; uses `wrappedJSObject` |

## Auth & Token

- `background.js` gets Bearer tokens via `window.Clerk.session.getToken()` inside a live `suno.com` tab (MAIN world injection).
- At least one active `suno.com` tab is required for auth.
- Cookie `__session` on `clerk.suno.com` / `suno.com` is used as fallback/identifier.
- Token cached for 45 min, refreshed via `chrome.alarms.create('tokenRefresh', ...)` every 45 min.
- Tab keepalive via `chrome.alarms.create('keepAlive', ...)` every 5 min.

## Song Data Model (normalized)

Fields in `normalizeSongClip()`: `id`, `title`, `audio_url`, `video_url`, `image_url`, `lyrics`, `is_public`, `created_at`, `reaction_state`, `is_liked`, `is_stem`, `upvote_count`, `owner_user_id`, `owner_handle`, `owner_display_name`, `is_owned_by_current_user`.

## IndexedDB Stores

Database: `BetterSunoicationsDB` (version 3)

| Store | Key | Purpose |
|-------|-----|---------|
| `tabStates` | `tabId` | Per-tab notification polling state |
| `songsList` | `id` | Cached song library |
| `userPreferences` | `key` | Settings, cached playlists, playlist songs |
| `audioCache` | `songId` | Blobs for offline playback |
| `imageCache` | `songId` | Cover image blobs |

## Notable Quirks

- `content-idb.js` (frontend IDB) and `idb-store.js` (background IDB) both use the same DB name but are separate wrappers — they coexist in different JS contexts.
- Since `content.js` and `downloader.js` are separate content scripts, communication happens via `chrome.runtime.sendMessage` to `background.js`, which proxies between them.
- `downloader.js` re-fetches the playlist songs page HTML when loading playlist tracks (`fetchPlaylistSongsFromPageHtml`), parsing JSON payloads embedded in the page. It does NOT use a direct API for playlist songs listing.
- Playlist add/remove uses a waterfall strategy: tries multiple API endpoint variants (`update_clips`, v1/v2 songs/clips POST/DELETE, add_songs, add_clips, etc.) and returns first success.
- No formal test suite. Manual verification only.
- `eslint` listed in `package.json` dependencies but no config file found — not configured.
- `package-lock.json` is in `.gitignore`.
