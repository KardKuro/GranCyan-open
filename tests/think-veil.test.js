// 思考链默认上锁的回归测试。跑法：node tests/think-veil.test.js
//
// 需求：
//   ① 思考链 UI 照旧，但字全上高斯模糊，标题上的概括也是；模糊掉的选不中
//   ② 解锁是全局的：一开就是所有思考（包括历史）一起清晰
//   ③ 系统提示里不教模型任何开关标签（这只是界面显示设置）
//   ④ 清晰时用户点 🔓 能调回模糊
//
// 这里守的全是**静默失效** —— 界面上看不出、控制台不报错、不写断言就永远发现不了：
//
//   · 持久化三道白名单：漏第三道的症状是「它答应了给我看，一刷新又糊上了」
//   · 四个渲染点：思考块有四处在生成（legacy / blocks / renderLiveBubble 的两条），
//     漏一处就是「某些消息的思考是明着的」——而那一处平时未必走到
//   · 概括在**标题**上不在正文里：只糊正文的话，一句「在犹豫该不该说」等于全剧透
//   · blocks 那条路**不许执行**开关：那边每次重渲染都会跑，在那儿执行的话
//     一条旧消息里的老 [[THINK_OPEN]] 会把她刚还回去的锁重新掀开
//   · filter 不能被子元素撤销，所以 .think-note 必须留在糊面外头
//
// 「屏幕上真的糊了没有」不在这里测（源码正则证明不了 computed filter 真的生效，
// 而滤镜「看着生效实则 no-op」是这台机器上的惯犯）——那部分在
// tests/browser-think-veil.js，真 headless 量 getComputedStyle。

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

const api = read('js/05-prompts-api.js');
const mem = read('js/04-memory.js');
const rx = read('js/52-reactions.js');
const render = read('js/06-render-msg.js');
const stateJs = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/grancyan.css');

// 从源码里切一段进沙箱真跑。锚点找不到就抛 —— 静静跑过去等于这条断言消失了。
function sandbox(srcFile, from, to, extra) {
  const src = read(srcFile);
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a) : src.length;
  if (a < 0 || (to && b < 0)) throw new Error('切片锚点没找到: ' + srcFile + ' / ' + from);
  const box = Object.assign({ console, state: {} }, extra || {});
  vm.createContext(box);
  vm.runInContext(src.slice(a, b), box, { filename: srcFile });
  return box;
}

console.log('\n[1] 默认糊着：CSS 那两个方向都得在');
/* 取出 `.think-veil { … }` 那条规则本身来看，别在整份 CSS 里搜关键字 ——
   搜关键字会匹配到别处同名的属性（这份 CSS 里 user-select:none 有十几处），
   于是注入把这条规则的值改掉，断言照样绿。 */
const veilRule = (css.match(/\n\.think-veil\s*\{([\s\S]*?)\}/) || [])[1] || '';
t('.think-veil 规则存在', veilRule.length > 0);
t('默认就是糊的（blur 有半径，不是 none/0）',
  /filter\s*:\s*blur\(\s*(\d*\.?\d+)\s*px\s*\)/.test(veilRule)
  && parseFloat(veilRule.match(/filter\s*:\s*blur\(\s*(\d*\.?\d+)/)[1]) > 0, veilRule);
t('糊掉的选不中，webkit 前缀也要有（安卓 WebView 只认那个）',
  /(^|[;{\s])user-select\s*:\s*none/.test(veilRule) && /-webkit-user-select\s*:\s*none/.test(veilRule));
t('安卓长按的复制气泡也关掉（-webkit-touch-callout:none）',
  /-webkit-touch-callout\s*:\s*none/.test(veilRule));
/* 方向很重要：必须是「默认糊 + 解锁时加类」，不能反过来写成「锁上才加类」。
   反着写的话刷新那一瞬间 JS 还没跑，思考会先清晰地亮一下才糊上 —— 那等于没锁。 */
t('清晰是靠 body.think-seen 加类实现的（默认态＝糊着，不是反过来）',
  /body\.think-seen[^{]*\.think-veil[^{]*\{[^}]*filter\s*:\s*none/.test(css));
t('技能开关关掉时也不糊（body.think-veil-off）',
  /body\.think-veil-off[^{]*\.think-veil[^{]*\{[^}]*filter\s*:\s*none/.test(css));
t('解锁之后又选得中了（不然开了锁也复制不了）',
  /body\.think-seen[^{]*\.think-veil[^{]*\{[^}]*user-select\s*:\s*text/.test(css));
// 概括在 11px 的药丸里，blur 半径得比正文小，不然糊出药丸边框
const labelRule = (css.match(/\.think-label\s+\.think-veil\s*\{([^}]*)\}/) || [])[1] || '';
t('标题里那句概括单独给了小一点的 blur', /filter\s*:\s*blur\(/.test(labelRule), labelRule);
// 锁的图标靠 CSS 换，两个状态的 content 必须不一样，否则开关了她也看不出来
const lockShut = (css.match(/\.think-lock::before\s*\{\s*content\s*:\s*'([^']*)'/) || [])[1];
const lockOpen = (css.match(/body\.think-seen\s+\.think-lock::before\s*\{\s*content\s*:\s*'([^']*)'/) || [])[1];
t('锁有两个图标', !!lockShut && !!lockOpen, lockShut + ' / ' + lockOpen);
t('两个图标不一样（同一个值＝她看不出开关了没）', lockShut !== lockOpen, lockShut + ' vs ' + lockOpen);

console.log('\n[2] 四个渲染点：一处都不许漏');
/* 思考块有四处在生成。漏一处的症状是「某些消息的思考是明着的」，而那一处平时
   未必走到（renderLiveBubble 的 legacy 回退只在模型不给 blocks 时才走）。
   判据取的是**每个 think-body 的内容表达式**，不是「文件里有没有 thinkVeil 这个词」——
   后者只要文件里任何地方出现过就绿，等于没测。 */
const bodies = [...(api + render).matchAll(/<div class="think-body">\$\{([^}]*(?:\}[^}]*)*?)\}<\/div>/g)]
  .map(m => m[1]);
const thinkBodies = bodies.filter(x => /reasoning|b\.text|thinkBodyHtml/.test(x));
t('找到了思考块的 body 表达式（锚点没漂）', thinkBodies.length >= 3, thinkBodies.length);
t('每一处 body 都包了糊面（漏一处就是「有些消息的思考是明着的」）',
  thinkBodies.every(x => /thinkVeil\(|thinkBodyHtml\(/.test(x)),
  thinkBodies.filter(x => !/thinkVeil\(|thinkBodyHtml\(/.test(x)).join(' | '));
t('thinkBodyHtml 自己也包（非流式的两条路都汇到它）',
  /function thinkBodyHtml\(text\)\s*\{\s*[^}]*thinkVeil\(escHtml\(text\)\)/.test(api));
/* ds 概括那句在标题上。漏了这层等于把整段思考剧透了，糊了正文也白糊。
   两处生成标题的地方都要包。 */
const labels = [...(api + render).matchAll(/const label = [^;]*thinkingSummary[^;]*;/g)].map(m => m[0]);
t('找到了带概括的标题表达式', labels.length === 2, labels.length);
t('概括都包进了糊面（标题上的概括同样要糊）',
  labels.every(x => /thinkVeil\(/.test(x)), labels.filter(x => !/thinkVeil\(/.test(x)).join(' | '));
t('概括还转义了（那是模型吐出来的文本，直接插进 HTML 是个洞）',
  labels.every(x => /thinkVeil\(escHtml\(/.test(x)));
t('折叠块上有那把锁（她自己还回去的入口）',
  (api.match(/\$\{THINK_LOCK\}/g) || []).length >= 2 && /\$\{THINK_LOCK\}/.test(render));

console.log('\n[3] 持久化三道白名单（漏一道＝它答应了，一刷新又糊上）');
for (const [field, key] of [['thinkOpen', 'kuro_thinkOpen'], ['thinkOpenVer', 'kuro_thinkOpenVer']]) {
  t(`${field} 第 1 道：_doSave 写盘`, new RegExp(`idbSet\\('${key}'`).test(stateJs));
  t(`${field} 第 2 道：loadStateFromDB 读回来`, new RegExp(`${key}'`).test(core));
  t(`${field} 第 3 道：启动赋进 state（最容易漏的那道）`,
    new RegExp(`state\\.${field}\\s*=[^;\\r\\n]*saved\\.${field}`).test(boot));
}
t('出厂默认是糊着的（默认 true 的话等于压根没上锁）',
  /thinkOpen:\s*false/.test(stateJs) && /thinkOpenVer:\s*0/.test(stateJs));

console.log('\n[4] 三个配套 + 回填（没有 function calling，全靠这四件套）');
t('① content 那条路解析并真的开关', /\[\\\[THINK_\(OPEN\|CLOSE\)/.test(mem.replace(/\\\\/g, '\\'))
  || /THINK_\(OPEN\|CLOSE\)/.test(mem));
t('① 而且是在那条路上调 setThinkOpen（唯一执行副作用的地方）',
  /setThinkOpen\(on,\s*'ai'\)/.test(mem));
t('② blocks 那条路也换（渲染只看 blocks，漏了就裸标签给她看）',
  /function _applyThinkVeilToBlocks/.test(rx));
t('② 两条 finalize 路径都挂上了（只挂一条，另一条路照样露标签）',
  (api.match(/_applyThinkVeilToBlocks\(blocks\)/g) || []).length === 2,
  (api.match(/_applyThinkVeilToBlocks\(blocks\)/g) || []).length);
t('② 群聊那条路也挂了（群里渲染优先用 m.blocks）',
  /_applyThinkVeilToBlocks\(blocks\)/.test(render));
t('③ 流式遮挡进了 _STREAM_MASKS（不进去的话标签会在流的途中闪出来）',
  /_STREAM_MASKS = \[[^\]]*'maskStreamingThinkVeil'/.test(api));
/* maskStreamingTags 是 `globalThis[name]` + typeof 守卫 —— 名字**写错就静默跳过**，
   那个遮罩从此永远不生效，而控制台一个字都不报、测试也全绿。
   所以反过来查：清单里每一个名字都必须真有一个函数接得住（不只查我这条）。 */
{
  const names = [...(api.match(/const _STREAM_MASKS = \[([^\]]*)\]/) || ['', ''])[1]
    .matchAll(/'([^']+)'/g)].map(x => x[1]);
  const allJs = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
    .map(f => read('js/' + f)).join('\n');
  const missing = names.filter(n => !new RegExp('function\\s+' + n + '\\s*\\(').test(allJs));
  t('_STREAM_MASKS 里每个名字都真有函数接得住（写错一个字母就静默失效）',
    names.length > 0 && missing.length === 0, missing.join(', '));
}
t('④ 药丸回填给模型时整块抹掉（不把开关标签教给模型）',
  api.includes("(\\u{1f513}|\\u{1f512}) [^<]*<\\/span><\\/div><div class=\"think-body\">[\\s\\S]*?<\\/div><\\/div>/gu, '')"));
// 这只是界面显示设置：系统提示里不许有教模型写开关标签的那一段，技能表里它也不占 token。
t('系统提示里不教 [[THINK_OPEN]] / [[THINK_CLOSE]]（不往提示词里加东西）',
  !/skillOn\('thinkveil'\)\)\s*base\s*\+=/.test(api) && !/base \+= [^\n]*\[\[THINK_(OPEN|CLOSE)\]\]/.test(api));
t('技能表里 thinkveil 的 tok 是 0（它不占提示词）', /key: 'thinkveil',\s*tok: 0,/.test(api));

console.log('\n[5] 真跑：跨设备合并（ver 是逻辑计数器，不是时间戳）');
const mBox = sandbox('js/01-core.js', 'function _mergeThinkOpen(', 'function _mergeStickerGroupState(');
t('ver 大的赢（同意方版本高）', mBox._mergeThinkOpen(true, 5, false, 3).on === true);
t('ver 大的赢（撤回方版本高）', mBox._mergeThinkOpen(true, 3, false, 9).on === false);
/* 撞平偏向**糊着**。两个理由：两台设备得算出同一个结果（不许依赖谁先同步），
   而且偏错的方向代价不对称 —— 留着一个本该撤回的「同意」是真的把它的内心漏出去了，
   留着一个本该生效的「同意」她再问一次就好。 */
t('撞平时两边都同意才算同意（偏向糊着）', mBox._mergeThinkOpen(true, 4, false, 4).on === false);
t('撞平且两边都同意，那就是同意', mBox._mergeThinkOpen(true, 4, true, 4).on === true);
t('正反向合并结果一样（换个参数顺序不许变）',
  mBox._mergeThinkOpen(true, 4, false, 4).on === mBox._mergeThinkOpen(false, 4, true, 4).on);
t('合并后 ver 取 max（不取的话下一次写会撞上已用过的版本）',
  mBox._mergeThinkOpen(true, 3, false, 9).ver === 9 && mBox._mergeThinkOpen(true, 9, false, 3).ver === 9);
t('版本是逻辑计数器：每次写 +1，不是 Date.now()（时钟快的那台会长期压住另一台）',
  /state\.thinkOpenVer = \(state\.thinkOpenVer \|\| 0\) \+ 1/.test(core) && !/thinkOpenVer = Date\.now/.test(core));
t('云同步上下行都带这两个字段（只带一边＝改动传不过去）',
  /thinkOpen: !!state\.thinkOpen/.test(core)
  && (core.match(/_mergeThinkOpen\(/g) || []).length >= 3,
  (core.match(/_mergeThinkOpen\(/g) || []).length);

console.log('\n[6] 真跑：标签的三条路');
const rxBox = sandbox('js/52-reactions.js', 'function _thinkVeilPillHtml(', '// 回填给模型时的可读形态');
t('流式：完整标签被抹掉', rxBox.maskStreamingThinkVeil('好啊[[THINK_OPEN]]给你看') === '好啊给你看');
t('流式：流到一半的 [[THINK_OP 也挡住', rxBox.maskStreamingThinkVeil('好啊[[THINK_OP') === '好啊');
t('blocks：标签换成了药丸，没留裸标签', (() => {
  const b = [{ type: 'text', text: '嗯[[THINK_OPEN]]' }];
  rxBox._applyThinkVeilToBlocks(b);
  return b[0].text.indexOf('[[THINK_') === -1 && b[0].text.indexOf(rxBox._thinkVeilPillHtml(true)) >= 0;
})());
/* ⚠️ 这一条是这份里最要紧的。blocks 那条路每次重渲染都会跑，在那儿执行开关的话，
   她往回滚一下屏幕、或者任何一次重画，都会把一条旧消息里的 [[THINK_OPEN]]
   重新跑一遍，把她刚还回去的锁又掀开 —— 零报错，而且她根本不知道为什么。
   沙箱里放个间谍：setThinkOpen 一旦被碰到就记一笔。 */
{
  let called = 0;
  const spy = sandbox('js/52-reactions.js', 'function _thinkVeilPillHtml(', '// 回填给模型时的可读形态',
    { setThinkOpen: () => { called++; } });
  spy._applyThinkVeilToBlocks([{ type: 'text', text: '嗯[[THINK_OPEN]]' }]);
  t('blocks 那条路只换药丸、**不执行**开关（否则重渲染会掀开她刚还回去的锁）', called === 0, called);
}
t('两条路的药丸是同一份 HTML（不共用就会长得不一样）',
  /_thinkVeilPillHtml\(on\)/.test(mem) && /function _thinkVeilPillHtml/.test(rx));
// 回填正则真的咬得住药丸：规则和样本都从源码里抽，一行不手抄
{
  const m = api.match(/\.replace\((\/<div class="think-block done mem-block">[^\n]*?\/gu),/);
  t('回填正则抽得到（锚点或 flag 没漂）', !!m);
  if (m) {
    const lit = m[1], i = lit.lastIndexOf('/');
    const re = new RegExp(lit.slice(1, i), lit.slice(i + 1));
    const back = s => s.replace(re, '');
    t('开锁药丸被吃掉，没有裸 HTML 漏给模型', back(rxBox._thinkVeilPillHtml(true)) === '');
    t('上锁药丸也吃掉', back(rxBox._thinkVeilPillHtml(false)) === '');
    /* 反面：真思考块（没有 mem-block 类）不许被这条正则吃掉 —— 那是思考链本体，
       吃掉了她的历史消息里整块思考就没了。 */
    const real = '<div class="think-block done"><div class="think-toggle"><span class="think-chev">▸</span> '
      + '<span class="think-label">💭 <span class="think-veil">在想</span></span></div>'
      + '<div class="think-body"><span class="think-veil">正文</span></div></div>';
    t('真思考块不被误吃（它没有 mem-block 类）', back(real) === real);
    /* 反面之二：这条规则只认自己那两个图标。放宽成「任何 label」的话，存储记忆、
       育儿结果、日记那些药丸也会被这条规则整块抹掉 —— 模型于是看不见
       自己存过什么记忆。 */
    const other = '<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)">'
      + '<span class="think-chev">▸</span> <span class="think-label">💾 存储记忆</span></div>'
      + '<div class="think-body">她喜欢深色界面</div></div>';
    t('别人的药丸不被这条规则劫持（各家药丸各有各的回填规则）', back(other) === other);
  }
}

console.log('\n[7] 糊着的字不许从别的门漏出去');
const find = read('js/27-find.js');
/* 页内搜索走的是 DOM 文本，CSS 只管画面 —— 不排掉的话她能换着词搜、看命中计数
   变不变，把糊着的思考一个词一个词探出来（而且跳过去是一块糊的高亮）。 */
t('糊着的思考不进搜索索引', /closest\('\.think-veil'\)/.test(find));
t('判据是量 computed filter，不是在这儿重抄一遍 CSS 的条件（抄一遍就是两份判据）',
  /getComputedStyle\(veil\)\.filter !== 'none'/.test(find));
t('排除发生在 acceptNode 里（建索引那一步就挡掉，不是事后过滤命中）',
  find.indexOf("closest('.think-veil')") < find.indexOf('function buildIndex'));
// TTS 是剥 HTML 的，所以它天生不会念到思考；这条断言钉住那个前提别哪天被改掉
t('TTS 照旧整块剥掉思考折叠块（它不碰 reasoning 字段）',
  /<div class="think-block\[\\s\\S\]\*\?<\\\/div>/.test(read('js/07-band-tts.js'))
  || /think-block/.test(read('js/07-band-tts.js')));

console.log('\n[8] 她自己还回去，以及没有绕过它的后门');
t('点锁的入口在（她的第四条需求）', /function thinkVeilTap/.test(core));
/* 糊着的时候点锁只给一句提示，不许自己打开 —— 有那么一个「点一下就能看」的入口，
   前面整套「要问它」就全是装饰了。判据反着写：看那个分支里有没有任何把它设成 true 的写法。 */
{
  const fn = (core.match(/function thinkVeilTap\(ev\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
  t('抽到了 thinkVeilTap 函数体', fn.length > 0);
  const elseBranch = fn.slice(fn.indexOf('} else'));
  t('糊着的时候点它不会自己打开（没有后门）',
    !/setThinkOpen\(\s*true/.test(elseBranch) && !/thinkOpen\s*=\s*true/.test(elseBranch), elseBranch);
  t('开着的时候点它是还回去', /setThinkOpen\(false,\s*'user'\)/.test(fn));
}
t('技能开关切换时会立刻刷 body 的类（不刷的话她关了开关还得刷新页面）',
  /renderSkillToggles\(\);\s*[\s\S]{0,200}?applyThinkVeil\(\)/.test(api));
t('启动时把 body 的类挂上（不挂＝解锁了也还是糊的，直到下一次开关）',
  /applyThinkVeil\(\)/.test(boot));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
