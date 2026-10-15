// 电脑操控「正在写」草稿：真浏览器里跑真的 streamCompletion，fetch 换成按剧本吐的 SSE。
//
// 守的几件事：
//   · 草稿边流边画（她能看着代码一行行出来），真工具事件一到整段剪掉，不画两遍
//   · live 帧不算 evIndex —— 服务端 runLive 不进缓冲，算进去的话重连 from 多跳，静默漏掉真事件
//   · 流断/按停止时草稿剪干净，半截代码不会被当正文落盘
//
// 跑法：
//   1) GRANCYAN_PORT=3931 GRANCYAN_PORT_TLS=3932 node server.js
//   2) STK_PORT=3931 node tests/browser-tool-draft.js

const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9348;
const PORT = process.env.STK_PORT || 3097;
const URL = `http://127.0.0.1:${PORT}/`;

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-tooldraft-profile')}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => {
  console.error('\n❌ 超过 120 秒还没跑完，判定卡死');
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
}, 120000);
let pass = 0, fail = 0;
const t = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n, extra ?? '')); };

(async () => {
  let ws;
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const p = l.find(x => x.type === 'page' && x.url.includes(String(PORT)));
      if (p && p.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
    } catch (_) {}
    await sleep(500);
  }
  if (!ws) throw new Error(`等不到 CDP —— server 起了吗？(${URL})`);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const rpc = (m, p) => new Promise((res, rej) => {
    const my = ++id;
    const on = e => { const x = JSON.parse(e.data); if (x.id !== my) return;
      ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); };
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
  });
  const ev = async expr => {
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 挂了');
    return r.result.value;
  };
  await rpc('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    if (await ev(`typeof streamCompletion === 'function' && typeof toolDraftMd === 'function' && typeof renderBlocksHtml === 'function'`)) break;
    await sleep(400);
  }

  console.log('\n[1] toolDraftMd 抠半截 JSON');
  const md1 = await ev(`toolDraftMd('Write', '{"file_path": "D:\\\\\\\\x\\\\\\\\a.js", "content": "const a = 1;\\\\nconst s = \\\\"hi')`);
  t('认出文件路径', md1.includes('`D:\\x\\a.js`'), md1);
  t('内容解了转义（\\n 成换行、\\" 成引号）', md1.includes('const a = 1;\nconst s = "hi'), md1);
  t('按扩展名标语言', md1.includes('```js\n'), md1);
  const md2 = await ev(`toolDraftMd('Write', '{"file_path": "a.md", "content": "看 \\\\u4f60\\\\u')`);
  t('末尾半个 \\u 转义剪掉不炸', md2.includes('看 你') && !md2.includes('\\u'), md2);
  const md3 = await ev(`toolDraftMd('Write', '{"file_path": "a.md", "content": "前\\\\n\`\`\`js\\\\nx\\\\n\`\`\`\\\\n后')`);
  t('代码里自带 ``` 时围栏更长，不会写到一半就关掉', /\n````md\n/.test(md3), md3);
  t('读文件这类不出草稿', await ev(`toolDraftMd('Read', '{"file_path": "a.js"}') === ''`));
  const long = await ev(`toolDraftMd('Write', JSON.stringify({file_path:'a.py', content: Array.from({length:200},(_, i)=>'line'+i).join('\\n')}).slice(0,-2))`);
  t('长文件只留最后 80 行', long.includes('前面 120 行') && long.includes('line199') && !long.includes('line100\n'), long.slice(0, 120));

  // 剧本 SSE：frames 里每一项是 [延迟ms, 对象 | 'END']；'END' = 不发 done 直接断流
  await ev(`(()=>{
    window.__sse = (frames, signal) => new Response(new ReadableStream({ async start(c) {
      const enc = new TextEncoder();
      for (const [ms, f] of frames) {
        await new Promise(r => setTimeout(r, ms));
        if (signal && signal.aborted) { c.error(new DOMException('aborted', 'AbortError')); return; }
        if (f === 'END') { c.close(); return; }
        c.enqueue(enc.encode('data: ' + JSON.stringify(f) + '\\n\\n'));
      }
      c.close();
    }}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    window.__realFetch = window.__realFetch || window.fetch;
    window.__urls = [];
    window.__script = {};
    window.fetch = (u, o) => { u = String(u); window.__urls.push(u);
      for (const k of Object.keys(__script)) if (u.includes(k)) return Promise.resolve(__sse(__script[k], o && o.signal));
      return __realFetch(u, o); };
    window.__conf = { id: 'tdconf', isLocalClaude: true, nickname: 't' };
    return true;
  })()`);

  console.log('\n[2] 一轮完整的：草稿边流边画 → 真工具事件到了剪掉');
  const r2 = await ev(`(async()=>{
    __script = { '/api/local-claude': [
      [0, { runId: 'tdr1', resumeFrom: 0, kind: 'chat' }],
      [10, { delta: '我来写。' }],
      [10, { toolDraftStart: 'Write', live: true }],
      [10, { toolDraft: '{"file_path": "D:\\\\\\\\x\\\\\\\\a.js", "content": "const a', live: true }],
      [10, { toolDraft: ' = 1;\\\\nconst b = 2', live: true }],
      [10, { tool: { name: 'Write', input: { file_path: 'D:\\\\x\\\\a.js', content: 'const a = 1;\\nconst b = 2' } } }],
      [10, { delta: '好了' }],
      [10, { done: true }],
    ]};
    const snaps = [];
    const chat = { id: 'tdchat', agentMode: true, nodes: {} };
    const out = await streamCompletion(__conf, [{ role: 'user', content: 'hi' }], (txt, th, blks) => {
      const box = document.createElement('div'); box.innerHTML = renderBlocksHtml(blks, true);
      snaps.push({ txt, pre: [...box.querySelectorAll('pre')].map(p => p.textContent).join('|') });
    }, undefined, chat);
    return { snaps, full: out.fullText, blocksText: out.blocks.map(b => b.text).join(''), err: out.error };
  })()`);
  const live = r2.snaps.filter(s => s.txt.includes('正在写'));
  t('流的途中出现了「✍️ 正在写」', live.length >= 2, r2.snaps.map(s => s.txt));
  t('★ 草稿是渐进的：先只有 const a，后来有了 const b', live.some(s => s.txt.includes('const a') && !s.txt.includes('const b')) && live.some(s => s.txt.includes('const b = 2')));
  t('草稿真的画成了代码块', live.some(s => s.pre.includes('const b = 2')), live.map(s => s.pre));
  t('★ 结束后 fullText 里没有草稿', !r2.full.includes('正在写'), r2.full);
  t('★ blocks 里也没有草稿（渲染只看 blocks）', !r2.blocksText.includes('正在写'), r2.blocksText);
  t('正文和 🔧 块都在、顺序对', /^我来写。[\s\S]*🔧 Write[\s\S]*好了$/.test(r2.full), r2.full);
  t('没报错', !r2.err, r2.err);

  console.log('\n[3] 写到半截断线：重连 from 不算 live 帧');
  const r3 = await ev(`(async()=>{
    __urls = [];
    __script = {
      '/api/local-claude': [
        [0, { runId: 'tdr2', resumeFrom: 0, kind: 'chat' }],
        [10, { delta: '开始' }],
        [10, { toolDraftStart: 'Write', live: true }],
        [10, { toolDraft: '{"file_path": "b.js", "content": "x', live: true }],
        [10, 'END'],
      ],
      '/api/agent-run/tdr2': [
        [0, { runId: 'tdr2', resumeFrom: 0, kind: 'chat' }],
        [10, { tool: { name: 'Write', input: { file_path: 'b.js' } } }],
        [10, { done: true }],
      ],
    };
    const chat = { id: 'tdchat2', agentMode: true, nodes: {} };
    const out = await streamCompletion(__conf, [{ role: 'user', content: 'hi' }], () => {}, undefined, chat);
    return { urls: __urls.filter(u => u.includes('agent-run')), full: out.fullText, err: out.error };
  })()`);
  const re = r3.urls.find(u => u.includes('/api/agent-run/tdr2?'));
  t('断线后去接了', !!re, r3.urls);
  t('★ 重连 from=1（只算了「开始」那一条真事件，live 帧不算）', re && /from=1&/.test(re), re);
  t('接回来之后草稿没了、🔧 块在', !r3.full.includes('正在写') && r3.full.includes('🔧 Write'), r3.full);

  console.log('\n[4] 写到半截她按停止');
  const r4 = await ev(`(async()=>{
    __script = { '/api/local-claude': [
      [0, { runId: 'tdr3', resumeFrom: 0, kind: 'chat' }],
      [10, { delta: '开始' }],
      [10, { toolDraftStart: 'Write', live: true }],
      [10, { toolDraft: '{"file_path": "c.js", "content": "half', live: true }],
      [3000, { done: true }],
    ]};
    const chat = { id: 'tdchat3', agentMode: true, nodes: {} };
    let seenDraft = false;
    const p = streamCompletion(__conf, [{ role: 'user', content: 'hi' }], (txt) => { if (txt.includes('正在写')) seenDraft = true; }, undefined, chat);
    await new Promise(r => setTimeout(r, 300));
    for (const c of [..._streamControllers]) if (c.gcChat === chat) c.abort();
    const out = await p;
    return { seenDraft, full: out.fullText, blocksText: (out.blocks || []).map(b => b.text).join(''), aborted: out.aborted };
  })()`);
  t('停之前草稿出现过（前置条件）', r4.seenDraft);
  t('认成了停止', r4.aborted === true, r4);
  t('★ 停止后正文里没有半截代码', !r4.full.includes('正在写') && !r4.blocksText.includes('half'), r4);

  await ev(`window.fetch = __realFetch; true`);
  console.log(`\n${pass} 过 / ${fail} 挂`);
  clearTimeout(WATCHDOG); ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { chrome.kill(); } catch (_) {} process.exit(1); });
