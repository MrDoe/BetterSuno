# BetterSuno

Enhance your Suno.com experience with real-time notifications and powerful song management tools.

## Features

### 🧭 Updated Panel UI
- **Top-left bell launcher** - BetterSuno now opens from a fixed bell in the top-left corner
- **Song Library first** - The Song Library tab is the default first tab, with Notifications as the second tab
- **Download controls near action button** - M4A/WAV + music/lyrics/image options are grouped right next to the Download button

### 🔔 Notifications
- **Live updates** - See your latest Suno notifications in real-time without grouping of similar events
- **Desktop alerts** - Get notified when someone likes or comments on your songs

### 🎵 Song Library & Batch Download
- **Browse your library** - View all your Suno creations in one place
- **Bulk downloads** - Download multiple own songs at once in M4A or WAV format
- **Complete packages** - Include lyrics and cover images with downloads of your own songs
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
- **Android Firefox keepalive** - Experimental opt-in silent media session to reduce MIUI/HyperOS tab reloads on Firefox for Android
- **Library actions** - Refetch library, stop fetch, or delete local library

### 🤖 MCP Server (AI Agent Integration)
- **47 tools** - Expose Suno's full API to AI agents (opencode, Claude Desktop, etc.) via the Model Context Protocol
- **Direct API calls** - The MCP server calls Suno's API directly using the extension's auth token
- **WebSocket bridge** - Extension shares Clerk token with the MCP server over `ws://localhost:9423`
- **Full feature coverage** - Song creation, covering, remastering, personas, uploads, downloads, playlists, workspaces, and more

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
5. **Choose download options** (M4A/WAV, music/lyrics/image) next to the Download button. File downloads are limited to songs you own; tracks by other artists can still be saved to the local DB for offline playback.
6. **Use the mini player** to play songs, seek by clicking the progress bar, and auto-advance through the list
7. **Switch to Notifications** for live activity updates, or **Settings** for polling/storage controls

## Building from Source

```bash
npm run build
```

This creates browser-specific builds in `dist/chrome/` and `dist/firefox/`.

## MCP Server

BetterSuno includes a standalone MCP (Model Context Protocol) server that exposes Suno's features to AI agents like opencode, Claude Desktop, or any MCP-compatible client.

### Quick Start

```bash
# 1. Install dependencies
cd mcp-server && npm install && cd ..

# 2. Start the MCP server
node mcp-server/src/index.js

# 3. Make sure the BetterSuno extension is loaded with a Suno tab open
#    The extension auto-connects to ws://localhost:9423 and shares the auth token
```

### Register with OpenCode

Add the following to `.opencode/opencode.json` in your project root:

```json
{
  "mcp": {
    "bettersuno": {
      "type": "local",
      "command": ["node", "mcp-server/src/index.js"],
      "enabled": true
    }
  }
}
```

### Register with Codex (OpenAI)

Add the following to `~/.codex/config.json` (or your project's `.codex/config.json`):

```json
{
  "mcpServers": {
    "bettersuno": {
      "command": "node",
      "args": ["mcp-server/src/index.js"]
    }
  }
}
```

### Register with Claude Desktop

Add the following to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bettersuno": {
      "command": "node",
      "args": ["/absolute/path/to/BetterSuno/mcp-server/src/index.js"]
    }
  }
}
```

### How It Works

```
AI Client ←stdio→ MCP Server ←ws://localhost:9423→ BetterSuno Extension → Suno API
                         ↓
                    Direct API calls (with shared token)
```

1. The **extension** acquires a Clerk auth token (via Suno.com tab) and pushes it to the MCP server over WebSocket
2. The **MCP server** receives the token and makes direct HTTP calls to `studio-api.prod.suno.com`
3. The **AI client** (opencode, Claude) calls MCP tools which translate to Suno API requests

The extension pushes the token on connect and on every 45-minute refresh. If Suno requires a captcha challenge, the MCP server requests a Turnstile solve from the extension over WebSocket.

### Prerequisites

- BetterSuno extension loaded in Chrome or Firefox
- At least one Suno.com tab open and logged in (for auth)
- Node.js 18+ (for the MCP server)

### Tool Overview (47 tools)

| Module | Tools |
|--------|-------|
| **Generation** | `create_song`, `inspire_song`, `cover_song`, `extend_song`, `remaster_song`, `make_stems`, `get_recommended_styles`, `upsample_tags` |
| **Library** | `list_library`, `get_song`, `get_songs_by_ids`, `search_songs`, `search_users`, `get_profile`, `get_current_user`, `get_user_session` |
| **Downloads** | `get_song_urls`, `download_song`, `download_lyrics`, `download_cover_image` |
| **Personas** | `create_persona`, `list_personas`, `get_persona`, `list_followed_personas`, `list_loved_personas`, `toggle_love_persona` |
| **Uploads** | `upload_audio`, `upload_image`, `upload_video` |
| **Playlists** | `list_playlists`, `create_playlist`, `get_playlist`, `add_to_playlist`, `remove_from_playlist`, `reorder_playlist`, `delete_playlist`, `update_playlist_metadata` |
| **Workspaces** | `list_projects`, `get_project`, `get_project_clips` |
| **Metadata** | `delete_song`, `trash_song`, `set_visibility`, `like_song`, `update_song_metadata`, `generate_video`, `create_custom_model` |

See [mcp-server/API.md](mcp-server/API.md) for full parameter references and examples.

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MCP_WS_PORT` | `9423` | WebSocket port the MCP server listens on |
| `MCP_API_BASE_URL` | `https://studio-api.prod.suno.com` | Suno API base URL |

## Support

If you encounter issues:
- Refresh the Suno.com page
- Reload the extension in your browser's extension manager
- Make sure you're logged in to Suno.com
- On Firefox for Android, the experimental keepalive setting shows an Android media notification and may use more battery

For bugs or feature requests, please open an issue on GitHub.

## Privacy

BetterSuno operates entirely locally in your browser. No data is collected or transmitted to third parties. The extension only communicates with Suno's official APIs using your existing session.

## Disclaimer

This project is an independent enhancement for Suno users and is not affiliated with or endorsed by Suno.
We respect Suno's terms of service and do not engage in any unauthorized access, downloading, or distribution of copyrighted content. 
The extension is designed to work with the public APIs and interfaces provided by Suno and operates within the permissions granted by the user. 
Users are responsible for ensuring their use of the extension complies with Suno's terms of service and applicable laws.
Use this extension at your own risk. The developers are not liable for any issues arising from its use.
