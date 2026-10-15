// 高级记忆检索（粗召回 → 重排）回归测试。
//
// 守的是两个只在「记忆库变大」之后才显形、而且**零报错**的退化：
//   ① pinned 把候选池吃光 —— 钉够 BRAIN_RERANK_POOL 条，相关记忆连参赛资格都没有
//   ② 粗召回被权重主导 —— score=w×(1+2rel) 里 w 的量级差盖过 rel，高权重的无关记忆占满池子
// 两者的症状都不是崩溃，是 AI 慢慢开始答非所问，所以只能靠断言守。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/14-boot-brain-hub.js'), 'utf8');
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const DAY = 86400000;
const now = Date.now();
const MODEL = 'm-local';

// 一条记忆的骨架。lastAccess 默认设近一点，免得被遗忘曲线筛掉、干扰我们要测的东西。
let seq = 0;
const mem = (o) => ({
  id: 1000 + (seq++), text: o.text, domain: o.domain || '综合',
  importance: o.importance ?? 5, valence: o.valence ?? 0, arousal: o.arousal ?? 0.3,
  pinned: !!o.pinned, resolved: !!o.resolved, modelIds: [MODEL],
  createdAt: now - 3 * DAY, lastAccess: now - (o.ageDays ?? 1) * DAY, accessCount: 0
});

function makeCtx(brainMemories) {
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Set, Map, isNaN, parseFloat, parseInt,
    setTimeout() {}, setInterval() {}, save() {}, showToast() {}, escHtml: s => String(s),
    renderMemoryBadge() {}, renderBrainMemList() {}, nextId: () => 9999,
    // hub 表里裸引用（没包 `() =>`）的那几个会在顶层求值时炸，必须先存在
    renderFavList() {}, renderHubBand() {},
    getMsgPlainText: n => n.text || '',
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, requestAnimationFrame() {}, fetch: () => Promise.reject(new Error('no net in test')),
    state: { brainMemories, memories: [], proustMems: [], configs: [{ id: MODEL, nickname: '本地 Claude' }] }
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx); vm.runInContext(source, ctx);
  // 这些调参常量是 const 声明的 —— 词法声明不会挂到 context 对象上（ctx.XXX 是 undefined，
  // 拿它做上界会让断言恒为真/恒为假），必须在 context 里求值取出来。
  ctx.K = vm.runInContext('({ POOL: BRAIN_RERANK_POOL, PIN: BRAIN_PIN_SLOTS, REL: BRAIN_REL_SLOTS,'
    + ' BUDGET: BRAIN_PROMPT_BUDGET, REL_MIN: BRAIN_REL_MIN, PIN_BUDGET: BRAIN_PIN_BUDGET })', ctx);
  return ctx;
}
// 单轮用户提问 —— pickBrainMemories 是从 chat 里回溯最近几条 user 消息来组查询向量的
const chatOf = q => ({ headId: 'n1', nodes: { n1: { role: 'user', text: q, parentId: null } } });

/* ── 场景一：一堆钉住的无关记忆 vs 一条强相关记忆 ──
   这正是导入 Ombre 记忆时踩到的形状（permanent 层 33 条全是 pinned）。 */
console.log('\n[钉住的记忆不该吃光候选池]');
{
  const target = mem({ text: '小明说想学会做手冲咖啡和拉花', domain: '自省', importance: 8 });
  const noise = [];
  for (let i = 0; i < 20; i++) {
    noise.push(mem({ text: `钉住的常驻事实第${i}条：与提问毫无关系的背景设定`, domain: '综合', importance: 10, pinned: true }));
  }
  const ctx = makeCtx([...noise, target]);
  const picked = ctx.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
  const texts = picked.map(x => x.m.text);
  t('钉住 20 条时，强相关的那条仍能浮现', texts.includes(target.text));
  // 上界是 PIN + REL 而不是 PIN：专属名额是保底，钉住的记忆此外仍可凭相关性去争 rel 名额
  // （被歧视才不对）。这里守的是「不能垄断」——修复前这个数是 13。
  const pinnedCount = picked.filter(x => x.m.pinned).length;
  t(`钉住的不再垄断候选池（实际 ${pinnedCount} ≤ ${ctx.K.PIN + ctx.K.REL}）`,
    pinnedCount <= ctx.K.PIN + ctx.K.REL);
  t('浮现结果里有非钉住的记忆', picked.some(x => !x.m.pinned));
}

/* ── 场景二：高权重的无关记忆 vs 低权重的相关记忆 ──
   粗召回若仍按 score=w×(1+2rel) 独占名额，低权重那条永远进不来。 */
console.log('\n[粗召回不该被权重独占]');
{
  const target = mem({ text: '小明的同事说研究AI可以赚钱', domain: '人际', importance: 4, ageDays: 20 });
  const heavy = [];
  for (let i = 0; i < 20; i++) {
    heavy.push(mem({ text: `高重要度但不沾边的记忆第${i}条`, domain: '综合', importance: 10, valence: 0.8, arousal: 0.8, ageDays: 0 }));
  }
  const ctx = makeCtx([...heavy, target]);
  const before = target.lastAccess;
  const picked = ctx.pickBrainMemories(chatOf('我同事最近怎么样'), MODEL);
  t('低权重但相关的记忆能被想起', picked.some(x => x.m.text === target.text));
  // 「因相关而被想起」才刷新，纯背景板不白嫖 —— 这是遗忘曲线的输入，写错了记忆会缓慢跑偏
  const revived = picked.filter(x => x.rel >= ctx.K.REL_MIN);
  t('确实有记忆过了相关性门限（否则下一条断言是假绿）', revived.length > 0);
  t('被想起的记忆刷新了 lastAccess 和 accessCount',
    revived.length > 0 && revived.every(x => x.m.accessCount >= 1 && x.m.lastAccess > before));
  const bg = picked.filter(x => x.rel < ctx.K.REL_MIN);
  t('只当背景板的没有白嫖刷新', bg.every(x => x.m.accessCount === 0));
}

/* ── 场景三：不相关的对话仍要有背景板，且不能整包倾倒 ── */
console.log('\n[无关话题时的行为]');
{
  const mems = [];
  for (let i = 0; i < 30; i++) mems.push(mem({ text: `背景记忆第${i}条`, domain: '综合', importance: 6 + (i % 4) }));
  const ctx = makeCtx(mems);
  const picked = ctx.pickBrainMemories(chatOf('qqqq zzzz'), MODEL);
  t('完全不相关时仍留少量背景板（不显得失忆）', picked.length > 0);
  t('不会把整个记忆库倾倒进提示', picked.length <= 10);
  const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
  t(`不超预算 BRAIN_PROMPT_BUDGET（用了 ${used}/${ctx.K.BUDGET}）`, used <= ctx.K.BUDGET);
}

/* ── 场景四：授权隔离没被这次改动破坏 ── */
console.log('\n[模型授权隔离]');
{
  const mine = mem({ text: '只给本地 Claude 看的私密记忆' });
  const other = { ...mem({ text: '别的模型的记忆' }), modelIds: ['m-other'] };
  const ctx = makeCtx([mine, other]);
  const picked = ctx.pickBrainMemories(chatOf('记忆'), MODEL);
  t('别的模型的记忆不会浮现', !picked.some(x => x.m.text === other.text));
}

/* ── 场景六：真实长度下的端到端预算争夺 ──
   上一版测试用的都是二三十字的短文本，于是漏掉了预算层：候选池修公平了，但 ranked 里
   pinned 排最前，6 条 ×(175+20) = 1170 就逼近 1200 的预算上限，后面那条真正相关的
   一进来就超支 break —— 「相关记忆召不回」从池子层原样搬到预算层。这条守的就是它。 */
console.log('\n[真实长度下的预算争夺]');
{
  const pad = (s, n) => s + '。'.repeat(Math.max(0, n - s.length));
  const target = mem({ text: pad('小明说想学会做手冲咖啡和拉花，这件事念叨了一整天', 175), domain: '自省', importance: 8 });
  const noise = [];
  for (let i = 0; i < 8; i++) {
    noise.push(mem({ text: pad(`钉住的常驻事实第${i}条：与提问毫无关系的长背景设定`, 175), importance: 10, pinned: true }));
  }
  const ctx = makeCtx([...noise, target]);
  const picked = ctx.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
  const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
  const pinUsed = picked.filter(x => x.m.pinned).reduce((s, x) => s + x.m.text.length + 20, 0);
  t('真实长度下强相关的那条仍进得了最终提示', picked.some(x => x.m.text === target.text));
  t(`钉住的不吃光预算（占了 ${pinUsed}/${ctx.K.BUDGET}）`, pinUsed <= ctx.K.BUDGET * ctx.K.PIN_BUDGET);
  t('至少保留一条钉住的（钉住不能完全失效）', picked.some(x => x.m.pinned));
  t(`总量不超预算（${used}/${ctx.K.BUDGET}）`, used <= ctx.K.BUDGET);
}

/* ── 场景七：超长的钉住记忆不能借「保底」之名吃掉整个预算 ──
   保底例外若无条件放行首条 pinned，一条 1100 字的钉住记忆就能占满预算，
   后面那条相关记忆一进来就超支 break —— 召不回原样复发。 */
console.log('\n[超长钉住记忆的预算边界]');
{
  const pad = (s, n) => s + '。'.repeat(Math.max(0, n - s.length));
  for (const len of [800, 1100, 1400]) {
    const target = mem({ text: pad('小明说想学会做手冲咖啡和拉花', 175), domain: '自省', importance: 8 });
    const huge = mem({ text: pad('超长的钉住记忆，与提问无关', len), importance: 10, pinned: true });
    const ctx = makeCtx([huge, target]);
    const picked = ctx.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
    const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
    t(`${len} 字的钉住记忆存在时，相关的那条仍进得去`, picked.some(x => x.m.text === target.text));
    t(`  且总量不超总预算（${used}/${ctx.K.BUDGET}）`, used <= ctx.K.BUDGET);
  }
}

/* ── 场景八：总预算是硬上限，任何单条都不能突破 ──
   原逻辑 `if (used + cost > BUDGET && picked.length) break` 里的 `&& picked.length`
   是「至少留一条」的保底，但它让首条超长记忆能无限超支。系统提示吃爆上下文窗口的后果是
   静默失忆（认得人格却不记得刚说过的话），所以这里必须是硬上限。 */
console.log('\n[总预算硬上限]');
{
  const pad = (s, n) => s + '。'.repeat(Math.max(0, n - s.length));
  for (const len of [1181, 1500]) {
    const only = mem({ text: pad('唯一的一条超长普通记忆，而且高度相关：手冲咖啡和拉花', len), domain: '自省', importance: 9 });
    const ctx = makeCtx([only]);
    const picked = ctx.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
    const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
    t(`唯一候选 ${len} 字时也不突破总预算（${used}/${ctx.K.BUDGET}）`, used <= ctx.K.BUDGET);
  }
  // 但正常长度的唯一候选必须照常进，别把保底去过头
  const ok = mem({ text: '手冲咖啡和拉花那句话', domain: '自省', importance: 9 });
  const ctx2 = makeCtx([ok]);
  t('正常长度的唯一候选仍然浮现', ctx2.pickBrainMemories(chatOf('手冲咖啡和拉花'), MODEL).length === 1);

  // 装不下的要跳过而不是中断，否则一条超长记忆能把整轮的记忆全挡住
  {
    const huge = mem({ text: pad('手冲咖啡和拉花手冲咖啡和拉花，超长版本', 1181), domain: '自省', importance: 10 });
    const small = mem({ text: '手冲咖啡和拉花那句话，短版本', domain: '自省', importance: 9 });
    const ctx3 = makeCtx([huge, small]);
    const picked = ctx3.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
    const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
    t('超长的首项不该挡住后面装得下的记忆', picked.some(x => x.m.text === small.text));
    t(`  且仍不超总预算（${used}/${ctx3.K.BUDGET}）`, used <= ctx3.K.BUDGET);
  }
  // 已选一部分之后，中间一条放不下也不该挡住更靠后的短记忆
  {
    const mems = [
      mem({ text: pad('手冲咖啡和拉花第一条', 400), domain: '自省', importance: 10 }),
      mem({ text: pad('手冲咖啡和拉花第二条', 400), domain: '自省', importance: 9 }),
      mem({ text: pad('手冲咖啡和拉花第三条超长放不下', 900), domain: '自省', importance: 8 }),
      mem({ text: '手冲咖啡和拉花第四条很短', domain: '自省', importance: 7 }),
    ];
    const ctx4 = makeCtx(mems);
    const picked = ctx4.pickBrainMemories(chatOf('你还记得手冲咖啡和拉花那件事吗'), MODEL);
    const used = picked.reduce((s, x) => s + x.m.text.length + 20, 0);
    t('中间放不下的一条不挡住更靠后的短记忆', picked.some(x => x.m.text === mems[3].text));
    t(`  且仍不超总预算（${used}/${ctx4.K.BUDGET}）`, used <= ctx4.K.BUDGET);
  }
}

/* ── 场景五：_brainPool 的名额分配（Codex 审出来的三个边界） ── */
console.log('\n[候选池名额分配]');
{
  const ctx = makeCtx([]);
  // scored 的形状：{ m, w, rel, score }，score = w*(1+2rel)
  const item = (o) => {
    const m = { id: o.id, text: o.text || ('t' + o.id), domain: '综合', pinned: !!o.pinned,
      importance: o.importance ?? 5, lastAccess: o.lastAccess ?? now };
    const w = o.w, rel = o.rel;
    return { m, w, rel, score: w * (1 + 2 * rel) };
  };

  // ① 13 条高 rel 的 pinned 不能把相关性名额也占光，挤掉真正相关的普通记忆
  {
    const scored = [];
    for (let i = 0; i < 13; i++) scored.push(item({ id: 'p' + i, pinned: true, w: 1.5, rel: 0.3 }));
    const target = item({ id: 'want', text: '真正相关的普通记忆', w: 0.62, rel: 0.155 });
    scored.push(target);
    for (let i = 0; i < 10; i++) scored.push(item({ id: 'h' + i, w: 1.22, rel: 0.003 }));
    const pool = ctx._brainPool(scored);
    t('13 条高相关 pinned 也挤不掉相关的普通记忆', pool.some(x => x.m.id === 'want'));
    t(`pinned 在池中不超过 PIN_SLOTS + 兜底（实际 ${pool.filter(x => x.m.pinned).length}）`,
      pool.filter(x => x.m.pinned).length <= ctx.K.POOL);
  }

  // ② 钉住的超过配额时，多出来的不该被永久饿死 —— 池子还空着就该补位
  {
    const scored = [];
    for (let i = 0; i < 20; i++) scored.push(item({ id: 'p' + i, pinned: true, w: 1.5, rel: 0 }));
    const pool = ctx._brainPool(scored);
    t(`只有钉住的记忆时池子仍被填满（${pool.length}/${ctx.K.POOL}）`, pool.length === ctx.K.POOL);
  }

  // ③ id 缺失不该让所有条目被当成同一条互相吞掉
  {
    const scored = [];
    for (let i = 0; i < 8; i++) scored.push(item({ id: undefined, w: 1 - i * 0.05, rel: 0.1 }));
    const pool = ctx._brainPool(scored);
    t(`id 全缺失时条目不互相吞（池中 ${pool.length} 条）`, pool.length === 8);
  }

  // ④ 空输入
  t('空输入返回空池', ctx._brainPool([]).length === 0);
}

/* ── 语义路：词法对不上字面的那条，靠向量名额进来 ──
   不在测试里跑真模型：直接往 _brainVec 里塞查询向量和文档向量，守的是「名额怎么发」。 */
console.log('\n[语义路名额]');
{
  // 8 维玩具向量：target 和查询同向，其余散开（让 top1 远高于中位数）
  const unit = (k) => { const v = new Float32Array(8); v[k % 8] = 1; return v; };
  const QV = unit(0);
  const build = (opts = {}) => {
    seq = 0;
    const target = mem({ text: '同学说我总在图书馆待到闭馆', domain: '人际', importance: 6 });
    const pinT = mem({ text: '钉住的：同样和查询语义很近', pinned: true, importance: 9 });
    const others = [];
    for (let i = 0; i < 15; i++) others.push(mem({ text: `日常琐事第${i}条：天气和吃饭`, importance: 5 }));
    const all = [target, pinT, ...others];
    const ctx = makeCtx(all);
    ctx.indexedDB = {};   // _brainVecOn 要它存在
    const V = vm.runInContext('_brainVec', ctx);
    const hash = m => vm.runInContext('_brainVecHash', ctx)(vm.runInContext('_brainVecDocText', ctx)(m));
    all.forEach((m, i) => {
      const v = (m === target || m === pinT) ? QV : (opts.flat ? QV : unit(1 + (i % 7)));
      V.docs.set(m.id, { model: 'x', h: hash(m), v });
    });
    const q = '舍友觉得我太爱泡自习室了';
    V.q = { text: opts.staleQ ? '上一轮的问题' : q, v: QV };
    return { ctx, target, pinT, q, V };
  };

  {
    const { ctx, target, q } = build();
    const before = target.lastAccess;
    const picked = ctx.pickBrainMemories(chatOf(q), MODEL);
    const hit = picked.find(x => x.m === target);
    t(`★ 词法 rel≈0 的目标靠语义名额浮现（rel=${hit ? hit.rel.toFixed(3) : '—'}）`, !!hit && hit.why === 'vec');
    t('语义名额不刷新 lastAccess（不当「想起」，免得自我强化）', target.lastAccess === before);
    t('面板记录带上 vrel', vm.runInContext('_lastBrainPick', ctx).items.some(it => it.why === 'vec' && it.vrel > 0.9));
  }
  {
    const { ctx, pinT, q } = build();
    ctx.pickBrainMemories(chatOf(q), MODEL);
    t('钉住的不拿语义名额（它们有自己的通道）', !pinT.vec);
  }
  {
    const { ctx, q } = build({ flat: true });
    const picked = ctx.pickBrainMemories(chatOf(q), MODEL);
    t('分数全挤在一起（问句没内容）时不发语义名额', !picked.some(x => x.why === 'vec'));
  }
  {
    const { ctx, q } = build({ staleQ: true });
    const picked = ctx.pickBrainMemories(chatOf(q), MODEL);
    t('查询向量是上一轮的就不用（对不上当前问句）', !picked.some(x => x.why === 'vec'));
  }
  {
    const { ctx, target, q, V } = build();
    target.text = '改过字的记忆';   // hash 对不上 → 旧向量作废
    const picked = ctx.pickBrainMemories(chatOf(q), MODEL);
    t('记忆改过字后旧向量不再生效', !picked.some(x => x.m === target && x.why === 'vec'));
  }
  {
    const { ctx, q } = build();
    ctx.localStorage = { getItem: k => (k === 'gc.brainVec' ? 'off' : null), setItem() {}, removeItem() {} };
    const picked = ctx.pickBrainMemories(chatOf(q), MODEL);
    t('gc.brainVec=off 时整路关闭', !picked.some(x => x.why === 'vec'));
  }
}

/* ── 等长改写：以前文档向量按「id+字数」缓存，把「张三」改成「李四」这种等长修改
   会一直拿旧向量去匹配，改完了照样检索不到新内容 ── */
console.log('\n[等长改写后检索跟上新内容]');
{
  const m = mem({ text: '小明最喜欢的水果是芒果', domain: '偏好', importance: 7 });
  const others = [mem({ text: '今天天气不错' }), mem({ text: '一起看了电影' })];
  const ctx = makeCtx([m, ...others]);
  // 只有三条记忆时全都会被选中，看「选没选中」测不出东西 —— 看这条的相关度分数
  const relOf = q => { const x = ctx.pickBrainMemories(chatOf(q), MODEL).find(x => x.m && x.m.id === m.id); return x ? x.rel : -1; };
  const relOld = relOf('芒果');
  m.text = '小明最喜欢的水果是榴莲';      // 等长
  const relNew = relOf('榴莲');
  t('改之前按「芒果」相关度 > 0（对照）', relOld > 0);
  t('等长改成「榴莲」后按新词相关度 > 0（实测 ' + relNew + '）', relNew > 0);
}

console.log('\n[副本一致]');
t('Android 副本与桌面一致',
  fs.readFileSync(path.join(ROOT, 'js/14-boot-brain-hub.js'))
    .equals(fs.readFileSync(path.join(ROOT, 'android/assets/js/14-boot-brain-hub.js'))));

console.log('\n' + (fail ? '❌' : '✅') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
