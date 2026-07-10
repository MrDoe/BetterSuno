---
name: suno-song-analysis
description: "Analyze Suno.com song pages, extract media URLs (cover image, generated video, uploaded video, audio), understand Suno API endpoints and data model, and interact with Suno's CDN patterns."
risk: unknown
source: "BetterSuno project analysis"
date_added: "2026-07-10"
---

# Suno Song Page Analysis

Expert in analyzing Suno.com song pages and extracting media assets. Understands the Suno platform architecture, API patterns, CDN URL structures, and data model.

## Suno Platform Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js (React) |
| Auth | Clerk (`clerk.suno.com`) |
| CDN/Cache | Cloudflare |
| Storage | AWS S3 (via CloudFront) |
| API Domain | `studio-api-prod.suno.com` |
| Media CDN | `cdn1.suno.ai`, `cdn2.suno.ai` |
| Assets CDN | `cdn-o.suno.ai` |

## Auth & Session

- Bearer tokens obtained via `window.Clerk.session.getToken()` (MAIN world)
- Cookie `__session` on `clerk.suno.com` / `suno.com` as fallback
- Token cached for ~45 min
- Custom headers on all API requests:
  - `browser-token: {"token":"eyJ..."}`
  - `device-id: <uuid>`
- Auth status returned in response headers: `x-clerk-auth-status`, `x-clerk-auth-reason`

## API Endpoints

### Song/Clip Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/clips/{id}/attribution` | GET | Song attribution data |
| `/api/clips/get_similar/?id={id}` | GET | Similar songs |
| `/api/clips/parent?clip_id={id}` | GET | Parent clip (returns 401 if not owned) |
| `/api/clips/direct_children_count?clip_id={id}` | GET | Child clip count (returns 401 if not owned) |
| `/api/gen/{id}/comments?order=newest` | GET | Song comments |
| `/api/unified/feed` | POST | Unified feed (requires auth) |
| `/api/feed/v3` | POST | Feed v3 (requires auth) |
| `/api/generate/v2-web/` | POST | Generate song (requires auth) |

### Playlist Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/playlist/v2/{id}?page={n}&page_size=50` | GET | Playlist v2 detail |
| `/api/playlist/{id}` | GET | Playlist detail |
| `/api/playlist/{id}/clips?page={n}&page_size=50` | GET | Playlist clips |

## Important API Field: `video_cover_url`

The Suno API clip data includes a `video_cover_url` field for songs that have a **"Generate Cover Art"** video. This is distinct from `video_url` (the generated lyric video):

```json
{
  "video_url": "https://cdn1.suno.ai/{song_id}.mp4",                                         // Lyric video
  "video_cover_url": "https://cdn1.suno.ai/video_upload_{uuid}_processed_video.mp4",         // Cover art video
  "audio_url": "https://cdn1.suno.ai/{song_id}.mp3",
  "image_url": "https://cdn2.suno.ai/video_upload_{uuid}_cover_snapshot_0s_{ts}_image.jpeg"  // Cover snapshot
}
```

The extension's `normalizeSongClip()` extracts `video_cover_url` separately from `video_url` to distinguish the two video types.

## CDN URL Patterns

### Cover Images
```
https://cdn2.suno.ai/video_gen_{uuid}_video_upload_{uuid}_cover_snapshot_0s_{timestamp}_image.jpeg
https://cdn2.suno.ai/video_gen_{uuid}_video_upload_{uuid}_cover_snapshot_0s_{timestamp}_image.jpeg?width=100
https://cdn2.suno.ai/video_upload_{uuid}_video_upload_{uuid}_cover_snapshot_0s_{timestamp}_image.jpeg
```

### Generated Videos (AI visualizer / lyric video) — TWO patterns:
```
https://cdn1.suno.ai/video_gen_{uuid}_processed_video.mp4    # video_gen pattern (older songs)
https://cdn1.suno.ai/{song_id}.mp4                            # simple song_id pattern (newer songs)
```

### Cover Art Videos ("Generate Cover Art" feature)
```
https://cdn1.suno.ai/video_upload_{uuid}_processed_video.mp4
```
Note: `video_upload_` URL pattern is used for BOTH "Generate Cover Art" videos and user-uploaded videos.
Distinguish by checking if a separate `video_url` (lyric video) also exists:
- `video_url` exists + `video_upload_` URL → second one is a cover art video
- Only `video_upload_` URL exists without `video_url` → likely a user-uploaded video

### Uploaded Videos (user upload)
```
https://cdn1.suno.ai/video_upload_{uuid}_processed_video.mp4
```

### User Avatars
```
https://cdn1.suno.ai/{hash}.webp
https://cdn1.suno.ai/{hash}.jpg
https://cdn1.suno.ai/sAura{hash}.jpg
```

### Cover Image Variants (from similar tracks / recommendations)
```
https://cdn2.suno.ai/{uuid}.jpeg?width=100
https://cdn2.suno.ai/image_{uuid}.jpeg?width=100
```

### Audio (lazy-loaded, only fetched on play)
```
https://cdn1.suno.ai/sil-100.mp3  (silent placeholder, loaded before playback)
```

## Song Data Model

Normalized fields from `normalizeSongClip()`:

```javascript
{
  id: string,                    // UUID
  title: string,                 // Song title
  audio_url: string | null,      // Audio stream URL
  video_url: string | null,      // Generated lyric video URL ({song_id}.mp4 or video_gen_{uuid}_processed_video.mp4)
  video_cover_url: string | null, // "Generate Cover Art" video (video_upload_{uuid}_processed_video.mp4)
  image_url: string | null,      // Cover image URL
  lyrics: string | null,         // Lyrics text
  is_public: boolean,
  created_at: string | null,
  reaction_state: 'like' | 'dislike' | null,
  is_liked: boolean,
  is_stem: boolean,              // Stem separation clip
  upvote_count: number,
  owner_user_id: string | null,
  owner_handle: string | null,
  owner_display_name: string | null,
  is_owned_by_current_user: boolean
}
```

### Field paths for raw clip extraction

The raw clip data can be nested under any of: `clip`, `song`, `item`, or flat.

| Normalized Field | Raw Field Paths |
|-----------------|-----------------|
| `audio_url` | `audio_url`, `stream_audio_url`, `song_path` |
| `video_url` | `video_url`, `video_cdn_url`, `mp4_url`, `metadata.video_url`, `cover_snapshot_url`, `video_upload_url`, `uploaded_video_url`, `metadata.cover_snapshot_url`, `metadata.video_upload_url`, `metadata.uploaded_video_url` |
| `video_cover_url` | `video_cover_url`, `metadata.video_cover_url`, `meta.video_cover_url` |
| `image_url` | `image_url`, `image`, `image_large_url`, `cover_url`, `cover_image_url`, `thumbnail_url`, `artwork_url`, `metadata.image_url`, `metadata.cover_image_url`, `meta.image_url` |
| `lyrics` | `lyrics`, `display_lyrics`, `full_lyrics`, `raw_lyrics`, `prompt`, `metadata.lyrics`, `metadata.prompt`, `meta.lyrics` |
| `owner_user_id` | `user_id`, `owner_user_id`, `user.id`, `user.user_id` |

## Song Page HTML Structure

The song page at `https://suno.com/song/{id}` is a Next.js app with:

```
body
  div#main-container
    sidebar (left)
      Logo, Nav (Home, Explore, Create, Studio, Library, Hooks)
      User section (Log in / Avatar)
      Bottom links (Earn Credits, Labs, Terms, More)
    main content area
      song cover image (<img>)
      video element (<video>) — generated AI visualizer
      song title (<h1>)
      artist name + link (<a> to /@{handle})
      follow button
      style tags (e.g. "Audio Drama 3D Audio Binaural")
      date
      action buttons (Play, Add to Playlist, Like, Dislike, Comment, Share, More)
      play count, like count, comment count
      description/lyrics section
    playbar (bottom)
      cover image thumbnail
      title + artist
      playback controls (shuffle, prev, play/pause, next, repeat)
      progress bar + time
      queue, like, dislike, comment, share, volume
```

## Video/Upload Detection

A song can have up to 3 video types (toggled in the player UI):

| Type | API Field | URL Pattern | Source |
|------|-----------|-------------|--------|
| **Lyric video** | `video_url` | `{song_id}.mp4` or `video_gen_{uuid}_processed_video.mp4` | AI-generated video with lyrics |
| **Cover art video** | `video_cover_url` | `video_upload_{uuid}_processed_video.mp4` | "Generate Cover Art" feature |
| **Uploaded video** | N/A (lazy-resolved) | `video_upload_{uuid}_processed_video.mp4` | User-uploaded video (must be resolved from song page HTML) |

The `video_upload_` URL pattern is ambiguous — it can be either a cover art video or a user-uploaded video.
To distinguish: if a separate `video_url` (lyric video) exists alongside a `video_upload_` URL, the latter is a cover art video.
If only a `video_upload_` URL exists, it's likely a user-uploaded video.

Key lesson: **`video_cover_url` is a separate field from `video_url` in the raw API clip data. Do NOT confuse it with `cover_video_url` (wrong name — that field does not exist in the API).**

## Network Request Flow

When loading a song page:
1. HTML page load (Next.js SSR via Cloudflare) — clip data is embedded in **RSC payload** (`__next_f.push`), NOT `__NEXT_DATA__`
2. `GET /api/clips/{id}/attribution` — attribution data
3. `GET /api/clips/get_similar/?id={id}` — similar songs
4. `GET /api/gen/{id}/comments?order=newest` — comments
5. Cover image loaded from `cdn2.suno.ai`
6. Video loaded from `cdn1.suno.ai` (as `<video>` element, partial content range requests)
7. Audio NOT pre-loaded — only fetched when user presses play
8. Auth-gated requests (parent, children) return 401 if not logged in

## RSC Payload Extraction (Critical)

Suno migrated from `__NEXT_DATA__` to Next.js **RSC (React Server Components)** format. The clip data is now embedded in `__next_f.push([1, "...escaped JSON..."])` calls.

**Key facts:**
- The HTML has **no** `<script id="__NEXT_DATA__">` tag
- The HTML has **no** `<source>` or `<video>` tags with video URLs
- All video URLs are inside the RSC payload string
- The push argument is a JSON array `[1, "...string..."]` where the string contains newline-separated RSC chunks
- Each chunk has the format `INDEX:JSON_CONTENT`
- Backslash-escaped quotes (`\"`) inside the string must be handled properly

**Extraction approach (see `background.js:extractJsonPayloadsFromHtml`):**
1. Find all `__next_f.push([1, "..."]);` calls using `indexOf` with manual quote-matching (regex `[^"]*` can't handle `\"`)
2. Parse the outer string via `JSON.parse` to properly resolve all escaping
3. Split the resulting string by `\n` to get individual RSC lines
4. Split each line at the first `:` — the part before is the chunk index, the part after is JSON
5. Parse JSON chunks into objects for recursive URL extraction

## Media Content Types

| Resource | CDN | Format | Example Pattern |
|----------|-----|--------|----------------|
| Cover image (full) | cdn2.suno.ai | JPEG | `video_gen_{uuid}_video_upload_{uuid}_cover_snapshot_0s_{ts}_image.jpeg` |
| Cover image (thumb) | cdn2.suno.ai | JPEG | Same + `?width=100` |
| Generated video (lyric) | cdn1.suno.ai | MP4 | `{song_id}.mp4` or `video_gen_{uuid}_processed_video.mp4` |
| Cover art video | cdn1.suno.ai | MP4 | `video_upload_{uuid}_processed_video.mp4` (same pattern as uploaded, distinguished by presence of `video_url`) |
| Uploaded video | cdn1.suno.ai | MP4 | `video_upload_{uuid}_processed_video.mp4` |
| Audio | cdn1.suno.ai | MP3/M4A/WAV | `sil-100.mp3` (placeholder), actual URL in clip data |
| User avatar | cdn1.suno.ai | WEBP/JPG | `{hash}.webp`, `sAura{hash}.jpg` |
| Artist image | cdn1.suno.ai | WEBP | `{hash}.webp` |

## Page Metadata (from Open Graph / API)

- Title: `"{title} by {artist} | Suno"`
- Description: `"{title} by {artist} (@{handle}). Listen and make your own on Suno."`
- URL: `https://suno.com/song/{id}`

## Related Skills

- **chrome-extension-developer**: For building Suno extensions
- **browser-extension-builder**: For extension patterns
- **ai-engineer**: For API integration patterns
