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
    let currentFetchMode = 'idle';
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
        return {
            id: playlist?.id || '',
            name: playlist?.name || 'Unnamed Playlist',
            song_count: playlist?.song_count ?? playlist?.num_total_results ?? null,
            num_total_results: playlist?.num_total_results ?? null,
            is_public: playlist?.is_public,
            is_owned: playlist?.is_owned,
            image_url: playlist?.image_url || null,
            description: playlist?.description || ''
        };
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
            option.textContent = (pl.name || 'Unnamed Playlist') +
                (count != null ? ` (${count})` : '');
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

        const normalizeToken = (value) => {
            if (typeof value !== 'string') return null;
            return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
        };

        const STEM_TOKENS = new Set([
            'stem',
            'stems',
            'audio_stem',
            'audio_stems',
            'stem_split',
            'stem_separation',
            'stem_separated'
        ]);

        const explicitFlags = [
            clip.is_stem,
            clip.stem,
            clip.metadata?.is_stem,
            clip.metadata?.stem,
            clip.meta?.is_stem,
            clip.meta?.stem,
            clip.generation?.is_stem,
            clip.generation?.stem,
            clip.model?.is_stem,
            clip.model?.stem
        ];

        if (explicitFlags.some(flag => flag === true)) return true;

        const typeMarkers = [
            clip.type,
            clip.clip_type,
            clip.generation_type,
            clip.generation_mode,
            clip.source,
            clip.variant,
            clip.metadata?.type,
            clip.metadata?.clip_type,
            clip.metadata?.generation_type,
            clip.metadata?.generation_mode,
            clip.meta?.type,
            clip.meta?.clip_type,
            clip.meta?.generation_type,
            clip.meta?.generation_mode,
            clip.generation?.type,
            clip.generation?.mode,
            clip.model?.type,
            clip.model?.mode
        ];

        for (const value of typeMarkers) {
            const token = normalizeToken(value);
            if (token && STEM_TOKENS.has(token)) return true;
        }

        if (Array.isArray(clip.tags)) {
            for (const tag of clip.tags) {
                const token = normalizeToken(tag);
                if (token && STEM_TOKENS.has(token)) return true;
            }
        }

        return false;
    }


    function isSongFromOtherArtist(song) {
        if (song?.is_owned_by_current_user === false) return true;
        if (sunoUserId && song?.owner_user_id && song.owner_user_id !== sunoUserId) return true;
        return false;
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

    function getSongThumbnailUrl(song) {
        return song?.image_url || song?.thumbnail_url || song?.cover_image_url || song?.artwork_url || null;
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
            leftSong?.is_liked === rightSong?.is_liked &&
            leftSong?.is_stem === rightSong?.is_stem &&
            (leftSong?.upvote_count ?? null) === (rightSong?.upvote_count ?? null) &&
            (leftSong?.is_owned_by_current_user ?? null) === (rightSong?.is_owned_by_current_user ?? null)
        );
    }

    function mergeSongMetadata(existingSong, freshSong) {
        return {
            ...existingSong,
            title: freshSong.title || existingSong.title,
            audio_url: freshSong.audio_url || existingSong.audio_url,
            video_url: freshSong.video_url || existingSong.video_url,
            image_url: freshSong.image_url || existingSong.image_url,
            lyrics: freshSong.lyrics || existingSong.lyrics,
            is_public: freshSong.is_public !== false,
            is_liked: freshSong.is_liked || false,
            is_stem: freshSong.is_stem ?? existingSong.is_stem,
            upvote_count: freshSong.upvote_count ?? existingSong.upvote_count,
            owner_user_id: freshSong.owner_user_id || existingSong.owner_user_id,
            owner_handle: freshSong.owner_handle || existingSong.owner_handle,
            owner_display_name: freshSong.owner_display_name || existingSong.owner_display_name,
            is_owned_by_current_user: freshSong.is_owned_by_current_user ?? existingSong.is_owned_by_current_user
        };
    }

    function normalizeSongClip(rawClip) {
        const clip = rawClip?.clip || rawClip || {};
        return {
            id: clip.id,
            title: clip.title || `Untitled_${clip.id || 'song'}`,
            audio_url: extractFirstMatchingValue(clip, SONG_CLIP_FIELD_PATHS.audio, value => value || null),
            video_url: extractUrlFromPaths(clip, SONG_CLIP_FIELD_PATHS.video),
            image_url: extractUrlFromPaths(clip, SONG_CLIP_FIELD_PATHS.image),
            lyrics: extractTextFromPaths(clip, SONG_CLIP_FIELD_PATHS.lyrics),
            is_public: clip.is_public !== false,
            created_at: clip.created_at || clip.createdAt || rawClip?.created_at || null,
            is_liked: clip.is_liked || false,
            is_stem: isStemClip(clip),
            upvote_count: clip.upvote_count || 0,
            owner_user_id: extractFirstMatchingValue(clip, SONG_CLIP_FIELD_PATHS.ownerUserId, value => value || null),
            is_owned_by_current_user: clip.is_owned_by_current_user
        };
    }

    function extractPlaylistClipItems(data) {
        if (!data || typeof data !== 'object') return [];

        const collections = [
            data.playlist_clips,
            data.clips,
            data.results,
            data.items,
            data.data?.playlist_clips,
            data.data?.clips,
            data.data?.results,
            data.data?.items
        ];

        for (const collection of collections) {
            if (Array.isArray(collection)) {
                return collection;
            }
        }

        return [];
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

            // Use cached audio if available, otherwise stream online
            const cachedBlob = await getAudioBlobFromIDB(song.id);
            if (cachedBlob) {
                currentBlobUrl = URL.createObjectURL(cachedBlob);
                audioElement.src = currentBlobUrl;
            } else {
                audioElement.src = song.audio_url;
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
        return el ? el.value : 'mp3';
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
    const versionFooter = document.getElementById("versionFooter");

    // hide stop-fetch button initially
    if (stopFetchBtn) {
        stopFetchBtn.style.display = 'none';
    }

    function setFetchUiState(active) {
        if (stopFetchBtn) {
            stopFetchBtn.style.display = active ? 'inline-block' : 'none';
        }
        if (syncNewBtn) {
            syncNewBtn.disabled = active;
            syncNewBtn.textContent = active && currentFetchMode === 'incremental' ? 'Refreshing...' : 'Refresh';
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
            cacheAllBtn.textContent = active ? 'Downloading to DB...' : '💾 Download to DB';
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

    function startFullRefresh(options = {}) {
        const { confirmUser = true } = options;
        if (currentFetchMode !== 'idle') {
            return;
        }

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
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: isPublicOnly,
                maxPages: maxPages
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Message error:', chrome.runtime.lastError);
                    statusDiv.innerText = "Fetching songs in background...";
                } else if (response && response.error) {
                    console.error('[Downloader] Fetch songs error:', response.error);
                    statusDiv.innerText = response.error;
                } else {
                    console.log('[Downloader] Fetch request sent successfully');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not send fetch request:', e.message);
            statusDiv.innerText = "Fetching songs in background...";
            currentFetchMode = 'idle';
            setFetchUiState(false);
        }
    }

    function startIncrementalSync(options = {}) {
        const { automatic = false } = options;

        if (currentFetchMode !== 'idle') {
            return;
        }

        if (!allSongs.length) {
            startFullRefresh({ confirmUser: !automatic });
            return;
        }

        currentFetchMode = 'incremental';
        setFetchUiState(true);
        void saveSyncMeta({
            syncStatus: 'running',
            lastSyncMode: 'incremental',
            lastError: null
        });

        statusDiv.innerText = automatic ? "Checking for new songs..." : "Refreshing songs and metadata...";

        try {
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: false,
                maxPages: 0,
                checkNewOnly: true,
                knownIds: allSongs.map(song => song.id)
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Incremental refresh error:', chrome.runtime.lastError);
                } else if (response && response.error) {
                    console.log('[Downloader] Incremental refresh error:', response.error);
                } else {
                    console.log('[Downloader] Incremental refresh request sent');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not refresh:', e.message);
            currentFetchMode = 'idle';
            setFetchUiState(false);
            statusDiv.innerText = "Refresh failed: " + e.message;
            void saveSyncMeta({
                syncStatus: 'error',
                lastError: e.message
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

                    if (getSongThumbnailUrl(s) !== getSongThumbnailUrl(mergedSong)) {
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
            filteredSongs = [...allSongs];
            applyFilter({
                preserveScroll: true,
                minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
            });
            void saveToStorage();
        }

        if (staleImageSongIds.length > 0) {
            void Promise.all(staleImageSongIds.map(songId => deleteImageBlobFromIDB(songId)));
        }

        return addedSongs.length;
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
                statusDiv.innerText = `⏹️ Download to DB stopped. ${cached} song(s) saved.`;
                break;
            }

            statusDiv.innerText = `💾 Downloading to DB ${cached + failed + 1}/${total}: ${song.title || 'Untitled'}...`;

            try {
                const response = await fetch(song.audio_url);
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
            statusDiv.innerText = `✅ Download to DB complete! ${cached} new, ${totalCached} total in browser database. ${failed > 0 ? `${failed} failed.` : ''}`.trim();
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
            startIncrementalSync({ automatic: false });
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
                const response = await api.runtime.sendMessage({ action: 'fetch_user_playlists', page });
                if (!response?.ok || !response.data) {
                    const reason = response?.error || `HTTP ${response?.status || 'unknown'}`;
                    statusDiv.innerText = Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0
                        ? `Loaded cached playlists. Refresh failed: ${reason}`
                        : `Playlist load failed: ${reason}`;
                    return;
                }
                const data = response.data;
                const batch = data.playlists;
                if (!Array.isArray(batch) || batch.length === 0) break;
                allPlaylists.push(...batch);
                // Stop if we have fetched all
                const total = data.num_total_results || 0;
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
            allPlaylists.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const normalizedPlaylists = allPlaylists.map(normalizePlaylistMetadata);
            renderPlaylistOptions(normalizedPlaylists, preferredValue);
            await savePreferenceToIDB(PLAYLISTS_KEY, normalizedPlaylists);
            statusDiv.innerText = `Loaded ${allPlaylists.length} playlist(s).`;
        } catch (e) {
            statusDiv.innerText = `Playlist load failed: ${e?.message || String(e)}`;
            console.debug('[Downloader] Failed to load playlists:', e);
        }
    }

    async function selectPlaylist(playlistId) {
        playlistSongs = null;
        await savePreferenceToIDB(SELECTED_PLAYLIST_KEY, playlistId || '');

        if (playlistId) {
            statusDiv.innerText = 'Loading playlist songs...';
            const cachedSongs = await loadPreferenceFromIDB(getPlaylistSongsCacheKey(playlistId));
            if (Array.isArray(cachedSongs) && cachedSongs.length > 0) {
                playlistSongs = cachedSongs;
                applyFilter();
                statusDiv.innerText = `Loaded ${cachedSongs.length} cached playlist song(s). Refreshing...`;
            }

            const playlistClipMap = new Map();
            let page = 1;
            while (true) {
                try {
                    const response = await api.runtime.sendMessage({
                        action: 'fetch_playlist_songs',
                        playlistId,
                        page
                    });
                    if (!response?.ok || !response.data) {
                        statusDiv.innerText = `Playlist load failed: ${response?.error || response?.status || 'unknown error'}`;
                        break;
                    }
                    const data = response.data;
                    const clips = extractPlaylistClipItems(data);
                    for (const c of clips) {
                        const song = normalizeSongClip(c);
                        if (song.id) {
                            playlistClipMap.set(song.id, song);
                        }
                    }
                    const total = data.num_total_results ?? data.total ?? 0;
                    if (!clips.length || playlistClipMap.size >= total) break;
                    page++;
                } catch (e) {
                    console.debug('[Downloader] Failed to fetch playlist songs page', page, e);
                    break;
                }
            }
            playlistSongs = Array.from(playlistClipMap.values());
            await savePreferenceToIDB(getPlaylistSongsCacheKey(playlistId), playlistSongs);
            statusDiv.innerText = playlistSongs.length > 0
                ? `Playlist: loaded ${playlistSongs.length} song(s).`
                : 'Playlist returned no songs from the current API response.';
        } else {
            statusDiv.innerText = 'Showing all songs.';
            if (libraryNeedsMetadataRefresh(allSongs)) {
                statusDiv.innerText = 'Refreshing all songs metadata...';
                setTimeout(() => startFullRefresh({ confirmUser: false }), 100);
            }
        }
        applyFilter();
    }

    if (playlistFilter) {
        playlistFilter.addEventListener('change', () => {
            void selectPlaylist(playlistFilter.value);
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

            // Incremental page update
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;

            if (wasCheckingNew) {
                // Merge with existing songs
                mergeSongs(newSongs);
                statusDiv.innerText = `Page ${message.pageNum}: ${message.totalSongs} new songs found...`;
            } else {
                // Fresh fetch - replace all
                allSongs = newSongs;
                initSunoUserId();
                filteredSongs = [...allSongs];

                // Show song list immediately after first page
                if (message.pageNum === 1) {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        applyFilter();
                    });
                } else {
                    // Just update the list
                    applyFilter({
                        preserveScroll: true,
                        minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
                    });
                }
                saveToStorage();
                statusDiv.innerText = `Page ${message.pageNum}: ${allSongs.length} songs...`;
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
                const addedCount = mergeSongs(newSongs);
                void saveSyncMeta({
                    lastSyncAt: completedAt,
                    lastIncrementalSyncAt: completedAt,
                    lastSyncMode: 'incremental',
                    lastAddedCount: addedCount,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                if (addedCount > 0) {
                    statusDiv.innerText = `Found ${addedCount} new song(s). Total: ${allSongs.length}`;
                } else {
                    statusDiv.innerText = `${allSongs.length} songs (no new songs found).`;
                }
            } else {
                // Fresh fetch complete
                allSongs = newSongs;
                initSunoUserId();
                filteredSongs = [...allSongs];

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
                    lastAddedCount: allSongs.length,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                statusDiv.innerText = `✅ Complete! Found ${allSongs.length} songs total.`;
            }
            currentFetchMode = 'idle';
        }
        if (message.action === "fetch_stopped") {
            setFetchUiState(false);
            void saveSyncMeta({
                syncStatus: 'stopped',
                lastSyncMode: currentFetchMode === 'idle' ? syncMeta.lastSyncMode : currentFetchMode
            });
            statusDiv.innerText = "⏹️ Fetch stopped by user – song list may be incomplete.";
            currentFetchMode = 'idle';
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
        if (currentPlayingSongId === song.id) {
            item.classList.add('playing');
        }

        const thumbnailUrl = getSongThumbnailUrl(song);

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

        function attachThumbnailImage(src) {
            const thumbnailImage = document.createElement("img");
            thumbnailImage.className = "song-thumbnail-image";
            thumbnailImage.src = src;
            thumbnailImage.alt = song.title ? `${song.title} cover art` : 'Song cover art';
            thumbnailImage.loading = 'lazy';
            thumbnailImage.decoding = 'async';
            thumbnailImage.addEventListener('error', () => {
                thumbnail.classList.add('is-fallback');
                thumbnailImage.remove();
                if (!thumbnail.textContent) {
                    thumbnail.textContent = '♪';
                }
            }, { once: true });
            thumbnail.appendChild(thumbnailImage);
        }

        if (cachedSongIds.has(song.id) && !song.image_cache_bust) {
            // Try to load from the local imageCache first; fall back to CDN URL
            getImageBlobFromIDB(song.id).then(imgBlob => {
                if (imgBlob) {
                    const objUrl = URL.createObjectURL(imgBlob);
                    attachThumbnailImage(objUrl);
                    // Revoke the object URL once the image has loaded to free memory
                    thumbnail.querySelector('img')?.addEventListener('load', () => URL.revokeObjectURL(objUrl), { once: true });
                } else if (thumbnailUrl) {
                    attachThumbnailImage(thumbnailUrl);
                } else {
                    thumbnail.classList.add('is-fallback');
                    thumbnail.textContent = '♪';
                }
            });
        } else if (thumbnailUrl) {
            attachThumbnailImage(thumbnailUrl);
        } else {
            thumbnail.classList.add('is-fallback');
            thumbnail.textContent = '♪';
        }

        const songInfo = document.createElement("div");
        songInfo.className = "song-info";
        songInfo.style.cursor = 'pointer';
        songInfo.addEventListener('click', () => {
            togglePlay(song);
        });

        const titleDiv = document.createElement("div");
        titleDiv.className = "song-title";
        titleDiv.title = song.title;
        titleDiv.textContent = song.title;

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
            ownershipSpan.textContent = ' • 👤 Other artist';
            ownershipSpan.title = 'Only your own songs can be downloaded as files';
            ownershipSpan.style.color = '#ff9800';
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

        const playBtn = document.createElement("button");
        playBtn.className = "song-action-btn play-btn";
        playBtn.title = "Play Song";
        playBtn.textContent = (currentPlayingSongId === song.id && !audioElement.paused) ? '⏸' : '▶';
        playBtn.onclick = (e) => {
            e.stopPropagation();
            togglePlay(song);
        };

        const gotoBtn = document.createElement("button");
        gotoBtn.className = "song-action-btn goto-btn";
        gotoBtn.title = "Go to Song";
        gotoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5c-7.633 0-12 7-12 7s4.367 7 12 7 12-7 12-7-4.367-7-12-7zm0 12a5 5 0 1 1 .001-10.001A5 5 0 0 1 12 17zm0-8a3 3 0 1 0 .001 6.001A3 3 0 0 0 12 9z"/></svg>`;
        gotoBtn.onclick = (e) => {
            e.stopPropagation();
            window.open(`https://suno.com/song/${song.id}`, '_blank');
        };

        actionsDiv.appendChild(playBtn);
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
                    : 'No offline songs cached yet. Select songs and use Download to DB.';
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
