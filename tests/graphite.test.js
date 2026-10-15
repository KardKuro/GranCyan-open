// 石墨色温（用户收藏夹 006 maneater meme：石墨灰 + 上浓下淡的网点 + 只亮一点 #c9e141 柠绿）
//
// 跟薄荷巧克力一样全是「零报错」的坑：专属类没挂上 / 切走没摘，网点就没了或者飘到别的配色底下；
// 网点条画反了（下面浓上面淡）或者点一样大，看着只是一层灰纹，不是她喜欢的那种渐变；
// 柠绿是亮色，哪个按钮又写回 color:#fff，字就看不见了 —— 都不会报错，只会长得不对。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n'); // 源码是 CRLF
let passed = 0, failed = 0;
function t(name, ok, detail) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); } }

const html = read('index.html');
const state = read('js/02-state.js');
const mainCss = read('css/grancyan.css');
const grCss = read('css/graphite.css');

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
t('外观里能选石墨', /data-theme-temperature="graphite"[^>]*onclick="setThemeTemperature\('graphite'\)"/.test(html));
const iM = html.indexOf('css/mint-choc.css'), iG = html.indexOf('css/graphite.css'), iC = html.indexOf('css/choco-shape.css');
t('graphite.css 排在配色文件之后、形状文件之前（形状要赢）', iM > 0 && iG > iM && iC > iG);

console.log('\n[配色]');
const pal = (state.match(/\n  graphite:\s*\{([\s\S]*?)\n  \}/) || [, ''])[1];
const keys = ['accent', 'bgBase', 'bgSurface', 'bgElevated', 'bgHover', 'textPrimary', 'textMuted', 'textDim', 'textSecondary', 'mask'];
t('字段齐全', keys.every(k => new RegExp(k + ":'").test(pal)));
t('强调色是原片里取的柠绿', /accent:'#c9e141'/.test(pal));
t('是深色（没标 light）', pal && !/light:/.test(pal));
t('带专属类 theme-graphite', /cls:'theme-graphite'/.test(pal));
// 原片的底是中性灰不是黑：底色三个通道要接近（不偏蓝不偏棕），也不能是纯黑
const base = (pal.match(/bgBase:'#([0-9a-f]{6})'/i) || [, '000000'])[1].match(/../g).map(h => parseInt(h, 16));
t('底色是中性灰（不偏色、不是纯黑）', Math.max(...base) - Math.min(...base) <= 4 && Math.min(...base) >= 0x1c, base);

console.log('\n[样式隔离]');
const stray = rules(grCss).flatMap(([sel]) => parts(sel)).filter(p => !/^html\.theme-graphite\b/.test(p) && p !== '.swatch-graphite');
t('graphite.css 每条都挂在 html.theme-graphite 下（小样除外）', rules(grCss).length > 10 && stray.length === 0, stray.slice(0, 3));
t('网点挂在 #bg-mask::before（::after 归色块形状）', /html\.theme-graphite #bg-mask::before/.test(grCss) && !/theme-graphite #bg-mask::after/.test(grCss));
t('外观面板有小样', rules(grCss).some(([sel]) => sel === '.swatch-graphite'));

console.log('\n[网点渐变]');
const before = (rules(grCss).find(([sel]) => /#bg-mask::before/.test(sel)) || [, ''])[1];
const svg = decodeURIComponent((before.match(/url\("data:image\/svg\+xml,([^"]*)"\)/) || [, ''])[1]);
const dots = [...svg.matchAll(/<circle cx='([\d.]+)' cy='([\d.]+)' r='([\d.]+)'\/>/g)].map(m => ({ cx: +m[1], cy: +m[2], r: +m[3] }));
const rows = [...new Map(dots.map(d => [d.cy, d])).values()].sort((a, b) => a.cy - b.cy);
t('网点条里有一排排的圆点', rows.length >= 20, rows.length);
t('上浓下淡：每往下一排点都更小', rows.length > 1 && rows.every((d, i) => i === 0 || d.r < rows[i - 1].r), rows.map(d => d.r).slice(0, 6));
t('最上面是大点、最下面几乎没了', rows.length && rows[0].r >= 4 && rows[rows.length - 1].r < 1, rows.length && [rows[0].r, rows[rows.length - 1].r]);
const onEdge = cy => dots.some(d => d.cy === cy && d.cx === 0);
t('隔行错开半格（印刷网点那样）', rows.length > 2 && rows.every((d, i) => i === 0 || onEdge(d.cy) !== onEdge(rows[i - 1].cy)));
const W = +(svg.match(/width='(\d+)'/) || [, 0])[1];
t('不在格子正中的那排左右两头各画一个，横向平铺接得上', W > 0 && dots.filter(d => d.cx === 0).length === dots.filter(d => d.cx === W).length);
t('压得淡（不抢字）', +((svg.match(/fill-opacity='([\d.]+)'/) || [, 1])[1]) <= 0.2);
t('只横向平铺（竖着不重复，才是一条渐变）', /repeat-x/.test(before));

console.log('\n[柠绿上的字]');
// 石墨不像薄荷巧克力那样自己带一张「换深字」的表：grancyan.css 里实心强调色的按钮全走 --on-accent，
// applyAccentCSS 按亮度挑字色。哪个按钮写回 color:#fff，酸性和石墨上那颗按钮的字就没了
const whiteOnAccent = rules(mainCss)
  .filter(([, b]) => /background(-color)?\s*:\s*var\(--accent\)\s*(;|!|$)/.test(b) && /(^|;|\s)color\s*:\s*(#fff\b|#ffffff|white)/i.test(b))
  .flatMap(([sel]) => parts(sel));
t('grancyan.css 里没有「实心强调色 + 写死白字」的按钮了', whiteOnAccent.length === 0, whiteOnAccent);
t('--on-accent 在石墨下兜底成深橄榄', /html\.theme-graphite \{[^}]*--on-accent:var\(--gr-ink\)/.test(grCss));

console.log('\n[换成石墨：硬边横推]');
t('只有换成石墨时传 wipe', /themeSwap\(\(\) => _setThemeTemperature\(name\), name === 'graphite' \? 'wipe' : undefined\)/.test(state));
const swapSrc = state.slice(state.indexOf('let _themeSwapXY'), state.indexOf('function setThemeTemperature('));
function makeEnv() {
  const env = { calls: [], innerWidth: 1000, innerHeight: 600 };
  env.window = { matchMedia: () => ({ matches: false }) };
  env.matchMedia = env.window.matchMedia;
  env.document = {
    hidden: false, addEventListener: (type, fn) => { env.onDown = fn; },
    documentElement: { animate: (kf, opt) => { env.calls.push(['animate', kf, opt]); } },
    startViewTransition: cb => { env.calls.push(['vt']); cb(); return { ready: { then: f => { f(); return { catch() {} }; } } }; },
  };
  vm.createContext(env);
  vm.runInContext(swapSrc, env);
  return env;
}
let e = makeEnv(), applied = 0;
e.onDown({ clientX: 900, clientY: 300 });
e.themeSwap(() => applied++, 'wipe');
let a = e.calls.find(c => c[0] === 'animate');
t('点在右半边 → 新画面从右边推进来', applied === 1 && a && a[1].clipPath[0] === 'inset(0 0 0 100%)' && a[1].clipPath[1] === 'inset(0 0 0 0)', a && a[1].clipPath);
t('是一刀切的矩形，不是圆', a && !/circle/.test(a[1].clipPath.join()));
t('动的是新画面那层', a && a[2].pseudoElement === '::view-transition-new(root)');
e = makeEnv();
e.onDown({ clientX: 80, clientY: 300 });
e.themeSwap(() => applied++, 'wipe');
a = e.calls.find(c => c[0] === 'animate');
t('点在左半边 → 从左边推进来', a && a[1].clipPath[0] === 'inset(0 100% 0 0)', a && a[1].clipPath);
e = makeEnv();
e.onDown({ clientX: 80, clientY: 300 });
e.themeSwap(() => applied++);
a = e.calls.find(c => c[0] === 'animate');
t('不传 wipe 照旧画圆', a && /^circle\(0px at 80px 300px\)$/.test(a[1].clipPath[0]));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
