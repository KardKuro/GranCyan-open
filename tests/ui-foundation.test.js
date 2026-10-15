// ui-polish / foundation（2026-10-13）：公共 token 和公共组件
//
// 守的都是「零报错、只会长得不对」的东西：
//   · :root 少了 --bg-rgb / --accent-rgb 默认值 → 一堆 rgba(var(--bg-rgb),.9) 整条声明作废，底色变透明
//   · --bg-main 又没定义 → 小组件全屏页落回 fallback 的中性灰 #111，不跟色温
//   · applyAccentCSS 不写 --accent-border / --accent-hover → 换了强调色，描边和悬停底还是金的
//   · --on-accent 挑错 → 薄荷青 / 荧光绿上的白字看不见，或者琥珀金上突然变黑字
//   · appPrompt 又写回内联颜色 → 米纸 / 薄荷巧克力下弹出一块写死的白字强调色按钮
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok, extra) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } }

const css = read('css/grancyan.css');
const state = read('js/02-state.js');
const blockCss = read('css/block-theme.css');

console.log('\n[:root token]');
const rootBlock = (css.match(/\n:root \{([\s\S]*?)\n\}/) || [, ''])[1];
const decl = name => (rootBlock.match(new RegExp('\\n\\s*' + name + ':\\s*([^;]+);')) || [, null])[1];
t('--bg-rgb 有默认值（暖色，和色温表 warm.mask 一致）', decl('--bg-rgb') && decl('--bg-rgb').replace(/\s/g, '') === '13,12,11');
t('--accent-rgb 有默认值（琥珀金）', decl('--accent-rgb') && decl('--accent-rgb').replace(/\s/g, '') === '200,149,85');
t('--on-accent 有默认值', !!decl('--on-accent'));
t('--bg-main 接到 --bg-base', decl('--bg-main') === 'var(--bg-base)');
['--glass-a', '--chrome-a', '--solid-a', '--text', '--bg-panel', '--bg-primary', '--bg-input', '--scrim', '--shadow-pop', '--shadow-panel', '--focus-ring-color', '--font-cjk-strong']
  .forEach(n => t(n + ' 有定义', !!decl(n)));
// 用户定的：英文数字的 Cormorant 斜体全保留。粗体中文的 token 也得先给 Cormorant 接住拉丁字母
t('--font 没被动（Cormorant 打头）', /\n\s*--font: 'Cormorant Garamond', SimSun/.test(rootBlock));
t('--font-cjk-strong 拉丁字母仍走 Cormorant', /^'Cormorant Garamond',/.test(decl('--font-cjk-strong') || ''));
t('没加改字形的 --font-ui / --font-num', !/--font-(ui|num)\s*:/.test(css));
const warmMask = (state.match(/\n  warm: \{[\s\S]*?mask:'([^']+)'/) || [, ''])[1];
t('色温表 warm.mask 和 :root --bg-rgb 对得上', warmMask === '13,12,11', warmMask);

console.log('\n[前 80 行里不再写死冷海军蓝 / 旧靛蓝]');
const head = css.slice(0, css.indexOf('/* ── 公共组件（ui-polish/foundation）── */'));
t('找得到公共组件区段', head.length > 0 && head.length < css.length);
t('没有 rgba(99,102,241…)', !/99,\s*102,\s*241/.test(head));
t('没有 rgba(9,9,15…) / #2a2a3d', !/rgba\(9,\s*9,\s*15/.test(head) && !/#2a2a3d/i.test(head));

console.log('\n[公共组件区段]');
const secStart = css.indexOf('/* ── 公共组件（ui-polish/foundation）── */');
const secEnd = css.indexOf('/* ── Sidebar ── */');
const sec = css.slice(secStart, secEnd);
t('区段夹在 :root 之后、侧栏之前', secStart > css.indexOf(':root {') && secEnd > secStart);
['.gc-close', '.gc-empty', '.gc-empty-icon', '.gc-empty-title', '.gc-empty-desc', '.gc-dialog-backdrop', '.gc-dialog', '.gc-dialog-msg', '.gc-dialog-input', '.gc-dialog-check', '.gc-dialog-actions', '.gc-btn', '.gc-btn.primary']
  .forEach(c => t(c + ' 有定义', new RegExp('(^|\\n)' + c.replace(/\./g, '\\.') + '\\s*[{,]').test(sec)));
t('统一 :focus-visible 用的是零特异性的 :where', /:where\([^)]*button[^)]*\):focus-visible\s*\{[^}]*var\(--focus-ring-color\)/.test(sec));
// mark-style.test 要全文第一个 reduced-motion 块紧挨着 .mark-text；这一段在它前面，一个字都不能写
t('区段里没写 prefers-reduced-motion（注释也不行）', !/prefers-reduced-motion/.test(sec));
const secNoComment = sec.replace(/\/\*[\s\S]*?\*\//g, '');
t('区段里不写死冷海军蓝 / 旧靛蓝 / 强调色上的白字', !/99,\s*102,\s*241|rgba\(\s*(9|10|13|18|22),\s*(9|10|13|18|22),\s*(15|18|22|28|34|35)/.test(secNoComment)
  && !/background:var\(--accent\)[^}]*color:#fff/.test(secNoComment));
t('强调色实心按钮的字走 --on-accent', /\.gc-btn\.primary \{[^}]*color:var\(--on-accent\)/.test(sec));

console.log('\n[applyAccentCSS]');
const applyA = (state.match(/function applyAccentCSS\(color\) \{[\s\S]*?\n\}/) || [''])[0];
['--accent-border', '--accent-hover', '--on-accent', '--accent-rgb'].forEach(v =>
  t('写 ' + v, new RegExp("setProperty\\('" + v + "'").test(applyA)));
t('回收站悬停底不再写死蓝黑', !/rgba\(22, 22, 34/.test(applyA));
t('回收站实心强调色按钮的字走 --on-accent', !/color: #fff !important/.test(applyA));

console.log('\n[--on-accent 按亮度挑]');
const fnSrc = (state.match(/function accentOnColor\(r, g, b\) \{[\s\S]*?\n\}/) || [''])[0];
t('有 accentOnColor', !!fnSrc);
let light = false;
const box = { document: { documentElement: { classList: { contains: c => c === 'theme-light' && light } } }, Math };
try { vm.runInNewContext(fnSrc + ';this.f=accentOnColor;', box); } catch (e) { console.log('   ' + e.message); }
const on = hex => box.f(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
// 每套色温自带的强调色：暗的照旧白字（和改之前一模一样），亮的换深字
const accents = Object.fromEntries([...state.matchAll(/\n  (\w+): \{\s*\n?\s*accent:'(#[0-9a-f]{6})'/gi)].map(m => [m[1], m[2]]));
t('色温表八套强调色都读到了', Object.keys(accents).length === 8, accents);
['warm', 'cool', 'ink', 'paper'].forEach(k => t(k + '（' + accents[k] + '）上是白字', box.f && on(accents[k]) === '#fff'));
['mintchoc', 'acid', 'graphite', 'dusk'].forEach(k => t(k + '（' + accents[k] + '）上换成底色深字', box.f && on(accents[k]) === 'var(--bg-base)'));
light = true;
t('米纸（浅底）上的亮强调色用墨黑，不用浅底色', box.f && on('#2ef0ff') === '#111111');

console.log('\n[appPrompt 走 .gc-dialog]');
const promptFn = (state.match(/function appPrompt\([\s\S]*?\n\}/) || [''])[0];
t('模板挂的是 gc-dialog 那套 class', /class="gc-dialog-backdrop" id="appPromptBackdrop"/.test(promptFn) && /class="gc-dialog"/.test(promptFn)
  && /id="appPromptInput" class="gc-dialog-input"/.test(promptFn) && /id="appPromptOk" class="gc-btn primary"/.test(promptFn));
const tpl = (promptFn.match(/innerHTML = `([\s\S]*?)`;/) || [, ''])[1];
t('模板里没有内联颜色', tpl.length > 0 && !/(background|color|border)\s*:/.test(tpl), tpl.match(/style="[^"]*"/g));
t('勾选行仍靠内联 display 开关（browser-sticker-off 读它）', /id="appPromptCheckRow"[^>]*style="display:none"/.test(tpl) && /checkRow\.style\.display = check \? 'flex' : 'none'/.test(promptFn));

console.log('\n[米纸下的 token 取值]');
t('block-theme 给浅色补了 --bg-input / --scrim / 阴影', /html\.theme-light \{[^}]*--bg-input:[^}]*--scrim:[^}]*--shadow-pop:/.test(blockCss));

console.log('\n[toast]');
const toastFn = (state.match(/function showToast\([\s\S]*?\n\}/) || [''])[0];
t("'warn' 归到 warning（css 只认 warning）", /if \(type === 'warn'\) type = 'warning'/.test(toastFn));
t('toast 不写内联颜色', !/style\.(background|color|border)/.test(toastFn));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
