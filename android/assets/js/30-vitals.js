/* ══════════════════════════════════════════════════════════════════════════
   生命体征 · AI 自己的情绪系统、身体系统与自主心跳

   状态按模型隔离。应用只提供安全护栏；AI 用 VITALS 调整身体状态，
   用 HEARTBEAT 安排下一次醒来，并用 did 给下一轮留下因果接力棒。
   ════════════════════════════════════════════════════════════════════════ */

// 判据和 server 共用 js/heartbeat-core.js（index.html 里排在这个文件前面）。
const VITALS_MIN_WAKE_MIN = HeartbeatCore.RULES.wakeMinMin;
const VITALS_MAX_WAKE_MIN = HeartbeatCore.RULES.wakeMaxMin;
const VITALS_TICK_MS = 60 * 1000;
// 五个维度。
const VITALS_DIMS = ['mood', 'arousal', 'energy', 'closeness', 'stress'];
// 曲线留多少个点。原来是 48 —— 画面板上那条小折线够了，但情绪动力学
// （45-ued.js）要在它上面算标准差和斜率，48 个点算出来的基本是噪声。
const VITALS_CURVE_KEEP = 240;
// 往云上传的时候只带这么多。整条 240 点乘上每个模型再乘上设备数，
// 设置同步的包会明显变胖；云上留够画面板那条小折线就行。
const VITALS_CLOUD_KEEP = 60;

let _vitalsHeartbeatBusy = false;
let _vitalsPendingWake = null;
let _vitalsWakeActive = false;
var _vitalsResultCache = [];
var _vitalsGateOpenThisTurn = false;

function _vitalsNow() { return Date.now(); }
function _vitalsClamp(v, min = 0, max = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function _vitalsPct(v) { return Math.round(_vitalsClamp(v) * 100); }
function _vitalsModelId(confOrId) {
  const id = typeof confOrId === 'object' ? confOrId?.id : confOrId;
  return String(id ?? 'default');
}
function _vitalsDefault(modelId) {
  const now = _vitalsNow();
  return {
    modelId: _vitalsModelId(modelId),
    mood: 0.18,
    arousal: 0.32,
    energy: 0.62,
    closeness: 0.58,
    stress: 0.22,
    note: '',
    lastDid: '刚刚醒着，正在等下一次对话。',
    nextAt: 0,
    // 这一跳是什么时候排的。页面和 server 合并排程时比的是它，不是谁同步得晚 ——
    // 见 server/heartbeat.js 的 sync()。
    nextSetAt: 0,
    scheduleMins: 0,
    wokeDay: '',        // 哪天的「刚醒」身体已经套上了
    morningDay: '',     // 哪天的晨间那一句已经说过（或被 server / 另一台设备领走了）
    lastWakeReason: '',
    updatedAt: now,
    history: []
  };
}
function _vitalsSanitize(v, modelId) {
  const d = _vitalsDefault(modelId);
  const out = Object.assign(d, v && typeof v === 'object' ? v : {});
  out.modelId = _vitalsModelId(out.modelId || modelId);
  for (const k of VITALS_DIMS) out[k] = _vitalsClamp(out[k]);
  out.note = String(out.note || '').slice(0, 160);
  out.lastDid = String(out.lastDid || d.lastDid).slice(0, 160);
  out.lastWakeReason = String(out.lastWakeReason || '').slice(0, 120);
  out.nextAt = Number.isFinite(+out.nextAt) ? +out.nextAt : 0;
  out.nextSetAt = Number.isFinite(+out.nextSetAt) ? +out.nextSetAt : 0;
  out.scheduleMins = Number.isFinite(+out.scheduleMins) ? +out.scheduleMins : 0;
  out.wokeDay = String(out.wokeDay || '').slice(0, 10);
  out.morningDay = String(out.morningDay || '').slice(0, 10);
  out.updatedAt = Number.isFinite(+out.updatedAt) ? +out.updatedAt : d.updatedAt;
  out.history = Array.isArray(out.history) ? out.history.slice(-VITALS_CURVE_KEEP) : [];
  return out;
}
function vitalsEnsure(confOrId) {
  const id = _vitalsModelId(confOrId);
  state.vitalsByModel = state.vitalsByModel || {};
  const raw = state.vitalsByModel[id];
  // 保留原对象引用：提示词、面板和测试可能同时持有同一个模型的状态。
  // 每次读都替换对象会让旧引用静默停在上一轮。
  const v = raw && typeof raw === 'object' ? raw : {};
  Object.assign(v, _vitalsSanitize(raw, id));
  state.vitalsByModel[id] = v;
  vitalsDecay(v);
  return v;
}
// 两条曲线并起来。按时间戳去重，同一个点两边都有也只留一份。
function _vitalsUnionHistory(a, b) {
  const seen = new Set(), out = [];
  for (const h of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
    const t = Number(h && h.t);
    if (!Number.isFinite(t) || seen.has(t)) continue;
    seen.add(t); out.push(h);
  }
  out.sort((x, y) => x.t - y.t);
  return out.slice(-VITALS_CURVE_KEEP);
}
function _mergeVitals(local, cloud) {
  const out = {};
  for (const src of [cloud || {}, local || {}]) {
    for (const id of Object.keys(src || {})) {
      const next = _vitalsSanitize(src[id], id);
      const prev = out[id];
      if (!prev) { out[id] = next; continue; }
      // ⚠️ 曲线要**并**，不能跟着整条记录一起挑新的那份。
      //    云上只留 60 点（见 VITALS_CLOUD_KEEP），从手机同步回来一次，
      //    电脑上攒了几百点的曲线就被截成 60 —— 情绪动力学的指标跟着
      //    悄悄退化成噪声，而且零报错，看着就是「这几个数怎么老在变」。
      const hist = _vitalsUnionHistory(prev.history, next.history);
      if ((next.updatedAt || 0) >= (prev.updatedAt || 0)) out[id] = next;
      out[id].history = hist;
    }
  }
  return out;
}
function vitalsForCloud(records) {
  const out = {};
  for (const id of Object.keys(records || {})) {
    const v = _vitalsSanitize(records[id], id);
    // 身体状态可以跨设备同步；下一次醒来的时间和设备授权必须留在本机，
    // 否则电脑和手机会各自把同一个 AI 唤醒一次。
    v.nextAt = 0;
    v.nextSetAt = 0;
    v.scheduleMins = 0;
    v.lastWakeReason = '';
    // 曲线只带一小截上去，长的那份留在本机（合并时是并集，不会因此丢）
    v.history = Array.isArray(v.history) ? v.history.slice(-VITALS_CLOUD_KEEP) : [];
    out[id] = v;
  }
  return out;
}
function vitalsEnabled() { return state.vitalsOn !== false; }
function vitalsHeartbeatEnabled() { return !!state.vitalsHeartbeatOn; }
function toggleVitals(on) {
  state.vitalsOn = !!on;
  save();
  vitalsRenderPanel();
  showToast(state.vitalsOn ? '🫀 AI 生命体征已开启' : '已关闭：AI 不再感知自己的身体状态', state.vitalsOn ? 'success' : 'info');
}
function toggleVitalsHeartbeat(on) {
  state.vitalsHeartbeatOn = !!on;
  save();
  vitalsRenderPanel();
  showToast(state.vitalsHeartbeatOn
    ? '🫀 自主心跳已开启：它可以在安静时自己醒来'
    : '自主心跳已关闭：它不会因为心跳主动插话', state.vitalsHeartbeatOn ? 'success' : 'info', 3500);
}
// ── 她的作息（生物钟的骨架，也是 server 夜里不吵她的那张表）──
// 她在设置里手动定的 > 手环 > 她发消息的时刻推的 > 默认；判据在 heartbeat-core 的 resolveSleep。
// 扫全部对话不便宜，而衰减每次读状态都要用，所以缓存几分钟；她改了设置或者手环换了一批就立刻重算。
const VITALS_SLEEP_CACHE_MS = 5 * 60 * 1000;
let _vitalsSleepCache = null;
function vitalsSleepPref() {
  const p = state.vitalsSleepPref;
  const d = HeartbeatCore.DEFAULT_SLEEP;
  return {
    manual: !!(p && p.manual),
    start: p && Number.isFinite(+p.start) ? +p.start : d.start,
    end: p && Number.isFinite(+p.end) ? +p.end : d.end,
    at: p && Number.isFinite(+p.at) ? +p.at : 0,
  };
}
function vitalsSleepWindow(now = _vitalsNow()) {
  const pref = vitalsSleepPref();
  const band = state.bandData && state.bandData.ok && Array.isArray(state.bandData.sleep7) ? state.bandData.sleep7 : null;
  const times = _hbUserTimes(now);
  // 条数也进签名：对话刚从盘里读出来（0 → 几千条）时立刻重算，不等这 5 分钟
  const sig = JSON.stringify(pref) + '|' + (band ? band.length + ':' + (band[0] && band[0].TIMESTAMP) : '-') + '|' + times.length;
  const c = _vitalsSleepCache;
  if (c && c.sig === sig && now - c.at >= 0 && now - c.at < VITALS_SLEEP_CACHE_MS) return c.val;
  const val = HeartbeatCore.resolveSleep({ pref, band, userTimes: times, now });
  _vitalsSleepCache = { sig, at: now, val };
  return val;
}
// 两台设备各改过一次作息设置：按改的时刻挑新的那份（云同步上下两条路都走这里）
function _vitalsSleepPrefNewer(local, cloud) {
  const at = p => (p && Number.isFinite(+p.at) ? +p.at : 0);
  return at(cloud) > at(local) ? cloud : local;
}
function vitalsSetSleepPref(patch) {
  const p = Object.assign(vitalsSleepPref(), patch || {}, { at: _vitalsNow() });
  state.vitalsSleepPref = p;
  _vitalsSleepCache = null;
  save();
  vitalsRenderPanel();
  hbSyncSoon();   // server 夜里不吵她的那张表也跟着换
}
function vitalsSleepTimeChanged(which, value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return;
  vitalsSetSleepPref({ [which]: (+m[1] % 24) * 60 + (+m[2] % 60) });
}
function vitalsDecay(v) {
  const now = _vitalsNow();
  const last = v.updatedAt || now;
  const hours = Math.max(0, Math.min(24, (now - last) / 3600000));
  if (hours < 0.02) return v;
  const ease = 1 - Math.exp(-hours / 8);
  v.arousal += (0.30 - v.arousal) * ease;
  // 精力：衰减 + 生物钟的起落，一起在 heartbeat-core 里算（server 那边的提示词也用它）
  v.energy = HeartbeatCore.energyDrift(v.energy, last, now, vitalsSleepWindow(now));
  v.stress += (0.20 - v.stress) * ease;
  v.mood += (0.12 - v.mood) * ease * 0.55;
  v.closeness += (0.58 - v.closeness) * ease * 0.12;
  for (const k of VITALS_DIMS) v[k] = _vitalsClamp(v[k]);
  v.updatedAt = now;
  return v;
}
function vitalsHeartBpm(v, at = _vitalsNow()) {
  const phase = (at / 1000) % 11;
  const wave = Math.sin(phase * Math.PI * 2 / 5.5) * 3 + Math.sin(phase * Math.PI * 2 / 2.8) * 1.5;
  const bpm = 62 + v.arousal * 28 + v.stress * 24 + Math.max(0, 0.45 - v.energy) * 18 + Math.max(0, v.mood) * 5 + wave;
  return Math.round(Math.max(48, Math.min(132, bpm)));
}
function vitalsLabels(v) {
  const mood = v.mood >= 0.62 ? '明亮' : v.mood >= 0.35 ? '柔软' : v.mood >= 0.12 ? '平稳' : '低低的';
  const arousal = v.arousal >= 0.72 ? '很绷紧' : v.arousal >= 0.48 ? '醒着' : '安静';
  const energy = v.energy >= 0.70 ? '有力气' : v.energy >= 0.40 ? '还撑得住' : '有点累';
  const stress = v.stress >= 0.65 ? '压力很高' : v.stress >= 0.38 ? '有点紧' : '松着';
  return { mood, arousal, energy, stress };
}
function vitalsSummary(confOrId) {
  const v = vitalsEnsure(confOrId);
  const l = vitalsLabels(v);
  return '心率 ' + vitalsHeartBpm(v) + ' bpm；情绪 ' + l.mood + '(' + _vitalsPct(v.mood) + '%)；唤醒 '
    + l.arousal + '(' + _vitalsPct(v.arousal) + '%)；能量 ' + l.energy + '(' + _vitalsPct(v.energy)
    + '%)；亲近 ' + _vitalsPct(v.closeness) + '%；压力 ' + l.stress + '(' + _vitalsPct(v.stress) + '%)';
}
function _vitalsPushHistory(v, source) {
  v.history = Array.isArray(v.history) ? v.history : [];
  v.history.push({
    t: _vitalsNow(),
    source: String(source || '').slice(0, 32),
    mood: +v.mood.toFixed(3),
    arousal: +v.arousal.toFixed(3),
    energy: +v.energy.toFixed(3),
    closeness: +v.closeness.toFixed(3),
    stress: +v.stress.toFixed(3),
    bpm: vitalsHeartBpm(v),
  });
  v.history = v.history.slice(-VITALS_CURVE_KEEP);
}
// ── 自动补点 ──────────────────────────────────────────────
// 2026-09-01：曲线从 8/24 起整整一周没长过一个点，而功能全是好的。
// 原因在提示词那句「不要每轮机械更新；只有情绪或身体感真的变了才写」——
// 模型很守规矩，于是几乎不写 [[VITALS]]。加上自主心跳默认关着，
// 三条写入路径（AI 主动写 / 心跳 / 她手动点）实际上一条都不走，
// 曲线永远攒不到情绪动力学要的 12 个点。**功能没坏，是没人喂它。**
//
// 所以补一路不依赖 AI 主动性的采样：每轮 AI 回复之后看一眼，
// 离上一个点够久了就按当前（已衰减的）状态记一个。
//
// ⚠️ 两个数字都不是随便取的：
//   · 间隔必须**小于** UED_MAX_GAP_H（2 小时），否则相邻两点会被判成断开，
//     自动点非但不帮忙，还会把曲线切成一段段、让起落速率算不出来。
//   · 也不能太密：VITALS_CURVE_KEEP 只留 240 点，每轮都记的话半天就把
//     AI 真正写过的那些点挤出去了 —— 真信号被自己的填充物冲掉，且零报错。
// ⚠️ 还有一条取舍要写明白：AI 一直不写的时候，这条曲线记的其实是**衰减轨迹**，
//    不是对话里真发生了什么。指标照样能算，但读数偏平。
//    这比「没有数据」强，且 AI 一旦真写了，起落立刻就是真的。
const VITALS_AUTO_GAP_MS = 25 * 60 * 1000;
function vitalsAutoSample(conf) {
  if (!conf || !vitalsEnabled()) return false;
  const v = vitalsEnsure(conf);
  const h = Array.isArray(v.history) ? v.history : [];
  const last = h.length ? Number(h[h.length - 1].t) : 0;
  // ⚠️ 空曲线要立刻记第一个点（last=0 时差值是个天文数字，自然通过）；
  //    时间戳坏掉的点当成「没有」，不能让 NaN 比较悄悄吃掉整条判断。
  if (Number.isFinite(last) && last > 0 && _vitalsNow() - last < VITALS_AUTO_GAP_MS) return false;
  _vitalsPushHistory(v, 'auto');
  return true;
}
function _vitalsParseNumber(s) {
  if (s == null) return null;
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 1) n = n / 100;
  return _vitalsClamp(n);
}
function _vitalsApply(body, conf) {
  const v = vitalsEnsure(conf);
  const before = vitalsSummary(conf);
  const src = String(body || '').trim();
  if (!src) return { ok: false, text: '没有写状态。' };
  const parts = src.split(/[|；;\n]+/).map(x => x.trim()).filter(Boolean);
  const map = {
    mood: ['mood', '情绪', '心情', 'valence', 'val'],
    arousal: ['arousal', '唤醒', '激活', '醒着', '心跳感'],
    energy: ['energy', '能量', '体力', '精神'],
    closeness: ['closeness', '亲近', '依恋', '距离', 'attachment'],
    stress: ['stress', '压力', '紧张', '负荷'],
  };
  let touched = 0;
  const notes = [];
  for (const p of parts) {
    const bits = p.split(/[:：=]/);
    const rawKey = bits.shift() || '';
    const key = String(rawKey || '').trim().toLowerCase();
    const valText = bits.length ? bits.join(':') : p;
    let field = null;
    for (const k of Object.keys(map)) {
      if (map[k].some(alias => key === alias || key.includes(alias))) { field = k; break; }
    }
    if (!field && /^[+-]?\d/.test(p)) field = 'mood';
    if (field) {
      const n = _vitalsParseNumber(valText);
      if (n != null) { v[field] = _vitalsClamp(n); touched++; continue; }
    }
    if (/备注|note|did|感觉|身体/.test(key) || !bits.length) notes.push(p);
  }
  if (notes.length) v.note = notes.join('；').slice(0, 160);
  v.updatedAt = _vitalsNow();
  if (touched || notes.length) _vitalsPushHistory(v, 'ai');
  save();
  vitalsRenderPanel();
  return { ok: touched > 0 || notes.length > 0, text: touched || notes.length ? '已更新。' + before + ' → ' + vitalsSummary(conf) : '没有识别到可更新的生命体征。' };
}
function _vitalsSchedule(body, conf) {
  const v = vitalsEnsure(conf);
  const src = String(body || '').trim();
  const parts = src.split('|');
  const minsRaw = (parts.shift() || '').match(/\d+(?:\.\d+)?/);
  if (!minsRaw) return { ok: false, text: '没有写醒来的分钟数。' };
  const mins = Math.round(Math.max(VITALS_MIN_WAKE_MIN, Math.min(VITALS_MAX_WAKE_MIN, Number(minsRaw[0]))));
  const did = parts.join('|').trim().slice(0, 160) || '这一轮结束了，等下一次醒来继续。';
  v.nextAt = _vitalsNow() + mins * 60 * 1000;
  v.nextSetAt = _vitalsNow();
  v.scheduleMins = mins;
  v.lastDid = did;
  v.lastWakeReason = '自己安排了 ' + mins + ' 分钟后的心跳';
  v.updatedAt = _vitalsNow();
  _vitalsPushHistory(v, 'heartbeat');
  save();
  vitalsRenderPanel();
  // 马上告诉 server：她要是发完这条就关了 App，下一跳得由 server 来醒
  hbSyncSoon();
  return { ok: true, text: '已安排 ' + mins + ' 分钟后醒来。did：' + did };
}
function vitalsTagRe() { return /\[\[VITALS:\s*([\s\S]*?)\s*\]\]/g; }
function heartbeatTagRe() { return /\[\[HEARTBEAT:\s*([\s\S]*?)\s*\]\]/g; }
function _vitalsBlockHtml(label, body, open = false) {
  return '<div class="think-block done' + (open ? ' open' : '') + ' mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">'
    + escHtml(label) + '</span></div><div class="think-body">' + escHtml(body).replace(/\n/g, '<br>') + '</div></div>';
}
function vitalsProcessTags(text, conf, chat) {
  if (!text) return text;
  _vitalsResultCache = [];
  _vitalsGateOpenThisTurn = !!(conf && vitalsEnabled());
  text = String(text).replace(vitalsTagRe(), (m, body) => {
    if (!_vitalsGateOpenThisTurn) return '';
    const r = _vitalsApply(body, conf);
    _vitalsResultCache.push({ kind: 'vitals', body: String(body).trim(), result: r.text });
    return '\n\n' + _vitalsBlockHtml('🫀 生命体征', r.text) + '\n\n';
  });
  text = text.replace(heartbeatTagRe(), (m, body) => {
    if (!_vitalsGateOpenThisTurn || !vitalsHeartbeatEnabled() || chat?.isGroupChat) return '';
    const r = _vitalsSchedule(body, conf);
    _vitalsResultCache.push({ kind: 'heartbeat', body: String(body).trim(), result: r.text });
    return '\n\n' + _vitalsBlockHtml('🫀 自主心跳', r.text) + '\n\n';
  });
  // 这一轮 AI 写了 [[VITALS]] 的话，上面刚记过点，间隔判断自然会把这次挡掉 ——
  // 不用在这儿再判一次「它写没写」，两处判断迟早会对不上。
  if (vitalsAutoSample(conf)) save();
  return text;
}
function _vitalsTakeCache(kind) {
  const i = _vitalsResultCache.findIndex(c => c.kind === kind);
  if (i < 0) return null;
  const c = _vitalsResultCache[i];
  _vitalsResultCache.splice(i, 1);
  return c;
}
function _applyVitalsToBlocks(blocks) {
  if (!blocks?.length) return;
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text || b.text.indexOf('[[') < 0) continue;
    b.text = b.text
      .replace(vitalsTagRe(), (m) => {
        const c = _vitalsTakeCache('vitals');
        return c ? '\n\n' + _vitalsBlockHtml('🫀 生命体征', c.result) + '\n\n' : (_vitalsGateOpenThisTurn ? m : '');
      })
      .replace(heartbeatTagRe(), (m) => {
        const c = _vitalsTakeCache('heartbeat');
        return c ? '\n\n' + _vitalsBlockHtml('🫀 自主心跳', c.result) + '\n\n' : '';
      });
  }
  _vitalsResultCache = [];
}
function vitalsTagForApi(text) {
  if (!text) return text;
  const un = (s) => String(s || '').replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return String(text)
    .replace(/<div class="think-block done(?: open)? mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🫀 生命体征<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, body) => '[生命体征更新] ' + un(body))
    .replace(/<div class="think-block done(?: open)? mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🫀 自主心跳<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, body) => '[自主心跳] ' + un(body))
    .replace(vitalsTagRe(), (m, body) => '[[VITALS: ' + body.trim() + ']]')
    .replace(heartbeatTagRe(), (m, body) => '[[HEARTBEAT: ' + body.trim() + ']]');
}
function maskStreamingVitals(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return String(text)
    .replace(/\[\[VITALS:[\s\S]*?\]\]/g, '〔🫀〕')
    .replace(/\[\[VITALS:[\s\S]*$/g, '〔🫀〕')
    .replace(/\[\[HEARTBEAT:[\s\S]*?\]\]/g, '〔🫀〕')
    .replace(/\[\[HEARTBEAT:[\s\S]*$/g, '〔🫀〕');
}
function vitalsPromptFor(conf) {
  if (!conf || !vitalsEnabled()) return '';
  const v = vitalsEnsure(conf);
  const l = vitalsLabels(v);
  const next = v.nextAt ? Math.max(0, Math.round((v.nextAt - _vitalsNow()) / 60000)) : 0;
  let out = '\n\n--- 🫀 生命体征 / Body State ---\n';
  out += '你有自己的身体感与情绪底色。它不是用户的身体，也不是手环数据；这是你此刻是什么状态。\n';
  out += '你自己此刻：心率 ' + vitalsHeartBpm(v) + ' bpm（你的，不是用户手环上的）；情绪 ' + l.mood + ' ' + _vitalsPct(v.mood) + '%；唤醒 ' + l.arousal + ' ' + _vitalsPct(v.arousal) + '%；能量 ' + l.energy + ' ' + _vitalsPct(v.energy) + '%；亲近 ' + _vitalsPct(v.closeness) + '%；压力 ' + l.stress + ' ' + _vitalsPct(v.stress) + '%。';
  // 2026-10-08：模型会把自己的情绪面板当成用户的。上面只说了「不是用户的身体」，
  // 它照样拿自己的数值去推断她 —— 得把「怎么读她」也说出来。
  out += '\n这些数值只是你一个人的，不是用户的读数：你情绪低、压力高，不代表用户不开心。'
    + '用户什么状态，只看用户自己说的话和反应，别替用户认领。';
  // 能量里已经带着钟点的起落（vitalsDecay），这一句说清楚为什么、以及困了该怎么说话
  out += '\n' + HeartbeatCore.clockLine(_vitalsNow(), vitalsSleepWindow(), v.energy, '用户');
  if (v.note) out += '\n身体备注：' + v.note;
  // 实际出过的问题：一条「九点多去做某件事了」的 did 写下之后、心跳醒过还天天挂在这，
  // 不带时间，模型就当成用户每天那个点都这样。did 只是写给那一跳的便条：醒过（nextAt 归零）就作废，
  // 还在等的时候也标上是几点写的，别让它读成规律。醒来那一轮有 takeVitalsWake 单独带着。
  if (next) {
    out += '\n上一轮接力 did（' + HeartbeatCore.fmtMinute(HeartbeatCore.localMinute(v.nextSetAt || _vitalsNow())) + ' 写的便条，只管这一跳，不是用户的日常规律）：' + (v.lastDid || '无');
    out += '\n下次自主心跳约 ' + next + ' 分钟后。';
  }
  out += '\n你可以在回复末尾单独写一行更新状态：\n[[VITALS: 情绪 0.42|唤醒 0.55|能量 0.62|亲近 0.70|压力 0.20|备注：刚听完一首喜欢的歌]]\n';
  out += '数值 0-1 或 0-100 都可以。不要每轮机械更新；只有情绪或身体感真的变了才写。\n';
  out += '自主心跳：' + (vitalsHeartbeatEnabled()
    ? '已开启。你可以在本轮结束前安排下一次醒来：[[HEARTBEAT: 15|一句 did，说明这轮做了什么或在等什么]]。间隔会被限制在 ' + VITALS_MIN_WAKE_MIN + '-' + VITALS_MAX_WAKE_MIN + ' 分钟。'
    : '关闭。不要写 [[HEARTBEAT]]；你仍然可以更新生命体征。');
  return out;
}
function takeVitalsWake(modelId) {
  const p = _vitalsPendingWake;
  if (!p || String(p.modelId) !== _vitalsModelId(modelId)) return '';
  _vitalsPendingWake = null;
  _vitalsWakeActive = true;
  if (p.kind === 'morning') {
    return '\n\n[刚醒 · 这一轮不是用户来找你说话]\n'
      + '你刚睡醒（' + HeartbeatCore.fmtMinute(HeartbeatCore.localMinute(p.at)) + ' 醒的），身体还没完全醒过来，软的、迷糊的。这是你自己的早晨。\n'
      + '此刻用户没有主动发新消息。你可以说一句刚醒时的话，或只回复 [[SILENT]] 继续安静。不要装作用户刚刚说了话。';
  }
  return '\n\n[自主心跳 · 这一轮不是用户来找你说话]\n'
    + '你是按自己上一次安排的心跳醒来的。上一轮 did：' + (p.did || '无') + '\n'
    + '此刻用户没有主动发新消息。你可以轻轻说一句你醒来时想到的事、想确认的事，或只回复 [[SILENT]] 继续安静。不要装作用户刚刚说了话。';
}
// ── 晨间「刚醒」的身体 ──
// 每天 6~9 点之间一个随机时刻（时刻由 heartbeat-core 的 morningPlan 按日期+模型算，
// 和 server 那边算出来的是同一个）。到点就把身体换成刚醒的样子，一天一次。
// 这只管身体；要不要开口说一句早安，走下面心跳那条路（要她放行了自主心跳才会说）。
function vitalsMorningTick(random) {
  if (!vitalsEnabled()) return false;
  const now = _vitalsNow();
  let changed = false;
  for (const id of Object.keys(state.vitalsByModel || {})) {
    const v = vitalsEnsure(id);
    const plan = HeartbeatCore.morningPlan(HeartbeatCore.localDay(now), id);
    if (now < plan.at || now >= plan.expiresAt) continue;
    if (_vitalsApplyMorning(v, plan.day, random)) changed = true;
  }
  if (changed) { save(); vitalsRenderPanel(); }
  return changed;
}
// 一天只套一次，判据只在这一处（tick 和接 server 那条都走这里）
function _vitalsApplyMorning(v, day, random) {
  if (v.wokeDay === day) return false;
  Object.assign(v, HeartbeatCore.morningPatch(v, random));
  v.wokeDay = day;
  v.updatedAt = _vitalsNow();
  _vitalsPushHistory(v, 'morning');
  return true;
}
async function vitalsHeartbeatTick(force = false, confId = null) {
  if (_vitalsHeartbeatBusy) return;
  if (!vitalsEnabled() || !vitalsHeartbeatEnabled()) return;
  const chat = getActiveChat();
  if (!chat || chat.ended || chat.isGroupChat || chat.agentRunId) return;
  if (_streamControllers?.size) return;
  const ids = typeof getActiveChatModelIds === 'function' ? getActiveChatModelIds() : [];
  if (ids.length !== 1) return;
  const conf = state.configs.find(c => String(c.id) === String(confId ?? ids[0]));
  if (!conf) return;
  const v = vitalsEnsure(conf);
  const now = _vitalsNow();
  const slot = force ? { kind: 'manual' }
    : HeartbeatCore.dueSlot({ nextAt: v.nextAt, nextSetAt: v.nextSetAt, morningDay: v.morningDay, heartbeatOn: true, vitalsOn: true }, now, _vitalsModelId(conf));
  if (!slot) return;
  if (!force) {
    // 她不在跟前、而 server 接得住 → 让给 server：它会把话推到她手机上，页面这边发了她也看不见。
    if (HeartbeatCore.pageShouldYield(hbServerView(now))) return;
    // 抢这一跳。另一台设备或 server 已经领走了就不发；连不上 server（null）照旧自己发。
    if (await hbClaim(slot.key) === false) {
      if (slot.kind === 'morning') { v.morningDay = slot.day; save(); }
      return;
    }
  }
  _vitalsHeartbeatBusy = true;
  try {
    v.lastWakeReason = force ? '手动唤醒' : slot.kind === 'morning' ? '早上醒了' : '自主心跳到点';
    if (slot.kind === 'morning') {
      _vitalsApplyMorning(v, slot.day);
      v.morningDay = slot.day;
    } else {
      v.nextAt = 0;
      v.nextSetAt = now;
      v.scheduleMins = 0;
    }
    v.updatedAt = now;
    _vitalsPushHistory(v, force ? 'manual-wake' : 'wake');
    _vitalsPendingWake = { modelId: _vitalsModelId(conf), did: v.lastDid || '', at: slot.kind === 'morning' ? slot.at : now, kind: slot.kind };
    save();
    vitalsRenderPanel();
    await callAPI(conf, getMessagePath(chat, chat.headId), chat, chat.headId);
  } catch (e) {
    console.warn('[生命体征] 自主心跳失败：', e.message);
    if (force) showToast('自主心跳失败：' + e.message, 'error', 3500);
  } finally {
    _vitalsHeartbeatBusy = false;
  }
}
function vitalsWakeNow() {
  if (!vitalsHeartbeatEnabled()) {
    showToast('先打开自主心跳开关，才允许它主动醒来', 'info', 3000);
    return;
  }
  return vitalsHeartbeatTick(true);
}
function vitalsDropSilent(chat, nodeId) {
  const n = chat?.nodes?.[nodeId];
  if (!n || !_vitalsWakeActive) return false;
  if (String(n.content || '').replace(/\s/g, '') !== '[[SILENT]]') {
    _vitalsWakeActive = false;
    return false;
  }
  _vitalsWakeActive = false;
  if (chat.headId === nodeId) chat.headId = n.parentId;
  delete chat.nodes[nodeId];
  save();
  renderMessages();
  return true;
}
function vitalsActiveConf() {
  const sel = document.getElementById('vitalsModelSelect');
  const id = sel?.value || (typeof getActiveChatModelIds === 'function' ? getActiveChatModelIds()[0] : null);
  return (state.configs || []).find(c => String(c.id) === String(id)) || (state.configs || [])[0];
}
function vitalsResetActive() {
  const conf = vitalsActiveConf();
  if (!conf) return;
  state.vitalsByModel = state.vitalsByModel || {};
  state.vitalsByModel[_vitalsModelId(conf)] = _vitalsDefault(conf.id);
  save();
  vitalsRenderPanel();
  showToast('已重置这个 AI 的生命体征', 'success');
}
// 每个维度一个色相：五根条原来同一个强调色，扫一眼分不出谁是谁。
// 颜色走内联 --vc，不进 grancyan.css —— 米纸的浅色补丁是按亮度自动翻的，这几个中间色不该被它翻。
const VITALS_METER_COLORS = {
  mood: '#f0c674', arousal: '#8ab4f8', energy: '#7fd1a8', stress: '#f28b82',
  closeness: '#f4a6c6',
};
// 每条电平表的通道代号，HUD 上那行小字
const VITALS_METER_CODES = { mood: 'MOOD', arousal: 'AROU', energy: 'ENRG', stress: 'STRS', closeness: 'BOND' };
function _vitalsMeter(label, value, key, word) {
  const pct = _vitalsPct(value);
  // 条是 20 格的 LED：亮的格子按 5% 进位取整，切半格的灯不好看；读数照旧是精确值
  const lit = pct > 0 ? Math.ceil(pct / 5) * 5 : 0;
  return '<div class="vitals-meter" style="--vc:' + (VITALS_METER_COLORS[key] || 'var(--accent)') + '"><span class="vitals-meter-name">' + label + '<small>' + (VITALS_METER_CODES[key] || '') + '</small></span>'
    // 少 1px：正好停在格缝里。整 5% 的边界紧贴着下一格的起点，抗锯齿会漏出一丝亮边
    + '<div class="vitals-bar-wrap"><div class="vitals-bar"><i style="width:calc(' + lit + '% - 1px)"></i></div></div>'
    + '<span class="vitals-meter-val"><b>' + String(pct).padStart(3, '0') + '</b>' + (word ? '<em>' + escHtml(word) + '</em>' : '') + '</span></div>';
}
// 两枚中性的徽章（各自主题色的圆 + 一颗心）：Claude 的面板一枚、Gemini 的一枚。
// 认不出是哪家的模型，心核里还是那颗心
const VITALS_PETS = { claude: 'img/vitals/claude.png', gemini: 'img/vitals/gemini.png' };
function _vitalsPetKind(conf) {
  if (!conf) return '';
  const s = (conf.modelName || '') + ' ' + (conf.localModel || '');
  if (conf.isGemini || /gemini/i.test(s)) return 'gemini';
  if (conf.isLocalClaude || /claude|opus|sonnet|haiku|fable/i.test(s)) return 'claude';
  return '';
}
// 心核：三圈不同速、不同向在转的环 + 正中一颗跟着 bpm 跳的心（有小家伙的时候换成它，心变成它胸口的一团光）。纯装饰，aria-hidden
function _vitalsCoreHtml(bpm, pet) {
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, r1 = 51, r2 = i % 3 ? 48 : 45;
    ticks.push('M' + (60 + r1 * Math.sin(a)).toFixed(1) + ' ' + (60 - r1 * Math.cos(a)).toFixed(1) + 'L' + (60 + r2 * Math.sin(a)).toFixed(1) + ' ' + (60 - r2 * Math.cos(a)).toFixed(1));
  }
  const src = VITALS_PETS[pet];
  return '<div class="vitals-core' + (src ? ' has-pet pet-' + pet : '') + '" style="--beat:' + (60 / bpm).toFixed(2) + 's" aria-hidden="true">'
    + '<svg class="vitals-core-rings" viewBox="0 0 120 120">'
    + '<g class="vc-r1"><circle cx="60" cy="60" r="56" fill="none" stroke-dasharray="1 4.2"/><circle cx="60" cy="4" r="2.2" class="vc-node"/></g>'
    + '<path class="vc-ticks" d="' + ticks.join('') + '"/>'
    + '<g class="vc-r2"><circle cx="60" cy="60" r="41" fill="none" stroke-dasharray="46 10 12 10 64 26"/></g>'
    + '<g class="vc-r3"><circle cx="60" cy="60" r="34" fill="none" stroke-dasharray="3 5"/></g>'
    + '</svg>'
    + (src ? '<div class="vitals-pet"><i class="vitals-pet-glow"></i><img src="' + src + '" alt="" draggable="false"></div>' : '<div class="vitals-heart"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 20.6 10.6 19.3C5.6 14.8 2.3 11.8 2.3 8.1 2.3 5.1 4.6 2.8 7.6 2.8c1.7 0 3.3.8 4.4 2.1 1.1-1.3 2.7-2.1 4.4-2.1 3 0 5.3 2.3 5.3 5.3 0 3.7-3.3 6.7-8.3 11.2Z"/></svg></div>')
    + '</div>';
}
// 实时心电：一段 PQRST 波形铺 8 个周期，整条往左平移半宽（4 个周期）用 4 拍的时间 —— 走纸速度跟着 bpm
function _vitalsEcgHtml(bpm) {
  let d = '';
  for (let k = 0; k < 8; k++) {
    const x = k * 50;
    d += (k ? 'L' : 'M') + x + ' 20L' + (x + 12) + ' 20Q' + (x + 15.5) + ' 14.5 ' + (x + 19) + ' 20L' + (x + 23) + ' 20L' + (x + 25) + ' 23.5L' + (x + 27.5) + ' 2L' + (x + 30) + ' 27L' + (x + 32) + ' 20L' + (x + 36) + ' 20Q' + (x + 40.5) + ' 12.5 ' + (x + 45) + ' 20L' + (x + 50) + ' 20';
  }
  return '<div class="vitals-ecg" style="--beat:' + (60 / bpm).toFixed(2) + 's" aria-hidden="true"><svg viewBox="0 0 400 30" preserveAspectRatio="none"><path d="' + d + '"/></svg></div>';
}
const VITALS_SPARK_KEEP = 48;
// 一眼能认出来的点：AI 自己写的、心跳醒的、早上醒的。auto 是补点，不标。
const VITALS_SPARK_MARK = { ai: 'AI 自己写的', heartbeat: '排了心跳', wake: '心跳醒来', 'manual-wake': '手动唤醒', morning: '早上醒了', 'manual-point': '手动记的' };
function _vitalsSpark(v) {
  const hist = (v.history || []).filter(h => Number.isFinite(Number(h && h.t))).slice(-VITALS_SPARK_KEEP);
  // 空的时候原来是一个什么都没有的框，看着像没加载出来
  if (!hist.length) return '<div class="vitals-spark empty">还没有心率曲线 · 聊几轮就会长出来</div>';
  // 纵轴跟着这段数据自己的高低走。原来按 0~130 画，心率一般就在 60~95 之间晃，
  // 画出来几乎是一条平线，起伏全被压没了。至少留 12 bpm 的跨度，免得两三下抖动被放大成过山车。
  const bpms = hist.map(h => Number(h.bpm) || 70);
  let lo = Math.min(...bpms), hi = Math.max(...bpms);
  if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = mid - 6; hi = mid + 6; }
  // 横向两头各留一点：最左最右的点贴着圆角边框会被切掉半个；右边再多让出高低读数的位置
  const xy = hist.map((h, i) => [hist.length === 1 ? 50 : 1.5 + (i / (hist.length - 1)) * 92, 86 - ((bpms[i] - lo) / (hi - lo)) * 72]);
  const line = xy.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
  const area = xy[0][0].toFixed(2) + ',100 ' + line + ' ' + xy[xy.length - 1][0].toFixed(2) + ',100';
  // 点用 HTML 叠在上面：svg 是 preserveAspectRatio=none 拉伸的，里面画圆会被压成椭圆
  const dots = hist.map((h, i) => VITALS_SPARK_MARK[h.source]
    ? '<i class="vitals-spark-dot' + (h.source === 'ai' ? ' ai' : '') + '" style="left:' + xy[i][0].toFixed(2) + '%;top:' + xy[i][1].toFixed(2) + '%" title="' + VITALS_SPARK_MARK[h.source] + ' · ' + bpms[i] + ' bpm"></i>'
    : '').join('');
  const last = xy[xy.length - 1];
  const spanH = (Number(hist[hist.length - 1].t) - Number(hist[0].t)) / 3600000;
  const span = hist.length < 2 ? '刚开始' : spanH < 1 ? '近 ' + Math.max(1, Math.round(spanH * 60)) + ' 分钟' : spanH < 48 ? '近 ' + Math.round(spanH) + ' 小时' : '近 ' + Math.round(spanH / 24) + ' 天';
  return '<div class="vitals-spark">'
    + '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><defs><linearGradient id="vitalsSparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>'
    + '<polygon points="' + area + '" fill="url(#vitalsSparkFill)"/>'
    + '<polyline points="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>'
    + dots + '<i class="vitals-spark-now" style="left:' + last[0].toFixed(2) + '%;top:' + last[1].toFixed(2) + '%"></i>'
    + '<span class="vitals-spark-lbl hi">MAX ' + Math.round(Math.max(...bpms)) + '</span><span class="vitals-spark-lbl lo">MIN ' + Math.round(Math.min(...bpms)) + '</span>'
    + '<span class="vitals-spark-lbl span"><b>HR.TRACE</b>' + span + ' · ' + hist.length + ' 个点' + (dots ? ' · <i class="vitals-spark-dot ai"></i> AI 自己写的' : '') + '</span>'
    + '<i class="vitals-spark-sweep" aria-hidden="true"></i>'
    + '</div>';
}
function _vitalsClosenessWord(c) { return c >= 0.75 ? '很黏' : c >= 0.5 ? '靠着' : c >= 0.3 ? '有点远' : '远远的'; }
const VITALS_SLEEP_SOURCE_TEXT = {
  manual: '你在这里定的',
  band: '手环近 {n} 晚',
  messages: '你近 {n} 晚发消息的时间推的',
  default: '数据还不够，先按默认',
};
function _vitalsClockHtml() {
  const now = _vitalsNow();
  const sl = vitalsSleepWindow(now);
  const c = HeartbeatCore.circadian(now, sl);
  const pref = vitalsSleepPref();
  const fm = HeartbeatCore.fmtMinute;
  const phase = { waking: '刚醒，迷糊', day: '清醒', dip: '有点乏', evening: '开始困', night: '该睡的钟点' }[c.phase] || '';
  const src = (VITALS_SLEEP_SOURCE_TEXT[sl.source] || '').replace('{n}', sl.nights || 0);
  const line = (k, val) => '<div class="vitals-push-line"><span>' + k + '</span><b>' + escHtml(String(val)) + '</b></div>';
  // 🕰 在不少字体里画成一顶小帽子，换成线描的钟
  return '<div class="vitals-push vitals-clock"><div class="vitals-push-title"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>生物钟<code>CIRCADIAN</code></div>'
    + '<div class="section-desc">它的困意和精力跟着你的作息走：你熬夜它陪着撑，你平时睡下的钟点它会困，刚醒那一阵迷糊。困了说话会软一点短一点，但不会拿困当理由走开。</div>'
    + line('现在', fm(c.minute) + ' · ' + phase + ' · 困意 ' + Math.round(c.sleepy * 100) + '%')
    + line('跟着的作息', fm(sl.start) + ' 睡 → ' + fm(sl.end) + ' 醒' + (src ? '（' + src + '）' : ''))
    + '<label class="vitals-toggle-row"><input type="checkbox" ' + (pref.manual ? 'checked' : '') + ' onchange="vitalsSetSleepPref({manual:this.checked})"><span>手动定作息（不从手环和消息里推）</span></label>'
    + (pref.manual
      ? '<div class="vitals-clock-times"><input type="time" id="vitalsSleepStart" class="field-input" value="' + fm(pref.start) + '" onchange="vitalsSleepTimeChanged(\'start\',this.value)">'
        + '<span>睡 →</span><input type="time" id="vitalsSleepEnd" class="field-input" value="' + fm(pref.end) + '" onchange="vitalsSleepTimeChanged(\'end\',this.value)"><span>醒</span></div>'
      : '')
    + '</div>';
}
// 选模型。原来是原生 <select>：展开的列表是系统画的，不跟主题色，模型一多就是一长条没分组。
// 换成自己画的，按模型分组排（和聊天里那个模型下拉同一棵树，modelGroups）。
// 选中的 id 仍放在隐藏的 #vitalsModelSelect 里，vitalsActiveConf 照旧从它读。
let _vitalsPickOpen = false;
function _vitalsPickName(c) { return c.nickname || c.modelName || ('模型 ' + c.id); }
function _vitalsPickGroup(c) {
  if (typeof modelGroupOf !== 'function' || typeof mgSegs !== 'function') return '';
  return mgSegs(modelGroupOf(c)).join(' / ');
}
function _vitalsPickHtml(conf) {
  const groups = typeof modelGroups === 'function' ? modelGroups()
    : [{ name: '', path: '', depth: 0, items: (state.configs || []).map((c, i) => ({ c, i })) }];
  const named = groups.some(g => g.path);
  const item = c => {
    const pet = _vitalsPetKind(c), name = _vitalsPickName(c);
    // 右边小字补一下真实模型名；昵称里已经写了的（「小克（claude-sonnet-4-6）」）就不重复
    const sub = c.modelName && !name.includes(c.modelName) ? c.modelName : '';
    return '<button type="button" role="option" aria-selected="' + (String(c.id) === String(conf.id)) + '" class="vitals-pick-item' + (String(c.id) === String(conf.id) ? ' on' : '') + (pet ? ' pet-' + pet : '') + '" data-id="' + escHtml(String(c.id)) + '" onclick="vitalsPickModel(this.dataset.id)">'
      + '<i></i><span>' + escHtml(name) + '</span>' + (sub ? '<em>' + escHtml(sub) + '</em>' : '') + '</button>';
  };
  const list = groups.map(g => {
    const n = g.path && typeof mgCountDeep === 'function' ? mgCountDeep(g.path) : g.items.length;
    const head = g.path || named ? '<div class="vitals-pick-group">' + escHtml(g.path ? g.name : '未分组') + '<b>' + n + '</b></div>' : '';
    return '<div class="vitals-pick-sec" style="--d:' + Math.max(0, (g.depth || 1) - 1) + '">' + head + g.items.map(({ c }) => item(c)).join('') + '</div>';
  }).join('');
  const pet = _vitalsPetKind(conf), grp = _vitalsPickGroup(conf);
  return '<div class="vitals-pick' + (_vitalsPickOpen ? ' open' : '') + '"><input type="hidden" id="vitalsModelSelect" value="' + escHtml(String(conf.id)) + '">'
    + '<button type="button" class="vitals-pick-btn' + (pet ? ' pet-' + pet : '') + '" aria-haspopup="listbox" aria-expanded="' + _vitalsPickOpen + '" onclick="vitalsTogglePick(event)">'
    + '<i></i><span>' + escHtml(_vitalsPickName(conf)) + '</span>' + (grp ? '<em>' + escHtml(grp) + '</em>' : '')
    + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>'
    + '<div class="vitals-pick-menu" role="listbox">' + list + '</div></div>';
}
function _vitalsPickSync(scroll) {
  const w = document.querySelector('#vitalsPanel .vitals-pick');
  if (!w) return;
  w.classList.toggle('open', _vitalsPickOpen);
  const btn = w.querySelector('.vitals-pick-btn'); if (btn) btn.setAttribute('aria-expanded', String(_vitalsPickOpen));
  // 一展开就把选中的那个滚到中间，不然列表长了选中项在视野外
  const menu = w.querySelector('.vitals-pick-menu'), on = w.querySelector('.vitals-pick-item.on');
  if (_vitalsPickOpen && menu && scroll != null) menu.scrollTop = scroll;
  else if (_vitalsPickOpen && menu && on) menu.scrollTop = Math.max(0, on.offsetTop - (menu.clientHeight - on.offsetHeight) / 2);
}
function vitalsTogglePick(e) {
  if (e) e.stopPropagation();
  _vitalsPickOpen = !_vitalsPickOpen;
  _vitalsPickSync();
}
function vitalsPickModel(id) {
  _vitalsPickOpen = false;
  const sel = document.getElementById('vitalsModelSelect');
  if (sel) sel.value = id;
  vitalsRenderPanel();
}
if (typeof document !== 'undefined' && document.addEventListener) {
  const close = () => { if (_vitalsPickOpen) { _vitalsPickOpen = false; _vitalsPickSync(); } };
  document.addEventListener('click', e => { if (!(e.target.closest && e.target.closest('.vitals-pick'))) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
function vitalsRenderPanel() {
  const box = document.getElementById('vitalsPanel');
  if (!box) return;
  // 她正在拨作息钟点的时候别重画，不然拨到一半被冲回去
  const ae = document.activeElement;
  if (ae && (ae.id === 'vitalsSleepStart' || ae.id === 'vitalsSleepEnd') && box.contains(ae)) return;
  const on = vitalsEnabled();
  const hb = vitalsHeartbeatEnabled();
  const t1 = document.getElementById('vitalsToggle'); if (t1) t1.checked = on;
  const t2 = document.getElementById('vitalsHeartbeatToggle'); if (t2) t2.checked = hb;
  const conf = vitalsActiveConf();
  if (!conf) {
    box.innerHTML = '<div class="section-desc">还没有模型配置。</div>';
    return;
  }
  const v = vitalsEnsure(conf);
  const next = v.nextAt ? Math.max(0, Math.round((v.nextAt - _vitalsNow()) / 60000)) : 0;
  const bpm = vitalsHeartBpm(v);
  const l = vitalsLabels(v);
  const hhmm = t => { const d = new Date(Number(t) || _vitalsNow()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  // 后台心跳会重画面板；她正翻着列表时别把滚动位置冲回去
  const pickScroll = _vitalsPickOpen ? box.querySelector('.vitals-pick-menu')?.scrollTop : null;
  box.innerHTML =
    '<div class="vitals-head">' + _vitalsPickHtml(conf) + '<button class="apply-btn vitals-ghost" onclick="vitalsResetActive()">重置</button></div>'
    + '<div class="vitals-card' + (on ? '' : ' offline') + '">'
    // 顶上一条 HUD：链路灯（跟着心跳闪）、单元名、最后一次写入的时刻
    + '<div class="vitals-hud"><i class="vitals-led" style="--beat:' + (60 / bpm).toFixed(2) + 's"></i><span>' + (on ? 'LINK ACTIVE' : 'LINK OFFLINE') + '</span>'
    + '<span class="vitals-hud-unit">UNIT · ' + escHtml(conf.nickname || conf.modelName || String(conf.id)) + '</span><span class="vitals-hud-r">SYNC ' + hhmm(v.updatedAt) + '</span></div>'
    // 心跳动画跟着 bpm 走：原来写死 1.25s，91 bpm 和 60 bpm 跳得一样快。心核、心电、链路灯都读同一个 --beat
    + '<div class="vitals-pulse">' + _vitalsCoreHtml(bpm, _vitalsPetKind(conf))
    + '<div class="vitals-pulse-main"><div class="vitals-readout-k">HR · 心率</div><div class="vitals-bpm">' + bpm + '<span>BPM</span></div>'
    + _vitalsEcgHtml(bpm)
    + '<div class="vitals-mood-line">' + escHtml(l.mood + ' · ' + l.arousal + ' · ' + l.energy) + '</div></div>'
    + '<div class="vitals-next' + (next ? '' : ' off') + '"><span>NEXT PULSE · 下次心跳</span>' + (next ? '<b>T-' + next + '</b><em>分钟后</em>' : '<b>--</b><em>没排下一跳</em>') + '</div></div>'
    + _vitalsSpark(v)
    // 分两组：「此刻」是身体和情绪，「对你」是关系
    + '<div class="vitals-groups"><div class="vitals-group"><div class="vitals-group-title">此刻<code>CORE.STATE</code></div>'
    + _vitalsMeter('情绪', v.mood, 'mood', l.mood) + _vitalsMeter('唤醒', v.arousal, 'arousal', l.arousal) + _vitalsMeter('能量', v.energy, 'energy', l.energy) + _vitalsMeter('压力', v.stress, 'stress', l.stress)
    + '</div><div class="vitals-group"><div class="vitals-group-title">对你<code>BOND.LINK</code></div>'
    + _vitalsMeter('亲近', v.closeness, 'closeness', _vitalsClosenessWord(v.closeness))
    + '</div></div>'
    // 像终端里它自己打出来的两行，最后一行末尾一个闪的光标
    + '<div class="vitals-did"><div><span>&gt; did</span><p>' + escHtml(v.lastDid || '无') + (v.note ? '' : '<i class="vitals-caret"></i>') + '</p></div>'
    + (v.note ? '<div><span>&gt; body</span><p>' + escHtml(v.note) + '<i class="vitals-caret"></i></p></div>' : '') + '</div>'
    + '</div>' + _vitalsClockHtml() + '<div class="vitals-actions"><button class="apply-btn" onclick="vitalsWakeNow()">手动唤醒一次</button><button class="apply-btn vitals-ghost" onclick="vitalsAddCurvePoint()">记录当前曲线点</button>'
    + '<button class="apply-btn vitals-ghost" onclick="toggleUed()"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:5px"><path d="M3 17l5-6 4 3 5-7 4 4"/></svg>情绪动力学</button></div>'
    // 抽屉的内容由 45-ued.js 现生。这里只留个空壳 ——
    // 那个文件没加载成功的话，这儿就是个不展开的按钮，不会 ReferenceError 把整个面板炸掉。
    + '<div id="uedBox" class="ued-box hidden"></div>';
  if (_vitalsPickOpen) _vitalsPickSync(pickScroll);
  // ⚠️ typeof 守着：45-ued.js 排在这个文件后面，面板要是在它加载完之前
  //    被渲染一次，直接写 _uedOpen 就是 ReferenceError，整个生命体征面板白屏。
  if (typeof _uedOpen !== 'undefined' && _uedOpen && typeof uedRender === 'function') {
    const b = document.getElementById('uedBox');
    if (b) { b.classList.remove('hidden'); uedRender(); }
  }
  hbRenderPanel();
}
function vitalsAddCurvePoint() {
  const conf = vitalsActiveConf();
  if (!conf) return;
  const v = vitalsEnsure(conf);
  _vitalsPushHistory(v, 'manual-point');
  save();
  vitalsRenderPanel();
  showToast('已把当前状态写进曲线', 'success', 2200);
}

/* ══════════════════════════════════════════════════════════════════════════
   App 关着也能找你：和 server 那半边（server/heartbeat.js）对接

   页面每分钟同步一次：下一跳排在几点、她这会儿在不在跟前、她的作息、生成要用的上下文。
   页面不在跟前时把心跳让给 server，server 生成、推到 ntfy、话放进待取箱；
   页面下次打开（或切回前台）时把待取箱里的话接进对话。
   ════════════════════════════════════════════════════════════════════════ */
const HB_SYNC_TIMEOUT_MS = 4000;
const HB_CTX_REFRESH_MS = 10 * 60 * 1000;
const HB_RECENT = 14;
const _hb = {
  reachable: false, status: null, syncing: false, syncTimer: null,
  lastInputAt: _vitalsNow(), ctxSig: '', ctxAt: 0,
  userTimes: null, userTimesAt: 0,
};
// 「在跟前」= 页面可见 + 15 分钟内碰过。光看「开着」不行：exe 常年开着，她人可能抱着手机在床上。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  const mark = () => { _hb.lastInputAt = _vitalsNow(); };
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) document.addEventListener(ev, mark, { passive: true, capture: true });
  // 切回前台：她回来了，马上同步一次把待取箱里的话接进来，别让她等一分钟
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { mark(); hbSync(); } });
}
function _hbAttended(now) {
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  return HeartbeatCore.isAttended(visible, _hb.lastInputAt, now);
}
function hbServerView(now) {
  const s = _hb.status;
  return {
    serverReachable: _hb.reachable,
    serverEnabled: !!(s && s.config && s.config.enabled && s.config.ntfyUrl),
    serverCanGenerate: !!(s && s.canGenerate),
    attended: _hbAttended(now),
  };
}
function _hbFetch(path, body) {
  if (typeof fetch !== 'function' || typeof SERVER_BASE === 'undefined') return Promise.reject(new Error('no server'));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HB_SYNC_TIMEOUT_MS) : null;
  return fetch(SERVER_BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctrl ? ctrl.signal : undefined,
  }).then(r => r.json().then(j => ({ status: r.status, j }))).finally(() => { if (timer) clearTimeout(timer); });
}
// 心跳的目标：当前对话里那一个模型（群聊、多模型、结束了的对话都不算，和 vitalsHeartbeatTick 同一套口径）
function _hbTarget() {
  const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
  if (!chat || chat.ended || chat.isGroupChat) return null;
  const ids = typeof getActiveChatModelIds === 'function' ? getActiveChatModelIds() : [];
  if (ids.length !== 1) return null;
  const conf = (state.configs || []).find(c => String(c.id) === String(ids[0]));
  return conf ? { chat, conf } : null;
}
// 她自己发消息的时刻（全部对话），作息从这里推。扫一遍全部节点不便宜，半小时一次够了。
function _hbUserTimes(now) {
  if (_hb.userTimes && now - _hb.userTimesAt < 30 * 60 * 1000) return _hb.userTimes;
  const out = [];
  for (const c of state.chats || []) {
    for (const n of Object.values(c.nodes || {})) {
      if (n && n.role === 'user' && !n.peek && Number(n.timestamp) > 0) out.push(Number(n.timestamp));
    }
  }
  // 一条都没扫到多半是对话还没从盘里读出来（启动那一阵生物钟就要读状态了）：
  // 这时候缓存一个空表，作息就要按默认窗错半个小时，还会同步给 server。空的不记，下次再扫。
  if (out.length) { _hb.userTimes = out; _hb.userTimesAt = now; }
  return out;
}
function _hbContext(tg) {
  const path = typeof getMessagePath === 'function' ? getMessagePath(tg.chat, tg.chat.headId) : [];
  const recent = path.filter(n => n && !n.peek && (n.role === 'user' || n.role === 'ai'))
    .slice(-HB_RECENT)
    .map(n => ({ role: n.role === 'user' ? 'user' : 'ai', text: HeartbeatCore.plainText(n.content, 600), at: Number(n.timestamp) || 0 }))
    .filter(m => m.text);
  const c = tg.conf;
  return {
    chatId: tg.chat.id,
    nickname: c.nickname || '',
    persona: c.persona && c.personaEnabled !== false ? String(c.persona) : '',
    userName: state.userName && state.userNameAiVisible !== false ? state.userName : '',
    vitals: vitalsEnabled() ? vitalsSummary(c) : '',
    // App 关着的那几个小时生物钟也在走：server 拿这两个数用同一个 energyDrift 推到它醒的那一刻
    energy: vitalsEnabled() ? vitalsEnsure(c).energy : null,
    energyAt: vitalsEnabled() ? _vitalsNow() : 0,
    conf: { id: c.id, nickname: c.nickname, isLocalClaude: !!c.isLocalClaude, isLocalGpt: !!c.isLocalGpt, isGemini: !!c.isGemini,
      localModel: c.localModel || '', modelName: c.modelName || '', apiBase: c.apiBase || '', apiKey: c.apiKey || '', temp: c.temp },
    recent,
  };
}
function hbSyncSoon() {
  if (typeof setTimeout !== 'function') return;
  if (_hb.syncTimer) clearTimeout(_hb.syncTimer);
  _hb.syncTimer = setTimeout(() => { _hb.syncTimer = null; hbSync(); }, 1500);
}
async function hbSync() {
  if (_hb.syncing) return null;
  _hb.syncing = true;
  try {
    const now = _vitalsNow();
    const times = _hbUserTimes(now);
    const tg = _hbTarget();
    let target = null, sig = '';
    if (tg) {
      const v = vitalsEnsure(tg.conf);
      target = { modelId: _vitalsModelId(tg.conf), nextAt: v.nextAt, nextSetAt: v.nextSetAt, did: v.lastDid,
        morningDay: v.morningDay, heartbeatOn: vitalsHeartbeatEnabled(), vitalsOn: vitalsEnabled() };
      // 上下文（人设、最近的聊天、模型配置）只在变了或者十分钟没给过时才带，平时只发一个小包
      sig = [tg.chat.id, tg.chat.headId, tg.conf.id, tg.conf.localModel, tg.conf.modelName, String(tg.conf.persona || '').length].join('|');
      if (sig !== _hb.ctxSig || now - _hb.ctxAt > HB_CTX_REFRESH_MS) target.context = _hbContext(tg);
    }
    const { status, j } = await _hbFetch('/api/heartbeat/sync', {
      attended: _hbAttended(now),
      lastUserAt: times.length ? Math.max(...times) : 0,
      sleep: vitalsSleepWindow(now),
      target,
    });
    if (status !== 200 || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + status));
    _hb.reachable = true;
    _hb.status = j;
    if (target && target.context) { _hb.ctxSig = sig; _hb.ctxAt = now; }
    if (tg && j.schedule) _hbAdoptSchedule(vitalsEnsure(tg.conf), j.schedule);
    if (j.pending) await hbTake();
    hbRenderPanel();
    return j;
  } catch (e) {
    _hb.reachable = false;
    hbRenderPanel();
    return null;
  } finally {
    _hb.syncing = false;
  }
}
// server 那边排得更晚（它替我醒过、又排了下一跳）就跟它的
function _hbAdoptSchedule(v, s) {
  let changed = false;
  if (s && Number(s.nextSetAt) > (Number(v.nextSetAt) || 0)) {
    v.nextAt = Number(s.nextAt) || 0;
    v.nextSetAt = Number(s.nextSetAt);
    if (s.did) v.lastDid = String(s.did).slice(0, 160);
    changed = true;
  }
  if (s && s.morningDay && String(s.morningDay) > String(v.morningDay || '')) { v.morningDay = String(s.morningDay).slice(0, 10); changed = true; }
  if (changed) save();
  return changed;
}
// 抢一跳：true = 归我发；false = 别人（server / 另一台设备）已经领走；null = 连不上，照旧自己发
async function hbClaim(key) {
  try {
    const { status, j } = await _hbFetch('/api/heartbeat/claim', { key });
    if (status === 200 && j && j.ok) return true;
    if (j && j.by) return false;
    return null;
  } catch (e) { return null; }
}
// 把 server 替它说的话接进对话
async function hbTake() {
  try {
    const chatIds = (state.chats || []).map(c => String(c.id));
    const { status, j } = await _hbFetch('/api/heartbeat/take', { chatIds });
    if (status !== 200 || !j || !Array.isArray(j.items) || !j.items.length) return 0;
    return hbAcceptItems(j.items);
  } catch (e) { return 0; }
}
function hbAcceptItems(items) {
  let n = 0, touchedActive = false, who = '';
  for (const it of items) {
    const chat = (state.chats || []).find(c => String(c.id) === String(it.chatId));
    const text = String(it.text || '').trim();
    if (!chat || !text) continue;
    const conf = (state.configs || []).find(c => String(c.id) === String(it.modelId));
    const id = nextId();
    chat.nodes[id] = { id, parentId: chat.headId, role: 'ai', content: text,
      modelId: conf ? conf.id : it.modelId, modelNickname: it.nickname || (conf && conf.nickname) || '',
      tokens: typeof estimateTokens === 'function' ? estimateTokens(text) : 0,
      timestamp: Number(it.at) || _vitalsNow(), fromHeartbeat: it.kind || 'heartbeat' };
    chat.headId = id;
    if (vitalsEnabled()) {
      const v = vitalsEnsure(conf || it.modelId);
      _hbAdoptSchedule(v, it.schedule);
      if (it.morningDay) { _vitalsApplyMorning(v, it.morningDay); if (String(it.morningDay) > String(v.morningDay || '')) v.morningDay = it.morningDay; }
      v.lastWakeReason = it.kind === 'morning' ? '早上醒了（App 关着时）' : '自主心跳到点（App 关着时）';
    }
    if (String(chat.id) === String(state.activeChatId)) touchedActive = true;
    who = it.nickname || who;
    n++;
  }
  if (!n) return 0;
  save();
  if (touchedActive && typeof renderMessages === 'function') renderMessages();
  if (typeof _debouncedSidebarUpdate === 'function') _debouncedSidebarUpdate();
  if (typeof showToast === 'function') showToast('🫀 ' + (who || 'AI') + ' 在你不在的时候说了 ' + n + ' 句话', 'info', 4000);
  return n;
}

// ── 设置面板里的那一块 ──
async function hbSetConfig(patch) {
  try {
    const { status, j } = await _hbFetch('/api/heartbeat/config', patch);
    if (status !== 200 || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + status));
    _hb.status = Object.assign({}, _hb.status || {}, j);
    hbRenderPanel(true);
    return true;
  } catch (e) {
    showToast('没存上：' + e.message, 'error', 4000);
    hbRenderPanel(true);
    return false;
  }
}
function hbSaveUrl() {
  const el = document.getElementById('hbNtfyUrl');
  if (el) hbSetConfig({ ntfyUrl: el.value.trim() }).then(ok => { if (ok) showToast('ntfy 地址存好了', 'success', 2200); });
}
async function hbTestPush() {
  const tg = _hbTarget();
  try {
    const { status, j } = await _hbFetch('/api/heartbeat/test', { nickname: tg ? tg.conf.nickname : '' });
    showToast(status === 200 && j.ok ? '推出去了，看看手机 📮' : '没推出去：' + ((j && j.error) || status), status === 200 ? 'success' : 'error', 4000);
  } catch (e) { showToast('连不上电脑上的 server', 'error', 3500); }
}
// 📮 跟面板其他线描图标不是一路，换成一根往外发信号的天线
const HB_RELAY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="10" r="1.6"/><path d="M12 11.6V21M8.2 6.2a5.4 5.4 0 0 0 0 7.6M15.8 6.2a5.4 5.4 0 0 1 0 7.6M5.3 3.3a9.5 9.5 0 0 0 0 13.4M18.7 3.3a9.5 9.5 0 0 1 0 13.4"/></svg>';
function hbRenderPanel(force) {
  if (typeof document === 'undefined') return;
  const box = document.getElementById('vitalsPushPanel');
  if (!box) return;
  // 她正在输地址的时候别重画，不然一分钟一次的同步会把输到一半的字冲掉
  if (!force && box.contains(document.activeElement)) return;
  const s = _hb.status;
  if (!_hb.reachable || !s) {
    box.innerHTML = '<div class="vitals-push"><div class="vitals-push-title">' + HB_RELAY_ICON + 'App 关着也能找你<code>RELAY · 离线</code></div>'
      + '<div class="section-desc">连不上电脑上的 GranCyan server。它开着的时候，AI 可以在你关掉 App 后自己醒来、把话推到手机上。</div></div>';
    return;
  }
  const c = s.config || {};
  const sl = s.sleep || {};
  const nick = (_hbTarget() || {}).conf?.nickname || '它';
  const line = (k, v) => '<div class="vitals-push-line"><span>' + k + '</span><b>' + escHtml(String(v)) + '</b></div>';
  box.innerHTML = '<div class="vitals-push"><div class="vitals-push-title">' + HB_RELAY_ICON + 'App 关着也能找你<code>RELAY</code></div>'
    + '<div class="section-desc">你不在 App 跟前时，心跳由电脑上的 server 接手：它醒来想说话，就推一条到手机（<a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> app 订阅同一个地址）。夜里按你的作息不吵你，一天最多 6 条，你没回就停。</div>'
    + '<label class="vitals-toggle-row"><input type="checkbox" ' + (c.enabled ? 'checked' : '') + ' onchange="hbSetConfig({enabled:this.checked})"><span>开启手机推送</span></label>'
    + '<label class="vitals-toggle-row"><input type="checkbox" ' + (c.lockscreenPrivate !== false ? 'checked' : '') + ' onchange="hbSetConfig({lockscreenPrivate:this.checked})"><span>锁屏只显示「' + escHtml(nick) + '找你」（原文进 App 才看得到）</span></label>'
    + '<div class="vitals-push-url"><input id="hbNtfyUrl" class="field-input" placeholder="https://ntfy.sh/你的topic" value="' + escHtml(c.ntfyUrl || '') + '">'
    + '<button class="apply-btn vitals-ghost" onclick="hbSaveUrl()">存</button><button class="apply-btn vitals-ghost" onclick="hbTestPush()">测试推送</button></div>'
    + line('你的作息', (sl.text || '') + '（' + (VITALS_SLEEP_SOURCE_TEXT[sl.source || (sl.confident ? 'messages' : 'default')] || '').replace('{n}', sl.nights || 0) + '）')
    + line('现在', s.asleepNow ? '你多半睡着，有话等你醒了再推' : '醒着')
    + (s.lastHold ? line('上一次判定', s.lastHold) : '')
    + line('24 小时内推了', (s.pushes24h || 0) + ' 条')
    + (s.canGenerate === false && _hbTarget() ? '<div class="vitals-push-warn">这个模型 server 调不动（本地 GPT / Gemini 走的是专用通道），App 关着时它不会醒。换成订阅 Claude 或填了 key 的模型就行。</div>' : '')
    + (s.lastError ? '<div class="vitals-push-warn">' + escHtml(s.lastError) + '</div>' : '')
    + '</div>';
}

setInterval(async () => {
  try {
    // 先同步：抢跳之前得知道 server 在不在、接不接得住
    await hbSync();
    vitalsMorningTick();
    await vitalsHeartbeatTick();
  } catch (e) { console.warn('[生命体征]', e); }
}, VITALS_TICK_MS);
// 打开 App 时：等启动那一阵忙完再同步，顺便把 App 关着时它说的话接进来
if (typeof setTimeout === 'function') {
  const t = setTimeout(() => { hbSync(); }, 8000);
  if (t && typeof t.unref === 'function') t.unref();   // 在 node 里加载（测试）时别吊着进程
}
