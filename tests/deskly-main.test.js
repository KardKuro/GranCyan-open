'use strict';
// 桌面歌词独立悬浮窗：主进程只信「洗过的数据」、改大小夹边界；
// 点歌台：播放现场落盘（队列 + 正在放的那首 + 进度）、重启装回来接着放、放不了的歌自动跳过、换歌预取地址；
// 以及系统媒体控制、全屏歌词能滚动的 CSS。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { cleanLyric, clampBounds } = require('../deskly-main.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let n = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('cleanLyric：关闭态只剩 on:false', () => assert.deepStrictEqual(cleanLyric({ on: false, rows: [1] }), { on: false }));
t('cleanLyric：最多六行（两句一页各带副行）、截长、class 白名单、进度夹 0-100、g 只认 0/1', () => {
  const c = cleanLyric({ on: true, rows: [{ t: 'a'.repeat(999), c: 'evil"><x', p: 500 }, { t: 'b', c: 'cur', p: -3 }, { t: 'c', k: 'tr' },
    { t: 'd', g: 1 }, { t: 'e', g: 7 }, { t: 'f', g: '1' }, { t: 'g' }] });
  assert.strictEqual(c.rows.length, 6);
  assert.strictEqual(c.rows[2].k, 'tr');
  assert.deepStrictEqual(c.rows.map(r => r.g), [0, 0, 0, 1, 0, 0]);
  assert.strictEqual(c.rows[0].t.length, 300);
  assert.strictEqual(c.rows[0].c, '');
  assert.strictEqual(c.rows[0].p, 100);
  assert.strictEqual(c.rows[1].c, 'cur');
  assert.strictEqual(c.rows[1].p, 0);
});
t('cleanLyric：accent 只认 #hex / rgb()，别的丢掉', () => {
  assert.strictEqual(cleanLyric({ on: true, rows: [], accent: '#c6ff00' }).accent, '#c6ff00');
  assert.strictEqual(cleanLyric({ on: true, rows: [], accent: 'red;background:url(x)' }).accent, '');
});
t('cleanLyric：字体名放行 app 的那串宋体，带分号/括号的丢掉', () => {
  const app = `"Cormorant Garamond", SimSun, 宋体, "Songti SC", STSong, "Noto Serif SC", serif`;
  assert.strictEqual(cleanLyric({ on: true, rows: [], font: app }).font, app);
  assert.strictEqual(cleanLyric({ on: true, rows: [], font: 'x;background:url(evil)' }).font, '');
  assert.strictEqual(cleanLyric({ on: true, rows: [], font: 'a'.repeat(300) }).font, '');
});
t('cleanLyric：副行种类只认 ro/tr，「音」「译」开关只留布尔', () => {
  const c = cleanLyric({ on: true, rows: [{ t: 'x', k: 'evil' }, { t: 'y', k: 'ro' }], opts: { hasRo: 'yes', hasTr: 0, ro: 1, tr: '<x>', extra: 'z' } });
  assert.strictEqual(c.rows[0].k, '');
  assert.strictEqual(c.rows[1].k, 'ro');
  assert.strictEqual(JSON.stringify(c.opts), '{"hasRo":true,"hasTr":false,"ro":true,"tr":true}');
  assert.strictEqual(JSON.stringify(cleanLyric({ on: true, rows: [] }).opts), '{"hasRo":false,"hasTr":false,"ro":false,"tr":false}');
});
t('cleanLyric：垃圾输入不抛', () => { assert.strictEqual(cleanLyric(null), null); assert.strictEqual(cleanLyric('x'), null); });
t('clampBounds：夹最小尺寸、不超过屏幕、不许整个拖出屏幕', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepStrictEqual(clampBounds({ x: 100, y: 100, width: 10, height: 5 }, wa), { x: 100, y: 100, width: 240, height: 56 });
  assert.strictEqual(clampBounds({ x: 0, y: 0, width: 5000, height: 5000 }, wa).width, 1920);
  const far = clampBounds({ x: 99999, y: -9999, width: 600, height: 120 }, wa);
  assert.ok(far.x <= 1920 - 40 && far.y >= -10, JSON.stringify(far));
  assert.deepStrictEqual(clampBounds({ x: 'a', y: null, width: NaN, height: undefined }, wa), { x: 0, y: 0, width: 240, height: 56 });
});

// ── 点歌台的播放现场：把 24-music.js 里真的那几个函数拎进沙箱跑 ──
const music = read('js/24-music.js');
function funcBody(s, name) {
  let i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('源码里找不到 function ' + name);
  if (s.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  throw new Error('括号不配对：' + name);
}
const FUNCS = ['_mSessSave', '_mPosSave', '_mSessLoad', '_mFadeStop', '_mFade', '_mUrlTake', '_mUrlPrefetch', '_mAudioEl', 'musicPlay', 'musicToggle', 'musicNext', 'musicStop', '_mSlim', '_mSameSong'];
function box(store, urls) {
  const noop = () => {};
  const b = {
    console, Math, Date, JSON, String, Object, Promise, Array, Number, isFinite, setInterval, clearInterval, setTimeout,
    toasts: [], fetched: [],
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    showToast: m => b.toasts.push(m), _mPaint: noop, _mPlayFailed: noop, musicNoteRecent: noop, musicLoadLyric: noop,
    _mCoverTint: noop, _mListen: noop, _mTick: noop, _mMediaSync: noop, _mMediaWire: noop, _mRC: () => false,
    _mFluidSet: noop, _mApplyTint: noop, _mDrawerSet: noop,
    musicFetchUrl: id => { b.fetched.push(String(id)); return Promise.resolve(urls[id] || ''); },
    Audio: function () {
      const a = { src: '', paused: true, currentTime: 0, volume: 1, plays: [], L: {},
        addEventListener: (k, f) => { (a.L[k] = a.L[k] || []).push(f); },
        removeAttribute() { a.src = ''; }, load() {},
        play() { a.plays.push(a.src); a.paused = false; return Promise.resolve(); }, pause() { a.paused = true; } };
      b.audio = a; return a;
    },
  };
  vm.createContext(b);
  vm.runInContext('var _mAudio = null, _mNow = null, _mQueue = [], _mCtx = null, _mPlayReq = 0, _mLyricReq = 0, _mTintReq = 0, _mRemote = null,'
    + ' _mSwitching = false, _mSkipRun = 0, _mFadeTimer = 0, _mFadeGen = 0, _mUrlCache = null, _mPosAt = 0, _mMode = "list", _mRate = 1,'
    + ' _mWordCur = -1, _mLyric = null, _mTint = null;\n' + FUNCS.map(f => funcBody(music, f)).join('\n'), b);
  return b;
}
const S = (id, name) => ({ id, name: name || 'song' + id, artist: 'x', cover: '' });
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 10)); } return true; };

t('重启：队列、整张单子、正在放的那首、进度都装回来（那首是「停着」的）', async () => {
  const store = new Map();
  const a = box(store, { 1: 'u1', 2: 'u2', 3: 'u3' });
  vm.runInContext('_mCtx = [' + [1, 2, 3].map(i => `{id:${i},name:"s${i}"}`).join(',') + ']; _mQueue = [{id:2,name:"s2"},{id:3,name:"s3"}];', a);
  await a.musicPlay(S(1), 'u1');
  a.audio.currentTime = 83.6;
  vm.runInContext('_mPosSave(true)', a);
  const b = box(store, { 1: 'u1-fresh' });
  vm.runInContext('_mSessLoad()', b);
  const r = vm.runInContext('({ q: _mQueue.length, ctx: _mCtx && _mCtx.length, id: _mNow && _mNow.id, resume: _mNow && _mNow._resume, t: _mNow && _mNow._resumeT, audio: _mAudio })', b);
  assert.deepStrictEqual([r.q, r.ctx, r.id, r.resume, r.t, r.audio], [2, 3, 1, true, 83, null]);
});
t('重启后按 ▶：重新取地址，从存下的那一秒接着放', async () => {
  const store = new Map();
  store.set('kuro_musicSess', JSON.stringify({ queue: [S(2)], ctx: null, now: S(1) }));
  store.set('kuro_musicPos', JSON.stringify({ id: 1, t: 83 }));
  const b = box(store, { 1: 'u1-fresh' });
  vm.runInContext('_mSessLoad()', b);
  b.musicToggle();
  assert.ok(await until(() => b.audio && b.audio.plays.length), '没放起来');
  assert.strictEqual(b.audio.src, 'u1-fresh');
  assert.strictEqual(b.audio.currentTime, 83);
  assert.strictEqual(vm.runInContext('_mNow._resume', b), false);
  assert.strictEqual(vm.runInContext('_mQueue.length', b), 1);
});
t('进度对不上号的旧歌不记：换歌途中 <audio> 里还是上一首', () => {
  const store = new Map();
  const b = box(store, {});
  vm.runInContext('_mAudio = { src: "uOld", currentTime: 50 }; _mNow = { id: 9, url: undefined, _resumeT: 0 };', b);
  vm.runInContext('_mPosSave(true)', b);
  assert.deepStrictEqual(JSON.parse(store.get('kuro_musicPos')), { id: 9, t: 0 });
});
t('杀歌后重启不再把那首装回来，队列照留', async () => {
  const store = new Map();
  const a = box(store, { 1: 'u1' });
  vm.runInContext('_mQueue = [{id:2,name:"s2"}];', a);
  await a.musicPlay(S(1), 'u1');
  a.musicStop();
  const b = box(store, {});
  vm.runInContext('_mSessLoad()', b);
  assert.strictEqual(vm.runInContext('JSON.stringify([_mNow, _mQueue.length])', b), '[null,1]');
});
t('队列里放不了的歌（没版权）自动跳过，接着放下一首', async () => {
  const b = box(new Map(), { 1: 'u1', 3: 'u3' });
  vm.runInContext('_mQueue = [{id:2,name:"无版权"},{id:3,name:"s3"}];', b);
  await b.musicPlay(S(1), 'u1');
  b.musicNext();
  assert.ok(await until(() => b.audio.src === 'u3'), '没跳到第三首：' + b.audio.src);
  assert.ok(b.toasts.some(m => /无版权.*跳过/.test(m)), JSON.stringify(b.toasts));
});
t('整张单子都放不了：跳 5 首就停，不空转', async () => {
  const b = box(new Map(), {});
  vm.runInContext('_mCtx = [{id:7,name:"a"},{id:8,name:"b"}];', b);
  b.musicNext();
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(b.fetched.length <= 7, '取了 ' + b.fetched.length + ' 次');
  assert.strictEqual(vm.runInContext('_mSkipRun', b), 0);
  assert.strictEqual(vm.runInContext('_mNow', b), null);
});
t('列表循环：下一首的地址在当前这首开放时就预取好，点下一首不再等网易云', async () => {
  const b = box(new Map(), { 1: 'u1', 2: 'u2' });
  vm.runInContext('_mQueue = [{id:2,name:"s2"}];', b);
  await b.musicPlay(S(1), 'u1');
  assert.ok(await until(() => vm.runInContext('_mUrlCache && _mUrlCache.id', b) === 2), '没预取');
  b.musicNext();
  assert.ok(await until(() => b.audio.src === 'u2'));
  assert.strictEqual(b.fetched.filter(x => x === '2').length, 1, '下一首被取了两遍');
});
t('换歌：旧的淡出、新的从 0 淡入到 1', async () => {
  const b = box(new Map(), { 1: 'u1', 2: 'u2' });
  await b.musicPlay(S(1), 'u1');
  await until(() => b.audio.volume === 1);
  const p = b.musicPlay(S(2), 'u2');
  await new Promise(r => setTimeout(r, 90));
  const mid = b.audio.volume;
  await p;
  assert.ok(mid > 0 && mid < 1, '淡出中途音量 ' + mid);
  assert.ok(await until(() => b.audio.volume === 1, 1000), '没淡回 1：' + b.audio.volume);
});
t('换歌：页面在后台时不淡（计时器被节流，淡入要等很久＝听着断了），音量直接到 1', async () => {
  const b = box(new Map(), { 1: 'u1', 2: 'u2' });
  await b.musicPlay(S(1), 'u1');
  await until(() => b.audio.volume === 1);
  b.document = { hidden: true };
  const t0 = Date.now();
  await b.musicPlay(S(2), 'u2');
  assert.strictEqual(b.audio.volume, 1, '后台换完歌音量是 ' + b.audio.volume);
  assert.ok(Date.now() - t0 < 120, '后台还在等淡出 ' + (Date.now() - t0) + 'ms');
});
t('后台自动下一首：不从音量 0 起放（内核会暂停后台静音媒体）；被内核 Abort 了拉满再试一次，不弹「拦了自动播放」', async () => {
  const b = box(new Map(), { 1: 'u1', 2: 'u2' });
  await b.musicPlay(S(1), 'u1');
  b.document = { hidden: true };
  const a = b.audio, vols = [];
  let n = 0;
  a.play = () => { vols.push(a.volume); a.plays.push(a.src);
    if (n++ === 0) { a.paused = true; const e = new Error('interrupted by a call to pause()'); e.name = 'AbortError'; return Promise.reject(e); }
    a.paused = false; return Promise.resolve(); };
  const failed = [];
  b._mPlayFailed = e => failed.push(e.name);
  await b.musicPlay(S(2), 'u2');
  assert.strictEqual(vols[0], 1, '后台起放时音量是 ' + vols[0]);
  assert.strictEqual(a.plays.length - 1, 2, '被 Abort 后没重试');
  assert.strictEqual(a.paused, false);
  assert.strictEqual(b._mSwitching, false);
  assert.deepStrictEqual(failed, []);
});

t('点歌台：桌面版走悬浮窗，不依赖迷你条；字体一起带过去', () => {
  assert.ok(/const dockUp = [^\n]*\(X && _mNow\)/.test(music));
  assert.ok(music.includes('X.lyric(st)'));
  assert.ok(music.includes('font: _mFontNow()'));
});
t('系统媒体控制：元数据、上/下一首、播放暂停（重启后没建 <audio> 也能按播放）、进度', () => {
  for (const k of ["'play'", "'pause'", "'previoustrack'", "'nexttrack'"]) assert.ok(music.includes(`on(${k},`), k);
  assert.ok(music.includes("on('play', () => { if (!_mAudio || _mAudio.paused) musicToggle(); });"));
  assert.ok(music.includes('new MediaMetadata({ title: _mNow.name'));
  assert.ok(music.includes('setPositionState'));
});
t('悬浮窗页面：不用 app-region 拖拽（会吞掉悬停）、有八个把手和锁', () => {
  const html = read('deskly.html'), js = read('deskly.js');
  assert.ok(!/app-region:\s*drag/.test(html));
  assert.strictEqual((html.match(/class="h [nsew]{1,2}"/g) || []).length, 8);
  assert.ok(js.includes('D.bounds(') && js.includes('D.lock(') && js.includes('D.hit('));
});
const css = read('css/grancyan.css');
t('全屏歌词：.mz-ly-wrap 必须 min-height:0（滚动/Tilt 才滚得动）', () => {
  assert.ok(/#musicModal\.music-lyrics-full \.mz-ly-wrap \{[^}]*min-height:0/.test(css));
});
t('全屏歌词：抽屉不许藏（全屏里点搜索/歌单要能拉出来），进全屏先收起', () => {
  const hid = (css.match(/((?:#musicModal\.music-lyrics-full [^,{]+,\s*)*#musicModal\.music-lyrics-full [^,{]+)\{\s*display:none/g) || []).join(' ');
  assert.ok(hid.includes('.mz-disc-wrap'), '全屏藏起来的那组没找到：' + hid);
  assert.ok(!/\.mz-drawer|\.mz-scrim/.test(hid), '全屏把抽屉藏了：' + hid);
  assert.ok(!/#musicModal\.music-lyrics-full \.mz-stage \{[^}]*margin-right:0/.test(css));
  assert.ok(music.includes('if (next && _mDrawerOpen) _mDrawerSet(false);'));
});
t('窗内桌面歌词：长句不折行，按宽度缩，最多缩到 0.6 再长就滚', () => {
  assert.ok(/\.mz-dl-l \{[^}]*white-space:nowrap/.test(css));
  assert.ok(/\.mz-dl-l \{[^}]*var\(--fit,1\)/.test(css));
  // span 不能再夹 max-width:100%：不折行之后它会把量出来的宽度夹住（判断不出超宽），超出去的字还会被 background-clip 裁成透明
  assert.ok(!/\.mz-dl-l > span \{[^}]*max-width/.test(css));
  assert.ok(/\.mz-dl-l\.over \{[^}]*overflow:hidden/.test(css));
  assert.ok(music.includes('Math.max(0.6, (w - 1) / need)') && music.includes('if (d._over > 0) _mDeskScroll(d, pr);'));
  const js = read('deskly.js');
  assert.ok(js.includes('var MIN_FIT = 0.6') && js.includes('scroll(d)'));
});
t('Windows 应用 ID：只在打包后设；任务栏钉住的快捷方式只改指向本 exe 的', () => {
  const m = read('electron-main.js');
  assert.ok(/function ensureWinIdentity\(\) \{\n  if \(process\.platform !== 'win32' \|\| !app\.isPackaged\) return;/.test(m));
  assert.ok(m.includes("if (same(l.target) && l.appUserModelId !== APP_ID) shell.writeShortcutLink(p, 'update', { appUserModelId: APP_ID });"));
  assert.ok(m.includes('app.whenReady().then(() => { ensureWinIdentity(); return createWindow(); })'));
});
// ── 桌面歌词的「音」「译」：真函数进沙箱 ──
function deskBox(store) {
  const b = { Math, JSON, String, localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: { getElementById: () => null }, pushes: 0, _mDockLyric() { b.pushes++; } };
  vm.createContext(b);
  vm.runInContext('var _mLyric = null;\n' + ['_mDeskOptOn', '_mDeskOptToggle', '_mDeskOpts', '_mDeskRows', '_mDeskProg', '_mDeskDur'].map(f => funcBody(music, f)).join('\n'), b);
  return b;
}
const JP = '_mLyric = { idx: 1, wbw: false, lines: [{ t: 0, txt: "前奏" }, { t: 10, end: 14, txt: "君の名は", ro: "kimi no na wa", tr: "你的名字" }, { t: 14, txt: "ラララ", ro: "rarara" }] };';
t('桌面歌词「音」「译」：默认关，保持两行一页', () => {
  const b = deskBox(new Map());
  vm.runInContext(JP, b);
  const o = vm.runInContext('_mDeskOpts()', b);
  assert.strictEqual(JSON.stringify(o), '{"hasRo":true,"hasTr":true,"ro":false,"tr":false}');
  const r = vm.runInContext('_mDeskRows(_mLyric, 10.9, _mDeskOpts())', b);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.k || ''])), '[["前奏","done",""],["君の名は","cur",""]]');
  assert.strictEqual(r[1].p, 50);
});
t('桌面歌词「音」「译」：开了以后一页一句，罗马音和主句同进度，翻译挂最下；这句没翻译就留空行', () => {
  const store = new Map();
  const b = deskBox(store);
  vm.runInContext(JP, b);
  vm.runInContext('_mDeskOptToggle("ro"); _mDeskOptToggle("tr")', b);
  assert.strictEqual(store.get('kuro_deskLyRo'), '1');
  assert.strictEqual(b.pushes, 2, '改完要重推');
  let r = vm.runInContext('_mDeskRows(_mLyric, 10.9, _mDeskOpts())', b);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.k || '', x.p])), '[["君の名は","cur","",50],["kimi no na wa","","ro",50],["你的名字","","tr",50]]');
  vm.runInContext('_mLyric.idx = 2', b);
  r = vm.runInContext('_mDeskRows(_mLyric, 14, _mDeskOpts())', b);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[2].t, '');
  // 只开「译」
  vm.runInContext('_mDeskOptToggle("ro"); _mLyric.idx = -1', b);
  r = vm.runInContext('_mDeskRows(_mLyric, 0, _mDeskOpts())', b);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.k || '', x.p])), '[["前奏","","",0],["","","tr",0]]');
});
t('桌面歌词「音」「译」：这首没有就不算开（中文歌开着也照旧两行），乱传的键不动设置', () => {
  const store = new Map([['kuro_deskLyRo', '1'], ['kuro_deskLyTr', '1']]);
  const b = deskBox(store);
  vm.runInContext('_mLyric = { idx: 0, lines: [{ t: 0, txt: "夜曲" }, { t: 5, txt: "一群嗜血的蚂蚁" }] }', b);
  assert.strictEqual(JSON.stringify(vm.runInContext('_mDeskOpts()', b)), '{"hasRo":false,"hasTr":false,"ro":false,"tr":false}');
  assert.strictEqual(vm.runInContext('_mDeskRows(_mLyric, 1, _mDeskOpts())', b).length, 2);
  vm.runInContext('_mDeskOptToggle("evil")', b);
  assert.strictEqual(b.pushes, 0);
});
t('桌面歌词「音」「译」：地方够大时两句一页，各带自己的副行，和普通模式同一个翻页节奏', () => {
  const b = deskBox(new Map([['kuro_deskLyRo', '1'], ['kuro_deskLyTr', '1']]));
  vm.runInContext(JP, b);
  // idx=1 → 这一页是第 0、1 句；第 0 句唱完（满），第 1 句唱到一半，罗马音跟自己那句走
  let r = vm.runInContext('_mDeskRows(_mLyric, 10.9, _mDeskOpts(), true)', b);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.k || '', x.p, x.g])),
    '[["前奏","done","",100,0],["","","ro",100,0],["","","tr",100,0],["君の名は","cur","",50,1],["kimi no na wa","","ro",50,1],["你的名字","","tr",50,1]]');
  // 不够大（two=false）：只剩唱到的那句，g 归零——和以前一页一句的结果一模一样
  r = vm.runInContext('_mDeskRows(_mLyric, 10.9, _mDeskOpts(), false)', b);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.k || '', x.p, x.g])),
    '[["君の名は","cur","",50,0],["kimi no na wa","","ro",50,0],["你的名字","","tr",50,0]]');
  // 翻到下一页（idx=2）：第 2 句在上、第 3 句不存在 → 空行占位，不让整块跳
  vm.runInContext('_mLyric.idx = 2', b);
  r = vm.runInContext('_mDeskRows(_mLyric, 14.5, _mDeskOpts(), true)', b);
  assert.strictEqual(r.length, 6);
  assert.strictEqual(JSON.stringify(r.map(x => [x.t, x.c, x.g])), '[["ラララ","cur",0],["rarara","",0],["","",0],["","",1],["","",1],["","",1]]');
});
t('桌面歌词悬浮窗：窗口不够高就只留唱到的那组，拉高/拉矮重新挑；窗内那层按画面大小定', () => {
  const js = read('deskly.js');
  assert.ok(js.includes('var TWO_MIN_FS = 30;'));
  assert.ok(js.includes('if (fsFor(availH(), u) >= TWO_MIN_FS) return list;'));
  assert.ok(js.includes("window.addEventListener('resize', function () { if (lastSt) { key = ''; render(lastSt); } else layout(); });"));
  assert.ok(music.includes('const rows = _mDeskRows(L, a ? a.currentTime : 0, o, true);'), '悬浮窗永远拿两句的版本，由它自己挑');
  assert.ok(music.includes('const two = typeof window !== \'undefined\' && window.innerHeight >= 720 && window.innerWidth >= 760;'));
  // 两句一页时 querySelector('.ro') 会拿到第一句的罗马音：窗内那层必须认「紧跟在 .cur 后面的副行」
  assert.ok(music.includes("for (let s = cur && cur.nextElementSibling; s && s.classList && (s.classList.contains('ro') || s.classList.contains('tr')); s = s.nextElementSibling) list.push(s);"));
});
t('桌面歌词悬浮窗：按窗口高度在一句/两句之间切（真跑 deskly.js 的 pick）', () => {
  const js = read('deskly.js');
  const body = js.slice(js.indexOf('function availH'), js.indexOf('function layout'))
    + js.slice(js.indexOf('function pick'), js.indexOf('var lastSt'));
  const box = { H: 0, getComputedStyle: () => ({ paddingTop: '8', paddingBottom: '8' }), Math };
  box.wrap = { get clientHeight() { return box.H; } };
  vm.createContext(box);
  vm.runInContext(body + '; this.pick = pick;', box);
  const rows = [{ t: 'a', c: 'done', g: 0 }, { t: 'ar', k: 'tr', g: 0 }, { t: 'b', c: 'cur', g: 1 }, { t: 'br', k: 'tr', g: 1 }];
  box.H = 128;   // 默认窗口：两句 3.42 份 → (112-2)/3.42/1.3 = 24 < 30 → 一句
  assert.deepStrictEqual(box.pick(rows).map(r => r.t), ['b', 'br']);
  assert.deepStrictEqual(box.pick(rows).map(r => r.g), [0, 0]);
  box.H = 200;   // 拉高：(184-2)/3.42/1.3 = 40 → 两句
  assert.strictEqual(box.pick(rows).length, 4);
  // 普通模式（没有 g=1）原样返回
  const plain = [{ t: 'x', c: 'cur' }, { t: 'y' }];
  box.H = 60;
  assert.strictEqual(box.pick(plain), plain);
});
t('歌词复制：所选照屏幕上的样子（开着的副行跟着），全部歌词只要原文，全部译文只要翻译', () => {
  const b = { Math, JSON, Set, state: { musicLyricTrans: true, musicLyricRoma: false }, _mLyric: null, _mLySel: null };
  vm.createContext(b);
  vm.runInContext(['_mOptOn', '_mLyCopyText'].map(f => funcBody(music, f)).join('\n'), b);
  vm.runInContext(JP + ' _mLySel = { L: _mLyric, picked: new Set([2, 1]) };', b);
  assert.strictEqual(vm.runInContext('_mLyCopyText("sel")', b), '君の名は\n你的名字\nラララ');
  vm.runInContext('state.musicLyricRoma = true', b);
  assert.strictEqual(vm.runInContext('_mLyCopyText("sel")', b), '君の名は\nkimi no na wa\n你的名字\nラララ\nrarara');
  assert.strictEqual(vm.runInContext('_mLyCopyText("all")', b), '前奏\n君の名は\nラララ');
  assert.strictEqual(vm.runInContext('_mLyCopyText("tr")', b), '你的名字');
  assert.strictEqual(vm.runInContext('_mLyCopyText("ro")', b), 'kimi no na wa\nrarara');
  vm.runInContext('_mLySel = null', b);
  assert.strictEqual(vm.runInContext('_mLyCopyText("sel")', b), '');
  // 长按进选择模式（不再是直接复制一句），选择模式里点句子不切沉浸
  assert.ok(music.includes('_mLySelStart(i);\n    }, 520) };'));
  assert.ok(music.includes(".ly-sel .music-ly-line')); }"));
});
t('安卓：卡片和悬浮条拿到的状态（遥控电脑/装回来没按 ▶ 时不挂卡片；时间轴带扫色时长和逐字）', () => {
  const sent = { state: [], lyric: [] };
  const b = { Math, JSON, String, Date, URL, isFinite, parseFloat, location: { href: 'https://grancyan.app/index.html' },
    window: { GrancyanMusic: { state: s => sent.state.push(JSON.parse(s)), lyric: s => sent.lyric.push(JSON.parse(s)) } },
    _mAccentNow: () => '#c6ff00', _mRemote: false, _mSwitching: false, _mNow: null, _mAudio: null, _mLyric: null };
  vm.createContext(b);
  vm.runInContext('var _mNativeAt = 0, _mNativeLyKey = "";\n' + ['_mNative', '_mNativeState', '_mNativeLyric', '_mDeskDur'].map(f => funcBody(music, f)).join('\n'), b);
  vm.runInContext('_mNow = { id: 1, name: "しりたくない", artist: "SEDO", cover: "http://p1.music.126.net/x.jpg", url: "u" }; _mAudio = { src: "u", paused: false, currentTime: 12.5, duration: 200, playbackRate: 1 }; _mNativeState()', b);
  assert.deepStrictEqual(sent.state.pop(), { title: 'しりたくない', artist: 'SEDO', cover: 'http://p1.music.126.net/x.jpg', dur: 200, pos: 12.5, playing: true, rate: 1, accent: '#c6ff00' });
  vm.runInContext('_mSwitching = true; _mNativeState()', b);
  const sw = sent.state.pop();
  assert.strictEqual(sw.pos, 0, '换歌途中不报上一首的位置');
  assert.strictEqual(sw.playing, true);
  vm.runInContext('_mSwitching = false; _mRemote = true; _mNativeState()', b);
  assert.deepStrictEqual(sent.state.pop(), { title: '' });
  vm.runInContext('_mRemote = false; _mNow._resume = true; _mNativeState()', b);
  assert.deepStrictEqual(sent.state.pop(), { title: '' });
  vm.runInContext('_mNow._resume = false;' + JP.replace('wbw: false', 'wbw: true') + ' _mLyric.lines[1].words = [{ t: 10, end: 11, txt: "君の" }, { t: 11, end: 12, txt: "名は" }];', b);
  const o = { hasRo: true, hasTr: true, ro: true, tr: false };
  vm.runInContext('_mNativeLyric(true, ' + JSON.stringify(o) + ')', b);
  const ly = sent.lyric.pop();
  assert.strictEqual(ly.on, true);
  assert.strictEqual(ly.n, 3);
  // 「君の名は」四个字：到 end 有 4s，但最多按每字 .45s 扫 → 1.8s（和桌面那份 _mDeskProg 同一个数）
  assert.deepStrictEqual(ly.lines[1], { s: 10, d: 1.8, t: '君の名は', ro: 'kimi no na wa', tr: '你的名字', w: [[10, 11, 2], [11, 12, 2]] });
  assert.strictEqual(ly.lines[0].d, 1.5, '「前奏」两个字：最多按每字 .45s，下限 1.5s');
  vm.runInContext('_mNativeLyric(true, ' + JSON.stringify(o) + ')', b);
  assert.strictEqual(sent.lyric.length, 0, '没变就不重推（每帧都会走到这里）');
  vm.runInContext('_mNativeLyric(false, ' + JSON.stringify(o) + ')', b);
  const off = sent.lyric.pop();
  assert.strictEqual(off.on, false);
  assert.strictEqual(off.n, 3, '关着也带时间轴：卡片上的「词」按钮要靠它才出现');
});
t('安卓：壳 → 页面的命令都接上了；词开着没权限只送去设置一次', () => {
  assert.ok(music.includes("if (typeof window !== 'undefined') window._mNativeCmd = _mNativeCmd;"));
  for (const c of ["cmd === 'play'", "cmd === 'pause'", "cmd === 'next'", "cmd === 'prev'", "cmd === 'seek'", "cmd === 'lyoff'", "cmd === 'lyric'", "cmd === 'ro' || cmd === 'tr'"]) assert.ok(music.includes(c), c);
  assert.ok(music.includes("if (!asked && N.askOverlay)"));
  const br = read('android/src/com/grancyan/app/MusicBridge.java');
  assert.ok(br.includes('"window._mNativeCmd&&window._mNativeCmd(" + JSONObject.quote(cmd) + "," + JSONObject.quote(arg == null ? "" : arg) + ")"'), '参数必须 quote，不能拼裸字符串');
  const act = read('android/src/com/grancyan/app/MainActivity.java');
  assert.ok(act.includes('webView.addJavascriptInterface(new MusicBridge(this, webView), "GrancyanMusic");'));
  assert.ok(act.includes('MusicService.setAppVisible(false);'), '退到后台才出悬浮条');
  const mf = read('android/AndroidManifest.xml');
  assert.ok(/<service\s+android:name="\.MusicService"\s+android:exported="false"\s+android:foregroundServiceType="mediaPlayback"\/>/.test(mf));
  for (const p of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'SYSTEM_ALERT_WINDOW', 'WAKE_LOCK']) assert.ok(mf.includes(`android.permission.${p}"`), p);
  const svc = read('android/src/com/grancyan/app/MusicService.java');
  // 锁屏放歌：放着时拿 CPU/Wi-Fi 锁，停了宽限一阵再放（两首之间也是 playing=false）
  assert.ok(/syncOverlay\(\);\s*holdLocks\(playing\);/.test(svc), 'refresh 里要按 playing 拿/放锁');
  assert.ok(svc.includes('if (!playing) { H.postDelayed(dropLocks, 90_000); return; }'));
  assert.ok(svc.includes('cpu.acquire(10 * 60_000L)'), '唤醒锁要带超时');
  assert.ok(svc.includes('startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)'));
  // 悬浮歌词和 App 一样是宋体（FONT_PRESETS 三档都落到 serif）
  assert.ok(read('android/src/com/grancyan/app/LyricOverlay.java').includes('paint.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));'), '悬浮歌词要用宋体');
  const presets = read('js/02-state.js').match(/const FONT_PRESETS = \{([\s\S]*?)\n\};/)[1].match(/`[^`]*`/g);
  assert.ok(presets.length >= 3 && presets.every(p => /, serif`$/.test(p)), '哪档字体不再落到 serif，悬浮歌词就要跟着改');
  // 安卓 13+ 卡片配色取自封面：封面是合成的主题色图，不是原图
  assert.ok(svc.includes('Bitmap out = compose(cover, accent);'));
  // 资源 id 走 getIdentifier（build.ps1 不生成 R.java）：名字写错就是 0，通知直接抛
  for (const r of ['ic_stat_music', 'ic_act_prev', 'ic_act_next', 'ic_act_play', 'ic_act_pause', 'ic_act_lyric']) {
    assert.ok(svc.includes(`"${r}"`), r);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'android/res/drawable', r + '.xml')), r + '.xml');
  }
});
t('安卓：自适应图标（前景+同色背景），老图标还在给 7.x 用', () => {
  const x = read('android/res/mipmap-anydpi-v26/ic_launcher.xml');
  assert.ok(x.includes('<background android:drawable="@color/ic_launcher_bg"/>') && x.includes('<foreground android:drawable="@mipmap/ic_launcher_foreground"/>'));
  assert.ok(read('android/res/values/colors.xml').includes('<color name="ic_launcher_bg">#0E478F</color>'));
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', `android/res/mipmap-${d}/ic_launcher_foreground.png`)), d);
    assert.ok(fs.existsSync(path.join(__dirname, '..', `android/res/mipmap-${d}/ic_launcher.png`)), d);
  }
});
t('桌面歌词「音」「译」：悬浮窗按钮 → 主进程 → 点歌台这条线接上了', () => {
  const html = read('deskly.html'), js = read('deskly.js'), pre = read('deskly-preload.js'), mainPre = read('preload.js'), dm = read('deskly-main.js');
  assert.ok(html.includes('id="bro"') && html.includes('id="btr"'));
  assert.ok(js.includes("D.opt('ro')") && js.includes("D.opt('tr')"));
  assert.ok(pre.includes("opt(v) { if (v === 'ro' || v === 'tr') ipcRenderer.send(`${kind}:cmd`, v); }"));
  assert.ok(dm.includes("else if (v === 'ro' || v === 'tr') toMain('desk-lyric:opt', v);"));
  assert.ok(mainPre.includes("ipcRenderer.on('desk-lyric:opt'"));
  assert.ok(music.includes('X.onLyricOpt(k => _mDeskOptToggle(k))'));
  assert.ok(music.includes('opts: o });'));
});
t('安卓副本一致', () => {
  for (const f of ['js/24-music.js', 'css/grancyan.css']) assert.strictEqual(read('android/assets/' + f), read(f), f);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('  ✓ ' + name); }
    catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
  }
  console.log(n + '/' + tests.length + ' 条通过');
})();
