// ============================================================
// 点歌 · 设备遥控（用户：「像 spotify 那样手机控制电脑播放，
// 取消设备控制之后就是 2 端各放各的」，电脑也要能反过来遥控手机）
//
// 链路：每台设备挂一条长连接到电脑 server（server/music-remote.js），
//   · 在放歌的那台把状态（哪首、进度、暂停、队列、模式、倍速）报上去；
//   · 遥控的那台收这份状态，把整块面板变成那台的镜像，按钮全部变成指令发过去。
// 歌永远在被遥控的那台真的放，遥控这台一点声音都不出。
//
// 怎么做到「面板一行都不用重写」：进遥控时把 _mAudio 换成一个替身（_mrProxy），
// 它的 currentTime/paused/duration 从对方报来的状态推算；_mNow/_mQueue 也换成镜像。
// 面板、歌词、进度条、频谱照旧读这几个变量，看到的就是对方那首。
// 按钮那头：24-music.js 里每个播放动作开头有 _mRC(...) 钩子，遥控时把指令发走、本机不动。
// 断开时把进遥控前的本机现场（_mrLocal）原样放回去——手机回到它自己那首（暂停着），两边各放各的。
//
// ⚠️ 这个文件顶层只在真浏览器里才连网（见文件末尾），拿去 vm 里测不会自己跑起来。
// ============================================================

var _mrDev = null;          // 本机 { id, name, kind }
var _mrConn = null;         // 当前这条长连接 { ctl, live }
var _mrDevices = [];        // server 给的设备表
var _mrStates = {};         // 别的设备最近报来的状态 { [id]: { st, recv } }
var _mrRetry = 0, _mrRetryTimer = 0;
var _mrLocal = null;        // 进遥控前本机的播放现场
var _mrLastSig = '', _mrLastPushAt = 0, _mrLastT = 0, _mrPushTimer = 0;
var _mrTickTimer = 0, _mrSeekTimer = 0;
var _mrBy = {};             // 谁在遥控我、上次提醒是什么时候（toast 别每条指令弹一次）
var _mrLostAt = 0;          // 遥控中连接断了的时刻（断太久就自动退出遥控）
const _MR_LOST_GIVEUP = 20000;

function _mrSelf() {
  if (_mrDev) return _mrDev;
  let id = '';
  try { id = localStorage.getItem('kuro_musicDevId') || ''; } catch (e) {}
  if (!/^[\w.-]{6,64}$/.test(id)) {
    id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('kuro_musicDevId', id); } catch (e) {}
  }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  let kind, name;
  if (window.GrancyanBand || window.GrancyanMusic) { kind = 'phone'; name = '手机'; }
  else if (/Electron/i.test(ua)) { kind = 'pc'; name = '电脑'; }
  else if (/Android|iPhone|iPad|Mobile/i.test(ua)) { kind = 'phone'; name = '手机网页'; }
  else { kind = 'pc'; name = '浏览器'; }
  return (_mrDev = { id, name, kind });
}
function _mrBase() { return typeof SERVER_BASE === 'string' ? SERVER_BASE : ''; }
async function _mrPost(p, body) {
  try {
    const r = await fetch(_mrBase() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {}
    return j || { ok: r.ok };
  } catch (e) { return { ok: false, error: '连不上电脑的 server' }; }
}
function _mrOthers() { const me = _mrSelf().id; return _mrDevices.filter(d => d.id !== me && d.online); }
function _mrWatchers() { const me = _mrSelf().id; return _mrDevices.filter(d => d.id !== me && d.target === me); }
function _mrName(id) { const d = _mrDevices.find(x => x.id === id); return d ? d.name : '那台设备'; }

// ── 长连接 ──
// 用 fetch 读流而不是 EventSource：EventSource 加不了请求头，手机连电脑要带配对码（X-GC-Token，
// 01-core 的 fetch 包装器自动加）。
function musicRemoteStart() {
  if (_mrConn) return;
  const me = _mrSelf();
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const conn = _mrConn = { ctl, live: false };
  const url = `${_mrBase()}/api/music/remote/stream?dev=${encodeURIComponent(me.id)}&name=${encodeURIComponent(me.name)}&kind=${me.kind}`;
  (async () => {
    try {
      const r = await fetch(url, { signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      conn.live = true; _mrRetry = 0;
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, k); buf = buf.slice(k + 2); _mrOnBlock(blk); }
      }
    } catch (e) {}
    if (_mrConn !== conn) return;
    _mrConn = null;
    _mrDevices = [];
    if (_mRemote && !_mrLostAt) _mrLostAt = Date.now();
    _mrSchedule();
    if (typeof musicRefresh === 'function') musicRefresh();
  })();
}
function _mrSchedule() {
  clearTimeout(_mrRetryTimer);
  // 遥控中断线太久：那台多半真的没了（电脑关机 / 出了门），退回本机
  if (_mRemote && _mrLostAt && Date.now() - _mrLostAt > _MR_LOST_GIVEUP) {
    musicRemoteDetach(true);
    showToast('和电脑的连接断了，已经退回这台自己放', 'info', 3500);
  }
  const wait = _mRemote ? 2000 : Math.min(60000, 2000 * Math.pow(2, _mrRetry++));
  _mrRetryTimer = setTimeout(musicRemoteStart, wait);
}
function musicRemoteReconnect() {
  clearTimeout(_mrRetryTimer);
  if (_mrConn && _mrConn.ctl) try { _mrConn.ctl.abort(); } catch (e) {}
  _mrConn = null; _mrRetry = 0;
  musicRemoteStart();
}

function _mrOnBlock(blk) {
  let ev = 'message', data = '';
  for (const line of blk.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  let d; try { d = JSON.parse(data); } catch (e) { return; }
  _mrHandle(ev, d);
}
function _mrHandle(ev, d) {
  const me = _mrSelf().id;
  if (ev === 'hello') {
    _mrDevices = Array.isArray(d.devices) ? d.devices : [];
    _mrLostAt = 0;
    // 断线重连回来：还在遥控的话重新挂上去（server 那边可能已经把我当成走了），
    // 自己在放歌的话把状态重报一遍（server 重启过的话它什么都不记得）
    if (_mRemote) _mrReattach();
    else { _mrLastSig = ''; musicRemoteNote(true); }
  } else if (ev === 'devices') {
    _mrDevices = Array.isArray(d) ? d : [];
    _mrNoteWatchers();
    if (_mRemote && !_mrDevices.some(x => x.id === _mRemote.dev)) {
      musicRemoteDetach(true);
      showToast('那台设备不在了，已经退回这台自己放', 'info', 3000);
    }
  } else if (ev === 'state') {
    if (!d || !d.dev || d.dev === me) return;
    const age = Math.max(0, +d.age || 0);
    _mrStates[d.dev] = { st: d.st || null, recv: Date.now() - age };
    if (_mRemote && d.dev === _mRemote.dev) _mrApply(d.st || null, age);
  } else if (ev === 'cmd') {
    _mrExec(d || {});
  } else if (ev === 'released') {
    // server 把我从遥控器上摘了：要么我遥控的那台自己去遥控别人了，要么有设备来遥控我
    // （一台设备不能又在放歌又在当遥控器，见 server/music-remote.js attach）
    if (_mRemote && d) {
      const was = _mRemote.name, wasDev = _mRemote.dev;
      musicRemoteDetach(true);
      const who = d.byName || _mrName(d.by);
      showToast(d.to !== me ? `${who}去遥控${_mrName(d.to)}了，已经退回这台自己放`
        : d.by === wasDev ? `🎛 ${who}反过来遥控这台了，这台不再遥控它`
        : `🎛 ${who}开始遥控这台，已停止遥控${was}`, 'info', 3200);
    }
  } else if (ev === 'gone') {
    if (_mRemote && d && d.dev === _mRemote.dev) {
      const nm = _mRemote.name;
      musicRemoteDetach(true);
      showToast(`${nm}下线了，已经退回这台自己放`, 'info', 3000);
    }
  }
  _mrRefreshBtn();
}
// 设备表变了只换那一个按钮，不整块重画面板——整块重画会打断正在拨的唱片、正在拖的进度条
function _mrRefreshBtn() {
  if (typeof document === 'undefined' || !document.querySelector) return;
  const b = document.querySelector('#musicBody .mz-dev');
  if (b) b.outerHTML = musicRemoteBtn();
}
// 被遥控时提醒一句（每台遥控器十分钟最多一次）
var _mrWatchSig = '';
function _mrNoteWatchers() {
  // 有新的遥控器挂上来：当场报一份新鲜的状态（server 手里那份可能是几秒前的）
  const sig = _mrWatchers().map(w => w.id).sort().join();
  if (sig !== _mrWatchSig) { _mrWatchSig = sig; if (sig) musicRemoteNote(true); }
  for (const w of _mrWatchers()) {
    if (Date.now() - (_mrBy[w.id] || 0) > 600000) {
      _mrBy[w.id] = Date.now();
      showToast(`🎛 ${w.name}在遥控这里放歌`, 'info', 3000);
    }
  }
}

// ── 报状态（在放歌的那台）──
// 播放/暂停/切歌/改队列都会走到 musicRefresh → 这里；自己去重：内容没变、进度也和推算的对得上就不报。
// 被人盯着（有设备在遥控我）时每 15 秒至少校一次进度，免得那边的进度条越走越偏。
function musicRemoteNote(force) {
  if (_mRemote || !_mrConn || !_mrConn.live) return;
  clearTimeout(_mrPushTimer);
  _mrPushTimer = setTimeout(() => _mrPush(!!force), force ? 0 : 250);
}
function _mrStateNow() {
  const a = _mAudio, n = _mNow;
  const base = { mode: _mMode, rate: _mRate, queue: _mQueue.slice(0, 100).map(_mSlim), ctxN: _mCtx ? _mCtx.length : 0 };
  if (!n) return Object.assign({ song: null, t: 0, dur: 0, paused: true }, base);
  const dur = a && isFinite(a.duration) ? a.duration : 0;
  return Object.assign({
    song: { id: n.id, name: n.name || '', artist: n.artist || '', cover: n.cover || '', url: n.url || '' },
    t: a ? +a.currentTime || 0 : 0, dur, paused: !a || !!a.paused,
  }, base);
}
function _mrPush(force) {
  if (_mRemote || !_mrConn || !_mrConn.live) return;
  const st = _mrStateNow();
  if (_mAudio && !_mAudio._mrHooked && _mAudio.addEventListener) {
    _mAudio._mrHooked = true;
    ['seeked', 'durationchange'].forEach(e => _mAudio.addEventListener(e, () => musicRemoteNote()));
  }
  const sig = JSON.stringify(Object.assign({}, st, { t: 0, dur: Math.round(st.dur) }));
  const now = Date.now();
  const guess = _mrLastT + (st.paused ? 0 : (now - _mrLastPushAt) / 1000 * (st.rate || 1));
  if (!force && sig === _mrLastSig && Math.abs(st.t - guess) < 1.5 && now - _mrLastPushAt < 15000) return;
  _mrLastSig = sig; _mrLastPushAt = now; _mrLastT = st.t;
  _mrPost('/api/music/remote/state', { dev: _mrSelf().id, st });
}

// ── 被遥控（执行别人发来的指令）──
async function _mrExec(d) {
  // 我自己正在遥控别人时，本机的真播放器被收在 _mrLocal 里，不在前台——这时候别人发来的指令不接，
  // 否则会作用在镜像上（把替身当播放器）。设备菜单里看得到「谁在遥控谁」。
  if (_mRemote) return;
  const a = d.args || {};
  if (d.from) { _mrBy[d.from] = _mrBy[d.from] || 0; _mrNoteWatchers(); }
  switch (d.cmd) {
    case 'toggle': if (_mNow) musicToggle(); else musicPlayLast(); break;
    case 'pause': if (_mAudio && !_mAudio.paused) _mAudio.pause(); break;
    case 'next': musicNext(); break;
    case 'prev': musicPrev(); break;
    case 'stop': musicStop(); break;
    case 'seek': if (_mNow && _mAudio && isFinite(+a.t)) _mLySeekTo(+a.t); break;
    case 'mode': _mSetMode(a.m); break;
    case 'rate': if (_M_RATES.includes(+a.r)) {
      _mRate = +a.r;
      try { localStorage.setItem('kuro_musicRate', String(_mRate)); } catch (e) {}
      if (_mAudio) { _mAudio.defaultPlaybackRate = _mRate; _mAudio.playbackRate = _mRate; }
    } break;
    case 'queue':
      if (Array.isArray(a.queue)) _mQueue = a.queue.filter(s => s && s.id != null).map(_mSlim);
      if (a.clearCtx) _mCtx = null;
      break;
    case 'play': {
      if (!a.song || a.song.id == null) break;
      if (a.ctx !== 'keep') _mCtx = Array.isArray(a.ctx) ? a.ctx.filter(s => s && s.id != null).map(_mSlim) : null;
      _mQueue = Array.isArray(a.queue) ? a.queue.filter(s => s && s.id != null).map(_mSlim) : [];
      await _mrPlayAt(_mSlim(a.song), +a.t || 0);
      break;
    }
    default: return;
  }
  if (typeof musicRefresh === 'function') musicRefresh();
  musicRemoteNote(true);
}
// 放一首并跳到第几秒（「转到这台放」接着对方的进度）
async function _mrPlayAt(song, t) {
  // 已经在放的就是这首：别走 musicPlay（它把「点正在放的那首」当成暂停键），接着放、跳秒就行
  if (_mNow && _mSameSong(_mNow.id, song.id) && _mAudio && _mAudio.src && !_mRemote) {
    if (_mAudio.paused) { try { await _mAudio.play(); } catch (e) { _mPlayFailed(e); } }
  } else await musicPlay(song);
  if (t > 1 && _mNow && _mSameSong(_mNow.id, song.id) && _mAudio && !_mRemote) {
    try { _mAudio.currentTime = t; } catch (e) {}
    _mTick();
  }
}

// ── 遥控别人 ──
// 替身播放器：进度按「对方报来的那一刻 + 过去了多久 × 倍速」推算；拖进度先在本地显示，
// 停手 120ms 再把最后的位置发过去（拖的时候每一帧都发的话一秒几十条）。
function _mrProxy() {
  return {
    _st: null, _recv: 0, _seekT: null, _seekAt: 0, _mrHooked: true, src: '', defaultPlaybackRate: 1,
    get paused() { return !this._st || !this._st.song || !!this._st.paused; },
    get duration() { return (this._st && +this._st.dur) || 0; },
    get playbackRate() { return (this._st && +this._st.rate) || 1; },
    set playbackRate(v) {},
    get currentTime() {
      const run = s => this.paused ? 0 : (Date.now() - s) / 1000 * this.playbackRate;
      let t;
      if (this._seekT != null && Date.now() - this._seekAt < 2500) t = this._seekT + run(this._seekAt);
      else t = this._st ? (+this._st.t || 0) + run(this._recv) : 0;
      return this.duration ? Math.max(0, Math.min(t, this.duration)) : Math.max(0, t);
    },
    set currentTime(v) {
      v = +v; if (!isFinite(v)) return;
      this._seekT = v; this._seekAt = Date.now();
      clearTimeout(_mrSeekTimer);
      _mrSeekTimer = setTimeout(() => _mRC('seek', { t: v }), 120);
    },
    play() { return Promise.resolve(); }, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
  };
}
// 对方报来一份状态 → 镜像到面板上
// age：这份状态是多久以前报的（刚挂上时拿到的是 server 手里存着的那份，可能已经过去好几秒）
function _mrApply(st, age) {
  if (!_mRemote) return;
  const p = _mRemote.proxy;
  // 刚拖过进度、对方回报的位置已经跟上了 → 以对方为准，不再用本地那份临时值
  if (p._seekT != null && st && Math.abs((+st.t || 0) - p._seekT) < 2) p._seekT = null;
  p._st = st; p._recv = Date.now() - Math.max(0, +age || 0);
  const song = st && st.song;
  if (!song) {
    if (_mNow) {
      _mNow = null; _mLyric = null; _mWordCur = -1; _mTint = null;
      _mPlayReq++; _mLyricReq++; _mTintReq++;
      _mFluidSet(null); _mApplyTint();
    }
  } else if (!_mNow || !_mSameSong(_mNow.id, song.id)) {
    const seq = ++_mPlayReq;
    _mNow = Object.assign({}, song, { _retried: true });
    const f = _mFeatGet(String(song.id)); if (f) _mNow.feat = f;
    musicLoadLyric(song.id);
    _mCoverTint(song.cover);
    if (song.url) _mListen(_mNow, seq);   // 频谱圈照样跟着歌跳（音频从 CDN 直拉，不经过对方）
  }
  _mQueue = Array.isArray(st && st.queue) ? st.queue.map(s => Object.assign({}, s)) : [];
  const n = (st && +st.ctxN) || 0;
  if (n) { const c = new Array(n).fill(null); c._mirror = true; _mCtx = c; } else _mCtx = null;
  if (st && _M_MODES.includes(st.mode)) _mMode = st.mode;
  if (st && _M_RATES.includes(+st.rate)) _mRate = +st.rate;
  // 只是例行校进度（内容没变）就只挪进度条和歌词，不整块重画——
  // 重画会打断正在拨的唱片、把抽屉里翻到的位置顶回去
  const sig = JSON.stringify([song && song.id, st && !!st.paused, _mMode, _mRate, _mQueue.map(s => s.id), n, Math.round((st && st.dur) || 0)]);
  if (sig !== _mRemote.sig) { _mRemote.sig = sig; _mPaint(); } else _mTick();
}
function musicRemoteSend(cmd, args) {
  if (!_mRemote) return;
  const to = _mRemote.dev;
  // 暂停/播放先在镜像上翻过来，按钮立刻有反应；对方执行完会报回真状态盖掉
  const p = _mRemote.proxy;
  if (cmd === 'toggle' && p._st && p._st.song) {
    p._st = Object.assign({}, p._st, { t: p.currentTime, paused: !p._st.paused }); p._recv = Date.now(); p._seekT = null;
    _mPaint();
  }
  return _mrPost('/api/music/remote/cmd', { from: _mrSelf().id, to, cmd, args }).then(r => {
    if (!r || r.ok !== false) return r;
    // server 说我早就不挂着那台了（「released」没收到）：别再假装在遥控
    if (r.detached && _mRemote && _mRemote.dev === to) {
      const nm = _mRemote.name;
      musicRemoteDetach(true);
      showToast(`已经不在遥控${nm}了，退回这台自己放`, 'info', 3000);
    } else showToast(`${_mRemote ? _mRemote.name : '那台设备'}没收到：${r.error || '不在线'}`, 'error', 3000);
    return r;
  });
}
async function musicRemoteAttach(devId) {
  const me = _mrSelf();
  if (!devId || devId === me.id) return false;
  const r = await _mrPost('/api/music/remote/attach', { dev: me.id, to: devId });
  if (!r || !r.ok) { showToast((r && r.error) || '连不上那台设备', 'error', 3000); return false; }
  if (!_mRemote) {
    // 本机现场收起来。本机在放的话先暂停——你现在要听的是那台
    if (_mAudio && !_mAudio.paused) try { _mAudio.pause(); } catch (e) {}
    // 「这台暂停了」要趁还没切成镜像时当场报掉：pause 事件排的那次报状态会晚到，
    // 那时 _mRemote 已经挂上、报状态被挡住，别的设备就一直以为这台还在放
    _mrPush(true);
    _mrLocal = { audio: _mAudio, now: _mNow, queue: _mQueue, ctx: _mCtx, mode: _mMode, rate: _mRate, lyric: _mLyric };
    _mRemote = { dev: devId, name: _mrName(devId), proxy: _mrProxy() };
    _mAudio = _mRemote.proxy; _mNow = null; _mLyric = null; _mQueue = []; _mCtx = null;
    clearInterval(_mrTickTimer);
    _mrTickTimer = setInterval(() => { if (_mRemote) _mTick(); }, 250);
  } else {
    _mRemote.dev = devId; _mRemote.name = _mrName(devId); _mRemote.sig = '';
  }
  _mrLostAt = 0;
  const kept = _mrStates[devId];
  if (r.st) _mrApply(r.st, +r.age || 0);
  else _mrApply(kept ? kept.st : null, kept ? Date.now() - kept.recv : 0);
  showToast(`🎛 正在遥控${_mRemote.name}`, 'success', 2200);
  _mPaint();
  return true;
}
async function _mrReattach() {
  if (!_mRemote) return;
  const r = await _mrPost('/api/music/remote/attach', { dev: _mrSelf().id, to: _mRemote.dev });
  if (r && r.ok) _mrApply(r.st || null, +r.age || 0);
}
// 断开：本机现场原样放回。silent = 不通知 server（它已经不在了 / 连接断了）
function musicRemoteDetach(silent) {
  if (!_mRemote) return;
  if (!silent) _mrPost('/api/music/remote/attach', { dev: _mrSelf().id, to: null });
  clearInterval(_mrTickTimer); _mrTickTimer = 0;
  clearTimeout(_mrSeekTimer);
  const L = _mrLocal || {};
  _mRemote = null; _mrLocal = null; _mrLostAt = 0;
  _mAudio = L.audio || null; _mNow = L.now || null; _mQueue = L.queue || []; _mCtx = L.ctx || null;
  if (_M_MODES.includes(L.mode)) _mMode = L.mode;
  if (_M_RATES.includes(L.rate)) _mRate = L.rate;
  _mPlayReq++; _mLyricReq++;
  _mLyric = L.lyric || null; _mWordCur = -1;
  if (_mLyric) _mLyric.idx = -1;
  if (_mNow) _mCoverTint(_mNow.cover); else { _mTint = null; _mTintReq++; _mFluidSet(null); _mApplyTint(); }
  if (typeof _mPaintLyric === 'function') _mPaintLyric();
  _mPaint();
  _mrLastSig = ''; musicRemoteNote(true);
  if (!silent) showToast('已断开，两边各放各的', 'info', 2200);
}
// 「接到这台放」：那台暂停，这台从同一首、同一秒接着放
async function musicRemoteTakeOver() {
  if (!_mRemote) return;
  const p = _mRemote.proxy, st = p._st;
  const song = st && st.song, t = p.currentTime, q = _mQueue.map(_mSlim);
  if (!song) { musicRemoteDetach(); return; }
  // 等暂停送到再松开：两个请求并发的话「松开」可能先到，server 就不再转发这条暂停，两台一起响
  if (!st.paused) await musicRemoteSend('pause', {});
  musicRemoteDetach(true);
  _mrPost('/api/music/remote/attach', { dev: _mrSelf().id, to: null });
  _mQueue = q; _mCtx = null;
  await _mrPlayAt(_mSlim(song), t);
  showToast('接过来了，在这台接着放', 'success', 2200);
}
// 「把这首转到 X 放」：这台暂停，那台从同一秒接着放，然后这台变成遥控器
async function musicRemoteHandOff(devId) {
  if (_mRemote || !_mNow) return musicRemoteAttach(devId);
  const song = _mSlim(_mNow), t = _mAudio ? +_mAudio.currentTime || 0 : 0;
  const queue = _mQueue.map(_mSlim), ctx = _mCtx ? _mCtx.map(_mSlim) : null;
  if (!(await musicRemoteAttach(devId))) return;
  _mRC('play', { song, queue, ctx, t });
}

// ── 面板上的「设备」按钮 + 菜单 ──
function musicRemoteBtn() {
  if (_mRemote) {
    return `<button type="button" class="mz-dev on" onclick="musicRemoteMenu(this)" title="正在遥控${escHtml(_mRemote.name)}，点开可以断开">遥控 · ${escHtml(_mRemote.name)}</button>`;
  }
  const others = _mrOthers(), by = _mrWatchers();
  if (by.length) return `<button type="button" class="mz-dev by" onclick="musicRemoteMenu(this)" title="${escHtml(by[0].name)}正在遥控这里">${escHtml(by[0].name)}在遥控</button>`;
  return `<button type="button" class="mz-dev${others.length ? '' : ' dim'}" onclick="musicRemoteMenu(this)" title="手机和电脑互相遥控">设备${others.length ? ' · ' + others.length : ''}</button>`;
}
function musicRemoteMenu(anchor) {
  const me = _mrSelf(), items = [];
  if (!_mrConn || !_mrConn.live) {
    items.push({ label: '连不上电脑的 server', sub: '电脑没开 GranCyan / 不在一个网里——点一下重连', dim: true, fn: musicRemoteReconnect });
  } else {
    const others = _mrOthers();
    if (!others.length) items.push({ label: '没有别的设备在线', sub: '手机或电脑打开 GranCyan 就会出现在这里', dim: true, fn: () => {} });
    for (const d of others) {
      const st = _mrStates[d.id] && _mrStates[d.id].st, now = (st && st.song) ? st : null;
      const playing = now ? `${now.paused ? '⏸' : '▶'} ${now.song.name}` : (d.now ? `${d.now.paused ? '⏸' : '▶'} ${d.now.name}` : '没在放');
      const on = !!(_mRemote && _mRemote.dev === d.id);
      items.push({ label: (on ? '✓ 正在遥控' : '遥控') + d.name, sub: playing, on, fn: () => { if (!on) musicRemoteAttach(d.id); } });
      if (!_mRemote && _mNow) items.push({ label: `把这首转到${d.name}放`, sub: '这台暂停，那台从这一秒接着放', fn: () => musicRemoteHandOff(d.id) });
    }
  }
  if (_mRemote) {
    items.push({ sep: true });
    items.push({ label: '接到这台放', sub: `${_mRemote.name}暂停，这台接着放`, fn: musicRemoteTakeOver });
    items.push({ label: '断开遥控', sub: '两边各放各的', fn: () => musicRemoteDetach() });
  }
  const by = _mrWatchers();
  if (by.length && !_mRemote) items.push({ sep: true }, { label: `${by.map(x => x.name).join('、')}正在遥控这里`, sub: me.name, dim: true, fn: () => {} });
  _mPop(anchor, '设备 · 这台是' + me.name, items);
}

// ── 真浏览器里才自己连 ──
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.addEventListener && !window.__mrNoAuto && typeof fetch === 'function') {
  setTimeout(musicRemoteStart, 2500);
  // 手机切回前台：连接多半被系统掐过了，别等退避计时，马上重连
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !_mrConn) { clearTimeout(_mrRetryTimer); _mrRetry = 0; musicRemoteStart(); }
  });
  // 有设备盯着我时，定期校一次进度（_mrPush 自己判断要不要真的发）
  setInterval(() => { if (_mrWatchers().length && _mNow) musicRemoteNote(); }, 5000);
}
