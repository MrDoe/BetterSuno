// lib/identity.js — bearer-token claim decoding and current-user identity.
//
// Identity is read from the __session JWT's own claims because Suno no longer
// exposes a Clerk browser SDK: `window.Clerk` is absent on every authenticated
// route, so any page-context identity read returns empty. The token is the
// credential the API actually accepts, so its claims are the most direct
// identity source available — and they need no Suno tab.
//
// Claims only LABEL data. They never authorise anything: ownership decisions
// still require explicit per-song metadata or a server response.

import { collectNormalizedIds, normalizeHandle, pickFirstNonEmptyString } from './util.js';

export function decodeJwtClaims(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const claims = JSON.parse(atob(padded));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

export function getJwtExpiryMs(token) {
  const exp = Number(decodeJwtClaims(token)?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1000;
}

/**
 * Identity carried by the bearer token's own claims.
 *
 * The `__session` JWT carries: `suno.com/claims/user_id` (which matches the
 * `user_id` on the account's own feed clips), `https://suno.ai/claims/clerk_id`,
 * `sub`, and `suno/handle`.
 */
export function getIdentityFromToken(token) {
  const claims = decodeJwtClaims(token);
  if (!claims) {
    return null;
  }

  const ids = collectNormalizedIds([
    claims['suno.com/claims/user_id'],
    claims['https://suno.ai/claims/clerk_id'],
    claims.sub
  ]);
  const handle = normalizeHandle(pickFirstNonEmptyString([
    claims['suno/handle'],
    claims['https://suno.ai/claims/handle']
  ]));

  if (ids.length === 0 && !handle) {
    return null;
  }

  return { id: ids[0] || null, ids, handle, displayName: null };
}

export function getIdentityIds(identity) {
  return collectNormalizedIds([
    identity?.id,
    ...(Array.isArray(identity?.ids) ? identity.ids : [])
  ]);
}
