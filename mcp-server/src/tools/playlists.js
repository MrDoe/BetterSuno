import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerPlaylistTools(server, allTools) {
  const tools = [
    tool('list_playlists', 'List your playlists', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/playlist/me');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch playlists');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('create_playlist', 'Create a new playlist', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Playlist name' },
        description: { type: 'string', description: 'Playlist description' },
        is_public: { type: 'boolean', description: 'Whether the playlist is public', default: false },
      },
      required: ['name'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/playlist/create/', {
        body: { name: args.name, description: args.description || '', is_public: args.is_public || false },
      });
      if (!result.ok) throw new Error(result.error || 'Playlist creation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_playlist', 'Get playlist details and tracks', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        page: { type: 'number', description: 'Page number', default: 1 },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}`, {
        params: { page: args.page || 1, page_size: 50 },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch playlist');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('add_to_playlist', 'Add songs to a playlist', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to add' },
      },
      required: ['playlist_id', 'clip_ids'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}/tracks/add`, {
        body: { clip_ids: args.clip_ids },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to add tracks to playlist');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('remove_from_playlist', 'Remove songs from a playlist', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to remove' },
      },
      required: ['playlist_id', 'clip_ids'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}/tracks/remove`, {
        body: { clip_ids: args.clip_ids },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to remove tracks from playlist');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('reorder_playlist', 'Reorder tracks in a playlist by index', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        from_index: { type: 'number', description: 'Current index of the track to move' },
        to_index: { type: 'number', description: 'Target index to move the track to' },
      },
      required: ['playlist_id', 'from_index', 'to_index'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}/tracks/reorder-by-index`, {
        body: { from_index: args.from_index, to_index: args.to_index },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to reorder playlist');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('delete_playlist', 'Delete/trash a playlist', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}/trash`);
      if (!result.ok) throw new Error(result.error || 'Failed to delete playlist');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, playlist_id: args.playlist_id }, null, 2) }] };
    }),

    tool('update_playlist_metadata', 'Update playlist name, description, or visibility', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        name: { type: 'string', description: 'New playlist name' },
        description: { type: 'string', description: 'New description' },
        is_public: { type: 'boolean', description: 'Whether the playlist is public' },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const body = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;

      if (args.is_public !== undefined) {
        body.is_public = args.is_public;
      }

      const result = await sunoClient.POST('/api/playlist/set_metadata', { body: { playlist_id: args.playlist_id, ...body } });
      if (!result.ok) throw new Error(result.error || 'Failed to update playlist');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('search_playlists', 'Search playlists by query. Returns both your own and other users\' public playlists.', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Playlist search query' },
        limit: { type: 'number', description: 'Max results', default: 100 },
      },
      required: ['query'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/search/', {
        search_queries: [
          {
            name: 'playlists',
            search_type: 'playlist',
            term: args.query,
            from_index: 0,
            size: args.limit || 100,
            rank_by: 'most_relevant',
          },
        ],
        tune_results: false,
        tuned_offset: 0,
      });
      if (!result.ok) throw new Error(result.error || 'Playlist search failed');
      const d = result.data || {};
      let raw = [];
      if (d?.result?.playlist?.result) raw = d.result.playlist.result;
      else if (d?.result?.playlists?.result) raw = d.result.playlists.result;
      else if (Array.isArray(d?.playlists)) raw = d.playlists;
      const playlists = raw.map((pl) => ({
        id: pl.id,
        name: pl.name || pl.title || null,
        image_url: pl.image_url || null,
        song_count: pl.song_count ?? pl.num_total_results ?? null,
        user_handle: pl.user_handle || null,
        user_display_name: pl.user_display_name || pl.user_handle || null,
        is_public: pl.is_public ?? true,
        is_owned_by_current_user: pl.is_owned_by_current_user ?? false,
        owner_user_id: pl.owner_user_id || pl.user_id || null,
        owner_handle: pl.owner_handle || pl.user_handle || null,
        description: pl.description || '',
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ playlists }, null, 2) }] };
    }),

    tool('get_playlist_songs', 'Get the songs in a playlist by ID. Works for public playlists owned by other users too (enables playing them).', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        page: { type: 'number', description: 'Page number', default: 1 },
        page_size: { type: 'number', description: 'Page size', default: 50 },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const pid = encodeURIComponent(args.playlist_id);
      const page = args.page || 1;
      const size = args.page_size || 50;
      const candidates = [
        `/api/playlist/v2/${pid}?page=${page}&page_size=${size}`,
        `/api/playlist/${pid}?page=${page}&page_size=${size}`,
        `/api/playlist/${pid}/clips?page=${page}&page_size=${size}`,
      ];
      const findClipArray = (data) => {
        if (!data || typeof data !== 'object') return null;
        const paths = [
          data.playlist_clips, data.playlist_songs, data.songs, data.tracks, data.clips, data.results, data.items,
          data.playlist?.playlist_clips, data.playlist?.playlist_songs, data.playlist?.songs, data.playlist?.tracks, data.playlist?.clips,
          data.data?.playlist_clips, data.data?.playlist_songs, data.data?.songs, data.data?.tracks, data.data?.clips,
          data.data?.playlist?.playlist_clips, data.data?.playlist?.playlist_songs, data.data?.playlist?.songs,
        ];
        for (const c of paths) if (Array.isArray(c) && c.length > 0) return c;
        return null;
      };
      for (const url of candidates) {
        const result = await sunoClient.GET(url);
        if (!result.ok) continue;
        const clips = findClipArray(result.data);
        if (clips && clips.length > 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ playlist_id: args.playlist_id, page, songs: clips }, null, 2) }] };
        }
      }
      throw new Error('Could not retrieve songs for this playlist (it may be private or not found).');
    }),
  ];

  allTools.push(...tools);
}
