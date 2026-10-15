// 薄荷巧克力色温（用户发的图：#744444 可可棕 + #2ef0ff 薄荷青）
//
// 全是「零报错」的坑：专属类没挂上，界面就是一套普通配色、顶光和薄荷碎都没了；
// 切走时没摘，下一套配色底下还飘着巧克力的样式；新加一个「实心强调色 + 白字」的按钮，
// 在薄荷青上白字直接看不见 —— 都不会报错，只会长得不对。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const state = read('js/02-state.js');
const mainCss = read('css/grancyan.css');
const mintCss = read('css/mint-choc.css');

// 拆出 [选择器, 声明体]，@media / @supports 里的也算
function rules(css) {
  const out = [];
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
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
t('外观里能选薄荷巧克力', /data-theme-temperature="mintchoc"[^>]*onclick="setThemeTemperature\('mintchoc'\)"/.test(html));
const iB = html.indexOf('css/block-theme.css'), iM = html.indexOf('css/mint-choc.css');
t('mint-choc.css 排在 block-theme 之后', iB > 0 && iM > iB);

console.log('\n[配色]');
const pal = (state.match(/\n  mintchoc:\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
const keys = ['accent', 'bgBase', 'bgSurface', 'bgElevated', 'bgHover', 'textPrimary', 'textMuted', 'textDim', 'textSecondary', 'mask'];
t('字段齐全', keys.every(k => new RegExp(k + ":'").test(pal)));
t('强调色就是图里的薄荷青', /accent:'#2ef0ff'/.test(pal));
t('是深色（没标 light）', pal && !/light:/.test(pal));
t('带专属类 theme-mintchoc', /cls:'theme-mintchoc'/.test(pal));

console.log('\n[应用]');
const applyT = (state.match(/function applyThemeTemperature\(\) \{[\s\S]*?\n\}/) || [''])[0];
// 遍历全表按「是不是当前这套」挂/摘：切走时才会把巧克力的类摘掉
// 10-14 起 t 是 effectiveTheme() 拷出来的一份（叠了自己调的底色/字色），得跟预设表里那一项本身比，不然专属类永远挂不上
t('切色温时按 cls 挂/摘专属类（切走会摘）', /Object\.values\(THEME_TEMPERATURES\)\.forEach\(x => \{ if \(x\.cls\) root\.classList\.toggle\(x\.cls, x === preset\); \}\)/.test(applyT)
  && /const preset = THEME_TEMPERATURES\[name\]/.test(applyT));

console.log('\n[样式隔离]');
const stray = rules(mintCss).flatMap(([sel]) => parts(sel)).filter(p => !/^html\.theme-mintchoc\b/.test(p) && p !== '.swatch-mintchoc');
t('mint-choc.css 每条都挂在 html.theme-mintchoc 下（小样除外）', rules(mintCss).length > 10 && stray.length === 0);
stray.slice(0, 5).forEach(l => console.log('      漏网: ' + l.slice(0, 70)));
t('薄荷碎挂在 #bg-mask::before（::after 归色块形状）', /html\.theme-mintchoc #bg-mask::before/.test(mintCss) && !/theme-mintchoc #bg-mask::after/.test(mintCss));

console.log('\n[薄荷青上的字]');
// grancyan.css 里每个「实心强调色 + 白字」的规则，在薄荷巧克力下都得换成深色字
const covered = new Set(rules(mintCss).filter(([, b]) => /color:var\(--mc-ink\) !important/.test(b))
  .flatMap(([sel]) => parts(sel)).map(p => p.replace(/^html\.theme-mintchoc /, '')));
const whiteOnAccent = rules(mainCss)
  .filter(([, b]) => /background(-color)?\s*:\s*var\(--accent\)\s*(;|!|$)/.test(b) && /(^|;|\s)color\s*:\s*(#fff\b|#ffffff|white)/i.test(b))
  .flatMap(([sel]) => parts(sel));
// ui-polish 起新写法是 color:var(--on-accent)（applyAccentCSS 按亮度自动挑字色，薄荷青上就是黑巧色），
// 这种不用进表。总数门槛把两种加起来算 —— 各块把 #fff 换成 --on-accent 时，表变短不该让这条红
const onAccent = rules(mainCss)
  .filter(([, b]) => /background(-color)?\s*:\s*var\(--accent\)\s*(;|!|$)/.test(b) && /(^|;|\s)color\s*:\s*var\(--on-accent\)/.test(b))
  .flatMap(([sel]) => parts(sel));
const missing = whiteOnAccent.filter(p => !covered.has(p));
t('grancyan.css 里实心强调色 + 白字的按钮都换了深色字', whiteOnAccent.length + onAccent.length > 20 && missing.length === 0);
t('--on-accent 在薄荷巧克力下兜底成黑巧色', /html\.theme-mintchoc \{[^}]*--on-accent:var\(--mc-ink\)/.test(mintCss));
missing.forEach(p => console.log('      没换: ' + p + '  → 加进 css/mint-choc.css 最后那张表'));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
