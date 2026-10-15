// 学习卡片主动复习回归测试。
// 跑法：node tests/study-auto-review.test.js
//
// 守三件事：
// 1) 到期卡不能继续靠模型“碰巧想起”，普通回复后程序会兜底补一张；
// 2) 不连续轰炸、未答不叠卡、群聊/电脑操控/通话/显式跳过都不偷袭；
// 3) content 与 blocks 必须复用同一个 askId，用户点的结果才能正确回填给模型。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');
const read = f => fs.readFileSync(path.join(JS, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

const ctx = {
  console, Date, setTimeout, clearTimeout,
  state: { studyOn: true, studyCards: [] },
  _call: { on: false },
  save(){}, showToast(){}, confirm:()=>true, SERVER_BASE:'',
  escHtml:s=>String(s), Audio:function(){ this.play = async()=>{}; },
  document: {
    getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
    addEventListener(){}
  },
  getMessagePath(chat, headId) {
    const out = [];
    let id = headId;
    while (id !== undefined && id !== null && chat.nodes[id]) {
      const n = chat.nodes[id];
      out.unshift(n);
      id = n.parentId;
    }
    return out;
  }
};
vm.createContext(ctx);
vm.runInContext(read('22-study.js'), ctx);

const dueCard = (id='c1') => ({
  id, lang:'de', front:'der Tisch', back:'桌子', ex:'Der Tisch ist groß.',
  ease:2.5, ivl:0, reps:0, lapses:0, due:Date.now()-1000, created:Date.now()-2000,
  last:0, log:{}
});
const freshChat = (extra={}) => ({
  nodes: {
    1:{ id:1, parentId:null, role:'user', content:'今天随便聊聊' },
    2:{ id:2, parentId:1, role:'ai', content:'' }
  },
  headId:2,
  ...extra
});
const ask = s => String(s).match(/\[\[CARDQ:([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\]\]/);

console.log('\n[1] 程序兜底主动出题');
ctx.state.studyCards = [dueCard()];
let chat = freshChat();
let run = { autoOffer:true, chat, userTurnId:1 };
let out = ctx.studyProcessTags('嗯，今天的风有点凉。', run);
let q = ask(out);
t('第一次普通回复自动补到期卡', !!q && q[1] === 'c1');
t('主动卡写入 ctx，供 blocks 重放', run.autoTag && run.autoTag.includes(q[2]));
t('出题后冷却计数归零', chat.studyAutoTurns === 0 && chat.studyAutoLastUserId === 1);

const blocks = [{type:'text', text:'嗯，今天的风有点凉。'}];
ctx._applyStudyToBlocks(blocks, run);
let qb = ask(blocks[0].text);
t('blocks 得到同一张主动卡', !!qb && qb[1] === q[1]);
t('content / blocks 共用完全相同的 askId', qb && qb[2] === q[2]);

console.log('\n[2] 未答不叠卡 + 三个用户回合冷却');
chat.nodes[2].content = out;
chat.nodes[2].blocks = blocks;
chat.nodes[3] = {id:3,parentId:2,role:'user',content:'然后呢'};
chat.nodes[4] = {id:4,parentId:3,role:'ai',content:''};
chat.headId = 4;
let r2 = {autoOffer:true,chat,userTurnId:3};
let o2 = ctx.studyProcessTags('接着聊。', r2);
t('上一张未答时不叠第二张', !ask(o2));

// 点掉第一张，并让它重新到期；之后仍须等满 3 个不同用户回合。
ctx.state.studyCards[0].log[q[2]] = {g:0,ts:Date.now()};
ctx.state.studyCards[0].due = Date.now()-1;
chat.nodes[4].content = o2;
chat.nodes[5] = {id:5,parentId:4,role:'user',content:'第二轮'};
chat.nodes[6] = {id:6,parentId:5,role:'ai',content:''}; chat.headId=6;
let o3 = ctx.studyProcessTags('还没到。',{autoOffer:true,chat,userTurnId:5});
chat.nodes[6].content=o3;
chat.nodes[7] = {id:7,parentId:6,role:'user',content:'第三轮'};
chat.nodes[8] = {id:8,parentId:7,role:'ai',content:''}; chat.headId=8;
let o4 = ctx.studyProcessTags('这次到了。',{autoOffer:true,chat,userTurnId:7});
t('冷却前两个新用户回合不出题', !ask(o2) && !ask(o3));
t('第 3 个新用户回合再次出题', !!ask(o4));

console.log('\n[3] 场景保护');
const noOffer = (extra, text='普通回复', mutate=()=>{}) => {
  ctx.state.studyCards = [dueCard()];
  const c = freshChat(extra); mutate(c);
  return ctx.studyProcessTags(text,{autoOffer:true,chat:c,userTurnId:1});
};
t('模型写 [[STUDY_SKIP]] 时不出题且标签隐藏', (()=>{
  const s=noOffer({},'先抱抱你。\n[[STUDY_SKIP]]'); return !ask(s) && !s.includes('STUDY_SKIP');
})());
t('群聊不自动围考', !ask(noOffer({isGroupChat:true})));
t('电脑操控模式不塞学习卡', !ask(noOffer({agentMode:true})));
ctx._call.on = true;
t('通话中不塞卡', !ask(noOffer({})));
ctx._call.on = false;
t('没有真实用户回合的自发消息不借机塞卡', (()=>{
  ctx.state.studyCards=[dueCard()]; const c=freshChat(); return !ask(ctx.studyProcessTags('忽然想起你。',{autoOffer:true,chat:c}));
})());

console.log('\n[4] 模型主动标签与 blocks 同步');
ctx.state.studyCards = [];
chat = freshChat();
run = {autoOffer:true,chat,userTurnId:1};
const raw = '顺手学一个。\n[[CARD: de|die Katze|猫|Die Katze schläft.]]';
out = ctx.studyProcessTags(raw, run);
q = ask(out);
const explicitBlocks = [{type:'text',text:raw}];
ctx._applyStudyToBlocks(explicitBlocks, run);
qb = ask(explicitBlocks[0].text);
t('显式建卡只创建一张数据卡', ctx.state.studyCards.length === 1);
t('显式卡在 content / blocks 也共用 askId', q && qb && q[1]===qb[1] && q[2]===qb[2]);
t('已有显式卡时不会再自动补第二张', (out.match(/\[\[CARDQ:/g)||[]).length === 1 && !run.autoTag);

console.log('\n[5] 旧版双 askId 历史修复');
const legacy = dueCard('legacy1');
legacy.log.a_visible = {g:2,ts:Date.now()};
ctx.state.studyCards = [legacy];
const legacyNode = {
  id:2,parentId:1,role:'ai',content:'[[CARDQ:legacy1|a_hidden]]',
  blocks:[{type:'text',text:'[[CARDQ:legacy1|a_visible]]'}]
};
ctx.state.chats = [{nodes:{1:{id:1,parentId:null,role:'user',content:'旧消息'},2:legacyNode},headId:2}];
t('启动迁移能找到并修复一条错位历史', ctx.studyRepairLegacyAskIds() === 1);
t('content 被对齐到用户实际看见并回答的 askId', legacyNode.content.includes('a_visible') && !legacyNode.content.includes('a_hidden'));
t('已回答的可见 blocks 不会把后续复习永久堵住', ctx._studyHasOpenAsk(ctx.state.chats[0]) === false);
t('迁移幂等，第二次不重复改', ctx.studyRepairLegacyAskIds() === 0);

console.log('\n[6] 接线与端侧一致性');
const mem = read('04-memory.js'), api = read('05-prompts-api.js'), group = read('06-render-msg.js');
const boot = read('14-boot-brain-hub.js');
t('processAiCommands 把 studyCtx 传进学习处理器', /studyProcessTags\(text, studyCtx\)/.test(mem));
// 末尾用 [,}] 收口而不是写死 `}`：后面还会有别的模块往同一个 ctx 上挂字段
//（檐廊的 gazeResults 就是），钉死闭括号会让无关改动误报红
t('普通回复创建 autoOffer 上下文', /const studyCtx = \{ autoOffer: true, chat, conf, userTurnId: parentMsgId[,}]/.test(api));
t('blocks 接收同一个 studyCtx', /_applyStudyToBlocks\(blocks, studyCtx\)/.test(api));
t('群聊显式关闭自动补卡', /autoOffer: false, chat, conf/.test(group));
t('启动时执行旧 askId 修复', /studyRepairLegacyAskIds\(\)/.test(boot));
t('桌面与安卓五个相关脚本一致', ['22-study.js','04-memory.js','05-prompts-api.js','06-render-msg.js','14-boot-brain-hub.js'].every(f =>
  fs.readFileSync(path.join(JS,f)).equals(fs.readFileSync(path.join(ROOT,'android/assets/js',f)))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
