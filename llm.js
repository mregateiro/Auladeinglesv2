// ─── LLM Client ──────────────────────────────────────────────
// Provider-agnostic: works with Ollama, OpenAI, Groq, Mistral,
// LM Studio, or any OpenAI-compatible endpoint.

const config = require('./config');

class LLM {
  // ── Send a chat completion request ────────────────────────
  // Returns the assistant message text.
  async chat(messages, { temperature, maxTokens, json = false } = {}) {
    const temp = temperature ?? config.llmTemperature;
    const max  = maxTokens   ?? config.llmMaxTokens;

    if (config.provider === 'ollama') {
      return this._ollama(messages, temp, max, json);
    }
    return this._openai(messages, temp, max, json);
  }

  // ── Ollama native API ────────────────────────────────────
  async _ollama(messages, temperature, maxTokens, json) {
    const url = `${config.llmUrl}/api/chat`;
    const body = {
      model: config.llmModel,
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
  async _openai(messages, temperature, maxTokens, json) {
    const url = `${config.llmUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.llmApiKey) {
      headers['Authorization'] = `Bearer ${config.llmApiKey}`;
    }

    const body = {
      model: config.llmModel,
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

  // ── Health check ─────────────────────────────────────────
  async ping() {
    try {
      if (config.provider === 'ollama') {
        const res = await fetch(`${config.llmUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        return { ok: true, provider: 'ollama', models: data.models?.map(m => m.name) || [] };
      } else {
        const res = await fetch(`${config.llmUrl}/models`, {
          headers: config.llmApiKey ? { 'Authorization': `Bearer ${config.llmApiKey}` } : {},
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
