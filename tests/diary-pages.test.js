// 日记按页公开 / 上锁（2026-10-03，书签里 Dreamvault 的点子）。
// 直接跑项目里的真函数、真正则，不复刻逻辑。跑法：node tests/diary-pages.test.js
//
// 守的几件事：
//   · 公开页书锁着也给看；锁页只露理由不露正文；没理由的锁页一个字都不露
//   · 公开 / 上锁只有模型能做，判定按「谁的时间戳晚」，同一毫秒连着做也不会判反
//   · 跨设备合并不把公开 / 上锁回退
//   · 锁页的关键词（私密正文里的几个字）不留进存储，理由留着给她看
//   · 往提示词里加的东西不打穿 stable 缓存
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'js') + path.sep;
const read = f => fs.readFileSync(R + f, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const body = { innerHTML: '' };
const modal = { classList: { contains: () => false, remove() {}, add() {} } };
const ctx = { state: {}, console, Date, save() {}, showToast() {}, confirm: () => true,
  document: { getElementById: id => id === 'diaryBody' ? body : id === 'diaryModal' ? modal : null,
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  window: { addEventListener() {} }, setTimeout, setInterval: () => 0, clearInterval() {}, escHtml: esc };
vm.createContext(ctx);
vm.runInContext(read('19-diary.js'), ctx);
const S = ctx.state;
const reset = () => {
  S.diaryEnabled = true; S.diaryDevView = false; S.diaryUnlock = {}; S.diaryHandover = {};
  S.configs = [{ id: 'm1', nickname: '小克', diaryOn: true }];
  S.modelDiaries = {};
};

console.log('\n[1] 写公开页 / 公开旧页 / 锁页');
reset();
ctx.diaryAdd('m1', '今天她夸我了，想让她也看到这页。', true);
ctx.diaryAdd('m1', '有件事我还没想好怎么跟她说。');
ctx.diaryAdd('m1', '第三页，普通的私密页。');
const [p1, p2, p3] = S.modelDiaries.m1;
t('DIARY_PUBLIC 写的页是公开的', ctx.diaryPagePublic(p1) === true);
t('普通 DIARY 写的页默认不公开', ctx.diaryPagePublic(p2) === false && ctx.diaryPagePublic(p3) === false);
const hid = ctx.diaryHide('m1', '还没想好', '等我想清楚了再给你看');
t('按关键词锁上那页并记下理由', hid === p2 && p2.why === '等我想清楚了再给你看' && !ctx.diaryPagePublic(p2));
t('找不到那页 → null，不乱锁别的页', ctx.diaryHide('m1', '根本没有这句', 'x') === null);
ctx.diaryShow('m1', '第三页');
t('DIARY_SHOW 把旧页公开', ctx.diaryPagePublic(p3) === true);
ctx.diaryHide('m1', '第三页', '');
t('同一毫秒里公开了又锁上 → 判锁着（时间戳不撞）', ctx.diaryPagePublic(p3) === false);
t('不给理由地锁 → 不留旧理由', p3.why === undefined);
ctx.diaryShow('m1', '第三页');
t('再公开一次 → 又公开（来回切都认最后一次）', ctx.diaryPagePublic(p3) === true);
ctx.diaryHide('m1', '第三页');

console.log('\n[2] 面板：书锁着的时候');
ctx.renderDiaryPanel();
let h = body.innerHTML;
t('公开页的正文看得到', h.includes('今天她夸我了'));
t('锁页的理由看得到', h.includes('等我想清楚了再给你看'));
t('★ 锁页的正文看不到', !h.includes('还没想好怎么跟她说'));
t('★ 没理由的锁页正文看不到', !h.includes('第三页，普通的私密页'));
t('提示还有 1 页没给理由地锁着', /还有 1 页没给理由地锁着/.test(h));
t('徽章写着几页公开', /已锁 · 3 页 · 1 页公开/.test(h));
t('理由被转义（不吃 HTML）', (() => { ctx.diaryHide('m1', '还没想好', '<b>x</b>'); ctx.renderDiaryPanel(); const ok = body.innerHTML.includes('&lt;b&gt;x&lt;/b&gt;') && !body.innerHTML.includes('<b>x</b>'); ctx.diaryHide('m1', '还没想好', '等我想清楚了再给你看'); return ok; })());

console.log('\n[3] 面板：整本解锁 / 一页都没公开');
S.diaryUnlock = { m1: Date.now() + 60000 };
ctx.renderDiaryPanel();
h = body.innerHTML;
t('解锁时三页正文都在', h.includes('今天她夸我了') && h.includes('还没想好怎么跟她说') && h.includes('第三页，普通的私密页'));
t('解锁时公开页打着「公开」、锁页带着理由', h.includes('diary-page-tag pub') && /diary-page-tag sealed"><svg[^]*?<\/svg> 等我想清楚了再给你看/.test(h));
t('解锁时没有「还有几页锁着」的提示', !/没给理由地锁着/.test(h));
S.diaryUnlock = {};
S.modelDiaries = { m1: [{ t: 1, text: '只有一页私密的' }] };
ctx.renderDiaryPanel();
h = body.innerHTML;
t('一页都没公开、没理由 → 跟以前一样只给「要沟通」的提示', /要在聊天里跟 小克 沟通/.test(h) && !h.includes('只有一页私密的') && !h.includes('diary-entries'));

console.log('\n[4] 提示词');
reset();
ctx.diaryAdd('m1', '公开的一页', true);
ctx.diaryAdd('m1', '锁着的一页');
ctx.diaryHide('m1', '锁着的', '不好意思');
const conf = S.configs[0];
const before = ctx.diaryPromptSplitFor(conf, false);
ctx.diaryShow('m1', '锁着的');
const after = ctx.diaryPromptSplitFor(conf, false);
t('公开 / 上锁不改 stable（否则每动一页都打穿缓存）', before.stable === after.stable);
t('stable 里教了三个新标签', /DIARY_PUBLIC/.test(before.stable) && /DIARY_SHOW/.test(before.stable) && /DIARY_HIDE/.test(before.stable));
t('公开页数进 volatile', /其中 1 页公开/.test(before.volatile) && /其中 2 页公开/.test(after.volatile));
ctx.diaryHide('m1', '锁着的', '不好意思');
const read1 = ctx.diaryEntriesForPrompt(conf);
t('它重读日记时看得到哪页公开、哪页锁着和理由', read1.includes('〔公开〕公开的一页') && read1.includes('〔锁着，理由：不好意思〕锁着的一页'));

console.log('\n[5] 跨设备合并');
const base = { t: 100, text: 'x' };
const merged = ctx._mergeDiaries({ m1: [{ ...base, pub: 200 }] }, { m1: [{ ...base }] });
t('这台公开了、云端是旧的 → 合并后仍公开', ctx.diaryPagePublic(merged.m1[0]));
const merged2 = ctx._mergeDiaries({ m1: [{ ...base, pub: 200 }] }, { m1: [{ ...base, pub: 200, sealAt: 300, why: 'y' }] });
t('另一台后来锁上了 → 合并后锁着、理由在', !ctx.diaryPagePublic(merged2.m1[0]) && merged2.m1[0].why === 'y');

console.log('\n[6] 存储消毒（blocks 进 IndexedDB / 云端）');
const blocks = [{ text: '嗯 [[DIARY_HIDE: 还没想好怎么说 | 等我想清楚]] 还有 [[DIARY_DEL: 那句坏话]] 和 [[DIARY_PUBLIC: 公开的正文]]' }];
ctx.sanitizeBlocksDiary(blocks);
t('★ 锁页的关键词不留进存储', !blocks[0].text.includes('还没想好怎么说'));
t('锁页理由留着（blocks 渲染路径要显示给她）', blocks[0].text.includes('[[DIARY_HIDE:· | 等我想清楚]]'));
t('撕页的关键词也不留', !blocks[0].text.includes('那句坏话'));
t('公开页的正文本来就是给她看的，留着', blocks[0].text.includes('公开的正文'));
t('流式时三种新标签都被挡住', !/还没想好|公开的正文/.test(ctx.maskStreamingDiary('[[DIARY_HIDE: 还没想好 | x]] [[DIARY_PUBLIC: 公开的正文')));

console.log('\n[7] 04-memory.js 指令处理（真正则）');
const mem = read('04-memory.js');
const i0 = mem.indexOf("if (typeof diaryEnabledFor === 'function' && diaryEnabledFor(conf)) {");
const i1 = mem.indexOf('    } else {', i0);
const i2 = mem.indexOf('\n    }\n', i1);
if (i0 < 0 || i1 < 0 || i2 < 0) { console.log('  ✗ 没能从 04-memory.js 切出日记指令那段'); process.exit(1); }
vm.runInContext('function __diaryCmds(text, conf) {' + mem.slice(mem.indexOf('{', i0) + 1, i1) + '\n return text; }', ctx);
vm.runInContext('function __diaryOff(text) {' + mem.slice(i1 + '    } else {'.length, i2) + '\n return text; }', ctx);
reset();
let out = ctx.__diaryCmds('好呀\n[[DIARY_PUBLIC: 今天的晚霞是橘色的]]', S.configs[0]);
t('[[DIARY_PUBLIC:]] 写进日记且是公开页', S.modelDiaries.m1.length === 1 && ctx.diaryPagePublic(S.modelDiaries.m1[0]));
t('公开页的正文摊在聊天的块里', out.includes('写了一页公开日记') && out.includes('今天的晚霞是橘色的') && !out.includes('[[DIARY'));
out = ctx.__diaryCmds('[[DIARY: 一页私密的]] 然后 [[DIARY_HIDE: 私密的 | 还不想说]]', S.configs[0]);
const pg = S.modelDiaries.m1[1];
t('同一条回复里先写后锁 → 那页带着理由锁着', pg && pg.why === '还不想说' && !ctx.diaryPagePublic(pg));
t('锁页的块显示理由、不显示正文', out.includes('锁上了一页日记') && out.includes('理由：还不想说') && !out.includes('一页私密的'));
out = ctx.__diaryCmds('[[DIARY_SHOW: 私密的]]', S.configs[0]);
t('[[DIARY_SHOW:]] 公开旧页，块里给出正文', ctx.diaryPagePublic(pg) && out.includes('公开了一页日记') && out.includes('一页私密的'));
out = ctx.__diaryCmds('[[DIARY_HIDE: 不存在的页]]', S.configs[0]);
t('锁不存在的页 → 块里说没找到', out.includes('没找到那页'));
t('功能没开 → 三种新标签都悄悄抹掉', ctx.__diaryOff('a[[DIARY_PUBLIC: x]]b[[DIARY_SHOW: y]]c[[DIARY_HIDE: z | w]]d') === 'abcd');

console.log('\n[8] 05-prompts-api.js 兜底渲染（blocks 走这条）');
const api = read('05-prompts-api.js');
const a0 = api.indexOf('function memCmdToHtml(');
const a1 = api.indexOf('\n}\n', a0);
const ctx2 = { console, escHtml: esc };
vm.createContext(ctx2);
vm.runInContext(api.slice(a0, a1 + 3), ctx2);
const r8 = ctx2.memCmdToHtml('嗯 [[DIARY_HIDE:· | 等我想清楚]] [[DIARY_SHOW: 第三页]] [[DIARY_PUBLIC: 晚霞]] [[DIARY:·]]', {});
t('消毒后的锁页标签渲染出理由', r8.includes('锁上了一页日记') && r8.includes('理由：等我想清楚'));
t('公开页兜底显示正文', r8.includes('写了一页公开日记') && r8.includes('晚霞'));
t('公开旧页兜底不露关键词', r8.includes('公开了一页日记') && !r8.includes('第三页'));
t('不留裸标签', !/\[\[DIARY/.test(r8));
t('私密页照旧只说「私密」', r8.includes('记了一页日记'));

console.log('\n[9] 接线');
t('android 副本与 js/ 一致', ['19-diary.js', '04-memory.js', '05-prompts-api.js'].every(f =>
  fs.readFileSync(R + f).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
