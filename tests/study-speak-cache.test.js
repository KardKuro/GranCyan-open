// 单词卡发音：前端音频缓存 + 预取。
// 跑法：node tests/study-speak-cache.test.js
//
// 守三件事：
// 1) 念过/预取过的词第二次点**不再发请求**（这就是"点下去立刻出声"的全部来源）；
// 2) 请求失败不进缓存——不然没连电脑时点一下，连上以后这个词永远念不出来；
// 3) 渲染路径上的预取：只取没答的题，而且在没有 fetch/location 的环境里不许把渲染搞挂。
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'js', '22-study.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name, extra ?? ''));

// 假 mp3：把文本塞进 256 字节里（前端要求 ≥200 字节，太短当空音频），Blob 再把文本解出来当 url
const fakeMp3 = text => { const b = new Uint8Array(256); b.set(new TextEncoder().encode(text)); return b.buffer; };
function FakeBlob(parts) { this.t = new TextDecoder().decode(new Uint8Array(parts[0])).replace(/\0+$/, ''); }

// 极简 IndexedDB：只够 _studyAudioDb 那几步（open → objectStore → get/put），数据放在传进来的 Map 里
function fakeIDB(store) {
  const later = f => setTimeout(f, 0);
  const os = { get(k) { const rq = {}; later(() => { rq.result = store.get(k); rq.onsuccess && rq.onsuccess(); }); return rq; },
               put(v, k) { store.set(k, v.slice(0)); } };
  const db = { transaction: () => ({ objectStore: () => os }), createObjectStore() {} };
  return { open() { const rq = { result: db }; later(() => { rq.onupgradeneeded && rq.onupgradeneeded(); rq.onsuccess && rq.onsuccess(); }); return rq; } };
}

// 假 Web Audio：解码出来的波形 = 前 185 个采样静音 + 100 个有声 + 400 个静音（采样率 1000，
// 照着实测的 Edge mp3「开头 185ms 空白、尾巴一大截空白」缩的）
function fakeAC(log) {
  const mkBuf = (len, fill) => { const d = new Float32Array(len); fill && fill(d); return { numberOfChannels: 1, sampleRate: 1000, length: len, getChannelData: () => d }; };
  return function () {
    this.state = 'running';
    this.destination = {};
    this.decodeAudioData = (ab, ok) => { log.decoded++; ok(mkBuf(685, d => { for (let i = 185; i < 285; i++) d[i] = 0.5; })); };
    this.createBuffer = (ch, len) => mkBuf(len);
    this.createBufferSource = () => ({ connect() {}, start(t) { log.started.push({ len: this.buffer.length, t, head: this.buffer.getChannelData(0)[25] }); }, stop() {} });
    this.resume = async () => {};
  };
}

function mk({ withFetch = true, failFirst = false, idb = null, audio = null, slow = 0 } = {}) {
  const calls = [];
  let n = 0, inflight = 0;
  const ctx = {
    console, Date, setTimeout, clearTimeout, Promise, ArrayBuffer, Uint8Array, Float32Array, Map, Set,
    state: { studyOn: true, studyCards: [], chats: [] },
    _call: { on: false }, save() {}, showToast(m) { (ctx.toasts = ctx.toasts || []).push(m); },
    SERVER_BASE: 'http://x', escHtml: s => String(s),
    Audio: function (u) { this.src = u; this.play = async () => { ctx.played = u; }; this.pause = () => {}; },
    URL: { createObjectURL: b => 'blob:' + b.t, revokeObjectURL() {} },
    Blob: FakeBlob,
    requestIdleCallback: f => f(),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  if (idb) ctx.indexedDB = fakeIDB(idb);
  if (audio) ctx.window = { AudioContext: fakeAC(audio) };
  if (withFetch) ctx.fetch = async u => {
    calls.push(u);
    inflight++; ctx.maxInflight = Math.max(ctx.maxInflight || 0, inflight);
    if (slow) await new Promise(r => setTimeout(r, slow));
    inflight--;
    if (failFirst && n++ === 0) return { ok: false, status: 502 };
    return { ok: true, arrayBuffer: async () => fakeMp3(decodeURIComponent(u.split('text=')[1].split('&')[0])) };
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.state.studyCards.push({ id: 'c1', lang: 'en', front: 'apple', back: '苹果', ex: 'An apple a day.', log: {} });
  ctx.state.studyCards.push({ id: 'c2', lang: 'de', front: 'der Apfel', back: '苹果', log: { a1: { g: 2 } } });
  return { ctx, calls };
}
const tick = () => new Promise(r => setTimeout(r, 5));

(async () => {
  console.log('\n[1] 第二次点不再发请求');
  {
    const { ctx, calls } = mk();
    await ctx.studySpeak('c1', null);
    await ctx.studySpeak('c1', null);
    t('同一个词点两次只请求一次', calls.length === 1, calls.length);
    t('放的是缓存里的 blob', ctx.played === 'blob:apple', ctx.played);
    await ctx.studySpeak('c1', null, 'example');
    t('例句单独缓存（再多一次请求，念的是例句）', calls.length === 2 && ctx.played === 'blob:An apple a day.');
  }

  console.log('\n[2] 失败不进缓存');
  {
    const { ctx, calls } = mk({ failFirst: true });
    await ctx.studySpeak('c1', null);
    t('第一次失败要吭声', (ctx.toasts || []).length === 1);
    await ctx.studySpeak('c1', null);
    t('第二次重新请求并且念出来了', calls.length === 2 && ctx.played === 'blob:apple', calls.length);
  }

  console.log('\n[3] 渲染路径上的预取');
  {
    const { ctx, calls } = mk();
    ctx.studyTagToHtml('[[CARDQ:c1|q1]] [[CARDQ:c2|a1]]');
    await tick();
    t('没答的题预取了正面', calls.some(u => u.includes('text=apple')), calls);
    t('答过的题不预取', !calls.some(u => u.includes('Apfel')), calls);
    ctx.studyTagToHtml('[[CARDQ:c1|q1]]');
    await tick();
    t('重画不会重复请求', calls.length === 1, calls.length);
    await ctx.studySpeak('c1', null);
    t('预取过的词点下去不再请求', calls.length === 1, calls.length);
  }
  {
    const { ctx } = mk({ withFetch: false });
    let ok = true;
    try { ctx.studyTagToHtml('[[CARDQ:c1|q1]]'); } catch (e) { ok = false; }
    t('没有 fetch 的环境里渲染照样不挂', ok);
  }

  console.log('\n[4] Web Audio：预先解码、裁掉开头静音');
  {
    const log = { decoded: 0, started: [] };
    const { ctx, calls } = mk({ audio: log });
    await ctx.studySpeak('c1', null);
    t('走的是 Web Audio（解码一次、用 BufferSource 放，没退回 <audio>）', log.decoded === 1 && log.started.length === 1 && !ctx.played, { log, played: ctx.played });
    const st = log.started[0] || {};
    t('开头 185ms 静音裁掉了（只留 20ms 起音）', st.head === 0.5 && st.t === 0, st);
    t('尾巴的静音也裁了（685 → 140 个采样）', st.len === 140, st.len);
    await ctx.studySpeak('c1', null);
    t('第二次点：不再请求也不再解码', calls.length === 1 && log.decoded === 1 && log.started.length === 2, { calls: calls.length, log });
  }

  console.log('\n[5] 本机持久缓存（IndexedDB）');
  {
    const store = new Map();
    const a = mk({ idb: store });
    await a.ctx.studySpeak('c1', null);
    await tick();
    t('第一次从后端拿，拿到就存进本机', a.calls.length === 1 && store.size === 1, { calls: a.calls.length, stored: store.size });
    const b = mk({ idb: store, withFetch: false });   // 重开 App：内存缓存空了，而且没网
    await b.ctx.studySpeak('c1', null);
    t('重开之后、没网也能念（从本机读出来）', b.ctx.played === 'blob:apple' && !(b.ctx.toasts || []).length, { played: b.ctx.played, toasts: b.ctx.toasts });
    const c = mk({ idb: store, failFirst: true });
    await c.ctx.studySpeak('c2', null);
    await tick();
    t('失败的不存进本机', store.size === 1, store.size);
  }

  console.log('\n[6] 整轮预取：排队、同时最多 2 个');
  {
    const { ctx, calls } = mk({ slow: 15 });
    for (let i = 0; i < 8; i++) ctx.state.studyCards.push({ id: 'p' + i, lang: 'en', front: 'w' + i, back: 'x', log: {} });
    ctx.studyPrefetchAudio(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    await new Promise(r => setTimeout(r, 200));
    t('8 个词全取到了', calls.length === 8, calls.length);
    t('同时在飞的请求没超过 2 个', ctx.maxInflight <= 2, ctx.maxInflight);
    const got = calls.map(u => decodeURIComponent(u.split('text=')[1].split('&')[0]));
    t('按出场顺序取', got.join(',') === 'w0,w1,w2,w3,w4,w5,w6,w7', got);
  }
  {
    const { ctx, calls } = mk({ slow: 15 });
    for (let i = 0; i < 6; i++) ctx.state.studyCards.push({ id: 'q' + i, lang: 'en', front: 'v' + i, back: 'x', log: {} });
    ctx.studyPrefetchAudio(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
    ctx.studyPrefetchAudio(['q5'], true);            // 翻到了 q5：插队
    await new Promise(r => setTimeout(r, 200));
    const got = calls.map(u => decodeURIComponent(u.split('text=')[1].split('&')[0]));
    t('眼前这张插队（前两个已经在飞，第三个就是它）', got[2] === 'v5' && calls.length === 6, got);
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
