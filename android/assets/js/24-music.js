// ============================================================
// 点歌（网易云）
//
// 用户要的是"让它给我放首歌"，不是"打开一个音乐 App"。所以和学习卡片一样：
// 歌长在聊天里——AI 写一行 [[MUSIC: 歌名]]，气泡里就长出一张能按下去出声的卡。
// 另外在小组件里放一个常驻播放器，想自己找歌听的时候也不用回聊天。
//
// 为什么不是 Spotify：Spotify 从 2024-11 起对新注册的应用砍掉了 30 秒试听音频，
// 真正播放要 Premium + 官方 Web Playback SDK（多数人没有 Premium）。网易云这条路
// 能拿到完整歌曲和歌词，代价是**搜索要连着电脑的 server**（浏览器直连会被 CORS 拦）。
// 拿到播放地址之后音频是手机/电脑直接从网易云 CDN 拉的，所以歌一旦开始放，
// 电脑那头断了也不影响这一首放完。
//
// 存储沿用表情包/学习卡片那条路：**标签原样存，渲染层每次重画**。
//   [[MUSIC: 关键词]]  AI 写的，渲染时才去搜（同 [[GIF_SEARCH:]]）
//   [[SONG: id|歌名|歌手|封面]]  搜到之后固化进存储的形态，从此不再重复搜
// 播放状态（在放哪首、放到第几秒）是纯运行时的，不进存储——存了的话刷新回来
// 会看到一张"正在播放"却没有声音的卡。
// ============================================================

function musicEnabled() { return !!state.musicOn; }
// 「听」不跟着「AI 点歌」那个开关走（用户：exe 存档被清过一次，开关回到默认关，
// 她在 GranCyan 里放着歌，AI 却连「有歌在放」都看不到，[[LISTEN]]/[[LYRICS]] 也不知道有）。
// 那个开关面板上写的是「接入对话（AI 点歌）」——管的是 AI 能不能给她放歌，不是 AI 能不能知道她在听什么。
function musicEarsOn() { return true; }

// 播放器只有一个：两张卡片、小组件面板、AI 点的歌，全都抢同一个 <audio>。
// 做成每张卡各自 new Audio() 的话，连点两首就是两首一起响。
var _mAudio = null;
var _mNow = null;        // { id, name, artist, cover, url }
var _mQueue = [];        // 后面还排着的歌（小组件里点"下一首"用）
var _mLyric = null;      // { lines:[{t,txt}], idx }
var _mSearchCache = {};  // 关键词 -> 已解析的歌（本次会话）
var _mSearchPending = {};
var _mPlayReq = 0;       // 播放代际。见 musicPlay 里那两处 await 的注释

// 播放模式 / 倍速 / 上一首（用户的稿子里有这三个按钮）。
// 模式和倍速是这台设备的习惯，不是数据，所以走 localStorage 不进 state——
// 进 state 就得过持久化那三道门，而且手机和电脑本来就可能想要不一样的。
var _mMode = 'list';     // list 列表循环 | one 单曲循环 | shuffle 随机
var _mRate = 1;
var _mHist = [];         // 放过的歌（上一首用），最近的在最后；不含正在放的
var _mHistCur = null;
var _mHistSkip = false;  // 按"上一首"回去的那次不往历史里再记一笔，不然来回两首打转
var _mCtx = null;        // 正在放的整张单子（歌单/收藏）。列表循环放完一轮从这里重新装队列
const _M_MODES = ['list', 'one', 'shuffle'];
const _M_MODE_NAMES = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' };
const _M_RATES = [1, 1.25, 1.5, 0.75];
try {
  const m = localStorage.getItem('kuro_musicMode'); if (_M_MODES.includes(m)) _mMode = m;
  const r = +localStorage.getItem('kuro_musicRate'); if (_M_RATES.includes(r)) _mRate = r;
} catch (e) {}

// 播放上下文（队列 + 整张单子）落盘（用户：「每次我播放歌单，重启软件之后队列不是歌单了，变成单曲了」）。
// 以前 _mQueue/_mCtx 只在内存里：重启后点 ▶ 走 musicPlayLast，只剩 recent[0] 一首，歌单的后半截全丢。
// 每次换歌、改队列都存一份；启动时装回来（队列里不含正在放的那首，所以 musicPlayLast 放的那首要从队列里剔掉）。
// 遥控时队列是那台的镜像，不存；单子里每首只留 id/名/歌手/封面。
// 正在放的那首也存（用户：「离开软件再进，播放队列自己消失」——实测队列其实装回来了，
// 但重启后 _mNow 是空的：迷你条不出、面板是「还没在放」，看上去整个播放现场都没了）。
// 装回来的那首是「停在这里、还没开始放」（_resume）：不建 <audio>、不取地址，按 ▶ 才从存下的那一秒接着放。
// 进度单独一个键、节流着写：队列那份上千首，跟着 timeupdate 一起写太重。
function _mSessSave() {
  try {
    if (_mRemote || (_mCtx && _mCtx._mirror)) return;
    localStorage.setItem('kuro_musicSess', JSON.stringify({
      queue: _mQueue.slice(0, 1000).map(_mSlim),
      ctx: _mCtx ? _mCtx.slice(0, 1000).map(_mSlim) : null,
      now: _mNow ? _mSlim(_mNow) : null
    }));
  } catch (e) {}
}
var _mPosAt = 0;
function _mPosSave(force) {
  try {
    if (_mRemote || !_mNow) return;
    const a = _mAudio, now = Date.now();
    if (!force && now - _mPosAt < 5000) return;
    _mPosAt = now;
    // 换歌途中 <audio> 里还是上一首：只有地址对得上才读它的进度，不然会把旧歌的秒数记到新歌头上
    const t = a && _mNow.url && a.src === _mNow.url && isFinite(a.currentTime) ? a.currentTime : (_mNow._resumeT || 0);
    localStorage.setItem('kuro_musicPos', JSON.stringify({ id: _mNow.id, t: Math.floor(t) }));
  } catch (e) {}
}
function _mSessLoad() {
  try {
    const s = JSON.parse(localStorage.getItem('kuro_musicSess') || 'null');
    if (!s || _mQueue.length || _mCtx || _mNow) return;
    const ok = a => Array.isArray(a) && a.every(x => x && x.id != null);
    if (ok(s.queue)) _mQueue = s.queue;
    if (ok(s.ctx) && s.ctx.length) _mCtx = s.ctx;
    if (s.now && s.now.id != null) {
      let t = 0;
      try { const p = JSON.parse(localStorage.getItem('kuro_musicPos') || 'null'); if (p && String(p.id) === String(s.now.id) && isFinite(p.t)) t = Math.max(0, +p.t); } catch (e) {}
      _mNow = Object.assign({}, s.now, { _retried: false, _resume: true, _resumeT: t });
    }
  } catch (e) {}
}
_mSessLoad();
if (typeof window !== 'undefined' && window.addEventListener) {
  // 装回来的那首：面板上要有它的词和封面配色，不然打开点歌台是「没有歌词」
  window.addEventListener('load', () => setTimeout(() => {
    if (!_mNow || !_mNow._resume || _mRemote) return;
    try { musicLoadLyric(_mNow.id); _mCoverTint(_mNow.cover); _mMediaSync(); _mDockSync(); } catch (e) {}
  }, 1200));
  // 关窗/退到后台时把进度落一笔（手机切后台 WebView 可能直接被杀，不会再有下一次 timeupdate）
  window.addEventListener('pagehide', () => _mPosSave(true));
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', () => { if (document.hidden) _mPosSave(true); });
}

// 系统媒体控制（Windows 的音量浮层 / 锁屏 / 耳机键 / 手机通知栏）：不设的话那里只会显示网页标题
// 「Grancyan · AI 小窝」（用户：「如果能让这里显示具体是什么歌就方便了」）。
// 曲目一换就同步元数据，播放/暂停同步状态；上一首/下一首/播放/暂停按键接回点歌台自己的函数。
function _mMediaSync() {
  _mNativeState();   // 安卓壳：系统卡片走原生（见 _mNative）
  try {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms) return;
    if (!_mNow) { ms.metadata = null; ms.playbackState = 'none'; return; }
    if (typeof MediaMetadata === 'function') {
      let cover = '';
      try { cover = _mNow.cover ? new URL(_mNow.cover, location.href).href : ''; } catch (e) {}
      ms.metadata = new MediaMetadata({ title: _mNow.name || '', artist: _mNow.artist || '', album: 'GranCyan 点歌',
        artwork: cover ? [{ src: cover, sizes: '512x512' }] : [] });
    }
    // 换歌那一下（旧的淡出、新的还在取地址）保持「在放」：不然浮层上的按钮会闪成 ▶ 再闪回来
    ms.playbackState = _mSwitching || (_mAudio && !_mAudio.paused) ? 'playing' : 'paused';
    // 进度条（Windows 11 的浮层会画时间轴）。时长没出来 / 是 Infinity 时不能传，会抛 TypeError。
    // 换歌途中 <audio> 里还是上一首的时长，清掉，等新歌的 loadedmetadata 再报
    const a = _mAudio;
    if (_mSwitching || !(a && _mNow.url && a.src === _mNow.url)) { try { ms.setPositionState && ms.setPositionState(); } catch (e) {} }
    else if (a && isFinite(a.duration) && a.duration > 0 && ms.setPositionState) {
      ms.setPositionState({ duration: a.duration, position: Math.min(a.currentTime || 0, a.duration), playbackRate: a.playbackRate || 1 });
    }
  } catch (e) {}
}
var _mMediaWired = false;
function _mMediaWire() {
  if (_mMediaWired) return;
  const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
  if (!ms || !ms.setActionHandler) return;
  _mMediaWired = true;
  const on = (k, f) => { try { ms.setActionHandler(k, f); } catch (e) {} };   // 不支持的动作会抛，别连累别的
  on('play', () => { if (!_mAudio || _mAudio.paused) musicToggle(); });
  on('pause', () => { if (_mAudio && !_mAudio.paused) musicToggle(); });
  on('previoustrack', () => musicPrev());
  on('nexttrack', () => musicNext());
}

// 换歌过渡：音量淡出/淡入。同一时刻只有一个淡变在跑，新的会掐掉旧的（连点下一首不会两段淡变抢音量）。
// 'play' 事件那里兜底：没有淡变在跑却发现音量不是 1（淡出到一半就停了/没放成），拉回 1。
var _mSwitching = false;   // 换歌途中（旧的淡出、新的还没开始响）
var _mSkipRun = 0;         // 连着跳过了几首放不了的，到 5 就停，免得整张单子都没版权时空转
var _mFadeTimer = 0, _mFadeGen = 0;
function _mFadeStop() {
  _mFadeGen++;
  if (_mFadeTimer && typeof clearInterval === 'function') clearInterval(_mFadeTimer);
  _mFadeTimer = 0;
}
function _mFade(a, to, ms) {
  _mFadeStop();
  const gen = _mFadeGen;
  return new Promise(res => {
    const set = v => { try { a.volume = Math.max(0, Math.min(1, v)); } catch (e) {} };
    if (!a) return res();
    if (typeof setInterval !== 'function') { set(to); return res(); }
    // 页面在后台（手机切出去 / 锁屏）时计时器被节流到一秒一跳甚至一分钟一跳：
    // 换歌时先压成 0 的音量要等很久才淡回来，听着就是「放着放着没声了，切回去才好」。后台不淡，直接到位
    if (typeof document !== 'undefined' && document.hidden) { set(to); return res(); }
    const from = isFinite(a.volume) ? a.volume : 1, t0 = Date.now();
    let id = 0;
    // 被新的淡变顶掉的那个（gen 对不上）只收尾、不再碰音量——不然它到点会把新那段的音量拍回自己的终点
    const end = () => {
      if (id && typeof clearInterval === 'function') clearInterval(id);
      if (_mFadeTimer === id) _mFadeTimer = 0;
      if (gen === _mFadeGen) set(to);
      res();
    };
    id = setInterval(() => {
      if (gen !== _mFadeGen) return end();
      const k = Math.min(1, (Date.now() - t0) / Math.max(1, ms));
      set(from + (to - from) * k);
      if (k >= 1) end();
    }, 16) || 0;
    _mFadeTimer = id;
    if (!id) end();    // 拿不到计时器（测试替身）就直接到终点
  });
}
// 下一首的播放地址提前取好（列表循环时队头就是下一首）：点下一首/自然放完时不用再等一趟网易云。
// 地址有时效，存 10 分钟；拿过一次就作废（失效了 error 监听会自己重取）。
var _mUrlCache = null;
function _mUrlTake(id) {
  const c = _mUrlCache;
  if (!c || String(c.id) !== String(id) || Date.now() - c.at > 600000) return '';
  _mUrlCache = null;
  return c.url;
}
function _mUrlPrefetch() {
  if (_mRemote || _mMode !== 'list') return;
  const nx = _mQueue[0] || (_mCtx && _mCtx.find(s => s && (!_mNow || !_mSameSong(s.id, _mNow.id))));
  if (!nx || (_mUrlCache && String(_mUrlCache.id) === String(nx.id))) return;
  const id = nx.id;
  musicFetchUrl(id).then(url => { if (url) _mUrlCache = { id, url, at: Date.now() }; }).catch(() => {});
}

function _mAudioEl() {
  if (_mAudio) return _mAudio;
  _mAudio = new Audio();
  _mAudio.preload = 'none';
  // 安卓卡片和悬浮条自己按时钟往前走，隔一阵对一次表就够（缓冲卡顿会让它慢慢跑快）
  _mAudio.addEventListener('timeupdate', () => { _mTick(); _mPosSave(); if (Date.now() - _mNativeAt > 15000) _mNativeState(); });
  _mMediaWire();
  // 时长出来 / 拖了进度条之后，把位置同步给系统浮层（平时它自己按倍速往前走）
  _mAudio.addEventListener('loadedmetadata', () => _mMediaSync());
  _mAudio.addEventListener('seeked', () => _mMediaSync());
  // 倍速在 play 时补一次：换 src 会走 load()，浏览器会把 playbackRate 打回默认值
  _mAudio.addEventListener('play', () => { if (_mAudio.playbackRate !== _mRate) _mAudio.playbackRate = _mRate; if (!_mFadeTimer && !_mSwitching && _mAudio.volume < 1) _mAudio.volume = 1; _mMediaSync(); _mPaint(); });
  _mAudio.addEventListener('pause', () => { _mMediaSync(); _mPosSave(true); _mPaint(); });
  _mAudio.addEventListener('ended', () => {
    if (_mMode === 'one' && _mNow) { _mAudio.currentTime = 0; _mAudio.play().catch(() => {}); return; }
    musicNext(true);
  });
  // 地址是有时效的（网易云的 CDN 链接过一阵子就失效）。放到一半断了别装死，
  // 重新取一次地址接着放——不这么做的话，隔天回来点播放是彻底没反应。
  _mAudio.addEventListener('error', async () => {
    if (!_mNow || _mNow._retried) { _mPaint(); return; }
    _mNow._retried = true;
    // 取地址期间她可能已经切了歌/停了：回来时不认代际的话，旧歌地址会塞进新歌的界面底下放。
    const seq = _mPlayReq, now = _mNow;
    const fresh = await musicFetchUrl(now.id);
    if (seq !== _mPlayReq || _mNow !== now) return;
    if (fresh) { now.url = fresh; _mAudio.src = fresh; _mAudio.play().catch(() => {}); }
    else showToast('这首歌的播放地址失效了，重新点一次试试～', 'error', 3000);
  });
  return _mAudio;
}

function _mFmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// ── 后端 ──
function musicApiBase() {
  // Android App 自带 localhost:8080 音乐代理，手机独立使用时不再依赖电脑。
  return (window.GrancyanBand || window.GrancyanMusic) ? 'http://localhost:8080' : SERVER_BASE;
}
async function musicFetchUrl(id) {
  try {
    const r = await fetch(`${musicApiBase()}/api/music/url?id=${encodeURIComponent(id)}`);
    const j = await r.json();
    return j.url || '';
  } catch (e) { return ''; }
}

async function musicSearch(q, limit) {
  const r = await fetch(`${musicApiBase()}/api/music/search?q=${encodeURIComponent(q)}&limit=${limit || 12}`);
  if (!r.ok) throw new Error('搜索失败');
  return (await r.json()).songs || [];
}

// 网易云曲库缺歌时，补一个 Apple Music 的公开目录入口。这里只提供官方试听和跳转，
// 不把 30 秒预览冒充完整歌曲，也不放进网易云的队列、收藏或点歌链路。
function musicSearchNorm(s) { return String(s || '').toLowerCase().replace(/[\s（）()【】\[\]·・,，.。'"’\-_]/g, ''); }
function musicSearchHasMatch(q, songs) {
  const parts = q.trim().split(/\s+/).map(musicSearchNorm).filter(Boolean);
  return songs.some(s => parts.every(p => musicSearchNorm(s.name + ' ' + s.artist).includes(p)));
}
async function musicSearchApple(q) {
  const parts = q.trim().split(/\s+/).filter(Boolean);
  const term = parts.sort((a, b) => b.length - a.length)[0] || q;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&country=us&limit=50`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  const tokens = q.trim().split(/\s+/).map(musicSearchNorm).filter(Boolean);
  return (data.results || []).filter(s => s.kind === 'song' && s.trackViewUrl &&
    tokens.every(p => musicSearchNorm(s.trackName + ' ' + s.artistName).includes(p))).slice(0, 5).map(s => ({
      name: s.trackName, artist: s.artistName, cover: s.artworkUrl100 || '',
      preview: s.previewUrl || '', url: s.trackViewUrl,
    }));
}

// AI 点歌走这条：后端顺带验过能不能播，返回的一定是首放得出声的（如果有）
async function musicPick(q) {
  const r = await fetch(`${musicApiBase()}/api/music/pick?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('点歌失败');
  return await r.json();
}

// ── 播放 ──
async function musicPlay(song, url) {
  if (!song) return;
  // 遥控时：点哪首都是让那台放。调用方（歌单/收藏/队列）在调这里之前已经把 _mQueue/_mCtx
  // 摆成了想要的样子，一起带过去；_mCtx 还是那台的镜像（没被本机换掉）时就让那台留着自己的
  if (_mRemote) {
    if (_mNow && _mSameSong(_mNow.id, song.id)) return void _mRC('toggle');
    return void _mRC('play', { song: _mSlim(song), queue: _mQueue.map(_mSlim), ctx: (_mCtx && !_mCtx._mirror) ? _mCtx.map(_mSlim) : (_mCtx ? 'keep' : null) });
  }
  const a = _mAudioEl();
  // 点的是正在放的这首 → 当成暂停/继续（卡片和面板上都是同一个按钮）
  if (_mNow && String(_mNow.id) === String(song.id) && a.src && !_mNow._resume) {
    if (a.paused) {
      // 这里**不能**递增 _mPlayReq：那会把正在加载的同一首歌取消掉，
      // 而它没有新的加载来接替。只记下当前代际，失败时用它判断该不该报错。
      const seq0 = _mPlayReq;
      try { await a.play(); }
      catch (e) {
        if (seq0 !== _mPlayReq || !_mNow || String(_mNow.id) !== String(song.id)) return;
        _mPlayFailed(e);
      }
    } else a.pause();
    return;
  }
  // 这个函数里有两处 await（取地址、play()）。等待期间用户完全可能又点了别的歌
  // 或者按了停止——恢复执行时 _mNow 已经是别人的、甚至是 null。
  // 不挡的话：① `_mNow.cover` 在停止后直接抛 TypeError；
  // ② 旧的这一趟会调 musicLoadLyric，反而拿到比新歌更大的 token，把新歌的歌词判成过期。
  // 光比对 song.id 不够——同一首歌连点两次分不出代际。
  // 切歌是一个"新意图"，必须**立刻**把上一首的所有在途异步结果一起作废。
  // 只推播放代际不够：上一首的歌词请求和封面取色都还挂在天上，
  // 它们的代际要等到 play() 之后才轮到推进，这中间回来的就会盖到新歌头上
  // （封面尤其明显——B 已经显示在屏幕上，配色却是 A 的）。
  const seq = ++_mPlayReq;
  _mLyricReq++; _mTintReq++;
  // 重启后装回来的那首：接着上次那一秒放。从队列里自动接上来的（_fromQ）：放不了就跳过，不停在半路
  const resumeT = song._resume ? Math.max(0, +song._resumeT || 0) : 0;
  const fromQ = !!song._fromQ;
  const wasPlaying = !!(a.src && !a.paused);
  // 换了一首：上一首一起听时聊的那段现在收走（摘她说过的话进档案），别等到下一轮聊天
  // （typeof：好几个测试只抠 musicPlay 这一段去跑，那边没有整首听这套）
  const tg = typeof _mTogetherGet === 'function' ? _mTogetherGet() : null;
  if (tg && tg.id !== String(song.id)) musicHarvest(tg);
  _mNow = { ...song, _retried: false, _resume: false, _fromQ: false, _resumeT: 0 };
  _mSessSave();
  _mSwitching = true;
  _mMediaSync();
  _mPaint();                                  // 先把"加载中"画出来，别让人以为没点上
  // 换歌（用户：「win 这边点下一首，切换不够自然」）：以前是新歌名先上了系统浮层，
  // 旧歌还接着唱到地址取回来，然后咔一下断掉。现在旧的先淡出，地址多半是预取好的（_mUrlPrefetch），新歌淡入。
  const fade = wasPlaying ? _mFade(a, 0, 180) : null;
  const src = url || _mUrlTake(song.id) || await musicFetchUrl(song.id);
  if (fade) await fade;
  if (seq !== _mPlayReq) return;                // 这一趟已经被后来的播放/停止取代
  if (!src) {
    _mNow = null; _mSwitching = false;
    if (wasPlaying) try { a.pause(); } catch (e) {}
    if (fromQ && _mSkipRun < 5 && (_mQueue.length || (_mCtx && _mCtx.length))) {
      _mSkipRun++;
      showToast(`《${song.name}》在网易云放不了，跳过`, 'info', 2200);
      musicNext();
      return;
    }
    _mSkipRun = 0;
    _mMediaSync(); _mSessSave(); _mPaint();
    showToast(`《${song.name}》在网易云没有可播放的版本（多半是版权）`, 'info', 3500);
    return;
  }
  _mNow.url = src;
  a.src = src;
  // 后台（手机切出去/锁屏）不从 0 淡入：新歌元数据到的那一刻音量是 0，Chromium 会把「后台的静音媒体」
  // 自己暂停掉（页面里没人调 pause，play() 以 AbortError 被拒）——用户「后台放歌放一会就自己断」的真凶，
  // 真机埋点抓到的：每次自动下一首都停在 0 秒
  a.volume = (typeof document !== 'undefined' && document.hidden) ? 1 : 0;
  // 校验必须在 catch **里面**也做一次：切歌会换掉 a.src，浏览器会让上一首的
  // play() 以 AbortError 拒绝——那不是"自动播放被拦"，是用户自己换的歌。
  // 不挡的话，每次切歌都弹一条"浏览器拦了自动播放，点一下 ▶ 就能听"的假提示。
  try {
    if (resumeT > 1) { try { a.currentTime = resumeT; } catch (e) {} }
    await a.play();
    // 有的流在元数据回来前设的 currentTime 不认，回来了再补一次
    if (resumeT > 1 && seq === _mPlayReq && a.currentTime < resumeT - 2) { try { a.currentTime = resumeT; } catch (e) {} }
    _mFade(a, 1, 260);
  }
  catch (e) {
    let err = e;
    // 代际没变（不是她换了歌）却被 Abort 了＝内核自己停的（上面那个静音暂停，或者正淡入时切到了后台）：音量拉满再试一次
    if (seq === _mPlayReq && _mNow && e && e.name === 'AbortError' && a.paused) {
      a.volume = 1;
      try { await a.play(); err = null; } catch (e2) { err = e2; }
    }
    if (err) {
      if (seq === _mPlayReq) { _mSwitching = false; a.volume = 1; }
      if (seq !== _mPlayReq || !_mNow) return;
      _mPlayFailed(err);
    }
  }
  if (seq !== _mPlayReq || !_mNow) return;
  _mSwitching = false; _mSkipRun = 0;
  _mMediaSync();
  _mUrlPrefetch();
  musicNoteRecent(_mNow);
  musicLoadLyric(song.id);
  _mCoverTint(_mNow.cover);
  _mListen(_mNow, seq);                         // 不 await：算不出来也不耽误听
  if (typeof musicProfileLoad === 'function') musicProfileLoad(song.id);   // 只读盘：以前一起听过的，档案和她说过的话先备好
  _mPaint();
}

// 手机浏览器/WebView 不允许没有用户手势就出声。AI 点的歌是"页面自己想放"，
// 大概率被拦——拦了就说人话，别让卡片一直显示"正在播放"却是哑的。
function _mPlayFailed(e) {
  console.warn('[点歌] 播放被拒:', e?.name || e);
  showToast('浏览器拦了自动播放，点一下卡片上的 ▶ 就能听', 'info', 3500);
  _mPaint();
}

// ============================================================
// 听歌：把正在放的歌算成几个数，递给 AI 当线索
//
// 和语音情绪（10-stickers-voice.js 的 analyzeVoiceEmotion）是同一个思路：
// AI 听不见，但它会读。所以把「速度、亮不亮、起伏、调性」算成人话塞进系统提示，
// 让它聊这首歌的时候有东西可抓，而不是只知道一个歌名。
//
// 音频是**另拉一份**来离线解码的，不碰正在放的 <audio>：
// 接 MediaElementSource 实时分析的话，整条播放链路就改道进 AudioContext 了——
// 哪天 CDN 不回 CORS 头，Web Audio 会静默输出全零，歌直接哑掉。
// 离线这条路坏了只是「没有听感」，歌照放。网易云 CDN 实测回 `Access-Control-Allow-Origin: *`，
// 手机上拿到的也是同一个 CDN 地址，所以电脑和手机都不用经过 server。
// ============================================================
const _M_FEAT_SR = 22050, _M_FEAT_N = 2048, _M_FEAT_HOP = 512;
const _M_FEAT_MAX_BYTES = 12 * 1024 * 1024;     // 128k 的 mp3 够 13 分钟；超了就只分析前面这些
const _M_FEAT_KEY = 'kuro_musicFeat';           // 算一次存着：同一首再点不用再下一遍
const _M_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
var _mListenAbort = null;

function _mFeatGet(id) {
  try { return (JSON.parse(localStorage.getItem(_M_FEAT_KEY) || '{}'))[id] || null; } catch { return null; }
}
function _mFeatPut(id, f) {
  try {
    const all = JSON.parse(localStorage.getItem(_M_FEAT_KEY) || '{}');
    delete all[id];
    all[id] = f;                                   // 删了再放 = 挪到最后，下面按插入顺序淘汰最老的
    const ids = Object.keys(all);
    for (let i = 0; i < ids.length - 150; i++) delete all[ids[i]];
    localStorage.setItem(_M_FEAT_KEY, JSON.stringify(all));
  } catch {}
}

async function _mListen(song, seq) {
  if (!song || !song.url) return;
  const id = String(song.id);
  const alive = () => seq === _mPlayReq && _mNow && String(_mNow.id) === id;
  const hit = _mFeatGet(id);
  if (hit && alive()) { _mNow.feat = hit; _mPaint(); }
  // 频谱圈也吃这份解码（见 musicSpectrum）。听感算一次就存下了，频谱太大不落盘，
  // 所以听感命中缓存时，只有「要频谱且内存里没有」才值得再下一遍。
  const wantSpec = _mSpecOn() && !_mSpecGet(id);
  if (hit && !wantSpec) return;
  // 切歌时上一首还没下完的那份直接掐掉，别让两首歌的下载抢带宽
  try { _mListenAbort?.abort(); } catch {}
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  _mListenAbort = ac;
  try {
    const r = await fetch(song.url, { headers: { Range: `bytes=0-${_M_FEAT_MAX_BYTES - 1}` }, signal: ac?.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    if (!alive()) return;
    // OfflineAudioContext 解码会顺手重采样到它自己的采样率——22k 够看到 11kHz，
    // 亮度（频谱重心）和节拍都用不着更高，内存还省一半
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await new OAC(1, 1, _M_FEAT_SR).decodeAudioData(ab);
    if (!alive()) return;
    const n = buf.length, ch = buf.numberOfChannels;
    const d = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const x = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] += x[i] / ch; }
    // 一首歌上万帧 FFT，一口气算完会卡一下界面（歌词在滚）。每隔一段让出主线程，
    // 顺便看一眼是不是已经切歌了——切了就别算完。
    const tick = async () => {
      await new Promise(res => setTimeout(res, 0));
      if (!alive()) throw new Error('切歌了');
    };
    // 频谱先算：它是看得见的，听感只是给 AI 的几行字，晚几秒没人察觉
    if (wantSpec) {
      const sp = await musicSpectrum(d, buf.sampleRate, tick);
      if (sp && alive()) _mSpecPut(id, sp);
    }
    if (hit) return;
    const f = await musicSongFeatures(d, buf.sampleRate, tick);
    if (!f) return;
    f.hint = musicSongHint(f);
    _mFeatPut(id, f);
    if (alive()) { _mNow.feat = f; _mPaint(); }
  } catch (e) {
    if (e?.name !== 'AbortError' && e?.message !== '切歌了') console.warn('[听歌] 算不出来，跳过：', e?.message || e);
  } finally {
    if (_mListenAbort === ac) _mListenAbort = null;
  }
}

// 原地 FFT（基 2）。只在这里用，不值得拉一个库
function _mFFT(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ── 频谱圈的数据 ──
// 用户稿子里唱片外面那一圈竖条要跟着歌跳。实时分析（AnalyserNode）必须把 <audio>
// 接进 Web Audio，CORS 一变整首歌静默变哑（见上面「听歌」的注释），不拿播放去赌。
// 所以和听感一样离线算：整首歌预先算成「每 46ms 一帧 × 48 个频段」的 0~255，
// 播放时按 currentTime 查表插值。4 分钟的歌 ≈ 5 千帧 × 48 ≈ 250KB，只放内存。
const _M_SPEC_NB = 48, _M_SPEC_N = 1024, _M_SPEC_HOP = 1024;
var _mSpecCache = new Map();   // id -> spec，只留最近 4 首（上一首/再听一遍不用重下）
function _mSpecOn() { try { return localStorage.getItem('kuro_musicSpec') !== '0'; } catch (e) { return true; } }
function _mSpecGet(id) { return _mSpecCache.get(String(id)) || null; }
function _mSpecPut(id, sp) {
  _mSpecCache.delete(String(id));
  _mSpecCache.set(String(id), sp);
  while (_mSpecCache.size > 4) _mSpecCache.delete(_mSpecCache.keys().next().value);
}

// 单声道采样 → { fps, nb, frames, data:Uint8Array(frames*nb) }
// 频段按对数切（40Hz~11kHz），每段取峰值的 dB；**每个频段各自归一化**——
// 统一归一化的话高频永远只有低频的零头，圈的下半边一直是秃的。
async function musicSpectrum(d, sr, tick) {
  const N = _M_SPEC_N, HOP = _M_SPEC_HOP, NB = _M_SPEC_NB, half = N >> 1;
  if (!d || d.length < N * 8) return null;
  const F = Math.floor((d.length - N) / HOP) + 1;
  const lo = 40, hi = Math.min(11000, sr * 0.49);
  const edge = new Int32Array(NB + 1);
  for (let b = 0; b <= NB; b++) edge[b] = Math.max(1, Math.round(lo * Math.pow(hi / lo, b / NB) * N / sr));
  // 低频段一个频点都分不到的时候至少给一个，否则前几条永远是 0
  for (let b = 1; b <= NB; b++) if (edge[b] <= edge[b - 1]) edge[b] = edge[b - 1] + 1;
  for (let b = 0; b <= NB; b++) edge[b] = Math.min(half, edge[b]);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const re = new Float32Array(N), im = new Float32Array(N);
  const db = new Float32Array(F * NB);
  for (let f0 = 0; f0 < F; f0 += 256) {
    const f1 = Math.min(F, f0 + 256);
    for (let f = f0; f < f1; f++) {
      const o = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = d[o + i] * win[i]; im[i] = 0; }
      _mFFT(re, im);
      for (let b = 0; b < NB; b++) {
        let m = 0;
        for (let k = edge[b]; k < Math.max(edge[b] + 1, edge[b + 1]); k++) {
          const v = re[k] * re[k] + im[k] * im[k];
          if (v > m) m = v;
        }
        db[f * NB + b] = 10 * Math.log10(m + 1e-12);
      }
    }
    if (tick) await tick();
  }
  // 每个频段：顶 = 97 分位，底 = 顶往下 36dB。抽样算分位，整首排序太贵。
  // 但顶不能低于「最响那段的顶 - 30dB」：整首歌几乎没声音的频段（纯人声清唱的高频、
  // 电子乐的超低频）按自己归一化的话，是把底噪放大成满格，那几根竖条会一直乱抖。
  const step = Math.max(1, Math.floor(F / 800));
  const data = new Uint8Array(F * NB);
  const tops = new Float32Array(NB);
  for (let b = 0; b < NB; b++) {
    const s = [];
    for (let f = 0; f < F; f += step) s.push(db[f * NB + b]);
    s.sort((x, y) => x - y);
    tops[b] = s[Math.floor(s.length * 0.97)] ?? 0;
  }
  const loudest = Math.max(...tops);
  for (let b = 0; b < NB; b++) {
    const top = Math.max(tops[b], loudest - 30), floor = top - 36;
    for (let f = 0; f < F; f++) {
      const v = Math.max(0, Math.min(1, (db[f * NB + b] - floor) / 36));
      data[f * NB + b] = Math.round(Math.pow(v, 1.7) * 255);   // 1.7 次方：把常驻的底噪压下去，只让起音冒头
    }
  }
  return { fps: sr / HOP, nb: NB, frames: F, data };
}

// 逐帧的 FFT。一首 4 分钟的歌一万多帧，node 里实测 1.5 秒左右——一口气算完界面会顿一下，
// 所以外面按 64 帧一批调它，批与批之间让出主线程。Chrome 里实测 200 帧一批最长卡 89ms，
// 歌词滚动看得出顿；64 帧一批 ≈ 30ms。（解码 decodeAudioData 本身在别的线程，不占主线程）
// （在 node 的 vm 沙箱里跑会慢到 10 秒：沙箱的全局查找每次 Math.sqrt 都要过一道拦截器。
//   那是测试环境的事，浏览器里没有。测试喂短样本就好。）
function _mFeatFrames(c, from, to) {
  const { d, sr, N, HOP, half, win, pcOf, rms, cent, flux, lsum, chromaF, re, im, prev, mag } = c;
  for (let f = from; f < to; f++) {
    const o = f * HOP;
    let s = 0;
    for (let i = 0; i < N; i++) { const v = d[o + i]; s += v * v; re[i] = v * win[i]; im[i] = 0; }
    rms[f] = Math.sqrt(s / N);
    _mFFT(re, im);
    let num = 0, den = 0, fl = 0, ls = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      num += k * m; den += m;
      // 频谱通量：各频点「比上一帧响了多少」的和。取对数是为了让鼓点和人声的起音
      // 都能露头，不然只有最响的那个乐器决定节拍
      const lm = Math.log1p(m);
      if (lm > prev[k]) fl += lm - prev[k];
      ls += lm;
      prev[k] = lm;
      mag[k] = m;
    }
    // 音级只收局部峰：一个音的能量会漏到隔壁几个频点，全收的话相邻半音糊成一片
    for (let k = 2; k < half - 1; k++) {
      if (pcOf[k] >= 0 && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) chromaF[f * 12 + pcOf[k]] += mag[k];
    }
    cent[f] = den > 0 ? num / den * sr / N : 0;
    flux[f] = fl;
    lsum[f] = ls;
  }
}

// 单声道采样 → { bpm, bpmConf, bright, lra, arc[], key, keyConf, dur }
// tick 是可选的 async 回调，每算一批帧调一次（让出主线程 / 中途放弃）。
async function musicSongFeatures(d, sr, tick) {
  const N = _M_FEAT_N, HOP = _M_FEAT_HOP, half = N >> 1;
  if (!d || d.length < sr * 5) return null;              // 不到 5 秒，算了也不作数
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  // 每个频点归到哪个音级（C=0…B=11）。只收 200~2500Hz：再低的话 10.8Hz 的频率分辨率
  // 分不清半音，再高基本是泛音，只会把调性抹平。
  const pcOf = new Int8Array(half).fill(-1);
  for (let k = 1; k < half; k++) {
    const hz = k * sr / N;
    if (hz >= 200 && hz <= 2500) pcOf[k] = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
  }
  const F = Math.floor((d.length - N) / HOP) + 1;
  const rms = new Float32Array(F), cent = new Float32Array(F), flux = new Float32Array(F), lsum = new Float32Array(F);
  const chromaF = new Float32Array(F * 12);
  const c = {
    d, sr, N, HOP, half, win, pcOf, rms, cent, flux, lsum, chromaF,
    re: new Float32Array(N), im: new Float32Array(N), prev: new Float32Array(half), mag: new Float32Array(half),
  };
  for (let f = 0; f < F; f += 64) {
    _mFeatFrames(c, f, Math.min(F, f + 64));
    if (tick) await tick();
  }

  // ── 有声段：去掉片头片尾的静音，不然「起伏」全被开头那两秒空白撑大 ──
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(F * 0.9)];
  const silTh = Math.max(p90 * 0.05, 1e-4);
  let a0 = 0, a1 = F - 1;
  while (a0 < F && rms[a0] < silTh) a0++;
  while (a1 > a0 && rms[a1] < silTh) a1--;
  if (a1 - a0 < 5 * sr / HOP) return null;

  // ── 亮度：有声帧频谱重心的中位数（Hz）──
  const cs = [];
  for (let f = a0; f <= a1; f++) if (rms[f] >= silTh) cs.push(cent[f]);
  cs.sort((a, b) => a - b);
  const bright = Math.round(cs[Math.floor(cs.length / 2)] || 0);

  // ── 起伏：3 秒窗的响度（dB），取 95 分位减 10 分位 ≈ 广播界的 LRA ──
  const fps = sr / HOP, W = Math.round(3 * fps), step = Math.max(1, W >> 1);
  const winDb = [];
  for (let s0 = a0; s0 + W <= a1 + 1; s0 += step) {
    let p = 0;
    for (let f = s0; f < s0 + W; f++) p += rms[f] * rms[f];
    winDb.push(10 * Math.log10(p / W + 1e-12));
  }
  const wd = [...winDb].sort((a, b) => a - b);
  const pct = q => wd[Math.min(wd.length - 1, Math.floor(wd.length * q))];
  const lra = wd.length ? +(pct(0.95) - pct(0.10)).toFixed(1) : 0;
  // 走势：把有声段切 8 段，每段相对全曲最响那段差几 dB（0 = 最响，负数 = 更轻）
  const SEG = 8, segDb = [];
  const segLen = (a1 - a0 + 1) / SEG;
  for (let g = 0; g < SEG; g++) {
    const s0 = a0 + Math.floor(g * segLen), s1 = a0 + Math.floor((g + 1) * segLen);
    let p = 0;
    for (let f = s0; f < s1; f++) p += rms[f] * rms[f];
    segDb.push(10 * Math.log10(p / Math.max(1, s1 - s0) + 1e-12));
  }
  const top = Math.max(...segDb);
  const arc = segDb.map(v => Math.round(v - top));

  // ── 速度：通量减去局部均值再自相关，在 50~200 BPM 里找最像周期的那个 ──
  // 拍子天然有倍/半的歧义（90 和 180 自相关都高），按 librosa 的做法乘一个
  // 宽一个八度的先验，偏向人会拿来打拍子的那一档。中心取 100 不取 librosa 的 120：
  // 中文慢歌多在 70~80，用 120 的话《后来》被算成 150（真实 75），改 100 之后
  // 实测 8 首里只有它变了、变对了。
  const E = a1 - a0 + 1, env = new Float32Array(E), M = Math.round(fps * 0.4);
  let run = 0;
  for (let i = 0; i < E; i++) {
    run += flux[a0 + i];
    if (i >= M) run -= flux[a0 + i - M];
    env[i] = Math.max(0, flux[a0 + i] - run / Math.min(i + 1, M));
  }
  const lagMin = Math.floor(fps * 60 / 200), lagMax = Math.ceil(fps * 60 / 50);
  const gridMin = Math.ceil(fps * 60 / 400);       // 细网格最快算到每分钟 400 下
  const acf = new Float32Array(lagMax + 2);
  for (let lag = 0; lag <= lagMax + 1; lag++) {
    if (lag && lag < gridMin - 1) continue;
    let s = 0;
    for (let i = 0; i + lag < E; i++) s += env[i] * env[i + lag];
    acf[lag] = s / (E - lag);
  }
  let best = 0, bestScore = -1, peakMax = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (!(acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1])) continue;
    peakMax = Math.max(peakMax, acf[lag]);
    const bpm = fps * 60 / lag;
    const score = acf[lag] * Math.exp(-0.5 * Math.log2(bpm / 100) ** 2);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // 八分音符铺满的歌（《彩色复活券》，约 131）：每 263 下/分就有一个起音，自相关在
  // 2、3、4 个八分音符处是一排几乎等高的梳齿，上面那步会落到 66 或 88。
  // 这种歌在 200~400 下/分之间有一个和拍子峰差不多高的细网格——其余校准歌这里最高
  // 只到 0.42，《彩色复活券》各版本 0.84 以上——有的话拍子直接取「两格」。
  // 没有细网格的（纯四分音符点击、抒情歌）走不到这里，不变。
  for (let u = gridMin; u < lagMin; u++) {
    if (!(acf[u] >= acf[u - 1] && acf[u] >= acf[u + 1] && acf[u] >= 0.7 * peakMax)) continue;
    const c = Math.round(2 * u);
    let g = c;
    for (const j of [c - 1, c + 1]) if (j >= lagMin && j <= lagMax && acf[j] > acf[g]) g = j;
    if (g >= lagMin && g <= lagMax && acf[g] >= 0.7 * peakMax) best = g;
    break;
  }
  let bpm = 0, bpmConf = 0;
  if (best && acf[0] > 0) {
    const y0 = acf[best - 1], y1 = acf[best], y2 = acf[best + 1], den2 = 2 * (2 * y1 - y0 - y2);
    const sh = den2 ? Math.max(-0.5, Math.min(0.5, (y2 - y0) / den2)) : 0;
    bpm = Math.round(fps * 60 / (best + sh));
    // 置信度：这个周期的自相关比「随便一个滞后」高出多少。节拍清楚的流行歌明显高，
    // 散拍的钢琴/氛围音乐接近平均值
    let mean = 0, cnt = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) { mean += acf[lag]; cnt++; }
    mean /= cnt;
    bpmConf = +((acf[best] - mean) / acf[0]).toFixed(3);
  }
  // 上面那个置信度只看「形状」，不看「有多大」：一段没有任何起音的长音，通量只剩数值噪声，
  // 噪声的自相关照样能凑出一个 0.36 的「周期」。所以再量一个绝对的起音强度——
  // 起音包络的均值占每帧总对数幅度的比例。
  let envSum = 0, lsSum = 0;
  for (let i = 0; i < E; i++) { envSum += env[i]; lsSum += lsum[a0 + i]; }
  const pulse = lsSum > 0 ? +(envSum / lsSum * 1000).toFixed(2) : 0;

  // ── 调性：音级能量对 Krumhansl-Kessler 大/小调模板做相关，24 个调里挑最像的 ──
  const chroma = new Float64Array(12);
  for (let f = a0; f <= a1; f++) {
    let t = 0;
    for (let p = 0; p < 12; p++) t += chromaF[f * 12 + p];
    if (t > 0) for (let p = 0; p < 12; p++) chroma[p] += chromaF[f * 12 + p] / t;   // 每帧先归一，别让最响的几秒独占
  }
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (x, y) => {
    const mx = x.reduce((a, b) => a + b, 0) / 12, my = y.reduce((a, b) => a + b, 0) / 12;
    let s = 0, sx = 0, sy = 0;
    for (let i = 0; i < 12; i++) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    return sx && sy ? s / Math.sqrt(sx * sy) : 0;
  };
  const cands = [];
  for (let root = 0; root < 12; root++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + root) % 12]);
    cands.push({ root, minor: false, r: corr(rot, MAJ) }, { root, minor: true, r: corr(rot, MIN) });
  }
  cands.sort((a, b) => b.r - a.r);
  const k0 = cands[0];
  // 关系大小调（C 大调 / A 小调）用的是同一组音，最容易互相混。置信度取和「除了它俩以外最像的那个」的差距，
  // 另外单独记一下和关系调差多少——差得少就只说「调性」不说大/小。
  const rel = k0.minor ? (k0.root + 3) % 12 : (k0.root + 9) % 12;
  const relC = cands.find(c => c.root === rel && c.minor !== k0.minor);
  const other = cands.find(c => c !== k0 && c !== relC);
  const key = `${_M_KEYS[k0.root]}${k0.minor ? ' 小调' : ' 大调'}`;

  return {
    dur: Math.round(d.length / sr), bpm, bpmConf, pulse, bright, lra, arc,
    key, keyR: +k0.r.toFixed(2), keyConf: +(k0.r - other.r).toFixed(2), modeConf: +(k0.r - relC.r).toFixed(2),
  };
}

// 有没有能打的拍子。两道门都要过：
//   bpmConf ≥ 0.3：节拍清楚的流行/电子实测 0.39~0.68，自由节奏的钢琴（River Flows in You）0.24
//   pulse ≥ 10：真歌实测 27~48；没有起音的长音 3.3、白噪声 2.3（光看 bpmConf 长音能到 0.36）
function _mHasBeat(f) { return !!(f && f.bpm && f.bpmConf >= 0.3 && f.pulse >= 10); }

// 数 → 人话。和 _voiceHint 一样只给「大概」，判断留给 AI。
function musicSongHint(f) {
  if (!f) return '';
  const parts = [];
  if (_mHasBeat(f)) {
    const b = f.bpm;
    parts.push(`约 ${b} BPM（${b < 76 ? '慢' : b < 100 ? '中慢' : b < 125 ? '中速' : b < 150 ? '偏快' : '快'}）`);
  } else parts.push('拍子不明显（散拍/自由节奏）');
  parts.push(f.bright < 1100 ? '音色偏暗偏厚' : f.bright < 1800 ? '音色偏暖' : f.bright < 2600 ? '音色偏亮' : '音色很亮很脆');
  parts.push(f.lra < 4 ? '整首响度很平' : f.lra < 9 ? '起伏适中' : '起伏很大');
  const arc = _mArcText(f.arc);
  if (arc) parts.push(arc);
  if (f.keyConf >= 0.08) parts.push(f.modeConf >= 0.04 ? `大概是 ${f.key}` : `调性大概在 ${f.key}/它的关系调之间`);
  return parts.join('、');
}
// 面板上那一行短的：给人扫一眼，不给 AI（AI 读 musicSongHint 那句长的）
function musicSongTags(f) {
  if (!f) return '';
  const t = [_mHasBeat(f) ? `${f.bpm} BPM` : '散拍',
    f.bright < 1100 ? '偏暗' : f.bright < 1800 ? '偏暖' : f.bright < 2600 ? '偏亮' : '很亮',
    f.lra < 4 ? '平稳' : f.lra < 9 ? '有起伏' : '起伏大'];
  if (f.keyConf >= 0.08 && f.modeConf >= 0.04) t.push(f.key.replace(' ', ''));
  return '🎧 ' + t.join(' · ');
}
// 8 段相对响度 → 一句走势
function _mArcText(arc) {
  if (!Array.isArray(arc) || arc.length < 6) return '';
  const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const head = avg(arc.slice(0, 2)), mid = avg(arc.slice(2, 6)), tail = avg(arc.slice(6));
  const peak = arc.indexOf(0);
  if (head <= mid - 5 && tail <= mid - 4) return '开头轻、中间推到最满、结尾收回去';
  if (head <= tail - 5) return '越往后越满（开头轻，后面推上去）';
  if (tail <= head - 5) return '前面满、后面渐渐收';
  if (Math.min(...arc) <= -8 && peak >= 2 && peak <= 5) return '中间有一段明显的高潮';
  return '';
}

// ── 遥控（Spotify Connect 那种）的接口 ──
// _mRemote 非空 = 这台正在遥控另一台：面板上显示的是那台的歌，按钮全都变成发给那台的指令。
// 真正连 server、收发状态的代码在 24-music-remote.js；这里只留一个钩子，
// 让下面每个播放动作开头问一句「现在是不是在遥控别人」——是就把指令发走、本机什么都不做。
// 这个文件单独拿去跑测试时没有遥控模块，_mRemote 永远是 null，钩子全都放行。
var _mRemote = null;
function _mRC(cmd, args) {
  if (!_mRemote) return false;
  if (typeof musicRemoteSend === 'function') musicRemoteSend(cmd, args || {});
  return true;
}
// 队列在遥控时是那台的镜像；本机点了加队列/删/置顶/清空之后，把改完的整条队列发过去
function _mRCQueue() {
  if (!_mRemote) return false;
  _mRC('queue', { queue: _mQueue.map(_mSlim), clearCtx: !_mCtx });
  return true;
}

function musicToggle() {
  if (_mRC('toggle')) return;
  if (!_mNow) return;
  // 重启后装回来、还没开始放的那首：没有地址，走完整的 musicPlay（它会从存下的那一秒接着放）
  if (_mNow._resume) return void musicPlay(_mNow);
  const a = _mAudioEl();
  if (a.paused) a.play().catch(_mPlayFailed); else a.pause();
}

// 下一首。随机：从队列里随便抽；列表循环：队列空了且有整张单子，就把单子重新装回来。
// 单曲循环只管「自然放完」（见 ended），手动点下一首照样往下走——不然按钮是死的。
function musicNext(auto) {
  if (_mRC('next')) return;
  const pick = () => (_mMode === 'shuffle' && _mQueue.length > 1)
    ? _mQueue.splice(Math.floor(Math.random() * _mQueue.length), 1)[0]
    : _mQueue.shift();
  let nx = pick();
  if (!nx && _mCtx && _mCtx.length && _mMode !== 'one') {
    _mQueue = _mCtx.map(s => Object.assign({}, s));
    // 重新装回来的第一首就是正在放的这首时跳过它（单子不止一首的话）
    if (_mQueue.length > 1 && _mNow) _mQueue = _mQueue.filter(s => !_mSameSong(s.id, _mNow.id));
    nx = pick();
  }
  if (nx) { musicPlay(Object.assign({}, nx, { _fromQ: true })); return; }
  // 自然放完、队列空、也没有整张单子可循环（从聊天卡片/搜索结果点的单首都是这样）：
  // 「列表循环/随机」下就把这首再放一遍，而不是停在末尾——否则离开点歌台后听一首放完就哑了。
  if (auto && _mAudio && _mNow) { _mAudio.currentTime = 0; _mAudio.play().catch(() => {}); return; }
  _mPaint();
}

// 上一首：放了几秒以上先回到开头（所有播放器都是这个手感），再按一次才真的退回上一首
function musicPrev() {
  if (_mRC('prev')) return;
  const a = _mAudio;
  if (a && _mNow && a.currentTime > 4) { a.currentTime = 0; _mTick(); return; }
  const pv = _mHist.pop();
  if (!pv) { if (a && _mNow) { a.currentTime = 0; _mTick(); } return; }
  if (_mNow) _mQueue.unshift(_mSlim(_mNow));
  _mHistSkip = true;
  musicPlay(pv);
}

function _mSetMode(m) {
  _mMode = _M_MODES.includes(m) ? m : 'list';
  // 遥控时改的是那台的模式：先在镜像上改了让按钮立刻换图标，本机自己的偏好不动
  if (_mRC('mode', { m: _mMode })) { _mPaint(); return; }
  try { localStorage.setItem('kuro_musicMode', _mMode); } catch (e) {}
  _mPaint();
}
function musicCycleMode() {
  _mSetMode(_M_MODES[(_M_MODES.indexOf(_mMode) + 1) % _M_MODES.length]);
  showToast(_M_MODE_NAMES[_mMode], 'info', 1200);
}
function musicCycleRate() {
  _mRate = _M_RATES[(_M_RATES.indexOf(_mRate) + 1) % _M_RATES.length];
  if (_mRC('rate', { r: _mRate })) { musicRefresh(); return; }
  try { localStorage.setItem('kuro_musicRate', String(_mRate)); } catch (e) {}
  // defaultPlaybackRate 也要改：换歌走 load() 时浏览器按它重置
  if (_mAudio) { _mAudio.defaultPlaybackRate = _mRate; _mAudio.playbackRate = _mRate; }
  musicRefresh();
}
function _mRateText() { return (_mRate % 1 ? String(_mRate) : _mRate.toFixed(1)) + 'x'; }

function musicStop() {
  if (_mRC('stop')) return;
  _mFadeStop(); _mSwitching = false;
  if (_mAudio) { _mAudio.pause(); _mAudio.removeAttribute('src'); _mAudio.load(); _mAudio.volume = 1; }
  _mNow = null; _mLyric = null; _mWordCur = -1; _mTint = null;
  _mMediaSync();
  // 作废在途的三件事，否则停了之后歌词/配色还会飘回来，
  // 而且没走完的那趟 musicPlay 会在 _mNow 已经是 null 时去读 _mNow.cover
  _mPlayReq++; _mLyricReq++; _mTintReq++;
  _mFluidSet(null);        // 封面层不清的话，停了之后底下还挂着上一首的封面
  _mApplyTint();
  _mSessSave();            // 杀掉的歌别在下次启动时又被装回来
  _mPaint();
  if (typeof _mTogetherGet === 'function' && _mTogetherGet()) musicHarvest();   // 停了：这首一起听时聊的那段收走
}

var _mSeekDrag = null;
function _mSeekAt(ev, el) {
  const a = _mAudioEl();
  if (!a.duration) return;
  const box = el.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));
  a.currentTime = pct * a.duration;
  document.querySelectorAll('.music-fill').forEach(f => { f.style.width = (pct * 100) + '%'; });
  document.querySelectorAll('.music-t-cur').forEach(t => { t.textContent = _mFmt(a.currentTime); });
  _mTick();
}
function musicSeekStart(ev, el) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  ev.preventDefault();
  _mSeekDrag = { el, id: ev.pointerId };
  el.classList.add('dragging');
  try { el.setPointerCapture(ev.pointerId); } catch (_) {}
  _mSeekAt(ev, el);
}
function musicSeekMove(ev, el) {
  if (!_mSeekDrag || _mSeekDrag.el !== el || _mSeekDrag.id !== ev.pointerId) return;
  ev.preventDefault();
  _mSeekAt(ev, el);
}
function musicSeekEnd(ev, el) {
  if (!_mSeekDrag || _mSeekDrag.el !== el || _mSeekDrag.id !== ev.pointerId) return;
  _mSeekAt(ev, el);
  el.classList.remove('dragging');
  try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
  _mSeekDrag = null;
}

// 老入口：单曲循环开/关。现在是三态模式的一档
function musicSetLoop(on) { _mSetMode(on ? 'one' : 'list'); }

// 最近播放：小组件里"接着听刚才那首"用。只留 30 条元数据，不存播放地址（会过期）
// 顺手记「上一首」的历史：每开始放一首新的，就把刚才那首压进 _mHist。
function musicNoteRecent(song) {
  if (_mHistCur && !_mSameSong(_mHistCur.id, song.id) && !_mHistSkip) {
    _mHist.push(_mHistCur);
    if (_mHist.length > 50) _mHist.shift();
  }
  _mHistSkip = false;
  _mHistCur = _mSlim(song);
  if (!Array.isArray(state.musicRecent)) state.musicRecent = [];
  const rec = { id: song.id, name: song.name, artist: song.artist, cover: song.cover || '', ts: _mStamp() };
  state.musicRecent = [rec, ...state.musicRecent.filter(s => String(s.id) !== String(song.id))].slice(0, 30);
  save();
}

// ============================================================
// 歌词
//
// 网易云同一个接口能给三层东西，以前只取了最外面那层：
//   lrc  行级 LRC ── 一句一个时间点，只能整句高亮
//   yrc  逐字时轴 ── 每个字都有起止毫秒，能做卡拉OK式逐字点亮
//   ytlrc/yromalrc  逐字版的翻译和罗马音
// 现在优先吃 yrc，没有才回落 lrc。**回落必须留着**：老歌、冷门歌、
// 大部分纯翻唱都只有行级歌词，只认 yrc 的话它们会直接变成"没有歌词"。
//
// 有 yrc 的时候翻译优先用 ytlrc：实测（Lemon / id=1466598056）ytlrc 的行首时间
// 和 yrc **中位数差 0.000 秒**（本来就是同一套时间轴），而 tlyric 差 0.320 秒。
// 下面 _mAttachAlt 是按时间就近配对的，所以拿错了也不会整体错行，
// 只是边界上会少配上一两条——真按行号硬配才会满盘皆错。
// ============================================================

// 统一的内部形态，行级和逐字共用一套，渲染层只看 words 是否为空：
//   { wbw, lines:[ { t, end, txt, words:[{t,end,txt}], tr, ro } ], idx }
var _mWordCur = -1;      // 当前行内唱到第几个字（-1 = 还没开口）

// 小数秒：LRC 里 [00:12.5] [00:12.50] [00:12.500] 是同一个时刻。
// 老代码一律除以 1000，两位的厘秒会被当成毫秒——.50 算成 0.05 秒，
// 整首歌的高亮都提前小半秒，肉眼只觉得"有点抢"，查不出来。
function _mFrac(s) { return s ? (+s) / Math.pow(10, s.length) : 0; }

// WebVTT：`00:00:12.000 --> 00:00:15.000` 换行接文本，块与块之间空行分隔。
// 和 LRC 完全不是一套语法，_mParseLrc 认不出来，得单独走一条。
function _mVttTime(h, m, s) { return (+(h || 0)) * 3600 + (+m) * 60 + (+s); }
function _mParseVtt(str) {
  const out = [];
  for (const block of String(str || '').split(/\r?\n\s*\r?\n/)) {
    const rows = block.split(/\r?\n/);
    // 只取时间行**之后**的内容当正文。不能改成"过滤掉纯数字行"——
    // WebVTT 的 cue identifier 不限于数字（`chorus` 这种是合法的），
    // 那样过滤会把 cue 名字当成歌词，混进去一句 "chorus 第一句"。
    const ti = rows.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const m = rows[ti].match(/(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)\s*-->\s*(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)/);
    if (!m) continue;
    const txt = rows.slice(ti + 1).filter(l => l.trim())
      .join(' ').replace(/<[^>]*>/g, '').trim();       // 顺手去掉 <c> <v> 这类内联标记
    if (!txt) continue;
    out.push({
      t: _mVttTime(m[1], m[2], String(m[3]).replace(',', '.')),
      end: _mVttTime(m[4], m[5], String(m[6]).replace(',', '.')),
      txt, words: [],
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// LRC 风格的行级歌词。一行可以挂多个时间标签（副歌复用同一句）。
function _mParseLrc(str) {
  const out = [];
  const tagRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  for (const raw of String(str || '').split('\n')) {
    const tags = raw.match(/\[\d+:\d+(?:[.:]\d+)?\]/g);
    if (!tags) continue;
    const txt = raw.replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, '').trim();
    if (!txt) continue;
    for (const tag of tags) {
      tagRe.lastIndex = 0;
      const m = tagRe.exec(tag);
      if (m) out.push({ t: +m[1] * 60 + +m[2] + _mFrac(m[3]), txt, words: [] });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// 逐字歌词。网易云的 yrc 和 QQ 音乐的 qrc 是同一套语法，一个解析器吃两种：
//   [行起始ms,行时长ms](字起始ms,字时长ms,0)字(...)字
// yrc 开头还有几行 {"t":0,"c":[...]} 的元数据（歌名/歌手），
// 行首正则匹配不上就自然被滤掉了，不用单独处理。
function _mParseWordLyric(str) {
  const out = [];
  for (const raw of String(str || '').split('\n')) {
    const lm = raw.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lm) continue;
    const words = [];
    let txt = '';
    // 字的文本一直取到**下一个合法时间元组**为止，不能写成 [^(]*：
    // 歌词里出现普通左括号（和声 (Oh)、括号注释）时，[^(]* 会在那里立刻收尾，
    // 这个字变成空串、整行被丢掉——英文歌的和声标记里这东西遍地都是。
    const re = /\((\d+),(\d+),(-?\d+)\)((?:(?!\(\d+,\d+,-?\d+\))[\s\S])*)/g;
    let wm;
    while ((wm = re.exec(lm[3])) !== null) {
      if (!wm[4]) continue;
      words.push({ t: +wm[1] / 1000, end: (+wm[1] + +wm[2]) / 1000, txt: wm[4] });
      txt += wm[4];
    }
    if (!txt.trim()) continue;
    out.push({ t: +lm[1] / 1000, end: (+lm[1] + +lm[2]) / 1000, txt: txt.trim(), words });
  }
  return out.sort((a, b) => a.t - b.t);
}

// TTML（Apple Music / AMLL 那一系用的格式）。网易云不给，留给下面的"贴歌词"用。
// 时间写法有两种：00:01:23.456 和 83.456s，都得认。
function _mTtmlTime(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const clock = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (clock) return (+(clock[1] || 0)) * 3600 + (+clock[2]) * 60 + (+clock[3]);
  const off = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (off) return (+off[1]) * ({ ms: .001, s: 1, m: 60, h: 3600 }[off[2] || 's']);
  return null;
}
function _mParseTtml(str) {
  let doc;
  try { doc = new DOMParser().parseFromString(str, 'application/xml'); } catch (e) { return []; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return [];
  const out = [];
  for (const p of doc.getElementsByTagName('p')) {
    const t = _mTtmlTime(p.getAttribute('begin'));
    if (t === null) continue;
    const end = _mTtmlTime(p.getAttribute('end'));
    // 行内 <span begin end> 就是逐字；没有就整句当一个"字"
    const words = [];
    for (const sp of p.getElementsByTagName('span')) {
      const wt = _mTtmlTime(sp.getAttribute('begin'));
      const we = _mTtmlTime(sp.getAttribute('end'));
      if (wt === null || we === null || !sp.textContent) continue;
      words.push({ t: wt, end: we, txt: sp.textContent });
    }
    const txt = (words.length ? words.map(w => w.txt).join('') : p.textContent || '').trim();
    if (!txt) continue;
    out.push({ t, end: end === null ? t + 4 : end, txt, words });
  }
  return out.sort((a, b) => a.t - b.t);
}

// 猜格式。给"贴歌词"用——用户不该被要求先说清自己贴的是哪一种。
function _mSniffLyric(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  if (/^\s*</.test(s) && /<tt[\s>]|<p[\s>]/i.test(s)) return _mParseTtml(s);
  if (/^\s*WEBVTT/i.test(s) || /^\s*[\d:.,]+\s*-->/m.test(s)) return _mParseVtt(s);
  if (/^\[\d+,\d+\]/m.test(s)) return _mParseWordLyric(s);
  if (/^\[\d+:\d+/m.test(s)) return _mParseLrc(s);
  return null;
}

// 把翻译/罗马音按时间贴到主歌词上。两边行数经常对不齐（翻译少几句是常态），
// 所以按"最近的起始时间"配对，差得太远就不配——硬按下标配会整体错行。
// 必须是**一对一**：每条翻译最多贴给一行。以前每行各自找最近的一条，
// 结果是主歌词拆行、翻译合行的时候（副歌、短促和声）同一句翻译连着显示两遍。
// 实测 Lemon 就中招：42 条翻译配到了 44 行主歌词上。
// 两边都已按时间排序，所以单指针往前推就够了，顺带把 O(n×m) 收成 O(n+m)。
function _mAttachAlt(lines, altStr, key) {
  const alt = _mParseLrc(altStr);
  if (!alt.length) return;
  let j = 0;
  for (const line of lines) {
    // 推到离这一行最近的那条（时间只增不减，不会回头）
    while (j + 1 < alt.length && Math.abs(alt[j + 1].t - line.t) <= Math.abs(alt[j].t - line.t)) j++;
    if (j >= alt.length) break;
    // "配上了"和"值得显示"是两件事：翻译和原文一模一样时不显示（没意义），
    // 但**仍然要消费掉**它——否则它会顺延贴给下一行，变成错位的翻译。
    if (Math.abs(alt[j].t - line.t) <= 0.6) {
      if (alt[j].txt !== line.txt) line[key] = alt[j].txt;
      j++;                       // 用掉了就不能再给下一行
      if (j >= alt.length) break;
    }
  }
}

// 纯音乐：网易云会塞一句"纯音乐，请欣赏"当歌词。不认出来的话，
// 沉浸模式下这六个字会占满整块屏幕一动不动。
// 认出来之后不是简单地「没有歌词」：记下是哪首，面板上换成猫咪那句（用户定的字）。
// 按歌 id 记而不是一个布尔：切歌、停歌、遥控换镜像都会把 _mLyric 清成 null，
// 布尔要在每一处都记得复位，漏一处就会在下一首有词的歌加载期间闪一下猫咪。
var _mLyPureId = null;
function _mLyIsPure() { return !!(_mNow && _mLyPureId !== null && String(_mNow.id) === _mLyPureId); }
// 只有「作词 : xxx / 编曲 : xxx」这种制作名单、没有一句真词（也常常没有时间轴）——
// 「斩杀时刻」就是这样：lyric 非空所以躲过了「一个字都没有」，解析出 0 行又落到「没有歌词」。
// 这其实就是纯音乐，一样给猫咪那句。至少要有一行名单，且名单之外不剩任何字。
function _mOnlyCredits(raw) {
  const rows = String(raw || '').split(/\r?\n/).map(s => s.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean);
  if (!rows.length) return false;
  const credit = /^(作词|作曲|编曲|制作人?|混音|母带|出品人?|监制|演唱|录音|策划|和声|词|曲|编曲\/制作\/混音|Lyrics?|Compose[dr]?|Arrange[dr]?|Produce[dr]?|Mix(ed|ing)?|Master(ed|ing)?)[^:：]{0,16}\s*[:：]/i;
  return rows.every(r => credit.test(r));
}
function _mIsPureMusic(j, lines) {
  if (j && j.pureMusic) return true;
  if (j && !String(j.yrc || '').trim() && _mOnlyCredits(j.lyric)) return true;
  return lines.length > 0 && lines.length <= 2 && lines.every(l => /纯音乐[，,]\s*请欣赏/.test(l.txt));
}

function _mSetLyric(lines, wbw) {
  _mLyric = lines && lines.length ? { lines, wbw: !!wbw, idx: -1 } : null;
  _mWordCur = -1;
}

// 连着切歌时，先发的请求可能后回来。不作废的话：切到 B、B 的歌词先画好，
// 然后 A 的慢响应回来把 B 的歌词盖掉——放着 B 唱、屏幕上是 A 的词，且零报错。
// musicStop 也要 ++，否则停掉之后在途的那个还会把歌词塞回来。
var _mLyricReq = 0;

async function musicLoadLyric(id) {
  const seq = ++_mLyricReq;
  _mLyric = null; _mWordCur = -1;
  try {
    const r = await fetch(`${musicApiBase()}/api/music/lyric?id=${encodeURIComponent(id)}`);
    const j = await r.json();
    // 等待期间切歌/停了 → 这份结果已经过期，丢掉
    if (seq !== _mLyricReq || !_mNow || String(_mNow.id) !== String(id)) return;
    const yrc = _mParseWordLyric(j.yrc);
    const wbw = yrc.length > 0;
    const lines = wbw ? yrc : _mParseLrc(j.lyric);
    // 网易云只给一部分纯音乐打 pureMusic 标。大量 phonk/slowed/sped up 回的是「一个字都没有、也不带标」
    // （用户反馈：「纯音乐怎么还是没有歌词」——不少 phonk 曲目都是这样）。
    // 所以：网易云**答了**、而且两份时轴都是空的 → 同样是猫咪。
    // 「没有歌词」只留给真没拿到（断网、server 502）——那是取失败，不是这首没词。
    // 有字但解析不出来也不算：那是格式问题，不能拿猫咪盖过去。
    const nothing = r.ok && !String(j.lyric || '').trim() && !String(j.yrc || '').trim();
    if (_mIsPureMusic(j, lines) || nothing) _mLyPureId = String(id);
    else if (lines.length) {
      // 逐字歌词配逐字版的翻译/罗马音，没有才回落到行级那份（见开头 ⚠️）
      _mAttachAlt(lines, (wbw && j.ytlrc) || j.tlyric, 'tr');
      _mAttachAlt(lines, (wbw && j.yromalrc) || j.romalrc, 'ro');
      _mSetLyric(lines, wbw);
    }
  } catch (e) { /* 没歌词就没歌词，不是错误 */ }
  _mPaintLyric();
  _mDockLyric();
}

// 要她输一句话（歌单名、贴歌词）。**不能用原生 prompt()**：它在 Electron 桌面版和安卓 WebView 里
// 都是静默返回 null 的——点了「新建歌单」什么都不发生，也不报错。统一走 02-state 的 appPrompt 弹窗。
// 测试沙箱里没有 appPrompt，退回 prompt（测试里是桩）。
function _mAsk(msg, def) {
  return typeof appPrompt === 'function' ? appPrompt(msg, def) : Promise.resolve(prompt(msg, def));
}

// 手动贴歌词：网易云匹配错了、或者干脆没有的时候的兜底。
// 顺带让上面那几个解析器（qrc / ttml）真的有地方能用上。
async function musicPasteLyric() {
  const raw = await _mAsk('把歌词贴进来（支持 LRC / WebVTT / 网易云 YRC / QQ音乐 QRC / TTML）：');
  if (raw === null) return;
  const lines = _mSniffLyric(raw);
  if (!lines || !lines.length) { showToast('这段歌词没认出来，检查一下格式～', 'error', 3000); return; }
  // 手动贴歌词多半就是因为自动那份还没回来或者匹配错了。不作废在途请求的话，
  // 网易云的响应过一会儿回来会把人刚贴的歌词直接盖掉。
  _mLyricReq++;
  _mSetLyric(lines, lines.some(l => l.words.length));
  _mPaintLyric();
  showToast(`已换上 ${lines.length} 行歌词${_mLyric.wbw ? '（逐字）' : ''}`, 'success', 2500);
}

// ── Tilt 排版：把一句拆成 1~4 段错落排布 ──
// 抄自 folia-major 的 Tilt 模式。它的做法是按语义分级切分（标点 → 括号 → 西文词
// → CJK 空格），切不够再按字数硬切，多了再合并；每段按概率决定要不要变成
// 「斜体放大」那一段，整句最多一段是。
//
// **只在 word 边界切**，这是这里最要紧的一条：切段之后 .ly-w 的 DOM 顺序必须
// 仍然和 line.words 一一对应，_mSyncWords 才能原封不动地用
// getElementsByClassName（它返回的是文档顺序）。从字符位置切的话，
// 空白字符和跨段的字会让 span 数和 words 数对不上——症状是"点亮跑到别的段去了"，
// 看得见，但一行报错都没有。
function _mTiltLineCount(charCount, rnd) {
  // 字数越多越倾向多切几段，但带抖动，免得每句都切得一样整齐
  const norm = Math.log(charCount + 4) / Math.log(24);
  const s = norm * (rnd() * 0.6 + 0.7);
  return s < 0.5 ? 1 : s < 1.05 ? 2 : s < 1.6 ? 3 : 4;
}
function _mTiltSplit(line, seed) {
  const rnd = _mSeedRand(seed);
  const ws = line.words || [];
  const text = line.txt || '';
  const n = _mTiltLineCount((text || '').trim().length, rnd);

  let groups;
  if (!ws.length) {
    groups = _mTiltSplitText(text, n, rnd).map(t => ({ txt: t, words: [] }));
  } else if (n <= 1) {
    groups = [{ txt: text, words: ws }];
  } else {
    // 候选切点：优先"这个字以标点收尾"，其次"下一个字以空格开头"，再次分词器认的词边界。
    // **词中间不许切**——用户截图：「就这样一点 / 点的腐烂吧」，「一点点」被劈成两半。
    // 以前没有分词这一级，切不出来就按字数硬劈；folia-major 原版在这一级用的也是 Intl.Segmenter。
    const full = ws.map(w => w.txt).join('');
    const brk = _mTiltBreaks(full);
    const ends = [];
    let off = 0;
    for (const w of ws) { off += w.txt.length; ends.push(off); }
    const score = k => brk.get(ends[k]) || 0;   // 0 = 词中间，不能切
    const target = Math.min(n, ws.length);
    const per = ws.length / target;
    const cuts = [];
    for (let g = 1; g < target; g++) {
      const ideal = Math.round(g * per);
      // 在理想位置附近找一个最像断句的地方；附近全是词中间就少切一段
      let best = -1, bestScore = 0;
      const lo = Math.max(cuts.length ? cuts[cuts.length - 1] + 1 : 0, ideal - 3);
      const hi = Math.min(ws.length - 2, ideal + 2);
      for (let k = lo; k <= hi; k++) {
        if (!score(k)) continue;
        // 两边都至少留两个字：单独掉一个「吧」「啊」到下一段比不切还难看
        const prev = cuts.length ? ends[cuts[cuts.length - 1]] : 0;
        if (_mTiltLen(full.slice(prev, ends[k])) < 2 || _mTiltLen(full.slice(ends[k])) < 2) continue;
        const s = score(k) - Math.abs(k - (ideal - 1)) * 0.35;
        if (s > bestScore) { bestScore = s; best = k; }
      }
      // 附近全是词中间（假名长句常见：「夢ならば|どれほどよかったでしょう」唯一的词边界离中点很远）
      // → 退一步，整句里找离理想位置最近的合法切点，别整句一段不切
      if (best < 0) {
        let bestD = Infinity;
        const prev = cuts.length ? ends[cuts[cuts.length - 1]] : 0;
        for (let k = cuts.length ? cuts[cuts.length - 1] + 1 : 0; k <= ws.length - 2; k++) {
          if (!score(k)) continue;
          if (_mTiltLen(full.slice(prev, ends[k])) < 2 || _mTiltLen(full.slice(ends[k])) < 2) continue;
          const d = Math.abs(k - (ideal - 1)) - score(k);
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      if (best >= 0 && (!cuts.length || best > cuts[cuts.length - 1])) cuts.push(best);
    }
    groups = [];
    let start = 0;
    for (const c of cuts.concat([ws.length - 1])) {
      const seg = ws.slice(start, c + 1);
      if (seg.length) groups.push({ txt: seg.map(w => w.txt).join(''), words: seg });
      start = c + 1;
    }
  }

  // 整句最多一段变成斜体大字。段数为 1 时也允许（那句就整个放大）
  const tiltAt = rnd() < 0.72 ? Math.floor(rnd() * groups.length) : -1;
  return groups.map((g, i) => ({
    txt: g.txt, words: g.words,
    tilt: i === tiltAt,
    // 缩进：奇偶交替再加一点抖动，排出错落感而不是整齐的阶梯
    ind: Math.max(0, Math.min(0.42, (i % 2 ? 0.20 : 0.02) + rnd() * 0.16)),
    rot: (rnd() - 0.5) * (i === tiltAt ? 3.2 : 1.2),
  }));
}
// 可以切的位置：字符偏移 → 分数（3 标点后、2 空白处、1 分词器认的词边界）。不在表里的位置是词中间，不能切。
// 没有 Intl.Segmenter 的老内核只剩标点和空格两级——宁可少切一段，也不把词劈开。
var _mTiltSeg = null;
function _mTiltBreaks(text) {
  const m = new Map();
  const put = (i, s) => { if (i > 0 && i < text.length && (m.get(i) || 0) < s) m.set(i, s); };
  if (_mTiltSeg === null) {
    try { _mTiltSeg = new Intl.Segmenter('zh', { granularity: 'word' }); } catch (_) { _mTiltSeg = false; }
  }
  if (_mTiltSeg) {
    // ICU 的分词在歌词上会犯三种错，词边界这一级要再筛一遍：
    //   叠字被拆（「一点|点」）、虚词落到下一段开头（「走过 / 的那些」）、
    //   日文词典外的假名一个一个散开（「よ|か|っ|た」）
    // 还有第四种：词典外的成语/新词被拆成一串单字（「也|一|无|是|处的」「倒霉|蛋」）。
    // 用户截图「哪怕存在着也一 / 无是处的我啊」。贴着单字的边界默认不切，
    // 除非左边以助词收尾（「存在着|也」「处的|我」）或右边是常起头的副词/连词/代词（「我|就是」）。
    // 判单字前先剥掉粘在尾巴上的助词：ICU 会把「处的」当一个词。
    const segs = [..._mTiltSeg.segment(text)];
    const kana = /^[぀-ヿ]$/;
    const tailP = /[的了着过吧啊呢吗嘛呀哦么地得]$/;
    const lone = s => /^[㐀-鿿]$/.test(s.replace(/[的了着过吧啊呢吗嘛呀哦么地得]+$/, '') || s);
    // 「一个 / 一次 / 两遍」这种数量短语也是天然的起头（「不想再|一个人孤单地流浪」），
    // 但前面是「这 / 那 / 每 / 第」时它们是一体的（「这一次」别劈成「这 / 一次」），「再一次」「又一遍」同理
    const numStart = (seg, a) => /^[一两几][个次遍点些种回下天场句首]/.test(seg) && !/[这那每第哪]/.test(a)
      && !(/[再又]/.test(a) && /^一[次遍回下]/.test(seg));
    for (let k = 1; k < segs.length; k++) {
      const i = segs[k].index, a = text[i - 1], b = text[i];
      if (a === b) continue;
      if (/[的了着过吧啊呢吗嘛呀哦么们得地之]/.test(b)) continue;
      if (kana.test(segs[k].segment) || kana.test(segs[k - 1].segment)) continue;
      if ((lone(segs[k - 1].segment) || lone(segs[k].segment))
          && !tailP.test(segs[k - 1].segment)
          && !/^[也就都还却又才再但而和与跟把被让给从向对我你他她它咱这那]/.test(segs[k].segment)
          && !numStart(segs[k].segment, a)) continue;
      put(i, 1);
    }
  }
  for (let i = 1; i < text.length; i++) {
    const a = text[i - 1], b = text[i];
    if (/[，。、！？；：,.!?;:…—）」』》】)]/.test(a) && !/[，。、！？；：,.!?;:…—]/.test(b)) put(i, 3);
    else if (/\s/.test(a) && !/\s/.test(b)) put(i, 2);   // 切在空格后面，下一段别以空格开头
  }
  // 「…，」后面跟着的空格：切在空格后面，别让下一段以空格开头
  for (const [i, s] of [...m]) if (s === 3 && /\s/.test(text[i] || '')) { m.delete(i); let j = i; while (/\s/.test(text[j] || '')) j++; put(j, 3); }
  return m;
}
function _mTiltLen(s) { return String(s || '').replace(/\s+/g, '').length; }
// 斜体只给不含中日韩字的放大段：宋体斜体是 Windows DirectWrite 在系统层硬拉的，
// CSS 的 font-synthesis-style:none 关不掉（10-14 实测），只能干脆不给 italic
function _mTiltItalic(s) {
  if (!s || !s.tilt) return false;
  const t = s.words && s.words.length ? s.words.map(w => w.txt).join('') : s.txt;
  return !/[぀-ヿ㐀-鿿豈-﫿가-힯＀-￯]/.test(t || '');
}
// 没有逐字时轴时按文本切：标点 → 空格 → 词边界（不劈词）
function _mTiltSplitText(text, n, rnd) {
  if (n <= 1 || !text) return [text];
  let parts = text.split(/(?<=[，。、！？；：,.!?;:…—])\s*/).filter(Boolean);
  // 空格留在前一段末尾：以前 split(/\s+/) 把空格吃掉，英文段拼回来成了「Icanfeelit」
  if (parts.length < n) parts = text.split(/(?<=\s)(?=\S)/).filter(Boolean);
  if (parts.length < n) {
    // 在均分点附近挑词边界切；附近没有能切的地方就少切一段
    const brk = _mTiltBreaks(text);
    const cuts = [];
    for (let g = 1; g < n; g++) {
      const ideal = Math.round(g * text.length / n);
      let best = -1, bestScore = 0;
      for (let i = ideal - 3; i <= ideal + 3; i++) {
        const s = brk.get(i) || 0;
        if (!s) continue;
        const prev = cuts.length ? cuts[cuts.length - 1] : 0;
        if (i <= prev || _mTiltLen(text.slice(prev, i)) < 2 || _mTiltLen(text.slice(i)) < 2) continue;
        const sc = s - Math.abs(i - ideal) * 0.35;
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best < 0) {                           // 附近没有 → 整句里找最近的合法切点（同 _mTiltSplit）
        let bestD = Infinity;
        const prev = cuts.length ? cuts[cuts.length - 1] : 0;
        for (const [i, s] of brk) {
          if (i <= prev || _mTiltLen(text.slice(prev, i)) < 2 || _mTiltLen(text.slice(i)) < 2) continue;
          const d = Math.abs(i - ideal) - s;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best > 0) cuts.push(best);
    }
    parts = [];
    let start = 0;
    for (const c of cuts.concat([text.length])) { parts.push(text.slice(start, c)); start = c; }
  }
  while (parts.length > n) {                    // 多了就把最短的两段并回去
    let mi = 0;
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i].length + parts[i + 1].length < parts[mi].length + parts[mi + 1].length) mi = i;
    }
    parts.splice(mi, 2, parts[mi] + parts[mi + 1]);
  }
  return parts;
}

// ── Cinema 影院排版 ──
// 只留当前一句，超大字横排，逐字高低错落、字号不一、互相压着，
// 镜头（.ly-main 的 translateX）跟着唱到的那个字横移。
//
// 和 Tilt 一样，**span 的 DOM 顺序必须和 line.words 一一对应**，
// 这里是逐词扁平映射，天生 1:1，_mSyncWords 那套不用动。

// 没有逐字时轴时的展示用切分：西文连着后面的空格算一个词，CJK 一字一个。
// 纯展示，和 _mParseWordLyric 无关——它只负责让 cinema 在普通 LRC 上也有错落感。
function _mCinePseudoWords(text) {
  return (String(text || '').match(/[A-Za-z0-9'’\-]+\s*|\s+|[\s\S]/g) || [])
    .map(t => ({ txt: t }));
}
// 一句里挑一个"hero"词特别放大——这是 cadenza(Mindscape) 的招牌，
// 它在 buildEmphasisMap 里给 hero 记 1.46 倍并摆到正中，其余词围着它排。
// 那套径向散落要碰撞检测 + pretext 排版，184px 高的面板里放不下，所以这里只搬
// "一句一个主角"这一条：**取最长的那个词**（字多的视觉重量本来就大），
// 并列时按种子挑一个，免得整首歌的 hero 永远落在同一个位置。
function _mCineHero(ws, rnd) {
  let best = -1, bestLen = 0, ties = 0;
  for (let i = 0; i < ws.length; i++) {
    const len = ws[i].txt.trim().length;
    if (!len) continue;
    if (len > bestLen) { bestLen = len; best = i; ties = 1; }
    else if (len === bestLen && rnd() < 1 / ++ties) best = i;   // 蓄水池抽样，均匀挑并列的
  }
  return best;
}
function _mCineJit(line, seed) {
  const rnd = _mSeedRand(seed);
  const ws = (line.words && line.words.length) ? line.words : _mCinePseudoWords(line.txt);
  // hero 要在抖动之前定：抖动那个循环每词消费 4 个随机数，
  // 放后面挑的话 rnd 已经被推走了，同一句每次算出的 hero 会不一样
  const hero = _mCineHero(ws, rnd);
  return ws.map((w, i) => {
    // 四个随机数**无条件先取满**，即使这个词是空白、四个值一个都用不上。
    // 这样每个词消费的随机数个数是固定的，第 i 个词拿到的永远是序列里第 4i~4i+3 个。
    // 放进 if 里也不会让同一句变得不确定（同样的输入还是同样的输出），
    // 但换成"少一个空格"的另一句时，后面所有词的随机数会整体错位——
    // 改个标点整句排版就全变样，调起来毫无头绪。
    const a = rnd(), b = rnd(), c = rnd(), d = rnd();
    const blank = /^\s*$/.test(w.txt);   // 空格不抖也不转，否则词距会被转歪
    return {
      txt: w.txt,
      hero: i === hero,
      dy:  blank ? 0 : +((a - 0.5) * 0.34).toFixed(3),
      // hero 直接吃 cadenza 的 1.46，不跟普通词那档叠加——叠了之后
      // 运气差的时候 hero 反而比旁边的词小，"主角"就白设了
      sc:  blank ? 1 : (i === hero ? 1.46 : +(0.84 + b * 0.34).toFixed(3)),
      rot: blank ? 0 : +((c - 0.5) * (i === hero ? 3.4 : 6)).toFixed(2),
      // 往左压一点，压出图里那种字挨着字的挤压感。首词不压，不然整句左边缺一块
      ov:  (blank || i === 0) ? 0 : +(d * 0.16).toFixed(3),
    };
  });
}
function _mCineOn() { return musicLyricStyleNorm(state.musicLyricStyle) === 'cinema'; }

// 容器宽度或字号变了之后重算一次镜头。
// 不补这个的话：进/退全屏会同时换掉容器宽度和字号，而当前字没变
// （cur === _mWordCur），_mSyncWords 里那个跟随分支根本不会进——
// 旧尺寸算出来的 translateX 就一直挂着，当前字可能停在画面外。
// 暂停时尤其明显：那会儿 rAF 和 timeupdate 都停了，没有任何东西会来纠正它。
function _mCineRemeasure() {
  if (!_mCineOn() || !_mLyric || _mLyric.idx < 0) return;
  const el = document.getElementById('mLy' + _mLyric.idx);
  if (!el) return;
  _mCineFollow(el, el.getElementsByClassName('ly-w'), _mLyric.wbw ? _mWordCur : -1);
}
// resize 会连着来一串，节流一下；orientationchange 走的也是 resize
var _mCineRsz = 0;
window.addEventListener('resize', () => {
  clearTimeout(_mCineRsz);
  _mCineRsz = setTimeout(_mCineRemeasure, 180);
});

// 镜头跟随：让正在唱的字停在容器偏左 38% 处。只在切字那一刻调，不进每帧路径。
// cur < 0 表示"这行没有当前字"（行级歌词），这时只负责把句子摆正。
function _mCineFollow(lineEl, spans, cur) {
  const box = document.getElementById('musicLyric');
  const main = lineEl && lineEl.querySelector('.ly-main');
  if (!box || !main) return;
  const mr = main.getBoundingClientRect(), cw = box.clientWidth;
  const over = mr.width - cw;
  // 放得下（over ≤ 0）就居中；只溢出一点点（不到一成）就两头各让一半。
  // 两种情况用的是同一个式子，负的 over 自然算出正的位移。
  // **不能图省事写成清空 transform**：.ly-main 是 max-content 且左对齐（左对齐是
  // _mCineFollow 的 clamp 前提，不能改），清掉之后短句会缩在最左边，
  // hero 和当前字都不在画面中间——常见的两三个词的短句全中招。
  // 推的话为了露出句尾那几个字母，句首整个字会被挤出画面——
  // 丢一个词首字母的代价比露出句尾大得多。
  if (over < cw * 0.12) { main.style.transform = `translateX(${(-over / 2).toFixed(1)}px)`; return; }
  // 长句但没有当前字可跟：先把句首摆进画面
  if (cur < 0 || cur >= spans.length) { main.style.transform = 'translateX(0px)'; return; }
  const sr = spans[cur].getBoundingClientRect();
  // 两个 rect 都在同一个 translateX 下，相减正好抵消掉当前位移，得到句内偏移
  const center = sr.left + sr.width / 2 - mr.left;
  // clamp：句首/句尾不许被推出画面
  const dx = Math.min(0, Math.max(cw - mr.width, cw * 0.38 - center));
  main.style.transform = `translateX(${dx.toFixed(1)}px)`;
}

// 点时间戳跳到那一句；长按一行把它复制走（网易云那套）。
// **必须是委托**：_mPaintLyric 每次都把 box.innerHTML 整片重写（切译文、切模式、
// 暂停继续都会重画），挂在行上的 handler 会跟着 DOM 一起没，所以只在 box 上挂一次。
var _mLyHold = null;
function _mLySeekTo(sec) {
  const a = _mAudio;
  if (!a || !isFinite(sec)) return;
  if (isFinite(a.duration) && a.duration > 0) sec = Math.max(0, Math.min(a.duration - 0.05, sec));
  a.currentTime = sec;
  // 进度条和「已播」时间不会自己跟上来（timeupdate 最快也要 250ms 才来一次，
  // 中间这段时间条子停在原处，点下去像没反应），所以照 _mSeekAt 那样当场写一遍。
  if (isFinite(a.duration) && a.duration > 0) {
    const pct = sec / a.duration * 100;
    document.querySelectorAll('.music-fill').forEach(f => { f.style.width = pct + '%'; });
  }
  document.querySelectorAll('.music-t-cur').forEach(t => { t.textContent = _mFmt(sec); });
  // 跳完必须强行重算当前行：_mSyncLyricLine 认「行号没变就 return」，
  // 而往回跳到同一句时行号真的没变 —— 不清掉 idx 的话逐字点亮会停在跳转前的位置。
  if (_mLyric) { _mLyric.idx = -1; _mWordCur = -1; }
  _mSyncLyricLine(sec);
  _mSyncWords(sec);
  _mTick();
}
function _mLyCancelHold() {
  if (!_mLyHold) return;
  clearTimeout(_mLyHold.timer);
  if (_mLyHold.el) _mLyHold.el.classList.remove('ly-holding');
  _mLyHold = null;
}
// 手指那侧的「悬停」。触屏没有 hover，CSS 那边的 :hover 一条都不会亮，
// 所以手一碰歌词区就整片浮出跳转角标，停手 2.2s 自己撤掉。
// **不能听 scroll 事件**：_mSyncLyricLine 每切一行都会 box.scrollTo 自动跟随，
// 那也是 scroll —— 挂在 scroll 上等于播着播着角标自己一直亮，又变回"跟播放位置走"了。
function _mLyScrub(box) {
  box.classList.add('ly-scrub');
  clearTimeout(box._lyScrubT);
  box._lyScrubT = setTimeout(() => box.classList.remove('ly-scrub'), 2200);
}
function _mLyBind(box) {
  if (box._lyBound) return;
  box._lyBound = 1;
  // 框的宽高变了（抽屉开合/拉宽、窗口缩放），长句重新折行，当前句会漂走，拉回来
  // 影院模式（只在全屏）当前句是按框宽算的平移，_mLyReanchor 不管它；全屏里开合抽屉也会改框宽，一起重测
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { _mLyReanchor(); _mCineRemeasure(); }).observe(box);
  box.addEventListener('pointerdown', ev => {
    // 鼠标交给 CSS :hover，只有触摸/手写笔需要这个
    if (ev.pointerType !== 'mouse') _mLyScrub(box);
    const line = ev.target.closest && ev.target.closest('.music-ly-line');
    if (!line) return;
    const t = parseFloat(line.dataset.t);
    // 点在时间戳上＝跳转，且不进长按判定（不然点一下要么跳要么复制，看运气）
    if (ev.target.closest('.ly-t')) {
      ev.preventDefault();
      _mLyCancelHold();
      _mLySeekTo(t);
      return;
    }
    _mLyCancelHold();
    const i = +(line.id || '').replace('mLy', '');
    // 选择模式里：点一下＝勾上/取消这句（抬手时才算，滑动不算）
    if (_mLySel) { _mLyHold = { el: line, t, i, x: ev.clientX, y: ev.clientY, id: ev.pointerId, sel: true, timer: 0 }; return; }
    // 长按＝进选择模式，按住的这句先勾上（用户：「手机端希望支持逐条选择复制歌词，也可以复制所有歌词或者所有译文」）
    _mLyHold = { el: line, t, x: ev.clientX, y: ev.clientY, id: ev.pointerId, timer: setTimeout(() => {
      _mLyCancelHold();
      try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
      _mLySelStart(i);
    }, 520) };
    line.classList.add('ly-holding');
  });
  // 手指一挪就认成滚动，别在滑歌词的时候偷偷复制
  box.addEventListener('pointermove', ev => {
    if (ev.pointerType !== 'mouse' && ev.buttons) _mLyScrub(box);   // 滑歌词的整个过程都算"手指在上面"
    if (!_mLyHold || _mLyHold.id !== ev.pointerId) return;
    if (Math.abs(ev.clientX - _mLyHold.x) > 8 || Math.abs(ev.clientY - _mLyHold.y) > 8) _mLyCancelHold();
  });
  // 短按整行**不跳**（用户：「歌词出现容易误点」）。整行都能跳的时候，
  // 想点一下切沉浸、想扫一眼歌词、手滑碰一下，播放头都会被挪走。跳转只认时间戳和 ▸ 那个角标。
  box.addEventListener('pointerup', ev => {
    const h = _mLyHold;
    if (h && h.sel && h.id === ev.pointerId && _mLySel) _mLySelToggle(h.i);
    _mLyCancelHold();
  });
  box.addEventListener('pointercancel', _mLyCancelHold);
  box.addEventListener('scroll', _mLyCancelHold);
}

// ── 歌词选择模式：长按一句进来，点句子勾选，底下一条按钮复制 ──
// 「复制所选」照屏幕上看到的来：开着罗马音/翻译就连同它们一起（每句的副行紧跟在原文下面）。
// 「全部歌词」只要原文、「全部译文」只要翻译，一行一句。换歌（_mLyric 换了一份）自动退出。
var _mLySel = null;   // { L: 进来时的那份 _mLyric, picked: Set<行号> }
function _mLySelStart(i) {
  if (!_mLyric) return;
  _mLySel = { L: _mLyric, picked: new Set(i >= 0 ? [i] : []) };
  _mLySelPaint();
}
function _mLySelToggle(i) {
  if (!_mLySel || !(i >= 0)) return;
  if (_mLySel.picked.has(i)) _mLySel.picked.delete(i); else _mLySel.picked.add(i);
  _mLySelPaint();
}
function _mLySelEnd() { _mLySel = null; _mLySelPaint(); }
function _mLySelPaint() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  if (_mLySel && _mLySel.L !== _mLyric) _mLySel = null;
  const box = document.getElementById('musicLyric');
  if (box) {
    box.classList.toggle('ly-sel', !!_mLySel);
    box.querySelectorAll('.music-ly-line').forEach(el => el.classList.toggle('ly-picked', !!_mLySel && _mLySel.picked.has(+(el.id || '').replace('mLy', ''))));
  }
  let bar = document.getElementById('mzLySel');
  if (!_mLySel) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mzLySel';
    bar.className = 'mz-lysel';
    (document.getElementById('musicModal') || document.body).appendChild(bar);
  }
  const L = _mLyric.lines, n = _mLySel.picked.size;
  const b = (fn, txt, cls) => `<button type="button" class="${cls || ''}" onclick="${fn}">${txt}</button>`;
  bar.innerHTML = `<span class="mz-lysel-n">${n ? `已选 ${n} 句` : '点句子来选'}</span>`
    + (n ? b("_mLyCopy('sel')", '复制所选', 'on') : '')
    + b("_mLyCopy('all')", '全部歌词')
    + (L.some(l => l.tr) ? b("_mLyCopy('tr')", '全部译文') : '')
    + (L.some(l => l.ro) ? b("_mLyCopy('ro')", '全部罗马音') : '')
    + b('_mLySelEnd()', '✕', 'x');
}
function _mLyCopyText(kind) {
  const L = (_mLyric && _mLyric.lines) || [];
  if (kind === 'all') return L.map(l => l.txt).filter(Boolean).join('\n');
  if (kind === 'tr' || kind === 'ro') return L.map(l => l[kind]).filter(Boolean).join('\n');
  if (!_mLySel) return '';
  const showTr = _mOptOn('musicLyricTrans', true), showRo = _mOptOn('musicLyricRoma', false);
  return [..._mLySel.picked].sort((a, b) => a - b).map(i => L[i]).filter(Boolean)
    .map(l => [l.txt, showRo && l.ro, showTr && l.tr].filter(Boolean).join('\n')).join('\n');
}
function _mLyCopy(kind) {
  const txt = _mLyCopyText(kind);
  if (!txt) { showToast('没有可复制的', 'info', 1600); return; }
  const what = { sel: '选中的歌词', all: '全部歌词', tr: '全部译文', ro: '全部罗马音' }[kind] || '歌词';
  copyTextCompat(txt).then(() => { showToast(what + '已复制', 'success', 1600); _mLySelEnd(); })
    .catch(() => showToast('复制失败', 'error', 1600));
}

// 歌词角上的「音」「译」（用户：日语歌要能一下切罗马音/翻译，不用钻进 ⋮）。
// 这首真有罗马音才出「音」、真有翻译才出「译」——中文歌两个都不出，不占地方。
// 开关还是 ⋮ 里那两个设置（musicLyricRoma / musicLyricTrans），两处改的是同一份。
// 用 <button>：歌词区单击＝沉浸开关（_mTapIgnored 放过按钮），不然点一下「译」屏幕会跟着切全屏。
function _mPaintLyOpts(showRo, showTr) {
  const el = document.getElementById('mzLyOpts');
  if (!el) return;
  const L = _mLyric && _mLyric.lines || [];
  const hasRo = L.some(l => l.ro), hasTr = L.some(l => l.tr);
  const chip = (on, key, def, txt, tip) =>
    `<button type="button" class="mz-ly-opt${on ? ' on' : ''}" onclick="musicToggleLyricOpt('${key}',${def})" title="${tip}（点一下${on ? '收起' : '显示'}）" aria-pressed="${on}">${txt}</button>`;
  el.innerHTML = (hasRo ? chip(showRo, 'musicLyricRoma', false, '音', '罗马音') : '')
    + (hasTr ? chip(showTr, 'musicLyricTrans', true, '译', '翻译') : '');
}

function _mPaintLyric() {
  const box = document.getElementById('musicLyric');
  if (!box) return;
  _mLyBind(box);
  const showTr = _mOptOn('musicLyricTrans', true);
  const showRo = _mOptOn('musicLyricRoma', false);
  _mPaintLyOpts(showRo, showTr);
  if (!_mLyric) {
    box.innerHTML = _mLyIsPure()
      ? `<div class="music-ly-none ly-pure">本曲已被猫咪啃掉歌词(=^. .^=)∫</div>`
      : `<div class="music-ly-none">没有歌词</div>`;
    if (_mLySel) _mLySelPaint();
    return;
  }
  const style  = musicLyricStyleNorm(state.musicLyricStyle);
  const tiltOn = style === 'tilt';
  const cineOn = style === 'cinema';
  // 逐字：每个字一个 span，点亮进度交给 CSS 变量 --p（0~1）。
  // data-c 是给 ::after 的 content 用的——裁一层同样的字盖在上面，
  // 比按字宽算渐变位置稳，换字体、换字号都不用重新测量。
  const spanOf = w => `<span class="ly-w" data-c="${escHtml(w.txt)}">${escHtml(w.txt)}</span>`;
  box.innerHTML = _mLyric.lines.map((l, i) => {
    let main;
    if (cineOn) {
      // 种子同 tilt：同一首歌每次进来排版一致，不然每开一次面板整篇重排像 bug
      main = _mCineJit(l, Math.round((l.t || 0) * 1000) + i * 7919).map(j =>
        `<span class="ly-w${j.hero ? ' ly-hero' : ''}" data-c="${escHtml(j.txt)}"`
        + ` style="--dy:${j.dy}em;--sc:${j.sc};--rot:${j.rot}deg;--ov:${j.ov}em"`
        + `>${escHtml(j.txt)}</span>`).join('');
    } else if (tiltOn) {
      // 种子用行的起始时间，同一首歌每次进来排版一样——用 Math.random 的话
      // 每次开面板整篇重排，看着像 bug
      const segs = _mTiltSplit(l, Math.round((l.t || 0) * 1000) + i * 7919);
      main = segs.map(s =>
        `<div class="ly-seg${s.tilt ? ' ly-seg-tilt' : ''}${_mTiltItalic(s) ? ' ly-seg-it' : ''}" style="--ind:${s.ind.toFixed(3)};--rot:${s.rot.toFixed(2)}deg">`
        + (s.words.length ? s.words.map(spanOf).join('') : escHtml(s.txt))
        + `</div>`).join('');
    } else {
      main = l.words.length ? l.words.map(spanOf).join('') : escHtml(l.txt);
    }
    // 时间戳走 data-t（秒，带两位小数），点它跳转、长按整行复制都靠它。
    // cinema 是绝对定位居中的沉浸模式，塞一个角标进去会把版面顶歪 —— 那个模式不挂。
    return `<div class="music-ly-line${i === _mLyric.idx ? ' on' : ''}" id="mLy${i}" data-t="${(l.t || 0).toFixed(2)}">`
      + (cineOn ? '' : `<i class="ly-t" title="从这句开始播（${_mFmt(l.t)}）"><b>▸</b>${_mFmt(l.t)}</i>`)
      + `<div class="ly-main">${main}</div>`
      + (showRo && l.ro ? `<div class="ly-ro">${escHtml(l.ro)}</div>` : '')
      + (showTr && l.tr ? `<div class="ly-tr">${escHtml(l.tr)}</div>` : '')
      + `</div>`;
  }).join('');
  box.classList.toggle('ly-tilt', tiltOn);
  box.classList.toggle('ly-cine', cineOn);
  // cinema 把整句压暗、靠逐字点亮层提亮。**没有逐字时轴的歌不能压暗**：
  // 那些歌的 --p 永远是 0，点亮层一次都不显示，整句会一直停在 36% 灰
  // （普通 LRC 是大多数歌，压暗等于这个模式在它们身上是坏的）。
  box.classList.toggle('ly-wbw', cineOn && !!_mLyric.wbw);
  if (cineOn) box.scrollTop = 0;      // 从滚动模式切过来时把残留的 scrollTop 清掉
  _mWordCur = -1;
  // 重绘会把 .ly-main 上的 inline transform 一起丢掉，必须重新量一次。
  // 逐字歌词靠上面那句 _mWordCur = -1 就够了（下一次 _mSyncWords 必定重算跟随），
  // **行级歌词没有这条路**：_mSyncWords 对非 wbw 直接 return，而 _mSyncLyricLine
  // 又会因为行号没变而提前 return。不补这一下，切"译/A"或暂停继续引发的重绘
  // 会让居中的短句重新贴回最左边。
  if (cineOn && !_mLyric.wbw) _mCineRemeasure();
  if (_mLySel) _mLySelPaint();   // 重画把勾选的样子冲掉了，补回来（换了歌就顺带退出选择）
  _mLyReanchor();
}

// 逐字推进。timeupdate 一秒只来 4 次，靠它点字会一顿一顿的，
// 所以逐字这一层单独挂 rAF；行切换仍然两条路都会调，谁先到算谁。
var _mRaf = 0;
function _mLyricLoopSync() {
  const a = _mAudio;
  const on = !!(a && !a.paused && _mLyric && _mLyric.wbw && _mLyricVisible());
  if (on && !_mRaf) _mRaf = requestAnimationFrame(_mLyricFrame);
  if (!on && _mRaf) { cancelAnimationFrame(_mRaf); _mRaf = 0; }
}
function _mLyricVisible() {
  const m = document.getElementById('musicModal');
  return !!(m && !m.classList.contains('hidden'));
}
function _mLyricFrame() {
  _mRaf = 0;
  const a = _mAudio;
  if (!a) return;
  _mSyncLyricLine(a.currentTime);
  _mSyncWords(a.currentTime);
  _mLyricLoopSync();
}

// 当前是第几行。行级和逐字共用。
function _mSyncLyricLine(time) {
  if (!_mLyric) return;
  let i = -1;
  for (let k = 0; k < _mLyric.lines.length; k++) { if (_mLyric.lines[k].t <= time) i = k; else break; }
  if (i === _mLyric.idx) return;
  _mLyric.idx = i;
  _mWordCur = -1;
  const box = document.getElementById('musicLyric');
  if (!box) return;
  box.querySelectorAll('.music-ly-line.on').forEach(el => el.classList.remove('on'));
  const cur = document.getElementById('mLy' + i);
  if (!cur) return;
  cur.classList.add('on');
  if (_mCineOn()) {
    // cinema 的行是 absolute + top:50% 自己居中的，不需要滚，滚了反而会把它推出画面：
    // .music-lyric 是 position:relative，absolute 子元素照样算进它的滚动区，
    // 所以 overflow:hidden 也拦不住这个 scrollTo。切模式时残留的 scrollTop 一并清掉。
    box.scrollTop = 0;
    // 没有逐字时轴时 _mSyncWords 会直接 return，镜头一次都不会动 ——
    // 新的一句会顶着上一句留下的位移显示。所以行级歌词在切行这里补一次归位：
    // 短句居中、长句把句首摆进画面。**只保证句首**——没有字级时间就无从跟随，
    // 长句的句尾在行级歌词下确实看不到，这是取舍不是遗漏。
    if (!_mLyric.wbw) _mCineFollow(cur, cur.getElementsByClassName('ly-w'), -1);
  } else {
    _mLyAnchor(box, cur, 'smooth');
  }
  if (typeof _mVisPulse === 'function') _mVisPulse();
}
// 当前句停在歌词框的哪个高度：默认正中；用户的稿子（手机）是当前句在上、下一句跟在下面，
// 由 CSS 变量 --ly-anchor 给（0 = 顶，0.5 = 中）。切行/重画/改尺寸才读一次，不在每帧路径上。
function _mLyAnchor(box, cur, behavior) {
  let k = NaN;
  try { k = parseFloat(getComputedStyle(box).getPropertyValue('--ly-anchor')); } catch (e) {}
  const anchor = isFinite(k) ? k : 0.5;
  box.scrollTo({ top: cur.offsetTop - (box.clientHeight - cur.offsetHeight) * anchor, behavior });
}
// 行号没变、但当前句不在该在的位置了——重画（innerHTML 把 scrollTop 归零）或者框变宽变窄（行重新折）。
// _mSyncLyricLine 认「行号没变就 return」，不补这一下当前句会一直待在框外，直到唱到下一句；暂停着就永远在外面
// （用户「看不到歌词」：窄窗口开抽屉、切页签都会这样）。
function _mLyReanchor() {
  if (!_mLyric || _mLyric.idx < 0 || _mCineOn()) return;
  const box = document.getElementById('musicLyric');
  const cur = box && document.getElementById('mLy' + _mLyric.idx);
  if (cur) _mLyAnchor(box, cur, 'instant');
}

// 行内点字。每帧只写"正在唱的那一个"字，切字的时候才把前后批量归位——
// 每帧刷全行 span 的话，一句 30 个字就是每秒 1800 次样式写入。
function _mSyncWords(time) {
  if (!_mLyric || !_mLyric.wbw || _mLyric.idx < 0) return;
  const line = _mLyric.lines[_mLyric.idx];
  if (!line || !line.words.length) return;
  const el = document.getElementById('mLy' + _mLyric.idx);
  if (!el) return;
  const spans = el.getElementsByClassName('ly-w');
  if (!spans.length) return;
  let cur = -1;
  for (let k = 0; k < line.words.length; k++) { if (line.words[k].t <= time) cur = k; else break; }
  if (cur !== _mWordCur) {
    for (let k = 0; k < spans.length; k++) {
      spans[k].style.setProperty('--p', k < cur ? '1' : '0');
      // Luminous 字效（抄自 folia 的 classic）：正在唱的字放大发光冒涟漪，
      // 唱过的留一层余晖。只在切字那一刻动 class，不进每帧路径。
      spans[k].classList.toggle('ly-now', k === cur);
      spans[k].classList.toggle('ly-done', k < cur);
    }
    _mWordCur = cur;
    // 跟随读 rect 会强制 layout，所以只挂在切字这个分支里；
    // 每帧路径（下面那个 --p）碰都不碰它
    if (_mCineOn()) _mCineFollow(el, spans, cur);
  }
  if (cur >= 0 && cur < spans.length) {
    const w = line.words[cur];
    const p = Math.max(0, Math.min(1, (time - w.t) / Math.max(.001, w.end - w.t)));
    spans[cur].style.setProperty('--p', p.toFixed(3));
  }
}

// ── 每帧刷新（只改必要的几个节点，不整块重画）──
// 整块重画的话，正在拖进度条的手指会被打断，小组件里的搜索框也会被清空。
function _mTick() {
  const a = _mAudio; if (!a) return;
  const pct = a.duration ? (a.currentTime / a.duration * 100) : 0;
  document.querySelectorAll('.music-fill').forEach(el => { el.style.width = pct + '%'; });
  document.querySelectorAll('.music-t-cur').forEach(el => { el.textContent = _mFmt(a.currentTime); });
  document.querySelectorAll('.music-t-dur').forEach(el => { el.textContent = _mFmt(a.duration); });
  if (_mLyric) {
    _mSyncLyricLine(a.currentTime);
    _mSyncWords(a.currentTime);   // 拖进度条之后要立刻把这一行的字归位，不能等下一帧
  }
  _mDockLyric();
  _mLyricLoopSync();
}

// 播放状态变了：卡片上的 ▶/⏸ 和小组件面板都要跟上
function _mPaint() {
  const playing = !!(_mAudio && !_mAudio.paused && _mNow);
  document.querySelectorAll('.music-card').forEach(el => {
    const on = _mNow && el.dataset.songId === String(_mNow.id);
    el.classList.toggle('music-card-on', !!on);
    const btn = el.querySelector('.music-play');
    if (btn) btn.textContent = (on && playing) ? '⏸' : '▶';
    if (!on) {
      const f = el.querySelector('.music-fill'); if (f) f.style.width = '0%';
    }
  });
  if (typeof musicRefresh === 'function') musicRefresh();
  _mLyricLoopSync();   // 暂停要把 rAF 停掉，不然后台一直空转
  _mVisSync();
  _mScopeSync();
}

// ============================================================
// 沉浸背景（封面取色 + 流光）
//
// 只在全屏歌词里跑。**没有接 Web Audio 的频谱**，这是故意的：
// 网易云的音频是从它自己的 CDN 拉的跨域资源，一旦把 <audio> 接进
// MediaElementAudioSourceNode，浏览器认定拿不到 CORS 许可就会让整条链路
// 输出静音——歌照放、进度条照走、控制台一声不吭，人只觉得"突然没声了"。
// 拿封面主色 + 歌词节奏驱动的程序化流光，效果够用，且不拿播放去赌。
// ============================================================
var _mTint = null;          // 封面主色（已压暗），[[r,g,b], ...]
var _mVisRaf = 0;
var _mVisPulseAt = -1e9;
var _mVisLast = 0;

// 封面取色。网易云图床带 Access-Control-Allow-Origin: *，所以能直接读像素；
// 万一哪天不带了，getImageData 会抛 SecurityError——兜住就好，回落到主题色。
var _mTintReq = 0;
function _mCoverTint(url) {
  const seq = ++_mTintReq;   // 同 musicLoadLyric：慢封面回来不许盖掉新歌的颜色
  _mTint = null;
  if (!url) { _mApplyTint(); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (seq !== _mTintReq) return;
    try {
      const n = 24, cv = document.createElement('canvas');
      cv.width = cv.height = n;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, n, n);
      const d = cx.getImageData(0, 0, n, n).data;
      // 量化到 4×4×4 的色格里投票。按饱和度加权——不加权的话
      // 封面四角的黑边和白底会稳赢，每首歌的背景都是同一坨灰。
      const bin = {};
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx ? (mx - mn) / mx : 0;
        if (mx < 24) continue;                       // 纯黑不参与
        const k = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
        const w = 0.15 + sat * sat * 2.4;
        (bin[k] || (bin[k] = [0, 0, 0, 0]));
        bin[k][0] += r * w; bin[k][1] += g * w; bin[k][2] += b * w; bin[k][3] += w;
      }
      const top = Object.values(bin).sort((a, b) => b[3] - a[3]).slice(0, 3)
        .map(v => [v[0] / v[3], v[1] / v[3], v[2] / v[3]]);
      _mTint = top.length ? top.map(_mDeepen) : null;
    } catch (e) { _mTint = null; }   // 跨域被拒：不是错误，换主题色接着走
    _mApplyTint();
  };
  img.onerror = () => { if (seq !== _mTintReq) return; _mTint = null; _mApplyTint(); };
  img.src = url;
}

// 统一压暗提纯：沉浸背景必须是深的，直接用封面原色会出现大片高亮，
// 白底封面能把整块屏幕刷成灰白，歌词直接看不见。
function _mDeepen(rgb) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  const k = Math.min(1, 150 / mx);                     // 先把最亮的通道压到 150
  return rgb.map(v => Math.round(v * k * 0.72));
}
function _mCss(rgb, a) { return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`; }

// 主色也给 CSS 用一份：歌词高亮的辉光跟着封面走
function _mApplyTint() {
  const m = document.getElementById('musicModal');
  if (!m) return;
  if (_mTint && _mTint.length) {
    const lit = _mTint[0].map(v => Math.min(255, Math.round(v * 1.9 + 40)));
    m.style.setProperty('--ly-glow', _mCss(lit, .55));
  } else {
    m.style.removeProperty('--ly-glow');
  }
}

function _mVisPulse() { _mVisPulseAt = performance.now(); }

function _mVisSync() {
  const m = document.getElementById('musicModal');
  const live = !!(m && !m.classList.contains('hidden')
    && m.classList.contains('music-lyrics-full')
    && state.musicVis !== 'off' && _mNow);
  // 两套底不是一个东西：流光/几何是 canvas 每帧画的，封面流体是一叠静态 <img>。
  // 同一时刻只亮一层，另一层连 rAF 都不该起。
  const cv = document.getElementById('musicVis');
  const fl = document.getElementById('musicFluid');
  const canvasOn = live && state.musicVis !== 'fluid';
  const fluidOn = live && state.musicVis === 'fluid';
  if (cv) cv.classList.toggle('on', canvasOn);
  if (fl) fl.classList.toggle('on', fluidOn);
  // 只在真要用的时候才去解码封面：不用的模式不该为它付这份成本。
  // _mFluidSet 自己幂等，所以这里被反复调用是安全的。
  if (fluidOn) _mFluidSet(_mNow && _mNow.cover);
  if (canvasOn && !_mVisRaf) _mVisRaf = requestAnimationFrame(_mVisFrame);
  if (!canvasOn && _mVisRaf) { cancelAnimationFrame(_mVisRaf); _mVisRaf = 0; }
}

// ── 封面流体背景 ──
// 把封面糊成一大团颜色垫在歌词底下，换歌时两张封面交叉淡入。
// 抄自 folia-major 的 FluidBackground，连它踩过的两个坑一起抄：
//
// 1. **模糊源必须先缩小**。blur(40px) 已经把比 40px 细的细节全抹掉了，
//    所以拿 384px 的缩略图去糊，和拿 3000px 原图去糊，肉眼看不出区别。
//    区别在 GPU：大图第一次合成时纹理是**分块上传**的，每块落地闪一下——
//    那就是大封面才会出现、小封面永远没有的"栅格闪烁"。384px 单块传完，没有。
// 2. **淡入要动外层 div 的 opacity，不能动带 blur 的 <img>**。
//    直接给模糊层做透明度动画，浏览器每帧都要重新光栅化那个 blur，又闪又卡。
//    让模糊烘在静态 img 上不动，只让外面那层廉价的合成层淡入。
var _mFluidUrl = null;
var _mFluidReq = 0;
function _mFluidSet(url) {
  const box = document.getElementById('musicFluid');
  if (!box) return;
  url = url || null;
  if (url === _mFluidUrl) return;      // 幂等：同一张封面不许重复堆层
  _mFluidUrl = url;
  const seq = ++_mFluidReq;
  if (!url) { box.innerHTML = ''; return; }

  _mDownscale(url, 384).then(small => {
    if (seq !== _mFluidReq) return;    // 慢封面回来不许盖掉新歌，同 _mCoverTint
    const wrap = document.createElement('div');
    wrap.className = 'music-fluid-layer';
    const img = new Image();
    img.className = 'music-fluid-img';
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    // 一张坏掉的层（封面 404、对象 URL 已回收）自己退场。
    // **不能**写成"还有别的层才退"：留一个永远画不出东西的空层在那，
    // 下面 reveal 的修剪逻辑会以它为基准去删别人，越修越乱。
    img.onerror = () => {
      wrap.remove();
      // 这一趟废了。不把 _mFluidUrl 清掉的话，幂等判断会一直认为"这张已经挂上了"，
      // 同一首歌从此再也不会重试——背景就空在那里，零报错。
      if (seq === _mFluidReq) _mFluidUrl = null;
    };
    wrap.appendChild(img);
    box.appendChild(wrap);
    // small 为 null = 跨域没给 CORS 头，canvas 被污染读不出来。回落原图：
    // 糊还是照样能糊（CSS filter 不受污染限制），只是少了防闪烁那层保险。
    img.src = small || url;

    const reveal = () => {
      // 已经被后来的换歌取代：连自己这层一起撤走，别让旧封面淡进来
      if (seq !== _mFluidReq) { wrap.remove(); return; }
      // 先让浏览器把这一帧合成掉（此时还是全透明），再淡入一张已经画好的图
      requestAnimationFrame(() => {
        // 代际必须在 rAF 回调里**再查一次**：上面那次检查到这一帧之间隔着整整一帧，
        // 用户在这个窗口里换了歌的话，旧封面照样会淡进来盖住新的。
        if (seq !== _mFluidReq) { wrap.remove(); return; }
        // 自己已经被 onerror 摘掉了就别再往下走：下面那个 while 的终止条件是
        // "删到 wrap 为止"，wrap 不在里面就会一路删空，把仅剩的好层也删掉。
        if (wrap.parentNode !== box) return;
        wrap.classList.add('on');
        setTimeout(() => {
          if (seq !== _mFluidReq || wrap.parentNode !== box) return;
          while (box.firstChild && box.firstChild !== wrap) box.removeChild(box.firstChild);
        }, 1600);
      });
    };
    // decode 失败也照样显示——宁可闪一下，也不能卡在黑屏
    if (img.decode) img.decode().then(reveal, reveal);
    else { img.onload = reveal; setTimeout(reveal, 1500); }
  });
}

// 把图缩到最长边 max 以内，返回 dataURL；跨域拿不到像素就返回 null 让调用方回落
function _mDownscale(url, max) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
        if (!nw || !nh) return resolve(null);
        const k = Math.min(1, max / Math.max(nw, nh));
        const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        if (!cx) return resolve(null);
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function _mVisFrame(ts) {
  _mVisRaf = 0;
  const cv = document.getElementById('musicVis');
  if (!cv) return;
  // 30fps 就够——这是一层慢速流动的底色，不是动作游戏。
  if (ts - _mVisLast >= 32) { _mVisLast = ts; _mVisDraw(cv, ts); }
  _mVisSync();
}

function _mVisDraw(cv, ts) {
  const geo = state.musicVis === 'geo';
  // 按低分辨率画再让 CSS 放大：放大产生的插值就是免费的模糊，比每帧 blur 滤镜便宜得多。
  // 但几何模式要看得出边，糊到 1/3 就只剩一团光斑了，所以只降到 1/2。
  const q = geo ? 2 : 3;
  const w = Math.max(1, Math.round(cv.clientWidth / q));
  const h = Math.max(1, Math.round(cv.clientHeight / q));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const cx = cv.getContext('2d');
  cx.globalCompositeOperation = 'source-over';
  cx.fillStyle = '#07070b';
  cx.fillRect(0, 0, w, h);

  const cols = _mTint && _mTint.length ? _mTint : [[52, 44, 96], [28, 60, 88], [78, 38, 70]];
  const t = ts / 1000;
  // 切歌词行时鼓一下，320ms 内衰减回去——让背景跟着唱，而不是自己转自己的
  const pulse = Math.max(0, 1 - (ts - _mVisPulseAt) / 320);
  if (geo) _mVisDrawGeo(cx, w, h, cols, t, pulse);
  else _mVisDrawAurora(cx, w, h, cols, t, pulse);
}

function _mVisDrawAurora(cx, w, h, cols, t, pulse) {
  const boost = 1 + pulse * pulse * 0.28;
  cx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const c = cols[i % cols.length];
    const sp = 0.09 + i * 0.031;                       // 每团自己的漂移速度，避免整体同步摆动
    const x = w * (0.5 + 0.36 * Math.sin(t * sp + i * 2.1));
    const y = h * (0.5 + 0.32 * Math.cos(t * sp * 1.31 + i * 1.7));
    const r = Math.min(w, h) * (0.52 + 0.12 * Math.sin(t * 0.21 + i)) * boost;
    const g = cx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, _mCss(c, 0.5));
    g.addColorStop(0.55, _mCss(c, 0.16));
    g.addColorStop(1, _mCss(c, 0));
    cx.fillStyle = g;
    cx.beginPath();
    cx.arc(x, y, r, 0, 6.2832);
    cx.fill();
  }
}

// ── 几何背景 ──
// 抄自 folia-major 的 GeometricBackground：一层缓慢漂移旋转的线框图形。
// 图案由歌曲 id 播种，所以同一首歌每次进来长得一样，换首歌就换一套——
// 用 Math.random 的话每次刷新面板图形全变，看着像 bug。
var _mGeoShapes = null;
var _mGeoSeed = null;
function _mSeedRand(seed) {
  let s = (seed >>> 0) || 1;
  // 先把种子雪崩打散再进 LCG。**不打散不行**：LCG 对相邻种子的第一个输出
  // 几乎是线性的（种子差 1，输出只差 1664525/2^32 ≈ 0.0004），而这里每个
  // 用法都恰好只取前几个数——歌词按行起始时间播种、几何按歌 id 播种，
  // 结果就是"随机"段数永远算出同一个值（实测 32 字长句 200 个种子全是 2 段，
  // 1/3/4 段一次都没出现过）。零报错，只是效果永远单调。
  s = Math.imul(s ^ (s >>> 16), 2246822507) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  // 乘法用 Math.imul：s 最大接近 2^32，直接 * 1664525 会超出 2^53 丢精度
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function _mGeoBuild(seed) {
  const rnd = _mSeedRand(seed);
  const kinds = ['circle', 'square', 'tri', 'cross'];
  const out = [];
  for (let i = 0; i < 14; i++) {
    out.push({
      k: kinds[Math.floor(rnd() * kinds.length)],
      x: rnd(), y: rnd(),
      r: 0.04 + rnd() * 0.11,          // 归一化半径，画的时候乘短边——换窗口大小不用重建
      sp: 0.05 + rnd() * 0.13,
      ph: rnd() * 6.2832,              // 各自的相位，否则整片同步摆动像一块布
      spin: (rnd() - 0.5) * 0.5,
      a: 0.16 + rnd() * 0.3,
      c: Math.floor(rnd() * 3),
      fill: rnd() < 0.35,
    });
  }
  return out;
}
function _mVisDrawGeo(cx, w, h, cols, t, pulse) {
  const seed = _mNow
    ? String(_mNow.id).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
    : 7;
  if (_mGeoSeed !== seed) { _mGeoSeed = seed; _mGeoShapes = _mGeoBuild(seed); }

  // 底下还是垫一层封面色，纯黑上飘几何图形像 90 年代屏保
  const bg = cx.createRadialGradient(w * .5, h * .38, 0, w * .5, h * .38, Math.max(w, h) * .75);
  bg.addColorStop(0, _mCss(cols[0], .34));
  bg.addColorStop(1, _mCss(cols[cols.length - 1], 0));
  cx.fillStyle = bg;
  cx.fillRect(0, 0, w, h);

  const short = Math.min(w, h);
  const boost = 1 + pulse * pulse * 0.22;
  cx.globalCompositeOperation = 'lighter';
  cx.lineWidth = Math.max(1, short * 0.006);
  for (const s of _mGeoShapes) {
    const x = (s.x + 0.13 * Math.sin(t * s.sp + s.ph)) * w;
    const y = (s.y + 0.11 * Math.cos(t * s.sp * 1.27 + s.ph)) * h;
    const r = s.r * short * boost;
    const c = cols[s.c % cols.length];
    // _mTint 是压暗过的（给背景用），线框太暗会看不见，这里提回来
    const lit = c.map(v => Math.min(255, Math.round(v * 1.7 + 26)));
    cx.save();
    cx.translate(x, y);
    cx.rotate(t * s.spin + s.ph);
    cx.beginPath();
    if (s.k === 'circle') cx.arc(0, 0, r, 0, 6.2832);
    else if (s.k === 'square') cx.rect(-r, -r, r * 2, r * 2);
    else if (s.k === 'tri') { cx.moveTo(0, -r); cx.lineTo(r * .87, r * .5); cx.lineTo(-r * .87, r * .5); cx.closePath(); }
    else { cx.moveTo(-r, 0); cx.lineTo(r, 0); cx.moveTo(0, -r); cx.lineTo(0, r); }
    if (s.fill && s.k !== 'cross') { cx.fillStyle = _mCss(lit, s.a * .34); cx.fill(); }
    cx.strokeStyle = _mCss(lit, s.a);
    cx.stroke();
    cx.restore();
  }
}

// ============================================================
// 聊天里的卡片
// ============================================================
// 存储形态：[[SONG: id|歌名|歌手|封面url]]
function musicSongTagRe() { return /\[\[SONG:\s*(\d+)\s*\|([^|\]]*)\|([^|\]]*)\|?([^\]]*)\]\]/g; }
function musicAskTagRe() { return /\[\[MUSIC:\s*([^\]]+?)\s*\]\]/g; }

function musicCardHtml(song) {
  const cover = song.cover
    ? `<img class="music-cover" src="${escHtml(song.cover)}" alt="" loading="lazy">`
    : `<div class="music-cover music-cover-none">🎵</div>`;
  const on = _mNow && String(_mNow.id) === String(song.id);
  const playing = on && _mAudio && !_mAudio.paused;
  const j = jsAttr(song);
  return `<div class="music-card${on ? ' music-card-on' : ''}" data-song-id="${escHtml(String(song.id))}">
    ${cover}
    <div class="music-meta">
      <div class="music-name">${escHtml(song.name)}</div>
      <div class="music-artist">${escHtml(song.artist || '')}</div>
      <div class="music-bar" onpointerdown="musicSeekStart(event,this)" onpointermove="musicSeekMove(event,this)" onpointerup="musicSeekEnd(event,this)" onpointercancel="musicSeekEnd(event,this)"><i class="music-fill"></i></div>
      <div class="music-times"><span class="music-t-cur">0:00</span><span class="music-t-dur">${_mFmt((song.duration || 0) / 1000)}</span></div>
    </div>
    <div class="music-ops">
      <button class="music-play" onclick='musicPlay(${j})' title="播放/暂停">${playing ? '⏸' : '▶'}</button>
      <a class="music-out" href="https://music.163.com/#/song?id=${escHtml(String(song.id))}" target="_blank" rel="noopener" title="在网易云打开">↗</a>
    </div>
  </div>`;
}

// 渲染层入口（由 stickerTagToHtml 末尾统一调用，content 和 blocks 两条路都会经过）
function musicTagToHtml(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  if (text.indexOf('[[SONG:') >= 0) {
    // 卡片是 <div>，前后要留空行——单个 \n 不够：marked 会把行首 <div> 之后
    // 一路吞到空行为止，紧跟的正文连同 **加粗** 一起被当 HTML 原样吐出来
    text = text.replace(musicSongTagRe(), (m, id, name, artist, cover) =>
      '\n\n' + musicCardHtml({ id, name: name.trim(), artist: artist.trim(), cover: (cover || '').trim() }) + '\n\n');
  }
  // AI 写的 [[MUSIC: 关键词]]：渲染时才去搜，搜到就固化成 [[SONG:]] 写回存储，
  // 失败则标签留着，下次渲染自动重试（同 [[GIF_SEARCH:]]）。
  if (text.indexOf('[[MUSIC:') >= 0) {
    text = text.replace(musicAskTagRe(), (m, kw) => {
      const q = kw.trim();
      if (!musicEnabled()) return m;                  // 功能没开就原样留着，开了自然会被救活
      if (_mSearchCache[q]) return '\n\n' + musicCardHtml(_mSearchCache[q]) + '\n\n';
      const uid = 'msearch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      setTimeout(() => resolveMusicSearch(uid, q), 30);
      return `\n\n<div id="${uid}" class="music-card music-card-load">🎵 找歌中…</div>\n\n`;
    });
  }
  return text;
}

// 歌单标签跟着走同一个入口。挂在这里而不是另找地方注册，
// 是因为 stickerTagToHtml 只认 musicTagToHtml 这一个音乐出口。
function musicTagToHtmlAll(text) { return musicPlaylistTagToHtml(musicTagToHtml(text)); }

async function resolveMusicSearch(elementId, q) {
  const swap = html => { const el = document.getElementById(elementId); if (el) el.outerHTML = html; };
  try {
    if (!_mSearchPending[q]) _mSearchPending[q] = musicPick(q).finally(() => { delete _mSearchPending[q]; });
    const r = await _mSearchPending[q];
    const s = r.song;
    if (!s) { swap(`<div class="music-card music-card-load">🎵 没找到《${escHtml(q)}》</div>`); return; }
    _mSearchCache[q] = s;
    const elGone = !document.getElementById(elementId);
    swap(musicCardHtml(s));
    _persistMusicResult(q, s);
    // AI 点的歌就直接放出来（这才叫"给我放首歌"）。浏览器拦了自动播放的话
    // _mPlayFailed 会提示点一下——但至少卡片已经在那儿了。
    if (r.url) musicPlay(s, r.url);
    if (elGone) renderMessages();
  } catch (e) {
    swap(`<div class="music-card music-card-load">🎵 点歌要连着电脑的后端服务（${escHtml(q)}）</div>`);
  }
}

// 往 [[SONG:]]/[[PLIST:]] 里塞的字段不许带 | [ ]：「Lemon [Remastered]」里的 ] 会把标签
// 提前截断，解析正则认不出，整串原文直接漏进气泡。换成全角，显示上看不出差别。
function _mTagSafe(s) {
  return String(s == null ? '' : s).replace(/\|/g, '｜').replace(/\]/g, '］').replace(/\[/g, '［');
}
// 封面是 URL，换全角会把地址弄坏，改成百分号编码（对服务器是同一个地址）
function _mTagSafeUrl(s) {
  return String(s || '').replace(/\|/g, '%7C').replace(/\]/g, '%5D').replace(/\[/g, '%5B');
}

// 把存储里的 [[MUSIC:kw]] 固化成 [[SONG:id|名|歌手|封面]]，避免每次渲染都重搜一遍
function _persistMusicResult(q, s) {
  const chat = getActiveChat();
  if (!chat) return;
  const re = new RegExp(`\\[\\[MUSIC:\\s*${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]`, 'g');
  const tag = `[[SONG:${s.id}|${_mTagSafe(s.name)}|${_mTagSafe(s.artist)}|${_mTagSafeUrl(s.cover)}]]`;
  let changed = false;
  const fix = str => { if (!str) return str; const r = str.replace(re, tag); if (r !== str) changed = true; return r; };
  for (const node of Object.values(chat.nodes)) {
    node.content = fix(node.content);
    if (node.blocks) node.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    if (node.variants) node.variants.forEach(v => {
      v.content = fix(v.content);
      if (v.blocks) v.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    });
  }
  if (changed) save();
}

// 回填历史给模型：压成一行可读文本。
// 漏了这条模型就看不见自己点过什么歌，会反复点同一首（学习卡片那边同款教训）。
function musicTagForApi(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return text
    .replace(musicSongTagRe(), (m, id, name, artist) => `[点了一首歌: ${name.trim()} - ${artist.trim()}]`)
    .replace(musicAskTagRe(), (m, kw) => `[点歌: ${kw.trim()}]`)
    .replace(musicPlaylistTagRe(), (m, id, name) => `[建了个歌单: ${(name || '').trim()}]`)
    .replace(musicPlaylistAskRe(), (m, raw) => `[建歌单: ${String(raw).split('|')[0].trim()}]`);
}

// 流式打字时别让裸指令漏在气泡里
function maskStreamingMusic(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return text
    .replace(/\[\[MUSIC:[\s\S]*?\]\]/g, '〔🎵 找歌中…〕')
    .replace(/\[\[MUSIC:[\s\S]*$/, '〔🎵 找歌中…〕')
    .replace(/\[\[SONG:[\s\S]*$/, '〔🎵 找歌中…〕')
    .replace(/\[\[PLAYLIST:[\s\S]*?\]\]/g, '〔🎵 整理歌单中…〕')
    .replace(/\[\[PLAYLIST:[\s\S]*$/, '〔🎵 整理歌单中…〕')
    .replace(/\[\[PLIST:[\s\S]*$/, '〔🎵 整理歌单中…〕')
    .replace(/\[\[LISTEN\]\]/gi, '〔🎧 听一听…〕')
    .replace(/\[\[LYRICS[^\]]*\]\]/gi, '〔📜 翻歌词…〕')
    .replace(/\[\[LYRICS[^\]]*\]?$/i, '〔📜 翻歌词…〕')
    .replace(/\[\[LY(?:R(?:I(?:C)?)?)?$/i, '')
    .replace(/\[\[L(?:I(?:S(?:T(?:E(?:N\]?)?)?)?)?)?$/i, '');
}

// ── 系统提示（只有开了才注入，省 token）──
// ── [[LISTEN]]：按需看一眼正在放的歌（同 [[MOMENTS]] 的「置位 → 注入一次」）──
// 标记只放内存：它写完这条，callAPI 收尾会当场续一轮把结果给它（lookupChainContinue），
// 不会隔到刷新之后，所以不需要从历史里认印子兜底。
const MUSIC_LISTEN_LABEL = '🎧 听了听正在放的歌';
function musicListenWant(confId) {
  if (confId == null) return;
  if (!state.musicListenWant) state.musicListenWant = {};
  state.musicListenWant[String(confId)] = true;
}
function musicListenPending(confId) { return !!(state.musicListenWant && state.musicListenWant[String(confId)]); }
function musicListenClear(confId) { if (state.musicListenWant) delete state.musicListenWant[String(confId)]; }
function musicListenBlockHtml() {
  return '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)">'
    + '<span class="think-chev">▸</span> <span class="think-label">' + MUSIC_LISTEN_LABEL + '</span></div>'
    + '<div class="think-body">（看了一眼正在放的歌）</div></div>\n\n';
}
// content 路径（processAiCommands）和 blocks 路径各走一遍；置位是幂等的，两边都置不怕。
function musicProcessListen(text, conf) {
  if (!text || text.indexOf('[[LISTEN') < 0) return text;
  return String(text).replace(/\[\[LISTEN\]\]/gi, () => {
    // 听关着时没人消费这个标记，置了也白置（现在听常开，musicEarsOn 留着当总闸）
    if (conf && musicEarsOn()) musicListenWant(conf.id);
    return musicListenBlockHtml();
  });
}
function _applyMusicListenToBlocks(blocks, conf) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) if (b && b.type === 'text' && b.text) b.text = musicProcessListen(b.text, conf);
}

// ── [[LYRICS: 歌名 歌手]]：想查哪首就看哪首的完整歌词（用户）──
// [[LISTEN]] 只给正在唱的那句前后两句；这条不用在放，写歌名就去网易云拿整首（有翻译带翻译）。
// 不带歌名的 [[LYRICS]] ＝ 正在放的那首（她手动贴过歌词的话就用贴的那份）。
// 取歌词要联网，而 musicPromptFor 是同步的，所以拆两步：
//   ① callAPI/群聊/并排收尾时、processAiCommands 之前 await musicLyricsPrefetch，结果挂 state.musicLyricsWant[confId]
//   ② 标签只换成提示块；下一次拼提示词（当轮续写那次）摊进 volatile，摊一次就清（同 [[LISTEN]]）
// 歌词不进聊天记录：一首几百到一千多 token，每轮回填历史白烧。要再看就再写一次。
const MUSIC_LYRICS_LABEL = '📜 翻了翻歌词';
const MUSIC_LYRICS_MAX = 2;         // 一轮最多查两首
const MUSIC_LYRICS_CHARS = 6000;    // 一首最多摊这么多字，超长的 remix/串烧别把上下文吃爆
function musicLyricsTagRe() { return /\[\[LYRICS(?::\s*([^\]]*?))?\s*\]\]/gi; }
function musicLyricsPending(confId) {
  const l = state.musicLyricsWant && state.musicLyricsWant[String(confId)];
  return !!(l && l.length);
}
function musicLyricsClear(confId) { if (state.musicLyricsWant) delete state.musicLyricsWant[String(confId)]; }

// 时轴行 → 纯文本。翻译挂在括号里；同一句连着重复（逐字歌词拆行）只留一次
function _mLyricsPlain(lines) {
  const out = [];
  for (const l of lines || []) {
    const s = String(l.txt || '').trim();
    if (!s) continue;
    const tr = String(l.tr || '').trim();
    const row = tr && tr !== s ? `${s}（${tr}）` : s;
    if (out[out.length - 1] !== row) out.push(row);
  }
  return out.join('\n');
}
// 按网易云 id 取一首。返回 { text } / { pure } / { none }；取失败抛错
async function _mLyricsById(id) {
  const r = await fetch(`${musicApiBase()}/api/music/lyric?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('取歌词失败');
  const j = await r.json();
  const yrc = _mParseWordLyric(j.yrc);
  const wbw = yrc.length > 0;
  let lines = wbw ? yrc : _mParseLrc(j.lyric);
  if (_mIsPureMusic(j, lines)) return { pure: true };
  if (lines.length) {
    _mAttachAlt(lines, (wbw && j.ytlrc) || j.tlyric, 'tr');
  } else {
    // 少数歌词没有时间轴，_mParseLrc 一行都认不出——那就按行原样给
    lines = String(j.lyric || '').split(/\r?\n/).map(s => ({ txt: s.replace(/\[[^\]]*\]/g, '').trim() })).filter(l => l.txt);
  }
  const text = _mLyricsPlain(lines);
  return text ? { text } : { none: true };
}
// 一个查询 → 一首歌的歌词结果 { q, name, artist, text?, pure?, none?, err?, cut? }
async function musicLyricsLookup(q) {
  q = String(q || '').trim();
  const fin = (song, got) => {
    const res = { q, name: song.name || '', artist: song.artist || '', ...got };
    if (res.text && res.text.length > MUSIC_LYRICS_CHARS) { res.text = res.text.slice(0, MUSIC_LYRICS_CHARS); res.cut = true; }
    return res;
  };
  if (!q) {
    const now = _mNow && !_mNow._resume ? _mNow : null;
    if (!now) return { q, err: '现在没有歌在放' };
    if (_mLyric && _mLyric.lines && _mLyric.lines.length) return fin(now, { text: _mLyricsPlain(_mLyric.lines) });
    if (_mLyIsPure()) return fin(now, { pure: true });
    if (!/^\d+$/.test(String(now.id || ''))) return fin(now, { none: true });
    return fin(now, await _mLyricsById(now.id));
  }
  const songs = await musicSearch(q, 8);
  if (!songs.length) return { q, err: '网易云上没搜到' };
  // 名字和歌手都对得上的排前面，其中歌手栏真对上的再往前（「晴天 (原唱 周杰伦)」只是名字里带了歌手）；
  // 翻唱版常常一个字歌词都没有，所以没词就往下再试两首对得上的。
  // 一首都对不上（编的歌名、网易云没这首）也给最接近的那首，但标 loose，摊开时明说多半不是
  const parts = q.split(/\s+/).map(musicSearchNorm).filter(Boolean);
  const hit = s => parts.every(p => musicSearchNorm(s.name + ' ' + s.artist).includes(p));
  const byArtist = s => parts.some(p => musicSearchNorm(s.artist).includes(p));
  const hits = songs.filter(hit);
  const cands = [...hits.filter(byArtist), ...hits.filter(s => !byArtist(s)), ...songs.filter(s => !hit(s))].slice(0, 3);
  let first = null;
  for (const s of cands) {
    const got = await _mLyricsById(s.id);
    if (!hit(s)) got.loose = true;
    if (got.text) return fin(s, got);
    if (!first) first = fin(s, got);
  }
  return first;
}
// callAPI 等收尾时 await：把这条回复里要查的歌词取回来挂上（听关着就不查——没人消费；不看「AI 点歌」开关）
async function musicLyricsPrefetch(text, conf) {
  if (!conf || !text || String(text).indexOf('[[LYRICS') < 0 || !musicEarsOn()) return;
  const qs = [...new Set([...String(text).matchAll(musicLyricsTagRe())].map(m => (m[1] || '').trim()))];
  if (!qs.length) return;
  const res = await Promise.all(qs.slice(0, MUSIC_LYRICS_MAX).map(q =>
    musicLyricsLookup(q).catch(e => ({ q, err: e.message || '连不上网易云' }))));
  for (const q of qs.slice(MUSIC_LYRICS_MAX)) res.push({ q, err: `一轮最多查 ${MUSIC_LYRICS_MAX} 首，这首没查` });
  if (!state.musicLyricsWant) state.musicLyricsWant = {};
  state.musicLyricsWant[String(conf.id)] = res;
}
function musicLyricsBlockHtml(q, r) {
  const ask = escHtml(q || '（正在放的那首）');
  const found = r && r.name ? `<br>→ ${escHtml(r.name)}${r.artist ? ' - ' + escHtml(r.artist) : ''}`
    + (r.pure ? '（纯音乐）' : r.none ? '（没有歌词）' : '') : (r && r.err ? `<br>→ ${escHtml(r.err)}` : '');
  return '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)">'
    + '<span class="think-chev">▸</span> <span class="think-label">' + MUSIC_LYRICS_LABEL + '</span></div>'
    + '<div class="think-body">' + ask + found + '</div></div>\n\n';
}
function musicProcessLyrics(text, conf) {
  if (!text || String(text).indexOf('[[LYRICS') < 0) return text;
  const got = (conf && state.musicLyricsWant && state.musicLyricsWant[String(conf.id)]) || [];
  return String(text).replace(musicLyricsTagRe(), (m, q) => {
    q = (q || '').trim();
    return musicLyricsBlockHtml(q, got.find(r => r.q === q));
  });
}
function _applyMusicLyricsToBlocks(blocks, conf) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) if (b && b.type === 'text' && b.text) b.text = musicProcessLyrics(b.text, conf);
}
// 摊进 volatile 的那段；摊完就清
function musicLyricsText(conf) {
  if (!conf || !musicLyricsPending(conf.id)) return '';
  const list = state.musicLyricsWant[String(conf.id)];
  musicLyricsClear(conf.id);
  const parts = list.map(r => {
    const who = r.name ? `《${r.name}》${r.artist ? ' - ' + r.artist : ''}` : `「${r.q || '正在放的那首'}」`;
    if (r.err) return `${who}：没查到（${r.err}）`;
    if (r.pure) return `${who}：纯音乐，没有歌词`;
    if (r.none || !r.text) return `${who}：网易云上这首没有歌词`;
    const src = !r.q || !r.name ? ''
      : r.loose ? `（你查的是「${r.q}」，网易云上没有名字歌手都对得上的，这是最接近的一首，多半不是你要的那首）`
      : `（你查的是「${r.q}」，按网易云搜到的这首给的）`;
    return `${who}${src}：\n${r.text}${r.cut ? '\n（太长，后面截掉了）' : ''}`;
  });
  return '\n\n[你刚翻的歌词] 是给你看的，聊的时候引一两句就好，别整首贴给她。\n' + parts.join('\n\n');
}

// 「正在放」附带的歌词：当前这句加前后各两句，她说「这句好喜欢」时 AI 知道是哪句。
// 只给一小段不给全文——整首歌词每轮都进 volatile，几百 token 白烧。
// 当前行按传进来的时间现算，不读 _mLyric.idx：那个只在歌词面板开着时才跟着走。
function musicLyricContext(time, before, after) {
  const L = _mLyric && _mLyric.lines;
  if (!L || !L.length) return '';
  before = before ?? 2; after = after ?? 2;
  let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t <= time) i = k; else break; }
  const txt = l => {
    const s = String(l.txt || '').trim();
    const tr = String(l.tr || '').trim();
    return s ? (tr && tr !== s ? `${s}（${tr}）` : s) : '';
  };
  const out = [];
  for (let k = Math.max(0, i - before); k <= Math.min(L.length - 1, i + after); k++) {
    const s = txt(L[k]);
    if (s) out.push((k === i ? '▶ ' : '  ') + s);
  }
  if (!out.length) return '';
  const head = i < 0 ? '歌词（还在前奏，下面是接下来要唱的）' : '歌词（▶ 是正在唱的这句，前后各带两句）';
  return `\n${head}：\n${out.join('\n')}`;
}

// ── 整首听过：歌曲档案（server/music-profile.js，2026-10-03）──
// 上面那几个数（速度/亮暗/调性）是本机算的，粗；这一份是让 Gemini 把整首**真听一遍**写的：
// 分段带时间点、情绪走向、乐器、人声、歌词大意。按歌 id 存在电脑上，一首只听一次。
// **只在真的一起听时才听**：歌在放（没暂停）、她又在聊天（musicPromptFor 跑了）、或者 AI 写了 [[LISTEN]]。
// 后台随便放着的歌、歌单里没一起听过的歌，一律不送——一首约 7k token，别把她上千首收藏全跑一遍。
// 「聊过的内容攒起来」：一起听期间记下这首歌和聊天的时间窗（_M_TOGETHER_KEY，落盘防刷新丢），
// 换歌/停歌时把这段里的对话交给 server 摘一两句她说过的话，存进同一份档案，下次放这首时带上。
// 全走 SERVER_BASE（电脑那台）：安卓自带的 8080 代理只有 search/url/pick/lyric 四条。
const _M_PROF_KEY = 'kuro_musicProfile';
const _M_TOGETHER_KEY = 'kuro_musicTogether';
const _M_PROF_RETRY_MS = 10 * 60 * 1000;          // 听失败了 10 分钟后才再试（server 那边也是这个冷却）
var _mProf = new Map();                           // id -> { profile, memos, error?, errAt? }
var _mProfBusy = new Set();                       // 正在等 server 听完的 id
function _mProfOn() { try { return localStorage.getItem(_M_PROF_KEY) !== '0'; } catch (e) { return true; } }
function _mProfBase() { return typeof SERVER_BASE !== 'undefined' ? SERVER_BASE : ''; }
function musicProfileGet(id) { return _mProf.get(String(id)) || null; }
function _mProfPut(id, j) {
  if (!j || typeof j !== 'object') return;
  id = String(id);
  _mProf.delete(id);
  _mProf.set(id, {
    profile: j.profile || null,
    memos: Array.isArray(j.memos) ? j.memos : [],
    ...(j.error ? { error: String(j.error), errAt: Date.now() } : {}),
  });
  while (_mProf.size > 40) _mProf.delete(_mProf.keys().next().value);
}
// 放歌时先读一眼盘（不分析）：以前一起听过的歌，档案和她说过的话要在第一次 [[LISTEN]] 时就在
async function musicProfileLoad(id) {
  id = String(id || '');
  if (!/^\d+$/.test(id) || !_mProfOn() || typeof fetch !== 'function') return;
  try {
    const r = await fetch(`${_mProfBase()}/api/music/profile?id=${encodeURIComponent(id)}`);
    if (!r.ok) return;
    const j = await r.json();
    const had = musicProfileGet(id);
    if (!had || !had.profile || j.profile) _mProfPut(id, j);
  } catch (e) { /* 电脑没开就算了，歌照放 */ }
}
// 第一次一起听这首：叫 server 去听。不 await——要半分钟到一分钟，听完下一轮就有
function musicProfileEnsure(song) {
  if (!song || !_mProfOn() || typeof fetch !== 'function') return;
  const id = String(song.id || '');
  if (!/^\d+$/.test(id) || _mProfBusy.has(id)) return;   // 非网易云的歌（Apple 试听之类）不听
  const have = musicProfileGet(id);
  if (have && have.profile) return;
  if (have && have.error && Date.now() - (have.errAt || 0) < _M_PROF_RETRY_MS) return;
  _mProfBusy.add(id);
  const dur = (_mAudio && _mNow && String(_mNow.id) === id && _mAudio.duration) || (+song.duration || 0) / 1000;
  fetch(`${_mProfBase()}/api/music/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: song.name || '', artist: song.artist || '', dur: Math.round(dur || 0) }),
  }).then(r => r.json()).then(j => {
    const had = musicProfileGet(id);
    _mProfPut(id, { ...j, memos: (j && j.memos && j.memos.length) ? j.memos : (had ? had.memos : []) });
    if (j && j.error) console.warn('[听歌·档案] 没听成：', j.error);
  }).catch(e => {
    _mProfPut(id, { ...(musicProfileGet(id) || {}), error: e.message || '连不上电脑' });
  }).finally(() => _mProfBusy.delete(id));
}
function musicProfileSection(p, t) {
  let cur = null;
  for (const s of (p && p.sections) || []) { if (s.start <= t) cur = s; else break; }
  return cur;
}
function _mMd(ts) { const d = new Date(ts); return isNaN(d) ? '' : `${d.getMonth() + 1}-${d.getDate()}`; }
// [[LISTEN]] 摊开时附在后面的那几行。t = 现在放到第几秒，用来标 ▶ 在哪一段
function musicProfileText(id, t) {
  id = String(id);
  const rec = musicProfileGet(id), p = rec && rec.profile;
  const out = [];
  if (p) {
    out.push(`整首档案（另一个模型把整首完整听过一遍写的，比上面那几个数准）：${p.summary || ''}`);
    if (p.mood) out.push(`情绪走向：${p.mood}`);
    const iv = [p.instruments && p.instruments.length ? '乐器：' + p.instruments.join('、') : '', p.vocal ? '人声：' + p.vocal : ''].filter(Boolean).join('；');
    if (iv) out.push(iv);
    if (p.lyricGist) out.push(`歌词大意：${p.lyricGist}`);
    const cur = musicProfileSection(p, t);
    if (p.sections && p.sections.length) out.push('段落：' + p.sections.map(s => (s === cur ? '▶' : '') + _mFmt(s.start) + ' ' + s.label).join(' · '));
    if (cur) out.push(`现在在「${cur.label}」（${_mFmt(cur.start)}–${_mFmt(cur.end)}）${cur.note ? '：' + cur.note : ''}`);
    if (p.peak) out.push(`最抓人的一刻：${_mFmt(p.peak.t)} ${p.peak.note || ''}`);
  } else if (_mProfBusy.has(id)) {
    out.push('（第一次一起听这首：另一个模型正在把整首听一遍写档案，大概半分钟到一分钟，下一轮就有）');
  }
  const memos = (rec && rec.memos) || [];
  if (memos.length) out.push('以前一起听这首时她说过：' + memos.map(m => `「${m.text}」${m.at ? `（${_mMd(m.at)}）` : ''}`).join(' '));
  return out.length ? '\n' + out.join('\n') : '';
}

function _mTogetherGet() { try { return JSON.parse(localStorage.getItem(_M_TOGETHER_KEY) || 'null'); } catch (e) { return null; } }
function _mTogetherSet(v) { try { v ? localStorage.setItem(_M_TOGETHER_KEY, JSON.stringify(v)) : localStorage.removeItem(_M_TOGETHER_KEY); } catch (e) {} }
// 每轮聊天（musicPromptFor）记一笔：这首歌在这个对话里一起听着。换了歌/换了对话就先把上一段收走
function musicTogetherTouch() {
  if (!_mNow || !_mProfOn()) return;
  const id = String(_mNow.id || '');
  if (!/^\d+$/.test(id)) return;
  const chatId = typeof state !== 'undefined' ? state.activeChatId : null;
  let tg = _mTogetherGet();
  if (tg && (tg.id !== id || tg.chatId !== chatId)) { musicHarvest(tg); tg = null; }
  const now = Date.now();
  // 窗口从这首歌开头算（这一轮之前她已经就着这首歌说过几句了），最多往回 15 分钟
  if (!tg) tg = { id, name: _mNow.name || '', artist: _mNow.artist || '', chatId, t0: now - Math.min(900000, ((_mAudio && _mAudio.currentTime) || 0) * 1000 + 5000) };
  tg.t1 = now;
  _mTogetherSet(tg);
}
function _mPlain(c) {
  const s = Array.isArray(c) ? c.map(p => (p && (p.text || (typeof p === 'string' ? p : ''))) || '').join(' ') : String(c || '');
  return s.replace(/<[^>]*>/g, ' ').replace(/\[\[[\s\S]*?\]\]/g, ' ').replace(/\s+/g, ' ').trim();
}
// 把一起听那段的对话摘出来交给 server，让它挑一两句她说过的话存进这首歌的档案
function musicHarvest(tg) {
  tg = tg || _mTogetherGet();
  _mTogetherSet(null);
  if (!tg || !tg.id || typeof fetch !== 'function' || typeof state === 'undefined') return;
  const chat = (state.chats || []).find(c => c.id === tg.chatId);
  if (!chat || !chat.nodes) return;
  // 她最后一句之后 AI 还会回一条，所以窗口往后放 3 分钟
  const end = Math.min(Date.now(), (tg.t1 || 0) + 180000);
  const lines = [];
  let n = chat.nodes[chat.headId], guard = 0;
  while (n && guard++ < 400) {
    const ts = +n.timestamp || 0;
    if (ts && ts < tg.t0) break;
    if (ts && ts <= end && (n.role === 'user' || n.role === 'assistant')) {
      const text = _mPlain(n.content);
      if (text) lines.push({ who: n.role === 'user' ? '她' : '它', text: text.slice(0, 300) });
    }
    n = n.parentId ? chat.nodes[n.parentId] : null;
  }
  lines.reverse();
  if (!lines.some(l => l.who === '她')) return;          // 她一句都没说，没什么可记的
  fetch(`${_mProfBase()}/api/music/profile/memo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tg.id, name: tg.name, artist: tg.artist, lines: lines.slice(-40) }),
  }).then(r => r.json()).then(j => {
    if (j && Array.isArray(j.memos)) _mProfPut(tg.id, { ...(musicProfileGet(tg.id) || {}), memos: j.memos, error: null });
  }).catch(() => {});
}
function musicToggleProfile() {
  const on = !_mProfOn();
  try { localStorage.setItem(_M_PROF_KEY, on ? '1' : '0'); } catch (e) {}
  if (!on) _mTogetherSet(null);
  showToast(on ? '整首听：开（第一次一起听一首歌时让 Gemini 听一遍，记下你们聊过的话）' : '整首听：关（只给 AI 几个算出来的数）', 'info', 2600);
}

// 分两半：点歌（[[MUSIC:]]/[[PLAYLIST:]]、最近放过、已有歌单）跟「AI 点歌」开关走；
// 听歌（有歌在放 / [[LISTEN]] / [[LYRICS]]）常开——开关关着时 AI 也得知道她在听什么。
function musicPromptFor(conf) {
  const ai = musicEnabled();
  const recent = ai ? (state.musicRecent || []).slice(0, 8).map(s => `${s.name}-${s.artist}`).join('、') : '';
  const pick = `

--- 🎵 点歌 ---
你可以在聊天里直接给用户放歌：单独写一行 \`[[MUSIC: 歌名 歌手]]\`，系统会去网易云找到这首歌，
在聊天里长出一张能播放的卡片并直接开始放。歌手名写上准确率高很多（\`[[MUSIC: 夜曲 周杰伦]]\`）。
- 用户说"放首歌""来点音乐""我想听XXX"时用这条；你自己想为当下的气氛配一首歌时也可以用。
- **一次只点一首**。也别在正文里复述"我给你放了《XXX》"——卡片上写着呢。
- 找不到或没版权时会显示放不了，那时候可以换一首相近的再试一次，别硬试同一首。
- 冷门歌、纯音乐、外语歌都行；网易云上没有的（比如很多欧美新歌）就换一首。

你也可以一次攒一个歌单：单独写一行
\`[[PLAYLIST: 歌单名 | 一句话简介 | 歌名1 歌手1 / 歌名2 歌手2 / 歌名3 歌手3]]\`
系统会挨个去搜，建成一个能点开听的歌单，聊天里长出一张歌单卡片。
- 用它的时机：她说"给我弄个歌单""整理一下""想要一批XX的歌"，或者你想按某种心情/主题攒一组。
- 三段用 \`|\` 隔开，歌与歌之间用 \`/\` 隔开。**一次最多 20 首**，超了会被截掉。
- 简介可以省（写成 \`[[PLAYLIST: 名字 | 歌1 / 歌2]]\`），但名字和歌是必须的。
- 建完别在正文里把歌名再列一遍——卡片上点开就能看见。
- 单首歌用 \`[[MUSIC:]]\`，成组才用这条。别拿它放一首歌。`;
  const ears = `

${ai ? '' : '--- 🎧 听歌 ---\n她在 GranCyan 自带的播放器里放歌时你会知道（给她放歌的功能她没开，别写 [[MUSIC:]]）。\n'}你听不见歌，但系统会从正在放的那首的音频里算出速度、音色亮暗、响度起伏、调性，
平时你只知道「有歌在放」，不知道是哪首。想知道的时候（她问你在放什么、说「这句好好听」、你想接着歌聊），
单独一行写 \`[[LISTEN]]\`，系统会**当场**把正在放的歌名、歌手、放到哪、听感、正在唱的那句加前后几句摆到你眼前，
你看完直接接着说——不用等她下一句。可以拿来聊这首歌、接她的情绪，但别说成你亲耳听到了；
这些是估的：BPM 可能差一倍，调性常和它的关系大/小调搞混。她说「这句」多半指歌词里 ▶ 那句。
别每轮都听：她没提歌、你也没打算聊歌的时候就别写。
一起听过的歌还会有一份「整首档案」：另一个模型把整首完整听过一遍写的分段（带时间点）、情绪走向、乐器、歌词大意，
[[LISTEN]] 时一起摆出来，▶ 标着现在放到哪一段——比那几个算出来的数准，聊的时候以它为准。
以前一起听这首时她说过的话也会附在后面：那是一起听这首时留下的记忆，可以自然地接上（「上次放这首你说……」），别整段念给她听。

想看一首歌的**完整歌词**（她问某首歌唱的什么、想聊某句词、你想知道正在放的这首后面唱什么），单独一行写
\`[[LYRICS: 歌名 歌手]]\`，系统会当场去网易云把整首歌词（有翻译带翻译）摆到你眼前，你看完直接接着说。
不用在放，任何歌都能查；不带歌名写 \`[[LYRICS]]\` 就是正在放的那首。一次最多两首，查不到会告诉你。
歌词是给你看的：聊的时候引一两句、说说你的理解，别把整首贴给她。`;
  const stable = (ai ? pick : '') + ears;
  // 已有的歌单也要报给它。不报的话它会一次次建出同名歌单，
  // 而且每次都以为自己是第一次建。
  const lists = ai ? (state.musicPlaylists || []).slice(0, 10)
    .map(p => `${p.name}(${(p.songs || []).length}首)`).join('、') : '';
  // 正在放的这首。放在 volatile：进度和听感每轮都可能变，进 stable 会把提示词缓存打穿。
  // 平时只报「有歌在放」；它写了 [[LISTEN]] 才摊开一次（用户：平时不用一直看到）。
  const want = !!(conf && musicListenPending(conf.id));
  if (conf) musicListenClear(conf.id);
  let now = '';
  // 重启后装回来、她还没按 ▶ 的那首（_resume）不算「有歌在放」
  const live = !!(_mNow && !_mNow._resume);
  // 「一起听」的判据：歌在放着她在聊，或者它主动听了一下。这时才记聊天窗口、才叫 server 整首听一遍
  if (live && (want || !(_mAudio && _mAudio.paused))) {
    musicTogetherTouch();
    musicProfileEnsure(_mNow);
  } else if (!live && _mTogetherGet()) {
    musicHarvest();                               // 歌放完了/停了还没收走的那段，这时候收
  }
  if (live && !want) {
    // 不报歌名（平时不用一直看到），但一起听过的要提一句，它才知道值得听一下
    const rec = musicProfileGet(_mNow.id);
    const met = rec && rec.memos && rec.memos.length ? '（这首你们以前一起听过）' : '';
    now = `\n\n[有歌在放${_mAudio && _mAudio.paused ? '（暂停中）' : ''}${met}] 想知道是哪首、唱到哪了，单独一行写 [[LISTEN]]`;
  } else if (want && !live) {
    now = '\n\n[你刚听了听] 现在没有歌在放。';
  } else if (live) {
    const a = _mAudio;
    const where = a && a.duration ? `，放到 ${_mFmt(a.currentTime)} / ${_mFmt(a.duration)}` : '';
    now = `\n\n[你刚听了听，正在放] ${_mNow.name}-${_mNow.artist || ''}${a && a.paused ? '（暂停中）' : ''}${where}`
      + (_mNow.feat?.hint ? `\n听感（按音频算的）：${_mNow.feat.hint}` : '')
      + musicProfileText(_mNow.id, a ? a.currentTime : 0)
      + musicLyricContext(a ? a.currentTime : 0);
  }
  const volatile = now
    + musicLyricsText(conf)
    + (recent ?`\n\n[最近放过的歌（别老是重复）] ${recent}` : '')
    + (lists ? `\n\n[已有的歌单（想加歌就直接说，别重复建同名的）] ${lists}` : '');
  return { stable, volatile };
}

function toggleMusic(on) {
  state.musicOn = !!on;
  save();
  showToast(state.musicOn ? '🎵 点歌已接入对话' : '点歌已关闭', state.musicOn ? 'success' : 'info', 2500);
  musicRefresh();
}

// ============================================================
// 小组件面板：常驻播放器
// ============================================================
var _mResults = [];      // 上一次搜索的结果
var _mExternalResults = []; // 网易云缺曲时的 Apple Music 目录结果
var _mSearching = false;

function openMusic() {
  const m = document.getElementById('musicModal'); if (!m) return;
  m.classList.remove('hidden');
  // 抽屉（搜索/收藏/歌单/队列）：宽屏第一次打开默认展开在右边，手机上默认收着——
  // 手机的抽屉是盖在唱片上的底部面板，一进来就盖住等于没看到播放器。
  if (_mDrawerOpen === null) _mDrawerOpen = _mWide();
  _mStarsScatter();
  musicRefresh(true);
  _mScopeSync();
  musicSyncPull();   // 另一台刚收藏/建的歌单，开面板时拉过来（半分钟最多一次）
}
// 背景星星（用户：「多一些，位置随机一些」）：index.html 里那 13 颗是照稿子摆的，
// 每次打开面板换一片新的撒上去。撒法是「随机点 + 离已有的太近就重抽」，不会挤成一团也不会排成格子；
// 大小、闪的快慢、起步都各不相同，只有少数几颗大的亮的。在打开时撒而不是每次重画——重画很频繁，星星会跳。
const _M_STARS_N = 34;
function _mStarsScatter(rnd) {
  rnd = rnd || Math.random;
  const box = document.querySelector && document.querySelector('#musicModal .mz-stars');
  if (!box) return [];
  const pts = [];
  for (let i = 0; i < _M_STARS_N; i++) {
    // 抽 30 次还找不到离谁都 ≥8% 的空位（屏幕快撒满了），就用这 30 次里最空的那个
    let p = null, best = -1;
    for (let k = 0; k < 30; k++) {
      const c = { x: rnd() * 100, y: rnd() * 100 };
      const gap = pts.reduce((m, q) => Math.min(m, Math.hypot(q.x - c.x, q.y - c.y)), 1e9);
      if (gap > best) { p = c; best = gap; }
      if (gap >= 8) break;
    }
    const r = rnd();
    p.s = r < 0.12 ? 6 : r < 0.55 ? 4 : 3;              // 一成多一点是大颗
    p.t = (2.6 + rnd() * 2.4).toFixed(1);               // 2.6~5s 闪一轮
    p.d = (rnd() * 5).toFixed(1);
    pts.push(p);
  }
  box.innerHTML = pts.map(p => `<i style="left:${p.x.toFixed(1)}%;top:${p.y.toFixed(1)}%;--s:${p.s}px;--t:${p.t}s;--d:${p.d}s"></i>`).join('');
  return pts;
}
function closeMusic() {
  const m = document.getElementById('musicModal');
  if (!m) return;
  m.classList.add('hidden');
  m.classList.remove('music-lyrics-full');
  _mPopClose();
  _mLyricLoopSync(); _mVisSync(); _mScopeSync();   // 关掉面板要停掉三个 rAF，否则一直在后台画
  _mDockSync();
}

// 迷你播放条（用户：「放歌时离开点歌台也可以有个控制条常驻」）。
// 有歌（放着或暂停着都算）且点歌台关着才挂出来；点歌台一开、或者停了歌，就收起。
// 挂在 <main> 里：电脑上坐在顶栏中间那段空白，窄屏浮在顶栏下面——都不压输入框。
// 进度直接用 .music-fill：_mTick 本来就按类名全局刷，不用另接 timeupdate。
// 只在「哪首 / 放没放 / 封面」变了时重写 innerHTML：musicRefresh 调得很勤，每次都重写的话按钮按下去那一瞬就被换掉了。
function _mDockSync() {
  if (typeof document === 'undefined' || !document.getElementById || !document.querySelector) return;
  const m = document.getElementById('musicModal');
  const host = document.querySelector('main');
  let d = document.getElementById('mzDock');
  const show = !!(_mNow && m && host && m.classList.contains('hidden'));
  if (!show) { if (d) d.classList.remove('on'); _mDockLyric(); return; }
  if (!d) {
    d = document.createElement('div');
    d.id = 'mzDock';
    d.className = 'mz-dock';
    d.addEventListener('pointerdown', _mDockDragStart);
    host.appendChild(d);
  }
  const a = _mAudio, now = _mNow;
  const playing = !!(a && !a.paused);
  const cover = now.cover ? escHtml(now.cover) : 'img/music/cover-default.jpg';
  const key = [now.id, playing, now.cover || ''].join('|');
  if (d._key !== key) {
    d._key = key;
    d.innerHTML = `<div class="mz-dk-row"><button type="button" class="mz-dk-info" onclick="openMusic()" title="打开点歌台">`
      + `<span class="mz-dk-disc"><img src="${cover}" alt="" draggable="false"></span>`
      + `<span class="mz-dk-txt"><b class="mz-dk-name">${escHtml(now.name || '')}</b><i class="mz-dk-artist">${escHtml(now.artist || '')}</i></span></button>`
      + _mIc('prev', 'musicPrev()', '上一首')
      + _mIc(playing ? 'pause' : 'play', 'musicToggle()', playing ? '暂停' : '播放', 'mz-dk-play')
      + _mIc('next', 'musicNext()', '下一首')
      + `<button type="button" class="mz-dk-lyb" onclick="_mDockLyToggle()" title="桌面歌词">词</button>`
      + `<button type="button" class="mz-dk-lyo" data-k="ro" onclick="_mDeskOptToggle('ro')" title="桌面歌词带罗马音">音</button>`
      + `<button type="button" class="mz-dk-lyo" data-k="tr" onclick="_mDeskOptToggle('tr')" title="桌面歌词带翻译">译</button>`
      + _mIc('close', 'musicStop()', '停止播放', 'mz-dk-x')
      + `</div>`
      + `<span class="mz-dk-bar"><i class="music-fill" style="width:${a && a.duration ? (a.currentTime / a.duration * 100).toFixed(2) : 0}%"></i></span>`;
  }
  d.classList.add('on');
  d.classList.toggle('playing', playing);
  _mDockPlace(d);
  _mDockLyric();
}

// 迷你条 / 桌面歌词都能拖开（用户：「挡住画面了」）。位置存 localStorage，按 <main> 的尺寸夹回去，窗口缩小也不会掉到外面。
// 在元素上任意位置按下都能拖；挪动不到 4px 当作普通点击，按钮照常响应；真拖了就吞掉随后那一下 click，免得松手时顺带点开点歌台。
var _mDockPos = null, _mDeskPos = null;
try { const p = JSON.parse(localStorage.getItem('kuro_dockPos') || 'null'); if (p && isFinite(p.x) && isFinite(p.y)) _mDockPos = { x: +p.x, y: +p.y }; } catch (e) {}
try { const p = JSON.parse(localStorage.getItem('kuro_deskLyPos') || 'null'); if (p && isFinite(p.x) && isFinite(p.y)) _mDeskPos = { x: +p.x, y: +p.y }; } catch (e) {}
function _mPlaceAt(d, pos) {
  if (!pos || !d.offsetParent) return;
  const host = d.offsetParent, hw = host.clientWidth, hh = host.clientHeight;
  const x = Math.max(0, Math.min(pos.x, hw - d.offsetWidth));
  const y = Math.max(0, Math.min(pos.y, hh - d.offsetHeight));
  d.classList.add('moved');
  d.style.left = x + 'px'; d.style.top = y + 'px';
}
function _mDockPlace(d) { _mPlaceAt(d, _mDockPos); }
function _mDeskPlace(d) { _mPlaceAt(d, _mDeskPos); }
function _mDragStart(ev, d, get, set, key, place) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const sx = ev.clientX, sy = ev.clientY, r = d.getBoundingClientRect(), hr = d.offsetParent.getBoundingClientRect();
  const ox = r.left - hr.left, oy = r.top - hr.top;
  let moved = false;
  const move = e => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    set({ x: ox + dx, y: oy + dy });
    place(d);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (!moved) return;
    // 夹过之后的位置才是真位置
    set({ x: parseFloat(d.style.left) || 0, y: parseFloat(d.style.top) || 0 });
    try { localStorage.setItem(key, JSON.stringify(get())); } catch (e) {}
    const eat = e => { e.stopPropagation(); e.preventDefault(); };
    d.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => d.removeEventListener('click', eat, true), 0);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
function _mDockDragStart(ev) { _mDragStart(ev, ev.currentTarget, () => _mDockPos, p => { _mDockPos = p; }, 'kuro_dockPos', _mDockPlace); }
function _mDeskDragStart(ev) { _mDragStart(ev, ev.currentTarget, () => _mDeskPos, p => { _mDeskPos = p; }, 'kuro_deskLyPos', _mDeskPlace); }
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', () => {
    const d = document.getElementById('mzDock'); if (d && d.classList.contains('on')) _mDockPlace(d);
    const e = document.getElementById('mzDeskLy'); if (e && e.classList.contains('on')) _mDeskPlace(e);
  });
}

// 桌面歌词（用户：「不用困在那个框里，像卡拉 OK 那样字单独在外面，酷狗那样，带一点点发光」）。
// 没有底、没有框，字直接浮在画面上，单独能拖；迷你条上的「词」开关它。
// 两行一页——2k 在上（靠左）、2k+1 在下（靠右），当前句从左往右逐字扫色；唱到下一页再整页换，不一句一句顶着跳。
// 扫色用 background-clip:text 的渐变，进度走 --p：逐字歌词按字数加权，行级歌词按这一句的时长。
// 进度要顺，timeupdate 一秒只 4 次，所以单独挂 rAF（只在放着、且桌面歌词显示时）。
function _mDockLyOn() { try { return localStorage.getItem('kuro_dockLy') !== '0'; } catch (e) { return true; } }
function _mDockLyToggle() {
  try { localStorage.setItem('kuro_dockLy', _mDockLyOn() ? '0' : '1'); } catch (e) {}
  _mDockLyric();
  // 安卓：悬浮条要「在其他应用上层显示」权限，只能她自己去系统设置里开。打开「词」时没权限就送过去一次，
  // 之后不再每次都跳（她可能就只想要 App 里那层），只提醒一句
  const N = _mNative();
  if (N && N.canOverlay && _mDockLyOn() && !N.canOverlay()) {
    let asked = false;
    try { asked = localStorage.getItem('kuro_ovAsked') === '1'; localStorage.setItem('kuro_ovAsked', '1'); } catch (e) {}
    if (!asked && N.askOverlay) { showToast('桌面歌词要浮在别的 App 上面，得在系统设置里允许「显示在其他应用上层」', 'info', 4500); N.askOverlay(); }
    else showToast('没开「显示在其他应用上层」，桌面歌词只在 App 里显示', 'info', 3000);
  }
}
// 桌面歌词的「音」「译」（用户：「日语什么的，外显示的字幕要是能自选翻译和音就好啦」）。
// 和点歌台歌词角上那两个是**分开的两份**：面板里看翻译不等于桌面上也要挂一行，默认都关，保持原来两行一页的样子。
// 开了以后桌面歌词换成「当前这句 + 它的罗马音/翻译」一页一句（两句各带副行就成了四五行，又回到「太满」）。
// 这首没有罗马音就不出「音」，没有翻译就不出「译」；开关在迷你条上，exe 的悬浮窗上也有一份，改的是同一个。
function _mDeskOptOn(k) { try { return localStorage.getItem(k === 'ro' ? 'kuro_deskLyRo' : 'kuro_deskLyTr') === '1'; } catch (e) { return false; } }
function _mDeskOptToggle(k) {
  if (k !== 'ro' && k !== 'tr') return;
  try { localStorage.setItem(k === 'ro' ? 'kuro_deskLyRo' : 'kuro_deskLyTr', _mDeskOptOn(k) ? '0' : '1'); } catch (e) {}
  const el = document.getElementById && document.getElementById('mzDeskLy'); if (el) el._k = '';
  _mDockLyric();
}
function _mDeskOpts() {
  const L = (_mLyric && _mLyric.lines) || [];
  const hasRo = L.some(l => l.ro), hasTr = L.some(l => l.tr);
  return { hasRo, hasTr, ro: hasRo && _mDeskOptOn('ro'), tr: hasTr && _mDeskOptOn('tr') };
}
// 桌面歌词这一页摆哪几行。悬浮窗和窗内那层共用。
// 普通：两行一页（2k 在上、2k+1 在下）。副行模式：只有当前这句（还在前奏就是第一句），下面挂罗马音/翻译。
// 罗马音和主句共用同一个进度（同一句的读音，一起扫）；翻译只拿进度来决定长句往哪滚，不扫色。
// 某句恰好没有翻译时副行留空但不拿掉，不然这一页少一行、整块上下跳。
// two：地方够大时副行模式也两句一页（用户：「画面如果够大可以自动让带音/译的换 2 行」）——
// 和普通模式同一个翻页节奏（2k、2k+1），每句底下挂自己的副行；g 标出行属于这页的第几句。
// 悬浮窗那边自己知道窗口多大，所以给它的永远是两句的版本，放不下由它扔掉不在唱的那一句（见 deskly.js）。
function _mDeskRows(L, time, o, two) {
  const i = L.idx, n = L.lines.length;
  if (o.ro || o.tr) {
    const pg = i < 0 ? 0 : i - (i % 2), rows = [];
    for (let g = 0; g < 2; g++) {
      const k = pg + g, ln = L.lines[k] || {};
      const p = k === i ? Math.round(_mDeskProg(i, time) * 200) / 2 : k < i ? 100 : 0;
      rows.push({ t: ln.txt || '', c: k === i ? 'cur' : k < i ? 'done' : '', p, g });
      if (o.ro) rows.push({ t: ln.ro || '', c: '', p, k: 'ro', g });
      if (o.tr) rows.push({ t: ln.tr || '', c: '', p, k: 'tr', g });
    }
    if (two) return rows;
    const gc = i < 0 ? 0 : i % 2;   // 只要一句：留唱到的那句（还在前奏就是第一句）
    return rows.filter(r => r.g === gc).map(r => ({ ...r, g: 0 }));
  }
  const p = i < 0 ? 0 : i - (i % 2);
  return [p, p + 1].map(k => ({
    t: k < n ? (L.lines[k].txt || '') : '',
    c: k === i ? 'cur' : k < i ? 'done' : '',
    p: k === i ? Math.round(_mDeskProg(i, time) * 200) / 2 : k < i ? 100 : 0
  }));
}

// ── 桌面歌词独立悬浮窗（桌面版 exe；用户：「词的显示单独离开 app，放在任何页面最上面，可放大缩小」）──
// window.grancyanDesktop.desk 只有 exe 的 preload 才有；浏览器和安卓没有，走上面那套窗口内的版本。
// 悬浮窗是单独的透明置顶窗（deskly-main.js），不依赖点歌台/迷你条开没开：有歌、有词、「词」开着就显示。
// 推给主进程的状态做了去重：rAF 每帧都会走到这里，没变就不发。
function _mDeskX() { try { return (typeof window !== 'undefined' && window.grancyanDesktop && window.grancyanDesktop.desk) || null; } catch (e) { return null; } }
var _mDeskXLast = '';
function _mAccentNow() {
  try { return (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim(); } catch (e) { return ''; }
}
// 字体也带过去（用户：「字幕条和 GranCyan 里面不一样了」——悬浮窗原来写死雅黑，app 里是外观设置选的那套宋体）
function _mFontNow() {
  try { return (getComputedStyle(document.body).fontFamily || '').trim(); } catch (e) { return ''; }
}
function _mDeskXPush(st) {
  const X = _mDeskX(); if (!X) return;
  const s = JSON.stringify(st);
  if (s === _mDeskXLast) return;
  _mDeskXLast = s; X.lyric(st);
}
var _mDeskXWired = false;
(function () {
  const X = _mDeskX();
  if (!X || _mDeskXWired) return;
  _mDeskXWired = true;
  // 在悬浮窗上点了 ✕：「词」开关同步成关；去重缓存清掉，下次再开才会重新发
  if (X.onLyricClosed) X.onLyricClosed(() => { try { localStorage.setItem('kuro_dockLy', '0'); } catch (e) {} _mDeskXLast = ''; _mDockLyric(); });
  // 悬浮窗上点了「音」「译」
  if (X.onLyricOpt) X.onLyricOpt(k => _mDeskOptToggle(k));
})();
function _mDeskProg(k, time) {
  const L = _mLyric, ln = L && L.lines[k];
  if (!ln) return 0;
  if (k < L.idx) return 1;
  if (k > L.idx) return 0;
  if (L.wbw && ln.words && ln.words.length) {
    let tot = 0, done = 0;
    for (const w of ln.words) {
      const n = (w.txt || '').length || 1;
      tot += n;
      if (time >= w.end) done += n; else if (time > w.t) done += n * (time - w.t) / Math.max(.001, w.end - w.t);
    }
    return tot ? Math.min(1, done / tot) : 0;
  }
  return Math.max(0, Math.min(1, (time - ln.t) / _mDeskDur(L, k)));
}
// 行级歌词这一句扫多久：扫到下一句开始。但间奏很长时不能爬 20 秒——一句话最多按每字 .45s 扫，扫完就停在满。
// 手机悬浮条（LyricOverlay.java）拿的就是这个数，两边扫色速度一样
function _mDeskDur(L, k) {
  const ln = L.lines[k], next = L.lines[k + 1];
  const end = ln.end > ln.t ? ln.end : (next ? next.t : ln.t + 4);
  return Math.min(Math.max(.5, end - ln.t), Math.max(1.5, (ln.txt || '').length * .45));
}

// ── 安卓：下拉栏播放卡片 + 后台时的桌面歌词悬浮条（用户）──
// window.GrancyanMusic 只有 APK 的壳才有（MusicBridge.java）。WebView 不替 navigator.mediaSession 建系统会话，
// 所以手机系统里看不到在放什么，得由壳自己建。这里只管把状态推过去，系统那边怎么画是 MusicService.java 的事。
// 悬浮条在 App 退到后台后由壳自己按时钟走（后台 rAF 停了），所以给它的是整首的时间轴，不是每帧的进度。
function _mNative() { try { return (typeof window !== 'undefined' && window.GrancyanMusic) || null; } catch (e) { return null; } }
var _mNativeAt = 0;
function _mNativeState() {
  const N = _mNative(); if (!N || !N.state) return;
  _mNativeAt = Date.now();
  // 遥控电脑时歌在电脑上放，手机这边不挂卡片；重启后装回来、还没按 ▶ 的那首也不挂（不然一开 App 就弹一张）
  const now = _mRemote || (_mNow && _mNow._resume) ? null : _mNow;
  const a = _mAudio;
  let st = { title: '' };
  if (now) {
    let cover = '';
    try { cover = now.cover ? new URL(now.cover, location.href).href : ''; } catch (e) {}
    const live = !_mSwitching && !!(a && now.url && a.src === now.url);   // 换歌途中 <audio> 里还是上一首的时长和位置
    st = { title: now.name || '（未知歌曲）', artist: now.artist || '', cover,
      dur: live && isFinite(a.duration) ? a.duration : 0, pos: live ? a.currentTime || 0 : 0,
      playing: !!(_mSwitching || (a && !a.paused)), rate: (a && a.playbackRate) || 1, accent: _mAccentNow() };
  }
  try { N.state(JSON.stringify(st)); } catch (e) {}
}
var _mNativeLyKey = '';
function _mNativeLyric(want, o) {
  const N = _mNative(); if (!N || !N.lyric) return;
  const L = _mLyric, has = !!(L && L.lines.length) && !_mRemote;
  const on = !!(want && has);
  const accent = _mAccentNow();
  const key = [on, _mNow && _mNow.id, has ? L.lines.length : 0, has && L.lines[0].t, o.ro, o.tr, o.hasRo, o.hasTr, accent].join('|');
  if (key === _mNativeLyKey) return;
  _mNativeLyKey = key;
  const lines = has ? L.lines.map((ln, k) => {
    const r = { s: ln.t || 0, d: _mDeskDur(L, k), t: ln.txt || '' };
    if (ln.ro) r.ro = ln.ro;
    if (ln.tr) r.tr = ln.tr;
    if (L.wbw && ln.words && ln.words.length) r.w = ln.words.map(w => [w.t, w.end, (w.txt || '').length || 1]);
    return r;
  }) : [];
  try { N.lyric(JSON.stringify({ on, n: lines.length, lines, wbw: !!(L && L.wbw), ro: o.ro, tr: o.tr, hasRo: o.hasRo, hasTr: o.hasTr, accent })); } catch (e) {}
}
// 壳那边（卡片按钮、耳机键、悬浮条上的按钮）调回来
function _mNativeCmd(cmd, arg) {
  const a = _mAudio;
  if (cmd === 'play') { if (!a || a.paused) musicToggle(); }
  else if (cmd === 'pause') { if (a && !a.paused) musicToggle(); }
  else if (cmd === 'toggle') musicToggle();
  else if (cmd === 'next') musicNext();
  else if (cmd === 'prev') musicPrev();
  else if (cmd === 'seek') { const t = parseFloat(arg); if (a && isFinite(t)) { try { a.currentTime = Math.max(0, t); } catch (e) {} } }
  else if (cmd === 'ro' || cmd === 'tr') _mDeskOptToggle(cmd);
  else if (cmd === 'lyoff') { try { localStorage.setItem('kuro_dockLy', '0'); } catch (e) {} _mDockLyric(); }
  else if (cmd === 'lyric') _mDockLyToggle();
}
if (typeof window !== 'undefined') window._mNativeCmd = _mNativeCmd;
var _mDeskRaf = 0;
function _mDeskFrame() {
  _mDeskRaf = 0;
  const a = _mAudio;
  if (!a) return;
  _mSyncLyricLine(a.currentTime);
  _mDockLyric();
}
// 长句不折行（用户：「这个字幕显示太满了」——一句俄语折成四行糊了半个屏幕）：
// 先按正常字号量出这一行要多宽，放不下就把这一行单独缩；最多缩到 0.6 倍，再长就单行跟着唱到的位置往左滚（_mDeskScroll）
function _mDeskFit(el) {
  if (!el || !el.children) return;
  const w = el.clientWidth;
  if (!w) return;
  for (const d of el.children) {
    const sp = d.firstElementChild;
    d.style.setProperty('--fit', '1');
    const need = sp ? sp.getBoundingClientRect().width + 8 : 0;
    const fit = need > w ? Math.max(0.6, (w - 1) / need) : 1;
    d.style.setProperty('--fit', String(fit));
    d._over = Math.max(0, need * fit - w); d._w = w;
    d.classList.toggle('over', d._over > 0);
    _mDeskScroll(d, d.classList.contains('done') ? 1 : 0);
  }
}
function _mDeskScroll(d, p) {
  const sp = d && d.firstElementChild; if (!sp || !sp.style) return;
  const off = d._over > 0 ? Math.max(0, Math.min(d._over, p * (d._over + d._w) - d._w * 0.55)) : 0;
  sp.style.transform = off ? `translateX(${(-off).toFixed(1)}px)` : '';
}
function _mDeskLoop(el) { _mDeskLoopOn(!!(el && el.classList.contains('on'))); }
function _mDeskLoopOn(visible) {
  const a = _mAudio;
  const on = !!(a && !a.paused && visible);
  if (on && !_mDeskRaf) _mDeskRaf = requestAnimationFrame(_mDeskFrame);
  if (!on && _mDeskRaf) { cancelAnimationFrame(_mDeskRaf); _mDeskRaf = 0; }
}
function _mDockLyric() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const d = document.getElementById('mzDock');
  const L = _mLyric;
  const has = !!(L && L.lines.length);
  const lyb = d && d.querySelector && d.querySelector('.mz-dk-lyb');
  if (lyb) { lyb.classList.toggle('off', !_mDockLyOn()); lyb.style.display = has ? '' : 'none'; }
  const o = has ? _mDeskOpts() : { hasRo: false, hasTr: false, ro: false, tr: false };
  if (d && d.querySelectorAll) d.querySelectorAll('.mz-dk-lyo').forEach(b => {
    const k = b.getAttribute('data-k');
    b.style.display = has && _mDockLyOn() && (k === 'ro' ? o.hasRo : o.hasTr) ? '' : 'none';
    b.classList.toggle('on', k === 'ro' ? o.ro : o.tr);
  });
  const X = _mDeskX();
  // 悬浮窗不依赖迷你条：只要有歌、有词、「词」开着就显示；窗内那层才要等迷你条挂出来
  const dockUp = !!(d && d.classList.contains('on')) || !!(X && _mNow);
  // 重启后装回来、还没按 ▶ 的那首不弹桌面歌词（不然一开软件就浮出一行不在唱的词）
  const want = !!(dockUp && has && _mDockLyOn() && !(_mNow && _mNow._resume));
  // 安卓悬浮条只在 App 退到后台时出现，不看迷你条挂没挂
  _mNativeLyric(!!(_mNow && has && _mDockLyOn() && !_mNow._resume), o);
  // 桌面版：歌词走独立悬浮窗（浮在所有程序上面），窗内那层不用了
  if (X) {
    const old = document.getElementById('mzDeskLy');
    if (old) { old.classList.remove('on'); old._k = ''; old.innerHTML = ''; }
    if (!want) { _mDeskXPush({ on: false }); _mDeskLoopOn(false); return; }
    const a = _mAudio;
    const rows = _mDeskRows(L, a ? a.currentTime : 0, o, true);
    _mDeskXPush({ on: true, rows, accent: _mAccentNow(), font: _mFontNow(), opts: o });
    _mDeskLoopOn(true);
    return;
  }
  let el = document.getElementById('mzDeskLy');
  if (!el && want) {
    const host = document.querySelector('main'); if (!host) return;
    el = document.createElement('div');
    el.id = 'mzDeskLy';
    el.className = 'mz-desk';
    el.addEventListener('pointerdown', _mDeskDragStart);
    host.appendChild(el);
  }
  if (!el) return;
  el.classList.toggle('on', want);
  if (!want) { el._k = ''; el.innerHTML = ''; _mDeskLoop(el); return; }
  const i = L.idx, a = _mAudio, t = a ? a.currentTime : 0;
  // 窗内那层字号是写死的 clamp，「够大」就看画面：电脑浏览器的大窗口两句一页，手机/小窗一句
  const two = typeof window !== 'undefined' && window.innerHeight >= 720 && window.innerWidth >= 760;
  const rows = _mDeskRows(L, t, o, two);
  const key = L.lines.length + '|' + i + '|' + rows.map(r => r.c + '|' + (r.k || '') + '|' + r.t).join('\n');
  if (el._k !== key) {
    el._k = key;
    el.classList.toggle('sub', !!(o.ro || o.tr));
    // 副行的 --p 跟着自己那句：唱过的那句的罗马音是满的，没唱到的是空的
    el.innerHTML = rows.map(r => `<div class="mz-dl-l${r.c ? ' ' + r.c : ''}${r.k ? ' ' + r.k : ''}${r.g ? ' g1' : ''}" style="--p:${r.c === 'done' ? 100 : r.k ? r.p || 0 : 0}%"><span>${escHtml(r.t)}</span></div>`).join('');
    _mDeskFit(el);
    _mDeskPlace(el);
  }
  // 当前句（和它的罗马音）跟着进度扫色；翻译不扫，只在放不下时跟着滚。
  // 副行认「紧跟在 .cur 后面的那几行」：两句一页时第一句也有自己的 .ro/.tr，querySelector('.ro') 会拿错
  if (i >= 0 && i < L.lines.length && el.querySelector) {
    const pr = _mDeskProg(i, t);
    const cur = el.querySelector('.cur');
    const list = cur ? [cur] : [];
    for (let s = cur && cur.nextElementSibling; s && s.classList && (s.classList.contains('ro') || s.classList.contains('tr')); s = s.nextElementSibling) list.push(s);
    list.forEach(d => {
      if (!d || !d.style) return;
      if (!(d.classList && d.classList.contains('tr'))) d.style.setProperty('--p', (pr * 100).toFixed(1) + '%');
      if (d._over > 0) _mDeskScroll(d, pr);
    });
  }
  _mDeskLoop(el);
}
function musicToggleLyricsFull(on) {
  const m = document.getElementById('musicModal'); if (!m || !_mNow) return;
  const next = typeof on === 'boolean' ? on : !m.classList.contains('music-lyrics-full');
  m.classList.toggle('music-lyrics-full', next);
  document.querySelectorAll('.mz-i-full').forEach(b => b.classList.toggle('on', next));
  // 进全屏＝要干净的一整屏：开着的抽屉先收起。全屏里点搜索/歌单还能再拉出来（以前全屏把抽屉 display:none，点了没反应）
  if (next && _mDrawerOpen) _mDrawerSet(false);
  _mVisSync(); _mScopeSync();
  // 全屏一开一关，容器宽度和字号都换了 —— 镜头必须重测。
  // 放在 rAF 里是因为要等新的 class 真的生效、布局重排完，否则量到的还是旧尺寸。
  requestAnimationFrame(() => { _mTick(); _mCineRemeasure(); });
}

// 歌词的几个小开关。都要落盘——每次进来重设一遍等于没有设置。
// 第二个参数是"没存过的时候算开还是关"，翻译默认开、罗马音默认关。
function musicToggleLyricOpt(key, defOn) {
  const cur = state[key] === undefined ? !!defOn : !!state[key];
  state[key] = !cur;
  save();
  _mPaintLyric();
  _mTick();
  musicRefresh(true);
}
function _mOptOn(key, defOn) { return state[key] === undefined ? !!defOn : !!state[key]; }

// 歌词排版：经典滚动 → Tilt 错落 → Cinema 影院。清单来自 01-core，同 musicCycleVis。
// 这两张表按 key 查、缺了回落，所以 01-core 加新样式时这里不改也不会崩（只是没名字/没图标）
var _mStyleNames = { scroll: '经典滚动', tilt: 'Tilt 错落', cinema: 'Cinema 影院' };
var _mStyleIcons = { scroll: '≡', tilt: '⌇', cinema: '◆' };
function musicCycleLyricStyle() {
  const list = MUSIC_LYRIC_STYLES;
  const i = list.indexOf(musicLyricStyleNorm(state.musicLyricStyle));
  state.musicLyricStyle = list[(i + 1) % list.length];
  save();
  _mPaintLyric();
  _mTick();                       // 立刻把当前行和当前字补上，别等下一帧
  musicRefresh(true);
  showToast('歌词：' + (_mStyleNames[state.musicLyricStyle] || state.musicLyricStyle), 'info', 1200);
}
// 背景在几种模式之间轮换。顺序就是按钮点下去的顺序，最后回到关。
// 清单来自 01-core 的 MUSIC_VIS_MODES——持久化那三道关认的是同一份，
// 在这里另抄一份的话，加了模式却存不住，且零报错。
// 在函数里取而不是在顶层存个别名：顶层引用会绑死 script 标签的先后顺序。
var _mVisNames = { aurora: '流光', fluid: '封面流体', geo: '几何', off: '关闭' };
var _mVisIcons = { aurora: '✦', fluid: '◍', geo: '◇', off: '✧' };
function musicCycleVis() {
  const modes = MUSIC_VIS_MODES;
  const i = modes.indexOf(state.musicVis);
  state.musicVis = modes[(i < 0 ? 0 : i + 1) % modes.length];
  save();
  _mVisSync();
  musicRefresh(true);
  showToast('背景：' + (_mVisNames[state.musicVis] || state.musicVis), 'info', 1200);
}
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('musicModal');
  if (!m || m.classList.contains('hidden')) return;
  // 一层一层退：弹出的小菜单 → 手机上盖着的抽屉 → 全屏歌词 → 关面板
  if (document.getElementById('mzPop')) _mPopClose();
  else if (_mDrawerOpen && !_mWide()) _mDrawerSet(false);
  else if (m.classList.contains('music-lyrics-full')) musicToggleLyricsFull(false);
  else closeMusic();
});

async function musicDoSearch() {
  const inp = document.getElementById('musicSearchIn');
  const q = (inp?.value || '').trim();
  if (!q) return;
  musicSearchNote(q);
  _mSearching = true; musicRefresh(true);
  try {
    _mResults = await musicSearch(q, 15);
    _mExternalResults = [];
    if (!musicSearchHasMatch(q, _mResults)) {
      try { _mExternalResults = await musicSearchApple(q); } catch (e) { console.warn('[点歌] Apple Music 目录查询失败:', e); }
    }
    if (!_mResults.length && !_mExternalResults.length) showToast('没搜到这首歌～换个说法试试', 'info', 2500);
  } catch (e) {
    showToast((window.GrancyanBand || window.GrancyanMusic) ? '手机直连网易云失败，请检查网络后重试' : '搜索要连着电脑的后端服务才行（设置里的 📡 后端服务器）', 'error', 4000);
  } finally {
    _mSearching = false; musicRefresh(true);
  }
}
function musicSearchKey(ev) { if (ev.key === 'Enter') { ev.preventDefault(); musicDoSearch(); } }

// 搜索记录：她自己在框里搜的词（AI 点歌不算）。最多 20 条，新的在前，跟着云同步走。
// 同一个词再搜一次是「顶到最前」，不是多一条
function _mSearchHist() { if (!Array.isArray(state.musicSearchHist)) state.musicSearchHist = []; return state.musicSearchHist; }
function musicSearchNote(q) {
  const k = _mSearchKey(q); if (!k) return;
  const ts = _mOp(_mSyncOps().search, k, 'a');
  state.musicSearchHist = [{ q: String(q).trim().slice(0, 80), ts }, ..._mSearchHist().filter(x => _mSearchKey(x.q) !== k)].slice(0, 20);
  save();
}
function musicSearchForget(i) {
  const h = _mSearchHist(), x = h[i]; if (!x) return;
  h.splice(i, 1);
  _mOp(_mSyncOps().search, _mSearchKey(x.q), 'd');
  save(); musicRefresh();
}
function musicSearchClearHist() {
  const h = _mSearchHist(); if (!h.length) return;
  const ops = _mSyncOps().search;
  h.forEach(x => _mOp(ops, _mSearchKey(x.q), 'd'));
  state.musicSearchHist = [];
  save(); musicRefresh();
}
function musicSearchFromHist(i) {
  const x = _mSearchHist()[i]; if (!x) return;
  const inp = document.getElementById('musicSearchIn');
  if (inp) inp.value = x.q;
  return musicDoSearch();
}

// 列表里点一首：直接放；按住的那个 ＋ 是加进队列
function musicPlayFromList(i) { const s = _mResults[i]; if (s) musicPlay(s); }
function musicQueueFromList(i) {
  const s = _mResults[i]; if (!s) return;
  _mQueue.push(s); _mSessSave();
  _mRCQueue();
  showToast(`已加入队列：${s.name}`, 'success', 2000);
  musicRefresh(true);
}

// ── 小幽灵＝「杀歌及列表」（用户稿子里的图层名）：点开是队列页，最上面那行能杀歌 ──
function musicQueueRemove(i) { if (_mQueue[i]) { _mQueue.splice(i, 1); _mSessSave(); _mRCQueue(); musicRefresh(); } }
function musicQueueTop(i) { const s = _mQueue.splice(i, 1)[0]; if (s) { _mQueue.unshift(s); _mSessSave(); _mRCQueue(); musicRefresh(); } }
function musicQueuePlay(i) { const s = _mQueue.splice(i, 1)[0]; if (s) musicPlay(s); }
function musicQueueClear() { _mQueue = []; _mCtx = null; _mSessSave(); _mRCQueue(); musicRefresh(); showToast('队列清空了', 'info', 1500); }
// 杀歌：这首掐掉，回到什么都不放（用户说的，不是跳下一首——跳下一首有 ⏭）。
// 手机上抽屉顺手收起来，让她看见面板回到「还没在放」
function musicKill() {
  musicStop();
  if (!_mWide()) _mDrawerSet(false);
}
function musicPlayRecent(i) { const s = (state.musicRecent || [])[i]; if (s) musicPlay(s); }

// ── 面板（照作者手画的设计稿）──
//
// 手机照稿子排：左上「点歌」块 + 大歌名，右边一列是 搜索/收藏/歌单、进度条（那只像素猫）、
// 一排控制键；中间是唱片 + 一圈频谱；下面两句歌词；最底下是 mascot、四角星、磁带。
// 电脑版是我排的：唱片和歌词左右并排（横屏竖着堆太浪费），搜索/收藏/歌单/队列
// 变成常驻在右边的抽屉。两边共用同一份 DOM，差别全在 CSS 的 min-width:1000px 里。
//
// 图标全是作者手画的，导出成白色遮罩（img/music/*.png），用 mask-image 刷成 --accent，
// 所以换主题色时整套跟着变——要求是「这个蓝色其实要遵循主题色」。
// 背景那几层（网格、星星、频谱、角色）写死在 index.html 里，不在这里拼，原因见那边的注释。
var _mDrawerOpen = null;   // null = 这次会话还没开过面板，openMusic 按屏宽定默认值
function _mWide() {
  try { return !!(window.matchMedia && window.matchMedia('(min-width: 1000px)').matches); } catch (e) { return false; }
}

// 歌名按「视觉长度」分档：稿子里两个字的歌名是巨大的，长歌名照那个字号会把右边一列挤没。
// 中日韩字算 1，拉丁字母算 0.56（等宽下大约是汉字的一半多）。
function _mTitleSize(s) {
  let w = 0;
  for (const ch of String(s || '')) w += /[\u2e80-\uffff]/.test(ch) ? 1 : 0.56;
  return w <= 3.2 ? 'mz-t-xl' : w <= 6 ? 'mz-t-l' : w <= 11 ? 'mz-t-m' : 'mz-t-s';
}

// 单击唱片/歌词那块＝沉浸歌词开关（用户：先要双击，用了一下说单击更顺手）。
// 按下和抬起配对着认：挪超过 10px（拨唱片、划选歌词）、按太久、或者这一下是去按停转着的唱片，都不算点。
// 触屏滑歌词走的是 pointercancel，不会误触；按钮上的点击不算
var _mTapDown = null;
// .ly-t：点歌词时间戳是「跳到这句」，不能顺手把沉浸也切了
// 选择歌词的时候点句子是在勾选，也不切沉浸
function _mTapIgnored(ev) { return ev.button > 0 || !!(ev.target && ev.target.closest && ev.target.closest('button,a,input,.ly-t,.mz-lysel,.ly-sel .music-ly-line')); }
function _mMainDown(ev) {
  _mTapDown = _mTapIgnored(ev) ? null : { t: performance.now(), x: ev.clientX, y: ev.clientY, caught: _mSpinCaught };
  _mSpinCaught = false;
}
function _mMainTap(ev) {
  const d = _mTapDown; _mTapDown = null;
  if (!d || _mTapIgnored(ev) || d.caught) return;
  if (performance.now() - d.t > 500 || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 10) return;
  musicToggleLyricsFull();
}

// 唱片能拿手指拨着转（用户）。只是个玩具，不碰声音——搓碟会吵。
// 手拨的角度记在 _mSpinDeg，挂在封面图上（--mz-spin），和唱盘本身 12 秒一圈的自转叠加；
// 重画面板会重建节点，所以角度存在变量里、渲染时写回去。
// 按住不动＝把唱片按停：放歌时唱盘还在自转，就每帧往回扣同样的角度抵消掉。
var _mSpinDeg = 0, _mSpinDrag = null, _mSpinV = 0, _mSpinRaf = 0, _mSpinCaught = false;
const _M_SPIN_NATURAL = 360 / 12000;   // 唱盘自转：度/毫秒，跟 css 的 mzSpin 12s 对齐
function _mSpinApply() {
  _mSpinDeg = ((_mSpinDeg % 360) + 360) % 360;
  const img = document.querySelector('#mzDisc .mz-cover');
  if (img) img.style.setProperty('--mz-spin', _mSpinDeg.toFixed(2) + 'deg');
}
function _mSpinAngle(ev, el) {
  const r = el.getBoundingClientRect(), dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
  return { a: Math.atan2(dy, dx) * 180 / Math.PI, far: Math.hypot(dx, dy) > 8 };   // 圆心附近角度乱跳，不认
}
function _mSpinNaturalOn() {
  const p = document.querySelector('#mzDisc .mz-platter');
  return !!(p && p.getAnimations && p.getAnimations().length);
}
function _mSpinDown(ev, el) {
  if (ev.button > 0) return;
  _mSpinCaught = !!_mSpinRaf;           // 还在惯性转的时候按下去＝接住它，不当成点击
  _mSpinStopFly();
  const g = _mSpinAngle(ev, el);
  _mSpinDrag = { id: ev.pointerId, el, a: g.a, t: performance.now(), v: 0, natural: _mSpinNaturalOn() };
  try { el.setPointerCapture(ev.pointerId); } catch (_) {}
  _mSpinHold();
}
function _mSpinMove(ev, el) {
  const d = _mSpinDrag; if (!d || ev.pointerId !== d.id) return;
  const g = _mSpinAngle(ev, el); if (!g.far) return;
  let da = g.a - d.a; if (da > 180) da -= 360; else if (da < -180) da += 360;
  const t = performance.now(), dt = Math.max(1, t - d.t);
  _mSpinDeg += da;
  d.v = d.v * 0.4 + (da / dt) * 0.6;    // 最近几下的平均角速度，松手时拿它甩出去
  d.a = g.a; d.t = t;
  _mSpinApply();
}
function _mSpinUp(ev) {
  const d = _mSpinDrag; if (!d || ev.pointerId !== d.id) return;
  _mSpinDrag = null;
  // 停下来再松手（最后一下挪动过去 80ms 以上）＝不甩
  // 封顶 1.5°/ms（一秒四圈多），使劲一甩也不至于转成一团糊
  const v = performance.now() - d.t > 80 ? 0 : Math.max(-1.5, Math.min(1.5, d.v));
  if (Math.abs(v) > 0.02) { _mSpinV = v; _mSpinFly(); }
}
// 按住期间：唱盘在自转就逐帧倒扣，看起来是被按停了
function _mSpinHold() {
  let last = performance.now();
  const step = now => {
    const d = _mSpinDrag; if (!d) return;
    // 按着的时候面板被重画（切歌/暂停）：旧节点连同捕获一起没了，pointerup 不会再来，自己松手
    if (d.el && d.el.isConnected === false) { _mSpinDrag = null; return; }
    if (d.natural) { _mSpinDeg -= _M_SPIN_NATURAL * (now - last); _mSpinApply(); }
    last = now;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// 松手后的惯性：摩擦慢慢收掉，最后并回唱盘自己的转速
function _mSpinFly() {
  let last = performance.now();
  const step = now => {
    const dt = Math.min(64, now - last); last = now;
    _mSpinDeg += _mSpinV * dt;
    _mSpinV *= Math.pow(0.97, dt / 16);
    _mSpinApply();
    if (Math.abs(_mSpinV) < 0.01) { _mSpinRaf = 0; return; }
    _mSpinRaf = requestAnimationFrame(step);
  };
  _mSpinRaf = requestAnimationFrame(step);
}
function _mSpinStopFly() { if (_mSpinRaf) cancelAnimationFrame(_mSpinRaf); _mSpinRaf = 0; _mSpinV = 0; }

// 主界面那颗星：有歌在放＝收藏/取消这首（用户：点一下实心，再点一下空心）；
// 没在放就没东西可收藏，照旧打开收藏页。收藏列表从抽屉顶上的「收藏」页签进
function musicStarTap() {
  if (_mNow) musicToggleFav(_mNow); else musicNav('fav');
}

// 一个手画图标按钮。图标是 CSS 类（mz-i-xxx）而不是内联 --ic:url()：
// url() 放进自定义属性后按谁的地址解析，各家浏览器不一致，写在同一份 css 里最稳。
function _mIc(icon, fn, title, extra) {
  return `<button type="button" class="mz-ic mz-i-${icon}${extra ? ' ' + extra : ''}" onclick="${fn}" title="${escHtml(title)}" aria-label="${escHtml(title)}"></button>`;
}

function musicRefresh(force) {
  // 播放/暂停/切歌/改队列最后都会走到这里——正好当「状态变了」的信号报给遥控模块（它自己去重、防抖）
  if (typeof musicRemoteNote === 'function') musicRemoteNote();
  _mDockSync();   // 点歌台关着时下面那句会提前 return，迷你条必须在它前面刷
  const m = document.getElementById('musicModal');
  const body = document.getElementById('musicBody');
  if (!body || !m) return;
  if (m.classList.contains('hidden') && !force) return;
  _mDrWApply(m);

  const keep = document.getElementById('musicSearchIn')?.value || '';
  // 抽屉里翻到哪了：重画会把滚动位置归零，收藏翻到第 80 首时点一下心就被弹回顶上
  const drTop = document.getElementById('mzDrawerBody')?.scrollTop || 0;
  // 在收藏/歌单里找歌时，切歌、点心、滚到底续行都会整面板重画——框里的字在 _mListQ 里，光标得还回去
  const lq = document.getElementById('musicListQ');
  const lqSel = lq && document.activeElement === lq ? [lq.selectionStart, lq.selectionEnd] : null;

  const a = _mAudio;
  const now = _mNow;
  const playing = !!(a && !a.paused && now);
  const vinylPhase = (((Number(a?.currentTime) || 0) % 12) / 12 * 360).toFixed(2);
  const fav = !!(now && musicIsFav(now.id));
  const tabOn = t => (_mDrawerOpen && _mTab === t) ? ' on' : '';
  const modeIc = { list: 'mode-list', one: 'mode-one', shuffle: 'mode-shuffle' }[_mMode] || 'mode-list';
  const cover = now && now.cover ? escHtml(now.cover) : 'img/music/cover-default.jpg';

  let h = `<div class="mz-stage${playing ? ' is-playing' : ''}${now ? '' : ' is-idle'}">
  <div class="mz-top">
    <span class="mz-badge">点歌</span>
    ${typeof musicRemoteBtn === 'function' ? musicRemoteBtn() : ''}
    <label class="mz-ai" title="打开后 AI 能在聊天里给你放歌">
      <input type="checkbox" id="musicToggle"${musicEnabled() ? ' checked' : ''} onchange="toggleMusic(this.checked)">
      <i class="mz-box" aria-hidden="true"></i><span>接入对话<small>（AI 点歌）</small></span>
    </label>
    ${_mIc('close', 'closeMusic()', '关闭', 'mz-x')}
  </div>
  <section class="mz-head">
    <div class="mz-titles">
      <div class="mz-title ${_mTitleSize(now ? now.name : '还没在放')}"${now ? ` title="${escHtml(now.name)}"` : ''}>${now ? escHtml(now.name) : '还没在放'}</div>
      <div class="mz-artist">${now ? escHtml(now.artist || '') : '搜一首，或者让 AI 给你点'}${fav ? '<i class="mz-faved" title="在收藏里" aria-label="已收藏"></i>' : ''}</div>
      ${now && now.feat ? `<div class="mz-feat" title="${escHtml(now.feat.hint || '')}">${escHtml(musicSongTags(now.feat))}</div>` : ''}
    </div>
    <div class="mz-side">
      <nav class="mz-nav">
        ${_mIc('search', "musicNav('search')", '搜索', 'mz-nav-b' + tabOn('search'))}
        ${_mIc('fav', 'musicStarTap()', now ? (fav ? '已收藏（再点一下取消）' : '收藏这首') : '收藏', 'mz-nav-b' + tabOn('fav') + (fav ? ' faved' : ''))}
        ${_mIc('list', "musicNav('lists')", '歌单', 'mz-nav-b' + tabOn('lists'))}
      </nav>
      <div class="mz-barrow">
        <div class="music-bar mz-bar" onpointerdown="musicSeekStart(event,this)" onpointermove="musicSeekMove(event,this)" onpointerup="musicSeekEnd(event,this)" onpointercancel="musicSeekEnd(event,this)"><i class="music-fill"></i></div>
        <div class="mz-time"><span class="music-t-cur">${_mFmt(a?.currentTime)}</span><span class="music-t-dur">${_mFmt(a?.duration)}</span></div>
      </div>
      <div class="mz-ctrl">
        ${_mIc('prev', 'musicPrev()', '上一首')}
        ${_mIc(playing ? 'pause' : 'play', now ? 'musicToggle()' : 'musicPlayLast()', playing ? '暂停' : '播放', 'mz-play')}
        ${_mIc('next', 'musicNext()', '下一首')}
        ${_mIc(modeIc, 'musicCycleMode()', _M_MODE_NAMES[_mMode] + '（点一下切换）')}
        ${_mIc('queue', "musicNav('queue')", '队列 · 杀歌', tabOn('queue').trim())}
        ${_mIc('add', 'musicAddMenu(this)', '收藏 / 加进歌单')}
        ${_mIc('full', 'musicToggleLyricsFull()', '沉浸歌词', m.classList.contains('music-lyrics-full') ? 'on' : '')}
        <button type="button" class="mz-rate" onclick="musicCycleRate()" title="播放速度（点一下切换）">${_mRateText()}</button>
      </div>
    </div>
  </section>
  <section class="mz-main" onpointerdown="_mMainDown(event)" onpointerup="_mMainTap(event)">
    <div class="mz-disc-wrap"><div class="mz-disc" id="mzDisc" onpointerdown="_mSpinDown(event,this)" onpointermove="_mSpinMove(event,this)" onpointerup="_mSpinUp(event)" onpointercancel="_mSpinUp(event)">
      <div class="mz-platter" style="--vinyl-phase:${vinylPhase}deg"><img class="mz-cover" src="${cover}" alt="" draggable="false" style="--mz-spin:${((_mSpinDeg % 360) + 360) % 360}deg"></div>
    </div></div>
    <div class="mz-ly-wrap">${now
      ? '<div class="music-lyric" id="musicLyric"></div><div class="mz-ly-opts" id="mzLyOpts"></div>'
      : `<div class="mz-ly-idle"><b>歌词会显示在这里</b><span>点上面的 🔍 找一首</span></div>`}</div>
  </section>
  <button type="button" class="mz-more" onclick="musicMoreMenu(this)" title="更多" aria-label="更多"><i></i><i></i><i></i></button>
</div>
<div class="mz-scrim" onclick="_mDrawerSet(false)"></div>
<aside class="mz-drawer${_mDrawerOpen ? ' open' : ''}" id="mzDrawer">
  <div class="mz-dr-resize" onpointerdown="_mDrResizeDown(event)" ondblclick="_mDrResizeReset()" title="左右拖动调宽度（双击恢复）"><i></i></div>
  <div class="mz-dr-grab" onclick="_mDrawerSet(false)" title="收起"><i></i></div>
  <div class="mz-dr-body" id="mzDrawerBody" onscroll="_mDrawerScroll(this)">${musicSectionsHtml()}${_mTab === 'search' ? _mSearchHtml(keep) : ''}</div>
</aside>`;

  body.innerHTML = h;
  if (body.classList) body.classList.toggle('mz-dr-open', !!_mDrawerOpen);
  const dr = document.getElementById('mzDrawerBody'); if (dr && drTop) dr.scrollTop = drTop;
  _mPaintLyric();
  _mTick();
  _mVisSync();
  // 重画会把光标顶掉，正在打字的人得把光标要回来
  const inp = document.getElementById('musicSearchIn');
  if (inp && keep && document.activeElement !== inp) {
    inp.focus(); inp.setSelectionRange(keep.length, keep.length);
  }
  const lq2 = lqSel && document.getElementById('musicListQ');
  if (lq2) { try { lq2.focus({ preventScroll: true }); lq2.setSelectionRange(lqSel[0], lqSel[1]); } catch (e) {} }
}

// 面板里没有在放的歌时按 ▶：接着放最近听过的那首，别让大按钮是死的
function musicPlayLast() {
  const s = (state.musicRecent || [])[0];
  // 重启后队列是从落盘里装回来的（不含正在放的那首）：最近那首若还躺在队列里，剔掉，免得放完又来一遍
  if (s) { _mQueue = _mQueue.filter(q => !_mSameSong(q.id, s.id)); musicPlay(s); } else musicNav('search');
}

// 搜索页（抽屉里）
function _mSearchHtml(keep) {
  let h = `<div class="music-search">
    <input id="musicSearchIn" class="music-search-in" type="text" placeholder="搜歌名 / 歌手…"
      value="${escHtml(keep)}" onkeydown="musicSearchKey(event)" spellcheck="false">
    <button class="music-search-go" onclick="musicDoSearch()">${_mSearching ? '搜索中…' : '搜索'}</button>
  </div>`;
  if (_mExternalResults.length) {
    h += `<div class="music-sub-t">Apple Music · 官方试听</div><div class="music-list">`;
    _mExternalResults.forEach(s => {
      h += `<div class="music-row music-row-external">
        <span class="music-row-name">${escHtml(s.name)}</span>
        <span class="music-row-artist">${escHtml(s.artist)}</span>
        ${s.preview ? `<audio controls preload="none" src="${escHtml(s.preview)}" aria-label="试听 ${escHtml(s.name)}"></audio>` : ''}
        <a class="music-row-q" href="${escHtml(s.url)}" target="_blank" rel="noopener" title="在 Apple Music 打开完整版">↗</a>
      </div>`;
    });
    h += `</div>`;
  }
  if (_mResults.length) {
    h += `<div class="music-list">`;
    _mResults.forEach((s, i) => {
      h += `<div class="music-row${_mNow && String(_mNow.id) === String(s.id) ? ' on' : ''}">
        <span class="music-row-name" onclick="musicPlayFromList(${i})">${escHtml(s.name)}</span>
        <span class="music-row-artist" onclick="musicPlayFromList(${i})">${escHtml(s.artist)}</span>
        <span class="music-row-dur">${_mFmt((s.duration || 0) / 1000)}</span>
        <button class="music-row-q" onclick="event.stopPropagation();musicQueueFromList(${i})" title="加入队列">⏭</button>
        <button class="music-row-q" onclick="event.stopPropagation();musicAddFromList(${i},this)" title="加进歌单">＋</button>
        ${_mHeartBtn(s, `musicFavFromList(${i})`)}
      </div>`;
    });
    h += `</div>`;
  }
  const hist = state.musicSearchHist || [];
  if (hist.length && !_mResults.length && !_mExternalResults.length && !_mSearching) {
    h += `<div class="music-sub-t">搜过<button class="music-pl-new" onclick="musicSearchClearHist()">清空</button></div><div class="mz-hist">`;
    hist.slice(0, 20).forEach((x, i) => {
      h += `<span class="mz-hist-chip"><button type="button" class="mz-hist-q" onclick="musicSearchFromHist(${i})">${escHtml(x.q)}</button><button type="button" class="mz-hist-x" onclick="musicSearchForget(${i})" title="删掉这条" aria-label="删掉这条">×</button></span>`;
    });
    h += `</div>`;
  }
  const rec = state.musicRecent || [];
  if (rec.length && !_mResults.length) {
    h += `<div class="music-sub-t">最近听过</div><div class="music-list">`;
    rec.slice(0, 12).forEach((s, i) => {
      h += `<div class="music-row" onclick="musicPlayRecent(${i})">
        <span class="music-row-name">${escHtml(s.name)}</span>
        <span class="music-row-artist">${escHtml(s.artist || '')}</span>
      </div>`;
    });
    h += `</div>`;
  }
  return h;
}

// 队列页：正在放的 + 接下来的
function _mRenderQueue() {
  let h = '';
  if (_mNow) {
    h += `<div class="music-sub-t">正在放</div><div class="music-list"><div class="music-row on">
      <span class="music-row-name">${escHtml(_mNow.name)}</span>
      <span class="music-row-artist">${escHtml(_mNow.artist || '')}</span>
      <button class="music-row-q mz-kill" onclick="musicKill()" title="这首掐掉，什么都不放">杀歌 ✕</button>
    </div></div>`;
  }
  h += `<div class="music-sub-t">接下来 · ${_mQueue.length} 首 · ${_M_MODE_NAMES[_mMode]}${_mQueue.length ? '<button class="music-pl-new" onclick="musicQueueClear()">清空</button>' : ''}</div>`;
  if (!_mQueue.length) {
    return h + `<div class="music-idle">队列是空的<br><span class="study-dim">${_mCtx && _mCtx.length && _mMode !== 'one' ? '放完这首会从单子开头再来一轮' : '搜索结果旁边的 ⏭ 能把歌排进来'}</span></div>`;
  }
  h += `<div class="music-list">`;
  _mQueue.forEach((s, i) => {
    h += `<div class="music-row">
      <span class="music-row-name" onclick="musicQueuePlay(${i})">${escHtml(s.name)}</span>
      <span class="music-row-artist" onclick="musicQueuePlay(${i})">${escHtml(s.artist || '')}</span>
      ${i ? `<button class="music-row-q" onclick="event.stopPropagation();musicQueueTop(${i})" title="下一首就放它">↑</button>` : ''}
      <button class="music-row-q" onclick="event.stopPropagation();musicQueueRemove(${i})" title="从队列里拿掉">－</button>
    </div>`;
  });
  return h + `</div>`;
}

// 顶上那三个图标 + 气泡脸：点一下打开抽屉并切到那一页，再点同一个就收起来
function musicNav(tab) {
  if (_mDrawerOpen && _mTab === tab) { _mDrawerSet(false); return; }
  const wasOpen = !!_mDrawerOpen;
  if (tab !== _mTab || _mViewList) _mListQ = '';
  _mTab = tab; _mViewList = null;
  if (wasOpen) { musicRefresh(); _mFocusSearch(); return; }
  // 从关着打开：先按「关着」画一遍再加 open，抽屉才有滑出来的过程（新建的节点直接带 open 是没有过渡的）
  _mDrawerOpen = false;
  musicRefresh();
  _mDrawerSet(true);
}
function _mDrawerSet(on) {
  _mDrawerOpen = !!on;
  const d = document.getElementById('mzDrawer');
  if (d) { void d.offsetWidth; d.classList.toggle('open', _mDrawerOpen); }
  const body = document.getElementById('musicBody');
  if (body && body.classList) body.classList.toggle('mz-dr-open', _mDrawerOpen);
  document.querySelectorAll('.mz-nav-b').forEach(b => b.classList.remove('on'));
  if (_mDrawerOpen) {
    const k = { search: 'search', fav: 'fav', lists: 'list', queue: 'queue' }[_mTab];
    document.querySelectorAll('.mz-stage .mz-i-' + k).forEach(b => b.classList.add('on'));
    _mFocusSearch();
  } else {
    // 小幽灵不是 .mz-nav-b（它在控制栏里），上面那句清不到它
    document.querySelectorAll('.mz-stage .mz-i-queue').forEach(b => b.classList.remove('on'));
  }
  // 宽屏上抽屉开合会改变唱片那一栏的宽度，频谱圈要跟着重新量（下一帧自己会量，不用管）
}
// 电脑上右边那条抽屉能拉宽拉窄（用户）。左边缘那根竖条是把手，只在宽屏的 css 里出现；
// 宽度写进 #musicModal 的 --mz-dw（抽屉宽、唱片那栏让出的 margin、小家伙们的避让全吃这一个变量），
// 记在 localStorage：是这台电脑的窗口习惯，不跟手机同步。
// 拖的时候给面板挂 mz-dr-drag，把舞台 margin 的 .32s 过渡关掉——不然唱片那栏拖着拖着一顿一顿地追手指。
const _M_DRW_MIN = 300, _M_DRW_DEF = 380, _M_DRW_KEY = 'kuro_musicDrawerW';
var _mDrW = 0, _mDrDrag = null;
try { _mDrW = +localStorage.getItem(_M_DRW_KEY) || 0; } catch (e) {}
function _mDrWClamp(w) {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1400;
  // 上限：抽屉最多占六成，唱片+歌词那栏至少留 420px
  return Math.round(Math.max(_M_DRW_MIN, Math.min(w, vw * 0.6, vw - 420)));
}
function _mDrWApply(m) {
  m = m || document.getElementById('musicModal');
  if (!m || !m.style) return;
  if (_mDrW) m.style.setProperty('--mz-dw', _mDrWClamp(_mDrW) + 'px');
  else m.style.removeProperty('--mz-dw');
}
function _mDrResizeDown(ev) {
  if (ev.button > 0) return;
  const d = document.getElementById('mzDrawer'), m = document.getElementById('musicModal');
  if (!d || !m) return;
  ev.preventDefault();
  _mDrDrag = { x: ev.clientX, w: d.getBoundingClientRect().width, w0: _mDrW, id: ev.pointerId, over: 0 };
  m.classList.add('mz-dr-drag');
  const move = e => {
    if (!_mDrDrag || e.pointerId !== _mDrDrag.id) return;
    const raw = _mDrDrag.w + (_mDrDrag.x - e.clientX);   // 把手在左边：往左拖＝变宽
    _mDrW = _mDrWClamp(raw);
    _mDrWApply(m);
    // 窄到底了还往右拖：抽屉整个跟着手往右滑，松手时滑出去够远就收起（苹果侧栏那样拖过头就合上）
    _mDrDrag.over = Math.max(0, _M_DRW_MIN - raw);
    _mDrSlide(_mDrDrag.over);
  };
  const up = e => {
    if (!_mDrDrag || e.pointerId !== _mDrDrag.id) return;
    const drag = _mDrDrag;
    _mDrDrag = null;
    m.classList.remove('mz-dr-drag');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    const close = drag.over >= _M_DR_SWIPE_CLOSE;
    // 拖过头收起的：宽度退回拖之前那个，下次打开还是原来的宽，不是被挤到的最窄
    if (close) { _mDrW = drag.w0; _mDrWApply(m); }
    _mDrSlideEnd(close);
    try { localStorage.setItem(_M_DRW_KEY, String(_mDrW)); } catch (e2) {}
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
function _mDrResizeReset() {
  _mDrW = 0;
  try { localStorage.removeItem(_M_DRW_KEY); } catch (e) {}
  _mDrWApply();
}
// 电脑上往右划收起抽屉（用户）：触控板两指往右划，或者把手拖过最窄。
// 划的过程中抽屉跟着手走（行内 transform，挂 mz-dr-swipe 关掉过渡），过了阈值就挂 mz-dr-will 变淡提示「松手就收」；
// 松手时够远就 _mDrawerSet(false)，不够就弹回去。
const _M_DR_SWIPE_CLOSE = 90;
function _mDrSlide(px) {
  const d = document.getElementById('mzDrawer'), m = document.getElementById('musicModal');
  if (!d || !m) return;
  px = Math.max(0, px);
  m.classList.add('mz-dr-swipe');
  m.classList.toggle('mz-dr-will', px >= _M_DR_SWIPE_CLOSE);
  d.style.transform = px ? `translateX(${Math.round(px)}px)` : '';
}
function _mDrSlideEnd(close) {
  const d = document.getElementById('mzDrawer'), m = document.getElementById('musicModal');
  if (m) { m.classList.remove('mz-dr-swipe', 'mz-dr-will'); }
  if (d) { void d.offsetWidth; d.style.transform = ''; }   // 先把过渡还回去，再撤 transform，才是滑回去/滑出去而不是瞬移
  if (close) _mDrawerSet(false);
}
// 触控板：Chrome 把两指横划报成 wheel 的 deltaX，手指往右 = deltaX 为负。
// 方向锁：一次手势（两次 wheel 间隔 <180ms 算同一次）头一下横着为主才算划，竖着开头的整段都让给列表滚动；
// 抽屉里本来就能横着滚的东西（搜索记录那排之类）让它自己滚；按着 Shift 的鼠标滚轮也是 deltaX，不算。
var _mDrWheel = null;
function _mDrWheelOn(e) {
  if (!_mDrawerOpen || !_mWide() || e.ctrlKey || e.shiftKey) return;
  const t = e.target, d = t && t.closest && t.closest('#mzDrawer');
  if (!d || (t.closest('.mz-dr-resize'))) return;
  const now = Date.now();
  if (!_mDrWheel || now - _mDrWheel.t > 180) {
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5;
    let scroller = false;
    for (let el = t; el && el !== d; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) { scroller = true; break; }
    }
    _mDrWheel = { t: now, on: horiz && !scroller, x: 0, timer: 0 };
  }
  const g = _mDrWheel;
  g.t = now;
  if (!g.on) return;
  e.preventDefault();   // 别让浏览器拿横划去做「后退」
  g.x = Math.max(0, g.x - e.deltaX * (e.deltaMode === 1 ? 16 : 1));
  _mDrSlide(g.x);
  clearTimeout(g.timer);
  g.timer = setTimeout(() => {
    if (_mDrWheel !== g) return;
    _mDrWheel = null;
    _mDrSlideEnd(g.x >= _M_DR_SWIPE_CLOSE);
  }, 180);
}
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('wheel', _mDrWheelOn, { passive: false });
function _mFocusSearch() {
  if (_mTab !== 'search' || !_mDrawerOpen) return;
  const inp = document.getElementById('musicSearchIn');
  // 手机上自动聚焦会弹键盘把整个抽屉顶上去，只在宽屏做
  if (inp && _mWide()) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 60);
}

// ── 小弹出菜单（＋ 和 ⋮ 共用）──
// 挂在 .mz-panel 上而不是 musicBody 里：播放/暂停都会重画 musicBody，挂里面的话一暂停菜单就没了。
var _mPopAnchor = null;
function _mPop(anchor, title, items) {
  if (_mPopAnchor === anchor && document.getElementById('mzPop')) { _mPopClose(); return; }
  _mPopClose();
  const host = document.querySelector('#musicModal .mz-panel');
  if (!host || !anchor) return;
  const pop = document.createElement('div');
  pop.className = 'mz-pop'; pop.id = 'mzPop';
  if (title) { const t = document.createElement('div'); t.className = 'mz-pop-t'; t.textContent = title; pop.appendChild(t); }
  items.forEach(it => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'mz-pop-sep'; pop.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mz-pop-it' + (it.on ? ' on' : '') + (it.dim ? ' dim' : '');
    b.innerHTML = `<span>${escHtml(it.label)}</span>${it.sub ? `<small>${escHtml(it.sub)}</small>` : ''}`;
    b.addEventListener('click', e => { e.stopPropagation(); _mPopClose(); it.fn(); });
    pop.appendChild(b);
  });
  host.appendChild(pop);
  _mPopAnchor = anchor;
  const r = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left - hr.left + r.width / 2 - pw / 2;
  x = Math.max(8, Math.min(hr.width - pw - 8, x));
  let y = r.bottom - hr.top + 8;
  if (y + ph > hr.height - 8) y = Math.max(8, r.top - hr.top - ph - 8);   // 底下放不下就翻到上面（⋮ 在右下角）
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  setTimeout(() => document.addEventListener('pointerdown', _mPopOutside, true), 0);
}
// 点在触发按钮上不算「外面」：交给按钮自己的 click 去做开关，不然按一下关、紧接着又被 click 打开
function _mPopOutside(e) {
  const p = document.getElementById('mzPop');
  if (!p || p.contains(e.target) || (_mPopAnchor && _mPopAnchor.contains(e.target))) return;
  _mPopClose();
}
function _mPopClose() {
  const p = document.getElementById('mzPop'); if (p) p.remove();
  _mPopAnchor = null;
  document.removeEventListener('pointerdown', _mPopOutside, true);
}

// ＋：收藏这首 / 放进哪个歌单 / 新建。以前是 prompt 让她填序号，手机上很难用
function musicAddMenu(anchor) {
  const s = _mNow;
  if (!s) { showToast('先放一首歌', 'info', 1500); return; }
  const fav = musicIsFav(s.id);
  _mPop(anchor, `《${s.name}》`, [{ label: fav ? '★ 已收藏（点一下取消）' : '☆ 收藏这首', on: fav, fn: () => musicToggleFav(s) }, { sep: true }, ..._mAddItems(s)]);
}

// 「放进哪个歌单」那一串：播放器上的 ＋ 和列表每行的 ＋ 共用
function _mAddItems(s) {
  const items = [];
  _mLists().forEach(p => {
    const has = p.songs.some(x => _mSameSong(x.id, s.id));
    items.push({
      label: p.name, sub: has ? '已在里面' : `${p.songs.length} 首`, dim: has,
      fn: () => {
        const ok = musicPlaylistAdd(p.id, s);
        showToast(ok ? `放进《${p.name}》了` : `《${p.name}》里已经有这首了`, ok ? 'success' : 'info', 2000);
        musicRefresh();
      }
    });
  });
  items.push({
    label: '＋ 新建歌单…', fn: async () => {
      const nm = await _mAsk('新歌单叫什么？');
      if (nm === null) return;
      const p = musicPlaylistCreate(nm, '', 'me');
      if (!p) { showToast('歌单得有个名字', 'error', 2200); return; }
      musicPlaylistAdd(p.id, s);
      showToast(`《${s.name}》放进新歌单《${p.name}》`, 'success', 2400);
      musicRefresh();
    }
  });
  return items;
}

// ⋮：用户稿子右下角那个「万能三个点」。歌词和显示的开关都收在这里，面板上不再摆一排小方块
function musicMoreMenu(anchor) {
  const st = musicLyricStyleNorm(state.musicLyricStyle);
  const items = [
    { label: '歌词翻译', on: _mOptOn('musicLyricTrans', true), sub: _mOptOn('musicLyricTrans', true) ? '开' : '关', fn: () => musicToggleLyricOpt('musicLyricTrans', true) },
    { label: '罗马音', on: _mOptOn('musicLyricRoma', false), sub: _mOptOn('musicLyricRoma', false) ? '开' : '关', fn: () => musicToggleLyricOpt('musicLyricRoma', false) },
    { label: '歌词排版', sub: _mStyleNames[st] || st, fn: musicCycleLyricStyle },
    { label: '沉浸歌词的背景', sub: _mVisNames[state.musicVis] || '流光', fn: musicCycleVis },
    { label: '桌面歌词', on: _mDockLyOn(), sub: !_mDockLyOn() ? '关' : _mDeskX() ? '浮在所有程序上面'
      : _mNative() && _mNative().canOverlay ? (_mNative().canOverlay() ? '退到后台也浮在别的 App 上面' : '只在 App 里（没开悬浮窗权限）') : '关掉面板后浮在画面上', fn: _mDockLyToggle },
    ...(_mNative() && _mNative().askOverlay && _mDockLyOn() && !_mNative().canOverlay() ? [{ label: '开悬浮窗权限…', sub: '系统设置 → 显示在其他应用上层', fn: () => _mNative().askOverlay() }] : []),
    { label: '频谱', sub: _mSpecOn() ? '跟着歌跳（多下一份音频）' : '省流量（模拟）', on: _mSpecOn(), fn: musicToggleSpec },
    { label: '整首听', sub: _mProfOn() ? '一起听时让 Gemini 听整首，记下聊过的话' : '关（只给 AI 几个算出来的数）', on: _mProfOn(), fn: musicToggleProfile },
    { label: '手动贴歌词…', fn: musicPasteLyric },
    ...(_mLyric && _mLyric.lines.length ? [{ label: '复制歌词…', sub: '逐句选 / 全部 / 全部译文（也可以长按一句）', fn: () => _mLySelStart(-1) }] : []),
    { sep: true },
  ];
  if (_mNow) {
    const id = String(_mNow.id);
    items.push({ label: '在网易云打开 ↗', fn: () => window.open('https://music.163.com/#/song?id=' + encodeURIComponent(id), '_blank', 'noopener') });
    items.push({ label: '停止播放', fn: musicStop });
  }
  items.push({ label: '刷新面板', fn: () => musicRefresh(true) });
  _mPop(anchor, '', items);
}
function musicToggleSpec() {
  const on = !_mSpecOn();
  try { localStorage.setItem('kuro_musicSpec', on ? '1' : '0'); } catch (e) {}
  showToast(on ? '频谱：跟着歌跳（下一首起生效）' : '频谱：省流量，改成模拟的', 'info', 2200);
  // 正在放的这首现在就补算，不用等下一首
  if (on && _mNow && _mNow.url) _mListen(_mNow, _mPlayReq);
}

// ============================================================
// 频谱圈 + 波浪（mzScope）
//
// 唱片外面一圈竖条 + 横穿过去的几道波，都画在一张铺满面板的 canvas 上。
// 唱片本身是 DOM（封面要能转、要清晰），画布每帧去量唱片在哪，围着它画——
// 所以手机/电脑两套布局、抽屉开合，画布都不用知道。
// 有算好的频谱（musicSpectrum）就查表；还没算完/关了，就用拍子 + 慢噪声模拟，
// 反正不能让一圈竖条僵在那：稿子里它是整个面板的心跳。
// ============================================================
var _mScopeRaf = 0, _mScopeLast = 0;
var _mScopeVals = null, _mScopeTgt = null;
var _mScopeCol = null, _mScopeColAt = -1e9;

function _mScopeSync() {
  const m = document.getElementById('musicModal');
  const on = !!(m && m.classList && !m.classList.contains('hidden') && !m.classList.contains('music-lyrics-full')
    && document.getElementById('mzScope'));
  if (on && !_mScopeRaf) _mScopeRaf = requestAnimationFrame(_mScopeFrame);
  if (!on && _mScopeRaf) { cancelAnimationFrame(_mScopeRaf); _mScopeRaf = 0; }
  // 角色那几只要知道在不在放（放着眯眼摇头，停了睁眼发呆），还有拍子多快
  if (m && m.classList && m.classList.toggle) {
    m.classList.toggle('mz-playing', !!(_mAudio && !_mAudio.paused && _mNow));
    const bpm = _mNow && _mNow.feat && _mHasBeat(_mNow.feat) ? _mNow.feat.bpm : 0;
    if (m.style) m.style.setProperty('--mz-beat', (bpm ? 60 / bpm : 0.62).toFixed(3) + 's');
  }
}

function _mScopeFrame(ts) {
  _mScopeRaf = 0;
  const cv = document.getElementById('mzScope');
  if (!cv) return;
  const playing = !!(_mAudio && !_mAudio.paused && _mNow);
  // 停着的时候只剩波浪慢慢飘，20fps 够了；放着的时候竖条要跟拍，跑满
  if (ts - _mScopeLast >= (playing ? 0 : 48)) { _mScopeLast = ts; _mScopeDraw(cv, ts, playing); }
  _mScopeSync();
}

// 主题色 → [r,g,b]。借 canvas 的 fillStyle 做归一化：它会把 #abc / rgb() / 颜色名统一吐成 #rrggbb
function _mAccentRgb() {
  try {
    const m = document.getElementById('musicModal');
    const v = getComputedStyle(m).getPropertyValue('--accent').trim() || '#0061c5';
    const cx = document.createElement('canvas').getContext('2d');
    cx.fillStyle = '#0061c5'; cx.fillStyle = v;
    const s = cx.fillStyle;
    if (s[0] === '#') return [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
    const n = s.match(/[\d.]+/g); if (n) return [+n[0], +n[1], +n[2]];
  } catch (e) {}
  return [0, 97, 197];
}

function _mScopeBands(t, playing) {
  const NB = _M_SPEC_NB;
  if (!_mScopeVals) { _mScopeVals = new Float32Array(NB); _mScopeTgt = new Float32Array(NB); }
  const v = _mScopeVals, tg = _mScopeTgt;
  const sp = playing && _mNow ? _mSpecGet(_mNow.id) : null;
  if (sp) {
    const fp = Math.max(0, (_mAudio.currentTime || 0) * sp.fps);
    const f0 = Math.min(sp.frames - 1, Math.floor(fp)), f1 = Math.min(sp.frames - 1, f0 + 1), fr = fp - Math.floor(fp);
    for (let j = 0; j < NB; j++) tg[j] = (sp.data[f0 * NB + j] * (1 - fr) + sp.data[f1 * NB + j] * fr) / 255;
  } else if (playing) {
    const bpm = (_mNow && _mNow.feat && _mNow.feat.bpm) || 96;
    const ph = ((_mAudio.currentTime || t) * bpm / 60) % 1;
    const kick = Math.exp(-ph * 5.5);
    for (let j = 0; j < NB; j++) {
      const n = 0.5 + 0.5 * Math.sin(t * (1.3 + j * 0.071) + j * 1.7) * Math.sin(t * 0.63 + j * 2.31);
      tg[j] = 0.12 + 0.34 * n + kick * 0.42 * (1 - j / NB);
    }
  } else {
    for (let j = 0; j < NB; j++) tg[j] = 0.035 + 0.025 * Math.sin(t * 0.9 + j * 0.8);
  }
  // 起得快落得慢，竖条才像是被声音顶起来的，而不是在抖
  for (let j = 0; j < NB; j++) v[j] += (tg[j] - v[j]) * (tg[j] > v[j] ? 0.6 : 0.16);
  return v;
}

// 那三道波＝把这一刻的声音拆成三个正弦分量（用户：「我本来想做音乐拆出来的正弦波」）。
// 48 个频段切成低/中/高三截，每截各出一道纯正弦：
//   · 频率＝这截里能量的重心在哪个频段（按能量四次方加权，谁最响跟谁——平方加权的话重心老在中间，波长几乎不动）。真实频率跨 40Hz~11kHz 近 300 倍，
//     画出来压成对数上的 0.7~6.4 个周期横穿面板——低音是一道大长浪，高音是细密的小碎波；
//   · 振幅＝这截的响度；
//   · 相位一直往前走，频率越高走得越快（像真的波在传）。
// 全都缓慢跟随不跳变：频谱表 21.5 帧/秒，直接套的话波长每帧都在抽搐。
var _mWaveAt = 0, _mWaveSt = null;
function _mWaveParts(v, dt, playing) {
  const NB = v.length, cut = [0, Math.round(NB / 3), Math.round(NB * 2 / 3), NB];
  if (!_mWaveSt) _mWaveSt = [0, 1, 2].map(i => ({ k: 0.7 * Math.pow(2, (cut[i] + cut[i + 1]) / 2 / NB * 3.2), a: 0.3, ph: i * 2.1, dir: i === 1 ? -1 : 1 }));
  for (let i = 0; i < 3; i++) {
    const w = _mWaveSt[i];
    let sw = 0, sj = 0, e = 0;
    for (let j = cut[i]; j < cut[i + 1]; j++) { const q = v[j] * v[j] * v[j] * v[j]; sw += q; sj += q * j; e += v[j]; }
    e /= cut[i + 1] - cut[i];
    const c = sw > 1e-6 ? sj / sw : (cut[i] + cut[i + 1] - 1) / 2;
    const k = 0.7 * Math.pow(2, c / (NB - 1) * 3.2);
    const a = playing ? Math.min(1.6, 0.25 + e * 2.2) : 0.3;
    // 波长慢慢变（约 0.6 秒跟上），振幅快一点（约 0.12 秒），鼓点才看得出来
    w.k += (k - w.k) * Math.min(1, dt * 1.6);
    w.a += (a - w.a) * Math.min(1, dt * (a > w.a ? 9 : 4));
    w.ph += w.dir * dt * (0.35 + 0.42 * w.k) * (playing ? 1 : 0.35);
  }
  return _mWaveSt;
}

function _mScopeDraw(cv, ts, playing) {
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const cx = cv.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, W, H);

  if (ts - _mScopeColAt > 1500) { _mScopeCol = _mAccentRgb(); _mScopeColAt = ts; }
  const [r, g, b] = _mScopeCol;
  const col = a => `rgba(${r},${g},${b},${a})`;

  // 唱片在哪：每帧量一次。量不到（空闲页、全屏歌词）就不画圈
  const disc = document.getElementById('mzDisc');
  const cr = cv.getBoundingClientRect();
  let ox = W / 2, oy = H * 0.42, R = 0;
  if (disc) {
    const d = disc.getBoundingClientRect();
    if (d.width > 10) { ox = d.left - cr.left + d.width / 2; oy = d.top - cr.top + d.height / 2; R = d.width / 2; }
  }
  const t = ts / 1000;
  const v = _mScopeBands(t, playing);

  // ── 波浪（稿子里的「试图画正波」）：三道横穿面板的正弦波，是从这一刻的频谱里拆出来的 ──
  const Rw = R || Math.min(W, H) * 0.2;
  const dt = _mWaveAt ? Math.min(0.1, Math.max(0, t - _mWaveAt)) : 0;
  _mWaveAt = t;
  const waves = _mWaveParts(v, dt, playing);
  const lay = [
    { y: oy - Rw * 1.5, amp: Rw * 0.2, a: 0.5 },
    { y: oy + Rw * 0.08, amp: Rw * 0.16, a: 0.42 },
    { y: oy + Rw * 1.3, amp: Rw * 0.13, a: 0.45 },
  ];
  cx.lineWidth = 2; cx.lineCap = 'round'; cx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    const w = waves[i], L = lay[i];
    const amp = L.amp * w.a;
    // 以面板中线为轴：频率一变波长从中间往两边伸缩，不会整条从左边被拽着跑
    const k = Math.PI * 2 * w.k / W;
    cx.strokeStyle = col(L.a);
    cx.beginPath();
    for (let x = -4; x <= W + 4; x += 3) {
      const y = L.y + amp * Math.sin(k * (x - W / 2) + w.ph);
      if (x < 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();
  }

  if (!R) return;
  // ── 频谱圈：竖条从唱片边上往外长。低频在正上方，往两边对称地走到正下方的高频 ──
  const N = 132, R0 = R * 1.075, Lmax = R * 0.62;
  const bw = Math.max(1.6, (Math.PI * 2 * R0 / N) * 0.46);
  cx.lineWidth = bw; cx.lineCap = 'round';
  cx.strokeStyle = col(0.92);
  cx.beginPath();
  for (let i = 0; i < N; i++) {
    const side = i < N / 2 ? i : N - i;                 // 0 … N/2 … 1，左右镜像
    const fb = side / (N / 2) * (_M_SPEC_NB - 1);
    const j = Math.floor(fb), fr = fb - j;
    const val = v[j] * (1 - fr) + v[Math.min(_M_SPEC_NB - 1, j + 1)] * fr;
    // 相邻竖条错开一点长度：稿子里那圈是参差的手绘感，不是整齐的柱状图
    const jitter = 0.82 + 0.18 * Math.sin(i * 12.9898);
    const L = R * 0.05 + Lmax * val * jitter;
    const ang = -Math.PI / 2 + i / N * Math.PI * 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    cx.moveTo(ox + c * R0, oy + s * R0);
    cx.lineTo(ox + c * (R0 + L), oy + s * (R0 + L));
  }
  cx.stroke();
}

// ============================================================
// 收藏 与 歌单（用户要的）
//
// 两个概念**故意分开存**，没把收藏做成"一个叫收藏的歌单"：
//   收藏是一首歌的属性（心是亮的还是灭的，一眼能看出来），
//   歌单是一个容器。做成同一个东西的话，"取消收藏"和"从歌单里删掉一首"
//   会共用一条代码路径，AI 整理歌单时顺手就能把她攒的收藏清空。
//
// 歌单形状：{ id, name, desc, cover, songs:[{id,name,artist,cover}], ts, by }
//   by = 'me' | 'ai'，只用来在卡片上标一下谁建的，不参与任何权限判断——
//   AI 建的歌单她照样能改名删歌，反过来也一样。
// ============================================================

function _mFavs() { if (!Array.isArray(state.musicFav)) state.musicFav = []; return state.musicFav; }
function _mLists() { if (!Array.isArray(state.musicPlaylists)) state.musicPlaylists = []; return state.musicPlaylists; }

// id 一律按字符串比。网易云的 id 从接口回来有时是数字有时是字符串，
// 用 === 比的话同一首歌会既"已收藏"又能再收藏一次，攒出两条一模一样的。
function _mSameSong(a, b) { return String(a) === String(b); }

// 存进收藏/歌单的只留这五个字段。整个搜索结果对象扔进去的话，
// 里面那些 duration/album/privilege 会跟着进 IndexedDB，几百首之后白占几 MB。
function _mSlim(song) {
  return { id: song.id, name: song.name || '', artist: song.artist || '', cover: song.cover || '' };
}

// ── 手机 ↔ 电脑同步：收藏 / 最近播放 / 搜索记录 / 歌单（用户要的）──
//
// 搭的是现成的云端设置（profiles.settings，见 01-core 的 syncSettingsToCloud）。
// 那条路是**整包 upsert、最后写入者赢**——收藏消息、记忆当年都被另一台整包冲掉过。
// 所以这四样不能直接塞进去，一律「先和云端按条合并，再推」：
//   · 每个元素记两个时间 {a: 最后一次加, d: 最后一次删}，a > d 才算活着（LWW 元素集）。
//     删除留下墓碑，另一台的旧副本下次同步时就不会把它「复活」。
//   · 时间用 _mStamp()：比本机见过的所有时间都大至少 1。一台时钟快了几分钟，
//     另一台同步到它的时间后就跟着往后走，「后做的操作赢」这件事不靠两台钟对得准。
//   · 合并是纯函数、两边算出来一样：推上去的就是两边的并集，下一轮判等收敛。
// 模式/倍速/上一首历史故意不同步——那是这台设备的习惯（见文件开头那段注释）。
var _mSyncHigh = 0;
function _mSyncOps() {
  let o = state.musicSyncOps;
  if (!o || typeof o !== 'object') o = state.musicSyncOps = {};
  for (const k of ['fav', 'lists', 'search']) if (!o[k] || typeof o[k] !== 'object') o[k] = {};
  return o;
}
// 本地数据里出现过的最大时间。启动后第一次盖戳时现算，不单独存盘（少过一道持久化的门）
function _mSyncSeen(d) {
  let hi = 0;
  const up = v => { v = +v || 0; if (v > hi) hi = v; };
  const ops = (d && d.ops) || {};
  for (const k of ['fav', 'lists', 'search']) for (const o of Object.values(ops[k] || {})) { up(o && o.a); up(o && o.d); }
  for (const x of [...(d.fav || []), ...(d.recent || []), ...(d.search || [])]) up(x && x.ts);
  for (const p of d.lists || []) {
    up(p && p.ts); up(p && p.mt);
    for (const o of Object.values((p && p.sops) || {})) { up(o && o.a); up(o && o.d); }
  }
  return hi;
}
function _mStamp() {
  if (!_mSyncHigh) _mSyncHigh = _mSyncSeen(_mSyncLocal());
  _mSyncHigh = Math.max(Date.now(), _mSyncHigh + 1);
  return _mSyncHigh;
}
function _mOp(map, key, kind) {
  const o = map[key] && typeof map[key] === 'object' ? map[key] : (map[key] = {});
  return (o[kind] = _mStamp());
}
function _mAlive(o) { return !o || !(+o.d) || (+o.a || 0) > (+o.d); }
function _mMergeOps(x, y) {
  const out = {};
  for (const src of [x || {}, y || {}]) {
    for (const k of Object.keys(src)) {
      const o = src[k]; if (!o || typeof o !== 'object') continue;
      const r = out[k] || (out[k] = {});
      if (+o.a > (r.a || 0)) r.a = +o.a;
      if (+o.d > (r.d || 0)) r.d = +o.d;
    }
  }
  return out;
}
// 元素集合并（收藏、搜索记录）。同一个元素两边都有时留 ts 大的那份（撞平留本地）；
// 没有 op 的老数据把自己的 ts 当成「加」的时间——所以旧收藏第一次同步不会丢。
function _mMergeSet(lList, cList, ops, keyOf) {
  const items = new Map();
  for (const it of [...(lList || []), ...(cList || [])]) {
    const k = it && keyOf(it); if (!k) continue;
    const prev = items.get(k);
    if (!prev || (+it.ts || 0) > (+prev.ts || 0)) items.set(k, it);
  }
  const out = [];
  for (const [k, it] of items) {
    const o = ops[k] || (ops[k] = {});
    if ((+it.ts || 0) > (o.a || 0)) o.a = +it.ts || 0;
    if (!_mAlive(o)) continue;
    out.push(Object.assign({}, it, { ts: Math.max(+it.ts || 0, o.a || 0) }));
  }
  // 新的在前；撞平按 key 排，两台排出来的顺序才一样
  return out.sort((x, y) => (y.ts - x.ts) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
}
function _mSearchKey(q) { return String(q || '').trim().toLowerCase().replace(/\s+/g, ' '); }
// 歌单里的歌：没有 sop 的老歌按「歌单创建时间 + 位置」补一个加入时间，
// 否则两台各按自己的顺序排、谁也说服不了谁，每轮同步都在来回改顺序。
function _mListSops(p) {
  const sops = Object.assign({}, p.sops || {});
  (p.songs || []).forEach((s, i) => {
    const k = String(s.id);
    if (!sops[k]) sops[k] = { a: (+p.ts || 0) + i };
  });
  return sops;
}
function _mMergeList(pl, pc) {
  // 只有一边有：和自己合并一遍，出来的字段和顺序跟两边都有时一样（签名比对才判得等）
  if (!pl || !pc) pl = pc = (pl || pc);
  const born = [pl.ts, pc.ts].map(Number).filter(x => x > 0);
  const mtl = +pl.mt || +pl.ts || 0, mtc = +pc.mt || +pc.ts || 0;
  const meta = mtc > mtl ? pc : pl;
  const sops = _mMergeOps(_mListSops(pl), _mListSops(pc));
  const songs = new Map();
  for (const s of [...(pl.songs || []), ...(pc.songs || [])]) if (s && s.id != null && !songs.has(String(s.id))) songs.set(String(s.id), s);
  const live = [...songs.values()].filter(s => _mAlive(sops[String(s.id)]))
    .sort((x, y) => ((sops[String(x.id)].a || 0) - (sops[String(y.id)].a || 0)) || (String(x.id) < String(y.id) ? -1 : 1));
  return {
    id: pl.id, name: meta.name, desc: meta.desc || '', by: meta.by || pl.by || 'me',
    // 云端那份封面太大没上传时是 null：意思是「我不知道」，不是「清掉了」
    cover: meta.cover == null ? (pl.cover || '') : meta.cover,
    ts: born.length ? Math.min(...born) : 0,
    mt: Math.max(mtl, mtc), sops, songs: live.map(s => Object.assign({}, s)),
  };
}
// 纯函数：本机一份 + 云端一份 → 合并后的一份。两边拿着同样两份输入，算出来的一模一样。
function musicSyncMerge(L, C) {
  L = L || {}; C = C || {};
  const lo = L.ops || {}, co = C.ops || {};
  const ops = { fav: _mMergeOps(lo.fav, co.fav), lists: _mMergeOps(lo.lists, co.lists), search: _mMergeOps(lo.search, co.search) };
  const fav = _mMergeSet(L.fav, C.fav, ops.fav, s => s.id != null ? String(s.id) : '');
  const search = _mMergeSet(L.search, C.search, ops.search, s => _mSearchKey(s.q)).slice(0, 20);
  // 最近播放没有删除：按歌取最后一次放的时间，截 30 条
  const rmap = new Map();
  for (const s of [...(L.recent || []), ...(C.recent || [])]) {
    if (!s || s.id == null) continue;
    const k = String(s.id), prev = rmap.get(k);
    if (!prev || (+s.ts || 0) > (+prev.ts || 0)) rmap.set(k, s);
  }
  const recent = [...rmap.values()].sort((x, y) => ((+y.ts || 0) - (+x.ts || 0)) || (String(x.id) < String(y.id) ? -1 : 1)).slice(0, 30);
  const lmap = new Map(), cmap = new Map();
  for (const p of L.lists || []) if (p && p.id != null) lmap.set(String(p.id), p);
  for (const p of C.lists || []) if (p && p.id != null) cmap.set(String(p.id), p);
  const lists = [];
  for (const id of new Set([...lmap.keys(), ...cmap.keys()])) {
    const pl = lmap.get(id), pc = cmap.get(id);
    const o = ops.lists[id] || (ops.lists[id] = {});
    const born = Math.max(+(pl && pl.ts) || 0, +(pc && pc.ts) || 0);
    if (born > (o.a || 0)) o.a = born;
    if (!_mAlive(o)) continue;
    lists.push(_mMergeList(pl, pc));
  }
  lists.sort((x, y) => ((+y.ts || 0) - (+x.ts || 0)) || (String(x.id) < String(y.id) ? -1 : 1));
  return { fav, recent, search, lists, ops };
}
function _mSyncLocal() {
  return { fav: state.musicFav || [], recent: state.musicRecent || [], search: state.musicSearchHist || [],
    lists: state.musicPlaylists || [], ops: state.musicSyncOps || {} };
}
function _mSyncFromCloud(s) {
  s = s || {};
  return { fav: s.musicFav, recent: s.musicRecent, search: s.musicSearchHist, lists: s.musicPlaylists, ops: s.musicSyncOps };
}
// 推上去的那份。自定义封面是 240px 的 JPEG，一般二三十 KB；异常大的不上云（整包 upsert 会被截断），
// 用 null 占位——另一台读到 null 就留着自己那张
const _M_COVER_MAX = 60000;
function _mSyncPayload(d) {
  return {
    musicFav: d.fav, musicRecent: d.recent, musicSearchHist: d.search, musicSyncOps: d.ops,
    musicPlaylists: d.lists.map(p => (p.cover && p.cover.length > _M_COVER_MAX) ? Object.assign({}, p, { cover: null }) : p),
  };
}
// 云端设置 → 合进本机（有变化才落盘、重画），返回要推上去的那几个字段。
// 两处调用：启动时拉云端设置（loadFromCloud），推送前先读一遍云端（syncSettingsToCloud）。
function musicSyncApply(cloudSettings) {
  const before = _mSyncLocal();
  const m = musicSyncMerge(before, _mSyncFromCloud(cloudSettings));
  const sig = d => JSON.stringify([d.fav, d.recent, d.search, d.lists, d.ops]);
  const changed = sig(m) !== sig(Object.assign({}, before, { ops: _mSyncOpsCopy(before.ops) }));
  if (changed) {
    state.musicFav = m.fav; state.musicRecent = m.recent; state.musicSearchHist = m.search;
    state.musicPlaylists = m.lists; state.musicSyncOps = m.ops;
  }
  const hi = _mSyncSeen(m); if (hi > _mSyncHigh) _mSyncHigh = hi;
  // 本机有、云端没有（比如这台攒了 13 首收藏，云端只有另一台推的 1 首）：光拉不推的话，
  // 本机一个字都没改（changed=false）→ 不 save → 不推，另一台永远等不到这 13 首。
  // 所以拿「合并结果」和「云端那份自己规整后的样子」比，不一样就得推一次（09-30 真机上逮到的）
  const cloudOnly = _mSyncFromCloud(cloudSettings);
  const needPush = JSON.stringify(_mSyncPayload(m)) !== JSON.stringify(_mSyncPayload(musicSyncMerge(cloudOnly, cloudOnly)));
  return { changed, needPush, payload: _mSyncPayload(m) };
}
function _mSyncOpsCopy(o) { o = o || {}; return { fav: o.fav || {}, lists: o.lists || {}, search: o.search || {} }; }

// 打开面板时顺手拉一次（最多半分钟一次）：启动时拉过，但两台都开着一整天的话，
// 另一台刚收藏的歌要等这台重启才看得见。推送仍然走 save() 那条 3 秒防抖。
var _mSyncPullAt = 0;
async function musicSyncPull(force) {
  if (typeof fetchCloudSettings !== 'function' || typeof currentUser === 'undefined' || !currentUser) return false;
  if (!force && Date.now() - _mSyncPullAt < 30000) return false;
  _mSyncPullAt = Date.now();
  try {
    const { data, error } = await fetchCloudSettings();
    if (error || !data || !data.settings) return false;
    const r = musicSyncApply(data.settings);
    if (r.changed) musicRefresh();
    if (r.changed || r.needPush) save();   // save() 3 秒后会推云端（推之前还会再和云端合并一次）
    return r.changed;
  } catch (e) { console.warn('[点歌同步] 拉取失败:', e && e.message); return false; }
}

function musicIsFav(id) { return _mFavs().some(s => _mSameSong(s.id, id)); }

function musicToggleFav(song) {
  if (!song || song.id == null) return;
  const favs = _mFavs();
  const i = favs.findIndex(s => _mSameSong(s.id, song.id));
  // 加和删都要盖戳：删的那一下留墓碑，另一台同步过来时才不会把它复活
  if (i >= 0) { favs.splice(i, 1); _mOp(_mSyncOps().fav, String(song.id), 'd'); showToast('已取消收藏', 'info', 1800); }
  else { favs.unshift(Object.assign(_mSlim(song), { ts: _mOp(_mSyncOps().fav, String(song.id), 'a') })); showToast('★ 已收藏', 'success', 1800); }
  save();
  musicRefresh();
}

// 正在放的这首。按钮在播放器上，_mNow 为空时整个按钮不渲染，所以这里只兜个底。
function musicFavCurrent() { if (_mNow) musicToggleFav(_mNow); }
function musicFavFromList(i) { const s = _mResults[i]; if (s) musicToggleFav(s); }
// 从收藏里点一首：后面的收藏排进队列，整张收藏当单子（列表循环/随机都在它里面转）
function musicPlayFav(i) {
  const favs = _mFavs(), s = favs[i]; if (!s) return;
  _mCtx = favs.map(x => Object.assign({}, x));
  _mQueue = favs.slice(i + 1).map(x => Object.assign({}, x));
  musicPlay(s);
}

// ── 歌单 CRUD ──

function _mListById(id) { return _mLists().find(p => String(p.id) === String(id)) || null; }

function musicPlaylistCreate(name, desc, by) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const p = {
    id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: nm.slice(0, 60), desc: String(desc || '').trim().slice(0, 300),
    cover: '', songs: [], ts: 0, by: by === 'ai' ? 'ai' : 'me', sops: {}
  };
  p.ts = p.mt = _mOp(_mSyncOps().lists, p.id, 'a');
  _mLists().unshift(p);
  save();
  return p;
}

async function musicPlaylistNew() {
  const nm = await _mAsk('新歌单叫什么？');
  if (nm === null) return;
  const p = musicPlaylistCreate(nm, '', 'me');
  if (!p) { showToast('歌单得有个名字', 'error', 2200); return; }
  showToast(`已建歌单《${p.name}》`, 'success', 2200);
  _mViewList = p.id;
  musicRefresh();
}

async function musicPlaylistRename(id) {
  const p = _mListById(id); if (!p) return;
  const nm = await _mAsk('歌单名字：', p.name);
  if (nm === null) return;
  const t = nm.trim();
  if (!t) { showToast('名字不能是空的', 'error', 2200); return; }
  p.name = t.slice(0, 60); p.mt = _mStamp(); save(); musicRefresh();
}

async function musicPlaylistEditDesc(id) {
  const p = _mListById(id); if (!p) return;
  const d = await _mAsk('这个歌单的简介：', p.desc || '');
  if (d === null) return;
  p.desc = d.trim().slice(0, 300); p.mt = _mStamp(); save(); musicRefresh();
}

// 删歌单要确认——一个歌单可能是攒了很久的，手滑点掉没有撤销。
function musicPlaylistDelete(id) {
  const p = _mListById(id); if (!p) return;
  if (!confirm(`删掉歌单《${p.name}》？里面 ${p.songs.length} 首歌的记录会一起没掉。`)) return;
  const arr = _mLists();
  arr.splice(arr.findIndex(x => String(x.id) === String(id)), 1);
  _mOp(_mSyncOps().lists, String(id), 'd');
  if (_mViewList === id) _mViewList = null;
  save(); musicRefresh();
  showToast('歌单已删除', 'info', 2000);
}

function musicPlaylistAdd(id, song) {
  const p = _mListById(id); if (!p || !song || song.id == null) return false;
  if (p.songs.some(s => _mSameSong(s.id, song.id))) return false;   // 同一首不重复进
  p.songs.push(_mSlim(song));
  _mOp(p.sops || (p.sops = {}), String(song.id), 'a');
  save();
  return true;
}

function musicPlaylistRemoveSong(id, i) {
  const p = _mListById(id); if (!p || !p.songs[i]) return;
  const gone = p.songs.splice(i, 1)[0];
  _mOp(p.sops || (p.sops = {}), String(gone.id), 'd');
  save(); musicRefresh();
}

// 把一首歌加进歌单：没歌单先建一个，有就让她挑。
// 有 anchor（列表行上的 ＋）就弹小菜单点选；以前是一个大弹窗列出全部歌单让她填序号（10-08 截图），
// 十几个歌单时又长又得数数。没 anchor 的调用方才退回填序号那条。
async function musicAddToPlaylist(song, anchor) {
  if (!song || song.id == null) return;
  const lists = _mLists();
  if (lists.length && anchor && document.querySelector('#musicModal .mz-panel')) {
    _mPop(anchor, `《${song.name}》放进…`, _mAddItems(song));
    return;
  }
  if (!lists.length) {
    const nm = await _mAsk('还没有歌单。新建一个，叫什么？');
    if (nm === null) return;
    const p = musicPlaylistCreate(nm, '', 'me');
    if (!p) { showToast('歌单得有个名字', 'error', 2200); return; }
    musicPlaylistAdd(p.id, song);
    showToast(`《${song.name}》已放进《${p.name}》`, 'success', 2400);
    musicRefresh();
    return;
  }
  const menu = lists.map((p, i) => `${i + 1}. ${p.name}（${p.songs.length}首）`).join('\n');
  const pick = await _mAsk(`把《${song.name}》放进哪个歌单？填序号，或直接输入新歌单的名字：\n${menu}`);
  if (pick === null) return;
  const t = pick.trim(); if (!t) return;
  // 纯数字且在范围内 = 选已有的；其余一律当成"建一个叫这个名字的新歌单"。
  // 这条分叉是故意的：她想建个叫「2」的歌单是极小概率，
  // 而输错序号被静默建成一个名叫「7」的空歌单才是真的莫名其妙。
  const n = /^\d+$/.test(t) ? +t : 0;
  const target = (n >= 1 && n <= lists.length) ? lists[n - 1] : musicPlaylistCreate(t, '', 'me');
  if (!target) return;
  const ok = musicPlaylistAdd(target.id, song);
  showToast(ok ? `《${song.name}》已放进《${target.name}》` : `《${target.name}》里已经有这首了`, ok ? 'success' : 'info', 2400);
  musicRefresh();
}

function musicAddFromList(i, anchor) { const s = _mResults[i]; if (s) musicAddToPlaylist(s, anchor); }
function musicAddCurrent() { if (_mNow) musicAddToPlaylist(_mNow); }

// 播放整个歌单：第一首直接放，其余进队列（复用现成的 _mQueue，不另造播放逻辑）
function musicPlaylistPlay(id) {
  const p = _mListById(id); if (!p) return;
  if (!p.songs.length) { showToast('这个歌单还是空的', 'info', 2000); return; }
  _mCtx = p.songs.map(s => Object.assign({}, s));
  // 随机模式下「播放全部」从随便哪首开始，不然每次都是第一首打头
  const i0 = _mMode === 'shuffle' ? Math.floor(Math.random() * p.songs.length) : 0;
  _mQueue = p.songs.filter((_, k) => k !== i0).map(s => Object.assign({}, s));
  musicPlay(p.songs[i0]);
  showToast(`▶ 《${p.name}》 ${p.songs.length} 首`, 'success', 2400);
}

function musicPlaylistPlaySong(id, i) {
  const p = _mListById(id); if (!p || !p.songs[i]) return;
  _mCtx = p.songs.map(s => Object.assign({}, s));
  _mQueue = p.songs.slice(i + 1).map(s => Object.assign({}, s));
  musicPlay(p.songs[i]);
}

// ── 自定义封面 ──
//
// ⚠️ 不靠 file.type 判断是不是图片。这台机器上系统按扩展名瞎猜 MIME
// （.ts 会被标成 video/*），信它的话该放行的被拦、该拦的放行。
// 真正的判据是**浏览器能不能把它解码成一张图**，所以判断放在 img.onload 里。
function musicPlaylistCover(id, input) {
  const file = input?.files?.[0];
  input.value = '';
  if (!file) return;
  const p = _mListById(id); if (!p) return;
  const r = new FileReader();
  r.onload = e => {
    const img = new Image();
    img.onload = () => {
      // 缩到 240 见方再存。原图直接塞 state 的话，一张手机拍的图就是几 MB，
      // 而且它会跟着每次 save() 整个写一遍 IndexedDB。
      const S = 240, c = document.createElement('canvas');
      c.width = c.height = S;
      const ctx = c.getContext('2d');
      const side = Math.min(img.width, img.height);      // 居中裁成正方形，不拉变形
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      p.cover = c.toDataURL('image/jpeg', 0.82);
      p.mt = _mStamp();
      save(); musicRefresh();
      showToast('封面换好了', 'success', 2000);
    };
    img.onerror = () => showToast('这个文件不是图片（或者浏览器读不了）', 'error', 2800);
    img.src = e.target.result;
  };
  r.onerror = () => showToast('读不了这个文件', 'error', 2500);
  r.readAsDataURL(file);
}

function musicPlaylistClearCover(id) {
  const p = _mListById(id); if (!p) return;
  p.cover = ''; p.mt = _mStamp(); save(); musicRefresh();
}

// ── 从网易云账号导入（用户要的）──
//
// 「喜欢的音乐」进收藏，她自己建的歌单进歌单。**只加不删**，可以反复点：
//   · 收藏：已经在的跳过；在 GranCyan 里取消过收藏、而且取消得比网易云那次「喜欢」晚的，也跳过
//     （她在这边亲手删的不该被导入复活）。收藏时间用网易云的「喜欢时间」，
//     所以导进来是按她在网易云里喜欢的先后排的，和这边原有的收藏按时间交错。
//   · 歌单：id 固定成 ne_<网易云歌单id>，再导一次是往同一个歌单里补新歌，不会冒出第二个同名的；
//     这边删掉的歌（有墓碑）不补回来。歌单本身被删了的，再导一次算她主动要回来，重建。
// 歌单名、简介、封面只在第一次建的时候取网易云的，之后她在这边改的不被覆盖。
function _mNeListId(neId) { return 'ne_' + neId; }
// 导入固定走电脑的 server：安卓 App 自带的 localhost:8080 代理（musicApiBase）只有搜索/播放/歌词四条，
// 没有这两条。导一次就够，导完靠同步送到手机，犯不上在 Java 那边再实现一遍。
function _mNeFetch(p) { return fetch(SERVER_BASE + p); }

function musicNeteaseMergeFav(songs) {
  const favs = _mFavs(), ops = _mSyncOps().fav;
  const have = new Set(favs.map(s => String(s.id)));
  let n = 0;
  for (const s of songs || []) {
    if (!s || s.id == null) continue;
    const k = String(s.id);
    if (have.has(k)) continue;
    const at = +s.at || 0, o = ops[k];
    if (o && +o.d && +o.d >= at) continue;            // 这边取消过，而且比网易云那次喜欢晚
    const ts = at || _mStamp();
    favs.push(Object.assign(_mSlim(s), { ts }));
    const r = ops[k] || (ops[k] = {});
    if (ts > (+r.a || 0)) r.a = ts;
    have.add(k); n++;
  }
  // 和 musicSyncMerge 排出来的一样（新的在前、撞平按 id），不然下一轮同步又判成「变了」
  favs.sort((x, y) => ((+y.ts || 0) - (+x.ts || 0)) || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  return n;
}

function musicNeteaseMergeList(pl) {
  const id = _mNeListId(pl.id);
  let p = _mListById(id), created = false;
  if (!p) {
    p = { id, name: String(pl.name || '网易云歌单').slice(0, 60), desc: String(pl.desc || '').trim().slice(0, 300),
      cover: pl.cover || '', songs: [], ts: 0, by: 'me', sops: {} };
    p.ts = p.mt = _mOp(_mSyncOps().lists, id, 'a');
    _mLists().unshift(p);
    created = true;
  }
  const sops = p.sops || (p.sops = {});
  const have = new Set(p.songs.map(s => String(s.id)));
  let n = 0;
  for (const s of pl.songs || []) {
    if (!s || s.id == null) continue;
    const k = String(s.id);
    if (have.has(k) || sops[k]) continue;             // 已经在，或者在这边被删过
    p.songs.push(_mSlim(s));
    sops[k] = { a: _mStamp() };                       // 逐首递增，同步合并后顺序和网易云一样
    have.add(k); n++;
  }
  return { p, n, created };
}

var _mNeBusy = false;
async function musicNeteaseImport() {
  if (_mNeBusy) { showToast('正在导入，等它跑完', 'info', 2000); return; }
  let last = '';
  try { last = localStorage.getItem('gc_music_ne_user') || ''; } catch (e) {}
  const q = await _mAsk('网易云的昵称（或用户 id）：\n会把「喜欢的音乐」放进收藏、你自己建的歌单放进歌单。只加不删，可以反复导。', last);
  if (q === null || !q.trim()) return;
  _mNeBusy = true;
  try {
    const r = await _mNeFetch(`/api/music/netease/user?q=${encodeURIComponent(q.trim())}`);
    const u = await r.json().catch(() => ({}));
    if (!r.ok) {
      const near = u.near && u.near.length ? `\n像的有：${u.near.join('、')}` : '';
      showToast((u.error || '读网易云失败') + near, 'error', 4000); return;
    }
    try { localStorage.setItem('gc_music_ne_user', q.trim()); } catch (e) {}
    // 倒着建：新建的歌单排最前，倒着建完正好是网易云里的顺序（顺着建的话最后一个跑到最上面）
    const pls = (u.playlists || []).slice().reverse();
    if (!pls.length) { showToast(`「${u.user.nickname}」没有自己建的歌单`, 'info', 3000); return; }
    let fav = 0, songs = 0, made = 0, fail = [];
    for (let i = 0; i < pls.length; i++) {
      const it = pls[i];
      showToast(`网易云导入 ${i + 1}/${pls.length}：${it.name}（${it.count} 首）`, 'info', 6000);
      try {
        const pr = await _mNeFetch(`/api/music/netease/playlist?id=${encodeURIComponent(it.id)}`);
        const pl = await pr.json().catch(() => ({}));
        if (!pr.ok) { fail.push(it.name + '：' + (pl.error || pr.status)); continue; }
        if (it.liked) fav += musicNeteaseMergeFav(pl.songs);
        else {
          const m = musicNeteaseMergeList(Object.assign({}, pl, { cover: pl.cover || it.cover }));
          songs += m.n; if (m.created) made++;
        }
      } catch (e) { fail.push(it.name + '：' + (e && e.message || e)); }
    }
    save(); musicRefresh();
    showToast(`导入完了：收藏 +${fav} 首，新歌单 ${made} 个，歌单里 +${songs} 首`
      + (fail.length ? `\n没导成：${fail.join('；')}` : ''), fail.length ? 'error' : 'success', fail.length ? 8000 : 4000);
  } catch (e) {
    showToast('网易云导入失败：' + (e && e.message || e) + '（这一步要连着电脑的 server）', 'error', 4000);
  } finally { _mNeBusy = false; }
}

// ── 面板 UI ──
//
// _mViewList 是"现在正看着哪个歌单的详情"。null = 列表页。
// 它**故意不进 state**：这是看到哪儿了，不是数据。存起来的话下次开面板
// 会莫名其妙停在某个歌单里，而她以为自己打开的是播放器。
var _mViewList = null;
var _mTab = 'search';    // search | fav | lists | queue

// 页签在抽屉里，切页签就意味着要看它：抽屉顺手打开（聊天里的歌单卡片也走这里）
function musicSetTab(t) { if (t !== _mTab) _mListQ = ''; _mTab = t; _mViewList = null; _mDrawerOpen = true; _mRowCap = _M_ROW_STEP0; musicRefresh(); }
function musicOpenList(id) { _mViewList = id; _mListQ = ''; _mRowCap = _M_ROW_STEP0; musicRefresh(); }
function musicBackToLists() { _mViewList = null; _mListQ = ''; musicRefresh(); }

// 长列表分段画。网易云导进来 1718 首收藏后，整页一次画完是 80 万字的 HTML，
// 浏览器吃下去再排版要 450ms（桌面实测，拼字符串本身才 4ms）——而切歌、暂停、点心都会整面板重画。
// 所以先画前 200 行，抽屉滚到底再续 300 行。已经续出来的行数重画时保留（不然她翻到第 600 首
// 点一下心就被截回 200 行），切页签/换歌单才归位。
const _M_ROW_STEP0 = 200, _M_ROW_STEP = 300;
var _mRowCap = _M_ROW_STEP0;
function _mMoreRowsHtml(total) {
  return total > _mRowCap
    ? `<button class="music-pl-back music-more-rows" onclick="_mMoreRows()">再显示 ${Math.min(_M_ROW_STEP, total - _mRowCap)} 首（共 ${total} 首）</button>`
    : '';
}
function _mMoreRows() { _mRowCap += _M_ROW_STEP; musicRefresh(); }
function _mDrawerScroll(el) {
  if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - 300) return;
  if (el.querySelector && el.querySelector('.music-more-rows')) _mMoreRows();
}

// favSet 可选：列表页一次画上千行时先建好一个 Set 传进来。逐行 musicIsFav 是 O(收藏数)，
// 网易云导进来 1700 首后收藏页每重画一次就是三百万次比较，切歌、点心都会顿一下。
function _mHeartBtn(song, handler, favSet) {
  const on = favSet ? favSet.has(String(song.id)) : musicIsFav(song.id);
  return `<button class="music-row-q music-fav${on ? ' on' : ''}" onclick="event.stopPropagation();${handler}" title="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>`;
}

function _mCoverBox(p, big) {
  return p.cover
    ? `<img class="music-pl-cover${big ? ' big' : ''}" src="${escHtml(p.cover)}" alt="">`
    : `<div class="music-pl-cover${big ? ' big' : ''} music-cover-none">🎵</div>`;
}

// ── 在收藏 / 歌单里找歌（用户要的）──
// 只在本地这份列表里筛，不联网。几个词空格隔开＝都得对上（歌名或歌手里），跟搜索页同一套归一化。
// 打字时只换 #mzLqRows 里的行，不走 musicRefresh：整面板重画会把输入框换掉，
// 中文输入法拼到一半的字就没了。筛出来的行 onclick 用的仍是原列表里的下标。
var _mListQ = '';
const _M_LQ_MIN = 10;     // 不到 10 首一眼就看完了，不摆搜索框
// 比搜索页多抹几个标点：她收藏里一堆「夜、萤火虫和你」「Run Rabbit!」这种，打字时不会带
const _mLqNorm = s => musicSearchNorm(s).replace(/[、！!？?~～:：;；\/／&＆]/g, '');
function _mListQMatch(songs) {
  const rows = songs.map((s, i) => [s, i]);
  const parts = _mListQ.trim().split(/\s+/).map(_mLqNorm).filter(Boolean);
  if (!parts.length) return rows;
  return rows.filter(([s]) => { const t = _mLqNorm(s.name + ' ' + (s.artist || '')); return parts.every(p => t.includes(p)); });
}
function _mListQBox(n) {
  if (n < _M_LQ_MIN && !_mListQ) return '';
  return `<div class="music-search mz-lq">
    <input id="musicListQ" class="music-search-in" type="search" placeholder="在这 ${n} 首里找歌名 / 歌手…" value="${escHtml(_mListQ)}"
      oninput="_mListQInput(event)" oncompositionend="_mListQInput(event)" onkeydown="_mListQKey(event)" spellcheck="false" autocomplete="off">
  </div>`;
}
function _mListQInput(e) {
  // 组字中照样筛（安卓 Gboard 打英文也一直挂着组字，等上屏的话手机上就不动了）——
  // 反正只换行区不换框，拼音不会被吞。只是拼音字母多半对不上，那时先别把列表换成「没有」，留着上一屏
  if (e.isComposing) {
    const old = _mListQ; _mListQ = e.target.value;
    const hit = _mListQMatch(_mTab === 'fav' ? _mFavs() : (_mListById(_mViewList) || { songs: [] }).songs).length;
    _mListQ = old;
    if (!hit) return;
  }
  _mListQ = e.target.value;
  _mRowCap = _M_ROW_STEP0;
  const box = document.getElementById('mzLqRows');
  const p = _mViewList && _mListById(_mViewList);
  if (box) box.innerHTML = _mTab === 'fav' ? _mFavRows() : p ? _mListRows(p) : '';
  const dr = document.getElementById('mzDrawerBody'); if (dr) dr.scrollTop = 0;
}
// Esc 先清框，框里空了才让它往外冒（关抽屉/面板那些）
function _mListQKey(e) {
  if (e.key !== 'Escape' || !e.target.value) return;
  e.preventDefault(); e.stopPropagation();
  e.target.value = ''; _mListQInput({ target: e.target });
}
function _mListQNone() {
  return `<div class="music-idle">这里没有「${escHtml(_mListQ.trim())}」<br><span class="study-dim">歌名、歌手都对过了；想找新的去搜索页</span></div>`;
}

// 收藏页
function _mRenderFav() {
  const favs = _mFavs();
  if (!favs.length) return `<div class="music-idle">还没有收藏的歌<br><span class="study-dim">听到喜欢的，点一下歌旁边的 ☆</span></div>`;
  return `<div class="music-sub-t">我的收藏 · ${favs.length} 首</div>${_mListQBox(favs.length)}<div id="mzLqRows">${_mFavRows()}</div>`;
}
function _mFavRows() {
  const favs = _mFavs(), rows = _mListQMatch(favs);
  if (!rows.length) return _mListQNone();
  let h = `${_mListQ.trim() ? `<div class="mz-lq-n">找到 ${rows.length} 首</div>` : ''}<div class="music-list">`;
  const favSet = new Set(favs.map(s => String(s.id)));
  rows.slice(0, _mRowCap).forEach(([s, i]) => {
    h += `<div class="music-row${_mNow && _mSameSong(_mNow.id, s.id) ? ' on' : ''}">
      <span class="music-row-name" onclick="musicPlayFav(${i})">${escHtml(s.name)}</span>
      <span class="music-row-artist" onclick="musicPlayFav(${i})">${escHtml(s.artist || '')}</span>
      <button class="music-row-q" onclick="event.stopPropagation();musicAddToPlaylist(_mFavs()[${i}],this)" title="加入歌单">＋</button>
      ${_mHeartBtn(s, `musicToggleFav(_mFavs()[${i}])`, favSet)}
    </div>`;
  });
  return h + `</div>` + _mMoreRowsHtml(rows.length);
}

// 歌单详情页
function _mRenderListDetail(p) {
  let h = `<div class="music-pl-head">
    ${_mCoverBox(p, true)}
    <div class="music-pl-meta">
      <div class="music-pl-name" onclick="musicPlaylistRename('${escHtml(p.id)}')" title="点一下改名">${escHtml(p.name)}</div>
      <div class="music-pl-desc" onclick="musicPlaylistEditDesc('${escHtml(p.id)}')" title="点一下改简介">${p.desc ? escHtml(p.desc) : '<span class="study-dim">还没写简介，点一下加上</span>'}</div>
      <div class="music-pl-sub">${p.songs.length} 首${p.by === 'ai' ? ' · AI 建的' : ''}</div>
      <div class="music-ctrl">
        <button class="music-btn music-btn-main" onclick="musicPlaylistPlay('${escHtml(p.id)}')">▶ 播放全部</button>
        <label class="music-btn" title="换封面">换封面<input type="file" accept="image/*" hidden onchange="musicPlaylistCover('${escHtml(p.id)}',this)"></label>
        ${p.cover ? `<button class="music-btn" onclick="musicPlaylistClearCover('${escHtml(p.id)}')" title="去掉封面">去封面</button>` : ''}
        <button class="music-btn" onclick="musicPlaylistDelete('${escHtml(p.id)}')" title="删除歌单">删除</button>
      </div>
    </div>
  </div>
  <button class="music-pl-back" onclick="musicBackToLists()">‹ 所有歌单</button>`;
  if (!p.songs.length) return h + `<div class="music-idle">这个歌单还是空的<br><span class="study-dim">搜到歌之后点 ＋ 放进来</span></div>`;
  return h + _mListQBox(p.songs.length) + `<div id="mzLqRows">${_mListRows(p)}</div>`;
}
function _mListRows(p) {
  const rows = _mListQMatch(p.songs);
  if (!rows.length) return _mListQNone();
  let h = `${_mListQ.trim() ? `<div class="mz-lq-n">找到 ${rows.length} 首</div>` : ''}<div class="music-list">`;
  const favSet = new Set(_mFavs().map(x => String(x.id)));
  rows.slice(0, _mRowCap).forEach(([s, i]) => {
    h += `<div class="music-row${_mNow && _mSameSong(_mNow.id, s.id) ? ' on' : ''}">
      <span class="music-row-name" onclick="musicPlaylistPlaySong('${escHtml(p.id)}',${i})">${escHtml(s.name)}</span>
      <span class="music-row-artist" onclick="musicPlaylistPlaySong('${escHtml(p.id)}',${i})">${escHtml(s.artist || '')}</span>
      ${_mHeartBtn(s, `musicToggleFav(_mListById('${escHtml(p.id)}').songs[${i}])`, favSet)}
      <button class="music-row-q" onclick="event.stopPropagation();musicPlaylistRemoveSong('${escHtml(p.id)}',${i})" title="从歌单移除">－</button>
    </div>`;
  });
  return h + `</div>` + _mMoreRowsHtml(rows.length);
}

// 歌单列表页
function _mRenderLists() {
  if (_mViewList) {
    const p = _mListById(_mViewList);
    if (p) return _mRenderListDetail(p);
    _mViewList = null;      // 歌单被删了还停在详情页的话，回列表，别白屏
  }
  const lists = _mLists();
  let h = `<div class="music-sub-t">歌单 · ${lists.length} 个<button class="music-pl-new" onclick="musicPlaylistNew()">＋ 新建</button><button class="music-pl-new" onclick="musicNeteaseImport()" title="把网易云「喜欢的音乐」和自建歌单拉进来">⤓ 网易云</button></div>`;
  if (!lists.length) return h + `<div class="music-idle">还没有歌单<br><span class="study-dim">建一个，或者让 AI 按心情给你攒一个</span></div>`;
  h += `<div class="music-pl-grid">`;
  lists.forEach(p => {
    h += `<div class="music-pl-card" onclick="musicOpenList('${escHtml(p.id)}')">
      ${_mCoverBox(p)}
      <div class="music-pl-card-name">${escHtml(p.name)}</div>
      <div class="music-pl-card-sub">${p.songs.length} 首${p.by === 'ai' ? ' · AI' : ''}</div>
    </div>`;
  });
  return h + `</div>`;
}

// musicRefresh 拼抽屉时调它：页签 + 收藏/歌单/队列（搜索页由 _mSearchHtml 接在后面）
function musicSectionsHtml() {
  // 数字单独包一层 <small>：抽屉里的分段页签要把它压小压淡，不然「收藏 1727」四位数比字还抢眼
  const tab = t => `<button class="music-tab${_mTab === t.k ? ' on' : ''}" onclick="musicSetTab('${t.k}')">${t.n}${t.c ? ` <small>${t.c}</small>` : ''}</button>`;
  let h = `<div class="music-tabs">${[
    { k: 'search', n: '搜索' }, { k: 'fav', n: '收藏', c: _mFavs().length },
    { k: 'lists', n: '歌单', c: _mLists().length },
    { k: 'queue', n: '队列', c: _mQueue.length }
  ].map(tab).join('')}</div>`;
  if (_mTab === 'fav') h += _mRenderFav();
  else if (_mTab === 'lists') h += _mRenderLists();
  else if (_mTab === 'queue') h += _mRenderQueue();
  return h;
}

// ── AI 建歌单：[[PLAYLIST: 名字 | 简介 | 歌1 歌手 / 歌2 歌手]] ──
//
// ⚠️ 必须固化。这条跟 [[MUSIC:]]→[[SONG:]] 是同一个坑，但后果重得多：
// 标签留在消息里不换掉的话，**每次重新渲染这条消息都会再建一个歌单**——
// 翻一次历史记录就多出一串同名歌单，而且一声不响。所以搜完立刻把原标签
// 换成 [[PLIST:id|...]]，认到 PLIST 就只是把已有的那个画出来。
function musicPlaylistAskRe() { return /\[\[PLAYLIST:\s*([^\]]+?)\s*\]\]/g; }
function musicPlaylistTagRe() { return /\[\[PLIST:\s*([^|\]]+)\|([^|\]]*)\|?([^\]]*)\]\]/g; }

// "名字 | 简介 | 歌1 / 歌2"。简介可以省（只有两段时中间那段当歌单）。
function _mParsePlaylistSpec(raw) {
  const parts = String(raw).split('|').map(x => x.trim());
  const name = parts[0] || '';
  const songs = (parts.length >= 3 ? parts[2] : parts[1] || '')
    .split('/').map(x => x.trim()).filter(Boolean).slice(0, 20);   // 上限 20，别让它一次点两百首
  return { name, desc: parts.length >= 3 ? parts[1] : '', songs };
}

var _mPlBuilding = {};    // 同一张卡在途时别重复开工

function musicPlaylistCardHtml(p) {
  return `<div class="music-pl-card-chat" onclick="openMusic();musicSetTab('lists');musicOpenList('${escHtml(p.id)}')">
    ${_mCoverBox(p)}
    <div class="music-pl-chat-meta">
      <div class="music-pl-card-name">${escHtml(p.name)}</div>
      ${p.desc ? `<div class="music-pl-card-sub">${escHtml(p.desc)}</div>` : ''}
      <div class="music-pl-card-sub">${p.songs.length} 首 · 点开听</div>
    </div>
  </div>`;
}

async function resolvePlaylistBuild(elementId, raw) {
  const swap = html => { const el = document.getElementById(elementId); if (el) el.outerHTML = html; };
  const spec = _mParsePlaylistSpec(raw);
  if (!spec.name || !spec.songs.length) { swap(`<div class="music-card music-card-load">🎵 歌单没写全</div>`); return; }
  try {
    const p = musicPlaylistCreate(spec.name, spec.desc, 'ai');
    if (!p) { swap(`<div class="music-card music-card-load">🎵 歌单建不出来</div>`); return; }
    // 一首一首搜。挂掉的那几首跳过就好——凑不齐 12 首不是失败，
    // 整条报错才是（她会觉得"AI 说要建歌单结果什么都没有"）。
    for (const q of spec.songs) {
      try { const r = await musicPick(q); if (r?.song) musicPlaylistAdd(p.id, r.song); } catch (e) {}
    }
    save();
    const elGone = !document.getElementById(elementId);
    swap(musicPlaylistCardHtml(p));
    _persistPlaylistResult(raw, p);
    if (elGone) renderMessages();
    else musicRefresh();
  } catch (e) {
    swap(`<div class="music-card music-card-load">🎵 建歌单要连着电脑的后端服务</div>`);
  }
}

// 把消息里的 [[PLAYLIST:...]] 换成 [[PLIST:id|名字|简介]]
function _persistPlaylistResult(raw, p) {
  const chat = getActiveChat();
  if (!chat) return;
  const re = new RegExp(`\\[\\[PLAYLIST:\\s*${String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]`, 'g');
  const tag = `[[PLIST:${p.id}|${_mTagSafe(p.name)}|${_mTagSafe(p.desc)}]]`;
  let changed = false;
  const fix = str => { if (!str) return str; const r = str.replace(re, tag); if (r !== str) changed = true; return r; };
  for (const node of Object.values(chat.nodes)) {
    node.content = fix(node.content);
    if (node.blocks) node.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    if (node.variants) node.variants.forEach(v => {
      v.content = fix(v.content);
      if (v.blocks) v.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    });
  }
  if (changed) save();
}

// 渲染层：认 PLIST（已建好的）和 PLAYLIST（要去建的）
function musicPlaylistTagToHtml(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  if (text.indexOf('[[PLIST:') >= 0) {
    text = text.replace(musicPlaylistTagRe(), (m, id, name, desc) => {
      const p = _mListById(id);
      // 歌单被她删了：不留半张坏卡片，就说一句它没了
      if (!p) return `\n\n<div class="music-card music-card-load">🎵 歌单《${escHtml((name || '').trim())}》已删除</div>\n\n`;
      return '\n\n' + musicPlaylistCardHtml(p) + '\n\n';
    });
  }
  if (text.indexOf('[[PLAYLIST:') >= 0) {
    text = text.replace(musicPlaylistAskRe(), (m, raw) => {
      if (!musicEnabled()) return m;
      const key = raw.trim();
      if (_mPlBuilding[key]) return `\n\n<div class="music-card music-card-load">🎵 歌单整理中…</div>\n\n`;
      _mPlBuilding[key] = 1;
      const uid = 'plbuild_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      setTimeout(() => resolvePlaylistBuild(uid, key).finally(() => { delete _mPlBuilding[key]; }), 30);
      return `\n\n<div id="${uid}" class="music-card music-card-load">🎵 歌单整理中…</div>\n\n`;
    });
  }
  return text;
}
