const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const css = read('css/grancyan.css');

console.log('\n[图标]');
t('图标基类在（没有它每个图标都是没上 mask 的实心块）', /^\.gi \{/m.test(css));
t('图标吃 currentColor（三套皮肤才不用各写一遍）', /\.gi \{[\s\S]*?background-color:currentColor/.test(css));
// Android WebView 老版本只认带前缀的 mask，漏了就整排图标消失且零报错
t('mask 带 -webkit- 前缀', /-webkit-mask:var\(--gi\)/.test(css));

/* ⚠️ 这条是这个文件存在的理由。
   .gi 上写了 background-color:currentColor，靠 mask 把它抠成图标形状。
   要是某个 gi-xxx 没有对应的 --gi 定义，mask 就是空的 —— 背景色照铺，
   结果是一个**实心色块**戳在界面上。不报错、不报警，只能靠眼睛看见。
   （加 mail 那次就是这么漏的：HTML 里写了 gi-mail，生成器的清单里没有。） */
const used = [...new Set((html.match(/\bgi-[a-z0-9-]+/g) || []))];
const defined = new Set((css.match(/^\.gi-[a-z0-9-]+/gm) || []).map(s => s.slice(1)));
const orphan = used.filter(u => !defined.has(u));
t('HTML 里用到的图标类都有对应的 --gi 定义', used.length > 0 && orphan.length === 0);
if (orphan.length) orphan.forEach(o => console.log('      没定义: ' + o));

// 反过来：定义了却没人用的，白占体积。不算错，但要能看见。
const unused = [...defined].filter(d => !used.includes(d));
t('没有定义了却没用上的图标（白占 APK 体积）', unused.length === 0);
if (unused.length) unused.forEach(u => console.log('      没用上: ' + u));

t('每个图标都真的带了图形数据', (css.match(/^\.gi-[a-z0-9-]+ \{ --gi:url\("data:image\/svg\+xml,%3Csvg/gm) || []).length === defined.size);
// 整包 815 个约 3.4MB。只挑用到的是有意为之，别哪天顺手全塞进来。
t('只内联了用到的那几个，没把整包搬进来', defined.size < 60);
t('注明了来源和许可（CC0 虽不要求署名，但得让人查得到出处）',
  /game-icon-pack/.test(css) && /CC0/.test(css));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
