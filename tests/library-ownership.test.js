// tests/library-ownership.test.js
//
// Regression guard for the library's "is this song someone else's?" decision.
//
// `downloader.js` decides three things with it: the 👤 badge, whether the
// Download button is enabled, and whether a song can be saved as a file
// (`splitSongsByDownloadEligibility`). `lib/ownership.js` guards the
// background's actual download gate, and its policy is explicit: only
// *evidence* may block a download, because a false block costs the user their
// own song.
//
// The panel used to break that policy. `isSongFromOtherArtist`:
//
//   1. only checked `is_owned_by_current_user` for `false`, so a song the API
//      had explicitly marked as the user's own could still be misclassified;
//   2. otherwise compared `owner_user_id` against `sunoUserId`, a single id
//      guessed from `allSongs[0].owner_user_id` — the *first* song in the
//      library. One foreign song at the head of the list (a public song the
//      user added) poisoned the guess for the whole session, and the guess was
//      never revisited.
//
// The fix: the background resolves the current user's ids from the bearer
// token's claims and sends them with the library payload, and the panel
// compares against that set. The single-id fallback now only ever comes from
// a song the API explicitly marked as owned.
//
// downloader.js is a content-script IIFE that touches `document`/`chrome` at
// import time, so it cannot be imported by node:test. As in
// tests/panel-visibility.test.js, the tests below extract the real function
// source and execute it against minimal stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readDownloader = () => fs.readFile(path.join(ROOT, 'downloader.js'), 'utf8');
const readBackground = () => fs.readFile(path.join(ROOT, 'background.js'), 'utf8');

// Brace-matched block extraction that skips strings and comments.
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

function findClosingParen(source, parenOpen, what) {
  let depth = 0;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  assert.fail(`unbalanced parentheses while extracting ${what}`);
}

// The body of `function name(...) { ... }`, skipping the parameter list: a
// default value like `options = {}` contains braces, so "the next `{` after
// the name" would find the destructuring default instead.
function extractFunctionBody(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected downloader.js to contain ${what}`);
  const parenOpen = source.indexOf('(', at);
  const parenClose = findClosingParen(source, parenOpen, what);
  return extractBraceBlock(source, source.indexOf('{', parenClose), what);
}

// The whole declaration, signature included, so it can be evaluated.
function extractFunctionText(source, needle, what) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `expected downloader.js to contain ${what}`);
  const parenOpen = source.indexOf('(', at);
  const parenClose = findClosingParen(source, parenOpen, what);
  const body = extractBraceBlock(source, source.indexOf('{', parenClose), what);
  return `${source.slice(at, parenClose + 1)}${body}`;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Run `isSongFromOtherArtist` with a given identity state.
function isOtherArtist(song, { userIds = [], fallbackId = null } = {}) {
  const source = readDownloaderSync();
  const text = extractFunctionText(source, 'function isSongFromOtherArtist(', 'isSongFromOtherArtist');

  const sunoUserIds = new Set(userIds);
  return new Function(
    'sunoUserIds', 'sunoUserId', 'song',
    `return (${text})(song);`
  )(sunoUserIds, fallbackId, song);
}

// readDownloader is async; this helper keeps the call sites synchronous.
let cachedSource = null;
function readDownloaderSync() {
  if (!cachedSource) {
    throw new Error('call loadDownloaderSource() before using the synchronous helper');
  }
  return cachedSource;
}

test('the panel never blocks a song the API says the user owns', async () => {
  cachedSource = await readDownloader();

  // The API's flag is authoritative in both directions — the old code only
  // looked for `false`, so an explicitly-owned song could still be misclassified
  // by the owner-id comparison.
  assert.equal(
    isOtherArtist({ is_owned_by_current_user: true, owner_user_id: 'someone-else' }),
    false,
    'a song the API marked as owned must never be treated as another artist\'s'
  );

  // The same, with a fallback owner id in play: the old code compared the owner
  // id even for songs the API had explicitly marked as the user's own.
  assert.equal(
    isOtherArtist(
      { is_owned_by_current_user: true, owner_user_id: 'someone-else' },
      { fallbackId: 'suno-uuid-1' }
    ),
    false,
    'the API\'s ownership flag must win over the owner-id comparison'
  );

  assert.equal(
    isOtherArtist({ is_owned_by_current_user: false, owner_user_id: 'me' }),
    true,
    'a song the API marked as not owned must be treated as another artist\'s'
  );
});

test('the resolved identity decides ownership when the API does not say', async () => {
  cachedSource = await readDownloader();

  const userIds = ['suno-uuid-1', 'clerk-id-1'];

  assert.equal(
    isOtherArtist({ owner_user_id: 'suno-uuid-1' }, { userIds }),
    false,
    'the current user\'s own song must not be blocked'
  );

  assert.equal(
    isOtherArtist({ owner_user_id: 'suno-uuid-2' }, { userIds }),
    true,
    'another artist\'s song must be recognised'
  );

  // The identity carries several aliases; a clip's owner_user_id is only one
  // of them, so a single-id comparison was never enough.
  assert.equal(
    isOtherArtist({ owner_user_id: 'clerk-id-1' }, { userIds }),
    false,
    'every alias of the current user must be recognised'
  );
});

test('without any identity evidence nothing is blocked', async () => {
  cachedSource = await readDownloader();

  // lib/ownership.js: "only explicit evidence may block a download — a false
  // block costs the user their own song". The panel must not guess.
  assert.equal(
    isOtherArtist({ owner_user_id: 'someone-elses-uuid' }),
    false,
    'an unresolved identity must not block on a guess'
  );
});

test('the fallback owner id is only taken from an explicitly-owned song', async () => {
  const source = await readDownloader();
  cachedSource = source;

  const init = extractFunctionBody(source, 'function initSunoUserId(', 'initSunoUserId');
  const code = stripComments(init);

  assert.ok(
    !/allSongs\[0\]/.test(code),
    'the owner id must not be guessed from the first song in the library — one ' +
    'foreign song at the head used to misclassify every song'
  );
  assert.match(
    code,
    /is_owned_by_current_user\s*===\s*true/,
    'the fallback owner id must come from a song the API explicitly marked as owned'
  );
});

test('the background sends the current user ids with the library payload', async () => {
  const background = await readBackground();

  // The panel cannot classify other artists' songs without them: the API's
  // `is_owned_by_current_user` is only ever `true` or absent, never `false`.
  assert.match(
    background,
    /currentUserIds:\s*allIdentityIds/,
    'the library messages must carry the resolved identity ids'
  );
  assert.match(
    background,
    /lastResolvedIdentityIds\s*=\s*allIdentityIds/,
    'the resolved identity must be remembered for the relay path'
  );

  const songsFetched = (background.match(/currentUserIds/g) || []).length;
  assert.ok(songsFetched >= 4,
    `every library message must carry the identity (found ${songsFetched} sites)`);
});

test('the panel records the identity the background sends', async () => {
  const source = await readDownloader();
  cachedSource = source;

  const body = extractFunctionBody(source, 'function applyCurrentUserIds(', 'applyCurrentUserIds');
  assert.match(body, /sunoUserIds\.add\(/,
    'the ids the background sends must be recorded');

  const pageHandler = source.slice(
    source.indexOf('if (message.action === "songs_page_update")'),
    source.indexOf('if (message.action === "songs_page_update")') + 400
  );
  assert.match(pageHandler, /applyCurrentUserIds\(message\.currentUserIds\)/,
    'the page update must record the identity');

  const fetchedHandler = source.slice(
    source.indexOf('if (message.action === "songs_fetched")'),
    source.indexOf('if (message.action === "songs_fetched")') + 400
  );
  assert.match(fetchedHandler, /applyCurrentUserIds\(message\.currentUserIds\)/,
    'the final payload must record the identity');
});
