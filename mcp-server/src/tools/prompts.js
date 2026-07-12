import { requestFromExtension } from '../ws-bridge.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

async function extReq(action, payload) {
  const res = await requestFromExtension(action, payload);
  if (!res.ok) throw new Error(res.error || 'Extension request failed');
  return res.data;
}

export function registerPromptTools(allTools) {
  const tools = [
    tool('get_prompts', 'List saved prompt-library entries stored in the BetterSuno extension. Requires the extension to be connected.', {
      type: 'object',
      properties: {},
    }, async () => {
      const data = await extReq('get_prompts');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),

    tool('save_prompt', 'Save a prompt to the BetterSuno extension\'s prompt library. Requires the extension to be connected.', {
      type: 'object',
      properties: {
        prompt: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Prompt title' },
            content: { type: 'string', description: 'Prompt text/lyrics' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
          },
          required: ['content'],
        },
      },
      required: ['prompt'],
    }, async (args) => {
      const data = await extReq('save_prompt', { prompt: args.prompt });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),

    tool('delete_prompt', 'Delete a saved prompt from the BetterSuno extension by ID. Requires the extension to be connected.', {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Prompt ID to delete' },
      },
      required: ['id'],
    }, async (args) => {
      const data = await extReq('delete_prompt', { id: args.id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
