// lib/panel-launch.js — pure helpers for the browser-action (toolbar) launcher.
//
// The toolbar icon is a second way to open the in-page panel. content.js owns
// the DOM; background.js only has to decide whether the clicked tab is a page
// where the content script can exist, and what message asks it to show the
// panel. Both rules are pure, so they live here and are covered by node:test —
// background.js itself cannot be imported by the test runner.

/** Runtime message that asks content.js to show the panel. */
export const SHOW_PANEL_MESSAGE = 'bettersunoShowPanel';

/**
 * True when `url` is a Suno web page (the only place the content script runs).
 *
 * Subdomains are accepted: the manifest's host permissions include
 * `https://*.suno.com/*`, and a sendMessage to a tab without a content script
 * simply rejects and is ignored. What matters is that a lookalike host such as
 * `suno.com.evil.example` or `evil-suno.com` is not accepted, and that only
 * https pages are.
 */
export function isSunoUrl(url) {
  if (typeof url !== 'string' || url === '') return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  return host === 'suno.com' || host.endsWith('.suno.com');
}
