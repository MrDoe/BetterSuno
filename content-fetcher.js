// content-fetcher.js — Injected script to fetch song list from Suno API
(async function() {
    const api = (typeof browser !== 'undefined') ? browser : chrome;
    
    function log(text) {
        try {
            api.runtime.sendMessage({ action: "log", text: text });
        } catch (e) {
            // ignore
        }
    }

    const token = window.sunoAuthToken;
    const isPublicOnly = window.sunoPublicOnly;
    const maxPages = window.sunoMaxPages || 0; // 0 = unlimited
    const checkNewOnly = window.sunoCheckNewOnly || false;
    const knownIds = new Set(window.sunoKnownIds || []);
    const metadataRefreshIds = new Set((window.sunoMetadataRefreshIds || []).filter(id => typeof id === 'string' && id));
    const metadataRefreshTargetCount = metadataRefreshIds.size;
    const userId = window.sunoUserId || null;
    const userIds = new Set((Array.isArray(window.sunoUserIds) ? window.sunoUserIds : []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()));
    if (userId && !userIds.has(userId)) userIds.add(userId);

    if (!token) {
        api.runtime.sendMessage({ action: "fetch_error_internal", error: "❌ Fatal: No Auth Token received." });
        return;
    }

    const modeLabel = isPublicOnly ? "Public Songs Only" : "All Songs";
    const pagesLabel = maxPages > 0 ? `, max ${maxPages} pages` : "";
    if (!checkNewOnly) {
        log(`🔍 Fetching songs (${modeLabel}${pagesLabel})...`);
    }

    let keepGoing = true;
    let allSongs = [];
    let cursor = null;
    
    // Adaptive settings
    let delay = 300;
    let successStreak = 0;
    const minDelay = 200;
    const maxDelay = 5000;

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

    function extractText(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }

        if (Array.isArray(value)) {
            const parts = value
                .map(v => extractText(v))
                .filter(Boolean);
            if (parts.length > 0) return parts.join('\n');
        }

        if (value && typeof value === 'object') {
            const nestedCandidates = [
                value.lyrics,
                value.display_lyrics,
                value.full_lyrics,
                value.raw_lyrics,
                value.prompt,
                value.text,
                value.content,
                value.value
            ];
            for (const candidate of nestedCandidates) {
                const text = extractText(candidate);
                if (text) return text;
            }
        }

        return null;
    }

    function extractLyricsFromClip(clip) {
        if (!clip || typeof clip !== 'object') return null;

        const directCandidates = [
            clip.lyrics,
            clip.display_lyrics,
            clip.full_lyrics,
            clip.raw_lyrics,
            clip.prompt,
            clip.metadata?.lyrics,
            clip.metadata?.display_lyrics,
            clip.metadata?.full_lyrics,
            clip.metadata?.raw_lyrics,
            clip.metadata?.prompt,
            clip.meta?.lyrics,
            clip.meta?.display_lyrics,
            clip.meta?.prompt
        ];

        for (const candidate of directCandidates) {
            const text = extractText(candidate);
            if (text) return text;
        }

        return null;
    }

    function extractUrl(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^https?:\/\//i.test(trimmed)) {
                return trimmed;
            }
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const url = extractUrl(item);
                if (url) return url;
            }
        }

        if (value && typeof value === 'object') {
            const nestedCandidates = [
                value.url,
                value.src,
                value.image_url,
                value.image,
                value.cover_url,
                value.cover_image_url,
                value.thumbnail_url,
                value.artwork_url
            ];
            for (const candidate of nestedCandidates) {
                const url = extractUrl(candidate);
                if (url) return url;
            }
        }

        return null;
    }

    function extractImageUrlFromClip(clip) {
        if (!clip || typeof clip !== 'object') return null;

        const directCandidates = [
            clip.image_url,
            clip.image,
            clip.image_large_url,
            clip.cover_url,
            clip.cover_image_url,
            clip.thumbnail_url,
            clip.artwork_url,
            clip.metadata?.image_url,
            clip.metadata?.image,
            clip.metadata?.cover_url,
            clip.metadata?.cover_image_url,
            clip.meta?.image_url,
            clip.meta?.image,
            clip.meta?.cover_url,
            clip.meta?.cover_image_url
        ];

        for (const candidate of directCandidates) {
            const url = extractUrl(candidate);
            if (url) return url;
        }

        return null;
    }

    function extractVideoUrlFromClip(clip) {
        if (!clip || typeof clip !== 'object') return null;

        const directCandidates = [
            clip.video_url,
            clip.video_cdn_url,
            clip.mp4_url,
            clip.cover_video_url,
            clip.metadata?.video_url,
            clip.metadata?.video_cdn_url,
            clip.metadata?.mp4_url,
            clip.meta?.video_url,
            clip.meta?.video_cdn_url,
            clip.meta?.mp4_url
        ];

        for (const candidate of directCandidates) {
            const url = extractUrl(candidate);
            if (url) return url;
        }

        return null;
    }

    function extractAudioUrlFromClip(clip) {
        if (!clip || typeof clip !== 'object') return null;

        const directCandidates = [
            clip.audio_url,
            clip.stream_audio_url,
            clip.song_path,
            clip.metadata?.audio_url,
            clip.metadata?.stream_audio_url,
            clip.metadata?.song_path,
            clip.meta?.audio_url,
            clip.meta?.stream_audio_url,
            clip.meta?.song_path
        ];

        for (const candidate of directCandidates) {
            const url = extractUrl(candidate);
            if (url) return url;
        }

        return null;
    }

    function pickFirstNonEmptyString(values) {
        for (const value of values) {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
            }
        }

        return null;
    }

    function normalizeHandle(value) {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
        return trimmed || null;
    }

    function extractOwnershipMetadataFromClip(clip, currentUserId, currentUserIds) {
        const idSet = currentUserIds || new Set();
        if (currentUserId && !idSet.has(currentUserId)) idSet.add(currentUserId);

        if (!clip || typeof clip !== 'object') {
            return {
                owner_user_id: currentUserId || null,
                owner_handle: null,
                owner_display_name: null,
                is_owned_by_current_user: idSet.size > 0 ? true : undefined
            };
        }

        const profiles = [
            clip.user,
            clip.owner,
            clip.creator,
            clip.author,
            clip.profile,
            clip.user_profile,
            clip.owner_profile,
            clip.creator_profile,
            clip.author_profile,
            ...(Array.isArray(clip.user_profiles) ? clip.user_profiles : []),
            ...(Array.isArray(clip.users) ? clip.users : [])
        ].filter(Boolean);

        const ownerUserId = pickFirstNonEmptyString([
            clip.user_id,
            clip.owner_user_id,
            clip.creator_user_id,
            clip.author_user_id,
            clip.owner_id,
            clip.creator_id,
            clip.author_id,
            clip.profile_id,
            ...profiles.map(profile => pickFirstNonEmptyString([
                profile?.id,
                profile?.user_id,
                profile?.profile_id,
                profile?.owner_id
            ]))
        ]) || currentUserId || null;

        const ownerHandle = normalizeHandle(pickFirstNonEmptyString([
            clip.handle,
            clip.user_handle,
            clip.owner_handle,
            clip.creator_handle,
            clip.author_handle,
            clip.username,
            ...profiles.map(profile => pickFirstNonEmptyString([
                profile?.handle,
                profile?.username,
                profile?.user_handle
            ]))
        ]));

        const ownerDisplayName = pickFirstNonEmptyString([
            clip.display_name,
            clip.user_display_name,
            clip.owner_display_name,
            clip.creator_display_name,
            clip.author_display_name,
            ...profiles.map(profile => pickFirstNonEmptyString([
                profile?.display_name,
                profile?.name
            ]))
        ]);

        return {
            owner_user_id: ownerUserId,
            owner_handle: ownerHandle,
            owner_display_name: ownerDisplayName,
            is_owned_by_current_user: idSet.size > 0 && !!ownerUserId && idSet.has(ownerUserId) ? true : undefined
        };
    }

    function normalizeClipLikeStatus(clip) {
        const likeCandidate =
            clip?.is_liked ??
            clip?.liked ??
            clip?.reaction_type ??
            clip?.current_user_reaction ??
            clip?.user_reaction ??
            clip?.isLike ??
            clip?.react ??
            clip?.upvote ??
            false;

        if (typeof likeCandidate === 'boolean') {
            return likeCandidate;
        }

        if (typeof likeCandidate === 'number') {
            return likeCandidate !== 0;
        }

        if (typeof likeCandidate === 'string') {
            const normalized = likeCandidate.trim().toLowerCase();
            if (['1', 'true', 'yes', 'on', 'liked', 'like'].includes(normalized)) return true;
            if (['0', 'false', 'no', 'off', 'disliked', 'dislike', 'none', 'null', ''].includes(normalized)) return false;
        }

        return false;
    }

    function normalizeClipUpvoteCount(clip) {
        const countCandidate =
            clip?.upvote_count ??
            clip?.like_count ??
            clip?.likes ??
            clip?.score ??
            0;

        const numberValue = Number(countCandidate);
        if (Number.isFinite(numberValue) && numberValue >= 0) {
            return Math.floor(numberValue);
        }

        return 0;
    }

    async function fetchPage(cursorValue) {
        const res = await Promise.race([
            api.runtime.sendMessage({
                action: "fetch_feed_page",
                token,
                cursor: cursorValue || null,
                isPublicOnly,
                userId
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout contacting background')), 25000))
        ]).catch((e) => ({ ok: false, status: 0, error: e?.message || String(e) }));

        if (!res?.ok && (!res?.status || res.status === 0)) {
            throw new Error(res?.error || 'Background fetch failed');
        }

        return {
            ok: !!res?.ok,
            status: typeof res?.status === 'number' ? res.status : 0,
            json: async () => {
                if (res?.data) return res.data;
                return {};
            }
        };
    }

    async function fetchWithRetry(cursorValue) {
        let retries = 0;
        const maxRetries = 5;
        
        while (retries < maxRetries) {
            try {
                const response = await fetchPage(cursorValue);
                
                if (response.status === 429) {
                    retries++;
                    delay = Math.min(maxDelay, delay * 2);
                    successStreak = 0;
                    const waitTime = Math.pow(2, retries) * 1000;
                    log(`⏳ Rate limited (${delay}ms delay). Waiting ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                
                successStreak++;
                if (successStreak >= 5 && delay > minDelay) {
                    delay = Math.max(minDelay, Math.floor(delay * 0.8));
                    successStreak = 0;
                }
                
                return response;
            } catch (err) {
                retries++;
                if (retries >= maxRetries) throw err;
                await new Promise(r => setTimeout(r, 1000 * retries));
            }
        }
        return null;
    }

    let pageNum = 0;
    try {
        while (keepGoing) {
            if (window.sunoStopFetch) {
                log(`⏹️ Stopped by user. Found ${allSongs.length} songs.`);
                break;
            }
            
            pageNum++;
            if (maxPages > 0 && pageNum > maxPages) {
                log(`✅ Reached max pages limit (${maxPages}). Found ${allSongs.length} songs.`);
                break;
            }
            
            log(`📄 Page ${pageNum}${maxPages > 0 ? '/' + maxPages : ''} | ${allSongs.length} songs`);

            const response = await fetchWithRetry(cursor);
            
            if (!response) {
                api.runtime.sendMessage({ action: "fetch_error_internal", error: `❌ API Error: Max retries exceeded` });
                return;
            }
            
            if (response.status === 401) {
                api.runtime.sendMessage({ action: "fetch_error_internal", error: "❌ Error 401: Token expired." });
                return;
            }
            if (!response.ok) {
                api.runtime.sendMessage({ action: "fetch_error_internal", error: `❌ API Error: ${response.status}` });
                return;
            }

            const data = await response.json();
            const clips = data.clips || [];
            cursor = data.next_cursor;
            const hasMore = data.has_more;

            if (!clips || clips.length === 0) {
                log(`✅ End of list. Found ${allSongs.length} songs total.`);
                keepGoing = false;
                break;
            }
            
            if (!hasMore) {
                keepGoing = false;
            }
            
            let shouldStopAfterPage = false;

            for (const clip of clips) {
                if (isPublicOnly && !clip.is_public) {
                    continue;
                }

                const ownership = extractOwnershipMetadataFromClip(clip, userId, userIds);
                const isExistingSong = knownIds.has(clip.id);

                if (isExistingSong && metadataRefreshIds.has(clip.id)) {
                    metadataRefreshIds.delete(clip.id);
                }

                allSongs.push({
                    id: clip.id,
                    title: clip.title || `Untitled_${clip.id}`,
                    audio_url: extractAudioUrlFromClip(clip),
                    video_url: extractVideoUrlFromClip(clip),
                    image_url: extractImageUrlFromClip(clip),
                    lyrics: extractLyricsFromClip(clip),
                    is_public: clip.is_public !== false,
                    created_at: clip.created_at,
                    is_liked: normalizeClipLikeStatus(clip),
                    is_stem: isStemClip(clip),
                    upvote_count: normalizeClipUpvoteCount(clip),
                    ...ownership
                });

                if (checkNewOnly && isExistingSong) {
                    if (metadataRefreshIds.size === 0) {
                        if (metadataRefreshTargetCount > 0) {
                            const newSongCount = allSongs.reduce((count, song) => count + (knownIds.has(song.id) ? 0 : 1), 0);
                            log(`✅ Refreshed metadata for ${metadataRefreshTargetCount} known song(s). Found ${newSongCount} new song(s).`);
                        } else {
                            log(`✅ Found first existing song. ${Math.max(allSongs.length - 1, 0)} new song(s) found.`);
                        }
                        shouldStopAfterPage = true;
                        break;
                    }
                }
            }

            // Send incremental update after each page
            api.runtime.sendMessage({
                action: "songs_page",
                songs: allSongs,
                pageNum: pageNum,
                totalSongs: allSongs.length,
                checkNewOnly: checkNewOnly
            });

            if (shouldStopAfterPage) {
                keepGoing = false;
                break;
            }
            
            if (!cursor) {
                log(`✅ End of list. Found ${allSongs.length} songs total.`);
                keepGoing = false;
                break;
            }

            await new Promise(r => setTimeout(r, delay));
        }
        
        log(`✅ Found ${allSongs.length} songs.`);
        
        api.runtime.sendMessage({ 
            action: "songs_list", 
            songs: allSongs,
            checkNewOnly: checkNewOnly
        });

    } catch (err) {
        api.runtime.sendMessage({ action: "fetch_error_internal", error: `❌ Critical Error: ${err.message}` });
    }
})();
