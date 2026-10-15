/* 设置那一行：另一台改了一点点，这台只下载那一点点（2026-10-14，10-13 一天又 401MB）。
 *
 * 10-11 修完之后「云端没动」只问一下时间，但「另一台推过」还是整包 4MB；
 * 而且 10-13 后台日志里整包 253 次、问时间的只有 ~95 次 —— 大部分整包是在没缓存的时候拉的。
 * 这里守住第二轮修的几件事（两台「设备」= 两个独立的 vm 上下文，共用一个假云端）：
 *   · 另一台只改了一个小键 → 这台只下载那个键（下载量 ≈ 那个键的大小），不是整包
 *   · state 没变 → 不推（不推就不动 updated_at，另一台也不用拉）
 *   · 收藏 / 记忆这种「一袋东西」两台顺序不一样不算变化，不然两台为了顺序永远互推
 *   · 云端 jsonb 会把对象的键重排，拉回来再推不能被当成「变了」
 *   · 整页刷新 / App 被回收重开：缓存从 IndexedDB 读回来，不再整包
 *   · 中转没回话改走直连：不再把缓存清空；推的那份真推上去了就直接认
 *   · 有人绕过 pushCloudSettings 写了 settings（_ver._at 对不上）→ 认得出来，退回整包
 *   · 老 server（10-11 那版）不认 cols → 跟以前一样，不多拉
 *   · 同步串行：上一轮还在推，下一轮不会叠上去再拉一遍
 *   · server 的 cols 白名单：只认 updated_at / settings / 别名:settings->键名
 *
 * 真跑的是 js/01-core.js 的原函数（vm 抽段）和 server/cloud.js 的原 GET handler；fetch / supabase 是假的，碰不到网。
 * 跑法：node tests/cloud-settings-delta.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSingleSrc } = require('./_src-map');

const ROOT = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'js/01-core.js'), 'utf8');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
};
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

const from = core.indexOf('function cloudError(');
const to = core.indexOf('async function rawUpsertChats(');
if (from < 0 || to < 0) throw new Error('云同步段锚点变了');
const seg = core.slice(from, to);

// ── server 的真 GET handler（跟 cloud-settings-cache.test.js 同样抠法）──
const server = readSingleSrc('cloud').text;
function grabHandler(sig) {
  const at = server.indexOf(sig);
  const fnAt = server.indexOf('async (req, res) => {', at);
  let i = server.indexOf('{', fnAt), d = 0, end = -1;
  for (let j = i; j < server.length; j++) {
    if (server[j] === '{') d++;
    else if (server[j] === '}' && --d === 0) { end = j + 1; break; }
  }
  if (at < 0 || end < 0) throw new Error('server handler 抠不出来: ' + sig);
  return server.slice(fnAt, end);
}
const getHandlerSrc = grabHandler("app.get('/api/cloud-profile'");

// ── 假云端：一行 profiles。jsonb 存进去会把对象的键重排（短的在前，同长按字节），这里照做 ──
function jsonbify(v) {
  if (Array.isArray(v)) return v.map(jsonbify);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))) out[k] = jsonbify(v[k]);
    return out;
  }
  return v;
}
const pgTs = d => new Date(d).toISOString().replace('Z', '+00:00');
function makeCloud() {
  return {
    row: null,             // { settings, updated_at }
    mode: 'new',           // new = 这次的 server；old = 10-11 那版（只认 select 白名单）
    proxyDown: false,      // 中转连不上（电脑关了 / 手机不在家）
    postLoseReply: false,  // 中转那次其实写进去了，但回包丢了（前端只看到网络错）
    directFail: false,     // 直连也失败
    postDelay: 0, inflight: 0, maxInflight: 0,
    log: [], bytes: 0,
  };
}
function evalSelect(c, sel) {
  if (!c.row) return [];
  const out = {};
  for (const p of sel.split(',')) {
    if (p === 'updated_at') out.updated_at = c.row.updated_at;
    else if (p === 'settings') out.settings = clone(c.row.settings);
    else {
      const m = p.match(/^(\w+):settings->(\w+)$/);
      if (!m) throw new Error('假云端不认这一列: ' + p);
      const v = c.row.settings[m[2]];
      out[m[1]] = v === undefined ? null : clone(v);   // PostgREST：键不存在回 null
    }
  }
  return [out];
}
function store(c, row) {
  c.row = { settings: jsonbify(clone(row.settings)), updated_at: pgTs(row.updated_at) };
}
const resp = (status, body) => ({ ok: status < 300, status, json: async () => clone(body), text: async () => JSON.stringify(body) });

async function proxyFetch(c, url, opts = {}) {
  if (c.proxyDown) throw new Error('Failed to fetch');
  const u = new URL(url);
  if ((opts.method || 'GET') === 'GET') {
    let data;
    if (c.mode === 'new') {
      // 真 handler，axios 换成直接读假云端
      const axios = { get: async gurl => {
        const sel = new URL(gurl).searchParams.get('select');
        return { status: 200, data: evalSelect(c, sel) };
      } };
      const fn = new Function('axios', 'outboundAgent', 'SUPABASE_URL', 'return ' + getHandlerSrc)(axios, async () => null, 'https://sb');
      const query = Object.fromEntries(u.searchParams.entries());
      const res = { _s: 200, status(s) { this._s = s; return this; }, json(b) { data = b; return this; } };
      await fn({ headers: { authorization: 'Bearer x', apikey: 'k' }, query }, res);
    } else {
      const s = u.searchParams.get('select');
      data = evalSelect(c, ['settings', 'updated_at', 'settings,updated_at'].includes(s) ? s : 'settings');
    }
    const txt = JSON.stringify(data);
    if (c.onVer && /^updated_at,ver:settings->_ver$/.test(u.searchParams.get('cols') || '')) await c.onVer();   // 模拟「要完 _ver 之后另一台又推了」
    c.bytes += txt.length;
    c.log.push('GET ' + (data[0] ? Object.keys(data[0]).join(',') : '∅'));
    return resp(200, data);
  }
  // POST
  c.inflight++; c.maxInflight = Math.max(c.maxInflight, c.inflight);
  try {
    if (c.postDelay) await new Promise(r => setTimeout(r, c.postDelay));
    const body = JSON.parse(opts.body);
    store(c, body);
    c.log.push('POST');
    if (c.postLoseReply) throw new Error('Failed to fetch');
    return resp(201, { ok: true });
  } finally { c.inflight--; }
}
function fakeSupabase(c, uidRef) {
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: uidRef.id } } } }) },
    from() {
      return {
        select: cols => {
          const q = {
            abortSignal() { return q; },
            single: async () => {
              c.log.push('direct GET ' + cols);
              if (c.directFail) return { data: null, error: { message: 'down', status: 503 } };
              const rows = evalSelect(c, cols);
              if (!rows.length) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
              c.bytes += JSON.stringify(rows[0]).length;
              return { data: rows[0], error: null };
            },
          };
          return q;
        },
        upsert: async row => {
          c.log.push('direct POST');
          if (c.directFail) return { error: { message: 'down', status: 503 } };
          store(c, JSON.parse(JSON.stringify(row)));
          return { error: null };
        },
      };
    },
  };
}

// 「一袋东西」（收藏 / 记忆）按认人的键比：同一条两边版本可以不同（合并规则就是本机为准），其它键整份比
const BAGK = { favMessages: f => f.chatId + '/' + f.nodeId, brainMemories: m => String(m.text).trim().toLowerCase(), memories: m => String(m.text).trim().toLowerCase(), proustMems: m => String(m.id) };
function sameAsCloud(got, cloudS) {
  const a = jsonbify(clone(got)), b = jsonbify(clone(cloudS)); delete b._ver;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (BAGK[k] && Array.isArray(a[k]) && Array.isArray(b[k])) {
      if (JSON.stringify([...new Set(a[k].map(BAGK[k]))].sort()) !== JSON.stringify([...new Set(b[k].map(BAGK[k]))].sort())) return 'bag ' + k;
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return k;
  }
  return true;
}
// 测试里模拟「中转又通了」：把「中转连不上，先直连一阵」的记号清掉
const upOk = dev => vm.runInContext('_cloudProxyDownUntil = 0', dev);
// 一台「设备」= 一个独立上下文（各自的内存缓存、各自的 IndexedDB）
function device(c, name, opts = {}) {
  const idb = opts.idb || new Map();
  const uidRef = { id: 'u1' };
  const box = {
    console: { log() {}, info() {}, warn() {}, error: console.error },
    JSON, Number, String, Object, Array, Date, Promise, Error, URL, Set, Map, Math,
    navigator: { onLine: true },
    setTimeout, clearTimeout, AbortController,
    SERVER_BASE: 'http://127.0.0.1:9',
    SUPABASE_ANON_KEY: 'anon',
    fetch: (url, o) => proxyFetch(c, url, o),
    supabaseClient: fakeSupabase(c, uidRef),
    idbGet: async k => idb.has(k) ? clone(idb.get(k)) : null,
    idbSet: async (k, v) => { idb.set(k, clone(v)); },
    currentUser: { id: 'u1' },
    state: opts.state ? clone(opts.state) : {},
    // 合并器：这里只关心流量，按「本机为准」最简单地桩掉（真合并规则各有各的测试）
    _cfgCanon: function canon(v) {   // 跟 02-state.js 的 _cfgCanon 一样：键排序后比
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
      return JSON.stringify(v === undefined ? null : v);
    },
    _mergeConfigs: a => a,
    _mergeProust: (a, b) => a || b || [],
    _mergeStickerAiOff: (cl, lo) => lo || {},
    _mergeStickerGroupOf: (cl, lo) => lo || {},
    _mergeStickerGroupState: lo => lo,
    _mergeThinkOpen: (lo, lv) => ({ on: lo, ver: lv }),
    // 点歌：最近播放按时间戳谁新用谁（真规则见 24-music.js 的 musicSyncMerge）
    musicSyncApply(cloud) {
      const st = box.state;
      const cr = cloud && cloud.musicRecent;
      if (cr && cr.ts > ((st.musicRecent && st.musicRecent.ts) || 0)) st.musicRecent = clone(cr);
      return { changed: false, payload: { musicRecent: st.musicRecent || null } };
    },
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(seg + '\nthis.fetchCloudSettings = fetchCloudSettings; this.pushCloudSettings = pushCloudSettings;'
    + ' this.syncSettingsToCloud = syncSettingsToCloud; this._cloudCacheFlush = _cloudCacheFlush;'
    + ' this._cloudVerOf = _cloudVerOf; this.stats = cloudStats;', box);
  box.name = name; box.idb = idb;
  return box;
}

// 她那行的形状（10-11 量的：favMessages 1.7M / brainMemories 0.9M / configs 0.6M…），按 1/20 缩小
const big = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: i + 1, text: tag + '·' + i + '·' + 'x'.repeat(40), chatId: 7, nodeId: 1000 + i, ts: 1760000000000 + i }));
function herState() {
  return {
    favMessages: big(1300, '收藏'), brainMemories: big(700, '记忆'),
    configs: Array.from({ length: 30 }, (_, i) => ({ id: i, nickname: 'm' + i, persona: 'p'.repeat(900), apiBase: 'https://x', modelName: 'claude' })),
    configsVer: 3,
    memories: big(40, '小记'), proustMems: [],
    musicRecent: { ts: 1, list: [{ id: 1, name: '晴天' }] },
    vitalsByModel: {}, deletedChats: { 5: 1760000000000 },
    accentColor: '#7aa2f7', userName: '小明',
  };
}

async function main() {
  console.log('\n[1] 另一台只改了一个小键 → 这台只下载那个键');
  const c = makeCloud();
  const A = device(c, '电脑', { state: herState() });
  const B = device(c, '手机', { state: herState() });
  await A.syncSettingsToCloud();                   // 电脑先把整行推上去（云端原来没有这一行）
  t('第一次：电脑推上去了', c.log.includes('POST') && !!c.row, c.log);
  const rowSize = JSON.stringify(c.row.settings).length;
  t('假云端这一行有一定分量（>100KB，像她那行的缩小版）', rowSize > 100000, rowSize);
  t('推上去的 settings 带着 _ver，_ver._at 就是这次的 updated_at',
    c.row.settings._ver && c.row.settings._ver._at === new Date(c.row.updated_at).getTime());

  c.log = []; c.bytes = 0;
  await B.fetchCloudSettings();                   // 手机开机：没缓存，整包（只这一次）
  t('手机开机：没缓存 → 整包一次', c.log.join('|') === 'GET settings,updated_at', c.log);
  const fullBytes = c.bytes;
  // 手机这一页第一次同步：它还没推过自己那份袋子（收藏/记忆）的内容，推一次打底；之后记在 IndexedDB 里
  c.log = [];
  await B.syncSettingsToCloud();
  t('手机第一次同步：推一次打底', c.log.includes('POST'), c.log);
  c.log = [];
  await A.syncSettingsToCloud();
  t('打底那次袋子的「认人的键」没变 → 电脑只要了 _ver，一个键都没拉', c.log.join('|') === 'GET updated_at|GET updated_at,ver', c.log);

  // 电脑放了一首新歌 → musicRecent 变了 → 推
  A.state.musicRecent = { ts: 2, list: [{ id: 2, name: '七里香' }] };
  c.log = []; c.bytes = 0;
  await A.syncSettingsToCloud();
  t('电脑：问时间（自己的缓存对得上）→ 推', c.log.join('|') === 'GET updated_at|POST', c.log);

  // 手机这时随手 save 一下（比如聊了一句，设置没变）
  c.log = []; c.bytes = 0;
  await B.syncSettingsToCloud();
  const keySize = JSON.stringify(A.state.musicRecent).length;
  t('★ 手机：问时间对不上 → 要 _ver → 只拉 musicRecent 那一个键', c.log.join('|') === 'GET updated_at|GET updated_at,ver|GET updated_at,k0', c.log);
  const verSize = JSON.stringify(c.row.settings._ver).length;
  t('★ 下载量 ≈ 那个键 + 一张 _ver（不是整包）', c.bytes < keySize + verSize + 300 && c.bytes * 20 < fullBytes, { bytes: c.bytes, keySize, verSize, fullBytes });
  t('★ 手机拿到的是电脑的新歌', B.state.musicRecent && B.state.musicRecent.ts === 2);
  t('★ 手机合并完跟云端一样 → 不推（不动 updated_at）', !c.log.includes('POST') && B.stats.skip === 1, c.log);

  c.log = []; c.bytes = 0;
  await A.syncSettingsToCloud();
  t('★ 电脑再 save：云端没人动过、自己也没改 → 只问一次时间，不推', c.log.join('|') === 'GET updated_at', c.log);
  t('只问时间那一下几十字节', c.bytes < 100, c.bytes);

  console.log('\n[2] 「一袋东西」顺序不同不算变；jsonb 重排键不算变');
  // 手机上收藏顺序跟电脑反过来（两台各自追加，顺序天生不一样），内容一样
  B.state.favMessages = clone(B.state.favMessages).reverse();
  c.log = [];
  await B.syncSettingsToCloud();
  c.log = [];
  await A.syncSettingsToCloud();
  t('★ 收藏只是顺序不同 → 另一台不用拉收藏（认人的键没变）', c.log.join('|') === 'GET updated_at|GET updated_at,ver', c.log);
  c.log = [];
  await B.syncSettingsToCloud();
  t('★ 顺序变过一次推过之后，再 save 不推', !c.log.includes('POST'), c.log);
  // 拉回来的对象键序被 jsonb 重排过，原样再推不能算变化
  const C = device(c, '平板', { state: {} });
  const got = await C.fetchCloudSettings();
  C.state = clone(got.data.settings);
  C.state.musicRecent = got.data.settings.musicRecent;
  await C.pushCloudSettings({ id: 'u1', settings: clone(got.data.settings), updated_at: new Date() }, { baseVer: got.data.ver });   // 平板第一次推（打底）
  const got2 = await C.fetchCloudSettings();
  c.log = [];
  await C.pushCloudSettings({ id: 'u1', settings: clone(got2.data.settings), updated_at: new Date() }, { baseVer: got2.data.ver });
  t('★ jsonb 重排过键的那份原样再推 → 认得是同一份，不推', !c.log.includes('POST'), c.log);
  // 但配置的顺序是有意义的（她排的模型顺序），换了顺序要推
  const cfg = clone(got.data.settings);
  cfg.configs = cfg.configs.slice().reverse();
  c.log = [];
  await C.pushCloudSettings({ id: 'u1', settings: cfg, updated_at: new Date() }, { baseVer: got.data.ver });
  t('配置换了顺序 → 算变化，要推', c.log.includes('POST'), c.log);

  // 记忆收件箱电脑、手机各吸收一遍：同一条正文，两边 id / createdAt 不一样（10-14 真浏览器里看到的）。
  // 合并是「同一条正文本机为准」，两边永远不会变成一样 —— 指纹要是算整条，两台就永远互推这 0.9MB
  await A.syncSettingsToCloud(); await B.syncSettingsToCloud();
  const inboxItem = (id, at) => ({ id, text: '克克散步带回来的一条', createdAt: at, lastAccess: at, accessCount: 0 });
  A.state.brainMemories = [inboxItem(90001, 111)].concat(A.state.brainMemories);
  B.state.brainMemories = [inboxItem(80001, 222)].concat(B.state.brainMemories);
  await A.syncSettingsToCloud(); await B.syncSettingsToCloud();
  c.log = [];
  for (let i = 0; i < 3; i++) { await A.syncSettingsToCloud(); await B.syncSettingsToCloud(); }
  t('★ 同一条记忆两边 id/createdAt 不同：几轮下来没有互推', !c.log.includes('POST'), c.log);
  // 高级记忆每轮检索都给几条盖新的 lastAccess
  A.state.brainMemories[3].lastAccess = Date.now(); A.state.brainMemories[3].accessCount = 9;
  c.log = [];
  await A.syncSettingsToCloud();
  t('★ 只是检索盖了 lastAccess → 不推', !c.log.includes('POST'), c.log);

  console.log('\n[3] 收藏在推之前按条合并（以前直接推本机那份，云端在两台之间来回翻）');
  await A.syncSettingsToCloud(); await B.syncSettingsToCloud();
  const newFav = { id: 9999, text: '电脑新收藏', chatId: 8, nodeId: 77, ts: 1760000099999 };
  A.state.favMessages = [newFav].concat(A.state.favMessages);
  await A.syncSettingsToCloud();
  c.log = []; c.bytes = 0;
  await B.syncSettingsToCloud();
  t('★ 手机同步时把电脑新收藏的那条并进本机', B.state.favMessages.some(f => f.id === 9999));
  t('手机只拉了收藏那一个键', c.log.filter(x => x.startsWith('GET')).join('|') === 'GET updated_at|GET updated_at,ver|GET updated_at,k0', c.log);
  c.log = [];
  await A.syncSettingsToCloud();
  t('手机并进来推了一次备份，电脑那边不用拉收藏（认人的键没变）', !c.log.some(x => /k0/.test(x)) && !c.log.includes('POST'), c.log);
  // 取消收藏（☆ 那个按钮）：留了墓碑，同步时云端那份不能把它并回来（评估方逮到的：以前单台也会被并回来）
  const gone = A.state.favMessages.shift();
  A.state.trash = [{ type: 'fav', favData: gone, deletedAt: new Date().toISOString() }];
  await A.syncSettingsToCloud();
  t('★ 取消的收藏同步后没被云端并回来', !A.state.favMessages.some(f => f.id === gone.id));
  t('★ 云端那份也没有了', !c.row.settings.favMessages.some(f => f.id === gone.id));
  const favSrc = fs.readFileSync(path.join(ROOT, 'js/06-render-msg.js'), 'utf8');
  const tog = favSrc.slice(favSrc.indexOf('function toggleFavMsg('), favSrc.indexOf('function toggleFavMsg(') + 1500);
  t('★ ☆ 取消收藏也写墓碑（跟 removeFav 一样）', /state\.trash\.push\(\{ type: 'fav', favData: gone/.test(tog));
  // 同一条收藏改了字段（换分组）：认人的键没变，但得推上去（云端是新设备 / 本机丢档时的备份）
  await B.syncSettingsToCloud(); await A.syncSettingsToCloud();
  A.state.favMessages[2] = Object.assign({}, A.state.favMessages[2], { group: '想再看' });
  c.log = [];
  await A.syncSettingsToCloud();
  t('★ 收藏换了分组 → 推', c.log.includes('POST'), c.log);
  t('云端那条有了新分组', c.row.settings.favMessages.some(f => f.group === '想再看'));
  c.log = [];
  await B.syncSettingsToCloud();
  t('另一台：认人的键没变 → 不拉收藏、也不推', !c.log.some(x => /k0/.test(x)) && !c.log.includes('POST'), c.log);

  console.log('[3½] 墓碑：一台删的收藏 / 记忆，另一台也拿掉；删完两台不再互推');
  await A.syncSettingsToCloud(); await B.syncSettingsToCloud(); await A.syncSettingsToCloud();
  const delFav = A.state.favMessages[5];
  A.state.favMessages = A.state.favMessages.filter(f => f !== delFav);
  A.state.trash.push({ type: 'fav', favData: delFav, deletedAt: new Date().toISOString() });
  const delMem = A.state.brainMemories[7];
  A.state.brainMemories = A.state.brainMemories.filter(m => m !== delMem);   // AI 的 [[BRAIN_DEL]] 就是这样：进回收站、从列表拿掉
  A.state.trash.push({ type: 'memory', memoryData: delMem, deletedAt: new Date().toISOString() });
  await A.syncSettingsToCloud();
  await B.syncSettingsToCloud();
  t('★ 电脑删的收藏，手机同步后也没了', !B.state.favMessages.some(f => f.chatId === delFav.chatId && f.nodeId === delFav.nodeId));
  t('★ 电脑删的记忆，手机同步后也没了', !B.state.brainMemories.some(m => m.text === delMem.text));
  c.log = [];
  for (let i = 0; i < 3; i++) { await A.syncSettingsToCloud(); await B.syncSettingsToCloud(); }
  t('★ 删完几轮：两台不再为收藏 / 记忆互推', !c.log.includes('POST') && !c.log.some(x => /k0/.test(x)), c.log);
  // 删了之后另一台又收藏回来（比墓碑新）→ 照留，还传回电脑
  B.state.favMessages = [Object.assign({}, delFav, { time: Date.now() + 1000 })].concat(B.state.favMessages);
  await B.syncSettingsToCloud(); await A.syncSettingsToCloud();
  t('★ 墓碑之后又收藏的：手机留着、电脑也收到了', B.state.favMessages.some(f => f.nodeId === delFav.nodeId) && A.state.favMessages.some(f => f.nodeId === delFav.nodeId));
  const trashSrc = fs.readFileSync(path.join(ROOT, 'js/13-trash-ctx-ui.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'js/08-edit-trash.js'), 'utf8');
  t('从回收站恢复收藏 / 记忆都盖 restoredAt（不然会被墓碑又拿掉）', (trashSrc.match(/restoredAt: Date.now()/g) || []).length >= 4);

  console.log('\n[4] 整页刷新 / App 被系统回收重开：缓存从 IndexedDB 读回来');
  await B._cloudCacheFlush();
  t('手机的缓存落进了本机 IndexedDB', B.idb.has('kuro_cloud_cache'));
  const B2 = device(c, '手机（重开）', { state: clone(B.state), idb: B.idb });
  A.state.userName = '阿明';
  await A.syncSettingsToCloud();
  c.log = []; c.bytes = 0;
  await B2.fetchCloudSettings();
  t('★ 重开后：不整包，问时间+_ver+只拉变了的 userName', c.log.join('|') === 'GET updated_at|GET updated_at,ver|GET updated_at,k0', c.log);
  t('★ 重开后下载量很小（一张 _ver + 一个小键）', c.bytes < 5000 && c.bytes * 50 < fullBytes, c.bytes);
  const r4 = await B2.fetchCloudSettings();
  t('★ 重开后拼出来的内容跟云端一致（袋子按认人的键）', sameAsCloud(r4.data.settings, c.row.settings) === true, sameAsCloud(r4.data.settings, c.row.settings));
  t('交给调用方的 settings 里不带 _ver', r4.data.settings._ver === undefined);
  B2.state = clone(B.state); B2.state.userName = '阿明';   // 开机时 loadFromCloud 会收下电脑改的名字
  c.log = [];
  await B2.syncSettingsToCloud();
  t('★ 重开后第一次同步：「上次推过的袋子」也从 IndexedDB 读回来了 → 没变就不推', !c.log.includes('POST'), c.log);

  console.log('\n[5] 中转没回话改走直连：缓存不清空；推上去的那份直接认');
  await A.syncSettingsToCloud();
  A.state.accentColor = '#ff8800';
  c.postLoseReply = true; c.directFail = true;      // 中转其实写进去了但回包丢了，直连也失败
  let threw = false;
  try { await A.syncSettingsToCloud(); } catch (e) { threw = true; }
  c.postLoseReply = false; c.directFail = false;
  t('这一轮报错（交给下次重试）', threw);
  t('但云端其实已经是新的', c.row.settings.accentColor === '#ff8800');
  c.log = []; c.bytes = 0;
  const r5 = await A.fetchCloudSettings();
  t('★ 下一次：问时间对上「推了没回话」那份 → 直接认，一个键都不拉', c.log.length === 1 && /GET updated_at$/.test(c.log[0]), c.log);
  t('认的内容是对的', r5.data.settings.accentColor === '#ff8800');
  upOk(A);
  // 中转连不上（电脑关了）：直连推，然后另一台改了一个键，这台走直连也只拉那个键
  c.proxyDown = true;
  A.state.accentColor = '#00ff88';
  await A.syncSettingsToCloud();
  c.proxyDown = false;
  B.state.userName = 'Alice';
  await B.syncSettingsToCloud();
  c.proxyDown = true;
  c.log = []; c.bytes = 0;
  await A.syncSettingsToCloud();
  c.proxyDown = false;
  t('★ 中转连不上：直连问时间+只拉变了的键（以前直连推完缓存清空，下一次必整包）',
    c.log.some(x => /^direct GET .*k0:settings->userName/.test(x)) && !c.log.some(x => /settings,updated_at|GET settings$/.test(x)), c.log);
  upOk(A); upOk(B);

  console.log('\n[6] 有人绕过 pushCloudSettings 写了 settings（抄了旧 _ver）→ 认得出来，整包');
  await A.syncSettingsToCloud();
  c.row.settings.userName = '外面写的';
  c.row.updated_at = pgTs(Date.now() + 5000);        // _ver 原样留着，_at 对不上新的 updated_at
  c.log = [];
  const r6 = await A.fetchCloudSettings();
  t('★ _ver._at 对不上 updated_at → 整包', c.log.join('|') === 'GET updated_at|GET updated_at,ver|GET settings,updated_at', c.log);
  t('拿到的是外面写进去的新值', r6.data.settings.userName === '外面写的');

  console.log('\n[7] 老 server（10-11 那版，不认 cols）：跟以前一样，不多拉');
  await A.syncSettingsToCloud();
  await B.syncSettingsToCloud();
  c.mode = 'old';
  A.state.userName = '老 server 下改的';
  await A.syncSettingsToCloud();
  c.log = [];
  const r7 = await B.fetchCloudSettings();
  t('老 server：问时间（只回时间）→ 对不上 → 要 _ver 也只回时间 → 整包（多一个几十字节的小请求，不多拉）', c.log.join('|') === 'GET updated_at|GET updated_at|GET settings,updated_at', c.log);
  t('老 server：内容照样是新的', r7.data.settings.userName === '老 server 下改的');
  c.mode = 'new';

  console.log('\n[8] 同步串行：上一轮还在推，下一轮不叠上去');
  c.postDelay = 30; c.maxInflight = 0;
  A.state.userName = 'a1';
  const p1 = A.syncSettingsToCloud();
  A.state.userName = 'a2';
  const p2 = A.syncSettingsToCloud();
  const p3 = A.syncSettingsToCloud();
  await Promise.all([p1, p2, p3]);
  c.postDelay = 0;
  t('★ 同时只有一个推送在路上', c.maxInflight === 1, c.maxInflight);
  t('★ 中途要的那次在后面补跑了，云端是最后那份', c.row.settings.userName === 'a2', c.row.settings.userName);

  console.log('\n[8½] 要 _ver 和拉键之间另一台又推了 → 按新 _ver 重来，拼出来的是同一刻的云端');
  await A.syncSettingsToCloud(); await B.syncSettingsToCloud();
  A.state.userName = '第一下';
  await A.syncSettingsToCloud();
  let fired = false;
  c.onVer = async () => {            // 电脑在手机要完 _ver 之后、拉键之前又改了一个键
    if (fired) return; fired = true;
    A.state.accentColor = '#123456';
    await A.syncSettingsToCloud();
  };
  c.log = [];
  const r85 = await B.fetchCloudSettings();
  c.onVer = null;
  t('★ 中途有人推：重来了一次（又要了一次 _ver），没退回整包', c.log.filter(x => /GET updated_at,ver$/.test(x)).length === 2 && !c.log.some(x => /settings,updated_at/.test(x)), c.log);
  t('★ 拼出来跟云端最新那刻一致（袋子按认人的键）', sameAsCloud(r85.data.settings, c.row.settings) === true && r85.data.settings.accentColor === '#123456', sameAsCloud(r85.data.settings, c.row.settings));

  console.log('\n[9] server：cols 白名单');
  async function hit(query) {
    let seen = null;
    const axios = { get: async url => { seen = url; return { status: 200, data: [] }; } };
    const fn = new Function('axios', 'outboundAgent', 'SUPABASE_URL', 'return ' + getHandlerSrc)(axios, async () => null, 'https://sb');
    const res = { status() { return res; }, json() { return res; } };
    await fn({ headers: { authorization: 'Bearer x', apikey: 'k' }, query }, res);
    return seen;
  }
  t('server：cols 合法 → 照它查', (await hit({ select: 'updated_at', cols: 'updated_at,ver:settings->_ver,k0:settings->favMessages' }))
    === 'https://sb/rest/v1/profiles?select=updated_at,ver:settings->_ver,k0:settings->favMessages');
  t('server：cols 里夹了别的（拼查询）→ 不认，退回 select', (await hit({ select: 'updated_at', cols: 'updated_at,id&or=(x)' }))
    === 'https://sb/rest/v1/profiles?select=updated_at');
  t('server：cols 想读别的列 → 不认', (await hit({ select: 'updated_at', cols: 'k0:email->x' })) === 'https://sb/rest/v1/profiles?select=updated_at');
  t('server：cols 太长 → 不认', (await hit({ select: 'updated_at', cols: Array(80).fill('k0:settings->a').join(',') })) === 'https://sb/rest/v1/profiles?select=updated_at');
  t('server：没有 cols 还是老规矩', (await hit({ select: 'settings,updated_at' })) === 'https://sb/rest/v1/profiles?select=settings,updated_at');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
