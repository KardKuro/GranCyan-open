'use strict';
// 整首听歌：Gemini 把一首歌整首听一遍写档案，聊过的话摘进档案（2026-10-03，server/music-profile.js + js/24-music.js）
//
// 分三块：
//   ① server 的纯函数 —— 时间轴规整（「4:04 写成 404 秒」那次真撞过）、模型链往下退、存储挡路径穿越
//   ② server 的路由 —— 同一首同时只听一遍、听过不再听、失败冷却、每日上限、她没说话不花摘回忆那一发
//   ③ 前端 —— 只在「一起听」时才叫 server 听；[[LISTEN]] 摊开时带档案和 ▶ 当前段；换歌把聊过的那段交出去
//
// 真的拿歌喂 Gemini 那一步这里测不了（要联网、要 key、结果要人看）——2026-10-03 手动探过两首，
// 脚本在 session scratchpad 的 probe.js，结论写在 music-profile.js 文件头。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); fail++; }
}

const axios = require(path.join(ROOT, 'node_modules', 'axios'));
const mp = require(path.join(ROOT, 'server', 'music-profile.js'));

(async () => {
  // ── ① 纯函数 ──
  console.log('① 纯函数');
  t('m:ss 解析', mp.parseMmss('1:05') === 65 && mp.parseMmss('01:05') === 65 && mp.parseMmss('1:02:03') === 3723 && mp.parseMmss(12) === 12 && mp.parseMmss('30') === 30);
  t('m:ss 认不出来的回 NaN（秒位 ≥60、乱写、负数）', [ '1:75', 'abc', '', null, -3, '1:2:3:4' ].every(v => Number.isNaN(mp.parseMmss(v))));

  // 2026-10-03 第一发的真实形状：歌长 263 秒，模型把 4:04 写成了 404
  const bad = mp.normalizeProfile({
    summary: 's', mood: 'm',
    sections: [
      { start: '0:59', end: '1:50', label: '副歌', note: 'c' },
      { start: '0:00', end: '0:12', label: '前奏', note: 'a' },
      { start: '0:12', end: '0:40', label: '主歌', note: 'b' },     // 和下一段重叠：end 对齐到 0:37
      { start: '0:37', label: '预副歌' },                            // 漏了 end
      { start: '404', end: '423', label: '尾奏' },                   // 落在歌外面
      { start: 'xx', label: '坏的' },
    ],
    peak: { t: '6:00', note: '超出歌长' },
  }, 263);
  t('段落按开始时间排好', bad.sections.map(s => s.label).join(',') === '前奏,主歌,预副歌,副歌', bad.sections);
  t('落在歌长外面的段落丢掉（4:04 写成 404 那种）', !bad.sections.some(s => s.start >= 263));
  t('end 对齐下一段 start（重叠/漏写都补上）', bad.sections[1].end === 37 && bad.sections[2].end === 59, bad.sections);
  t('最后一段的 end 夹在歌长以内', bad.sections[3].end === 110 && bad.sections.every(s => s.end <= 263));
  t('peak 超出歌长 → 不要', bad.peak === null);
  t('什么都没听出来 → null，不存空档案', mp.normalizeProfile({ summary: '', sections: [] }, 200) === null && mp.normalizeProfile(null, 1) === null);
  const long = mp.normalizeProfile({ summary: 'x'.repeat(500), instruments: Array(20).fill('吉他'), sections: [{ start: '0:00', label: '前奏', note: 'n'.repeat(300) }] }, 0);
  t('字段长度、乐器个数都封顶', long.summary.length <= 61 && long.instruments.length === 8 && long.sections[0].note.length <= 61);
  t('不知道歌长时最后一段 end 不乱填', long.sections[0].end === 0);

  t('JSON 外面包了 ```json 也解得出', mp.parseJsonLoose('```json\n{"a":1}\n```').a === 1 && mp.parseJsonLoose('好的：{"a":2} 完') .a === 2 && mp.parseJsonLoose('nope') === null);
  t('回忆最多两条、去空', mp.normalizeMemos({ memos: ['a', '', 'b', 'c'] }).join() === 'a,b' && mp.normalizeMemos(null).length === 0);
  const cl = mp.cleanLines([...Array(50)].map((_, i) => ({ who: i % 2 ? '她' : 'x', text: 'm' + i })).concat([{ who: '她', text: '' }, null, { text: 5 }]));
  t('聊天行消毒：只留最后 40 条、who 只有她/它、空的丢掉', cl.length === 40 && cl.every(l => l.who === '她' || l.who === '它') && cl[39].text === 'm49', cl.slice(-2));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mprof-'));
  const st = mp.createStore(tmp);
  st.put('123', { a: 1 });
  t('存储：存了读得回来', st.get('123').a === 1);
  t('存储：id 只认纯数字（挡路径穿越）', !st.okId('../x') && !st.okId('1/2') && !st.okId('') && st.get('..\\x') === null);
  // 名字带随机串、跑完清掉：故障注入把校验拆掉时这里真的会写出盘外去，
  // 固定名字的话那份文件留在 tmp 里，之后每一轮（连对照组）都会被它连带判红
  const evil = 'evil-' + process.pid + '-' + Date.now();
  const evilAbs = path.join(tmp, '..', evil + '.json');
  let threw = false; try { st.put('../' + evil, {}); } catch { threw = true; }
  const leaked = fs.existsSync(evilAbs);
  try { fs.unlinkSync(evilAbs); } catch {}
  t('存储：坏 id 写不进去', threw && !leaked);

  // 模型链：503 往下退，地区被拒不退（换模型没用）
  const agentFor = async () => ({ agent: null, viaLane: false });
  const ok = text => ({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'think', thought: true }, { text }] } }] } });
  let calls = [];
  let r = await mp.geminiOnce({ key: 'k', parts: [], agentFor, post: async (url) => { calls.push(url); return calls.length === 1 ? { status: 503, data: { error: { message: 'busy' } } } : ok('{"x":1}'); } });
  t('503 → 换下一个模型', calls.length === 2 && r.model === mp.MODELS[1] && r.text === '{"x":1}', { calls, r });
  t('思考段不混进正文', !r.text.includes('think'));
  calls = []; let err = '';
  try { await mp.geminiOnce({ key: 'k', parts: [], agentFor, post: async (url) => { calls.push(url); return { status: 400, data: { error: { message: 'User location is not supported for the API use.' } } }; } }); }
  catch (e) { err = e.message; }
  t('地区被拒：不换模型、报人话', calls.length === 1 && /出口 IP/.test(err), { calls: calls.length, err });
  // 2026-10-08：第一个 503、链尾的报「模型不开放」，以前报的是后者，真原因（高峰）被盖掉
  calls = []; err = '';
  try { await mp.geminiOnce({ key: 'k', parts: [], agentFor, post: async (url) => { calls.push(url); return calls.length === 1 ? { status: 503, data: { error: { message: 'FIRST-busy' } } } : { status: 404, data: { error: { message: 'LAST-model-gone' } } }; } }); }
  catch (e) { err = e.message; }
  t('全退光：报第一个模型的错，不报链尾的', calls.length === mp.MODELS.length && err.includes('FIRST-busy') && !err.includes('LAST-model-gone'), { calls: calls.length, err });
  t('链里没有已下线的 2.5-flash', !mp.MODELS.includes('gemini-2.5-flash'));

  // ── ② 路由 ──
  console.log('② 路由');
  process.env.GRANCYAN_MUSIC_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mprof-r-'));
  process.env.GEMINI_API_KEY = 'test-key';
  // server 每听一首打一行日志，上限那段要刷 40 首——静音掉，别把断言淹了
  const _log = console.log, _warn = console.warn;
  console.log = (...a) => { if (!String(a[0]).startsWith('[听歌')) _log(...a); };
  console.warn = (...a) => { if (!String(a[0]).startsWith('[听歌')) _warn(...a); };
  const routes = {};
  const app = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
  let songUrlCalls = 0, audioGets = 0, geminiPosts = 0, geminiReply = null, songUrlRet = 'https://m.music.126.net/a.mp3';
  const origGet = axios.get, origPost = axios.post;
  axios.get = async (url, opt) => {
    audioGets++;
    if (opt.proxy !== false) throw new Error('音频走了代理');
    return { data: Buffer.alloc(200 * 1024), headers: { 'content-type': 'audio/mpeg' } };
  };
  axios.post = async (url, body) => {
    geminiPosts++;
    await new Promise(res => setTimeout(res, 20));
    return geminiReply ? geminiReply(url, body) : ok(JSON.stringify({ summary: '温柔的吉他弹唱', mood: '由静到满', sections: [{ start: '0:00', label: '前奏' }, { start: '0:12', label: '主歌' }] }));
  };
  mp.mount(app, { ROOT: tmp, agent: {}, outboundAgent: async () => ({}), songUrl: async () => { songUrlCalls++; return songUrlRet; } });
  const call = (key, body, query) => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); } };
    routes[key]({ body: body || {}, query: query || {} }, res);
  });

  const [a1, a2] = await Promise.all([
    call('POST /api/music/profile', { id: '111', name: '小幸运', artist: 'x', dur: 263 }),
    call('POST /api/music/profile', { id: '111', name: '小幸运', artist: 'x', dur: 263 }),
  ]);
  t('同一首同时来两次：只听一遍', songUrlCalls === 1 && geminiPosts === 1 && a1.body.profile && a2.body.profile, { songUrlCalls, geminiPosts });
  t('档案规整过才回（时间是秒）', a1.body.profile.sections[1].start === 12 && a1.body.profile.sections[1].end === 263, a1.body.profile);
  const p2 = await call('POST /api/music/profile', { id: '111', name: '小幸运', artist: 'x', dur: 263 });
  t('听过的再叫：读盘，不再听', p2.body.profile && geminiPosts === 1 && audioGets === 1);
  const g1 = await call('GET /api/music/profile', null, { id: '111' });
  t('GET 只读盘', g1.body.profile && g1.body.profile.summary === '温柔的吉他弹唱' && geminiPosts === 1);
  const g0 = await call('GET /api/music/profile', null, { id: '222' });
  t('GET 没听过的：profile 为空、不触发听', g0.body.profile === null && geminiPosts === 1 && songUrlCalls === 1);
  t('坏 id 400', (await call('POST /api/music/profile', { id: '../../x' })).code === 400 && (await call('GET /api/music/profile', null, { id: 'a' })).code === 400);

  songUrlRet = '';
  const f1 = await call('POST /api/music/profile', { id: '333', name: '没版权', dur: 200 });
  t('没版权拿不到音频：报出来、不调 Gemini', /没有可播放/.test(f1.body.error || '') && geminiPosts === 1, f1.body);
  songUrlRet = 'https://m.music.126.net/b.mp3';
  const before = songUrlCalls;
  const f2 = await call('POST /api/music/profile', { id: '333', name: '没版权', dur: 200 });
  t('失败后冷却期内不重试（每轮聊天都会叫一次）', songUrlCalls === before && f2.body.error, { songUrlCalls, before });

  geminiReply = () => ok('not json at all');
  const f3 = await call('POST /api/music/profile', { id: '444', name: 'x', dur: 100 });
  t('Gemini 回的解不出来：当失败，不存空档案', f3.body.error && !f3.body.profile && !fs.existsSync(path.join(process.env.GRANCYAN_MUSIC_PROFILE_DIR, '444.json')));

  // 每日上限：用一批新 id 刷到顶
  geminiReply = null;
  let capped = null;
  for (let i = 0; i < mp.MAX_PER_DAY + 2 && !capped; i++) {
    const rr = await call('POST /api/music/profile', { id: String(9000 + i), name: 'n', dur: 60 });
    if (rr.body.error && /今天已经/.test(rr.body.error)) capped = i;
  }
  t(`每日上限：一天最多整首听 ${mp.MAX_PER_DAY} 首`, capped !== null && capped <= mp.MAX_PER_DAY, capped);

  // 摘回忆
  const gp0 = geminiPosts;
  const m0 = await call('POST /api/music/profile/memo', { id: '111', name: '小幸运', lines: [{ who: '它', text: '这首好听吗' }] });
  t('她一句都没说：不花摘回忆那一发', geminiPosts === gp0 && m0.body.added === 0);
  let memoBody = null;
  geminiReply = (url, body) => { memoBody = body; return ok('{"memos":["她说副歌让她想起毕业那年夏天","她说这首要单曲循环"]}'); };
  const m1 = await call('POST /api/music/profile/memo', { id: '111', name: '小幸运', lines: [{ who: '她', text: '副歌好像毕业那年夏天' }, { who: '它', text: '嗯' }] });
  t('摘到的回忆存进同一份档案', m1.body.added === 2 && mp.createStore(process.env.GRANCYAN_MUSIC_PROFILE_DIR).get('111').memos.length === 2 && mp.createStore(process.env.GRANCYAN_MUSIC_PROFILE_DIR).get('111').profile, m1.body);
  t('摘回忆的提示词里带上了用户说的话，且分得清谁说的', JSON.stringify(memoBody).includes('她：副歌好像毕业那年夏天') && JSON.stringify(memoBody).includes('对方：嗯'));
  const m2 = await call('POST /api/music/profile/memo', { id: '111', name: '小幸运', lines: [{ who: '她', text: '还是好听' }] });
  t('同一句不重复存', m2.body.added === 0 && m2.body.memos.length === 2);
  for (let i = 0; i < 6; i++) {
    geminiReply = () => ok(JSON.stringify({ memos: [`第${i}次a`, `第${i}次b`] }));
    await call('POST /api/music/profile/memo', { id: '111', name: '小幸运', lines: [{ who: '她', text: 'x' }] });
  }
  const fin = mp.createStore(process.env.GRANCYAN_MUSIC_PROFILE_DIR).get('111').memos;
  t(`回忆封顶 ${mp.MEMO_MAX} 条，新的挤掉旧的`, fin.length === mp.MEMO_MAX && fin[fin.length - 1].text === '第5次b' && !fin.some(m => m.text.includes('毕业那年')), fin.map(m => m.text));
  const m3 = await call('POST /api/music/profile/memo', { id: '555', name: '没听过的歌', lines: [{ who: '她', text: '好听' }] });
  t('没整首听过的歌也能先记回忆（profile 留空）', m3.body.added > 0 && mp.createStore(process.env.GRANCYAN_MUSIC_PROFILE_DIR).get('555').profile === null);
  axios.get = origGet; axios.post = origPost;
  console.log = _log; console.warn = _warn;

  // 装配：server.js 真把它挂上了，songUrl 用的是 music.js 那一份（直连、认 404）
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('server.js 挂上了 music-profile，songUrl 来自 music.js', /require\('\.\/server\/music-profile'\)\.mount\(app, \{[^}]*songUrl: _music\.neteaseSongUrl/.test(srv));

  // ── ③ 前端 ──
  console.log('③ 前端');
  const music = fs.readFileSync(path.join(ROOT, 'js/24-music.js'), 'utf8');
  const store = {};
  const fetched = [];
  let profReply = { profile: { summary: '温柔的吉他弹唱', mood: '由静到满', instruments: ['木吉他'], vocal: '女声', lyricGist: '感谢那个人', sections: [{ start: 0, end: 12, label: '前奏', note: '吉他' }, { start: 12, end: 59, label: '主歌', note: '轻轻唱' }, { start: 59, end: 110, label: '副歌', note: '推满了' }], peak: { t: 80, note: '高音' } }, memos: [] };
  const box = {
    state: { chats: [], activeChatId: 'c1' }, console, Date, JSON,
    SERVER_BASE: 'https://pc',
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    addEventListener() {}, setTimeout: (fn) => { fn(); return 0; }, AbortController,
    fetch: async (url, opt) => { fetched.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null }); return { ok: true, json: async () => (/memo/.test(url) ? { memos: [{ at: Date.UTC(2026, 9, 3), text: '她说副歌像毕业那年' }] } : profReply) }; },
    escHtml: s => String(s ?? ''), showToast() {}, save() {},
  };
  box.window = { addEventListener() {} };
  vm.createContext(box);
  vm.runInContext(music, box);
  vm.runInContext('_mPaint = function(){}', box);
  const flush = () => new Promise(res => setImmediate(res));
  const posts = () => fetched.filter(f => f.url === 'https://pc/api/music/profile' && f.body);

  vm.runInContext(`_mNow = { id: 111, name: '小幸运', artist: 'x', url: 'u' }; _mAudio = { paused: true, currentTime: 70, duration: 263 };`, box);
  vm.runInContext('musicPromptFor({ id: 1 })', box); await flush();
  t('歌暂停着、她在聊别的：不叫 server 听', posts().length === 0 && !store.kuro_musicTogether);
  vm.runInContext('_mAudio.paused = false; musicPromptFor({ id: 1 })', box); await flush();
  t('歌在放、她在聊：叫 server 整首听一遍（带歌名歌手歌长）', posts().length === 1 && posts()[0].body.id === '111' && posts()[0].body.dur === 263, posts());
  t('同时记下「一起听」的窗口', JSON.parse(store.kuro_musicTogether || 'null')?.id === '111');
  vm.runInContext('musicPromptFor({ id: 1 })', box); await flush();
  t('听过了：下一轮不再叫', posts().length === 1);

  const idle = vm.runInContext('musicPromptFor({ id: 1 })', box);
  t('平时（没写 [[LISTEN]]）：不摊开档案、不带歌名', !idle.volatile.includes('整首档案') && !idle.volatile.includes('小幸运'));
  const want = vm.runInContext(`state.musicListenWant = { '1': true }; musicPromptFor({ id: 1 })`, box);
  t('[[LISTEN]]：带上整首档案', want.volatile.includes('整首档案') && want.volatile.includes('温柔的吉他弹唱') && want.volatile.includes('情绪走向：由静到满'), want.volatile);
  t('[[LISTEN]]：▶ 标在当前那段（1:10 在副歌）', want.volatile.includes('▶0:59 副歌') && want.volatile.includes('现在在「副歌」（0:59–1:50）：推满了'), want.volatile);
  t('档案只进 volatile，stable 里没有', !want.stable.includes('温柔的吉他弹唱') && want.stable.includes('整首档案'));

  // 不是网易云的歌（Apple 试听之类）不送
  vm.runInContext(`_mNow = { id: 'am_9', name: 'Apple', artist: 'y', url: 'u' };`, box);
  vm.runInContext('musicPromptFor({ id: 1 })', box); await flush();
  t('非网易云 id 不送去听', posts().length === 1);

  // 关掉开关
  vm.runInContext(`_mNow = { id: 222, name: 'B', artist: 'y', url: 'u' }; localStorage.setItem('kuro_musicProfile', '0');`, box);
  vm.runInContext('musicPromptFor({ id: 1 })', box); await flush();
  t('⋮ 里关了：不送', posts().length === 1);
  store.kuro_musicProfile = '1';

  // 换歌：把上一首一起听那段的对话交出去
  const now = Date.now();
  box.state.chats = [{ id: 'c1', headId: 'm4', nodes: {
    m1: { id: 'm1', parentId: null, role: 'user', content: '很久以前的话', timestamp: now - 3600e3 },
    m2: { id: 'm2', parentId: 'm1', role: 'user', content: '这首副歌好像毕业那年夏天 <b>呀</b>', timestamp: now - 20e3 },
    m3: { id: 'm3', parentId: 'm2', role: 'assistant', content: '[[LISTEN]] 嗯，那段吉他很亮', timestamp: now - 10e3 },
    m4: { id: 'm4', parentId: 'm3', role: 'user', content: '对', timestamp: now - 5e3 },
  } }];
  store.kuro_musicTogether = JSON.stringify({ id: '111', name: '小幸运', artist: 'x', chatId: 'c1', t0: now - 60e3, t1: now - 4e3 });
  vm.runInContext(`_mNow = { id: 333, name: 'C', artist: 'z', url: 'u' }; _mAudio.paused = false;`, box);
  vm.runInContext('musicPromptFor({ id: 1 })', box); await flush();
  const memo = fetched.filter(f => /memo/.test(f.url)).pop();
  t('换了歌：上一首那段对话交给 server 摘回忆', memo && memo.body.id === '111' && memo.body.lines.length === 3, memo && memo.body);
  t('只收一起听那段（更早的话不带）、去掉标签和指令', memo && !JSON.stringify(memo.body).includes('很久以前') && memo.body.lines[0].text === '这首副歌好像毕业那年夏天 呀' && memo.body.lines[1].text === '嗯，那段吉他很亮');
  t('分得清谁说的', memo && memo.body.lines.map(l => l.who).join() === '她,它,她');
  t('新的一首开了新窗口', JSON.parse(store.kuro_musicTogether || 'null')?.id === '333');

  // 下次再放 111：回忆跟着档案出来
  vm.runInContext(`_mNow = { id: 111, name: '小幸运', artist: 'x', url: 'u' }; _mAudio.currentTime = 5;`, box);
  const back = vm.runInContext(`state.musicListenWant = { '1': true }; musicPromptFor({ id: 1 })`, box);
  t('再放同一首：[[LISTEN]] 带着上次她说过的话', back.volatile.includes('以前一起听这首时她说过：「她说副歌像毕业那年」（10-3）'), back.volatile);
  t('再放同一首：▶ 在前奏', back.volatile.includes('▶0:00 前奏'));
  const met = vm.runInContext('musicPromptFor({ id: 1 })', box);
  t('平时那行提一句「以前一起听过」，但不报歌名', met.volatile.includes('（这首你们以前一起听过）') && !met.volatile.includes('小幸运'));

  // 停歌：收走
  const nMemo = fetched.filter(f => /memo/.test(f.url)).length;
  store.kuro_musicTogether = JSON.stringify({ id: '111', name: '小幸运', artist: 'x', chatId: 'c1', t0: now - 60e3, t1: now - 4e3 });
  vm.runInContext('_mAudio.pause = _mAudio.load = _mAudio.removeAttribute = function(){}; _mRC = function(){ return false; }; _mFadeStop = function(){}; _mMediaSync = function(){}; _mFluidSet = function(){}; _mApplyTint = function(){}; _mSessSave = function(){}; musicStop()', box); await flush();
  t('停歌：一起听那段交出去、窗口清掉', fetched.filter(f => /memo/.test(f.url)).length === nMemo + 1 && !store.kuro_musicTogether);

  // 她一句话都没说（只有 AI 自己说）→ 不发
  box.state.chats[0].nodes.m2.role = 'assistant'; box.state.chats[0].nodes.m4.role = 'assistant';
  store.kuro_musicTogether = JSON.stringify({ id: '111', name: '小幸运', artist: 'x', chatId: 'c1', t0: now - 60e3, t1: now - 4e3 });
  vm.runInContext('musicHarvest()', box); await flush();
  t('那段里她一句都没说：不发', fetched.filter(f => /memo/.test(f.url)).length === nMemo + 1);

  // 放歌时先读盘（不分析）
  t('musicPlay 放起来后读一次盘', /musicProfileLoad\(song\.id\)/.test(music.slice(music.indexOf('async function musicPlay'), music.indexOf('function _mPlayFailed'))));
  t('⋮ 里有「整首听」开关', /label: '整首听'[^\n]*musicToggleProfile/.test(music));

  for (const d of [tmp, process.env.GRANCYAN_MUSIC_PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

  console.log(fail ? `\n❌ ${pass} passed, ${fail} failed` : `\n✅ ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
