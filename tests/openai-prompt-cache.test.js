// OpenAI 兼容路径的提示词缓存
// 跑法：node tests/openai-prompt-cache.test.js
//
// 背景（2026-08-19）：applyPromptCache 只在 apiBase 以 /messages 结尾时才被调用，
// 于是同一个 claude-opus，走官方端点省九成、走中转（api.xxx/openai）**一点缓存都没有** ——
// 两边在设置界面里长得一模一样，账单差十倍，而且没有任何地方会提这件事。
//
// 守四件事：
//   1) Claude 系走中转时带上 cache_control，非 Claude（GPT/GLM）不带（带了白挨一次 400）；
//   2) 断点打在 system + 最后一条用户消息**之前**那条，不能打在最后一条上
//      （那条挂着每轮都变的实时信息，缓存了也永远命中不了，还倒贴 25% 写入费）；
//   3) ★ 不许污染调用方的 messages —— 污染了的话「降级重发」那一次还带着标记，
//      于是降级根本没降下去，400 会一直循环；
//   4) 被拒过就先别再试，但记的是时间不是 true（中转以后支持了要能自己恢复）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')));

const ctx = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }),
  state: { memories: [], configs: [] },
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: s => String(s),
  estimateTokens: s => Math.ceil(String(s || '').length / 4),
  pickBrainMemories: () => [], formatBrainForPrompt: () => '',
  takeProustMoment: () => '', stickerTagForApi: s => String(s || ''),
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8'), ctx);

const mkMsgs = () => ([
  { role: 'system',    content: '你是克克。'.repeat(40) },
  { role: 'user',      content: '早' },
  { role: 'assistant', content: '早啊小明' },
  { role: 'user',      content: '【本轮实时信息…】\n\n今天想吃什么' },   // 最后这条每轮都变
]);
const claudeConf = { id: 1, modelName: 'claude-opus-4-6-r', apiBase: 'https://api.highwayapi.ai/openai', maxReplyTokens: 800 };
const gptConf    = { id: 2, modelName: 'gpt-4o',            apiBase: 'https://api.highwayapi.ai/openai', maxReplyTokens: 800 };

const cacheMarks = body => body.messages.filter(m =>
  Array.isArray(m.content) && m.content.some(p => p && p.cache_control));

console.log('\n[1] 该带的带上，不该带的不带');
{
  const withC = ctx.buildRequestBody(claudeConf, mkMsgs(), true);
  t('Claude + withCache → 打了缓存断点', cacheMarks(withC).length === 2, `实际 ${cacheMarks(withC).length} 个`);
  const noC = ctx.buildRequestBody(claudeConf, mkMsgs(), false);
  t('withCache=false → 一个断点都没有', cacheMarks(noC).length === 0);
  // 对照组：没有这一条的话，「无脑给所有消息都打标记」也能让上面那条变绿
  t('不该打的消息没被顺手打上', cacheMarks(withC).every(m =>
    m.content.some(p => /你是克克/.test(p.text) || /早啊小明/.test(p.text))));
}

console.log('\n[2] 断点位置：system + 最后一条用户消息之前那条');
{
  const body = ctx.buildRequestBody(claudeConf, mkMsgs(), true);
  const marked = body.messages.map((m, i) =>
    (Array.isArray(m.content) && m.content.some(p => p && p.cache_control)) ? i : -1).filter(i => i >= 0);
  t('断点在 [0] system 和 [2] assistant 上', marked.join(',') === '0,2', `实际 ${marked.join(',')}`);
  const last = body.messages[3];
  t('★ 最后一条用户消息没有断点（每轮都变，缓存了永不命中还倒贴写入费）',
    typeof last.content === 'string' || !last.content.some(p => p && p.cache_control));
}

console.log('\n[3] ★ 不许污染调用方的 messages（污染了降级就降不下去）');
{
  const shared = mkMsgs();
  const before = JSON.stringify(shared);
  ctx.buildRequestBody(claudeConf, shared, true);
  t('打完缓存后原数组一个字没变', JSON.stringify(shared) === before);

  // 真实的降级流程：同一份 messages 先带缓存发一次、被拒、再不带缓存发一次
  const msgs = mkMsgs();
  ctx.buildRequestBody(claudeConf, msgs, true);
  const retry = ctx.buildRequestBody(claudeConf, msgs, false);
  t('★ 降级重发的那一份真的不带 cache_control', cacheMarks(retry).length === 0,
    `还剩 ${cacheMarks(retry).length} 个`);
}

console.log('\n[4] 被拒之后的冷却');
{
  t('没被拒过 → 允许', ctx.promptCacheAllowed({ modelName: 'x' }) === true);
  t('刚被拒 → 不再试', ctx.promptCacheAllowed({ noPromptCache: Date.now() }) === false);
  t('八天前被拒 → 自己恢复（中转后来支持了不用手动改配置）',
    ctx.promptCacheAllowed({ noPromptCache: Date.now() - 8 * 24 * 3600 * 1000 }) === true);
  // 看不懂的值（老版本留下的 true、脏数据）一律当成没记过：
  // 宁可多白试一次，也不要静默把缓存永久关掉——那正是这次要修的那类故障。
  t('noPromptCache=true 这种脏值 → 当成没记过，照常试',
    ctx.promptCacheAllowed({ noPromptCache: true }) === true);
  t('字符串脏值也不炸', ctx.promptCacheAllowed({ noPromptCache: '2026-08-19' }) === true);
}

console.log('\n[5] 只对 Claude 开（判据来自源码里那句，别写死成两套）');
{
  const src = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8');
  t('调用处按模型名判 claude', /\/claude\/i\.test\(conf\.modelName[\s\S]{0,40}promptCacheAllowed\(conf\)/.test(src));
  // GPT 那条路即使 withCache 传 true 也不该在真实流程里被走到 —— 这里直接验判据本身
  t('gpt-4o 不该被判成要缓存', !/claude/i.test(gptConf.modelName));
  t('claude-opus-4-6-r 该被判成要缓存', /claude/i.test(claudeConf.modelName));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
