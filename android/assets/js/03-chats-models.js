function getActiveChat() { return state.chats.find(c => c.id === state.activeChatId); }

// fromHeader:从右上角快捷按钮进来的。侧栏那颗按钮在手机上点完要顺手关侧栏，
// 但右上角这颗按下时侧栏本来就是关的，再 toggle 一次反而会把侧栏弹开。
function createNewChat(fromHeader) {
  // 新建对话 = 活跃对话变了，正念着的那条消息不在视图里了
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  if (typeof cancelComposerEdit === 'function') cancelComposerEdit();   // 同 switchChat
  // activeModelIds 用 [] 而不是 null：getActiveChatModelIds 对 null 会回落成
  // 「全选」（state.configs.map），于是新对话一发消息二十多个模型一起答，
  // 每次都得手动去掉——空数组才是「一个都没选」。
  // ⚠️ 只动新建的对话，历史对话的 null 保持原样，否则老对话会突然全部变成一个模型都不选。
  const c = { id: nextId(), title: '崭新の对话', nodes: {}, headId: null, isPinned: false,
              activeModelIds: [], msgLimit: 0, isGroupChat: false, totalTokens: 0 };
  state.chats.unshift(c); state.activeChatId = c.id;
  save(); renderChatList(); renderMessages(); renderModelPills();
  if (isMobileLayout() && !fromHeader) toggleSidebar();
}

function deleteChat(id, e) {
  e.stopPropagation();
  // 删掉对话之后会自动切到另一个，音频不叫停就跟过去了
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  if (!confirm('确定要删除这个对话吗？(。﹏。*) \n \n \n      （三思而后行啊…')) return;
  const chatToDelete = state.chats.find(c => c.id === id);
  if (chatToDelete) {
    state.trash.push({
      type: 'chat',                              // ← 加 type 字段，区分"单条消息"和"整段对话"
      chatData: JSON.parse(JSON.stringify(chatToDelete)),  // 深拷贝整段对话
      deletedAt: new Date().toISOString()
    });
  }
  state.chats = state.chats.filter(c => c.id !== id);
  /* 打墓碑。⚠️ 必须打 —— 光删本地 + 删云端是不够的：
     云端删除会失败（离线、token 过期），而「清点补漏」每次启动都会把
     本地没有、云端有的对话拉回来。墓碑是唯一能表达「我不要它了」的东西。
     见 02-state.js 里 markChatDeleted 那段。 */
  markChatDeleted(id, false, chatToDelete?.importedFrom?.uuid);
  if (!state.chats.length) createNewChat();
  else if (state.activeChatId === id) state.activeChatId = state.chats[0].id;
  pruneDeadFavs();
  save(); renderChatList(); renderMessages();
  purgeDeletedChatsFromCloud([id]);
}

/* 删云端 + 把删成功的墓碑标 done。三个删除入口共用。
   ⚠️ 原来这里是 `.then(({error}) => ...)` 的即发即忘写法，有两个静默失败：
      ① 网络异常走的是 reject 分支，而那段只接了成功回调 —— 未处理的 rejection，
        什么都不弹，人以为删掉了；
      ② 就算 alert 弹出来，也没有任何重试，那条云端记录就永远留着了。
      现在改成：失败不要紧，墓碑还是 'pending'，下次同步 retryPendingChatDeletes 会再试。 */
function purgeDeletedChatsFromCloud(ids) {
  if (!currentUser || !ids || !ids.length) return;
  Promise.resolve(deleteChatsFromCloud(ids))
    .then(done => {
      if (!done || !done.length) return;      // 没删成也别吭声，墓碑挡着，下次自动重试
      done.forEach(id => markTombstoneCloudDone(id));
      save();
    })
    .catch(e => console.warn('[云同步] 删除对话失败，已留待重试:', e && e.message));
}

function togglePin(id, e) {
  e.stopPropagation();
  const c = state.chats.find(c => c.id === id);
  if (!c) return; // 防止空指针错误
  c.isPinned = !c.isPinned;
  save(); renderChatList();
}

async function editChatTitle(id, e) {
  e?.stopPropagation();
  const c = state.chats.find(x => x.id === id);
  if (!c) return; // 防止空指针错误
  const t = await appPrompt('修改对话名称', c.title);
  // ⚠️ appPrompt 是 textarea，Shift+Enter 能敲进换行，光 trim() 只去首尾。
  //    标题本来就该是一行；而且它会被拼进「看别的对话」的目录送给模型，
  //    带换行的标题在提示词里看起来就像新的一行系统说明（见 28-chat-peek.js 的 _chatPeekMeta）。
  const title = t ? t.replace(/\s+/g, ' ').trim() : '';
  if (title) { c.title = title; save(); renderChatList(); }
}

function switchChat(id) {
  // 正念着就别跟到新对话里去 —— 承载暂停按钮的那条消息马上就不在视图里了
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  // 正在输入框里改上一个对话的某条消息：换对话就算不改了，草稿还给她（不然改的字会被当新消息发到这边来）
  if (typeof cancelComposerEdit === 'function') cancelComposerEdit();
  state.activeChatId = id; renderChatList(); renderMessages();
  idbSet('kuro_activeChat', String(id));
  renderModelPills(); updateHeaderTokenInfo(); renderConvSettingsBar(); updateGroupBoardBtn();
  if (isMobileLayout()) toggleSidebar();
}

/* 侧栏对话条目的线条图标（ui-polish/sidebar A04：原来是 📌📍✎🗑🖼 彩色 emoji，每行一串很吵）。
   描边色跟 currentColor 走，样式在 grancyan.css 的 .sb-ic。 */
const _SB_IC = {
  pin:    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  unpin:  '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  edit:   '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  trash:  '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  image:  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  users:  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
const _sbIc = (k, cls = '') => `<svg class="sb-ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${_SB_IC[k]}</svg>`;

function renderChatList() {
  const list   = document.getElementById('chatList');
  const search = document.getElementById('chatSearch').value.toLowerCase();
  const filter = c => (c.title || '').toLowerCase().includes(search);
  const byTimeDesc = (a, b) => (getChatLastTimestamp(b) || 0) - (getChatLastTimestamp(a) || 0);
  const pinned = state.chats.filter(c =>  c.isPinned && filter(c)).sort(byTimeDesc);
  const rest   = state.chats.filter(c => !c.isPinned && filter(c)).sort(byTimeDesc);

  const renderItem = c => {
    const tokens   = getChatTotalTokens(c);
    const msgCount = c.nodes ? Object.keys(c.nodes).length : 0;
    const lastTs   = getChatLastTimestamp(c);
    const timeStr  = lastTs ? relativeTime(lastTs) : '';
    const isGroup  = c.isGroupChat;
    const groupAvatarHtml = isGroup && c.groupAvatar
      ? `<img class="chat-group-av" src="${c.groupAvatar}" alt="">`
      : isGroup
        ? `<span class="chat-group-av">${_sbIc('users')}</span>`
        : '';
    const sel = state.chatSelectMode;
    const isChosen = state.selectedChatIds.has(c.id);
    /* tabindex + role：键盘 Tab 能走到每一条（A34），回车 / 空格 = 点它。
       只认落在条目本身上的按键 —— 里面的 置顶/改名/删除 是真 <button>，自己会响应回车，
       冒上来再 click 一次条目就等于「删完顺手切过去」。 */
    return `
      <div data-cid="${c.id}" tabindex="0" role="button" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();this.click()}" onclick="${sel ? `toggleChatSelection(${c.id},event)` : `switchChat(${c.id})`}" class="chat-item ${state.activeChatId===c.id && !sel?'active':''}${isGroup?' is-group':''}">
        ${sel ? `<input type="checkbox" ${isChosen?'checked':''} onclick="toggleChatSelection(${c.id},event)" style="width:15px;height:15px;accent-color:${activeAccent()};flex-shrink:0;margin-right:8px;cursor:pointer">` : ''}
        ${groupAvatarHtml}
        <div class="chat-item-left">
          <div class="chat-item-title-row">
            <span class="chat-item-title">${c.isPinned ? _sbIc('pin', 'chat-pin-ic') : ''}${escHtml(c.title)}</span>
            ${timeStr ? `<span class="chat-item-time">${timeStr}</span>` : ''}
          </div>
          <div class="chat-item-meta">
            ${c.importedFrom ? `<span class="cc-badge" title="从 claude.ai 导入的老对话">claude.ai</span>` : ''}
            ${msgCount > 0 ? `<span>${msgCount} 条</span>` : ''}
            ${tokens > 0 ? `<span class="token-badge">~${fmtTokens(tokens)}</span>` : ''}
          </div>
        </div>
        ${sel ? '' : `
        <div class="chat-item-actions">
          ${isGroup ? `<button onclick="setGroupChatAvatar(${c.id},event)" title="设置群聊头像" aria-label="设置群聊头像">${_sbIc('image')}</button>` : ''}
          <button onclick="togglePin(${c.id},event)" title="${c.isPinned?'取消置顶':'置顶'}" aria-label="${c.isPinned?'取消置顶':'置顶'}">${_sbIc(c.isPinned ? 'unpin' : 'pin')}</button>
          <button onclick="editChatTitle(${c.id},event)" title="重命名" aria-label="重命名">${_sbIc('edit')}</button>
          <button class="chat-act-del" onclick="deleteChat(${c.id},event)" title="删除" aria-label="删除">${_sbIc('trash')}</button>
        </div>`}
      </div>`;
  };

  let html = '';
  if (pinned.length) html += `<div class="chat-section-label">已置顶</div>` + pinned.map(renderItem).join('');
  if (rest.length)   html += `<div class="chat-section-label">最近</div>`   + rest.map(renderItem).join('');
  list.innerHTML = html;

  // 更新 header 标题和头像
  const activeChat = getActiveChat();
  document.getElementById('currentChatTitle').innerText = activeChat?.title || '崭新の对话';
  // 顶栏标题旁那枚「claude.ai 时期」：一进对话就知道这是哪个时候的
  const ccEra = document.getElementById('ccEraBadge');
  if (ccEra) {
    const f = activeChat?.importedFrom;
    ccEra.classList.toggle('hidden', !f);
    if (f) {
      const d = f.createdAt ? new Date(f.createdAt) : null;
      ccEra.textContent = 'claude.ai 时期' + (d ? ` · ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '');
    }
  }
  const avatarEl = document.getElementById('currentChatAvatar');
  if (avatarEl) {
    if (activeChat?.isGroupChat && activeChat?.groupAvatar) {
      avatarEl.src = activeChat.groupAvatar;
      avatarEl.style.display = 'block';
    } else {
      avatarEl.style.display = 'none';
    }
  }
}

/* ── 手机：长按一条对话 → 亮出它的 置顶 / 改名 / 删除 ──
   A04：操作按钮原来在手机上每行常驻一串 emoji，把标题挤得只剩五六个字。
   现在按钮浮在行上、平时藏着：桌面 hover / 键盘聚焦时出现；手机上当前这条常亮，
   别的条目长按出来（.acts-open）。
   用 document 级委托，跟 29-multiselect 的左划同一个路子，不往模板里塞 ontouch*。 */
const SB_PRESS_MS = 480;
let _sbPress = null;
let _sbEatClickUntil = 0;

function _sbCloseActs(except) {
  document.querySelectorAll('.chat-item.acts-open').forEach(el => { if (el !== except) el.classList.remove('acts-open'); });
}
function _sbOpenActs(el) {
  if (!el || !el.isConnected || state.chatSelectMode) return;
  _sbCloseActs(el);
  el.classList.add('acts-open');
  // 松手后浏览器会补一个 click —— 不吃掉的话刚亮出按钮就切走了对话
  _sbEatClickUntil = Date.now() + 800;
  try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
}
const _sbEl = e => (e.target instanceof Element ? e.target : null);

document.addEventListener('touchstart', e => {
  const tgt = _sbEl(e), t = e.touches && e.touches[0];
  if (!tgt || !t || e.touches.length > 1) { _sbPress = null; return; }
  if (tgt.closest('.chat-item-actions')) { _sbPress = null; return; }   // 点的就是亮出来的按钮
  const el = tgt.closest('.chat-item[data-cid]');
  if (!el) { _sbPress = null; _sbCloseActs(); return; }                 // 点别处 = 收起
  if (state.chatSelectMode) { _sbPress = null; return; }
  const p = { x: t.clientX, y: t.clientY, el, timer: 0 };
  p.timer = setTimeout(() => { if (_sbPress === p) { _sbPress = null; _sbOpenActs(el); } }, SB_PRESS_MS);
  _sbPress = p;
}, { passive: true });

document.addEventListener('touchmove', e => {
  const p = _sbPress, t = e.touches && e.touches[0];
  if (!p || !t) return;
  // 在滚列表 —— 不算长按
  if (Math.abs(t.clientX - p.x) > 10 || Math.abs(t.clientY - p.y) > 10) { clearTimeout(p.timer); _sbPress = null; }
}, { passive: true });

const _sbPressEnd = () => { if (_sbPress) { clearTimeout(_sbPress.timer); _sbPress = null; } };
document.addEventListener('touchend', _sbPressEnd, { passive: true });
document.addEventListener('touchcancel', _sbPressEnd, { passive: true });

document.addEventListener('click', e => {
  if (Date.now() > _sbEatClickUntil) return;
  const tgt = _sbEl(e);
  if (!tgt || !tgt.closest('.chat-item[data-cid]') || tgt.closest('.chat-item-actions')) return;
  _sbEatClickUntil = 0;
  e.preventDefault(); e.stopPropagation();
}, true);

/* 安卓长按还会触发 contextmenu（WebView 可能弹系统菜单 / 选中文字）。
   对话条目上拦掉，并且当成「长按到了」—— 有的机器 contextmenu 比上面的计时器先到、
   接着来一个 touchcancel 把计时器清了，不在这里补一下就什么都没亮。
   桌面（精确指针）不拦，留给 29-multiselect 的「按住 Ctrl 可以多选」提示。 */
document.addEventListener('contextmenu', e => {
  const el = _sbEl(e)?.closest('.chat-item[data-cid]');
  if (!el) return;
  try { if (window.matchMedia('(pointer:fine)').matches) return; } catch (_) { return; }
  e.preventDefault();
  _sbPressEnd();
  _sbOpenActs(el);
});

// 群聊头像设置
async function setGroupChatAvatar(chatId, e) {
  e.stopPropagation();
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const chat = state.chats.find(c => c.id === chatId);
    if (!chat) return;

    // Try Supabase storage
    if (currentUser) {
      try {
        const ext = (file.name.split('.').pop() || 'png').toLowerCase();
        const storagePath = `group_avatars/${currentUser.id}/chat_${chatId}_${Date.now()}.${ext}`;
        const { error: upErr } = await supabaseClient.storage
          .from('avatars').upload(storagePath, file, { upsert: true, contentType: file.type });
        if (!upErr) {
          const { data: urlData } = supabaseClient.storage.from('avatars').getPublicUrl(storagePath);
          const publicUrl = urlData?.publicUrl;
          if (!publicUrl) throw new Error('无法获取公开 URL');
          chat.groupAvatar = publicUrl;
          save(); renderChatList(); renderMessages();
          return;
        }
      } catch(e) { /* fall through */ }
    }
    // Fallback base64
    const r = new FileReader();
    r.onload = ev2 => {
      chat.groupAvatar = ev2.target.result;
      save(); renderChatList(); renderMessages();
    };
    r.readAsDataURL(file);
  };
  inp.click();
}


// ═══════════════════════════════════════════════════════
// MODEL PILLS (header, per-conversation active model toggle)
// ═══════════════════════════════════════════════════════
function getActiveChatModelIds() {
  const chat = getActiveChat();
  if (!chat || !chat.activeModelIds) return state.configs.map(c => c.id);
  return chat.activeModelIds;
}

function ensureLocalClaudeConfig() {
  let conf = state.configs.find(c => c.isLocalClaude);
  if (!conf) {
    const maxId = state.configs.reduce((m, c) => Math.max(m, c.id), 0);
    conf = {
      id: maxId + 1, nickname: '订阅 Claude', modelName: 'claude-local',
      apiKey: '', apiBase: 'http://127.0.0.1:8000', temp: 0.7,
      maxTokens: 8000, maxReplyTokens: 4096,
      avatar: '', persona: '', thinkingMode: 'auto', isLocalClaude: true
    };
    state.configs.push(conf);
    save();
  }
  return conf;
}

function setLocalClaudeModel(model) {
  const conf = ensureLocalClaudeConfig();
  conf.localModel = model;
  save();
}

// 思考链开关。原来它只长在「模型设置」面板深处（每个 config 一个 think-select），
// 而本地 Claude 的默认是 'auto' —— 而 auto 走的是省 token 的 CLI 路，那条路的
// thinking 块永远是空文本。于是现象就是"设置里明明有思考，就是不显示"。
// 摆到会话栏上和模型下拉并排，让「要不要思考」和「用哪个模型」一样是一眼可见的。
// 仍然不默认改成 always：这个模型的定位就是省 token，直连一轮丢一次会话缓存。
function setLocalClaudeThinking(mode) {
  const conf = ensureLocalClaudeConfig();
  conf.thinkingMode = mode;
  save();
}

// 订阅 Claude 的思考**力度**（claude --effort）。
// 和上面的思考链开关是两件事：这个管它想多深，那个管想完了给不给你看。
// 空串 = 不传，跟着 CLI 自己的默认（Claude Code 默认 xhigh，Opus 5.5 单独算默认 medium）。
function setLocalClaudeEffort(effort) {
  const conf = ensureLocalClaudeConfig();
  conf.localEffort = effort;
  save();
}

function ensureLocalGptConfig() {
  let conf = state.configs.find(c => c.isLocalGpt);
  if (!conf) {
    const maxId = state.configs.reduce((m, c) => Math.max(m, c.id), 0);
    conf = {
      id: maxId + 1, nickname: '订阅 GPT', modelName: 'gpt-local',
      apiKey: '', apiBase: 'http://127.0.0.1:3000', temp: 0.7,
      maxTokens: 8000, maxReplyTokens: 4096,
      avatar: '', persona: '', thinkingMode: 'always', thinkingDefaultMigrated: true, isLocalGpt: true
    };
    state.configs.push(conf);
    save();
  }
  return conf;
}

function setLocalGptModel(model) {
  const conf = ensureLocalGptConfig();
  conf.localModel = model;
  save();
}

// ── Gemini ────────────────────────────────────────────────────────
// 和上面两个长得一样，但它**不是本地**：没有 CLI、没有会话续传、没有电脑操控。
// 摆在一起只是因为「一键切过去 + 选模型」这件事她要的是同一个手感。
function ensureGeminiConfig() {
  let conf = state.configs.find(c => c.isGemini);
  if (!conf) {
    const maxId = state.configs.reduce((m, c) => Math.max(m, c.id), 0);
    conf = {
      id: maxId + 1, nickname: 'Gemini', modelName: 'gemini',
      apiKey: '', apiBase: 'https://generativelanguage.googleapis.com', temp: 0.7,
      maxTokens: 8000, maxReplyTokens: 8192,
      avatar: '', persona: '', thinkingMode: 'auto', isGemini: true
    };
    state.configs.push(conf);
    save();
  }
  return conf;
}

function setGeminiModel(model) {
  const conf = ensureGeminiConfig();
  conf.localModel = model;
  save();
}

// 思考**深度**。这一个下拉同时管「想多深」和「给不给看思考链」。
// ⚠️ 「不想」这一档**不发 thinking_level=minimal**：2026-09-21 端到端实测，
//    gemini-3.8-flash 回 400「Thinking level MINIMAL is not supported for this model」——
//    minimal 在枚举里合法却不是每个模型都吃。所以「不想」只关思考链显示，
//    档位交给模型自己定（见 server/gemini.js 的 buildThinkingConfig）。
function setGeminiThinking(level) {
  const conf = ensureGeminiConfig();
  conf.geminiThinking = level;
  save();
  if (conf.geminiVia === 'sub') prewarmAgy(conf);   // 订阅那边换档＝换模型，预热的那只要换掉
}

// Gemini 自带的联网检索（google_search）。和会话栏上那个「🔍 联网搜索」是两回事：
// 那个是 GranCyan 先替它搜好、把结果塞进 prompt；这个是模型自己决定查不查、查什么。
function toggleGeminiSearch() {
  const conf = ensureGeminiConfig();
  conf.geminiSearch = !conf.geminiSearch;
  save(); renderConvSettingsBar();
}

// 走订阅 / 走 key。订阅＝本机 agy 吃自己账号的 Google AI Pro（server/agy.js），不要 key，
// 但只有 3.8 Flash 三档、没有自己联网、第一个字要等十来秒。
function toggleGeminiVia() {
  const conf = ensureGeminiConfig();
  conf.geminiVia = conf.geminiVia === 'sub' ? '' : 'sub';
  save(); renderConvSettingsBar();
  if (conf.geminiVia === 'sub') prewarmAgy(conf);
}

// 让电脑那边先把 agy 起好等着（冷启动光 init 就 ~8s）。失败无所谓，发消息时会冷启动。
function prewarmAgy(conf) {
  try {
    fetch(SERVER_BASE + '/api/agy-prewarm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: conf.geminiThinking || '' }),
    }).catch(() => {});
  } catch { /* 没有 server 的环境 */ }
}

function toggleGemini() {
  const chat = getActiveChat(); if (!chat) return;
  const geminiConf = ensureGeminiConfig();
  const ids = getActiveChatModelIds().slice();
  const isOn = ids.length === 1 && ids[0] === geminiConf.id;
  if (isOn) {
    const defaultConf = state.configs.find(c => !c.isLocalClaude && !c.isLocalGpt && !c.isGemini);
    chat.activeModelIds = defaultConf ? [defaultConf.id] : ids;
  } else {
    chat.activeModelIds = [geminiConf.id];
  }
  save(); renderModelPills(); renderConvSettingsBar();
}

// 本地 GPT 的思考**深度**（Codex 的 model_reasoning_effort）。
// 以前它是「思考链开关」的附属品（总是→high、关→low），现在独立成一档 ——
// 「要看思考链但别想太久」这种组合以前根本表达不出来。
function setLocalGptEffort(effort) {
  const conf = ensureLocalGptConfig();
  conf.reasoningEffort = effort;
  save();
}

function toggleLocalClaude() {
  const chat = getActiveChat(); if (!chat) return;
  const localConf = ensureLocalClaudeConfig();
  const ids = getActiveChatModelIds().slice();
  const isOn = ids.length === 1 && ids[0] === localConf.id;
  if (isOn) {
    const defaultConf = state.configs.find(c => !c.isLocalClaude);
    chat.activeModelIds = defaultConf ? [defaultConf.id] : ids;
  } else {
    chat.activeModelIds = [localConf.id];
  }
  save(); renderModelPills(); renderConvSettingsBar();
}

function toggleLocalGpt() {
  const chat = getActiveChat(); if (!chat) return;
  const localConf = ensureLocalGptConfig();
  const ids = getActiveChatModelIds().slice();
  const isOn = ids.length === 1 && ids[0] === localConf.id;
  if (isOn) {
    const defaultConf = state.configs.find(c => !c.isLocalClaude && !c.isLocalGpt);
    chat.activeModelIds = defaultConf ? [defaultConf.id] : ids;
  } else {
    chat.activeModelIds = [localConf.id];
  }
  save(); renderModelPills(); renderConvSettingsBar();
}

function renderModelPills() {
  const wrap = document.getElementById('modelPillsWrap');
  const activeIds = getActiveChatModelIds();
  const _actives = state.configs.filter(c => activeIds.includes(c.id));
  const activeNames = _actives.length > 1
    ? _actives[0].nickname + ' +' + (_actives.length - 1)
    : (_actives[0]?.nickname || '选择模型');
  
  const allSelected = state.configs.length > 0 && state.configs.every(c => activeIds.includes(c.id));
  if (typeof refreshEmptyEcho === 'function') refreshEmptyEcho();
  wrap.innerHTML = `
    <div style="position:relative" id="modelDropdownWrap">
      <button onclick="toggleModelDropdown(event)"
        style="display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;
          font-size:12px;font-weight:600;border:1px solid var(--border-mid);
          background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;
          max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block"></span>
        ${escHtml(activeNames)}
        <span style="opacity:.7">▾</span>
      </button>
      <div class="hidden" style="position:absolute;right:0;top:110%;background:var(--bg-elevated);
           border:1px solid var(--border-mid);border-radius:10px;padding:6px;min-width:160px;max-width:200px;word-break:break-word;max-width:calc(100vw - 16px);word-break:break-all;z-index:9999;display:flex;flex-direction:column;gap:2px;">
        <div onclick="modelSelectAllClick()" ondblclick="modelSelectAllDbl()"
          title="单击全选，双击全不选"
          style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;cursor:pointer;
                 font-size:12px;font-weight:700;user-select:none;
                 color:${allSelected?'var(--accent)':'var(--text-dim)'};
                 border-bottom:1px solid var(--border-mid);margin-bottom:2px">
          <span style="width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.7"></span>
          ✔ 全选（双击=全不选）
        </div>
        ${modelGroups().map(g => {
          // 树拍平成一列，靠左边距体现层级。分组标题本身可点：整组（含子分组）勾上 / 取消，
          // 组里全选中时标题也跟着高亮。
          const gIds = state.configs.filter(c => mgUnder(modelGroupOf(c), g.path)).map(c => c.id);
          const gAll = gIds.length > 0 && gIds.every(id => activeIds.includes(id));
          const pad = 10 + Math.max(0, g.depth - 1) * 12;
          return (g.path ? `
          <div data-g="${escHtml(g.path)}" onclick="toggleChatModelGroup(this.dataset.g)"
            title="点一下＝整组全选 / 全不选（含子分组）"
            style="display:flex;align-items:center;gap:6px;padding:6px 10px 4px ${pad}px;margin-top:2px;
                   font-size:11px;font-weight:700;letter-spacing:.02em;cursor:pointer;user-select:none;
                   color:${gAll?'var(--accent)':'var(--text-muted)'}">
            🗂 ${escHtml(g.name)}
          </div>` : '')
          + g.items.map(({ c }) => `
          <div onclick="toggleChatModel(${c.id})"
            style="display:flex;align-items:center;gap:8px;padding:7px 10px 7px ${pad + (g.path?12:0)}px;
                   border-radius:7px;
                   cursor:pointer;font-size:12px;color:${activeIds.includes(c.id)?'var(--accent)':'var(--text-dim)'};
                   background:${activeIds.includes(c.id)?'var(--accent-soft)':'transparent'}">
            <span style="width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.7"></span>
            ${escHtml(c.nickname)}
          </div>`).join('');
        }).join('')}
      </div>
    </div>`;
  // 重渲染前是展开状态就保持展开（点选模型不再自动收回，直到用户自己收）
  if (_modelDropdownOpen) {
    const btn = wrap.querySelector('#modelDropdownWrap > button');
    const dropdown = btn?.nextElementSibling;
    if (btn && dropdown) _positionModelDropdown(btn, dropdown);
  }
}
let _modelDropdownOpen = false;
function _positionModelDropdown(btn, dropdown) {
  const rect = btn.getBoundingClientRect();
  // 用 fixed 定位，脱离所有父容器
  dropdown.style.position = 'fixed';
  dropdown.style.top = (rect.bottom + 6) + 'px';
  const dropW = Math.min(200, window.innerWidth - 16);
  dropdown.style.maxWidth = dropW + 'px';
  dropdown.style.left = Math.min(Math.max(8, rect.right - dropW), window.innerWidth - dropW - 8) + 'px';
  dropdown.style.maxHeight = '280px';
  dropdown.style.overflowY = 'auto';
  dropdown.classList.remove('hidden');
  _modelDropdownOpen = true;
}
function toggleModelDropdown(e) {
  e.stopPropagation();
  const btn = e.currentTarget;
  const dropdown = btn.nextElementSibling;
  const isOpen = !dropdown.classList.contains('hidden');
  if (isOpen) {
    dropdown.classList.add('hidden');
    _modelDropdownOpen = false;
  } else {
    _positionModelDropdown(btn, dropdown);
  }
}

// 点击页面其他地方关闭下拉
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('modelDropdownWrap');
  if (!wrap) return;
  const dropdown = wrap.querySelector('div');
  if (dropdown && !dropdown.classList.contains('hidden') && !wrap.contains(e.target)) {
    dropdown.classList.add('hidden');
    _modelDropdownOpen = false;
  }
});
function toggleChatModel(configId) {
  const chat = getActiveChat(); if (!chat) return;
  let ids = getActiveChatModelIds().slice();
  if (ids.includes(configId)) {
    ids = ids.filter(id => id !== configId); // 允许一个都不选（发送时会提示）
  } else { ids.push(configId); }
  chat.activeModelIds = ids; save(); renderModelPills(); renderConvSettingsBar();
}

// 全选 / 全不选（单击全选，双击全不选；两处模型选择 UI 共用）
let _selAllTimer = null;
function modelSelectAllClick() {
  clearTimeout(_selAllTimer);
  _selAllTimer = setTimeout(() => setAllChatModels(true), 260); // 等一拍，确认不是双击
}
function modelSelectAllDbl() {
  clearTimeout(_selAllTimer);
  setAllChatModels(false);
}
function setAllChatModels(on) {
  const chat = getActiveChat(); if (!chat) return;
  chat.activeModelIds = on ? state.configs.map(c => c.id) : [];
  save(); renderModelPills(); renderConvSettingsBar();
  showToast(on ? '✔ 已选择全部模型' : '已取消选择所有模型');
}

// ═══════════════════════════════════════════════════════
// PER-CONVERSATION SETTINGS BAR
// ═══════════════════════════════════════════════════════
function toggleConvSettings() {
  state.convSettingsOpen = !state.convSettingsOpen;
  document.getElementById('convSettingsBar').classList.toggle('hidden', !state.convSettingsOpen);
  document.getElementById('convSettingsToggle').classList.toggle('active', state.convSettingsOpen);
  if (state.convSettingsOpen) convBarApplyHeight();
}

// 底边把手拖高度：拖的是 max-height，内容不够高就停在内容高，超出部分面板里滚。
// 只在电脑上（手机上这条是一行横滑，把手藏着）。高度记在本机 localStorage，双击把手恢复默认。
const CONV_BAR_H_KEY = 'gc.convBarMaxH';
let _convBarH = 0; // localStorage 不可用时兜底，至少这次开着的期间记得住
const convBarMobile = () => window.matchMedia('(max-width: 768px), (max-height: 500px) and (orientation: landscape)').matches;
function convBarApplyHeight() {
  const bar = document.getElementById('convSettingsBar');
  let h = _convBarH; try { h = +localStorage.getItem(CONV_BAR_H_KEY) || 0; } catch {}
  bar.style.maxHeight = (h && !convBarMobile()) ? Math.min(h, Math.round(innerHeight * 0.7)) + 'px' : '';
}
function convGripDown(e) {
  if (convBarMobile() || e.button !== 0) return;
  e.preventDefault();
  const bar = document.getElementById('convSettingsBar'), grip = e.currentTarget;
  const y0 = e.clientY, h0 = bar.getBoundingClientRect().height;
  // 往下拖到比内容还高时 max-height 会继续涨、面板不跟手；起点按实际内容高截一下，回拖立刻有反应
  const full = bar.scrollHeight + 1;
  let h = h0;
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('dragging');
  const move = ev => {
    h = Math.max(40, Math.min(ev.clientY - y0 + h0, full, Math.round(innerHeight * 0.7)));
    bar.style.maxHeight = h + 'px';
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.classList.remove('dragging');
    // 拖到底 = 「全展开」，记成不设限：以后开了订阅 GPT 多出一行也不会被截进滚动条
    const v = h >= full - 2 ? 9999 : Math.round(h);
    _convBarH = v;
    try { localStorage.setItem(CONV_BAR_H_KEY, String(v)); } catch {}
    convBarApplyHeight();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
}
function convGripReset() {
  _convBarH = 0;
  try { localStorage.removeItem(CONV_BAR_H_KEY); } catch {}
  document.getElementById('convSettingsBar').style.maxHeight = '';
}

function renderConvSettingsBar() {
  const bar  = document.getElementById('convSettingsBar');
  const chat = getActiveChat(); if (!chat) return;
  // 选模型只在顶栏的模型胶囊里（全选 / 分组 / 逐个都在那）。这里原来还铺着一整排模型按钮，
  // 模型一多就把下面的开关挤成好几行，用户说不用再放这了。
  const limitVal = chat.msgLimit || 0;

  bar.innerHTML = `
    <span class="conv-label">消息上限</span>
    <input type="number" class="conv-limit-input" value="${limitVal}" min="0" max="9999"
           placeholder="不限" title="0 = 不限"
           onchange="setChatMsgLimit(this.value)">
    <span class="conv-label" style="color:var(--text-muted)">条（0=不限）</span>

    <div class="conv-sep"></div>
    <button class="conv-settings-btn ${isLocalClaudeOnly() ? 'active' : ''}"
            onclick="toggleLocalClaude();renderConvSettingsBar()"
            title="切换订阅 Claude：用电脑上的 Claude Code CLI 跑，走订阅额度，不花 API 钱">
      ⚡ 订阅Claude
    </button>
    ${isLocalClaudeOnly() ? `
    <select class="conv-limit-input conv-select" style="min-width:100px"
            onchange="setLocalClaudeModel(this.value)"
            title="选择订阅 Claude 使用的模型">
      ${[
        // 「默认」= 不传 --model，跟着 claude CLI 自己的默认走（settings.json 的 model
        // 字段，比如 Opus 5）。原来这里写死「默认 (Sonnet)」是错的标签，
        // 而且会让人以为选它就是老模型。server 侧 resolveLocalClaudeModel 会把空串
        // 解析成真实默认再判思考链，不然选「默认」就永远看不到思考。
        ['', '默认（跟随 CLI）'],
        ['claude-fable-5-1', 'Fable 5.1'],
        ['claude-fable-5', 'Fable 5'],
        ['claude-opus-5-5', 'Opus 5.5'],
        ['claude-opus-5', 'Opus 5'],
        ['claude-opus-4-8', 'Opus 4.8'],
        ['claude-opus-4-7', 'Opus 4.7'],
        ['claude-opus-4-6', 'Opus 4.6'],
        ['claude-opus-4-5', 'Opus 4.5'],
        ['claude-opus-4-1', 'Opus 4.1'],
        ['claude-opus-4-0', 'Opus 4.0'],
        ['claude-sonnet-5-5', 'Sonnet 5.5'],
        ['claude-sonnet-5', 'Sonnet 5'],
        ['claude-sonnet-4-6', 'Sonnet 4.6'],
        ['claude-sonnet-4-5', 'Sonnet 4.5'],
        ['claude-sonnet-4-0', 'Sonnet 4.0'],
        ['claude-haiku-5-5', 'Haiku 5.5'],
        ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
      ].map(([v, l]) => {
        const lc = state.configs.find(c => c.isLocalClaude);
        const cur = (lc && lc.localModel) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    <select class="conv-limit-input conv-select" style="min-width:96px"
            onchange="setLocalClaudeThinking(this.value)"
            title="思考链：要不要把思考摘要显示出来。「关」就不要摘要；新型号想不想由它自己决定。">
      ${[['auto', '💭 思考：自动'], ['always', '💭 思考：总是'], ['off', '💭 思考：关']].map(([v, l]) => {
        const cur = (state.configs.find(c => c.isLocalClaude)?.thinkingMode) || 'auto';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    <select class="conv-limit-input conv-select" style="min-width:104px"
            onchange="setLocalClaudeEffort(this.value)"
            title="思考力度（effort）：越高想得越深、越慢、越费额度。和左边的「思考链」是两件事 —— 这个管想多深，那个管想完给不给你看。4.6 及更老的型号没有「超高」，会按「高」发；Haiku / Sonnet 4.5 不认这个参数，选了也不传。">
      ${[
        // 值必须是 claude CLI 认的那五个（low/medium/high/xhigh/max）——
        // 传错它只打一行 Warning 就用默认跑，静默不生效，所以 server 侧还会再白名单过一道。
        ['', '🎚 力度：默认'],
        ['low', '🎚 力度：低'],
        ['medium', '🎚 力度：中'],
        ['high', '🎚 力度：高'],
        ['xhigh', '🎚 力度：超高'],
        ['max', '🎚 力度：最高'],
      ].map(([v, l]) => {
        const cur = (state.configs.find(c => c.isLocalClaude)?.localEffort) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    <button class="conv-settings-btn ${state.ccMemoryEnabled ? 'active' : ''}"
            onclick="toggleCcMemory()"
            title="把 Claude Code 的私人记忆（你的画像、项目背景）注入订阅 Claude 的系统提示">
      🧠 CC记忆
    </button>
    <button class="conv-settings-btn ${chat.agentMode ? 'active' : ''}"
            onclick="toggleAgentMode()"
            title="电脑操控模式：让订阅 Claude 用 Bash/文件工具真的在电脑上执行（编程、跑命令）。给的是电脑完全执行权，谨慎开启">
      🖥 电脑操控${chat.agentMode ? ' ✓' : ''}
    </button>
    <button class="conv-settings-btn ${chat.browserMode ? 'active' : ''}"
            onclick="toggleBrowserMode()"
            title="浏览器：让订阅 Claude 操作那个专用 Chrome —— 就是登录着你小红书的那一个，不是干净的新窗口。它能看能翻能点；发东西之前它会先问你，但那道闸只是它自己，GranCyan 的每日额度管不到这条路。和电脑操控互相独立，可以只开这个">
      🌐 浏览器${chat.browserMode ? ' ✓' : ''}
    </button>
    <button class="conv-settings-btn ${state.peekEnabled ? 'active' : ''}"
            onclick="togglePeek()" oncontextmenu="event.preventDefault();peekNow()"
            title="偷看屏幕：你在用电脑、这边又安静着的时候，它偶尔会截一张你的屏幕，看看你在忙什么然后随口说一句。前台是 GranCyan 自己时不拍。右键 = 3 秒后来一次（留时间切窗口，且不受黑名单限制）">
      👀 偷看屏幕${state.peekEnabled ? ' ✓' : ''}
    </button>` : ''}

    <button class="conv-settings-btn ${isLocalGptOnly() ? 'active' : ''}"
            onclick="toggleLocalGpt();renderConvSettingsBar()"
            title="切换订阅 GPT：用电脑上的 Codex CLI 跑，走订阅额度">
      ✨ 订阅GPT
    </button>
    ${isLocalGptOnly() ? `
    <select class="conv-limit-input conv-select" style="min-width:100px"
            onchange="setLocalGptModel(this.value)"
            title="选择订阅 GPT 使用的模型">
      ${[
        ['', '默认 (GPT-5.6 Sol)'],
        ['gpt-6-astra', 'GPT-6 Astra'],
        ['gpt-5.6-sol', 'GPT-5.6 Sol'],
        ['gpt-5.6-terra', 'GPT-5.6 Terra'],
        ['gpt-5.6-luna', 'GPT-5.6 Luna'],
        ['gpt-5.5', 'GPT-5.5'],
        ['gpt-5.4', 'GPT-5.4'],
      ].map(([v, l]) => {
        const lg = state.configs.find(c => c.isLocalGpt);
        const cur = (lg && lg.localModel) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    <select class="conv-limit-input conv-select" style="min-width:104px"
            onchange="setLocalGptEffort(this.value)"
            title="思考深度（Codex 的 reasoning effort）。和左边那个「思考链」是两件事：这个管它想多久，那个管想完了给不给你看。越深越慢越费额度。">
      ${[
        // 值必须落在 codex 自己的枚举里（none/minimal/low/medium/high/xhigh/max/ultra）——
        // 传错值它是 exit 0 + 空日志，静默不生效，所以 server 侧还会再白名单过一道。
        ['', '🧠 深度：自动'],
        ['none', '🧠 深度：不想'],
        ['minimal', '🧠 深度：最浅'],
        ['low', '🧠 深度：浅'],
        ['medium', '🧠 深度：中'],
        ['high', '🧠 深度：深'],
        ['xhigh', '🧠 深度：很深'],
        ['max', '🧠 深度：最深'],
        ['ultra', '🧠 深度：极限'],
      ].map(([v, l]) => {
        const cur = (state.configs.find(c => c.isLocalGpt)?.reasoningEffort) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    <button class="conv-settings-btn ${chat.agentMode ? 'active' : ''}"
            onclick="toggleAgentMode()"
            title="电脑操控模式：让订阅 GPT/Codex 在电脑上读写项目、运行命令。给的是电脑执行权，谨慎开启">
      🖥 电脑操控${chat.agentMode ? ' ✓' : ''}
    </button>` : ''}

    <button class="conv-settings-btn ${isGeminiOnly() ? 'active' : ''}"
            onclick="toggleGemini();renderConvSettingsBar()"
            title="切换 Gemini：直连 Google，不走本机 CLI。没有电脑操控、没有会话续传（每轮重发历史），但模型多、上下文一百万、还能出图。">
      ✦ Gemini
    </button>
    ${isGeminiOnly() ? `
    <button class="conv-settings-btn ${state.configs.find(c => c.isGemini)?.geminiVia === 'sub' ? 'active' : ''}"
            onclick="toggleGeminiVia()"
            title="走订阅：用电脑上的 agy（Antigravity CLI）吃 Google AI Pro 订阅，不要 API key；只有 3.8 Flash（深度选浅/中/深＝low/medium/high 三档），没有自己联网，第一个字要等十来秒。走 key：直连 Google API，模型多、快，但吃 key 的额度。">
      ${state.configs.find(c => c.isGemini)?.geminiVia === 'sub' ? '💳 走订阅 ✓' : '🔑 走 key'}
    </button>
    ${state.configs.find(c => c.isGemini)?.geminiVia === 'sub' ? '' : `
    <select class="conv-limit-input conv-select" style="min-width:132px"
            onchange="setGeminiModel(this.value)"
            title="选择 Gemini 模型。免费层里只有 Flash 系列能随便聊：Pro 系列配额极小（基本一发就 429），出图那两个免费层一次都不给（要给 Google 项目开结算）。">
      ${[
        // 2026-09-21 按 /v1beta/models 接口实际返回的清单挑出来的，不是背的。
        // ⚠️ 2.5 系列**故意不列**：那批对新用户已经 404（"no longer available to new users"），
        //    列出来就是一个选了必坏的选项。
        ['', '默认（3.8 Flash）'],
        ['gemini-3.8-flash', '3.8 Flash'],
        ['gemini-3.7-flash', '3.7 Flash'],
        ['gemini-3.6-flash', '3.6 Flash'],
        ['gemini-3.5-flash', '3.5 Flash'],
        ['gemini-3.5-flash-lite', '3.5 Flash Lite'],
        ['gemini-flash-latest', 'Flash 最新'],
        ['gemini-3-flash-preview', '3 Flash 预览'],
        ['gemini-3.1-flash-lite', '3.1 Flash Lite'],
        ['gemini-3.1-pro-preview', '3.1 Pro（易超配额）'],
        ['gemini-pro-latest', 'Pro 最新（易超配额）'],
        ['gemini-3-pro-image', '🍌 Nano Banana Pro（出图·要付费额度）'],
        ['gemini-3.1-flash-image', '🍌 Nano Banana 2（出图·要付费额度）'],
      ].map(([v, l]) => {
        const g = state.configs.find(c => c.isGemini);
        const cur = (g && g.localModel) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>`}
    <select class="conv-limit-input conv-select" style="min-width:104px"
            onchange="setGeminiThinking(this.value)"
            title="思考深度。选「不想」＝不给你看思考链（想多深交给模型自己定，因为有的模型不吃最低档）；其余几档都会把思考摘要一起发过来。">
      ${[
        // 合法值就这四个 —— 传别的是 400 硬报错，不是静默忽略（2026-09-21 实测问出来的）。
        // 'minimal' 这个值服务端会翻成「只关思考链、不传档位」：它虽然在枚举里，
        // 但 3.8 Flash 实测不认，硬传必 400（同日端到端逮到）。
        ['', '🧠 深度：自动'],
        ['minimal', '🧠 深度：不看思考'],
        ['low', '🧠 深度：浅'],
        ['medium', '🧠 深度：中'],
        ['high', '🧠 深度：深'],
      ].map(([v, l]) => {
        const cur = (state.configs.find(c => c.isGemini)?.geminiThinking) || '';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('')}
    </select>
    ${state.configs.find(c => c.isGemini)?.geminiVia === 'sub' ? '' : `
    <button class="conv-settings-btn ${state.configs.find(c => c.isGemini)?.geminiSearch ? 'active' : ''}"
            onclick="toggleGeminiSearch()"
            title="让 Gemini 自己上网查（google_search）。和右边那个「🔍 联网搜索」不是一回事：那个是 GranCyan 先替它搜好塞进去，这个是它自己决定查不查、查什么。">
      🌐 自己联网${state.configs.find(c => c.isGemini)?.geminiSearch ? ' ✓' : ''}
    </button>`}` : ''}

    ${!chat.isGroupChat ? `
    <div class="conv-sep"></div>
    <button class="conv-settings-btn ${chat.webSearchEnabled ? 'active' : ''}"
            onclick="toggleWebSearch()"
            title="开启后，发送消息时会先联网搜索相关资料并提供给 AI 参考（需在设置中填写搜索 API Key）">
      🔍 联网搜索
    </button>
    <button class="conv-settings-btn ${chat.suggestionsEnabled ? 'active' : ''}"
            onclick="toggleChatSuggestions()"
            title="让 AI 在回复末尾给出最多三条可点击的下一句；不会额外请求 API">
      ✨ 回复建议${chat.suggestionsEnabled ? ' ✓' : ''}
    </button>` : ''}

    <div class="conv-sep"></div>
    <button class="conv-settings-btn ${chat.isGroupChat ? 'active' : ''}"
            onclick="toggleGroupChat()" 
            title="开启后多个 AI 会依次回复，互相能看到对方的话">
      👥 群聊模式
    </button>
    
    ${chat.isGroupChat ? `
        <input type="number" class="conv-limit-input"
               value="${chat.groupRounds || 1}"
               min="1" max="9999"
               title="群聊轮数"
               onchange="setGroupRounds(this.value)">
        <button class="conv-settings-btn" onclick="openGroupBoard()" title="群公告栏 / 群记忆">📌 群公告</button>
        <button class="conv-settings-btn ${chat.whoUserGame?.active ? 'active' : ''}" onclick="openWhoUserGame()" title="伪装身份，玩谁是 user">🕵 谁是 user</button>
    ` : ''}

    <div class="conv-sep"></div>
    <span class="conv-label">本对话 token：</span>
    <span class="tok-pill accent-text">${fmtTokens(getChatTotalTokens(chat))}</span>

    <div class="conv-sep"></div>
    <button class="conv-settings-btn ${state.isSelectMode ? 'active' : ''}"
            onclick="enterSelectMode()"
            title="进入多选，勾选多条消息后批量删除或分享">
      ☑ 批量删除
    </button>
    <button class="conv-settings-btn" onclick="openShareModal()" title="把整个对话或选中的几条生成一个只读链接">
      🔗 分享
    </button>
  `;
}

/* ── 单开某个订阅通道？（对话设置栏按这个决定显示哪组控件）──────────────── */
function isLocalClaudeOnly() {
  const lc = state.configs.find(c => c.isLocalClaude);
  if (!lc) return false;
  const ids = getActiveChatModelIds();
  return ids.includes(lc.id) && ids.length === 1;
}

function isLocalGptOnly() {
  const lg = state.configs.find(c => c.isLocalGpt);
  if (!lg) return false;
  const ids = getActiveChatModelIds();
  return ids.includes(lg.id) && ids.length === 1;
}
function isGeminiOnly() {
  const g = state.configs.find(c => c.isGemini);
  if (!g) return false;
  const ids = getActiveChatModelIds();
  return ids.includes(g.id) && ids.length === 1;
}

// ── Claude Code 记忆互通 ────────────────────────────────────────
// server.js 的 /api/cc-memory 读 CC 每项目 memory 目录下的 *.md；
// 开关打开后，发本地 Claude 时带 ccMemory:true，由后端拼进系统提示。
async function fetchCcMemory() {
  try {
    const r = await fetch(SERVER_BASE + '/api/cc-memory');
    return await r.json();
  } catch (e) {
    return { ok: false, msg: '连不上后端服务器：' + e.message };
  }
}

async function refreshCcMemoryStat() {
  const el = document.getElementById('ccMemoryStat');
  if (!el) return;
  const d = await fetchCcMemory();
  el.textContent = d.ok
    ? `共 ${d.count} 条 · 摘要注入约 ${d.injectChars} 字（≈${Math.round((d.injectChars||0) / 1.5)} token）· 全文 ${d.chars} 字`
    : (d.msg || '读取失败');
}

async function showCcMemoryList() {
  const d = await fetchCcMemory();
  document.getElementById('ccMemModal')?.remove();
  const el = document.createElement('div');
  el.id = 'ccMemModal';
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center';
  el.onclick = e => { if (e.target === el) el.remove(); };

  const rows = d.ok && d.count
    ? d.items.map(m => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border,#333)">
          <div style="font-size:13px;font-weight:600">${escHtml(m.name)}
            <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">${escHtml(m.type)} · ${m.chars} 字</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escHtml(m.description || '')}</div>
        </div>`).join('')
    : `<div style="font-size:13px;color:var(--text-muted);padding:10px 0">${d.ok ? '还没有任何 CC 记忆。' : escHtml(d.msg || '读取失败')}</div>`;

  el.innerHTML = `
    <div style="background:var(--bg-panel,#1e1e1e);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:12px;padding:20px;width:min(480px,92vw);max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.4)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="font-size:15px">🧠 Claude Code 的记忆</b>
        <span style="font-size:11px;color:var(--text-muted)">${d.ok ? d.count + ' 条 · ' + d.chars + ' 字' : ''}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${d.ok && d.dirs ? escHtml(d.dirs.join('\n')) : ''}</div>
      ${rows}
      <button class="conv-settings-btn" style="width:100%;margin-top:14px"
              onclick="document.getElementById('ccMemModal').remove()">关闭</button>
    </div>`;
  document.body.appendChild(el);
}

function toggleCcMemory() {
  state.ccMemoryEnabled = !state.ccMemoryEnabled;
  save();
  const t = document.getElementById('ccMemoryToggle');
  if (t) t.checked = !!state.ccMemoryEnabled;
  renderConvSettingsBar();
  showToast(state.ccMemoryEnabled ? '✓ 订阅 Claude 将读取 CC 记忆' : '已关闭 CC 记忆注入');
}

// 电脑操控模式（per-conversation）：开启后本地 Claude 能真的在电脑上跑命令/改文件。
// 首次开启弹确认，因为这等于把电脑执行权交给对话。
function toggleAgentMode() {
  const chat = getActiveChat(); if (!chat) return;
  if (!chat.agentMode) {
    if (!confirm('开启「电脑操控模式」后，订阅 Claude 可以在你电脑上执行终端命令、读写文件（用于编程/自动化）。\n\n这相当于把电脑的执行权交给这个对话，请只在信任的场景使用。\n\n确定开启？')) return;
  }
  chat.agentMode = !chat.agentMode;
  save();
  renderConvSettingsBar();
  showToast(chat.agentMode ? '🖥 电脑操控已开启 — 订阅 Claude 现在能动手了' : '电脑操控已关闭');
}

// 浏览器（per-conversation）：开启后本地 Claude 能操作那个专用 Chrome。
// ⚠️ 和电脑操控**互相独立**，不是它的子开关：可以只开这个 —— 让AI 看网页，
//    但一个 Bash 都不给。两个开关在服务端也是分开判的（各挂各的工具）。
// 首次开启弹确认，因为它接管的**不是**一个干净的新窗口，是用户登录着的那个 profile。
function toggleBrowserMode() {
  const chat = getActiveChat(); if (!chat) return;
  if (!chat.browserMode) {
    if (!confirm('开启「浏览器」后，订阅 Claude 能操作那个专用 Chrome —— 就是登录着你小红书的那一个，不是干净的新窗口。\n\n它能看、能翻、能点。发帖发评论这类留痕的动作它会先问你，但要说清楚：那道闸只是它自己。GranCyan 的每日额度和审核闸管的是应用内那条路，管不到浏览器这条。\n\n确定开启？')) return;
  }
  chat.browserMode = !chat.browserMode;
  save();
  renderConvSettingsBar();
  showToast(chat.browserMode ? '🌐 浏览器已开启 — 它现在能看你那个 Chrome 了' : '浏览器已关闭');
}

function toggleWebSearch() {
  const chat = getActiveChat(); if (!chat) return;
  const provider = state.webSearchProvider || 'tavily';
  if (!chat.webSearchEnabled && provider !== 'duckduckgo' && !state.webSearchApiKey) {
    showToast('请先在设置 → 模型 & API 中填写搜索 API Key', 'error', 3000);
    return;
  }
  chat.webSearchEnabled = !chat.webSearchEnabled;
  save(); renderConvSettingsBar();
}

function setChatMsgLimit(val) {
  const chat = getActiveChat(); if (!chat) return;
  chat.msgLimit = parseInt(val) || 0; save(); renderChatList();
}
function setGroupRounds(val) {
  const chat = getActiveChat();
  chat.groupRounds = parseInt(val) || 1;
  save();
}
function toggleGroupChat() {
  const chat = getActiveChat(); if (!chat) return;
  chat.isGroupChat = !chat.isGroupChat;
  save(); renderConvSettingsBar(); renderMessages(); updateGroupBoardBtn();
}

// ═══════════════════════════════════════════════════════
// MODELS / SETTINGS
// ═══════════════════════════════════════════════════════
function addModelConfig() {
  const conf = { id: nextId(), nickname: '新助手', modelName: 'gpt-4o',
    apiKey: '', apiBase: 'https://api.openai.com/v1', temp: 0.7,
    maxTokens: 4096, maxReplyTokens: 1024,
    avatar: '', persona: '', thinkingMode: 'auto' };
  state.configs.push(conf);
  // 刚加的这张直接展开——不然点完「添加模型」只多出一行，看着像什么都没发生
  _setOpenModelCards(_openModelCards().concat([conf.id]));
  save(); renderConfigs(); renderModelPills(); renderConvSettingsBar();
}

function removeModelConfig(i) {
  if (state.configs.length <= 1) { alert('至少保留一个模型配置'); return; }
  state.configs.splice(i, 1); save(); renderConfigs(); renderModelPills(); renderConvSettingsBar();
}

function updateC(i, k, v) { state.configs[i][k] = v; save(); renderModelPills(); renderConvSettingsBar(); }

// ═══════════════════════════════════════════════════════
// 模型分组（可以无限层嵌套）
//
// 分组存在每个 config 的 group 字段里，**分组结构是从 configs 现算出来的**。
// 不另开 state.modelGroups 之类的字段，是为了绕开持久化那三道白名单
// （_doSave / loadStateFromDB / 启动赋值块，漏一道就刷新即失且零报错）——
// configs 本来就整包序列化进 kuro_configs，group 跟着走，天然存得住。
//
// 嵌套靠的是把 group 从「组名」升成「路径」：'本地/Claude 系' 就是两层，层数没上限。
// 老数据里的 '国产' 恰好等于深度 1 的路径，所以这次升级不用迁移任何东西。
//
// 代价还是那个：**空分组存不下来**。所以 UI 上没有「新建空分组」这种入口，
// 建组只能在「把某个模型移到新分组」时顺手发生，移分组也只能移已经有东西的组。
// 这不是偷懒 —— 组＝模型的位置，没有模型就没有这个位置，语义是自洽的。
// ═══════════════════════════════════════════════════════
const MODEL_GROUP_FOLD_KEY = 'gc_model_groups_folded';
const MG_SEP = '/';

/* ── 多选的兜底桩 ──────────────────────────────────────
   下面 renderConfigs / modelGroupHtml 会调 _mselHasModel 等三个函数，真身在
   29-multiselect.js（**后**加载）。运行时渲染发生在 boot 之后，真身早就位了，
   所以正常情况下这三个桩一次都不会被调用。

   留着它们是为了**漏文件时别把整页带走**：29 要是没挂进 HTML（改版漏了、
   安卓副本没同步），renderConfigs 第一行就 ReferenceError，
   结果不是「多选没了」而是**整个模型列表空白**，而且报错只在控制台。
   这种「一个文件缺席 → 另一块功能整个消失」的静默故障这个项目吃过好几次亏。

   ⚠️ 同名 function 声明，后加载的覆盖先加载的 —— 29 一到位就自动接管。
      所以这里必须写成 function 声明，不能写成 const/let（那会直接重复声明报错）。 */
function _mselHasModel() { return false; }
function _mselHasGroup() { return false; }
function mselBarHtml() { return ''; }
// 这个桩返回 false＝不提 Ctrl。29 缺席时多选本来就没有，提了才是骗人
function _mselIsDesktop() { return false; }

// 路径规范化：去掉空段和两头空格，'  本地 //  Claude ' → '本地/Claude'
function mgNorm(p) {
  return String(p || '').split(MG_SEP).map(s => s.trim()).filter(Boolean).join(MG_SEP);
}
function modelGroupOf(c) { return mgNorm(c?.group); }
function mgSegs(p)   { const n = mgNorm(p); return n ? n.split(MG_SEP) : []; }
function mgParent(p) { const s = mgSegs(p); s.pop(); return s.join(MG_SEP); }
function mgLeaf(p)   { const s = mgSegs(p); return s[s.length - 1] || ''; }
function mgJoin(parent, name) { return parent ? parent + MG_SEP + name : name; }
// 组名里不能带分隔符，不然输一个名字就凭空变成两层。换成全角，别直接报错打断人
function mgSafeName(n) { return String(n || '').split(MG_SEP).join('／').trim(); }
// g 是不是在 path 这棵子树里（path 自己也算）。path 为空＝「未分组」那一坨，不是全体
function mgUnder(g, path) { return path ? (g === path || g.startsWith(path + MG_SEP)) : !g; }
// 含子孙的模型总数 —— 组头上显示这个，像文件夹一样
function mgCountDeep(path) {
  return state.configs.filter(c => mgUnder(modelGroupOf(c), path)).length;
}

// 所有出现过的分组路径，外加它们的祖先（中间层可以只有子组、没有直属模型）。
// 顺序保证祖先排在子代前面，同层按第一次出现的先后
function modelGroupPaths() {
  const seen = [];
  state.configs.forEach(c => {
    let acc = '';
    mgSegs(modelGroupOf(c)).forEach(s => {
      acc = mgJoin(acc, s);
      if (!seen.includes(acc)) seen.push(acc);
    });
  });
  return seen;
}
// 保留这个名字：现在返回的是所有分组**路径**
function modelGroupNames() { return modelGroupPaths(); }

// 嵌套树。节点 = { name, path, depth, items:[{c,i}], children:[节点] }
// 未分组那一坨作为最后一个顶层节点返回（path 为空）
function modelGroupTree() {
  const nodes = new Map();
  modelGroupPaths().forEach(p => {
    nodes.set(p, { name: mgLeaf(p), path: p, depth: mgSegs(p).length, items: [], children: [] });
  });
  const roots = [];
  nodes.forEach((n, p) => {
    const par = nodes.get(mgParent(p));
    (par ? par.children : roots).push(n);
  });
  const loose = { name: '', path: '', depth: 0, items: [], children: [] };
  state.configs.forEach((c, i) => {
    (nodes.get(modelGroupOf(c)) || loose).items.push({ c, i });
  });
  return loose.items.length ? roots.concat([loose]) : roots;
}

// 深度优先拍平，给那些只能「一列到底」的 UI 用（选模型下拉、记忆页），靠 depth 缩进
function modelGroups() {
  const out = [];
  (function walk(ns) { ns.forEach(n => { out.push(n); walk(n.children); }); })(modelGroupTree());
  return out;
}

// 折叠状态是纯 UI 偏好，不进 state，也就不用跟着上云。
// 读的时候顺手把已经不存在的路径滤掉：删模型、解散组都会留下脏 key，
// 留着的话以后再建一个同名分组，它会莫名其妙一出生就是收起的
function _foldedGroups() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(MODEL_GROUP_FOLD_KEY) || '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const alive = modelGroupPaths();
  return raw.filter(p => alive.includes(p));
}
// 改名 / 挪窝以后折叠状态要跟着搬，不然收起来的组一改名就自己弹开了
function _remapFoldedGroups(fn) {
  const next = [];
  _foldedGroups().forEach(p => {
    const v = fn(p);
    if (v && !next.includes(v)) next.push(v);
  });
  try { localStorage.setItem(MODEL_GROUP_FOLD_KEY, JSON.stringify(next)); } catch {}
}

// 卡片这一级也能折。一张展开的模型卡有头像/Key/窗口/思考预算/persona…能占满一屏，
// 全摊开时「模型配置」就是一摞表格，分组也救不回来。所以默认收成一行，
// 点开才是设置。存的是**展开**的 id（默认全收），这样新加的模型不会莫名其妙就展开着。
const MODEL_CARD_OPEN_KEY = 'gc_model_cards_open';
function _openModelCards() {
  try { return JSON.parse(localStorage.getItem(MODEL_CARD_OPEN_KEY) || '[]'); } catch { return []; }
}
function _setOpenModelCards(ids) {
  try { localStorage.setItem(MODEL_CARD_OPEN_KEY, JSON.stringify(ids)); } catch {}
}
function toggleModelCardFold(id) {
  if (_mgmConsumeSuppress()) return;              // 这一下是长按弹菜单带出来的
  const o = _openModelCards();
  const i = o.indexOf(id);
  if (i < 0) o.push(id); else o.splice(i, 1);
  _setOpenModelCards(o);
  renderConfigs();
}
function toggleModelGroupFold(name) {
  if (_mgmConsumeSuppress()) return;              // 这一下是长按弹菜单带出来的
  const f = _foldedGroups();
  const i = f.indexOf(name);
  if (i < 0) f.push(name); else f.splice(i, 1);
  try { localStorage.setItem(MODEL_GROUP_FOLD_KEY, JSON.stringify(f)); } catch {}
  renderConfigs();
  // 记忆页的模型设定跟这边共用折叠状态，开着就一起刷
  try {
    if (typeof _currentMemTab !== 'undefined' && _currentMemTab === 'model'
        && document.getElementById('memoryList')) renderModelMemTab();
  } catch {}
}

/* 右键（桌面）/ 长按（手机）折叠行 → 选分组。
   收藏夹式的「移到某个文件夹」：分组是**整理动作**，不是这个模型的一项设置，
   所以它不该躺在展开后那一堆 API Key / token / persona 中间。展开区里没有分组下拉。 */
let _mgmTimer = null;
let _mgmSuppressTimer = null;
let _mgmSuppressClick = false;      // 长按弹完菜单，手指抬起会补一个 click，别让它把卡片展开

/* 那个补发的 click 并不保证一定来（手指抬起时压在刚弹出来的菜单上、
   或者系统把这次长按认成了别的手势，就没有）。标志一旦挂住不清，
   下一次正常点击会被白白吃掉 —— 所以给它加个自动过期兜底。 */
function _mgmSuppress() {
  _mgmSuppressClick = true;
  clearTimeout(_mgmSuppressTimer);
  _mgmSuppressTimer = setTimeout(() => { _mgmSuppressClick = false; }, 800);
}
function _mgmConsumeSuppress() {
  if (!_mgmSuppressClick) return false;
  _mgmSuppressClick = false;
  clearTimeout(_mgmSuppressTimer);
  return true;
}

function _mgmTouchStart(e, i) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  const x = t.clientX, y = t.clientY;
  clearTimeout(_mgmTimer);
  _mgmTimer = setTimeout(() => { _mgmSuppress(); showModelGroupMenu(x, y, i); }, 600);
}
// 分组标题上长按＝把整个分组挪走
function _mggTouchStart(e, path) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  const x = t.clientX, y = t.clientY;
  clearTimeout(_mgmTimer);
  _mgmTimer = setTimeout(() => { _mgmSuppress(); showGroupMoveMenu(x, y, path); }, 600);
}
function _mgmTouchCancel() { clearTimeout(_mgmTimer); }

function closeModelGroupMenu() {
  document.getElementById('modelGroupMenu')?.remove();
}

/* 「移模型」和「移分组」两个菜单长得一样，共用这个渲染器。
   rows: [{ path, label, depth, active, disabled, sub }]
   sub=true 的行尾挂一个「＋」＝在这一层里面新建子分组 —— 嵌套就是从这里长出来的，
   所以每一层都得有，不然只能建到第二层。 */
function _mgmShow(x, y, title, rows, onPick, onNew) {
  closeModelGroupMenu();
  const menu = document.createElement('div');
  menu.id = 'modelGroupMenu';
  menu.innerHTML = `<div class="mgm-title">${title}</div>` + rows.map(r => `
    <div class="mgm-item ${r.cls || ''} ${r.active ? 'active' : ''} ${r.disabled ? 'disabled' : ''}"
         style="padding-left:${10 + Math.max(0, (r.depth || 1) - 1) * 15}px"
         ${r.disabled ? '' : `data-v="${escHtml(r.path)}"`}>
      <span class="mgm-tick">${r.active ? '✓' : ''}</span>
      <span class="mgm-label">${escHtml(r.label)}</span>
      ${r.sub && !r.disabled
        ? `<span class="mgm-sub" data-n="${escHtml(r.path)}" title="在「${escHtml(r.label)}」里面新建子分组">＋</span>`
        : ''}
    </div>`).join('')
    /* 用户第 5 条要的「右键弹 ui 说可以多选」。模型 / 分组这两处本来就有右键菜单，
       提示就挂在菜单底部，不另弹一个气泡去盖住它。
       其余没有右键菜单的地方（消息、对话、回收站）走 29-multiselect.js 里的 _mselShowTip。
       ⚠️ 只在有鼠标的环境提 —— 手机上没有 Ctrl 可按，说了等于误导。 */
    + (_mselIsDesktop() ? `<div class="mgm-tip">按住 <b>Ctrl</b> 点，可以一次选好几个</div>` : '');
  document.body.appendChild(menu);

  // fixed 定位，够不下就往回弹（长列表里右键靠底部时很常见）
  const w = menu.offsetWidth || 200, h = menu.offsetHeight || 200;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth  - w - 8)) + 'px';
  menu.style.top  = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';

  menu.querySelectorAll('.mgm-sub').forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); closeModelGroupMenu(); onNew(el.dataset.n); };
  });
  menu.querySelectorAll('.mgm-item:not(.disabled)').forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); closeModelGroupMenu(); onPick(el.dataset.v); };
  });
  return menu;
}

// 模型那一行上右键 / 长按：把这个模型移到哪个分组（层数不限）
function showModelGroupMenu(x, y, i) {
  const c = state.configs[i];
  if (!c) return;
  const cur = modelGroupOf(c);
  const rows = modelGroups().filter(n => n.path).map(n => ({
    path: n.path, label: n.name, depth: n.depth, active: n.path === cur, sub: true,
  }));
  rows.push({ path: '', label: '未分组', depth: 1, active: !cur, sub: false });
  rows.push({ path: '__new__', label: '＋ 新建分组…', depth: 1, sub: false, cls: 'mgm-new' });
  _mgmShow(x, y, `把「${escHtml(c.nickname)}」移到`, rows,
    v => (v === '__new__' ? newGroupForModel(i, '') : setModelGroup(i, v)),
    parent => newGroupForModel(i, parent));
}

/* 分组标题上右键 / 长按：把整个分组（连同子孙）挪到别的分组底下。
   菜单里滤掉自己和自己的子孙 —— 不然就成环了，那一堆 config 的 group 会变成无主路径。 */
function showGroupMoveMenu(x, y, src) {
  if (!src) return;
  const rows = modelGroups().filter(n => n.path && !mgUnder(n.path, src)).map(n => ({
    path: n.path, label: n.name, depth: n.depth, active: n.path === mgParent(src), sub: false,
  }));
  rows.unshift({ path: '', label: '⤴ 顶层', depth: 1, active: !mgParent(src), sub: false });
  _mgmShow(x, y, `把分组「${escHtml(mgLeaf(src))}」移到`, rows,
    dest => moveModelGroup(src, dest), () => {});
}

// 点别处 / 按 Esc / 滚动都收起来
document.addEventListener('click', e => {
  if (!e.target.closest('#modelGroupMenu')) closeModelGroupMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModelGroupMenu(); });

// 分组一变，四处 UI 都得跟着刷（记忆页的模型设定也按同一棵树排）
function refreshModelGroupUI() {
  save(); renderConfigs(); renderModelPills(); renderConvSettingsBar();
  try {
    if (typeof _currentMemTab !== 'undefined' && _currentMemTab === 'model'
        && document.getElementById('memoryList')) renderModelMemTab();
  } catch {}
}

function setModelGroup(i, path) {
  if (!state.configs[i]) return;
  state.configs[i].group = mgNorm(path);
  refreshModelGroupUI();
}

// 新建分组永远是「建的同时就把这个模型放进去」——空分组存不住，见文件头那段注释
async function newGroupForModel(i, parent) {
  const name = mgSafeName(await appPrompt(
    parent ? `在「${mgLeaf(parent)}」里面新建子分组，叫什么？` : '新分组叫什么？', ''));
  if (!name) return;
  setModelGroup(i, mgJoin(mgNorm(parent), name));
}

// 改的只是这一段名字，子孙的路径前缀跟着换
async function renameModelGroup(path) {
  const old = mgLeaf(path);
  const name = mgSafeName(await appPrompt('把这个分组改叫什么？', old));
  if (!name || name === old) return;
  const next = mgJoin(mgParent(path), name);
  if (next !== path && modelGroupPaths().includes(next)
      && !confirm(`同一层里已经有「${name}」了，合并进去？`)) return;
  // 先搬折叠状态再改 configs —— 反过来的话旧路径已经不存在，读出来就被当脏 key 滤掉了
  _remapFoldedGroups(p => mgUnder(p, path) ? next + p.slice(path.length) : p);
  state.configs.forEach(c => {
    const g = modelGroupOf(c);
    if (mgUnder(g, path)) c.group = next + g.slice(path.length);
  });
  refreshModelGroupUI();
  showToast(`分组已改名为「${name}」`, 'success');
}

// 把整个分组挪到 dest 底下（dest 为空＝挪回顶层）。子孙跟着走，模型一个不动
function moveModelGroup(src, dest) {
  src = mgNorm(src); dest = mgNorm(dest);
  const target = mgJoin(dest, mgLeaf(src));
  if (!src || target === src) return;
  if (mgUnder(target, src)) { showToast('不能把分组移进它自己里面', 'error'); return; }
  if (modelGroupPaths().includes(target)
      && !confirm(`目标那层已经有「${mgLeaf(src)}」了，合并进去？`)) return;
  _remapFoldedGroups(p => mgUnder(p, src) ? target + p.slice(src.length) : p);
  state.configs.forEach(c => {
    const g = modelGroupOf(c);
    if (mgUnder(g, src)) c.group = target + g.slice(src.length);
  });
  refreshModelGroupUI();
  showToast(dest ? `已移到「${dest}」里` : '已移回顶层');
}

// 解散分组＝把里面的东西上移一层，**不删模型**（删模型走卡片上的 ✕）。
// 子分组也只上移一层，不会被拍平成一堆散模型
function dissolveModelGroup(path) {
  const n = mgCountDeep(path);
  const kids = modelGroupPaths().filter(p => mgParent(p) === path).length;
  const par = mgParent(path);
  const where = par ? `「${par}」` : '未分组';
  if (!confirm(`解散分组「${mgLeaf(path)}」？\n里面的 ${n} 个模型`
    + `${kids ? `和 ${kids} 个子分组` : ''}会挪到${where}，模型本身不会被删。`)) return;
  // 这个组自己没了（映射成空＝丢弃），子孙上移一层
  _remapFoldedGroups(p => p === path ? ''
    : (mgUnder(p, path) ? mgJoin(par, p.slice(path.length + 1)) : p));
  state.configs.forEach(c => {
    const g = modelGroupOf(c);
    if (g === path) c.group = par;
    else if (mgUnder(g, path)) c.group = mgJoin(par, g.slice(path.length + 1));
  });
  refreshModelGroupUI();
  showToast(`已解散「${mgLeaf(path)}」，${n} 个模型挪到${where}`);
}

// 本次对话里整组勾上 / 整组取消，**连子孙一起**（组内已全选就取消，否则补齐）
function toggleChatModelGroup(path) {
  const chat = getActiveChat(); if (!chat) return;
  const groupIds = state.configs.filter(c => mgUnder(modelGroupOf(c), path)).map(c => c.id);
  if (!groupIds.length) return;
  const ids = getActiveChatModelIds().slice();
  const allOn = groupIds.every(id => ids.includes(id));
  chat.activeModelIds = allOn
    ? ids.filter(id => !groupIds.includes(id))
    : ids.concat(groupIds.filter(id => !ids.includes(id)));
  save(); renderModelPills(); renderConvSettingsBar();
}

function renderConfigs() {
  const list = document.getElementById('configList');
  if (!list) return;
  const tree = modelGroupTree();
  // 一个分组都还没建的时候保持原样平铺，别凭空多出一层「未分组」的壳。
  // 但要留一行提示 —— 不然分组入口只藏在右键里，页面上完全看不出有这么个功能
  // （第一版就是这样，用户当场没找着）。
  if (tree.length === 1 && !tree[0].path) {
    list.innerHTML = mselBarHtml() + `
      <div class="model-group-hint">
        点模型名展开设置。🗂 想再收拢一层就分组：<b>在模型那一行上右键（手机长按）</b>就能选分组，
        菜单里每个分组后面的 <b>＋</b> 是往它里面再建一层，<b>层数不限</b>。
        分组标题上右键还能把整个分组挪个位置。<br>
        要一次收好几个：<b>桌面 Ctrl + 左键</b>、<b>手机在条目上往左划</b>，
        挑完点右上角的 <b>🗂</b> 就直接建组。
      </div>`
      + tree[0].items.map(({ c, i }) => modelCardHtml(c, i)).join('');
    return;
  }
  const folded = _foldedGroups();
  list.innerHTML = mselBarHtml() + tree.map(g => modelGroupHtml(g, folded)).join('');
}

// 递归：子分组排在本层直属模型前面，跟文件夹一个规矩
function modelGroupHtml(g, folded) {
  const isFolded = folded.includes(g.path);
  const p = escHtml(g.path);
  return `
    <div class="model-group ${g.path ? '' : 'loose'} ${_mselHasGroup(g.path) ? 'msel-on' : ''}">
      <div class="model-group-head" data-g="${p}" onclick="toggleModelGroupFold(this.dataset.g)"
           ${g.path ? `oncontextmenu="showGroupMoveMenu(event.clientX,event.clientY,this.dataset.g);return false"
           ontouchstart="_mggTouchStart(event,this.dataset.g)" ontouchend="_mgmTouchCancel()"
           ontouchmove="_mgmTouchCancel()" ontouchcancel="_mgmTouchCancel()"
           title="展开 / 收起｜右键、长按可以把整个分组挪走｜Ctrl+点 或 左划＝多选"` : ''}>
        <span class="model-group-caret ${isFolded ? 'folded' : ''}">▾</span>
        <span class="model-group-name">${escHtml(g.path ? g.name : '未分组')}</span>
        <span class="model-group-count">${mgCountDeep(g.path)}</span>
        ${g.path ? `
        <span class="model-group-acts" onclick="event.stopPropagation()">
          <button class="model-group-btn" data-g="${p}"
                  onclick="renameModelGroup(this.dataset.g)" title="重命名分组">✎</button>
          <button class="model-group-btn" data-g="${p}"
                  onclick="dissolveModelGroup(this.dataset.g)" title="解散分组（里面的东西上移一层，不删模型）">⊘</button>
        </span>` : ''}
      </div>
      <div class="model-group-body ${isFolded ? 'hidden' : ''}">
        ${g.children.map(k => modelGroupHtml(k, folded)).join('')}
        ${g.items.map(({ c, i }) => modelCardHtml(c, i)).join('')}
      </div>
    </div>`;
}

function modelCardHtml(c, i) {
  const open = _openModelCards().includes(c.id);
  return `
    <div class="model-card ${open ? '' : 'folded'} ${_mselHasModel(c.id) ? 'msel-on' : ''}">
      <div class="model-card-header" data-mid="${c.id}" onclick="toggleModelCardFold(${c.id})"
           oncontextmenu="showModelGroupMenu(event.clientX,event.clientY,${i});return false"
           ontouchstart="_mgmTouchStart(event,${i})" ontouchend="_mgmTouchCancel()"
           ontouchmove="_mgmTouchCancel()" ontouchcancel="_mgmTouchCancel()"
           title="${open ? '收起' : '展开设置'}｜右键 / 长按可改分组｜Ctrl+点 或 左划＝多选">
        <span class="model-card-caret ${open ? '' : 'folded'}">▾</span>
        ${c.avatar
          ? `<img class="model-card-dot" src="${c.avatar}">`
          : `<span class="model-card-dot fallback" style="background:${getModelColor(c.id)}22;color:${getModelColor(c.id)}">${escHtml((c.nickname||'AI').slice(0,1))}</span>`}
        <span class="model-card-name">${escHtml(c.nickname)}</span>
        <span class="model-card-sub">${escHtml(c.modelName || '')}</span>
        <button class="model-card-del" onclick="event.stopPropagation();removeModelConfig(${i})">✕</button>
      </div>
      <div class="model-card-body ${open ? '' : 'hidden'}">
      <div class="avatar-upload-row">
        ${c.avatar ? `<img class="avatar-preview" src="${c.avatar}">` : `<div class="avatar-preview fallback" style="background:${getModelColor(c.id)}22;color:${getModelColor(c.id)}">${escHtml((c.nickname||'AI').slice(0,1))}</div>`}
        <button class="avatar-upload-btn" onclick="document.getElementById('avatarFile_${i}').click()">🖼 设置头像</button>
        <input type="file" id="avatarFile_${i}" accept="image/*" style="display:none" onchange="handleModelAvatarUpload(${i},this)">
        ${c.avatar ? `<button class="avatar-clear-btn" onclick="updateC(${i},'avatar','');renderConfigs()">移除头像</button>` : ''}
      </div>
      <div class="model-card-grid">
        <div class="field-group">
          <span class="field-label">昵称</span>
          <input class="field-input" type="text" value="${escHtml(c.nickname)}" placeholder="昵称"
                 onchange="updateC(${i},'nickname',this.value);renderConfigs()">
        </div>
        <div class="field-group">
          <span class="field-label">模型名</span>
          <input class="field-input" type="text" value="${escHtml(c.modelName)}" placeholder="model name"
                 onchange="updateC(${i},'modelName',this.value)">
        </div>
      </div>
      <div class="field-full field-group" style="margin-bottom:10px">
        <span class="field-label">API Base URL</span>
        <input class="field-input" type="text" value="${escHtml(c.apiBase||'')}" placeholder="https://api.openai.com/v1"
               onchange="updateC(${i},'apiBase',this.value.trim())">
      </div>
      <div class="field-full field-group" style="margin-bottom:14px">
        <span class="field-label">API Key</span>
        <input class="field-input" type="password" value="${c.apiKey||''}" placeholder="sk-…"
               onchange="updateC(${i},'apiKey',this.value)">
      </div>
      <div class="token-limit-row" style="margin-bottom:14px">
        <div class="field-group">
          <span class="field-label">上下文窗口 (tokens)</span>
          <input class="field-input" type="number" value="${c.maxTokens||4096}" min="256" max="200000" step="256"
                 onchange="updateC(${i},'maxTokens',parseInt(this.value)||4096)">
        </div>
        <div class="field-group">
          <span class="field-label">单次回复上限 (tokens)</span>
          <input class="field-input" type="number" value="${c.maxReplyTokens||1024}" min="64" max="32768" step="64"
                 onchange="updateC(${i},'maxReplyTokens',parseInt(this.value)||1024)">
        </div>
      </div>
      <div class="field-group" style="margin-bottom:14px">
        <span class="field-label">思考模式</span>
        <select class="think-select" onchange="updateC(${i},'thinkingMode',this.value)">
          <option value="auto" ${ (c.thinkingMode||'auto')==='auto'?'selected':''}>模型自己选（默认）</option>
          <option value="always" ${c.thinkingMode==='always'?'selected':''}>始终开启思考</option>
          <option value="off" ${c.thinkingMode==='off'?'selected':''}>不使用思考</option>
        </select>
      </div>
      <div class="field-full field-group">
        <span class="field-label">思考预算</span>
        <select class="think-select" onchange="updateC(${i},'thinkingBudget',this.value)">
          <option value="-1" ${ (c.thinkingBudget||'-1')==='-1'?'selected':''}>无限制（默认）</option>
          <option value="1000" ${c.thinkingBudget==='1000'?'selected':''}>1000 tokens (快速)</option>
          <option value="3000" ${c.thinkingBudget==='3000'?'selected':''}>3000 tokens (标准)</option>
          <option value="5000" ${c.thinkingBudget==='5000'?'selected':''}>5000 tokens (深度)</option>
          <option value="10000" ${c.thinkingBudget==='10000'?'selected':''}>10000 tokens (极深)</option>
        </select>
        <div class="field-hint">控制思考深度，数值越大思考越深入（仅支持扩展思考的模型）</div>
      </div>
      <div class="field-group" style="margin-bottom:14px">
        <span class="field-label">设定库 / Persona <span style="font-weight:400;color:var(--text-muted)">（追加到该模型的系统提示，不限字数）</span></span>
        <textarea class="persona-textarea" placeholder="例如：你是XX，性格设定、说话风格、背景故事…&#10;这里写的内容只会发给这个模型。"
                  onchange="updateC(${i},'persona',this.value)">${escHtml(c.persona||'')}</textarea>
      </div>
      <div class="temp-label">
        <span>Temperature</span>
        <span class="accent-text" id="tempLabel_${i}">${c.temp}</span>
      </div>
      <input type="range" min="0" max="2" step="0.1" value="${c.temp}"
             oninput="updateC(${i},'temp',parseFloat(this.value)); document.getElementById('tempLabel_${i}').innerText=parseFloat(this.value).toFixed(1)">
      </div>
    </div>`;
}

async function handleModelAvatarUpload(i, input) {
  const file = input.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  input.value = '';

  // Try uploading to Supabase Storage (avatars bucket)
  if (currentUser) {
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const storagePath = `model_avatars/${currentUser.id}/${state.configs[i].id}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseClient.storage
        .from('avatars').upload(storagePath, file, { upsert: true, contentType: file.type });
      if (!upErr) {
        const { data: { publicUrl } } = supabaseClient.storage.from('avatars').getPublicUrl(storagePath);
        state.configs[i].avatar = publicUrl;
        save(); renderConfigs(); renderMessages(); renderModelPills();
        syncSettingsToCloud().catch(e => console.warn('云同步失败:', e));
        return;
      }
    } catch(e) { /* bucket may not exist — fall through to base64 */ }
  }

  // Fallback: local base64
  const r = new FileReader();
  r.onload = e => {
    state.configs[i].avatar = e.target.result;
    save(); renderConfigs(); renderMessages(); renderModelPills();
  };
  r.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════
// MEMORY SYSTEM
// ═══════════════════════════════════════════════════════
