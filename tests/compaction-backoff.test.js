// 连续性压缩失败退避：失败后不再每条消息都重打一次模型。
// 跑真的 js/05-continuity-compaction.js（vm 沙箱），fetch 由测试控制并计数。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', '05-continuity-compaction.js'), 'utf8');

let fetchCalls = 0;
let mode = 'fail';
function okNote(prompt) {
  const ids = [...prompt.matchAll(/<message id="([^"]+)"/g)].map(m => m[1]);
  return '事件与事实: 一些事实，足够长的摘要文本用来通过长度校验。\n时间线:\n纠正与偏好:\n关系与情绪:\n当前状态与未解决事项:\n来源ID: ' + ids.join(', ');
}
const ctx = {
  console: { log() {}, warn() {}, error: console.error },
  state: { thinkSumKey: 'k1' },
  estimateTokens: text => Math.ceil(String(text || '').length / 2),
  stickerTagForApi: text => String(text || ''),
  save: () => {},
  fetch: async (url, opts) => {
    fetchCalls++;
    if (mode === 'fail') return { ok: false, status: 503, json: async () => ({}) };
    const prompt = JSON.parse(opts.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: okNote(prompt) } }] }) };
  },
  setTimeout,
  clearTimeout
};
vm.createContext(ctx);
vm.runInContext(source, ctx);

// 20 条 × 1000 tokens：尾巴留 ~5000，可折叠 15 条 / 15000 tokens，必触发压缩
function makePath(prefix) {
  const out = [];
  for (let i = 0; i < 20; i++) out.push({ id: `${prefix}${i}`, role: i % 2 ? 'ai' : 'user', content: 'x'.repeat(10), tokens: 1000 });
  return out;
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('✓', name);
  else { failed++; console.error('✗', name, detail === undefined ? '' : detail); }
}

async function rounds(p, chat, conf, n) {
  const before = fetchCalls;
  const pattern = [];
  for (let i = 0; i < n; i++) {
    const b = fetchCalls;
    await ctx.continuityPreparePath(p, chat, conf);
    pattern.push(fetchCalls - b);
  }
  return { total: fetchCalls - before, pattern: pattern.join('') };
}

(async () => {
  const conf = { id: 'model', nickname: 'm' };

  // 1) 持续失败：第 1、3、6、11 轮才真的打模型（跳 1、2、4 轮）
  {
    mode = 'fail';
    const chat = { id: 'c1' };
    const r = await rounds(makePath('a'), chat, conf, 11);
    check('持续失败时按 1→2→4 轮指数退避（11 轮只打 4 次）', r.pattern === '10100100001', r.pattern);
    check('失败时不写压缩状态', !chat.continuityCompaction.model, JSON.stringify(chat.continuityCompaction));
  }

  // 2) 退避封顶
  {
    mode = 'fail';
    const chat = { id: 'c2' };
    const key = 'c2:model';
    for (let i = 0; i < 10; i++) ctx.continuityBackoffFail(key);
    const b = ctx._continuityBackoff.get(key);
    check('退避轮数封顶在 MAX_SKIP', b.skip === ctx.CONTINUITY_BACKOFF_MAX_SKIP, JSON.stringify(b));
    ctx._continuityBackoff.delete(key);
  }

  // 3) 成功一次清零：失败→跳过→成功→再失败时只跳 1 轮
  {
    mode = 'fail';
    const chat = { id: 'c3' };
    const p = makePath('b');
    await rounds(p, chat, conf, 1);                 // fail #1, skip 1
    await rounds(p, chat, conf, 1);                 // skipped
    mode = 'ok';
    const s = await rounds(p, chat, conf, 1);       // success
    check('退避期满后成功压缩', s.total > 0 && chat.continuityCompaction.model && chat.continuityCompaction.model.summary, s);
    check('成功后退避状态清掉', !ctx._continuityBackoff.has('c3:model'));
    // 边界推进后需要新的可折叠内容才会再压：换一条更长的路径
    const p2 = p.concat(makePath('c'));
    mode = 'fail';
    const r = await rounds(p2, chat, conf, 3);
    check('成功清零后再失败从头开始退避（打/跳/打）', r.pattern === '101', r.pattern);
  }

  // 4) 换了 thinkSumKey 立刻重试，不用等退避
  {
    mode = 'fail';
    const chat = { id: 'c4' };
    const p = makePath('d');
    await rounds(p, chat, conf, 2);                 // fail #1 + skip
    await rounds(p, chat, conf, 1);                 // fail #2 → skip 2
    ctx.state.thinkSumKey = 'k2';
    const r = await rounds(p, chat, conf, 1);
    check('换 key 后下一轮直接重试', r.total === 1, r);
    ctx.state.thinkSumKey = 'k1';
  }

  // 5) 同一 run 被两处同时 await 只记一次失败
  {
    mode = 'fail';
    const chat = { id: 'c5' };
    const p = makePath('e');
    const before = fetchCalls;
    await Promise.all([ctx.continuityPreparePath(p, chat, conf), ctx.continuityPreparePath(p, chat, conf)]);
    const b = ctx._continuityBackoff.get('c5:model');
    check('并发两处 await 只打一次模型、只记一次失败', fetchCalls - before === 1 && b && b.fails === 1, { calls: fetchCalls - before, b });
  }

  // 6) 退避中仍然用旧摘要裁剪路径（不因为跳过压缩而把旧摘要丢了）
  {
    mode = 'fail';
    const p = makePath('f');
    const chat = { id: 'c6', continuityCompaction: { model: { untilId: 'f1', summary: '旧摘要' } } };
    await ctx.continuityPreparePath(p, chat, conf);           // 失败一次，进入退避
    const out = await ctx.continuityPreparePath(p, chat, conf); // 被跳过
    check('退避跳过的这轮仍注入旧摘要并从边界后发送', out.summary === '旧摘要' && out.path[0].id === 'f2', { s: out.summary, first: out.path[0] && out.path[0].id });
  }

  if (failed) { console.error(`\n${failed} 项失败`); process.exitCode = 1; }
  else console.log('\ncompaction-backoff: 全部通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
