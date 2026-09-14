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
- Pre-call `POST /api/c/check` `{ctype:"generation"}`. The response's `captcha_version` is **1 = hCaptcha, 2 = Turnstile**; `required:true` means a token is needed. MCP asks the extension to solve it and forwards `captcha_version` in the `captcha_required` WS message. The extension only solves Turnstile — it fails fast with a clear error for hCaptcha (Suno's own fallback when Turnstile times out). `handleMcpCaptchaRequest` prefers a `/create` tab and tries, in order: (1) reuse a fresh token from an existing Turnstile widget (and `reset`s it afterwards so the next call gets a new one), (2) `turnstile.execute()` on an existing widget, (3) render its own widget with a visible "tick the checkbox" hint (110s wait). Failures throw a descriptive error that the MCP relays to the tool caller — the user must tick "Verify you are human" manually. Automated/remote-debugged browsers can't pass (`navigator.webdriver`).
- **Always include `token:null, token_provider:null`** — else 422 `token_validation_failed`.
- **Mode switch is `gpt_description_prompt`**: empty → Custom (uses `prompt` lyrics); non-empty → Inspiration (auto-lyrics, ignores `prompt`). `metadata.create_mode` is NOT the switch.
- Sliders in `metadata.control_sliders` (`style_weight`, `weirdness_constraint`, `audio_weight`, 0–1) + `metadata.can_control_sliders` array.
- **V6 models (2026-09)**: the create UI exposes only the current V6 family — `chirp-hawk` (V6, default), `chirp-hawk-wild` (V6-wild), `chirp-goose` (V6-mini). Old models (V5.5/V5/V4.5) were removed from the UI. Sent as top-level `mv`.
- **`params: {}` is no longer required (2026-09)** — the V6 web client omits it and generation succeeds without it. It was removed from the extension payloads; don't re-add.
- New optional `metadata` fields the web client sends: `is_max_mode` (V6 Max Mode, plan feature `max-mode`), `vocal_gender` (`"m"`/`"f"`, flag `vocal-gender-toggle`), `create_surface`, `user_tier`, `disable_volume_normalization`, `batch_offset`, `is_mumble`, `sound_configs`, `model_config`. Top-level: `duration`, `lyrics_project_id`, `lyricist_id`, `transaction_uuid`.

## V6 API changes (2026-09, verified against live bundles + API)
- **Library**: `GET /api/library?page=…` is **gone (404)**. Library pages now come from `GET /api/project/feed?scope=library&entity_type=clip&limit=30&cursor=…` (web client) or `POST /api/feed/v3` `{limit, cursor}` → `{clips, next_cursor}` (still supported; used by the extension's sync and the MCP server).
- **WAV download**: the web client uses `GET /api/gen/{clip_id}/wav_file/` → `{wav_file_url}` and, when missing, `POST /api/gen/{clip_id}/convert_wav/` (204) followed by polling every 5s (≤24 tries). The legacy `GET /api/download/clip/{clip_id}?format=wav` still works (returns `{ok, download_url}`) and is the fallback.
- **Playlists**: `/api/playlist/v2/{playlist_id}` now returns **metadata only** (`metadata/relationship/bio/stats`) — tracks still come from the v1 `GET /api/playlist/{id}?page=&page_size=` (`playlist_clips`). Mutations: `POST /api/playlist/v2/{id}/tracks/add|remove` (`{clip_ids}`) and `POST /api/playlist/v2/{id}/tracks/reorder-by-index` with `{positions:[{clip_id,index}]}` (reorder needs the clip id; resolve from the v1 listing). `/api/playlist/update_clips/` still works.
- **Async edits**: `/api/edit/crop/{id}/` and `/api/edit/fade/{id}/` return `{action_clip_id}`; poll `GET /api/edit/action/{action_clip_id}/` until `status:"complete"` (error on `"error"`), then load `GET /api/clip/{action_clip_id}`. MCP's `crop_clip`/`fade_clip` now wait for completion.
- **Stems**: the web client no longer calls `/api/edit/stems/…` (not present in bundles; likely replaced by `POST /api/generate/v2-web/` with `task:"gen_stem"` + `stem_type_id`/`stem_type_group_name`/`stem_task`, model override `chirp-v3-5-b`). The MCP `make_stems` tool still calls the legacy endpoint; verify before relying on it.
- **New surfaces not yet covered**: `POST /api/video/hooks/create` + `/api/video/hooks/{id}` (Song Hooks; `enableTrustSafety…`), `/api/lyrics-projects/*`, `/api/unified/*` (home/explore/search), `/api/clip/{id}/permissions/*` (sharing), `/api/clips/{id}/set_remix_type`, `/api/gen/{id}/novelty-sections`, `/api/gen/{id}/aligned_lyrics/v3`, `/api/download/clips/zip/prepare` (batch zip), `/api/prompts/suggestions[/contextual]`, `/api/music_player/playbar_state`.

## MCP server (`bettersuno-mcp`)
The MCP server is now a **separate package** at [MrDoe/bettersuno-mcp](https://github.com/MrDoe/bettersuno-mcp) on [npm](https://www.npmjs.com/package/bettersuno-mcp).
Run: `npx bettersuno-mcp`. Registered globally in `~/.config/opencode/opencode.jsonc` (do NOT also register in `.opencode/opencode.json` — one registration per session). Requires the extension loaded + an open Suno tab.

**Single-instance rule**: only ONE server can bind `ws://127.0.0.1:9423`; the extension connects to whoever owns the port. A second opencode session's server hits `EADDRINUSE` and now exits with an actionable FATAL message (instead of silently serving broken tools). If tools say "not connected", a stale instance owns the port → `pkill -f bettersuno-mcp` (the active session's server respawns on next tool use).

**59 tools / 12 modules.** The server sits behind a WS bridge (`ws-bridge.js`); the MCP server's `suno-client.js` calls the Suno API directly (429 → exponential backoff 1s→30s, 5 retries; 401 → token auto-refreshed).

Extension-side semantics that agents need to know:
- **Playback** (`play_song`): works for ANY song (incl. other users' public playlists). Relays MCP→WS→`background.relayMcpPlaybackToTab`→suno tab→`downloader.togglePlay`; `start_time` seeks; `stop_playback` pauses. Needs the extension connected.
- **Prompts**: stored in the extension's IndexedDB; relayed via WS `extension_request`/`response` (`background.handleMcpExtensionRequest`). Needs the extension connected.
- **Library DB**: `handleMcpExtensionRequest` also handles `get_db_songs` (relays to the suno tab's `mcp_get_db_songs`, which projects `songsList` records). Song records cache `model_name`/`major_model_version`, `play_count`, `task`, `cover_clip_id`; the library UI shows model + played chips and has Unplayed/Model filters, and MCP reads the same data through `get_db_songs`/`get_library_stats {source:"db"}`.
- **Captcha**: MCP server requests Turnstile solve from the extension over WS when Suno requires it. `background.handleMcpCaptchaRequest` runs in the suno.com tab (MAIN world) and **discovers the generation sitekey dynamically** by scanning Suno's own JS chunks for `NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY_GEN` (pattern `...||"0x4AAAA..."`), falling back to `FALLBACK_CAPTCHA_SITEKEY`. Do NOT hardcode Cloudflare's test key (`0x4AAA...AAAQAAA`) — Suno rejects those tokens. The returned token is sent back over WS as `captcha_token`; the MCP server passes it as `token` with `token_provider = captcha_version` from `/api/c/check`.
- **`params: {}` required** in `POST /api/generate/v2-web/` bodies (2026-08). The extension's `generate_song` payload and `downloader.js` `relay_generate` both add it; missing it → 422 `token_validation_failed` / "We couldn't verify your request".

## Code navigation
Use OpenCodeRAG before reading/editing: `search_semantic` (search), `get_file_skeleton` (orient), `find_usages` (before edits), `describe_image` (images). The index can be stale — verify with `read`.

## Inspection (Firefox DevTools MCP)
`npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing`. Tabs `_list_pages`; DOM `_take_snapshot`; network `_list_network_requests`→`_get_network_request`; screenshot `_screenshot_page`. Console/network need BiDi (`--headless`). After code changes: `node build.js` + reload the extension.

**Firefox 152+ CDP note**: The REST endpoints (`/json/version`, `/json/list`) are **gone** — the HTTP server is a minimal `httpd.js`. Use the DevTools MCP with `--connect-existing` or connect via WebSocket (BiDi) directly. To start an inspectable Firefox for testing:
```
# Kill any existing Firefox first, then start with remote debugging + same profile
/usr/lib/firefox/firefox --new-instance --profile ~/.mozilla/firefox/<profile> --remote-debugging-port 9222
# The MCP will then find the browser via `--connect-existing`. You cannot use curl to the CDP port.
