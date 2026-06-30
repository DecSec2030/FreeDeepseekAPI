# FreeDeepseekAPI

OpenAI-совместимый прокси-сервер для DeepSeek Web Chat. Позволяет использовать DeepSeek через любой OpenAI-клиент.

## Возможности

- OpenAI Chat Completions API (`/v1/chat/completions`)
- Anthropic Messages API (`/v1/messages`) — для Claude Code
- OpenAI Responses API (`/v1/responses`)
- Streaming (SSE) и non-streaming режимы
- Tool calling (парсинг TOOL_CALL: и XML из ответа DeepSeek)
- Multi-account (round-robin, circuit breaker, лимиты)
- Per-agent сессии (изоляция контекста)
- Персистентность истории (при перезапуске)
- Prometheus-метрики (`GET /metrics`)
- SIGHUP reload конфига без рестарта

## Установка

```bash
git clone https://github.com/DecSec2030/FreeDeepseekAPI.git
cd FreeDeepseekAPI
```

Зависимости: только Node.js (22+). Никаких npm-пакетов не требуется.

## Настройка

### Получение DeepSeek auth

1. Открой https://chat.deepseek.com в браузере
2. Открой Инструменты разработчика → Application → Local Storage
3. Скопируй `userToken` и cookie `smidV2`
4. Создай файл `deepseek-auth.json`:

```json
{
  "token": "твой_userToken",
  "cookie": "smidV2=твоя_cookie"
}
```

Либо используй встроенный импорт: запусти сервер и выбери пункт 2.

### Альтернатива: экспорт cookie через Firefox (для Termux)

```bash
termux-open-url https://chat.deepseek.com
# Войди в аккаунт, затем экспортируй cookies в формате JSON
# Импорт:
node scripts/auth_import.js --input cookies.json
```

## Запуск

### На ПК

```bash
cd FreeDeepseekAPI
echo "4" | node server.js
```

### На Termux (Android)

```bash
cd FreeDeepseekAPI
echo "4" | nohup node server.js > ds-server.log 2>&1 &
```

Сервер будет доступен на `http://localhost:9655`.

### Фоновый запуск (с авто-выбором пункта 4)

```bash
echo "4" | nohup node server.js > ds-server.log 2>&1 &
```

### Перезапуск

```bash
pkill -f "node server.js"
sleep 3
echo "4" | nohup node server.js > ds-server.log 2>&1 &
```

## Использование

### OpenAI Chat Completions

```bash
curl http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### OpenCode CLI

Настрой провайдер в `~/.config/opencode/opencode.jsonc`:

```json
{
  "providers": {
    "deepseek-local": {
      "package": "@ai-sdk/openai-compatible",
      "url": "http://localhost:9655/v1",
      "models": {
        "deepseek-chat": {},
        "deepseek-reasoner": {},
        "deepseek-v4-flash": {},
        "deepseek-v4-flash-reasoner": {},
        "deepseek-v4-pro": {},
        "deepseek-expert": {}
      }
    }
  }
}
```

Запуск:

```bash
opencode --provider deepseek-local --model deepseek-v4-flash
```

Внутри OpenCode можно переключать модель через `/model`.

### Anthropic Messages (для Claude Code)

```bash
curl http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Модели

| ID | Описание |
|---|---|
| `deepseek-v4-flash` | Быстрая модель (по умолчанию) |
| `deepseek-v4-flash-reasoner` | Быстрая + режим рассуждений |
| `deepseek-v4-flash-search` | Быстрая + веб-поиск |
| `deepseek-v4-flash-reasoner-search` | Быстрая + рассуждения + поиск |
| `deepseek-expert` | Экспертная модель (ограниченные ресурсы) |
| `deepseek-v4-pro` | Экспертная + рассуждения |
| `deepseek-v3` | Алиас для быстрой модели |
| `deepseek-r1` | Алиас для быстрой + рассуждения |

**Депрекейтед** (работают, но удалятся 2026-07-24):
- `deepseek-chat` → используй `deepseek-v4-flash`
- `deepseek-reasoner` → используй `deepseek-v4-flash-reasoner`

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | 9655 | Порт сервера |
| `HOST` | 0.0.0.0 | Хост |
| `LOG_LEVEL` | INFO | Фильтр логов (DEBUG/INFO/WARN/ERROR) |
| `LOG_FORMAT` | text | Формат логов (text/json) |
| `SESSION_TTL_MINUTES` | 120 | Время жизни сессии DeepSeek |
| `MAX_MESSAGE_DEPTH` | 100 | Макс. сообщений до автосброса сессии |
| `MAX_CONCURRENT_PER_ACCOUNT` | 3 | Макс. одновременных запросов на аккаунт |
| `CIRCUIT_BREAKER_FAILURES` | 3 | Ошибок до circuit breaker |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | 300000 | Время остывания circuit breaker |
| `SESSION_STORE_PATH` | sessions.json | Путь к файлу сессий |
| `DEEPSEEK_AUTH_PATH` | deepseek-auth.json | Путь к файлу auth |
| `NON_INTERACTIVE` | — | Пропустить меню при запуске |
| `SKIP_ACCOUNT_MENU` | — | Пропустить меню при запуске |

## API endpoints

| Метод | Путь | Описание |
|---|---|---|
| GET | `/` | Health check |
| GET | `/health` | Health check |
| GET | `/v1/models` | Список моделей |
| GET | `/v1/model-capabilities` | Полное описание моделей |
| GET | `/metrics` | Prometheus-метрики |
| GET | `/v1/sessions` | Список активных сессий |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/reset-session?agent=<id>` | Сброс сессии агента |
| POST | `/reset-session?agent=all` | Сброс всех сессий |

## Tool calling

Прокси поддерживает вызов инструментов (tools/functions) через DeepSeek Web Chat.

Как это работает:
1. OpenAI-клиент шлёт `tools` в запросе
2. Прокси преобразует tools в текстовые инструкции в system prompt
3. DeepSeek отвечает с `TOOL_CALL:` или `<tool_call>` XML
4. Прокси парсит ответ и возвращает корректный `tool_calls` в OpenAI-формате

**Важно:** DeepSeek Web Chat — текстовая модель, она не гарантирует тулколлы. Срабатывает ~50-70% запросов.

## Структура проекта

```
FreeDeepseekAPI/
├── server.js          # Точка входа
├── lib/               # Модули
│   ├── logger.js      # Логирование
│   ├── config.js      # Константы и настройки
│   ├── auth.js        # Аккаунты и авторизация
│   ├── pow.js         # PoW (WASM solver)
│   ├── parse.js       # Парсинг tool calls и ответов
│   ├── history.js     # Сессии и персистентность
│   └── http.js        # SSE-стримеры
├── scripts/           # Вспомогательные скрипты
├── tests/             # Тесты
│   ├── unit.test.js   # Юнит-тесты
│   └── smoke.sh       # Smoke-тест
└── deepseek-auth.json # Конфиг авторизации
```

## Тестирование

```bash
node tests/unit.test.js
bash tests/smoke.sh
```

## Решение проблем

### EADDRINUSE — порт занят

```bash
fuser -k 9655/tcp
# или
pkill -f "node server.js"
sleep 3
# затем запусти снова
```

### Auth expired / 401

```bash
# Обнови auth-данные через меню (пункт 1) или:
node scripts/deepseek_chrome_auth.js
```

### Пустой ответ от DeepSeek

Прокси автоматически делает до 3 повторных попыток со сбросом сессии. Если не помогает — проблема на стороне DeepSeek.
