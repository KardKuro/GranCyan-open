/* 角标可见性的渲染层判据：单测只能验 CSS 源码正则，验不出
 * 「规则到底盖没盖住那个元素」。这里在真渲染器里量 computed opacity。
 * 只加载 css/grancyan.css + 手搭最小 DOM —— 不跑项目 JS，免得别的报错混进来。
 *
 * 跑法：node tests/browser-lyric-hover.js （不进 npm test，要开真 Chrome） */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const BS = String.fromCharCode(92);   // 反斜杠：这台机器上写字面量会被层层吃掉
const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'grancyan.css'), 'utf8');
const CHROME = process.env.CHROME_PATH || ['C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'].join(BS);
const PORT = 9231;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

const HTML = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111}\n' + CSS + '\n</style>'
  + '<div class="music-lyric" id="box" style="height:200px">'
  + '<div class="music-ly-line" id="L0" data-t="0"><i class="ly-t"><b>&#9656;</b>0:00</i><div class="ly-main">first line</div></div>'
  + '<div class="music-ly-line on" id="L1" data-t="61.5"><i class="ly-t"><b>&#9656;</b>1:01</i><div class="ly-main">playing line</div></div>'
  + '<div class="music-ly-line" id="L2" data-t="90"><i class="ly-t"><b>&#9656;</b>1:30</i><div class="ly-main">third line</div></div>'
  + '</div>';
const file = path.join(os.tmpdir(), 'gc-ly-hover.html');
fs.writeFileSync(file, HTML, 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  [ok] ' + n); }
  else { fail++; console.log('  [XX] ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=900,700',
    '--user-data-dir=' + path.join(os.tmpdir(), 'gc-ly-hover-profile'),
    'file:///' + file.split(BS).join('/')], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('Chrome 没起来'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('gc-ly-hover'));
  if (!page) { console.error('没找到页面', targets.map(t => t.url)); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result && r.result.result.value;
  };
  const op = sel => js("getComputedStyle(document.querySelector('" + sel + "')).opacity");
  const pe = sel => js("getComputedStyle(document.querySelector('" + sel + "')).pointerEvents");
  const hover = async sel => {
    const b = await js("(()=>{const r=document.querySelector('" + sel + "').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, buttons: 0 });
    await sleep(360);   // 盖过 .ly-t 那条 .16s 的 opacity 过渡——量早了会读到淡出途中的 0.014
  };

  // 先确认探针本身站得住：DOM 在、CSS 进来了。少了这一步，下面全 0 会被读成「功能对」
  let sane = null;
  for (let i = 0; i < 24 && sane !== 'relative'; i++) {
    await sleep(250);
    sane = await js("document.querySelector('#L1 .ly-t') ? getComputedStyle(document.querySelector('.music-ly-line')).position : 'no-dom:' + document.readyState");
  }
  if (sane !== 'relative') { console.error('探针自身不成立（DOM 或 CSS 没进来）:', sane); chrome.kill(); process.exit(1); }

  console.log('\n[env] 渲染器报告的指针能力');
  const hv = await js("matchMedia('(hover:hover)').matches");
  console.log('   hover:hover = ' + hv);
  if (!hv) { console.error('这个渲染器报 hover:none，下面 hover 那几条不成立'); chrome.kill(); process.exit(1); }

  console.log('\n[1] 静息：一个角标都不该亮 —— 当前句也不例外');
  await hover('body');
  const r0 = await op('#L0 .ly-t'), r1 = await op('#L1 .ly-t');
  ok(r0 === '0', '普通行 opacity=0', r0);
  ok(r1 === '0', '当前播放行 opacity=0（老样子是 .6，那正是「播到哪哪显示」）', r1);

  console.log('\n[2] 鼠标悬到哪一行，哪一行浮出');
  await hover('#L2 .ly-main');
  const a0 = await op('#L0 .ly-t'), a1 = await op('#L1 .ly-t'), a2 = await op('#L2 .ly-t');
  ok(+a2 > 0.5, '悬停行浮出来了', a2);
  ok(a0 === '0' && a1 === '0', '别的行（含当前句）仍然 0 —— 只有指针下那一行', { L0: a0, L1: a1 });
  ok(await pe('#L2 .ly-t') === 'auto', '浮出来之后才接点击');
  ok(await pe('#L0 .ly-t') === 'none', '看不见的角标不接点击');

  console.log('\n[3] 换一行，跟着指针走');
  await hover('#L0 .ly-main');
  const b0 = await op('#L0 .ly-t'), b2 = await op('#L2 .ly-t');
  ok(+b0 > 0.5 && b2 === '0', '角标跟着指针换了行', { L0: b0, L2: b2 });

  console.log('\n[4] 手指那侧：.ly-scrub 打上去整片浮出');
  await hover('body');
  await js("document.getElementById('box').classList.add('ly-scrub')");
  await sleep(100);
  const s0 = await op('#L0 .ly-t'), s2 = await op('#L2 .ly-t');
  ok(+s0 > 0 && +s2 > 0, '三行一起浮出（手指没有 hover，只能整片给）', { L0: s0, L2: s2 });
  ok(+s0 < 0.9, '压得比鼠标悬停那档淡（不是常显噪点）', s0);
  await js("document.getElementById('L2').classList.add('ly-holding')");
  await sleep(100);
  const hold = await op('#L2 .ly-t');
  ok(+hold > +s0, '手指正按着的那一行再亮一档', { holding: hold, rest: s0 });

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + '  ' + pass + ' passed, ' + fail + ' failed');
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
