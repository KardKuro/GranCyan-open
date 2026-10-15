// 背景 / 字色自己调（2026-10-14）：持久化几道关 + effectiveTheme 推出来的几级颜色真的对。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const state = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const look = read('js/09-appearance-input.js');

console.log('\n[持久化]');
for (const f of ['customBg', 'customText']) {
  t(f + ' 有 state 默认值', new RegExp(f + ":\\s*''").test(state));
  t(f + ' 写入 IndexedDB', state.includes(`idbSet('kuro_${f}'`));
  t(f + ' 从 IndexedDB 读回', core.includes(`${f}: `) && core.includes(`'kuro_${f}'`));
  t(f + ' 启动时落回 state', boot.includes(`state.${f}`) && boot.includes(`saved.${f}`));
  t(f + ' 进云同步 push', core.includes(`${f}: state.${f}`));
  // '' 是「跟预设」，用 || 合并的话另一台改回预设永远同步不过来
  t(f + ' 云端合并用 ?? 不用 ||', core.includes(`state.${f} = s.${f} ?? state.${f}`));
}

console.log('\n[界面]');
t('外观里有背景和文字两个取色器', /id="customBgColor"[^>]*setCustomTone\('bg'/.test(html) && /id="customTextColor"[^>]*setCustomTone\('text'/.test(html));
t('两个都有「跟色温」退回按钮', /data-tone-reset="customBgColor"/.test(html) && /data-tone-reset="customTextColor"/.test(html));
t('点色温预设会清掉自己调的底色和字色', /_setThemeTemperature[\s\S]{0,400}state\.customBg = ''; state\.customText = ''/.test(state));
t('遮罩和底衬判断读 effectiveTheme，不直接读预设表', !/THEME_TEMPERATURES\[state\.themeTemperature\]/.test(look) && (look.match(/effectiveTheme\(\)/g) || []).length >= 3);

console.log('\n[空页面大字透明度]');
const css = read('css/grancyan.css');
t('echoOpacity 默认 1、写盘、读回、启动落回、进云同步',
  /echoOpacity:\s*1\b/.test(state) && state.includes(`idbSet('kuro_echoOpacity'`) && core.includes(`'kuro_echoOpacity'`)
  && boot.includes('state.echoOpacity') && boot.includes('saved.echoOpacity')
  && core.includes('echoOpacity: state.echoOpacity') && core.includes('state.echoOpacity = s.echoOpacity ?? state.echoOpacity'));
t('启动和云端合并后都应用', /applyUiShape\(\);\s*applyEchoOpacity\(\)/.test(boot) && /applyUiShape\(\);\s*applyEchoOpacity\(\)/.test(core));
t('外观里有滑块', /id="echoOpacityRange"[^>]*setEchoOpacity\(this\.value\)/.test(html));
// 挂在字本身上会被入场动画 emptyEchoIn（opacity, fill both）盖掉，拖了没反应
t('透明度挂在 #emptyEchoLayer 这一层，不挂在 .empty-echo 上',
  /#emptyEchoLayer \{[^}]*opacity:var\(--echo-opacity,1\)/.test(css) && !/\.empty-echo \{[^}]*--echo-opacity/.test(css));
{
  const src = (state.match(/function _echoOpacityVal\(\) \{[\s\S]*?\n\}/) || [''])[0];
  const c2 = { state: {} }; vm.createContext(c2); vm.runInContext(src + '\nthis.f = _echoOpacityVal;', c2);
  const v = x => (c2.state.echoOpacity = x, c2.f());
  t('透明度夹在 0~1，坏值当 1', v(0.4) === 0.4 && v(-1) === 0 && v(3) === 1 && v(undefined) === 1 && v('abc') === 1 && v(0) === 0);
}

console.log('\n[推出来的颜色]');
const tablesrc = (state.match(/const THEME_TEMPERATURES = \{[\s\S]*?\n\};/) || [''])[0];
const fnsrc = (state.match(/function _isHex6[\s\S]*?(?=\/\/ which: )/) || [''])[0];
const ctx = { state: { themeTemperature: 'warm', customBg: '', customText: '' } };
vm.createContext(ctx);
vm.runInContext(tablesrc + '\n' + fnsrc + '\nthis.THEME_TEMPERATURES = THEME_TEMPERATURES; this.effectiveTheme = effectiveTheme; this._hexLum = _hexLum;', ctx);
const { THEME_TEMPERATURES: TT, effectiveTheme, _hexLum } = ctx;
const set = (temp, bg, fg) => { ctx.state.themeTemperature = temp; ctx.state.customBg = bg; ctx.state.customText = fg; return effectiveTheme(); };

let e = set('warm', '', '');
t('没调 = 原样是预设', ['bgBase','bgSurface','textPrimary','textMuted','mask','accent'].every(k => e[k] === TT.warm[k]));
t('effectiveTheme 不改预设表本身', (set('warm', '#102030', '#ffeeaa'), TT.warm.bgBase === '#0d0c0b' && TT.warm.textPrimary === '#eee8df'));

e = set('warm', '#102030', '');
t('深底：底色就是挑的那个，遮罩跟着换', e.bgBase === '#102030' && e.mask === '16,32,48');
t('深底：surface < elevated < hover 一级比一级亮', _hexLum(e.bgBase) < _hexLum(e.bgSurface) && _hexLum(e.bgSurface) < _hexLum(e.bgElevated) && _hexLum(e.bgElevated) < _hexLum(e.bgHover));
t('深底：还是深色，字照用预设', !e.light && e.textPrimary === TT.warm.textPrimary);

e = set('warm', '#f2efe8', '');
t('浅底挂在深预设上：标成浅色、借米纸的字', e.light === true && e.textPrimary === TT.paper.textPrimary && /17,17,17/.test(e.border || ''));
t('浅底：几级往暗走', _hexLum(e.bgHover) < _hexLum(e.bgBase));

e = set('paper', '#121212', '');
t('深底挂在米纸上：摘掉浅色边、借暖色的字', !e.light && !e.border && e.textPrimary === TT.warm.textPrimary);

e = set('warm', '', '#a0e8ff');
const L = c => _hexLum(c);
t('字色：primary 就是挑的那个', e.textPrimary === '#a0e8ff');
t('字色：secondary > dim > muted 一级比一级靠近底色', L(e.textPrimary) > L(e.textSecondary) && L(e.textSecondary) > L(e.textDim) && L(e.textDim) > L(e.textMuted) && L(e.textMuted) > L(e.bgBase));

e = set('warm', '#102030', '#ffffff');
t('两样都调：字往调过的底色退', e.textMuted === '#' + [0x10,0x20,0x30].map(v => Math.round(255 + (v - 255) * .42).toString(16).padStart(2, '0')).join(''));

e = set('warm', 'red', '#12');
t('不是 #rrggbb 的值当没调', e.bgBase === TT.warm.bgBase && e.textPrimary === TT.warm.textPrimary);

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
