// lib/audio-filename.js
//
// Pure rules for audio download filenames: infer the file extension from
// a URL/content-type pair, replace it on a filename, and verify that a
// download filename's extension matches the content actually served.
// Extracted from background.js so node:test can import it (the service
// worker itself cannot be imported by tests).

// Extensions recognized as audio. A trailing run of these is stripped
// before the verified extension is appended, so MIME-derived appends
// ("song.m4a.mp4") are repaired instead of stacked.
const AUDIO_FILE_EXTENSIONS = new Set([
  'aac', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'opus', 'wav', 'webm',
]);

export function replaceFilenameExtension(filename, nextExtension) {
  if (typeof filename !== 'string' || !filename) {
    return filename;
  }

  const cleanExtension = String(nextExtension || '').trim().replace(/^\./, '').toLowerCase();
  if (!cleanExtension) {
    return filename;
  }

  return filename.replace(/\.[^.\/]+$/, `.${cleanExtension}`);
}

export function inferAudioExtension(url, contentType, fallbackExtension = 'm4a') {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('audio/wav') || normalizedType.includes('audio/x-wav') || normalizedType.includes('audio/wave')) {
    return 'wav';
  }
  if (normalizedType.includes('audio/mpeg') || normalizedType.includes('audio/mp3')) {
    return 'mp3';
  }
  if (normalizedType.includes('audio/mp4') || normalizedType.includes('audio/x-m4a')) {
    return 'm4a';
  }
  if (normalizedType.includes('audio/ogg')) {
    return 'ogg';
  }

  const normalizedUrl = String(url || '').split('?')[0].toLowerCase();
  const extensionMatch = normalizedUrl.match(/\.([a-z0-9]{2,5})$/i);
  if (extensionMatch?.[1]) {
    return extensionMatch[1].toLowerCase();
  }

  return String(fallbackExtension || 'm4a').toLowerCase();
}

// Removes a trailing run of known audio extensions ("song.m4a.mp4" -> "song").
// Stops at the first non-audio extension, so a title like "demo.mp4" inside
// "demo.mp4_abcd.m4a" survives — the id slice separates it from the end.
export function stripTrailingAudioExtensions(filename) {
  let stripped = String(filename || '');
  for (let guard = 0; guard < 8; guard += 1) {
    const match = stripped.match(/\.([a-z0-9]{2,5})$/i);
    if (!match || !AUDIO_FILE_EXTENSIONS.has(match[1].toLowerCase())) {
      break;
    }
    stripped = stripped.slice(0, match.index);
  }
  return stripped;
}

// Verifies a download filename against the content that was actually
// served. Non-audio payloads (lyrics, images, unknown types) pass
// through untouched. For audio, the filename's extension is replaced with
// the extension inferred from the content-type (falling back to the URL,
// then the filename's own extension). Also repairs double extensions.
export function verifyAudioDownloadFilename(filename, url, contentType) {
  if (typeof filename !== 'string' || !filename) {
    return filename;
  }

  const currentExtension = filename.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || '';
  const normalizedType = String(contentType || '').toLowerCase();
  const isAudioPayload = normalizedType.startsWith('audio/')
    || AUDIO_FILE_EXTENSIONS.has(currentExtension);
  if (!isAudioPayload) {
    return filename;
  }

  const detectedExtension = inferAudioExtension(url, contentType, currentExtension);
  if (!detectedExtension) {
    return filename;
  }

  const stripped = stripTrailingAudioExtensions(filename);
  if (stripped === '') {
    return filename;
  }

  if (stripped === filename) {
    // Single (or no) audio extension: only touch the name when the
    // served content implies a different one.
    if (!currentExtension) {
      return `${filename}.${detectedExtension}`;
    }
    return detectedExtension === currentExtension
      ? filename
      : replaceFilenameExtension(filename, detectedExtension);
  }

  // A trailing run of audio extensions (e.g. browser-appended duplicates
  // like "song.m4a.mp4"): rebuild the name with the verified extension
  // exactly once.
  return `${stripped}.${detectedExtension}`;
}
