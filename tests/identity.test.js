// tests/identity.test.js
//
// Identity is read from the __session JWT's own claims because window.Clerk no
// longer exists on authenticated Suno routes (verified 2026-09-27). If these
// break, identity silently reverts to "empty user" — which previously made
// ownership checks unable to prove anything.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeJwtClaims,
  getIdentityFromToken,
  getIdentityIds,
  getJwtExpiryMs,
} from '../lib/identity.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.signature`;

test('decodeJwtClaims reads the payload segment', () => {
  const claims = decodeJwtClaims(jwt({ sub: 'abc', 'suno/handle': 'artist' }));
  assert.equal(claims.sub, 'abc');
  assert.equal(claims['suno/handle'], 'artist');
});

test('decodeJwtClaims returns null instead of throwing on junk', () => {
  for (const bad of ['', null, undefined, 'not-a-jwt', 'a.b', 'a.!!!.c', 12345]) {
    assert.equal(decodeJwtClaims(bad), null, `expected null for ${String(bad)}`);
  }
});

test('getJwtExpiryMs converts exp seconds to ms and rejects non-exp', () => {
  assert.equal(getJwtExpiryMs(jwt({ exp: 1700000000 })), 1700000000000);
  assert.equal(getJwtExpiryMs(jwt({ exp: 0 })), null);
  assert.equal(getJwtExpiryMs(jwt({ exp: -5 })), null);
  assert.equal(getJwtExpiryMs(jwt({ nope: true })), null);
});

test('getIdentityFromToken prefers suno.com/claims/user_id', () => {
  const token = jwt({
    'suno.com/claims/user_id': '47168b06-b84b-496a-9fce-608ea950567b',
    'https://suno.ai/claims/clerk_id': 'user_abc123',
    sub: 'subject-uuid',
    'suno/handle': 'SomeArtist'
  });

  const identity = getIdentityFromToken(token);

  assert.equal(identity.id, '47168b06-b84b-496a-9fce-608ea950567b');
  assert.equal(identity.handle, 'someartist', 'handles are lowercased');
  assert.ok(identity.ids.includes('user_abc123'));
  assert.ok(identity.ids.includes('subject-uuid'));
});

test('getIdentityFromToken returns null when the token carries no identity', () => {
  assert.equal(getIdentityFromToken(jwt({ exp: 1 })), null);
  assert.equal(getIdentityFromToken(jwt({ sub: '   ' })), null);
  assert.equal(getIdentityFromToken('garbage'), null);
});

test('getIdentityFromToken accepts a handle-only token', () => {
  const identity = getIdentityFromToken(jwt({ 'suno/handle': 'someone' }));
  assert.equal(identity.id, null);
  assert.equal(identity.handle, 'someone');
  assert.deepEqual(identity.ids, []);
});

test('getIdentityIds dedupes, trims and prefers id + ids[]', () => {
  assert.deepEqual(
    getIdentityIds({ id: '  a  ', ids: ['a', 'b', '  ', 'b'] }),
    ['a', 'b']
  );
  assert.deepEqual(getIdentityIds(null), []);
  assert.deepEqual(getIdentityIds({}), []);
});
