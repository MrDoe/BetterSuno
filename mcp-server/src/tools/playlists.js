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
  ];

  allTools.push(...tools);
}
