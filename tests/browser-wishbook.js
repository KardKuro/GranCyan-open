/* 小本子的真·浏览器冒烟（用户）：
 * 它写 [[WISH: 东西 | 为什么]] → 气泡里只有「📒 悄悄记了一笔」、存档里记着 → 下一轮回填历史里它看得到自己记过什么、
 * 系统提示里列着「还封着的」→ 它写 [[WISH_OPEN: 东西]] → 气泡里翻开那一页 → 刷新后本子还在（真 IndexedDB）→ 面板。
 *
 * tests/wishbook.test.js 是 vm 抠源码跑；这里验的是真页面上三道关、渲染链、blocks 都接上了。
 *
 * 跑法：先 GRANCYAN_PORT=3797 GRANCYAN_PORT_TLS=3798 node server.js，再 node tests/browser-wishbook.js
 * 主模型是假的（脚本自己在 3799 起一个 OpenAI 兼容的假身），不花一分钱。截图落在 tests/out/。
 */
const PORT = process.env.GC_PORT || 3797;
const MOCK = 3799;
const CDP = 9271;
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const OUT = path.join(__dirname, 'out');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra ? '  —— ' + extra : '')); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

const ITEM = '月亮夜灯';
const WHY = '她说起夜总踢到桌角';
const seen = [];
const mock = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let b = '';
  req.on('data', d => b += d);
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(b); } catch {}
    seen.push(body);
    const n = seen.length;
    const reply = n === 1 ? `记住了，不说。\n[[WISH: ${ITEM} | ${WHY}]]\n快去睡。`
      : n === 2 ? `熬过去了，给你看个东西。\n[[WISH_OPEN: ${ITEM}]]\n下周寄到。`
      : '嗯。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunks = reply.match(/[\s\S]{1,5}/g);
    let i = 0;
    const tick = () => {
      if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`); setTimeout(tick, 12); }
      else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    tick();
  });
});

(async () => {
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode));
      r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });
  await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));
  fs.mkdirSync(OUT, { recursive: true });
  const prof = path.join(os.tmpdir(), 'gc-wishbook-smoke');
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (_) {}

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + prof, '--window-size=1280,900',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });
  const bye = code => { try { chrome.kill(); } catch {} ; mock.close(); process.exit(code); };

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('连不上 Chrome'); bye(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  const errors = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 400));
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function shot(name, w, h, prep) {
    await ev(`(() => { const m = document.getElementById('authModal'); if (m) m.style.display = 'none'; return true; })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(500);
    if (prep) { await ev(prep); await sleep(200); }
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride', {});
  }
  async function waitBoot(ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
      try { if (await ev(`typeof state === 'object' && !!state && typeof wishProcessTags === 'function' && Array.isArray(state.configs)`)) { await sleep(800); return true; } } catch (_) {}
    }
    return false;
  }
  async function waitFor(expr, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
      try { if (await ev(expr)) return true; } catch (_) {}
    }
    return false;
  }
  const flush = () => ev(`(async () => { clearTimeout(_saveTimer); await _doSave(); return true; })()`);
  const replyDone = `!getActiveChat().nodes[getActiveChat().headId].streaming && getActiveChat().nodes[getActiveChat().headId].role === 'ai'`;
  const bubbles = `[...document.querySelectorAll('.msg-group')].map(g => g.textContent).join(' | ')`;

  await send('Runtime.enable');
  await send('Page.enable');
  if (!await waitBoot(30000)) { console.log('  ✗ 页面 30 秒都没起来'); console.log(errors.slice(0, 5).join('\n')); bye(1); }

  group('[1] 准备：假主模型');
  await ev(`(() => {
    state.configs = [{ id: 901, nickname: '测试克克', modelName: 'mock-main', apiKey: 'k', apiBase: 'http://127.0.0.1:${MOCK}/v1', temp: 0.7, maxTokens: 200000, maxReplyTokens: 2048 }];
    createNewChat(true);
    getActiveChat().activeModelIds = [901];
    save(); renderMessages();
    return true;
  })()`);
  ok(await ev(`Array.isArray(state.wishbook) && state.wishbook.length === 0`), '本子起步是空的');

  group('[2] 它悄悄记了一笔');
  await ev(`handleSend('最近晚上起夜老踢到桌角，好痛')`);
  ok(await waitFor(replyDone, 15000), '第一轮回完了');
  const sys1 = JSON.stringify((seen[0] || { messages: [] }).messages);
  ok(sys1.includes('[小本子]') && sys1.includes('[[WISH: 东西 | 为什么想给她]]'), '系统提示里教了怎么记');
  const w1 = await ev(`JSON.stringify(state.wishbook)`);
  ok(w1.includes(ITEM) && w1.includes(WHY) && /"c":"901"/.test(w1), '★ 记进本子，记在它名下', w1);
  const b1 = await ev(bubbles);
  ok(!b1.includes(ITEM) && !b1.includes(WHY), '★ 气泡里看不到记了什么', b1.slice(-200));
  ok(b1.includes('悄悄记了一笔'), '气泡里有那枚小印章');
  ok(!/\[\[WISH/.test(b1), '气泡里没有裸标签');
  const node1 = await ev(`(() => { const c = getActiveChat(); const n = c.nodes[c.headId]; return JSON.stringify({ c: n.content, b: n.blocks }); })()`);
  ok(!node1.includes(ITEM), '★ 存下来的消息（content 和 blocks）里都没有东西名', node1.slice(0, 300));
  await shot('wishbook-kept.png', 1280, 900);
  await shot('wishbook-kept-phone.png', 390, 844);

  group('[3] 下一轮：它记得自己记过什么，然后翻给她');
  await ev(`handleSend('ddl 终于交了！！')`);
  ok(await waitFor(replyDone, 15000), '第二轮回完了');
  const msgs2 = (seen[1] || { messages: [] }).messages;
  const all2 = JSON.stringify(msgs2);
  ok(all2.includes(`[[WISH: ${ITEM} | ${WHY}]]`), '★ 回填历史里咬回了它记过的那条', all2.slice(-600));
  ok(all2.includes(`还封着的：${ITEM}`), '系统提示里列着还封着的');
  const b2 = await ev(bubbles);
  ok(b2.includes(ITEM) && b2.includes(WHY) && b2.includes('从小本子里翻出来一页'), '★ 翻开的那页画在气泡里', b2.slice(-300));
  ok(!/\[\[WISH/.test(b2), '气泡里没有裸标签');
  ok(await ev(`state.wishbook[0].open > 0`), '本子里标成翻开了');
  await shot('wishbook-open.png', 1280, 900);
  await shot('wishbook-open-phone.png', 390, 844);

  group('[4] 刷新之后');
  // 再记一页封着的，面板里好有封页可看
  await ev(`(() => { wishAdd({ item: '新的发夹', why: '上次那个断了', confId: 901, who: '测试克克' }); return true; })()`);
  await flush();
  const before = await ev(`JSON.stringify(state.wishbook)`);
  await send('Page.reload', {});
  await sleep(1000);
  await waitBoot(30000);
  const after = await ev(`JSON.stringify(state.wishbook)`);
  ok(after === before, '★ 刷新后本子还在（真 IndexedDB，三道关都过了）', after);
  const b3 = await ev(bubbles);
  ok(b3.includes('悄悄记了一笔') && b3.includes(WHY), '刷新后气泡照样画（印章 + 翻开的那页）');

  group('[5] 面板');
  await ev(`openWidget(openWishbook)`);
  ok(await ev(`!document.getElementById('wishbookModal').classList.contains('hidden')`), '从小组件打开了');
  const panel = await ev(`document.getElementById('wishbookBody').innerText`);
  ok(/一共 2 页 · 翻开了 1 页/.test(panel), '页数对', panel.slice(0, 120));
  ok(!panel.includes('新的发夹') && !panel.includes('上次那个断了'), '★ 封着的那页面板里也看不到', panel);
  ok(panel.includes(ITEM) && panel.includes(WHY), '翻开的那页看得到');
  await shot('wishbook-panel.png', 1280, 900);
  await shot('wishbook-panel-phone.png', 390, 844);
  ok(await ev(`(() => { const b = document.getElementById('wishbookBody'); return b.scrollWidth <= b.clientWidth + 1; })()`), '窄屏不横向溢出');
  await ev(`closeWishbook()`);
  ok(await ev(`document.getElementById('wishbookModal').classList.contains('hidden')`), '关得上');

  ok(!errors.length, '页面没有异常', errors.slice(0, 3).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  bye(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
