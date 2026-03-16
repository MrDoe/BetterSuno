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
    const userId = window.sunoUserId || null;

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

        if (clip.is_stem === true || clip.stem_of || clip.stem_of_id) return true;

        const directStrings = [
            clip.type,
            clip.clip_type,
            clip.generation_type,
            clip.generation_mode,
            clip.source,
            clip.variant
        ];

        for (const value of directStrings) {
            if (typeof value === 'string' && value.toLowerCase().includes('stem')) return true;
        }

        const nested = [clip.metadata, clip.meta, clip.generation, clip.model, clip.source_clip, clip.parent_clip];
        for (const obj of nested) {
            if (!obj || typeof obj !== 'object') continue;
            for (const v of Object.values(obj)) {
                if (typeof v === 'string' && v.toLowerCase().includes('stem')) return true;
                if (v === true && (obj.is_stem === true || obj.stem === true)) return true;
            }
        }

        if (Array.isArray(clip.tags) && clip.tags.some(t => typeof t === 'string' && t.toLowerCase().includes('stem'))) {
            return true;
        }

        if (typeof clip.title === 'string' && /\bstem(s)?\b/i.test(clip.title)) return true;

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
            
            let foundKnownSong = false;

            for (const clip of clips) {
                if (isPublicOnly && !clip.is_public) {
                    continue;
                }

                if (checkNewOnly && knownIds.has(clip.id)) {
                    log(`✅ Found known song. ${allSongs.length} new song(s) found.`);
                    foundKnownSong = true;
                    break;
                }

                allSongs.push({
                    id: clip.id,
                    title: clip.title || `Untitled_${clip.id}`,
                    audio_url: clip.audio_url || null,
                    image_url: extractImageUrlFromClip(clip),
                    lyrics: extractLyricsFromClip(clip),
                    is_public: clip.is_public,
                    created_at: clip.created_at,
                    is_liked: clip.is_liked || false,
                    is_stem: isStemClip(clip),
                    upvote_count: clip.upvote_count || 0
                });
            }

            // Send incremental update after each page
            api.runtime.sendMessage({
                action: "songs_page",
                songs: allSongs,
                pageNum: pageNum,
                totalSongs: allSongs.length,
                checkNewOnly: checkNewOnly
            });

            if (foundKnownSong) {
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
