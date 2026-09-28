# Privacy and Permission Justifications

BetterSuno takes privacy seriously. The extension requests a small set of permissions strictly to provide the features described below. No personal data is collected or transmitted by the extension unless explicitly required by the user (for example, downloading a song file). All network requests are limited to the official Suno domains and the localhost MCP server. Below is a detailed explanation of each permission and its purpose.

## Requested Permissions

- `cookies` –
  Used to read Suno's `__session` cookie, which is the extension's bearer
  credential. Suno no longer exposes a Clerk browser SDK on authenticated
  routes, so in practice the cookie is the credential source; a page-context
  Clerk client is still consulted first if a future Suno build exposes one
  again. Candidate cookies are validated server-side against
  `GET /api/notification/v2` before being accepted, and only then cached. The
  cookie is never sent to any party other than Suno's own API, and the raw
  bearer is never returned to a content script or the offscreen document.

- `alarms` –
  Employed to schedule periodic checks for new tracks or message updates so that desktop notifications can be delivered in a timely manner. Alarms run locally and no data leaves the user's machine.

- `scripting` –
  Allows injected scripts (`content.js` and `downloader.js`) to interact with the Suno web page to enable features like the download button and to gather information for notifications. Scripts are executed only on `https://suno.com/*` as defined in host permissions.

- `tabs` –
  Used to enumerate Suno tabs, activate a reachable page, and reload a discarded/frozen tab when refreshing authentication. We do not track or inspect tab contents beyond what is required for these actions.

- `storage` –
  Stores user preferences (such as notification settings) and local caches used to avoid unnecessary network requests. A short-lived Suno/Clerk bearer token is kept in browser-session-scoped extension storage so a Chrome service-worker restart does not discard it; it is not exposed to page scripts or content-script message handlers.

- `notifications` –
  Necessary to display desktop notifications about new tracks, completed downloads, or other user-visible events. No notification content is sent outside the extension.

- `downloads` –
  Used to save audio files when the user chooses to download a song. The extension only accesses downloads that it initiates and does not monitor or modify other files on the system.

### Not a permission

- **Offscreen document** – Chrome builds ship `offscreen.html`/`offscreen.js`, a
  lightweight extension-owned document used to poll notifications while the
  service worker may otherwise be suspended. The MV3 offscreen API requires no
  permission declaration and `offscreen` does not appear in the `permissions`
  array. Firefox uses a persistent background page and does not use it at all.


## Host Permissions

The extension requires access to the following domains to function:

The list below mirrors `host_permissions` in `manifest.json` exactly. A test
(`tests/repo-hygiene.test.js`) fails the build if the two drift apart, because
this document is part of the store listing.

- `https://suno.com/*` – Core Suno site where audio playback occurs and where content scripts run.
- `https://*.suno.com/*` – Other Suno subdomains (audio, asset and API hosts).
- `https://*.suno.ai/*` – Suno API and asset hosts referenced by the web app.
- `https://*.cloudfront.net/*` – CDN that serves Suno's audio and image assets.
- `https://studio-api.prod.suno.com/*` – Primary Suno API: library, playlists, generation, notifications, and download URLs.
- `http://localhost/*` and `ws://localhost/*` – Local-only. Used by the optional
  MCP server bridge (`bettersuno-mcp`, default `ws://127.0.0.1:9423`), which lets a
  local AI agent drive the extension. These requests never leave the machine, and
  the extension does not contact any remote MCP host.

All network requests are restricted to these hosts and nothing else. We do not collect, share, or store any personal data from these requests.

## Data Collection

This extension does not collect any personal data. The `browser_specific_settings` section explicitly marks the extension as exempt from data collection. No telemetry or analytics are present.

## Contact

If you have any privacy concerns or questions about the permissions, please open an issue on the [GitHub repository](https://github.com/MrDoe/SunoNotifications) or contact the maintainer directly.

---

*Last updated: September 28, 2026*