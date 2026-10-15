/* 静态服务不许把私钥、数据库、日志吐给局域网 / tailnet。
 *
 * server 以前 `app.use(express.static(ROOT))` 挂整个项目根，又绑 0.0.0.0：
 * 同一 WiFi 或 tailnet 上的设备 GET /key.pem 就拿到 TLS 私钥，/coread.db 里有书架模型的 key，
 * /Gadgetbridge.db 是健康数据，/local-claude.log 有对话原话。
 *
 * 真起一个 server（另起端口），用原始路径（不经 URL 规范化）挨个打。
 * 绕法都是实测过会中的：`/api/../key.pem`（静态服务自己消解 ..，豁免 /api/ 被一句 .. 绕过）、
 * Windows 的尾点 / 尾空格 / ::$DATA、大小写、%2e。对照组：前端真要的文件必须还是 200。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3000 + 200 + (process.pid % 500);
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(rawPath) {
  return new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, r => {
      let b = ''; r.setEncoding('latin1'); r.on('data', d => { if (b.length < 200) b += d; }); r.on('end', () => res({ code: r.statusCode, body: b }));
    });
    req.on('error', e => res({ code: 0, body: e.message }));
    req.end();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, GRANCYAN_PORT: String(PORT), GRANCYAN_PORT_TLS: String(PORT + 1) }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = (await get('/')).code === 200; if (!up) await sleep(500); }
    t('server 起来了', up);

    console.log('\n【一】私钥 / 数据库 / 日志一律拿不到');
    const leaks = ['/key.pem', '/cert.pem', '/coread.db', '/Gadgetbridge.db', '/local-claude.log', '/local-gpt.log',
      '/KEY.PEM', '/key.pem.', '/key.pem%20', '/key.pem::$DATA', '/key%2epem',
      '/api/../key.pem', '/api/%2e%2e/key.pem', '/js/../key.pem', '/api/..%5ckey.pem', '/js/..%20/key.pem',
      '/data-backups/', '/data-backups./', '/history/', '/server/cloud.js', '/scripts/run-tests.js'];
    for (const p of leaks) {
      const r = await get(p);
      t(`${p} 不给`, r.code !== 200 && !/BEGIN|SQLite format/.test(r.body), r.code + ' ' + r.body.slice(0, 40));
    }

    console.log('\n【二】对照组：前端真要的照常给');
    for (const p of ['/', '/index.html', '/js/01-core.js', '/output.css', '/grancyan.ico', '/stickers/manifest.json']) {
      const r = await get(p);
      t(`${p} 200`, r.code === 200, r.code);
    }
    const api = await get('/api/this-route-does-not-exist');
    t('/api 不被静态闸拦成空 404（走到 API 那层）', api.code !== 0 && api.body.length > 0, api.code);
  } finally {
    server.kill();
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
