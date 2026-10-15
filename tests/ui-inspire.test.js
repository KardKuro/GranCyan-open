'use strict';
// 从一组平面设计参考里拆出来的招：
//   空页面猫背后的回声大字 + 极淡网格；换色温 / 形状时新样子从点的地方画圆扩开。
// 守的是「零报错、只会长得不对」的那几件：大字被公共规则拽回文档流（变成挤在猫上面的一行字）、
// 名字留着「（claude-opus-4-6）」切成半截、圆形扩开在不支持 / 减少动效时把换主题整个吞掉。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); // 源码是 CRLF
let passed = 0, failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i) + 2); };

const css = read('css/grancyan.css');
const msg = read('js/06-render-msg.js');
const st = read('js/02-state.js');

console.log('\n[空页面：回声大字 + 网格]');
t('空页面画出网格，对读屏隐藏', /class="empty-bg empty-grid" aria-hidden="true"/.test(msg));
t('公共的「抬到 z-index:1」规则绕开 .empty-bg（不然网格被拽回文档流）', /\.empty-state > :not\(\.empty-aurora\):not\(svg\):not\(\.empty-bg\) \{ position:relative;z-index:1; \}/.test(css));
// 差值：大字要反的是壁纸 / 遮罩 / 网点，它们在最外层（#bg-layer z-2、#bg-mask z-1），main 自己是一层（z-index:10）。
// 大字留在 main 里，差值就只跟 main 里透明的那片混 —— 不报错，只是什么都没反（10-14 第一版就是这样）
t('大字不再写进空页面模板（留在 main 里差值碰不到背景）', !/empty-echo/.test(fnSrc(msg, 'renderMessages')));
t('renderMessages 在空页面时同步大字那一层', /syncEmptyEcho\(\)/.test(fnSrc(msg, 'renderMessages')));
const sync = fnSrc(msg, 'syncEmptyEcho');
t('大字那一层挂在 body 下', /document\.body\.appendChild\(layer\)/.test(sync) && /layer\.id = 'emptyEchoLayer'/.test(sync));
t('那一层框成 chatWindow 的位置和大小', /getBoundingClientRect\(\)/.test(sync) && /left: r\.left/.test(sync) && /width: r\.width/.test(sync));
t('空页面被换掉 / 窗口变了都会跟着藏或挪', /new MutationObserver\(syncEmptyEcho\)/.test(sync) && /ResizeObserver\(syncEmptyEcho\)/.test(sync));
const layerCss = (css.match(/\n#emptyEchoLayer \{([^}]*)\}/) || [, ''])[1];
const mainZ = +((css.match(/\nmain \{[^}]*z-index:(\d+)/) || [, NaN])[1]);
const layerZ = +((layerCss.match(/z-index:(-?\d+)/) || [, NaN])[1]);
t('那一层压在 main 底下、背景上面（0 ≤ z < main）', layerZ >= 0 && layerZ < mainZ, [layerZ, mainZ]);
t('差值写在那一层上（它自己成层，混合要挂在跟背景同一层的元素上）', /mix-blend-mode:difference/.test(layerCss) && /position:fixed/.test(layerCss) && /pointer-events:none/.test(layerCss));
const echo = (css.match(/\n#emptyEchoLayer \.empty-echo \{([^}]*)\}/) || [, ''])[1];
// 定下来的字形：空心白字、描边比原来的 1.5px 粗一点点（实心白字没有空心好看）。
// 描边不能直接描在字上：Cormorant 关节处轮廓是叠着的，直接描会在字里留一截截白线（笔画看着没擦干净）。
// 现在是后面一层（::before）描白，前面的字填黑盖住里面那半圈和叠缝 —— 黑在差值里等于不反，所以看着还是空心
const before = (css.match(/\n#emptyEchoLayer \.empty-echo::before \{([^}]*)\}/) || [, ''])[1];
const stroke = before.match(/-webkit-text-stroke:([\d.]+)px (#fff|#ffffff|white)\b/);
t('前面的字填黑（差值里黑 = 背景原样，不是实心白）', /color:#000\b/.test(echo) && !/-webkit-text-stroke/.test(echo), echo);
t('白描边在后面那一层，读同一个名字、垫在字底下', !!stroke && /content:attr\(data-text\)/.test(before) && /z-index:-1/.test(before) && /position:absolute;inset:0/.test(before), before);
t('露出来的外半圈比原来的 1.5px 粗一点点（不超过 3px）', stroke && +stroke[1] / 2 > 1.5 && +stroke[1] / 2 <= 3, stroke && stroke[1]);
t('名字两处都同步写进 data-text（不然描边那层是空的 / 换模型后对不上）',
  /textContent = layer\.firstChild\.dataset\.text = _emptyEchoName\(\)/.test(sync) && /el\.textContent = el\.dataset\.text = _emptyEchoName\(\)/.test(fnSrc(msg, 'refreshEmptyEcho')));
t('标题和小字垫一圈底色外阴影（大字的线从底下穿过时不划花字）', /\n\.empty-title, \.empty-sub \{ text-shadow:0 0 \d+px rgba\(var\(--bg-rgb\)/.test(css));
t('大字不折行（两头出血就是要的样子）', /white-space:nowrap/.test(echo));
t('减少动态效果时大字不播入场（选择器得压得过 #emptyEchoLayer .empty-echo）', /\.empty-title span, \.empty-sub, #emptyEchoLayer \.empty-echo \{ animation:none/.test(css));
t('浅色自动翻色不碰它（翻成深字差值就没了）', /#emptyEchoLayer/.test(read('scripts/gen-light-patch.js').match(/const SKIP = .*/)[0]) && !/#emptyEchoLayer/.test(read('css/light-patch.css')));
t('换模型时就地换名字（renderModelPills 调 refreshEmptyEcho）', /refreshEmptyEcho\(\)/.test(fnSrc(read('js/03-chats-models.js'), 'renderModelPills')));

const box = { state: { configs: [] }, ids: [], getActiveChatModelIds() { return box.ids; } };
vm.createContext(box);
vm.runInContext(fnSrc(msg, '_emptyEchoName'), box);
const name = (configs, ids) => { box.state.configs = configs; box.ids = ids; return box._emptyEchoName(); };
t('只选一个模型 → 它的名字，括号里的型号去掉', name([{ id: 1, nickname: '小克（claude-opus-4-6）' }], [1]) === '小克', name([{ id: 1, nickname: '小克（claude-opus-4-6）' }], [1]));
t('半角括号也去', name([{ id: 1, nickname: 'Opus (5.5)' }], [1]) === 'Opus');
t('选了好几个 → GranCyan', name([{ id: 1, nickname: 'a' }, { id: 2, nickname: 'b' }], [1, 2]) === 'GranCyan');
t('一个没选 → GranCyan', name([{ id: 1, nickname: 'a' }], []) === 'GranCyan');
t('名字只剩括号 → GranCyan（不画一行空的）', name([{ id: 1, nickname: '（测试）' }], [1]) === 'GranCyan');

console.log('\n[换主题：从点的地方画圆扩开]');
const swapSrc = st.slice(st.indexOf('let _themeSwapXY'), st.indexOf('function setThemeTemperature('));
function makeEnv({ vt = true, reduce = false, hidden = false } = {}) {
  const env = { calls: [], innerWidth: 1000, innerHeight: 600 };
  env.window = { matchMedia: () => ({ matches: reduce }) };
  env.matchMedia = env.window.matchMedia;
  env.document = {
    hidden, addEventListener: (type, fn) => { env.onDown = fn; },
    documentElement: { animate: (kf, opt) => { env.calls.push(['animate', kf, opt]); } },
  };
  if (vt) env.document.startViewTransition = cb => { env.calls.push(['vt']); cb(); return { ready: { then: f => { f(); return { catch() {} }; } } }; };
  vm.createContext(env);
  vm.runInContext(swapSrc, env);
  return env;
}
let applied = 0;
let e = makeEnv({ vt: false });
e.themeSwap(() => applied++);
t('浏览器不支持 → 直接换（不吞掉）', applied === 1 && e.calls.length === 0);
e = makeEnv({ reduce: true });
e.themeSwap(() => applied++);
t('减少动态效果 → 直接换，不播圆', applied === 2 && e.calls.length === 0);
e = makeEnv({ hidden: true });
e.themeSwap(() => applied++);
t('窗口在后台 → 直接换', applied === 3 && e.calls.length === 0);
e = makeEnv();
e.onDown({ clientX: 100, clientY: 50 });
e.themeSwap(() => applied++);
const anim = e.calls.find(c => c[0] === 'animate');
t('支持时走 View Transition，换主题照样执行', applied === 4 && e.calls[0][0] === 'vt');
t('圆从点的地方长出来', anim && /circle\(0px at 100px 50px\)/.test(anim[1].clipPath[0]), anim && anim[1].clipPath);
const rr = anim && +anim[1].clipPath[1].match(/circle\(([\d.]+)px/)[1];
t('终点半径盖住最远的那个角（不留一块旧主题）', rr >= Math.hypot(900, 550) - 0.5, rr);
t('动画挂在新画面上', anim && anim[2].pseudoElement === '::view-transition-new(root)');
e.themeSwap(() => applied++);
const anim2 = e.calls.filter(c => c[0] === 'animate')[1];
t('没有新的点击 → 从屏幕中间长（不沿用上一次的点）', anim2 && /at 500px 300px/.test(anim2[1].clipPath[0]), anim2 && anim2[1].clipPath[0]);
t('色温和形状都走它', /function setThemeTemperature\(name\) \{\s*if \(!THEME_TEMPERATURES\[name\]\) return;\s*themeSwap\(/.test(st) && /function setUiShape\(name\) \{\s*if \(!UI_SHAPES\[name\]\) return;\s*themeSwap\(/.test(st));
t('关掉默认的交叉淡化', /::view-transition-old\(root\), ::view-transition-new\(root\) \{ animation:none;/.test(css));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
