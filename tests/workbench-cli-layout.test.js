'use strict';
// 编程工作台：CLI 版式（2026-08-28）
// 这一套全是「改回去也不报错、只是看着不对」的东西，所以每条都真跑渲染函数
// 或真查 CSS 规则，不做宽泛的字符串包含。
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

const ui = read('js/41-code-workbench.js');
const css = read('css/grancyan.css');
const html = read('index.html');
const NL = String.fromCharCode(10);

// 真跑渲染段
const from = ui.indexOf('function cwRenderMessage');
const to = ui.indexOf('function cwRender(');
const box = {};
vm.createContext(box);
vm.runInContext([
  'var _E={"&":"&amp;","<":"&lt;",">":"&gt;"};',
  'function escHtml(s){return String(s).replace(/[&<>]/g,function(c){return _E[c];});}',
  'function cwTimingText(){return "";}',
  ui.slice(from, to),
  'this.msg=cwRenderMessage; this.ev=cwRenderEvent; this.diff=cwDiffLines; this.banner=cwCompactBanner;',
].join(NL), box);

console.log('[1] 一条文本流，不是气泡卡片');
const um = box.msg({ role: 'user', content: 'hi', at: 0 });
const am = box.msg({ role: 'assistant', provider: 'claude', content: 'yo', at: 0 });
t('用户消息行首是 >（CC 的输入提示符）', /class="cw-gutter"[^>]*>&gt;</.test(um));
t('助手消息行首是 ⏺ 而不是姓名 header', /class="cw-gutter"[^>]*>⏺</.test(am));
t('不再渲染姓名 header（名字进 title，不占一行）', !/<header/.test(um + am));
t('名字和时间没丢，只是挪进了 title（没设用户名时叫「用户」）', /title="[^"]*用户[^"]*"/.test(um));
// .cw-msg>div 曾经是 border+border-radius+background 的气泡
const msgBox = (css.match(/\.cw-msg>div\{[^}]*\}/) || [''])[0];
t('.cw-msg>div 不再有边框/圆角/底色（气泡的三件套）',
  !/border|radius|background/.test(msgBox), msgBox);

console.log('[2] gutter 是同一列 —— 对不齐就不像 CLI 了');
const msgCol = (css.match(/\.cw-msg\{[^}]*grid-template-columns:([^;}]*)/) || [])[1];
const evCol = (css.match(/\.cw-ev-head\{[^}]*grid-template-columns:([^;}]*)/) || [])[1];
t('消息和事件用同一套列宽（消息=' + msgCol + ' 事件=' + evCol + '）',
  !!msgCol && msgCol === evCol);
const indent = (css.match(/\.cw-ev-body\{[^}]*margin:[^;}]*?(\d+)px\}/) || [])[1];
t('事件正文缩进 = gutter 宽 + gap（压在标题文字下，不是压在标记下）',
  /margin:[^;}]*25px/.test((css.match(/\.cw-ev-body\{[^}]*\}/) || [''])[0]));

// 用户：「工作台的字体不用换，除了代码渲染的字体」。
// 所以分两类：正文（消息、事件标题、输入框）走全局 --font；
// 只有工具原始输出、快捷键提示和 gutter 符号列走 --mono。
// 下一个「做得更像 CLI」的改动很容易把整个 feed 推回等宽，所以销在这里。
console.log('[3] 字体分工 —— 正文走全局字体，只有代码等宽');
t('有独立的 --mono 变量', /--mono:\s*[^;]*monospace/.test(css));
t('没有拿 --mono 顶替全局 --font（全局衬线是用户选的）',
  /--font:\s*'Cormorant Garamond'/.test(css));
const rule = (sel) => { const i = css.indexOf(sel + '{'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1); };
for (const sel of ['.cw-feed', '.cw-ev-name', '.cw-ev-sub', '.cw-thinking-live', '.cw-msg-timing', '.cw-compose textarea']) {
  const r = rule(sel);
  t(sel + ' 是正文，不能被换成等宽', !!r && !/var\(--mono\)/.test(r) && /var\(--font\)/.test(r), r.slice(0, 110));
}
for (const sel of ['.cw-gutter', '.cw-ev-body', '.cw-prompt', '.cw-compose-meta']) {
  const r = rule(sel);
  t(sel + ' 是代码/符号列，保持等宽', !!r && /var\(--mono\)/.test(r), r.slice(0, 110));
}

console.log('[4] diff 行距 —— 这条不守住就会静默变成双倍行距');
const d = box.diff(['- a', '+ b'].join(NL));
t('span 之间不拼换行（span 是 display:block，pre 里再来个换行=每行都空一行）',
  !d.includes('</span>' + NL + '<span'), d);
t('CSS 里那些 span 确实是 display:block（上一条的前提）',
  /\.cw-event pre>span\{[^}]*display:block/.test(css));
t('加删行仍各自带 class', /cw-diff-del/.test(d) && /cw-diff-add/.test(d));

console.log('[5] 长输出默认折叠，短的不折叠');
const longBody = 'Read(x.js)' + NL + Array.from({ length: 30 }, (_, i) => 'line ' + i).join(NL);
const short = box.ev({ kind: 'tool', text: 'Read(x.js)' + NL + 'one line', at: 1 }, 0);
const big = box.ev({ kind: 'tool', text: longBody, at: 2 }, 1);
t('长输出标成 foldable 且默认不展开', /class="cw-event tool foldable"/.test(big), big.slice(0, 60));
t('长输出给出一行摘要（⎿ N 行）', /cw-ev-sub[\s\S]*行/.test(big));
t('短输出不折叠、直接展开', /class="cw-event tool open"/.test(short) && !/foldable/.test(short));
t('折叠态的正文被 CSS 藏起来（只加 class 不写样式=白折叠）',
  /\.cw-event\.foldable:not\(\.open\) \.cw-ev-body\{display:none\}/.test(css));

console.log('[6] 工具行是 名字(参数) —— CC 最认得出的那一眼');
t('工具名加粗、参数分开着色', /<b>Read<\/b><i>\(x\.js\)<\/i>/.test(short), short);
t('思考行是 Thinking… 不是原文首行',
  /<b>Thinking…<\/b>/.test(box.ev({ kind: 'thinking', text: 'aaa' + NL + 'bbb', at: 3 }, 0)));

console.log('[7] 输入框是带提示符的整框');
t('输入框外面包了 cw-input-wrap', /class="cw-input-wrap"/.test(html));
t('框里有 > 提示符', /class="cw-prompt"[^>]*>&gt;</.test(html));
t('提示符对读屏隐藏（它是装饰，不该被念出来）', /class="cw-prompt" aria-hidden="true"/.test(html));
t('焦点环挂在外框上，不是 textarea 上（textarea 已经没边框了）',
  /\.cw-input-wrap:focus-within\{border-color/.test(css));

console.log('[8] 没留下死规则');
t('.cw-msg header 的旧规则已删干净', !/\.cw-msg header/.test(css));

console.log('[10] compact 在默认视图里看得见');
// 用户报的：敲了 /compact，界面上没有任何反应。
// 两条根因：默认视图整个不渲染 events（所有斜杠命令都没回音），
// 且那条压缩横幅是手写 HTML，改成 gutter 版式后对不齐了。
t('没压缩过时不渲染横幅（空会话不该顶着一条提示）', box.banner({ messages: [] }) === '');
t('compactSummary 为空串也不渲染', box.banner({ compactSummary: '', messages: [] }) === '');
const longSummary = Array.from({ length: 40 }, (_, i) => '用户：第' + i + '句').join(NL);
const bn = box.banner({ compactSummary: longSummary, compactedCount: 18, compactedAt: 1, messages: [1, 2, 3, 4, 5, 6] });
t('横幅走 cw-event 结构，不是裸 span+pre（裸标记没有 gutter 样式，会贴到左边缘）',
  /class="cw-event compact/.test(bn) && /class="cw-ev-head"/.test(bn) && /class="cw-gutter"/.test(bn), bn.slice(0, 80));
t('行首标记是 ↯，跟工具行的 ⏺ 区分得开', /class="cw-gutter">↯</.test(bn));
t('正文用 cw-ev-body（拿到和事件一样的缩进）', /class="cw-ev-body"/.test(bn));
t('说清压缩了多少条', /18 条/.test(bn));
t('说清保留了多少条原文', /保留最近 6 条/.test(bn));
t('长摘要可折叠，默认收起（横幅不该占掉半屏）',
  /class="cw-event compact foldable"/.test(bn) && !/ open/.test(bn));
t('摘要全文进正文，不再截断到 220 字（截断=想看也看不到）',
  bn.includes('第39句') && bn.includes('第0句'));
const shortBn = box.banner({ compactSummary: '一句话', compactedCount: 2, messages: [1] });
t('短摘要不折叠、直接可读', / open/.test(shortBn) && !/foldable/.test(shortBn));
t('CSS 给了 .cw-event.compact 的 gutter 配色（只发 class 不写样式=看不出来）',
  /\.cw-event\.compact \.cw-gutter\{color:/.test(css));
t('横幅底下有分隔线（它标的是「上面的没了」这个断点）',
  /\.cw-event\.compact\{[^}]*border-bottom/.test(css));

console.log('[11] 默认视图渲染会话级通知');
const feedBlock = ui.slice(ui.indexOf('const notices'), ui.indexOf('feed.scrollTop'));
t('默认视图把 status 事件并进流里（不然 /compact /status 敲了毫无回音）',
  /kind === 'status'/.test(feedBlock), feedBlock.slice(0, 120));
t('error 事件也在默认视图里（错误藏进 trace 视图=用户不知道跑挂了）',
  /kind === 'error'/.test(feedBlock));
t('tool/thinking 仍不进默认视图（量太大会淹掉对话）',
  !/'tool'/.test(feedBlock) && !/'thinking'/.test(feedBlock));
t('通知和消息按时间排序，不是拼在末尾',
  /sort\(\(a, b\) => \(a\.at \|\| 0\) - \(b\.at \|\| 0\)\)/.test(feedBlock));
const compactCmd = ui.slice(ui.indexOf("cmd === '/compact'"), ui.indexOf("cmd === '/status'"));
t('/compact 不再 push status 事件（会和横幅重复，且被排到流的最底部）',
  !/cwPushEvent/.test(compactCmd), compactCmd.slice(-200));
t('/compact 自己调了 cwRender（去掉 push 就没人刷界面了——压缩生效但看不见）',
  /cwRender\(\)/.test(compactCmd));
t('/compact 自己调了 cwScheduleSave（同上，不存盘=重开就丢）',
  /cwScheduleSave\(\)/.test(compactCmd));
t('/compact 记下了压缩条数，横幅才有数可说', /compactedCount/.test(compactCmd));

console.log('[9] 桌面与安卓副本一致');
for (const f of ['js/41-code-workbench.js', 'css/grancyan.css', 'index.html']) {
  t('android 副本与 ' + f + ' 一致', read(f) === read('android/assets/' + f.replace(/^/, '')));
}

console.log(NL + (fail ? '❌ ' : '✅ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
