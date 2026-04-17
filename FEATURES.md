# BetterSuno — Planned Features

This document lists the features planned for upcoming releases. Each item includes a description of the user-facing behaviour and a brief technical sketch of how it will be implemented.

---

## 1. Playback Queue & Continuous Play

**Status:** Planned

**Description:**  
Allow users to build an ordered queue of songs that plays back-to-back without manual intervention. Songs can be appended, removed, or reordered within the queue. The Player tab will show the upcoming tracks so the listener always knows what is coming next.

**Details:**
- "Add to Queue" button on every song row in the Song Library.
- Queue panel inside the Player tab showing song title, artist, and duration.
- Drag-to-reorder support for the queue list.
- "Play Queue" button starts playback from the top of the queue.
- At the end of each track the next item in the queue is loaded automatically.
- "Clear Queue" action to reset the list.

**Technical sketch:**  
Maintain an ordered array of song IDs in memory (and optionally persisted to `userPreferences` in IndexedDB). When the `ended` event fires on the `<audio>` element, pop the next ID from the queue and load it.

---

## 2. Shuffle & Repeat Modes

**Status:** Planned

**Description:**  
Shuffle and repeat controls in the Player tab complement the playback queue feature.

**Details:**
- **Shuffle** — randomise the playback order of the current queue/library view without altering the original list.
- **Repeat One** — loop the currently playing track indefinitely.
- **Repeat All** — restart from the beginning of the queue when the last track ends.
- Mode is shown via an icon/toggle button in the Player controls bar.

**Technical sketch:**  
Store the current mode (`none | shuffle | repeat-one | repeat-all`) in `userPreferences`. When `ended` fires, the next-track logic checks this flag to decide which song ID to load next. For shuffle, a Fisher–Yates shuffled copy of the current queue is created and consumed in order.

---

## 3. Keyboard Shortcuts

**Status:** Planned

**Description:**  
Control playback and navigate the panel without touching the mouse.

**Details:**

| Shortcut | Action |
|----------|--------|
| `Space` (when panel focused) | Play / Pause |
| `→` | Seek forward 10 s |
| `←` | Seek backward 10 s |
| `N` | Next track in queue |
| `P` | Previous track |
| `S` | Toggle shuffle |
| `R` | Cycle repeat mode |
| `Ctrl+B` (global) | Toggle the BetterSuno panel open/closed |

**Technical sketch:**  
Attach a `keydown` listener to `document` in `content.js`. Gate playback shortcuts behind a check that the focused element is not a text input. Dispatch `bettersuno:*` custom events so `downloader.js` can respond without circular references.

---

## 4. Recently Played History

**Status:** Planned

**Description:**  
A "History" sub-tab (inside Player or Library) that shows the last N songs played through the BetterSuno player, ordered by most-recently-played first.

**Details:**
- Up to 200 entries stored in `userPreferences` under the key `recentlyPlayed`.
- Each entry records song ID, title, cover URL, and timestamp.
- Clicking an entry in the history loads and plays that song immediately.
- "Clear History" button at the top of the list.

**Technical sketch:**  
Every time a new song starts playing in `downloader.js`, prepend its metadata to the history array and persist to IndexedDB. Deduplicate consecutive identical entries. The History view is rendered with the existing virtual-scroll / sentinel pattern already used in the song library.

---

## 5. Export Playlists & Library Backup

**Status:** Planned

**Description:**  
Let users export their song library or any playlist to a portable file format for archiving or sharing.

**Details:**
- **JSON export** — full metadata (title, lyrics, cover URL, audio URL, etc.) for every selected/filtered song.
- **M3U export** — standard playlist file pointing to the Suno audio URLs; playable in VLC and most media players.
- **CSV export** — spreadsheet-friendly format with columns for title, created date, like count, play count, etc.
- Import a previously exported JSON back into the local library to restore metadata (no audio file needed).

**Technical sketch:**  
A new "Export" button group below the download controls. Uses the browser `downloads` API already declared in `manifest.json` to write the generated file. Import reads the JSON file via `<input type="file">` and merges it into the IndexedDB `songsList` store.

---

## 6. Lyrics Karaoke / Highlight Mode

**Status:** Planned

**Description:**  
Synchronise the display of lyrics in the Player tab with the audio playback position so the current line is highlighted as the song plays.

**Details:**
- Lyrics are time-stamped by parsing the LRC format if available, or via a simple heuristic that distributes lines evenly across the song duration.
- The active lyric line scrolls into view automatically.
- A toggle ("Karaoke On/Off") in the Lyrics sub-tab enables or disables the highlighting.
- Works for songs cached locally (offline) and for streamed songs.

**Technical sketch:**  
Listen to the `timeupdate` event on the audio element. Map the current `currentTime` to a lyric line index using the pre-computed time stamps. Add/remove a CSS class `lyric-active` on the corresponding line element.

---

## 7. Statistics Dashboard

**Status:** Planned

**Description:**  
A "Stats" sub-tab (inside Settings or as a new top-level tab) that visualises aggregate data about the user's song library.

**Details:**
- Total songs, total play time, total likes received.
- Songs created per day/week/month bar chart.
- Top 10 most-liked songs.
- Distribution of public vs private tracks.
- Genre/style tag cloud (parsed from song metadata if available).
- Offline vs online song ratio.

**Technical sketch:**  
Query the `songsList` IndexedDB store once when the tab is opened. Compute statistics client-side and render lightweight SVG charts (no external library needed). Data refreshes when the library is re-fetched.

---

## 8. Advanced Search & Filtering

**Status:** Planned

**Description:**  
Extend the existing title search with richer filtering options.

**Details:**
- Full-text search in **lyrics** (not just title).
- Filter by **date range** (created after/before a date).
- Filter by **minimum like count**.
- Filter by **duration** (shorter than / longer than N minutes).
- **Sort options** — by creation date, title, like count, duration.
- Saved searches / filter presets stored in `userPreferences`.

**Technical sketch:**  
The existing `applyFilter()` function in `downloader.js` is extended to accept additional filter criteria. Lyrics search uses a simple `String.includes()` scan over the cached `lyrics` field; for large libraries a debounce prevents lag. Sort order is applied after filtering before the virtual-scroll render.

---

## 9. Batch Metadata Operations

**Status:** Planned

**Description:**  
Perform bulk edits on selected songs without navigating away from the library.

**Details:**
- **Bulk rename** — apply a title template (e.g. append a date or tag) to all selected songs.
- **Bulk tag / genre** — write a shared tag into local metadata.
- **Bulk privacy toggle** — flip public/private on a group of selected songs (calls the Suno API for each).
- **Bulk delete** — remove selected songs from the Suno library (with confirmation).

**Technical sketch:**  
Reuses the existing multi-select mechanism (`selectedSongIds`). Batch API operations are submitted sequentially with a small delay to avoid rate-limiting, using the retry helper already present in `downloader.js`. Progress is shown in the status bar.

---

## 10. Theme Customisation

**Status:** Planned

**Description:**  
Let users personalise the look of the BetterSuno panel.

**Details:**
- **Dark / Light mode** independent of the Suno page theme.
- **Accent colour picker** — choose the highlight/primary colour used for buttons and active states.
- **Panel opacity** — slider to make the panel semi-transparent when not in focus.
- **Font size** — small / medium / large presets for the panel text.
- Preferences saved to `userPreferences` in IndexedDB and applied on next load.

**Technical sketch:**  
A new "Appearance" section in the Settings tab. CSS custom properties (`--bs-accent`, `--bs-bg`, etc.) are already used throughout `content.css`; changing them via `document.documentElement.style.setProperty` at runtime applies the theme immediately. Saved values are re-applied in the `initDownloader` initialisation path.
