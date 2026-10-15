// ui-polish/composer（2026-10-14）：输入区打磨的几处结构，守住别被改回去
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok, info) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); } }

const html = read('index.html');
const css = read('css/grancyan.css');
const inp = read('js/09-appearance-input.js');
const conv = read('js/03-chats-models.js');
// 只认顶格写的那条（大手机 @media 里缩进的同名规则不算）
const rule = sel => { const i = css.indexOf('\n' + sel + ' {'); if (i < 0) return ''; return css.slice(i, css.indexOf('}', i)); };
const fnBody = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}', i)); };

console.log('\n[A07 内心想法：常驻，空着时只占一行]');
const ph = (html.match(/id="userThinkingInput"[^>]*placeholder="([^"]*)"/) || [])[1] || '';
t('占位文字短（≤ 16 字，412 宽的手机放得下）', ph.length > 0 && ph.length <= 16, ph);
t('空框的占位文字不折行', /#userThinkingInput:placeholder-shown\s*\{[^}]*white-space:nowrap/.test(css));
t('没有默认收起（用户定的常驻）', !/id="userThinkingInput"[^>]*hidden/.test(html) && !/#userThinkingInput\s*\{[^}]*display:none/.test(css));

console.log('\n[A08 电脑端面板挂在输入栏上沿]');
t('.input-bar 自己是定位框（色块 / 巧克力主题关了滤镜也不漂）', /position:relative/.test(rule('.input-bar')));
t('加号面板从输入栏上沿往上长', /bottom:calc\(100% \+ 8px\)/.test(rule('.plus-menu')), rule('.plus-menu').slice(0, 120));
t('加号 wrap 不再自己当定位框', /\.plus-menu-wrap \{ position:static/.test(css));
t('表情 / 公式 wrap 钉在输入栏右上角', /\.sticker-picker-wrap, \.math-picker-wrap \{ position:absolute !important;top:0;bottom:auto;right:0/.test(css));
t('加号面板图标没有彩色 emoji 了', !/plus-menu-icon">[^<]/.test(html));

console.log('\n[A14 对话设置条]');
t('电脑端折行', /flex-wrap:wrap/.test(rule('#convSettingsBar')));
t('下拉走 .conv-select，不再内联 padding', /class="conv-limit-input conv-select"/.test(conv) && !/padding:2px 4px/.test(conv));
// 用户：模型只在顶栏胶囊里选，设置条里不再铺一排模型按钮
const bar = fnBody(conv, 'renderConvSettingsBar');
t('设置条里没有模型按钮了', bar && !/toggleChatModel|toggleChatModelGroup|modelSelectAllClick|本次使用模型/.test(bar), bar.slice(0, 80));
t('胶囊里还能选（全选 / 分组 / 逐个都在）', /onclick="modelSelectAllClick\(\)"/.test(conv) && /toggleChatModelGroup\(this\.dataset\.g\)/.test(conv) && /onclick="toggleChatModel\(\$\{c\.id\}\)"/.test(conv));
t('底边有拖高度的把手，紧跟在设置条后面', /<div id="convSettingsBar" class="hidden"><\/div>\s*<div id="convSettingsGrip" class="conv-grip"[^>]*onpointerdown="convGripDown\(event\)"/.test(html));
t('把手拖的是 max-height（内容不够高就停在内容高）', /bar\.style\.maxHeight = h \+ 'px'/.test(fnBody(conv, 'convGripDown')));
t('面板关着时把手也藏', /#convSettingsBar\.hidden \+ \.conv-grip \{ display:none; \}/.test(css));
t('手机上把手藏（那边是一行横滑）', /#convSettingsBar::-webkit-scrollbar \{ display:none; \}\s*\.conv-grip \{ display:none; \}/.test(css));

console.log('\n[A23 全屏输入的收起键是图标]');
const tog = fnBody(inp, 'toggleInputExpand');
t('toggleInputExpand 不再往按钮里写字', tog && !/btn\.textContent/.test(tog), tog.slice(0, 80));
t('按钮里有展开 / 收起两枚 SVG', /id="expandInputBtn"[\s\S]{0,400}class="ico-expand"[\s\S]{0,600}class="ico-collapse"/.test(html));

console.log('\n[A24 附件托盘]');
t('引用 / 图片 / 文件 / 改消息横条都在 .composer-tray 里',
  /class="composer-tray">[\s\S]*id="editModeBar"[\s\S]*id="quotePrevBar"[\s\S]*id="imgPendingWrap"[\s\S]*id="filePendingWrap"[\s\S]*?<\/div>\s*<div id="chatEndedBanner"/.test(html));
t('托盘只在有东西时画底（:has）', /\.composer-tray:has\(> :not\(\[style\*="none"\]\)\)/.test(css));
const rq = fnBody(inp, 'renderQuoteBar');
t('引用条不再拼内联样式', rq && !/style="/.test(rq), rq.slice(0, 80));

console.log('\n[A01 地盘里的写死色]');
t('输入栏底托跟色温走（不再 9,9,15）', !/--ib-rgb,9,9,15/.test(css) && /--ib-rgb:var\(--bg-rgb\)/.test(css));
t('.input-bar 不再写死海军蓝', !/rgba\(18,18,28/.test(rule('.input-bar')));
t('强调色实底上的字用 --on-accent', /\.expand-send-btn \{[^}]*color:var\(--on-accent\)/.test(css) && /\.input-bar\.has-content \.plus-btn \{[^}]*color:var\(--on-accent\)/.test(css));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
