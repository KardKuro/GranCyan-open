/* ══════════════════════════════════════════════════════════════════════════
   网页坞 · 把已经部署在网上的页面直接摆进 App 里

   为什么要有它：网页版随时改随时刷新，App 却每加一个功能就得重打一次 apk——
   而大部分小功能一个月也用不了两次，不值得为它走一遍打包。
   所以这里放的不是新功能，是**一个装网页的架子**：页面部署在网上，App 只存一份清单。
   清单本身也在网上（webDockSrc 指向一个 JSON），改清单 = 改 App 里的列表，不用重打包。

   清单格式（数组，或 {items:[...]} 包一层都认）：
     [{ "name": "记账", "desc": "随手记两笔", "url": "https://…/a.html", "icon": "💰" }]

   和「伴读书架」的区别：书架是整页跳走（webView.loadUrl），跳走了就只能靠右滑手势回来。
   这里是 iframe，外面永远留着底部那条 tab bar，聊天和网页之间一步来回。
   iframe 还有个白捡的好处：页面能通过 postMessage 借用 App 的权限（震动、Toast），
   这些在普通浏览器里要么没有要么被拦。
   ════════════════════════════════════════════════════════════════════════ */

const WEBDOCK_SYNC_TTL = 5 * 60 * 1000;   // 5 分钟内进过一次就不再重复拉清单

let _wdView = 'list';     // 'list' | 'page'
let _wdCurrent = null;    // 当前打开的条目 {name,url,…}
let _wdSyncing = false;

// ── 条目的读写 ────────────────────────────────────────────────────
// 远端清单（webDockRemote）和手动加的（webDockItems）合起来展示，按 url 去重，本地优先——
// 本地那份是用户自己加的，被远端同名条目盖掉会很莫名其妙。
// 只放行 http(s)。javascript:/data: 之类的 origin 是 "null"，过不了下面的同源判断，
// 会被当成外站多给一个 allow-same-origin —— javascript: 就在 App 自己的源里跑了。
// 远端清单是别人能改的 JSON，缓存里也可能还躺着旧的坏条目，所以在读出口统一卡。
function _wdSafeUrl(url) { return /^https?:\/\//i.test(String(url || '').trim()); }

function webDockList() {
  const out = [];
  const seen = new Set();
  const push = (it, local) => {
    const url = String(it?.url || '').trim();
    if (!url || seen.has(url) || !_wdSafeUrl(url)) return;
    seen.add(url);
    out.push({
      url, local,
      name: String(it.name || url.replace(/^https?:\/\//, '').slice(0, 30)).slice(0, 40),
      desc: String(it.desc || '').slice(0, 80),
      icon: String(it.icon || '🔗').slice(0, 4),
    });
  };
  (state.webDockItems || []).forEach(it => push(it, true));
  (state.webDockRemote || []).forEach(it => push(it, false));
  return out;
}

function webDockAdd(url, name, desc, icon) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) { showToast('网址要以 http:// 或 https:// 开头', 'error'); return false; }
  state.webDockItems = state.webDockItems || [];
  if (state.webDockItems.some(x => x.url === url)) { showToast('这个已经在列表里了', 'info'); return false; }
  state.webDockItems.unshift({ url, name: (name || '').trim(), desc: (desc || '').trim(), icon: (icon || '').trim() });
  save();
  return true;
}

function webDockRemove(url) {
  state.webDockItems = (state.webDockItems || []).filter(x => x.url !== url);
  save();
  renderWebDock();
}

/* 拉清单。失败不清空缓存——手机上多半只是没连上电脑/没网，
   把上次拉到的列表一起抹掉，会让"离线就整个坞是空的"，那比过期更糟。 */
async function webDockSync(manual = false) {
  const src = (state.webDockSrc || '').trim();
  if (!src) { if (manual) showToast('先在下面填一个清单地址', 'info'); return; }
  if (_wdSyncing) return;
  if (!manual && Date.now() - (state.webDockSyncAt || 0) < WEBDOCK_SYNC_TTL) return;
  _wdSyncing = true;
  // 只在列表页重画。进坞就会自动同步，用户这时点开了一个页面的话，整块 body 重画会把
  // 正在用的 iframe 连根换掉、页面从头加载——填到一半的东西就没了。按钮上的「同步中…」只在列表页有。
  if (_wdView === 'list') renderWebDock();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(src, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!arr) throw new Error('清单格式不对（要一个数组，或 {items:[…]}）');
    state.webDockRemote = arr.filter(x => x && _wdSafeUrl(x.url)).slice(0, 60);
    state.webDockSyncAt = Date.now();
    save();
    if (manual) showToast(`✓ 已同步 ${state.webDockRemote.length} 个页面`, 'success');
  } catch (e) {
    if (manual) showToast('同步失败：' + (e.message || e), 'error', 3500);
  } finally {
    _wdSyncing = false;
    if (_wdView === 'list') renderWebDock();
  }
}

// ── 开关 ────────────────────────────────────────────────────────
function openWebDock() {
  document.getElementById('webdockModal')?.classList.remove('hidden');
  _wdView = 'list';
  renderWebDock();
  webDockSync(false);          // 进来就悄悄对一次清单，过期了才真的发请求
}
function closeWebDock() {
  document.getElementById('webdockModal')?.classList.add('hidden');
  const f = document.getElementById('wdFrame');
  if (f) f.src = 'about:blank';   // 别让后台的页面继续跑（音频、定时器、轮询）
  _wdView = 'list'; _wdCurrent = null;
}

function webDockOpen(url) {
  if (!_wdSafeUrl(url)) return;
  const it = webDockList().find(x => x.url === url) || { url, name: url, icon: '🔗' };
  _wdCurrent = it;
  _wdView = 'page';
  renderWebDock();
}
function webDockBackToList() { _wdView = 'list'; renderWebDock(); }
function webDockReload() {
  const f = document.getElementById('wdFrame');
  if (f && _wdCurrent) f.src = _wdCurrent.url;
}
function webDockExternal() {
  if (_wdCurrent && _wdSafeUrl(_wdCurrent.url)) window.open(_wdCurrent.url, '_blank');
}

// ── 渲染 ────────────────────────────────────────────────────────
function renderWebDock() {
  const body = document.getElementById('wdBody');
  if (!body) return;
  const tabs = document.getElementById('wdTabs');
  if (tabs) {
    tabs.querySelectorAll('.wd-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.wd === _wdView);
    });
    const pageTab = tabs.querySelector('[data-wd="page"]');
    if (pageTab) {
      pageTab.classList.toggle('wd-tab-off', !_wdCurrent);
      const label = pageTab.querySelector('.wd-tab-label');
      if (label) label.textContent = _wdCurrent ? _wdCurrent.name.slice(0, 6) : '当前页';
    }
  }
  body.innerHTML = _wdView === 'page' ? _wdPageHtml() : _wdListHtml();
  if (_wdView === 'page' && _wdCurrent) {
    const f = document.getElementById('wdFrame');
    // 同源的页面不给 allow-same-origin——那等于把自家 IndexedDB 交给它。
    // 外部站点本来就不同源，加上它只是让它能用自己的存储。
    if (f && f.dataset.src !== _wdCurrent.url) { f.dataset.src = _wdCurrent.url; f.src = _wdCurrent.url; }
  }
}

function _wdListHtml() {
  const items = webDockList();
  const syncAt = state.webDockSyncAt ? new Date(state.webDockSyncAt).toLocaleString('zh-CN', { hour12: false }).slice(5) : '还没同步过';
  return `
    <div class="wd-list">
      ${items.length ? items.map(it => `
        <div class="wd-card" onclick="webDockOpen(${jsAttr(it.url)})">
          <span class="wd-card-icon">${escHtml(it.icon)}</span>
          <div class="wd-card-main">
            <div class="wd-card-name">${escHtml(it.name)}${it.local ? '<span class="wd-card-tag">本地</span>' : ''}</div>
            <div class="wd-card-desc">${escHtml(it.desc || it.url)}</div>
          </div>
          ${it.local ? `<button class="wd-card-del" title="从列表移除"
             onclick="event.stopPropagation();webDockRemove(${jsAttr(it.url)})">✕</button>` : ''}
        </div>`).join('')
      : `<div class="gc-empty">
           <div class="gc-empty-icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/></svg></div>
           <div class="gc-empty-title">还没有页面</div>
           <div class="gc-empty-desc">下面填一个清单地址（一个 JSON），或者手动加一条 —— 之后改网页就是改网页，不用再打包。</div>
         </div>`}
    </div>
    <div class="wd-config">
      <div class="wd-config-title">清单地址</div>
      <div class="wd-config-row">
        <input class="field-input wd-input" id="wdSrcInput" placeholder="https://…/pages.json"
               value="${escHtml(state.webDockSrc || '')}"
               onchange="state.webDockSrc=this.value.trim();save()">
        <button class="apply-btn" onclick="state.webDockSrc=document.getElementById('wdSrcInput').value.trim();save();webDockSync(true)">
          ${_wdSyncing ? '同步中…' : '↻ 同步'}
        </button>
      </div>
      <div class="wd-config-hint">
        JSON 长这样：<code>[{"name":"记账","desc":"随手记两笔","url":"https://…/a.html","icon":"💰"}]</code><br>
        上次同步：${escHtml(syncAt)} · 远端 ${(state.webDockRemote || []).length} 条
      </div>
      <div class="wd-config-title" style="margin-top:14px">手动加一个</div>
      <div class="wd-config-row">
        <input class="field-input wd-input wd-input-sm" id="wdAddIcon" placeholder="🔗" maxlength="4">
        <input class="field-input wd-input wd-input-sm" id="wdAddName" placeholder="名字">
        <input class="field-input wd-input" id="wdAddUrl" placeholder="https://…">
        <button class="apply-btn" onclick="_wdAddFromInputs()">加入</button>
      </div>
      <div class="wd-config-hint">
        页面可以借 App 的权限：在它自己的脚本里
        <code>parent.postMessage({grancyan:'vibrate',ms:30},'*')</code> 就能震一下，
        <code>{grancyan:'toast',text:'…'}</code> 弹提示，<code>{grancyan:'close'}</code> 回聊天。
      </div>
    </div>`;
}

function _wdAddFromInputs() {
  const url = document.getElementById('wdAddUrl')?.value || '';
  const name = document.getElementById('wdAddName')?.value || '';
  const icon = document.getElementById('wdAddIcon')?.value || '';
  if (webDockAdd(url, name, '', icon)) { showToast('✓ 已加入列表', 'success'); renderWebDock(); }
}

function _wdPageHtml() {
  const it = _wdCurrent;
  if (!it) return _wdListHtml();
  const sameOrigin = (() => {
    try { return new URL(it.url, location.href).origin === location.origin; } catch (e) { return false; }
  })();
  const sandbox = 'allow-scripts allow-forms allow-popups allow-modals'
    + (sameOrigin ? '' : ' allow-same-origin');
  return `
    <div class="wd-pagebar">
      <button class="wd-pagebar-btn" onclick="webDockBackToList()" title="回列表">←</button>
      <span class="wd-pagebar-title">${escHtml(it.icon)} ${escHtml(it.name)}</span>
      <button class="wd-pagebar-btn" onclick="webDockReload()" title="刷新">↻</button>
      <button class="wd-pagebar-btn" onclick="webDockExternal()" title="用浏览器打开">⧉</button>
    </div>
    <iframe id="wdFrame" class="wd-frame" sandbox="${sandbox}"
            referrerpolicy="no-referrer" allow="clipboard-write; fullscreen"></iframe>`;
}

/* ── 页面 → App 的小桥 ────────────────────────────────────────────
   只认从当前 iframe 发来的消息，并且只放行这几件事。
   不做「读记忆」「发消息给 AI」之类的——那等于把整个 App 的数据交给一个外部网页。 */
window.addEventListener('message', (e) => {
  const f = document.getElementById('wdFrame');
  if (!f || e.source !== f.contentWindow) return;
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.grancyan) {
    case 'vibrate':
      try { navigator.vibrate?.(Math.min(400, Math.max(1, parseInt(msg.ms) || 20))); } catch (err) {}
      break;
    case 'toast':
      showToast(String(msg.text || '').slice(0, 60), msg.kind === 'error' ? 'error' : 'info');
      break;
    case 'close':
      closeWebDock();
      break;
  }
});
