#!/usr/bin/env node
/**
 * Chrome Web Store "Verified CRX" publish flow.
 *
 * https://developer.chrome.com/docs/webstore/update#protect-package-updates
 *
 * 1. Packs dist/chrome into a CRX3 signed with your registered private key
 *    (google-chrome --pack-extension ... --pack-extension-key ...).
 * 2. Uploads the CRX to the Web Store API v2 upload endpoint with the headers
 *    required for verified CRX uploads, then publishes (submits for review).
 *
 * Run via `npm run publish:chrome` (builds first) or `npm run pack:chrome`
 * (build + sign only, for a manual dashboard upload).
 *
 * Credentials: env vars, or a KEY=VALUE file at ~/.cws-credentials.env:
 *   CWS_PUBLISHER_ID     Developer Dashboard -> Publisher -> Settings
 *   CWS_CLIENT_ID        OAuth client id (Chrome Web Store API scope)
 *   CWS_CLIENT_SECRET    OAuth client secret
 *   CWS_REFRESH_TOKEN    OAuth refresh token
 * Optional:
 *   CWS_EXTENSION_ID     default: eoonbcloadallnpkfgkpfkplgllchbeh
 *   CWS_CRX_KEY          default: ~/.firefox-private-key.pem
 *   CHROME_BIN           default: google-chrome
 *
 * Flags: --pack-only (skip upload), --no-publish (upload, don't submit)
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const credFile = process.env.CWS_CREDENTIALS_FILE || join(homedir(), '.cws-credentials.env');
if (existsSync(credFile)) {
  for (const line of readFileSync(credFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const packOnly = args.includes('--pack-only');
const noPublish = args.includes('--no-publish');

const root = resolve(process.cwd());
const distDir = join(root, 'dist', 'chrome');
const crxPath = join(root, 'dist', 'chrome.crx');
const keyPath = (process.env.CWS_CRX_KEY || join(homedir(), '.firefox-private-key.pem')).replace(/^~/, homedir());
const chromeBin = process.env.CHROME_BIN || 'google-chrome';
const extensionId = process.env.CWS_EXTENSION_ID || 'eoonbcloadallnpkfgkpfkplgllchbeh';

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

if (!existsSync(join(distDir, 'manifest.json'))) {
  fail('dist/chrome is not built — run `npm run build` first');
}
if (!existsSync(keyPath)) {
  fail(`private key not found at ${keyPath} (set CWS_CRX_KEY)`);
}
const version = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')).version;

console.log(`Packing Chrome CRX v${version} with ${keyPath}`);
execFileSync(chromeBin, [
  `--pack-extension=${distDir}`,
  `--pack-extension-key=${keyPath}`,
  '--no-message-box',
], { stdio: 'inherit' });

if (!existsSync(crxPath)) fail(`CRX was not created at ${crxPath}`);
console.log(`✔ ${crxPath} (${statSync(crxPath).size} bytes)`);

const publisherId = process.env.CWS_PUBLISHER_ID;
const clientId = process.env.CWS_CLIENT_ID;
const clientSecret = process.env.CWS_CLIENT_SECRET;
const refreshToken = process.env.CWS_REFRESH_TOKEN;

if (packOnly || !publisherId || !clientId || !clientSecret || !refreshToken) {
  console.log('');
  console.log('No Chrome Web Store API credentials (or --pack-only) — upload the CRX manually:');
  console.log('  Developer Dashboard → Package → Upload New Package');
  console.log('  Requires Verified CRX Uploads to be enabled and this key registered.');
  console.log('  For API upload set CWS_PUBLISHER_ID/CWS_CLIENT_ID/CWS_CLIENT_SECRET/CWS_REFRESH_TOKEN.');
  process.exit(0);
}

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }),
});
const tokenJson = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !tokenJson.access_token) {
  fail(`OAuth token refresh failed: ${JSON.stringify(tokenJson)}`);
}
const token = tokenJson.access_token;

const base = 'https://chromewebstore.googleapis.com';
console.log(`Uploading CRX for item ${extensionId}`);
const uploadRes = await fetch(`${base}/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Goog-Upload-Protocol': 'raw',
    'X-Goog-Upload-File-Name': `bettersuno-${version}.crx`,
    'Content-Type': 'application/octet-stream',
  },
  body: readFileSync(crxPath),
});
const uploadJson = await uploadRes.json().catch(() => ({}));
console.log(`Upload response (${uploadRes.status}): ${JSON.stringify(uploadJson)}`);
if (!uploadRes.ok) fail('Upload failed');
if (uploadJson.uploadState === 'FAILURE') fail(`Upload rejected: ${JSON.stringify(uploadJson)}`);

if (noPublish) {
  console.log('--no-publish set — stopping before submit.');
  process.exit(0);
}

console.log('Submitting for review');
const publishRes = await fetch(`${base}/v2/publishers/${publisherId}/items/${extensionId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const publishJson = await publishRes.json().catch(() => ({}));
console.log(`Publish response (${publishRes.status}): ${JSON.stringify(publishJson)}`);
if (!publishRes.ok) fail('Publish failed');
console.log('✔ Submitted. Check the Developer Dashboard for review status.');
