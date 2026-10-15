// 暮紫色温（用户收藏夹 265 Écoute Chérie：紫纸颗粒 + 四角银色卷草 + 只亮一点金）
//
// 坑和石墨、薄荷巧克力一样都是「零报错」：专属类没挂上 / 切走没摘，纸和画框就没了或者飘到别的配色底下；
// 画框盖在字上面或者挡了点击，不会报错，只会点不动、看着脏。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n'); // 源码是 CRLF
let passed = 0, failed = 0;
function t(name, ok, detail) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); } }

const html = read('index.html');
const state = read('js/02-state.js');
const css = read('css/dusk.css');

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
t('外观里能选暮紫', /data-theme-temperature="dusk"[^>]*onclick="setThemeTemperature\('dusk'\)"/.test(html));
const iM = html.indexOf('css/mint-choc.css'), iD = html.indexOf('css/dusk.css'), iC = html.indexOf('css/choco-shape.css');
t('dusk.css 排在配色文件之后、形状文件之前（形状要赢）', iM > 0 && iD > iM && iC > iD);

console.log('\n[配色]');
const pal = (state.match(/\n  dusk:\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
const keys = ['accent', 'bgBase', 'bgSurface', 'bgElevated', 'bgHover', 'textPrimary', 'textMuted', 'textDim', 'textSecondary', 'mask'];
t('字段齐全', keys.every(k => new RegExp(k + ":'").test(pal)));
t('强调色是金', /accent:'#e2b04a'/.test(pal));
t('是深色（没标 light）', pal && !/light:/.test(pal));
t('带专属类 theme-dusk', /cls:'theme-dusk'/.test(pal));
const base = (pal.match(/bgBase:'#([0-9a-f]{6})'/i) || [, '000000'])[1].match(/../g).map(h => parseInt(h, 16));
t('底色偏紫（红蓝都比绿高）', base[0] > base[1] && base[2] > base[1], base);

console.log('\n[样式隔离]');
const stray = rules(css).flatMap(([sel]) => parts(sel)).filter(p => !/^html\.theme-dusk\b/.test(p) && p !== '.swatch-dusk');
t('dusk.css 每条都挂在 html.theme-dusk 下（小样除外）', rules(css).length > 10 && stray.length === 0, stray.slice(0, 3));
t('纸挂在 #bg-mask::before（::after 归色块形状）', /html\.theme-dusk #bg-mask::before/.test(css) && !/theme-dusk #bg-mask::after/.test(css));
t('外观面板有小样', rules(css).some(([sel]) => sel === '.swatch-dusk'));
t('--on-accent 在暮紫下兜底成深色', /html\.theme-dusk \{[^}]*--on-accent:var\(--dk-ink\)/.test(css));

console.log('\n[纸]');
const paper = (rules(css).find(([sel]) => sel === 'html.theme-dusk #bg-mask::before') || [, ''])[1];
t('有颗粒（feTurbulence）', /feTurbulence/.test(decodeURIComponent((paper.match(/data:image\/svg\+xml,([^"]*)"/) || [, ''])[1])));
t('中间一团紫光', /radial-gradient\([^)]*rgba\(var\(--dk-plum-rgb\)/.test(paper));

console.log('\n[四角画框]');
const frame = rules(css).filter(([sel]) => sel === 'html.theme-dusk main::before');
const f0 = (frame[0] || [, ''])[1];
const imgs = [...f0.matchAll(/url\("data:image\/svg\+xml,([^"]*)"\) (left|right) (top|bottom)\//g)];
t('四个角各一张', imgs.length === 4 && new Set(imgs.map(m => m[2] + m[3])).size === 4, imgs.map(m => m[2] + ' ' + m[3]));
const svgs = imgs.map(m => decodeURIComponent(m[1]));
const inner = s => s.replace(/<g [^>]*>/, '').replace(/<\/g>.*/, '');
t('四个角是同一份卷草镜像出来的（左上不带 transform，其它三个各翻一边）',
  svgs.length === 4 && svgs.every(s => inner(s) === inner(svgs[0])) && !/transform/.test(svgs[0]) && svgs.slice(1).every(s => /scale\(-?1 -?1\)/.test(s)));
t('压在 main 的内容底下（z-index:-1）、不吃点击', /z-index:-1/.test(f0) && /pointer-events:none/.test(f0));
t('顶上让开 header（54px）', +((f0.match(/inset:(\d+)px/) || [, 0])[1]) >= 54);
t('手机上缩小、顶上让开 42px 的 header', frame.length === 2 && /background-size:\d+px/.test(frame[1][1]) && +((frame[1][1].match(/inset:(\d+)px/) || [, 0])[1]) >= 42);

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
