/* 一批零散 bug 的回归测试（2026-09-27 审查报上来的十条，逐条核过再修）。
 *
 *  4 终端：输出写到当前标签而不是跑命令的标签；abort/runId 全局共享；关左边标签下标不减
 *  5 点歌：地址过期重取期间切了歌，回来把旧歌塞进新歌界面底下放
 *  6 点歌：歌名里的 ] | 把 [[SONG:]]/[[PLIST:]] 标签截断
 *  7 回复建议：「3点前提醒我」被剥成「点前提醒我」
 *  8 页内查找：关掉时没清搜索防抖，关完高亮才冒出来
 *  9 猫爪日报：「N 天前」按毫秒算不按日历天
 * 10 全屏看消息：用户消息走了 renderRichText（原始 HTML 放行）
 *
 * 全部在 vm 里真跑源码里的函数（funcBody 按括号配对切，或整文件加载），不是正则看源码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function funcBody(s, name) {
  let i = s.indexOf('function ' + name + '(');
  if (i < 0) return '';
  if (s.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
function funcs(s, names) {
  return names.map(n => {
    const b = funcBody(s, n);
    if (!b) throw new Error('源码里找不到 function ' + n);
    return b;
  }).join('\n');
}

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const noop = () => {};
// 等一个 termRun 结束，最多等 300ms：停不下来就让后面的断言去报红，别让整个进程挂住
const settle = p => Promise.race([p, new Promise(r => setTimeout(r, 300))]);
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// 可控的假定时器：记下来，测试决定什么时候触发
function fakeTimers() {
  let seq = 0; const live = new Map();
  return {
    setTimeout: (f, ms) => { const id = ++seq; live.set(id, f); return id; },
    clearTimeout: id => { live.delete(id); },
    live,
    fireAll() { const fs = [...live.values()]; live.clear(); fs.forEach(f => f()); },
  };
}
// 记录监听器的假元素
function recEl(extra) {
  const L = {};
  return Object.assign({
    style: {}, dataset: {}, classList: { contains: () => false, add: noop, remove: noop, toggle: noop },
    addEventListener: (k, f) => { (L[k] = L[k] || []).push(f); },
    fire: (k, e) => (L[k] || []).forEach(f => f(e || {})),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: noop, clientWidth: 340, clientHeight: 600, width: 340, height: 600,
    checked: false, textContent: '', innerHTML: '',
  }, extra || {});
}

// ⚠️ 下面有 await 一个「停下来才会 resolve」的 termRun。停不下来时事件循环会空掉，
// node 直接 exit 0 —— 后面的断言一条都没跑，看着却是绿的。没走到结尾一律按失败算。
let finished = false;
process.on('exit', code => {
  if (!finished && code === 0) { console.log('  ✗ 测试没跑完就退出了（多半是某个 await 永远等不到：该停的没停）'); process.exitCode = 1; }
});

(async () => {

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
console.log('\n【4】终端：输出、停止都认跑命令的那个标签');
{
  const term = read('js/15-terminal.js');
  const prelude = term.slice(0, term.indexOf('function openTerminal('));
  const enc = new TextEncoder();
  function termBox() {
    const outEl = { html: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0, innerHTML: '',
      insertAdjacentHTML(_, h) { this.html += h; } };
    const els = { termInput: { value: '' }, termAdmin: { checked: false }, termOut: outEl };
    const streams = [];   // 每次 /run 一个可控的流
    const kills = [];
    const box = {
      SERVER_BASE: 'http://x', console, JSON, String, Date, Math, Error, Promise,
      TextDecoder, AbortController,
      localStorage: { getItem: () => null, setItem: noop },
      setTimeout: () => 1, clearTimeout: noop,
      escHtml: s => String(s), autoResize: noop, showToast: noop,
      document: { getElementById: id => els[id] || null },
      renderTerm: noop,
      fetch: (url, opt) => {
        const body = JSON.parse(opt.body);
        if (url.endsWith('/kill')) { kills.push(body.id); return Promise.resolve({ ok: true }); }
        const s = { id: body.id, cmd: body.cmd, q: [], waiter: null, signal: opt.signal };
        s.push = v => { if (s.waiter) { const w = s.waiter; s.waiter = null; w.res(v); } else s.q.push(v); };
        s.out = text => s.push({ done: false, value: enc.encode(`event: out\ndata: ${JSON.stringify({ text })}\n\n`) });
        s.finish = () => { s.push({ done: false, value: enc.encode(`event: done\ndata: ${JSON.stringify({ code: 0 })}\n\n`) }); s.push({ done: true }); };
        opt.signal.addEventListener('abort', () => {
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          if (s.waiter) { const w = s.waiter; s.waiter = null; w.rej(err); } else s.q.push({ err });
        });
        streams.push(s);
        return Promise.resolve({ ok: true, body: { getReader: () => ({
          read: () => new Promise((res, rej) => {
            if (s.q.length) { const v = s.q.shift(); return v.err ? rej(v.err) : res(v); }
            s.waiter = { res, rej };
          }),
        }) } });
      },
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(prelude + '\n' + funcs(term, ['termNewTab', 'termCloseTab', 'termSwitchTab', 'termPrint', 'termRun', '_termStopRun', 'termKill'])
      + '\nthis.__g = () => ({ tabs: _termTabs, active: _termActive, cur: _termTab() });', box);
    vm.runInContext("_termTabs = [{ name: '终端 1', shell: 'powershell', cwd: '', admin: false, out: [], history: [], histIdx: -1, busy: false }]", box);
    Object.assign(box, { _els: els, _out: outEl, _streams: streams, _kills: kills });
    box.run = cmd => { els.termInput.value = cmd; return box.termRun(); };
    return box;
  }

  // 切走之后输出记回原标签
  {
    const b = termBox();
    b.termNewTab();                // 两个标签，当前 = 1
    b.termSwitchTab(0);
    const pA = b.run('cmdA');
    await flush();
    const [A, B] = b.__g().tabs;
    b.termSwitchTab(1);
    b._out.html = '';
    b._streams[0].out('hello-from-A');
    await flush();
    t('★ 跑到一半切走：输出记在 A 名下', A.out.join('').includes('hello-from-A'), A.out);
    t('★ 不会写进当前的 B（也就不会跟着 B 落盘）', !B.out.join('').includes('hello-from-A'), B.out);
    t('★ 屏幕上当前是 B：不往 DOM 里画 A 的输出', !b._out.html.includes('hello-from-A'), b._out.html);
    b.termSwitchTab(0);
    b._streams[0].out('more-A');
    await flush();
    t('切回 A：接着往屏幕上画', b._out.html.includes('more-A'), b._out.html);
    b._streams[0].finish(); await settle(pA);
    t('A 结束的 [完成] 也记在 A 名下', A.out.join('').includes('[完成]') && !B.out.join('').includes('[完成]'));
  }

  // 两个标签同时在跑：停止只停当前标签那条
  {
    const b = termBox();
    b.termNewTab(); b.termSwitchTab(0);
    const pA = b.run('cmdA'); await flush();
    b.termSwitchTab(1);
    const pB = b.run('cmdB'); await flush();
    const [sA, sB] = b._streams;
    t('（对照）两条命令各自一个 runId', sA.id && sB.id && sA.id !== sB.id, [sA.id, sB.id]);
    b.termKill();                  // 当前是 B
    await settle(pB);
    t('★ 在 B 按停止：只断 B 的流', sB.signal.aborted && !sA.signal.aborted, [sA.signal.aborted, sB.signal.aborted]);
    t('★ 发给后端掐进程的是 B 的 id', b._kills.length === 1 && b._kills[0] === sB.id, b._kills);
    t('A 还在跑', b.__g().tabs[0].busy === true);
    b.termSwitchTab(0);
    b.termKill();
    await settle(pA);
    t('★ B 先结束之后回 A 按停止：A 照样停得下来（abort 没被 B 置空）', sA.signal.aborted && b._kills[1] === sA.id, b._kills);
  }
  {
    const b = termBox();
    b.termNewTab(); b.termSwitchTab(0);
    const pA = b.run('cmdA'); await flush();
    b.termSwitchTab(1);
    const pB = b.run('cmdB'); await flush();
    const [sA, sB] = b._streams;
    sB.finish(); await settle(pB);         // B 自然跑完
    b.termSwitchTab(0);
    b.termKill();
    await settle(pA);
    t('★ B 自然跑完后 A 的停止仍然有效', sA.signal.aborted && b._kills.includes(sA.id), b._kills);
  }

  // 关左边的标签，当前标签不能跳
  {
    const b = termBox();
    // 四个标签、当前停在第三个 —— 当前不能是最后一个，不然「越界夹回」会碰巧把下标拉对
    b.termNewTab(); b.termNewTab(); b.termNewTab();   // W X Y Z
    b.termSwitchTab(2);
    const Y = b.__g().tabs[2];
    b.termCloseTab(0);
    t('★ 关掉当前左边的标签：还停在原来那个标签上', b.__g().cur === Y && b.__g().active === 1, b.__g().active);
    const b2 = termBox();
    b2.termNewTab(); b2.termNewTab();
    b2.termSwitchTab(1);
    const Z2 = b2.__g().tabs[2];
    b2.termCloseTab(1);                   // 关当前 → 落到右边那个
    t('关当前标签：落到它右边那个', b2.__g().cur === Z2, b2.__g().active);
    const b3 = termBox();
    b3.termNewTab();
    b3.termSwitchTab(1);
    b3.termCloseTab(1);                   // 关最后一个当前
    t('关最后一个（当前）：退到前一个', b3.__g().active === 0);
  }
  {
    const b = termBox();
    b.termNewTab(); b.termSwitchTab(0);
    const pA = b.run('cmdA'); await flush();
    b.termSwitchTab(1);
    b.termCloseTab(0);
    await settle(pA);
    t('关掉一个还在跑的标签：它那条命令也停掉', b._streams[0].signal.aborted && b._kills.includes(b._streams[0].id), b._kills);
  }
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【5】点歌：地址过期重取时切了歌');
{
  const music = read('js/24-music.js');
  function musicBox() {
    const audios = [];
    const box = {
      console, Math, Date, JSON, String, Object, Promise,
      showToast: noop, _mPaint: noop, _mPlayFailed: noop, musicNoteRecent: noop, musicLoadLyric: noop,
      _mCoverTint: noop, _mListen: noop, _mTick: noop, musicNext: noop, _mSessSave: noop, _mMediaSync: noop, _mMediaWire: noop,
      _mPosSave: noop, _mUrlPrefetch: noop, _mUrlTake: () => '', _mFade: () => Promise.resolve(),
      Audio: function () {
        const L = {};
        const a = { src: '', paused: true, plays: [], currentTime: 0,
          addEventListener: (k, f) => { (L[k] = L[k] || []).push(f); },
          fire: k => Promise.all((L[k] || []).map(f => f())),
          play() { a.plays.push(a.src); a.paused = false; return Promise.resolve(); }, pause() { a.paused = true; } };
        audios.push(a); return a;
      },
      _pending: [],
      musicFetchUrl: id => new Promise(res => box._pending.push({ id, res })),
    };
    vm.createContext(box);
    // _mRemote：遥控钩子（24-music.js 顶上那个 var），这里测的是本机播放，永远是 null
    vm.runInContext('var _mAudio = null, _mNow = null, _mPlayReq = 0, _mLyricReq = 0, _mTintReq = 0, _mLoop = false, _mRemote = null;\n'
      + 'var _mSwitching = false, _mSkipRun = 0, _mFadeTimer = 0, _mQueue = [], _mCtx = null;\n'
      + funcs(music, ['_mAudioEl', 'musicPlay']), box);
    box._audios = audios;
    return box;
  }
  {
    const b = musicBox();
    await b.musicPlay({ id: 1, name: 'A' }, 'urlA');
    const a = b._audios[0];
    const err = a.fire('error');             // A 的地址过期
    await flush();
    t('（对照）去重取 A 的地址了', b._pending.length === 1 && b._pending[0].id === 1);
    await b.musicPlay({ id: 2, name: 'B' }, 'urlB');   // 取地址期间她点了 B
    b._pending[0].res('urlA-fresh');
    await err; await flush();
    t('★ 回来发现已经换歌：不把 A 的新地址塞进播放器', a.src === 'urlB', a.src);
    t('★ 也不再 play 一次 A', !a.plays.includes('urlA-fresh'), a.plays);
    t('界面上的仍然是 B', vm.runInContext('_mNow.id', b) === 2);
  }
  {
    const b = musicBox();
    await b.musicPlay({ id: 1, name: 'A' }, 'urlA');
    const a = b._audios[0];
    const err = a.fire('error');
    await flush();
    b._pending[0].res('urlA-fresh');
    await err; await flush();
    t('没换歌：照旧用新地址接着放', a.src === 'urlA-fresh' && a.plays.includes('urlA-fresh'), a.plays);
  }
  {
    const b = musicBox();
    await b.musicPlay({ id: 1, name: 'A' }, 'urlA');
    const a = b._audios[0];
    const err = a.fire('error');
    await flush();
    vm.runInContext('_mPlayReq++; _mNow = null;', b);   // 等同于她按了停止
    b._pending[0].res('urlA-fresh');
    await err; await flush();
    t('重取期间停了：不会自己又响起来', a.src === 'urlA' && !a.plays.includes('urlA-fresh'), a.plays);
  }
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【6】点歌：歌名里的 ] | 不能把标签截断');
{
  const music = read('js/24-music.js');
  const chat = { nodes: {} };
  const box = {
    console, JSON, String, RegExp, Object, Math, Date,
    getActiveChat: () => chat, save: noop, escHtml: s => String(s),
    musicCardHtml: s => `<CARD ${s.id}|${s.name}|${s.artist}>`,
    musicEnabled: () => true, _mListById: id => ({ id }), musicPlaylistCardHtml: p => `<PL ${p.id}>`,
    _mPlBuilding: {}, _mSearchCache: {},
  };
  vm.createContext(box);
  vm.runInContext(funcs(music, ['_mTagSafe', '_mTagSafeUrl', '_persistMusicResult', '_persistPlaylistResult',
    'musicSongTagRe', 'musicAskTagRe', 'musicTagToHtml', 'musicPlaylistTagRe', 'musicPlaylistAskRe',
    'musicPlaylistTagToHtml', 'musicTagForApi']), box);

  chat.nodes = { n1: { content: '给你 [[MUSIC: lemon]] 听' } };
  box._persistMusicResult('lemon', { id: 42, name: 'Lemon [Remastered]', artist: '米津|玄師', cover: 'http://c/a.jpg?x=[1]' });
  const c = chat.nodes.n1.content;
  const ms = [...c.matchAll(box.musicSongTagRe())];
  t('★ 固化出来的 [[SONG:]] 能被解析正则整条认出来', ms.length === 1 && c.replace(box.musicSongTagRe(), '') === '给你  听', c);
  t('歌名/歌手里的符号换成全角，看着一样', ms[0] && ms[0][2] === 'Lemon ［Remastered］' && ms[0][3] === '米津｜玄師', ms[0] && ms[0].slice(1));
  t('封面地址是百分号编码，不是全角（全角会把 URL 弄坏）', ms[0] && ms[0][4] === 'http://c/a.jpg?x=%5B1%5D', ms[0] && ms[0][4]);
  const html = box.musicTagToHtml(c);
  t('★ 渲染后气泡里没有裸标签原文', !html.includes('[[SONG') && !html.includes('Remastered]]') && html.includes('<CARD 42|'), html);
  t('回填给模型也能认出来', box.musicTagForApi(c).includes('[点了一首歌: Lemon ［Remastered］ - 米津｜玄師]'), box.musicTagForApi(c));

  chat.nodes = { n2: { content: '[[PLAYLIST: 夜里 | 睡前 | 歌1 / 歌2]]' } };
  box._persistPlaylistResult('夜里 | 睡前 | 歌1 / 歌2', { id: 'pl_1', name: '夜里 [循环]', desc: '一|二]三' });
  const pc = chat.nodes.n2.content;
  const pm = [...pc.matchAll(box.musicPlaylistTagRe())];
  t('★ [[PLIST:]] 同样整条认得出', pm.length === 1 && pc.replace(box.musicPlaylistTagRe(), '') === '', pc);
  t('PLIST 渲染后没有裸标签', !box.musicPlaylistTagToHtml(pc).includes('[[PLIST'), box.musicPlaylistTagToHtml(pc));
  t('普通歌名不受影响', box._mTagSafe('晴天') === '晴天' && box._mTagSafe(undefined) === '');
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【7】回复建议：只剥列表记号，不剥正文里的数字');
{
  const src = read('js/34-suggestions.js');
  const box = { String };
  vm.createContext(box);
  vm.runInContext(funcs(src, ['_cleanSuggestion']), box);
  const c = box._cleanSuggestion;
  t('★ 「3点前提醒我」原样保留', c('3点前提醒我') === '3点前提醒我', c('3点前提醒我'));
  t('★ 「1.5倍速放」原样保留', c('1.5倍速放') === '1.5倍速放', c('1.5倍速放'));
  t('★ 「2026年的计划」原样保留', c('2026年的计划') === '2026年的计划', c('2026年的计划'));
  t('「1. 继续讲」剥成「继续讲」', c('1. 继续讲') === '继续讲', c('1. 继续讲'));
  t('「2) 举个例子」剥掉', c('2) 举个例子') === '举个例子', c('2) 举个例子'));
  t('「3、总结」剥掉', c('3、总结') === '总结', c('3、总结'));
  t('「- 好的」「• 好的」「* 好的」剥掉', c('- 好的') === '好的' && c('• 好的') === '好的' && c('* 好的') === '好的');
  t('引号照旧去掉', c('“再说一遍”') === '再说一遍', c('“再说一遍”'));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【8】页内查找：关掉时清掉还没落地的搜索');
{
  const src = read('js/27-find.js');
  const tm = fakeTimers();
  let walks = 0;
  const mk = () => recEl({ value: '', focus: noop, select: noop, querySelector: sel => kids[sel] || (kids[sel] = mk()), onclick: null });
  const kids = {};
  const bar = mk();
  const box = {
    console, String, Object, Array, Math, JSON, RegExp,
    setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout,
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    MutationObserver: function () { return { observe: noop, disconnect: noop, takeRecords: () => [] }; },
    document: {
      createElement: () => bar, body: { appendChild: noop },
      addEventListener: noop,
      createTreeWalker: () => { walks++; return { nextNode: () => null }; },
      createRange: () => ({}),
    },
  };
  box.window = Object.assign(box, { getSelection: () => '' });
  vm.createContext(box);
  vm.runInContext(src, box);
  box.openFindBar();
  const input = kids['#gcFindInput'];
  input.value = '克克';
  input.fire('input');
  t('（对照）敲字后挂着一拍防抖', tm.live.size === 1);
  box.closeFindBar();
  t('★ 关掉时那一拍被清掉', tm.live.size === 0, tm.live.size);
  tm.fireAll();
  t('★ 关完之后不会再冒出一次搜索', walks === 0, walks);
  // 对照组：不关的话防抖到点确实会搜 —— 证明上面的「0 次」不是因为搜索压根跑不起来
  box.openFindBar();
  input.value = '克克'; input.fire('input');
  const w0 = walks;
  tm.fireAll();
  t('（对照）不关的话到点确实会搜', walks > w0, walks - w0);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【9】猫爪日报：「N 天前」按日历天');
{
  const src = read('js/51-moments.js');
  const box = { Number, Date, Math, String };
  vm.createContext(box);
  vm.runInContext(funcs(src, ['momentsRelativeTime']), box);
  const rt = (a, b) => box.momentsRelativeTime(a.getTime(), b.getTime());
  const D = (m, d, h, mi) => new Date(2026, m - 1, d, h, mi || 0);
  t('★ 前天 23:00 的帖，今天 00:30 看是「2 天前」', rt(D(9, 25, 23), D(9, 27, 0, 30)) === '2 天前', rt(D(9, 25, 23), D(9, 27, 0, 30)));
  t('昨天 23:00 → 「昨天」（不变）', rt(D(9, 26, 23), D(9, 27, 0, 30)) === '昨天');
  t('前天 00:10，今天 23:50 → 「2 天前」', rt(D(9, 25, 0, 10), D(9, 27, 23, 50)) === '2 天前', rt(D(9, 25, 0, 10), D(9, 27, 23, 50)));
  t('6 个日历天前 → 「6 天前」', rt(D(9, 21, 23), D(9, 27, 0, 30)) === '6 天前', rt(D(9, 21, 23), D(9, 27, 0, 30)));
  t('7 个日历天前（哪怕只过了 6 天多）→ 显示日期', rt(D(9, 20, 23), D(9, 27, 0, 30)) === '2026-09-20', rt(D(9, 20, 23), D(9, 27, 0, 30)));
  t('跨月也按日历天', rt(D(8, 30, 22), D(9, 2, 1)) === '3 天前', rt(D(8, 30, 22), D(9, 2, 1)));
  t('今天的仍是「N 小时前」', rt(D(9, 27, 1), D(9, 27, 5)) === '4 小时前');
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n【10】全屏看消息：用户消息走转义的那条渲染');
{
  const src = read('js/18-gesture.js');
  const bodyEl = { className: '', innerHTML: '', textContent: '', scrollTop: 5 };
  const btn = { textContent: '', classList: { toggle: noop } };
  const chat = { nodes: {
    u1: { id: 'u1', role: 'user', content: '<img src=x onerror=alert(1)>' },
    a1: { id: 'a1', role: 'assistant', content: '**粗**' },
    v1: { id: 'v1', role: 'user', variants: [{ content: 'v0' }, { content: '<b>v1</b>' }], chosenVariant: 1 },
  } };
  const box = {
    String, Object,
    document: { getElementById: id => (id === 'tvBody' ? bodyEl : id === 'tvRawBtn' ? btn : null) },
    getActiveChat: () => chat, typesetMath: noop,
    renderUserText: s => 'USER:' + s, renderRichText: s => 'RICH:' + s,
  };
  vm.createContext(box);
  vm.runInContext('var _tvNodeId = null, _tvRaw = false;\n' + funcs(src, ['nodeTextById', '_tvPaint']), box);
  const paint = id => { vm.runInContext(`_tvNodeId = ${JSON.stringify(id)}; _tvRaw = false;`, box); box._tvPaint(); return bodyEl.innerHTML; };
  t('★ 用户消息：走 renderUserText', paint('u1') === 'USER:<img src=x onerror=alert(1)>', bodyEl.innerHTML);
  t('AI 消息：仍走 renderRichText', paint('a1') === 'RICH:**粗**', bodyEl.innerHTML);
  t('用户消息的变体也走 renderUserText', paint('v1') === 'USER:<b>v1</b>', bodyEl.innerHTML);
}

console.log(`\n${pass} 通过, ${fail} 失败`);
finished = true;
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
