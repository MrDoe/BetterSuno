export const config = {
  wsPort: parseInt(process.env.MCP_WS_PORT || '9423', 10),
  apiBaseUrl: process.env.MCP_API_BASE_URL || 'https://studio-api.prod.suno.com',
  maxRetries: 5,
  initialRetryDelayMs: 1000,
  captchaTimeoutMs: 60000,
  tokenRefreshTimeoutMs: 15000,
  // Comments expose other users' content; opt-in only.
  allowComments: process.env.MCP_ALLOW_COMMENTS === 'true',
  // Prompt library lives in the extension's IndexedDB; surfaced via WS relay.
  extensionRequestTimeoutMs: 15000,
};
