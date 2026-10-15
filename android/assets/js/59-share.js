// ============================================================
// 分享对话：整个对话或选几句话，生成一个只读链接
// ============================================================
// 链路：选好的消息 → 压成纯文本快照 → 写进 Supabase 的 shares 表 → 链接指向一个静态查看页
//   <GRANCYAN_CONFIG.sharePageUrl>#<id>（在 js/00-config.js 里配；留空 = 分享功能提示未配置）
// 查看页（单独部署的静态页，比如 GitHub Pages）只拿着 id 调 get_share(id) 这个 RPC 取那一条。
//
// 为什么查看页不直接 select 表：表对匿名访客**没有**读权限，只开了 get_share 一个口子——
// 不然任何人拿着页面里的 anon key 就能 select * 把所有人分享过的对话全列出来。
// 撤回 = 删行（RLS 只许删自己的），删了链接立刻打不开；不自动过期。
//
// 快照里**只有**：标题、双方名字、每条的文字和时间、主题色。不带头像（base64 动辄几百 KB）、
// 不带思考链、不带图片（写成「[图片]」），也不带任何设置/记忆/提示词。
// AI 回复里的 [[指令]] 是给 App 自己执行的，界面上本来就不显示，快照里一并剥掉。

const SHARE_PAGE = String((typeof GRANCYAN_CONFIG === 'object' && GRANCYAN_CONFIG && GRANCYAN_CONFIG.sharePageUrl) || '').trim();
const SHARE_OFF_MSG = '分享功能未配置：在 js/00-config.js 里填 sharePageUrl（以及 Supabase）';
const SHARE_MAX_MSGS = 300;
const SHARE_MAX_CHARS = 200000;

function _shareId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => abc[x % abc.length]).join('');
}

// 一条消息 → 快照里的一行。用户：r='u'；AI：r='a'，名字取那条（或选中的那个版本）的昵称
function _shareMsg(n) {
  const v = n.variants ? (n.variants[n.chosenVariant ?? 0] || {}) : n;
  let t = getMsgPlainText(n) || '';
  t = t.replace(/\[\[[^\]\n]{0,2000}\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const imgs = (v.images || n.images || []).length;
  if (imgs) t = (t ? t + '\n' : '') + '[图片]'.repeat(Math.min(imgs, 9));
  if (n.role === 'user') return { r: 'u', n: state.userName || '我', t, ts: n.timestamp || 0 };
  return { r: 'a', n: v.modelNickname || n.modelNickname || 'AI', t, ts: n.timestamp || v.timestamp || 0 };
}

function _sharePayload(chat, nodes) {
  const msgs = nodes.filter(n => n && (n.role === 'user' || n.role === 'assistant' || n.role === 'ai'))
    .map(_shareMsg).filter(m => m.t);
  let accent = '';
  try { accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim(); } catch (e) {}
  return { v: 1, title: (chat && chat.title) || '一段对话', user: state.userName || '我', accent, msgs };
}

async function _shareCreate(nodes, label) {
  if (!SHARE_PAGE) { showToast(SHARE_OFF_MSG, 'info', 4000); return; }
  if (typeof currentUser === 'undefined' || !currentUser) { showToast('分享要先登录（云端账号）', 'error', 3000); return; }
  const chat = getActiveChat();
  const p = _sharePayload(chat, nodes);
  if (!p.msgs.length) { showToast('选中的消息里没有文字可以分享', 'info', 2500); return; }
  if (p.msgs.length > SHARE_MAX_MSGS) { showToast(`一次最多分享 ${SHARE_MAX_MSGS} 条，选少一点～`, 'error', 3000); return; }
  if (JSON.stringify(p).length > SHARE_MAX_CHARS) { showToast('太长了，分开几段分享吧', 'error', 3000); return; }
  const id = _shareId();
  showToast('正在生成链接…', 'info', 1500);
  const { error } = await supabaseClient.from('shares').insert({ id, user_id: currentUser.id, title: p.title, n: p.msgs.length, payload: p });
  if (error) { console.warn('[分享] 写入失败', error); showToast('生成失败：' + (error.message || error.code || '网络问题'), 'error', 4000); return; }
  const url = SHARE_PAGE + '#' + id;
  _shareShowLink(url, label || `${p.msgs.length} 条消息`);
  copyTextCompat(url).then(() => showToast('链接已复制', 'success', 1800)).catch(() => {});
}

// 整个对话（当前分支上看得见的那一串）
function shareWholeChat() {
  const chat = getActiveChat();
  if (!chat || !chat.headId) { showToast('这个对话还是空的', 'info'); return; }
  _shareClose();
  _shareCreate(getMessagePath(chat, chat.headId), '整个对话');
}

// 批量托盘上的「分享」：按对话里的先后顺序，不按勾选顺序
function shareSelectedMessages() {
  const chat = getActiveChat();
  if (!chat || !state.selectedMessageIds.size) { showToast('先勾几条消息', 'info'); return; }
  const nodes = getMessagePath(chat, chat.headId).filter(n => state.selectedMessageIds.has(n.id));
  exitSelectMode();
  _shareCreate(nodes);
}

function shareStartPick() {
  _shareClose();
  enterSelectMode();
  showToast('勾选要分享的消息，然后点底下的「分享」', 'info', 3000);
}

// ── 面板：分享整个 / 选几条 / 我分享过的 ──
function _shareClose() { const el = document.getElementById('shareModal'); if (el) el.remove(); }
function _shareSheet(inner) {
  _shareClose();
  const el = document.createElement('div');
  el.id = 'shareModal';
  el.className = 'share-modal';
  el.innerHTML = `<div class="share-card" role="dialog" aria-label="分享对话">${inner}</div>`;
  el.addEventListener('click', e => { if (e.target === el) _shareClose(); });
  document.body.appendChild(el);
  return el;
}

function openShareModal() {
  if (!SHARE_PAGE) { showToast(SHARE_OFF_MSG, 'info', 4000); return; }
  const chat = getActiveChat();
  const n = chat && chat.headId ? getMessagePath(chat, chat.headId).length : 0;
  const el = _shareSheet(`
    <div class="share-hd"><b>🔗 分享对话</b><button type="button" class="share-x" onclick="_shareClose()" title="关闭">✕</button></div>
    <button type="button" class="share-opt" onclick="shareWholeChat()" ${n ? '' : 'disabled'}><b>分享整个对话</b><i>当前看得到的 ${n} 条</i></button>
    <button type="button" class="share-opt" onclick="shareStartPick()" ${n ? '' : 'disabled'}><b>选几条分享</b><i>勾好以后点底下托盘里的「分享」</i></button>
    <div class="share-note">链接谁拿到都能看（只读），不带头像、思考链和图片。随时可以在下面撤回。</div>
    <div class="share-sub">我分享过的</div>
    <div class="share-list" id="shareList"><div class="share-empty">加载中…</div></div>`);
  _shareLoadMine(el.querySelector('#shareList'));
}

async function _shareLoadMine(box) {
  if (!box) return;
  if (typeof currentUser === 'undefined' || !currentUser) { box.innerHTML = '<div class="share-empty">登录后才能分享</div>'; return; }
  const { data, error } = await supabaseClient.from('shares').select('id,title,n,created_at').order('created_at', { ascending: false }).limit(50);
  if (error) { box.innerHTML = `<div class="share-empty">读不到：${escHtml(error.message || '网络问题')}</div>`; return; }
  if (!data || !data.length) { box.innerHTML = '<div class="share-empty">还没分享过</div>'; return; }
  box.innerHTML = data.map(s => {
    const d = new Date(s.created_at);
    const when = isNaN(d) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const url = SHARE_PAGE + '#' + s.id;
    return `<div class="share-row" data-id="${escHtml(s.id)}">
      <div class="share-row-t"><b>${escHtml(s.title || '一段对话')}</b><i>${s.n || 0} 条 · ${when}</i></div>
      <button type="button" onclick="copyTextCompat('${url}').then(()=>showToast('链接已复制','success',1500))" title="复制链接">复制</button>
      <button type="button" onclick="window.open('${url}','_blank','noopener')" title="打开看看">看</button>
      <button type="button" class="danger" onclick="shareRevoke('${escHtml(s.id)}')" title="撤回：链接立刻打不开">撤回</button>
    </div>`;
  }).join('');
}

async function shareRevoke(id) {
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) return;
  if (!confirm('撤回这条分享？链接会立刻打不开。')) return;
  const { error } = await supabaseClient.from('shares').delete().eq('id', id);
  if (error) { showToast('撤回失败：' + (error.message || '网络问题'), 'error', 3500); return; }
  showToast('已撤回', 'success', 1500);
  const row = document.querySelector(`#shareList .share-row[data-id="${id}"]`);
  if (row) row.remove();
  const box = document.getElementById('shareList');
  if (box && !box.children.length) box.innerHTML = '<div class="share-empty">还没分享过</div>';
}

// 生成好了：把链接摆出来（剪贴板在有的 WebView 里会静默失败，所以链接要看得见、能手动复制）
function _shareShowLink(url, what) {
  _shareSheet(`
    <div class="share-hd"><b>✓ 分享链接（${escHtml(what)}）</b><button type="button" class="share-x" onclick="_shareClose()" title="关闭">✕</button></div>
    <input class="share-url" readonly value="${escHtml(url)}" onclick="this.select()">
    <div class="share-acts">
      <button type="button" class="on" onclick="copyTextCompat('${url}').then(()=>showToast('链接已复制','success',1500))">复制链接</button>
      <button type="button" onclick="window.open('${url}','_blank','noopener')">打开看看</button>
      <button type="button" onclick="openShareModal()">我分享过的</button>
    </div>`);
}
