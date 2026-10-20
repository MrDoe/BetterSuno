// tests/normalizer-field-set.test.js
//
// The library has two clip normalizers that feed one collection:
//
//   - `normalizeLibraryClip` (background.js) — the Refresh / library-sync path
//   - `normalizeSongClip`    (downloader.js)  — the scroll / hydration path
//
// Their field sets must stay identical. When they diverged (until 2026-10-09)
// songs that first arrived via Refresh were *invisible*, not merely chip-less:
// the Unplayed filter tests `song.play_count !== 0`, which is true for
// `undefined`, and the Model filter matched on a field the Refresh path never
// set. The scroll path then filled the fields in — so a song's visibility
// depended on whether the user happened to scroll.
//
// `mergeSongMetadata` is the third half of the invariant: it merges a fresh
// API record into an existing one. A field it does not carry is silently
// dropped on every metadata refresh. `video_cover_url` was missing from it,
// so a song that gained a cover video lost it again on the next refresh.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readDownloader = () => fs.readFile(path.join(ROOT, 'downloader.js'), 'utf8');
const readBackground = () => fs.readFile(path.join(ROOT, 'background.js'), 'utf8');

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
  assert.notEqual(at, -1, `expected the source to contain ${what}`);
  const parenOpen = source.indexOf('(', at);
  const parenClose = findClosingParen(source, parenOpen, what);
  return extractBraceBlock(source, source.indexOf('{', parenClose), what);
}

// The keys of the object literal a function returns. Good enough for a
// field-set comparison: the normalizers return a single object literal.
function returnedObjectKeys(source, needle, what) {
  const body = extractFunctionBody(source, needle, what);
  const keys = new Set();
  const re = /^\s{4,}([a-z_][a-z0-9_]*)\s*:/gm;
  let match;
  while ((match = re.exec(body)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

test('both clip normalizers emit the same ownership and cover fields', async () => {
  const background = await readBackground();
  const downloader = await readDownloader();

  const libraryKeys = returnedObjectKeys(background, 'function normalizeLibraryClip(', 'normalizeLibraryClip');
  const songKeys = returnedObjectKeys(downloader, 'function normalizeSongClip(', 'normalizeSongClip');

  // The background's normalizer spreads the ownership fields in from a helper
  // instead of writing them out, so they are checked there.
  const ownershipKeys = returnedObjectKeys(
    background,
    'function extractOwnershipMetadataFromClip(',
    'extractOwnershipMetadataFromClip'
  );

  // The fields the UI reads directly. A song that arrives without them is
  // invisible to the Unplayed and Model filters, not merely missing a chip.
  const required = [
    'play_count',
    'model_name',
    'major_model_version',
    'task',
    'cover_clip_id',
    'video_cover_url',
    'is_public',
    'is_stem',
    'upvote_count',
    'reaction_state',
    'is_liked',
    'created_at',
    'title',
    'audio_url',
    'image_url',
    'lyrics'
  ];

  for (const field of required) {
    assert.ok(libraryKeys.has(field),
      `normalizeLibraryClip must emit ${field} — the Refresh path and the scroll ` +
      'path feed one collection, and a missing field makes songs invisible to a filter');
    assert.ok(songKeys.has(field),
      `normalizeSongClip must emit ${field} — see the field-set invariant`);
  }

  for (const field of ['owner_user_id', 'owner_handle', 'owner_display_name', 'is_owned_by_current_user']) {
    assert.ok(ownershipKeys.has(field),
      `the Refresh path must emit ${field} — without it the panel cannot tell the ` +
      "user's own songs from other artists'");
    assert.ok(songKeys.has(field),
      `normalizeSongClip must emit ${field} — see the field-set invariant`);
  }
});

test('mergeSongMetadata carries every mutable field the normalizers emit', async () => {
  const downloader = await readDownloader();
  const merge = extractFunctionBody(downloader, 'function mergeSongMetadata(', 'mergeSongMetadata');

  // A field mergeSongMetadata does not mention is dropped on every metadata
  // refresh. `video_cover_url` was missing: a song that gained a cover video
  // lost it again on the next refresh.
  const mutable = [
    'title',
    'audio_url',
    'video_url',
    'video_cover_url',
    'image_url',
    'lyrics',
    'is_public',
    'reaction_state',
    'is_stem',
    'upvote_count',
    'play_count',
    'model_name',
    'major_model_version',
    'task',
    'cover_clip_id',
    'owner_user_id',
    'owner_handle',
    'owner_display_name',
    'is_owned_by_current_user'
  ];

  for (const field of mutable) {
    assert.match(merge, new RegExp(`\\b${field}\\b`),
      `mergeSongMetadata must merge ${field} — a field it does not carry is ` +
      'silently dropped on every metadata refresh');
  }
});

test('a changed cover video is noticed as a metadata change', async () => {
  const downloader = await readDownloader();
  const equal = extractFunctionBody(downloader, 'function areSongDetailsEqual(', 'areSongDetailsEqual');

  assert.match(equal, /video_cover_url/,
    'areSongDetailsEqual must compare video_cover_url, or a changed cover video ' +
    'is not reported as a change and the row is never refreshed');
});
