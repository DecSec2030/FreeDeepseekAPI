const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT || 9655),
  HOST: process.env.HOST || '0.0.0.0',
  MAX_HISTORY_LENGTH: 15,
  MAX_HISTORY_CHARS: 10000,
  MAX_MESSAGE_DEPTH: Number(process.env.MAX_MESSAGE_DEPTH) || 100,
  SESSION_TTL_MS: (Number(process.env.SESSION_TTL_MINUTES) || 120) * 60 * 1000,
  SESSION_CLEANUP_INTERVAL_MS: 300000,
  CIRCUIT_BREAKER_THRESHOLD: Number(process.env.CIRCUIT_BREAKER_FAILURES) || 3,
  CIRCUIT_BREAKER_COOLDOWN_MS: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || 5 * 60 * 1000),
  MAX_CONCURRENT_PER_ACCOUNT: Number(process.env.MAX_CONCURRENT_PER_ACCOUNT) || 3,
  DEFAULT_ACCOUNT_COOLDOWN_MS: Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000),
  SESSION_STORE_PATH: process.env.SESSION_STORE_PATH || path.join(__dirname, '..', 'sessions.json'),
  DS_CONFIG_PATH: process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json'),
  FORGETMEAI_WATERMARK: 't.me/forgetmeai',
  AUTH_REFRESH_INTERVAL: 55 * 60 * 1000,
  MAX_RETRIES: Number(process.env.MAX_RETRIES) || 3,
  FORMAT_WATERMARK_CHAR: () => '─'.repeat(process.stdout.columns > 50 ? process.stdout.columns - 2 : 50),
  formatWatermark: (prefix = 'ForgetMeAI') => `${prefix}: t.me/forgetmeai`,
  SERVER_HOST: require('os').hostname(),
  SERVER_PUBLIC_IP: (() => {
    try {
      const interfaces = require('os').networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
      }
    } catch (_e) {}
    return 'localhost';
  })(),
  MODEL_CONFIGS: {
    'deepseek-chat': { model_type: 'default', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek-V4-Flash non-thinking (DEPRECATED, use deepseek-v4-flash)', capabilities: { reasoning: false, web_search: false, files: true }, supported: true, deprecated_since: '2026-06-24' },
    'deepseek-v4-flash': { model_type: 'default', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek-V4-Flash non-thinking', capabilities: { reasoning: false, web_search: false, files: true }, supported: true },
    'deepseek-v4-flash-reasoner': { model_type: 'default', thinking_enabled: true, search_enabled: false, real_model: 'DeepSeek-V4-Flash thinking mode', capabilities: { reasoning: true, web_search: false, files: true }, supported: true },
    'deepseek-v3': { model_type: 'default', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web "Быстрый" / default)', capabilities: { reasoning: false, web_search: false, files: true }, supported: true },
    'deepseek-default': { model_type: 'default', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web "Быстрый" / default)', capabilities: { reasoning: false, web_search: false, files: true }, supported: true },
    'deepseek-reasoner': { model_type: 'default', thinking_enabled: true, search_enabled: false, real_model: 'DeepSeek-V4-Flash thinking mode (DEPRECATED, use deepseek-v4-flash-reasoner)', capabilities: { reasoning: true, web_search: false, files: true }, supported: true, deprecated_since: '2026-06-24' },
    'deepseek-r1': { model_type: 'default', thinking_enabled: true, search_enabled: false, real_model: 'DeepSeek-V4-Flash thinking mode; R1-compatible alias', capabilities: { reasoning: true, web_search: false, files: true }, supported: true },
    'deepseek-chat-search': { model_type: 'default', thinking_enabled: false, search_enabled: true, real_model: 'DeepSeek-V4-Flash non-thinking + web search (DEPRECATED)', capabilities: { reasoning: false, web_search: true, files: true }, supported: true, deprecated_since: '2026-06-24' },
    'deepseek-v4-flash-search': { model_type: 'default', thinking_enabled: false, search_enabled: true, real_model: 'DeepSeek-V4-Flash non-thinking + web search', capabilities: { reasoning: false, web_search: true, files: true }, supported: true },
    'deepseek-default-search': { model_type: 'default', thinking_enabled: false, search_enabled: true, real_model: 'DeepSeek-V4-Flash non-thinking + web search', capabilities: { reasoning: false, web_search: true, files: true }, supported: true },
    'deepseek-reasoner-search': { model_type: 'default', thinking_enabled: true, search_enabled: true, real_model: 'DeepSeek-V4-Flash thinking + web search (DEPRECATED)', capabilities: { reasoning: true, web_search: true, files: true }, supported: true, deprecated_since: '2026-06-24' },
    'deepseek-v4-flash-reasoner-search': { model_type: 'default', thinking_enabled: true, search_enabled: true, real_model: 'DeepSeek-V4-Flash thinking + web search', capabilities: { reasoning: true, web_search: true, files: true }, supported: true },
    'deepseek-r1-search': { model_type: 'default', thinking_enabled: true, search_enabled: true, real_model: 'DeepSeek-V4-Flash thinking mode + web search; R1-compatible alias', capabilities: { reasoning: true, web_search: true, files: true }, supported: true },
    'deepseek-expert': { model_type: 'expert', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek Web "Эксперт"', capabilities: { reasoning: false, web_search: false, files: false }, supported: true },
    'deepseek-v4-pro': { model_type: 'expert', thinking_enabled: true, search_enabled: false, real_model: 'DeepSeek Web "Эксперт" + thinking mode', capabilities: { reasoning: true, web_search: false, files: false }, supported: true },
    'deepseek-expert-search': { model_type: 'expert', thinking_enabled: false, search_enabled: true, real_model: 'DeepSeek Web "Эксперт" + search', capabilities: { reasoning: false, web_search: false, files: false }, supported: false, unavailable_reason: 'Expert search unavailable' },
    'deepseek-vision': { model_type: 'vision', thinking_enabled: false, search_enabled: false, real_model: 'DeepSeek Web vision beta', capabilities: { reasoning: false, web_search: false, files: true, vision: true }, supported: false, unavailable_reason: 'Vision temporarily unavailable' },
  },
  SUPPORTED_MODEL_IDS: null,
  ALL_MODEL_CAPABILITIES: null,
};

const mc = module.exports;
mc.SUPPORTED_MODEL_IDS = Object.keys(mc.MODEL_CONFIGS).filter(id => mc.MODEL_CONFIGS[id].supported);
mc.ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(mc.MODEL_CONFIGS).map(([id, cfg]) => [id, {
  id, real_model: cfg.real_model, model_type: cfg.model_type,
  thinking_enabled: cfg.thinking_enabled, search_enabled: cfg.search_enabled,
  capabilities: cfg.capabilities, supported: cfg.supported,
  unavailable_reason: cfg.unavailable_reason || null,
}]));
