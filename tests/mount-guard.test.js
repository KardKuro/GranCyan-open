// tests/mount-guard.test.js
// 挂载守护：拆分（docs/server-split-plan.md Phase 0.5 第 2 步）用的基础设施之一。
//
// 守的是什么：源码断言（正则扫 server.js）只能证明"这段代码还在文件里"，
// 证明不了"这段代码真的被 app.use()/挂到路由表上了"。搬块的时候完全可能
// 把函数体搬过去了，却忘了在新文件里重新 require 挂载——源码断言照样全绿，
// 生产环境却是 404。这是黑盒：真起一个 server 进程，真发 HTTP 请求，
// 只看得见"这条路由到底通不通"，看不见代码在哪个文件里。
//
// 跑法：node tests/mount-guard.test.js  （run-tests.js 会自动捡起，因为文件名匹配 *.test.js）
//
// 安全注意（都是真机上踩过的坑，不是空担心）：
//   · NURSERY_HOME / ENGAWA_BIN 必须指到不存在的路径 —— 否则
//     doctor 自检会顺手把引擎子进程拉起来，测试套件每跑一次就在用户机器上
//     多放一堆常驻进程。手动探测已确认：这两个 env 指到不存在路径时，
//     xxxInstalled() 提前返回 false，doctor 只打一条 warn，不会 spawn 任何东西。
//   · GRANCYAN_PORT 和 GRANCYAN_PORT_TLS 都要显式指到空闲高位端口 —— 不设
//     GRANCYAN_PORT_TLS 的话 listenDual 会用默认值 3443（server.js 5314 行），
//     虽然端口占用时 _onListenErr 只是打日志不会崩，但既然任务明确说了
//     "别动 3000/3443"，就不给它留触碰的机会。
//   · 用 127.0.0.1 探活，不用 localhost（localhost 走 ::1 会被 wslrelay 截胡，
//     返回空回复，看着像 server 没起来）。
//   · 收尾用 taskkill /PID <pid> /T /F 杀整棵进程树，且包在 finally 里兜底。
//
// GUARDED_ROUTES 挑路由的原则（手动 curl 探测踩过的坑，写在这免得下次重踩）：
//   最早想拿一条转发给本机常驻引擎的路由当练手路由，手动一测才发现那条指令
//   会直接写进真实存档。换成了不碰任何外部服务、
//   不产生任何副作用的 /api/brain-snapshot：两个校验分支（consumer 格式、
//   memories 必须是数组）都在 fs.mkdirSync/writeFileSync 之前 return，纯内存校验。
//
//   "缺参不能是 404" 这条判定标准在 /api/brain-snapshot 上是天然成立的（两个校验
//   分支都是 400，不会退化成业务性的 404），不需要额外挑 body 来避开歧义。
//   而"body 真被解析了"这条，靠对比两次请求的错误文案证明：
//     · {}                                    -> 400 "consumer 缺失或不合法"
//     · {consumer: 合法值, memories: 非数组}   -> 400 "memories 必须是数组"
//   第二条只有在 req.body.consumer 真被读到、且通过了格式校验后才会往下走到
//   memories 校验——如果 body 没解析（req.body 是 undefined），两次请求会
//   拿到一模一样的第一条错误，那正是"body 没解析"的形态。

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_NURSERY   = path.join(ROOT, '__mount_guard_no_such_nursery__');
const FAKE_ENGAWA    = path.join(ROOT, '__mount_guard_no_such_engawa__', 'bin.exe');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name, extra !== undefined ? extra : ''); }
};

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
        resolve({ status: res.statusCode, body, raw });
      });
    });
    // Codex 二轮阻断 #2：不设超时的话，TCP 通了但响应不结束会让整套测试永久卡死，
    // finally 永远到不了，测试 server 残留。
    req.setTimeout(8000, () => req.destroy(new Error(`${method} ${urlPath} 超时(8s)`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForPort(port, isDead, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (isDead && isDead()) return false;   // server 已经死了就别傻等满 45 秒
    try {
      await httpJson(port, 'GET', '/');
      return true;
    } catch (_) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// 每条 = {name, method, path, body?, check(result) -> {ok, detail}}
const GUARDED_ROUTES = [
  {
    // 原本用 /api/ratelimit 练手，但它每次都真打 api.anthropic.com（读凭据+外网），
    // 测试套件不许依赖外网 —— 换成纯读本地文件夹的表情包列表。
    name: 'GET /api/stickers 挂上了',
    method: 'GET', path: '/api/stickers',
    check: r => ({
      ok: r.status !== 404,
      detail: `status=${r.status} body=${r.raw.slice(0, 200)}`,
    }),
  },
  {
    name: 'POST /api/brain-snapshot 挂上了，且 req.body 真被解析',
    method: 'POST', path: '/api/brain-snapshot',
    body: { consumer: 'mount-guard-probe', memories: 'not-an-array' },
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && r.body.error === 'memories 必须是数组';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 "memories 必须是数组"（证明 consumer 校验先过了、body 真解析了），
      实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 点歌（server/music.js，docs/server-split-plan.md Phase 1 第一块）：缺 q
    // 在 server/music.js 里是 `if (!q) return res.status(400).json({ error: '缺少 q' });`，
    // 这一行排在 neteaseSearch(q, limit) 调用之前，所以走这个分支绝不会打网易云的网。
    name: 'GET /api/music/search 挂上了，缺 q 走真校验分支（不会打外网）',
    method: 'GET', path: '/api/music/search',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && r.body.error === '缺少 q';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 "缺少 q"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 整首听歌（server/music-profile.js）：id 不是纯数字在 handler 第一行就 400，
    // 排在读盘、拿网易云地址、调 Gemini 之前——不摸文件、不打外网、不花额度。
    // 顺带证明 req.body 真被解析了（id 是从 body 里读的）。
    name: 'POST /api/music/profile 挂上了，坏 id 走真校验分支（不打外网）',
    method: 'POST', path: '/api/music/profile',
    body: { id: '../etc' },
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && r.body.error === 'id 不合法';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 "id 不合法"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 音标（server/ipa.js，docs/server-split-plan.md Phase 1 第二块）：缺 word
    // 在 server/ipa.js 里是 `if (!form) return res.json({ ok:false, ipa:'', reason:'empty' });`，
    // 这一行排在 ipaCache()（会摸缓存文件）和 fetchIpaEn/fetchIpaDe（打外网）之前，
    // 所以走这个分支既不会碰文件也不会打外网。
    name: 'GET /api/ipa 挂上了，缺 word 走真校验分支（不摸缓存文件、不打外网）',
    method: 'GET', path: '/api/ipa',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 200 && r.body && r.body.ok === false && r.body.reason === 'empty';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 200 {ok:false, reason:'empty'}，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 视频抽帧(N)（server/media.js，docs/server-split-plan.md Phase 1 第四块）：
    // 在 server/media.js 里是 `if (!req.body || !req.body.length) return res.status(400)...`，
    // 是 handler 的第一行，排在 fs.mkdtempSync（第一次摸文件系统）和 spawn('ffmpeg', …)
    // 之前——这条路由本身不打外网，"先于文件"就是它能给到的最干净的分支。
    name: 'POST /api/video-frames 挂上了，空 body 走真校验分支（不摸临时目录、不起 ffmpeg）',
    method: 'POST', path: '/api/video-frames',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && r.body.error === '没收到视频数据';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 "没收到视频数据"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 表情存图/图片代理(O)（server/media.js，同一块）：在 server/media.js 里是
    // `if (!gifUrl || !name) return res.status(400).json({ ok:false });`，排在
    // fs.existsSync(saveDir)（第一次摸文件系统）和 fetchRemoteBuffer（打外网）之前。
    name: 'POST /api/sticker-save-url 挂上了，缺参数走真校验分支（不摸文件、不打外网）',
    method: 'POST', path: '/api/sticker-save-url',
    body: {},
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && r.body.ok === false;
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 {ok:false}，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 云对话中转(I)（server/cloud.js，docs/server-split-plan.md Phase 1 收尾块）：
    // 在 server/cloud.js 里是 `if (!auth || !apikey) return res.status(401)...`，
    // 是 handler 第一行，排在 axios.get/post（打 Supabase）之前。
    name: 'GET /api/cloud-chats 挂上了，缺 auth/apikey 走真校验分支（不打 Supabase）',
    method: 'GET', path: '/api/cloud-chats',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 401 && r.body && r.body.error === '缺少 Authorization / apikey';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 401 "缺少 Authorization / apikey"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 同一块，云设置(profiles)中转：guard 形状跟 cloud-chats 一样。
    name: 'GET /api/cloud-profile 挂上了，缺 auth/apikey 走真校验分支（不打 Supabase）',
    method: 'GET', path: '/api/cloud-profile',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 401 && r.body && r.body.error === '缺少 Authorization / apikey';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 401 "缺少 Authorization / apikey"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 同一块，云文件中转：多一道 path 校验，但缺 auth/apikey 排在它前面，
    // 一样先于网络（也先于 path 正则）。
    name: 'GET /api/cloud-file 挂上了，缺 auth/apikey 走真校验分支（不打 Supabase）',
    method: 'GET', path: '/api/cloud-file',
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 401 && r.body && r.body.error === '缺少 Authorization / apikey';
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 401 "缺少 Authorization / apikey"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  {
    // 自主心跳的 server 半边（server/heartbeat.js，2026-10-03）：坏的 ntfy 地址
    // 在 setConfig 里是第一道校验，排在 save()（第一次写文件）之前，也不推任何东西。
    // 400 且错误文案是地址那句 = body 真被解析了（没解析的话 ntfyUrl 是 undefined，走不进这个分支，回 200）。
    name: 'POST /api/heartbeat/config 挂上了，坏地址走真校验分支（不写文件、不推送）',
    method: 'POST', path: '/api/heartbeat/config',
    body: { ntfyUrl: 'not-a-url' },
    check: r => {
      if (r.status === 404) return { ok: false, detail: `404 —— 没挂上 (${r.raw.slice(0, 200)})` };
      const gotRightBranch = r.status === 400 && r.body && /ntfy 地址要长成/.test(r.body.error || '');
      return {
        ok: gotRightBranch,
        detail: gotRightBranch ? undefined
          : `期望 400 "ntfy 地址要长成…"，实得 status=${r.status} body=${r.raw.slice(0, 200)}`,
      };
    },
  },
  // ⚠️ 手环（server/band.js，Phase 1 第 3 块）故意没有加进这个数组——不是漏了。
  // （现在没设 GRANCYAN_BAND_DB_REMOTE 时路由开头就回 not-configured、不碰 adb，
  //  由 tests/server-fixes.test.js [I] 和 tests/band-optin.test.js 守着；下面是当初不加的理由。）
  // 当时 /api/band-data 在冷启动的测试 server 上没有任何"先于 adb"的分支：唯一的早退
  // （冷却期内直接用缓存）要求 bandCache.data 已经非空，而这是 mount() 私有闭包变量，
  // 探针没法预置。也就是说**任何**一次真实 HTTP 命中——哪怕只是想验证"没 404"——
  // 都会先跑到 adbDeviceState()。装了 adb 的机器上 ADB_EXE
  // 是真实存在的，adbDeviceState() 会真的 spawn 一次 `adb devices`；万一手机当下
  // 恰好插着且已授权，pullBandData 还会继续往下跑 `adb pull` 把真实 Gadgetbridge.db
  // 写进项目根目录——跟这份文件开头注释里记录的"练手路由差点打进用户真实
  // 存档"是同一类风险（真机/真文件副作用，不是 404 检测能安全换来的）。
  // 所以这条先跳过：doctor 注册制那部分已经用不发真实请求的方式单独验过
  // （mount() 本身只是 Map.set + app.get 注册，不碰硬件；见搬迁报告里的核对记录）。
];

async function main() {
  const port = await pickFreePort();
  // Codex 二轮建议 #3：两次 listen(0) 可能抓到同一个端口（HTTP 起来了、TLS 静默
  // EADDRINUSE，server 半启动但探针照样全绿）——至少保证两个不同。
  let portTls = await pickFreePort();
  while (portTls === port) portTls = await pickFreePort();

  console.log(`[mount-guard] 起测试用 server：端口 ${port}（TLS 槽位 ${portTls}，同样不是 3000/3443）`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GRANCYAN_PORT: String(port),
      GRANCYAN_PORT_TLS: String(portTls),
      NURSERY_HOME: FAKE_NURSERY,
      ENGAWA_BIN: FAKE_ENGAWA,
      // 心跳推送的状态文件指到临时目录：测试 server 不读也不写她真实的开关和 ntfy 地址
      GRANCYAN_HEARTBEAT_DIR: path.join(require('os').tmpdir(), 'gc-mount-guard-heartbeat'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });

  // Codex 二轮阻断 #1：child 退出后 PID 会被 Windows 回收再分配，
  // 这时再 taskkill /T /F 打的是那个 PID 的**新主人**——强杀无辜进程树。
  // 所以必须记录退出状态，只在确认还活着时才杀。
  let childExited = false;
  child.on('exit', () => { childExited = true; });

  const killChild = () => {
    if (childExited || child.pid == null) return;
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) { /* 进程可能已经没了，忽略 */ }
  };

  try {
    const up = await waitForPort(port, () => childExited);
    if (!up) {
      console.error('[mount-guard] server 起不来，最后的输出：\n' + out.slice(-3000));
      fail++;
      return;
    }

    for (const route of GUARDED_ROUTES) {
      const r = await httpJson(port, route.method, route.path, route.body);
      const { ok, detail } = route.check(r);
      t(route.name, ok, detail);
    }

    // band 没有可安全探测的 HTTP 分支（见上面 GUARDED_ROUTES 结尾注释），改守 doctor 输出：
    // server.js 里 runDoctor 的异常被 try/catch 吞掉只 warn（"自检异常（不影响启动）"），
    // 所以忘挂 band.mount 不会崩——症状是 getDoctorCheck('band') 拿到 undefined、
    // runDoctor 中途 TypeError、整段自检输出消失。这里断言自检真的打印完整、band 行在场
    // （band 的 doctor 检查只是 existsSync，不 spawn adb，冷启动时安全）。
    t('doctor 自检完整跑完，band 检查在输出里（守「忘挂载→自检静默消失」）',
      out.includes('=== Grancyan server 启动自检 ===')
        && (out.includes('手环数据未启用') || out.includes('手环数据链路可用') || out.includes('手环数据拉不了')),
      '子进程输出尾部：' + out.slice(-800));
  } finally {
    killChild();
    // 给 taskkill 一点时间真正把端口收回去，避免下一条测试/下一次跑撞上 TIME_WAIT 之外的残留
    await new Promise(r => setTimeout(r, 300));
  }
}

main()
  .catch(e => { console.error('[mount-guard] 异常：', e); fail++; })
  .then(() => {
    console.log(`\n[mount-guard] ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  });
