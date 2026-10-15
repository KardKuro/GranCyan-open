/* 猫爪日报第 1 单的真·持久化冒烟：发一条 → 真的刷新页面 → 它还在吗。
 *
 * 为什么必须在浏览器里跑：tests/moments.test.js 用 vm 抠源码跑，
 * idbSet/idbGet 是假的 Map —— 它验的是「四道关的代码逻辑接得上」，
 * 验不了「真 IndexedDB 里真的存住了」。而这一单的验收点恰恰就是
 * 「刷新之后它还在」，那是一次真实的 reload 往返，假 Map 永远测不到。
 *
 * 跑法：先 GRANCYAN_PORT=3097 node server.js，再 node tests/browser-moments.js
 */
const PORT = process.env.GC_PORT || 3097;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || require('path').join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9231, path: p }, r => {
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
    '--headless=new', '--remote-debugging-port=9231', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + require('path').join(require('os').tmpdir(), 'gc-moments-smoke'),
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('连不上 Chrome'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  const errors = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 300));
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(3500);

  group('[1] 面板真的能开');
  ok(await ev(`typeof openMoments === 'function'`), 'openMoments 挂上了');
  await ev(`openMoments()`);
  ok(await ev(`!document.getElementById('momentsModal').classList.contains('hidden')`), '面板打开了');
  ok(await ev(`!!document.getElementById('momentsInput')`), '发布框在 DOM 里');

  group('[2] 空列表有占位，不是一片空白');
  await ev(`state.moments = []; momentsRender();`);
  ok(await ev(`document.querySelector('.moments-empty') !== null`), '空的时候有占位文案');

  group('[3] 发一条');
  const made = await ev(`(() => { const m = momentsAddUser('冒烟测试的第一条动态'); return m && m.id; })()`);
  ok(typeof made === 'number' && made > 0, '发布返回了一条带 id 的动态（id=' + made + '）');
  await ev(`momentsRender()`);
  ok(await ev(`document.querySelectorAll('#momentsList .moment-card, #momentsList .moment-item').length >= 1`)
     || await ev(`document.getElementById('momentsList').innerHTML.includes('冒烟测试的第一条动态')`),
     '列表里渲染出来了');

  group('[4] ❗真刷新页面 —— 这是假 IDB 永远测不到的那一步');
  await ev(`(async () => { await save(); })()`);           // 把 debounce 逼出去，真写进 IndexedDB
  await sleep(1200);
  await send('Page.reload', { ignoreCache: false });
  await sleep(5000);
  const survived = await ev(`(state.moments || []).some(m => m && m.text === '冒烟测试的第一条动态')`);
  ok(survived, '❗刷新之后动态还在（真 IndexedDB 往返）');
  const authorOk = await ev(`(state.moments || []).find(m => m && m.text === '冒烟测试的第一条动态')?.author === 'user'`);
  ok(authorOk, 'author 存的是 \'user\' 字符串，不是下标');

  group('[5] 刷新后重新打开面板也正常');
  ok(await ev(`typeof openMoments === 'function'`), 'reload 后 openMoments 仍然在');
  await ev(`openMoments(); momentsRender();`);
  ok(await ev(`document.getElementById('momentsList').innerHTML.includes('冒烟测试的第一条动态')`),
     '重开面板还能看到那条');

  group('[5.5] 第 2 单：AI 写 [[MOMENT:]] 在真页面里走通');
  ok(await ev(`typeof momentsProcessTags === 'function' && typeof maskStreamingMoments === 'function'`),
     '51-moments.js 的第 2 单函数在真页面里挂上了（脚本加载顺序对）');
  const cooked = await ev(
    `processAiCommands('前面一句 [[MOMENT: 冒烟测试的AI动态]] 后面一句', {}, { name: '冒烟角色' })`);
  ok(typeof cooked === 'string' && !cooked.includes('[[MOMENT:') && cooked.includes('moment-chat-card'),
     '气泡里是卡片，指令不裸露');
  ok(await ev(`(state.moments || []).some(m => m && m.text === '冒烟测试的AI动态' && m.author === '冒烟角色')`),
     'author 存的是模型卡的 name 字符串');
  // 命门：回填给模型看的必须还是正牌指令，不是「🐾 上了猫爪日报」
  const back = await ev(`stickerTagForApi(${JSON.stringify(cooked)})`);
  ok(typeof back === 'string' && back.includes('[[MOMENT: 冒烟测试的AI动态]]') && !back.includes('上了猫爪日报'),
     '❗回填进历史的是 [[MOMENT: 正文]] 原样，不是展示形态');
  ok(!(await ev(`maskStreamingMoments('正在写 [[MOMENT: 半截')`)).includes('[[MOMENT:'),
     '流式打字时没写完的标签被遮住了');

  group('[5.6] 第 3 单：点赞、评论、草稿不被重画吃掉');
  const mid = await ev(`(() => { const m = momentsAddByChar('冒烟角色', '冒烟测试的被评论动态'); return m && m.id; })()`);
  ok(typeof mid === 'number' && mid > 0, '有一条可以被互动的动态（id=' + mid + '）');
  await ev(`openMoments(); momentsRender();`);
  await ev(`momentsToggleLike(${mid})`);
  ok(await ev(`(momentsFindById(${mid}).likes || []).includes('user')`), '小明点赞落到 likes 里，身份是 user');
  ok(await ev(`document.getElementById('momentsList').innerHTML.includes('user') || document.querySelectorAll('#momentsList [class*=like]').length > 0`),
     '点赞在面板里看得见');

  // 真 DOM 里的草稿保全：vm 测试用的是假 document，这一步只有真浏览器能证
  await ev(`momentsToggleReply(${mid})`);
  const typed = await ev(`(() => {
    const box = document.querySelector('#momentsList textarea, #momentsList input[type=text]');
    if (!box) return 'NO_INPUT';
    box.value = '真浏览器里写到一半的评论';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  })()`);
  ok(typed === 'OK', '评论框真的出现在 DOM 里' + (typed === 'NO_INPUT' ? '（没找到输入框）' : ''));
  await ev(`momentsRender()`);
  const draftKept = await ev(`(() => {
    const box = document.querySelector('#momentsList textarea, #momentsList input[type=text]');
    return box ? box.value : null;
  })()`);
  ok(draftKept === '真浏览器里写到一半的评论',
     '❗momentsRender() 重画之后草稿还在（真 DOM，不是假 document）— 实际拿到：' + JSON.stringify(draftKept));

  group('[5.7] 第 3 单：AI 点赞评论 + 回填自咬合');
  const socialCooked = await ev(
    `processAiCommands('[[MOMENT_LIKE: ${mid}]] [[MOMENT_REPLY: ${mid} | 冒烟测试的AI评论]]', {}, { name: '另一个冒烟角色' })`);
  ok(await ev(`(momentsFindById(${mid}).likes || []).includes('另一个冒烟角色')`), '角色点赞了别人的动态');
  ok(await ev(`(momentsFindById(${mid}).comments || []).some(c => c.author === '另一个冒烟角色' && c.text === '冒烟测试的AI评论')`),
     '角色评论了别人的动态，author 是它的 name（角色互评）');
  const aiCommentId = await ev(`(momentsFindById(${mid}).comments || []).find(c => c.text === '冒烟测试的AI评论')?.id`);
  await ev(`momentsRender(); momentsReplyToComment(${mid}, ${JSON.stringify(aiCommentId)})`);
  ok(await ev(`document.querySelector('.moment-reply-context')?.textContent.includes('另一个冒烟角色')`),
     '点评论后，真 DOM 回复框明确显示回复对象');
  await ev(`(() => {
    const box = document.getElementById('momentsReplyInput');
    box.value = '冒烟测试的定向回复';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    momentsSubmitReply(${mid});
  })()`);
  ok(await ev(`(momentsFindById(${mid}).comments || []).some(c => c.text === '冒烟测试的定向回复'
       && c.replyTo?.id === ${JSON.stringify(aiCommentId)} && c.replyTo?.author === '另一个冒烟角色')`),
     '定向回复在真页面落库，保留目标评论 id 与作者');
  ok(await ev(`document.getElementById('momentsList').innerHTML.includes('moment-comment-reply-word')`),
     '定向回复在列表里渲染成「小明 回复 另一个冒烟角色」');
  const socialBack = await ev(`stickerTagForApi(${JSON.stringify(socialCooked)})`);
  ok(socialBack.includes(`[[MOMENT_LIKE: ${mid}]]`) && socialBack.includes(`[[MOMENT_REPLY: ${mid} | 冒烟测试的AI评论]]`)
     && !/<[^>]+>/.test(socialBack),
     '❗回填是正牌指令，没有任何 HTML 展示形态漏进历史');
  ok(await ev(`(() => { const s = {}; momentsViewWant(1); buildSystemPrompt({ id: 1, name: '冒烟角色', nickname: '冒烟角色' }, { id: 1, nodes: {}, headId: null }, '', null, s); momentsViewClear(1);
        return !s.stable.includes('[最近的猫爪日报动态]') && s.volatile.includes('[最近的猫爪日报动态]'); })()`),
     '动态摘要只进 volatile（不进 stable，否则提示词缓存每轮全废）');

  group('[6] 没有未捕获的 JS 报错');
  ok(errors.length === 0, '控制台无未捕获异常' + (errors.length ? '：' + errors[0] : ''));

  // 收尾：把冒烟造的数据删掉，别留在真 IDB 里
  await ev(`(async () => { state.moments = (state.moments||[]).filter(m => !(m && /^冒烟测试的/.test(m.text || ''))); await save(); })()`);
  await sleep(600);

  ws.close(); chrome.kill();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
