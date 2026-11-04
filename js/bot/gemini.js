/* ============================================================================
 * bot/gemini.js — Gemini 代理串接（Cloudflare Worker Proxy）
 *
 * 代理位址：CONFIG.PROXY_URL。因為不同 Worker 的路由寫法不一，採「自動偵測 + 記憶」：
 *   模式 A  POST {proxy}/v1beta/models/{model}:generateContent   （Gemini 原生路徑，舊版 Worker 同此格式）
 *   模式 B  POST {proxy}/                                        （根路徑，body 為 {model, contents, generationConfig}）
 * 先試 A，遇到 404/405 再試 B，成功的模式會記住。任何失敗都回傳 null，
 * 由呼叫端退回本地說服型發言，所以代理掛掉或被限流時遊戲不會卡住。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const C = GD.CONFIG;

  const state = { mode: null, cooldownUntil: 0, lastError: '', calls: 0, ok: 0, lastModel: '', fallbackCount: 0, lastCallMs: 0, lastAttempts: 0, lastAttemptModels: [], totalCallMs: 0 };

  const enabled = () => GD.store.get(C.STORAGE.useGemini, true) !== false;

  function bodyFor(prompt, opts = {}) {
    const generationConfig = {
      temperature: opts.temperature ?? 0.7,
      thinkingConfig: { thinkingBudget: 0 }
    };
    // 只有呼叫端明確要求時才設定 token 上限；一般遊戲發言不設固定輸出長度。
    // 單次請求仍受 GEMINI_TIMEOUT_MS／GEMINI_TOTAL_TIMEOUT_MS 約束，避免無限等待。
    const requestedMaxTokens = Number(opts.maxTokens);
    if (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0) {
      generationConfig.maxOutputTokens = Math.floor(requestedMaxTokens);
    }
    return {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig
    };
  }

  function extract(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const t = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (t) return t;
    }
    // 兼容代理已把回應展平的格式
    if (typeof data?.text === 'string' && data.text.trim()) return data.text.trim();
    if (typeof data?.output === 'string' && data.output.trim()) return data.output.trim();
    return '';
  }

  async function post(url, payload, timeoutMs = C.GEMINI_TIMEOUT_MS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      // Keep the abort timer alive until the response body is parsed. Fetch may
      // resolve when headers arrive while response.json() is still stalled.
      let data = null;
      if (response.status === 429 || response.ok) {
        try { data = await response.json(); } catch (error) { throw error; }
      }
      return { status: response.status, ok: response.ok, headers: response.headers, data };
    } finally { clearTimeout(timer); }
  }

  function retryDelayFrom429(resp, details) {
    const error = details && details.error && typeof details.error === 'object' ? details.error : {};
    const message = typeof details?.error === 'string' ? details.error
      : String(error.message || details?.message || '');
    const retryHeader = resp && resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
    const headerSeconds = Number(retryHeader) || 0;
    const headerDateMs = retryHeader && !headerSeconds ? Math.max(0, Date.parse(retryHeader) - Date.now()) : 0;
    const retryInfo = [...(Array.isArray(error.details) ? error.details : []), ...(Array.isArray(details?.details) ? details.details : [])]
      .find(item => item && (item.retryDelay || item.retry_after));
    const bodyRetry = Math.max(Number(details?.retryAfter) || 0, Number(details?.retry_after) || 0);
    let retryMs = Math.max(headerSeconds * 1000, headerDateMs, bodyRetry * 1000);
    const retryText = String(details?.retryDelay || error.retryDelay || (retryInfo && (retryInfo.retryDelay || retryInfo.retry_after)) || '');
    const retryMatch = retryText.match(/(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(\d+(?:\.\d+)?)s/i);
    if (retryMatch) retryMs = Math.max(retryMs,
      (Number(retryMatch[1] || 0) * 3600 + Number(retryMatch[2] || 0) * 60 + Number(retryMatch[3] || 0)) * 1000);
    const match = message.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
    if (match) retryMs = Math.max(retryMs,
      (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000);
    return {
      retryMs: Math.max(retryMs, Number(C.GEMINI_COOLDOWN_MS) || 0, 60_000),
      message,
      source: String(details?.source || error.status || error.code || 'HTTP 429')
    };
  }

  /**
   * 傳入完整 Prompt，回傳文字。單次發言有總等待上限，避免多模型逐個逾時，
   * 導致一名 BOT 卡住數十秒甚至數分鐘；快速的 429/模型錯誤仍可繼續 fallback。
   */
  async function generate(prompt, opts = {}) {
    if (!enabled()) { state.lastError = '已在設定中關閉雲端大腦'; state.lastCallMs = 0; state.lastAttempts = 0; state.lastAttemptModels = []; state.lastModel = ''; return null; }
    if (Date.now() < state.cooldownUntil) { state.lastError = '雲端大腦冷卻中（429）'; state.lastCallMs = 0; state.lastAttempts = 0; state.lastAttemptModels = []; state.lastModel = ''; return null; }
    const base = C.PROXY_URL.replace(/\/+$/, '');
    const models = [...new Set((Array.isArray(C.GEMINI_MODELS) ? C.GEMINI_MODELS : []).filter(Boolean))];
    if (!models.length) { state.lastError = '沒有設定可用的 Gemini 模型'; state.lastCallMs = 0; state.lastAttempts = 0; return null; }

    const startedAt = Date.now();
    const totalBudget = Math.max(1, Number(C.GEMINI_TOTAL_TIMEOUT_MS) || 20000);
    const deadline = startedAt + totalBudget;
    const maxAttempts = Math.max(1, Math.min(models.length, Number(C.GEMINI_MAX_ATTEMPTS) || models.length));
    const perModelTimeout = Math.max(1, Number(C.GEMINI_TIMEOUT_MS) || 10000);
    const attemptModels = [];
    const finish = result => {
      state.lastCallMs = Math.max(0, Date.now() - startedAt);
      state.lastAttempts = attemptModels.length;
      state.lastAttemptModels = attemptModels.slice();
      state.totalCallMs = (Number(state.totalCallMs) || 0) + state.lastCallMs;
      return result;
    };

    state.calls++;
    state.fallbackCount = 0;
    state.lastModel = '';
    let maxRetryMs = 0;
    let last429 = '';
    let lastFailure = '';

    for (let modelIndex = 0; modelIndex < models.length && attemptModels.length < maxAttempts; modelIndex++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        lastFailure = `Gemini 單次等待已達 ${totalBudget}ms 上限，改用本地發言`;
        break;
      }
      const model = models[modelIndex];
      const timeoutMs = Math.max(1, Math.min(perModelTimeout, remaining));
      attemptModels.push(model);
      const url = `${base}/v1beta/models/${model}:generateContent`;
      // Every fallback receives the same full conversation prompt and generation options.
      const payload = bodyFor(prompt, opts);
      try {
        const resp = await post(url, payload, timeoutMs);
        if (resp.status === 429) {
          const details = resp.data && typeof resp.data === 'object' ? resp.data : {};
          const retry = retryDelayFrom429(resp, details);
          maxRetryMs = Math.max(maxRetryMs, retry.retryMs);
          last429 = `[${retry.source}] ${retry.message || '請求頻率或配額限制'}（模型 ${model}）`;
          state.lastError = last429;
          if (modelIndex < models.length - 1 && attemptModels.length < maxAttempts && Date.now() < deadline) { state.fallbackCount++; continue; }
          break;
        }
        if (resp.status === 404 || resp.status === 405 || resp.status === 400 || resp.status === 403) {
          lastFailure = `模型 ${model} 不可用（HTTP ${resp.status}）`;
          state.lastError = lastFailure;
          if (modelIndex < models.length - 1 && attemptModels.length < maxAttempts && Date.now() < deadline) { state.fallbackCount++; continue; }
          break;
        }
        if (!resp.ok) {
          lastFailure = `模型 ${model} HTTP ${resp.status}`;
          state.lastError = lastFailure;
          if (modelIndex < models.length - 1 && attemptModels.length < maxAttempts && Date.now() < deadline && (resp.status >= 500 || resp.status === 408)) {
            state.fallbackCount++;
            continue;
          }
          break;
        }
        const text = extract(resp.data);
        if (text) {
          state.mode = 'A';
          state.lastModel = model;
          state.ok++;
          state.lastError = '';
          state.cooldownUntil = 0;
          return finish(text);
        }
        lastFailure = `模型 ${model} 回應沒有文字`;
        state.lastError = lastFailure;
        if (modelIndex < models.length - 1 && attemptModels.length < maxAttempts && Date.now() < deadline) { state.fallbackCount++; continue; }
      } catch (e) {
        lastFailure = e && e.name === 'AbortError' ? `模型 ${model} 逾時（${timeoutMs}ms）` : `模型 ${model}：${(e && e.message) || '連線失敗'}`;
        state.lastError = lastFailure;
        if (modelIndex < models.length - 1 && attemptModels.length < maxAttempts && Date.now() < deadline) { state.fallbackCount++; continue; }
      }
    }

    if (maxRetryMs > 0) {
      state.cooldownUntil = Date.now() + maxRetryMs;
      state.lastError = last429 || lastFailure || '所有 Gemini 備援模型均達配額限制';
    } else if (lastFailure) {
      state.lastError = lastFailure;
    }
    if (!lastFailure && !last429) state.lastError = 'Gemini 單次等待預算已用完';
    return finish(null);
  }

  /** 清掉引號 / 角色名前綴 / 說明性前言，只留台詞 */
  function clean(text) {
    return String(text || '')
      .replace(/^```[a-z]*\n?|```$/g, '')
      .replace(/^\s*(?:台詞|發言|回答)[：:]\s*/, '')
      .replace(/^[「『"“]|[」』"”]$/g, '')
      .trim();
  }

  GD.Gemini = { generate, clean, state, enabled, setEnabled: v => GD.store.set(C.STORAGE.useGemini, !!v) };
})(window.GD);
