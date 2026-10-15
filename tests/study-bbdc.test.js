// 刷单词「不背单词手感」+ 内置词书 + 今日打卡 回归测试。
// 跑法：node tests/study-bbdc.test.js  —— 全程 mock，不出网。
//
// 守的几件事，每一件坏了都是零报错：
//   · 回炉（这一轮里没认出来、过几张再考）**不进 SRS**。进了的话一个词错一次、
//     回炉认出来一次，就被算成"不会 + 记住了"，间隔推到明天之后——刚错的词被放跑。
//   · 词书按组补词、pos 只进不退：不这样的话要么一次灌 3000 张卡，要么删掉的书词冒回来。
//   · 标熟的卡两条队列都不进。
//   · 连续打卡从 c.log 现算，今天还没刷不算断。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')));

let saves = 0;
const ctx = {
  console, Date, Math, setTimeout, clearTimeout, Promise,
  state: { studyOn: true, studyCards: [], studyGroupIds: [] },
  _call: { on: false },
  save() { saves++; }, showToast() {}, confirm: () => true, SERVER_BASE: '',
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  Audio: function () { this.play = async () => {}; },
  location: { protocol: 'file:' },          // 不出网：例句/发音预取在 file: 下直接跳过
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('js/22-study.js'), ctx);

// 一本小词书（形状同 js/wordbooks/gk.js）
const BOOK = [];
for (let i = 0; i < 40; i++) BOOK.push(['w' + i, '/w' + i + '/', '释义' + i]);
BOOK.splice(3, 0, ['Apple', '/ˈæpl/', '苹果（书里的）']);
ctx.GC_WORDBOOKS = { gk: { name: '测试书', lang: 'en', words: BOOK } };

const NOW = Date.now();
const mk = (id, lang, o = {}) => Object.assign({
  id, lang, front: id, back: '意思' + id, ex: '',
  ease: 2.5, ivl: 0, reps: 0, lapses: 0,
  due: NOW - 1000, created: NOW - 1000, last: 0, log: {}, ipa: '', ipaTried: 0,
}, o);
const reset = (cards, book) => {
  ctx.state.studyCards = cards;
  ctx.state.studyGroupIds = [];
  ctx.state.studyGroupSize = 5;
  ctx.state.studyLastKind = 'new';
  ctx.state.studyBook = book || null;
};

// ── [1] 词书按组补词 ──
console.log('\n[1] 词书：一组一组补，pos 只进不退');
reset([mk('apple', 'en', { front: 'apple', reps: 2, due: NOW + 9e8 })], { id: 'gk', pos: 0 });
let g = ctx.studyGroup();
t('空库选了书：补出一组（5 个），不是整本', g.length === 5 && ctx.state.studyCards.length === 6, g.length);
t('按书里的顺序取', g.map(c => c.front).join() === 'w0,w1,w2,w3,w4', g.map(c => c.front));
t('书里的音标带进卡片', g[0].ipa === '/w0/' && g[0].src === 'gk');
t('已有的 apple 被跳过（不区分大小写），但也算取过：pos 走到 6', ctx.state.studyBook.pos === 6, ctx.state.studyBook.pos);
ctx.state.studyCards = ctx.state.studyCards.filter(c => c.front !== 'w2');   // 删掉一张书词
g.forEach(c => { c.reps = 1; c.due = NOW + 9e8; });                        // 这一组学完
g = ctx.studyGroup();
t('下一组从 pos 接着取，删掉的 w2 不回来', g.map(c => c.front).join() === 'w5,w6,w7,w8,w9' && !ctx.state.studyCards.some(c => c.front === 'w2'), g.map(c => c.front));

reset([1, 2, 3, 4, 5, 6].map(i => mk('mine' + i, 'en', { created: NOW - 9000 + i })), { id: 'gk', pos: 0 });
g = ctx.studyGroup();
t('自己导入的新词够一组时不从书里补', g.every(c => c.id.startsWith('mine')) && ctx.state.studyBook.pos === 0, ctx.state.studyBook.pos);

reset([], { id: 'gk', pos: 0 });
const saveBook = ctx.GC_WORDBOOKS;
ctx.GC_WORDBOOKS = undefined;
t('书还没载进来：不补、不报错', ctx.studyGroup().length === 0 && ctx.state.studyBook.pos === 0);
ctx.GC_WORDBOOKS = saveBook;

// ── [2] 标熟 ──
console.log('\n[2] 标熟的卡两条队列都不进');
reset([mk('n1', 'en'), mk('n2', 'en', { known: NOW }), mk('r1', 'en', { reps: 2 }), mk('r2', 'en', { reps: 2, known: NOW })]);
t('新词组不含标熟的', ctx.studyGroup().map(c => c.id).join() === 'n1', ctx.studyGroup().map(c => c.id));
t('复习队列不含标熟的', ctx.studyReviewQueue().map(c => c.id).join() === 'r1');
ctx.studyUnknow('n2');
ctx.state.studyGroupIds = [];
t('取消标熟后重新排进来', ctx.studyGroup().some(c => c.id === 'n2'));

// ── [3] 新词：四个点 ──
// 答对当前这张（不管什么题型）
const answerRight = () => {
  const s = ctx._studySession, c = ctx._studySessCard();
  if (s.cur.mode === 'choice') ctx.studySessPick(s.opts.indexOf(c.back));
  else if (s.cur.mode === 'spell') { s.typed = c.front; ctx.studySessSpellSubmit(); }
  else ctx.studySessKnow();
  ctx.studySessNext();
};
console.log('\n[3] 新词：连对 4 次亮满 4 个点才学会，错一次掉空；学习中不进 SRS');
const fresh = () => [mk('a', 'en', { front: 'borrow', back: '借' }),
  mk('b', 'en', { back: '桌子' }), mk('c', 'en', { back: '猫' }), mk('d', 'en', { back: '狗' }), mk('e', 'en', { back: '书' })];
reset(fresh());
ctx.state.studyGroupSize = 5;
ctx.studyStartSession('due');
let s = ctx._studySession;
t('开局：5 张新词都按「四个点」学，第一张是自评', s.learnIds.size === 5 && s.cur.learn && s.cur.mode === 'recall', { n: s.learnIds.size, mode: s.cur.mode });
t('题面上画了 4 个空点', (ctx._studySessionHtml().match(/<i class="">/g) || []).length >= 4 && /bb-dots/.test(ctx._studySessionHtml()));
const firstId = s.cur.id;
const fc = ctx.studyGet(firstId);
ctx.studySessKnow();
t('认识 → 预演亮第一个点（还没落定）', /<i class="on pop">/.test(ctx._studySessionHtml()) && fc.dots === undefined);
ctx.studySessNext();
t('落定：dots=1，reps 仍 0（学习中不进 SRS），log 记一条 learn:1', fc.dots === 1 && fc.reps === 0 && Object.values(fc.log).some(e => e.learn === 1), { dots: fc.dots, reps: fc.reps });
let qi = s.queue.findIndex(q => q.id === firstId);
// 读的时候已经翻到下一张了（它不在队列里），所以「隔四张」在队列里是下标 3
t('答对了隔四张再来，下一关是四选一', qi === 3 && s.queue[qi].mode === 'choice' && s.queue[qi].learn, { qi, q: s.queue[qi] });
let guard = 0;
while (s.cur && s.cur.id !== firstId && guard++ < 20) answerRight();
t('走到它的第二关：四选一，选项含正确答案', s.cur && s.cur.id === firstId && s.cur.mode === 'choice' && s.opts.includes(fc.back), s.opts);
ctx.studySessPick(s.opts.findIndex(o => o !== fc.back));
t('选错 → 预演整排掉空（抖一下）', /bb-dots lose/.test(ctx._studySessionHtml()) && !/<i class="on/.test(ctx._studySessionHtml()));
ctx.studySessNext();
t('落定：点清空 dots=0，记一次 slips，还是不进 SRS', fc.dots === 0 && fc.slips === 1 && fc.reps === 0 && !fc.lapses, { dots: fc.dots, slips: fc.slips, reps: fc.reps });
qi = s.queue.findIndex(q => q.id === firstId);
t('错了隔三张重来，从回想那关开始', qi === 2 && s.queue[qi].mode === 'recall', { qi, q: s.queue[qi] });
guard = 0;
while (s.cur && guard++ < 80) answerRight();
t('一直答对 → 全部学会、到小结页', !s.cur && s.grad.length === 5 && s.passed.size === 5, { cur: s.cur, grad: s.grad.length });
t('学会 = 删掉 dots、第一次进 SRS：reps=1、落在第一个节点（1 天）', fc.dots === undefined && fc.reps === 1 && fc.step === 0 && fc.ivl === 1, { dots: fc.dots, reps: fc.reps, step: fc.step, ivl: fc.ivl });
t('学会那一下记了 grad', Object.values(fc.log).some(e => e.grad === true && e.learn === 4));
t('掉空过的词一共答了 4+2 次（前面对 1 次、错 1 次、再连对 4 次）', Object.keys(fc.log).length === 6, Object.keys(fc.log).length);
const p = ctx._studySessProgress(s);
t('进度条走满', p.done === p.total && p.total === 20, p);
t('小结页：新词学会 5', /这一组刷完了/.test(ctx._studySessionHtml()) && /新词学会 5/.test(ctx._studySessionHtml()));
t('学会的词出组了，下一组可以开', ctx.studyGroup().every(c => c.id !== firstId));

console.log('\n[3b] 聊天里答题：正在学的词算点，从没学过的词照旧直接进复习');
reset([mk('L', 'en', { dots: 3 }), mk('N', 'en')]);
ctx.studyGrade('L', 'q1', 2);
const L = ctx.studyGet('L');
t('第 4 个点在聊天里亮了 → 学会、进 SRS', L.dots === undefined && L.reps === 1 && L.log.q1.grad === true, { dots: L.dots, reps: L.reps });
ctx.studyGrade('N', 'q2', 2);
const N = ctx.studyGet('N');
t('没学过的词聊天里答对 → 直接进复习（不补四个点）', N.dots === undefined && N.reps === 1 && N.ivl === 1);
reset([mk('L2', 'en', { dots: 2 })]);
ctx.studyGrade('L2', 'q3', 1);
t('聊天里模糊 → 掉空', ctx.studyGet('L2').dots === 0 && ctx.studyGet('L2').reps === 0);

// ── [4] 复习词：回炉照旧 ──
console.log('\n[4] 复习词：不认识 → 回炉考四选一，回炉不进 SRS；记错了；回炉选错继续回炉');
const revs = () => [mk('a', 'en', { front: 'borrow', back: '借', reps: 1, step: 0, ivl: 1 }),
  mk('b', 'en', { back: '桌子', reps: 1, step: 0, ivl: 1 }), mk('c', 'en', { back: '猫', reps: 1, step: 0, ivl: 1 }),
  mk('d', 'en', { back: '狗', reps: 1, step: 0, ivl: 1 }), mk('e', 'en', { back: '书', reps: 1, step: 0, ivl: 1 })];
reset(revs());
ctx.studyStartSession('due');
s = ctx._studySession;
t('开局：5 张复习词，第一张是自评，不按四个点', s.learnIds.size === 0 && s.cur.mode === 'recall' && !s.cur.learn);
const rId = s.cur.id;
const rc = ctx.studyGet(rId);
ctx.studySessForgot();
t('不认识 → 展开详情，预告 10 分钟后', s.phase === 'detail' && s.g === 0 && /10 分钟后再来一次/.test(ctx._studySessionHtml()));
ctx.studySessNext();
t('第一次作答进 SRS：reps=2、lapses=1、回到起点', rc.reps === 2 && rc.lapses === 1 && rc.step === -1 && rc.ivl === 0, { reps: rc.reps, lapses: rc.lapses, step: rc.step });
qi = s.queue.findIndex(q => q.id === rId);
t('回炉插在三张之后，考四选一', (qi === 2 || qi === 3) && s.queue[qi].mode === 'choice' && s.queue[qi].retry === true, { qi, q: s.queue[qi] });
guard = 0;
while (s.cur && s.cur.id !== rId && guard++ < 10) answerRight();
ctx.studySessPick(s.opts.indexOf(rc.back));
t('回炉选对 → 绿了，等着翻页', s.phase === 'done' && s.g === 2);
ctx.studySessNext();
t('回炉答对：过关，但 SRS 不再动（reps 仍是 2、log 仍一条）', s.passed.has(rId) && rc.reps === 2 && Object.keys(rc.log).length === 1, { reps: rc.reps, logs: Object.keys(rc.log).length });
guard = 0;
while (s.cur && guard++ < 10) answerRight();
t('全部过关 → 小结页', !s.cur && s.passed.size === 5, { passed: s.passed.size });
t('小结页：复习 5（第一次就认出 4）', /复习 5（第一次就认出 4）/.test(ctx._studySessionHtml()));

reset(revs());
ctx.studyStartSession('due');
s = ctx._studySession;
const id2 = s.cur.id;
ctx.studySessKnow();
t('认识 → 亮释义，可反悔', s.phase === 'known');
ctx.studySessOops();
t('记错了 → 按不认识算', s.phase === 'detail' && s.g === 0);
ctx.studySessNext();
t('记错了进 SRS 的是 0 分', ctx.studyGet(id2).lapses === 1 && ctx.studyGet(id2).ivl === 0);
guard = 0;
while (s.cur && s.cur.id !== id2 && guard++ < 10) { ctx.studySessKnow(); ctx.studySessNext(); }
const wrongIdx = s.opts.findIndex(o => o !== ctx.studyGet(id2).back);
ctx.studySessPick(wrongIdx);
t('回炉选错 → 详情，选项标出对错', s.phase === 'detail' && /bb-opt right/.test(ctx._studySessionHtml()) && /bb-opt wrong/.test(ctx._studySessionHtml()));
ctx.studySessNext();
t('选错了继续回炉', s.queue.some(q => q.id === id2 && q.retry));
t('回炉选错也不再扣 SRS', ctx.studyGet(id2).lapses === 1 && Object.keys(ctx.studyGet(id2).log).length === 1);

console.log('\n[5] 太简单');
reset(fresh());
ctx.studyStartSession('due');
s = ctx._studySession;
const id3 = s.cur.id;
ctx.studySessTooEasy();
const c3 = ctx.studyGet(id3);
t('标熟：c.known 有值，不进 SRS（reps 仍 0、没有 log）', c3.known > 0 && c3.reps === 0 && !Object.keys(c3.log).length);
t('这一轮里不再出现，且算进度', s.cur.id !== id3 && !s.queue.some(q => q.id === id3) && s.known.includes(id3));
const id3b = s.cur.id;
ctx.studySessForgot();
t('答完（详情页）也有标熟按钮', /studySessTooEasy\(\)/.test(ctx._studySessionHtml()));
ctx.studySessTooEasy();
const c3b = ctx.studyGet(id3b);
t('答完再标熟：这次作答不落定（dots 没掉、没 log），直接跳下一张', c3b.known > 0 && c3b.dots === undefined && !Object.keys(c3b.log).length && s.cur.id !== id3b);

console.log('\n[6] 拼写：拼错回炉还是拼写');
reset([mk('s1', 'en', { front: 'budget', back: '预算', reps: 3, due: NOW - 10 })]);
ctx.studyStartSession('due');
s = ctx._studySession;
t('reps=3 的复习词考拼写', s.cur.mode === 'spell', s.cur.mode);
t('拼写题面不露单词、不露例句', !/budget/.test(ctx._studySessionHtml()));
s.typed = 'buget';
ctx.studySessSpellSubmit();
t('差一个字母判「差一点」(g=1)', s.g === 1 && s.phase === 'detail');
ctx.studySessNext();
t('差一点也回炉，回来还是拼写', s.cur && s.cur.id === 's1' && s.cur.mode === 'spell' && s.cur.retry);

// ── [7] 今日 / 打卡 ──
console.log('\n[7] 今日新学 / 复习 / 连续打卡');
const day = 864e5;
const T = new Date(); T.setHours(12, 0, 0, 0);
const at = n => T.getTime() - n * day;
reset([
  mk('x1', 'en', { log: { a: { g: 2, ts: at(0) } } }),                              // 今天第一次 → 新学
  mk('x2', 'en', { log: { a: { g: 2, ts: at(3) }, b: { g: 1, ts: at(0) } } }),      // 以前学过今天又答 → 复习
  mk('x3', 'en', { log: { a: { g: 2, ts: at(1) } } }),
  mk('x4', 'en', { log: { a: { g: 2, ts: at(2) } } }),
  mk('x5', 'en', { log: { a: { g: 2, ts: at(5) } } }),                              // 断在第 4 天
]);
let st = ctx.studyDayStats(T.getTime());
t('今日新学 1、复习 1', st.learned === 1 && st.reviewed === 1, st);
t('连续 4 天（今天、昨天、前天、大前天），第 4 天断了不算', st.streak === 4, st.streak);
t('最近两周：最右是今天且亮着', st.recent.length === 14 && st.recent[13] === true && st.recent[8] === true && st.recent[9] === false, st.recent);
ctx.state.studyCards = ctx.state.studyCards.filter(c => c.id !== 'x1' && c.id !== 'x2');
st = ctx.studyDayStats(T.getTime());
t('今天还没刷：不算断，从昨天数（2 天）', st.streak === 2 && !st.doneToday, st);
reset([
  mk('y1', 'en', { log: { a: { g: 2, ts: at(0), learn: 1 }, b: { g: 2, ts: at(0), learn: 4, grad: true } } }),   // 今天学会
  mk('y2', 'en', { dots: 2, log: { a: { g: 2, ts: at(0), learn: 1 }, b: { g: 2, ts: at(0), learn: 2 } } }),    // 今天学到一半
  mk('y3', 'en', { log: { a: { g: 2, ts: at(2), learn: 4, grad: true }, b: { g: 2, ts: at(0) } } }),           // 前天学会、今天复习
]);
st = ctx.studyDayStats(T.getTime());
t('四个点之后：今天亮满的算新学，学到一半的另算，不混进复习', st.learned === 1 && st.learning === 1 && st.reviewed === 1, st);

// ── [8] 例句标亮 ──
console.log('\n[8] 例句里标亮这个词');
const hl = c => ctx._studyExHtml(c);
t('变形也标：borrow → borrowed', /<b class="bb-hl">borrowed<\/b>/.test(hl({ front: 'borrow', ex: 'I borrowed it.' })));
t('德语卡剥冠词再找', /<b class="bb-hl">Tisch<\/b>/.test(hl({ front: 'der Tisch', ex: 'Unter den Tisch!' })));
t('词中间的同形不标（sun ≠ unsung 里的 sun）', !/bb-hl/.test(hl({ front: 'sun', ex: 'An unsung hero.' })));
t('例句里的 HTML 被转义', /&lt;script&gt;/.test(hl({ front: 'x', ex: '<script>x</script>' })));
t('词组也能标', /<b class="bb-hl">give up<\/b>/.test(hl({ front: 'give up', ex: 'Never give up.' })));

// ── [9] 持久化三道关 + 词书文件 ──
console.log('\n[9] state.studyBook 三道白名单 + 词书文件');
t('loadStateFromDB 读 kuro_studyBook', /studyBook:\s*await g\('kuro_studyBook'/.test(read('js/01-core.js')));
t('_doSave 写 kuro_studyBook', /idbSet\('kuro_studyBook'/.test(read('js/02-state.js')));
t('启动赋值块收 studyBook', /state\.studyBook\s*=/.test(read('js/14-boot-brain-hub.js')));
const bookSrc = read('js/wordbooks/gk.js');
const w = {}; vm.runInNewContext(bookSrc, { window: w });
const gk = w.GC_WORDBOOKS && w.GC_WORDBOOKS.gk;
t('gk.js 载得进来，3000+ 个词', gk && gk.words.length > 3000, gk && gk.words.length);
t('每项都是 [词, /音标/, 释义] 且不空', gk && gk.words.every(x => x[0] && /^\/.+\/$/.test(x[1]) && x[2]));
t('词书里没有学科义项和变形词残留', !/\[计\]|的名词复数|\\r|ә|\^/.test(bookSrc));
t('词书注明 ECDICT 的 MIT 出处', /ECDICT[\s\S]*MIT/.test(bookSrc.slice(0, 400)));
t('词书注明 engra（词根词缀）的 MIT 出处', /engra[\s\S]*MIT/.test(bookSrc.slice(0, 600)));
const gkMap = new Map(gk.words.map(x => [x[0], x[3]]));
const withR = gk.words.filter(x => x[3]).length;
t('三分之一左右的词带词根词缀（1000+）', withR > 1000 && withR < gk.words.length, withR);
t('report 拆成 re-回 + port 拿', /re-回/.test((gkMap.get('report') || {}).m || '') && (gkMap.get('report') || {}).r === 'port', gkMap.get('report'));
t('government：由 govern 变来 + -ment', (gkMap.get('government') || {}).p === 'govern' && /ment/.test((gkMap.get('government') || {}).a || ''));
t('拆解里没有残留的【】［］和词性前缀', gk.words.every(x => !x[3] || ['m', 'pm', 'rm', 'pt'].every(k => !x[3][k] || !/[【】［］]|^[a-z]+\.[；;]/.test(x[3][k]))));

// ── [10] 后端 /api/example 挑句 ──
console.log('\n[10] /api/example：简体优先、长度合适、没查成要抛');
const ipaSrc = read('server/ipa.js');
const from = ipaSrc.indexOf('function pickExample'), to = ipaSrc.indexOf("app.get('/api/example'");
t('切得出 pickExample … fetchExample', from > 0 && to > from);
let nextResp = null;
const sctx = {
  outboundAgent: async () => null,
  axios: { async get() { if (nextResp instanceof Error) throw nextResp; return nextResp; } },
};
vm.createContext(sctx);
vm.runInContext('class IpaLookupFailed extends Error {}\n' + ipaSrc.slice(from, to) + '\nthis.pickExample = pickExample; this.pickExamples = pickExamples; this.fetchExample = fetchExample;', sctx);
const tr = (text, script) => ({ lang: 'cmn', script, text });
const rows = [
  { text: 'Borrow it.', translations: [[tr('借吧。', 'Hans')]] },                             // 太短
  { text: 'I borrow money from him.', translations: [[tr('我跟他借錢。', 'Hant')]] },          // 繁体
  { text: 'Can I borrow your pen today?', translations: [[tr('我今天能借你的笔吗？', 'Hans')]] },
];
const got = sctx.pickExample(rows);
t('跳过太短的、繁体让位给简体', got.ex === 'Can I borrow your pen today?' && got.zh === '我今天能借你的笔吗？', got);
t('只有繁体时用繁体兜底', sctx.pickExample(rows.slice(0, 2)).zh === '我跟他借錢。');
t('一句都没有 → 空（会被缓存成"没有"）', sctx.pickExample([]).ex === '');
(async () => {
  nextResp = { status: 429, data: {} };
  let threw = false; try { await sctx.fetchExample('en', 'x'); } catch (e) { threw = true; }
  t('HTTP 429 → 抛（不缓存），不是当成"没有"', threw);
  nextResp = { status: 200, data: '<html>proxy</html>' };
  threw = false; try { await sctx.fetchExample('en', 'x'); } catch (e) { threw = true; }
  t('200 但结构不对 → 也抛', threw);
  nextResp = { status: 200, data: { data: rows } };
  const ok = await sctx.fetchExample('en', 'borrow');
  t('正常返回 → 挑出一句', ok.ex === 'Can I borrow your pen today?');
  t('还带着好几句（list），第一句就是 ex', Array.isArray(ok.list) && ok.list.length === 3 && ok.list[0].ex === ok.ex, ok.list);
  const many = [
    { text: 'I want to borrow a book today.', translations: [[tr('我今天想借一本书。', 'Hans')]] },
    { text: 'I want to borrow a book, today!', translations: [[tr('我今天想借本书！', 'Hans')]] },     // 同一句换了标点
    { text: 'May I borrow your umbrella now?', translations: [[tr('現在可以借你的傘嗎？', 'Hant')]] },
    { text: 'Could you let me borrow your car tonight?', translations: [[tr('今晚能借我你的车吗？', 'Hans')]] },
    { text: 'Borrow nothing from anyone ever again.', translations: [] },
  ];
  const picked = sctx.pickExamples(many, 3);
  t('多句：最多 3 句、同一句只要一次、简体排在繁体前', picked.length === 3 && picked[0].ex === many[0].text && picked[1].ex === many[3].text && picked[2].zh === '現在可以借你的傘嗎？', picked.map(x => x.ex));
  t('多句：没翻译的只在凑不够时垫底', sctx.pickExamples(many.slice(4), 3)[0].zh === '' && sctx.pickExamples(many, 5).pop().ex === many[4].text);

  // ── [12] 艾宾浩斯节点 ──
  console.log('\n[12] 复习节点：1、2、4、7、15 天…；认识进一格、模糊退一格、不认识回起点');
  const card = mk('z', 'en');
  const ivls = [];
  for (let i = 0; i < 6; i++) { ctx.studySchedule(card, 2); ivls.push(card.ivl); }
  t('一直认识：1 → 2 → 4 → 7 → 15 → 30 天', ivls.join() === '1,2,4,7,15,30', ivls);
  ctx.studySchedule(card, 1);
  t('模糊：退一格（30 → 15）', card.ivl === 15 && card.step === 4, { ivl: card.ivl, step: card.step });
  ctx.studySchedule(card, 0);
  t('不认识：回起点，10 分钟后能再见，记一次 lapses', card.ivl === 0 && card.step === -1 && card.lapses === 1 && card.due - Date.now() < 11 * 60e3);
  ctx.studySchedule(card, 2);
  t('回起点后再认识：从 1 天重新走', card.ivl === 1 && card.step === 0);
  for (let i = 0; i < 20; i++) ctx.studySchedule(card, 2);
  t('走到头就停在最后一个节点（240 天）', card.ivl === 240, card.ivl);
  const legacy = mk('old', 'en', { reps: 4, ivl: 8, ease: 2.5 });              // SM-2 时代的卡，没有 step
  ctx.studySchedule(legacy, 2);
  t('老卡（间隔 8 天、没有 step）落到 7 天那格接着走 → 15 天', legacy.ivl === 15 && legacy.step === 4, { ivl: legacy.ivl, step: legacy.step });
  const d23 = new Date(); d23.setHours(23, 0, 0, 0);
  const due1 = new Date(ctx._studyDueAt(1, d23.getTime()));
  t('晚上 11 点背的词，「1 天后」= 第二天凌晨 4 点就到期', due1.getHours() === 4 && due1.getDate() === new Date(d23.getTime() + 864e5).getDate(), due1.toString());
  const d2 = new Date(); d2.setHours(2, 0, 0, 0);
  t('凌晨 2 点还没睡算前一天：「1 天后」= 当天凌晨 4 点', ctx._studyDueAt(1, d2.getTime()) === new Date(d2).setHours(4, 0, 0, 0));
  t('预告文案：复习词认识/模糊/不认识', ctx._studyPreviewNext({ step: 1, ivl: 2 }, 2, false) === '4天后再见'
    && ctx._studyPreviewNext({ step: 1, ivl: 2 }, 1, false) === '明天再见' && ctx._studyPreviewNext({ step: 1 }, 0, false) === '10 分钟后再来一次');
  t('预告文案：第 4 个点亮了 → 学会了', /学会了/.test(ctx._studyPreviewNext({ dots: 3 }, 2, true)) && ctx._studyPreviewNext({ dots: 1 }, 2, true) === '');
  t('遗忘曲线画出来：走过的实心、正在等的高亮', (() => { const h = ctx._studyCurveHtml({ reps: 3, step: 2, ivl: 4 }); return (h.match(/class="done"/g) || []).length === 2 && /class="cur">4天/.test(h); })());
  t('学到一半的词在列表里画点', /bb-dots/.test(ctx._studyCurveHtml({ reps: 0, dots: 2 })) && /学习中/.test(ctx._studyCurveHtml({ reps: 0, dots: 2 })));

  // ── [13] 例句：一个词好几句（前端）──
  console.log('\n[13] 例句：主例句缺了才补，另外几句总补；老卡再查一次');
  const exCalls = [];
  let exResp = null;
  ctx.SERVER_BASE = 'http://x';
  const zhCalls = [];
  let zhResp = null;
  // 例句接口和翻译接口分开记：补例句之后会顺手去要中文（见 [17]）
  ctx.fetch = async (u, o) => {
    if (u.includes('/api/sentence-zh')) { zhCalls.push(JSON.parse(o.body)); if (zhResp instanceof Error) throw zhResp; return { json: async () => zhResp }; }
    exCalls.push(u); return { json: async () => exResp };
  };
  const flush = () => new Promise(r => setTimeout(r, 5));
  reset([mk('e1', 'en', { front: 'borrow' }), mk('e2', 'en', { front: 'lend', ex: 'Lend me a hand.' }),
         mk('e3', 'en', { front: 'old', ex: 'Old one.', exTried: 1 }), mk('e4', 'en', { front: 'done', exV: 2 })]);
  exResp = { ok: true, ex: 'A.', zh: '甲', list: [{ ex: 'A b c d.', zh: '甲' }, { ex: 'Lend me a hand!', zh: '乙' }, { ex: 'C d e f.', zh: '丙' }] };
  ctx._studyExSoon(ctx.studyGet('e1')); await flush();
  const e1 = ctx.studyGet('e1');
  t('没例句的卡：第一句当主例句，另外两句进 exMore', e1.ex === 'A b c d.' && e1.exZh === '甲' && e1.exMore.length === 2 && e1.exV === 2, { ex: e1.ex, more: e1.exMore });
  ctx._studyExSoon(ctx.studyGet('e2')); await flush();
  const e2 = ctx.studyGet('e2');
  t('自己有例句的卡：主例句不动，句库那几句补进 exMore，和主例句重复的那句（只差标点）不要', e2.ex === 'Lend me a hand.' && e2.exMore.length === 2 && !e2.exMore.some(x => /Lend/.test(x.ex)), e2.exMore);
  const before = exCalls.length;
  ctx._studyExSoon(ctx.studyGet('e3')); await flush();
  ctx._studyExSoon(ctx.studyGet('e4')); await flush();
  t('只查过一句的老卡会再查一次；按多句查过的不再查', exCalls.length === before + 1 && exCalls[exCalls.length - 1].includes('word=old'), exCalls.length - before);
  exResp = { ok: false };
  const e5 = mk('e5', 'en', { front: 'x' }); ctx.state.studyCards.push(e5);
  ctx._studyExSoon(e5); await flush();
  t('没查成（后端报错）不记 exV，下次还能再试', !e5.exV);
  e1.ex = 'I borrowed it.'; e1.exMore = [{ ex: 'We borrow books.', zh: '我们借书。' }];
  reset([e1, mk('o1', 'en', { reps: 1, step: 0, ivl: 1, back: '猫' }), mk('o2', 'en', { reps: 1, step: 0, ivl: 1, back: '狗' }), mk('o3', 'en', { reps: 1, step: 0, ivl: 1, back: '书' })]);
  ctx.location = { protocol: 'file:' }; ctx.SERVER_BASE = '';
  ctx.studyStartSession('due');
  s = ctx._studySession;
  guard = 0; while (s.cur && s.cur.id !== 'e1' && guard++ < 30) answerRight();
  t('题面上只有主例句', /I <b class="bb-hl">borrowed<\/b> it/.test(ctx._studySessionHtml()) && !/We borrow/.test(ctx._studySessionHtml()));
  ctx.studySessKnow();
  t('答完另外几句摊开（也标亮、带翻译、能念）', /We <b class="bb-hl">borrow<\/b> books/.test(ctx._studySessionHtml()) && /我们借书/.test(ctx._studySessionHtml()) && /'ex0'\)/.test(ctx._studySessionHtml()));
  t('念第二句用的是那一句的文本', ctx._studyAudioText(e1, 'ex0') === 'We borrow books.' && ctx._studyAudioText(e1, 'example') === 'I borrowed it.');

  // ── [14] 词根词缀 ──
  console.log('\n[14] 词根词缀：答完才露，按词从词书里查');
  ctx.GC_WORDBOOKS.gk.words.push(['report', '/rɪˈpɔːt/', '报告', { m: 're-回，port 拿，带', r: 'port', rm: '拿，带，运', f: ['import', 'support'] }],
                                ['government', '/g/', '政府', { p: 'govern', pt: '统治', a: '-ment（名词）' }],
                                ['xss', '/x/', 'x', { m: '<img onerror=1>' }]);
  reset([mk('rp', 'en', { front: 'report', back: '报告' }), mk('o1', 'en', { back: '猫' }), mk('o2', 'en', { back: '狗' }), mk('o3', 'en', { back: '书' })]);
  ctx.studyStartSession('due');
  s = ctx._studySession;
  guard = 0; while (s.cur && s.cur.id !== 'rp' && guard++ < 30) answerRight();
  t('答题时不露拆解', !/bb-roots/.test(ctx._studySessionHtml()));
  ctx.studySessKnow();
  const rh = ctx._studySessionHtml();
  t('答完露：词根标签、拆解、同根词', /bb-root-chip">port<i>拿，带，运/.test(rh) && /re-回，port 拿，带/.test(rh) && /同根：import · support/.test(rh));
  t('没有拆解的：显示「由哪个词变来 + 词缀」', /govern（统治） \+ -ment（名词）/.test(ctx._studyRootsHtml({ lang: 'en', front: 'Government' })));
  ctx.GC_WORDBOOKS.gk.words.push(['today', '/t/', '今天', { p: 'day', pt: '天', a: 'to-' }]);
  t('前缀写在前面：to- + day（天）', /to- \+ day（天）/.test(ctx._studyRootsHtml({ lang: 'en', front: 'today' })));
  t('德语卡不查、书里没有的词不画', ctx._studyRootsHtml({ lang: 'de', front: 'report' }) === '' && ctx._studyRootsHtml({ lang: 'en', front: 'zzz' }) === '');
  t('拆解文本转义', /&lt;img/.test(ctx._studyRootsHtml({ lang: 'en', front: 'xss' })));

  // ── [15] 笔记 ──
  console.log('\n[15] 笔记：答完才露，能写能改能清空');
  reset([mk('nt', 'en', { front: 'bear', back: '熊；忍受', note: '<b>两个意思</b>' }), mk('o1', 'en', { back: '猫' }), mk('o2', 'en', { back: '狗' }), mk('o3', 'en', { back: '书' })]);
  ctx.studyStartSession('due');
  s = ctx._studySession;
  guard = 0; while (s.cur && s.cur.id !== 'nt' && guard++ < 30) answerRight();
  t('答题时不露笔记', !/两个意思/.test(ctx._studySessionHtml()));
  ctx.studySessForgot();
  t('答完露笔记（转义过）', /&lt;b&gt;两个意思/.test(ctx._studySessionHtml()));
  ctx.studySessNoteEdit();
  t('点开编辑：出现输入框，草稿带着原笔记', s.noteEdit && /id="studySessNote"/.test(ctx._studySessionHtml()) && s.noteDraft === '<b>两个意思</b>');
  s.noteDraft = '  bear 熊 / bear with 忍受  ';
  ctx.studySessNoteSave();
  t('保存：去掉首尾空白存进卡里', ctx.studyGet('nt').note === 'bear 熊 / bear with 忍受' && !s.noteEdit);
  t('写笔记不影响这次作答（还在详情页、g 没变）', s.phase === 'detail' && s.g === 0);
  ctx.studySessNoteEdit(); s.noteDraft = '   '; ctx.studySessNoteSave();
  t('清空 = 删掉笔记字段', !('note' in ctx.studyGet('nt')));
  ctx.studySessNoteEdit();
  let escaped = false;
  ctx.studyNoteKey({ key: 'Escape', preventDefault() {}, stopPropagation() { escaped = true; } }, ctx.studySessNoteSave, ctx.studySessNoteCancel);
  t('Esc 取消编辑且拦住冒泡（不然会把整个学习面板关掉）', escaped && !s.noteEdit);

  // ── [16] 后端 TTS 磁盘缓存 ──
  console.log('\n[16] 发音磁盘缓存：重启后不用再等 Edge 现合成');
  const os = require('os');
  const ttsDisk = require(path.join(ROOT, 'server', 'tts-disk.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tts-'));
  const disk = ttsDisk.create(tmp);
  const k = ttsDisk.keyOf('en-US-AriaNeural', '+0%', '+0%', 'government');
  await disk.put(k, Buffer.alloc(300, 7));
  const back = await disk.get(k);
  t('存进去读得出来', back && back.length === 300 && back[0] === 7);
  t('不留临时文件', fs.readdirSync(tmp).length === 1 && !fs.readdirSync(tmp)[0].endsWith('.tmp'), fs.readdirSync(tmp));
  fs.writeFileSync(disk.file('half'), Buffer.alloc(50));
  t('半截文件当没有', (await disk.get('half')) === null);
  t('只收短文本（单词、短例句），长文不进', disk.eligible('government') && !disk.eligible('x'.repeat(121)) && !disk.eligible(''));
  const serverSrc = read('server.js');
  t('后端路由的缓存键和 keyOf 是同一个格式（预生成脚本才找得到）', /const cacheKey = voice \+ '\|' \+ rate \+ '\|' \+ pitch \+ '\|' \+ text;/.test(serverSrc)
    && ttsDisk.keyOf('v', 'r', 'p', 't') === 'v|r|p|t');
  // 真路由：切进 vm，内存没有 → 读盘命中 → 不去合成
  const cut = (a, b) => { const i = serverSrc.indexOf(a), j = serverSrc.indexOf(b, i + a.length); return serverSrc.slice(i, j); };
  let route = null, synthCalls = 0;
  const { EventEmitter } = require('events');
  class FakeTTS { setMetadata() { return Promise.resolve(); } toStream() { synthCalls++; const e = new EventEmitter(); setImmediate(() => { e.emit('data', Buffer.alloc(400, 1)); e.emit('close'); }); return { audioStream: e }; } }
  const box = { require: () => ({ MsEdgeTTS: FakeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' } }),
    app: { get: (p, fn) => { if (p === '/api/tts') route = fn; } }, Buffer, console: { warn() {}, error() {} }, Promise, parseInt, setImmediate,
    setTimeout: () => 1, clearTimeout: () => {}, ttsDisk: disk };
  vm.createContext(box);
  vm.runInContext(cut('let _MsEdgeTTS = null', 'const DEEPGRAM_TTS_KEY_FILE')
    + '\nasync function getDeepgramTTSKey() { return ""; }\nasync function synthDeepgramTTS() {}\n'
    + cut("app.get('/api/tts'", '// ==========================================\n// 语音输入'), box);
  const call = q => new Promise(res => { const r = { headers: {}, set(a, b) { this.headers[a] = b; return this; }, status() { return this; },
    json(v) { res({ r: this, body: v }); }, end(b) { res({ r: this, body: b }); } }; route({ query: q }, r); });
  let out = await call({ text: 'government', voice: 'en-US-AriaNeural' });
  t('盘里有的词：直接回，标 disk，不合成', out.r.headers['X-TTS-Cache'] === 'disk' && synthCalls === 0 && out.body.length === 300, { hdr: out.r.headers['X-TTS-Cache'], synthCalls });
  out = await call({ text: 'government', voice: 'en-US-AriaNeural' });
  t('第二次走内存（hit）', out.r.headers['X-TTS-Cache'] === 'hit');
  out = await call({ text: 'abandon', voice: 'en-US-AriaNeural' });
  await new Promise(r => setTimeout(r, 30));
  t('盘里没有的：合成一次，并且存盘', synthCalls === 1 && (await disk.get(ttsDisk.keyOf('en-US-AriaNeural', '+0%', '+0%', 'abandon'))) !== null);
  out = await call({ text: 'x'.repeat(300), voice: 'en-US-AriaNeural' });
  await new Promise(r => setTimeout(r, 30));
  t('长文照常合成但不存盘', synthCalls === 2 && fs.readdirSync(tmp).filter(f => f.endsWith('.mp3')).length === 3, fs.readdirSync(tmp));
  fs.rmSync(tmp, { recursive: true, force: true });
  t('预生成脚本和后端用同一个 keyOf、同一个目录规则', /ttsDisk\.keyOf\(voice, '\+0%', '\+0%', w\)/.test(read('scripts/tts-pregen-book.js')) && /'tts-cache'/.test(read('scripts/tts-pregen-book.js')));
  t('tts-cache 不进 git', /^tts-cache\/$/m.test(read('.gitignore')));

  // ── [17] 例句中文 ──
  console.log('\n[17] 例句中文：缺哪句翻哪句，翻不成这次不再问，句子改了译文作废');
  ctx.location = { protocol: 'http:' }; ctx.SERVER_BASE = 'http://x';
  // （别用 [13] 里出现过的句子：那边后端回的不是翻译格式，已经记进「这次不再问」了）
  const zc = mk('zh1', 'en', { front: 'lend', ex: 'Lend me your pen.', exV: 2,
    exMore: [{ ex: 'He lent me money.', zh: '' }, { ex: 'Can you lend it?', zh: '你能借吗？' }] });
  reset([zc]);
  zhCalls.length = 0;
  zhResp = { ok: true, zh: ['帮我一把。', '他借给我钱。'], pending: 0 };
  const saves0 = saves;
  ctx._studyZhSoon(zc); await flush();
  t('只把缺中文的两句送去翻', zhCalls.length === 1 && JSON.stringify(zhCalls[0].texts) === JSON.stringify(['Lend me your pen.', 'He lent me money.']) && zhCalls[0].lang === 'en', zhCalls);
  t('译文填回主例句和另外那句，存盘', zc.exZh === '帮我一把。' && zc.exMore[0].zh === '他借给我钱。' && zc.exMore[1].zh === '你能借吗？' && saves > saves0);
  ctx._studyZhSoon(zc); await flush();
  t('都有中文了就不再问', zhCalls.length === 1);
  const zd = mk('zh2', 'en', { front: 'x', ex: 'One two three.', exV: 2 });
  reset([zd]);
  zhResp = { ok: true, zh: [''], pending: 1 };           // 电脑上的本地模型没开
  ctx._studyZhSoon(zd); await flush();
  ctx._studyZhSoon(zd); await flush();
  t('没翻成：不瞎填，这次打开 App 不再撞第二次', !zd.exZh && zhCalls.length === 2, zhCalls.length);
  const ze = mk('zh3', 'en', { front: 'y', ex: 'Four five six.', exV: 2 });
  reset([ze]);
  zhResp = new Error('offline');
  ctx._studyZhSoon(ze); await flush();
  ctx._studyZhSoon(ze); await flush();
  t('后端连不上：同样只试一次', !ze.exZh && zhCalls.length === 3);
  const zf = mk('zh4', 'en', { front: 'z', ex: 'Old sentence.', exV: 2 });
  reset([zf]);
  let release;
  zhResp = { ok: true, zh: ['旧句子。'] };
  ctx.fetch = async (u, o) => { zhCalls.push(JSON.parse(o.body)); await new Promise(r => { release = r; }); return { json: async () => zhResp }; };
  ctx._studyZhSoon(zf); await flush();
  zf.ex = 'New sentence.';                                 // 翻回来之前她把句子改了
  release(); await flush();
  t('翻回来之前句子被改了：旧译文不挂到新句子上', !zf.exZh, zf.exZh);
  ctx.fetch = async (u, o) => { zhCalls.push(JSON.parse(o.body)); return { json: async () => ({ ok: true, zh: ['AI 的句子。'] }) }; };
  const n0 = zhCalls.length;
  const added = ctx._studyAdd('en', 'apple', '苹果', 'I ate an apple.');
  await flush();
  t('AI 教词带来的例句：建卡就去要中文', zhCalls.length === n0 + 1 && added.card.exZh === 'AI 的句子。');
  ctx._studyAdd('en', 'pear', '梨', '');
  await flush();
  t('没例句的卡不发请求', zhCalls.length === n0 + 1);
  added.card.exZh = '<我吃了>';
  added.card.log = { a1: { g: 2, ts: NOW } };
  t('聊天里答完的卡显示例句中文（转义过）', /study-ex-zh-chat">&lt;我吃了&gt;/.test(ctx.studyCardHtml(added.card.id, 'a1')));
  t('没看答案之前不显示', !/study-ex-zh-chat/.test(ctx.studyCardHtml(added.card.id, 'a2')));
  ctx.location = { protocol: 'file:' }; ctx.SERVER_BASE = '';

  // 后端：缓存命中不碰模型；模型挂了算 pending 不缓存；回原文不收
  const sz = require(path.join(ROOT, 'server', 'sentence-zh.js'));
  const mem = {};
  const store = { get: (l, x) => mem[sz.keyOf(l, x)] || '', put: (l, x, z) => { mem[sz.keyOf(l, x)] = z; } };
  store.put('en', 'Cached one.', '缓存的。');
  let ollamaCalls = 0, ollamaReply = '模型的译文。', ollamaDown = false;
  const fakeFetch = async (u, o) => {
    ollamaCalls++;
    if (ollamaDown) throw new Error('ECONNREFUSED');
    const body = JSON.parse(o.body);
    return { ok: true, json: async () => ({ message: { content: ollamaReply }, _model: body.model, _think: body.think }) };
  };
  let r = await sz.translate(store, 'en', ['Cached one.', 'Fresh one.', '已经是中文了'], fakeFetch);
  t('缓存有的直接给，没有的交给模型，中文原句跳过', r.zh[0] === '缓存的。' && r.zh[1] === '模型的译文。' && r.zh[2] === '' && ollamaCalls === 1 && r.pending === 0, r);
  t('翻好的进缓存', store.get('en', 'Fresh one.') === '模型的译文。');
  ollamaDown = true; ollamaCalls = 0;
  r = await sz.translate(store, 'en', ['A b.', 'C d.', 'E f.'], fakeFetch);
  t('Ollama 没开：第一句失败就不再试后面的，全算 pending，不缓存', ollamaCalls === 1 && r.pending === 3 && !store.get('en', 'A b.'), { ollamaCalls, r });
  ollamaDown = false; ollamaReply = 'A b.';
  r = await sz.translate(store, 'en', ['A b.'], fakeFetch);
  t('模型回了原文（没汉字）：不收、不缓存', r.zh[0] === '' && r.pending === 1 && !store.get('en', 'A b.'));
  t('cleanZh：剥引号、只取第一行、太长的不要', sz.cleanZh('Hi.', '「你好。」\n（注：打招呼）') === '你好。' && sz.cleanZh('Hi.', '你'.repeat(40)) === '');
  t('键里的空白规整过（同一句多个空格也命中）', sz.keyOf('en', '  Cached   one. ') === sz.keyOf('en', 'Cached one.') && sz.keyOf('fr', 'a') === 'en:a');

  // 落盘先并后写：别的进程写进去的条目不能被冲掉
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zh-'));
  const f = path.join(tdir, 'x.json');
  fs.writeFileSync(f, JSON.stringify({ a: 1, b: 1 }));
  const m2 = { b: 2, c: 3 };
  sz.writeMerged(f, m2);
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  t('writeMerged：盘上的 a 留着，b 以内存为准，c 写进去；内存也拿到 a', onDisk.a === 1 && onDisk.b === 2 && onDisk.c === 3 && m2.a === 1 && fs.readdirSync(tdir).length === 1, onDisk);

  // /api/example 出门前补中文：真挂 ipa.js，缓存里的句子没中文、译文缓存里有
  fs.writeFileSync(path.join(tdir, 'example-cache.json'), JSON.stringify({ 'en:lend': { ex: 'Lend me a hand.', zh: '', list: [{ ex: 'Lend me a hand.', zh: '' }, { ex: 'Lend it.', zh: '借吧。' }] } }));
  fs.writeFileSync(path.join(tdir, 'sentence-zh.json'), JSON.stringify({ [sz.keyOf('en', 'Lend me a hand.')]: '帮个忙。' }));
  const routes = {};
  require(path.join(ROOT, 'server', 'ipa.js')).mount({ get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } },
    { ROOT: tdir, outboundAgent: async () => undefined });
  t('挂上了 POST /api/sentence-zh', typeof routes['POST /api/sentence-zh'] === 'function');
  const got = await new Promise(res => routes['GET /api/example']({ query: { lang: 'en', word: 'lend' } }, { json: res }));
  t('例句接口：没中文的句子从译文缓存补上，本来有的不动', got.ok && got.zh === '帮个忙。' && got.list[0].zh === '帮个忙。' && got.list[1].zh === '借吧。', got);
  fs.rmSync(tdir, { recursive: true, force: true });
  t('译文缓存不进 git', /^sentence-zh\.json$/m.test(read('.gitignore')));

  // ── [18] 全部标成没学过 + 入口角标 ──
  console.log('\n[18] 全部重来：只清进度，留例句笔记和打卡；入口角标只数不动');
  {
    const today = Date.now(), yest = today - 86400000;
    const learned = mk('rl', 'en', { reps: 3, step: 2, ivl: 4, lapses: 1, slips: 2, due: today + 9e8, last: today - 5000,
      ex: 'She sang.', exZh: '她唱了。', note: '我的笔记', ipa: '/x/',
      log: { selfA: { g: 2, ts: yest }, askChat: { g: 2, ts: today - 60000 } } });
    const midway = mk('rm', 'en', { dots: 2, log: { selfB: { g: 2, ts: today - 30000, learn: 2 } } });
    const known = mk('rk', 'en', { known: today - 1000 });
    const fresh = mk('rn', 'en');
    reset([learned, midway, known, fresh]);
    ctx.state.studyGroupIds = ['rm', 'rn'];
    const before = ctx.studyDayStats();
    ctx.confirm = () => false;
    ctx.studyResetAllAsk();
    t('点了取消：什么都不动', learned.reps === 3 && midway.dots === 2 && known.known);
    ctx.confirm = () => true;
    const n = ctx.studyResetAll();
    t('返回原来有进度的个数（学过 / 学到一半 / 标熟 = 3）', n === 3, n);
    t('四张都成了新词', [learned, midway, known, fresh].every(c => ctx._studyIsNew(c) && !ctx._studyLearning(c)));
    t('进度字段清干净', learned.reps === 0 && learned.ivl === 0 && learned.lapses === 0 && learned.step === undefined
      && learned.slips === undefined && midway.dots === undefined && known.known === undefined && learned.due <= Date.now(), learned);
    t('例句 / 中文 / 笔记 / 音标都留着', learned.ex === 'She sang.' && learned.exZh === '她唱了。' && learned.note === '我的笔记' && learned.ipa === '/x/');
    t('作答记录不删（聊天里的旧题还认得是答过的）', Object.keys(learned.log).length === 2 && midway.log.selfB);
    t('旧的一组作废，重挑出来四个都在', ctx.state.studyGroupIds.length === 0 && ctx.studyGroup().length === 4, ctx.state.studyGroupIds);
    t('复习队列空了', ctx.studyReviewQueue().length === 0);
    const chat = { nodes: { a: { content: '考你 [[CARDQ:rl|askChat]]' } } };
    t('聊天里答过的旧题不会变回「悬着」，自动出题不被堵', ctx._studyHasOpenAsk(chat) === false);
    const after = ctx.studyDayStats();
    t('重来之前的作答不再算今日新学 / 复习', before.reviewed + before.learned > 0 && after.learned === 0 && after.reviewed === 0 && after.learning === 0, { before, after });
    t('打卡天数不断', after.doneToday && after.streak === before.streak && after.streak >= 2, after);
    // 重来之后再学：照常算
    ctx.studyGrade('rl', 'askNew', 2);
    t('重来之后聊天里答对：直接进复习，算今日新学', learned.reps === 1 && ctx.studyDayStats().learned === 1, ctx.studyDayStats());

    // 入口角标：只数，不补词、不落盘、不改组
    reset([mk('d1', 'en', { reps: 2, due: today - 10 }), mk('d2', 'en', { reps: 2, due: today + 9e8 }), mk('n1', 'en'), mk('n2', 'en')], { id: 'gk', pos: 0 });
    const s0 = saves, cards0 = ctx.state.studyCards.length;
    let tc = ctx.studyTodoCount();
    t('角标：1 个到期复习 + 下一组 5 个（2 张新卡 + 书里还有，凑满一组）', tc.review === 1 && tc.fresh === 5 && tc.total === 6, tc);
    t('数一遍不补词、不落盘、不改组', saves === s0 && ctx.state.studyCards.length === cards0 && ctx.state.studyGroupIds.length === 0 && ctx.state.studyBook.pos === 0);
    ctx.state.studyGroupIds = ['n1', 'n2'];
    tc = ctx.studyTodoCount();
    t('当前组还有词：只数组里剩的', tc.fresh === 2 && tc.total === 3, tc);
    ctx.state.studyBook = null; ctx.state.studyGroupIds = [];
    ctx.state.studyCards.forEach(c => { c.reps = 2; c.due = today + 9e8; });
    t('全刷完：0', ctx.studyTodoCount().total === 0);
    // 角标真的画到两个入口上
    const els = {};
    const mkEl = () => ({ textContent: '', title: '', classList: { _h: true, toggle(k, on) { this._h = on; } } });
    ['studyEntryBadge', 'studyHeadBadge', 'studyEntryBtn'].forEach(id => { els[id] = mkEl(); });
    const oldGet = ctx.document.getElementById;
    ctx.document.getElementById = id => els[id] || null;
    ctx.state.studyCards[0].due = today - 10;
    ctx.studyEntryBadge();
    t('两个入口都显示 1，没藏', els.studyEntryBadge.textContent === '1' && els.studyHeadBadge.textContent === '1' && !els.studyEntryBadge.classList._h && !els.studyHeadBadge.classList._h, els);
    ctx.state.studyCards[0].due = today + 9e8;
    ctx.studyRefresh();          // 面板没开（studyModal 取不到）也要更新角标
    t('刷完了：studyRefresh 顺手把角标藏起来', els.studyEntryBadge.classList._h && els.studyHeadBadge.classList._h && /刷完/.test(els.studyEntryBtn.title));
    ctx.document.getElementById = oldGet;
  }

  // ── [11] 安卓副本 ──
  console.log('\n[11] android 副本与 js/ 一致');
  const same = f => { try { return read(f) === read('android/assets/' + f); } catch (e) { return false; } };
  t('22-study.js / 词书 / 三道关文件 / css / index.html 都同步了',
    ['js/22-study.js', 'js/wordbooks/gk.js', 'js/01-core.js', 'js/02-state.js', 'js/14-boot-brain-hub.js', 'css/grancyan.css'].every(same));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
