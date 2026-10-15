// 淡墨出字（70-ink.js）真浏览器验：字是不是真的排队慢放、重画后接得上、收尾放完才出页脚。
// 源码断言答不了这些 —— 要量的是 display / 透明度 / 节奏。
//
// 不碰她的对话和 state：在 body 上挂一个临时的 .msg-group + 气泡，直接调 _paintLiveBubble / renderLiveBubble。
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3931 GRANCYAN_PORT_TLS=3932 node server.js
//   2) INK_PORT=3931 node tests/browser-ink.js
//   FAULT=1 时把 inkPaint 换成空函数（＝没蒙墨），★ 断言应该红。

const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9351;
const PORT = process.env.INK_PORT || 3931;
const URL = `http://127.0.0.1:${PORT}/`;
const FAULT = process.env.FAULT === '1';

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-ink-profile')}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--window-size=900,900', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => { console.error('\n❌ 超过 150 秒还没跑完，判定卡死'); try { chrome.kill(); } catch (_) {} process.exit(1); }, 150000);
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
  await rpc('Page.enable');
  await rpc('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    if (await ev(`typeof _paintLiveBubble === 'function' && typeof inkPaint === 'function' && typeof state === 'object'`)) break;
    await sleep(400);
  }
  if (FAULT) { await ev(`inkPaint = () => {}; true`); console.log('  （FAULT=1：inkPaint 换成了空函数）'); }

  const fps = await ev(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 500 ? requestAnimationFrame(f) : r(n * 2); }; requestAnimationFrame(f); })`);
  console.log(`  （rAF ≈ ${fps} 帧/秒）`);

  await ev(`(()=>{
    state.inkStream = true; state.inkRate = 14;
    const g=document.createElement('div'); g.className='msg-group ai'; g.id='ink-g';
    g.style.cssText='position:fixed;left:0;top:0;width:520px;z-index:99999;background:#111;color:#eee';
    g.innerHTML='<div class="bubble ai" id="bubble-inktest" data-msg-id="inktest"></div><div class="msg-token-info">~123 tokens</div>';
    document.body.appendChild(g);
    window.__B = () => document.getElementById('bubble-inktest');
    // 看得见的字：不在 display:none 里的文本
    window.__vis = () => { let n = 0; const w = document.createTreeWalker(__B(), NodeFilter.SHOW_TEXT);
      for (let x = w.nextNode(); x; x = w.nextNode()) { let e = x.parentElement, hid = false;
        for (; e && e !== __B().parentElement; e = e.parentElement) if (getComputedStyle(e).display === 'none') { hid = true; break; }
        if (!hid) n += x.data.replace(/\\s/g,'').length; } return n; };
    window.__P1 = '窗外起风了，树影在窗帘上一晃一晃的。靠窗的位置光线刚好，书翻到一半，茶还冒着一点热气。';
    window.__P2 = '那就先读完这一章。**再续一杯茶**，等雨停了我们再出门，顺路去看看街角那家旧书店。';
    window.__paint = (txt, streaming=true) => _paintLiveBubble('bubble-inktest', txt, '', streaming, [{type:'text', text: txt}]);
    return true;
  })()`);

  console.log('\n[1] 一大坨字同时到：不整段拍上来，排队慢放');
  await ev(`__paint(__P1 + '\\n\\n' + __P2); true`);
  const v0 = await ev(`__vis()`);
  t('★ 刚到的那一刻几乎什么都没露（≤3 个字）', v0 <= 3, v0);
  t('全文都在 DOM 里（复制/朗读拿 textContent 不受影响）', await ev(`__B().textContent.replace(/\\s/g,'').includes('顺路去看看街角那家旧书店')`));
  t('★ 第二段整段藏着（没放到的段落不占高度）', await ev(`getComputedStyle(__B().querySelectorAll('p')[1]).display === 'none'`));
  t('页脚 tokens 先藏着', await ev(`getComputedStyle(document.querySelector('#ink-g .msg-token-info')).visibility === 'hidden'`));
  await sleep(1500);
  const v1 = await ev(`__vis()`);
  t('★ 过 1.5 秒放出来十来个字（按每秒 14 字，标点处歇一口气）', v1 >= 8 && v1 <= 30, v1);
  t('流式光标跟在墨后头（在第一段里，不是挂在最后）', await ev(`!!__B().querySelector('p .stream-cursor')`));

  console.log('\n[2] 正在淡的字：重画换了节点也接着淡，不重新从透明开始');
  // 按「前面有几个字」认同一截（同一个字可能出现好几次，按字认会认错）
  await ev(`window.__off = el => { const r = document.createRange(); r.setStart(__B(), 0); r.setEndBefore(el); return r.toString().length; }; true`);
  const opBefore = await ev(`(()=>{ const s=[...__B().querySelectorAll('span.ink-f')]; const x=s[Math.floor(s.length/2)]; window.__inkOff=x&&__off(x); return x ? +getComputedStyle(x).opacity : -1; })()`);
  await ev(`__paint(__P1 + '\\n\\n' + __P2 + '好。'); true`);   // 来了新字 → 节点换掉重画
  const opAfter = await ev(`(()=>{ const x=[...__B().querySelectorAll('span.ink-f')].find(s=>__off(s)===__inkOff); return x ? +getComputedStyle(x).opacity : -1; })()`);
  t('★ 同一截字重画后透明度没掉回 0（负延时接着演）', opBefore > 0.05 && opAfter >= opBefore - 0.08, [opBefore, opAfter]);
  t('淡着的字的延时是负数', await ev(`[...__B().querySelectorAll('span.ink-f')].some(s => parseFloat(s.style.getPropertyValue('--ink-d')) < 0)`));

  console.log('\n[3] 写完了：队里剩下的字接着放，放完才出页脚');
  await ev(`renderLiveBubble('bubble-inktest', '', '', true, [{type:'text', text: __P1 + '\\n\\n' + __P2 + '好。'}], true); true`);
  const vEnd = await ev(`__vis()`);
  t('★ 收尾那一下没把剩下的全拍出来', vEnd < 60, vEnd);
  // 正式消息换掉节点（模拟 renderMessages：整条重画、去掉光标）
  await ev(`__B().innerHTML = renderBlocksHtml([{type:'text', text: __P1 + '\\n\\n' + __P2 + '好。'}], false); inkAfterRender(); true`);
  const vSwap = await ev(`__vis()`);
  t('★ 换成正式消息后接着同一份进度（没从头、也没全露）', vSwap >= vEnd - 2 && vSwap < 80, [vEnd, vSwap]);
  t('★ 模型写完了、墨还在放：光标还在（自己补的那个），跟在墨后头不在末尾',
    await ev(`(()=>{ const c=__B().querySelector('.stream-cursor'); return !!c && c.dataset.inkCur === '1' && c.parentNode !== __B(); })()`),
    await ev(`__B().innerHTML.slice(0,200)`));
  // 等放完：剩下 ~70 字，14 字/秒 + 停顿 + 最后一个字淡完 1.7 秒
  let done = false;
  for (let i = 0; i < 30 && !done; i++) { await sleep(500); done = await ev(`!inkBusy('bubble-inktest')`); }
  t('★ 最后全放完了', done && await ev(`__vis()`) === await ev(`__B().textContent.replace(/\\s/g,'').length`));
  t('墨揭干净了：没有残留的 span / 藏着的块', await ev(`!__B().querySelector('[data-ink], .ink-hide, .ink-atom')`));
  t('页脚出来了', await ev(`getComputedStyle(document.querySelector('#ink-g .msg-token-info')).visibility === 'visible'`));
  t('★ 放完了，补的光标也拿掉了', await ev(`!__B().querySelector('.stream-cursor')`));
  t('加粗还在（markdown 没被揭墨弄坏）', await ev(`(__B().querySelector('strong')||{}).textContent === '再续一杯茶'`));

  console.log('\n[3b] 模型还没写完、墨先追平了：光标回到末尾，不卡在半句话里');
  await ev(`__B().innerHTML=''; __paint('嗯，我在。'); true`);
  await sleep(1200);
  t('★ 追平以后光标是气泡最后一个节点', await ev(`(()=>{ const c=__B().querySelector('.stream-cursor'); return !!c && c.parentNode===__B() && !c.nextSibling; })()`),
    await ev(`__B().innerHTML.slice(-160)`));
  await sleep(2000);   // 最后一个字也淡完了，模型还在想
  // 数一秒里循环跑了几次：歇着的时候只剩每秒一次的心跳，空转的话是几十次
  const loops = await ev(`new Promise(r => { const orig = _inkLoop; let n = 0; _inkLoop = (t) => { n++; return orig(t); };
    setTimeout(() => { _inkLoop = orig; r(n); }, 1000); })`);
  t('★ 追平又淡完以后循环歇着（不每帧空转耗电），进度还留着等下一批', loops <= 3 && await ev(`inkBusy('bubble-inktest')`), loops);
  await ev(`__paint('嗯，我在。你慢慢说。'); true`);
  await sleep(150);
  t('来了新字又叫醒、接着慢放', await ev(`_inkRaf !== 0`) && await ev(`__vis()`) < 12, await ev(`__vis()`));
  await ev(`inkEnd('bubble-inktest'); true`);
  for (let i = 0; i < 12 && await ev(`inkBusy('bubble-inktest')`); i++) await sleep(300);

  console.log('\n[3c] 放完的段落再重画也不换节点（_patchLiveBubble 的「一样的不动」还管用）');
  await ev(`__B().innerHTML=''; inkFlush('bubble-inktest', 400); __paint(__P1 + '\\n\\n' + __P2); true`);
  await sleep(2300);   // 一口气放完 + 最后那批淡完
  await ev(`window.__p0 = __B().querySelector('p'); true`);
  t('揭完墨的段落上没留空的 class / style 属性', await ev(`!!__p0 && !__p0.hasAttribute('class') && !__p0.hasAttribute('style')`), await ev(`__p0 && __p0.outerHTML.slice(0,60)`));
  await ev(`__paint(__P1 + '\\n\\n' + __P2 + '嗯。'); true`);
  t('★ 第一段节点没被换掉', await ev(`__B().querySelector('p') === __p0`));
  t('inkFlush 那一阵到的字直接显出来', await ev(`__vis()`) >= 80, await ev(`__vis()`));
  await ev(`inkEnd('bubble-inktest'); true`);
  for (let i = 0; i < 12 && await ev(`inkBusy('bubble-inktest')`); i++) await sleep(300);

  console.log('\n[4] 离开过（切后台 / 切走）就别重演');
  await ev(`__B().innerHTML=''; __paint('第一句。第二句。第三句。第四句。第五句。第六句。第七句。'); true`);
  // 只是卡了一下（主线程堵 2 秒）不算离开：不许一口吐完
  await ev(`(()=>{ const t0=performance.now(); while (performance.now()-t0 < 2000); return true; })()`);
  await sleep(100);
  t('★ 卡了 2 秒不当成离开（不一口吐完）', await ev(`__vis()`) < 12, await ev(`__vis()`));
  await ev(`_inks.get('bubble-inktest').awayAt = performance.now() - 3000; true`);   // 假装切走了 3 秒
  await sleep(200);
  t('★ 回来时之前到的字直接显出来', await ev(`__vis()`) >= 20, await ev(`__vis()`));
  await ev(`inkEnd('bubble-inktest'); true`);
  for (let i = 0; i < 12 && await ev(`inkBusy('bubble-inktest')`); i++) await sleep(300);

  console.log('\n[4b] 桌面上切去别的窗口（失焦，页面没 hidden、rAF 照跑），回来也别接着慢放');
  await ev(`__B().innerHTML=''; __paint(__P1 + '\\n\\n' + __P2); true`);
  await sleep(300);
  // 走真的 blur / focus 事件；headless 开了焦点模拟 hasFocus 永远真，临时盖掉
  await ev(`document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); true`);
  await sleep(1800);   // 离开 1.8 秒，期间 rAF 照跑、_inkStep 每帧都在走
  const vAway = await ev(`__vis()`);
  t('失焦期间照常慢放（没被冻住也没一口吐完）', vAway > 3 && vAway < 50, vAway);
  await ev(`delete document.hasFocus; window.dispatchEvent(new Event('focus')); true`);
  await sleep(200);
  t('★ 回焦那一下，离开期间到的字全显出来', await ev(`__vis()`) === await ev(`__B().textContent.replace(/\\s/g,'').length`), await ev(`__vis()`));
  // 焦点只是进了页面里的 iframe：blur 照样来，但 document 还有焦点，不算离开
  await ev(`__paint(__P1 + '\\n\\n' + __P2 + '\\n\\n' + __P1); true`);
  await sleep(100);
  const vIf0 = await ev(`__vis()`);
  await ev(`window.dispatchEvent(new Event('blur')); true`);
  await sleep(1700);
  await ev(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(200);
  t('★ 焦点进 iframe（document 还有焦点）不算离开', await ev(`__vis()`) - vIf0 < 45, [vIf0, await ev(`__vis()`)]);
  await ev(`inkEnd('bubble-inktest'); true`);
  for (let i = 0; i < 20 && await ev(`inkBusy('bubble-inktest')`); i++) await sleep(300);

  console.log('\n[4c] 气泡所在的页被整个藏起来（display:none）再放出来');
  await ev(`__B().innerHTML=''; __paint(__P1 + '\\n\\n' + __P2); true`);
  await sleep(300);
  await ev(`document.getElementById('ink-g').style.display='none'; true`);
  await sleep(1800);
  await ev(`document.getElementById('ink-g').style.display=''; true`);
  await sleep(200);
  t('★ 放出来时藏着那阵到的字直接显出来', await ev(`__vis()`) === await ev(`__B().textContent.replace(/\\s/g,'').length`), await ev(`__vis()`));
  await ev(`inkEnd('bubble-inktest'); true`);

  console.log('\n[5] 关掉开关：完全不碰');
  for (let i = 0; i < 10 && await ev(`inkBusy('bubble-inktest')`); i++) await sleep(400);
  await ev(`state.inkStream = false; __B().innerHTML=''; __paint(__P1); true`);
  t('关着的时候字一来就全在', await ev(`__vis()`) === await ev(`__B().textContent.replace(/\\s/g,'').length`));
  t('关着的时候没起进度', await ev(`!inkBusy('bubble-inktest')`));

  await ev(`document.getElementById('ink-g').remove(); state.inkStream = true; true`);
  console.log(`\n${pass} 过 / ${fail} 挂`);
  clearTimeout(WATCHDOG); ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { chrome.kill(); } catch (_) {} process.exit(1); });
