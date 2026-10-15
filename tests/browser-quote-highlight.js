/* 点引用条跳回原消息：只亮被引用的那一段，不是整条气泡一起闪（用户提的）。
 *
 * 必须在真浏览器里跑：定位靠 TreeWalker + Range，高亮靠 CSS.highlights，vm 桩里验不出来。
 * 验的形状都是真会碰到的：
 *   - 引用跨段落、中间夹着 **加粗**（选区复制出来带 \n，DOM 里段落间没有文本节点）；
 *   - AI 写的 [[QUOTE:]]；
 *   - 原文找不到（原消息后来被编辑过）→ 退回整条闪，不报错；
 *   - --accent-rgb 真的跟着主题色（以前没人设，高亮一直是后备的靛蓝）。
 *
 * 跑法：node tests/browser-quote-highlight.js   （自己起 server 和 Chrome，跑完自己收拾）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.GC_PORT || 3098;
const CDP = 9232;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(require('os').tmpdir(), 'gc-quote-smoke-' + process.pid + '-' + Date.now());

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

(async () => {
  // 127.0.0.1 不用 localhost：localhost 走 ::1 会撞上 wslrelay
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
    for (let i = 0; i < 40 && !(await evalJs('typeof createNewChat==="function" && typeof scrollToMessage==="function"')); i++) await sleep(500);
    await sleep(2500);   // 等 init 跑完

    const r = await evalJs(`(async () => {
      document.getElementById('authModal')?.classList.add('hidden');
      createNewChat();
      const chat = getActiveChat();
      const b = nextId() + 5; _nodeIdCounter = b + 20;
      chat.nodes[b+1] = { id: b+1, parentId: null, role: 'user', content: '讲个故事', timestamp: Date.now() };
      chat.nodes[b+2] = { id: b+2, parentId: b+1, role: 'ai', content: '从前有一座山，山上有一座庙。\\n\\n庙里有个**老和尚**在给小和尚讲故事。\\n\\n讲的是什么呢？', timestamp: Date.now() };
      chat.nodes[b+3] = { id: b+3, parentId: b+2, role: 'user', content: '然后呢', quotes: [{ text: '山上有一座庙。\\n\\n庙里有个老和尚', sourceNodeId: b+2 }], timestamp: Date.now() };
      chat.nodes[b+4] = { id: b+4, parentId: b+3, role: 'ai', content: '[[QUOTE: 讲的是什么呢]] 我也想知道', timestamp: Date.now() };
      chat.headId = b+4; renderMessages();
      await new Promise(z => setTimeout(z, 300));
      const out = {};
      const marks = () => [...document.querySelectorAll('.gc-quote-mark')];
      const shape = () => {
        const L = marks()[0]; if (!L) return null;
        const host = L.parentElement, hr = host.getBoundingClientRect();
        const bars = [...L.children].map(i => i.getBoundingClientRect());
        return { text: L.dataset.text, n: bars.length, z: getComputedStyle(L).zIndex, iso: getComputedStyle(host).isolation,
          radius: L.children[0] && getComputedStyle(L.children[0]).borderTopLeftRadius,
          widest: Math.max(...bars.map(r => r.width)) / hr.width, inside: bars.every(r => r.top >= hr.top - 4 && r.bottom <= hr.bottom + 4) };
      };
      const aiBubble = document.querySelector('[data-node-id="' + (b+2) + '"] .bubble');
      out.isoBefore = getComputedStyle(aiBubble).isolation;
      document.querySelector('[data-node-id="' + (b+3) + '"] .bubble-quote').click();
      out.user = shape();
      document.querySelector('[data-node-id="' + (b+4) + '"] .bubble-quote').click();
      out.ai = shape();
      out.onlyOne = marks().length === 1;
      out.fallbackReturned = scrollToMessage(b+2, '根本不存在的一句话啊啊啊啊啊啊');
      out.fallbackNoHl = marks().length === 0;
      out.accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
      out.accent = state.accentColor;
      scrollToMessage(b+2, '讲的是什么呢');
      await new Promise(z => setTimeout(z, 2900));
      out.clearedAfter = marks().length === 0;
      out.isoAfter = getComputedStyle(aiBubble).isolation;
      return out;
    })()`);

    console.log('\n[引用高亮 · 浏览器冒烟]');
    const u = r.user || {}, a = r.ai || {};
    ok((u.text || '').replace(/\s/g, '') === '山上有一座庙。庙里有个老和尚',
       '★ 她的引用跨段落 + 夹着加粗：亮的正好是那一段', u.text);
    ok(u.n === 2, '★ 跨两段 = 两块色块（加粗没把一行切碎）', u);
    ok(a.text === '讲的是什么呢' && a.n === 1, '★ AI 的 [[QUOTE:]] 只亮那一句', a);
    ok(a.widest < 0.8, '★ 色块只盖那几个字，没冒出整行宽的段落盒子', a.widest);
    ok(u.radius === '6px' && u.z === '-1' && u.iso === 'isolate', '★ 圆角 + 垫在字底下', u);
    ok(u.inside && a.inside, '色块位置落在气泡里');
    ok(r.onlyOne, '连点两次只留最后一处，不叠');
    ok(r.fallbackReturned && r.fallbackNoHl, '原文找不到：照样跳过去、退回整条闪、不留假高亮');
    const hex = (r.accent || '').replace('#', '');
    const want = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');
    ok(r.accentRgb === want, '--accent-rgb 跟着主题色（' + r.accentRgb + ' = ' + r.accent + '）', r.accentRgb);
    ok(r.clearedAfter, '高亮过一会儿自己消失');
    ok(r.isoAfter === r.isoBefore, '消失后气泡的 isolation 还原（' + r.isoBefore + '）', r.isoAfter);
    ws.close();
  } catch (e) {
    fail++; console.log('  ✗ 跑挂了：' + e.message);
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
