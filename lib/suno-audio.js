// lib/suno-audio.js — Suno download-URL resolution and encrypted-audio decryption.
//
// Extracted from background.js (2026-09-28) because this cluster is provably
// dispatch-free: it touches `fetch` and `crypto.subtle` and nothing else. It
// reads no tabState, holds no module-level mutable state, never calls
// chrome.*/sendMessage, and never reaches the token cache — `token` is always a
// parameter. That is what makes it safe to move while the message dispatch stays
// inline, and it is why it went before the dispatch refactor (CODE_REVIEW [M1]).
//
// Deps are injected rather than imported so this module has no dependency on
// background.js state. `fetchFeedSongsByIds` and `extractMediaUrlFromClip` stay
// in background.js because other callers share them.

/** Shared request helper for the `/api/gen/{id}/wav_file/` + convert flow. */
export async function sunoWavRequest(path, { method = 'GET', token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  const res = await fetch(path, { method, headers });
  if (res.status === 204) return { ok: true, status: 204, body: null };
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.detail || body?.error || body?.message || '';
    } catch (e) {
      // body was not JSON
    }
    const err = new Error(`Suno WAV endpoint unavailable: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    err.status = res.status;
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { ok: true, status: 204, body };
}

// Resolve a real WAV download URL for a clip.
//
// The V6-era web client (downloadClipWav) no longer uses the old
// /api/download/clip route for WAV. It does:
//   1. GET  /api/gen/{clip_id}/wav_file/   -> {wav_file_url} if already converted
//   2. POST /api/gen/{clip_id}/convert_wav/ (204) to start conversion
//   3. poll GET wav_file/ every 5s (up to 24 tries) until {wav_file_url}
// The legacy endpoint is kept as a fallback. This route is metered by Suno's
// download credits, so callers must treat failures as non-fatal and fall back
// to the unlimited stream.
export async function resolveGenWavUrl(clipId, token, { delay } = {}) {
  const base = `https://studio-api.prod.suno.com/api/gen/${encodeURIComponent(clipId)}`;
  const wait = delay ?? ((ms) => new Promise(r => setTimeout(r, ms)));

  const initial = await sunoWavRequest(`${base}/wav_file/`, { token });
  if (initial.body?.wav_file_url) return initial.body.wav_file_url;

  await sunoWavRequest(`${base}/convert_wav/`, { method: 'POST', token });

  for (let attempt = 0; attempt < 24; attempt++) {
    await wait(5000);
    const polled = await sunoWavRequest(`${base}/wav_file/`, { token });
    if (polled.body?.wav_file_url) return polled.body.wav_file_url;
  }
  throw new Error('Timed out waiting for Suno WAV conversion');
}

export async function resolveLegacySunoDownloadUrl(clipId, format, token) {
  const path = `https://studio-api.prod.suno.com/api/download/clip/${encodeURIComponent(clipId)}?format=${encodeURIComponent(format)}`;
  const headers = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(path, { method: 'GET', headers });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.detail || body?.error || body?.message || '';
      } catch (e) {
        // body was not JSON
      }
      throw new Error(`Suno download unavailable: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    const data = await res.json();
    if (data?.download_url) return data.download_url;
    if (data?.status === 'error') throw new Error(data?.error || 'Suno download failed');
    if (attempt >= 1 && (data?.ok === false || data?.status === 'not_available')) {
      throw new Error(data?.detail || data?.error || 'Suno download not available');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for Suno download URL');
}

export async function resolveSunoDownloadUrl(clipId, format, token, { log, delay } = {}) {
  if (format === 'wav') {
    try {
      return await resolveGenWavUrl(clipId, token, { delay });
    } catch (e) {
      // One-time warning: a caller that omits `log` silently loses the fallback
      // diagnostic, which is exactly the case you want to know about when a WAV
      // download quietly degrades to the legacy endpoint.
      if (!log) {
        if (!resolveSunoDownloadUrl._warned) {
          resolveSunoDownloadUrl._warned = true;
          console.warn('[suno-audio] resolveSunoDownloadUrl called without a log dep; the convert_wav fallback diagnostic will be dropped');
        }
      } else {
        log(`resolveSunoDownloadUrl: convert_wav flow failed (${e.message}), trying legacy endpoint`);
      }
    }
  }
  return resolveLegacySunoDownloadUrl(clipId, format, token);
}

// ============================================================================
// Suno encrypted audio ("mango" / m4a-opus) — replicated from Suno's own player
// (their webpack module 913328 + the /api/mango/rights license flow).
//
// Suno now serves clip audio as an encrypted fragmented MP4. `audio_url` is a
// decoy (`/api/forbidden`); the real stream lives in `media_urls[]` as an
// entry with `encoding` set (e.g. cloudfront m4a-opus). To play it:
//   1. POST /api/mango/rights  -> { key, iv, glt }  (AES-GCM-wrapped AES-CTR key)
//   2. userKey = SHA-256(bearer token) or SHA-256(glt) for guests
//   3. unwrap key/iv via AES-GCM (additionalData = clipId)
//   4. fetch the encrypted media, AES-CTR decrypt the whole stream
//   5. the result is a plain MP4 -> blob -> audio element (no MSE needed)
// ============================================================================

// NOTE: the keys returned here are imported with usages ['decrypt'] only. A test
// (or any caller) that needs to build a reference fixture with the same material
// must import its own encrypt-capable key from the same raw bytes — using these
// keys to encrypt throws. See tests/suno-audio.test.js `gcmKeyForWrapping`.
export async function sunoGetUserKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
}

export function sunoToWrappedKey(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function sunoDecodeContentKey(wrapped, contentId, userKey) {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: new TextEncoder().encode(contentId) },
    userKey,
    wrapped.slice(12)
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CTR' }, false, ['decrypt']);
}

export async function sunoDecodeContentIv(wrapped, contentId, userKey) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: new TextEncoder().encode(contentId) },
    userKey,
    wrapped.slice(12)
  ));
}

// `iv` is the 12-byte content IV from the license, NOT a full counter block.
// WebCrypto requires a 16-byte AES-CTR counter, so the IV is zero-extended here
// by writing into a 16-byte buffer. Passing a 12-byte buffer straight to
// WebCrypto throws validateByteLength, which reads like a WebCrypto bug rather
// than a fixture mistake. `add` is in 16-byte blocks, not bytes.
export function sunoIncrementCounter(iv, add) {
  const out = new Uint8Array(16);
  if (out.set(iv), add === 0) return out;
  let n = BigInt(0);
  for (let i = 0; i < 16; i++) n = (n << BigInt(8)) | BigInt(out[i]);
  n += BigInt(add);
  for (let i = 15; i >= 0; i--) { out[i] = Number(n & BigInt(255)); n >>= BigInt(8); }
  return out;
}

export async function sunoAesCtrDecryptFull(key, iv, data, chunkSize = 65536) {
  const out = [];
  let carry = new Uint8Array(0);
  let counter = 0;
  for (let pos = 0; pos < data.length; pos += chunkSize) {
    const slice = data.slice(pos, pos + chunkSize);
    const merged = new Uint8Array(carry.length + slice.length);
    merged.set(carry); merged.set(slice, carry.length);
    const fullLen = 16 * Math.floor(merged.length / 16);
    if (fullLen > 0) {
      const ctr = sunoIncrementCounter(iv, counter);
      const dec = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: ctr, length: 128 },
        key,
        merged.buffer.slice(merged.byteOffset, merged.byteOffset + fullLen)
      ));
      out.push(dec);
      counter += fullLen / 16;
    }
    carry = merged.slice(fullLen);
  }
  if (carry.length > 0) {
    const ctr = sunoIncrementCounter(iv, counter);
    out.push(new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: ctr, length: 128 },
      key,
      carry.buffer.slice(carry.byteOffset, carry.byteOffset + carry.byteLength)
    )));
  }
  const total = out.reduce((a, b) => a + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of out) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// Fetches the license + media and returns decrypted audio bytes for a clip.
// Encrypted media URL is the `media_urls[]` entry with `encoding` set.
export async function resolveSunoAudioBytes(clipId, encryptedUrl, token, {
  fetchFeedSongsByIds,
  extractMediaUrlFromClip,
} = {}) {
  // If we only have the decoy/stale URL (older cached clips stored `audio_url`
  // as /api/forbidden before the media_urls change), re-fetch the clip from the
  // feed to obtain the real encrypted media URL. Suno's own player does the same
  // (POST /api/feed/v3 with filters.ids.clipIds).
  if (!encryptedUrl || /forbidden/i.test(String(encryptedUrl))) {
    const lookup = await fetchFeedSongsByIds(token, [clipId], { logPrefix: 'resolve_suno_audio' });
    const clip = Array.isArray(lookup?.clips) ? lookup.clips[0] : null;
    const media = extractMediaUrlFromClip(clip);
    encryptedUrl = media?.url || null;
    if (!encryptedUrl) throw new Error('No playable media URL for clip');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const rightsResp = await fetch('https://studio-api-prod.suno.com/api/mango/rights', {
    method: 'POST',
    cache: 'no-store',
    headers,
    credentials: 'include',
    body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } })
  });
  if (!rightsResp.ok) throw new Error(`Suno license request failed: HTTP ${rightsResp.status}`);
  const rights = await rightsResp.json();
  if (!rights?.key || !rights?.iv) throw new Error('Suno license response missing key/iv');

  const userKey = token && rights.glt
    ? await sunoGetUserKey(token)
    : await sunoGetUserKey(rights.glt || token);
  const aesKey = await sunoDecodeContentKey(sunoToWrappedKey(rights.key), clipId, userKey);
  const aesIv = await sunoDecodeContentIv(sunoToWrappedKey(rights.iv), clipId, userKey);

  const mediaResp = await fetch(encryptedUrl, { cache: 'no-store' });
  if (!mediaResp.ok) throw new Error(`Suno media fetch failed: HTTP ${mediaResp.status}`);
  const encData = new Uint8Array(await mediaResp.arrayBuffer());
  return await sunoAesCtrDecryptFull(aesKey, aesIv, encData);
}
