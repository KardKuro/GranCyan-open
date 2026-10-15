// 翻记忆 [[BREATH: 关键词]]（js/63-breath.js）回归测试。
//
// 守的是这个 bug（用户）：订阅 Claude（以及别的模型）没法主动去记忆库里找东西，
// 只能等「浮现」碰巧把那条挑上来。淡掉的记忆浮现永远挑不到，问起来就只能编。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failed = 0;
function t(name, yes) {
  console.log(`  ${yes ? '✓' : '✗'} ${name}`);
  if (!yes) failed++;
}

const DAY = 86400000;
const now = Date.now();
const state = {
  configs: [{ id: 1, nickname: '订阅克克', isLocalClaude: true }, { id: 2, nickname: '别的模型' }],
  brainMemories: [], skillsOff: {}, thinkSumKey: '',
};
let fetchImpl = async () => { throw new Error('no net'); };
let saved = 0;
const box = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number, Promise, Float32Array,
  state, AbortController,
  fetch: (...a) => fetchImpl(...a),
  save() { saved++; }, renderMemoryBadge() {}, nextId: () => Math.floor(Math.random() * 1e9),
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  getMsgPlainText: n => String((n && n.content) || ''),
  skillOn: key => !(state.skillsOff && state.skillsOff[key]),
  localStorage: { getItem: () => null },
};
box.globalThis = box;
vm.createContext(box);

// 高级记忆那一段（权重、IDF、语义路的常量）原样搬进来 —— breath 复用的就是这些
const hub = read('js/14-boot-brain-hub.js');
const a = hub.indexOf('const BRAIN_HALFLIFE_DAYS');
const b = hub.indexOf('// ── 高级记忆 UI ──');
t('抠到了高级记忆那一段', a > 0 && b > a);
vm.runInContext(hub.slice(a, b), box);
vm.runInContext(read('js/63-breath.js'), box);

const mem = (id, text, o = {}) => ({
  id, text, domain: o.domain || '情感', importance: o.importance ?? 5, valence: 0, arousal: 0.3,
  modelIds: o.modelIds || [1], pinned: false, resolved: false,
  createdAt: o.createdAt || now - 3 * DAY, lastAccess: o.lastAccess || now - 3 * DAY, accessCount: 0,
});
state.brainMemories = [
  // 一年没碰、重要度 2：权重远低于浮现门槛（BRAIN_MIN_WEIGHT），被动浮现永远挑不到它
  mem(101, '阳台种的是樱桃番茄，每周浇两次水', { importance: 2, lastAccess: now - 400 * DAY, createdAt: now - 400 * DAY }),
  mem(102, '小明喜欢深色界面，做 UI 先给深色'),
  mem(103, '小明的代表色是克莱因蓝'),
  mem(104, '只授权给别的模型的一条：樱桃番茄种子', { modelIds: [2] }),
];
for (let i = 0; i < 20; i++) state.brainMemories.push(mem(200 + i, `无关的日常记录第${i}条，今天吃了米饭`));

console.log('\n[1] 检索本身');
const faded = state.brainMemories[0];
t('前提：那条淡掉的记忆权重低于浮现门槛（不然这条测试证明不了什么）',
  box.brainWeight(faded, now) < vm.runInContext('BRAIN_MIN_WEIGHT', box));
const hits = box.breathSearch('樱桃番茄', 1, null);
t('★ 主动翻能翻到淡掉的记忆', hits.length > 0 && hits[0].m.id === 101);
t('★ 没授权给这个模型的记忆翻不到', !hits.some(h => h.m.id === 104));
t('别的模型翻得到授权给它的那条', box.breathSearch('樱桃番茄', 2, null).some(h => h.m.id === 104));
t('无关关键词翻不出一堆噪音', box.breathSearch('量子力学', 1, null).length === 0);
const imp = box.breathSearch('', 1, null);
t('不带关键词＝按重要度翻一批，且有上限', imp.length > 0 && imp.length <= vm.runInContext('BREATH_TOP', box));

console.log('\n[2] 全链路：预取 → 提示块 → 续写摊开 → 历史回填');
(async () => {
  const conf = state.configs[0];
  const before = faded.lastAccess;
  const reply = '我想想…\n[[BREATH: 樱桃番茄]]';
  await box.breathPrefetch(reply, conf);
  t('预取后标记为待摊开（lookupChain 靠它决定当轮续写）', box.breathPending(1));
  t('翻到的算「被想起」，刷新了 lastAccess 并落盘', faded.lastAccess > before && saved > 0);
  const shown = box.processBreathTags(reply, conf);
  t('★ 标签被换成提示块，气泡里没有裸标签', !/\[\[BREATH/.test(shown) && shown.includes('🌬 翻了翻记忆') && shown.includes('翻到 1 条'));
  const blocks = [{ type: 'text', text: reply }];
  box._applyBreathToBlocks(blocks, conf);
  t('blocks 路径同样换掉（渲染优先看 blocks）', !/\[\[BREATH/.test(blocks[0].text) && blocks[0].text.includes('🌬'));
  t('★ 回填历史咬回正牌指令', box.breathTagForApi(shown).includes('[[BREATH: 樱桃番茄]]') && !box.breathTagForApi(shown).includes('<div'));
  const p = box.breathPromptFor(conf);
  t('说明进 stable，教了指令写法', p.stable.includes('[[BREATH: 关键词]]'));
  t('★ 翻到的原文进 volatile', p.volatile.includes('阳台种的是樱桃番茄'));
  t('摊一次就清（不会每轮都带着）', !box.breathPending(1) && box.breathPromptFor(conf).volatile === '');

  await box.breathPrefetch('[[BREATH: 量子力学]]', conf);
  const none = box.breathPromptFor(conf).volatile;
  t('没翻到也要说，并叮嘱别编', none.includes('没找到') && none.includes('别编'));

  console.log('\n[3] 开关、流式遮挡、条数上限');
  state.skillsOff = { breath: true };
  await box.breathPrefetch('[[BREATH: 樱桃番茄]]', conf);
  t('技能关着不翻', !box.breathPending(1));
  t('技能关着裸标签被抹掉', box.processBreathTags('好[[BREATH: 樱桃番茄]]', conf) === '好');
  t('技能关着不教', box.breathPromptFor(conf).stable === '');
  state.skillsOff = {};
  t('流式：写完的标签遮住', !/\[\[/.test(box.maskStreamingBreath('嗯[[BREATH: 樱桃番茄]]')));
  t('流式：写到一半的标签也遮住', !/\[\[/.test(box.maskStreamingBreath('嗯[[BREA')));
  t('流式：普通文字不动', box.maskStreamingBreath('今天天气好') === '今天天气好');
  await box.breathPrefetch('[[BREATH: 深色]][[BREATH: 克莱因蓝]][[BREATH: 米饭]]', conf);
  const three = box.breathPromptFor(conf).volatile;
  t('一条回复最多翻两次，第三次明说没翻', three.includes('克莱因蓝') && /米饭.*最多翻 2 次/.test(three));

  console.log('\n[4] DeepSeek 脱水');
  for (let i = 0; i < 12; i++) state.brainMemories.push(mem(300 + i, `关于猫猫的一段很长的记忆，第${i}条，`.repeat(8) + '猫猫'));
  state.thinkSumKey = 'sk-test';
  let called = 0;
  fetchImpl = async (url, opt) => {
    called++;
    const body = JSON.parse(opt.body);
    t('脱水请求发给 DeepSeek，且带着关键词', /deepseek/.test(url) && body.messages[1].content.includes('猫猫'));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '- 猫猫相关的记忆，压成一句' } }] }) };
  };
  await box.breathPrefetch('[[BREATH: 猫猫]]', conf);
  let v = box.breathPromptFor(conf).volatile;
  t('★ 长结果走了脱水，摊开的是压缩后的', called === 1 && v.includes('压成一句') && v.includes('DeepSeek 压缩过'));
  fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  await box.breathPrefetch('[[BREATH: 猫猫]]', conf);
  v = box.breathPromptFor(conf).volatile;
  t('★ 脱水失败退回原文，不是一条都不给', v.includes('关于猫猫') && !v.includes('DeepSeek 压缩过'));
  called = 0;
  fetchImpl = async () => { called++; return { ok: true, json: async () => ({}) }; };
  await box.breathPrefetch('[[BREATH: 樱桃番茄]]', conf);
  box.breathPromptFor(conf);
  t('短结果不浪费一次 DeepSeek 调用', called === 0);

  console.log('\n[5] 接线（漏一处就是静默断链）');
  const api = read('js/05-prompts-api.js'), render = read('js/06-render-msg.js'), memjs = read('js/04-memory.js');
  t('单模型 / 多模型并排两条收尾都预取', (api.match(/await breathPrefetch\(/g) || []).length === 2);
  t('群聊收尾也预取', /await breathPrefetch\(fullText, conf\)/.test(render));
  t('content 路径换提示块', /processBreathTags\(text, conf\)/.test(memjs));
  t('blocks 路径三处都换', (api.match(/_applyBreathToBlocks\(blocks, conf\)/g) || []).length === 2
    && /_applyBreathToBlocks\(blocks, conf\)/.test(render));
  t('★ 当轮续写认它', /breathPending\(id\)\) out\.push/.test(api));
  t('系统提示里接上了', /breathPromptFor\(conf\)/.test(api));
  t('流式遮罩名单里有它', /'maskStreamingBreath'/.test(api));
  t('历史回填接上了', /breathTagForApi\(cooked\)/.test(api));
  t('技能表里有开关', /key: 'breath'/.test(api));
  t('页面加载了脚本', read('index.html').includes('<script src="./js/63-breath.js"></script>'));

  // 用户开着 CC 记忆让订阅 Claude「翻 CC 记忆」，他系统提示里只有一行摘要，
  // 提示词还叫他「去读文件」—— 聊天档根本没有读文件的工具，于是他只能说读不了。
  console.log('\n[6] CC 记忆（终端 Claude Code 写的）跟着 [[BREATH:]] 一起翻');
  state.thinkSumKey = '';
  box.SERVER_BASE = 'http://127.0.0.1:1';
  const urls = [];
  fetchImpl = async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ ok: true, hits: [{ name: 'weekend-sketch', description: '周末的速写', body: '五点做完的那段动画，逐帧' }] }) };
  };
  state.ccMemoryEnabled = false;
  await box.breathPrefetch('[[BREATH: 速写]]', conf);
  box.breathPromptFor(conf);
  t('开关关着不去捞 CC 记忆', urls.length === 0);
  state.ccMemoryEnabled = true;
  await box.breathPrefetch('[[BREATH: 速写]]', conf);
  const ccBlock = box.processBreathTags('[[BREATH: 速写]]', conf);
  v = box.breathPromptFor(conf).volatile;
  t('★ 开着就带关键词去后端搜', urls.length === 1 && urls[0].includes('/api/cc-memory/search?q=' + encodeURIComponent('速写')));
  t('★★ 高级记忆一条没中，CC 全文照样摆到眼前（不是「没找到，别编」）',
    v.includes('五点做完的那段动画') && v.includes('CC 记忆全文') && !v.includes('别编'));
  t('提示块告诉用户翻到了 CC 记忆', ccBlock.includes('CC 记忆 1 条'));
  t('回填历史仍咬回正牌标签', box.breathTagForApi(ccBlock).trim() === '[[BREATH: 速写]]');
  urls.length = 0;
  await box.breathPrefetch('[[BREATH: 速写]]', state.configs[1]);
  box.breathPromptFor(state.configs[1]);
  t('★ 别的模型翻不到 CC 记忆（私人记忆只给订阅 Claude）', urls.length === 0);
  fetchImpl = async () => { throw new Error('后端没开'); };
  await box.breathPrefetch('[[BREATH: 樱桃番茄]]', conf);
  v = box.breathPromptFor(conf).volatile;
  t('后端连不上不连累高级记忆那一路', v.includes('樱桃番茄') && !v.includes('CC 记忆全文'));
  state.ccMemoryEnabled = false;

  // 服务端：搜索函数 + 提示词按档说实话
  const srv = read('server.js');
  const sa = srv.indexOf('function searchCcMemories'), sb = srv.indexOf("app.get('/api/cc-memory/search'");
  t('抠到了 searchCcMemories', sa > 0 && sb > sa);
  const srvBox = { String, Math };
  vm.createContext(srvBox);
  vm.runInContext(srv.slice(sa, sb) + ';this.searchCcMemories = searchCcMemories;', srvBox);
  const items = [
    { name: 'balcony-garden', description: '阳台种的是樱桃番茄', body: '每周浇两次水' },
    { name: 'grancyan-hub', description: 'GranCyan 子索引', body: '提到过一次樱桃番茄' },
    { name: 'unrelated', description: '别的', body: '米饭' },
  ];
  const sh = srvBox.searchCcMemories(items, '樱桃番茄');
  t('★ 摘要命中的排在只有正文命中的前面，无关的不进', sh.length === 2 && sh[0].name === 'balcony-garden');
  t('名称精确命中排第一', srvBox.searchCcMemories(items, 'grancyan-hub')[0].name === 'grancyan-hub');
  t('空关键词不返回', srvBox.searchCcMemories(items, '').length === 0);
  const big = srvBox.searchCcMemories([{ name: 'big', description: '', body: '鱼'.repeat(9000) }], '鱼');
  t('全文有总字数上限', big[0].body.length < 4100 && big[0].body.includes('截掉'));
  const pa = srv.indexOf('async function ccMemoryPrompt('), pb = srv.indexOf('function searchCcMemories');
  const promptSrc = srv.slice(pa, pb);
  t('★★ 聊天档的提示叫它写 [[BREATH:]]，不再叫它去读文件', /agent\s*\?[\s\S]*Read[\s\S]*:\s*'需要某条完整内容时，单独写一行 \[\[BREATH:/.test(promptSrc));
  // 原来还有一个调用点在带图直连里（写死 false）；直连删了之后带图也走这同一个调用点
  t('★ 调用点按档传了 agent（每个调用点都是，没有写死的）',
    /ccMemoryPrompt\(!!agent\)/.test(srv) && (srv.match(/await ccMemoryPrompt\(/g) || []).length === (srv.match(/await ccMemoryPrompt\(!!agent\)/g) || []).length);

  if (failed) { console.log(`\n✗ ${failed} 条失败`); process.exitCode = 1; }
  else console.log('\n  —— 翻记忆全部通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
