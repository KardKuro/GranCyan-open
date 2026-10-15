// ============================================================
// [[BREATH: 关键词]] —— 主动翻记忆库
//
// 以前高级记忆只有「浮现」一条路：pickBrainMemories 按她最近三句话挑几条塞进提示词，
// 模型自己想查某件事（「我们上次说好的那个是什么来着」）没有任何办法，只能凭空答或者装记得。
// 用户要的是 Ombre-Brain 原仓库里那个 breath(query)：带关键词去库里捞，
// 捞出来的用 DeepSeek「脱水」压一遍再交回去。
//
// 链路（照 [[LYRICS:]] 那套「先取好 → 换提示块 → 当轮续写」）：
//   ① 收尾时 processAiCommands 之前 await breathPrefetch：检索（+脱水）结果挂 state.breathWant[confId]
//   ② processBreathTags / _applyBreathToBlocks：标签换成提示块（只读结果，不再检索第二次）
//   ③ lookupChainReasons 看见 breathPending → 当轮续写；buildSystemPrompt 把结果摊进 volatile，摊一次就清
//   ④ 回填历史 stickerTagForApi：提示块咬回正牌 [[BREATH: 关键词]]（历史就是教材）
// 结果不进聊天记录：几条记忆几百字，每轮回填历史白烧。要再看就再写一次。
//
// 检索两路并起来（同浮现）：词法（IDF 余弦 + 关键词字面命中）+ 语义（bge 向量，模型加载好了才有）。
// 跟浮现不同的地方：
//   · 不看遗忘曲线门槛 —— 淡掉的记忆浮现不出来，但她/它主动问的时候必须翻得到。
//   · 不受 1200 字浮现预算管，有自己的上限（BREATH_TOP 条 / BREATH_CHARS 字）。
//   · 翻到的算「被想起」，刷新 lastAccess（同 Ombre：越常想起越不容易忘）。
// 权限照旧走 memoryAllowedForModel：没授权给这个模型的记忆，它翻也翻不到。
// ============================================================

const BREATH_LABEL = '🌬 翻了翻记忆';
const BREATH_MAX_Q = 2;               // 一条回复最多翻两次
const BREATH_TOP = 8;                 // 一次最多交回几条
const BREATH_VEC_SLOTS = 3;           // 其中语义路最多占几条
const BREATH_CHARS = 2400;            // 一次交回最多多少字（没脱水时按这个截）
const BREATH_DEHYDRATE_OVER = 900;    // 原文超过这么多字才叫 DeepSeek 脱水，短的直接给原文
const BREATH_DS_TIMEOUT = 15000;      // 脱水最多等多久，超时就给原文
const BREATH_VEC_WAIT = 2500;         // 语义路查询向量最多等多久

// 全角冒号也认；不带关键词的 [[BREATH]] ＝ 按重要度浮现一批（同 Ombre 不传 query）
function breathTagRe() { return /\[\[BREATH(?:\s*[:：]\s*([^\]]*?))?\s*\]\]/gi; }

function breathPending(confId) {
  const l = state.breathWant && state.breathWant[String(confId)];
  return !!(l && l.length);
}
function breathClear(confId) { if (state.breathWant) delete state.breathWant[String(confId)]; }

// 语义路的查询向量。模型没加载就踢一脚让它后台加载、这次不等（只有词法）
async function _breathQueryVec(q) {
  if (!q || typeof _brainVecOn !== 'function' || !_brainVecOn()) return null;
  try {
    if (!_brainVec.pipe) { _brainVecLoad().then(p => p && _brainVecIndex()); return null; }
    let timer = null;
    const v = await Promise.race([
      _brainVecRun(BRAIN_VEC_QPREFIX + q.slice(0, 256)).then(o => Float32Array.from(o.tolist()[0])),
      new Promise(r => { timer = setTimeout(() => r(null), BREATH_VEC_WAIT); }),
    ]);
    clearTimeout(timer);
    return v;
  } catch (e) { return null; }
}

// 同步检索。qv 是语义路的查询向量（可以没有）。返回 [{ m, why }]，why = 'lex' | 'vec' | 'imp'
function breathSearch(q, modelId, qv) {
  const mems = (state.brainMemories || []).filter(m => m && m.text && memoryAllowedForModel(m, modelId));
  if (!mems.length) return [];
  const now = Date.now();
  q = String(q || '').trim();
  if (!q) {
    return mems.map(m => ({ m, w: brainWeight(m, now) }))
      .sort((a, b) => b.w - a.w).slice(0, BREATH_TOP)
      .map(x => ({ m: x.m, why: 'imp' }));
  }
  if (typeof _brainIdfSyncContent === 'function') _brainIdfSyncContent();
  // 关键词：按空白和常见分隔符切开。字面命中给加分 —— IDF 余弦对两三个字的短查询很不稳，
  // 记忆里一字不差出现了她说的那个词，那条就该排前面。
  const kws = q.toLowerCase().split(/[\s,，、|/;；]+/).filter(Boolean);
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const scored = mems.map(m => {
    const hay = (m.text + ' ' + (m.domain || '')).toLowerCase();
    const rel = brainRelevance(m, q);
    const all = kws.length > 0 && kws.every(k => hay.includes(k));
    const some = kws.filter(k => k.length >= 2 && hay.includes(k)).length;
    let vrel = null;
    if (qv && _brainVec.docs) {
      const d = _brainVec.docs.get(m.id);
      if (d && d.h === _brainVecHash(_brainVecDocText(m))) vrel = dot(qv, d.v);
    }
    const s = rel + (all ? 0.5 : 0) + 0.15 * some;
    return { m, s, vrel, w: brainWeight(m, now) };
  });
  // 词法路：过门限的按分数排；权重只做 ±15% 的微调（主动查的时候「相关」压倒「重要」）
  const lex = scored.filter(x => x.s >= BRAIN_REL_MIN)
    .sort((a, b) => b.s * (0.85 + 0.15 * Math.min(1, b.w)) - a.s * (0.85 + 0.15 * Math.min(1, a.w)));
  const out = [], seen = new Set();
  const take = (x, why) => { if (out.length < BREATH_TOP && !seen.has(x.m)) { seen.add(x.m); out.push({ m: x.m, why }); } };
  // 语义路：向量分不能当门限（无关的问句 top1 也有 0.57），只在「最近的明显比一般的近」时发名额（同 _brainVecMark）
  const withV = scored.filter(x => x.vrel != null);
  let vec = [];
  if (withV.length >= 8) {
    const vs = withV.map(x => x.vrel).sort((a, b) => b - a);
    if (vs[0] - vs[vs.length >> 1] >= BRAIN_VEC_SPREAD) {
      vec = withV.slice().sort((a, b) => b.vrel - a.vrel).slice(0, BREATH_VEC_SLOTS);
    }
  }
  lex.slice(0, BREATH_TOP - Math.min(vec.length, BREATH_VEC_SLOTS)).forEach(x => take(x, 'lex'));
  vec.forEach(x => take(x, 'vec'));
  lex.forEach(x => take(x, 'lex'));   // 语义路没用满的名额还给词法
  return out;
}

function _breathLine(m) {
  const d = m.createdAt ? new Date(m.createdAt) : null;
  const when = d && !isNaN(d) ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : '';
  const flags = [m.pinned ? '钉' : '', m.resolved ? '已解决' : ''].filter(Boolean).join(',');
  return `- [${m.domain || '综合'}|重要${m.importance || 5}${flags ? '|' + flags : ''}${when ? '|' + when : ''}] ${m.text}`;
}

// DeepSeek 脱水（Ombre-Brain dehydrator 的路子）：压掉重复和废话，事实一个不丢。
// 失败、超时、没 key 都退回原文 —— 宁可长一点，也不能因为脱水没成就一条都不给。
async function _breathDehydrate(q, raw) {
  if (!state.thinkSumKey || raw.length <= BREATH_DEHYDRATE_OVER) return null;
  try { if (localStorage.getItem('gc.breathDehydrate') === 'off') return null; } catch (e) {}
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), BREATH_DS_TIMEOUT);
  try {
    const sys = '你是记忆脱水器。下面是从一个人的记忆库里按关键词翻出来的几条记忆，每条一行，方括号里是领域/重要度/日期。'
      + '把它们压缩成紧凑的要点：合并重复的，删掉修饰和废话，但人名、称呼、日期、数字、约定、原话里的关键词一个都不能丢，'
      + '也不许加任何记忆里没有的东西。每条要点保留它的日期。只输出要点，不要开场白和总结。';
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.thinkSumKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat', stream: false, temperature: 0, max_tokens: 900,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: `关键词：${q || '（没给，按重要度翻的）'}\n\n${raw}` }],
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const t = String(j?.choices?.[0]?.message?.content || '').trim();
    // 比原文还长 = 它没在压缩，在扩写；不要
    return t && t.length < raw.length ? t : null;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

// CC 记忆（终端那边 Claude Code 写的）开着的话，顺带去后端按关键词捞全文。
// 系统提示里只有一行摘要；聊天档的订阅 Claude 手上没有读文件的工具，以前想看全文只能回一句「读不了」。
// 只给订阅 Claude：注入本来就只对它生效，别的模型不该看到这些私人记忆。
const BREATH_CC_TIMEOUT = 3000;
async function _breathCc(q, conf) {
  if (!q || !state.ccMemoryEnabled || !conf || !conf.isLocalClaude || typeof SERVER_BASE === 'undefined') return [];
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), BREATH_CC_TIMEOUT);
  try {
    const r = await fetch(SERVER_BASE + '/api/cc-memory/search?q=' + encodeURIComponent(q), { signal: ctrl ? ctrl.signal : undefined });
    const j = r.ok ? await r.json() : null;
    return (j && Array.isArray(j.hits)) ? j.hits : [];
  } catch (e) { return []; }
  finally { clearTimeout(timer); }
}
function _breathCcText(hits) {
  return hits.map(h => `## ${h.name}${h.description ? '：' + h.description : ''}\n${h.body}`).join('\n\n');
}

async function breathLookup(q, conf) {
  const [qv, ccHits] = await Promise.all([_breathQueryVec(q), _breathCc(q, conf)]);
  const cc = ccHits.length ? { n: ccHits.length, text: _breathCcText(ccHits) } : null;
  const hits = breathSearch(q, conf.id, qv);
  if (!hits.length) {
    const r = { q, n: 0 };
    if (cc) r.cc = cc;
    return r;
  }
  const now = Date.now();
  hits.forEach(h => { h.m.lastAccess = now; h.m.accessCount = (h.m.accessCount || 0) + 1; });
  let raw = hits.map(h => _breathLine(h.m)).join('\n');
  const dry = await _breathDehydrate(q, raw);
  let cut = false;
  if (!dry && raw.length > BREATH_CHARS) { raw = raw.slice(0, BREATH_CHARS); cut = true; }
  const r = { q, n: hits.length, text: dry || raw, dry: !!dry, cut, vec: hits.some(h => h.why === 'vec') };
  if (cc) r.cc = cc;
  return r;
}

// callAPI 等收尾时 await（processAiCommands 之前）
async function breathPrefetch(text, conf) {
  if (!conf || !text || !/\[\[BREATH/i.test(String(text)) || !skillOn('breath')) return;
  const qs = [...new Set([...String(text).matchAll(breathTagRe())].map(m => (m[1] || '').trim()))];
  if (!qs.length) return;
  const res = await Promise.all(qs.slice(0, BREATH_MAX_Q).map(q =>
    breathLookup(q, conf).catch(e => ({ q, n: 0, err: (e && e.message) || '翻记忆出错了' }))));
  for (const q of qs.slice(BREATH_MAX_Q)) res.push({ q, n: 0, err: `一条回复最多翻 ${BREATH_MAX_Q} 次，这次没翻` });
  if (!state.breathWant) state.breathWant = {};
  state.breathWant[String(conf.id)] = res;
  if (typeof save === 'function') save();   // lastAccess 刷新了
}

// 提示块。think-body 第一段是关键词（回填历史靠它咬回指令），<br> 后面是翻到几条（不回填）
function breathBlockHtml(q, r) {
  const esc = typeof escHtml === 'function' ? escHtml : (s => String(s));
  const ask = esc(q || '（没给关键词，按重要度翻）');
  const extra = (r && r.cc ? `，还有 CC 记忆 ${r.cc.n} 条` : '');
  const got = !r ? '' : r.err ? `<br>→ ${esc(r.err)}`
    : r.n ? `<br>→ 翻到 ${r.n} 条${r.dry ? '（DeepSeek 脱过水）' : ''}${extra}`
    : extra ? `<br>→ 记忆库没翻到${extra}` : '<br>→ 没翻到';
  return '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)">'
    + '<span class="think-chev">▸</span> <span class="think-label">' + BREATH_LABEL + '</span></div>'
    + '<div class="think-body">' + ask + got + '</div></div>\n\n';
}

function processBreathTags(text, conf) {
  if (!text || !/\[\[BREATH/i.test(String(text))) return text;
  // 技能关着：裸标签抹掉，别漏给她看
  if (!skillOn('breath')) return String(text).replace(breathTagRe(), '');
  const got = (conf && state.breathWant && state.breathWant[String(conf.id)]) || [];
  return String(text).replace(breathTagRe(), (m, q) => {
    q = (q || '').trim();
    return breathBlockHtml(q, got.find(r => r.q === q));
  });
}
function _applyBreathToBlocks(blocks, conf) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) if (b && b.type === 'text' && b.text) b.text = processBreathTags(b.text, conf);
}

// 历史回填：提示块 → [[BREATH: 关键词]]
function breathTagForApi(text) {
  if (!text || String(text).indexOf(BREATH_LABEL) < 0) return text;
  const re = /<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🌬 翻了翻记忆<\/span><\/div><div class="think-body">([^<]*)(?:<br>[\s\S]*?)?<\/div><\/div>/g;
  return String(text).replace(re, (_, q) => {
    q = q.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
    return q && q !== '（没给关键词，按重要度翻）' ? `[[BREATH: ${q}]]` : '[[BREATH]]';
  });
}

function maskStreamingBreath(text) {
  if (!text || !/\[\[BRE/i.test(text)) return text;
  return text
    .replace(/\[\[BREATH(?:\s*[:：][^\]]*)?\s*\]\]/gi, '〔🌬 翻记忆中…〕')
    .replace(/\[\[BRE(?:A(?:T(?:H[^\]]*)?)?)?$/i, '〔🌬 翻记忆中…〕');
}

// 系统提示：说明进 stable（吃缓存），结果进 volatile（摊一次就清）
function breathPromptFor(conf) {
  const out = { stable: '', volatile: '' };
  if (!conf) return out;
  if (skillOn('breath')) {
    out.stable = '\n\n[翻记忆] 每轮「浮现的高级记忆」只是按最近几句话自动挑的几条，库里还有很多没浮上来。'
      + '想确认一件过去的事（她问你还记不记得、你自己想不起细节、要核对说过的约定）时，单独写一行 [[BREATH: 关键词]]，'
      + '我会去整个记忆库里翻，这一轮就把翻到的摆到你眼前，你接着说。关键词写最能代表那件事的一两个词，'
      + '比如 [[BREATH: 生日]]、[[BREATH: 旅行]]。不带关键词的 [[BREATH]] 是按重要度翻一批。'
      + '翻不到就照实说记不清，别编。一条回复最多翻两次。';
  }
  if (breathPending(conf.id)) {
    const list = state.breathWant[String(conf.id)];
    breathClear(conf.id);
    const parts = list.map(r => {
      const who = r.q ? `「${r.q}」` : '（按重要度）';
      if (r.err) return `${who}：没翻成（${r.err}）`;
      const extra = (r.cc ? `\n\n[CC 记忆全文 · 终端那边的 Claude Code 记下的，${r.cc.n} 条，按相关程度排]\n${r.cc.text}` : '');
      if (!r.n) return r.cc ? `${who}：高级记忆库里没有相关的记忆。${extra}` : `${who}：记忆库里没找到相关的。别编，照实说记不清，或者问她。`;
      return `${who}（${r.n} 条${r.dry ? '，DeepSeek 压缩过' : ''}${r.vec ? '，含意思相近的' : ''}）：\n${r.text}${r.cut ? '\n（太长，后面截掉了）' : ''}${extra}`;
    });
    out.volatile = '\n\n[你刚翻的记忆] 这些是你以前记下的事，按相关程度排。自然地用，别整段念给她，'
      + '「含意思相近的」那几条不一定真是她问的那件，拿不准就别硬套。\n' + parts.join('\n\n');
  }
  return out;
}
