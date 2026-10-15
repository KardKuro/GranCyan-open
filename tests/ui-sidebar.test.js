// ui-polish / sidebar（2026-10-14）：侧栏顶部按钮、对话条目操作、批量托盘、工具菜单
//
// 守的都是「零报错、只会长得不对 / 点错」的东西：
//   · 条目操作按钮又回到文档流里 → 标题重新被挤成五六个字（A04）
//   · 藏着的操作按钮没 pointer-events:none → 它盖在相对时间上，点「3小时前」点中的是看不见的删除键
//   · 手机大块里又写回 .chat-item-actions{opacity:1!important} → 每行常驻一串按钮
//   · 长按亮按钮后没吃掉补发的 click → 刚亮出来就切走对话、侧栏关掉
//   · 单词卡入口又挂回强调色底，看着像「当前选中」（A25，用户拍板）
//   · 批量删对话的托盘没了 nowrap / 侧栏定位 → 手机上「取/消」「删/除」竖排（A12）
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function t(name, ok, extra) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } }

const css = read('css/grancyan.css');
const html = read('index.html');
const js = read('js/03-chats-models.js');

// 侧栏区段：从「/* ── Sidebar ── */」到 hub 的 .widgets-grid
const sbFrom = css.indexOf('/* ── Sidebar ── */');
const sbTo = css.indexOf('.widgets-grid {', sbFrom);
const sb = css.slice(sbFrom, sbTo);
// 取「整条规则」：选择器开头、到第一个 } 为止（只认第一次出现）
const rule = (src, sel) => { const i = src.indexOf('\n' + sel + ' {'); return i < 0 ? '' : src.slice(i, src.indexOf('}', i) + 1); };

console.log('\n[A01 侧栏区段不再写死冷海军蓝 / 旧靛蓝]');
t('切得出侧栏区段', sbFrom > 0 && sbTo > sbFrom);
t('没有 rgba(99,102,241…)', !/99,\s*102,\s*241/.test(sb));
t('没有 rgba(10,10,18…) / rgba(13,13,22…)', !/rgba\((10,\s*10,\s*18|13,\s*13,\s*22)/.test(sb));
t('#sidebar 走 --bg-rgb + --chrome-a', /background:\s*rgba\(var\(--bg-rgb\),var\(--chrome-a\)\)/.test(rule(sb, '#sidebar')));
t('#footerMenu 走 --solid-a', /rgba\(var\(--bg-rgb\),var\(--solid-a\)\)/.test(rule(sb, '#footerMenu')));
t('手机遮罩走 --scrim', /#mobile-overlay \{[^}]*background:var\(--scrim\)/.test(css));

console.log('\n[A04 对话条目：操作按钮浮在行上，不占标题宽度]');
const acts = rule(sb, '.chat-item-actions');
t('.chat-item 是定位容器', /position:relative/.test(rule(sb, '.chat-item')));
t('.chat-item-actions 绝对定位', /position:absolute/.test(acts), acts);
t('❗藏着时 opacity:0 且 pointer-events:none（不然盖在相对时间上能被点中）', /opacity:0/.test(acts) && /pointer-events:none/.test(acts), acts);
t('hover 只在有 hover 的设备上生效（手机点过不赖着）', /@media \(hover:hover\) \{ \.chat-item:hover \.chat-item-actions \{ opacity:1;pointer-events:auto; \} \}/.test(sb));
t('键盘焦点能亮出按钮', /\.chat-item:is\(:focus-visible, :has\(:focus-visible\)\) \.chat-item-actions/.test(sb));
t('长按出来的 .acts-open 能亮出按钮', /\.chat-item\.acts-open \.chat-item-actions \{ opacity:1;pointer-events:auto; \}/.test(sb));
const bigMobile = css.slice(css.indexOf('MOBILE RESPONSIVE'), css.indexOf('/* ── Settings Modal ── */'));
t('❗手机大块里不再每行常驻（没有 .chat-item-actions { opacity: 1 !important }）', !/\.chat-item-actions \{ opacity: 1 !important/.test(bigMobile));
t('手机上当前这条常亮', /\.chat-item\.active \.chat-item-actions \{ opacity:1;pointer-events:auto; \}/.test(sb));
t('元信息数字齐线等宽（不动斜体）', /font-variant-numeric:lining-nums tabular-nums/.test(rule(sb, '.chat-item-meta')) && !/font-style/.test(rule(sb, '.chat-item-meta')));
t('条目里不再有 emoji 按钮', !/[📌📍🗑🖼👥]/u.test(js.slice(js.indexOf('function renderChatList'), js.indexOf('// 群聊头像设置'))));
t('删除键不再常驻红色内联样式', !/deleteChat\(\$\{c\.id\},event\)" title="删除" style=/.test(js));
t('条目可 Tab 到（tabindex + role=button）', /data-cid="\$\{c\.id\}" tabindex="0" role="button"/.test(js));
t('回车只认落在条目本身（里面的按钮自己处理）', /event\.target===this&&\(event\.key==='Enter'/.test(js));

console.log('\n[手机长按]');
const lp = js.slice(js.indexOf('const SB_PRESS_MS'), js.indexOf('// 群聊头像设置'));
t('有长按计时', /SB_PRESS_MS\s*=\s*\d+/.test(lp) && /setTimeout\(/.test(lp));
t('手指挪动 >10px 取消（滚列表不算长按）', /> 10/.test(lp) && /touchmove/.test(lp));
t('❗吃掉长按后补发的 click：document capture 阶段', /addEventListener\('click', e => \{[\s\S]*?_sbEatClickUntil[\s\S]*?stopPropagation\(\);\s*\}, true\);/.test(lp));
t('多选模式下长按不亮按钮', /state\.chatSelectMode/.test(lp));
t('contextmenu 只在非精确指针上拦（桌面留给 Ctrl 多选提示）', /contextmenu[\s\S]*?\(pointer:fine\)[\s\S]*?return;[\s\S]*?preventDefault\(\)/.test(lp));
t('手机上长按不选中标题文字', /\.chat-item \{ -webkit-touch-callout:none;-webkit-user-select:none;user-select:none; \}/.test(sb));

console.log('\n[A25 顶部按钮：新建对话是主按钮，群聊 / 单词卡一排小按钮]');
const top = html.slice(html.indexOf('<div class="sidebar-top">'), html.indexOf('<nav id="chatList">'));
t('只剩一颗 .new-chat-btn，就是新建对话', (top.match(/class="new-chat-btn/g) || []).length === 1 && /class="new-chat-btn sb-primary" onclick="createNewChat\(\)"/.test(top));
const quick = top.slice(top.indexOf('<div class="sidebar-quick">'), top.indexOf('<div class="search-wrap">'));
t('群聊、单词卡在同一排 .sidebar-quick 里', /onclick="createGroupChat\(\)"/.test(quick) && /id="studyEntryBtn"/.test(quick));
t('两颗小按钮都有 title 和 aria-label', (quick.match(/<button[^>]*title="[^"]+"[^>]*aria-label="[^"]+"/g) || []).length === 2);
t('onclick / id 没改', /id="studyEntryBtn" onclick="openStudy\(\);if\(isMobileLayout\(\)&&state\.sidebarOpen\)toggleSidebar\(\)"/.test(quick));
t('❗单词卡不再是强调色底', !/\.study-entry-btn[^{]*\{[^}]*accent/.test(sb));
// 用户：实心亮块里抠暗色符号太刺眼 → 加号和单词卡数字都改成描边 + 强调色字，不许再整块填 --accent
t('主按钮的加号是描边框 + 强调色线条，不是实心块', /\.new-chat-btn\.sb-primary \.icon \{ background:transparent;color:var\(--accent\);box-shadow:inset 0 0 0 [\d.]+px var\(--accent-border\)/.test(sb));
for (const sel of ['.study-entry-badge', '.study-head-badge']) {
  const r = rule(css, sel);
  t(`❗${sel} 不是实心强调色底`, !/background:var\(--accent\)/.test(r) && !/--on-accent/.test(r) && /color:var\(--accent\)/.test(r), r);
}
// 用户截图：全角「＋」在中文字体里笔画细、偏下，看着不顺眼 → 换成线条图标，描边要压得过 .sb-ic 默认的 1.8
const plusIc = (top.match(/<span class="icon">([\s\S]*?)<\/span>/) || [, ''])[1];
t('加号是线条 SVG（不是全角字符），横竖都过中心', !/＋/.test(plusIc) && /<svg class="sb-ic" viewBox="0 0 24 24"[^>]*><path d="M12 5v14M5 12h14"\/><\/svg>/.test(plusIc), plusIc);
t('加号描边比默认图标粗', +((css.match(/\.new-chat-btn \.icon \.sb-ic \{[^}]*stroke-width:([\d.]+)/) || [, 0])[1]) > 1.8);

console.log('\n[A12 批量删对话的托盘]');
const tray = rule(css, '#chatBatchTray');
t('一行排开不折字', /white-space:nowrap/.test(tray), tray);
t('钉在侧栏里：左对齐、宽度跟侧栏', /left:10px/.test(tray) && /width:calc\(var\(--sidebar-w\) - 20px\)/.test(tray) && /transform:none/.test(tray));
t('手机侧栏 280px 宽时另算宽度', /@media \(max-width: 768px\)[^{]*\{\s*#chatBatchTray \{ width:260px;/.test(css));
t('托盘出现时列表底部留出余量', /body:has\(#chatBatchTray:not\(\.hidden\)\) #chatList \{ padding-bottom:64px; \}/.test(sb));

console.log('\n[A26 工具菜单]');
const menu = html.slice(html.indexOf('<div id="footerMenu"'), html.indexOf('<div class="footer-user-row"'));
t('「同步对话」不再图标 + ☁ 两份', /同步对话/.test(menu) && !/☁/.test(menu));
t('底部用户行能用键盘打开', /class="footer-user-row"[^>]*tabindex="0" role="button"/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
