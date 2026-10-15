#!/usr/bin/env node
/* Ombre-Brain buckets/*.md → GranCyan 高级记忆(brainMemories) 转换器。
 *
 * 两边的模型本来就是同一套（14-boot-brain-hub.js 的注释：「艾宾浩斯改良版，同 Ombre-Brain」），
 * 所以这里是字段搬运，不是语义重写 —— 不经过任何模型，可重跑、结果确定。
 *
 * 用法：node scripts/ombre-import.js [--src <buckets目录>] [--time keep|shift|now] [--out <json>]
 *   --time keep   原样保留 last_active（忠实还原 Ombre 当时的遗忘状态）
 *          shift  整体平移，让最新一条对齐到今天（默认；抹掉「系统没在跑」的空档，
 *                 遗忘曲线不该惩罚停机时间，条目之间的相对新旧仍然保留）
 *          now    全部设成导入时刻（等于把所有条目全重新想起一遍）
 *   --pin  none   一条都不钉（默认，见下方 pinned 字段处的说明）
 *          orig   继承 Ombre 的 pinned（会有 33 条 —— 足以让检索失效，只在排查时用）
 *   不写 --out 时只做统计、不落盘（dry run）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SRC  = arg('--src', process.env.OMBRE_BUCKETS || '');
const MODE = arg('--time', 'shift');
const OUT  = arg('--out', null);
const PIN  = arg('--pin', 'none');
if (!SRC) { console.error('缺 --src <Ombre-Brain 的 buckets 目录>（或环境变量 OMBRE_BUCKETS）'); process.exit(1); }
if (!['keep', 'shift', 'now'].includes(MODE)) { console.error('--time 只能是 keep|shift|now'); process.exit(1); }
if (!['none', 'orig'].includes(PIN)) { console.error('--pin 只能是 none|orig'); process.exit(1); }

// id 号段：brainMemories 的 id 必须是**数字** —— renderBrainMemList 里是
// onclick="toggleBrainPin(${m.id})" 裸插值，字符串 id 会拼成语法错误，按钮静默失效。
// 从 1e9 起：reseedIdCounter() 只按 chats/configs 播种，nextId() 永远够不到这个号段，
// 因此两边不会互相撞号（同 id 会让 UI 的 pin/del/edit 操作到错误的那条）。
const ID_BASE = 1_000_000_000;

/* ── frontmatter ─────────────────────────────────────────────
   字段形态有限（标量 + 短横线数组），不引第三方 YAML 依赖。 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) { (meta[key] = Array.isArray(meta[key]) ? meta[key] : []).push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    meta[key] = kv[2].trim() === '' ? [] : unquote(kv[2]);
  }
  return { meta, body: m[2].trim() };
}
const unquote = s => s.trim().replace(/^['"]|['"]$/g, '');
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ts = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/* ── 收集 ── */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
}

const files = walk(SRC);
const parsed = [];
const skipped = [];
for (const f of files) {
  const p = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  if (!p || !p.body) { skipped.push([f, p ? '正文为空' : '没有 frontmatter']); continue; }
  const layer = path.relative(SRC, f).split(path.sep)[0];
  parsed.push({ f, layer, ...p });
}

/* ── 时间轴 ──
   Ombre 的 last_active 停在数据导出那天；今天已经过去很久，直接照搬会让低重要度的条目
   一进去就跌到 BRAIN_MIN_WEIGHT 以下（UI 里可见，但不再注入系统提示）。 */
const lastActives = parsed.map(p => ts(p.meta.last_active) || ts(p.meta.created)).filter(Boolean);
const NOW = Date.now();
const SHIFT = MODE === 'shift' ? NOW - Math.max(...lastActives) : 0;

/* ── 转换 ── */
const out = parsed.map((p, i) => {
  const { meta, body, layer } = p;
  const name = (meta.name || '').trim();
  // name 是 Ombre 给每条起的标题，检索侧（IDF 加权余弦）拿它当关键词很有用，拼进 text。
  const text = name && !body.startsWith(name) ? `${name}：${body}` : body;

  // domain 在 Ombre 是数组；feel 层的 feel_category（平静/感动/期待…）比 domain[0]（一律「情绪」）更有信息量。
  const domainSrc = layer === 'feel' && meta.feel_category
    ? meta.feel_category
    : (Array.isArray(meta.domain) ? meta.domain[0] : meta.domain);

  const created = ts(meta.created) || NOW;
  const active  = ts(meta.last_active) || created;

  return {
    id: ID_BASE + i,
    text,
    domain: String(domainSrc || '综合').trim().slice(0, 12) || '综合',
    importance: clamp(Math.round(num(meta.importance, 5)), 1, 10),
    valence:    clamp(num(meta.valence, 0), -1, 1),
    arousal:    clamp(num(meta.arousal, 0.3), 0, 1),
    // ⚠ 故意不继承 Ombre 的 pinned（permanent 层 33 条全是 pinned:true）。
    // pickBrainMemories 里 pinned 会先无条件排到最前，再截 BRAIN_RERANK_POOL(14) 当候选池，
    // 且 _brainRerank 对 pinned 不筛不去重全量放行 —— 一旦 pinned 条数 ≥14，候选池会被
    // pinned 占满，真正相关的记忆连参赛资格都没有，每轮注入的都是同一批（实测：问
    // 标题里的原词，召不回标题就是这个词的那条记忆）。这是 GranCyan 侧的既有问题，
    // 不该由导入来引爆 —— 想常驻的那几条，进去之后在界面上手动钉，控制在个位数。
    pinned:   PIN === 'orig' ? (meta.pinned === 'true' || meta.pinned === true) : false,
    // archive 层是已归档/已了结的事，对应 resolved（权重降到 35%）。
    resolved: meta.resolved === 'true' || meta.resolved === true || layer === 'archive',
    createdAt:   MODE === 'now' ? NOW : created + SHIFT,
    lastAccess:  MODE === 'now' ? NOW : active  + SHIFT,
    accessCount: Math.round(num(meta.activation_count, 0)),
    // modelIds 故意留空：真实的 config id 只有浏览器里才知道，由导入页现场用
    // defaultMemoryOwnerId()（找 isLocalClaude / nickname「本地 Claude」）填上。
    modelIds: [],
    _ombreId: meta.id || null,
    _layer: layer
  };
});

/* ── 权重预演：照搬 14-boot-brain-hub.js 的 brainWeight，算出有多少条一进去就是「已淡去」 ── */
const HALFLIFE = 14, MIN_W = 0.05;
function brainWeight(m, now) {
  const imp = (m.importance || 5) / 10;
  if (m.pinned) return Math.max(1.2, imp * 1.5);
  const intensity = Math.min(1, Math.abs(m.valence || 0) * 0.5 + (m.arousal || 0) * 0.5);
  const halfLife = HALFLIFE * (0.5 + imp) * (1 + 2 * intensity);
  const days = Math.max(0, now - (m.lastAccess || m.createdAt)) / 86400000;
  return imp * Math.exp(-Math.LN2 * days / halfLife) * (m.resolved ? 0.35 : 1) * (1 + 0.4 * intensity);
}

const faded = out.filter(m => !m.pinned && brainWeight(m, NOW) < MIN_W);
const byLayer = {};
for (const m of out) (byLayer[m._layer] = byLayer[m._layer] || { n: 0, faded: 0 }).n++;
for (const m of faded) byLayer[m._layer].faded++;

const dupText = new Map();
for (const m of out) {
  const k = m.text.trim().toLowerCase();
  dupText.set(k, (dupText.get(k) || 0) + 1);
}
const dups = [...dupText.values()].filter(v => v > 1).length;

console.log(`源目录  ${SRC}`);
console.log(`时间策略 --time ${MODE}` + (MODE === 'shift' ? `（整体前移 ${Math.round(SHIFT / 86400000)} 天）` : ''));
console.log(`解析    ${parsed.length} / ${files.length} 个 md` + (skipped.length ? `（跳过 ${skipped.length}）` : ''));
for (const [f, why] of skipped.slice(0, 5)) console.log(`   跳过 ${path.basename(f)} — ${why}`);
console.log('');
console.log('层级         条数   其中已淡去(不再注入)');
for (const [k, v] of Object.entries(byLayer)) {
  console.log(`  ${k.padEnd(10)} ${String(v.n).padStart(4)}   ${String(v.faded).padStart(4)}`);
}
console.log(`  ${'合计'.padEnd(9)} ${String(out.length).padStart(4)}   ${String(faded.length).padStart(4)}  (${Math.round(faded.length / out.length * 100)}%)`);
console.log('');
console.log(`钉住(pinned)   ${out.filter(m => m.pinned).length}`);
console.log(`已解决(resolved) ${out.filter(m => m.resolved).length}`);
console.log(`text 重复的组数  ${dups}（导入时按 text 去重，不会生成双份）`);
console.log(`JSON 体积       ${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0)} KB`);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  console.log(`\n已写出 → ${OUT}`);
} else {
  console.log('\n(dry run — 加 --out <文件> 才落盘)');
}
