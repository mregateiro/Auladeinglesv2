// ─── Configuration ─────────────────────────────────────────
// LLM provider config. Supports any OpenAI-compatible API.
//
// EXAMPLES:
//   Ollama local:           PROVIDER=ollama  LLM_URL=http://localhost:11434  LLM_MODEL=llama3
//   Ollama on desktop:      PROVIDER=ollama  LLM_URL=http://192.168.1.50:11434  LLM_MODEL=llama3
//   OpenAI:                 PROVIDER=openai  LLM_API_KEY=sk-...  LLM_MODEL=gpt-4o-mini
//   Groq:                   PROVIDER=openai  LLM_URL=https://api.groq.com/openai/v1  LLM_API_KEY=gsk-...  LLM_MODEL=llama-3.3-70b-versatile
//   Mistral:                PROVIDER=openai  LLM_URL=https://api.mistral.ai/v1  LLM_API_KEY=...  LLM_MODEL=mistral-small-latest
//   LM Studio local:        PROVIDER=openai  LLM_URL=http://localhost:1234/v1  LLM_MODEL=local-model
//   Anthropic (via proxy):  PROVIDER=openai  LLM_URL=https://anthropic-openai-proxy.example.com/v1  LLM_API_KEY=sk-ant-...
//
// Set via environment variables, .env file, or edit defaults below.

const config = {
  // ── Server ──
  port: int(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || null,  // null = auto (./data/learn.json)
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'aula_session',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  // ── LLM Provider ──
  provider: process.env.PROVIDER || 'ollama',          // 'ollama' | 'openai'
  llmUrl:   process.env.LLM_URL  || 'http://localhost:11434',
  llmModel: process.env.LLM_MODEL || 'llama3.2:3b',
  llmApiKey: process.env.LLM_API_KEY || '',

  // ── Authentication ──
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // ── LLM Tuning ──
  llmTemperature: float(process.env.LLM_TEMPERATURE, 0.7),
  llmMaxTokens:   int(process.env.LLM_MAX_TOKENS, 2048),

  // ── Content ──
  contentLanguage: process.env.CONTENT_LANG || 'pt',   // UI language (pt, en, es…)
};

function int(v, d)   { const n = parseInt(v, 10); return isNaN(n) ? d : n; }
function float(v, d) { const n = parseFloat(v);   return isNaN(n) ? d : n; }
function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

module.exports = config;
