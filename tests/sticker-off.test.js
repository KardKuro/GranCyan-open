// 表情包「不给 AI 用」开关（用户 X 书签 Monagwd/sticker-shelf 那条）。
// 跑法：node tests/sticker-off.test.js
//
// 守的全是静默失效：
//   ① 关掉的那张还在系统提示的清单里 → 模型照样写，开关形同虚设，界面上看不出来
//   ② 模型照着历史写了它的标签 → 照样出图（content / blocks / 流式三条路漏一条就漏）
//   ③ 她自己发也被拦了（拦在了渲染层）→ 或者反过来，关掉之前 AI 发过的老消息全变裸标签
//   ④ 同步：本地优先合并的话「重新打开」永远传不到另一台；三道白名单漏一道活不过刷新
//   ⑤ 老数据（没有这张表）必须等于全部给 AI 用
//
// 「点了开关提示词里真的少了那张」的端到端那遍在 tests/browser-sticker-off.js（真 headless）。

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
// 仓库里的文件是 CRLF，切片锚点按 \n 写 —— 统一掰成 LF 再切
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const stk = read('js/10-stickers-voice.js');
const mm = read('js/12-math-media.js');
const api = read('js/05-prompts-api.js');
const mem = read('js/04-memory.js');
const render = read('js/06-render-msg.js');
const stateJs = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/grancyan.css');

function slice(src, from, to, file) {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a) : src.length;
  if (a < 0 || (to && b < 0)) throw new Error('切片锚点没找到: ' + file + ' / ' + from);
  return src.slice(a, b);
}

// 把真代码抠进一个沙箱：findSticker / stickerRef / _packStickers / _bumpGroupVer（12）、
// normalizeStickerTags（04）、开关那几个函数（10）
function makeBox(list) {
  const box = { console, Object, String, state: { stickerAiOff: {}, stickerGroupsVer: 0 }, _stickerList: list || [] };
  vm.createContext(box);
  vm.runInContext(slice(mm, 'function stickerKey(s) {', 'function _groupStickers(gid)', '12-math-media.js'), box);
  vm.runInContext(slice(mem, 'function normalizeStickerTags(text)', 'function processAiCommands(', '04-memory.js'), box);
  vm.runInContext(slice(stk, 'function stickerAiOff(name)', '// 给收藏的表情包备注', '10-stickers-voice.js'), box);
  return box;
}
const LIST = [
  { name: '哭哭', desc: '哭', file: '哭哭.png', source: 'server', custom: true },
  { name: '笑笑', desc: '笑', file: '笑笑.png', source: 'server', custom: true },
  { name: '抱抱', desc: '抱', file: '抱抱.gif', source: 'pack', pack: 'demo' },
  { name: '__proto__', desc: '怪名字', file: '__proto__.png', source: 'cloud' },
];

console.log('\n[1] 开关本身（真跑）');
{
  const box = makeBox(LIST);
  t('老数据没有这张表 = 给 AI 用', box.stickerAiOff('哭哭') === false);
  box.state.stickerAiOff = undefined;
  t('state 上整个字段都没有也不炸、照样给 AI 用', box.stickerAiOff('哭哭') === false);
  box.setStickerAiOff('哭哭', true);
  t('关掉之后读得回来', box.stickerAiOff('哭哭') === true);
  t('关掉一张不连累别的', box.stickerAiOff('笑笑') === false);
  t('写的是带版本的记录（逻辑计数器，跟分组共用那一个）',
    box.state.stickerAiOff['哭哭'].off === true && box.state.stickerAiOff['哭哭'].v === 1 && box.state.stickerGroupsVer === 1,
    box.state.stickerAiOff['哭哭']);
  box.setStickerAiOff('哭哭', false);
  t('重新打开记成 off:false 而不是删键（删了另一台的旧「关」会在合并时回来）',
    Object.keys(box.state.stickerAiOff).includes('哭哭') && box.state.stickerAiOff['哭哭'].off === false
    && box.state.stickerAiOff['哭哭'].v === 2 && box.stickerAiOff('哭哭') === false);
  box.setStickerAiOff('__proto__', true);
  t('表情叫 __proto__ 也存得住、读得回、JSON 往返不丢（普通对象会写进原型）',
    box.stickerAiOff('__proto__') === true
    && Object.keys(JSON.parse(JSON.stringify(box.state.stickerAiOff))).includes('__proto__'));
  t('没关过的名字不会从原型上捡到东西', box.stickerAiOff('toString') === false && box.stickerAiOff('constructor') === false);
  // 上面那张表已经被 setStickerAiOff 换成无原型对象了，测不出读的那一侧。
  // 出厂值 / 别处赋进来的是普通 {}：读的时候也得查自有属性（故障注入逮到这条原来是空守）
  box.state.stickerAiOff = {};
  t('普通 {} 上读 toString / constructor 也不会当成「关了」',
    box.stickerAiOff('toString') === false && box.stickerAiOff('constructor') === false);
  box.state.stickerAiOff = { 老格式: true };
  t('裸 true 也认（手改过或者以后谁偷懒写了布尔）', box.stickerAiOff('老格式') === true);
}

console.log('\n[2] AI 写了被关掉的那张：不出图（真跑）');
{
  const box = makeBox(LIST);
  box.setStickerAiOff('哭哭', true);
  box.setStickerAiOff('抱抱', true);
  const s = x => box.stripAiOffStickers(x);
  t('[[STICKER:哭哭]] 被抹掉', s('好呀[[STICKER:哭哭]]') === '好呀', s('好呀[[STICKER:哭哭]]'));
  t('没关的那张原样留着', s('好[[STICKER:笑笑]]') === '好[[STICKER:笑笑]]');
  t('标签里带空格也认', s('[[STICKER: 哭哭 ]]') === '');
  t('包里的表情用「包id/文件名」写也拦得住', s('[[STICKER:demo/抱抱.gif]]') === '');
  t('认不出的名字不归这里管，原样交给渲染层（照旧是「不认识的表情」那条路）',
    s('[[STICKER:根本没有]]') === '[[STICKER:根本没有]]');
  t('一条里混着关的和没关的：只抹关掉的',
    s('[[STICKER:哭哭]]嗯[[STICKER:笑笑]]') === '嗯[[STICKER:笑笑]]');
  const n = x => box.stripAiOffStickers(box.normalizeStickerTags(x));
  t('照抄历史写成 [表情包: 哭哭] 的，normalize 之后也拦住', n('[表情包: 哭哭]') === '', n('[表情包: 哭哭]'));
  t('全角冒号 [[STICKER：哭哭]] 也拦住', n('[[STICKER：哭哭]]') === '');
  const blocks = [{ type: 'text', text: '抱一下[[STICKER:抱抱]]' }, { type: 'thinking', text: '[[STICKER:抱抱]]' },
                  { type: 'text', text: '[表情包: 哭哭]然后' }];
  box._applyStickerOffToBlocks(blocks);
  t('blocks 那条路：文字块里的抹掉了', blocks[0].text === '抱一下' && blocks[2].text === '然后', blocks.map(b => b.text));
  t('blocks 那条路：思考块不动（那不是发出去的）', blocks[1].text === '[[STICKER:抱抱]]');
  t('流式遮挡：写完的那张不闪一下', box.maskStreamingStickerOff('嗯[[STICKER:哭哭]]') === '嗯');
  t('流式遮挡：没写完的半截不归它管（总表里别的遮罩不管表情，照旧）',
    box.maskStreamingStickerOff('嗯[[STICKER:哭') === '嗯[[STICKER:哭');
  box.setStickerAiOff('哭哭', false);
  t('重新打开之后 AI 又能发了', s('[[STICKER:哭哭]]') === '[[STICKER:哭哭]]');
}

console.log('\n[3] 接线：三条路都拦、而且拦在落盘那一刻');
const pac = slice(mem, 'function processAiCommands(', '\n}\n', '04-memory.js');
const iNorm = pac.indexOf('text = normalizeStickerTags(text);');
const iStrip = pac.indexOf('text = stripAiOffStickers(text)');
t('processAiCommands（content 那条路）调了 stripAiOffStickers', iStrip > 0);
t('  而且在 normalize 之后（不然 [表情包: 名字] 那种漏过去）', iNorm >= 0 && iStrip > iNorm);
t('finalize 两条路（正常 + 多变体）blocks 都过了一遍',
  (api.match(/_applyStickerOffToBlocks\(blocks\)/g) || []).length === 2);
t('群聊/流式那条路 blocks 也过了', /_applyStickerOffToBlocks\(blocks\)/.test(render));
t('流式遮罩登记进了总表', /'maskStreamingStickerOff'/.test(slice(api, 'const _STREAM_MASKS', '\n', 'api')));
// 拦在渲染层的话：她自己发的也被拦；关掉之前 AI 发过的老消息全变裸标签
const s2h = slice(mm, 'function stickerTagToHtml(text) {', '\n}\n', '12-math-media.js');
t('渲染层（stickerTagToHtml）不查开关 —— 她自己照样能发，老消息照样出图',
  !/stickerAiOff|stripAiOffStickers/.test(s2h));
const rut = slice(read('js/09-appearance-input.js'), 'function renderUserText(raw)', '\n}\n', '09');
t('用户消息的渲染也不查开关', !/stickerAiOff|stripAiOffStickers/.test(rut));

console.log('\n[4] 系统提示里的表情清单（真跑 buildSystemPrompt）');
{
  const state = {
    moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [], chats: [],
    userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: '', bandAiEnabled: false, studyOn: false,
    stickerNotes: { 笑笑: '开心的时候发' }, stickerAiOff: {}, stickerGroupsVer: 0,
  };
  const list = [...LIST.slice(0, 3)];
  // 哭哭、笑笑 + 29 张填充 = 31 张收藏，清单只给 30 个名额，填充29 正好是第 31 张。
  // 关掉哭哭之后它必须补进来（先滤再截）
  for (let i = 1; i <= 29; i++) list.push({ name: '填充' + i, desc: 'f' + i, file: '填充' + i + '.png', source: 'server', custom: true });
  const box = {
    console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number,
    fetch: async () => ({ ok: true }), state,
    _stickerList: list, _stickerPacks: [{ id: 'demo', name: '克克' }], _call: { on: false }, _ctxWarnedFor: new Set(),
    save() {}, showToast() {}, escHtml: v => String(v),
    pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
    getActiveChat: () => null, getMsgPlainText: n => String((n && n.content) || ''),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {},
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(slice(stateJs, 'function estimateTokens(text)', 'function getChatTotalTokens', '02-state.js'), box);
  vm.runInContext(slice(mm, 'function stickerKey(s) {', 'function _groupStickers(gid)', '12-math-media.js'), box);
  vm.runInContext(slice(stk, 'function stickerAiOff(name)', '// 给收藏的表情包备注', '10-stickers-voice.js'), box);
  vm.runInContext(api, box);
  const conf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
  const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
  const sp = () => {
    const p = box.buildSystemPrompt(conf, chat, '', null, {});
    const i = p.indexOf('[表情包技能]');
    return i < 0 ? '' : p.slice(i, p.indexOf('方式2', i));
  };
  const before = sp();
  t('探针先验身：没关的时候三张都在清单里',
    before.includes('哭哭(哭)') && before.includes('笑笑(开心的时候发)') && before.includes('demo/抱抱.gif(抱)'), before.slice(0, 300));
  t('探针先验身：第 31 张被 30 的名额截在外面', !before.includes('填充29(') && before.includes('填充28('));
  box.setStickerAiOff('哭哭', true);
  box.setStickerAiOff('抱抱', true);
  const after = sp();
  t('关掉的收藏不在清单里了', !after.includes('哭哭'), after.slice(0, 300));
  t('关掉的包里的表情不在清单里了', !after.includes('抱抱'));
  t('没关的照旧在，备注照旧用', after.includes('笑笑(开心的时候发)'));
  t('先滤再截：关掉的不占名额，第 31 张补进来了', after.includes('填充29('));
  t('包那一栏全关光了就不报这一栏（不留一行空的「AI这一栏:」）', !after.includes('「克克」这一栏'));
  t('提示词真的变短了', box.estimateTokens(after) < box.estimateTokens(before));
  for (const s of list) box.setStickerAiOff(s.name, true);
  const none = sp();
  t('全关光了就不教方式1（教一个空清单，它只会照着历史瞎写名字）', !/方式1/.test(none) && none.includes('[表情包技能]'), none);
  for (const s of list) box.setStickerAiOff(s.name, false);
  const back = sp();
  t('全部重新打开，清单回到原样', back === before);
}

console.log('\n[5] 同步：跟备注同一条路（云端设置），但合并要能「关了再开」');
t('不给AI开关 写盘', /idbSet\('kuro_stickerAiOff'/.test(stateJs));
t('不给AI开关 读盘', /stickerAiOff:\s*await g\('kuro_stickerAiOff'/.test(core));
t('不给AI开关 启动时赋进 state（第 3 道，最容易漏）', /state\.stickerAiOff\s*=[^;\r\n]*saved\.stickerAiOff/.test(boot));
t('不给AI开关 state 出厂值里有它', /stickerAiOff: \{\}/.test(stateJs));
t('跟着账号云同步（和 stickerNotes 挨着，同一个设置包）', /stickerNotes: state\.stickerNotes \|\| \{\},\s*stickerAiOff: state\.stickerAiOff \|\| \{\}/.test(core));
t('推送前、拉取后两处都走合并函数，不是本地优先整包覆盖',
  (core.match(/_mergeStickerAiOff\(/g) || []).length === 3 && !/stickerAiOff = Object\.assign\(/.test(core));
{
  const box = { console, Object, String };
  vm.createContext(box);
  vm.runInContext(slice(core, 'function _mergeStickerAiOff(a, b)', 'async function loadStateFromDB', '01-core.js'), box);
  const M = box._mergeStickerAiOff;
  const off = (k, x) => (M.length, x[k] && x[k].off);
  const phoneOff = { 哭哭: { off: true, v: 3 } }, pcOn = { 哭哭: { off: false, v: 5 } };
  t('手机关、电脑后来又开：开赢（版本大的赢）', off('哭哭', M(phoneOff, pcOn)) === false);
  t('  反过来合并结果一样（跟谁先同步无关）', off('哭哭', M(pcOn, phoneOff)) === false);
  t('版本撞平：两台收敛到同一个结果，而且偏向先别给 AI 用',
    off('哭哭', M({ 哭哭: { off: true, v: 4 } }, { 哭哭: { off: false, v: 4 } })) === true
    && off('哭哭', M({ 哭哭: { off: false, v: 4 } }, { 哭哭: { off: true, v: 4 } })) === true);
  t('一边有一边没有：有的那条留着（另一台没碰过它）', off('哭哭', M(phoneOff, {})) === true && off('哭哭', M(undefined, phoneOff)) === true);
  t('两边都没有这张表：合出来是空的 = 全部给 AI 用', Object.keys(M(undefined, undefined)).length === 0);
  t('裸布尔的老格式当 0 版，能被任何新写入盖掉', off('x', M({ x: true }, { x: { off: false, v: 1 } })) === false);
  const pm = M({ ['__proto__']: { off: true, v: 1 } }, JSON.parse('{"__proto__":{"off":true,"v":1}}'));
  t('表情叫 __proto__ 合并后也还在', Object.keys(pm).includes('__proto__') && pm['__proto__'].off === true);
}

console.log('\n[6] 界面：开关放在备注弹窗里，关掉的那张淡淡标出来');
const esn = slice(stk, 'async function editStickerNote(name)', '\n}\n', '10-stickers-voice.js');
t('备注弹窗带了勾选框，初值是当前状态', /appPrompt\([^\n]*\{ check \}\)/.test(esn) && /checked: wasOff/.test(esn));
t('只在勾选真的变了才写开关（不然每次改备注都白涨一格版本）', /if \(check\.checked !== wasOff\)/.test(esn) && /setStickerAiOff\(name, check\.checked\)/.test(esn));
t('取消就什么都不动', /if \(note === null\) return;/.test(esn) && esn.indexOf('if (note === null) return;') < esn.indexOf('setStickerAiOff'));
const ap = slice(stateJs, 'function appPrompt(message', '\n}\n', '02-state.js');
t('appPrompt 每次都重置勾选行（弹窗是复用的，上一个的勾选框不许留到下一个）',
  /checkRow\.style\.display = check \? 'flex' : 'none'/.test(ap) && /checkBox\.checked = !!\(check && check\.checked\)/.test(ap));
t('按确定才把勾选写回去，取消不写', /if \(check && checkBox && val !== null\) check\.checked = checkBox\.checked/.test(ap));
t('面板格子：关掉的挂 ai-off 和小记号', /aiOff \? ' ai-off' : ''/.test(mm) && /sticker-ai-off-tag/.test(mm));
t('样式：图淡一点，记号不挡点击', /\.sticker-item\.ai-off img \{[^}]*opacity/.test(css) && /\.sticker-ai-off-tag \{[^}]*pointer-events:none/.test(css));
t('点格子照样是发送（她自己照样能发）', /sticker-item\$\{note \? ' has-note' : ''\}\$\{aiOff \? ' ai-off' : ''\}" onclick="sendLocalSticker\(/.test(mm));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
