# BetterSuno

BetterSuno is a Chrome/Chromium extension that enhances the Suno.com experience with:

- In-page floating notification bell and panel
- Live notification updates and desktop notifications
- Song library fetching from Suno
- Bulk download support (MP3/WAV, lyrics, and images)
- Filtering, selection, and persistent local state

## Features

- Notifications tab
- Shows latest notifications from Suno in a floating panel
- Badge count for unseen notifications
- Optional desktop notifications

- Download Songs tab
- Fetch songs from your Suno account
- Filter by text, liked, stems, and public/private
- Default sort by date (newest first)
- Bulk download selected songs
- Download options:
  - Music (`mp3` or `wav`)
  - Lyrics
  - Cover image

- Settings tab
- Polling interval configuration
- Desktop notification toggle
- Download folder preference
- Manual "Fetch Songs" action
- **Stop Fetch** button in Settings (warns that song list may be incomplete if stopped early)

## Installation (Developer Mode)

1. Open your browser and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/home/christoph/Downloads/BetterSunoications`
5. Open `https://suno.com` and log in.

The extension injects its UI directly into Suno pages.

## Project Structure

- `manifest.json` - Extension manifest (MV3)
- `background.js` - Service worker, state, notifications, fetch/download orchestration
- `content.js` - Floating bell/panel and settings/notifications UI
- `downloader.js` - Song list, filtering, sorting, and download actions
- `content-fetcher.js` - In-page fetch helper logic
- `content.css` - Injected UI styles
- `idb-store.js` - IndexedDB storage helpers
- `offscreen.html`, `offscreen.js` - Offscreen document support
- `icons/` - Extension icons

## Permissions Used

From `manifest.json`:

- `cookies` - Access auth/session cookies needed for Suno API flow
- `alarms` - Scheduled polling
- `scripting` - Injecting/communicating with page context
- `tabs` - Tab targeting and active tab checks
- `offscreen` - Offscreen document support
- `storage` - Persistent extension state
- `notifications` - Desktop notifications
- `downloads` - File download handling

Host permissions:

- `https://suno.com/*`
- `https://clerk.suno.com/*`
- `https://api.suno.com/*`
- `https://studio-api.prod.suno.com/*`

## Development Notes

- Manifest version: `3`
- Extension version: `2.0.0`
- Main UI is content-script based and runs on Suno pages.

## Troubleshooting

- "Could not establish connection. Receiving end does not exist."
  - Reload the extension in `chrome://extensions`
  - Refresh Suno tabs
  - Ensure Suno is open and you are logged in

- Song fetch fails
  - Ensure `https://suno.com` is open in an active tab
  - Confirm your session is valid (log out/in if needed)

## Disclaimer

This project is an independent enhancement for Suno users and is not affiliated with or endorsed by Suno.
