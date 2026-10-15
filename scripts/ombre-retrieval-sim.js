/* 检索预演：把 14-boot-brain-hub.js 的挑选管线原样搬过来（brainWeight / IDF 余弦 /
 * 粗召回 / 重排 / 预算截断），拿导出的真实记忆库跑几个查询，看到底会浮现什么。
 *
 * 验的不是「字段对不对」，是「导进去之后问一句话，能不能想起相关的那条」。
 *   node scripts/ombre-retrieval-sim.js [--pinned-mode all|orig|none]
 */
'use strict';
const mems0 = require('./ombre-memories.json');
const argv = process.argv.slice(2);
const PIN = (argv.indexOf('--pinned-mode') >= 0 ? argv[argv.indexOf('--pinned-mode') + 1] : 'all');

const HALFLIFE = 14, BUDGET = 1200, MIN_W = 0.05, POOL = 14, REL_MIN = 0.055, BG = 2, MMR = 0.62;

const mems = mems0.map(m => ({
  ...m,
  pinned: PIN === 'all' ? m.pinned : PIN === 'none' ? false : (m._layer === 'permanent' ? m.pinned : m.pinned)
}));
if (PIN === 'none') mems.forEach(m => m.pinned = false);

function brainWeight(m, now) {
  const imp = (m.importance || 5) / 10;
  if (m.pinned) return Math.max(1.2, imp * 1.5);
  const intensity = Math.min(1, Math.abs(m.valence || 0) * 0.5 + (m.arousal || 0) * 0.5);
  const halfLife = HALFLIFE * (0.5 + imp) * (1 + 2 * intensity);
  const days = Math.max(0, now - (m.lastAccess || m.createdAt)) / 86400000;
  return imp * Math.exp(-Math.LN2 * days / halfLife) * (m.resolved ? 0.35 : 1) * (1 + 0.4 * intensity);
}
const STOP = new Set('的了是我你他她它在就和有也都不一个这那么呢吧啊被把很还要会对上下去来到说给'.split(''));
function grams(s) {
  const set = new Set();
  (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(w => { if (w.length > 2) set.add(w); });
  const cjk = String(s).replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    if (i < cjk.length - 1) set.add(cjk.slice(i, i + 2));
    if (!STOP.has(cjk[i])) set.add(cjk[i]);
  }
  return set;
}
const df = new Map();
for (const m of mems) grams((m.text || '') + ' ' + (m.domain || '')).forEach(g => df.set(g, (df.get(g) || 0) + 1));
const N = mems.length, idf = new Map();
df.forEach((c, g) => idf.set(g, Math.log(1 + N / (1 + c))));

const vecCache = new Map();
function docVec(m) {
  if (vecCache.has(m.id)) return vecCache.get(m.id);
  const vec = new Map(); let sq = 0;
  grams((m.text || '') + ' ' + (m.domain || '')).forEach(g => {
    const w = idf.get(g) || 0; if (w > 0) { vec.set(g, w); sq += w * w; }
  });
  const out = { vec, norm: Math.sqrt(sq) || 1 };
  vecCache.set(m.id, out); return out;
}
function qVec(q) {
  const vec = new Map(); let sq = 0;
  grams(q).forEach(g => { const w = idf.get(g) || 0; if (w > 0) { vec.set(g, w); sq += w * w; } });
  return { vec, norm: Math.sqrt(sq) };
}
function cos(a, b) {
  if (!a.norm || !b.norm) return 0;
  let dot = 0;
  const [s, l] = a.vec.size <= b.vec.size ? [a.vec, b.vec] : [b.vec, a.vec];
  s.forEach((w, g) => { const o = l.get(g); if (o) dot += w * o; });
  return dot / (a.norm * b.norm);
}
/* --pin-quota N：模拟「给 pinned 设配额」的修法。
   现状是 pinned 先无条件排到最前、再截 POOL(14)，于是 pinned 一多就把候选池整个吃掉，
   相关记忆连参赛资格都没有。配额版只让权重最高的 N 条 pinned 进池并优先，
   剩下的 pinned 退回去按 score 和普通记忆公平竞争。 */
const QUOTA = argv.indexOf('--pin-quota') >= 0 ? parseInt(argv[argv.indexOf('--pin-quota') + 1]) : null;
/* --hybrid N：模拟「粗召回给相关性留 N 个名额」。
   现状粗召回只按 score = w×(1+2rel) 截前 POOL(14)，w 的量级差异（1.2 vs 0.6）盖过 rel 的
   贡献，于是高权重的低相关记忆把池子占满 —— 库越大越致命（近千条时 pool 只覆盖 1.5%）。
   混合召回：一部分名额照旧按 score 给（保住"重要但没人提"的常驻项），另一部分纯按 rel 给，
   保证真正相关的那条至少能进池子、参加重排。 */
const HYBRID = argv.indexOf('--hybrid') >= 0 ? parseInt(argv[argv.indexOf('--hybrid') + 1]) : null;
function poolOf(scored) {
  if (HYBRID != null) {
    const byScore = scored.slice(0, POOL - HYBRID);
    const taken = new Set(byScore.map(x => x.m.id));
    const byRel = scored.filter(x => !taken.has(x.m.id) && x.rel > 0)
      .sort((a, b) => b.rel - a.rel).slice(0, HYBRID);
    return [...byScore, ...byRel];
  }
  if (QUOTA == null) return scored.slice(0, POOL);
  const pin = scored.filter(x => x.m.pinned).sort((a, b) => b.score - a.score).slice(0, QUOTA);
  const keep = new Set(pin.map(x => x.m.id));
  // 超配额的 pinned 必须连「不衰减的高权重」一起交出来，否则它们照样以 w=1.5 碾压
  // 所有普通记忆、把池子重新占满 —— 配额就等于没设。这里按普通记忆的公式给它们重新计权。
  const rest = scored.filter(x => !keep.has(x.m.id)).map(x => {
    if (!x.m.pinned) return x;
    const w = brainWeight({ ...x.m, pinned: false }, Date.now());
    return { ...x, w, score: w * (1 + 2 * x.rel) };
  }).sort((a, b) => b.score - a.score);
  return [...pin, ...rest].slice(0, POOL);
}
function rerank(scored) {
  const pool = poolOf(scored);
  if (!pool.length) return [];
  const wMax = pool.reduce((s, x) => Math.max(s, x.w), 0) || 1;
  pool.forEach(x => { x.rr = x.rel * (0.55 + 0.45 * (x.w / wMax)); });
  const out = [];
  const dup = x => out.some(y => !y.m.pinned && cos(docVec(x.m), docVec(y.m)) > MMR);
  pool.filter(x => x.m.pinned).forEach(x => { x.why = 'pinned'; out.push(x); });
  pool.filter(x => !x.m.pinned && x.rel >= REL_MIN).sort((a, b) => b.rr - a.rr)
      .forEach(x => { if (!dup(x)) { x.why = 'rel'; out.push(x); } });
  pool.filter(x => !x.m.pinned && x.rel < REL_MIN).sort((a, b) => b.w - a.w).slice(0, BG)
      .forEach(x => { if (!dup(x)) { x.why = 'bg'; out.push(x); } });
  return out;
}
function pick(query, now = Date.now()) {
  const q = qVec(query);
  let scored = mems.map(m => {
    const w = brainWeight(m, now), rel = cos(q, docVec(m));
    return { m, w, rel, score: w * (1 + 2 * rel) };
  }).filter(x => x.m.pinned || (x.w >= MIN_W && x.score >= MIN_W));
  scored.sort((a, b) => (b.m.pinned - a.m.pinned) || (b.score - a.score));
  const ranked = rerank(scored);
  const picked = []; let used = 0;
  for (const x of ranked) {
    const cost = x.m.text.length + 20;
    if (used + cost > BUDGET && picked.length) break;
    picked.push(x); used += cost;
  }
  return { picked, poolSize: scored.length, used };
}

const QUERIES = [
  '上次我们聊的那本书',
  '我最近睡眠怎么样',
  '我朋友的论文',
  '今天想吃什么',
  '你还记得那首诗吗',
];
console.log(`pinned 模式: --pinned-mode ${PIN}  (pinned 条数 ${mems.filter(m => m.pinned).length}/${mems.length})\n`);
const firstOf = {};
for (const q of QUERIES) {
  const { picked, poolSize, used } = pick(q);
  console.log(`【${q}】 候选池 ${poolSize} · 用了 ${used}/${BUDGET} 字符 · 浮现 ${picked.length} 条`);
  picked.forEach(x => {
    console.log(`   [${x.why.padEnd(6)} rel=${x.rel.toFixed(3)} w=${x.w.toFixed(2)}] ${x.m.text.slice(0, 46).replace(/\n/g, ' ')}…`);
  });
  firstOf[q] = picked.map(x => x.m.id).join(',');
  console.log('');
}
const uniq = new Set(Object.values(firstOf));
console.log(`不同查询召回的结果集有 ${uniq.size} / ${QUERIES.length} 种`);
if (uniq.size === 1) console.log('⚠ 所有查询浮现的都是同一批 —— 检索没在起作用，等于每轮念同一段通讯录。');
