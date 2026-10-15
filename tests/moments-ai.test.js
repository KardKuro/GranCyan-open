'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stateSrc = read('js/02-state.js');
const memorySrc = read('js/04-memory.js');
const promptSrc = read('js/05-prompts-api.js');
const momentsSrc = read('js/51-moments.js');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const state = {
  moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [],
  userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
  webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false
};
let next = 200;
let saves = 0;
const commandBox = {
  console, Date, setTimeout, clearTimeout,
  state,
  nextId: () => ++next,
  save: () => { saves++; },
  escHtml: value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  document: { getElementById: () => null },
  showToast: () => {},
  _stickerList: []
};
commandBox.globalThis = commandBox;
vm.createContext(commandBox);
// 浏览器里的真实顺序是 04 先声明调用点、51 后声明实现；真正收到回复时两者都已加载。
vm.runInContext(memorySrc, commandBox, { filename: '04-memory.js' });
vm.runInContext(momentsSrc, commandBox, { filename: '51-moments.js' });

console.log('\n[1] 指令执行、稳定作者与 blocks 展示');
const conf = { id: 77, name: '阿岚', nickname: '不该存这个别名' };
const raw = '前一句\n[[MOMENT: 第一条，雨停了。]]\n中间\n[[MOMENT: 第二条，风也小了。]]\n后一句';
const cooked = vm.runInContext('processAiCommands(__raw, {}, __conf)', Object.assign(commandBox, { __raw: raw, __conf: conf }));
const made = commandBox.state.moments;
t('★ author 存模型卡 name 字符串，不存下标、id 或 nickname',
  made.length === 2 && made.every(item => item.author === '阿岚' && typeof item.author === 'string'),
  JSON.stringify(made.map(item => item.author)));
t('★ 一条回复里的多个 [[MOMENT:]] 全部依次落库',
  made.length === 2 && made[0].text === '第一条，雨停了。' && made[1].text === '第二条，风也小了。'
    && made[0].id === 201 && made[1].id === 202 && saves === 2,
  JSON.stringify(made));
t('content 路径显示可点击猫爪日报卡片且不再裸露指令',
  !cooked.includes('[[MOMENT:') && (cooked.match(/class="moment-chat-card"/g) || []).length === 2
    && cooked.includes('onclick="openMoments()"'));

const blocks = [{ type: 'text', text: raw }];
vm.runInContext('_applyMomentsToBlocks(__blocks)', Object.assign(commandBox, { __blocks: blocks }));
t('blocks 非空时也显示两张卡片，并且不会重复落库',
  !blocks[0].text.includes('[[MOMENT:') && (blocks[0].text.match(/class="moment-chat-card"/g) || []).length === 2
    && commandBox.state.moments.length === 2 && saves === 2,
  blocks[0].text.slice(0, 180));

console.log('\n[2] 空正文 fail closed');
commandBox.state.moments = [];
saves = 0;
const emptyOut = vm.runInContext("processAiCommands('前 [[MOMENT:   ]] 后', {}, __conf)", commandBox);
t('★ 空正文或纯空白 [[MOMENT:]] 不产生动态',
  commandBox.state.moments.length === 0 && saves === 0 && !emptyOut.includes('moment-chat-card'),
  JSON.stringify(commandBox.state.moments));

const promptBox = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }),
  state,
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: value => String(value),
  pickBrainMemories: () => [],
  formatBrainForPrompt: () => '',
  takeProustMoment: () => '',
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

console.log('\n[3] 历史回填必须自咬合');
const history = promptBox.stickerTagForApi(cooked);
t('★ 回填格式仍是正牌 [[MOMENT: 正文]]，不含任何展示形态',
  history.includes('[[MOMENT: 第一条，雨停了。]]')
    && history.includes('[[MOMENT: 第二条，风也小了。]]')
    && !history.includes('上了猫爪日报') && !history.includes('moment-chat-card'),
  history.slice(0, 220));

// 改名前存进聊天记录里的老卡片 / 老提示块：字样还是「朋友圈」，必须照样咬回正牌指令，否则老历史静默断链
const oldCard = '<button type="button" class="moment-chat-card" onclick="openMoments()"><span class="moment-chat-kicker">📷 发了条朋友圈</span><span class="moment-chat-text">老动态正文</span></button>';
const oldView = '<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">📷 翻了翻朋友圈</span></div><div class="think-body">x</div></div>';
const oldBack = promptBox.stickerTagForApi(oldCard + '\n' + oldView);
t('★ 改名前存下的老卡片/老提示块仍咬回 [[MOMENT:]] / [[MOMENTS]]',
  oldBack.includes('[[MOMENT: 老动态正文]]') && oldBack.includes('[[MOMENTS]]') && !/<[^>]+>/.test(oldBack), oldBack.slice(0, 160));
const newCard = '<button type="button" class="moment-chat-card" onclick="openMoments()"><span class="moment-chat-kicker">上了猫爪日报</span><span class="moment-chat-text">新动态正文</span></button>';
t('新版卡片同样咬回', promptBox.stickerTagForApi(newCard).includes('[[MOMENT: 新动态正文]]'));
t('老提示块也能被 momentsViewAskedRecently 认出（刷新后兜底）',
  promptBox.momentsViewAskedRecently([{ role: 'ai', content: oldView }]) === true);

console.log('\n[4] 技能开关与 tok 实测');
const promptConf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
const build = () => promptBox.buildSystemPrompt(promptConf, chat, '刚刚聊了雨', null, {});
promptBox.state.skillsOff = {};
const full = build();
promptBox.state.skillsOff = { moments: true };
const lean = build();
t('★ 关闭 moments 后整段提示消失，其他系统提示仍保留',
  full.includes('[猫爪日报技能]') && full.includes('[[MOMENT: 正文]]')
    && full.includes('没有素材就不要发') && full.includes('大多数回复里都不该发猫爪日报')
    && !lean.includes('[猫爪日报技能]') && lean.includes('You are a helpful AI assistant'));
const measuredTok = promptBox.estimateTokens(full) - promptBox.estimateTokens(lean);
const momentDef = vm.runInContext("SKILL_DEFS.find(item => item.key === 'moments')", promptBox);
/* ±1 容差，和 mark-style.test.js 里那条同一个理由：这份的 state 桩和
   tests/skill-tok.test.js 的不一样，estimateTokens 又带 Math.ceil，同一段提示词
   在两个桩里能差 1 —— 两处各钉一个精确值必然有一个是错的，而"改一条技能提示
   要同时哄两个数字"的结局是有人把其中一个改成跑得过的值。
   精确到个位由 skill-tok.test.js 集中守（它逐条比全表）；这里只逮"整段提示改了
   忘了回来更新表"那种量级的偏差。 */
t('moments 的 tok 和实测差值一致（±1 容差，精确值由 skill-tok.test.js 守）',
  !!momentDef && Math.abs(momentDef.tok - measuredTok) <= 1,
  `表中 ${momentDef && momentDef.tok}，实测 ${measuredTok}`);

console.log('\n[5] 流式未闭合标签遮罩');
const masked = promptBox.maskStreamingTags('正在写 [[MOMENT: 这句还没写完');
t('★ 流式未闭合的 [[MOMENT: 被遮住，不漏标签或半截正文',
  !masked.includes('[[MOMENT:') && !masked.includes('这句还没写完') && masked.includes('正在发布动态'),
  masked);

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
