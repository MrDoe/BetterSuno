import { sunoClient } from '../suno-client.js';
import { config } from '../config.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerCommentTools(allTools) {
  const guard = () => {
    if (!config.allowComments) {
      throw new Error(
        'Comments are disabled. Set MCP_ALLOW_COMMENTS=true when starting the MCP server to enable comment tools.',
      );
    }
  };

  const tools = [
    tool('get_song_comments', 'List comments on a song. Requires MCP_ALLOW_COMMENTS=true.', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        order: { type: 'string', description: 'Sort order', enum: ['newest', 'top'], default: 'newest' },
      },
      required: ['clip_id'],
    }, async (args) => {
      guard();
      const result = await sunoClient.GET(`/api/gen/${encodeURIComponent(args.clip_id)}/comments`, {
        params: { order: args.order || 'newest' },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch comments');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('post_song_comment', 'Post a comment (or reply) on a song. Requires MCP_ALLOW_COMMENTS=true.', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        content: { type: 'string', description: 'Comment text' },
        parent_id: { type: 'string', description: 'Parent comment ID to reply to (optional)' },
      },
      required: ['clip_id', 'content'],
    }, async (args) => {
      guard();
      const result = await sunoClient.POST(`/api/gen/${encodeURIComponent(args.clip_id)}/comment`, {
        body: { content: args.content, parent_id: args.parent_id || null, track_timestamp: null },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to post comment');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('update_comment_reaction', 'Like/unlike a comment. Requires MCP_ALLOW_COMMENTS=true.', {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'Comment ID' },
        clip_id: { type: 'string', description: 'Song clip ID the comment belongs to' },
        reaction: { type: 'string', description: 'Reaction type', enum: ['LIKE', 'NONE'], default: 'LIKE' },
      },
      required: ['comment_id', 'clip_id'],
    }, async (args) => {
      guard();
      const result = await sunoClient.POST(`/api/comment/${encodeURIComponent(args.comment_id)}/reaction/`, {
        body: { reaction: args.reaction || 'LIKE' },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update comment reaction');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
