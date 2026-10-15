'use strict';
// 手机⇄电脑断点一跨，键盘位上的面板要当场收干净。
//
// 用户截图：窗口拉窄（手机态）→ 点表情库 → 直接拉宽，
// 输入栏悬在屏幕中间，底下一片暗。原因是手机态打开时：面板搬去了 body、
// 输入栏被 margin-bottom 抬了一个面板高、遮罩亮着；拉宽以后电脑端 .closing 没动画，
// animationend 永远不来，这些全卡住，而且再点表情按钮也开不出来。
//
// 跑的是真函数（vm 里加载 js/10-stickers-voice.js），拿到它挂在媒体查询上的监听器直接触发。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

function el(id, classes = []) {
  const cls = new Set(classes);
  return {
    id, style: {}, parentNode: null, nextSibling: null,
    classList: {
      contains: c => cls.has(c),
      add: (...cs) => cs.forEach(c => cls.add(c)),
      remove: (...cs) => cs.forEach(c => cls.delete(c)),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
    },
    insertBefore(child) { child.parentNode = this; },
    appendChild(child) { child.parentNode = this; },
    addEventListener() {}, removeEventListener() {},
  };
}

// 摆成「手机态开着表情面板」的样子
const body = el('body');
const inputBar = el('inputBar');
const panel = el('stickerPanel', ['open']);
panel.parentNode = body; panel._gcHome = inputBar; panel._gcNext = null;
const overlay = el('stickerOverlay', ['open']);
const emojiBtn = el('emojiBtn', ['open']);
const wrap = el('wrap', ['panel-open']);
wrap.style.marginBottom = '320px'; wrap.style.zIndex = '502'; wrap.style.transition = 'margin-bottom .22s';
const byId = { stickerPanel: panel, stickerOverlay: overlay, emojiBtn };

const mqListeners = [];
const closed = [];
const ctx = {
  console,
  setTimeout, clearTimeout, requestAnimationFrame: f => f(),
  document: {
    body, addEventListener() {},
    getElementById: id => byId[id] || null,
    querySelector: s => (s === '.input-bar-wrap' ? wrap : null),
    querySelectorAll: () => [],
    createElement: () => el('x'),
  },
  window: {
    addEventListener() {},
    matchMedia: q => ({ media: q, matches: false, addEventListener: (type, fn) => mqListeners.push({ q, type, fn }) }),
  },
  navigator: { mediaDevices: {} },
  closeMathPanel: () => closed.push('math'),
  closeFancyPanel: () => closed.push('fancy'),
  updateComposerBtns: () => closed.push('composer'),
  isMobileLayout: () => false,
  state: {},
  SERVER_BASE: '',
};
ctx.window.innerWidth = 1900; ctx.window.innerHeight = 750;
vm.createContext(ctx);
vm.runInContext(read('js/10-stickers-voice.js'), ctx, { filename: '10-stickers-voice.js' });

const bp = mqListeners.find(l => /max-width:\s*768px/.test(l.q) && l.type === 'change');
t('挂在和 CSS 一致的手机断点上', !!bp, mqListeners.map(l => l.q));
// 断点要和 CSS / 02-state.js 的 mobileMq 一字不差，不然横屏矮屏会漏
t('断点含横屏矮屏那半句', !!bp && /max-height:\s*500px\) and \(orientation:\s*landscape\)/.test(bp.q), bp && bp.q);

if (bp) bp.fn({ matches: false });

t('★ 表情面板收掉', !panel.classList.contains('open') && !panel.classList.contains('closing'));
t('★ 面板搬回输入栏（不留在 body 上）', panel.parentNode === inputBar);
t('★ 遮罩灭掉', !overlay.classList.contains('open'));
t('★ 输入栏落回原位（不悬在半空）', wrap.style.marginBottom === '', wrap.style.marginBottom);
t('输入栏 z-index / transition 当场清掉，不等 240ms 尾巴', wrap.style.zIndex === '' && wrap.style.transition === '');
t('输入栏 panel-open 摘掉', !wrap.classList.contains('panel-open'));
t('表情按钮从键盘图标换回来', !emojiBtn.classList.contains('open'));
t('同一块键盘位上的公式 / 花字面板也一起收', closed.includes('math') && closed.includes('fancy'));

console.log('');
console.log(pass + ' 通过，' + fail + ' 失败');
if (fail) process.exit(1);
