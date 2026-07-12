export const config = {
  wsPort: parseInt(process.env.MCP_WS_PORT || '9423', 10),
  apiBaseUrl: process.env.MCP_API_BASE_URL || 'https://studio-api.prod.suno.com',
  maxRetries: 5,
  initialRetryDelayMs: 1000,
  captchaTimeoutMs: 60000,
  tokenRefreshTimeoutMs: 15000,
};
