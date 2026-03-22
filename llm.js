// ─── LLM Client ──────────────────────────────────────────────
// Provider-agnostic: works with Ollama, OpenAI, Groq, Mistral,
// LM Studio, Azure, Anthropic, Gemini, OpenRouter, KiloKode,
// or any OpenAI-compatible endpoint.
// Accepts optional per-request config overrides for multi-user support.

const config = require('./config');

// ─── Provider presets ────────────────────────────────────────
// Each preset defines defaults for url, apiType, and common models.
const PROVIDERS = {
  ollama:      { label: 'Ollama (Local)',           apiType: 'ollama',    url: 'http://localhost:11434',                         models: ['llama3.2:3b', 'llama3:8b', 'mistral', 'gemma2'] },
  lmstudio:    { label: 'LM Studio (Local)',        apiType: 'openai',    url: 'http://localhost:1234/v1',                       models: ['local-model'] },
  openai:      { label: 'OpenAI',                   apiType: 'openai',    url: 'https://api.openai.com/v1',                     models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  azure:       { label: 'Azure OpenAI',             apiType: 'openai',    url: '',                                               models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4'], urlPlaceholder: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>/v1' },
  anthropic:   { label: 'Anthropic',                apiType: 'anthropic', url: 'https://api.anthropic.com',                     models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'] },
  gemini:      { label: 'Google Gemini',            apiType: 'gemini',    url: 'https://generativelanguage.googleapis.com',      models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'] },
  openrouter:  { label: 'OpenRouter',               apiType: 'openai',    url: 'https://openrouter.ai/api/v1',                  models: ['meta-llama/llama-3-70b-instruct', 'google/gemini-flash-1.5', 'anthropic/claude-3-haiku'] },
  groq:        { label: 'Groq',                     apiType: 'openai',    url: 'https://api.groq.com/openai/v1',                models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
  mistral:     { label: 'Mistral AI',               apiType: 'openai',    url: 'https://api.mistral.ai/v1',                     models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'] },
  kilokode:    { label: 'KiloKode',                 apiType: 'openai',    url: 'https://api.kilokode.com/v1',                   models: [] },
  custom:      { label: 'Custom (OpenAI-compatible)', apiType: 'openai',  url: '',                                               models: [], urlPlaceholder: 'https://your-api-endpoint.com/v1' },
};

class LLM {
  // Resolve effective LLM settings: per-request override → global config fallback
  _resolve(overrides) {
    const o = overrides || {};
    const provider = o.provider || config.provider || 'ollama';
    const preset   = PROVIDERS[provider] || PROVIDERS.custom;
    return {
      provider,
      apiType:     preset.apiType,
      url:         o.llmUrl    || config.llmUrl    || preset.url,
      model:       o.llmModel  || config.llmModel  || (preset.models[0] || ''),
      apiKey:      o.llmApiKey || config.llmApiKey  || '',
      temperature: o.temperature ?? config.llmTemperature,
      maxTokens:   o.maxTokens   ?? config.llmMaxTokens,
    };
  }

  // ── Send a chat completion request ────────────────────────
  // Returns the assistant message text.
  // `overrides` may contain { provider, llmUrl, llmModel, llmApiKey }
  async chat(messages, { temperature, maxTokens, json = false, overrides } = {}) {
    const cfg = this._resolve(overrides);
    const temp = temperature ?? cfg.temperature;
    const max  = maxTokens   ?? cfg.maxTokens;

    if (cfg.apiType === 'ollama') {
      return this._ollama(cfg, messages, temp, max, json);
    }
    if (cfg.apiType === 'anthropic') {
      return this._anthropic(cfg, messages, temp, max, json);
    }
    if (cfg.apiType === 'gemini') {
      return this._gemini(cfg, messages, temp, max, json);
    }
    return this._openai(cfg, messages, temp, max, json);
  }

  // ── Ollama native API ────────────────────────────────────
  async _ollama(cfg, messages, temperature, maxTokens, json) {
    const url = `${cfg.url}/api/chat`;
    const body = {
      model: cfg.model,
      messages,
      stream: false,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };
    if (json) body.format = 'json';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.message?.content || '';
  }

  // ── OpenAI-compatible API ────────────────────────────────
  async _openai(cfg, messages, temperature, maxTokens, json) {
    const url = `${cfg.url}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }

    const body = {
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // ── Anthropic native API ─────────────────────────────────
  async _anthropic(cfg, messages, temperature, maxTokens, json) {
    const url = `${cfg.url}/v1/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    };

    // Separate system message from user/assistant messages
    let system = '';
    const filtered = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system += (system ? '\n' : '') + m.content;
      } else {
        filtered.push(m);
      }
    }

    const body = {
      model: cfg.model,
      max_tokens: maxTokens || 2048,
      temperature,
      messages: filtered,
    };
    if (system) body.system = system;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  // ── Google Gemini API ────────────────────────────────────
  async _gemini(cfg, messages, temperature, maxTokens, json) {
    const url = `${cfg.url}/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;

    // Convert OpenAI-style messages to Gemini format
    let systemInstruction = '';
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemInstruction += (systemInstruction ? '\n' : '') + m.content;
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
      }
    }

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (json) {
      body.generationConfig.responseMimeType = 'application/json';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // ── Convenience: ask for JSON and parse it ───────────────
  async chatJSON(messages, opts = {}) {
    const raw = await this.chat(messages, { ...opts, json: true });
    try {
      // Some models wrap JSON in markdown code blocks
      const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      return JSON.parse(cleaned);
    } catch (e) {
      console.error('[LLM] Failed to parse JSON response:', raw.slice(0, 300));
      throw new Error('LLM returned invalid JSON');
    }
  }

  // ── Health check / test connection ────────────────────────
  async ping(overrides) {
    const cfg = this._resolve(overrides);
    try {
      if (cfg.apiType === 'ollama') {
        const res = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        return { ok: true, provider: 'ollama', models: data.models?.map(m => m.name) || [] };
      } else if (cfg.apiType === 'anthropic') {
        // Anthropic doesn't have a models list endpoint; do a lightweight check
        const res = await fetch(`${cfg.url}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(10000),
        });
        return { ok: res.ok, provider: 'anthropic', status: res.status };
      } else if (cfg.apiType === 'gemini') {
        const res = await fetch(`${cfg.url}/v1beta/models?key=${cfg.apiKey}`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        const models = data.models?.map(m => m.name?.replace('models/', '')) || [];
        return { ok: res.ok, provider: 'gemini', models };
      } else {
        const res = await fetch(`${cfg.url}/models`, {
          headers: cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        return { ok: res.ok, provider: 'openai-compatible', status: res.status };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = new LLM();
module.exports.PROVIDERS = PROVIDERS;
