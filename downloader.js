// downloader.js — popup.js adapted as a content script for the Library tab panel
// Runs after content.js has injected the panel DOM.
// Uses IndexedDB for persistent storage across browser sessions

(function initDownloader() {
    const api = (typeof browser !== 'undefined') ? browser : chrome;

    let allSongs = [];
    let filteredSongs = [];
    let selectedSongIds = new Set();
    let currentPlayingSongId = null;
    let cachedSongIds = new Set();
    let currentBlobUrl = null;
    let stopCachingRequested = false;
    const SONG_RENDER_BATCH_SIZE = 40;
    let sortedFilteredSongs = [];
    let renderedSongCount = 0;
    let songListSentinel = null;
    let songListObserver = null;
    const songItemCache = new Map(); // songId → DOM element; reused on re-renders to prevent image reload
    let metadataRefreshInFlight = false;
    const pendingMetadataRefreshIds = new Set();
    let metadataRefreshBlockedUntil = 0;
    let songListVisibleRefreshTimer = null;
    let songListVisibleRefreshFollowupTimer = null;
    let songListVisibleRefreshIntervalTimer = null;
    const VISIBLE_SONG_REFRESH_DEBOUNCE_MS = 180;
    const VISIBLE_SONG_REFRESH_REPEAT_MS = 1000;
    const VISIBLE_SONG_REFRESH_INTERVAL_MS = 10 * 1000;
    const METADATA_REFRESH_ERROR_BACKOFF_MS = 30 * 1000;
    const SYNC_META_KEY = 'sunoSyncMeta';
    const PLAYLISTS_KEY = 'sunoPlaylists';
    const SELECTED_PLAYLIST_KEY = 'sunoSelectedPlaylist';
    const TEXT_CANDIDATE_KEYS = ['lyrics', 'display_lyrics', 'full_lyrics', 'raw_lyrics', 'prompt', 'text', 'content', 'value'];
    const URL_CANDIDATE_KEYS = ['url', 'src', 'image_url', 'image', 'cover_url', 'cover_image_url', 'thumbnail_url', 'artwork_url'];
    const SONG_CLIP_FIELD_PATHS = {
        audio: ['audio_url', 'stream_audio_url', 'song_path'],
        video: ['video_url', 'video_cdn_url', 'mp4_url', 'metadata.video_url'],
        image: ['image_url', 'image', 'image_large_url', 'cover_url', 'cover_image_url', 'thumbnail_url', 'artwork_url', 'metadata.image_url', 'metadata.cover_image_url', 'meta.image_url'],
        lyrics: ['lyrics', 'display_lyrics', 'full_lyrics', 'raw_lyrics', 'prompt', 'metadata.lyrics', 'metadata.prompt', 'meta.lyrics'],
        ownerUserId: ['user_id', 'owner_user_id', 'user.id', 'user.user_id']
    };

    async function sendMessageWithRetry(message, { retries = 10, initialDelayMs = 150 } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await api.runtime.sendMessage(message);
            } catch (e) {
                lastError = e;
                const msg = e?.message || String(e);
                if (!msg.includes('Could not establish connection') && !msg.includes('Receiving end does not exist')) {
                    throw e;
                }
                if (attempt === retries) break;
                const delay = initialDelayMs * Math.min(10, attempt + 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    let currentFetchMode = 'idle';
    let currentMetadataRefreshRequested = false;
    const METADATA_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    const metadataRefreshTimestamps = new Map();
    metadataRefreshInFlight = false;
    let syncMeta = createDefaultSyncMeta();
    let playlistSongs = null; // Active playlist songs when a playlist is selected, else null
    let sunoUserId = null; // Set from the first own song when My Songs are loaded

    function createDefaultSyncMeta() {
        return {
            lastSyncAt: null,
            lastFullSyncAt: null,
            lastIncrementalSyncAt: null,
            lastSyncMode: null,
            lastAddedCount: 0,
            totalSongsAtLastSync: 0,
            lastError: null,
            syncStatus: 'idle'
        };
    }

    function getActiveSongs() {
        return Array.isArray(playlistSongs) ? playlistSongs : allSongs;
    }

    function getPlaylistSongsCacheKey(playlistId) {
        return `sunoPlaylistSongs:${playlistId}`;
    }

    function normalizePlaylistMetadata(playlist) {
        const candidateId = playlist?.id || playlist?.playlist_id || playlist?.playlistId || playlist?.song_id || playlist?.id?.toString?.() || '';
        return {
            id: candidateId,
            name: playlist?.name || playlist?.title || 'Unnamed Playlist',
            song_count: playlist?.song_count ?? playlist?.num_total_results ?? playlist?.total ?? playlist?.total_results ?? null,
            num_total_results: playlist?.num_total_results ?? playlist?.total ?? playlist?.total_results ?? null,
            is_public: playlist?.is_public,
            is_owned: playlist?.is_owned,
            is_owned_by_current_user: playlist?.is_owned_by_current_user,
            image_url: playlist?.image_url || playlist?.cover_image_url || null,
            description: playlist?.description || playlist?.short_description || '',
            owner_user_id: playlist?.owner_user_id || playlist?.user_id || playlist?.creator_user_id || playlist?.author_user_id || null,
            owner_handle: playlist?.owner_handle || playlist?.user_handle || playlist?.creator_handle || playlist?.author_handle || null,
            owner_display_name: playlist?.owner_display_name || playlist?.user_display_name || playlist?.creator_display_name || playlist?.author_display_name || playlist?.name || null
        };
    }

    function isPlaylistOtherArtist(playlist) {
        return playlist?.is_owned_by_current_user === false || playlist?.is_owned === false;
    }

    function normalizePlaylistId(raw) {
        if (!raw || typeof raw !== 'string') return '';
        const trimmed = raw.trim();
        const urlMatch = trimmed.match(/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
            || trimmed.match(/playlist\/([0-9a-f-]{30,36})/i);
        if (urlMatch) return urlMatch[1];
        return trimmed;
    }

    function mergePlaylistsById(...collections) {
        const merged = new Map();

        collections.forEach(collection => {
            if (!Array.isArray(collection)) return;
            collection.forEach(playlist => {
                const normalized = normalizePlaylistMetadata(playlist);
                if (!normalized.id) return;

                const existing = merged.get(normalized.id);
                merged.set(normalized.id, existing ? {
                    ...existing,
                    ...normalized,
                    is_owned: normalized.is_owned ?? existing.is_owned,
                    is_owned_by_current_user: normalized.is_owned_by_current_user ?? existing.is_owned_by_current_user
                } : normalized);
            });
        });

        return Array.from(merged.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    async function savePlaylistToDropdown(playlist, preferredValue = '') {
        if (!playlist?.id) return;

        const cachedPlaylists = await loadPreferenceFromIDB(PLAYLISTS_KEY);
        const mergedPlaylists = mergePlaylistsById(Array.isArray(cachedPlaylists) ? cachedPlaylists : [], [playlist]);
        await savePreferenceToIDB(PLAYLISTS_KEY, mergedPlaylists);
        renderPlaylistOptions(mergedPlaylists, preferredValue || playlist.id);
    }

    async function clearPlaylistCache() {
        try {
            const preferenceRows = await getAllRecordsFromStore('userPreferences');
            const keysToDelete = preferenceRows
                .map(row => row?.key)
                .filter(key => key === PLAYLISTS_KEY || key === SELECTED_PLAYLIST_KEY || (typeof key === 'string' && key.startsWith('sunoPlaylistSongs:')));

            await Promise.all(keysToDelete.map(key => deletePreferenceFromIDB(key)));
        } catch (e) {
            console.error('[Downloader] Failed to clear playlist cache:', e);
        }
    }

    function renderPlaylistOptions(playlists, preferredValue = '') {
        if (!playlistFilter) return;

        while (playlistFilter.options.length > 1) {
            playlistFilter.remove(1);
        }

        playlists.forEach(pl => {
            const option = document.createElement('option');
            option.value = pl.id || '';
            const count = pl.song_count ?? pl.num_total_results;
            const ownerName = pl.owner_display_name || pl.owner_handle || 'Other artist';
            const suffix = isPlaylistOtherArtist(pl) ? ` (by ${ownerName})` : '';
            option.textContent = (pl.name || 'Unnamed Playlist') +
                (count != null ? ` (${count})` : '') +
                suffix;
            playlistFilter.appendChild(option);
        });

        if (preferredValue && Array.from(playlistFilter.options).some(option => option.value === preferredValue)) {
            playlistFilter.value = preferredValue;
        }
    }

    function extractText(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }

        if (Array.isArray(value)) {
            const parts = value.map(extractText).filter(Boolean);
            return parts.length > 0 ? parts.join('\n') : null;
        }

        if (value && typeof value === 'object') {
            const nestedCandidates = TEXT_CANDIDATE_KEYS.map(key => value[key]);
            for (const candidate of nestedCandidates) {
                const text = extractText(candidate);
                if (text) return text;
            }
        }

        return null;
    }

    function extractUrl(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return /^https?:\/\//i.test(trimmed) ? trimmed : null;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const url = extractUrl(item);
                if (url) return url;
            }
        }

        if (value && typeof value === 'object') {
            const nestedCandidates = URL_CANDIDATE_KEYS.map(key => value[key]);
            for (const candidate of nestedCandidates) {
                const url = extractUrl(candidate);
                if (url) return url;
            }
        }

        return null;
    }

    function isStemClip(clip) {
        if (!clip || typeof clip !== 'object') return false;

        const meta = clip.metadata || clip.meta || {};

        // Primary signal: task explicitly set to gen_stem
        if (meta.task === 'gen_stem') return true;

        // Secondary signal: stem_from_id present (UUID of the source clip)
        if (typeof meta.stem_from_id === 'string' && meta.stem_from_id.trim().length > 0) return true;

        // Tertiary signal: Suno's own badge system marks this as a stem
        const badges = Array.isArray(meta.secondary_badges) ? meta.secondary_badges
            : Array.isArray(clip.secondary_badges) ? clip.secondary_badges : [];
        if (badges.some(b => b && b.icon_key === 'stem')) return true;

        return false;
    }


    function isSongFromOtherArtist(song) {
        if (song?.is_owned_by_current_user === false) return true;
        if (sunoUserId && song?.owner_user_id && song.owner_user_id !== sunoUserId) return true;
        return false;
    }

    function getSongDisplayTitle(song) {
        return song?.custom_title ? String(song.custom_title) : (song?.title ? String(song.title) : 'Untitled');
    }

    function applyCustomSongTitle(songId, newTitle) {
        if (!songId || !newTitle) return;

        const updateTitle = (collection) => {
            if (!Array.isArray(collection)) return;
            const item = collection.find(s => s.id === songId);
            if (item) {
                item.custom_title = newTitle;
            }
        };

        updateTitle(allSongs);
        updateTitle(playlistSongs);

        if (currentPlayingSongId === songId) {
            const song = getActiveSongs().find(s => s.id === songId);
            if (song && playerTitle) {
                playerTitle.textContent = getSongDisplayTitle(song);
            }
        }

        // Force the current song element to recreate (not stale) and persist to IndexedDB.
        songItemCache.delete(songId);
        applyFilter({ preserveScroll: true, minimumRenderCount: renderedSongCount });
        void saveToStorage();
    }

    function initSunoUserId() {
        if (!sunoUserId && allSongs.length > 0) {
            sunoUserId = allSongs[0].owner_user_id || null;
        }
    }

    function splitSongsByDownloadEligibility(songs) {
        const downloadable = [];
        const blocked = [];
        songs.forEach(song => {
            if (isSongFromOtherArtist(song)) blocked.push(song);
            else downloadable.push(song);
        });
        return { downloadable, blocked };
    }

    function shouldShowOtherArtistBadge(song) {
        if (!playlistFilter || !playlistFilter.value) return false;
        return isSongFromOtherArtist(song);
    }

    function getNestedValue(source, path) {
        return path.split('.').reduce((current, key) => current?.[key], source);
    }

    function extractFirstMatchingValue(source, paths, extractor) {
        for (const path of paths) {
            const value = getNestedValue(source, path);
            const extracted = extractor(value);
            if (extracted !== null && extracted !== undefined) {
                return extracted;
            }
        }

        return null;
    }

    function extractTextFromPaths(source, paths) {
        return extractFirstMatchingValue(source, paths, extractText);
    }

    function extractUrlFromPaths(source, paths) {
        return extractFirstMatchingValue(source, paths, extractUrl);
    }

    function extractSongIdFromClipItem(rawClip) {
        const candidates = [
            rawClip?.clip?.id,
            rawClip?.song?.id,
            rawClip?.item?.id,
            rawClip?.id,
            rawClip?.clip_id,
            rawClip?.clipId,
            rawClip?.song_id,
            rawClip?.songId,
            rawClip?.gen_id,
            rawClip?.clip?.clip_id,
            rawClip?.song?.song_id
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        return null;
    }

    function getSongThumbnailSource(song) {
        if (!song || typeof song !== 'object') {
            return null;
        }

        const imageUrl = song?.image_url ?? song?.thumbnail_url ?? song?.cover_image_url ?? song?.artwork_url ?? null;
        if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim()) {
            return { url: getSunoThumbnailUrl(imageUrl.trim()), type: 'image' };
        }

        const webmUrl = song?.cover_video_url ?? song?.video_url ?? song?.video_cdn_url ?? song?.mp4_url ?? null;
        if (webmUrl && typeof webmUrl === 'string' && webmUrl.trim()) {
            const lower = webmUrl.split('?')[0].toLowerCase();
            if (lower.endsWith('.webm') || lower.endsWith('.mp4')) {
                return { url: webmUrl.trim(), type: 'video' };
            }
        }

        return null;
    }

    function getSongThumbnailSignature(song) {
        const source = getSongThumbnailSource(song);
        if (!source?.url) {
            return '';
        }

        return `${source.type || 'unknown'}:${source.url}`;
    }

    function getSunoThumbnailUrl(url) {
        if (typeof url !== 'string' || !url.trim()) {
            return url;
        }

        try {
            const parsed = new URL(url, window.location.href);
            if (!parsed.hostname.endsWith('suno.ai')) {
                return url;
            }

            parsed.searchParams.set('width', '100');
            return parsed.toString();
        } catch {
            return url;
        }
    }

    function normalizeLikeFlag(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'on', 'liked', 'like'].includes(normalized)) return true;
            if (['0', 'false', 'no', 'off', 'disliked', 'dislike', 'none', 'null', ''].includes(normalized)) return false;
        }
        return false;
    }

    function normalizeUpvoteCount(value) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
        }

        if (typeof value === 'string') {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed) && parsed >= 0) {
                return Math.floor(parsed);
            }
        }

        return 0;
    }

    function areSongDetailsEqual(leftSong, rightSong) {
        return (
            (leftSong?.title || '') === (rightSong?.title || '') &&
            (leftSong?.lyrics || '') === (rightSong?.lyrics || '') &&
            (leftSong?.audio_url || '') === (rightSong?.audio_url || '') &&
            (leftSong?.video_url || '') === (rightSong?.video_url || '') &&
            (leftSong?.image_url || '') === (rightSong?.image_url || '') &&
            (leftSong?.owner_user_id || '') === (rightSong?.owner_user_id || '') &&
            (leftSong?.owner_handle || '') === (rightSong?.owner_handle || '') &&
            (leftSong?.owner_display_name || '') === (rightSong?.owner_display_name || '') &&
            leftSong?.is_public === rightSong?.is_public &&
            normalizeLikeFlag(leftSong?.is_liked) === normalizeLikeFlag(rightSong?.is_liked) &&
            leftSong?.is_stem === rightSong?.is_stem &&
            normalizeUpvoteCount(leftSong?.upvote_count) === normalizeUpvoteCount(rightSong?.upvote_count) &&
            (leftSong?.is_owned_by_current_user ?? null) === (rightSong?.is_owned_by_current_user ?? null)
        );
    }

    function mergeSongMetadata(existingSong, freshSong) {
        return {
            ...existingSong,
            title: freshSong.title ?? existingSong.title,
            audio_url: freshSong.audio_url || existingSong.audio_url,
            video_url: freshSong.video_url || existingSong.video_url,
            image_url: freshSong.image_url || existingSong.image_url,
            lyrics: freshSong.lyrics ?? existingSong.lyrics,
            is_public: typeof freshSong.is_public === 'boolean' ? freshSong.is_public : existingSong.is_public,
            is_liked: freshSong.is_liked !== undefined ? normalizeLikeFlag(freshSong.is_liked) : normalizeLikeFlag(existingSong.is_liked),
            is_stem: freshSong.is_stem ?? existingSong.is_stem,
            upvote_count: freshSong.upvote_count !== undefined ? normalizeUpvoteCount(freshSong.upvote_count) : normalizeUpvoteCount(existingSong.upvote_count),
            owner_user_id: freshSong.owner_user_id || existingSong.owner_user_id,
            owner_handle: freshSong.owner_handle || existingSong.owner_handle,
            owner_display_name: freshSong.owner_display_name || existingSong.owner_display_name,
            is_owned_by_current_user: freshSong.is_owned_by_current_user ?? existingSong.is_owned_by_current_user
        };
    }

    function normalizeSongClip(rawClip) {
        const clip = rawClip?.clip || rawClip?.song || rawClip?.item || rawClip || {};
        const songId = extractSongIdFromClipItem(rawClip);

        const upvoteCandidate =
            clip.upvote_count ??
            rawClip?.upvote_count ??
            clip.like_count ??
            rawClip?.like_count ??
            clip.likes ??
            rawClip?.likes ??
            clip.score ??
            rawClip?.score ??
            clip.stats?.upvotes ??
            rawClip?.stats?.upvotes ??
            clip.stats?.likes ??
            rawClip?.stats?.likes;

        const upvoteCount = normalizeUpvoteCount(upvoteCandidate);

        const likeCandidate =
            clip.is_liked ??
            rawClip?.is_liked ??
            clip.liked ??
            rawClip?.liked ??
            clip.reaction_type ??
            rawClip?.reaction_type ??
            clip.current_user_reaction ??
            rawClip?.current_user_reaction ??
            clip.user_reaction ??
            rawClip?.user_reaction ??
            clip.isLike ??
            rawClip?.isLike ??
            clip.react ??
            rawClip?.react ??
            clip.upvote ??
            rawClip?.upvote;

        const isLiked = normalizeLikeFlag(likeCandidate);

        return {
            id: songId,
            title: clip.title || rawClip?.title || `Untitled_${songId || 'song'}`,
            audio_url: extractFirstMatchingValue(clip, SONG_CLIP_FIELD_PATHS.audio, value => value || null)
                || extractFirstMatchingValue(rawClip, SONG_CLIP_FIELD_PATHS.audio, value => value || null),
            video_url: extractUrlFromPaths(clip, SONG_CLIP_FIELD_PATHS.video)
                || extractUrlFromPaths(rawClip, SONG_CLIP_FIELD_PATHS.video),
            image_url: extractUrlFromPaths(clip, SONG_CLIP_FIELD_PATHS.image)
                || extractUrlFromPaths(rawClip, SONG_CLIP_FIELD_PATHS.image),
            lyrics: extractTextFromPaths(clip, SONG_CLIP_FIELD_PATHS.lyrics)
                || extractTextFromPaths(rawClip, SONG_CLIP_FIELD_PATHS.lyrics),
            is_public: (clip.is_public ?? rawClip?.is_public) !== false,
            created_at: clip.created_at || clip.createdAt || rawClip?.created_at || null,
            is_liked: isLiked,
            is_stem: isStemClip(clip),
            upvote_count: upvoteCount,
            owner_user_id: extractFirstMatchingValue(clip, SONG_CLIP_FIELD_PATHS.ownerUserId, value => value || null)
                || extractFirstMatchingValue(rawClip, SONG_CLIP_FIELD_PATHS.ownerUserId, value => value || null),
            owner_handle: extractFirstMatchingValue(clip, ['handle', 'user_handle', 'owner_handle', 'creator_handle', 'author_handle', 'username'], value => (typeof value === 'string' ? value.trim() : null))
                || extractFirstMatchingValue(rawClip, ['handle', 'user_handle', 'owner_handle', 'creator_handle', 'author_handle', 'username'], value => (typeof value === 'string' ? value.trim() : null)),
            owner_display_name: extractFirstMatchingValue(clip, ['display_name', 'user_display_name', 'owner_display_name', 'creator_display_name', 'author_display_name', 'name'], value => (typeof value === 'string' ? value.trim() : null))
                || extractFirstMatchingValue(rawClip, ['display_name', 'user_display_name', 'owner_display_name', 'creator_display_name', 'author_display_name', 'name'], value => (typeof value === 'string' ? value.trim() : null)),
            is_owned_by_current_user: clip.is_owned_by_current_user ?? rawClip?.is_owned_by_current_user
        };
    }

    function extractPlaylistClipItems(data) {
        if (!data || typeof data !== 'object') return [];
        if (Array.isArray(data) && data.length > 0) return data;

        const collections = [
            data.playlist_clips,
            data.playlist_songs,
            data.songs,
            data.tracks,
            data.entries,
            data.clips,
            data.results,
            data.items,
            data.playlist?.playlist_clips,
            data.playlist?.playlist_songs,
            data.playlist?.songs,
            data.playlist?.tracks,
            data.playlist?.entries,
            data.playlist?.clips,
            data.playlist?.results,
            data.playlist?.items,
            data.data?.playlist_clips,
            data.data?.playlist_songs,
            data.data?.songs,
            data.data?.tracks,
            data.data?.entries,
            data.data?.clips,
            data.data?.results,
            data.data?.items,
            data.data?.playlist?.playlist_clips,
            data.data?.playlist?.playlist_songs,
            data.data?.playlist?.songs,
            data.data?.playlist?.tracks,
            data.data?.playlist?.entries,
            data.data?.playlist?.clips,
            data.data?.playlist?.results,
            data.data?.playlist?.items
        ];

        for (const collection of collections) {
            if (Array.isArray(collection) && collection.length > 0) {
                return collection;
            }
        }

        // Deep fallback: recursively search for any array of clip-like objects
        const looksLikeClip = (item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            return !!(item.id || item.clip_id || item.song_id || item.clip?.id || item.song?.id);
        };
        const searched = new Set();
        const search = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 4 || searched.has(node)) return null;
            searched.add(node);
            if (Array.isArray(node)) {
                return (node.length > 0 && node.some(looksLikeClip)) ? node : null;
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value) && value.length > 0 && value.some(looksLikeClip)) {
                    return value;
                }
            }
            for (const value of Object.values(node)) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const found = search(value, depth + 1);
                    if (found) return found;
                }
            }
            return null;
        };
        return search(data, 0) || [];
    }

    function extractPlaylistItems(data) {
        if (Array.isArray(data)) return data;
        if (!data || typeof data !== 'object') return [];

        const collections = [
            data.playlists,
            data.results,
            data.items,
            data.data?.playlists,
            data.data?.results,
            data.data?.items,
            data.collection?.playlists,
            data.collection?.results,
            data.collection?.items
        ];

        for (const collection of collections) {
            if (Array.isArray(collection)) {
                return collection;
            }
        }

        return [];
    }

    function extractPlaylistTotal(data, fallbackCount = 0) {
        if (!data || typeof data !== 'object') return fallbackCount;

        const candidates = [
            data.num_total_results,
            data.total,
            data.total_results,
            data.total_count,
            data.count,
            data.data?.num_total_results,
            data.data?.total,
            data.data?.total_results,
            data.data?.total_count,
            data.data?.count,
            data.playlist?.num_total_results,
            data.playlist?.total,
            data.playlist?.total_results,
            data.playlist?.total_count,
            data.playlist?.count,
            data.data?.playlist?.num_total_results,
            data.data?.playlist?.total,
            data.data?.playlist?.total_results,
            data.data?.playlist?.total_count,
            data.data?.playlist?.count,
            data.playlist_songs?.total,
            data.playlist_songs?.total_results,
            data.playlist_songs?.count,
            data.playlist_songs?.num_total_results,
            data.playlist?.playlist_songs?.total,
            data.playlist?.playlist_songs?.total_results,
            data.playlist?.playlist_songs?.count,
            data.playlist?.playlist_songs?.num_total_results,
            data.data?.playlist_songs?.total,
            data.data?.playlist_songs?.total_results,
            data.data?.playlist_songs?.count,
            data.data?.playlist_songs?.num_total_results
        ];

        for (const value of candidates) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value;
            }
        }

        return fallbackCount;
    }

    async function hydratePlaylistSongsById(songIds) {
        if (!Array.isArray(songIds) || songIds.length === 0) {
            return [];
        }

        try {
            const response = await api.runtime.sendMessage({
                action: 'fetch_songs_by_ids',
                songIds
            });

            if (!response?.ok || !response.data) {
                return [];
            }

            const clips = Array.isArray(response.data.clips)
                ? response.data.clips
                : extractPlaylistClipItems(response.data);

            return clips
                .map(normalizeSongClip)
                .filter(song => !!song.id);
        } catch (e) {
            console.debug('[Downloader] Failed to hydrate playlist songs by id:', e);
            return [];
        }
    }

    // ========================================================================
    // Audio Player
    // ========================================================================
    const miniPlayer = document.getElementById('bettersuno-mini-player');
    const audioElement = document.getElementById('bettersuno-audio-element');
    const playPauseBtn = document.getElementById('player-play-pause');
    const playerTitle = document.getElementById('player-song-title');
    const progressBar = document.getElementById('player-progress-bar');
    const progressContainer = progressBar?.parentElement || null;
    const playerTime = document.getElementById('player-time');
    let progressHandle = null;

    // Player tab references
    const playerTabVideo = document.getElementById('player-tab-video');
    const playerTabCoverImage = document.getElementById('player-tab-cover-image');
    const playerTabTitle = document.getElementById('player-tab-title');
    const playerTabLyrics = document.getElementById('player-tab-lyrics');
    const playerTabViewCover = document.getElementById('player-tab-view-cover');
    const playerTabViewLyrics = document.getElementById('player-tab-view-lyrics');
    const playerTabSubtabCover = document.getElementById('player-tab-subtab-cover');
    const playerTabSubtabLyrics = document.getElementById('player-tab-subtab-lyrics');
    const playerTabNoSong = document.getElementById('player-tab-no-song');
    const playerTabSong = document.getElementById('player-tab-song');
    const playerTabPlayPause = document.getElementById('player-tab-play-pause');
    const playerTabPrev = document.getElementById('player-tab-prev');
    const playerTabNext = document.getElementById('player-tab-next');
    const playerTabProgressBar = document.getElementById('player-tab-progress-bar');
    const playerTabProgressContainer = document.getElementById('player-tab-progress-container');
    const playerTabTime = document.getElementById('player-tab-time');
    let playerTabProgressHandle = null;
    let playerTabMediaRequestId = 0;
    let playerTabCurrentView = 'cover';

    function setPlayerTabView(view) {
        const nextView = view === 'lyrics' ? 'lyrics' : 'cover';
        playerTabCurrentView = nextView;

        if (playerTabViewCover) {
            playerTabViewCover.style.display = nextView === 'cover' ? 'flex' : 'none';
        }
        if (playerTabViewLyrics) {
            playerTabViewLyrics.style.display = nextView === 'lyrics' ? 'flex' : 'none';
        }

        if (playerTabSubtabCover) {
            playerTabSubtabCover.classList.toggle('active', nextView === 'cover');
        }
        if (playerTabSubtabLyrics) {
            playerTabSubtabLyrics.classList.toggle('active', nextView === 'lyrics');
        }
    }

    if (playerTabSubtabCover) {
        playerTabSubtabCover.addEventListener('click', () => setPlayerTabView('cover'));
    }
    if (playerTabSubtabLyrics) {
        playerTabSubtabLyrics.addEventListener('click', () => setPlayerTabView('lyrics'));
    }
    setPlayerTabView(playerTabCurrentView);

    if (progressContainer) {
        progressHandle = progressContainer.querySelector('#player-progress-handle');
        if (!progressHandle) {
            progressHandle = document.createElement('div');
            progressHandle.id = 'player-progress-handle';
            progressContainer.appendChild(progressHandle);
        }
    }

    if (playerTabProgressContainer) {
        playerTabProgressHandle = playerTabProgressContainer.querySelector('#player-tab-progress-handle');
        if (!playerTabProgressHandle) {
            playerTabProgressHandle = document.createElement('div');
            playerTabProgressHandle.id = 'player-tab-progress-handle';
            playerTabProgressHandle.className = 'player-tab-progress-handle';
            playerTabProgressContainer.appendChild(playerTabProgressHandle);
        }
    }

    function formatPlayerTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            return '0:00';
        }

        const total = Math.floor(seconds);
        const mins = Math.floor(total / 60);
        const secs = String(total % 60).padStart(2, '0');
        return `${mins}:${secs}`;
    }

    function updatePlayerProgressUi() {
        if (!audioElement) {
            return;
        }

        const duration = Number.isFinite(audioElement.duration) && audioElement.duration > 0
            ? audioElement.duration
            : 0;
        const current = Number.isFinite(audioElement.currentTime) && audioElement.currentTime >= 0
            ? audioElement.currentTime
            : 0;

        const percent = duration > 0
            ? Math.max(0, Math.min(100, (current / duration) * 100))
            : 0;

        if (progressBar) {
            progressBar.style.width = `${percent}%`;
        }
        if (progressHandle) {
            progressHandle.style.left = `${percent}%`;
        }
        if (playerTime) {
            playerTime.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;
        }

        // Sync player tab progress
        if (playerTabProgressBar) {
            playerTabProgressBar.style.width = `${percent}%`;
        }
        if (playerTabProgressHandle) {
            playerTabProgressHandle.style.left = `${percent}%`;
        }
        if (playerTabTime) {
            playerTabTime.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;
        }
    }

    function seekAudioFromProgressContainer(container, bar, handle, event) {
        if (!audioElement || !container) {
            return;
        }

        if (!Number.isFinite(audioElement.duration) || audioElement.duration <= 0) {
            return;
        }

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) {
            return;
        }

        const rawOffset = event.clientX - rect.left;
        const clampedOffset = Math.max(0, Math.min(rect.width, rawOffset));
        const seekRatio = clampedOffset / rect.width;
        const seekPercent = seekRatio * 100;

        if (bar) {
            bar.style.width = `${seekPercent}%`;
        }
        if (handle) {
            handle.style.left = `${seekPercent}%`;
        }

        audioElement.currentTime = seekRatio * audioElement.duration;
        updatePlayerProgressUi();
    }

    async function togglePlay(song) {
        if (!song || !song.audio_url) return;

        if (currentPlayingSongId === song.id) {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '■';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
        } else {
            // Remember the previous blob URL so we can revoke it after switching sources
            const prevBlobUrl = currentBlobUrl;
            currentBlobUrl = null;

            currentPlayingSongId = song.id;

            // Reset progress immediately so next/previous track changes are reflected
            // before metadata/timeupdate events arrive for the new source.
            if (audioElement) {
                audioElement.pause();
                audioElement.removeAttribute('src');
                audioElement.load();
                updatePlayerProgressUi();
            }

            // Use cached audio if available, otherwise stream online (respect requested format if available)
            const cachedBlob = await getAudioBlobFromIDB(song.id);
            if (cachedBlob) {
                currentBlobUrl = URL.createObjectURL(cachedBlob);
                audioElement.src = currentBlobUrl;
            } else {
                const desiredFormat = getSelectedFormat();
                audioElement.src = getAudioUrlForFormat(song, desiredFormat) || song.audio_url;
            }

            audioElement.currentTime = 0;
            updatePlayerProgressUi();

            // Revoke the previous blob URL now that the audio element has moved to the new source
            if (prevBlobUrl) {
                URL.revokeObjectURL(prevBlobUrl);
            }

            audioElement.load();
            audioElement.play();
            miniPlayer.style.display = 'block';
            playerTitle.textContent = song.title || 'Untitled';
            playPauseBtn.textContent = '■';

            updatePlayerTabUi(song);
            refreshVisibleSongPlaybackState();
        }
    }

    function getPreviousSong() {
        if (!Array.isArray(sortedFilteredSongs) || sortedFilteredSongs.length === 0) {
            return null;
        }

        const currentIndex = sortedFilteredSongs.findIndex(song => song.id === currentPlayingSongId);
        if (currentIndex <= 0) {
            return null;
        }

        return sortedFilteredSongs[currentIndex - 1] || null;
    }

    function getNextSongForPlayback() {
        if (!Array.isArray(sortedFilteredSongs) || sortedFilteredSongs.length === 0) {
            return null;
        }

        const currentIndex = sortedFilteredSongs.findIndex(song => song.id === currentPlayingSongId);
        if (currentIndex < 0) {
            return sortedFilteredSongs[0] || null;
        }

        return sortedFilteredSongs[currentIndex + 1] || null;
    }

    function updatePlayerTabUi(song) {
        if (!playerTabSong || !playerTabNoSong) return;

        const isLikelyVideoUrl = (url) => {
            if (typeof url !== 'string') return false;
            const cleaned = url.split('?')[0].toLowerCase();
            return cleaned.endsWith('.mp4') || cleaned.endsWith('.webm') || cleaned.endsWith('.mov') || cleaned.endsWith('.m4v');
        };

        const deriveProcessedVideoUrl = (...values) => {
            for (const value of values) {
                if (typeof value !== 'string' || !value) continue;
                const match = value.match(/video_gen_([0-9a-f-]{36})/i);
                if (match?.[1]) {
                    return `https://cdn1.suno.ai/video_gen_${match[1]}_processed_video.mp4`;
                }
            }
            return null;
        };

        const hideVideo = () => {
            if (!playerTabVideo) return;
            playerTabVideo.pause();
            playerTabVideo.removeAttribute('src');
            playerTabVideo.load();
            playerTabVideo.style.display = 'none';
            playerTabVideo.onerror = null;
            playerTabVideo.onloadeddata = null;
        };

        const hideCoverImage = () => {
            if (!playerTabCoverImage) return;
            playerTabCoverImage.style.display = 'none';
            playerTabCoverImage.removeAttribute('src');
        };

        const showCoverImage = (src) => {
            if (!playerTabCoverImage) return;
            if (src) {
                playerTabCoverImage.src = src;
                playerTabCoverImage.style.display = 'block';
            } else {
                hideCoverImage();
            }
        };

        const showNoMedia = () => {
            hideVideo();
            showCoverImage(thumbnailUrl);
        };

        const showVideo = (src, posterUrl = null) => {
            hideCoverImage();
            playerTabVideo.muted = true;
            playerTabVideo.loop = true;
            playerTabVideo.playsInline = true;
            playerTabVideo.poster = posterUrl || '';
            playerTabVideo.src = src;
            playerTabVideo.style.display = 'block';
            playerTabVideo.onerror = () => {
                showNoMedia();
            };
            playerTabVideo.onloadeddata = () => {
                const playPromise = playerTabVideo.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {
                        // Keep video visible even if autoplay is blocked.
                    });
                }
            };
            const initialPlayPromise = playerTabVideo.play();
            if (initialPlayPromise && typeof initialPlayPromise.catch === 'function') {
                initialPlayPromise.catch(() => {
                    // loadeddata may still trigger playback.
                });
            }
        };

        if (!song) {
            playerTabMediaRequestId += 1;
            playerTabNoSong.style.display = 'flex';
            playerTabSong.style.display = 'none';
            hideVideo();
            if (playerTabCoverImage) playerTabCoverImage.style.display = 'none';
            return;
        }

        const requestId = ++playerTabMediaRequestId;
        const isStillCurrentSong = () => requestId === playerTabMediaRequestId && currentPlayingSongId === song.id;

        playerTabNoSong.style.display = 'none';
        playerTabSong.style.display = 'flex';
        setPlayerTabView(playerTabCurrentView);

        if (playerTabTitle) {
            playerTabTitle.textContent = song.title || 'Untitled';
        }

        if (playerTabLyrics) {
            const lyrics = song.lyrics || '';
            playerTabLyrics.textContent = lyrics || 'No lyrics available.';
        }

        // Update cover media: video only
        const thumbnailUrl = song.image_url || song.thumbnail_url || song.cover_image_url || song.artwork_url || null;
        const derivedProcessedVideoUrl = deriveProcessedVideoUrl(
            song.video_url,
            song.image_url,
            song.thumbnail_url,
            song.cover_image_url,
            song.artwork_url
        );
        const videoUrl =
            derivedProcessedVideoUrl ||
            song.video_url ||
            song.video_cdn_url ||
            song.mp4_url ||
            song.cover_video_url ||
            (isLikelyVideoUrl(song.image_url) ? song.image_url : null) ||
            (isLikelyVideoUrl(song.thumbnail_url) ? song.thumbnail_url : null) ||
            (isLikelyVideoUrl(song.cover_image_url) ? song.cover_image_url : null) ||
            null;

        if (playerTabVideo) {
            if (videoUrl) {
                showVideo(videoUrl, thumbnailUrl);
            } else {
                showNoMedia();
            }

            // Resolve preferred cover video from the Suno song page.
            // This can replace metadata URLs that point to the wrong clip.
            if (song.id) {
                void (async () => {
                    try {
                        const response = await api.runtime.sendMessage({
                            action: 'resolve_song_cover_video',
                            songId: song.id
                        });

                        if (!isStillCurrentSong()) {
                            return;
                        }

                        const resolvedUrl = (response?.ok && typeof response.videoUrl === 'string')
                            ? response.videoUrl
                            : null;

                        if (resolvedUrl && (!videoUrl || resolvedUrl !== videoUrl)) {
                            showVideo(resolvedUrl, thumbnailUrl);
                        }
                    } catch (e) {
                        // Keep existing image/fallback display if resolving cover video fails.
                    }
                })();
            }
        }
    }

    async function playNextSongAutomatically() {
        const nextSong = getNextSongForPlayback();
        if (!nextSong) {
            currentPlayingSongId = null;
            playPauseBtn.textContent = '▶';
            playerTitle.textContent = 'Queue finished';
            updatePlayerTabUi(null);
            refreshVisibleSongPlaybackState();
            return;
        }

        await togglePlay(nextSong);
    }

    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '■';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
            refreshVisibleSongPlaybackState();
        });
    }

    if (playerTabPlayPause) {
        playerTabPlayPause.addEventListener('click', () => {
            if (!audioElement) return;
            if (audioElement.paused) {
                audioElement.play();
            } else {
                audioElement.pause();
            }
            refreshVisibleSongPlaybackState();
        });
    }

    if (playerTabPrev) {
        playerTabPrev.addEventListener('click', () => {
            const prevSong = getPreviousSong();
            if (prevSong) {
                togglePlay(prevSong);
            }
        });
    }

    if (playerTabNext) {
        playerTabNext.addEventListener('click', () => {
            const nextSong = getNextSongForPlayback();
            if (nextSong) {
                togglePlay(nextSong);
            }
        });
    }

    if (audioElement) {
        audioElement.addEventListener('timeupdate', () => {
            updatePlayerProgressUi();
        });

        audioElement.addEventListener('loadedmetadata', () => {
            updatePlayerProgressUi();
        });

        audioElement.addEventListener('durationchange', () => {
            updatePlayerProgressUi();
        });

        audioElement.addEventListener('canplay', () => {
            updatePlayerProgressUi();
        });

        audioElement.addEventListener('seeked', () => {
            updatePlayerProgressUi();
        });

        audioElement.addEventListener('play', () => {
            refreshVisibleSongPlaybackState();
        });

        audioElement.addEventListener('pause', () => {
            refreshVisibleSongPlaybackState();
        });

        audioElement.addEventListener('ended', () => {
            void playNextSongAutomatically();
        });
    }

    if (audioElement && progressContainer) {
        progressContainer.addEventListener('click', (event) => {
            seekAudioFromProgressContainer(progressContainer, progressBar, progressHandle, event);
        });
    }

    if (audioElement && playerTabProgressContainer) {
        playerTabProgressContainer.addEventListener('click', (event) => {
            seekAudioFromProgressContainer(playerTabProgressContainer, playerTabProgressBar, playerTabProgressHandle, event);
        });
    }

    // ========================================================================
    // IndexedDB Helpers
    // ========================================================================

    const idbApi = window.BetterSunoIDB;

    if (!idbApi) {
        console.error('[Downloader] BetterSunoIDB is unavailable');
        return;
    }

    const {
        deleteAudioBlobFromIDB,
        deleteImageBlobFromIDB,
        deletePreferenceFromIDB,
        estimateDbUsageBytes,
        getAllCachedSongIdsFromIDB,
        getAllRecordsFromStore,
        getAudioBlobFromIDB,
        getImageBlobFromIDB,
        loadPreferenceFromIDB,
        loadSongsFromIDB,
        saveAudioBlobToIDB,
        saveImageBlobToIDB,
        savePreferenceToIDB,
        saveSongsToIDB
    } = idbApi;

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        const rounded = value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1);
        return `${rounded} ${units[unitIndex]}`;
    }

    // ========================================================================
    // DOM Elements
    // ========================================================================

    const statusDiv = document.getElementById("status");
    const folderInput = document.getElementById("folder");
    function getSelectedFormat() {
        const el = document.querySelector('input[name="format"]:checked');
        return el ? el.value : 'm4a';
    }

    function getAudioUrlForFormat(song, format) {
        if (!song || !song.audio_url) return null;
        const requested = String(format || '').trim().toLowerCase();
        const originalUrl = String(song.audio_url || '').trim();

        if (!requested || !originalUrl) return originalUrl;

        const urlCandidates = [
            song.audio_url,
            song.stream_audio_url,
            song.song_path,
            song.metadata?.audio_url,
            song.metadata?.stream_audio_url,
            song.metadata?.song_path,
            song.meta?.audio_url,
            song.meta?.stream_audio_url,
            song.meta?.song_path
        ].filter(Boolean);

        for (const candidate of urlCandidates) {
            const normalized = String(candidate || '').toLowerCase();
            if (requested === 'm4a' && normalized.includes('.m4a')) return candidate;
            if (requested === 'wav' && normalized.includes('.wav')) return candidate;
            if (requested === 'mp3' && normalized.includes('.mp3')) return candidate;
        }

        const queryIndex = originalUrl.indexOf('?');
        const base = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
        const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
        const converted = base.replace(/\.([a-z0-9]{2,5})$/i, `.${requested}`);

        if (converted !== base) {
            return converted + query;
        }

        if (!/\bformat=/i.test(originalUrl)) {
            return originalUrl + (originalUrl.includes('?') ? '&' : '?') + `format=${encodeURIComponent(requested)}`;
        }

        return originalUrl;
    }

    const formatRadios = document.querySelectorAll('input[name="format"]');
    
    // Default settings (no longer in UI)
    const maxPages = 0; // 0 = unlimited
    const isPublicOnly = false; // fetch all songs
    const downloadBtn = document.getElementById("downloadBtn");
    const stopDownloadBtn = document.getElementById("stopDownloadBtn");
    const stopFetchBtn = document.getElementById("bettersuno-stop-fetch-btn");
    const cacheAllBtn = document.getElementById("cacheAllBtn");
    const stopCacheBtn = document.getElementById("stopCacheBtn");
    const deleteCachedBtn = document.getElementById("deleteCachedBtn");
    const dbUsageValue = document.getElementById("bettersuno-db-usage");
    const filterInput = document.getElementById("filterInput");
    const filterLiked = document.getElementById("filterLiked");
    const filterStems = document.getElementById("filterStems");
    const filterPublic = document.getElementById("filterPublic");
    const filterOffline = document.getElementById("filterOffline");
    const playlistFilter = document.getElementById("playlistFilter");
    const refreshPlaylistsBtn = document.getElementById("refreshPlaylistsBtn");
    const selectAllButton = document.getElementById("selectAll");
    const syncNewBtn = document.getElementById("syncNewBtn");
    const downloadMusicCheckbox = document.getElementById("downloadMusic");
    const downloadLyricsCheckbox = document.getElementById("downloadLyrics");
    const downloadImageCheckbox = document.getElementById("downloadImage");
    const songList = document.getElementById("songList");
    const songCount = document.getElementById("songCount");
    const songListContainer = document.getElementById("songListContainer");

    function getVisibleSongIds() {
        if (!songList) {
            return [];
        }

        const containerRect = songList.getBoundingClientRect();
        const bufferedTop = containerRect.top - 80;
        const bufferedBottom = containerRect.bottom + 80;

        return Array.from(songList.querySelectorAll('.song-item[data-song-id]'))
            .filter(item => {
                const r = item.getBoundingClientRect();
                return r.bottom >= bufferedTop && r.top <= bufferedBottom;
            })
            .map(item => item.dataset.songId)
            .filter(Boolean);
    }

    function refreshVisibleSongItems(songIds) {
        if (!songList || !Array.isArray(songIds) || songIds.length === 0) {
            return;
        }

        songIds.forEach(songId => {
            const oldItem = Array.from(songList.querySelectorAll('.song-item[data-song-id]'))
                .find(el => el.dataset.songId === songId);
            if (!oldItem) {
                return;
            }

            const song = getActiveSongs().find(s => s.id === songId) || allSongs.find(s => s.id === songId);
            if (!song) {
                return;
            }

            const newItem = createSongListItem(song);
            if ((oldItem.dataset.thumbnailSignature || '') === (newItem.dataset.thumbnailSignature || '')) {
                const oldThumbnail = oldItem.querySelector('.song-thumbnail');
                const newThumbnail = newItem.querySelector('.song-thumbnail');
                if (oldThumbnail && newThumbnail && newThumbnail.parentNode === newItem) {
                    newItem.replaceChild(oldThumbnail, newThumbnail);
                }
            }
            songList.replaceChild(newItem, oldItem);
            songItemCache.set(songId, newItem);
        });
    }

    function refreshCurrentVisibleSongMetadata(options = {}) {
        const { forceRefresh = false } = options;
        const visibleIds = getVisibleSongIds();
        if (visibleIds.length === 0) {
            return;
        }

        refreshVisibleSongItems(visibleIds);
        void refreshVisibleSongsMetadata(visibleIds, { forceRefresh });
    }

    function scheduleVisibleSongRefresh() {
        if (songListVisibleRefreshTimer) {
            clearTimeout(songListVisibleRefreshTimer);
        }
        if (songListVisibleRefreshFollowupTimer) {
            clearTimeout(songListVisibleRefreshFollowupTimer);
        }
        if (songListVisibleRefreshIntervalTimer) {
            clearInterval(songListVisibleRefreshIntervalTimer);
        }
        songListVisibleRefreshTimer = setTimeout(() => {
            refreshCurrentVisibleSongMetadata();
            songListVisibleRefreshFollowupTimer = setTimeout(() => {
                refreshCurrentVisibleSongMetadata({ forceRefresh: true });
            }, VISIBLE_SONG_REFRESH_REPEAT_MS);
            songListVisibleRefreshIntervalTimer = setInterval(() => {
                refreshCurrentVisibleSongMetadata({ forceRefresh: true });
            }, VISIBLE_SONG_REFRESH_INTERVAL_MS);
        }, VISIBLE_SONG_REFRESH_DEBOUNCE_MS);
    }

    if (songList) {
        songList.addEventListener('scroll', scheduleVisibleSongRefresh);
        window.addEventListener('resize', scheduleVisibleSongRefresh);
    }
    const versionFooter = document.getElementById("versionFooter");

    // hide stop-fetch button initially
    if (stopFetchBtn) {
        stopFetchBtn.style.display = 'none';
    }

    function setFetchUiState(active) {
        if (syncNewBtn) {
            syncNewBtn.disabled = false;
            syncNewBtn.textContent = active ? 'Stop' : 'Refresh';
            syncNewBtn.classList.toggle('btn-stop', active);
        }
        if (stopFetchBtn) {
            stopFetchBtn.style.display = 'none';
        }
    }

    function stopCurrentFetch() {
        if (currentFetchMode === 'idle') {
            return;
        }

        statusDiv.innerText = 'Stopping refresh...';
        currentFetchMode = 'idle';
        currentMetadataRefreshRequested = false;
        setFetchUiState(false);

        try {
            api.runtime.sendMessage({ action: 'stop_fetch' });
        } catch (e) {
            console.debug('[Downloader] Could not send stop fetch request:', e?.message || String(e));
        }
    }

    function formatRelativeTime(value) {
        if (!value) {
            return 'never';
        }

        const ts = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(ts)) {
            return 'unknown';
        }

        const diffMs = Date.now() - ts;
        const diffMinutes = Math.round(diffMs / 60000);
        if (diffMinutes <= 1) return 'just now';
        if (diffMinutes < 60) return `${diffMinutes}m ago`;

        const diffHours = Math.round(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours}h ago`;

        const diffDays = Math.round(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;

        try {
            return new Date(ts).toLocaleDateString();
        } catch {
            return 'unknown';
        }
    }

    async function refreshDbUsageDisplay() {
        if (!dbUsageValue) {
            return;
        }

        dbUsageValue.textContent = 'Calculating...';
        try {
            const bytes = await estimateDbUsageBytes();
            dbUsageValue.textContent = `${formatBytes(bytes)} used locally`;
            dbUsageValue.title = `Approximate IndexedDB usage for BetterSuno: ${bytes.toLocaleString()} bytes`;
        } catch (e) {
            dbUsageValue.textContent = 'Unavailable';
            dbUsageValue.title = e?.message || 'Failed to measure IndexedDB usage';
        }
    }

    async function saveSyncMeta(patch = {}) {
        syncMeta = {
            ...syncMeta,
            ...patch
        };
        try {
            await savePreferenceToIDB(SYNC_META_KEY, syncMeta);
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('[Downloader] Failed to save sync metadata:', e);
        }
    }

    function setCachingUiState(active) {
        if (cacheAllBtn) {
            cacheAllBtn.disabled = active;
            cacheAllBtn.textContent = active ? 'Saving to DB...' : 'Save to DB';
        }
        if (stopCacheBtn) {
            stopCacheBtn.disabled = false;
            stopCacheBtn.classList.toggle('hidden', !active);
        }
    }



    try {
        const version = api.runtime.getManifest()?.version;
        if (versionFooter && version) {
            versionFooter.textContent = `v${version}`;
        }
    } catch (e) {
        if (versionFooter) {
            versionFooter.textContent = "v?";
        }
    }

    // Load from storage on startup
    loadFromStorage();

    // Save format preference when changed
    formatRadios.forEach(r => r.addEventListener("change", async () => {
        await savePreferenceToIDB('sunoFormat', getSelectedFormat());
    }));

    // Save folder preference when changed
    folderInput.addEventListener("change", () => {
        saveToStorage();
    });

    // Check if fetching is in progress
    checkFetchState();

    // Check if downloading is in progress (important when popup is reopened)
    checkDownloadState();

    function setDownloadUiState(isRunning) {
        if (isRunning) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = "Downloading...";
            stopDownloadBtn.classList.remove("hidden");
        } else {
            downloadBtn.disabled = false;
            downloadBtn.textContent = "Download";
            stopDownloadBtn.classList.add("hidden");
        }
    }

    async function checkFetchState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_fetch_state" });
            if (response && response.isFetching) {
                currentFetchMode = syncMeta.lastSyncMode || 'incremental';
                statusDiv.innerText = "Fetching in progress...";
                setFetchUiState(true);
            }
        } catch (e) {
            // Ignore errors (e.g., no response)
        }
    }

    function startAutoFetch() {
        startFullRefresh({ confirmUser: true });
    }

    async function startFullRefresh(options = {}) {
        const { confirmUser = true } = options;
        if (currentFetchMode !== 'idle') {
            return;
        }

        currentMetadataRefreshRequested = false;

        if (confirmUser) {
            const proceed = confirm("BetterSuno will reload your full Suno library. This may take a while. Continue?");
            if (!proceed) {
                statusDiv.innerText = "Refresh cancelled.";
                return;
            }
        }

        currentFetchMode = 'full';
        setFetchUiState(true);
        void saveSyncMeta({
            syncStatus: 'running',
            lastSyncMode: 'full',
            lastError: null
        });

        statusDiv.innerText = "Refreshing full library...";
        console.log('[Downloader] Starting full refresh...');
        try {
            const response = await sendMessageWithRetry({
                action: "fetch_songs",
                isPublicOnly: isPublicOnly,
                maxPages: maxPages
            });
            if (response?.error) {
                console.error('[Downloader] Fetch songs error:', response.error);
                statusDiv.innerText = response.error;
            } else {
                console.log('[Downloader] Fetch request sent successfully');
            }
        } catch (e) {
            console.debug('[Downloader] Could not send fetch request:', e);
            statusDiv.innerText = "Fetching songs in background...";
            currentFetchMode = 'idle';
            setFetchUiState(false);
        }
    }

    async function startIncrementalSync(options = {}) {
        const { automatic = false, refreshMetadata = false } = options;

        if (currentFetchMode !== 'idle') {
            return;
        }

        if (!allSongs.length) {
            startFullRefresh({ confirmUser: !automatic });
            return;
        }

        const metadataRefreshIds = refreshMetadata
            ? allSongs.map(song => song.id).filter(id => typeof id === 'string' && id)
            : [];
        currentMetadataRefreshRequested = metadataRefreshIds.length > 0;

        currentFetchMode = 'incremental';
        setFetchUiState(true);
        void saveSyncMeta({
            syncStatus: 'running',
            lastSyncMode: 'incremental',
            lastError: null
        });

        statusDiv.innerText = automatic ? "Checking for new songs..." : "Refreshing songs and metadata...";

        try {
            const response = await sendMessageWithRetry({
                action: "fetch_songs",
                isPublicOnly: false,
                maxPages: 0,
                checkNewOnly: true,
                knownIds: allSongs.map(song => song.id),
                metadataRefreshIds
            });
            if (response?.error) {
                console.log('[Downloader] Incremental refresh error:', response.error);
            } else {
                console.log('[Downloader] Incremental refresh request sent');
            }
        } catch (e) {
            console.debug('[Downloader] Could not refresh:', e);
            currentFetchMode = 'idle';
            currentMetadataRefreshRequested = false;
            setFetchUiState(false);
            statusDiv.innerText = "Refresh failed: " + (e?.message || String(e));
            void saveSyncMeta({
                syncStatus: 'error',
                lastError: e?.message || String(e)
            });
        }
    }

    async function checkDownloadState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_download_state" });
            if (response && response.isDownloading) {
                setDownloadUiState(true);
                statusDiv.innerText = "Download in progress...";
            }
        } catch (e) {
            // Ignore errors
        }
    }

    async function loadFromStorage() {
        let savedSelectedPlaylist = '';
        try {
            console.log('[Downloader] Loading songs from IndexedDB...');
            // Load songs and cached audio IDs from IndexedDB in parallel
            const [savedSongs, savedFormat, savedSongsMeta, cachedIds, savedSyncMeta, persistedSelectedPlaylist] = await Promise.all([
                loadSongsFromIDB(),
                loadPreferenceFromIDB('sunoFormat'),
                loadPreferenceFromIDB('sunoSongsList'),
                getAllCachedSongIdsFromIDB(),
                loadPreferenceFromIDB(SYNC_META_KEY),
                loadPreferenceFromIDB(SELECTED_PLAYLIST_KEY)
            ]);
            savedSelectedPlaylist = persistedSelectedPlaylist || '';

            cachedSongIds = new Set(cachedIds);
            syncMeta = {
                ...createDefaultSyncMeta(),
                ...(savedSyncMeta || {})
            };
            console.log('[Downloader] Loaded', savedSongs?.length || 0, 'songs,', cachedSongIds.size, 'cached audio blobs from IndexedDB');
            void refreshDbUsageDisplay();

            // Load saved format preference first
            if (savedFormat) {
                const radio = document.querySelector(`input[name="format"][value="${savedFormat}"]`);
                if (radio) radio.checked = true;
            }
            
            if (savedSongs && savedSongs.length > 0) {
                allSongs = savedSongs;
                initSunoUserId();
                filteredSongs = [...allSongs];
                const needsMetadataRefresh = libraryNeedsMetadataRefresh(savedSongs);

                // Restore settings from metadata
                if (savedSongsMeta) {
                    if (savedSongsMeta.folder) folderInput.value = savedSongsMeta.folder;
                    if (savedSongsMeta.format) {
                        const radio = document.querySelector(`input[name="format"][value="${savedSongsMeta.format}"]`);
                        if (radio) radio.checked = true;
                    }
                }

                // Go directly to song list
                songListContainer.style.display = "block";
                filterInput.value = "";
                await loadFilterPreferences();
                applyFilter();

                scheduleVisibleSongRefresh();

                statusDiv.innerText = `${allSongs.length} cached songs. Checking for new...`;

                // Load playlists in background (non-blocking)
                void loadPlaylists();
                if (savedSelectedPlaylist) {
                    void selectPlaylist(savedSelectedPlaylist);
                }

                console.log('[Downloader] Showing cached songs, checking for new songs...');
                if (needsMetadataRefresh && !savedSelectedPlaylist) {
                    statusDiv.innerText = 'Refreshing all songs metadata...';
                    setTimeout(() => startFullRefresh({ confirmUser: false }), 100);
                } else {
                    // Check for new songs
                    setTimeout(() => checkForNewSongs(), 100);
                }
                return;
            }
        } catch (e) {
            console.error('[Downloader] Error loading from storage:', e);
        }

        void refreshDbUsageDisplay();

        console.log('[Downloader] No cached songs found, will prompt before auto-fetch...');
        // No cached songs — ask user before starting a full fetch
        songListContainer.style.display = "block";
        void loadPlaylists();
        if (savedSelectedPlaylist) {
            void selectPlaylist(savedSelectedPlaylist);
        }
        startAutoFetch();
    }

    function checkForNewSongs() {
        startIncrementalSync({ automatic: true });
    }

    function libraryNeedsMetadataRefresh(songs) {
        return Array.isArray(songs) && songs.some(song => song.upvote_count === undefined);
    }

    async function saveToStorage() {
        try {
            // Save songs to IndexedDB
            await saveSongsToIDB(allSongs);
            
            // Save metadata
            const metadata = {
                folder: folderInput.value,
                format: getSelectedFormat(),
                timestamp: Date.now()
            };
            await savePreferenceToIDB('sunoSongsList', metadata);
            await savePreferenceToIDB('sunoFormat', getSelectedFormat());
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('Failed to save to storage:', e);
        }
    }

    async function saveFilterPreferences() {
        try {
            await savePreferenceToIDB('sunoFilterLiked', filterLiked.checked);
            await savePreferenceToIDB('sunoFilterStems', filterStems.checked);
            await savePreferenceToIDB('sunoFilterPublic', filterPublic.checked);
            await savePreferenceToIDB('sunoFilterOffline', !!filterOffline?.checked);
        } catch (e) {
            console.error('Failed to save filter preferences:', e);
        }
    }

    async function loadFilterPreferences() {
        try {
            const liked = await loadPreferenceFromIDB('sunoFilterLiked');
            const stems = await loadPreferenceFromIDB('sunoFilterStems');
            const pub = await loadPreferenceFromIDB('sunoFilterPublic');
            const offline = await loadPreferenceFromIDB('sunoFilterOffline');
            
            if (liked !== null) filterLiked.checked = liked;
            if (stems !== null) filterStems.checked = stems;
            filterPublic.checked = (pub !== null) ? pub : true;
            if (filterOffline) {
                filterOffline.checked = offline === true;
            }
        } catch (e) {
            console.error('Failed to load filter preferences:', e);
            filterPublic.checked = true;
            if (filterOffline) {
                filterOffline.checked = false;
            }
        }
    }

    function mergeSongs(newSongs) {
        const existingIds = new Set(allSongs.map(s => s.id));
        const addedSongs = newSongs.filter(s => !existingIds.has(s.id));
        const staleImageSongIds = [];
        let metadataUpdateCount = 0;

        // Refresh mutable fields from fresh API data: title, lyrics, cover, liked/public state, counts, etc.
        if (newSongs.length > 0) {
            const newSongsById = new Map(newSongs.map(s => [s.id, s]));
            allSongs = allSongs.map(s => {
                const fresh = newSongsById.get(s.id);
                if (!fresh) {
                    return s;
                }

                const mergedSong = mergeSongMetadata(s, fresh);

                if (!areSongDetailsEqual(s, mergedSong)) {
                    metadataUpdateCount += 1;
                    songItemCache.delete(s.id);

                    const previousThumbnailSource = getSongThumbnailSource(s);
                    const nextThumbnailSource = getSongThumbnailSource(mergedSong);
                    if ((previousThumbnailSource?.url || '') !== (nextThumbnailSource?.url || '') || (previousThumbnailSource?.type || '') !== (nextThumbnailSource?.type || '')) {
                        mergedSong.image_cache_bust = Date.now();
                        staleImageSongIds.push(s.id);
                    }

                    if (currentPlayingSongId === s.id) {
                        updatePlayerTabUi(mergedSong);
                        if (playerTitle) {
                            playerTitle.textContent = mergedSong.title || 'Untitled';
                        }
                    }
                }

                return mergedSong;
            });
        }

        if (addedSongs.length > 0) {
            // Add new songs at the beginning
            allSongs = [...addedSongs, ...allSongs];
        }

        if (metadataUpdateCount > 0 || addedSongs.length > 0) {
            if (!Array.isArray(playlistSongs)) {
                filteredSongs = [...allSongs];
            }
            applyFilter({
                preserveScroll: true,
                minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
            });
            void saveToStorage();
        }

        if (staleImageSongIds.length > 0) {
            void Promise.all(staleImageSongIds.map(songId => deleteImageBlobFromIDB(songId)));
        }

        return {
            addedCount: addedSongs.length,
            metadataUpdateCount
        };
    }

    function shouldRefreshMetadataForSong(song) {
        if (!song || !song.id) return false;

        const lastRefreshed = metadataRefreshTimestamps.get(song.id);
        if (!lastRefreshed) return true;
        if (Date.now() - lastRefreshed > METADATA_REFRESH_INTERVAL_MS) return true;

        // If any primary fields are missing, refresh immediately.
        if (!song.title || !song.audio_url || song.upvote_count === undefined || song.is_public === undefined) {
            return true;
        }

        return false;
    }

    async function refreshVisibleSongsMetadata(songIds, options = {}) {
        const { forceRefresh = false } = options;
        if (!Array.isArray(songIds) || songIds.length === 0) return;
        if (Date.now() < metadataRefreshBlockedUntil) return;

        const normalizedIds = songIds
            .filter(id => typeof id === 'string' && id.trim())
            .map(id => id.trim());

        normalizedIds.forEach(id => pendingMetadataRefreshIds.add(id));

        if (metadataRefreshInFlight) {
            return;
        }

        while (pendingMetadataRefreshIds.size > 0) {
            const idsToCheck = Array.from(pendingMetadataRefreshIds);
            pendingMetadataRefreshIds.clear();

            const idsToRefresh = idsToCheck
                .map(id => getActiveSongs().find(song => song.id === id) || allSongs.find(song => song.id === id))
                .filter(Boolean)
                .filter(song => forceRefresh || shouldRefreshMetadataForSong(song))
                .map(song => song.id);

            if (idsToRefresh.length === 0) {
                continue;
            }

            metadataRefreshInFlight = true;
            try {
                const response = await sendMessageWithRetry({ action: 'fetch_songs_by_ids', songIds: idsToRefresh });
                if (!response?.ok) {
                    if (response?.status === 429) {
                        metadataRefreshBlockedUntil = Date.now() + METADATA_REFRESH_ERROR_BACKOFF_MS;
                    }
                    continue;
                }

                if (!response?.data?.clips || !Array.isArray(response.data.clips)) {
                    continue;
                }

                const refreshedAt = Date.now();
                idsToRefresh.forEach(id => metadataRefreshTimestamps.set(id, refreshedAt));

                const updatedSongs = response.data.clips
                    .map(normalizeSongClip)
                    .filter(song => song.id);

                if (updatedSongs.length > 0) {
                    mergeSongs(updatedSongs);
                }
            } catch (e) {
                console.debug('[Downloader] metadata refresh by visible items failed:', e);
            } finally {
                metadataRefreshInFlight = false;
            }
        }
    }

    async function clearStorage() {
        try {
            await deletePreferenceFromIDB('sunoSongsList');
            await clearPlaylistCache();
        } catch (e) {}
    }

    async function cacheAllSongs() {
        const activeSongs = getActiveSongs();
        if (activeSongs.length === 0) {
            statusDiv.innerText = "No songs to cache. Fetch your song list first.";
            return;
        }

        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const selectedSongs = activeSongs.filter(s => selectedIds.includes(s.id));
        const songsToCache = selectedSongs.filter(s => s.audio_url && !cachedSongIds.has(s.id));
        if (songsToCache.length === 0) {
            statusDiv.innerText = `All ${selectedSongs.length} selected song(s) are already in the browser database.`;
            return;
        }

        stopCachingRequested = false;
        setCachingUiState(true);

        let cached = 0;
        let failed = 0;
        const total = songsToCache.length;

        for (const song of songsToCache) {
            if (stopCachingRequested) {
                statusDiv.innerText = `⏹️ Save to DB stopped. ${cached} song(s) saved.`;
                break;
            }

            statusDiv.innerText = `💾 Saving to DB ${cached + failed + 1}/${total}: ${song.title || 'Untitled'}...`;

            try {
                const desiredFormat = getSelectedFormat();
                const audioUrl = getAudioUrlForFormat(song, desiredFormat) || song.audio_url;
                const response = await fetch(audioUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                await saveAudioBlobToIDB(song.id, blob);

                // Also cache a small thumbnail (64px wide via CDN query param)
                const rawImageUrl = song.image_url || song.thumbnail_url || song.cover_image_url || song.artwork_url || null;
                if (rawImageUrl) {
                    try {
                        const thumbUrl = rawImageUrl.split('?')[0] + '?width=64';
                        const imgResponse = await fetch(thumbUrl);
                        if (imgResponse.ok) {
                            const imgBlob = await imgResponse.blob();
                            await saveImageBlobToIDB(song.id, imgBlob);
                            delete song.image_cache_bust;
                        }
                    } catch (imgErr) {
                        // thumbnail failure is non-fatal
                    }
                }

                cachedSongIds.add(song.id);
                songItemCache.delete(song.id); // force re-creation so cached thumbnail is shown
                cached++;
                void refreshDbUsageDisplay();
            } catch (e) {
                failed++;
                console.error(`[Downloader] Failed to cache "${song.title}":`, e);
            }
        }

        setCachingUiState(false);

        if (!stopCachingRequested) {
            const totalCached = cachedSongIds.size;
            statusDiv.innerText = `✅ Save to DB complete! ${cached} new, ${totalCached} total in browser database. ${failed > 0 ? `${failed} failed.` : ''}`.trim();
        }

        renderSongList({
            preserveScroll: true,
            minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
        });
        void refreshDbUsageDisplay();
    }

    async function deleteSelectedCachedSongs() {
        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const cachedSelectedIds = selectedIds.filter(id => cachedSongIds.has(id));
        if (cachedSelectedIds.length === 0) {
            statusDiv.innerText = "None of the selected songs are stored in the browser database.";
            return;
        }

        const proceed = confirm(`Delete ${cachedSelectedIds.length} selected song(s) from the browser database?`);
        if (!proceed) {
            statusDiv.innerText = "Database delete cancelled.";
            return;
        }

        if (deleteCachedBtn) {
            deleteCachedBtn.disabled = true;
        }

        let deleted = 0;
        let failed = 0;

        try {
            for (const songId of cachedSelectedIds) {
                try {
                    await deleteAudioBlobFromIDB(songId);
                    await deleteImageBlobFromIDB(songId);
                    cachedSongIds.delete(songId);
                    songItemCache.delete(songId); // force re-creation without cached state
                    deleted++;
                    void refreshDbUsageDisplay();
                } catch (e) {
                    failed++;
                }
            }

            const message = `🗑 Removed ${deleted} song(s) from the browser database.${failed > 0 ? ` ${failed} failed.` : ''}`;
            statusDiv.innerText = message;
            renderSongList({
                preserveScroll: true,
                minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
            });
        } finally {
            if (deleteCachedBtn) {
                deleteCachedBtn.disabled = false;
            }
        }
    }

    // Filter input
    filterInput.addEventListener("input", () => {
        applyFilter();
    });

    // Filter checkboxes
    filterLiked.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterStems.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterPublic.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    if (filterOffline) {
        filterOffline.addEventListener("change", () => {
            applyFilter();
            saveFilterPreferences();
        });
    }

    if (syncNewBtn) {
        syncNewBtn.addEventListener("click", () => {
            if (currentFetchMode !== 'idle') {
                stopCurrentFetch();
            } else {
                startIncrementalSync({ automatic: false, refreshMetadata: true });
            }
        });
    }

    // ========================================================================
    // Playlist loading and selection
    // ========================================================================

    async function loadPlaylists() {
        if (!playlistFilter) return;
        try {
            const currentValue = playlistFilter.value;
            const savedSelection = await loadPreferenceFromIDB(SELECTED_PLAYLIST_KEY);
            const preferredValue = currentValue || savedSelection || '';

            const cachedPlaylists = await loadPreferenceFromIDB(PLAYLISTS_KEY);
            if (Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0) {
                renderPlaylistOptions(cachedPlaylists, preferredValue);
            }

            // Fetch all pages (1-based pagination)
            const allPlaylists = [];
            let page = 1;
            while (true) {
                let response;
                try {
                    response = await sendMessageWithRetry({ action: 'fetch_user_playlists', page });
                } catch (e) {
                    const reason = e?.message || String(e);
                    statusDiv.innerText = Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0
                        ? `Loaded cached playlists. Refresh failed: ${reason}`
                        : `Playlist load failed: ${reason}`;
                    return;
                }
                if (!response?.ok || !response.data) {
                    const reason = response?.error || `HTTP ${response?.status || 'unknown'}`;
                    statusDiv.innerText = Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0
                        ? `Loaded cached playlists. Refresh failed: ${reason}`
                        : `Playlist load failed: ${reason}`;
                    return;
                }
                const data = response.data;
                const batch = extractPlaylistItems(data);
                if (!Array.isArray(batch) || batch.length === 0) break;
                allPlaylists.push(...batch);
                // Stop if we have fetched all
                const total = extractPlaylistTotal(data, allPlaylists.length);
                if (allPlaylists.length >= total) break;
                page++;
            }

            if (allPlaylists.length === 0) {
                statusDiv.innerText = Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0
                    ? `Loaded ${cachedPlaylists.length} cached playlist(s).`
                    : 'No playlists returned by Suno.';
                return;
            }

            // Sort alphabetically by name
            const normalizedPlaylists = allPlaylists.map(normalizePlaylistMetadata);
            const cachedExternalPlaylists = Array.isArray(cachedPlaylists)
                ? cachedPlaylists.filter(isPlaylistOtherArtist)
                : [];
            const mergedPlaylists = mergePlaylistsById(normalizedPlaylists, cachedExternalPlaylists);
            renderPlaylistOptions(mergedPlaylists, preferredValue);
            await savePreferenceToIDB(PLAYLISTS_KEY, mergedPlaylists);

            const externalCount = mergedPlaylists.filter(isPlaylistOtherArtist).length;
            statusDiv.innerText = externalCount > 0
                ? `Loaded ${normalizedPlaylists.length} own playlist(s) and kept ${externalCount} other artist playlist(s).`
                : `Loaded ${normalizedPlaylists.length} playlist(s).`;
        } catch (e) {
            statusDiv.innerText = `Playlist load failed: ${e?.message || String(e)}`;
            console.debug('[Downloader] Failed to load playlists:', e);
        }
    }

    async function selectPlaylist(playlistId) {
        const selectedPlaylistId = normalizePlaylistId(playlistId);
        const wasPlaylistMode = Array.isArray(playlistSongs);
        playlistSongs = null;
        await savePreferenceToIDB(SELECTED_PLAYLIST_KEY, selectedPlaylistId || '');

        if (selectedPlaylistId) {
            statusDiv.innerText = 'Loading playlist songs...';
            playlistSongs = [];
            const cachedSongs = await loadPreferenceFromIDB(getPlaylistSongsCacheKey(selectedPlaylistId));
            if (Array.isArray(cachedSongs) && cachedSongs.length > 0) {
                playlistSongs = cachedSongs;
                applyFilter();
                statusDiv.innerText = `Loaded ${cachedSongs.length} cached playlist song(s). Refreshing...`;
            } else {
                // No cached songs: render empty playlist immediately while we fetch.
                applyFilter();
            }

            const playlistClipMap = new Map();
            const discoveredSongIds = new Set();
            let page = 1;
            let lastDiagnostics = null;
            while (true) {
                try {
                    let response;
                    try {
                        response = await sendMessageWithRetry({
                            action: 'fetch_playlist_songs',
                            playlistId: selectedPlaylistId,
                            page
                        });
                    } catch (e) {
                        console.debug('[Downloader] Failed to fetch playlist songs page', page, e);
                        const reason = e?.message || String(e);
                        statusDiv.innerText = `Playlist load failed: ${reason}`;
                        break;
                    }
                    console.debug('[Downloader] Playlist API response:', { playlistId: selectedPlaylistId, page, response });
                    if (response?.diagnostics) lastDiagnostics = response.diagnostics;
                    if (!response?.ok || !response.data) {
                        const errorMsg = response?.error || response?.status || 'unknown error';
                        const diagSummary = lastDiagnostics
                            ? lastDiagnostics.map(d => `${d.source}:${d.status}(${d.clipCount})`).join(', ')
                            : '';
                        console.debug('[Downloader] Playlist load failed:', errorMsg, diagSummary);
                        statusDiv.innerText = `Playlist load failed: ${errorMsg}` + (diagSummary ? ` [${diagSummary}]` : '');
                        break;
                    }
                    const data = response.data;
                    let clips = extractPlaylistClipItems(data);
                    clips = clips.map(item => {
                        if (typeof item === 'string' && item.trim()) {
                            return { song_id: item.trim() };
                        }
                        if (typeof item === 'number') {
                            return { song_id: String(item) };
                        }
                        return item;
                    });
                    console.debug('[Downloader] Extracted clips:', { clipsCount: clips.length, sample: clips[0], dataKeys: data ? Object.keys(data) : null });
                    for (const c of clips) {
                        const rawSongId = extractSongIdFromClipItem(c);
                        if (rawSongId) {
                            discoveredSongIds.add(rawSongId);
                        }
                        const song = normalizeSongClip(c);
                        if (song.id) {
                            playlistClipMap.set(song.id, song);
                        }
                    }
                    const total = extractPlaylistTotal(data, playlistClipMap.size);
                    if (!clips.length || playlistClipMap.size >= total) break;
                    page++;
                } catch (e) {
                    console.debug('[Downloader] Failed to fetch playlist songs page', page, e);
                    break;
                }
            }

            const missingSongIds = Array.from(discoveredSongIds).filter(songId => {
                const existingSong = playlistClipMap.get(songId);
                return !existingSong || !existingSong.audio_url;
            });

            if (missingSongIds.length > 0) {
                const hydratedSongs = await hydratePlaylistSongsById(missingSongIds);
                hydratedSongs.forEach(song => {
                    const existingSong = playlistClipMap.get(song.id);
                    playlistClipMap.set(song.id, existingSong ? mergeSongMetadata(existingSong, song) : song);
                });
            }

            const fetchedPlaylistSongs = Array.from(playlistClipMap.values());
            if (fetchedPlaylistSongs.length > 0) {
                playlistSongs = fetchedPlaylistSongs;
                await savePreferenceToIDB(getPlaylistSongsCacheKey(selectedPlaylistId), playlistSongs);
                statusDiv.innerText = `Playlist: loaded ${playlistSongs.length} song(s).`;
            } else if (Array.isArray(cachedSongs) && cachedSongs.length > 0) {
                statusDiv.innerText = `Playlist API returned no songs; showing ${cachedSongs.length} cached song(s).`;
            } else {
                playlistSongs = [];
                const diagSummary = lastDiagnostics
                    ? lastDiagnostics.map(d => `${d.source}:${d.status}(${d.clipCount})`).join(', ')
                    : '';
                statusDiv.innerText = 'Playlist returned no songs.' + (diagSummary ? ` [${diagSummary}]` : '');
            }

            applyFilter();
        } else {
            statusDiv.innerText = 'Showing all songs.';
            if (libraryNeedsMetadataRefresh(allSongs)) {
                statusDiv.innerText = 'Refreshing all songs metadata...';
                setTimeout(() => startFullRefresh({ confirmUser: false }), 100);
            }
        }

        const nowPlaylistMode = Array.isArray(playlistSongs);
        if (wasPlaylistMode !== nowPlaylistMode) {
            songItemCache.clear();
        }

        applyFilter();
    }

    if (playlistFilter) {
        playlistFilter.addEventListener('change', () => {
            void selectPlaylist(playlistFilter.value);
        });
    }

    // ========================================================================
    // Playlist search (other users' playlists)
    // ========================================================================

    const playlistSearchInput = document.getElementById('playlistSearchInput');
    const playlistSearchBtn = document.getElementById('playlistSearchBtn');
    const playlistSearchResults = document.getElementById('playlistSearchResults');

    function renderPlaylistSearchResults(playlists) {
        if (!playlistSearchResults) return;
        playlistSearchResults.innerHTML = '';
        if (!playlists || playlists.length === 0) {
            playlistSearchResults.style.display = 'block';
            const empty = document.createElement('div');
            empty.className = 'playlist-search-empty';
            empty.textContent = 'No playlists found.';
            playlistSearchResults.appendChild(empty);
            return;
        }
        playlists.forEach(pl => {
            const norm = normalizePlaylistMetadata(pl);
            const item = document.createElement('div');
            item.className = 'playlist-search-item';
            item.title = `Load playlist: ${norm.name}`;

            if (norm.image_url) {
                const img = document.createElement('img');
                img.src = norm.image_url;
                img.className = 'playlist-search-thumb';
                img.alt = '';
                item.appendChild(img);
            }

            const info = document.createElement('div');
            info.className = 'playlist-search-info';

            const nameEl = document.createElement('span');
            nameEl.className = 'playlist-search-name';
            nameEl.textContent = norm.name;
            info.appendChild(nameEl);

            if (norm.song_count != null) {
                const countEl = document.createElement('span');
                countEl.className = 'playlist-search-count';
                countEl.textContent = `${norm.song_count} songs`;
                info.appendChild(countEl);
            }

            item.appendChild(info);
            item.addEventListener('click', () => {
                playlistSearchResults.style.display = 'none';
                if (playlistSearchInput) playlistSearchInput.value = '';
                void selectPlaylist(norm.id);
            });
            playlistSearchResults.appendChild(item);
        });
        playlistSearchResults.style.display = 'block';
    }

    async function runPlaylistSearch() {
        if (!playlistSearchInput) return;
        const input = playlistSearchInput.value.trim();
        if (!input) {
            if (playlistSearchResults) playlistSearchResults.style.display = 'none';
            return;
        }

        // Extract a UUID from a suno.com/playlist/UUID URL, or use input as-is
        let playlistId = input;
        const urlMatch = input.match(/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
            || input.match(/playlist\/([0-9a-f-]{30,36})/i);
        if (urlMatch) {
            playlistId = urlMatch[1];
        }
        // Accept only UUID-shaped IDs (with or without hyphens)
        if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(playlistId)) {
            if (playlistSearchResults) {
                playlistSearchResults.innerHTML = '';
                const msg = document.createElement('div');
                msg.className = 'playlist-search-empty';
                msg.textContent = 'Paste a suno.com/playlist/… URL or a playlist UUID.';
                playlistSearchResults.appendChild(msg);
                playlistSearchResults.style.display = 'block';
            }
            return;
        }

        if (playlistSearchBtn) {
            playlistSearchBtn.disabled = true;
            playlistSearchBtn.textContent = '…';
        }
        try {
            const response = await sendMessageWithRetry({ action: 'fetch_playlist_info', playlistId });
            if (response?.ok && response.playlist) {
                await savePlaylistToDropdown(response.playlist, response.playlist.id);
                renderPlaylistSearchResults([response.playlist]);
            } else {
                renderPlaylistSearchResults([]);
            }
        } catch (e) {
            statusDiv.innerText = `Playlist lookup error: ${e?.message || String(e)}`;
            if (playlistSearchResults) playlistSearchResults.style.display = 'none';
        } finally {
            if (playlistSearchBtn) {
                playlistSearchBtn.disabled = false;
                playlistSearchBtn.textContent = 'Load';
            }
        }
    }

    if (playlistSearchBtn) {
        playlistSearchBtn.addEventListener('click', () => void runPlaylistSearch());
    }
    if (playlistSearchInput) {
        playlistSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void runPlaylistSearch();
            if (e.key === 'Escape') {
                playlistSearchResults.style.display = 'none';
                playlistSearchInput.value = '';
            }
        });
    }

    if (refreshPlaylistsBtn) {
        refreshPlaylistsBtn.addEventListener('click', () => {
            void loadPlaylists();
        });
    }

    document.addEventListener('bettersuno:refresh-library', () => {
        startFullRefresh({ confirmUser: true });
    });

    document.addEventListener('bettersuno:settings-opened', () => {
        void refreshDbUsageDisplay();
    });

    document.addEventListener('bettersuno:delete-library', async () => {
        try {
            await clearStorage();
            // Also wipe the audio and image caches
            try {
                const db = await getDB();
                await new Promise((res, rej) => {
                    const tx = db.transaction(['audioCache', 'imageCache'], 'readwrite');
                    tx.objectStore('audioCache').clear();
                    tx.objectStore('imageCache').clear();
                    tx.oncomplete = res;
                    tx.onerror = () => rej(tx.error);
                });
            } catch (e) { /* non-fatal */ }
            allSongs = [];
            playlistSongs = null;
            selectedSongIds.clear();
            cachedSongIds.clear();
            songItemCache.clear();
            if (playlistFilter) {
                playlistFilter.value = '';
                while (playlistFilter.options.length > 1) {
                    playlistFilter.remove(1);
                }
            }
            renderSongList({ preserveScroll: false });
            statusDiv.innerText = "✅ Library deleted successfully.";
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('[Downloader] Failed to delete library:', e);
            statusDiv.innerText = "❌ Failed to delete library.";
        }
    });

    // Select/Clear all toggle button
    selectAllButton.addEventListener("click", () => {
        const shouldSelectAll = selectAllButton.getAttribute('aria-pressed') !== 'true';
        filteredSongs.forEach(song => {
            if (shouldSelectAll) {
                selectedSongIds.add(song.id);
            } else {
                selectedSongIds.delete(song.id);
            }
        });
        refreshVisibleSongSelectionState();
        updateSelectedCount();
    });

    // Download selected songs
    downloadBtn.addEventListener("click", () => {
        const activeSongs = getActiveSongs();
        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const downloadOptions = getDownloadOptions();
        if (!downloadOptions.music && !downloadOptions.lyrics && !downloadOptions.image) {
            statusDiv.innerText = "Please select at least one download type: music, lyrics, or image.";
            return;
        }

        const folder = folderInput.value;
        const format = getSelectedFormat();
        const songsToDownload = activeSongs.filter(s => selectedIds.includes(s.id));
        const { downloadable, blocked } = splitSongsByDownloadEligibility(songsToDownload);

        if (downloadable.length === 0) {
            statusDiv.innerText = "Only your own songs can be downloaded as files. Songs by other artists may only be saved to the local database.";
            return;
        }

        setDownloadUiState(true);

        try {
            api.runtime.sendMessage({
                action: "download_selected",
                folderName: folder,
                format: format,
                songs: downloadable,
                downloadOptions: downloadOptions
            });
        } catch (e) {
            console.debug('[Downloader] Could not send download request:', e.message);
        }

        const selectedTypes = [];
        if (downloadOptions.music) selectedTypes.push(format.toUpperCase());
        if (downloadOptions.lyrics) selectedTypes.push("lyrics");
        if (downloadOptions.image) selectedTypes.push("images");
        statusDiv.innerText = blocked.length > 0
            ? `Downloading ${downloadable.length} own song(s): ${selectedTypes.join(", ")}. Skipped ${blocked.length} song(s) by other artists.`
            : `Downloading ${downloadable.length} song(s): ${selectedTypes.join(", ")}...`;
    });

    // Stop downloading
    stopDownloadBtn.addEventListener("click", () => {
        try {
            api.runtime.sendMessage({ action: "stop_download" });
        } catch (e) {
            console.debug('[Downloader] Could not send stop download request:', e.message);
        }
        statusDiv.innerText = "Stopping download...\n" + statusDiv.innerText;
        // Keep UI in running state until background confirms stop/complete
    });

    // Cache all songs to browser database
    if (cacheAllBtn) {
        cacheAllBtn.addEventListener("click", () => {
            cacheAllSongs();
        });
    }

    if (deleteCachedBtn) {
        deleteCachedBtn.addEventListener("click", () => {
            deleteSelectedCachedSongs();
        });
    }

    // Stop caching
    if (stopCacheBtn) {
        stopCacheBtn.addEventListener("click", () => {
            stopCachingRequested = true;
            stopCacheBtn.disabled = true;
        });
    }

    // Listen for messages from background
    api.runtime.onMessage.addListener((message) => {
        if (message.action === "log") {
            statusDiv.innerText = message.text + "\n" + statusDiv.innerText;
        }

        if (message.action === "fetch_started") {
            // background informs us fetching has started (manual or auto)
            setFetchUiState(true);
            statusDiv.innerText = currentFetchMode === 'incremental' ? "Refreshing songs and metadata..." : "Fetching songs...";
        }
        if (message.action === "songs_page_update") {
            // start or continue fetching, ensure UI shows stop button
            setFetchUiState(true);

            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;

            // Always merge fetched data into existing song list, never replace list mid-load
            const { addedCount, metadataUpdateCount } = mergeSongs(newSongs);

            if (currentFetchMode === 'incremental' || wasCheckingNew) {
                statusDiv.innerText = currentMetadataRefreshRequested
                    ? `Page ${message.pageNum}: scanned ${message.totalSongs} song(s)...`
                    : `Page ${message.pageNum}: ${message.totalSongs} new song(s) found...`;
            } else {
                statusDiv.innerText = `Page ${message.pageNum}: ${allSongs.length} songs (added ${addedCount}, updated ${metadataUpdateCount}).`;
            }
        }

        if (message.action === "download_state") {
            setDownloadUiState(!!message.isDownloading);
        }

        if (message.action === "download_stopped") {
            setDownloadUiState(false);
        }

        if (message.action === "songs_fetched") {
            setFetchUiState(false);
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;
            const completedAt = Date.now();

            if (wasCheckingNew) {
                // Merge with existing songs
                const { addedCount, metadataUpdateCount } = mergeSongs(newSongs);
                void saveSyncMeta({
                    lastSyncAt: completedAt,
                    lastIncrementalSyncAt: completedAt,
                    lastSyncMode: 'incremental',
                    lastAddedCount: addedCount,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                if (currentMetadataRefreshRequested) {
                    if (addedCount > 0 || metadataUpdateCount > 0) {
                        statusDiv.innerText = `Updated ${metadataUpdateCount} existing song(s)${addedCount > 0 ? ` and found ${addedCount} new song(s)` : ''}. Total: ${allSongs.length}`;
                    } else {
                        statusDiv.innerText = `${allSongs.length} songs already up to date.`;
                    }
                } else if (addedCount > 0) {
                    statusDiv.innerText = `Found ${addedCount} new song(s). Total: ${allSongs.length}`;
                } else {
                    statusDiv.innerText = `${allSongs.length} songs (no new songs found).`;
                }
            } else {
                // Fresh fetch complete: merge new data into existing library rather than replacing.
                const preMergeCount = allSongs.length;
                const { addedCount, metadataUpdateCount } = mergeSongs(newSongs);

                if (!sunoUserId) {
                    initSunoUserId();
                }

                // Only show song list if not already visible (page updates already showed it)
                if (songListContainer.style.display !== "block") {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        applyFilter();
                    });
                } else {
                    // Just update the final list
                    applyFilter({
                        preserveScroll: true,
                        minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
                    });
                }
                saveToStorage();
                void saveSyncMeta({
                    lastSyncAt: completedAt,
                    lastFullSyncAt: completedAt,
                    lastSyncMode: 'full',
                    lastAddedCount: addedCount,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                const updatedPart = metadataUpdateCount > 0 ? `Updated ${metadataUpdateCount} existing song(s), ` : '';
                statusDiv.innerText = `✅ Complete! ${updatedPart}Added ${addedCount} new song(s). Total: ${allSongs.length} (was ${preMergeCount}).`;
            }
            currentFetchMode = 'idle';
            currentMetadataRefreshRequested = false;
        }
        if (message.action === "fetch_stopped") {
            setFetchUiState(false);
            void saveSyncMeta({
                syncStatus: 'stopped',
                lastSyncMode: currentFetchMode === 'idle' ? syncMeta.lastSyncMode : currentFetchMode
            });
            statusDiv.innerText = "⏹️ Fetch stopped by user – song list may be incomplete.";
            currentFetchMode = 'idle';
            currentMetadataRefreshRequested = false;
        }
        if (message.action === "fetch_error") {
            setFetchUiState(false);
            void saveSyncMeta({
                syncStatus: 'error',
                lastError: message.error || 'Unknown error',
                lastSyncMode: currentFetchMode === 'idle' ? syncMeta.lastSyncMode : currentFetchMode
            });
            statusDiv.innerText = message.error;
            currentFetchMode = 'idle';
            currentMetadataRefreshRequested = false;
        }

        if (message.action === "download_complete") {
            setDownloadUiState(false);
            if (typeof message.text === 'string' && message.text.trim()) {
                statusDiv.innerText = message.text;
            } else if (message.stopped) {
                statusDiv.innerText = "⏹️ Download stopped by user.";
            } else if (message.ok === false) {
                statusDiv.innerText = "❌ Download failed.";
            } else {
                statusDiv.innerText = "✅ Download complete!";
            }
        }
    });

    function ensureSongListObserver() {
        if (songListObserver || !songList) {
            return;
        }

        songListObserver = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                renderSongListChunk();
            }
        }, {
            root: songList,
            rootMargin: '0px 0px 160px 0px'
        });
    }

    function updateSongListSentinelState() {
        if (!songListSentinel) {
            return;
        }

        const remaining = Math.max(sortedFilteredSongs.length - renderedSongCount, 0);
        songListSentinel.classList.toggle('is-complete', remaining === 0);
        songListSentinel.textContent = remaining > 0
            ? `Scroll to load ${Math.min(remaining, SONG_RENDER_BATCH_SIZE)} more songs`
            : (sortedFilteredSongs.length > 0 ? 'All my songs loaded' : '');
    }

    function updateSongLikeState(songId, liked) {
        const allSongsArray = [allSongs, playlistSongs || []];
        let changed = false;

        allSongsArray.forEach(songArr => {
            if (!Array.isArray(songArr)) return;
            songArr.forEach(song => {
                if (song.id !== songId) return;

                const currentlyLiked = !!song.is_liked;
                if (currentlyLiked === liked) return;

                song.is_liked = liked;
                if (!Number.isFinite(song.upvote_count)) {
                    song.upvote_count = 0;
                }

                if (liked) {
                    song.upvote_count = (song.upvote_count || 0) + 1;
                } else {
                    song.upvote_count = Math.max(0, (song.upvote_count || 1) - 1);
                }

                changed = true;
            });
        });

        if (changed) {
            songItemCache.delete(songId);
            void saveToStorage();
            applyFilter({ preserveScroll: true, minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE) });
        }
    }

    function sendSongReactionUpdate(songId, reaction) {
        api.runtime.sendMessage({ action: 'update_song_reaction', songId, reaction }, (response) => {
            if (chrome.runtime.lastError) {
                statusDiv.innerText = `Failed to update reaction: ${chrome.runtime.lastError.message}`;
                return;
            }
            if (!response || !response.ok) {
                const errorMessage = response?.error || `status=${response?.status || 'unknown'}`;
                statusDiv.innerText = `Failed to update reaction: ${errorMessage}`;
            }
        });
    }

    function ensureSongListSentinel() {
        ensureSongListObserver();

        if (!songListSentinel) {
            songListSentinel = document.createElement('div');
            songListSentinel.className = 'bettersuno-list-sentinel';
        }

        if (!songListSentinel.isConnected) {
            songList.appendChild(songListSentinel);
        }

        if (songListObserver) {
            songListObserver.disconnect();
            songListObserver.observe(songListSentinel);
        }

        updateSongListSentinelState();
    }

    function createSongListItem(song) {
        const item = document.createElement("div");
        item.className = "song-item";
        item.dataset.songId = song.id;
        item.dataset.thumbnailSignature = getSongThumbnailSignature(song);
        if (currentPlayingSongId === song.id) {
            item.classList.add('playing');
        }

        const thumbnailSource = getSongThumbnailSource(song);

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.id = song.id;
        checkbox.checked = selectedSongIds.has(song.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                selectedSongIds.add(song.id);
            } else {
                selectedSongIds.delete(song.id);
            }
            updateSelectedCount();
        });

        const thumbnail = document.createElement("div");
        thumbnail.className = "song-thumbnail";
        thumbnail.style.cursor = 'pointer';
        thumbnail.addEventListener('click', () => {
            togglePlay(song);
        });

        function attachThumbnail(src, type) {
            if (!src) return;
            
            thumbnail.classList.remove('is-fallback');
            thumbnail.textContent = '';
            thumbnail.innerHTML = '';

            if (type === 'video') {
                const videoEl = document.createElement('video');
                videoEl.className = 'song-thumbnail-image';
                videoEl.src = src;
                videoEl.autoplay = true;
                videoEl.loop = true;
                videoEl.muted = true;
                videoEl.playsInline = true;
                videoEl.preload = 'metadata';
                videoEl.style.display = 'block';
                videoEl.style.width = '100%';
                videoEl.style.height = '100%';
                videoEl.style.objectFit = 'cover';
                videoEl.addEventListener('error', () => {
                    videoEl.remove();
                    thumbnail.classList.add('is-fallback');
                    thumbnail.textContent = '♪';
                }, { once: true });
                videoEl.addEventListener('loadedmetadata', () => {
                    thumbnail.classList.remove('is-fallback');
                }, { once: true });
                thumbnail.appendChild(videoEl);
                return;
            }

            const thumbnailImage = document.createElement("img");
            thumbnailImage.className = "song-thumbnail-image";
            thumbnailImage.src = src;
            thumbnailImage.alt = song.title ? `${song.title} cover art` : 'Song cover art';
            thumbnailImage.loading = 'eager';
            thumbnailImage.decoding = 'async';
            thumbnailImage.style.display = 'block';
            thumbnailImage.style.width = '100%';
            thumbnailImage.style.height = '100%';
            thumbnailImage.addEventListener('load', () => {
                thumbnail.classList.remove('is-fallback');
                thumbnail.textContent = '';
                thumbnail.innerHTML = '';
                if (thumbnail.querySelector('img') !== thumbnailImage) {
                    thumbnail.innerHTML = '';
                    thumbnail.appendChild(thumbnailImage);
                }
            }, { once: true });
            thumbnailImage.addEventListener('error', () => {
                thumbnail.classList.add('is-fallback');
                thumbnail.innerHTML = '';
                thumbnail.textContent = '♪';
            }, { once: true });
            thumbnail.appendChild(thumbnailImage);
        }

        const isCachedSong = cachedSongIds.has(song.id) && !song.image_cache_bust;

        const attachSource = (source) => {
            if (!source || !source.url) {
                thumbnail.classList.add('is-fallback');
                thumbnail.textContent = '♪';
                return;
            }
            attachThumbnail(source.url, source.type);
        };

        if (isCachedSong) {
            getImageBlobFromIDB(song.id).then(imgBlob => {
                if (imgBlob) {
                    const objUrl = URL.createObjectURL(imgBlob);
                    attachThumbnail(objUrl, 'image');
                    thumbnail.querySelector('img')?.addEventListener('load', () => URL.revokeObjectURL(objUrl), { once: true });
                } else {
                    attachSource(thumbnailSource);
                }
            }).catch(() => {
                attachSource(thumbnailSource);
            });
        } else {
            attachSource(thumbnailSource);
        }

        const songInfo = document.createElement("div");
        songInfo.className = "song-info";
        songInfo.style.cursor = 'pointer';
        songInfo.addEventListener('click', () => {
            togglePlay(song);
        });

        const titleDiv = document.createElement("div");
        titleDiv.className = "song-title";
        titleDiv.title = song.title || 'Untitled';
        titleDiv.textContent = getSongDisplayTitle(song);

        const metaDiv = document.createElement("div");
        metaDiv.className = "song-meta";

        const visibilitySpan = document.createElement("span");
        visibilitySpan.className = song.is_public ? 'public' : 'private';
        visibilitySpan.textContent = song.is_public ? '🌐 Public' : '🔒 Private';
        metaDiv.appendChild(visibilitySpan);

        if (song.is_liked) {
            const likedSpan = document.createElement("span");
            likedSpan.textContent = ' • ❤️ Liked';
            likedSpan.style.color = '#e91e63';
            metaDiv.appendChild(likedSpan);
        }

        if (song.upvote_count > 0) {
            const likesSpan = document.createElement("span");
            likesSpan.textContent = ` • 👍 ${song.upvote_count.toLocaleString()}`;
            likesSpan.title = `${song.upvote_count.toLocaleString()} likes`;
            metaDiv.appendChild(likesSpan);
        }

        if (song.is_stem) {
            const stemSpan = document.createElement("span");
            stemSpan.textContent = ' • 🎹 Stem';
            stemSpan.style.color = '#9c27b0';
            metaDiv.appendChild(stemSpan);
        }

        if (song.created_at) {
            metaDiv.appendChild(document.createTextNode(' • ' + formatDate(song.created_at)));
        }

        if (shouldShowOtherArtistBadge(song)) {
            const ownershipSpan = document.createElement('span');
            const artistName = song.owner_display_name || song.owner_handle || 'Other artist';
            ownershipSpan.textContent = ` • 👤 ${artistName}`;
            ownershipSpan.title = 'Only your own songs can be downloaded as files';
            ownershipSpan.style.color = '#7ae';
            metaDiv.appendChild(ownershipSpan);
        }

        if (cachedSongIds.has(song.id)) {
            const cachedSpan = document.createElement("span");
            cachedSpan.textContent = ' • 💾 Cached';
            cachedSpan.title = 'Audio stored in browser database';
            cachedSpan.style.color = '#4caf50';
            metaDiv.appendChild(cachedSpan);
        }

        songInfo.appendChild(titleDiv);
        songInfo.appendChild(metaDiv);

        const actionsDiv = document.createElement("div");
        actionsDiv.className = "song-actions";

        const likeBtn = document.createElement("button");
        likeBtn.className = "song-action-btn like-btn";
        likeBtn.textContent = song.is_liked ? '❤️' : '🤍';
        likeBtn.title = song.is_liked ? 'Unlike this song' : 'Like this song';
        likeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetValue = !song.is_liked;
            updateSongLikeState(song.id, targetValue);
            sendSongReactionUpdate(song.id, targetValue ? 'LIKE' : 'DISLIKE');
        });

        let dislikeBtn;
        if (!Array.isArray(playlistSongs)) {
            dislikeBtn = document.createElement("button");
            dislikeBtn.className = "song-action-btn dislike-btn";
            dislikeBtn.textContent = '👎';
            dislikeBtn.title = 'Dislike (remove like)';
            dislikeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                updateSongLikeState(song.id, false);
                sendSongReactionUpdate(song.id, 'DISLIKE');
            });
        }

        const copyLinkBtn = document.createElement("button");
        copyLinkBtn.className = "song-action-btn copy-link-btn";
        copyLinkBtn.textContent = '🔗';
        copyLinkBtn.title = 'Copy song link';
        copyLinkBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songLink = `https://suno.com/song/${song.id}`;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(songLink);
                } else {
                    const tempInput = document.createElement('textarea');
                    tempInput.value = songLink;
                    tempInput.style.position = 'fixed';
                    tempInput.style.left = '-9999px';
                    document.body.appendChild(tempInput);
                    tempInput.focus();
                    tempInput.select();
                    document.execCommand('copy');
                    document.body.removeChild(tempInput);
                }
                statusDiv.innerText = 'Copied song link to clipboard.';
            } catch (err) {
                console.debug('[Downloader] Copy link failed', err);
                statusDiv.innerText = 'Failed to copy song link.';
            }
        });

        let renameBtn;
        if (!isSongFromOtherArtist(song)) {
            renameBtn = document.createElement("button");
            renameBtn.className = "song-action-btn rename-btn";
            renameBtn.textContent = '✏️';
            renameBtn.title = 'Rename this song';
            renameBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const oldTitle = getSongDisplayTitle(song);
                const userTitle = prompt('Enter a new name for your song:', oldTitle);
                if (userTitle === null) return;
                const newTitle = userTitle.trim();
                if (!newTitle) {
                    statusDiv.innerText = 'Song title cannot be empty.';
                    return;
                }
                if (newTitle === oldTitle) {
                    return;
                }

                statusDiv.innerText = 'Updating title on Suno...';
                try {
                    const response = await api.runtime.sendMessage({
                        action: 'set_song_metadata',
                        songId: song.id,
                        title: newTitle
                    });

                    if (!response || !response.ok) {
                        statusDiv.innerText = `Failed to update title on Suno: ${response?.error || 'unknown'}`;
                        return;
                    }

                    applyCustomSongTitle(song.id, newTitle);
                    statusDiv.innerText = `Renamed song to "${newTitle}".`;
                } catch (err) {
                    console.debug('[Downloader] set_song_metadata failed', err);
                    statusDiv.innerText = `Failed to update title on Suno.`;
                }
            });
        }

        const gotoBtn = document.createElement("button");
        gotoBtn.className = "song-action-btn goto-btn";
        gotoBtn.title = "Go to Song";
        gotoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5c-7.633 0-12 7-12 7s4.367 7 12 7 12-7 12-7-4.367-7-12-7zm0 12a5 5 0 1 1 .001-10.001A5 5 0 0 1 12 17zm0-8a3 3 0 1 0 .001 6.001A3 3 0 0 0 12 9z"/></svg>`;
        gotoBtn.onclick = (e) => {
            e.stopPropagation();
            const panel = document.getElementById('bettersuno-panel');
            if (panel) {
                panel.classList.remove('open');
            }
            window.location.assign(`https://suno.com/song/${song.id}`);
        };

        actionsDiv.appendChild(likeBtn);
        actionsDiv.appendChild(copyLinkBtn);
        if (renameBtn) {
            actionsDiv.appendChild(renameBtn);
        }
        if (dislikeBtn) {
            actionsDiv.appendChild(dislikeBtn);
        }
        actionsDiv.appendChild(gotoBtn);

        item.appendChild(checkbox);
        item.appendChild(thumbnail);
        item.appendChild(songInfo);
        item.appendChild(actionsDiv);

        return item;
    }

    function renderSongListChunk(count = SONG_RENDER_BATCH_SIZE) {
        if (!sortedFilteredSongs.length) {
            updateSelectedCount();
            return;
        }

        ensureSongListSentinel();

        const start = renderedSongCount;
        const end = Math.min(start + count, sortedFilteredSongs.length);
        if (start >= end) {
            updateSongListSentinelState();
            return;
        }

        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const song = sortedFilteredSongs[index];
            let item = songItemCache.get(song.id);
            if (!item) {
                item = createSongListItem(song);
                songItemCache.set(song.id, item);
            }
            fragment.appendChild(item);
        }

        songList.insertBefore(fragment, songListSentinel);
        renderedSongCount = end;
        updateSongListSentinelState();
        updateSelectedCount();

    }

    function refreshVisibleSongSelectionState() {
        songList.querySelectorAll('input[type="checkbox"][data-id]').forEach(checkbox => {
            checkbox.checked = selectedSongIds.has(checkbox.dataset.id);
        });
    }

    function refreshVisibleSongPlaybackState() {
        const isPaused = !audioElement || audioElement.paused;
        songList.querySelectorAll('.song-item[data-song-id]').forEach(item => {
            const isCurrent = item.dataset.songId === currentPlayingSongId;
            item.classList.toggle('playing', isCurrent);
            const playBtn = item.querySelector('.play-btn');
            if (playBtn) {
                playBtn.textContent = (isCurrent && !isPaused) ? '⏸' : '▶';
            }
        });

        // Sync player tab play/pause button
        if (playerTabPlayPause) {
            playerTabPlayPause.textContent = (!isPaused && currentPlayingSongId) ? '⏸' : '▶';
        }
        // Sync mini-player play/pause button
        if (playPauseBtn) {
            playPauseBtn.textContent = (!isPaused && currentPlayingSongId) ? '■' : '▶';
        }
    }

    function applyFilter(options = {}) {
        const { preserveScroll = false, minimumRenderCount = SONG_RENDER_BATCH_SIZE } = options;
        filteredSongs = filterSongs(getActiveSongs(), getSongFilterState());
        sortedFilteredSongs = sortSongsForDisplay(filteredSongs);

        renderSongList({ preserveScroll, minimumRenderCount });
    }

    function getSongFilterState() {
        return {
            searchText: filterInput.value.toLowerCase(),
            showLikedOnly: filterLiked.checked,
            showStemsOnly: filterStems.checked,
            showPublicOnly: filterPublic.checked,
            showOfflineOnly: !!filterOffline?.checked
        };
    }

    function matchesSongFilters(song, filterState) {
        if (filterState.searchText && !song.title.toLowerCase().includes(filterState.searchText)) {
            return false;
        }

        if (filterState.showLikedOnly && !song.is_liked) {
            return false;
        }

        if (filterState.showStemsOnly && !song.is_stem) {
            return false;
        }

        if (filterState.showPublicOnly && !song.is_public) {
            return false;
        }

        if (filterState.showOfflineOnly && !cachedSongIds.has(song.id)) {
            return false;
        }

        return true;
    }

    function filterSongs(songs, filterState) {
        return songs.filter(song => matchesSongFilters(song, filterState));
    }

    function sortSongsForDisplay(songs) {
        return [...songs].sort((a, b) => {
            const aTs = getSongTimestamp(a);
            const bTs = getSongTimestamp(b);
            if (bTs !== aTs) return bTs - aTs;
            return (a.title || '').localeCompare(b.title || '');
        });
    }

    function renderSongList(options = {}) {
        const { preserveScroll = false, minimumRenderCount = SONG_RENDER_BATCH_SIZE } = options;
        const previousScrollTop = preserveScroll ? songList.scrollTop : 0;

        songList.textContent = '';
        renderedSongCount = 0;

        if (!sortedFilteredSongs.length) {
            const activeSongs = getActiveSongs();
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'bettersuno-empty';
            if (filterOffline?.checked) {
                emptyDiv.textContent = cachedSongIds.size > 0
                    ? 'No offline songs match the current filters'
                    : 'No offline songs cached yet. Select songs and use Save to DB.';
            } else {
                emptyDiv.textContent = activeSongs.length > 0 ? 'No songs match the current filters' : 'No songs loaded yet';
            }
            songList.appendChild(emptyDiv);
            updateSelectedCount();
            return;
        }

        ensureSongListSentinel();

        while (renderedSongCount < Math.min(minimumRenderCount, sortedFilteredSongs.length)) {
            renderSongListChunk();
        }

        if (renderedSongCount > 0) {
            scheduleVisibleSongRefresh();
        }

        if (preserveScroll) {
            songList.scrollTop = previousScrollTop;
        } else {
            songList.scrollTop = 0;
        }

        updateSelectedCount();
    }

    function getSelectedSongIds() {
        const activeSongIds = new Set(getActiveSongs().map(song => song.id));
        return Array.from(selectedSongIds).filter(id => activeSongIds.has(id));
    }

    function getDownloadOptions() {
        return {
            music: !!downloadMusicCheckbox?.checked,
            lyrics: !!downloadLyricsCheckbox?.checked,
            image: !!downloadImageCheckbox?.checked
        };
    }

    function updateSelectedCount() {
        const total = filteredSongs.length;
        const selected = filteredSongs.filter(song => selectedSongIds.has(song.id)).length;
        songCount.textContent = `${selected}/${total} selected`;

        // Update select all button state
        const allChecked = total > 0 && filteredSongs.every(song => selectedSongIds.has(song.id));
        const isPressed = allChecked && total > 0;
        selectAllButton.setAttribute('aria-pressed', String(isPressed));
        selectAllButton.textContent = isPressed ? 'Clear All' : 'Select All';

        // Disable Download button if any selected song is from "Other artist"
        const activeSongs = getActiveSongs();
        const selectedSongs = activeSongs.filter(song => selectedSongIds.has(song.id));
        const fromOtherArtist = selectedSongs.some(song => isSongFromOtherArtist(song));
        if (downloadBtn) {
            downloadBtn.disabled = fromOtherArtist;
            if (fromOtherArtist) {
                downloadBtn.title = "Cannot download as files - Songs of other artists can only be saved to local database";
            } else {
                downloadBtn.title = "";
            }
        }
    }

    function formatDate(dateStr) {
        try {
            return new Date(dateStr).toLocaleDateString();
        } catch {
            return '';
        }
    }

    function getSongTimestamp(song) {
        const raw = song?.created_at || song?.createdAt || song?.timestamp;
        const ts = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(ts) ? ts : 0;
    }
})();
