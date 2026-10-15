// 学习卡片「分组投放」回归测试。
// 跑法：node tests/study-grouping.test.js
//
// 守的是这一个塌方：
//   新卡建出来 due = 建卡那一刻（已经是过去），学过的卡答完 due 被推到未来。
//   原来挑卡只有一条「所有到期卡按 due 升序取第一张」的队列，于是导 200 个词进来，
//   这 200 张永远排在所有学过的卡前面 —— 学过的词得等新词全部消化完才轮得到，
//   中间隔好几天。**零报错**，面板上还显示"待复习 200+"，看着像在正常工作。
//
// 所以这里的断言几乎都在问同一句话：新词多到离谱的时候，复习还轮得到吗。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');
const read = f => fs.readFileSync(path.join(JS, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

let saves = 0;
const ctx = {
  console, Date, setTimeout, clearTimeout,
  state: { studyOn: true, studyCards: [], studyGroupIds: [] },
  _call: { on: false },
  save(){ saves++; }, showToast(){}, confirm:()=>true, SERVER_BASE:'',
  escHtml:s=>String(s), Audio:function(){ this.play = async()=>{}; },
  document: { getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){} },
  getMessagePath(chat, headId) {
    const out = []; let id = headId;
    while (id !== undefined && id !== null && chat.nodes[id]) { const n = chat.nodes[id]; out.unshift(n); id = n.parentId; }
    return out;
  },
};
vm.createContext(ctx);
vm.runInContext(read('22-study.js'), ctx);

const NOW = Date.now();
// reps 是"新词 / 学过"的唯一判据，别用 ivl —— 答错的卡 ivl 会被清零
const mk = (id, lang, o = {}) => Object.assign({
  id, lang, front: id, back: '意思', ex: '',
  ease: 2.5, ivl: 0, reps: 0, lapses: 0,
  due: NOW - 1000, created: NOW - 1000, last: 0, log: {}, ipa: '', ipaTried: 0,
}, o);

const reset = (cards) => {
  ctx.state.studyCards = cards;
  ctx.state.studyGroupIds = [];
  ctx.state.studyGroupSize = undefined;
  ctx.state.studyLastKind = 'new';
};

// ── 一大批新词 + 一张要复习的老词：原来那个塌方的最小复现 ──
console.log('\n[1] 新词淹不掉复习');
// ⚠️ 工厂，不是共享数组：下面有几节会把卡片的 reps 改掉模拟"学过了"，
// 共用同一批对象的话后面的用例会读到被前面改过的状态（第一版就是这么假绿的）。
const makeFlood = () => {
  const out = [];
  for (let i = 0; i < 100; i++) out.push(mk('de' + i, 'de', { created: NOW - 5000 + i }));
  for (let i = 0; i < 100; i++) out.push(mk('en' + i, 'en', { created: NOW - 5000 + i }));
  return out;
};
// 学过一轮、今天到期的老词。它的 due 比所有新卡都晚 —— 这正是原来被压在底下的原因
const old1 = mk('old1', 'en', { reps: 3, ivl: 4, due: NOW - 100, created: NOW - 99999 });
reset([old1, ...makeFlood()]);

t('复习队列只装学过的卡（200 张新词一个都不算）', ctx.studyReviewQueue().length === 1 && ctx.studyReviewQueue()[0].id === 'old1');
t('一次能出的新词封顶一组（默认 10），不是 200', ctx.studyGroup().length === 10);
const picked = [];
for (let i = 0; i < 6; i++) { const c = ctx.studyPick(); picked.push(c && c.id); }
t('复习卡在头两张里就轮到（原来要等 200 张新词学完）', picked.slice(0, 2).includes('old1'));

console.log('\n[2] 两门语言都学得到');
reset(makeFlood());
const g = ctx.studyGroup();
t('一组 10 个', g.length === 10);
t('德语英语各一半（一门词库导得再多也挤不掉另一门）',
  g.filter(c => c.lang === 'de').length === 5 && g.filter(c => c.lang === 'en').length === 5);
t('组内严格交替，不是前五个德语后五个英语', g.every((c, i) => i === 0 || c.lang !== g[i - 1].lang));

console.log('\n[3] 只有一门语言时不空转');
reset(makeFlood().filter(c => c.lang === 'de'));
t('只有德语新词也照样凑满一组', ctx.studyGroup().length === 10);
reset([mk('only1', 'en'), mk('only2', 'en')]);
t('新词不够一组就有几个给几个', ctx.studyGroup().length === 2);

console.log('\n[4] 一组学完才开下一组');
reset(makeFlood());
const first = ctx.studyGroup().map(c => c.id);
t('组落盘到 state.studyGroupIds（不存的话每次刷新都换一批，一组永远学不完）',
  ctx.state.studyGroupIds.length === 10 && ctx.state.studyGroupIds.join() === first.join());
t('再取一次还是同一组，不会重挑', ctx.studyGroup().map(c => c.id).join() === first.join());
// 学掉这一组里的一半
for (const id of first.slice(0, 5)) ctx.studyGet(id).reps = 1;
t('学掉一半后组里只剩没答过的 5 个', ctx.studyGroup().length === 5);
t('   而且还是原来那一组，没被补新的进来', ctx.studyGroup().every(c => first.includes(c.id)));
for (const id of first) ctx.studyGet(id).reps = 1;
const second = ctx.studyGroup().map(c => c.id);
t('全学完自动开下一组', second.length === 10 && second.every(id => !first.includes(id)));
t('新组也落了盘', ctx.state.studyGroupIds.join() === second.join());

console.log('\n[5] 复习和新词交替发牌');
reset([
  mk('r1', 'en', { reps: 2, ivl: 3, due: NOW - 300 }),
  mk('r2', 'de', { reps: 2, ivl: 3, due: NOW - 200 }),
  mk('r3', 'en', { reps: 2, ivl: 3, due: NOW - 100 }),
  mk('n1', 'de'), mk('n2', 'en'), mk('n3', 'de'),
]);
const kinds = [];
for (let i = 0; i < 4; i++) { const c = ctx.studyPick(); kinds.push(c && c.reps > 0 ? 'review' : 'new'); }
t('复习/新词交替，不是一边倒', kinds.join() === 'review,new,review,new');
// 一边没货时不该空手而归
reset([mk('r9', 'en', { reps: 2, ivl: 3, due: NOW - 100 })]);
t('只有复习卡时连着两次都给复习（不会因为"轮到新词"就返回 null）',
  ctx.studyPick() && ctx.studyPick() && ctx.studyPick().id === 'r9');
reset([mk('n9', 'de')]);
t('只有新词时同理', ctx.studyPick() && ctx.studyPick() && ctx.studyPick().id === 'n9');
reset([]);
t('一张卡都没有时返回 null', ctx.studyPick() === null);

// 交替游标必须跨启动活着。用户的用法是"聊几句就关掉"，一次会话常常只触发一张卡；
// 游标每次启动都重置的话，第一张永远是复习，复习队列一有积压新词就连着好几天发不出来
// —— 换个触发条件把「有的词好几天都复习不到」原样搬了回来。（Codex 审出来的第 4 条）
// ⚠️ 「重启」必须真的走一遍 _doSave → IDB → loadStateFromDB → 启动赋值。
// 第一版是把值从 ctx.state 取出来又原样写回同一个对象——那什么都没验证：
// 就算生产代码里写成 idbSet('kuro_studyLastKind', 'new')，它照样全绿。
// 所以这里把那三段代码从真源文件里抠出来跑，中间过一次 JSON 序列化。
const idb = {};
const saveGates = (st) => {
  // 第 1 道：_doSave 里那几行 idbSet（从 02-state.js 现抠，写错了这里就跟着错）
  const lines = read('02-state.js').split('\n')
    .filter(l => /idbSet\('kuro_study(GroupSize|GroupIds|LastKind)'/.test(l));
  if (lines.length !== 3) throw new Error('抠不到三行 idbSet，02-state.js 结构变了');
  const fn = new Function('state', 'JSON', 'out',
    lines.map(l => l.trim().replace(/^idbSet\('([^']+)',\s*/, "out['$1'] = (").replace(/\),?$/, ');')).join('\n'));
  fn(st, JSON, idb);
  // 落盘就是落盘：IDB 里躺的是序列化后的值，不是原对象的引用
  for (const k in idb) idb[k] = JSON.parse(JSON.stringify(idb[k]));
};
const loadGates = () => {
  // 第 2 道：loadStateFromDB 的默认值 + 第 3 道：14-boot 的启动赋值，都从源文件现抠
  const g = (k, d) => (idb[k] === undefined ? d : (typeof idb[k] === 'string' && /^[[{"]/.test(idb[k]) ? JSON.parse(idb[k]) : idb[k]));
  const coreLines = read('01-core.js').split('\n').filter(l => /kuro_study(GroupSize|GroupIds|LastKind)'/.test(l));
  if (coreLines.length !== 3) throw new Error('抠不到三行 loadStateFromDB，01-core.js 结构变了');
  const saved = {};
  for (const l of coreLines) {
    const m = l.match(/(\w+):\s*await g\('([^']+)',\s*(.+?)\),?\s*$/);
    saved[m[1]] = g(m[2], new Function('return ' + m[3])());
  }
  const bootLines = read('14-boot-brain-hub.js').split('\n').filter(l => /state\.study(GroupSize|GroupIds|LastKind)\s*=/.test(l));
  if (bootLines.length !== 3) throw new Error('抠不到三行启动赋值，14-boot-brain-hub.js 结构变了');
  const st = {};
  new Function('state', 'saved', 'Number', 'Array', bootLines.map(l => l.trim()).join('\n'))(st, saved, Number, Array);
  return st;
};

const shortSessions = [];
reset([
  mk('sr1', 'en', { reps: 2, ivl: 3, due: NOW - 300 }),
  mk('sr2', 'de', { reps: 2, ivl: 3, due: NOW - 200 }),
  mk('sn1', 'de'), mk('sn2', 'en'),
]);
const cards = ctx.state.studyCards;
for (let day = 0; day < 4; day++) {
  const c = ctx.studyPick();                       // 这一次会话只出一张卡，然后关掉
  shortSessions.push(c && c.reps > 0 ? 'review' : 'new');
  saveGates(ctx.state);                            // 关掉：只有过了三道门的东西活得下来
  const revived = loadGates();                     // 打开：state 从存储重建
  ctx.state = Object.assign({ studyOn: true, studyCards: cards }, revived);
}
t('每次只出一张、中间真·重启（过三道门 + 序列化），四次仍然交替',
  shortSessions.join() === 'review,new,review,new');
t('   游标确实经由 IDB 活过来了', idb['kuro_studyLastKind'] !== undefined);
// 反面：把存进 IDB 的游标改成非法值，启动赋值必须收口成 new 而不是原样带进来
idb['kuro_studyLastKind'] = 'garbage';
t('存了非法游标时启动收口成 new', loadGates().studyLastKind === 'new');
idb['kuro_studyGroupSize'] = '0';
t('存了非法组大小时启动收口成 10', loadGates().studyGroupSize === 10);

console.log('\n[6] 答错的老词算复习，不算新词');
// 答错 → ivl 清零 → 如果拿 ivl 判"新词"，刚答错的词会被丢回新词队列重新排队
const wrong = mk('w1', 'de', { reps: 5, lapses: 2, ivl: 0, due: NOW - 10 });
reset([wrong, mk('nw', 'en')]);
t('答错清零 ivl 的老词仍在复习队列里', ctx.studyReviewQueue().some(c => c.id === 'w1'));
t('   而且没混进新词组', !ctx.studyGroup().some(c => c.id === 'w1'));

console.log('\n[7] 组大小可配');
reset(makeFlood());
ctx.state.studyGroupSize = 5;
ctx.state.studyGroupIds = [];
t('设成 5 就是 5 个', ctx.studyGroup().length === 5);
ctx.studySetGroupSize(20);
t('studySetGroupSize 立刻换组', ctx.studyGroup().length === 20 && ctx.state.studyGroupSize === 20);
ctx.studySetGroupSize(999);
t('越界的值被拒（不是悄悄取个默认）', ctx.state.studyGroupSize === 20);
ctx.state.studyGroupSize = 0;
ctx.state.studyGroupIds = [];
t('存了个非法值时回落到默认 10', ctx.studyGroup().length === 10);

console.log('\n[8] 出题指令用对队列');
reset(makeFlood());   // 全是新词，一张到期复习都没有
const chat = { nodes: { 1:{id:1,parentId:null,role:'user',content:'聊天'}, 2:{id:2,parentId:1,role:'ai',content:''} }, headId: 2 };
let out = ctx.studyProcessTags('看看这个 [[REVIEW]]', { chat, autoOffer: false });
t('[[REVIEW]] 在只有新词时被抹掉，不拿没见过的新词冒充"复习"', !/\[\[CARDQ:/.test(out) && !/REVIEW/.test(out));
out = ctx.studyProcessTags('考拼写 [[SPELL]]', { chat, autoOffer: false });
t('[[SPELL]] 同理（没学过的词凭空拼是刁难）', !/\[\[CARDS:/.test(out));
reset([mk('rv', 'en', { reps: 3, ivl: 2, due: NOW - 50 }), ...makeFlood()]);
out = ctx.studyProcessTags('[[REVIEW]]', { chat, autoOffer: false });
t('有到期复习卡时 [[REVIEW]] 抽的就是它', /\[\[CARDQ:rv\|/.test(out));

// 模型显式点的卡也得记进游标。不记的话，[[REVIEW]] 发了一张复习之后，
// 下一次自动补卡仍以为"上一张是新词"，于是又发复习——连着两张。
// （第一版这里赋值给一个已经删掉的变量，非严格模式下只是凭空造了个全局变量，零报错。）
t('[[REVIEW]] 出完卡把游标记成 review', ctx.state.studyLastKind === 'review');
const afterReview = ctx.studyPick();
t('   于是下一张轮到新词，不会连着两张复习', afterReview && !(afterReview.reps > 0));
reset([mk('sp', 'de', { reps: 3, ivl: 2, due: NOW - 50 }), ...makeFlood()]);
ctx.studyProcessTags('[[SPELL]]', { chat, autoOffer: false });
t('[[SPELL]] 同样算复习', ctx.state.studyLastKind === 'review');
reset(makeFlood());
ctx.state.studyLastKind = 'review';   // 先拨到反面，不然断言恒真（reset 本来就是 new）
ctx.studyProcessTags('[[CARD: en|brandnew|全新的词]]', { chat, autoOffer: false });
t('[[CARD:]] 现教现考算新词', ctx.state.studyLastKind === 'new');

console.log('\n[9] 自动补卡走同一套队列');
reset([old1, ...makeFlood()]);
const chat2 = { nodes: { 1:{id:1,parentId:null,role:'user',content:'聊'}, 2:{id:2,parentId:1,role:'ai',content:''} }, headId: 2 };
out = ctx.studyProcessTags('随便聊两句', { chat: chat2, autoOffer: true, userTurnId: 1 });
t('普通回复后程序仍会兜底补一张', /\[\[CARD[QS]:/.test(out));
reset([]);
const chat3 = { nodes: { 1:{id:1,parentId:null,role:'user',content:'聊'}, 2:{id:2,parentId:1,role:'ai',content:''} }, headId: 2 };
out = ctx.studyProcessTags('随便聊两句', { chat: chat3, autoOffer: true, userTurnId: 1 });
t('一张卡都没有时不补空标签', !/\[\[CARD/.test(out));

console.log('\n[10] 面板统计与持久化');
const src = read('22-study.js');
t('面板"待复习"数的是 studyReviewQueue，不是把新卡也算进去的 studyDue',
  /const review = studyReviewQueue\(\);/.test(src) && /\$\{review\.length\}<\/b><span>待复习/.test(src));
t('面板另有一栏显示本组新词', /<span>本组新词<\/span>/.test(src));
t('组大小的 selected 从 state 现读（写死会被 innerHTML 重画弹回默认）',
  /n === gs \? ' selected' : ''/.test(src));

// 三道白名单，漏一道就是"设置刷新即失且零报错"（见 grancyan2-persist-three-gates）
const stateJs = read('02-state.js'), coreJs = read('01-core.js'), bootJs = read('14-boot-brain-hub.js');
for (const key of ['studyGroupSize', 'studyGroupIds', 'studyLastKind']) {
  // 字符串字段直接存原值、不裹 JSON.stringify（同 kuro_nurseryName），所以只认 key 本身
  t(`${key} 过了第 1 道（_doSave 写盘）`, new RegExp(`idbSet\\('kuro_${key}'`).test(stateJs));
  t(`${key} 过了第 2 道（loadStateFromDB 读回）`, new RegExp(`kuro_${key}'`).test(coreJs));
  t(`${key} 过了第 3 道（启动赋值）`, new RegExp(`state\\.${key}\\s*=`).test(bootJs));
}

// 组状态**不上云**是故意的，不是漏了。2026-10-10 起卡片本身上云了（按「语言+正面」合并，
// 见 tests/study-sync.test.js），但两台各学各的组：同一个词两台的 id 可能不一样，
// 把这台的组推过去，另一台拿到的多半是一串找不到卡片的孤儿 id，每次都得重挑组。
// 上行和下行都要查。只查 push 的话，将来有人只在 merge 那侧加一句，
// 远端的孤儿 id 照样会被合进本地，而这两条断言仍然全绿。
const cloudPush = coreJs.slice(coreJs.indexOf('const settings = {'), coreJs.indexOf('await cloudRetry('));
const cloudMerge = coreJs.slice(coreJs.indexOf('await cloudRetry('), coreJs.indexOf('async function cloudRetry'));
t('前提核实：切出来的推送 / 合并两段都找对了地方', cloudPush.length > 200 && cloudMerge.length > 200 && /studyCards/.test(cloudPush));
t('组状态跟卡片保持一致，上行不上云（孤儿 id 比不同步更坏）',
  !/study(GroupSize|GroupIds|LastKind)/.test(cloudPush));
t('组状态下行也不合并', !/study(GroupSize|GroupIds|LastKind)/.test(cloudMerge));

console.log('\n[11] 桌面与安卓副本一致');
t('android 副本与 js/ 一致', ['22-study.js','01-core.js','02-state.js','14-boot-brain-hub.js'].every(f =>
  fs.readFileSync(path.join(JS, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));
t('android 的 css 也同步了',
  fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
