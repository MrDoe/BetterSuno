// tests/panel-open-performance.test.js
//
// Opening the panel from the star (bell) used to do two expensive things in
// front of the first paint, and one of them could take the panel down entirely:
//
//   1. `refresh()` awaited claimRefreshHost() (and, for the host tab, a network
//      notification fetch) before rendering a single notification row. A cold
//      service worker therefore showed an empty list for as long as its wake-up
//      took.
//   2. A failed IndexedDB read fell through to the full-refresh prompt, so a
//      database that could not open (another tab holding an older version, a
//      timed-out open) produced a blocking confirm() and a network crawl instead
//      of the cached library.
//
//   On top of that, startup deserialised every cached audio blob twice
//   (evictStaleBlobs + estimateDbUsageBytes) on the same main thread the first
//   library render uses, and saveSyncMeta() repeated the usage measurement
//   several times per session for a label only the Settings tab can display.
//
// content.js / downloader.js are content-script IIFEs that touch `document` and
// `chrome` at load, so they cannot be imported by node:test. As elsewhere in
// this suite, the shipped function source is extracted and executed against
// stubs, so the assertions track the real implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CONTENT_SOURCE = read('content.js');
const DOWNLOADER_SOURCE = read('downloader.js');

// Return the `{ ... }` block starting at `openIndex`, brace-matched while
// skipping string literals and comments.
function extractBraceBlock(source, openIndex) {
  assert.notEqual(openIndex, -1, 'expected a body brace');
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i);
      assert.notEqual(i, -1, 'unterminated block comment');
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      assert.notEqual(i, source.length, `unterminated ${quote} literal`);
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    i += 1;
  }
  throw new Error('unbalanced braces');
}

// The full declaration text of a top-level function, including a leading
// `async` and its parameter list.
function functionSource(source, name) {
  const needle = `function ${name}(`;
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected a declaration for ${name}`);

  const lineStart = source.lastIndexOf('\n', at) + 1;
  const open = source.indexOf('{', source.indexOf(')', at));
  assert.notEqual(open, -1, `expected a body for ${name}`);
  return source.slice(lineStart, open) + extractBraceBlock(source, open);
}

function bodyOf(source, name) {
  const declaration = functionSource(source, name);
  return declaration.slice(declaration.indexOf('{'));
}

// ---------------------------------------------------------------------------
// content.js — cached notifications paint before any round trip
// ---------------------------------------------------------------------------

function loadRefresh() {
  const declaration = functionSource(CONTENT_SOURCE, 'refresh');
  const factory = new Function(
    'isContextValid',
    'clearInterval',
    'refreshInterval',
    'androidFirefoxKeepAliveManager',
    'renderContextInvalidNotice',
    'renderCurrentState',
    'claimRefreshHost',
    'chrome',
    `let isNotificationsRefreshHost = false;
     ${declaration}
     return refresh;`
  );

  return (overrides = {}) => {
    const calls = { renders: 0, fetches: 0, notices: 0, clearedIntervals: 0 };
    const refresh = factory(
      overrides.isContextValid ?? (() => true),
      () => { calls.clearedIntervals += 1; },
      null,
      { stop: () => {} },
      () => { calls.notices += 1; },
      () => { calls.renders += 1; },
      overrides.claimRefreshHost ?? (() => Promise.resolve(false)),
      {
        runtime: {
          sendMessage(message, callback) {
            if (message?.type === 'contentFetchExisting') {
              calls.fetches += 1;
              callback?.();
            }
          }
        }
      }
    );
    return { refresh, calls };
  };
}

test('refresh paints the cached list before awaiting the refresh-host claim', async () => {
  let resolveClaim;
  const claim = () => new Promise((resolve) => { resolveClaim = resolve; });
  const make = loadRefresh();
  const { refresh, calls } = make({ claimRefreshHost: claim });

  const pending = refresh();

  assert.equal(calls.renders, 1,
    'the cached notification list must be painted before any message round trip');
  assert.equal(calls.fetches, 0,
    'no network fetch may start before the panel has something to show');

  resolveClaim(true);
  await pending;

  assert.equal(calls.fetches, 1, 'the host tab still refreshes from Suno afterwards');
  assert.equal(calls.renders, 2, 'the fetched list is rendered when it arrives');
});

test('refresh does not fetch when another tab owns the refresh host', async () => {
  const make = loadRefresh();
  const { refresh, calls } = make({ claimRefreshHost: () => Promise.resolve(false) });

  await refresh();

  assert.equal(calls.renders, 1, 'the cached paint happens regardless');
  assert.equal(calls.fetches, 0, 'only the host tab may start a network fetch');
});

test('refresh keeps the panel and explains a dead extension context', async () => {
  const make = loadRefresh();
  const { refresh, calls } = make({ isContextValid: () => false });

  await refresh();

  assert.equal(calls.notices, 1, 'the user must be told to reload the page');
  assert.equal(calls.clearedIntervals, 1, 'the polling interval must stop');
  assert.equal(calls.renders, 0, 'a dead context cannot render live state');
});

test('the invalid-context path never removes the panel', () => {
  // The old code called root.remove() here, which made the star look dead on
  // the first tap after an extension update: the whole panel disappeared.
  const body = bodyOf(CONTENT_SOURCE, 'refresh');
  assert.ok(!/root\.remove\(\)/.test(body),
    'a dead context must leave the panel in place and show the reload notice');
  assert.ok(/renderContextInvalidNotice\(\)/.test(body),
    'the invalid-context path must render the notice');
});

test('renderContextInvalidNotice inserts one banner, once', () => {
  const declaration = functionSource(CONTENT_SOURCE, 'renderContextInvalidNotice');
  const factory = new Function(
    'document',
    'root',
    `let contextInvalidNoticeShown = false;
     ${declaration}
     return renderContextInvalidNotice;`
  );

  const inserted = [];
  const anchor = { firstChild: null, insertBefore: (node) => { inserted.push(node); } };
  const root = { querySelector: () => anchor };
  const document = {
    createElement: () => ({
      id: '',
      textContent: '',
      style: { cssText: '' },
      setAttribute() {}
    })
  };

  const render = factory(document, root);
  render();
  render();

  assert.equal(inserted.length, 1, 'a second refresh must not stack banners');
  assert.equal(inserted[0].id, 'bettersuno-context-invalid');
  assert.equal(inserted[0].textContent.includes('Reload this page'), true,
    'the banner has to say what the user can do');
  assert.equal(inserted[0].style.cssText.includes('background'), true,
    'the banner must be visible over Suno without relying on content.css');
});

// ---------------------------------------------------------------------------
// downloader.js — retries and startup deferral
// ---------------------------------------------------------------------------

function loadSendMessageWithRetry() {
  const declaration = `${functionSource(DOWNLOADER_SOURCE, 'isExtensionContextValid')}
${functionSource(DOWNLOADER_SOURCE, 'sendMessageWithRetry')}`;
  return new Function('api', `${declaration}\nreturn sendMessageWithRetry;`);
}

test('sendMessageWithRetry gives up immediately when the context is invalid', async () => {
  let attempts = 0;
  const api = {
    runtime: {
      id: undefined,
      sendMessage() {
        attempts += 1;
        throw new Error('Extension context invalidated');
      }
    }
  };

  const send = loadSendMessageWithRetry()(api);

  await assert.rejects(() => send({ action: 'get_fetch_state' }), /context invalidated/i);
  assert.equal(attempts, 1,
    'an orphaned content script can never reconnect; retrying only stalls the panel');
});

test('sendMessageWithRetry still retries a live background', async () => {
  let attempts = 0;
  const api = {
    runtime: {
      id: 'extension-id',
      sendMessage() {
        attempts += 1;
        if (attempts < 2) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return Promise.resolve({ ok: true });
      }
    }
  };

  const send = loadSendMessageWithRetry()(api);
  const response = await send({ action: 'fetch_songs' }, { retries: 2, initialDelayMs: 0 });

  assert.deepEqual(response, { ok: true });
  assert.equal(attempts, 2, 'a live background must keep the retry budget');
});

test('startup probes use a short retry budget', () => {
  const fetchState = bodyOf(DOWNLOADER_SOURCE, 'checkFetchState');
  const downloadState = bodyOf(DOWNLOADER_SOURCE, 'checkDownloadState');

  assert.match(fetchState, /get_fetch_state["'] \}, \{ retries: 2 \}/,
    'a startup probe must not spend the full crawl retry budget');
  assert.match(downloadState, /get_download_state["'] \}, \{ retries: 2 \}/,
    'a startup probe must not spend the full crawl retry budget');
});

test('startup eviction and usage measurement are deferred until idle', () => {
  const loadFromStorage = bodyOf(DOWNLOADER_SOURCE, 'loadFromStorage');

  assert.match(loadFromStorage, /whenIdle\(\(\) => \{[\s\S]*?evictStaleBlobs\(\)[\s\S]*?refreshDbUsageDisplay\(\)[\s\S]*?\}\)/,
    'both blob-deserialising jobs belong behind whenIdle, not in the first render');
  assert.equal((loadFromStorage.match(/void refreshDbUsageDisplay\(\);/g) || []).length, 1,
    'the only usage measurement in loadFromStorage belongs to the idle job');
});

test('the automatic library check is deferred until the panel has painted', () => {
  const loadFromStorage = bodyOf(DOWNLOADER_SOURCE, 'loadFromStorage');

  assert.match(loadFromStorage, /whenIdle\(\(\) => checkForNewSongs\(\), 1500\)/,
    'a page-load crawl competes with the first open; it must start at idle');
  assert.ok(!/setTimeout\(\(\) => checkForNewSongs\(\), 100\)/.test(loadFromStorage),
    'the old 100 ms crawl start is what made the open path feel busy');
});

test('a failed library read never falls through to the full-refresh prompt', () => {
  const loadFromStorage = bodyOf(DOWNLOADER_SOURCE, 'loadFromStorage');

  assert.match(loadFromStorage, /savedSongs === null/,
    'an unreadable store must be distinguished from an empty one');
  assert.match(loadFromStorage, /if \(libraryLoadFailed\) \{[\s\S]*?return;[\s\S]*?\}/,
    'the failure path must return before startAutoFetch()');
  assert.match(loadFromStorage, /startAutoFetch\(\)/,
    'the genuinely empty library still prompts for a first fetch');
});

test('the DB usage label is measured lazily and throttled', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'refreshDbUsageDisplay');

  assert.match(body, /getClientRects\(\)\.length > 0/,
    'the measurement must be gated on the Settings tab actually being rendered');
  assert.match(body, /DB_USAGE_RECOMPUTE_MS/,
    'repeated sync-meta writes must not re-measure the whole cache');
  assert.match(body, /if \(!isVisible && !force\) \{[\s\S]*?return;/,
    'a hidden label must not deserialise every audio blob');
});

test('the Settings tab forces a fresh usage measurement', () => {
  assert.match(DOWNLOADER_SOURCE, /bettersuno:settings-opened', \(\) => \{\s*void refreshDbUsageDisplay\(\{ force: true \}\);/,
    'opening Settings is the one place a fresh number is worth computing');
});

// ---------------------------------------------------------------------------
// content-idb.js — an unreadable store is null, not an empty library
// ---------------------------------------------------------------------------

function loadContentIdb(indexedDB) {
  const sandbox = {
    indexedDB,
    TextEncoder,
    Blob,
    Date,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(read('content-idb.js'), sandbox, { filename: 'content-idb.js' });
  return sandbox.window.BetterSunoIDB;
}

test('loadSongsFromIDB returns null when the database cannot open', async () => {
  const api = loadContentIdb({
    open() {
      throw new Error('IndexedDB open timed out');
    }
  });

  assert.equal(await api.loadSongsFromIDB(), null,
    'null means "could not read"; the caller must not offer a full re-fetch for it');
});
