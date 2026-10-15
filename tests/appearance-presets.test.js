const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const state = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/grancyan.css');

console.log('\n[外观预设]');
t('外观里能选冷色和暖色', /data-theme-temperature="cool"/.test(html) && /data-theme-temperature="warm"/.test(html));
t('外观里有三套宋体', ['simsun','stsong','noto'].every(x => html.includes(`data-font-preset="${x}"`)));
t('英文数字先用历史版 Cormorant，中文再回退到宋体', /--font:\s*'Cormorant Garamond',\s*SimSun/.test(css));
t('三套中文字体预设都不会让宋体接管英文数字', Object.values((() => {
  const m = state.match(/const FONT_PRESETS = \{([\s\S]*?)\n\};/);
  return m ? { block: m[1] } : {};
})()).every(block => (block.match(/'Cormorant Garamond'/g) || []).length === 3));
t('冷暖配色都定义完整', /cool:\s*\{[\s\S]*bgBase:'#09090f'/.test(state) && /warm:\s*\{[\s\S]*bgBase:'#0d0c0b'/.test(state));
t('切色温会同步对应强调色', /state\.accentColor\s*=\s*THEME_TEMPERATURES\[name\]\.accent/.test(state));
t('字体和色温都有应用函数', /function applyThemeTemperature\(/.test(state) && /function applyFontPreset\(/.test(state));

console.log('\n[持久化四道关]');
for (const field of ['themeTemperature','fontPreset','uiShape']) {
  t(field + ' 有 state 默认值', new RegExp(field + ":\\s*'").test(state));
  t(field + ' 写入 IndexedDB', state.includes(`state.${field}`) && state.includes(`kuro_${field}`));
  t(field + ' 进入云同步 push/merge', core.includes(`${field}: state.${field}`) && core.includes(`state.${field} = s.${field}`));
  t(field + ' 启动时落回 state', boot.includes(`state.${field}`) && boot.includes(`saved.${field}`));
}
t('云端设置合并后立即应用两种预设', /applyThemeTemperature\(\);\s*applyFontPreset\(\);\s*applyAccentCSS/.test(core));
t('云端设置合并后也应用界面形状', /applyAccentCSS\(state\.accentColor\);\s*applyUiShape\(\)/.test(core));

console.log('\n[界面形状]');
t('外观里能选柔和和工业', /data-ui-shape="soft"/.test(html) && /data-ui-shape="industrial"/.test(html));
t('形状有应用函数', /function applyUiShape\(/.test(state));
t('augmented-ui 排在 grancyan.css 之前（它要求先于其它样式表）',
  html.includes('css/augmented-ui.css') && html.indexOf('css/augmented-ui.css') < html.indexOf('css/grancyan.css'));
// 关掉时必须把属性摘掉，不能只拿 CSS 盖住 —— 盖不干净的话 clip-path 仍在算，
// 柔和模式下的 box-shadow 会被裁掉，而这种缺陷肉眼极难定位。
t('关掉工业风是摘属性，不是拿 CSS 盖住', /removeAttribute\('data-augmented-ui'\)/.test(state));

// 反过来验：工业风那一段里，任何一条规则只要没挂在 html.ui-industrial 底下，
// 就会连柔和模式一起切角。所以不去枚举"应该有哪些规则"，而是断言这一段里
// 挑不出反例。段内如果哪天有意要写全局规则，把它挪到这段外面去。
// 段落边界一律截到"下一个 /* ── 标题"为止。写死成某个具体的下一段（曾经写的是
// 「终端小组件」）的话，中间一插新段落，截取范围就悄悄变大，把邻段的规则算成漏网。
function styleBlock(title) {
  return (css.match(new RegExp('── 界面形状：' + title + '[\\s\\S]*?(?=\\/\\* ── )')) || [''])[0];
}
function strayRules(block, prefix) {
  return block.split('\n')
    .filter(l => l.includes('{') && !/^\s*(\/\*|\*)/.test(l))
    .filter(l => !new RegExp('^' + prefix + '\\b').test(l.trim()));
}
const indBlock = styleBlock('工业');
const stray = strayRules(indBlock, 'html\\.ui-industrial');
t('工业风那段挑不出漏掉 html.ui-industrial 的规则', indBlock.length > 0 && stray.length === 0);
if (stray.length) stray.forEach(l => console.log('      漏网: ' + l.trim().slice(0, 70)));

console.log('\n[酸性风格]');
t('外观里能选酸性色温和酸性形状', /data-theme-temperature="acid"/.test(html) && /data-ui-shape="acid"/.test(html));
t('酸性配色定义完整（底色是真正的纯黑）', /acid:\s*\{[\s\S]*?bgBase:'#000000'[\s\S]*?accent:'#c8ff00'|acid:\s*\{[\s\S]*?accent:'#c8ff00'[\s\S]*?bgBase:'#000000'/.test(state));
// 2026-10-09 加了色块（直角，也不切角），判断从「不是柔和」改成点名工业和酸性
t('酸性也算进"要切角"的形状里', /const on = state\.uiShape === 'industrial' \|\| state\.uiShape === 'acid'/.test(state));
t('三档形状都在 UI_SHAPES 里', /soft:[\s\S]*?industrial:[\s\S]*?acid:/.test(state));
const acidBlock = styleBlock('酸性');
const acidStray = strayRules(acidBlock, 'html\\.ui-acid');
t('酸性那段挑不出漏掉 html.ui-acid 的规则', acidBlock.length > 0 && acidStray.length === 0);
if (acidStray.length) acidStray.forEach(l => console.log('      漏网: ' + l.trim().slice(0, 70)));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
