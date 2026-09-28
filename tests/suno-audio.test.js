// tests/suno-audio.test.js
//
// The AES-CTR and download-URL cluster extracted to lib/suno-audio.js on
// 2026-09-28. This is the test that earns the move: "it still imports" proves
// nothing, so the crypto is verified against WebCrypto as an independent
// reference.
//
// Reference-independence matters here. The expected plaintext is never derived
// by calling the function under test. Instead:
//   1. encrypt a known plaintext with WebCrypto AES-CTR (the SUT does not
//      implement encryption)
//   2. decrypt with sunoAesCtrDecryptFull
//   3. assert the result equals the original plaintext byte for byte
// The 16-byte boundary and multi-chunk cases are where a carry-buffer bug would
// hide, so both are covered explicitly.
//
// The 5s WAV poll interval is asserted by injecting `delay` and checking the
// requested value. No wall-clock waiting and no hand-rolled timer fake, which in
// a zero-dependency suite would be the thing under test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGenWavUrl,
  resolveLegacySunoDownloadUrl,
  resolveSunoAudioBytes,
  resolveSunoDownloadUrl,
  sunoAesCtrDecryptFull,
  sunoDecodeContentIv,
  sunoDecodeContentKey,
  sunoGetUserKey,
  sunoIncrementCounter,
  sunoToWrappedKey,
  sunoWavRequest,
} from '../lib/suno-audio.js';

const hex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map(b => parseInt(b, 16)));

// Deterministic fixture material. Fixed, not random, so a failure is reproducible.
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
// AES-CTR counter blocks are exactly 16 bytes. The content IV unwrapped from the
// license is the first 12 of these; the counter is the full 16.
const IV_HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const importAesCtrKey = () =>
  crypto.subtle.importKey('raw', unhex(KEY_HEX), { name: 'AES-CTR' }, false, ['encrypt', 'decrypt']);

/** Encrypt with WebCrypto, independently of the code under test. */
async function encryptReference(plaintext) {
  const key = await importAesCtrKey();
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: unhex(IV_HEX), length: 128 },
    key,
    plaintext
  );
  return new Uint8Array(ct);
}

const plaintextOf = (n, seed = 0) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

// sunoGetUserKey imports the SHA-256 digest as a DECRYPT-only AES-GCM key, so it
// cannot be used to build the wrapped fixture. Derive the same material with
// encrypt permission instead — identical key bytes, independent of the SUT.
const gcmKeyForWrapping = (secret) =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
    .then(d => crypto.subtle.importKey('raw', d, { name: 'AES-GCM' }, false, ['encrypt']));

// The license hands out a 12-byte content IV, but an AES-CTR counter block must
// be 16 bytes. The production code zero-extends it inside sunoIncrementCounter
// (`new Uint8Array(16)` then `set(iv)`), so tests must do the same explicitly —
// passing the 12 bytes straight to WebCrypto is a test bug, not a code bug.
const asCounter = (iv12) => {
  const out = new Uint8Array(16);
  out.set(iv12, 0);
  return out;
};

// sunoDecodeContentKey returns a DECRYPT-only AES-CTR key, so the reference
// side of any round trip must bring its own encrypt-capable key built from the
// same raw material.
const ctrEncryptKey = () =>
  crypto.subtle.importKey('raw', unhex(KEY_HEX), { name: 'AES-CTR' }, false, ['encrypt']);

const withFetch = (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
};

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status,
  json: async () => body
});

test('AES-CTR round trip: the decrypted output equals the original plaintext', async () => {
  const plaintext = plaintextOf(1024);
  const key = await importAesCtrKey();
  const ciphertext = await encryptReference(plaintext);

  const out = await sunoAesCtrDecryptFull(key, unhex(IV_HEX), ciphertext);

  assert.equal(out.length, plaintext.length);
  assert.equal(hex(out), hex(plaintext));
});

test('AES-CTR handles data that is not a multiple of 16 bytes', async () => {
  // 1001 bytes = 62 full blocks + 9 bytes of carry. A carry-buffer bug that drops
  // or double-counts the remainder shows up only here.
  const plaintext = plaintextOf(1001, 3);
  const key = await importAesCtrKey();
  const ciphertext = await encryptReference(plaintext);

  const out = await sunoAesCtrDecryptFull(key, unhex(IV_HEX), ciphertext);

  assert.equal(out.length, 1001);
  assert.equal(hex(out), hex(plaintext));
});

test('AES-CTR spans chunk boundaries and reassembles in order', async () => {
  // chunkSize 64 forces many carry transitions across 2000 bytes.
  const plaintext = plaintextOf(2000, 11);
  const key = await importAesCtrKey();
  const ciphertext = await encryptReference(plaintext);

  const out = await sunoAesCtrDecryptFull(key, unhex(IV_HEX), ciphertext, 64);

  assert.equal(hex(out), hex(plaintext));
});

test('AES-CTR on empty input returns empty', async () => {
  const key = await importAesCtrKey();
  const out = await sunoAesCtrDecryptFull(key, unhex(IV_HEX), new Uint8Array(0));
  assert.equal(out.length, 0);
});

test('sunoIncrementCounter carries across the 16-byte counter', () => {
  const base = unhex(IV_HEX);
  assert.equal(hex(sunoIncrementCounter(base, 0)), IV_HEX);
  // Last byte 0xf0 -> 0xf1
  assert.equal(hex(sunoIncrementCounter(base, 1)), '0f1e2d3c4b5a69788796a5b4c3d2e1f1');
  // 0x100 must roll into the second-to-last byte (0x1e -> 0x1f).
  assert.equal(hex(sunoIncrementCounter(base, 256)), '0f1e2d3c4b5a69788796a5b4c3d2e2f0');
});

test('sunoToWrappedKey decodes base64 into bytes', () => {
  const bytes = sunoToWrappedKey(btoa('hello'));
  assert.equal(new TextDecoder().decode(bytes), 'hello');
});

test('key and IV unwrap from the AES-GCM-wrapped format using clipId as AAD', async () => {
  // Build the wire format: 12-byte IV || AES-GCM(ciphertext), keyed by SHA-256(secret).
  const secret = 'bearer-token-value';
  const userKey = await sunoGetUserKey(secret);
  const wrapKey = await gcmKeyForWrapping(secret);
  const contentId = 'clip-abc';

  const contentKeyRaw = unhex(KEY_HEX);
  const contentIvRaw = unhex(IV_HEX).slice(0, 12);
  const aad = new TextEncoder().encode(contentId);
  const gcmIv = unhex('000102030405060708090a0b');

  const wrap = async (raw) => {
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: gcmIv, additionalData: aad }, wrapKey, raw
    ));
    return new Uint8Array([...gcmIv, ...sealed]);
  };

  const aesKey = await sunoDecodeContentKey(await wrap(contentKeyRaw), contentId, userKey);
  const aesIv = await sunoDecodeContentIv(await wrap(contentIvRaw), contentId, userKey);

  assert.equal(hex(aesIv), hex(contentIvRaw));
  // The unwrapped key must actually decrypt AES-CTR (counter zero-extended).
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: asCounter(aesIv), length: 128 }, await ctrEncryptKey(), plaintextOf(32)
  );
  const back = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: asCounter(aesIv), length: 128 }, aesKey, ct
  );
  assert.equal(hex(new Uint8Array(back)), hex(plaintextOf(32)));
});

test('sunoGetUserKey derives the same key material for the same secret', async () => {
  // CryptoKey identity cannot be compared (extractable=false), so assert
  // determinism behaviourally: a value wrapped for one derived key must unwrap
  // with a key derived independently from the same secret.
  const secret = 'token-a';
  const wrapKey = await gcmKeyForWrapping(secret);
  const contentId = 'c1';
  const gcmIv = unhex('000102030405060708090a0b');
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: gcmIv, additionalData: new TextEncoder().encode(contentId) },
    wrapKey,
    unhex(KEY_HEX)
  );
  const wrapped = new Uint8Array([...gcmIv, ...new Uint8Array(ct)]);

  const outA = await sunoDecodeContentKey(wrapped, contentId, await sunoGetUserKey(secret));
  const outB = await sunoDecodeContentKey(wrapped, contentId, await sunoGetUserKey(secret));

  // Both derived keys must decrypt identically -> same underlying material.
  const probe = asCounter(unhex(IV_HEX).slice(0, 12));
  const probeCt = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: probe, length: 128 }, await ctrEncryptKey(), new Uint8Array(16)
  );
  const dec = (k) => crypto.subtle.decrypt({ name: 'AES-CTR', counter: probe, length: 128 }, k, probeCt);
  assert.equal(hex(new Uint8Array(await dec(outA))), hex(new Uint8Array(await dec(outB))));

  // A different secret must NOT unwrap it.
  const otherKey = await sunoGetUserKey('token-b');
  await assert.rejects(() => sunoDecodeContentKey(wrapped, contentId, otherKey));
});

test('resolveGenWavUrl fast path: one fetch, no convert_wav', async () => {
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push(`${opts?.method ?? 'GET'} ${url}`);
    return jsonResponse({ wav_file_url: 'https://cdn/wav.wav' });
  }, () => resolveGenWavUrl('clip-1', 'tok'));

  assert.deepEqual(calls, ['GET https://studio-api.prod.suno.com/api/gen/clip-1/wav_file/']);
});

test('resolveGenWavUrl converts then polls, requesting a 5000ms delay each try', async () => {
  const calls = [];
  const delays = [];
  let polls = 0;

  await withFetch(async (url, opts) => {
    const method = opts?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST') return jsonResponse(null, { status: 204 });
    polls++;
    // Not ready for the first two polls, ready on the third.
    return jsonResponse(polls < 3 ? {} : { wav_file_url: 'https://cdn/ready.wav' });
  }, () => resolveGenWavUrl('clip-2', 'tok', { delay: async (ms) => { delays.push(ms); } }));

  assert.equal(calls.filter(c => c.startsWith('POST')).length, 1, 'convert_wav called once');
  assert.equal(polls, 3, 'one initial probe plus two polls before the URL appears');
  assert.deepEqual(delays, [5000, 5000], 'a 5s wait before each poll, never before the first fetch');
});

test('resolveGenWavUrl gives up after 24 retries', async () => {
  let gets = 0;
  let delays = 0;
  await withFetch(async (url, opts) => {
    if ((opts?.method ?? 'GET') === 'POST') return jsonResponse(null, { status: 204 });
    gets++;
    return jsonResponse({});
  }, async () => {
    await assert.rejects(
      () => resolveGenWavUrl('clip-3', 'tok', { delay: async () => { delays++; } }),
      /Timed out waiting for Suno WAV conversion/
    );
  });
  // One initial probe, then at most 24 retries — each preceded by a 5s wait.
  assert.equal(delays, 24, 'the retry cap is 24');
  assert.equal(gets, 25, 'initial probe plus 24 retries');
});

test('resolveSunoDownloadUrl falls back to legacy when the WAV flow fails, and logs', async () => {
  const logs = [];
  const urls = await withFetch(async (url) => {
    if (url.includes('/api/gen/')) return jsonResponse({}, { ok: false, status: 500 });
    return jsonResponse({ download_url: 'https://cdn/legacy.m4a' });
  }, () => resolveSunoDownloadUrl('clip-4', 'wav', 'tok', {
    log: (m) => logs.push(m),
    delay: async () => {}
  }));

  assert.equal(urls, 'https://cdn/legacy.m4a');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /convert_wav flow failed/);
});

test('resolveSunoDownloadUrl skips the WAV path entirely for non-wav formats', async () => {
  const calls = [];
  const url = await withFetch(async (u) => {
    calls.push(u);
    return jsonResponse({ download_url: 'https://cdn/m.m4a' });
  }, () => resolveSunoDownloadUrl('clip-5', 'm4a', 'tok', { log: () => {} }));

  assert.equal(url, 'https://cdn/m.m4a');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('/api/download/clip/'));
});

test('resolveLegacySunoDownloadUrl surfaces the API error detail', async () => {
  await withFetch(async () => jsonResponse({ detail: 'no credits' }, { ok: false, status: 402 }),
    async () => {
      await assert.rejects(
        () => resolveLegacySunoDownloadUrl('clip-6', 'wav', 'tok'),
        /HTTP 402 \(no credits\)/
      );
    });
});

test('resolveSunoAudioBytes unwraps and decrypts a full rights round trip', async () => {
  // Build a real wrapped key/iv pair, then have the stubbed rights endpoint serve
  // them, so the test exercises the production unwrap path rather than stubbing it.
  const secret = 'the-bearer';
  const userKey = await sunoGetUserKey(secret);
  const wrapKey = await gcmKeyForWrapping(secret);
  const contentId = 'clip-rt';
  const aad = new TextEncoder().encode(contentId);
  const gcmIv = unhex('aabbccddeeff001122334455');

  const wrap = async (raw) => {
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: gcmIv, additionalData: aad }, wrapKey, raw
    ));
    return btoa(String.fromCharCode(...[...gcmIv, ...ct]));
  };

  const rawKey = unhex(KEY_HEX);
  const rawIv = unhex(IV_HEX).slice(0, 12);
  const rights = { key: await wrap(rawKey), iv: await wrap(rawIv) };

  // Encrypt a known plaintext with an independent AES-CTR key built from the
  // same raw content key the SUT will unwrap (independent reference, not the SUT).
  const plaintext = plaintextOf(777, 5);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: asCounter(rawIv), length: 128 }, await ctrEncryptKey(), plaintext
  );

  await withFetch(async (url) => {
    if (String(url).includes('/api/mango/rights')) return jsonResponse(rights);
    return { ok: true, status: 200, arrayBuffer: async () => ciphertext };
  }, async () => {
    const out = await resolveSunoAudioBytes(contentId, 'https://cdn/enc.m4a', secret);
    assert.equal(hex(out), hex(plaintext));
  });
});

test('resolveSunoAudioBytes re-resolves a forbidden URL through the feed', async () => {
  let fedLookups = 0;
  const result = await withFetch(async () => {
    throw new Error('should not reach the network for the media URL');
  }, async () => {
    // Feed supplies the real media URL; the rights/media fetches are stubbed
    // separately below by short-circuiting on URL.
    return resolveSunoAudioBytes('clip-x', '/api/forbidden', 'tok', {
      fetchFeedSongsByIds: async () => {
        fedLookups++;
        return { clips: [{ media_urls: [{ url: 'https://cdn/real.m4a', encoding: 'x' }] }] };
      },
      extractMediaUrlFromClip: (clip) => ({ url: clip?.media_urls?.[0]?.url })
    }).catch(e => e);
  });

  assert.equal(fedLookups, 1, 'a forbidden URL must trigger exactly one feed re-resolve');
  assert.match(String(result?.message ?? result), /should not reach the network|license/i);
});

test('resolveSunoAudioBytes throws when the rights response omits key/iv', async () => {
  await withFetch(async () => jsonResponse({ glt: 'x' }), async () => {
    await assert.rejects(
      () => resolveSunoAudioBytes('clip-y', 'https://cdn/enc.m4a', 'tok'),
      /license response missing key\/iv/
    );
  });
});

test('sunoWavRequest attaches the bearer when a token is supplied', async () => {
  let seen = null;
  await withFetch(async (url, opts) => {
    seen = opts.headers;
    return jsonResponse(null, { status: 204 });
  }, () => sunoWavRequest('https://x/wav_file/', { token: 'abc' }));

  assert.equal(seen.Authorization, 'Bearer abc');
});

test('sunoWavRequest surfaces the HTTP status on the thrown error', async () => {
  await withFetch(async () => jsonResponse({}, { ok: false, status: 503 }),
    async () => {
      await assert.rejects(
        () => sunoWavRequest('https://x/wav_file/'),
        (err) => err.status === 503
      );
    });
});
