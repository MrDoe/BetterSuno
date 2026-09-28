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
