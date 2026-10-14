// tests/panel-visibility.test.js
//
// Regression guard for two Firefox Android defects reported 2026-10-11:
//
//   A. "Tapping the BetterSuno button sometimes does nothing", mostly after the
//      browser is re-opened from sleep. Two independent causes:
//        A1. `root`'s only parent is document.body, but the self-heal that
//            re-attaches a detached root was driven by a MutationObserver on
//            documentElement{subtree:true} *and* a 30s/120s interval — both of
//            which `releaseAndroidFirefoxKeepAlive` tore down on `pagehide` with
//            no matching re-arm. A back/forward-cache restore after sleep brought
//            back a live document with no observer and no interval, so a detached
//            root stayed detached forever.
//        A2. The bell handler inverted the cached `panelOpen` boolean. That
//            boolean survives a bfcache restore even when the panel is not on
//            screen, so the next tap *closed* the panel instead of opening it.
//      Both leave the tap with nothing to show: A1 because the subtree was not in
//      the document, A2 because it was toggled off.
//
//   B. "The extension becomes unresponsive under load, especially with BetterSuno
//      open in several tabs." The observer from A1 watched the entire document
//      subtree, so it fired on essentially every mutation Suno's SPA makes; each
//      burst debounced into an ensureVisibility() call that rewrote ~19
//      `!important` inline styles. That is ~20 style-invalidating writes per
//      second, per open tab, and it never shows up in a network trace. Separately,
//      every 30s each tab rebuilt the notification list from scratch even though
//      the array had not changed.
//
// content.js is a content-script IIFE that touches `document`, `chrome` and the
// DOM at import time, so it cannot be imported by node:test the way lib/*.js can.
// The behavioural tests below therefore extract the real handler/function source
// text and execute it against minimal stubs, so they exercise the shipped code
// rather than a re-implementation of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readContentSource() {
  return fs.readFile(path.join(ROOT, 'content.js'), 'utf8');
}

// Return the `{ ... }` block starting at `openIndex`, brace-matched while
// skipping string literals, template literals and comments. A naive scan would
// stop at a `}` inside a string; this file has deeply nested handlers, so being
// off by one block would silently assert against the wrong function.
function extractBraceBlock(source, openIndex, what) {
  assert.notEqual(openIndex, -1, `expected a body brace for ${what}`);

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
      assert.notEqual(i, -1, `unterminated block comment in ${what}`);
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
      assert.notEqual(i, source.length, `unterminated ${quote} literal in ${what}`);
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
  throw new Error(`unbalanced braces while extracting ${what}`);
}

function extractBlockAfter(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected content.js to contain ${what}`);
  return extractBraceBlock(source, source.indexOf('{', at + needle.length), what);
}

// Turn a real `function name(...) { ... }` declaration into a callable. Only
// valid for self-contained functions that do not close over the IIFE scope.
function loadFunction(source, name) {
  const decl = new RegExp(`^\\s*function ${name}\\(`, 'm');
  const match = source.match(decl);
  assert.ok(match, `expected content.js to declare ${name}`);

  const start = source.indexOf('function ' + name, match.index);
  const parenOpen = source.indexOf('(', start);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) { parenClose = i; break; }
    }
  }
  assert.notEqual(parenClose, -1, `expected ${name} to have a parameter list`);

  const text = source.slice(start, parenClose + 1)
    + extractBraceBlock(source, source.indexOf('{', parenClose), name);
  return new Function(`return (${text});`)();
}

// ---------------------------------------------------------------------------
// A1 — the self-heal must survive a back/forward-cache restore
// ---------------------------------------------------------------------------

test('a pageshow handler re-arms the visibility watchers torn down on pagehide', async () => {
  const source = await readContentSource();

  // The teardown still exists and is still bound to pagehide …
  assert.match(source, /addEventListener\('pagehide',\s*releaseAndroidFirefoxKeepAlive/,
    'pagehide must still release the Android keepalive');
  assert.match(source, /visibilityObserver\.disconnect\(\)/,
    'pagehide is expected to disconnect the visibility observer');

  // … so something has to put it back.
  const arm = extractBlockAfter(source, 'function armVisibilityWatchers()', 'armVisibilityWatchers');
  assert.match(arm, /restartVisibilityCheckInterval\(\)/,
    're-arming must restore the periodic visibility check');
  assert.match(arm, /visibilityObserver\.observe\(/,
    're-arming must resume observing the DOM for a detached root');
  assert.match(arm, /visibilityObserver\.disconnect\(\)/,
    're-arming must disconnect first so repeated arming cannot stack observers');

  const pageshow = extractBlockAfter(source, "addEventListener('pageshow'", 'the pageshow handler');
  assert.match(pageshow, /armVisibilityWatchers\(\)/,
    'pageshow must re-arm the visibility watchers — this is the wake-from-sleep fix');
});

test('the visibility observer no longer watches the whole document', async () => {
  const source = await readContentSource();

  // This is the multi-tab performance fix. `root`'s only parent is document.body,
  // so watching body's direct children catches every way root can be detached.
  // Observing documentElement with subtree:true caught every mutation Suno's SPA
  // makes instead, and each one triggered a ~19-property inline style rewrite.
  const observeCalls = [...source.matchAll(/visibilityObserver\.observe\(([\s\S]*?)\);/g)]
    .map(m => m[1]);
  assert.ok(observeCalls.length >= 1, 'expected the visibility observer to be armed');

  for (const args of observeCalls) {
    assert.ok(!/subtree\s*:\s*true/.test(args),
      `visibilityObserver.observe must not use subtree:true — ${args.trim()}`);
    assert.ok(!/documentElement/.test(args),
      `visibilityObserver.observe must not watch documentElement — ${args.trim()}`);
    assert.ok(/document\.body/.test(args),
      `visibilityObserver.observe must watch document.body (root's only parent) — ${args.trim()}`);
  }
});

test('the visibility observer ignores mutations that cannot detach our root', async () => {
  const source = await readContentSource();
  const observer = extractBlockAfter(source, 'new MutationObserver(', 'the visibility observer callback');

  assert.match(observer, /record\.target\s*!==\s*document\.body/,
    'only mutations on document.body can detach a direct child of body');
  assert.match(observer, /removedNodes/,
    'the filter must inspect removedNodes to notice our root being removed');
  assert.match(observer, /couldDetachRoot/,
    'the observer must decide whether a mutation is relevant before scheduling work');
  assert.match(observer, /if\s*\(!couldDetachRoot\)\s*return;/,
    'irrelevant mutations must bail out before arming the debounce timer');
});

// ---------------------------------------------------------------------------
// A2 — the tap must derive its next state from what is visible
// ---------------------------------------------------------------------------

// Execute the real bell click handler body against a minimal DOM, and return the
// state it ended up in. Parameters are passed by value, so the post-click locals
// have to be read back out of the function's own scope.
async function clickBell(initial = {}) {
  const source = await readContentSource();
  const body = extractBlockAfter(source, "bell.addEventListener('click'", 'the bell click handler');

  const dom = {
    rootMounted: true,
    panelHasOpenClass: false,
    // Rendered height, modelled separately from the class on purpose: a class
    // check and a layout check disagree exactly in the state that broke the bell.
    panelHeight: null,
    badgeStyleDisplay: '',
    badgeText: '',
    ...initial
  };
  if (dom.panelHeight === null) {
    dom.panelHeight = dom.panelHasOpenClass ? 720 : 0;
  }

  const calls = { ensureVisibility: 0, refresh: 0, dispatched: [] };

  const stubs = {
    root: { id: 'bettersuno-root' },
    panel: {
      classList: {
        contains(name) {
          assert.equal(name, 'open');
          return dom.panelHasOpenClass;
        },
        toggle(name, force) {
          assert.equal(name, 'open');
          dom.panelHasOpenClass = force;
          dom.panelHeight = force ? 720 : 0;
        }
      },
      getBoundingClientRect() {
        return { height: dom.panelHeight };
      }
    },
    badge: {
      style: {
        set display(v) { dom.badgeStyleDisplay = v; },
        get display() { return dom.badgeStyleDisplay; }
      },
      set textContent(v) { dom.badgeText = v; },
      get textContent() { return dom.badgeText; }
    },
    document: {
      documentElement: { contains: () => dom.rootMounted },
      body: { appendChild() {} },
      dispatchEvent(evt) { calls.dispatched.push(evt.type); }
    },
    CustomEvent: class {
      constructor(type) { this.type = type; }
    },
    ensureVisibility() { calls.ensureVisibility += 1; },
    refresh() { calls.refresh += 1; },
    panelOpen: initial.panelOpen ?? false,
    lastSeenCount: 0,
    currentNotifCount: 7,
    currentTab: 'library'
  };

  const keys = Object.keys(stubs);
  const after = new Function(
    ...keys,
    `${body}\nreturn { panelOpen, lastSeenCount };`
  )(...keys.map(k => stubs[k]));

  return { dom, calls, after };
}

test('tapping the bell opens the panel when our root was detached', async () => {
  // A1's user-visible symptom: the panel is not in the document, so the tap has
  // nothing to show. It must end up open, and it must repair the root on the way.
  const { dom, calls, after } = await clickBell({
    rootMounted: false,
    panelHasOpenClass: false
  });

  assert.equal(after.panelOpen, true, 'a tap must open the panel when nothing is visible');
  assert.equal(dom.panelHasOpenClass, true, 'the open class must end up applied');
  assert.equal(calls.ensureVisibility, 1, 'the tap must re-assert visibility before toggling');
  assert.equal(calls.refresh, 1, 'opening must trigger the existing refresh');
  assert.deepEqual(calls.dispatched, ['bettersuno:panel-opened'],
    'opening the library tab must still notify the rest of the content scripts');
});

test('tapping the bell opens the panel after a stale-open restore', async () => {
  // A2's user-visible symptom: panelOpen survived the bfcache restore as `true`
  // while the panel was not on screen. Inverting the cached flag would close it,
  // and the user would see nothing happen.
  const { dom, after } = await clickBell({
    rootMounted: true,
    panelHasOpenClass: false,
    panelOpen: true
  });

  assert.equal(after.panelOpen, true,
    'a stale cached panelOpen=true must not make the tap close the panel');
  assert.equal(dom.panelHasOpenClass, true, 'the panel must end up visibly open');
});

test('tapping the bell closes a panel that is genuinely open', async () => {
  // The fix must not turn the bell into an "open only" button.
  const { dom, calls, after } = await clickBell({
    rootMounted: true,
    panelHasOpenClass: true,
    panelOpen: true
  });

  assert.equal(after.panelOpen, false, 'an open panel must close on tap');
  assert.equal(dom.panelHasOpenClass, false);
  assert.equal(calls.ensureVisibility, 1, 'the tap must still re-assert visibility');
  assert.equal(calls.refresh, 0, 'closing must not trigger a refresh');
});

test('the bell handler does not blindly invert the cached panelOpen flag', async () => {
  const source = await readContentSource();
  const handler = extractBlockAfter(source, "bell.addEventListener('click'", 'the bell click handler');

  assert.ok(!/panelOpen\s*=\s*!panelOpen/.test(handler),
    'a bare toggle of the cached flag is what made a tap close an invisible panel');
  assert.match(handler, /document\.documentElement\.contains\(root\)/,
    'the next state must consider whether our root is still in the document');
  assert.match(handler, /panel\.getBoundingClientRect\(\)\.height > 0/,
    'the next state must come from the rendered panel, not the class. The `open` ' +
    'class is set by CSS to display:flex and ensureVisibility() re-adds it from the ' +
    'stale panelOpen flag, so it reads "open" even when nothing is on screen.');
  // Isolate the sample statement (it wraps over two lines) so the negative
  // assertion below cannot be satisfied by the rest of the handler.
  const sampleMatch = handler.match(/^\s*const wasVisiblyOpen =[\s\S]*?;$/m);
  assert.ok(sampleMatch, 'expected a `const wasVisiblyOpen = ...;` sample statement');
  const sampleLine = sampleMatch[0];
  assert.match(sampleLine, /panel\.getBoundingClientRect\(\)\.height > 0/,
    'the sample must read the rendered panel');
  assert.ok(!/panelOpen\s*\?|classList\.contains\(['"]open['"]\)/.test(sampleLine),
    'the pre-tap sample must not fall back to the cached flag or the open class');

  // The visible state has to be sampled before ensureVisibility() re-asserts the
  // stale flag, otherwise it would read its own repair back as "already open".
  // Both sides are matched as *statements*, not bare names: the handler's own
  // comments mention both tokens, and a name match would silently compare the
  // wrong pair of offsets (or invert them).
  const sampleAt = handler.search(/^\s*const wasVisiblyOpen =/m);
  const healAt = handler.search(/^\s*ensureVisibility\(\);$/m);
  assert.ok(sampleAt !== -1, 'expected a `const wasVisiblyOpen =` sample statement');
  assert.ok(healAt !== -1, 'expected a bare `ensureVisibility();` call statement');
  assert.ok(sampleAt < healAt,
    'sample the visible state before ensureVisibility() re-applies the stale panelOpen flag');
});

test('tapping the bell opens a panel that carries .open but renders nothing', async () => {
  // The state a class check cannot see: root is still mounted and `.open` is still
  // on the panel, but Suno stripped root's inline styles so the panel has no box.
  // Sampling the class here reports "already open" and the tap removes it — the
  // bell reappears, the panel stays shut, and the user taps a second time.
  const { dom, calls, after } = await clickBell({
    rootMounted: true,
    panelHasOpenClass: true,
    panelHeight: 0,
    panelOpen: true
  });

  assert.equal(after.panelOpen, true,
    'a zero-height panel is not visible, so the tap must open rather than close');
  assert.equal(dom.panelHasOpenClass, true, 'the panel must end up open');
  assert.equal(calls.ensureVisibility, 1, 'the tap must still re-assert visibility');
  assert.equal(calls.refresh, 1, 'opening must trigger the existing refresh');
});

// ---------------------------------------------------------------------------
// B — the per-tab idle cost
// ---------------------------------------------------------------------------

test('notificationFingerprint recognises a re-delivered identical list', async () => {
  const source = await readContentSource();
  const fingerprint = loadFunction(source, 'notificationFingerprint');

  const list = [
    { id: 'n3', updated_at: '2026-10-11T10:00:00Z' },
    { id: 'n2', updated_at: '2026-10-11T09:00:00Z' },
    { id: 'n1', updated_at: '2026-10-11T08:00:00Z' }
  ];

  // A fresh (de)serialisation of the same payload, as arrives on every poll.
  assert.equal(fingerprint(JSON.parse(JSON.stringify(list))), fingerprint(list),
    'a re-delivered identical list must produce the same fingerprint');

  assert.notEqual(fingerprint([{ id: 'n4', updated_at: '2026-10-11T11:00:00Z' }, ...list]), fingerprint(list),
    'a new notification must change the fingerprint');

  // "Load older" grows the tail — the incremental append path relies on this.
  assert.notEqual(fingerprint([...list, { id: 'n0', updated_at: '2026-10-11T07:00:00Z' }]), fingerprint(list),
    'an appended older notification must change the fingerprint');

  // A list that lost its newest entry must not alias onto the current one.
  assert.notEqual(fingerprint(list.slice(1)), fingerprint(list),
    'a list missing its newest entry must not share a fingerprint');

  // A same-length list with different content must not alias either.
  assert.notEqual(fingerprint(list.map(n => ({ ...n, id: n.id + 'x' }))), fingerprint(list),
    'a same-length list with different ids must not share a fingerprint');

  assert.equal(fingerprint([]), 'empty');
  assert.equal(fingerprint(null), 'empty');
  assert.equal(fingerprint(undefined), 'empty');
});

test('renderNotifications compares the fingerprint before touching the DOM', async () => {
  const source = await readContentSource();
  const fn = extractBlockAfter(source, 'function renderNotifications(', 'renderNotifications');

  assert.match(fn, /notificationFingerprint\(notifications\)/,
    'renderNotifications must compute a fingerprint');
  assert.match(fn, /nextFingerprint\s*===\s*renderedNotificationFingerprint/,
    'renderNotifications must compare it against the rendered one');

  // The skip has to happen before list.textContent = '' and the rebuild.
  const guardAt = fn.indexOf('if (unchanged) {');
  const rebuildAt = fn.indexOf("list.textContent = ''");
  assert.ok(guardAt !== -1, 'renderNotifications must have an unchanged guard');
  assert.ok(rebuildAt !== -1, 'renderNotifications still has its rebuild path');
  assert.ok(guardAt < rebuildAt,
    'the unchanged guard must run before the list is torn down and rebuilt');

  // The badge is computed before the guard, so a skipped render still updates it.
  const badgeAt = fn.indexOf('badge.textContent');
  assert.ok(badgeAt !== -1 && badgeAt < guardAt,
    'the badge must be updated before the unchanged guard returns early');

  // The model must still advance, so switching to the tab later stays correct.
  const guard = fn.slice(guardAt, fn.indexOf('\n    }', guardAt) + 6);
  assert.match(guard, /currentNotifications\s*=/,
    'the skip path must still refresh currentNotifications');
});

test('the fingerprint follows the incremental append path', async () => {
  const source = await readContentSource();

  // The stateUpdate handler grows currentNotifications in place when older
  // notifications arrive. If the fingerprint were not advanced there, the next
  // identical broadcast would look like a change and throw that render away.
  const handler = extractBlockAfter(
    source,
    'chrome.runtime.onMessage.addListener((msg, sender, sendResponse)',
    'the runtime message listener'
  );
  assert.match(handler, /renderedNotificationFingerprint\s*=\s*notificationFingerprint\(newNotifs\)/,
    'the append-older path must advance renderedNotificationFingerprint');
});

test('renderNotifications clears currentNotifications for an empty list', async () => {
  const source = await readContentSource();
  const fn = extractBlockAfter(source, 'function renderNotifications(', 'renderNotifications');

  // An empty payload renders "No notifications yet" — leaving the model holding
  // the previous list would let the append-older heuristic (which tests
  // currentNotifications.length > 0) reason about data that is no longer shown.
  const emptyAt = fn.indexOf('if (!notifications || notifications.length === 0) {');
  const clearAt = fn.indexOf('currentNotifications = []', emptyAt);
  assert.ok(emptyAt !== -1 && clearAt !== -1 && emptyAt < clearAt,
    'the empty-list branch must reset currentNotifications');
});