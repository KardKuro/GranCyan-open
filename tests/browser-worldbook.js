/* 世界书的真·浏览器冒烟：面板能开、表单能存、刷新还在、命中真的进了发出去的那条、
 * 导入能用，外加拿真的 bge-small-zh 给语义门限做一次标定（打印分数表）。
 *
 * 为什么要在浏览器里跑：tests/worldbook.test.js 是 vm 抠源码跑，验的是逻辑；
 * 验不了「真 IndexedDB 刷新后还在」「表单 DOM 真的接得上」「真模型的分数长什么样」。
 *
 * 跑法：先 GRANCYAN_PORT=3760 GRANCYAN_PORT_TLS=3761 node server.js，再 node tests/browser-worldbook.js
 * 加 --calib 才跑语义标定（要拉模型，首次较慢；server 的 hf-cache/ 里有缓存就快）。
 * 截图落在 tests/out/。
 */
const PORT = process.env.GC_PORT || 3760;
const CDP = 9241;
const CALIB = process.argv.includes('--calib');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const OUT = path.join(__dirname, 'out');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

(async () => {
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode));
      r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });
  fs.mkdirSync(OUT, { recursive: true });
  const prof = path.join(os.tmpdir(), 'gc-worldbook-smoke');
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (_) {}

  const chrome = global.__chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + prof, '--window-size=1280,900',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
  if (!targets) { console.error('连不上 Chrome'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  const errors = [];
  ws.on('message', m => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 400));
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function shot(name, w, h) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(400);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride', {});
  }
  // 等到启动块真的把存储搬进 state 为止（固定睡几秒时快时慢，慢的那次就是假红）
  async function waitBoot(ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
      try { if (await ev(`typeof state === 'object' && !!state && typeof wbBook === 'function' && Array.isArray(state.configs)`)) { await sleep(800); return true; } } catch (_) {}
    }
    return false;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  if (!await waitBoot(30000)) { console.log('  ✗ 页面 30 秒都没起来'); console.log(errors.slice(0, 5).join('\n')); chrome.kill(); process.exit(1); }

  group('[1] 面板');
  ok(await ev(`typeof openWorldbook === 'function' && typeof worldbookPromptFor === 'function'`), '脚本加载了');
  ok(await ev(`!!(state.worldbook && Array.isArray(state.worldbook.entries))`), '启动后 state.worldbook 是规范结构');
  await ev(`openWorldbook()`);
  ok(await ev(`!document.getElementById('worldbookModal').classList.contains('hidden')`), '面板打开了');
  ok(await ev(`document.getElementById('worldbookBody').innerHTML.includes('还没有条目')`), '空的时候有占位文案');

  group('[2] 表单新建一条');
  await ev(`worldbookEdit('new')`);
  ok(await ev(`!!document.getElementById('wbF_title')`), '编辑卡出来了');
  await ev(`(() => {
    const s = (id, v) => { document.getElementById(id).value = v; };
    s('wbF_title', '下雨天的写法'); s('wbF_keys', '下雨, 雨伞, /带(上|着)伞/'); s('wbF_content', '先落在窗沿，等{{user}}自己推开窗。');
    s('wbF_pri', '120'); s('wbF_group', '写法指南');
    document.querySelector('.wb-edit .study-go').click();
  })()`);
  ok(await ev(`state.worldbook.entries.length === 1 && state.worldbook.entries[0].keys.length === 3`), '存进 state 了（三个触发词）');
  ok(await ev(`document.querySelectorAll('.wb-item').length === 1 && document.getElementById('worldbookBody').innerHTML.includes('写法指南')`), '列表里出现，带分组');
  await shot('worldbook-desktop.png', 1280, 860);

  group('[3] 命中真的进了发出去的那条，且只在 volatile');
  const r3 = await ev(`(async () => {
    const conf = state.configs[0] || { id: 'x', nickname: '克克' };
    const p = [{ role: 'user', content: '今天好累' }, { role: 'ai', content: '外面阴天了' }, { role: 'user', content: '好像要下雨了' }];
    // 先算没命中那轮、再算命中那轮：面板显示的是「最后一轮」，顺序反了它就该写「什么都没翻出来」
    const miss = {};
    buildSystemPrompt(conf, { id: 'c', nodes: {}, headId: null }, '', [{ role: 'user', content: '晚上吃什么' }], miss);
    const out = {};
    buildSystemPrompt(conf, { id: 'c', nodes: {}, headId: null }, '', p, out);
    return { inVol: out.volatile.includes('先落在窗沿'), inStable: out.stable.includes('先落在窗沿'),
             filled: out.volatile.includes('等' + (state.userName || '用户') + '自己推开窗'),
             missSame: miss.stable === out.stable, missClean: !miss.volatile.includes('世界书') };
  })()`);
  ok(r3.inVol && !r3.inStable, '命中 → volatile 有、stable 没有');
  ok(r3.filled, '{{user}} 换成了名字');
  ok(r3.missSame && r3.missClean, '没命中那轮：stable 跟命中那轮一样、volatile 里没有世界书');
  ok(await ev(`document.querySelector('.wb-item.wb-hit') !== null && document.getElementById('worldbookBody').innerHTML.includes('上一轮')`), '面板标出了「上一轮翻出来了」');
  // 走真的发送拼装（buildApiMessages：含语义预备、压缩、volatile 搬家），看最终发出去的消息
  const r3b = await ev(`(async () => {
    const conf = Object.assign({}, state.configs[0] || {}, { id: (state.configs[0] || {}).id || 'x', apiBase: 'https://api.anthropic.com/v1/messages', maxTokens: 200000, maxReplyTokens: 4096 });
    const p = [{ id: 1, role: 'user', content: '今天好累' }, { id: 2, role: 'ai', content: '外面阴天了' }, { id: 3, role: 'user', content: '好像要下雨了' }];
    const msgs = await buildApiMessages(p, conf, false, { id: 'c', nodes: {}, headId: null });
    const sys = msgs.filter(m => m.role === 'system').map(m => JSON.stringify(m.content)).join('');
    const last = JSON.stringify(msgs[msgs.length - 1].content);
    return { inSys: sys.includes('先落在窗沿'), inLast: last.includes('先落在窗沿'), lastRole: msgs[msgs.length - 1].role };
  })()`);
  ok(r3b.lastRole === 'user' && r3b.inLast && !r3b.inSys, '真发送拼装：世界书在最后一条用户消息里，不在 system 里');

  group('[4] 粘贴导入（酒馆格式）');
  await ev(`worldbookPaste(true)`);
  await ev(`(() => { document.getElementById('wbPasteText').value = JSON.stringify({ entries: { 0: { key: ['海'], comment: '海边', content: '海风是咸的', order: 50 }, 1: { key: [], comment: '世界观', content: '一座海边小城', constant: true } } }); worldbookImportPasted(); })()`);
  ok(await ev(`state.worldbook.entries.length === 3 && state.worldbook.entries.some(e => e.always)`), '导入了两条，常驻那条带着 always');

  group('[5] 刷新之后还在（真 IndexedDB）');
  // 直接 await 写盘：save() 是 800ms 防抖，中途别处再调一次 save() 就会往后推，
  // 固定睡 1.5 秒有时刚好落在窗口里（应用全局都没有「刷新前冲掉防抖」这一步，不是世界书独有的）
  await ev(`(async () => { clearTimeout(_saveTimer); await _doSave(); return true; })()`);
  await sleep(300);
  await send('Page.reload', {});
  await sleep(1000);
  await waitBoot(30000);
  { const n = await ev(`state.worldbook && state.worldbook.entries.length`); ok(n === 3, "刷新后三条都还在（实际 " + n + "）"); }
  ok(await ev(`state.worldbook.entries.find(e => e.title === '下雨天的写法').priority === 120`), '字段原样回来（优先级 120）');

  group('[6] 删除要点两次');
  await ev(`openWorldbook(); worldbookEdit(state.worldbook.entries.find(e => e.title === '海边').id)`);
  await ev(`document.querySelector('.wb-del').click()`);
  ok(await ev(`state.worldbook.entries.length === 3 && document.querySelector('.wb-del-armed') !== null`), '第一次只是「再点一次」');
  await shot('worldbook-editor.png', 1280, 860);
  await ev(`document.querySelector('.wb-del').click()`);
  ok(await ev(`state.worldbook.entries.length === 2 && Object.keys(state.worldbook.del).length === 1`), '第二次真删了、留了墓碑');
  await shot('worldbook-phone.png', 390, 844);

  ok(!errors.filter(e => /worldbook|wb[A-Z_]|_wb/.test(e)).length, '页面没有世界书相关的异常' + (errors.length ? '（其他异常 ' + errors.length + ' 条）' : ''));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));

  if (CALIB) {
    group('[7] 语义标定（真 bge-small-zh）');
    const loaded = await ev(`(async () => { try { const p = await Promise.race([_brainVecLoad(), new Promise(r => setTimeout(() => r(null), 180000))]); return !!p; } catch (e) { return 'ERR ' + e.message; } })()`);
    ok(loaded === true, '模型加载了');
    if (loaded === true) {
      const ENTRIES = {
        trip:  ['想去旅行', '假期出去玩', '订机票'],
        sleep: ['睡不着', '失眠了', '躺下也睡不着'],
        fight: ['我生气了', '你根本不在乎我', '不想理你了'],
      };
      const Q = {
        trip:  ['五一想去海边', '行李箱还没收拾', '高铁票抢到了'],
        sleep: ['今晚又要熬到天亮了', '凌晨三点了还是闭不上眼', '数羊数到一千了'],
        fight: ['你是不是嫌我烦了', '哼 走开', '算了 随便你'],
        none:  ['今天食堂的饭好难吃', '帮我看看这段代码', '明天要考高数', '嗯嗯', '这首歌好好听', '我去洗澡了', '天气预报说下雨', '你在干嘛', '哈哈哈笑死', '刚刚开完会'],
      };
      const rows = await ev(`(async () => {
        const ENTRIES = ${JSON.stringify(ENTRIES)}, Q = ${JSON.stringify(Q)};
        state.worldbook = wbNorm({ entries: Object.keys(ENTRIES).map(k => ({ id: k, title: k, keys: ['__不会命中__'], sem: true, semText: ENTRIES[k].join('\\n'), content: k })) });
        const conf = { id: 'calib' };
        const out = [];
        for (const want of Object.keys(Q)) for (const q of Q[want]) {
          _wbSem.q = null;
          await worldbookPrepare([{ role: 'user', content: q }], conf);
          if (!_wbSem.q) { out.push({ q, want, err: 'no result' }); continue; }
          const sc = _wbSem.q.scores;
          out.push({ q, want, base: _wbSem.q.base, s: Object.fromEntries(Object.keys(sc).map(k => [k, sc[k].s])), hit: Object.keys(sc).filter(k => sc[k].hit) });
        }
        return out;
      })()`);
      let tp = 0, fn = 0, fp = 0;
      for (const r of rows) {
        if (r.err) { console.log('   ', r.q, r.err); continue; }
        const d = Object.entries(r.s).map(([k, v]) => `${k}:${v.toFixed(3)}(${(v - r.base >= 0 ? '+' : '') + (v - r.base).toFixed(3)})`).join('  ');
        console.log(`    [${r.want}] ${r.q.padEnd(14, '　')} base ${r.base.toFixed(3)}  ${d}  → ${r.hit.join(',') || '-'}`);
        if (r.want === 'none') fp += r.hit.length;
        else { if (r.hit.includes(r.want)) tp++; else fn++; fp += r.hit.filter(h => h !== r.want).length; }
      }
      console.log(`    命中 ${tp} / 漏 ${fn} / 误触发 ${fp}`);
      ok(fp === 0, '闲聊句一条都没误触发语义条目');
    }
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { global.__chrome && global.__chrome.kill(); } catch (_) {} process.exit(1); });
