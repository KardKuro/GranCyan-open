'use strict';
// TTS 音色 / 语速 / 音高契约：优先跑真实函数和真实路由，只在持久化接缝处做结构断言。
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

// 直接运行 server.js 里的真实 /api/tts handler；假 Edge 类只负责截获最终参数。
function makeServerRoute() {
  const calls = [];
  let route;
  class FakeTTS {
    setMetadata(voice, format) { this.voice = voice; this.format = format; return Promise.resolve(); }
    toStream(text, opts) {
      calls.push({ text, voice: this.voice, format: this.format, ...opts });
      const audioStream = new EventEmitter();
      setImmediate(() => { audioStream.emit('data', Buffer.alloc(256)); audioStream.emit('close'); });
      return { audioStream };
    }
  }
  const box = {
    require: name => {
      if (name !== 'msedge-tts') throw new Error('unexpected require: ' + name);
      return { MsEdgeTTS: FakeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' } };
    },
    app: { get: (p, fn) => { if (p === '/api/tts') route = fn; } },
    Buffer, console, Promise, parseInt, setImmediate,
    // 合成超时用的（常驻连接的半死兜底）；假 TTS 都是 setImmediate 就回，计时器永远不会真触发
    setTimeout: () => 1, clearTimeout: () => {}
  };
  vm.createContext(box);
  const edgePart = sourceBetween(serverSrc, 'let _MsEdgeTTS = null', 'const DEEPGRAM_TTS_KEY_FILE');
  const routePart = sourceBetween(serverSrc, "app.get('/api/tts'", '// ==========================================\n// 语音输入');
  vm.runInContext(edgePart
    + '\nasync function getDeepgramTTSKey() { return ""; }'
    + '\nasync function synthDeepgramTTS() { throw new Error("unused"); }\n'
    + routePart + '\nthis.__ttsCache = _ttsCache;', box);
  // 这份测的是参数白名单，同一句「你好」会反复发；每次先清掉合成缓存，否则第二次起根本到不了 Edge。
  // 缓存本身另有一组测试，走 cachedRoute（不清）。
  const cachedRoute = route;
  return { route: (req, res) => { box.__ttsCache.clear(); return cachedRoute(req, res); }, cachedRoute, calls };
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

function makeFrontend() {
  const urls = [];
  const btn = { textContent: '' };
  const box = {
    state: { ttsVoice: 'en-US-AndrewMultilingualNeural', ttsRate: -20, ttsPitch: -15 },
    SERVER_BASE: 'http://127.0.0.1:3000',
    document: { getElementById: () => btn },
    getActiveChat: () => ({ nodes: { 1: { content: '同一段文字' } } }),
    getMsgPlainText: n => n.content,
    showToast: () => {},
    fetch: url => { urls.push(url); return new Promise(() => {}); },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { pause() {} play() { return Promise.resolve(); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    speechSynthesis: { pause() {}, resume() {}, cancel() {}, speak() {}, getVoices: () => [] },
    setTimeout: () => 1, clearTimeout: () => {}, Math, Date, JSON, console, Object, Array,
    String, Number, Boolean, RegExp, Set, Promise, parseInt, isNaN
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(ttsSrc + ';this.toggleSpeak=toggleSpeak;this.previewTtsVoice=previewTtsVoice;this.pitch=_ttsPitchStr;', box);
  box.urls = urls;
  return box;
}

(async () => {
  console.log('\n【一】服务端 pitch 默认值与白名单');
  const srv = makeServerRoute();
  await invoke(srv.route, { text: '你好' });
  await invoke(srv.route, { text: '你好', pitch: '+0%' });
  t('★ 不传 pitch 与显式 +0% 行为一致',
    srv.calls[0].pitch === '+0%' && srv.calls[1].pitch === '+0%', srv.calls.slice(0, 2));

  const invalid = ["'; malicious", '10', '+999%', '', '-51%', '+21%'];
  for (const pitch of invalid) await invoke(srv.route, { text: '你好', pitch });
  const invalidCalls = srv.calls.slice(2);
  t('★ 非法 pitch 全部退回 +0%，不会交给 SSML 生成器',
    invalidCalls.length === invalid.length && invalidCalls.every(c => c.pitch === '+0%'), invalidCalls);

  await invoke(srv.route, { text: '你好', pitch: '-50%' });
  await invoke(srv.route, { text: '你好', pitch: '+20%' });
  t('★ 服务端接受的 pitch 边界正是 -50..20',
    srv.calls.at(-2).pitch === '-50%' && srv.calls.at(-1).pitch === '+20%', srv.calls.slice(-2));

  console.log('\n【二】朗读和试听共用参数');
  const front = makeFrontend();
  front.toggleSpeak(1);
  front.previewTtsVoice();
  const params = front.urls.map(u => new URL(u).searchParams);
  const contract = p => p.get('voice') === 'en-US-AndrewMultilingualNeural'
    && p.get('rate') === '-20%' && p.get('pitch') === '-15%';
  t('★ 朗读和试听真正发出同一套 voice/rate/pitch',
    params.length === 2 && params.every(contract), front.urls);

  console.log('\n【三】ttsPitch 持久化与云同步白名单');
  const stateDefaults = sourceBetween(stateSrc, 'let state = {', '\n};');
  t('★ ttsPitch 有 state 默认值', /\bttsPitch:\s*0\b/.test(stateDefaults));
  t('★ ttsPitch 会写入 IndexedDB', /idbSet\('kuro_ttsPitch',\s*String\(state\.ttsPitch\s*\|\|\s*0\)\)/.test(stateSrc));
  t('★ ttsPitch 会从 IndexedDB 读回', /ttsPitch:\s*parseInt\(await g\('kuro_ttsPitch',\s*0\)\)\s*\|\|\s*0/.test(coreSrc));
  t('★ ttsPitch 启动时会赋回 state', /state\.ttsPitch\s*=\s*parseInt\(saved\.ttsPitch\)\s*\|\|\s*0/.test(bootSrc));
  t('★ 云同步 push 带 ttsPitch', /ttsPitch:\s*state\.ttsPitch\s*\|\|\s*0/.test(coreSrc));
  t('★ 云同步 merge 用 ?? 保住用户的 0', /state\.ttsPitch\s*=\s*s\.ttsPitch\s*\?\?\s*state\.ttsPitch/.test(coreSrc));

  console.log('\n【四】音色合法性与三处范围一致');
  const english = sourceBetween(html, '<optgroup label="英语">', '</optgroup>');
  const voices = [...english.matchAll(/<option\s+value="([^"]+)"/g)].map(m => m[1]);
  t('★ 11 个英语音色 value 全部符合服务端白名单',
    voices.length === 11 && voices.every(v => /^[A-Za-z0-9\-]+$/.test(v)), voices);

  const rangeTag = (html.match(/<input[^>]+id="ttsPitchRange"[^>]*>/) || [''])[0];
  const min = Number((rangeTag.match(/\bmin="(-?\d+)"/) || [])[1]);
  const max = Number((rangeTag.match(/\bmax="(-?\d+)"/) || [])[1]);
  front.state.ttsPitch = -999;
  const low = front.pitch();
  front.state.ttsPitch = 999;
  const high = front.pitch();
  t('★ 滑条与 _ttsPitchStr 的范围一致（-50..20）',
    min === -50 && max === 20 && low === '-50%' && high === '+20%', { min, max, low, high });

  console.log('\n【五】试听不许叠着响（用户报的「念两遍」）');
  {
    // 这里的 fetch 是**可控的**：不自己 resolve，测试说了算 ——
    // 因为要复现的正是「上一次请求还在路上」的那个窗口，用真 fetch 复现不了。
    // deadAbort=true 模拟「abort 不管用」的运行时（安卓 WebView 上遇到过这类降级）。
    // 这不是为了凑用例：abort 是第一道闸，_ttsToken 是第二道；只测正常情况的话
    // 第二道永远走不到，拆掉它测试也不会红 —— 那这道闸就等于没人守着。
    function makePreview(deadAbort) {
      const pending = [], aborted = [], played = [], spoken = [];
      const btn = { textContent: '' };
      const box = {
        state: { ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsVoiceZh: 'zh-CN-XiaoxiaoNeural', ttsRate: 0, ttsPitch: 0 },
        SERVER_BASE: 'http://127.0.0.1:3000',
        document: { getElementById: () => btn },
        getActiveChat: () => null, getMsgPlainText: n => n.content, showToast: () => {},
        fetch: (url, opt) => new Promise((res, rej) => {
          const rec = { url, res, rej };
          if (opt && opt.signal) opt.signal.onabort = () => { aborted.push(url); if (!deadAbort) rej(new Error('aborted')); };
          pending.push(rec);
        }),
        AbortController: class { constructor() { this.signal = { onabort: null }; } abort() { if (this.signal.onabort) this.signal.onabort(); } },
        Audio: class { constructor(src) { this.src = src; } pause() {} play() { played.push(this.src); return Promise.resolve(); } },
        URL: { createObjectURL: () => 'blob:preview-' + played.length, revokeObjectURL: () => {} },
        SpeechSynthesisUtterance: function (t) { this.text = t; },
        speechSynthesis: { pause() {}, resume() {}, cancel() {}, speak: u => spoken.push(u.text), getVoices: () => [] },
        setTimeout: () => 1, clearTimeout: () => {}, Math, Date, JSON, console, Object, Array,
        String, Number, Boolean, RegExp, Set, Promise, parseInt, isNaN, encodeURIComponent
      };
      box.window = box;
      vm.createContext(box);
      vm.runInContext(ttsSrc + ';this.preview=previewTtsVoice;this.stopSpeaking=ttsStopSpeaking;'
        + 'this.previewAudio=()=>_ttsPreviewAudio;', box);
      box.pending = pending; box.aborted = aborted; box.played = played; box.spoken = spoken;
      return box;
    }
    const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));
    const ok = { ok: true, blob: async () => ({ size: 4096 }) };

    let f = makePreview();
    f.preview();                       // 下拉框 onchange 那一次
    f.preview();                       // 紧接着点「▶ 试听」——第一次还在路上
    f.pending.forEach(p => p.res(ok)); // 两个请求同时回来
    await tick(); await tick();
    t('★★ 两次试听落在同一个请求窗口里，只响一次（不是两遍叠着）',
      f.played.length === 1, { 播放: f.played, 请求: f.pending.length });
    t('★ 被顶掉那次的请求真的 abort 了，不是放着不管',
      f.aborted.length === 1, f.aborted);
    t('★ 被 abort 的那次不许退回系统语音再念一遍（换个嗓子叠还是叠）',
      f.spoken.length === 0, f.spoken);

    f = makePreview(true);             // abort 装死，只剩 _ttsToken 那道闸
    f.preview();
    f.preview();
    f.pending.forEach(p => p.res(ok));
    await tick(); await tick();
    t('★★ abort 不管用时，token 那道闸还拦得住（第二道防线单独有效）',
      f.played.length === 1, { 播放: f.played, abort调用: f.aborted.length });

    f = makePreview();
    f.preview();
    f.pending[0].res(ok);
    await tick(); await tick();
    f.stopSpeaking();                  // 朗读那边的「别念了」也要能停住试听
    t('★ ttsStopSpeaking 能停掉正在响的试听并清干净',
      f.previewAudio() === null, { audio: f.previewAudio() });

    f = makePreview();
    f.preview();
    f.pending[0].rej(new Error('后端没起来'));
    await tick(); await tick();
    t('★ 真失败（不是被顶掉）时，系统语音兜底还在',
      f.spoken.length === 1, f.spoken);
  }

  console.log('\n【缓存】同一句话第二次不再打 Edge（单词卡反复点喇叭）');
  {
    const c = makeServerRoute();
    const r1 = await invoke(c.cachedRoute, { text: 'apple', voice: 'en-US-AriaNeural' });
    const r2 = await invoke(c.cachedRoute, { text: 'apple', voice: 'en-US-AriaNeural' });
    t('★ 第二次命中缓存：只合成了一次、回的是同一段音频',
      c.calls.length === 1 && r2.headers['X-TTS-Cache'] === 'hit' && r2.body === r1.body,
      { calls: c.calls.length, hdr: r2.headers['X-TTS-Cache'] });
    await invoke(c.cachedRoute, { text: 'apple', voice: 'de-DE-KatjaNeural' });
    await invoke(c.cachedRoute, { text: 'apple', voice: 'en-US-AriaNeural', pitch: '-10%' });
    await invoke(c.cachedRoute, { text: 'apple', voice: 'en-US-AriaNeural', rate: '+20%' });
    await invoke(c.cachedRoute, { text: 'Apple', voice: 'en-US-AriaNeural' });
    t('★ 换音色 / 音高 / 语速 / 大小写都不串缓存', c.calls.length === 5, c.calls.length);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
