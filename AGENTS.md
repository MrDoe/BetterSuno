# BetterSuno — Agent Guide

## Build
- `node build.js` → `dist/chrome/` + `dist/firefox/` (arg `chrome`/`firefox` for one). No dev server, tests, typecheck, or linter.
- Load unpacked: `dist/chrome/` (`chrome://extensions`) or `dist/firefox/` (`about:debugging#/runtime/this-firefox`).

## Architecture
| File | Role |
|------|------|
| `background.js` | ES-module SW (Chrome) / persistent (FF): Clerk auth, notification polling, song-fetch proxy, playlist mutations, **WS client to MCP**. |
| `content.js` | IIFE content script: injects panel UI (runs before `downloader.js`). |
| `downloader.js` | IIFE content script: library, batch download, playlists, mini player (`togglePlay`), comments; runtime message listener ~L4211. |
| `content-fetcher.js` | MAIN-world injected fetcher for the song library. |
| `content-idb.js` / `idb-store.js` | Frontend / background IndexedDB wrappers (same DB, separate contexts). |
| `idb-helpers.js` | Shared IDB utils. |
| `offscreen.js` | Chrome-only offscreen polling doc. |

Content scripts ↔ `background.js` via `chrome.runtime.sendMessage`. `content.js` builds the DOM, `downloader.js` consumes it.
DB `BetterSunoicationsDB` v3: `tabStates`, `songsList`, `userPreferences`, `audioCache`, `imageCache`.

## Browser differences (Chrome vs Firefox)
SW vs persistent bg; offscreen polling vs inline `ffPollOnce`; `world:"MAIN"` (Clerk token) vs `wrappedJSObject`; `build.js` strips `offscreen` perm and adds `browser_specific_settings.gecko` for FF.

## Auth & token
`background.js` gets a Bearer token via `window.Clerk.session.getToken()` in a live `suno.com` tab (needs ≥1 open tab). Cached 45 min, refreshed by alarm, pushed to MCP over WS on connect/refresh.

## Generation (`POST /api/generate/v2-web/`)
- Pre-call `POST /api/c/check` `{ctype:"generation"}`; if `required:true` MCP asks the extension to solve Turnstile.
- **Always include `token:null, token_provider:null`** — else 422 `token_validation_failed`.
- **Mode switch is `gpt_description_prompt`**: empty → Custom (uses `prompt` lyrics); non-empty → Inspiration (auto-lyrics, ignores `prompt`). `metadata.create_mode` is NOT the switch.
- Sliders in `metadata.control_sliders` (`style_weight`, `weirdness_constraint`, `audio_weight`, 0–1) + `metadata.can_control_sliders` array.

## MCP server (`bettersuno-mcp`)
The MCP server is now a **separate package** at [MrDoe/bettersuno-mcp](https://github.com/MrDoe/bettersuno-mcp) on [npm](https://www.npmjs.com/package/bettersuno-mcp).
Run: `npx bettersuno-mcp`. Register in `.opencode/opencode.json` via `npx bettersuno-mcp`. Requires the extension loaded + an open Suno tab.

**59 tools / 12 modules.** The server sits behind a WS bridge (`ws-bridge.js`); the MCP server's `suno-client.js` calls the Suno API directly (429 → exponential backoff 1s→30s, 5 retries; 401 → token auto-refreshed).

Extension-side semantics that agents need to know:
- **Playback** (`play_song`): works for ANY song (incl. other users' public playlists). Relays MCP→WS→`background.relayMcpPlaybackToTab`→suno tab→`downloader.togglePlay`; `start_time` seeks; `stop_playback` pauses. Needs the extension connected.
- **Prompts**: stored in the extension's IndexedDB; relayed via WS `extension_request`/`response` (`background.handleMcpExtensionRequest`). Needs the extension connected.
- **Captcha**: MCP server requests Turnstile solve from the extension over WS when Suno requires it.

## Code navigation
Use OpenCodeRAG before reading/editing: `search_semantic` (search), `get_file_skeleton` (orient), `find_usages` (before edits), `describe_image` (images). The index can be stale — verify with `read`.

## Inspection (Firefox DevTools MCP)
`npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing`. Tabs `_list_pages`; DOM `_take_snapshot`; network `_list_network_requests`→`_get_network_request`; screenshot `_screenshot_page`. Console/network need BiDi (`--headless`). After code changes: `node build.js` + reload the extension.

**Firefox 152+ CDP note**: The REST endpoints (`/json/version`, `/json/list`) are **gone** — the HTTP server is a minimal `httpd.js`. Use the DevTools MCP with `--connect-existing` or connect via WebSocket (BiDi) directly. To start an inspectable Firefox for testing:
```
# Kill any existing Firefox first, then start with remote debugging + same profile
/usr/lib/firefox/firefox --new-instance --profile ~/.mozilla/firefox/<profile> --remote-debugging-port 9222
# The MCP will then find the browser via `--connect-existing`. You cannot use curl to the CDP port.
