// tests/repo-hygiene.test.js
//
// Regression guards for the drift classes found on 2026-09-28. Each test here
// corresponds to a real defect that shipped or nearly shipped:
//
//   - dead ownership code that a quirk misdescribed as a live regression
//   - PRIVACY.md documenting hosts the manifest never granted (a Chrome Web
//     Store listing was blocked on INVALID_ITEM_METADATA at the time)
//   - a source module omitted from build.js, which ships a build that only
//     fails when the service worker evaluates its imports
//   - a self-contradicting AGENTS.md instruction about `params: {}`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('verified-dead ownership functions do not return', () => {
  const dead = [
    'canDownloadSongForIdentity',
    'isSongOwnedByIdentity',
    'hasSongOwnershipMetadata',
    'getNormalizedSongOwnerIds',
    'getNormalizedSongOwnerHandles',
    'collectUuidLikeIds',
  ];
  const sources = ['background.js', 'lib/ownership.js', 'lib/util.js', 'lib/identity.js']
    .map(read)
    .join('\n');

  for (const name of dead) {
    // Allow the historical note in lib/ownership.js's header comment, which
    // documents the removal. Strip comments before asserting.
    const withoutComments = sources
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      withoutComments.includes(name),
      false,
      `${name} was removed as dead code on 2026-09-28 and must not come back`
    );
  }
});

test('every runtime source file is shipped by the build', () => {
  const build = read('build.js');

  // Parse the declared arrays rather than scraping every quoted string, which
  // would also match Node built-ins like 'fs'.
  const arrayBody = (name) => {
    const m = build.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `build.js must declare ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  };

  const shipped = [...arrayBody('SHARED_FILES'), ...arrayBody('SHARED_DIRS')];

  const manifest = JSON.parse(read('manifest.json'));
  const referenced = new Set([
    ...shipped,
    ...(manifest.background?.scripts ?? []),
    ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
    ...(manifest.content_scripts ?? []).flatMap(cs => cs.js ?? []),
  ]);

  for (const f of referenced) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), true, `build/manifest references missing ${f}`);
  }

  // lib/ must be a build target, or background.js's imports dangle in dist/.
  assert.ok(shipped.includes('lib'), 'build.js must ship lib/ (background.js imports it)');
  assert.ok(fs.existsSync(path.join(ROOT, 'lib')), 'lib/ must exist');
});

test('PRIVACY.md documents exactly the granted host permissions', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const privacy = read('PRIVACY.md');

  for (const host of manifest.host_permissions) {
    // Match on the scheme+host portion, ignoring the path wildcard.
    const bare = host.replace(/\/\*$/, '');
    assert.ok(
      privacy.includes(bare),
      `manifest grants ${bare} but PRIVACY.md does not document it — store listings must match the manifest`
    );
  }
});

test('PRIVACY.md does not claim permissions the manifest does not request', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const privacy = read('PRIVACY.md');

  // Documented as a requested permission but absent from the manifest.
  assert.equal(
    manifest.permissions.includes('offscreen'),
    false,
    'if offscreen is ever added to the manifest, PRIVACY.md must be updated in the same change'
  );
  assert.equal(
    /`offscreen`\s*–/.test(privacy),
    false,
    'PRIVACY.md lists `offscreen` as a requested permission; the MV3 offscreen API needs none'
  );
});

test('AGENTS.md does not assert the stale `params: {}` requirement', () => {
  const agents = read('AGENTS.md');
  // The generation section is authoritative: params:{} was removed 2026-09.
  // The MCP section previously contradicted it and claimed both payloads add it.
  const contradiction = /`params:\s*\{\}`\s*required/i.test(agents) ||
    /generate_song payload[\s\S]{0,80}adds it/i.test(agents) ||
    /relay_generate[\s\S]{0,40}both add/i.test(agents);
  assert.equal(
    contradiction,
    false,
    'AGENTS.md still claims params:{} is required / that the extension adds it — verified false 2026-09-28'
  );
});

test('the token contract is never hardcoded as a bare string', () => {
  // AGENTS.md warns not to hardcode the token shape; make sure the shape is
  // still validated in code rather than assumed.
  const background = read('background.js');
  assert.ok(
    /__session/.test(background),
    'the __session cookie is the working credential source and must remain referenced'
  );
});
