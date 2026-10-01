// tests/library-stats.test.js
//
// Covers lib/library-stats.js, the pure aggregations behind the library-stats
// panel (docs/library-stats-scope.md).
//
// These tests cannot check the part that matters most: the UI copy that tells
// the user what play_count does and does not count. The copy is load-bearing
// and no test touches it, which is why lib/library-stats.js carries the same
// qualification in its header — the comment beside the string is the only
// guard, and a well-meaning edit that drops the qualifier reintroduces exactly
// the artifact this scope exists to prevent, with this suite green throughout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  mostPlayedSongs,
  playCountSummary,
  summarizeCache,
} from '../lib/library-stats.js';

const song = (id, play_count, created_at = '2026-09-01T00:00:00Z', title = `Song ${id}`) => ({
  id, play_count, created_at, title
});

test('mostPlayedSongs ranks by play count, descending', () => {
  const out = mostPlayedSongs([song('a', 1), song('b', 9), song('c', 5)], 10);
  assert.deepEqual(out.map(s => s.id), ['b', 'c', 'a']);
  assert.deepEqual(out.map(s => s.play_count), [9, 5, 1]);
});

test('mostPlayedSongs excludes songs never played', () => {
  const out = mostPlayedSongs([song('a', 0), song('b', 3), song('c', null), song('d', undefined)]);
  assert.deepEqual(out.map(s => s.id), ['b']);
});

test('mostPlayedSongs tolerates junk play_count values without throwing', () => {
  const out = mostPlayedSongs([
    song('neg', -5),
    song('nan', NaN),
    song('str', '4'),
    { id: 'numstr', play_count: '7', title: 'x' },
    { id: 'ok2', play_count: 3, title: 'x' },
    { id: 'ok', play_count: 2, title: 'x' },
    null,
    undefined
  ]);
  // Negative and NaN count as no plays and drop out; numeric strings are real data.
  assert.deepEqual(out.map(s => s.id), ['numstr', 'str', 'ok2', 'ok']);
  assert.deepEqual(out.map(s => s.play_count), [7, 4, 3, 2]);
});

// These pin the coercion to normalizePlayCount (downloader.js), because a
// numeric string is not junk — production already treats "1" and 1 as the same
// count. A different rule here would make the stats panel disagree with the
// badge beside it, silently.
test('play_count coercion matches normalizePlayCount for every input shape', () => {
  const cases = [
    [1, 1], [0, 0], [1.7, 1], [42, 42],
    ['4', 4], ['  7  ', 7], ['1e3', 1000], ['', 0],
    [-1, 0], [NaN, 0], ['abc', 0], [null, 0], [undefined, 0], [true, 0], [{}, 0]
  ];

  for (const [input, expected] of cases) {
    const out = mostPlayedSongs([{ id: 'x', play_count: input, title: 'x' }]);
    const actual = out.length === 0 ? 0 : out[0].play_count;
    assert.equal(actual, expected,
      `play_count ${JSON.stringify(input)} should coerce to ${expected}, got ${actual}`);
  }
});

test('mostPlayedSongs ties resolve deterministically, newest first', () => {
  const rows = [
    song('old', 4, '2026-01-01T00:00:00Z'),
    song('new', 4, '2026-09-01T00:00:00Z'),
    song('mid', 4, '2026-05-01T00:00:00Z')
  ];
  const first = mostPlayedSongs(rows).map(s => s.id);
  const second = mostPlayedSongs([...rows].reverse()).map(s => s.id);
  assert.deepEqual(first, ['new', 'mid', 'old']);
  assert.deepEqual(second, first, 'input order must not change the result');
});

test('mostPlayedSongs falls back to id ordering when created_at is missing', () => {
  const rows = [
    { id: 'zz', play_count: 2, title: 'a' },
    { id: 'aa', play_count: 2, title: 'b' }
  ];
  assert.deepEqual(mostPlayedSongs(rows).map(s => s.id), ['aa', 'zz']);
});

test('mostPlayedSongs handles empty and non-array input without throwing', () => {
  assert.deepEqual(mostPlayedSongs([]), []);
  assert.deepEqual(mostPlayedSongs(null), []);
  assert.deepEqual(mostPlayedSongs(undefined), []);
  assert.deepEqual(mostPlayedSongs('nonsense'), []);
});

test('mostPlayedSongs honours limit and clamps a negative limit to empty', () => {
  const rows = [song('a', 3), song('b', 2), song('c', 1)];
  assert.equal(mostPlayedSongs(rows, 2).length, 2);
  assert.deepEqual(mostPlayedSongs(rows, 0), []);
  assert.deepEqual(mostPlayedSongs(rows, -1), []);
});

test('mostPlayedSongs titles fall back rather than rendering undefined', () => {
  const out = mostPlayedSongs([{ id: 'x', play_count: 1 }]);
  assert.equal(out[0].title, 'Untitled');
});

test('playCountSummary reports the honest denominator', () => {
  const s = playCountSummary([song('a', 3), song('b', 0), song('c', 4), null]);
  assert.equal(s.totalPlays, 7);
  // Only songs with a non-zero count, because that is what markSongPlayed writes.
  assert.equal(s.playedSongCount, 2);
  assert.equal(s.trackedSongCount, 3);
});

test('playCountSummary on an empty library returns zeroes, not NaN', () => {
  const s = playCountSummary([]);
  assert.deepEqual(s, { totalPlays: 0, playedSongCount: 0, trackedSongCount: 0 });
});

test('summarizeCache separates auto-cached from manual records', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const out = summarizeCache([
    { songId: 'a', timestamp: now - 1 * day, auto_cached: true },
    { songId: 'b', timestamp: now - 2 * day, auto_cached: true },
    { songId: 'c', timestamp: now - 1 * day },
    { songId: 'd', timestamp: now - 30 * day }
  ], { now });

  assert.equal(out.total, 4);
  assert.equal(out.autoCached, 2);
  assert.equal(out.manual, 2);
});

test('summarizeCache counts only untagged records as expiring', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const out = summarizeCache([
    // Auto-cached records are exempt from the age sweep, however old.
    { songId: 'ancient-auto', timestamp: now - 400 * day, auto_cached: true },
    { songId: 'old-manual', timestamp: now - 30 * day },
    { songId: 'fresh-manual', timestamp: now - 2 * day }
  ], { now });

  assert.equal(out.expiringSoon, 1, 'only the untagged record past 7 days');
  assert.equal(out.autoCached, 1);
  assert.equal(out.oldestAgeDays, 30, 'the 400-day auto-cached record is not counted as expiring');
});

test('summarizeCache reports the oldest untagged record age', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const out = summarizeCache([
    { songId: 'a', timestamp: now - 3 * day },
    { songId: 'b', timestamp: now - 12 * day },
    { songId: 'c', timestamp: now - 5 * day }
  ], { now });
  assert.equal(out.oldestAgeDays, 12);
});

test('summarizeCache skips records with no usable timestamp', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const out = summarizeCache([
    { songId: 'noTs' },
    { songId: 'badTs', timestamp: 'yesterday' },
    { songId: 'ok', timestamp: now }
  ], { now });

  assert.equal(out.manual, 3, 'still counted as records');
  assert.equal(out.expiringSoon, 0);
  assert.equal(out.oldestAgeDays, 0);
});

test('summarizeCache on an empty cache returns zeroes', () => {
  assert.deepEqual(summarizeCache([]), {
    total: 0, autoCached: 0, manual: 0, expiringSoon: 0, oldestAgeDays: 0
  });
});

// The chrome-free invariant is the only reason this module is in lib/ at all:
// a `chrome` or DOM reference would make it unimportable by node:test and the
// whole point would evaporate. Nothing mechanical guards that today, so it is
// asserted here rather than left as a convention.
test('lib/ stays free of chrome, DOM and side-effect dependencies', async () => {
  const src = await readFile(
    new URL('../lib/library-stats.js', import.meta.url),
    'utf8'
  );
  // Strip comments so prose about chrome.* does not trip the check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of ['chrome.', 'document.', 'window.', 'indexedDB', 'fetch(', 'localStorage']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `library-stats.js references ${forbidden} — lib/ must stay pure so node:test can import it`
    );
  }
});

test('only strict true counts as auto-cached', () => {
  const out = summarizeCache([
    { songId: 'a', auto_cached: true },
    { songId: 'b', auto_cached: 'true' },
    { songId: 'c', auto_cached: 1 },
    { songId: 'd' }
  ]);
  assert.equal(out.autoCached, 1);
  assert.equal(out.manual, 3);
});