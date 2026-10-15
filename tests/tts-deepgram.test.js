'use strict';
// Deepgram（aura-*）音色的分流契约。
//
// ⚠️ 这份测试永远不会真的打到 Deepgram —— fetch 是假的，key 也是编的，
//    跑一万遍也不花用户一分钱。谁以后往这里加用例，也守住这条。
//
// 要守的东西有两类：
//   1. 分流本身（哪些音色走 Deepgram、哪些不走），两个方向都要测；
//   2. 中文兜底 —— Deepgram 拿到中文会返回 HTTP 200 + 一段听不懂的噪音，
//      是**静默失败**，只能在客户端提前拦。这里必须测「真的换成中文音色发出去了」，
//      光测「没发给 Deepgram」不够：一个什么都不做的实现也能让后者永远成立。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const serverSrc = read('server.js');
const ttsSrc = read('js/07-band-tts.js');
const coreSrc = read('js/01-core.js');
const stateSrc = read('js/02-state.js');
const bootSrc = read('js/14-boot-brain-hub.js');
const html = read('index.html');

// 假 key 里埋一段独一无二的字样，用来在响应体和日志里搜「有没有漏出去」
const FAKE_KEY = 'dgk-LEAKCANARY-7f3a91';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

function sourceBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('切不出源码片段：' + from + ' → ' + to);
  return src.slice(a, b);
}

// 真的 /api/tts handler + 真的 Deepgram 适配器；只有 msedge-tts、fetch、fsp 是假的。
function makeServerRoute(opts) {
  opts = opts || {};
  const edgeCalls = [], dgCalls = [], logs = [];
  let route;
  class FakeTTS {
    setMetadata(voice) { this.voice = voice; return Promise.resolve(); }
    toStream(text, o) {
      edgeCalls.push(Object.assign({ text, voice: this.voice }, o));
      const audioStream = new EventEmitter();
      setImmediate(() => { audioStream.emit('data', Buffer.alloc(4096)); audioStream.emit('close'); });
      return { audioStream };
    }
  }
  const box = {
    require: name => {
      if (name !== 'msedge-tts') throw new Error('unexpected require: ' + name);
      return { MsEdgeTTS: FakeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' } };
    },
    app: { get: (p, fn) => { if (p === '/api/tts') route = fn; } },
    path, os: { homedir: () => path.join('/fake', 'home') },
    fsp: {
      readFile: async () => {
        if (opts.fileKey == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return opts.fileKey;
      }
    },
    process: { env: opts.env || {} },
    // 合成超时用的（常驻连接的半死兜底）；假 TTS 都是 setImmediate 就回，计时器永远不会真触发
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url, init) => {
      dgCalls.push({ url: String(url), init });
      if (opts.dgFail) throw new Error('boom');
      if (opts.dgNotOk) return { ok: false, status: 401 };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4096) };
    },
    URL, Buffer, Error, JSON, String, Object, Promise, parseInt, setImmediate,
    console: {
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' '))
    }
  };
  vm.createContext(box);
  vm.runInContext(
    sourceBetween(serverSrc, 'let _MsEdgeTTS = null', 'const DEEPGRAM_TTS_KEY_FILE')
    + sourceBetween(serverSrc, 'const DEEPGRAM_TTS_KEY_FILE', "app.get('/api/tts'")
    + sourceBetween(serverSrc, "app.get('/api/tts'", '// ==========================================\n// 语音输入')
    + '\nthis.__ttsCache = _ttsCache;',
    box);
  // 这份测的是分流，同一句 'hi' 会反复发；每次先清掉合成缓存，否则第二次起根本到不了 Edge
  const raw = route;
  return { route: (req, res) => { box.__ttsCache.clear(); return raw(req, res); }, edgeCalls, dgCalls, logs };
}

async function invoke(route, query) {
  const res = {
    headersSent: false, statusCode: 200, headers: {}, body: null,
    status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; this.headersSent = true; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    end(v) { this.body = v; this.headersSent = true; return this; }
  };
  await route({ query }, res);
  return res;
}

// 前端：跑真的 _ttsUrl / _ttsVoiceForText，只截住发出去的 URL
function makeFrontend(st) {
  const urls = [], toasts = [];
  const btn = { textContent: '' };
  const box = {
    state: Object.assign(
      { ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoxiaoNeural', ttsRate: -20, ttsPitch: -15 },
      st || {}),
    SERVER_BASE: 'http://127.0.0.1:3000',
    document: { getElementById: () => btn },
    getActiveChat: () => ({ nodes: { 1: { content: '同一段文字' } } }),
    getMsgPlainText: n => n.content,
    showToast: m => toasts.push(String(m)),
    fetch: url => { urls.push(url); return new Promise(() => {}); },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { pause() {} play() { return Promise.resolve(); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    speechSynthesis: { pause() {}, resume() {}, cancel() {}, speak() {}, getVoices: () => [] },
    setTimeout: () => 1, clearTimeout: () => {}, Math, Date, JSON, console, Object, Array,
    String, Number, Boolean, RegExp, Set, Promise, parseInt, isNaN, encodeURIComponent
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(ttsSrc + ';this.ttsUrl=_ttsUrl;this.previewTtsVoice=previewTtsVoice;', box);
  box.urls = urls; box.toasts = toasts;
  return box;
}
const qOf = url => Object.fromEntries(new URL(url).searchParams);
// 一条断言不成立不该把后面 30 条一起带走。
// 这份测试里到处要读 dgCalls[0].url / .init，缺了就是 TypeError → 整个套件崩 →
// 剩下的断言一条都不跑，看上去像「只红了一条」。故障注入当场逮到过一次，所以有了这两个。
const dgUrl = s => new URL((s.dgCalls[0] || {}).url || 'https://absent.invalid/');
const dgInit = s => (s.dgCalls[0] || {}).init || { headers: {}, body: '{}' };

(async () => {
  console.log('\n【一】服务端分流：只有 aura- 前缀走 Deepgram');
  {
    const s = makeServerRoute({ env: { DEEPGRAM_API_KEY: FAKE_KEY } });
    await invoke(s.route, { text: 'Hello there.', voice: 'aura-2-hyperion-en' });
    t('★ aura- 音色真的打到了 Deepgram，且没顺手也走一遍 Edge',
      s.dgCalls.length === 1 && s.edgeCalls.length === 0,
      { dg: s.dgCalls.length, edge: s.edgeCalls.length });

    const u = dgUrl(s);
    t('★ Deepgram 请求带的是 canonical model 名和 mp3 编码',
      u.origin + u.pathname === 'https://api.deepgram.com/v1/speak'
      && u.searchParams.get('model') === 'aura-2-hyperion-en'
      && u.searchParams.get('encoding') === 'mp3', dgUrl(s).href);
    t('★ Authorization 是 Token 形式，文本走 body 不走 query',
      dgInit(s).headers.Authorization === 'Token ' + FAKE_KEY
      && JSON.parse(dgInit(s).body).text === 'Hello there.'
      && !u.searchParams.has('text'), Object.keys(dgInit(s).headers));
  }
  {
    // 反方向：长得像但不是前缀的，一个都不许漏过去
    const s = makeServerRoute({ env: { DEEPGRAM_API_KEY: FAKE_KEY } });
    const notDg = ['zh-CN-XiaoxiaoNeural', 'en-US-AndrewMultilingualNeural',
      'en-US-AuraNeural', 'my-aura-2-voice', 'aura', 'Aura-2-hyperion-en'];
    for (const voice of notDg) await invoke(s.route, { text: 'hi', voice });
    t('★ 非 aura- 前缀的音色一个都没打到 Deepgram（含大小写和中缀陷阱）',
      s.dgCalls.length === 0 && s.edgeCalls.length === notDg.length,
      { dg: s.dgCalls.length, edge: s.edgeCalls.length, notDg });
    await invoke(s.route, { text: 'hi' });
    t('★ 默认音色（不传 voice）走 Edge', s.dgCalls.length === 0 && s.edgeCalls.length === notDg.length + 1);
  }

  console.log('\n【二】Deepgram 这条路上没有 rate / pitch');
  {
    const s = makeServerRoute({ env: { DEEPGRAM_API_KEY: FAKE_KEY } });
    await invoke(s.route, { text: 'Hello.', voice: 'aura-2-hyperion-en', rate: '-20%', pitch: '-15%' });
    const u = dgUrl(s);
    const body = JSON.parse(dgInit(s).body);
    t('★ 就算前端硬塞了 rate/pitch，也不会跟着发给 Deepgram（它不认这两个）',
      !u.searchParams.has('rate') && !u.searchParams.has('pitch')
      && !('rate' in body) && !('pitch' in body), { url: dgUrl(s).href, body });
  }

  console.log('\n【三】key：来源优先级、缺失、以及绝不外泄');
  {
    const s = makeServerRoute({ env: {}, fileKey: null });
    const res = await invoke(s.route, { text: 'hi', voice: 'aura-2-hyperion-en' });
    t('★ 没配 key → 501，而且没有偷偷降级去 Edge 拿别的嗓子糊弄',
      res.statusCode === 501 && s.dgCalls.length === 0 && s.edgeCalls.length === 0, res.body);
  }
  {
    const s = makeServerRoute({ env: {}, fileKey: '  ' + FAKE_KEY + '\n' });
    await invoke(s.route, { text: 'hi', voice: 'aura-2-hyperion-en' });
    t('★ key 从 ~/.deepgram/key.txt 读得到，且首尾空白被 trim 掉',
      s.dgCalls.length === 1 && dgInit(s).headers.Authorization === 'Token ' + FAKE_KEY,
      dgInit(s).headers.Authorization);
  }
  {
    const s = makeServerRoute({ env: { DEEPGRAM_API_KEY: FAKE_KEY }, fileKey: 'file-key-should-lose' });
    await invoke(s.route, { text: 'hi', voice: 'aura-2-hyperion-en' });
    t('★ 环境变量优先于 key 文件',
      dgInit(s).headers.Authorization === 'Token ' + FAKE_KEY);
  }
  {
    // 上游 401 / fetch 抛异常：两种失败都不许把 key 写进响应或日志
    for (const [why, opt] of [['上游 401', { dgNotOk: true }], ['fetch 抛异常', { dgFail: true }]]) {
      const s = makeServerRoute(Object.assign({ env: { DEEPGRAM_API_KEY: FAKE_KEY } }, opt));
      const res = await invoke(s.route, { text: 'hi', voice: 'aura-2-hyperion-en' });
      const blob = JSON.stringify(res.body) + '||' + s.logs.join('||');
      t('★ ' + why + ' → 502，且响应体和日志里都搜不到 key',
        res.statusCode === 502 && !blob.includes(FAKE_KEY) && !blob.includes('LEAKCANARY'),
        { status: res.statusCode, blob });
    }
  }

  console.log('\n【四】中文兜底 —— Deepgram 收到中文是 200 + 噪音，只能在前端拦');
  {
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    const q = qOf(f.ttsUrl('今天想你了。'));
    t('★★ 中文 + Deepgram 音色 → 真的用 ttsVoiceZh 发出去了（不是「什么都没发」）',
      q.voice === 'zh-CN-XiaoyiNeural' && q.text === '今天想你了。', q);
    t('★ 兜底之后 rate/pitch 会回来（Edge 音色认这两个）',
      q.rate === '-20%' && q.pitch === '-15%', q);
    t('★ 兜底时给了提示，不是默默换嗓子', f.toasts.some(m => m.includes('中文')), f.toasts);
  }
  {
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    const q = qOf(f.ttsUrl('Say it again, slower.'));
    t('★★ 纯英文 + Deepgram 音色 → 没有误伤，还是 aura', q.voice === 'aura-2-hyperion-en', q);
    t('★ Deepgram 这条路上前端不发 rate/pitch', !('rate' in q) && !('pitch' in q), q);
    t('★ 纯英文不该弹「不支持中文」的提示', f.toasts.length === 0, f.toasts);
  }
  {
    // 中日韩三段码位分别抽一个字，别只测常用汉字区
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    const got = ['好', '㐁', '豈'].map(c => qOf(f.ttsUrl('ok ' + c)).voice);
    t('★ 三段 CJK 码位都能触发兜底', got.every(v => v === 'zh-CN-XiaoyiNeural'), got);
  }
  {
    const f = makeFrontend({ ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    const q = qOf(f.ttsUrl('今天想你了。'));
    t('★ 没选 Deepgram 的时候兜底逻辑完全不掺和', q.voice === 'zh-CN-XiaoxiaoNeural', q);
  }
  {
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: '' });
    const q = qOf(f.ttsUrl('你好'));
    t('★ ttsVoiceZh 是空的也有兜底的兜底（晓晓），不会把空音色发出去',
      q.voice === 'zh-CN-XiaoxiaoNeural', q);
  }
  {
    // 贯通：前端生成的 URL 直接喂给真服务端，确认中文那条真的落在 Edge 上
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    const s = makeServerRoute({ env: { DEEPGRAM_API_KEY: FAKE_KEY } });
    await invoke(s.route, qOf(f.ttsUrl('你好呀')));
    await invoke(s.route, qOf(f.ttsUrl('Hello there')));
    t('★★ 端到端：中文那条落在 Edge 且用的是中文音色，英文那条落在 Deepgram',
      s.edgeCalls.length === 1 && s.edgeCalls[0].voice === 'zh-CN-XiaoyiNeural'
      && s.dgCalls.length === 1
      && dgUrl(s).searchParams.get('model') === 'aura-2-hyperion-en',
      { edge: s.edgeCalls.map(c => c.voice), dg: s.dgCalls.map(c => c.url) });
  }
  {
    // 试听必须走同一个 _ttsUrl，不能自己拼一份（这两条路分叉过一次，这里钉住）
    const f = makeFrontend({ ttsVoice: 'aura-2-hyperion-en', ttsVoiceZh: 'zh-CN-XiaoyiNeural' });
    f.previewTtsVoice();
    const q = qOf(f.urls[0] || 'https://absent.invalid/');
    t('★ 选了 Deepgram 时试听用英文文案 + aura 音色（不会拿中文去撞噪音）',
      q.voice === 'aura-2-hyperion-en' && !/[一-鿿]/.test(q.text), q);
  }

  console.log('\n【五】ttsVoiceZh 的三道闸 + 云同步');
  const stateDefaults = sourceBetween(stateSrc, 'let state = {', '\n};');
  t('★ ttsVoiceZh 有 state 默认值', /ttsVoiceZh:\s*'zh-CN-XiaoxiaoNeural'/.test(stateDefaults));
  t('★ ttsVoiceZh 会写入 IndexedDB',
    /idbSet\('kuro_ttsVoiceZh',\s*state\.ttsVoiceZh\s*\|\|\s*'zh-CN-XiaoxiaoNeural'\)/.test(stateSrc));
  t('★ ttsVoiceZh 会从 IndexedDB 读回',
    /ttsVoiceZh:\s*await g\('kuro_ttsVoiceZh',\s*'zh-CN-XiaoxiaoNeural'\)/.test(coreSrc));
  t('★ ttsVoiceZh 启动时会赋回 state',
    /state\.ttsVoiceZh\s*=\s*saved\.ttsVoiceZh\s*\|\|\s*'zh-CN-XiaoxiaoNeural'/.test(bootSrc));
  t('★ 云同步 push 带 ttsVoiceZh',
    /ttsVoiceZh:\s*state\.ttsVoiceZh\s*\|\|\s*'zh-CN-XiaoxiaoNeural'/.test(coreSrc));
  t('★ 云同步 merge 用 ?? 不用 ||',
    /state\.ttsVoiceZh\s*=\s*s\.ttsVoiceZh\s*\?\?\s*state\.ttsVoiceZh/.test(coreSrc));

  console.log('\n【六】界面：Deepgram 音色在选单里，而且旋钮会禁掉');
  {
    const dg = sourceBetween(html, '<optgroup label="Deepgram', '</optgroup>');
    const vals = [...dg.matchAll(/<option\s+value="([^"]+)"/g)].map(m => m[1]);
    t('★ Deepgram 分组里的 value 全是 aura- 前缀且符合服务端白名单',
      vals.length > 0 && vals.every(v => v.startsWith('aura-') && /^[A-Za-z0-9\-]+$/.test(v)), vals);
    t('★ 有中文兜底音色的下拉框和它的容器',
      /id="ttsVoiceZhSelect"/.test(html) && /id="ttsVoiceZhWrap"/.test(html));
    const sync = sourceBetween(ttsSrc, "const zhSel = document.getElementById('ttsVoiceZhSelect')", '\n}');
    t('★ 选 Deepgram 时语速/音高滑条会被禁用（它们发不出去，留着是骗人的）',
      /r\.disabled\s*=\s*deepgram/.test(sync) && /p\.disabled\s*=\s*deepgram/.test(sync), sync);
    t('★ 选 Deepgram 时中文兜底那一块才显示', /zhWrap\.style\.display\s*=\s*deepgram\s*\?/.test(sync));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
