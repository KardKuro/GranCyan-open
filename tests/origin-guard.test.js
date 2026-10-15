// 「这个请求是不是自己人发的」——这道闸守着整个 /api。
//
// 它有两个方向的失败，**两个都要测**：
//   拦不住 → 任何网页都能读走她的对话和记忆、调她登录着的账号（真实存在过，实测复现过）
//   误伤   → 手机版 / Electron 静默连不上，而且报错长得像网络问题，能查半天
// 只测前者的话，一个 `return false` 就能让「安全」那一半全绿。
const path = require('path');
const os = require('node:os');
const { makeOriginGuard, selfAddrs } = require(path.join(__dirname, '..', 'origin-guard.js'));

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const ANDROID = 'https://grancyan.app';
const serverGuard = makeOriginGuard([ANDROID]);   // server.js 用的
const tightGuard = makeOriginGuard([]);           // social-browser.js 用的（更严）
const req = (origin, host) => ({ headers: { origin, host: host || '127.0.0.1:3000' } });

// 这台机器**真实**的一个网卡地址。写死 IP 是不行的：判据要求 Host 真的是本机地址
// （挡 DNS rebinding），写死的换台机器就红。
const lanIp = (() => {
  for (const l of Object.values(os.networkInterfaces() || {})) {
    for (const ni of l || []) if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
})();

// ── 自己人：一个都不能误伤 ────────────────────────────────
console.log('自己人（误伤了就是静默连不上）:');
t('Electron —— loadURL("http://127.0.0.1:PORT/")', serverGuard(req('http://127.0.0.1:3000')) === true);
t('电脑浏览器 localhost', serverGuard(req('http://localhost:3000')) === true);
t('★ 安卓 APK —— 页面挂在 https://grancyan.app 这个虚拟域名下，天生跨源',
  serverGuard(req(ANDROID)) === true);
t('curl / 探针 / 非浏览器客户端（没有 Origin 头）', serverGuard({ headers: {} }) === true);
t('手机隔着局域网连过来（Origin 和 Host 一致、且确实是本机地址）',
  lanIp ? serverGuard(req(`http://${lanIp}:3000`, `${lanIp}:3000`)) === true : true, lanIp);

// ── 外人：一个都不能放进来 ────────────────────────────────
console.log('外人:');
t('恶意网页（https）', serverGuard(req('https://evil.example.com')) === false);
t('恶意网页（http）', serverGuard(req('http://attacker.cn')) === false);
t('把本机地址拼进域名里骗人（127.0.0.1.evil.com）',
  serverGuard(req('http://127.0.0.1.evil.com')) === false);
t('Origin 畸形 → 判死不判活', serverGuard(req('not-a-url')) === false);
t('"null"（sandbox iframe / data: 页面）', serverGuard(req('null')) === false);
t('非 http(s) 协议', serverGuard(req('file://')) === false && serverGuard(req('chrome-extension://abc')) === false);
t('★ DNS rebinding —— Origin 和 Host 都是攻击者的域名，比出来也「一致」',
  serverGuard(req('http://evil.example', 'evil.example')) === false);
t('★ 带端口的同名重绑定', serverGuard(req('http://evil.example:3000', 'evil.example:3000')) === false);
t('Host 是本机、Origin 是外站 → 拒',
  lanIp ? serverGuard(req('https://evil.example.com', `${lanIp}:3000`)) === false : true);
t('局域网 IP 对不上 Host → 拒',
  lanIp ? serverGuard(req('http://192.168.1.99:3000', `${lanIp}:3000`)) === false : true);

// ── 两道闸的松紧不一样，而且是**故意**的 ────────────────────────────────
// server 要放行安卓；浏览器通道后面是一个登录着的浏览器，只服务本机，不给任何外部 origin 开口。
console.log('两道闸的松紧:');
t('★ 安卓那个 origin 进得了 server，进不了浏览器通道',
  serverGuard(req(ANDROID)) === true && tightGuard(req(ANDROID)) === false);
t('本机来源两边都放行', tightGuard(req('http://127.0.0.1:3000')) === true);
t('外站两边都拒', tightGuard(req('https://evil.example.com')) === false);

// ── 本机地址是现取的，不是启动时缓存的 ────────────────────────────────
// 这台机器上网卡一直在动（Tailscale / WSL / VMware 都装了虚拟网卡）。
// 缓存一次的话，切了网就开始误伤，而且是静默的。
console.log('本机地址:');
t('至少认得 loopback', selfAddrs().has('127.0.0.1') && selfAddrs().has('localhost'));
t('拿得到真实网卡地址', lanIp ? selfAddrs().has(String(lanIp).toLowerCase()) : true, lanIp);
t('每次调用都重新取（网卡会热插拔）', (() => {
  const a = selfAddrs(), b = selfAddrs();
  return a !== b && a.size === b.size;     // 不是同一个对象，说明没缓存
})());

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
