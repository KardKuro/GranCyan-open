// 学习卡片：词库导入 + 拼写题回归测试。
// 跑法：node tests/study-spell-import.test.js
//
// 守四件事：
// 1) 英语词库导得进来——真实词表的分隔符（逗号/冒号/破折号/空格）都认，
//    而且语言选了英语之后**不会被面板重画悄悄弹回德语**（这是"英语导不进去"的真身）；
// 2) 示例文案跟着选中的语言变，选英语不再看德语例子；
// 3) 拼写题：答完之前答案绝不出现在 HTML 里（包括 🔊），判分认大小写/空格、
//    德语漏冠词只算"勉强"；
// 4) 拼写题走完 content→blocks→回填模型 整条链路，askId 全程唯一。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');
const read = f => fs.readFileSync(path.join(JS, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

// ── 假 DOM。只要够 studyRefresh / studyDoImport / studySpellSubmit 跑通就行 ──
const nodes = {};
const mkEl = (id) => (nodes[id] = {
  id, value: '', innerHTML: '', placeholder: '', textContent: '', checked: false,
  dataset: {}, classList: { contains: () => false, add() {}, remove() {} },
});
['studyModal', 'studyBody', 'studyToggle', 'studyImportText', 'studyImportHint'].forEach(mkEl);

const ctx = {
  console, Date, setTimeout, clearTimeout,
  state: { studyOn: true, studyCards: [], chats: [] },
  _call: { on: false },
  save() { ctx.__saves = (ctx.__saves || 0) + 1; },
  showToast(m, kind) { (ctx.__toasts = ctx.__toasts || []).push(kind + ': ' + m); },
  confirm: () => true, SERVER_BASE: '',
  escHtml: s => String(s), Audio: function () { this.play = async () => {}; },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  document: {
    getElementById: id => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  getMessagePath(chat, headId) {
    const out = []; let id = headId;
    while (id !== undefined && id !== null && chat.nodes[id]) { out.unshift(chat.nodes[id]); id = chat.nodes[id].parentId; }
    return out;
  },
};
vm.createContext(ctx);
vm.runInContext(read('22-study.js'), ctx);

const spellAsk = s => String(s).match(/\[\[CARDS:([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\]\]/);
const recallAsk = s => String(s).match(/\[\[CARDQ:([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\]\]/);
const freshChat = (extra = {}) => ({
  nodes: { 1: { id: 1, parentId: null, role: 'user', content: '聊聊' }, 2: { id: 2, parentId: 1, role: 'ai', content: '' } },
  headId: 2, ...extra,
});

console.log('\n[1] 真实词表的分隔符');
const parse = raw => ctx.studyParseImport(raw);
const rows = parse([
  'apple | 苹果 | I ate an apple.',   // 正统竖线
  'banana = 香蕉',                     // 等号
  'budget\t预算',                      // Anki 导出的 Tab
  'show up, 出现',                     // 逗号（网页扒的最常见）
  'remind: 提醒',                      // 冒号
  'give up - 放弃',                    // 破折号
  'schedule  日程',                    // 两个空格对齐
  'remember 记住',                     // 单空格：拉丁撞汉字处切
  '# 这行是注释',
  '//这行也是',
  'lonelyword',                        // 只有一栏，丢掉
].join('\n'));
t('十种写法解析出 8 张卡（注释和单栏行被丢）', rows.length === 8);
t('竖线三栏含例句', rows[0].front === 'apple' && rows[0].back === '苹果' && rows[0].ex === 'I ate an apple.');
t('逗号分隔的词组不被拆散', rows[3].front === 'show up' && rows[3].back === '出现');
t('破折号分隔', rows[5].front === 'give up' && rows[5].back === '放弃');
t('单空格靠"拉丁撞汉字"切对', rows[7].front === 'remember' && rows[7].back === '记住');
t('中文释义里的逗号不会被当分隔符', (() => {
  const r = parse('apple | 苹果，苹果树');
  return r.length === 1 && r[0].back === '苹果，苹果树';
})());
t('德语原有格式没被新兜底带坏', (() => {
  const r = parse('der Tisch | 桌子 | Der Tisch ist groß.\ndie Katze = 猫');
  return r.length === 2 && r[0].front === 'der Tisch' && r[1].front === 'die Katze';
})());

console.log('\n[2] 导入语言不再被面板重画弹回德语');
const doImport = (text) => { nodes.studyImportText.value = text; ctx.studyDoImport(); };
ctx.state.studyCards = [];
ctx.studyToggleImport();                      // 展开导入区，radio 才会被渲染出来
t('导入区展开后渲染出两个语言 radio', (nodes.studyBody.innerHTML.match(/name="studyImportLang"/g) || []).length === 2);
ctx.studySetImportLang('en');
doImport('apple | 苹果\nbanana = 香蕉');
t('第一批英语词进来就是英语卡', ctx.state.studyCards.length === 2 && ctx.state.studyCards.every(c => c.lang === 'en'));
t('导入后语言选择仍然是英语', ctx._studyImportLang === 'en');
ctx.studyRefresh(true);                       // 面板整块重画（就是原来把选择弹回 de 的那一步）
t('重画后的 radio 上 checked 落在英语', /value="en"[^>]*checked/.test(nodes.studyBody.innerHTML));
t('重画后德语 radio 不带 checked', !/value="de"[^>]*checked/.test(nodes.studyBody.innerHTML));
doImport('water = 水');
t('第二批仍然是英语卡（原来这里会变成 🇩🇪）', ctx.studyGet(ctx.state.studyCards[2].id).lang === 'en');
t('语言写进 localStorage，下次开面板还记得', ctx.localStorage.getItem('kuro_studyImportLang') === 'en');
t('导入成功的 toast 会说清是哪种语言', (ctx.__toasts || []).some(s => s.includes('英语卡')));

console.log('\n[3] 示例文案跟着语言走');
t('选英语时示例是英语词', nodes.studyImportText.placeholder.includes('apple') && !nodes.studyImportText.placeholder.includes('der Tisch'));
t('英语提示不提德语冠词', !nodes.studyImportHint.textContent.includes('der/die/das'));
ctx.studySetImportLang('de');
t('切回德语示例也跟着换', nodes.studyImportText.placeholder.includes('der Tisch') && !nodes.studyImportText.placeholder.includes('apple'));
t('德语提示提醒带冠词', nodes.studyImportHint.textContent.includes('der/die/das'));
t('重画不会清掉正在粘的词库', (() => {
  nodes.studyImportText.value = '还没导完的一大坨';
  ctx.studyRefresh(true);
  return nodes.studyImportText.value === '还没导完的一大坨';
})());
nodes.studyImportText.value = '';

console.log('\n[4] 漏写语言字段时的猜测');
t('apple 猜英语', ctx._studyGuessLang('apple') === 'en');
t('der Tisch 猜德语', ctx._studyGuessLang('der Tisch') === 'de');
t('带变音字母猜德语', ctx._studyGuessLang('Größe') === 'de');
ctx.state.studyCards = [];
ctx.studyCreate('apple|苹果');                 // 模型漏了语言字段
t('模型漏写语言时英语词不再变成德语卡', ctx.state.studyCards[0].lang === 'en' && ctx.state.studyCards[0].front === 'apple');
ctx.studyCreate('das Buch|书');
t('漏写语言但带冠词的仍判德语', ctx.state.studyCards[1].lang === 'de');

console.log('\n[5] 拼写判分');
const j = (card, typed) => ctx.studySpellJudge(card, typed);
const en = { lang: 'en', front: 'schedule', back: '日程' };
const de = { lang: 'de', front: 'der Tisch', back: '桌子' };
t('拼对了给满分', j(en, 'schedule').g === 2);
t('大小写和首尾空格不算错', j(en, '  Schedule ').g === 2);
t('结尾多个句号不算错', j(en, 'schedule.').g === 2);
t('差一个字母算勉强', j(en, 'schedual').g === 1);
t('完全不沾算不会', j(en, '什么都想不起来').g === 0);
t('什么都没写算不会', j(en, '   ').g === 0);
t('德语漏冠词算勉强并点出冠词', (() => { const r = j(de, 'Tisch'); return r.g === 1 && r.note.includes('der'); })());
t('德语冠词写错也算勉强', (() => { const r = j(de, 'die Tisch'); return r.g === 1 && r.note.includes('der'); })());
t('德语只差一个字母仍算勉强', j(de, 'der Fisch').g === 1);
t('德语换了个词就算不会', j(de, 'der Stuhl').g === 0);

console.log('\n[6] 答完之前不能泄题');
const mature = () => ({
  id: 'm1', lang: 'en', front: 'schedule', back: '日程', ex: 'Check the schedule.',
  ease: 2.5, ivl: 1, reps: 2, lapses: 0, due: Date.now() - 1000, created: 1, last: 1, log: {},
});
ctx.state.studyCards = [mature()];
let html = ctx.studySpellHtml('m1', 'ask1');
t('题面是中文释义', html.includes('日程'));
t('答案不出现在未作答的卡里', !html.includes('schedule'));
t('例句也不提前露（例句里带着答案）', !html.includes('Check the'));
t('未作答时没有 🔊 按钮（一念就是给答案）', !html.includes('studySpeak'));
t('有输入框和交卷按钮', html.includes('study-spell-in') && html.includes('studySpellSubmit'));
t('带 data-study-mode=spell，重画时才知道是拼写题', html.includes('data-study-mode="spell"'));
t('德语拼写题提示要带冠词', (() => {
  ctx.state.studyCards = [{ ...mature(), id: 'd1', lang: 'de', front: 'der Tisch', back: '桌子', ex: '' }];
  return ctx.studySpellHtml('d1', 'a').includes('der/die/das');
})());

console.log('\n[7] 交卷 → 记录 → 回填模型');
ctx.state.studyCards = [mature()];
mkEl('spellIn_ask1').value = 'schedual';
ctx.studySpellSubmit('m1', 'ask1');
const card = ctx.studyGet('m1');
t('作答记在 log[askId] 上并标了题型', card.log.ask1 && card.log.ask1.mode === 'spell' && card.log.ask1.g === 1);
t('记下了他实际写成什么', card.log.ask1.typed === 'schedual');
t('走了同一套 SRS（reps 加一、算出下次到期）', card.reps === 3 && card.due > Date.now());
const repsBefore = card.reps;
ctx.studySpellSubmit('m1', 'ask1');
t('同一道题不会被重复计分', card.reps === repsBefore);
html = ctx.studySpellHtml('m1', 'ask1');
t('答完才显示答案和 🔊', html.includes('schedule') && html.includes('studySpeak'));
t('单词与例句朗读按钮分流', html.includes("studySpeak('m1',event,'example')") && /part === 'example'/.test(read('22-study.js')));
t('答完显示他写错的样子', html.includes('schedual'));
t('回填给模型的是拼写题格式，带他写错的词', (() => {
  const line = ctx.studyTagForApi('[[CARDS:m1|ask1]]');
  return line.includes('拼写题') && line.includes('日程') && line.includes('schedule') && line.includes('schedual');
})());
t('认词卡的回填格式没被带坏', (() => {
  ctx.state.studyCards.push({ ...mature(), id: 'r1', log: { q1: { g: 2, ts: 1 } } });
  const line = ctx.studyTagForApi('[[CARDQ:r1|q1]]');
  return line.includes('卡片:') && line.includes('记住了');
})());
t('想不起来也记一次（0 分，不是无声跳过）', (() => {
  ctx.state.studyCards = [mature()];
  ctx.studySpellGiveUp('m1', 'g1');
  const c = ctx.studyGet('m1');
  return c.log.g1 && c.log.g1.g === 0 && c.log.g1.mode === 'spell' && c.reps === 3;
})());

console.log('\n[8] [[SPELL]] 指令与 blocks 同步');
ctx.state.studyCards = [mature()];
let chat = freshChat();
let run = { autoOffer: true, chat, userTurnId: 1 };
let out = ctx.studyProcessTags('来，这个词你写得出来吗？\n[[SPELL]]', run);
let q = spellAsk(out);
t('[[SPELL]] 换成 [[CARDS:…]]', !!q && q[1] === 'm1');
t('裸标签不会漏进气泡', !out.includes('[[SPELL'));
const blocks = [{ type: 'text', text: '来，这个词你写得出来吗？\n[[SPELL]]' }];
ctx._applyStudyToBlocks(blocks, run);
const qb = spellAsk(blocks[0].text);
t('blocks 拿到同一道题', qb && qb[1] === q[1] && qb[2] === q[2]);
t('一轮里出了拼写题就不再叠自动卡', (out.match(/\[\[CARD[QS]:/g) || []).length === 1 && !run.autoTag);
t('没答完的拼写题会挡住下一张（跟认词卡一视同仁）', (() => {
  chat.nodes[2].content = out; chat.nodes[2].blocks = blocks;
  chat.nodes[3] = { id: 3, parentId: 2, role: 'user', content: '再来' };
  chat.nodes[4] = { id: 4, parentId: 3, role: 'ai', content: '' }; chat.headId = 4;
  const o = ctx.studyProcessTags('接着聊。[[SPELL]]', { autoOffer: true, chat, userTurnId: 3 });
  return !spellAsk(o) && !recallAsk(o);
})());
t('没答过一次的新卡不出拼写题（凭空拼是刁难）', (() => {
  ctx.state.studyCards = [{ ...mature(), reps: 0 }];
  const c = freshChat();
  const o = ctx.studyProcessTags('拼一下？[[SPELL]]', { autoOffer: false, chat: c, userTurnId: 1 });
  return !spellAsk(o);
})());

console.log('\n[9] 自动补卡的题型选择');
t('生词（reps 0）自动补的是认词卡', (() => {
  ctx.state.studyCards = [{ ...mature(), reps: 0, ivl: 0 }];
  const c = freshChat();
  const o = ctx.studyProcessTags('随便聊。', { autoOffer: true, chat: c, userTurnId: 1 });
  return !!recallAsk(o) && !spellAsk(o);
})());
t('熟卡（reps 2）自动补的是拼写题', (() => {
  ctx.state.studyCards = [mature()];
  const c = freshChat();
  const o = ctx.studyProcessTags('随便聊。', { autoOffer: true, chat: c, userTurnId: 1 });
  return !!spellAsk(o);
})());
t('同一张卡不会连着两轮都考拼写（reps 奇偶交替）', ctx._studyAutoSpell({ reps: 2 }) && !ctx._studyAutoSpell({ reps: 3 }));

console.log('\n[10] 渲染与流式');
ctx.state.studyCards = [mature()];
t('存储里的 [[CARDS:]] 渲染成拼写卡', (() => {
  const r = ctx.studyTagToHtml('看这个：[[CARDS:m1|z1]]');
  return r.includes('study-card-spell') && !r.includes('[[CARDS:');
})());
t('认词卡和拼写卡能在同一条消息里共存', (() => {
  const r = ctx.studyTagToHtml('[[CARDQ:m1|z2]] 和 [[CARDS:m1|z3]]');
  return (r.match(/data-study-ask=/g) || []).length === 2
    && (r.match(/data-study-mode="spell"/g) || []).length === 1
    && !r.includes('[[CARD');
})());
t('漏进存储的裸 [[SPELL]] 被抹掉而不是现场挑卡', (() => {
  const r = ctx.studyTagToHtml('前面[[SPELL]]后面');
  return r === '前面后面';
})());
t('流式打字时 [[SPELL]] 不裸露', ctx.maskStreamingStudy('那么 [[SPELL]] 好').includes('出题中') === true
  && !ctx.maskStreamingStudy('那么 [[SPELL]] 好').includes('[[SPELL'));
t('打了一半的 [[SPELL 也遮住', !ctx.maskStreamingStudy('那么 [[SPEL').includes('[[SPEL'));
t('_studyHasAskTag 认得两种题型', ctx._studyHasAskTag('[[CARDQ:a|b]]') && ctx._studyHasAskTag('[[CARDS:a|b]]') && !ctx._studyHasAskTag('[[CARD: en|x|y]]'));

console.log('\n[11] 接线与端侧一致性');
const api = fs.readFileSync(path.join(JS, '05-prompts-api.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/grancyan.css'), 'utf8');
t('回填历史的正则认拼写题（漏了模型就看不见拼写结果）', /\\\[\\\[CARD\(\[QS\]\)/.test(api.replace(/\\/g, '\\\\')) || /CARD\(\[QS\]\)/.test(api));
t('系统提示里写了 [[SPELL]] 用法', /\[\[SPELL\]\]/.test(read('22-study.js')));
t('拼写卡有配套 CSS', /\.study-card-spell/.test(css) && /\.study-spell-in/.test(css));
t('桌面与安卓脚本一致', ['22-study.js', '05-prompts-api.js'].every(f =>
  fs.readFileSync(path.join(JS, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f))))
  && fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
