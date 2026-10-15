// 压缩挑缓存冷的时候做（2026-10-03）。
// 摘要进 system 稳定段，每折一批前缀就变：订阅 Claude 整段重开 CLI 会话、API 前缀缓存作废。
// 缓存热着时先不折（除非撞硬线），冷了再折。跑真的 js/05-continuity-compaction.js（vm 沙箱）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js', '05-continuity-compaction.js'), 'utf8');

let fetchCalls = 0, inflight = 0, maxInflight = 0;
let mode = 'ok';
const logs = [];
function okNote(prompt) {
  const ids = [...prompt.matchAll(/<message id="([^"]+)"/g)].map(m => m[1]);
  return `事件与事实: 覆盖 ${ids[0]} 起的这一批，足够长的摘要文本用来通过长度校验。\n时间线:\n纠正与偏好:\n关系与情绪:\n当前状态与未解决事项:\n来源ID: ` + ids.join(', ');
}
const ctx = {
  console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error: console.error },
  state: { thinkSumKey: 'k1' },
  estimateTokens: text => Math.ceil(String(text || '').length / 2),
  stickerTagForApi: text => String(text || ''),
  save: () => {},
  fetch: async (url, opts) => {
    fetchCalls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 5));
    inflight--;
    if (mode === 'fail') return { ok: false, status: 503, json: async () => ({}) };
    const prompt = JSON.parse(opts.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: okNote(prompt) } }] }) };
  },
  setTimeout,
  clearTimeout
};
vm.createContext(ctx);
vm.runInContext(source, ctx);

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

const MIN = 60e3;
const LOCAL = { id: 2, nickname: '订阅', isLocalClaude: true };
const API = { id: 7, nickname: 'api' };
// n 条 × per tokens；AI 回复挂 modelId 和 timestamp（最后一条 AI 在 lastAgo 之前发出）
function makePath(prefix, conf, lastAgoMs, n = 20, per = 1000) {
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    const ai = i % 2 === 1;
    out.push({ id: `${prefix}${i}`, role: ai ? 'ai' : 'user', content: 'x'.repeat(10), tokens: per,
      ...(ai ? { modelId: conf.id, timestamp: now - lastAgoMs - (n - i) * 1000 } : { timestamp: now - (n - i) * 1000 }) });
  }
  // 最后一条是她刚发的这句
  out.push({ id: `${prefix}u`, role: 'user', content: 'x', tokens: 10, timestamp: now });
  return out;
}
async function prep(p, chat, conf, opts) {
  const before = fetchCalls;
  const out = await ctx.continuityPreparePath(p, chat, conf, opts);
  return { calls: fetchCalls - before, out };
}

(async () => {
  // ── 纯判据 ──
  check('订阅 Claude 按 1 小时算', ctx.promptCacheTtlMs(LOCAL) === 60 * MIN);
  check('其它通道按 5 分钟算', ctx.promptCacheTtlMs(API) === 5 * MIN && ctx.promptCacheTtlMs({ id: 9, apiBase: 'https://api.anthropic.com/v1/messages' }) === 5 * MIN);

  {
    const p = makePath('a', LOCAL, 10 * MIN);
    check('只认同一个模型的回复：别的模型回过话不算热', ctx.continuityLastReplyAt(p, { id: 999 }) === 0);
    check('同一个模型：取最后一条 AI 回复的时间', ctx.continuityLastReplyAt(p, LOCAL) > 0);
    const streaming = [...p.slice(0, -1), { id: 'ph', role: 'ai', modelId: LOCAL.id, timestamp: Date.now(), streaming: true }];
    check('还在流的占位气泡不算上次回复', ctx.continuityLastReplyAt(streaming, LOCAL) === ctx.continuityLastReplyAt(p, LOCAL));
  }

  // ── 订阅 Claude：热着不折 ──
  {
    const chat = { id: 'h1' };
    const r = await prep(makePath('b', LOCAL, 10 * MIN), chat, LOCAL);
    check('缓存热着（10 分钟前 < 1 小时）：不调摘要模型', r.calls === 0, r.calls);
    check('缓存热着：不写压缩状态、原文整段照发', !chat.continuityCompaction[LOCAL.id] && r.out.path.length === 21, r.out.path.length);
    check('先不折要留痕（console 里说为什么）', logs.some(l => /缓存还热/.test(l)));
  }
  // ── 冷了照折 ──
  {
    const chat = { id: 'h2' };
    const r = await prep(makePath('c', LOCAL, 61 * MIN), chat, LOCAL);
    check('缓存冷了（61 分钟）：照常折', r.calls > 0 && chat.continuityCompaction[LOCAL.id] && r.out.summary, r.calls);
  }
  // ── API 通道 5 分钟 ──
  {
    const r1 = await prep(makePath('d', API, 4 * MIN), { id: 'h3' }, API);
    check('API 通道 4 分钟前回过：不折', r1.calls === 0, r1.calls);
    const r2 = await prep(makePath('e', API, 6 * MIN), { id: 'h4' }, API);
    check('API 通道 6 分钟前回过：折', r2.calls > 0, r2.calls);
  }
  // ── 没有时间戳（老数据）照原来的规矩折 ──
  {
    const p = makePath('f', LOCAL, 1 * MIN).map(m => { const { timestamp, ...rest } = m; return rest; });
    const r = await prep(p, { id: 'h5' }, LOCAL);
    check('找不到上次回复时间：当成冷，照折', r.calls > 0, r.calls);
  }
  // ── 硬线：可折叠到 warmHoldMaxTokens 不再等 ──
  {
    const per = Math.ceil(vm.runInContext('CONTINUITY_CFG.warmHoldMaxTokens', ctx) / 15);
    const r = await prep(makePath('g', LOCAL, 1 * MIN, 22, per), { id: 'h6' }, LOCAL);
    check('热着但可折叠撞上 warmHoldMaxTokens：照折', r.calls > 0, r.calls);
  }
  // ── 硬线：快撑满窗口不再等（不然 buildApiMessages 会无摘要地裁掉旧消息）──
  {
    const r1 = await prep(makePath('h', LOCAL, 1 * MIN), { id: 'h7' }, LOCAL, { historyBudget: 200000 });
    check('窗口宽裕：热着照样不折', r1.calls === 0, r1.calls);
    const r2 = await prep(makePath('i', LOCAL, 1 * MIN), { id: 'h8' }, LOCAL, { historyBudget: 20000 });
    check('原文 ~20k 已超窗口预算 80%：热着也折', r2.calls > 0, r2.calls);
  }
  // ── 先不折不是一次尝试：不碰退避计数 ──
  {
    const chat = { id: 'h9' };
    mode = 'fail';
    await prep(makePath('j', LOCAL, 61 * MIN), chat, LOCAL);       // 冷 → 折 → 失败一次
    const b = ctx._continuityBackoff.get(`h9:${LOCAL.id}`);
    check('冷了折失败记一次退避', b && b.fails === 1, b);
    const hot = makePath('j', LOCAL, 1 * MIN);
    const r = await prep(hot, chat, LOCAL);                         // 热 → 先不折
    const b2 = ctx._continuityBackoff.get(`h9:${LOCAL.id}`);
    check('热着先不折：不打模型、退避计数原样留着', r.calls === 0 && b2 && b2.fails === 1 && b2.skip === 1, b2);
    mode = 'ok';
  }
  // ── 各批并发摘要，顺序不乱 ──
  {
    const chat = { id: 'h10' };
    maxInflight = 0;
    // 30 条 × 1000：可折叠 ~25 条、5 批左右
    const r = await prep(makePath('k', LOCAL, 61 * MIN, 30), chat, LOCAL);
    check('冷了一次折好几批：摘要并发跑（不让她干等 N 次）', r.calls >= 3 && maxInflight >= 2, { calls: r.calls, maxInflight });
    const s = String(chat.continuityCompaction[LOCAL.id]?.summary || '');
    const order = [...s.matchAll(/覆盖 (k\d+) 起/g)].map(m => Number(m[1].slice(1)));
    check('并发后摘要仍按原文顺序拼', order.length === r.calls && order.every((v, i) => i === 0 || v > order[i - 1]), order);
  }

  // ── 接线：buildApiMessages 真把窗口预算传进来了 ──
  {
    const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8');
    check('buildApiMessages 把 historyBudget 传给压缩', /continuityPreparePath\(path, chat, conf,\s*\{ historyBudget: windowLimit - estimateTokens\(systemPrompt\)(, isolated: _isoDropped > 0)? \}\)/.test(api));
    // promptCacheTtlMs 给 API 通道按 5 分钟算，依据是「历史断点是默认 5m」。
    // 哪天历史断点也改成 1h，这条红 —— 回去改 promptCacheTtlMs。
    const fn = api.slice(api.indexOf('function applyPromptCache('), api.indexOf('function applyPromptCache(') + 2000);
    const hist = fn.slice(fn.indexOf('② 历史断点'));
    check('官方 Anthropic 历史断点仍是默认 5m（promptCacheTtlMs 的前提）', hist && !/ttl/.test(hist.slice(0, hist.indexOf('\n}'))));
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('server 把订阅 Claude 的缓存账落进 local-claude.log', /claudeLog\(`用量 缓存读=\$\{u\.cache_read_input_tokens \|\| 0\}/.test(srv));
  }

  // ── 真跑 buildApiMessages：抠原函数 + 真压缩文件，看发出去的 system 和条数 ──
  {
    const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = api.indexOf('async function buildApiMessages(');
    const b = api.indexOf('// ═══════════════════════════════════════════════════════\n// WEB SEARCH', a);
    if (a < 0 || b < 0) throw new Error('抠不到 buildApiMessages');
    const box = {
      console: { log() {}, warn() {}, error() {} }, state: { thinkSumKey: 'k1' },
      Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error,
      setTimeout, clearTimeout, fetch: ctx.fetch,
      buildSystemPrompt: (conf, chat, last, p, out) => { out.stable = 'SYS'; out.volatile = ''; return 'SYS'; },
      estimateTokens: s => Math.ceil(String(s || '').length / 2),
      stickerTagForApi: s => String(s || ''),
      showToast() {}, _ctxWarnedFor: new Set(), save() {},
    };
    vm.createContext(box);
    vm.runInContext(source + '\n' + api.slice(a, b) + '\nthis.buildApiMessages = buildApiMessages;', box);
    const big = { ...LOCAL, maxTokens: 999999, maxReplyTokens: 4000 };
    const sysOf = msgs => String(msgs[0].content || '');
    const hot = await box.buildApiMessages(makePath('w', big, 10 * MIN), big, false, { id: 'w1' });
    check('真接线·热着：system 里没有摘要，21 条原文全发', !sysOf(hot).includes('<earlier_continuity>') && hot.length === 22, hot.length);
    const cold = await box.buildApiMessages(makePath('v', big, 61 * MIN), big, false, { id: 'w2' });
    check('真接线·冷了：system 带上摘要，只发尾巴', sysOf(cold).includes('<earlier_continuity>') && cold.length < 22, cold.length);
    // 窗口 26000 - 回复 4000 - 64 = 21936 可用；原文 ~20k > 80% → 热着也得折
    const tight = { ...LOCAL, maxTokens: 26000, maxReplyTokens: 4000 };
    const t = await box.buildApiMessages(makePath('y', tight, 1 * MIN), tight, false, { id: 'w3' });
    check('真接线·窗口紧：热着也折（窗口预算真传进去了）', sysOf(t).includes('<earlier_continuity>'), t.length);
  }

  console.log(`\ncompaction-cache-hold: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('✗ 崩了', e); process.exitCode = 1; });
