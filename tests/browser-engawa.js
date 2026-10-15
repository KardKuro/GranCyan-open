/* 檐廊的浏览器冒烟：真的在 Chrome 里开面板、真的按按钮、真的走一遍聊天里的
 * [[GAZE:]] 全链路（前端 → server 的 MCP 转发 → engawa 引擎 → 格式化 → 回填 blocks）。
 *
 * 为什么必须在浏览器里跑：单测那份（tests/engawa.test.js）是 vm 沙箱，document 是桩，
 * 验的是**逻辑**（解析、格式化、回填正则）。而这三件事桩里怎么摆都验不出来：
 *   1. 40-engawa.js 有没有真的被页面加载（index.html 漏一行 script，单测照样全绿）；
 *   2. _gazeBlockHtml 拼出来的字符串能不能被浏览器解析成一个真的可折叠块
 *      （模板里少一个引号，单测的字符串断言照样过，页面上已经是一坨源码了）；
 *   3. 整条链路通不通 —— 单测里 fetch 是桩，从来没碰过真的 server 和真的引擎。
 *
 * 跑法：node tests/browser-engawa.js   （脚本自己起 server 和 Chrome，跑完自己收拾）
 * 需要引擎装在本机；没装的话 server 那边会回 503，脚本会说清楚是这个原因。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.GC_PORT || 3097;
const CDP = 9231;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(require('os').tmpdir(), 'gc-engawa-smoke-' + process.pid + '-' + Date.now());

let pass = 0, fail = 0, warn = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
// 软断言：依赖外网上游（NASA / 芝加哥艺术学院 / arXiv）的那几条。
// 上游抽风不该把整个冒烟判红 —— 但也绝不静默跳过，照实报出来。
const soft = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { warn++; console.log('  ⚠ ' + n + '（上游没回，非本地代码问题）'); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ping(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => { r.resume(); res(r.statusCode); }).on('error', rej);
  });
}
function getJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
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
    // 每次跑用一个全新的 profile 目录。固定目录的话，上一次被 kill 掉的实例会在里面
    // 留下 SingletonLock，新 chrome 起不来 —— 而 CDP 端口还连得上（连到的是旧实例或
    // 空页面），于是报出来是「openEngawa is not defined」，看着像代码坏了。踩过一次。
    '--user-data-dir=' + PROFILE,
    '--window-size=1280,1700', `http://127.0.0.1:${PORT}/`,
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
    // profile 目录是一次性的，删掉别在 temp 里堆一地（删不掉也无所谓，下次换新的）
    try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  };
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
    for (let i = 0; i < 40 && !(await evalJs('typeof openEngawa==="function"')); i++) await sleep(500);

    console.log('\n[檐廊 · 浏览器冒烟]');
    ok(await evalJs('typeof openEngawa==="function"'), '40-engawa.js 真的被页面加载了');
    ok(await evalJs('typeof gazeParse==="function" && typeof prefetchGazeCommands==="function"'), '协议函数都在全局');

    // ── 面板 ──
    await evalJs('openEngawa()');
    await sleep(400);
    ok(await evalJs('!document.getElementById("engawaModal").classList.contains("hidden")'), '面板真的打开了');
    ok(await evalJs('document.querySelectorAll(".engawa-actions button").length===7'), '七个按钮都在');
    ok(await evalJs('[...document.querySelectorAll(".engawa-actions button")].every(b=>b.getBoundingClientRect().height>10)'),
       '按钮有可见高度（不是被压扁的空壳）');

    // 深色：用户的默认口味，面板底色必须是暗的
    const bg = await evalJs('getComputedStyle(document.getElementById("engawaBody")).backgroundColor+"|"+getComputedStyle(document.querySelector(".engawa-actions button")).backgroundColor');
    const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg.split('|')[1]);
    ok(rgb && (+rgb[1] + +rgb[2] + +rgb[3]) / 3 < 110, '按钮底色是深色（均值 ' + (rgb ? Math.round((+rgb[1] + +rgb[2] + +rgb[3]) / 3) : '?') + '）');

    // ── 真按一下：诗（不依赖外网上游，走的是引擎自带的诗库）──
    await evalJs('engawaPeek("daily_poem")');
    for (let i = 0; i < 40 && await evalJs('!document.querySelector("#engawaBody .engawa-card")'); i++) await sleep(500);
    const poemTxt = await evalJs('document.querySelector("#engawaBody .engawa-card-body")?.textContent||""');
    ok(!!poemTxt && poemTxt.length > 6, '★ 按「今日诗」真的出内容了（全链路：页面→server→MCP→引擎）');
    ok(/——/.test(poemTxt), '诗的出处那一行也渲染出来了');
    ok(!poemTxt.includes('⚠️'), '没有报错信息漏在正文里', poemTxt.slice(0, 80));

    // ── 今晚的天：本地算，最稳，且能验坐标不是默认的格林尼治 ──
    await evalJs('document.getElementById("engawaBody").innerHTML="";engawaPeek("sky_tonight")');
    for (let i = 0; i < 40 && !(await evalJs('!!document.querySelector("#engawaBody .engawa-card-body")')); i++) await sleep(500);
    const skyTxt = await evalJs('document.querySelector("#engawaBody .engawa-card-body")?.textContent||""');
    ok(/月相|月升/.test(skyTxt), '★ 今晚的天渲染出来了');

    // ── 每日一画：验图片真的能加载（外网，软断言）──
    await evalJs('document.getElementById("engawaBody").innerHTML="";engawaPeek("daily_art")');
    for (let i = 0; i < 60 && !(await evalJs('!!document.querySelector("#engawaBody .engawa-card-body")')); i++) await sleep(500);
    const hasImgTag = await evalJs('!!document.querySelector("#engawaBody img.engawa-img")');
    soft(hasImgTag, '每日一画给出了 <img>');
    if (hasImgTag) {
      // naturalWidth>0 才是真的解码出来了；只看 src 有值是骗人的（记忆：坏图别用 img.src 判）
      for (let i = 0; i < 30 && !(await evalJs('document.querySelector("#engawaBody img.engawa-img")?.naturalWidth>0')); i++) await sleep(500);
      soft(await evalJs('document.querySelector("#engawaBody img.engawa-img")?.naturalWidth>0'),
           '★ 图片真的解码出来了（naturalWidth>0，不是只有 src）');
    }

    // ── 聊天全链路：模型写 [[GAZE:]] → 预取 → 回填进 blocks ──
    // 这一段才是这个功能的正体：面板只是附赠品。
    console.log('\n[聊天里的 [[GAZE:]] 全链路]');
    await evalJs('state.engawaOn=true;window.__conf={id:"smoke",nickname:"冒烟",engawaOn:true}');
    ok(await evalJs('engawaEnabledFor(window.__conf)===true'), '开关和模型授权都认了');
    ok(await evalJs('engawaEnabledFor({id:"x",engawaOn:false})===false'), '没勾的模型确实看不见（不烧它的 token）');

    // Runtime.evaluate 的表达式是顶层的，await 得自己包一层 async
    const aiText = '今晚外面挺好的。[[GAZE: sky_tonight]] 你看。';
    await evalJs(`(async()=>{
      window.__blocks=[{type:"text",text:${JSON.stringify(aiText)}}];
      window.__gz = await prefetchGazeCommands(${JSON.stringify(aiText)}, window.__conf);
      _applyGazeToBlocks(window.__blocks, window.__gz);
    })()`);
    ok(await evalJs('Array.isArray(window.__gz) && window.__gz.length===1'), '预取把结果**返回**出来了（不是只塞进全局）');
    const blockHtml = await evalJs('window.__blocks[0].text');
    ok(!blockHtml.includes('[[GAZE'), '★ 裸指令被结果块替换掉了（不会漏在气泡里给小明看见）');
    ok(blockHtml.includes('🪟 檐廊: sky_tonight'), '★ 结果块带正牌标题（回填正则按这个抓，改了就断链）');
    ok(/月相|月升/.test(blockHtml), '★ 引擎看到的东西真的进了气泡');

    // 把这段 HTML 真的塞进 DOM，验它能被浏览器解析成一个可折叠块 —— 字符串断言验不出这个
    await evalJs('window.__probe=document.createElement("div");window.__probe.innerHTML=window.__blocks[0].text;document.body.appendChild(window.__probe)');
    ok(await evalJs('!!window.__probe.querySelector(".think-block .think-toggle .think-label")'),
       '★ 结果块能被浏览器解析成真的折叠块（不是一坨源码）');
    ok(await evalJs('window.__probe.querySelector(".think-label").textContent.includes("檐廊")'), '折叠块标题渲染正确');

    // ── content 路径：blocks 为空时全靠它（Codex 逮到的那条，二审前整个漏了）──
    const contentOut = await evalJs(`(async()=>{
      try {
        const t = '看看天 [[GAZE: sky_tonight]] 就这样';
        const gz = await prefetchGazeCommands(t, window.__conf);
        return processAiCommands(t, {nodes:{},title:''}, window.__conf, {gazeResults: gz});
      } catch(e) { return 'THREW: ' + e.message; }
    })()`);
    ok(!String(contentOut).startsWith('THREW'), 'content 路径没抛错', contentOut);
    ok(!String(contentOut).includes('[[GAZE'), '★ content 路径也把裸指令换掉了（没有 blocks 的模型不会漏指令）');
    ok(/🪟 檐廊/.test(String(contentOut)), '★ content 路径长出了结果块');

    // 没开功能时，裸指令必须被抹掉而不是漏出去
    const contentOff = await evalJs(`(async()=>{
      try { return processAiCommands('喂 [[GAZE: sky_tonight]] 喂', {nodes:{},title:''}, {id:'off',engawaOn:false}, {gazeResults:[]}); }
      catch(e) { return 'THREW: ' + e.message; }
    })()`);
    ok(!String(contentOff).includes('[[GAZE'), '★ 功能没开时裸指令被抹掉，不漏给小明看见', contentOff);

    // ── 图片降级：坏地址要变成一句人话 + 原页面链接，不是碎图标 ──
    await evalJs(`window.__im=document.createElement('div');
      window.__im.innerHTML=_gazeImgHtml('https://127.0.0.1:9/nope.jpg','https://example.com/page');
      document.body.appendChild(window.__im);`);
    for (let i = 0; i < 24 && !(await evalJs('!!window.__im.querySelector(".engawa-img-fail")')); i++) await sleep(250);
    ok(await evalJs('!!window.__im.querySelector(".engawa-img-fail")'), '★ 图挂了会降级成提示块（不是碎图标）');
    ok(await evalJs('window.__im.querySelector(".engawa-img-fail a")?.href.includes("example.com")'), '降级块给出了原页面链接');
    await evalJs('window.__im.remove()');

    // 危险协议的图一律不渲染
    ok(await evalJs('_gazeImgHtml("javascript:alert(1)","")===""'), '★ javascript: 图片不生成标签');

    // 回填给模型看：跑真的 stickerTagForApi（页面里就有），验历史里留下的是正牌格式
    if (await evalJs('typeof stickerTagForApi==="function"')) {
      const back = await evalJs('stickerTagForApi(window.__blocks[0].text)');
      ok(/\[\[GAZE:\s*sky_tonight\s*\]\]/.test(back), '★ 回填历史时压回正牌 [[GAZE: …]]（历史就是教材）');
      ok(!/<div|<img|<a\s/.test(back), '★ 回填后没有裸 HTML 漏给模型', (back.match(/<[a-z][^>]*>/gi) || []).slice(0, 3));
    } else {
      fail++; console.log('  ✗ 页面里没有 stickerTagForApi，回填断言没跑成');
    }

    // 出图给用户看
    await evalJs('window.__probe.remove();document.getElementById("engawaBody").innerHTML="";engawaPeek("daily_art")');
    await sleep(3500);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot.result?.data) {
      require('fs').mkdirSync(path.join(ROOT, 'tests/out'), { recursive: true });
      const out = path.join(ROOT, 'tests/out/engawa.png');
      require('fs').writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log('  📷 截图: ' + out);
    }

    ws.close();
  } catch (e) {
    fail++; console.error('  ✗ 冒烟本身炸了：' + e.message);
  } finally { cleanup(); }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed${warn ? `, ${warn} 上游没回` : ''}`);
  process.exit(fail ? 1 : 0);
})();
