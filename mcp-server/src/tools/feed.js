import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerFeedTools(allTools) {
  const tools = [
    tool('explore_feed', 'Browse the public Suno feed (trending/explore). Returns public songs only — downloading or saving cover art of these is not permitted.', {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
        public_only: { type: 'boolean', description: 'Restrict to public songs', default: true },
        user_id: { type: 'string', description: 'Restrict feed to a specific user ID (optional)' },
        limit: { type: 'number', description: 'Number of results', default: 20 },
      },
    }, async (args) => {
      const body = {
        limit: args.limit || 20,
        filters: {
          disliked: 'False',
          trashed: 'False',
          fromStudioProject: { presence: 'False' },
        },
      };
      if (args.user_id) body.filters.user = { presence: 'True', user_id: args.user_id };
      if (args.public_only !== false) body.filters.public = 'True';
      if (args.cursor) body.cursor = args.cursor;
      const result = await sunoClient.POST('/api/feed/v3', { body });
      if (!result.ok) throw new Error(result.error || 'Feed request failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
