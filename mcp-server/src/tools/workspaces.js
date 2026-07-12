import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerWorkspaceTools(server, allTools) {
  const tools = [
    tool('list_projects', 'List your projects/workspaces', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/project/feed');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch projects');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_project', 'Get project/workspace details', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/project/${encodeURIComponent(args.project_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch project');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_project_clips', 'List clips/songs in a project', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/project/${encodeURIComponent(args.project_id)}/clips`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch project clips');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
