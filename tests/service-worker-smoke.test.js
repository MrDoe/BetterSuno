// tests/service-worker-smoke.test.js
//
// Loads background.js with a stubbed `chrome` to prove the module graph actually
// resolves at runtime.
//
// This is the check that would have caught a bad extraction. `node --check` only
// validates syntax, so an import of a name that no longer exists, or a missing
// lib/ file, still "passes" — the service worker only breaks when Chrome evaluates
// it. A real import is the only thing that proves the wiring.
//
// Expected non-fatal noise: indexedDB is absent in Node, so IDBStore calls log
// ReferenceError: indexedDB is not defined. Those are caught and logged by the
// extension's own error handling, and are unrelated to module resolution. What
// matters is that we reach "module graph resolved" with no ReferenceError naming a
// missing binding.

import test from 'node:test';
import assert from 'node:assert/strict';

const STUB = `
const registered = [];
const handler = new Proxy({}, { get: () => (fn) => fn });
const chrome = new Proxy({
  runtime: {
    id: 'testext',
    onMessage: { addListener: (f) => registered.push(f) },
    getManifest: () => ({ version: '0.0.0-test' }),
    sendMessage: async () => {},
    getURL: (p) => p,
    lastError: null,
    connect: () => ({
      onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}
    })
  },
  storage: { session: { get: async () => ({}), set: async () => {} },
             local:  { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [], get: async () => null, update: async () => {},
          onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  notifications: { create() {}, clear() {},
                   onClicked: { addListener() {} }, onClosed: { addListener() {} } },
  cookies: { get: async () => null },
  action: { onClicked: { addListener() {} } },
  downloads: { download() {}, onChanged: { addListener() {} } },
  permissions: { contains: async () => false },
  i18n: { getMessage: (k) => k },
  contextMenus: { create() {} },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
}, { get: (t, p) => (p in t ? t[p] : handler) });

globalThis.chrome = chrome;
globalThis.self = globalThis;

export const loadBackground = async (url) => {
  await import(url);
  return registered;
};
`;

test('background.js module graph resolves against a stubbed chrome', async (t) => {
  const stubUrl = new URL('./.chrome-stub.mjs', import.meta.url);
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(stubUrl, STUB);

  t.after(async () => {
    await rm(stubUrl, { force: true });
  });

  const stub = await import(stubUrl.href);
  const backgroundUrl = new URL('../background.js', import.meta.url).href;

  let registered;
  try {
    registered = await stub.loadBackground(backgroundUrl);
  } catch (err) {
    // A ReferenceError naming a missing binding is a real wiring failure. The
    // indexedDB ReferenceError is environment-only and is caught internally.
    if (err instanceof ReferenceError && !/indexedDB|atob|btoa|crypto is/.test(err.message)) {
      throw new Error(`background.js failed to resolve its module graph: ${err.message}`);
    }
    registered = [];
  }

  assert.ok(Array.isArray(registered));
  assert.equal(registered.length, 1,
    'background.js must register exactly one onMessage listener — two means duplicated handlers');
});
