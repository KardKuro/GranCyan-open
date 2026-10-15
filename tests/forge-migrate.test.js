// 无缝换窗（选择性对话迁移）回归测试。
// 跑法：node tests/forge-migrate.test.js
//
// 这个功能最容易出的是**静默错**：搬过去的对话看着好好的，但
//   - 只搬了 AI 那半边 → 模型看见自己凭空说了段话
//   - 断层没标 → 模型把"三天前"和"刚才"当成一口气聊完的
//   - 沿用了原节点 id → 撞 id 被 merge 吞掉整段（2026-07-15 那次对话静默消失）
//   - 改到了原对话 → 挑错一次就毁了原始记录
// 全都不会报错，所以每一条都单独钉住。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');
const read = f => fs.readFileSync(path.join(JS, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')));

let _id = 1000;
const ctx = {
  console, Date, setTimeout, clearTimeout,
  state: { chats: [], activeChatId: null },
  save(){}, showToast(){}, escHtml: s => String(s), structuredClone,
  nextId: () => ++_id,
  estimateTokens: s => Math.ceil(String(s || '').length / 4),
  renderChatList(){}, renderMessages(){}, renderModelPills(){},
  document: { getElementById: () => null, addEventListener(){} },
  getActiveChat() { return ctx.state.chats.find(c => c.id === ctx.state.activeChatId); },
  getMessagePath(chat, nodeId) {
    const p = []; let cur = nodeId;
    while (cur) { const n = chat.nodes[cur]; if (!n) break; p.unshift(n); cur = n.parentId; }
    return p;
  },
};
vm.createContext(ctx);
vm.runInContext(read('37-forge.js'), ctx);

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const T0 = 1700000000000;

// 造一个 6 轮的对话，时间跨度拉开：第 4 轮跟第 3 轮隔了 4 天
function makeChat() {
  const nodes = {};
  let id = 1, parent = null;
  const rounds = [
    { u: '第一轮问题', a: ['第一轮回答'], at: T0 },
    { u: '第二轮问题', a: ['第二轮回答'], at: T0 + 5 * MIN },
    { u: '第三轮问题', a: ['第三轮回答'], at: T0 + 10 * MIN },
    { u: '第四轮问题', a: ['第四轮回答'], at: T0 + 4 * DAY },
    { u: '第五轮问题', a: ['第五轮回答A', '第五轮回答B'], at: T0 + 4 * DAY + 5 * MIN },
    { u: '第六轮问题', a: ['第六轮回答'], at: T0 + 4 * DAY + 10 * MIN },
  ];
  for (const r of rounds) {
    const uid = id++;
    nodes[uid] = { id: uid, parentId: parent, role: 'user', content: r.u, timestamp: r.at, tokens: 5 };
    parent = uid;
    for (const a of r.a) {
      const aid = id++;
      nodes[aid] = { id: aid, parentId: parent, role: 'ai', content: a, timestamp: r.at + 1000, tokens: 7, reasoning: '一大段思考链'.repeat(50) };
      parent = aid;
    }
  }
  return { id: 1, title: '原对话', nodes, headId: parent, activeModelIds: ['m1'], msgLimit: 0, isGroupChat: false };
}

const setup = () => {
  const chat = makeChat();
  ctx.state.chats = [chat];
  ctx.state.activeChatId = chat.id;
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set();
  ctx._forgeNotes = {};
  ctx._forgeKeepImgs = true;
  return chat;
};

console.log('\n[1] 切轮');
let chat = setup();
t('切出 6 轮', ctx._forgeRounds.length === 6, ctx._forgeRounds.length);
t('每轮都有 user', ctx._forgeRounds.every(r => r.user && r.user.role === 'user'));
t('第 5 轮有两条 AI 回复', ctx._forgeRounds[4].ais.length === 2);
t('轮里的 nodes 数对得上', ctx._forgeRounds.map(r => r.nodes.length).join() === '2,2,2,2,3,2');

// 只走当前分支，不能把旁支（重试/编辑留下的）也算进来
chat = setup();
const orphan = { id: 999, parentId: 1, role: 'ai', content: '这是另一个分支的回复', timestamp: T0 };
chat.nodes[999] = orphan;
ctx._forgeRounds = ctx.forgeSplitRounds(chat);
t('旁支节点不进轮次（界面上看不见的话不该被搬走）',
  !ctx._forgeRounds.some(r => r.ais.some(a => a.id === 999)));

console.log('\n[2] 间隔措辞');
t('半小时以内不算断层（连着聊的两轮别插废话）', ctx.forgeGapText(20 * MIN) === '');
t('45 分钟 → 分钟', ctx.forgeGapText(45 * MIN) === '45 分钟');
t('3 小时 → 小时', ctx.forgeGapText(3 * HOUR) === '3 小时');
t('4 天 → 天', ctx.forgeGapText(4 * DAY) === '4 天');
t('两个月 → 个月', ctx.forgeGapText(60 * DAY) === '2 个月');
t('两年 → 年', ctx.forgeGapText(730 * DAY) === '2 年');

console.log('\n[3] 断层计划');
setup();
ctx._forgeSel = new Set([0, 1, 2]);          // 连着选三轮，中间什么都没漏
let plan = ctx.forgePlan();
t('连着选、时间也挨着 → 一处断层都不标', plan.every(p => !p.gapNote), plan.map(p => p.gapNote));

setup();
ctx._forgeSel = new Set([0, 5]);             // 跳过中间 4 轮
plan = ctx.forgePlan();
t('第一轮不带断层（前面没有东西可跳过）', !plan[0].gapNote);
t('跳过中间时写明隔了多久 + 省略几条', /隔了 4 天/.test(plan[1].gapNote) && /省略了 9 条/.test(plan[1].gapNote), plan[1].gapNote);

setup();
ctx._forgeSel = new Set([2, 3]);             // 相邻两轮，但中间隔了 4 天
plan = ctx.forgePlan();
t('相邻但隔了很久 → 只说隔了多久，不说"省略了 0 条"',
  plan[1].gapNote === '中间隔了 4 天', plan[1].gapNote);

console.log('\n[4] 搬过去');
chat = setup();
const beforeJson = JSON.stringify(chat);
ctx._forgeSel = new Set([0, 4, 5]);
ctx._forgeNotes = { 4: '心疼' };
ctx.forgeGo();

const neu = ctx.state.chats[0];
t('新对话排在最前面并被选中', neu.id !== chat.id && ctx.state.activeChatId === neu.id);
t('原对话一个字都没动', JSON.stringify(ctx.state.chats.find(c => c.id === 1)) === beforeJson);

const newPath = ctx.getMessagePath(neu, neu.headId);
t('搬过来 3 轮 = 2+3+2 共 7 条', newPath.length === 7, newPath.length);
t('顺序没乱', newPath.map(n => n.content).join('|') ===
  '第一轮问题|第一轮回答|第五轮问题|第五轮回答A|第五轮回答B|第六轮问题|第六轮回答',
  newPath.map(n => n.content).join('|'));
t('user/ai 交替结构正确', newPath.map(n => n.role).join() === 'user,ai,user,ai,ai,user,ai');

t('id 全部重新分配，一个都没跟原对话撞（撞了会被 merge 吞掉）',
  newPath.every(n => !chat.nodes[n.id]));
t('parentId 串成了一条直链', newPath.every((n, i) => i === 0 ? n.parentId === null : n.parentId === newPath[i - 1].id));
t('headId 指向最后一条', neu.headId === newPath[newPath.length - 1].id);

t('断层标在跳过之后那一轮的第一条上', newPath[2].gapNote && /隔了 4 天/.test(newPath[2].gapNote), newPath[2].gapNote);
t('   而且只标在 user 那条，不重复标到 AI 上', !newPath[3].gapNote && !newPath[4].gapNote);
t('第一轮没有断层标记', !newPath[0].gapNote);
t('连着的第 6 轮不再标断层（跟第 5 轮只隔 5 分钟）', !newPath[5].gapNote);

t('情绪关键词挂在 AI 那侧', newPath[3].moodNote === '心疼' && newPath[4].moodNote === '心疼');
t('   不挂到 user 上（那是 AI 的心境）', !newPath[2].moodNote);
t('思考链被甩掉了（换窗的全部意义就是甩掉这部分重量）',
  newPath.every(n => !n.reasoning));

t('模型选择跟着走', neu.activeModelIds.join() === 'm1');
t('   但是复制的，不是共享引用', neu.activeModelIds !== chat.activeModelIds);
t('留了来源痕迹', neu.forgedFrom === chat.id);

console.log('\n[5] 多模型节点只带选中的那一版');
chat = setup();
// 把第 2 轮的 AI 换成多模型节点，选中第 1 版（索引 1）
const aiId = ctx._forgeRounds[1].ais[0].id;
chat.nodes[aiId] = { id: aiId, parentId: chat.nodes[aiId].parentId, role: 'ai', isMulti: true, chosenVariant: 1,
  timestamp: T0 + 5 * MIN, variants: [
    { modelId: 'a', content: '没被采纳的稿子', tokens: 9 },
    { modelId: 'b', content: '被选中的那一版', tokens: 11 },
  ] };
ctx._forgeRounds = ctx.forgeSplitRounds(chat);
ctx._forgeSel = new Set([1]);
ctx.forgeGo();
const n2 = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId);
t('带的是 chosenVariant 指的那一版', n2[1].content === '被选中的那一版', n2[1].content);
t('   没被采纳的稿子没跟过来（占上下文还让模型自相矛盾）',
  !n2.some(n => String(n.content).includes('没被采纳')));
t('   节点被降级成普通 ai 节点', !n2[1].isMulti && !n2[1].variants);

console.log('\n[6] 图片开关');
chat = setup();
const uid1 = ctx._forgeRounds[0].user.id;
chat.nodes[uid1].images = [{ url: 'data:image/png;base64,AAAA' }];
ctx._forgeRounds = ctx.forgeSplitRounds(chat);
ctx._forgeSel = new Set([0]);
ctx._forgeKeepImgs = true;
ctx.forgeGo();
t('开着就带图', ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0].images?.length === 1);

chat = setup();
chat.nodes[ctx._forgeRounds[0].user.id].images = [{ url: 'data:image/png;base64,AAAA' }];
ctx._forgeRounds = ctx.forgeSplitRounds(chat);
ctx._forgeSel = new Set([0]);
ctx._forgeKeepImgs = false;
ctx.forgeGo();
t('关了就不带（换窗常常就是为了甩掉图片的重量）',
  !ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0].images);
ctx._forgeKeepImgs = true;

console.log('\n[7] 边界');
setup();
ctx._forgeSel = new Set();
const chatsBefore = ctx.state.chats.length;
ctx.forgeGo();
t('一轮都没选时不建空对话', ctx.state.chats.length === chatsBefore);

setup();
ctx._forgeSel = new Set([3]);
ctx.forgeGo();
t('只选一轮也能搬', ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId).length === 2);
t('   单轮不带断层标记（前面没有可跳过的东西）',
  !ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0].gapNote);

console.log('\n[8] 开头就是 AI 的历史（Codex 审出来的第 1 条）');
// 老数据里有这种：以前"继续"过的对话、导入的记录，路径第一条就是 AI。
// 原来会把它切成一个 user 为空的轮，选中搬走 → 新对话以 assistant 开头，
// 正是这个模块开头明说要避免的「模型看见自己凭空说了段话」。
{
  const nodes = {};
  nodes[1] = { id: 1, parentId: null, role: 'ai', content: '孤儿开头', timestamp: T0, tokens: 3 };
  nodes[2] = { id: 2, parentId: 1, role: 'user', content: '正常提问', timestamp: T0 + MIN, tokens: 4 };
  nodes[3] = { id: 3, parentId: 2, role: 'ai', content: '正常回答', timestamp: T0 + 2 * MIN, tokens: 5 };
  const c = { id: 77, title: 'AI 开头', nodes, headId: 3, activeModelIds: [], msgLimit: 0, isGroupChat: false };
  ctx.state.chats = [c]; ctx.state.activeChatId = 77;
  ctx._forgeRounds = ctx.forgeSplitRounds(c);
  ctx._forgeSel = new Set(); ctx._forgeNotes = {};

  t('孤儿 AI 头被标成 orphan', ctx._forgeRounds[0].orphan === true && ctx._forgeRounds[0].user === null);
  t('正常轮不是 orphan', ctx._forgeRounds[1].orphan !== true);
  t('forgeSelectable 拒绝 orphan', ctx.forgeSelectable(0) === false && ctx.forgeSelectable(1) === true);
  ctx.forgeToggle(0);
  t('点它也勾不上', ctx._forgeSel.size === 0);
  ctx.forgeSelectAll(true);
  t('「全选」也不会把它勾进去（最容易漏的一个入口）', !ctx._forgeSel.has(0) && ctx._forgeSel.has(1));
  ctx.forgeSelectLast(9);
  t('「最近 N 轮」同理', !ctx._forgeSel.has(0));
  ctx.forgeGo();
  const got = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId);
  t('搬过去的第一条一定是 user（绝不以 AI 开头）', got[0].role === 'user', got.map(n => n.role));
  t('   孤儿那条没跟过来', !got.some(n => n.content === '孤儿开头'));
}

console.log('\n[9] 深拷贝：新对话改了不能反噬原对话（第 3 条）');
{
  chat = setup();
  const uid = ctx._forgeRounds[0].user.id;
  chat.nodes[uid].images = [{ url: 'data:x', note: '原始说明' }];
  chat.nodes[uid].quotes = [{ text: '原始引用' }];
  chat.nodes[uid].audio = 'blob:x';
  chat.nodes[uid].voiceEmo = { hint: '原始听感' };
  chat.nodes[uid].videoNote = ['第 1 秒', '第 2 秒'];
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set([0]);
  ctx.forgeGo();
  const copied = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0];

  t('图片/引用/语音情绪/视频说明都带过来了',
    copied.images?.length === 1 && copied.quotes?.length === 1 && copied.videoNote?.length === 2 && !!copied.voiceEmo);
  // 关键：改新对话里的那份，原对话必须纹丝不动
  copied.images[0].note = '改过的说明';
  copied.quotes[0].text = '改过的引用';
  copied.voiceEmo.hint = '改过的听感';
  copied.videoNote[0] = '改过的时间码';
  t('改图片说明不反噬原对话', chat.nodes[uid].images[0].note === '原始说明', chat.nodes[uid].images[0].note);
  t('改引用不反噬', chat.nodes[uid].quotes[0].text === '原始引用');
  t('改语音听感不反噬', chat.nodes[uid].voiceEmo.hint === '原始听感');
  t('改视频说明不反噬', chat.nodes[uid].videoNote[0] === '第 1 秒');
}
// 两条克隆路都失败时（旧 WebView 没有 structuredClone + 附件里有循环引用）
// 必须整次放弃，绝不能"原样交出去"—— 那等于共享引用，正是这条要防的东西。
// （Codex 二审的第 1 条：为了"别炸"而静默降级，恰好制造出它要防的静默 bug。）
{
  chat = setup();
  const uid = ctx._forgeRounds[0].user.id;
  const circular = { url: 'data:x' };
  circular.self = circular;                    // JSON 拷不动
  chat.nodes[uid].images = [circular];
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set([0]);

  // 把 structuredClone 拿掉，模拟旧 WebView
  const hadSC = ctx.structuredClone;
  ctx.structuredClone = undefined;
  const chatsBefore2 = ctx.state.chats.length;
  // ⚠️ 这里不能用 JSON.stringify 比对——被测数据本身就含循环引用，
  // 那样炸的是测试自己（第一版就是这么炸的）。比节点数 + 引用同一性就够。
  const srcNodeCount = Object.keys(chat.nodes).length;
  const srcImages = chat.nodes[uid].images;
  let threw = false;
  try { ctx.forgeGo(); } catch (e) { threw = true; }
  ctx.structuredClone = hadSC;

  t('拷不动时不建那个新对话（宁可整次放弃，也不留半截）',
    ctx.state.chats.length === chatsBefore2, ctx.state.chats.length - chatsBefore2);
  t('   也没把异常抛到界面上（是给了提示）', !threw);
  t('   原对话仍然一个字没动',
    Object.keys(chat.nodes).length === srcNodeCount && chat.nodes[uid].images === srcImages
    && chat.nodes[uid].images[0].self === chat.nodes[uid].images[0]);
  // 反面对照：structuredClone 在的时候，同一个循环引用是能拷的
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set([0]);
  if (typeof ctx.structuredClone === 'function' || typeof structuredClone === 'function') {
    ctx.structuredClone = structuredClone;
    ctx.forgeGo();
    const copied2 = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0];
    t('对照：有 structuredClone 时循环引用能正常搬，且不共享引用',
      copied2 && copied2.images && copied2.images[0] !== circular);
  }
}
// videoNote 不是数组时也不能炸掉整次迁移
{
  chat = setup();
  chat.nodes[ctx._forgeRounds[0].user.id].videoNote = '不是数组的情况';
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set([0]);
  let ok = true;
  try { ctx.forgeGo(); } catch (e) { ok = false; }
  t('videoNote 是字符串时不炸、也不被拆成字符数组',
    ok && ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0].videoNote === '不是数组的情况');
}

console.log('\n[10] 多模型的作者身份（第 4 条）');
{
  chat = setup();
  const aid2 = ctx._forgeRounds[1].ais[0].id;
  // isMulti 的外层节点通常**没有** modelId —— 身份在每个 variant 里
  chat.nodes[aid2] = { id: aid2, parentId: chat.nodes[aid2].parentId, role: 'ai', isMulti: true, chosenVariant: 1,
    timestamp: T0 + 5 * MIN, variants: [
      { modelId: 'gpt', modelNickname: '小G', content: '没被采纳', tokens: 9 },
      { modelId: 'claude', modelNickname: '克克', content: '被选中的', tokens: 11 },
    ] };
  ctx._forgeRounds = ctx.forgeSplitRounds(chat);
  ctx._forgeSel = new Set([1]);
  ctx.forgeGo();
  const n = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[1];
  t('modelId 取自被选中的那一版，不是外层容器', n.modelId === 'claude', n.modelId);
  t('昵称同理（错了就是头像和"谁说的"全错）', n.modelNickname === '克克', n.modelNickname);
  t('token 也取那一版', n.tokens === 11, n.tokens);
}

console.log('\n[11] 用户消息的 token 不能丢（第 5 条）');
{
  chat = setup();
  ctx._forgeSel = new Set([0]);
  ctx.forgeGo();
  const u = ctx.getMessagePath(ctx.state.chats[0], ctx.state.chats[0].headId)[0];
  t('用户节点带着 tokens', u.tokens === 5, u.tokens);
  t('新对话 totalTokens 不是 0', ctx.state.chats[0].totalTokens > 0, ctx.state.chats[0].totalTokens);
}

console.log('\n[12] 间隔用「上一段末尾 → 这一段开头」（Codex 的措辞建议）');
{
  // 上一轮的 AI 拖了 5 小时才答完，紧接着（1 分钟后）问下一句。
  // 拿两轮的开头算会得出"隔了 5 小时"，其实是连着说的。
  const nodes = {};
  nodes[1] = { id: 1, parentId: null, role: 'user', content: '问', timestamp: T0, tokens: 2 };
  nodes[2] = { id: 2, parentId: 1, role: 'ai', content: '答（很久之后才答完）', timestamp: T0 + 5 * HOUR, tokens: 2 };
  nodes[3] = { id: 3, parentId: 2, role: 'user', content: '紧接着再问', timestamp: T0 + 5 * HOUR + MIN, tokens: 2 };
  nodes[4] = { id: 4, parentId: 3, role: 'ai', content: '再答', timestamp: T0 + 5 * HOUR + 2 * MIN, tokens: 2 };
  const c = { id: 88, title: 'x', nodes, headId: 4, activeModelIds: [], msgLimit: 0, isGroupChat: false };
  ctx.state.chats = [c]; ctx.state.activeChatId = 88;
  ctx._forgeRounds = ctx.forgeSplitRounds(c);
  ctx._forgeSel = new Set([0, 1]); ctx._forgeNotes = {};
  const p = ctx.forgePlan();
  t('AI 答得慢、下一句紧接着 → 不误报"隔了 5 小时"', !p[1].gapNote, p[1].gapNote);
}

console.log('\n[13] 接线');
const api = read('05-prompts-api.js');
t('gapNote 回填进了发给模型的历史（不回填的话这个功能等于没做）',
  /if \(m\.gapNote\) content = /.test(api));
t('moodNote 也回填了', /m\.moodNote/.test(api));
// 第 2 条：光回填给模型不够，人也得看得见——否则她无从检查这次换窗带了什么
const rend = read('06-render-msg.js');
t('gapNote 画进了消息流（不是只有模型暗地里收到）', /m\.gapNote/.test(rend) && /msg-gap/.test(rend));
t('moodNote 画进了 AI 气泡', /m\.moodNote/.test(rend) && /mood-note/.test(rend));
t('   两者都进了渲染缓存键（不进的话改了不重画）',
  /gp\$\{m\.gapNote\?\.length\|\|0\}/.test(rend) && /mn\$\{m\.moodNote\?\.length\|\|0\}/.test(rend));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
t('index.html 引了脚本', /js\/37-forge\.js/.test(html));
t('有面板容器 forgeBody', /id="forgeBody"/.test(html));
t('小组件里有入口', /openWidget\(openForge\)/.test(html));
const css = fs.readFileSync(path.join(ROOT, 'css/grancyan.css'), 'utf8');
t('断层横幅有样式（它是要给人看的，没样式就淹没在列表里）', /\.forge-gap\s*\{/.test(css));
t('消息流里的断层和心境也有样式', /\.msg-gap\s*\{/.test(css) && /\.mood-note\s*\{/.test(css));
t('孤儿轮有禁用样式', /\.forge-orphan\s*\{/.test(css));

console.log('\n[14] 桌面与安卓副本一致');
t('android 副本与 js/ 一致', ['37-forge.js', '05-prompts-api.js', '06-render-msg.js'].every(f =>
  fs.readFileSync(path.join(JS, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));
t('android 的 index.html / css 也同步了',
  fs.readFileSync(path.join(ROOT, 'index.html')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html'))) &&
  fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
