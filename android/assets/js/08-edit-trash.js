function editMessage(nodeId) {
  const chat = getActiveChat();
  const old  = chat?.nodes[nodeId];
  if (!old || old.role !== 'user') return;

  // Find the bubble element and replace it with an inline editor
  const msgEl = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!msgEl) return;

  // Build inline edit UI
  const oldBubble = msgEl.querySelector('.bubble.user, .msg-attach');
  if (!oldBubble) return;

  const editWrap = document.createElement('div');
  editWrap.className = 'msg-edit-wrap';
  // 思考链排在正文之前，和气泡里的显示顺序一致；留空即这条没有思考链。
  editWrap.innerHTML = `
    <textarea class="msg-edit-ta msg-edit-think" rows="2" placeholder="我的思考（可留空）">${escHtml(old.userThinking || '')}</textarea>
    <textarea class="msg-edit-ta msg-edit-body" rows="3">${escHtml(old.content)}</textarea>
    <div class="msg-edit-actions">
      <button class="msg-edit-big" onclick="editMessageInComposer(${nodeId}, this)" title="搬到输入框里全屏改，能加图片和文件">⤢ 全屏 · 加附件</button>
      <button class="msg-edit-cancel" onclick="_invalidateNodeCache(${nodeId});renderMessages()">取消</button>
      <button class="msg-edit-save" onclick="submitEditMessage(${nodeId}, this)">✓ 提交并重新生成</button>
    </div>`;
  oldBubble.replaceWith(editWrap);
  // 两个框都按 class 取，别用 querySelector('textarea')——那会拿到思考链
  const body  = editWrap.querySelector('.msg-edit-body');
  const think = editWrap.querySelector('.msg-edit-think');
  const fit = (ta, min) => {
    ta.style.height = 'auto';
    ta.style.height = Math.max(min, ta.scrollHeight) + 'px';
  };
  [[think, 40], [body, 72]].forEach(([ta, min]) => {
    fit(ta, min);
    ta.addEventListener('input', () => fit(ta, min));
  });
  body.focus();
}

function submitEditMessage(nodeId, btn) {
  const editWrap = btn.closest('.msg-edit-wrap');
  if (!editWrap) return;
  const newContent = editWrap.querySelector('.msg-edit-body')?.value?.trim();
  if (!newContent) return;
  const newThinking = editWrap.querySelector('.msg-edit-think')?.value?.trim() || null;

  const chat = getActiveChat();
  const old  = chat?.nodes[nodeId];
  if (!old) return;
  // 一字没改也照样发（用户要的）：原样再开一条分支、重新生成。
  // 以前这里会静默关掉编辑框什么都不做 —— 可她点「提交」就是想要一个新回复，
  // 想重来又不想换说法的时候，那个「什么都没发生」反而像是坏了。
  // 旧分支保留着，左右切分支还能看到原来那条回复。

  // Create new branch user node (keeps old branch intact)
  const newId = nextId();
  chat.nodes[newId] = {
    id: newId, parentId: old.parentId, role: 'user',
    content: newContent,
    tokens: estimateTokens(newContent) + (newThinking ? estimateTokens(newThinking) : 0),
    timestamp: Date.now(), quotes: old.quotes || null, userThinking: newThinking,
    images: old.images || null, files: old.files || null
  };
  // 编辑重发 = 整条分支换掉，正念着的那条马上不在视图里了
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  chat.headId = newId;
  save(); renderMessages();

  // Re-fetch AI reply for new branch
  const activeIds = getActiveChatModelIds();
  const activeConfigs = state.configs.filter(c => activeIds.includes(c.id));
  const path = getMessagePath(chat, newId);
  if (chat.isGroupChat) {
    callGroupChat(activeConfigs, path, chat, newId);
  } else if (activeConfigs.length === 1) {
    callAPI(activeConfigs[0], path, chat, newId);
  } else {
    callAPIMulti(activeConfigs, path, chat, newId);
  }
}

/* ── 在底下输入框里改（用户要的：改消息也要能全屏、能加附件）──
   不另造一套：把这条消息的正文 / 思考 / 图 / 文件 / 引用整份搬进主输入框，展开成全屏，
   主输入框已有的图片、文件、粘贴、拖拽、表情、音频、视频就全都能用了。
   发送仍走 handleSend，只是它会问 composerEditTarget() —— 在改的话新节点挂到原消息的
   父节点下面（= 开新分支重新生成，和行内「提交」一样），而不是挂在 headId 后面。
   她原来没发的草稿先收进 stash，发出去或取消后原样还回来。 */
let _composerEdit = null;   // { chatId, nodeId, stash: { text, thinking, imgs, files, quotes } }

function editMessageInComposer(nodeId, btn) {
  const chat = getActiveChat();
  const old  = chat?.nodes[nodeId];
  const input = document.getElementById('userInput');
  if (!old || old.role !== 'user' || !input) return;
  const thinkingInput = document.getElementById('userThinkingInput');
  // 行内框里已经改了一半的字跟着搬过去，别让她重打
  const wrap = btn && btn.closest ? btn.closest('.msg-edit-wrap') : null;
  const body  = wrap ? wrap.querySelector('.msg-edit-body')?.value  : old.content;
  const think = wrap ? wrap.querySelector('.msg-edit-think')?.value : old.userThinking;
  // 已经在改另一条时不再收一次草稿 —— 那样收进去的是上一条的修改稿，她真正的草稿就丢了
  if (!_composerEdit) {
    _composerEdit = { stash: {
      text: input.value, thinking: thinkingInput ? thinkingInput.value : '',
      imgs: _pendingImgs, files: _pendingFiles, quotes: _pendingQuotes } };
  }
  _composerEdit.chatId = chat.id;
  _composerEdit.nodeId = nodeId;
  input.value = body || '';
  if (thinkingInput) { thinkingInput.value = think || ''; autoResize(thinkingInput); }
  // 拷一份：在输入框里 × 掉某张图不能改到原消息节点上
  _pendingImgs   = old.images ? [...old.images] : [];
  _pendingFiles  = old.files  ? old.files.map(f => ({ ...f })) : [];
  _pendingQuotes = old.quotes ? [...old.quotes] : [];
  renderPendingImgs(); renderPendingFiles(); renderQuoteBar();
  renderComposerEditBar();
  _invalidateNodeCache(nodeId); renderMessages();   // 收起行内编辑框
  toggleInputExpand(true);
  try { updateInputTokenEstimate(); } catch {}
}

// handleSend 问：这次发送是不是在改某条消息？
//   null  = 没在改，照常发
//   节点  = 在改这条，新节点挂到它的父节点下
//   false = 在改，但那条已经不在当前对话里了（被删 / 对话被别的路切走）——
//           别把改的字当新消息发到别处去，由 handleSend 拦下
function composerEditTarget(chat) {
  if (!_composerEdit) return null;
  if (!chat || chat.id !== _composerEdit.chatId) return false;
  const old = chat.nodes && chat.nodes[_composerEdit.nodeId];
  return old && old.role === 'user' ? old : false;
}

// 结束「在输入框里改」：发出去了或取消了都走这里，把她原来的草稿还回去
function endComposerEdit() {
  if (!_composerEdit) return;
  const s = _composerEdit.stash;
  _composerEdit = null;
  const input = document.getElementById('userInput');
  const thinkingInput = document.getElementById('userThinkingInput');
  if (input) input.value = s.text || '';
  if (thinkingInput) { thinkingInput.value = s.thinking || ''; autoResize(thinkingInput); }
  _pendingImgs = s.imgs || []; _pendingFiles = s.files || []; _pendingQuotes = s.quotes || [];
  renderPendingImgs(); renderPendingFiles(); renderQuoteBar();
  renderComposerEditBar();
  if (input) autoResize(input);
  try { updateInputTokenEstimate(); } catch {}
}

function cancelComposerEdit() {
  if (!_composerEdit) return;
  endComposerEdit();
  if (document.querySelector('.input-bar-wrap.input-expanded')) toggleInputExpand(false);
}

function renderComposerEditBar() {
  const bar = document.getElementById('editModeBar');
  if (!bar) return;
  const chat = _composerEdit && getActiveChat();
  if (!_composerEdit) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const old  = chat && chat.id === _composerEdit.chatId && chat.nodes && chat.nodes[_composerEdit.nodeId];
  const raw = old ? String(old.content || '').replace(/\s+/g, ' ') : '';
  const snip = raw.length > 30 ? raw.slice(0, 30) + '…' : (raw || '（只有附件）');
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="edit-mode-ico">✎</span>
    <span class="edit-mode-text">${old
      ? `正在改「${escHtml(snip)}」· 发出去会开新分支重新生成`
      : '要改的那条消息不在这个对话里了'}</span>
    <button class="quote-cancel-btn" onclick="cancelComposerEdit()">× 不改了</button>`;
}

function regenerate(nodeId) {
  // 重新生成 = 这条的内容要被换掉，正念着的那份已经不作数了
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  const chat = getActiveChat();
  const node = chat.nodes[nodeId]; if (!node?.parentId) return;
  // 保留旧 AI 节点作为分支，新回复作为同级兄弟
  chat.headId = node.parentId;
  const path = getMessagePath(chat, node.parentId);
  const activeIds = getActiveChatModelIds();
  const activeConfigs = state.configs.filter(c => activeIds.includes(c.id));
  save(); renderMessages();
  if (chat.isGroupChat) {
    callGroupChat(activeConfigs, path, chat, node.parentId);
  } else if (activeConfigs.length === 1) {
    callAPI(activeConfigs[0], path, chat, node.parentId);
  } else {
    callAPIMulti(activeConfigs, path, chat, node.parentId);
  }
}

// ── Message multi-select mode (batch delete messages) ──
function enterSelectMode() {
  state.isSelectMode = true;
  state.selectedMessageIds.clear();
  document.getElementById('batchActionTray').classList.remove('hidden');
  document.getElementById('selectCount').innerText = '0';
  renderMessages();
  renderConvSettingsBar();
}
function exitSelectMode() {
  state.isSelectMode = false;
  state.selectedMessageIds.clear();
  document.getElementById('batchActionTray').classList.add('hidden');
  renderMessages();
  renderConvSettingsBar();
}
function handleLongPress(id) { enterSelectMode(); toggleMessageSelection(id); }

// ── Chat multi-select mode (batch delete conversations) ──
function toggleChatSelectMode() {
  state.chatSelectMode = !state.chatSelectMode;
  state.selectedChatIds.clear();
  document.getElementById('chatBatchTray').classList.add('hidden');
  renderChatList();
}
function toggleChatSelection(id, e) {
  e?.stopPropagation();
  if (state.selectedChatIds.has(id)) state.selectedChatIds.delete(id);
  else state.selectedChatIds.add(id);
  const tray = document.getElementById('chatBatchTray');
  tray.classList.toggle('hidden', state.selectedChatIds.size === 0);
  document.getElementById('chatSelectCount').innerText = state.selectedChatIds.size;
  renderChatList();
}
function deleteSelectedChats() {
  if (!state.selectedChatIds.size) return;
  const count = state.selectedChatIds.size;
  if (!confirm(`确定删除选中的 ${count} 个对话吗？(可在回收站找回)`)) return;
  state.selectedChatIds.forEach(id => {
    const chat = state.chats.find(c => c.id === id);
    if (chat) {
      state.trash.push({ type: 'chat', chatData: JSON.parse(JSON.stringify(chat)), deletedAt: new Date().toISOString() });
    }
  });
  /* ❗这里原来**完全没有云端删除**，只删本地 —— 单个删的 deleteChat 有，批量删没有。
     结果是批量删掉的对话下次启动被「清点补漏」原样拉回来，一个不少。
     用户说的「反复删除了十几次又冒出来」删的就是这条路。
     现在两件事都做：打墓碑（本地永久不再接受它）+ 删云端（失败留待重试）。 */
  const goneIds = [...state.selectedChatIds];
  goneIds.forEach(id => markChatDeleted(id));
  state.chats = state.chats.filter(c => !state.selectedChatIds.has(c.id));
  pruneDeadFavs();
  if (!state.chats.length) createNewChat();
  else if (!state.chats.find(c => c.id === state.activeChatId)) {
    // 当前这个对话被一起删掉了，直接切走 —— 不走 switchChat 也不走 createNewChat，
    // 所以叫停得写在这儿（上面那条 createNewChat 分支自己会停）
    if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
    state.activeChatId = state.chats[0].id; renderMessages();
  }
  toggleChatSelectMode();
  save(); renderChatList();
  purgeDeletedChatsFromCloud(goneIds);
  showToast(`✓ 已删除 ${count} 个对话`, 'success');
}
// 📥 初始化回收站多选控制状态
state.trashSelectMode = false;
state.selectedTrashIdxs = new Set(); // 存储被勾选的数组下标 i

function enterTrashSelectMode() {
  state.trashSelectMode = true;
  state.selectedTrashIdxs.clear();
  renderTrashList();
}

function exitTrashSelectMode() {
  state.trashSelectMode = false;
  state.selectedTrashIdxs.clear();
  renderTrashList();
}

function toggleTrashSelection(idx) {
  const i = parseInt(idx);
  if (state.selectedTrashIdxs.has(i)) {
    state.selectedTrashIdxs.delete(i);
  } else {
    state.selectedTrashIdxs.add(i);
  }
  renderTrashList();
}

// 批量恢复逻辑：精准调用你原有的专用恢复函数
function batchRecoverTrash() {
  if (!state.selectedTrashIdxs || state.selectedTrashIdxs.size === 0) {
    alert('请先勾选需要恢复的项目哦！');
    return;
  }
  
  // 1. 依然是从大到小排序，确保从后往前处理
  const sortedIdxs = Array.from(state.selectedTrashIdxs).sort((a, b) => b - a);
  
  // 确保系统的数据结构是健康的
  if (!state.memories) state.memories = [];
  if (!state.chats) state.chats = [];
  if (!state.favMessages) state.favMessages = [];

  // 恢复的对话要连带复活收藏，但那会重排 state.trash、打乱下面倒序 splice 的下标，
  // 所以循环里只记映射，等 splice 全部做完再统一复活。
  const chatRemaps = [];

  // 2. 核心大循环：只负责“放回系统”，同时把要剔除的项删掉
  sortedIdxs.forEach(i => {
    const item = state.trash[i];
    if (!item) return;

    // 💡 A 分支：如果是整段对话 —— 深拷贝、重新分配 ID 后插入对话数组
    if (item.type === 'chat') {
      const chat = JSON.parse(JSON.stringify(item.chatData));
      const oldChatId = item.chatData.id;
      chat.id = nextId();
      const oldToNew = {};
      Object.keys(chat.nodes || {}).forEach(oldId => {
        const newId = nextId();
        oldToNew[oldId] = newId;
        chat.nodes[newId] = chat.nodes[oldId];
        chat.nodes[newId].id = newId;
        delete chat.nodes[oldId];
      });
      Object.values(chat.nodes).forEach(n => { if (n.parentId && oldToNew[n.parentId]) n.parentId = oldToNew[n.parentId]; });
      if (chat.headId && oldToNew[chat.headId]) chat.headId = oldToNew[chat.headId];
      state.chats.unshift(chat);
      chatRemaps.push({ oldChatId, newChatId: chat.id, oldToNew });
    }
    // 💡 B 分支：如果是新增的“记忆”
    else if (item.type === 'memory') {
      state.memories.push(Object.assign({}, item.memoryData, { restoredAt: Date.now() }));   // restoredAt：见 01-core 的 memGone 墓碑
    }
    // 💡 B2 分支：被删消息带走的收藏
    else if (item.type === 'fav') {
      // restoredAt：云同步的收藏墓碑（01-core 的 favGone）按时间认，比墓碑新的才算「又收藏回来了」
      state.favMessages.unshift(Object.assign({}, item.favData, { restoredAt: Date.now() }));
    }
    // 💡 C 分支：如果是单条普通消息 —— 找回所属对话，没有就新建
    else if (item.type === 'message' || !item.type) {
      let chat = state.chats.find(c => c.id === item.chatId);
      if (!chat) {
        chat = { id: nextId(), title: item.chatTitle || '已恢复的对话', nodes: {}, headId: null, isPinned: false, activeModelIds: null, msgLimit: 0, totalTokens: 0 };
        state.chats.unshift(chat);
      }
      chat.nodes[item.message.id] = item.message;
      if (!chat.headId || item.message.id > chat.headId) chat.headId = item.message.id;
      // 单条消息恢复后 id 不变，用恒等映射就能把它的收藏一起找回来
      chatRemaps.push({ oldChatId: item.chatId, newChatId: chat.id, oldToNew: { [item.message.id]: item.message.id } });
    }

    // 关键：在这里直接安全地从后往前剔除，因为是倒序，所以完全不会影响前面的未处理下标！
    state.trash.splice(i, 1);
  });
  
  // 3. 循环彻底结束后（下标已不再被使用），复活恢复对话名下的收藏
  chatRemaps.forEach(r => restoreChatFavs(r.oldChatId, r.newChatId, r.oldToNew));
  updateFavBadge();

  // 4. 统一退出管理状态、保存并刷新全站列表
  exitTrashSelectMode();
  save();
  renderTrashList();
  renderChatList();
  
  // 联动刷新记忆列表（防漏调）
  if (typeof renderSettingsMemoryList === 'function') renderSettingsMemoryList();
  if (typeof renderMemoryList === 'function') renderMemoryList();
  
  showToast('✨ 已全部恢复成功！', 'success');
}

// 批量彻底删除逻辑
function batchPermanentDeleteTrash() {
  if (state.selectedTrashIdxs.size === 0) return;
  if (!confirm(`确定要永久删除选中的 ${state.selectedTrashIdxs.size} 项吗？此操作不可逆！`)) return;
  
  const sortedIdxs = Array.from(state.selectedTrashIdxs).sort((a, b) => b - a);
  
  sortedIdxs.forEach(i => {
    // 绕过单项的 confirm 提示，直接批量从数组中拔除
    state.trash.splice(i, 1);
  });
  
  exitTrashSelectMode();
  save(); renderTrashList();
}
function toggleMessageSelection(id, event) {
  if (event) event.stopPropagation();
  state.selectedMessageIds.has(id) ? state.selectedMessageIds.delete(id) : state.selectedMessageIds.add(id);
  document.getElementById('selectCount').innerText = state.selectedMessageIds.size;
  renderMessages();
}
function deleteSingleMessage(nodeId) {
  if (!confirm('确定删除这条消息？')) return;
  // 消息没了，暂停按钮也就没了 —— 不叫停的话音频还在放，她只能刷新页面
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  const chat = getActiveChat();
  if (!chat || !chat.nodes[nodeId]) return;
  state.trash.push({
    id: Date.now() + Math.random(),
    chatId: chat.id,
    chatTitle: chat.title,
    message: { ...chat.nodes[nodeId] },
    deletedAt: new Date().toISOString()
  });
  const parentId = chat.nodes[nodeId].parentId;
  // 🔧 把被删消息的"下一句"接到它的"上一句"身上，不让后面的对话也被清掉
  Object.values(chat.nodes).forEach(n => {
    if (n.parentId === nodeId) n.parentId = parentId;
  });
  delete chat.nodes[nodeId];
  if (chat.headId === nodeId) chat.headId = parentId || null;
  pruneDeadFavs();
  save(); renderMessages(); _debouncedSidebarUpdate();
}
function deleteSelectedMessages() {
  // 批量删里可能就有正在念的那条
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  const chat = getActiveChat();
  // 先记录每个节点的 parentId
  const parentMap = {};
  state.selectedMessageIds.forEach(id => {
    if (chat.nodes[id]) parentMap[id] = chat.nodes[id].parentId;
  });
  // 再删除
    state.selectedMessageIds.forEach(id => {
    if (chat.nodes[id]) {
      // 先存入回收站
      state.trash.push({
        id: Date.now() + Math.random(),
        chatId: chat.id,
        chatTitle: chat.title,
        message: { ...chat.nodes[id] },  // 深拷贝
        deletedAt: new Date().toISOString()
      });
      // 再删除
      delete chat.nodes[id];
    }
  });
  // 向上找到第一个未被删除的祖先
  const liveAncestor = (id) => {
    while (id && parentMap.hasOwnProperty(id)) id = parentMap[id] ?? null;
    return id || null;
  };
  // 🔧 和单条删一样：被删消息后面的对话接到最近的未删祖先上。
  // 以前这里是「清理孤儿」，删中间一条会把后面整段对话连带抹掉，还不进回收站
  Object.values(chat.nodes).forEach(n => {
    if (n.parentId && parentMap.hasOwnProperty(n.parentId)) n.parentId = liveAncestor(n.parentId);
  });
  chat.headId = liveAncestor(chat.headId);
  pruneDeadFavs();
  exitSelectMode(); save(); renderChatList(); renderMessages();
}

// ═══════════════════════════════════════════════════════
// RELATIVE TIME
// ═══════════════════════════════════════════════════════
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1)  return '刚刚';
  if (min < 60) return `${min}分钟前`;
  if (hr  < 24) return `${hr}小时前`;
  if (day === 1) return '昨天';
  if (day < 7)  return `${day}天前`;
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()}`;
}

// 获取对话最后一条消息的时间戳
function getChatLastTimestamp(chat) {
  if (!chat?.nodes || !chat.headId) return null;
  let cur = chat.headId;
  while (cur && chat.nodes[cur]) {
    const n = chat.nodes[cur];
    if (n.timestamp) return n.timestamp;
    cur = n.parentId;
  }
  return null;
}


