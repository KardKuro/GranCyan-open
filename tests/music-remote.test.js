'use strict';
/* 点歌 · 设备遥控（手机 ↔ 电脑，Spotify Connect 那种）——用户要的
 *
 * 三层：
 *   [1] server 的设备表（server/music-remote.js createHub）：报到、转发状态、转发指令、断线宽限
 *   [2] 真起一个 express + mount，真用 HTTP/SSE 走一遍（挂载漏了是 404，只有这层逮得到）
 *   [3] 前端：两台「设备」各一个 vm 沙箱（24-music.js + 24-music-remote.js 整份加载），
 *       中间接的是 [1] 那个真 hub——遥控的那台按按钮，被遥控的那台真的执行，状态真的回流到镜像上。
 *       「断开后两边各放各的」「遥控时本机不出声」都在这层验。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const { createHub, mount } = require('../server/music-remote');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// 假 SSE 连接：记下写进来的事件
function fakeRes() {
  const r = { out: [], write(s) { r.out.push(s); } };
  r.events = () => r.out.filter(s => !s.startsWith(':')).map(s => {
    const ev = (s.match(/^event: (.+)$/m) || [])[1], data = (s.match(/^data: (.+)$/m) || [])[1];
    return { ev, data: data ? JSON.parse(data) : null };
  });
  r.last = ev => r.events().filter(e => e.ev === ev).pop();
  return r;
}

async function main() {
console.log('\n[1] server 设备表');
{
  const timers = [];
  const hub = createHub({ setTimer: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const pc = fakeRes(), ph = fakeRes();
  hub.join('pc1', '电脑', 'pc', pc);
  hub.join('ph1', '手机', 'phone', ph);
  t('报到后自己收到 hello，带着设备表', ph.last('hello') && ph.last('hello').data.you === 'ph1' && ph.last('hello').data.devices.length === 2);
  t('先来的电脑收到「设备表变了」', pc.last('devices') && pc.last('devices').data.some(d => d.id === 'ph1' && d.online));
  hub.setState('pc1', { song: { id: 1, name: '晴天', artist: '周' }, t: 30, paused: false });
  t('电脑报的状态转给了手机', ph.last('state') && ph.last('state').data.dev === 'pc1' && ph.last('state').data.st.song.name === '晴天');
  t('状态不回给自己', !pc.events().some(e => e.ev === 'state'));
  const r = hub.attach('ph1', 'pc1');
  t('手机挂上电脑：拿到电脑当前的状态', r.ok && r.st.song.name === '晴天');
  t('设备表里写着「手机在遥控电脑」', pc.last('devices').data.find(d => d.id === 'pc1').by.includes('ph1'));
  t('手机发的指令转给了电脑', hub.command('ph1', 'pc1', 'toggle', {}).ok && pc.last('cmd').data.cmd === 'toggle' && pc.last('cmd').data.fromName === '手机');
  t('不能遥控自己', !hub.command('pc1', 'pc1', 'toggle').ok && !hub.attach('pc1', 'pc1').ok);
  t('不在线的设备：指令不发，说清楚', !hub.command('ph1', 'nobody', 'next').ok);
  const ph2 = fakeRes();
  hub.join('ph9', '新手机', 'phone', ph2);
  t('后来的设备立刻看得到别人正在放什么', ph2.events().some(e => e.ev === 'state' && e.data.dev === 'pc1'));
  // 断线：不立刻除名（手机切后台闪断很常见）
  hub.leave('pc1', pc);
  t('电脑断线：先标成离线，不删', hub.summary().find(d => d.id === 'pc1') && !hub.summary().find(d => d.id === 'pc1').online);
  t('离线的设备不收指令', !hub.command('ph1', 'pc1', 'next').ok);
  const pcBack = fakeRes();
  hub.join('pc1', '电脑', 'pc', pcBack);
  timers.forEach(fn => fn());                          // 宽限期到点——但它已经回来了
  t('宽限期内回来了：还在，手机还挂着它', hub.summary().find(d => d.id === 'pc1').online && hub._devs.get('ph1').target === 'pc1');
  timers.length = 0;
  hub.leave('pc1', pcBack);
  timers.forEach(fn => fn());
  t('宽限期过了还没回来：删掉，并告诉遥控它的手机', !hub.summary().some(d => d.id === 'pc1') && ph.last('gone') && ph.last('gone').data.dev === 'pc1' && hub._devs.get('ph1').target === null);
  t('id 里的怪字符被洗掉', hub.join('a/b<c>', 'x', 'pc', fakeRes()).id === 'abc');
  // 存着的状态要带「多久以前报的」：挂上时拿到的是几秒前那份，进度得从那一刻往后推
  let clock = 1000;
  const h2 = createHub({ now: () => clock, setTimer: () => 0, clearTimer: () => {} });
  h2.join('p', '电脑', 'pc', fakeRes());
  h2.setState('p', { song: { id: 1, name: 'x' }, t: 10, paused: false });
  clock += 4200;
  const late = fakeRes(); h2.join('q', '手机', 'phone', late);
  t('后来的设备拿到的状态带着 age（4.2 秒前报的）', late.last('state').data.age === 4200, late.last('state').data);
  t('挂上时拿到的状态也带 age', h2.attach('q', 'p').age === 4200);

  // 一台设备要么在放、要么在遥控（用户：手机遥控电脑时电脑再去遥控手机，前面那条没断）
  const h3 = createHub({ setTimer: () => 0, clearTimer: () => {} });
  const A = fakeRes(), B = fakeRes(), C = fakeRes(), D = fakeRes();
  h3.join('A', '手机', 'phone', A); h3.join('B', '电脑', 'pc', B); h3.join('C', '平板', 'pc', C); h3.join('D', '旧手机', 'phone', D);
  const rel = r => r.events().filter(e => e.ev === 'released');
  h3.attach('A', 'B');
  h3.attach('B', 'A');
  t('两台互相挂：先挂的那条被摘掉', h3._devs.get('A').target === null && h3._devs.get('B').target === 'A');
  t('被摘的那台收到一次 released（两条规则落在同一台只发一次）', rel(A).length === 1 && rel(A)[0].data.by === 'B' && rel(A)[0].data.to === 'A' && rel(A)[0].data.was === 'B', rel(A).map(e => e.data));
  t('新挂的那台自己没被摘', rel(B).length === 0);
  const stale = h3.command('A', 'B', 'toggle', {});
  t('被摘掉后还发指令：不转发，叫它退回', !stale.ok && stale.detached === true && !B.events().some(e => e.ev === 'cmd'));
  t('设备表里 by 只剩手机被电脑遥控', h3.summary().find(d => d.id === 'A').by.join() === 'B' && h3.summary().find(d => d.id === 'B').by.length === 0);
  h3.attach('B', null); h3.attach('A', 'B'); h3.attach('B', 'C');
  t('我遥控的那台去遥控别人了：我被松开', h3._devs.get('A').target === null && rel(A).length === 2 && rel(A)[1].data.to === 'C');
  h3.attach('D', 'C');
  t('（旁观）另一台也遥控平板，不影响电脑→平板', h3._devs.get('B').target === 'C' && h3._devs.get('D').target === 'C');
  h3.attach('A', 'B');
  t('被挂上的那台原来在遥控别人：它松开，回来当播放器', h3._devs.get('B').target === null && rel(B).length === 1 && rel(B)[0].data.by === 'A' && rel(B)[0].data.to === 'B');
  t('不相干的那条（旧手机→平板）没被碰', h3._devs.get('D').target === 'C' && rel(D).length === 0 && rel(C).length === 0);
  t('重复挂同一台不误伤', (h3.attach('A', 'B'), h3._devs.get('A').target === 'B' && rel(A).length === 2));
}

console.log('\n[2] 真 HTTP：挂载 + SSE + 配对码头照常过');
{
  const express = require(path.join(root, 'node_modules', 'express'));
  const app = express(); app.use(express.json());
  mount(app);
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const got = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/api/music/remote/stream?dev=pcX&name=%E7%94%B5%E8%84%91&kind=pc' }, res => {
    got.ct = res.headers['content-type'];
    res.setEncoding('utf8'); res.on('data', d => got.push(d));
  });
  await tick(150);
  t('stream 是 text/event-stream、一连上就有 hello', /text\/event-stream/.test(got.ct || '') && got.join('').includes('event: hello'), got.ct);
  const post = (p, body) => new Promise(r => {
    const s = JSON.stringify(body);
    const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => r({ status: res.statusCode, body: JSON.parse(b || '{}') }));
    });
    q.end(s);
  });
  const a1 = await post('/api/music/remote/attach', { dev: 'nobody', to: 'pcX' });
  t('没连上的设备不能挂（409 不是 404）', a1.status === 409);
  const c1 = await post('/api/music/remote/cmd', { from: 'x', to: 'pcX', cmd: 'next', args: {} });
  await tick(80);
  t('POST 指令 → 电脑那条流里收到 cmd', c1.status === 200 && got.join('').includes('"cmd":"next"'));
  const dv = await new Promise(r => http.get({ host: '127.0.0.1', port, path: '/api/music/remote/devices' }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r(JSON.parse(b))); }));
  t('设备表接口', dv.devices.some(d => d.id === 'pcX' && d.name === '电脑'));
  req.destroy(); srv.close();
  const sj = read('server.js');
  t('server.js 挂上了 music-remote', /require\('\.\/server\/music-remote'\)\.mount\(app\)/.test(sj));
}

console.log('\n[3] 前端：手机遥控电脑，断开后各放各的');
{
  const hub = createHub({ setTimer: () => 0, clearTimer: () => {} });
  const music = read('js/24-music.js'), remote = read('js/24-music-remote.js');
  // 一台设备 = 一个沙箱。fetch 接到上面那个真 hub；audio 是假的但记录每个动作
  function device(name, isPhone) {
    const store = { kuro_musicDevId: 'dev_' + name };
    const toasts = [];
    const box = {
      state: {}, save() {}, showToast: (m) => toasts.push(m), console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set, Promise, Infinity, isFinite,
      Float32Array, Int32Array, Uint8Array, Int8Array, TextDecoder, AbortController,
      escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      _panel: { innerHTML: '' },
      document: {
        getElementById: id => id === 'musicBody' ? box._panel : id === 'musicModal' ? { classList: { contains: () => false, toggle() {} }, style: { setProperty() {}, removeProperty() {} } } : null,
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
      },
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout, setInterval: () => 0, clearInterval() {},
      addEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
      Image: function () {}, navigator: { userAgent: isPhone ? 'Mozilla/5.0 (Linux; Android 16) Mobile' : 'Mozilla/5.0 Electron/38' },
      prompt: () => null, confirm: () => true,
      MUSIC_LYRIC_STYLES: ['scroll', 'tilt', 'cinema'], MUSIC_VIS_MODES: ['aurora', 'fluid', 'geo', 'off'],
      musicLyricStyleNorm: s => s || 'scroll',
      SERVER_BASE: 'http://pc', __mrNoAuto: true, _toasts: toasts, _sse: fakeRes(), _played: [],
    };
    // 假 <audio>：play/pause/currentTime 都是真的状态，不出声
    box.Audio = function () {
      const a = this; a.paused = true; a.currentTime = 0; a.duration = 200; a.src = ''; a._ev = {};
      a.addEventListener = (e, fn) => (a._ev[e] = a._ev[e] || []).push(fn);
      a.play = () => { a.paused = false; box._played.push(a.src); (a._ev.play || []).forEach(f => f()); return Promise.resolve(); };
      a.pause = () => { a.paused = true; (a._ev.pause || []).forEach(f => f()); };
      a.removeAttribute = () => { a.src = ''; }; a.load = () => {};
    };
    // fetch → 真 hub。stream 那条不走这里（直接把 hub 的事件喂给 _mrHandle）
    box.fetch = async (url, init) => {
      const u = new URL(url), body = init && init.body ? JSON.parse(init.body) : {};
      const json = j => ({ ok: true, status: 200, json: async () => j });
      if (u.pathname === '/api/music/url') return json({ url: 'https://m7.music.126.net/' + u.searchParams.get('id') + '.mp3' });
      if (u.pathname === '/api/music/lyric') return json({ lyric: '[00:01.00]第一句\n[00:05.00]第二句' });
      if (u.pathname === '/api/music/remote/state') return json({ ok: hub.setState(body.dev, body.st) });
      if (u.pathname === '/api/music/remote/cmd') return json(hub.command(body.from, body.to, body.cmd, body.args));
      if (u.pathname === '/api/music/remote/attach') return json(hub.attach(body.dev, body.to));
      return { ok: false, status: 404, json: async () => ({}) };
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(music, box);
    vm.runInContext(remote, box);
    box._listen = box._mListen; box._mListen = () => {};   // 频谱那份下载在这里不测
    // 「连上了」：挂到 hub 上，hub 往这台写的每条事件都实时喂给前端的解析器
    const me = vm.runInContext('_mrSelf()', box);
    vm.runInContext('_mrConn = { live: true, ctl: null }', box);
    const res = { write: s => { if (!s.startsWith(':')) box._mrOnBlock(s.replace(/\n\n$/, '')); } };
    hub.join(me.id, me.name, me.kind, res);
    return box;
  }
  const pc = device('pc', false), ph = device('ph', true);
  const V = (box, expr) => vm.runInContext(expr, box);
  t('名字：电脑是「电脑」，手机浏览器是「手机网页」', V(pc, '_mrSelf().name') === '电脑' && V(ph, '_mrSelf().name') === '手机网页');
  t('两台互相看得见', V(ph, '_mrOthers().map(d => d.name).join()') === '电脑' && V(pc, '_mrOthers().map(d => d.name).join()') === '手机网页');

  // 电脑在放歌、手机也在放自己的
  await pc.musicPlay({ id: 101, name: '晴天', artist: '周杰伦', cover: '' });
  V(pc, "_mQueue = [{ id: 102, name: '七里香', artist: 'x', cover: '' }]"); pc.musicRefresh(); await tick(30);
  await ph.musicPlay({ id: 201, name: '手机的歌', artist: 'y', cover: '' });
  await tick(30);
  t('手机的设备菜单里看得到电脑在放《晴天》', V(ph, '_mrStates[_mrOthers()[0].id].st.song.name') === '晴天');

  // 手机挂上电脑
  const pcId = V(pc, '_mrSelf().id');
  const attachAt = Date.now();
  await ph.musicRemoteAttach(pcId);
  await tick(20);
  t('手机进入遥控：面板上是电脑那首', V(ph, '_mNow && _mNow.name') === '晴天' && V(ph, '!!_mRemote'));
  t('手机自己那首被暂停了（遥控时手机不出声）', V(ph, '_mrLocal.audio.paused') === true);
  t('队列是电脑的镜像', V(ph, '_mQueue.map(s => s.name).join()') === '七里香');
  // 镜像进度按 age 往后推：一份 5 秒前报的 t=20 在放 → 现在该是 25 秒左右
  V(ph, "_mrApply(Object.assign({}, _mRemote.proxy._st, { t: 20, paused: false, rate: 1 }), 5000)");
  t('拿到的是 5 秒前的状态：镜像进度从那一刻往后推（≈25 秒）', Math.abs(V(ph, '_mAudio.currentTime') - 25) < 0.3, V(ph, '_mAudio.currentTime'));
  V(ph, "_mrApply(Object.assign({}, _mRemote.proxy._st, { t: 20, paused: true }), 5000)");
  t('暂停着的状态不往后推', Math.abs(V(ph, '_mAudio.currentTime') - 20) < 0.01);
  // 电脑一看到有人挂上来，就当场报一份新鲜的（server 手里那份可能是好几秒前的）
  t('被挂上的那台当场重报了一次状态', hub._devs.get(V(pc, '_mrSelf().id')).stAt >= attachAt, [hub._devs.get(V(pc, '_mrSelf().id')).stAt, attachAt]);
  t('电脑那边提示「手机网页在遥控」', pc._toasts.some(m => /手机网页在遥控/.test(m)));
  t('面板按钮写着「遥控 · 电脑」', /mz-dev on[^>]*>遥控 · 电脑</.test(ph.musicRemoteBtn()));
  // 进遥控那一下会暂停本机 → pause 事件 → 排了一次「报状态」。等它到点时手机已经在遥控了，
  // 这时要是报出去，报的就是镜像（电脑那首），电脑的设备菜单会看到「手机在放晴天」
  await tick(40);
  const phSt = hub._devs.get(V(ph, '_mrSelf().id')).st;
  t('遥控器不把镜像当自己的状态报上去', phSt && phSt.song && phSt.song.name === '手机的歌' && phSt.paused === true, phSt && phSt.song);
  // 手机遥控着电脑时，电脑反过来发指令给手机：手机不接（否则会作用在镜像上、再转发回电脑）
  const pcPaused0 = V(pc, '_mAudio.paused');
  // （server 现在会拦掉没挂着的设备发的指令，这里直接喂给前端，验前端自己那道闸）
  ph._mrHandle('cmd', { from: V(pc, '_mrSelf().id'), cmd: 'toggle', args: {} }); await tick(30);
  t('遥控中不接别人发来的指令', V(pc, '_mAudio.paused') === pcPaused0 && V(ph, '_mrLocal.audio.paused') === true);

  // 按暂停
  ph.musicToggle(); await tick(30);
  t('手机按暂停 → 电脑真的暂停了', V(pc, '_mAudio.paused') === true);
  t('手机这边镜像也显示暂停', V(ph, '_mAudio.paused') === true);
  t('手机自己的真播放器没被动（还是暂停着）', V(ph, '_mrLocal.audio.paused') === true && V(ph, "_mrLocal.now.name") === '手机的歌');
  ph.musicToggle(); await tick(30);
  t('再按一下 → 电脑接着放', V(pc, '_mAudio.paused') === false);

  // 下一首：电脑按自己的队列走
  ph.musicNext(); await tick(40);
  t('手机按下一首 → 电脑放队列里的《七里香》', V(pc, '_mNow.name') === '七里香');
  t('状态回流：手机面板跟着换成《七里香》、队列空了', V(ph, '_mNow.name') === '七里香' && V(ph, '_mQueue.length') === 0);

  // 手机上从搜索结果点一首
  V(ph, "_mResults = [{ id: 333, name: '稻香', artist: 'z', cover: '' }]");
  ph.musicPlayFromList(0); await tick(40);
  t('手机点《稻香》→ 在电脑上放', V(pc, '_mNow.name') === '稻香' && V(pc, '_mAudio.paused') === false);
  t('手机本机没有去取播放地址、没出声', ph._played.length === 1, ph._played);

  // 拖进度
  V(ph, '_mAudio.currentTime = 88'); await tick(200);
  t('手机拖进度到 88 秒 → 电脑跳到 88 秒', Math.abs(V(pc, '_mAudio.currentTime') - 88) < 0.01, V(pc, '_mAudio.currentTime'));
  // 手机上改模式、加队列
  ph.musicCycleMode(); await tick(30);
  t('手机切播放模式 → 改的是电脑的', V(pc, '_mMode') === 'one' && V(ph, '_mMode') === 'one');
  t('手机自己的模式偏好没被写', V(ph, "localStorage.getItem('kuro_musicMode')") === null);
  V(ph, "_mResults = [{ id: 444, name: '夜曲', artist: 'z', cover: '' }]");
  ph.musicQueueFromList(0); await tick(30);
  t('手机加队列 → 进了电脑的队列', V(pc, '_mQueue.map(s => s.name).join()') === '夜曲');
  // 收藏走的是本机数据（本来就会同步）
  ph.musicStarTap();
  t('遥控时点星星：收藏的是电脑正在放的那首', V(ph, 'musicIsFav(333)') === true);

  // 转到这台放
  await ph.musicRemoteTakeOver(); await tick(40);
  t('「接到这台放」：电脑暂停了', V(pc, '_mAudio.paused') === true);
  t('手机从同一首、同一秒左右接着放', V(ph, '_mNow.name') === '稻香' && V(ph, '_mAudio.paused') === false && Math.abs(V(ph, '_mAudio.currentTime') - 88) < 2, [V(ph, '_mNow.name'), V(ph, '_mAudio.currentTime')]);
  t('手机退出了遥控', !V(ph, '!!_mRemote'));

  // 手机换一首自己的（和电脑那首不一样，才看得出断开后回到的是谁的），再挂上，然后断开：各放各的
  await ph.musicPlay({ id: 202, name: '手机第二首', artist: 'y', cover: '' }); await tick(20);
  await ph.musicRemoteAttach(pcId); await tick(20);
  ph.musicToggle(); await tick(30);                     // 让电脑放起来
  t('（重新挂上后电脑在放）', V(pc, '_mAudio.paused') === false);
  ph.musicRemoteDetach(); await tick(30);
  t('断开：手机回到自己那首、暂停着', !V(ph, '!!_mRemote') && V(ph, '_mNow.name') === '手机第二首' && V(ph, '_mAudio.paused') === true, V(ph, '_mNow && _mNow.name'));
  t('断开：电脑接着放它的，不受影响', V(pc, '_mAudio.paused') === false && V(pc, '_mNow.name') === '稻香');
  t('断开后手机的按钮只管自己', (ph.musicToggle(), V(ph, '_mAudio.paused') === false) && V(pc, '_mAudio.paused') === false);
  t('断开后 server 上手机不再遥控电脑', hub._devs.get(V(ph, '_mrSelf().id')).target === null);

  // 电脑反过来遥控手机
  const phId = V(ph, '_mrSelf().id');
  await pc.musicRemoteAttach(phId); await tick(20);
  t('电脑也能遥控手机：面板是手机那首', V(pc, '_mNow.name') === '手机第二首' && V(pc, '!!_mRemote'));
  pc.musicToggle(); await tick(30);
  t('电脑按暂停 → 手机暂停', V(ph, '_mAudio.paused') === true);
  // 电脑遥控着手机，手机反过来去遥控电脑：电脑那条要自己断（用户真机碰到的）
  await ph.musicRemoteAttach(pcId); await tick(30);
  t('手机反挂电脑 → 电脑自动退出遥控、回到自己那首', !V(pc, '!!_mRemote') && V(pc, '_mNow.name') === '稻香' && V(pc, '_mAudio.paused') === true, V(pc, '_mNow && _mNow.name'));
  t('电脑那边说了是谁接管的', pc._toasts.some(m => /手机网页反过来遥控这台了/.test(m)), pc._toasts.slice(-2));
  t('server 上只剩手机→电脑一条', hub._devs.get(pcId).target === null && hub._devs.get(phId).target === pcId);
  t('手机面板镜像的是电脑那首', V(ph, '!!_mRemote') && V(ph, '_mNow.name') === '稻香');
  ph.musicToggle(); await tick(30);
  t('手机的键现在管用：电脑放起来了', V(pc, '_mAudio.paused') === false && V(ph, '_mrLocal.audio.paused') === true);
  ph.musicToggle(); await tick(30);
  // 「把这首转到手机放」已经在遥控了就等于挂上；从本机转过去：
  pc.musicRemoteDetach(); await tick(20);
  await pc.musicPlay({ id: 555, name: '电脑新放的', artist: 'q', cover: '' }); await tick(20);
  V(pc, '_mAudio.currentTime = 42');
  await pc.musicRemoteHandOff(phId); await tick(50);
  t('「把这首转到手机放」：手机放这首、从 42 秒左右开始', V(ph, '_mNow.name') === '电脑新放的' && V(ph, '_mAudio.paused') === false && Math.abs(V(ph, '_mAudio.currentTime') - 42) < 2, [V(ph, '_mNow.name'), V(ph, '_mAudio.currentTime')]);
  t('电脑那边暂停、变成遥控器', V(pc, '_mrLocal.audio.paused') === true && V(pc, '!!_mRemote'));
  t('手机原来在遥控电脑：转过来时被松开了，不再是遥控器', !V(ph, '!!_mRemote') && hub._devs.get(phId).target === null);
  // 「released」丢了（比如那一下网断了）：电脑以为自己还在遥控，server 已经不认——按键时被告知，自己退回
  hub._devs.get(pcId).target = null;
  pc.musicNext(); await tick(30);
  t('server 不认这条遥控了 → 按键时自己退回本机', !V(pc, '!!_mRemote') && V(pc, '_mNow.name') === '电脑新放的' && pc._toasts.some(m => /已经不在遥控/.test(m)));
  t('那条过期的「下一首」没打到手机', V(ph, '_mNow.name') === '电脑新放的');
  await pc.musicRemoteAttach(phId); await tick(20);

  // 被遥控的那台下线：遥控器自己退回本机
  hub._devs.get(phId).streams.clear();
  const phDev = hub._devs.get(phId); hub._devs.delete(phId);
  for (const o of hub._devs.values()) if (o.target === phId) { o.target = null; }
  pc._mrHandle('gone', { dev: phId }); await tick(10);
  t('手机下线：电脑自动退出遥控、回到自己那首', !V(pc, '!!_mRemote') && V(pc, '_mNow.name') === '电脑新放的');
  t('并且说了一声', pc._toasts.some(m => /下线了/.test(m)));
  void phDev;
}

console.log('\n[4] 接线');
{
  const music = read('js/24-music.js'), html = read('index.html'), css = read('css/grancyan.css');
  const i1 = html.indexOf('js/24-music.js'), i2 = html.indexOf('js/24-music-remote.js');
  t('index.html 在 24-music.js 之后加载遥控模块', i1 > 0 && i2 > i1);
  for (const fn of ['musicToggle', 'musicNext', 'musicPrev', 'musicStop']) {
    t(`${fn} 开头问了一句「是不是在遥控」`, new RegExp(`function ${fn}\\([a-z]*\\) \\{\\n  if \\(_mRC\\(`).test(music));
  }
  t('musicPlay 遥控时把指令发走', /async function musicPlay\(song, url\) \{\n  if \(!song\) return;[\s\S]{0,400}if \(_mRemote\) \{/.test(music));
  for (const fn of ['musicQueueRemove', 'musicQueueTop', 'musicQueueClear', 'musicQueueFromList']) {
    t(`${fn} 改完队列同步给那台`, new RegExp(`function ${fn}\\([^)]*\\) \\{[^\\n]*(\\n[^\\n]*){0,3}_mRCQueue\\(\\)`).test(music));
  }
  t('面板上有「设备」按钮', /musicRemoteBtn\(\)/.test(music) && /\.mz-dev \{/.test(css));
  t('状态变化走 musicRefresh 报出去', /function musicRefresh\(force\) \{\n[^\n]*\n  if \(typeof musicRemoteNote === 'function'\) musicRemoteNote\(\);/.test(music));
  t('长连接用 fetch 读流（要带配对码头），不是 EventSource', /r\.body\.getReader\(\)/.test(read('js/24-music-remote.js')) && !/new EventSource/.test(read('js/24-music-remote.js')));
}
}
main().then(() => {
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
