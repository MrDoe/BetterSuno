// tests/panel-launch.test.js
//
// The toolbar (browser action) icon is a second launcher for the in-page panel.
// There was no `chrome.action.onClicked` listener at all, so a click on the
// extension icon did nothing, ever. The decision logic is pure and lives in
// lib/panel-launch.js; this file covers it and the wiring in both runtime files.
//
// background.js cannot be imported (it is a service worker / persistent script
// that touches `chrome` at load), so the handler is extracted from its source and
// executed against a stub — the same technique as tests/panel-visibility.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHOW_PANEL_MESSAGE, isSunoUrl } from '../lib/panel-launch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Return the `{ ... }` block starting at `openIndex`, brace-matched while
// skipping string literals and comments (the handler body contains both).
function extractBraceBlock(source, openIndex) {
  assert.notEqual(openIndex, -1, 'expected a brace');
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

// ---------------------------------------------------------------------------
// isSunoUrl — only pages where the content script can exist
// ---------------------------------------------------------------------------

test('isSunoUrl accepts Suno web pages', () => {
  assert.equal(isSunoUrl('https://suno.com/'), true);
  assert.equal(isSunoUrl('https://suno.com/create?foo=bar'), true);
  assert.equal(isSunoUrl('https://suno.com@evil.example/'), false,
    'userinfo must not be mistaken for the host');
  assert.equal(isSunoUrl('https://www.suno.com/'), true);
  assert.equal(isSunoUrl('https://studio-api.prod.suno.com/api/x'), true,
    'subdomains are accepted; sendMessage rejects if no content script is there');
  assert.equal(isSunoUrl('https://suno.com:8443/'), true);
});

test('isSunoUrl rejects lookalikes and non-web URLs', () => {
  assert.equal(isSunoUrl('http://suno.com/'), false,
    'the content script only runs on https pages');
  assert.equal(isSunoUrl('https://evil-suno.com/'), false);
  assert.equal(isSunoUrl('https://notsuno.com/'), false);
  assert.equal(isSunoUrl('https://suno.com.evil.example/'), false);
  assert.equal(isSunoUrl('https://evil.example/?next=https://suno.com/'), false);
  assert.equal(isSunoUrl('chrome://extensions/'), false);
  assert.equal(isSunoUrl('about:blank'), false);
  assert.equal(isSunoUrl('file:///tmp/suno.com'), false);
});

test('isSunoUrl tolerates missing and malformed values', () => {
  for (const value of ['', 'not a url', null, undefined, 42, {}, []]) {
    assert.equal(isSunoUrl(value), false, `expected false for ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// background.js — exactly one action handler, and it only opens
// ---------------------------------------------------------------------------

async function loadActionHandler() {
  const source = await fs.readFile(path.join(ROOT, 'background.js'), 'utf8');

  const at = source.indexOf('chrome.action.onClicked.addListener(');
  assert.notEqual(at, -1, 'background.js must register a toolbar action handler');

  const arrowAt = source.indexOf('=>', at);
  assert.notEqual(arrowAt, -1, 'the action listener must be a function');

  const body = extractBraceBlock(source, source.indexOf('{', arrowAt));
  const handlerSource = `(tab) => ${body}`;

  const calls = { sent: [] };
  const chromeStub = {
    tabs: {
      sendMessage(tabId, message) {
        calls.sent.push({ tabId, message });
        return Promise.resolve();
      }
    }
  };

  const handler = new Function(
    'chrome', 'isSunoUrl', 'SHOW_PANEL_MESSAGE',
    `return (${handlerSource});`
  )(chromeStub, isSunoUrl, SHOW_PANEL_MESSAGE);

  return { source, handler, calls, chromeStub };
}

test('the toolbar action opens the panel on a Suno tab', async () => {
  const { handler, calls } = await loadActionHandler();

  handler({ id: 7, url: 'https://suno.com/create' });

  assert.deepEqual(calls.sent, [{
    tabId: 7,
    message: { type: SHOW_PANEL_MESSAGE }
  }], 'the action must ask the content script to show the panel');
});

test('the toolbar action is a no-op on non-Suno tabs', async () => {
  // It must not navigate the user anywhere on its own (user decision
  // 2026-10-29), and it must not message a tab with no content script.
  const { handler, calls } = await loadActionHandler();

  handler({ id: 8, url: 'https://example.com/' });
  handler({ id: 9, url: 'chrome://extensions/' });
  handler({ id: 10 });
  handler(undefined);

  assert.deepEqual(calls.sent, [], 'no message may be sent off a Suno page');
});

test('a missing receiver on the Suno tab is swallowed', async () => {
  const { handler, chromeStub } = await loadActionHandler();

  // The tab may still be loading, so the content script does not exist yet.
  chromeStub.tabs.sendMessage = () => Promise.reject(new Error('Receiving end does not exist'));
  assert.doesNotThrow(() => handler({ id: 11, url: 'https://suno.com/' }));

  // Some browsers/harnesses return undefined instead of a promise.
  chromeStub.tabs.sendMessage = () => undefined;
  assert.doesNotThrow(() => handler({ id: 12, url: 'https://suno.com/' }));

  await new Promise(resolve => setTimeout(resolve, 0));
});

test('background.js registers exactly one action listener and imports the pure rules', async () => {
  const { source } = await loadActionHandler();

  assert.equal((source.match(/chrome\.action\.onClicked\.addListener\(/g) || []).length, 1,
    'two action listeners would double-send the show message');
  assert.match(source, /from '\.\/lib\/panel-launch\.js'/,
    'the pure URL rule must stay in lib/ so node:test can import it');
});

// ---------------------------------------------------------------------------
// content.js — the receiving end
// ---------------------------------------------------------------------------

test('content.js handles the toolbar message by showing the panel', async () => {
  const source = await fs.readFile(path.join(ROOT, 'content.js'), 'utf8');

  const at = source.indexOf(`msg.type === '${SHOW_PANEL_MESSAGE}'`);
  assert.notEqual(at, -1,
    `content.js must handle msg.type === '${SHOW_PANEL_MESSAGE}'`);

  const branch = source.slice(at, at + 400);
  assert.match(branch, /showPanel\(\)/,
    'the toolbar path must call showPanel(), the same open path as the bell');
  assert.match(branch, /sendResponse\(\{ ok: true \}\)/,
    'background.js needs an answer so a missing receiver is distinguishable');

  assert.ok(!/msg\.type === 'bettersunoShowPanel'[\s\S]{0,200}panelOpen\s*=/.test(source),
    'the toolbar icon must only open, never toggle');
});
