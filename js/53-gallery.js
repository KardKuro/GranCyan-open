// ============================================================
// 画板：收大家画的画 —— AI 画的动画、用户画的、朋友送的、别的 AI 画的。
//
// 点子：给自己做一个画板，存大家画的画。每张画旁边留一行注脚，
// 写这张是什么、那天发生了什么。
//
// ⚠️ 存储单独走 IDB 的 kuro_gallery，**不进 state**：
//   一张动画几十 KB、一张图几 MB，塞进 state 的话每次 save() 都要整包重写一遍；
//   而且单独的 key 不用过「持久化三道白名单」，漏一道刷新即失那种坑这里没有。
//   代价是它不跟着 state 走云同步 —— 画板目前只在本机。
//
// 画是怎么挂上来的：
//   · 模型在回复里先写一块 ```html / ```svg 画，再单独一行 [[GALLERY: 注脚]]，
//     就把这条消息里、这个指令**之前**最后一块画挂上去（galleryProcessTags）。
//   · 用户在画板里自己传：图片、.html、.svg 都收。
// 看画用画板自己的 iframe（sandbox 不给 same-origin），每次从头播，关掉就卸，不存进度。
// ============================================================

const GALLERY_KEY = 'kuro_gallery';
let _galleryItems = null;      // 没读过是 null；读过（哪怕是空的）才是数组
let _galleryLoading = null;
let _gallerySel = null;
let _galleryDelArm = null;     // 删除要点两下：第一下只是「上膛」
let _galleryPending = null;    // 用户选好但还没挂上去的文件 {kind, src, name}
let _gallerySrcOpen = false;   // 「</> 源码」展开着没；换一张画也保持，方便一张张翻着看

function galleryEsc(v) {
  const s = String(v == null ? '' : v);
  return typeof escHtml === 'function' ? escHtml(s)
    : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function galleryNewId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function galleryLoad() {
  if (_galleryItems) return _galleryItems;
  if (_galleryLoading) return _galleryLoading;
  _galleryLoading = (async () => {
    // 读失败 ≠ 从没存过。以前 catch 里把 raw 当 null，于是一次读失败就被当成「新画板」，
    // 第一批种子画直接写回去盖掉了真画板。现在读失败就往外抛：不缓存、不写回，下次打开再读。
    const raw = await idbGet(GALLERY_KEY);
    let items = null;
    if (raw != null) {
      try { items = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { items = null; }
    }
    if (Array.isArray(items)) {
      _galleryItems = items.filter(it => it && it.id && it.src);
    } else {
      // 从没存过（null）才挂第一批。读坏了的当空的，但这时不写回 —— 下一次真挂画才会覆盖
      _galleryItems = raw == null && typeof GALLERY_SEED !== 'undefined'
        ? GALLERY_SEED.map(it => Object.assign({}, it)) : [];
      if (raw == null) await gallerySave();
    }
    return _galleryItems;
  })();
  try { return await _galleryLoading; }
  finally { _galleryLoading = null; }
}

async function gallerySave() {
  try { await idbSet(GALLERY_KEY, JSON.stringify(_galleryItems || [])); return true; }
  catch (e) {
    if (typeof showToast === 'function') showToast('画板没存上：' + (e && e.message || e), 'error', 2600);
    return false;
  }
}

function gallerySorted() {
  return (_galleryItems || []).slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
}

async function galleryAdd(item) {
  try { await galleryLoad(); }
  catch (e) {
    if (typeof showToast === 'function') showToast('画板读不出来，这张先没挂上：' + (e && e.message || e), 'error', 2600);
    return null;
  }
  const it = {
    id: galleryNewId(),
    kind: item.kind === 'image' ? 'image' : 'html',
    src: String(item.src || ''),
    author: String(item.author || '').trim() || '无名氏',
    caption: String(item.caption || '').trim().slice(0, 200),
    ts: Number(item.ts || Date.now()),
  };
  if (!it.src) return null;
  _galleryItems.push(it);
  await gallerySave();
  if (galleryIsOpen()) { _gallerySel = it.id; galleryRender(); }
  return it;
}

// ── 模型挂画：[[GALLERY: 注脚]] ──────────────────────────────

function galleryTagRe() {
  return /\[\[GALLERY:\s*([\s\S]*?)\s*\]\]/g;
}

// svg 单独成块时包成一页，居中、深色底
function galleryWrapSvg(svg) {
  return '<!doctype html><html><head><meta charset="utf-8"></head>'
    + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d14">'
    + svg + '</body></html>';
}

// 指令之前、离它最近的那块 html / svg 代码块。找不到就是 null（不去挂别条消息里的画）。
function galleryFindDrawing(before) {
  const re = /```[ \t]*(html|htm|svg|xml)[^\n]*\n([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(String(before || '')))) last = m;
  if (!last) return null;
  const lang = last[1].toLowerCase();
  const code = last[2].replace(/\s+$/, '');
  if (!code.trim()) return null;
  if (lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/i.test(code))) return galleryWrapSvg(code);
  if (lang === 'xml') return null;
  return code;
}

function galleryChatCardHtml(caption, found) {
  return '<button type="button" class="gallery-chat-card' + (found ? '' : ' is-miss') + '" onclick="openGallery()">'
    + '<span class="gallery-chat-kicker">' + (found ? '🖼 挂上了画板' : '🖼 想挂画，但这条里没找到画') + '</span>'
    + '<span class="gallery-chat-text">' + galleryEsc(String(caption == null ? '' : caption).trim()) + '</span>'
    + '</button>';
}

// 副作用（真的挂上去）只在 content 这条路上做一次；blocks 那条路只画卡片。
function galleryProcessTags(text, conf) {
  if (!text || String(text).indexOf('[[GALLERY:') === -1) return text;
  const who = String(conf && (conf.name || conf.nickname) || '').trim() || 'AI';
  const used = new Set();
  return String(text).replace(galleryTagRe(), (_, cap, offset, whole) => {
    const src = galleryFindDrawing(whole.slice(0, offset));
    // 同一条消息里两个指令指着同一块画：只挂一次，卡片照样显示
    if (src && !used.has(src)) {
      used.add(src);
      galleryAdd({ kind: 'html', src, author: who, caption: cap, ts: Date.now() });
    }
    return '\n\n' + galleryChatCardHtml(cap, !!src) + '\n\n';
  });
}

function _applyGalleryToBlocks(blocks) {
  if (!Array.isArray(blocks)) return;
  let before = '';   // 前面各块的原文：代码块和指令可能被切进不同的 text block
  for (const block of blocks) {
    if (!block || block.type !== 'text' || !block.text) continue;
    const orig = block.text;
    if (orig.indexOf('[[GALLERY:') !== -1) {
      block.text = orig.replace(galleryTagRe(), (_, cap, offset) =>
        '\n\n' + galleryChatCardHtml(cap, !!galleryFindDrawing(before + orig.slice(0, offset))) + '\n\n');
    }
    before += orig + '\n';
  }
}

function maskStreamingGallery(text) {
  if (!text || String(text).indexOf('[[GALLERY') === -1) return text;
  return String(text)
    .replace(/\[\[GALLERY:[\s\S]*?\]\]/g, '〔🖼 正在挂上画板…〕')
    .replace(/\[\[GALLERY:?[\s\S]*$/, '〔🖼 正在挂上画板…〕');
}

// ── 画板面板 ───────────────────────────────────────────────

function galleryIsOpen() {
  const modal = document.getElementById('galleryModal');
  return !!(modal && !modal.classList.contains('hidden'));
}

async function openGallery(id) {
  const modal = document.getElementById('galleryModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const list = document.getElementById('galleryList');
  if (!_galleryItems && list) list.innerHTML = '<div class="gallery-empty">正在翻画板…</div>';
  try { await galleryLoad(); }
  catch (e) {
    if (list) list.innerHTML = '<div class="gallery-empty">画板没读出来，关掉再开一次试试。</div>';
    return;
  }
  _gallerySel = id || _gallerySel || (gallerySorted()[0] || {}).id || null;
  _galleryDelArm = null;
  galleryRender();
}

function closeGallery() {
  galleryFullscreen(false);
  const modal = document.getElementById('galleryModal');
  if (modal) modal.classList.add('hidden');
  // 关掉就卸：动画、声音不在看不见的地方接着跑，下次打开从头播
  const frame = document.getElementById('galleryFrame');
  if (frame) frame.srcdoc = '';
}

function galleryHtmlTitle(src) {
  const m = String(src || '').match(/<title[^>]*>([^<]{1,60})<\/title>/i);
  return m ? m[1].trim() : '';
}

function galleryStageDoc(it) {
  if (it.kind === 'image') {
    return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0d0d14}'
      + 'body{display:grid;place-items:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head>'
      + '<body><img src="' + galleryEsc(it.src) + '" alt=""></body></html>';
  }
  // 沙箱里碰 localStorage 会抛，垫片换成内存版（和聊天里 ▶ 运行同一个）
  const shim = typeof _artifactShim === 'function' ? '<script>' + _artifactShim(false) + '<\/script>' : '';
  const src = String(it.src);
  const head = src.match(/<head[^>]*>/i);
  return head ? src.replace(head[0], m => m + shim) : shim + src;
}

// 「</> 源码」给看、给复制的那份：svg 挂上来时被 galleryWrapSvg 包过一层，剥回原来那块 svg。
// 图片没有源码可看（src 是一整串 data URL），返回空串，按钮也不出。
function gallerySourceOf(it) {
  if (!it || it.kind !== 'html') return '';
  const src = String(it.src || '');
  const pre = galleryWrapSvg('');
  const cut = pre.indexOf('</body>');
  const head = pre.slice(0, cut), tail = pre.slice(cut);
  if (src.startsWith(head) && src.endsWith(tail)) {
    const inner = src.slice(head.length, src.length - tail.length);
    if (/^\s*<svg[\s>]/i.test(inner)) return inner;
  }
  return src;
}

function gallerySrcPanelHtml(code) {
  const lines = code ? code.split('\n').length : 0;
  const kb = code.length / 1024;
  return '<div class="gallery-src">'
    + '<div class="gallery-src-bar"><span>' + lines + ' 行 · ' + (kb < 1 ? code.length + ' 字' : kb.toFixed(1) + ' KB') + '</span>'
    + '<button type="button" class="gallery-src-copy" onclick="galleryCopySrc(this)">⎘ 复制源码</button></div>'
    + '<pre class="gallery-src-code"><code>' + galleryEsc(code) + '</code></pre></div>';
}

function galleryToggleSrc() {
  _gallerySrcOpen = !_gallerySrcOpen;
  galleryRender();   // 舞台按 dataset.showing 判断，同一张不会重载，画接着播
}

function galleryCopySrc(btn) {
  const it = (_galleryItems || []).find(x => x.id === _gallerySel);
  const code = gallerySourceOf(it);
  if (!code) return;
  const done = ok => {
    if (!btn) return;
    btn.textContent = ok ? '✓ 已复制' : '没复制上，长按代码手动选';
    btn.classList.toggle('is-done', !!ok);
    setTimeout(() => { btn.textContent = '⎘ 复制源码'; btn.classList.remove('is-done'); }, 1600);
  };
  const copy = typeof copyTextCompat === 'function' ? copyTextCompat(code)
    : (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject(new Error('no clipboard')));
  copy.then(() => done(true), () => done(false));
}

function galleryDate(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function galleryRender() {
  const items = gallerySorted();
  const list = document.getElementById('galleryList');
  const stage = document.getElementById('galleryStage');
  const frame = document.getElementById('galleryFrame');
  const meta = document.getElementById('galleryMeta');
  if (!list || !stage || !frame || !meta) return;
  let sel = items.find(it => it.id === _gallerySel);
  if (!sel && items.length) { sel = items[0]; _gallerySel = sel.id; }

  if (!sel) {
    stage.classList.add('is-empty');
    frame.srcdoc = '';
    meta.innerHTML = '<div class="gc-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="1.5"/>'
      + '<path d="M7 13l3-3 3 3 2-2 2 2"/><path d="M9 21h6M12 17v4"/></svg></div>'
      + '<div class="gc-empty-title">画板还是空的</div>'
      + '<div class="gc-empty-desc">画了什么就挂上来，或者让 AI 画一张给你。</div></div>';
  } else {
    stage.classList.remove('is-empty');
    if (frame.dataset.showing !== sel.id || !frame.srcdoc) galleryStageLoad(stage, frame, galleryStageDoc(sel));
    frame.dataset.showing = sel.id;
    const armed = _galleryDelArm === sel.id;
    const code = gallerySourceOf(sel);
    meta.innerHTML = '<div class="gallery-meta-line"><b>' + galleryEsc(sel.author) + '</b>'
      + '<span>' + galleryDate(sel.ts) + '</span>'
      + '<button type="button" class="gallery-replay" onclick="galleryReplay()">↻ 重播</button>'
      + (code ? '<button type="button" class="gallery-src-toggle' + (_gallerySrcOpen ? ' is-on' : '') + '" onclick="galleryToggleSrc()">'
        + (_gallerySrcOpen ? '&lt;/&gt; 收起源码' : '&lt;/&gt; 源码') + '</button>' : '')
      + '<button type="button" class="gallery-full" onclick="galleryFullscreen(true)">⛶ 全屏</button>'
      + '<button type="button" class="gallery-del' + (armed ? ' is-armed' : '') + '" onclick="galleryDelete()">'
      + (armed ? '再点一下就摘掉' : '摘下来') + '</button></div>'
      // textarea 不是 input：注脚常常一句话写不完，手机上单行框会把后半句截掉
      + '<textarea id="galleryCaption" class="gallery-caption" rows="2" maxlength="200" placeholder="给这张画留一行字…"'
      + ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.blur()}" onblur="galleryCaptionSave(this.value)">'
      + galleryEsc(sel.caption || '') + '</textarea>'
      + (code && _gallerySrcOpen ? gallerySrcPanelHtml(code) : '');
  }

  list.innerHTML = items.map(it => {
    const thumb = it.kind === 'image'
      ? '<img src="' + galleryEsc(it.src) + '" alt="" loading="lazy">'
      : '<span class="gallery-tile-html"><i>▶</i>' + galleryEsc(galleryHtmlTitle(it.src) || '会动的画') + '</span>';
    return '<button type="button" class="gallery-tile' + (sel && it.id === sel.id ? ' is-on' : '') + '"'
      + ' data-id="' + galleryEsc(it.id) + '" onclick="gallerySelect(this.dataset.id)">'
      + '<span class="gallery-tile-thumb">' + thumb + '</span>'
      + '<span class="gallery-tile-cap">' + galleryEsc(it.caption || '（没留字）') + '</span>'
      + '<span class="gallery-tile-by">' + galleryEsc(it.author) + ' · ' + galleryDate(it.ts) + '</span>'
      + '</button>';
  }).join('');
}

function gallerySelect(id) {
  _gallerySel = id;
  _galleryDelArm = null;
  galleryRender();
}

// 全屏分两层：is-full 先把舞台铺满窗口（哪儿都灵），再去要原生全屏盖掉任务栏/标题栏。
// 安卓 WebView 没实现 onShowCustomView，原生那层要不到 —— 要不到就停在铺满窗口，不算失败。
// 退出走同一个函数：✕、Esc、关画板、用户自己按 Esc 退掉原生全屏（fullscreenchange）都收回 is-full。
function galleryFullscreen(on) {
  const stage = document.getElementById('galleryStage');
  if (!stage) return;
  if (on) {
    if (stage.classList.contains('is-empty')) return;
    stage.classList.add('is-full');
    try {
      const p = stage.requestFullscreen && stage.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    return;
  }
  stage.classList.remove('is-full');
  if (document.fullscreenElement === stage) { try { document.exitFullscreen().catch(() => {}); } catch (e) {} }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('fullscreenchange', () => {
    const stage = document.getElementById('galleryStage');
    if (stage && !document.fullscreenElement && stage.classList.contains('is-full')) stage.classList.remove('is-full');
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const stage = document.getElementById('galleryStage');
    if (stage && stage.classList.contains('is-full')) { e.stopPropagation(); galleryFullscreen(false); }
  }, true);
}

function galleryReplay() {
  const frame = document.getElementById('galleryFrame');
  const it = (_galleryItems || []).find(x => x.id === _gallerySel);
  if (frame && it) { frame.srcdoc = ''; galleryStageLoad(document.getElementById('galleryStage'), frame, galleryStageDoc(it)); }
}

// A28：新画的文档没画出第一帧之前（样式表常挂着 Google Fonts，在等它），iframe 会先铺一整块白。
// 换画时把舞台标成 is-loading（CSS 里 iframe 透明、露出舞台的深底），load 了再淡入；
// load 迟迟不来（字体 CDN 被墙）也最多藏 4 秒，不让画一直看不见。
// 重播是先 srcdoc='' 再赋新文档：清空那次要是也回了 load，那时 srcdoc 已经是新值，光看 srcdoc 会提前淡入。
// 所以 load 里再看一眼文档是不是空的；序号防的是连点两幅时，前一幅的 4 秒兜底把后一幅提前亮出来
let _galleryLoadTimer = null, _galleryLoadSeq = 0;
function galleryStageLoad(stage, frame, doc) {
  if (stage && stage.classList) {
    stage.classList.add('is-loading');
    const seq = ++_galleryLoadSeq;
    const done = () => { if (seq === _galleryLoadSeq) stage.classList.remove('is-loading'); };
    frame.onload = () => {
      let blank = false;
      try { const d = frame.contentDocument; blank = !!(d && d.body && d.body.childNodes.length === 0); } catch {}
      if (frame.srcdoc && !blank) done();
    };
    clearTimeout(_galleryLoadTimer);
    _galleryLoadTimer = setTimeout(done, 4000);
  }
  frame.srcdoc = doc;
}

async function galleryCaptionSave(value) {
  const it = (_galleryItems || []).find(x => x.id === _gallerySel);
  const v = String(value || '').trim().slice(0, 200);
  if (!it || it.caption === v) return;
  it.caption = v;
  await gallerySave();
  // 只刷缩略图那一格的字，别重画整页（重画会把舞台上正在播的画打断）
  const cap = document.querySelector('.gallery-tile.is-on .gallery-tile-cap');
  if (cap) cap.textContent = v || '（没留字）';
}

async function galleryDelete() {
  if (!_gallerySel) return;
  if (_galleryDelArm !== _gallerySel) {
    _galleryDelArm = _gallerySel;
    galleryRender();
    return;
  }
  _galleryItems = (_galleryItems || []).filter(x => x.id !== _gallerySel);
  _galleryDelArm = null;
  _gallerySel = null;
  await gallerySave();
  galleryRender();
}

// ── 用户自己挂画 ───────────────────────────────────────────

function galleryReadFile(file, as) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (as === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}

// 大图压一压：IDB 装得下，但每次打开画板都要整包读出来。动图不压（压了就不动了）。
async function galleryShrinkImage(dataUrl, type) {
  if (/gif|svg/.test(type) || dataUrl.length < 1.5 * 1024 * 1024) return dataUrl;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/webp', 0.9);
    return out.startsWith('data:image/webp') && out.length < dataUrl.length ? out : dataUrl;
  } catch (e) { return dataUrl; }
}

async function galleryPickFile(input) {
  const file = input && input.files && input.files[0];
  const label = document.getElementById('galleryFileName');
  _galleryPending = null;
  if (!file) { if (label) label.textContent = '还没选'; return; }
  const name = file.name || '';
  // File.type 不可信（.ts 会被标成 video/*），按扩展名兜一道
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  try {
    if (/^html?$/i.test(ext)) {
      _galleryPending = { kind: 'html', src: await galleryReadFile(file, 'text'), name };
    } else if (/^svg$/i.test(ext)) {
      _galleryPending = { kind: 'html', src: galleryWrapSvg(await galleryReadFile(file, 'text')), name };
    } else if (/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp|avif)$/i.test(ext)) {
      _galleryPending = { kind: 'image', src: await galleryShrinkImage(await galleryReadFile(file, 'url'), file.type), name };
    }
  } catch (e) { _galleryPending = null; }
  if (label) label.textContent = _galleryPending ? name : '这个认不出来，挂图片 / .html / .svg';
}

async function gallerySubmit() {
  if (!_galleryPending) {
    if (typeof showToast === 'function') showToast('先选一张画', 'info', 1600);
    return;
  }
  const authorEl = document.getElementById('galleryAuthor');
  const capEl = document.getElementById('galleryNewCaption');
  const fileEl = document.getElementById('galleryFile');
  const it = await galleryAdd({
    kind: _galleryPending.kind,
    src: _galleryPending.src,
    author: (authorEl && authorEl.value.trim()) || (typeof state !== 'undefined' && state.userName) || '我',
    caption: capEl ? capEl.value : '',
  });
  if (!it) return;
  _galleryPending = null;
  if (capEl) capEl.value = '';
  if (fileEl) fileEl.value = '';
  const label = document.getElementById('galleryFileName');
  if (label) label.textContent = '还没选';
  const add = document.getElementById('galleryAdd');
  if (add) add.open = false;
}
