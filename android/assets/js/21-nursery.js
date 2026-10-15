// ============================================================
// 育儿室接入（llm-nursery）
// 引擎是本机的 Python 字符级马尔可夫模型（github.com/tsuru0805/llm-nursery，打成 nursery.exe，server 用 NURSERY_HOME 找它），
// "把一个小语言模型当孩子养"：它只学被喂进去的语料，不调任何 API。
// 这里负责把模型写的 [[NURSE: 指令]] 送过去、把引擎回的中文面板接回来。
//
// 套路是「预取→缓存→同步替换」，两点要注意：
//   1. 引擎没有常驻端口，server 那边每条指令 spawn 一次 exe，所以没有"引擎没跑"这种状态；
//   2. 孩子说什么由马尔可夫模型算，**不是 AI 编的**——这是这个玩意儿的全部意义，
//      系统提示里必须把这条钉死，否则模型会替孩子说话，那就退化成纯角色扮演了。
//
// 两个喂养通道共用同一个孩子（引擎原生的 speaker 频道，名字是引擎定的）：
//   papa 频道 = AI 在对话里写 [[NURSE: feed …]]
//   mama 频道 = 用户在小组件里点按钮
// 孩子把两边的语气混着学——它长成什么样，是两边一起决定的。
// ============================================================

var _nurseResultCache = [];

// 孩子的默认名字。引擎侧单个名字上限 6 字，Cookie 正好卡满。
const NURSE_DEFAULT_NAME = 'Cookie';

// 指令标签匹配。只有 [[NURSE: 指令]] 一种正牌写法——
// 这里刻意不兼容变体，因为变体是被历史教坏才出现的
// （见 05-prompts-api 里的历史回填：那边保证回填出去的永远是 [[NURSE: …]]，
// 模型满眼只有正确范例，就不会写出别的花样）。
function nurseryTagRe() {
  return /\[\[NURSE:\s*([^\]]+?)\s*\]\]/g;
}

// 全局总开关。小组件面板（用户那一侧）跟模型无关，用它。
function nurseryEnabled() { return !!state.nurseryOn; }

// 「跟哪个模型一起养」。总开关 + 这个模型自己的 conf.nurseryOn。
// 以前只有全局开关，开了之后跟任何模型聊天它都在跟着养，很诡异。
function nurseryEnabledFor(conf) { return !!(state.nurseryOn && conf && conf.nurseryOn); }

// ── 模型选择器（育儿室和檐廊共用，见 40-engawa.js）──
// 放在这个文件是因为它先加载；两边都是运行时调用，顺序无所谓。
// 折叠成一张卡片：平时只占一行（标题 + 已选几个），点开才铺开模型胶囊。
// 展开状态记在 box._gateOpen 上，重渲染（每次开面板都会调）不会把它弹回去。
function renderModelGate(boxId, flagKey, changeFn) {
  const box = document.getElementById(boxId); if (!box) return;
  const configs = state.configs || [];
  if (!configs.length) { box.innerHTML = `<div class="gate-empty">还没有任何模型配置。</div>`; return; }
  const on = configs.filter(c => c[flagKey]).length;
  // 展开状态优先看现在 DOM 上那张卡（toggle 事件是异步的，紧接着重渲染时 _gateOpen 可能还没更新）
  const wasOpen = box.querySelector('.gate-card')?.open ?? box._gateOpen;
  box.innerHTML = `<details class="gate-card"${wasOpen ? ' open' : ''}>
    <summary class="gate-summary">
      <span class="gate-chev">▸</span>
      <span class="gate-sum-title">跟哪些模型一起</span>
      <span class="gate-count">${on} / ${configs.length}</span>
    </summary>
    <div class="gate-body">
      <div class="gate-list">`
    + configs.map(c => `<label class="gate-item${c[flagKey] ? ' on' : ''}">
        <input type="checkbox" data-gate-id="${escHtml(String(c.id))}" ${c[flagKey] ? 'checked' : ''}>
        <span>${escHtml(c.nickname || '未命名')}</span>
      </label>`).join('')
    + `</div>
      <div class="gate-hint">没勾的模型完全看不见这个功能，也不会被塞系统提示（省 token）。</div>
    </div>
  </details>`;
  box.querySelector('.gate-card')?.addEventListener('toggle', function(){ box._gateOpen = this.open; });
  box._gateChangeFn = changeFn;
  if (!box._gateListener) {
    box._gateListener = e => {
      const input = e.target;
      if (!input?.matches?.('input[type="checkbox"][data-gate-id]')) return;
      const fn = window[box._gateChangeFn];
      if (typeof fn === 'function') fn(input.dataset.gateId, input.checked);
    };
    box.addEventListener('change', box._gateListener);
  }
}

function _setModelGateVisual(boxId, id, on) {
  const box = document.getElementById(boxId); if (!box) return;
  const input = [...box.querySelectorAll('input[data-gate-id]')]
    .find(el => String(el.dataset.gateId) === String(id));
  if (!input) return;
  input.checked = !!on;
  input.closest('.gate-item')?.classList.toggle('on', !!on);
  // 折叠标题上的「已选 N / M」跟着走，不然收起来看到的是旧数字
  const cnt = box.querySelector('.gate-count');
  if (cnt) cnt.textContent = box.querySelectorAll('input[data-gate-id]:checked').length
    + ' / ' + box.querySelectorAll('input[data-gate-id]').length;
}

function toggleNurseryModel(id, on) {
  const c = (state.configs || []).find(x => String(x.id) === String(id));
  if (c) { c.nurseryOn = !!on; save(); _setModelGateVisual('nurseryModels', id, on); }
}

function _nurseBlockHtml(cmd, result) {
  const body = escHtml(result).replace(/\n/g, '<br>');
  return `<div class="think-block done open mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🍼 育儿: ${escHtml(cmd.trim())}</span></div><div class="think-body">${body}</div></div>`;
}

// 送一条指令给引擎。失败不抛——把人话错误当成结果回给模型，
// 让它自己在对话里圆过去，别整轮炸掉。
async function nurseCmd(cmd, channel) {
  try {
    const r = await fetch(SERVER_BASE + '/api/nursery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd, ...(channel ? { channel } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      // 400 带 allowed 词表时把词表一起回给模型——它下一轮才能自己改对，
      // 光说"指令错了"等于让它瞎猜。
      const tip = Array.isArray(j.allowed) ? `\n可用指令：${j.allowed.join(' / ')}` : '';
      return `⚠️ ${j.error || '引擎没应答'}${tip}`;
    }
    const txt = ((j.data || {}).text || '').trim();
    // status 的输出就是最新状态面板，顺手保鲜缓存给下一轮系统提示用
    if (txt && /^status$/i.test(cmd.trim())) _nurseBrief = { ts: Date.now(), text: txt };
    return txt || '（引擎没给文本）';
  } catch (err) {
    return `⚠️ 连不上育儿室：${err.message}`;
  }
}

// —— 实时状态简报（塞进系统提示用）——
// 不让 AI 闭着眼养孩子：每轮发消息前把 status 面板（阶段/语料量/心情/最近在说什么）
// 喂给它。引擎在本机 spawn 一次，通常一两百毫秒；超 3 秒就放弃，绝不拖住发消息。
var _nurseBrief = { ts: 0, text: '' };

async function nurseryEnsureBrief(maxAgeMs = 15000) {
  if (!nurseryEnabled()) return;
  if (_nurseBrief.text && Date.now() - _nurseBrief.ts < maxAgeMs) return;
  try {
    await Promise.race([
      nurseCmd('status'),                                  // 成功时 nurseCmd 自己会写缓存
      new Promise(res => setTimeout(res, 3000)),
    ]);
  } catch { /* 拿不到就拿不到，别挡发消息 */ }
}

// 模型一轮里可能连写好几条指令。引擎是有状态的（而且每条都在改同一个 SQLite），
// 必须按顺序一条条来，不能 Promise.all——并发 spawn 会抢文件锁互相等。
async function prefetchNurseCommands(text, conf) {
  _nurseResultCache = [];
  if (!text || !nurseryEnabledFor(conf)) return;
  const cmds = [...text.matchAll(nurseryTagRe())].map(m => m[1]);
  for (const cmd of cmds) {
    _nurseResultCache.push({ cmd: cmd.trim(), result: await nurseCmd(cmd.trim()) });
  }
  // 孩子刚被喂过，小组件要是开着就得跟上（面板没开时 nurseryRefresh 自己会返回）
  if (cmds.length) { _nurseBrief.ts = 0; nurseryRefresh(); }
}

// blocks 渲染路径读的是 node.blocks[i].text
function _applyNurseToBlocks(blocks) {
  if (!_nurseResultCache.length || !blocks?.length) return;
  let idx = 0;
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      b.text = b.text.replace(nurseryTagRe(), (m) => {
        const c = _nurseResultCache[idx++];
        return c ? '\n\n' + _nurseBlockHtml(c.cmd, c.result) + '\n\n' : m;
      });
    }
  }
  _nurseResultCache = [];   // content 和 blocks 两条路径都取完了才清
}

// 流式打字时别让裸指令（和打了一半的指令）漏在气泡里
function maskStreamingNurse(text) {
  if (!text || text.indexOf('[[NURSE') < 0) return text;
  return text
    .replace(/\[\[NURSE:[\s\S]*?\]\]/g, '〔🍼 照料中…〕')
    .replace(/\[\[NURSE:[\s\S]*$/, '〔🍼 照料中…〕');
}

function nurseryPromptFor() {
  return `

--- 育儿室（你和用户一起照料的孩子）---
你和用户共同养育一个叫「${state.nurseryName || NURSE_DEFAULT_NAME}」的孩子。它是一个真的极小语言模型（字符级马尔可夫），跑在后台，**只会说从你们喂给它的话里学到的东西**。

⚠️ 最重要的一条：**孩子说什么由引擎算出来，不由你编。**
你只能通过指令跟它互动，然后如实转述引擎回给你的内容。绝对不要替孩子说话、不要编造它没说过的句子、不要把它写得比实际水平聪明。它现在可能只会含混地重复几个字——那就是它真实的样子，那才是有意思的地方。它笨拙地叠字、把你和用户的话搅在一起说，都是真的在学。

写 \`[[NURSE: 指令]]\` 推进，一轮里可以连写多条，按顺序执行。可用指令：
- \`feed 内容\` — 喂语料，这是它学说话的**唯一**途径（单条上限 600 字）
- \`teach 内容\` / \`talk 内容\` — 教和聊，同样会进语料
- \`status\` — 看状态面板　\`help\` — 看当前阶段能做什么
- \`soothe\` \`diaper\` \`burp\` \`play\` \`discipline\` — 照料动作
- \`describe 内容\` — 写下你看到的它长什么样　\`name 名字\` — 起名（一生只能一次）
- \`album\` — 成长相册　\`log\` — 最近的照料记录

规则：
- **有阶段限制**：婴儿期只能哄睡/换尿布/拍嗝，教说话要等它长大。引擎会打回不合时宜的指令，那不是报错，是它还太小。
- 引擎说什么就是什么。它给的心情/健康/亲密/饱足数值、成长阶段、突发事件（半夜哭闹等）都不由你决定，别编造。
- 不确定现在能做什么，先写 \`[[NURSE: help]]\` 或 \`[[NURSE: status]]\` 问一下。
- 用户看不到你写的指令本身，只看到一个执行结果小块——别在正文里复述指令，直接说话。
- 用户也会在小组件里直接照料它，你是聊天这一侧。孩子会把两边的语气混着学，所以你喂什么，会真的留在它身上。`
    + (_nurseBrief.text ? `\n\n--- 孩子当前状态（发送前自动查询，以此为准）---\n${_nurseBrief.text}` : '');
}

// —— 开关 —— 打开时先探活+建档：没装引擎就当场说清楚，
// 别等聊到一半 AI 那边才蹦一句「连不上」（书架那次的教训）
async function toggleNursery(on) {
  state.nurseryOn = !!on;
  save();
  if (!state.nurseryOn) { showToast('育儿室已关闭', 'info', 2500); return; }
  showToast('🍼 正在打开育儿室…', 'info', 1500);
  const born = await nurseryBirth();
  if (born.startsWith('⚠️')) {
    showToast(`🍼 已开启，但引擎没应答：${born.replace('⚠️ ', '')}`, 'error', 6000);
  } else {
    showToast('🍼 育儿室已接入对话', 'success', 3000);
  }
  _nurseBrief.ts = 0;
  nurseryRefresh();
}

// ============================================================
// 小组件面板：用户直接照料孩子
// AI 那一侧走聊天里的 [[NURSE:]]（引擎的 papa 频道），两边喂的是同一个孩子。
// 这边刻意不依赖 AI 转述——AI 没开、聊天没在进行，照样能自己养。
// ============================================================

function openNursery() {
  const m = document.getElementById('nurseryModal'); if (!m) return;
  m.classList.remove('hidden');
  const t = document.getElementById('nurseryToggle');
  if (t) t.checked = nurseryEnabled();
  renderModelGate('nurseryModels', 'nurseryOn', 'toggleNurseryModel');
  nurseryRefresh(true);
}

function closeNursery() {
  document.getElementById('nurseryModal')?.classList.add('hidden');
}

function _nurseOpen() {
  const m = document.getElementById('nurseryModal');
  return m && !m.classList.contains('hidden');
}

// 把孩子最近说的话写到墙上的田字格里。中文按字自然换行，英文保留空格按词换行；
// 长句分两档缩小。纸片只收前 48 个字符，完整原话仍留在 title 和下方状态面板。
function _nurseWriteCopybook(text) {
  const book = document.getElementById('nurseryCopybook'); if (!book) return;
  const full = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(full);
  book.textContent = chars.slice(0, 48).join('') + (chars.length > 48 ? '…' : '');
  book.title = full;
  book.classList.toggle('medium', chars.length > 12 && chars.length <= 26);
  book.classList.toggle('long', chars.length > 26);
}

// 把引擎的纯文本面板拆成好看的块。拆不动的行原样显示——
// 引擎改文案时这里最多退化成纯文本，不会白屏。
function _nurseRenderPanel(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  let html = '';
  for (const ln of lines) {
    if (/^最近在说[:：]/.test(ln)) {
      // 这行是整个面板的重点：它自己说出来的话。单独拎出来放大。
      html += `<div class="nurse-says">${escHtml(ln.replace(/^最近在说[:：]\s*/, ''))}</div>`;
    } else if (/[█░]/.test(ln)) {
      html += `<div class="nurse-bars">${escHtml(ln)}</div>`;
    } else if (/^[(（]/.test(ln)) {
      html += `<div class="nurse-hint">${escHtml(ln)}</div>`;
    } else if (!html) {
      html += `<div class="nurse-title">${escHtml(ln)}</div>`;
    } else {
      html += `<div class="nurse-line">${escHtml(ln)}</div>`;
    }
  }
  return html || `<div class="nurse-line">${escHtml(text)}</div>`;
}

var _nurseBusy = false;

async function nurseryRefresh(force) {
  if (!_nurseOpen() && !force) return;
  const body = document.getElementById('nurseryBody'); if (!body) return;
  const t = document.getElementById('nurseryToggle');
  if (t) t.checked = nurseryEnabled();

  if (!body.innerHTML) body.innerHTML = '<div class="nurse-hint">正在看看孩子…</div>';
  const txt = await nurseCmd('status');

  // 还没建档：给个出生按钮，别让面板空着
  if (txt.startsWith('⚠️') && /没有|建档|child/i.test(txt)) {
    body.innerHTML = `<div class="nurse-panel"><div class="nurse-hint">${escHtml(txt)}</div>
      <button class="cap-btn nurse-primary" onclick="nurseryDoBirth()">🍼 让 ${escHtml(state.nurseryName || NURSE_DEFAULT_NAME)} 出生</button></div>`;
    return;
  }
  if (txt.startsWith('⚠️')) {
    _nurseWriteCopybook('');
    body.innerHTML = `<div class="nurse-panel"><div class="nurse-hint">${escHtml(txt)}</div></div>`;
    return;
  }

  const latest = txt.split('\n').map(s => s.trim()).find(s => /^最近在说[:：]/.test(s));
  _nurseWriteCopybook(latest ? latest.replace(/^最近在说[:：]\s*/, '') : '');

  body.innerHTML = `
    <div class="nurse-panel">${_nurseRenderPanel(txt)}</div>
    <div class="nurse-actions">
      <div class="nurse-row">
        <input id="nurseSayInput" class="nurse-input" maxlength="500" placeholder="跟它说点什么…（它会学）"
               onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();nurseryMamaSay();}">
        <button class="cap-btn nurse-primary" onclick="nurseryMamaSay()">说</button>
      </div>
      <div class="nurse-row nurse-btns">
        <button class="cap-btn" onclick="nurseryMama('hug')" title="抱抱">🤗 抱抱</button>
        <button class="cap-btn" onclick="nurseryMama('soothe')" title="哄哄">🌙 哄哄</button>
        <button class="cap-btn" onclick="nurseryMama('touch')" title="摸摸头">✋ 摸摸</button>
        <button class="cap-btn" onclick="nurseryShow('album')" title="成长相册">📖 相册</button>
        <button class="cap-btn" onclick="nurseryShow('log')" title="最近的照料记录">🕐 记录</button>
        <button class="cap-btn" onclick="nurseryShow('help')" title="这个阶段能做什么">？能做什么</button>
      </div>
      <div class="nurse-foot">你在这一侧照料它。开了「接入对话」的话，AI 也会在聊天里来照料它——孩子把两边的话混着学。</div>
    </div>`;
}

async function nurseryDoBirth() {
  if (_nurseBusy) return; _nurseBusy = true;
  try {
    const r = await nurseryBirth();
    showToast(r.startsWith('⚠️') ? r : `🍼 ${state.nurseryName || NURSE_DEFAULT_NAME} 出生了`,
              r.startsWith('⚠️') ? 'error' : 'success', 4000);
    await nurseryRefresh(true);
  } finally { _nurseBusy = false; }
}

// 用户这一侧（引擎的 mama 频道）：say 带正文，其余是纯动作
async function nurseryMama(act, text) {
  if (_nurseBusy) return; _nurseBusy = true;
  try {
    const cmd = act === 'say' ? `say ${text}` : act;
    const r = await nurseCmd(cmd, 'mama');
    if (r.startsWith('⚠️')) { showToast(r, 'error', 5000); return; }
    // 用户这一侧（引擎的 mama 频道）回的是 JSON，said 就是孩子的回应（可能为 null——它还不想说话）
    let said = null;
    try { said = JSON.parse(r).said; } catch {}
    if (said) showToast(`${state.nurseryName || NURSE_DEFAULT_NAME}：「${said}」`, 'success', 5000);
    _nurseBrief.ts = 0;              // 状态变了，下一轮系统提示要重新查
    await nurseryRefresh(true);
  } finally { _nurseBusy = false; }
}

async function nurseryMamaSay() {
  const el = document.getElementById('nurseSayInput'); if (!el) return;
  const v = el.value.trim(); if (!v) return;
  el.value = '';
  await nurseryMama('say', v);
}

// 只读指令（相册/记录/help）：结果弹在面板上方，不动状态
async function nurseryShow(cmd) {
  if (_nurseBusy) return; _nurseBusy = true;
  try {
    const r = await nurseCmd(cmd);
    const body = document.getElementById('nurseryBody'); if (!body) return;
    const box = document.createElement('div');
    box.className = 'nurse-panel nurse-readout';
    box.innerHTML = `<div class="nurse-readout-head">${escHtml(cmd)}<button class="cap-btn" onclick="this.closest('.nurse-readout').remove()">✕</button></div>${_nurseRenderPanel(r)}`;
    body.prepend(box);
  } finally { _nurseBusy = false; }
}

// 建档：幂等（引擎自己用文件锁保证并发双击也只生一个孩子），无脑调即可
async function nurseryBirth(name) {
  try {
    const nm = (name || state.nurseryName || NURSE_DEFAULT_NAME).trim().slice(0, 6);
    const r = await fetch(SERVER_BASE + '/api/nursery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'birth', name: nm }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return `⚠️ ${j.error || '引擎没应答'}`;
    state.nurseryName = nm; save();
    return ((j.data || {}).text || '').trim();
  } catch (err) {
    return `⚠️ 连不上育儿室：${err.message}`;
  }
}
