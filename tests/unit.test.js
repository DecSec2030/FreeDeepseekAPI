const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../lib/parse.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('parseToolCall detects XML tool_call format', () => {
  const result = serverInternals.parseToolCall('<tool_call>{"name": "write", "arguments": {"filePath": "/tmp/x.txt", "content": "hi"}}</tool_call>');
  assert.notEqual(result, null);
  assert.equal(result.name, 'write');
});

test('parseToolCall detects TOOL_CALL: legacy format', () => {
  const result = serverInternals.parseToolCall('TOOL_CALL: write\narguments: {"filePath": "/tmp/x.txt", "content": "hi"}');
  assert.notEqual(result, null);
  assert.equal(result.name, 'write');
});

test('parseToolCall detects multiple TOOL_CALL:', () => {
  const result = serverInternals.parseToolCall('TOOL_CALL: write\narguments: {"filePath": "/tmp/a.txt", "content": "a"}\nTOOL_CALL: write\narguments: {"filePath": "/tmp/b.txt", "content": "b"}');
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'write');
  assert.equal(result[1].name, 'write');
});

test('parseToolCall returns null for plain text', () => {
  assert.equal(serverInternals.parseToolCall('Hello, how are you?'), null);
});

test('formatToolDefinitions returns empty string for no tools', () => {
  assert.equal(serverInternals.formatToolDefinitions([]), '');
  assert.equal(serverInternals.formatToolDefinitions(null), '');
});

test('formatToolDefinitions includes function names', () => {
  const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command' } }];
  const result = serverInternals.formatToolDefinitions(tools);
  assert.match(result, /bash/);
  assert.match(result, /TOOL_CALL/);
});

test('buildToolCallResponse returns tool_calls format', () => {
  const tc = { name: 'bash', arguments: '{"command": "ls"}' };
  const resp = serverInternals.buildToolCallResponse(tc, 'test-model');
  assert.equal(resp.choices[0].finish_reason, 'tool_calls');
  assert.equal(resp.choices[0].message.tool_calls.length, 1);
  assert.equal(resp.choices[0].message.tool_calls[0].function.name, 'bash');
  assert.equal(resp.choices[0].message.content, null);
});

test('buildToolCallResponse handles array of tool calls', () => {
  const tcs = [
    { name: 'bash', arguments: '{"command": "ls"}' },
    { name: 'write', arguments: '{"filePath": "/tmp/x"}' },
  ];
  const resp = serverInternals.buildToolCallResponse(tcs, 'test-model');
  assert.equal(resp.choices[0].message.tool_calls.length, 2);
});

test('buildTextResponse returns text response', () => {
  const resp = serverInternals.buildTextResponse('Hello!', 'Prompt', 'test-model');
  assert.equal(resp.choices[0].message.content, 'Hello!');
  assert.equal(resp.choices[0].finish_reason, 'stop');
});

test('buildTextResponse includes reasoning_content', () => {
  const resp = serverInternals.buildTextResponse('Hello!', 'Prompt', 'test-model', 'Some reasoning');
  assert.equal(resp.choices[0].message.reasoning_content, 'Some reasoning');
});

test('sanitizeContent removes surrogate characters', () => {
  assert.equal(serverInternals.sanitizeContent('hello\uD800world'), 'helloworld');
  assert.equal(serverInternals.sanitizeContent('normal text'), 'normal text');
});

test('normalizeApiParams handles Anthropic format', () => {
  const params = {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: false,
  };
  const result = serverInternals.normalizeApiParams(params, 'anthropic');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'user');
});

test('normalizeApiParams handles Responses format', () => {
  const params = {
    model: 'deepseek-v4-flash',
    input: [{ role: 'user', content: 'Hi' }],
  };
  const result = serverInternals.normalizeApiParams(params, 'responses');
  assert.equal(result.messages.length, 1);
});
