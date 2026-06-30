const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const config = require('./config');

const accounts = [];
let accountRoundRobin = 0;

function buildBaseHeaders(accountConfig) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Android 15; Mobile; rv:152.0) Gecko/152.0 Firefox/152.0',
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'ru',
    'x-client-timezone-offset': '10800',
    'x-app-version': '2.0.0',
    'Authorization': `Bearer ${accountConfig.token || ''}`,
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'Cookie': accountConfig.cookie || '',
    'Content-Type': 'application/json',
    'Connection': 'keep-alive',
  };
  if (accountConfig.hif_dliq) headers['x-hif-dliq'] = accountConfig.hif_dliq;
  if (accountConfig.hif_leim) headers['x-hif-leim'] = accountConfig.hif_leim;
  return headers;
}

function discoverAuthPaths() {
  if (process.env.DEEPSEEK_AUTH_DIR) {
    try {
      return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
    } catch (e) {
      logger.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
      return [];
    }
  }
  if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
    return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [config.DS_CONFIG_PATH];
}

function loadDeepSeekConfig({ fatal = true } = {}) {
  accounts.length = 0;

  // Env vars take priority over file
  const envToken = process.env.DEEPSEEK_TOKEN;
  const envCookie = process.env.DEEPSEEK_COOKIE;
  if (envToken && envCookie) {
    const id = 'account_env';
    const cfg = { token: envToken, cookie: envCookie };
    if (process.env.DEEPSEEK_HIF_DLIQ) cfg.hif_dliq = process.env.DEEPSEEK_HIF_DLIQ;
    if (process.env.DEEPSEEK_HIF_LEIM) cfg.hif_leim = process.env.DEEPSEEK_HIF_LEIM;
    if (process.env.DEEPSEEK_WASM_URL) cfg.wasmUrl = process.env.DEEPSEEK_WASM_URL;
    accounts.push({ id, file: '(env)', config: cfg, headers: buildBaseHeaders(cfg), cooldownUntil: 0, failures: 0, consecutiveFailures: 0, lastUsedAt: 0, concurrentRequests: 0 });
    logger.info(`[DS-API] Loaded auth from env vars (account: ${id})`);
    return true;
  }

  const paths = discoverAuthPaths();
  for (const file of paths) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const cfg = JSON.parse(raw);
      const id = `account_${accounts.length + 1}`;
      accounts.push({ id, file, config: cfg, headers: buildBaseHeaders(cfg), cooldownUntil: 0, failures: 0, consecutiveFailures: 0, lastUsedAt: 0, concurrentRequests: 0 });
    } catch (e) {
      logger.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
    }
  }
  if (accounts.length > 0) {
    logger.info(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
    return true;
  }
  if (fatal) {
    logger.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || config.DS_CONFIG_PATH}`);
    process.exit(1);
  }
  return false;
}

function hasAuthConfig() {
  return accounts.some(a => a.config.token && a.config.cookie);
}

function accountStatus(account) {
  return {
    id: account.id,
    ready: !!(account.config.token && account.config.cookie),
    cooldown: account.cooldownUntil > Date.now(),
    cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
    failures: account.failures,
    consecutive_failures: account.consecutiveFailures || 0,
    concurrent_requests: account.concurrentRequests || 0,
    last_used_at: account.lastUsedAt || null,
  };
}

function parseRetryAfterMs(retryAfterRaw) {
  if (!retryAfterRaw) return null;
  const raw = String(retryAfterRaw).trim();
  if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
  return null;
}

function markAccountFailure(account, status, reason = '', retryAfterRaw = null) {
  if (!account) return;
  account.failures = (account.failures || 0) + 1;
  account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
  if ([401, 403, 429].includes(Number(status))) {
    const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
    const cooldownMs = retryMs != null ? retryMs : config.DEFAULT_ACCOUNT_COOLDOWN_MS;
    account.cooldownUntil = Date.now() + cooldownMs;
    logger.info(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
  } else if (account.consecutiveFailures >= config.CIRCUIT_BREAKER_THRESHOLD) {
    account.cooldownUntil = Date.now() + config.CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn(`[account:${account.id}] circuit breaker: ${account.consecutiveFailures} consecutive failures, cooldown ${Math.round(config.CIRCUIT_BREAKER_COOLDOWN_MS / 1000)}s (last: HTTP ${status}${reason ? ` ${reason}` : ''})`);
  }
}

function markAccountSuccess(account) {
  if (!account) account.consecutiveFailures = 0;
}

function selectAccountForSession(session) {
  const now = Date.now();
  if (session.accountId) {
    const sticky = accounts.find(a => a.id === session.accountId);
    if (sticky && sticky.config.token && sticky.config.cookie && sticky.cooldownUntil <= now && sticky.concurrentRequests < config.MAX_CONCURRENT_PER_ACCOUNT) return sticky;
    if (sticky && sticky.cooldownUntil > now) {
      session.id = null;
      session.parentMessageId = null;
      session.createdAt = null;
      session.messageCount = 0;
    }
    session.accountId = null;
  }
  const ready = accounts.filter(a =>
    a.config.token && a.config.cookie && a.cooldownUntil <= now &&
    a.concurrentRequests < config.MAX_CONCURRENT_PER_ACCOUNT
  );
  if (ready.length === 0) {
    const busy = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
    if (busy.length > 0) {
      throw new Error(`All DeepSeek auth accounts are at max concurrency (${config.MAX_CONCURRENT_PER_ACCOUNT}). Try again later.`);
    }
    const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    if (waiting) {
      const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
      throw new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
    }
    throw new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
  }
  const account = ready[accountRoundRobin % ready.length];
  accountRoundRobin++;
  account.concurrentRequests++;
  session.accountId = account.id;
  return account;
}

async function readDeepSeekJsonResponse(resp, label, account) {
  const text = await resp.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); }
    catch (e) {
      markAccountFailure(account, resp.status, label);
      throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
    }
  }
  if (!resp.ok) markAccountFailure(account, resp.status, label);
  return { json, text };
}

// hif_leim
let _hifCache = null;
const HIF_CACHE_TTL = 60000;

async function fetchHifLeimForAccount(account, forceRefresh = false) {
  if (!account.config.cookie) return null;
  if (!forceRefresh && _hifCache && _hifCache.expires > Date.now() && _hifCache.accountId === account.id) {
    return _hifCache.value;
  }
  try {
    const resp = await fetch('https://hif-leim.deepseek.com/query', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Android 15; Mobile; rv:152.0) Gecko/152.0 Firefox/152.0',
        'Accept': '*/*',
        'Origin': 'https://chat.deepseek.com',
        'Referer': 'https://chat.deepseek.com/',
        'Cookie': account.config.cookie,
      }
    });
    const data = await resp.json();
    const value = data?.data?.biz_data?.value;
    if (value) {
      _hifCache = { value, accountId: account.id, expires: Date.now() + HIF_CACHE_TTL };
      return value;
    }
  } catch (e) {
    logger.warn(`[${account.id}] Failed to fetch hif_leim: ${e.message}`);
  }
  return null;
}

function buildHeadersWithHif(account, hifLeim) {
  const h = buildBaseHeaders(account.config);
  if (hifLeim) h['x-hif-leim'] = hifLeim;
  return h;
}

async function refreshAllHifLeim(forceRefresh = true) {
  if (accounts.length === 0) return;
  logger.info(`[HIF] Refreshing hif_leim for ${accounts.length} account(s)...`);
  for (const account of accounts) {
    const value = await fetchHifLeimForAccount(account, forceRefresh);
    if (value) {
      account.config.hif_leim = value;
      account.headers = buildBaseHeaders(account.config);
      logger.info(`[${account.id}] hif_leim refreshed`);
    }
  }
}

let lastAuthRefresh = 0;
const AUTH_REFRESH_INTERVAL = 55 * 60 * 1000;

async function autoRefreshAuth(force) {
  const now = Date.now();
  if (!force && (now - lastAuthRefresh) < AUTH_REFRESH_INTERVAL) return true;
  logger.info('[Auth] Auto-refreshing auth...');
  const ok = await runAuthScript();
  if (ok) { lastAuthRefresh = now; logger.info('[Auth] Refresh OK'); }
  else { logger.error('[Auth] Refresh FAILED'); }
  await refreshAllHifLeim();
  return ok;
}

async function runAuthScript() {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'deepseek_chrome_auth.js');
  try {
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env, timeout: 30000 });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
  } catch (e) {
    logger.error('[Auth] Script error:', e.message);
    return false;
  }
}

module.exports = {
  accounts,
  buildBaseHeaders,
  discoverAuthPaths,
  loadDeepSeekConfig,
  hasAuthConfig,
  accountStatus,
  parseRetryAfterMs,
  markAccountFailure,
  markAccountSuccess,
  selectAccountForSession,
  readDeepSeekJsonResponse,
  fetchHifLeimForAccount,
  buildHeadersWithHif,
  refreshAllHifLeim,
  autoRefreshAuth,
  runAuthScript,
  get _hifCache() { return _hifCache; },
  set _hifCache(v) { _hifCache = v; },
};
