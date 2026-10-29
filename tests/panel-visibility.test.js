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

// The same source, cached for the helpers that run synchronously.
let cachedContentSource = null;
function readContentSourceSync() {
  assert.ok(cachedContentSource, 'call readContentSource() before the synchronous helper');
  return cachedContentSource;
}

// The `[ ... ]` literal that follows a needle.
function extractArrayAfter(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected content.js to contain ${what}`);
  const open = source.indexOf('[', at + needle.length);
  assert.notEqual(open, -1, `expected an array literal for ${what}`);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced brackets while extracting ${what}`);
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

// `notificationFingerprint` calls `notificationSignature`, so both have to be
// composed into one scope.
function loadNotificationFingerprint(source) {
  const signature = functionSource(source, 'notificationSignature');
  const fingerprint = functionSource(source, 'notificationFingerprint');
  return new Function(`${signature}\n${fingerprint}\nreturn notificationFingerprint;`)();
}

// The source text of a real `function name(...) { ... }` declaration, so it can
// be composed into another scope.
function functionSource(source, name) {
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

  return source.slice(start, parenClose + 1)
    + extractBraceBlock(source, source.indexOf('{', parenClose), name);
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
  assert.match(arm, /observeBody\(\)/,
    're-arming must resume observing the DOM for a detached root');
  assert.match(arm, /rootStyleObserver\.observe\(/,
    're-arming must resume watching our own inline styles');

  // The body watcher lives in its own function so it can also be re-anchored
  // when Suno replaces the body node itself. It must still watch body's direct
  // children only.
  const observeBody = extractBlockAfter(source, 'function observeBody()', 'observeBody');
  assert.match(observeBody, /visibilityObserver\.observe\(document\.body/,
    'the body watcher must observe document.body');
  assert.match(observeBody, /visibilityObserver\.disconnect\(\)/,
    're-anchoring must disconnect first so observers cannot stack');
  assert.match(observeBody, /observedBody\s*=\s*document\.body/,
    'the anchored body node must be remembered, or a body replacement goes unnoticed');

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

// A2 — the tap must derive its next state from what is visible
// ---------------------------------------------------------------------------

// Compose the real showPanel/hidePanel/isPanelVisiblyOpen/activateBell source
// into one scope and run it against a minimal DOM. The functions close over the
// IIFE's own variables, so they are extracted (like ensureVisibility below)
// rather than re-implemented: a re-implementation would keep passing after the
// shipped code regressed.
async function loadPanelControls(initial = {}) {
  const source = await readContentSource();

  const dom = {
    rootMounted: true,
    rootParent: 'body',          // 'body' | 'other' | null (detached)
    rootIsLastChild: true,
    panelHasOpenClass: false,
    // Geometry is modelled separately from the class on purpose: the class and
    // what is actually rendered disagree exactly in the states that broke the
    // bell. panelRect: null → derive from the class.
    panelRect: null,
    panelComputedStyle: { display: 'flex', visibility: 'visible', opacity: '1' },
    // elementFromPoint result: null → the panel itself; an object → that
    // element; 'throw' → the API is unavailable / cannot measure.
    hit: null,
    viewportWidth: 1280,
    viewportHeight: 720,
    badgeStyleDisplay: '',
    badgeText: '',
    ...initial
  };
  if (initial.panelComputedStyle) {
    dom.panelComputedStyle = { ...dom.panelComputedStyle, ...initial.panelComputedStyle };
  }
  if (dom.panelRect === null) {
    dom.panelRect = dom.panelHasOpenClass
      ? { left: 0, top: 0, width: dom.viewportWidth, height: dom.viewportHeight, right: dom.viewportWidth, bottom: dom.viewportHeight }
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  const body = { name: 'body' };
  const otherContainer = { name: 'suno-container' };
  const calls = { ensureVisibility: 0, refresh: 0, dispatched: [], reparented: 0, bellFocused: 0 };

  function createStyleStore() {
    const props = new Map();
    return {
      props,
      getPropertyValue(name) { return props.get(name)?.value ?? ''; },
      getPropertyPriority(name) { return props.get(name)?.priority ?? ''; },
      setProperty(name, value, priority) { props.set(name, { value, priority }); },
      removeProperty(name) { props.delete(name); }
    };
  }

  const fullRect = () => ({
    left: 0,
    top: 0,
    width: dom.viewportWidth,
    height: dom.viewportHeight,
    right: dom.viewportWidth,
    bottom: dom.viewportHeight
  });
  const zeroRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });

  const panelStyle = createStyleStore();
  const panel = {
    style: panelStyle,
    classList: {
      add(name) {
        assert.equal(name, 'open');
        dom.panelHasOpenClass = true;
        // A visible class gives the panel its box, exactly like the CSS rule.
        if (!(dom.panelRect.height > 0)) dom.panelRect = fullRect();
      },
      remove(name) {
        assert.equal(name, 'open');
        dom.panelHasOpenClass = false;
        dom.panelRect = zeroRect();
      },
      contains(name) {
        assert.equal(name, 'open');
        return dom.panelHasOpenClass;
      }
    },
    contains(node) {
      return node === panel || node?.insidePanel === true;
    },
    getBoundingClientRect() { return dom.panelRect; }
  };

  const root = {
    id: 'bettersuno-root',
    style: createStyleStore(),
    get parentNode() {
      if (dom.rootParent === 'body') return body;
      if (dom.rootParent === 'other') return otherContainer;
      return null;
    },
    get nextElementSibling() { return dom.rootIsLastChild ? null : { name: 'suno-node' }; }
  };

  const bell = {
    id: 'bettersuno-bell',
    style: createStyleStore(),
    contains(node) { return node === bell; },
    focus() { calls.bellFocused += 1; }
  };

  body.appendChild = (node) => {
    assert.equal(node, root, 'only root may be appended to body');
    dom.rootParent = 'body';
    dom.rootIsLastChild = true;
    calls.reparented += 1;
  };

  const stubs = {
    root,
    bell,
    panel,
    badge: {
      style: {
        set display(v) { dom.badgeStyleDisplay = v; },
        get display() { return dom.badgeStyleDisplay; }
      },
      set textContent(v) { dom.badgeText = v; },
      get textContent() { return dom.badgeText; }
    },
    document: {
      documentElement: {
        contains: () => dom.rootMounted,
        clientWidth: dom.viewportWidth,
        clientHeight: dom.viewportHeight
      },
      body,
      elementFromPoint() {
        if (dom.hit === 'throw') throw new Error('no layout in this environment');
        if (dom.hit === null) return panel;
        return dom.hit;
      },
      dispatchEvent(evt) { calls.dispatched.push(evt.type); }
    },
    window: {
      innerWidth: dom.viewportWidth,
      innerHeight: dom.viewportHeight,
      getComputedStyle: () => dom.panelComputedStyle
    },
    CustomEvent: class {
      constructor(type) { this.type = type; }
    },
    ensureVisibility() { calls.ensureVisibility += 1; },
    refresh() { calls.refresh += 1; },
    panelOpen: initial.panelOpen ?? dom.panelHasOpenClass,
    lastSeenCount: 0,
    currentNotifCount: 7,
    currentTab: 'library'
  };

  const panelStylesArray = extractArrayAfter(
    source, 'const PANEL_OPEN_INLINE_STYLES =', 'PANEL_OPEN_INLINE_STYLES');
  const coalesceMatch = source.match(/const BELL_ACTIVATION_COALESCE_MS = (\d+);/);
  assert.ok(coalesceMatch, 'expected content.js to declare BELL_ACTIVATION_COALESCE_MS');

  const keys = Object.keys(stubs);
  const controls = new Function(
    ...keys,
    `
    const PANEL_OPEN_INLINE_STYLES = ${panelStylesArray};
    const BELL_ACTIVATION_COALESCE_MS = ${coalesceMatch[1]};
    let lastBellActivationAt = 0;
    ${functionSource(source, 'applyImportantStyles')}
    ${functionSource(source, 'clearImportantStyles')}
    ${functionSource(source, 'isPanelVisiblyOpen')}
    ${functionSource(source, 'showPanel')}
    ${functionSource(source, 'hidePanel')}
    ${functionSource(source, 'activateBell')}
    return {
      activateBell,
      showPanel,
      hidePanel,
      isPanelVisiblyOpen,
      state: () => ({ panelOpen, lastSeenCount })
    };
    `
  )(...keys.map(k => stubs[k]));

  return { dom, calls, panelStyle, ...controls };
}

// One tap at a known timestamp (so the coalescing window is deterministic).
async function tapBell(initial = {}, now = 1000) {
  const controls = await loadPanelControls(initial);
  const result = controls.activateBell(now);
  return { ...controls, result, after: controls.state() };
}

test('tapping the bell opens the panel when our root was detached', async () => {
  // A1's user-visible symptom: the panel is not in the document, so the tap has
  // nothing to show. It must end up open, and it must repair the root on the way.
  const tap = await tapBell({
    rootMounted: false,
    rootParent: null,
    panelHasOpenClass: false
  });

  assert.equal(tap.result, 'opened');
  assert.equal(tap.after.panelOpen, true, 'a tap must open the panel when nothing is visible');
  assert.equal(tap.dom.panelHasOpenClass, true, 'the open class must end up applied');
  assert.equal(tap.calls.reparented, 1, 'a detached root must be re-parented before showing');
  assert.equal(tap.calls.ensureVisibility, 1, 'the tap must re-assert visibility before opening');
  assert.equal(tap.calls.refresh, 1, 'opening must trigger the existing refresh');
  assert.deepEqual(tap.calls.dispatched, ['bettersuno:panel-opened'],
    'opening the library tab must still notify the rest of the content scripts');
});

test('tapping the bell opens the panel after a stale-open restore', async () => {
  // A2's user-visible symptom: panelOpen survived the bfcache restore as `true`
  // while the panel was not on screen. Inverting the cached flag would close it,
  // and the user would see nothing happen.
  const tap = await tapBell({
    rootMounted: true,
    panelHasOpenClass: false,
    panelOpen: true
  });

  assert.equal(tap.result, 'opened');
  assert.equal(tap.after.panelOpen, true,
    'a stale cached panelOpen=true must not make the tap close the panel');
  assert.equal(tap.dom.panelHasOpenClass, true, 'the panel must end up visibly open');
});

test('tapping the bell closes a panel that is genuinely open', async () => {
  // The fix must not turn the bell into an "open only" button.
  const tap = await tapBell({
    rootMounted: true,
    panelHasOpenClass: true,
    panelOpen: true
  });

  assert.equal(tap.result, 'closed');
  assert.equal(tap.after.panelOpen, false, 'an open panel must close on tap');
  assert.equal(tap.dom.panelHasOpenClass, false);
  assert.equal(tap.calls.refresh, 0, 'closing must not trigger a refresh');
  assert.equal(tap.calls.bellFocused, 1, 'closing must return focus to the bell');
  assert.equal(tap.panelStyle.props.size, 0,
    'the close path must remove the inline overrides so the CSS can hide the panel');
});

test('tapping the bell opens a panel that carries .open but renders nothing', async () => {
  // The state a class check cannot see: root is still mounted and `.open` is still
  // on the panel, but Suno stripped root's inline styles so the panel has no box.
  // Sampling the class here reports "already open" and the tap removes it — the
  // bell reappears, the panel stays shut, and the user taps a second time.
  const tap = await tapBell({
    rootMounted: true,
    panelHasOpenClass: true,
    panelRect: { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
    panelOpen: true
  });

  assert.equal(tap.result, 'opened');
  assert.equal(tap.after.panelOpen, true,
    'a zero-height panel is not visible, so the tap must open rather than close');
  assert.equal(tap.dom.panelHasOpenClass, true, 'the panel must end up open');
  assert.equal(tap.calls.refresh, 1, 'opening must trigger the existing refresh');
});

test('tapping the bell opens a panel buried under a Suno layer', async () => {
  // The residual defect: the panel has a full-size box, but a later, equal-z-index
  // Suno layer paints over it. A rect-only probe says "open", the tap *closes*
  // the invisible panel, and every second tap repeats that. The hit test at the
  // panel centre is the only check that can see this state.
  const occluder = { name: 'suno-overlay', insidePanel: false };
  const tap = await tapBell({
    rootMounted: true,
    panelHasOpenClass: true,
    panelOpen: true,
    hit: occluder
  });

  assert.equal(tap.isPanelVisiblyOpen(), false,
    'a panel that does not own the topmost paint at its centre is not visible');
  assert.equal(tap.result, 'opened',
    'an occluded panel must be re-opened, never toggled closed');
  assert.equal(tap.dom.panelHasOpenClass, true);
});

test('tapping the bell opens a panel whose computed style hides it', async () => {
  for (const hidden of [
    { visibility: 'hidden' },
    { opacity: '0' },
    { display: 'none' }
  ]) {
    const tap = await tapBell({
      rootMounted: true,
      panelHasOpenClass: true,
      panelOpen: true,
      panelComputedStyle: hidden
    });

    assert.equal(tap.result, 'opened',
      `computed ${JSON.stringify(hidden)} must count as not visible`);
    assert.equal(tap.dom.panelHasOpenClass, true);
  }
});

test('a root nested in a Suno container is re-parented before the panel opens', async () => {
  // `documentElement.contains(root)` is true here, so the old self-heal saw
  // nothing to do. An ancestor with display:none or a transform can still make
  // the fixed panel unrenderable or break its positioning.
  const controls = await loadPanelControls({
    rootMounted: true,
    rootParent: 'other',
    panelHasOpenClass: false,
    panelOpen: false
  });

  assert.equal(controls.isPanelVisiblyOpen(), false,
    'root must be a direct child of body to count as visible');
  assert.equal(controls.activateBell(1000), 'opened');
  assert.equal(controls.calls.reparented, 1, 'the tap must move root back to document.body');
  assert.equal(controls.state().panelOpen, true);
});

test('a rapid second tap cannot close the panel the first tap opened', async () => {
  // The impatient double tap: the first tap opens, the second arrives before the
  // user can see the result. It must be coalesced, not treated as "close".
  const controls = await loadPanelControls({
    rootMounted: true,
    panelHasOpenClass: false
  });

  assert.equal(controls.activateBell(1000), 'opened');
  assert.equal(controls.activateBell(1200), 'coalesced',
    'a repeat activation inside the coalescing window must be dropped');
  assert.equal(controls.state().panelOpen, true,
    'the panel must still be open after the second tap');

  const coalesceMs = Number(
    (await readContentSource()).match(/const BELL_ACTIVATION_COALESCE_MS = (\d+);/)[1]);
  assert.equal(controls.activateBell(1000 + coalesceMs + 1), 'closed',
    'after the window a tap is honoured again');
});

test('the tap decision comes from the rendered panel, not the cached flag', async () => {
  const source = await readContentSource();

  const probe = functionSource(source, 'isPanelVisiblyOpen');
  assert.match(probe, /document\.documentElement\.contains\(root\)/,
    'the probe must consider whether our root is still in the document');
  assert.match(probe, /root\.parentNode !== document\.body/,
    'an in-document root nested in a Suno container is not visible either');
  assert.match(probe, /panel\.getBoundingClientRect\(\)/,
    'the probe must read the rendered box');
  assert.match(probe, /getComputedStyle\(panel\)/,
    'a full rect is not enough: visibility/opacity/display can still hide it');
  assert.match(probe, /document\.elementFromPoint\(/,
    'z-index burial is only visible to a hit test');
  assert.ok(!/offsetParent/.test(probe),
    'offsetParent is permanently null for position:fixed elements');

  const activate = functionSource(source, 'activateBell');
  assert.match(activate, /isPanelVisiblyOpen\(\)/,
    'the tap must derive its next state from the visible probe');
  assert.match(activate, /showPanel\(\)/);
  assert.match(activate, /hidePanel\(\{ focusBell: true \}\)/);
  assert.ok(!/panelOpen\s*=\s*!panelOpen/.test(source),
    'a bare toggle of the cached flag is what made a tap close an invisible panel');
  assert.ok(!/classList\.contains\(['"]open['"]\)/.test(probe),
    'the class is what CSS uses to make the panel visible, so it cannot be the test');
});

test('the open path asserts the panel styles and the close path removes them', async () => {
  const source = await readContentSource();

  const show = functionSource(source, 'showPanel');
  assert.match(show, /applyImportantStyles\(panel, PANEL_OPEN_INLINE_STYLES\)/,
    'opening must re-assert the panel declarations inline, or a stylesheet can keep it hidden');
  assert.match(show, /root\.parentNode !== host/,
    'opening must move root back to body');

  const hide = functionSource(source, 'hidePanel');
  assert.match(hide, /clearImportantStyles\(panel, PANEL_OPEN_INLINE_STYLES\)/,
    'closing must remove the inline overrides, or the panel would never hide');

  const ensure = functionSource(source, 'ensureVisibility');
  assert.match(ensure, /root\.parentNode !== host/,
    'the self-heal must repair a nested root, not just a fully detached one');
  assert.match(ensure, /applyImportantStyles\(panel, PANEL_OPEN_INLINE_STYLES\)/,
    'the periodic heal must also restore the open panel declarations');
});

test('the bell listens on window in the capture phase', async () => {
  // A capture-phase handler on document/body that calls stopPropagation() must
  // not be able to swallow the tap before a bubble-phase bell listener runs.
  const source = await readContentSource();

  for (const type of ['pointerdown', 'pointerup', 'click']) {
    const at = source.indexOf(`window.addEventListener('${type}'`);
    assert.notEqual(at, -1, `expected a window-level ${type} listener`);
    const tail = source.slice(at, at + 600);
    assert.match(tail, /\}, true\);/,
      `the ${type} listener must be registered in the capture phase`);
  }

  assert.ok(!/bell\.addEventListener\('click'/.test(source),
    'the bubble-phase bell listener is what Suno could swallow');

  const pointerUp = source.slice(
    source.indexOf("window.addEventListener('pointerup'"),
    source.indexOf("window.addEventListener('pointercancel'"));
  assert.match(pointerUp, /bellPointerDown/,
    'pointerup must only activate when the pointer went down on the bell');
});

// ---------------------------------------------------------------------------
// B — the per-tab idle cost
// ---------------------------------------------------------------------------

test('notificationFingerprint recognises a re-delivered identical list', async () => {
  const source = await readContentSource();
  const fingerprint = loadNotificationFingerprint(source);

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
// ---------------------------------------------------------------------------
// The self-heal must be cheap, and it must not go blind
// ---------------------------------------------------------------------------

// The inline styles content.js keeps on `root` and `bell`.
const EXPECTED_ROOT_STYLES = {
  position: 'fixed',
  top: '20px',
  left: '20px',
  right: 'auto',
  bottom: 'auto',
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  'pointer-events': 'auto',
  'z-index': '9999999999'
};

const EXPECTED_BELL_STYLES = {
  display: 'flex',
  visibility: 'visible',
  opacity: '1',
  'pointer-events': 'auto'
};

// An element whose inline style can be read, written, removed and stripped, and
// which records every write.
function createStyledElement(initialStyles) {
  const props = new Map();
  for (const [name, value] of Object.entries(initialStyles)) {
    props.set(name, { value, priority: 'important' });
  }

  const writes = [];
  return {
    writes,
    parentNode: null,
    strip(name) { props.delete(name); },
    style: {
      getPropertyValue(name) { return props.get(name)?.value ?? ''; },
      getPropertyPriority(name) { return props.get(name)?.priority ?? ''; },
      setProperty(name, value, priority) {
        writes.push(name);
        props.set(name, { value, priority });
      },
      removeProperty(name) {
        writes.push(`-${name}`);
        props.delete(name);
      }
    }
  };
}

// Run the real ensureVisibility() against stubbed elements.
function runEnsureVisibility({
  stripRoot,
  stripBell,
  body,
  observedBody,
  rootParent,
  panelOpen = false
}) {
  const source = readContentSourceSync();

  const calls = { observeBody: 0, addedOpenClass: 0, appended: 0 };

  const root = createStyledElement({ ...EXPECTED_ROOT_STYLES });
  const bell = createStyledElement({ ...EXPECTED_BELL_STYLES });
  const panel = createStyledElement({});
  panel.classList = { add() { calls.addedOpenClass += 1; } };
  if (stripRoot) root.strip(stripRoot);
  if (stripBell) bell.strip(stripBell);
  root.parentNode = rootParent ?? body;

  body.appendChild = (node) => {
    calls.appended += 1;
    node.parentNode = body;
  };

  const applyStyles = functionSource(source, 'applyImportantStyles');
  const ensureVisibility = functionSource(source, 'ensureVisibility');
  const rootStylesArray = extractArrayAfter(source, 'const ROOT_INLINE_STYLES =', 'ROOT_INLINE_STYLES');
  const bellStylesArray = extractArrayAfter(source, 'const BELL_INLINE_STYLES =', 'BELL_INLINE_STYLES');
  const panelStylesArray = extractArrayAfter(source, 'const PANEL_OPEN_INLINE_STYLES =', 'PANEL_OPEN_INLINE_STYLES');

  const keys = ['root', 'bell', 'panel', 'panelOpen', 'document', 'observedBody', 'observeBody'];
  const stubs = {
    root,
    bell,
    panel,
    panelOpen,
    document: {
      documentElement: { contains: () => true },
      body
    },
    observedBody,
    observeBody() { calls.observeBody += 1; }
  };

  const ensure = new Function(
    ...keys,
    `
    const ROOT_INLINE_STYLES = ${rootStylesArray};
    const BELL_INLINE_STYLES = ${bellStylesArray};
    const PANEL_OPEN_INLINE_STYLES = ${panelStylesArray};
    ${applyStyles}
    ${ensureVisibility}
    return ensureVisibility;
    `
  )(...keys.map(k => stubs[k]));

  ensure();
  return { root, bell, panel, calls };
}

test('ensureVisibility only writes the declarations that are actually wrong', async () => {
  cachedContentSource = await readContentSource();

  // The old implementation rewrote all 14 `!important` inline styles on every
  // check. Each write invalidates the style of the whole subtree, which was
  // the per-tab idle cost: with BetterSuno open in several tabs the extension
  // crawled. Reading an inline declaration is free.
  const body = { name: 'body' };
  const healthy = runEnsureVisibility({ body, observedBody: body });

  assert.deepEqual(healthy.root.writes, [],
    'a healthy root must not be rewritten at all');
  assert.deepEqual(healthy.bell.writes, [],
    'a healthy bell must not be rewritten at all');

  // Now strip one declaration and check that exactly that one is restored.
  const body2 = { name: 'body' };
  const stripped = runEnsureVisibility({ stripRoot: 'z-index', body: body2, observedBody: body2 });

  assert.deepEqual(stripped.root.writes, ['z-index'],
    'only the stripped declaration may be rewritten');
  assert.deepEqual(stripped.bell.writes, [],
    'the bell must not be rewritten when it is healthy');

  const body3 = { name: 'body' };
  const strippedBell = runEnsureVisibility({ stripBell: 'opacity', body: body3, observedBody: body3 });

  assert.deepEqual(strippedBell.bell.writes, ['opacity'],
    'only the stripped bell declaration may be rewritten');
  assert.deepEqual(strippedBell.root.writes, [],
    'the root must not be rewritten when it is healthy');
});

test('the body watcher is re-anchored when Suno replaces the body node', async () => {
  cachedContentSource = await readContentSource();

  // The observer watches a *node*. If Suno replaces document.body itself, the
  // watcher would be watching a detached node and never fire again — the DOM
  // churn watcher would be permanently blind.
  const result = runEnsureVisibility({
    body: { name: 'new-body' },
    observedBody: { name: 'old-body' }
  });

  assert.equal(result.calls.observeBody, 1,
    'a replaced body node must re-anchor the observer');
});

test('the body watcher is not re-anchored while the body is the same node', async () => {
  cachedContentSource = await readContentSource();

  const body = { name: 'body' };
  const result = runEnsureVisibility({ body, observedBody: body });

  assert.equal(result.calls.observeBody, 0,
    'the observer must not be re-anchored on every check');
});

test('ensureVisibility moves a root nested in a Suno container back to body', async () => {
  cachedContentSource = await readContentSource();

  // `documentElement.contains(root)` is true in this state, so the old
  // detached-only check left root under an ancestor that can hide it
  // (display:none) or break its fixed positioning (transform).
  const body = { name: 'body' };
  const result = runEnsureVisibility({
    body,
    observedBody: body,
    rootParent: { name: 'suno-container' }
  });

  assert.equal(result.calls.appended, 1,
    'a root that is in the document but not a child of body must be re-parented');
  assert.equal(result.root.parentNode, body);
});

test('ensureVisibility re-asserts the panel declarations while it is open', async () => {
  cachedContentSource = await readContentSource();

  const body = { name: 'body' };
  const result = runEnsureVisibility({ body, observedBody: body, panelOpen: true });

  assert.equal(result.calls.addedOpenClass, 1,
    'the periodic heal must keep the open class applied');
  assert.ok(result.panel.writes.includes('display'),
    'a stylesheet override must not be able to keep the open panel hidden');
  assert.ok(result.panel.writes.includes('opacity'),
    'the panel declarations asserted on open must also survive the heal');
});

test('a stripped inline style is healed without waiting for the interval', async () => {
  const source = await readContentSource();

  // The old whole-document observer re-asserted the styles on any SPA churn,
  // which is why the panel felt self-healing. Narrowing the observer to body
  // childList dropped that, and recovery then waited for the 30s/120s interval.
  // Watching root's own style attribute restores the fast path.
  assert.match(source, /rootStyleObserver = new MutationObserver\(/,
    'the style watcher must exist');
  assert.match(source, /rootStyleObserver\.observe\(root,\s*\{ attributes: true, attributeFilter: \['style'\] \}\)/,
    'root\'s style attribute must be watched so a style strip is healed quickly');
});

test('the notification fingerprint notices a changed middle entry', async () => {
  const source = await readContentSource();
  const fingerprint = loadNotificationFingerprint(source);

  const list = [
    { id: 'n3', updated_at: '2026-10-11T10:00:00Z' },
    { id: 'n2', updated_at: '2026-10-11T09:00:00Z' },
    { id: 'n1', updated_at: '2026-10-11T08:00:00Z' }
  ];

  // A middle entry changed, but the length, both end ids and the newest
  // timestamp are identical. The old fingerprint could not see this, so the DOM
  // kept the stale item.
  const middleChanged = [
    { id: 'n3', updated_at: '2026-10-11T10:00:00Z' },
    { id: 'n2', updated_at: '2026-10-11T09:30:00Z' },
    { id: 'n1', updated_at: '2026-10-11T08:00:00Z' }
  ];

  assert.notEqual(fingerprint(middleChanged), fingerprint(list),
    'a changed middle entry must change the fingerprint — the DOM would keep the stale item');

  // A middle entry that is *replaced* (same length, different id) must also be
  // visible to the fingerprint.
  const middleReplaced = [
    { id: 'n3', updated_at: '2026-10-11T10:00:00Z' },
    { id: 'nX', updated_at: '2026-10-11T09:00:00Z' },
    { id: 'n1', updated_at: '2026-10-11T08:00:00Z' }
  ];
  assert.notEqual(fingerprint(middleReplaced), fingerprint(list),
    'a replaced middle entry must change the fingerprint');

  // The existing transitions must still be covered.
  assert.notEqual(fingerprint([...list, { id: 'n0' }]), fingerprint(list),
    'an appended older notification must change the fingerprint');
  assert.notEqual(fingerprint(list.slice(1)), fingerprint(list),
    'a list missing its newest entry must not share a fingerprint');
  assert.equal(fingerprint([]), 'empty');
  assert.equal(fingerprint(null), 'empty');
  assert.equal(fingerprint(undefined), 'empty');
});
