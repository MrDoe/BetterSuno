// tests/library-filters.test.js
//
// The library's five boolean filters are tri-state:
//
//   off      — filter inactive (unchecked)
//   include  — only songs that match (checked)
//   exclude  — matching songs removed (crossed out / indeterminate)
//
// The explicit state lives in `data-filter-state`; the native checkbox is only
// a mirror. A click flips `.checked` before `change` fires, so reading it back
// would skip a state. This guards the cycle, the matching rules, the legacy
// boolean migration, and the two places that used to read `.checked` directly
// (`markSongPlayed` and the empty-state message).
//
// downloader.js is a content-script IIFE that touches `document`/`chrome` at
// import time, so it cannot be imported by node:test. As in the other library
// tests, the real function source is extracted and executed against stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DOWNLOADER_SOURCE = read('downloader.js');
const CONTENT_SOURCE = read('content.js');
const CSS_SOURCE = read('content.css');

// Brace-matched block extraction that skips strings and comments.
function extractBraceBlock(source, openIndex, what) {
  assert.notEqual(openIndex, -1, `expected a body brace for ${what}`);

  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i);
      assert.notEqual(i, -1, `unterminated block comment in ${what}`);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      assert.notEqual(i, source.length, `unterminated ${quote} literal in ${what}`);
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    i += 1;
  }
  throw new Error(`unbalanced braces while extracting ${what}`);
}

function findClosingParen(source, parenOpen, what) {
  let depth = 0;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  assert.fail(`unbalanced parentheses while extracting ${what}`);
}

// The source text of a real `function name(...) { ... }` declaration.
function loadFunctionSource(source, name) {
  const decl = new RegExp(`^\\s*(?:async\\s+)?function ${name}\\(`, 'm');
  const match = source.match(decl);
  assert.ok(match, `expected downloader.js to declare ${name}`);

  const start = source.indexOf('function ' + name, match.index);
  const parenOpen = source.indexOf('(', start);
  const parenClose = findClosingParen(source, parenOpen, name);
  const body = extractBraceBlock(source, source.indexOf('{', parenClose), name);
  return `${source.slice(start, parenClose + 1)}${body}`;
}

function bodyOf(source, name) {
  const declaration = loadFunctionSource(source, name);
  return declaration.slice(declaration.indexOf('{'));
}

// ---------------------------------------------------------------------------
// Tri-state helpers
// ---------------------------------------------------------------------------

function loadFilterHelpers() {
  const names = [
    'normalizeFilterState',
    'getFilterState',
    'setFilterState',
    'cycleFilterState',
    'matchesTriState'
  ];
  const declarations = names.map(name => loadFunctionSource(DOWNLOADER_SOURCE, name)).join('\n');
  return new Function(`${declarations}
    return { normalizeFilterState, getFilterState, setFilterState, cycleFilterState, matchesTriState };`)();
}

function makeFilterInput(id, state = 'off', text = '') {
  const classes = new Set();
  const input = {
    id,
    dataset: { filterState: state },
    checked: state === 'include',
    indeterminate: state === 'exclude',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    closest(selector) {
      assert.equal(selector, '.filter-tri-state');
      return this.label;
    }
  };
  const label = {
    textContent: text || id,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return classes.has(name);
      },
      contains(name) { return classes.has(name); }
    }
  };
  input.label = label;
  input.classes = classes;
  return input;
}

test('legacy booleans and stored strings decode to the three states', () => {
  const { normalizeFilterState } = loadFilterHelpers();

  assert.equal(normalizeFilterState(true), 'include', 'a stored true used to mean checked');
  assert.equal(normalizeFilterState(false), 'off', 'a stored false used to mean inactive');
  assert.equal(normalizeFilterState('include'), 'include');
  assert.equal(normalizeFilterState('exclude'), 'exclude');
  assert.equal(normalizeFilterState('off'), 'off');
  assert.equal(normalizeFilterState('bogus'), 'off');
  assert.equal(normalizeFilterState('bogus', 'include'), 'include',
    'Public supplies include as its fallback');
  assert.equal(normalizeFilterState(null, 'include'), 'include');
});

test('a click cycles off → include → exclude → off', () => {
  const { cycleFilterState, getFilterState } = loadFilterHelpers();
  const input = makeFilterInput('liked', 'off', '❤️ Liked');

  assert.equal(cycleFilterState(input), 'include');
  assert.equal(getFilterState(input), 'include');
  assert.equal(cycleFilterState(input), 'exclude');
  assert.equal(getFilterState(input), 'exclude');
  assert.equal(cycleFilterState(input), 'off');
  assert.equal(getFilterState(input), 'off');
});

test('exclude mirrors the native checkbox and crosses out the label', () => {
  const { setFilterState } = loadFilterHelpers();
  const input = makeFilterInput('liked', 'off', '❤️ Liked');

  setFilterState(input, 'include');
  assert.equal(input.dataset.filterState, 'include');
  assert.equal(input.checked, true);
  assert.equal(input.indeterminate, false);
  assert.equal(input.classes.has('filter-excluded'), false);
  assert.equal(input.attrs['aria-label'], 'Liked: include');

  setFilterState(input, 'exclude');
  assert.equal(input.dataset.filterState, 'exclude');
  assert.equal(input.checked, false);
  assert.equal(input.indeterminate, true, 'the native mixed state draws the dash');
  assert.equal(input.classes.has('filter-excluded'), true, 'the label gets the cross-out class');
  assert.equal(input.attrs['aria-label'], 'Liked: exclude');

  setFilterState(input, 'off');
  assert.equal(input.checked, false);
  assert.equal(input.indeterminate, false);
  assert.equal(input.classes.has('filter-excluded'), false);
  assert.equal(input.attrs['aria-label'], 'Liked: off');
});

test('matchesTriState applies include and exclude in opposite directions', () => {
  const { matchesTriState } = loadFilterHelpers();

  assert.equal(matchesTriState('off', true), true);
  assert.equal(matchesTriState('off', false), true);

  assert.equal(matchesTriState('include', true), true);
  assert.equal(matchesTriState('include', false), false);

  assert.equal(matchesTriState('exclude', true), false);
  assert.equal(matchesTriState('exclude', false), true);
});

// ---------------------------------------------------------------------------
// Song matching
// ---------------------------------------------------------------------------

function loadSongFilters({ cachedIds = [], playlistSongs = null, isOtherArtist = () => false } = {}) {
  const names = [
    'normalizePlayCount',
    'matchesTriState',
    'matchesModelFilter',
    'matchesSongFilters',
    'filterSongs'
  ];
  const declarations = names.map(name => loadFunctionSource(DOWNLOADER_SOURCE, name)).join('\n');
  return new Function(
    'cachedSongIds',
    'playlistSongs',
    'isSongFromOtherArtist',
    `${declarations}
     return { matchesSongFilters, filterSongs };`
  )(new Set(cachedIds), playlistSongs, isOtherArtist);
}

function filterState(overrides = {}) {
  return {
    searchText: '',
    liked: 'off',
    stems: 'off',
    public: 'off',
    offline: 'off',
    unplayed: 'off',
    currentSongId: null,
    modelVersion: '',
    ...overrides
  };
}

function song(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Test Song',
    is_liked: false,
    is_stem: false,
    is_public: false,
    play_count: 0,
    ...overrides
  };
}

test('liked, stems and public include/exclude select the right rows', () => {
  const { matchesSongFilters } = loadSongFilters();

  const cases = [
    { key: 'liked', flag: 'is_liked', yes: song({ id: 'yes', is_liked: true }), no: song({ id: 'no' }) },
    { key: 'stems', flag: 'is_stem', yes: song({ id: 'yes', is_stem: true }), no: song({ id: 'no' }) },
    { key: 'public', flag: 'is_public', yes: song({ id: 'yes', is_public: true }), no: song({ id: 'no' }) }
  ];

  for (const { key, yes, no } of cases) {
    assert.equal(matchesSongFilters(yes, filterState({ [key]: 'include' })), true,
      `${key} include keeps a matching song`);
    assert.equal(matchesSongFilters(no, filterState({ [key]: 'include' })), false,
      `${key} include drops a non-matching song`);
    assert.equal(matchesSongFilters(yes, filterState({ [key]: 'exclude' })), false,
      `${key} exclude drops a matching song`);
    assert.equal(matchesSongFilters(no, filterState({ [key]: 'exclude' })), true,
      `${key} exclude keeps a non-matching song`);
    assert.equal(matchesSongFilters(yes, filterState()), true,
      `${key} off keeps everything`);
    assert.equal(matchesSongFilters(no, filterState()), true,
      `${key} off keeps everything`);
  }
});

test('offline include/exclude reads the cached-id set', () => {
  const { matchesSongFilters } = loadSongFilters({ cachedIds: ['cached'] });

  assert.equal(matchesSongFilters(song({ id: 'cached' }), filterState({ offline: 'include' })), true);
  assert.equal(matchesSongFilters(song({ id: 'remote' }), filterState({ offline: 'include' })), false);
  assert.equal(matchesSongFilters(song({ id: 'cached' }), filterState({ offline: 'exclude' })), false);
  assert.equal(matchesSongFilters(song({ id: 'remote' }), filterState({ offline: 'exclude' })), true);
  assert.equal(matchesSongFilters(song({ id: 'remote' }), filterState()), true);
});

test('the currently playing song survives both Unplayed directions', () => {
  const { matchesSongFilters } = loadSongFilters();
  const playing = song({ id: 'playing', play_count: 4 });
  const played = song({ id: 'played', play_count: 4 });
  const fresh = song({ id: 'fresh', play_count: 0 });

  const includeState = filterState({ unplayed: 'include', currentSongId: 'playing' });
  assert.equal(matchesSongFilters(playing, includeState), true,
    'the row under the mini player must not vanish');
  assert.equal(matchesSongFilters(fresh, includeState), true);
  assert.equal(matchesSongFilters(played, includeState), false);

  const excludeState = filterState({ unplayed: 'exclude', currentSongId: 'playing' });
  assert.equal(matchesSongFilters(playing, excludeState), true,
    'the exception also applies when unplayed songs are excluded');
  assert.equal(matchesSongFilters(played, excludeState), true);
  assert.equal(matchesSongFilters(fresh, excludeState), false);

  assert.equal(matchesSongFilters(fresh, filterState({ unplayed: 'off' })), true);
  assert.equal(matchesSongFilters(played, filterState({ unplayed: 'off' })), true);
});

test('combined filters and search/model still narrow the same list', () => {
  const { matchesSongFilters } = loadSongFilters();

  const state = filterState({
    liked: 'include',
    public: 'exclude',
    searchText: 'alpha',
    modelVersion: 'v6'
  });
  const match = song({
    id: 'a',
    title: 'Alpha',
    is_liked: true,
    is_public: false,
    major_model_version: 'v6'
  });
  assert.equal(matchesSongFilters(match, state), true);

  assert.equal(matchesSongFilters({ ...match, is_liked: false }, state), false);
  assert.equal(matchesSongFilters({ ...match, is_public: true }, state), false);
  assert.equal(matchesSongFilters({ ...match, title: 'Beta' }, state), false);
  assert.equal(matchesSongFilters({ ...match, major_model_version: 'v4' }, state), false);
});

test('the ownership gate still applies outside playlist view', () => {
  const isOtherArtist = (entry) => entry.owner === 'other';
  const { filterSongs } = loadSongFilters({ isOtherArtist });
  const own = song({ id: 'own' });
  const foreign = song({ id: 'foreign', owner: 'other' });

  assert.deepEqual(
    filterSongs([own, foreign], filterState()).map(entry => entry.id),
    ['own'],
    'the library view must not show another artist\'s song'
  );

  const playlist = loadSongFilters({ isOtherArtist, playlistSongs: [foreign] });
  assert.deepEqual(
    playlist.filterSongs([foreign], filterState()).map(entry => entry.id),
    ['foreign'],
    'a playlist view is allowed to contain other artists'
  );
});

// ---------------------------------------------------------------------------
// Wiring and persistence
// ---------------------------------------------------------------------------

test('the panel markup starts the five filters in the right state', () => {
  const block = CONTENT_SOURCE.slice(
    CONTENT_SOURCE.indexOf('<div id="filterControls">'),
    CONTENT_SOURCE.indexOf('<input type="text" id="filterInput"')
  );

  const expected = {
    filterLiked: 'off',
    filterStems: 'off',
    filterPublic: 'include',
    filterOffline: 'off',
    filterUnplayed: 'off'
  };

  for (const [id, state] of Object.entries(expected)) {
    const match = block.match(new RegExp(`id="${id}"[^>]*data-filter-state="([^"]+)"`));
    assert.ok(match, `${id} must carry an explicit data-filter-state`);
    assert.equal(match[1], state, `${id} must start as ${state}`);
    assert.match(block, new RegExp(`class="checkbox-label filter-tri-state"[^>]*>[\\s\\S]*?id="${id}"`),
      `${id} must be marked as a tri-state filter`);
  }
  assert.match(block, /id="filterPublic"[^>]*checked/,
    'Public must still render as checked in the include state');
});

test('saveFilterPreferences stores the explicit state and never Unplayed', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'saveFilterPreferences');

  for (const key of ['sunoFilterLiked', 'sunoFilterStems', 'sunoFilterPublic', 'sunoFilterOffline']) {
    assert.match(body, new RegExp(`savePreferenceToIDB\\('${key}', getFilterState\\(`),
      `${key} must persist the tri-state value`);
  }
  assert.ok(!/\.checked/.test(body),
    'a click flips checked before change fires; it is a mirror, not the state');
  assert.ok(!/sunoFilterUnplayed/.test(body),
    'Unplayed must keep starting off on every page load');
});

test('loadFilterPreferences migrates booleans and defaults Public to include', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'loadFilterPreferences');

  assert.match(body, /setFilterState\(filterLiked, liked !== null \? liked : 'off'\)/);
  assert.match(body, /setFilterState\(filterStems, stems !== null \? stems : 'off'\)/);
  assert.match(body, /setFilterState\(filterPublic, pub !== null \? pub : 'include', 'include'\)/);
  assert.match(body, /setFilterState\(filterOffline, offline !== null \? offline : 'off'\)/);
  assert.ok(!/\.checked/.test(body),
    'restoring preferences must go through setFilterState, not the native bit');
  assert.ok(!/sunoFilterUnplayed/.test(body),
    'Unplayed must not be restored from storage');
});

test('getSongFilterState reads explicit states, not native checkboxes', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'getSongFilterState');

  assert.match(body, /liked: getFilterState\(filterLiked\)/);
  assert.match(body, /stems: getFilterState\(filterStems\)/);
  assert.match(body, /public: getFilterState\(filterPublic, 'include'\)/);
  assert.match(body, /offline: getFilterState\(filterOffline\)/);
  assert.match(body, /unplayed: getFilterState\(filterUnplayed\)/);
  assert.ok(!/\.checked/.test(body),
    'the browser toggles checked before change, so it cannot be the source of truth');
});

test('the three-state cycle is wired to every boolean filter', () => {
  for (const [id, persist] of [
    ['filterLiked', true],
    ['filterStems', true],
    ['filterPublic', true],
    ['filterOffline', true],
    ['filterUnplayed', false]
  ]) {
    const pattern = new RegExp(
      persist
        ? `setupTriStateFilter\\(${id}, \\{ persist: true(?:, fallback: 'include')? \\}\\);`
        : `setupTriStateFilter\\(${id}\\);`
    );
    assert.match(DOWNLOADER_SOURCE, pattern,
      persist
        ? `${id} must persist its state`
        : `${id} must stay session-only`);
  }
});

test('markSongPlayed re-renders for both active Unplayed directions', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'markSongPlayed');

  assert.match(body, /getFilterState\(filterUnplayed\) !== 'off'/,
    'a played row can leave either the Unplayed or the Played view');
  assert.ok(!/filterUnplayed\?\.checked/.test(body),
    'the old condition missed the exclude direction');
});

test('the empty-state message only claims "offline" for the include state', () => {
  const body = bodyOf(DOWNLOADER_SOURCE, 'renderSongList');

  assert.match(body, /getFilterState\(filterOffline\) === 'include'/,
    'exclude is not "only offline" and must use the generic message');
  assert.ok(!/filterOffline\?\.checked/.test(body));
});

test('the stylesheet renders the excluded state without relying on color alone', () => {
  assert.match(CSS_SOURCE, /\.filter-tri-state\.filter-excluded\s*\{[^}]*text-decoration:\s*line-through/s,
    'the label must be crossed out');
  assert.match(CSS_SOURCE, /\.filter-tri-state\.filter-excluded::after\s*\{[^}]*content:\s*'✕'/s,
    'an explicit cross marks the state');
  assert.match(CSS_SOURCE, /input\[type="checkbox"\]:indeterminate\s*\{[^}]*accent-color:\s*#ef4444/s,
    'the native dash must be visible in the error color');
});
