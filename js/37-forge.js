// ============================================================
// 无缝换窗（选择性对话迁移）
// 一个对话聊长了总要换新的，但换新的就等于从零开始——上下文裁剪那条路
// （见 buildApiMessages 里的 [上下文裁剪]）只会从头砍，砍掉的往往正是
// "我们是怎么走到这儿的"，留下的是最近几句流水账。
//
// 这里换个思路：**让用户自己挑哪几轮值得带走**。挑出来的轮原样复制进新对话，
// 中间跳过的部分插一句「隔了 4 天，省略了 62 条」，模型就知道这不是连续的。
//
// 三个决定，都跟 forge-picker 那份说明书一致，理由是自己的：
//
// 1) **按"轮"选，不按条选。** 一轮 = 一条用户消息 + 它后面所有 AI 回复。
//    只带走 AI 那半边等于让模型看见自己凭空说了段话；只带用户那半边更糟。
//
// 2) **不连续的地方必须显式说出来。** 不说的话，模型看到的是一串紧挨着的消息，
//    会默认它们前后相接——于是"三天前说的事"和"刚才说的事"被当成一口气说完的。
//
// 3) **原对话一个字都不动。** 这是复制，不是搬家。挑错了重来一次就行。
//
// 实现上跟 forge-picker 分道扬镳的一点：它是生成一段文本喂给新会话，
// 而 GranCyan 有真实的 nodes 树，所以这里**直接复制节点**。好处是新对话
// 在回填、渲染、分支、导出各条路径上都跟正常聊出来的对话没有任何区别，
// 一处特殊逻辑都不用加（唯一的例外是 gapNote，见下）。
// ============================================================

// 时间断层挂在**被复制节点自己身上**（node.gapNote），不新增节点类型。
// 新增一种节点的话，渲染、回填、分支、多选、导出、token 统计每一处都得认它，
// 漏一处就是一个静默的怪状态；挂字段只要渲染和回填各加一处。
// 回填那处在 buildApiMessages 里（js/05-prompts-api.js）。

// 附件（图片 / 引用 / 视频说明 / 语音情绪）一律深拷贝再放进新对话。
// structuredClone 优先，没有就退回 JSON（旧 WebView 上没有 structuredClone）。
//
// ⚠️ 两条路都失败时**必须抛**，绝不能"拷不动就原样交出去"。
// 原样返回等于新旧对话共享同一个对象，之后在新对话里改一张图的说明，
// 原对话跟着变 —— 而「原对话一个字都不动」正是这个功能敢让人随便试的全部底气。
// 为了"别炸"而静默降级，恰好制造出它本来要防的那个静默 bug。
// 抛出去是安全的：forgeGo 在**写进 state.chats 之前**就全部复制完了，
// 中途失败什么都没留下（见那边的 try/catch）。
function _forgeClone(v) {
  if (v === null || typeof v !== 'object') return v;
  let err = null;
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch (e) { err = e; }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { err = e; }
  throw new Error('这条消息的附件拷不动（' + ((err && err.message) || '未知原因') + '）');
}

var _forgeSel = new Set();        // 选中的轮次序号
var _forgeRounds = [];            // 当前对话切出来的轮
var _forgeNotes = {};             // 轮次序号 → 情绪关键词（可选，用户手填）
var _forgeKeepImgs = true;        // 带不带图片

// 把当前分支切成"轮"。一轮从一条 user 消息开始，到下一条 user 之前结束。
// ⚠️ 走 getMessagePath(chat, chat.headId) 而不是 Object.values(chat.nodes)：
// 后者会把**所有分支**的节点混在一起（重试、编辑都会留下旁支），
// 那些节点在界面上根本看不见，混进来就是搬走一堆自己没见过的话。
// ⚠️ 开头就是 AI 的历史（老数据里有：以前"继续"过的对话、导入的记录）会切出
// 一个 user 为空的轮。这种轮**必须标成 orphan 且不给选**——搬走它的话新对话
// 会以 assistant 消息开头，正是这个文件开头第 1 条明说要避免的
//「模型看见自己凭空说了段话」。不悄悄丢掉是因为：她在面板上得看得见
// "这里确实有东西、只是带不走"，无声消失只会让人以为程序漏了几条。
function forgeSplitRounds(chat) {
  const path = (typeof getMessagePath === 'function' ? getMessagePath(chat, chat.headId) : []) || [];
  const rounds = [];
  for (const n of path) {
    if (n.role === 'user' || !rounds.length) {
      const isOrphan = n.role !== 'user';
      rounds.push({
        user: isOrphan ? null : n,
        ais: isOrphan ? [n] : [],
        nodes: [n],
        orphan: isOrphan,
      });
    } else {
      const cur = rounds[rounds.length - 1];
      cur.ais.push(n);
      cur.nodes.push(n);
    }
  }
  return rounds;
}

function forgeSelectable(i) { return !!_forgeRounds[i] && !_forgeRounds[i].orphan; }

// 一轮的时间戳：优先用用户那条（那是"这轮什么时候开始的"）
function _forgeTime(r) {
  return (r.user && r.user.timestamp) || (r.ais[0] && r.ais[0].timestamp) || 0;
}
// 一轮的结束时间。算间隔要用**上一段的末尾 → 这一段的开头**，
// 不能两头都拿开头：上一轮 AI 拖了很久才答完、紧接着就问下一句时，
// 拿开头算会得出"隔了几天"，而实际上是连着说的。
function _forgeEndTime(r) {
  const last = r.nodes[r.nodes.length - 1];
  return (last && last.timestamp) || _forgeTime(r);
}

// 多模型节点只带**选中的那一版**。variants 里其余的是没被采纳的稿子，
// 带过去既占上下文又会让模型看见自己"同时说了三段互相矛盾的话"。
function _forgeVariant(n) {
  if (!n.isMulti || !Array.isArray(n.variants)) return null;
  return n.variants[n.chosenVariant || 0] || n.variants[0] || null;
}

// 例外（2026-10-13 模型隔离）：**别家**写的那版要留下。单聊里每家只看得见自己家的话
//（05-prompts-api.js 的 modelIsolatePath），她挑了AI 那版时 GPT 得靠自己那版接上——
// 换窗时把它扔了，GPT 到了新窗口就只剩「这一轮省略了」。
// 同一家的落选稿照旧不带（同一个模型看见自己写过两版，正是上面说的自相矛盾）。
// 返回要留的 variants（选中的那版排第一），只剩一家时返回 null = 照旧降级成普通节点。
function _forgeFamilyVariants(n) {
  if (!n.isMulti || !Array.isArray(n.variants) || typeof modelFamilyOfNode !== 'function') return null;
  const ci = n.variants[n.chosenVariant || 0] ? (n.chosenVariant || 0) : 0;
  const chosen = n.variants[ci];
  if (!chosen) return null;
  const famOf = v => modelFamilyOfNode({ role: 'ai', modelId: v.modelId, modelNickname: v.modelNickname }) || ('?' + v.modelId);
  const seen = new Set([famOf(chosen)]);
  const out = [chosen];
  n.variants.forEach((v, i) => {
    if (i === ci || !v || !v.content || v.streaming) return;
    const f = famOf(v);
    if (seen.has(f)) return;
    seen.add(f); out.push(v);
  });
  if (out.length < 2) return null;
  // 思考链照旧不带（换窗的全部意义）
  return out.map(v => { const c = _forgeClone(v); delete c.reasoning; delete c.streaming; return c; });
}

function _forgeAiText(n) {
  const v = _forgeVariant(n);
  return (v ? v.content : n.content) || '';
}

// 模型身份要从**被选中的那一版**上取。isMulti 的外层节点通常没有 modelId
//（它只是个容器，身份在每个 variant 里），从外层取会让搬过去的消息丢掉作者，
// 或者更糟——认成另一个模型：头像、昵称、群聊里"谁说的"全跟着错。
function _forgeAiIdentity(n) {
  const v = _forgeVariant(n);
  return {
    modelId: (v && v.modelId) || n.modelId || null,
    modelNickname: (v && v.modelNickname) || n.modelNickname || null,
  };
}

function _forgeAiTokens(n) {
  const v = _forgeVariant(n);
  const src = v || n;
  return src.tokens || (typeof estimateTokens === 'function' ? estimateTokens(src.content || '') : 0);
}

function _forgeRoundTokens(r) {
  let t = 0;
  if (r.user) t += r.user.tokens || (typeof estimateTokens === 'function' ? estimateTokens(r.user.content || '') : 0);
  for (const a of r.ais) t += _forgeAiTokens(a);
  return t;
}

// 「隔了多久」。写给模型看的，所以宁可粗一点也要是人话：
// 精确到分钟对它理解"这中间断过"没有帮助，反而像日志。
function forgeGapText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 30) return '';                       // 半小时内不算断层，别为连着聊的两轮插废话
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo} 个月` : `${Math.round(mo / 12)} 年`;
}

// 选中的轮 → 每一轮该不该带 gapNote，带的话写什么。
// 只在**真的跳过了东西**时才写：连着选的两轮之间什么都没漏，插一句
// 「省略了 0 条」纯属噪音，还会让模型以为中间有它看不到的内容。
function forgePlan() {
  const picked = [...(_forgeSel)].sort((a, b) => a - b);
  const out = [];
  let prevIdx = -1;
  for (const idx of picked) {
    const r = _forgeRounds[idx];
    let gapNote = '';
    if (prevIdx >= 0 && idx > prevIdx + 1) {
      // 中间跳过的轮里一共有多少条消息
      let skipped = 0;
      for (let i = prevIdx + 1; i < idx; i++) skipped += _forgeRounds[i].nodes.length;
      const gap = forgeGapText(_forgeTime(r) - _forgeEndTime(_forgeRounds[prevIdx]));
      gapNote = gap ? `中间隔了 ${gap}，省略了 ${skipped} 条` : `中间省略了 ${skipped} 条`;
    } else if (prevIdx >= 0) {
      // 相邻两轮，但中间可能真的隔了很久（比如昨天聊完今天接着聊）
      const gap = forgeGapText(_forgeTime(r) - _forgeEndTime(_forgeRounds[prevIdx]));
      if (gap) gapNote = `中间隔了 ${gap}`;
    }
    out.push({ idx, gapNote, note: (_forgeNotes[idx] || '').trim() });
    prevIdx = idx;
  }
  return out;
}

function forgeSelectedTokens() {
  let t = 0;
  for (const i of _forgeSel) t += _forgeRoundTokens(_forgeRounds[i]);
  return t;
}

// ── 执行迁移 ──
// 复制节点：id 一律重新分配（nextId），parentId 串成一条直链。
// **不能沿用原 id** —— 那是全局计数器发的，撞 id 会被 merge 吞掉整段对话
//（2026-07-15 那次对话静默消失就是共享计数器播种漏了对话 id，见记忆库）。
function forgeGo() {
  const chat = getActiveChat();
  if (!chat) return;
  const plan = forgePlan();
  if (!plan.length) { showToast('一轮都没选，先勾几轮想带走的', 'info', 3000); return; }

  const src = chat;
  const c = {
    id: nextId(),
    title: (src.title || '对话') + '（续）',
    nodes: {}, headId: null, isPinned: false,
    // 模型选择、消息上限、群聊开关都跟着走：换个窗口是想接着聊，
    // 不是想重新配一遍。activeModelIds 复制一份而不是共享引用。
    activeModelIds: Array.isArray(src.activeModelIds) ? [...src.activeModelIds] : [],
    msgLimit: src.msgLimit || 0,
    isGroupChat: !!src.isGroupChat,
    totalTokens: 0,
    forgedFrom: src.id,          // 从哪儿搬来的，纯留痕
  };

  // 整段复制包在 try 里：任何一条附件拷不动就整次放弃。
  // **不能只跳过那一条**——少搬一条消息而不吭声，正是这个功能最怕的那种静默错。
  // 这时 c 还没进 state.chats，放弃掉什么痕迹都不留。
  let parent = null;
  let total = 0;
  try {
  for (const step of plan) {
    const r = _forgeRounds[step.idx];
    let first = true;
    for (const n of r.nodes) {
      const id = nextId();
      const isUser = n.role === 'user';
      const node = {
        id, parentId: parent, role: n.role,
        content: isUser ? (n.content || '') : _forgeAiText(n),
        timestamp: n.timestamp || Date.now(),
      };
      // 断层标记挂在这一轮的**第一条**上（用户那条），模型顺着读先看到"这里断过"
      if (first && step.gapNote) node.gapNote = step.gapNote;
      // 情绪关键词只挂 AI 那侧：它替代的是整条思考链，
      // 一个词就够，带完整独白等于把省下来的上下文又填回去
      if (!isUser && step.note) node.moodNote = step.note;
      if (isUser) {
        node.tokens = n.tokens || (typeof estimateTokens === 'function' ? estimateTokens(n.content || '') : 0);
        if (n.userThinking) node.userThinking = n.userThinking;
        // ⚠️ 深拷贝，不是 [...arr]。浅拷只换了数组外壳，里面的图片/引用**对象还是同一个**——
        // 以后在新对话里改一张图的说明或上传状态，原对话那边跟着变，
        // 而"原对话一个字都不动"正是这个功能敢让人随便试的全部底气。
        // voiceEmo 也是对象，同理。
        if (n.quotes) node.quotes = _forgeClone(n.quotes);
        if (_forgeKeepImgs && n.images) node.images = _forgeClone(n.images);
        if (_forgeKeepImgs && n.videoNote) node.videoNote = _forgeClone(n.videoNote);
      } else {
        // reasoning（思考链）**故意不带**：它是当时想给谁看的过程，
        // 换窗的全部意义就是甩掉这部分重量。moodNote 是它的替身。
        const fam = _forgeFamilyVariants(n);
        if (fam) {
          // 跟原来的多模型节点同一个形状：外层没有 content/modelId，身份和正文都在 variants 里
          delete node.content;
          node.isMulti = true;
          node.chosenVariant = 0;
          node.variants = fam;
        } else {
          const who = _forgeAiIdentity(n);
          if (who.modelId) node.modelId = who.modelId;
          if (who.modelNickname) node.modelNickname = who.modelNickname;
        }
        node.tokens = _forgeAiTokens(n);
      }
      // 语音**两侧都要带**。这块原先整个压在上面的 isUser 分支里，可 AI 自己也会发语音条
      // （[[VOICE]]），于是 AI 的语音换窗之后连 audio 都没有，直接退化成一条普通文字。
      // voiceParts 再漏的话，拆开的语音会退回单气泡、表情埋回展开正文 —— 那种情况 audio 还在，
      // 看着像条正常语音，一点报错都没有。voiceEmo 和 voiceParts 都是对象，深拷不能省，
      // 否则改新对话会串改原对话（「原对话一个字都不动」是这个功能的全部底气）。
      if (n.audio) {
        node.audio = n.audio;
        node.audioDur = n.audioDur;
        if (n.voiceEmo) node.voiceEmo = _forgeClone(n.voiceEmo);
        if (n.voiceParts) node.voiceParts = _forgeClone(n.voiceParts);
      }
      c.nodes[id] = node;
      parent = id;
      total += (node.tokens || (typeof estimateTokens === 'function' ? estimateTokens(node.content) : 0));
      first = false;
    }
  }
  } catch (e) {
    showToast(`搬不过去：${e.message}。原来那个对话没有受影响`, 'error', 7000);
    return;
  }
  c.headId = parent;
  c.totalTokens = total;

  state.chats.unshift(c);
  state.activeChatId = c.id;
  save();
  renderChatList(); renderMessages(); renderModelPills();
  closeForge();
  const gaps = plan.filter(p => p.gapNote).length;
  showToast(`🪟 搬过来 ${plan.length} 轮${gaps ? `，标了 ${gaps} 处时间断层` : ''}。原来那个对话一个字都没动`, 'success', 5000);
}

// ── 面板 ──
function openForge() {
  const chat = getActiveChat();
  if (!chat) { showToast('先打开一个对话', 'info', 2500); return; }
  _forgeRounds = forgeSplitRounds(chat);
  if (!_forgeRounds.length) { showToast('这个对话还是空的，没什么好搬的', 'info', 3000); return; }
  _forgeSel = new Set();
  _forgeNotes = {};
  // 默认勾最近 3 轮：换窗最常见的意图就是"接着刚才聊"，
  // 一进来全空的话每次都要先手动点几下
  for (let i = Math.max(0, _forgeRounds.length - 3); i < _forgeRounds.length; i++) {
    if (forgeSelectable(i)) _forgeSel.add(i);
  }
  document.getElementById('forgeModal')?.classList.remove('hidden');
  forgeRefresh();
}
function closeForge() { document.getElementById('forgeModal')?.classList.add('hidden'); }

// 所有选择入口都要过 forgeSelectable —— 「全选」是最容易把 orphan 轮
// 悄悄勾进去的那一个（它本来就叫全选）。
function forgeToggle(i) {
  if (!forgeSelectable(i)) return;
  _forgeSel.has(i) ? _forgeSel.delete(i) : _forgeSel.add(i);
  forgeRefresh();
}
function forgeSelectAll(on) {
  _forgeSel = new Set();
  if (on) for (let i = 0; i < _forgeRounds.length; i++) if (forgeSelectable(i)) _forgeSel.add(i);
  forgeRefresh();
}
function forgeSelectLast(n) {
  _forgeSel = new Set();
  for (let i = Math.max(0, _forgeRounds.length - n); i < _forgeRounds.length; i++) {
    if (forgeSelectable(i)) _forgeSel.add(i);
  }
  forgeRefresh();
}
function forgeSetNote(i, v) {
  // ⚠️ 只改数据、**不重画**。这个面板是整块 innerHTML 重画的，
  // 输入过程中重画会把焦点和光标位置一起丢掉（每敲一个字跳一次）。
  _forgeNotes[i] = v;
}
function forgeSetKeepImgs(on) { _forgeKeepImgs = !!on; forgeRefresh(); }

function _forgeSnip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : (s || '（空）');
}
function _forgeWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function forgeRefresh() {
  const body = document.getElementById('forgeBody');
  if (!body) return;
  const plan = forgePlan();
  const gapOf = {};
  for (const p of plan) if (p.gapNote) gapOf[p.idx] = p.gapNote;

  const tok = forgeSelectedTokens();
  const allTok = _forgeRounds.reduce((s, r) => s + _forgeRoundTokens(r), 0);
  const pct = allTok ? Math.round(tok / allTok * 100) : 0;

  let h = `<div class="forge-stats">
    <div class="study-stat"><b>${_forgeSel.size}</b><span>选中的轮</span></div>
    <div class="study-stat"><b>${_forgeRounds.length}</b><span>总共几轮</span></div>
    <div class="study-stat"><b>${tok > 9999 ? (tok / 1000).toFixed(1) + 'k' : tok}</b><span>大约 token</span></div>
    <div class="study-stat"><b>${pct}%</b><span>占原来的</span></div>
  </div>`;

  h += `<div class="forge-quick">
    <button class="study-imp-toggle" onclick="forgeSelectLast(3)">最近 3 轮</button>
    <button class="study-imp-toggle" onclick="forgeSelectLast(10)">最近 10 轮</button>
    <button class="study-imp-toggle" onclick="forgeSelectAll(true)">全选</button>
    <button class="study-imp-toggle" onclick="forgeSelectAll(false)">全不选</button>
    <label class="forge-imgs"><input type="checkbox" onchange="forgeSetKeepImgs(this.checked)"${_forgeKeepImgs ? ' checked' : ''}> 带上图片</label>
  </div>`;

  h += `<div class="forge-go-row">
    <button class="study-go" onclick="forgeGo()">🪟 搬到新对话（原对话不动）</button>
  </div>`;

  h += `<div class="forge-list">`;
  for (let i = 0; i < _forgeRounds.length; i++) {
    const r = _forgeRounds[i];
    const on = _forgeSel.has(i);
    const orphan = !!r.orphan;
    if (gapOf[i]) h += `<div class="forge-gap">⌇ ${escHtml(gapOf[i])}</div>`;
    h += `<div class="forge-round${on ? ' forge-on' : ''}${orphan ? ' forge-orphan' : ''}">
      <label class="forge-pick">
        <input type="checkbox" onchange="forgeToggle(${i})"${on ? ' checked' : ''}${orphan ? ' disabled' : ''}>
        <span class="forge-when">${escHtml(_forgeWhen(_forgeTime(r)))}</span>
      </label>
      <div class="forge-body">
        ${orphan
          ? `<div class="forge-u forge-orphan-why">这条 AI 消息前面没有对应的提问，带不走（搬过去新对话会以 AI 开头）</div>`
          : `<div class="forge-u">${escHtml(_forgeSnip(r.user && r.user.content, 90))}</div>`}
        ${r.ais.map(a => `<div class="forge-a">${escHtml(_forgeSnip(_forgeAiText(a), 110))}</div>`).join('')}
        ${on && r.ais.length ? `<input class="forge-note" type="text" placeholder="这一轮的情绪（可留空，一个词就够：心疼 / 在气头上）"
            value="${escHtml(_forgeNotes[i] || '')}" oninput="forgeSetNote(${i}, this.value)">` : ''}
      </div>
      <span class="forge-tok">${_forgeRoundTokens(r)}</span>
    </div>`;
  }
  h += `</div>`;
  body.innerHTML = h;
}

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('forgeModal');
  if (m && !m.classList.contains('hidden')) closeForge();
});
