/* 不是本机发的 /api 请求要带配对码。
 *
 * 来源闸（Origin）只拦得住浏览器：局域网 / tailnet 上随便一台设备拿 curl 不带 Origin
 * 打过来，以前一律放行 —— /api 后面有本地AI的电脑操控（bypassPermissions 跑命令）、
 * 偷看屏幕、全部对话。
 *
 * 上半截：直接喂假 req 给 makePairGate 的中间件（源地址随便造）。
 * 下半截：真起一个 server，用 X-Forwarded-For 把自己伪装成外人（反代头一律当外人，
 *         这也正是 cloudflared 隧道那条路），挨个打路由的各种写法。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePairGate, isLocalReq, selfAddrs } = require('../origin-guard');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeReq({ ip = '192.168.1.50', p = '/api/chats', headers = {}, query = {}, method = 'GET' } = {}) {
  return { socket: { remoteAddress: ip }, path: p, headers, query, method, secure: false };
}
function run(gate, req) {
  const out = { next: false, code: 0, body: null, cookies: [] };
  const res = {
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    type() { return this; },
    send(b) { out.body = b; return this; },
    append(k, v) { if (k === 'Set-Cookie') out.cookies.push(v); return this; },
  };
  gate.middleware(req, res, () => { out.next = true; });
  return out;
}

(async () => {
  const quiet = { warn() { } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pair-'));
  const g = makePairGate({ dir, open: false, log: quiet });
  const tok = g.token();

  console.log('— 中间件');
  t('配对码 10 位、落了盘', tok.length === 10 && fs.readFileSync(path.join(dir, '.pair-token'), 'utf8').trim() === tok);
  t('formatted 是 XXXXX-XXXXX', /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(g.formatted()), g.formatted());
  t('本机 127.0.0.1 不用码', run(g, fakeReq({ ip: '127.0.0.1' })).next);
  t('本机 ::ffff:127.0.0.1 不用码', run(g, fakeReq({ ip: '::ffff:127.0.0.1' })).next);
  t('本机 ::1 不用码', run(g, fakeReq({ ip: '::1' })).next);
  const lanSelf = [...selfAddrs()].find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.') && a !== '0.0.0.0');
  if (lanSelf) t('源地址是本机网卡（' + lanSelf + '）当本机', run(g, fakeReq({ ip: lanSelf })).next);
  t('源地址写成 0.0.0.0 不算本机', !isLocalReq(fakeReq({ ip: '0.0.0.0' })));

  let r = run(g, fakeReq());
  t('局域网设备不带码 → 401 pair', !r.next && r.code === 401 && r.body && r.body.pair === true, JSON.stringify(r));
  r = run(g, fakeReq({ ip: '100.64.1.2', p: '/api/local-claude', method: 'POST' }));
  t('tailnet 设备不带码 POST /api/local-claude → 401', !r.next && r.code === 401);
  r = run(g, fakeReq({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }));
  t('本机转进来但带 X-Forwarded-For → 当外人', !r.next && r.code === 401);
  r = run(g, fakeReq({ ip: '127.0.0.1', headers: { 'cf-connecting-ip': '8.8.8.8' } }));
  t('本机转进来但带 cf-connecting-ip → 当外人', !r.next && r.code === 401);

  for (const p of ['/API/chats', '//api/chats', '/%61pi/chats', '/api/../api/chats', '/reading', '/reading/3/1', '/Reading']) {
    r = run(g, fakeReq({ p }));
    t('路径 ' + p + ' 也拦', !r.next && r.code === 401);
  }
  r = run(g, fakeReq({ p: '/js/01-core.js' }));
  t('静态文件不拦（手机浏览器要能打开页面）', r.next);
  r = run(g, fakeReq({ p: '/reading', headers: { accept: 'text/html,application/xhtml+xml' } }));
  t('整页打开给能填码的页面', !r.next && r.code === 401 && /name="gct"/.test(String(r.body)));

  r = run(g, fakeReq({ headers: { 'x-gc-token': tok } }));
  t('头带对 → 放行', r.next);
  t('头带对 → 种 HttpOnly SameSite=Strict cookie', r.cookies.length === 1 && /^gct=/.test(r.cookies[0]) && /HttpOnly/.test(r.cookies[0]) && /SameSite=Strict/.test(r.cookies[0]), r.cookies[0]);
  r = run(g, fakeReq({ headers: { 'x-gc-token': g.formatted().toLowerCase() } }));
  t('小写 + 横杠照样认', r.next);
  r = run(g, fakeReq({ query: { gct: tok } }));
  t('?gct= 带对 → 放行', r.next && r.cookies.length === 1);
  r = run(g, fakeReq({ headers: { cookie: 'foo=1; gct=' + tok } }));
  t('cookie 带对 → 放行、不重复种', r.next && r.cookies.length === 0);
  r = run(g, fakeReq({ headers: { 'x-gc-token': tok.slice(0, 9) + (tok[9] === 'A' ? 'B' : 'A') } }));
  t('错一位 → 401', !r.next && r.code === 401);
  r = run(g, fakeReq({ headers: { 'x-gc-token': tok + 'A' } }));
  t('多一位 → 401', !r.next && r.code === 401);

  // 限流：同一源地址错 20 次后，带对的也先关门
  const bad = fakeReq({ ip: '192.168.1.66', headers: { 'x-gc-token': 'WRONGWRONG' } });
  for (let i = 0; i < 20; i++) run(g, bad);
  r = run(g, fakeReq({ ip: '192.168.1.66', headers: { 'x-gc-token': tok } }));
  t('错 20 次后同地址被锁（带对也 429）', !r.next && r.code === 429, r.code);
  r = run(g, fakeReq({ ip: '192.168.1.67', headers: { 'x-gc-token': tok } }));
  t('别的地址不受牵连', r.next);

  const g2 = makePairGate({ dir, open: false, log: quiet });
  t('重启读回同一个码', g2.token() === tok);
  fs.writeFileSync(path.join(dir, '.pair-token'), 'short\n');
  const g3 = makePairGate({ dir, open: false, log: quiet });
  t('文件坏了 → 换一个合法的新码', g3.token().length === 10 && g3.token() !== 'SHORT');
  const old = g3.token(); g3.rotate();
  t('rotate 后旧码失效', g3.token() !== old && !run(g3, fakeReq({ headers: { 'x-gc-token': old } })).next);
  const gOpen = makePairGate({ dir, open: true, log: quiet });
  t('GRANCYAN_LAN_OPEN 逃生口', run(gOpen, fakeReq()).next);

  console.log('— 真 server（X-Forwarded-For 冒充外人）');
  const PORT = 3000 + 700 + (process.pid % 400);
  const get = (p, headers = {}, method = 'GET') => new Promise(res => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, rr => {
      let b = ''; rr.setEncoding('utf8'); rr.on('data', d => { if (b.length < 400) b += d; }); rr.on('end', () => res({ code: rr.statusCode, body: b, headers: rr.headers }));
    });
    req.on('error', e => res({ code: 0, body: e.message })); req.end();
  });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, GRANCYAN_PORT: String(PORT), GRANCYAN_PORT_TLS: String(PORT + 1) }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = (await get('/')).code === 200; if (!up) await sleep(500); }
    t('server 起来了', up);
    const X = { 'x-forwarded-for': '192.168.1.50' };
    const tk = await get('/api/pair-token');
    t('本机能看配对码', tk.code === 200 && /^\{"token":"[A-Z2-9]{5}-[A-Z2-9]{5}"\}$/.test(tk.body), tk.body);
    const real = tk.code === 200 ? JSON.parse(tk.body).token : '';
    t('外人看不到配对码', (await get('/api/pair-token', X)).code === 401);
    t('外人 POST 换不了码', (await get('/api/pair-token/rotate', X, 'POST')).code === 401);
    t('外人带码也换不了（只许本机）', (await get('/api/pair-token/rotate', { ...X, 'x-gc-token': real }, 'POST')).code === 403);
    for (const p of ['/api/cloud-chats?limit=1', '/API/cloud-chats', '//api/cloud-chats', '/%61pi/cloud-chats', '/api/../api/cloud-chats', '/api/agent-run/1']) {
      const rr = await get(p, X);
      t('外人 ' + p + ' → 被配对闸挡下', rr.code === 401 && /"pair":true/.test(rr.body), rr.code + ' ' + rr.body.slice(0, 80));
    }
    const ok = await get('/api/pair-check', { ...X, 'x-gc-token': real });
    t('外人带对码 → pair-check 200', ok.code === 200 && /"local":false/.test(ok.body), ok.code + ' ' + ok.body);
    t('带对码种了 cookie', /gct=/.test(String(ok.headers && ok.headers['set-cookie'])));
    t('外人带 cookie → 200', (await get('/api/pair-check', { ...X, cookie: 'gct=' + real.replace('-', '') })).code === 200);
    t('本机 pair-check 报 local', /"local":true/.test((await get('/api/pair-check')).body));
    t('外人打开主页照常（静态不拦）', (await get('/', X)).code === 200);
    t('点文件 /.pair-token 不给', (await get('/.pair-token', X)).code === 404 && (await get('/.pair-token')).code === 404);
    t('本机不带码照常用 /api', (await get('/api/reading/models')).code === 200);
  } finally {
    server.kill();
  }
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
