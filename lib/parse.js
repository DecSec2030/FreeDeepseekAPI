const { logger } = require('./logger');
const { FORGETMEAI_WATERMARK } = require('./config');

function formatToolDefinitions(tools) {
  if (!tools || tools.length === 0) return '';
  let text = '\n\n<tool_instructions>\n';
  text += 'CRITICAL: You MUST call a tool for every action. NEVER describe what you would do — DO IT.\n';
  text += 'If you need to read/write/execute something, use TOOL_CALL: immediately. No text first.\n';
  text += 'Format:\nTOOL_CALL: <function_name>\narguments: <JSON>\n\n';
  text += 'Example:\nTOOL_CALL: write\narguments: {"filePath": "/tmp/x.txt", "content": "hi"}\n\n';
  text += 'Rules:\n';
  text += '- NO explanations, NO markdown, NO code blocks before the tool call.\n';
  text += '- After getting tool result, you may respond with text.\n';
  text += '- Never simulate or guess results.\n\n';
  text += 'Available functions:\n';
  for (const tool of tools) {
    if (tool.type === 'function' && tool.function) {
      const fn = tool.function;
      text += `- ${fn.name}: ${fn.description || ''}\n`;
    }
  }
  text += '\n</tool_instructions>\n';
  text += 'START WITH TOOL_CALL:';
  return text;
}

function extractBalancedJsonAt(text, startIndex) {
  let braceDepth = 0, inString = false, escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') braceDepth++;
      if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) return text.substring(startIndex, i + 1);
      }
    }
  }
  return null;
}

function coerceToolCallObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidate = obj.tool_call || obj.tool || obj.function_call || obj;
  if (!candidate || typeof candidate !== 'object') return null;
  const fn = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate;
  const name = fn.name || candidate.name || obj.name;
  let args = fn.arguments ?? candidate.arguments ?? candidate.input ?? obj.arguments ?? obj.input ?? {};
  if (!name || typeof name !== 'string') return null;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = { raw: args }; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  return { name, arguments: JSON.stringify(args) };
}

function parseJsonToolCandidate(raw, label = 'json') {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const tc = coerceToolCallObject(parsed);
    if (tc) {
      logger.info(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
      return tc;
    }
  } catch (e) {
    logger.debug(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
  }
  return null;
}

function parseToolCall(text) {
  if (!text || typeof text !== 'string') return null;
  const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
  if (xmlMatch) {
    const tc = parseJsonToolCandidate(xmlMatch[1].trim(), 'xml');
    if (tc) return tc;
  }
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence;
  while ((fence = fenceRe.exec(text)) !== null) {
    const tc = parseJsonToolCandidate(fence[1].trim(), 'fenced');
    if (tc) return tc;
  }
  const allTc = [];
  const tcRe = /TOOL_CALL:\s*([\w-]+)\s*/gi;
  let m;
  while ((m = tcRe.exec(text)) !== null) {
    const name = m[1];
    const afterMatch = text.substring(m.index + m[0].length);
    const braceIdx = afterMatch.indexOf('{');
    if (braceIdx === -1) { logger.debug(`[parseToolCall] TOOL_CALL:${name} found but no { after it`); continue; }
    const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
    if (!rawJson) { logger.debug(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`); continue; }
    try {
      const args = JSON.parse(rawJson);
      logger.info(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
      allTc.push({ name, arguments: JSON.stringify(args) });
    } catch (e) {
      logger.debug(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
    }
  }
  if (allTc.length > 1) return allTc;
  if (allTc.length === 1) return allTc[0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const rawJson = extractBalancedJsonAt(text, i);
    if (!rawJson) continue;
    const tc = parseJsonToolCandidate(rawJson, 'inline');
    if (tc) return tc;
  }
  logger.debug(`[parseToolCall] No tool call match in ${text.length} chars`);
  return null;
}

function sanitizeContent(text) {
  return text.replace(/[\ud800-\udfff]/g, '');
}

function estimateTokens(text) {
  return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
  const promptTokens = estimateTokens(prompt);
  const contentTokens = estimateTokens(content);
  const reasoningTokens = estimateTokens(reasoningContent);
  const completionTokens = contentTokens + reasoningTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokens }
  };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '') {
  const calls = Array.isArray(toolCall) ? toolCall : [toolCall];
  const tool_calls = calls.map(tc => ({
    id: 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
    type: 'function',
    function: { name: tc.name, arguments: tc.arguments }
  }));
  return {
    id: 'ds-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls }, finish_reason: 'tool_calls' }],
    usage: buildUsage(prompt, '', reasoningContent),
    watermark: FORGETMEAI_WATERMARK
  };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '') {
  const message = { role: 'assistant', content };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  return {
    id: 'ds-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: buildUsage(prompt, content, reasoningContent),
    watermark: FORGETMEAI_WATERMARK
  };
}

function normalizeMessageContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
      if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
      if (part.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`;
      return part.text || part.content || JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return String(content);
}

function normalizeAnthropicTools(tools = []) {
  return (tools || []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
    }
  })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
  return (tools || []).map(tool => {
    if (tool.type === 'function' && tool.function) return tool;
    if (tool.type === 'function' && tool.name) {
      return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
    }
    return null;
  }).filter(Boolean);
}

function normalizeResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      messages.push({ role: item.role || 'user', content: normalizeMessageContent(item.content) });
    } else if (item.role) {
      messages.push({ role: item.role, content: normalizeMessageContent(item.content) });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
    } else if (item.type === 'input_text') {
      messages.push({ role: 'user', content: item.text || '' });
    }
  }
  return messages;
}

function normalizeApiParams(params, apiMode) {
  if (apiMode === 'anthropic') {
    const messages = [];
    if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
    for (const msg of params.messages || []) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
        const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
        if (text) messages.push({ role: 'assistant', content: text });
        for (const tu of toolUses) {
          messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
        for (const part of msg.content) {
          if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
          else messages.push({ role: 'user', content: normalizeMessageContent(part) });
        }
      } else {
        messages.push({ role: msg.role || 'user', content: normalizeMessageContent(msg.content) });
      }
    }
    return { ...params, model: params.model || 'deepseek-v4-flash', messages, tools: normalizeAnthropicTools(params.tools || []), stream: params.stream === true, user: params.metadata?.user_id || params.user };
  }
  if (apiMode === 'responses') {
    const messages = normalizeResponsesInput(params.input);
    if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
    return { ...params, model: params.model || 'deepseek-v4-flash', messages, tools: normalizeResponsesTools(params.tools || []), stream: params.stream === true, user: params.user };
  }
  return params;
}

function safeJsonParseObject(text, fallback = {}) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (_e) { return fallback; }
}

function toAnthropicResponse(openaiResp) {
  const choice = openaiResp.choices[0];
  const msg = choice.message || {};
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  const content = [];
  if (hasToolCalls) {
    for (const tc of msg.tool_calls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
    }
  } else {
    content.push({ type: 'text', text: msg.content || '' });
  }
  const response = {
    id: 'msg_' + openaiResp.id, type: 'message', role: 'assistant', model: openaiResp.model,
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0 },
    watermark: FORGETMEAI_WATERMARK,
  };
  if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
  return response;
}

function toResponsesResponse(openaiResp) {
  const choice = openaiResp.choices[0];
  const msg = choice.message || {};
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  const output = [];
  if (!hasToolCalls && msg.reasoning_content) {
    output.push({ id: 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  if (hasToolCalls) {
    for (const tc of msg.tool_calls) {
      output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
    }
  } else {
    output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
  }
  return {
    id: openaiResp.id.replace(/^ds-/, 'resp_'),
    object: 'response',
    created_at: openaiResp.created,
    status: 'completed',
    model: openaiResp.model,
    output,
    output_text: msg.content || '',
    usage: { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0, total_tokens: openaiResp.usage?.total_tokens || 0, output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 } },
    watermark: FORGETMEAI_WATERMARK,
  };
}

function isAssistantOutputFragment(fragment) {
  return fragment && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH') && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
  return fragment && (fragment.type === 'THINK' || fragment.type === 'REASONING') && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
  return event && event.type === 'error';
}

function rebuildFragmentText(fragments) {
  const responseText = fragments.filter(isAssistantOutputFragment).map(f => f.content).join('');
  const thinkText = fragments.filter(isReasoningFragment).map(f => f.content).join('');
  return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
  if (!Array.isArray(ops)) return false;
  let applied = false;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
      appendFragments(op.v);
      applied = true;
    }
  }
  return applied;
}

function extractScreenshotPaths(messages) {
  const fs = require('fs');
  const paths = [];
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.content) {
      const pngMatch = msg.content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
      if (pngMatch) {
        const filePath = pngMatch[2];
        if (filePath.startsWith('/') && fs.existsSync(filePath)) paths.push(`MEDIA:${filePath}`);
      }
      const mediaMatch = msg.content.match(/MEDIA:(\S+)/g);
      if (mediaMatch) {
        for (const tag of mediaMatch) {
          const extractedPath = tag.replace(/^MEDIA:/, '');
          if (fs.existsSync(extractedPath) && !paths.includes(tag)) paths.push(tag);
        }
      }
    }
    if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
      let match;
      while ((match = pathRegex.exec(content)) !== null) {
        const filePath = match[1];
        if (filePath.startsWith('/') && fs.existsSync(filePath) && !paths.includes(`MEDIA:${filePath}`)) paths.push(`MEDIA:${filePath}`);
      }
    }
  }
  return paths;
}

module.exports = {
  formatToolDefinitions,
  extractBalancedJsonAt,
  coerceToolCallObject,
  parseJsonToolCandidate,
  parseToolCall,
  sanitizeContent,
  estimateTokens,
  buildUsage,
  buildToolCallResponse,
  buildTextResponse,
  normalizeMessageContent,
  normalizeAnthropicTools,
  normalizeResponsesTools,
  normalizeResponsesInput,
  normalizeApiParams,
  safeJsonParseObject,
  toAnthropicResponse,
  toResponsesResponse,
  isAssistantOutputFragment,
  isReasoningFragment,
  isDeepSeekModelErrorEvent,
  rebuildFragmentText,
  applyResponsePatchOperations,
  extractScreenshotPaths,
};
