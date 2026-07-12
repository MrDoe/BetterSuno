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

## MCP server (`mcp-server/`)
stdio server, **59 tools / 12 modules**. `index.js` registers; each `tools/*.js` exports `register*Tools(allTools)`. Token comes from the WS bridge (`ws-bridge.js`); Suno calls go direct via `suno-client.js` (429 → exponential backoff 1s→30s, 5 retries; 401 → token auto-refreshed).
Run: `cd mcp-server && npm install && node mcp-server/src/index.js`. Register in `.opencode/opencode.json` as local `bettersuno`. Requires the extension loaded + an open Suno tab.

Tools (module → `file` → tools):
- Generation `generation.js`: create_song, inspire_song, cover_song, extend_song, remaster_song, make_stems, get_recommended_styles, upsample_tags, mashup_song
- Library `library.js`: list_library, get_song, get_songs_by_ids, search_songs, search_users, get_profile, get_current_user, get_user_session
- Downloads `downloads.js`: get_song_urls, download_song, download_lyrics, download_cover_image
- Personas `personas.js`: create_persona, list_personas, get_persona, list_followed_personas, list_loved_personas, toggle_love_persona
- Uploads `uploads.js`: upload_audio, upload_image, upload_video
- Playlists `playlists.js`: list_playlists, create_playlist, get_playlist, get_playlist_songs, search_playlists, add_to_playlist, remove_from_playlist, reorder_playlist, delete_playlist, update_playlist_metadata
- Workspaces `workspaces.js`: list_projects, get_project, get_project_clips
- Metadata `metadata.js`: delete_song, trash_song, set_visibility, like_song, update_song_metadata, generate_video, create_custom_model
- Playback `playback.js`: play_song, stop_playback
- Comments `comments.js`: get_song_comments, post_song_comment, update_comment_reaction
- Feed `feed.js`: explore_feed
- Prompts `prompts.js`: get_prompts, save_prompt, delete_prompt

Semantics that bite:
- **Ownership gate** (`auth.js` `assertOwned`): download/metadata/delete throw for non-owned songs. `cover`/`extend`/`mashup` use `assertCanCover` (other artists allowed only if `metadata.can_remix`). `like_song` is open.
- **Playback** (`play_song`): works for ANY song (incl. other users' public playlists). Relays MCP→WS→`background.relayMcpPlaybackToTab`→suno tab→`downloader.togglePlay`; `start_time` seeks; `stop_playback` pauses. Needs the extension connected.
- **Comments opt-in**: throw unless started with `MCP_ALLOW_COMMENTS=true`.
- **Prompts**: stored in the extension's IndexedDB; relayed via WS `extension_request`/`response` (`background.handleMcpExtensionRequest`). Needs the extension connected.
- **explore_feed**: public read-only; downloading or saving cover art of those is blocked by the ownership gate.
- **Search**: `search_songs`/`search_users`/`search_playlists` use `POST /api/search/` with `search_queries` (`search_type` song/user/playlist). GET variants return 405.

## Code navigation
Use OpenCodeRAG before reading/editing: `search_semantic` (search), `get_file_skeleton` (orient), `find_usages` (before edits), `describe_image` (images). The index can be stale — verify with `read`.

## Inspection (Firefox DevTools MCP)
`npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing`. Tabs `_list_pages`; DOM `_take_snapshot`; network `_list_network_requests`→`_get_network_request`; screenshot `_screenshot_page`. Console/network need BiDi (`--headless`). After code changes: `node build.js` + reload the extension.
