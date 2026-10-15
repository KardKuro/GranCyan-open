// 墨块 / 米纸色温 + 色块形状（2026-10-09，参考用户发的 Haiku 5.5 宣传片）
//
// 这一套全是「零报错」的坑：规则少挂一个根选择器就会连别的主题一起污染；
// 浅色标记没挂上，米纸就是一屏黑字压黑底；色块被算进切角的形状里，
// 直角块会被 augmented-ui 裁成切角 —— 都不会报错，只会长得不对。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const state = read('js/02-state.js');
const appear = read('js/09-appearance-input.js');
const blockCss = read('css/block-theme.css');
const patchCss = read('css/light-patch.css');

// 把 css 拆成「选择器 → 是否在 @font-face 里」，只看顶层和 @media 里的普通规则
function selectors(css) {
  const out = [];
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const head = s.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
    if (/^@media|^@supports/.test(head)) out.push(...selectors(s.slice(open + 1, j - 1)));
    else if (!head.startsWith('@')) out.push(head);
    i = j;
  }
  return out;
}
function topLevelParts(sel) {
  // 按顶层逗号切（:is(...) 里的逗号不算）
  const parts = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

console.log('\n[入口]');
t('外观里能选墨块、米纸两个色温', /data-theme-temperature="ink"/.test(html) && /data-theme-temperature="paper"/.test(html));
t('外观里能选色块形状', /data-ui-shape="block"[^>]*onclick="setUiShape\('block'\)"/.test(html));
const iG = html.indexOf('css/grancyan.css'), iP = html.indexOf('css/light-patch.css'), iB = html.indexOf('css/block-theme.css');
t('样式表顺序：grancyan → light-patch → block-theme（手写的要压过生成的）', iG > 0 && iP > iG && iB > iP);

console.log('\n[配色]');
const pal = name => (state.match(new RegExp('\\n  ' + name + ':\\s*\\{([\\s\\S]*?)\\n  \\}')) || [, ''])[1];
const keys = ['accent', 'bgBase', 'bgSurface', 'bgElevated', 'bgHover', 'textPrimary', 'textMuted', 'textDim', 'textSecondary', 'mask'];
t('墨块配色字段齐全', keys.every(k => new RegExp(k + ":'").test(pal('ink'))));
t('米纸配色字段齐全，且标了 light、带浅色边框', keys.every(k => new RegExp(k + ":'").test(pal('paper'))) && /light:true/.test(pal('paper')) && /border:'rgba\(17,17,17/.test(pal('paper')));
t('米纸是真的浅底（底色亮、字是墨色）', /bgBase:'#efece5'/.test(pal('paper')) && /textPrimary:'#111111'/.test(pal('paper')));
t('墨块不是浅色（没标 light）', !/light:/.test(pal('ink')));

console.log('\n[应用]');
const applyT = (state.match(/function applyThemeTemperature\(\) \{[\s\S]*?\n\}/) || [''])[0];
t('切色温时按 light 挂/摘 theme-light', /classList\.toggle\('theme-light', !!t\.light\)/.test(applyT));
t('没写边框的配色把 --border 摘回默认（切回深色不留浅色边）', /removeProperty\('--border'\)/.test(applyT) && /removeProperty\('--border-mid'\)/.test(applyT));
t('切色温时写 --bg-rgb（输入栏渐变靠它）', /setProperty\('--bg-rgb', t\.mask\)/.test(applyT));
t('色块在 UI_SHAPES 里', /block:\s*\{ label: '色块' \}/.test(state));
t('applyUiShape 挂/摘 ui-block', /classList\.toggle\('ui-block', name === 'block'\)/.test(state));
const sync = (state.match(/function syncAugShapeAttrs\(root\) \{[\s\S]*?\n\}/) || [''])[0];
t('色块不挂 augmented-ui（只有工业和酸性切角）', /const on = state\.uiShape === 'industrial' \|\| state\.uiShape === 'acid'/.test(sync));
t('浅色底下不给亮壁纸套深色壳', /documentElement\?\.classList\.contains\('theme-light'\)\) return set\(false\)/.test(appear)
  && appear.indexOf("contains('theme-light')") < appear.indexOf("if (mode === 'on')  return set(true)"));

console.log('\n[样式隔离]');
// 每条规则都必须挂在 html.ui-block / html.theme-light 下；例外只有三个外观小样（只是色块，放哪都无害）
const SAMPLE = /^\.(swatch-ink|swatch-paper|shape-block)$/;
const stray = [];
for (const sel of selectors(blockCss)) for (const p of topLevelParts(sel)) {
  if (!/^html\.(ui-block|theme-light)\b/.test(p) && !SAMPLE.test(p)) stray.push(p);
}
t('block-theme.css 挑不出漏挂根选择器的规则', selectors(blockCss).length > 50 && stray.length === 0);
stray.slice(0, 5).forEach(l => console.log('      漏网: ' + l.slice(0, 70)));
const patchStray = selectors(patchCss).flatMap(topLevelParts).filter(p => !/^html\.theme-light\b/.test(p));
t('light-patch.css 每条都挂在 html.theme-light 下', selectors(patchCss).length > 100 && patchStray.length === 0);
patchStray.slice(0, 5).forEach(l => console.log('      漏网: ' + l.slice(0, 70)));
t('light-patch.css 没翻其它配色的小样', !/swatch-(cool|warm|acid)|shape-acid/.test(patchCss));

console.log('\n[字体]');
const fonts = [...blockCss.matchAll(/url\(\.\/fonts\/([^)]+)\)/g)].map(m => m[1]);
t('两个字体都走本地文件且文件真在', fonts.length === 2 && fonts.every(f => fs.existsSync(path.join(root, 'css', 'fonts', f)) && fs.statSync(path.join(root, 'css', 'fonts', f)).size > 10000));
t('没往 CDN 拉字体', !/fonts\.(googleapis|gstatic)\.com/.test(blockCss));

console.log('\n[色块的几手]');
t('她的气泡是实心强调色、盖掉渲染时写的内联光晕', /html\.ui-block \.bubble\.user \{[^}]*background:var\(--accent\) !important[^}]*box-shadow:none !important/.test(blockCss));
t('当前对话整块强调色（盖过动态强调色的 !important）', /html\.ui-block \.chat-item\.active \{ background:var\(--accent\) !important/.test(blockCss));
t('logo 的内联 display 被 !important 盖掉', /html\.ui-block \.sidebar-top > img \{ display:none !important; \}/.test(blockCss));
t('通用直角排除了该圆的东西（头像/圆点/唱片/环）', /:not\(\[class\*="avatar"\]\):not\(\[class\*="dot"\]\):not\(\[class\*="disc"\]\):not\(\[class\*="ring"\]\)/.test(blockCss));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
