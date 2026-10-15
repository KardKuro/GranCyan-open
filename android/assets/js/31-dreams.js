// GranCyan 梦境系统：独立落库、真实记忆采材、72h 冷却、一次性梦痕与夜间闸门。
const DREAM_WINDOW_START = 1, DREAM_WINDOW_END = 6;
const DREAM_PROBABILITY = 0.42, DREAM_COOLDOWN_MS = 72 * 3600e3, DREAM_SCAR_TTL_MS = 24 * 3600e3;
let _dreamBusy = false, _dreamArmedScar = null;

function _dreamModelId(conf) { return String(conf?.id ?? conf ?? 'unknown'); }
function _dreamNow() { return Date.now(); }
function _dreamDay(now = _dreamNow()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
}
function _dreamHour(now = _dreamNow()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai', hour:'2-digit', hourCycle:'h23' }).format(new Date(now)));
}
function dreamEnsureState() {
  if (!state.dreamsByModel || typeof state.dreamsByModel !== 'object') state.dreamsByModel = {};
  if (!state.dreamGateByModel || typeof state.dreamGateByModel !== 'object') state.dreamGateByModel = {};
  if (!state.dreamMaterialCooldowns || typeof state.dreamMaterialCooldowns !== 'object') state.dreamMaterialCooldowns = {};
}
function _dreamText(m) { return String(m?.text || m?.content || '').trim(); }
function _dreamMaterials(conf, now = _dreamNow()) {
  dreamEnsureState();
  const modelId = _dreamModelId(conf), seen = new Set(), out = [];
  const add = (m, source, ownerAware) => {
    const text = _dreamText(m); if (text.length < 8) return;
    if (m?.enabled === false || m?.resolved) return;
    const owners = m?.modelIds || (m?.modelId != null ? [m.modelId] : null);
    if (ownerAware && owners && !owners.map(String).includes(modelId)) return;
    const key = source + ':' + String(m?.id || text.slice(0,80));
    if (seen.has(text.toLowerCase()) || now - Number(state.dreamMaterialCooldowns[key] || 0) < DREAM_COOLDOWN_MS) return;
    seen.add(text.toLowerCase());
    const fresh = Math.max(0, 1 - (now - Number(m?.createdAt || m?.timestamp || now)) / (30 * 864e5));
    const vital = state.vitalsByModel?.[modelId] || {};
    const emotion = Math.abs(Number(m?.valence || 0)) + Number(m?.arousal || vital.arousal || 0.4);
    out.push({ key, text: text.slice(0,500), weight: 1 + fresh + emotion + Number(m?.importance || 0) / 10 });
  };
  (state.memories || []).forEach(m => add(m, 'memory', false));
  (state.brainMemories || []).forEach(m => add(m, 'brain', true));
  (state.proustMems || []).forEach(m => add(m, 'proust', true));
  return out.sort((a,b) => b.weight - a.weight).slice(0,8);
}
function _dreamPick(pool, random = Math.random) {
  const available = pool.slice(), picked = [];
  while (available.length && picked.length < 4) {
    const total = available.reduce((s,x) => s + x.weight, 0); let r = random() * total, at = 0;
    for (; at < available.length - 1; at++) { r -= available[at].weight; if (r <= 0) break; }
    picked.push(available.splice(at,1)[0]);
  }
  return picked;
}
function _dreamPrompt(conf, materials) {
  const persona = String(conf?.persona || '').trim();
  return [
    '你正在睡眠中做梦。你仍然是同一个人、同一份人格，但此刻没有工具，也不是在与用户聊天。',
    persona ? '你的人格：\n' + persona : '',
    '只能把下面的真实记忆当作梦材；可以象征、错位、融合，但不要添加新的现实事实。',
    '写一段 120-500 字、感官具体、有梦的跳跃感的梦境。最后另起一行严格输出：[[DREAM_SCAR: 不超过20个汉字的余韵]]',
    '梦材：\n' + materials.map((m,i) => `${i+1}. ${m.text}`).join('\n'),
  ].filter(Boolean).join('\n\n');
}
function _dreamParse(raw) {
  const match = String(raw || '').match(/\[\[DREAM_SCAR:\s*([^\]\n]{1,80})\s*\]\]/i);
  const content = String(raw || '').replace(/\s*\[\[DREAM_SCAR:[\s\S]*?\]\]\s*/ig, '').trim();
  let scar = (match?.[1] || content.replace(/\s+/g,'').slice(0,20)).trim();
  scar = Array.from(scar).slice(0,20).join('');
  return { content, scar };
}
async function dreamAttempt(conf, opts = {}) {
  dreamEnsureState();
  if (_dreamBusy) return { ok:false, reason:'busy' };
  const now = opts.now ?? _dreamNow(), modelId = _dreamModelId(conf), day = _dreamDay(now);
  const gate = state.dreamGateByModel[modelId] || (state.dreamGateByModel[modelId] = {});
  if (!opts.force && !state.dreamsOn) return { ok:false, reason:'disabled' };
  if (!opts.force && (_dreamHour(now) < DREAM_WINDOW_START || _dreamHour(now) >= DREAM_WINDOW_END)) return { ok:false, reason:'outside-window' };
  if (!opts.force && gate.attemptDay === day) return { ok:false, reason:'already-attempted' };
  // 梦会跨设备同步过来：另一台今晚已经替它做过梦了，这台就别再做一个
  if (!opts.force && (state.dreamsByModel[modelId] || []).some(d => _dreamDay(d.createdAt) === day)) return { ok:false, reason:'already-dreamed' };
  gate.attemptDay = day; gate.attemptAt = now;
  const pool = _dreamMaterials(conf, now);
  if (pool.length < 2) { save(); return { ok:false, reason:'insufficient-material' }; }
  const random = opts.random || Math.random;
  if (!opts.force && random() >= DREAM_PROBABILITY) { save(); return { ok:false, reason:'probability' }; }
  const materials = _dreamPick(pool, random);
  _dreamBusy = true;
  try {
    const dreamConf = { ...conf, temp: Math.max(1.05, Number(conf.temp || 0.7)), maxReplyTokens: Math.min(1200, Number(conf.maxReplyTokens || 1024)) };
    const result = opts.generate
      ? await opts.generate(_dreamPrompt(conf, materials), dreamConf)
      // 给本地模型一个脱离聊天树的 origin，runId 只落在这次梦请求上，绝不污染当前对话。
      : await streamCompletion(dreamConf, [{ role:'system', content:_dreamPrompt(conf, materials) }, { role:'user', content:'让梦自然发生。' }], () => {}, undefined, { id:'dream-run-' + modelId, nodes:{}, agentMode:false });
    if (result?.error) throw new Error(result.error);
    const parsed = _dreamParse(typeof result === 'string' ? result : result?.fullText);
    if (!parsed.content) return { ok:false, reason:'empty' };
    const dream = { id:'dream-' + now + '-' + Math.random().toString(36).slice(2,7), modelId, modelNickname:conf.nickname || '', content:parsed.content, scar:parsed.scar, createdAt:now, materialKeys:materials.map(x=>x.key), scarConsumedAt:0 };
    (state.dreamsByModel[modelId] ||= []).unshift(dream);
    state.dreamsByModel[modelId] = state.dreamsByModel[modelId].slice(0,60);
    materials.forEach(m => { state.dreamMaterialCooldowns[m.key] = now; });
    gate.lastDreamAt = now; save(); dreamRenderGallery(); dreamRenderSettings();
    return { ok:true, dream };
  } catch (e) { console.warn('[梦境] 生成失败：', e); return { ok:false, reason:'error', error:e }; }
  finally { _dreamBusy = false; }
}
function dreamArmScar(conf, now = _dreamNow()) {
  dreamEnsureState(); const modelId = _dreamModelId(conf);
  const dream = (state.dreamsByModel[modelId] || []).find(d => !d.scarConsumedAt && d.scar && now - d.createdAt <= DREAM_SCAR_TTL_MS);
  _dreamArmedScar = dream ? { dream, modelId, now } : null;
}
function dreamScarPromptFor(conf) {
  const armed = _dreamArmedScar; _dreamArmedScar = null;
  if (!armed || armed.modelId !== _dreamModelId(conf)) return '';
  armed.dream.scarConsumedAt = armed.now; save();
  return `\n\n[昨夜梦痕 · 只在这一轮轻轻影响语气，不要当作事实复述]\n${armed.dream.scar}`;
}
// 跨设备同步：按梦的 id 并集合并。梦生成后内容不再变，唯一会变的是梦痕用掉的时间——两边谁用过都算用过（取较早那次）。
// 2026-10-10 电脑的 IndexedDB 被硬杀 exe 弄得整个重建，梦以前只存本机，陈列室一个不剩。
function dreamsMerge(local, cloud) {
  const buckets = {};
  for (const src of [local, cloud]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [mid, list] of Object.entries(src)) {
      if (!Array.isArray(list)) continue;
      const bucket = buckets[mid] ||= new Map();
      for (const d of list) {
        if (!d || !d.id) continue;
        const prev = bucket.get(d.id);
        if (!prev) { bucket.set(d.id, d); continue; }
        const a = Number(prev.scarConsumedAt) || 0, b = Number(d.scarConsumedAt) || 0;
        const used = a && b ? Math.min(a, b) : (a || b);
        if (used !== a) bucket.set(d.id, { ...prev, scarConsumedAt: used });
      }
    }
  }
  const out = {};
  for (const [mid, bucket] of Object.entries(buckets))
    out[mid] = [...bucket.values()].sort((x, y) => (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0)).slice(0, 60);
  return out;
}
function dreamsSyncApply(cloud) {
  dreamEnsureState();
  const next = dreamsMerge(state.dreamsByModel, cloud);
  const changed = JSON.stringify(next) !== JSON.stringify(state.dreamsByModel);
  if (changed) { state.dreamsByModel = next; save(); dreamRenderGallery(); }
  return changed;
}
function toggleDreams(on) { state.dreamsOn = !!on; save(); dreamRenderSettings(); }
async function dreamTest(modelId) {
  const conf = state.configs.find(c => _dreamModelId(c) === String(modelId)) || state.configs[0];
  if (!conf) return showToast('还没有可做梦的模型', 'error');
  showToast('正在让 ' + (conf.nickname || 'AI') + ' 入梦…', 'info', 2500);
  const r = await dreamAttempt(conf, { force:true });
  showToast(r.ok ? '梦醒了，已放进陈列室' : '这次没有成梦：' + r.reason, r.ok ? 'success' : 'info', 3500);
}
// ── 陈列室界面（用户的草稿 → AI 画的展馆）：颜色全部从 --accent 推出来，换主题一起变 ──
let _dreamFilter = 'all';
const _DREAM_CAT = `<svg class="dr-cat" viewBox="0 0 52 30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g class="head"><path class="dr-cat-fill" d="M8 30C8 20 9 13 11 6l7 6.5c5-1.8 11-1.8 16 0L41 6c2 7 3 14 3 24"/><path class="asleep" d="M17.5 21q2.5 2 5 0M29.5 21q2.5 2 5 0"/><g class="awake" fill="currentColor" stroke="none"><circle cx="20" cy="20.5" r="1.7"/><circle cx="32" cy="20.5" r="1.7"/></g><path d="M24.5 24.5l1.5 1 1.5-1" stroke-width="1.1"/></g><path class="dr-cat-fill" d="M4 30q0-3.5 4-3.5t4 3.5M40 30q0-3.5 4-3.5t4 3.5"/><text class="zzz" x="45" y="6" fill="currentColor" stroke="none" font-size="7">z</text></svg>`;
const _DREAM_SPROUT = `<svg class="dr-sprout" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 20V9"/><path d="M8 11C8 7 5 5 1.5 5.5 1.8 9 4.5 11 8 11Z" fill="currentColor" fill-opacity=".25"/><path d="M8 9c0-4 2.5-6.5 6.5-6.5C14.5 6.5 12 9 8 9Z" fill="currentColor" fill-opacity=".25"/></svg>`;
// 做梦那一夜的月相：朔望月 29.530588 天，以 2000-01-06 18:14 UTC 的新月为零点
function _dreamMoonSvg(ts) {
  const p = ((ts - Date.UTC(2000,0,6,18,14)) / 864e5 / 29.530588 % 1 + 1) % 1, r = 5.5, k = Math.cos(2 * Math.PI * p);
  const lit = p < .5 ? 1 : 0, rx = Math.abs(k * r).toFixed(2), sw = (p < .5) === (k > 0) ? 0 : 1;
  return `<svg class="dr-moon" viewBox="-7 -7 14 14"><circle r="${r}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width=".8"/><path d="M0 ${-r}A${r} ${r} 0 0 ${lit} 0 ${r}A${rx} ${r} 0 0 ${sw} 0 ${-r}Z" fill="currentColor"/></svg>`;
}
function _dreamFmt(ts) { const d = new Date(ts), p = n => String(n).padStart(2,'0'); return `${p(d.getMonth()+1)}.${p(d.getDate())} · ${p(d.getHours())}:${p(d.getMinutes())}`; }
function _dreamNick(modelId, fallback) { const c = (state.configs || []).find(c => _dreamModelId(c) === modelId); return c?.nickname || fallback || c?.modelName || 'AI'; }
function _dreamSkyOnce() {
  const el = document.getElementById('dreamSky'); if (!el || el.dataset.lit) return; el.dataset.lit = '1';
  const r = (a,b) => a + Math.random() * (b - a); let h = '';
  for (let i = 0; i < 46; i++) h += `<i class="dr-star" style="left:${r(0,100)}%;top:${r(0,100)}%;--d:${r(3,8).toFixed(1)}s;--delay:-${r(0,8).toFixed(1)}s;transform:scale(${r(.5,1.3).toFixed(2)})"></i>`;
  for (let i = 0; i < 14; i++) h += `<span class="dr-bit" style="left:${r(2,96)}%;top:${r(20,105)}%;--d:${r(14,26).toFixed(0)}s;--delay:-${r(0,26).toFixed(1)}s">${Math.random() < .5 ? 0 : 1}</span>`;
  el.insertAdjacentHTML('beforeend', h);
}
function dreamSetFilter(id) { _dreamFilter = id || 'all'; dreamRenderGallery(); }
function dreamRenderSettings() {
  const toggle = document.getElementById('dreamsToggle'); if (toggle) toggle.setAttribute('aria-pressed', String(!!state.dreamsOn));
  const el = document.getElementById('dreamSettingsPanel'); if (!el) return;
  const opts = (state.configs || []).map(c => `<option value="${escHtml(String(c.id))}">${escHtml(c.nickname || c.modelName || String(c.id))}</option>`).join('');
  el.innerHTML = opts ? `<div class="dr-try"><select id="dreamModelSelect" class="dr-select" aria-label="选一个模型">${opts}</select><button type="button" class="dr-try-btn" onclick="dreamTest(document.getElementById('dreamModelSelect').value)">✦ 现在试做一个梦</button></div>` : '';
}
function dreamRenderGallery() {
  const el = document.getElementById('dreamGallery'); if (!el) return; dreamEnsureState(); _dreamSkyOnce();
  const all = Object.values(state.dreamsByModel).flat().sort((a,b) => b.createdAt - a.createdAt);
  const order = new Map([...all].reverse().map((d,i) => [d.id, i + 1]));   // 馆藏编号：最早的梦是 No.01
  const groups = new Map(); all.forEach(d => { const id = String(d.modelId ?? ''); groups.set(id, (groups.get(id) || 0) + 1); });
  if (_dreamFilter !== 'all' && !groups.has(_dreamFilter)) _dreamFilter = 'all';
  const tabs = document.getElementById('dreamTabs');
  if (tabs) tabs.innerHTML = all.length ? [['all','全部',all.length], ...[...groups].map(([id,n]) => [id, _dreamNick(id, all.find(d => String(d.modelId ?? '') === id)?.modelNickname), n])]
    .map(([id,label,n]) => `<button type="button" class="dr-tab" role="tab" aria-selected="${id === _dreamFilter}" data-id="${escHtml(id)}" onclick="dreamSetFilter(this.dataset.id)">${escHtml(label)}<small>${n}</small></button>`).join('') : '';
  const count = document.getElementById('dreamCount');
  if (count) count.innerHTML = all.length ? `藏品 <b>${all.length}</b> · 最近 <b>${_dreamFmt(all[0].createdAt)}</b>` : '展厅还空着';
  const list = _dreamFilter === 'all' ? all : all.filter(d => String(d.modelId ?? '') === _dreamFilter);
  el.innerHTML = list.length ? list.map((d,i) => `<li class="dr-ex" style="--i:${Math.min(i,8)}">${_DREAM_SPROUT}${_DREAM_CAT}<div class="dr-case">`
    + `<div class="dr-plate"><span class="dr-no">No.${String(order.get(d.id) || 0).padStart(2,'0')}</span><b class="dr-name">${escHtml(_dreamNick(String(d.modelId ?? ''), d.modelNickname))}</b><time class="dr-when">${_dreamMoonSvg(d.createdAt)}${_dreamFmt(d.createdAt)}</time></div>`
    + `<p class="dr-text">${escHtml(d.content)}</p>`
    + (d.scar ? `<div class="dr-scar${d.scarConsumedAt ? ' gone' : ''}"><span>梦痕 · ${escHtml(d.scar)}</span>${d.scarConsumedAt ? '<em>已消散</em>' : ''}</div>` : '')
    + `</div></li>`).join('')
    : `<li class="dr-empty"><svg viewBox="0 0 120 70" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 58c-6-18 8-34 34-34 22 0 40 10 40 26 0 7-5 10-12 10H30c-5 0-8-1-10-2Z" fill="currentColor" fill-opacity=".08"/><path d="M78 30l4-12 6 9M88 27l8-6 1 12"/><path d="M84 42q2.5 1.8 5 0"/><path d="M20 58c-8 2-14-2-12-8s10-4 12 0"/><text x="98" y="16" fill="currentColor" stroke="none" font-size="10" opacity=".7">z z</text></svg>还没有梦。<br>等记忆够了、夜色合适的时候，它们会自己来。</li>`;
}
async function dreamNightTick() {
  if (!state.dreamsOn || _dreamBusy || globalThis._streamControllers?.size) return;
  for (const conf of state.configs || []) await dreamAttempt(conf);
}
if (typeof setInterval === 'function') setInterval(dreamNightTick, 5 * 60 * 1000);
if (typeof setTimeout === 'function') setTimeout(dreamNightTick, 12000);
