// 歌词时间戳跳转 + 长按复制。
//
// ⚠️ 这里**不验源码正则**（那种断言会匹配到注释里的反例、也管不住行为对不对）。
// 做法是把 24-music.js 里那一段真代码抠出来 eval，喂最小 DOM/Audio stub，
// 然后问「按下去之后到底发生了什么」。抠不出来就直接红，不会静默变成验空气。
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'js', '24-music.js'), 'utf8');
const CSS = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');

// ── 把那一段真代码抠出来 ──────────────────────────────────────────
const ANCHOR_A = 'var _mLyHold = null;';
const ANCHOR_B = '\nfunction _mPaintLyric()';
{
  // 锚点唯一性自检：>1 处的话抠出来的可能是别的段落（踩过：插桩锚点不唯一）
  const nA = SRC.split(ANCHOR_A).length - 1;
  const nB = SRC.split(ANCHOR_B).length - 1;
  test('锚点唯一，抠出来的是真代码不是空气', () => {
    assert.equal(nA, 1, `"${ANCHOR_A}" 命中 ${nA} 处`);
    assert.equal(nB, 1, `"${ANCHOR_B}" 命中 ${nB} 处`);
  });
}
const iA = SRC.indexOf(ANCHOR_A);
const iB = SRC.indexOf(ANCHOR_B);
const SEG = iA >= 0 && iB > iA ? SRC.slice(iA, iB) : '';

// ── 最小 stub ────────────────────────────────────────────────────
function mkEl(tag, cls) {
  const el = {
    tagName: tag, id: '', dataset: {}, textContent: '', style: {},
    _cls: new Set((cls || '').split(' ').filter(Boolean)), _kids: [], parent: null,
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      contains: c => el._cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !el._cls.has(c) : on) el._cls.add(c); else el._cls.delete(c); },
    },
    _listeners: {},
    addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    // 会冒泡 —— 手势是委托在容器上的，不冒泡的话从行上 fire 压根到不了 handler，
    // 于是所有「什么都不该发生」的断言会集体假绿（第一版就栽在这）
    fire: (t, ev) => { (el._listeners[t] || []).forEach(fn => fn(ev)); if (el.parent) el.parent.fire(t, ev); },
    // 认逗号分隔的选择器组（_mTapIgnored 用的是 'button,a,input,.ly-t'）：.xx 按类、其余按标签
    closest(sel) {
      const alts = sel.split(',').map(s => s.trim());
      const hit = n => alts.some(s => s[0] === '.' ? n._cls.has(s.slice(1)) : String(n.tagName).toLowerCase() === s);
      let n = el;
      while (n) { if (hit(n)) return n; n = n.parent; }
      return null;
    },
    append(child) { child.parent = el; el._kids.push(child); return child; },
  };
  return el;
}
function mkWorld(opts = {}) {
  const box = mkEl('div', 'music-lyric');
  const line = box.append(mkEl('div', 'music-ly-line'));
  line.id = 'mLy1';
  line.dataset.t = String(opts.t == null ? 61.5 : opts.t);
  const stamp = line.append(mkEl('i', 'ly-t'));
  const main = line.append(mkEl('div', 'ly-main'));
  const fill = mkEl('i', 'music-fill');
  const cur = mkEl('span', 'music-t-cur');
  const audio = { currentTime: opts.at == null ? 0 : opts.at, duration: opts.dur == null ? 200 : opts.dur, paused: false };
  const log = { toasts: [], copied: [], sync: [], ticks: 0 };
  // 长按进的是选择模式（10-02 起）：底部那条按钮挂在 body 上，getElementById 找得回来
  box.querySelectorAll = sel => (sel === '.music-ly-line' ? [line] : []);
  const doc = {
    _bar: null,
    querySelectorAll: sel => (sel === '.music-fill' ? [fill] : sel === '.music-t-cur' ? [cur] : []),
    getElementById: id => (id === 'musicLyric' ? box : id === 'mzLySel' ? doc._bar : null),
    createElement: tag => { const e = mkEl(tag); e.remove = () => { if (doc._bar === e) doc._bar = null; }; return e; },
    body: { appendChild: c => { doc._bar = c; return c; } },
  };
  const timers = [];
  const env = {
    document: doc,
    _mAudio: audio,
    _mLyric: { lines: [{ t: 0, txt: 'zero', words: [] }, { t: 61.5, txt: '第二句', tr: 'the second', words: [] }], wbw: false, idx: 5 },
    _mFmt: s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    _mSyncLyricLine: t => log.sync.push(['line', t]),
    _mSyncWords: t => log.sync.push(['words', t]),
    _mTick: () => { log.ticks++; },
    _mCineOn: () => false,
    copyTextCompat: txt => { log.copied.push(txt); return Promise.resolve(); },
    _mOptOn: (k, def) => def,   // 翻译默认开、罗马音默认关
    navigator: {},
    showToast: (m, k) => log.toasts.push([m, k]),
    setTimeout: (fn, ms) => { const h = { fn, ms, dead: false }; timers.push(h); return h; },
    clearTimeout: h => { if (h) h.dead = true; },
  };
  // 顶层 var 要留在 eval 的作用域里，才能读回 _mWordCur / _mLyHold 的真值
  const body = SEG + `\n;return { seek:_mLySeekTo, bind:_mLyBind, cancel:_mLyCancelHold, copy:_mLyCopy,
      sel:()=>_mLySel ? [..._mLySel.picked] : null,
      peek:()=>({ wordCur:typeof _mWordCur==='undefined'?undefined:_mWordCur, hold:_mLyHold }) };`;
  const keys = Object.keys(env);
  const api = new Function(...keys, '"use strict";var _mWordCur=-1;' + body)(...keys.map(k => env[k]));
  api.bind(box);
  return { box, line, stamp, main, audio, fill, cur, log, env, timers, api,
    runTimers: () => timers.filter(h => !h.dead).forEach(h => { h.dead = true; h.fn(); }) };
}
const pd = (target, extra = {}) => Object.assign({ target, pointerId: 1, clientX: 100, clientY: 100, preventDefault() { this._pd = true; } }, extra);
const pdTouch = (target, extra = {}) => pd(target, Object.assign({ pointerType: 'touch' }, extra));
const pdMouse = (target, extra = {}) => pd(target, Object.assign({ pointerType: 'mouse' }, extra));

// ── 跳转 ─────────────────────────────────────────────────────────
test('点时间戳跳到那一句的开头', () => {
  const w = mkWorld({ t: 61.5, at: 10 });
  w.line.fire('pointerdown', pd(w.stamp));
  assert.equal(w.audio.currentTime, 61.5);
});

test('★ 跳转当场把进度条和「已播」写一遍（timeupdate 250ms 才来，不写就像点了没反应）', () => {
  const w = mkWorld({ t: 61.5, at: 10, dur: 200 });
  w.line.fire('pointerdown', pd(w.stamp));
  assert.equal(w.fill.style.width, (61.5 / 200 * 100) + '%');
  assert.equal(w.cur.textContent, '1:01');
  assert.ok(w.log.ticks >= 1, '_mTick 没被叫');
});

test('★ 跳转必须把 idx 清成 -1 —— 往回跳到同一句时行号没变，不清就停在原处不亮', () => {
  const w = mkWorld({ t: 61.5, at: 90 });   // 当前在 90s，往回跳到 61.5s
  w.env._mLyric.idx = 1;                    // 且当前就是这一句
  w.line.fire('pointerdown', pd(w.stamp));
  assert.equal(w.env._mLyric.idx, -1, 'idx 没清 → _mSyncLyricLine 会因为行号相同提前 return');
  assert.equal(w.api.peek().wordCur, -1, '_mWordCur 没清 → 逐字点亮停在跳转前的位置');
  assert.deepEqual(w.log.sync, [['line', 61.5], ['words', 61.5]], '两条同步都要按新时间重跑');
});

test('时长内夹住：往后跳不许越过结尾，也不许为负', () => {
  const a = mkWorld({ t: 9999, dur: 200 });
  a.line.fire('pointerdown', pd(a.stamp));
  assert.ok(a.audio.currentTime <= 200 && a.audio.currentTime > 199, `夹到了 ${a.audio.currentTime}`);
  const b = mkWorld({ t: -5, dur: 200 });
  b.line.fire('pointerdown', pd(b.stamp));
  assert.equal(b.audio.currentTime, 0);
});

test('duration 还没拿到（NaN）也不能把 currentTime 写成 NaN', () => {
  const w = mkWorld({ t: 61.5, dur: NaN });
  w.line.fire('pointerdown', pd(w.stamp));
  assert.equal(w.audio.currentTime, 61.5);
  assert.ok(!Number.isNaN(w.audio.currentTime));
});

test('data-t 是坏的就什么都不做，别把播放头扔到 NaN', () => {
  const w = mkWorld({ t: 61.5, at: 30 });
  w.line.dataset.t = 'oops';
  w.line.fire('pointerdown', pd(w.stamp));
  assert.equal(w.audio.currentTime, 30, '原地不动才对');
});

// ── 长按 → 选择模式 → 复制（用户：逐条选择复制，也能复制全部歌词/全部译文）──
test('长按进选择模式、按住的这句先勾上；「复制所选」复制正文带上译文', async () => {
  const w = mkWorld();
  w.line.fire('pointerdown', pd(w.main));
  assert.ok(w.line.classList.contains('ly-holding'), '按下要有「在按着」的反馈');
  w.runTimers();
  assert.deepEqual(w.api.sel(), [1], '按住的那句（mLy1）要勾上');
  assert.ok(w.line.classList.contains('ly-picked'));
  assert.ok(w.box.classList.contains('ly-sel'));
  assert.ok(w.env.document._bar, '底部那条按钮要挂出来');
  assert.deepEqual(w.log.copied, [], '长按本身不复制（要先选）');
  w.api.copy('sel');
  assert.deepEqual(w.log.copied, ['第二句\nthe second']);
  await Promise.resolve();   // toast 挂在 copyTextCompat 的 .then 上，同步读不到
  assert.equal(w.log.toasts[0] && w.log.toasts[0][1], 'success', '复制完要给回执');
  assert.equal(w.api.sel(), null, '复制完退出选择模式');
  assert.equal(w.env.document._bar, null, '按钮条收掉');
});

test('★ 选择模式里点一下句子＝勾上/取消；滑动不算', () => {
  const w = mkWorld();
  w.line.fire('pointerdown', pd(w.main));
  w.runTimers();
  w.line.fire('pointerup', pd(w.main));           // 长按那一下抬手，不许把刚勾上的又取消掉
  assert.deepEqual(w.api.sel(), [1]);
  w.line.fire('pointerdown', pd(w.main));
  w.line.fire('pointerup', pd(w.main));
  assert.deepEqual(w.api.sel(), [], '再点一下取消');
  w.line.fire('pointerdown', pd(w.main));
  w.box.fire('pointermove', pd(w.main, { clientX: 100, clientY: 140 }));
  w.line.fire('pointerup', pd(w.main, { clientY: 140 }));
  assert.deepEqual(w.api.sel(), [], '滑歌词不是勾选');
  w.line.fire('pointerdown', pd(w.main));
  w.line.fire('pointerup', pd(w.main));
  assert.deepEqual(w.api.sel(), [1]);
  w.runTimers();
  assert.deepEqual(w.api.sel(), [1], '选择模式里不再起长按计时');
});

test('★ 点时间戳不许同时进长按判定（不然点一下是跳还是选看运气）', () => {
  const w = mkWorld();
  const ev = pd(w.stamp);
  w.line.fire('pointerdown', ev);
  assert.ok(ev._pd, '点时间戳要 preventDefault');
  w.runTimers();
  assert.equal(w.api.sel(), null, '跳转那一下不该进选择模式');
});

test('★ 手指一挪就取消 —— 滑歌词的时候不许偷偷进选择模式', () => {
  const w = mkWorld();
  w.line.fire('pointerdown', pd(w.main));
  w.box.fire('pointermove', pd(w.main, { clientX: 100, clientY: 140 }));
  w.runTimers();
  assert.equal(w.api.sel(), null);
  assert.ok(!w.line.classList.contains('ly-holding'), '取消了就要把按住的样子摘掉');
});

test('手指只抖一两像素不算滑动，照样进得去', () => {
  const w = mkWorld();
  w.line.fire('pointerdown', pd(w.main));
  w.box.fire('pointermove', pd(w.main, { clientX: 103, clientY: 102 }));
  w.runTimers();
  assert.deepEqual(w.api.sel(), [1]);
});

test('抬手 / 滚动都要把待触发的长按掐掉', () => {
  for (const evt of ['pointerup', 'pointercancel', 'scroll']) {
    const w = mkWorld();
    w.line.fire('pointerdown', pd(w.main));
    w.box.fire(evt, pd(w.main));
    w.runTimers();
    assert.equal(w.api.sel(), null, `${evt} 之后还进了选择模式`);
  }
});

test('点在歌词区空白处（不在任何一行上）什么都不做', () => {
  const w = mkWorld();
  w.box.fire('pointerdown', pd(w.box));
  w.box.fire('pointerup', pd(w.box));
  w.runTimers();
  assert.equal(w.api.sel(), null);
  assert.equal(w.audio.currentTime, 0);
});

// ── 跟指针走，不跟播放位置 ───────────────────────────────────────
// 老样子是「只有正在唱的那句挂着可见的角标」，看着就像只有那一句能跳。
// 现在：鼠标悬到哪一行哪一行浮出（CSS :hover），手指碰一下整片浮出（.ly-scrub）。
// 跳转只认角标：09-25 曾改成「整行短按就跳」，用户说容易误点，退回来了。
test('★ 短按整行不跳 —— 只有点时间戳 / ▸ 才跳（整行都能跳太容易误点）', () => {
  for (const ev of [pd(null), pdMouse(null), pdTouch(null)]) {
    const w = mkWorld({ t: 61.5, at: 10 });
    const e = Object.assign({}, ev, { target: w.main });
    w.line.fire('pointerdown', e);
    w.line.fire('pointerup', e);
    assert.equal(w.audio.currentTime, 10, `${e.pointerType || '默认'} 短按正文就把播放头挪走了`);
    assert.deepEqual(w.log.sync, [], '没跳就不该重算当前行');
  }
});

test('★ 点时间戳会跳，且会被主区域「单击切沉浸」放过', () => {
  const w = mkWorld({ t: 61.5, at: 10 });
  w.line.fire('pointerdown', pd(w.stamp));
  w.line.fire('pointerup', pd(w.stamp));
  assert.equal(w.audio.currentTime, 61.5);
  const ign = SRC.match(/function _mTapIgnored\(ev\) \{[^\n]*\}/);
  assert.ok(ign, '抠不到 _mTapIgnored');
  const fn = new Function('return ' + ign[0])();
  assert.equal(fn({ button: 0, target: w.stamp }), true, '点时间戳跳完，抬手又切了沉浸');
  assert.equal(fn({ button: 0, target: w.main }), false, '点歌词正文仍然是切沉浸');
});

test('★ 长按进选择模式的那一下，抬手不许再跳（不然选完播放头还被挪走）', () => {
  const w = mkWorld({ t: 61.5, at: 10 });
  w.line.fire('pointerdown', pd(w.main));
  w.runTimers();                                  // 按够 520ms，进选择模式
  w.line.fire('pointerup', pd(w.main));
  assert.deepEqual(w.api.sel(), [1]);
  assert.equal(w.audio.currentTime, 10, '长按之后播放头要原地不动');
});

test('★ 滑歌词之后抬手不许跳 —— 那是滚动不是点击', () => {
  const w = mkWorld({ t: 61.5, at: 10 });
  w.line.fire('pointerdown', pd(w.main));
  w.box.fire('pointermove', pd(w.main, { clientY: 160 }));
  w.line.fire('pointerup', pd(w.main, { clientY: 160 }));
  assert.equal(w.audio.currentTime, 10);
});

test('★ 点角标只跳一次 —— pointerdown 跳完，pointerup 不许再跳一遍', () => {
  const w = mkWorld({ t: 61.5, at: 10 });
  w.line.fire('pointerdown', pd(w.stamp));
  w.line.fire('pointerup', pd(w.stamp));
  assert.deepEqual(w.log.sync, [['line', 61.5], ['words', 61.5]], '跳了两遍的话这里是四条');
});

test('★ 手指碰歌词区＝触屏那侧的「悬停」；鼠标不该触发它（鼠标走 CSS :hover）', () => {
  const t = mkWorld();
  t.box.fire('pointerdown', pdTouch(t.main));
  assert.ok(t.box.classList.contains('ly-scrub'), '手指碰了却没浮出来');
  const m = mkWorld();
  m.box.fire('pointerdown', pdMouse(m.main));
  assert.ok(!m.box.classList.contains('ly-scrub'), '鼠标走 :hover，不该同时走这条');
});

test('★ 滑动过程中一直算「手指在上面」，停手才撤 —— 常亮着就又变回噪点了', () => {
  const w = mkWorld();
  w.box.fire('pointerdown', pdTouch(w.main));
  w.box.fire('pointermove', pdTouch(w.main, { clientY: 160, buttons: 1 }));
  assert.ok(w.box.classList.contains('ly-scrub'), '滑到一半就撤掉了');
  w.runTimers();
  assert.ok(!w.box.classList.contains('ly-scrub'), '停手之后该撤');
});

// ── 重绘与渲染契约 ───────────────────────────────────────────────
test('★ 手势是委托挂在容器上、且只挂一次 —— innerHTML 每次重画会把行上的 handler 全带走', () => {
  assert.match(SRC, /function _mLyBind\(box\)\s*\{\s*\n\s*if \(box\._lyBound\) return;/,
    '没有「挂过就不再挂」的闸，每次重画都会叠一层 handler');
  // 绑定发生在 _mPaintLyric 里（重画的唯一入口），而不是某个只跑一次的初始化
  const paint = SRC.match(/function _mPaintLyric\(\) \{[\s\S]*?\n\}/);
  assert.ok(paint, '抠不到 _mPaintLyric');
  assert.match(paint[0], /_mLyBind\(box\)/);
  // 委托的落点必须是容器：挂在 .music-ly-line 上就等于每次重画后失效
  assert.match(SEG, /box\.addEventListener\('pointerdown'/);
});

test('★ 每行都带 data-t，cinema 模式不挂时间戳（绝对定位居中，角标会把版面顶歪）', () => {
  const paint = SRC.match(/function _mPaintLyric\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(paint, /id="mLy\$\{i\}" data-t="\$\{\(l\.t \|\| 0\)\.toFixed\(2\)\}"/);
  assert.match(paint, /cineOn \? '' : `<i class="ly-t"/);
});

test('★ 角标的可见性挂在指针上，不挂在播放位置上', () => {
  assert.match(CSS, /\.ly-t \{[^}]*position:absolute/);
  // 鼠标：悬到哪一行，哪一行浮出
  assert.match(CSS, /\.music-ly-line:hover \.ly-t \{[^}]*opacity:\.\d/);
  // 手指：没有 hover，靠 JS 打的 .ly-scrub 整片浮出
  assert.match(CSS, /\.music-lyric\.ly-scrub \.ly-t \{[^}]*opacity:\.\d/);
  // 老样子必须真的没了。这两条是"播放到哪哪显示"的本体：
  //   · .on 自己挂一个可见角标 → 看着像只有正在唱的这句能跳
  //   · hover:none 下一律常显 → 长句永远被角标压着
  // 注释里没出现过这两个选择器串，所以这里不会被自己的注释反咬（踩过：断言匹配到注释里的反例）
  assert.doesNotMatch(CSS, /\.music-ly-line\.on \.ly-t/);
  assert.doesNotMatch(CSS, /@media \(hover:none\)[\s\S]{0,200}\.ly-t \{ opacity:\.34/);
  assert.match(CSS, /\.music-ly-line\.ly-holding/);
  assert.match(CSS, /@keyframes lyCopied/);
});
