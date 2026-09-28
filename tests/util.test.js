// tests/util.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectNormalizedIds, normalizeHandle, pickFirstNonEmptyString } from '../lib/util.js';

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
