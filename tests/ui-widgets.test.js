'use strict';
// ui-polish / widgets（2026-10-14）：全屏小组件的通用壳、统一关闭键、画板换画不闪白。
//
// 守的是「零报错、只会长得不对」的那几件：
//   壳的底色又写回死灰 #111（不跟色温）；新加的小组件又抄了老的 .art-close（一颗孤零零的细 ✕）；
//   画板换画时 iframe 先铺一大块白（A28）。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const css = read('css/grancyan.css');
const html = read('index.html');

console.log('\n[壳]');
const overlay = (css.match(/\n\.cap-overlay \{([^}]*)\}/) || [, ''])[1];
t('.cap-overlay 的底走 --bg-main（跟色温），不再兜底成死灰 #111', /var\(--bg-main\)/.test(overlay) && !/#111/.test(overlay), overlay);
t('.cap-overlay 顶上那层晕跟强调色走（--accent-rgb）', /radial-gradient\([^;]*rgba\(var\(--accent-rgb\)/.test(overlay));
const h3 = (css.match(/\n\.cap-header h3 \{([^}]*)\}/) || [, ''])[1];
t('标题加粗时走 --font-cjk-strong（宋体硬加粗会糊）', /font-weight:600/.test(h3) && /font-family:var\(--font-cjk-strong\)/.test(h3), h3);

console.log('\n[关闭键]');
// 刻意做了美术、自己配了关闭键样式的几个留着老的；其余全屏小组件都用公共的 .gc-close
const KEEP = ['closeDiary', 'closeTreasure'];
// 标题栏里可能嵌着别的 div（画图板的标签页），所以不按第一个 </div> 截，而是从标题栏开头一直找到第一颗 onclick="closeXxx()" 的按钮；
// 属性顺序不限（title 写在 onclick 前面也认得）
const overlayIds = [...html.matchAll(/<div id="(\w+Modal)" class="cap-overlay hidden">/g)].map(m => m[1]);
const closes = overlayIds.map(id => {
  const from = html.indexOf('<div id="' + id + '"');
  const head = html.indexOf('<div class="cap-header">', from);
  const next = html.indexOf('class="cap-overlay', html.indexOf('>', from));
  if (head < 0 || (next > 0 && head > next)) return null;
  const btn = html.slice(head).match(/<button\b([^>]*\bonclick="(close\w*)\(\)"[^>]*)>/);
  return btn ? [((btn[1].match(/\bclass="([^"]*)"/) || [])[1] || ''), btn[2], id] : null;
}).filter(Boolean);
const capHeaders = overlayIds.filter(id => { const f = html.indexOf('<div id="' + id + '"'); const h = html.indexOf('<div class="cap-header">', f); const n = html.indexOf('class="cap-overlay', html.indexOf('>', f)); return h > 0 && (n < 0 || h < n); });
t('每个带标题栏的小组件都扫到了关闭键（一个都没漏）', closes.length >= 20 && closes.length === capHeaders.length,
  [closes.length, capHeaders.filter(id => !closes.some(c => c[2] === id))]);
t('画图板（标题栏里嵌着标签页 div）也扫到了', closes.some(c => c[2] === 'ggbModal'));
const stray = closes.filter(([cls, fn]) => !KEEP.includes(fn) && !/\bgc-close\b/.test(cls)).map(x => x[1]);
t('标题栏里的关闭键都是 .gc-close（美术组件除外）', stray.length === 0, stray);
const both = closes.filter(([cls]) => /\bgc-close\b/.test(cls) && /\bart-close\b/.test(cls)).map(x => x[1]);
t('没有同时挂两个 class（.art-close 在后面的内联样式里，会把尺寸盖回去）', both.length === 0, both);
t('.cap-header 里的 .gc-close 被推到最右', /\.cap-header > \.gc-close \{ margin-left:auto; \}/.test(css));

console.log('\n[画板换画不闪白]');
const gsrc = read('js/53-gallery.js');
const a = gsrc.indexOf('let _galleryLoadTimer');
const b = gsrc.indexOf('\n}\n', gsrc.indexOf('function galleryStageLoad', a)) + 3;
t('有 galleryStageLoad', a > 0 && b > a);
const box = { setTimeout: (fn, ms) => { box._timer = { fn, ms }; return 1; }, clearTimeout() {} };
vm.createContext(box);
vm.runInContext(gsrc.slice(a, b), box);
const cls = new Set();
const stage = { classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) } };
const frame = { srcdoc: '' };
box.galleryStageLoad(stage, frame, '<p>画</p>');
t('换画时舞台先挂 is-loading', cls.has('is-loading') && frame.srcdoc === '<p>画</p>');
frame.onload();
t('load 了就摘掉，画淡入', !cls.has('is-loading'));
box.galleryStageLoad(stage, frame, '<p>另一张</p>');
t('load 迟迟不来，最多藏 4 秒', box._timer && box._timer.ms <= 4000 && (box._timer.fn(), !cls.has('is-loading')));
// 重播先 srcdoc='' 再赋新画：清空那次回来的 load 文档是空的，不能当成新画画完
box.galleryStageLoad(stage, frame, '<p>重播</p>');
frame.contentDocument = { body: { childNodes: [] } };
frame.onload();
t('空文档的 load（重播清空那次）不提前淡入', cls.has('is-loading'));
frame.contentDocument = { body: { childNodes: [1] } };
frame.onload();
t('新画真画出来了才淡入', !cls.has('is-loading'));
// 连点两幅：前一幅的 4 秒兜底不能把后一幅提前亮出来
box.galleryStageLoad(stage, frame, '<p>甲</p>');
const oldTimer = box._timer;
box.galleryStageLoad(stage, frame, '<p>乙</p>');
oldTimer.fn();
t('前一幅的兜底计时器不摘后一幅的 is-loading', cls.has('is-loading'));
t('渲染和重播都走它（不再直接塞 srcdoc）', /galleryStageLoad\(stage, frame, galleryStageDoc\(sel\)\)/.test(gsrc) && /galleryStageLoad\(document\.getElementById\('galleryStage'\), frame, galleryStageDoc\(it\)\)/.test(gsrc));
t('CSS：is-loading 时 iframe 透明', /\.gallery-stage\.is-loading iframe\{opacity:0\}/.test(css));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
