# BetterSuno MCP Server — API Reference

47 tools across 8 modules. All tools require the BetterSuno extension to be running with an active Suno.com tab for authentication.

---

## Generation

### `create_song`

Generate a song from custom lyrics and style tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lyrics` | string | Yes | Song lyrics with section markers like `[Verse]`, `[Chorus]` |
| `title` | string | No | Song title |
| `tags` | string | No | Style/genre tags (e.g. `"pop, upbeat, synth"`) |
| `negative_tags` | string | No | Styles to avoid |
| `instrumental` | boolean | No | Make instrumental (no vocals) |
| `mv` | string | No | Model version (`chirp-fenix`, `chirp-v4`, `chirp-v3-5`). Default: `chirp-fenix` |
| `weirdness` | number | No | Weirdness 0–100 |
| `style_weight` | number | No | Style influence 0–100 |
| `audio_weight` | number | No | Audio influence 0–100 |
| `persona_id` | string | No | Persona ID for voice consistency |

**Example:**
```json
{
  "lyrics": "[Verse]\nHello world\n\n[Chorus]\nGoodbye world",
  "title": "My Song",
  "tags": "indie rock, acoustic",
  "weirdness": 50,
  "style_weight": 75
}
```

---

### `inspire_song`

Generate a song from a description. Suno auto-writes the lyrics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | Yes | Style/description text (e.g. `"a sad ballad about losing a pet"`) |
| `title` | string | No | Song title |
| `instrumental` | boolean | No | Make instrumental |
| `mv` | string | No | Model version. Default: `chirp-fenix` |
| `tags` | string | No | Additional style tags |

---

### `cover_song`

Create a cover version of an existing song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to cover |
| `start_s` | number | No | Start time in seconds |
| `end_s` | number | No | End time in seconds |
| `mv` | string | No | Model version. Default: `chirp-fenix` |
| `tags` | string | No | Style tags for the cover |
| `instrumental` | boolean | No | Make instrumental |

---

### `extend_song`

Extend a song from a specific point.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to extend |
| `continue_at` | number | Yes | Time in seconds to extend from |
| `lyrics` | string | No | Optional lyrics for the extension |
| `mv` | string | No | Model version. Default: `chirp-fenix` |
| `tags` | string | No | Style tags for the extension |

---

### `remaster_song`

Remaster/upsample a song to higher quality.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to remaster |
| `model_name` | string | No | Target model |
| `tags` | string | No | Style tags to apply |
| `freedom` | number | No | Variation freedom 0.0–1.0 |
| `tone` | number | No | Tone adjustment 0.0–1.0 |
| `clarity` | number | No | Clarity 0.0–1.0 |
| `strength` | number | No | Strength 0.0–1.0 |
| `stereo_width` | number | No | Stereo width 0.0–1.0 |
| `variation_category` | string | No | Variation category |

---

### `make_stems`

Extract stems (vocals, instrumental, drums, bass) from a song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to extract stems from |

---

### `get_recommended_styles`

Get recommended style tags for the current user.

No parameters.

---

### `upsample_tags`

Expand and enhance style tags with AI suggestions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tags` | string | Yes | Base style tags to expand |

---

## Library

### `list_library`

List the user's song library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Songs per page. Default: 50 |
| `cursor` | string | No | Pagination cursor from previous response |
| `liked_only` | boolean | No | Show only liked songs |
| `public_only` | boolean | No | Show only public songs |
| `stems_only` | boolean | No | Show only stems |
| `sort` | string | No | `newest` or `oldest` |

---

### `get_song`

Get details for a single song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |

---

### `get_songs_by_ids`

Batch get multiple songs by their IDs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_ids` | string[] | Yes | Array of song clip IDs |

---

### `search_songs`

Search Suno songs by query text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `page` | number | No | Page number. Default: 1 |

---

### `search_users`

Search Suno users by query text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | User search query |

---

### `get_profile`

Get a user profile by handle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `handle` | string | Yes | User handle (e.g. `@username`) |

---

### `get_current_user`

Get the current user's account info (credits, subscription, plan).

No parameters.

---

### `get_user_session`

Get current user session info.

No parameters.

---

## Downloads

### `get_song_urls`

Get all downloadable URLs for a song (audio, video, image, lyrics).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |

---

### `download_song`

Download a song's audio to disk.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `format` | string | No | `m4a` or `wav`. Default: `m4a` |
| `output_dir` | string | No | Output directory (defaults to current dir) |

---

### `download_lyrics`

Download a song's lyrics as a text file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `output_dir` | string | No | Output directory (defaults to current dir) |

---

### `download_cover_image`

Download a song's cover image.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `output_dir` | string | No | Output directory (defaults to current dir) |

---

## Personas

### `create_persona`

Create a voice persona from existing clips.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Persona name |
| `clip_ids` | string[] | Yes | Array of clip IDs to base the persona on |
| `description` | string | No | Persona description |
| `is_voice_recording` | boolean | No | Whether this uses a voice recording |

---

### `list_personas`

List your own personas.

No parameters.

---

### `get_persona`

Get details for a specific persona.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `persona_id` | string | Yes | Persona ID |

---

### `list_followed_personas`

List personas you follow.

No parameters.

---

### `list_loved_personas`

List personas you have loved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | No | Page number. Default: 1 |

---

### `toggle_love_persona`

Love or unlove a persona.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `persona_id` | string | Yes | Persona ID |

---

## Uploads

### `upload_audio`

Upload an audio file to Suno. Uses the S3 presigned URL flow: init → S3 upload → finish → initialize clip.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the audio file on disk |
| `title` | string | No | Title for the uploaded clip |
| `upload_type` | string | No | Upload type. Default: `studio_file_upload` |
| `is_stem_mix` | boolean | No | Whether the file is a stem mix |
| `initialize_clip` | boolean | No | Whether to initialize a clip after upload. Default: `true` |

**Supported formats:** mp3, wav, m4a, flac, ogg, aac
**Max size:** 500 MB

---

### `upload_image`

Upload a cover image to Suno.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the image file on disk |

**Supported formats:** jpg, png, webp, gif
**Max size:** 10 MB

---

### `upload_video`

Upload a video file to Suno.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the video file on disk |
| `is_video_cover` | boolean | No | Whether this is a cover art video |
| `clip_id` | string | No | Optional clip ID to associate with |

**Supported formats:** mp4, webm, mov
**Max size:** 100 MB

---

## Playlists

### `list_playlists`

List your playlists.

No parameters.

---

### `create_playlist`

Create a new playlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Playlist name |
| `description` | string | No | Playlist description |
| `is_public` | boolean | No | Whether the playlist is public. Default: false |

---

### `get_playlist`

Get playlist details and tracks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |
| `page` | number | No | Page number. Default: 1 |

---

### `add_to_playlist`

Add songs to a playlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |
| `clip_ids` | string[] | Yes | Array of song clip IDs to add |

---

### `remove_from_playlist`

Remove songs from a playlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |
| `clip_ids` | string[] | Yes | Array of song clip IDs to remove |

---

### `reorder_playlist`

Reorder tracks in a playlist by index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |
| `from_index` | number | Yes | Current index of the track to move |
| `to_index` | number | Yes | Target index to move the track to |

---

### `delete_playlist`

Delete/trash a playlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |

---

### `update_playlist_metadata`

Update playlist name, description, or visibility.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `playlist_id` | string | Yes | Playlist ID |
| `name` | string | No | New playlist name |
| `description` | string | No | New description |
| `is_public` | boolean | No | Whether the playlist is public |

---

## Workspaces

### `list_projects`

List your projects/workspaces.

No parameters.

---

### `get_project`

Get project/workspace details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |

---

### `get_project_clips`

List clips/songs in a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |

---

## Metadata

### `delete_song`

Permanently delete songs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_ids` | string[] | Yes | Array of song clip IDs to delete |
| `reason` | string | No | Optional reason for deletion |

---

### `trash_song`

Move songs to/from trash.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_ids` | string[] | Yes | Array of song clip IDs |
| `trash` | boolean | No | True to trash, false to restore. Default: true |

---

### `set_visibility`

Make a song public or private.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `is_public` | boolean | Yes | True for public, false for private |
| `submit_to_contest` | boolean | No | Also submit to contest. Default: false |

---

### `like_song`

Like or unlike a song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `like` | boolean | Yes | True to like, false to unlike |

---

### `update_song_metadata`

Update a song's title, tags, lyrics, or visibility.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `title` | string | No | New title |
| `tags` | string | No | New style tags |
| `lyrics` | string | No | New lyrics |
| `negative_tags` | string | No | New negative/exclude style tags |
| `is_public` | boolean | No | Update visibility |

---

### `generate_video`

Generate a lyric video for a song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |

---

### `create_custom_model`

Create a custom AI model from a set of clips.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_ids` | string[] | Yes | Array of clip IDs (minimum 6) |
| `name` | string | No | Custom model name. Default: `Custom Model` |

---

## Error Handling

All tools return errors as MCP error responses with descriptive messages. Common errors:

| Error | Cause |
|-------|-------|
| `No auth token. Is BetterSuno extension running and connected?` | Extension not loaded, no Suno tab, or WS bridge disconnected |
| `Captcha solve timed out` | Cloudflare Turnstile challenge not solved within 60s |
| `HTTP 401` | Token expired — extension should refresh automatically |
| `HTTP 429` | Rate limited — server retries with exponential backoff |
| `HTTP 422 token_validation_failed` | Captcha check not completed — should not occur (handled internally) |

## Suno API Endpoints Used

All endpoints are on `https://studio-api.prod.suno.com`:

| Endpoint | Method | Used by |
|----------|--------|---------|
| `/api/c/check` | POST | All generation tools (captcha check) |
| `/api/generate/v2-web/` | POST | `create_song`, `inspire_song`, `cover_song`, `extend_song` |
| `/api/generate/upsample` | POST | `remaster_song` |
| `/api/edit/stems/{clip_id}/` | POST | `make_stems` |
| `/api/generate/get_recommend_styles` | GET | `get_recommended_styles` |
| `/api/prompts/upsample` | POST | `upsample_tags` |
| `/api/feed/v3` | POST | `list_library` |
| `/api/clip/{clip_id}` | GET | `get_song`, download tools |
| `/api/clips/get_songs_by_ids` | POST | `get_songs_by_ids` |
| `/api/search/` | GET | `search_songs` |
| `/api/search/users` | GET | `search_users` |
| `/api/profiles/{handle}` | GET | `get_profile` |
| `/api/user/me` | GET | `get_current_user` |
| `/api/session/` | GET | `get_user_session` |
| `/api/uploads/audio/` | POST | `upload_audio` (init) |
| `/api/uploads/audio/{id}/upload-finish/` | POST | `upload_audio` (finish) |
| `/api/uploads/audio/{id}/initialize-clip/` | POST | `upload_audio` (clip init) |
| `/api/uploads/image/` | POST | `upload_image` (init) |
| `/api/uploads/image/{id}/upload-finish/` | POST | `upload_image` (finish) |
| `/api/uploads/video/` | POST | `upload_video` (init) |
| `/api/uploads/video/{id}/upload-finish/` | POST | `upload_video` (finish) |
| `/api/persona/create/` | POST | `create_persona` |
| `/api/persona/get-personas/` | GET | `list_personas` |
| `/api/persona/get-persona/{id}/` | GET | `get_persona` |
| `/api/persona/get-followed-personas/` | GET | `list_followed_personas` |
| `/api/persona/get-loved-personas/` | GET | `list_loved_personas` |
| `/api/persona/{id}/toggle_love/` | POST | `toggle_love_persona` |
| `/api/playlist/me` | GET | `list_playlists` |
| `/api/playlist/create/` | POST | `create_playlist` |
| `/api/playlist/v2/{id}` | GET | `get_playlist` |
| `/api/playlist/v2/{id}/tracks/add` | POST | `add_to_playlist` |
| `/api/playlist/v2/{id}/tracks/remove` | POST | `remove_from_playlist` |
| `/api/playlist/v2/{id}/tracks/reorder-by-index` | POST | `reorder_playlist` |
| `/api/playlist/v2/{id}/trash` | POST | `delete_playlist` |
| `/api/playlist/set_metadata` | POST | `update_playlist_metadata` |
| `/api/project/feed` | GET | `list_projects` |
| `/api/project/{id}` | GET | `get_project` |
| `/api/project/{id}/clips` | GET | `get_project_clips` |
| `/api/clips/delete/` | POST | `delete_song` |
| `/api/gen/trash` | POST | `trash_song` |
| `/api/gen/{id}/set_visibility/` | POST | `set_visibility` |
| `/api/gen/{id}/update_reaction_type/` | POST | `like_song` |
| `/api/gen/{id}/set_metadata/` | POST | `update_song_metadata` |
| `/api/video/generate/{id}/` | POST | `generate_video` |
| `/api/custom-model/create/` | POST | `create_custom_model` |
