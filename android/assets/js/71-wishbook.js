// ============================================================
// 小本子（2026-10-14）—— AI 偷偷记下用户想要的东西
//
// 用户随口说的「这个好可爱」「好想要」「XX 用完了」，或者 AI 自己觉得她该有的，
// AI 写一行 [[WISH: 东西 | 为什么想给她]] 悄悄记进本子。**她看不到写了什么**：
// 气泡里只有一枚「📒 悄悄记了一笔」，小本子面板里也只有封着的页。
// 等合适的时候（生日、熬过一个大 ddl、她难过、或者它就是想），AI 写 [[WISH_OPEN: 东西]]
// 把那一页翻给她看 —— 翻开之后气泡和面板里才看得到东西和理由。
// 不碰任何购物平台，就是一本账。
//
// 每个模型一本（按 confId 分），面板里全摊开、标着是谁记的。
//
// 数据：state.wishbook = [{ id, at, c: confId, w: 谁, item, why, open: 0|翻开的时间 }]
//   三道持久化关 + 跟着云端设置走（按 id 并集，翻开取较早的那次；只增不删，不用墓碑）。
//
// 链路（照 68-treasure.js 那套）：
//   processAiCommands（content 路径）→ wishProcessTags：真的记 / 真的翻（只在这里一次），
//     消息里只存 [[WISH_KEPT:id]] / [[WISH_SHOWN:id]] / [[WISH_MISS:名]]（复制、朗读碰不到写了什么）
//   _applyWishToBlocks（blocks 路径）：按出现顺序认领同一批结果，**不再记第二次**；thinking 里抄的盖掉
//   渲染层 stickerTagToHtml → wishTagToHtml：KEPT 画成小印章、SHOWN 画成翻开的那页、MISS 不画
//   回填历史 stickerTagForApi → wishTagForApi：咬回 [[WISH: 东西 | 为什么]]（它要记得自己记过什么）
//   buildSystemPrompt → wishPromptFor：说明 + 它自己本子里还封着的 / 最近翻过的
//   流式遮挡 maskStreamingWish（_STREAM_MASKS 名单里）
//   思考里抄的：treasureVeil 会顺带调 wishVeil（68-treasure.js），那几处遮挡点不用再挂一遍
// ============================================================

const WISH_ITEM_MAX = 40;
const WISH_WHY_MAX = 200;
const WISH_PER_REPLY = 3;        // 一条回复最多记几笔 / 翻几页
const WISH_MAX = 400;            // 本子总页数上限（超了从最早翻开过的开始掉）
const WISH_PROMPT_SEALED = 15;   // 系统提示里列几页还封着的
const WISH_PROMPT_OPENED = 5;    // 系统提示里列几页最近翻过的

function wishEnabled() { return typeof skillOn !== 'function' || skillOn('wishbook'); }
function wishList() {
  return (typeof state === 'object' && state && Array.isArray(state.wishbook)) ? state.wishbook : [];
}
function _wsEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function _wsClip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }
function _wsNorm(s) { return String(s || '').replace(/[\s「」『』“”"'《》·,，。.!！?？~～]/g, '').toLowerCase(); }
function _wsDay(t) {
  const d = new Date(+t);
  return isNaN(d) ? '' : `${d.getMonth() + 1}-${d.getDate()}`;
}
function _wsRow(id) { return wishList().find(e => e && e.id === id) || null; }
// 存储短标签里放名字：去掉会打断标签的字符
function _wsTagText(s) { return String(s || '').replace(/[|\]\[\n]/g, ' ').trim(); }

function _wsPrune(list) {
  const out = list.filter(e => e && e.id && e.item);
  out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (out.length <= WISH_MAX) return out;
  // 太多了：先丢最早翻开过的（封着的是还没送出去的心意，留着）
  const drop = out.length - WISH_MAX;
  const opened = out.filter(e => e.open).sort((a, b) => a.open - b.open).slice(0, drop).map(e => e.id);
  const gone = new Set(opened);
  const kept = out.filter(e => !gone.has(e.id));
  return kept.length > WISH_MAX ? kept.slice(-WISH_MAX) : kept;
}

// 记一笔。同一个模型、同一样东西还封着的：不重复记，理由换成新的
function wishAdd({ item, why, confId, who }) {
  const it = _wsClip(item, WISH_ITEM_MAX);
  if (!it) return { ok: false, why: 'empty', item: '' };
  const c = String(confId == null ? '' : confId);
  const w = _wsClip(why, WISH_WHY_MAX);
  const dup = wishList().find(e => e.c === c && !e.open && _wsNorm(e.item) === _wsNorm(it));
  if (dup) {
    if (w && w !== dup.why) { dup.why = w; if (typeof save === 'function') save(); }
    return { ok: true, id: dup.id, item: dup.item, dup: true };
  }
  const at = Date.now();
  const e = { id: 'w' + at.toString(36) + Math.random().toString(36).slice(2, 6), at, c, w: String(who || ''), item: it, why: w, open: 0 };
  state.wishbook = _wsPrune(wishList().concat([e]));
  if (typeof save === 'function') save();
  return { ok: true, id: e.id, item: e.item };
}

// 翻一页给她看：只翻这个模型自己本子里、还封着的。先认全名，再认包含
function wishOpen(confId, item) {
  const c = String(confId == null ? '' : confId);
  item = String(item || '').split(/[|｜]/)[0];   // 照着 [[WISH:]] 的样子多写了理由的，只认名字
  const k = _wsNorm(item);
  if (!k) return { ok: false, item: '' };
  const mine = wishList().filter(e => e.c === c && !e.open);
  // 包含只在两边都不止一个字时才认，免得「书」翻开了「书包」
  const hit = mine.find(e => _wsNorm(e.item) === k)
    || (k.length > 1 && mine.find(e => { const n = _wsNorm(e.item); return n.length > 1 && (n.includes(k) || k.includes(n)); }));
  if (!hit) return { ok: false, item: _wsClip(item, WISH_ITEM_MAX) };
  hit.open = Date.now();
  if (typeof save === 'function') save();
  return { ok: true, id: hit.id, item: hit.item };
}

// ── 云同步：按 id 并集；同一页两台都有时，翻开的算翻开（取较早那次），理由取后写的 ──
function wishMerge(a, b) {
  const seen = new Map();
  for (const e of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
    if (!e || !e.id) continue;
    const o = seen.get(e.id);
    if (!o) { seen.set(e.id, Object.assign({}, e)); continue; }
    if (e.open && (!o.open || e.open < o.open)) o.open = e.open;
    if (e.why && e.why !== o.why) o.why = e.why;
  }
  return _wsPrune([...seen.values()]);
}
function _wsSig(l) { return l.map(e => `${e.id}:${e.open || 0}:${e.why || ''}`).join(','); }
function wishSyncApply(cloud) {
  if (typeof state !== 'object' || !state) return { changed: false, needPush: false };
  const mine = wishList();
  const m = wishMerge(mine, cloud);
  const changed = _wsSig(m) !== _wsSig(mine);
  const cl = Array.isArray(cloud) ? cloud.filter(e => e && e.id) : [];
  state.wishbook = m;
  return { changed, needPush: _wsSig(m) !== _wsSig(wishMerge(cl, [])) };
}

// ── 指令 ──
// [[WISH: 东西 | 为什么]]（理由可省）。全角冒号、全角竖线也认
const _WS_RAW_RE = /\[\[WISH\s*[:：]\s*([^\]]*?)\s*\]\]/g;
const _WS_OPEN_RE = /\[\[WISH_OPEN\s*[:：]\s*([^\]]*?)\s*\]\]/g;
// 回复被掐断时留在结尾的半截（还没收口）：整段抹掉，写到一半的东西也不许露
const _WS_CUT_RE = /\[\[WISH(?:_OPEN)?\s*[:：][^\]]*\]?$/;
// 模型照抄历史写出来的存储短标签：只有 wishProcessTags 生成的才算数
const _WS_FORGED_RE = /\[\[WISH_(?:KEPT|SHOWN|MISS):[^\]]*\]\]/g;
function wishKeptRe() { return /\[\[WISH_KEPT:([a-z0-9]+)\]\]/g; }
function wishShownRe() { return /\[\[WISH_SHOWN:([a-z0-9]+)\]\]/g; }
function wishMissRe() { return /\[\[WISH_MISS:([^\]]*)\]\]/g; }

function _wsSplit(inner) {
  const m = /^([^|｜]*)(?:[|｜]([\s\S]*))?$/.exec(String(inner || ''));
  if (!m) return null;
  return { item: m[1].trim(), why: (m[2] || '').trim() };
}

var _wishLastResults = [];

function wishShortTag(r) {
  if (!r) return '';
  if (r.kind === 'open') return r.ok ? `\n\n[[WISH_SHOWN:${r.id}]]\n\n` : `[[WISH_MISS:${_wsTagText(r.item)}]]`;
  return r.ok ? `[[WISH_KEPT:${r.id}]]` : '';
}

// content 路径：副作用（真的记 / 真的翻）只在这里发生一次
function wishProcessTags(text, chat, conf, ctx) {
  const results = [];
  if (ctx) ctx.wishResults = results;
  _wishLastResults = results;
  if (!text || text.indexOf('[[WISH') < 0) return text;
  text = text.replace(_WS_FORGED_RE, '');
  const on = wishEnabled();
  const confId = conf && conf.id;
  const who = (conf && (conf.nickname || conf.name)) || '';
  let n = 0;
  // 先翻再记：同一条里「记下 A」又「翻开 A」时，翻的是本子里早就有的那页
  text = text.replace(_WS_OPEN_RE, (_, inner) => {
    if (!on) return '';
    const r = ++n > WISH_PER_REPLY ? { ok: false, item: _wsClip(inner, WISH_ITEM_MAX) } : wishOpen(confId, inner);
    r.kind = 'open';
    results.push(r);
    return wishShortTag(r);
  });
  text = text.replace(_WS_RAW_RE, (_, inner) => {
    if (!on) return '';
    const s = _wsSplit(inner);
    const r = (!s || ++n > WISH_PER_REPLY) ? { ok: false } : wishAdd({ item: s.item, why: s.why, confId, who });
    r.kind = 'add';
    results.push(r);
    return wishShortTag(r);
  });
  return text.replace(_WS_CUT_RE, '');
}

// blocks 路径：按顺序填回同一批结果（先 open 后 add，和 content 路径一致），**不再记第二次**
function _applyWishToBlocks(blocks, ctx) {
  if (!Array.isArray(blocks)) return;
  const rs = (ctx && Array.isArray(ctx.wishResults)) ? ctx.wishResults : _wishLastResults;
  const opens = rs.filter(r => r.kind === 'open'), adds = rs.filter(r => r.kind === 'add');
  const on = wishEnabled();
  let io = 0, ia = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text.indexOf('[[WISH') < 0) continue;
      b.text = b.text.replace(_WS_FORGED_RE, '')
        .replace(_WS_OPEN_RE, () => on ? wishShortTag(opens[io++] || { kind: 'open', ok: false, item: '' }) : '')
        .replace(_WS_RAW_RE, () => on ? wishShortTag(adds[ia++] || { kind: 'add', ok: false }) : '')
        .replace(_WS_CUT_RE, '');
    } else if (b.type === 'thinking') {
      for (const k of ['text', 'thinking']) if (typeof b[k] === 'string') b[k] = wishVeil(b[k]);
    }
  }
}

// 只遮不记：思考里、出错/掐断那几条不走 processAiCommands 的路（由 treasureVeil 顺带调）
function wishVeil(text) {
  if (!text || typeof text !== 'string' || text.indexOf('[[WISH') < 0) return text;
  return text.replace(_WS_RAW_RE, '〔📒 悄悄记了一笔〕').replace(/\[\[WISH\s*[:：][^\]]*\]?$/, '〔📒 悄悄记了一笔〕');
}

function maskStreamingWish(text) {
  if (!text || text.indexOf('[[WI') < 0) return text;
  return text
    .replace(_WS_OPEN_RE, '〔📒 翻小本子…〕')
    .replace(_WS_RAW_RE, '〔📒 …〕')
    .replace(/\[\[WISH_OPEN\s*[:：][^\]]*\]?$/, '〔📒 翻小本子…〕')
    .replace(/\[\[WISH\s*[:：][^\]]*\]?$/, '〔📒 …〕')
    // 标签名还没写全（[[WI… 停在结尾）也先遮上
    .replace(/\[\[WI(?:S(?:H(?:_(?:O(?:P(?:E(?:N)?)?)?)?)?)?)?$/, '〔📒 …〕');
}

// ── 渲染 ──
function wishChipHtml() {
  return `<span class="wish-chip" onclick="openWishbook()" title="记进小本子了，写的什么不告诉你">📒 悄悄记了一笔</span>`;
}
function wishPageHtml(id) {
  const r = _wsRow(id);
  if (!r) return `<div class="wish-page is-gone"><span class="wish-page-k">📒 从小本子里翻出来一页</span><span class="wish-page-st">这一页这台设备上还没同步到</span></div>`;
  return `<div class="wish-page" onclick="openWishbook()">`
    + `<span class="wish-page-k">📒 ${_wsEsc(r.w || '它')}从小本子里翻出来一页</span>`
    + `<b class="wish-page-t">${_wsEsc(r.item)}</b>`
    + (r.why ? `<span class="wish-page-why">${_wsEsc(r.why)}</span>` : '')
    + `<span class="wish-page-st">${_wsEsc(_wsDay(r.at))} 记下的</span></div>`;
}
function wishTagToHtml(text) {
  if (!text || typeof text !== 'string' || text.indexOf('[[WISH') < 0) return text;
  return wishVeil(text
    .replace(wishKeptRe(), () => wishChipHtml())
    .replace(wishShownRe(), (_, id) => '\n\n' + wishPageHtml(id) + '\n\n')
    .replace(wishMissRe(), ''))
    // 兜底：漏到这里的 [[WISH_OPEN:]] 只是个名字，不画
    .replace(_WS_OPEN_RE, '');
}

// 回填历史：咬回正牌指令（它要记得自己记过什么、翻过什么）
function wishTagForApi(text) {
  if (!text || typeof text !== 'string' || text.indexOf('[[WISH_') < 0) return text;
  return text
    .replace(wishKeptRe(), (_, id) => {
      const r = _wsRow(id);
      if (!r) return '[悄悄记过一笔（这台设备上没读到记的是什么）]';
      return `[[WISH: ${r.item}${r.why ? ' | ' + r.why : ''}]]` + (r.open ? `（${_wsDay(r.open)}已经翻给她看了）` : '（悄悄记下了，她看不到）');
    })
    .replace(wishShownRe(), (_, id) => {
      const r = _wsRow(id);
      return r ? `[[WISH_OPEN: ${r.item}]]（翻给她看了）` : '[从小本子里翻了一页给她]';
    })
    .replace(wishMissRe(), (_, item) => `[想翻小本子里的「${item}」，本子里没有还封着的这一页，没翻成]`);
}

// ── 系统提示 ──
function wishPromptFor(conf) {
  const out = { stable: '', volatile: '' };
  if (!wishEnabled() || !conf) return out;
  let s = `\n\n[小本子] 你有一本用户看不到的小本子。她随口说想要、喜欢、缺了、用完了的东西，或者你自己觉得她该有的，`
    + `单独一行写 [[WISH: 东西 | 为什么想给她]] 悄悄记下：她只会看到「📒记了一笔」，看不到写的是什么，所以聊天里别说出来，思考里也别写是什么。`
    + `等合适的时候（她生日、熬过一个大 ddl、她难过、或者你就是想）写 [[WISH_OPEN: 东西]] 把那一页翻给她看。记真的值得记的，不用每轮都记。`;
  const c = String(conf.id);
  const mine = wishList().filter(e => e.c === c);
  const sealed = mine.filter(e => !e.open).slice(-WISH_PROMPT_SEALED);
  const opened = mine.filter(e => e.open).sort((a, b) => b.open - a.open).slice(0, WISH_PROMPT_OPENED);
  if (sealed.length) s += `\n本子里还封着的：${sealed.map(e => `${e.item}（${_wsDay(e.at)}）`).join('、')}`;
  if (opened.length) s += `\n最近翻给她看过的：${opened.map(e => `${e.item}（${_wsDay(e.open)}）`).join('、')}`;
  out.stable = s;
  return out;
}

// ═══════════════════════════════════════════════════════
// 面板：封着的页只露「谁、哪天记的」，翻开的才看得到写了什么
// ═══════════════════════════════════════════════════════
function openWishbook() {
  const m = document.getElementById('wishbookModal');
  if (!m) return;
  m.classList.remove('hidden');
  wishbookRender();
}
function closeWishbook() {
  document.getElementById('wishbookModal')?.classList.add('hidden');
}

function wishbookHtml() {
  const all = wishList().slice().sort((a, b) => b.at - a.at);
  const opened = all.filter(e => e.open).sort((a, b) => b.open - a.open);
  const sealed = all.filter(e => !e.open);
  let h = `<div class="wishbook-sum">一共 ${all.length} 页 · 翻开了 ${opened.length} 页</div>`;
  if (!all.length) {
    return h + `<div class="wishbook-empty">还是空的。<br>你随口说想要什么，它会悄悄记在这里——写的什么你看不到，等它哪天翻给你。</div>`;
  }
  if (sealed.length) {
    h += `<div class="wishbook-sec">还封着的</div><div class="wishbook-grid">`;
    for (const e of sealed) {
      h += `<div class="wishbook-seal" title="写的什么不告诉你"><span class="wishbook-seal-mark">✉</span>`
        + `<span class="wishbook-seal-who">${_wsEsc(e.w || 'AI')}</span><time>${_wsEsc(_wsDay(e.at))}</time></div>`;
    }
    h += `</div>`;
  }
  if (opened.length) {
    h += `<div class="wishbook-sec">翻给你看过的</div>`;
    for (const e of opened) {
      h += `<div class="wishbook-open"><b>${_wsEsc(e.item)}</b>`
        + (e.why ? `<p>${_wsEsc(e.why)}</p>` : '')
        + `<span>${_wsEsc(e.w || 'AI')} · ${_wsEsc(_wsDay(e.at))} 记下 · ${_wsEsc(_wsDay(e.open))} 翻开</span></div>`;
    }
  }
  return h;
}
function wishbookRender() {
  const el = typeof document === 'object' && document.getElementById('wishbookBody');
  if (el) el.innerHTML = wishbookHtml();
}
