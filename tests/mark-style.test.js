'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appearanceSrc = read('js/09-appearance-input.js');
const mediaSrc = read('js/12-math-media.js');
const stateSrc = read('js/02-state.js');
const promptSrc = read('js/05-prompts-api.js');
const momentsSrc = read('js/51-moments.js');
const indexSrc = read('index.html');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

let currentBg = '#141210';
const renderBox = {
  console, Math, Number, String, Array, Object,
  document: { documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: name => name === '--bg-surface' ? currentBg : '' }),
  normalizeStickerTags: text => text,
  _stickerList: []
};
renderBox.globalThis = renderBox;
vm.createContext(renderBox);
const escStart = appearanceSrc.indexOf('function escHtml(str)');
const escEnd = appearanceSrc.indexOf('/* 把值拼进 onclick=', escStart);
vm.runInContext(appearanceSrc.slice(escStart, escEnd), renderBox, { filename: '09-appearance-input.js#escHtml' });
const markStart = mediaSrc.indexOf('function _markRgb(value)');
const markEnd = mediaSrc.indexOf('// AI 引用条点击：', markStart);
vm.runInContext(mediaSrc.slice(markStart, markEnd), renderBox, { filename: '12-math-media.js#mark' });

function render(raw, bg = '#141210') {
  currentBg = bg;
  renderBox.__raw = raw;
  return vm.runInContext('stickerTagToHtml(__raw)', renderBox);
}
function displayColor(html) {
  const hit = html.match(/style="color:([^;]+);/);
  return hit && hit[1];
}
/* 透明度 2026-09-22 起走 `--mk-o` 变量下发（闪烁那条 keyframes 动的就是 opacity，
   写死的话「半透明 + 闪烁」里的半透明会被动画整个盖掉）。所以断言不能再比
   字面量 `opacity:0.6` —— 解出变量算实际值再比，换实现也不用回来改一遍。 */
function opacityOf(html) {
  const decl = (html.match(/style="([^"]*)"/) || ['', ''])[1];
  const raw = (decl.match(/(?:^|;)opacity:([^;]+)/) || [])[1];
  if (raw == null) return null;
  if (!/^var\(--mk-o\)$/.test(raw.trim())) return Number(raw);
  const v = (decl.match(/--mk-o:([^;]+)/) || [])[1];
  return v == null ? null : Number(v);
}
function lum(color) {
  renderBox.__color = color;
  return vm.runInContext('_markLum(_markRgb(__color))', renderBox);
}
function contrast(a, b) {
  renderBox.__a = a;
  renderBox.__b = b;
  return vm.runInContext('_markContrast(_markRgb(__a), _markRgb(__b))', renderBox);
}

console.log('\n[1] MARK 参数渲染与安全边界');
const full = render('[[MARK: <b>蓝光</b> | o=0.6 c=#88ccff s=1.4]]');
t('★ MARK 三参数齐全按任意顺序进入 style，文本经过 escHtml',
  full.includes('color:#88ccff;font-size:1.4em') && opacityOf(full) === 0.6
    && full.includes('&lt;b&gt;蓝光&lt;/b&gt;') && !full.includes('<b>蓝光</b>'),
  full);

t('★ 透明度是经 --mk-o 变量下发的（写死的话闪烁会把半透明整个盖掉，静默失效）',
  /--mk-o:0\.6/.test(full) && /opacity:var\(--mk-o\)/.test(full), full);

const defaults = render('[[MARK: 默认标注]]');
t('★ MARK 参数全省时使用主题强调色和默认字号透明度',
  defaults.includes('color:var(--accent);font-size:1em') && opacityOf(defaults) === 1
    && !defaults.includes('data-mark-c=') && !defaults.includes('data-mark-s=') && !defaults.includes('data-mark-o=')
    && !defaults.includes('data-mark-b=') && !defaults.includes('filter:'),
  defaults);

const malicious = 'red;background:url(javascript:boom)';
const rejected = render(`[[MARK: 安全 | c=${malicious}]]`);
t('★ MARK 非法色号彻底丢弃并走默认，结果不含非法字符串',
  rejected.includes('color:var(--accent)') && !rejected.includes(malicious) && !rejected.includes('javascript:boom'),
  rejected);

const bounded = render('[[MARK: 低 | s=-4 o=-1]] / [[MARK: 高 | o=9 s=7]]');
t('★ MARK 字号与透明度超范围时上下两端都被钳制',
  (() => {
    const [lo, hi] = bounded.split('</span>');
    return lo.includes('font-size:0.6em') && opacityOf(lo) === 0.3
        && hi.includes('font-size:2em') && opacityOf(hi) === 1;
  })(),
  bounded);

console.log('\n[1.5] MARK 模糊参数渲染、量化与安全边界');
const gaussian = render('[[MARK: 高斯 | b=1.5]]');
t('★ MARK b=1.5 进入高斯 blur filter',
  gaussian.includes('filter:blur(1.5px)'), gaussian);

const gaussianBounds = render('[[MARK: 高 | b=9]] / [[MARK: 低 | b=-3]]');
t('★ MARK 高斯模糊上下两端钳制且负数不发 filter',
  gaussianBounds.includes('filter:blur(2.5px)')
    && (gaussianBounds.match(/filter:/g) || []).length === 1,
  gaussianBounds);

const gaussianZero = render('[[MARK: 不糊 | b=0]]');
t('★ MARK b=0 不发 filter 但保留原值 data-mark-b',
  !gaussianZero.includes('filter:') && gaussianZero.includes('data-mark-b="0"'), gaussianZero);

const directional = render('[[MARK: 横 | b=h2]] / [[MARK: 纵 | b=v3.5]]');
t('★ MARK h2 和 v3.5 映射到对应方向 filter id',
  directional.includes('filter:url(#mkb-h-20)') && directional.includes('filter:url(#mkb-v-35)'),
  directional);

const quantized = render('[[MARK: 近档 | b=h2.7]] / [[MARK: 上钳 | b=h9]] / [[MARK: 下钳 | b=h0.1]]');
t('★ MARK 方向模糊按 0.5 档量化并钳制范围',
  quantized.includes('filter:url(#mkb-h-25)') && quantized.includes('filter:url(#mkb-h-40)')
    && quantized.includes('filter:url(#mkb-h-05)'),
  quantized);

const invalidBlurValues = ['abc', '2px', 'x3', 'h', 'h0', 'h-1', 'h2;filter:url(#evil)'];
const invalidBlurHtml = invalidBlurValues.map(value => render(`[[MARK: 安全 | b=${value}]]`));
t('★ MARK 非法 b 全部忽略且非法原串不进入 HTML',
  invalidBlurHtml.every((html, i) => !html.includes('filter:') && !html.includes('data-mark-b=')
    && !html.includes(invalidBlurValues[i])),
  invalidBlurHtml.join(' / '));

const blurIds = [];
for (const axis of ['h', 'v']) {
  for (const amount of [0.51, 1.01, 1.51, 2.01, 2.51, 3.01, 3.51, 4.01]) {
    renderBox.__blur = axis + amount;
    blurIds.push(vm.runInContext('_markBlur(__blur).id', renderBox));
  }
}
t('★ MARK 渲染器生成的全部 16 个方向 filter id 都存在于 index.html',
  blurIds.length === 16 && new Set(blurIds).size === 16
    && blurIds.every(id => indexSrc.includes(`id="${id}"`)),
  blurIds.filter(id => !indexSrc.includes(`id="${id}"`)).join(', '));

const originalBlur = render('[[MARK: 原值 | b=h2.7]]');
t('★ MARK data-mark-b 保存量化前的模型原值',
  originalBlur.includes('data-mark-b="h2.7"'),
  originalBlur);

const allFour = render('[[MARK: 四样 | b=v2 c=#88ccff o=0.6 s=1.4]]');
t('★ MARK b 与 c/s/o 四参数共存时全部生效在同一个 style',
  allFour.includes('data-mark-c="#88ccff"') && allFour.includes('data-mark-s="1.4"')
    && allFour.includes('data-mark-o="0.6"') && allFour.includes('data-mark-b="v2"')
    && allFour.includes('color:#88ccff;font-size:1.4em') && opacityOf(allFour) === 0.6
    && allFour.includes('filter:url(#mkb-v-20)"'),
  allFour);


console.log('\n[1.6] MARK 渐变与描边');

// 渐变字的做法是「渐变当背景 + 按字形裁剪 + 字身透明」。三件必须同时出现，
// 少一件的后果都不是"样子不对"而是"字看不见"或"渐变不出来"。
const grad = render('[[MARK: 渐变 | g=#ff8ab0-#88ccff]]');
t('★★ 渐变三件套齐全：背景是 linear-gradient、按字形裁剪、字身透明',
  grad.includes('background-image:linear-gradient(')
    && grad.includes('-webkit-background-clip:text') && grad.includes('background-clip:text')
    && grad.includes('-webkit-text-fill-color:transparent'),
  grad);

// ⚠️ 这条守的是**降级**，不是好看。引擎要是不认 background-clip:text，
//   多半也不认 -webkit-text-fill-color，于是 color 生效 → 退回一个纯色。
//   没有它的话，不支持的机器上渲染出来是一行看不见的字（静默失效）。
t('★★ 渐变仍然先写 color 打底（引擎不支持时回落成纯色，不是隐形字）',
  /style="color:#[0-9a-f]{6};background-image:linear-gradient\(/.test(grad), grad);

t('★ 渐变默认方向是 90deg（从左到右）',
  grad.includes('linear-gradient(90deg,'), grad);

const gradAngle = render('[[MARK: 斜的 | g=-45:#ff8ab0-#88ccff]]');
t('★ 负角度归一化成正的（CSS 里不出现负号，-45 和 315 是同一个方向）',
  gradAngle.includes('linear-gradient(315deg,'), gradAngle);

const gradArrow = render('[[MARK: 箭头 | g=#ff8ab0>#88ccff]]');
t('★ 分隔符 - 和 > 都收（模型两种都会写）',
  gradArrow.includes('linear-gradient(90deg, #ff8ab0, #88ccff)'), gradArrow);

// ⚠️ 渐变照样要过对比度保护。深色底上一条 #222→#333 的渐变就是一行看不见的字，
//   「换了个属性所以保护不生效」正是这类功能最容易漏的地方。
const gradDark = render('[[MARK: 暗渐变 | g=#222-#333]]', '#141210');
const gradStops = (gradDark.match(/linear-gradient\(90deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\)/) || []).slice(1);
t('★★ 渐变的每个色标都过对比度钳制（否则暗底上整条渐变都看不见）',
  gradStops.length === 2 && gradStops.every(c => contrast(c, '#141210') >= 3),
  JSON.stringify(gradStops));
t('★ 而且 data 属性存的仍是模型写的原值，不是钳制后的显示值',
  gradDark.includes('data-mark-g="#222-#333"'), gradDark);

t('☑ 色标少于 2 个 / 多于 3 个 / 不是合法色号 → 整个 g 作废，不留半截样式',
  !render('[[MARK: 单色 | g=#ff8ab0]]').includes('linear-gradient')
    && !render('[[MARK: 四色 | g=#111-#222-#333-#444]]').includes('linear-gradient')
    && !render('[[MARK: 乱写 | g=red-blue]]').includes('linear-gradient'));

// ── 描边 ──
const stroke = render('[[MARK: 描边 | k=#000000]]');
t('★ 描边默认粗细 0.6px，并且带 paint-order:stroke fill',
  stroke.includes('-webkit-text-stroke:0.6px #000000') && stroke.includes('paint-order:stroke fill'),
  stroke);

// paint-order 不是装饰：不加的话描边骑在字形边缘上往里吃一半，
// 汉字笔画细，稍粗一点就把字心糊死。
t('★★ 描边必须让字身画在描边之上（paint-order），否则汉字会被自己的边吃掉',
  stroke.includes('paint-order:stroke fill'), stroke);

t('★ 粗细可指定并被钳制在 0.2~3',
  render('[[MARK: 粗 | k=9:#000000]]').includes('-webkit-text-stroke:3px #000000')
    && render('[[MARK: 细 | k=0.01:#000000]]').includes('-webkit-text-stroke:0.2px #000000'));

// ⚠️ 描边色**不过**对比度保护：那个保护管「字会不会融进背景」，
//   而描边的职责恰恰是跟字身拉开对比。亮渐变配纯黑边是常见写法，
//   拿背景对比度去推它会把黑边推成白边，等于把这个功能废掉。
t('★★ 描边色原样输出，不被对比度保护推走（黑边就得是黑边）',
  render('[[MARK: 黑边 | k=#000000]]', '#141210').includes('-webkit-text-stroke:0.6px #000000'));

t('☑ 描边色不合法 → 整个 k 作废',
  !render('[[MARK: 乱写 | k=black]]').includes('text-stroke'));

// 渐变 + 描边叠加：两套样式都要在，而且字身透明那句不能被描边顶掉
const both = render('[[MARK: 都要 | g=#ff8ab0-#88ccff k=1:#000000]]');
t('★ 渐变和描边可以叠，两套样式同时存在',
  both.includes('linear-gradient(90deg') && both.includes('-webkit-text-stroke:1px #000000')
    && both.includes('-webkit-text-fill-color:transparent'),
  both);

// g 和 c 同时写时 c 物理上无效（字身被挖空了）。这不是我们挑掉的，
// 是渐变实现的必然结果 —— 提示词里对模型说清楚了，这里钉住行为。
const gc = render('[[MARK: 撞了 | c=#ff0000 g=#ff8ab0-#88ccff]]');
t('★ g 和 c 同时写时以 g 为准（c 被字身透明物理覆盖），但 c 的原值仍留在 data 里',
  gc.includes('linear-gradient(90deg') && gc.includes('-webkit-text-fill-color:transparent')
    && gc.includes('data-mark-c="#ff0000"'),
  gc);

console.log('\n[2] WCAG 对比度与原值留存');
const darkHtml = render('[[MARK: 暗底 | c=#222]]', '#141210');
const lightHtml = render('[[MARK: 亮底 | c=#ddd]]', '#ffffff');
const darkDisplay = displayColor(darkHtml);
const lightDisplay = displayColor(lightHtml);
t('★ MARK 对比度钳制同时覆盖暗底提亮与亮底压暗',
  contrast(darkDisplay, '#141210') >= 3 && lum(darkDisplay) > lum('#222')
    && contrast(lightDisplay, '#ffffff') >= 3 && lum(lightDisplay) < lum('#ddd'),
  JSON.stringify({ darkDisplay, lightDisplay }));

t('★ MARK data 属性保存钳制前的原始色号而非显示色',
  darkHtml.includes('data-mark-c="#222"') && darkDisplay !== '#222',
  darkHtml);

const state = {
  moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [],
  userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
  webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false
};
const promptBox = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }), state,
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: value => String(value),
  pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {}
};
promptBox.globalThis = promptBox;
vm.createContext(promptBox);
const tokenStart = stateSrc.indexOf('function estimateTokens(text)');
const tokenEnd = stateSrc.indexOf('function getChatTotalTokens', tokenStart);
vm.runInContext(stateSrc.slice(tokenStart, tokenEnd), promptBox, { filename: '02-state.js#estimateTokens' });
vm.runInContext(promptSrc, promptBox, { filename: '05-prompts-api.js' });
vm.runInContext(momentsSrc, promptBox, { filename: '51-moments.js' });

const roundtripHtml = render('[[MARK: 往返 | c=#8cf s=2.7 o=0.2 b=h2.7]]');
const back = promptBox.stickerTagForApi(roundtripHtml);
t('★ MARK 渲染回填按 c/s/o/b 顺序咬回原值且不残留 HTML',
  back === '[[MARK: 往返 | c=#8cf s=2.7 o=0.2 b=h2.7]]' && !/<[^>]+>/.test(back),
  back);

// ⚠️ 渐变和描边也必须能咬回来。回填漏掉一个参数的症状是**模型一边在用、
//   一边从历史里学到"我从来没用过这个参数"** —— 展示格式≠指令格式，
//   别的指令栽过这条，而且零报错。
const gkBack = promptBox.stickerTagForApi(render('[[MARK: 花字 | g=90:#ff8ab0-#88ccff k=1.2:#000000]]'));
t('★★ 渐变和描边也要能从 HTML 咬回指令原值（漏了模型会学成"我没用过"）',
  gkBack === '[[MARK: 花字 | g=90:#ff8ab0-#88ccff k=1.2:#000000]]', gkBack);

console.log('\n[3] GLITCH 样式原意回填与旧数据回落');
const glitchStyledHtml = render('[[GLITCH: 疼|big]]');
const glitchStyledBack = promptBox.stickerTagForApi(glitchStyledHtml);
t('★ GLITCH 显式样式渲染回填咬回原词和样式',
  glitchStyledBack === '[[GLITCH: 疼|big]]',
  glitchStyledBack);

const glitchDefaultHtml = render('[[GLITCH: 疼]]');
const glitchDefaultBack = promptBox.stickerTagForApi(glitchDefaultHtml);
t('★ GLITCH 未指定样式回填不伪造哈希样式',
  glitchDefaultBack === '[[GLITCH: 疼]]' && !glitchDefaultBack.includes('|'),
  glitchDefaultBack);

const glitchLegacyBack = promptBox.stickerTagForApi('<span class="glitch-word g3">疼</span>');
t('★ GLITCH 旧 HTML 回落成裸词且不漏标签',
  glitchLegacyBack === '疼' && !/<[^>]+>/.test(glitchLegacyBack),
  glitchLegacyBack);

console.log('\n[4] 技能提示、token 实测与流式遮罩');
const conf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
const build = () => promptBox.buildSystemPrompt(conf, chat, '', null, {});
promptBox.state.skillsOff = {};
const withMark = build();
promptBox.state.skillsOff = { mark: true };
const withoutMark = build();
const measuredTok = promptBox.estimateTokens(withMark) - promptBox.estimateTokens(withoutMark);
const markDef = vm.runInContext("SKILL_DEFS.find(item => item.key === 'mark')", promptBox);
t('MARK 技能提示交代 b 三种写法、两个范围、无斜向且可省略',
  withMark.includes('[文字标注技能]') && withMark.includes('0.6~2.0') && withMark.includes('0.3~1.0')
    && withMark.includes('b=1.5') && withMark.includes('b=h2') && withMark.includes('b=v2')
    && withMark.includes('0~2.5') && withMark.includes('0.5~4') && withMark.includes('没有斜的')
    && withMark.includes('任意排序') && withMark.includes('界面通常是深色')
    && !withoutMark.includes('[文字标注技能]'));

/* 「N 个参数都可以省略」里那个 N 不许手抄 —— 加了新参数只改渲染器不改这句，
   模型就会照着旧数字理解能用几个参数，而且一路零报错。N 从解析器的白名单
   字符类里现数出来，两边只能一起对或一起错。 */
t('★ 提示词里「几个参数」的数目 == 解析器白名单里真实的参数个数',
  (() => {
    const cls = mediaSrc.match(/replace\(\/\(\?:\^\|\\s\)\(\[([a-z]+)\]\)/);
    if (!cls) return false;                       // 抠不到白名单就该红，不是该放过
    const CN = ['零','一','二','三','四','五','六','七','八','九','十'];
    const want = CN[cls[1].length];
    const hit = withMark.match(/([零一二三四五六七八九十]+)个参数都可以省略/);
    return !!hit && !!want && hit[1] === want;
  })(),
  '参数个数和提示词里写的对不上');
// 纵向模糊的上限不是拍脑袋定的：实测（截图对比过）v≥1.5 会把
// 汉字的横笔画糊掉、只剩竖笔画，看着像被撕成条。代码不拦（16 档对称好测），
// 靠提示词把这条实话给模型。没有断言守着的话，这句话哪天被顺手删掉都没人知道。
t('MARK 技能提示交代纵向模糊在汉字上的实测限制',
  withMark.includes('纵向模糊超过 1.5') && withMark.includes('只剩竖线')
    && withMark.includes('横向到 4 都还有表现力'),
  withMark.slice(withMark.indexOf('[文字标注技能]'), withMark.indexOf('[文字标注技能]') + 400));

/* 精确到个位的 tok 由 tests/skill-tok.test.js 集中守（2026-09-21 起）。这里的
   桩状态和那份不完全一样，estimateTokens 又带 Math.ceil，同一段提示词在两个
   桩里能差 1 —— 两处各钉一个精确值的话，改任何一条技能提示都得同时哄两个
   数字，最后必然有一个被人顺手改成"跑得过"的值。所以这里只守「别离谱」
   （真正要逮的是 765→1057 这种整段提示改了没回来更新表）。 */
t('MARK 的 tok 和实测差值一致（±1 容差，精确值由 skill-tok.test.js 守）',
  markDef && Math.abs(markDef.tok - measuredTok) <= 1,
  `表中 ${markDef && markDef.tok}，实测 ${measuredTok}`);

const masked = promptBox.maskStreamingTags('前面 [[MARK: 还没写完 | c=#8cf b=h2.7');
t('MARK 带 b 的流式半截标签被遮住',
  !masked.includes('[[MARK:') && !masked.includes('还没写完') && masked.includes('正在标注文字'),
  masked);

console.log('\n[5] 裸标签直接进历史 —— 这才是实际走得最多的那条路');
// 消息存的是 content（裸标签），渲染成 span 只发生在展示时。
// 老代码里那句 .replace(/\[\[GLITCH:…\]\]/g, '$1') 会把裸标签抹成纯词，
// 于是系统提示每轮教「写 [[GLITCH:词]]」、历史每轮示范「我从没写过」——
// 这是指令断链的同一个雷。删掉那句之后必须真的原样透传，
// 而这条路上一版没有任何断言守着（span 那条测了，裸标签这条没测）。
const rawBack = promptBox.stickerTagForApi('他说 [[GLITCH: 疼|big]] 然后 [[MARK: 轻一点 | c=#88ccff]] 收尾');
t('★ 裸 [[GLITCH:]] / [[MARK:]] 原样进历史，不被抹成纯文字',
  rawBack.includes('[[GLITCH: 疼|big]]') && rawBack.includes('[[MARK: 轻一点 | c=#88ccff]]')
    && !/<[^>]+>/.test(rawBack),
  rawBack);

console.log('\n[6] 图层混合模式 m=（2026-09-19 加的）');
const blendOf = html => { const hit = html.match(/mix-blend-mode:([^;"]+)/); return hit ? hit[1].trim() : null; };
const cssSrc = read('css/grancyan.css');

t('中文名认（PS 那套叫法）', blendOf(render('[[MARK: 光 | m=滤色]]')) === 'screen');
t('CSS 名也认', blendOf(render('[[MARK: 光 | m=screen]]')) === 'screen');
t('驼峰/下划线/大写都收下', ['m=colorDodge', 'm=color_dodge', 'm=COLOR-DODGE'].every(
  p => blendOf(render(`[[MARK: 光 | ${p}]]`)) === 'color-dodge'));
t('简写认（diff / dodge / burn / plus）',
  blendOf(render('[[MARK: 光 | m=diff]]')) === 'difference'
  && blendOf(render('[[MARK: 光 | m=burn]]')) === 'color-burn'
  && blendOf(render('[[MARK: 光 | m=plus]]')) === 'plus-lighter');
t('不写 m 就没有这一句（不是悄悄塞个 normal）', blendOf(render('[[MARK: 光 | c=#88ccff]]')) === null);

// ⚠️ 这个值会原样进 inline style，所以判据必须**反着写**：不是「挑掉我想到的几种写法」，
//    而是「除了白名单里那 17 个常量，任何东西都不许出现在 style 里」。
//    枚举攻击写法的版本被 Codex 打回过四次（见 failclosed-regex-enumeration-trap）。
const ALLOWED = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn',
  'hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity','plus-lighter'];
t('★ 混合模式的值永远来自白名单常量，绝不是用户给的那个字符串', [
  'm=red;position:fixed', 'm=screen;position:fixed;inset:0', 'm="onload=alert(1)',
  'm=banana', 'm=url(javascript:1)', 'm=expression(1)', 'm=inherit', 'm=initial', 'm=var(--x)',
  'm=screen)', 'm=SCREEN;x:1',
].every(p => {
  const html = render(`[[MARK: 光 | ${p}]]`);
  const b = blendOf(html);
  const okValue = b === null || ALLOWED.includes(b);
  // 连带检查整条 style：不许多出第二个分号分隔的陌生属性
  const style = (html.match(/style="([^"]*)"/) || [, ''])[1];
  const props = style.split(';').map(s => s.split(':')[0].trim()).filter(Boolean);
  const KNOWN = ['color','background-image','-webkit-background-clip','background-clip',
    '-webkit-text-fill-color','font-size','opacity','filter','-webkit-text-stroke','paint-order',
    'mix-blend-mode','animation'];
  /* 自定义属性（--mk-o / --mk-amp / --mk-dx …）放行，但只放 --mk- 前缀这一族：
     它们本身是惰性的（没有 keyframes 或 var() 引用就什么都不做），而且每加一个
     动效参数就得回来补一次名单的话，这条闸迟早会被人嫌烦顺手删掉。
     注意仍然是 fail-closed —— `--mk-o:red;position:fixed` 里那个 position
     会被分号切出来单独问一遍，照样红。 */
  return okValue && props.every(p2 => KNOWN.includes(p2) || /^--mk-[a-z-]+$/.test(p2));
}), '有一个非法值漏进了 style');

t('认不出来的 m 整个丢掉，别的参数照旧生效',
  (() => { const h = render('[[MARK: 光 | m=banana s=1.5]]'); return blendOf(h) === null && /font-size:1\.5em/.test(h); })());

t('data-mark-m 存的是模型原话（历史要靠它咬回去）',
  /data-mark-m="滤色"/.test(render('[[MARK: 光 | m=滤色]]')));

t('★ 混合模式能进历史回填 —— 漏了模型下轮就学不到这个参数（同指令断链那个雷）',
  (() => {
    const back = promptBox.stickerTagForApi(render('[[MARK: 光 | m=差值 c=#88ccff]]'));
    return back.includes('m=差值') && back.includes('c=#88ccff') && !/<[^>]+>/.test(back);
  })());

t('混合和渐变能叠（先算出字色再去混）',
  (() => { const h = render('[[MARK: 光 | g=#ff8ab0-#88ccff m=滤色]]');
    return blendOf(h) === 'screen' && /background-clip:text/.test(h); })());

t('★ 混合有明确的混合对象（气泡内隔离），不然深色底上看着像没生效',
  /\.bubble:has\(\.mark-text\[data-mark-m\]\)\s*\{[^}]*isolation:isolate/.test(cssSrc), '少了那条 isolation');

// 反向判据：面板下拉里的**每一个** option 都必须被解析器认出来。
// 手抄一份「应该有哪些」是没用的（抄错了两边一起错），所以从 index.html 里
// 枚举真实存在的 value，逐个丢进真渲染器问它认不认。
t('★ 面板下拉的每个选项渲染器都认（选了没效果是零报错的那种坏）', (() => {
  const sel = indexSrc.match(/<select id="fancyM"[\s\S]*?<\/select>/);
  if (!sel) return false;
  const vals = [...sel[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  if (vals.length < 10) return false;          // 下拉被删空了也要红
  return vals.every(v => ALLOWED.includes(blendOf(render(`[[MARK: 光 | m=${v}]]`))));
})(), '有选项渲染器不认');

t('面板拼标签时会带上 m=（不然下拉是个摆设）',
  /params\.push\('m=' \+ blend\)/.test(mediaSrc) && /v\('fancyM'\)/.test(mediaSrc));

t('提示词交代了混合模式，并且提醒深色底上哪几种会没效果',
  withMark.includes('图层混合模式') && withMark.includes('滤色') && withMark.includes('差值')
    && withMark.includes('深色底'));

console.log('\n[7] 动效三档 f/v/w（2026-09-22 加的）：面板 → 标签 → 渲染器 → keyframes');

/* 这一组走的是真实那条链：拿 index.html 里**真实存在**的控件（默认值、上下限、
   下拉选项全从 HTML 现读，不手抄 —— 抄错了两边一起错，判据就白设了），
   调真的 fancyTagText() 拼标签，再丢进真的渲染器，最后问 CSS 里有没有那条
   keyframes。链上断任何一环的症状都一样：面板拖了，字不动，零报错。 */
renderBox._fancyKind = 'mark';
vm.runInContext(
  mediaSrc.slice(mediaSrc.indexOf('function fancyTagText()'), mediaSrc.indexOf('function updateFancyPreview()')),
  renderBox, { filename: '12-math-media.js#fancyTagText' });

// 把面板上所有 fancy* 控件按 HTML 里的样子做成假 DOM
const panelEls = {};
for (const m of indexSrc.matchAll(/<(input|select|textarea)\b([^>]*\bid="(fancy[A-Za-z0-9]+)"[^>]*)>/g)) {
  const [, tag, attrs, id] = m;
  const at = a => { const h = attrs.match(new RegExp(`\\b${a}="([^"]*)"`)); return h ? h[1] : null; };
  if (tag !== 'select') {
    panelEls[id] = { value: at('value') || '', checked: /\bchecked\b/.test(attrs),
      min: Number(at('min')), max: Number(at('max')) };
  } else {
    const block = indexSrc.slice(m.index, indexSrc.indexOf('</select>', m.index));
    const opts = [...block.matchAll(/<option value="([^"]*)"/g)].map(o => o[1]);
    const picked = block.match(/<option value="([^"]*)"[^>]*\bselected\b/);
    panelEls[id] = { value: picked ? picked[1] : (opts[0] || ''), options: opts };
  }
}
renderBox.document.getElementById = id => panelEls[id] || null;
const PANEL_DEFAULTS = JSON.parse(JSON.stringify(panelEls));
// 每次都从 HTML 默认值重置：上一条断言留下的残留会把下一条悄悄掏空
function tagWith(over) {
  for (const k in PANEL_DEFAULTS) Object.assign(panelEls[k], PANEL_DEFAULTS[k]);
  panelEls.fancyText.value = '光';
  for (const k in over) panelEls[k].value = String(over[k]);
  return vm.runInContext('fancyTagText()', renderBox);
}
function animNames(html) {
  const hit = (html.match(/style="([^"]*)"/) || ['', ''])[1].match(/animation:([^;"]*)/);
  return hit ? hit[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean) : [];
}
const kwExists = name => new RegExp(`@keyframes\\s+${name}\\s*\\{`).test(cssSrc);

t('面板上真有这三档控件（少一个后面整组就是假绿）',
  ['fancyF', 'fancyVMode', 'fancyVA', 'fancyV', 'fancyWMode', 'fancyW'].every(id => panelEls[id]),
  Object.keys(panelEls).join(' '));

t('默认状态三档全关，标签里不出现 f=/v=/w=（一打开面板就抽抽是不能接受的）',
  !/\b[fvw]=/.test(tagWith({})), tagWith({}));

// 反向枚举：下拉里**每一个**选项都必须一路走到一条真实存在的 keyframes。
// 手抄一份"应该有哪几种"没用（抄错了两边一起错），从 HTML 里现枚举。
t('★ 位移下拉的每个选项都真能动起来，且 keyframes 在 CSS 里真存在',
  (() => {
    const opts = panelEls.fancyVMode.options.filter(Boolean);
    if (opts.length < 4) return false;                    // 下拉被删空也要红
    return opts.every(mode => {
      const names = animNames(render(tagWith({ fancyVMode: mode })));
      return names.length === 1 && kwExists(names[0]);
    });
  })(), '有选项走不到 keyframes');

t('★ 形变下拉的每个选项同理（摇摆/呼吸）',
  (() => {
    const opts = panelEls.fancyWMode.options.filter(Boolean);
    if (opts.length < 2) return false;
    return opts.every(mode => {
      const names = animNames(render(tagWith({ fancyWMode: mode })));
      return names.length === 1 && kwExists(names[0]);
    });
  })(), '有选项走不到 keyframes');

t('★ 幅度拖到滑杆上限时，标签里写的数字 == 渲染器实际动的数字（钳制表只有一份）',
  (() => panelEls.fancyVMode.options.filter(Boolean).every(mode => {
    const tag = tagWith({ fancyVMode: mode, fancyV: panelEls.fancyV.max });
    const inTag = Number((tag.match(/v=[^:\s]+:([\d.]+)/) || [])[1]);
    const html = render(tag);
    const ampHit = html.match(/--mk-amp:([\d.]+)px/);
    const real = ampHit ? Number(ampHit[1])
      : Math.hypot(Number((html.match(/--mk-dx:(-?[\d.]+)px/) || [])[1]),
                   Number((html.match(/--mk-dy:(-?[\d.]+)px/) || [])[1]));
    return Number.isFinite(inTag) && Number.isFinite(real) && Math.abs(real - inTag) < 0.02;
  }))(), '面板写的幅度和实际动的幅度不是一个数');

// 角度约定必须和 g=（渐变）一致：0 是向上、90 是向右。不一致的话模型会拿
// 渐变的角度感觉去写位移，方向全错而且错得看不出是约定问题。
t('★ 0° 往上、90° 往右（和 g= 的角度约定一致）',
  (() => {
    const up = render(tagWith({ fancyVMode: 'dir', fancyVA: 0, fancyV: 10 }));
    const right = render(tagWith({ fancyVMode: 'dir', fancyVA: 90, fancyV: 10 }));
    return /--mk-dy:-10px/.test(up) && /--mk-dx:0px/.test(up)
        && /--mk-dx:10px/.test(right) && !/--mk-dy:-?[1-9]/.test(right);
  })());

t('呼吸拖到滑杆最小值时发出的倍数仍在解析器的合法区间（不会被悄悄抬高）',
  (() => {
    const tag = tagWith({ fancyWMode: 'pulse', fancyW: panelEls.fancyW.min });
    const inTag = Number((tag.match(/w=pulse:([\d.]+)/) || [])[1]);
    const real = Number((render(tag).match(/--mk-scale:([\d.]+)/) || [])[1]);
    return inTag >= 1.02 && Math.abs(real - inTag) < 1e-9;
  })());

t('★ 闪烁+位移+形变能同时生效（三条并行，不是后面的把前面的顶掉）',
  (() => {
    const html = render(tagWith({ fancyF: 2, fancyVMode: 'float', fancyWMode: 'swing' }));
    const names = animNames(html);
    return names.length === 3 && names.every(kwExists)
      && names.includes('markFlash') && names.includes('markFloat') && names.includes('markSwing');
  })());

// 三条动画分别动 opacity / translate / rotate·scale。挤进 transform 的话
// 只有最后一条生效 —— 这是分成三个参数的全部理由，所以钉住。
t('★ 位移和形变走各自的 CSS 属性通道（都塞 transform 会只剩最后一条）',
  (() => {
    const body = cssSrc.slice(cssSrc.indexOf('@keyframes markDrift'));
    const move = body.slice(0, body.indexOf('@keyframes markSwing'));
    const wob = cssSrc.slice(cssSrc.indexOf('@keyframes markSwing'));
    return /\btranslate:/.test(move) && !/\btransform:/.test(move)
        && /\brotate:/.test(wob) && !/\btransform:/.test(wob.slice(0, wob.indexOf('@keyframes', 5) + 1 || undefined));
  })(), 'keyframes 用的是 transform，三档会互相覆盖');

t('半透明 + 闪烁：o= 没被闪烁动画盖掉（走 --mk-o 变量那条）',
  (() => {
    const html = render(tagWith({ fancyF: 2, fancyO: 0.5 }));
    return opacityOf(html) === 0.5 && animNames(html).includes('markFlash');
  })());

t('系统开「减少动态效果」时三档全停（无障碍，CSS 里得有兜底）',
  (() => {
    const i = cssSrc.indexOf('prefers-reduced-motion');
    if (i < 0) return false;
    const block = cssSrc.slice(i, i + 600);
    return /\.mark-text/.test(block) && /animation:\s*none/.test(block);
  })(), '少了 prefers-reduced-motion 兜底');

t('★ 三档都能从 HTML 咬回指令原值（回填漏了，模型会从历史学到"我没用过"）',
  promptBox.stickerTagForApi(render('[[MARK: 动 | f=2 v=120:8 w=swing:6]]'))
    === '[[MARK: 动 | f=2 v=120:8 w=swing:6]]',
  promptBox.stickerTagForApi(render('[[MARK: 动 | f=2 v=120:8 w=swing:6]]')));

t('提示词交代了三档新参数，且角度约定和 g= 写的是同一套',
  withMark.includes('f=') && withMark.includes('v=') && withMark.includes('w=')
    && /0\s*是?向上/.test(withMark.slice(withMark.indexOf('[文字标注技能]'))),
  withMark.slice(withMark.indexOf('f、v、w'), withMark.indexOf('f、v、w') + 300));

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
