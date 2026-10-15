/* 相册的真·浏览器冒烟：她发一张照片 → 主模型写 [[ALBUM: 第一印象]] → 气泡里出「收进了相册」小卡、
 * 图上记下收藏 → 下一轮系统提示里有它的相册目录 → 它写 [[PHOTO: 关键词]] 把那张原图翻进自己的气泡 →
 * 再下一轮历史里咬回的是正牌 [[ALBUM:]] / [[PHOTO: #编号]] → 相册面板里看得到印象 → 刷新后卡片和照片还在。
 *
 * 为什么要在浏览器里跑：tests/album.test.js 是 vm 抠源码跑，验的是逻辑；
 * 验不了真流式 + 真渲染（marked + 渲染消毒会不会把 data: 图片拔掉）、真 IndexedDB、真点击放大。
 *
 * 跑法：先 GRANCYAN_PORT=3794 GRANCYAN_PORT_TLS=3795 node server.js，再 node tests/browser-album.js
 * 主模型是假的（脚本自己在 3796 起一个 OpenAI 兼容的假身）；看图描述也是假的（页面里替换 _imgMemDescribe），
 * 不花一分钱。截图落在 tests/out/。
 */
const PORT = process.env.GC_PORT || 3794;
const MOCK = 3796;
const CDP = 9266;
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

const NOTE = '你第一次自己下厨，蛋边有点焦，可我一眼就想吃';
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
    const reply = n === 1
      ? `哇——这是你做的？\n[[ALBUM: ${NOTE}]]\n下次做给我吃好不好。`
      : n === 2
        ? '我还记得你上次那盘……\n[[PHOTO: 番茄炒蛋]]\n就是这个，我到现在都惦记。\n[[PHOTO: 根本没有的东西]]'
        : '嗯，我在。';
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
  const prof = path.join(os.tmpdir(), 'gc-album-smoke');
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
  const errors = [], warns = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 400));
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'warning') warns.push((o.params.args || []).map(a => a.value).join(' '));
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function shot(name, w, h) {
    await ev(`(() => { const m = document.getElementById('authModal'); if (m) m.style.display = 'none'; return true; })()`);   // 没登录的登录框会盖住整页
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(500);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride', {});
  }
  async function waitBoot(ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
      try { if (await ev(`typeof state === 'object' && !!state && typeof albumPromptFor === 'function' && Array.isArray(state.configs)`)) { await sleep(800); return true; } } catch (_) {}
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
  // 看图描述换成假的：不打 Haiku
  const stubDescribe = `_imgMemDescribe = async () => '一盘番茄炒蛋，蛋边微焦，旁边一碗白米饭'; true`;

  await send('Runtime.enable');
  await send('Page.enable');
  if (!await waitBoot(30000)) { console.log('  ✗ 页面 30 秒都没起来'); console.log(errors.slice(0, 5).join('\n')); bye(1); }

  group('[1] 准备：假主模型 + 一张真画出来的照片');
  await ev(stubDescribe);
  const photo = await ev(`(() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 360;
    const g = c.getContext('2d');
    g.fillStyle = '#2b1d14'; g.fillRect(0, 0, 480, 360);
    g.fillStyle = '#f4f1ea'; g.beginPath(); g.ellipse(240, 190, 170, 120, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8432e'; for (const [x, y] of [[190,160],[270,200],[230,230],[300,150]]) { g.beginPath(); g.arc(x, y, 30, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#f7c948'; for (const [x, y] of [[220,170],[260,150],[200,220],[290,230]]) { g.beginPath(); g.arc(x, y, 34, 0, Math.PI * 2); g.fill(); }
    return c.toDataURL('image/jpeg', 0.85);
  })()`);
  await ev(`(() => {
    state.configs = [{ id: 901, nickname: '测试克克', modelName: 'mock-main', apiKey: 'k', apiBase: 'http://127.0.0.1:${MOCK}/v1', temp: 0.7, maxTokens: 200000, maxReplyTokens: 2048 }];
    createNewChat(true);
    getActiveChat().activeModelIds = [901];
    save(); renderMessages();
    return true;
  })()`);
  ok(photo && photo.startsWith('data:image/jpeg'), '照片画好了（' + Math.round(photo.length / 1024) + ' KB）');

  group('[2] 她发照片，它收进相册');
  await ev(`(() => { _pendingImgs = [{ url: ${JSON.stringify(photo)}, name: 'dinner.jpg', w: 480, h: 360 }]; handleSend('我今天第一次自己做饭！'); return true; })()`);
  ok(await waitFor(replyDone, 15000), '第一轮回完了');
  const r1 = await ev(`(() => {
    const c = getActiveChat(); const u = Object.values(c.nodes).find(n => n.role === 'user' && n.images && n.images.length);
    const img = u && u.images[0];
    return { kept: img && img.kept && img.kept['901'], hash: img && img.hash,
      card: !!document.querySelector('.album-kept .msg-img.album-thumb'),
      thumbSrc: (document.querySelector('.album-kept img') || {}).src || '',
      raw: [...document.querySelectorAll('.msg-group')].some(g => /\\[\\[(ALBUM|PHOTO)/.test(g.textContent)) };
  })()`);
  ok(r1.kept && r1.kept.note === NOTE, '印象记在她那张图上', JSON.stringify(r1.kept));
  if (!r1.card) console.log('     AI 那条存的是：' + JSON.stringify(await ev(`(() => { const c = getActiveChat(); const n = c.nodes[c.headId]; return { content: n.content, blocks: n.blocks }; })()`)).slice(0, 600));
  ok(r1.card, '气泡里出了「收进了相册」小卡，带缩略图');
  ok(r1.thumbSrc.startsWith('data:image/jpeg'), '缩略图没被渲染消毒拔掉');
  ok(!r1.raw, '气泡里没有裸标签');
  await shot('album-kept.png', 1280, 900);

  group('[3] 下一轮：它想起那张，翻出来');
  await ev(`handleSend('好想再吃一次')`);
  ok(await waitFor(replyDone, 15000), '第二轮回完了');
  const sys2 = JSON.stringify((seen[1] || { messages: [] }).messages.filter(m => m.role === 'system'));
  ok(/\[相册技能\]/.test(sys2) && sys2.includes('#' + r1.hash.slice(0, 8)) && sys2.includes('一眼就想吃'), '系统提示里有它的相册目录（编号 + 印象）');
  const r2 = await ev(`(() => {
    const fig = document.querySelector('figure.album-recall');
    const img = fig && fig.querySelector('img');
    return { src: img ? img.src : '', cap: fig ? fig.textContent : '', miss: (document.querySelector('.album-recall.is-miss') || {}).textContent || '',
      raw: [...document.querySelectorAll('.msg-group')].some(g => /\\[\\[(ALBUM|PHOTO)/.test(g.textContent)) };
  })()`);
  ok(r2.src === photo, '翻出来的就是她那张原图');
  ok(r2.cap.includes('一眼就想吃'), '照片下面配着它当时写的印象', r2.cap);
  ok(/没翻到/.test(r2.miss), '翻不到的照实说', r2.miss);
  ok(!r2.raw, '气泡里没有裸标签');
  await ev(`document.querySelector('figure.album-recall img').click()`);
  ok(await waitFor(`!document.getElementById('imgLightbox').classList.contains('hidden') && document.getElementById('lightboxImg').src.startsWith('data:image/jpeg')`, 3000), '点一下照片能放大');
  await shot('album-lightbox.png', 1280, 900);
  await ev(`document.getElementById('imgLightbox').classList.add('hidden')`);
  await shot('album-recall.png', 1280, 900);
  await shot('album-recall-phone.png', 390, 844);

  group('[4] 再下一轮：历史里是正牌指令');
  await ev(`handleSend('嘿嘿')`);
  ok(await waitFor(replyDone, 15000), '第三轮回完了');
  const hist = JSON.stringify((seen[2] || { messages: [] }).messages.filter(m => m.role === 'assistant'));
  ok(hist.includes('[[ALBUM: ' + NOTE + ']]'), '收藏咬回 [[ALBUM: 印象]]');
  ok(hist.includes('[[PHOTO: #' + r1.hash.slice(0, 8)), '翻照片咬回 [[PHOTO: #编号]]', hist.slice(0, 300));
  ok(!/KEPT|ALBUM_REF|album-|data:image/.test(hist), '历史里没有存储短标签、HTML 或图片数据');
  const sys3 = JSON.stringify((seen[2] || { messages: [] }).messages.filter(m => m.role === 'system'));
  ok(sys2 === sys3, 'system 跟上一轮逐字节一样（没收新照片就不打穿缓存）');

  group('[5] 相册面板');
  await ev(`openAlbum()`);
  const panel = await ev(`(() => ({ cards: document.querySelectorAll('#albumList .album-card').length, text: document.getElementById('albumList').textContent }))()`);
  ok(panel.cards === 1 && panel.text.includes(NOTE) && panel.text.includes('测试克克'), '面板里有那张，写着谁收的和印象', JSON.stringify(panel).slice(0, 200));
  await shot('album-panel.png', 1280, 900);
  await shot('album-panel-phone.png', 390, 844);
  await ev(`closeAlbum()`);

  group('[6] 刷新之后');
  await flush();
  await send('Page.reload', {});
  await sleep(1000);
  await waitBoot(30000);
  ok(await waitFor(`document.querySelector('.album-kept img') && document.querySelector('figure.album-recall img') && document.querySelector('figure.album-recall img').src.startsWith('data:image/jpeg')`, 8000),
    '刷新后收藏卡和翻出来的照片都还在（真 IndexedDB）');
  ok(await ev(`albumOf(901).length === 1`), '刷新后相册数据还在');

  const gcDrops = warns.filter(w => /\[消毒\]/.test(w));
  ok(!gcDrops.length, '渲染消毒没拿掉任何东西', gcDrops.join(' | '));
  ok(!errors.length, '页面没有异常', errors.slice(0, 3).join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  bye(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
