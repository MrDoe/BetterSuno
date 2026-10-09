// tests/audio-filename.test.js
//
// Audio download filename rules. The Android double-extension bug
// ("song.m4a.mp4" — Firefox for Android appends the extension it maps
// from the blob's MIME type, audio/mp4 -> .mp4) is why
// verifyAudioDownloadFilename exists: the in-page save path must be able
// to repair or prevent it, and the requested container (m4a/mp3) is only
// a hint — the filename must follow the content actually served.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferAudioExtension,
  replaceFilenameExtension,
  stripTrailingAudioExtensions,
  verifyAudioDownloadFilename,
} from '../lib/audio-filename.js';

test('infers extension from content-type first', () => {
  assert.equal(inferAudioExtension('https://x/a', 'audio/mp4'), 'm4a');
  assert.equal(inferAudioExtension('https://x/a', 'audio/x-m4a'), 'm4a');
  assert.equal(inferAudioExtension('https://x/a', 'audio/mpeg'), 'mp3');
  assert.equal(inferAudioExtension('https://x/a', 'audio/wav'), 'wav');
  assert.equal(inferAudioExtension('https://x/a', 'audio/ogg'), 'ogg');
});

test('infers extension from URL, ignoring the query string', () => {
  assert.equal(inferAudioExtension('https://x/song.mp3?token=1', 'application/octet-stream'), 'mp3');
  assert.equal(inferAudioExtension('https://x/song.WAV', ''), 'wav');
});

test('falls back to the given extension, then m4a', () => {
  assert.equal(inferAudioExtension('https://x/song', 'application/octet-stream', 'mp3'), 'mp3');
  assert.equal(inferAudioExtension('https://x/song', ''), 'm4a');
});

test('replaces only the last extension of a filename', () => {
  assert.equal(replaceFilenameExtension('song.m4a', 'mp3'), 'song.mp3');
  assert.equal(replaceFilenameExtension('folder/song.m4a', 'mp3'), 'folder/song.mp3');
  assert.equal(replaceFilenameExtension('song', 'mp3'), 'song');
  assert.equal(replaceFilenameExtension('song.m4a', ''), 'song.m4a');
});

test('strips a trailing run of audio extensions', () => {
  assert.equal(stripTrailingAudioExtensions('song.m4a.mp4'), 'song');
  assert.equal(stripTrailingAudioExtensions('song.m4a'), 'song');
  assert.equal(stripTrailingAudioExtensions('song.m4a.m4a'), 'song');
  assert.equal(stripTrailingAudioExtensions('demo.mp4_abcd.m4a'), 'demo.mp4_abcd');
  assert.equal(stripTrailingAudioExtensions('song.txt'), 'song.txt');
  assert.equal(stripTrailingAudioExtensions('song'), 'song');
});

test('verify keeps a correct audio filename untouched', () => {
  assert.equal(verifyAudioDownloadFilename('song.m4a', 'https://x/a', 'audio/mp4'), 'song.m4a');
  assert.equal(verifyAudioDownloadFilename('song.mp3', 'https://x/a', 'audio/mpeg'), 'song.mp3');
  assert.equal(verifyAudioDownloadFilename('song.m4a', 'https://x/a', 'application/octet-stream'), 'song.m4a');
});

test('verify corrects a mismatched extension to the served content', () => {
  assert.equal(verifyAudioDownloadFilename('song.mp4', 'https://x/a', 'audio/mp4'), 'song.m4a');
  assert.equal(verifyAudioDownloadFilename('song.m4a', 'https://x/a', 'audio/mpeg'), 'song.mp3');
  assert.equal(verifyAudioDownloadFilename('song.m4a', 'https://x/a.mp3', 'application/octet-stream'), 'song.mp3');
  assert.equal(verifyAudioDownloadFilename('song', 'https://x/a', 'audio/mp4'), 'song.m4a');
});

test('verify repairs browser-appended double extensions', () => {
  assert.equal(verifyAudioDownloadFilename('song.m4a.mp4', 'https://x/a', 'audio/mp4'), 'song.m4a');
  assert.equal(verifyAudioDownloadFilename('song.mp4.m4a', 'https://x/a', 'audio/mp4'), 'song.m4a');
});

test('verify leaves non-audio payloads untouched', () => {
  assert.equal(verifyAudioDownloadFilename('lyrics.txt', 'https://x/a', 'text/plain'), 'lyrics.txt');
  assert.equal(verifyAudioDownloadFilename('cover.jpg', 'https://x/a', 'image/jpeg'), 'cover.jpg');
  assert.equal(verifyAudioDownloadFilename('song.m4a', 'https://x/a', 'text/plain'), 'song.m4a');
});
