const { AppError } = require('./errors');

async function solvePOW(challenge, wasmUrl) {
  if (!wasmUrl) {
    wasmUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  }
  const resp = await fetch(wasmUrl);
  const wasmBytes = await resp.arrayBuffer();
  const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
  const e = mod.instance.exports;
  const encoder = new TextEncoder();
  const prefix = challenge.salt + '_' + challenge.expire_at + '_';
  const cBytes = encoder.encode(challenge.challenge);
  const pBytes = encoder.encode(prefix);
  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
  new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
  const dv = new DataView(e.memory.buffer);
  const code = dv.getInt32(sp, true);
  const ans = dv.getFloat64(sp + 8, true);
  e.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new AppError('POW_FAILED', { message: 'PoW challenge не пройден. Убедись что auth актуален.' });
  return Math.floor(ans);
}

async function createPOW(headers, wasmUrl, targetPath = '/api/v0/chat/completion') {
  const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST', headers,
    body: JSON.stringify({ target_path: targetPath })
  });
  const chalText = await cr.text();
  if (!cr.ok) throw new AppError('AUTH_EXPIRED', { message: `DeepSeek PoW challenge error: HTTP ${cr.status}. Auth скорее всего истёк.` });
  let chalJson;
  try { chalJson = JSON.parse(chalText); }
  catch (e) { throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`); }
  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired.');
  const answer = await solvePOW(challenge, wasmUrl);
  const powB64 = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge,
    salt: challenge.salt, answer,
    signature: challenge.signature, target_path: targetPath
  })).toString('base64');
  return powB64;
}

module.exports = { solvePOW, createPOW };
