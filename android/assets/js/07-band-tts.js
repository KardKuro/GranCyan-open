function hauntOff() {
  document.body.classList.remove('haunted');
  document.getElementById('hauntOverlay')?.remove();
  document.getElementById('hauntEscape')?.remove();
  applyAccentCSS(state.accentColor);
}

// ── 用户名 ──
// 侧栏底部优先显示用户名，没设置就退回邮箱/登录状态
function renderUserName() {
  const el = document.getElementById('footerUserName');
  if (!el) return;
  el.textContent = state.userName || (typeof currentUser !== 'undefined' && currentUser ? (currentUser.email || '已登录') : '未登录');
}

// ── 用户头像 ──
function uploadUserAvatar(input) {
  const file = input.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      state.userAvatar = c.toDataURL('image/jpeg', 0.85);
      save(); renderUserAvatar(); renderMessages();
      showToast('✓ 头像已更新', 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function renderUserAvatar() {
  for (const id of ['footerAvatar', 'acctAvatarPreview']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = state.userAvatar ? `<img src="${state.userAvatar}" alt="me">` : '🐱';
  }
}

// ═══════════════════════════════════════════════════════
// 手环数据面板 (Band Data Panel)
// ═══════════════════════════════════════════════════════
function openBandPanel() {
  document.getElementById('bandModal').classList.remove('hidden');
  const t = document.getElementById('bandAiToggle');
  if (t) t.checked = state.bandAiEnabled !== false;
  const ta = document.getElementById('bandAutoToggle');
  if (ta) ta.checked = state.bandAutoFetch === true;
  renderBandPanel();
}
function closeBandPanel() {
  document.getElementById('bandModal').classList.add('hidden');
  const tip = document.getElementById('bandTip');
  if (tip) tip.style.display = 'none';
}

// ── 手环本地桥（App 内，见 android/src/.../BandBridge.java）────────────────
// 有这个桥就不用连电脑了：广播、读库、解析全在手机上做。
// 旧版 App 或浏览器里 GrancyanBand 不存在，自动回落到电脑的 /api/band-data。
function bandBridge() {
  try {
    return (typeof GrancyanBand !== 'undefined' && GrancyanBand.available()) ? GrancyanBand : null;
  } catch (e) { return null; }
}
const _bandCbs = {};
// Java 侧读完（十几秒）回调这里，按 cbId 找回对应的 Promise
window._bandBridgeResult = function (cbId, data) {
  const fn = _bandCbs[cbId];
  if (fn) { delete _bandCbs[cbId]; fn(data); }
};
function bandBridgeFetch(force) {
  const bridge = bandBridge();
  if (!bridge) return Promise.resolve(null);
  return new Promise(resolve => {
    const cbId = 'bb' + Date.now() + Math.random().toString(36).slice(2, 6);
    // 等导出最多 12 秒，加上读库和余量给 40 秒；超时当作桥不可用去走电脑那条路
    const timer = setTimeout(() => { delete _bandCbs[cbId]; resolve(null); }, 40000);
    _bandCbs[cbId] = d => { clearTimeout(timer); resolve(d); };
    try { bridge.fetch(cbId, !!force); }
    catch (e) { clearTimeout(timer); delete _bandCbs[cbId]; resolve(null); }
  });
}
function bandBridgeStatus() {
  const bridge = bandBridge();
  if (!bridge) return null;
  try { return JSON.parse(bridge.status()); } catch (e) { return null; }
}
function bandRequestAccess() {
  const bridge = bandBridge();
  if (!bridge) return;
  bridge.requestAccess();
  showToast('在系统设置里把「所有文件访问权限」打开，然后回来点刷新', 'info', 6000);
}

async function refreshBandData(force) {
  const btn = document.getElementById('bandRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 同步中…'; }
  try {
    // 1) 先试手机本地（不用电脑、出门在外也能用）
    const local = await bandBridgeFetch(force);
    if (local && local.ok) {
      state.bandData = local;
      renderBandPanel();
      showToast('✓ 手环数据已刷新（手机本地）', 'success');
      if (btn) { btn.disabled = false; btn.textContent = '↻ 刷新'; }
      return;
    }
    // 2) 本地拿不到 → 回落到电脑的 server.js
    const r = await fetch(SERVER_BASE + '/api/band-data' + (force ? '?force=1' : ''));
    state.bandData = await r.json();
    // 电脑那边也没有的话，把本地失败的原因带上（多半是没给权限），比笼统的"不可用"有用
    if (!state.bandData?.ok && local && local.msg) state.bandData = local;
    renderBandPanel();
    showToast(state.bandData?.ok ? '✓ 手环数据已刷新' : '手环数据不可用', state.bandData?.ok ? 'success' : 'error');
  } catch {
    // 电脑连不上时，本地的失败原因比"连不上 server.js"更贴近真相
    const local = await bandBridgeFetch(false);
    if (local && local.ok) { state.bandData = local; renderBandPanel(); showToast('✓ 手环数据已刷新（手机本地）', 'success'); }
    else if (local) { state.bandData = local; renderBandPanel(); showToast(local.msg || '手环数据不可用', 'error', 4000); }
    else showToast('连不上 server.js，检查后端服务器地址', 'error', 3000);
  }
  if (btn) { btn.disabled = false; btn.textContent = '↻ 刷新'; }
}

// 手环睡眠按「哪一晚」归堆（用户：AI 只看得到最近一次睡眠，下午补个觉就把昨晚盖掉了）。
// 入睡在 12:00~19:59 的算白天小睡；其余按「入睡时刻往前推 12 小时」落在哪天归到那一晚，
// 所以凌晨四点睡、早上十点又补一段，都算前一天那晚。
function bandSleepSessions(bd) {
  // 旧 server（exe 快照 / 手机连的老版本）没有 sleepRecent，拿最近一条 + sleep7 凑
  const src = Array.isArray(bd?.sleepRecent) ? bd.sleepRecent : [...(bd?.sleepSummary || []), ...(bd?.sleep7 || [])];
  const seen = new Set(), out = [];
  for (const r of src) {
    const ts = +r?.TIMESTAMP;
    if (!Number.isFinite(ts) || seen.has(ts)) continue;
    seen.add(ts);
    const h = new Date(ts).getHours(), k = new Date(ts - 12 * 3600000);
    out.push({ ...r, nap: h >= 12 && h < 20, night: `${k.getFullYear()}-${k.getMonth() + 1}-${k.getDate()}` });
  }
  return out.sort((a, b) => b.TIMESTAMP - a.TIMESTAMP);
}
// 夜里的几段合成一晚，新的在前；total 是这一晚几段加起来
function bandSleepNights(sessions) {
  const m = new Map();
  for (const s of sessions) {
    if (s.nap) continue;
    if (!m.has(s.night)) m.set(s.night, { night: s.night, segs: [], total: 0 });
    const g = m.get(s.night);
    g.segs.push(s);
    g.total += +s.TOTAL_DURATION || 0;
  }
  return [...m.values()];
}
// 给 AI 看的睡眠段：最近几晚每段一行 + 平均作息。只用单换行 —— server 的 _VOLATILE_SYS 剥手环段剥到 \n\n 为止
function bandSleepPromptText(bd, who, maxNights = 7) {
  const ss = bandSleepSessions(bd);
  if (!ss.length) return '';
  const nights = bandSleepNights(ss).slice(0, maxNights);
  const from = nights.length ? Math.min(...nights[nights.length - 1].segs.map(s => +s.TIMESTAMP)) : ss[0].TIMESTAMP;
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(+ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const md = ts => { const d = new Date(+ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const dur = min => `${Math.floor(min / 60)}h${min % 60}m`;
  let txt = `\n${who}最近的睡眠（新的在前。凌晨睡下、早上又补一段的都算前一晚；标了「白天小睡」的是白天补觉，别当成昨晚）:`;
  for (const s of ss) {
    if (s.TIMESTAMP < from) break;
    const staged = [s.DEEP_SLEEP_DURATION, s.LIGHT_SLEEP_DURATION, s.REM_SLEEP_DURATION].some(v => +v > 0);
    txt += `\n- ${md(s.TIMESTAMP)} ${hm(s.TIMESTAMP)}入睡→${hm(s.WAKEUP_TIME)}醒来, ${dur(+s.TOTAL_DURATION || 0)}${s.nap ? ' [白天小睡]' : ''}`
      + (staged ? ` (深睡${s.DEEP_SLEEP_DURATION}m/浅睡${s.LIGHT_SLEEP_DURATION}m/REM${s.REM_SLEEP_DURATION}m/清醒${s.AWAKE_DURATION || 0}m)` : '');
  }
  if (nights.length >= 2) {
    // 入睡时刻跨午夜，按「中午 12 点起算的分钟数」平均，不然 23:30 和 01:30 会平均成中午
    const ofDay = ts => { const d = new Date(+ts); return d.getHours() * 60 + d.getMinutes(); };
    const avgClock = (vals, shift) => {
      const v = Math.round(vals.reduce((a, x) => a + (x - shift + 1440) % 1440, 0) / vals.length);
      const t = (v + shift) % 1440;
      return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    };
    const avgTotal = Math.round(nights.reduce((a, n) => a + n.total, 0) / nights.length);
    const beds = nights.map(n => ofDay(Math.min(...n.segs.map(s => +s.TIMESTAMP))));
    const wakes = nights.map(n => ofDay(Math.max(...n.segs.map(s => +s.WAKEUP_TIME))));
    txt += `\n近${nights.length}晚平均: 每晚睡${dur(avgTotal)}, 一般${avgClock(beds, 720)}左右睡下、${avgClock(wakes, 0)}左右起`;
  }
  return txt;
}

// 10-14 用户发了张深色数据面板说「我喜欢这个」，要做在手环上、底色死黑：
// 卡片是黑底上一层淡玻璃，数字和图只用白（深浅分档），不跟主题强调色走 —— 这块不管换什么主题都是这个样子。
// 涨跌小药丸只说方向和差值，不判好坏（步数涨是好事，静息心率涨不是），所以也一律白
const BAND_IC = {
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
};
const _bandIc = k => `<span class="band-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${BAND_IC[k]}</svg></span>`;
const _bandNum = n => (n == null || n === '' || !Number.isFinite(+n)) ? '–' : Math.round(+n).toLocaleString('en-US');
function _bandDelta(cur, prev, unit = '') {
  if (cur == null || prev == null || !Number.isFinite(+cur) || !Number.isFinite(+prev)) return '';
  const dv = Math.round(+cur - +prev);
  return `<span class="band-pill" title="跟前一天比">${dv > 0 ? '↗ +' : dv < 0 ? '↘ ' : '→ '}${dv}${unit}</span>`;
}
// 白的几档深浅：图表、图例、睡眠分段共用
const BAND_INK = { line: 'rgba(255,255,255,.92)', dim: 'rgba(255,255,255,.42)', muted: 'rgba(255,255,255,.38)', grid: 'rgba(255,255,255,.05)',
  deep: 'rgba(255,255,255,.95)', light: 'rgba(255,255,255,.58)', rem: 'rgba(255,255,255,.3)', awake: 'rgba(255,255,255,.12)' };

function renderBandPanel() {
  const box = document.getElementById('bandBody');
  if (!box) return;
  const bd = state.bandData;
  if (!bd?.ok) {
    // App 里有本地桥的话，主推手机自己读这条路（不用电脑），并按缺什么给对应的按钮
    const st = bandBridgeStatus();
    let how, extraBtn = '';
    if (!st) {
      how = '需要：电脑端设好 GRANCYAN_BAND_DB_REMOTE 并运行 server.js ＋ 手机 ADB 已连接 ＋ Gadgetbridge 在后台运行';
    } else if (!st.gbInstalled) {
      how = '这台手机上没找到 Gadgetbridge，先装上并连好手环';
    } else if (!st.hasAccess) {
      how = '手机可以自己读手环数据，但需要「所有文件访问权限」才能看到 Gadgetbridge 的导出文件';
      extraBtn = `<button class="apply-btn" style="margin-top:10px" onclick="bandRequestAccess()">去开权限</button> `;
    } else if (!st.exists) {
      how = `没找到导出文件<br><span style="font-size:11px">${escHtml(st.path)}</span><br>`
          + '在 Gadgetbridge → 设置 → 自动导出 里，把导出目录设成「手环数据」文件夹';
    } else {
      how = '导出文件在，但读不出内容 —— 在 Gadgetbridge → 设置 → 开发者选项 → 意图接口，'
          + '把「活动同步触发器」和「数据库导出」打开';
    }
    box.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px 10px;line-height:2">
      ⌚ 暂无手环数据<br>${how}<br>
      ${bd?.msg ? `<span style="font-size:11px;opacity:.8">${escHtml(bd.msg)}</span><br>` : ''}
      ${/* server 现在会说清楚卡在哪一步（没连手机 / 没授权 / GB 没跑 / 意图开关没开…），
            hint 就是「该去动什么」。以前这里只有一句笼统的「请确认手机已通过USB连接」。 */''}
      ${bd?.hint ? `<span style="font-size:11px;opacity:.7">👉 ${escHtml(bd.hint)}</span><br>` : ''}
      ${extraBtn}<button class="apply-btn" style="margin-top:10px" onclick="refreshBandData(true)">↻ 重试同步</button></div>`;
    return;
  }
  const d = bd.daily?.[0], hr = bd.latestHR?.[0];
  const fresh = bd.ageMins == null ? '' : bd.ageMins > 240 ? `⚠ 数据是 ${Math.round(bd.ageMins / 60)} 小时前的` : `${bd.ageMins} 分钟前更新`;
  // 「昨晚」取最近一晚几段的合计，白天小睡不算（以前直接拿最近一条，下午睡一觉就顶掉了昨晚）
  const lastNight = bandSleepNights(bandSleepSessions(bd))[0];
  const slText = lastNight ? `${Math.floor(lastNight.total / 60)}<small>h</small>${lastNight.total % 60}<small>m</small>` : '–';
  // 有数据 ≠ 一切正常：手机拔了就吃缓存，导出没触发就一直是旧文件。
  // 这两种以前都悄悄显示成正常数字，等她发现步数不对已经过了好几天。
  const trouble = bd.stale || bd.warn;
  // 「前一天」按时间戳找，不按下标：daily7[0] 不一定就是 daily[0] 那天
  const week = bd.daily7 || [];
  const prev = d ? week.find(r => +r.TIMESTAMP < +d.TIMESTAMP) : null;
  const hrS = bd.hrSeries || [], stS = bd.stressSeries || [];
  const hrLo = hrS.length > 1 ? Math.min(...hrS.map(p => p.HEART_RATE)) : null, hrHi = hrS.length > 1 ? Math.max(...hrS.map(p => p.HEART_RATE)) : null;
  // 下面那条细条 = 今天在近 7 天里有多高（压力、血氧本来就是百分制，按 100 算）
  const wmax = k => Math.max(1, ...week.map(r => +r[k] || 0));
  const row = (ic, label, val, unit, pill, frac) => `<div class="band-row">${_bandIc(ic)}<div class="band-row-main">
      <div class="band-row-top"><span class="band-row-label">${label}</span><span class="band-row-val">${val}${unit && val !== '–' ? `<small>${unit}</small>` : ''}${pill}</span></div>
      <div class="band-meter"><i style="width:${Math.round(Math.max(0, Math.min(1, +frac || 0)) * 100)}%"></i></div></div></div>`;
  // 步数、卡路里是一天里攒的，早上跟昨天整天比永远是「跌」—— 这两样只把昨天的数摆出来
  const yday = (k, unit = '') => prev && prev[k] != null ? `<span class="band-pill" title="前一天">昨天 ${_bandNum(prev[k])}${unit}</span>` : '';
  box.innerHTML = `
    <div class="band-fresh">${fresh}</div>
    ${trouble ? `<div class="band-trouble">⚠ ${escHtml(trouble.msg)}
      <span>👉 ${escHtml(trouble.hint)}</span></div>` : ''}
    <div class="band-grid">
      <div class="band-card">
        <div class="band-card-title">最近心率</div>
        <div class="band-num">${hr?.HEART_RATE ?? '–'}<small>bpm</small></div>
        ${hrS.length > 1 ? `<span class="band-pill">24h ${hrLo}–${hrHi}</span><canvas id="bandHrChart"></canvas>` : ''}
      </div>
      <div class="band-card">
        <div class="band-card-title">今日步数</div>
        <div class="band-num">${_bandNum(d?.STEPS)}</div>
        ${yday('STEPS')}
        ${week.length > 1 ? '<canvas id="bandStepsChart"></canvas>' : ''}
      </div>
      <div class="band-card">
        <div class="band-card-title">压力</div>
        <div class="band-num">${d?.STRESS_AVG ?? '–'}<small>均值</small></div>
        ${stS.length > 1 ? `<span class="band-pill">24h 峰值 ${Math.max(...stS.map(p => p.STRESS))}</span><canvas id="bandStressChart"></canvas>` : ''}
      </div>
      <div class="band-card">
        <div class="band-card-title">今天的身体</div>
        <div class="band-card-sub">细条：跟近 7 天最高的那天比</div>
        <div class="band-num band-num-xl">${slText}</div>
        <div class="band-num-label">昨晚睡眠${lastNight && lastNight.segs.length > 1 ? `（${lastNight.segs.length} 段）` : ''}</div>
        ${row('heart', '静息心率', d?.HR_RESTING ?? '–', 'bpm', _bandDelta(d?.HR_RESTING, prev?.HR_RESTING), (+d?.HR_RESTING || 0) / wmax('HR_RESTING'))}
        ${row('pulse', '压力均值', d?.STRESS_AVG ?? '–', '', _bandDelta(d?.STRESS_AVG, prev?.STRESS_AVG), (+d?.STRESS_AVG || 0) / 100)}
        ${row('flame', '卡路里', _bandNum(d?.CALORIES), 'kcal', yday('CALORIES'), (+d?.CALORIES || 0) / wmax('CALORIES'))}
        ${+d?.SPO2_AVG > 0 ? row('drop', '血氧', d.SPO2_AVG, '%', _bandDelta(d.SPO2_AVG, prev?.SPO2_AVG), +d.SPO2_AVG / 100) : ''}
      </div>
      ${bd.sleep7?.length ? `<div class="band-card band-wide">
        <div class="band-card-title">睡眠构成<span class="band-card-sub">近 ${bd.sleep7.length} 晚</span></div>
        <canvas id="bandSleepChart"></canvas>
        <div class="band-legend">
          <span><i style="background:${BAND_INK.deep}"></i>深睡</span><span><i style="background:${BAND_INK.light}"></i>浅睡</span>
          <span><i style="background:${BAND_INK.rem}"></i>REM</span><span><i style="background:${BAND_INK.awake}"></i>清醒</span>
        </div></div>` : ''}
    </div>`;
  // 图按画布当下的像素宽度画。搬进小组件那一帧面板还没宽度（画出来是空的），窗口变宽变窄也会拉伸 ——
  // 所以盯着 bandBody 的宽度，变了就重画（盯一次就够，换的只是重画哪份数据）
  box._bandRedraw = () => {
    if (bd.hrSeries?.length > 1) drawBandLine('bandHrChart', bd.hrSeries.map(p => ({ t: p.TIMESTAMP * 1000, v: p.HEART_RATE })), 'bpm');
    if (bd.stressSeries?.length > 1) drawBandLine('bandStressChart', bd.stressSeries.map(p => ({ t: p.TIMESTAMP * 1000, v: p.STRESS })), '');
    if (bd.daily7?.length > 1) drawBandBars('bandStepsChart', [...bd.daily7].reverse().map(r => ({ label: new Date(r.TIMESTAMP).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }), v: r.STEPS || 0 })));
    if (bd.sleep7?.length) drawBandSleep('bandSleepChart', [...bd.sleep7].reverse());
  };
  requestAnimationFrame(box._bandRedraw);
  if (!box._bandRO && typeof ResizeObserver === 'function') {
    let lastW = -1;
    box._bandRO = new ResizeObserver(() => { if (box.clientWidth !== lastW) { lastW = box.clientWidth; box._bandRedraw?.(); } });
    box._bandRO.observe(box);
  }
}

function _bandCanvas(id) {
  const cv = document.getElementById(id);
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;   // 还没排版（藏着 / 刚搬进小组件）：等 ResizeObserver 有了宽度再画，零宽画胶囊会因为负半径抛错
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  return { cv, ctx, w, h };
}
function _bandTip() {
  let tip = document.getElementById('bandTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'bandTip';
    tip.style.cssText = 'position:fixed;z-index:99;pointer-events:none;display:none;background:rgba(0,0,0,.94);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:5px 11px;font:500 11px \'Inter\',\'Segoe UI\',system-ui,sans-serif;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.5)';
    document.body.appendChild(tip);
  }
  return tip;
}

// 折线图：白线 + 往下渐隐的白面积 + 悬停十字线。
// 原始点一天上千个，直接连是一把锯齿；按 96 格（24h 里一格 15 分钟）取平均，再跟左右两格揉一下，连成平滑曲线。
// 悬停也读这条揉过的线（点落在曲线上，不会浮在线外面）；真正的最高 / 最低写在卡片上的药丸里
function drawBandLine(id, pts, unit) {
  const c = _bandCanvas(id); if (!c || !pts.length) return;
  const { cv, ctx, w, h } = c;
  const padL = 2, padR = 2, padT = 10, padB = 16;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const N = 96, buckets = [];
  pts.forEach(p => { const k = Math.min(N - 1, Math.floor((p.t - t0) / ((t1 - t0) || 1) * N)); (buckets[k] = buckets[k] || []).push(p); });
  const avg = buckets.filter(Boolean).map(b => ({ t: b.reduce((a, p) => a + p.t, 0) / b.length, v: b.reduce((a, p) => a + p.v, 0) / b.length }));
  const sm = avg.map((p, i) => { const nb = avg.slice(Math.max(0, i - 1), i + 2); return { t: p.t, v: nb.reduce((a, q) => a + q.v, 0) / nb.length }; });
  const vmin = Math.min(...sm.map(p => p.v)), vmax = Math.max(...sm.map(p => p.v));
  const lo = Math.max(0, vmin - (vmax - vmin) * 0.3 - 1), hi = vmax + (vmax - vmin) * 0.12 + 1;
  const X = t => padL + (t - t0) / (t1 - t0 || 1) * (w - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const trace = () => {
    ctx.beginPath(); ctx.moveTo(X(sm[0].t), Y(sm[0].v));
    for (let i = 1; i < sm.length; i++) {
      const x0 = X(sm[i - 1].t), y0 = Y(sm[i - 1].v), x1 = X(sm[i].t), y1 = Y(sm[i].v);
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    ctx.lineTo(X(sm[sm.length - 1].t), Y(sm[sm.length - 1].v));
  };
  const fmtT = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const draw = (hoverI) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = BAND_INK.grid; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { const y = padT + (h - padT - padB) * i / 2; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); }
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = BAND_INK.muted; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText(fmtT(t0), padL, h - 12);
    ctx.textAlign = 'right'; ctx.fillText(fmtT(t1), w - padR, h - 12);
    trace();
    ctx.lineTo(X(sm[sm.length - 1].t), h - padB); ctx.lineTo(X(sm[0].t), h - padB); ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, h - padB);
    g.addColorStop(0, 'rgba(255,255,255,.26)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fill();
    trace();
    ctx.strokeStyle = BAND_INK.line; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    if (hoverI != null) {
      const p = sm[hoverI], x = X(p.t), y = Y(p.v);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
    }
  };
  draw(null);
  const tip = _bandTip();
  cv.onmousemove = e => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0, bestD = 1e9;
    sm.forEach((p, i) => { const dd = Math.abs(X(p.t) - mx); if (dd < bestD) { bestD = dd; best = i; } });
    draw(best);
    const p = sm[best];
    tip.textContent = `${fmtT(p.t)} · ${Math.round(p.v)}${unit}`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 28) + 'px';
  };
  cv.onmouseleave = () => { draw(null); tip.style.display = 'none'; };
}

// 步数柱：细胶囊，今天那根纯白、前几天半透明；最高那天头顶标数
function drawBandBars(id, bars) {
  const c = _bandCanvas(id); if (!c || !bars.length) return;
  const { cv, ctx, w, h } = c;
  const padT = 16, padB = 16, padL = 4, padR = 4;
  const vmax = Math.max(...bars.map(b => b.v), 1);
  const bw = (w - padL - padR) / bars.length;
  const wd = Math.min(14, bw * 0.42);
  const maxI = bars.findIndex(b => b.v === vmax);
  ctx.font = '10px system-ui, sans-serif';
  bars.forEach((b, i) => {
    const bh = Math.max(4, (b.v / vmax) * (h - padT - padB));
    const x = padL + i * bw + (bw - wd) / 2, y = h - padB - bh;
    ctx.fillStyle = i === bars.length - 1 ? BAND_INK.line : BAND_INK.dim;
    ctx.beginPath();
    ctx.roundRect(x, y, wd, bh, Math.min(wd / 2, bh / 2));
    ctx.fill();
    ctx.fillStyle = BAND_INK.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(b.label, x + wd / 2, h - 12);
    if (i === maxI) { ctx.textBaseline = 'bottom'; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(_bandNum(b.v), x + wd / 2, y - 3); }
  });
  const tip = _bandTip();
  cv.onmousemove = e => {
    const rect = cv.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - padL) / bw);
    if (i < 0 || i >= bars.length) { tip.style.display = 'none'; return; }
    tip.textContent = `${bars[i].label} · ${bars[i].v} 步`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 28) + 'px';
  };
  cv.onmouseleave = () => { tip.style.display = 'none'; };
}

// 睡眠堆叠胶囊：深睡→浅睡→REM→清醒是白的四档深浅，从下往上叠；整根裁成胶囊，段间 2px 透出黑底
function drawBandSleep(id, rows) {
  const c = _bandCanvas(id); if (!c || !rows.length) return;
  const { cv, ctx, w, h } = c;
  const padT = 16, padB = 16, padL = 4, padR = 4;
  const total = r => (r.DEEP_SLEEP_DURATION || 0) + (r.LIGHT_SLEEP_DURATION || 0) + (r.REM_SLEEP_DURATION || 0) + (r.AWAKE_DURATION || 0);
  const vmax = Math.max(...rows.map(total), 1);
  const bw = (w - padL - padR) / rows.length;
  const wd = Math.min(16, bw * 0.42);
  const segs = r => [
    [r.DEEP_SLEEP_DURATION || 0, BAND_INK.deep],
    [r.LIGHT_SLEEP_DURATION || 0, BAND_INK.light],
    [r.REM_SLEEP_DURATION || 0, BAND_INK.rem],
    [r.AWAKE_DURATION || 0, BAND_INK.awake],
  ];
  ctx.font = '10px system-ui, sans-serif';
  rows.forEach((r, i) => {
    const x = padL + i * bw + (bw - wd) / 2;
    const th = (total(r) / vmax) * (h - padT - padB);
    let y = h - padB;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y - th, wd, th, Math.min(wd / 2, th / 2)); ctx.clip();
    segs(r).forEach(([mins, color]) => {
      if (!mins) return;
      const sh = (mins / vmax) * (h - padT - padB);
      y -= sh;
      ctx.fillStyle = color;
      ctx.fillRect(x, y + 1, wd, Math.max(0.5, sh - 2));
    });
    ctx.restore();
    const tt = total(r);
    ctx.fillStyle = BAND_INK.muted; ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.floor(tt / 60)}h${tt % 60 ? (tt % 60) + 'm' : ''}`, x + wd / 2, y - 2);
    ctx.textBaseline = 'top';
    ctx.fillText(new Date(r.TIMESTAMP).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }), x + wd / 2, h - 12);
  });
  const tip = _bandTip();
  cv.onmousemove = e => {
    const rect = cv.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - padL) / bw);
    if (i < 0 || i >= rows.length) { tip.style.display = 'none'; return; }
    const r = rows[i];
    tip.textContent = `深${r.DEEP_SLEEP_DURATION || 0}m · 浅${r.LIGHT_SLEEP_DURATION || 0}m · REM ${r.REM_SLEEP_DURATION || 0}m · 醒${r.AWAKE_DURATION || 0}m`;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 240) + 'px'; tip.style.top = (e.clientY - 28) + 'px';
  };
  cv.onmouseleave = () => { tip.style.display = 'none'; };
}

// ── 文字转语音 ──
// 优先走 server.js 的 Edge 神经语音代理（/api/tts，微软神经语音，非常有人味），
// server 不在 / 超时 / 报错时回退到浏览器 speechSynthesis（机械音、WebView 内常不可用）。
let _ttsNodeId = null;
let _ttsAudio = null;   // 当前播放的 <audio> 元素（Edge-TTS 路径）
let _ttsPausedAt = 0;   // 暂停的时刻（浏览器合成那条路要用，见 toggleSpeak）
// ⚠️ 「正在取音频」也是一种状态，必须进状态机。原来它只活在按钮文案里 ——
//    请求还没回来时再点一下，_ttsState 说 idle，于是又发一个请求：
//    两个回调的 nodeId 都对得上、各自 new 一个 Audio 同时播，
//    后一个覆盖 _ttsAudio，前一个变成**控制不了也回收不掉**的野音频。
//    （Codex 四审逮到的）
let _ttsLoading = null;   // 正在取音频的那条消息 id
// ⚠️ 每次请求一个递增的号。守卫**必须**认它，不能认 _ttsLoading 本身 ——
//    因为 _ttsLoading 在成功路径上会被清掉，而清掉之后如果再抛错
//    （比如 blob 是空的），catch 里的守卫就成立了、直接 return：
//    不回退浏览器合成、按钮永久停在「加载…」，内部状态却是 idle。
//    （Codex 五审复现出来的：state=idle / button=⏳ 加载…）
let _ttsSeq = 0;
let _ttsToken = 0;
let _ttsAbort = null;     // 当前请求的 AbortController，取消时要真的掐掉
let _ttsUtterance = null; // 浏览器合成当前这一句；同 nodeId 重念时要靠对象/token 分新旧
// 按钮是这个功能**唯一的状态显示**，所以状态和文案必须一处改、一起改。
// 分开写的话总有一条路忘了更新文案，症状是「点了没反应」——
// 其实反应了，只是按钮还写着上一个状态。
const TTS_LABEL = { idle: '🔊 朗读', playing: '⏸ 暂停', paused: '▶ 继续', loading: '⏳ 加载…' };
function _ttsBtnSet(nodeId, st) {
  const b = document.getElementById('tts-btn-' + nodeId);
  if (b) b.textContent = TTS_LABEL[st] || TTS_LABEL.idle;
}
function _ttsBtnReset(nodeId) {
  if (_ttsNodeId === nodeId) _ttsNodeId = null;
  _ttsBtnSet(nodeId, 'idle');
}
function _ttsStopAll() {
  _ttsLoading = null;
  _ttsToken = ++_ttsSeq;                   // 在飞的回调一律作废
  _ttsPreviewStop();                       // 设置里的试听也归它管，否则试听和朗读会同时响
  if (_ttsAbort) { try { _ttsAbort.abort(); } catch (_) {} _ttsAbort = null; }
  if (_ttsAudio) {
    try { _ttsAudio.pause(); } catch (_) {}
    // ⚠️ blob URL 要在这儿回收。done() 里那次只在**自然念完/出错**时跑，
    //    而「切去念另一条」走的是这条路 —— 不 revoke 的话每换一条漏一个，
    //    一次几十上百 KB，不报错、只是内存慢慢涨。
    try { if (_ttsAudio.src && _ttsAudio.src.indexOf('blob:') === 0) URL.revokeObjectURL(_ttsAudio.src); } catch (_) {}
    _ttsAudio.src = ''; _ttsAudio = null;
  }
  if ('speechSynthesis' in window) try { speechSynthesis.cancel(); } catch (_) {}
  _ttsUtterance = null;
  _ttsPausedAt = 0;
}

// 当前这条是「播着」还是「停着」。三处要用，写一处。
function _ttsState(nodeId) {
  if (_ttsLoading === nodeId) return 'loading';
  if (_ttsNodeId !== nodeId) return 'idle';
  if (_ttsAudio) return _ttsAudio.paused ? 'paused' : 'playing';
  if ('speechSynthesis' in window && speechSynthesis.speaking) {
    return speechSynthesis.paused ? 'paused' : 'playing';
  }
  return 'idle';
}

// ⚠️ 消息列表一重画，按钮就是新元素、文案回到「朗读」，而音频还在响。
//    她看到的是「朗读」，点一下反而从头开始念 —— 而且旧的那路还在放。
//    渲染完调一次这个把文案补回去。（和设置面板那两个开关是同一类问题：
//    UI 有状态就必须有回填，不能指望它天生对。）
function ttsSyncBtn() {
  if (_ttsNodeId == null) return;
  // ⚠️⚠️ 这一条才是「别念着念着人没了」的**保证**，下面那些散在各入口的
  //   ttsStopSpeaking() 只是提前量。
  //   判据是**承载暂停按钮的那条消息还在不在视图里** —— 重画完按钮元素没了，
  //   就说明她已经看不到它了：既停不掉也释放不掉，只能刷新页面。
  //   原来的做法是去每个「会切走」的入口手动叫停，那是**枚举**，而枚举数不全：
  //   我数了七个以为齐了，Codex 六审又找出三个（切分支、编辑重发、批量删对话），
  //   顺着 activeChatId 还能再找出两个（回收站恢复对话、建群聊）。
  //   凡是能让那条消息离开视图的路，最后都要经过一次 renderMessages()，
  //   而这个函数就挂在它末尾 —— 一条判据盖住全部入口，以后新加入口也不用记得改这儿。
  if (!document.getElementById('tts-btn-' + _ttsNodeId)) { ttsStopSpeaking(); return; }
  const st = _ttsState(_ttsNodeId);
  if (st === 'idle') { _ttsNodeId = null; return; }
  _ttsBtnSet(_ttsNodeId, st);
}
// 对外的「别念了」。切对话、删消息、重新生成那几条路都要叫它 ——
// 不叫的话音频接着放，而承载暂停按钮的那条消息已经从视图里没了：
// 她既停不掉也释放不掉，只能刷新页面。（Codex 四审逮到的）
function ttsStopSpeaking() {
  const was = _ttsNodeId;
  _ttsStopAll();
  if (was != null) _ttsBtnReset(was);
  _ttsNodeId = null;
}

// 提取并清洗要朗读的文本（去标签、代码块、markdown 符号、链接）
function getTtsCleanText(node) {
  return cleanTtsText(getMsgPlainText(node));
}
// 同一套清洗规则，但吃的是裸字符串。语音拆段（_splitVoiceSegs）按表情把正文切成好几截，
// 每一截各自送去合成，那时候手里只有半段文本、没有 node —— 两边必须共用一套规则，
// 不然拆出来的语音条念的东西和整条语音对不上。
function cleanTtsText(raw) {
  return String(raw || '')
    // 指令块（存储记忆 / 高级记忆 / 结束对话 / 打给你…）在 processAiCommands 里就已经
    // 变成 <div class="think-block"> 这样的小卡片躺在 content 里。它们是给眼睛看的，不是给耳朵听的——
    // 不剥掉的话，念出来的是一坨标签，Edge-TTS 干脆返回空音频（502）。
    .replace(/<div class="think-block[\s\S]*?<\/div>\s*<\/div>/g, ' ')
    .replace(/<[^>]+>/g, ' ')                       // 兜底：任何残余标签
    .replace(/```[\s\S]*?```/g, '，代码略，')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_#`>|~]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
// 把 state.ttsRate（整数百分比，-50~50）转成 Edge TTS 的 rate 字符串（+0% / -20%）
function _ttsRateStr() {
  const r = Math.max(-50, Math.min(50, parseInt(state.ttsRate) || 0));
  return (r >= 0 ? '+' : '') + r + '%';
}
// 音高与设置滑条同范围；显式带正负号，和服务端的 SSML 白名单一致
function _ttsPitchStr() {
  const p = Math.max(-50, Math.min(20, parseInt(state.ttsPitch) || 0));
  return (p >= 0 ? '+' : '') + p + '%';
}
function _ttsIsDeepgramVoice(voice) {
  return String(voice || '').startsWith('aura-');
}
// 本地情绪声音（cosy-*，见 js/voice-style.js、server/tts-local.js）
function _ttsIsLocalVoice(voice) {
  return typeof VoiceStyle !== 'undefined' && VoiceStyle.isLocalVoice(voice);
}
// 这句话该用什么语气：当前对话那个 AI 的生命体征 + 这句话本身。体征关着就只看话。
function _ttsStyleFor(text) {
  if (typeof VoiceStyle === 'undefined') return 'neutral';
  let v = null;
  try {
    if (typeof vitalsEnabled === 'function' && vitalsEnabled() && typeof vitalsEnsure === 'function') {
      const id = typeof getActiveChatModelIds === 'function' ? getActiveChatModelIds()[0] : null;
      if (id != null) v = vitalsEnsure(id);
    }
  } catch (_) { v = null; }
  return VoiceStyle.pick(v, text).style;
}
// 本地声音要多带的参数；别的音色返回空串。三条路（朗读 / 语音条 / 通话）都拼它。
function _ttsStyleParam(text, voice) {
  return _ttsIsLocalVoice(voice) ? '&style=' + encodeURIComponent(_ttsStyleFor(text)) : '';
}
// 本地声音第一次要加载模型（几十秒），Edge 那条 6 秒超时会把它掐掉、转去念机械音
function _ttsTimeoutMs(voice) {
  return _ttsIsLocalVoice(voice) ? 120000 : 6000;
}
function _ttsVoiceForText(text) {
  const selected = state.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  if (_ttsIsDeepgramVoice(selected) && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)) {
    showToast('Deepgram 音色不支持中文，已改用中文兜底音色', 'info', 3500);
    return state.ttsVoiceZh || 'zh-CN-XiaoxiaoNeural';
  }
  return selected;
}
// 实际朗读和设置里的试听必须走同一套音色选择，避免把中文交给英语专用模型
function _ttsUrl(text) {
  const voice = _ttsVoiceForText(text);
  let url = SERVER_BASE + '/api/tts?text=' + encodeURIComponent(text)
    + '&voice=' + encodeURIComponent(voice);
  if (_ttsIsLocalVoice(voice)) {
    url += '&rate=' + encodeURIComponent(_ttsRateStr()) + _ttsStyleParam(text, voice);
  } else if (!_ttsIsDeepgramVoice(voice)) {
    url += '&rate=' + encodeURIComponent(_ttsRateStr())
      + '&pitch=' + encodeURIComponent(_ttsPitchStr());
  }
  return typeof gcTok === 'function' ? gcTok(url) : url;   // 给 <audio> 当 src 用，加不了头，手机上要补配对码
}
function toggleSpeak(nodeId) {
  const btn = document.getElementById('tts-btn-' + nodeId);

  // ── 同一条：在「播」和「停一下」之间来回，**不销毁**音频 ──
  //    原来这里是「再点一次 = 停止」：pause() 之后把 src 清空、对象置 null。
  //    那是销毁不是暂停 —— 念到一半想停一下，再点就得重新请求一次 TTS、从头念。
  //    （用户提的：「语音没法暂停」。）
  const st = _ttsState(nodeId);
  // 正在取音频时再点 = 取消这次（而不是再发一个请求）
  if (st === 'loading') {
    _ttsToken = ++_ttsSeq;                 // 作废这次请求的回调
    if (_ttsAbort) { try { _ttsAbort.abort(); } catch (_) {} _ttsAbort = null; }
    _ttsLoading = null;
    _ttsNodeId = null;
    _ttsBtnSet(nodeId, 'idle');
    return;
  }
  if (st === 'playing') {
    if (_ttsAudio) { try { _ttsAudio.pause(); } catch (_) {} }
    else if ('speechSynthesis' in window) { try { speechSynthesis.pause(); } catch (_) {} }
    _ttsPausedAt = Date.now();
    _ttsBtnSet(nodeId, 'paused');
    return;
  }
  if (st === 'paused') {
    if (_ttsAudio) {
      // play() 的 Promise 可能在「继续 → 停掉 → 同一条重新朗读」之后才落地。
      // nodeId 前后相同，必须同时认当时的 audio 和 token，旧 Promise 才碰不到新会话。
      const audio = _ttsAudio;
      const token = _ttsToken;
      audio.play().then(() => {
        if (_ttsAudio === audio && _ttsToken === token) _ttsBtnSet(nodeId, 'playing');
      }, () => {
        if (_ttsAudio !== audio || _ttsToken !== token) return;
        _ttsStopAll();
        _ttsBtnReset(nodeId);
      });
      _ttsBtnSet(nodeId, 'playing');
      return;
    }
    // ⚠️ 浏览器合成那条路：Chrome 上暂停超过十几秒，utterance 会被系统回收，
    //    resume() 调了没声音也不报错 —— 按钮显示「播放中」，其实什么都没有。
    //    所以停太久就别 resume 了，老老实实从头念一遍（有声音 > 假装在播）。
    if ('speechSynthesis' in window) {
      if (Date.now() - _ttsPausedAt > 12000) {
        try { speechSynthesis.cancel(); } catch (_) {}
        _ttsNodeId = null;                       // 落到下面走完整流程重念
      } else {
        try { speechSynthesis.resume(); } catch (_) {}
        _ttsBtnSet(nodeId, 'playing');
        return;
      }
    }
  }

  // ── 换一条：把上一条真的停掉并释放 ──
  _ttsStopAll();
  if (_ttsNodeId && _ttsNodeId !== nodeId) _ttsBtnReset(_ttsNodeId);

  const chat = getActiveChat(); if (!chat) return;
  const node = chat.nodes[nodeId]; if (!node) return;
  const text = getTtsCleanText(node);
  if (!text) { showToast('没有可朗读的文本'); return; }

  _ttsNodeId = nodeId;
  _ttsLoading = nodeId;
  _ttsBtnSet(nodeId, 'loading');

  // 1) 优先 Edge 神经语音（server.js 中转）
  const url = _ttsUrl(text.slice(0, 2000));
  const ctrl = new AbortController();
  _ttsAbort = ctrl;
  const token = ++_ttsSeq;
  _ttsToken = token;
  const timer = setTimeout(() => ctrl.abort(), _ttsTimeoutMs(state.ttsVoice));
  fetch(url, { signal: ctrl.signal })
    .then(r => { clearTimeout(timer); if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); })
    .then(blob => {
      if (_ttsToken !== token) return;                 // 这次请求已经不作数了
      // ⚠️ 先验再清。反过来的话（先清 _ttsLoading 再验），下面这一 throw
      //    会被 catch 里的守卫吞掉 —— 不回退、按钮永久「加载…」。
      if (!blob || blob.size < 200) throw new Error('empty audio');
      _ttsLoading = null;
      const audio = new Audio(URL.createObjectURL(blob));
      _ttsAudio = audio;
      // ⚠️ 下面这三个回调都是**晚到的**：play() 那个 promise、onerror、onended
      //    都可能在「取消 → 重新朗读同一条」之后才落地。它们捕获的 nodeId 前后一样，
      //    认 nodeId 等于不认 —— 旧请求的失败会把新请求的按钮打回「朗读」，
      //    再把**旧文本**丢给浏览器合成念出来，于是两路叠播、按钮却显示空闲。
      //    资源回收（revoke / 清 _ttsAudio）认这个 audio 自己，界面和续播认 token。
      //    （Codex 六审逮到的）
      const done = () => {
        URL.revokeObjectURL(audio.src);
        if (_ttsAudio === audio) _ttsAudio = null;
        if (_ttsToken !== token) return;
        _ttsBtnReset(nodeId);
      };
      audio.onended = done;
      audio.onerror = () => { done(); };
      _ttsBtnSet(nodeId, 'playing');
      audio.play().catch(() => {
        done();
        if (_ttsToken !== token) return;              // 旧请求的失败不许把旧文本念出来
        speakFallback(nodeId, text);
      });
    })
    .catch(() => {
      clearTimeout(timer);
      if (_ttsToken !== token) return;                 // 已经被取消/换人了
      _ttsLoading = null;
      speakFallback(nodeId, text);                    // 2) 回退浏览器合成
    });
}
// 浏览器 speechSynthesis 兜底
function speakFallback(nodeId, text) {
  const btn = document.getElementById('tts-btn-' + nodeId);
  if (!('speechSynthesis' in window)) {
    showToast('后端未连接，且当前环境不支持本地语音合成', 'error', 3000);
    _ttsBtnReset(nodeId);
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.05 + (parseInt(state.ttsRate) || 0) / 100;
  const zh = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('zh'));
  if (zh) u.voice = zh;
  const token = _ttsToken;
  const reset = () => {
    // cancel/restart 同一条时，旧 utterance 的 onend/onerror 也会晚到；只认 nodeId 会误伤新句。
    if (_ttsUtterance !== u || _ttsToken !== token) return;
    _ttsUtterance = null;
    _ttsBtnReset(nodeId);
  };
  u.onend = reset; u.onerror = reset;
  _ttsNodeId = nodeId;
  _ttsUtterance = u;
  _ttsPausedAt = 0;
  _ttsBtnSet(nodeId, 'playing');
  speechSynthesis.speak(u);
}
// 把 state 里的音色/语速/音高回填到设置面板控件
function syncTtsSettingsUI() {
  const sel = document.getElementById('ttsVoiceSelect');
  if (sel) sel.value = state.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  const r = document.getElementById('ttsRateRange');
  const lbl = document.getElementById('ttsRateLabel');
  const rate = parseInt(state.ttsRate) || 0;
  if (r) r.value = rate;
  if (lbl) lbl.innerText = (rate >= 0 ? '+' : '') + rate + '%';
  const p = document.getElementById('ttsPitchRange');
  const plbl = document.getElementById('ttsPitchLabel');
  const pitch = parseInt(state.ttsPitch) || 0;
  if (p) p.value = pitch;
  if (plbl) plbl.innerText = (pitch >= 0 ? '+' : '') + pitch + '%';
  const zhSel = document.getElementById('ttsVoiceZhSelect');
  if (zhSel) zhSel.value = state.ttsVoiceZh || 'zh-CN-XiaoxiaoNeural';
  const deepgram = _ttsIsDeepgramVoice(state.ttsVoice);
  const local = _ttsIsLocalVoice(state.ttsVoice);
  const zhWrap = document.getElementById('ttsVoiceZhWrap');
  const note = document.getElementById('ttsDeepgramNote');
  const localNote = document.getElementById('ttsLocalNote');
  if (zhWrap) zhWrap.style.display = deepgram ? 'block' : 'none';
  if (note) note.style.display = deepgram ? 'block' : 'none';
  if (localNote) localNote.style.display = local ? 'block' : 'none';
  if (r) r.disabled = deepgram;
  if (p) p.disabled = deepgram || local;     // 本地声音不吃音高，语速吃
  _ttsLoadLocalVoices();
}
// 本地声音的样本是 voices 目录里有什么就是什么——放一段 wav+txt 进去就多一个选项，
// 所以选项表要问 server 要。问不到（server 不在/没装）就只留 HTML 里写死的那个。
let _ttsLocalAsked = 0;
function _ttsLoadLocalVoices() {
  if (typeof fetch !== 'function' || typeof SERVER_BASE === 'undefined') return;
  if (Date.now() - _ttsLocalAsked < 30000) return;
  _ttsLocalAsked = Date.now();
  fetch(SERVER_BASE + '/api/tts/local').then(r => r.ok ? r.json() : null).then(s => {
    if (!s) return;
    const group = document.getElementById('ttsLocalGroup');
    if (group) {
      for (const name of s.voices || []) {
        const id = 'cosy-' + name;
        if (!VoiceStyle.isLocalVoice(id) || group.querySelector('option[value="' + id + '"]')) continue;
        const o = document.createElement('option');
        o.value = id; o.textContent = name + ' · 本地样本';
        group.appendChild(o);
      }
      const sel = document.getElementById('ttsVoiceSelect');
      if (sel && state.ttsVoice) sel.value = state.ttsVoice;
    }
    const st = document.getElementById('ttsLocalStatus');
    if (st) st.textContent = !s.installed ? '⚠️ 这台电脑上还没装引擎，现在念的是 Edge 兜底。'
      : s.running ? '✓ 模型已加载。' : s.booting ? '⏳ 模型加载中…' : '模型还没加载，第一句会慢一些。';
  }).catch(() => {});
}
// 通话开始时先把模型拉起来：通话里第一句话等几十秒冷启动是没法接受的
function ttsWarmLocal() {
  if (!_ttsIsLocalVoice(state.ttsVoice) || typeof fetch !== 'function' || typeof SERVER_BASE === 'undefined') return;
  fetch(SERVER_BASE + '/api/tts/local/warm', { method: 'POST' }).catch(() => {});
}
// 设置面板「试听」当前音色
let _ttsPreviewAudio = null, _ttsPreviewAbort = null;
// 把上一次试听彻底掐掉。**光 pause() 是不够的** —— 上一次的请求可能还在路上，
// 那时 _ttsPreviewAudio 还是 null，没东西可 pause，等它回来照样会播。
// 用户报的「点中文试音念两遍、声音重在一起」就是这个：
// 下拉框 onchange 自己会试听一次，紧接着点「▶ 试听」是第二次，两次都落在请求窗口里。
function _ttsPreviewStop() {
  if (_ttsPreviewAbort) { try { _ttsPreviewAbort.abort(); } catch (_) {} _ttsPreviewAbort = null; }
  if (_ttsPreviewAudio) {
    try { _ttsPreviewAudio.pause(); } catch (_) {}
    try { if (String(_ttsPreviewAudio.src).indexOf('blob:') === 0) URL.revokeObjectURL(_ttsPreviewAudio.src); } catch (_) {}
    _ttsPreviewAudio.src = ''; _ttsPreviewAudio = null;
  }
}
function previewTtsVoice() {
  // 走 ttsStopSpeaking 而不是 _ttsStopAll：它还会把那条消息的朗读按钮复位。
  // 顺带作废在飞的回调（_ttsToken 会 ++），下面所有分支都认这个 token。
  ttsStopSpeaking();
  const token = _ttsToken;
  const text = _ttsIsDeepgramVoice(state.ttsVoice)
    ? 'Hi, this is Hyperion. I hope you like this warm Australian voice.'
    : '你好呀，这是当前音色的试听效果，希望你喜欢。';
  const url = _ttsUrl(text);
  const ctrl = new AbortController();
  _ttsPreviewAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), _ttsTimeoutMs(state.ttsVoice));
  fetch(url, { signal: ctrl.signal })
    .then(r => {
      clearTimeout(timer);
      if (!r.ok) throw new Error('tts ' + r.status);
      return r.blob();
    })
    .then(blob => {
      // 唯一的一道 token 闸，就卡在「要开始播了」之前。
      // 之前这里和上面各有一道，上面那道会先拦下 —— 结果下面这道任何测试都走不到，
      // 拆掉它测试还是全绿。宁可只留一道真有人守着的，也不要两道其中一道没人验。
      if (_ttsToken !== token) return;
      if (!blob || blob.size < 200) throw new Error('empty');
      const a = new Audio(URL.createObjectURL(blob));
      _ttsPreviewAudio = a;
      a.onended = a.onerror = () => { URL.revokeObjectURL(a.src); if (_ttsPreviewAudio === a) _ttsPreviewAudio = null; };
      a.play().catch(() => {});
    })
    .catch(() => {
      clearTimeout(timer);
      // ⚠️ 这条也必须认 token。上面的 abort() 会让 fetch 抛异常走到这里 ——
      //    不拦的话「被顶掉的那次」会用系统语音再念一遍，等于换个嗓子重叠。
      if (_ttsToken !== token) return;
      if (!('speechSynthesis' in window)) { showToast('后端未连接，无法试听神经语音', 'error'); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = 1.05 + (parseInt(state.ttsRate) || 0) / 100;
      const zh = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('zh'));
      if (zh) u.voice = zh;
      speechSynthesis.speak(u);
    });
}

