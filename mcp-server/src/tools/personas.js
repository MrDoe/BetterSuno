import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerPersonaTools(server, allTools) {
  const tools = [
    tool('create_persona', 'Create a voice persona from existing clips', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Persona name' },
        description: { type: 'string', description: 'Persona description' },
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Array of clip IDs to base the persona on' },
        is_voice_recording: { type: 'boolean', description: 'Whether this uses a voice recording' },
      },
      required: ['name', 'clip_ids'],
    }, async (args) => {
      const body = {
        name: args.name,
        description: args.description || '',
        clips: args.clip_ids,
        is_voice_recording: args.is_voice_recording || false,
      };
      const result = await sunoClient.POST('/api/persona/create/', { body });
      if (!result.ok) throw new Error(result.error || 'Persona creation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('list_personas', 'List your own personas', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/persona/get-personas/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch personas');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_persona', 'Get details for a specific persona', {
      type: 'object',
      properties: {
        persona_id: { type: 'string', description: 'Persona ID' },
      },
      required: ['persona_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/persona/get-persona/${encodeURIComponent(args.persona_id)}/`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch persona');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('list_followed_personas', 'List personas you follow', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/persona/get-followed-personas/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch followed personas');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('list_loved_personas', 'List personas you have loved', {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number', default: 1 },
      },
    }, async (args) => {
      const result = await sunoClient.GET('/api/persona/get-loved-personas/', { params: { page: args.page || 1 } });
      if (!result.ok) throw new Error(result.error || 'Failed to fetch loved personas');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('toggle_love_persona', 'Love or unlove a persona', {
      type: 'object',
      properties: {
        persona_id: { type: 'string', description: 'Persona ID' },
      },
      required: ['persona_id'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/persona/${encodeURIComponent(args.persona_id)}/toggle_love/`);
      if (!result.ok) throw new Error(result.error || 'Failed to toggle persona love');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
