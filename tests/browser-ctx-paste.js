/* 消息里的输入框右键 / 长按，要弹系统那个带「粘贴」的菜单，不是消息菜单（用户提的）。
 *
 * 必须在真浏览器里跑：要验的是「行内 oncontextmenu 的 preventDefault 到底有没有跑到」，
 * 这取决于真实的事件传播顺序（document capture → 目标 → 冒泡），vm 桩里验不出来。
 * defaultPrevented === false 就等于系统菜单会弹（exe 里是 electron-main.js 那份剪切/复制/粘贴）。
 *
 * 跑法：node tests/browser-ctx-paste.js   （自己起 server 和 Chrome，跑完自己收拾）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.GC_PORT || 3102;
const CDP = 9236;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(require('os').tmpdir(), 'gc-ctxpaste-smoke-' + process.pid + '-' + Date.now());

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
    for (let i = 0; i < 40 && !(await evalJs('typeof createNewChat==="function" && typeof editMessage==="function"')); i++) await sleep(500);
    await sleep(2500);   // 等 init 跑完

    const r = await evalJs(`(async () => {
      document.getElementById('authModal')?.classList.add('hidden');
      createNewChat();
      const chat = getActiveChat();
      const b = nextId() + 5; _nodeIdCounter = b + 20;
      chat.nodes[b+1] = { id: b+1, parentId: null, role: 'user', content: '帮我记 approach', timestamp: Date.now() };
      chat.nodes[b+2] = { id: b+2, parentId: b+1, role: 'ai', content: 'app + roach，手机里爬出一只蟑螂', timestamp: Date.now() };
      chat.headId = b+2; renderMessages();
      await new Promise(z => setTimeout(z, 300));
      const wait = ms => new Promise(z => setTimeout(z, ms));
      const menu = document.getElementById('contextMenu');
      const shown = () => menu.style.display === 'flex';
      const reset = async () => { closeMsgContextMenu(); await wait(80); };
      const rclick = el => {
        const r = el.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      const press = async el => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        await wait(750);
        const s = shown();
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        return s;
      };
      const out = {};

      // 对照组：消息正文上右键 / 长按，消息菜单照旧
      const aiBubble = document.querySelector('[data-node-id="' + (b+2) + '"] .bubble');
      out.bubblePrevented = rclick(aiBubble);
      out.bubbleShown = shown();
      await reset();
      out.bubblePress = await press(aiBubble);
      await reset();

      // 改自己那条消息：编辑框里右键 / 长按
      editMessage(b+1);
      const ta = document.querySelector('[data-node-id="' + (b+1) + '"] .msg-edit-body');
      out.hasTa = !!ta;
      out.taPrevented = rclick(ta);
      out.taShown = shown();
      await reset();
      out.taPress = await press(ta);
      await reset();

      // 编辑框旁边的按钮不是输入框：右键仍是消息菜单（别把整个编辑区都放生了）
      const btn = document.querySelector('[data-node-id="' + (b+1) + '"] .msg-edit-cancel');
      out.btnPrevented = rclick(btn);
      out.btnShown = shown();
      await reset();

      // 消息外面的输入框（底部输入栏）本来就不归消息菜单管，不受影响
      const main = document.getElementById('userInput') || document.querySelector('.input-bar textarea');
      out.mainPrevented = main ? rclick(main) : null;
      return out;
    })()`);

    console.log('\n[消息里的输入框右键 / 长按 · 浏览器冒烟]');
    ok(r.bubblePrevented && r.bubbleShown, '对照：消息正文右键仍弹消息菜单', r);
    ok(r.bubblePress, '对照：消息正文长按仍弹消息菜单', r);
    ok(r.hasTa, '编辑框打开了');
    ok(r.taPrevented === false, '★ 编辑框里右键：没被 preventDefault（系统「粘贴」菜单会弹）', r.taPrevented);
    ok(r.taShown === false, '★ 编辑框里右键：消息菜单没跟着弹', r.taShown);
    ok(r.taPress === false, '★ 编辑框里长按：消息菜单不弹（手机上让给系统取词条）', r.taPress);
    ok(r.btnPrevented && r.btnShown, '编辑区的按钮上右键仍是消息菜单', r);
    ok(r.mainPrevented === false || r.mainPrevented === null, '底部输入栏右键不受影响', r.mainPrevented);
    ws.close();
  } catch (e) {
    fail++; console.log('  ✗ 跑挂了：' + e.message);
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
