# Library Stats — Scope

**Status:** scope for review. No implementation until this is agreed.
**Date:** 2026-10-01
**Reviewed by:** pending (peer session `ses_f1658ab75ffeGBqnl1AveBSezW`)

## The premise, and the trap in it

The extension already collects `play_count` on every play, badges it, filters on it, and
exposes it to MCP — and never *reads* it. Same for the cache: auto-caching, a usage display, an
offline filter, and manual delete exist, with no view of what is cached or why.

That is a real gap. But "the data exists, so just display it" is the exact reasoning that
produced the four plausible-but-wrong artifacts catalogued during the 2.5.0 work. This feature
reads numbers the extension does not fully maintain. The scope therefore spends as much on what
the numbers do *not* mean as on what they do.

## What I verified in the source myself

| Claim | Where | Status |
|---|---|---|
| `markSongPlayed` increments `play_count` and nothing else | `downloader.js:1927` | verified |
| No play timestamp exists anywhere | `grep -rE "last_played\|played_at"` → 0 hits | verified |
| `timestamp` is a record-write marker, not a play time | `content-idb.js:134`, moves on every metadata refresh | verified |
| `markSongPlayed` early-returns `false` for songs absent from `allSongs`/`playlistSongs` | `downloader.js:1927` | verified |
| `mergeSongMetadata` spreads `existingSong`, so unknown local fields survive | `downloader.js:669`, `:690` | verified |
| `areSongDetailsEqual` compares `play_count`, `is_stem`, `model_name` | `downloader.js:646-667` | verified |
| `audioCache` records are `{songId, blob, timestamp, auto_cached}` | `content-idb.js:134` | verified |
| **`areSongDetailsEqual` does not gate persistence** — at both call sites (`:3311`, `:3385`) it only drives a counter / `changedIds`, which in turn only drives `applyFilter` + `saveToStorage` | `:3311`, `:3385`, `:3413` | verified |

### The last row matters more than it looks

Asked whether a `last_played_at` bump would be swallowed by a library sync: **no.** The save is not
gated by the equality check, and `mergeSongMetadata`'s `...existingSong` spread preserves a
local-only field regardless. The real consequence is narrower: a change the equality function does
not compare will not trigger `applyFilter`, so the panel would not refresh in place — the same
behaviour `play_count` already has by being in the comparison set. Failure mode is **cosmetic, not
data loss**. The field therefore still belongs in the comparison set, but the reason is "so the UI
updates without a reload", not "or the write is lost".

*(Both function names above were named by the peer from recall rather than a fresh read; I then read
both bodies, which is why this row is marked verified.)*

## Peer-reported, NOT re-verified at implementation time

The `songsList` field list (`id, title, created_at, model_name, major_model_version, play_count,
upvote_count, is_liked, is_public, is_stem, task, cover_clip_id, is_owned_by_current_user,
owner_handle`) came from the peer session reading the records while building the eviction tests —
a different part of the codebase, days ago. **Re-read before building.** If something drifted, the
implementation says so rather than inheriting that confidence.

Likewise: whether `get_library_stats {source:"db"}` returns enough to derive these aggregations is
**unread**. This scope does not assume it does.

## What the numbers actually mean

`play_count` counts **plays routed through the BetterSuno player**, and nothing else:

- It excludes every play on suno.com itself.
- It includes MCP-initiated playback, because that also goes through `togglePlay`. A count of 3
  may be three human clicks or one agent playing a track three times. It is **not attributable**
  to a human or an agent, and the UI must not imply either.
- It excludes songs the extension holds no record for (§ early return).

Consequences the UI copy must carry: **no "your plays", no "listening", no time period.** The only
honest stat is *most played, all time*. A "last 7 days" card would assert a period we do not
observe — we hold a monotonically incremented integer and no play timestamps.

Also note the play_count set and the auto_cached set are **close, not identical**: both fire from
`togglePlay`, but auto-cache accepts any song object while `markSongPlayed` requires a library or
playlist record. Their divergence is the interesting case (a track you keep playing that is not in
your library), so the panel should present one number, not two that look like independent
confirmation.

## Scope decision required: `last_played_at`

Recency is not implementable today and adding the field is **cheaper now than later**, because it
would only ever be correct going forward.

Proposed: add `last_played_at`, written on every play, **independent of `markSongPlayed`'s early
return**. Inheriting that return would reproduce the exact blind spot we are trying to remove —
the timestamp would be silently missing for exactly the songs that are most interesting.

Two consequences to accept:
1. Existing records have no value. No migration is worth it; the field is correct from release on.
2. It should be added to `areSongDetailsEqual`, so a play refreshes the panel in place. Note this
   is a UI-refresh concern, **not** a persistence concern — see the verified table above.

**Decision needed:** add now (unlocks "recently played" as a *filter*, reusing existing sort
machinery) or defer (ships no recency feature this cycle).

## Shape

**Pure logic in `lib/library-stats.js`** — same reasoning that made the `suno-audio` split safe.
Aggregations over an array of song records, no `chrome`, no DOM, directly unit-testable.

Song aggregations are pure. Cache composition is also pure, but its **read** is IndexedDB and stays
in the content script — the stub-at-the-boundary shape used by the eviction test.

### Two placements, deliberately separate

- **Song stats** → in the Song Library panel. *Most played, all time* is the only stat proposed.
  "Recently played" is a **filter**, not a stat: a stat nobody reads twice must be maintained
  forever, and a filter reuses the existing sort/filter machinery.
- **Cache composition** → a separate Settings view. It is about storage, not listening; merging
  them puts the "what this doesn't count" qualifier in competition with an unrelated number for
  proximity to the play count.

## Deliberately out of scope

- Any claim about total listening, or any time-bounded stat.
- `get_library_stats {source:"db"}` integration — unread, so not designed against.
- Deriving `play_count` from the API — it is a local count merged with `Math.max`; that is
  deliberate and not in question here.

## Tests

`tests/library-stats.test.js`, pure functions against fixed record fixtures:

- missing/null `play_count` treated as 0, not dropped
- a song played more often ranks first; ties are stable, not arbitrary
- songs with no `created_at` do not break aggregation
- empty input returns an empty result, not a throw

The UI copy itself is **not** unit-testable. That qualifier is reviewed by reading it, which is a
weak check — acknowledged rather than papered over.