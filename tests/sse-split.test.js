/* 云端 API 流式解析：网络拆包不许丢字、不许出 �。
 *
 * 以前 streamCompletion 的通用分支（DeepSeek / OpenAI 兼容 / Anthropic 直连）
 * 每个网络包单独 TextDecoder.decode()、按包 split('\n')：
 *   - 一个汉字（3 字节）被切在两包之间 → 两头各变成 �；
 *   - 一行 `data: {...}` 被切成两包 → 前半截 JSON.parse 失败被 catch{} 吞掉，
 *     后半截不以 `data: ` 开头被 filter 掉，那段字永久丢了，零报错。
 * 订阅通道那条路早就是行缓冲写法，这条漏了。
 *
 * 这里在 vm 里真跑 05-prompts-api.js 的 streamCompletion，fetch 是假的，
 * 把一段 SSE 字节流按固定步长切碎喂进去（步长 1～13 都试，必然切开汉字和 JSON 行）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
function funcBody(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
const fnSrc = funcBody(src, 'async function streamCompletion(');

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); } };

function makeCtx(bytes, step) {
  const ctx = {
    _streamControllers: new Set(), updateStreamUI() {}, getActiveChat: () => null,
    SERVER_BASE: '', promptCacheAllowed: () => false, applyPromptCache() {}, applyAnthropicThinking() {},
    reportCacheUsage() {}, buildRequestBody: (conf, msgs) => ({ model: conf.modelName, messages: msgs, stream: true }),
    console: { log() {}, warn() {}, error() {} },
    AbortController, TextDecoder, TextEncoder, JSON, Promise, Array, Object, Math, Date, String, RegExp, Error,
    fetch: async () => {
      let i = 0;
      return {
        ok: true, status: 200, headers: { get: () => null },
        body: { getReader: () => ({
          read: async () => {
            if (i >= bytes.length) return { done: true, value: undefined };
            const v = bytes.slice(i, i + step); i += step;
            return { done: false, value: v };
          },
        }) },
      };
    },
  };
  // 函数体里零星用到的其它全局（设置项、提示等）一律给个无害桩，免得 ReferenceError
  return vm.createContext(new Proxy(ctx, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : (k === Symbol.unscopables ? undefined : globalThis[k])),
  }));
}
async function runStream(sse, step, conf) {
  const bytes = new TextEncoder().encode(sse);
  const ctx = makeCtx(bytes, step);
  vm.runInContext(fnSrc + '\nthis.__sc = streamCompletion;', ctx);
  return ctx.__sc(conf, [{ role: 'user', content: 'hi' }], () => {}, undefined, null);
}

const PIECES = ['你好呀，', '小明🐱', '今天想吃', '什么？', 'éñ中文混排。', '最后一句'];
const WANT = PIECES.join('');
const openaiSse = PIECES.map(p => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
const anthroSse = [
  { type: 'message_start', message: { usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...PIECES.map(p => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
].map(o => 'event: x\r\ndata: ' + JSON.stringify(o) + '\r\n\r\n').join('');

(async () => {
  t('切得出 streamCompletion', fnSrc.length > 1000);

  console.log('\n【一】OpenAI 兼容格式，步长 1～13 字节切碎');
  {
    const bad = [];
    for (let step = 1; step <= 13; step++) {
      const r = await runStream(openaiSse, step, { apiBase: 'https://x.test/v1', apiKey: 'k', modelName: 'deepseek-chat' });
      if (r.error || r.fullText !== WANT) bad.push({ step, got: r.fullText, err: r.error });
    }
    t('每种切法拼回来都一字不差', bad.length === 0, bad[0]);
  }
  {
    const r = await runStream(openaiSse, 1 << 20, { apiBase: 'https://x.test/v1', apiKey: 'k', modelName: 'deepseek-chat' });
    t('一整包送达（对照组）也对', r.fullText === WANT, r.fullText);
  }

  console.log('\n【二】Anthropic 直连格式（\\r\\n 行尾）');
  {
    const bad = [];
    for (let step = 1; step <= 13; step++) {
      const r = await runStream(anthroSse, step, { apiBase: 'https://x.test/v1/messages', apiKey: 'k', modelName: 'claude-x' });
      if (r.error || r.fullText !== WANT) bad.push({ step, got: r.fullText, err: r.error });
    }
    t('每种切法拼回来都一字不差', bad.length === 0, bad[0]);
  }

  console.log('\n【三】最后一行没带换行也不丢');
  {
    const sse = openaiSse.replace('data: [DONE]\n\n', '').replace(/\n\n$/, '');
    const r = await runStream(sse, 5, { apiBase: 'https://x.test/v1', apiKey: 'k', modelName: 'deepseek-chat' });
    t('末行无换行照样收进来', r.fullText === WANT, r.fullText);
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
