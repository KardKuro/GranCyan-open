// 聊天里的单词卡跟上刷卡界面（2026-10-03）。跑法：node tests/study-chat-card.test.js —— 全程 mock，不出网。
//
// 守的几件事，坏了都是零报错：
//   · 聊天卡片能标熟 / 取消标熟，同一个词在聊天里的每张卡一起变
//   · 标熟了的那次提问不算「悬着」——标熟不写 log，不放行的话自动出题会被它永久堵住
//   · 回填给模型的那行写明标熟了，模型才不会接着拿这个词考
//   · 正在学的词按这一次的 log 显示点数，不再一律写「10 分钟后再考你一次」
//   · 例句标亮、另外几句、词根、笔记在答完之后才出现（答前露 = 送答案）
//   · 卡片上的每个内联事件都长成渲染消毒放行的形状（不然按钮哑了、零报错）
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')));

// 假 DOM：只认 [data-study-ask="…"] 和 [data-study-ask^="…"] 两种选择器，够 studyRerender / _studyChatRedraw 用
const els = [];
const byId = {};
// outerHTML 记赋值次数：真 DOM 里重画一次就把框里打了一半的字冲掉，哪怕画出来的 HTML 一模一样
const mkEl = (key, mode) => {
  let html = '';
  const e = { dataset: { studyAsk: key, ...(mode ? { studyMode: mode } : {}) }, sets: 0 };
  Object.defineProperty(e, 'outerHTML', { get: () => html, set: v => { html = v; e.sets++; } });
  els.push(e); return e;
};
const document = {
  getElementById: id => byId[id] || null,
  querySelector: () => null,
  querySelectorAll(sel) {
    const m = /\[data-study-ask(\^?)="([^"]+)"\]/.exec(sel);
    if (!m) return [];
    return els.filter(e => m[1] ? e.dataset.studyAsk.startsWith(m[2]) : e.dataset.studyAsk === m[2]);
  },
  addEventListener() {},
};

let saves = 0, toasts = [];
const ta = value => ({ value, focus() {}, setSelectionRange() {} });
const ctx = {
  console, Date, Math, setTimeout, clearTimeout, Promise,
  state: { studyOn: true, studyCards: [], studyGroupIds: [] },
  _call: { on: false },
  save() { saves++; }, showToast(m) { toasts.push(m); }, confirm: () => true, SERVER_BASE: '',
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  Audio: function () { this.play = async () => {}; },
  location: { protocol: 'file:' },
  document,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('js/22-study.js'), ctx);
// 让 outerHTML 赋值真的生效（studyRerender 是 el.outerHTML = …）
els.length = 0;

const NOW = Date.now();
const mk = (id, o = {}) => Object.assign({
  id, lang: 'en', front: id, back: '意思' + id, ex: '',
  ease: 2.5, ivl: 0, reps: 0, lapses: 0, due: NOW - 1000, created: NOW - 1000, last: 0, log: {}, ipa: '',
}, o);
const reset = cards => { ctx.state.studyCards = cards; ctx.state.studyGroupIds = []; els.length = 0; for (const k in byId) delete byId[k]; };

// ── [1] 标熟按钮 ──
console.log('\n[1] 聊天卡片上能标熟');
reset([mk('apple', { back: '苹果', reps: 2, ivl: 4, step: 2 })]);
let h = ctx.studyCardHtml('apple', 'q1');
t('没答的认词卡有「标熟」', /studyChatKnown\('apple'\)/.test(h));
ctx.state.studyCards[0].log.q2 = { g: 2, ts: NOW };
t('答完的认词卡也有（答完发现很熟也来得及）', /studyChatKnown\('apple'\)/.test(ctx.studyCardHtml('apple', 'q2')));
h = ctx.studySpellHtml('apple', 's1');
t('没答的拼写卡也有，而且没把词漏出来', /studyChatKnown\('apple'\)/.test(h) && !/>apple</.test(h), h.slice(0, 300));

// ── [2] 点了标熟 ──
console.log('\n[2] 点标熟：卡上记 known，同一个词的每张聊天卡一起重画');
const e1 = mkEl('apple|q1'), e2 = mkEl('apple|q2'), eS = mkEl('apple|s1', 'spell'), eOther = mkEl('pear|q9');
saves = 0;
ctx.studyChatKnown('apple');
const apple = ctx.studyGet('apple');
t('known 是时间戳、存了盘', typeof apple.known === 'number' && saves > 0);
t('三张 apple 卡都重画了，别的词没动', e1.outerHTML && e2.outerHTML && eS.outerHTML && !eOther.outerHTML);
t('没答的那张：亮出答案、说已标熟、给反悔，不再给评分按钮',
  /study-back">苹果/.test(e1.outerHTML) && /已标熟/.test(e1.outerHTML) && /studyChatUnknow\('apple'\)/.test(e1.outerHTML) && !/studyGrade\(/.test(e1.outerHTML), e1.outerHTML);
t('拼写卡标熟了就不再要她拼：亮出词、没有输入框', />apple</.test(eS.outerHTML) && !/study-spell-in/.test(eS.outerHTML), eS.outerHTML);
t('标熟不写 log（没考过，谈不上答对）', !apple.log.q1 && !apple.log.s1);
t('复习队列里没有它了', !ctx.studyReviewQueue().some(c => c.id === 'apple'));

// ── [3] 悬着的题 ──
console.log('\n[3] 标熟了的那次提问不算悬着');
const chat = { nodes: { n1: { content: '考你一个 [[CARDQ:apple|q1]]' } }, headId: 'n1' };
t('标熟了：不堵自动出题', ctx._studyHasOpenAsk(chat) === false);
delete apple.known;
t('对照：没标熟、没答，照旧算悬着', ctx._studyHasOpenAsk(chat) === true);

// ── [4] 回填给模型 ──
console.log('\n[4] 回填给模型的那行');
t('对照：没标熟没答 = 还没答', /用户：还没答）/.test(ctx.studyTagForApi('[[CARDQ:apple|q1]]')));
apple.known = NOW;
let line = ctx.studyTagForApi('[[CARDQ:apple|q1]]');
t('没答就标熟：写明标熟了', /直接标熟/.test(line) && !/还没答/.test(line), line);
line = ctx.studyTagForApi('[[CARDQ:apple|q2]]');
t('答过的：结果照旧，后面补一句标熟了', /记住了；这个词后来标熟了/.test(line), line);
line = ctx.studyTagForApi('[[CARDS:apple|s1]]');
t('拼写题同理', /拼写题: 苹果 → apple（用户：没拼，直接标熟了/.test(line), line);

// ── [5] 取消标熟 ──
console.log('\n[5] 取消标熟');
ctx.studyChatUnknow('apple');
t('known 删掉、卡片变回评分按钮', !apple.known && /studyGrade\('apple','q1',2\)/.test(e1.outerHTML) === false && /studyChatKnown/.test(e1.outerHTML));
t('没看答案的卡取消后又折回去（看答案按钮回来了）', /studyReveal\('apple','q1'\)/.test(e1.outerHTML), e1.outerHTML.slice(0, 200));

// ── [6] 四个点 ──
console.log('\n[6] 正在学的词显示点，不再一律「10 分钟后」');
reset([mk('learn', { dots: 2 })]);
h = ctx.studyCardHtml('learn', 'a');
t('没答：卡头上亮两个点', (h.match(/<i class="on/g) || []).length === 2 && /学习中/.test(h), h.slice(0, 300));
const lc = ctx.studyGet('learn');
lc.log.b = { g: 2, ts: NOW, learn: 3 };
h = ctx.studyCardHtml('learn', 'b');
t('答对了：按这一次的 log 亮三个点、还差 1 个', (h.match(/<i class="on/g) || []).length === 3 && /还差 1 个点/.test(h) && !/10 分钟后/.test(h), h);
lc.log.c = { g: 0, ts: NOW, learn: 0 };
h = ctx.studyCardHtml('learn', 'c');
t('答错了：点掉空了', /点掉空了/.test(h) && !/10 分钟后/.test(h));
lc.log.d = { g: 2, ts: NOW, learn: 4, grad: true };
t('亮满：学会了', /学会了/.test(ctx.studyCardHtml('learn', 'd')));
reset([mk('rev', { reps: 3, ivl: 7, step: 3, log: { a: { g: 2, ts: NOW } } })]);
t('对照：复习词照旧报下次哪天见', /7 天后再问你/.test(ctx.studyCardHtml('rev', 'a')));
reset([mk('hard', { reps: 3, ivl: 1, lapses: 2, slips: 1 })]);
t('错过三回的标易忘', /study-hard">易忘/.test(ctx.studyCardHtml('hard', 'a')));

// ── [7] 答完才摊开的那一段 ──
console.log('\n[7] 例句标亮 / 另外几句 / 词根 / 笔记：答完才出现');
ctx.GC_WORDBOOKS = { gk: { name: '测试书', lang: 'en', words: [['borrow', '', '借', { r: 'bor', rm: '借', f: ['borrower'] }]] } };
reset([mk('borrow', {
  front: 'borrow', back: '借', reps: 1, ivl: 1, ex: 'I borrowed a <pen>.', exZh: '我借了笔。',
  exMore: [{ ex: 'Can I borrow it?', zh: '能借吗？' }], note: '和 lend <反着>',
})]);
h = ctx.studyCardHtml('borrow', 'x');
t('没看答案：没有例句、词根、笔记', !/study-ex/.test(h) && !/bb-roots/.test(h) && !/lend/.test(h), h);
ctx.studyGet('borrow').log.y = { g: 1, ts: NOW };
h = ctx.studyCardHtml('borrow', 'y');
t('例句里把变形也标亮（borrowed），其余照样转义', /<b class="bb-hl">borrowed<\/b> a &lt;pen&gt;\./.test(h), h);
t('另外几句带上了，各自有喇叭', /Can I <b class="bb-hl">borrow<\/b> it\?/.test(h) && /'ex0'/.test(h) && /能借吗？/.test(h));
t('词根词缀出来了', /bb-roots/.test(h) && /bb-root-chip">bor/.test(h) && /borrower/.test(h));
t('笔记出来了（转义过）', /study-chat-note"[^>]*>📝 和 lend &lt;反着&gt;/.test(h), h);
delete ctx.GC_WORDBOOKS;
t('词书没载进来：不报错，只是没有词根', !/bb-roots/.test(ctx.studyCardHtml('borrow', 'y')));
h = ctx.studySpellHtml('borrow', 'sp');
t('拼写题答前：例句一个字都不露', !/borrow/i.test(h.replace(/'borrow'|"borrow\|sp"/g, '')), h);

// ── [8] 聊天卡片里写笔记 ──
console.log('\n[8] 聊天卡片里写笔记');
reset([mk('cat', { back: '猫', reps: 1, ivl: 1, log: { k: { g: 2, ts: NOW } } })]);
const ek = mkEl('cat|k'), ek2 = mkEl('cat|k2');
ctx.studyGet('cat').log.k2 = { g: 2, ts: NOW };
t('没笔记：给「写笔记」', /studyChatNoteEdit\('cat','k'\)/.test(ctx.studyCardHtml('cat', 'k')));
ctx.studyChatNoteEdit('cat', 'k');
t('点开：这一张出现输入框（id 带 askId）', /id="studyChatNote_k"/.test(ek.outerHTML) && !/studyChatNote_k2/.test(ek.outerHTML));
const setsK = ek.sets, setsK2 = ek2.sets;
ctx._studyChatRedraw('cat');
t('正在写的那张不被别的重画冲掉，另一张照常', ek.sets === setsK && ek2.sets === setsK2 + 1, [ek.sets - setsK, ek2.sets - setsK2]);
byId.studyChatNote_k = ta('  像 cut 少个字母  ');
ctx.studyChatNoteSave('cat', 'k');
t('保存：去掉首尾空白落到卡上，两张卡都显示', ctx.studyGet('cat').note === '像 cut 少个字母' && /像 cut 少个字母/.test(ek.outerHTML) && /像 cut 少个字母/.test(ek2.outerHTML));
ctx.studyChatNoteEdit('cat', 'k');
byId.studyChatNote_k = ta('');
ctx.studyChatNoteSave('cat', 'k');
t('清空保存 = 删掉笔记', !('note' in ctx.studyGet('cat')));
let stopped = 0;
ctx.studyChatNoteEdit('cat', 'k');
ctx.studyChatNoteKey({ key: 'a', stopPropagation() { stopped++; }, preventDefault() {} }, 'cat', 'k');
t('普通按键不冒泡（别撞页面级快捷键）', stopped === 1);
ctx.studyChatNoteKey({ key: 'Escape', stopPropagation() {}, preventDefault() {} }, 'cat', 'k');
t('Esc 取消', ctx._studyChatNoteAt === null && !/textarea/.test(ek.outerHTML));

// ── [9] 面板那边改了，聊天卡跟着变 ──
console.log('\n[9] 面板 / 刷卡界面那边标熟，聊天卡跟着变');
reset([mk('dog', { back: '狗', reps: 1, ivl: 1 })]);
const ed = mkEl('dog|z');
ctx.studyMarkKnown('dog');
t('单词列表里点标熟：聊天卡变成已标熟', /已标熟/.test(ed.outerHTML));
ctx.studyUnknow('dog');
t('列表里取消：聊天卡变回来', /studyChatKnown\('dog'\)/.test(ed.outerHTML) && !/已标熟/.test(ed.outerHTML));

// ── [10] 渲染消毒放行 ──
// 卡片按钮靠内联 onclick；消毒（js/09 的 gcSanitize）不认的形状会被静默拿掉，按钮就哑了。
// 把那几段规则原样切出来，拿卡片上出现的每个 on* 属性过一遍。
console.log('\n[10] 卡片上每个内联事件都过得了渲染消毒');
const SAN = read('js/09-appearance-input.js');
const a0 = SAN.indexOf('const _GC_AUTO_EVENTS'), a1 = SAN.indexOf('function _gcUrlOk');
t('切得到消毒规则', a0 > 0 && a1 > a0);
const sctx = { console };
vm.createContext(sctx);
vm.runInContext(SAN.slice(a0, a1), sctx);
sctx._gcIsAppFn = name => typeof ctx[name] === 'function';
reset([mk('bee', { back: '蜜蜂', reps: 1, ivl: 1, ex: 'A bee.', exMore: [{ ex: 'Bees!', zh: '' }], note: 'n', log: { a: { g: 2, ts: NOW } } })]);
const htmls = [ctx.studyCardHtml('bee', 'a'), ctx.studyCardHtml('bee', 'b'), ctx.studySpellHtml('bee', 'c')];
ctx.studyGet('bee').known = NOW;
htmls.push(ctx.studyCardHtml('bee', 'b'), ctx.studySpellHtml('bee', 'c'));
delete ctx.studyGet('bee').known;
ctx._studyChatNoteAt = 'bee|a';
htmls.push(ctx.studyCardHtml('bee', 'a'));
ctx._studyChatNoteAt = null;
const handlers = [];
for (const x of htmls) for (const m of x.matchAll(/\s(on\w+)="([^"]*)"/g)) handlers.push([m[1], m[2]]);
const bad = handlers.filter(([n, v]) => !sctx._gcHandlerOk(n, v.replace(/&#39;/g, "'")));
const fns = new Set(handlers.map(([, v]) => (/^(\w+)\(/.exec(v) || [])[1]));
t('新按钮都在里面（标熟 / 取消 / 写笔记 / 存 / 取消 / 按键）',
  ['studyChatKnown', 'studyChatUnknow', 'studyChatNoteEdit', 'studyChatNoteSave', 'studyChatNoteCancel', 'studyChatNoteKey'].every(f => fns.has(f)), [...fns]);
t('一个都没被拿掉', handlers.length > 10 && bad.length === 0, bad);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
