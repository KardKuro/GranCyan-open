// 提示词缓存回归测试。
// 跑法：node tests/prompt-cache.test.js
//
// 守四件事（每一条都是"错了也不报错、只是悄悄多花钱/丢信息"的那种）：
// 1) 系统提示切成 stable / volatile 两截，每轮会变的东西（时间等）不许留在 stable 里
//    —— 留一个时间戳在前面，后面整份缓存每分钟作废一次，等于没开缓存；
// 2) volatile 被挪到最后一条用户消息之前，system 只剩稳定段；
// 3) cache_control 断点打在 system 末尾 + 最后一条用户消息**之前**那条，
//    不能打在最后一条上（那条每轮都不同，缓存了也永远命中不了）；
// 4) 联网搜索结果必须进得了 Anthropic 那条路（老 bug：第二条 system 消息被整条丢掉）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

const ctx = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }),
  state: {
    memories: [{ text: '小明喜欢深色界面', enabled: true }],
    userName: '小明', bandAiEnabled: false, webSearchApiKey: '', studyOn: false,
  },
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: s => String(s),
  estimateTokens: s => Math.ceil(String(s || '').length / 4),
  pickBrainMemories: () => [{ text: '这一轮刚好被勾起来的一条' }],
  formatBrainForPrompt: a => a.map(x => '- ' + x.text).join('\n'),
  takeProustMoment: () => '',
  stickerTagForApi: s => String(s || ''),
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('05-prompts-api.js'), ctx);

const conf = { id: 'm1', nickname: '克克', modelName: 'claude-opus-5', apiBase: 'https://api.anthropic.com/v1/messages', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };

// ── 1) 切分 ──
console.log('\n[1] 系统提示切分');
const out = {};
const full = ctx.buildSystemPrompt(conf, chat, '你好', null, out);
t('stable + volatile 拼回来就是完整提示', out.stable + out.volatile === full);
t('时间戳不在 stable 里', !/Current time/.test(out.stable));
t('时间戳在 volatile 里', /Current time/.test(out.volatile));
t('每轮变的高级记忆不在 stable 里', !/浮现的高级记忆/.test(out.stable));
t('人格/技能说明留在 stable 里', /记忆技能/.test(out.stable) && /表情包技能/.test(out.stable));
t('stable 不是空的', out.stable.length > 500);

// 隔一分钟再建一次：stable 必须一字不差（这就是缓存能不能命中的全部）
const realNow = Date.now;
Date.now = () => realNow() + 90 * 1000;
const out2 = {};
ctx.buildSystemPrompt(conf, chat, '你好', null, out2);
Date.now = realNow;
t('过了一分半，stable 一字未变', out2.stable === out.stable);

// ── 2) volatile 搬家 ──
console.log('\n[2] volatile 挪到最后一条用户消息');
const msgs = [
  { role: 'system', content: full },
  { role: 'user', content: '第一句' },
  { role: 'assistant', content: '回答' },
  { role: 'user', content: '最新一句' },
];
ctx.relocateVolatilePrompt(msgs, out);
t('system 只剩稳定段', msgs[0].content === out.stable);
t('实时信息挪进了最后一条用户消息', /本轮实时信息/.test(msgs[3].content) && /Current time/.test(msgs[3].content));
t('用户原话还在最后', msgs[3].content.trim().endsWith('最新一句'));
t('中间的历史一个字没动', msgs[1].content === '第一句' && msgs[2].content === '回答');

// 带图片的消息（content 是数组）也得能挪
const msgsImg = [
  { role: 'system', content: full },
  { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '这是什么' }] },
];
ctx.relocateVolatilePrompt(msgsImg, out);
t('图片消息：实时信息插在最前面且没弄丢图片', msgsImg[1].content.length === 3
  && msgsImg[1].content[0].type === 'text' && /本轮实时信息/.test(msgsImg[1].content[0].text)
  && msgsImg[1].content[1].type === 'image');

// ── 3) 断点 ──
console.log('\n[3] cache_control 断点');
const body = { system: msgs[0].content, messages: null };
const chatMsgs = msgs.slice(1).map(m => ({ role: m.role, content: m.content }));
ctx.applyPromptCache(body, chatMsgs);
t('system 变成带 cache_control 的块', Array.isArray(body.system)
  && body.system[0].cache_control?.type === 'ephemeral' && body.system[0].text === out.stable);
t('稳定 system 用 1h，增长中的历史仍用默认 5m',
  body.system[0].cache_control?.ttl === '1h'
  && !chatMsgs[1].content[0].cache_control?.ttl);
t('断点打在最后一条用户消息之前那条', Array.isArray(chatMsgs[1].content)
  && chatMsgs[1].content[0].cache_control?.type === 'ephemeral');
t('最后一条（挂着实时信息的那条）不打断点', typeof chatMsgs[2].content === 'string');
t('断点总数 = 2（上限 4）',
  JSON.stringify([body.system, chatMsgs]).split('"cache_control"').length - 1 === 2);

// 只有一条用户消息时（新对话第一句）不该崩，也不该给它打断点
const solo = [{ role: 'user', content: '第一句话' }];
const body2 = { system: 'stable', messages: null };
ctx.applyPromptCache(body2, solo);
t('新对话只有一条消息：只缓存 system，不崩', Array.isArray(body2.system) && typeof solo[0].content === 'string');

// ── 4) 联网搜索结果 ──
console.log('\n[4] 搜索结果不再被 Anthropic 那条路吞掉');
const split = { stable: 'STABLE', volatile: '\n\nVOL' };
split.volatile += '\n\n以下是与用户最新问题相关的实时网页搜索结果：\n\n[1] 某条结果';
const m4 = [{ role: 'system', content: 'STABLE' + split.volatile }, { role: 'user', content: '搜一下' }];
ctx.relocateVolatilePrompt(m4, split);
const anthropicSys = m4.filter(m => m.role === 'system')[0].content;
const anthropicMsgs = m4.filter(m => m.role !== 'system');
t('搜索结果随 volatile 进了用户消息（而不是被 filter 掉的第二条 system）',
  /网页搜索结果/.test(anthropicMsgs[0].content) && !/网页搜索结果/.test(anthropicSys));

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
