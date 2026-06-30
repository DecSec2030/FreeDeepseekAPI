const { FORGETMEAI_WATERMARK } = require('./config');

function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(res, openaiResp) {
  const { toAnthropicResponse, safeJsonParseObject } = require('./parse');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const choice = openaiResp.choices[0];
  const msg = choice.message || {};
  const message = toAnthropicResponse(openaiResp);
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  writeSse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });
  if (hasToolCalls) {
    msg.tool_calls.forEach((tc, i) => {
      writeSse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
      writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    });
    writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: message.usage });
  } else {
    if (msg.reasoning_content) {
      writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${msg.reasoning_content}\n[/reasoning]\n` } });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    const offset = msg.reasoning_content ? 1 : 0;
    writeSse(res, 'content_block_start', { type: 'content_block_start', index: offset, content_block: { type: 'text', text: '' } });
    const text = msg.content || '';
    for (let i = 0; i < text.length; i += 80) {
      writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: offset, delta: { type: 'text_delta', text: text.substring(i, i + 80) } });
    }
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: offset });
    writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
  }
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function sendResponsesStream(res, openaiResp) {
  const { toResponsesResponse } = require('./parse');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const response = toResponsesResponse(openaiResp);
  const choice = openaiResp.choices[0];
  const msg = choice.message || {};
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  writeSse(res, 'response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });
  let outputIndex = 0;
  if (!hasToolCalls && msg.reasoning_content) {
    const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
    writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...reasoningItem, status: 'in_progress' } });
    writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: outputIndex, summary_index: 0, delta: msg.reasoning_content });
    writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: msg.reasoning_content }] } });
    outputIndex++;
  }
  if (hasToolCalls) {
    msg.tool_calls.forEach((tc) => {
      const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
      writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
      writeSse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
      writeSse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
      outputIndex++;
    });
  } else {
    const text = msg.content || '';
    const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
    writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
    for (let i = 0; i < text.length; i += 80) {
      writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
    }
    writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
    writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
    writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
  }
  writeSse(res, 'response.completed', { type: 'response.completed', response });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendOpenAIStream(res, openaiResp) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const choice = openaiResp.choices[0];
  const msg = choice.message || {};
  const id = openaiResp.id;
  const created = openaiResp.created;
  const model = openaiResp.model;
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  if (!hasToolCalls && msg.reasoning_content) {
    for (let i = 0; i < msg.reasoning_content.length; i += 50) {
      const chunk = msg.reasoning_content.substring(i, i + 50);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
    }
  }
  if (hasToolCalls) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: msg.tool_calls }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    for (let i = 0; i < (msg.content || '').length; i += 50) {
      const chunk = msg.content.substring(i, i + 50);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }
  res.end();
}

module.exports = { writeSse, sendAnthropicStream, sendResponsesStream, sendOpenAIStream };
