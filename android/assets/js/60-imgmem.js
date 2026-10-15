/* ═══════════════════════════════════════════════════════
   看过一次的图就记住（2026-10-03）
   ═══════════════════════════════════════════════════════
   每张图第一次发出去的时候，另叫一个便宜模型（server 的 /api/img-describe，Haiku）
   写一段客观描述，挂在图片对象上（img.hash / img.desc），跟着对话一起存、一起同步。
   之后这张图在历史里就按「位置」决定发原图还是发描述：

   · 订阅 Claude / 订阅 GPT：服务端从来只收**最后一条**用户消息的图，历史图一律丢掉 ——
     CLI 那条路连「这里有过一张图」都不知道。
     所以它们最缺的不是省 token，是**记得**：历史里的图全部换成描述文字。
   · 其它（API key / 中转 / Gemini）：历史图每轮整张重发。最近 IMGMEM_RAW_TURNS 条
     用户消息里的图照发原图（她多半还在问「左下角那个是什么」），更早的换成描述。

   ⚠️ 提示词缓存：换不换只看「这条消息离末尾隔了几条用户消息」和「有没有描述」，
   两样都不随时间漂。一张图一辈子只翻一次（原图 → 描述），之后每轮逐字节相同。
   描述一旦写进去就不再改（imgMemEnsure 只给没有 desc 的图补）。

   为什么不让当前模型「顺路」写描述：量过，最近 30 天 1046 条用户消息里只有 5 张图，
   单独叫一次 Haiku 一张图不到 1k token，一个月的总开销可以忽略；而顺路写要在人设回复里
   塞一个新的 [[标签]]（提示词 + 解析 + 渲染剥离三件套），还要冒着它把格式学进正文的风险。
   不划算。

   同一张图（字节相同 → 哈希相同）再发，**这一轮照样发原图**——她又发一次是想让它再看一眼，
   不是想让它听一段别人写的转述。省下的是那次描述调用（直接复用旧描述）。 */

const IMGMEM_RAW_TURNS = 3;          // API 通道：最近几条用户消息里的图保留原图
const IMGMEM_WAIT_MS = 8000;         // 组消息时最多等一张「正在描述」的图多久
const IMGMEM_DESC_MAX = 400;

const _imgMemInflight = new Map();   // hash -> Promise<desc|''>
const _imgMemTried = new Set();      // 本次运行里失败过的 hash，别每轮都再打一次

// 同步的 64 位 FNV-1a（两路 32 位拼起来）。不用 crypto.subtle：安卓 WebView 和
// 非安全上下文里它可能不存在，而这个哈希只拿来认「是不是同一张图」，不防人。
function imgMemHash(url) {
  const s = String(url || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function _imgMemUrl(img) { return typeof img === 'string' ? img : (img && img.url) || ''; }

// 全库里已经有描述的图：hash -> desc。按需扫一遍，之后增量维护。
let _imgMemKnown = null;
function _imgMemIndex() {
  if (_imgMemKnown) return _imgMemKnown;
  _imgMemKnown = new Map();
  for (const chat of (typeof state === 'object' && state.chats) || []) {
    for (const n of Object.values(chat.nodes || {})) {
      for (const img of n.images || []) {
        if (img && img.hash && img.desc && !_imgMemKnown.has(img.hash)) _imgMemKnown.set(img.hash, img.desc);
      }
    }
  }
  return _imgMemKnown;
}

function _imgMemClean(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 4) return '';
  // 小模型偶尔拒答 / 说看不到图：这种不能当描述存下来，存了就永远是这句
  if (/^(抱歉|对不起|sorry|i can(no|')t|i'm unable|i am unable|无法|我不能|看不到)/i.test(t)) return '';
  return t.length > IMGMEM_DESC_MAX ? t.slice(0, IMGMEM_DESC_MAX) + '…' : t;
}

async function _imgMemDescribe(url) {
  if (typeof SERVER_BASE !== 'string' || !/^data:image\//.test(url)) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(SERVER_BASE + '/api/img-describe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: url }), signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { console.warn('[看图记忆] 描述失败：', j.error || r.status); return ''; }
    return _imgMemClean(j.desc);
  } catch (e) {
    console.warn('[看图记忆] 描述请求没发出去：', e.message);
    return '';
  } finally { clearTimeout(timer); }
}

// 给一条消息里还没描述的图补上哈希和描述。返回一个 promise（全部补完 / 放弃）。
// 已知的哈希直接复用，不再花一次调用。
function imgMemEnsure(node) {
  // 视频抽帧不描述：一段视频十几帧，一帧叫一次模型不值，而且拆成散的描述就丢了
  // 「这是同一段视频的第几秒」这层关系（videoNote 只在发原图时有意义）。照旧发原图。
  if (!node || (node.videoNote && node.videoNote.length)) return Promise.resolve();
  const imgs = node.images || [];
  const jobs = [];
  let touched = false;
  for (const img of imgs) {
    if (!img || typeof img !== 'object' || img.desc) continue;
    const url = _imgMemUrl(img);
    if (!url) continue;
    if (!img.hash) { img.hash = imgMemHash(url); touched = true; }
    const known = _imgMemIndex().get(img.hash);
    if (known) { img.desc = known; touched = true; continue; }
    if (_imgMemTried.has(img.hash)) continue;
    let p = _imgMemInflight.get(img.hash);
    if (!p) {
      p = _imgMemDescribe(url).then(desc => {
        _imgMemInflight.delete(img.hash);
        if (desc) _imgMemIndex().set(img.hash, desc);
        else _imgMemTried.add(img.hash);
        return desc;
      });
      _imgMemInflight.set(img.hash, p);
    }
    jobs.push(p.then(desc => {
      // 写回之前再看一眼：等的这几秒里别的路径（同一张图的另一条消息）可能已经写过了
      if (desc && !img.desc) { img.desc = desc; if (typeof save === 'function') save(); }
    }));
  }
  if (touched && typeof save === 'function') save();
  return Promise.all(jobs);
}

// 服务端只认最后一条用户消息的图的那几条通道
function imgMemLastOnly(conf) { return !!(conf && (conf.isLocalClaude || conf.isLocalGpt)); }
function _imgMemKeepTurns(conf) { return imgMemLastOnly(conf) ? 1 : IMGMEM_RAW_TURNS; }

// 每条消息离末尾隔了几条用户消息（0 = 最后一条用户消息）
function imgMemTurnsFromEnd(path) {
  const out = new Map();
  let k = 0;
  for (let i = (path || []).length - 1; i >= 0; i--) if (path[i] && path[i].role === 'user') out.set(path[i], k++);
  return out;
}

// 组消息前调：给 path 里所有带图的用户消息补描述。
// 只**等**这一轮就要换成文字的那几张（最多 IMGMEM_WAIT_MS）；刚发的图这轮发原图，
// 它的描述在后台写，绝不能让她发图之后干等一个小模型。
// 等不到也照发 —— 那张图这轮按「没有描述」处理（API 发原图，订阅通道照旧只有最后一张）。
async function imgMemPrepare(path, conf) {
  const turns = imgMemTurnsFromEnd(path);
  const keep = _imgMemKeepTurns(conf);
  const waits = [];
  for (const m of path || []) {
    if (!m || m.role !== 'user' || !m.images || !m.images.length) continue;
    const job = imgMemEnsure(m);
    if ((turns.get(m) || 0) >= keep) waits.push(job);
  }
  if (!waits.length) return;
  let timer;
  await Promise.race([Promise.all(waits), new Promise(r => { timer = setTimeout(r, IMGMEM_WAIT_MS); })]);
  clearTimeout(timer);
}

// 这条消息里的图，哪些发原图、哪些换成文字。
// userTurnsFromEnd：0 = 最后一条用户消息，1 = 倒数第二条……
function imgMemSplit(images, userTurnsFromEnd, conf) {
  const keepTurns = _imgMemKeepTurns(conf);
  const raw = [], notes = [];
  for (const img of images || []) {
    if (userTurnsFromEnd >= keepTurns && img && img.desc) notes.push(`[图片：${img.desc}]`);
    else raw.push(img);
  }
  return { raw, text: notes.join('\n') };
}

// 相册：全库每张不同的图一条（同一张图发过几次只算一条），新的在前。
// 先只做数据，界面最小化：控制台 imgAlbum() 就能翻。
function imgAlbum() {
  const byHash = new Map();
  for (const chat of (typeof state === 'object' && state.chats) || []) {
    for (const n of Object.values(chat.nodes || {})) {
      if (n.role !== 'user') continue;
      for (const img of n.images || []) {
        if (!img || typeof img !== 'object') continue;
        const hash = img.hash || imgMemHash(_imgMemUrl(img));
        const at = n.timestamp || 0;
        const e = byHash.get(hash);
        if (e) {
          e.times++;
          if (!e.desc && img.desc) e.desc = img.desc;
          if (at < e.firstAt) Object.assign(e, { firstAt: at, chatId: chat.id, msgId: n.id });
        } else {
          byHash.set(hash, { hash, desc: img.desc || '', name: img.name || '', w: img.w || 0, h: img.h || 0,
            url: _imgMemUrl(img), firstAt: at, chatId: chat.id, msgId: n.id, times: 1 });
        }
      }
    }
  }
  return [...byHash.values()].sort((a, b) => b.firstAt - a.firstAt);
}

// 按描述搜相册（空格分词，全部命中才算）
function imgAlbumFind(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return imgAlbum().filter(e => words.every(w => (e.desc + ' ' + e.name).toLowerCase().includes(w)));
}
