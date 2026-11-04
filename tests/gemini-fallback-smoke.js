'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Gemini, CONFIG } = GD;

function response(status, body, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return name.toLowerCase() === 'retry-after' ? retryAfter : null; } },
    clone() { return { json: async () => body }; },
    async json() { return body; }
  };
}

(async () => {
  try {
    assert.deepStrictEqual(CONFIG.GEMINI_MODELS.slice(0, 3),
      ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
      'primary and fallback order must be stable');
    GD.store.set(CONFIG.STORAGE.useGemini, true);
    Gemini.state.cooldownUntil = 0;
    const prompt = '完整公開對局上下文：真人指控凱基柏宇假冒姬雲浮；隻貓不是老朝奉而可能是鄭國渠。不得遺失前後文。';
    const requests = [];
    global.fetch = async (url, init) => {
      const payload = JSON.parse(init.body);
      requests.push({ url, prompt: payload.contents[0].parts[0].text, generationConfig: payload.generationConfig });
      if (requests.length === 1) return response(429, {
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded. Please retry in 1h2m3s' }
      });
      return response(200, { candidates: [{ content: { parts: [{ text: '我聽到這項角色指控，會按技能時點核對。' }] } }] });
    };
    const text = await Gemini.generate(prompt, { temperature: 0.6, maxTokens: 460 });
    assert.strictEqual(text, '我聽到這項角色指控，會按技能時點核對。', 'fallback model response must be returned');
    assert.strictEqual(requests.length, 2, 'a 429 on the primary model must advance to the next model');
    assert(requests[0].url.includes('/gemini-3.8-flash:generateContent'), 'first request must use the primary model');
    assert(requests[1].url.includes('/gemini-3.5-flash-lite:generateContent'), 'second request must use the first fallback model');
    assert(requests.every(item => item.prompt === prompt), 'every fallback must receive the exact same full context prompt');
    assert.strictEqual(Gemini.state.lastModel, 'gemini-3.5-flash-lite', 'successful fallback model must be recorded');
    assert.strictEqual(Gemini.state.fallbackCount, 1, 'one fallback attempt must be counted');
    assert.strictEqual(Gemini.state.cooldownUntil, 0, 'a successful fallback must clear cooldown');
    assert.strictEqual(requests[0].generationConfig.maxOutputTokens, 460,
      'an explicit token budget from a deliberate caller should still be honored');

    // Default gameplay speeches must not inherit a hidden fixed output-token cap.
    Gemini.state.cooldownUntil = 0;
    let uncappedGenerationConfig = null;
    global.fetch = async (_url, init) => {
      uncappedGenerationConfig = JSON.parse(init.body).generationConfig;
      return response(200, { candidates: [{ content: { parts: [{ text: '依據本輪證據，我暫時保留判斷。' }] } }] });
    };
    const uncapped = await Gemini.generate(prompt);
    assert(uncapped, 'an uncapped-by-length response should still be returned');
    assert(!Object.prototype.hasOwnProperty.call(uncappedGenerationConfig, 'maxOutputTokens'),
      'default gameplay speech must not send a fixed maxOutputTokens value');

    // If every model is quota-limited, preserve the longest retry instruction and cool down once.
    Gemini.state.cooldownUntil = 0;
    const before = Date.now();
    let exhaustedCalls = 0;
    global.fetch = async () => {
      exhaustedCalls++;
      return response(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Please retry in 1m2s' } });
    };
    const exhausted = await Gemini.generate(prompt, { maxTokens: 460 });
    assert.strictEqual(exhausted, null, 'all quota-limited models must safely return null for local speech fallback');
    assert.strictEqual(exhaustedCalls, CONFIG.GEMINI_MODELS.length, 'all configured models must be tried before global cooldown');
    assert(Gemini.state.cooldownUntil >= before + 62_000, 'the server retry interval must be preserved');
    const callsBeforeCooldown = exhaustedCalls;
    await Gemini.generate(prompt);
    assert.strictEqual(exhaustedCalls, callsBeforeCooldown, 'cooldown must prevent repeated quota requests');

    // A slow/hung endpoint must be bounded by the per-model timeout and one total speech budget.
    Gemini.state.cooldownUntil = 0;
    const oldPerModel = CONFIG.GEMINI_TIMEOUT_MS;
    const oldTotal = CONFIG.GEMINI_TOTAL_TIMEOUT_MS;
    const oldMaxAttempts = CONFIG.GEMINI_MAX_ATTEMPTS;
    CONFIG.GEMINI_TIMEOUT_MS = 20;
    CONFIG.GEMINI_TOTAL_TIMEOUT_MS = 55;
    CONFIG.GEMINI_MAX_ATTEMPTS = 4;
    let timeoutCalls = 0;
    global.fetch = async (_url, init) => {
      timeoutCalls++;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('request aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const timeoutStart = Date.now();
    const timedOut = await Gemini.generate(prompt);
    const wallMs = Date.now() - timeoutStart;
    assert.strictEqual(timedOut, null, 'a timeout must fall back locally rather than hang the game');
    assert(timeoutCalls <= 4 && timeoutCalls >= 2, 'timeout fallback may try only models allowed by the remaining budget');
    assert(wallMs < 180, `total request time must stay close to the configured 55ms test budget, got ${wallMs}ms`);
    assert(Gemini.state.lastCallMs <= 180 && Gemini.state.lastAttempts === timeoutCalls,
      'per-speech latency and attempts must be recorded for match-log diagnosis');

    // Headers may arrive immediately while the response body hangs. The same
    // per-model abort timer must cover response.json(), not just fetch().
    Gemini.state.cooldownUntil = 0;
    let bodyTimeoutCalls = 0;
    global.fetch = async (_url, init) => {
      bodyTimeoutCalls++;
      return {
        status: 200,
        ok: true,
        headers: { get() { return null; } },
        json() {
          return new Promise((_resolve, reject) => {
            const abort = () => {
              const error = new Error('response body aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (init.signal.aborted) abort();
            else init.signal.addEventListener('abort', abort, { once: true });
          });
        }
      };
    };
    const bodyStart = Date.now();
    const stalledBody = await Gemini.generate(prompt);
    const bodyWallMs = Date.now() - bodyStart;
    assert.strictEqual(stalledBody, null, 'a stalled response body must fall back locally');
    assert(bodyTimeoutCalls >= 2 && bodyTimeoutCalls <= 4, 'a stalled body may retry only inside the remaining total budget');
    assert(bodyWallMs < 180, `response body parsing must remain inside the total timeout, got ${bodyWallMs}ms`);
    assert.strictEqual(Gemini.state.lastAttempts, bodyTimeoutCalls, 'body timeout attempts must be recorded');

    CONFIG.GEMINI_TIMEOUT_MS = oldPerModel;
    CONFIG.GEMINI_TOTAL_TIMEOUT_MS = oldTotal;
    CONFIG.GEMINI_MAX_ATTEMPTS = oldMaxAttempts;

    console.log('Gemini fallback 測試通過：429 逐模型切換、完整上下文、冷卻、單次總等待上限與實際延遲紀錄均正確。');
    process.exit(0);
  } catch (error) {
    console.error('Gemini fallback 測試失敗：', error && error.stack || error);
    process.exit(1);
  }
})();
