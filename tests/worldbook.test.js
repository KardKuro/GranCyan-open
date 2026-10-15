// 世界书（js/60-worldbook.js）回归测试。
// 跑法：node tests/worldbook.test.js
//
// 守的几件事，都是「错了也不报错，只是悄悄多花钱 / 悄悄丢东西」的那种：
//   1) 没命中时，整份系统提示（stable + volatile）跟没装世界书时**逐字节一样**——一个字都不多；
//   2) 命中了只进 volatile，stable 一字不动（进 stable 等于每命中一次缓存全废一次）；
//   3) 总长上限：按优先级从高往低装，装不下的整条跳过，不截半条；
//   4) 判定细节：扫描深度、AI 上一句也算、次级关键词、正则、作用范围、开关；
//   5) 语义路：比「闲聊底噪」高出一截才算，过期的结果（换了一句话）不认；
//   6) 酒馆格式导入/导出、云同步合并（墓碑、收敛）、持久化三道关。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

// 时间钉死：volatile 里有「Current time」，不钉的话跨分钟就没法逐字节比
const FIX = Date.parse('2026-10-03T12:00:00Z');
class FDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(FIX); }
  static now() { return FIX; }
}

function makeCtx(withWorldbook, wb) {
  const ctx = {
    console, Date: FDate, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number, RegExp, Promise, Float32Array,
    fetch: async () => ({ ok: true }),
    state: {
      memories: [{ text: '小明喜欢深色界面', enabled: true }],
      userName: '小明', bandAiEnabled: false, webSearchApiKey: '', studyOn: false,
      configs: [{ id: 'm1', nickname: '克克' }, { id: 'm2', nickname: '小二' }],
      worldbook: wb,
    },
    _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
    save() {}, showToast() {}, escHtml: s => String(s),
    estimateTokens: s => Math.ceil(String(s || '').length / 4),
    pickBrainMemories: () => [],
    formatBrainForPrompt: () => '',
    takeProustMoment: () => '',
    stickerTagForApi: s => String(s || ''),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/05-prompts-api.js'), ctx);
  if (withWorldbook) vm.runInContext(read('js/60-worldbook.js'), ctx);
  return ctx;
}

const conf = { id: 'm1', nickname: '克克', modelName: 'claude-opus-5', apiBase: 'https://api.anthropic.com/v1/messages', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
const U = s => ({ role: 'user', content: s });
const AI = s => ({ role: 'ai', content: s });
const E = (o) => Object.assign({ id: 'e' + Math.random().toString(36).slice(2, 8), title: '条目', keys: [], content: '正文', priority: 100, on: true, ver: 1 }, o);
const book = (entries, extra) => Object.assign({ on: true, budget: 2000, depth: 2, ver: 0, entries, del: {} }, extra || {});

function build(ctx, p, c) {
  const out = {};
  const full = ctx.buildSystemPrompt(c || conf, chat, '', p, out);
  return { full, stable: out.stable, volatile: out.volatile };
}

// ── 1) 没命中时一个字都不多 ──
console.log('\n[1] 没命中：系统提示逐字节不变');
const pathMiss = [U('今天好冷'), AI('多穿点'), U('嗯嗯 晚上吃火锅')];
const base = build(makeCtx(false), pathMiss);
const wbMissBook = book([
  E({ title: '下雨的写法', keys: ['下雨', '雨伞'], content: '雨声写细一点，先落在窗沿。' }),
  E({ title: '只给小二', keys: ['火锅'], content: '小二专用', scope: 'm2' }),
  E({ title: '关着的', keys: ['火锅'], content: '关着的条目', on: false }),
  E({ title: '空正文', keys: ['火锅'], content: '   ' }),
]);
const miss = build(makeCtx(true, wbMissBook), pathMiss);
t('世界书·没命中时 stable 跟没装世界书时逐字节一样', miss.stable === base.stable);
t('世界书·没命中时 volatile 跟没装世界书时逐字节一样', miss.volatile === base.volatile);
t('世界书·别的角色专用的条目不进这个角色', !/小二专用/.test(miss.full));
t('世界书·关掉的条目不进', !/关着的条目/.test(miss.full));
const offAll = build(makeCtx(true, book([E({ keys: ['火锅'], content: '总开关关了也不该进' })], { on: false })), pathMiss);
t('世界书·总开关关了，命中也一个字不多', offAll.full === base.full);
const noState = build(makeCtx(true, undefined), pathMiss);
t('世界书·state 里压根没有 worldbook（老用户第一次升级）也一个字不多', noState.full === base.full);

// ── 2) 命中只进 volatile ──
console.log('\n[2] 命中：只进 volatile');
const pathHit = [U('今天好冷'), AI('外面阴天了'), U('好像要下雨了')];
const ctxHit = makeCtx(true, wbMissBook);
const hit = build(ctxHit, pathHit);
const lastPick = vm.runInContext('_wbLast', ctxHit);
const baseHit = build(makeCtx(false), pathHit);
t('世界书·命中后 stable 一字未变', hit.stable === baseHit.stable);
t('世界书·命中的正文进了 volatile', /雨声写细一点，先落在窗沿/.test(hit.volatile) && /【下雨的写法】/.test(hit.volatile));
t('世界书·命中的正文不在 stable 里', !/雨声写细/.test(hit.stable) && !/世界书/.test(hit.stable));
t('世界书·volatile 只是在原来后面多了这一段', hit.volatile.startsWith(baseHit.volatile));
const msgs = [{ role: 'system', content: hit.full }, U('第一句'), AI('回答'), U('好像要下雨了')];
ctxHit.relocateVolatilePrompt(msgs, { stable: hit.stable, volatile: hit.volatile });
t('世界书·挪完之后 system 里没有世界书，最后一条用户消息里有',
  !/雨声写细/.test(msgs[0].content) && /雨声写细/.test(msgs[3].content));
const hit2 = build(ctxHit, [U('换个话题'), AI('好'), U('明天去哪玩')]);
t('世界书·下一轮没聊到就没了（不粘着）', !/雨声写细/.test(hit2.volatile));
t('世界书·上一轮记录给面板看（命中理由带着触发词）', !!lastPick && lastPick.items.length === 1
  && lastPick.items[0].title === '下雨的写法' && /下雨/.test(lastPick.items[0].why));

// ── 3) 判定细节 ──
console.log('\n[3] 判定细节');
const ctxD = makeCtx(true, book([
  E({ title: 'AI句', keys: ['阴天'], content: 'AI 上一句里的词' }),
  E({ title: '太早', keys: ['好冷'], content: '三条之前的词' }),
  E({ title: '且', keys: ['下雨'], keys2: ['雨伞'], content: '要同时有雨伞' }),
  E({ title: '正则', keys: ['/带(上|着)雨伞/'], content: '正则命中' }),
  E({ title: '坏正则', keys: ['/([/'], content: '坏正则不该炸也不该命中' }),
  E({ title: '大小写', keys: ['Umbrella'], content: '不分大小写' }),
  E({ title: 'HTML', keys: ['think-block'], content: '不该命中 class 名' }),
]));
const d1 = build(ctxD, [U('今天好冷'), AI('<div class="think-block">外面阴天了</div>'), U('好像要下雨了 umbrella')]);
t('世界书·AI 上一句里的触发词也算（默认看 2 条）', /AI 上一句里的词/.test(d1.volatile));
t('世界书·超出扫描深度的那条不算', !/三条之前的词/.test(d1.volatile));
t('世界书·次级关键词没对上就不进', !/要同时有雨伞/.test(d1.volatile));
t('世界书·关键词不分大小写', /不分大小写/.test(d1.volatile));
t('世界书·坏正则不炸、不命中', !/坏正则不该炸/.test(d1.volatile));
t('世界书·HTML 标签里的字不算命中', !/不该命中 class 名/.test(d1.volatile));
const d2 = build(ctxD, [AI('嗯'), U('带上雨伞吧，要下雨了')]);
t('世界书·次级关键词对上了就进', /要同时有雨伞/.test(d2.volatile));
t('世界书·/…/ 写法按正则', /正则命中/.test(d2.volatile));
ctxD.state.worldbook.depth = 3;
const d3 = build(ctxD, [U('今天好冷'), AI('嗯'), U('好')]);
t('世界书·扫描深度调大后，早一点的那条也算', /三条之前的词/.test(d3.volatile));
const ctxF = makeCtx(true, book([E({ keys: ['名字'], content: '叫{{user}}，你是{{char}}' })]));
t('世界书·{{user}} {{char}} 换成名字', /叫小明，你是克克/.test(build(ctxF, [U('叫我名字')]).volatile));

// ── 4) 总长上限 ──
console.log('\n[4] 总长上限：按优先级截');
const L = n => 'x'.repeat(n);
const ctxB = makeCtx(true, book([
  E({ id: 'a', title: 'A', keys: ['火'], content: 'AAA' + L(180), priority: 10 }),
  E({ id: 'b', title: 'B', keys: ['火'], content: 'BBB' + L(140), priority: 5 }),
  E({ id: 'c', title: 'C', keys: ['火'], content: 'CCC' + L(40), priority: 1 }),
  E({ id: 'd', title: 'D', keys: ['火'], content: 'DDD' + L(400), priority: 99 }),
], { budget: 300 }));
const b1 = build(ctxB, [U('火锅')]);
t('世界书·上限内优先级高的先装', /AAA/.test(b1.volatile));
t('世界书·装不下的那条整条扔掉', !/BBB/.test(b1.volatile));
t('世界书·跳过之后短的低优先级还能塞进去', /CCC/.test(b1.volatile));
t('世界书·比上限还长的那条不进、也不截半条', !/DDD/.test(b1.volatile));
const used = (b1.volatile.match(/【[ABCD]】\n[A-Z]{3}x*/g) || []).reduce((s, x) => s + x.length, 0);
t('世界书·条目正文加起来不超过上限', used > 0 && used <= 300);
t('世界书·优先级高的排在前面', b1.volatile.indexOf('AAA') < b1.volatile.indexOf('CCC'));
const cutRec = vm.runInContext('_wbLast', ctxB);
t('世界书·被挤掉的记下来给面板看', !!cutRec && cutRec.cut.map(x => x.id).sort().join() === 'b,d');

// ── 5) 常驻 ──
console.log('\n[5] 常驻条目进 stable');
const ctxA = makeCtx(true, book([
  E({ id: 'k', title: '世界观', always: true, content: '这里是一座海边小城', priority: 1 }),
  E({ id: 'h', title: '命中', keys: ['海'], content: '海的写法' }),
]));
const a1 = build(ctxA, [U('早上好')]);
const a2 = build(ctxA, [U('去看海吧')]);
t('世界书·常驻条目进 stable、不进 volatile', /海边小城/.test(a1.stable) && !/海边小城/.test(a1.volatile));
t('世界书·常驻条目每轮一样，stable 不随话题变', a1.stable === a2.stable);
t('世界书·常驻在 stable、命中在 volatile 各管各的', /海的写法/.test(a2.volatile) && !/海的写法/.test(a2.stable));

// ── 6) 语义路 ──
console.log('\n[6] 语义路');
(async () => {
  const vecs = {
    '想出门走走': [0, 1, 0],
    'Q:今晚好想出去散散步': [0.2, 0.98, 0],
    'Q:今天午饭吃什么': [1, 0, 0],
    'Q:模棱两可': [0.7071, 0.7071, 0],
  };
  const vecOf = s => vecs[s] || [1, 0, 0];   // 底噪句全在 x 轴上
  const ctxS = makeCtx(true, book([
    E({ id: 's', title: '散步', keys: ['__不会命中的词__'], sem: true, semText: '想出门走走', content: '语义命中的正文' }),
  ]));
  ctxS._brainVec = { pipe: true };
  ctxS._brainVecOn = () => true;
  ctxS.BRAIN_VEC_QPREFIX = 'Q:';
  ctxS._brainVecRun = async (input) => ({ tolist: () => (Array.isArray(input) ? input : [input]).map(vecOf) });
  const run = async (q) => { const p = [AI('嗯'), U(q)]; await ctxS.worldbookPrepare(p, conf); return build(ctxS, p); };
  t('世界书·意思对上了（比底噪高出一截）就翻出来', /语义命中的正文/.test((await run('今晚好想出去散散步')).volatile));
  t('世界书·闲聊不触发语义条目', !/语义命中的正文/.test((await run('今天午饭吃什么')).volatile));
  t('世界书·得分不低但跟闲聊一样高，不算（比的是差值不是绝对值）', !/语义命中的正文/.test((await run('模棱两可')).volatile));
  await ctxS.worldbookPrepare([U('今晚好想出去散散步')], conf);
  t('世界书·语义结果绑在那句话上：换了一句就不认上一句的', !/语义命中的正文/.test(build(ctxS, [U('今天午饭吃什么')]).volatile));
  ctxS._brainVec = { pipe: null };
  let kicked = 0;
  ctxS._brainVecLoad = () => { kicked++; return new Promise(() => {}); };
  const tm = Date.now();
  await ctxS.worldbookPrepare([U('别的话')], conf);
  t('世界书·模型没加载好：踢一脚就走，不等', kicked === 1 && Date.now() - tm < 500);

  // ── 7) 酒馆导入 / 导出 ──
  console.log('\n[7] 酒馆格式');
  const ctxI = makeCtx(true, book([]));
  const st = { entries: {
    0: { uid: 0, key: ['下雨', '雨伞'], keysecondary: ['伞'], selective: true, selectiveLogic: 0, comment: '雨天', content: '雨天的正文', order: 120, constant: false, disable: false },
    1: { uid: 1, key: ['世界'], keysecondary: ['x'], selective: true, selectiveLogic: 2, comment: '非且', content: 'NOT ANY 的', order: 50, disable: true },
    2: { uid: 2, key: [], comment: '常驻', content: '世界观正文', constant: true },
    3: { uid: 3, key: ['空'], content: '' },
  } };
  const r1 = ctxI.wbImport(JSON.stringify(st), '酒馆书');
  const es = ctxI.state.worldbook.entries;
  const rain = es.find(e => e.title === '雨天');
  t('世界书·导入酒馆世界书：条数对（空正文的跳过）', r1.added === 3 && es.length === 3);
  t('世界书·导入：关键词、次级词、优先级、分组都带过来', rain && rain.keys.join() === '下雨,雨伞' && rain.keys2.join() === '伞' && rain.priority === 120 && rain.group === '酒馆书');
  t('世界书·导入：非「且」逻辑的次级词不硬套（意思会反）', es.find(e => e.title === '非且').keys2.length === 0 && r1.dropped2 === 1);
  t('世界书·导入：disable 的导进来是关着的', es.find(e => e.title === '非且').on === false);
  t('世界书·导入：constant 变常驻', es.find(e => e.title === '常驻').always === true);
  const r2 = ctxI.wbImport(JSON.stringify(st), '酒馆书');
  t('世界书·同一个文件导两次不翻倍', r2.added === 0 && r2.dup === 3 && ctxI.state.worldbook.entries.length === 3);
  const card = { spec: 'chara_card_v2', data: { name: '某角色', character_book: { entries: [
    { keys: ['海'], secondary_keys: [], content: '卡里的条目', enabled: true, insertion_order: 7, name: '海边' } ] } } };
  const r3 = ctxI.wbImport(card);
  const sea = ctxI.state.worldbook.entries.find(e => e.title === '海边');
  t('世界书·导入角色卡里嵌的 character_book', r3.added === 1 && sea && sea.priority === 7 && sea.group === '某角色');
  let threw = false; try { ctxI.wbImport('{"nope":1}'); } catch (_) { threw = true; }
  t('世界书·认不出的文件报错，不静默导入 0 条', threw);
  sea.sem = true; sea.semText = '想去海边';
  const exp = ctxI.wbToTavern(ctxI.state.worldbook.entries);
  const ctxI2 = makeCtx(true, book([]));
  ctxI2.wbImport(JSON.stringify(exp));
  const back = ctxI2.state.worldbook.entries;
  const sea2 = back.find(e => e.title === '海边');
  t('世界书·导出再导入：条数、语义设置、分组都还在', back.length === 4 && sea2 && sea2.sem && sea2.semText === '想去海边' && sea2.group === '某角色');
  t('世界书·导出格式酒馆认得（entries 是对象、有 key/content/order）', !Array.isArray(exp.entries) && exp.entries[0].key && 'order' in exp.entries[0]);
  t('世界书·导入 BOM 开头的文件', ctxI2.wbImport('﻿' + JSON.stringify({ entries: [{ key: ['b'], content: 'bom' }] })).added === 1);

  // ── 8) 云同步合并 ──
  console.log('\n[8] 云同步合并');
  const M = ctxI.wbMerge;
  const x = { id: 'x', title: 'X', keys: ['k'], content: 'v1', ver: 1 };
  const A = book([x, { id: 'y', title: 'Y', keys: ['k'], content: 'Y', ver: 3 }]);
  const B = book([Object.assign({}, x, { content: 'v2', ver: 2 }), { id: 'z', title: 'Z', keys: ['k'], content: 'Z', ver: 1 }]);
  const m1 = M(A, B), m2 = M(B, A);
  t('世界书·合并：两边独有的都留着、同 id 取 ver 大的', m1.entries.map(e => e.id).join() === 'x,y,z' && m1.entries[0].content === 'v2');
  t('世界书·合并结果跟先后无关（两台会收敛）', JSON.stringify(m1) === JSON.stringify(m2));
  const tie1 = book([Object.assign({}, x, { content: '甲改的', ver: 5 })]);
  const tie2 = book([Object.assign({}, x, { content: '乙改的', ver: 5 })]);
  t('世界书·合并：同 ver 两边各改了一次，两台算出同一条', JSON.stringify(M(tie1, tie2)) === JSON.stringify(M(tie2, tie1)));
  const delA = book([], { del: { x: 1 } });
  t('世界书·合并：删除靠墓碑传过去，不会被另一台复活', !M(delA, book([x])).entries.some(e => e.id === 'x') && !M(book([x]), delA).entries.some(e => e.id === 'x'));
  t('世界书·合并：删了之后另一台又改过（ver 更高），改动赢', M(delA, B).entries.some(e => e.id === 'x' && e.content === 'v2'));
  const sA = book([], { budget: 900, ver: 2 }), sB = book([], { budget: 3000, ver: 1 });
  t('世界书·合并：设置按版本号取新的', M(sA, sB).budget === 900 && M(sB, sA).budget === 900);
  t('世界书·合并：云端从没有过世界书（null）时本地原样保留', M(A, null).entries.length === 2);
  const ctxW = makeCtx(true, book([]));
  const e1 = ctxW.wbSaveEntry({ title: 'T', keys: '甲,乙', content: 'c' });
  const e2 = ctxW.wbSaveEntry({ id: e1.id, content: 'c2' });
  t('世界书·每改一次 ver +1（合并靠它判新旧）', e1.ver === 1 && e2.ver === 2 && ctxW.state.worldbook.entries.length === 1);
  ctxW.wbDeleteEntry(e1.id);
  t('世界书·删除留墓碑（记下删时的 ver）', ctxW.state.worldbook.del[e1.id] === 2 && !ctxW.state.worldbook.entries.length);
  const dirty = ctxW.wbNorm({ budget: 'abc', depth: 99, entries: [{ id: 'q', keys: 'a,b', content: 'x' }, null, { id: 'q', content: 'dup' }], del: { q: 'NaN' } });
  t('世界书·脏数据收成合法结构（默认上限、深度封顶、去重、坏墓碑丢掉）',
    dirty.budget === 2000 && dirty.depth === 10 && dirty.entries.length === 1 && dirty.entries[0].keys.join() === 'a,b' && !('q' in dirty.del));

  // ── 9) 持久化三道关 + 云同步 + 入口 ──
  console.log('\n[9] 持久化与接线');
  const s02 = read('js/02-state.js'), s01 = read('js/01-core.js'), s14 = read('js/14-boot-brain-hub.js');
  const s05 = read('js/05-prompts-api.js'), html = read('index.html');
  t('世界书·持久化第 1 道：_doSave 写 kuro_worldbook', /idbSet\('kuro_worldbook',\s*JSON\.stringify\(state\.worldbook/.test(s02));
  t('世界书·持久化第 2 道：loadStateFromDB 读 kuro_worldbook', /worldbook:\s*await g\('kuro_worldbook'/.test(s01));
  t('世界书·持久化第 3 道：启动时搬进 state', /state\.worldbook\s*=\s*typeof wbNorm === 'function' \? wbNorm\(saved\.worldbook\)/.test(s14));
  t('世界书·云同步推之前按条合并', /settings\.worldbook = state\.worldbook = wbMerge\(state\.worldbook, cloud\.worldbook\)/.test(s01));
  t('世界书·云同步拉下来也按条合并', /state\.worldbook = wbMerge\(state\.worldbook, s\.worldbook\)/.test(s01));
  t('世界书·云同步整包里带着它', /worldbook: state\.worldbook \|\| null/.test(s01));
  t('世界书·接进 buildSystemPrompt（stable/volatile 分开加）', /base \+= wb\.stable;\s*\n\s*vol \+= wb\.volatile;/.test(s05));
  t('世界书·发送前先算语义路', /await worldbookPrepare\(path, conf\)/.test(s05));
  t('世界书·页面加载了脚本、有面板和入口', /js\/60-worldbook\.js/.test(html) && /id="worldbookModal"/.test(html) && /openWidget\(openWorldbook\)/.test(html) && /id="worldbookBody"/.test(html));

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log('  ✗ 世界书·测试本身崩了'); process.exit(1); });
