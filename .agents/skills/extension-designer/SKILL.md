---
name: extension-designer
description: >-
  Design the architecture for Chrome and Firefox browser extensions end-to-end.
  Use when planning a new extension, choosing between MV3 manifest designs,
  deciding background execution models (service worker vs persistent), designing
  cross-context communication (content scripts, background, popup), selecting
  storage strategies (chrome.storage, IndexedDB), or resolving Chrome vs Firefox
  compatibility differences. Covers architecture decisions, not implementation
  details.
risk: unknown
source: community
---

# Extension Designer

Design the architecture of a browser extension for Chrome, Firefox, or both — covering manifest structure, background execution model, content script strategy, cross-context communication, storage, auth, build system, and cross-browser differences. Focuses on architectural decisions; defers implementation details to `browser-extension-builder` or `chrome-extension-developer`.

## Inputs to collect

Before starting, resolve:

- **Target browsers**: Chrome only, Firefox only, or cross-browser.
- **Core behavior**: What does the extension do on the page? Modify DOM, inject a panel, extract data, automate actions, provide a popup, intercept network requests?
- **Auth requirement**: Does it need user authentication? If so, what provider?
- **Persistence**: What data must survive browser restarts? Settings? Cached API responses? Audio/image blobs?
- **Offline**: Must any features work without network?

If any input is ambiguous, ask one direct question. Otherwise state assumptions and proceed.

## Design workflow

### 1. Extension architecture: pick the shape

Map the core behavior to one of these patterns:

| Pattern | When | Manifest signals |
|---------|------|-----------------|
| **Content modifier** | Alter page content, hide elements, restyle | `content_scripts` only |
| **Injected panel** | Add a sidebar, floating panel, or overlay to a specific site | `content_scripts` injects DOM |
| **Popup tool** | Quick action on click, configuration | `action.default_popup` |
| **Background processor** | Poll APIs, schedule tasks, process data | `background.service_worker` |
| **Devtools extension** | Add panels to Chrome DevTools | `devtools_page` |
| **Omnibox / context menu** | New tab page override, right-click actions | `chrome_url_overrides`, `contextMenus` |

Most real extensions combine multiple patterns. Identify the primary and secondary patterns.

### 2. Manifest design

Always target **Manifest V3**. Manifest V2 is rejected by Chrome Web Store.

**Cross-browser manifest** — when targeting both Chrome and Firefox, structure the manifest for the build system to transform:

```json
{
  "manifest_version": 3,
  "name": "...",
  "version": "...",
  "permissions": ["storage"],
  "host_permissions": ["https://target-site.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [{
    "matches": ["https://target-site.com/*"],
    "js": ["content.js"],
    "css": ["content.css"]
  }],
  "action": {
    "default_popup": "popup.html"
  }
}
```

**Chrome vs Firefox manifest differences**:

| Field | Chrome | Firefox |
|-------|--------|---------|
| `background` | `service_worker` (JS file) | `scripts` array (persistent) or `service_worker` |
| `browser_specific_settings` | Not used | Required: `gecko.id`, `gecko.strict_min_version` |
| `host_permissions` | Required for host access | Optional; `permissions` with match patterns also works |
| `offscreen` permission | Supported | Not supported; remove from Firefox manifest |
| `world: "MAIN"` in scripting | Supported | Not supported; use `wrappedJSObject` |

**Decision**: If cross-browser, use a build script that mutates the manifest per target. Keep one canonical manifest and transform at build time. Strip Chrome-only permissions (`offscreen`) from the Firefox output and add `browser_specific_settings`.

### 3. Background execution model

The background script handles long-lived tasks: auth, polling, message routing, alarms.

| Model | When to use | Chrome | Firefox |
|-------|-------------|--------|---------|
| **Service worker** | Ephemeral, event-driven, wakes on message/alarm | Default (MV3) | Supported (MV3) |
| **Persistent background** | Long-running polling, WebSocket, state that must survive | Not available (MV3) | Default when using `background.scripts` |

**Service worker constraints** (Chrome):
- Killed after ~30s inactivity. Do not rely on global state.
- Use `chrome.alarms` for periodic work, not `setInterval`.
- Use `chrome.storage.session` for in-memory data that survives short restarts.
- For long polling, use an **offscreen document** (`offscreen.js`) that holds a live connection.

**Firefox persistent background**:
- Stays alive as long as the browser runs (or until unloaded).
- Can use `setInterval` directly.
- No offscreen document needed; poll inline.

**Decision tree**:
- Periodic API polling (every N minutes) → **service worker with `chrome.alarms`** (both browsers).
- Continuous polling / WebSocket → **offscreen document** (Chrome), **persistent background** (Firefox).
- Message-passing hub only → **service worker** (both browsers, simplest).

### 4. Content script architecture

Content scripts run in the page context but in an isolated JavaScript world. They have DOM access but not access to the page's JS variables.

**Key decisions**:

| Decision | Options | Guidance |
|----------|---------|----------|
| **Injection method** | Static (`content_scripts` in manifest) vs dynamic (`scripting.executeScript`) | Static for always-on pages; dynamic for conditional or user-triggered |
| **World** | `ISOLATED` (default) vs `MAIN` | Use `MAIN` only when you must access page JS objects (e.g., `window.Clerk`); otherwise stay isolated |
| **Multiple scripts** | Single content script vs multiple coordinated scripts | Split when responsibilities differ (e.g., `content.js` for UI, `content-fetcher.js` for API calls in MAIN world) |
| **CSS injection** | `content_scripts.css` vs injected `<style>` | Use static CSS for always-on styling; inject styles for dynamic themes |

**Communication from content script**:
- To background: `chrome.runtime.sendMessage`
- From background: `chrome.tabs.sendMessage`
- To other content scripts: route through background (background proxies)
- To page scripts (MAIN world): `window.postMessage` / custom DOM events

**Firefox note**: `world: "MAIN"` in `scripting.executeScript` is not supported. Use `wrappedJSObject` to access page objects from content scripts instead.

### 5. Cross-context communication

Every extension with more than one context needs a communication plan:

```
Popup ──→ Background (Service Worker) ──→ Content Script
  │                │                          │
  └────────────────┼──────────────────────────┘
                   ↓
            chrome.storage
```

**Patterns**:

| Pattern | Use for | Example |
|---------|---------|---------|
| **Message passing** | Request-response between contexts | Popup asks background for auth token |
| **Storage as bus** | One context writes, another watches `onChanged` | Content script writes form data; popup reads it |
| **Custom events** | Content script → page script (MAIN world) | Page script detects extension and sends data via `window.postMessage` |
| **Background as proxy** | Content script A → Content script B | Both talk to background; background forwards |

**Always**: return `true` from `onMessage` listeners when sending async responses. Without it, the message port closes before `sendResponse` executes.

### 6. Storage strategy

Select storage backend by data type:

| Data | Backend | Capacity | Syncs across devices |
|------|---------|----------|---------------------|
| Settings, preferences | `chrome.storage.sync` | 100KB total | Yes |
| Cached API responses, user data | `chrome.storage.local` | 5MB (unlimited with `unlimitedStorage`) | No |
| Large structured data (song libraries, blobs) | **IndexedDB** | ~80% of disk | No |
| Audio, images, video | **IndexedDB** (blobs) or `chrome.storage.local` (base64) | IndexedDB preferred for blobs | No |
| Ephemeral session data | `chrome.storage.session` | 10MB | No |

**IndexedDB** is available in both background and content script contexts. They are separate databases — do not share a single DB across contexts. Use distinct DB names or coordinate through the background.

**Storage coordination**: When both background and content scripts need the same data, pick one as the **source of truth** (usually background) and have other contexts request data via messages.

### 7. Auth model

Choose the auth approach based on what the target website already uses:

| Scenario | Approach |
|----------|----------|
| Extension for a site that has its own auth (e.g., Suno, GitHub) | Extract tokens from the live page via MAIN-world content script |
| Standalone extension with its own users | OAuth flow in a popup/tab, store tokens in `chrome.storage.local` |
| API-key based service | Store API key in `chrome.storage.local`, send in headers |

**Token extraction pattern** (for site-specific extensions):
1. Inject a script into the MAIN world via `scripting.executeScript({ world: 'MAIN' })`.
2. The MAIN-world script reads `window.Clerk.session.getToken()` or similar.
3. The MAIN-world script posts the token back via `window.postMessage` or `chrome.runtime.sendMessage`.
4. Background caches the token and sets up a refresh alarm.

**Token refresh**: Use `chrome.alarms.create('tokenRefresh', { periodInMinutes: 45 })` to refresh before expiry. Never let the token expire without a refresh; service workers may not wake in time for a last-second refresh.

### 8. Build system

For cross-browser extensions, use a build script that produces separate directories:

```
dist/
├── chrome/
│   ├── manifest.json    (with service_worker, offscreen permission)
│   ├── background.js
│   └── ...
└── firefox/
    ├── manifest.json    (with background.scripts, browser_specific_settings)
    ├── background.js
    └── ...
```

**Build script responsibilities**:
1. Start from a canonical manifest template.
2. For Chrome output: ensure `background.service_worker`, add `offscreen` permission, strip `browser_specific_settings`.
3. For Firefox output: convert to `background.scripts` if persistent background is needed, add `browser_specific_settings.gecko`, strip `offscreen`.
4. Copy shared files.
5. Optionally run browser-specific code transforms (replace `chrome.*` with `browser.*` for Firefox if using the `browser` polyfill).

**Module system**: Service workers support ES modules (`"type": "module"` in manifest for Chrome). Firefox persistent backgrounds also support ES modules with `"type": "module"`. Content scripts are typically IIFE unless loaded as modules.

### 9. Permission design

Apply the principle of least privilege:

| Principle | Practice |
|-----------|----------|
| **Minimal host permissions** | Use `https://specific-site.com/*` not `<all_urls>` |
| **Optional permissions** | Request broad permissions (notifications, downloads) at runtime with `chrome.permissions.request` |
| **ActiveTab over tabs** | Use `activeTab` when the extension only needs the current tab after user gesture |
| **No unnecessary permissions** | Every permission in the manifest will be reviewed by the store; each must be justified |

**Store review considerations**:
- Chrome Web Store: Host permissions trigger a longer review. `<all_urls>` requires written justification.
- Firefox Add-ons (AMO): Generally faster review; same permission scrutiny applies.

## Output contract

After working through the workflow, produce a design summary covering:

1. **Architecture pattern** (primary + secondary).
2. **Manifest design** — key fields and cross-browser differences.
3. **Background model** — service worker, persistent, or offscreen document; polling strategy.
4. **Content script plan** — how many scripts, which worlds, injection method, communication pattern.
5. **Cross-context communication** — message routing table.
6. **Storage design** — which backends for which data, source of truth.
7. **Auth model** — token source, refresh strategy.
8. **Build system** — single or cross-browser, manifest transforms.
9. **Permission list** — minimal set with justification.
10. **Chrome vs Firefox differences** — enumerated with resolution strategy.

## Validation checks

Before finalizing the design, verify:

- [ ] Manifest is MV3 (not V2).
- [ ] Service worker does not rely on global state surviving restarts.
- [ ] No `setInterval` in service worker; uses `chrome.alarms` instead.
- [ ] `chrome.runtime.onMessage` listeners return `true` for async `sendResponse`.
- [ ] Permissions are minimal; `<all_urls>` is justified if present.
- [ ] Cross-browser differences are enumerated and resolved (build transforms or runtime checks).
- [ ] Storage backends match data size and type (blobs in IndexedDB, not `chrome.storage`).
- [ ] Auth token refresh is scheduled before expiry.
- [ ] No `eval()`, `innerHTML` with unsanitized input, or `document.write` in content scripts.

## When to Use

- User mentions or implies: design browser extension, plan extension, extension architecture
- User mentions or implies: chrome extension design, firefox addon design, cross-browser extension
- User mentions or implies: manifest v3, extension manifest, content script architecture
- User mentions or implies: extension background script, service worker extension
- User asks about extension storage, extension auth, extension communication patterns

## Limitations

- This skill covers architectural design decisions, not implementation code. For implementation, use `browser-extension-builder` or `chrome-extension-developer`.
- Assumes Manifest V3. For V2 migration guidance, delegate to `chrome-extension-developer`.
- Does not cover Safari extensions or Edge-specific APIs.
- Does not cover extension monetization or store publishing; use `browser-extension-builder` for those.
- Stop and ask for clarification if required inputs, permissions, safety boundaries, or success criteria are missing.
