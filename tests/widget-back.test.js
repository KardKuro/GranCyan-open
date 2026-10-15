/* 小组件的 ✕ 退回小组件列表，不是一路掉回聊天（用户：要的）。
 *
 *  ① 小组件页里每个入口都走 openWidget(...) / openHubSection(..., 'widgets')，没有漏网的 closeHub();openXxx()
 *  ② 点弹窗自己的关闭键 / 点遮罩 / Esc 关掉 → 回小组件
 *  ③ 弹窗被别的按钮顺手关掉（填进输入框、去聊天）→ 不回，她要去聊天
 *  ④ 编程工作台会话行上的「×」是移入回收站，不能被当成关闭键
 *  ⑤ 从小组件进的生命体征/梦境/手环，手机上点返回回小组件，不是最外层功能列表
 *
 * 把 14-boot-brain-hub.js 里 hub 那一段**真代码**抠出来塞进 vm，DOM / MutationObserver 换成桩。
 * 真浏览器里 36 个入口挨个点开再点 ✕ 的冒烟在 10-09 跑过（playwright），这里守逻辑。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const html = read('index.html');
const hub = read('js/14-boot-brain-hub.js');

console.log('\n[1] 入口');
{
  const a = html.indexOf('<div id="widgetsHubHome"'), b = html.indexOf('<!-- ── 专注番茄钟', a);
  const seg = html.slice(a, b);
  const items = seg.match(/<div class="widget-item"[^>]*>/g) || [];
  const bad = items.filter(x => !/onclick="(openWidget\(open\w+\)|openHubSection\('\w+','widgets'\))"/.test(x));
  t('小组件页的每个入口都记得来路（openWidget / openHubSection(…, \'widgets\')）', items.length >= 30 && !bad.length, bad.slice(0, 3));
  t('没有漏网的 closeHub();openXxx()', !/onclick="closeHub\(\);open/.test(seg));
}

// ── 抠真代码：从 HUB_SECTIONS 到小组件那段监听器结束 ──
const start = hub.indexOf('const HUB_SECTIONS = {');
const endMark = "document.addEventListener('keydown', (e) => { if (_widgetOpen && e.key === 'Escape') _widgetCloseAt = Date.now(); }, true);";
const end = hub.indexOf(endMark);
t('抠得到 hub 那段代码', start > 0 && end > start);
const code = hub.slice(start, end + endMark.length);

function mkEl(id, cls = []) {
  const set = new Set(cls), attrs = {};
  const el = {
    id, children: [], parent: null, scrollTop: 0, textContent: '', dataset: {},
    get className() { return [...set].join(' '); },
    classList: {
      add: c => { set.add(c); el._mut(); }, remove: c => { set.delete(c); el._mut(); },
      contains: c => set.has(c), toggle: (c, on) => { (on ?? !set.has(c)) ? set.add(c) : set.delete(c); el._mut(); },
    },
    getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; },
    appendChild(ch) { if (ch.parent) ch.parent.children = ch.parent.children.filter(x => x !== ch); ch.parent = el; el.children.push(ch); },
    contains(x) { for (let p = x; p; p = p.parent) if (p === el) return true; return false; },
    closest(sel) { for (let p = el; p; p = p.parent) if (p._btn) return p; return null; },
    _obs: [], _mut() { el._obs.forEach(o => o.pending = true); },
  };
  return el;
}

function box() {
  const els = {};
  const add = (id, cls) => (els[id] = mkEl(id, cls));
  add('hubModal', ['hidden']); add('hubShell'); add('hubContent'); add('hubDetailTitle');
  const home = add('widgetsHubHome', ['hidden']);
  const panel = mkEl('', ['hub-widgets-panel']); home.appendChild(panel);
  for (const n of ['vitals', 'dreams', 'band']) { const h = add(n + 'HubHome', ['hidden']); h.appendChild(mkEl('', ['p-' + n])); }
  const modal = add('demoModal', ['hidden']);
  const closeBtn = mkEl(''); closeBtn._btn = true; closeBtn.setAttribute('onclick', 'closeDemo()'); closeBtn.textContent = '✕'; modal.appendChild(closeBtn);
  const sendBtn = mkEl(''); sendBtn._btn = true; sendBtn.setAttribute('onclick', 'demoSendToChat()'); sendBtn.textContent = '发到聊天'; modal.appendChild(sendBtn);
  const trashX = mkEl(''); trashX._btn = true; trashX.setAttribute('onclick', "cwDeleteSession('s1')"); trashX.textContent = '×'; modal.appendChild(trashX);
  const sel = {
    '#widgetsHubHome > .hub-widgets-panel': () => panel,
    '.hub-widgets-panel': () => panel,
    '#vitalsHubHome > .dreams-panel': () => els.vitalsHubHome.children[0],
    '#dreamsHubHome > .dreams-panel': () => els.dreamsHubHome.children[0],
    '#bandModal > .memory-panel': () => els.vitalsHubHome.children[0],
  };
  const listeners = [];
  const observers = [];
  const ctx = {
    console, Date, Set, Math, performance: { now: () => Date.now() },
    requestAnimationFrame: f => f(),
    getComputedStyle: () => ({ display: 'block' }),
    isMobileLayout: () => true, closeFooterMenu() {},
    document: {
      getElementById: id => els[id] || null,
      querySelector: s => (sel[s] ? sel[s]() : null),
      querySelectorAll: s => s === '[id$="Modal"]' ? Object.values(els).filter(e => /Modal$/.test(e.id)) : [],
      addEventListener: (ev, fn, cap) => listeners.push({ ev, fn, cap }),
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; el._obs.push(this); }
      disconnect() { if (this.el) this.el._obs = this.el._obs.filter(o => o !== this); }
    },
    renderMemoryList() {}, renderFavList() {}, buildHelpToc() {}, vitalsRenderPanel() {}, dreamRenderSettings() {}, dreamRenderGallery() {},
    renderConfigs() {}, renderBandPanel() {},
  };
  ctx.closeDemo = () => els.demoModal.classList.add('hidden');
  ctx.openDemo = () => els.demoModal.classList.remove('hidden');
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  // MutationObserver 是异步的：手动冲一下
  const flushObs = () => { for (const e of Object.values(els)) for (const o of [...e._obs]) if (o.pending) { o.pending = false; o.cb([]); } };
  const click = target => {
    const ev = { target };
    for (const l of listeners.filter(x => x.ev === 'click' && x.cap)) l.fn(ev);
    const call = target.getAttribute('onclick');
    if (call) ctx[call.replace(/\(.*$/, '')]?.();
    flushObs();
  };
  const key = k => { for (const l of listeners.filter(x => x.ev === 'keydown' && x.cap)) l.fn({ key: k }); };
  return { ctx, els, panel, closeBtn, sendBtn, trashX, click, key, flushObs };
}
const hubOpenOnWidgets = b => !b.els.hubModal.classList.contains('hidden') && b.panel.parent === b.els.hubContent;

console.log('\n[2] ✕ 回小组件');
{
  const b = box();
  b.ctx.openHub('widgets');
  t('打开小组件：列表挂进 hub', hubOpenOnWidgets(b));
  b.panel.scrollTop = 640;
  b.ctx.openWidget(b.ctx.openDemo);
  t('点进小组件：hub 关掉、弹窗开着', b.els.hubModal.classList.contains('hidden') && !b.els.demoModal.classList.contains('hidden'));
  b.panel.scrollTop = 0;                       // 搬走以后滚动位置会丢，模拟一下
  b.click(b.closeBtn);
  t('点弹窗的 ✕ → 回到小组件列表', hubOpenOnWidgets(b) && b.els.demoModal.classList.contains('hidden'));
  t('而且回到刚才滑到的位置', b.panel.scrollTop === 640, b.panel.scrollTop);
}
{
  const b = box();
  b.ctx.openHub('widgets'); b.ctx.openWidget(b.ctx.openDemo);
  b.key('Escape'); b.ctx.closeDemo(); b.flushObs();
  t('Esc 关掉 → 也回小组件', hubOpenOnWidgets(b));
}
{
  const b = box();
  b.ctx.openHub('widgets'); b.ctx.openWidget(b.ctx.openDemo);
  b.click(b.els.demoModal);                     // 点遮罩（target 是弹窗本身）
  b.ctx.closeDemo(); b.flushObs();
  t('点遮罩关掉 → 也回小组件', hubOpenOnWidgets(b));
}

console.log('\n[3] 不该回的时候不回');
{
  const b = box();
  b.ctx.openHub('widgets'); b.ctx.openWidget(b.ctx.openDemo);
  b.ctx.demoSendToChat = () => b.ctx.closeDemo();   // 「发到聊天」顺手把弹窗关了
  b.click(b.sendBtn);
  t('别的按钮顺手关掉弹窗（她要去聊天）→ 不回小组件', b.els.hubModal.classList.contains('hidden'));
}
{
  const b = box();
  b.ctx.openDemo();                             // 聊天里的卡片 / AI 指令直接开的，不是从小组件进的
  b.click(b.closeBtn);
  t('不是从小组件进的，✕ 照旧回聊天', b.els.hubModal.classList.contains('hidden'));
}
{
  const b = box();
  b.ctx.openHub('widgets'); b.ctx.openWidget(b.ctx.openDemo);
  b.ctx.closeDemo(); b.flushObs();
  b.ctx.openDemo(); b.click(b.closeBtn);
  t('只盯一次：回过（或没回）之后，下一次从别处打开的不受影响', b.els.hubModal.classList.contains('hidden'));
}
{
  const b = box();
  b.ctx.openHub('widgets');
  b.ctx.openWidget(() => {});                  // 无缝换窗没对话时只弹 toast，什么也没开
  t('什么都没打开就什么都不盯', vm.runInContext('_widgetOpen', b.ctx) === null);
}

console.log('\n[4] 认关闭键');
{
  const b = box();
  const isClose = el => vm.runInContext('_isCloseCtl', b.ctx)(el);
  t('onclick="closeDemo()" 是关闭键', isClose(b.closeBtn));
  t('长得像 × 但 onclick 是移入回收站的，不是关闭键', !isClose(b.trashX));
  t('「发到聊天」不是关闭键', !isClose(b.sendBtn));
  const bare = mkEl(''); bare.textContent = '✕';
  t('没写 onclick（JS 绑的）的「✕」按字形认', isClose(bare));
  const titled = mkEl(''); titled.setAttribute('aria-label', '关闭面板');
  t('aria-label 写着「关闭」的认', isClose(titled));
}

console.log('\n[5] hub 里的子页');
{
  const b = box();
  b.ctx.openHub('widgets');
  b.ctx.openHubSection('vitals', 'widgets');
  t('从小组件进生命体征', b.els.vitalsHubHome.children.length === 0);
  b.ctx.hubBackToList();
  t('手机上点返回 → 回小组件，不是最外层功能列表', hubOpenOnWidgets(b) && b.els.hubShell.classList.contains('hub-detail'));
  b.ctx.hubBackToList();
  t('再点一次返回才回最外层列表', !b.els.hubShell.classList.contains('hub-detail'));
}
{
  const b = box();
  b.ctx.openHub('dreams');
  b.ctx.hubBackToList();
  t('不是从小组件进的子页，返回照旧回最外层列表', !b.els.hubShell.classList.contains('hub-detail'));
}
{
  // 用户：生命体征右上角的 ✕ 点完要回上一级，不是直接掉回聊天
  const b = box();
  b.ctx.openHub('widgets');
  b.ctx.openHubSection('vitals', 'widgets');
  b.ctx.hubCloseOrBack();
  t('★ 从小组件进的生命体征，✕ → 回小组件，hub 不关', hubOpenOnWidgets(b) && !b.els.hubModal.classList.contains('hidden'));
  b.ctx.hubCloseOrBack();
  t('在小组件里再点 ✕ 才关回聊天', b.els.hubModal.classList.contains('hidden'));
}
{
  const b = box();
  b.ctx.openHub('vitals');
  b.ctx.hubCloseOrBack();
  t('不是从小组件进的（直接开的生命体征），✕ 照旧关回聊天', b.els.hubModal.classList.contains('hidden'));
}

console.log('\n[6] 每个从小组件进的 hub 子页右上角都有 ✕（用户：每个小组件都要有 ✕ 回上一级）');
{
  // 弹窗类的小组件有自己的 ✕（真浏览器里挨个点过）；挂进 hub 的子页原本只有生命体征有，
  // 梦境、手环在桌面上只剩左栏最底下那个「关闭」，一点就掉回聊天
  const subs = [...new Set([...html.matchAll(/onclick="openHubSection\('(\w+)','widgets'\)"/g)].map(m => m[1]))];
  t('抠得到从小组件进的子页', subs.length >= 3, subs);
  for (const name of subs) {
    const m = hub.match(new RegExp(name + ":\\s*\\{ sel:'#(\\w+)"));
    const home = m && m[1];
    const a = home ? html.indexOf('id="' + home + '"') : -1;
    // 子页的 markup：从它的 home 到下一个顶层 <div id=
    const b = a < 0 ? -1 : html.indexOf('\n<div id=', a + 1);
    const seg = a < 0 ? '' : html.slice(a, b < 0 ? undefined : b);
    t(`${name}：面板里有走 hubCloseOrBack() 的 ✕`, /<button[^>]*onclick="hubCloseOrBack\(\)"/.test(seg), home);
  }
  const css = read('css/grancyan.css');
  t('.hub-x 平时藏着、进了 hub 才出来（手环在 hub 外是独立弹窗，有自己的 ✕）',
    /\.hub-x \{ display:none/.test(css) && /\.in-hub \.hub-x \{ display:grid/.test(css));
}

console.log('\n[7] 伴读书架（整页跳走的）的 ✕ / 返回 回到小组件');
{
  const reader = read('coread/routes/reader.js');
  const shelf = reader.slice(reader.indexOf("app.get('/reading',"), reader.indexOf("app.get('/api/reading-export'"));
  t('电脑书架：右上角有 ✕，指向 /#widgets', /<a class="x" href="\/#widgets"[^>]*>✕<\/a>/.test(shelf));
  t('电脑书架：「← 返回」也回 /#widgets，不再掉在聊天里', /<a class="back" href="\/#widgets">← 返回<\/a>/.test(shelf) && !/href="\/"/.test(shelf));
  const and = read('android/src/com/grancyan/app/CoreadServer.java');
  t('安卓离线书架：也有 ✕ 指向 /#widgets（原来连返回都没有）', and.includes('<a class=\\"x\\" href=\\"/#widgets\\"'));
  const act = read('android/src/com/grancyan/app/MainActivity.java');
  t('安卓壳：书架点回根路径时把 #widgets 带过去', /url\.getFragment\(\)/.test(act) && /"\/index\.html" \+ \(frag/.test(act));

  // 开机那一刀抠出来真跑一遍
  const boot = hub.match(/  if \(location\.hash === '#widgets'\) \{[\s\S]*?\n  \}/);
  t('开机认 #widgets', !!boot);
  if (boot) {
    const run = hash => {
      const calls = [];
      const ctx = { location: { hash, pathname: '/index.html', search: '' },
        history: { replaceState: (a, b, u) => calls.push('replace:' + u) }, openHub: s => calls.push('openHub:' + s) };
      vm.runInNewContext(boot[0], ctx);
      return calls;
    };
    const c = run('#widgets');
    t('带 #widgets 回来 → 打开小组件，并把 # 抹掉（刷新不会又弹一次）', c.includes('openHub:widgets') && c.includes('replace:/index.html'), c);
    t('平常开机不带 # → 什么都不做', run('').length === 0);
  }
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
