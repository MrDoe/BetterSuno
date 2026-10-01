# Library Stats — Scope

**Status:** approved 2026-10-01. Not yet implemented.
**Date:** 2026-10-01
**Reviewed by:** peer session `ses_f1658ab75ffeGBqnl1AveBSezW` — all eight citations in the verified
table re-checked and confirmed; approved as written

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
| The object returned by `mergeSongMetadata` spreads `...existingSong`, so local-only fields survive a merge. **The spread is inside the `return`, below the reaction-state resolution** — not at the top of the function | `downloader.js:689-690` | verified |
| `areSongDetailsEqual` compares `play_count`, `is_stem`, `model_name` | `downloader.js:646-667` | verified |
| `audioCache` records are `{songId, blob, timestamp, auto_cached}` | `content-idb.js:134` | verified |
| **`changedIds` gates `saveToStorage()`** at `:3413` (`if (changedIds.size > 0)`), with the `applyFilter` re-render inside that same block | `:3385`, `:3413` | verified |

### The last two rows matter more than they look

Asked whether a `last_played_at` bump would be swallowed by a library sync. The precise answer
separates two things that are easy to conflate:

- **The record survives.** `mergeSongMetadata`'s returned object spreads `...existingSong`, so a
  local-only field is preserved regardless of what the equality check compares.
- **The save is gated.** `changedIds` — populated from `areSongDetailsEqual` — gates
  `saveToStorage()`. A field the comparison ignores will not, by itself, trigger a write from this
  path, nor re-render the filter.

So the failure mode is **not data loss**. It is a field that is correct on disk and stale in the
panel — arguably worse to diagnose, because nothing looks broken. `last_played_at` therefore
belongs in the comparison set, and the reason is "so the panel refreshes without a reload", not
"or the write is lost".

*(Both function names were first named by the peer from recall rather than a fresh read; both bodies
were then read, which is why these rows are marked verified. Corrected after peer review: an earlier
draft said the merge "begins with" the spread, and that `changedIds` merely "drives" the save —
both inaccurate, and both would have been misread by anyone grepping at the top of the function.)*

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

## Decision: add `last_played_at` now — as a field only, not a feature

Agreed on review. The field and the recency UI are **separate decisions with different expiry
dates**, and the original draft of this document wrongly bundled them into one question, which made
the cheap thing look contingent on the expensive one.

- **Field: add now.** ~2 lines. Its only cost is that existing records have no value, and that cost
  grows with every release skipped — the value is only ever correct going forward, so it decays
  exactly as fast as it is deferred. Adding it forecloses nothing.
- **Filter: defer.** The "recently played" *filter* is a UI decision depending on sort machinery
  and on what "recently" should mean when records only have the field for six weeks. Its cost is
  roughly flat. Do not build it yet.

Write it on every play, **independent of `markSongPlayed`'s early return** — see the implementation
notes below for why that matters more than it looks.

Two consequences to accept:
1. Existing records have no value. No migration is worth it; the field is correct from release on.
2. Add it to `areSongDetailsEqual`, so a play re-renders the panel in place. Without it the value is
   still written correctly on disk — it just goes stale in the UI. See the verified table above for
   why those are different failures.

## Implementation notes (requirements, not suggestions)

**1. The write must be visibly separate from `markSongPlayed`, with a comment saying why.**
The instinct at implementation time will be to fold it into `bumpPlayCount`, where it looks
tidier. Folding it in reintroduces `markSongPlayed`'s early return as the blind spot, and does so
in a way that reads as *good* engineering — which is what makes it dangerous. The comment must name
the early return as the reason the write lives elsewhere, not merely state its location.

**2. The UI copy must carry a comment naming the qualifier it has to keep.**
The copy is simultaneously the load-bearing part of this feature *and* the part no test touches.
Those compound: a later edit that drops "via the BetterSuno player" leaves every number
arithmetically correct while the panel quietly claims something broader — reintroducing precisely
the artifact this scope exists to prevent, with the suite green throughout. A one-line comment beside
the string is proportionate insurance for whoever edits it without reading this document.

Both notes belong in this document as well as the code, so the reasoning survives a refactor.

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