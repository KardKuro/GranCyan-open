// 流式时思考框的滚动条别被弹回顶上（真浏览器量 scrollTop，源码断言答不了这个）。
//
// 以前 _paintLiveBubble 每 60ms 整块 innerHTML 重画，.think-body（max-height:400 自带滚动条）
// 每次都是新节点 —— 她拖到底，下一帧就回到顶上。现在思考块原地改，节点不换。
//
// 不碰她的对话和 state：只在 body 上挂一个临时气泡，直接调 _paintLiveBubble。
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3931 GRANCYAN_PORT_TLS=3932 node server.js
//   2) STK_PORT=3931 node tests/browser-think-scroll.js
//   FAULT=1 时把补丁换回整块 innerHTML，断言应该红（验这份测试真的抓得住）。

const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9347;
const PORT = process.env.STK_PORT || 3097;
const URL = `http://127.0.0.1:${PORT}/`;
const FAULT = process.env.FAULT === '1';

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-thinkscroll-profile')}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => {
  console.error('\n❌ 超过 90 秒还没跑完，判定卡死');
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
}, 90000);
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
    if (await ev(`typeof _paintLiveBubble === 'function' && typeof renderBlocksHtml === 'function'`)) break;
    await sleep(400);
  }
  if (FAULT) { await ev(`_patchLiveBubble = (b, h) => { b.innerHTML = h; }; true`); console.log('  （FAULT=1：补丁换回了整块 innerHTML）'); }

  // 气泡挂在 body 上、给足宽度；思考框要真的有尺寸，scrollTop 才有意义
  await ev(`(()=>{
    const b=document.createElement('div'); b.id='bubble-tscroll';
    b.style.cssText='position:fixed;left:0;top:0;width:420px;z-index:99999;background:#111';
    document.body.appendChild(b);
    window.__tsLines = n => Array.from({length:n},(_, i)=>'第'+i+'行 想了想').join('\\n');
    window.__tsPaint = (n, streaming=true, extra=[]) => _paintLiveBubble('bubble-tscroll', '', '', streaming,
      [{type:'thinking', text: __tsLines(n)}, ...extra]);
    window.__tsBody = () => document.querySelector('#bubble-tscroll .think-body');
    window.__tsAtBottom = () => { const b=__tsBody(); return b.scrollHeight - b.scrollTop - b.clientHeight < 2; };
    return true;
  })()`);

  console.log('\n[1] 一开始短，越写越长：停在底部就跟着往下走');
  await ev(`__tsPaint(3)`);
  await ev(`window.__tsNode = __tsBody(); true`);
  await ev(`__tsPaint(80)`);
  t('思考框确实出了滚动条（前置条件）', await ev(`__tsBody().scrollHeight > __tsBody().clientHeight + 50`),
    await ev(`[__tsBody().scrollHeight, __tsBody().clientHeight]`));
  t('★ 重画后还是同一个 .think-body 节点（没被整块换掉）', await ev(`__tsBody() === __tsNode`));
  t('★ 原来在底部 → 新字来了还在底部', await ev(`__tsAtBottom()`), await ev(`__tsBody().scrollTop`));

  console.log('\n[2] 她往上翻了：停在她翻到的地方');
  await ev(`__tsBody().scrollTop = 120; true`);
  await ev(`__tsPaint(120)`);
  t('★ 往上翻到 120 → 再来新字仍是 120，不弹回顶上也不拽到底', await ev(`__tsBody().scrollTop === 120`), await ev(`__tsBody().scrollTop`));

  console.log('\n[3] 她又拖回最底下');
  await ev(`__tsBody().scrollTop = __tsBody().scrollHeight; true`);
  await ev(`__tsPaint(160)`);
  t('★ 拖到底 → 新字来了还贴着底', await ev(`__tsAtBottom()`), await ev(`[__tsBody().scrollTop, __tsBody().scrollHeight]`));

  console.log('\n[4] 她手动收起来了，流式重画别再弹开');
  await ev(`_thinkToggle(document.querySelector('#bubble-tscroll .think-toggle')); true`);
  await ev(`__tsPaint(170)`);
  t('★ 收起之后重画还是收着', await ev(`!document.querySelector('#bubble-tscroll .think-block').classList.contains('open')`));

  console.log('\n[5] 正文开始流：思考块收成 done，正文照常出来');
  await ev(`__tsPaint(170, true, [{type:'text', text:'好的小明，\\n\\n\`\`\`js\\nconst a = 1;'}])`);
  t('思考块标成 done', await ev(`document.querySelector('#bubble-tscroll .think-block').classList.contains('done')`));
  t('正文里的代码块流出来了', await ev(`(document.querySelector('#bubble-tscroll pre')||{}).textContent?.includes('const a = 1')`));
  await ev(`__tsPaint(170, false, [{type:'text', text:'好的小明，\\n\\n\`\`\`js\\nconst a = 1;\\n\`\`\`'}])`);
  t('流结束：没有残留的流式光标', await ev(`!document.querySelector('#bubble-tscroll .stream-cursor')`));
  t('流结束：内容完整', await ev(`document.querySelector('#bubble-tscroll pre').textContent.includes('const a = 1')`));

  await ev(`document.getElementById('bubble-tscroll').remove(); true`);
  console.log(`\n${pass} 过 / ${fail} 挂`);
  clearTimeout(WATCHDOG); ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { chrome.kill(); } catch (_) {} process.exit(1); });
