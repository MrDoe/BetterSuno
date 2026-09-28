# BetterSuno — Agent Guide

## Build
- `node build.js` → `dist/chrome/` + `dist/firefox/` (arg `chrome`/`firefox` for one).
- `npm run verify` → syntax check + `node:test` + build both targets. **Run this before declaring any change done** (see Verification below).
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
| `lib/auth-state.js` `lib/identity.js` `lib/ownership.js` `lib/util.js` | **Pure logic** (auth allowlists, JWT claim decoding, ownership gate, string helpers), imported by `background.js`. Split out so `node:test` can import it — the service worker cannot be. New pure logic goes here. |
| `build.js` | Copies `SHARED_FILES` + `SHARED_DIRS`; `verifyRelativeImports()` fails the build when a module is not shipped. |

Content scripts ↔ `background.js` via `chrome.runtime.sendMessage`. `content.js` builds the DOM, `downloader.js` consumes it.
DB `BetterSunoicationsDB` v3: `tabStates`, `songsList`, `userPreferences`, `audioCache`, `imageCache`.

`audioCache` has two record classes. Untagged records (manual **Save to DB**, and any plain play of an encrypted clip) age out after 7 days via `evictStaleBlobs`. Records with `auto_cached: true` (written only by Settings → **Auto-cache songs I listen to**, via `downloader.cacheSongInDb(song, { autoCached: true })`) are exempt from the age sweep and survive until the 500 MB `evictBySize` trim or **Delete from DB** — that exemption is the point of the feature. Both `saveAudioBlobToIDB` and `resolveEncryptedAudioBlob` take the flag so the encrypted and plain paths tag identically.

`content-fetcher.js` keeps private copies of `normalizeHandle`/`pickFirstNonEmptyString` **on purpose**: it is MAIN-world injected as a classic script and cannot use ES module imports. Don't "deduplicate" it.

## Verification
`npm run verify` = `node --check` on every runtime source and test file, `node --test tests/*.test.js`, then `node build.js` for both targets. CI runs the same (`.github/workflows/verify.yml`). There are no runtime or dev dependencies; the toolchain is pure Node.

`node --check` alone is **not** sufficient — it passes on valid-but-wrong code. `tests/service-worker-smoke.test.js` loads `background.js` against a stubbed `chrome` to prove the module graph resolves, and asserts exactly one `onMessage` listener is registered. **Add a test with every fix**; a fix without one is how the same class of bug ships twice.

## Browser differences (Chrome vs Firefox)
SW vs persistent bg; offscreen polling vs inline `ffPollOnce`; `world:"MAIN"` (`__session` cookie read) vs `wrappedJSObject`; `build.js` adds `browser_specific_settings.gecko` for FF. Note `offscreen` is **not** in `manifest.permissions` at all — the MV3 offscreen API needs no permission declaration, so the old "strips the offscreen perm" filter in `build.js` is a no-op.

## Auth & token
`background.js` needs a Bearer token; **a live `suno.com` tab is still required** (it is the only context that can read the cookie). Cached 45 min, refreshed by alarm, pushed to MCP over WS on connect/refresh.

**`window.Clerk` no longer exists (verified 2026-09-27, Chrome 153).** On a signed-in session, `window.Clerk` is `undefined` on `/create`, `/discover` and `/explore` alike: zero `clerk` globals, zero of 127 `<script>` tags referencing Clerk, no Clerk DOM node. The old `window.Clerk.session.getToken()` path therefore always returned `no-clerk` — that was the real cause of "not acquiring a valid token", not retry tuning. Do not "fix" this by re-adding Clerk SDK waits.

Token sources, in order:
1. **Clerk page context** — `window.Clerk.session.getToken()` (kept as primary in case Suno re-exposes it; currently always absent).
2. **Page-context `__session` cookie** — read from `document.cookie` in the MAIN-world injection. The cookie is **not httpOnly** and is a 3-segment JWT (~1681 chars).
3. **Cookie API `__session`** — via `chrome.cookies`, same JWT.

Sources 2 and 3 are **server-validated** against `GET /api/notification/v2?page=1` before being cached (`validateBearerToken`), so a stale cookie yields a precise reason instead of a 401 loop. A bogus token returns 401 on that endpoint, so the probe genuinely discriminates. Never cache an unvalidated cookie token.

**Do not hardcode the token shape.** The bare-string contract is bundle-derived only — it was never confirmed against an authenticated `getToken()` call, because there is no longer a Clerk global to call.

## Generation (`POST /api/generate/v2-web/`)
- Pre-call `POST /api/c/check` `{ctype:"generation"}`. The response's `captcha_version` is **1 = hCaptcha, 2 = Turnstile**; `required:true` means a token is needed. MCP asks the extension to solve it and forwards `captcha_version` in the `captcha_required` WS message. The extension only solves Turnstile — it fails fast with a clear error for hCaptcha (Suno's own fallback when Turnstile times out). `handleMcpCaptchaRequest` prefers a `/create` tab and tries, in order: (1) reuse a fresh token from an existing Turnstile widget (and `reset`s it afterwards so the next call gets a new one), (2) `turnstile.execute()` on an existing widget, (3) render its own widget with a visible "tick the checkbox" hint (110s wait). Failures throw a descriptive error that the MCP relays to the tool caller — the user must tick "Verify you are human" manually. Automated/remote-debugged browsers can't pass (`navigator.webdriver`).
- **Always include `token:null, token_provider:null`** — else 422 `token_validation_failed`.
- **Mode switch is `gpt_description_prompt`**: empty → Custom (uses `prompt` lyrics); non-empty → Inspiration (auto-lyrics, ignores `prompt`). `metadata.create_mode` is NOT the switch.
- Sliders in `metadata.control_sliders` (`style_weight`, `weirdness_constraint`, `audio_weight`, 0–1) + `metadata.can_control_sliders` array.
- **V6 models (2026-09)**: the create UI exposes only the current V6 family — `chirp-hawk` (V6, default), `chirp-hawk-wild` (V6-wild), `chirp-goose` (V6-mini). Old models (V5.5/V5/V4.5) were removed from the UI. Sent as top-level `mv`.
- **`params: {}` is no longer required (2026-09)** — the V6 web client omits it and generation succeeds without it. It was removed from the extension payloads; don't re-add.
- New optional `metadata` fields the web client sends: `is_max_mode` (V6 Max Mode, plan feature `max-mode`), `vocal_gender` (`"m"`/`"f"`, flag `vocal-gender-toggle`), `create_surface`, `user_tier`, `disable_volume_normalization`, `batch_offset`, `is_mumble`, `sound_configs`, `model_config`. Top-level: `duration`, `lyrics_project_id`, `lyricist_id`, `transaction_uuid`.

## V6 API changes (2026-09, verified against live bundles + API)
- **Library**: `GET /api/library?page=…` is **gone (404)**. Library pages now come from `GET /api/project/feed?scope=library&entity_type=clip&limit=30&cursor=…` (web client) or `POST /api/feed/v3` `{limit, cursor}` → `{clips, next_cursor}` (still supported; used by the extension's sync and the MCP server; `limit` > 100 → 400, verified 2026-09).
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
- **Playback** (`play_song`): works for ANY song (incl. other users' public playlists). Relays MCP→WS→`background.relayMcpPlaybackToTab`→suno tab→`downloader.togglePlay`; `start_time` seeks; `stop_playback` pauses. Needs the extension connected. Because `togglePlay` is the single funnel for every playback path, MCP `play_song` also triggers **Auto-cache songs I listen to** when the user has that setting on — MCP-initiated playback writes to the local DB like any other play.
- **Prompts**: stored in the extension's IndexedDB; relayed via WS `extension_request`/`response` (`background.handleMcpExtensionRequest`). Needs the extension connected.
- **Library DB**: `handleMcpExtensionRequest` also handles `get_db_songs` (relays to the suno tab's `mcp_get_db_songs`, which projects `songsList` records). Song records cache `model_name`/`major_model_version`, `play_count`, `task`, `cover_clip_id`; the library UI shows model + played chips and has Unplayed/Model filters, and MCP reads the same data through `get_db_songs`/`get_library_stats {source:"db"}`. Playing a song via BetterSuno bumps its cached `play_count` immediately (merges keep the higher local/server value), so the Unplayed badge/filter update without waiting for a sync; the Unplayed filter itself starts unchecked on every panel load (not persisted).
- **Captcha**: MCP server requests Turnstile solve from the extension over WS when Suno requires it. `background.handleMcpCaptchaRequest` runs in the suno.com tab (MAIN world) and **discovers the generation sitekey dynamically** by scanning Suno's own JS chunks for `NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY_GEN` (pattern `...||"0x4AAAA..."`), falling back to `FALLBACK_CAPTCHA_SITEKEY`. Do NOT hardcode Cloudflare's test key (`0x4AAA...AAAQAAA`) — Suno rejects those tokens. The returned token is sent back over WS as `captcha_token`; the MCP server passes it as `token` with `token_provider = captcha_version` from `/api/c/check`.
- **`params: {}` is no longer sent by the extension** (verified 2026-09-28). Neither the `generate_song` body in `background.js` nor `downloader.js` `relay_generate` adds it; `grep -n params` over `create.js`/`downloader.js` returns nothing, and the only `params` hits in `background.js` are `URLSearchParams` (notification polling) and `content_params` (clip content). Note `relay_generate` forwards `...message.payload` **verbatim** from the WS bridge, so whatever the MCP server sends is what Suno receives — the `bettersuno-mcp` package lives outside this repo and its payload is not verifiable here. Missing `params: {}` on the extension's own path does not cause a 422.

## Code navigation
Use OpenCodeRAG before reading/editing: `search_semantic` (search), `get_file_skeleton` (orient), `find_usages` (before edits), `describe_image` (images). The index goes stale — it once served pre-fix code that inverted a trust-boundary conclusion. **Confirm anything security-relevant with `read`**, and refer to guards by name (`OFFSCREEN_ONLY_TYPES`, `STATE_MODIFYING_TYPES`) rather than line number.

## Inspection (Firefox DevTools MCP)
`npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing`. Tabs `_list_pages`; DOM `_take_snapshot`; network `_list_network_requests`→`_get_network_request`; screenshot `_screenshot_page`. Console/network need BiDi (`--headless`). After code changes: `node build.js` + reload the extension.

**Firefox 152+ CDP note**: The REST endpoints (`/json/version`, `/json/list`) are **gone** — the HTTP server is a minimal `httpd.js`. Use the DevTools MCP with `--connect-existing` or connect via WebSocket (BiDi) directly. To start an inspectable Firefox for testing:
```
# Kill any existing Firefox first, then start with remote debugging + same profile
/usr/lib/firefox/firefox --new-instance --profile ~/.mozilla/firefox/<profile> --remote-debugging-port 9222
# The MCP will then find the browser via `--connect-existing`. You cannot use curl to the CDP port.

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath, systemPrompt?)` — never read raw bytes
- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall
- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact
- **Fix quirks** — `update_quirk(id, ...)` / `delete_quirk(id)` when a stored quirk is outdated or wrong

If no results, run `opencode-rag index`.

### Decision tree — ALWAYS follow this order
1. User mentions code behavior/architecture → `search_semantic(query)`
2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines
3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`
4. User asks a code question → `search_semantic` to gather context before answering
5. User asks about an image or visual asset → `describe_image(filePath)` (optionally pass `systemPrompt` to focus on specific features) to retrieve its generated description, then optionally `search_semantic` for related code
6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`
7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions
8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies

### Proactive triggers — you MUST call these tools when
- User asks about code behavior, architecture, or implementation details
- User asks to edit, refactor, or fix code — call `find_usages` first
- User references files or functions you haven't read yet
- User says "find", "search", "look up", "where is", "how does"
- User refers to an image, screenshot, diagram, or visual asset
- Before answering ANY code-related question, retrieve context first
- Before reading ANY file, call `get_file_skeleton` to orient first

### Anti-patterns — NEVER do these
- Reading full files without calling `get_file_skeleton` first (wastes tokens)
- Editing a function without calling `find_usages` first (breaks call sites)
- Answering code questions without calling `search_semantic` first (you guess at behavior)
- Using `grep`/`glob` when `search_semantic` would find the answer faster
- Treating image files as text — use `describe_image` instead of reading raw bytes
- Using `npx opencode-rag quirk` shell commands instead of the built-in quirk tools (`add_quirk` / `recall_quirks` / `update_quirk` / `delete_quirk`) (the tools are faster, already loaded in-process, and go through the trust monitor)

### MANDATORY quirk capture rules — you MUST call `add_quirk` when
- A build, test, or type-check command fails and you resolve it
- You discover an undocumented library constraint, peer dep, or workaround
- You learn an environment-specific requirement (OS, tool version, etc.)
- You make a design decision that future sessions should remember
- You resolve a gotcha that cost more than one attempt

### MANDATORY quirk hygiene — you MUST call `update_quirk` or `delete_quirk` when
- A stored quirk is outdated, wrong, or has been fixed — update it or delete it instead of adding a contradicting duplicate
- NEVER finish a coding session without adding quirks for resolved errors.
<!-- END opencode-rag -->

<!-- opencode-crosstalk:begin -->
## OpenCode Crosstalk

Other OpenCode sessions in this workspace are reachable through the
`opencode-crosstalk` plugin: `crosstalk_status`, `crosstalk_peers`,
`crosstalk_send`, `crosstalk_inbox`, `crosstalk_claim`, `crosstalk_wait`.
Talk to each other briefly, but keep working — only stop for coordination that prevents
a real collision.

- **Declare once - precisely and concisely - then keep moving.** `crosstalk_status` sets your role and goal;
  `crosstalk_peers` shows active sessions and their leases. Work that does not
  overlap theirs needs no coordination.
- **Talk before you collide.** If you need something a peer holds, `crosstalk_send`
  a short precise ask and continue elsewhere; replies are injected into live turns (use
  `crosstalk_inbox` to catch up). Never force a claim.
- **Lease what you are editing now.** `crosstalk_claim` takes an exclusive expiring
  lease on exact paths — no globs (`resources`, `note`, `ttlSeconds`). `renew` if the
  work runs long, `release` when done; a refusal names the holder.
- **Identity is automatic** — never pass a "who am I". Blocking calls are capped by
  `maxWaitMs` and may return early; that is normal.

Installed globally - `opencode api get /api/plugin` shows if `opencode.crosstalk` is active.
<!-- opencode-crosstalk:end -->
