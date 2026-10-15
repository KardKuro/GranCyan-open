// 「巧克力」界面形状（用户：「巧克力可以专门做一种界面形状」）
//
// 全是「零报错」的坑：类没挂上，选了巧克力界面纹丝不动；漏挂 html.ui-choco 的规则，
// 柔和形状下的气泡也会被咬一口；她的气泡底色被 applyAccentCSS 的 !important 压住、
// 内联光晕没盖掉 —— 都不会报错，只会长得不对。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const state = read('js/02-state.js');
const css = read('css/choco-shape.css');

// 拆出 [选择器, 声明体]，@media / @supports 里的也算
function rules(src) {
  const out = [];
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const head = s.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
    const body = s.slice(open + 1, j - 1);
    if (/^@media|^@supports/.test(head)) out.push(...rules(body));
    else if (!head.startsWith('@')) out.push([head, body]);
    i = j;
  }
  return out;
}
const parts = sel => sel.split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);

console.log('\n[入口]');
t('外观里能选巧克力形状', /data-ui-shape="choco"[^>]*onclick="setUiShape\('choco'\)"/.test(html));
const iM = html.indexOf('css/mint-choc.css'), iC = html.indexOf('css/choco-shape.css');
t('choco-shape.css 排在 mint-choc.css 之后（同一个部件两边都写了，形状要赢）', iM > 0 && iC > iM);

console.log('\n[应用]');
t('巧克力在 UI_SHAPES 里', /choco:\s*\{ label: '巧克力' \}/.test(state));
t('applyUiShape 挂/摘 ui-choco', /classList\.toggle\('ui-choco', name === 'choco'\)/.test(state));
// 巧克力要的是圆角，挂上 augmented-ui 会被切角
t('巧克力不切角（不在 augmented-ui 的开关里）', /const on = state\.uiShape === 'industrial' \|\| state\.uiShape === 'acid';/.test(state));

console.log('\n[样式隔离]');
const stray = rules(css).flatMap(([sel]) => parts(sel)).filter(p => !/^html\.ui-choco\b/.test(p) && p !== '.shape-choco');
t('choco-shape.css 每条都挂在 html.ui-choco 下（小样除外）', rules(css).length > 10 && stray.length === 0);
stray.slice(0, 5).forEach(l => console.log('      漏网: ' + l.slice(0, 70)));

console.log('\n[消息]');
// 单栏模式那条选择器带 #chatWindow，不跟着写一遍的话 AI 的话在单栏下一格巧克力都没有（2026-10-10 截图栽过）
t('单栏模式下 AI 的话也是巧克力板', rules(css).some(([sel, b]) => parts(sel).includes('html.ui-choco #chatWindow.gc-mode-solo .msg-group.ai .bubble.ai:not(.bubble-sticker)') && /var\(--ck-grid\)/.test(b)));

console.log('\n[她的气泡]');
const userRule = (rules(css).find(([sel]) => parts(sel).includes('html.ui-choco .bubble.user:not(.bubble-sticker)')) || [, ''])[1];
t('底色 !important（盖 applyAccentCSS 写的 !important）', /background:[^;]*!important/.test(userRule));
t('阴影 !important（盖渲染时写的内联光晕）', /box-shadow:[^;]*!important/.test(userRule));
t('被咬一口：带前缀和标准两套 mask 合成', /-webkit-mask-composite:source-in/.test(userRule) && /mask-composite:intersect/.test(userRule));
const bareBubble = rules(css).filter(([, b]) => /ck-grid|mask/.test(b)).flatMap(([sel]) => parts(sel))
  .filter(p => /\.bubble\.(user|ai)/.test(p) && !/:not\(\.bubble-sticker\)/.test(p));
t('表情包气泡不切块不咬（格子和牙印都带 :not(.bubble-sticker)）', bareBubble.length === 0);
bareBubble.forEach(p => console.log('      会咬到表情包: ' + p));

console.log('\n[更多地方（2026-10-11）]');
const has = (sel, re) => rules(css).some(([s, b]) => parts(s).includes(sel) && re.test(b));
// 空页面那板巧克力是伪元素画的，同心圆不藏掉的话两样叠在猫背后
t('空页面：同心圆藏掉，换成一板被咬过的巧克力', has('html.ui-choco .empty-state > svg', /display:none/) &&
  has('html.ui-choco .empty-state::before', /content:""/) && has('html.ui-choco .empty-state::before', /mask-composite:intersect/));
// 点是文字「.」，字号不归零的话豆子旁边还挂着三个句点
t('思考中的三个点是巧克力豆（字藏掉、转 45° 尖朝上）', has('html.ui-choco .thinking-dots span', /font-size:0/) && has('html.ui-choco .thinking-dots span', /rotate\(45deg\)/));
// .hub-shell 底色是写死的深蓝黑，不换的话一盒巧克力装在蓝盒子里
t('万事屋外壳换成配色的底色，小组件是一颗颗巧克力', has('html.ui-choco .hub-shell', /background:var\(--bg-surface\)/) &&
  has('html.ui-choco .hub-widgets-grid .widget-item', /var\(--ck-grid\)/));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
