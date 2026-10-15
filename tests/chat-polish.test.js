// ui-polish/chat（2026-10-14）：消息流打磨的几条「改坏了不报错、只是界面悄悄变回去」的约定。
//   A03 手机上只有最后一条 AI 消息常驻操作条（用户拍板），其余点气泡 / 长按调出
//   A10 操作条图标画在 ::before 上，朗读的 id 在内层 span（07-band-tts 写 textContent 不冲掉图标）
//   A11 右键 / 长按菜单文案统一中文
//   A13 手机上右侧导航列平时收着
//   A02 Markdown 列表 / 引用 / h2 伪斜体
//   A01 地盘里不再写死冷海军蓝底和旧靛蓝
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(extra).slice(0, 300) : '')); }
}
function funcBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  return '';
}
// 按区段注释标题切出一段 css（到下一个 `/* ── ` 标题为止）
function section(css, title) {
  const i = css.indexOf(title);
  if (i < 0) return '';
  const j = css.indexOf('\n/* ── ', i + title.length);
  return css.slice(i, j < 0 ? undefined : j);
}

const css = read('css/grancyan.css');
const rm = read('js/06-render-msg.js');
const html = read('index.html');

console.log('\n[A03] 手机只有最后一条 AI 常驻操作条');
{
  const r = funcBody(rm, 'renderMessages');
  t('renderMessages 给最后一条 AI 的包装层挂 is-last-ai', /classList\.toggle\('is-last-ai'/.test(r), r.slice(-600));
  t('  而且是按 role 倒着找的（不是简单取最后一个包装层——最后一条可能是她的）',
    /path\[i\]\.role !== 'user'/.test(r));
  const m = css.match(/@media \(hover:none\) \{\s*\.msg-actions \{ display:none; \}([\s\S]*?)\n\}/);
  t('触屏下操作条默认收起（display:none，不占地方）', !!m);
  t('  .is-last-ai 和点出来的 .acts-on 才显示', !!m && /\[data-msg-wrapper\]\.is-last-ai \.msg-actions/.test(m[1]) && /\.msg-group\.acts-on \.msg-actions/.test(m[1]), m && m[1]);
  t('点气泡的处理挂在 pointerup 上（跟 18-gesture 双击判定同一时刻），并让开双击的全屏页',
    /addEventListener\('pointerup', _msgTapActions/.test(rm) && /msgTextView'\)\?\.classList\.contains\('open'\)/.test(funcBody(rm, '_msgTapActions')));
  t('  多选模式 / 长按 / 滑动都让开', /state\.isSelectMode/.test(funcBody(rm, '_msgTapActions'))
    && /> 450/.test(funcBody(rm, '_msgTapActions')) && /> 10\)/.test(funcBody(rm, '_msgTapActions')));
}

console.log('\n[A10] 操作条图标');
{
  t('朗读的 id 挪到内层 span（07-band-tts 改 textContent 时按钮的图标不被冲掉）',
    /<button class="msg-action-btn" data-ic="speak"[^>]*><span class="ma-tts" id="tts-btn-\$\{m\.id\}">/.test(rm));
  t('  它的打头 emoji 用 ::first-letter 收成 0 宽', /\.ma-tts::first-letter \{ font-size:0; \}/.test(css));
  t('操作条按钮不再带彩色 emoji / 内联红字', !/msg-action-btn[^`]*?(🗑|🔊 朗读<\/button>|style="color:#f87171")/.test(rm));
  t('删除平时不红，悬停才红', /\.msg-action-btn\.ma-del:hover \{ color:#f87171/.test(css));
  t('收藏原地切换时连 .on 一起换（实心星）', /b\.classList\.toggle\('on', nowFav\)/.test(funcBody(rm, 'toggleFavMsg')));
  t('键盘 Tab 进来操作条也出现', /\.msg-group:focus-within \.msg-actions/.test(css));
  // 图标是 background:currentColor + mask。某个 data-ic 值没配 --ic 的话 mask 整条失效，画出来是一个实心方块
  const used = new Set([...(rm + html).matchAll(/data-ic="([a-z-]+)"/g)].map(m => m[1]));
  const missing = [...used].filter(v => !new RegExp('\\[data-ic="' + v + '"\\][^{]*\\{[^}]*--ic:var\\(--ma-[a-z]+\\)').test(css)
    || !new RegExp('--ma-' + ((css.match(new RegExp('\\[data-ic="' + v + '"\\][^{]*\\{[^}]*--ic:var\\(--ma-([a-z]+)\\)')) || [])[1] || '\u0000') + ':url\\(').test(css));
  t('每个用到的 data-ic 都配了图标（漏配会画成实心方块）', used.size >= 10 && missing.length === 0, JSON.stringify({ used: [...used], missing }));
  t('👍👎 只剩图标，带 aria-label 给读屏', /data-ic="up" aria-label="写得好"/.test(rm) && /data-ic="down" aria-label="不对味"/.test(rm));
  t('收藏面板里删掉一条，原消息的按钮也换字 + 切 .on（不再写回「★ 已收藏 / ☆ 收藏」）',
    /b\.textContent = on \? '已收藏' : '收藏'; b\.classList\.toggle\('on', on\);/.test(funcBody(rm, 'removeFav')) && !/'☆ 收藏'/.test(funcBody(rm, 'removeFav')));
}

console.log('\n[A11] 右键 / 长按菜单中文');
{
  const menu = (html.match(/<div id="contextMenu"[\s\S]*?<\/div>/) || [''])[0];
  const menuText = menu.replace(/<[^>]*>/g, ' ');   // 只看露给她的字（onclick 里的 ctxCopyMsg 之类不算）
  t('菜单里没有 Reply / Copy / Delete', menu && !/Reply|Copy|Delete/.test(menuText), menuText);
  t('  回复 / 复制 / 标注 / 错题本 / 多选 / 删除 都在', ['回复', '复制', '标注', '错题本', '多选', '删除'].every(w => menu.includes('>' + w + '</button>')));
  t('浮动引用键也是中文', /id="floatReplyBtn"[^>]*>↩ 回复</.test(html));
  t('删除不再写死红色内联', !/ctxDeleteMsg\(\)" style="color/.test(menu));
  t('手机底条排成三列格子、不被大手机块的 max-width 挤偏', /#contextMenu\.ctx-mobile-bar \{ flex-wrap:wrap;gap:6px;max-width:none; \}/.test(css)
    && /#contextMenu\.ctx-mobile-bar button \{ flex:1 1 calc\(\(100% - 12px\) \/ 3\)/.test(css));
}

console.log('\n[A13] 手机导航列');
{
  t('触屏下 ⬆↑↓ 平时 opacity:0，.nav-awake 才浮出', /html:root body #msgNavBar \.msg-nav-btn, html:root body #msgNavBar \.nav-sep \{ opacity:0;/.test(css)
    && /html:root body #msgNavBar\.nav-awake \.msg-nav-btn/.test(css));
  t('  整列收起的那条特异度压得过 choco-shape 的 html.ui-choco #msgNavBar（1,1,1；它后加载）',
    /\n  html:root body #msgNavBar \{\s*opacity:1; pointer-events:none;\s*background:transparent;/.test(css));
  t('唤醒认手指（touchmove）不认 scroll 事件（自动滚到底 / 流式出字都会发 scroll）',
    /addEventListener\('touchmove', _msgNavWake/.test(rm) && !/addEventListener\('scroll', _msgNavWake/.test(rm));
}

console.log('\n[A32] 代码块长行的横滚提示');
{
  t('提示挂在真正横滚的 code.hljs 上（只挂 pre 的话一下都不会亮：pre 的 scrollWidth 等于自己宽）',
    /\.code-block-wrap pre > code \{ animation:codeEdgeFade linear both;animation-timeline:scroll\(self inline\); \}/.test(css)
    || /\.code-block-wrap pre, \.code-block-wrap pre > code \{ animation:codeEdgeFade linear both;animation-timeline:scroll\(self inline\); \}/.test(css));
  t('  关键帧起点只淡右边、终点只淡左边', /@keyframes codeEdgeFade \{\s*0%, 3% \{[^}]*calc\(100% - 40px\),transparent\)[^}]*\}[\s\S]*?97%, 100% \{[^}]*transparent,black 28px\)/.test(css));
}

console.log('\n[A02] Markdown');
{
  t('列表有圆点和序号（preflight 清掉的 list-style 补回来）', /\.bubble ul,[^{]*\{ list-style:disc; \}/.test(css) && /\.bubble ol,[^{]*\{ list-style:decimal; \}/.test(css));
  t('> 引用有样式', /\.bubble blockquote,[^{]*\{[^}]*border-left:3px solid/.test(css));
  t('h2 保留拉丁斜体、中文不被硬拧', /\.bubble\.ai h2 \{[^}]*font-style:italic;[^}]*font-synthesis-style:none/.test(css));
}

console.log('\n[A01] chat 地盘不再写死海军蓝 / 旧靛蓝');
{
  const NAVY = /rgba\((9|1\d|2[0-5]),\s*(9|1\d|2[0-5]),\s*(1[5-9]|2\d|3[0-5])\s*,|99,\s*102,\s*241|#0d0d16|d4d4ff/;
  const titles = ['/* ── Artifact 画布面板 ── */', '/* ── Chat Window ── */', '/* ── 花字的动起来', '/* ── 操作条图标',
    '/* ── Multi-response container ── */', '/* ── Avatars ── */', '/* ── 群聊：微信', '/* ── 单对话：ChatGPT',
    '/* ── 头像列 / 内容列的骨架', '气泡手势：左滑引用', '/* ── Quote/Reply ── */', '/* ── Context Menu (右键/长按) ── */',
    '/* ── Code Blocks ── */', '/* ── Msg Navigation Bar ── */', '/* ── Right Scrubber ── */', '/* ── Inline edit textarea ── */',
    '/* ── 浅色壁纸的文字底衬', '/* ── Thinking / reasoning collapsible ── */', '/* ── claude.ai 风格内联思考块 ── */',
    '/* ── Improved right-side nav arrows ── */', '/* ── Toast Notification ── */'];
  for (const ti of titles) {
    const s = section(css, ti);
    const hit = s.split('\n').find(l => NAVY.test(l));
    t('  ' + ti.replace(/\/\* ── | ──.*$/g, ''), s && !hit, s ? hit : '找不到这个区段');
  }
  const hdr = (css.match(/\nheader \{[^}]*\}/) || [''])[0];
  t('  header', hdr && !NAVY.test(hdr), hdr);
  const tv = (css.match(/#msgTextView \{[^}]*\}/) || [''])[0];
  t('  全屏文本页', tv && !NAVY.test(tv), tv);
  t('  toast 走 --bg-rgb + --solid-a', /\.toast \{\s*background:rgba\(var\(--bg-rgb\),var\(--solid-a\)\)/.test(css));
}

console.log('\n[交接] foundation 的 .gc-close 动效在第一个 reduced-motion 块里关');
{
  const i = css.indexOf('prefers-reduced-motion');
  const blk = css.slice(i, css.indexOf('\n}', i));
  t('.gc-close,.gc-close:hover{transition:none;transform:none} 在块里', blk.includes('.gc-close,.gc-close:hover{transition:none;transform:none}'), blk);
  t('  而且没挤到 .mark-text 前面（mark-style.test 要 600 字内见到它）', blk.indexOf('.mark-text') >= 0 && blk.indexOf('.mark-text') < blk.indexOf('.gc-close'));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
