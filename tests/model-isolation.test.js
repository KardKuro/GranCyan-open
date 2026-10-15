'use strict';
// 模型隔离（单聊）：每家模型只看得见自己那家回过的轮。
// 用户：「grancyan无缝换窗能不能做个模型隔离。不然gpt知道Claude说过的所有话并且当成自己说的」
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8').replace(/\r\n/g, '\n');
const cont = fs.readFileSync(path.join(ROOT, 'js', '05-continuity-compaction.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const CONFS = [
  { id: 1, nickname: '订阅 Claude', modelName: 'claude-local', isLocalClaude: true, maxTokens: 200000, maxReplyTokens: 4000 },
  { id: 2, nickname: '订阅 GPT', modelName: 'gpt-local', isLocalGpt: true, maxTokens: 200000, maxReplyTokens: 4000 },
  { id: 3, nickname: '中转克', modelName: 'claude-opus-4-5', apiBase: 'https://x/v1/chat/completions', maxTokens: 200000, maxReplyTokens: 4000 },
  { id: 4, nickname: '小Q', modelName: 'qwen3-max', maxTokens: 200000, maxReplyTokens: 4000 },
  { id: 5, nickname: '无名', modelName: 'some-weird-model', maxTokens: 200000, maxReplyTokens: 4000 },
];

async function main() {
  const a = api.indexOf('// ── 模型隔离（单聊）──');
  const b = api.indexOf('// ═══════════════════════════════════════════════════════\n// WEB SEARCH', a);
  if (a < 0 || b < 0) throw new Error('抠不到 模型隔离 + buildApiMessages');
  const box = {
    console: { log() {}, warn() {}, error() {} }, state: { configs: CONFS },
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout,
    buildSystemPrompt: (conf, chat, last, p, out) => { out.stable = 'SYS'; out.volatile = ''; box._sysPath = p; return 'SYS'; },
    estimateTokens: s => Math.ceil(String(s || '').length / 2),
    stickerTagForApi: s => String(s || ''),
    showToast() {}, _ctxWarnedFor: new Set(), save() {},
  };
  vm.createContext(box);
  vm.runInContext(api.slice(a, b) + '\nthis.buildApiMessages = buildApiMessages; this.modelIsolatePath = modelIsolatePath;'
    + 'this.modelFamilyOfConf = modelFamilyOfConf; this.modelFamilyOfNode = modelFamilyOfNode;', box);

  console.log('\n[1] 认家');
  const fam = box.modelFamilyOfConf;
  t('订阅 Claude / 中转 Claude 是同一家', fam(CONFS[0]) === 'claude' && fam(CONFS[2]) === 'claude');
  t('订阅 GPT 是 gpt', fam(CONFS[1]) === 'gpt');
  t('o3-mini 认成 gpt，opus 不会被 o 误伤', fam({ id: 9, modelName: 'o3-mini' }) === 'gpt' && fam({ id: 9, modelName: 'opus-4' }) === 'claude');
  t('认不出的模型自己算一家', fam(CONFS[4]) === 'conf:5');
  t('config 被删了按昵称猜（claude.ai 导入的老对话昵称是 Claude）',
    box.modelFamilyOfNode({ role: 'ai', modelId: null, modelNickname: 'Claude' }) === 'claude');
  t('多模型节点看被选中的那一版',
    box.modelFamilyOfNode({ role: 'ai', isMulti: true, chosenVariant: 1, variants: [{ modelId: 1 }, { modelId: 2 }] }) === 'gpt');
  t('什么都没有的老消息认不出（= 不隔）', box.modelFamilyOfNode({ role: 'ai' }) === '');

  console.log('\n[2] 单聊：GPT 看不见Claude那几轮');
  const T = (h) => Date.UTC(2026, 9, 13, h, 0);
  const p = [
    { id: 11, role: 'user', content: '在吗', timestamp: T(1) },
    { id: 12, role: 'ai', content: 'Claude 的私房话一号', modelId: 1, timestamp: T(1) },
    { id: 13, role: 'user', content: '再来', timestamp: T(2) },
    { id: 14, role: 'ai', content: 'Claude 的私房话二号', modelId: 3, timestamp: T(2) },
    { id: 15, role: 'user', content: '问问 gpt', timestamp: T(3) },
    { id: 16, role: 'ai', content: 'GPT 自己说的', modelId: 2, timestamp: T(3) },
    { id: 17, role: 'user', content: '现在这句', timestamp: T(4) },
  ];
  const before = JSON.stringify(p);
  const gptMsgs = await box.buildApiMessages(p, CONFS[1], false, { id: 'c1' });
  const all = JSON.stringify(gptMsgs);
  t('★ Claude说的一个字都没发给 GPT', !/Claude 的私房话/.test(all), all);
  t('★ 她说给Claude听的那句也一起拿掉', !/在吗|再来/.test(all), all);
  t('GPT 自己那轮还在、还是 assistant', gptMsgs.some(m => m.role === 'assistant' && m.content === 'GPT 自己说的'));
  t('当前这句还在', /现在这句/.test(all));
  const noted = gptMsgs.find(m => typeof m.content === 'string' && m.content.includes('问问 gpt'));
  t('★ 隔开的地方写明省略了几轮', noted && /这之前有 2 轮是用户和别的 AI 的对话/.test(noted.content), noted && noted.content);
  t('user/assistant 还是交替的', gptMsgs.slice(1).every((m, i, arr) => i === 0 || m.role !== arr[i - 1].role), all);
  t('系统提示拿到的也是隔离后的路径', box._sysPath && !box._sysPath.some(n => n.id === 12));
  t('原路径一个字都没动', JSON.stringify(p) === before);

  console.log('\n[3] Claude这边：同家互通，GPT 那轮看不见');
  const ccMsgs = await box.buildApiMessages(p, CONFS[0], false, { id: 'c1' });
  const ccAll = JSON.stringify(ccMsgs);
  t('★ 订阅 Claude 看得见中转 Claude 那轮（都是Claude）', /Claude 的私房话一号/.test(ccAll) && /Claude 的私房话二号/.test(ccAll));
  t('★ 看不见 GPT 那轮', !/GPT 自己说的/.test(ccAll) && !/问问 gpt/.test(ccAll), ccAll);
  const ccLast = ccMsgs.find(m => typeof m.content === 'string' && m.content.includes('现在这句'));
  t('隔开的地方写明省略了 1 轮', ccLast && /这之前有 1 轮/.test(ccLast.content), ccLast && ccLast.content);

  console.log('\n[4] 不该动的不动');
  const plain = [
    { id: 21, role: 'user', content: '早', timestamp: T(1) },
    { id: 22, role: 'ai', content: '早呀', modelId: 1, timestamp: T(1) },
    { id: 23, role: 'user', content: '老消息', timestamp: T(2) },
    { id: 24, role: 'ai', content: '没署名的老回复', timestamp: T(2) },
    { id: 25, role: 'user', content: '嗯', timestamp: T(3) },
  ];
  const iso = box.modelIsolatePath(plain, CONFS[0]);
  t('全是自己家的：路径原样返回（同一个数组，缓存/续传不受影响）', iso.path === plain && iso.dropped === 0);
  const gIso = box.modelIsolatePath(plain, CONFS[1]);
  t('认不出是谁的老回复留着，只拿掉认得出的别家', gIso.dropped === 1 && gIso.path.some(n => n.id === 24) && !gIso.path.some(n => n.id === 22));
  const grp = await box.buildApiMessages(p, CONFS[1], true, { id: 'c1', isGroupChat: true });
  t('★ 群聊不隔（群聊本来就要互相看见，走昵称前缀那条路）', /Claude 的私房话一号/.test(JSON.stringify(grp)) && /\]: Claude 的私房话一号/.test(JSON.stringify(grp)), JSON.stringify(grp));

  console.log('\n[5] 连续性摘要：隔离前折的旧摘要不能再给 GPT 用');
  const ca = cont.indexOf('async function continuityPreparePath(');
  const cb = cont.indexOf('\nfunction continuityInjectedBlock(', ca);
  const cbox = { state: {}, String, console: { log() {}, warn() {} } };
  vm.createContext(cbox);
  vm.runInContext(cont.slice(cont.indexOf('function continuityStateFor('), cont.indexOf('function continuityClassify('))
    + cont.slice(ca, cb) + '\nthis.prep = continuityPreparePath;', cbox);
  const chat = { continuityCompaction: { '2': { summary: '旧摘要里有Claude 的私房话', untilId: '16' } } };
  const path2 = [{ id: 15 }, { id: 16 }, { id: 17 }];
  const r1 = await cbox.prep(path2, chat, CONFS[1], { isolated: true });
  t('★ 拿掉过别家的轮 + 旧摘要没有 iso 标 → 不用', r1.summary === '' && r1.path.length === 3, JSON.stringify(r1));
  const r2 = await cbox.prep(path2, chat, CONFS[1], { isolated: false });
  t('没拿掉东西时旧摘要照用（别无端重折）', r2.summary === '旧摘要里有Claude 的私房话' && r2.path.length === 1);
  chat.continuityCompaction['2'].iso = 1;
  const r3 = await cbox.prep(path2, chat, CONFS[1], { isolated: true });
  t('隔离之后折的（iso:1）照用', r3.summary === '旧摘要里有Claude 的私房话');
  t('新折的摘要都打上 iso:1', /version: 1, iso: 1 \}/.test(cont));

  // ── 2026-10-13 第二轮：「能不能让 GPT 看到自己的上一轮，克看到自己的上一轮」──
  console.log('\n[6] 同时问了两家、她挑了Claude那版：GPT 读自己那版');
  const multi = { id: 32, role: 'ai', isMulti: true, chosenVariant: 0, timestamp: T(2), variants: [
    { modelId: 1, modelNickname: '订阅 Claude', content: 'Claude 那版私房话' },
    { modelId: 2, modelNickname: '订阅 GPT', content: 'GPT 自己那版' },
  ] };
  const pm = [
    { id: 31, role: 'user', content: '一起回我', timestamp: T(2) },
    multi,
    { id: 33, role: 'user', content: '接着说', timestamp: T(3) },
  ];
  const multiBefore = JSON.stringify(multi);
  const gm = JSON.stringify(await box.buildApiMessages(pm, CONFS[1], false, { id: 'c2', nodes: {} }));
  t('★ GPT 看到的是它自己那版', /GPT 自己那版/.test(gm) && !/Claude 那版私房话/.test(gm), gm);
  t('★ 那一轮没被整轮拿掉（她那句还在）', /一起回我/.test(gm) && !/按模型隔离省略/.test(gm), gm);
  t('★ 没改她选中的那版（原节点 chosenVariant 还是Claude）', JSON.stringify(multi) === multiBefore);
  const cm = JSON.stringify(await box.buildApiMessages(pm, CONFS[0], false, { id: 'c2', nodes: {} }));
  t('Claude那边照旧看自己那版', /Claude 那版私房话/.test(cm) && !/GPT 自己那版/.test(cm), cm);
  const pmQ = box.modelIsolatePath(pm, CONFS[3], { nodes: {} });
  t('第三家（两版都不是它的）整轮拿掉', pmQ.dropped === 1 && !pmQ.path.includes(multi));

  console.log('\n[7] 换了模型重新生成：旁支上自己那条接得上');
  const sib = {
    41: { id: 41, parentId: null, role: 'user', content: '你怎么看', timestamp: T(1) },
    42: { id: 42, parentId: 41, role: 'ai', content: 'GPT 先答的（后来被重新生成换掉了）', modelId: 2, timestamp: T(1) },
    43: { id: 43, parentId: 41, role: 'ai', content: 'Claude 后答的', modelId: 1, timestamp: T(1) + 5000 },
    44: { id: 44, parentId: 43, role: 'user', content: '嗯嗯', timestamp: T(2) },
  };
  const ps = [sib[41], sib[43], sib[44]];
  const gs = JSON.stringify(await box.buildApiMessages(ps, CONFS[1], false, { id: 'c3', nodes: sib }));
  t('★ GPT 接上的是自己在旁支上那条', /GPT 先答的/.test(gs) && !/Claude 后答的/.test(gs), gs);
  t('不传 chat 就找不了旁支，退回整轮拿掉', box.modelIsolatePath(ps, CONFS[1]).dropped === 1);

  console.log('\n[8] 翻别的对话（[[CHAT_READ]]）也隔开');
  const peekSrc = fs.readFileSync(path.join(ROOT, 'js', '28-chat-peek.js'), 'utf8');
  const chats = [
    { id: 100, title: '只跟Claude 聊的', isGroupChat: false, nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '在吗', timestamp: T(1) },
      2: { id: 2, parentId: 1, role: 'ai', content: 'Claude 的私房话', modelId: 1, modelNickname: '订阅 Claude', timestamp: T(1) } }, headId: 2 },
    { id: 200, title: '两家都聊过', isGroupChat: false, nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '问Claude ', timestamp: T(1) },
      2: { id: 2, parentId: 1, role: 'ai', content: 'Claude 的另一段私房话', modelId: 1, modelNickname: '订阅 Claude', timestamp: T(1) },
      3: { id: 3, parentId: 2, role: 'user', content: '问 GPT', timestamp: T(2) },
      4: { id: 4, parentId: 3, role: 'ai', content: 'GPT 的回答', modelId: 2, modelNickname: '订阅 GPT', timestamp: T(2) } }, headId: 4 },
    { id: 300, title: '群聊', isGroupChat: true, nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '大家好', timestamp: T(1) },
      2: { id: 2, parentId: 1, role: 'ai', content: 'Claude 在群里', modelId: 1, modelNickname: '订阅 Claude', timestamp: T(1) },
      3: { id: 3, parentId: 2, role: 'ai', content: 'GPT 在群里', modelId: 2, modelNickname: '订阅 GPT', timestamp: T(1) } }, headId: 3 },
  ];
  const pbox = { state: { chats, configs: CONFS }, console, Object, Array, String, Number, Set, Map, Math, Date, JSON, RegExp,
    getMessagePath(chat, id) { const p = []; let c = id; while (c != null && chat.nodes[c]) { p.unshift(chat.nodes[c]); c = chat.nodes[c].parentId; } return p; } };
  vm.createContext(pbox);
  vm.runInContext(api.slice(a, api.indexOf('async function buildApiMessages(')) + '\n' + peekSrc
    + '\nthis.dir = chatDirectoryForPrompt; this.read = chatTranscriptForPrompt; this.pf = chatPeekPromptFor;', pbox);
  const gDir = pbox.dir(999, CONFS[1]);
  t('★ GPT 的目录里没有只跟Claude聊的那个', !/只跟Claude 聊的/.test(gDir) && /两家都聊过/.test(gDir) && /群聊/.test(gDir), gDir);
  t('★ 目录里的「出现过的模型」也不露Claude', !/订阅 Claude/.test(gDir.split('\n').find(l => /两家都聊过/.test(l)) || 'x'), gDir);
  const g100 = pbox.read(100, CONFS[1]);
  t('★ 点名要读也读不到（跟不存在说同一句）', !/私房话/.test(g100) && /没有 #100 这个对话/.test(g100), g100);
  const g200 = pbox.read(200, CONFS[1]);
  t('★ 两家都聊过的，只读得到自己那轮', /GPT 的回答/.test(g200) && !/私房话/.test(g200) && !/问Claude /.test(g200), g200);
  t('群聊照旧整篇给（大家本来就一起看）', /Claude 在群里/.test(pbox.read(300, CONFS[1])));
  t('Claude读自己的照旧', /Claude 的私房话/.test(pbox.read(100, CONFS[0])));
  t('不传 conf（老调用方）不隔', /Claude 的私房话/.test(pbox.read(100)) && /只跟Claude 聊的/.test(pbox.dir(999)));
  t('chatPeekPromptFor 把 conf 传下去', !/私房话/.test(pbox.pf(999, true, 200, CONFS[1]).volatile));

  console.log('\n[9] 换窗：别家那版跟着搬，同家的落选稿照旧不带');
  let _fid = 5000;
  const fctx = { console, Date, structuredClone, JSON, Object, Array, String, Number, Set, Map, Math, RegExp, Error,
    state: { chats: [], activeChatId: null, configs: CONFS },
    save() {}, showToast() {}, escHtml: s => String(s), nextId: () => ++_fid,
    estimateTokens: s => Math.ceil(String(s || '').length / 4),
    renderChatList() {}, renderMessages() {}, renderModelPills() {},
    document: { getElementById: () => null, addEventListener() {} },
    getActiveChat() { return fctx.state.chats.find(c => c.id === fctx.state.activeChatId); },
    getMessagePath: pbox.getMessagePath };
  vm.createContext(fctx);
  vm.runInContext(api.slice(a, api.indexOf('async function buildApiMessages(')) + '\n'
    + fs.readFileSync(path.join(ROOT, 'js', '37-forge.js'), 'utf8'), fctx);
  const fsrc = { id: 1, title: '原', isGroupChat: false, activeModelIds: [1, 2], nodes: {
    1: { id: 1, parentId: null, role: 'user', content: '一起回我', timestamp: T(1) },
    2: { id: 2, parentId: 1, role: 'ai', isMulti: true, chosenVariant: 1, timestamp: T(1), variants: [
      { modelId: 2, modelNickname: '订阅 GPT', content: 'GPT 那版', reasoning: '长思考' },
      { modelId: 1, modelNickname: '订阅 Claude', content: 'Claude 选中那版', reasoning: '长思考' },
      { modelId: 3, modelNickname: '中转克', content: 'Claude 同家落选稿' },
    ] } }, headId: 2 };
  fctx.state.chats = [fsrc]; fctx.state.activeChatId = 1;
  vm.runInContext('_forgeRounds = forgeSplitRounds(getActiveChat()); _forgeSel = new Set([0]); forgeGo();', fctx);
  const fn = Object.values(fctx.state.chats[0].nodes).find(n => n.role === 'ai');
  t('★ 搬过去还是多模型节点，GPT 那版跟着走', fn && fn.isMulti && fn.variants.some(v => v.content === 'GPT 那版'), fn);
  t('选中的那版排第一、仍是选中的', fn && fn.chosenVariant === 0 && fn.variants[0].content === 'Claude 选中那版');
  t('同家的落选稿没带（同一个模型看见自己写过两版会自相矛盾）', fn && !fn.variants.some(v => /落选稿/.test(v.content)));
  t('思考链照旧甩掉', fn && fn.variants.every(v => !v.reasoning));
  t('原对话没动', fsrc.nodes[2].variants.length === 3 && fsrc.nodes[2].variants[0].reasoning === '长思考');
  const fchat = fctx.state.chats[0];
  const fgpt = box.modelIsolatePath(pbox.getMessagePath(fchat, fchat.headId), CONFS[1], fchat);
  t('★ 新窗口里 GPT 读到自己那版', fgpt.path[1] && fgpt.path[1].variants[fgpt.path[1].chosenVariant].content === 'GPT 那版');

  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
