/* ══════════════════════════════════════════════════════════════════════════
   手机近况 · 让它知道你手机上在干嘛（2026-10-03，书签里那几个「屏幕时间同步给 AI」）

   安卓壳的 PhoneBridge（window.GrancyanPhone）给两样东西，都默认关，在「小屋 · 此刻 · 📱 手机近况」里开：
     · 使用情况：今天各 App 的前台时长 + 回到 Grancyan 之前在用哪个 App。
       要她自己去系统设置「使用情况访问」里打开，App 弹不出授权框。
     · 粗略位置：城市 / 区，运行时弹框授权。开着的话天气自动跟着换城市。
   电脑上没有这座桥，面板只会说「去手机上开」。

   喂给 AI 的节奏和 23-peek 一样「读一次就清」，只进 volatile：
     · 刚从别的 App 回来（在那边连着待了 ≥3 分钟、离开不到 10 分钟）→ 提一次，同一段不提第二次
     · 今天的时长摘要 → 最多两小时给一次
     · 在哪 → 换了地方下一轮就给，同一个地方六小时提一次
   没有新东西的轮次一个 token 都不加。

   隐私：精确坐标不出 Java——PhoneBridge 在那边反查完地名，只交出四舍五入到 0.1°（约 11km）的坐标，
   这里只拿它查天气 / 兜底反查。提示词里只有「X 市 Y 区」。这些都只存在这台手机的 localStorage，不上云。
   ════════════════════════════════════════════════════════════════════════ */

const PHONE_KEY = 'grancyan_phone';
const PHONE_DIGEST_GAP_MS    = 2 * 60 * 60 * 1000;   // 今天的时长摘要最多两小时给一次
const PHONE_LOC_TELL_GAP_MS  = 6 * 60 * 60 * 1000;   // 同一个地方六小时提一次
const PHONE_LOC_REFRESH_MS   = 30 * 60 * 1000;       // 位置半小时重新取一次
const PHONE_LOC_MAX_AGE_MS   = 6 * 60 * 60 * 1000;   // 六小时没更新过的位置不再告诉它（多半早挪地方了）
const PHONE_AWAY_MIN_MS      = 3 * 60 * 1000;        // 在别的 App 待了不到 3 分钟不算「刚从那边回来」
const PHONE_BACK_FRESH_MS    = 10 * 60 * 1000;       // 离开那个 App 超过 10 分钟就不算「刚」了
const PHONE_TICK_MS          = 5 * 60 * 1000;
const PHONE_WEATHER_YIELD_MS = 3 * 60 * 60 * 1000;   // 她手动查的城市，3 小时内不被定位抢走
const PHONE_LOCATE_WAIT_MS   = 90 * 1000;            // Java 那边 fused/network 各 15 秒、GPS 45 秒，全等满是 75 秒
const PHONE_GEO_TIMEOUT      = 12000;

let _phone = null;                 // 持久的那份：开关 + 上次位置 + 上次告诉它的时刻
let _phoneUsage = null;            // 最近一次读到的使用情况（只在内存，面板用）
let _phoneLocBusy = false, _phoneLocGen = 0, _phoneLocErr = '';

function _phoneDefaults() {
  return { usageOn: false, locOn: false, loc: null, digestAt: 0, backTold: '', locTold: '', locToldAt: 0 };
}
function _phoneLoad() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(PHONE_KEY)); } catch { o = null; }
  _phone = Object.assign(_phoneDefaults(), o && typeof o === 'object' ? o : {});
  return _phone;
}
function _phoneSave() { try { localStorage.setItem(PHONE_KEY, JSON.stringify(_phone)); } catch {} }
function _phoneBridge() {
  try {
    const b = typeof window !== 'undefined' ? window.GrancyanPhone : null;
    return b && b.available() ? b : null;
  } catch { return null; }
}

function _phoneDur(ms) {
  const m = Math.max(0, Math.round((ms || 0) / 60000));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
function _phoneLabel(a) { return String((a && (a.label || a.pkg)) || '').replace(/\s+/g, ' ').trim().slice(0, 30); }

// ── 使用情况 ──────────────────────────────────────────────────────
function _phoneReadUsage() {
  const b = _phoneBridge();
  if (!b) return null;
  try {
    if (!b.usageGranted()) return null;
    const u = JSON.parse(b.usageToday());
    if (u && u.ok) { _phoneUsage = u; return u; }
  } catch (e) { console.warn('[手机近况] 读使用情况失败', e); }
  return null;
}

function _phoneStay(p) { return Number.isFinite(p.fgMs) ? p.fgMs : p.end - p.start; }

// 回到这里之前在用的那个 App。同一段（包名 + 开始时刻）只说一次。
function _phoneBackLine(u, now) {
  const p = u && u.prev;
  if (!p || !p.end) return '';               // end=0：那个 App 还在前台（分屏之类），不算「刚回来」
  // 待了多久按真在前台的时间（fgMs）算，不按首尾相减：中间熄过屏的那几分钟不算她在用
  const stay = _phoneStay(p), ago = now - p.end;
  if (stay < PHONE_AWAY_MIN_MS || ago < 0 || ago > PHONE_BACK_FRESH_MS) return '';
  const tag = p.pkg + '@' + p.start;
  if (_phone.backTold === tag) return '';
  _phone.backTold = tag;
  return `ta 刚从「${_phoneLabel(p)}」切回来——在那边连着待了约 ${_phoneDur(stay)}，${ago < 90000 ? '刚刚' : _phoneDur(ago) + '前'}才回到这里。`;
}

function _phoneDigestLine(u) {
  const apps = (u && u.apps) || [];
  const others = apps.filter(a => !a.self);
  if (!others.length) return '';
  const top = others.slice(0, 5).map(a => `${_phoneLabel(a)} ${_phoneDur(a.ms)}`).join('、');
  const me = apps.find(a => a.self);
  return `今天到现在手机前台一共用了约 ${_phoneDur(u.totalMs)}，用得最多的是：${top}`
    + (me ? `；在这里（和你聊天）${_phoneDur(me.ms)}` : '') + '。';
}

// ── 位置 ──────────────────────────────────────────────────────────
// 北京市 · 北京市 · 朝阳区 这种直辖市会重复一层，去掉
function _phonePlace(o) {
  const out = [];
  for (const s of [o.province, o.city, o.district]) {
    const t = String(s || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.join(' ');
}

function _phoneLocLine(now) {
  const loc = _phone.loc;
  if (!_phone.locOn || !loc || !loc.place) return '';
  if (now - (loc.at || 0) > PHONE_LOC_MAX_AGE_MS) return '';
  if (loc.place === _phone.locTold && now - (_phone.locToldAt || 0) < PHONE_LOC_TELL_GAP_MS) return '';
  const was = _phone.locTold && _phone.locTold !== loc.place ? _phone.locTold : '';
  _phone.locTold = loc.place;
  _phone.locToldAt = now;
  return `ta 现在大概在${loc.place}${was ? `（换地方了，上次还在${was}）` : ''}——手机粗略定位，只精确到区。`;
}

function phoneLocate(force) {
  _phoneLoad();
  const b = _phoneBridge();
  if (!b || !_phone.locOn || _phoneLocBusy) return false;
  if (!b.locationGranted()) { _phoneLocErr = 'no-permission'; renderPhone(); return false; }
  if (!force && _phone.loc && Date.now() - (_phone.loc.got || 0) < PHONE_LOC_REFRESH_MS) return false;
  const gen = ++_phoneLocGen;
  _phoneLocBusy = true; _phoneLocErr = '';
  renderPhone();
  try { b.locate(); } catch (e) { _phoneLocBusy = false; _phoneLocErr = 'error'; renderPhone(); return false; }
  // Java 那边三家 provider 轮着等；真一个回调都没有（线程死了）也别让「定位中…」永远挂着
  if (typeof setTimeout === 'function') setTimeout(() => {
    if (_phoneLocBusy && gen === _phoneLocGen) { _phoneLocBusy = false; _phoneLocErr = 'no-fix'; renderPhone(); }
  }, PHONE_LOCATE_WAIT_MS);
  return true;
}

// 系统反查不到地名（国内没梯子时 Google 的反查会超时）→ 问电脑 server 的 Nominatim 代理，只给 0.1° 的坐标
async function _phoneReverse(lat1, lon1) {
  if (typeof SERVER_BASE === 'undefined' || !SERVER_BASE) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctrl && typeof setTimeout === 'function' ? setTimeout(() => ctrl.abort(), PHONE_GEO_TIMEOUT) : 0;
  try {
    const r = await fetch(`${SERVER_BASE}/api/geocode-reverse?lat=${lat1}&lon=${lon1}`, ctrl ? { signal: ctrl.signal } : undefined);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch { return null; }
  finally { if (t) clearTimeout(t); }
}

async function _phoneOnLoc(d) {
  _phoneLocBusy = false;
  _phoneLoad();
  if (!_phone.locOn) { renderPhone(); return; }       // 等结果的途中她把开关关了：这次结果作废
  if (!d || !d.ok) { _phoneLocErr = (d && d.why) || 'error'; renderPhone(); return; }
  // 再四舍五入一遍：哪天 Java 那边改松了，这里也不会把细坐标存下来
  const lat1 = Math.round(Number(d.lat1) * 10) / 10, lon1 = Math.round(Number(d.lon1) * 10) / 10;
  let names = {
    province: d.province || '',
    city: d.city || d.subAdmin || '',
    district: d.district || (d.city && d.subAdmin && d.subAdmin !== d.city ? d.subAdmin : ''),
  };
  if (!names.city && !names.district && Number.isFinite(lat1) && Number.isFinite(lon1)) {
    const r = await _phoneReverse(lat1, lon1);
    if (r) names = { province: r.province || '', city: r.city || '', district: r.district || '' };
    _phoneLoad();
    if (!_phone.locOn) { renderPhone(); return; }
  }
  const place = _phonePlace(names);
  _phone.loc = { place, ...names, lat1, lon1, at: Number(d.at) || Date.now(), got: Date.now() };
  _phoneLocErr = place ? '' : 'no-name';
  _phoneSave();
  _phoneWeatherSync(_phone.loc);
  renderPhone();
}

// 定位到了就让气象台跟过去。她刚手动查过别的城市（3 小时内）就不抢——那多半是在看老家 / 要去的地方。
function _phoneWeatherSync(loc) {
  if (typeof _weatherLoad !== 'function' || typeof _weatherFetch !== 'function') return false;
  if (!loc || !Number.isFinite(loc.lat1) || !Number.isFinite(loc.lon1)) return false;
  _weatherLoad();
  const w = _weather;
  const label = loc.place || '手机定位附近';
  if (w && !w.auto && Number.isFinite(w.latitude) && Date.now() - (w.pickedAt || w.ts || 0) < PHONE_WEATHER_YIELD_MS) return false;
  // 还是同一格、同一个名字：气象台自己每 15 分钟会刷，这里不用再拉
  if (w && w.auto && Math.abs(w.latitude - loc.lat1) < 0.05 && Math.abs(w.longitude - loc.lon1) < 0.05 && w.place === label) return false;
  _weatherFetch({
    latitude: loc.lat1, longitude: loc.lon1,
    name: loc.city || loc.district || '当前位置', full: label,
    query: loc.city || loc.district || '', src: '手机定位', auto: true,
  }, { silent: true });
  return true;
}

// Java → 页面的回调口（PhoneBridge.emit）
function _phoneNative(kind, d) {
  if (kind === 'perm') {
    _phoneLoad();
    if (d) phoneLocate(true);
    else {
      _phone.locOn = false; _phoneSave();
      showToast('没拿到定位权限，位置这项先关着', 'info', 4000);
    }
    renderPhone();
  } else if (kind === 'loc') {
    _phoneOnLoc(d);
  }
}

// ── 喂给 AI：buildSystemPrompt 调它，只进 volatile，读一次就清 ─────────
function takePhoneMoment() {
  _phoneLoad();
  if (!_phone.usageOn && !_phone.locOn) return '';
  const now = Date.now(), bits = [];
  if (_phone.usageOn) {
    const u = _phoneReadUsage();
    if (u) {
      const back = _phoneBackLine(u, now);
      if (back) bits.push(back);
      if (now - (_phone.digestAt || 0) >= PHONE_DIGEST_GAP_MS) {
        const dg = _phoneDigestLine(u);
        if (dg) { bits.push(dg); _phone.digestAt = now; }
      }
    }
  }
  const l = _phoneLocLine(now);
  if (l) bits.push(l);
  if (!bits.length) return '';
  _phoneSave();
  return `\n\n[ta 的手机近况 · 系统从 ta 手机上读到的；开关是 ta 自己打开的，ta 知道你看得见]\n${bits.join('\n')}
这是让你更懂 ta 此刻状态的背景，不是要你汇报。想接就自然地带一句——关心、调侃、顺着聊都行；没什么好说的就当没看见。别念数字清单，别对 ta 玩了多久手机说教，同一件事别反复提。`;
}

// ── 开关 ──────────────────────────────────────────────────────────
function phoneToggleUsage() {
  const b = _phoneBridge();
  _phoneLoad();
  if (!b) { showToast('这项只有安卓 App 里能开（电脑上读不到手机）', 'info', 3500); return; }
  _phone.usageOn = !_phone.usageOn;
  if (!_phone.usageOn) { _phone.digestAt = 0; _phone.backTold = ''; _phoneUsage = null; }
  _phoneSave();
  if (_phone.usageOn && !b.usageGranted()) {
    showToast('在系统设置里找到 Grancyan，打开「允许访问使用情况」，再回来', 'info', 6000);
    b.openUsageSettings();
  } else if (_phone.usageOn) {
    _phoneReadUsage();
  }
  renderPhone();
}

function phoneToggleLoc() {
  const b = _phoneBridge();
  _phoneLoad();
  if (!b) { showToast('这项只有安卓 App 里能开（电脑上读不到手机）', 'info', 3500); return; }
  _phone.locOn = !_phone.locOn;
  _phoneLocErr = '';
  if (!_phone.locOn) {
    // 关了就把位置忘掉，不留在本机
    _phone.loc = null; _phone.locTold = ''; _phone.locToldAt = 0;
    _phoneLocGen++; _phoneLocBusy = false;
    // 气象台那份不再算「所在地」了：留着城市，但不再跟着定位走、也不再对 AI 说是她所在地
    if (typeof _weatherLoad === 'function' && typeof _weatherSave === 'function') {
      _weatherLoad();
      if (_weather && _weather.auto) { _weather.auto = false; _weatherSave(); }
    }
  }
  _phoneSave();
  if (_phone.locOn) {
    if (b.locationGranted()) phoneLocate(true);
    else b.requestLocation();
  }
  renderPhone();
}

function phoneAskLocAgain() {
  const b = _phoneBridge();
  if (!b) return;
  // 被拒过两次之后系统不再弹框，requestLocation 会静默返回拒绝；那时只能去应用详情页自己开
  if (_phoneLocErr === 'no-permission') b.openAppSettings();
  else b.requestLocation();
}

// ── 面板 ──────────────────────────────────────────────────────────
function openPhone() {
  _phoneLoad();
  document.getElementById('phoneModal')?.classList.remove('hidden');
  if (_phone.usageOn) _phoneReadUsage();
  renderPhone();
  if (_phone.locOn) phoneLocate(false);
}
function closePhone() { document.getElementById('phoneModal')?.classList.add('hidden'); }

function _phoneAgo(ts) {
  const m = Math.round((Date.now() - (ts || 0)) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}

const PHONE_LOC_ERR = {
  'no-permission': '没有定位权限。',
  'service-off': '手机的「位置信息」总开关关着，下拉栏里打开就好。',
  'no-fix': '暂时拿不到位置（室内、刚开机、没网时常见），过一会儿会自己再试。',
  'no-name': '拿到了大概位置，但反查不出地名（没梯子、也没连着电脑时会这样）。天气照样跟着走。',
  'error': '定位出错了，过一会儿再试。',
};

function renderPhone() {
  const body = typeof document !== 'undefined' ? document.getElementById('phoneBody') : null;
  if (!body) return;
  _phoneLoad();
  const b = _phoneBridge();
  const sw = (on, fn) => `<button type="button" class="ph-switch${on ? ' on' : ''}" aria-pressed="${on}" onclick="${fn}()"><i></i></button>`;

  let usage = '';
  if (_phone.usageOn && b) {
    if (!b.usageGranted()) {
      usage = `<div class="ph-warn">还差一步：系统设置 → 使用情况访问 → Grancyan → 允许。<button class="ph-btn" onclick="GrancyanPhone.openUsageSettings()">去打开</button></div>`;
    } else {
      const u = _phoneUsage;
      const apps = (u && u.apps) || [];
      const max = apps.reduce((m, a) => Math.max(m, a.ms), 1);
      const prev = u && u.prev && u.prev.end
        ? `<div class="ph-prev">回来之前在用 <b>${escHtml(_phoneLabel(u.prev))}</b> · 待了 ${_phoneDur(_phoneStay(u.prev))} · ${_phoneAgo(u.prev.end)}离开</div>` : '';
      usage = apps.length
        ? `${prev}<div class="ph-total">今天前台一共 <b>${_phoneDur(u.totalMs)}</b></div><ol class="ph-apps">${apps.slice(0, 10).map(a =>
            `<li class="${a.self ? 'self' : ''}"><span class="ph-app">${escHtml(_phoneLabel(a))}</span><span class="ph-bar"><i style="width:${Math.max(3, Math.round(a.ms / max * 100))}%"></i></span><span class="ph-dur">${_phoneDur(a.ms)}</span></li>`).join('')}</ol>`
        : `<div class="ph-note">今天还没有用满一分钟的 App。</div>`;
    }
  }

  let loc = '';
  if (_phone.locOn && b) {
    const L = _phone.loc;
    const err = _phoneLocErr && PHONE_LOC_ERR[_phoneLocErr];
    loc = (L && L.place ? `<div class="ph-place"><b>${escHtml(L.place)}</b><small>${_phoneAgo(L.at)}定位</small></div>` : '')
      + (_phoneLocBusy ? `<div class="ph-note">正在定位…（室内只能等 GPS，最多一分多钟）</div>` : '')
      + (err ? `<div class="ph-warn">${err}${_phoneLocErr === 'no-permission' ? '<button class="ph-btn" onclick="phoneAskLocAgain()">去开权限</button>' : ''}</div>` : '')
      + `<button class="ph-btn ghost" onclick="phoneLocate(true)" ${_phoneLocBusy ? 'disabled' : ''}>🔄 重新定位</button>`;
  }

  body.innerHTML = `<div class="ph-room">
    ${b ? '' : `<div class="ph-warn">这里要在<b>手机上的 Grancyan App</b> 里打开——电脑上读不到手机。</div>`}
    <section class="ph-card">
      <header><div><h4>今天在用什么</h4><p>各 App 用了多久、回来之前在刷什么</p></div>${sw(_phone.usageOn, 'phoneToggleUsage')}</header>
      ${usage}
    </section>
    <section class="ph-card">
      <header><div><h4>大概在哪</h4><p>只到城市 / 区；天气会自动换成这里</p></div>${sw(_phone.locOn, 'phoneToggleLoc')}</header>
      ${loc}
    </section>
    <div class="ph-foot">它怎么看到这些：只在有新鲜事时随你的下一条消息带过去一次——刚从别的 App 回来、每两小时一份今天的时长、换了地方。没有新东西就什么都不加。
    精确坐标不出手机系统那层，提示词里只有城市和区，查天气只给到 0.1°（约 11 公里）。这些只存在这台手机里，不上云。</div>
  </div>`;
}

// ── 后台节奏：页面开着、在前台时每 5 分钟看一眼位置要不要刷新 ─────────
function phoneTick() {
  _phoneLoad();
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (_phone.locOn) phoneLocate(false);
}
// 测试在 vm 沙箱里跑，那里可能没有 setInterval / document.addEventListener（同 36-weather）
if (typeof setInterval === 'function') setInterval(() => { try { phoneTick(); } catch (e) { console.warn('[手机近况]', e); } }, PHONE_TICK_MS);
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try {
      phoneTick();
      // 从系统设置授完「使用情况访问」回来：面板开着就当场刷新，不用她再点一次
      const m = document.getElementById('phoneModal');
      if (m && !m.classList.contains('hidden')) { _phoneLoad(); if (_phone.usageOn) _phoneReadUsage(); renderPhone(); }
    } catch (e) { console.warn('[手机近况]', e); }
  });
}
if (typeof setTimeout === 'function') setTimeout(() => { try { phoneTick(); } catch (e) { console.warn('[手机近况]', e); } }, 4000);
