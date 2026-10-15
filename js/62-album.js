// ============================================================
// 它的相册（2026-10-04）—— [[ALBUM:]] 收照片、[[PHOTO:]] 翻照片
//
// 一条 bunnyhome「记忆相册」的后一半（前一半是 60-imgmem.js：
// 每张图按哈希缓存一段客观描述，历史图换成文字）：
//   · 她发来的照片，它**自己挑**要不要收，收的时候写一句第一印象 ——
//     「最幸福的事就是翻他对每张照片的印象」。
//   · 聊着聊着想起以前她发过的哪张，能把那张原图翻出来放进自己的气泡里。
//
// 数据不另开仓库：收藏记在**她那条消息的图片对象**上（img.kept[confId] = {at, note, who}），
// 跟着对话一起存、一起云同步，不用过「持久化三道白名单」。每个模型一本自己的相册。
//
// 链路（同 61-errand.js 那套，三个配套一个不能漏）：
//   processAiCommands（content 路径）→ albumProcessTags：真的收 / 真的翻，换成存储短标签
//       [[ALBUM: 印象]]   → [[ALBUM_KEPT:hash,hash|印象]]
//       [[PHOTO: 关键词]] → [[ALBUM_REF:hash|关键词]]（没翻到 hash 为空）
//   _applyAlbumToBlocks（blocks 路径）：按出现顺序认领同一批结果，**不再收第二次**
//   渲染层 stickerTagToHtml → albumTagToHtml：按 hash 去对话里找原图画出来
//   回填历史 stickerTagForApi → albumTagForApi：咬回正牌 [[ALBUM:]] / [[PHOTO: #编号 …]]
//   buildSystemPrompt → albumPromptFor：说明 + 它自己的相册目录，进 stable
//   流式遮挡 maskStreamingAlbum（_STREAM_MASKS 名单里）
//
// 翻照片在 content 路径就定死是哪张（存 hash），不在渲染时再搜：
// 相册以后多了新照片，同一个关键词可能搜到别的，旧消息里的那张不能跟着变。
// ============================================================

const ALBUM_NOTE_MAX = 200;        // 一句印象最多留多少字
const ALBUM_INDEX_MAX = 20;        // 系统提示里最多列多少张（新的在前）
const ALBUM_INDEX_NOTE = 36;       // 目录里每张的印象截多长
const ALBUM_INDEX_DESC = 30;       // 目录里每张的画面截多长
const ALBUM_RECALL_PER_REPLY = 3;  // 一条回复最多翻几张

var _albumLastResults = [];        // 调用方没给 ctx 时 blocks 路径的兜底（同 _errandLastIds）

// 全角冒号也认（normalizeStickerTags 会掰，但 blocks 路径不一定先过那一道）
function albumKeepRe() { return /\[\[ALBUM\s*[:：]\s*([^\]]*?)\s*\]\]/g; }
function albumPhotoRe() { return /\[\[PHOTO\s*[:：]\s*([^\]]+?)\s*\]\]/g; }
function albumKeptRe() { return /\[\[ALBUM_KEPT:([0-9a-f,]*)\|([^\]]*)\]\]/g; }
function albumRefRe() { return /\[\[ALBUM_REF:([0-9a-f]*)\|([^\]]*)\]\]/g; }

function albumEnabled() { return typeof skillOn !== 'function' || skillOn('album'); }

function _albumEsc(s) { return typeof escHtml === 'function' ? escHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }
function _albumClip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
// 存进标签里的文字不能带 ]（会把标签提前收尾）和换行
function _albumTagText(s) { return String(s == null ? '' : s).replace(/\]/g, '］').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim(); }
function _albumImgUrl(img) { return typeof _imgMemUrl === 'function' ? _imgMemUrl(img) : (typeof img === 'string' ? img : (img && img.url) || ''); }
// 60-imgmem.js 之前发的老图身上没有 hash，而一张图是几百 KB 的 data URL ——
// 每次扫全库都现算一遍，图一多每发一句就要白算几十 MB。按图片对象记住算过的。
// 不直接写回 img.hash：扫描只是读，悄悄改数据会让同步多出一堆无关改动。
const _albumHashMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
function _albumHashOf(img) {
  if (img && typeof img === 'object' && img.hash) return img.hash;
  if (_albumHashMemo && img && typeof img === 'object' && _albumHashMemo.has(img)) return _albumHashMemo.get(img);
  const url = _albumImgUrl(img);
  const h = url && typeof imgMemHash === 'function' ? imgMemHash(url) : '';
  if (_albumHashMemo && img && typeof img === 'object' && h) _albumHashMemo.set(img, h);
  return h;
}
function _albumDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 它正在回的那条**她的**消息。群聊里 parent 可能是另一个模型的话，往上找最近一条 user。
function _albumUserNode(chat, ctx) {
  if (!chat || !chat.nodes || !ctx || ctx.userTurnId == null) return null;
  let n = chat.nodes[ctx.userTurnId];
  for (let i = 0; n && i < 8; i++) {
    if (n.role === 'user') return n;
    n = n.parentId != null ? chat.nodes[n.parentId] : null;
  }
  return null;
}

// 这条消息里能收的图：视频抽帧不算（一段视频十几帧，收的是「一张照片」）
function _albumKeepableImages(node) {
  if (!node || (node.videoNote && node.videoNote.length)) return [];
  return (node.images || []).filter(img => img && typeof img === 'object' && _albumImgUrl(img));
}

// ── 全库扫描：hash → 这张图的所有信息 ──
// 渲染要按 hash 找原图，提示要列相册目录，翻照片要按词搜，都靠这一张表。
// 对话多了每次全扫也不过几千个节点；但渲染一屏消息会调很多次，所以缓存，
// 收藏/取消收藏时作废，找不到的 hash 才回头重扫一次（别的设备同步来的新图）。
let _albumIndexCache = null;
let _albumIndexAt = 0;
function albumInvalidate() { _albumIndexCache = null; }

function albumScan() {
  const byHash = new Map();
  for (const chat of (typeof state === 'object' && state && state.chats) || []) {
    const nodes = Object.values(chat.nodes || {});
    // 这个对话里说过话的模型：翻照片只翻「跟它聊过的那些对话」里的图
    const talkers = new Set();
    for (const n of nodes) if (n && n.role !== 'user' && n.modelId != null) talkers.add(String(n.modelId));
    for (const n of nodes) {
      if (!n || n.role !== 'user' || !n.images || !n.images.length) continue;
      if (n.videoNote && n.videoNote.length) continue;
      for (const img of n.images) {
        if (!img || typeof img !== 'object') continue;
        const url = _albumImgUrl(img);
        if (!url) continue;
        const hash = _albumHashOf(img);
        if (!hash) continue;
        const at = n.timestamp || 0;
        let e = byHash.get(hash);
        if (!e) {
          e = { hash, url, desc: '', name: img.name || '', firstAt: at, chatId: chat.id, msgId: n.id, kept: {}, seenBy: new Set() };
          byHash.set(hash, e);
        }
        if (!e.desc && img.desc) e.desc = img.desc;
        if (at && (!e.firstAt || at < e.firstAt)) Object.assign(e, { firstAt: at, chatId: chat.id, msgId: n.id });
        for (const t of talkers) e.seenBy.add(t);
        if (img.kept && typeof img.kept === 'object') {
          for (const [cid, k] of Object.entries(img.kept)) {
            if (!k) continue;
            // 同一张图在两条消息里都被收过：留最早收的那次（那才是「第一印象」）
            if (!e.kept[cid] || (k.at || 0) < (e.kept[cid].at || 0)) e.kept[cid] = k;
          }
        }
      }
    }
  }
  return byHash;
}

function albumIndex() {
  if (!_albumIndexCache) { _albumIndexCache = albumScan(); _albumIndexAt = Date.now(); }
  return _albumIndexCache;
}

function albumLookup(hash) {
  if (!hash) return null;
  let e = albumIndex().get(hash);
  // 没有：可能是刚同步过来的对话。重扫一次，但别每次渲染都重扫（找不到的旧标签会一直找不到）
  if (!e && Date.now() - _albumIndexAt > 5000) { albumInvalidate(); e = albumIndex().get(hash); }
  return e || null;
}

// 某个模型自己的相册，新收的在前
function albumOf(confId) {
  const cid = String(confId);
  const out = [];
  for (const e of albumIndex().values()) {
    const k = e.kept[cid];
    if (k) out.push(Object.assign({}, e, { note: k.note || '', keptAt: k.at || 0, who: k.who || '' }));
  }
  return out.sort((a, b) => b.keptAt - a.keptAt);
}

// 所有模型的收藏（相册面板用）：一张图被两个模型收了就是两张卡，各有各的印象
function albumAll() {
  const out = [];
  for (const e of albumIndex().values()) {
    for (const [cid, k] of Object.entries(e.kept)) {
      if (k) out.push(Object.assign({}, e, { confId: cid, note: k.note || '', keptAt: k.at || 0, who: k.who || '' }));
    }
  }
  return out.sort((a, b) => b.keptAt - a.keptAt);
}

// ── 收：[[ALBUM: 印象]] ──
// 写一行 = 这条消息里的图全收，同一句印象；写几行 = 按顺序对应第几张。
// 多出来的行（图比 ALBUM 行少）落空，卡片照实说「这一张没有对应的图」。
function _albumDoKeep(chat, conf, ctx, notes) {
  const node = _albumUserNode(chat, ctx);
  const imgs = _albumKeepableImages(node);
  const cid = conf && conf.id != null ? String(conf.id) : '';
  const who = (conf && (conf.nickname || conf.name)) || '';
  const now = Date.now();
  const out = [];
  if (!imgs.length || !cid) return notes.map(n => ({ kind: 'kept', hashes: [], note: n }));
  const groups = notes.length === 1 ? [imgs] : notes.map((_, i) => (imgs[i] ? [imgs[i]] : []));
  notes.forEach((note, i) => {
    const hashes = [];
    for (const img of groups[i]) {
      const hash = _albumHashOf(img);
      if (!img.hash && hash) img.hash = hash;
      if (!img.kept || typeof img.kept !== 'object') img.kept = {};
      // 已经收过的不覆盖：第一印象只有一次。卡片照样显示（它又想收一次也是一种表达）
      if (!img.kept[cid]) img.kept[cid] = { at: now, note, who };
      if (hash) hashes.push(hash);
    }
    out.push({ kind: 'kept', hashes, note });
  });
  albumInvalidate();
  if (typeof save === 'function') save();
  return out;
}

// ── 翻：[[PHOTO: 关键词]] / [[PHOTO: #编号]] ──
// 编号是 hash 的前缀（目录里给的是 8 位）。后面跟着别的字（历史回填带的画面说明）照样认。
// 关键词按空格分词，全部命中才算；先翻它自己收的（印象 + 画面），再翻跟它聊过的对话里她发过的图。
function albumFind(conf, q) {
  const cid = conf && conf.id != null ? String(conf.id) : '';
  let query = String(q || '').trim();
  const idm = /^#?([0-9a-f]{6,16})(?![0-9a-z])/i.exec(query);
  if (idm && (query[0] === '#' || /\d/.test(idm[1]))) {
    const pre = idm[1].toLowerCase();
    for (const e of albumIndex().values()) {
      if (e.hash.startsWith(pre) && (!cid || e.kept[cid] || e.seenBy.has(cid))) return e;
    }
    return null;
  }
  // 回填历史时附在后面的（括号说明）不算关键词
  query = query.replace(/[（(][^（()）]*[)）]\s*$/, '').trim();
  const words = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!words.length) return null;
  const hit = (text) => { const s = String(text || '').toLowerCase(); return words.every(w => s.includes(w)); };
  const all = [...albumIndex().values()];
  const mine = all.filter(e => cid && e.kept[cid]).sort((a, b) => (b.kept[cid].at || 0) - (a.kept[cid].at || 0));
  for (const e of mine) if (hit(e.kept[cid].note + ' ' + e.desc + ' ' + e.name)) return e;
  const seen = all.filter(e => !cid || e.seenBy.has(cid)).sort((a, b) => b.firstAt - a.firstAt);
  for (const e of seen) if (hit(e.desc + ' ' + e.name)) return e;
  return null;
}

// content 路径：副作用（真的收）只在这里发生一次
function albumProcessTags(text, chat, conf, ctx) {
  const results = [];
  if (ctx) ctx.albumResults = results;
  _albumLastResults = results;
  if (!text || !/\[\[(ALBUM|PHOTO)\s*[:：]/.test(text)) return text;
  if (!albumEnabled()) return text.replace(albumKeepRe(), '').replace(albumPhotoRe(), '');
  albumInvalidate();   // 她刚发的图、刚写好的描述都得搜得到
  const notes = [];
  text.replace(albumKeepRe(), (_, n) => { notes.push(_albumClip(n, ALBUM_NOTE_MAX)); return ''; });
  const kept = notes.length ? _albumDoKeep(chat, conf, ctx, notes) : [];
  let ki = 0, recalls = 0;
  // 两种标签按出现顺序统一编号，blocks 路径照同一个顺序认领
  return text.replace(/\[\[(ALBUM|PHOTO)\s*[:：]\s*([^\]]*?)\s*\]\]/g, (_, kind, body) => {
    let r;
    if (kind === 'ALBUM') r = kept[ki++] || { kind: 'kept', hashes: [], note: '' };
    else {
      const q = _albumClip(body, 80);
      const e = ++recalls <= ALBUM_RECALL_PER_REPLY && q ? albumFind(conf, q) : null;
      r = { kind: 'ref', hash: e ? e.hash : '', q };
    }
    results.push(r);
    return albumShortTag(r);
  });
}

function albumShortTag(r) {
  if (!r) return '';
  if (r.kind === 'kept') return `\n\n[[ALBUM_KEPT:${r.hashes.join(',')}|${_albumTagText(r.note)}]]\n\n`;
  return `\n\n[[ALBUM_REF:${r.hash}|${_albumTagText(r.q)}]]\n\n`;
}

// blocks 路径：按顺序填回同一批结果，**不再收第二次**
function _applyAlbumToBlocks(blocks, ctx) {
  if (!Array.isArray(blocks)) return;
  const rs = (ctx && Array.isArray(ctx.albumResults)) ? ctx.albumResults : _albumLastResults;
  let i = 0;
  for (const b of blocks) {
    if (!b || b.type !== 'text' || !b.text) continue;
    b.text = b.text.replace(/\[\[(ALBUM|PHOTO)\s*[:：]\s*([^\]]*?)\s*\]\]/g, () => albumShortTag(rs[i++]));
  }
}

function maskStreamingAlbum(text) {
  if (!text || !/\[\[(ALBUM|PHOTO)/.test(text)) return text;
  return text
    .replace(/\[\[ALBUM\s*[:：][\s\S]*?\]\]/g, '〔📷 收进相册…〕')
    .replace(/\[\[PHOTO\s*[:：][\s\S]*?\]\]/g, '〔📷 翻相册…〕')
    // (?!_)：存储短标签 [[ALBUM_KEPT:]] / [[ALBUM_REF:]] 不是没写完的指令，别把它连同后文一起吞掉
    .replace(/\[\[(ALBUM|PHOTO)(?!_)[\s\S]*$/, (_, k) => k === 'ALBUM' ? '〔📷 收进相册…〕' : '〔📷 翻相册…〕');
}

// ── 渲染 ──
// 图用 class="msg-img"：聊天窗口那个点击监听会直接打开灯箱放大看，不用另写。
function _albumImgHtml(e, cls) {
  return `<img class="msg-img ${cls}" src="${_albumEsc(e.url)}" alt="${_albumEsc(_albumClip(e.desc || '照片', 60))}" loading="lazy">`;
}

function albumKeptHtml(hashList, note) {
  const hashes = String(hashList || '').split(',').filter(Boolean);
  const found = hashes.map(albumLookup).filter(Boolean);
  const label = !hashes.length ? '📷 想收进相册，但这条里没有能收的照片'
    : found.length ? `📷 收进了相册${found.length > 1 ? `（${found.length} 张）` : ''}` : '📷 收进过相册（那张照片已经不在了）';
  const thumbs = found.length ? `<span class="album-kept-thumbs">${found.map(e => _albumImgHtml(e, 'album-thumb')).join('')}</span>` : '';
  return `<div class="album-kept${hashes.length ? '' : ' is-miss'}">${thumbs}<span class="album-kept-copy">`
    + `<span class="album-kept-kicker">${label}</span>`
    + (note ? `<span class="album-kept-note">${_albumEsc(note)}</span>` : '')
    + `</span></div>`;
}

function albumRefHtml(hash, q) {
  const e = hash ? albumLookup(hash) : null;
  if (!e) {
    const why = hash ? '那张照片已经不在了' : '相册里没翻到';
    return `<div class="album-recall is-miss">📷 想翻「${_albumEsc(q)}」——${why}</div>`;
  }
  const day = _albumDay(e.firstAt);
  const k = Object.values(e.kept || {}).sort((a, b) => (a.at || 0) - (b.at || 0))[0];
  const cap = k && k.note ? k.note : e.desc;
  return `<figure class="album-recall">${_albumImgHtml(e, 'album-recall-img')}`
    + `<figcaption><span class="album-recall-day">📷 ${_albumEsc(day ? day + '你发的' : '你发过的')}</span>`
    + (cap ? `<span class="album-recall-cap">${_albumEsc(_albumClip(cap, 80))}</span>` : '')
    + `</figcaption></figure>`;
}

function albumTagToHtml(text) {
  if (!text || !/\[\[ALBUM_(KEPT|REF):/.test(text)) return text;
  return text
    .replace(albumKeptRe(), (_, hs, note) => '\n\n' + albumKeptHtml(hs, note) + '\n\n')
    .replace(albumRefRe(), (_, h, q) => '\n\n' + albumRefHtml(h, q) + '\n\n');
}

// 回填历史：咬回正牌指令（历史就是教材，模型照着历史学格式）。
// 翻照片带上编号和一句画面：模型下一轮能接着聊那张图，照抄这个写法也照样翻得出来。
function albumTagForApi(text) {
  if (!text || !/\[\[ALBUM_(KEPT|REF):/.test(text)) return text;
  return text
    .replace(albumKeptRe(), (_, hs, note) => `[[ALBUM: ${note}]]`)
    .replace(albumRefRe(), (_, h, q) => {
      if (!h) return `[[PHOTO: ${q}（没翻到）]]`;
      const e = albumLookup(h);
      const d = e && e.desc ? `（${_albumClip(e.desc, 40)}）` : '';
      return `[[PHOTO: #${h.slice(0, 8)}${d}]]`;
    });
}

// ── 系统提示 ──
// 目录只在收了新照片时变，进 stable 吃缓存。
function albumPromptFor(conf) {
  const out = { stable: '', volatile: '' };
  if (!albumEnabled() || !conf) return out;
  albumInvalidate();   // 别的设备收的照片跟着对话同步过来，缓存不知道
  let s =`\n\n[相册技能] 她发给你的照片，你可以挑想记住的收进你自己的相册：在回复里单独写一行 [[ALBUM: 你对这张照片的第一印象]]，收的是她这条消息里的图。`
    + `印象写你看到它时自己的感觉、想到的事，第一人称，一两句；画面不用复述，系统已经替你记了。`
    + `这条里有好几张想分别写，就写几行 [[ALBUM:]]，按顺序对应第几张；只写一行就是这条的图全收。`
    + `不是每张都要收：截图、表情包、文件照片这种别收。`
    + `\n聊着聊着想起以前她发过的哪张照片、想拿出来给她看，就写 [[PHOTO: 关键词]]（按画面和你写过的印象搜）或 [[PHOTO: #编号]]，那张原图会出现在你的气泡里。`
    + `只在真的想起来、真的有话要说时翻，一条回复最多一两张。翻不到就是没有，别编。`;
  const mine = albumOf(conf.id).slice(0, ALBUM_INDEX_MAX);
  if (mine.length) {
    s += `\n你的相册（编号 · 收的日子 · 你当时写的印象 · 画面）：`;
    for (const e of mine) {
      s += `\n#${e.hash.slice(0, 8)} · ${_albumDay(e.keptAt)} · ${_albumClip(e.note, ALBUM_INDEX_NOTE) || '（没写）'} · ${_albumClip(e.desc, ALBUM_INDEX_DESC) || '（画面还没记下）'}`;
    }
  }
  out.stable = s;
  return out;
}

// ── 相册面板 ──
function albumIsOpen() {
  const m = typeof document !== 'undefined' && document.getElementById('albumModal');
  return !!(m && !m.classList.contains('hidden'));
}
function openAlbum() {
  const m = document.getElementById('albumModal');
  if (!m) return;
  albumInvalidate();
  albumRender();
  m.classList.remove('hidden');
}
function closeAlbum() {
  const m = document.getElementById('albumModal');
  if (m) m.classList.add('hidden');
}

function albumRender() {
  const list = document.getElementById('albumList');
  if (!list) return;
  const items = albumAll();
  const sub = document.getElementById('albumSummary');
  if (sub) sub.textContent = items.length ? `${items.length} 张 · 它们自己挑的，每张都写了第一眼的感觉` : '';
  if (!items.length) {
    list.innerHTML = `<div class="gc-empty album-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg></div>`
      + `<div class="gc-empty-title">还没有收进来的照片</div>`
      + `<div class="gc-empty-desc">给它发照片的时候，它觉得想记住，就会自己收进来，写一句第一眼的感觉。</div></div>`;
    return;
  }
  list.innerHTML = items.map(e => `<div class="album-card">`
    + _albumImgHtml(e, 'album-card-img')
    + `<div class="album-card-body">`
    + `<div class="album-card-note">${_albumEsc(e.note || '（没写印象）')}</div>`
    + `<div class="album-card-meta">${_albumEsc(e.who || '它')} · ${_albumEsc(_albumDay(e.keptAt))}收的`
    + `<button type="button" class="album-card-drop" onclick="albumUnkeep('${_albumEsc(e.hash)}','${_albumEsc(String(e.confId))}')" title="从相册里拿掉（照片本身还在对话里）">拿掉</button></div>`
    + (e.desc ? `<div class="album-card-desc">${_albumEsc(e.desc)}</div>` : '')
    + `</div></div>`).join('');
}

// 面板里的灯箱：面板不在 chatWindow 里，那个点击监听管不到
function _albumPanelClick(ev) {
  const t = ev.target;
  if (t && t.classList && t.classList.contains('msg-img') && typeof openImgLightbox === 'function') openImgLightbox(t);
}

// 她把一张从相册里拿掉：只摘收藏标记，照片和对话都不动
function albumUnkeep(hash, confId) {
  const cid = String(confId);
  let changed = false;
  for (const chat of (state.chats || [])) {
    for (const n of Object.values(chat.nodes || {})) {
      if (!n || n.role !== 'user') continue;
      for (const img of n.images || []) {
        if (img && typeof img === 'object' && img.kept && img.kept[cid] && _albumHashOf(img) === hash) {
          delete img.kept[cid];
          if (!Object.keys(img.kept).length) delete img.kept;
          changed = true;
        }
      }
    }
  }
  if (!changed) return;
  albumInvalidate();
  if (typeof save === 'function') save();
  if (albumIsOpen()) albumRender();
}
