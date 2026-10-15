/* 多选的浏览器冒烟：真的派 Ctrl+click 和 touch 事件，看 DOM 有没有按预期变。
 *
 * 为什么必须在浏览器里跑：单测那份是 vm 沙箱，DOM 全是桩，验的是**搬移语义**。
 * 而「capture 阶段能不能抢在 inline onclick 前面」「touchend preventDefault 有没有
 * 吃掉补发的 click」这两件事，全靠真实的事件派发路径 —— 桩里怎么摆都验不出来。
 *
 * 跑法：先 GRANCYAN_PORT=3099 node server.js，再 node tests/browser-multiselect.js
 */
const PORT = process.env.GC_PORT || 3099;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9224, path }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

(async () => {
  // 先确认服务器活着 —— 不查的话页面根本没加载，下面每条都会以「元素不存在」为由红，
  // 看起来像功能坏了。（chat-peek 那轮就是漏了这一步，跑出过一次假失败。）
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode));
      r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + require('os').tmpdir() + '\\gc-msel-smoke',
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
  const send = (method, params) => new Promise(r => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  }
  await send('Runtime.enable');
  await sleep(3500);

  // ── 造三个模型 + 一个分组，渲染出来 ──────────────────────
  await ev(`(() => {
    state.configs = [
      { id: 101, nickname: '甲', modelName: 'm1', group: '' },
      { id: 102, nickname: '乙', modelName: 'm2', group: '' },
      { id: 103, nickname: '丙', modelName: 'm3', group: '老组' },
    ];
    _mselModels.clear(); _mselGroups.clear();
    renderConfigs();
    return document.querySelectorAll('.model-card-header[data-mid]').length;
  })()`);

  group('[1] 渲染挂载点');
  ok(await ev(`document.querySelectorAll('.model-card-header[data-mid]').length`) === 3,
    '三张模型卡片都带 data-mid');
  ok(await ev(`!!document.querySelector('.model-group-head[data-g="老组"]')`),
    '分组标题带 data-g');
  ok(await ev(`!document.querySelector('.msel-bar')`), '没选东西时不显示工具栏');

  // ── Ctrl + 左键 ────────────────────────────────────────
  group('[2] ❗Ctrl + 左键：抢在 inline onclick 之前');

  const ctrlClick = sel => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'no-el';
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
      clientX: r.left + 5, clientY: r.top + 5,
    }));
    return 'ok';
  })()`);

  const openedBefore = await ev(`_openModelCards().includes(101)`);
  await ctrlClick('.model-card-header[data-mid="101"]');
  ok(await ev(`_mselModels.has(101)`), 'Ctrl+点模型 → 选中了');
  ok(await ev(`_openModelCards().includes(101)`) === openedBefore,
    '❗卡片没有跟着展开（说明 capture 真的把 inline onclick 拦下来了）');
  ok(await ev(`!!document.querySelector('.msel-bar')`), '工具栏出来了');
  ok(await ev(`!!document.querySelector('.model-card.msel-on')`), '选中的卡片有 msel-on 样式');

  await ctrlClick('.model-card-header[data-mid="102"]');
  ok(await ev(`_mselModels.size === 2`), '再 Ctrl+点一个 → 累加，不是替换');

  await ctrlClick('.model-card-header[data-mid="102"]');
  ok(await ev(`_mselModels.size === 1 && !_mselModels.has(102)`), '同一个再点一次 → 取消选中');

  const foldedBefore = await ev(`_foldedGroups().includes('老组')`);
  await ctrlClick('.model-group-head[data-g="老组"]');
  ok(await ev(`_mselGroups.has('老组')`), 'Ctrl+点分组标题 → 选中了');
  ok(await ev(`_foldedGroups().includes('老组')`) === foldedBefore,
    '❗分组没有跟着折叠/展开');

  group('[3] 「未分组」不是真分组，选不了');
  await ev(`(() => { state.configs.forEach(c => { if (c.id !== 103) c.group = ''; }); renderConfigs(); })()`);
  const looseSel = '.model-group.loose .model-group-head';
  if (await ev(`!!document.querySelector(${JSON.stringify(looseSel)})`)) {
    const n0 = await ev(`_mselGroups.size`);
    await ctrlClick(looseSel);
    ok(await ev(`_mselGroups.size`) === n0, '❗Ctrl+点「未分组」不会把空路径加进选中集合');
  } else {
    ok(false, '（找不到「未分组」那一坨，用例没跑到）');
  }

  // ── 建新分组 ──────────────────────────────────────────
  group('[4] 🗂 建新分组');
  await ev(`(() => {
    state.configs = [
      { id: 101, nickname: '甲', modelName: 'm1', group: '' },
      { id: 102, nickname: '乙', modelName: 'm2', group: '' },
      { id: 103, nickname: '丙', modelName: 'm3', group: '' },
    ];
    _mselModels.clear(); _mselGroups.clear();
    _mselModels.add(101); _mselModels.add(103);
    renderConfigs();
    mselGroupSelected();
    return 1;
  })()`);
  ok(await ev(`state.configs.find(c => c.id === 101).group === '新分组'`), '选中的甲进了「新分组」');
  ok(await ev(`state.configs.find(c => c.id === 103).group === '新分组'`), '选中的丙也进了');
  ok(await ev(`state.configs.find(c => c.id === 102).group === ''`), '没选的乙没动');
  ok(await ev(`_mselModels.size === 0`), '建完退出多选');
  ok(await ev(`!document.querySelector('.msel-bar')`), '工具栏收起来了');
  ok(await ev(`!!document.querySelector('.model-group-head[data-g="新分组"]')`), '新分组渲染出来了');

  // ── 手机左划 ──────────────────────────────────────────
  group('[5] ❗手机左划选中');

  // 真的派一串 touchstart → touchmove → touchend，位移够一次左划
  const swipe = (sel, dx, dy) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'no-el';
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width - 10, y0 = r.top + r.height / 2;
    const mk = (type, x, y, list) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      return new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: list ? [t] : [], targetTouches: list ? [t] : [], changedTouches: [t],
      });
    };
    el.dispatchEvent(mk('touchstart', x0, y0, true));
    el.dispatchEvent(mk('touchmove', x0 - ${dx} / 2, y0 + ${dy} / 2, true));
    const end = mk('touchend', x0 - ${dx}, y0 + ${dy}, false);
    el.dispatchEvent(end);
    return end.defaultPrevented ? 'prevented' : 'not-prevented';
  })()`);

  await ev(`(() => { _mselModels.clear(); _mselGroups.clear(); renderConfigs(); })()`);
  const r1 = await swipe('.model-card-header[data-mid="102"]', 80, 4);
  ok(r1 !== 'no-el', '找得到要划的卡片');
  ok(await ev(`_mselModels.has(102)`), '往左划 80px → 选中');
  ok(r1 === 'prevented',
    '❗touchend 被 preventDefault（吃掉补发的 click，否则卡片会跟着展开）');

  await ev(`(() => { _mselModels.clear(); renderConfigs(); })()`);
  await swipe('.model-card-header[data-mid="102"]', 20, 4);
  ok(await ev(`_mselModels.size === 0`), '❗只划 20px 不算（低于阈值，多半是滚动时的抖动）');

  await swipe('.model-card-header[data-mid="102"]', 60, 90);
  ok(await ev(`_mselModels.size === 0`), '❗斜着甩（纵移更大）不算 —— 列表是竖着滚的');

  await ev(`(() => { _mselModels.clear(); renderConfigs(); })()`);
  await swipe('.model-card-header[data-mid="102"]', -80, 4);
  ok(await ev(`_mselModels.size === 0`), '❗往**右**划不算（只认左划）');

  // ── 其余三处 Ctrl 场景 ────────────────────────────────
  group('[6] Ctrl 也能激活别处的多选');

  /* 消息那条：空对话里没有气泡可点，所以先塞一个带 data-msg-wrapper 的节点进去。
     ⚠️ 这里验的是「zone 认得出它 → 进多选 → 勾上」这条链路，
        不是消息本身怎么渲染的 —— 后者 renderMessages 会立刻把这个假节点冲掉，
        但断言查的是 state，不受影响。 */
  await ev(`(() => {
    if (state.isSelectMode) exitSelectMode();
    const win = document.getElementById('chatWindow');
    if (win && !document.querySelector('[data-msg-wrapper]')) {
      const d = document.createElement('div');
      d.setAttribute('data-msg-wrapper', '7777');
      d.style.cssText = 'height:40px';
      d.textContent = '假消息';
      win.appendChild(d);
    }
    return 1;
  })()`);
  const msgSel = '[data-msg-wrapper]';
  if (await ev(`!!document.querySelector(${JSON.stringify(msgSel)})`)) {
    await ctrlClick(msgSel);
    ok(await ev(`state.isSelectMode === true`), 'Ctrl+点消息 → 直接进批量删除模式');
    ok(await ev(`state.selectedMessageIds.size === 1`), '并且那一条已经勾上了');
    await ev(`exitSelectMode()`);
  } else {
    ok(false, '（塞不进假消息，用例没跑到）');
  }

  await ev(`(() => { if (state.chatSelectMode) toggleChatSelectMode(); renderChatList(); return 1; })()`);
  if (await ev(`!!document.querySelector('.chat-item[data-cid]')`)) {
    await ctrlClick('.chat-item[data-cid]');
    ok(await ev(`state.chatSelectMode === true`), 'Ctrl+点对话 → 进对话多选');
    ok(await ev(`state.selectedChatIds.size === 1`), '❗那一条勾上了，且没有切走对话');
    await ev(`toggleChatSelectMode()`);
  } else {
    ok(false, '（没有对话可点，用例没跑到）');
  }

  // ── 右键提示 ──────────────────────────────────────────
  group('[7] 右键说「可以多选」');

  await ev(`(() => { document.getElementById('mselTip')?.remove(); return 1; })()`);
  await ev(`(() => {
    const el = document.querySelector('.chat-item[data-cid]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5,
    }));
    return 1;
  })()`);
  ok(await ev(`!!document.getElementById('mselTip')`), '没有右键菜单的地方 → 弹提示气泡');
  ok(await ev(`(document.getElementById('mselTip')?.textContent || '').includes('Ctrl')`),
    '提示里写了 Ctrl');

  await ev(`(() => { document.getElementById('mselTip')?.remove(); closeModelGroupMenu(); return 1; })()`);
  await ev(`(() => {
    const el = document.querySelector('.model-card-header[data-mid]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5,
    }));
    return 1;
  })()`);
  ok(await ev(`!!document.getElementById('modelGroupMenu')`), '模型上右键 → 还是弹分组菜单');
  ok(await ev(`!document.getElementById('mselTip')`),
    '❗气泡不去盖住已有的菜单（走 defaultPrevented 让路）');
  ok(await ev(`(document.getElementById('modelGroupMenu')?.textContent || '').includes('Ctrl')`),
    '提示改挂在菜单底部');

  // ── capture 的副作用 ──────────────────────────────────
  /* ❗Codex 审出来的：capture 阶段 stopPropagation 会让所有「点别处关闭」的
     冒泡监听跑不到。最危险的是消息右键菜单 —— 菜单留着还不算，配套的 _ctxNodeId
     还指着上一条消息，回头点「删除」就删错人。 */
  group('[7b] ❗Ctrl 命中时，旧浮层要一起关掉');

  await ev(`(() => {
    // 手工摆出「右键菜单开着，且 _ctxNodeId 指着某条消息」的现场
    const m = document.getElementById('contextMenu');
    m.style.display = 'flex';
    _ctxNodeId = 4242;
    return 1;
  })()`);
  ok(await ev(`document.getElementById('contextMenu').style.display === 'flex'`), '（前提）菜单确实开着');
  ok(await ev(`_ctxNodeId === 4242`), '（前提）_ctxNodeId 指着旧消息');

  await ev(`(() => { renderConfigs(); return 1; })()`);
  await ctrlClick('.model-card-header[data-mid]');
  ok(await ev(`document.getElementById('contextMenu').style.display === 'none'`),
    '❗Ctrl+点之后旧右键菜单关掉了');
  ok(await ev(`_ctxNodeId === null`),
    '❗_ctxNodeId 也清了（不清的话点菜单里的「删除」会删掉上一条消息）');

  // 面板类：开着才关，没开的别去动它（closePlusMenu 会顺带动输入栏布局）
  const plus = await ev(`(() => {
    const p = document.getElementById('plusMenu');
    if (!p) return 'no-el';
    p.classList.add('open');
    return 'ok';
  })()`);
  if (plus === 'ok') {
    await ctrlClick('.model-card-header[data-mid]');
    ok(await ev(`!document.getElementById('plusMenu').classList.contains('open')`),
      '加号面板也被关掉了');
  } else {
    ok(false, '（找不到 plusMenu，用例没跑到）');
  }

  /* ❗footer 菜单：菜单和箭头是一对，只藏菜单的话箭头还朝上，看着像还开着。
     （我原来自己 add('hidden') 就漏了箭头，Codex 二审逮到。） */
  const footer = await ev(`(() => {
    const m = document.getElementById('footerMenu'), c = document.getElementById('footerMenuChev');
    if (!m || !c) return 'no-el';
    m.classList.remove('hidden');
    c.style.transform = 'rotate(180deg)';
    return 'ok';
  })()`);
  if (footer === 'ok') {
    await ctrlClick('.model-card-header[data-mid]');
    ok(await ev(`document.getElementById('footerMenu').classList.contains('hidden')`),
      'footer 菜单关掉了');
    ok(await ev(`document.getElementById('footerMenuChev').style.transform === ''`),
      '❗箭头也转回去了（菜单和箭头是一对，漏一个就显示成"还开着"）');
  } else {
    ok(false, '（找不到 footerMenu/Chev，用例没跑到）');
  }

  // ── 功能指南 ──────────────────────────────────────────
  /* ⚠️ 这一组必须测 **openHub('help')** 这条路，不是 toggleHelp()。
     页面上根本没有用 toggleHelp 打开的地方 —— 它只出现在 ✕ 按钮和点背景关闭里，
     唯一的打开入口是大集合。第一版测试测的是 toggleHelp，全绿，
     可那条路人一次都走不到，等于什么都没验。 */
  group('[8] 功能指南：从大集合打开（唯一的真实入口）');

  ok(await ev(`(() => {
    const html = document.body.innerHTML;
    return /onclick="openHubSection\\('help'\\)"/.test(html);
  })()`), '大集合里有「功能指南」入口');

  await ev(`(() => { try { closeHub(); } catch (_) {} return 1; })()`);
  await ev(`openHub('help')`);
  await sleep(400);
  ok(await ev(`document.querySelector('.help-panel')?.parentElement?.id === 'hubContent'`),
    '面板被搬进了大集合的内容区');
  ok(await ev(`document.querySelectorAll('#helpToc .help-toc-item').length >= 15`),
    '❗左侧目录有东西（修之前这里是 0 —— HUB_SECTIONS.help.render 是 null，目录一次都不建）');
  ok(await ev(`document.getElementById('helpToc')?.getBoundingClientRect().height > 50`),
    '目录栏是撑开的');
  ok(await ev(`document.querySelector('#helpToc .help-toc-item')?.getBoundingClientRect().height > 10`),
    '❗目录项本身有高度（不是有 DOM 但塌成 0）');
  await ev(`closeHub()`);
  await sleep(200);
  ok(await ev(`document.querySelector('.help-panel')?.parentElement?.id === 'helpModal'`),
    '关掉之后面板搬回原来的 modal');

  group('[9] 功能指南预热');
  // 预热排在 2.5s 之后的 idle 里。前面的用例跑了一会儿，但别赌它一定过了
  for (let i = 0; i < 20 && !(await ev(`typeof _helpWarmed !== 'undefined' && _helpWarmed`)); i++) await sleep(500);
  ok(await ev(`_helpWarmed === true`), 'idle 预热跑过了');
  ok(await ev(`document.getElementById('helpModal').classList.contains('warm')`), '预热态挂上了');
  ok(await ev(`getComputedStyle(document.getElementById('helpModal')).visibility === 'hidden'`),
    '❗预热态完全不可见');
  ok(await ev(`getComputedStyle(document.getElementById('helpModal')).display === 'flex'`),
    '❗display 真的是 flex —— 全局有一条 .hidden{display:none!important}，'
    + '不加 !important 的话这里会静默变回 none，预热一点用没有');
  ok(await ev(`document.getElementById('helpModal').getBoundingClientRect().height > 0`),
    '❗已经排好版了（高度不为 0，说明布局树在，这才是预热的意义）');

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
