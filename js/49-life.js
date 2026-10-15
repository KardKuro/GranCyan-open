// ============================================================
// 生活三件套：今日小票 / 小月历 / 纪念日卡
//
// 三个各自很小的工具，共同点是：**数据只有一份，人和 AI 从各自的入口读写它**。
// 所以真正的危险不在功能本身，在「同一件事算出两个答案」和「补记历史把状态搞乱」。
//
// ── 三条守则 ──
//
// 1) **统计只能有一个实现。** 「下次大概什么时候」在面板上算一遍、在提示词里
//    再算一遍，某天改了公式只改一处，两边就给出两个日期——而且都不报错，
//    你只会觉得「它说的跟我看到的不一样」。所以 lifePeriodStats 是唯一出口。
//
// 2) **允许补记历史，就不能用「最新一条」判进行中。**
//    这是别人上线当天就翻的车：先记了最近一次，再回头补四月的，
//    于是四月那条永远显示「进行中」，怎么点都关不上。
//    根因是「进行中 = 数组里最新那条且没有 end」这个假设在乱序录入下直接崩。
//    这里的判法是：**只有 start 最晚的那一条才可能是进行中**；
//    其余没 end 的一律算「忘了记结束」，标出来，且不进统计。
//
// 3) **离群值不能进平均。** 漏记几个月会造出一个 200 天的间隔，
//    忘记标结束会造出一个 40 天的经期。这两个数字混进平均值里，
//    「预计下次」就会安静地偏出去十几天——看着仍然是个正常日期。
// ============================================================

// ── 日期：全程用 'YYYY-MM-DD' 字符串 ────────────────────────
// ⚠️ 用字符串而不是 Date 对象，是因为这里全是「哪一天」而不是「哪一刻」。
//    Date 一掺进来就要处理时区，而 new Date('2026-08-30') 是 UTC 零点，
//    在东八区会变成 8 月 30 日 08:00，跨月边界上直接差一天——零报错。
function lifeToday() {
  const d = new Date();
  return lifeYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
function lifeYmd(y, m, d) {
  return String(y) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
// 归一化：'2026-8-1' / '2026/08/01' 都收成 '2026-08-01'。
// 不归一化的话字典序排序会错位（'2026-8-1' > '2026-12-01'），而排序错了
// 「最晚的一条」就选错，第 2 条守则整个失效。
function lifeNorm(s) {
  const m = String(s || '').match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  // ⚠️ 格式对 ≠ 这天存在。'2026-02-31' 能过上面的范围检查，
  //    但 Date.UTC 会把它滚成 3 月 3 日 —— 于是同一条记录在**字符串排序**里
  //    是 2 月的、在**做差统计**里是 3 月的，两处代表两个日期，零报错。
  //    拿 UTC 走一个来回，滚过头就说明这天不存在。（Codex 逮到的）
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return lifeYmd(y, mo, d);
}
function lifeDays(a, b) {          // b - a，天数
  const pa = lifeNorm(a), pb = lifeNorm(b);
  if (!pa || !pb) return null;
  const ta = Date.UTC(+pa.slice(0, 4), +pa.slice(5, 7) - 1, +pa.slice(8, 10));
  const tb = Date.UTC(+pb.slice(0, 4), +pb.slice(5, 7) - 1, +pb.slice(8, 10));
  return Math.round((tb - ta) / 86400000);
}
function lifeAdd(a, n) {
  const p = lifeNorm(a);
  if (!p) return '';
  const t = Date.UTC(+p.slice(0, 4), +p.slice(5, 7) - 1, +p.slice(8, 10)) + n * 86400000;
  const d = new Date(t);
  return lifeYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// ============================================================
// 今日小票
// ============================================================
const LIFE_RECEIPT_MAX = 40;       // 一天最多记这么多条，防止无限长
const LIFE_RECEIPT_KEEP = 120;     // 只留最近这么多天
// 并发去重的时间窗。几个 variant 相隔毫秒级；同一件事真的做两次至少隔几分钟。
// 取 30 秒：够宽能盖住慢的那个 variant，够窄不会吞掉「晚上又吃了一次药」。
const LIFE_DEDUP_MS = 30000;
// 当前这一轮的来源键（对话 id + 用户轮次 id）。lifeProcessTags 进来时设、出去时清。
// ⚠️ 用模块级变量而不是给 lifeReceiptAdd 加参数，是因为它还有面板那条调用路径；
//    进出都锁在 lifeProcessTags 一个函数里，看得住。
let _lifeTurnKey = '';

function lifeReceipts() {
  const r = (typeof state === 'object' && state && state.lifeReceipts);
  return (r && typeof r === 'object') ? r : {};
}

function lifeReceiptOf(day) {
  const list = lifeReceipts()[lifeNorm(day) || day];
  return Array.isArray(list) ? list : [];
}

// by: 'user' = 她自己记的，'ai' = 它替她记的。
// ⚠️ 必须分开标：混在一起的话，某天她看着一条自己完全没印象的记录，
//    分不清是自己忘了还是它记岔了。
function lifeReceiptAdd(text, by, day) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (typeof state !== 'object' || !state) return false;
  const d = lifeNorm(day) || lifeToday();
  if (!state.lifeReceipts || typeof state.lifeReceipts !== 'object') state.lifeReceipts = {};
  const list = Array.isArray(state.lifeReceipts[d]) ? state.lifeReceipts[d] : [];
  // ⚠️ 多模型并排时几个 variant 会各跑一次 processAiCommands，同一句被记好几条。
  //    但**不能拿正文当幂等键**：上午和晚上各「吃了一次药」是两件真事，
  //    按内容查重会把第二次静默吞掉，还返回成功、界面照样显示「记下了」——
  //    我为了修多 variant 引入的这个查重，本身就是个新的静默失败。（Codex 四审逮到的）
  //
  //    也不能**只**靠时间窗：她若真在窗口内记两次同样的还是会被吞，
  //    慢的那个 variant 若超出窗口又会漏进来 —— 两头都不严。（Codex 五审逮到的）
  //    正解是**来源键**：同一个对话的同一轮 = 同一次调用，隔多久都算重复；
  //    换一轮就是新的一件事，隔一秒也照记。时间窗只在拿不到来源键时兜底
  //    （面板直接调、以及将来别处的调用点）。
  const txt = t.slice(0, 120);
  const now = Date.now();
  const key = _lifeTurnKey;
  if (key) {
    if (list.some(r => r && r.k === key && r.t === txt)) return true;
  } else if (list.some(r => r && r.t === txt && now - (Number(r.at) || 0) < LIFE_DEDUP_MS)) {
    return true;
  }
  if (list.length >= LIFE_RECEIPT_MAX) return false;
  list.push({ t: txt, by: by === 'ai' ? 'ai' : 'user', at: Date.now(), k: key || undefined });
  state.lifeReceipts[d] = list;
  lifeReceiptTrim();
  try { save(); } catch {}
  return true;
}

function lifeReceiptDel(day, idx) {
  if (typeof state !== 'object' || !state || !state.lifeReceipts) return;
  const d = lifeNorm(day) || day;
  const list = state.lifeReceipts[d];
  if (!Array.isArray(list) || idx < 0 || idx >= list.length) return;
  list.splice(idx, 1);
  if (!list.length) delete state.lifeReceipts[d];
  try { save(); } catch {}
}

// 只留最近 N 天。没有这道，记两年之后每次 save() 都要重写一大坨。
function lifeReceiptTrim() {
  if (typeof state !== 'object' || !state || !state.lifeReceipts) return;
  const days = Object.keys(state.lifeReceipts).filter(k => lifeNorm(k)).sort();
  while (days.length > LIFE_RECEIPT_KEEP) delete state.lifeReceipts[days.shift()];
}

// ============================================================
// 小月历
// ============================================================
const LIFE_CYCLE_MAX = 120;        // 间隔超过这个就是漏记了，不进平均
const LIFE_LEN_MAX = 15;           // 经期超过这个就是忘了标结束，不进平均
const LIFE_CYCLE_DEF = 28;

function lifePeriods() {
  const p = (typeof state === 'object' && state && state.lifePeriods);
  return Array.isArray(p) ? p : [];
}

// 排好序、洗干净的记录。**所有读取都必须经过它**——
// 直接读 state.lifePeriods 就会拿到用户补记时的乱序数组。
function lifePeriodList() {
  return lifePeriods()
    .map(p => ({ start: lifeNorm(p && p.start), end: lifeNorm(p && p.end) }))
    .filter(p => p.start)
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ⚠️ 第 2 条守则的落点。
//    「进行中」只能是 start 最晚的那一条，而且它得没有 end。
//    其余没有 end 的一律是「忘了标结束」，要单独报出来让人去补，
//    不能当成进行中（那样会有两条同时进行中，而且早的那条永远关不上）。
function lifePeriodOpen() {
  const list = lifePeriodList();
  if (!list.length) return { current: null, unclosed: [] };
  const last = list[list.length - 1];
  const unclosed = list.slice(0, -1).filter(p => !p.end);
  // ⚠️ 最晚那条没记结束，也不等于「现在还在进行中」。
  //    忘了记结束、之后几个月又没再记，它会**永远**是 current ——
  //    面板显示「第 100 天」，提示词还一本正经告诉模型她正在经期。
  //    LIFE_LEN_MAX 只过滤填了 end 的，救不到这一条。（Codex 逮到的）
  let current = last.end ? null : last;
  if (current) {
    const run = lifeDays(current.start, lifeToday());
    if (run == null || run + 1 > LIFE_LEN_MAX) { unclosed.push(current); current = null; }
  }
  unclosed.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return { current, unclosed };
}

// 唯一的统计出口。面板、提示词、AI 工具全走它。
function lifePeriodStats() {
  const list = lifePeriodList();
  const out = {
    n: list.length, avgCycle: null, avgLen: null, next: null, delta: null,
    current: null, unclosed: [], last: null
  };
  const open = lifePeriodOpen();
  out.current = open.current;
  out.unclosed = open.unclosed;
  if (!list.length) return out;
  out.last = list[list.length - 1];

  // 间隔：相邻两次开始之间。离群的丢掉（漏记几个月会造出一个 200 天的间隔）
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const g = lifeDays(list[i - 1].start, list[i].start);
    if (g != null && g > 0 && g <= LIFE_CYCLE_MAX) gaps.push(g);
  }
  if (gaps.length) out.avgCycle = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);

  // 时长：只算记完了的，且离群的丢掉（忘了标结束会造出一个 40 天的经期）
  const lens = [];
  for (const p of list) {
    if (!p.end) continue;
    const L = lifeDays(p.start, p.end);
    if (L != null && L >= 0 && L + 1 <= LIFE_LEN_MAX) lens.push(L + 1);
  }
  if (lens.length) out.avgLen = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);

  // 预计下次：拿平均周期推。样本不够就用 28 天，但要让调用方知道这是猜的。
  const cyc = out.avgCycle || LIFE_CYCLE_DEF;
  out.cycleIsGuess = !out.avgCycle;
  out.next = lifeAdd(out.last.start, cyc);
  out.delta = lifeDays(lifeToday(), out.next);   // 正=还有几天，负=晚了几天
  return out;
}

function lifePeriodAdd(start, end) {
  const s = lifeNorm(start);
  if (!s) return false;
  // ⚠️ end 填了但格式不对 → 必须**失败**，不能 `lifeNorm(end) || ''` 静默当成没填。
  //    静默的话她以为记上了，实际那次永远显示「没记结束」，还不进统计。（Codex 逮到的）
  const raw = String(end == null ? '' : end).trim();
  const e = raw ? lifeNorm(raw) : '';
  if (raw && !e) return false;
  if (e && lifeDays(s, e) < 0) return false;      // 填反了：结束早于开始
  if (typeof state !== 'object' || !state) return false;
  if (!Array.isArray(state.lifePeriods)) state.lifePeriods = [];
  // 同一天不重复记
  if (state.lifePeriods.some(p => lifeNorm(p && p.start) === s)) return false;
  state.lifePeriods.push({ start: s, end: e });
  try { save(); } catch {}
  return true;
}

function lifePeriodClose(start, end) {
  const s = lifeNorm(start);
  // ⚠️ 和 lifePeriodAdd 同款：填了但格式不对必须**失败**，
  //    不能 `lifeNorm(end) || lifeToday()` 静默存成今天 ——
  //    她输入「八月一号」会得到一个「成功」和一个根本不对的日期。
  //    （Add 那处上一轮修了，Close 这处漏了，Codex 二审逮到的。）
  const raw = String(end == null ? '' : end).trim();
  const e = raw ? lifeNorm(raw) : lifeToday();
  if (raw && !e) return false;
  if (!s || typeof state !== 'object' || !state) return false;
  const hit = (state.lifePeriods || []).find(p => lifeNorm(p && p.start) === s);
  if (!hit) return false;
  // 结束不能早于开始 —— 允许手填日期就一定有人填反
  if (lifeDays(s, e) < 0) return false;
  hit.end = e;
  try { save(); } catch {}
  return true;
}

function lifePeriodDel(start) {
  const s = lifeNorm(start);
  if (!s || typeof state !== 'object' || !state) return;
  state.lifePeriods = (state.lifePeriods || []).filter(p => lifeNorm(p && p.start) !== s);
  try { save(); } catch {}
}

// ============================================================
// 纪念日卡
// ============================================================
function lifeAnnivs() {
  const a = (typeof state === 'object' && state && state.lifeAnnivs);
  return Array.isArray(a) ? a : [];
}

// 今年的这一天是几号。
// ⚠️ 2 月 29 日：平年没有这天，落到 2 月 28 日。不处理的话 lifeNorm 会
//    收下 '2027-02-29' 这个不存在的日期，然后「还有几天」算出个负数，
//    纪念日就永远不提醒了——零报错。
function lifeAnnivThisYear(date, year) {
  const p = lifeNorm(date);
  if (!p) return '';
  const y = year || +lifeToday().slice(0, 4);
  let mo = +p.slice(5, 7), d = +p.slice(8, 10);
  if (mo === 2 && d === 29) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!leap) d = 28;
  }
  return lifeYmd(y, mo, d);
}

// 距离下一次还有几天（今天就是 0）。过了今年的就看明年。
function lifeAnnivDaysLeft(date) {
  const today = lifeToday();
  const y = +today.slice(0, 4);
  const a = lifeAnnivThisYear(date, y);
  if (!a) return null;
  let n = lifeDays(today, a);
  if (n != null && n < 0) n = lifeDays(today, lifeAnnivThisYear(date, y + 1));
  return n;
}

function lifeAnnivAdd(name, date) {
  const nm = String(name || '').trim().slice(0, 40);
  const d = lifeNorm(date);
  if (!nm || !d) return false;
  if (typeof state !== 'object' || !state) return false;
  if (!Array.isArray(state.lifeAnnivs)) state.lifeAnnivs = [];
  state.lifeAnnivs.push({ id: 'a' + Date.now().toString(36), name: nm, date: d, cards: {} });
  try { save(); } catch {}
  return true;
}

function lifeAnnivDel(id) {
  if (typeof state !== 'object' || !state) return;
  state.lifeAnnivs = lifeAnnivs().filter(a => a && a.id !== id);
  try { save(); } catch {}
}

// 今天是不是某个纪念日
function lifeAnnivToday() {
  const today = lifeToday();
  return lifeAnnivs().filter(a => a && lifeAnnivThisYear(a.date) === today);
}

// AI 写的卡片：一年一张，按年份存。
// 已经写过的那年**不覆盖**——它每年只写一次，重写会把去年那张顶掉，
// 而「历年可翻」正是这个功能的全部意义。
function lifeAnnivCardSet(id, year, text) {
  const a = lifeAnnivs().find(x => x && x.id === id);
  if (!a) return false;
  const body = String(text || '').trim();
  if (!body) return false;                   // 空卡片不存：存了会把那年的位置占掉
  const y = String(year || lifeToday().slice(0, 4));
  if (!a.cards || typeof a.cards !== 'object') a.cards = {};
  // ⚠️ 用「有没有这个键」判，不看值的真假。原来写 `if (a.cards[y])`，
  //    那年若存过空串就会被判成「没写过」，于是能被覆盖一次 —— 而
  //    「一年一张、往年可翻」正是这个功能的全部意义。（Codex 逮到的）
  if (Object.prototype.hasOwnProperty.call(a.cards, y)) return false;
  a.cards[y] = body.slice(0, 600);
  try { save(); } catch {}
  return true;
}

function lifeAnnivCard(id, year) {
  const a = lifeAnnivs().find(x => x && x.id === id);
  if (!a || !a.cards) return '';
  return a.cards[String(year || lifeToday().slice(0, 4))] || '';
}

// ============================================================
// 约定（它答应过她的事）—— 2026-10-03 加，点子来自社区分享
//
// 它在回复里顺口答应的事（「周末陪你看电影」「明天提醒你交作业」）
// 写一个 [[PROMISE: 事|日期]] 落进清单；到日子或过了日子，提示词里会提醒它自己提起来，
// 做到了写 [[KEPT: 那件事里的几个字]] 勾掉。
//
// ⚠️ 跟小票一样的两道坑，这里也得防：
//   · 几个 variant 并发会把同一句答应记成好几条 → 用「清单里已经有一模一样的、还没兑现的」去重，
//     不靠时间窗（约定不像小票，同一件事一天答应两次也还是同一件事）
//   · 日期写错（「周末」「下周三」）不能静默存成今天、也不能整条丢掉 ——
//     丢了就是它答应了却没人记得，比没日期更糟。存成「没定日子」，气泡上照实说没看懂日期。
// ============================================================
const LIFE_PROMISE_OPEN_MAX = 30;      // 没兑现的最多挂这么多，再多就是它在乱许愿了
const LIFE_PROMISE_DONE_KEEP = 60;     // 兑现过的只留最近这么多条

function lifePromises() {
  const a = (typeof state === 'object' && state && state.lifePromises);
  return Array.isArray(a) ? a : [];
}
function lifePromisesOpen() { return lifePromises().filter(p => p && !p.done); }

// 返回 'ok' | 'nd'（记上了但日期没看懂/已经过去）| 'dup' | 'full' | ''（空的，没记）
function lifePromiseAdd(text, due, by) {
  const t = String(text == null ? '' : text).trim().slice(0, 80);
  if (!t) return '';
  if (typeof state !== 'object' || !state) return '';
  if (!Array.isArray(state.lifePromises)) state.lifePromises = [];
  if (lifePromisesOpen().some(p => p.t === t)) return 'dup';
  if (lifePromisesOpen().length >= LIFE_PROMISE_OPEN_MAX) return 'full';
  const rawDue = String(due == null ? '' : due).trim();
  let d = rawDue ? lifeNorm(rawDue) : '';
  // 日期早于今天：多半是它把「10-05」写成了去年，或者干脆写错了。存成没日子，别一记下来就算过期
  if (d && lifeDays(lifeToday(), d) < 0) d = '';
  state.lifePromises.push({
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    t, due: d, at: Date.now(), by: by === 'user' ? 'user' : 'ai', done: '',
  });
  try { save(); } catch {}
  return (rawDue && !d) ? 'nd' : 'ok';
}

// 它写 [[KEPT: 几个字]] 时按片段找。只找还没兑现的，找到第一条就勾掉。
// 片段至少两个字：一个字（「看」）能命中一半的清单，勾错了比没勾更糟。
function lifePromiseKeep(frag) {
  const f = String(frag == null ? '' : frag).trim();
  if (f.length < 2) return null;
  const hit = lifePromisesOpen().find(p => p.t.indexOf(f) >= 0 || f.indexOf(p.t) >= 0);
  if (!hit) return null;
  hit.done = lifeToday();
  lifePromiseTrim();
  try { save(); } catch {}
  return hit;
}

function lifePromiseTrim() {
  if (typeof state !== 'object' || !state || !Array.isArray(state.lifePromises)) return;
  const done = state.lifePromises.filter(p => p && p.done);
  if (done.length <= LIFE_PROMISE_DONE_KEEP) return;
  done.sort((a, b) => String(a.done).localeCompare(String(b.done)) || (a.at || 0) - (b.at || 0));
  const drop = new Set(done.slice(0, done.length - LIFE_PROMISE_DONE_KEEP).map(p => p.id));
  state.lifePromises = state.lifePromises.filter(p => p && !drop.has(p.id));
}

// 面板上她手动点「做到了」/「其实没做到」
function lifePromiseSetDone(id, on) {
  const p = lifePromises().find(x => x && x.id === id);
  if (!p) return false;
  p.done = on ? lifeToday() : '';
  if (on) lifePromiseTrim();
  try { save(); } catch {}
  return true;
}

function lifePromiseDel(id) {
  if (typeof state !== 'object' || !state) return;
  state.lifePromises = lifePromises().filter(p => p && p.id !== id);
  try { save(); } catch {}
}

// 距到期还有几天：负数 = 过了几天；没定日子 = null
function lifePromiseDaysLeft(p) {
  if (!p || !p.due) return null;
  return lifeDays(lifeToday(), p.due);
}

// 没兑现的排个序：过期的最前（过得越久越前），然后按到期近远，没日子的垫底（先答应的在前）
function lifePromiseSorted() {
  return lifePromisesOpen().slice().sort((a, b) => {
    const da = lifePromiseDaysLeft(a), db = lifePromiseDaysLeft(b);
    if (da == null && db == null) return (a.at || 0) - (b.at || 0);
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db || (a.at || 0) - (b.at || 0);
  });
}

function lifePromiseWhen(p) {
  const n = lifePromiseDaysLeft(p);
  if (n == null) return '没定日子';
  if (n === 0) return '今天到期';
  if (n < 0) return '已经过了 ' + (-n) + ' 天';
  if (n === 1) return '明天到期';
  // 不带括号：提示词和面板外面都会再包一层括号，套娃难看
  return p.due.slice(5) + ' 到期，还有 ' + n + ' 天';
}

// ============================================================
// 标签协议
//
// 只给 AI 两个写入口：记一条小票、写一张纪念日卡。
// **月历它只能读不能写** —— 那是她身体的记录，替她记等于替她篡改，
// 而且记错了她要花很久才发现（周期统计会被一条假记录整个带偏）。
// ============================================================
function lifeEnabled() {
  return typeof state === 'object' && state && state.lifeOn !== false;
}
// 月历单独一道开关：它会进提示词，也就是会发给模型。
function lifeCycleShared() {
  return lifeEnabled() && (typeof state === 'object' && state && state.lifeCycleShare !== false);
}

// ⚠️⚠️ 副作用的**结果**必须写回标签，渲染层照结果画。
//    原来是「不管写没写进去，一律画一张『记下了』」——
//    今天满 40 条、纪念日名字差一个字、今年已经写过卡片，
//    这三种情况数据层都拒绝了，聊天里却照样显示成功。
//    她之后翻面板才发现根本没有，而那时早忘了是哪条。（Codex 逮到的）
//    跟塔罗一个解法：结果固化进标签文本，跟着这条消息走。
function lifeReceiptTagRe() { return /\[\[RECEIPT(#[a-z]{2,8})?:\s*([^\]]{1,120})\]\]/g; }
function lifeAnnivTagRe() { return /\[\[ANNIV(#[a-z]{2,8})?:\s*([^\]|]{1,40})\|([^\]]{1,600})\]\]/g; }
// 约定：日期那截可有可无。[[PROMISE: 下周一起整理书单|2026-10-05]] / [[PROMISE: 以后每周回顾一次计划]]
function lifePromiseTagRe() { return /\[\[PROMISE(#[a-z]{2,8})?:\s*([^\]|]{1,80})(?:\|([^\]]{0,20}))?\]\]/g; }
function lifeKeptTagRe() { return /\[\[KEPT(#[a-z]{2,8})?:\s*([^\]]{1,80})\]\]/g; }

// 拼来源键：两截**都得有**才算数，缺一截就返回空串、让调用方退回时间窗兜底。
// ⚠️ 原来在调用方那边直接写 `(chat && chat.id) + ':' + (turnId || '')` ——
//    缺 turnId 拼出来是 `chat-1:`，连 chat 都没有时是 `undefined:`，
//    **两个都是真值**，于是永远走来源键分支：同一个对话里以后再记同一句话，
//    会被无限期当成「同一轮的重复」静默吞掉，压根到不了那 30 秒兜底。
//    零报错，界面照样显示「记下了」。（Codex 六审逮到的）
function lifeTurnKey(chatId, turnId) {
  const a = String(chatId == null ? '' : chatId).trim();
  const b = String(turnId == null ? '' : turnId).trim();
  return (a && b) ? (a + ':' + b) : '';
}

// 本轮 lifeProcessTags 产出的标签文本，按出现顺序。只给 _applyLifeToBlocks 用。
//
// ⚠️ 为什么非要有这一份：blocks 非空时渲染**完全不看 content**（06-render-msg.js:483），
//    而 blocks 里躺的是流式一个字一个字收进来的**原始**文本 —— 上面没有 #ok 标记。
//    于是小票明明已经记进去了，气泡上却写着「🧾 这条没记上」，反着骗人。
//    育儿室 / 体征 / 学习 / 檐廊 / 偷看 等功能都各配了一份
//    _applyXxxToBlocks 补这一刀，生活和塔罗当初漏了。
let _lifeReceiptOut = [], _lifeAnnivOut = [], _lifePromiseOut = [], _lifeKeptOut = [];

// turnKey = 「哪个对话的哪一轮」。同一轮里几个 variant 并发跑到这儿，靠它去重才准。
function lifeProcessTags(text, turnKey) {
  if (!text) return text;
  let out = String(text);
  _lifeReceiptOut = []; _lifeAnnivOut = []; _lifePromiseOut = []; _lifeKeptOut = [];
  _lifeTurnKey = turnKey || '';
  try {
  if (out.indexOf('[[RECEIPT') >= 0) {
    out = out.replace(lifeReceiptTagRe(), (m, mark, body) => {
      if (!lifeEnabled()) { _lifeReceiptOut.push(''); return ''; }
      // ⚠️⚠️ 模型自己写出来的 #ok 一律不认，照样真的去记一次、用真结果盖掉。
      //    Codex 二审逮到的：原本这里「已经有标记就放行」，等于模型输出
      //    [[RECEIPT#ok: 根本没存]] 就能让界面显示「记下了」而实际什么都没存。
      //    敢无条件重跑，是因为 processAiCommands 的三个调用点（05-prompts-api.js 两处、
      //    06-render-msg.js 一处）传的都是本轮刚生成的 finalText / fullText，从来不是存下来的历史。
      //    ⚠️ 将来谁要加「对历史文本重跑」的路径，得先在这里想清楚，否则历史里的记录会被重复记。
      const ok = lifeReceiptAdd(body, 'ai');
      const done = '[[RECEIPT#' + (ok ? 'ok' : 'full') + ': ' + body + ']]';
      _lifeReceiptOut.push(done);
      return done;
    });
  }
  if (out.indexOf('[[ANNIV') >= 0) {
    out = out.replace(lifeAnnivTagRe(), (m, mark, name, body) => {
      if (!lifeEnabled()) { _lifeAnnivOut.push(''); return ''; }
      // 同上：模型自己写的 #ok / #dup 都不认，真跑一次拿真结果。
      const nm = String(name).trim();
      const a = lifeAnnivs().find(x => x && x.name === nm);
      let st = 'nf';                            // 没找到这个纪念日
      // ⚠️ 还要验今天**确实是**那个日子。不验的话它提前一天写一张，
      //    就把今年唯一的名额占掉了 —— 真到日子那天只能拿到 #dup。（Codex 三审逮到的）
      if (a && lifeAnnivThisYear(a.date) !== lifeToday()) st = 'early';
      else if (a) st = lifeAnnivCardSet(a.id, lifeToday().slice(0, 4), body) ? 'ok' : 'dup';
      const done = '[[ANNIV#' + st + ': ' + name + '|' + body + ']]';
      _lifeAnnivOut.push(done);
      return done;
    });
  }
  // 约定：同上，模型自己写的标记不认，真跑一次。
  // ⚠️ 先勾 KEPT 再记 PROMISE：同一条回复里「上次答应的做到了，下次再陪你」——
  //    反过来的话新记的那条可能被同一个片段顺手勾掉。
  if (out.indexOf('[[KEPT') >= 0) {
    out = out.replace(lifeKeptTagRe(), (m, mark, frag) => {
      if (!lifeEnabled()) { _lifeKeptOut.push(''); return ''; }
      const hit = lifePromiseKeep(frag);
      // 勾到的那条把全文写回标签：气泡和回填都按它真正勾掉的那条说，不按它写的片段说
      const done = hit ? '[[KEPT#ok: ' + hit.t + ']]' : '[[KEPT#nf: ' + String(frag).trim() + ']]';
      _lifeKeptOut.push(done);
      return done;
    });
  }
  if (out.indexOf('[[PROMISE') >= 0) {
    out = out.replace(lifePromiseTagRe(), (m, mark, body, due) => {
      if (!lifeEnabled()) { _lifePromiseOut.push(''); return ''; }
      const st = lifePromiseAdd(body, due, 'ai') || 'empty';
      const p = lifePromisesOpen().find(x => x.t === String(body).trim().slice(0, 80));
      const d = (p && p.due) ? '|' + p.due : '';
      const done = '[[PROMISE#' + st + ': ' + String(body).trim() + d + ']]';
      _lifePromiseOut.push(done);
      return done;
    });
  }
  return out;
  } finally { _lifeTurnKey = ''; }   // 出去就清，别让面板那条路蹭到上一轮的键
}

// 把本轮真实结果补进 blocks。**必须紧跟在 processAiCommands 后面同步调用** ——
// 中间不能有 await：这份缓存是模块级的，多模型并排是真并发，一让出线程就会串线。
// （其余七个 _applyXxxToBlocks 都是同一个前提，调用点也都挨着。）
function _applyLifeToBlocks(blocks) {
  // 先取走再清空：blocks 为空时也得清，否则这一轮的结果会漏给下一轮。
  const rc = _lifeReceiptOut, ac = _lifeAnnivOut, pc = _lifePromiseOut, kc = _lifeKeptOut;
  _lifeReceiptOut = []; _lifeAnnivOut = []; _lifePromiseOut = []; _lifeKeptOut = [];
  if (!blocks || !blocks.length) return;
  let ri = 0, ai = 0, pi = 0, ki = 0;
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text || b.text.indexOf('[[') < 0) continue;
    if (b.text.indexOf('[[RECEIPT') >= 0) {
      b.text = b.text.replace(lifeReceiptTagRe(), m => {
        const o = rc[ri++];
        // 没有对应结果 = 写入那一步真的没跑（流式断了）。原样留着，
        // 让 lifeTagToHtml 照实画「没记上」—— 这时候画成功才是撒谎。
        return o === undefined ? m : o;
      });
    }
    if (b.text.indexOf('[[ANNIV') >= 0) {
      b.text = b.text.replace(lifeAnnivTagRe(), m => {
        const o = ac[ai++];
        return o === undefined ? m : o;
      });
    }
    if (b.text.indexOf('[[KEPT') >= 0) {
      b.text = b.text.replace(lifeKeptTagRe(), m => {
        const o = kc[ki++];
        return o === undefined ? m : o;
      });
    }
    if (b.text.indexOf('[[PROMISE') >= 0) {
      b.text = b.text.replace(lifePromiseTagRe(), m => {
        const o = pc[pi++];
        return o === undefined ? m : o;
      });
    }
  }
}

function lifeTagToHtml(text) {
  if (!text) return text;
  const esc = (typeof escHtml === 'function') ? escHtml : (s => String(s == null ? '' : s));
  let out = String(text);
  if (out.indexOf('[[RECEIPT') >= 0) {
    out = out.replace(lifeReceiptTagRe(), (m, mark, body) => {
      const t = esc(String(body).trim());
      // 没有标记 = 副作用那一步压根没跑（流式断了 / 功能关着），
      // 这时候也不能画成功 —— 画了就是撒谎。
      if (mark === '#full') return '<div class="life-chip life-chip-no">🧾 今天记满了，这条没记上：' + t + '</div>';
      if (mark !== '#ok') return '<div class="life-chip life-chip-no">🧾 这条没记上：' + t + '</div>';
      return '<div class="life-chip">🧾 记下了：' + t + '</div>';
    });
  }
  if (out.indexOf('[[ANNIV') >= 0) {
    out = out.replace(lifeAnnivTagRe(), (m, mark, name, body) => {
      const n = esc(String(name).trim()), b = esc(String(body).trim());
      if (mark === '#nf') return '<div class="life-chip life-chip-no">💌 没有叫「' + n + '」的纪念日，这张没存下</div>';
      if (mark === '#early') return '<div class="life-chip life-chip-no">💌 还没到「' + n + '」那天，这张没存下</div>';
      if (mark === '#dup') return '<div class="life-chip life-chip-no">💌 「' + n + '」今年的卡片已经写过了，这张没存下</div>';
      if (mark !== '#ok') return '<div class="life-chip life-chip-no">💌 这张卡没存下</div>';
      return '<div class="life-card"><div class="life-card-h">💌 ' + n + '</div>'
        + '<div class="life-card-b">' + b + '</div></div>';
    });
  }
  if (out.indexOf('[[PROMISE') >= 0) {
    out = out.replace(lifePromiseTagRe(), (m, mark, body, due) => {
      const t = esc(String(body).trim());
      const d = lifeNorm(due || '');
      const when = d ? '（' + esc(d.slice(5)) + ' 前）' : '';
      if (mark === '#ok') return '<div class="life-chip">🤙 记进约定清单了：' + t + when + '</div>';
      if (mark === '#nd') return '<div class="life-chip">🤙 记进约定清单了：' + t + '（日期没看懂，先记成没定日子）</div>';
      if (mark === '#dup') return '<div class="life-chip">🤙 这件事本来就在约定清单上：' + t + when + '</div>';
      if (mark === '#full') return '<div class="life-chip life-chip-no">🤙 约定清单挂满了，这条没记上：' + t + '</div>';
      return '<div class="life-chip life-chip-no">🤙 这条约定没记上：' + t + '</div>';
    });
  }
  if (out.indexOf('[[KEPT') >= 0) {
    out = out.replace(lifeKeptTagRe(), (m, mark, frag) => {
      const t = esc(String(frag).trim());
      if (mark === '#ok') return '<div class="life-chip">✅ 兑现了：' + t + '</div>';
      if (mark === '#nf') return '<div class="life-chip life-chip-no">✅ 约定清单里没找到「' + t + '」，没勾上</div>';
      return '<div class="life-chip life-chip-no">✅ 没勾上：' + t + '</div>';
    });
  }
  return out;
}

// 回填：换成中性文本。
// ⚠️ 换进去的**不能长得像卡片**，模型会照着历史里的样子学，
//    下次自己手写一个假卡片出来（tag-format-imitation 那条坑）。
function lifeTagForApi(text) {
  if (!text) return text;
  let out = String(text);
  // 回填也要带上结果，否则它下一轮以为记成功了，会接着说「已经帮你记下了」
  if (out.indexOf('[[RECEIPT') >= 0) out = out.replace(lifeReceiptTagRe(), (m, mark, b) =>
    (mark === '#ok' ? '[记了一条：' : '[没记上：') + String(b).trim() + ']');
  if (out.indexOf('[[ANNIV') >= 0) out = out.replace(lifeAnnivTagRe(), (m, mark, n) =>
    (mark === '#ok' ? '[写了一张给「' : '[没能写给「') + String(n).trim() + '」的卡]');
  if (out.indexOf('[[PROMISE') >= 0) out = out.replace(lifePromiseTagRe(), (m, mark, b, due) => {
    const t = String(b).trim(), d = lifeNorm(due || '');
    if (mark === '#ok' || mark === '#nd') return '[答应了她：' + t + (d ? '，' + d + ' 前' : '') + '，记进了约定清单]';
    if (mark === '#dup') return '[答应了她：' + t + '（清单上本来就有）]';
    return '[答应了她：' + t + '（没记进清单）]';
  });
  if (out.indexOf('[[KEPT') >= 0) out = out.replace(lifeKeptTagRe(), (m, mark, f) =>
    (mark === '#ok' ? '[把约定「' + String(f).trim() + '」勾成做到了]' : '[想勾掉「' + String(f).trim() + '」但清单里没有]'));
  return out;
}

function maskStreamingLife(text) {
  if (!text) return text;
  let out = String(text);
  if (out.indexOf('[[RECEIPT') >= 0) out = out.replace(lifeReceiptTagRe(), '〔🧾〕');
  if (out.indexOf('[[ANNIV') >= 0) out = out.replace(lifeAnnivTagRe(), '〔💌〕');
  if (out.indexOf('[[PROMISE') >= 0) out = out.replace(lifePromiseTagRe(), '〔🤙〕');
  if (out.indexOf('[[KEPT') >= 0) out = out.replace(lifeKeptTagRe(), '〔✅〕');
  return out;
}

// ── 提示词 ──────────────────────────────────────────────────
// 进提示词的硬预算。没有它的话，合法的 40 条小票 × 每条 120 字就是五千字，
// 每一轮都发一遍 —— 而这不是异常数据，是这功能正常用一天的量。
// （我上一轮报的「112 字」是空数据时量的，Codex 二审拿满数据实跑打出来的是 5144 字。）
// 逐条预算。兜底那一刀切在 +60 处（留一行的余量），所以实际硬上限就是 760，
// 不是「700 但其实能到 901」—— 常量和实际对不上的话，下次有人照着 700 去估算
// token 就会估少三成。（Codex 三审指出的）
const LIFE_PROMPT_MAX = 700;
// 约定那段自己一份预算，排在 volatile 最前面（过期没兑现的事比今天吃了什么要紧）。
const LIFE_PROMISE_PROMPT_MAX = 300;
// 兜底那一刀的位置 = 真正的硬上限。留一行余量给最后那句行为约束。
const LIFE_PROMPT_HARD = LIFE_PROMPT_MAX + LIFE_PROMISE_PROMPT_MAX + 60;

function lifePromptFor() {
  const empty = { stable: '', volatile: '' };
  if (!lifeEnabled()) return empty;

  // ⚠️ stable 必须**恒定**。原来「纪念日卡怎么写」那段是有条件才拼进去的，
  //    于是纪念日前一天、当天没写卡、写完卡三种状态下 stable 各不相同 ——
  //    提示词缓存的前缀一变，后面整段历史每轮重写一次，只体现在账单上。
  //    固定说明无条件放这儿，「今天能不能写」放 volatile。
  const stable = '【生活】她有一份「今日小票」（今天做了什么、吃了什么的流水）。'
    + '她随口提到的事，你觉得值得留一条就写 [[RECEIPT: 一句话]]，会记进今天那张小票。'
    + '别记废话，也别一轮记好几条。'
    + '纪念日当天你可以写一张只写一次的卡片：[[ANNIV: 纪念日的名字|你要说的话]]，'
    + '一年一张，往后每年都能翻出来看 —— 没到日子别写。'
    + '你答应她一件具体的事（「周末陪你看电影」「明天提醒你交作业」）时，另写 [[PROMISE: 那件事|YYYY-MM-DD]]'
    + '（没有具体日子就只写那件事），它会进一张约定清单；做到了写 [[KEPT: 那件事里的几个字]] 勾掉。'
    + '只记真答应了的，客套话别记。\n';

  let vol = '';
  const today = lifeToday();

  // 约定：没兑现的列出来，过期的最前。只有过期、今天到期、或三天内到期的才催它提，
  // 其余只是让它知道清单上有什么，免得它把同一件事再答应一遍。
  const open = lifePromiseSorted();
  if (open.length) {
    const parts = [];
    let used = 0;
    for (const p of open) {
      const one = p.t + '（' + lifePromiseWhen(p) + (p.by === 'user' ? '，她替你记的' : '') + '）';
      if (used + one.length + 1 > LIFE_PROMISE_PROMPT_MAX) break;
      parts.push(one); used += one.length + 1;
    }
    if (parts.length) {
      const urgent = open.some(p => { const n = lifePromiseDaysLeft(p); return n != null && n <= 3; });
      vol += '你答应过她、还没兑现的：' + parts.join('；')
        + (parts.length < open.length ? '（还有 ' + (open.length - parts.length) + ' 件没列）' : '') + '。'
        + (urgent ? '快到或已经过了日子的，找个自然的时候自己提起来，别等她问。' : '')
        + '\n';
    }
  }
  const rec = lifeReceiptOf(today);
  if (rec.length) {
    // 小票按「从新到旧」放，超预算就停 —— 砍掉的是最早的那几条。
    const parts = [];
    let used = 0;
    for (let i = rec.length - 1; i >= 0; i--) {
      const one = rec[i].t + (rec[i].by === 'ai' ? '（你记的）' : '');
      if (used + one.length + 1 > LIFE_PROMPT_MAX) break;
      parts.unshift(one); used += one.length + 1;
    }
    if (parts.length) {
      vol += '今天这张小票上已经有：' + parts.join('、')
        + (parts.length < rec.length ? '（还有更早的 ' + (rec.length - parts.length) + ' 条没列）' : '') + '。\n';
    }
  }

  // 月历：单独一道开关，因为这一段等于把她的身体数据发给模型。
  if (lifeCycleShared()) {
    const st = lifePeriodStats();
    if (st.current) {
      const d = lifeDays(st.current.start, today);
      vol += '她这次来是第 ' + ((d == null ? 0 : d) + 1) + ' 天'
        + (st.avgLen ? '（平常大概 ' + st.avgLen + ' 天）' : '') + '。'
        + '这种时候别劝她硬撑，也别把情绪都归到这上面。\n';
    } else if (st.next && st.delta != null) {
      if (st.delta >= 0 && st.delta <= 3) {
        vol += '按她的记录，这两天差不多要来了'
          + (st.cycleIsGuess ? '（记录还少，这是按 28 天估的）' : '') + '。\n';
      } else if (st.delta < -3) {
        vol += '按她的记录已经晚了 ' + (-st.delta) + ' 天'
          + (st.cycleIsGuess ? '（记录还少，估得不准）' : '')
          + '。别追着问，她提起再说。\n';
      }
    }
  }

  // 纪念日：只提最近的，且只在快到或就是今天的时候提。
  const soon = [];
  for (const a of lifeAnnivs()) {
    const n = lifeAnnivDaysLeft(a && a.date);
    if (n == null || n > 7) continue;
    soon.push({ a, n });
  }
  if (soon.length) {
    soon.sort((x, y) => x.n - y.n);
    const y = today.slice(0, 4);
    // 纪念日条数也要封顶：七天内可以有任意多个，全列进去同样能把预算吃光。
    for (const s of soon.slice(0, 4)) {
      if (s.n === 0) {
        vol += '今天是「' + s.a.name + '」。'
          + (lifeAnnivCard(s.a.id, y) ? '今年的卡片你已经写过了，别再写一张。' : '你今年还没写卡片。')
          + '\n';
      } else {
        vol += '还有 ' + s.n + ' 天是「' + s.a.name + '」。\n';
      }
    }
    if (soon.length > 4) vol += '（还有 ' + (soon.length - 4) + ' 个日子在七天内。）\n';
  }

  // 兜底再切一刀，防将来加了字段忘了算预算 —— 那种漏洞不报错，
  // 只会让每轮提示词悄悄变长，最后体现在账单上。
  // ⚠️ 切完还要接省略号，所以要**先减掉省略号的长度**再切 ——
  //    不然声称的 760 实际是 762，常量和实际又对不上了。（Codex 四审逮到的）
  if (vol.length > LIFE_PROMPT_HARD) vol = vol.slice(0, LIFE_PROMPT_HARD - 2) + '…\n';

  return { stable, volatile: vol };
}

// ============================================================
// 面板：三个 tab 共用一个 modal
// ============================================================
let _lifeTab = 'receipt';
let _lifeDay = '';        // 小票在看哪一天，空 = 今天

function openLife(tab) {
  const el = document.getElementById('lifeModal');
  if (!el) return;
  if (tab) _lifeTab = String(tab);
  _lifeDay = '';
  el.classList.remove('hidden');
  lifeRender();
}
function closeLife() {
  const el = document.getElementById('lifeModal');
  if (el) el.classList.add('hidden');
}
function lifeTab(t) { _lifeTab = String(t); lifeRender(); }

// 值进 onclick 一律走这里，别用 JSON.stringify + 只换双引号。
// 属性值里的实体是浏览器**解析属性时**就解掉的：只转双引号的话，
// 值自身带的 &quot; 会变回真引号提前收尾，后面的东西就成了可执行的 JS。
// （仓库里已经因为这个吃过一次亏，jsAttr 就是那次的产物。）
function _lifeAttr(v) {
  if (typeof jsAttr === 'function') return jsAttr(v);
  return JSON.stringify(v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

function _lifeEsc(s) {
  return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s);
}

// 空状态（ui-polish A27）：公共的 .gc-empty，线条图标 + 一句标题 + 一句说明。参数都是写死的文案，不用转义
const _LIFE_EMPTY_ICONS = {
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M12 18.2l-2.3-2.2a1.4 1.4 0 0 1 2.3-1.5 1.4 1.4 0 0 1 2.3 1.5z"/>',
  promise: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 10"/>',
};
function _lifeEmpty(icon, title, desc) {
  return '<div class="gc-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24">' + (_LIFE_EMPTY_ICONS[icon] || '') + '</svg></div>'
    + '<div class="gc-empty-title">' + title + '</div>' + (desc ? '<div class="gc-empty-desc">' + desc + '</div>' : '') + '</div>';
}

function lifeRender() {
  const box = document.getElementById('lifeBody');
  if (!box) return;
  const tabs = [['receipt', '🧾 小票'], ['cycle', '🌙 月历'], ['anniv', '💌 纪念日'], ['promise', '🤙 约定']];
  let h = '<div class="life-tabs">' + tabs.map(([k, n]) =>
    '<button class="life-tab' + (k === _lifeTab ? ' on' : '') + '" onclick="lifeTab(\'' + k + '\')">'
    // 图标和字分开包：手机上几个挤一排，「纪念日」会被折成两行，拆开才能让图标叠到字上面
    + n.replace(/^(\S+)\s+(.+)$/, '<i>$1</i><span>$2</span>') + '</button>').join('') + '</div>';
  h += _lifeTab === 'receipt' ? _lifeReceiptHtml()
    : _lifeTab === 'cycle' ? _lifeCycleHtml()
    : _lifeTab === 'promise' ? _lifePromiseHtml()
    : _lifeAnnivHtml();
  box.innerHTML = h;
}

// ── 小票 ────────────────────────────────────────────────────
function _lifeReceiptHtml() {
  const esc = _lifeEsc;
  const day = _lifeDay || lifeToday();
  const list = lifeReceiptOf(day);
  const isToday = day === lifeToday();

  let h = '<div class="life-daybar">'
    + '<button class="life-nav" onclick="lifeDayShift(-1)">‹</button>'
    + '<b>' + esc(day) + (isToday ? ' · 今天' : '') + '</b>'
    + '<button class="life-nav" onclick="lifeDayShift(1)"' + (isToday ? ' disabled' : '') + '>›</button>'
    + '</div>';

  h += '<div class="life-receipt">'
    + '<div class="life-rhead">今日小票</div>';
  if (!list.length) {
    h += '<div class="life-empty">这天还什么都没记</div>';
  } else {
    h += list.map((r, i) =>
      '<div class="life-ritem"><span class="life-rt">' + esc(r.t) + '</span>'
      // 谁记的必须看得见 —— 不然某天看到一条自己没印象的，分不清是忘了还是它记岔了
      + (r.by === 'ai' ? '<span class="life-rby">它记的</span>' : '')
      + '<button class="life-rdel" onclick="lifeReceiptRemove(' + _lifeAttr(day) + ',' + i + ')">✕</button></div>'
    ).join('');
    h += '<div class="life-rfoot">共 ' + list.length + ' 条</div>';
  }
  h += '</div>';

  if (isToday) {
    h += '<div class="life-addrow">'
      + '<input id="lifeRecInput" placeholder="记一条：喝了咖啡 / 走了八千步 / 又熬夜了"'
      + ' onkeydown="if(event.key===\'Enter\')lifeReceiptSubmit()">'
      + '<button class="apply-btn" onclick="lifeReceiptSubmit()">记下</button></div>';
  }
  return h;
}

function lifeDayShift(n) {
  const cur = _lifeDay || lifeToday();
  const next = lifeAdd(cur, n);
  if (!next) return;
  if (lifeDays(next, lifeToday()) < 0) return;    // 不许翻到未来
  _lifeDay = next === lifeToday() ? '' : next;
  lifeRender();
}

function lifeReceiptSubmit() {
  const el = document.getElementById('lifeRecInput');
  if (!el) return;
  const v = String(el.value || '').trim();
  if (!v) return;
  if (!lifeReceiptAdd(v, 'user')) {
    if (typeof showToast === 'function') showToast('今天记满了', 'info', 1600);
    return;
  }
  el.value = '';
  lifeRender();
}

function lifeReceiptRemove(day, i) { lifeReceiptDel(day, i); lifeRender(); }

// ── 月历 ────────────────────────────────────────────────────
function _lifeCycleHtml() {
  const esc = _lifeEsc;
  const st = lifePeriodStats();
  let h = '<div class="life-stats">';
  if (!st.n) {
    h += _lifeEmpty('moon', '还没有记录', '第一次来的那天点下面那颗按钮就行。');
  } else {
    if (st.current) {
      const d = lifeDays(st.current.start, lifeToday());
      h += '<div class="life-now">这次第 <b>' + ((d == null ? 0 : d) + 1) + '</b> 天'
        + '<small>' + esc(st.current.start) + ' 开始</small></div>';
    } else if (st.next) {
      const dd = st.delta;
      h += '<div class="life-now">'
        + (dd == null ? '' : dd >= 0 ? '还有 <b>' + dd + '</b> 天' : '晚了 <b>' + (-dd) + '</b> 天')
        + '<small>预计 ' + esc(st.next) + (st.cycleIsGuess ? '（记录少，按 28 天估的）' : '') + '</small></div>';
    }
    h += '<div class="life-nums">'
      + '<span>平均周期 <b>' + (st.avgCycle == null ? '—' : st.avgCycle + ' 天') + '</b></span>'
      + '<span>平均天数 <b>' + (st.avgLen == null ? '—' : st.avgLen + ' 天') + '</b></span>'
      + '<span>共 <b>' + st.n + '</b> 次</span></div>';
    // 忘了标结束的要显眼 —— 它们不进统计，不说的话统计会莫名其妙偏
    if (st.unclosed.length) {
      h += '<div class="life-warn">有 ' + st.unclosed.length + ' 次忘了记结束（'
        + st.unclosed.map(p => esc(p.start)).join('、') + '），它们不算进平均。点下面补上。</div>';
    }
  }
  h += '</div>';

  h += '<div class="life-acts">';
  if (st.current) {
    h += '<button class="apply-btn life-main" onclick="lifeCycleClose()">今天结束了</button>';
  } else {
    h += '<button class="apply-btn life-main" onclick="lifeCycleStart()">今天来了</button>';
  }
  h += '<button class="apply-btn" onclick="lifeCycleBackfill()">补记一次</button></div>';

  const list = lifePeriodList().slice().reverse();
  if (list.length) {
    h += '<div class="life-list">' + list.map(p => {
      const L = p.end ? lifeDays(p.start, p.end) : null;
      return '<div class="life-li"><span>' + esc(p.start) + '</span>'
        + '<span class="life-li-len">' + (p.end ? (L + 1) + ' 天' : '<i>没记结束</i>') + '</span>'
        + (p.end ? '' : '<button class="life-mini" onclick="lifeCycleCloseAt(' + _lifeAttr(p.start) + ')">补结束</button>')
        + '<button class="life-rdel" onclick="lifeCycleRemove(' + _lifeAttr(p.start) + ')">✕</button></div>';
    }).join('') + '</div>';
  }
  return h;
}

function lifeCycleStart() {
  if (!lifePeriodAdd(lifeToday(), '')) {
    if (typeof showToast === 'function') showToast('今天已经记过了', 'info', 1600);
  }
  lifeRender();
}
function lifeCycleClose() {
  const st = lifePeriodStats();
  if (!st.current) return;
  lifePeriodClose(st.current.start, lifeToday());
  lifeRender();
}
// window.prompt 在 Electron 桌面版和安卓 WebView 里都是死的（点了没反应），走 appPrompt。
async function lifeCycleCloseAt(start) {
  const v = await appPrompt('「' + start + '」那次是哪天结束的？（YYYY-MM-DD）', start);
  if (!v) return;
  if (!lifePeriodClose(start, v)) {
    if (typeof showToast === 'function') showToast('日期不对，或者比开始还早', 'error', 2200);
  }
  lifeRender();
}
async function lifeCycleBackfill() {
  const s = await appPrompt('补记一次，开始那天（YYYY-MM-DD）：', '');
  if (!s) return;
  const e = await appPrompt('结束那天（不记得就留空）：', '');
  if (!lifePeriodAdd(s, e || '')) {
    if (typeof showToast === 'function') showToast('日期不对，或者那天已经记过了', 'error', 2200);
  }
  lifeRender();
}
function lifeCycleRemove(start) {
  if (!confirm('删掉 ' + start + ' 那次？')) return;
  lifePeriodDel(start);
  lifeRender();
}

// ── 纪念日 ──────────────────────────────────────────────────
function _lifeAnnivHtml() {
  const esc = _lifeEsc;
  const list = lifeAnnivs().slice();
  const y = lifeToday().slice(0, 4);
  list.sort((a, b) => (lifeAnnivDaysLeft(a.date) ?? 999) - (lifeAnnivDaysLeft(b.date) ?? 999));

  let h = '';
  if (!list.length) {
    h += _lifeEmpty('cal', '还没有纪念日', '加一个，当天它会写一张卡给你，一年一张。');
  } else {
    h += '<div class="life-list">' + list.map(a => {
      const n = lifeAnnivDaysLeft(a.date);
      const card = lifeAnnivCard(a.id, y);
      const years = Object.keys(a.cards || {}).sort().reverse();
      return '<div class="life-anniv">'
        + '<div class="life-anniv-h"><b>' + esc(a.name) + '</b>'
        + '<span class="life-anniv-d">' + esc(a.date) + '</span>'
        + '<span class="life-anniv-n">' + (n === 0 ? '就是今天' : n == null ? '' : '还有 ' + n + ' 天') + '</span>'
        + '<button class="life-rdel" onclick="lifeAnnivRemove(' + _lifeAttr(a.id) + ')">✕</button></div>'
        + (card ? '<div class="life-card-b">' + esc(card) + '</div>' : '')
        + (years.length > (card ? 1 : 0)
            ? '<div class="life-years">往年：' + years.filter(v => v !== y || !card).map(v =>
                '<button class="life-mini" onclick="lifeAnnivPeek(' + _lifeAttr(a.id)
                + ',' + _lifeAttr(v) + ')">' + esc(v) + '</button>').join('') + '</div>'
            : '')
        + '</div>';
    }).join('') + '</div>';
  }
  h += '<div class="life-addrow">'
    + '<input id="lifeAnnivName" placeholder="叫什么（生日 / 搬家 …）">'
    + '<input id="lifeAnnivDate" placeholder="YYYY-MM-DD" style="max-width:120px">'
    + '<button class="apply-btn" onclick="lifeAnnivSubmit()">加</button></div>';
  return h;
}

function lifeAnnivSubmit() {
  const n = document.getElementById('lifeAnnivName');
  const d = document.getElementById('lifeAnnivDate');
  if (!n || !d) return;
  if (!lifeAnnivAdd(n.value, d.value)) {
    if (typeof showToast === 'function') showToast('名字和日期都要填，日期写成 2026-08-30 这样', 'error', 2400);
    return;
  }
  n.value = ''; d.value = '';
  lifeRender();
}
function lifeAnnivRemove(id) {
  if (!confirm('删掉这个纪念日？往年的卡片也会一起没。')) return;
  lifeAnnivDel(id);
  lifeRender();
}
// ── 约定 ────────────────────────────────────────────────────
function _lifePromiseHtml() {
  const esc = _lifeEsc;
  const open = lifePromiseSorted();
  const done = lifePromises().filter(p => p && p.done)
    .sort((a, b) => String(b.done).localeCompare(String(a.done)) || (b.at || 0) - (a.at || 0));
  let h = '';
  if (!open.length && !done.length) {
    h += _lifeEmpty('promise', '还没有约定', '它在聊天里答应你一件具体的事时会记进来，到日子会自己提。');
  }
  if (open.length) {
    h += '<div class="life-list">' + open.map(p => {
      const n = lifePromiseDaysLeft(p);
      return '<div class="life-li life-promise' + (n != null && n < 0 ? ' late' : '') + '">'
        + '<span class="life-rt">' + esc(p.t) + '</span>'
        + (p.by === 'user' ? '<span class="life-rby">你记的</span>' : '')
        + '<span class="life-li-len">' + esc(lifePromiseWhen(p)) + '</span>'
        + '<button class="life-mini" onclick="lifePromiseMark(' + _lifeAttr(p.id) + ',true)">做到了</button>'
        + '<button class="life-rdel" onclick="lifePromiseRemove(' + _lifeAttr(p.id) + ')">✕</button></div>';
    }).join('') + '</div>';
  }
  if (done.length) {
    h += '<div class="life-rhead life-promise-dh">兑现过的</div><div class="life-list">' + done.slice(0, 20).map(p =>
      '<div class="life-li life-promise done"><span class="life-rt">' + esc(p.t) + '</span>'
      + '<span class="life-li-len">' + esc(String(p.done).slice(5)) + ' 做到</span>'
      + '<button class="life-mini" onclick="lifePromiseMark(' + _lifeAttr(p.id) + ',false)">其实没做到</button></div>'
    ).join('') + '</div>';
  }
  h += '<div class="life-addrow">'
    + '<input id="lifePromiseText" placeholder="它答应过你、却没记上的事">'
    + '<input id="lifePromiseDue" placeholder="YYYY-MM-DD（可空）" style="max-width:140px">'
    + '<button class="apply-btn" onclick="lifePromiseSubmit()">记下</button></div>';
  return h;
}

function lifePromiseSubmit() {
  const t = document.getElementById('lifePromiseText');
  const d = document.getElementById('lifePromiseDue');
  if (!t) return;
  const st = lifePromiseAdd(t.value, d ? d.value : '', 'user');
  const toast = (m, k) => { if (typeof showToast === 'function') showToast(m, k || 'info', 2200); };
  if (!st) return toast('先写是什么事', 'error');
  if (st === 'dup') return toast('清单上已经有这件了');
  if (st === 'full') return toast('没兑现的约定挂满了，先勾掉几件', 'error');
  if (st === 'nd') toast('日期没看懂（要写成 2026-10-05 这样，也不能是过去的日子），先记成没定日子');
  t.value = ''; if (d) d.value = '';
  lifeRender();
}
function lifePromiseMark(id, on) { lifePromiseSetDone(id, on); lifeRender(); }
function lifePromiseRemove(id) {
  if (!confirm('删掉这条约定？')) return;
  lifePromiseDel(id);
  lifeRender();
}

function lifeAnnivPeek(id, year) {
  const c = lifeAnnivCard(id, year);
  if (typeof showToast === 'function') showToast(year + '：' + (c || '那年没写'), 'info', 5000);
}

function toggleLife(on) {
  if (typeof state !== 'object' || !state) return;
  state.lifeOn = !!on;
  try { save(); } catch {}
}
function toggleLifeCycleShare(on) {
  if (typeof state !== 'object' || !state) return;
  state.lifeCycleShare = !!on;
  try { save(); } catch {}
}
