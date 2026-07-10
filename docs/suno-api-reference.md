# Suno API Reference

> Base URL: `https://studio-api.prod.suno.com`
> Media CDN: `cdn1.suno.ai` (video, audio), `cdn2.suno.ai` (images)

## Common Headers

Auth required endpoints use:
```
Authorization: Bearer <token>
browser-token: {"token":"eyJ0aW1lc3RhbXAiOjE3ODM3MTk4OTUxODN9"}
device-id: <uuid>
```

Token obtained from `window.Clerk.session.getToken()` (MAIN world). Also sent via `__session` cookie as fallback.

---

## Songs / Clips

### GET `/api/clips/{clip_id}/attribution`
Fetch song attribution data.

### GET `/api/clips/get_similar/?id={clip_id}`
Fetch similar songs. Returns array of clip objects.

### GET `/api/clips/parent?clip_id={clip_id}`
Fetch parent clip (if this is a remix/stem). Returns 401 if not owned.

### GET `/api/clips/direct_children_count?clip_id={clip_id}`
Count direct child clips. Returns 401 if not owned.

---

## Comments

### GET `/api/gen/{song_id}/comments?order=newest`
Fetch song comments.

### POST `/api/gen/{song_id}/comment`
Post a comment.
```json
{ "content": "text", "parent_id": null, "track_timestamp": null }
```

### POST `/api/comment/{comment_id}/reaction/`
Like a comment.
```json
{ "reaction": "LIKE" }
```

---

## Reactions

### POST `/api/gen/{song_id}/update_reaction_type/`
Like/dislike/clear a song.

**Set reaction:**
```json
{ "reaction": "LIKE", "recommendation_metadata": {} }
```
Reactions: `"LIKE"`, `"DISLIKE"`.

**Clear reaction:**
```json
{ "play_count": 3, "skip_count": 0, "flagged": false, "clip": "{song_id}", "updated_at": "2023-01-01T00:00:00" }
```

---

## Feed

### POST `/api/feed/v3`
Paginated feed of songs. Core endpoint for library browsing.

```json
{
  "limit": 20,
  "cursor": null,
  "filters": {
    "disliked": "False",
    "trashed": "False",
    "fromStudioProject": { "presence": "False" },
    "user": { "presence": "True", "user_id": "{user_id}" },
    "public": "True",
    "playlist": { "presence": "True", "playlistId": "{playlist_id}" }
  }
}
```

Filters are optional. Use `cursor` for pagination (value from previous response).

### POST `/api/unified/feed`
Alternative feed endpoint.

---

## Library

### GET `/api/library?page={n}&page_size={n}`
Fetch user's song library. Paginated. Returns metadata + clips.

---

## Playlists

### GET `/api/playlist/me?page={n}&show_trashed=false&show_sharelist=false`
Fetch current user's playlists.

### GET `/api/playlist/v2/{playlist_id}?page={n}&page_size=50`
Fetch playlist songs (v2).

### GET `/api/playlist/{playlist_id}?page={n}&page_size=50`
Fetch playlist songs (v1 fallback).

### GET `/api/playlist/{playlist_id}/clips?page={n}&page_size=50`
Fetch playlist clips (fallback).

### POST `/api/feed/v3` with playlist filter
Fetch playlist songs via feed.
```json
{
  "limit": 50,
  "cursor": null,
  "filters": {
    "disliked": "False",
    "trashed": "False",
    "fromStudioProject": { "presence": "False" },
    "playlist": { "presence": "True", "playlistId": "{playlist_id}" }
  }
}
```

---

## Song Generation

### POST `/api/generate/v2-web/`
Generate a song.

**Two mutually exclusive modes:**

| Mode | `gpt_description_prompt` | `prompt` | `tags` | `metadata.create_mode` | Behavior |
|------|--------------------------|----------|--------|------------------------|----------|
| **Inspiration** (auto-generate) | style/description text | `""` | — | `"inspiration"` | Suno writes lyrics from description |
| **Custom** (user lyrics) | `""` **(must be empty)** | lyrics text | style/genre tags | `"custom"` | Suno uses provided lyrics verbatim |

**Critical rule:** Putting style text in `gpt_description_prompt` forces inspiration mode and Suno will auto-generate lyrics, ignoring the `prompt` field entirely. This is true even if `metadata.create_mode` is set to `"custom"`. The `gpt_description_prompt` field is the real mode switch.

**Full custom-mode payload (as used by BetterSuno):**
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
  "continue_at": null,
  "continue_clip_id": null,
  "task": null,
  "persona_id": "<uuid>",
  "persona_model": null,
  "metadata": {
    "web_client_pathname": "/create",
    "create_mode": "custom",
    "create_session_token": "<uuid>",
    "control_sliders": { "style_weight": 0.5, "weirdness_constraint": 0.5 },
    "can_control_sliders": ["style_weight", "weirdness_constraint"]
  }
}
```

### Request Fields

| Field | Type | Description |
|-------|------|-------------|
| `mv` | string | Model/version, e.g. `"chirp-v4"`, `"chirp-fenix"` |
| `gpt_description_prompt` | string | Style description (inspiration mode) or `""` (custom mode) |
| `prompt` | string | Lyric text (custom mode) or `""` (inspiration mode) |
| `make_instrumental` | boolean | Whether to generate instrumental only |
| `title` | string | Song title |
| `tags` | string | Comma-separated style/genre tags (custom mode) |
| `negative_tags` | string | Comma-separated styles to avoid |
| `generation_type` | string | Always `"TEXT"` |
| `continue_at` | string\|null | Timestamp to continue from |
| `continue_clip_id` | string\|null | Clip ID to continue from |
| `task` | string\|null | Override task type |
| `persona_id` | string\|null | Persona UUID for voice model |
| `persona_model` | string\|null | Persona model version |

### Control Sliders

In `metadata.control_sliders` (values 0.0–1.0, mapped from UI 0–100):

| Key | Description |
|-----|-------------|
| `style_weight` | How closely to follow the style tags |
| `weirdness_constraint` | How weird/experimental the output |
| `audio_weight` | Audio quality influence |

Also set `metadata.can_control_sliders` to an array of the slider keys used.

---

## Search

### POST `/api/search/`
Search for playlists, songs, etc.
```json
{
  "search_queries": [{
    "name": "playlists",
    "search_type": "playlist",
    "term": "query",
    "from_index": 0,
    "size": 100,
    "rank_by": "most_relevant"
  }],
  "tune_results": false,
  "tuned_offset": 0
}
```

Response path: `result.playlist.result` or `result.playlists.result`.

---

## Personas

### GET `/api/persona/get-personas/?page={n}`
Fetch user's personas (voice models).

### GET `/api/persona/get-personas/?continuation_token={token}`
Fetch personas with continuation token (alternative pagination).

---

## Notifications

### GET `/api/notification/v2?{params}`
Poll for new notifications.

### POST `/api/notification/v2/read`
Mark notifications as read.

---

## Library Song Fetch (Waterfall Strategy)

When fetching songs by IDs, the extension uses a waterfall:

1. **Feed lookup** — `POST /api/feed/v3` with targeted filters
2. **Bulk library** — `GET /api/library?page=1&page_size=99999` (large page size)
3. **Paged library** — Iterate `GET /api/library` page by page
4. **Content fetcher** — Inject `content-fetcher.js` into MAIN world as last resort

---

## Playlist Song Fetch (Waterfall Strategy)

1. `GET /api/playlist/v2/{id}?page={n}&page_size=50`
2. `GET /api/playlist/{id}?page={n}&page_size=50`
3. `GET /api/playlist/{id}/clips?page={n}&page_size=50`
4. `POST /api/feed/v3` with playlist filter
5. **Page HTML fallback** — Parse JSON from the playlist page HTML

---

## Playlist Mutations

The extension's `playlistMutations` handler tries multiple endpoint variations for add/remove:

**Add song to playlist:**
Candidates (tries each, returns first success):
- `POST /api/playlist/{pid}/update_clips/`
- `PUT /api/playlist/{pid}/songs/` — body: `{ "song_id": "{clip_id}" }`
- `POST /api/playlist/{pid}/clips/` — body: `{ "clip_id": "{clip_id}" }`
- `POST /api/playlist/{pid}/add_clips/` — body: `{ "clip_ids": ["{clip_id}"] }`
- `POST /api/playlist/{pid}/add_songs/` — body: `{ "song_ids": ["{clip_id}"] }`
- `POST /api/playlist/{pid}/v1/clips/` — body: `{ "clip_id": "{clip_id}" }`
- `POST /api/playlist/v2/{pid}/add-clips/` — body: `{ "clip_ids": ["{clip_id}"] }`

**Remove song from playlist:**
Same URL candidates, but uses `DELETE` method instead of `POST`.

---

## CDN Media URL Patterns

| Resource | Pattern |
|----------|---------|
| Cover image (full) | `https://cdn2.suno.ai/video_{type}_{uuid}_..._cover_snapshot_0s_{ts}_image.jpeg` |
| Cover (thumbnail) | Same + `?width=100` |
| Lyric video (newer) | `https://cdn1.suno.ai/{song_id}.mp4` |
| Lyric video (older) | `https://cdn1.suno.ai/video_gen_{uuid}_processed_video.mp4` |
| Cover art video | `https://cdn1.suno.ai/video_upload_{uuid}_processed_video.mp4` |
| Uploaded video | `https://cdn1.suno.ai/video_upload_{uuid}_processed_video.mp4` |
| Audio | Attached to clip data as `audio_url` / `stream_audio_url` |
| User avatar | `https://cdn1.suno.ai/{hash}.webp` |
| Artist image | `https://cdn1.suno.ai/{hash}.webp` |

> **Note:** The `video_upload_` URL pattern is ambiguous — used for both cover art and uploaded videos. Distinguish by checking if a separate `video_url` (lyric video) also exists alongside. In the extension, `video_cover_url` (API field) contains the cover art video URL.

---

## Song Data Model

Normalized fields (from `normalizeSongClip()`):

```
id                  — UUID
title               — string
audio_url           — string|null
video_url           — string|null (lyric video)
video_cover_url     — string|null (cover art video, "Generate Cover Art")
image_url           — string|null
lyrics              — string|null
is_public           — boolean
created_at          — string|null
reaction_state      — "like"|"dislike"|null
is_liked            — boolean
is_stem             — boolean
upvote_count        — number
owner_user_id       — string|null
owner_handle        — string|null
owner_display_name  — string|null
is_owned_by_current_user — boolean
```

---

## Response Meta

- `x-clerk-auth-status`: `signed-in` | `signed-out`
- `x-clerk-auth-reason`: reason if signed out
- `session-id`: session UUID
- Headers use `cloudflare` server, `br` content-encoding
