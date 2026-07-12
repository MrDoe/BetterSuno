import { sunoClient } from '../suno-client.js';
import { sendToExtension } from '../ws-bridge.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerPlaybackTools(allTools) {
  const tools = [
    tool(
      'play_song',
      'Play a song in the BetterSuno in-page mini player (GUI). Works for any song including public songs from other users\' playlists. Requires the BetterSuno extension to be connected to an open suno.com tab.',
      {
        type: 'object',
        properties: {
          clip_id: { type: 'string', description: 'Song clip ID to play' },
          start_time: { type: 'number', description: 'Start playback at this position in seconds' },
        },
        required: ['clip_id'],
      },
      async (args) => {
        const result = await sunoClient.GET(`/api/clip/${encodeURIComponent(args.clip_id)}`);
        if (!result.ok) {
          throw new Error(result.error || 'Song not found');
        }
        const sent = sendToExtension({
          type: 'play_song',
          song: result.data,
          start_time: typeof args.start_time === 'number' ? args.start_time : null,
        });
        if (!sent) {
          throw new Error('BetterSuno extension is not connected (open suno.com with the extension loaded).');
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  playing: true,
                  clip_id: args.clip_id,
                  title: result.data.title,
                  start_time: typeof args.start_time === 'number' ? args.start_time : 0,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),

    tool(
      'stop_playback',
      'Stop the currently playing song in the BetterSuno GUI. Requires the BetterSuno extension to be connected.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const sent = sendToExtension({ type: 'stop_playback' });
        if (!sent) {
          throw new Error('BetterSuno extension is not connected (open suno.com with the extension loaded).');
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ stopped: true }, null, 2) }],
        };
      },
    ),
  ];

  allTools.push(...tools);
}
