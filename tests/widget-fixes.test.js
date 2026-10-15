/* 小部件一批静默 bug 的回归测试（2026-09-27）。
 *
 *  ① 工作台：appPrompt 里按 Esc 取消，冒泡到 document 把正在跑的任务杀了
 *  ② 工作台：GET 状态失败 / 服务端读盘瞬时出错 → 空状态被 PUT 回去盖掉全部项目
 *  ③ 工作台：流还在跑时重开，整棵状态树被换掉，流写进孤儿会话，新树那条永远 running
 *  ④ 大富翁：看门狗不带代际，上一回合的 5 秒定时器在 AI 回合中途解锁并把回合抢回来
 *  ⑤ 生活：window.prompt 在 exe 和 WebView 里是死的
 *  ⑥ 网页坞：同步完成后整块重画，把正在用的 iframe 重新加载
 *  ⑦ 网页坞：远端清单里的 javascript: 地址拿到 allow-same-origin
 *  ⑧ 画板 / 气泡：IDB 读失败被当成「没有」，画板被种子盖掉、主题被永久摘掉
 *
 * 除了服务端直接 require（HOME 指到临时目录），前端都是把**真文件**整个塞进 vm 跑，
 * DOM / fetch / 定时器换成桩。没有正则扫源码。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

function funcBody(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}

const flush = () => new Promise(r => setImmediate(r));
// 手摇时钟：setTimeout 只进队列，advance 时按时间顺序一个个放出来，每放一个都把微任务排干。
function clock() {
  let now = 0, seq = 0;
  const q = [];
  const setT = (fn, ms) => { const id = ++seq; q.push({ id, at: now + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearT = id => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      q.sort((a, b) => a.at - b.at || a.id - b.id);
      const nx = q[0];
      if (!nx || nx.at > end) break;
      q.shift(); now = nx.at; nx.fn();
    }
    now = end; await flush();
  }
  return { setTimeout: setT, clearTimeout: clearT, advance, get now() { return now; } };
}
const mkKey = (key) => ({
  key, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}
});

(async () => {
  // ════════════════════════════════════════════════════════════════
  // 工作台（前端）
  // ════════════════════════════════════════════════════════════════
  const cwSrc = read('js/41-code-workbench.js');
  const appPromptSrc = funcBody(read('js/02-state.js'), 'appPrompt');
  t('切得出 appPrompt 真身', appPromptSrc.length > 500);

  function cwBox(getState) {
    const c = clock();
    const els = {}, handlers = {}, puts = [], toasts = [];
    els.codeWorkbenchModal = { classList: { contains: () => false, add() {}, remove() {} } };
    const mkEl = () => ({ style: {}, textContent: '', value: '', onclick: null, onkeydown: null, focus() {}, select() {} });
    const box = {
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Map, Set, RegExp, Error,
      setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: () => 0, clearInterval() {},
      SERVER_BASE: 'http://srv',
      fetch: async (url, opt = {}) => {
        if ((opt.method || 'GET') === 'PUT') { puts.push(JSON.parse(opt.body)); return { ok: true, json: async () => ({ ok: true }) }; }
        if (String(url).endsWith('/api/code-workbench/state')) return getState();
        return { ok: true, json: async () => ({ runs: [] }) };
      },
      showToast: m => toasts.push(String(m)), escHtml: s => String(s), autoResize() {},
      document: {
        getElementById: id => els[id] || null,
        addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [],
        createElement: () => {
          const parts = {};
          ['#appPromptInput', '#appPromptMsg', '#appPromptOk', '#appPromptCancel', '#appPromptBackdrop'].forEach(k => { parts[k] = mkEl(); });
          return { style: {}, id: '', innerHTML: '', querySelector: sel => parts[sel] || null };
        },
        body: { appendChild: w => { els[w.id] = w; } }
      },
      window: {}
    };
    vm.createContext(box);
    vm.runInContext(cwSrc, box, { filename: '41-code-workbench.js' });
    vm.runInContext(appPromptSrc, box, { filename: '02-state.js#appPrompt' });
    // 渲染和恢复跟这几条 bug 无关，换成空函数；cwStop 换成计数器
    box.__stops = 0;
    vm.runInContext('cwRender = cwBindDropZone = cwStartThinkingTicker = cwRecoverRuns = cwRenderAttachments = function () {};'
      + 'cwStop = function () { __stops++; };', box);
    const keydown = e => (handlers.keydown || []).forEach(fn => fn(e));
    return { box, c, els, puts, toasts, keydown, run: code => vm.runInContext(code, box) };
  }
  const okState = st => () => ({ ok: true, json: async () => ({ ok: true, state: JSON.parse(JSON.stringify(st)) }) });
  const baseState = () => ({
    version: 1, activeProjectId: 'p1', activeSessionId: 's1', activeProvider: 'codex',
    projects: [{ id: 'p1', name: 'P', cwd: 'C:\\projects\\P', provider: 'codex',
      sessions: [{ id: 's1', title: '任务', status: 'running', runId: 'r1', messages: [{ id: 'm1', role: 'user', content: 'hi' }], events: [] }] }]
  });

  console.log('\n【①】appPrompt 里按 Esc 不许杀掉正在跑的任务');
  {
    const W = cwBox(okState(baseState()));
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    t('前提：当前会话在 running', W.run("cwSession()?.status") === 'running');

    // 真实路径：appPrompt 的 textarea 先吃到 keydown（它 preventDefault），再冒泡到 document
    const p1 = W.run("appPrompt('修改会话标题', '任务')");
    const input = W.els.appPromptModal.querySelector('#appPromptInput');
    const ev = mkKey('Escape');
    input.onkeydown(ev); W.keydown(ev);
    const v1 = await p1;
    t('Esc 取消了弹窗（appPrompt 返回 null）', v1 === null, v1);
    t('★ 冒泡到 document 的那次 Esc 没有触发 cwStop', W.box.__stops === 0, W.box.__stops);

    // 焦点不在输入框（点了弹窗空白处）：appPrompt 自己没接到，document 直接收到
    const p2 = W.run("appPrompt('另一个', '')");
    W.keydown(mkKey('Escape'));
    t('★ 弹窗还开着时的 Esc 也不杀任务', W.box.__stops === 0, W.box.__stops);
    W.els.appPromptModal.querySelector('#appPromptCancel').onclick(); await p2;

    // 对照组：没有弹窗时，Esc 仍然是「中断任务」
    W.keydown(mkKey('Escape'));
    t('对照：没有弹窗时 Esc 照旧中断任务', W.box.__stops === 1, W.box.__stops);
  }

  console.log('\n【②】读状态失败时绝不回写');
  {
    const W = cwBox(async () => { throw new Error('ECONNREFUSED'); });
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    t('★ GET 抛错：打开后没有 PUT', W.puts.length === 0, W.puts.length);
    W.run('cwScheduleSave()'); W.run('closeCodeWorkbench()'); await W.c.advance(1000);
    t('★ 之后的任何保存也不 PUT（内存里是空壳）', W.puts.length === 0, W.puts.length);
    t('并且提示用户这次不会保存', W.toasts.some(m => /没读出来/.test(m)), W.toasts);
  }
  {
    const W = cwBox(() => ({ ok: false, json: async () => ({ ok: false, error: '工作台记录读取失败：EBUSY' }) }));
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    t('★ 服务端 500 {ok:false}：没有 PUT', W.puts.length === 0, W.puts.length);
  }
  {
    const W = cwBox(okState(baseState()));
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    t('对照：GET 成功照常回写一次，内容是读到的那份', W.puts.length === 1 && W.puts[0].projects.length === 1, W.puts.length);
  }

  console.log('\n【③】流还在跑时重开：活的会话对象要嫁接进新树');
  {
    let serverState = baseState();
    const W = cwBox(() => okState(serverState)());
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    // 模拟 cwRunTurn 正在跑：_cwStreams 里有这条，流闭包攥着旧的会话对象
    W.run("globalThis.__live = cwFindSession('s1').s; _cwStreams.set('s1', { controller: { abort() {} } });");
    W.run("__live.messages.push({ id: 'a1', role: 'assistant', content: '写到一半' });");
    W.run('closeCodeWorkbench()');
    // 另一个窗口在服务端加了一条会话；服务端那份 s1 是旧快照
    serverState = baseState();
    serverState.projects[0].sessions.push({ id: 's2', title: '别的窗口建的', status: 'idle', messages: [{ id: 'x', role: 'user', content: 'y' }], events: [] });
    await W.run('openCodeWorkbench()'); await W.c.advance(1000);
    t('新树确实换上了（别的窗口建的 s2 在）', !!W.run("cwFindSession('s2')"));
    t('★ s1 是还在被流写的那个活对象', W.run("cwFindSession('s1').s === __live"));
    // 流收尾：写进活对象
    W.run("__live.messages[1].content += '，写完了'; __live.status = 'idle'; _cwStreams.delete('s1'); cwScheduleSave();");
    await W.c.advance(1000);
    t('★ 新树里看得到流写完的回复和 idle 状态',
      W.run("cwFindSession('s1').s.status") === 'idle' && W.run("cwFindSession('s1').s.messages[1].content") === '写到一半，写完了');
    const last = W.puts[W.puts.length - 1];
    const s1 = last && last.projects[0].sessions.find(s => s.id === 's1');
    t('★ 落盘的也是写完的那份，不会永远停在 running', s1 && s1.status === 'idle' && s1.messages.length === 2, s1 && s1.status);
  }

  // ════════════════════════════════════════════════════════════════
  // 工作台（服务端）：HOME 指到临时目录，真跑 code-workbench.js
  // ════════════════════════════════════════════════════════════════
  console.log('\n【②·服务端】只有 ENOENT 才算空；读不了就报错，坏了就留底');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cw-'));
    const oldEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = tmp; process.env.HOME = tmp;
    const homeOk = os.homedir() === tmp;
    t('前提：os.homedir() 指到了临时目录（否则不跑，免得碰真记录）', homeOk, os.homedir());
    if (homeOk) {
      delete require.cache[require.resolve('../code-workbench.js')];
      const cw = require('../code-workbench.js');
      const dir = path.join(tmp, '.grancyan', 'code-workbench');
      const STATE = path.join(dir, 'state.json');
      const realRead = fs.readFileSync;
      const busy = on => {
        fs.readFileSync = on ? function (p, ...a) {
          if (path.resolve(String(p)) === STATE) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
          return realRead.call(fs, p, ...a);
        } : realRead;
      };
      const routes = {};
      cw.mountCodeWorkbench({ get: (p, h) => { routes['GET ' + p] = h; }, put: (p, h) => { routes['PUT ' + p] = h; }, post() {} });
      const call = (k, body) => {
        const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        routes[k]({ body }, res); return res;
      };

      t('没有文件 → 空状态', cw.loadState().projects.length === 0);
      const one = { version: 1, projects: [{ id: 'p1', name: 'P', sessions: [] }] };
      cw.saveState(one);
      t('存了读得回来', cw.loadState().projects[0].id === 'p1');

      busy(true);
      let threw = '';
      try { cw.loadState(); } catch (e) { threw = e.message; }
      const g = call('GET /api/code-workbench/state');
      busy(false);
      t('★ EBUSY 读失败 → loadState 抛错，不是返回空', /EBUSY/.test(threw), threw);
      t('★ GET 回 500 + ok:false（前端据此不回写）', g.code === 500 && g.body && g.body.ok === false, g.code);
      t('文件原封未动', JSON.parse(realRead(STATE, 'utf8')).projects[0].id === 'p1');

      // 外部把文件换成了坏的（我们没见过这个指纹）→ 保存前先留底
      fs.writeFileSync(STATE, '{ 坏掉的 json');
      cw.saveState({ version: 1, projects: [] });
      let backups = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
      t('★ 覆盖一份读不懂的记录之前先留了 .corrupt 底', backups.length === 1
        && realRead(path.join(dir, backups[0]), 'utf8') === '{ 坏掉的 json', backups);

      // 外部改过、而这一刻又读不了 → 不写
      fs.writeFileSync(STATE, JSON.stringify({ version: 1, projects: [{ id: 'keep' }] }));
      busy(true);
      const pr = call('PUT /api/code-workbench/state', { version: 1, projects: [] });
      busy(false);
      t('★ 盘上那份被别人动过且读不了 → PUT 拒绝（400）', pr.code === 400, pr.code);
      t('★ 并且没有覆盖', JSON.parse(realRead(STATE, 'utf8')).projects[0].id === 'keep');

      // 盘上内容本身坏了 → 挪走留底，当空的开局
      fs.writeFileSync(STATE, 'not json at all');
      const before = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-')).length;
      const empty = cw.loadState();
      backups = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
      t('★ 坏 JSON → 挪成 .corrupt 留底后返回空', empty.projects.length === 0 && backups.length === before + 1 && !fs.existsSync(STATE), backups);
      t('留底的是原内容', backups.some(f => realRead(path.join(dir, f), 'utf8') === 'not json at all'));
      cw.saveState({ version: 1, projects: [{ id: 'fresh' }] });
      t('之后照常能存', cw.loadState().projects[0].id === 'fresh');
    }
    process.env.USERPROFILE = oldEnv.USERPROFILE; process.env.HOME = oldEnv.HOME;
    if (oldEnv.HOME === undefined) delete process.env.HOME;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ════════════════════════════════════════════════════════════════
  // 大富翁
  // ════════════════════════════════════════════════════════════════
  console.log('\n【④】大富翁：过期的看门狗不许动下一回合');
  function monoBox() {
    const c = clock();
    const ls = new Map();
    const die = { textContent: '', classList: { add() {}, remove() {} } };
    const fixedMath = Object.create(Math); fixedMath.random = () => 0.99;   // 永远掷 6
    const box = {
      console, JSON, Object, Array, String, Number, Boolean, Promise, Map, Set, RegExp, Error,
      Math: fixedMath, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
      localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
      state: { configs: [] }, escHtml: s => String(s),
      document: {
        getElementById: () => null,
        querySelector: sel => (sel === '#monopolyBody .mono-die' ? die : null),
        querySelectorAll: () => [], body: null
      }
    };
    vm.createContext(box);
    vm.runInContext(read('js/35-monopoly.js'), box, { filename: '35-monopoly.js' });
    // 让 AI 的棋子动画卡住，直到测试放行 —— 模拟真机上动画拖过 5 秒
    vm.runInContext('globalThis.__gate = null; const __realPawn = _monoPawnAnimation;'
      + "_monoPawnAnimation = function (k, f, d) { if (k !== 'ai') return Promise.resolve(); return new Promise(r => { __gate = r; }); };", box);
    return { box, c, run: code => vm.runInContext(code, box) };
  }
  {
    const M = monoBox();
    M.run('openMonopoly()');
    M.run('monoRoll()');                 // t=0：用户掷骰，第一只看门狗 5000ms 后醒
    await M.c.advance(1300);             // 用户动画走完 → 轮到 AI（650ms 后开跑）
    await M.c.advance(1000);             // t≈2.3s：AI 回合开始，卡在棋子动画里
    t('前提：AI 回合正在动画中', M.run("_mono.turn") === 'ai' && M.run('_monoAnimating') === true);
    await M.c.advance(3000);             // t≈5.3s：用户那一回合的看门狗醒了
    t('★ 上一回合的看门狗醒来不解锁 AI 的动画', M.run('_monoAnimating') === true);
    t('★ 也不把回合抢回给用户', M.run('_mono.turn') === 'ai', M.run('_mono.turn'));
    t('不写「动画超时」', !M.run('_mono.log.join()').includes('动画超时'));
    M.run('__gate()'); await M.c.advance(100);
    t('放行后 AI 正常走完这一步、回合交回用户', M.run('_mono.turn') === 'user' && M.run('_mono.players.ai.pos') === 6, M.run('_mono.players.ai.pos'));
  }
  {
    const M = monoBox();
    M.run('openMonopoly()');
    M.run('monoRoll()');
    await M.c.advance(2300);
    const posBefore = M.run('_mono.players.ai.pos');
    await M.c.advance(5000);             // AI 自己那只看门狗到点：真卡住了
    t('对照：AI 动画真卡 5 秒，它自己那代看门狗照样解锁并还回合',
      M.run('_monoAnimating') === false && M.run('_mono.turn') === 'user' && M.run('_mono.log.join()').includes('动画超时'));
    M.run('__gate()'); await M.c.advance(100);
    t('★ 被换代的旧协程醒来后不再落子', M.run('_mono.players.ai.pos') === posBefore, M.run('_mono.players.ai.pos'));
  }

  // ════════════════════════════════════════════════════════════════
  // 生活：appPrompt
  // ════════════════════════════════════════════════════════════════
  console.log('\n【⑤】生活 不再调 window.prompt');
  const deadPrompt = () => { throw new Error('window.prompt 在 exe / WebView 里是死的'); };
  {
    const noop = () => {};
    const el = { style: {}, value: '', innerHTML: '', textContent: '', classList: { add: noop, remove: noop, toggle: noop, contains: () => false } };
    const answers = [];
    const box = {
      state: { lifeOn: true, lifeCycleShare: true },
      save: noop, showToast: noop, prompt: deadPrompt, confirm: () => true,
      appPrompt: async () => answers.shift(),
      escHtml: s => String(s == null ? '' : s), document: { getElementById: () => el },
      Math, Date, JSON, console, Object, Array, String, Number, Boolean, RegExp, Set, isNaN, Promise
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(read('js/49-life.js'), box, { filename: '49-life.js' });
    const today = vm.runInContext('lifeToday()', box);
    const s = vm.runInContext(`lifeAdd(${JSON.stringify(today)}, -40)`, box);
    const e = vm.runInContext(`lifeAdd(${JSON.stringify(today)}, -35)`, box);
    answers.push(s, '');
    let err = '';
    try { await vm.runInContext('lifeCycleBackfill()', box); } catch (x) { err = x.message; }
    let list = vm.runInContext('lifePeriodList()', box);
    t('★ 补记一次走 appPrompt，记上了（结束留空）', !err && list.some(p => p.start === s && !p.end), err || list);
    answers.push(e);
    err = '';
    try { await vm.runInContext(`lifeCycleCloseAt(${JSON.stringify(s)})`, box); } catch (x) { err = x.message; }
    list = vm.runInContext('lifePeriodList()', box);
    t('★ 补结束走 appPrompt，结束日期写上了', !err && list.some(p => p.start === s && p.end === e), err || list);
  }

  // ════════════════════════════════════════════════════════════════
  // 网页坞
  // ════════════════════════════════════════════════════════════════
  function wdBox(fetchImpl) {
    const els = {}, opened = [];
    let renders = 0, frameSeq = 0;
    const body = {};
    Object.defineProperty(body, 'innerHTML', {
      get() { return this._h || ''; },
      set(v) {
        renders++; this._h = v;
        // 模拟 DOM：整块重画 = 旧 iframe 被扔掉、换一个新的
        els.wdFrame = /id="wdFrame"/.test(v) ? { n: ++frameSeq, dataset: {}, srcSets: 0, set src(u) { this._src = u; this.srcSets++; }, get src() { return this._src; } } : null;
      }
    });
    els.wdBody = body;
    els.webdockModal = { classList: { add() {}, remove() {} } };
    const box = {
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Set, Map, RegExp, Error, URL,
      setTimeout, clearTimeout, AbortController,
      state: { webDockItems: [{ url: 'https://a.example/x', name: 'A' }], webDockRemote: [], webDockSrc: 'https://list.example/l.json' },
      save() {}, showToast() {}, escHtml: s => String(s == null ? '' : s), jsAttr: s => JSON.stringify(s),
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
      fetch: (...a) => fetchImpl(...a),
      document: { getElementById: id => els[id] || null },
    };
    box.window = { addEventListener() {}, open: u => opened.push(u) };
    vm.createContext(box);
    vm.runInContext(read('js/25-webdock.js'), box, { filename: '25-webdock.js' });
    return { box, els, opened, renders: () => renders, run: code => vm.runInContext(code, box) };
  }
  const listResp = arr => async () => ({ ok: true, json: async () => arr });

  console.log('\n【⑥】同步完成不许把正在用的 iframe 重新加载');
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const D = wdBox(async () => { await gate; return { ok: true, json: async () => [{ url: 'https://b.example/', name: 'B' }] }; });
    D.run("webDockOpen('https://a.example/x')");
    const frame = D.els.wdFrame;
    t('前提：打开了页面，iframe 已加载一次', frame && frame.src === 'https://a.example/x' && frame.srcSets === 1);
    const r0 = D.renders();
    const p = D.run('webDockSync(false)');   // 进坞时那次后台同步，用户已经点开了页面
    release(); await p;
    t('★ 同步前后都没有重画 body', D.renders() === r0, D.renders() - r0);
    t('★ 还是同一个 iframe，没被重新加载', D.els.wdFrame === frame && frame.srcSets === 1, frame.srcSets);
    t('同步的数据照样落下了', D.box.state.webDockRemote.length === 1);
    D.run('webDockBackToList()');
    const r1 = D.renders();
    await D.run('webDockSync(true)');
    t('对照：在列表页同步会刷新列表', D.renders() > r1);
  }

  console.log('\n【⑦】只放行 http(s)，javascript: 进不了 iframe 也打不开');
  {
    const D = wdBox(listResp([
      { url: 'javascript:alert(document.cookie)', name: 'evil' },
      { url: '  JAVASCRIPT:alert(1)', name: 'evil2' },
      { url: 'data:text/html,<script>1</script>', name: 'evil3' },
      { url: 'https://b.example/', name: 'B' }
    ]));
    await D.run('webDockSync(true)');
    t('★ 远端清单只留下 https 那条', JSON.stringify(D.box.state.webDockRemote.map(x => x.url)) === '["https://b.example/"]',
      D.box.state.webDockRemote.map(x => x.url));
    D.box.state.webDockRemote = [{ url: 'javascript:alert(1)', name: '旧缓存里的坏条目' }];
    t('★ 缓存里残留的 javascript: 条目不会出现在列表', !D.run('webDockList()').some(x => /^javascript:/i.test(x.url)));
    D.run("webDockOpen('javascript:alert(1)')");
    t('★ webDockOpen 拒绝 javascript:', D.run('_wdCurrent') === null && !D.els.wdFrame, D.run('_wdCurrent'));
    D.run("_wdCurrent = { url: 'javascript:alert(1)', name: 'x' }; webDockExternal();");
    t('★ 外部打开也拒绝 javascript:', D.opened.length === 0, D.opened);
    D.run("_wdCurrent = { url: 'https://b.example/', name: 'B' }; webDockExternal();");
    t('对照：https 照常外部打开', D.opened.length === 1 && D.opened[0] === 'https://b.example/');
  }

  // ════════════════════════════════════════════════════════════════
  // 画板 / 气泡：读失败 ≠ 没有
  // ════════════════════════════════════════════════════════════════
  console.log('\n【⑧】画板：IDB 读失败不许用种子盖掉真画板');
  {
    const idb = new Map();
    let sets = 0, failReads = 0;
    const real = [{ id: 'g1', kind: 'html', src: '<p>真画</p>', author: '小明', caption: '', ts: 1 }];
    idb.set('kuro_gallery', JSON.stringify(real));
    const box = {
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Set, Map, RegExp, Error,
      setTimeout, clearTimeout, state: {},
      idbGet: async k => { if (failReads > 0) { failReads--; throw new Error('IDB 读抖了一下'); } return idb.has(k) ? idb.get(k) : null; },
      idbSet: async (k, v) => { sets++; idb.set(k, v); },
      showToast() {}, escHtml: s => String(s == null ? '' : s),
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    };
    box.globalThis = box;
    vm.createContext(box);
    vm.runInContext(read('js/53-gallery-seed.js') + '\nglobalThis.GALLERY_SEED = GALLERY_SEED;', box, { filename: '53-gallery-seed.js' });
    vm.runInContext(read('js/53-gallery.js'), box, { filename: '53-gallery.js' });

    failReads = 1;
    let threw = false;
    try { await vm.runInContext('galleryLoad()', box); } catch { threw = true; }
    t('★ 读失败 → galleryLoad 报错，而不是装作是新画板', threw);
    t('★ 没有写回（种子没盖上去）', sets === 0 && JSON.parse(idb.get('kuro_gallery'))[0].id === 'g1', sets);
    t('也没缓存成空数组（下次还会重读）', vm.runInContext('_galleryItems', box) === null);
    failReads = 1;
    const added = await vm.runInContext("galleryAdd({ kind: 'html', src: '<p>新画</p>' })", box);
    t('★ 读失败时挂画 → 不挂、不写', added === null && sets === 0, sets);
    const items = await vm.runInContext('galleryLoad()', box);
    t('读恢复后拿回的是真画板', items.length === 1 && items[0].id === 'g1', items.map(i => i.id));

    vm.runInContext('_galleryItems = null', box);
    idb.delete('kuro_gallery');
    await vm.runInContext('galleryLoad()', box);
    t('对照：真没存过（null）才挂种子并落盘', sets === 1 && idb.has('kuro_gallery'), sets);
  }

  console.log('\n【⑧】气泡：IDB 读失败不许把主题从索引里摘掉');
  {
    let failRead = false, saves = 0;
    const idb = new Map();
    const styleEl = { id: '', textContent: '' };
    const cls = new Set();
    const toasts = [];
    const box = {
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Set, Map, RegExp, Error,
      state: { bubbleThemes: [{ id: 'bt1', name: '粉' }], bubbleTheme: 'bt1' },
      save() { saves++; }, showToast: m => toasts.push(String(m)), escHtml: s => String(s == null ? '' : s),
      idbGet: async k => { if (failRead) throw new Error('IDB 读抖了一下'); return idb.has(k) ? idb.get(k) : null; },
      idbSet: async (k, v) => { idb.set(k, v); }, idbDel: async k => { idb.delete(k); }, confirm: () => true,
      document: {
        getElementById: id => (id === 'bubbleThemeVars' ? (box._mounted ? styleEl : null) : null),
        createElement: () => styleEl, head: { appendChild: () => { box._mounted = true; } },
        body: { classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } }
      }
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(read('js/43-bubble.js'), box, { filename: '43-bubble.js' });
    failRead = true;
    await vm.runInContext("applyBubbleTheme('bt1')", box);
    t('★ 读失败：主题还在索引里', box.state.bubbleThemes.length === 1, box.state.bubbleThemes);
    t('★ 选中也没被清掉（下次还能读）', box.state.bubbleTheme === 'bt1', box.state.bubbleTheme);
    t('没有为此 save()', saves === 0, saves);
    t('告诉了用户这次没读出来', toasts.some(m => /没读出来/.test(m)), toasts);
    failRead = false;
    await vm.runInContext("applyBubbleTheme('bt1')", box);
    t('对照：真没有（not found）才摘掉', box.state.bubbleThemes.length === 0 && box.state.bubbleTheme === '', box.state.bubbleThemes);
  }

  console.log('\n' + (fail ? '✗ ' + fail + ' 条没过' : '✓ 全过') + '（共 ' + (pass + fail) + ' 条）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
