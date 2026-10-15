'use strict';
// 桌面歌词独立窗的页面脚本。数据全部由点歌台经主进程推过来（deskly-preload.js 暴露的 window.deskly），
// 这里负责：画两行、当前句扫色、按窗口大小排字、拖动/改大小/锁定。所有文字一律走 textContent，不拼 HTML。
//
// 挪位置不用 -webkit-app-region:drag：Windows 上拖拽区会把鼠标事件整块吞掉，悬停判断失灵（工具条和把手时有时无），
// 锁定时的穿透转发也收不到。所以挪和拉都是自己算：按下记屏幕坐标，移动时把新矩形发给主进程 setBounds。
(function () {
  var D = window.deskly;
  var body = document.body, wrap = document.getElementById('wrap'), rows = document.getElementById('rows');
  var key = '', font = '', locked = false;
  var MIN_W = 240, MIN_H = 56;

  // ── 排字：字号由窗口高度定（两行塞满）；太长的那行先按宽度缩，最多缩到 0.6 倍，
  //    再长（比如一句两百字的俄语）就不硬缩成蚂蚁字了：单行、跟着唱到的位置往左滚，两头淡出 ──
  var MIN_FIT = 0.6;
  var availW = 0;
  function availH() {
    var cs = getComputedStyle(wrap);
    return wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  }
  // 一行主句算 1 份高、一行罗马音/翻译算 .62 份，两句一页时第二句前面空的那点算 .18 份
  function unitsOf(list, kOf) {
    var u = 0, g1 = false;
    for (var j = 0; j < list.length; j++) { var k = kOf(list[j]); u += k.sub ? 0.62 : 1; if (k.g1) g1 = true; }
    return u + (g1 ? 0.18 : 0);
  }
  function fsFor(h, units) { return Math.max(10, Math.floor((h - 2) / Math.max(2, units) / 1.3)); }
  // 副行模式两句一页至少要这么大的主句字号，不然宁可一页一句（要求是「画面够大可以自动换 2 行」——
  // 默认那个 128 高的窗口还是一句，往高里拉到放得下才变两句）
  var TWO_MIN_FS = 30;
  function layout() {
    var cs = getComputedStyle(wrap);
    var h = availH();
    availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // 不超过两份（普通两行、或主句+一行副行）时字号和原来一样，
    // 主句 + 罗马音 + 翻译是 2.24 份，整体缩一点塞进同一个窗口，不用她再去拉高
    var units = unitsOf(rows.children, function (d) { return { sub: /\b(ro|tr)\b/.test(d.className), g1: /\bg1\b/.test(d.className) && !/\b(ro|tr)\b/.test(d.className) }; });
    var fs = fsFor(h, units);
    body.style.setProperty('--fs', fs + 'px');
    for (var i = 0; i < rows.children.length; i++) {
      var d = rows.children[i], sp = d.firstChild;
      d.style.setProperty('--fit', '1');
      var need = sp ? sp.getBoundingClientRect().width + 8 : 0;   // + 左右 padding
      var fit = need > availW && need > 0 ? Math.max(MIN_FIT, (availW - 1) / need) : 1;
      d.style.setProperty('--fit', String(fit));
      d._over = Math.max(0, need * fit - availW);                  // 缩到底还多出来的像素
      d.classList.toggle('over', d._over > 0);
      scroll(d);
    }
  }
  // 放不下的那行：把唱到的位置保持在离左边 55% 的地方
  function scroll(d) {
    var sp = d.firstChild; if (!sp) return;
    var off = 0;
    if (d._over > 0) {
      var p = (d._p || 0) / 100, full = d._over + availW;
      off = Math.max(0, Math.min(d._over, p * full - availW * 0.55));
    }
    sp.style.transform = off ? 'translateX(' + (-off).toFixed(1) + 'px)' : '';
  }

  // 点歌台给的副行模式永远是两句（g=0/1）。窗口不够高就只留唱到的那一句（有 .cur 的那组，前奏时是第一句）
  function pick(list) {
    if (!list.some(function (r) { return r.g === 1; })) return list;
    var u = unitsOf(list, function (r) { return { sub: !!r.k, g1: r.g === 1 && !r.k }; });
    if (fsFor(availH(), u) >= TWO_MIN_FS) return list;
    var cur = list.filter(function (r) { return r.c === 'cur'; })[0];
    var g = cur ? cur.g : 0;
    return list.filter(function (r) { return r.g === g; }).map(function (r) { return { t: r.t, c: r.c, p: r.p, k: r.k, g: 0 }; });
  }
  var lastSt = null;
  function render(st) {
    if (!st || !st.rows) return;
    lastSt = st;
    st = { rows: pick(st.rows), accent: st.accent, font: st.font, opts: st.opts };
    if (st.accent) body.style.setProperty('--accent', st.accent);
    // app 那串字体第一位是 Cormorant（Google 字体，要联网），没加载出来时拉丁/俄文会落到宋体的全角字形上，间距巨大。
    // 在它后面垫一个 Georgia：Cormorant 在就用它，不在也是正常的衬线字；中文照旧落到后面的宋体
    if (st.font && st.font !== font) { font = st.font; body.style.fontFamily = font.replace(/^\s*("[^"]*"|'[^']*'|[^,]+)/, '$1, Georgia'); key = ''; }
    var o = st.opts || {};
    optBtn(bro, o.hasRo, o.ro); optBtn(btr, o.hasTr, o.tr);
    body.classList.toggle('sub', !!(o.ro || o.tr));
    var k = st.rows.map(function (r) { return r.c + '|' + (r.k || '') + '|' + (r.g || 0) + '|' + r.t; }).join('\n');
    if (k !== key) {
      key = k;
      rows.textContent = '';
      st.rows.forEach(function (r) {
        var d = document.createElement('div');
        d.className = 'l' + (r.c ? ' ' + r.c : '') + (r.k ? ' ' + r.k : '') + (r.g ? ' g1' : '');
        var sp = document.createElement('span');
        sp.textContent = r.t;
        d.appendChild(sp);
        rows.appendChild(d);
      });
      layout();
    }
    st.rows.forEach(function (r, i) {
      var d = rows.children[i];
      if (!d) return;
      d._p = r.c === 'done' ? 100 : r.p || 0;
      d.style.setProperty('--p', d._p + '%');
      if (d._over > 0) scroll(d);
    });
  }

  // ── 悬停：显出边框、工具条、把手。锁着时窗口是穿透的，靠主进程转发的 mousemove 判断，停 1.5 秒就收 ──
  var hovT = 0;
  function hov() {
    body.classList.add('hov');
    clearTimeout(hovT);
    hovT = setTimeout(function () { if (!dragging) body.classList.remove('hov'); }, locked ? 1500 : 2500);
  }
  document.addEventListener('mousemove', hov);
  document.addEventListener('mouseleave', function () { if (!dragging) { clearTimeout(hovT); body.classList.remove('hov'); } });

  // ── 拖动 / 改大小 ──
  var dragging = false;
  function drag(e, dir) {
    if (locked || e.button !== 0) return;
    e.preventDefault();
    var tgt = e.currentTarget;
    try { tgt.setPointerCapture(e.pointerId); } catch (err) {}
    var s = { sx: e.screenX, sy: e.screenY, x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
    var raf = 0, pend = null;
    dragging = true;
    function move(ev) {
      var dx = ev.screenX - s.sx, dy = ev.screenY - s.sy;
      var x = s.x, y = s.y, w = s.w, h = s.h;
      if (!dir) { x += dx; y += dy; }
      else {
        if (dir.indexOf('e') >= 0) w = s.w + dx;
        if (dir.indexOf('s') >= 0) h = s.h + dy;
        if (dir.indexOf('w') >= 0) { w = s.w - dx; x = s.x + dx; }
        if (dir.indexOf('n') >= 0) { h = s.h - dy; y = s.y + dy; }
        // 拉到最小就停住：被拉的那条边不动，对边也不能跟着跑
        if (w < MIN_W) { if (dir.indexOf('w') >= 0) x -= MIN_W - w; w = MIN_W; }
        if (h < MIN_H) { if (dir.indexOf('n') >= 0) y -= MIN_H - h; h = MIN_H; }
      }
      pend = { x: x, y: y, width: w, height: h };
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; if (pend && D) D.bounds(pend); });
    }
    // 挂在 window 上而不是把手上：拉得快时鼠标会先跑出窗口（窗口要等下一帧才跟上），挂在把手上就收不到了
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false;
      if (pend && D) D.bounds(pend);
      hov();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  wrap.addEventListener('pointerdown', function (e) { drag(e, ''); });
  Array.prototype.forEach.call(document.querySelectorAll('.h'), function (h) {
    h.addEventListener('pointerdown', function (e) { e.stopPropagation(); drag(e, h.getAttribute('data-d')); });
  });
  // 拉高/拉矮可能跨过「两句一页」的门槛：拿最后一份状态重新挑一遍（暂停时点歌台不会再推）
  window.addEventListener('resize', function () { if (lastSt) { key = ''; render(lastSt); } else layout(); });
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', layout);

  // ── 锁定 ──
  var bl = document.getElementById('bl'), blp = document.getElementById('blp');
  function setLocked(v) {
    locked = !!v;
    body.classList.toggle('locked', locked);
    blp.setAttribute('d', locked ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.6-1.8');
    bl.title = locked ? '解锁（能拖动、改大小）' : '锁定（鼠标穿透，点得到下面的东西）';
  }
  bl.addEventListener('click', function () { if (D) D.lock(!locked); });
  // 锁着时整窗穿透，只有悬到锁上才临时接鼠标，好点它
  bl.addEventListener('mouseenter', function () { if (locked && D) D.hit(true); });
  bl.addEventListener('mouseleave', function () { if (locked && D) D.hit(false); });
  document.getElementById('bx').addEventListener('click', function () { if (D) D.close(); });

  // ── 「音」「译」：这首有才出按钮；点了交给点歌台去改开关，它改完会重推一份状态过来 ──
  var bro = document.getElementById('bro'), btr = document.getElementById('btr');
  function optBtn(b, has, on) {
    b.hidden = !has;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = (b === bro ? '罗马音' : '翻译') + '（点一下' + (on ? '收起' : '显示') + '）';
  }
  bro.addEventListener('click', function () { if (D && D.opt) D.opt('ro'); });
  btr.addEventListener('click', function () { if (D && D.opt) D.opt('tr'); });

  if (!D) return;
  D.onState(render);
  D.onLock(setLocked);
  D.ready();
})();
