// lib/util.js — small pure string/collection helpers shared across BetterSuno.
//
// Extracted from background.js so the pure logic is importable by tests
// (node:test) instead of only being reachable through a 6.7k-line service
// worker that cannot be imported in a test process.
//
// NOTE: content-fetcher.js intentionally keeps its own private copies of
// normalizeHandle/pickFirstNonEmptyString. It is injected into the page's MAIN
// world as a classic script and cannot use ES module imports, so that
// duplication is required, not accidental.

export function pickFirstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

export function normalizeHandle(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
  return trimmed || null;
}

export function collectNormalizedIds(values) {
  const ids = [];

  values.forEach(value => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();
    if (trimmed) {
      ids.push(trimmed);
    }
  });

  return Array.from(new Set(ids));
}

// Returns true for data: URLs. Firefox's downloads API rejects
// them (TypeError), and the download flow has observed
// "NetworkError when attempting to fetch resource" when they
// reach fetch() — so decode them locally and save from a tab.
export function isDataUrl(url) {
  return typeof url === 'string' && /^data:/i.test(url);
}

// Decodes a data: URL into { bytes, mimeType } without fetching.
// Base64 payloads are decoded as-is; plain payloads are
// percent-decoded and UTF-8 encoded.
export function decodeDataUrl(dataUrl) {
  if (!isDataUrl(dataUrl)) {
    throw new Error('Not a data: URL');
  }

  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Malformed data: URL');
  }

  const header = dataUrl.slice(5, commaIndex).toLowerCase();
  const payload = dataUrl.slice(commaIndex + 1);
  const [mediaType = '', ...parameters] = header.split(';');
  const mimeType = mediaType || 'text/plain';

  if (parameters.includes('base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, mimeType };
  }

  const bytes = new TextEncoder().encode(decodeURIComponent(payload));
  return { bytes, mimeType };
}
