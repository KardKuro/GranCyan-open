// 表情包分组（stickers-packs/ 一个文件夹一栏 + 用户自建的分组）和消息 emoji 标注的回归测试。
// 跑法：node tests/sticker-groups.test.js
//
// 这里守的全是**静默失效**——界面上看不出、控制台不报错、断言不写就永远发现不了：
//
//   ① 持久化三道白名单：新 state 字段要在 _doSave / loadStateFromDB / 启动赋值块各写一遍，
//      漏第三道最常见，症状是「建的分组当场好用，一刷新全没了」。
//   ② 给 AI 加能力的三个配套：解析（content）+ blocks 路径再走一遍 + 流式遮挡 + 历史回填。
//      blocks 那条最容易自以为绕过去，漏了就是 [[REACT:]] 裸在气泡里给用户看。
//   ③ 两处扫描规则必须是同一份：server 实时列目录 / build.ps1 冻进 APK。
//      各写一套的话，同一个包在电脑和手机上张数不一样，而两边代码单看都对。
//   ④ PS 5.1 的 ConvertTo-Json 会把单元素数组写成对象。现在正好只有一个包 ——
//      用它生成 packs.json 就是「电脑上好好的，APK 里整栏消失」。
//
// 「画出来对不对」不在这里测（正则断言证明不了 DOM 真的有那一栏），
// 那部分在 tests/browser-sticker-groups.js，真 headless 跑。

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, mergeCheck = Promise.resolve();
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

const stk = read('js/10-stickers-voice.js');
const mm = read('js/12-math-media.js');
const api = read('js/05-prompts-api.js');
const mem = read('js/04-memory.js');
const rx = read('js/52-reactions.js');
const render = read('js/06-render-msg.js');
const stateJs = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const html = read('index.html');
const server = read('server.js');
const buildPs = read('android/build.ps1');
const scan = read('scripts/sticker-packs.js');

console.log('\n[1] 磁盘包：一个文件夹一栏');
t('扫描逻辑单独成模块（server 和打包脚本共用一份）', /function scanPacks\(rootDir\)/.test(scan));
t('server 的路由调的就是这个模块，没有自己再写一套',
  /require\('\.\/scripts\/sticker-packs'\)\.scanPacks\(/.test(server)
  && !/readdirSync\(STK_PACK_DIR/.test(server));
t('打包脚本也调它（而不是用 ConvertTo-Json 拼）',
  /node.*scripts\\sticker-packs\.js/.test(buildPs) && !/ConvertTo-Json[^\n]*\$packs/.test(buildPs));
t('包目录整个拷进 assets', /assets\\stickers-packs/.test(buildPs));
t('`_` 开头的是包自己的资产（图标），不当表情列出来', /startsWith\('_'\)/.test(scan));
t('pack.json 全部字段可选（丢个文件夹进去就能用）',
  /catch \(e\) \{\}/.test(scan) && /meta\.name \|\| id/.test(scan));
t('前端两个来源都拉：APK 里的快照 + 电脑实时列目录',
  /stickers-packs\/packs\.json/.test(stk) && /\/api\/sticker-packs/.test(stk));
t('前端拿到的不是数组时当空处理（PS 那个单元素退化坑的兜底）',
  /Array\.isArray\(g\.packs\) \? g\.packs : \[\]/.test(stk));

console.log('\n[2] 合并与归类的键必须是同一套');
// 两边算法漂了的症状：分组里凭空少图，而两处代码单看都对
// 键用**文件名**不用 name：name 去了扩展名，同一个包里 爱心.gif / 爱心.png 会撞成一个
t('loadStickers 里包的表情按「包名/文件名」去重，不跟收藏抢名字',
  /source === 'pack' \? `pack:\$\{s\.pack\}\/\$\{s\.file\}` : s\.name/.test(stk));
t('归类用的 stickerKey 和它是同一个算法',
  /function stickerKey\(s\) \{[\s\S]*?source === 'pack' \? `pack:\$\{s\.pack\}\/\$\{s\.file\}` : s\.name/.test(mm));
t('包里的表情不混进「自带表情库」那一栏（单开一栏的意思是只在那一栏）',
  /function _libStickers\(\)[^\n]*s\.source !== 'pack'/.test(mm));
// 存储键带了包名、发送协议只有名字的话，收藏里同名的那张会把包里的顶掉 —— 点 A 发出 B
t('包里的表情一律用「包id/文件名」引用，生成和解析是同一套',
  /function stickerRef\(s\)/.test(mm) && /function findSticker\(ref\)/.test(mm)
  && /const s = findSticker\(name\);/.test(mm)
  && /sendLocalSticker\(\$\{jsAttr\(stickerRef\(s\)\)\}\)/.test(mm)
  && /source === 'pack' \? `\$\{s\.pack\}\/\$\{s\.file\}` : s\.name/.test(mm));
t('给模型的清单也用同一套引用（它照抄清单，清单写错它就写错）',
  /stickerRef\(s\) : s\.name\)/.test(api));
t('包的元信息和表情列表由同一轮原子落地（标签栏和格子不能各画各的）',
  /_stickerPacks = packs\.packs;/.test(stk));
t('这一轮也负责重画标签栏（新文件夹不重画就点不进去）',
  /renderStickerTabs === 'function'\) renderStickerTabs\(\)/.test(stk));

// 用户画的那批在 stickers/ 和云端各有一份同名的。云端先到的话全被归进「收藏」，自带库空掉。
// 真跑一遍 loadStickers（四个来源全换成桩），看同名的那张最后落在哪一栏。
{
  const src = stk.match(/(async function loadStickers\(\) \{[\s\S]*?\r?\n\})/)[1];
  const sb = { console: { log() {} }, _stickerTab: 'lib', _stickerList: [], _stickerPacks: [], _cloudStickerState: null };
  vm.createContext(sb);
  vm.runInContext(`let _stickerLoadGen = 0;
    const loadCloudStickers = async () => ({ items: [
      { name: 'happy', file: 'happy.png', source: 'cloud' },
      { name: 'onlycloud', file: 'onlycloud.png', source: 'cloud' }], state: { ok: true } });
    const loadServerStickers = async () => [
      { name: 'happy', file: 'happy.png', custom: false, source: 'server' },
      { name: 'onlycloud', file: 'onlycloud.png', custom: true, source: 'server' }];
    const loadBuiltinStickers = async () => [];
    const loadPackStickers = async () => ({ packs: [], items: [] });
    ${src}
    globalThis.__run = loadStickers;
    globalThis.__list = () => _stickerList;`, sb);
  mergeCheck = sb.__run().then(() => {
    const list = sb.__list();
    const happy = list.find(s => s.name === 'happy'), onlycloud = list.find(s => s.name === 'onlycloud');
    t('电脑自带库和云端同名时，归自带库（不被抢进收藏）', happy && happy.source === 'server' && happy.custom === false);
    t('收藏和云端同名时，仍以云端那份为准', onlycloud && onlycloud.source === 'cloud');
  });
}

console.log('\n[3] 分组数据的三道白名单（漏一道就活不过刷新）');
for (const [name, field] of [['分组清单', 'stickerGroups'], ['归属表', 'stickerGroupOf'],
                             ['版本计数器', 'stickerGroupsVer'], ['存活表', 'stickerGroupOps']]) {
  t(`${name} 写盘`, new RegExp(`idbSet\\('kuro_${field}'`).test(stateJs));
  t(`${name} 读盘`, new RegExp(`${field}:\\s*(Number\\()?await g\\('kuro_${field}'`).test(core));
  t(`${name} 启动时赋进 state（第 3 道，最容易漏）`, new RegExp(`state\\.${field}\\s*=[^;\\r\\n]*saved\\.${field}`).test(boot));
  t(`${name} 跟着账号云同步`, new RegExp(`${field}: state\\.${field}`).test(core));
}
// 分组会删，备注几乎不删 —— 所以不能照抄 stickerNotes 那套「本地优先整包合并」：
// 那样这台删掉的分组会被另一台的旧值原样送回来复活，而且删除永远传不出去
t('分组和归属都走合并函数，不是整包覆盖',
  /function _mergeStickerGroupState\(local, cloud\)/.test(core) && /function _mergeStickerGroupOf\(a, b\)/.test(core)
  && (core.match(/_mergeStickerGroupOf\(/g) || []).length >= 3
  && (core.match(/_mergeStickerGroupState\(/g) || []).length >= 3
  && !/stickerGroupOf = Object\.assign\(/.test(core));
// 版本必须是逻辑计数器。用 Date.now() 的话，一台机器时钟快一年就能长期压住另一台，
// 它之后所有真实的改名/移组/删除全都输 —— favGroups 当年就踩过（合并那头的注释还在）
t('版本是逻辑计数器，不是墙钟', /function _bumpGroupVer\(\)/.test(mm)
  && /state\.stickerGroupsVer = \(state\.stickerGroupsVer \|\| 0\) \+ 1/.test(mm)
  && !/t: Date\.now\(\)/.test(mm.split('function _bumpGroupVer')[1] || ''));
t('删除写进 ops 墓碑，条目本身留着', /_markGroup\(id, false, 'd'\)/.test(mm) && /_setGroupOf\(k, null\)/.test(mm));
// 墓碑一过期，离线超过那个期限的设备一上线就会把删掉的分组原样推回来
t('墓碑不设过期（量级才几十条，过期反而会让删除复活）', !/_GROUP_TOMB_TTL/.test(core) && !/TOMB_TTL/.test(mm));
t('归属值带逻辑版本，且老的裸字符串格式还认',
  /typeof v === 'string' \? v : \(v\.g \|\| null\)/.test(mm)
  && /\{ g: gid \|\| null, v: _bumpGroupVer\(\) \}/.test(mm));
t('存活判定走 ops 表（a >= d），不是看条目上的 deleted 字段',
  /function _groupAlive\(id, isPack\)/.test(mm) && /\(o\.a \|\| 0\) >= \(o\.d \|\| 0\)/.test(mm)
  && !/g\.deleted/.test(mm));
t('上行把 ops 和版本也传过去（不然另一台判不出存活）',
  /stickerGroupsVer: state\.stickerGroupsVer/.test(core) && /stickerGroupOps: state\.stickerGroupOps/.test(core));

console.log('\n[4] 表情列表给 AI 看的时候不许截掉整栏');
// 中间允许夹一道 .filter(forAi)（「不给 AI 用」的先滤掉再截，见 tests/sticker-off.test.js）
t('按栏分行报，而不是对整个列表一刀切前 30 个',
  /_packStickers\(p\.id\)(\.filter\(forAi\))?\.slice\(0, 24\)/.test(api)
  && /_stickerList\.filter\(s => s\.source !== 'pack'\)(\.filter\(forAi\))?\.slice\(0, 30\)/.test(api)
  && !/_stickerList\.slice\(0, 30\)\.map/.test(api));

console.log('\n[5] emoji 标注：三个配套一个都不能少');
t('模块挂进页面了', /<script src="\.\/js\/52-reactions\.js"><\/script>/.test(html));
t('① 解析：processAiCommands 认 [[REACT:]]', /\[\[REACT:/.test(mem) && /applyAiReaction\(chat, studyCtx/.test(mem));
t('② blocks 路径单独再走一遍', /function _applyReactToBlocks\(blocks\)/.test(rx));
t('  finalize 两条路都调了它（正常 + 多变体）',
  (api.match(/_applyReactToBlocks\(blocks\)/g) || []).length === 2);
t('  群聊/流式那条路也调了', /_applyReactToBlocks\(blocks\)/.test(render));
t('  blocks 那边只抹标签不重复执行（副作用已经在 content 那条路做过了）',
  /只抹不执行/.test(rx) && !/addAiReaction/.test(rx.split('function _applyReactToBlocks')[1].split('\n}')[0]));
t('③ 流式遮挡函数在，且登记进了名单',
  /function maskStreamingReact\(text\)/.test(rx) && /'maskStreamingReact'/.test(api));
t('④ 历史回填：模型看得见消息上已有的标注', /function reactionsForApi\(m\)/.test(rx)
  && /reactionsForApi === 'function'\) content \+= reactionsForApi\(m\)/.test(api));
// ⚠️ 这条原本是 `/tok: 245,/` —— 名字讲「是实测值」，实现却是 grep 源码里有没有 245
//    这个字。任何人改**任何一条**技能的提示词文本，estimateTokens 的取整都会让别的
//    条目漂 ±1，于是这里假红（2026-09-21 实际发生过一次）。
//    tok 到底准不准，改由 tests/skill-tok.test.js 真量一遍集中守着。
t('技能开关有 react 这一条，且 tok 是个具体数字',
  /\{ key: 'react',\s+tok: \d+,/.test(api));
t('提示里说清了历史里那行是只读说明，别照着写（指令断链的同款教训）',
  /只读说明/.test(api.split("skillOn('react')")[1].slice(0, 700)));

console.log('\n[6] 标注贴在哪、贴给谁');
t('贴在「它正在回复的那条用户消息」上，不让模型自己数第几条',
  /studyCtx && studyCtx\.userTurnId/.test(rx));
// 昵称不能当身份：群里两个模型可以同名（第二个就贴不上了），一个模型改名还是同一个它
t('去重认的是模型 id 不是昵称', /r\.id != null && id != null \? String\(r\.id\) === String\(id\)/.test(rx)
  && /const id = conf && conf\.id != null \? conf\.id : null;/.test(rx));
t('老记录没有 id 时才退回按昵称比', /: \(r\.who \|\| ''\) === \(who \|\| ''\)/.test(rx));
t('记了是谁贴的（群聊里几个模型得分得清）', /who: who \|\| 'AI'/.test(rx));
t('药丸行两种消息都渲染（用户的和 AI 的）',
  (render.match(/renderReactions === 'function' \? renderReactions\(m\)/g) || []).length === 2);
t('容器一直在 DOM 里（贴第一个 emoji 不用整条重画）',
  /id="react-row-\$\{m\.id\}"/.test(rx) && /_refreshReactionRow/.test(rx));
t('空的时候模板里不许有多余空白（有的话 :empty 失效，每条消息底下多一条空行）',
  /`<div class="react-row" id="react-row-\$\{m\.id\}">\$\{groups\.map/.test(rx));
t('手机端有长按入口（hover 出来的操作条在手机上点不到）',
  /function ctxReactMsg\(ev\)/.test(read('js/13-trash-ctx-ui.js'))
  && /ctxReactMsg\(event\)/.test(html));
t('长按入口先量位置再关菜单（反了的话浮层会飞到屏幕左上角）',
  /getBoundingClientRect\(\) : null;[\s\S]{0,200}closeMsgContextMenu\(\)/.test(read('js/13-trash-ctx-ui.js')));


/* ── 真跑一遍，而不是对着源码做正则 ────────────────────────────────
   下面这两组断言原来是查「源码里有没有这段文字」，故障注入当场打脸：
   把函数体掏空、只留函数名和调用点，两条断言照样全绿（红 0）。
   所以这里用 vm 把那几个纯函数抠出来真执行 —— 它们只依赖 state 和 _stickerList，
   抠得出来。行为对不对，只有让它算一遍才知道。 */
const _cnt = a => (a || []).length;
function sandbox(srcFile, from, to, extra) {
  const src = read(srcFile);
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a) : src.length;
  if (a < 0 || (to && b < 0)) throw new Error('切片锚点没找到: ' + srcFile + ' / ' + from);
  const box = Object.assign({ console, state: { stickerGroupOf: {}, stickerGroups: [] }, _stickerList: [] }, extra || {});
  vm.createContext(box);
  vm.runInContext(src.slice(a, b), box, { filename: srcFile });
  return box;
}

console.log('\n[7] 真跑：撞名时的引用 / AI 标注去重');

const skBox = sandbox('js/12-math-media.js', 'function stickerKey(s) {', 'function _stickerTabDefs()');
skBox._stickerList = [
  { name: '爱心', file: '爱心.png', source: 'server', custom: true },
  { name: '爱心', file: '爱心.gif', source: 'pack', pack: 'demo' },
  { name: '思考', file: '思考.gif', source: 'pack', pack: 'demo' },
];
// 包里的一律带前缀 —— 「撞名才加」那版被 Codex 打回来了：引用要在历史里躺很久，
// 含义不能随「当时列表里撞没撞名」而改变（今天短名字指收藏，明天加了个同名的包就改指包里那张）
t('包里的表情一律带包前缀 + 完整文件名', skBox.stickerRef(skBox._stickerList[1]) === 'demo/爱心.gif',
  skBox.stickerRef(skBox._stickerList[1]));
t('不撞名的包表情也照样带前缀（含义不随列表漂移）',
  skBox.stickerRef(skBox._stickerList[2]) === 'demo/思考.gif', skBox.stickerRef(skBox._stickerList[2]));
t('收藏/自带库仍然写名字（它们本来就按名字存，改了老消息全废）',
  skBox.stickerRef(skBox._stickerList[0]) === '爱心');
t('带前缀的引用查回来的是包里那张，不是排在前面的同名收藏',
  (skBox.findSticker('demo/爱心.gif') || {}).source === 'pack');
t('短名字仍然查得到（老消息不能因为这次改动失效）',
  (skBox.findSticker('爱心') || {}).name === '爱心');
// 同一个包里 爱心.png 和 爱心.gif：这两张必须各回各家。只比 stickerKey 不够 ——
// 要走完 stickerRef → findSticker 一个来回（Codex 二审点名的失败序列）
t('同包同名不同扩展名的两张，引用往返各回各家', (() => {
  const keep = skBox._stickerList;
  const gif = { name: '爱心', file: '爱心.gif', source: 'pack', pack: 'demo' };
  const png = { name: '爱心', file: '爱心.png', source: 'pack', pack: 'demo' };
  skBox._stickerList = [gif, png];
  const ok = skBox.findSticker(skBox.stickerRef(gif)) === gif
          && skBox.findSticker(skBox.stickerRef(png)) === png;
  skBox._stickerList = keep;
  return ok;
})());
t('包被删掉后，带前缀的老引用回退到按名字找（不是变成一行裸标签）',
  (() => { const keep = skBox._stickerList;
           skBox._stickerList = [{ name: '爱心', file: '爱心.png', source: 'server', custom: true }];
           const hit = skBox.findSticker('demo/爱心.gif');
           skBox._stickerList = keep;
           return !!hit && hit.source === 'server'; })());
t('自带库撤掉的 sad / wink：老消息退到意思最近的那张（cry / happy），不露裸标签',
  (() => { const keep = skBox._stickerList;
           const cry = { name: 'cry', file: 'cry.png', source: 'server' }, happy = { name: 'happy', file: 'happy.png', source: 'server' };
           skBox._stickerList = [happy, cry];
           const ok = skBox.findSticker('sad') === cry && skBox.findSticker('wink') === happy
             && skBox.findSticker('__proto__') === null && skBox.findSticker('nope') === null;
           skBox._stickerList = keep;
           return ok; })());
t('  同名的真表情还在时，用它自己（别名只是兜底）',
  (() => { const keep = skBox._stickerList;
           const mine = { name: 'sad', file: 'sad.png', source: 'server', custom: true };
           skBox._stickerList = [{ name: 'cry', file: 'cry.png', source: 'server' }, mine];
           const ok = skBox.findSticker('sad') === mine;
           skBox._stickerList = keep;
           return ok; })());
t('同一个包里同名不同扩展名的两张，合并键不一样（否则加载时吞掉一张）',
  skBox.stickerKey({ name: '爱心', file: '爱心.gif', source: 'pack', pack: 'demo' })
  !== skBox.stickerKey({ name: '爱心', file: '爱心.png', source: 'pack', pack: 'demo' }));

/* ── 合并函数：真跑 Codex 点名的那几个失败序列 ──────────────────────
   原来这块只有源码正则，注入把函数体掏空也照样绿。 */
const mgBox = sandbox('js/01-core.js', 'function _stkOpKey(g)', 'async function loadStateFromDB');
const G = (id, name, v) => ({ id, name, v });

// ① A 删掉分组，B 手里还是旧的活记录 → 合并后必须还是删掉的
{
  const A = { groups: [G('x', '甲', 1)], ops: { 'g:x': { a: 1, d: 2 } }, ver: 2 };
  const B = { groups: [G('x', '甲', 1)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 1 };
  t('① A 删了、B 还留着 → 合并后是删掉的（删除能传播）',
    _cnt(mgBox._mergeStickerGroupState(A, B).groups) === 0);
  t('① 反过来同步一遍，结果一样（跟先后无关）',
    _cnt(mgBox._mergeStickerGroupState(B, A).groups) === 0);
}
// ② 时钟快一年的设备不该长期压住另一台：版本是逻辑计数器，比的是谁改得更晚而不是谁的表快
{
  const fast = { groups: [G('x', '时钟快的那台', 5)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 5 };
  const slow = { groups: [G('x', '后改的名字', 6)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 6 };
  const m = mgBox._mergeStickerGroupState(fast, slow);
  t('② 版本大的赢（逻辑计数器，跟设备时钟无关）', m.groups[0].name === '后改的名字', m.groups[0].name);
  t('② 合并后版本取 max，本地下一次写必然更大', m.ver === 6, m.ver);
}
// ③ 离线很久的设备回来，不能把删掉的分组复活（所以墓碑不许过期）
{
  const cloudDeleted = { groups: [G('x', '甲', 1)], ops: { 'g:x': { a: 1, d: 9 } }, ver: 9 };
  const longOffline = { groups: [G('x', '甲', 1)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 1 };
  t('③ 离线再久回来也复活不了（墓碑没有保质期）',
    _cnt(mgBox._mergeStickerGroupState(cloudDeleted, longOffline).groups) === 0);
}
// ④ 并发：A 删甲、B 新建乙，两边版本撞平 —— 甲不许回来，乙不许丢
{
  const A = { groups: [G('甲', '甲', 1)], ops: { 'g:甲': { a: 1, d: 2 } }, ver: 2 };
  const B = { groups: [G('甲', '甲', 1), G('乙', '乙', 2)], ops: { 'g:甲': { a: 1, d: 0 }, 'g:乙': { a: 2, d: 0 } }, ver: 2 };
  const ids = mgBox._mergeStickerGroupState(A, B).groups.map(g => g.id).sort();
  t('④ 并发「A 删甲 / B 建乙」：甲没回来，乙也没丢', ids.join() === '乙', ids.join());
}
// ⑤ 老数据没有 ops 表：不能凭空消失（升级那一刻的行为必须零变化）
{
  const old = { groups: [G('x', '老分组', 0)], ops: {}, ver: 0 };
  t('⑤ 没有 ops 记录的老分组当成「0 版建的」，照样活着',
    _cnt(mgBox._mergeStickerGroupState(old, { groups: [], ops: {}, ver: 0 }).groups) === 1);
}
// ⑤b 同一个分组被两台设备并发改成不同名字、版本撞平：谁赢无所谓，但**两边必须赢的是同一个**。
//     我第一版的平局规则写的是按 id 排 —— 能进到同一条比较的必然同 id，那句永远为假，
//     实际退化成「先遍历到的赢」，于是换个参数顺序结果就变了（Codex 三审实测出来的）。
{
  const A = { groups: [G('x', '甲', 2)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 2 };
  const B = { groups: [G('x', '乙', 2)], ops: { 'g:x': { a: 1, d: 0 } }, ver: 2 };
  const ab = mgBox._mergeStickerGroupState(A, B).groups[0].name;
  const ba = mgBox._mergeStickerGroupState(B, A).groups[0].name;
  t('⑤b 属性版本撞平时，正反向合并结果一样（不许依赖参数顺序）', ab === ba, ab + ' vs ' + ba);
}
// ⑥ 归属表：移出也要能传播，而且平局要收敛到同一个结果
{
  const moved = { k1: { g: null, v: 3 } };
  const stale = { k1: { g: 'x', v: 1 } };
  t('⑥ 一台移出了，另一台的旧归属不许把它塞回去',
    mgBox._mergeStickerGroupOf(moved, stale).k1.g === null);
  const p1 = { k1: { g: 'aa', v: 5 } }, p2 = { k1: { g: 'bb', v: 5 } };
  t('⑥ 版本撞平时两台设备收敛到同一个结果',
    mgBox._mergeStickerGroupOf(p1, p2).k1.g === mgBox._mergeStickerGroupOf(p2, p1).k1.g);
  t('⑥ 老的裸字符串格式当 0 版，能被新写入盖掉',
    mgBox._mergeStickerGroupOf({ k1: 'old' }, { k1: { g: 'new', v: 1 } }).k1.g === 'new');
}

/* 表情可以叫 `__proto__.png`（收藏按文件名起名）。普通 {} 碰上这个键，赋值会写进原型：
   Object.keys 看不到、JSON.stringify 出来是空的 —— 界面上看着加进分组了，
   一保存/一同步那条归属就没了，全程零报错。IndexedDB 反序列化回来又是普通对象，
   所以每次写之前都得确认一遍。 */
{
  const gBox = sandbox('js/12-math-media.js', 'function _bumpGroupVer()', 'function _groupStickers(gid)',
    { state: { stickerGroupOf: {}, stickerGroupOps: {}, stickerGroupsVer: 0 } });
  gBox._setGroupOf('__proto__', 'g1');
  t('⑦ 表情名叫 __proto__ 也存得进去（普通对象会写进原型，键看不见）',
    Object.keys(gBox.state.stickerGroupOf).indexOf('__proto__') >= 0,
    Object.keys(gBox.state.stickerGroupOf).join());
  t('⑦ 而且读得回来', gBox._groupIdOf('__proto__') === 'g1', gBox._groupIdOf('__proto__'));
  t('⑦ JSON 往返之后还在（落盘和云同步走的就是这一趟）',
    Object.keys(JSON.parse(JSON.stringify(gBox.state.stickerGroupOf))).indexOf('__proto__') >= 0);
  t('⑦ 没归过组的表情读出来是 null，不是从原型上捡到的东西',
    gBox._groupIdOf('toString') === null && gBox._groupIdOf('没归过组的') === null);
  gBox._markGroup('__proto__', false, 'a');
  t('⑦ 分组 id 叫 __proto__ 时，存活表同样存得住',
    gBox._groupAlive('__proto__', false) === true
    && Object.keys(gBox.state.stickerGroupOps).indexOf('g:__proto__') >= 0);
}

const rxBox = sandbox('js/52-reactions.js', 'function _reactList(m)', 'function applyAiReaction(');
const chatFix = () => ({ nodes: { 1: { id: 1, reactions: [] } } });
let c = chatFix();
rxBox.addAiReaction(c, 1, '🤣', 'm1', '克克');
t('AI 贴得上', c.nodes[1].reactions.length === 1);
rxBox.addAiReaction(c, 1, '🤣', 'm1', '克克');
t('同一个模型贴同一个 emoji 不叠加', c.nodes[1].reactions.length === 1, c.nodes[1].reactions.length);
rxBox.addAiReaction(c, 1, '🤣', 'm2', '克克');
t('同昵称的另一个模型贴得上（身份认的是模型 id，不是名字）',
  c.nodes[1].reactions.length === 2, c.nodes[1].reactions.length);
rxBox.addAiReaction(c, 1, '🤣', 'm1', '改了个名的克克');
t('同一个模型改了昵称，不会再贴一遍', c.nodes[1].reactions.length === 2, c.nodes[1].reactions.length);
c = chatFix();
c.nodes[1].reactions = [{ e: '🤣', by: 'ai', who: '老记录' }];   // 老数据没有 id
rxBox.addAiReaction(c, 1, '🤣', null, '老记录');
t('老记录（没有 id）退回按昵称比，不重复贴', c.nodes[1].reactions.length === 1, c.nodes[1].reactions.length);

mergeCheck.then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
