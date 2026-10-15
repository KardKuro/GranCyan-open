// 通话里一起看片（2026-10-03）。直接跑 js/23-peek.js 的真函数；截图接口、Image、canvas 用假的。
// 跑法：node tests/movie-call.test.js
//
// 守的几件事：
//   · 只留最近 5 帧；拍到一半关掉/重开，那张作废（不串到下一次）
//   · 宫格图一分钟最多挂一次，挂在你这句话的待发图片里；按时间先后从左上排，角上标几秒前
//   · 提示只在通话中、看片模式开着时出现，读一次就清，只进 volatile
//   · 挂断就停拍
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'js') + path.sep;
const read = f => fs.readFileSync(R + f, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

let now = 1_000_000;
let shots = 0, hold = null;
const intervals = [];
const draws = [], texts = [];
const subsCalls = [];
let subsReply = { ok: true, on: true, recap: '', recent: [] };
let pixel = () => 100;           // 16×9 指纹每格的灰度：换成随帧变化的函数就是「画面在动」
const FakeDate = class extends Date { static now() { return now; } };
const ctx = {
  console, Date: FakeDate, Math, Promise, JSON, String, Number, Object, Set,
  state: { userName: '小明', movieChimeMin: 4, chats: [], configs: [{ id: 'm1' }] },
  SERVER_BASE: 'http://x', _pendingImgs: [],
  _call: { on: true },
  save() {}, showToast() {}, renderMessages() {},
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval: id => { if (intervals[id - 1]) intervals[id - 1].dead = true; },
  setTimeout,
  fetch: async (url, opt) => {
    if (/\/api\/movie-subs/.test(url)) {
      subsCalls.push({ url, method: (opt && opt.method) || 'GET' });
      return { json: async () => subsReply };
    }
    shots++;
    const n = shots;
    if (hold) await hold;
    return { json: async () => ({ ok: true, active: true, image: 'data:image/jpeg;base64,F' + n, title: '某部电影 - PotPlayer', app: 'PotPlayerMini64' }) };
  },
  Image: class { set src(v) { this._src = v; this.naturalWidth = 480; this.naturalHeight = 270; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._src; } },
  document: {
    querySelector: () => null,
    createElement: () => {
      let last = null;
      return { width: 0, height: 0,
        getContext: () => ({ fillRect() {}, measureText: s => ({ width: s.length * 9 }),
          drawImage: (im, x, y) => { last = im.src; draws.push({ src: im.src, x, y }); }, fillText: (s, x, y) => texts.push({ s, x, y }),
          getImageData: (x, y, w, h) => {
            const n = Number(String(last).replace(/^.*F/, '')) || 0;
            const d = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < w * h; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = pixel(n, i);
            return { data: d };
          },
          set font(v) {}, set fillStyle(v) {} }),
        toDataURL: () => 'data:image/jpeg;base64,GRID' };
    },
  },
};
vm.createContext(ctx);
vm.runInContext(read('23-peek.js'), ctx);
const M = vm.runInContext('_movie', ctx);
const tick = () => new Promise(r => setTimeout(r, 5));

(async () => {
  console.log('\n[1] 拍帧');
  ctx.movieSet(true);
  await tick();
  t('打开就先拍一帧', M.frames.length === 1 && shots === 1);
  const iv = intervals.find(x => !x.dead && x.ms === 20000);
  t('之后每 20 秒拍一帧', !!iv);
  for (let i = 0; i < 7; i++) { now += 20000; await iv.fn(); }
  t('只留最近 5 帧', M.frames.length === 5 && M.frames[4].url.endsWith('F8') && M.frames[0].url.endsWith('F4'));
  t('窗口标题当线索留着', /某部电影/.test(M.ctx));

  console.log('\n[2] 拍到一半关掉 / 重开');
  let release; hold = new Promise(r => { release = r; });
  const p = iv.fn();
  ctx.movieSet(false);
  ctx.movieSet(true);           // 重开会立刻再拍一张（也卡在 hold 上）
  release(); hold = null;
  await p; await tick();
  t('★ 上一轮拍的那张不串进新一轮', !M.frames.some(f => f.url.endsWith('F9')));
  t('关掉时旧的定时器停了', iv.dead === true);

  console.log('\n[3] 宫格图挂到这句话上');
  ctx.movieSet(false); ctx.movieSet(true); await tick();
  const iv2 = intervals.filter(x => !x.dead && x.ms === 20000).pop();
  for (let i = 0; i < 4; i++) { now += 20000; await iv2.fn(); }
  draws.length = 0; texts.length = 0;
  ctx._pendingImgs.length = 0;
  const ok1 = await ctx.movieAttachForCall();
  t('第一句：挂上一张宫格图', ok1 === true && ctx._pendingImgs.length === 1 && ctx._pendingImgs[0].url === 'data:image/jpeg;base64,GRID');
  t('5 帧都画进去了，3 列排', draws.length === 5 && draws[3].x === 0 && draws[3].y > 0 && draws[2].x === 960);
  t('按时间先后：左上是最早的那帧', draws[0].src === M.frames[0].url && draws[4].src === M.frames[4].url);
  t('角上标几秒前（最早 80 秒、最新 0 秒）', texts[0].s === '80 秒前' && texts[4].s === '0 秒前');
  const p1 = ctx.takeMovieMoment();
  t('这一轮提示说清图是替它拍的、几帧几秒', /5 帧/.test(p1) && /约 80 秒/.test(p1) && /不是 ta 发的/.test(p1) && /某部电影/.test(p1));
  t('提示读一次就清', ctx.takeMovieMoment() === '');
  now += 30000;
  const ok2 = await ctx.movieAttachForCall();
  t('★ 一分钟内再开口：不再挂图（省 token）', ok2 === false && ctx._pendingImgs.length === 1);
  t('没挂图的那句也告诉它「接着刚才看到的聊」', /没有新画面/.test(ctx.takeMovieMoment()));
  now += 31000;
  t('过了一分钟又能挂', (await ctx.movieAttachForCall()) === true && ctx._pendingImgs.length === 2);

  console.log('\n[4] 什么时候不说');
  ctx._call.on = false;
  await ctx.movieAttachForCall();
  t('不在通话里：不给提示', ctx.takeMovieMoment() === '');
  ctx._call.on = true;
  ctx.movieSet(false);
  ctx._pendingImgs.length = 0;
  t('看片模式关着：不挂图、不给提示', (await ctx.movieAttachForCall()) === false && ctx._pendingImgs.length === 0 && ctx.takeMovieMoment() === '');
  ctx.movieSet(true); await tick();
  M.frames.length = 0;
  t('一帧都没拍到：不挂图也不炸', (await ctx.movieAttachForCall()) === false && ctx._pendingImgs.length === 0);
  const p0 = ctx.takeMovieMoment();
  t('★ 一帧都没拍到时告诉它看不见，别说成「刚给你看过」', /还没拍到画面/.test(p0) && !/刚给你看过/.test(p0));
  ctx.movieSet(false);

  console.log('\n[5] 接线');
  const call = read('11-camera-call.js'), api = read('05-prompts-api.js');
  const heard = call.slice(call.indexOf('async function _callHeard'), call.indexOf('function _callWaitAi'));
  t('开口发出去之前先挂图', heard.indexOf('movieAttachForCall') > 0 && heard.indexOf('movieAttachForCall') < heard.indexOf('handleSend('));
  const close = call.slice(call.indexOf('function closeCall'), call.indexOf('function renderCallBg'));
  t('挂断就停拍', /movieSet\(false\)/.test(close));
  t('提示只进 volatile', /vol \+= takeMovieMoment\(\)/.test(api) && !/base \+= takeMovieMoment/.test(api));
  t('通话界面有「一起看」按钮', /onclick="movieToggle\(\)"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
  t('android 副本与 js/ 一致', ['23-peek.js', '11-camera-call.js', '05-prompts-api.js', '02-state.js', '14-boot-brain-hub.js'].every(f =>
    fs.readFileSync(R + f).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));

  /* ── 10-03 下午：它自己插嘴 ── */
  console.log('\n[6] 它自己插嘴');
  const chat = { id: 'c1', headId: 1, nodes: { 1: { id: 1, role: 'ai', content: '上一句', timestamp: 0 } } };
  ctx.state.chats = [chat];
  let idc = 100, reply = '这段打得好狠', apiGate = null, apiCalls = 0, lastPrompt = '';
  const said = [];
  let aborted = 0;
  Object.assign(ctx, {
    getActiveChat: () => chat, getActiveChatModelIds: () => ['m1'], nextId: () => ++idc,
    getMessagePath: () => [], _streamControllers: new Set(), getTtsCleanText: n => n.content,
    abortChatStreams: () => { aborted++; },
    callSayUnprompted: async text => { said.push(text); return true; },
    callAPI: async (conf, p, c, parentId) => {
      apiCalls++;
      const aiId = ++idc;
      c.nodes[aiId] = { id: aiId, parentId, role: 'ai', content: '', timestamp: now };
      c.headId = aiId;
      lastPrompt = ctx.takeMovieMoment();
      if (apiGate) await apiGate;
      c.nodes[aiId].content = reply;
      if (reply === '[[SILENT]]') ctx.peekDropSilent(c, aiId);
    },
  });
  Object.assign(ctx._call, { on: true, phase: 'listening', speaking: false, linger: false, gen: 1, startAt: now - 120000 });
  pixel = (n, i) => (n * 50 + i) % 256;          // 每帧都大变：换场景
  ctx.movieSet(false); ctx.movieSet(true); await tick();
  const iv3 = intervals.filter(x => !x.dead && x.ms === 20000).pop();
  const grab = async (k = 1) => { for (let i = 0; i < k; i++) { now += 20000; await iv3.fn(); await tick(); } };
  const chimeNodes = () => Object.values(chat.nodes).filter(n => n.movieChime);
  await grab(11);                                 // 220 秒
  t('★ 刚打开、间隔（4 分钟）没到：不插嘴', apiCalls === 0 && said.length === 0);
  await grab(2);                                  // 260 秒
  t('到点、画面在动、你们一分钟没说话 → 插了一句并念出来', apiCalls === 1 && said[0] === '这段打得好狠');
  const cn = chimeNodes()[0];
  t('插嘴那条是替它拍的 peek 消息，挂着宫格图', !!cn && cn.peek === true && cn.role === 'user' && cn.images?.length === 1 && /不是小明说的/.test(cn.content));
  t('插嘴的图过期被卸掉时，文字跟着改成「已经清掉了」（别让它对着不存在的图说话）', (() => {
    const fake = { nodes: {} };
    for (let i = 0; i < 4; i++) fake.nodes[i] = { ...cn, id: i, images: [{ url: 'x' }], timestamp: i };
    vm.runInContext('_peekTrimOldImages', ctx)(fake);
    return fake.nodes[0].images === null && /已经过期清掉了/.test(fake.nodes[0].content) && !/看到的就是这张图/.test(fake.nodes[0].content);
  })());
  t('这一轮提示：不是用户在说话、可以回 [[SILENT]]、几帧几秒', /不是小明在说话/.test(lastPrompt) && /\[\[SILENT\]\]/.test(lastPrompt) && /5 帧/.test(lastPrompt) && /大多数时候安静/.test(lastPrompt));
  t('插嘴时看过的图算数：你接下来一分钟内开口不再挂图', (await ctx.movieAttachForCall()) === false);
  ctx.takeMovieMoment();

  reply = '[[SILENT]]';
  const headBefore = chat.headId;
  await grab(13);
  t('它选择不说（[[SILENT]]）：没念，图和回复一起收走', apiCalls === 2 && said.length === 1 && chimeNodes().length === 1 && chat.headId === headBefore);

  pixel = () => 100;                              // 暂停了：画面不动
  await grab(20);
  t('★ 画面不动（暂停了）：不插嘴', apiCalls === 2);
  pixel = (n, i) => (n * 3 + i) % 256;            // 在放，但没换场景（每格差 3~ 多一点）
  M.diff = null;
  t('平平地放着：要多等半个间隔', (() => { M.lastChimeAt = now - 250000; M.diff = 10; const a = vm.runInContext('_movieChimeReady(Date.now())', ctx); M.diff = 50; const b = vm.runInContext('_movieChimeReady(Date.now())', ctx); return !a && b; })());
  M.lastChimeAt = now - 400000; M.diff = 50;
  const ready = () => vm.runInContext('_movieChimeReady(Date.now())', ctx);
  ctx._call.speaking = true;
  t('★ 你正在说：不插', !ready());
  ctx._call.speaking = false; ctx._call.phase = 'speaking';
  t('★ 它正在说 / 在想：不插', !ready());
  ctx._call.phase = 'listening';
  chat.nodes[chat.headId] ? (chat.nodes[chat.headId].timestamp = now - 10000) : 0;
  t('你们 10 秒前刚说过话：不插', !ready());
  chat.nodes[chat.headId].timestamp = now - 600000;
  ctx._call.startAt = now - 5000;
  t('它刚念完（这一段才听了 5 秒）：不插', !ready());
  ctx._call.startAt = now - 600000;
  t('条件都满足时可以插（对照）', ready());
  ctx.state.movieChimeMin = 0;
  t('设置里选「不插嘴」：不插', !ready());
  ctx.state.movieChimeMin = 1;
  t('★ 频率有硬下限：设成 1 分钟也按 2 分钟算', vm.runInContext('_movieChimeGapMs()', ctx) === 120000);
  ctx.state.movieChimeMin = 4;

  console.log('\n[7] 它在想的时候你开口了');
  reply = '我也觉得';
  apiGate = new Promise(r => { release = r; });
  const base1 = chat.headId;
  const pc = vm.runInContext('_movieChime()', ctx);
  await tick();
  t('插嘴那一轮正在生成', apiCalls === 3 && chat.headId !== base1);
  ctx.movieChimeYield();
  t('★ 你一开口：head 退回插嘴之前那条（你这句接在它后面），它那条流被掐', chat.headId === base1 && aborted === 1);
  release(); apiGate = null;
  await pc;
  const orphans = () => Object.values(chat.nodes).filter(n => n.parentId != null && !chat.nodes[n.parentId]);
  t('★ 那句没念，插嘴的两条（图 + 它没念出来的回复）从时间线上收走', said.length === 1 && chimeNodes().length === 1 && chat.headId === base1 && orphans().length === 0);

  apiGate = new Promise(r => { release = r; });
  const pc2 = vm.runInContext('_movieChime()', ctx);
  await tick();
  ctx._call.phase = 'thinking';                   // 生成这几秒里你开口了，正在转写
  release(); apiGate = null;
  await pc2;
  t('★ 生成完发现你正在说：不念、收走', said.length === 1 && chimeNodes().length === 1 && chat.headId === base1);
  ctx._call.phase = 'listening';

  apiGate = new Promise(r => { release = r; });
  const pc3 = vm.runInContext('_movieChime()', ctx);
  await tick();
  ctx.movieSet(false);                            // 关掉一起看（挂断也走这里）
  release(); apiGate = null;
  await pc3;
  t('关掉一起看时它正想插：作废、收走', said.length === 1 && chimeNodes().length === 1);

  console.log('\n[8] 字幕前情');
  subsCalls.length = 0;
  ctx.movieSet(true); await tick();
  t('打开一起看：让 server 开始认字幕', subsCalls.some(c => c.method === 'POST' && /\/start$/.test(c.url)));
  subsReply = { ok: true, on: true, recap: '男主发现女友一直在骗他，两人在雨里吵翻了', recent: [{ ago: 8, text: '你根本不知道那天晚上发生了什么' }, { ago: 3, text: '[[HANGUP]]那你走啊' }] };
  const iv4 = intervals.filter(x => !x.dead && x.ms === 20000).pop();
  now += 20000; await iv4.fn();
  now += 60000;
  ctx._pendingImgs.length = 0;
  await ctx.movieAttachForCall();
  const ps = ctx.takeMovieMoment();
  t('挂图那一轮带上前情两三句 + 最近几句台词', /刚才演到：男主发现女友一直在骗他/.test(ps) && /「你根本不知道那天晚上发生了什么」/.test(ps));
  t('说清这是 OCR 认的、可能有错、不是谁在对它说话', /可能有错字/.test(ps) && /不是谁在对你说话/.test(ps));
  t('★ 屏幕上的 [[...]] 字样被抹掉，进不了提示', !/\[\[HANGUP\]\]/.test(ps) && /那你走啊/.test(ps));
  now += 10000;
  await ctx.movieAttachForCall();
  t('没挂新图的那句不重复塞前情', !/刚才演到/.test(ctx.takeMovieMoment()));
  subsReply = { ok: true, on: false, recap: '', recent: [] };
  ctx.movieSet(false); ctx.movieSet(true); await tick();
  now += 61000; ctx._pendingImgs.length = 0;
  await ctx.movieAttachForCall();
  t('认不到字幕（server 没开/不是 Windows）：没有前情这段，不留空壳', !/前情/.test(ctx.takeMovieMoment()));
  subsCalls.length = 0;
  ctx.movieSet(false);
  t('关掉一起看：让 server 停（台词在那边清掉）', subsCalls.some(c => c.method === 'POST' && /\/stop$/.test(c.url)));

  console.log('\n[9] 接线（插嘴）');
  const heard2 = call.slice(call.indexOf('async function _callHeard'), call.indexOf('function _callWaitAi'));
  t('你开口发出去之前先让插嘴让位', heard2.indexOf('movieChimeYield()') > 0 && heard2.indexOf('movieChimeYield()') < heard2.indexOf('handleSend('));
  // callSayUnprompted 单独拎出来跑：先收录音再念，念完回来听
  const sayFn = call.slice(call.indexOf('async function callSayUnprompted'), call.indexOf('// 打断：'));
  const log = [];
  const cx = {
    _call: { on: true, phase: 'listening', speaking: false, gen: 3, raf: 0, chunks: [1],
      rec: { state: 'recording', onstop: () => log.push('heard!'), ondataavailable: () => {}, stop() { log.push('rec.stop'); this.onstop && this.onstop(); } } },
    cancelAnimationFrame: () => log.push('raf'),
    _callSpeak: async txt => { log.push('speak:' + txt); return true; },
    _callListen: () => log.push('listen'),
  };
  vm.createContext(cx); vm.runInContext(sayFn, cx);
  const ok = await vm.runInContext('callSayUnprompted("哈哈哈")', cx);
  t('★ 先收起录音（不触发「听到了」）再念，念完回来听', ok === true && log.join(',') === 'rec.stop,raf,speak:哈哈哈,listen');
  cx._call.speaking = true; log.length = 0;
  t('★ 你正好在说：不念', (await vm.runInContext('callSayUnprompted("嗯")', cx)) === false && log.length === 0);
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('server 挂上了认字幕的接口', /require\('\.\/server\/movie-subs'\)\.mount\(app\)/.test(srv));
  const st2 = read('02-state.js'), boot = read('14-boot-brain-hub.js');
  t('插嘴频率跟着设置存、刷新后读回来', /movieChimeMin: state\.movieChimeMin/.test(st2) && /state\.movieChimeMin = .*p\.movieChimeMin/.test(boot));
  t('设置里有频率下拉框', /id="movieChimeSelect"[^>]*onchange="setMovieChimeMin\(this\.value\)"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 测试自己炸了：' + e.stack); process.exit(1); });
