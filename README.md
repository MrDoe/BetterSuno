# BetterSuno

Enhance your Suno.com experience with real-time notifications and powerful song management tools.

## Features

### 🧭 Updated Panel UI
- **Top-left bell launcher** - BetterSuno now opens from a fixed bell in the top-left corner
- **Song Library first** - The Song Library tab is the default first tab, with Notifications as the second tab
- **Download controls near action button** - MP3/WAV + music/lyrics/image options are grouped right next to the Download button

### 🔔 Notifications
- **Live updates** - See your latest Suno notifications in real-time without grouping of similar events
- **Desktop alerts** - Get notified when someone likes or comments on your songs

### 🎵 Song Library & Batch Download
- **Browse your library** - View all your Suno creations in one place
- **Bulk downloads** - Download multiple songs at once in MP3 or WAV format
- **Complete packages** - Include lyrics and cover images with your downloads
- **Smart filtering** - Filter by liked songs, stems, public/private, offline-only, or search by title
- **Playlist picker** - Load your Suno playlists into a dropdown and view playlist tracks directly
- **Playlist persistence** - Playlists and playlist songs are cached in the browser database for faster reopen

### 💾 Offline Database
- **Local song cache** - Persist your library in IndexedDB
- **Save to DB** - Cache selected songs for offline playback
- **Offline-only filter** - Show only tracks that are stored locally
- **Delete from DB** - Remove selected cached tracks from local storage
- **Usage display** - See local DB usage in Settings

### ▶️ Mini Player
- **Inline playback** - Play songs directly from the Song Library
- **Auto-next playback** - Automatically plays the next visible song when one ends
- **Seek support** - Click the progress bar to jump to any position in a track
- **Current/total time display** - Shows live playback position and full duration

### ⚙️ Settings
- **Customizable polling** - Choose how often to check for new notifications
- **Desktop notifications toggle** - Enable/disable desktop alerts
- **Library actions** - Refresh library, stop fetch, or delete local library

## Installation

### Chrome / Edge / Brave
1. Download and extract this extension
2. Open `chrome://extensions` in your browser
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `dist/chrome/` folder
5. Visit [suno.com](https://suno.com) and look for the notification bell icon

### Firefox
1. Download and extract this extension
2. Open `about:debugging#/runtime/this-firefox` in Firefox
3. Click **Load Temporary Add-on**
4. Select the `manifest.json` file from the `dist/firefox/` folder
5. Visit [suno.com](https://suno.com) and look for the notification bell icon

## How to Use

1. **Open Suno.com** and log in to your account
2. **Click the bell icon** in the top-left corner to open the panel
3. **Use Song Library** (default tab) to load, filter, play, cache, and download tracks
4. **Select a playlist** from the Playlist dropdown (optional) to load playlist tracks
5. **Choose download options** (MP3/WAV, music/lyrics/image) next to the Download button
6. **Use the mini player** to play songs, seek by clicking the progress bar, and auto-advance through the list
7. **Switch to Notifications** for live activity updates, or **Settings** for polling/storage controls

## Building from Source

```bash
npm run build
```

This creates browser-specific builds in `dist/chrome/` and `dist/firefox/`.

## Support

If you encounter issues:
- Refresh the Suno.com page
- Reload the extension in your browser's extension manager
- Make sure you're logged in to Suno.com

For bugs or feature requests, please open an issue on GitHub.

## Privacy

BetterSuno operates entirely locally in your browser. No data is collected or transmitted to third parties. The extension only communicates with Suno's official APIs using your existing session.

## Disclaimer

This project is an independent enhancement for Suno users and is not affiliated with or endorsed by Suno.
We respect Suno's terms of service and do not engage in any unauthorized access, downloading, or distribution of copyrighted content. 
The extension is designed to work with the public APIs and interfaces provided by Suno and operates within the permissions granted by the user. 
Users are responsible for ensuring their use of the extension complies with Suno's terms of service and applicable laws.
Use this extension at your own risk. The developers are not liable for any issues arising from its use.
