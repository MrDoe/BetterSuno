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

Fields in `normalizeSongClip()`: `id`, `title`, `audio_url`, `video_url`, `video_cover_url`, `image_url`, `lyrics`, `is_public`, `created_at`, `reaction_state`, `is_liked`, `is_stem`, `upvote_count`, `owner_user_id`, `owner_handle`, `owner_display_name`, `is_owned_by_current_user`.

### Media Toggle Modes (Player tab)

The player tab can toggle between the following media modes:
| Mode | Source | Description |
|------|--------|-------------|
| `image` | `image_url` / `image_large_url` | Static cover image |
| `lyric` | `video_url` or `{songId}.mp4` / `video_gen_{uuid}_processed_video.mp4` | Generated video with lyrics |
| `cover_art` | `video_cover_url` or `video_upload_{uuid}_processed_video.mp4` | Video from "Generate Cover Art" feature |
| `uploaded` | Resolved from song page HTML | User-uploaded video (lazy-resolved) |

## IndexedDB Stores

Database: `BetterSunoicationsDB` (version 3)

| Store | Key | Purpose |
|-------|-----|---------|
| `tabStates` | `tabId` | Per-tab notification polling state |
| `songsList` | `id` | Cached song library |
| `userPreferences` | `key` | Settings, cached playlists, playlist songs |
| `audioCache` | `songId` | Blobs for offline playback |
| `imageCache` | `songId` | Cover image blobs |

## Suno API — Song Generation

Endpoint: `POST https://studio-api.prod.suno.com/api/generate/v2-web/`

### Captcha Check (required before generation)

Suno requires a captcha check before calling the generate endpoint. Without it, the API returns 422 `token_validation_failed`.

1. Call `POST https://studio-api.prod.suno.com/api/c/check` with body `{ "ctype": "generation" }` (Authorization: Bearer token)
2. Response: `{ "required": false, "captcha_version": 1 }` (common case) or `{ "required": true, "captcha_version": N }`
3. If `required: false` — pass `token: null, token_provider: null` in the generate payload (these fields are always present in Suno's own payload)
4. If `required: true` — a Cloudflare Turnstile widget must be rendered and solved on-page to obtain a captcha token. This cannot be done from the background script.

**Critical:** The `token` and `token_provider` fields must be present in the generate payload even when null. Without them, generation fails. See `background.js` `handleGenerateSong` (the `generate_song` message handler).

### Two mutually exclusive modes:

| Mode | `gpt_description_prompt` | `prompt` | `tags` | `metadata.create_mode` | Behavior |
|------|--------------------------|----------|--------|------------------------|----------|
| **Inspiration** (auto-generate) | style/description text | `""` | — | `"inspiration"` | Suno writes lyrics from description |
| **Custom** (user lyrics) | `""` **(must be empty)** | lyrics text | style/genre tags | `"custom"` | Suno uses provided lyrics verbatim |

**Critical rule:** Putting style text in `gpt_description_prompt` forces inspiration mode and Suno will auto-generate lyrics, ignoring the `prompt` field entirely. This is true even if `metadata.create_mode` is set to `"custom"`. The `gpt_description_prompt` field is the real mode switch.

**Control sliders** (optional, in `metadata.control_sliders`):
- `style_weight` — 0.0 to 1.0 (mapped from UI slider 0–100 ÷ 100)
- `weirdness_constraint` — 0.0 to 1.0
- `audio_weight` — 0.0 to 1.0

Also set `metadata.can_control_sliders` to an array of the slider keys used.

**Full custom-mode payload:**
```json
{
  "mv": "chirp-fenix",
  "gpt_description_prompt": "",
  "prompt": "[Verse]\nActual lyrics...",
  "make_instrumental": false,
  "title": "Song Title",
  "tags": "pop, upbeat, synths",
  "negative_tags": "metal, heavy",
  "generation_type": "TEXT",
  "token": null,
  "token_provider": null,
  "continue_at": null,
  "continue_clip_id": null,
  "task": null,
  "metadata": {
    "web_client_pathname": "/create",
    "create_mode": "custom",
    "create_session_token": "<uuid>",
    "control_sliders": { "style_weight": 0.5, "weirdness_constraint": 0.5 },
    "can_control_sliders": ["style_weight", "weirdness_constraint"]
  }
}
```

## Firefox DevTools MCP

The project uses `@mozilla/firefox-devtools-mcp` for browser automation (configured in `.opencode/opencode.json`).

| Setup | Detail |
|-------|--------|
| Command | `npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing --viewport 1280x720` |
| Mode | `--connect-existing` connects to a Firefox instance already running with `--marionette` (port 2828) |
| Profile | Uses `$HOME/.mozilla/firefox/...default-release` — **not** isolated (uses the real user profile) |
| Launch | Start Firefox manually: `firefox --marionette "https://suno.com"` |

### Common Tasks

- **List tabs**: `firefox-devtools_list_pages`
- **Navigate**: `firefox-devtools_navigate_page(url)` — note: `about:` URLs cause errors
- **Inspect DOM**: `firefox-devtools_take_snapshot(maxLines, selector)`
- **Capture screenshot**: `firefox-devtools_screenshot_page(saveTo)`
- **Inspect network**: `firefox-devtools_list_network_requests(urlContains, detail)` then `firefox-devtools_get_network_request(id, format)` — **requires BiDi mode** (not available with `--connect-existing`)
- **Read console**: `firefox-devtools_list_console_messages(level)` — **requires BiDi mode** (not available with `--connect-existing`)
- **Change viewport**: `firefox-devtools_set_viewport_size(width, height)`

### Troubleshooting

- If MCP server won't start, ensure Firefox is already running with `--marionette` (port 2828)
- If tools time out or return MCP errors, kill stale MCP server processes: `pkill -f "firefox-devtools-mcp"`, then restart the MCP from OpenCode's `/mcp` UI
- If the MCP tools disappear from the agent's tool list, the MCP server process was killed — restart it from OpenCode's `/mcp` UI
- BiDi features (console messages, network requests) are **not available** in `--connect-existing` mode; use `--headless` mode (without `--connect-existing`) for those features
- `about:` URLs (like `about:debugging`) cause `navigate_page` errors — select an existing tab instead
- After code changes: `node build.js` then reload the extension in `about:debugging#/runtime/this-firefox`
- The RAG index (`opencode-rag`) can be stale — always use `read` to verify actual source code when RAG shows old mode names or patterns

## Player Tab Video Mode Cycle

The player tab cycles `image → lyric → cover_art → uploaded` in `cyclePlayerTabMediaModeForward/Backward`. Two critical bugs were fixed:

1. **Cached URL chicken-and-egg**: The cycle functions only advanced to modes listed in `getPlayerTabAvailableVideoModes()`, but `cover_art` and `uploaded` modes couldn't appear there until after resolution (which only triggers after entering the mode). **Fix**: allow cycling into `cover_art`/`uploaded` even without cached URL, as long as `song.id` exists — resolution triggers on mode switch.

2. **Cover art URL classification in HTML fallback**: `extractCoverVideosFromHtml` in `background.js` collects video URLs from JSON payloads on the song page using `Object.values()`, which discards field names. A `video_cover_url` value (`video_upload_{uuid}_processed_video.mp4`) was indistinguishable from `video_url`. The pattern-based classification could only classify `video_upload_*` URLs as `coverArt` if a `lyricUrls` entry already existed (order-dependent), or misclassify as `uploaded`. **Fix**: use `Object.entries()` and check field key against `COVER_FIELD_RE` / `LYRIC_FIELD_RE` regex — `video_cover_url` values go directly to `coverArtUrls`, `video_url` to `lyricUrls`.

3. **No fallback for cover_art after failed resolution**: `updatePlayerTabUi` only had a fallback to `image` mode for `uploaded`; added the same fallback for `cover_art`.

## Notable Quirks

- `content-idb.js` (frontend IDB) and `idb-store.js` (background IDB) both use the same DB name but are separate wrappers — they coexist in different JS contexts.
- Since `content.js` and `downloader.js` are separate content scripts, communication happens via `chrome.runtime.sendMessage` to `background.js`, which proxies between them.
- `downloader.js` re-fetches the playlist songs page HTML when loading playlist tracks (`fetchPlaylistSongsFromPageHtml`), parsing JSON payloads embedded in the page. It does NOT use a direct API for playlist songs listing.
- Playlist add/remove uses a waterfall strategy: tries multiple API endpoint variants (`update_clips`, v1/v2 songs/clips POST/DELETE, add_songs, add_clips, etc.) and returns first success.
- No formal test suite. Manual verification only.
- `eslint` listed in `package.json` dependencies but no config file found — not configured.
- `package-lock.json` is in `.gitignore`.

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath)` — never read raw bytes

If no results, run `opencode-rag index`.

## MCP Server (`mcp-server/`)

The project includes a standalone MCP server in `mcp-server/` that exposes Suno features to AI agents (opencode, Claude Desktop, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

### Architecture

```
AI Client ←stdio→ MCP Server ←ws://localhost:9423→ BetterSuno Extension → Suno API
                         ↓
                    Direct API calls (with shared token)
```

- **MCP server** (`mcp-server/src/index.js`) — stdio transport, registers 47 tools across 8 modules
- **Extension** (`background.js`) — WebSocket client connects to `ws://localhost:9423`, shares the Clerk auth token, handles captcha challenges if needed
- **Token flow**: Extension pushes token on connect and on every 45-minute token refresh alarm. MCP server stores it and makes direct API calls.

### Setup

```bash
cd mcp-server && npm install && cd ..
node mcp-server/src/index.js  # starts the server (stdio)
```

Register in `.opencode/opencode.json`:
```json
"bettersuno": {
  "type": "local",
  "command": ["node", "mcp-server/src/index.js"],
  "enabled": true
}
```

Prerequisites: BetterSuno extension loaded in Firefox/Chrome with a Suno tab open (for auth).

### Tool Modules (47 tools)

| Module | File | Tools |
|--------|------|-------|
| Generation | `tools/generation.js` | `create_song`, `inspire_song`, `cover_song`, `extend_song`, `remaster_song`, `make_stems`, `get_recommended_styles`, `upsample_tags` |
| Library | `tools/library.js` | `list_library`, `get_song`, `get_songs_by_ids`, `search_songs`, `search_users`, `get_profile`, `get_current_user`, `get_user_session` |
| Downloads | `tools/downloads.js` | `get_song_urls`, `download_song`, `download_lyrics`, `download_cover_image` |
| Personas | `tools/personas.js` | `create_persona`, `list_personas`, `get_persona`, `list_followed_personas`, `list_loved_personas`, `toggle_love_persona` |
| Uploads | `tools/uploads.js` | `upload_audio`, `upload_image`, `upload_video` |
| Playlists | `tools/playlists.js` | `list_playlists`, `create_playlist`, `get_playlist`, `add_to_playlist`, `remove_from_playlist`, `reorder_playlist`, `delete_playlist`, `update_playlist_metadata` |
| Workspaces | `tools/workspaces.js` | `list_projects`, `get_project`, `get_project_clips` |
| Metadata | `tools/metadata.js` | `delete_song`, `trash_song`, `set_visibility`, `like_song`, `update_song_metadata`, `generate_video`, `create_custom_model` |

### Key Implementation Details

- **Captcha**: All generation tools call `POST /api/c/check` with `{ctype: "generation"}` first. If captcha is required, the MCP server requests a Turnstile solve from the extension via WebSocket.
- **Upload flow**: Files are uploaded via S3 presigned URLs (init → S3 → finish → optional initialize-clip). Reads files from the local filesystem by path.
- **Rate limiting**: `suno-client.js` implements exponential backoff (1s → 2s → ... → 30s cap) for 429 responses, max 5 retries.
- **Token expiry**: 401 responses bubble up as clear errors. The extension pushes refreshed tokens automatically every 45 min.

## Browser-level inspection

When analyzing Suno.com behavior, use the **firefox-devtools** MCP tools instead of static code search:
- **Network requests**: `firefox-devtools_list_network_requests(urlContains, detail)` to find API calls, then `firefox-devtools_get_network_request(id, format)` for full request/response details
- **DOM structure**: `firefox-devtools_take_snapshot(maxLines, selector)` for live page DOM
- **Screenshots**: `firefox-devtools_screenshot_page(saveTo)` for visual verification
- **Console logs**: `firefox-devtools_list_console_messages(level)` for runtime debug output
- **Page navigation**: `firefox-devtools_navigate_page(url)` to load specific Suno pages

See the Firefox DevTools MCP section above for setup and troubleshooting.
<!-- END opencode-rag -->
