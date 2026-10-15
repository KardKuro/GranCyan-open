/* 相关性探针：绕开权重、门限和预算，纯看 IDF 余弦把哪几条排在最前。
 * 回答一个问题：某个查询召不回东西，是库里真没有，还是有、但 rel 没过 BRAIN_REL_MIN(0.055)？ */
'use strict';
const mems = require('./ombre-memories.json');
const REL_MIN = 0.055;
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
function vec(s) {
  const v = new Map(); let sq = 0;
  grams(s).forEach(g => { const w = idf.get(g) || 0; if (w > 0) { v.set(g, w); sq += w * w; } });
  return { vec: v, norm: Math.sqrt(sq) };
}
function cos(a, b) {
  if (!a.norm || !b.norm) return 0;
  let dot = 0;
  const [s, l] = a.vec.size <= b.vec.size ? [a.vec, b.vec] : [b.vec, a.vec];
  s.forEach((w, g) => { const o = l.get(g); if (o) dot += w * o; });
  return dot / (a.norm * b.norm);
}
const docs = mems.map(m => ({ m, v: vec((m.text || '') + ' ' + (m.domain || '')) }));

const QUERIES = process.argv.slice(2).length ? process.argv.slice(2) : [
  '我最近睡眠怎么样', '我朋友的论文', '今天想吃什么',
  '你还记得那首诗吗', '上次我们聊的那本书',
];
for (const q of QUERIES) {
  const qv = vec(q);
  const top = docs.map(d => ({ m: d.m, rel: cos(qv, d.v) })).sort((a, b) => b.rel - a.rel).slice(0, 4);
  const over = docs.filter(d => cos(qv, d.v) >= REL_MIN).length;
  console.log(`【${q}】  过门限(≥${REL_MIN})的有 ${over} 条`);
  top.forEach((x, i) => {
    const mark = x.rel >= REL_MIN ? '✓' : '✗被门限挡';
    console.log(`  ${i + 1}. rel=${x.rel.toFixed(4)} ${mark}  ${x.m.text.slice(0, 44).replace(/\n/g, ' ')}…`);
  });
  console.log('');
}
console.log(`记忆库规模 ${mems.length} 条，文档平均 gram 数 ${Math.round(docs.reduce((s, d) => s + d.v.vec.size, 0) / docs.length)}`);
