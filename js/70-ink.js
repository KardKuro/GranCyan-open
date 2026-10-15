// 淡墨出字（2026-10-14，照 sanqianzilanyue/ai-streaming-ink 的做法搬进 GranCyan）
//
// 回复不再字一来就整截拍上去：字先排队，按读信的节奏一两个一两个放，每个字用 1.68 秒从透明洇到实。
// 淡入比两个字的间隔长得多，屏幕上同时有二十来个字处在不同浓淡里，看不见「冒出来」那一下。
//
// 原版只管纯文本；GranCyan 的气泡是 markdown 画出来的 HTML，而且流式时每 60ms 重画一次、
// 收尾时又被 renderMessages 整条换成正式消息。所以这里不碰内容管线，只给**已经画好的气泡**蒙一层墨：
//   · 进度按「看得见的字」计（文本节点的字；图片、代码块、表格、卡片这类整块的东西各算一个字）
//   · 放到哪（R）之前的字照常显示，最近 1.68 秒内放出来的套 <span class="ink-f">，
//     动画延时 = 出生时刻 − 现在（负数＝从半路接着演），所以节点被重画换掉也接得上，不会重淡一遍
//   · R 之后的字包进 display:none 的 span，还没轮到的段落/列表项/整块整个藏起来 ——
//     没放出来的东西不占高度，跟底跟的是墨，不是一片空白
// 进度挂在气泡的 id 上（bubble-<消息id> / variant-<消息id>-<第几个>），收尾换成正式消息时同一个 id 接着放。
//
// 挂点：_paintLiveBubble 画完调 inkPaint；renderLiveBubble 收尾那次调 inkEnd；renderMessages 插完节点调 inkAfterRender。
// 思考框不蒙（它自己有滚动条，进度也不算它）。开关在 外观 → 淡墨出字（state.inkStream，默认开）。

const INK_FADE_MS = 1680;
const INK_FREE = 300;          // 排队超过这么多字才开始提速
const INK_TAU = 16;            // 多出来的部分每 16 秒追平一份
const INK_AWAY_MS = 1500;      // 这么久没在放（切走了 / 切后台），回来时之前到的字直接当看过
// 标点后头歇几个字的工夫
const INK_PAUSE = { '。': 2.2, '！': 2.2, '？': 2.2, '…': 2.2, '!': 2.2, '?': 2.2,
  '，': 0.9, '、': 0.9, '；': 0.9, '：': 0.9, ',': 0.9, ';': 0.9, ':': 0.9, '\n': 1.5 };
const INK_ATOM = '￼';
// 往里走、按字放的元素；别的元素（图片、代码块、表格、卡片……）整块算一个字
const _INK_FLOW = new Set(['P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'STRONG', 'B', 'EM', 'I', 'U', 'DEL', 'S', 'A', 'CODE', 'SPAN', 'SUP', 'SUB', 'MARK', 'SMALL', 'Q', 'ABBR', 'KBD']);
// 不算进度、也不藏的：思考框、换窗心境批注、流式光标
const _INK_SKIP = '.think-block, .mood-note, .stream-cursor';

const _inks = new Map();       // 气泡 id → 进度
let _inkRaf = 0;

function inkEnabled() {
  if (typeof state !== 'undefined' && state && state.inkStream === false) return false;
  try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch (e) {}
  return true;
}
function _inkRate() {
  const r = typeof state !== 'undefined' && state ? +state.inkRate : 0;
  return r > 0 ? r : 14;
}

// 这条进度现在落在哪几个元素上。正式消息里表情会把一条拆成几个气泡（只有第一个带 id），按 data-msg-id 一起收
function _inkEls(st) {
  const el = document.getElementById(st.key);
  if (!el) return [];
  const mid = el.dataset && el.dataset.msgId;
  if (mid && el.classList.contains('bubble')) {
    const g = el.closest('.msg-group');
    if (g) return [...g.querySelectorAll('.bubble')].filter(b => b.dataset.msgId === mid);
  }
  return [el];
}

// 挂/摘 class 不留痕：摘光了连 class="" 属性一起拿掉。
// _patchLiveBubble 拿 isEqualNode 比新旧节点，留个空属性就永远「不一样」，每 60ms 整条气泡全换一遍
function _inkCls(el, cls, on) {
  el.classList.toggle(cls, on);
  if (!on && el.getAttribute('class') === '') el.removeAttribute('class');
}
function _inkAtomClear(e) {
  _inkCls(e, 'ink-atom', false);
  e.style.removeProperty('--ink-d');
  if (e.getAttribute('style') === '') e.removeAttribute('style');
  delete e.dataset.inkB;
}

// 把蒙的墨揭掉：等着的字和淡着的字并回普通文本，藏着的块放出来。full=true 连整块的淡入也撤（收工时）
function _inkUnveil(root, full) {
  const touched = new Set();
  root.querySelectorAll('span[data-ink]').forEach(s => {
    const p = s.parentNode;
    if (!p) return;
    p.replaceChild(document.createTextNode(s.textContent), s);
    touched.add(p);
  });
  touched.forEach(p => p.normalize());
  _inkCls(root, 'ink-hide', false);
  root.querySelectorAll('.ink-hide').forEach(e => _inkCls(e, 'ink-hide', false));
  if (full) {
    if (root.classList.contains('ink-atom')) _inkAtomClear(root);
    root.querySelectorAll('.ink-atom').forEach(_inkAtomClear);
  }
}

function _inkSpan(text, cls, birth, now) {
  const s = document.createElement('span');
  s.dataset.ink = '1';
  s.className = cls;
  s.textContent = text;
  if (birth != null) s.style.setProperty('--ink-d', Math.round(birth - now) + 'ms');
  return s;
}

// 整块的东西（图片、代码块、卡片、表情气泡）：没轮到就藏，刚轮到就整块淡入。
// 已经在淡的别重设延时 —— 节点还是那个、动画还在跑，改延时会让它跳一下
function _inkAtom(el, idx, st, now) {
  if (idx >= st.R) { el.classList.add('ink-hide'); return; }
  _inkCls(el, 'ink-hide', false);
  const b = st.births[idx];
  if (b > now - INK_FADE_MS) {
    if (el.dataset.inkB !== String(b)) {
      el.dataset.inkB = String(b);
      el.style.setProperty('--ink-d', Math.round(b - now) + 'ms');
      el.classList.add('ink-atom');
    }
  } else if (el.classList.contains('ink-atom')) {
    _inkAtomClear(el);
  }
}

// 一个文本节点：[已落定 | 正在淡（按出生时刻分组）| 还没轮到]
function _inkText(node, s, st, now, out) {
  const txt = node.data, e = s + txt.length;
  const R = st.R;
  if (s >= R) {               // 整段都没轮到
    node.parentNode.replaceChild(_inkSpan(txt, 'ink-wait'), node);
    return;
  }
  const visEnd = Math.min(e, R);
  let fresh = s;              // 第一个还在淡的字（births 是单调不减的）
  const cut = now - INK_FADE_MS;
  while (fresh < visEnd && st.births[fresh] <= cut) fresh++;
  if (fresh >= visEnd && e <= R) { out.last = node; return; }   // 全落定了，不动它
  const frag = document.createDocumentFragment();
  if (fresh > s) frag.appendChild(document.createTextNode(txt.slice(0, fresh - s)));
  let i = fresh, lastNode = fresh > s ? frag.lastChild : null;
  while (i < visEnd) {
    const b = st.births[i];
    let j = i + 1;
    while (j < visEnd && st.births[j] === b) j++;
    lastNode = frag.appendChild(_inkSpan(txt.slice(i - s, j - s), 'ink-f', b, now));
    i = j;
  }
  if (e > R) frag.appendChild(_inkSpan(txt.slice(R - s), 'ink-wait'));
  out.last = lastNode || out.last;
  node.parentNode.replaceChild(frag, node);
}

// 走一遍：算出看得见的字（st.text / st.L），同时按 R 蒙上墨
function _inkWalk(node, st, now, out) {
  for (let c = node.firstChild; c; ) {
    const next = c.nextSibling;
    if (c.nodeType === 3) {
      if (/\S/.test(c.data)) {
        const s = out.text.length;
        out.text += c.data;
        _inkText(c, s, st, now, out);
      }
    } else if (c.nodeType === 1) {
      if (c.matches(_INK_SKIP)) { /* 不算也不藏 */ }
      else if (c.tagName === 'BR') {
        const s = out.text.length; out.text += '\n';
        _inkCls(c, 'ink-hide', s >= st.R);
      } else if (_INK_FLOW.has(c.tagName) && !c.classList.contains('katex') && !c.classList.contains('katex-display')) {
        const s = out.text.length;
        _inkWalk(c, st, now, out);
        const len = out.text.length - s;
        // 还一个字都没轮到的段落/列表项/行内 code 整个藏起来（空的 <p>、带底色的 <code> 也有个框）
        _inkCls(c, 'ink-hide', len > 0 ? s >= st.R : s > st.R);
      } else {
        const s = out.text.length; out.text += INK_ATOM;
        _inkAtom(c, s, st, now);
        if (s < st.R) out.last = c;
      }
    }
    c = next;
  }
}

function _inkVeil(st, els, now) {
  const out = { text: '', last: null };
  let cursor = null;
  for (const root of els) {
    _inkUnveil(root, false);
    if (!cursor) cursor = root.querySelector('.stream-cursor');
    if (root.classList.contains('bubble-sticker')) {          // 表情气泡整个算一块
      const s = out.text.length; out.text += INK_ATOM;
      _inkAtom(root, s, st, now);
      continue;
    }
    const s = out.text.length;
    _inkWalk(root, st, now, out);
    // 拆出来的后几个气泡：一个字都没轮到就整个藏（不然先露出个空气泡框）
    if (root !== els[0]) _inkCls(root, 'ink-hide', out.text.length > s && s >= st.R);
    st.els.add(root);
  }
  // 文本被改写了（收尾去掉了标签、markdown 重排）：比 R 短就跟着缩，出生时刻按位置沿用
  st.text = out.text;
  st.L = out.text.length;
  if (st.R > st.L) { st.R = st.L; st.births.length = st.L; }
  // 模型写完了（收尾那次重画不带光标），队里还有字在放：自己补一个，放完再拿掉。
  // 不然最后那一大截是没光标地往外冒的，看着像卡住了
  if (!cursor && st.R < st.L && els[0]) {
    cursor = document.createElement('span');
    cursor.className = 'stream-cursor';
    cursor.dataset.inkCur = '1';
    els[0].appendChild(cursor);
  }
  // 光标跟在墨后头，不是挂在一堆还没放的字的最后面；追平了就回到气泡末尾（它本来的位置）
  if (cursor && cursor.dataset.inkCur && st.R >= st.L) cursor.remove();
  else if (cursor) {
    if (out.last && out.last.parentNode && st.R < st.L) out.last.parentNode.insertBefore(cursor, out.last.nextSibling);
    else if (cursor.parentNode !== els[0] || cursor.nextSibling) els[0].appendChild(cursor);
  }
  // 页脚（tokens、回复建议）等字显完再出来
  const g = els[0] && els[0].closest('.msg-group');
  if (g && /^bubble-/.test(st.key)) { g.classList.add('ink-busy'); g.classList.remove('ink-foot'); }
}

function _inkFinish(st) {
  const els = _inkEls(st);
  for (const el of [...st.els, ...els]) {
    try { el.querySelectorAll('[data-ink-cur]').forEach(c => c.remove()); _inkUnveil(el, true); } catch (e) {}
  }
  const cur = els[0] && els[0].querySelector('.stream-cursor');
  if (cur && (cur.parentNode !== els[0] || cur.nextSibling)) els[0].appendChild(cur);
  // 页脚：当前那份和蒙过的旧节点（可能已经离开页面、躺在缓存里等切回来）都摘。
  // 只摘当前的话，切到空对话时收的工，缓存里那条的 tokens 就永远藏着
  const groups = new Set();
  for (const el of [...st.els, ...els]) { const g = el.closest && el.closest('.msg-group'); if (g) groups.add(g); }
  for (const g of groups) {
    if (!g.classList.contains('ink-busy')) continue;
    g.classList.remove('ink-busy');
    if (!g.isConnected) continue;
    g.classList.add('ink-foot');
    // 淡完就摘掉：正式消息的节点是缓存复用的，切对话再插回来时动画会重播一遍
    setTimeout(() => g.classList.remove('ink-foot'), 900);
  }
  _inks.delete(st.key);
}

// ── 跟底：每帧往底部挪剩下距离的一部分（时间常数 0.16s），她一碰就停 ──
let _inkGlide = 0, _inkGlideHooked = false;
function _inkFollow(win) {
  if (!_inkGlideHooked) {
    _inkGlideHooked = true;
    const stop = () => { if (_inkGlide) { cancelAnimationFrame(_inkGlide); _inkGlide = 0; } };
    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => win.addEventListener(ev, stop, { passive: true }));
  }
  if (_inkGlide) return;
  let last = performance.now(), pos = win.scrollTop;
  const step = () => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const gap = win.scrollHeight - win.clientHeight - pos;
    if (gap <= 1 || !win.isConnected) { _inkGlide = 0; return; }
    pos += Math.max(1, gap * (1 - Math.exp(-dt / 0.16)));
    win.scrollTop = pos;
    _inkGlide = requestAnimationFrame(step);
  };
  _inkGlide = requestAnimationFrame(step);
}

// 返回 true＝下一帧还要接着跑
function _inkStep(st, now) {
  const els = _inkEls(st);
  // 切到别的对话了，或者气泡所在的页被整个藏起来（display:none，量不出框）：先不放，回来按「离开过」处理。
  // 量父节点不量气泡自己：还没轮到的表情气泡是被墨自己 ink-hide 掉的，那不算离开
  if (!els.length || !(els[0].parentElement || els[0]).getClientRects().length) {
    if (!st.awayAt) st.awayAt = now;
    // 流写完了、或者离开了 10 分钟还没回来（流断在半路、收尾那声没传到）：揭干净收工，别让循环一直空转
    if (st.ended || now - st.awayAt > 600000) { _inkFinish(st); return false; }
    return true;
  }
  const gap = now - st.last;
  st.last = now;
  let grew = false;
  // 离开过（切走 / 切后台）：之前到的字当看过，不重演。
  // 只认明确的「离开」，不拿两帧间隔猜 —— 手机上一次重渲染卡个两秒也是大间隔，那不算她走了
  const away = (st.awayAt && now - st.awayAt > INK_AWAY_MS) || now < st.flushUntil;
  st.awayAt = 0;
  if (away && st.R < st.L) {
    // 之前在淡的也一起落定：births 得保持单调不减（_inkText 和收工判断都靠它）
    const cut = now - INK_FADE_MS - 1;
    for (let i = st.R - 1; i >= 0 && st.births[i] > cut; i--) st.births[i] = cut;
    for (let i = st.R; i < st.L; i++) st.births[i] = cut;
    st.R = st.L; st.acc = 0; grew = true;
  } else if (st.R < st.L) {
    const dt = Math.min(0.1, gap / 1000);  // 后台回来别一口吐一大截
    const backlog = st.L - st.R;
    const speed = _inkRate() + Math.max(0, backlog - INK_FREE) / INK_TAU;
    // 每帧最多放多少跟着速度走：写死 4 个的话积压几千字时提速被它压住，帧率一掉更慢
    st.acc = Math.min(Math.max(4, speed * 0.1), st.acc + speed * dt);
    if (st.acc >= 1) {
      let end = Math.min(st.L, st.R + Math.floor(st.acc));
      const code = st.text.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF && end < st.L) end++;   // 别把表情劈成两半
      st.acc -= end - st.R;
      st.acc -= INK_PAUSE[st.text[end - 1]] || 0;                  // 标点后头歇一口气
      for (let i = st.R; i < end; i++) st.births[i] = now;
      st.R = end; grew = true;
    }
  }
  const fading = st.R > 0 && st.births[st.R - 1] > now - INK_FADE_MS;
  if (st.ended && st.R >= st.L && !fading) { _inkFinish(st); return false; }
  // 淡完的字每隔一阵并回普通文本（不然最后一下才并，期间 span 越攒越多）
  let fold = !grew && fading && now - st.folded > 400;
  if (grew || fold) {
    st.folded = now;
    const win = document.getElementById('chatWindow');
    const follow = grew && win && win.contains(els[0]) && win.scrollHeight - win.scrollTop - win.clientHeight < 60;
    _inkVeil(st, els, now);
    if (follow) _inkFollow(win);
  }
  // 追平了、也淡完了：先歇着，等下一次画气泡 / renderMessages 再叫醒（模型停下来想的时候别每帧空转耗电）。
  // 淡完的最后那批 span 留到下次蒙墨或收工时再并，看上去没区别
  return st.R < st.L || fading;
}

function _inkLoop(now) {
  _inkRaf = 0;
  let more = false;
  for (const st of [..._inks.values()]) {
    try { if (_inkStep(st, now)) more = true; } catch (e) { console.warn('[淡墨]', e); _inkFinish(st); }
  }
  if (more) _inkRaf = requestAnimationFrame(_inkLoop);
  // 歇着的时候每秒看一眼：她切走了要记下「离开」，回来时那段时间到的字直接显出来
  else if (_inks.size && !_inkNap) _inkNap = setTimeout(() => { _inkNap = 0; _inkKick(); }, 1000);
}
let _inkNap = 0;
function _inkKick() { if (!_inkRaf && _inks.size) _inkRaf = requestAnimationFrame(_inkLoop); }
// 她离开这个窗口：切后台（hidden），或者桌面上切去别的窗口（失焦）。
// 后一种 exe 被盖住了 Chromium 也不算 hidden，rAF 照跑，字在她背后按读信的速度慢慢放，回来还没放完。
// 所以离开时只记个时刻，回来那一下才按这个时刻给每条进度补上 awayAt（中间 _inkStep 照跑也冲不掉）
let _inkLeftAt = 0;
function _inkLeave() { if (!_inkLeftAt) _inkLeftAt = performance.now(); }
function _inkBack() {
  const t = _inkLeftAt;
  _inkLeftAt = 0;
  if (t && performance.now() - t > INK_AWAY_MS) {
    for (const st of _inks.values()) st.awayAt = st.awayAt ? Math.min(st.awayAt, t) : t;
  }
  _inkKick();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { document.hidden ? _inkLeave() : _inkBack(); });
  // 焦点进了页面里的 iframe 也会触发 window 的 blur —— 那不算离开，等一拍看 document 还有没有焦点
  window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) _inkLeave(); }, 0));
  window.addEventListener('focus', _inkBack);
}

function _inkNew(elId) {
  const now = performance.now();
  const st = { key: elId, R: 0, L: 0, acc: 0, births: [], text: '', last: now, folded: now, ended: false, awayAt: 0, flushUntil: 0, els: new Set() };
  _inks.set(elId, st);
  return st;
}

// 流式气泡刚画完（_paintLiveBubble 末尾）。streaming=false 的那次画就是收尾。
// 这里是在流的回调里同步跑的：出了错只能吞掉、把这条揭干净，不能把模型的流带崩
function inkPaint(elId, streaming) {
  let st = _inks.get(elId);
  try {
    // 同一个气泡又开始流了（重跑同一个变体、找回电脑上的活），上一轮还在放的先放完，别把旧进度带进新流
    if (st && st.ended && streaming) { _inkFinish(st); st = null; }
    if (!st) {
      if (!streaming || !inkEnabled()) return;
      st = _inkNew(elId);
    }
    if (!streaming) st.ended = true;
    const els = _inkEls(st);
    if (els.length) _inkVeil(st, els, performance.now());   // 同步蒙上：别让刚画的整截先露一帧
    _inkKick();
  } catch (e) {
    console.warn('[淡墨]', e);
    if (st) { try { _inkFinish(st); } catch (e2) {} }
  }
}

// 模型写完了（renderLiveBubble 收尾那次）。队里剩下的字接着放完
function inkEnd(elId) {
  const st = _inks.get(elId);
  if (st) { st.ended = true; _inkKick(); }
}

// 接下来这一阵到的字都当看过（找回电脑上的活：开头那段是整条重放，她多半早看过了）
function inkFlush(elId, ms) {
  if (!inkEnabled()) return;
  let st = _inks.get(elId);
  if (st && st.ended) { _inkFinish(st); st = null; }
  if (!st) st = _inkNew(elId);
  st.flushUntil = performance.now() + (ms || 1500);
}

// renderMessages 换了节点之后：还在放的那几条重新蒙上（正式消息接着同一份进度放）
function inkAfterRender() {
  if (!_inks.size) return;
  const now = performance.now();
  for (const st of _inks.values()) {
    const els = _inkEls(st);
    if (!els.length) continue;
    try { _inkVeil(st, els, now); } catch (e) { console.warn('[淡墨]', e); try { _inkFinish(st); } catch (e2) {} }
  }
  _inkKick();
}

// 这条还在放吗（外面要判「先别出页脚」之类的时候用）
function inkBusy(elId) { return _inks.has(elId); }

// 外观里那个开关和速度下拉回填（开机、打开设置时）
function _syncInkSettings() {
  const t = document.getElementById('inkStreamToggle');
  if (t) t.checked = state.inkStream !== false;
  const s = document.getElementById('inkRateSelect');
  if (s) s.value = String(+state.inkRate || 14);
}
