// ui-polish / hub（2026-10-14）：大集合外壳、小组件网格、功能指南
//
// 守的都是「零报错、只会长得不对」的东西：
//   · hub 外壳又写回冷海军蓝 rgba(13,13,22,…) → 暖色主题下外框一圈蓝黑（A01）
//   · 手机二级页又露出面板自己的大标题 → 两层标题叠着，正文被压到 330px 以下（A17）
//   · 小组件网格退回固定 3 栏 → 「公式卡」「点歌」各自单独占一行，右边空两格（A22）
//   · 梦境 / 左下角「关闭」的 ✕ 退回各画各的 <svg>（A16）
//   · 小组件卡片和指南目录是 div，没有 tabindex 就 Tab 不到（A34）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok, extra) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } }

const css = read('css/grancyan.css');
const html = read('index.html');
const hubJs = read('js/14-boot-brain-hub.js');
const helpJs = read('js/13-trash-ctx-ui.js');

// hub 的三段地盘：小组件网格、帮助/鸣谢、hub 外壳（按区段注释切，不按行号）
const seg = (a, b) => { const i = css.indexOf(a), j = css.indexOf(b, i + 1); return i >= 0 && j > i ? css.slice(i, j) : ''; };
const grid = seg('.widgets-grid { display:grid', '/* 外观：冷暖色温与宋体预设 */');
const help = seg('/* ── Help Modal ── */', '/* ── Hub「大集合」全屏容器');
const shell = seg('/* ── Hub「大集合」全屏容器', '.img-pending-wrap {');
t('三段地盘都切得到', grid.length > 500 && help.length > 2000 && shell.length > 2000, [grid.length, help.length, shell.length]);

console.log('\n[A01 写死的冷海军蓝 / 旧靛蓝]');
const mine = grid + help + shell;
t('地盘里没有旧靛蓝（含 fallback 写法）', !/99,\s*102,\s*241/.test(mine));
t('地盘里没有冷海军蓝底', !/rgba\(\s*(9|10|11|12|13|14|16|18|20|22|25),\s*(9|10|11|12|13|14|16|18|20|22|25),\s*(15|18|19|20|22|24|26|28|32|35|36)\s*,/.test(mine));
t('地盘里没有写死的琥珀金（换色温后还是金的）', !/200,\s*149,\s*85/.test(grid.replace(/\[data-widget-featured="ember"\][^}]*\}/, '')));
t('.hub-shell 底色走 --bg-rgb', /\.hub-shell \{[^}]*background:rgba\(var\(--bg-rgb\),var\(--chrome-a\)\)/.test(shell));
t('强调色实心底上的字走 --on-accent', !/background:var\(--accent\)[^}]*color:#fff/.test(mine));
t('文件查看器的下载钮描边不再是靛蓝', /onclick="downloadViewedFile\(\)"\s*style="[^"]*border:1px solid var\(--accent-border\)/.test(html));

console.log('\n[A17 手机二级页只留一层标题]');
const mob = (shell.match(/@media \(max-width:768px\)[\s\S]*$/) || [''])[0];
t('抠得到 hub 的手机 @media', mob.length > 1000);
t('设置 / 鸣谢的面板标题在 hub 手机二级页藏掉',
  /\.in-hub > \.settings-header,\s*\.hub-shell \.in-hub > \.credits-header \{ display:none; \}/.test(mob));
// 选择器列表里只要有一个不认识（老 WebView 不认 :has），整条规则作废——所以 :has 不能跟它们写在一条里
t('带 :has 的规则单独成条，不连坐设置 / 鸣谢', !/,\s*[^{},]*:has\([^{]*\{/.test(mob) && !/:has\([^{]*,\s*[^{]*\{/.test(mob));
t('记忆 / 收藏的标题藏掉，手环那条（带刷新和 ✕）只藏 h3',
  /\.memory-header:not\(:has\(\.hub-x\)\) \{ display:none; \}/.test(mob) && /\.memory-header:has\(\.hub-x\) > h3 \{ display:none; \}/.test(mob));
t('指南只藏标题，搜索框留着', /\.help-topbar > h2 \{ display:none; \}/.test(mob));
t('这些规则只在手机 @media 里（桌面不能藏）', !/\.in-hub > \.settings-header/.test(shell.replace(mob, '')));

console.log('\n[A22 小组件网格不留孤儿格]');
const wide = (grid.match(/@media\(min-width:701px\)\{([\s\S]*?)\n\}/) || [, ''])[1];
t('桌面 6 栏，普通卡占 2 栏', /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/.test(wide) && /> \.widget-item \{ grid-column:span 2; \}/.test(wide));
t('最后一行剩 2 张：各占一半', /:nth-child\(3n\+1 of :not\(\[data-widget-featured\]\)\):nth-last-child\(2\)[\s\S]*?\{ grid-column:span 3;/.test(wide));
t('最后一行剩 1 张：占满', /:nth-child\(3n\+1 of :not\(\[data-widget-featured\]\)\):last-child \{ grid-column:1 \/ -1;/.test(wide));
t('特色卡在 6 栏里也占 2 栏', /\.widget-item\[data-widget-featured\] \{[^}]*grid-column:span 2;/.test(grid));
t('手机两栏：单数时最后一张占满', /:nth-child\(odd of :not\(\[data-widget-featured\]\)\):last-child \{ grid-column:1 \/ -1;/.test(grid));
// 上面的计数只数非特色卡，前提是特色卡排在最前、而且正好凑满整行（3 张）。
// 哪天「此刻」加成 4 张特色卡，后面的普通卡就会错位留洞——拿真 HTML 数一遍
const shelves = html.slice(html.indexOf('<div id="widgetsHubHome"'), html.indexOf('<!-- ── 专注番茄钟')).split('<section class="widget-shelf');
const bad = [];
for (const s of shelves.slice(1)) {
  const items = [...s.matchAll(/<div class="widget-item"([^>]*)>/g)].map(m => /data-widget-featured/.test(m[1]));
  const nf = items.filter(Boolean).length, firstNormal = items.indexOf(false);
  if (nf % 3 || (nf && firstNormal >= 0 && firstNormal < nf)) bad.push(s.match(/<span>([^<]+)<\/span>/)?.[1]);
}
t('特色卡排在最前且凑满整行（按真 HTML 数的）', shelves.length > 5 && !bad.length, bad);

console.log('\n[A16 关闭键跟全站一个样]');
const dreams = html.slice(html.indexOf('<div id="dreamsHubHome"'), html.indexOf('<section class="dr" id="dreamRoom">'));
t('梦境的 ✕ 挂了 .gc-close，里面不再放 <svg>', /class="hub-x gc-close" onclick="hubCloseOrBack\(\)"/.test(dreams) && !/<svg/.test(dreams));
const hubClose = (html.match(/<button class="hub-close" onclick="closeHub\(\)">[\s\S]*?<\/button>/) || [''])[0];
t('左下角「关闭」里的 ✕ 换成 .gc-close，字留着', /<span class="gc-close sm" aria-hidden="true">/.test(hubClose) && /关闭/.test(hubClose) && !/<svg/.test(hubClose));
t('「关闭」里那颗 ✕ 颜色跟按钮走（色块主题反白时才看得见）', /\.hub-close \.gc-close,\s*\.hub-close \.gc-close:hover \{ color:inherit;/.test(shell));
t('.hub-x 悬停也亮描边（跟 .gc-close 一致）', /\.hub-x:hover \{[^}]*border-color:var\(--accent-border\)/.test(shell));

console.log('\n[A34 键盘走得到]');
t('指南目录项建出来就带 tabindex / role', /item\.tabIndex = 0; item\.setAttribute\('role', 'button'\)/.test(helpJs));
const a11yStart = hubJs.indexOf('// 键盘也能开小组件');
t('抠得到小组件键盘那段', a11yStart > 0);
{
  const listeners = {};
  const mkItem = (attrs = {}) => {
    const a = { ...attrs }, el = {
      clicks: 0, tabIndex: -1,
      hasAttribute: k => k in a, setAttribute: (k, v) => { a[k] = v; }, getAttribute: k => a[k] ?? null,
      click() { this.clicks++; },
      matches: sel => /\.widget-item\[role="button"\]/.test(sel) && a.role === 'button' && a.cls === 'widget-item',
    };
    Object.defineProperty(el, 'tabIndex', { get: () => a.tabindex ?? -1, set: v => { a.tabindex = v; } });
    return el;
  };
  const items = [mkItem({ cls: 'widget-item' }), mkItem({ cls: 'widget-item', tabindex: 3 })];
  const document = {
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    querySelectorAll: sel => sel === '#widgetsHubHome .widget-item' ? items : [],
  };
  try {
    vm.runInNewContext(hubJs.slice(a11yStart), { document });
    listeners.DOMContentLoaded.forEach(f => f());
    t('卡片补上 tabindex=0 和 role=button', items[0].tabIndex === 0 && items[0].getAttribute('role') === 'button');
    t('已经有 tabindex 的不覆盖', items[1].tabIndex === 3);
    let prevented = 0;
    const key = (k, target) => listeners.keydown.forEach(f => f({ key: k, target, preventDefault: () => prevented++ }));
    key('Enter', items[0]); key(' ', items[0]); key('a', items[0]);
    t('Enter / 空格 = 点一下，别的键不管', items[0].clicks === 2 && prevented === 2, [items[0].clicks, prevented]);
    key('Enter', { matches: () => false, click() { throw new Error('不该点'); } });
    t('不是卡片的元素不拦（输入框回车发送照常）', prevented === 2);
  } catch (e) { t('键盘那段在沙箱里跑得起来', false, String(e)); }
}

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
