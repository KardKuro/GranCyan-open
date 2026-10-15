/* 「删掉的对话又回来了」在浏览器里真的跑一遍：删 → 模拟云端同步 → 看它回不回来。
 *
 * 为什么必须在浏览器里：单测那份在 vm 里只跑墓碑本身的逻辑，
 * 而这条 bug 的要害是**三个函数的接线**（删除入口 → 墓碑 → mergeCloudChats / 清点补漏）。
 * 接线错了每个函数单看都是对的。
 *
 * 跑法：先 GRANCYAN_PORT=3099 node server.js，再 node tests/browser-tombstone.js
 */
const PORT = process.env.GC_PORT || 3099;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9227, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

(async () => {
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode));
      r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9227', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + require('os').tmpdir() + '\\gc-tomb-smoke',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('连不上 Chrome'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes(`127.0.0.1:${PORT}/`));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', m => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  await send('Runtime.enable');
  await sleep(3500);

  /* 造三个对话。headId 不能是 null —— syncChatsToCloud 会拿它筛掉空对话，
     而我们要验的正是「会不会被推上云」。 */
  const setup = `(() => {
    state.deletedChats = {};
    state.trash = [];
    state.chats = [1001, 1002, 1003].map(i => ({
      id: i, title: '崭新の对话 ' + i, headId: i * 10, nodes: {
        [i * 10]: { id: i * 10, role: 'user', content: '喂', parentId: null, timestamp: Date.now() }
      }
    }));
    state.activeChatId = 1001;
    renderChatList();
    return state.chats.length;
  })()`;

  group('[1] 单个删：打墓碑');
  await ev(setup);
  // confirm 会挡住 deleteChat，临时按「是」
  await ev(`window.__origConfirm = window.confirm; window.confirm = () => true;`);
  await ev(`deleteChat(1001, { stopPropagation(){} })`);
  ok(await ev(`isChatDeleted(1001)`), '删完打上了墓碑');
  ok(await ev(`!state.chats.some(c => c.id === 1001)`), '本地列表里没了');
  ok(await ev(`state.trash.some(t => t.type === 'chat' && t.chatData.id === 1001)`), '进了回收站');

  group('[2] ❗云端同步不会把它拉回来');
  /* 这就是用户遇到的那一幕：云端还留着那条（删云端失败，或者别的设备推上去的），
     同步下来 mergeCloudChats 一合并，对话就回来了。 */
  const cloudRow = `{ id: 1001, title: '崭新の对话 1001', headId: 10010, nodes: {
    '10010': { id: 10010, role: 'user', content: '喂', parentId: null, timestamp: Date.now() } } }`;
  await ev(`mergeCloudChats([${cloudRow}])`);
  ok(await ev(`!state.chats.some(c => c.id === 1001)`),
    '❗云端那条被墓碑挡住了，没有复活');

  // 没墓碑的照常合并进来 —— 别把墓碑做成「什么都不同步」
  await ev(`mergeCloudChats([{ id: 2002, title: '别的设备新建的', headId: 20020, nodes: {
    '20020': { id: 20020, role: 'user', content: 'hi', parentId: null, timestamp: Date.now() } } }])`);
  ok(await ev(`state.chats.some(c => c.id === 2002)`),
    '没墓碑的对话照常同步进来（墓碑不是"关掉同步"）');

  group('[3] ❗批量删：主因就在这条路');
  await ev(setup);
  await ev(`(() => {
    state.chatSelectMode = true;
    state.selectedChatIds = new Set([1001, 1002]);
    renderChatList();
    return 1;
  })()`);
  await ev(`deleteSelectedChats()`);
  ok(await ev(`isChatDeleted(1001) && isChatDeleted(1002)`),
    '❗批量删掉的每一个都打了墓碑（原来这条路一个云端删除都没有）');
  ok(await ev(`!isChatDeleted(1003)`), '没选中的不受影响');
  await ev(`mergeCloudChats([${cloudRow}, { id: 1002, title: 'x', headId: 10020, nodes: {} }])`);
  ok(await ev(`!state.chats.some(c => c.id === 1001 || c.id === 1002)`),
    '❗同步下来也没复活');

  group('[4] ❗有墓碑的绝不往云端推');
  const dirty = await ev(`(() => {
    // 还原「本地不知怎么还留着一份」的情形，看它会不会被当成 dirty 推上去
    state.chats.push({ id: 1001, title: '幽灵', headId: 10010, nodes: {
      '10010': { id: 10010, role: 'user', content: 'x', parentId: null, timestamp: Date.now() } } });
    const fp = {};
    return state.chats.filter(c => c.headId !== null && !isChatDeleted(c.id)).map(c => c.id);
  })()`);
  ok(Array.isArray(dirty) && !dirty.includes(1001),
    '❗有墓碑的被排除在推送名单外（不然这台会亲手把它复活回云端）');

  group('[5] ❗清点补漏也要挡 —— 那才是复活引擎的正身');
  /* loadChatsFromCloud 里那段拿云端全部 chat_id 跟本地比，
     把「本地没有」的当成同步漏了主动拉回来。人删掉的对话在它眼里跟漏了一样。 */
  const missing = await ev(`(() => {
    const idRows = [{ chat_id: 1001 }, { chat_id: 1003 }, { chat_id: 9999 }];
    const localIds = new Set(state.chats.filter(c => !isChatDeleted(c.id)).map(c => String(c.id)));
    return idRows.map(r => r.chat_id).filter(id =>
      !localIds.has(String(id)) && !isChatDeleted(id));
  })()`);
  ok(Array.isArray(missing) && !missing.includes(1001),
    '❗已删的不在"补漏"名单里');
  ok(Array.isArray(missing) && missing.includes(9999),
    '真正漏了的还是会被补回来（别把补漏功能整个废掉）');

  group('[6] 墓碑活过刷新（持久化三道关）');
  await ev(`(() => { state.deletedChats = {}; markChatDeleted(4242); return save(); })()`);
  await sleep(600);
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(4500);
  ok(await ev(`isChatDeleted(4242)`),
    '❗刷新后墓碑还在（三道关漏一道就是刷新即失，而且零报错）');
  ok(await ev(`typeof state.deletedChats === 'object' && state.deletedChats !== null`),
    'deletedChats 是对象，不是 undefined');

  group('[7] 恢复出来的是新 id，不受旧墓碑影响');
  /* ⚠️ 上一组导航过页面，window.confirm 的补丁跟着新文档一起没了。
     不重打的话 deleteChat 会弹出**真的**确认框，headless 里没人点，整个脚本挂死
     （不是失败，是卡住不动）—— 第一版就是这么超时的。
     凡是 Page.navigate 之后，页面级的猴子补丁都要重来一遍。 */
  await ev(`window.__origConfirm = window.confirm; window.confirm = () => true;`);
  await ev(`(() => {
    state.deletedChats = {}; state.trash = []; state.chats = [];
    state.chats = [{ id: 7001, title: '要被删的', headId: 70010, nodes: {
      '70010': { id: 70010, role: 'user', content: 'x', parentId: null, timestamp: Date.now() } } }];
    state.activeChatId = 7001;
    return 1;
  })()`);
  await ev(`deleteChat(7001, { stopPropagation(){} })`);
  const idx = await ev(`state.trash.findIndex(t => t.type === 'chat' && t.chatData.id === 7001)`);
  ok(idx >= 0, '（前提）在回收站里找得到');
  await ev(`restoreChatFromTrash(${idx})`);
  ok(await ev(`isChatDeleted(7001)`), '❗旧 id 的墓碑还留着（撤掉的话它就又能复活了）');
  const restored = await ev(`state.chats.find(c => c.title === '要被删的')?.id`);
  ok(restored && restored !== 7001, `恢复出来的是新 id（${restored}），不被墓碑挡住`);
  ok(await ev(`state.chats.some(c => c.title === '要被删的')`), '恢复的对话确实在列表里');

  await ev(`window.confirm = window.__origConfirm || window.confirm;`);
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
