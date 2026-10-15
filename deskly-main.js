'use strict';
// 桌面歌词独立悬浮窗：词的显示单独离开 app，放在任何页面最上面，并且能放大缩小。
// 迷你条不做独立窗（系统后台自己有媒体控制）。点歌台把状态经 preload → 这里 → 悬浮窗；
// 悬浮窗是透明无框置顶窗，浮在所有程序上面，位置和大小落在 userData/deskly.json。
//
// 改大小（要求：自由拉缩长宽大小，字也会一起变化）：
// 像普通窗口一样拖四边四角改长宽，字号由窗口高度定、每行再按宽度缩到放得下（见 deskly.js）。
// 边框是页面自己画的把手，不是系统的 resizable——Windows 上透明窗口开 resizable 不可靠，拖边缘没反应。
// 把手按下后页面把算好的新矩形发过来（bounds），这里夹一下最小尺寸和屏幕范围再 setBounds。
//
// 锁定：锁上后整窗鼠标穿透（点得到底下的网页/游戏），只有悬停到那把小锁上才临时接鼠标，好再点开。
// 这是 Electron 文档里的 setIgnoreMouseEvents(true, { forward:true }) 用法：穿透期间鼠标移动照样转发给页面。
//
// 为什么不是「点歌台的 DOM 里再来一层」：那一层只在 GranCyan 窗口里，切到别的程序就看不见了。
// 为什么 focusable:false：悬浮窗不能抢走游戏/文档的键盘焦点（点它的按钮照样能响应）。
// 为什么每个 IPC 都验 sender：preload 暴露的东西页面上任何脚本都能调，只认主窗口和对应悬浮窗自己。
const path = require('path');
const fs = require('fs');

const MIN_W = 240, MIN_H = 56;

function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }

// 点歌台推过来的东西只当数据：截长度、白名单 class，不信任何一个字段。
// 字体名只放字母数字、空格、引号、逗号、连字符和中日文——它要原样塞进 CSS 的 font-family。
function cleanLyric(st) {
  if (!st || typeof st !== 'object') return null;
  if (!st.on) return { on: false };
  // 最多六行：两行一页的普通模式，或副行模式两句一页、每句「主句 + 罗马音 + 翻译」
  // （k 标出副行是哪种，g 标出是这页的第几句——窗口不够高时悬浮窗只留唱到的那一句）
  const rows = (Array.isArray(st.rows) ? st.rows : []).slice(0, 6).map(r => ({
    t: String((r && r.t) || '').slice(0, 300),
    c: r && (r.c === 'cur' || r.c === 'done') ? r.c : '',
    p: Math.max(0, Math.min(100, Number(r && r.p) || 0)),
    k: r && (r.k === 'ro' || r.k === 'tr') ? r.k : '',
    g: r && r.g === 1 ? 1 : 0
  }));
  const accent = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s,.%]+\)$/i.test(String(st.accent || '')) ? String(st.accent) : '';
  const f = String(st.font || '');
  const font = f.length <= 240 && /^[\w\s'",\-぀-ヿ㐀-鿿]+$/.test(f) ? f : '';
  // 「音」「译」按钮：has＝这首有没有（没有就不出按钮），on＝开没开
  const o = st.opts && typeof st.opts === 'object' ? st.opts : {};
  const opts = { hasRo: !!o.hasRo, hasTr: !!o.hasTr, ro: !!o.ro, tr: !!o.tr };
  return { on: true, rows, accent, font, opts };
}
// 页面发来的新矩形：夹最小尺寸、不许整个跑出屏幕（至少留 40px 在某块屏上，能抓回来）
function clampBounds(b, wa) {
  const width = Math.round(Math.max(MIN_W, Math.min(num(b && b.width, 0), wa.width)));
  const height = Math.round(Math.max(MIN_H, Math.min(num(b && b.height, 0), wa.height)));
  const x = Math.round(Math.max(wa.x - width + 40, Math.min(num(b && b.x, wa.x), wa.x + wa.width - 40)));
  const y = Math.round(Math.max(wa.y - 10, Math.min(num(b && b.y, wa.y), wa.y + wa.height - 30)));
  return { x, y, width, height };
}

function setup({ app, ipcMain, BrowserWindow, screen, getMainWindow, dir }) {
  const file = path.join(app.getPath('userData'), 'deskly.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { saved = {}; }
  const wins = [];

  function flush() {
    try { fs.writeFileSync(file, JSON.stringify(saved)); } catch (e) {}
  }

  // 一个悬浮窗 = 一份配置。kind 同时是 IPC 通道前缀（desk-lyric:*）和 deskly.json 里的键。
  function overlay(o) {
    const cfg = saved[o.kind] = saved[o.kind] || {};
    let win = null, last = null, timer = null, locked = !!cfg.locked;
    const ch = n => `${o.kind}:${n}`;

    function persist() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const b = alive() ? win.getBounds() : null;
        if (b) { cfg.x = b.x; cfg.y = b.y; cfg.w = b.width; cfg.h = b.height; }
        cfg.locked = locked;
        delete cfg.scale;   // 旧版（按比例缩放）留下的键
        flush();
      }, 400);
    }
    // 存的位置可能是副屏拔掉之前的：不在任何一块屏上就退回主屏默认位置
    function startBounds() {
      const w = Math.max(MIN_W, num(cfg.w, o.baseW)), h = Math.max(MIN_H, num(cfg.h, o.baseH));
      if (Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
        const wa = screen.getDisplayMatching({ x: cfg.x, y: cfg.y, width: w, height: h }).workArea;
        if (cfg.x + w > wa.x + 40 && cfg.x < wa.x + wa.width - 40 && cfg.y >= wa.y - 10 && cfg.y < wa.y + wa.height - 20)
          return clampBounds({ x: cfg.x, y: cfg.y, width: w, height: h }, wa);
      }
      const wa = screen.getPrimaryDisplay().workArea;
      return clampBounds(Object.assign({ width: w, height: h }, o.defaultPos(wa, Math.min(w, wa.width), h)), wa);
    }
    function applyLock() {
      if (!alive()) return;
      try { win.setIgnoreMouseEvents(locked, locked ? { forward: true } : undefined); } catch (e) {}
      win.webContents.send(ch('lock'), locked);
    }
    function create() {
      const b = startBounds();
      win = new BrowserWindow({
        width: b.width, height: b.height, x: b.x, y: b.y,
        transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: false, show: false, alwaysOnTop: true, backgroundColor: '#00000000',
        title: o.title,
        webPreferences: { preload: path.join(dir, 'deskly-preload.js'), spellcheck: false, devTools: false }
      });
      // 'screen-saver' 级别：盖在全屏的视频/游戏窗口之上，普通 alwaysOnTop 会被它们压住
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setMenuBarVisibility(false);
      win.webContents.on('will-navigate', e => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('moved', persist);
      win.on('closed', () => { win = null; });
      win.loadFile(path.join(dir, o.html), { query: { kind: o.kind } });
    }
    const alive = () => !!(win && !win.isDestroyed());
    const fromDesk = e => alive() && e.sender === win.webContents;
    const fromMain = e => { const m = getMainWindow(); return !!(m && !m.isDestroyed() && e.sender === m.webContents); };
    function hide() { last = null; if (alive() && win.isVisible()) win.hide(); }

    ipcMain.on(ch('push'), (e, st) => {
      if (!fromMain(e)) return;
      const c = o.clean(st);
      if (!c) return;
      if (!c.on) { hide(); return; }
      last = c;
      if (!alive()) { create(); return; }   // 建好后由 ready 补发
      if (!win.isVisible()) win.showInactive();
      win.webContents.send(ch('state'), c);
    });
    ipcMain.on(ch('ready'), e => {
      if (!fromDesk(e)) return;
      applyLock();
      if (last) { win.showInactive(); win.webContents.send(ch('state'), last); }
    });
    // 拖把手改大小：页面按屏幕坐标算好整块矩形发过来
    ipcMain.on(ch('bounds'), (e, b) => {
      if (!fromDesk(e)) return;
      const cur = win.getBounds();
      const wa = screen.getDisplayMatching(cur).workArea;
      win.setBounds(clampBounds(b, wa));
      persist();
    });
    // 锁定/解锁；hit = 锁着时鼠标悬到那把锁上，临时接鼠标（离开再穿透）
    ipcMain.on(ch('lock'), (e, v) => {
      if (!fromDesk(e)) return;
      locked = !!v; applyLock(); persist();
    });
    ipcMain.on(ch('hit'), (e, v) => {
      if (!fromDesk(e) || !locked) return;
      try { win.setIgnoreMouseEvents(!v, v ? undefined : { forward: true }); } catch (err) {}
    });
    if (o.onDeskMsg) ipcMain.on(ch('cmd'), (e, v) => { if (fromDesk(e)) o.onDeskMsg(v); });
    const self = { hide, destroy() { if (alive()) win.destroy(); } };
    wins.push(self);
    return self;
  }

  const toMain = (chan, v) => { const m = getMainWindow(); if (m && !m.isDestroyed()) m.webContents.send(chan, v); };

  const lyricOv = overlay({
    kind: 'desk-lyric', html: 'deskly.html', title: '桌面歌词', baseW: 920, baseH: 128, clean: cleanLyric,
    defaultPos: (wa, w, h) => ({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + wa.height - h - 70) }),
    // 悬浮窗上的 ✕：关掉并让点歌台把「词」开关同步成关
    onDeskMsg: v => {
      if (v === 'close') { lyricOv.hide(); toMain('desk-lyric:closed', 1); }
      else if (v === 'ro' || v === 'tr') toMain('desk-lyric:opt', v);   // 「音」「译」：开关存在点歌台，它改完会重推
    }
  });
  return { destroy() { wins.forEach(w => w.destroy()); } };
}

module.exports = { setup, cleanLyric, clampBounds };
