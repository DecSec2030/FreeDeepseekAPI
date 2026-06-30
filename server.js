#!/usr/bin/env node
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync, execSync } = require('child_process');

const { logger } = require('./lib/logger');
const config = require('./lib/config');
const { accounts, loadDeepSeekConfig, hasAuthConfig, accountStatus, markAccountFailure, markAccountSuccess, selectAccountForSession, readDeepSeekJsonResponse, fetchHifLeimForAccount, buildHeadersWithHif, refreshAllHifLeim, autoRefreshAuth } = require('./lib/auth');
const { createPOW } = require('./lib/pow');
const { formatToolDefinitions, parseToolCall, sanitizeContent, buildToolCallResponse, buildTextResponse, normalizeApiParams, toAnthropicResponse, toResponsesResponse, isDeepSeekModelErrorEvent, rebuildFragmentText, applyResponsePatchOperations, extractScreenshotPaths } = require('./lib/parse');
const { sessions, createSession, getOrCreateAgentSession, runSerialized, storeHistory, saveSessions, loadSessions } = require('./lib/history');
const { formatErrorResponse } = require('./lib/errors');
const { sendAnthropicStream, sendResponsesStream, sendOpenAIStream } = require('./lib/http');

process.on('unhandledRejection', (reason) => {
    logger.error('[FATAL] Unhandled Rejection:', reason instanceof Error ? reason.stack : String(reason));
});
process.on('uncaughtException', (err) => {
    logger.error('[FATAL] Uncaught Exception:', err.stack);
    process.exit(1);
});

const { MODEL_CONFIGS, SUPPORTED_MODEL_IDS, ALL_MODEL_CAPABILITIES, FORGETMEAI_WATERMARK } = config;
const metrics = { requests: 0, errors: 0, byModel: {}, byEndpoint: {}, byStatus: {}, startTime: Date.now() };

function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return (MODEL_CONFIGS[String(model || '').toLowerCase()] || {}).supported === true; }

function printBanner() {
    logger.info(`
███████ ██████  ███████ ███████ ██████  ███████ ███████ ███████ ██   ██
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
█████   ██████  █████   █████   ██   ██ █████   █████   █████   █████
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
██      ██   ██ ███████ ███████ ██████  ███████ ███████ ███████ ██   ██

   FreeDeepseekAPI — API-прокси для DeepSeek Web Chat
   ${config.formatWatermark()}
`);
}
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

async function askDeepSeekStream(promptText, agentId, model = 'deepseek-default', skipHif = false) {
    const modelCfg = resolveModelConfig(model);
    const session = getOrCreateAgentSession(agentId);
    const account = selectAccountForSession(session);
    try {
    const agentTag = `[${agentId}/acct:${account.id}]`;

    if (session.id && session.messageCount >= config.MAX_MESSAGE_DEPTH) {
        logger.info(`${agentTag} Session ${session.id} hit ${session.messageCount} messages. Auto-resetting.`);
        session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
    }
    if (session.id && session.createdAt && (Date.now() - session.createdAt > config.SESSION_TTL_MS)) {
        logger.info(`${agentTag} Session ${session.id} expired. Creating new...`);
        session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
    }

    const powB64 = await createPOW(account.headers, account.config.wasmUrl);

    if (!session.id) {
        const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: account.headers, body: '{}'
        });
        const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, 'session create', account);
        const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
        if (!sr.ok || !createdSessionId) {
            throw new Error(`Could not create DeepSeek chat session (HTTP ${sr.status}). Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`);
        }
        session.id = createdSessionId; session.accountId = account.id; session.parentMessageId = null;
        session.createdAt = Date.now(); session.lastUsedAt = Date.now(); session.messageCount = 0;
        saveSessions();
        logger.info(`${agentTag} Created new session: ${session.id}`);
    } else {
        logger.info(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const localHifLeim = skipHif ? null : await fetchHifLeimForAccount(account);
    const compHeaders = buildHeadersWithHif(account, localHifLeim);
    compHeaders['X-DS-PoW-Response'] = powB64;

    async function doCompletion(sid, parentId) {
        return fetch('https://chat.deepseek.com/api/v0/chat/completion', {
            method: 'POST', headers: compHeaders,
            body: JSON.stringify({
                chat_session_id: sid, parent_message_id: parentId,
                model_type: modelCfg.model_type, prompt: promptText, ref_file_ids: [],
                thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
                action: null, preempt: false,
            })
        });
    }

    const resp = await doCompletion(session.id, session.parentMessageId);

    if (resp.status !== 200) {
        markAccountFailure(account, resp.status, 'completion', resp.headers.get('retry-after'));
        const errText = await resp.text();
        logger.info(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            logger.info(`${agentTag} Session ${session.id} expired. Creating new session...`);
            session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
            const sr2 = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: account.headers, body: '{}'
            });
            const { json: sessionData2, text: sessionText2 } = await readDeepSeekJsonResponse(sr2, 'session recreate', account);
            const createdSessionId2 = sessionData2?.data?.biz_data?.chat_session?.id || sessionData2?.data?.biz_data?.id;
            if (!sr2.ok || !createdSessionId2) {
                throw new Error(`Could not recreate DeepSeek chat session (HTTP ${sr2.status}). Run npm run doctor, then npm run auth. First chars: ${String(sessionText2 || '').substring(0, 120)}`);
            }
            session.id = createdSessionId2; session.accountId = account.id; session.parentMessageId = null;
            session.createdAt = Date.now(); session.lastUsedAt = Date.now();
            logger.info(`${agentTag} Created new session: ${session.id}`);
            saveSessions();
            const resp2 = await doCompletion(session.id, null);
            return { resp: resp2, agentId, account };
        } else {
            throw new Error(`DeepSeek API error (HTTP ${resp.status}): ${errText.substring(0, 200)}`);
        }
    }
    return { resp, agentId, account };
    } finally {
        account.concurrentRequests--;
    }
}

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-v4-flash').toLowerCase();
    const cfg = MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-v4-flash'];
    if (cfg && cfg.deprecated_since) {
        logger.warn(`[MODEL] "${requested}" is deprecated since ${cfg.deprecated_since}. Use deepseek-v4-flash or deepseek-v4-flash-reasoner instead.`);
    }
    return cfg;
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) systemPrompt += msg.content + '\n';
    }
    systemPrompt += formatToolDefinitions(tools);
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;
        if (msg.role === 'user' && msg.content) conversation += `User: ${msg.content}\n\n`;
        else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`;
            } else if (msg.content) conversation += `Assistant: ${msg.content}\n\n`;
        } else if (msg.role === 'tool' && msg.content) {
            const truncated = msg.content.length > 8000 ? msg.content.substring(0, 8000) + '\n...[truncated]' : msg.content;
            conversation += `[Tool Result]\n${truncated}\n\n`;
        }
    }
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

const rateLimitMap = new Map();
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const RATE_LIMIT = 30, RATE_WINDOW = 60000;
    let entry = rateLimitMap.get(ip);
    if (!entry || now - entry.windowStart > RATE_WINDOW) {
        entry = { count: 1, windowStart: now }; rateLimitMap.set(ip, entry);
    } else {
        entry.count++;
        if (entry.count > RATE_LIMIT) {
            metrics.errors++;
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil((entry.windowStart + RATE_WINDOW - now) / 1000) });
            res.end(JSON.stringify({ error: { message: 'Too many requests. Please slow down.', type: 'rate_limit', retry_after: Math.ceil((entry.windowStart + RATE_WINDOW - now) / 1000) } }));
            return;
        }
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const reqId = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
    res.setHeader('X-Request-ID', reqId);
    metrics.requests++;
    metrics.byEndpoint[url.pathname] = (metrics.byEndpoint[url.pathname] || 0) + 1;

    if (req.method === 'GET' && url.pathname === '/metrics') {
        const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
        const lines = [
            '# HELP freedeepseek_requests_total Total requests', '# TYPE freedeepseek_requests_total counter',
            `freedeepseek_requests_total ${metrics.requests}`,
            '# HELP freedeepseek_errors_total Total errors', '# TYPE freedeepseek_errors_total counter',
            `freedeepseek_errors_total ${metrics.errors}`,
            '# HELP freedeepseek_agents_active Active agent sessions', '# TYPE freedeepseek_agents_active gauge',
            `freedeepseek_agents_active ${sessions.size}`,
            '# HELP freedeepseek_accounts_total Total auth accounts', '# TYPE freedeepseek_accounts_total gauge',
            `freedeepseek_accounts_total ${accounts.length}`,
            '# HELP freedeepseek_accounts_ready Ready (non-cooldown) accounts', '# TYPE freedeepseek_accounts_ready gauge',
            `freedeepseek_accounts_ready ${accounts.filter(a => a.cooldownUntil <= Date.now()).length}`,
            '# HELP freedeepseek_uptime_seconds Server uptime', '# TYPE freedeepseek_uptime_seconds gauge',
            `freedeepseek_uptime_seconds ${uptime}`,
        ];
        for (const [model, count] of Object.entries(metrics.byModel))
            lines.push(`freedeepseek_requests_by_model{model="${model}"} ${count}`);
        for (const [endpoint, count] of Object.entries(metrics.byEndpoint))
            lines.push(`freedeepseek_requests_by_endpoint{endpoint="${endpoint}"} ${count}`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(lines.join('\n') + '\n');
        return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'FreeDeepseekAPI', watermark: FORGETMEAI_WATERMARK, models: SUPPORTED_MODEL_IDS, unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported), agents: sessions.size, accounts: accounts.map(accountStatus), config_ready: hasAuthConfig(), session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(config.SESSION_TTL_MS / 60000), max_messages: config.MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' } }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: FORGETMEAI_WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({ agent: agentId, session_id: session.id, message_count: session.messageCount, account: session.accountId, history_size: session.history.length, age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0 });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size; sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `No session for agent: ${agentId}` })); return; }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages' ? 'anthropic' : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
            const rawParams = JSON.parse(body || '{}');
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = params.messages || [];
            const tools = params.tools || [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-v4-flash').toLowerCase();
            metrics.byModel[requestedModel] = (metrics.byModel[requestedModel] || 0) + 1;
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const agentId = requestedSession ? String(requestedSession) : ((remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') ? 'dev-agent' : remoteAddr);
            const agentTag = `[${agentId}][${reqId}]`;

            const lastUserMessage = [...messages].reverse().find(m => m && m.role === 'user');
            const lastUserText = lastUserMessage && typeof lastUserMessage.content === 'string' ? lastUserMessage.content.trim() : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                logger.info(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                if (stream) {
                    if (apiMode === 'anthropic') sendAnthropicStream(res, confirmation);
                    else if (apiMode === 'responses') sendResponsesStream(res, confirmation);
                    else sendOpenAIStream(res, confirmation);
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(confirmation)));
                    else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(confirmation)));
                    else res.end(JSON.stringify(confirmation));
                }
                return;
            }

            try {

            return await runSerialized(agentId, async () => {
            const { prompt, systemPrompt } = formatMessages(messages, tools);
            const session = getOrCreateAgentSession(agentId);
            let historyPrefix = '';
            if (!session.id && session.history.length > 0) {
                historyPrefix = '[Previous conversation]\n';
                for (const exchange of session.history) historyPrefix += `User: ${exchange.user}\nAssistant: ${exchange.assistant}\n\n`;
                historyPrefix += '[Continue from here]\n\n';
            }
            const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${historyPrefix}${prompt}` : `${historyPrefix}${prompt}`;
            const startTime = Date.now();
            const { resp: dsResp, account } = await askDeepSeekStream(fullPrompt, agentId, requestedModel);

            async function readDeepSeekResponse(readable, onChunk) {
                let buffer = '', lastPath = null;
                const fragments = [];
                let fullContent = '', reasoningContent = '', newMessageId = null, finishReason = null, modelError = null;
                let prevContent = '', prevReasoning = '';
                const flushChunk = () => {
                    if (!onChunk) return;
                    const contentDelta = fullContent.slice(prevContent.length);
                    const reasoningDelta = reasoningContent.slice(prevReasoning.length);
                    if (contentDelta || reasoningDelta) { onChunk(contentDelta, reasoningDelta); prevContent = fullContent; prevReasoning = reasoningContent; }
                };
                const rebuildFragmentState = () => {
                    const { responseText, thinkText } = rebuildFragmentText(fragments);
                    if (responseText) fullContent = responseText;
                    reasoningContent = thinkText;
                    flushChunk();
                };
                const appendFragments = (value) => {
                    const incoming = Array.isArray(value) ? value : [value];
                    for (const fragment of incoming) { if (fragment && typeof fragment === 'object') fragments.push({ ...fragment }); }
                    rebuildFragmentState();
                };
                for await (const chunk of readable) {
                    buffer += new TextDecoder().decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const d = JSON.parse(line.slice(6));
                                if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                                if (isDeepSeekModelErrorEvent(d)) modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                                if (d.finish_reason) finishReason = d.finish_reason;
                                if (d.p !== undefined) lastPath = d.p;
                                if (d.v && typeof d.v === 'object' && d.v.response) {
                                    if (d.v.response.message_id !== undefined) newMessageId = d.v.response.message_id;
                                    if (d.v.response.content !== undefined) { fullContent = d.v.response.content; flushChunk(); }
                                    if (Array.isArray(d.v.response.fragments)) { fragments.length = 0; appendFragments(d.v.response.fragments); }
                                    if (d.v.response.finish_reason !== undefined) finishReason = d.v.response.finish_reason;
                                }
                                if (lastPath === 'response/fragments' && d.v !== undefined) appendFragments(d.v);
                                if (lastPath === 'response' && d.v !== undefined) applyResponsePatchOperations(d.v, appendFragments);
                                if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                                    if (fragments.length > 0) { fragments[fragments.length - 1].content = `${fragments[fragments.length - 1].content || ''}${d.v}`; rebuildFragmentState(); }
                                }
                                if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') { fullContent += d.v; flushChunk(); }
                                if (lastPath === 'response/finish_reason' && d.v !== undefined) finishReason = d.v;
                                if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') finishReason = d.v;
                            } catch (e) {}
                        }
                    }
                }
                flushChunk();
                return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError };
            }

            if (stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
                let streamContent = '', streamReasoning = '';
                let assistantRoleSent = false, toolCallMode = false, detectedToolCall = null, contentBuffer = '';
                const modelName = requestedModel;
                const chunkId = `ds-${Date.now()}`;
                const created = Math.floor(Date.now() / 1000);

                let streamResult;
                try {
                    streamResult = await readDeepSeekResponse(dsResp.body, (contentDelta, reasoningDelta) => {
                        if (!assistantRoleSent) {
                            res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
                            assistantRoleSent = true;
                        }
                        if (reasoningDelta) {
                            res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { reasoning_content: reasoningDelta }, finish_reason: null }] })}\n\n`);
                            streamReasoning += reasoningDelta;
                        }
                        streamContent += contentDelta || '';
                        if (toolCallMode) {
                            if (!detectedToolCall) {
                                const tc = parseToolCall(streamContent);
                                if (tc) {
                                    detectedToolCall = tc;
                                    const calls = Array.isArray(tc) ? tc : [tc];
                                    const toolCalls = calls.map(c => ({ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name: c.name, arguments: c.arguments } }));
                                    res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: null }] })}\n\n`);
                                }
                            }
                            return;
                        }
                        if (!contentDelta) return;
                        contentBuffer += contentDelta;

                        // Detect XML tool call (<tool_call>) or legacy TOOL_CALL: format
                        const tcXmlMatch = streamContent.match(/<tool_call[^>]*>/i);
                        const tcLegacyMatch = streamContent.match(/TOOL_CALL:\s*\w+/i);
                        if (tcXmlMatch || tcLegacyMatch) {
                            // Suppress text before tool call to avoid duplicates
                            contentBuffer = '';
                            toolCallMode = true;
                            return;
                        }

                        // Buffer if tail could be start of TOOL_CALL: prefix
                        const tail = streamContent.replace(/[^a-zA-Z_:]/g, '').slice(-12).toUpperCase();
                        const tcPrefix = 'TOOL_CALL:';
                        let couldBeTC = false;
                        for (let i = 1; i <= tcPrefix.length && i <= tail.length; i++) {
                            if (tail.endsWith(tcPrefix.slice(0, i))) { couldBeTC = true; break; }
                        }
                        if (couldBeTC && contentBuffer.length < 100) return;

                        // Buffer if tail could be start of <tool_call[
                        if (/<tool/i.test(tail) && contentBuffer.length < 100) return;
                        if (contentBuffer) {
                            res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }] })}\n\n`);
                            contentBuffer = '';
                        }
                    });
                } catch (e) {
                    logger.error(`${agentTag} Stream error: ${e.message}`);
                    res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })}\n\n`);
                    res.write('data: [DONE]\n\n'); res.end();
                    return;
                }
                if (contentBuffer) {
                    res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }] })}\n\n`);
                }
                // Suppress false positive recovery text to avoid duplicates
                if (toolCallMode && !detectedToolCall) {
                    contentBuffer = '';
                }
                const { messageId: newMessageId, finishReason: finishReason_ } = streamResult;
                if (newMessageId) { session.parentMessageId = newMessageId; session.messageCount++; }
                session.lastUsedAt = Date.now();
                markAccountSuccess(account);
                const elapsed = Date.now() - startTime;
                logger.info(`${agentTag} Streamed ${streamContent.length} chars (+${streamReasoning.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);
                const finalFinishReason = detectedToolCall ? 'tool_calls' : (finishReason_ || 'stop');
                res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }] })}\n\n`);
                res.write('data: [DONE]\n\n'); res.end();
                const finalContent = sanitizeContent(streamContent);
                const toolCall = detectedToolCall || parseToolCall(finalContent);
                storeHistory(agentId, prompt, finalContent, toolCall);
                logger.info(`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${elapsed}ms`);
                return;
            }

            // Non-streaming
            const readResult = await readDeepSeekResponse(dsResp.body);
            let fullContent = readResult.content;
            let reasoningContent = readResult.reasoningContent || '';
            let finishReason = readResult.finishReason;
            const modelError = readResult.modelError;
            fullContent = sanitizeContent(fullContent);
            reasoningContent = sanitizeContent(reasoningContent || '');
            const elapsed = Date.now() - startTime;
            logger.info(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            if ((!fullContent || fullContent.trim().length === 0) && modelError) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: modelError.content || 'DeepSeek returned an error without content', type: modelError.finish_reason || modelError.type || 'deepseek_model_error', model: requestedModel, real_model: resolveModelConfig(requestedModel).real_model } }));
                return;
            }

            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                retryAttempt++;
                if (retryAttempt > config.MAX_RETRIES) {
                    logger.info(`${agentTag} Empty after ${config.MAX_RETRIES} retries. Retrying without hif_leim...`);
                    require('./lib/auth')._hifCache = null;
                    session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
                    await new Promise(r => setTimeout(r, 1000));
                    const { resp: noHifResp } = await askDeepSeekStream(fullPrompt, agentId, requestedModel, true);
                    const noHifResult = await readDeepSeekResponse(noHifResp.body);
                    const noHifContent = noHifResult && noHifResult.content ? sanitizeContent(noHifResult.content) : '';
                    const noHifReasoning = noHifResult && noHifResult.reasoningContent ? sanitizeContent(noHifResult.reasoningContent) : '';
                    if (noHifContent && noHifContent.trim().length > 0) {
                        logger.info(`${agentTag} Fallback (no hif_leim) succeeded`);
                        fullContent = noHifContent; reasoningContent = noHifReasoning; break;
                    }
                    logger.info(`${agentTag} Empty after ${config.MAX_RETRIES + 1} total attempts. Giving up.`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `DeepSeek returned empty content after ${config.MAX_RETRIES + 1} attempts`, type: 'empty_response', agent: agentId, session_id: session.id, message_count: session.messageCount, history_length: session.history.length, retry_attempts: retryAttempt - 1 } }));
                    return;
                }
                logger.info(`${agentTag} Empty response (msg#${session.messageCount}, retry ${retryAttempt}/${config.MAX_RETRIES}). Resetting session...`);
                require('./lib/auth')._hifCache = null;
                session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
                await refreshAllHifLeim(true);
                await new Promise(r => setTimeout(r, Math.min(1000 * retryAttempt, 5000)));
                require('./lib/auth')._hifCache = null;
                const { resp: retryResp } = await askDeepSeekStream(fullPrompt, agentId, requestedModel);
                const retryResult = await readDeepSeekResponse(retryResp.body);
                const retryContent = retryResult && retryResult.content ? sanitizeContent(retryResult.content) : '';
                const retryReasoning = retryResult && retryResult.reasoningContent ? sanitizeContent(retryResult.reasoningContent) : '';
                if (retryContent && retryContent.trim().length > 0) { fullContent = retryContent; reasoningContent = retryReasoning; }
            }

            let continuationRounds = 0;
            while ((finishReason === 'length' || fullContent.length > 25000) && continuationRounds < 2) {
                continuationRounds++;
                logger.info(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/2)...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const { resp: contResp, account: contAccount } = await askDeepSeekStream('continue', agentId, requestedModel);
                if (contAccount && contBeforeId && contAccount.id !== contBeforeId) {
                    logger.info(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping`); break;
                }
                const contResult = await readDeepSeekResponse(contResp.body);
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += '\n' + contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    logger.info(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else { logger.info(`${agentTag} Continuation returned nothing useful, stopping`); break; }
            }

            let toolCall = parseToolCall(fullContent);
            if (!toolCall && /TOOL_CALL:\s*\w/i.test(fullContent)) {
                logger.info(`${agentTag} TOOL_CALL detected but JSON invalid/truncated. Retrying with stricter prompt...`);
                session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
                await new Promise(r => setTimeout(r, 1000));
                const strictPrompt = fullPrompt + '\n\n[STRICT INSTRUCTION] Your previous response had a TOOL_CALL but the arguments were too long and got cut off. Keep the arguments SHORT. Output ONLY: TOOL_CALL: <function>\narguments: <short JSON>';
                const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel);
                const retryResult2 = await readDeepSeekResponse(retryResp2.body);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = parseToolCall(retryContent2);
                    if (retryTc) { fullContent = retryContent2; reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : ''; toolCall = retryTc; }
                    else { reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent; }
                }
            }
            if (!fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) { fullContent += '\n\n' + screenshotPaths.join('\n'); logger.info(`${agentTag} Injected MEDIA paths: ${screenshotPaths.join(', ')}`); }
            }
            storeHistory(agentId, prompt, fullContent, toolCall);
            session.lastUsedAt = Date.now();
            markAccountSuccess(account);
            const openaiResponse = toolCall ? buildToolCallResponse(toolCall, requestedModel, fullPrompt, reasoningContent) : buildTextResponse(fullContent, fullPrompt, requestedModel, reasoningContent);
            if (stream) {
                if (apiMode === 'anthropic') sendAnthropicStream(res, openaiResponse);
                else if (apiMode === 'responses') sendResponsesStream(res, openaiResponse);
                else sendOpenAIStream(res, openaiResponse);
                logger.info(`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
                else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
                else res.end(JSON.stringify(openaiResponse));
                logger.info(`${agentTag} Response ${apiMode} (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        });
        } catch (e) {
            metrics.errors++;
            const errMsg = String(e.message || '').toLowerCase();
            const errCode = e.code || 'SERVER_ERROR';
            const { status, body } = formatErrorResponse(e, { agentId });
            logger.info(`[DS-API][${errCode}] Error: ${e.message}`);
            if (e.code === 'AUTH_EXPIRED' || errMsg.includes('auth') || errMsg.includes('401') || errMsg.includes('403')) {
                logger.info('[DS-API] Auth error, trying auto-refresh...');
                const refreshed = await autoRefreshAuth(true);
                if (refreshed) {
                    body.error.refreshed = true;
                    body.error.message += ' Auth refreshed, retry.';
                }
            }
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        }
    });
});

function printStatus() {
    logger.info(`\n${config.formatWatermark()}`);
    logger.info(`Auth: ${hasAuthConfig() ? 'OK' : 'FAIL — no deepseek-auth.json'}`);
    logger.info(`Auth source: ${process.env.DEEPSEEK_AUTH_DIR || config.DS_CONFIG_PATH}`);
    logger.info(`Accounts: ${accounts.length ? accounts.map(a => `${a.id}${a.cooldownUntil > Date.now() ? ' (cooldown)' : ''}`).join(', ') : 'none'}`);
    logger.info(`Working models: ${SUPPORTED_MODEL_IDS.join(', ')}`);
    logger.info('Broken/hidden aliases: ' + Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported).join(', '));
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: true });
        return true;
    }
    while (true) {
        printStatus();
        logger.info('\n=== Menu ===');
        logger.info(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
        logger.info('1 - Login / update DeepSeek auth');
        logger.info('2 - Import auth file / cookies');
        logger.info('3 - Show models and status');
        logger.info('4 - Start proxy (default)');
        logger.info('5 - Exit');
        let choice = await prompt('Your choice (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') { await require('./lib/auth').runAuthScript(); }
        else if (choice === '2') { spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env }); loadDeepSeekConfig({ fatal: false }); }
        else if (choice === '3') { logger.info(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2)); await prompt('\nPress Enter to return...'); }
        else if (choice === '4') { if (!hasAuthConfig()) { logger.info('Need deepseek-auth.json. Run option 1 or 2.'); continue; } return true; }
        else if (choice === '5') return false;
    }
}

async function killExistingServer(port) {
    const findCmds = [
        `ss -tlnp "sport = :${port}" 2>/dev/null`,
        `fuser ${port}/tcp 2>/dev/null`,
        `lsof -ti :${port} 2>/dev/null`
    ];
    for (const cmd of findCmds) {
        try {
            const out = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim();
            const pid = out.match(/pid=(\d+)/)?.[1] || out.split(/\s+/).find(s => /^\d+$/.test(s));
            if (pid) {
                logger.info(`[Kill] Port ${port} занят PID ${pid}. Завершаю...`);
                try { execSync(`kill ${pid}`, { timeout: 3000 }); } catch {}
                let waited = 0;
                while (waited < 5000) {
                    try { execSync(`kill -0 ${pid} 2>/dev/null`, { timeout: 1000 }); } catch { break; }
                    await new Promise(r => setTimeout(r, 200));
                    waited += 200;
                }
                if (waited >= 5000) try { execSync(`kill -9 ${pid} 2>/dev/null`, { timeout: 1000 }); } catch {}
                logger.info(`[Kill] Старый процесс (PID ${pid}) завершён`);
                await new Promise(r => setTimeout(r, 500));
                return;
            }
        } catch (_) {}
    }
}

async function main() {
    await killExistingServer(config.PORT);
    printBanner();
    loadDeepSeekConfig({ fatal: false });
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    await refreshAllHifLeim();
    loadSessions();
    server.listen(config.PORT, config.HOST, () => {
        logger.info(`[DS-API] Server on http://${config.HOST}:${config.PORT} (multi-agent sessions enabled)`);
        logger.info(`[DS-API] ${config.formatWatermark()}`);
        logger.info('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        logger.info('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        logger.info('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        logger.info('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        logger.info('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        logger.info('[DS-API] GET  /metrics — Prometheus-style metrics');
        logger.info('[DS-API] GET  /v1/sessions — list active agent sessions');
        logger.info('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        logger.info('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
    if (hasAuthConfig()) {
        logger.info('[Auth] Config present, will auto-refresh in', Math.round(55 * 60 * 1000 / 60000), 'min');
    } else {
        autoRefreshAuth(false).catch(e => logger.error('[Auth] Initial refresh error:', e.message));
    }
    setInterval(() => {
        if (hasAuthConfig()) autoRefreshAuth(false).catch(e => logger.error('[Auth] Periodic refresh error:', e.message));
    }, 55 * 60 * 1000).unref();
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [agentId, sess] of sessions) {
            const lastUsed = sess.lastUsedAt || sess.createdAt || 0;
            if (lastUsed > 0 && (now - lastUsed) > config.SESSION_TTL_MS) { sessions.delete(agentId); cleaned++; }
        }
        if (cleaned > 0) logger.info(`[Sessions] Cleaned ${cleaned} stale session(s)`);
        saveSessions();
    }, config.SESSION_CLEANUP_INTERVAL_MS).unref();
    const shutdown = (signal) => {
        logger.info(`[DS-API] Received ${signal}, shutting down gracefully...`);
        saveSessions();
        server.close(() => { logger.info('[DS-API] HTTP server closed'); process.exit(0); });
        setTimeout(() => { logger.error('[DS-API] Forced shutdown after timeout'); process.exit(1); }, 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => {
        logger.info('[DS-API] SIGHUP received — reloading auth config...');
        loadDeepSeekConfig({ fatal: false });
        if (accounts.length > 0) {
            require('./lib/auth')._hifCache = null;
            logger.info(`[DS-API] Auth config reloaded: ${accounts.length} account(s)`);
        } else { logger.error('[DS-API] SIGHUP reload failed — no valid auth config found'); }
    });
}

if (require.main === module) {
    main().catch(err => { logger.error('[DS-API] FATAL:', err); process.exit(1); });
}
