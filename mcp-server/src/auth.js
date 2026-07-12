import { sunoClient } from './suno-client.js';

let _currentUser = null;

export async function getCurrentUser() {
  if (_currentUser) return _currentUser;
  const result = await sunoClient.GET('/api/user/me');
  if (!result.ok) throw new Error(result.error || 'Failed to fetch current user');
  const d = result.data || {};
  _currentUser = {
    user_id: d.user_id || d.id || d.userId || null,
    handle: d.handle || d.username || d.user_handle || null,
  };
  if (!_currentUser.user_id) {
    throw new Error('Could not determine current user id from /api/user/me');
  }
  return _currentUser;
}

export async function fetchClip(clipId) {
  const result = await sunoClient.GET(`/api/clip/${encodeURIComponent(clipId)}`);
  if (!result.ok) throw new Error(result.error || 'Song not found');
  return result.data;
}

function clipOwnerId(clip) {
  if (!clip || typeof clip !== 'object') return null;
  return clip.user_id || clip.owner_user_id || clip.user?.id || clip.metadata?.user_id || null;
}

// Throws unless the clip belongs to the current user.
export async function assertOwned(clipId) {
  const clip = await fetchClip(clipId);
  const me = await getCurrentUser();
  const owner = clipOwnerId(clip);
  if (!owner || (me.user_id && owner !== me.user_id)) {
    throw new Error(
      `Access denied: song ${clipId} is not in your library ` +
      `(owned by @${clip.handle || owner || 'unknown'}).`
    );
  }
  return clip;
}

// Covering/remixing your own songs is always allowed.
// Covering/remixing another artist's song is only allowed when that
// song's metadata.can_remix flag is enabled by its owner.
export async function assertCanCover(clipId) {
  const clip = await fetchClip(clipId);
  const me = await getCurrentUser();
  const owner = clipOwnerId(clip);
  const isOwn = me.user_id && owner === me.user_id;
  if (isOwn) return clip;
  const canRemix = clip.metadata?.can_remix === true;
  if (!canRemix) {
    throw new Error(
      `Cover/remix denied: "${clip.title || clipId}" by @${clip.handle || owner || 'unknown'} ` +
      `does not allow remixing (metadata.can_remix is not enabled).`
    );
  }
  return clip;
}
