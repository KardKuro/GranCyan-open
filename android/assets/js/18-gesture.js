// ═══════════════════════════════════════════════════════
// 气泡手势：左滑引用 / 双击全屏（手机专用，思路借鉴 cocoon）
//
// 只认 pointerType === 'touch'：桌面端左键拖拽是划选文字、双击是选词，
// 都不能抢。桌面要引用走右键菜单，路已经有了。
//
// 事件挂在 #chatWindow 上做委托——renderMessages() 每次都重刷 innerHTML，
// 挂在气泡上的监听会跟着一起蒸发。
// ═══════════════════════════════════════════════════════

const SWIPE_TRIGGER = 48;   // 滑过这个距离触发引用
const SWIPE_MAX     = 72;   // 最多跟手到这里
const DBL_TAP_MS    = 320;  // 两下之间超过这个间隔就算两次单击

const _g = { id: null, row: null, x: 0, y: 0, t: 0, tracking: false, swiping: false, fired: false, icon: null };
let _lastTapId = null, _lastTapT = 0;

// 代码块要横向滚、图片要点开、按钮要点——这些地方不接管手势
function _gestureInert(el) {
  return !!el.closest('button, input, textarea, a, img, pre, code, table, .code-block-wrap, .artifact-card, .msg-action-btn, .branch-switcher, .bubble-quote, .voice-bubble, .msg-img');
}

// 整条消息的纯文本（多模型对比取当前选用的那个），跟右键菜单的取值口径一致
function nodeTextById(id) {
  const chat = getActiveChat();
  const node = chat?.nodes?.[id];
  if (!node) return '';
  return node.variants
    ? (node.variants[node.chosenVariant ?? 0]?.content || '')
    : (node.content || '');
}

function _swipeReset(fast) {
  const row = _g.row;
  if (row) {
    row.style.transition = fast ? 'transform .2s ease' : 'transform .25s cubic-bezier(.2,.9,.3,1)';
    row.style.transform = '';
    setTimeout(() => { if (row) row.style.transition = ''; }, 280);
  }
  if (_g.icon) {
    const icon = _g.icon;
    icon.style.opacity = '0';
    setTimeout(() => icon.remove(), 200);
    _g.icon = null;
  }
  _g.tracking = false; _g.swiping = false; _g.row = null; _g.id = null;
}

// 左滑到位：整条进引用栏。同一条已经在引用栏里就不重复塞
function _swipeQuote(id) {
  const text = nodeTextById(id);
  if (!text) return;
  if (_pendingQuotes.some(q => typeof q === 'object' && q.sourceNodeId === id)) {
    showToast('这条已经在引用里了', 'info');
    return;
  }
  _pendingQuotes.push({ text: text.slice(0, 200), sourceNodeId: id });
  renderQuoteBar();
  if (navigator.vibrate) navigator.vibrate(15);
}

function initBubbleGestures() {
  const win = document.getElementById('chatWindow');
  if (!win || win.dataset.gestureBound) return;
  win.dataset.gestureBound = '1';

  win.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const row = e.target.closest('.msg-group[data-node-id]');
    if (!row || _gestureInert(e.target)) return;
    _g.id = +row.dataset.nodeId;
    _g.row = row;
    _g.x = e.clientX; _g.y = e.clientY; _g.t = Date.now();
    _g.tracking = true; _g.swiping = false; _g.fired = false;
  });

  win.addEventListener('pointermove', e => {
    if (!_g.tracking || e.pointerType !== 'touch') return;
    const dx = e.clientX - _g.x, dy = e.clientY - _g.y;

    // 正在划选文字（长按取词后拖把手）——手势全让开，选区优先
    if (!window.getSelection()?.isCollapsed) { _swipeReset(true); return; }

    // 横向位移得明显压过纵向，否则这是在滚列表
    if (!_g.swiping && dx < -6 && Math.abs(dx) > Math.abs(dy) + 4) {
      _g.swiping = true;
      clearTimeout(longPressTimer);          // 滑动不该再冒出长按菜单
      try { win.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (!_g.swiping) return;
    if (_g.fired) return;

    const move = Math.max(Math.min(dx, 0), -SWIPE_MAX);
    _g.row.style.transform = `translateX(${move}px)`;

    if (!_g.icon) {
      const icon = document.createElement('div');
      icon.className = 'swipe-reply-icon';
      icon.textContent = '↩';
      _g.row.appendChild(icon);
      _g.icon = icon;
    }
    const p = Math.min(Math.abs(move) / SWIPE_TRIGGER, 1);
    _g.icon.style.opacity = String(p);
    _g.icon.style.transform = `translateY(-50%) scale(${0.6 + p * 0.4})`;
    if (p === 1) _g.icon.classList.add('ready');

    if (move <= -SWIPE_TRIGGER) {
      _g.fired = true;
      _swipeQuote(_g.id);
    }
  });

  win.addEventListener('pointerup', e => {
    if (!_g.tracking || e.pointerType !== 'touch') return;
    const id = _g.id;
    const moved = Math.abs(e.clientX - _g.x) + Math.abs(e.clientY - _g.y);
    const quick = Date.now() - _g.t < 400;
    const wasSwipe = _g.swiping;
    _swipeReset(false);
    if (wasSwipe || moved > 10 || !quick) return;

    // 双击 → 全屏页。300ms 内的第二下才算，不然两次单击会被误判
    const now = Date.now();
    if (id === _lastTapId && now - _lastTapT < DBL_TAP_MS) {
      _lastTapId = null; _lastTapT = 0;
      clearTimeout(longPressTimer);
      openMsgTextView(id);
      return;
    }
    _lastTapId = id; _lastTapT = now;
  });

  win.addEventListener('pointercancel', () => { if (_g.tracking) _swipeReset(true); });
}

// ═══════════════════════════════════════════════════════
// 全屏文本页
//
// 气泡里长按撞菜单、左滑撞引用、双指还要滚列表——选一段字根本没活路。
// 铺到全屏，手势全部让开，只剩选字。
// 默认渲染视图（代码高亮/公式/图都在），一键切 markdown 原文整段捞走。
// ═══════════════════════════════════════════════════════
let _tvNodeId = null, _tvRaw = false;

function openMsgTextView(id) {
  const text = nodeTextById(id);
  if (!text) return;
  _tvNodeId = id;
  _tvRaw = false;

  let ov = document.getElementById('msgTextView');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'msgTextView';
    ov.innerHTML = `
      <div class="tv-bar">
        <button class="tv-btn" id="tvRawBtn" onclick="toggleMsgTextRaw()">原文</button>
        <button class="tv-btn" onclick="copyMsgTextView()">⎘ 复制</button>
        <button class="tv-btn tv-close" onclick="closeMsgTextView()">✕</button>
      </div>
      <div class="tv-body" id="tvBody"></div>`;
    document.body.appendChild(ov);
    // 长代码会渲染成 artifact 卡片，点开是右侧画布——先把全屏页收了，不然挡着
    ov.addEventListener('click', e => {
      if (e.target.closest('.artifact-card')) closeMsgTextView();
    }, true);
  }
  ov.classList.add('open');
  document.addEventListener('keydown', _tvEsc);
  _tvPaint();
}

function _tvPaint() {
  const body = document.getElementById('tvBody');
  const btn  = document.getElementById('tvRawBtn');
  const text = nodeTextById(_tvNodeId);
  if (!body) return;
  btn.textContent = _tvRaw ? '渲染' : '原文';
  btn.classList.toggle('on', _tvRaw);
  if (_tvRaw) {
    body.className = 'tv-body tv-raw';
    body.textContent = text;
  } else {
    body.className = 'tv-body bubble ai tv-rich';
    // 用户气泡平时走 renderUserText（先转义）；这里一律 renderRichText 会让她手打的
    // <img onerror> 之类在全屏里变成真 HTML —— 和气泡里看到的不是一个东西。
    const node = getActiveChat()?.nodes?.[_tvNodeId];
    body.innerHTML = node?.role === 'user' ? renderUserText(text) : renderRichText(text);
    typesetMath(body);
  }
  body.scrollTop = 0;
}

function toggleMsgTextRaw() { _tvRaw = !_tvRaw; _tvPaint(); }

function copyMsgTextView() {
  copyTextCompat(nodeTextById(_tvNodeId)).then(() => showToast('已复制整条', 'success')).catch(() => {});
}

function closeMsgTextView() {
  document.getElementById('msgTextView')?.classList.remove('open');
  document.removeEventListener('keydown', _tvEsc);
  _tvNodeId = null;
}

function _tvEsc(e) { if (e.key === 'Escape') closeMsgTextView(); }

document.addEventListener('DOMContentLoaded', initBubbleGestures);
