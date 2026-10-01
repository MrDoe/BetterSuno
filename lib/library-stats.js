// lib/library-stats.js — pure aggregations over cached song records.
//
// Implements the aggregations from docs/library-stats-scope.md. Pure functions
// over plain records: no chrome, no DOM, no IndexedDB. That is what makes them
// unit-testable — the service worker and the content-script IIFEs cannot be
// imported into node:test, which is why this logic lives here rather than inline.
//
// THE ONE STAT: mostPlayedSongs() — all time.
//
// There is deliberately no time-bounded variant. `play_count` is a monotonically
// incremented integer and we record no play timestamps, so "played this week"
// would assert a period we cannot observe. Recency requires `last_played_at`,
// which is being added as a field only; the filter that would consume it is a
// separate, deferred decision. See the scope document.
//
// WHAT play_count COUNTS — keep this in sync with the UI copy, because the copy
// is the load-bearing part of the feature and no test covers it:
//
//   It counts plays routed through the BetterSuno player (togglePlay) and
//   nothing else. It excludes plays on suno.com itself. It INCLUDES
//   MCP-initiated playback, because that also goes through togglePlay — so a
//   count is not attributable to a human or to an agent, and must not be
//   described as "your plays" or "listening". And it covers only songs the
//   extension holds a record for: markSongPlayed() early-returns for songs
//   absent from allSongs and the current playlistSongs.
//
//   Any caller rendering this number must carry that qualifier. Dropping it
//   leaves every figure arithmetically correct while the panel claims something
//   broader — reintroducing exactly the artifact the scope exists to prevent,
//   with the suite green throughout.

/**
 * Coerce a stored play_count to a non-negative integer, mirroring
 * `normalizePlayCount` in downloader.js.
 *
 * The duplication is deliberate and the two MUST agree: `normalizePlayCount` is
 * a local inside downloader.js's IIFE and cannot be imported here, and a
 * numeric string is not junk data — it is data that legitimately arrives, and
 * production already treats "1" and 1 as the same count. Inventing a different
 * rule here would make the stats panel disagree with the badge it sits beside,
 * with no error anywhere.
 *
 * Behaviour that must stay in step (see tests/library-stats.test.js, which pins
 * each of these):
 *   - non-negative finite number -> Math.floor(value)
 *   - string                   -> trimmed, then parsed, then floored
 *   - anything else, or a negative/non-finite result -> 0 here (no plays)
 *
 * NOTE the deliberate difference: normalizePlayCount returns null for
 * unusable input where this returns 0. Both callers treat that as "no plays
 * counted", so the observable result is the same; the test asserts the
 * observable, not the return type.
 */
function playCountOf(song) {
  const raw = song?.play_count;

  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }

  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return 0;
}

/**
 * Most played songs, all time.
 *
 * Ordering: play_count descending, then created_at descending (newest first),
 * then id ascending as a final deterministic tiebreak. The last key matters —
 * ties must resolve identically across runs, otherwise the panel reshuffles
 * itself on every render and reads as a bug.
 *
 * Songs never played (play_count 0 or absent) are excluded. "Most played"
 * listing songs with a count of zero answers a question nobody asked.
 */
export function mostPlayedSongs(songs, limit = 10) {
  const list = Array.isArray(songs) ? songs : [];

  return list
    .filter((song) => song && playCountOf(song) > 0)
    .map((song, index) => ({
      id: song.id,
      title: song.title || 'Untitled',
      play_count: playCountOf(song),
      created_at: song.created_at || null,
      _index: index,
    }))
    .sort((a, b) => (
      b.play_count - a.play_count
      || String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? ''))
      || a._index - b._index
    ))
    .slice(0, Math.max(0, limit))
    .map(({ _index, ...rest }) => rest);
}

/**
 * How many songs carry the BetterSuno play count, and how many plays in total.
 *
 * `playedSongCount` is the honest denominator: it is smaller than the library
 * size, because markSongPlayed skips songs with no record. A panel showing
 * "3 plays" without "across 2 songs you have records for" invites the reader to
 * assume it covers the whole library.
 */
export function playCountSummary(songs) {
  const list = Array.isArray(songs) ? songs : [];
  let totalPlays = 0;
  let playedSongCount = 0;

  for (const song of list) {
    if (!song) continue;
    const count = playCountOf(song);
    if (count > 0) {
      totalPlays += count;
      playedSongCount += 1;
    }
  }

  return {
    totalPlays,
    playedSongCount,
    trackedSongCount: list.filter(Boolean).length,
  };
}

/**
 * Cache composition for the Settings view.
 *
 * Pure over audioCache record arrays ({songId, blob, timestamp, auto_cached}).
 * The READ of those records is IndexedDB and stays in the content script; this
 * only aggregates what is handed to it.
 *
 * Exposed separately from the play stats on purpose: it is about storage, not
 * listening, and merging the two views puts the "what this doesn't count"
 * qualifier in competition with an unrelated number for proximity to the play
 * count.
 */
export function summarizeCache(records, { maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const list = Array.isArray(records) ? records : [];

  let autoCached = 0;
  let manual = 0;
  let expiringSoon = 0;
  const oldestAgeDays = [];

  for (const record of list) {
    if (!record) continue;
    if (record.auto_cached === true) {
      autoCached += 1;
      continue;
    }
    manual += 1;

    const ts = typeof record.timestamp === 'number' ? record.timestamp : null;
    if (ts === null || !Number.isFinite(ts)) continue;

    const age = now - ts;
    oldestAgeDays.push(Math.floor(age / (24 * 60 * 60 * 1000)));

    // Untagged records age out via evictStaleBlobs after maxAgeMs. A record
    // already past that threshold has not been swept yet — which is exactly the
    // set the user would lose on the next sweep.
    if (age > maxAgeMs) expiringSoon += 1;
  }

  oldestAgeDays.sort((a, b) => b - a);

  return {
    total: autoCached + manual,
    autoCached,
    manual,
    // Records the next eviction will take. Auto-cached records are exempt from
    // the age sweep, so they are never counted here — only the size cap or an
    // explicit Delete from DB removes those.
    expiringSoon,
    oldestAgeDays: oldestAgeDays[0] ?? 0,
  };
}