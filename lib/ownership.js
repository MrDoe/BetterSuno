// lib/ownership.js — the download ownership gate.
//
// Extracted from background.js so the rule is testable in isolation without
// loading the 6.5k-line service worker.
//
// There is exactly ONE ownership gate, and it is deliberately conservative.
//
//   isSongExplicitlyKnownToBeOtherArtist — trusts ONLY explicit per-song
//     metadata from the fetched library payload (is_owned_by_current_user ===
//     false, or is_own_song === false). Unknown or inconclusive ownership
//     returns false, so the download is allowed.
//
// The asymmetry is intentional: a false block costs the user access to their
// own song, while a false allow is caught downstream by the API itself. The
// extension must never be the component that decides a song is not yours on
// incomplete evidence.
//
// REMOVED 2026-09-28 (Tier 4 cleanup) as verified dead code, with no call
// sites: canDownloadSongForIdentity, isSongOwnedByIdentity,
// hasSongOwnershipMetadata, getNormalizedSongOwnerIds,
// getNormalizedSongOwnerHandles, collectUuidLikeIds.
//
// canDownloadSongForIdentity is worth calling out: it contained UUID/Clerk-id
// mismatch logic that WOULD have blocked other artists' downloads if it had
// ever run. A stored quirk claimed it was already doing so. It never ran — the
// function had zero call sites — so there was no regression, and removing it
// cannot introduce one.

export function isSongExplicitlyKnownToBeOtherArtist(song) {
  return !!song && (song.is_owned_by_current_user === false || song.is_own_song === false);
}
