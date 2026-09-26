# Privacy and Permission Justifications

BetterSuno takes privacy seriously. The extension requests a small set of permissions strictly to provide the features described below. No personal data is collected or transmitted by the extension unless explicitly required by the user (for example, downloading a song file). All network requests are limited to the official Suno domains and the localhost MCP server. Below is a detailed explanation of each permission and its purpose.

## Requested Permissions

- `cookies` –
  Used to read Suno’s `__session` cookie. The extension first uses the live page-context Clerk client when available and validates the cookie as a bearer-token fallback when that client is absent. The cookie is never sent to any party other than Suno’s own API.

- `alarms` –
  Employed to schedule periodic checks for new tracks or message updates so that desktop notifications can be delivered in a timely manner. Alarms run locally and no data leaves the user's machine.

- `scripting` –
  Allows injected scripts (`content.js` and `downloader.js`) to interact with the Suno web page to enable features like the download button and to gather information for notifications. Scripts are executed only on `https://suno.com/*` as defined in host permissions.

- `tabs` –
  Used to enumerate Suno tabs, activate a reachable page, and reload a discarded/frozen tab when refreshing authentication. We do not track or inspect tab contents beyond what is required for these actions.

- `offscreen` –
  Chrome/MV3-only. Enables a lightweight extension-owned document to poll notifications while the service worker may otherwise be suspended. Firefox uses its persistent background page and does not request or use this permission.

- `storage` –
  Stores user preferences (such as notification settings) and local caches used to avoid unnecessary network requests. A short-lived Suno/Clerk bearer token is kept in browser-session-scoped extension storage so a Chrome service-worker restart does not discard it; it is not exposed to page scripts or content-script message handlers.

- `notifications` –
  Necessary to display desktop notifications about new tracks, completed downloads, or other user-visible events. No notification content is sent outside the extension.

- `downloads` –
  Used to save audio files when the user chooses to download a song. The extension only accesses downloads that it initiates and does not monitor or modify other files on the system.


## Host Permissions

The extension requires access to the following domains to function:

- `https://suno.com/*` – Core Suno site where audio playback occurs and where content scripts run.
- `https://clerk.suno.com/*` – Authentication and session management endpoints used when logging in.
- `https://api.suno.com/*` and `https://studio-api.prod.suno.com/*` – APIs used to check for new releases and to fetch data needed for notifications or the download feature.
- `http://localhost:3000/*` – Localhost MCP server used for development and testing purposes. All requests to this server are local and do not leave the user's machine.

All network requests are restricted to these hosts and nothing else. We do not collect, share, or store any personal data from these requests.

## Data Collection

This extension does not collect any personal data. The `browser_specific_settings` section explicitly marks the extension as exempt from data collection. No telemetry or analytics are present.

## Contact

If you have any privacy concerns or questions about the permissions, please open an issue on the [GitHub repository](https://github.com/MrDoe/SunoNotifications) or contact the maintainer directly.

---

*Last updated: September 23, 2026*