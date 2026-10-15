// ============================================================
// 学习卡片（英语 / 德语）
// 用户的真实痛点不是"没有好的学习软件"，是**不想打开学习软件**。
// 所以这个模块刻意不做成一个需要你专门打开的东西：卡片长在聊天里，
// AI 在你本来就在聊的天里把题送到眼前，答完接着聊。你躲不掉，
// 但也从来不需要"进入学习状态"。
//
// 跟育儿室 [[NURSE:]] 是同一套指令协议，但简单一档：
// SRS 说白了就是算个下次到期日，全在本地，**不用走 HTTP 预取**，
// 所以直接在同步的 processAiCommands 里处理。
//
// ⚠️ 一个跟育儿室不同的关键决定：结果**不就地烤成 HTML 存进消息**。
// 育儿室的结果块是死的（引擎回了什么就是什么，永不变），可以直接存 HTML；
// 卡片是活的——你答完了、熟练度变了、下次到期日变了，存死 HTML 的话
// 刷新回来又是一张没答过的卡。所以照表情包的路子：**标签原样存储，
// 渲染层 studyTagToHtml 每次按当前状态重新渲染**（见 04-memory.js:71 那条注释，
// 表情包当年就是栽在"就地转 HTML"上）。
//
// 三条指令：
//   [[CARD: de|der Tisch|桌子|Der Tisch ist groß.]]  建新卡，建完立刻考一遍
//   [[REVIEW]]                                        抽一张到期的旧卡来考（认不认得）
//   [[SPELL]]                                         抽一张熟卡考拼写（给中文，自己敲出词）
// AI 不需要记卡片 id——它只说"我要考一张"，挑哪张由 SRS 定。让模型管 id
// 是自找断链（早先有条指令就这么断过：模型照着历史学格式，能写错的地方它一定写错）。
//
// 两种考法共用一张卡、一套 SRS、一个 c.log，只在**存储标签**上分家：
// [[CARDQ:]] 是认词，[[CARDS:]] 是拼写。分家是因为渲染层只拿到 id 和 askId，
// 得有个办法知道该画哪一面（拼写题正面是中文、且答完之前连 🔊 都不能给——
// 一放发音答案就漏了）。
// ============================================================

function studyEnabled() { return !!state.studyOn; }

// 发音音色。/api/tts 的 voice 参数是透传的（server.js:955 只校验字符集），
// 所以德语原生音色是白捡的，后端一行都不用改。
const STUDY_VOICE = { de: 'de-DE-KatjaNeural', en: 'en-US-AriaNeural' };
const STUDY_LANG_LABEL = { de: '🇩🇪 德语', en: '🇬🇧 英语' };

// 建卡：[[CARD: 语言|正面|背面|例句]]，例句可省
function studyCardTagRe() { return /\[\[CARD:\s*([^\]]+?)\s*\]\]/g; }
// 抽考：[[REVIEW]]（容忍模型手抖写成 [[REVIEW: 随便什么]]）
function studyReviewTagRe() { return /\[\[REVIEW(?::[^\]]*)?\s*\]\]/g; }
// 抽拼写题：[[SPELL]]（同样容忍 [[SPELL: 随便什么]]）
function studySpellTagRe() { return /\[\[SPELL(?::[^\]]*)?\s*\]\]/g; }
// 渲染引用：[[CARDQ:卡片id|这一次的提问id]]——只有这条会进存储
function studyQTagRe() { return /\[\[CARDQ:\s*([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\s*\]\]/g; }
// 拼写题的存储标签。注意 studyCardTagRe 是 `\[\[CARD:`（冒号紧跟 CARD），
// 所以 [[CARDS:]] 不会被它当成建卡指令再执行一遍。
function studySTagRe() { return /\[\[CARDS:\s*([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\s*\]\]/g; }
// 两种题一起扫：$1 是 Q/S（题型），$2 卡片 id，$3 提问 id
function studyAnyQTagRe() { return /\[\[CARD([QS]):\s*([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\s*\]\]/g; }
function _studyHasAskTag(s) { return /\[\[CARD[QS]:/.test(String(s || '')); }

function studyCards() {
  if (!Array.isArray(state.studyCards)) state.studyCards = [];
  return state.studyCards;
}
function studyGet(id) { return studyCards().find(c => c.id === id); }

function _studyId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── 建卡 ──
// 同一个正面已经有卡就不再建（模型很容易把同一个词反复"教"你，
// 导入词库时也常有重叠），重复建卡会让 SRS 的间隔永远从头开始。
// **不在这里 save()**：导入几百行时逐条落盘纯属浪费，由调用方批量存。
// ⚠️ 语言判定必须**整段精确匹配**，不能用 /^de/ 前缀：德语冠词 der/die/das
// 全都以 "de" 开头，模型漏写语言字段时（[[CARD: der Hund|狗]]），前缀匹配会把
// "der Hund" 当成合法语言字段，于是 front 错位成"狗"、back 变 undefined，整张卡丢掉。
const STUDY_LANG_FIELD = /^(de|en|deutsch|german|english|德语?|英语?)$/i;

function _studyAdd(lang, front, back, ex) {
  lang = /^(en|english|英语?)$/i.test(String(lang || '').trim()) ? 'en' : 'de';
  front = String(front || '').trim();
  back = String(back || '').trim();
  if (!front || !back) return null;

  const dup = studyCards().find(c => c.lang === lang && c.front.toLowerCase() === front.toLowerCase());
  if (dup) return { card: dup, isNew: false };

  const c = {
    id: _studyId('c'), lang, front, back, ex: String(ex || '').trim(),
    ease: 2.5, ivl: 0, reps: 0, lapses: 0,
    due: Date.now(), created: Date.now(), last: 0,
    log: {},                     // { askId: {g, ts} }，见下面 studyGrade 的注释
    ipa: '', ipaTried: 0,        // 音标，异步补；ipaTried 是"查过没有"的时间戳（见 studyFetchIpa）
  };
  studyCards().push(c);
  if (c.ex) _studyZhSoon(c);     // AI 教词时带的例句没有中文，趁早翻
  return { card: c, isNew: true };
}

// 模型漏写语言字段时猜一把。**不能一律当德语**：两门语言里英语通常是主力，
// 一律 de 会把 `[[CARD: apple|苹果]]` 变成一张 🇩🇪 apple 的假德语卡——
// 发音走德语音色、面板挂德国旗、还要被"名词没带冠词"的规则挑刺，
// 看起来就像"英语的词根本导不进来"。
// 只认德语自己的证据（变音字母、冠词开头），其余归英语。
function _studyGuessLang(front) {
  const s = String(front || '');
  if (/[äöüÄÖÜß]/.test(s)) return 'de';
  if (/^(der|die|das|ein|eine|einen|dem|den|des)\s/i.test(s)) return 'de';
  return 'en';
}

// AI 那条路：[[CARD: 语言|正面|背面|例句]]
function studyCreate(payload) {
  const parts = String(payload || '').split('|').map(s => s.trim());
  let [lang, front, back, ex] = parts;
  // 模型漏了语言字段时按位置往前挪一格，别整条丢掉
  if (!STUDY_LANG_FIELD.test(String(lang || '').trim())) { ex = back; back = front; front = parts[0]; lang = _studyGuessLang(parts[0]); }
  const r = _studyAdd(lang, front, back, ex);
  if (!r) return null;
  if (r.isNew) { save(); _studyIpaSoon(r.card); }   // 命中去重就不落盘：渲染层兜底会反复调它
  return r.card;
}

// 内容 hash，给历史裸标签当稳定的 askId 用。
// 渲染是幂等的，同一个裸标签每次重画必须落到同一个 askId，
// 否则你答完一刷新，作答记录对不上号，又变回没答过。
function _studyHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(36);
}

// ── 导入词库 ──
// 分隔符认 | ｜ Tab = ＝ 制表，一行一张卡。词库来源五花八门（Anki 导出的 Tab、
// 网上抄的词表、自己敲的等号），严格格式只会让人导一次就放弃。
// 第三段是例句，可省。# 和 // 开头当注释跳过。
const STUDY_SEP_MAIN = /\s*[|｜\t]\s*|\s*[=＝]\s*/;
// 主分隔符一个都没有时的兜底。英语词表从网页/词典/背单词 App 扒下来，
// 十条里有八条是「apple, 苹果」「apple: 苹果」「apple - 苹果」「apple  苹果」
// 这几种样子——原来只认 | Tab = ，这些一行都解析不出来，于是"英语词汇导不进去"。
// **只切第一处**：中文释义里逗号顿号一大堆（"苹果，苹果树"），全局切会把释义剁碎。
const STUDY_SEP_FALLBACK = /\s+[-–—]\s+|\s*[:：,，、；;]\s*|\s{2,}/;
// 连符号都没有的「apple 苹果」：在拉丁字母撞上汉字的地方切一刀。
// 这样 "give up 放弃" 也能切对（不会被词组内部的空格骗到）。
const STUDY_SEP_CJK = /[A-Za-z0-9.)\]!?](\s+)(?=[一-鿿])/;

function _studySplitLine(ln) {
  const parts = ln.split(STUDY_SEP_MAIN).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;
  let m = ln.match(STUDY_SEP_FALLBACK);
  let at = m && m.index > 0 ? [m.index, m[0].length] : null;
  if (!at) {
    m = ln.match(STUDY_SEP_CJK);
    if (m) at = [m.index + m[0].length - m[1].length, m[1].length];
  }
  if (!at) return parts;
  return [ln.slice(0, at[0]).trim(), ln.slice(at[0] + at[1]).trim()].filter(Boolean);
}

function studyParseImport(raw) {
  const out = [];
  for (let ln of String(raw || '').split(/\r?\n/)) {
    ln = ln.trim();
    if (!ln || ln.startsWith('#') || ln.startsWith('//')) continue;
    const parts = _studySplitLine(ln);
    if (parts.length < 2) continue;
    out.push({ front: parts[0], back: parts[1], ex: parts[2] || '' });
  }
  return out;
}

var _studyImportOpen = false;

// ⚠️ 导入语言必须记在 JS 变量里，**不能只靠 radio 的 checked**。
// 面板是整块 `body.innerHTML = h` 重画的，而那段模板里 de 的 checked 是写死的：
// 每次 studyRefresh（导完一批、答完一张卡、开关一动）都会把选择弹回德语，
// 顺手还把已经粘进去的词库清空。于是"选了英语→导入→再导第二批"时，
// 第二批悄悄全成了 🇩🇪 卡——英语导不进去的真身就是这个。
var _studyImportLang = (function () {
  try { return localStorage.getItem('kuro_studyImportLang') === 'en' ? 'en' : 'de'; } catch (e) { return 'de'; }
})();

// 示例也得跟着语言变。原来两种语言共用一份德语示例（der Tisch | 桌子），
// 选了英语还照着德语示例填，怎么看怎么像功能坏了。
const STUDY_IMPORT_PH = {
  de: '一行一个词，分隔符 | 或 Tab 或 = 都认，第三段是例句（可省）：\n\nder Tisch | 桌子 | Der Tisch ist groß.\ndie Katze = 猫\ndas Buch\t书\n\n重复的词自动跳过，不会打乱已有进度。',
  en: '一行一个词，分隔符 | Tab = 逗号 冒号 都认，第三段是例句（可省）：\n\napple | 苹果 | I ate an apple.\ngive up = 放弃\nbudget\t预算\nshow up, 出现\nremind 提醒\n\n重复的词自动跳过，不会打乱已有进度。',
};
const STUDY_IMPORT_HINT = {
  de: '德语名词记得带 der/die/das，导进来才算数',
  en: '词组和句子也能当正面；第三栏留给英文例句',
};

function studyToggleImport() { _studyImportOpen = !_studyImportOpen; studyRefresh(true); }

function studySetImportLang(v) {
  _studyImportLang = v === 'en' ? 'en' : 'de';
  try { localStorage.setItem('kuro_studyImportLang', _studyImportLang); } catch (e) { /* 隐私模式，无所谓 */ }
  // 只换示例和提示，**不重画面板**——重画会把正在粘的词库清掉
  const ta = document.getElementById('studyImportText');
  if (ta) ta.placeholder = STUDY_IMPORT_PH[_studyImportLang];
  const hint = document.getElementById('studyImportHint');
  if (hint) hint.textContent = STUDY_IMPORT_HINT[_studyImportLang];
}

// innerHTML 重画之后把导入框补回原样（示例文案 + 没导完的内容）
function _studyRestoreImportBox(keepText) {
  const ta = document.getElementById('studyImportText');
  if (ta) {
    ta.placeholder = STUDY_IMPORT_PH[_studyImportLang];
    if (keepText) ta.value = keepText;
  }
  const hint = document.getElementById('studyImportHint');
  if (hint) hint.textContent = STUDY_IMPORT_HINT[_studyImportLang];
}

function studyDoImport() {
  const ta = document.getElementById('studyImportText');
  const lang = _studyImportLang;
  const rows = studyParseImport(ta ? ta.value : '');
  if (!rows.length) { showToast('一行都没解析出来，看看分隔符对不对？', 'error', 3500); return; }

  let added = 0, dup = 0, bad = 0, noArticle = 0, flipped = 0;
  for (const r of rows) {
    // 德语名词漏冠词是导入时最容易批量搞砸的事——单独一个首字母大写的词，
    // 十有八九是名词却没带 der/die/das。不拦，但要数出来告诉他。
    if (lang === 'de' && /^[A-ZÄÖÜ][a-zäöüßA-ZÄÖÜ]*$/.test(r.front)) noArticle++;
    // 正反面装反：正面是汉字、背面没汉字。网上扒的词表常是「释义 单词」这个顺序，
    // 装反了导进来每张卡都是拿中文考中文，等于白导一批。
    if (/[一-鿿]/.test(r.front) && !/[一-鿿]/.test(r.back)) flipped++;
    const res = _studyAdd(lang, r.front, r.back, r.ex);
    if (!res) { bad++; continue; }
    res.isNew ? added++ : dup++;
  }
  save();
  if (ta) ta.value = '';
  studyRefresh(true);

  let msg = `📥 新增 ${added} 张${lang === 'en' ? '英语' : '德语'}卡`;
  if (dup) msg += `，跳过 ${dup} 张重复`;
  if (bad) msg += `，${bad} 行没看懂`;
  showToast(msg, 'success', 4500);
  if (noArticle) {
    showToast(`⚠️ 有 ${noArticle} 个德语词看着像名词但没带冠词。词性后补是补不回来的，建议改成「der Tisch」这种再导一次`, 'error', 9000);
  }
  if (flipped > rows.length / 2) {
    showToast(`⚠️ ${flipped} 行看着正反面装反了（正面是中文）。把两列换一下再导一次，不然考的是拿中文猜中文`, 'error', 9000);
  }
}

// ── SRS：艾宾浩斯复习节点 ──
// 2026-09-28 从 SM-2 换成固定节点（用户：「有那个什么遗忘曲线当复习周期的」）。
// SM-2 其实也是照遗忘曲线来的，但它的间隔是 1 → 3 → 8 → 20 天这样乘出来的，
// 看不出「这个词走到哪了」；节点制每一步都写在明面上，前面也更密（1、2、4、7 天），
// 对刚背下来的高中词更稳——不背单词、墨墨那一路也是这个节奏。
//   认识 → 往后走一个节点；模糊 → 退一个节点；不认识 → 回到起点，10 分钟后就能再撞见
// 老卡（SM-2 时代）没有 step：按它现在的间隔落到最近的节点上接着走，不重头来。
// 到期落在那天凌晨 4 点：昨晚 11 点背的词，今天晚上 8 点打开就该出现，而不是等到 11 点。
const STUDY_LADDER = [1, 2, 4, 7, 15, 30, 60, 120, 240];
function _studyStep(c) {
  if (Number.isInteger(c.step)) return Math.min(c.step, STUDY_LADDER.length - 1);
  let s = -1;
  STUDY_LADDER.forEach((d, i) => { if ((c.ivl || 0) >= d) s = i; });
  return s;
}
function _studyDueAt(days, now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);   // 凌晨两点还没睡，算前一天
  d.setHours(4, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
// 纯函数：答了 g 之后下一步落在哪。刷卡界面「几天后再见」的预告也用它，所以不能有副作用。
function _studyNextSched(c, g, now = Date.now()) {
  if (g === 0) return { step: -1, ivl: 0, due: now + 10 * 60 * 1000 };
  const s = _studyStep(c);
  const step = g === 2 ? Math.min(s + 1, STUDY_LADDER.length - 1) : Math.max(0, s - 1);
  return { step, ivl: STUDY_LADDER[step], due: _studyDueAt(STUDY_LADDER[step], now) };
}
function studySchedule(c, g) {
  c.reps = (c.reps || 0) + 1;
  if (g === 0) c.lapses = (c.lapses || 0) + 1;
  Object.assign(c, _studyNextSched(c, g));
  c.last = Date.now();
}

// 到期的卡（due 已过），最该复习的排前面。
// ⚠️ 这个函数**不再用来挑出题的卡**，只剩面板统计和"提前刷"在用。
// 挑卡走 studyPick()，原因见下面那一大段。
function studyDue() {
  const now = Date.now();
  return studyCards().filter(c => c.due <= now).sort((a, b) => a.due - b.due);
}

// ── 出什么题：分组投放 ──
// 原来只有一条队列：所有到期卡按 due 升序，永远取第一张。看着公平，
// 导进一批词库之后就塌了——
//   新卡建出来 due = 建卡那一刻（已经是过去），而学过的卡答完 due 会被推到未来。
//   按 due 升序排，**所有没学过的新卡永远排在所有学过的卡前面**。
// 于是导 200 个词进来，这 200 张就把队列堵死了：用户学过的那些词得等
// 新词全部消化完才轮得到，中间隔好几天——"有的词好几天都复习不到"就是这么来的。
// 而且一门语言导得多就把另一门整个压在底下，德语词库一导，英语一个月不出现。
//
// 改成两条队列 + 交替发牌（照"不背单词"那个路子）：
//   复习队列：学过的、到期的，按 due 升序
//   新词队列：**当前这一组**（默认 10 个，英德交替挑），组里的词全都学过一遍才开下一组
// 关键是新词那边有个闸：任何时刻能出的新词最多一组，词库导得再多也淹不掉复习。
const STUDY_GROUP_SIZE_DEFAULT = 10;
function studyGroupSize() {
  const n = Number(state.studyGroupSize);
  return n >= 1 && n <= 50 ? Math.round(n) : STUDY_GROUP_SIZE_DEFAULT;
}

// 改组大小就把当前组作废重挑。已经学过的词不受影响（studyGroup 只挑没答过的），
// 丢掉的只是"这一组挑了哪几个"，重挑一次就按新大小排好。
function studySetGroupSize(v) {
  const n = Number(v);
  if (!(n >= 1 && n <= 50)) return;
  state.studyGroupSize = Math.round(n);
  state.studyGroupIds = [];
  save();
  studyRefresh(true);
}

// "新词" = 一次都没答过。用 reps 而不是 ivl/due：答错的卡 ivl 会被清零，
// 拿 ivl 判会把刚答错的老词又当成没学过的新词塞回新词队列。
// 标熟（刷卡时点「太简单」）的卡两边都不进：c.known 是时间戳，取消标熟就是删掉它。
function _studyIsNew(c) { return !(c.reps > 0) && !c.known; }

// ── 学新词：四个点（照不背单词）──
// 新词不是见一面就进复习：要**连着答对 4 次**才算学会，每对一次亮一个点，
// 中途答错（模糊也算没答对）点就全掉空、从头来。亮满 4 个才毕业，交给上面的复习节点。
// c.dots 是数字 = 正在学；学会就删掉它。学的过程中 reps 一直是 0，所以它仍然算
// 「新词」、仍然占着当前这一组的位置，组里的词都学会了才开下一组。
// 聊天里考到正在学的词也一样算点（studyGrade）；聊天里考一个从没学过的词照旧直接进复习——
// 那是 AI 教过、当场考过的词，不用再在这里过四关。
const STUDY_DOTS = 4;
function _studyLearning(c) { return !!c && typeof c.dots === 'number' && !c.known; }
function studyLearnStep(c, g) {
  if (g === 2) c.dots = (c.dots || 0) + 1;
  else { c.dots = 0; c.slips = (c.slips || 0) + 1; }
  if (c.dots >= STUDY_DOTS) { delete c.dots; studySchedule(c, 2); return true; }
  return false;
}

function studyReviewQueue() {
  const now = Date.now();
  return studyCards().filter(c => c.reps > 0 && !c.known && c.due <= now).sort((a, b) => a.due - b.due);
}

// 挑一组新词。两门语言**交替取**，这样一门的词库导得再多也挤不掉另一门
// （原话：英语德语都要学到）。组内按建卡先后排，先导进来的先学。
function _studyPickGroup() {
  const pool = { de: [], en: [] };
  for (const c of studyCards()) if (_studyIsNew(c)) (pool[c.lang] === undefined ? pool.en : pool[c.lang]).push(c);
  pool.de.sort((a, b) => (a.created || 0) - (b.created || 0));
  pool.en.sort((a, b) => (a.created || 0) - (b.created || 0));

  const size = studyGroupSize();
  const out = [];
  // 从存货少的那门开门：两门数量悬殊时，先手给少的那门才不会让它整组只剩零星几个
  let turn = (pool.de.length && pool.en.length) ? (pool.de.length <= pool.en.length ? 'de' : 'en')
           : (pool.de.length ? 'de' : 'en');
  while (out.length < size && (pool.de.length || pool.en.length)) {
    const take = pool[turn].length ? turn : (turn === 'de' ? 'en' : 'de');
    out.push(pool[take].shift());
    turn = turn === 'de' ? 'en' : 'de';
  }
  return out;
}

// 当前这一组里还没学的新词。组学完了就自动开下一组。
// 组本身要落盘（state.studyGroupIds）：不存的话每次刷新都重新挑一组，
// 学到一半换一批词，等于永远学不完一组。
function studyGroup() {
  const ids = Array.isArray(state.studyGroupIds) ? state.studyGroupIds : [];
  const left = ids.map(studyGet).filter(c => c && _studyIsNew(c));
  if (left.length) return left;
  studyBookTopUp();
  const next = _studyPickGroup();
  const nextIds = next.map(c => c.id);
  // 只在真的换组时落盘：这个函数渲染层每次重画都会调
  if (nextIds.join(',') !== ids.join(',')) { state.studyGroupIds = nextIds; if (nextIds.length) save(); }
  return next;
}

// 还有活可干吗（复习或新词，两边有一边有货就算）
function studyHasWork() { return studyReviewQueue().length > 0 || studyGroup().length > 0; }

// 入口上的小数字（侧边栏「单词卡」和顶栏那颗 📇）。**不能调 studyGroup()**：它会从词书补词、会落盘，
// 入口角标每次重画都跑一遍的话，没打开过面板也在偷偷改 state。这里只数，不动。
function studyTodoCount() {
  const review = studyReviewQueue().length;
  const ids = Array.isArray(state.studyGroupIds) ? state.studyGroupIds : [];
  let fresh = ids.map(studyGet).filter(c => c && _studyIsNew(c)).length;
  if (!fresh) {
    // 这一组学完了：下一组能凑多少就是多少（词书还有剩就算满一组）
    const size = studyGroupSize();
    const sel = state.studyBook, book = sel && studyBookData(sel.id);
    const bookLeft = book ? Math.max(0, book.words.length - (sel.pos || 0)) : 0;
    fresh = Math.min(size, studyCards().filter(_studyIsNew).length + bookLeft);
  }
  return { review, fresh, total: review + fresh };
}
function studyEntryBadge() {
  const t = studyTodoCount();
  const txt = t.total > 99 ? '99+' : String(t.total || '');
  for (const id of ['studyEntryBadge', 'studyHeadBadge']) {
    const el = document.getElementById(id); if (!el) continue;
    el.textContent = txt;
    el.classList.toggle('hidden', !t.total);
  }
  const btn = document.getElementById('studyEntryBtn');
  if (btn) btn.title = t.total ? `单词卡：${t.review} 个要复习，${t.fresh} 个新词` : '单词卡：今天的都刷完了';
}

// 复习和新词交替发牌。**不能一边倒**：全给复习，导进来的新词永远学不到；
// 全给新词，就退回成原来那个"学过的词好几天轮不到"。
//
// ⚠️ 这个游标必须落盘，别拿运行时变量凑合。用户的用法是"聊几句就关掉"，
// 一次会话常常只触发一张自动卡；游标每次启动都重置的话，第一张永远是复习卡，
// 于是复习队列只要有积压，新词组能连着好几天一张都发不出去——
// 那就是换了个触发条件把「有的词好几天都复习不到」原样搬了回来。
function _studyLastKindGet() { return state.studyLastKind === 'review' ? 'review' : 'new'; }
// 出了一张卡就把游标记上。**模型显式点的卡也要记**：不记的话，模型自己写了
// [[REVIEW]] 之后，下一次程序自动补卡仍以为"上一张是新词"，于是又发一张复习，
// 连着两张复习。（漏这一处的第一版还在赋值给一个已经删掉的变量，非严格模式下
// 它只是凭空造了个全局变量，一声不吭。）
function _studyNoteKind(kind) {
  if (state.studyLastKind === kind) return;
  state.studyLastKind = kind;
  save();
}

function studyPick() {
  const review = studyReviewQueue();
  const group = studyGroup();
  if (!review.length && !group.length) return null;
  let want = _studyLastKindGet() === 'review' ? 'new' : 'review';
  let c = want === 'review' ? review[0] : group[0];
  if (!c) { want = want === 'review' ? 'new' : 'review'; c = want === 'review' ? review[0] : group[0]; }
  _studyNoteKind(want);
  return c;
}

// ── 主动复习节奏 ──
// 不能把「会不会想起来出题」全押在模型身上：提示词里的“可以”不是调度器。
// 第一次遇到到期卡就出；之后每隔 3 个不同的用户回合，最多再出一张。
// 同一用户回合里并行跑多个模型时，只让最先完成的那个带卡，避免一窝蜂围考。
const STUDY_AUTO_TURN_GAP = 3;

function _studyActivePath(chat) {
  if (!chat) return [];
  if (typeof getMessagePath === 'function') {
    try { return getMessagePath(chat, chat.headId) || []; } catch (e) { /* 用下面的兜底 */ }
  }
  return Object.values(chat.nodes || {});
}

// 只要当前分支还有一张没点结果的卡，就先不叠新作业。旧分支里的卡不算，
// 否则用户换过分支后会被一张已经看不见的卡永久堵住。
function _studyHasOpenAsk(chat) {
  for (const n of _studyActivePath(chat)) {
    const blockTexts = Array.isArray(n?.blocks) ? n.blocks.map(b => b && b.text).filter(Boolean) : [];
    // 有 blocks 时用户看到、点击的是 blocks；旧版曾让 content / blocks 各生成一个 askId，
    // 这时不能拿那个永远没机会作答的 content askId 把后续复习永久堵住。
    const texts = blockTexts.some(s => _studyHasAskTag(s)) ? blockTexts : [n && n.content];
    for (const txt of texts) {
      if (!_studyHasAskTag(txt)) continue;
      const re = studyAnyQTagRe();
      let m;
      while ((m = re.exec(txt))) {
        const c = studyGet(m[2]);
        // 标熟了的不算悬着：她不会再去点那张卡的评分了（标熟也不写 log）
        if (c && !c.known && !(c.log && c.log[m[3]])) return true;
      }
    }
  }
  return false;
}

// 2026-07-25 之前 blocks 路径会把模型标签再执行一次，导致同一张可见卡在
// node.content 和 node.blocks 里各有一个 askId。用户只能回答 blocks 那张，API 却读 content，
// 于是它永远以为用户没答。启动时把 content 对齐到真正显示过的 blocks，修一次便落盘。
function studyRepairLegacyAskIds() {
  let fixed = 0;
  const tags = (s) => {
    const out = [], re = studyAnyQTagRe();
    let m;
    while ((m = re.exec(String(s || '')))) out.push({ mode:m[1], id:m[2], askId:m[3], tag:m[0] });
    return out;
  };
  const repairOne = holder => {
    if (!holder || !holder.content || !Array.isArray(holder.blocks)) return;
    const visibleText = holder.blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
    const a = tags(holder.content), b = tags(visibleText);
    if (!a.length || a.length !== b.length) return;
    if (!a.every((x, i) => x.id === b[i].id && x.mode === b[i].mode)) return;
    if (!a.some((x, i) => x.askId !== b[i].askId)) return;
    let i = 0;
    holder.content = holder.content.replace(studyAnyQTagRe(), () => b[i++].tag);
    fixed++;
  };
  for (const chat of state.chats || []) {
    for (const n of Object.values(chat.nodes || {})) {
      repairOne(n);
      for (const v of n.variants || []) repairOne(v);
    }
  }
  return fixed;
}

function _studyNoteUserTurn(ctx) {
  const chat = ctx && ctx.chat;
  const turnId = ctx && ctx.userTurnId;
  if (!chat || turnId === undefined || turnId === null) return;
  if (String(chat.studyAutoLastUserId || '') === String(turnId)) return;
  chat.studyAutoLastUserId = turnId;
  if (chat.studyAutoLastAt) chat.studyAutoTurns = (chat.studyAutoTurns || 0) + 1;
}

function _studyMarkOffer(ctx) {
  const chat = ctx && ctx.chat;
  if (!chat) return;
  chat.studyAutoLastAt = Date.now();
  chat.studyAutoTurns = 0;
  if (ctx.userTurnId !== undefined && ctx.userTurnId !== null) chat.studyAutoLastUserId = ctx.userTurnId;
}

function _studyCanAutoOffer(ctx, skipped) {
  if (!ctx?.autoOffer || skipped || !studyEnabled() || !ctx.chat) return false;
  if (ctx.userTurnId === undefined || ctx.userTurnId === null) return false; // 不借“普鲁斯特走神”等自发消息偷袭
  if (ctx.chat.isGroupChat || ctx.chat.ended || ctx.chat.agentMode) return false;
  if (typeof _call !== 'undefined' && _call.on) return false;               // 通话里看不到卡片，也别念标签
  _studyNoteUserTurn(ctx);
  if (ctx.chat.studyAutoLastAt && (ctx.chat.studyAutoTurns || 0) < STUDY_AUTO_TURN_GAP) return false;
  if (_studyHasOpenAsk(ctx.chat)) return false;
  return studyHasWork();
}

// ── 答题 ──
// 作答记在 c.log[askId] 而不是卡片本身：同一张卡会被考很多次，
// 记在卡上的话，历史消息里那些旧卡片块会跟着一起变成"已答对"，
// 而且 AI 新出这张卡时它一打开就显示答过了。askId 让每次提问各记各的。
function studyGrade(id, askId, g) {
  const c = studyGet(id); if (!c) return;
  if (c.log && c.log[askId]) return;          // 同一次提问只算一次
  if (_studyLearning(c)) {
    const grad = studyLearnStep(c, g);
    (c.log = c.log || {})[askId] = { g, ts: Date.now(), learn: grad ? STUDY_DOTS : c.dots, ...(grad ? { grad: true } : {}) };
  } else {
    studySchedule(c, g);
    (c.log = c.log || {})[askId] = { g, ts: Date.now() };
  }
  save();
  studyRerender(id, askId);
  studyRefresh();
  _studyChatEnrich(c);
}

// ── 拼写题 ──
// 认得出 ≠ 写得出。认词卡是"看正面想背面"，拼写题反着来：给中文，自己把词敲出来。
// 判分照样走同一套 SRS 和 c.log[askId]，所以一张卡的两种考法会互相影响间隔——
// 这是故意的：拼不出来说明这个词根本没记牢，认词那边也该早点再见。

// 判定前的归一化。大小写、首尾空白、词内多余空格、结尾标点一律不计较——
// 考的是词形，不是打字精度。手机输入法自动大写首字母就更不能算错。
function _studyNorm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;，。！？；]+$/, '').trim();
}
const STUDY_ART = /^(der|die|das)\s+/i;

// 编辑距离，只用来区分"差一两个字母"和"根本没记住"。滚动两行数组够了。
function _studyLev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// → { g, note }，g 直接喂 studySchedule
// 德语冠词单独算一档：词写对了、冠词漏了或写错，判"勉强"而不是"不会"。
// 一上来就判全错会让人不想再答第二题，而这时候真正该补的只是词性。
function studySpellJudge(card, typed) {
  const want = _studyNorm(card.front), got = _studyNorm(typed);
  if (!got) return { g: 0, note: '什么都没写' };
  if (got === want) return { g: 2, note: '' };

  if (card.lang === 'de' && STUDY_ART.test(want)) {
    const wantArt = want.match(STUDY_ART)[1];
    if (got.replace(STUDY_ART, '') === want.replace(STUDY_ART, '')) {
      const gotArt = got.match(STUDY_ART);
      return {
        g: 1,
        note: gotArt ? `词对了，冠词是 ${wantArt}，不是 ${gotArt[1]}` : `词对了，但冠词 ${wantArt} 漏了`,
      };
    }
  }

  const d = _studyLev(got, want);
  if (d <= (want.length > 6 ? 2 : 1)) return { g: 1, note: '就差一两个字母' };
  return { g: 0, note: '' };
}

function studySpellSubmit(id, askId) {
  const c = studyGet(id); if (!c) return;
  if (c.log && c.log[askId]) return;                 // 同一次提问只算一次
  const inp = document.getElementById('spellIn_' + askId);
  const typed = inp ? inp.value : '';
  if (!String(typed).trim()) { showToast('先写点什么再交～', 'info', 2000); return; }
  const j = studySpellJudge(c, typed);
  studySchedule(c, j.g);
  (c.log = c.log || {})[askId] = { g: j.g, ts: Date.now(), mode: 'spell', typed: String(typed).trim(), note: j.note };
  save();
  studyRerender(id, askId);
  studyRefresh();
  _studyChatEnrich(c);
}

// 想不起来就直接看答案，记 0 分。卡在一道题上死磕比答错伤更大。
function studySpellGiveUp(id, askId) {
  const c = studyGet(id); if (!c) return;
  if (c.log && c.log[askId]) return;
  studySchedule(c, 0);
  (c.log = c.log || {})[askId] = { g: 0, ts: Date.now(), mode: 'spell', typed: '', note: '直接看了答案' };
  save();
  studyRerender(id, askId);
  studyRefresh();
  _studyChatEnrich(c);
}

// 回车交卷。stopPropagation 是必须的：这个输入框长在消息流里，
// 冒泡上去会撞上页面级的按键处理（Esc 关面板那类）。
function studySpellKey(ev, id, askId) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  ev.stopPropagation();
  studySpellSubmit(id, askId);
}

// 展开答案是纯运行时状态（刷新后重新折叠，无所谓），不进存储
var _studyRevealed = new Set();
function studyReveal(id, askId) {
  _studyRevealed.add(id + '|' + askId);
  studyRerender(id, askId);
  _studyChatEnrich(studyGet(id));    // 例句、例句的中文、词根要的词书，趁她看答案这会儿补上
}

// 只重画这一个卡片块，不动整条消息——重渲染整条会把正在打字的输入框、
// 滚动位置全打乱（表情包重试那边踩过）
// 题型从元素自己的 data-study-mode 上读：这里只拿到 id 和 askId，
// 不知道这一块当初是认词还是拼写，读错就会把拼写题重画成认词卡（等于送答案）。
function studyRerender(id, askId) {
  document.querySelectorAll(`[data-study-ask="${id}|${askId}"]`).forEach(el => {
    const spell = el.dataset.studyMode === 'spell';
    el.outerHTML = spell ? studySpellHtml(id, askId) : studyCardHtml(id, askId);
  });
}

function _studyDueText(c) {
  if (!c.ivl) return '10 分钟后再考你一次';
  if (c.ivl === 1) return '明天再问你';
  if (c.ivl < 30) return `${c.ivl} 天后再问你`;
  return `${Math.round(c.ivl / 30)} 个月后再问你`;
}

// ── 聊天卡片跟上刷卡界面（用户：「聊天界面的单词卡都似乎没接上新的高级功能」）──
// 刷卡界面 9-28 那两轮加的东西，聊天里这张卡一样没拿到：标熟、四个点、例句标亮、另外几句例句、
// 词根词缀、笔记、易忘。下面这几段是聊天卡片的那一份，数据和刷卡界面共用同一张卡。
//
// 标熟：c.known 是卡上的状态，所以历史里同一个词的每张旧卡都会一起变成「已标熟」——这是对的，
// 它说的是这个词现在的去向。标熟不进 SRS、不写 c.log（没考过，谈不上答对），
// 所以悬着没答的那次提问要在 _studyHasOpenAsk 里放行，不然自动出题会被一张标熟的卡永久堵住。

// 卡头上的小标：没答的、正在学的词亮四个点；错过好几回的标「易忘」。答完的点数看 log（见 _studyChatFate）。
function _studyChatBadges(c, done) {
  let h = '';
  if (!done && _studyLearning(c)) h += ` · 学习中${_studyDotsHtml(c.dots || 0)}`;
  if (!c.known && (c.lapses || 0) + (c.slips || 0) >= 3) h += ' · <b class="study-hard">易忘</b>';
  return h;
}

// 答完之后这个词的去向。正在学的词按**这一次**的 log 说（learn 是答完时的点数），
// 不拿卡上现在的 dots——翻旧聊天时每张旧卡该显示它当时亮到第几个点。
// 没有 learn 字段的是复习词：照旧报下次什么时候见（卡上当前的间隔）。
function _studyChatFate(c, done) {
  if (typeof done.learn === 'number') {
    if (done.grad) return `${_studyDotsHtml(STUDY_DOTS)} 学会了，接下来按复习节点来`;
    return _studyDotsHtml(done.learn) + (done.g === 2 ? ` 还差 ${STUDY_DOTS - done.learn} 个点` : ' 点掉空了，从头再来');
  }
  return c.known ? '' : escHtml(_studyDueText(c));
}

// 答完 / 看过答案之后摊开的那一段：例句（词标亮）+ 中文、另外几句、词根词缀、笔记。
// 拼写题答前不调它——例句里就是答案。
function _studyChatDetailHtml(c, askId) {
  let h = '';
  if (c.ex) {
    h += `<div class="study-ex">${_studyExHtml(c)} <button class="study-speak" onclick="studySpeak('${c.id}',event,'example')" title="念例句">🔊 例句</button></div>`;
    if (c.exZh) h += `<div class="study-ex-zh-chat">${escHtml(c.exZh)}</div>`;
  }
  (c.exMore || []).forEach((x, i) => {
    if (!x || !x.ex) return;
    h += `<div class="study-ex study-ex-more">${_studyExHtml(c, x.ex)} <button class="study-speak" onclick="studySpeak('${c.id}',event,'ex${i}')" title="念这句">🔊</button></div>`;
    if (x.zh) h += `<div class="study-ex-zh-chat">${escHtml(x.zh)}</div>`;
  });
  h += _studyRootsHtml(c);
  const key = c.id + '|' + askId;
  if (_studyChatNoteAt === key) {
    // 没有 oninput：消毒只放行「调 App 函数」形状的内联事件，草稿在保存时直接从框里读
    h += `<div class="study-chat-note-edit">
      <textarea class="study-spell-in" id="studyChatNote_${escHtml(askId)}" spellcheck="false"
        placeholder="写点自己的记法：谐音、联想、容易混的词…（Ctrl+Enter 存）"
        onkeydown="studyChatNoteKey(event,'${c.id}','${askId}')">${escHtml(c.note || '')}</textarea>
      <div class="study-chat-note-row">
        <button class="study-link" onclick="studyChatNoteSave('${c.id}','${askId}')">保存</button>
        <button class="study-link" onclick="studyChatNoteCancel('${c.id}','${askId}')">取消</button>
      </div></div>`;
  } else if (c.note) {
    h += `<div class="study-chat-note" onclick="studyChatNoteEdit('${c.id}','${askId}')" title="点一下改笔记">📝 ${escHtml(c.note)}</div>`;
  } else {
    h += `<button class="study-link" onclick="studyChatNoteEdit('${c.id}','${askId}')">📝 写笔记</button>`;
  }
  return h;
}

// 卡片最底下那一行：没标熟就给「标熟」，标熟了说一声、给反悔。任何时候都能点（同刷卡界面）。
function _studyChatKnownHtml(c) {
  if (c.known) return `<div class="study-known">✓ 已标熟，不再出现 <button class="study-link" onclick="studyChatUnknow('${c.id}')">↺ 取消标熟</button></div>`;
  return `<button class="study-link study-known-btn" onclick="studyChatKnown('${c.id}')" title="以后不再考这个词，单词卡列表里可以取消">✓ 标熟，不用再背</button>`;
}

// 同一个词在聊天里出过好几次，每张都跟着重画（标熟、笔记、例句都是卡上的状态）。
// 正在写笔记的那一张不重画，不然她打了一半的字会被冲掉。
function _studyChatRedraw(id) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  document.querySelectorAll(`[data-study-ask^="${id}|"]`).forEach(el => {
    const key = el.dataset.studyAsk || '';
    const askId = key.split('|')[1];
    if (askId && key !== _studyChatNoteAt) studyRerender(id, askId);
  });
}

function studyChatKnown(id) {
  const c = studyGet(id); if (!c) return;
  c.known = Date.now();
  save();
  _studyChatRedraw(id);
  studyRefresh();
  showToast(`「${c.front}」标熟了，以后不再出现`, 'success', 2500);
}

function studyChatUnknow(id) {
  const c = studyGet(id); if (!c) return;
  delete c.known;
  save();
  _studyChatRedraw(id);
  studyRefresh();
  showToast(`「${c.front}」取消标熟，会重新排进来`, 'success', 2500);
}

// 聊天卡片里的笔记：同一时刻只开一个框（key = 卡id|askId）
var _studyChatNoteAt = null;
function studyChatNoteEdit(id, askId) {
  const prev = _studyChatNoteAt;
  _studyChatNoteAt = id + '|' + askId;
  if (prev && prev !== _studyChatNoteAt) { const [pid, pa] = prev.split('|'); studyRerender(pid, pa); }
  studyRerender(id, askId);
  const ta = typeof document !== 'undefined' && document.getElementById('studyChatNote_' + askId);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function studyChatNoteSave(id, askId) {
  const c = studyGet(id); if (!c) return;
  const ta = typeof document !== 'undefined' && document.getElementById('studyChatNote_' + askId);
  if (ta) _studySetNote(c, ta.value);
  _studyChatNoteAt = null;
  _studyChatRedraw(id);
  studyRefresh();
}
function studyChatNoteCancel(id, askId) {
  _studyChatNoteAt = null;
  studyRerender(id, askId);
}
// 回车是换行，Ctrl+Enter 存，Esc 取消。stopPropagation：这个框长在消息流里，
// Esc 冒上去会撞页面级的按键处理（同 studySpellKey）
function studyChatNoteKey(ev, id, askId) {
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); studyChatNoteCancel(id, askId); }
  else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); studyChatNoteSave(id, askId); }
  else ev.stopPropagation();
}

// 看答案 / 答完这一刻去补例句（含另外几句）和词根要用的词书。
// 不能放进渲染函数里：那边每重画一次就跑一次（幂等是它的底线），翻旧聊天会一口气打几十个请求。
function _studyChatEnrich(c) {
  if (!c) return;
  _studyExSoon(c);
  if (c.lang === 'en' && !studyBookData('gk') && typeof document !== 'undefined' && document.createElement) {
    studyLoadBook('gk').then(() => _studyChatRedraw(c.id), () => {});
  }
}

// ── 卡片渲染 ──
// 幂等：只读当前状态画图，没有任何副作用。渲染层每次重画都会调它。
function studyCardHtml(id, askId) {
  const c = studyGet(id);
  if (!c) return `<div class="study-card study-gone">（这张卡片已经被删掉了）</div>`;

  const key = id + '|' + askId;
  const done = c.log && c.log[askId];
  const open = done || c.known || _studyRevealed.has(key);
  const lang = STUDY_LANG_LABEL[c.lang] || c.lang;

  let h = `<div class="study-card${c.known ? ' study-card-known' : ''}" data-study-ask="${escHtml(key)}">`;
  h += `<div class="study-head"><span class="study-lang">${lang}${_studyChatBadges(c, done)}</span>`;
  h += `<button class="study-speak" onclick="studySpeak('${c.id}',event)" title="听发音">🔊</button></div>`;
  h += `<div class="study-front">${escHtml(c.front)}</div>`;
  if (c.ipa) h += `<div class="study-ipa">${escHtml(c.ipa)}</div>`;

  if (!open) {
    h += `<button class="study-btn study-show" onclick="studyReveal('${c.id}','${askId}')">看答案</button>`;
  } else {
    h += `<div class="study-back">${escHtml(c.back)}</div>`;
    h += _studyChatDetailHtml(c, askId);
    if (done) {
      const tag = ['❌ 不会', '🤔 勉强', '✅ 记住了'][done.g] || '';
      const fate = _studyChatFate(c, done);
      h += `<div class="study-done">${tag}${fate ? `　<span class="study-dim">${fate}</span>` : ''}</div>`;
    } else if (!c.known) {
      h += `<div class="study-grades">
        <button class="study-g study-g0" onclick="studyGrade('${c.id}','${askId}',0)">❌ 不会</button>
        <button class="study-g study-g1" onclick="studyGrade('${c.id}','${askId}',1)">🤔 勉强</button>
        <button class="study-g study-g2" onclick="studyGrade('${c.id}','${askId}',2)">✅ 记住了</button>
      </div>`;
    }
  }
  return h + _studyChatKnownHtml(c) + `</div>`;
}

// 拼写题的渲染。同样幂等。
// ⚠️ 答完之前**不给 🔊**：念一遍就等于把答案读出来了。答完再给，
// 而且这时候才最想听——刚写错的词，听一遍比看一眼记得住。
function studySpellHtml(id, askId) {
  const c = studyGet(id);
  if (!c) return `<div class="study-card study-gone">（这张卡片已经被删掉了）</div>`;

  const key = id + '|' + askId;
  const done = c.log && c.log[askId];
  const lang = STUDY_LANG_LABEL[c.lang] || c.lang;

  let h = `<div class="study-card study-card-spell${c.known ? ' study-card-known' : ''}" data-study-ask="${escHtml(key)}" data-study-mode="spell">`;
  h += `<div class="study-head"><span class="study-lang">${lang}${_studyChatBadges(c, done)}</span><span class="study-mode">✍️ 拼写</span></div>`;
  h += `<div class="study-front">${escHtml(c.back)}</div>`;   // 拼写题正面是中文释义

  if (!done && c.known) {
    // 没拼就标熟了：不再要她拼，直接亮出这个词
    h += `<div class="study-back">${escHtml(c.front)}</div>`;
    if (c.ipa) h += `<div class="study-ipa">${escHtml(c.ipa)}</div>`;
    h += _studyChatDetailHtml(c, askId);
  } else if (!done) {
    // autocapitalize/autocorrect 全关：手机输入法会把 apple 改成 Apple、
    // 把德语词自动纠成英语词，那就不是在考他了。
    h += `<div class="study-spell-row">
      <input class="study-spell-in" id="spellIn_${escHtml(askId)}" type="text"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        placeholder="${c.lang === 'de' ? '连 der/die/das 一起写' : '把这个词拼出来'}"
        onkeydown="studySpellKey(event,'${c.id}','${askId}')">
      <button class="study-btn study-spell-go" onclick="studySpellSubmit('${c.id}','${askId}')">交卷</button>
    </div>
    <button class="study-spell-skip" onclick="studySpellGiveUp('${c.id}','${askId}')">想不起来，看答案</button>`;
  } else {
    const tag = ['❌ 没写出来', '🤔 差一点', '✅ 拼对了'][done.g] || '';
    h += `<div class="study-back">${escHtml(c.front)}</div>`;
    // 音标只在**答完之后**给。写在题面上等于把读音漏出去了，
    // 拼写题连 🔊 都要藏到这一步之后（见函数头的注释），音标同理。
    if (c.ipa) h += `<div class="study-ipa">${escHtml(c.ipa)}</div>`;
    h += _studyChatDetailHtml(c, askId);
    if (done.typed && _studyNorm(done.typed) !== _studyNorm(c.front)) {
      h += `<div class="study-typed">你写的：<s>${escHtml(done.typed)}</s></div>`;
    }
    const fate = _studyChatFate(c, done);
    h += `<div class="study-done">${tag}${done.note ? '　' + escHtml(done.note) : ''}${fate ? `　<span class="study-dim">${fate}</span>` : ''}</div>`;
    h += `<button class="study-spell-hear" onclick="studySpeak('${c.id}',event)">🔊 听一遍</button>`;
  }
  return h + _studyChatKnownHtml(c) + `</div>`;
}

// 渲染层入口：把存储里的 [[CARDQ:…]] 换成当前状态的卡片。
// 由 stickerTagToHtml 末尾统一调用——那条路 content 和 blocks 两个渲染
// 路径都会经过，不用像有些指令那样单独写一份 _applyXxxToBlocks。
function studyTagToHtml(text) {
  if (!text) return text;
  // 兜底：历史消息里已经存下的**裸** [[CARD:]] 也救活成卡片。
  // 这种标签是 blocks 路径漏处理时留下的（processAiCommands 只管 content），
  // 以及功能上线前 AI 就写过的。功能没开就原样留着别偷偷建卡——
  // 标签留在存储里，等哪天开了自然会被救活（同 [[GIF_SEARCH:]] 失败时的处理）。
  if (text.indexOf('[[CARD:') >= 0 && studyEnabled()) {
    text = text.replace(studyCardTagRe(), (m, payload) => {
      const c = studyCreate(payload);
      return c ? `[[CARDQ:${c.id}|${_studyHash(payload)}]]` : m;
    });
  }
  // 漏进存储的裸 [[SPELL]] 直接抹掉，不在渲染层现挑卡片：
  // 挑卡要看"当前哪些到期"，那是有副作用、每次结果都不同的事，
  // 而这个函数每重画一次就跑一次（幂等是它的底线）。
  if (text.indexOf('[[SPELL') >= 0) text = text.replace(studySpellTagRe(), '');
  if (!_studyHasAskTag(text)) return text;
  return text.replace(studyAnyQTagRe(), (m, mode, id, askId) => {
    // 还没答的题才预取发音：翻旧聊天时满屏答完的卡不该一口气打几十个请求
    const c = studyGet(id);
    if (c && !(c.log && c.log[askId])) studyPrefetchAudio([id]);
    return '\n' + (mode === 'S' ? studySpellHtml(id, askId) : studyCardHtml(id, askId)) + '\n';
  });
}

// blocks 渲染路径：模型的回复被切成 blocks 时，b.text 里的指令
// **不经过 processAiCommands**（那条只管 content）——同其他 _applyXxxToBlocks。
// 漏了这个就是「气泡里裸着一行 [[CARD: …]]」。
function _applyStudyToBlocks(blocks, ctx) {
  if (!blocks || !blocks.length) return;
  // content 已经执行过一次建卡/选卡；blocks 只重放同一批替换结果。
  // 不能再调 studyProcessTags 生成新 askId，否则用户点的是 blocks 里的卡，
  // 回填给模型的 content 却指向另一道“还没答”的题。
  let ci = 0, ri = 0, si = 0;
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text) continue;
    if (ctx) {
      b.text = b.text
        .replace(studyCardTagRe(), () => (ctx.cardReplacements || [])[ci++] || '')
        .replace(studyReviewTagRe(), () => (ctx.reviewReplacements || [])[ri++] || '')
        .replace(studySpellTagRe(), () => (ctx.spellReplacements || [])[si++] || '')
        .replace(/\[\[STUDY_SKIP(?::[^\]]*)?\s*\]\]/gi, '');
    } else {
      b.text = studyProcessTags(b.text);
    }
  }
  if (ctx?.autoTag) {
    let tail = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'text') { tail = blocks[i]; break; }
    }
    if (tail) tail.text = (tail.text || '') + ctx.autoTag;
    else blocks.push({ type: 'text', text: ctx.autoTag });
  }
}

// ── 发音 ──
// 单词和例句分开念：卡片顶部的喇叭永远念正面；例句旁的按钮只念例句。
//
// 用户问「单词软件点发音为什么几乎没延迟」——因为点下去那一刻什么都不用现做。
// 2026-09-28 把这条链路拆开量过，照着一段一段削：
//   · Edge 现合成一个词 0.6～0.7 秒 → 后端存盘（server/tts-disk.js），词书整本预生成
//     （scripts/tts-pregen-book.js），读盘 8 毫秒
//   · 每次 new Audio() 现解码 mp3 → 这里预取时就用 Web Audio 解成 AudioBuffer，点下去直接出声
//   · Edge 的 mp3 开头有 185 毫秒静音，听起来就是「点了顿一下才响」→ 解码后把首尾静音裁掉
//   · 重开 App 内存缓存就空、手机还要隔着网络找电脑 → 拿到的 mp3 存进本机 IndexedDB，
//     以后断网、电脑关着也能念
//   · 刷卡一开始就把整轮的词按顺序预取（限并发，别把 Edge 那条常驻连接挤爆）
// 没有 Web Audio 或者解码失败，退回 <audio> 播放，功能不丢。
var _studyAudio = new Map();          // `${voice}|${text}` → Promise<{buf, url}>
const STUDY_AUDIO_MAX = 80;           // 解码后的波形比 mp3 大十几倍，一个词裁完约 100KB，80 个 ≈ 8MB
var _studyPlaying = null;             // 正在念的那个 {stop()}，连点时先掐掉上一个
var _studyAC = null;

function _studyAudioCtx() {
  if (_studyAC) return _studyAC;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { _studyAC = new AC(); } catch (_) { _studyAC = null; }
  return _studyAC;
}

// 老 WebView 的 decodeAudioData 只认回调，新的返回 Promise，两种都接
function _studyDecode(ac, ab) {
  return new Promise((res, rej) => {
    try { const p = ac.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }
    catch (e) { rej(e); }
  });
}

// 裁掉首尾静音，前后各留 20ms 免得吃掉辅音的起音。全静音（坏文件）就原样返回。
function _studyTrimSilence(ac, buf) {
  const d = buf.getChannelData(0), n = d.length, thr = 0.01;
  let a = 0, b = n - 1;
  while (a < n && Math.abs(d[a]) < thr) a++;
  if (a >= n) return buf;
  while (b > a && Math.abs(d[b]) < thr) b--;
  const pad = Math.round(buf.sampleRate * 0.02);
  a = Math.max(0, a - pad); b = Math.min(n - 1, b + pad);
  const out = ac.createBuffer(buf.numberOfChannels, b - a + 1, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).subarray(a, b + 1));
  return out;
}

// ── 本机持久缓存：单独一个 IndexedDB 库，不和 state 混（state 要整份存盘、云同步，拖着几十 MB 音频不行）──
// 不做淘汰：一个词十几 KB，整本高中词书全念过一遍也就四十来 MB。
const STUDY_AUDIO_DB = 'gc-study-audio';
var _studyAudioDbP = null;
function _studyAudioDb() {
  if (_studyAudioDbP) return _studyAudioDbP;
  _studyAudioDbP = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const rq = indexedDB.open(STUDY_AUDIO_DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('mp3');
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return _studyAudioDbP;
}
async function _studyAudioDbGet(key) {
  const db = await _studyAudioDb(); if (!db) return null;
  return new Promise(res => {
    try {
      const rq = db.transaction('mp3').objectStore('mp3').get(key);
      rq.onsuccess = () => res(rq.result instanceof ArrayBuffer && rq.result.byteLength >= 200 ? rq.result : null);
      rq.onerror = () => res(null);
    } catch (_) { res(null); }
  });
}
function _studyAudioDbPut(key, ab) {
  _studyAudioDb().then(db => { if (db) try { db.transaction('mp3', 'readwrite').objectStore('mp3').put(ab, key); } catch (_) {} });
}

function _studyAudioText(c, part) {
  if (part === 'example') return c.ex || c.front;
  const m = /^ex(\d)$/.exec(part || '');
  if (m) { const x = (c.exMore || [])[+m[1]]; return (x && x.ex) || c.front; }
  return c.front;
}

function _studyAudioGet(c, part) {
  const voice = STUDY_VOICE[c.lang] || STUDY_VOICE.en;
  const txt = _studyAudioText(c, part);
  const key = voice + '|' + txt;
  let p = _studyAudio.get(key);
  if (p) { _studyAudio.delete(key); _studyAudio.set(key, p); return p; }   // LRU：挪到队尾
  p = (async () => {
    let ab = await _studyAudioDbGet(key);
    if (!ab) {
      const r = await fetch(`${SERVER_BASE}/api/tts?text=${encodeURIComponent(txt)}&voice=${voice}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ab = await r.arrayBuffer();
      if (ab.byteLength < 200) throw new Error('空音频');
      _studyAudioDbPut(key, ab);         // put 当场就把数据克隆走了，后面解码把 ab 拆掉也不影响
    }
    const ac = _studyAudioCtx();
    if (ac) {
      // decodeAudioData 会把传进去的 ArrayBuffer 拆掉（detach），留一份给退路用
      try { return { buf: _studyTrimSilence(ac, await _studyDecode(ac, ab.slice(0))), url: null }; }
      catch (_) { /* 解不了就退回 <audio> */ }
    }
    return { buf: null, url: URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' })) };
  })();
  p.catch(() => { if (_studyAudio.get(key) === p) _studyAudio.delete(key); });   // 失败别缓存，下次重试
  _studyAudio.set(key, p);
  while (_studyAudio.size > STUDY_AUDIO_MAX) {
    const [k, old] = _studyAudio.entries().next().value;
    _studyAudio.delete(k);
    old.then(a => { if (a.url) URL.revokeObjectURL(a.url); }, () => {});
  }
  return p;
}

function _studyStopAudio() {
  if (_studyPlaying) { try { _studyPlaying.stop(); } catch (_) {} _studyPlaying = null; }
}

function _studyPlayClip(a) {
  _studyStopAudio();
  const ac = _studyAC;
  if (a.buf && ac) {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const src = ac.createBufferSource();
    src.buffer = a.buf;
    src.connect(ac.destination);
    src.start(0);
    _studyPlaying = { stop: () => src.stop() };
    return Promise.resolve();
  }
  const el = new Audio(a.url);
  _studyPlaying = { stop: () => el.pause() };
  return el.play();
}

// 后台预取：只取正面（例句长、点得少），失败静默——点的时候 studySpeak 会再说人话。
// 渲染层可以放心调：同一个词只会真的请求一次。排队、同时最多 2 个：
// 一开刷就把整轮三十来个词塞进来，不限并发的话几十个请求同时砸到后端那条 Edge 常驻连接上。
// 挂在渲染路径上，所以整个包在 try 里：预取出什么岔子都不许把卡片画挂。
var _studyPrefetchQ = [], _studyPrefetchRun = 0;
function _studyPrefetchPump() {
  while (_studyPrefetchRun < 2 && _studyPrefetchQ.length) {
    const c = studyGet(_studyPrefetchQ.shift());
    if (!c) continue;
    _studyPrefetchRun++;
    _studyAudioGet(c, 'front').catch(() => {}).finally(() => { _studyPrefetchRun--; _studyPrefetchPump(); });
  }
}
function studyPrefetchAudio(ids, front) {
  try {
    if (typeof fetch !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) return;
    if (!SERVER_BASE && typeof location !== 'undefined' && location.protocol === 'file:') return;
    ids = ids.filter(Boolean);
    // front=true：插队（眼前这张和紧跟着的两张），其余排在后面
    _studyPrefetchQ = front ? ids.concat(_studyPrefetchQ.filter(x => !ids.includes(x)))
                            : _studyPrefetchQ.concat(ids.filter(x => !_studyPrefetchQ.includes(x)));
    _studyPrefetchPump();
  } catch (_) {}
}

async function studySpeak(id, ev, part = 'front') {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const c = studyGet(id); if (!c) return;
  const btn = ev && ev.currentTarget;
  _studyStopAudio();
  const ac = _studyAudioCtx();
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {});   // 趁着这一下点击把音频解锁
  // 还没到手的时候给个在转的反馈，别让她以为没点上
  const slow = btn && setTimeout(() => btn.classList.add('study-speak-wait'), 120);
  try {
    await _studyPlayClip(await _studyAudioGet(c, part));
  } catch (e) {
    // 手机上 SERVER_BASE 没配（或没连电脑）就是这条路，说人话别静默
    showToast('发音要连着电脑的后端服务才行～', 'error', 3000);
  } finally {
    if (btn) { clearTimeout(slow); btn.classList.remove('study-speak-wait'); }
  }
}

// ── 音标 ──
// 后端 /api/ipa 查词典（en → dictionaryapi.dev，de → de.wiktionary），本机缓存。
// 不让 AI 在 [[CARD:]] 里带音标：那条协议按位置解析，加一段就多一处能错位的地方
// （见文件头的注释和 grancyan2-tag-format-imitation）。音标是查得到的事实，查比编稳。
//
// ⚠️ 渲染层不能直接调这个：studyCardHtml 每重画一次就会跑一次，
// 一张卡在屏幕上滚进滚出十次就是十个请求。补音标只在**建卡时**和
// **她按「补音标」时**发生，两处都是有明确边界的一次性动作。

var _studyIpaInflight = new Set();      // 同一个词别并发查两遍（建卡 + 批量补可能撞上）

// 查一个词的音标，写回卡片。返回是否真的拿到了。
// ipaTried 记时间戳而不是布尔：词典临时抽风（或者当时没联网）不该把这个词
// 永久钉死成"没有音标"，隔一天再按「补音标」还能再试一次。
async function studyFetchIpa(card) {
  if (!card || card.ipa) return false;
  if (_studyIpaInflight.has(card.id)) return false;
  _studyIpaInflight.add(card.id);
  try {
    const r = await fetch(`${SERVER_BASE}/api/ipa?lang=${encodeURIComponent(card.lang)}&word=${encodeURIComponent(card.front)}`);
    const j = await r.json();
    card.ipaTried = Date.now();
    if (j && j.ok && j.ipa) { card.ipa = j.ipa; return true; }
    return false;
  } catch (e) {
    // 没连上后端（手机没连电脑）。不记 ipaTried —— 这次压根没查成，
    // 记了的话下面那个 24 小时的门会把它挡在外面一整天。
    return false;
  } finally {
    _studyIpaInflight.delete(card.id);
  }
}

// ⚠️ 这里原来有个 24 小时的重试门（跳过"今天查过但没查到"的卡）。已经拿掉，因为：
//   1. 唯一的调用方是面板上那个按钮——**手按按钮就是明确的意图**，不该被节流；
//   2. 后端对"词典里确实没有"的词有永久缓存，重按一次几乎不出网；
//   3. 门还留着的话会是半开的：只要有**一张**卡超过 24 小时，todo 就非空，
//      于是"让路"的分支根本不触发，剩下那些当天查过的照样被挡一整天。
//      这正是 Codex 审出来的第 3 条——注释承诺了让路，实现只在全体被挡时才让。
// ipaTried 字段本身保留：studyFetchIpa 还在写，将来要做自动补时是现成的依据。

// 批量补：给面板上那个按钮用。串行 + 小间隔，别把词典打崩
//（本机缓存命中的那些几乎不花时间，真正出网的只有新词）。
async function studyFillIpa() {
  const todo = studyCards().filter(c => !c.ipa);
  if (!todo.length) { showToast('每个词都有音标了 ✓', 'success', 3000); return; }
  showToast(`📖 正在查 ${todo.length} 个词的音标…`, 'success', 2500);
  let got = 0;
  for (const c of todo) {
    if (await studyFetchIpa(c)) got++;
    await new Promise(r => setTimeout(r, 120));
  }
  save();
  studyRefresh(true);
  if (typeof renderMessages === 'function') renderMessages();   // 聊天里那些卡片也跟着更新
  showToast(`📖 补上 ${got} 个音标${todo.length - got ? `，${todo.length - got} 个没查到` : ''}`, 'success', 4000);
}

// 建卡后台补一发。**不 await**：建卡是同步流程里的一步（studyProcessTags），
// 让它等一次网络往返的话，AI 每教一个词整条消息的渲染都要卡上一秒。
function _studyIpaSoon(card) {
  if (!card || card.ipa) return;
  setTimeout(async () => {
    if (await studyFetchIpa(card)) {
      save();
      // 卡片是"标签原样存储、渲染层每次重画"的（见文件头），所以补完只要重画
      if (typeof renderMessages === 'function') renderMessages();
      studyRefresh(true);
    }
  }, 50);
}

// ── 指令处理（由 processAiCommands 调用，同步）──
// 建卡和抽考都在这里换成 [[CARDQ:…]]，**只有这个短标签进存储**。
// 顺带的好处：历史里存的是十几个字符的标签而不是虚胖 HTML，
// 回填给模型时省一大截 token（引擎结果块就很占）。
function studyProcessTags(text, ctx = null) {
  if (!text) return text;

  const skipped = /\[\[STUDY_SKIP(?::[^\]]*)?\s*\]\]/i.test(text);
  text = text.replace(/\[\[STUDY_SKIP(?::[^\]]*)?\s*\]\]/gi, '');
  if (ctx) {
    ctx.cardReplacements = [];
    ctx.reviewReplacements = [];
    ctx.spellReplacements = [];
    ctx.autoTag = '';
  }
  let offered = false;

  text = text.replace(studyCardTagRe(), (m, payload) => {
    let replacement = '';
    if (!studyEnabled() || offered) {
      if (ctx) ctx.cardReplacements.push(replacement);
      return replacement;
    }
    const c = studyCreate(payload);
    if (!c) {
      if (ctx) ctx.cardReplacements.push(replacement);
      return replacement;                    // 格式烂到解析不出来，别把裸标签漏给用户
    }
    studyRefresh();
    _studyNoteKind('new');          // 现教现考的是个新词，下一张该轮到复习
    replacement = `\n\n[[CARDQ:${c.id}|${_studyId('a')}]]\n\n`;
    offered = true;
    if (ctx) ctx.cardReplacements.push(replacement);
    return replacement;
  });

  text = text.replace(studyReviewTagRe(), () => {
    let replacement = '';
    if (!studyEnabled() || offered || (ctx?.chat && _studyHasOpenAsk(ctx.chat))) {
      if (ctx) ctx.reviewReplacements.push(replacement);
      return replacement;
    }
    // [[REVIEW]] 是"考一张旧卡"，所以只从复习队列里拿，不走 studyPick 的交替
    //（模型明说要复习的时候塞一张没见过的新词，那不叫复习）
    const review = studyReviewQueue();
    // 没有到期的就悄悄抹掉——总比硬塞一张刚学完的卡好
    if (!review.length) {
      if (ctx) ctx.reviewReplacements.push(replacement);
      return replacement;
    }
    _studyNoteKind('review');
    replacement = `\n\n[[CARDQ:${review[0].id}|${_studyId('a')}]]\n\n`;
    offered = true;
    if (ctx) ctx.reviewReplacements.push(replacement);
    return replacement;
  });

  text = text.replace(studySpellTagRe(), () => {
    let replacement = '';
    if (!studyEnabled() || offered || (ctx?.chat && _studyHasOpenAsk(ctx.chat))) {
      if (ctx) ctx.spellReplacements.push(replacement);
      return replacement;
    }
    const c = _studySpellPick();
    if (!c) {                                  // 没有够熟的卡就当没说过，别硬考
      if (ctx) ctx.spellReplacements.push(replacement);
      return replacement;
    }
    _studyNoteKind('review');       // 拼写题抽的也是复习队列里的旧卡
    replacement = `\n\n[[CARDS:${c.id}|${_studyId('a')}]]\n\n`;
    offered = true;
    if (ctx) ctx.spellReplacements.push(replacement);
    return replacement;
  });

  if (offered) {
    _studyMarkOffer(ctx);
  } else if (_studyCanAutoOffer(ctx, skipped)) {
    const c = studyPick();
    if (c) {
      const tag = `\n\n[[CARD${_studyAutoSpell(c) ? 'S' : 'Q'}:${c.id}|${_studyId('a')}]]\n\n`;
      text += tag;
      if (ctx) ctx.autoTag = tag;
      _studyMarkOffer(ctx);
    }
  }

  return text;
}

// 拼写题只从**答过至少一次**的到期卡里挑：一个刚见过一面、还没认清的词
// 让人凭空拼出来，那不是复习是刁难，答不出来还要被 SRS 扣一轮。
// （复习队列本身就已经排除了没答过的新卡，所以这里直接取队首。）
function _studySpellPick() {
  return studyReviewQueue()[0] || null;
}

// 程序自动补卡时的题型：熟到一定程度才改考拼写（认得出来的词才值得考写得出来）。
// 用 reps 的奇偶交替，同一张卡不会连着两轮都只考拼写。
function _studyAutoSpell(c) {
  return !!c && (c.reps || 0) >= 2 && (c.reps || 0) % 2 === 0;
}

// 流式打字时别让裸指令（和打了一半的指令）漏在气泡里
function maskStreamingStudy(text) {
  // 门槛只看 `[[`，不看完整标签名：流式是一个字一个字来的，
  // 「[[SPEL」这种打了一半的状态原来漏在气泡里（因为它还不含 `[[SPELL`），
  // 下面最后一条专门收这种半截标签。
  if (!text || text.indexOf('[[') < 0) return text;
  return text
    .replace(/\[\[CARD:[\s\S]*?\]\]/g, '〔📇 出题中…〕')
    .replace(/\[\[CARD:[\s\S]*$/, '〔📇 出题中…〕')
    .replace(/\[\[REVIEW(?::[^\]]*)?\]\]/g, '〔📇 出题中…〕')
    .replace(/\[\[REVIEW[\s\S]*$/, '〔📇 出题中…〕')
    .replace(/\[\[SPELL(?::[^\]]*)?\]\]/g, '〔✍️ 出题中…〕')
    .replace(/\[\[SPELL[\s\S]*$/, '〔✍️ 出题中…〕')
    // 结尾一截还没写全的标签名（[[CAR / [[REVIE / [[SPEL）。
    // 必须是这三个名字的真前缀才遮，否则会把 [[MEM_ADD:… 这类别人的标签
    // 在刚打出 `[[M` 的那一帧误标成"出题中"。
    .replace(/\[\[([A-Z]+)$/, (m, w) =>
      ['CARD', 'REVIEW', 'SPELL'].some(k => k.startsWith(w)) ? '〔📇 出题中…〕' : m);
}

// 回填历史给模型时，把 [[CARDQ:…]] 压成一行可读文本。
// **漏了这条模型就是瞎的**：它看不见自己出过什么题、你答没答、答得怎么样，
// 于是会反复出同一个词，或者永远不知道你昨天全错了（三个配套里最容易漏的一条）。
// mode 是标签里的 Q/S；旧调用没传就退回看 log 里的记录（拼写题会留 mode:'spell'）
function _studyForApiOne(id, askId, mode) {
  const c = studyGet(id);
  if (!c) return '[出过一张已删除的卡片]';
  const d = c.log && c.log[askId];
  // 标熟是卡上的状态：没答就标熟的写成「标熟了」，答过的后面补一句。模型看到就不会再拿这个词考他
  const known = c.known ? (d ? '；这个词后来标熟了，不用再考' : '') : '';
  if (mode === 'S' || (d && d.mode === 'spell')) {
    const res = d ? ['没拼出来', '差一点', '拼对了'][d.g] : c.known ? '没拼，直接标熟了，说这个词太简单' : '还没答';
    // 把他写错的样子也告诉模型：错在哪比错没错有用（模型能顺口讲一句为什么）
    const typed = d && d.typed && _studyNorm(d.typed) !== _studyNorm(c.front) ? `，写成了「${d.typed}」` : '';
    return `[拼写题: ${c.back} → ${c.front}（用户：${res}${typed}${known}）]`;
  }
  const res = d ? ['答不出来', '勉强想起来', '记住了'][d.g] : c.known ? '没答，直接标熟了，说这个词太简单' : '还没答';
  return `[卡片: ${c.front} = ${c.back}（用户：${res}${known}）]`;
}

function studyTagForApi(text) {
  if (!text || !_studyHasAskTag(text)) return text;
  return text.replace(studyAnyQTagRe(), (m, mode, id, askId) => _studyForApiOne(id, askId, mode));
}

// ── 系统提示 ──
function studyPromptFor() {
  const cards = studyCards();
  const review = studyReviewQueue();
  const group = studyGroup();
  // 最近学过的给模型看一眼，免得它把同一个词教十遍
  const recent = cards.slice(-25).map(c => c.front).join('、');
  const dueList = review.slice(0, 5).map(c => `${c.front}（${c.back}）`).join('、');
  const groupList = group.slice(0, 6).map(c => c.front).join('、');

  return `

--- 学习卡片（用户在跟你学英语和德语）---
用户的水平：**英语只认识一些常见词汇，德语是零基础**。跟他说英语要压到很简单；德语**绝对不要整句说**，他还看不懂，会直接被劝退。

你可以在聊天里随手教他；到期复习则由程序按节奏兜底，不再依赖你碰巧想起来：
- \`[[CARD: 语言|正面|背面|例句]]\` — 教一个新词并立刻考他。语言填 \`de\` 或 \`en\`，例句可省。
  例：\`[[CARD: de|der Tisch|桌子|Der Tisch ist groß.]]\`、\`[[CARD: en|budget|预算|We are over budget.]]\`
- \`[[REVIEW]]\` — 抽一张到期该复习的旧卡考他（看词想意思）。挑哪张由算法定，你不用管。
- \`[[SPELL]]\` — 抽一张够熟的旧卡考**拼写**：给他中文，他自己把词敲出来。同样不用你挑卡。
  他随口说"这个词我看得懂但写不出来"、或者想练拼写的时候用这条最合适。

规则（这几条比出题本身重要）：
- **语言字段别省**。省了程序只能靠词形猜，英语词很容易被猜成德语卡（挂德国旗、用德语音色念）。
- **德语名词必须连冠词一起写**：正面写 \`der Tisch\` 而不是 \`Tisch\`。词性后补是补不回来的，裸名词的卡等于废卡。
- **一轮最多插一张卡**。他最怕的就是"学习感"，一次糊三张过来他会直接关掉。
- **聊得正起劲的时候别打断**。他在说正事、在情绪里、在专注干活，就不要出题——等话题告一段落、或者他自己提起学习/某个词的时候再插。宁可今天不考，也不要打断他。
- 如果**这一轮明确不适合出现卡片**（正在安慰严重情绪、处理紧急事情、通话或专注工作），在回复任意位置写 \`[[STUDY_SKIP]]\`。它会被隐藏，并阻止程序本轮自动补卡。只有明确不合适时才写，不要把普通闲聊也一律判成打扰。
- 出卡时**别在正文里复述题目**，用户看到的是一个可交互的卡片块，你复述就重复了。拼写题更不能——正文里写出那个词就是直接给答案。
- 他答完你能在下一轮看到结果（历史里会写"用户：记住了/勉强想起来/答不出来"，拼写题还会写他拼成了什么）。答错的别急着再考一遍，算法会安排；但可以顺口讲一句为什么，拼错的地方值得点一句（比如少了个字母、德语冠词记错了）。
- 他随口问某个词怎么说、或者聊到一个值得记的表达，**直接建卡**，这是最自然的时机。

当前状态：已有 ${cards.length} 张卡片，其中 **${review.length} 张今天到期该复习**。${dueList ? `\n到期的前几张：${dueList}` : ''}${groupList ? `\n这一组正在学的新词（程序会按节奏投放，你不用管顺序）：${groupList}` : ''}${recent ? `\n最近学过（别重复教）：${recent}` : ''}`;
}

// ── 开关 ──
function toggleStudy(on) {
  state.studyOn = !!on;
  save();
  showToast(state.studyOn ? '📇 单词卡已接入对话' : '单词卡不再接入对话', state.studyOn ? 'success' : 'info', 2500);
  studyRefresh();
}

// ============================================================
// 小组件面板
// 第一阶段刻意做得很薄：开关 + 到期数 + 卡片列表（能删）。
// 番茄钟、统计图、错题本视图全没做——不是忘了，是等用户真用满两周，
// 那时才知道哪些是真需求。现在猜着做，大概率做一堆没人点的按钮。
// ============================================================

function openStudy() {
  const m = document.getElementById('studyModal'); if (!m) return;
  m.classList.remove('hidden');
  const t = document.getElementById('studyToggle'); if (t) t.checked = studyEnabled();
  studyRefresh(true);
}
function closeStudy() { document.getElementById('studyModal')?.classList.add('hidden'); }
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('studyModal');
  if (m && !m.classList.contains('hidden')) closeStudy();
});

// ============================================================
// 内置词书
// 用户要的是不背单词那种「选一本书，词自己排进来」，不用先去网上扒词表再导入。
// 书的正文在 js/wordbooks/*.js（ECDICT 生成，按词频排，最常用的在前），
// **按需用 <script> 注入**而不是 fetch：安卓 WebView 和 file:// 下 fetch 本地文件会被拦，
// script 标签哪儿都能载。
//
// 书里的词**不一次性灌进卡片库**：3000 多张卡每张十几个字段，全塞进 state 会让
// 每次 save() 和云同步都拖着一大坨没学过的东西。改成每开一组新词时从书里补一组
// （studyGroup → studyBookTopUp），state.studyBook.pos 记着取到了第几个。
// pos 只进不退——删掉的书词不会再冒回来。
// ============================================================

const STUDY_BOOKS = {
  gk: { name: '高中（含中考词）', file: './js/wordbooks/gk.js', lang: 'en' },
};
var _studyBookLoading = {};

function studyBookData(id) {
  const all = globalThis.GC_WORDBOOKS;
  const b = all && all[id];
  return b && Array.isArray(b.words) ? b : null;
}

function studyLoadBook(id) {
  const meta = STUDY_BOOKS[id];
  if (!meta) return Promise.reject(new Error('没有这本词书'));
  if (studyBookData(id)) return Promise.resolve(studyBookData(id));
  if (_studyBookLoading[id]) return _studyBookLoading[id];
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = meta.file;
    s.onload = () => { const b = studyBookData(id); b ? resolve(b) : reject(new Error('词书文件是空的')); };
    s.onerror = () => reject(new Error('词书文件没载进来'));
    document.head.appendChild(s);
  });
  _studyBookLoading[id] = p;
  // 载好了立刻让当前组有机会从书里补词；载失败就把 Promise 扔掉，下次还能重试
  p.then(() => { studyGroup(); studyRefresh(); }, () => { delete _studyBookLoading[id]; });
  return p;
}

// 新词不够一组时从书里补一组。先用她自己导入的 / AI 教的词（它们 created 更早），
// 书词排在后面；同一个词已经有卡就跳过（_studyAdd 自带去重），跳过的也算取过。
function studyBookTopUp() {
  const sel = state.studyBook;
  if (!sel) return 0;
  const book = studyBookData(sel.id);
  if (!book) return 0;
  const lang = book.lang || 'en';
  const size = studyGroupSize();
  if (studyCards().filter(c => c.lang === lang && _studyIsNew(c)).length >= size) return 0;
  let added = 0, pos = sel.pos || 0;
  const base = Date.now();
  while (added < size && pos < book.words.length) {
    const [front, ipa, back] = book.words[pos++];
    const r = _studyAdd(lang, front, back, '');
    if (r && r.isNew) {
      r.card.ipa = ipa || '';
      r.card.src = sel.id;
      r.card.created = base + added;       // 保住书里的词频顺序
      added++;
    }
  }
  if (pos !== sel.pos) { state.studyBook = { id: sel.id, pos }; save(); }
  return added;
}

function studySetBook(id) {
  if (!id) {
    state.studyBook = null;
    save();
    studyRefresh(true);
    showToast('不用词书了，已经取出来的词还在', 'info', 3000);
    return;
  }
  if (!STUDY_BOOKS[id]) return;
  if (!state.studyBook || state.studyBook.id !== id) state.studyBook = { id, pos: 0 };
  save();
  studyLoadBook(id).then(b => {
    studyGroup();
    studyRefresh(true);
    showToast(`📚 ${b.name}：${b.words.length} 个词，常用的在前，一组一组来`, 'success', 3500);
  }, e => showToast('词书没载进来：' + e.message, 'error', 4000));
}

// ============================================================
// 今日 / 打卡
// 全部从 c.log 现算，不另存计数器：聊天里答的卡、自己刷的卡本来就都记在那里，
// 另存一份迟早和真实记录对不上（而且老进度直接就能算出连续天数）。
// 「今日新学」= 第一次作答发生在今天的卡；「今日复习」= 今天答过、但更早就学过的卡。
// ============================================================

function _studyDayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

// 有了「四个点」之后，「今日新学」= **今天学会（亮满 4 个点）**的词，学到一半的另算「学习中」。
// 老卡和聊天里直接进复习的词没有学习记录（log 里没有 learn 字段），照旧按「第一次作答在今天」算新学。
function studyDayStats(now = Date.now()) {
  const today = _studyDayKey(now);
  const days = new Set();
  let learned = 0, reviewed = 0, learning = 0;
  for (const c of studyCards()) {
    let first = Infinity, hasLearn = false, gradToday = false, learnToday = false, reviewToday = false;
    for (const k in (c.log || {})) {
      const e = c.log[k];
      if (!e || !e.ts) continue;
      const dk = _studyDayKey(e.ts);
      days.add(dk);
      if (c.resetAt && e.ts < c.resetAt) continue;   // 全部重来之前的作答只算打卡，不算这张卡学过
      if (e.ts < first) first = e.ts;
      const isLearn = typeof e.learn === 'number';
      if (isLearn) hasLearn = true;
      if (dk !== today) continue;
      if (isLearn) { learnToday = true; if (e.grad) gradToday = true; }
      else reviewToday = true;
    }
    if (gradToday || (!hasLearn && first !== Infinity && _studyDayKey(first) === today)) learned++;
    else if (reviewToday) reviewed++;
    else if (learnToday) learning++;
  }
  // 今天还没刷不算断：连续天数从昨天往回数，等今天刷了再 +1
  let streak = 0;
  const d = new Date(now);
  if (!days.has(today)) d.setDate(d.getDate() - 1);
  while (days.has(_studyDayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  const recent = [];
  for (let i = 13; i >= 0; i--) {
    const x = new Date(now); x.setDate(x.getDate() - i);
    recent.push(days.has(_studyDayKey(x.getTime())));
  }
  return { learned, reviewed, learning, streak, doneToday: days.has(today), recent };
}

// ============================================================
// 自己刷单词（照不背单词的手感）
// 原来的设计是"卡片只长在聊天里"——刻意的，因为用户的痛点是不想打开学习软件。
// 但那条只解决了「不想学的时候也能学到」，没解决「想学的时候学不了」，
// 所以有这条自助通道，共用同一套卡、同一套 SRS、同一份 c.log。
//
// 2026-09-28 按不背单词重做（用户：「把单词复习做得和不背单词那样」）：
//   · 先看词 + 例句（释义藏着），自己判 认识 / 模糊 / 不认识；
//     认识了亮释义，还能点「记错了」反悔
//   · 模糊 / 不认识的词过三张再回来，**这一组里认出来才算过**——一次没过不等于这轮结束
//   · 回来的那次改考四选一（看词选义），比再自评一次更实在
//   · 熟一点的复习词轮换考法：自评 → 四选一 → 拼写
//   · 「太简单」直接标熟，以后不再出现（刚接词书时前面一堆认识的词靠它快速划掉）
//   · 自动念、例句标亮、今日打卡
// 当天晚些时候第二轮（用户：「不背单词体系更复杂」）：
//   · 新词走「四个点」（见 studyLearnStep）：回想/四选一交替，连对 4 次才学会，错一次掉空
//   · 学会之后按艾宾浩斯节点复习（见 STUDY_LADDER），答完就告诉她下次哪天见
//   · 标熟任何时候都能点；答完露出词根词缀、笔记、另外几句例句
// 下面说的「回炉」「只吃第一次」只管**复习词**；新词每一次作答都算（那就是点）。
//
// ⚠️ SRS 只吃**每张卡这一轮的第一次**。回炉那几次是当场的巩固，不是隔天的回忆；
// 让它们也进 studySchedule 的话，一个词错一次、回炉认出来一次，就会被算成
// "不会 + 记住了"两次，间隔被推到明天之后，等于把刚错的词放跑了。
//
// 作答照旧记进 c.log（askId 以 'self' 开头），模型回填历史时能看到你自己刷过什么。
// ============================================================

var _studySession = null;
var _studyAutoSpeak = (function () {
  try { return localStorage.getItem('kuro_studyAutoSpeak') !== '0'; } catch (e) { return true; }
})();

function studyToggleAutoSpeak() {
  _studyAutoSpeak = !_studyAutoSpeak;
  try { localStorage.setItem('kuro_studyAutoSpeak', _studyAutoSpeak ? '1' : '0'); } catch (e) {}
  studyRefresh(true);
}

// 四选一的干扰项：同语言别的卡的释义；卡不够就从词书里借。凑不齐 3 个就不出选择题。
function _studyChoicePool(c) {
  const seen = new Set([_studyNorm(c.back)]);
  const out = [];
  const push = back => { const k = _studyNorm(back); if (k && !seen.has(k)) { seen.add(k); out.push(back); } };
  for (const x of studyCards()) if (x.id !== c.id && x.lang === c.lang) push(x.back);
  const book = c.lang === 'en' && state.studyBook && studyBookData(state.studyBook.id);
  if (book && out.length < 30) {
    for (let i = 0; i < 40; i++) push(book.words[Math.floor(Math.random() * book.words.length)][2]);
  }
  return out;
}

function _studyShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 学新词的四关照不背单词：回想（看词判认不认识）和四选一各两次，交替出。
// 第一关永远是回想——第一次见面谈不上考，先看词、看例句、自己判。
const STUDY_LEARN_MODES = ['recall', 'choice', 'recall', 'choice'];
function _studyLearnMode(c) {
  const m = STUDY_LEARN_MODES[Math.min(c.dots || 0, STUDY_DOTS - 1)];
  return m === 'choice' && _studyChoicePool(c).length < 3 ? 'recall' : m;   // 干扰项凑不齐就还是回想
}

// 这一张怎么考。retry = 这一轮里回炉的那次（只有复习词会回炉；新词错了是点清空、接着排）。
function _studySessMode(c, retry, prevMode) {
  if (_studyIsNew(c)) return _studyLearnMode(c);
  if (retry) {
    if (prevMode === 'spell') return 'spell';            // 拼错的词回来还是拼，拼对才算
    return _studyChoicePool(c).length >= 3 ? 'choice' : 'recall';
  }
  const r = c.reps || 0;
  if (r >= 3 && r % 3 === 0) return 'spell';
  if (r % 3 === 2 && _studyChoicePool(c).length >= 3) return 'choice';
  return 'recall';
}

// 一轮 = 到期要复习的 + 当前这一组新词，两边交替排（跟聊天里出题同一套节奏，
// 见 studyPick 上面那段）。一张都排不出来才随机抓一批提前刷——
// 想学的时候不该被"今天没到期"拦住。
function studyStartSession(scope) {
  const review = studyReviewQueue();
  const group = studyGroup();
  let ids = [];
  if (scope !== 'all') {
    let i = 0, j = 0;
    while (ids.length < 30 && (i < review.length || j < group.length)) {
      if (i < review.length) ids.push(review[i++].id);
      if (ids.length < 30 && j < group.length) ids.push(group[j++].id);
    }
  }
  const ahead = !ids.length;
  if (ahead) ids = _studyShuffle(studyCards().filter(c => !c.known)).slice(0, 20).map(c => c.id);
  if (!ids.length) { showToast('还没有卡片可以刷～选一本词书或者导一批词进来', 'info', 3000); return; }
  const learnIds = new Set(ids.filter(id => _studyIsNew(studyGet(id))));
  _studySession = {
    queue: ids.map(id => ({ id, mode: _studySessMode(studyGet(id), false), retry: false, learn: learnIds.has(id) })),
    cur: null, phase: 'ask', g: null,
    first: {},            // id → 这一轮第一次的成绩（复习词进 SRS 的就是它）
    passed: new Set(),    // 这一轮已经过关的（复习词答对 / 新词亮满 4 个点）
    known: [],            // 这一轮标熟的
    learnIds,             // 这一轮里按「四个点」学的新词
    grad: [],             // 这一轮学会的
    order: ids.slice(), ahead,
    opts: [], pick: -1, typed: '', judged: null, autoT: null,
    noteEdit: false, noteDraft: '',
  };
  // 趁这一下点击把音频解锁；整轮的发音按出场顺序排进预取
  try { const ac = _studyAudioCtx(); if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); } catch (_) {}
  studyPrefetchAudio(ids);
  // 词根词缀跟着词书走：没选词书也把书载进来查（只查不往卡库里补词）
  if (!studyBookData('gk') && ids.some(id => (studyGet(id) || {}).lang === 'en')) studyLoadBook('gk').catch(() => {});
  _studySessAdvance();
}

// 进度：复习词一张算 1，新词算 4（一个点一格）。标熟的整张算满。
function _studySessProgress(s) {
  let done = 0, total = 0;
  for (const id of s.order) {
    const c = studyGet(id);
    const w = s.learnIds.has(id) ? STUDY_DOTS : 1;
    total += w;
    if (!c || s.known.includes(id) || s.passed.has(id)) done += w;
    else if (s.learnIds.has(id)) done += Math.min(c.dots || 0, STUDY_DOTS);
  }
  return { done, total: total || 1 };
}

function studyEndSession() {
  if (_studySession) clearTimeout(_studySession.autoT);
  _studySession = null;
  studyRefresh(true);
}

// 发下一张。删掉的、这一轮里被标熟的直接跳过。
function _studySessAdvance() {
  const s = _studySession; if (!s) return;
  clearTimeout(s.autoT);
  s.cur = null;
  while (s.queue.length) {
    const q = s.queue.shift();
    const c = studyGet(q.id);
    if (!c || c.known) continue;
    if (q.learn && !_studyIsNew(c)) { s.passed.add(c.id); continue; }   // 刷到一半在聊天里学会了
    s.cur = q; break;
  }
  s.phase = 'ask'; s.g = null; s.pick = -1; s.typed = ''; s.judged = null;
  s.noteEdit = false; s.noteDraft = '';
  if (s.cur) {
    const c = studyGet(s.cur.id);
    s.opts = s.cur.mode === 'choice'
      ? _studyShuffle([c.back, ..._studyShuffle(_studyChoicePool(c)).slice(0, 3)]) : [];
    _studyExSoon(c);
    s.queue.slice(0, 2).forEach(q => _studyExSoon(studyGet(q.id)));
    if (s.cur.mode !== 'spell') _studySessSpeak(c);      // 拼写题念出来就是送答案
  }
  studyRefresh(true);
}

function _studySessCard() {
  const s = _studySession;
  return s && s.cur ? studyGet(s.cur.id) : null;
}

// ── 四种动作 ──
function studySessKnow()   { const s = _studySession; if (!s || s.phase !== 'ask') return; s.g = 2; s.phase = 'known'; studyRefresh(true); }
function studySessFuzzy()  { const s = _studySession; if (!s || s.phase !== 'ask') return; s.g = 1; s.phase = 'detail'; studyRefresh(true); }
function studySessForgot() { const s = _studySession; if (!s || s.phase !== 'ask') return; s.g = 0; s.phase = 'detail'; studyRefresh(true); }
// 「认识」之后看到释义发现不对：按不认识处理。反悔只在这一步有效，点了下一个就落定了
function studySessOops()   { const s = _studySession; if (!s || s.phase !== 'known') return; s.g = 0; s.phase = 'detail'; studyRefresh(true); }

// 四选一。i = -1 是「不知道」。选对了停一下让她看见绿色再自动翻页。
function studySessPick(i) {
  const s = _studySession; if (!s || s.phase !== 'ask' || s.cur.mode !== 'choice') return;
  const c = _studySessCard(); if (!c) return;
  s.pick = i;
  if (i >= 0 && s.opts[i] === c.back) {
    s.g = 2; s.phase = 'done';
    const cur = s.cur;
    s.autoT = setTimeout(() => { if (_studySession === s && s.cur === cur && s.phase === 'done') studySessNext(); }, 700);
  } else {
    s.g = 0; s.phase = 'detail';
  }
  studyRefresh(true);
}

function studySessSpellSubmit() {
  const s = _studySession; if (!s || s.phase !== 'ask') return;
  const inp = document.getElementById('studySessSpell');
  const typed = inp ? inp.value : s.typed;
  if (!String(typed).trim()) { showToast('先写点什么再交～', 'info', 2000); return; }
  const c = _studySessCard(); if (!c) return;
  s.judged = studySpellJudge(c, typed);
  s.typed = String(typed).trim();
  s.g = s.judged.g;
  s.phase = 'detail';
  studyRefresh(true);
  _studySessSpeak(c);                    // 交卷之后才念：这时候最想听
}

function studySessSpellGiveUp() {
  const s = _studySession; if (!s || s.phase !== 'ask') return;
  s.g = 0; s.typed = ''; s.judged = { g: 0, note: '直接看了答案' }; s.phase = 'detail';
  studyRefresh(true);
  _studySessSpeak(_studySessCard());
}

function studySessSpellKey(ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault(); ev.stopPropagation();
  studySessSpellSubmit();
}

// 落定这一张 → 下一张。
function studySessNext() {
  const s = _studySession; if (!s || !s.cur || s.phase === 'ask') return;
  const c = _studySessCard();
  const g = s.g == null ? 2 : s.g;
  if (c && s.cur.learn) {
    // 新词：每一次作答都算（这就是四个点），对了过几张再来下一关，错了点清空、过三张重来
    const grad = studyLearnStep(c, g);
    (c.log = c.log || {})['self' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)] = {
      g, ts: Date.now(), self: true, mode: s.cur.mode, learn: grad ? STUDY_DOTS : c.dots, ...(grad ? { grad: true } : {}),
    };
    if (!(c.id in s.first)) s.first[c.id] = g;
    save();
    if (grad) { s.passed.add(c.id); s.grad.push(c.id); }
    else s.queue.splice(Math.min(g === 2 ? 4 : 3, s.queue.length), 0, { id: c.id, mode: _studyLearnMode(c), retry: false, learn: true });
    _studySessAdvance();
    return;
  }
  if (c) {
    if (!s.cur.retry && !(c.id in s.first)) {
      studySchedule(c, g);
      (c.log = c.log || {})['self' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)] = {
        g, ts: Date.now(), self: true, mode: s.cur.mode,
        ...(s.cur.mode === 'spell' ? { typed: s.typed } : {}),
      };
      s.first[c.id] = g;
      save();
    }
    // 没认出来的过三张再回来（不背单词的节奏：隔得太近是短时记忆在答，太远这一轮又收不了尾）
    if (g < 2) s.queue.splice(Math.min(3, s.queue.length), 0, { id: c.id, mode: _studySessMode(c, true, s.cur.mode), retry: true });
    else s.passed.add(c.id);
  }
  _studySessAdvance();
}

// 太简单：标熟，这一轮和以后都不再出。不进 SRS——没考过，谈不上答对。
function studySessTooEasy() {
  const s = _studySession; if (!s || !s.cur) return;
  const c = _studySessCard(); if (!c) return;
  c.known = Date.now();
  save();
  _studyChatRedraw(c.id);
  if (!s.known.includes(c.id)) s.known.push(c.id);
  s.queue = s.queue.filter(q => q.id !== c.id);
  _studySessAdvance();
}

function studySessReplay(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const c = _studySessCard(); if (!c) return;
  const s = _studySession;
  if (s.cur.mode === 'spell' && s.phase === 'ask') return;
  studySpeak(c.id, ev);
}

// 自动念：失败静默（手机没连电脑就是念不了，每张卡弹一次提示会烦死人）
// 整个包在 try 里：它挂在翻页路径上，发音出任何岔子都不许把刷用户住。
function _studySessSpeak(c) {
  if (!_studyAutoSpeak || !c) return;
  try {
    if (typeof fetch !== 'function') return;
    if (!SERVER_BASE && typeof location !== 'undefined' && location.protocol === 'file:') return;
    _studyStopAudio();
    _studyAudioGet(c, 'front').then(a => {
      const s = _studySession;
      if (!s || !s.cur || s.cur.id !== c.id) return;       // 念到的时候已经翻页了，别串台
      return _studyPlayClip(a);
    }).catch(() => {});
  } catch (_) {}
}

// ── 例句（Tatoeba，后端 /api/example）──
// 一个词给好几句（用户：「一个词可以有好几个例句」）：c.ex 是主例句（题面上那句），
// c.exMore 是句库里另外挑的一两句，答完才一起摊开。
// 主例句只在**没有**的时候拿句库的补：她自己写的、AI 教词时带的例句是挑过的，不拿句库的去顶；
// 但另外那几句照样补上。
// 查成了才记 exV（句库里确实没有也算查成）；没连上后端不记，下次还能再试。
// exV = 2 是「按多句接口查过了」；只查过一句的老卡（有 exTried 没 exV）会再查一次把另外几句补上。
var _studyExInflight = new Set();
function _studyExKey(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function _studyExSoon(c) {
  if (c && c.exV >= 1) _studyZhSoon(c);       // 查过了，但可能还有没中文的句子
  if (!c || c.exV >= 1 || _studyExInflight.has(c.id)) return;
  if (typeof fetch !== 'function') return;
  if (!SERVER_BASE && typeof location !== 'undefined' && location.protocol === 'file:') return;
  _studyExInflight.add(c.id);
  fetch(`${SERVER_BASE}/api/example?lang=${encodeURIComponent(c.lang)}&word=${encodeURIComponent(c.front)}`)
    .then(r => r.json())
    .then(j => {
      if (!j || !j.ok) return;
      c.exTried = Date.now();
      const list = Array.isArray(j.list) ? j.list.filter(x => x && x.ex) : (j.ex ? [{ ex: j.ex, zh: j.zh || '' }] : []);
      c.exV = Array.isArray(j.list) ? 2 : 1;       // 1 = 老后端只给一句；下次换了新后端也不会再查，够用
      if (!c.ex && list[0]) { c.ex = list[0].ex; c.exZh = list[0].zh || ''; }
      const more = list.filter(x => _studyExKey(x.ex) !== _studyExKey(c.ex)).slice(0, 2).map(x => ({ ex: x.ex, zh: x.zh || '' }));
      if (more.length) c.exMore = more; else delete c.exMore;
      save();
      _studyExRedraw(c);
      _studyZhSoon(c);
    })
    .catch(() => {})
    .finally(() => _studyExInflight.delete(c.id));
}

// 例句换了内容之后重画：正在刷的这张、列表里展开着的这行、聊天里答完的这张卡。
// 正在拼写、正在写笔记、正在改例句就别重画刷卡界面/列表：会把她打了一半的字连同焦点一起冲掉
// （拼写题本来也不显示例句）。
function _studyExRedraw(c) {
  const s = _studySession;
  if (s && s.cur && s.cur.id === c.id && !(s.cur.mode === 'spell' && s.phase === 'ask') && !s.noteEdit) studyRefresh(true);
  else if (!s && _studyOpenRows.has(c.id) && !_studyExEditing && !_studyNoteEditing) studyRefresh(true);
  _studyChatRedraw(c.id);
}

// ── 例句的中文（用户：「能不能给所有句子加中文翻译」）──
// 句库只有一部分句子配了人工中文，她自己写的、AI 教词时带的句子一句中文都没有。
// 缺中文的句子交给后端 /api/sentence-zh：整本词书的句子已经预先翻好在缓存里，秒回；
// 零散的交给电脑上的本地模型现翻。电脑没开 / 本地模型没开就先空着，
// 这次打开 App 不再问（_studyZhGaveUp），下次打开再试 —— 不能每翻一张卡都去撞一次墙。
// 译文跟着句子走：句子被改了（studyExSave 清掉 exZh），自然又会变成「缺中文」。
var _studyZhInflight = new Set(), _studyZhGaveUp = new Set();
function _studyZhGaps(c) {
  const out = [];
  if (c.ex && !c.exZh) out.push({ text: c.ex, set: zh => { c.exZh = zh; } });
  (c.exMore || []).forEach(x => { if (x && x.ex && !x.zh) out.push({ text: x.ex, set: zh => { x.zh = zh; } }); });
  return out.filter(g => !_studyZhGaveUp.has(c.lang + ':' + g.text));
}
function _studyZhSoon(c) {
  if (!c || _studyZhInflight.has(c.id) || typeof fetch !== 'function') return;
  if (!SERVER_BASE && typeof location !== 'undefined' && location.protocol === 'file:') return;
  const gaps = _studyZhGaps(c);
  if (!gaps.length) return;
  _studyZhInflight.add(c.id);
  const texts = gaps.map(g => g.text);
  fetch(`${SERVER_BASE}/api/sentence-zh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: c.lang, texts }),
  })
    .then(r => r.json())
    .then(j => {
      const zh = (j && j.ok && Array.isArray(j.zh)) ? j.zh : [];
      let got = 0;
      gaps.forEach((g, i) => {
        // 翻回来之前句子被她改掉了：这句译文已经不属于任何句子，扔掉
        const still = _studyZhGaps(c).some(x => x.text === g.text);
        if (zh[i] && still) { g.set(String(zh[i])); got++; }
        else if (!zh[i]) _studyZhGaveUp.add(c.lang + ':' + g.text);
      });
      if (got) { save(); _studyExRedraw(c); }
    })
    .catch(() => texts.forEach(t => _studyZhGaveUp.add(c.lang + ':' + t)))
    .finally(() => _studyZhInflight.delete(c.id));
}

// 例句里把这个词标亮。带词尾的变形也算（borrow → borrowed / borrowing），
// 德语卡先剥冠词（der Tisch → Tisch）。
function _studyExHtml(c, text) {
  const ex = String(text != null ? text : (c.ex || ''));
  const form = String(c.front || '').replace(STUDY_ART, '').replace(/[!！?？.。,，;；:：]+$/, '').trim();
  if (!form) return escHtml(ex);
  const re = new RegExp('(^|[^\\p{L}])(' + form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\p{L}*)', 'giu');
  let out = '', last = 0, m;
  while ((m = re.exec(ex))) {
    const at = m.index + m[1].length;
    out += escHtml(ex.slice(last, at)) + '<b class="bb-hl">' + escHtml(m[2]) + '</b>';
    last = at + m[2].length;
  }
  return out + escHtml(ex.slice(last));
}

// ── 词根词缀 ──
// 数据在词书里（engra，MIT，由 ECDICT 的建书脚本合进 gk.js 每项的第 4 格）。
// **不存进卡片**，按词从载入的词书里现查：书重新生成了卡片跟着变，state 也不用多背一坨；
// 她自己导入的英语词，只要书里有同一个词也查得到。
var _studyRootIdx = {};
function _studyRootsOf(c) {
  if (!c || c.lang !== 'en') return null;
  const w = String(c.front || '').trim().toLowerCase();
  for (const id in STUDY_BOOKS) {
    const b = studyBookData(id); if (!b) continue;
    let idx = _studyRootIdx[id];
    if (!idx || idx.src !== b.words || idx.n !== b.words.length) {
      idx = _studyRootIdx[id] = { src: b.words, n: b.words.length, map: new Map() };
      for (const x of b.words) if (x[3]) idx.map.set(String(x[0]).toLowerCase(), x[3]);
    }
    const r = idx.map.get(w);
    if (r) return r;
  }
  return null;
}

// 拆解 > 由哪个词变来；借来的祖先拆解（important 借 import 的）另起一行；词根做成小标签；同根词垫底。
function _studyRootsHtml(c) {
  const r = _studyRootsOf(c); if (!r) return '';
  let h = '<div class="bb-roots">';
  if (r.r && r.rm) h += `<span class="bb-root-chip">${escHtml(r.r)}<i>${escHtml(r.rm)}</i></span>`;
  if (r.m) h += `<div class="bb-root-line">${escHtml(r.m)}</div>`;
  else if (r.p) {
    // 前缀（un- / to-）写在前面，后缀（-ment）写在后面：to- + day，govern + -ment
    const base = escHtml(r.p) + (r.pt ? `（${escHtml(r.pt)}）` : '');
    const a = r.a ? escHtml(r.a) : '';
    h += `<div class="bb-root-line">${!a ? base + ' 变来' : a.startsWith('-') ? base + ' + ' + a : a + ' + ' + base}</div>`;
  }
  if (r.pw && r.pm) h += `<div class="bb-root-line bb-root-from"><b>${escHtml(r.pw)}</b>：${escHtml(r.pm)}</div>`;
  if (r.f && r.f.length) h += `<div class="bb-root-fam">同根：${r.f.map(escHtml).join(' · ')}</div>`;
  return h + '</div>';
}

// ── 四个点 / 复习节点 ──
// anim：'gain' 刚亮的那个点弹一下，'lose' 整排抖一下（掉空了）
function _studyDotsHtml(n, anim) {
  let h = `<span class="bb-dots${anim === 'lose' ? ' lose' : ''}" title="连着答对 ${STUDY_DOTS} 次就学会了">`;
  for (let i = 0; i < STUDY_DOTS; i++) h += `<i class="${i < n ? 'on' : ''}${anim === 'gain' && i === n - 1 ? ' pop' : ''}"></i>`;
  return h + '</span>';
}

function _studyLadderLabel(d) { return d < 30 ? d + '天' : (d / 30) + '个月'; }

// 这个词在遗忘曲线上走到哪了：走过的节点实心，正在等的那个高亮
function _studyCurveHtml(c) {
  if (!c || c.known) return '';
  if (_studyIsNew(c)) return `<div class="bb-curve-row">${_studyDotsHtml(c.dots || 0)}<span class="study-dim">${_studyLearning(c) ? '学习中' : '还没学'}</span></div>`;
  const step = _studyStep(c);
  let h = '<div class="bb-curve" title="艾宾浩斯复习节点：认识往后走一格，模糊退一格，不认识回起点">';
  STUDY_LADDER.forEach((d, i) => { h += `<i class="${i < step ? 'done' : i === step ? 'cur' : ''}">${_studyLadderLabel(d)}</i>`; });
  return h + '</div>';
}

// 这张答完、落定之前，先告诉她「下次什么时候见」。只读，不动卡（真落定在 studySessNext）。
function _studyPreviewNext(c, g, learn) {
  if (learn) return g === 2 && (c.dots || 0) + 1 >= STUDY_DOTS ? '学会了！明天第一次复习' : '';
  const n = _studyNextSched(c, g);
  if (!n.ivl) return '10 分钟后再来一次';
  return n.ivl === 1 ? '明天再见' : `${_studyLadderLabel(n.ivl)}后再见`;
}

// ── 笔记 ──
// 写在词旁边的自己的话（用户：「词旁边可以写笔记的」）。刷卡时答完才露出来——
// 笔记里多半写着意思，答前露就是送答案。列表里点开一行也能写。
function _studySetNote(c, v) {
  v = String(v || '').trim().slice(0, 2000);
  if (v) c.note = v; else delete c.note;
  save();
}
function studySessNoteEdit() {
  const s = _studySession, c = _studySessCard(); if (!s || !c) return;
  clearTimeout(s.autoT);                 // 选对了正在倒数自动翻页的，别翻走
  s.noteEdit = true; s.noteDraft = c.note || '';
  studyRefresh(true);
}
function studySessNoteSave() {
  const s = _studySession, c = _studySessCard(); if (!s || !c) return;
  const ta = document.getElementById('studySessNote');
  _studySetNote(c, ta ? ta.value : s.noteDraft);
  s.noteEdit = false; s.noteDraft = '';
  studyRefresh(true);
  _studyChatRedraw(c.id);
}
function studySessNoteCancel() {
  const s = _studySession; if (!s) return;
  s.noteEdit = false; s.noteDraft = '';
  studyRefresh(true);
}
// Ctrl+Enter 存，Esc 取消。Esc 要拦住：不拦会冒泡到文档上把整个学习面板关掉
function studyNoteKey(ev, save_, cancel) {
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
  else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); save_(); }
}

// 刷卡界面里的快捷键。输入框里不拦（拼写题要打字），带修饰键的不拦（别吃掉 Ctrl+C）。
document.addEventListener('keydown', function (e) {
  const s = _studySession;
  if (!s || !s.cur) return;
  const m = document.getElementById('studyModal');
  if (!m || m.classList.contains('hidden')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  let hit = true;
  if (k === ' ') studySessReplay();
  else if (s.phase === 'ask' && s.cur.mode === 'recall') {
    if (k === '1' || k === 'ArrowLeft') studySessForgot();
    else if (k === '2' || k === 'ArrowDown') studySessFuzzy();
    else if (k === '3' || k === 'ArrowRight') studySessKnow();
    else hit = false;
  } else if (s.phase === 'ask' && s.cur.mode === 'choice') {
    const i = '1234'.indexOf(k);
    if (i >= 0 && i < s.opts.length) studySessPick(i);
    else if (k === '0') studySessPick(-1);
    else hit = false;
  } else if (s.phase !== 'ask') {
    if (k === 'Enter' || k === 'ArrowRight') studySessNext();
    else if (k === 'ArrowLeft' && s.phase === 'known') studySessOops();
    else hit = false;
  } else hit = false;
  if (hit) e.preventDefault();   // Enter 落在按钮上时，不拦的话按钮还会再被点一次
});

// ── 刷卡界面 ──
function _studySessionHtml() {
  const s = _studySession;
  if (!s.cur) return _studySessSummaryHtml();

  const c = _studySessCard();
  const mode = s.cur.mode, ph = s.phase;
  const asking = ph === 'ask';
  const learn = !!s.cur.learn;
  const g = s.g == null ? 2 : s.g;
  const prog = _studySessProgress(s);
  const tag = learn ? '新词' : s.cur.retry ? '再认一次' : '复习';
  const lang = c.lang === 'de' ? '德语' : '英语';     // 不用国旗：Windows 没有国旗 emoji，只会显示成「GB」两个字母
  const hard = (c.lapses || 0) + (c.slips || 0) >= 3;  // 错过好几回的：标个「易忘」
  // 四个点：答题时是现在的样子；答完先按这次的结果预演（亮一个 / 掉空），点「下一个」才真的落定
  let dotsHtml = '';
  if (learn) {
    const now = c.dots || 0;
    dotsHtml = asking ? _studyDotsHtml(now)
      : g === 2 ? _studyDotsHtml(Math.min(now + 1, STUDY_DOTS), 'gain') : _studyDotsHtml(0, now ? 'lose' : '');
  }

  let h = `<div class="bb-sess">
    <div class="bb-top">
      <button class="bb-quit" onclick="studyEndSession()" title="退出（进度已经存了）">✕</button>
      <div class="bb-bar"><i style="width:${Math.round(prog.done / prog.total * 100)}%"></i></div>
      <span class="bb-count" title="新词亮一个点算一格，复习词答对算一格">${prog.done}/${prog.total}</span>
      <button class="bb-auto${_studyAutoSpeak ? ' on' : ''}" onclick="studyToggleAutoSpeak()" title="翻到新词时自动念">${_studyAutoSpeak ? '🔊' : '🔇'}</button>
    </div>
    <div class="bb-card bb-${mode} bb-ph-${ph}">
      <div class="bb-tag">${lang} · ${tag}${mode === 'choice' ? ' · 选意思' : mode === 'spell' ? ' · 拼写' : ''}${hard ? ' · <b class="bb-hard">易忘</b>' : ''}${dotsHtml}</div>`;

  // 词面。拼写题反过来：题面是中文，答完才亮出词。
  if (mode === 'spell' && asking) {
    h += `<div class="bb-word bb-word-zh">${escHtml(c.back)}</div>`;
  } else {
    h += `<div class="bb-word">${escHtml(c.front)}</div>
      <div class="bb-ipa">${c.ipa ? escHtml(c.ipa) : ''}<button class="bb-say" onclick="studySessReplay(event)" title="再念一遍（空格）">🔊</button></div>`;
  }

  // 释义（答完才出），紧跟在词下面——翻过来第一眼要看到的是意思，不是例句。
  // 选择题的释义已经在选项里标绿了，不再重复。
  if (!asking && mode !== 'choice') h += `<div class="bb-mean">${escHtml(c.back)}</div>`;

  // 例句：题面上就给（这是不背单词的「语境」），翻译答完才给。拼写题答前不给——例句里就是答案。
  // 另外那几句（c.exMore）答完才摊开：题面上一句语境够了，多了就是在帮她猜。
  if (c.ex && !(mode === 'spell' && asking)) {
    h += `<div class="bb-ex"><div class="bb-ex-en">${_studyExHtml(c)}<button class="bb-say" onclick="studySpeak('${c.id}',event,'example')" title="念例句">🔊</button></div>
      ${!asking && c.exZh ? `<div class="bb-ex-zh">${escHtml(c.exZh)}</div>` : ''}</div>`;
    if (!asking) (c.exMore || []).forEach((x, i) => {
      h += `<div class="bb-ex bb-ex-more"><div class="bb-ex-en">${_studyExHtml(c, x.ex)}<button class="bb-say" onclick="studySpeak('${c.id}',event,'ex${i}')" title="念例句">🔊</button></div>
        ${x.zh ? `<div class="bb-ex-zh">${escHtml(x.zh)}</div>` : ''}</div>`;
    });
  }

  // 答完：词根词缀 + 笔记（答前露出来都等于送答案）
  if (!asking) {
    h += _studyRootsHtml(c);
    if (s.noteEdit) {
      h += `<div class="bb-note bb-note-edit">
        <textarea id="studySessNote" class="study-ex-in" spellcheck="false" placeholder="写点自己的记法：谐音、联想、容易混的词…（Ctrl+Enter 存）"
          oninput="_studySession && (_studySession.noteDraft = this.value)"
          onkeydown="studyNoteKey(event, studySessNoteSave, studySessNoteCancel)">${escHtml(s.noteDraft)}</textarea>
        <div class="study-ex-row"><button class="study-ex-save" onclick="studySessNoteSave()">保存</button><button class="study-ex-cancel" onclick="studySessNoteCancel()">取消</button></div>
      </div>`;
    } else if (c.note) {
      h += `<div class="bb-note" onclick="studySessNoteEdit()" title="点一下改笔记"><span>📝</span>${escHtml(c.note)}</div>`;
    } else {
      h += `<button class="bb-link bb-note-add" onclick="studySessNoteEdit()">📝 写笔记</button>`;
    }
  }

  if (mode === 'choice' && (asking || ph === 'done' || ph === 'detail')) {
    h += `<div class="bb-opts">`;
    s.opts.forEach((o, i) => {
      let cls = '';
      if (!asking) {
        if (o === c.back) cls = ' right';
        else if (i === s.pick) cls = ' wrong';
      }
      h += `<button class="bb-opt${cls}" onclick="studySessPick(${i})"${asking ? '' : ' disabled'}><i>${i + 1}</i>${escHtml(o)}</button>`;
    });
    h += `</div>`;
    if (asking) h += `<button class="bb-link" onclick="studySessPick(-1)">不知道（0）</button>`;
  }

  if (mode === 'spell' && asking) {
    h += `<div class="bb-spell">
      <input class="study-spell-in" id="studySessSpell" type="text" value="${escHtml(s.typed)}"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        placeholder="${c.lang === 'de' ? '连 der/die/das 一起写' : '把这个词拼出来'}"
        oninput="_studySession && (_studySession.typed = this.value)"
        onkeydown="studySessSpellKey(event)">
      <button class="bb-go" onclick="studySessSpellSubmit()">交卷</button>
    </div>
    <button class="bb-link" onclick="studySessSpellGiveUp()">想不起来，看答案</button>`;
  }

  if (mode === 'spell' && !asking && s.typed && _studyNorm(s.typed) !== _studyNorm(c.front)) {
    h += `<div class="bb-typed">你写的：<s>${escHtml(s.typed)}</s>${s.judged && s.judged.note ? '　' + escHtml(s.judged.note) : ''}</div>`;
  } else if (mode === 'spell' && !asking && s.judged && s.judged.note) {
    h += `<div class="bb-typed">${escHtml(s.judged.note)}</div>`;
  }
  if (!asking) {
    // 答完告诉她这个词接下来的去向：新词看点，复习词看遗忘曲线
    let fate = '';
    if (learn) fate = g === 2 ? (_studyPreviewNext(c, g, true) || `还差 ${STUDY_DOTS - Math.min((c.dots || 0) + 1, STUDY_DOTS)} 个点`) : '点掉空了，过几张从头再来';
    else if (s.cur.retry) fate = g === 2 ? '这回认出来了' : '过几张再考你一次';
    else fate = _studyPreviewNext(c, g, false) + (g < 2 ? '，这一轮过几张还会再考' : '');
    h += `<div class="bb-again${g === 2 ? ' ok' : ''}">${escHtml(fate)}</div>`;
  }
  h += `</div>`;

  // 底部按钮
  if (asking && mode === 'recall') {
    h += `<div class="bb-acts">
      <button class="bb-btn bb-no" onclick="studySessForgot()">不认识<small>1 / ←</small></button>
      <button class="bb-btn bb-meh" onclick="studySessFuzzy()">模糊<small>2 / ↓</small></button>
      <button class="bb-btn bb-yes" onclick="studySessKnow()">认识<small>3 / →</small></button>
    </div>`;
  } else if (!asking) {
    h += `<div class="bb-acts">
      ${ph === 'known' ? `<button class="bb-btn bb-oops" onclick="studySessOops()">记错了<small>←</small></button>` : ''}
      <button class="bb-btn bb-next" onclick="studySessNext()">下一个<small>Enter / →</small></button>
    </div>`;
  }
  // 标熟随时能点（用户：「词是可以随时标熟的」），答完发现这词其实很熟也来得及
  h += `<button class="bb-easy" onclick="studySessTooEasy()" title="标熟：以后不再出现，列表里可以取消">✓ 标熟，不用再背</button>`;
  return h + `</div>`;
}

function _studySessSummaryHtml() {
  const s = _studySession;
  const cnt = [0, 0, 0];
  for (const id in s.first) cnt[s.first[id]]++;
  const st = studyDayStats();
  const icon = id => s.known.includes(id) ? ['bb-s-easy', '已标熟']
    : s.grad.includes(id) ? ['bb-s-yes', '学会了']
    : ({ 2: ['bb-s-yes', '认识'], 1: ['bb-s-meh', '模糊'], 0: ['bb-s-no', '不认识'] })[s.first[id]] || ['', ''];
  let rows = '';
  for (const id of s.order) {
    const c = studyGet(id); if (!c) continue;
    const [cls, txt] = icon(id);
    rows += `<div class="bb-s-row"><span class="bb-s-tag ${cls}">${txt}</span><b>${escHtml(c.front)}</b><span>${escHtml(c.back)}</span></div>`;
  }
  const nReview = s.order.length - s.learnIds.size;
  const parts = [];
  if (s.learnIds.size) parts.push(`新词学会 ${s.grad.length}`);
  if (nReview) parts.push(`复习 ${nReview}（第一次就认出 ${s.order.filter(id => !s.learnIds.has(id) && s.first[id] === 2).length}）`);
  if (s.known.length) parts.push(`标熟 ${s.known.length}`);
  return `<div class="bb-sess bb-sum">
    <div class="bb-sum-big">这一组刷完了</div>
    <div class="bb-sum-line">${parts.join(' · ') || `认识 ${cnt[2]} · 模糊 ${cnt[1]} · 不认识 ${cnt[0]}`}</div>
    <div class="bb-streak">🔥 连续打卡 <b>${st.streak}</b> 天　今天新学 ${st.learned} · 复习 ${st.reviewed}</div>
    <div class="bb-s-list">${rows}</div>
    <div class="bb-acts">
      <button class="bb-btn bb-meh" onclick="studyEndSession()">回去</button>
      <button class="bb-btn bb-next" onclick="studyStartSession('due')">再来一组</button>
    </div>
  </div>`;
}

// 首页顶上那块「今日」：今天学了多少、连续几天、最近两周哪天刷过
function _studyTodayHtml() {
  const st = studyDayStats();
  const midway = studyCards().filter(_studyLearning).length;
  const dots = st.recent.map((on, i) => `<i class="${on ? 'on' : ''}${i === 13 ? ' today' : ''}"></i>`).join('');
  return `<div class="bb-today">
    <div class="bb-today-nums">
      <div><b>${st.learned}</b><span>今日新学</span></div>
      <div><b>${st.reviewed}</b><span>今日复习</span></div>
      <div><b>${st.streak}</b><span>连续打卡</span></div>
    </div>
    <div class="bb-days" title="最近两周（最右边是今天）">${dots}</div>
    ${midway ? `<div class="study-dim bb-today-hint">还有 ${midway} 个词学到一半（没亮满 ${STUDY_DOTS} 个点），接着刷就行</div>` : ''}
    ${st.doneToday ? '' : '<div class="study-dim bb-today-hint">今天还没刷，刷一张就算打卡</div>'}
  </div>`;
}

function _studyBookRowHtml() {
  const sel = state.studyBook;
  const b = sel && studyBookData(sel.id);
  const opts = [`<option value="">不用词书</option>`]
    .concat(Object.entries(STUDY_BOOKS).map(([id, m]) => `<option value="${id}"${sel && sel.id === id ? ' selected' : ''}>${escHtml(m.name)}</option>`));
  let note = '选一本，新词会一组一组自己排进来';
  if (sel && b) note = `已取 ${Math.min(sel.pos, b.words.length)} / ${b.words.length} 个词，常用的在前`;
  else if (sel) note = '词书载入中…';
  return `<div class="study-group-row study-book-row">
    <span class="study-dim">📚 词书</span>
    <select class="study-group-sel" onchange="studySetBook(this.value)">${opts.join('')}</select>
    <span class="study-dim">${note}</span>
  </div>`;
}

function studyUnknow(id) {
  const c = studyGet(id); if (!c) return;
  delete c.known;
  save();
  studyRefresh(true);
  _studyChatRedraw(id);           // 聊天里这个词的卡片也跟着变回来
  showToast(`「${c.front}」取消标熟，会重新排进来`, 'success', 2500);
}

function studyMarkKnown(id) {
  const c = studyGet(id); if (!c) return;
  c.known = Date.now();
  save();
  studyRefresh(true);
  _studyChatRedraw(id);
}

// ── 全部重来（用户：「所有词全标成没学过」）──
// 只清进度：点、节点、间隔、标熟、答错次数。例句、中文、笔记、音标都留着——那些是她攒的东西，不是进度。
// **c.log 不删**：聊天记录里的旧题靠 c.log[askId] 判「答过没有」，删了那些卡会全变回没答，
// 还会被 _studyHasOpenAsk 当成悬着的题，把 AI 自动出题永久堵住。打卡天数也是从 log 算的，删了连续天数就没了。
// 改成记一个 c.resetAt：今日新学 / 复习的归类只看它之后的作答（studyDayStats），打卡照旧算。
function studyResetAll(now = Date.now()) {
  let n = 0;
  for (const c of studyCards()) {
    if (c.reps > 0 || c.known || typeof c.dots === 'number' || c.ivl > 0) n++;
    delete c.dots; delete c.known; delete c.step; delete c.slips;
    c.reps = 0; c.lapses = 0; c.ivl = 0; c.ease = 2.5; c.last = 0; c.due = now;
    c.resetAt = now;
  }
  state.studyGroupIds = [];        // 旧的一组按新状态重挑
  _studySession = null;
  return n;
}
function studyResetAllAsk() {
  const total = studyCards().length;
  if (!total) return;
  if (!confirm(`把全部 ${total} 个词都标成没学过？\n\n四个点、复习节点、标熟都会清掉，从头学。\n例句、中文、笔记会留着。`)) return;
  const n = studyResetAll();
  save();
  studyRefresh(true);
  showToast(`已经全部标成没学过（原来有进度的 ${n} 个）`, 'success', 3500);
}

// ── 列表里的例句 ──
// 例句一直存在卡里（AI 建卡时就带），但列表只画了正反面，所以用户在面板里
// 一直看不到——想复习一句怎么用，只能等它在聊天里再出一次题。
// 点一行就展开：例句 + 释义（手机上那一列被 CSS 藏了，展开是唯一看得到的地方）。
// 纯运行时状态，不进存储：关掉面板重开又都收起来，这是对的。
var _studyOpenRows = new Set();
var _studyExEditing = null;      // 正在改例句的卡片 id
var _studyExDraft = '';          // 改到一半的文本，重画时救回来（AI 建卡会随时触发重画）

function studyToggleRow(id) {
  if (_studyOpenRows.has(id)) { _studyOpenRows.delete(id); if (_studyExEditing === id) _studyExEditing = null; }
  else { _studyOpenRows.add(id); _studyExSoon(studyGet(id)); }   // 展开才去补例句和中文
  studyRefresh(true);
}

function _studyExBox(c) {
  if (_studyExEditing === c.id) {
    return `<div class="study-ex-box">
      <textarea class="study-ex-in" id="studyExIn_${c.id}" spellcheck="false"
        placeholder="写一句用得上这个词的话"
        oninput="_studyExDraft=this.value">${escHtml(_studyExDraft)}</textarea>
      <div class="study-ex-row">
        <button class="study-ex-save" onclick="studyExSave('${c.id}')">保存</button>
        <button class="study-ex-cancel" onclick="studyExCancel()">取消</button>
      </div>
    </div>`;
  }
  const more = (c.exMore || []).map((x, i) => `<div class="study-ex-more">
      <div class="study-ex-text">${escHtml(x.ex)}<button class="study-ex-x" onclick="studyExMoreSpeak('${c.id}',${i},event)" title="念这句">🔊</button><button class="study-ex-x" onclick="studyExMoreDel('${c.id}',${i})" title="这句不好，删掉">✕</button></div>
      ${x.zh ? `<div class="study-ex-none">${escHtml(x.zh)}</div>` : ''}</div>`).join('');
  const note = _studyNoteEditing === c.id
    ? `<div class="study-note-box">
        <textarea class="study-ex-in" id="studyNoteIn_${c.id}" spellcheck="false" placeholder="写点自己的记法：谐音、联想、容易混的词…（Ctrl+Enter 存）"
          oninput="_studyNoteDraft=this.value" onkeydown="studyNoteKey(event, () => studyNoteSave('${c.id}'), studyNoteCancel)">${escHtml(_studyNoteDraft)}</textarea>
        <div class="study-ex-row"><button class="study-ex-save" onclick="studyNoteSave('${c.id}')">保存</button><button class="study-ex-cancel" onclick="studyNoteCancel()">取消</button></div>
      </div>`
    : c.note ? `<div class="study-note" onclick="studyNoteEdit('${c.id}')" title="点一下改笔记">📝 ${escHtml(c.note)}</div>` : '';
  return `<div class="study-ex-box">
    <div class="study-ex-meaning">${escHtml(c.back)}</div>
    ${_studyCurveHtml(c)}
    ${c.ex
      ? `<div class="study-ex-text">${escHtml(c.ex)}</div>${c.exZh ? `<div class="study-ex-none">${escHtml(c.exZh)}</div>` : ''}`
      : `<div class="study-ex-none">还没有例句</div>`}
    ${more}
    ${_studyRootsHtml(c)}
    ${note}
    <div class="study-ex-row">
      ${_studyNoteEditing === c.id ? '' : `<button class="study-ex-edit" onclick="studyNoteEdit('${c.id}')">📝 ${c.note ? '改笔记' : '写笔记'}</button>`}
      <button class="study-ex-edit" onclick="studyExEdit('${c.id}')">✎ ${c.ex ? '改例句' : '加例句'}</button>
      <button class="study-ex-edit" onclick="studySpeak('${c.id}',event,'front')">🔊 念单词</button>
      ${c.ex ? `<button class="study-ex-edit" onclick="studySpeak('${c.id}',event,'example')">🔊 念例句</button>` : ''}
      ${c.known ? `<button class="study-ex-edit" onclick="studyUnknow('${c.id}')">↺ 取消标熟</button>`
                : `<button class="study-ex-edit" onclick="studyMarkKnown('${c.id}')">✓ 标熟</button>`}
      <span class="study-dim">${c.known ? '已标熟，不再出现' : `${(c.reps || 0)} 次 · ${escHtml(_studyDueText(c))}`}</span>
    </div>
  </div>`;
}

function studyExEdit(id) {
  const c = studyGet(id); if (!c) return;
  _studyExEditing = id;
  _studyExDraft = c.ex || '';
  studyRefresh(true);
  const ta = document.getElementById('studyExIn_' + id);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function studyExCancel() { _studyExEditing = null; _studyExDraft = ''; studyRefresh(true); }

// 句库配的另外几句，配歪了的（Tatoeba 偶尔会给 government 配「打倒政府」）可以单独删
function studyExMoreDel(id, i) {
  const c = studyGet(id); if (!c || !Array.isArray(c.exMore)) return;
  c.exMore.splice(i, 1);
  if (!c.exMore.length) delete c.exMore;
  save();
  studyRefresh(true);
}
function studyExMoreSpeak(id, i, ev) { studySpeak(id, ev, 'ex' + i); }

// 列表里的笔记：和改例句同一个套路（草稿存在变量里，重画时救回来）
var _studyNoteEditing = null, _studyNoteDraft = '';
function studyNoteEdit(id) {
  const c = studyGet(id); if (!c) return;
  _studyNoteEditing = id; _studyNoteDraft = c.note || '';
  _studyOpenRows.add(id);
  studyRefresh(true);
  const ta = document.getElementById('studyNoteIn_' + id);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function studyNoteCancel() { _studyNoteEditing = null; _studyNoteDraft = ''; studyRefresh(true); }
function studyNoteSave(id) {
  const c = studyGet(id); if (!c) return;
  const ta = document.getElementById('studyNoteIn_' + id);
  _studySetNote(c, ta ? ta.value : _studyNoteDraft);
  _studyNoteEditing = null; _studyNoteDraft = '';
  studyRefresh(true);
  _studyChatRedraw(id);
}

// 只动 ex 字段，不碰 SRS 的任何数值：改一句例句不该把复习进度也搅了
function studyExSave(id) {
  const c = studyGet(id); if (!c) return;
  const ta = document.getElementById('studyExIn_' + id);
  const ex = String(ta ? ta.value : _studyExDraft).trim();
  if (ex !== c.ex) c.exZh = '';     // 句库配的翻译是跟原句走的，句子换了翻译就不对了
  c.ex = ex;
  save();
  _studyExEditing = null; _studyExDraft = '';
  studyRefresh(true);
  _studyZhSoon(c);                  // 她自己写的句子也配上中文
  // 聊天里正开着的这张卡也跟着换掉例句（答完的卡才显示例句，没答的不受影响）
  _studyChatRedraw(id);
  showToast('例句已保存', 'success', 2000);
}

function studyRefresh(force) {
  const m = document.getElementById('studyModal');
  const body = document.getElementById('studyBody');
  try { studyEntryBadge(); } catch (e) { console.warn('[单词卡] 入口角标没画上:', e); }   // 面板关着也要更新
  if (!body || !m) return;
  if (m.classList.contains('hidden') && !force) return;   // 没开着就不白跑一趟渲染

  const t = document.getElementById('studyToggle'); if (t) t.checked = studyEnabled();

  // 正在自己刷单词：整个面板让给刷卡界面（导入框、列表、自习室装饰这时候都是干扰）
  m.classList[_studySession ? 'add' : 'remove']('study-in-sess');
  if (_studySession) {
    body.innerHTML = _studySessionHtml();
    const s = _studySession;
    studyPrefetchAudio([s.cur && s.cur.id, ...s.queue.slice(0, 2).map(q => q.id)], true);   // 这张 + 后两张插队
    const si = document.getElementById('studySessSpell');
    if (si) si.focus();
    const ni = document.getElementById('studySessNote');
    if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
    return;
  }

  // 重画前先把还没导完的词库抢救出来——聊天里 AI 建一张卡就会调到这里，
  // 正在粘词库的人不该被顺手清空
  const _prevTa = document.getElementById('studyImportText');
  const keepText = _prevTa ? _prevTa.value : '';

  const cards = studyCards();
  const review = studyReviewQueue();
  const group = studyGroup();
  const learned = cards.filter(c => c.ivl >= 3).length;
  const newLeft = cards.filter(_studyIsNew).length;

  // "待复习"只数**学过的**到期卡。原来这里数的是 studyDue()，把几百张还没学的
  // 新卡也算进去，于是导完词库这个数字就是个吓人的 300 且几天都不会掉。
  let h = (cards.length || state.studyBook ? _studyTodayHtml() : '') + `<div class="study-stats">
    <div class="study-stat"><b>${cards.length}</b><span>总卡片</span></div>
    <div class="study-stat"><b>${review.length}</b><span>待复习</span></div>
    <div class="study-stat"><b>${group.length}</b><span>本组新词</span></div>
    <div class="study-stat"><b>${learned}</b><span>记牢了</span></div>
  </div>`;

  const todo = review.length + group.length;
  if (cards.length) {
    h += `<div class="study-go-row">
      <button class="study-go" onclick="studyStartSession('due')">${todo ? `▶ 开始学习（${review.length} 复习 + ${group.length} 新词）` : '▶ 开始刷单词'}</button>
      ${todo ? `<button class="study-go study-go-alt" onclick="studyStartSession('all')" title="随机抽 20 张，不管到没到期">提前刷</button>` : ''}
    </div>`;
  }

  h += _studyBookRowHtml();

  // 组大小。⚠️ selected 必须从 state 读出来，不能写死某一档：
  // 这个面板是整块 innerHTML 重画的，写死的话每答完一张卡就弹回默认值
  //（导入语言的单选框当年就是这么坏的，见 _studyImportLang 那段注释）。
  if (newLeft) {
    const gs = studyGroupSize();
    h += `<div class="study-group-row">
      <span class="study-dim">每组新词</span>
      <select class="study-group-sel" onchange="studySetGroupSize(this.value)">
        ${[5, 10, 15, 20, 30].map(n => `<option value="${n}"${n === gs ? ' selected' : ''}>${n} 个</option>`).join('')}
      </select>
      <span class="study-dim">还没学的还有 ${newLeft} 个，这一组学完自动开下一组</span>
    </div>`;
  }

  // 导入区放在空列表判断之前——一张卡都没有的时候才最想导词库
  // 示例文案不写在 placeholder 属性里，重画完由 _studyRestoreImportBox 按当前语言塞
  h += `<div class="study-import">
    <button class="study-imp-toggle" onclick="studyToggleImport()">📥 导入词库 ${_studyImportOpen ? '▲' : '▼'}</button>
    ${_studyImportOpen ? `<div class="study-imp-box">
      <div class="study-imp-langs">
        <label><input type="radio" name="studyImportLang" value="de" onchange="studySetImportLang('de')"${_studyImportLang === 'de' ? ' checked' : ''}> 🇩🇪 德语</label>
        <label><input type="radio" name="studyImportLang" value="en" onchange="studySetImportLang('en')"${_studyImportLang === 'en' ? ' checked' : ''}> 🇬🇧 英语</label>
      </div>
      <textarea id="studyImportText" class="study-imp-ta" spellcheck="false"></textarea>
      <div class="study-imp-row">
        <button class="study-imp-go" onclick="studyDoImport()">导入</button>
        <span class="study-dim" id="studyImportHint"></span>
      </div>
    </div>` : ''}
  </div>`;

  if (!cards.length) {
    h += `<div class="study-empty">还没有卡片。<br><span class="study-dim">最省事的是上面选一本词书，直接开刷。也可以打开接入对话的开关，然后回聊天里随便聊——AI 会在合适的时候教你一个词，顺手考你。你也可以直接问它「Tisch 是什么意思」，或者用上面的导入塞一批词库进来。</span></div>`;
    body.innerHTML = h;
    _studyRestoreImportBox(keepText);
    return;
  }

  // 音标是后补的（建卡时异步查一次），所以老卡片和查不到的词会缺。
  // 只在真的缺的时候露这个按钮 —— 补齐了还杵在那儿只会让人想按，按了又什么都不发生。
  const noIpa = cards.filter(c => !c.ipa).length;
  if (noIpa) {
    h += `<div class="study-ipa-row">
      <button class="study-imp-toggle" onclick="studyFillIpa()">📖 补音标（还缺 ${noIpa} 个）</button>
      <span class="study-dim">查词典，要连着电脑的后端</span>
    </div>`;
  }

  // 排序按"接下来会轮到谁"：到期复习 → 本组新词 → 排队中的新词 → 已排到未来的。
  // 原来一律按 due 升序，而没学过的卡 due 停在建卡那一刻（很早），
  // 于是导完词库整张列表最上面是几百行"该复习了"——其实一个都还没学过。
  // 列表仍然兼着错题本：答错 → 间隔清零 → 明天到期 → 自己浮到最上面。
  const groupPos = new Map(group.map((c, i) => [c.id, i]));
  const rank = (c) => {
    if (c.known) return 4;                  // 标熟的沉底
    if (!_studyIsNew(c)) return c.due <= Date.now() ? 0 : 3;
    return groupPos.has(c.id) ? 1 : 2;
  };
  const sorted = [...cards].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return groupPos.get(a.id) - groupPos.get(b.id);
    if (ra === 2) return (a.created || 0) - (b.created || 0);
    return a.due - b.due;
  });
  h += `<div class="study-list">`;
  for (const c of sorted) {
    const r = rank(c);
    const open = _studyOpenRows.has(c.id);
    const state_ = r === 0 ? '该复习了' : _studyLearning(c) ? `学习中 ${c.dots}/${STUDY_DOTS}` : r === 1 ? '这一组要学' : r === 2 ? '还没排到' : r === 4 ? '已标熟' : _studyDueText(c);
    h += `<div class="study-item">
      <div class="study-row${r === 0 ? ' study-row-due' : ''}${r === 1 ? ' study-row-new' : ''}${r === 2 || r === 4 ? ' study-row-queued' : ''}${open ? ' study-row-open' : ''}" onclick="studyToggleRow('${c.id}')">
      <span class="study-row-lang">${c.lang === 'de' ? '德' : '英'}</span>
      <span class="study-row-front">${escHtml(c.front)}${c.ipa ? ` <i class="study-row-ipa">${escHtml(c.ipa)}</i>` : ''}</span>
      <span class="study-row-back">${escHtml(c.back)}</span>
      <span class="study-row-due-txt">${escHtml(state_)}</span>
      <button class="study-row-speak" onclick="studySpeak('${c.id}',event)">🔊</button>
      <button class="study-row-del" onclick="event.stopPropagation();studyDelete('${c.id}')" title="删掉这张卡">✕</button>
    </div>${open ? _studyExBox(c) : ''}</div>`;
  }
  h += `</div>`;
  // 放在最底下、做成不起眼的样子：一键清掉全部进度，不该是顺手会点到的位置
  if (cards.some(c => c.reps > 0 || c.known || typeof c.dots === 'number')) {
    h += `<div class="study-reset-row"><button class="study-reset-btn" onclick="studyResetAllAsk()">↺ 全部标成没学过</button></div>`;
  }
  body.innerHTML = h;
  _studyRestoreImportBox(keepText);
}

function studyDelete(id) {
  const c = studyGet(id); if (!c) return;
  if (!confirm(`删掉「${c.front}」这张卡？`)) return;
  state.studyCards = studyCards().filter(x => x.id !== id);
  save();
  studyRefresh();
  // 历史消息里指向它的 [[CARDQ:]] 会渲染成"已删除"占位，不会报错
  document.querySelectorAll(`[data-study-ask^="${id}|"]`).forEach(el => {
    el.outerHTML = `<div class="study-card study-gone">（这张卡片已经被删掉了）</div>`;
  });
}

// ── 手机 ↔ 电脑同步：单词卡（2026-10-10）──
// 以前卡片只存本机。那天电脑的 IndexedDB 被硬杀 exe 弄得整个重建，单词卡一张不剩，
// 最后是从 8 月的旧备份里抠回来的。云端那条路是整包 upsert（01-core 的 syncSettingsToCloud），
// 所以跟猫爪日报一样「先按条合并再推」。
// 跟点歌收藏不同，卡片被改的地方有十几处（打分、补音标、补例句、重置进度、删卡……），
// 一处处盖戳迟早漏一处。所以改成同步时对账：state.studySeen = {id: [词, 指纹]} 是上次同步完的样子，
//   · 指纹变了 → 这台改过，盖 upd = 现在
//   · 上次有的词这次没了（删了，或者改了正面）→ 墓碑 studyGone[词] = 现在
// 合并按「语言 + 正面」认同一个词——两台各自建的同一个词 id 不一样，按 id 并会出两张。
// upd 大的赢；墓碑比卡新就不留（删了之后又重新加的，created 比墓碑新，照样活）。
// studySeen 只存本机不上云：存档被清空时它跟着空，不会把「本机什么都没有」误判成「全删了」。
var _studySyncHigh = 0;
function _studyStampNow() { _studySyncHigh = Math.max(Date.now(), _studySyncHigh + 1); return _studySyncHigh; }
function _studyKey(c) { return (c.lang === 'en' ? 'en' : 'de') + '|' + String(c.front || '').trim().toLowerCase(); }
function _studyUpd(c) { return Math.max(+c.upd || 0, +c.created || 0, +c.last || 0); }
function _studyPrint(c) {
  const { upd, ...rest } = c;
  const s = JSON.stringify(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + '.' + s.length.toString(36);
}
function _studyGoneNorm(g) {
  const out = {};
  if (g && typeof g === 'object' && !Array.isArray(g))
    for (const [k, t] of Object.entries(g)) if (+t > 0) out[k] = +t;
  return out;
}
// 纯函数：两边拿着同样两份输入算出来一模一样（撞平比指纹，不看哪边是本机），推拉才收敛
function studyCardsMerge(local, cloud, goneL, goneC) {
  const gone = _studyGoneNorm(goneL);
  for (const [k, t] of Object.entries(_studyGoneNorm(goneC))) if (t > (gone[k] || 0)) gone[k] = t;
  const by = new Map();
  for (const list of [local, cloud]) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object' || !c.id || !String(c.front || '').trim()) continue;
      const k = _studyKey(c), prev = by.get(k);
      if (!prev) { by.set(k, c); continue; }
      const a = _studyUpd(prev), b = _studyUpd(c);
      if (b > a || (b === a && _studyPrint(c) > _studyPrint(prev))) by.set(k, c);
    }
  }
  const cards = [...by.entries()].filter(([k, c]) => _studyUpd(c) > (gone[k] || 0)).map(([, c]) => c)
    .sort((x, y) => ((+x.created || 0) - (+y.created || 0)) || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  return { cards, gone };
}
// 01-core.js 推、拉两处共用：先对账盖戳，再跟云端合并进 state，有变化就落盘、重画
function studySyncApply(cloudCards, cloudGone, cloudBook) {
  const seen = (state.studySeen && typeof state.studySeen === 'object') ? state.studySeen : {};
  const before = JSON.stringify([state.studyCards || [], state.studyGone || {}, state.studyBook || null, seen]);
  const gone = _studyGoneNorm(state.studyGone);
  const keys = new Set(studyCards().map(_studyKey));
  let now = 0;
  for (const c of studyCards()) {
    const s = c && seen[c.id];
    if (Array.isArray(s) && s[1] !== _studyPrint(c)) c.upd = now ||= _studyStampNow();
  }
  for (const s of Object.values(seen)) {
    if (Array.isArray(s) && s[0] && !keys.has(s[0])) gone[s[0]] = Math.max(gone[s[0]] || 0, now ||= _studyStampNow());
  }
  const m = studyCardsMerge(studyCards(), cloudCards, gone, cloudGone);
  state.studyCards = m.cards;
  state.studyGone = m.gone;
  // 词书取到第几个：同一本书取大的那个（不然另一台从头取，删掉的书词又一个个冒回来）。
  // 换书 / 不用书是这台自己的选择，不跟着云端走
  const sb = state.studyBook;
  if (sb && cloudBook && cloudBook.id === sb.id && (parseInt(cloudBook.pos) || 0) > sb.pos)
    state.studyBook = { id: sb.id, pos: parseInt(cloudBook.pos) || 0 };
  const nextSeen = {};
  for (const c of m.cards) {
    nextSeen[c.id] = [_studyKey(c), _studyPrint(c)];
    if (_studyUpd(c) > _studySyncHigh) _studySyncHigh = _studyUpd(c);
  }
  for (const t of Object.values(m.gone)) if (t > _studySyncHigh) _studySyncHigh = t;
  state.studySeen = nextSeen;
  const changed = JSON.stringify([state.studyCards, state.studyGone, state.studyBook, nextSeen]) !== before;
  if (changed) {
    if (typeof save === 'function') save();
    try { studyRefresh(); } catch (e) { console.warn('[单词卡同步] 没重画上:', e); }
  }
  return changed;
}
