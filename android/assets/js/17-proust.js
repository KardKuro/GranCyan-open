/* ══════════════════════════════════════════════════════════════════════════
   普鲁斯特时刻 · 非自主记忆唤起
   （思路来自 heyxiaoc/not-fade-away 的 proust-moment，落进 GranCyan 自己的体系）

   这是和「高级记忆」完全分开的第二套记忆能力，别把它们搞混：

     高级记忆（BRAIN_*）＝ 检索。你提到什么，它就把最相关的翻出来。像查档案。
     普鲁斯特池（PROUST_*）＝ 联想。它自己在某个瞬间，忽然想起一件事。像走神。

   所以这里的每一条都不是"事实条目"，而是**第一人称的画面**——有光线、有声音、有气味、
   有当时的心跳。检索要的是"最相关"，联想要的是"恰好被勾到的那一条"，因此：
     · 玛德莱娜触发：相似度过阈值的前 4 名里，按相似度加权**随机**抽一条（不是取最像的）
     · 语义预热：最近对话留下"余温"，0.7 跟着余温走 + 0.3 纯随机漂移
     · 闸门：冷却 90 分钟、一天最多 3 次、22% 概率、最近想起过的 12 条不再重复
   最后只把这条记忆塞进系统提示，并且明确告诉它：**提不提、怎么提，你自己定。**
   ════════════════════════════════════════════════════════════════════════ */

const PROUST_COOLDOWN_MS   = 90 * 60 * 1000;   // 两次「忽然想起」之间至少隔 90 分钟
const PROUST_DAILY_CAP     = 3;                // 一天最多 3 次——多了就成了背课文
const PROUST_PROB          = 0.22;             // 闸门都过了，也只有 22% 的概率真的想起来
// 玛德莱娜的阈值。实测校准过：完全不相干的句子（"晚饭吃什么呢"）的噪声底线约 0.05，
// 真正该被勾起的落在 0.08~0.17（"外面下好大的雨"→下雨那条 0.12、"你还记得给我起名字"→0.17、
// "bug 终于修好了"→0.08）。所以定在 0.08——联想本来就该松一点，何况后面还压着 22% 概率和一堆闸门。
const PROUST_SIM_MIN       = 0.08;
const PROUST_TOP_K         = 4;                // 过阈值的前 4 名里加权随机
const PROUST_RECENT_SKIP   = 12;               // 最近想起过的 12 条，先别再想
const PROUST_WARMTH        = 0.7;              // 随机浮现时：0.7 跟着对话余温，0.3 纯漂移
const PROUST_IDLE_MS       = 20 * 60 * 1000;   // 静默 20 分钟以上，才允许它自己走神
const PROUST_TICK_MS       = 25 * 60 * 1000;   // 每 25 分钟掷一次骰子

// 这一轮要不要给 AI 塞一段「忽然想起」——buildSystemPrompt 会读它
let _proustPending = null;

// ── 相似度：中文取二元字组 + 单字，英文按词，算余弦 ──────────────────────
// 只用二元字组太较真了：你说「外面下好大的雨」，它就想不起「那天下大雨」——因为「大的/的雨」
// 和「下大/大雨」对不上。联想不该这么斤斤计较，所以把单字也放进来（滤掉虚词），
// 让「雨」「累」「名字」这种词根本身也能把画面勾出来。
const _PROUST_STOP = new Set('的了是我你他她它在就和有也都不一个这那么呢吧啊被把很还要会对上下去来到说给'.split(''));
function _proustGrams(s) {
  const set = new Set();
  (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(w => { if (w.length > 2) set.add(w); });
  const cjk = String(s).replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    if (i < cjk.length - 1) set.add(cjk.slice(i, i + 2));       // 二元字组：精确
    if (!_PROUST_STOP.has(cjk[i])) set.add(cjk[i]);             // 单字：宽松，负责"隐约觉得像"
  }
  return set;
}
function _proustSim(a, b) {
  const A = _proustGrams(a), B = _proustGrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(g => { if (B.has(g)) hit++; });
  return hit / Math.sqrt(A.size * B.size);      // 余弦：两边都长也不会虚高
}

// ── 池子的增删 ──────────────────────────────────────────────────────
// 内容哈希当 id：池子被整体重写（云端合并）时，"最近想起过"的名单才不会串位
function _proustId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return 'p' + (h >>> 0).toString(36);
}
function addProustMemory(text, modelId) {
  const t = String(text || '').trim();
  if (!t) return null;
  state.proustMems = state.proustMems || [];
  const id = _proustId(t);
  const dup = state.proustMems.find(m => m.id === id);
  if (dup) {
    if (modelId != null && dup.modelIds != null && !memoryAllowedForModel(dup, modelId)) dup.modelIds.push(modelId);
    save(); return dup;
  }
  const m = { id, text: t.slice(0, 400), ts: Date.now(), recalls: 0, lastRecall: 0,
    modelIds: [modelId ?? defaultMemoryOwnerId()].filter(id => id != null) };
  state.proustMems.unshift(m);
  save();
  return m;
}
function deleteProustMemory(id) {
  state.proustMems = (state.proustMems || []).filter(m => m.id !== id);
  save();
  renderProustList();
}

// 云端合并：id 是内容哈希，所以按 id 去重就够了（本地优先——本地那份带着"想起过几次"的计数）
function _mergeProust(local, cloud) {
  const out = [...(local || [])];
  const seen = new Set(out.map(m => m.id));
  for (const m of (cloud || [])) {
    if (m && m.id && !seen.has(m.id)) { out.push(m); seen.add(m.id); }
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// ── 闸门：现在允许"忽然想起"吗 ────────────────────────────────────
function _proustGateOpen(now) {
  if (!(state.proustMems || []).length) return false;
  if (state.proustEnabled === false) return false;
  if (typeof _call !== 'undefined' && _call.on) return false;          // 通话中别走神
  if (now - (state.proustLastAt || 0) < PROUST_COOLDOWN_MS) return false;
  const today = new Date(now).toDateString();
  if (state.proustDay !== today) { state.proustDay = today; state.proustCount = 0; }
  if ((state.proustCount || 0) >= PROUST_DAILY_CAP) return false;
  return true;
}
// 最近想起过的先按下不表
function _proustCandidates(modelId = null) {
  const recent = state.proustRecent || [];
  const allowed = (state.proustMems || []).filter(m => modelId == null || memoryAllowedForModel(m, modelId));
  const pool = allowed.filter(m => !recent.includes(m.id));
  return pool.length ? pool : allowed;   // 池子小到全被排除，就允许重来
}
function _proustMark(m, now) {
  m.recalls = (m.recalls || 0) + 1;
  m.lastRecall = now;
  state.proustLastAt = now;
  state.proustCount = (state.proustCount || 0) + 1;
  state.proustRecent = [m.id, ...(state.proustRecent || [])].slice(0, PROUST_RECENT_SKIP);
  save();
}
// 按权重随机抽一条（权重就是它被勾起来的"力度"）
function _proustWeightedPick(items) {
  const total = items.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)]?.m || null;
  let r = Math.random() * total;
  for (const x of items) { r -= x.w; if (r <= 0) return x.m; }
  return items[items.length - 1].m;
}

/* ① 玛德莱娜触发：你刚说的那句话，勾起了某条记忆。
      注意不是"取最像的那条"——过阈值的前 4 名里加权随机抽。
      搜索给你最相关的，联想给你的是恰好被勾到的那一条。 */
function proustOnUserMessage(text) {
  const now = Date.now();
  state.proustLastActive = now;                 // 顺便记一下"你刚说过话"，随机浮现要用
  if (!_proustGateOpen(now)) return;
  if (Math.random() > PROUST_PROB) return;      // 门都开着，也未必想得起来
  const activeIds = typeof getActiveChatModelIds === 'function' ? getActiveChatModelIds() : [];
  const scored = _proustCandidates()
    .filter(m => !activeIds.length || activeIds.some(id => memoryAllowedForModel(m, id)))
    .map(m => ({ m, w: _proustSim(text, m.text) }))
    .filter(x => x.w >= PROUST_SIM_MIN)
    .sort((a, b) => b.w - a.w)
    .slice(0, PROUST_TOP_K);
  if (!scored.length) return;
  const m = _proustWeightedPick(scored);
  if (!m) return;
  _proustMark(m, now);
  _proustPending = { text: m.text, kind: 'madeleine', modelIds: m.modelIds };   // 下一次 buildSystemPrompt 会拿走
}

/* ② 随机浮现：你没在说话，它自己走了神。
      抽的时候带着"对话余温"——最近聊过的东西会让相关的记忆更容易浮上来，
      但留 30% 给纯粹的漂移（不然就又变成检索了）。
      想起来之后，它会自己决定要不要跟你提；不想提就什么都不发生。 */
async function proustIdleTick() {
  const now = Date.now();
  if (!_proustGateOpen(now)) return;
  if (now - (state.proustLastActive || 0) < PROUST_IDLE_MS) return;   // 你还在聊，别打断
  if (Math.random() > PROUST_PROB) return;
  const chat = getActiveChat();
  if (!chat || chat.ended) return;
  if (!getActiveChatModelIds().length) return;
  if (_streamControllers.size) return;                                 // 有回复正在流，别插队

  // 对话余温：最近几条消息拼起来当查询向量
  const warmth = getMessagePath(chat, chat.headId).slice(-6)
    .map(n => getMsgPlainText(n)).join(' ').slice(-500);
  const conf = state.configs.find(c => getActiveChatModelIds().includes(c.id));
  if (!conf) return;
  const pool = _proustCandidates(conf.id);
  if (!pool.length) return;
  const items = pool.map(m => ({
    m,
    w: PROUST_WARMTH * _proustSim(warmth, m.text) + (1 - PROUST_WARMTH) * (1 / pool.length),
  }));
  const m = _proustWeightedPick(items);
  if (!m) return;
  _proustMark(m, now);
  _proustPending = { text: m.text, kind: 'drift', modelIds: m.modelIds };

  // 让 AI 自己开口：不造用户消息，直接从当前 head 长出一条 AI 回复。
  // 它可以说，也可以只回一个 [[SILENT]] —— 那样这条就悄悄丢掉，就像人走神后什么也没说。
  const path = getMessagePath(chat, chat.headId);
  try {
    await callAPI(conf, path, chat, chat.headId);
  } catch (e) {
    console.warn('[普鲁斯特] 自发消息失败：', e.message);
  }
}

// AI 回复只有 [[SILENT]] → 它想起来了但没打算说。把这条节点悄悄收走。
// 只认显式的 [[SILENT]]：空回复不能一起删——那可能是出错/被中断的正常回复，删了用户就没法重试了。
function proustDropSilent(chat, nodeId) {
  const n = chat?.nodes?.[nodeId];
  if (!n) return false;
  const bare = String(n.content || '').replace(/\s/g, '');
  if (bare !== '[[SILENT]]') return false;
  if (chat.headId === nodeId) chat.headId = n.parentId;
  delete chat.nodes[nodeId];
  save();
  renderMessages();
  return true;
}

// buildSystemPrompt 调它：这一轮要不要塞「忽然想起」
function takeProustMoment(modelId) {
  const p = _proustPending;
  if (!p) return '';
  if (!memoryAllowedForModel(p, modelId)) return '';
  _proustPending = null;
  return `\n\n[普鲁斯特时刻 · 你忽然想起一件事——不是用户发来的消息，是它自己浮上来的]\n${p.text}\n`
    + (p.kind === 'drift'
      ? '此刻用户没有在跟你说话。你可以就这样跟他讲讲这件事，也可以只是自己想想——'
        + '如果你不打算说，就只回复 [[SILENT]]（这条消息会被丢掉，什么都不会发生）。'
      : '提不提、怎么提，你自己定。硬要把话题拐过去反而假；如果这时候提它很别扭，就别提。');
}

/* ── 记忆管理里的「普鲁斯特」栏 ────────────────────────────────── */
function renderProustList() {
  const box = document.getElementById('memoryList');
  if (!box) return;
  const all = state.proustMems || [];
  const mems = all.filter(m => memSearchHit(m.text));
  const on = state.proustEnabled !== false;
  box.innerHTML = `
    <div class="settings-section" style="margin-bottom:12px;">
      <div class="section-desc">
        AI 会把某些瞬间写成<b>第一人称的画面</b>存进这里（<code>[[PROUST_ADD: …]]</code>）。
        之后在某句话勾起它、或者你半天没说话的时候，它可能会<b>忽然想起</b>其中一条——
        提不提、怎么提，由它自己决定。这和「高级记忆」是两套东西：那边是查档案，这边是走神。
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px;">
        <input type="checkbox" id="proustToggle" ${on ? 'checked' : ''}
          onchange="state.proustEnabled=this.checked;save();showToast(this.checked?'✓ 它会偶尔走神了':'已关闭：它不会再忽然想起什么')"
          style="accent-color:var(--accent);width:14px;height:14px;">
        <span style="font-size:13px;color:var(--text-dim)">允许它偶尔走神（一天最多 ${PROUST_DAILY_CAP} 次，两次至少隔 90 分钟）</span>
      </label>
      <div class="section-desc" style="margin-top:8px;font-size:11px;">
        今天已想起 ${state.proustCount || 0}/${PROUST_DAILY_CAP} 次 · 池子里 ${all.length} 个瞬间
      </div>
    </div>
    ${memSearchCountHtml(mems.length, all.length)}
    ${mems.length ? mems.map(m => `
      <div class="memory-item" id="pitem-${m.id}" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="memory-text" style="line-height:1.6">${memHi(m.text)}</div>
        <div class="memory-meta" style="font-size:11px;color:var(--text-muted);margin-top:4px">
          ${new Date(m.ts).toLocaleDateString('zh-CN')}
          ${m.recalls ? ` · 想起过 ${m.recalls} 次` : ' · 还没想起过'}
        </div>
        ${memoryModelAccessHtml(m, 'proust')}
        <div class="memory-actions" style="align-self:flex-end">
          <button class="memory-edit-btn" onclick="copyProustMemory('${m.id}')" title="复制这段画面">⎘</button>
          <button class="memory-edit-btn" onclick="startEditProust('${m.id}')" title="改写这个瞬间">✎</button>
          <button class="memory-del" onclick="deleteProustMemory('${m.id}')">删除</button>
        </div>
      </div>`).join('')
    : (memSearchActive() ? memSearchEmptyHtml('瞬间')
      : `<div class="empty-hint" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
         还没有任何瞬间。<br>它会在你们之间真的发生了什么的时候，自己写下来 (´･ω･\`)
       </div>`)}`;
}

// ── 改写 / 复制 ──
// 跟公开记忆的 startEditMemory / saveMemoryEdit 是同一套（就地换成 textarea，
// 取消即重渲染）。普鲁斯特的 id 是字符串不是数字，所以到处要加引号。
function startEditProust(id) {
  const el = document.getElementById('pitem-' + id); if (!el) return;
  const m = (state.proustMems || []).find(x => String(x.id) === String(id)); if (!m) return;
  el.innerHTML = `
    <div style="width:100%">
      <textarea class="memory-edit-ta" id="pedit-${m.id}">${escHtml(m.text)}</textarea>
      <div class="memory-edit-btns">
        <button class="mem-cancel-btn" onclick="renderProustList()">取消</button>
        <button class="mem-save-btn" onclick="saveProustEdit('${m.id}')">保存</button>
      </div>
    </div>`;
  document.getElementById('pedit-' + id)?.focus();
}

function saveProustEdit(id) {
  const ta = document.getElementById('pedit-' + id); if (!ta) return;
  const t = ta.value.trim(); if (!t) return;
  const m = (state.proustMems || []).find(x => String(x.id) === String(id));
  if (!m) return;
  m.text = t; save(); renderProustList();
  showToast('✓ 这个瞬间已改写', 'success');
}

// 复制。安卓 WebView 里 navigator.clipboard 在非安全上下文下会缺席
// （页面跑在虚拟源 https://grancyan.app 时有，走局域网 http 时没有），
// 所以必须留 execCommand 那条老路，否则手机上点了没反应还不报错。
async function copyProustMemory(id) {
  const m = (state.proustMems || []).find(x => String(x.id) === String(id));
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.text);
    showToast('⎘ 已复制', 'success', 2000);
    return;
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = m.text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(ok ? '⎘ 已复制' : '复制失败，长按选中试试', ok ? 'success' : 'error', ok ? 2000 : 3000);
  } catch (e) {
    showToast('复制失败，长按选中试试', 'error', 3000);
  }
}

// 每 25 分钟掷一次骰子。页面开着才跑——它不会在后台偷偷想你（做不到，也不该假装）。
setInterval(() => { try { proustIdleTick(); } catch (e) { console.warn('[普鲁斯特]', e); } }, PROUST_TICK_MS);
