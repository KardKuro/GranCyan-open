// reader.js — 章节页交互:选文批注/发起讨论、批注气泡(含"聊这条")、共读聊天面板(SSE 流式)。
// 独立静态文件,所有正则和 \n 都只写一层——别把这些塞回服务端模板字面量(防踩坑 #6)。
(function () {
  var CFG = window.__COREAD || {};
  var content = document.getElementById('content');
  var selTxt = '', quote = '', annCtx = null, sheet = null, bar = null;

  // 模型名是用户自己起的（"小克<script>"也不是不可能），拼进 innerHTML 前先转义
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── 底部选文条 ──
  function buildBar() {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '#cr-bar{position:fixed;left:0;right:0;bottom:0;z-index:200;background:var(--bg);border-top:1px solid var(--line);padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 14px);display:none}' +
      '#cr-bar.show{display:block}' +
      '#cr-bar .hint{font-size:12px;color:var(--soft);font-style:italic;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#cr-bar textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--tx);padding:10px;font-size:14px;font-family:inherit;line-height:1.6}' +
      '#cr-bar .btns{display:flex;gap:10px;margin-top:8px}' +
      '#cr-bar button{padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:none;color:var(--soft);font-size:13px;cursor:pointer;font-family:inherit}' +
      '#cr-bar button.save{color:var(--acc);border-color:var(--acc)}' +
      '.cr-bub{position:fixed;z-index:210;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;max-width:300px;box-shadow:0 8px 24px rgba(0,0,0,.15)}' +
      '.cr-bub .who{font-size:11px;color:var(--faint);margin-bottom:4px}' +
      '.cr-bub .txt{font-size:13.5px;line-height:1.7;white-space:pre-wrap}' +
      '.cr-bub .acts{margin-top:8px;text-align:right}' +
      '.cr-bub .acts span{font-size:11px;color:var(--soft);cursor:pointer;margin-left:12px}' +
      '</style>');
    bar = document.createElement('div');
    bar.id = 'cr-bar';
    bar.innerHTML = '<div class="hint"></div><textarea placeholder="写一条批注…"></textarea><div class="btns"><button onclick="this.closest(\'#cr-bar\').classList.remove(\'show\')">取消</button><button class="save" id="cr-save">保存批注</button><button class="save" id="cr-talk">聊这句</button></div>';
    document.body.appendChild(bar);
    document.getElementById('cr-save').onclick = function () {
      var tx = bar.querySelector('textarea').value.trim();
      if (!tx || !selTxt) return;
      fetch('/api/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: CFG.bid, chapter_num: CFG.cnum, original_text: selTxt, annotation: tx }) })
        .then(function () { location.reload(); });
    };
    document.getElementById('cr-talk').onclick = function () { openSheet(selTxt, null); bar.classList.remove('show'); };
  }
  buildBar();

  // 常驻共读浮标:以前只有"选中文字"或"点已有批注"两条路能打开 AI 面板,
  // 手机上选不中字就等于没有共读功能。给个永远在的入口。
  (function buildFab() {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '#cr-fab{position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 20px);z-index:190;' +
      'width:52px;height:52px;border-radius:50%;border:1px solid var(--line);background:var(--acc);color:var(--bg);' +
      'font-size:22px;line-height:1;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)}' +
      '</style>');
    var fab = document.createElement('button');
    fab.id = 'cr-fab';
    fab.type = 'button';
    fab.title = '和 AI 聊这本书';
    fab.textContent = '💬';
    fab.onclick = function () { openSheet('', null); };
    document.body.appendChild(fab);
  })();

  content.addEventListener('mouseup', function () { setTimeout(checkSel, 80); });
  content.addEventListener('touchend', function () { setTimeout(checkSel, 350); });
  // 手机端关键:长按取词会让 WebView 起原生选择模式,触摸流被 touchcancel 掐断,
  // touchend 根本不触发 —— 只靠上面两行的话,手机上批注条永远弹不出来(于是"聊这句"
  // 这个唯一的共读入口也跟着消失)。selectionchange 在原生选择/拖把手时都会稳定触发。
  var selTimer = null;
  document.addEventListener('selectionchange', function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(checkSel, 320);   // 等把手拖停再读,免得每动一下就刷一次
  });

  function checkSel() {
    var s = getSelection();
    var t = (s && s.rangeCount && !s.isCollapsed) ? s.toString().trim() : '';
    var inContent = t && s.anchorNode && content.contains(s.anchorNode);
    if (!t || t.length < 2 || !inContent) {
      // 选区没了就收起批注条——但别打断正在写批注的人
      var ta = bar.querySelector('textarea');
      if (bar.classList.contains('show') && document.activeElement !== ta && !ta.value.trim()) {
        bar.classList.remove('show');
      }
      return;
    }
    if (t === selTxt && bar.classList.contains('show')) return;  // 同一段选区,别重置正在写的字
    selTxt = t;
    bar.querySelector('.hint').textContent = '「' + (t.length > 30 ? t.slice(0, 30) + '…' : t) + '」';
    bar.querySelector('textarea').value = '';
    bar.classList.add('show');
  }

  // ── 批注气泡(点已画线的文字) ──
  document.addEventListener('click', function (e) {
    var old = document.querySelector('.cr-bub');
    if (old && !old.contains(e.target)) old.remove();
    var el = e.target.closest('[data-anns]');
    if (!el) return;
    var anns = JSON.parse(el.dataset.anns);
    var bub = document.createElement('div');
    bub.className = 'cr-bub';
    bub.innerHTML = anns.map(function (a, i) {
      return '<div' + (i ? ' style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"' : '') + '><div class="who">' + (a.w === 'user' ? '读者' : 'AI') + (a.t ? ' · ' + a.t : '') + '</div><div class="txt"></div><div class="acts"><span data-i="' + i + '">聊这条</span></div></div>';
    }).join('');
    bub.querySelectorAll('.txt').forEach(function (d, i) { d.textContent = anns[i].a; });
    bub.querySelectorAll('.acts span').forEach(function (s) {
      s.onclick = function (ev) {
        ev.stopPropagation();
        var a = anns[s.dataset.i | 0];
        bub.remove();
        openSheet(el.textContent || '', { who: a.w, text: a.a });
      };
    });
    document.body.appendChild(bub);
    var rc = el.getBoundingClientRect(), w = Math.min(300, innerWidth - 32);
    bub.style.width = w + 'px';
    bub.style.left = Math.max(16, Math.min(rc.left + rc.width / 2 - w / 2, innerWidth - w - 16)) + 'px';
    bub.style.top = (rc.bottom + 8 + bub.offsetHeight > innerHeight ? rc.top - bub.offsetHeight - 8 : rc.bottom + 8) + 'px';
  });

  // ── 共读聊天面板 ──
  function buildSheet() {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '#cr-sheet{position:fixed;left:0;right:0;bottom:0;z-index:300;background:var(--bg);border-top:1px solid var(--line);border-radius:16px 16px 0 0;transform:translateY(115%);transition:transform .3s;max-height:78vh;display:flex;flex-direction:column;box-shadow:0 -10px 36px rgba(0,0,0,.15)}' +
      '#cr-sheet.show{transform:translateY(0)}' +
      '#cr-sheet .hd{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--acc);align-items:flex-start}' +
      '#cr-sheet .hd .x{margin-left:auto;cursor:pointer;color:var(--faint);font-size:18px;line-height:1}' +
      '#cr-sheet .log{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:130px}' +
      '#cr-sheet .m{max-width:85%;padding:8px 12px;border-radius:12px;font-size:14.5px;line-height:1.6;white-space:pre-wrap}' +
      '#cr-sheet .me{align-self:flex-end;background:var(--acc);color:var(--bg)}' +
      '#cr-sheet .ai{align-self:flex-start;background:var(--card)}' +
      '#cr-sheet .note{align-self:center;font-size:11px;color:var(--faint);font-style:italic}' +
      '#cr-sheet .in{display:flex;gap:8px;padding:10px 14px calc(env(safe-area-inset-bottom,0px) + 12px);border-top:1px solid var(--line)}' +
      '#cr-sheet textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:16px;padding:8px 13px;font-size:14.5px;font-family:inherit;background:var(--card);color:var(--tx)}' +
      '#cr-sheet .send{border:none;background:var(--acc);color:var(--bg);border-radius:50%;width:38px;height:38px;cursor:pointer;font-size:16px}' +
      // 模型选择器不能用原生 <select>：安卓 WebView 把它的下拉弹层交给系统画成一个
      // AlertDialog，那个对话框的皮肤来自 Activity 主题，页面里的 CSS（背景色、
      // option 颜色、color-scheme:dark 全都试过）根本够不着它——弹出来永远是刺眼的白。
      // 所以这里自己画一个下拉：一个按钮 + 一层浮层，全在页面里，想多深有多深。
      '#cr-sheet .mdl{border:1px solid var(--line);background:#1a1a26;color:var(--tx);border-radius:8px;padding:4px 8px;font-size:11.5px;font-family:inherit;max-width:52%;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}' +
      '#cr-mdl-mask{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.5);display:none}' +
      '#cr-mdl-mask.show{display:block}' +
      '#cr-mdl-pop{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(300px,86vw);max-height:64vh;overflow-y:auto;background:#1a1a26;color:var(--tx);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);padding:6px;-webkit-overflow-scrolling:touch}' +
      '#cr-mdl-pop .opt{padding:11px 12px;border-radius:9px;font-size:13.5px;line-height:1.35;cursor:pointer;display:flex;gap:9px;align-items:center}' +
      '#cr-mdl-pop .opt:active{background:rgba(255,255,255,.08)}' +
      '#cr-mdl-pop .opt .dot{width:15px;flex-shrink:0;color:var(--acc)}' +
      '#cr-mdl-pop .opt.on{color:var(--acc)}' +
      '</style>');
    sheet = document.createElement('div');
    sheet.id = 'cr-sheet';
    sheet.innerHTML = '<div class="hd"><span class="q"></span><div class="mdl" title="书架用哪个模型陪读">模型…</div><span class="x">✕</span></div><div class="log"></div><div class="in"><textarea rows="1" placeholder="聊聊这本书…"></textarea><button class="send">↑</button></div>';
    document.body.appendChild(sheet);
    sheet.querySelector('.x').onclick = function () { sheet.classList.remove('show'); };
    sheet.querySelector('.send').onclick = send;
    sheet.querySelector('textarea').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    // 模型选择:选项由服务端给(主程序把 state.configs 推过来存的),选中项也存服务端——
    // 手机和电脑看到的是同一份,换设备不用重选。
    var mdl = sheet.querySelector('.mdl');
    var mdlOpts = [], mdlKey = '';

    var mask = document.createElement('div');
    mask.id = 'cr-mdl-mask';
    mask.innerHTML = '<div id="cr-mdl-pop"></div>';
    document.body.appendChild(mask);
    var pop = mask.querySelector('#cr-mdl-pop');
    mask.onclick = function (e) { if (e.target === mask) mask.classList.remove('show'); };

    function paintMdl() {
      var cur = mdlOpts.filter(function (o) { return o.key === mdlKey; })[0];
      mdl.textContent = (cur ? cur.label : '选模型') + ' ▾';
    }
    function openMdl() {
      if (!mdlOpts.length) return;
      pop.innerHTML = mdlOpts.map(function (o, i) {
        return '<div class="opt' + (o.key === mdlKey ? ' on' : '') + '" data-i="' + i + '">'
          + '<span class="dot">' + (o.key === mdlKey ? '●' : '') + '</span>'
          + '<span>' + esc(o.label) + '</span></div>';
      }).join('');
      mask.classList.add('show');
    }
    pop.onclick = function (e) {
      var row = e.target.closest ? e.target.closest('.opt') : null;
      if (!row) return;
      mdlKey = mdlOpts[+row.dataset.i].key;
      mask.classList.remove('show');
      paintMdl();
      fetch('/api/reading/model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: mdlKey }),
      }).catch(function () {});
    };
    mdl.onclick = openMdl;

    fetch('/api/reading/models').then(function (r) { return r.json(); }).then(function (d) {
      mdlOpts = d.options || [];
      mdlKey = d.selected || (mdlOpts[0] && mdlOpts[0].key) || '';
      paintMdl();
    }).catch(function () {});
    // 讨论历史落库了,开面板先续上——共读是一条连续的河(防踩坑 #7)
    fetch('/api/reading/' + CFG.bid + '/chats').then(function (r) { return r.json(); }).then(function (d) {
      (d.items || []).forEach(function (c) { add(c.who === 'user' ? 'me' : 'ai', c.text); });
    });
  }

  function add(cls, text) {
    var log = sheet.querySelector('.log');
    var el = document.createElement('div');
    el.className = 'm ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function openSheet(sel, ann) {
    quote = sel || '';
    annCtx = ann || null;
    if (!sheet) buildSheet();
    sheet.querySelector('.q').textContent = quote ? '「' + (quote.length > 60 ? quote.slice(0, 60) + '…' : quote) + '」' + (ann ? ' · 聊这条批注' : '') : '聊聊这本书';
    sheet.classList.add('show');
    setTimeout(function () { sheet.querySelector('textarea').focus(); }, 120);
  }

  function send() {
    var ta = sheet.querySelector('textarea');
    var m = ta.value.trim();
    if (!m) return;
    ta.value = '';
    add('me', m);
    var t = add('ai', '…');
    var log = sheet.querySelector('.log');
    var _ann = annCtx; annCtx = null; // 批注上下文只随第一条消息带
    // SSE:fetch + ReadableStream 手工分帧(EventSource 不支持 POST)。
    fetch('/api/reading/' + CFG.bid + '/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ cnum: CFG.cnum, message: m, selection: quote, ann: _ann || undefined }),
    }).then(function (r) {
      var rd = r.body.getReader(), dec = new TextDecoder('utf-8'), buf = '', done = false;
      function pump() {
        return rd.read().then(function (x) {
          if (x.done) { if (!done) t.textContent = '（流断了，再说一遍？）'; return; }
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var fr = buf.slice(0, i); buf = buf.slice(i + 2);
            var em = /^event: (\S+)$/m.exec(fr), dm = /^data: (.*)$/m.exec(fr);
            if (!em || !dm) continue;
            var d; try { d = JSON.parse(dm[1]); } catch (e) { continue; }
            if (em[1] === 'live') {
              t.textContent = (d.t || '').replace(/\n?\[批注[^\]]*\]?\s*$/, ''); // 半截批注标记别闪出来
              log.scrollTop = log.scrollHeight;
            } else if (em[1] === 'final') {
              done = true;
              t.textContent = (d.reply || '').trim() || d.error || '（没接住，再说一遍？）';
              if (d.ann) { var n = document.createElement('div'); n.className = 'note'; n.textContent = '—— AI 在这一页留下了画线批注，刷新可见 ——'; log.appendChild(n); }
              log.scrollTop = log.scrollHeight;
              try { rd.cancel(); } catch (e) {}
              return;
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { t.textContent = '（出错了：' + e.message + '）'; });
  }
})();
