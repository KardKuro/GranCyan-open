/* 飞行棋的浏览器冒烟：真的在 Chrome 里开面板、真的点掷骰子，看 DOM 有没有按预期长出来。
 *
 * 为什么必须在浏览器里跑：单测那份（tests/ludo.test.js）是 vm 沙箱，document 全是桩，
 * 验的是**规则**。而「renderLudo 拼出来的 HTML 能不能被浏览器解析成 20 个格子」
 * 「grid 坐标会不会把格子叠在一起」「掷骰之后棋子有没有真的换格」这三件事，
 * 桩里怎么摆都验不出来——模板里少一个引号，单测照样全绿，页面已经是白的了。
 *
 * 跑法：node tests/browser-ludo.js   （脚本自己起 server 和 Chrome，跑完自己收拾）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.GC_PORT || 3099;
const CDP = 9226;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
// 主页返回的是 HTML，不能拿 JSON 解析器去探活（踩过：永远解析失败→重试到耗尽）
function ping(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => { r.resume(); res(r.statusCode); }).on('error', rej);
  });
}
async function waitPort(port, p, tries = 90) {
  for (let i = 0; i < tries; i++) { try { await ping(port, p); return true; } catch { await sleep(500); } }
  throw new Error(`端口 ${port} 起不来`);
}
async function waitJson(port, p, tries = 90) {
  for (let i = 0; i < tries; i++) { try { return await getJson(port, p); } catch { await sleep(500); } }
  throw new Error(`端口 ${port} 的 ${p} 拿不到 JSON`);
}

(async () => {
  // 用 127.0.0.1 不用 localhost：localhost 走 ::1 会撞上 wslrelay，返回空回复（踩过）
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, GRANCYAN_PORT: String(PORT) }, stdio: 'ignore',
  });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'gc-ludo-smoke'),
    '--window-size=1280,1600', `http://127.0.0.1:${PORT}/`,
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
  process.on('exit', cleanup);

  try {
    await waitPort(PORT, '/');
    const tabs = await waitJson(CDP, '/json/list');
    const page = tabs.find(t => t.type === 'page' && t.url.includes(String(PORT)));
    if (!page) throw new Error('没找到页面标签');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

    let id = 0; const waiting = new Map();
    ws.on('message', m => {
      const msg = JSON.parse(m);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    });
    const send = (method, params) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'JS 抛错');
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    for (let i = 0; i < 40 && !(await evalJs('typeof openLudo==="function"')); i++) await sleep(500);

    console.log('\n[飞行棋 · 浏览器冒烟]');
    ok(await evalJs('typeof openLudo==="function"'), '39-ludo.js 真的被页面加载了');

    // 骰子定死，不然每次跑的结果都不一样，红了也说不清是 bug 还是运气
    await evalJs('window.__r=Math.random;Math.random=()=>0.9999;localStorage.removeItem("grancyan_ludo");openLudo()');
    await sleep(400);

    ok(await evalJs('!document.getElementById("ludoModal").classList.contains("hidden")'), '面板真的打开了');
    ok(await evalJs('document.querySelectorAll("#ludoBody .ludo-cell").length===20'), '棋盘渲染出 20 个格子');
    ok(await evalJs('new Set([...document.querySelectorAll("#ludoBody .ludo-cell")].map(e=>e.style.gridRow+"/"+e.style.gridColumn)).size===20'),
       '20 个格子各占一个 grid 坐标，没有叠在一起');
    ok(await evalJs('!!document.querySelector("#ludoBody .ludo-die")&&!!document.getElementById("ludoRollBtn")'), '骰子和掷骰按钮都在');
    ok(await evalJs('document.querySelectorAll("#ludoBody .ludo-runway i").length===8'), '两条终点道各四格');
    ok(await evalJs('document.querySelectorAll("#ludoBody .ludo-runway em").length===2'), '两条终点道各自标了归属');

    // 格子真的有可见面积——模板拼错时格子会被压成 0 高，DOM 数得对但页面是空的
    ok(await evalJs('[...document.querySelectorAll("#ludoBody .ludo-cell")].every(e=>e.getBoundingClientRect().height>10)'),
       '每个格子都有可见高度（不是被压扁的空壳）');

    // 掷骰：Math.random 定死成 6，两架都在停机坪 → 一架起飞到第 1 步
    ok(await evalJs('_ludo.planes.user.join()==="0,0"'), '开局两架都在停机坪');
    await evalJs('ludoRoll()');
    await sleep(2200);
    ok(await evalJs('_ludo.lastRoll===6'), '掷出的点数进了状态');
    ok(await evalJs('_ludo.planes.user.filter(s=>s>0).length===1'), '掷 6 之后真的有一架起飞了');
    // 飞机现在是 SVG 剪影，不再是 emoji 文字，所以数的是 .ludo-plane 而不是 textContent
    ok(await evalJs('document.querySelectorAll("#ludoBody .ludo-pawns .ludo-plane").length===1'),
       '起飞的飞机画在了格子上（正好一架）');
    ok(await evalJs('(()=>{const d=document.querySelector("#ludoBody .ludo-die");return d.dataset.face==="6"&&getComputedStyle(d,"::before").width!=="auto"})()'),
       '骰子的点数落到了 data-face 上（CSS 靠它画点）');

    // 换版本：换的是文案，不是规则
    const before = await evalJs('JSON.stringify(_ludo.planes)');
    await evalJs('ludoSetTheme("maid")');
    await sleep(300);
    ok(await evalJs(`JSON.stringify(_ludo.planes)===${JSON.stringify(before)}`), '换版本不动棋子位置');
    ok(await evalJs('document.querySelector("#ludoBody .ludo-room-title span").textContent.includes("女仆值班表".toUpperCase())||document.querySelector("#ludoBody .ludo-room-title span").textContent.includes("女仆值班表")'),
       '换版本之后标题跟着换了');

    // 深色：取**普通格**量。起飞点/跳格/航线格本来就要着主题色，拿它们量等于量主题色亮不亮
    const bg = await evalJs('getComputedStyle(document.querySelector("#ludoBody .ludo-room")).backgroundImage+"|"+getComputedStyle(document.querySelector("#ludoBody .ludo-cell.plain")).backgroundColor');
    const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg.split('|')[1]);
    ok(rgb && (+rgb[1] + +rgb[2] + +rgb[3]) / 3 < 90, '格子底色是深色（均值 ' + (rgb ? Math.round((+rgb[1] + +rgb[2] + +rgb[3]) / 3) : '?') + '）');

    // 出图给用户看
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot.result?.data) {
      require('fs').mkdirSync(path.join(ROOT, 'tests/out'), { recursive: true });
      const out = path.join(ROOT, 'tests/out/ludo.png');
      require('fs').writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log('  📷 截图: ' + out);
    }

    await evalJs('Math.random=window.__r');
    ws.close();
  } catch (e) {
    fail++; console.error('  ✗ 冒烟本身炸了：' + e.message);
  } finally { cleanup(); }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
