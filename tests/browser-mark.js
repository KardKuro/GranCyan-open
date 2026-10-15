/* [[MARK:]] 的真浏览器冒烟。
 *
 * 为什么必须在真 Chrome 里跑：tests/mark-style.test.js 用 vm 抠源码跑，
 * 那里没有 document，_markDisplayColor 走的是 catch 分支里写死的 #141210 兜底。
 * 它验的是「算对比度的算法对」，验不了这三件事：
 *
 *   1. getComputedStyle 在真页面里到底取不取得到 --bg-surface（取不到就一直用兜底色，
 *      换了气泡主题之后钳制会按错误的底色算，而且零报错）；
 *   2. 拼出来的 style 字符串浏览器认不认 —— **非法 CSS 值是被静默丢弃的**，
 *      字符串断言全绿、画面上颜色根本没生效，这两者在 vm 里长得一模一样；
 *   3. 标注文字在真实气泡底色上到底看不看得见（这是这个功能唯一的意义）。
 *
 * 跑法：先 GRANCYAN_PORT=3097 node server.js，再 node tests/browser-mark.js
 */
const PORT = process.env.GC_PORT || 3097;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const { PNG } = require('pngjs');
const DEBUG_PORT = 9237;

const CHROME = process.env.CHROME_PATH
  || require('path').join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: DEBUG_PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

(async () => {
  const serverReady = () => new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      const good = r.statusCode === 200;
      r.resume();
      resolve(good);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
  let server = null;
  if (!(await serverReady())) {
    server = spawn(process.execPath, ['server.js'], {
      cwd: require('path').join(__dirname, '..'), stdio: 'ignore',
      env: { ...process.env, GRANCYAN_PORT: String(PORT) }
    });
    for (let i = 0; i < 40 && !(await serverReady()); i++) await sleep(250);
    if (!(await serverReady())) throw new Error(`连不上 127.0.0.1:${PORT}，自动启动 server.js 也失败了`);
  }

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--use-angle=swiftshader', '--no-first-run',
    // 独立 profile：和别的冒烟共用会撞锁，症状是「某函数 is not defined」，很容易误判成代码坏了
    '--user-data-dir=' + require('path').join(require('os').tmpdir(), 'gc-mark-smoke-' + process.pid),
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('连不上 Chrome'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('Chrome 没有打开 index.html，targets=' + JSON.stringify(targets).slice(0, 500));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('Chrome DevTools WebSocket 在 open 前关闭')));
  });
  let id = 0; const pend = new Map();
  const errors = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 300));
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { pend.delete(i); reject(new Error(`Chrome DevTools ${method} 10 秒无响应`)); }, 10000);
    pend.set(i, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id: i, method, params }), e => { if (e) { clearTimeout(timer); pend.delete(i); reject(e); } });
  });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function screenshotStats() {
    const shot = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: 40, y: 40, width: 300, height: 170, scale: 1 }
    });
    const png = PNG.sync.read(Buffer.from(shot.result.data, 'base64'));
    let intermediate = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 8 && r < 247 && Math.abs(r - g) < 3 && Math.abs(r - b) < 3) intermediate++;
    }
    return { intermediate, width: png.width, height: png.height };
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(3500);

  group('[1] 函数在真页面里挂上了（脚本加载顺序对）');
  ok(await ev(`typeof stickerTagToHtml === 'function' && typeof maskStreamingMark === 'function'`),
     'stickerTagToHtml / maskStreamingMark 都在');

  group('[2] ❗真页面里取得到主题底色 —— vm 测试走的是兜底分支，这一步只有真浏览器能证');
  const bg = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim()`);
  ok(typeof bg === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(bg),
     `--bg-surface 真的取得到，拿到的是 ${JSON.stringify(bg)}（不是空串→说明没在用写死的兜底色）`);

  group('[3] ❗浏览器真的接受了拼出来的 style（非法 CSS 值是被静默丢弃的）');
  await ev(`(() => {
    const box = document.createElement('div');
    box.id = 'markSmokeBox';
    box.style.cssText = 'position:fixed;left:-9999px;background:' + getComputedStyle(document.documentElement).getPropertyValue('--bg-surface');
    document.body.appendChild(box);
    return true;
  })()`);
  await ev(`document.getElementById('markSmokeBox').innerHTML = stickerTagToHtml('[[MARK: 看得见吗 | c=#88ccff s=1.4 o=0.6]]')`);
  const got = await ev(`(() => {
    const el = document.querySelector('#markSmokeBox .mark-text');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, size: cs.fontSize, opacity: cs.opacity, text: el.textContent };
  })()`);
  ok(got && got.color === 'rgb(136, 204, 255)',
     '颜色被浏览器接受并生效（computed = ' + (got && got.color) + '，不是丢弃后的继承色）');
  ok(got && parseFloat(got.opacity) === 0.6, '透明度生效（computed opacity = ' + (got && got.opacity) + '）');
  ok(got && parseFloat(got.size) > 0, '字号是个真实像素值（computed = ' + (got && got.size) + '）');
  ok(got && got.text === '看得见吗', '正文没被转义或吞掉');

  group('[3.5] ❗高斯 filter 不只被接受，截图像素也证明文字真的糊了');
  await ev(`(() => {
    const box = document.getElementById('markSmokeBox');
    box.style.cssText = 'position:fixed;z-index:10001;left:40px;top:40px;width:300px;height:170px;overflow:hidden;background:#fff;color:#000;font:64px/1 monospace;padding:15px;box-sizing:border-box';
    document.documentElement.style.setProperty('--bg-surface', '#fff');
    box.innerHTML = stickerTagToHtml('[[MARK: ██ | c=#000 s=2 b=0]]');
  })()`);
  await ev(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const sharpPixels = await screenshotStats();
  await ev(`document.getElementById('markSmokeBox').innerHTML = stickerTagToHtml('[[MARK: ██ | c=#000 s=2 b=1.25]]')`);
  await ev(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const blurFilter = await ev(`getComputedStyle(document.querySelector('#markSmokeBox .mark-text')).filter`);
  const blurredPixels = await screenshotStats();
  ok(blurFilter !== 'none' && blurredPixels.intermediate > sharpPixels.intermediate * 1.5,
     `高斯 blur 真正扩散了像素（computed=${blurFilter}，中间灰像素 ${sharpPixels.intermediate} → ${blurredPixels.intermediate}）`);
  // ❗必须把盒子的底色也还原。上面为了数像素把它改成了白底，
  // 不还原的话 [4] 会拿「白底」去量「按深色底算出来的钳制结果」——
  // 那条断言仍然是绿的（推亮后约 #707070，对白底 4.9:1 > 3），
  // 但它已经不证明「按真实底色算」这件事了，是典型的绿而无据。
  await ev(`(() => {
    document.documentElement.style.removeProperty('--bg-surface');
    const box = document.getElementById('markSmokeBox');
    box.style.cssText = 'position:fixed;left:-9999px;background:' + getComputedStyle(document.documentElement).getPropertyValue('--bg-surface');
    return true;
  })()`);

  group('[4] ❗按真实底色算，暗色被推到看得见');
  const contrast = await ev(`(() => {
    const el = document.querySelector('#markSmokeBox .mark-text');
    const parse = s => (s.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
    const lum = rgb => { const l = rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
    const ratio = (a, b) => { const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05); };
    // 故意给一个几乎和底色一样的深灰，看它有没有被推亮
    document.getElementById('markSmokeBox').innerHTML = stickerTagToHtml('[[MARK: 差点看不见 | c=#1a1a1a]]');
    const el2 = document.querySelector('#markSmokeBox .mark-text');
    const fg = parse(getComputedStyle(el2).color);
    const bgc = parse(getComputedStyle(document.getElementById('markSmokeBox')).backgroundColor);
    return { ratio: ratio(fg, bgc), fg: getComputedStyle(el2).color, kept: el2.getAttribute('data-mark-c') };
  })()`);
  ok(contrast && contrast.ratio >= 3,
     `#1a1a1a 在真实底色上被推到对比度 ${contrast && contrast.ratio.toFixed(2)}（≥3 才算看得见），实际显示成 ${contrast && contrast.fg}`);
  ok(contrast && contrast.kept === '#1a1a1a',
     '❗但 data 属性里存的还是模型原本要的 #1a1a1a（钳制只改显示，不改回填）');

  group('[4.5] ❗方向模糊 defs 真正在 DOM 里');
  ok(await ev(`document.getElementById('mkb-h-20') instanceof SVGFilterElement`),
     'mkb-h-20 在真页面里是 SVGFilterElement');

  group('[5] ❗回填往返：历史里必须是正牌指令，不能漏 HTML');
  const back = await ev(`stickerTagForApi(stickerTagToHtml('[[MARK: 往返 | c=#1a1a1a s=1.4 o=0.6 b=v1.5]]'))`);
  ok(typeof back === 'string' && back.includes('[[MARK: 往返') && back.includes('c=#1a1a1a')
     && back.includes('b=v1.5') && !/<[^>]+>/.test(back),
     '真页面带 b 咬回 [[MARK: …]] 且一个 HTML 标签都没漏 —— 实际拿到：' + JSON.stringify(back));

  group('[5.5] ❗GLITCH 也咬得回去了 —— 以前这里是被抹成裸词的');
  const gBack = await ev(`stickerTagForApi(stickerTagToHtml('他说 [[GLITCH: 疼|big]] 了'))`);
  ok(typeof gBack === 'string' && gBack.includes('[[GLITCH: 疼|big]]') && !/<[^>]+>/.test(gBack),
     '显式样式原样回填 —— 实际拿到：' + JSON.stringify(gBack));
  const gPlain = await ev(`stickerTagForApi(stickerTagToHtml('他说 [[GLITCH: 疼]] 了'))`);
  ok(typeof gPlain === 'string' && gPlain.includes('[[GLITCH: 疼]]') && !gPlain.includes('|'),
     '没指定样式就不伪造一个（渲染时哈希选的 g1~g4 不能当成模型的本意）—— 实际拿到：' + JSON.stringify(gPlain));
  const gLegacy = await ev(`stickerTagForApi('<span class="glitch-word g3">疼</span>')`);
  ok(gLegacy === '疼', '旧数据（没有 data 属性的 span）回落成裸词，不漏 HTML —— 实际拿到：' + JSON.stringify(gLegacy));

  group('[6] 流式半截标签被遮住');
  ok(!(await ev(`maskStreamingTags('正在写 [[MARK: 半截 | c=#8cf')`)).includes('[[MARK:'),
     '没写完的标签不会裸露在气泡里');

  group('[7] 没有未捕获的 JS 报错');
  ok(errors.length === 0, '控制台无未捕获异常' + (errors.length ? '：' + errors[0] : ''));

  await ev(`document.getElementById('markSmokeBox')?.remove()`);
  ws.close(); chrome.kill();
  if (server) server.kill();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('browser-mark 冒烟失败：', e && e.stack || e);
  process.exit(1);
});
