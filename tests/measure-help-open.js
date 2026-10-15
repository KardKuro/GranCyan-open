/* 量「点开功能指南」到画面真的出来，中间隔了多久，并做 blur 的对照实验。
 *
 * 用户报的是「侧边栏 UI 显示得很慢，很久才会出现」。怀疑对象是两层
 * backdrop-filter（#helpModal 全屏 blur(20px) + .help-panel blur(32px)），
 * 但怀疑不算证据 —— 这个脚本就是拿证据的。
 *
 * 手法：CDP 连 headless Chrome，先灌一屏假消息把底下撑满（blur 的代价跟
 * 底下内容量成正比，空页面上量不出问题），再 toggleHelp()，
 * 用 requestAnimationFrame 等到**下一帧真的画完**才停表。
 *
 * ⚠️ 每组都**重新加载页面**再量第一次。首次打开要建合成层 + 给 164 行内容
 *    做第一次布局，这一下比后面几次贵一个数量级 —— 而人抱怨的正是这一下。
 *    只量稳态中位数会把真正的痛点洗掉。
 *
 * 跑法：先 GRANCYAN_PORT=3099 node server.js，再 node tests/measure-help-open.js
 */
const PORT = process.env.GC_PORT || 3099;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9223, path }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9223',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + require('os').tmpdir() + '\\gc-help-measure',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(250);
    try { targets = await get('/json/list'); } catch {}
  }
  if (!targets) { console.error('连不上 Chrome'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes(`127.0.0.1:${PORT}/`));

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', m => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function send(method, params) {
    const i = ++id;
    return new Promise(r => { pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  await send('Runtime.enable');

  // 底下先撑满：blur 要模糊的是它下面的东西，空页面量不出真实代价
  const FILL = `(() => {
    const win = document.getElementById('messagesWindow') || document.body;
    let h = '';
    for (let i = 0; i < 300; i++) {
      h += '<div data-msg-wrapper="' + i + '"><div class="bubble ai" style="padding:14px;margin:8px">'
        + '假消息 ' + i + '：' + '内容'.repeat(40) + '</div></div>';
    }
    win.insertAdjacentHTML('beforeend', h);
    return win.children.length;
  })()`;

  // 一次「打开」的耗时：停表停在**下一帧合成完**，不是 toggleHelp() 返回时
  const ONCE = `new Promise(res => {
    const m = document.getElementById('helpModal');
    m.classList.add('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t0 = performance.now();
      toggleHelp();
      requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
    }));
  })`;

  /* 把改动**退回去**，量出「修之前长什么样」：两层 blur 加回来 + 拆掉预热。
     反过来做（在旧代码上模拟新版）会漏掉真实生效路径，这样量的是源文件里真的那份。 */
  const AS_BEFORE = `(() => {
    document.getElementById('helpModal').classList.remove('warm');
    const s = document.createElement('style');
    s.id = 'oldBlurProbe';
    s.textContent = '#helpModal{backdrop-filter:blur(20px)!important;-webkit-backdrop-filter:blur(20px)!important}'
      + '.help-panel{backdrop-filter:blur(32px)!important;-webkit-backdrop-filter:blur(32px)!important}'
      + '#helpModal.hidden.warm{display:none!important}';
    document.head.appendChild(s);
    return true;
  })()`;

  // 预热是 idle 里跑的，量之前先确认它真的挂上了 —— 没挂上的话这组白量
  const WARM_OK = `!!document.getElementById('helpModal')?.classList.contains('warm')`;

  /* ⚠️ 测量顺序会污染结果，这一段是踩过才写的。
     第一版脚本是「A 组跑完跑 B 组」，量出来 A=740ms、B=424ms，看着 B 快一大截。
     可把两组对调之后，**还是先跑的那组慢** —— 慢的根本不是 A，是「第一个」：
     浏览器进程冷启动、字体首次光栅化、V8 还没 JIT，全记在第一组头上。
     所以：先跑一轮结果**直接丢掉**的 warmup，再 A/B 交替若干轮取中位数。 */
  async function once(label, prep) {
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(7000);                       // 等 boot + idle 预热（预热排在 2.5s 之后）
    await evaluate(FILL);
    if (prep) await evaluate(prep);
    await sleep(800);
    const warm = await evaluate(WARM_OK);
    const first = await evaluate(ONCE);      // 冷开这一下才是人抱怨的那下
    const rest = [];
    for (let i = 0; i < 4; i++) { await sleep(400); rest.push(await evaluate(ONCE)); }
    rest.sort((a, b) => a - b);
    return { label, first, warm, med: rest[Math.floor(rest.length / 2)] };
  }

  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  process.stdout.write('预热轮（结果丢弃）… ');
  await once('warmup', null);
  console.log('好了');

  const ROUNDS = 3;
  const A = [], B = [];
  for (let i = 0; i < ROUNDS; i++) {
    process.stdout.write(`第 ${i + 1}/${ROUNDS} 轮… `);
    // 每轮内部也换先后手，把「同一轮里谁先跑」的残余偏差也摊掉
    if (i % 2 === 0) { A.push(await once('after', null)); B.push(await once('before', AS_BEFORE)); }
    else { B.push(await once('before', AS_BEFORE)); A.push(await once('after', null)); }
    console.log('好了');
  }

  const rep = (label, rs) => ({
    label,
    first: med(rs.map(r => r.first)),
    steady: med(rs.map(r => r.med)),
    firsts: rs.map(r => r.first),
    warm: rs.every(r => r.warm),
  });
  const before = rep('改之前（两层 blur，无预热）', B);
  const after = rep('改完（无 blur + 预热）', A);

  console.log(`\n底下垫 300 条消息，点开功能指南 → 画面出来`);
  console.log(`（headless 无 GPU；丢弃 1 轮 warmup 后 A/B 交替 ${ROUNDS} 轮，取中位数）\n`);
  for (const r of [before, after]) {
    console.log(`  ${r.label}`);
    console.log(`    冷开第一次：${r.first.toFixed(1)} ms   (各轮 ${r.firsts.map(t => t.toFixed(0)).join(', ')})`);
    console.log(`    之后中位数：${r.steady.toFixed(1)} ms`);
  }
  const d1 = before.first - after.first, d2 = before.steady - after.steady;
  console.log(`\n  冷开：${d1 >= 0 ? '省了' : '反而慢了'} ${Math.abs(d1).toFixed(1)} ms`
    + `（${(100 * Math.abs(d1) / before.first).toFixed(0)}%）`);
  console.log(`  稳态：${d2 >= 0 ? '省了' : '反而慢了'} ${Math.abs(d2).toFixed(1)} ms`
    + `（${(100 * Math.abs(d2) / before.steady).toFixed(0)}%）`);
  // 预热没挂上的话上面那组数字是假的 —— 明说，别让它悄悄混过去
  console.log(`\n  预热每轮都真的挂上了：${after.warm ? '是' : '❌ 否（这组数字不算数）'}`);

  ws.close(); chrome.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
