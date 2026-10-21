// 英文界面真浏览器验（2026-10-21）：消息正文不被翻、界面照翻、流式时气泡里不动、功能指南整段是英文。
//
// 跑法：先起一个一次性 server（别用自己的真数据，adb 指到不存在的路径）：
//   GRANCYAN_PORT=3724 GRANCYAN_PORT_TLS=3725 GRANCYAN_ADB=Z:\no\adb.exe GRANCYAN_USER_DATA=<临时目录> node server.js
// 再 node tests/browser-i18n-en.js [端口]
// FAULT=1：拦下 /js/16-misc.js，把跳过名单里的 .bubble 摘掉再喂给页面 —— 「正文原样」那几条应该红。
const { spawn } = require('child_process');
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const PORT = +(process.argv[2] || process.env.GC_PORT || 3724), MOCK = 3727, CDP = 9727;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAULT = process.env.FAULT === '1';
const CJK = /[\u4e00-\u9fff]/;

// 假模型：先想一会儿再一点点吐「好的 / 设置 / 取消」—— 三个都是词典里有的词
let streamGate = null;
const mock = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  req.resume(); req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = d => res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
    for (const c of ['她说删除。', '我想想。']) { send({ reasoning_content: c }); await sleep(40); }
    send({ content: '好的\n\n' }); await sleep(60);
    send({ content: '设置' });
    await new Promise(r => { streamGate = r; setTimeout(r, 8000); });   // 停在半路，等测试看完流式中的样子
    send({ content: '\n\n取消' }); await sleep(40);
    res.write('data: [DONE]\n\n'); res.end();
  });
});

(async () => {
  await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));
  const prof = path.join(os.tmpdir(), 'gc-probe-i18n-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--disable-gpu', '--no-first-run', '--user-data-dir=' + prof, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  const bye = c => { try { chrome.kill(); } catch {} try { require('child_process').spawnSync('taskkill', ['/F', '/T', '/PID', String(chrome.pid)]); } catch {} mock.close(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(c); };
  setTimeout(() => { console.log('超时'); bye(1); }, 150000);
  let ws;
  for (let i = 0; i < 60 && !ws; i++) { await sleep(300); try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const p = l.find(x => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} }
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', async e => {
    const o = JSON.parse(e.data);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Fetch.requestPaused') {
      const u = o.params.request.url;
      if (/\/js\/16-misc\.js/.test(u)) {
        // FAULT=1 才改；平时原样放过去
        let body = fs.readFileSync(path.join(__dirname, '..', 'js', '16-misc.js'), 'utf8');
        if (FAULT) body = body.replace("'[data-no-i18n],.bubble,", "'[data-no-i18n],");
        send('Fetch.fulfillRequest', { requestId: o.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript; charset=utf-8' }], body: Buffer.from(body).toString('base64') });
      } else send('Fetch.failRequest', { requestId: o.params.requestId, errorReason: 'BlockedByClient' });   // 手环 / adb / 偷看屏幕一律掐掉
    }
  });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result?.result?.value; };
  await send('Page.enable');
  await send('Fetch.enable', { patterns: ['*/js/16-misc.js*', '*/api/band*', '*/api/desktop-peek*', '*/api/agent*', '*/api/local-*', '*/api/heartbeat*'].map(u => ({ urlPattern: u, requestStage: 'Request' })) });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('grancyanLang', 'en'); } catch (e) {}` });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 120; i++) { try { if (await ev(`typeof handleSend==='function' && typeof state==='object' && Array.isArray(state.configs) && !!window.__i18n`)) break; } catch {} await sleep(500); }
  await sleep(2000);
  let pass = 0, fail = 0;
  const t = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n, extra ?? '')); };
  console.log(FAULT ? '（FAULT=1：页面拿到的 16-misc.js 跳过名单里没有 .bubble）' : '');
  await ev(`(() => {
    const b = document.getElementById('authOfflineBtn'); const m = document.getElementById('authModal');
    if (b && m && !m.classList.contains('hidden')) b.click();
    state.configs = [{ id: 901, nickname: 'Keke', modelName: 'mock-main', apiKey: 'k', apiBase: 'http://127.0.0.1:${MOCK}/v1', temp: 0.7, maxTokens: 200000, maxReplyTokens: 2048 }];
    state.inkStream = false;
    createNewChat(true); getActiveChat().activeModelIds = [901]; save(); renderMessages();
    summarizeThinking = async () => '';
    return true;
  })()`);
  await sleep(800);
  t('html 挂上 lang=en', await ev(`document.documentElement.lang`) === 'en');
  // 她发一句刚好是词典里有的词
  await ev(`handleSend('删除'), 1`);
  const head = `getActiveChat().nodes[getActiveChat().headId]`;
  let mid = null;
  for (let i = 0; i < 200; i++) {
    mid = await ev(`(() => { const h = ${head}; const b = h && h.role === 'ai' && document.getElementById('bubble-' + h.id); return b ? b.innerText : null; })()`).catch(() => null);
    if (mid && /设置/.test(mid)) break;
    if (mid && /Settings/.test(mid)) break;
    await sleep(50);
  }
  t('流式中：气泡里的「好的」「设置」原样', !!mid && /好的/.test(mid) && /设置/.test(mid) && !/\bOK\b|Settings/.test(mid), mid);
  if (streamGate) streamGate();
  for (let i = 0; i < 200; i++) { if (await ev(`${head}.role === 'ai' && !${head}.streaming`)) break; await sleep(50); }
  await sleep(1200);
  const r = await ev(`(() => {
    const c = getActiveChat(), h = c.nodes[c.headId];
    const ai = document.getElementById('bubble-' + h.id);
    const user = [...document.querySelectorAll('#chatWindow .bubble.user')].map(b => b.innerText.trim());
    const acts = [...document.querySelectorAll('#chatWindow .msg-actions .msg-action-btn')].map(b => b.innerText.trim()).filter(Boolean);
    const think = document.querySelector('#chatWindow .think-label');
    const thinkBody = document.querySelector('#chatWindow .think-body');
    return { ai: ai && ai.innerText, user, acts: acts.slice(0, 8), think: think && think.innerText, thinkBody: thinkBody && thinkBody.textContent };
  })()`);
  t('她发的「删除」原样', r.user.some(u => u === '删除'), r.user);
  t('AI 回的「好的」「设置」「取消」原样', /好的/.test(r.ai || '') && /设置/.test(r.ai || '') && /取消/.test(r.ai || ''), r.ai);
  t('思考正文原样', /她说删除/.test(r.thinkBody || ''), r.thinkBody);
  t('思考块标题是英文（气泡里的界面零件照翻）', !!r.think && !CJK.test(r.think), r.think);
  t('消息下面的操作按钮是英文', r.acts.length > 2 && r.acts.every(a => !CJK.test(a)), r.acts);
  // 她起的对话标题刚好叫「设置」：侧栏和顶栏都原样
  const title = await ev(`(async () => { const c = getActiveChat(); c.title = '设置'; save(); renderChatList(); renderMessages();
    await new Promise(r => setTimeout(r, 400));
    const side = [...document.querySelectorAll('.chat-item-title')].map(x => x.innerText.trim());
    return { side, top: document.getElementById('currentChatTitle').innerText }; })()`);
  t('她起的对话标题「设置」在侧栏和顶栏都原样', title.side.includes('设置') && title.top === '设置', title);
  // 超过 320 字的长消息画成附件卡，正文里单独一行「删除」也原样
  await ev(`handleSend('删除\\n' + '我一直在听。'.repeat(70)), 1`);
  if (streamGate) setTimeout(() => streamGate && streamGate(), 300);
  await sleep(2500);
  if (streamGate) streamGate();
  await sleep(1500);
  const longBody = await ev(`(() => { const b = [...document.querySelectorAll('#chatWindow .msg-attach-body')].pop(); return b ? b.textContent.trim().slice(0, 40) : null; })()`);
  t('长消息（附件卡）正文原样', !!longBody && /^删除/.test(longBody.trim()) && /我一直在听/.test(longBody), longBody);
  // 设置和功能指南
  await ev(`openHub('settings'), 1`); await sleep(600);
  const tabs = await ev(`[...document.querySelectorAll('.settings-tabs button, [onclick*="switchSettingsTab"]')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 6)`);
  // open 的设置只有四个标签（外观 / 模型 & API / 账号 / 回收站），主仓多出语音、功能
  t('设置的标签是英文', tabs.length >= 4 && tabs.every(x => !CJK.test(x)), tabs);
  await ev(`openHubSection('help'), 1`); await sleep(800);
  const help = await ev(`(() => { const d = [...document.querySelectorAll('.help-desc')]; return { n: d.length, zh: d.filter(x => /[\\u4e00-\\u9fff]/.test(x.innerText)).length, first: d[0] && d[0].innerText.slice(0, 80) }; })()`);
  t('功能指南每一段都换成英文', help.n > 200 && help.zh === 0, help);
  await send('Page.captureScreenshot', { format: 'png' }).then(s => { try { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', 'browser-i18n-en.png'), Buffer.from(s.result.data, 'base64')); } catch {} });
  console.log(`\n${pass} passed, ${fail} failed`);
  bye(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
