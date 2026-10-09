// tests/util.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectNormalizedIds,
  decodeDataUrl,
  isDataUrl,
  normalizeHandle,
  pickFirstNonEmptyString,
} from '../lib/util.js';

test('normalizeHandle strips @, trims and lowercases', () => {
  assert.equal(normalizeHandle('  @SomeArtist '), 'someartist');
  assert.equal(normalizeHandle('@@double'), 'double');
});

test('normalizeHandle rejects non-strings and empties', () => {
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle('   '), null);
  assert.equal(normalizeHandle('@'), null);
  assert.equal(normalizeHandle(null), null);
  assert.equal(normalizeHandle(42), null);
});

test('pickFirstNonEmptyString returns the first usable trimmed value', () => {
  assert.equal(pickFirstNonEmptyString(['', '  ', ' real ', 'later']), 'real');
  assert.equal(pickFirstNonEmptyString([null, undefined, 0, 'x']), 'x');
  assert.equal(pickFirstNonEmptyString([]), null);
  assert.equal(pickFirstNonEmptyString([null, '']), null);
});

test('collectNormalizedIds trims, drops non-strings, dedupes, keeps order', () => {
  assert.deepEqual(
    collectNormalizedIds([' a ', 'a', '', '   ', null, 7, 'b']),
    ['a', 'b']
  );
  assert.deepEqual(collectNormalizedIds([]), []);
});

test('isDataUrl detects data: URLs only', () => {
  assert.equal(isDataUrl('data:text/plain;base64,SGVsbG8='), true);
  assert.equal(isDataUrl('DATA:,x'), true);
  assert.equal(isDataUrl('https://suno.com/a'), false);
  assert.equal(isDataUrl('blob:https://suno.com/uuid'), false);
  assert.equal(isDataUrl(''), false);
  assert.equal(isDataUrl(null), false);
});

test('decodeDataUrl decodes base64 payloads', () => {
  const { bytes, mimeType } = decodeDataUrl('data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==');
  assert.equal(mimeType, 'text/plain');
  assert.deepEqual(bytes, new TextEncoder().encode('Hello, world!'));
});

test('decodeDataUrl percent-decodes plain payloads as UTF-8', () => {
  const { bytes, mimeType } = decodeDataUrl('data:text/plain,H%C3%A9llo%20w%C3%B6rld');
  assert.equal(mimeType, 'text/plain');
  assert.deepEqual(bytes, new TextEncoder().encode('Héllo wörld'));
});

test('decodeDataUrl defaults the media type to text/plain', () => {
  const { bytes, mimeType } = decodeDataUrl('data:,hi');
  assert.equal(mimeType, 'text/plain');
  assert.deepEqual(bytes, new TextEncoder().encode('hi'));
});

test('decodeDataUrl decodes an empty media type with base64', () => {
  const { bytes, mimeType } = decodeDataUrl('data:;base64,SGk=');
  assert.equal(mimeType, 'text/plain');
  assert.deepEqual(bytes, new TextEncoder().encode('Hi'));
});

test('decodeDataUrl rejects non-data and malformed URLs', () => {
  assert.throws(() => decodeDataUrl('https://suno.com/a'), /Not a data/);
  assert.throws(() => decodeDataUrl('data:text/plain'), /Malformed/);
});

