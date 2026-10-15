// ============================================================
// 藏宝地图（2026-10-12）—— AI 在用户会去的地方埋纸条
//
// 用户在地图上点一下，把她常去的地方标成「公园门口」这种命名地点（kind='place'）。
// AI（Claude Code 里的我，或聊天里的 AI）在某个地点埋一张纸条（kind='letter'）。
// 她到了那里，在地图的小旗上点「我到这儿了」打个卡，才拆得开（**默认不碰定位**，纯信任——
// 她怕开手机定位让谷歌按位置改账号地区）。设置里「定位提醒」开了，才走原生接近提醒：
// 走到附近（默认 150m）安卓壳弹通知，点开进 App 看纸条。
//
// ⚠️ 这块最要紧的一条：**纸条正文在被找到之前不能露出来**。
//   聊天气泡、通知、地图、列表、DOM 里都不许有正文，只能有地点和标题。所以：
//   · [[HIDE_LETTER: 地点 | 标题 | 正文]] 在 content 路径执行完，正文**不留在消息里**，
//     消息里只存 [[TREASURE_HID:id|地点|标题|谁]]（复制、分享、朗读、云同步对话都碰不到正文）；
//   · blocks 路径（渲染优先用它）换成同一张卡片；thinking 块里抄了一遍的也盖掉；
//   · 流式时整段遮住（maskStreamingTreasure），回复被掐断留下的半截指令也遮住；
//   · 渲染层兜底：漏到渲染的裸 [[HIDE_LETTER…]] 一律画成占位，不画正文；
//   · 交给原生的 setLetters 列表不含 body。
//   回填给 AI（ForApi）时可以带正文 —— 它要记得自己写了什么。
//
// 数据：Supabase public.letters（契约见 briefs/treasure.md），前端直连读写，不进 settings 整包。
//   坐标**存库永远是 WGS-84**；高德底图是 GCJ-02，显示时 wgs2gcj，点地图拿到的 gcj2wgs 再存。
//   本机缓存在 localStorage（离线能看、能先标地点），没写上云的行带 _dirty，下次连上补写。
//   表还没建 / 没登录 / 断网都不白屏：面板顶上说一句，先存本机。
//
// 原生桥 window.GrancyanTreasure（安卓壳实现，桌面 exe 上不存在，处处判空）：
//   available / status / requestPermissions / locate(cbId) / setLetters(json) / takePending
//   回调：window._treasureNative(kind, payload)；点通知进来：window._treasureOpen(id)
//
// 链路（同 62-album.js 那套）：
//   processAiCommands（content 路径）→ treasureProcessTags：真的埋（只在这里一次）
//   _applyTreasureToBlocks（blocks 路径）：按出现顺序认领同一批结果，**不再埋第二次**
//   渲染层 stickerTagToHtml → treasureTagToHtml：画卡片（不含正文）
//   回填历史 stickerTagForApi → treasureTagForApi：咬回 [[HIDE_LETTER: 地点 | 标题 | 正文]]
//   buildSystemPrompt → treasurePromptFor：说明 + 地点名单（不给坐标）+ 最近找到的
//   流式遮挡 maskStreamingTreasure（_STREAM_MASKS 名单里）
// ============================================================

const TREASURE_CACHE_KEY = 'gc_treasure_v1';
const TREASURE_VIEW_KEY = 'gc_treasure_view';
const TREASURE_RADIUS = 150;
const TREASURE_TITLE_MAX = 40;
const TREASURE_BODY_MAX = 2000;
const TREASURE_PLACE_MAX = 24;
const TREASURE_PER_REPLY = 3;          // 一条回复最多埋几张
const TREASURE_PROMPT_PLACES = 20;     // 系统提示里最多列几个地点
const TREASURE_PROMPT_FOUND = 5;       // 系统提示里列最近找到的几张
const TREASURE_TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';

// ── WGS-84 ⇄ GCJ-02（国测局「火星坐标」标准算法；境外不偏移）──
const _TR_A = 6378245.0;
const _TR_EE = 0.00669342162296594323;
function treasureOutOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function _trDLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function _trDLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}
// 返回 [lat, lng]（Leaflet 的顺序）
function wgs2gcj(lat, lng) {
  if (treasureOutOfChina(lat, lng)) return [lat, lng];
  let dLat = _trDLat(lng - 105.0, lat - 35.0);
  let dLng = _trDLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - _TR_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((_TR_A * (1 - _TR_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (_TR_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}
// 反算没有解析解：迭代逼近（几步就到亚厘米级）。粗算版「减一次偏移」会差 1~2 米，
// 一来一回地点就慢慢漂走，所以用迭代。
function gcj2wgs(lat, lng) {
  if (treasureOutOfChina(lat, lng)) return [lat, lng];
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 12; i++) {
    const g = wgs2gcj(wLat, wLng);
    const eLat = g[0] - lat, eLng = g[1] - lng;
    wLat -= eLat; wLng -= eLng;
    if (Math.abs(eLat) < 1e-10 && Math.abs(eLng) < 1e-10) break;
  }
  return [wLat, wLng];
}
// 两点距离（米），haversine
function treasureDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── 小工具 ──
function _trEsc(s) {
  s = String(s == null ? '' : s);
  return typeof escHtml === 'function' ? escHtml(s)
    : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _trClip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
// 存进标签里的文字不能带 ]（会把标签提前收尾）、|（分段）和换行
function _trTagText(s) { return String(s == null ? '' : s).replace(/\]/g, '］').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim(); }
function _trDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function _trUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
  const b = new Array(16);
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) { const u = crypto.getRandomValues(new Uint8Array(16)); for (let i = 0; i < 16; i++) b[i] = u[i]; }
  } catch (_) {}
  for (let i = 0; i < 16; i++) if (b[i] == null) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function _trIsId(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
// 地点名比较：去引号、空白，大小写不敏感
function _trNorm(s) { return String(s == null ? '' : s).replace(/[「」『』“”"'《》【】\[\]（）()]/g, '').replace(/\s+/g, '').toLowerCase(); }

function treasureEnabled() { return typeof skillOn !== 'function' || skillOn('treasure'); }

// ── 本机数据 ──
// rows 里每行就是一条 letters 记录；本机多两个字段：
//   _dirty: 'new'（整行还没上云）| 'patch'（改过的字段在 _patch 里，待写）
const _tr = { rows: [], loaded: false, cloud: 'unknown', cloudMsg: '', busy: null, uid: '', syncedAt: 0 };

function _trLoadCache() {
  if (_tr.loaded) return;
  _tr.loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(TREASURE_CACHE_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && Array.isArray(j.rows)) _tr.rows = j.rows.filter(r => r && _trIsId(r.id));
    if (j && j.uid) _tr.uid = String(j.uid);
  } catch (_) { /* 缓存坏了就当没有，云端还在 */ }
}
function _trSaveCache() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TREASURE_CACHE_KEY, JSON.stringify({ v: 1, at: Date.now(), uid: _tr.uid || '', rows: _tr.rows }));
  } catch (_) {}
}
function _trRow(id) { _trLoadCache(); return _tr.rows.find(r => r.id === id) || null; }
function treasurePlaces() {
  _trLoadCache();
  return _tr.rows.filter(r => r.kind === 'place' && !r.deleted_at)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}
function treasureLetters() { _trLoadCache(); return _tr.rows.filter(r => r.kind === 'letter' && !r.deleted_at); }
function treasureBuried() { return treasureLetters().filter(r => !r.found_at); }
function treasureFoundList() {
  return treasureLetters().filter(r => r.found_at)
    .sort((a, b) => String(b.found_at).localeCompare(String(a.found_at)));
}
function treasureFindPlace(name) {
  const n = _trNorm(name);
  if (!n) return null;
  const ps = treasurePlaces();
  const exact = ps.find(p => _trNorm(p.place) === n);
  if (exact) return exact;
  // 模型偶尔多写/少写一两个字（「公园门口」写成「公园大门口」）：只有唯一一处包含关系时才认
  const near = ps.filter(p => { const q = _trNorm(p.place); return q && (q.includes(n) || n.includes(q)); });
  return near.length === 1 ? near[0] : null;
}

// 交给原生的列表：**不含 body**，只有还埋着的
function treasureNativeList() {
  return treasureBuried()
    .filter(r => Number.isFinite(+r.lat) && Number.isFinite(+r.lng))
    .map(r => ({ id: r.id, lat: +r.lat, lng: +r.lng, radius_m: +r.radius_m || TREASURE_RADIUS, title: r.title || '', place: r.place || '' }));
}
function _trNative() {
  try {
    const n = typeof window !== 'undefined' ? window.GrancyanTreasure : null;
    if (n && typeof n.available === 'function' && n.available()) return n;
  } catch (_) {}
  return null;
}
// 定位提醒开关：**默认关，关着就一点都不碰定位** ——
// 她怕开了手机定位，谷歌按位置把账号区域改掉。关着时：不调 locate / requestPermissions，
// 也不调 navigator.geolocation（桌面 Electron 的那个走谷歌网络定位，一样不许）；
// 交给原生的永远是 []（把以前挂上的提醒撤干净）；解锁靠在小旗上「我到这儿了」打卡。
// 这是这台设备自己的开关（手机开、电脑不开很正常），存在 localStorage，不进云端整包。
const TREASURE_GEO_KEY = 'gc_treasure_geo';
function treasureGeoOn() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(TREASURE_GEO_KEY) === '1'; } catch (_) { return false; }
}
function _trSetGeo(on) {
  try { if (typeof localStorage !== 'undefined') { if (on) localStorage.setItem(TREASURE_GEO_KEY, '1'); else localStorage.removeItem(TREASURE_GEO_KEY); } } catch (_) {}
  treasureSyncNative();
}
function treasureSyncNative() {
  const n = _trNative();
  if (!n || typeof n.setLetters !== 'function') return false;
  const list = treasureGeoOn() ? treasureNativeList() : [];
  try { n.setLetters(JSON.stringify(list)); return true; } catch (e) { console.warn('[藏宝] setLetters', e); return false; }
}

// ── 云端 ──
function _trCloudReady() {
  return typeof supabaseClient !== 'undefined' && supabaseClient && typeof currentUser !== 'undefined' && !!currentUser;
}
// 表还没建 → 'closed'（还没开张）；断网 → 'offline'；别的 → 'error'
function _trClassifyErr(err) {
  const msg = String((err && (err.message || err.details || err.hint)) || err || '');
  const code = String((err && err.code) || '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204'
    || /does not exist|could not find the table|schema cache|relation .*letters/i.test(msg)) return 'closed';
  if (/failed to fetch|network|load failed|timeout|ERR_INTERNET|ENOTFOUND|fetch failed/i.test(msg)) return 'offline';
  return 'error';
}
function _trCloudRowOf(r) {
  const o = {};
  for (const k of ['id', 'kind', 'place', 'lat', 'lng', 'radius_m', 'title', 'body', 'hidden_by', 'created_at', 'found_at', 'deleted_at']) {
    if (r[k] !== undefined) o[k] = r[k];
  }
  return o;
}

// 拉一次表，和本机没写上去的合并，再把没写上去的补写。并发调用共用同一次。
// 本机行多带两个字段：_rev（每改一次 +1）和 _t（最后一次本机改动的时间）。
//   · flush 只在「发出去的那一版」还是最新时才清 _dirty —— 请求在路上时又改了，就留着下回再写；
//   · select 发出去之后才在本机新建/改过的行（_t ≥ 发请求的时刻），云端快照里自然没有，**不能当成被删了丢掉**；
//   · 还标着 'new' 的行就算云端已有（上次写成功了但响应丢了）也以本机为准，下回整行再 upsert 一次。
function treasureRefresh() {
  if (_tr.busy) return _tr.busy;
  _tr.busy = (async () => {
    _trLoadCache();
    if (!_trCloudReady()) { _tr.cloud = 'nologin'; _tr.cloudMsg = ''; return _tr.cloud; }
    try {
      const t0 = Date.now();
      const uid = (typeof currentUser !== 'undefined' && currentUser && currentUser.id) || '';
      const { data, error } = await supabaseClient.from('letters').select('*').is('deleted_at', null).order('created_at', { ascending: true });
      if (error) { _tr.cloud = _trClassifyErr(error); _tr.cloudMsg = error.message || ''; return _tr.cloud; }
      // 换了账号：上一个账号留在本机的（连没上云的一起）不带过来，免得写进这个账号
      if (_tr.uid && uid && _tr.uid !== uid) _tr.rows = _tr.rows.filter(r => (r._t || 0) >= t0);
      _tr.uid = uid;
      const server = new Map((data || []).filter(r => r && _trIsId(r.id)).map(r => [r.id, r]));
      const merged = [];
      for (const r of server.values()) {
        const loc = _tr.rows.find(x => x.id === r.id);
        if (loc && (loc._dirty === 'new' || (loc._t || 0) >= t0)) merged.push(loc);
        else if (loc && loc._dirty === 'patch' && loc._patch) merged.push(Object.assign({}, r, loc._patch, { _dirty: 'patch', _patch: loc._patch, _rev: loc._rev, _t: loc._t }));
        else merged.push(r);
      }
      // 本机新建、还没上云的留着；请求发出后才动过的留着；其余本机有、云端没有的 = 别的账号的或被软删了，丢掉
      for (const loc of _tr.rows) {
        if (server.has(loc.id)) continue;
        if (loc._dirty === 'new' || (loc._t || 0) >= t0) merged.push(loc);
      }
      _tr.rows = merged;
      _tr.cloud = 'ok'; _tr.cloudMsg = ''; _tr.syncedAt = Date.now();
      await _trFlush();
    } catch (e) {
      _tr.cloud = _trClassifyErr(e); _tr.cloudMsg = String((e && e.message) || e);
    } finally {
      _trSaveCache();
      treasureSyncNative();
    }
    return _tr.cloud;
  })().finally(() => { _tr.busy = null; if (treasureIsOpen()) treasureRender(); });
  return _tr.busy;
}

async function _trFlush() {
  if (!_trCloudReady() || _tr.cloud === 'closed') return;
  for (const r of _tr.rows.slice()) {
    if (!r._dirty) continue;
    const rev = r._rev, kind = r._dirty, patch = r._patch;
    try {
      let res;
      if (kind === 'new') res = await supabaseClient.from('letters').upsert(_trCloudRowOf(r), { onConflict: 'id' });
      else res = await supabaseClient.from('letters').update(Object.assign({}, patch || {})).eq('id', r.id);
      if (res && res.error) { _tr.cloud = _trClassifyErr(res.error); _tr.cloudMsg = res.error.message || ''; if (_tr.cloud !== 'error') return; continue; }
      // 请求在路上时又改过（rev 变了）：别清，下回把新的那版再写一次
      if (r._rev === rev) { delete r._dirty; delete r._patch; }
    } catch (e) { _tr.cloud = _trClassifyErr(e); return; }
  }
  _trSaveCache();
}

function _trTouch(r) { r._rev = (r._rev || 0) + 1; r._t = Date.now(); }

function _trAdd(row) {
  _trLoadCache();
  row._dirty = 'new';
  _trTouch(row);
  _tr.rows.push(row);
  _trSaveCache();
  treasureSyncNative();
  _trFlush().then(() => { _trSaveCache(); if (treasureIsOpen()) treasureRender(); });
  return row;
}
function _trPatch(id, patch) {
  const r = _trRow(id);
  if (!r) return null;
  Object.assign(r, patch);
  _trTouch(r);
  // 'new' 的行下回整行 upsert，带的就是最新的；已经上过云的只写改了的字段
  if (r._dirty !== 'new') { r._dirty = 'patch'; r._patch = Object.assign({}, r._patch || {}, patch); }
  _trSaveCache();
  treasureSyncNative();
  _trFlush().then(() => { _trSaveCache(); if (treasureIsOpen()) treasureRender(); });
  return r;
}

function treasureAddPlace(name, lat, lng) {
  const place = _trClip(name, TREASURE_PLACE_MAX);
  if (!place) return { ok: false, why: '名字空着' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, why: '坐标不对' };
  if (treasurePlaces().some(p => _trNorm(p.place) === _trNorm(place))) return { ok: false, why: `已经有一个叫「${place}」的地方了` };
  const row = _trAdd({
    id: _trUuid(), kind: 'place', place, lat, lng, radius_m: TREASURE_RADIUS,
    title: null, body: null, hidden_by: 'user', created_at: new Date().toISOString(), found_at: null, deleted_at: null,
  });
  return { ok: true, row };
}

// 埋：只认已标过的地点，坐标和半径照抄那个地点
function treasureHide({ place, title, body, by, who } = {}) {
  const p = treasureFindPlace(place);
  const t = _trClip(title, TREASURE_TITLE_MAX);
  const b = String(body == null ? '' : body).trim().slice(0, TREASURE_BODY_MAX);
  if (!p) return { ok: false, why: 'noplace', place: _trClip(place, TREASURE_PLACE_MAX), title: t };
  if (!b) return { ok: false, why: 'empty', place: p.place, title: t };
  const row = _trAdd({
    id: _trUuid(), kind: 'letter', place: p.place, lat: +p.lat, lng: +p.lng, radius_m: +p.radius_m || TREASURE_RADIUS,
    title: t || '一张纸条', body: b, hidden_by: by || 'chat', created_at: new Date().toISOString(), found_at: null, deleted_at: null,
  });
  return { ok: true, id: row.id, place: row.place, title: row.title, who: who || '' };
}

// ── 指令：[[HIDE_LETTER: 地点 | 标题 | 正文]] ──
function treasureHidRe() { return /\[\[TREASURE_HID:([0-9a-f-]{36})\|([^|\]]*)\|([^|\]]*)\|([^|\]]*)\]\]/g; }
function treasureMissRe() { return /\[\[TREASURE_MISS:([a-z]+)\|([^|\]]*)\|([^|\]]*)\]\]/g; }
const _TR_ANY_RE = /\[\[HIDE_LETTER/;
// 模型自己照抄出来的存储短标签（只有 treasureProcessTags 生成的才算数，免得它「假装埋好了」）
const _TR_FORGED_RE = /\[\[TREASURE_(?:HID|MISS):[^\]]*\]\]/g;

// 找出每一条 [[HIDE_LETTER…]]。**按 [[ / ]] 配对数层数**，不用惰性正则：
// 正文里夹一个 [[STICKER:抱抱]]（或者 [表情:抱抱] 被 normalizeStickerTags 改写成的那个），
// 惰性正则会在它的 ]] 处提前收尾，后半截正文就原样露在气泡里。
// 返回 [{start, end, inner, cut}]：cut = 到结尾都没配上（回复被掐断 / 还在流）
function _trFind(text) {
  const out = [];
  if (!text || text.indexOf('[[HIDE_LETTER') < 0) return out;
  const head = /\[\[HIDE_LETTER/g;
  let m;
  while ((m = head.exec(text))) {
    const from = m.index + m[0].length;
    let i = from, depth = 1;
    while (i < text.length && depth > 0) {
      if (text.charCodeAt(i) === 91 && text.charCodeAt(i + 1) === 91) { depth++; i += 2; }        // [[
      else if (text.charCodeAt(i) === 93 && text.charCodeAt(i + 1) === 93) { depth--; i += 2; }   // ]]
      else i++;
    }
    const cut = depth > 0;
    const end = cut ? text.length : i;
    const raw = text.slice(from, cut ? text.length : i - 2);
    const im = /^\s*[:：]\s*([\s\S]*)$/.exec(raw);
    out.push({ start: m.index, end, inner: im ? im[1] : null, cut });
    head.lastIndex = end;
  }
  return out;
}
function _trReplace(text, fn) {
  const segs = _trFind(text);
  if (!segs.length) return text;
  let res = '', last = 0;
  for (const s of segs) { res += text.slice(last, s.start) + fn(s); last = s.end; }
  return res + text.slice(last);
}

// 前两个竖线是分隔，第三段起原样都是正文（正文里的竖线、空格不动）
function _trSplit(inner) {
  const m = /^([^|｜]*)[|｜]([^|｜]*)[|｜]([\s\S]*)$/.exec(String(inner || ''));
  if (!m) return null;
  return { place: m[1].trim(), title: m[2].trim(), body: m[3].trim() };
}

var _treasureLastResults = [];

function treasureShortTag(r) {
  if (!r) return '';
  if (r.ok) return `\n\n[[TREASURE_HID:${r.id}|${_trTagText(r.place)}|${_trTagText(r.title)}|${_trTagText(r.who)}]]\n\n`;
  return `\n\n[[TREASURE_MISS:${r.why || 'fail'}|${_trTagText(r.place)}|${_trTagText(r.title)}]]\n\n`;
}

// content 路径：副作用（真的埋）只在这里发生一次
function treasureProcessTags(text, chat, conf, ctx) {
  const results = [];
  if (ctx) ctx.treasureResults = results;
  _treasureLastResults = results;
  if (!text) return text;
  if (text.indexOf('[[TREASURE_') >= 0) text = text.replace(_TR_FORGED_RE, '');
  if (!_TR_ANY_RE.test(text)) return text;
  if (!treasureEnabled()) return _trReplace(text, () => '');
  const who = (conf && (conf.nickname || conf.name)) || '';
  let n = 0;
  return _trReplace(text, seg => {
    let r;
    // 写到一半被停了：正文半截也不许露
    if (seg.cut) r = { ok: false, why: 'cut', place: '', title: '' };
    else {
      const s = seg.inner == null ? null : _trSplit(seg.inner);
      if (!s) r = { ok: false, why: 'format', place: '', title: '' };
      else if (++n > TREASURE_PER_REPLY) r = { ok: false, why: 'limit', place: _trClip(s.place, TREASURE_PLACE_MAX), title: _trClip(s.title, TREASURE_TITLE_MAX) };
      else r = treasureHide({ place: s.place, title: s.title, body: s.body, by: 'chat', who });
    }
    results.push(r);
    return treasureShortTag(r);
  });
}

// blocks 路径：按顺序填回同一批结果，**不再埋第二次**；thinking 里抄过的指令也盖住
function _applyTreasureToBlocks(blocks, ctx) {
  if (!Array.isArray(blocks)) return;
  const rs = (ctx && Array.isArray(ctx.treasureResults)) ? ctx.treasureResults : _treasureLastResults;
  const on = treasureEnabled();
  let i = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text.indexOf('[[TREASURE_') >= 0) b.text = b.text.replace(_TR_FORGED_RE, '');
      if (!_TR_ANY_RE.test(b.text)) continue;
      // 技能关着：同 content 路径，整条抹掉（不画「没埋成」卡片，两条路说法一致）
      b.text = _trReplace(b.text, seg => on
        ? treasureShortTag(rs[i++] || { ok: false, why: seg.cut ? 'cut' : 'fail', place: '', title: '' })
        : '');
    } else if (b.type === 'thinking') {
      for (const k of ['text', 'thinking']) {
        if (typeof b[k] === 'string' && _TR_ANY_RE.test(b[k])) b[k] = treasureVeil(b[k]);
      }
    }
  }
}

// 只遮不埋（thinking 块、渲染兜底、出错/找回那几条不走 processAiCommands 的路用）
function treasureVeil(text) {
  // 小本子（71-wishbook.js）的 [[WISH:]] 也不许露在思考里：挂在这里，所有纸条遮挡点顺带都遮了
  if (typeof wishVeil === 'function') text = wishVeil(text);
  if (!text || typeof text !== 'string' || !_TR_ANY_RE.test(text)) return text;
  return _trReplace(text, () => '〔🎁 一张纸条（正文藏起来了）〕');
}
// 整个消息节点过一遍：content / reasoning 是字符串直接换；blocks 只在 live=false 时动
// （流式回调里的 blocks 是流还在往里追加的那份，原地改了会把收尾时的认领打乱）
function treasureVeilNode(node, live) {
  if (!node) return node;
  if (typeof node.content === 'string') node.content = treasureVeil(node.content);
  if (typeof node.reasoning === 'string') node.reasoning = treasureVeil(node.reasoning);
  if (!live && Array.isArray(node.blocks)) {
    for (const b of node.blocks) {
      if (!b) continue;
      for (const k of ['text', 'thinking']) if (typeof b[k] === 'string') b[k] = treasureVeil(b[k]);
    }
  }
  return node;
}

function maskStreamingTreasure(text) {
  if (!text || text.indexOf('[[HID') < 0) return text;
  return _trReplace(text, () => '〔🎁 埋纸条…〕')
    // 标签名还没写全（[[HID… 停在结尾）也先遮上
    .replace(/\[\[HID(?:E(?:_(?:L(?:E(?:T(?:T(?:E(?:R)?)?)?)?)?)?)?)?$/, '〔🎁 埋纸条…〕');
}

// ── 渲染（卡片上**不出现正文**）──
const _TR_MISS_WHY = {
  noplace: '地图上没有这个地点', empty: '纸条是空的', format: '格式不对（要「地点 | 标题 | 正文」三段）',
  limit: '一条消息最多埋三张', cut: '写到一半断了', fail: '没埋成',
};
function treasureCardHtml(id, place, title, who) {
  const r = _trRow(id);
  let state;
  if (r && r.deleted_at) state = '<span class="treasure-card-st">这张纸条已经收回了</span>';
  else if (r && r.found_at) state = `<span class="treasure-card-st is-found">你 ${_trEsc(_trDay(r.found_at))}找到了 · 点开看</span>`;
  else if (r) state = `<span class="treasure-card-st">还埋着 · 到了那儿点小旗打个卡就能拆开</span>`;
  else state = '<span class="treasure-card-st">埋好了</span>';
  const name = who ? _trEsc(who) : '它';
  return `<div class="treasure-card${r && r.found_at ? ' is-found' : ''}" onclick="treasureCardTap('${id}')" title="打开藏宝地图">`
    + `<span class="treasure-card-ico" aria-hidden="true">🎁</span><span class="treasure-card-copy">`
    + `<span class="treasure-card-k">${name}在「${_trEsc(place)}」埋了一张纸条</span>`
    + `<b class="treasure-card-t">${_trEsc(title || '一张纸条')}</b>${state}</span></div>`;
}
function treasureMissHtml(why, place, title) {
  const where = place ? `在「${_trEsc(place)}」` : '';
  return `<div class="treasure-card is-miss"><span class="treasure-card-ico" aria-hidden="true">🎁</span><span class="treasure-card-copy">`
    + `<span class="treasure-card-k">想${where}埋一张纸条${title ? '「' + _trEsc(title) + '」' : ''}，没埋成</span>`
    + `<span class="treasure-card-st">${_trEsc(_TR_MISS_WHY[why] || _TR_MISS_WHY.fail)}</span></span></div>`;
}
function treasureTagToHtml(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.indexOf('[[TREASURE_') >= 0) {
    text = text
      .replace(treasureHidRe(), (_, id, place, title, who) => '\n\n' + treasureCardHtml(id, place, title, who) + '\n\n')
      .replace(treasureMissRe(), (_, why, place, title) => '\n\n' + treasureMissHtml(why, place, title) + '\n\n');
  }
  // 兜底：没经过 processAiCommands 的裸指令（老消息、半路崩掉存下的草稿）也不许画出正文
  if (_TR_ANY_RE.test(text)) text = treasureVeil(text);
  return text;
}

// 回填历史：咬回正牌指令，带上正文（它要记得自己写了什么）和她找到没有
function treasureTagForApi(text) {
  if (!text || typeof text !== 'string' || text.indexOf('[[TREASURE_') < 0) return text;
  return text
    .replace(treasureHidRe(), (_, id, place, title) => {
      const r = _trRow(id);
      if (!r || !r.body) return `[埋过一张纸条：「${place}」·「${title}」（正文这台设备上没读到）]`;
      const st = r.deleted_at ? '（已收回）' : r.found_at ? `（她 ${_trDay(r.found_at)}找到了）` : '（还埋着，她还没找到）';
      return `[[HIDE_LETTER: ${r.place || place} | ${r.title || title} | ${r.body}]]${st}`;
    })
    .replace(treasureMissRe(), (_, why, place, title) =>
      `[想${place ? '在「' + place + '」' : ''}埋纸条${title ? '「' + title + '」' : ''}，没埋成：${_TR_MISS_WHY[why] || _TR_MISS_WHY.fail}]`);
}

// ── 系统提示 ──
function treasurePromptFor(conf) {
  const out = { stable: '', volatile: '' };
  if (!treasureEnabled() || !conf) return out;
  let s = `\n\n[藏宝地图] 用户在藏宝地图上标了她常去的地方，你可以在其中一处给她埋一张纸条：单独一行写 [[HIDE_LETTER: 地点名 | 标题 | 正文]]。`
    + `她得亲自到那里、在地图上打个卡，才拆得开正文。`
    + `地点名只能照抄下面列着的；标题会露在通知和地图上，别剧透；正文在她找到之前谁都看不到，聊天里也别复述。想留个惊喜时再埋，不用常埋。`;
  const places = treasurePlaces();
  if (!places.length) {
    s += `\n她还没标地点，现在埋不了；想埋可以请她去小组件「藏宝地图」里标一个。`;
  } else {
    const buried = treasureBuried();
    const list = places.slice(0, TREASURE_PROMPT_PLACES).map(p => {
      const k = buried.filter(l => _trNorm(l.place) === _trNorm(p.place)).length;
      return k ? `${p.place}（还埋着 ${k} 张）` : p.place;
    });
    s += `\n她标过的地点：${list.join('、')}`;
    const found = treasureFoundList().slice(0, TREASURE_PROMPT_FOUND);
    if (found.length) s += `\n她最近找到的：${found.map(l => `「${_trClip(l.title, 20)}」（${l.place}，${_trDay(l.found_at)}）`).join('、')}`;
  }
  out.stable = s;
  return out;
}

// ═══════════════════════════════════════════════════════
// 面板
// ═══════════════════════════════════════════════════════
let _trMap = null, _trLayer = null, _trMeLayer = null, _trPick = null, _trLib = null;
let _trTab = 'map';
let _trSheet = null;   // 底部小抽屉现在在干什么：{kind:'name', lat, lng} | {kind:'place', id} | {kind:'gift', ids} | {kind:'perm'}
let _trLetterId = null;

function treasureIsOpen() {
  const m = typeof document !== 'undefined' && document.getElementById && document.getElementById('treasureModal');
  return !!(m && !m.classList.contains('hidden'));
}

function _trLoadLib() {
  if (typeof L !== 'undefined' && L && L.map) return Promise.resolve();
  if (_trLib) return _trLib;
  _trLib = new Promise((resolve, reject) => {
    if (!document.getElementById('leafletCss')) {
      const l = document.createElement('link');
      l.id = 'leafletCss'; l.rel = 'stylesheet'; l.href = './js/lib/leaflet.min.css';
      document.head.appendChild(l);
    }
    const s = document.createElement('script');
    s.src = './js/lib/leaflet.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _trLib = null; reject(new Error('地图库没加载成功')); };
    document.head.appendChild(s);
  });
  return _trLib;
}

function openTreasure() {
  const m = document.getElementById('treasureModal');
  if (!m) return;
  m.classList.remove('hidden');
  _trLoadCache();
  treasureRender();
  _trEnsureMap();
  treasureRefresh();
}
function closeTreasure() {
  document.getElementById('treasureModal')?.classList.add('hidden');
  _trSheet = null; _trLetterId = null; _trQueue = [];
  _trNoViewSave = false;
}

function treasureTab(k) {
  _trTab = k === 'found' ? 'found' : 'map';
  _trSheet = null;
  if (_trPick) { try { _trPick.remove(); } catch (_) {} _trPick = null; }
  treasureRender();
  if (_trTab === 'map' && _trMap) setTimeout(() => { try { _trMap.invalidateSize(); } catch (_) {} }, 30);
}

async function _trEnsureMap() {
  const el = document.getElementById('treasureMap');
  if (!el) return;
  if (_trMap) { setTimeout(() => { try { _trMap.invalidateSize(); } catch (_) {} _trDrawMarkers(); }, 30); return; }
  try { await _trLoadLib(); } catch (e) {
    el.innerHTML = '<div class="treasure-map-fail">地图库没加载成功——列表还能看</div>';
    return;
  }
  if (_trMap || !document.getElementById('treasureMap')) return;
  let view = null;
  try { view = JSON.parse(localStorage.getItem(TREASURE_VIEW_KEY) || 'null'); } catch (_) {}
  _trMap = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true });
  L.control.zoom({ position: 'bottomright' }).addTo(_trMap);
  L.tileLayer(TREASURE_TILE_URL, { subdomains: '1234', minZoom: 3, maxZoom: 18, attribution: '© 高德地图' }).addTo(_trMap);
  _trLayer = L.layerGroup().addTo(_trMap);
  _trMeLayer = L.layerGroup().addTo(_trMap);
  const ps = treasurePlaces();
  if (view && Number.isFinite(view.lat) && Number.isFinite(view.lng)) _trMap.setView([view.lat, view.lng], view.z || 15);
  else if (ps.length) _trFitPlaces();
  else _trMap.setView([35.0, 105.0], 4);
  _trMap.on('click', ev => _trMapClick(ev.latlng));
  _trMap.on('moveend', () => {
    if (_trNoViewSave) return;   // 这次打开定过位：之后的视野都在她身边，一概不记（她的坐标不进 localStorage）
    try { const c = _trMap.getCenter(); localStorage.setItem(TREASURE_VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, z: _trMap.getZoom() })); } catch (_) {}
  });
  _trDrawMarkers();
  setTimeout(() => { try { _trMap.invalidateSize(); } catch (_) {} }, 60);
}

function _trFitPlaces() {
  const ps = treasurePlaces();
  if (!_trMap || !ps.length) return;
  const pts = ps.map(p => wgs2gcj(+p.lat, +p.lng));
  if (pts.length === 1) _trMap.setView(pts[0], 16);
  else _trMap.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}

function _trIcon(cls, html, size, anchor) {
  return L.divIcon({ className: 'treasure-pin ' + cls, html, iconSize: size, iconAnchor: anchor });
}
const _TR_FLAG_SVG = '<svg viewBox="0 0 24 30" class="treasure-flag-svg"><path class="p" d="M5 28V3"/><path class="f" d="M5.5 4c4-2 7 2 11 0l3-.8v10c-3.5 1.6-7-2-11 0l-3 .8z"/></svg>';

function _trDrawMarkers() {
  if (!_trMap || !_trLayer || typeof L === 'undefined') return;
  _trLayer.clearLayers();
  for (const p of treasurePlaces()) {
    const ll = wgs2gcj(+p.lat, +p.lng);
    const m = L.marker(ll, { icon: _trIcon('is-place', _TR_FLAG_SVG + `<span class="treasure-pin-name">${_trEsc(p.place)}</span>`, [24, 30], [5, 28]) });
    m.on('click', () => _trOpenSheet({ kind: 'place', id: p.id }));
    m.addTo(_trLayer);
  }
  // 还埋着的：同一个坐标的并成一个发光小礼物圈（只带张数，不带正文）
  const groups = new Map();
  for (const l of treasureBuried()) {
    const k = (+l.lat).toFixed(6) + ',' + (+l.lng).toFixed(6);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  for (const ls of groups.values()) {
    const ll = wgs2gcj(+ls[0].lat, +ls[0].lng);
    const html = `<span class="treasure-gift"><i></i><b>🎁</b>${ls.length > 1 ? `<em>${ls.length}</em>` : ''}</span>`;
    // 放在小旗左上方：右边是地点名牌，别压住
    const m = L.marker(ll, { icon: _trIcon('is-gift', html, [34, 34], [40, 34]), zIndexOffset: 500 });
    m.on('click', () => _trOpenSheet({ kind: 'gift', ids: ls.map(l => l.id) }));
    m.addTo(_trLayer);
  }
  // 找到的：小信封，点开看
  for (const l of treasureFoundList()) {
    const ll = wgs2gcj(+l.lat, +l.lng);
    const m = L.marker(ll, { icon: _trIcon('is-found', '<span class="treasure-env">✉</span>', [22, 22], [28, 6]) });
    m.on('click', () => treasureOpenLetter(l.id));
    m.addTo(_trLayer);
  }
  if (_trPick) _trPick.addTo(_trLayer);
}

function _trMapClick(latlng) {
  if (!latlng) return;
  const w = gcj2wgs(latlng.lat, latlng.lng);
  if (_trPick) { try { _trPick.remove(); } catch (_) {} }
  _trPick = L.marker([latlng.lat, latlng.lng], { icon: _trIcon('is-pick', _TR_FLAG_SVG, [24, 30], [5, 28]), interactive: false });
  _trPick.addTo(_trLayer);
  _trOpenSheet({ kind: 'name', lat: w[0], lng: w[1] });
  setTimeout(() => document.getElementById('treasureNameIn')?.focus(), 30);
}

function _trOpenSheet(s) {
  _trSheet = s;
  if (s.kind !== 'name' && _trPick) { try { _trPick.remove(); } catch (_) {} _trPick = null; }
  _trRenderSheet();
}
function treasureSheetClose() {
  _trSheet = null;
  if (_trPick) { try { _trPick.remove(); } catch (_) {} _trPick = null; }
  _trRenderSheet();
}

function treasureSavePlace() {
  if (!_trSheet || _trSheet.kind !== 'name') return;
  const inp = document.getElementById('treasureNameIn');
  const r = treasureAddPlace(inp ? inp.value : '', _trSheet.lat, _trSheet.lng);
  if (!r.ok) { if (typeof showToast === 'function') showToast(r.why, 'info', 2200); return; }
  if (typeof showToast === 'function') showToast(`标好了：「${r.row.place}」`, 'success', 1800);
  if (_trPick) { try { _trPick.remove(); } catch (_) {} }
  _trPick = null; _trSheet = null;
  treasureRender();
}

// 拿掉地点 = 软删（deleted_at）。函数名别叫 delete*/remove*（渲染消毒会拿掉，虽然这里不走消毒也别养成习惯）
function treasureRetirePlace(id, sure) {
  const p = _trRow(id);
  if (!p || p.kind !== 'place') return;
  if (!sure) { _trSheet = { kind: 'place', id, confirm: true }; _trRenderSheet(); return; }
  _trPatch(id, { deleted_at: new Date().toISOString() });
  _trSheet = null;
  treasureRender();
}

// 「我在这」：**只在定位提醒开着时**才有（默认关，按钮都不出现）。
// 手机走原生精确定位，桌面走 navigator.geolocation。拿到的坐标**只用来挪地图中心**：
// 不存库、不进缓存、不发给谁，连「上次看的地图位置」都不记这一下。
let _trLocSeq = 0;
let _trNoViewSave = false;
function treasureLocateMe() {
  if (!treasureGeoOn()) return false;
  const n = _trNative();
  if (n && typeof n.locate === 'function') {
    const cbId = 'tr' + (++_trLocSeq);
    _trSetStatusNote('正在找你在哪…');
    try { n.locate(cbId); } catch (e) { _trSetStatusNote('定位没成功：' + (e.message || e)); }
    return true;
  }
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    _trSetStatusNote('正在找你在哪…');
    navigator.geolocation.getCurrentPosition(
      pos => _trOnLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      err => _trSetStatusNote('定位没成功（' + (err && err.message || '没权限') + '），可以直接在地图上点'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    return true;
  }
  _trSetStatusNote('这台设备没法定位，直接在地图上点就好');
  return false;
}
function _trOnLoc(d) {
  if (!treasureGeoOn()) return;
  if (!d || d.error || !Number.isFinite(+d.lat) || !Number.isFinite(+d.lng)) {
    _trSetStatusNote('定位没成功' + (d && d.error ? '：' + d.error : '') + '，可以直接在地图上点');
    return;
  }
  _trSetStatusNote('');
  if (_trMap && typeof L !== 'undefined') {
    const ll = wgs2gcj(+d.lat, +d.lng);
    _trMeLayer.clearLayers();
    L.marker(ll, { icon: _trIcon('is-me', '<span class="treasure-me"></span>', [16, 16], [8, 8]), interactive: false }).addTo(_trMeLayer);
    _trNoViewSave = true;
    _trMap.setView(ll, Math.max(_trMap.getZoom(), 16));
  }
}

function _trSetStatusNote(s) {
  const el = document.getElementById('treasureNote');
  if (el) { el.textContent = s || ''; el.classList.toggle('hidden', !s); }
}

// ── 原生回调 ──
function _treasureNativeIn(kind, payload) {
  let d = payload;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
  if (kind === 'loc') _trOnLoc(d);
  else if (kind === 'perm') { _trPermCache = d; if (treasureIsOpen()) treasureRender(); }
}
let _trPermCache = null;
function treasurePermStatus() {
  if (!treasureGeoOn()) return null;
  const n = _trNative();
  if (!n || typeof n.status !== 'function') return null;
  try { const s = n.status(); return typeof s === 'string' ? JSON.parse(s) : s; } catch (_) { return _trPermCache; }
}
function treasureAskPerms(go) {
  if (!treasureGeoOn()) return;
  const n = _trNative();
  if (!n) return;
  if (!go) { _trOpenSheet({ kind: 'perm' }); return; }
  _trSheet = null; _trRenderSheet();
  try { n.requestPermissions(); } catch (e) { if (typeof showToast === 'function') showToast('权限没要成：' + (e.message || e), 'error', 3000); }
}

// 定位提醒开关：开之前先说清楚代价（开了手机定位，谷歌那边也可能读到位置）
function treasureGeoToggle(go) {
  if (treasureGeoOn()) {
    _trSetGeo(false);          // 关：原生那边立刻 setLetters([])，撤干净
    if (_trMeLayer) { try { _trMeLayer.clearLayers(); } catch (_) {} }
    _trSheet = null; treasureRender();
    return;
  }
  if (!go) { _trOpenSheet({ kind: 'geo' }); return; }
  _trSetGeo(true);
  _trSheet = null;
  treasureRender();
  if (_trNative()) treasureAskPerms();   // 手机上接着讲权限那一步（还是先给解释，不直接弹）
}

// 打卡：在小旗上点「我到这儿了」，这处还埋着的纸条一张一张拆开。不看真实位置，纯信任。
let _trQueue = [];
function _trBuriedAt(name) { const n = _trNorm(name); return treasureBuried().filter(l => _trNorm(l.place) === n); }
function treasureCheckIn(id) {
  const r = _trRow(id);
  if (!r) return 0;
  const ls = _trBuriedAt(r.place).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  if (!ls.length) { if (typeof showToast === 'function') showToast(`「${r.place}」这儿现在没有埋着的纸条`, 'info', 2200); return 0; }
  _trQueue = ls.slice(1).map(l => l.id);
  treasureOpenLetter(ls[0].id, _TR_CHECKIN);
  return ls.length;
}

// 聊天卡片点进来：找到了的直接开信；还埋着的只开地图、对准那里（不露正文）
function treasureCardTap(id) {
  if (!_trIsId(id)) return;
  const r = _trRow(id);
  openTreasure();
  if (r && r.found_at && !r.deleted_at) { treasureOpenLetter(id); return; }
  if (r && _trMap) setTimeout(() => { try { _trMap.setView(wgs2gcj(+r.lat, +r.lng), 16); } catch (_) {} }, 80);
  if (r && !r.found_at) _trOpenSheet({ kind: 'gift', ids: [id] });
}

// 打开纸条。找到前只有两种情况能开：她在小旗上打了卡（_TR_CHECKIN）、点到达通知进来的（_TR_NOTIFY）；
// 找到过的随便开。两个凭证都是模块里私有的对象，不是字符串 —— 聊天里模型自己写的 HTML 按钮
// （渲染消毒放行「调 App 全局函数 + 字面量参数」）写不出它们，替她「打卡」不了。
const _TR_NOTIFY = Object.freeze({ notify: true });
const _TR_CHECKIN = Object.freeze({ checkin: true });
function treasureOpenLetter(id, why) {
  const r = _trRow(id);
  if (!r || r.kind !== 'letter' || r.deleted_at) { if (typeof showToast === 'function') showToast('这张纸条不在了', 'info', 2000); return false; }
  const allowed = !!r.found_at || why === _TR_NOTIFY || why === _TR_CHECKIN;
  if (!allowed) { _trOpenSheet({ kind: 'gift', ids: [id] }); return false; }
  if (!r.found_at) _trPatch(id, { found_at: new Date().toISOString() });   // 第一次打开 = 找到了
  _trSheet = null;      // 「还埋着」那个抽屉别留在信纸底下
  _trLetterId = id;
  if (!treasureIsOpen()) openTreasure(); else treasureRender();
  return true;
}
function treasureCloseLetter() {
  _trLetterId = null;
  // 打卡拆的是这一处的好几张：收好一张，接着下一张
  while (_trQueue.length) {
    const next = _trQueue.shift();
    const r = _trRow(next);
    if (r && !r.found_at && !r.deleted_at) { treasureOpenLetter(next, _TR_CHECKIN); return; }
  }
  treasureRender();
}

// 点通知进 App（原生调）：必要时先拉一次表
// 本机还没有这张（AI 刚从电脑那头埋的、冷启动还没登录好）：pending 已经被取走、通知也只响一次，
// 这一下不能丢 —— 等登录好、拉到了再开，最多等 TREASURE_OPEN_WAIT 毫秒。
const TREASURE_OPEN_WAIT = 45000;
async function _treasureOpenIn(id, waitMs) {
  if (!_trIsId(id)) return false;
  _trLoadCache();
  const until = Date.now() + (waitMs == null ? TREASURE_OPEN_WAIT : waitMs);
  let told = false;
  while (!_trRow(id)) {
    if (_trCloudReady()) { try { await treasureRefresh(); } catch (_) {} }
    if (_trRow(id) || Date.now() >= until) break;
    if (!told && typeof showToast === 'function') { told = true; showToast('正在把那张纸条拉过来…', 'info', 2500); }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!_trRow(id)) { if (typeof showToast === 'function') showToast('那张纸条还没同步过来——等网好了从藏宝地图里打开', 'info', 4000); return false; }
  if (!treasureIsOpen()) openTreasure();
  return treasureOpenLetter(id, _TR_NOTIFY);
}

// ── 画 ──
const _TR_BY = { cc: '克克 · 从电脑那头埋的', chat: '聊天里埋的', user: '你自己埋的' };
function _trCloudLine() {
  switch (_tr.cloud) {
    case 'closed': return '藏宝地图还没开张——云端放纸条的柜子还没搭好。你标的地点先存在这台设备上，开张后自动搬上去。';
    case 'nologin': return '没登录云端账号：先存在这台设备上，登录后自动同步。';
    case 'offline': return '连不上云端，先用这台设备上存着的。';
    case 'error': return '云端读写出了点问题' + (_tr.cloudMsg ? '（' + _trClip(_tr.cloudMsg, 60) + '）' : '') + '，先用这台设备上存着的。';
    default: return '';
  }
}

function treasureRender() {
  if (typeof document === 'undefined') return;
  const cloud = document.getElementById('treasureCloud');
  if (cloud) { const s = _trCloudLine(); cloud.textContent = s; cloud.classList.toggle('hidden', !s); }
  const sum = document.getElementById('treasureSum');
  if (sum) {
    const ps = treasurePlaces().length, b = treasureBuried().length, f = treasureFoundList().length;
    sum.textContent = `${ps} 个地点 · 还埋着 ${b} 张 · 找到 ${f} 张`;
  }
  // 原生提醒权限一行（桌面没有原生桥就不显示）
  const perm = document.getElementById('treasurePerm');
  if (perm) {
    const st = treasurePermStatus();
    if (!st) { perm.classList.add('hidden'); perm.innerHTML = ''; }
    else {
      const miss = [];
      if (!st.fine) miss.push('精确定位');
      if (!st.notify) miss.push('通知');
      if (!st.background) miss.push('后台定位');
      perm.classList.remove('hidden');
      perm.innerHTML = miss.length
        ? `<span>到达提醒还差：${_trEsc(miss.join('、'))}${st.locationOn === false ? '（手机定位也关着）' : ''}</span><button type="button" class="treasure-btn" onclick="treasureAskPerms()">去开</button>`
        : `<span>到达提醒开着${st.locationOn === false ? '，但手机定位关着' : ''}：走到埋纸条的地方会响</span>`;
    }
  }
  const geoOn = treasureGeoOn();
  document.getElementById('treasureMeBtn')?.classList.toggle('hidden', !geoOn);
  const geo = document.getElementById('treasureGeo');
  if (geo) {
    geo.innerHTML = geoOn
      ? `<span>定位提醒开着${_trNative() ? '：走近埋纸条的地方手机会响' : ''}。坐标只用来挪地图，不存、不发。</span><button type="button" class="treasure-btn" onclick="treasureGeoToggle()">关掉</button>`
      : `<span>定位提醒（要开手机定位）：关着——一点都不碰定位，到了地方点小旗「我到这儿了」就能拆。</span><button type="button" class="treasure-btn" onclick="treasureGeoToggle()">开</button>`;
  }
  for (const k of ['map', 'found']) {
    document.getElementById('treasureTab_' + k)?.classList.toggle('on', _trTab === k);
  }
  document.getElementById('treasureStage')?.classList.toggle('hidden', _trTab !== 'map');
  const fl = document.getElementById('treasureFound');
  if (fl) {
    fl.classList.toggle('hidden', _trTab !== 'found');
    if (_trTab === 'found') fl.innerHTML = _trFoundHtml();
  }
  _trDrawMarkers();
  _trRenderSheet();
  _trRenderLetter();
}

function _trFoundHtml() {
  const list = treasureFoundList();
  if (!list.length) {
    const b = treasureBuried().length;
    return `<div class="treasure-empty">还没有找到的纸条。${b ? `<br>地图上还埋着 ${b} 张，到了那儿点小旗打个卡就能拆开。` : '<br>克克埋下第一张之后，到了那里打个卡就能拆开。'}</div>`;
  }
  return list.map(l => `<button type="button" class="treasure-row" onclick="treasureOpenLetter('${l.id}')">`
    + `<span class="treasure-row-ico">✉</span><span class="treasure-row-copy"><b>${_trEsc(l.title || '一张纸条')}</b>`
    + `<small>${_trEsc(l.place || '')} · ${_trEsc(_trDay(l.found_at))}找到 · ${_trEsc(_TR_BY[l.hidden_by] || '')}</small></span></button>`).join('');
}

function _trRenderSheet() {
  const el = document.getElementById('treasureSheet');
  if (!el) return;
  const s = _trSheet;
  if (!s) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  let h = '';
  if (s.kind === 'name') {
    h = `<div class="treasure-sheet-t">把这里标成…</div>`
      + `<input id="treasureNameIn" class="treasure-in" maxlength="${TREASURE_PLACE_MAX}" placeholder="比如：公园门口、常去的那家咖啡店" onkeydown="if(event.key==='Enter')treasureSavePlace()">`
      + `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureSheetClose()">算了</button><button type="button" class="treasure-btn treasure-go" onclick="treasureSavePlace()">标上</button></div>`
      + `<div class="treasure-sheet-hint">克克只看得到地点的名字，看不到坐标。</div>`;
  } else if (s.kind === 'place') {
    const p = _trRow(s.id);
    if (!p) { _trSheet = null; el.classList.add('hidden'); return; }
    const b = treasureBuried().filter(l => _trNorm(l.place) === _trNorm(p.place)).length;
    const f = treasureFoundList().filter(l => _trNorm(l.place) === _trNorm(p.place)).length;
    h = `<div class="treasure-sheet-t">⚑ ${_trEsc(p.place)}</div>`
      + `<div class="treasure-sheet-sub">还埋着 ${b} 张 · 在这里找到过 ${f} 张</div>`
      + (s.confirm
        ? `<div class="treasure-sheet-sub">拿掉之后克克就不能再往这里埋了${b ? `（已经埋着的 ${b} 张还在，地图上照样看得到、拆得开）` : ''}。确定？</div>`
          + `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureSheetClose()">留着</button><button type="button" class="treasure-btn treasure-warn" onclick="treasureRetirePlace('${p.id}',true)">拿掉</button></div>`
        : `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureRetirePlace('${p.id}')">不要这个地点了</button><button type="button" class="treasure-btn" onclick="treasureSheetClose()">好</button>`
          + (b ? `<button type="button" class="treasure-btn treasure-go" onclick="treasureCheckIn('${p.id}')">我到这儿了</button>` : '') + `</div>`);
  } else if (s.kind === 'gift') {
    const ls = (s.ids || []).map(_trRow).filter(l => l && !l.deleted_at);
    if (!ls.length) { _trSheet = null; el.classList.add('hidden'); return; }
    const anyBuried = ls.some(l => !l.found_at);
    h = `<div class="treasure-sheet-t">🎁 「${_trEsc(ls[0].place)}」埋着 ${ls.length} 张纸条</div>`
      + ls.map(l => `<div class="treasure-gift-row"><span><b>${_trEsc(l.title || '一张纸条')}</b><small>${_trEsc(_trDay(l.created_at))}埋下 · ${_trEsc(_TR_BY[l.hidden_by] || '')}</small></span>`
        + (l.found_at ? `<button type="button" class="treasure-btn" onclick="treasureOpenLetter('${l.id}')">看</button>` : `<em>还埋着</em>`) + `</div>`).join('')
      + `<div class="treasure-sheet-hint">到了那儿点「我到这儿了」就能拆开${treasureGeoOn() && _trNative() ? '；走近了手机也会响' : '（不看定位，凭你一句话）'}。</div>`
      + `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureSheetClose()">好</button>`
      + (anyBuried ? `<button type="button" class="treasure-btn treasure-go" onclick="treasureCheckIn('${ls[0].id}')">我到这儿了</button>` : '') + `</div>`;
  } else if (s.kind === 'geo') {
    h = `<div class="treasure-sheet-t">开定位提醒？</div>`
      + `<div class="treasure-sheet-sub">开了之后，走近埋纸条的地方手机会响，「我在这」也能用。但这要开手机定位——<b>开了手机定位，谷歌那边也可能读到你的位置</b>（比如按位置改账号地区）。`
      + `你的坐标不存进库、不发给克克，只用来挪地图。不开也完全能玩：到了地方点小旗打个卡就行。</div>`
      + `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureSheetClose()">先不开</button><button type="button" class="treasure-btn treasure-go" onclick="treasureGeoToggle(true)">知道了，开</button></div>`;
  } else if (s.kind === 'perm') {
    h = `<div class="treasure-sheet-t">开到达提醒</div>`
      + `<div class="treasure-sheet-sub">要三样：精确定位（知道你走到哪了）、通知（到了响一声）、后台定位（App 关着也能提醒）。`
      + `最后一步安卓会跳到设置页——在「位置信息」里选「始终允许」，再回来就好。</div>`
      + `<div class="treasure-sheet-acts"><button type="button" class="treasure-btn" onclick="treasureSheetClose()">先不</button><button type="button" class="treasure-btn treasure-go" onclick="treasureAskPerms(true)">好，去开</button></div>`;
  }
  el.innerHTML = h;
  el.classList.remove('hidden');
}

// 信纸上不画聊天里的指令：正文里夹着的 [[STICKER:抱抱]] 这类换成〔抱抱〕，别露一串方括号
function _trLetterText(s) {
  return String(s == null ? '' : s).replace(/\[\[[A-Z_]+\s*[:：]\s*([^\]]*?)\s*\]\]/g, '〔$1〕').replace(/\[\[[A-Z_]+\]\]/g, '');
}
function _trRenderLetter() {
  const el = document.getElementById('treasureLetter');
  if (!el) return;
  const r = _trLetterId ? _trRow(_trLetterId) : null;
  if (!r || !r.found_at || r.deleted_at) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = `<div class="treasure-paper" role="dialog" aria-label="纸条">`
    + `<div class="treasure-paper-place">埋在「${_trEsc(r.place || '')}」</div>`
    + `<h4 class="treasure-paper-title">${_trEsc(r.title || '一张纸条')}</h4>`
    + `<div class="treasure-paper-body">${_trEsc(_trLetterText(r.body))}</div>`
    + `<div class="treasure-paper-sign">${_trEsc(_TR_BY[r.hidden_by] || '')} · ${_trEsc(_trDay(r.created_at))}埋下 · 你 ${_trEsc(_trDay(r.found_at))}找到</div>`
    + `<button type="button" class="treasure-btn treasure-paper-x" onclick="treasureCloseLetter()">收好了</button></div>`;
  el.classList.remove('hidden');
}

// ── 启动 ──
// 冷启动：先用本机缓存把提醒挂上（离线也能响），问原生是不是点通知进来的；
// 登录好了再拉一次云端。
let _trBooted = false;
function treasureBoot() {
  if (_trBooted) return;
  _trBooted = true;
  _trLoadCache();
  treasureSyncNative();
  const n = _trNative();
  if (n && typeof n.takePending === 'function') {
    let id = '';
    try { id = String(n.takePending() || ''); } catch (_) {}
    if (id) setTimeout(() => _treasureOpenIn(id), 300);
  }
  // 等登录：头一分钟勤着看，之后半分钟看一次（离线进来、过会儿才登录的也接得上）
  let tries = 0;
  const wait = () => {
    if (_trCloudReady()) { treasureRefresh(); return; }
    setTimeout(wait, ++tries < 40 ? 1500 : 30000);
  };
  wait();
  // AI 从电脑那头新埋的，要拉下来交给原生才会响 —— 不能只靠「开面板 / 重启」才拉。
  // 表很小（几十行），一刻钟一次 + 切回前台时（隔了两分钟以上）补一次，流量可以忽略。
  setInterval(() => { if (_trCloudReady()) treasureRefresh(); }, TREASURE_SYNC_EVERY);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && _trCloudReady() && Date.now() - (_tr.syncedAt || 0) > 120000) treasureRefresh();
    });
  }
}
const TREASURE_SYNC_EVERY = 15 * 60 * 1000;

if (typeof window !== 'undefined') {
  window._treasureNative = _treasureNativeIn;
  window._treasureOpen = _treasureOpenIn;
  if (typeof window.addEventListener === 'function') {
    if (typeof document !== 'undefined' && document.readyState === 'complete') setTimeout(treasureBoot, 1200);
    else window.addEventListener('load', () => setTimeout(treasureBoot, 1200));
  }
}
