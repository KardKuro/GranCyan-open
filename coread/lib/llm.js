// llm.js — LLM 后端适配。三条路：
//   ① 本地 Claude CLI（走 GranCyan 的 /api/local-claude，可指定模型号，省订阅额度）
//   ② OpenAI 兼容（{apiBase}/chat/completions + Bearer）—— DeepSeek/GPT/大多数中转
//   ③ Anthropic（apiBase 以 /messages 结尾 + x-api-key）
// 判定规则与主程序 index.html 里一致，别单独发明。
//
// ⚠️ 防踩坑 #4(见 README):收响应体绝不能 `d += chunk` 逐块拼字符串——
// 一个中文字 3 字节,被网络分块切在边界就碎成 �。流式必须用 StringDecoder。
//
// ⚠️ 防踩坑 #6:本地 Claude 那条 SSE 里,正文增量字段叫 `delta` 不叫 `content`。
// 认错字段的后果不是报错,是 full 恒为空串、HTTP 200、前端只显示"（没接住，再说一遍？）",
// F12 干干净净什么都看不出来。`thinking`/`usage` 帧不是正文,必须跳过。
const http = require('http');
const { StringDecoder } = require('string_decoder');
const axios = require('axios');

// ── SSE 分帧:按空行(\n\n)切,帧会被网络切成任意块,buf 必须跨块累积(⚠️ 防踩坑 #5) ──
function makeFrameParser(onFrame) {
  let buf = '';
  return (textChunk) => {
    buf += textChunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const m = /^data: ?(.*)$/m.exec(frame);
      if (!m) continue;
      const raw = m[1];
      if (raw === '[DONE]') { onFrame(null, true); return; }
      try { if (onFrame(JSON.parse(raw), false)) return; } catch (e) { /* 半截帧,忽略 */ }
    }
  };
}

// ── ① 本地 Claude ────────────────────────────────────────────
function _localClaude(messages, model, onChunk) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      messages: (messages || []).filter((m) => m.role !== 'system'),
      systemPrompt: (messages.find((m) => m.role === 'system') || {}).content || '',
      model: model || '',
    });
    const rq = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/api/local-claude', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 300000,
    }, (res) => {
      const sd = new StringDecoder('utf8');
      res.on('data', (c) => onChunk(sd.write(c)));
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    rq.on('error', reject);
    rq.on('timeout', () => { rq.destroy(); reject(new Error('订阅 Claude 超时')); });
    rq.write(payload); rq.end();
  });
}

function localClaudeStream(messages, cfg, onDelta) {
  return new Promise((resolve, reject) => {
    let full = '', settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    _localClaude(messages, cfg.localModel, makeFrameParser((obj, isDone) => {
      if (isDone || !obj) return false;
      const t = typeof obj.delta === 'string' ? obj.delta
              : typeof obj.content === 'string' ? obj.content : '';
      if (t) { full += t; if (onDelta) onDelta(t, full); }
      // 有正文就不算失败:server 可能在 usage 之后补发 error 帧(如速率提示),
      // 但已经流出来的内容仍然是好的,别扔。
      if (obj.error && !full) { done(reject, new Error(obj.error)); return true; }
      if (obj.done) { done(resolve, full); return true; }
      return false;
    })).then(() => done(resolve, full)).catch((e) => done(reject, e));
  });
}

// ── ②③ 外部模型(OpenAI 兼容 / Anthropic) ──────────────────────
// 判定与主程序一致:apiBase 以 /messages 结尾 = Anthropic,否则 OpenAI 兼容。
function isAnthropic(cfg) {
  return String(cfg.apiBase || '').trim().replace(/\/$/, '').endsWith('/messages');
}

function buildRemoteReq(messages, cfg) {
  const ant = isAnthropic(cfg);
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  const chat = messages.filter((m) => m.role !== 'system');
  if (ant) {
    return {
      url: cfg.apiBase,
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: cfg.modelName, messages: chat, stream: true,
        max_tokens: cfg.maxTokens || 1024,
        ...(sys ? { system: sys } : {}),
      },
    };
  }
  // `/api/...` 相对地址 = 前端约定的「走 GranCyan server」（本地 Ollama 小千就这么配）。
  // 这里就在 server 进程里，补成自己的回环地址。
  let base = String(cfg.apiBase || 'https://api.openai.com/v1').trim().replace(/\/$/, '');
  if (/^\/(?!\/)/.test(base)) base = `http://127.0.0.1:${Number(process.env.GRANCYAN_PORT) || 3000}${base}`;
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: {
      model: cfg.modelName, messages, stream: true,
      // 5 代 / 4.7+ 的 Claude 走中转时 temperature 照样 400（规则同 js/05-prompts-api.js 的 isAdaptiveOnlyClaude）
      ...(/fable|mythos|opus-5|opus-4[.-][789]|sonnet-5|haiku-5/.test(String(cfg.modelName || '').toLowerCase())
        ? {} : { temperature: cfg.temp != null ? cfg.temp : 0.7 }),
      ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
    },
  };
}

// 从一帧里抠出正文增量。两家结构不同:
//   OpenAI: {choices:[{delta:{content:"…"}}]}
//   Anthropic: {type:'content_block_delta', delta:{type:'text_delta', text:"…"}}
function remoteFrameText(obj, ant) {
  if (ant) {
    const d = obj.delta || {};
    return d.type === 'text_delta' && typeof d.text === 'string' ? d.text : '';
  }
  const d = ((obj.choices || [])[0] || {}).delta || {};
  return typeof d.content === 'string' ? d.content : '';
}

async function remoteStream(messages, cfg, onDelta) {
  const ant = isAnthropic(cfg);
  const { url, headers, body } = buildRemoteReq(messages, cfg);
  const agent = cfg.getAgent ? await cfg.getAgent() : undefined;

  const resp = await axios({
    method: 'POST', url, headers, data: body,
    responseType: 'stream', validateStatus: () => true,
    timeout: 300000,
    ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
  });

  if (resp.status !== 200) {
    // 错误体也是流,得先读出来才知道上游到底在抱怨什么
    const text = await new Promise((res) => {
      const chunks = [];
      resp.data.on('data', (c) => chunks.push(c));
      resp.data.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
      resp.data.on('error', () => res(''));
    });
    throw new Error(`${cfg.label || cfg.modelName} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return new Promise((resolve, reject) => {
    let full = '', settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const sd = new StringDecoder('utf8');
    const feed = makeFrameParser((obj, isDone) => {
      if (isDone) { done(resolve, full); return true; }
      if (!obj) return false;
      if (obj.error) { done(reject, new Error(obj.error.message || String(obj.error))); return true; }
      const t = remoteFrameText(obj, ant);
      if (t) { full += t; if (onDelta) onDelta(t, full); }
      return false;
    });
    resp.data.on('data', (c) => feed(sd.write(c)));
    resp.data.on('end', () => done(resolve, full));
    resp.data.on('error', (e) => done(reject, e));
  });
}

// ── 对外 ──────────────────────────────────────────────────────
// cfg: models.js 的 resolve() 产物 + 可选 getAgent()（外网走代理，见 server.js outboundAgent）
function chatStream(messages, onDelta, cfg) {
  const c = cfg || { isLocal: true, localModel: '' };
  return c.isLocal ? localClaudeStream(messages, c, onDelta) : remoteStream(messages, c, onDelta);
}

// 非流式一问一答(章节摘要 digest 用)：底层还是流式，攒齐再返回。
async function ask(prompt, opts = {}, cfg) {
  const messages = [{ role: 'user', content: prompt }];
  const c = cfg || { isLocal: true, localModel: '' };
  const full = await chatStream(messages, null, { ...c, maxTokens: opts.maxTokens || c.maxTokens });
  return String(full || '').trim();
}

module.exports = { ask, chatStream };
