function copyLastAIReply() {
  const chat = getActiveChat();
  if (!chat || !chat.headId) return;
  // 从 headId 往上找到最近的 AI 消息
  let cur = chat.headId;
  while (cur) {
    const node = chat.nodes[cur];
    if (!node) break;
    if (node.role === 'ai') {
      const text = node.variants 
        ? (node.variants[node.chosenVariant ?? 0]?.content || '')
        : (node.content || '');
      copyTextCompat(text).then(() => {
        const btn = document.getElementById('copyLastReplyBtn');
        btn.textContent = '✅ 已复制';
        setTimeout(() => { btn.textContent = '📋 复制上条回复'; }, 1500);
      }).catch(() => {});
      return;
    }
    cur = node.parentId;
  }
}
function copyMyLastMessage() {
  const chat = getActiveChat();
  if (!chat || !chat.headId) return;
  let cur = chat.headId;
  while (cur) {
    const node = chat.nodes[cur];
    if (!node) break;
    if (node.role === 'user') {
      const text = node.content || '';
      copyTextCompat(text).then(() => {
        const btn = document.getElementById('copyMyLastMsgBtn');
        btn.textContent = '✅ 已复制';
        setTimeout(() => { btn.textContent = '📋 复制我的消息'; }, 1500);
      }).catch(() => {});
      return;
    }
    cur = node.parentId;
  }
}
function renderTrashList() {
  const el = document.getElementById('trashList');
  if (!el) return;

  // 1. 初始化并进行分类过滤
  const currentFilter = state.trashFilter || 'all';
  const filteredList = currentFilter === 'all' 
    ? state.trash 
    : state.trash.filter(item => {
        const type = item.type || 'message';
        return type === currentFilter;
      });

  // 如果回收站总数为 0，表示彻底清空或没有任何垃圾，显示空空如也提示
  if (!state.trash || !state.trash.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:16px 0;text-align:center">(´• ω •`) 回收站是空的，什么都没有呢</div>';
    return;
  }

  const accent = activeAccent();

  // 2. 动态生成切换分类小标签的 HTML（在这里实时计算每个分类有多少条）
  const filters = [
    { key: 'all', label: '全部' },
    { key: 'memory', label: '记忆' },
    { key: 'message', label: '消息' },
    { key: 'chat', label: '对话' },
    { key: 'fav', label: '收藏' }
  ];

  let filterTabsHtml = `<div style="display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;padding-bottom:4px;">`;
  filters.forEach(f => {
    const isActive = currentFilter === f.key;
    // 动态计算该分类在回收站数组里的实时数量
    const count = f.key === 'all' ? state.trash.length : state.trash.filter(i => (i.type || 'message') === f.key).length;
    
    filterTabsHtml += `
      <button onclick="state.trashFilter='${f.key}';exitTrashSelectMode();renderTrashList();"
        style="background: ${isActive ? 'var(--accent-soft)' : 'rgba(255,255,255,0.02)'}; 
               color: ${isActive ? 'var(--accent)' : 'var(--text-muted)'}; 
               border: 1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}; 
               border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; 
               font-family: var(--font); white-space: nowrap; transition: all 0.2s ease;">
        ${f.label} (${count})
      </button>`;
  });
  filterTabsHtml += `</div>`;

  // 3. 顶部操作工具栏（一键清空与批量管理并存）
  let batchBarHtml = '';
  if (state.trashSelectMode) {
    batchBarHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:12px;gap:10px;">
        <div style="font-size:12px;color:var(--text-primary)">已选中 <span style="color:${accent};font-weight:bold;">${state.selectedTrashIdxs.size}</span> 项</div>
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button onclick="batchRecoverTrash()" class="trash-batch-recover" style="background: var(--accent-soft); color: var(--accent); border: 1px solid rgba(255,255,255,0.02); border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: var(--font); transition: all 0.2s ease;">批量恢复</button>
          <button onclick="batchPermanentDeleteTrash()" class="trash-batch-delete" style="background: rgba(239, 68, 68, 0.05); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: var(--font); transition: all 0.2s ease;">彻底删除</button>
          <button onclick="exitTrashSelectMode()" class="trash-batch-cancel" style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); color: var(--text-dim); border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: var(--font); transition: all 0.2s ease;">取消</button>
        </div>
      </div>`;
  } else {
    batchBarHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;">
        <button onclick="if(confirm('你真的确定清空回收站？(・・;)   （好吧我也阻止不了你…')){state.trash=[];save();renderTrashList()}" 
          class="trash-clear-btn"
          style="background: rgba(239, 68, 68, 0.08); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; padding: 8px 16px; font-family: var(--font); font-size: 12px; cursor: pointer; flex-shrink: 0; transition: all 0.2s ease;">
          🗑 清空全部（${state.trash.length} 条）
        </button>
        <button onclick="enterTrashSelectMode()" class="trash-batch-manage-btn" style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); color: var(--text-dim); border-radius: 8px; padding: 8px 16px; font-size: 12px; cursor: pointer; font-family: var(--font); flex-shrink: 0; transition: all 0.2s ease;">⚙ 批量管理</button>
      </div>`;
  }

  // 4. ✨ 核心漏洞堵截：如果当前分类过滤后【没有数据】，但垃圾箱其实【有别的分类】，依然显示顶部的标签导航！
  if (filteredList.length === 0) {
    el.innerHTML = filterTabsHtml + batchBarHtml + `<div style="font-size:12px;color:var(--text-muted);padding:32px 0;text-align:center">该分类下没有被删除的内容哦 🍃</div>`;
    return;
  }

// 5. 核心列表生成：将 filteredList 转化为卡片
  let listHtml = filteredList.map((item) => {
    // 关键设计：通过绝对定位，在原大数组中查找下标 i，保证点击“恢复”和“删除”时索引完全正确，绝不发生错位
    const i = state.trash.indexOf(item);
    if (i === -1) return '';

    let displayTitle = '';
    let displaySub = '';
    let restoreFunc = '';
    let typeBadge = '';

    if (item.type === 'chat') {
      displayTitle = '对话「' + escHtml(item.chatData?.title || '未命名') + '」';
      displaySub = (Object.keys(item.chatData?.nodes || {}).length) + ' 条消息';
      restoreFunc = 'restoreChatFromTrash(' + i + ')';
      typeBadge = '<span style="background:#f59e0b33;color:#f59e0b;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:6px">对话</span>';

    } else if (item.type === 'message' || !item.type) {
      displayTitle = escHtml((item.message?.content || '').slice(0, 40)) + ((item.message?.content || '').length > 40 ? '…' : '');
      displaySub = '来自「' + escHtml(item.chatTitle || '') + '」';
      restoreFunc = 'restoreFromTrash(' + i + ')';
      typeBadge = '';

    } else if (item.type === 'fav') {
      const favText = item.favData?.text || '(空)';
      displayTitle = '收藏「' + escHtml(favText.slice(0, 40)) + (favText.length > 40 ? '…' : '') + '」';
      displaySub = '来自「' + escHtml(item.favData?.chatTitle || '') + '」· ' + escHtml(item.favData?.model || '');
      restoreFunc = `restoreFavFromTrash(${i})`;
      typeBadge = '<span style="background:#eab30833;color:#eab308;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:6px">收藏</span>';

    } else if (item.type === 'memory') {
      const memoryText = item.memoryData?.content || item.memoryData?.text || '空白记忆';
      displayTitle = '记忆「' + escHtml(memoryText.slice(0, 40)) + (memoryText.length > 40 ? '…' : '') + '」';
      displaySub = '独立记忆片段';
      // 💡 核心修正：单条恢复记忆时，直接触发内联的安全安全救赎，确保不依赖未知的全局变量
      restoreFunc = `if(!state.memories)state.memories=[]; state.memories.push(Object.assign({}, state.trash[${i}].memoryData, { restoredAt: Date.now() })); state.trash.splice(${i},1); save(); renderTrashList(); if(typeof renderSettingsMemoryList==='function')renderSettingsMemoryList(); if(typeof renderMemoryList==='function')renderMemoryList(); showToast('✨ 记忆已成功恢复！', 'success');`;
      typeBadge = '<span style="background:#10b98133;color:#10b981;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:6px">记忆</span>';
    }

    const isSelected = state.selectedTrashIdxs.has(i);

    return `
      <div class="trash-card" data-ti="${i}" style="background: rgba(22, 22, 34, 0.4); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--border); border-radius: var(--radius-md);
        padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);">
        
        <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1;">
          ${state.trashSelectMode ? `
            <input type="checkbox" ${isSelected ? 'checked' : ''} 
              onclick="toggleTrashSelection(${i})" 
              style="width:16px;height:16px;accent-color:${accent};flex-shrink:0;cursor:pointer;">
          ` : ''}
          
          <div style="min-width:0;flex:1;">
            <div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${displayTitle}${typeBadge}
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">
              ${displaySub} · ${new Date(item.deletedAt).toLocaleString()}
            </div>
          </div>
        </div>

        ${!state.trashSelectMode ? `
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button onclick="${restoreFunc}" class="trash-item-recover"
              style="background: var(--accent-soft); color: var(--accent); border: 1px solid rgba(255,255,255,0.02); border-radius: 6px;
              padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: var(--font); transition: all 0.2s ease;">恢复</button>
            <button onclick="permanentDelete(${i})" class="trash-item-delete"
              style="background: rgba(239, 68, 68, 0.03); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; cursor: pointer; font-size: 11px;
              padding: 4px 10px; border-radius: 6px; font-family: var(--font); transition: all 0.2s ease;">⨉</button>
          </div>
        ` : ''}
      </div>`;
  }).join('');

  // 拼接所有的内容并塞回 DOM
  el.innerHTML = filterTabsHtml + batchBarHtml + listHtml;
}
function restoreFromTrash(index) {
  const item = state.trash[index];
  if (!item) return;
  let chat = state.chats.find(c => c.id === item.chatId);
  if (!chat) {
    chat = { id: nextId(), title: item.chatTitle, nodes: {}, headId: null, isPinned: false, activeModelIds: null, msgLimit: 0, totalTokens: 0 };
    state.chats.unshift(chat);
  }
  chat.nodes[item.message.id] = item.message;
  if (!chat.headId || item.message.id > chat.headId) {
    chat.headId = item.message.id;
  }
  state.trash.splice(index, 1);
  // 消息 id 恢复后不变，用恒等映射把它当初被连带删掉的收藏一起找回来
  const revived = restoreChatFavs(item.chatId, chat.id, { [item.message.id]: item.message.id });
  save(); renderTrashList(); renderChatList(); renderMessages();
  showToast('✓ 消息已恢复到「' + chat.title + '」' + (revived ? '（含收藏）' : ''), 'success');
}

function restoreChatFromTrash(index) {
  const item = state.trash[index];
  if (!item || item.type !== 'chat') return;
  // 用深拷贝恢复对话，并分配新 ID 防止冲突
  const chat = JSON.parse(JSON.stringify(item.chatData));
  const oldChatId = item.chatData.id;
  chat.id = nextId();
  // 把所有消息节点的 ID 也重新分配
  const oldToNew = {};
  Object.keys(chat.nodes || {}).forEach(oldId => {
    const newId = nextId();
    oldToNew[oldId] = newId;
    chat.nodes[newId] = chat.nodes[oldId];
    chat.nodes[newId].id = newId;
    delete chat.nodes[oldId];
  });
  // 更新 parentId 引用
  Object.values(chat.nodes).forEach(n => {
    if (n.parentId && oldToNew[n.parentId]) {
      n.parentId = oldToNew[n.parentId];
    }
  });
  // 更新 headId
  if (chat.headId && oldToNew[chat.headId]) {
    chat.headId = oldToNew[chat.headId];
  }
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  state.trash.splice(index, 1);
  const revived = restoreChatFavs(oldChatId, chat.id, oldToNew);
  save(); renderTrashList(); renderChatList(); renderMessages();
  showToast('✓ 对话「' + chat.title + '」已恢复' + (revived ? `（含 ${revived} 条收藏）` : ''), 'success');
}
function restoreFavFromTrash(index) {
  const item = state.trash[index];
  if (!item || item.type !== 'fav') return;
  state.favMessages = state.favMessages || [];
  // restoredAt：云同步的收藏墓碑（01-core 的 favGone）按时间认，比墓碑新的才算「又收藏回来了」
  state.favMessages.unshift(Object.assign({}, item.favData, { restoredAt: Date.now() }));
  state.trash.splice(index, 1);
  updateFavBadge();
  save(); renderTrashList();
  showToast('★ 收藏已恢复', 'success');
}

function permanentDelete(index) {
  if (!state.trash || !state.trash[index]) return;
  const item = state.trash[index];
  let confirmMsg = '确定永久删除这条消息？此操作不可恢复。'; // 默认提示
  // 根据回收站条目的类型，切换不同的提示语
  if (item.type === 'chat') {
    confirmMsg = `确定永久删除整个对话「${item.chatData?.title || '未命名'}」吗？此操作将永远无法恢复！`;
  } else if (item.type === 'fav') {
    confirmMsg = '确定永久删除这条收藏吗？此操作不可恢复。';
  } else if (item.type === 'memory') {
    confirmMsg = '确定永久抹除这条记忆吗？此操作不可恢复，AI 将永远忘记这件事。';
  }
  // 弹出定制化的确认框
  if (!confirm(confirmMsg)) return;
  // 执行删除
  state.trash.splice(index, 1);
  save(); 
  renderTrashList();
}

// 监听 chatWindow 滚动，显示/隐藏"回到底部"和"回到顶部"按钮
document.getElementById('chatWindow').addEventListener('scroll', function() {
  const atBottom = this.scrollHeight - this.scrollTop - this.clientHeight < 120;
  const atTop = this.scrollTop < 120;
  document.getElementById('scrollBottomBtn').classList.toggle('hidden-nav', atBottom);
  document.getElementById('scrollTopBtn').classList.toggle('hidden-nav', atTop);
});

function scrollToBottom() {
  const win = document.getElementById('chatWindow');
  win.scrollTo({ top: win.scrollHeight, behavior: 'smooth' });
  // 同 _scrollToBottomSettled 的道理：content-visibility:auto 下 scrollHeight 是估算值，
  // 平滑滚动途中那些消息才拿到真实高度、底部随之变远，一次 scrollTo 会停在半空。
  // 滚动停下来再补一次（scrollend 不是所有内核都有，用静默计时兜底）。
  let last = -1, tries = 0;
  const settle = () => {
    if (!win.isConnected || tries++ > 12) return;
    if (win.scrollTop === last) { win.scrollTo({ top: win.scrollHeight, behavior: 'auto' }); return; }
    last = win.scrollTop;
    setTimeout(settle, 60);
  };
  setTimeout(settle, 60);
}
// ═══════════════════════════════════════════════════════
// GROUP CHAT
// ═══════════════════════════════════════════════════════
async function createGroupChat() {
  if (state.configs.length < 2) {
    alert('群聊至少需要 2 个 AI 模型，请先在设置中添加模型配置。');
    return;
  }
  let memberSelection = '';
  state.configs.forEach((c, i) => {
    memberSelection += `${i+1}. ${c.nickname} (${c.modelName})\n`;
  });

  const selectedIndices = await appPrompt(
    '选择参与群聊的模型（用逗号分隔序号，如 1,2,3）：\n\n' + memberSelection
  );
  if (!selectedIndices) return;

  const indices = selectedIndices.split(',').map(s => parseInt(s.trim()) - 1)
    .filter(i => i >= 0 && i < state.configs.length);
  if (indices.length < 2) { alert('至少选择 2 个模型'); return; }

  const members = [];
  for (const i of indices) {
    const freq = await appPrompt(
      `设置「${state.configs[i].nickname}」的回复频率：\nhigh = 话多(90%)\nmedium = 正常(60%)\nlow = 话少(30%)`,
      'medium'
    );
    members.push({
      configId: state.configs[i].id,
      nickname: state.configs[i].nickname,
      frequency: ['high','medium','low'].includes(freq) ? freq : 'medium'
    });
  }

  const rounds = parseInt(await appPrompt('群聊轮数（每轮每个 AI 可能回复一次）：', '3')) || 3;
  
  const chat = {
    id: nextId(),
    title: '群聊 · ' + members.map(m => m.nickname).join('、'),
    nodes: {},
    headId: null,
    isPinned: false,
    activeModelIds: members.map(m => m.configId),
    msgLimit: 0,
    totalTokens: 0,
    isGroupChat: true,      // ← 就在这里
    groupMembers: members,  // ← 就在这里
    groupRounds: rounds     // ← 就在这里
  };
  
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  save(); renderChatList(); renderMessages(); renderModelPills(); renderConvSettingsBar(); updateGroupBoardBtn();
}
let _ctxNodeId = null;

// 右键会把用户已选中的文字取消掉：contextmenu 事件触发时选区往往已被浏览器折叠清空，
// 导致「选取部分却复制全部」。所以在 mousedown 捕获阶段（默认折叠动作发生之前）先抓一份选区。
let _pendingSel = null;
document.addEventListener('mousedown', function(e) {
  if (e.button === 2) {   // 右键
    const s = window.getSelection()?.toString().trim();
    _pendingSel = s || null;
  }
}, true);

/* 消息里面也会长出输入框：改自己那条消息的编辑框、单词卡的笔记框、拼写题的作答框。
   在这些框里右键 / 长按，要的是系统那个带「粘贴」的菜单（exe 里是 electron-main.js
   给的剪切/复制/粘贴/全选，手机上是系统取词条），不是消息菜单。
   消息的 oncontextmenu 是行内写的、先 preventDefault 再开菜单 —— 一旦让它跑到，
   系统菜单就没了。所以在 document 的 capture 阶段截住：落在可编辑元素上就
   stopPropagation，行内那个根本收不到，默认菜单照常弹。
   只截停传播、不碰 preventDefault；29-multiselect.js 冒泡阶段那个「按 Ctrl 多选」
   提示也一起被跳过 —— 它会 preventDefault，放它过去一样把粘贴吃掉。 */
function _ctxIsEditable(t) {
  const el = t && (t.nodeType === 1 ? t : t.parentElement);
  return !!(el && el.closest &&
    el.closest('textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), [contenteditable=""], [contenteditable="true"]'));
}
document.addEventListener('contextmenu', function(e) {
  if (_ctxIsEditable(e.target) && e.target.closest && e.target.closest('[data-node-id]')) e.stopPropagation();
}, true);
// 长按开菜单走的是 600ms 定时器（showContextMenuAtMsg），不经过 contextmenu。
// 记下最后一次按下落在哪，按在输入框里的就不开 —— 手机上那一下长按归系统的「粘贴」。
let _ctxDownTarget = null;
['mousedown', 'touchstart'].forEach(type => document.addEventListener(type, function(e) {
  _ctxDownTarget = e.target;
}, { capture: true, passive: true }));

function showContextMenu(e, nodeId) {
  _ctxNodeId = nodeId;
  _selTarget = (window.getSelection()?.toString().trim()) || _pendingSel || null;
  _pendingSel = null;
  const menu = document.getElementById('contextMenu');
  menu.classList.remove('ctx-mobile-bar');
  menu.style.display = 'flex';
  document.getElementById('floatReplyBtn').style.display = 'none';
  var menuW = menu.offsetWidth || 230;
  menu.style.left = Math.min(e.clientX, window.innerWidth - menuW - 10) + 'px';
  menu.style.left = Math.max(8, parseInt(menu.style.left)) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
}

/* 关掉消息右键菜单，并且**把 _ctxNodeId 一起清掉**。
   两件事必须一起做：菜单藏了但 _ctxNodeId 还指着上一条消息的话，
   下次菜单项被点到就作用在错的消息上（里面有「删除」）。
   提成函数是为了让别处也能关 —— 29-multiselect.js 里 Ctrl 命中时在 capture 阶段
   stopPropagation，下面那个冒泡监听根本跑不到，得由它显式调这个。 */
function closeMsgContextMenu() {
  const m = document.getElementById('contextMenu');
  if (m) m.style.display = 'none';
  _ctxNodeId = null;
}

// 点击其他地方关闭菜单
document.addEventListener('click', function(e) {
  if (!e.target.closest('#contextMenu')) {
    // 延后一点：菜单项自己的 click 要先跑完，不然菜单先没了，这一下就丢了
    setTimeout(closeMsgContextMenu, 50);
  }
});

// 长按那一刻系统还没取完词，_selTarget 往往是空的——所以点"复制"时要再看一眼实时选区，
// 只认落在这条消息里的选区（否则会把菜单/别处的文字也算进来）。
function liveSelectionIn(nodeId) {
  const sel = window.getSelection();
  const s = sel && sel.toString().trim();
  if (!s || !sel.rangeCount) return null;
  const group = document.querySelector('[data-node-id="' + nodeId + '"]');
  if (!group) return null;
  const anchor = sel.getRangeAt(0).commonAncestorContainer;
  const el = anchor.nodeType === 3 ? anchor.parentElement : anchor;
  return (el && group.contains(el)) ? s : null;
}

function ctxTargetText() {
  return liveSelectionIn(_ctxNodeId) || _selTarget || (() => {
    const chat = getActiveChat();
    const node = chat?.nodes?.[_ctxNodeId];
    return node?.variants ? (node.variants[node.chosenVariant ?? 0]?.content || '') : (node?.content || '');
  })();
}

/* 手机上没有 hover，msg-actions 那条操作栏基本点不到，所以标注也得有一个长按入口。
   先把 _ctxNodeId 抄下来再关菜单 —— closeMsgContextMenu() 会把它清空，
   顺序反了就会对着 null 开选择器（不报错，只是什么都不发生）。*/
function ctxReactMsg(ev) {
  const id = _ctxNodeId;
  // 位置要在关菜单**之前**量：菜单一藏，按钮的 rect 就全是 0，浮层会飞到屏幕左上角。
  const rect = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
  if (ev) ev.stopPropagation();   // 不然这一下点击冒到 document，刚开的浮层立刻被关掉
  closeMsgContextMenu();
  if (id == null || typeof openReactionPicker !== 'function') return;
  openReactionPicker(id, null, rect);
}

function ctxCopyMsg() {
  const sel = liveSelectionIn(_ctxNodeId);
  const textToCopy = ctxTargetText();
  copyTextCompat(textToCopy).then(() => {
    showToast(sel ? '已复制选中文字' : '已复制整条', 'success');
  }).catch(() => {});
  _selTarget = null;
  document.getElementById('contextMenu').style.display = 'none';
  _ctxNodeId = null;
}
function ctxDeleteMsg() {
  if (!confirm('确定删除这条消息？')) return;
  const nodeId = _ctxNodeId;
  document.getElementById('contextMenu').style.display = 'none';
  _ctxNodeId = null;
  if (!nodeId) return;
  deleteSingleMessage(nodeId);
}
function ctxQuoteMsg() {
  const text = ctxTargetText();
  if (text) { _pendingQuotes.push({ text: text.slice(0, 200), sourceNodeId: _ctxNodeId }); renderQuoteBar(); }
  _selTarget = null;
  document.getElementById('contextMenu').style.display = 'none';
  _ctxNodeId = null;
}

function showContextMenuAtMsg(nodeId) {
  if (_ctxIsEditable(_ctxDownTarget)) return;
  _ctxNodeId = nodeId;
  _selTarget = window.getSelection()?.toString().trim() || null;
  const menu = document.getElementById('contextMenu');
  const el = document.querySelector('[data-node-id="' + nodeId + '"]')
          || document.querySelector('.msg-group:last-child');
  menu.style.display = 'flex';
  document.getElementById('floatReplyBtn').style.display = 'none';

  // 手机端：菜单绝不能压在手指/选区上——长按同时也是系统的取词手势，
  // 菜单浮在文字上就看不见自己在选什么，拖选区的把手也点不到。钉在屏幕底部横条。
  if (isMobileLayout()) {
    menu.classList.add('ctx-mobile-bar');
    menu.style.left = ''; menu.style.top = '';
    return;
  }
  menu.classList.remove('ctx-mobile-bar');

  let x, y;
  if (_lastTouchX && _lastTouchY) {
    x = _lastTouchX; y = _lastTouchY;
  } else if (el) {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2; y = r.top + r.height / 2;
  } else {
    x = window.innerWidth / 2; y = window.innerHeight / 2;
  }
  menu.style.left = Math.min(x, window.innerWidth - 240) + 'px';
  menu.style.left = Math.max(8, parseInt(menu.style.left)) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 60) + 'px';
}

// ══════════════════════════════════════════════════════════
// FILE CARD REGISTRY — avoids embedding raw content in onclick attrs
// (fixes .html overflow bug and .txt viewer no-response bug)
// ══════════════════════════════════════════════════════════
let _renderedFiles = {};
function renderFileCard(f, fi, msgId) {
  const key = `f_${msgId}_${fi}`;
  _renderedFiles[key] = { name: f.name, content: f.content };
  const ext = f.name.split('.').pop().toLowerCase();
  const icon = ['png','jpg','jpeg','gif','webp','svg'].includes(ext) ? '🖼' : ext === 'pdf' ? '📕' : '📄';
  return `<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;margin-bottom:4px;font-size:12px;display:flex;align-items:center;gap:6px;min-width:0">
    <span>${icon}</span>
    <span style="font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(f.name)}</span>
    <span style="color:var(--text-muted);font-size:10px;flex-shrink:0">${f.content.length.toLocaleString()} 字</span>
    <button onclick="openFileViewerByKey('${key}')" style="flex-shrink:0;margin-left:4px;background:none;border:1px solid var(--border);border-radius:12px;padding:2px 8px;font-size:10px;color:var(--text-muted);cursor:pointer;font-family:var(--font);transition:color .15s,border-color .15s" onmouseover="this.style.color='var(--accent)';this.style.borderColor='var(--accent)'" onmouseout="this.style.color='var(--text-muted)';this.style.borderColor='var(--border)'">查看</button>
  </div>`;
}
function openFileViewerByKey(key) {
  const f = _renderedFiles[key];
  if (!f) { console.warn('file not found:', key); return; }
  openFileViewer(f.name, f.content);
}

// ══════════════════════════════════════════════════════════
// CODE SYNTAX HIGHLIGHT via highlight.js
// ══════════════════════════════════════════════════════════
// 中文加粗修正。**必须排在 hljs 那道守卫前面** —— 它跟代码高亮没关系，
// 没装 hljs 也得生效，塞进下面那个 try 里会被 `if (!window.hljs) return` 一起跳过。
//
// 病根是 CommonMark 的 right-flanking 规则：结束的 ** 前面是标点、后面是文字时，
// 不算闭合。英文写 `**Note:** text` 没事（** 后面是空格）；中文写 `**标题：**正文`
// 就炸，而这恰恰是模型最爱的格式，于是气泡里天天飘星号。
// 中招的还有 **内容。**后面 / **内容，**后面 / **内容！**后面 / **（内容）**后面……
//
// 加一条优先于内置 emStrong 的 inline 规则：只认「** 紧跟非空白 … 非空白紧跟 **」。
// 内侧带空格的（`** 内容**`、`**内容 **`）照旧不渲染，保持 CommonMark 原状。
// 只做 **，**不碰 __** —— 放宽下划线会把 __init__ / snake_case 全变成加粗。
// 行内代码和代码块不受影响：那两个 tokenizer 从起始字符就把整段吃掉了，轮不到这里。
let _cjkStrongInited = false;
function initMarkedCjkStrong() {
  if (_cjkStrongInited) return;                     // marked.use 会累加，别注册两遍
  if (typeof marked === 'undefined' || !marked.use) return;
  try {
    marked.use({
      extensions: [{
        name: 'cjkStrong',
        level: 'inline',
        start(src) { const i = src.indexOf('**'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          // 两个 (?!\*) 是必须的：`***内容***`（粗斜体）内置处理得好好的，
          // 让这条规则接管的话，`**` 会先吃掉两个星号、把第三个当正文，
          // 结果是 <strong>*内容</strong>* —— 我第一版就这么咬坏了（测试逮到的）。
          // 三星号一律让给内置 emStrong。
          const m = /^\*\*(?!\*)(?=\S)([\s\S]*?\S)\*\*(?!\*)/.exec(src);
          if (!m) return;
          return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        },
      }],
    });
    _cjkStrongInited = true;
  } catch (e) { console.warn('cjkStrong init failed:', e); }
}
// 脚本一加载就打上，**不等启动流程**。initMarked() 是在 14-boot 的初始化里才被调用的，
// 比 renderRichText 可用的时刻晚不少；那段空窗里渲染的消息会用到没打补丁的 marked，
// 于是「有时候有星号有时候没有」。marked 在 <head> 里同步加载，这里必定拿得到。
initMarkedCjkStrong();

function initMarked() {
  initMarkedCjkStrong();          // 幂等，仅作兜底（万一上面那次比 marked 还早）
  if (!window.hljs) return;
  try {
    marked.use({
      renderer: {
        code: function(token) {
          const text = (typeof token === 'object' && token) ? (token.text || '') : String(token || '');
          const lang = (typeof token === 'object' && token) ? (token.lang || '') : '';

          // ── 超长代码 / 网页(HTML) / 矢量图(SVG) 不再堆在气泡里，改成一张卡片，点开右侧画布 ──
          const lowerLang = (lang || '').toLowerCase();
          const isCanvasType = ['html','svg','xml'].includes(lowerLang);
          const runKind = artifactRunKind(lowerLang);
          const lineCount = text.split('\n').length;
          // 能跑的块（含短块）都登记，▶ 运行时要按 data-art 把同一条消息里的 html/css/js 拼起来
          let artId = '';
          if (runKind || isCanvasType || lineCount > 15 || text.length > 600) {
            artId = 'art_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            window.__artifacts = window.__artifacts || {};
            window.__artifacts[artId] = { code: text, lang: lang || 'text' };
          }
          if (isCanvasType || lineCount > 15 || text.length > 600) {
            const icon = isCanvasType ? '🌐' : (runKind ? '▶' : '📄');
            const label = isCanvasType ? '网页 / 矢量图预览' : ((lang || '代码').toUpperCase());
            return `<div class="artifact-card" data-art="${artId}" onclick="openArtifact('${artId}')">`
              + `<span class="ic">${icon}</span>`
              + `<div class="info"><div class="t">${label}</div>`
              + `<div class="s">${lineCount} 行 · 点击在右侧画布打开</div></div>`
              + `</div>`;
          }

          let highlighted;
          try {
            highlighted = lang && hljs.getLanguage(lang)
              ? hljs.highlight(text, { language: lang }).value
              : hljs.highlightAuto(text).value;
          } catch(e) {
            highlighted = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }
          const label = lang || 'text';
          const runBtn = runKind ? `<button class="code-copy-btn" style="margin-left:auto;margin-right:6px" onclick="event.stopPropagation();openArtifact('${artId}','run')">▶ 运行</button>` : '';
          return `<div class="code-block-wrap"${artId ? ` data-art="${artId}"` : ''}><div class="code-block-header"><span class="code-lang">${label}</span>${runBtn}<button class="code-copy-btn" onclick="copyCodeBlock(this)">⎘ 复制</button></div><pre><code class="hljs${lang?' language-'+lang:''}">${highlighted}</code></pre></div>`;
        }
      }
    });
  } catch(e) { console.warn('marked renderer init failed:', e); }
}
function copyCodeBlock(btn) {
  const code = btn.closest('.code-block-wrap')?.querySelector('code');
  if (!code) return;
  copyTextCompat(code.innerText || code.textContent || '').then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ 已复制';
    btn.style.color = 'var(--accent)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1600);
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// ARTIFACT 画布面板 —— 网页/SVG 直接预览，长代码/长文章右侧展开
// ══════════════════════════════════════════════════════════
// ── ▶ 运行：html / css / js 在沙箱 iframe 里跑起来 ──
// iframe 是 sandbox="allow-scripts"、不给 allow-same-origin：跑的代码碰不到 GranCyan 的
// IDB/cookie，而且每次都是 srcdoc 重新装载 —— 「重进不存进度」是这样天然成立的，不是另外清的。
function artifactRunKind(lowerLang) {
  return ({ html:'html', htm:'html', svg:'html', xml:'html',
            css:'css', js:'js', javascript:'js', mjs:'js' })[lowerLang] || '';
}

// 同一条消息里常常是 html / css / js 分三块给的，只跑一块会是白板或没样式。
// 按 data-msg-id 把这条消息所有气泡里登记过的块捞出来（表情包拆气泡后一条消息有多个 .bubble）。
function collectRunParts(id) {
  const self = window.__artifacts[id];
  const selfKind = artifactRunKind((self.lang || '').toLowerCase());
  const parts = { html: [], css: [], js: [] };
  const el = document.querySelector(`[data-art="${id}"]`);
  const msgId = el && el.closest('.bubble[data-msg-id]')?.dataset.msgId;
  const nodes = msgId
    ? document.querySelectorAll(`.bubble[data-msg-id="${msgId}"] [data-art]`)
    : [];
  nodes.forEach(n => {
    const a = window.__artifacts[n.dataset.art];
    const k = a && artifactRunKind((a.lang || '').toLowerCase());
    if (k) parts[k].push({ id: n.dataset.art, code: a.code });
  });
  if (!parts[selfKind].some(p => p.id === id)) parts[selfKind].push({ id, code: self.code });
  // 点的是哪块 html 就跑哪块；点的是 css/js 就配这条消息里第一块 html
  const html = selfKind === 'html' ? self.code : (parts.html[0] ? parts.html[0].code : '');
  return { html, css: parts.css.map(p => p.code), js: parts.js.map(p => p.code) };
}

// 页内控制台：纯 js 没有页面，log 得有地方看；带页面时只冒错误，免得盖住页面。
// localStorage 在不同源沙箱里一碰就抛 SecurityError，换成内存版 —— 能跑，关了就没。
function _artifactShim(consoleOnly) {
  return `(function(){
var mk=function(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}});
var full=${consoleOnly ? 'true' : 'false'},box;
function out(t,c){if(!box){box=document.createElement('pre');box.id='__gc_console';box.style.cssText=full?'margin:0;padding:12px 14px;min-height:100vh;box-sizing:border-box;background:#0d0d14;color:#cfd3e6;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word':'position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;margin:0;padding:8px 10px;background:#0d0d14;color:#cfd3e6;font:12px/1.5 ui-monospace,Consolas,monospace;border-top:1px solid #2a2a3a;z-index:2147483647;white-space:pre-wrap';(document.body||document.documentElement).appendChild(box);}var d=document.createElement('div');if(c)d.style.color=c;d.textContent=t;box.appendChild(d);box.scrollTop=box.scrollHeight}
function fmt(a){return Array.prototype.map.call(a,function(x){if(typeof x==='string')return x;try{var s=JSON.stringify(x);return s===undefined?String(x):s}catch(e){return String(x)}}).join(' ')}
['log','info','warn','error'].forEach(function(k){var o=console[k];console[k]=function(){if(o)o.apply(console,arguments);if(full||k==='error')out(fmt(arguments),k==='error'?'#ff7a8a':k==='warn'?'#f5c26b':'')}});
window.addEventListener('error',function(e){out('\\u2716 '+(e.message||e),'#ff7a8a')});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;out('\\u2716 '+(r&&r.message||r),'#ff7a8a')});
})();`;
}

function buildRunDoc(id) {
  const { html, css, js } = collectRunParts(id);
  const noScriptEnd = s => s.replace(/<\/script/gi, '<\\/script');
  let doc = html || '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0d0d14"></body></html>';
  const head = `<script>${_artifactShim(!html)}<\/script>`
    + css.map(c => `<style>${c.replace(/<\/style/gi, '<\\/style')}</style>`).join('');
  const headOpen = doc.match(/<head[^>]*>/i);
  // 函数形式的替换：代码里的 $& $' 之类不能被当成替换模式吃掉
  if (headOpen) doc = doc.replace(headOpen[0], m => m + head);
  else doc = head + doc;
  const tail = js.map(c => `<script>${noScriptEnd(c)}<\/script>`).join('');
  const bodyEnd = doc.toLowerCase().lastIndexOf('</body>');
  doc = bodyEnd >= 0 ? doc.slice(0, bodyEnd) + tail + doc.slice(bodyEnd) : doc + tail;
  return doc;
}

function openArtifact(id, mode) {
  const a = window.__artifacts && window.__artifacts[id];
  if (!a) return;

  const panel    = document.getElementById('artifactPanel');
  const frame    = document.getElementById('artifactFrame');
  const codeView = document.getElementById('artifactCodeView');
  const codeEl   = document.getElementById('artifactCodeEl');
  const mdView   = document.getElementById('artifactMdView');
  const langTag  = document.getElementById('artifactLangTag');
  const title    = document.getElementById('artifactTitle');

  panel.classList.add('open');
  panel.style.display = 'flex';
  window.__currentArtifactId = id;

  const lowerLang   = (a.lang || '').toLowerCase();
  const isCanvasType = ['html','svg','xml'].includes(lowerLang);
  const isMarkdown   = lowerLang === 'markdown' || lowerLang === 'md';

  const runnable = !!artifactRunKind(lowerLang);
  const running  = runnable && (mode === 'run' || (isCanvasType && mode !== 'code'));

  langTag.textContent = (a.lang || 'TEXT').toUpperCase();
  frame.style.display    = 'none';
  codeView.style.display = 'none';
  mdView.style.display   = 'none';
  const runBtn = document.getElementById('artifactRunBtn');
  if (runBtn) {
    runBtn.hidden = !runnable;
    runBtn.firstElementChild.textContent = running ? '</> 代码' : '▶ 运行';
    runBtn.onclick = () => openArtifact(id, running ? 'code' : 'run');
  }
  // 切到代码视图也要把上一次跑的页面卸掉，不然它的定时器/音频还在后台跑
  if (!running) frame.srcdoc = '';

  if (running) {
    title.textContent = isCanvasType ? '网页预览' : '运行预览';
    frame.srcdoc = buildRunDoc(id);
    frame.style.display = 'block';
  } else if (isMarkdown) {
    title.textContent = '文章预览';
    mdView.innerHTML = gcSanitize(marked.parse(a.code || ''), { strict: true });   // 模型写的文章，同样可能夹带裸 HTML
    mdView.style.display = 'block';
  } else {
    title.textContent = '代码';
    let highlighted;
    try {
      highlighted = a.lang && hljs.getLanguage(a.lang)
        ? hljs.highlight(a.code, { language: a.lang }).value
        : hljs.highlightAuto(a.code).value;
    } catch(e) {
      highlighted = (a.code || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    codeEl.innerHTML  = highlighted;
    codeEl.className  = 'hljs' + (a.lang ? ' language-' + a.lang : '');
    codeView.style.display = 'block';
  }
}

function closeArtifactPanel() {
  document.getElementById('artifactPanel').classList.remove('open');
  // 只摘 .open 的话 iframe 里的页面还活着：动画、定时器、声音在看不见的地方接着跑
  const frame = document.getElementById('artifactFrame');
  if (frame) { frame.srcdoc = ''; frame.style.display = 'none'; }
}

// 窗口 resize 期间暂停全局过渡动画：跨越 768px 断点时 artifactPanel 等
// 隐藏面板的 transform/width 变化会被 transition 播成"滑出"动画，看起来像面板自己弹出来
let _resizeAnimStopTimer = null;
window.addEventListener('resize', () => {
  document.body.classList.add('resize-anim-stopper');
  clearTimeout(_resizeAnimStopTimer);
  _resizeAnimStopTimer = setTimeout(() => document.body.classList.remove('resize-anim-stopper'), 150);
});

function copyArtifactContent() {
  const id = window.__currentArtifactId;
  const a = window.__artifacts && window.__artifacts[id];
  if (!a) return;
  copyTextCompat(a.code || '').then(() => {
    const btn = document.querySelector('.artifact-header .artifact-btn-copy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = orig; }, 1600);
    }
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// MOBILE ENTER KEY — newline on mobile, send on desktop
// ══════════════════════════════════════════════════════════
function handleInputKeydown(e) {
  if (e.key === 'Escape' && document.querySelector('.input-bar-wrap.input-expanded')) {
    e.preventDefault(); toggleInputExpand(false); return;
  }
  if (e.key !== 'Enter') return;
  // 判据搬进 01-core.js 的 isMobileComposer() 了，工作台的输入框要用同一份（行为没变）。
  const isMobile = isMobileComposer();
  if (!e.shiftKey && !isMobile) {
    e.preventDefault();
    handleSend();
  }
  // mobile or Shift+Enter: let default newline through
}

// ══════════════════════════════════════════════════════════
// MESSAGE NAVIGATION — top / prev / next
// ══════════════════════════════════════════════════════════
// _navIntended tracks where we *intend* to scroll so rapid clicks work correctly
let _navIntended = null;
let _navProgrammatic = false;
let _navProgTimer = null;

function _navScrollTo(top) {
  const chatWin = document.getElementById('chatWindow');
  _navIntended = top;
  _navProgrammatic = true;
  clearTimeout(_navProgTimer);
  chatWin.scrollTo({ top, behavior: 'smooth' });
  // Give the smooth-scroll animation time to finish before allowing
  // manual-scroll detection to reset _navIntended again.
  _navProgTimer = setTimeout(() => { _navProgrammatic = false; }, 450);
}

// 消息导航要量的是「每条消息在滚动容器里的位置」。以前拿的是 .msg-group，
// 但它在 [data-msg-wrapper] 里面，而 wrapper 开了 content-visibility:auto ——
// 屏幕外的子树跳过渲染，里面元素的 offsetTop 不保证是最新值（各内核行为还不一致）。
// wrapper 自己永远参与布局，改量它，几何值才靠得住。没有 wrapper 的老结构自动回退。
function _msgAnchors(chatWin) {
  const wrapped = Array.from(chatWin.querySelectorAll(':scope > [data-msg-wrapper]'));
  return wrapped.length ? wrapped : Array.from(chatWin.querySelectorAll('.msg-group'));
}

function navPrevMsg() {
  const chatWin = document.getElementById('chatWindow');
  const groups = _msgAnchors(chatWin);
  if (!groups.length) return;
  // Use intended position so rapid clicks keep going up
  const ref = (_navIntended !== null) ? Math.min(_navIntended, chatWin.scrollTop) : chatWin.scrollTop;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].offsetTop < ref - 8) {
      _navScrollTo(groups[i].offsetTop - 16);
      return;
    }
  }
  _navScrollTo(0);
}

function navNextMsg() {
  const chatWin = document.getElementById('chatWindow');
  const groups = _msgAnchors(chatWin);
  if (!groups.length) return;
  // Use intended position so rapid clicks keep going down
  const ref = (_navIntended !== null) ? Math.max(_navIntended, chatWin.scrollTop) : chatWin.scrollTop;
  for (const group of groups) {
    // 滚动目标是 offsetTop - 16，所以要用 offsetTop - 16 > ref + 8 来排除当前这条，
    // 否则每次点击都会重新选中当前消息、原地不动
    if (group.offsetTop - 16 > ref + 8) {
      _navScrollTo(group.offsetTop - 16);
      return;
    }
    }
  // 找不到下一条了，就直接平滑滚到最底部
  _navScrollTo(chatWin.scrollHeight); 
}

// Reset intended when user manually scrolls significantly (not during our own animation)
document.getElementById('chatWindow').addEventListener('scroll', () => {
  if (_navProgrammatic) return;
  if (_navIntended !== null && Math.abs(document.getElementById('chatWindow').scrollTop - _navIntended) > 120) {
    _navIntended = null;
  }
}, { passive: true });

function scrollToTopMsg() {
  _navScrollTo(0);
}

// ══════════════════════════════════════════════════════════
// RIGHT SCRUBBER — draggable position indicator
// ══════════════════════════════════════════════════════════
function initScrubber() {
  const chatWin = document.getElementById('chatWindow');
  const thumb = document.getElementById('scrubberThumb');
  const track = document.getElementById('scrubberTrack');
  const wrap  = document.getElementById('chatScrubberWrap');
  if (!chatWin || !thumb || !track) return;

  function updateThumb() {
    const { scrollTop, scrollHeight, clientHeight } = chatWin;
    if (scrollHeight <= clientHeight + 4) { thumb.style.opacity = '0'; return; }
    thumb.style.opacity = '1';
    const trackH = track.clientHeight || 1;
    const ratio   = scrollTop / (scrollHeight - clientHeight);
    const thumbH  = Math.max(28, (clientHeight / scrollHeight) * trackH);
    const thumbTop = ratio * (trackH - thumbH);
    thumb.style.height = thumbH + 'px';
    thumb.style.top    = thumbTop + 'px';
  }

  chatWin.addEventListener('scroll', () => { updateThumb(); wrap.classList.add('active'); clearTimeout(wrap._hideTimer); wrap._hideTimer = setTimeout(() => wrap.classList.remove('active'), 1200); }, { passive: true });
  window.addEventListener('resize', updateThumb);

  // Drag
  let dragging = false, startY = 0, startScroll = 0;
  thumb.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startScroll = chatWin.scrollTop;
    thumb.classList.add('dragging'); wrap.classList.add('active');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const { scrollHeight, clientHeight } = chatWin;
    const trackH  = track.clientHeight || 1;
    const thumbH  = parseFloat(thumb.style.height) || 28;
    const ratio   = (e.clientY - startY) / (trackH - thumbH);
    chatWin.scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, startScroll + ratio * (scrollHeight - clientHeight)));
  });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; thumb.classList.remove('dragging'); } });

  // Click on track
  track.addEventListener('click', e => {
    if (e.target === thumb) return;
    const rect  = track.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const { scrollHeight, clientHeight } = chatWin;
    chatWin.scrollTo({ top: ratio * (scrollHeight - clientHeight), behavior: 'smooth' });
  });

  // Touch support
  thumb.addEventListener('touchstart', e => {
    dragging = true; startY = e.touches[0].clientY; startScroll = chatWin.scrollTop;
    thumb.classList.add('dragging'); wrap.classList.add('active');
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const { scrollHeight, clientHeight } = chatWin;
    const trackH = track.clientHeight || 1;
    const thumbH = parseFloat(thumb.style.height) || 28;
    const ratio  = (e.touches[0].clientY - startY) / (trackH - thumbH);
    chatWin.scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, startScroll + ratio * (scrollHeight - clientHeight)));
  }, { passive: true });
  document.addEventListener('touchend', () => { if (dragging) { dragging = false; thumb.classList.remove('dragging'); } });

  updateThumb();
}

// ══════════════════════════════════════════════════════════
// HELP MODAL（wiki 版：左侧目录 + 顶部搜索）
// ══════════════════════════════════════════════════════════
// 目录不写死在 HTML 里，是开的时候按 <h3> 现扫的 —— 以后加一节功能，
// 只要往 #helpSection 里塞个 h3，目录、跳转、搜索过滤全都自动跟上。
function toggleHelp() {
  const m = document.getElementById('helpModal');
  m.classList.toggle('hidden');
  if (!m.classList.contains('hidden')) buildHelpToc();
}

/* 指南有 160+ 行条目、18 节。第一次打开要把这一坨从零排一次版，
   冷开那一下明显比之后几次慢（原话：「很久才会出现」）。
   趁页面空下来先把这笔账付掉 —— 加 .warm 让它保持**已排好版但完全不可见**，
   见 css 里 #helpModal.hidden.warm 那段。

   ⚠️ 不能改成「显示一下再 display:none 藏回去」：display:none 会把布局树整个丢掉，
      下次打开还得重排一遍，等于白忙。必须一直保持可布局。
   ⚠️ 也不能在 boot 里直接同步调 —— 那就把这笔账挪到了启动路径上，
      变成「开 App 慢」，只是换个地方卡人。所以走 idle。 */
let _helpWarmed = false;
function warmHelpModal() {
  if (_helpWarmed) return;
  const m = document.getElementById('helpModal');
  if (!m || !m.classList.contains('hidden')) return;   // 人已经打开了就不用预热了
  _helpWarmed = true;
  m.classList.add('warm');
  void m.offsetHeight;        // 强制同步排一次版，别等到下一帧
  buildHelpToc();             // 目录也顺手建了，反正现在有布局可读
}

/* requestIdleCallback 在老 WebView 上可能没有，退回定时器。
   延迟给足 —— boot 要拉对话、渲消息、连云端，别去跟它抢。 */
(function scheduleHelpWarm() {
  const go = () => { try { warmHelpModal(); } catch (_) {} };
  if (typeof requestIdleCallback === 'function') {
    setTimeout(() => requestIdleCallback(go, { timeout: 4000 }), 2500);
  } else {
    setTimeout(go, 4000);
  }
})();

let _helpTocBuilt = false;
function buildHelpToc() {
  const toc = document.getElementById('helpToc');
  const sec = document.getElementById('helpSection');
  if (!toc || !sec || _helpTocBuilt) return;

  const heads = [...sec.querySelectorAll('h3')];
  toc.innerHTML = '';
  heads.forEach((h, i) => {
    h.id = 'helpSec' + i;
    const item = document.createElement('div');
    item.className = 'help-toc-item';
    item.textContent = h.textContent;
    item.dataset.sec = h.id;
    item.tabIndex = 0; item.setAttribute('role', 'button');   // 键盘 Tab 得到（A34），Enter/空格在 14 号那边转成 click
    item.onclick = () => {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setHelpTocActive(h.id);
    };
    toc.appendChild(item);
  });
  if (heads[0]) setHelpTocActive(heads[0].id);

  // 末尾垫一块空白：最后一节内容不够长的话滚到底也顶不到顶部，
  // 目录里那一项就永远轮不到高亮，点它也像没反应。
  if (!sec.querySelector('.help-tail')) {
    const tail = document.createElement('div');
    tail.className = 'help-tail';
    sec.appendChild(tail);
  }

  // 滚动高亮当前章节。scroll 事件很密，用 rAF 压成每帧最多算一次。
  let ticking = false;
  sec.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const top = sec.getBoundingClientRect().top;
      let cur = heads[0];
      for (const h of heads) {
        if (h.offsetParent === null) continue;           // 搜索时被隐藏的章节不算
        if (h.getBoundingClientRect().top - top <= 60) cur = h; else break;
      }
      if (cur) setHelpTocActive(cur.id);
    });
  });

  _helpTocBuilt = true;
}

function setHelpTocActive(id) {
  document.querySelectorAll('#helpToc .help-toc-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sec === id);
  });
}

// ── 指南内搜索 ─────────────────────────────────────────────
// 只过滤条目，不动 DOM 结构：命中的词用 <span class="help-hit"> 包一层，
// 清空搜索时再拆回去 + normalize()，来回几次也不会把文本节点切碎。
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function clearHelpHits(root) {
  root.querySelectorAll('.help-hit').forEach(s => s.replaceWith(document.createTextNode(s.textContent)));
  root.normalize();
}

function markHelpHits(root, q) {
  const needle = q.toLowerCase();
  const re = new RegExp('(' + escRe(q) + ')', 'ig');
  const nodes = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeValue && n.nodeValue.toLowerCase().includes(needle))
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  let n; while ((n = w.nextNode())) nodes.push(n);   // 先收集再改，边走边改会让 walker 迷路
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(re)) {
      if (!part) continue;
      if (part.toLowerCase() === needle) {
        const s = document.createElement('span');
        s.className = 'help-hit';
        s.textContent = part;
        frag.appendChild(s);
      } else frag.appendChild(document.createTextNode(part));
    }
    node.replaceWith(frag);
  }
}

function filterHelp(q, alsoClearInput) {
  const sec = document.getElementById('helpSection');
  const box = document.getElementById('helpSearch');
  if (!sec) return;
  if (alsoClearInput && box) box.value = '';

  q = (q || '').trim();
  clearHelpHits(sec);

  const heads = [...sec.querySelectorAll('h3')];
  const rows = [...sec.querySelectorAll('.help-row')];
  let empty = sec.querySelector('.help-empty');

  if (!q) {
    rows.forEach(r => r.style.display = '');
    heads.forEach(h => h.style.display = '');
    document.querySelectorAll('#helpToc .help-toc-item').forEach(el => el.classList.remove('dim'));
    if (empty) empty.remove();
    return;
  }

  const needle = q.toLowerCase();
  let total = 0;
  rows.forEach(r => {
    const hit = r.textContent.toLowerCase().includes(needle);
    r.style.display = hit ? '' : 'none';
    if (hit) total++;
  });

  // 一节里一条都没命中就把标题也收起来，顺便把目录里那一项调暗
  heads.forEach(h => {
    let any = false;
    for (let el = h.nextElementSibling; el && el.tagName !== 'H3'; el = el.nextElementSibling) {
      if (el.classList.contains('help-row') && el.style.display !== 'none') { any = true; break; }
    }
    h.style.display = any ? '' : 'none';
    const item = document.querySelector(`#helpToc .help-toc-item[data-sec="${h.id}"]`);
    if (item) item.classList.toggle('dim', !any);
  });

  markHelpHits(sec, q);

  if (!total) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'help-empty';
      sec.appendChild(empty);
    }
    empty.textContent = `没有找到「${q}」相关的功能 (´･_･\`)　换个词试试？`;
    empty.style.display = '';
  } else if (empty) empty.remove();

  sec.scrollTop = 0;
}

// ══════════════════════════════════════════════════════════
// 特别鸣谢（内容在 #creditsModal 的 .credits-body 里手写；原来是空着的更新日志）
// ══════════════════════════════════════════════════════════
function toggleCredits() {
  document.getElementById('creditsModal').classList.toggle('hidden');
}



// Esc closes help modal too
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const h = document.getElementById('helpModal'); if (!h.classList.contains('hidden')) h.classList.add('hidden'); } });

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
