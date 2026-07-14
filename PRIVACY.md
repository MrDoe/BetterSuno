# Privacy and Permission Justifications

BetterSuno takes privacy seriously. The extension requests a small set of permissions strictly to provide the features described below. No personal data is collected or transmitted by the extension unless explicitly required by the user (for example, downloading a song file). All network requests are limited to the official Suno domains and the localhost MCP server. Below is a detailed explanation of each permission and its purpose.

## Requested Permissions

- `cookies` –
  Used to read the minimal session information required to determine if the user is logged in to Suno and to ensure notifications and downloads work in the correct context. We never read or transmit cookies to third parties.

- `alarms` –
  Employed to schedule periodic checks for new tracks or message updates so that desktop notifications can be delivered in a timely manner. Alarms run locally and no data leaves the user's machine.

- `scripting` –
  Allows injected scripts (`content.js` and `downloader.js`) to interact with the Suno web page to enable features like the download button and to gather information for notifications. Scripts are executed only on `https://suno.com/*` as defined in host permissions.

- `tabs` –
  Used when opening new windows or tabs (for example when the user clicks a download link or when we need to redirect to a login page). We do not track or inspect tab contents beyond what is required for these actions.

- `offscreen` –
  Enables the extension to run service worker tasks (like downloading files and generating notifications) when no browser window is open. All processing happens locally.

- `storage` –
  Stores user preferences (such as notification settings) and a small cache of recent tracks to avoid unnecessary network requests. Stored data is solely for the user's convenience and is not shared.

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

*Last updated: July 14, 2026*