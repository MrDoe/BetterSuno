import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerLibraryTools(server, allTools) {
  const tools = [
    tool('list_library', 'List the user\'s song library', {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of songs per page', default: 50 },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        liked_only: { type: 'boolean', description: 'Show only liked songs' },
        public_only: { type: 'boolean', description: 'Show only public songs' },
        stems_only: { type: 'boolean', description: 'Show only stems' },
        sort: { type: 'string', description: 'Sort order', enum: ['newest', 'oldest'] },
      },
    }, async (args) => {
      const filters = {};
      if (args.liked_only) filters.liked = 'True';
      if (args.public_only) filters.is_public = 'True';
      if (args.stems_only) filters.stem = { presence: 'True' };
      if (args.sort === 'oldest') filters.sort = 'created_asc';

      const body = {
        limit: args.limit || 50,
        cursor: args.cursor || null,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };

      const result = await sunoClient.POST('/api/feed/v3', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch library');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_song', 'Get details for a single song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/clip/${encodeURIComponent(args.clip_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch song');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_songs_by_ids', 'Batch get multiple songs by their IDs', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/clips/get_songs_by_ids', { body: { ids: args.clip_ids } });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch songs');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('search_songs', 'Search Suno songs by query text', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        page: { type: 'number', description: 'Page number', default: 1 },
      },
      required: ['query'],
    }, async (args) => {
      const result = await sunoClient.GET('/api/search/', { params: { q: args.query, page: args.page || 1 } });
      if (!result.ok) throw new Error(result.error || 'Search failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('search_users', 'Search Suno users by query text', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User search query' },
      },
      required: ['query'],
    }, async (args) => {
      const result = await sunoClient.GET('/api/search/users', { params: { q: args.query } });
      if (!result.ok) throw new Error(result.error || 'User search failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_profile', 'Get a user profile by handle', {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'User handle (e.g. @username)' },
      },
      required: ['handle'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/profiles/${encodeURIComponent(args.handle)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch profile');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_current_user', 'Get the current user\'s account info (credits, subscription, plan)', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/user/me');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch user info');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_user_session', 'Get current user session info', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/session/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch session');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
