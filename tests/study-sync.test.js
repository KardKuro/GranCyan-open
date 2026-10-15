// 单词卡跨设备同步（22-study.js 的 studySyncApply / studyCardsMerge）。
// 2026-10-10 电脑的 IndexedDB 被硬杀 exe 弄得整个重建，单词卡只存本机，一张不剩。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js/22-study.js'), 'utf8');
const at = src.indexOf('// ── 手机 ↔ 电脑同步：单词卡');
if (at < 0) { console.log('✗ 22-study.js 里找不到单词卡同步那一段'); process.exit(1); }
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

let saves = 0;
const ctx = { console, JSON, Object, Array, String, Number, Math, Map, Set, Date, parseInt,
  state: {}, save() { saves++; }, studyRefresh() {} };
ctx.studyCards = () => { if (!Array.isArray(ctx.state.studyCards)) ctx.state.studyCards = []; return ctx.state.studyCards; };
vm.createContext(ctx);
vm.runInContext(src.slice(at), ctx);

const T0 = 1785000000000;
const card = (id, front, back, o = {}) => Object.assign({ id, lang: 'de', front, back, ex: '', ease: 2.5, ivl: 0, reps: 0, lapses: 0,
  due: T0, created: T0, last: 0, log: {}, ipa: '', ipaTried: 0 }, o);
const clone = x => JSON.parse(JSON.stringify(x));
const fronts = list => list.map(c => c.front).join(',');
// 模拟一台设备：本机卡片 + 墓碑 + 上次同步的指纹
const dev = (cards, extra = {}) => { ctx.state = Object.assign({ studyCards: clone(cards), studyGone: {}, studySeen: {}, studyBook: null }, extra); saves = 0; };

console.log('\n[单词卡同步]');
const cloud = [card('c1', 'der Tisch', '桌子'), card('c2', 'das Fenster', '窗户', { created: T0 + 1 }), card('c3', 'apple', '苹果', { lang: 'en', created: T0 + 2 })];

dev([]);
ctx.studySyncApply(clone(cloud), {}, null);
t('★ 本机被清空 → 云端的词全回来，而且不会被当成「全删了」', fronts(ctx.state.studyCards) === 'der Tisch,das Fenster,apple'
  && Object.keys(ctx.state.studyGone).length === 0 && saves === 1);

saves = 0;
t('★ 第二次同步一样的东西 → 不改、不落盘', ctx.studySyncApply(clone(ctx.state.studyCards), clone(ctx.state.studyGone), null) === false && saves === 0);

const r = ctx.studyCardsMerge([card('p1', 'der Tisch', '桌子', { reps: 3, last: T0 + 5000 })], [card('d1', 'Der Tisch ', '桌子')], {}, {});
t('★ 两台各自建了同一个词（id 不一样）→ 只留一张，复习过的那张赢', r.cards.length === 1 && r.cards[0].id === 'p1');

// 本机删掉「das Fenster」：上次同步时有，这次没了
dev(cloud);
ctx.studySyncApply(clone(cloud), {}, null);
ctx.state.studyCards = ctx.state.studyCards.filter(c => c.front !== 'das Fenster');
ctx.studySyncApply(clone(cloud), {}, null);
const goneAfterDel = clone(ctx.state.studyGone);
t('★ 本机删掉的词留下墓碑，云端的旧副本不会把它复活', fronts(ctx.state.studyCards) === 'der Tisch,apple' && goneAfterDel['de|das fenster'] > 0);

// 另一台拿到这份墓碑：它手里还是旧的那张，删掉
dev(cloud);
ctx.studySyncApply(clone(cloud), {}, null);
ctx.studySyncApply(clone(cloud.filter(c => c.front !== 'das Fenster')), goneAfterDel, null);
t('★ 另一台拿到墓碑 → 它手里那张也删掉', fronts(ctx.state.studyCards) === 'der Tisch,apple');

const re = ctx.studyCardsMerge([card('n1', 'das Fenster', '窗户', { created: goneAfterDel['de|das fenster'] + 1000 })], [], {}, goneAfterDel);
t('★ 删了之后又重新加的词照样活着', re.cards.length === 1);

// 本机改了释义（没碰 last），另一台还是旧的
dev(cloud);
ctx.studySyncApply(clone(cloud), {}, null);
ctx.state.studyCards.find(c => c.id === 'c1').back = '桌子；餐桌';
ctx.studySyncApply(clone(cloud), {}, null);
const edited = ctx.state.studyCards.find(c => c.id === 'c1');
t('★ 本机改过的卡（指纹变了）盖上新戳，赢过云端的旧版本', edited.back === '桌子；餐桌' && edited.upd > T0);
const pushed = clone(ctx.state.studyCards);

dev(cloud);
ctx.studySyncApply(clone(cloud), {}, null);
ctx.studySyncApply(pushed, {}, null);
t('★ 另一台改过的 → 这边收进来', ctx.state.studyCards.find(c => c.front === 'der Tisch').back === '桌子；餐桌');

const a = [card('x', 'gut', '好', { back: '好的' })], b = [card('y', 'gut', '好')];
t('★ 撞平时两台算出来一样（跟哪边是本机无关）', JSON.stringify(ctx.studyCardsMerge(a, b, {}, {}).cards) === JSON.stringify(ctx.studyCardsMerge(b, a, {}, {}).cards));

dev(cloud);
ctx.studySyncApply(undefined, undefined, undefined);
t('★ 云端还没有这个键（老版本推的）→ 本机一张不丢', ctx.state.studyCards.length === 3);

dev([], { studyBook: { id: 'gk', pos: 30 } });
ctx.studySyncApply([], {}, { id: 'gk', pos: 120 });
const sameBook = ctx.state.studyBook.pos;
dev([], { studyBook: { id: 'gk', pos: 30 } });
ctx.studySyncApply([], {}, { id: 'other', pos: 999 });
t('★ 词书：同一本取到更后面的那个，换书不跟着云端走', sameBook === 120 && ctx.state.studyBook.id === 'gk' && ctx.state.studyBook.pos === 30);

console.log('\n[接线]');
const core = fs.readFileSync(path.join(ROOT, 'js/01-core.js'), 'utf8');
t('★ 推之前跟云端合并，整包里带着单词卡、墓碑和词书进度', /studySyncApply\(cloud\.studyCards, cloud\.studyGone, cloud\.studyBook\)/.test(core)
  && /settings\.studyCards = state\.studyCards;/.test(core) && /settings\.studyGone = state\.studyGone;/.test(core));
t('★ 单词卡在拉下来时也合并进本机', /studySyncApply\(s\.studyCards, s\.studyGone, s\.studyBook\)/.test(core));
const st = fs.readFileSync(path.join(ROOT, 'js/02-state.js'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'js/14-boot-brain-hub.js'), 'utf8');
t('★ 墓碑和指纹三道关都存了（不然刷新后删掉的词会被另一台复活）',
  /idbSet\('kuro_studyGone'/.test(st) && /idbSet\('kuro_studySeen'/.test(st)
  && /g\('kuro_studyGone'/.test(core) && /g\('kuro_studySeen'/.test(core)
  && /state\.studyGone\s*=/.test(boot) && /state\.studySeen\s*=/.test(boot));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
