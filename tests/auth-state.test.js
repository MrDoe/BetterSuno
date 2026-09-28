// tests/auth-state.test.js
//
// Guards the background-owned auth boundary. These are the invariants that must
// never regress silently, so they are asserted explicitly rather than by
// snapshotting the allowlists.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKGROUND_AUTH_STATE_KEYS,
  PERSIST_FIELDS,
  toAuthSafeState,
  toPersistableState,
} from '../lib/auth-state.js';

test('toAuthSafeState strips every background-owned auth field', () => {
  const state = {
    enabled: true,
    intervalMs: 30000,
    notifications: [{ id: 1 }],
    token: 'secret-bearer',
    tokenTimestamp: 1700000000000,
    tokenExpiresAt: 1700003600000,
    tokenRefreshPromise: 'pending',
    clerkSessionToken: 'session',
    clerkSessionExpiry: 123,
    lastAuthFailure: 'no-clerk'
  };

  const safe = toAuthSafeState(state);

  for (const key of BACKGROUND_AUTH_STATE_KEYS) {
    assert.equal(key in safe, false, `${key} must not survive toAuthSafeState`);
  }
  assert.equal(safe.enabled, true);
  assert.equal(safe.intervalMs, 30000);
  assert.deepEqual(safe.notifications, [{ id: 1 }]);
});

test('toAuthSafeState does not mutate its input', () => {
  const state = { enabled: true, token: 'secret' };
  toAuthSafeState(state);
  assert.equal(state.token, 'secret', 'input object must be left untouched');
});

test('toAuthSafeState tolerates null/undefined and returns a fresh object', () => {
  assert.deepEqual(toAuthSafeState(null), {});
  assert.deepEqual(toAuthSafeState(undefined), {});
});

test('PERSIST_FIELDS cannot leak any auth field to IndexedDB', () => {
  // The persistence path is an ALLOWLIST, so this is the real containment: even
  // if a future caller stuffs a token into tab state, saveState cannot write it.
  for (const key of BACKGROUND_AUTH_STATE_KEYS) {
    assert.equal(PERSIST_FIELDS.includes(key), false, `${key} must never be persisted`);
  }
});

test('toPersistableState keeps only allowlisted fields', () => {
  const st = {
    enabled: false,
    intervalMs: 15000,
    notifications: [],
    token: 'secret-bearer',
    clerkSessionToken: 'session',
    somethingElse: 'dropped'
  };

  const saved = toPersistableState(st);

  // Values are copied for every allowlisted field (absent ones read undefined,
  // matching saveState's original behaviour). What matters is that nothing
  // outside the allowlist can appear in persisted state.
  assert.equal(saved.enabled, false);
  assert.equal(saved.intervalMs, 15000);
  assert.deepEqual(saved.notifications, []);

  assert.equal('token' in saved, false);
  assert.equal('clerkSessionToken' in saved, false);
  assert.equal('somethingElse' in saved, false);

  for (const key of Object.keys(saved)) {
    assert.ok(PERSIST_FIELDS.includes(key), `${key} escaped the allowlist into persisted state`);
  }
});
