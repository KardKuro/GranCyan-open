// ============================================================
// 世界书
// 跟酒馆（SillyTavern）的世界书是一个意思：一条条设定/写法指南，平时不占位，
// 最近几轮聊到了（关键词命中，或者意思对上了）才翻出来塞进这一轮的提示词。
//
// ── 放哪一段 ──
// 命中的条目**只进 volatile**（每轮现拼的「本轮实时信息」那条，见 05 的 buildSystemPrompt）。
// 它天生每轮都可能变：这轮聊到了就有，下轮没聊到就没了。放进 stable 的话，
// 每命中/脱靶一次，system 连同后面整段历史的缓存就全废一次（记忆 grancyan2-prompt-cache）。
// 唯一的例外是「常驻」条目（酒馆的 constant）：内容不随话题变，进 stable 正好吃缓存。
//
// ── 没命中时一个字都不多 ──
// 没有命中、没有常驻 → stable 和 volatile 都返回空串，不留标题、不留说明。
// 所以 AI 平时根本不知道有世界书这回事，也就不会去「提起」它。
// tests/worldbook.test.js 拿整份系统提示逐字节比对守着这条。
//
// ── 命中判定 ──
//   · 关键词：扫最近 depth 条消息（默认 2 条＝她这句 + 上一条 AI 回复），任意一个词出现就算。
//     写成 /…/i 的按正则；「同时还要出现」那一栏非空时，还得再命中其中一个（酒馆的 AND ANY）。
//   · 语义：复用高级记忆那条 bge-small-zh 语义路（14-boot-brain-hub.js），只看她最新这句。
//     ⚠ 那边的注释写得很清楚：向量分的**绝对值**当不了门限——「今天午饭吃什么」跟真相关的
//     问句 top1 都在 0.57 上下。所以这里比的是「比闲聊高出多少」：同一句话先跟一组
//     日常闲聊句算一遍当底噪，条目得分要高出底噪 WB_SEM_MARGIN 才算命中。
//     全程尽力而为：模型没加载完/拉不到 → 这一路缺席，关键词照常。
//
// ── 总长上限 ──
// 常驻的先占（它们每轮一样，先占才能让 stable 稳定），命中的按优先级从高到低往里装，
// 装不下的整条跳过、接着看下一条（短的低优先级可能还塞得进）。不截半条——
// 半条写法指南比没有更糟，模型会照着残句去写。
// ============================================================

const WB_BUDGET_DEFAULT = 2000;   // 世界书这一块最多占多少字
const WB_DEPTH_DEFAULT  = 2;      // 扫最近几条消息
const WB_DEPTH_MAX      = 10;
const WB_SEM_LINES_MAX  = 8;      // 一条最多几句语义触发句
// 两个门限是 2026-10-03 拿真 bge-small-zh 标的（tests/browser-worldbook.js --calib 会打出整张分数表）：
//   真相关的句子绝对分只有 0.43~0.59，跟闲聊句的 0.42~0.47 搅在一起——绝对分确实分不开；
//   看差值：闲聊句比底噪最高 −0.058，对错了条目的最高 +0.016，对上的 +0.10~+0.13。
//   0.05 落在中间：那组 19 句 0 误触发、9 句正例召回 3 句。宁可漏（关键词兜着），别乱翻。
const WB_SEM_MARGIN     = 0.05;   // 比闲聊底噪至少高出这么多才算意思对上
const WB_SEM_MIN        = 0.4;    // 再兜一道绝对下限：底噪本身很低时（她说了句很怪的话），别让 0.25 也算命中
const WB_SEM_WAIT_MS    = 1500;   // 发送前最多等语义路多久（跟高级记忆一样）
// 底噪句：日常里最常见、跟任何设定都不沾边的话。拿她这句跟它们比，算出「这句话跟随便一句闲聊有多像」。
const WB_SEM_NEUTRAL = [
  '好的', '嗯嗯', '哈哈哈哈', '在吗', '你在干嘛', '今天午饭吃什么', '我回来了', '晚安',
  '明天天气怎么样', '我有点累', '刚刚在忙', '这个怎么弄', '你觉得呢', '我去洗个澡', '今天好冷', '等我一下',
];

// ── 数据 ──
// state.worldbook = { on, budget, depth, ver, entries: [...], del: { id: ver } }
//   ver   —— on/budget/depth 这三个设置的版本号（逻辑计数器，不是时间戳：设备时钟不可信）
//   del   —— 墓碑：删掉那一刻条目的 ver。另一台设备手里的同一条 ver 不比它高 → 视为已删
// 条目 = { id, title, keys, keys2, sem, semText, content, priority, on, always, scope, group, ver }
//   scope —— 'all' 或某个模型配置的 id（那个角色专用）
function _wbStr(v, max) { return (typeof v === 'string' ? v : (v == null ? '' : String(v))).slice(0, max || 20000); }
function _wbInt(v, def, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function _wbKeys(v) {
  if (typeof v === 'string') v = v.split(/[,，、\n]/);
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v) {
    const s = _wbStr(k, 200).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 50);
}
function wbNewId() { return 'wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function wbEntryNorm(e) {
  if (!e || typeof e !== 'object') return null;
  const keys = _wbKeys(e.keys);
  return {
    id: _wbStr(e.id, 64) || wbNewId(),
    title: _wbStr(e.title, 120).trim() || keys[0] || '未命名',
    keys,
    keys2: _wbKeys(e.keys2),
    sem: !!e.sem,
    semText: _wbStr(e.semText, 2000),
    content: _wbStr(e.content, 20000),
    priority: _wbInt(e.priority, 100, -9999, 9999),
    on: e.on !== false,
    always: !!e.always,
    scope: (e.scope == null || e.scope === '' || e.scope === 'all') ? 'all' : String(e.scope),
    group: _wbStr(e.group, 60).trim(),
    ver: _wbInt(e.ver, 1, 0, 1e9),
  };
}

function wbNorm(raw) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const seen = new Set();
  const entries = [];
  for (const x of Array.isArray(b.entries) ? b.entries : []) {
    const e = wbEntryNorm(x);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id); entries.push(e);
  }
  const del = {};
  if (b.del && typeof b.del === 'object') {
    for (const k of Object.keys(b.del)) { const v = Number(b.del[k]); if (Number.isFinite(v) && v >= 0) del[k] = v; }
  }
  return {
    on: b.on !== false,
    budget: _wbInt(b.budget, WB_BUDGET_DEFAULT, 200, 20000),
    depth: _wbInt(b.depth, WB_DEPTH_DEFAULT, 1, WB_DEPTH_MAX),
    ver: _wbInt(b.ver, 0, 0, 1e9),
    entries, del,
  };
}

// state.worldbook 每换一个对象（启动、云端合并、别处直接赋值）就过一遍 wbNorm。
// 光判「entries 是不是数组」不够：缺 scope 的条目会被 wbInScope 当成「不属于任何角色」，静默永不命中。
const _wbNormed = new WeakSet();
function wbBook() {
  if (!state.worldbook || typeof state.worldbook !== 'object' || !_wbNormed.has(state.worldbook)) {
    state.worldbook = wbNorm(state.worldbook);
    _wbNormed.add(state.worldbook);
  }
  return state.worldbook;
}

function wbInScope(e, confId) {
  return e.scope === 'all' || (confId != null && String(e.scope) === String(confId));
}

// ── 云同步合并 ──
// 走现有那套「整包 upsert 之前先跟云端按条合并」（见 01-core 的 syncSettingsToCloud）。
// 规则：同 id 取 ver 大的；ver 相同内容不同（两台各从同一版改了一次）按规范化 JSON 字典序取一个
// ——两台算出来是同一条，下一轮就收敛。删除留墓碑，墓碑 ver ≥ 条目 ver 才算删掉：
// 另一台在删除之后又改过它（ver 更高）的话，改动赢，条目回来——宁可多一条也别吞掉她刚写的字。
function _wbCanon(o) { return JSON.stringify(o); }
function wbMerge(local, cloud) {
  const A = wbNorm(local), B = wbNorm(cloud);
  const del = Object.assign({}, A.del);
  for (const k of Object.keys(B.del)) del[k] = Math.max(del[k] || 0, B.del[k]);
  const byId = new Map();
  for (const e of [...A.entries, ...B.entries]) {
    const cur = byId.get(e.id);
    if (!cur || e.ver > cur.ver || (e.ver === cur.ver && _wbCanon(e) > _wbCanon(cur))) byId.set(e.id, e);
  }
  const entries = [...byId.values()]
    .filter(e => !(del[e.id] >= e.ver))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const setA = { on: A.on, budget: A.budget, depth: A.depth };
  const setB = { on: B.on, budget: B.budget, depth: B.depth };
  const pickB = B.ver > A.ver || (B.ver === A.ver && _wbCanon(setB) > _wbCanon(setA));
  const s = pickB ? setB : setA;
  return { on: s.on, budget: s.budget, depth: s.depth, ver: Math.max(A.ver, B.ver), entries, del };
}

// ── 扫描文本 ──
// 历史里 AI 的消息是烤好的 HTML（指令结果块、表情 <img>），去掉标签再比，
// 不然 class 名、onclick 里的字也能「命中」关键词。思考链不扫：那不是说出口的话。
function _wbMsgText(m) {
  if (!m) return '';
  let t = '';
  if (Array.isArray(m.variants) && m.variants.length) {
    const v = m.variants[m.chosenVariant || 0] || m.variants[0];
    t = v ? (Array.isArray(v.blocks) && v.blocks.length
      ? v.blocks.filter(b => b && b.type !== 'thinking').map(b => b.text || '').join('\n')
      : (v.content || '')) : '';
  } else if (Array.isArray(m.blocks) && m.blocks.length) {
    t = m.blocks.filter(b => b && b.type !== 'thinking').map(b => b.text || '').join('\n');
  } else if (typeof m.content === 'string') {
    t = m.content;
  } else if (Array.isArray(m.content)) {
    t = m.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  }
  return String(t)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function wbScanText(path, depth, lastUserText) {
  const out = [];
  if (Array.isArray(path)) {
    for (let i = path.length - 1; i >= 0 && out.length < depth; i--) {
      const m = path[i];
      if (!m || (m.role !== 'user' && m.role !== 'ai' && m.role !== 'assistant')) continue;
      out.push(_wbMsgText(m));
    }
  } else if (lastUserText) {
    out.push(String(lastUserText));
  }
  return out.reverse().join('\n');
}
function _wbLastUserText(path) {
  if (!Array.isArray(path)) return '';
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] && path[i].role === 'user') return _wbMsgText(path[i]).trim().slice(0, 256);
  }
  return '';
}

// ── 关键词 ──
// /…/flags 写法按正则（酒馆同款），其余不分大小写按子串。写坏的正则当它不存在，别让一条坏规则炸掉整轮。
const _wbReCache = new Map();
function _wbRegex(k) {
  if (_wbReCache.has(k)) return _wbReCache.get(k);
  let re = null;
  const m = /^\/(.+)\/([imsu]*)$/.exec(k);
  if (m) { try { re = new RegExp(m[1], m[2]); } catch (_) { re = null; } }
  if (_wbReCache.size > 500) _wbReCache.clear();
  _wbReCache.set(k, re);
  return re;
}
function _wbKeyHit(k, text, lower) {
  if (/^\/.+\/[imsu]*$/.test(k)) { const re = _wbRegex(k); return !!(re && re.test(text)); }
  return lower.includes(k.toLowerCase());
}
function wbKeyMatch(e, text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const k1 = e.keys.find(k => _wbKeyHit(k, text, lower));
  if (!k1) return null;
  if (e.keys2.length) {
    const k2 = e.keys2.find(k => _wbKeyHit(k, text, lower));
    if (!k2) return null;
    return k1 + ' + ' + k2;
  }
  return k1;
}

// ── 语义路 ──
// buildSystemPrompt 是同步的，向量只能在发送前（buildApiMessages 里）先算好放着。
// 结果绑在「她这句话的原文」上：不是同一句就不认，免得重试别的消息时吃到上一句的结果。
const _wbSem = { docs: new Map(), q: null };
function _wbSemLines(e) {
  const lines = String(e.semText || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, WB_SEM_LINES_MAX);
  return lines.length ? lines : [(e.title + ' ' + e.keys.filter(k => !/^\/.+\/[imsu]*$/.test(k)).join(' ')).trim()].filter(Boolean);
}
function _wbVecReady() {
  return typeof _brainVecRun === 'function' && typeof _brainVec !== 'undefined' && !!_brainVec && !!_brainVec.pipe
    && (typeof _brainVecOn !== 'function' || _brainVecOn());
}
async function _wbEmbed(texts) {
  const need = texts.filter(t => !_wbSem.docs.has(t));
  for (let i = 0; i < need.length; i += 16) {
    const batch = need.slice(i, i + 16);
    const out = (await _brainVecRun(batch)).tolist();
    batch.forEach((t, j) => _wbSem.docs.set(t, Float32Array.from(out[j])));
  }
  if (_wbSem.docs.size > 600) {   // 改过很多次语义句之后旧的就没用了；整个清掉下次重算，几十条而已
    const keep = new Set(texts);
    for (const k of [..._wbSem.docs.keys()]) if (!keep.has(k)) _wbSem.docs.delete(k);
  }
}
function _wbDot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

async function worldbookPrepare(path, conf) {
  try {
    const book = wbBook();
    if (!book.on) return;
    const sems = book.entries.filter(e => e.on && e.sem && !e.always && wbInScope(e, conf && conf.id));
    if (!sems.length) return;
    const bv = typeof _brainVec !== 'undefined' ? _brainVec : null;
    if (typeof _brainVecLoad === 'function' && !(bv && bv.pipe)) {
      // 跟高级记忆同一个模型：没加载就踢一脚，这一轮不等
      if (typeof _brainVecOn !== 'function' || _brainVecOn()) _brainVecLoad();
      return;
    }
    if (!_wbVecReady()) return;
    const text = _wbLastUserText(path);
    if (!text) return;
    const run = (async () => {
      const lines = new Map(sems.map(e => [e.id, _wbSemLines(e)]));
      const all = [...WB_SEM_NEUTRAL, ...[].concat(...lines.values())];
      await _wbEmbed(all);
      const qp = typeof BRAIN_VEC_QPREFIX === 'string' ? BRAIN_VEC_QPREFIX : '';
      const qv = Float32Array.from((await _brainVecRun(qp + text)).tolist()[0]);
      const base = Math.max(...WB_SEM_NEUTRAL.map(t => _wbDot(qv, _wbSem.docs.get(t))));
      const scores = {};
      for (const e of sems) {
        const s = Math.max(...lines.get(e.id).map(t => _wbDot(qv, _wbSem.docs.get(t))));
        scores[e.id] = { s, hit: s >= WB_SEM_MIN && s - base >= WB_SEM_MARGIN };
      }
      _wbSem.q = { text, base, scores };
    })();
    await Promise.race([run, new Promise(r => setTimeout(r, WB_SEM_WAIT_MS))]);
  } catch (e) { console.warn('[世界书·语义路] 失败，这一轮只用关键词：', e && e.message || e); }
}

// ── 挑选 + 拼提示词 ──
let _wbLast = null;   // 上一轮翻出了什么、为什么、截掉了什么——面板上给她看
function _wbFill(s, conf) {
  const user = (typeof state === 'object' && state && state.userName) || '用户';
  const char = (conf && (conf.nickname || conf.name)) || '你';
  return String(s).replace(/\{\{user\}\}/gi, user).replace(/\{\{char\}\}/gi, char);
}
function _wbByPriority(a, b) { return (b.e.priority - a.e.priority) || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0); }

function worldbookPromptFor(conf, path, lastUserText) {
  const empty = { stable: '', volatile: '' };
  if (typeof state !== 'object' || !state || !state.worldbook) return empty;
  const book = wbBook();
  if (!book.on || !book.entries.length) { _wbLast = null; return empty; }
  const confId = conf && conf.id;
  const live = book.entries.filter(e => e.on && wbInScope(e, confId) && e.content.trim());
  if (!live.length) { _wbLast = null; return empty; }

  const always = live.filter(e => e.always).map(e => ({ e, why: '常驻' })).sort(_wbByPriority);
  const text = wbScanText(path, book.depth, lastUserText);
  const qText = _wbLastUserText(path) || String(lastUserText || '').trim().slice(0, 256);
  const sem = _wbSem.q && _wbSem.q.text === qText ? _wbSem.q.scores : null;
  const hits = [];
  for (const e of live) {
    if (e.always) continue;
    const k = wbKeyMatch(e, text);
    if (k) { hits.push({ e, why: '关键词：' + k }); continue; }
    if (e.sem && sem && sem[e.id] && sem[e.id].hit) hits.push({ e, why: '意思对上了（' + sem[e.id].s.toFixed(2) + '）' });
  }
  hits.sort(_wbByPriority);

  let used = 0;
  const cut = [];
  const take = (arr) => arr.filter(x => {
    const block = '【' + x.e.title + '】\n' + _wbFill(x.e.content.trim(), conf);
    x.block = block;
    if (used + block.length > book.budget) { cut.push(x); return false; }
    used += block.length;
    return true;
  });
  const keptAlways = take(always);
  const keptHits = take(hits);

  _wbLast = {
    at: Date.now(), conf: conf && (conf.nickname || conf.name) || '',
    used, budget: book.budget,
    items: [...keptAlways, ...keptHits].map(x => ({ id: x.e.id, title: x.e.title, why: x.why })),
    cut: cut.map(x => ({ id: x.e.id, title: x.e.title, why: x.why, len: x.block.length })),
    semBase: _wbSem.q && _wbSem.q.text === qText ? _wbSem.q.base : null,
  };
  if (typeof worldbookRefresh === 'function') { try { worldbookRefresh(); } catch (_) {} }

  const out = { stable: '', volatile: '' };
  if (keptAlways.length) {
    out.stable = '\n\n[世界书·常驻] 下面是一直有效的设定，照着用就好，不用提起它。\n' + keptAlways.map(x => x.block).join('\n\n');
  }
  if (keptHits.length) {
    out.volatile = '\n\n[世界书] 下面几条是按这几轮聊到的内容翻出来的参考，只管这一轮。用进你的回复里就好，别提起「世界书」，也别照抄原文。\n'
      + keptHits.map(x => x.block).join('\n\n');
  }
  return out;
}

// ── 导入 / 导出（酒馆格式）──
// 认三种：酒馆世界书 {entries:{"0":{key,keysecondary,comment,content,order,constant,disable,selective,selectiveLogic}}}、
// 角色卡里嵌的 character_book（v2/v3：{entries:[{keys,secondary_keys,content,enabled,insertion_order,constant,name/comment}]}）、
// 以及我们自己导出的（就是酒馆格式外加几个 gc_ 字段，酒馆那边会忽略它们）。
function wbFromTavern(raw, groupName) {
  let j = raw;
  if (typeof j === 'string') j = JSON.parse(j.replace(/^﻿/, ''));
  if (j && j.data && j.data.character_book) { groupName = groupName || j.data.name; j = j.data.character_book; }
  else if (j && j.character_book) { groupName = groupName || j.name; j = j.character_book; }
  let list = j && j.entries;
  if (list && !Array.isArray(list) && typeof list === 'object') list = Object.values(list);
  if (!Array.isArray(list)) throw new Error('认不出这个文件：里面没有 entries');
  const group = _wbStr(groupName || (j && j.name) || '', 60).trim();
  let dropped2 = 0;
  const entries = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const keys = _wbKeys(x.key != null ? x.key : x.keys);
    const sec = _wbKeys(x.keysecondary != null ? x.keysecondary : x.secondary_keys);
    // 酒馆的次级关键词有四种逻辑，这里只做默认那种（AND ANY）。别的逻辑硬套 AND ANY 会意思反过来，干脆不要
    const logic = x.selectiveLogic == null ? 0 : Number(x.selectiveLogic);
    const useSec = sec.length && x.selective !== false && logic === 0;
    if (sec.length && !useSec) dropped2++;
    const content = _wbStr(x.content, 20000);
    if (!content.trim()) continue;
    const e = wbEntryNorm({
      title: x.comment || x.name || x.title || keys[0],
      keys, keys2: useSec ? sec : [],
      content,
      priority: x.order != null ? x.order : (x.insertion_order != null ? x.insertion_order : x.priority),
      on: !(x.disable === true || x.enabled === false),
      always: !!x.constant,
      sem: !!x.gc_sem, semText: x.gc_semText || '',
      scope: x.gc_scope || 'all',
      group: x.gc_group != null ? x.gc_group : group,
    });
    e.id = wbNewId();
    entries.push(e);
  }
  return { entries, dropped2 };
}
function wbToTavern(entries) {
  const out = { entries: {} };
  (entries || []).forEach((e, i) => {
    out.entries[i] = {
      uid: i, key: e.keys.slice(), keysecondary: e.keys2.slice(), comment: e.title, content: e.content,
      constant: !!e.always, selective: e.keys2.length > 0, selectiveLogic: 0,
      order: e.priority, position: 0, disable: !e.on,
      gc_sem: !!e.sem, gc_semText: e.semText || '', gc_scope: e.scope, gc_group: e.group || '',
    };
  });
  return out;
}
// 导入时去重：标题 + 正文都一样的当成同一条，重复导入同一个文件不会翻倍
function wbImport(raw, groupName) {
  const book = wbBook();
  const { entries, dropped2 } = wbFromTavern(raw, groupName);
  const have = new Set(book.entries.map(e => e.title + '\u0000' + e.content));
  let added = 0, dup = 0;
  for (const e of entries) {
    const k = e.title + '\u0000' + e.content;
    if (have.has(k)) { dup++; continue; }
    have.add(k); book.entries.push(e); added++;
  }
  if (added && typeof save === 'function') save();
  return { added, dup, dropped2 };
}

// ── 增删改（面板用）──
function wbSaveEntry(fields) {
  const book = wbBook();
  const idx = fields.id ? book.entries.findIndex(e => e.id === fields.id) : -1;
  const old = idx >= 0 ? book.entries[idx] : null;
  const e = wbEntryNorm(Object.assign({}, old || {}, fields, { ver: (old ? old.ver : 0) + 1 }));
  if (old) book.entries[idx] = e; else book.entries.push(e);
  if (typeof save === 'function') save();
  return e;
}
function wbDeleteEntry(id) {
  const book = wbBook();
  const e = book.entries.find(x => x.id === id);
  if (!e) return false;
  book.del[id] = Math.max(book.del[id] || 0, e.ver);
  book.entries = book.entries.filter(x => x.id !== id);
  if (typeof save === 'function') save();
  return true;
}
function wbSetConfig(patch) {
  const book = wbBook();
  const n = wbNorm(Object.assign({}, book, patch));
  book.on = n.on; book.budget = n.budget; book.depth = n.depth;
  book.ver = (book.ver || 0) + 1;
  if (typeof save === 'function') save();
}
function wbToggleEntry(id, on) {
  const e = wbBook().entries.find(x => x.id === id);
  if (e) wbSaveEntry({ id, on: !!on });
}
function wbToggleGroup(group, on) {
  const book = wbBook();
  book.entries.forEach(e => { if ((e.group || '') === group && e.on !== !!on) { e.on = !!on; e.ver++; } });
  if (typeof save === 'function') save();
  worldbookRefresh(true);
}

// ============================================================
// 面板
// ============================================================
let _wbEditing = null;      // 正在编辑的条目 id，'new' 是新建
let _wbDelArm = null;       // 删除要点两次：第一次只是「真的要删吗」
let _wbPasteOpen = false;

function openWorldbook() {
  const m = document.getElementById('worldbookModal'); if (!m) return;
  m.classList.remove('hidden');
  worldbookRefresh(true);
}
function closeWorldbook() {
  document.getElementById('worldbookModal')?.classList.add('hidden');
  _wbEditing = null; _wbDelArm = null; _wbPasteOpen = false;
}

function _wbScopeLabel(scope) {
  if (scope === 'all') return '全局';
  const c = (state.configs || []).find(x => String(x.id) === String(scope));
  return c ? (c.nickname || c.modelName || '某个角色') : '已删除的角色';
}
function _wbEsc(s) { return typeof escHtml === 'function' ? escHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }
function _wbJsArg(s) { return _wbEsc(JSON.stringify(String(s))); }

function _wbEditorHtml(e) {
  const isNew = !e;
  e = e || wbEntryNorm({ title: '', keys: [], content: '', id: 'new' });
  const scopes = [['all', '全局（所有角色）'], ...(state.configs || []).map(c => [String(c.id), c.nickname || c.modelName || c.id])];
  const tooLong = e.content && ('【' + e.title + '】\n' + e.content).length > wbBook().budget;
  return `<div class="wb-edit">
    <label class="wb-f"><span>标题</span><input id="wbF_title" class="field-input" maxlength="120" value="${_wbEsc(isNew ? '' : e.title)}" placeholder="比如：下雨天的写法"></label>
    <label class="wb-f"><span>触发词 <small>逗号或换行分开；写成 /…/i 的按正则</small></span>
      <textarea id="wbF_keys" class="field-input" rows="2" placeholder="下雨, 雨伞, /带(上|着)伞/">${_wbEsc(e.keys.join(', '))}</textarea></label>
    <label class="wb-f"><span>同时还要出现 <small>可选。填了的话，上面命中之外还得再命中这里的一个</small></span>
      <input id="wbF_keys2" class="field-input" value="${_wbEsc(e.keys2.join(', '))}" placeholder="留空就不管"></label>
    <label class="wb-check"><input type="checkbox" id="wbF_sem"${e.sem ? ' checked' : ''} onchange="document.getElementById('wbF_semBox').classList.toggle('hidden',!this.checked)"> 语义触发 <small>字面没对上、意思对上了也翻出来</small></label>
    <div id="wbF_semBox" class="wb-f${e.sem ? '' : ' hidden'}">
      <textarea id="wbF_semText" class="field-input" rows="3" placeholder="每行一句：她聊到这件事时可能会怎么说。留空就拿标题和触发词凑">${_wbEsc(e.semText)}</textarea>
      <small class="study-dim">跟高级记忆用同一个本地小模型；它还没加载好的那几轮只看触发词。</small>
    </div>
    <label class="wb-f"><span>正文 <small>命中时原样给它看；{{user}} {{char}} 会换成名字</small></span>
      <textarea id="wbF_content" class="field-input wb-content" rows="8" placeholder="写法、设定、注意事项……">${_wbEsc(e.content)}</textarea></label>
    ${tooLong ? `<div class="wb-warn">这条比总长上限（${wbBook().budget} 字）还长，永远塞不进去——拆短一点，或者把上限调大。</div>` : ''}
    <div class="wb-row">
      <label class="wb-f wb-f-s"><span>优先级 <small>大的先装</small></span><input id="wbF_pri" class="field-input" type="number" value="${e.priority}"></label>
      <label class="wb-f"><span>作用范围</span><select id="wbF_scope" class="field-input">${scopes.map(([v, l]) => `<option value="${_wbEsc(v)}"${String(e.scope) === v ? ' selected' : ''}>${_wbEsc(l)}</option>`).join('')}</select></label>
      <label class="wb-f"><span>分组 <small>可选</small></span><input id="wbF_group" class="field-input" maxlength="60" value="${_wbEsc(e.group)}" placeholder="比如：写法指南"></label>
    </div>
    <label class="wb-check"><input type="checkbox" id="wbF_always"${e.always ? ' checked' : ''}> 常驻 <small>不看触发词，每轮都带上（会一直占着上限）</small></label>
    <div class="wb-actions">
      <button class="study-go" onclick="worldbookSaveForm(${_wbJsArg(isNew ? '' : e.id)})">保存</button>
      <button class="study-imp-toggle" onclick="worldbookEdit(null)">取消</button>
      ${isNew ? '' : `<button class="study-imp-toggle wb-del${_wbDelArm === e.id ? ' wb-del-armed' : ''}" onclick="worldbookDelete(${_wbJsArg(e.id)})">${_wbDelArm === e.id ? '再点一次就删掉' : '删除'}</button>`}
    </div>
  </div>`;
}

function _wbRowHtml(e) {
  const chips = e.keys.slice(0, 6).map(k => `<i>${_wbEsc(k)}</i>`).join('') + (e.keys.length > 6 ? `<i>+${e.keys.length - 6}</i>` : '');
  const tags = [e.always ? '<b class="wb-tag">常驻</b>' : '', e.sem ? '<b class="wb-tag">语义</b>' : '', e.keys2.length ? '<b class="wb-tag">且</b>' : ''].join('');
  const hit = _wbLast && _wbLast.items.some(x => x.id === e.id);
  const cut = _wbLast && _wbLast.cut.some(x => x.id === e.id);
  return `<div class="wb-item${e.on ? '' : ' wb-off'}${hit ? ' wb-hit' : ''}">
    <label class="diary-switch wb-item-sw" title="${e.on ? '开着' : '关着'}"><input type="checkbox"${e.on ? ' checked' : ''} onchange="wbToggleEntry(${_wbJsArg(e.id)},this.checked);worldbookRefresh(true)"></label>
    <div class="wb-item-main" onclick="worldbookEdit(${_wbJsArg(e.id)})">
      <div class="wb-item-top"><b>${_wbEsc(e.title)}</b>${tags}${hit ? '<b class="wb-tag wb-tag-hit">上一轮翻出来了</b>' : ''}${cut ? '<b class="wb-tag wb-tag-cut">上一轮被挤掉</b>' : ''}</div>
      <div class="wb-item-sub">${chips || '<span class="study-dim">没有触发词</span>'}</div>
      <div class="wb-item-meta study-dim">优先级 ${e.priority} · ${_wbEsc(_wbScopeLabel(e.scope))} · ${e.content.length} 字</div>
    </div>
  </div>`;
}

function worldbookRefresh(force) {
  const m = document.getElementById('worldbookModal');
  const body = document.getElementById('worldbookBody');
  if (!m || !body) return;
  if (m.classList.contains('hidden') && !force) return;
  // 正在编辑时别从底下刷掉她没保存的字（每轮发送都会调到这里）
  if (!force && _wbEditing) return;
  const book = wbBook();
  const tg = document.getElementById('worldbookToggle'); if (tg) tg.checked = !!book.on;
  const bd = document.getElementById('worldbookBudget'); if (bd && document.activeElement !== bd) bd.value = book.budget;
  const dp = document.getElementById('worldbookDepth'); if (dp) dp.value = String(book.depth);

  let h = '';
  // 上一轮翻出了什么——调关键词全靠它
  if (_wbLast && (_wbLast.items.length || _wbLast.cut.length)) {
    h += `<div class="wb-last"><div class="wb-last-label">上一轮（${_wbEsc(_wbLast.conf || '')}）· 用了 ${_wbLast.used} / ${_wbLast.budget} 字</div>`;
    h += _wbLast.items.map(x => `<div class="wb-last-row"><b>${_wbEsc(x.title)}</b><span class="study-dim">${_wbEsc(x.why)}</span></div>`).join('');
    h += _wbLast.cut.map(x => `<div class="wb-last-row wb-last-cut"><b>${_wbEsc(x.title)}</b><span class="study-dim">命中了但装不下（${x.len} 字）· ${_wbEsc(x.why)}</span></div>`).join('');
    h += `</div>`;
  } else if (_wbLast) {
    // 只有真的算过一轮才这么说；刚打开、刚刷新（_wbLast 还是 null）就什么都不写，免得像是「坏了」
    h += `<div class="wb-last wb-last-quiet study-dim">上一轮什么都没翻出来——这时候提示词里一个字都不多。</div>`;
  }

  if (_wbPasteOpen) {
    h += `<div class="wb-paste">
      <textarea id="wbPasteText" class="field-input" rows="6" placeholder="把酒馆世界书 / 角色卡的 JSON 整段贴进来"></textarea>
      <div class="wb-actions"><button class="study-go" onclick="worldbookImportPasted()">导入</button><button class="study-imp-toggle" onclick="worldbookPaste(false)">算了</button></div>
    </div>`;
  }

  if (_wbEditing === 'new') h += `<div class="wb-group"><div class="wb-group-head"><b>新条目</b></div>${_wbEditorHtml(null)}</div>`;

  if (!book.entries.length && _wbEditing !== 'new') {
    // 空状态走公共 .gc-empty（ui-polish A27）；「还没有条目」这几个字 browser-worldbook 认
    h += `<div class="gc-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v14H6.5A1.5 1.5 0 0 0 5 18.5z"/><path d="M5 18.5A1.5 1.5 0 0 0 6.5 20H19"/><path d="M9 7.5h6"/></svg></div>`
      + `<div class="gc-empty-title">还没有条目</div>`
      + `<div class="gc-empty-desc">每条是一段设定或写法指南，聊到它的触发词时才翻出来给他看，平时不占地方。也可以直接导入酒馆的世界书 JSON。</div></div>`;
  } else {
    const groups = new Map();
    [...book.entries].sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : 1))
      .forEach(e => { const g = e.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); });
    const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh')));
    for (const g of names) {
      const list = groups.get(g);
      const allOn = list.every(e => e.on);
      h += `<div class="wb-group"><div class="wb-group-head"><b>${_wbEsc(g || '未分组')}</b><span class="study-dim">${list.length} 条</span>
        <button class="wb-mini" onclick="wbToggleGroup(${_wbJsArg(g)},${allOn ? 'false' : 'true'})">${allOn ? '整组关掉' : '整组打开'}</button></div>`;
      for (const e of list) h += _wbEditing === e.id ? _wbEditorHtml(e) : _wbRowHtml(e);
      h += `</div>`;
    }
  }
  body.innerHTML = h;
}

function worldbookEdit(id) {
  _wbEditing = id; _wbDelArm = null;
  worldbookRefresh(true);
  if (id) setTimeout(() => document.getElementById('wbF_title')?.focus(), 0);
}
function worldbookSaveForm(id) {
  const v = k => (document.getElementById(k) || {}).value || '';
  const content = v('wbF_content');
  const keys = _wbKeys(v('wbF_keys'));
  const always = !!document.getElementById('wbF_always')?.checked;
  const sem = !!document.getElementById('wbF_sem')?.checked;
  if (!content.trim()) { showToast('正文是空的，存了也不会注入', 'info', 2600); return; }
  if (!keys.length && !always && !sem) { showToast('没有触发词、也没开语义或常驻——它永远不会被翻出来', 'info', 3600); return; }
  const bad = keys.concat(_wbKeys(v('wbF_keys2'))).filter(k => /^\/.+\/[imsu]*$/.test(k) && !_wbRegex(k));
  if (bad.length) { showToast('这个正则写坏了：' + bad[0], 'error', 3600); return; }
  wbSaveEntry({
    id: id || undefined, title: v('wbF_title'), keys, keys2: v('wbF_keys2'), sem, semText: v('wbF_semText'),
    content, priority: v('wbF_pri'), scope: v('wbF_scope') || 'all', group: v('wbF_group'), always,
  });
  _wbEditing = null;
  worldbookRefresh(true);
  showToast('存好了', 'success', 1600);
}
function worldbookDelete(id) {
  if (_wbDelArm !== id) { _wbDelArm = id; worldbookRefresh(true); return; }
  wbDeleteEntry(id);
  _wbDelArm = null; _wbEditing = null;
  worldbookRefresh(true);
}
function worldbookPaste(open) { _wbPasteOpen = !!open; worldbookRefresh(true); if (open) setTimeout(() => document.getElementById('wbPasteText')?.focus(), 0); }
function _wbImportReport(r) {
  const bits = [`导入了 ${r.added} 条`];
  if (r.dup) bits.push(`${r.dup} 条已经有了，跳过`);
  if (r.dropped2) bits.push(`${r.dropped2} 条的次级关键词用的不是「且」逻辑，没带过来`);
  showToast(bits.join('，'), r.added ? 'success' : 'info', 4200);
}
function worldbookImportPasted() {
  try {
    const r = wbImport(document.getElementById('wbPasteText')?.value || '');
    _wbPasteOpen = false;
    worldbookRefresh(true);
    _wbImportReport(r);
  } catch (e) { showToast('导入失败：' + (e && e.message || e), 'error', 4000); }
}
function worldbookImportFile(input) {
  const f = input && input.files && input.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const r = wbImport(String(rd.result || ''), f.name.replace(/\.json$/i, ''));
      worldbookRefresh(true);
      _wbImportReport(r);
    } catch (e) { showToast('导入失败：' + (e && e.message || e), 'error', 4000); }
    input.value = '';
  };
  rd.onerror = () => { showToast('读不了这个文件', 'error', 3000); input.value = ''; };
  rd.readAsText(f, 'utf-8');
}
function worldbookExport() {
  const book = wbBook();
  if (!book.entries.length) { showToast('还没有条目可导出', 'info', 2000); return; }
  const json = JSON.stringify(wbToTavern(book.entries), null, 2);
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
    a.download = 'GranCyan-世界书.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (_) {}
  // 手机 WebView 里下载不一定接得住，顺手放进剪贴板兜底
  try { navigator.clipboard && navigator.clipboard.writeText(json).then(() => showToast('导出了，也复制到剪贴板了（酒馆格式）', 'success', 2600)).catch(() => {}); } catch (_) {}
}

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('worldbookModal');
  if (m && !m.classList.contains('hidden')) closeWorldbook();
});
