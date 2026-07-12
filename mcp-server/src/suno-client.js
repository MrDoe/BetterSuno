import { config } from './config.js';
import { getToken, requestCaptcha } from './ws-bridge.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class SunoClient {
  async _fetch(path, { method = 'GET', body, params, signal, retries = config.maxRetries } = {}) {
    let url = `${config.apiBaseUrl}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) searchParams.set(k, String(v));
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const token = getToken();
    if (!token) {
      return { ok: false, status: 0, error: 'No auth token. Is BetterSuno extension running and connected?', data: null };
    }

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    let lastError = null;
    let delay = config.initialRetryDelayMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });

        let data = null;
        try { data = await response.json(); } catch { /* ignore */ }

        if (response.ok) {
          return { ok: true, status: response.status, data, error: null };
        }

        if (response.status === 401) {
          return { ok: false, status: 401, data, error: data?.detail || 'Token expired — extension should refresh it automatically' };
        }

        if (response.status === 429 && attempt < retries) {
          lastError = { ok: false, status: 429, data, error: data?.detail || 'Rate limited' };
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
          continue;
        }

        return { ok: false, status: response.status, data, error: data?.detail || data?.error_type || `HTTP ${response.status}` };
      } catch (err) {
        lastError = { ok: false, status: 0, data: null, error: err.message };
        if (attempt < retries) {
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
          continue;
        }
        return lastError;
      }
    }

    return lastError;
  }

  GET(path, opts) { return this._fetch(path, { ...opts, method: 'GET' }); }
  POST(path, opts) { return this._fetch(path, { ...opts, method: 'POST' }); }
  PATCH(path, opts) { return this._fetch(path, { ...opts, method: 'PATCH' }); }
  DELETE(path, opts) { return this._fetch(path, { ...opts, method: 'DELETE' }); }

  async captchaCheck(ctype = 'generation') {
    const result = await this.POST('/api/c/check', { body: { ctype } });
    if (result.ok) {
      const required = result.data?.required === true;
      return { required, captchaVersion: result.data?.captcha_version || null };
    }
    return { required: false, captchaVersion: null, error: result.error };
  }

  async ensureCaptcha() {
    const check = await this.captchaCheck();
    if (check.required) {
      const captchaToken = await requestCaptcha();
      return { token: captchaToken, tokenProvider: check.captchaVersion };
    }
    return { token: null, tokenProvider: null };
  }

  async generate(payload) {
    const captcha = await this.ensureCaptcha();
    const fullPayload = {
      ...payload,
      token: captcha.token,
      token_provider: captcha.tokenProvider,
    };
    return this.POST('/api/generate/v2-web/', { body: fullPayload });
  }
}

export const sunoClient = new SunoClient();
