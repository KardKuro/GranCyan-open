// Grancyan 桌面壳：内嵌 server.js（端口 3000）+ Chromium 窗口
// 打包后若电脑上存在开发目录，则数据根指回它（见 findDevRoot），
// 与浏览器/手机共用同一份 index.html、stickers/、Gadgetbridge.db。
const { app, BrowserWindow, shell, Menu, ipcMain, screen } = require('electron');
let deskOverlays = null;   // 桌面歌词 / 迷你播放条的独立悬浮窗（deskly-main.js）
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const PORT = 3000;
let mainWindow = null;

// 测量/调试用的一次性存档：GRANCYAN_USER_DATA 指一个空目录，exe 就不碰真实的 userData。
// 拿真实 userData 反复冷启动又强杀，IndexedDB 会被 Chromium 判坏、删库重建，只存本机的数据全丢。
// 反复启动 / taskkill /F 的测量脚本一律设这个变量，指向一次性空目录。
// 必须在 requestSingleInstanceLock 之前：单实例锁也是按 userData 算的。
if (process.env.GRANCYAN_USER_DATA) app.setPath('userData', path.resolve(process.env.GRANCYAN_USER_DATA));

// IndexedDB 的 LevelDB 后端不能由两个独立 Electron 主进程同时打开。
// 任务栏图标被重复点击时，只唤醒已有窗口；否则第二个实例会共用 userData，
// 页面得到含糊的 `UnknownError: Internal error`，看起来像数据库损坏。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function isExternalHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== '127.0.0.1'
      && url.hostname !== 'localhost';
  } catch (_) {
    return false;
  }
}

// 数据根目录：exe 必须指回项目目录，才能和浏览器/手机共用同一份 HTML、stickers/、
// 并且有个**可写**的地方放 adb 拉下来的 Gadgetbridge.db。
// 以前这里写死过一个带版本号的绝对路径，项目一搬家就永远匹配不上：
// GRANCYAN_ROOT 没设 → server.js 里 ROOT 退化成 asar 包内路径 → adb pull 写不进只读的 asar
// → 手环数据永远"暂无"。现在从 exe 自身位置往上找，找不到再扫 GRANCYAN_DEV_PARENTS 列的目录。
// 认门牌：package.json 的 name 是 grancyan，且 index.html 在旁边。
// 不用文件名当标识是有原因的——以前 marker 写死 'Grancyan2.1.html'，版本号一升
// 文件名就变，四处引用漏一处 exe 直接白屏。package.json 的 name 不随版本变。
// 光看 index.html 又不够独特（满世界都是），所以两个条件一起。
// 先看 index.html——它在，就说明这个目录**很可能**就是项目根。此时 package.json
// 读不动或解析不了，必须喊出来：这正是最危险的那种失败（门牌读坏 → 判定"不是项目根"
// → DEV_ROOT=null → ROOT 退化成只读 asar → 手环/表情/育儿室存档全静默失效）。
// 反过来 index.html 不在，那就是普通的"不是这个目录"，安静返回即可。
function isProjectRoot(dir) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) return false;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    // JSON.parse('null') 不抛异常，直接返回 null；不在这儿拦住的话，下面读 .name
    // 会在 try 外面抛 TypeError。findDevRoot 是模块顶层执行的，那等于 exe 起不来。
    if (!pkg || typeof pkg !== 'object') throw new Error('package.json 不是一个对象');
  } catch (e) {
    console.warn(`⚠ ${dir} 有 index.html 但 package.json 读不动（${e.message}），`
      + '不认它作项目根。如果这就是项目目录，写文件的功能会全部失效——先修 package.json。');
    return false;
  }
  return pkg.name === 'grancyan';
}

function findDevRoot() {
  // 打包后 __dirname 在 …\dist\Grancyan-win32-x64\resources\app.asar，项目根在上面 4 层；
  // 开发态直接就是项目根。逐层往上找，谁先像项目根就是谁。
  // 注意必须跳过 .asar：package.json 和 index.html 本身都被打进了包，而 Electron 给 fs
  // 打过 asar 补丁，不跳的话第一轮就在 app.asar 里命中，ROOT 直接指向只读包内路径——
  // 手环/表情/育儿室存档等一切要写文件的功能全落进去（育儿室会因此和浏览器各养一个孩子）。
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (!dir.includes('.asar') && isProjectRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 兜底：exe 被拷到项目外时，上面那圈往上找会全部落空。此时去环境变量
  // GRANCYAN_DEV_PARENTS（分号分隔的若干父目录，比如放项目的那个文件夹）里翻一遍。
  // 这里刻意**不写死版本号**——写死的话目录一改名就成了死路径，
  // 而且失败得毫无声响（返回 null → ROOT 退化成只读 asar → 写文件的功能全废）。
  // 改成扫父目录下的 GranCyan* 子目录，谁通过 isProjectRoot 就是谁；认的还是 package.json 的 name。
  const parents = String(process.env.GRANCYAN_DEV_PARENTS || '').split(';').map(s => s.trim()).filter(Boolean);
  for (const base of parents) {
    let names;
    try {
      names = fs.readdirSync(base);
    } catch (e) {
      continue; // 这个盘/目录不在这台机器上，正常
    }
    // 排序是为了结果稳定：多份并存时固定挑同一个，而不是看目录项返回顺序。
    // 倒序 → GranCyan2.2 排在 GranCyan2.1 前面，优先命中新版本。
    for (const name of names.filter(n => /^GranCyan/i.test(n)).sort().reverse()) {
      const cand = path.join(base, name);
      if (isProjectRoot(cand)) return cand;
    }
  }
  return null;
}
const DEV_ROOT = findDevRoot();

// 只回答「端口上有没有人应答」。**不要用它判断该不该起自己的服务器**——
// 见下面 serverAlive 的注释。
function portInUse(port) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(600);
    s.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

// 探活：对面确实是 GranCyan 才算数。
//
// 光 TCP 连得上远远不够：wslrelay 和 Docker Desktop 也会占着 3000，而且
// Docker 那个 :::3000 是 dual-stack，把 IPv4 的连接一起接了 —— connect 立刻
// 成功、一发 HTTP 请求却是空回复。于是 exe 判定「端口 3000 已有服务器，直接
// 使用」，不启动内嵌 server，loadURL 拿到空回复，**窗口全黑**；更糟的是看门狗
// 查的也是 portInUse，Docker 一直在那儿，它永远认为服务器还活着，永远不接管。
//
// 实际出过这种全黑：手动跑的 node server 一关，
// 就露出了底下的 Docker。上一版看门狗防的是「外部 server 死了」，防不住
// 「端口上蹲着个根本不是 GranCyan 的东西」——这是同一个坑的另一半。
function serverAlive(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish(false); }
      let buf = '';
      res.on('data', d => {
        buf += d;
        // 认出来就立刻收工，不用把整页 100KB 读完
        if (/Grancyan/i.test(buf)) { res.destroy(); finish(true); }
        else if (buf.length > 65536) { res.destroy(); finish(false); }
      });
      res.on('end', () => finish(/Grancyan/i.test(buf)));
      res.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 内嵌服务器只能起一次（require 有模块缓存），起没起过要记着——
// 看门狗判断"还能不能自救"全靠这个标志。
let ownServer = false;

function startOwnServer() {
  if (ownServer) return;
  if (!process.env.GRANCYAN_ROOT && DEV_ROOT) {
    process.env.GRANCYAN_ROOT = DEV_ROOT;
    console.log('数据根目录 ->', DEV_ROOT);
  } else if (!process.env.GRANCYAN_ROOT) {
    console.warn('⚠ 找不到项目目录（package.json name=grancyan + index.html），手环/表情等需要写文件的功能会不可用');
  }
  require('./server.js');
  ownServer = true;
}

// 等端口起来。coread 是异步初始化的，listen 会晚一点，所以给足时间。
async function waitPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await serverAlive(PORT)) {
      await sleep(500);   // 页面出得来了再等 500ms，确保路由都挂完
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function ensureServer() {
  // start.bat 已经开着服务器就直接连它，不重复占端口
  // 判断标准是「对面是不是 GranCyan」，不是「端口有没有人」：
  // 端口被 Docker / wslrelay 占着时必须自己起，否则窗口全黑（见 serverAlive）
  if (await serverAlive(PORT)) { console.log('端口 3000 上已有 GranCyan 服务器，直接使用'); return; }
  startOwnServer();
  if (!await waitPort(10000)) console.error('服务器启动超时');
}

// 「蹭端口不自愈」的坑：exe 启动时若外面已有 server 就直接用它，可那个 server 一旦
// 退出，窗口就永远指着空端口——整页 ERR_CONNECTION_REFUSED，刷新也救不回来，
// 看起来就像 exe 自己坏了。2026-07-21 踩过一次。这里守着端口，掉了就自己顶上再重载。
function watchServer(win) {
  let healing = false;
  const timer = setInterval(async () => {
    // 已经是自己起的服务器还挂了，那是 server 进程级的问题，这儿救不了
    if (healing || ownServer || win.isDestroyed()) return;
    if (await serverAlive(PORT)) return;
    healing = true;
    try {
      console.warn(`端口 ${PORT} 上的服务器没了 —— 启动内嵌服务器接管`);
      startOwnServer();
      if (await waitPort(15000)) { if (!win.isDestroyed()) win.reload(); }
      else console.error('接管失败：内嵌服务器起不来');
    } catch (e) {
      console.error('接管失败:', e && e.message);
    } finally { healing = false; }
  }, 5000);
  timer.unref?.();
  win.on('closed', () => clearInterval(timer));
}


async function createWindow() {
  await ensureServer();
  const win = new BrowserWindow({
    width: 1360, height: 880,
    minWidth: 480, minHeight: 600,
    title: 'Grancyan',
    icon: path.join(__dirname, 'grancyan.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#09090f',
    webPreferences: {
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: true,
      // 见 preload.js：只为「拖进来的文件 → 绝对路径」这一件事而存在。
      // contextIsolation / sandbox / nodeIntegration 全部保持默认（true / true / false），
      // 这里**不要**为了方便去动它们，preload 用不着。
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    // 悬浮窗隐藏着也算窗口，不关的话 window-all-closed 永远不来、exe 关不掉
    if (deskOverlays) deskOverlays.destroy();
  });

  // 开发者工具：**默认不开**。
  // 以前这里是无条件 openDevTools()，打包给日常用的 exe 也一样开着，代价是隐形的：
  // ① DevTools 是独立 renderer，空转就占 ~260MB（页面自己的 JS 堆才 36MB）；
  // ② Console 面板持有每条日志的**对象引用**，那些对象永远 GC 不掉 —— 实测灌 3000 条
  //    带 2KB 载荷的日志，renderer 单调涨 29MB 且不回落。GranCyan 后台 tick 一直在打日志，
  //    所以开得越久越沉，症状就是「用着用着就未响应」，而且挂着不动也会发生；
  // ③ Network 面板保留每个请求的完整响应体，聊天是 SSE 长流，一天下来全在内存里。
  // 要看日志的时候：设 GRANCYAN_DEVTOOLS=1 启动，或者窗口里按 F12 / Ctrl+Shift+I。
  if (process.env.GRANCYAN_DEVTOOLS === '1') win.webContents.openDevTools();
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const f12 = input.key === 'F12';
    const ctrlShiftI = input.control && input.shift && String(input.key).toLowerCase() === 'i';
    if (f12 || ctrlShiftI) { win.webContents.toggleDevTools(); event.preventDefault(); }
  });

  // 设置 CSP 允许本地服务器和内联样式
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://localhost:3000 http://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:3000 https: http:; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http://localhost:3000 http://127.0.0.1:3000 https: http:; " +
          "worker-src 'self' blob: http://localhost:3000 http://127.0.0.1:3000; " +   // 启动页的 Worker 用 Blob 起（index.html），不跟开机 80 个脚本抢连接
          "style-src 'self' 'unsafe-inline' http://localhost:3000 http://127.0.0.1:3000 https: http:; " +
          "img-src 'self' data: blob: http://localhost:3000 http://127.0.0.1:3000 https: http:; " +
          "connect-src 'self' http://localhost:3000 http://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:3000 https: http: wss:; " +
          "font-src 'self' data: https: http:; " +
          "media-src 'self' blob: https: http:;"
        ]
      }
    });
  });
  win.setMenuBarVisibility(false);
  // 菜单栏隐藏后编辑快捷键（Ctrl+C/V/X/A/Z）会失效，挂一个不可见的应用菜单把 role 补回来
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'selectAll' }, { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }
    ]}
  ]));
  // 输入框/选中文本的右键菜单（剪切/复制/粘贴/全选）
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  // Markdown 文献链接默认在当前页导航，不会触发 setWindowOpenHandler。
  // 拦住这条路径，否则论文站会被塞进 Electron 窗口，既丢掉聊天页，也常被站点以 403 拒绝。
  win.webContents.on('will-navigate', (event, url) => {
    // 往窗口里拖一个文件，Chromium 的默认动作是**导航到那个文件**。
    // 走到这里的 url 形如 file:///D:/xxx.png，protocol 不是 http(s)，
    // 所以下面那条 isExternalHttpUrl 判定会放它过去 —— 结果是聊天页被整个换掉，
    // 未保存的输入和滚动位置全没，还得重开 exe。渲染进程那边已经在 document 上
    // preventDefault 挡了一道（见 js/01-core.js 的拖放兜底），这里是第二道：
    // **任何一处忘了 preventDefault 都不该赔上整个页面**，而拖放遍布聊天/工作台/终端，
    // 单靠「每个 drop 处理器都记得挡」是迟早会漏的。
    // 这个窗口只可能停在 http://127.0.0.1:PORT/，正常路径下永远不会导航到 file:。
    if (url.startsWith('file:')) { event.preventDefault(); return; }
    if (!isExternalHttpUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  // 独立悬浮窗（桌面歌词 / 迷你播放条）：只注册一次，主窗口重开也复用
  if (!deskOverlays) {
    try {
      deskOverlays = require('./deskly-main').setup({ app, ipcMain, BrowserWindow, screen, getMainWindow: () => mainWindow, dir: __dirname });
    } catch (e) { console.error('[桌面歌词] 悬浮窗初始化失败：', e && e.message); }
  }
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  watchServer(win);
}

// Windows 的系统媒体浮层顶上写着「未知应用」：那一行是 Windows 按「应用 ID」查出来的名字，
// 而解包运行的 exe 没有应用 ID，也没有开始菜单快捷方式，Windows 查无此人。
// 所以：进程设一个固定的应用 ID，开始菜单放一个带同样 ID 的快捷方式（名字和图标从这里来）。
// ⚠️ 任务栏上钉着的那个快捷方式也要同步写上这个 ID——不然 Windows 把运行中的窗口（有 ID）和钉住的图标（没 ID）
// 当成两个程序，任务栏上会多出一个图标。只动「指向的就是这个 exe」的快捷方式，别人的不碰。
// 只在打包后的 exe 里做：开发时 process.execPath 是 node_modules 里的 electron.exe，不能拿它建快捷方式。
const APP_ID = 'com.grancyan.app';
function ensureWinIdentity() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try { app.setAppUserModelId(APP_ID); } catch (e) {}
  const exe = process.execPath;
  const same = p => { try { return path.resolve(p).toLowerCase() === exe.toLowerCase(); } catch (e) { return false; } };
  const opts = { target: exe, cwd: path.dirname(exe), icon: exe, iconIndex: 0, appUserModelId: APP_ID, description: 'GranCyan · AI 小窝' };
  const appData = app.getPath('appData');
  const startLnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GranCyan.lnk');
  try {
    let cur = null;
    try { cur = fs.existsSync(startLnk) ? shell.readShortcutLink(startLnk) : null; } catch (e) { cur = null; }
    if (!cur || !same(cur.target) || cur.appUserModelId !== APP_ID) shell.writeShortcutLink(startLnk, cur ? 'replace' : 'create', opts);
  } catch (e) { console.warn('[应用 ID] 开始菜单快捷方式没写成:', e.message); }
  const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  try {
    for (const f of fs.readdirSync(pinned)) {
      if (!/\.lnk$/i.test(f)) continue;
      const p = path.join(pinned, f);
      try {
        const l = shell.readShortcutLink(p);
        if (same(l.target) && l.appUserModelId !== APP_ID) shell.writeShortcutLink(p, 'update', { appUserModelId: APP_ID });
      } catch (e) {}
    }
  } catch (e) {}
}

if (hasSingleInstanceLock) app.whenReady().then(() => { ensureWinIdentity(); return createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
