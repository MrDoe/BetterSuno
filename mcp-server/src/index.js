#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initBridge } from './ws-bridge.js';
import { registerGenerationTools } from './tools/generation.js';
import { registerLibraryTools } from './tools/library.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerPersonaTools } from './tools/personas.js';
import { registerUploadTools } from './tools/uploads.js';
import { registerPlaylistTools } from './tools/playlists.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerMetadataTools } from './tools/metadata.js';
import { registerPlaybackTools } from './tools/playback.js';

initBridge();

const server = new Server(
  { name: 'bettersuno-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const allTools = [];

registerGenerationTools(server, allTools);
registerLibraryTools(server, allTools);
registerDownloadTools(server, allTools);
registerPersonaTools(server, allTools);
registerUploadTools(server, allTools);
registerPlaylistTools(server, allTools);
registerWorkspaceTools(server, allTools);
registerMetadataTools(server, allTools);
registerPlaybackTools(allTools);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = allTools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!tool.handler) throw new Error(`Tool ${name} has no handler`);
  return tool.handler(args);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bettersuno-mcp] MCP server ready on stdio');
}

main().catch((err) => {
  console.error('[bettersuno-mcp] Fatal error:', err);
  process.exit(1);
});
