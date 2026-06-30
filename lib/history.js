const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { SESSION_STORE_PATH, MAX_HISTORY_LENGTH, MAX_HISTORY_CHARS } = require('./config');

const sessions = new Map();
const _agentQueues = new Map();

function createSession() {
  return { id: null, parentMessageId: null, createdAt: null, lastUsedAt: null, messageCount: 0, accountId: null, history: [] };
}

function getOrCreateAgentSession(agentId) {
  if (!sessions.has(agentId)) sessions.set(agentId, createSession());
  return sessions.get(agentId);
}

function runSerialized(agentId, fn) {
  const prev = _agentQueues.get(agentId) || Promise.resolve();
  const next = prev.then(() => fn());
  _agentQueues.set(agentId, next.catch(() => {}));
  return next;
}

function storeHistory(agentId, prompt, content, toolCall) {
  const session = getOrCreateAgentSession(agentId);
  const calls = toolCall ? (Array.isArray(toolCall) ? toolCall : [toolCall]) : [];
  const assistantResponse = calls.length > 0
    ? calls.map(tc => `TOOL_CALL: ${tc.name}\narguments: ${tc.arguments}`).join('\n')
    : content;
  const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
  session.history.push({ user: shortPrompt, assistant: assistantResponse });
  while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
  let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
  while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
    const removed = session.history.shift();
    historyChars -= removed.user.length + removed.assistant.length;
  }
  saveSessions();
}

function saveSessions() {
  try {
    const dir = path.dirname(SESSION_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {};
    for (const [agentId, s] of sessions) {
      data[agentId] = { history: s.history, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt };
    }
    fs.writeFileSync(SESSION_STORE_PATH + '.tmp', JSON.stringify(data), 'utf8');
    fs.renameSync(SESSION_STORE_PATH + '.tmp', SESSION_STORE_PATH);
  } catch (e) {
    logger.warn(`[Sessions] Save failed: ${e.message}`);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_STORE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_STORE_PATH, 'utf8'));
    for (const [agentId, s] of Object.entries(data)) {
      sessions.set(agentId, {
        id: null, parentMessageId: null, accountId: null, messageCount: 0,
        createdAt: s.createdAt || null, lastUsedAt: s.lastUsedAt || null,
        history: Array.isArray(s.history) ? s.history : [],
      });
    }
    if (Object.keys(data).length > 0) logger.info(`[Sessions] Loaded ${Object.keys(data).length} session(s) (histories only, session IDs reset)`);
  } catch (e) {
    logger.warn(`[Sessions] Load failed: ${e.message}`);
  }
}

module.exports = {
  sessions,
  _agentQueues,
  createSession,
  getOrCreateAgentSession,
  runSerialized,
  storeHistory,
  saveSessions,
  loadSessions,
};
