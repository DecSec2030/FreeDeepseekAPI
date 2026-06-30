const { FORGETMEAI_WATERMARK } = require('./config');

const ERROR_CODES = {
  AUTH_EXPIRED: { status: 401, message: 'DeepSeek token истёк. Обнови через env vars (DEEPSEEK_TOKEN, DEEPSEEK_COOKIE) или запусти npm run auth.' },
  ACCOUNT_BANNED: { status: 403, message: 'Аккаунт заблокирован или rate-limited. Попробуй другой аккаунт или подожди.' },
  CIRCUIT_OPEN: { status: 503, message: 'Аккаунт временно недоступен (слишком много ошибок). Повтори через минуту.' },
  RATE_LIMIT: { status: 429, message: 'Слишком много одновременных запросов на аккаунт. Уменьши MAX_CONCURRENT_PER_ACCOUNT или добавь больше аккаунтов.' },
  DEEPSEEK_ERROR: { status: 502, message: 'DeepSeek API вернул ошибку. Повтори запрос позже.' },
  SESSION_RESET: { status: 200, message: 'Сессия сброшена из-за глубины диалога. Продолжай normally.' },
  INVALID_MODEL: { status: 400, message: 'Неизвестная модель. Список: GET /v1/models' },
  UNSUPPORTED_MODEL: { status: 400, message: 'Модель не поддерживается через этот прокси.' },
  EMPTY_RESPONSE: { status: 502, message: 'DeepSeek вернул пустой ответ после нескольких попыток.' },
  POW_FAILED: { status: 502, message: 'PoW challenge не пройден. Обнови auth.' },
  SERVER_ERROR: { status: 500, message: 'Внутренняя ошибка сервера.' },
};

class AppError extends Error {
  constructor(code, details = {}, original = null) {
    const def = ERROR_CODES[code] || ERROR_CODES.SERVER_ERROR;
    super(details.message || def.message);
    this.code = code;
    this.status = details.status || def.status;
    this.details = details;
    this.original = original;
  }
}

function formatErrorResponse(err, _req = {}) {
  const code = err.code || 'SERVER_ERROR';
  const def = ERROR_CODES[code] || ERROR_CODES.SERVER_ERROR;
  const status = err.status || def.status;
  const message = err.message || def.message;
  const body = {
    error: {
      code,
      message,
      type: code.toLowerCase(),
    },
    watermark: FORGETMEAI_WATERMARK,
  };
  if (err.details?.retryAfter) body.error.retry_after = err.details.retryAfter;
  if (err.details?.model) body.error.model = err.details.model;
  if (err.details?.agentId) body.error.agent = err.details.agentId;
  return { status, body };
}

module.exports = { AppError, ERROR_CODES, formatErrorResponse };
