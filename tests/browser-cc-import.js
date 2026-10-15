/* 导入 claude.ai 老对话：在真浏览器里从「选文件」一路点到「刷新后还在」。
 *
 * 单测（cc-import.test.js）在 vm 里跑的是转换逻辑；这里验的是接线：
 * 文件框 → JSZip 解包 → 预览 → 落地 → 对话列表/顶栏标记 → 渲染（思考块、分支箭头、缺图卡片）
 * → 落盘刷新还在 → 再导一次不翻倍 → 删掉再导不复活。
 *
 * 跑法：先 GRANCYAN_PORT=3720 GRANCYAN_PORT_TLS=3721 node server.js，再 node tests/browser-cc-import.js
 * 用全新的 Chrome 资料目录（没登录 → 不碰云端），跑完删掉。
 */
const PORT = process.env.GC_PORT || 3720;
const CDP = 9330;
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const AdmZip = require('adm-zip');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.env.GC_SHOT_DIR || os.tmpdir();

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode)); r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });

  // 按官方格式造的样本，打成和官方一样「套一层目录」的 zip
  const zipPath = path.join(os.tmpdir(), 'gc-cc-import-sample.zip');
  const z = new AdmZip();
  z.addFile('data-2026-10-03-12-00-00/conversations.json', fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-export-sample.json')));
  z.addFile('data-2026-10-03-12-00-00/users.json', Buffer.from('[]'));
  z.writeZip(zipPath);

  const profile = path.join(os.tmpdir(), 'gc-cc-import-smoke');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--disable-gpu', '--no-first-run',
    '--window-size=1280,860', '--force-dark-mode', '--user-data-dir=' + profile,
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });
  const done = code => { try { chrome.kill(); } catch {} setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 800); };

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  const page = targets && targets.find(t => t.type === 'page' && t.url.includes(String(PORT)));
  if (!page) { console.error('连不上 Chrome'); return done(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  const errors = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails?.exception?.description || o.params.exceptionDetails?.text);
  });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  const shot = async name => {
    // 全新资料目录没登录，登录框会盖住整页 —— 截图只为看排版，拍之前藏掉（不影响上面任何断言）
    await ev(`(() => { const a = document.getElementById('authModal'); if (a) a.style.display = 'none'; return true; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('    📸 ' + f);
  };
  const waitFor = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); }
    return false;
  };
  async function pickFile() {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#ccImportBody input[type=file]' });
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [zipPath] });
  }

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await waitFor(`typeof openCcImport === 'function' && Array.isArray(state.chats)`);
  await sleep(1500);
  await ev(`window.confirm = () => true; true`);
  const before = await ev(`state.chats.length`);

  group('[1] 选文件 → 预览');
  await ev(`openCcImport(); true`);
  ok(await ev(`!document.getElementById('ccImportModal').classList.contains('hidden')`), '面板打开了');
  ok(await ev(`/Export data/.test(document.getElementById('ccImportBody').textContent)`), '面板里写着怎么导出');
  await shot('cc-import-1-intro.png');
  await pickFile();
  ok(await waitFor(`!!document.querySelector('#ccImportBody .cc-list')`), '选了 zip 后出了预览');
  const stats = await ev(`[...document.querySelectorAll('#ccImportBody .study-stat')].map(e => e.textContent.replace(/\\s+/g,''))`);
  ok(stats && stats[0] === '2新对话', '预览：2 个新对话（空的那个不算）', stats);
  ok(await ev(`/老格式导出/.test(document.getElementById('ccImportBody').textContent)`), '老格式（没有分支信息）的提醒出现了');
  await shot('cc-import-2-plan.png');

  group('[2] 落地');
  await ev(`ccDoImport(); true`);
  ok(await waitFor(`!!document.querySelector('#ccImportBody .cc-done')`), '出了结果页');
  const doneTxt = await ev(`document.querySelector('#ccImportBody .cc-done').textContent`);
  ok(/新建 2 个对话/.test(doneTxt), '结果：新建 2 个', doneTxt.slice(0, 80));
  ok(/没带过来的/.test(doneTxt) && /图片\/文件只有名字/.test(doneTxt), '结果里明说了图片没本体', doneTxt);
  await shot('cc-import-3-done.png');
  await ev(`closeCcImport(); true`);
  ok(await ev(`state.chats.length`) === before + 2, '对话多了 2 个');
  ok(await ev(`document.querySelectorAll('#chatList .cc-badge').length`) === 2, '对话列表里 2 个 claude.ai 标记');

  group('[3] 渲染');
  const cid = await ev(`state.chats.find(c => c.importedFrom && c.title === '初见').id`);
  await ev(`switchChat(${cid}); true`);
  await sleep(600);
  ok(await ev(`!document.getElementById('ccEraBadge').classList.contains('hidden') && document.getElementById('ccEraBadge').textContent`) === 'claude.ai 时期 · 2026-01', '顶栏挂着「claude.ai 时期 · 2026-01」');
  ok(await ev(`document.querySelectorAll('#chatWindow [data-node-id]').length >= 8`), '主线 8 条都画出来了');
  ok(await ev(`/东京今天晴/.test(document.getElementById('chatWindow').textContent)`), '正文在');
  ok(await ev(`/cat\\.png/.test(document.getElementById('chatWindow').textContent)`), '缺图卡片画出来了（cat.png）');
  ok(await ev(`/给小明的小网页/.test(document.getElementById('chatWindow').textContent)`), 'artifact 标题在');
  await shot('cc-import-4-chat.png');
  // 切到思考那条分支：第一句下面的回复有两个兄弟（m-0002 带思考，m-0003 是主线）
  const a2 = await ev(`Object.values(state.chats.find(c=>c.id===${cid}).nodes).find(n=>n.ccUuid==='m-0002').id`);
  const a3 = await ev(`Object.values(state.chats.find(c=>c.id===${cid}).nodes).find(n=>n.ccUuid==='m-0003').id`);
  await ev(`switchBranch(${a3}, -1); true`);
  await sleep(500);
  ok(await ev(`getActiveChat().headId`) === a2, '左切分支到了带思考的那条回复');
  ok(await ev(`!!document.querySelector('#chatWindow .think-block')`), '思考块画出来了');
  ok(await ev(`/想着怎么打招呼/.test(document.querySelector('#chatWindow .think-block .think-label').textContent)`), '思考块标题是 claude.ai 的概括');
  await shot('cc-import-5-branch.png');

  group('[4] 落盘 → 刷新还在');
  await ev(`save(); true`);
  await sleep(1500);
  await send('Page.reload', {});
  await sleep(1500);
  await waitFor(`typeof openCcImport === 'function' && Array.isArray(state.chats) && state.chats.length > 0`);
  await sleep(2000);
  ok(await ev(`state.chats.filter(c => c.importedFrom).length`) === 2, '刷新后 2 个导入的对话还在');
  ok(await ev(`(() => { const c = state.chats.find(c => c.title === '初见'); return !!c && Object.values(c.nodes).every(n => n.ccUuid) && c.importedFrom.uuid === 'c0a1e7f2-1111-4a6b-9c1d-000000000001'; })()`), '刷新后来源标记和 ccUuid 都在');

  group('[5] 再导一次不翻倍');
  await ev(`window.confirm = () => true; openCcImport(); true`);
  await pickFile();
  await waitFor(`!!document.querySelector('#ccImportBody .cc-list')`);
  const stats2 = await ev(`[...document.querySelectorAll('#ccImportBody .study-stat')].map(e => e.textContent.replace(/\\s+/g,''))`);
  ok(stats2 && stats2[0] === '0新对话' && stats2[2] === '2已经有了', '再导：0 新，2 已有', stats2);
  ok(await ev(`document.querySelector('#ccImportBody .forge-go-row .study-go').disabled`), '导入按钮是灰的');
  await ev(`closeCcImport(); true`);

  group('[6] 删掉再导，不复活');
  const cid2 = await ev(`state.chats.find(c => c.title === '初见').id`);
  await ev(`deleteChat(${cid2}, { stopPropagation(){} }); true`);
  ok(await ev(`state.deletedChats[String(${cid2})] && state.deletedChats[String(${cid2})].cc`) === 'c0a1e7f2-1111-4a6b-9c1d-000000000001', '删掉后墓碑上记着 claude.ai uuid');
  await ev(`openCcImport(); true`);
  await pickFile();
  await waitFor(`!!document.querySelector('#ccImportBody .cc-list')`);
  const stats3 = await ev(`[...document.querySelectorAll('#ccImportBody .study-stat')].map(e => e.textContent.replace(/\\s+/g,''))`);
  ok(stats3 && stats3[0] === '0新对话' && stats3[3] === '1导过又删掉', '再导：删掉的那个标成「导过又删掉」', stats3);
  ok(await ev(`!!document.querySelector('#ccImportBody .cc-opt input')`), '有「也导回来」的勾');
  await shot('cc-import-6-deleted.png');
  await ev(`ccDoImport(); true`);
  await sleep(300);
  ok(await ev(`!state.chats.some(c => c.title === '初见')`), '不勾就不导回来');

  group('[7] 页面没有报错');
  ok(!errors.length, '没有未捕获异常', errors.slice(0, 3));

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log('  ✗ 跑到一半炸了：' + e.message); process.exit(1); });
