// tests/ownership.test.js
//
// The download gate. The asymmetry here is a deliberate decision and the tests
// exist to stop someone "tightening" it:
//
//   Only EXPLICIT evidence that a song belongs to someone else blocks a
//   download. Inconclusive ownership allows it. A false block costs the user
//   their own song; a false allow is caught by the API downstream.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isSongExplicitlyKnownToBeOtherArtist } from '../lib/ownership.js';

test('blocks only on explicit negative ownership flags', () => {
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: false }), true);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_own_song: false }), true);
});

test('allows when ownership is positive', () => {
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: true }), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_own_song: true }), false);
});

test('allows when ownership is merely absent — never block on inference', () => {
  // This is the regression guard. canDownloadSongForIdentity used to infer a
  // mismatch from unrelated UUID forms; it was dead code, and its logic must not
  // come back in a form that blocks a user's own song.
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({}), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ title: 'x' }), false);
  assert.equal(
    isSongExplicitlyKnownToBeOtherArtist({ owner_user_id: 'someone-elses-uuid' }),
    false
  );
});

test('only strict false blocks — truthy/falsy lookalikes do not', () => {
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: 0 }), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: 'false' }), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: null }), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist({ is_owned_by_current_user: undefined }), false);
});

test('handles null/undefined songs without throwing', () => {
  assert.equal(isSongExplicitlyKnownToBeOtherArtist(null), false);
  assert.equal(isSongExplicitlyKnownToBeOtherArtist(undefined), false);
});
