'use strict';
// 生活三件套：今日小票 / 小月历 / 纪念日卡
//
// 三个各自很小的工具，危险全在「同一件事算出两个答案」和「补记历史把状态搞乱」。
// 这份测试里带 ⚑ 的几条是 Codex 审出来的——它们全都是「代码跑得好好的、
// 面板看着正常、数字悄悄偏出去」那一类，我自己写的时候一条都没想到。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const src = read('js/49-life.js');
const html = read('index.html');
const css = read('css/grancyan.css');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');
const mem = read('js/04-memory.js');
const media = read('js/12-math-media.js');
const prompts = read('js/05-prompts-api.js');
const appearance = read('js/09-appearance-input.js');

function sandbox(opts = {}) {
  const noop = () => {};
  const el = { style: {}, value: '', innerHTML: '', textContent: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false } };
  const box = {
    state: Object.assign({ lifeOn: true, lifeCycleShare: true }, opts.state || {}),
    save: noop, showToast: (m) => { box.__toast = String(m); },
    prompt: () => opts.promptVal, confirm: () => true,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: () => el },
    Math, Date, JSON, console, Object, Array, String, Number, Boolean, RegExp, Set, isNaN
  };
  box.window = box; box.__el = el;
  vm.createContext(box);
  vm.runInContext(src
    + ';this.lifeToday=lifeToday;this.lifeNorm=lifeNorm;this.lifeDays=lifeDays;this.lifeAdd=lifeAdd;'
    + 'this.lifeReceiptAdd=lifeReceiptAdd;this.lifeReceiptOf=lifeReceiptOf;this.lifeReceiptDel=lifeReceiptDel;'
    + 'this.lifePeriodAdd=lifePeriodAdd;this.lifePeriodClose=lifePeriodClose;this.lifePeriodDel=lifePeriodDel;'
    + 'this.lifePeriodList=lifePeriodList;this.lifePeriodOpen=lifePeriodOpen;this.lifePeriodStats=lifePeriodStats;'
    + 'this.lifeAnnivAdd=lifeAnnivAdd;this.lifeAnnivs=lifeAnnivs;this.lifeAnnivCardSet=lifeAnnivCardSet;'
    + 'this.lifeAnnivCard=lifeAnnivCard;this.lifeAnnivThisYear=lifeAnnivThisYear;this.lifeAnnivDaysLeft=lifeAnnivDaysLeft;'
    + 'this.lifeProcessTags=lifeProcessTags;this._applyLifeToBlocks=_applyLifeToBlocks;this.lifeTagToHtml=lifeTagToHtml;this.lifeTagForApi=lifeTagForApi;'
    + 'this.maskStreamingLife=maskStreamingLife;this.lifePromptFor=lifePromptFor;this.lifeRender=lifeRender;'
    + 'this.lifePromiseAdd=lifePromiseAdd;this.lifePromiseKeep=lifePromiseKeep;this.lifePromises=lifePromises;this.lifePromisesOpen=lifePromisesOpen;'
    + 'this.lifePromiseSorted=lifePromiseSorted;this.lifePromiseSetDone=lifePromiseSetDone;this.lifePromiseDel=lifePromiseDel;this.lifePromiseWhen=lifePromiseWhen;'
    + 'this.LIFE_PROMISE_OPEN_MAX=LIFE_PROMISE_OPEN_MAX;this.LIFE_PROMISE_DONE_KEEP=LIFE_PROMISE_DONE_KEEP;this.LIFE_PROMISE_PROMPT_MAX=LIFE_PROMISE_PROMPT_MAX;'
    + 'this.LIFE_RECEIPT_MAX=LIFE_RECEIPT_MAX;this.LIFE_PROMPT_MAX=LIFE_PROMPT_MAX;this.LIFE_PROMPT_HARD=LIFE_PROMPT_HARD;this.LIFE_DEDUP_MS=LIFE_DEDUP_MS;this.LIFE_LEN_MAX=LIFE_LEN_MAX;this.LIFE_CYCLE_MAX=LIFE_CYCLE_MAX;', box);
  return box;
}
const B = sandbox();
const TODAY = B.lifeToday();
const ago = n => B.lifeAdd(TODAY, -n);

console.log('\n【一】日期：格式对不等于这天存在');

t('★ 归一化补零', B.lifeNorm('2026-8-1') === '2026-08-01');
t('★ 斜杠也认', B.lifeNorm('2026/08/01') === '2026-08-01');
t('★ 乱写的拒绝', B.lifeNorm('yesterday') === '');
t('★ 13 月拒绝', B.lifeNorm('2026-13-01') === '');
// ⚑ Codex：格式对但那天不存在。Date.UTC 会把它滚成 3 月 3 日，于是同一条记录
//    在「字符串排序」里是 2 月的、在「做差统计」里是 3 月的——两处代表两个日期。
t('⚑ 2026-02-31 要拒绝（不然排序和统计里它是两个日期）', B.lifeNorm('2026-02-31') === '');
t('⚑ 2026-04-31 也要拒绝', B.lifeNorm('2026-04-31') === '');
t('★ 闰年 2 月 29 收下', B.lifeNorm('2024-02-29') === '2024-02-29');
t('★ 平年 2 月 29 拒绝', B.lifeNorm('2026-02-29') === '');
t('★ 跨月做差', B.lifeDays('2026-01-31', '2026-02-01') === 1);
t('★ 跨年做差', B.lifeDays('2025-12-31', '2026-01-01') === 1);

console.log('\n【二】小票');

{
  const S = sandbox();
  S.lifeReceiptAdd('喝了咖啡', 'user');
  S.lifeReceiptAdd('走了八千步', 'ai');
  const list = S.lifeReceiptOf(TODAY);
  t('★ 记得进去', list.length === 2);
  // 谁记的必须分得清：某天看到一条自己没印象的，要能判断是自己忘了还是它记岔了
  t('★ 谁记的分得清', list[0].by === 'user' && list[1].by === 'ai', list.map(r => r.by));
  t('★ 空的不记', S.lifeReceiptAdd('   ', 'user') === false);
  S.lifeReceiptDel(TODAY, 0);
  t('★ 删得掉', S.lifeReceiptOf(TODAY).length === 1);
}

{
  const S = sandbox();
  for (let i = 0; i < S.LIFE_RECEIPT_MAX; i++) S.lifeReceiptAdd('第' + i, 'user');
  t('★ 一天有上限，满了就拒绝', S.lifeReceiptAdd('多的', 'user') === false);
  t('★ 而且真的没多进去', S.lifeReceiptOf(TODAY).length === S.LIFE_RECEIPT_MAX);
}

{
  const S = sandbox();
  for (let i = 0; i < 200; i++) S.lifeReceiptAdd('x', 'user', B.lifeAdd(TODAY, -i));
  const days = Object.keys(S.state.lifeReceipts).length;
  t('★ 只留最近若干天（不然记两年之后每次 save 都要重写一大坨）',
    days <= 120, days);
}

console.log('\n【三】月历：补记历史是常态，不能靠「最新一条」');

{
  // 别人上线当天翻的车：先记最近的，再回头补四月的
  const S = sandbox();
  S.lifePeriodAdd(ago(3), '');
  S.lifePeriodAdd(ago(120), '');       // 事后补的，忘了填结束
  S.lifePeriodAdd(ago(90), ago(85));
  const o = S.lifePeriodOpen();
  t('★ 进行中的是「开始最晚」那条，不是「数组里最后放进去」那条',
    o.current && o.current.start === ago(3), o.current);
  t('★ 早先那条没结束的算「忘了记」，不是第二个进行中',
    o.unclosed.length === 1 && o.unclosed[0].start === ago(120), o.unclosed);
}

{
  // ⚑ Codex：最晚那条没记结束，也不等于「现在还在进行中」。
  //    忘了记结束、之后几个月没再记，它会永远是 current——
  //    面板显示「第 100 天」，提示词还告诉模型她正在经期。
  const S = sandbox();
  S.lifePeriodAdd(ago(100), '');
  const o = S.lifePeriodOpen();
  t('⚑ 一百天前开始、一直没记结束 → 不算进行中', o.current === null, o.current);
  t('⚑ 归到「忘了记结束」里', o.unclosed.length === 1 && o.unclosed[0].start === ago(100));
  const st = S.lifePromptFor().volatile;
  t('⚑ 提示词也不会说她正在经期', !/这次来是第/.test(st), st);
}

{
  const S = sandbox();
  S.lifePeriodAdd(ago(2), '');
  t('★ 两天前开始、还没结束 → 确实是进行中', S.lifePeriodOpen().current !== null);
}

console.log('\n【四】月历：离群值不能进平均');

{
  const S = sandbox();
  // 四次正常的 28 天周期
  for (let i = 4; i >= 1; i--) S.lifePeriodAdd(ago(i * 28), B.lifeAdd(ago(i * 28), 5));
  const before = S.lifePeriodStats().avgCycle;
  t('★ 正常记录算得出周期', before === 28, before);
  S.lifePeriodAdd(ago(400), B.lifeAdd(ago(400), 5));   // 漏记了一整年
  t('★ 加一条一年前的，平均周期纹丝不动（离群被丢掉）',
    S.lifePeriodStats().avgCycle === before, S.lifePeriodStats().avgCycle);
}

{
  const S = sandbox();
  S.lifePeriodAdd(ago(60), B.lifeAdd(ago(60), 4));      // 5 天
  S.lifePeriodAdd(ago(30), B.lifeAdd(ago(30), 5));      // 6 天
  t('★ 平均天数算得对（同一天算一天）', S.lifePeriodStats().avgLen === 6,
    S.lifePeriodStats().avgLen);
  S.lifePeriodAdd(ago(120), B.lifeAdd(ago(120), 30));   // 忘了标结束，31 天
  t('★ 31 天那次不进平均', S.lifePeriodStats().avgLen === 6, S.lifePeriodStats().avgLen);
}

{
  const S = sandbox();
  S.lifePeriodAdd(ago(10), B.lifeAdd(ago(10), S.LIFE_LEN_MAX - 1));
  t('★ 边界：正好等于上限的那次算进去',
    S.lifePeriodStats().avgLen === S.LIFE_LEN_MAX, S.lifePeriodStats().avgLen);
}

{
  const S = sandbox();
  S.lifePeriodAdd(ago(5), ago(1));
  const st = S.lifePeriodStats();
  t('★ 只有一次记录时，周期是猜的，而且明说是猜的',
    st.avgCycle === null && st.cycleIsGuess === true && !!st.next, st);
}

console.log('\n【五】月历：写入的边界');

{
  const S = sandbox();
  S.lifePeriodAdd(ago(5), '');
  t('★ 同一天不重复记', S.lifePeriodAdd(ago(5), '') === false);
  // ⚑ Codex：end 填了但格式不对，原来会 `lifeNorm(end) || ''` 静默当成「没填」，
  //    她以为记上了，实际那次永远显示「没记结束」还不进统计。
  t('⚑ 结束日期格式不对 → 整条拒绝，不静默变成「没填」',
    S.lifePeriodAdd(ago(50), '八月一号') === false);
  t('⚑ 而且真的没写进去', S.lifePeriodList().every(p => p.start !== ago(50)));
  // ⚑ Codex：允许手填就一定有人填反
  t('⚑ 结束早于开始 → 拒绝', S.lifePeriodAdd(ago(20), ago(25)) === false);
  t('★ 结束等于开始 → 收下（当天来当天走）', S.lifePeriodAdd(ago(30), ago(30)) === true);
}

{
  const S = sandbox();
  S.lifePeriodAdd(ago(4), '');
  t('★ 补结束日期', S.lifePeriodClose(ago(4), ago(1)) === true);
  t('★ 补的结束早于开始 → 拒绝', S.lifePeriodClose(ago(4), ago(9)) === false);
  t('★ 补一个不存在的开始 → 拒绝', S.lifePeriodClose(ago(99), TODAY) === false);
  // ⚑ Codex 二审：lifePeriodAdd 修了这个，lifePeriodClose 漏了 ——
  //    她在「补结束」里输入「八月一号」，会得到一个「成功」和一个存成今天的日期。
  t('⚑ 补的结束日期格式不对 → 拒绝，不静默存成今天',
    S.lifePeriodClose(ago(4), '八月一号') === false);
  t('⚑ 而且真的没被改成今天',
    S.lifePeriodList().find(p => p.start === ago(4)).end !== TODAY);
}

console.log('\n【六】月历：统计只有一个出口');

{
  // 面板和提示词各算一遍的话，某天改了公式只改一处，两边给出两个日期，且都不报错
  const users = src.split(/\r?\nfunction /).filter(f => /lifePeriodStats\(\)/.test(f)).map(f => f.split('(')[0]);
  t('★ 面板和提示词都调 lifePeriodStats，没有各算各的',
    users.includes('lifePromptFor') && users.includes('_lifeCycleHtml'), users);
  // ⚠️ 别用 split(/\nfunction /) 去圈函数体 —— 两个函数之间的常量定义会被
  //    算进前一个函数里，于是无辜的函数被点名（这条第一次跑就这么红的）。
  //    直接数「计算点出现几次」更准。
  t('★ 周期的平均值只在一处算', (src.match(/gaps\.reduce/g) || []).length === 1);
  t('★ 时长的平均值只在一处算', (src.match(/lens\.reduce/g) || []).length === 1);
  t('★ 「预计下次」只在一处推（定义 + 唯一一次使用）',
    (src.match(/LIFE_CYCLE_DEF/g) || []).length === 2,
    (src.match(/LIFE_CYCLE_DEF/g) || []).length);
}

console.log('\n【七】纪念日');

{
  const S = sandbox();
  t('★ 加得上', S.lifeAnnivAdd('搬家', '2026-03-01') === true);
  t('★ 日期不对不加', S.lifeAnnivAdd('生日', '乱写') === false);
  t('★ 没名字不加', S.lifeAnnivAdd('', '2026-02-14') === false);
}

{
  t('★ 平年落到 2 月 28（不然算出负数，永远不提醒）',
    B.lifeAnnivThisYear('2024-02-29', 2027) === '2027-02-28');
  t('★ 闰年还是 2 月 29', B.lifeAnnivThisYear('2024-02-29', 2028) === '2028-02-29');
  t('★ 今天就是纪念日 → 还有 0 天', B.lifeAnnivDaysLeft(TODAY) === 0);
  const past = B.lifeAdd(TODAY, -1);
  const n = B.lifeAnnivDaysLeft(past);
  t('★ 今年的已经过了 → 看明年，不给负数', n != null && n > 300, n);
}

{
  const S = sandbox();
  S.lifeAnnivAdd('搬家', TODAY);
  const id = S.lifeAnnivs()[0].id;
  const y = TODAY.slice(0, 4);
  t('★ 写得进去', S.lifeAnnivCardSet(id, y, '第一年') === true);
  t('★ 同一年不覆盖（一年一张、往年可翻是这功能的全部意义）',
    S.lifeAnnivCardSet(id, y, '想改') === false);
  t('★ 内容还是原来那张', S.lifeAnnivCard(id, y) === '第一年');
  t('★ 换一年可以写', S.lifeAnnivCardSet(id, String(+y + 1), '第二年') === true);
}

{
  // ⚑ Codex：空白卡片是漏洞——存进去之后 `if (a.cards[y])` 判成「没写过」，
  //    于是能被覆盖一次。
  const S = sandbox();
  S.lifeAnnivAdd('搬家', TODAY);
  const id = S.lifeAnnivs()[0].id;
  const y = TODAY.slice(0, 4);
  t('⚑ 空白卡片不存', S.lifeAnnivCardSet(id, y, '   ') === false);
  S.lifeAnnivCardSet(id, y, '真的');
  t('⚑ 存过之后不给覆盖',
    S.lifeAnnivCardSet(id, y, '覆盖') === false && S.lifeAnnivCard(id, y) === '真的');
}

{
  // ⚠️ 上面那条测不出 hasOwnProperty 的价值 —— 因为「拒绝空正文」那道
  //    已经把空串挡在外面了，两道防护互相兜底，单独拆掉任一道行为都不变
  //    （故障注入报红 0 就是这个原因，不是断言无效）。
  //    hasOwnProperty 真正防的是**老档里已经躺着空串**：早先版本存进去过，
  //    或者手工导入的数据。那时候 `if (a.cards[y])` 会判成「那年没写过」，
  //    于是那张卡能被覆盖一次 —— 而「一年一张、往年可翻」是这功能的全部意义。
  const S = sandbox();
  S.lifeAnnivAdd('搬家', TODAY);
  const id = S.lifeAnnivs()[0].id;
  const y = TODAY.slice(0, 4);
  S.lifeAnnivs()[0].cards = { [y]: '' };        // 直接造一个老档：那年是空串
  t('⚑ 老档里那年是空串，也算「写过了」，不给覆盖',
    S.lifeAnnivCardSet(id, y, '想覆盖') === false, S.lifeAnnivCard(id, y));
}

console.log('\n【八】标签：副作用失败绝不能画成成功');

{
  const S = sandbox();
  const out = S.lifeProcessTags('[[RECEIPT: 喝了咖啡]]');
  t('★ 记成功的标签带上 #ok', /\[\[RECEIPT#ok:/.test(out), out);
  t('★ 真的记进去了', S.lifeReceiptOf(TODAY).length === 1);
  t('★ 渲染成「记下了」', /记下了/.test(S.lifeTagToHtml(out)));
}

{
  // ⚠️⚠️ 同塔罗：原来写的是「再跑一遍不重复记」，那等于让模型输出
  //    [[RECEIPT#ok: 根本没存]] 就能让界面显示「记下了」而实际什么都没存。
  //    （Codex 二审逮到的。）现在模型自己写的标记一律不认，真跑一次拿真结果。
  const S = sandbox();
  const fake = '[[RECEIPT#ok: 模型自己说存好了]]';
  const out = S.lifeProcessTags(fake);
  t('★ 模型自己写的 #ok 不算数，会真的去记一次',
    S.lifeReceiptOf(TODAY).length === 1
    && S.lifeReceiptOf(TODAY)[0].t === '模型自己说存好了', S.lifeReceiptOf(TODAY));
  t('★ 拿到的是真结果', /\[\[RECEIPT#ok:/.test(out), out);
}

{
  // ⚑ Codex 三审：只测「伪造 #ok → 真结果也是 #ok」太松 ——
  //    如果实现是「确实写入了，但把模型的标记原样抄回去」，那组仍然绿。
  //    两边交叉才测得出：空着时伪造 #full 要变 #ok，满了时伪造 #ok 要变 #full。
  const S = sandbox();
  const one = S.lifeProcessTags('[[RECEIPT#full: 其实记得下]]');
  t('⚑ 交叉一：空着的时候伪造 #full → 必须改成 #ok', /\[\[RECEIPT#ok:/.test(one), one);

  const S2 = sandbox();
  for (let i = 0; i < S2.LIFE_RECEIPT_MAX; i++) S2.lifeReceiptAdd('占位' + i, 'user');
  const two = S2.lifeProcessTags('[[RECEIPT#ok: 其实记不下]]');
  t('⚑ 交叉二：记满的时候伪造 #ok → 必须改成 #full', /\[\[RECEIPT#full:/.test(two), two);
}

{
  // ⚑ Codex：今天满了、数据层拒绝了，回复却照样显示「记下了」
  const S = sandbox();
  for (let i = 0; i < S.LIFE_RECEIPT_MAX; i++) S.lifeReceiptAdd('第' + i + '条', 'user');
  const out = S.lifeProcessTags('[[RECEIPT: 记满之后这条]]');
  t('⚑ 记满了 → 标签是 #full', /\[\[RECEIPT#full:/.test(out), out);
  t('⚑ 渲染要说「没记上」，不能画成功', /没记上/.test(S.lifeTagToHtml(out)));
  t('⚑ 回填也要说没记上（不然它下轮以为记成功了，接着说「已经帮你记下了」）',
    /没记上/.test(S.lifeTagForApi(out)), S.lifeTagForApi(out));
}

{
  // ⚑ Codex：纪念日名字差一个字就找不到，却照样显示卡片
  const S = sandbox();
  S.lifeAnnivAdd('搬家', TODAY);
  const out = S.lifeProcessTags('[[ANNIV: 搬家了|生日快乐]]');
  t('⚑ 找不到那个纪念日 → #nf', /\[\[ANNIV#nf:/.test(out), out);
  t('⚑ 渲染说「没存下」，不画一张假卡片', /没存下/.test(S.lifeTagToHtml(out)));
}

{
  // ⚑ Codex：今年已经写过，数据层拒绝，回复却显示新写的那张，面板里其实是旧的
  const S = sandbox();
  S.lifeAnnivAdd('搬家', TODAY);
  S.lifeProcessTags('[[ANNIV: 搬家|第一张]]');
  const out = S.lifeProcessTags('[[ANNIV: 搬家|又写一张]]');
  t('⚑ 今年写过了 → #dup', /\[\[ANNIV#dup:/.test(out), out);
  t('⚑ 渲染说「已经写过了」', /已经写过/.test(S.lifeTagToHtml(out)));
  t('⚑ 面板里还是第一张', S.lifeAnnivCard(S.lifeAnnivs()[0].id, TODAY.slice(0, 4)) === '第一张');
}

{
  // 流式断了 → 副作用没跑 → 标签没有标记。这时候也不能画成功。
  const S = sandbox();
  t('★ 没跑过副作用的标签画成「没记上」，不撒谎',
    /没记上/.test(S.lifeTagToHtml('[[RECEIPT: 断了]]')));
}

{
  const S = sandbox();
  const out = S.lifeProcessTags('[[RECEIPT: 咖啡]]');
  t('★ 处理完仍是标签、没变成 HTML（blocks 那条路才看得见）',
    out.indexOf('[[RECEIPT') >= 0 && out.indexOf('<') < 0, out);
  t('★ 流式过程中被遮住', S.maskStreamingLife(out).indexOf('[[RECEIPT') < 0);
  t('★ 回填不含 HTML（不然模型照着历史学，下次自己手写一个假卡片）',
    !/</.test(S.lifeTagForApi(out)), S.lifeTagForApi(out));
}

{
  // ⚑ Codex 三审：写卡时只按名字找，没验今天确实是那个日子 ——
  //    提前一天写一张就把今年唯一的名额占掉，真到日子只能拿到 #dup。
  const S = sandbox();
  S.lifeAnnivAdd('搬家', B.lifeAdd(TODAY, 3));
  const out = S.lifeProcessTags('[[ANNIV: 搬家|提前三天写的]]');
  t('⚑ 还没到日子就写 → #early，不占名额', /\[\[ANNIV#early:/.test(out), out);
  t('⚑ 渲染说「还没到那天」', /还没到/.test(S.lifeTagToHtml(out)));
  t('⚑ 今年的名额还空着', S.lifeAnnivCard(S.lifeAnnivs()[0].id, TODAY.slice(0, 4)) === '');
}

{
  // ⚑ Codex 三审：多模型并排时几个 variant 各跑一次 processAiCommands，
  //    同一句话被记好几条；重新生成、编辑后重发同理。
  const S = sandbox();
  S.lifeProcessTags('[[RECEIPT: 今天喝了咖啡]]');
  S.lifeProcessTags('[[RECEIPT: 今天喝了咖啡]]');
  S.lifeProcessTags('[[RECEIPT: 今天喝了咖啡]]');
  t('⚑ 三个 variant 记同一句，只留一条',
    S.lifeReceiptOf(TODAY).length === 1, S.lifeReceiptOf(TODAY).length);
  S.lifeProcessTags('[[RECEIPT: 又走了八千步]]');
  t('⚑ 但内容不同的照记', S.lifeReceiptOf(TODAY).length === 2, S.lifeReceiptOf(TODAY).length);
}

{
  // ⚑⚑ Codex 四审：**不能拿正文当幂等键**。上午和晚上各「吃了一次药」是两件真事，
  //    按内容永久查重会把第二次静默吞掉，还返回成功、界面照样显示「记下了」——
  //    我为了修多 variant 引入的那个查重，本身就是个新的静默失败。
  //    改成时间窗：几个 variant 相隔毫秒级，真实的重复事件隔着几小时。
  const S = sandbox();
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]');
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]');
  t('⚑ 并发那两次仍然合成一条', S.lifeReceiptOf(TODAY).length === 1);
  // 把时间戳往回拨，模拟「晚上又吃了一次」
  S.state.lifeReceipts[TODAY][0].at = Date.now() - 6 * 3600000;
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]');
  t('⚑⚑ 六小时后又记同一件事 → 照记，不许被吞',
    S.lifeReceiptOf(TODAY).length === 2, S.lifeReceiptOf(TODAY).length);
}

{
  // ⚑⚑ Codex 五审：时间窗**两头都不严** —— 窗口内的真实重复会被吞，
  //    慢的那个 variant 超出窗口又会漏进来。正解是来源键（对话 id + 用户轮次 id）。
  //    ⚠️ 上面那两段走的是「拿不到来源键」的兜底路（不传 turnKey），
  //    覆盖不到这条主路 —— 它才是真实调用链（04-memory.js）走的那条。
  const S = sandbox();
  const K1 = 'chat-1:turn-7', K2 = 'chat-1:turn-8', K3 = 'chat-2:turn-7';
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', K1);
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', K1);
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', K1);
  t('⚑⚑ 同一轮三个 variant 记同一句，只留一条',
    S.lifeReceiptOf(TODAY).length === 1, S.lifeReceiptOf(TODAY).length);
  t('⚑⚑ 来源键要落进记录里（不落的话下一轮就认不出是同一轮了）',
    S.lifeReceiptOf(TODAY)[0].k === K1, S.lifeReceiptOf(TODAY)[0]);
  // ⚠️ 这里**故意**把时间戳拨到「刚刚」：隔了不到一毫秒，时间窗一定会吞掉它。
  //    能照记，才证明判据是来源键而不是时间。
  S.state.lifeReceipts[TODAY][0].at = Date.now();
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', K2);
  t('⚑⚑ 下一轮记同一句 → 照记，哪怕只隔了一毫秒',
    S.lifeReceiptOf(TODAY).length === 2, S.lifeReceiptOf(TODAY).length);
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', K3);
  t('⚑ 换个对话也是新的一件事', S.lifeReceiptOf(TODAY).length === 3, S.lifeReceiptOf(TODAY).length);
  // ⚠️ 出去就清。不清的话面板那条路会蹭到上一轮的键，
  //    她手动记的东西被当成「同一轮的重复」静默吞掉，界面还显示记下了。
  S.lifeReceiptAdd('自己手动记的', 'user');
  const last = S.lifeReceiptOf(TODAY)[3];
  t('⚑ 面板手动记的不带来源键', !!last && last.k === undefined, last);
}

{
  // ⚑⚑ Codex 六审：**缺字段的时候必须退回时间窗兜底**。
  //    原来在 04-memory.js 里直接拼 `(chat && chat.id) + ':' + (turnId || '')`：
  //    缺 turnId 拼出来是 `chat-1:`、连 chat 都没有时是 `undefined:` —— 两个都是真值，
  //    于是永远走来源键分支。同一对话里以后再记同一句会被**无限期**当成同一轮吞掉，
  //    压根到不了那 30 秒兜底，界面还显示「记下了」。
  //    ⚠️ 上一段喂的是我自己合成好的键，测不到这个 —— 真正的构造在 lifeTurnKey 里。
  const S = sandbox();
  t('⚑⚑ 两截都有才拼', S.lifeTurnKey('chat-1', 'turn-7') === 'chat-1:turn-7', S.lifeTurnKey('chat-1', 'turn-7'));
  t('⚑⚑ 缺轮次 id → 空串（不是 "chat-1:"）', S.lifeTurnKey('chat-1', '') === '', S.lifeTurnKey('chat-1', ''));
  t('⚑⚑ 缺对话 id → 空串（不是 "undefined:"）', S.lifeTurnKey(undefined, 'turn-7') === '', S.lifeTurnKey(undefined, 'turn-7'));
  t('⚑ 两截都没有 → 空串', S.lifeTurnKey(null, undefined) === '');
  t('⚑ 全是空白也不算数', S.lifeTurnKey('  ', ' ') === '', S.lifeTurnKey('  ', ' '));
  // 拿空串当 turnKey 走一遍：应当落回时间窗，六小时后照记
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', S.lifeTurnKey('chat-1', undefined));
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', S.lifeTurnKey('chat-1', undefined));
  t('⚑ 拿不到来源键时仍然走时间窗（并发合一条）', S.lifeReceiptOf(TODAY).length === 1, S.lifeReceiptOf(TODAY).length);
  S.state.lifeReceipts[TODAY][0].at = Date.now() - 6 * 3600000;
  S.lifeProcessTags('[[RECEIPT: 吃了一次药]]', S.lifeTurnKey('chat-1', undefined));
  t('⚑⚑ 而且六小时后照记 —— 兜底那条路没被假键堵死',
    S.lifeReceiptOf(TODAY).length === 2, S.lifeReceiptOf(TODAY).length);
}

{
  // ⚠️ 上面测的是 lifeTurnKey 本身。这一条守**调用点真的用了它** ——
  //    04-memory.js 里改回手拼字符串的话，上面那些断言一条都不会红。
  const mem = read('js/04-memory.js');
  const call = (mem.match(/lifeProcessTags\([^)]*\)/) || [''])[0];
  t('⚑⚑ 04-memory 把来源键交给 lifeTurnKey 构造，不自己拼',
    /lifeTurnKey\(/.test(call) && !/\+\s*':'\s*\+/.test(call), call);
}

console.log('\n【八·续】提示词要有硬预算');

{
  // ⚑ Codex 二审：合法的 40 条小票 × 每条 120 字 = 五千字，每一轮都发一遍。
  //    这不是异常数据，是这功能正常用一天的量。我上一轮报的「112 字」是空数据时量的。
  const S = sandbox();
  for (let i = 0; i < S.LIFE_RECEIPT_MAX; i++) S.lifeReceiptAdd(i + '记录'.repeat(60).slice(0, 108), 'user');
  const p = S.lifePromptFor();
  // ⚠️ 阈值要卡在**逐条预算**那道上，不能松到只有兜底那一刀能兜住 ——
  //    松了的话逐条预算整个失效它也是绿的（故障注入报红 0 就是这么来的：
  //    拿掉逐条预算后是 902 字，仍然 < 1000）。
  t('⚑ 小票再多，提示词也收得住',
    p.volatile.length <= S.LIFE_PROMPT_MAX + 60, p.volatile.length);
  t('⚑ 而且明说了还有多少条没列', /没列/.test(p.volatile));
}

{
  // 七天内可以有任意多个纪念日，全列进去同样能把预算吃光
  const S = sandbox();
  for (let i = 0; i < 12; i++) S.lifeAnnivAdd('日子' + i, TODAY);
  const p = S.lifePromptFor();
  t('⚑ 纪念日条数也封顶', p.volatile.length < 1000, p.volatile.length);
}

{
  // ⚑ Codex 四审：兜底那一刀切完还接了个省略号，所以声称的 760 实际是 762。
  //    上面那几条数据都没触发兜底，所以抓不到这个边界。这条专门把它撑到触发。
  const S = sandbox();
  for (let i = 0; i < S.LIFE_RECEIPT_MAX; i++) S.lifeReceiptAdd(i + '流水'.repeat(60).slice(0, 108), 'user');
  S.lifePeriodAdd(ago(1), '');
  for (let i = 0; i < 6; i++) S.lifeAnnivAdd('日子' + i, TODAY);
  const v = S.lifePromptFor().volatile;
  t('⚑ 撑到触发兜底时，长度不超过声称的硬上限',
    v.length <= S.LIFE_PROMPT_HARD, { got: v.length, hard: S.LIFE_PROMPT_HARD });
}

{
  // ⚑ Codex 二审：stable 必须恒定。原来「纪念日卡怎么写」是有条件才拼进去的，
  //    于是前一天 / 当天没写 / 写完 三种状态下 stable 各不相同，
  //    提示词缓存的前缀一变，后面整段历史每轮重写一次 —— 只体现在账单上。
  const A = sandbox();
  const B2 = sandbox();
  B2.lifeAnnivAdd('搬家', TODAY);
  const C = sandbox();
  C.lifeAnnivAdd('搬家', TODAY);
  C.lifeProcessTags('[[ANNIV: 搬家|写了]]');
  t('⚑ 没纪念日 / 今天有还没写 / 写完了，三种状态下 stable 完全一样',
    A.lifePromptFor().stable === B2.lifePromptFor().stable
    && B2.lifePromptFor().stable === C.lifePromptFor().stable);
  t('⚑ 而且「今天能不能写」确实进了 volatile',
    /还没写卡片/.test(B2.lifePromptFor().volatile)
    && /已经写过/.test(C.lifePromptFor().volatile));
}

console.log('\n【九】月历进提示词是单独一道开关（等于把身体数据发给模型）');

{
  const S = sandbox({ state: { lifeOn: true, lifeCycleShare: false } });
  S.lifePeriodAdd(ago(1), '');
  const p = S.lifePromptFor();
  t('★ 关掉之后提示词里一个字都不提月历',
    !/这次来是第|要来了|晚了/.test(p.volatile), p.volatile);
  t('★ 但小票那部分照常', p.stable.length > 0);
}

{
  const S = sandbox({ state: { lifeOn: true, lifeCycleShare: true } });
  S.lifePeriodAdd(ago(1), '');
  t('★ 开着的时候会说第几天', /这次来是第 2 天/.test(S.lifePromptFor().volatile),
    S.lifePromptFor().volatile);
}

{
  const S = sandbox({ state: { lifeOn: false } });
  t('★ 整个功能关掉 → 提示词一个字都不加',
    S.lifePromptFor().stable === '' && S.lifePromptFor().volatile === '');
  t('★ 关掉时标签也不处理', S.lifeProcessTags('[[RECEIPT: x]]').indexOf('RECEIPT') < 0);
}

console.log('\n【十】三道门 + 挂载点');

for (const k of ['lifeOn', 'lifeCycleShare', 'lifeReceipts', 'lifePeriods', 'lifeAnnivs', 'lifePromises']) {
  t('★ ' + k + ' 三道门都在',
    core.includes('kuro_' + k) && stateJs.includes('kuro_' + k) && boot.includes('state.' + k),
    { core: core.includes('kuro_' + k), st: stateJs.includes('kuro_' + k), boot: boot.includes('state.' + k) });
}
t('★ lifeOn 默认开，判据是「!== false」', /state\.lifeOn\s*=\s*saved\.lifeOn\s*!==\s*false/.test(boot));
t('★ lifeCycleShare 默认开，判据也是「!== false」',
  /state\.lifeCycleShare\s*=\s*saved\.lifeCycleShare\s*!==\s*false/.test(boot));
t('★ lifePeriods 启动判据认数组', /state\.lifePeriods\s*=\s*Array\.isArray/.test(boot));

t('★ 49-life.js 进了 index.html', html.includes('js/49-life.js'));
t('★ 小组件里有入口', /openWidget\(openLife\)/.test(html));
t('★ lifeModal 在', html.includes('id="lifeModal"'));
t('★ 面板挂载点在', html.includes('id="lifeBody"'));
t('★ 三个 tab 不写死在 HTML 里',
  !/class="life-tab[" ]/.test(html.slice(html.indexOf('id="lifeModal"'), html.indexOf('id="lifeModal"') + 1500)));
t('★ 设置里有两道开关',
  html.includes('id="lifeToggle"') && html.includes('id="lifeCycleToggle"'));
t('★ 设置里说清了月历会发给模型', /发给模型/.test(html));

t('★ 副作用接在 processAiCommands 里', /lifeProcessTags/.test(mem));
t('★ 卡片接在渲染层', /lifeTagToHtml/.test(media));
t('★ 回填接在发 API 那条路上', /lifeTagForApi/.test(prompts));
t('★ 流式遮罩注册了', /maskStreamingLife/.test(prompts));
t('★ 提示词接上了', /lifePromptFor/.test(prompts));

// ⚑ Codex 二审：小票/周期/纪念日卡是**用户记录**不是功能开关，不在云同步里。
//    我选了保守那条（月历属身体记录，不默认往 Supabase 传），但那就必须说出来 ——
//    不说的话她换设备才发现全空，而那时数据已经只在旧机器上了。
t('⚑ 界面上说清了这三样只存本机、不走云同步',
  /只存在这台设备上/.test(html) && /不走云同步/.test(html));
// ⚑ Codex 二审：默认开的开关，第一次打开设置会看见没勾的框，她照着框理解就理解反了。
// ⚑⚑ 这条上一版写反了，把**错误实现**当成了正确断言（Codex 三审逮到的）。
//    月历那个框必须读原始的 state.lifeCycleShare，不能读 lifeCycleShared() ——
//    后者是「总开关 && share」，于是总开关关着时框显示没勾，她再打开总开关，
//    框还是没勾、而 share 实际是 true，下一轮就把身体记录发出去了。
//    她看着一个没勾的框，以为没在发。这是隐私方向的错，不是显示瑕疵。
t('⚑ 生活总开关按 state 回填', /lifeToggle[\s\S]{0,120}lifeEnabled/.test(appearance));
t('⚑⚑ 月历那个框读原始 state.lifeCycleShare，不读受总开关影响的 lifeCycleShared()',
  /lifeCycleToggle[\s\S]{0,300}state\.lifeCycleShare !== false/.test(appearance)
  && !/lifeCycleToggle[\s\S]{0,200}lifeCycleShared\(\)/.test(appearance));
t('⚑ 共读那个开关也回填', /coreadToggle[\s\S]{0,120}coreadEnabled/.test(appearance));

for (const c of ['.life-body', '.life-receipt', '.life-chip', '.life-chip-no', '.life-card', '.life-warn']) {
  t('★ 样式 ' + c + ' 在', css.includes(c));
}
t('★ 帮助里有这一条', /help-key">🧾 生活/.test(html));

// ── blocks 那条渲染路径 ──────────────────────────────────
// 用户报的：气泡上写「🧾 这条没记上」，但小票其实已经存进去了。
// 根因是 blocks 非空时渲染完全不看 content（06-render-msg.js:483），
// 而 blocks 里躺的是流式收到的**原始**标签、不带 #ok。
console.log('\n【blocks 路径】结果要补进 blocks，不然记上了也显示没记上');
{
  const b = sandbox();
  const raw = '好呀，我记下了。[[RECEIPT: 蟹粉汤包]]';
  // 真实顺序：processAiCommands 先写 content，紧接着补 blocks
  const blocks = [{ type: 'text', text: raw }];
  const content = b.lifeProcessTags(raw, 'chat1:turn1');
  b._applyLifeToBlocks(blocks);
  t('★★ content 拿到了 #ok（写入那步确实跑了）', /\[\[RECEIPT#ok:/.test(content), content);
  t('★★ blocks 里也补上了 #ok —— 否则渲染会说「没记上」而其实记上了',
    /\[\[RECEIPT#ok:/.test(blocks[0].text), blocks[0].text);
  t('★★ 走 blocks 渲染出来是「记下了」不是「没记上」',
    b.lifeTagToHtml(blocks[0].text).includes('🧾 记下了：')
    && !b.lifeTagToHtml(blocks[0].text).includes('没记上'), b.lifeTagToHtml(blocks[0].text));
  t('★ 小票是真的落进 state 了（不是只改了显示）',
    b.lifeReceiptOf(TODAY).some(r => r.t === '蟹粉汤包'), b.lifeReceiptOf(TODAY));
}
{
  // 反向：写入那步真没跑（流式断了）时，blocks 必须原样留着，照实显示「没记上」。
  // 少了这条，上面那几条可以被「无脑给所有标签盖 #ok」骗过去。
  const b = sandbox();
  const blocks = [{ type: 'text', text: '[[RECEIPT: 没跑过的]]' }];
  b._applyLifeToBlocks(blocks);
  t('★★ 写入没跑过时不许假装成功（缓存是空的就原样留着）',
    blocks[0].text === '[[RECEIPT: 没跑过的]]'
    && b.lifeTagToHtml(blocks[0].text).includes('没记上'), blocks[0].text);
}
{
  // 多条 + 记满：结果要按出现顺序一一对上，不能整体盖同一个标记
  const b = sandbox();
  const raw = '[[RECEIPT: 一]][[RECEIPT: 二]]';
  const blocks = [{ type: 'text', text: '[[RECEIPT: 一]]' }, { type: 'text', text: '[[RECEIPT: 二]]' }];
  b.state.lifeReceipts = { [TODAY]: Array.from({ length: b.LIFE_RECEIPT_MAX - 1 }, (_, i) => ({ t: 'x' + i, by: 'user', at: 1 })) };
  b.lifeProcessTags(raw, 'chat1:turn1');
  b._applyLifeToBlocks(blocks);
  t('★★ 跨 block 的多个标签按顺序各拿各的结果（第一条记上、第二条记满）',
    /\[\[RECEIPT#ok: 一\]\]/.test(blocks[0].text) && /\[\[RECEIPT#full: 二\]\]/.test(blocks[1].text),
    [blocks[0].text, blocks[1].text]);
}
{
  // 缓存必须一轮一清，否则这一轮的结果会盖到下一轮的标签上
  const b = sandbox();
  b.lifeProcessTags('[[RECEIPT: 上一轮]]', 'chat1:turn1');
  b._applyLifeToBlocks(null);                       // 这一轮没有 blocks
  const blocks = [{ type: 'text', text: '[[RECEIPT: 下一轮]]' }];
  b._applyLifeToBlocks(blocks);                     // 不许蹭到上一轮的结果
  t('★★ 上一轮的结果不会漏给下一轮（blocks 为空时也要清缓存）',
    blocks[0].text === '[[RECEIPT: 下一轮]]', blocks[0].text);
}
{
  // 功能关着时 content 里标签是被删掉的，blocks 也得删干净，不能露出裸标签
  const b = sandbox({ state: { lifeOn: false } });
  const blocks = [{ type: 'text', text: '前 [[RECEIPT: 关着呢]] 后' }];
  b.lifeProcessTags('前 [[RECEIPT: 关着呢]] 后', 'chat1:turn1');
  b._applyLifeToBlocks(blocks);
  t('★ 功能关着时 blocks 里的裸标签也被抹掉，不会露给用户看',
    blocks[0].text.indexOf('[[RECEIPT') < 0, blocks[0].text);
}
{
  // thinking block 不参与计数，否则思考里出现标签会让后面全部错位
  const b = sandbox();
  const blocks = [{ type: 'thinking', text: '[[RECEIPT: 想的]]' }, { type: 'text', text: '[[RECEIPT: 说的]]' }];
  b.lifeProcessTags('[[RECEIPT: 说的]]', 'chat1:turn1');
  b._applyLifeToBlocks(blocks);
  t('★ thinking 块被跳过，正文那条照样拿到自己的结果',
    /\[\[RECEIPT#ok: 说的\]\]/.test(blocks[1].text) && blocks[0].text === '[[RECEIPT: 想的]]',
    [blocks[0].text, blocks[1].text]);
}
{
  // 三个调用点都得挂上，漏一个就有一条路继续骗人
  const sites = (prompts.match(/_applyLifeToBlocks\(blocks\)/g) || []).length;
  const render = (read('js/06-render-msg.js').match(/_applyLifeToBlocks\(blocks\)/g) || []).length;
  t('★★ processAiCommands 的三个调用点后面都补了 blocks（漏一个就有一条路继续骗人）',
    sites === 2 && render === 1, { 'prompts-api': sites, 'render-msg': render });
}

// ── 约定清单（2026-10-03 加）────────────────────────────────
// 它答应的事落进清单、到日子自己提。会静默出错的地方：
//   · 并发 variant 把同一句答应记成好几条
//   · 日期写成「周末」—— 静默存成今天（马上就「今天到期」）或整条丢掉，都是骗人
//   · KEPT 片段太短一勾勾错一条；勾的是 A、气泡上写的是它随手写的片段
//   · 过期的没进提示词，或者挤掉了别的；回填长得像标签，模型照抄手写假结果
console.log('\n【约定】它答应的事');
{
  const S = sandbox();
  const d3 = S.lifeAdd(TODAY, 3);
  t('★ 带日期的记得进去', S.lifePromiseAdd('下周一起整理书单', d3, 'ai') === 'ok'
    && S.lifePromisesOpen().length === 1 && S.lifePromisesOpen()[0].due === d3);
  t('★ 不带日期的也记得进去', S.lifePromiseAdd('以后每周回顾一次计划', '', 'ai') === 'ok'
    && S.lifePromisesOpen()[1].due === '');
  t('★★ 一模一样的还没兑现 → dup，不重复记（并发 variant 靠这个）',
    S.lifePromiseAdd('下周一起整理书单', d3, 'ai') === 'dup' && S.lifePromisesOpen().length === 2);
  t('★★ 日期没看懂 → 照记但不设到期（不许丢，也不许存成今天）',
    S.lifePromiseAdd('下周一起去图书馆', '下周三', 'ai') === 'nd'
    && S.lifePromisesOpen().find(p => p.t === '下周一起去图书馆').due === '');
  t('★ 日期是过去的 → 同样记成没定日子，别一记下来就过期',
    S.lifePromiseAdd('给她写首诗', ago(5), 'ai') === 'nd'
    && S.lifePromisesOpen().find(p => p.t === '给她写首诗').due === '');
  t('  空的不记', S.lifePromiseAdd('   ', '', 'ai') === '' && S.lifePromisesOpen().length === 4);
}
{
  const S = sandbox();
  for (let i = 0; i < S.LIFE_PROMISE_OPEN_MAX; i++) S.lifePromiseAdd('第' + i + '件', '', 'ai');
  t('★ 没兑现的挂满了拒绝', S.lifePromiseAdd('再多一件', '', 'ai') === 'full'
    && S.lifePromisesOpen().length === S.LIFE_PROMISE_OPEN_MAX);
  S.lifePromiseKeep('第3件');
  t('  勾掉一件就又能记', S.lifePromiseAdd('再多一件', '', 'ai') === 'ok');
}
{
  const S = sandbox();
  S.lifePromiseAdd('下周一起整理书单', '', 'ai');
  S.lifePromiseAdd('明天提醒她交作业', '', 'ai');
  t('★★ 一个字的片段不勾（「整」能命中一半清单）', S.lifePromiseKeep('整') === null
    && S.lifePromisesOpen().length === 2);
  const hit = S.lifePromiseKeep('整理书单');
  t('★ 片段命中就勾掉，记下兑现日', hit && hit.t === '下周一起整理书单' && hit.done === TODAY
    && S.lifePromisesOpen().length === 1);
  t('★ 勾过的不会被再勾一次', S.lifePromiseKeep('整理书单') === null);
  t('  清单里没有的返回 null', S.lifePromiseKeep('去海边') === null);
}
{
  const S = sandbox();
  S.lifePromiseAdd('没日子的', '', 'ai');
  S.lifePromiseAdd('后天的', S.lifeAdd(TODAY, 2), 'ai');
  S.lifePromiseAdd('今天的', TODAY, 'ai');
  // 直接造一条过期的老档（正常入口不收过去的日子）
  S.state.lifePromises.push({ id: 'old', t: '过期的', due: ago(2), at: 1, by: 'ai', done: '' });
  const order = S.lifePromiseSorted().map(p => p.t);
  t('★★ 排序：过期 → 今天 → 近的 → 没日子', JSON.stringify(order) === JSON.stringify(['过期的', '今天的', '后天的', '没日子的']), order);
  t('★ 到期说法', S.lifePromiseWhen(S.lifePromiseSorted()[0]) === '已经过了 2 天'
    && S.lifePromiseWhen(S.lifePromiseSorted()[1]) === '今天到期'
    && S.lifePromiseWhen(S.lifePromiseSorted()[3]) === '没定日子');
  const v = S.lifePromptFor().volatile;
  t('★★ 没兑现的进了提示词，过期的排最前', /你答应过她、还没兑现的：过期的（已经过了 2 天）/.test(v), v);
  t('★ 有快到或过期的 → 叫它自己提', /自己提起来/.test(v));
}
{
  const S = sandbox();
  S.lifePromiseAdd('没日子的', '', 'ai');
  t('★ 只有没日子的 → 只列出来，不催', /没日子的/.test(S.lifePromptFor().volatile)
    && !/自己提起来/.test(S.lifePromptFor().volatile));
  S.lifePromiseKeep('没日子的');
  t('★ 兑现了的不进提示词', !/还没兑现/.test(S.lifePromptFor().volatile));
}
{
  // 预算：约定那段自己封顶，而且不会把整段撑过声称的硬上限
  const S = sandbox();
  for (let i = 0; i < S.LIFE_PROMISE_OPEN_MAX; i++) S.lifePromiseAdd(i + '件'.repeat(70), '', 'ai');
  for (let i = 0; i < S.LIFE_RECEIPT_MAX; i++) S.lifeReceiptAdd(i + '流水'.repeat(60).slice(0, 108), 'user');
  const v = S.lifePromptFor().volatile;
  const seg = v.split('\n')[0];
  t('★★ 约定段被自己的预算截住，还注明了没列的', seg.length < S.LIFE_PROMISE_PROMPT_MAX + 120 && /还有 \d+ 件没列/.test(seg), seg.length);
  t('★★ 撑满时整段仍不超过硬上限', v.length <= S.LIFE_PROMPT_HARD, { got: v.length, hard: S.LIFE_PROMPT_HARD });
  t('★ 小票没被约定挤没', /今天这张小票上已经有/.test(v));
}
{
  // stable 恒定：有没有约定、过没过期，stable 一个字都不变（缓存前缀）
  const A = sandbox(), B3 = sandbox();
  B3.lifePromiseAdd('下周一起整理书单', TODAY, 'ai');
  t('★★ 有没有约定，stable 都一样', A.lifePromptFor().stable === B3.lifePromptFor().stable);
  t('★ stable 里教了两个标签', /\[\[PROMISE:/.test(A.lifePromptFor().stable) && /\[\[KEPT:/.test(A.lifePromptFor().stable));
}
console.log('\n【约定】标签：结果写回标签，渲染 / 回填 / blocks 都照结果');
{
  const S = sandbox();
  const d3 = S.lifeAdd(TODAY, 3);
  const out = S.lifeProcessTags('好，说定了。[[PROMISE: 下周一起整理书单|' + d3 + ']]', 'c:1');
  t('★★ 记上了 → #ok，日期写回', out.includes('[[PROMISE#ok: 下周一起整理书单|' + d3 + ']]'), out);
  t('★ 真的落进 state', S.lifePromisesOpen().some(p => p.t === '下周一起整理书单'));
  const html = S.lifeTagToHtml(out);
  t('★ 气泡：记进清单了 + 到期日', html.includes('🤙 记进约定清单了：下周一起整理书单') && html.includes(d3.slice(5)), html);
  const again = S.lifeProcessTags('[[PROMISE: 下周一起整理书单]]', 'c:2');
  t('★ 再答应一遍 → #dup，且带出原来那条的日期', again.includes('[[PROMISE#dup: 下周一起整理书单|' + d3 + ']]'), again);
  const nd = S.lifeProcessTags('[[PROMISE: 下周一起去图书馆|下周三]]', 'c:3');
  t('★★ 日期没看懂 → #nd，气泡照实说', nd.includes('[[PROMISE#nd: 下周一起去图书馆]]')
    && S.lifeTagToHtml(nd).includes('日期没看懂'), nd);
  const kept = S.lifeProcessTags('书单整理好啦 [[KEPT: 整理书单]]', 'c:4');
  t('★★ KEPT 勾到了 → 标签里写回整条约定（不是它写的片段）', kept.includes('[[KEPT#ok: 下周一起整理书单]]'), kept);
  const nf = S.lifeProcessTags('[[KEPT: 去海边]]', 'c:5');
  t('★ KEPT 没找到 → #nf，气泡说没勾上', nf.includes('[[KEPT#nf: 去海边]]') && S.lifeTagToHtml(nf).includes('没找到'), nf);
}
{
  const S = sandbox();
  const fake = S.lifeProcessTags('[[PROMISE#ok: 根本没记]]', 'c:1');
  t('⚑ 模型自己写的 #ok 不认，真记一次', fake.includes('[[PROMISE#ok: 根本没记]]') && S.lifePromisesOpen().length === 1);
  const fk = S.lifeProcessTags('[[KEPT#ok: 不存在的事]]', 'c:2');
  t('⚑ 模型自己写的 KEPT#ok 不认，没找到就是 #nf', fk.includes('[[KEPT#nf: 不存在的事]]'), fk);
  t('★ 没标记的（写入没跑）气泡不许说成功',
    S.lifeTagToHtml('[[PROMISE: 没跑过]]').includes('没记上') && S.lifeTagToHtml('[[KEPT: 没跑过]]').includes('没勾上'));
}
{
  const S = sandbox();
  const api = S.lifeTagForApi('[[PROMISE#ok: 下周一起整理书单|2099-01-01]] [[KEPT#ok: 给她写首诗]] [[PROMISE: 没记上的]]');
  t('★★ 回填不长得像标签（模型会照抄历史）', api.indexOf('[[') < 0, api);
  t('★ 回填带结果', /记进了约定清单/.test(api) && /勾成做到了/.test(api) && /没记进清单/.test(api), api);
  t('★ 流式遮罩', S.maskStreamingLife('[[PROMISE: 周末|2099-01-01]][[KEPT: 周末]]') === '〔🤙〕〔✅〕');
}
{
  const S = sandbox({ state: { lifeOn: false } });
  t('★ 功能关着：约定标签被抹掉，也不落库',
    S.lifeProcessTags('a[[PROMISE: x]]b[[KEPT: xy]]c') === 'abc' && S.lifePromises().length === 0);
}
{
  // blocks 路径：同小票那一节，结果按顺序补进 blocks
  const S = sandbox();
  S.lifePromiseAdd('明天提醒她交作业', '', 'ai');
  const raw = '[[KEPT: 交作业]]下次再说 [[PROMISE: 一起做手账]]';
  const blocks = [{ type: 'text', text: '[[KEPT: 交作业]]' }, { type: 'text', text: '下次再说 [[PROMISE: 一起做手账]]' }];
  S.lifeProcessTags(raw, 'c:1');
  S._applyLifeToBlocks(blocks);
  t('★★ blocks 里的 KEPT / PROMISE 各拿各的真结果',
    blocks[0].text === '[[KEPT#ok: 明天提醒她交作业]]' && blocks[1].text === '下次再说 [[PROMISE#ok: 一起做手账]]', blocks.map(b => b.text));
  const later = [{ type: 'text', text: '[[PROMISE: 下一轮]]' }];
  S._applyLifeToBlocks(later);
  t('★★ 结果缓存一轮一清', later[0].text === '[[PROMISE: 下一轮]]', later[0].text);
}
{
  const S = sandbox();
  S.lifePromiseAdd('一件事', '', 'ai');
  const id = S.lifePromisesOpen()[0].id;
  S.lifePromiseSetDone(id, true);
  t('★ 面板「做到了」', S.lifePromisesOpen().length === 0 && S.lifePromises()[0].done === TODAY);
  S.lifePromiseSetDone(id, false);
  t('★ 面板「其实没做到」放回去', S.lifePromisesOpen().length === 1);
  S.lifePromiseDel(id);
  t('★ 面板删得掉', S.lifePromises().length === 0);
  for (let i = 0; i < S.LIFE_PROMISE_DONE_KEEP + 5; i++) { S.lifePromiseAdd('旧' + i, '', 'ai'); S.lifePromiseKeep('旧' + i); }
  t('★ 兑现过的只留最近一批，不无限长', S.lifePromises().length === S.LIFE_PROMISE_DONE_KEEP, S.lifePromises().length);
}
{
  const S = sandbox();
  S.lifePromiseAdd('<b>整理</b>书单', S.lifeAdd(TODAY, 1), 'ai');
  S.lifePromiseAdd('她替它记的', '', 'user');
  S.state.lifePromises.push({ id: 'late1', t: '过期那件', due: ago(1), at: 1, by: 'ai', done: '' });
  vm.runInContext('lifeTab("promise")', S);
  const h = S.__el.innerHTML;
  t('★ 面板画出了没兑现的、过期的标出来', h.includes('过期那件') && /life-promise late/.test(h) && h.includes('明天'), h.slice(0, 300));
  t('★ 她记的标出来', h.includes('你记的'));
  t('⚑ 约定正文转义了（模型写的字进 innerHTML）', !h.includes('<b>整理</b>') && h.includes('&lt;b&gt;'));
}
t('★ 面板有「约定」这个 tab', /\['promise', '🤙 约定'\]/.test(src) && /_lifePromiseHtml\(\)/.test(src));
t('★ 帮助和设置里说了约定', /\[\[PROMISE: 那件事\|日期\]\]/.test(html) && /约定都不走云同步/.test(html));

console.log('\n' + (fail ? '✗ ' + fail + ' 条没过' : '✓ 全过') + '（共 ' + (pass + fail) + ' 条）');
process.exit(fail ? 1 : 0);
