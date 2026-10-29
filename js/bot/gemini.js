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

  const state = { mode: null, cooldownUntil: 0, lastError: '', calls: 0, ok: 0 };

  const enabled = () => GD.store.get(C.STORAGE.useGemini, true) !== false;

  function bodyFor(prompt, opts) {
    return {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? 420,
        thinkingConfig: { thinkingBudget: 0 }
      }
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

  async function post(url, payload) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), C.GEMINI_TIMEOUT_MS);
    try {
      return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });
    } finally { clearTimeout(timer); }
  }

  /** 傳入完整 Prompt，回傳文字；失敗回傳 null（並把原因寫入 state.lastError）*/
  async function generate(prompt, opts = {}) {
    if (!enabled()) { state.lastError = '已在設定中關閉雲端大腦'; return null; }
    if (Date.now() < state.cooldownUntil) { state.lastError = '雲端大腦冷卻中（429）'; return null; }
    const base = C.PROXY_URL.replace(/\/+$/, '');
    state.calls++;

    for (const model of C.GEMINI_MODELS) {
      const modes = ['A'];
      for (const mode of modes) {
        const url = mode === 'A' ? `${base}/v1beta/models/${model}:generateContent` : `${base}/`;
        const payload = mode === 'A' ? bodyFor(prompt, opts) : { model, ...bodyFor(prompt, opts) };
        try {
          const resp = await post(url, payload);
          if (resp.status === 429) {
  let details = {};

  try {
    details = await resp.clone().json();
  } catch {}

  const message =
    typeof details.error === 'string'
      ? details.error
      : typeof details.message === 'string'
        ? details.message
        : '';

  const retryAfterSeconds = Math.max(
    Number(details.retryAfter) || 0,
    Number(resp.headers.get('Retry-After')) || 0
  );

  let retryMs = retryAfterSeconds * 1000;

  // 解析 Google 回應中的 "Please retry in 16h2m46s"
  const match = message.match(
    /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i
  );

  if (match) {
    const seconds =
      Number(match[1] || 0) * 3600 +
      Number(match[2] || 0) * 60 +
      Number(match[3] || 0);

    retryMs = Math.max(retryMs, seconds * 1000);
  }

  // 未提供等待時間時，至少冷卻 60 秒
  retryMs = Math.max(
    retryMs,
    Number(C.GEMINI_COOLDOWN_MS) || 0,
    60_000
  );

  state.cooldownUntil = Date.now() + retryMs;
  state.lastError =
    `[${details.source || 'HTTP 429'}] ` +
    (message || '請求頻率或配額限制');

  return null;
}
          if (resp.status === 404 || resp.status === 405) { state.lastError = `模式 ${mode} 路徑不符 (${resp.status})`; continue; }
          if (!resp.ok) { state.lastError = `HTTP ${resp.status}`; break; }
          const text = extract(await resp.json());
          if (text) { state.mode = mode; state.ok++; state.lastError = ''; return text; }
          state.lastError = '回應沒有文字';
        } catch (e) {
          state.lastError = e && e.name === 'AbortError' ? '逾時' : (e && e.message) || '連線失敗';
        }
      }
    }
    return null;
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
