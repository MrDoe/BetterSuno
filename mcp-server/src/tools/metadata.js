import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerMetadataTools(server, allTools) {
  const tools = [
    tool('delete_song', 'Permanently delete songs', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs to delete' },
        reason: { type: 'string', description: 'Optional reason for deletion' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      const body = { ids: args.clip_ids };
      if (args.reason) body.reason = args.reason;
      const result = await sunoClient.POST('/api/clips/delete/', { body });
      if (!result.ok) throw new Error(result.error || 'Failed to delete songs');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, clip_ids: args.clip_ids }, null, 2) }] };
    }),

    tool('trash_song', 'Move songs to/from trash', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of song clip IDs' },
        trash: { type: 'boolean', description: 'True to trash, false to restore', default: true },
      },
      required: ['clip_ids'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/gen/trash', {
        body: { clip_ids: args.clip_ids, trash: args.trash !== false },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update trash status');
      return { content: [{ type: 'text', text: JSON.stringify({ trashed: args.trash !== false, clip_ids: args.clip_ids }, null, 2) }] };
    }),

    tool('set_visibility', 'Make a song public or private', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        is_public: { type: 'boolean', description: 'True for public, false for private' },
        submit_to_contest: { type: 'boolean', description: 'Also submit to contest', default: false },
      },
      required: ['clip_id', 'is_public'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_visibility/`, {
        body: { is_public: args.is_public, submit_to_contest: args.submit_to_contest || false },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update visibility');
      return { content: [{ type: 'text', text: JSON.stringify({ clip_id: args.clip_id, is_public: args.is_public }, null, 2) }] };
    }),

    tool('like_song', 'Like or unlike a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        like: { type: 'boolean', description: 'True to like, false to unlike' },
      },
      required: ['clip_id', 'like'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/update_reaction_type/`, {
        body: { reaction: args.like ? 'LIKE' : null },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update reaction');
      return { content: [{ type: 'text', text: JSON.stringify({ clip_id: args.clip_id, liked: args.like }, null, 2) }] };
    }),

    tool('update_song_metadata', 'Update a song\'s title, tags, or lyrics', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        title: { type: 'string', description: 'New title' },
        tags: { type: 'string', description: 'New style tags' },
        lyrics: { type: 'string', description: 'New lyrics' },
        negative_tags: { type: 'string', description: 'New negative/exclude style tags' },
        is_public: { type: 'boolean', description: 'Update visibility' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.lyrics !== undefined) body.prompt = args.lyrics;
      if (args.negative_tags !== undefined) body.negative_tags = args.negative_tags;
      if (args.is_public !== undefined) body.is_public = args.is_public;

      let result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_metadata/`, { body });
      if (!result.ok) throw new Error(result.error || 'Failed to update metadata');

      if (args.is_public !== undefined) {
        result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/set_visibility/`, {
          body: { is_public: args.is_public },
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify({ updated: true, clip_id: args.clip_id }, null, 2) }] };
    }),

    tool('generate_video', 'Generate a lyric video for a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/video/generate/${encodeURIComponent(args.clip_id)}/`);
      if (!result.ok) throw new Error(result.error || 'Video generation failed');
      return { content: [{ type: 'text', text: JSON.stringify({ generating: true, clip_id: args.clip_id }, null, 2) }] };
    }),

    tool('create_custom_model', 'Create a custom AI model from a set of clips', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of clip IDs (minimum 6)' },
        name: { type: 'string', description: 'Custom model name', default: 'Custom Model' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      if (args.clip_ids.length < 6) throw new Error('At least 6 clips are required to create a custom model');
      const result = await sunoClient.POST('/api/custom-model/create/', {
        body: { clip_ids: args.clip_ids, name: args.name || 'Custom Model' },
      });
      if (!result.ok) throw new Error(result.error || 'Custom model creation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
