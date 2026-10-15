/* Chunked continuity compaction.
   Raw nodes are never deleted: this only controls what is sent to a model. The
   accepted summary and boundary live on the chat, so backups/cloud sync carry
   them across windows without adding another state whitelist. */
const CONTINUITY_CFG = Object.freeze({
  rawTailTokens: 5000,
  foldableTriggerTokens: 8000,
  minimumMessages: 10,
  batchMaxTokens: 5000,
  summaryMaxChars: 24000,
  // 缓存热着时的硬线：可折叠部分涨到这么多就不等了，照折（见 continuityPlan）
  warmHoldMaxTokens: 40000,
  // 没折的原文占「历史还剩的窗口」超过这个比例也不等 —— 再等下去 buildApiMessages
  // 就要从头裁消息了，那是不带摘要的静默失忆，比重写一次缓存坏得多
  warmHoldBudgetRatio: 0.8
});

/* ── 压缩挑缓存冷的时候做（2026-10-03）──────────────────────────────
   摘要进的是 system 的稳定段（见 buildApiMessages）。每折一批，前缀就变：
   订阅 Claude 判「系统提示结构变了」整段重开 CLI 会话，API 通道的前缀缓存整段作废。
   缓存还热的时候这一下是纯亏 —— 折掉 8k 原文每轮省 0.1×8k 的缓存读，
   换来一次 ~2×(系统提示+摘要+尾巴) 的重写，要七十来轮才回本。
   10-03 15:52 实录：上一句 3 分钟前、缓存热着，一折 63 条→26 条，CLI 整段重写 3 万多 token。
   缓存已经冷了就反过来：反正要整段重写，折了写得更少。

   所以：距这个模型上次回复不到缓存 TTL → 先不折，除非撞上硬线（上面两条）。
   判据只在这一个文件里：这里是唯一决定折不折的地方，服务端不碰压缩。 */

// 这个模型的提示缓存多久过期。改了 applyPromptCache / server 的缓存方式要回来改这里。
//   订阅 Claude：claude -p --resume，CLI 写的是 1h 缓存（会话 jsonl 里 ephemeral_1h_input_tokens，10-03 实测）
//   其它：5 分钟。官方 Anthropic 端点 system 段是 1h，但对话历史断点是默认 5m ——
//         折叠砍的是历史，过了 5 分钟历史那段本来就得重写，这时候折正好。
//         中转 Claude、GPT、Gemini、DeepSeek 的自动缓存都按 5 分钟算（宁可早折，行为贴近原来）。
function promptCacheTtlMs(conf) {
  return conf && conf.isLocalClaude ? 3600e3 : 5 * 60e3;
}

// 这个模型在这条分支上最近一次回复是什么时候发出的（节点的 timestamp 是请求发出那一刻建的）。
// 只认同一个模型：别的模型回过话不会让这个模型的缓存变热。
// 找不到就是 0 —— 当成冷，照原来的规矩折。
function continuityLastReplyAt(path, conf) {
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i];
    if (!m || m.role !== 'ai' || m.streaming) continue;
    if (m.modelId != null && conf && String(m.modelId) !== String(conf.id)) continue;
    const t = Number(m.timestamp);
    if (t > 0) return t;
  }
  return 0;
}

// 折不折、为什么。纯函数，不碰网络和状态。
//   action: 'none'（不够折） | 'hold'（够了但缓存热，先等） | 'fold'
// opts.historyBudget：系统提示之外，窗口里还剩给历史的 token；不传就不看窗口。
// opts.now：测试用。
function continuityPlan(path, saved, conf, opts = {}) {
  const start = continuityRawStart(path, saved);
  const pending = path.slice(start);
  let tailTokens = 0, tailStart = pending.length;
  while (tailStart > 0 && tailTokens < CONTINUITY_CFG.rawTailTokens) {
    tailTokens += continuityTokens(pending[--tailStart]);
  }
  const foldable = pending.slice(0, tailStart);
  const foldTokens = foldable.reduce((s, m) => s + continuityTokens(m), 0);
  const plan = { action: 'none', foldable, foldTokens, tailTokens, reason: '' };
  if (foldable.length < CONTINUITY_CFG.minimumMessages || foldTokens < CONTINUITY_CFG.foldableTriggerTokens) return plan;

  plan.action = 'fold';
  const last = continuityLastReplyAt(path, conf);
  const ttl = promptCacheTtlMs(conf);
  const age = (opts.now || Date.now()) - last;
  if (!last || age >= ttl) { plan.reason = last ? `缓存已冷（距上次回复 ${Math.round(age / 6e4)} 分钟）` : '没有上次回复'; return plan; }
  if (foldTokens >= CONTINUITY_CFG.warmHoldMaxTokens) { plan.reason = `缓存热着但可折叠已到硬线 ~${foldTokens}`; return plan; }
  const budget = Number(opts.historyBudget);
  if (Number.isFinite(budget) && foldTokens + tailTokens > budget * CONTINUITY_CFG.warmHoldBudgetRatio) {
    plan.reason = `缓存热着但原文 ~${foldTokens + tailTokens} 快撑满窗口（历史可用 ${Math.max(0, Math.round(budget))}）`;
    return plan;
  }
  plan.action = 'hold';
  plan.reason = `缓存还热（距上次回复 ${Math.round(age / 6e4)} 分钟 < ${Math.round(ttl / 6e4)}），可折叠 ~${foldTokens} tokens 先不折`;
  return plan;
}

var _continuityRuns = new Map();

// 压缩失败后的退避（只在内存里，刷新即清零）。
// 以前失败了下一条消息就立刻再压一次：DeepSeek 挂着/摘要撞上 summaryMaxChars 封顶/
// 校验老不过时，每发一条消息都白花 1～2 次模型调用，而且永远不会自己好。
// 现在同一对话×模型连续失败 n 次后，跳过接下来 min(2^(n-1), MAX_SKIP) 轮再试；
// 成功一次清零。换了 thinkSumKey 也清零 —— 多半是在修 key，别让她干等。
var _continuityBackoff = new Map(); // `${chat.id}:${conf.id}` -> { fails, skip, sumKey }
var CONTINUITY_BACKOFF_MAX_SKIP = 32;

function continuityBackoffSkip(key) {
  const b = _continuityBackoff.get(key);
  if (!b) return false;
  if (b.sumKey !== state.thinkSumKey) { _continuityBackoff.delete(key); return false; }
  if (b.skip > 0) { b.skip--; return true; }
  return false;
}

function continuityBackoffFail(key) {
  const b = _continuityBackoff.get(key) || { fails: 0, skip: 0, sumKey: state.thinkSumKey };
  b.fails++;
  b.skip = Math.min(2 ** (b.fails - 1), CONTINUITY_BACKOFF_MAX_SKIP);
  b.sumKey = state.thinkSumKey;
  _continuityBackoff.set(key, b);
}

function continuityTokens(m) {
  const raw = m?.variants ? (m.variants[m.chosenVariant ?? 0]?.content || '') : (m?.content || '');
  return Number(m?.tokens) || estimateTokens(typeof stickerTagForApi === 'function' ? stickerTagForApi(raw) : raw);
}

function continuityText(m) {
  const raw = m?.variants ? (m.variants[m.chosenVariant ?? 0]?.content || '') : (m?.content || '');
  return typeof stickerTagForApi === 'function' ? stickerTagForApi(raw) : String(raw || '');
}

function continuityStateFor(chat, conf) {
  if (!chat || !conf) return null;
  if (!chat.continuityCompaction || typeof chat.continuityCompaction !== 'object') chat.continuityCompaction = {};
  return chat.continuityCompaction[String(conf.id)] || null;
}

function continuityRawStart(path, saved) {
  if (!saved?.untilId) return 0;
  const idx = path.findIndex(m => String(m.id) === String(saved.untilId));
  // Branch/edit no longer contains the accepted boundary: never inject a summary
  // produced from a different branch.
  return idx < 0 ? 0 : idx + 1;
}

function continuityBatches(messages) {
  const turns = [];
  for (let i = 0; i < messages.length;) {
    const one = [messages[i++]];
    if (one[0]?.role === 'user' && messages[i]?.role === 'ai') one.push(messages[i++]);
    turns.push({ messages: one, tokens: one.reduce((s, m) => s + continuityTokens(m), 0) });
  }
  const batches = [];
  for (const turn of turns) {
    const prev = batches[batches.length - 1];
    if (prev && prev.tokens + turn.tokens <= CONTINUITY_CFG.batchMaxTokens) {
      prev.messages.push(...turn.messages); prev.tokens += turn.tokens;
    } else {
      batches.push({ messages: [...turn.messages], tokens: turn.tokens });
    }
  }
  return batches;
}

function continuityPrompt(batch) {
  const source = batch.messages.map(m => {
    const role = m.role === 'user' ? '用户' : '助手';
    return `<message id="${String(m.id)}" role="${role}">\n${continuityText(m)}\n</message>`;
  }).join('\n\n');
  return `你在为长对话生成内部连续性笔记，不是在回复用户。优先保留事实、时间线、用户纠正、偏好、决定、关系状态和未解决事项。\n`
    + `只依据下面消息，不推测。必须以“来源ID:”结尾并列出所有实际覆盖的 id。\n`
    + `固定字段：\n事件与事实:\n时间线:\n纠正与偏好:\n关系与情绪:\n当前状态与未解决事项:\n来源ID:\n\n${source}`;
}

function continuityValidate(text, batch) {
  const value = String(text || '').trim();
  if (value.length < 40 || /^(抱歉|对不起|sorry|i cannot|i can't)/i.test(value)) return false;
  if (!/来源ID\s*[:：]/i.test(value) || !/事件与事实\s*[:：]/.test(value)) return false;
  const allowed = batch.messages.map(m => String(m.id));
  return allowed.every(id => new RegExp(`(^|[^0-9A-Za-z_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z_-]|$)`).test(value));
}

async function continuitySummarize(batch, retry = false) {
  if (!state.thinkSumKey) throw new Error('missing thinkSumKey');
  const prompt = continuityPrompt(batch) + (retry ? '\n\n上次输出未通过校验。严格补齐字段与每个来源ID，不要写对话回复。' : '');
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.thinkSumKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 900, stream: false, temperature: 0 })
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}`);
  const json = await resp.json();
  return String(json.choices?.[0]?.message?.content || '').trim();
}

async function continuityCompact(plan, chat, conf, saved) {
  const { foldable, foldTokens, tailTokens } = plan;
  if (plan.action !== 'fold') return saved;

  // 等缓存冷了才折，一次可能攒到 warmHoldMaxTokens（8 批左右），全串行的话她回来发的
  // 第一句要干等八次 DeepSeek。所以：第一批单独打（DeepSeek 挂着/key 坏了只白花一次，
  // 退避那套的账才对得上），通了再把剩下的并发打出去。顺序由下标保住；任何一批不过就整轮作废（同原来）。
  const summarizeOne = async batch => {
    let note = await continuitySummarize(batch, false);
    if (!continuityValidate(note, batch)) note = await continuitySummarize(batch, true);
    if (!continuityValidate(note, batch)) throw new Error('summary validation failed');
    return note;
  };
  const batches = continuityBatches(foldable);
  const first = await summarizeOne(batches[0]);
  const notes = [first, ...await Promise.all(batches.slice(1).map(summarizeOne))];
  const previous = String(saved?.summary || '').trim();
  const summary = [previous, ...notes].filter(Boolean).join('\n\n--- 后续连续性 ---\n\n');
  if (summary.length > CONTINUITY_CFG.summaryMaxChars) throw new Error('continuity summary reached safety cap');
  const next = { summary, untilId: String(foldable[foldable.length - 1].id), updatedAt: Date.now(), version: 1, iso: 1 };
  chat.continuityCompaction[String(conf.id)] = next;
  save();
  console.log(`[连续性压缩] ${conf.nickname || conf.id}：压缩 ${foldable.length} 条 / ~${foldTokens} tokens，保留原文尾巴 ~${tailTokens} tokens（${plan.reason}）`);
  return next;
}

async function continuityPreparePath(path, chat, conf, opts = {}) {
  if (!chat || !conf || !Array.isArray(path)) return { path, summary: '' };
  let saved = continuityStateFor(chat, conf);
  if (saved && continuityRawStart(path, saved) === 0) saved = null;
  // 模型隔离（05-prompts-api.js 的 modelIsolatePath）之前折的摘要，可能把别家模型那几轮也写进去了。
  // 这条路径真拿掉过别家的轮时，只认隔离之后折的（iso:1），旧的作废重折。
  if (saved && opts.isolated && !saved.iso) saved = null;
  if (state.thinkSumKey) {
    const key = `${chat.id}:${conf.id}`;
    // 先判折不折。'hold' 不是一次尝试：不进 run、不碰退避（不然一次「等等」会把失败计数清零）
    const plan = _continuityRuns.has(key) ? null : continuityPlan(path, saved, conf, opts);
    if (plan && plan.action === 'hold') console.log(`[连续性压缩] ${conf.nickname || conf.id}：${plan.reason}`);
    // 记账挂在 run 本身上：同一个 run 被多处 await 时只算一次成功/失败
    if (plan && plan.action === 'fold' && !continuityBackoffSkip(key)) {
      _continuityRuns.set(key, continuityCompact(plan, chat, conf, saved)
        .then(r => { _continuityBackoff.delete(key); return r; },
              e => { continuityBackoffFail(key); throw e; })
        .finally(() => _continuityRuns.delete(key)));
    }
    const run = _continuityRuns.get(key);
    if (run) {
      try { saved = await run; }
      catch (e) { console.warn('[连续性压缩] 本轮保留旧摘要与原文：', e.message); }
    }
  }
  const start = continuityRawStart(path, saved);
  return { path: start > 0 ? path.slice(start) : path, summary: String(saved?.summary || '') };
}

function continuityInjectedBlock(summary) {
  if (!String(summary || '').trim()) return '';
  return '\n\n<earlier_continuity>\n更早的对话已压缩为内部连续性笔记。把它当作安静背景，不要提及笔记或压缩本身。\n'
    + String(summary).trim() + '\n</earlier_continuity>';
}
