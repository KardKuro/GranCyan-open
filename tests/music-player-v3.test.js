/* 点歌面板 v3（用户的稿）——逻辑与素材接线
 *
 * 画面本身要真浏览器看（当时另写过截图脚本，没放进仓库），
 * 这里守的是「截图看不出来、坏了也不报错」的几件事：
 *   ① 手画图标：JS 里用到的每个 mz-i-xxx 都真的有 CSS 规则、指着的 png 真的在盘上
 *      （少一个 = 那个按钮是透明的，能点但看不见）
 *   ② 播放模式 / 上一首 / 列表循环 / 随机
 *   ③ 频谱：低音进低频段、高音进高频段（反了圈就是倒着跳的，肉眼只觉得「不太跟拍」）
 *   ④ 面板在有歌 / 没歌 / 各个抽屉页签下都画得出来
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const music = read('js/24-music.js');
const css = read('css/grancyan.css');
const html = read('index.html');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

function sandbox() {
  const store = {};
  const box = {
    state: {}, save() {}, showToast() {}, console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Promise,
    Float32Array, Int32Array, Uint8Array, Int8Array,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _panel: { innerHTML: '' },
    document: {
      getElementById: id => id === 'musicBody' ? box._panel : id === 'musicModal' ? { classList: { contains: () => false, toggle() {} }, style: { setProperty() {}, removeProperty() {} } } : null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout: fn => { fn(); return 0; }, setInterval() {}, addEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    Audio: function () { this.addEventListener = () => {}; }, Image: function () {}, navigator: { userAgent: 'node' },
    prompt: () => null, confirm: () => true,
    MUSIC_LYRIC_STYLES: ['scroll', 'tilt', 'cinema'], MUSIC_VIS_MODES: ['aurora', 'fluid', 'geo', 'off'],
    musicLyricStyleNorm: s => s || 'scroll',
    _store: store,
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(music, box);
  box._played = [];
  box.musicPlay = s => { box._played.push(s); vm.runInContext('_mNow = ' + JSON.stringify(Object.assign({}, s)), box); };
  return box;
}
const S = (id, name) => ({ id, name: name || '歌' + id, artist: 'x', cover: '' });

// ── ① 手画图标都接上了 ─────────────────────────────────────────────────
console.log('\n[1] 手画图标与素材');
{
  const used = new Set();
  for (const m of music.matchAll(/_mIc\((?:'([\w-]+)'|playing \? '([\w-]+)' : '([\w-]+)')/g)) [m[1], m[2], m[3]].filter(Boolean).forEach(x => used.add(x));
  for (const m of music.matchAll(/(?:list|one|shuffle): '(mode-[\w]+)'/g)) used.add(m[1]);
  used.delete('');
  t('JS 里认出了一整套图标（稿子里 14 个）', used.size >= 14, [...used]);
  const missing = [], noFile = [];
  for (const k of used) {
    const r = css.match(new RegExp('\\.mz-i-' + k + ' \\{ --ic:url\\(\\.\\./img/music/([\\w.-]+)\\)'));
    if (!r) { missing.push(k); continue; }
    if (!fs.existsSync(path.join(root, 'img/music', r[1]))) noFile.push(r[1]);
  }
  t('每个图标都有 CSS 规则', !missing.length, missing);
  t('每个规则指着的 png 都在 img/music/ 里', !noFile.length, noFile);
  // 角色、叉叉条也是同一套：url 写错了就是一块透明
  const urls = [...css.matchAll(/url\(\.\.\/img\/music\/([\w.-]+)\)/g)].map(m => m[1]);
  const gone = urls.filter(u => !fs.existsSync(path.join(root, 'img/music', u)));
  t('css 里所有 img/music/ 的引用都有文件', urls.length >= 20 && !gone.length, { n: urls.length, gone });
  t('默认封面（用户画的那张）在', /img\/music\/cover-default\.jpg/.test(music) && fs.existsSync(path.join(root, 'img/music/cover-default.jpg')));
  // 图标必须是用 mask 刷主题色，不能写死颜色——她说「这个蓝色要遵循主题色」
  const mzBlock = css.slice(css.indexOf('/* ═══ 点歌面板 v3'), css.indexOf('/* 「跟哪些模型一起」选择器')).replace(/\/\*[\s\S]*?\*\//g, '');
  t('面板样式里没有写死稿子的蓝 #0061C5', !/#0061c5/i.test(mzBlock));
  t('图标走 mask + currentColor', /\.mz-ic::before \{[^}]*background:currentColor;[^}]*mask:var\(--ic\)/.test(mzBlock));
  // 原生 prompt() 在 exe 和手机上静默返回 null：点歌里要她输字的地方只许走 _mAsk（→ appPrompt）
  const bare = music.split('\n').filter(l => /(^|[^\w.])prompt\(/.test(l) && !/^\s*\/\//.test(l) && !/function _mAsk|Promise\.resolve\(prompt\(/.test(l));
  t('点歌里没有直接调 prompt() 的地方', !bare.length, bare);
  for (const cls of ['mz-grid', 'mz-stars', 'mz-scope', 'mz-doodles', 'mz-mascot', 'mz-sparkle', 'mz-tape']) {
    t(`index.html 里写死了 .${cls}（不进 musicBody，重画不闪）`, new RegExp(`class="[^"]*\\b${cls}\\b`).test(html));
  }
  // 安卓 WebView：几个遮罩元素叠在同一个框上就画错（mascot 被压扁到三分之一宽、眨眼层挖透明方洞；
  // 09-30 真机抓到，桌面 Chrome 看不出）。所以 mascot 只有一个元素，身体和眼睛是它的两层遮罩
  const dd = (html.match(/<div class="mz-doodles"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  t('mascot 只有一个元素，小家伙那层里没有包装层', (dd.match(/\bmz-mascot\b/g) || []).length === 1 && !/<div/.test(dd), dd.slice(0, 200));
  // 排在第一个（后面压着一直在动的 codex）真机上被压扁到三分之一宽，挪到最后才正常
  const lastI = (dd.match(/<i class="([^"]+)"><\/i>\s*$/) || [])[1];
  t('mascot 是小家伙那层的最后一个（排前面真机上会被压扁）', lastI === 'mz-m mz-mascot', lastI);
  const mascotRule = (css.match(/\n\.mz-mascot \{[^}]*\}/) || [''])[0];
  t('mascot 的遮罩是「身体 + 睁眼」两层', /mask-image:url\(\.\.\/img\/music\/mascot\.png\),url\(\.\.\/img\/music\/mascot-eye-open\.png\);mask-image/.test(mascotRule), mascotRule);
  // .mz-mascot 没有 --ic，.mz-m 的 mask:var(--ic) 简写在它身上整条作废，尺寸/重复要自己写全，不然图按原尺寸平铺（桌面上放大成一截线）
  t('mascot 自己写全了遮罩尺寸和不平铺', /-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat/.test(mascotRule), mascotRule.slice(-200));
  const blink = (css.match(/@keyframes mzBlink \{[\s\S]*?\} \}/) || [''])[0];
  // 逐帧看：平时那帧两种写法都是睁眼，眨眼那帧两种写法都是眯眼（只换一半＝有一端不眨）
  const frame = sel => (blink.match(new RegExp(sel.replace(/[%,]/g, m => m) + ' \\{([^}]*)\\}')) || [])[1] || '';
  const both = (f, eye) => new RegExp(`-webkit-mask-image:url\\(\\.\\./img/music/mascot\\.png\\),url\\(\\.\\./img/music/${eye}\\.png\\);mask-image:url\\(\\.\\./img/music/mascot\\.png\\),url\\(\\.\\./img/music/${eye}\\.png\\)`).test(f);
  t('眨眼＝换眼睛那层遮罩：平时睁眼、眨的那一下眯眼（带不带前缀都换）',
    both(frame('0%,92%,100%'), 'mascot-eye-open') && both(frame('94%,97%'), 'mascot-eye-squint') && !/opacity|visibility/.test(blink), blink.slice(0, 160));
  t('放歌时 mascot 是眯眼', /#musicModal\.mz-playing \.mz-mascot \{[^}]*mascot-eye-squint/.test(css));
}

// ── ② 播放模式 / 上一首 / 下一首 ──────────────────────────────────────
console.log('\n[2] 播放模式');
{
  const b = sandbox();
  const seen = [];
  for (let i = 0; i < 3; i++) { b.musicCycleMode(); seen.push(vm.runInContext('_mMode', b)); }
  t('模式按 列表→单曲→随机→列表 轮', seen.join() === 'one,shuffle,list', seen);
  b.musicCycleMode();
  t('模式落进了 localStorage', b._store.kuro_musicMode === 'one');
  b.musicCycleRate();
  t('倍速切到 1.25 并落盘', vm.runInContext('_mRate', b) === 1.25 && b._store.kuro_musicRate === '1.25');
  t('倍速显示成 1.25x', b._mRateText() === '1.25x');
  vm.runInContext('_mRate = 1', b);
  t('1 倍显示成 1.0x（稿子里就是 1.0x）', b._mRateText() === '1.0x');
}
{
  // 列表循环：放整个歌单，队列放空之后从头再来，而且不重复刚放完的那首
  const b = sandbox();
  vm.runInContext(`_mMode = 'list'; _mCtx = [${JSON.stringify(S(1))}, ${JSON.stringify(S(2))}, ${JSON.stringify(S(3))}]; _mQueue = []; _mNow = ${JSON.stringify(S(3))};`, b);
  b.musicNext();
  t('列表循环：队列空了从单子开头重来', b._played.length === 1 && b._played[0].id === 1, b._played);
  t('重装的队列里没有刚放完的那首', vm.runInContext('_mQueue.map(s => s.id).join()', b) === '2', vm.runInContext('_mQueue.map(s=>s.id)', b));
  // 没有单子（AI 点的一首歌）：放完就停，不能凭空循环
  const c = sandbox();
  vm.runInContext(`_mMode = 'list'; _mCtx = null; _mQueue = []; _mNow = ${JSON.stringify(S(9))};`, c);
  c.musicNext();
  t('没有单子时队列空了就不放了', c._played.length === 0);
  // 单曲循环下手动点「下一首」照样往下走
  const d = sandbox();
  vm.runInContext(`_mMode = 'one'; _mQueue = [${JSON.stringify(S(5))}]; _mNow = ${JSON.stringify(S(4))};`, d);
  d.musicNext();
  t('单曲循环时手动下一首不被锁死', d._played.length === 1 && d._played[0].id === 5);
  // 随机：从队列里抽，不是永远拿第一首
  const e = sandbox();
  e.Math = Object.create(Math); e.Math.random = () => 0.99;
  vm.runInContext(`_mMode = 'shuffle'; _mQueue = [${[1, 2, 3, 4].map(i => JSON.stringify(S(i))).join()}];`, e);
  e.musicNext();
  t('随机：抽到的是队尾那首（random=0.99）', e._played[0] && e._played[0].id === 4, e._played);
  t('抽走的那首从队列里拿掉了', vm.runInContext('_mQueue.map(s => s.id).join()', e) === '1,2,3');
}
{
  // 上一首：历史由 musicNoteRecent 记；放了几秒以上先回开头
  const b = sandbox();
  b.musicNoteRecent(S(1)); b.musicNoteRecent(S(2)); b.musicNoteRecent(S(3));
  t('历史记下了前两首（不含正在放的）', vm.runInContext('_mHist.map(s => s.id).join()', b) === '1,2');
  vm.runInContext(`_mNow = ${JSON.stringify(S(3))}; _mAudio = { currentTime: 30 }; _mTick = function(){};`, b);
  b.musicPrev();
  t('放到 30 秒时按上一首：先回到开头', vm.runInContext('_mAudio.currentTime', b) === 0 && b._played.length === 0);
  b.musicPrev();
  t('再按：真的退回上一首', b._played.length === 1 && b._played[0].id === 2, b._played);
  t('正在放的那首排回队列最前面', vm.runInContext('_mQueue[0] && _mQueue[0].id', b) === 3);
  b.musicNoteRecent(S(2));   // musicPlay 真放起来时会调它
  t('退回去的那次不往历史里再记一笔（不然两首来回打转）', vm.runInContext('_mHist.map(s => s.id).join()', b) === '1', vm.runInContext('_mHist.map(s=>s.id)', b));
  b.musicPrev(); b.musicNoteRecent(S(1));
  b.musicPrev();
  t('历史退到底：留在第一首，不报错', b._played.length === 2 && b._played[1].id === 1);
}
{
  // 单曲循环：自然放完回到开头，不走 musicNext
  const b = sandbox();
  const L = {};
  b.Audio = function () { this.addEventListener = (k, f) => { L[k] = f; }; this.play = () => ({ catch() {} }); this.currentTime = 99; };
  vm.runInContext(`_mAudio = null; _mMode = 'one'; _mNow = ${JSON.stringify(S(7))}; _mAudioEl();`, b);
  let nexted = 0; b.musicNext = () => { nexted++; };
  L.ended();
  t('单曲循环：放完回到 0 秒接着放', vm.runInContext('_mAudio.currentTime', b) === 0 && nexted === 0);
  vm.runInContext(`_mMode = 'list'`, b);
  L.ended();
  t('列表循环：放完交给 musicNext', nexted === 1);
}

// ── ③ 频谱 ───────────────────────────────────────────────────────────
console.log('\n[3] 频谱（离线算好的那张表）');
(async () => {
  const b = sandbox();
  const SR = 22050, n = SR * 4, d = new Float32Array(n);
  // 前 2 秒 80Hz 低音，后 2 秒 5kHz 高音
  for (let i = 0; i < n; i++) d[i] = i < n / 2 ? 0.6 * Math.sin(2 * Math.PI * 80 * i / SR) : 0.6 * Math.sin(2 * Math.PI * 5000 * i / SR);
  let ticks = 0;
  const sp = await b.musicSpectrum(d, SR, async () => { ticks++; });
  t('算出来了：帧率 ≈ 21.5、48 段', sp && Math.abs(sp.fps - 21.53) < 0.1 && sp.nb === 48, sp && { fps: sp.fps, nb: sp.nb, frames: sp.frames });
  const NB = sp.nb, fA = Math.floor(sp.frames * 0.25), fB = Math.floor(sp.frames * 0.75);
  // 取区间里最亮的一段：纯音只点亮一两段，取平均会被同区间的暗段稀释
  const band = (f, lo, hi) => { let m = 0; for (let j = lo; j < hi; j++) m = Math.max(m, sp.data[f * NB + j]); return m; };
  const lowA = band(fA, 0, 12), highA = band(fA, 36, 48), lowB = band(fB, 0, 12), highB = band(fB, 36, 48);
  t('低音那段：低频段亮、高频段暗', lowA > 120 && highA < 40, { lowA, highA });
  t('高音那段：反过来', highB > 120 && lowB < 40, { lowB, highB });
  // 峰落在哪一段。低端一段只分到一个频点（21.5Hz/格），80Hz ≈ 第 4 格 → 第 1~3 段；
  // 高端按对数刻度，5kHz 在 48·ln(125)/ln(275) ≈ 41 段
  const peakAt = f => { let p = 0; for (let j = 1; j < NB; j++) if (sp.data[f * NB + j] > sp.data[f * NB + p]) p = j; return p; };
  t('80Hz 的峰在最低那几段', peakAt(fA) >= 1 && peakAt(fA) <= 3, peakAt(fA));
  t('5kHz 的峰在第 40~42 段', peakAt(fB) >= 40 && peakAt(fB) <= 42, peakAt(fB));
  t('算的过程中让出过主线程', ticks >= 1, ticks);
  t('太短的样本不硬算', (await b.musicSpectrum(new Float32Array(2000), SR)) === null);
  // 缓存只留 4 首
  for (let i = 0; i < 6; i++) b._mSpecPut('s' + i, { i });
  t('频谱缓存只留最近 4 首', !b._mSpecGet('s0') && !b._mSpecGet('s1') && !!b._mSpecGet('s2') && !!b._mSpecGet('s5'));
  // 省流量开关
  b._store.kuro_musicSpec = '0';
  t('关掉频谱后 _mSpecOn 为 false', b._mSpecOn() === false);

  // ── ④ 面板画得出来 ────────────────────────────────────────────────
  console.log('\n[4] 面板渲染');
  const p = sandbox();
  let err = null;
  try { p.musicRefresh(true); } catch (e) { err = e; }
  t('没在放歌：画得出来', !err, err && String(err));
  t('没在放歌：显示稿子里那句「歌词会显示在这里」', p._panel.innerHTML.includes('歌词会显示在这里'));
  vm.runInContext(`_mNow = { id: 1, name: '歌名', artist: '作者名', cover: '' }; _mAudio = { paused: false, currentTime: 3, duration: 200 };
    _mQueue = [{ id: 2, name: '排着的歌', artist: 'y' }];`, p);
  err = null;
  try { p.musicRefresh(true); } catch (e) { err = e; }
  t('在放歌：画得出来', !err, err && String(err));
  const h = p._panel.innerHTML;
  for (const [k, name] of [['prev', '上一首'], ['pause', '暂停'], ['next', '下一首'], ['mode-list', '播放模式'], ['queue', '小幽灵（杀歌）'], ['add', '加歌单'], ['full', '全屏'], ['search', '搜索'], ['fav', '收藏'], ['list', '歌单'], ['close', '关闭']]) {
    t(`按钮在：${name}`, h.includes('mz-i-' + k));
  }
  t('倍速文字在', h.includes('>1.0x<'));
  t('进度条还是那只像素猫（沿用 music-bar / music-fill）', /class="music-bar mz-bar"[\s\S]*class="music-fill"/.test(h));
  t('接入对话的开关还是 #musicToggle（openMusic/toggleMusic 认这个 id）', /id="musicToggle"[^>]*onchange="toggleMusic\(this\.checked\)"/.test(h));
  t('歌名按长度分档', p._mTitleSize('歌名') === 'mz-t-xl' && p._mTitleSize('Never Gonna Give You Up') === 'mz-t-s');
  p.musicSetTab('queue');
  t('队列页：列出排着的歌', p._panel.innerHTML.includes('排着的歌'));
  t('队列页：有「杀歌」', p._panel.innerHTML.includes('杀歌'));
  t('切页签会把抽屉打开（聊天里的歌单卡片走这条）', vm.runInContext('_mDrawerOpen', p) === true && p._panel.innerHTML.includes('mz-drawer open'));
  p.musicQueueRemove(0);
  t('从队列里拿掉', vm.runInContext('_mQueue.length', p) === 0);

  // ── ⑤ 用户第二轮 ─────────────────────────────────────────────
  console.log('\n[5] 第二、三轮：小幽灵杀歌 / 实心星星点一下收藏 / 单击全屏 / 拨唱片 / 猫压端点 / 电脑版小家伙靠右');
  // 小幽灵＝「杀歌及列表」：点开是队列页；队列里的「杀歌」＝这首掐掉、回到「还没在放」（不是跳下一首，后面有歌也不跳）
  const k = sandbox();
  vm.runInContext(`_mNow = { id: 7, name: '正在放', artist: 'z', cover: '' };
    _mAudio = { paused: false, currentTime: 30, duration: 200, pause(){ this.paused = true; }, removeAttribute(){}, load(){} };
    _mQueue = [{ id: 8, name: '后面那首', artist: 'z' }]; _mCtx = [{ id: 7 }, { id: 8 }];`, k);
  k.musicRefresh(true);
  const ghost = (k._panel.innerHTML.match(/class="mz-ic mz-i-queue[^"]*" onclick="([^"]+)"/) || [])[1];
  t('小幽灵按钮打开队列页', ghost === "musicNav('queue')", ghost);
  vm.runInContext(ghost || '0', k);
  t('点了小幽灵：抽屉开在队列页、列着后面那首', vm.runInContext("_mTab === 'queue' && _mDrawerOpen === true", k) && k._panel.innerHTML.includes('后面那首'));
  const kill = (k._panel.innerHTML.match(/class="music-row-q mz-kill" onclick="([^"]+)"/) || [])[1];
  t('队列页正在放那行有杀歌', kill === 'musicKill()', kill);
  vm.runInContext(kill || '0', k);
  t('杀歌：没有歌在放、后面有歌也没跳过去', vm.runInContext('_mNow === null && _mAudio.paused', k) && !k._played.length, k._played);
  t('杀歌：排着的歌还在（杀的是这首，不是整个队列）', vm.runInContext('_mQueue.length', k) === 1);
  k.musicRefresh(true);
  t('杀歌：面板回到「还没在放」', k._panel.innerHTML.includes('还没在放') && k._panel.innerHTML.includes('歌词会显示在这里'));
  // 实心星星：这首在收藏里 → 顶上的星星换成填实的那张，歌手名后面也是实心星
  const f = sandbox();
  vm.runInContext(`_mNow = { id: 9, name: '收了的歌', artist: 'z', cover: '' }; _mAudio = { paused: true, currentTime: 0, duration: 100 };`, f);
  f.musicRefresh(true);
  t('没收藏：顶上星星是空心的', !/mz-i-fav[^"]*faved/.test(f._panel.innerHTML) && !f._panel.innerHTML.includes('mz-faved'));
  vm.runInContext(`musicToggleFav(_mNow)`, f);
  f.musicRefresh(true);
  t('收藏了：顶上星星带 faved', /class="mz-ic mz-i-fav[^"]*\bfaved\b/.test(f._panel.innerHTML), f._panel.innerHTML.match(/mz-i-fav[^"]*/));
  t('收藏了：歌手名后面有实心星', f._panel.innerHTML.includes('class="mz-faved"'));
  t('faved 的星星指向 ic-fav-on.png', /\.mz-i-fav\.faved \{ --ic:url\(\.\.\/img\/music\/ic-fav-on\.png\)/.test(css) && fs.existsSync(path.join(root, 'img/music/ic-fav-on.png')));
  // 带前缀和不带前缀两条都要换（WebView/Electron 各认一条，只换一条就有一端还是空心）
  t('列表里收藏了的那行也是实心星', /\.music-row-q\.music-fav\.on::before \{ -webkit-mask-image:url\(\.\.\/img\/music\/ic-fav-on\.png\);mask-image:url\(\.\.\/img\/music\/ic-fav-on\.png\)/.test(css));
  // 灌水失败时 export.py 会原样存一张空心的——两张一样＝实心星没做出来
  t('ic-fav-on 和 ic-fav 不是同一张图', !fs.readFileSync(path.join(root, 'img/music/ic-fav-on.png')).equals(fs.readFileSync(path.join(root, 'img/music/ic-fav.png'))));
  // 主界面那颗星（第三轮）：有歌在放＝点一下收藏、再点一下取消；没在放＝打开收藏页
  const st = sandbox();
  vm.runInContext(`_mNow = { id: 11, name: '点星星', artist: 'z', cover: '' }; _mAudio = { paused: true, currentTime: 0, duration: 100 };`, st);
  st.musicRefresh(true);
  const star = (st._panel.innerHTML.match(/class="mz-ic mz-i-fav[^"]*" onclick="([^"]+)"/) || [])[1];
  t('主界面星星接的是 musicStarTap', star === 'musicStarTap()', star);
  vm.runInContext(star || '0', st);
  t('点一下：这首进了收藏、星星变实心', st.musicIsFav(11) && /class="mz-ic mz-i-fav[^"]*\bfaved\b/.test(st._panel.innerHTML));
  t('点一下不会把抽屉拉出来', vm.runInContext('!_mDrawerOpen', st));
  vm.runInContext(star || '0', st);
  t('再点一下：取消收藏、星星变回空心', !st.musicIsFav(11) && !/mz-i-fav[^"]*\bfaved\b/.test(st._panel.innerHTML));
  vm.runInContext('_mNow = null', st);
  st.musicStarTap();
  t('没在放歌时点星星：打开收藏页', vm.runInContext("_mDrawerOpen === true && _mTab === 'fav'", st));

  // 单击中间＝沉浸歌词（09-30 第三轮：双击改单击）。挪动/按太久/点按钮/去按停转着的唱片都不算
  const dt = sandbox();
  let clock = 1000, toggles = 0;
  dt.performance = { now: () => clock };
  dt.musicToggleLyricsFull = () => { toggles++; };
  const plain = { closest: () => null };
  const ev = (x, y, target) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, target: target || plain });
  const tap = (x, y, target, hold, x2, y2) => { dt._mMainDown(ev(x, y, target)); clock += hold || 80; dt._mMainTap(ev(x2 == null ? x : x2, y2 == null ? y : y2, target)); };
  t('中间那块按下/抬起都接上了', /class="mz-main" onpointerdown="_mMainDown\(event\)" onpointerup="_mMainTap\(event\)"/.test(p._panel.innerHTML));
  tap(100, 100);
  t('单击 → 切沉浸歌词', toggles === 1, toggles);
  tap(100, 100);
  t('再单击 → 切回来', toggles === 2, toggles);
  tap(100, 100, null, 80, 140, 100);
  t('按下去挪了 40px 不算点（拨唱片/划选歌词）', toggles === 2, toggles);
  tap(100, 100, null, 900);
  t('按了 900ms 才松不算点', toggles === 2, toggles);
  // 假按钮只认 button 这个选择器（像真 DOM 一样），选择器写错了它就不算按钮
  const btn = { closest: sel => sel.split(',').map(x => x.trim()).includes('button') ? btn : null };
  tap(100, 100, btn);
  t('点在按钮上不算', toggles === 2, toggles);
  dt._mMainTap(ev(100, 100));
  t('没有配对的按下（抬起单独来）不算', toggles === 2, toggles);

  // 拨唱片：绕圆心转多少度就转多少度，松手有惯性，按住放着的唱片＝按停
  const raf = [];
  dt.requestAnimationFrame = fn => { raf.push(fn); return raf.length; };
  dt.cancelAnimationFrame = () => {};
  const runRaf = (n, step) => { for (let i = 0; i < n && raf.length; i++) { clock += step; raf.shift()(clock); } };
  const img = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
  let natural = false;
  const platter = { getAnimations: () => natural ? [{}] : [] };
  dt.document.querySelector = sel => /mz-cover/.test(sel) ? img : /mz-platter/.test(sel) ? platter : null;
  const disc = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }), setPointerCapture() {} };
  const deg = () => vm.runInContext('_mSpinDeg', dt);
  t('唱片接了拨动的三个事件', /id="mzDisc" onpointerdown="_mSpinDown\(event,this\)" onpointermove="_mSpinMove\(event,this\)" onpointerup="_mSpinUp\(event\)"/.test(p._panel.innerHTML));
  dt._mSpinDown(ev(200, 100), disc); clock += 30;
  dt._mSpinMove(ev(100, 200), disc);          // 0° → 90°
  t('绕圆心拨 90°，唱片转 90°', Math.abs(deg() - 90) < 1e-6 && img.style.props['--mz-spin'] === '90.00deg', { deg: deg(), p: img.style.props });
  dt._mSpinMove(ev(100 - 98.48, 100 + 17.36), disc);   // 90° → 170°
  clock += 10;
  dt._mSpinMove(ev(100 - 98.48, 100 - 17.36), disc);   // 170° → -170°：实际是再往前 20°
  t('跨过 ±180° 那条线不倒转 340°', Math.abs(deg() - 190) < 0.1, deg());
  const before = deg();
  raf.length = 0;   // 按着时排的那帧「倒扣」松手后自己就退了，先清掉，下面跑的第一帧才是惯性
  dt._mSpinUp(ev(0, 0));
  t('快速拨完松手：甩出去了（惯性在转）', vm.runInContext('_mSpinRaf', dt) > 0 && vm.runInContext('_mSpinV', dt) > 0.02, vm.runInContext('_mSpinV', dt));
  t('甩出去的速度有封顶（1.5°/ms）', vm.runInContext('_mSpinV', dt) <= 1.5, vm.runInContext('_mSpinV', dt));
  runRaf(1, 16);
  const mid = deg();
  t('惯性让它接着往同方向转（一帧十几度）', (mid - before + 360) % 360 > 5 && (mid - before + 360) % 360 < 30, { before, mid });
  runRaf(2000, 16);
  t('摩擦把惯性收掉，最后停下', vm.runInContext('_mSpinRaf', dt) === 0, vm.runInContext('_mSpinV', dt));
  // 慢慢拨、停住再松手：不甩
  dt._mSpinDown(ev(200, 100), disc); clock += 30; dt._mSpinMove(ev(100, 200), disc); clock += 300;
  dt._mSpinUp(ev(0, 0));
  t('停住 300ms 再松手：不甩', vm.runInContext('_mSpinRaf', dt) === 0);
  // 放歌时唱盘自己在转：按住不动要每帧倒扣自转的角度，看起来是被按停了（12 秒一圈 → 1.2 秒倒扣 36°）
  natural = true; raf.length = 0;
  dt._mSpinDown(ev(200, 100), disc);
  const held0 = deg();
  runRaf(1, 0); runRaf(75, 16);
  t('按住 1.2 秒：倒扣 36°（抵消 12 秒一圈的自转）', Math.abs(((held0 - deg()) + 360) % 360 - 36) < 0.5, { held0, now: deg() });
  dt._mSpinUp(ev(0, 0));
  runRaf(3, 16);
  t('松手后不再倒扣', raf.length === 0, raf.length);
  // 按着的时候面板被重画：旧节点没了，pointerup 不会来，自己松开，不然一直倒扣
  natural = true;
  const gone = Object.assign({}, disc);
  dt._mSpinDown(ev(200, 100), gone);
  gone.isConnected = false;
  runRaf(3, 16);
  t('唱片节点被重画掉：自己松手', vm.runInContext('_mSpinDrag', dt) === null && raf.length === 0);
  natural = false;
  // 唱片还在惯性转的时候点一下＝接住它，这一下不切全屏
  dt._mSpinDown(ev(200, 100), disc); clock += 10; dt._mSpinMove(ev(100, 200), disc); dt._mSpinUp(ev(0, 0));
  t('（又甩出去一次）', vm.runInContext('_mSpinRaf', dt) > 0);
  const tg = toggles;
  dt._mSpinDown(ev(150, 150), disc); tap(150, 150);
  dt._mSpinUp(ev(0, 0));
  t('按停转着的唱片不切全屏', toggles === tg && vm.runInContext('_mSpinRaf', dt) === 0, toggles);
  dt._mSpinDown(ev(150, 150), disc); tap(150, 150); dt._mSpinUp(ev(0, 0));
  t('唱片停着时点它：照常切全屏', toggles === tg + 1, toggles);
  t('封面转角走 --mz-spin，唱片区不让浏览器抢手势', /\.mz-cover \{[^}]*transform:rotate\(var\(--mz-spin,0deg\)\)/.test(css) && /\.mz-disc \{ touch-action:none;/.test(css));
  t('重画时把拨过的角度写回封面', /class="mz-cover"[^>]*style="--mz-spin:/.test(p._panel.innerHTML));
  // 进度条：猫要压在两端的竖刻度上面（刻度是 .mz-bar::after，排在 fill 后面画）
  t('进度条的 fill（猫在它的 ::after 上）叠在端点刻度上面', /\.mz-bar \.music-fill \{ z-index:1;/.test(css));
  // 电脑版：小家伙们在右下角，抽屉拉出来就往左让
  const wide = css.slice(css.indexOf('@media (min-width:1000px)'));
  t('电脑版小家伙靠右', /\.mz-doodles \{ left:auto;right:/.test(wide));
  t('电脑版抽屉开着时小家伙往左让出抽屉宽度', /#musicModal:has\(\.mz-dr-open\) \.mz-doodles \{ right:calc\(var\(--mz-dw\)/.test(wide));
  // 390px 以下的手机：歌名那栏吃满 42% 后控制栏挤不下，「1.0x」被切半个（headless 量过：218px 刚好放下一排）
  const side = (css.match(/\n\.mz-side \{[^}]*\}/) || [''])[0];
  t('控制栏有最小宽度兜底（窄屏不切掉倍速）', /min-width:(2[01]\d)px/.test(side), side.trim());

  // 那三道波＝从频谱里拆出来的正弦分量（用户）：低/中/高三截各一道，频率跟这截里最响的频段走
  const wv = sandbox();
  const bands = (hot, bg) => { const v = new Float32Array(48).fill(bg == null ? 0.05 : bg); for (const [j, x] of hot) v[j] = x; return v; };
  const settle = (v, playing, n) => { let w; for (let i = 0; i < (n || 200); i++) w = wv._mWaveParts(v, 0.05, playing); return JSON.parse(JSON.stringify(w)); };
  vm.runInContext('_mWaveSt = null', wv);
  // 背景 0.3：真歌里别的频段不是零，重心要跟得住最响的那个，不能被一片中等的拖回中间
  const lowBass = settle(bands([[1, 0.9]], 0.3), true), lowUp = settle(bands([[14, 0.9]], 0.3), true);
  t('低音那道：最响的是很低的频段 → 波长长（周期少）；往上挪 → 周期变多', lowBass[0].k < 0.85 && lowUp[0].k > lowBass[0].k * 1.5, [lowBass[0].k, lowUp[0].k]);
  const flat = settle(bands([]), true);
  t('三道各管一截：低 < 中 < 高', flat[0].k < flat[1].k && flat[1].k < flat[2].k, flat.map(w => w.k));
  t('哪截响哪道起伏大', settle(bands([[20, 1], [21, 1], [22, 1], [23, 1], [24, 1], [25, 1]]), true)[1].a > flat[1].a * 1.8, flat[1].a);
  const quiet = settle(bands([[1, 1]]), false);
  t('停着：三道都收成小起伏', quiet.every(w => Math.abs(w.a - 0.3) < 0.01), quiet.map(w => w.a));
  vm.runInContext('_mWaveSt = null', wv);
  const p0 = settle(bands([]), true, 1), p1 = settle(bands([]), true, 21);
  const moved = [0, 1, 2].map(i => Math.abs(p1[i].ph - p0[i].ph));
  t('波在走，频率越高走得越快', moved[0] > 0.1 && moved[2] > moved[0] * 1.8, moved);
  vm.runInContext('_mWaveSt = null', wv);
  const jump = [settle(bands([[1, 0.9]]), true)[0].k];
  jump.push(wv._mWaveParts(bands([[14, 0.9]]), 0.05, true)[0].k);
  t('频率换了不是一帧跳过去（波长慢慢伸缩）', jump[1] - jump[0] < 0.1, jump);
  t('画的是纯正弦：一道波一个 sin，频率/相位用拆出来的', /amp \* Math\.sin\(k \* \(x - W \/ 2\) \+ w\.ph\)/.test(music) && /const waves = _mWaveParts\(v, dt, playing\)/.test(music));

  // ── 抽屉 v2（用户：能拉宽、顶上漏缝、分隔线要短线段、整体好看点）──
  console.log('\n[抽屉] 拉宽 / 顶缝 / 页签');
  {
    const b = sandbox();
    const on = {}, props = {}, cls = new Set();
    b.addEventListener = (ev, fn) => { (on[ev] = on[ev] || []).push(fn); };
    b.removeEventListener = (ev, fn) => { on[ev] = (on[ev] || []).filter(f => f !== fn); };
    const fire = (ev, e) => (on[ev] || []).slice().forEach(f => f(e));
    const modal = { style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } },
      classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), contains: c => cls.has(c), toggle() {} } };
    const drawer = { getBoundingClientRect: () => ({ width: 380 }), style: {}, classList: { toggle() {} } };
    b.document.getElementById = id => id === 'musicModal' ? modal : id === 'mzDrawer' ? drawer : id === 'musicBody' ? b._panel : null;
    b.innerWidth = 1440;
    t('宽度下限 300', b._mDrWClamp(100) === 300, b._mDrWClamp(100));
    t('宽度上限＝窗口六成（1440 → 864）', b._mDrWClamp(5000) === 864, b._mDrWClamp(5000));
    b.innerWidth = 1000;
    t('窄窗口时给唱片那栏留 420（1000 → 580）', b._mDrWClamp(5000) === 580, b._mDrWClamp(5000));
    b.innerWidth = 1440;
    b._mDrResizeDown({ button: 0, clientX: 1000, pointerId: 7, preventDefault() {} });
    t('按下把手：挂上拖动态（关掉舞台过渡）', cls.has('mz-dr-drag'));
    fire('pointermove', { pointerId: 7, clientX: 800 });
    t('往左拖 200 → 抽屉 580px', props['--mz-dw'] === '580px', props);
    fire('pointermove', { pointerId: 9, clientX: 100 });
    t('别的手指/指针的移动不算', props['--mz-dw'] === '580px', props);
    fire('pointermove', { pointerId: 7, clientX: 1300 });
    t('往右拖过头停在下限 300', props['--mz-dw'] === '300px', props);
    fire('pointermove', { pointerId: 7, clientX: 800 });
    fire('pointerup', { pointerId: 7, clientX: 800 });
    t('松手：拖动态撤掉、宽度记进 localStorage', !cls.has('mz-dr-drag') && b._store.kuro_musicDrawerW === '580', { cls: [...cls], st: b._store.kuro_musicDrawerW });
    t('松手后监听全摘掉', !(on.pointermove || []).length && !(on.pointerup || []).length && !(on.pointercancel || []).length);
    delete props['--mz-dw'];
    b.musicRefresh(true);
    t('重画面板时把记下的宽度挂回去', props['--mz-dw'] === '580px', props);
    t('抽屉里有拖宽把手', /class="mz-dr-resize" onpointerdown="_mDrResizeDown\(event\)" ondblclick="_mDrResizeReset\(\)"/.test(b._panel.innerHTML));
    // ── 往右划收起（用户）──
    modal.classList.toggle = (c, v) => { if (v) cls.add(c); else cls.delete(c); };
    vm.runInContext('_mDrawerOpen = true', b);
    b._mDrResizeDown({ button: 0, clientX: 1000, pointerId: 7, preventDefault() {} });
    // mock 量出来的起手宽恒为 380：拖到 x 时宽＝380 + (1000 - x)
    fire('pointermove', { pointerId: 7, clientX: 1050 });   // → 330，还没到最窄
    t('没窄到底之前抽屉不滑', drawer.style.transform === '' && props['--mz-dw'] === '330px', { tf: drawer.style.transform, w: props['--mz-dw'] });
    fire('pointermove', { pointerId: 7, clientX: 1120 });   // → 260，比最窄 300 过头 40
    t('窄到底还往右拖：抽屉整个跟着手滑（过头多少滑多少）', drawer.style.transform === 'translateX(40px)' && props['--mz-dw'] === '300px', { tf: drawer.style.transform, w: props['--mz-dw'] });
    t('没过阈值不挂「松手就收」', !cls.has('mz-dr-will'));
    fire('pointerup', { pointerId: 7, clientX: 1120 });
    t('过头不够远松手：弹回去、抽屉还开着', drawer.style.transform === '' && b._mDrawerOpen === true && !cls.has('mz-dr-swipe'), { tf: drawer.style.transform, open: b._mDrawerOpen, cls: [...cls] });
    b._store.kuro_musicDrawerW = '580'; vm.runInContext('_mDrW = 580', b);
    b._mDrResizeDown({ button: 0, clientX: 1000, pointerId: 7, preventDefault() {} });
    fire('pointermove', { pointerId: 7, clientX: 1200 });   // → 180，过头 120
    t('拖过阈值：挂「松手就收」变淡提示', cls.has('mz-dr-will') && drawer.style.transform === 'translateX(120px)', { cls: [...cls], tf: drawer.style.transform });
    fire('pointerup', { pointerId: 7, clientX: 1200 });
    t('拖过头够远松手：抽屉收起、滑动态撤干净', b._mDrawerOpen === false && drawer.style.transform === '' && !cls.has('mz-dr-swipe') && !cls.has('mz-dr-will'), { open: b._mDrawerOpen, tf: drawer.style.transform, cls: [...cls] });
    t('收起的那次不把宽度记成最窄：下次打开还是原来的 580', b._store.kuro_musicDrawerW === '580' && props['--mz-dw'] === '580px', { st: b._store.kuro_musicDrawerW, w: props['--mz-dw'] });
    // 触控板两指往右划＝wheel 的 deltaX 为负
    let pend = null;
    b.setTimeout = fn => { pend = fn; return 1; }; b.clearTimeout = () => { pend = null; };
    b.matchMedia = () => ({ matches: true });
    b.getComputedStyle = el => ({ overflowX: el.ox || 'visible' });
    const dEl = {};
    const mkT = (extra) => Object.assign({ scrollWidth: 100, clientWidth: 100, parentElement: dEl, closest: s => s === '#mzDrawer' ? dEl : null }, extra);
    const wheel = (dx, dy, tg, more) => { const e = Object.assign({ deltaX: dx, deltaY: dy, deltaMode: 0, target: tg || mkT(), prevented: false, preventDefault() { this.prevented = true; } }, more); b._mDrWheelOn(e); return e; };
    const endGesture = () => { const f = pend; pend = null; if (f) f(); vm.runInContext('_mDrWheel = null', b); };
    vm.runInContext('_mDrawerOpen = true', b);
    let e1 = wheel(-30, 2); wheel(-40, 0); wheel(-30, 1);
    t('两指往右划：抽屉跟着滑 100px，拦掉浏览器的横划后退', drawer.style.transform === 'translateX(100px)' && e1.prevented, drawer.style.transform);
    endGesture();
    t('划够了停手：收起', b._mDrawerOpen === false && drawer.style.transform === '', { open: b._mDrawerOpen, tf: drawer.style.transform });
    vm.runInContext('_mDrawerOpen = true', b);
    wheel(-30, 0); wheel(20, 0);
    t('往右划一点又往回划：跟着回来（只剩 10px）', drawer.style.transform === 'translateX(10px)', drawer.style.transform);
    endGesture();
    t('划得不够：弹回去，抽屉还开着', b._mDrawerOpen === true && drawer.style.transform === '', { open: b._mDrawerOpen, tf: drawer.style.transform });
    let ev = wheel(-5, 40); wheel(-200, 0);
    t('竖着开头的一整段手势都让给列表滚动（中途横过来也不算）', !ev.prevented && drawer.style.transform === '' && b._mDrawerOpen === true, drawer.style.transform);
    endGesture();
    ev = wheel(-200, 0, null, { shiftKey: true });
    t('按着 Shift 的鼠标滚轮不算划', !ev.prevented && drawer.style.transform === '');
    endGesture();
    const row = mkT({ scrollWidth: 400, clientWidth: 100, ox: 'auto' });
    ev = wheel(-200, 0, mkT({ parentElement: row }));
    t('抽屉里本来能横着滚的东西让它自己滚', !ev.prevented && drawer.style.transform === '');
    endGesture();
    ev = wheel(-200, 0, { closest: () => null });
    t('抽屉外面划不算', !ev.prevented && drawer.style.transform === '');
    endGesture();
    b.matchMedia = () => ({ matches: false });
    ev = wheel(-200, 0);
    t('手机宽度（底部面板）不走这个', !ev.prevented && drawer.style.transform === '');
    endGesture();
    b._mDrResizeReset();
    t('双击恢复默认：变量撤掉', !('--mz-dw' in props), props);
    // 页签数字单独包起来
    vm.runInContext('_mTab = "fav"', b);
    const secs = b.musicSectionsHtml();
    t('页签数字包进 <small>，没数字的不带空壳', !/搜索 <small>/.test(secs) && /队列<\/button>/.test(secs), secs.slice(0, 400));
    vm.runInContext('state.musicFav = [{id:1,name:"a"},{id:2,name:"b"}]', b);
    t('收藏页签是「收藏 <small>2</small>」', /收藏 <small>2<\/small><\/button>/.test(b.musicSectionsHtml()), b.musicSectionsHtml().slice(0, 300));
  }
  {
    const desk = (css.match(/@media \(min-width:1000px\) \{[\s\S]*?\n\}/g) || []).join('\n');
    t('顶缝：宽屏滚动容器不再有 padding-top，留白在吸顶页签自己身上', /\.mz-dr-body \{ padding-top:0; \}/.test(desk) && /\.mz-drawer \.music-tabs \{ padding-top:18px; \}/.test(desk) && !/\.mz-dr-body \{ padding-top:18px/.test(css));
    t('分隔线是短线段（重复渐变），实线边框去掉了', /\.mz-dr-resize i \{[^}]*repeating-linear-gradient\(to bottom,var\(--accent\) 0 9px,transparent 9px 16px\)/.test(desk) && /\.mz-drawer \{ left:auto;[^}]*border-left:0;/.test(desk));
    t('把手只在宽屏出现', /\n\.mz-dr-resize \{ display:none; \}/.test(css) && /\.mz-dr-resize \{ display:block;[^}]*cursor:col-resize/.test(desk));
    t('拖动时关掉舞台/抽屉的过渡', /#musicModal\.mz-dr-drag \.mz-stage, #musicModal\.mz-dr-drag \.mz-doodles, #musicModal\.mz-dr-drag \.mz-drawer \{ transition:none; \}/.test(desk));
    t('列表行两行之间没有旧的 10px 行距（gap:0 2px）', /\.mz-drawer \.music-row \{[^}]*display:grid;[^}]*gap:0 2px;/.test(css));
    t('实心按钮上的字用深底色（原来白字压在荧光色上）', /\.mz-drawer \.music-btn-main \{[^}]*color:var\(--mz-bg\)/.test(css) && /\.mz-drawer \.music-search-go \{[^}]*color:var\(--mz-bg\)/.test(css));
  }

  // ── 背景星星（用户：多一些、位置随机一些）──
  console.log('\n[星星] 多、随机、不扎堆');
  {
    const b = sandbox();
    const box = { innerHTML: 'old' };
    b.document.querySelector = s => s === '#musicModal .mz-stars' ? box : null;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pts = b._mStarsScatter(rnd);
    const n = (box.innerHTML.match(/<i /g) || []).length;
    t('撒了一大把（比稿子里 13 颗多）', pts.length >= 30 && n === pts.length, { pts: pts.length, n });
    t('全在面板里（0~100%）', pts.every(p => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100));
    let dmin = 1e9;
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++) dmin = Math.min(dmin, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    t('不扎堆：任意两颗至少隔 8%', dmin >= 8, dmin.toFixed(2));
    const sizes = new Set(pts.map(p => p.s));
    t('有大有小，大颗是少数', sizes.size >= 3 && pts.filter(p => p.s === 6).length <= pts.length / 4, [...sizes]);
    const ts = pts.map(p => +p.t);
    t('闪的快慢各不相同（2.6~5s）', new Set(ts).size >= 10 && Math.min(...ts) >= 2.6 && Math.max(...ts) <= 5, ts.slice(0, 8));
    t('每颗都带上大小/快慢/起步', /^(<i style="left:[\d.]+%;top:[\d.]+%;--s:\d+px;--t:[\d.]+s;--d:[\d.]+s"><\/i>)+$/.test(box.innerHTML), box.innerHTML.slice(0, 200));
    b._mStarsScatter();
    const first = box.innerHTML;
    b._mStarsScatter();
    t('再开一次是另一片', box.innerHTML !== first);
    t('打开面板时撒（不是每次重画都撒，星星会跳）', /_mStarsScatter\(\);\n  musicRefresh\(true\);/.test(music) && (music.match(/_mStarsScatter\(\)/g) || []).length === 1);
    t('CSS 吃 --s / --t', /\.mz-stars i \{[^}]*width:var\(--s\);height:var\(--s\);[^}]*animation:mzTwinkle var\(--t,3\.4s\)/.test(css));
  }

  // ── 电脑窄窗口（用户两张截图）──
  {
    const i0 = css.indexOf('/* ── 电脑：唱片和歌词并排');
    const desk = i0 >= 0 ? css.slice(i0, css.indexOf('\n}\n', i0)) : '';
    t('抠到了电脑那段 media', desk.length > 500 && /@media \(min-width:1000px\)/.test(desk), desk.length);
    t('唱片那行是容器（cqi 量的是它）', /\.mz-main \{ container-type:inline-size; \}/.test(desk));
    // 唱片块宽 ≈ D × 1.72（左右各 .36D 给频谱），30cqi × 1.72 ≈ 52%：歌词至少留下将近一半
    const m = desk.match(/\.mz-disc-wrap \{ --mz-D:max\(120px,min\(34vh,25vw,(\d+)cqi\)\); \}/);
    t('唱片大小也看这一行多宽，最多吃掉一半多一点', m && +m[1] * 1.72 <= 55, m && m[1]);
    t('歌词栏是容器，字号跟着栏宽缩', /\.mz-ly-wrap \{ container-type:inline-size; \}/.test(desk)
      && /\.music-ly-line\.on \.ly-main \{ font-size:clamp\(\d+px,\d+cqi,30px\); \}/.test(desk)
      && /\.ly-main \{ font-size:clamp\(\d+px,\d+cqi,19px\); \}/.test(desk));
    t('歌单大封面不被 flex 拉成竖条', /\.music-pl-cover\.big \{[^}]*align-self:flex-start/.test(css));
    t('大封面仍是正方形（aspect-ratio 还在基础规则上）', /\.music-pl-cover \{[^}]*aspect-ratio:1/.test(css));
  }

  // ── 重画 / 改尺寸之后当前句拉回原位（用户「看不到歌词」）──
  {
    const b = sandbox();
    const scrolls = [];
    const cur = { offsetTop: 900, offsetHeight: 40 };
    const lyBox = { clientHeight: 400, scrollTo: o => scrolls.push(o) };
    b.document.getElementById = id => id === 'musicLyric' ? lyBox : id === 'mLy12' ? cur : null;
    b.getComputedStyle = () => ({ getPropertyValue: k => k === '--ly-anchor' ? '.42' : '' });
    b.state.musicLyricStyle = 'scroll';
    vm.runInContext(`_mLyric = { lines: [], wbw: false, idx: 12 }`, b);
    b._mLyReanchor();
    t('当前句按 --ly-anchor 拉回（900 − (400−40)×.42），而且是瞬移不是慢慢滚',
      scrolls.length === 1 && Math.abs(scrolls[0].top - (900 - 360 * 0.42)) < 1e-6 && scrolls[0].behavior === 'instant', scrolls);
    scrolls.length = 0;
    vm.runInContext(`_mLyric.idx = -1`, b); b._mLyReanchor();
    vm.runInContext(`_mLyric = null`, b); b._mLyReanchor();
    t('还没唱到第一句 / 没歌词：不动', scrolls.length === 0);
    vm.runInContext(`_mLyric = { lines: [], wbw: false, idx: 12 }`, b);
    b.state.musicLyricStyle = 'cinema';
    b._mLyReanchor();
    t('cinema 不滚（它自己居中，滚了就推出画面）', scrolls.length === 0);
    const paint = music.match(/function _mPaintLyric\(\) \{[\s\S]*?\n\}/);
    t('每次重画歌词最后都拉一次', paint && /_mLyReanchor\(\);\n\}$/.test(paint[0]));
    t('框的尺寸变了也拉（ResizeObserver 挂在 _mLyBind 里，只挂一次）',
      /function _mLyBind\(box\) \{\n  if \(box\._lyBound\) return;\n  box\._lyBound = 1;\n(?:  \/\/[^\n]*\n)+  if \(typeof ResizeObserver === 'function'\) new ResizeObserver\(\(\) => \{ _mLyReanchor\(\); _mCineRemeasure\(\); \}\)\.observe\(box\);/.test(music));
  }

  // ── 迷你播放条（用户：离开点歌台也有个控制条常驻）──
  {
    const b = sandbox();
    const mk = () => { const el = { innerHTML: '', _c: new Set(), children: [], addEventListener() {}, querySelector: () => null, style: {}, classList: {
      add: c => el._c.add(c), remove: c => el._c.delete(c), contains: c => el._c.has(c),
      toggle: (c, on) => { on = on === undefined ? !el._c.has(c) : !!on; on ? el._c.add(c) : el._c.delete(c); return on; } } }; return el; };
    const modal = mk(); modal.style = { setProperty() {}, removeProperty() {} };
    const main = mk(); main.appendChild = el => { main.children.push(el); b._dockEl = el; return el; };
    b.document.getElementById = id => id === 'musicBody' ? b._panel : id === 'musicModal' ? modal : id === 'mzDock' ? (b._dockEl || null) : null;
    b.document.querySelector = q => q === 'main' ? main : null;
    b.document.createElement = () => mk();
    const audio = { paused: false, currentTime: 30, duration: 120, addEventListener() {} };
    vm.runInContext('_mAudio = null', b);
    b._setAudio = audio; vm.runInContext('_mAudio = _setAudio', b);
    const dock = () => b._dockEl;
    const shown = () => !!(dock() && dock()._c.has('on'));

    modal._c.add('hidden');
    b._mDockSync();
    t('没歌：点歌台关着也不挂', !shown());
    vm.runInContext(`_mNow = { id: 7, name: 'Run <Rabbit>', artist: 'Mollie', cover: '' }`, b);
    modal._c.delete('hidden');
    b._mDockSync();
    t('有歌但点歌台开着：不挂（面板里已经有一套了）', !shown());
    modal._c.add('hidden');
    b._mDockSync();
    const h = dock() ? dock().innerHTML : '';
    t('有歌、点歌台关着：挂出来，而且挂在 <main> 里', shown() && main.children.length === 1 && dock().id === 'mzDock');
    t('歌名转义了、点歌名回点歌台', /Run &lt;Rabbit&gt;/.test(h) && /class="mz-dk-info" onclick="openMusic\(\)"/.test(h), h.slice(0, 200));
    t('上一首 / 暂停 / 下一首 / 停止都在', /mz-i-prev[^>]*onclick="musicPrev\(\)"/.test(h) && /mz-i-pause[^>]*onclick="musicToggle\(\)"/.test(h)
      && /mz-i-next[^>]*onclick="musicNext\(\)"/.test(h) && /mz-i-close mz-dk-x[^>]*onclick="musicStop\(\)"/.test(h), h);
    t('进度条用 .music-fill（_mTick 全局刷它），一挂出来就是当前进度', /<i class="music-fill" style="width:25\.00%"><\/i>/.test(h));
    t('没封面用用户画的那张', /img\/music\/cover-default\.jpg/.test(h));
    t('放着的时候带 playing（小唱片转）', dock()._c.has('playing'));
    dock().innerHTML = 'SENTINEL';
    b._mDockSync();
    t('状态没变不重写（musicRefresh 很勤，按钮按下去那一瞬不许被换掉）', dock().innerHTML === 'SENTINEL');
    audio.paused = true;
    b._mDockSync();
    t('暂停：换成播放键、唱片停转、条还在', /mz-i-play[^>]*onclick="musicToggle\(\)"/.test(dock().innerHTML) && !dock()._c.has('playing') && shown());
    b._panel = { innerHTML: '' };
    b.musicRefresh();
    t('musicRefresh 在点歌台关着时也会刷到它（早退之前）', /function musicRefresh\(force\) \{[\s\S]{0,200}_mDockSync\(\);[\s\S]{0,300}if \(m\.classList\.contains\('hidden'\) && !force\) return;/.test(music));
    t('关点歌台时刷一次', /function closeMusic\(\) \{[\s\S]*?_mDockSync\(\);\n\}/.test(music));
    vm.runInContext('_mNow = null', b);
    b._mDockSync();
    t('停了歌就收起来', !shown() && main.children.length === 1);
    // 样式：宽屏在顶栏里，窄了掉到顶栏下面；默认藏着，.on 才显示
    t('CSS：默认 display:none，.on 才出来', /\.mz-dock \{[^}]*display:none/.test(css) && /\.mz-dock\.on \{ display:flex/.test(css));
    t('CSS：窄屏落到顶栏下面（顶栏 54px）', /@media \(max-width:\d+px\) \{ \.mz-dock \{ top:(5[5-9]|6\d)px; \} \}/.test(css));
    t('CSS：小唱片放着才转', /\.mz-dk-disc img \{[^}]*animation-play-state:paused/.test(css) && /\.mz-dock\.playing \.mz-dk-disc img \{ animation-play-state:running/.test(css));
  }

  // ── 桌面歌词（独立浮层）/ 迷你条可拖动 / 单首放完不停（用户）──
  {
    const b = sandbox();
    const cl = () => { const s = new Set(); return { s, add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, on) => { on = on === undefined ? !s.has(c) : !!on; on ? s.add(c) : s.delete(c); return on; } }; };
    const lyb = { style: {}, classList: cl() };
    const dock = { classList: cl(), querySelector: q => q === '.mz-dk-lyb' ? lyb : null, style: {}, offsetParent: { clientWidth: 1000, clientHeight: 700 }, offsetWidth: 400, offsetHeight: 80 };
    dock.classList.add('on');
    let desk = null, rafs = 0, cancels = 0;
    const curEl = { style: { v: '', setProperty(k, v) { this.v = v; } } };
    const main = { appendChild: el => { desk = el; return el; } };
    b.document.getElementById = id => id === 'mzDock' ? dock : id === 'mzDeskLy' ? desk : null;
    b.document.querySelector = q => q === 'main' ? main : null;
    b.document.createElement = () => { const el = { innerHTML: '', _k: '', classList: cl(), style: {}, offsetParent: { clientWidth: 1000, clientHeight: 700 }, offsetWidth: 800, offsetHeight: 70,
      addEventListener(n, fn) { el['_on_' + n] = fn; }, querySelector: q => q === '.cur' ? curEl : null }; return el; };
    b.requestAnimationFrame = () => ++rafs;
    b.cancelAnimationFrame = () => { cancels++; };
    const DEF = [{t:0,end:2,txt:'一'},{t:2,end:4,txt:'二<b>'},{t:4,end:6,txt:'三'},{t:6,end:8,txt:'四'},{t:8,end:10,txt:'五'}];
    const set = (idx, wbw, lines) => { b._ls = lines || DEF; vm.runInContext(`_mLyric = { lines: _ls, wbw:${!!wbw}, idx:${idx} }`, b); };
    const aud0 = { paused: false, currentTime: 0, addEventListener() {} };
    b._setAudio = aud0; vm.runInContext('_mAudio = _setAudio', b);
    const H = () => desk ? desk.innerHTML : '';
    set(-1); b._mDockLyric();
    t('桌面歌词是挂在 <main> 里的独立层（不在迷你条里）', !!desk && desk.id === 'mzDeskLy' && desk.classList.contains('on') && !/mz-dk-ly"/.test(music.match(/function _mDockSync[\s\S]*?\n\}/)[0]), H());
    t('还没唱：显示头两句，都不亮', /一/.test(H()) && /二/.test(H()) && !/ cur/.test(H()), H());
    set(0); b._mDockLyric();
    t('唱第 0 句：上一句亮、下一句暗', /mz-dl-l cur"[^>]*><span>一/.test(H()) && /mz-dl-l" style="--p:0%"><span>二/.test(H()), H());
    set(1); b._mDockLyric();
    t('唱第 1 句：整页不翻，上句唱完（done、满色）、下面那句亮；歌词转义', /mz-dl-l done" style="--p:100%"><span>一/.test(H()) && /mz-dl-l cur"[^>]*><span>二&lt;b&gt;/.test(H()), H());
    set(2); b._mDockLyric();
    t('唱第 2 句：整页翻到 三/四', /cur"[^>]*><span>三/.test(H()) && /><span>四/.test(H()) && !/一/.test(H()), H());
    set(4); b._mDockLyric();
    t('最后一页只有一句：下行留空不崩', /cur"[^>]*><span>五/.test(H()) && /<span><\/span><\/div>$/.test(H()), H());
    // 扫色进度
    const prog = (k, time) => b._mDeskProg(k, time);
    set(1);
    t('行级：句子「二<b>」4 个字，按 4×.45=1.8s 扫满，1s 处 ≈ 55.6%', Math.abs(prog(1, 3) - 1 / 1.8) < 0.01 && prog(1, 2) === 0 && prog(1, 9) === 1, [prog(1, 3)]);
    t('已唱过的行是满、没唱的是 0', prog(0, 3) === 1 && prog(2, 3) === 0);
    set(0, false, [{t:0,end:30,txt:'短'},{t:30,end:31,txt:'x'}]);
    t('间奏很长的句子：不爬 30 秒，1.5s 内扫满', prog(0, 1.5) === 1 && prog(0, .75) === .5);
    set(0, true, [{t:0,end:4,txt:'ab',words:[{t:0,end:1,txt:'a'},{t:2,end:4,txt:'bcd'}]}]);
    t('逐字：按字数加权（共 4 字；a 唱完 → 25%；bcd 唱一半 → 25%+75%/2）', prog(0, 1.5) === .25 && Math.abs(prog(0, 3) - .625) < 1e-9, [prog(0, 1.5), prog(0, 3)]);
    // 每帧只写当前行的 --p
    set(1); aud0.currentTime = 3; curEl.style.v = ''; b._mDockLyric();
    t('每帧只更新当前行的 --p（百分比）', curEl.style.v === '55.6%', curEl.style.v);
    t('放着：挂了 rAF', rafs > 0);
    aud0.paused = true; b._mDockLyric();
    t('暂停：rAF 停掉，不后台空转', cancels > 0);
    aud0.paused = false;
    vm.runInContext('_mLyric = null', b); b._mDockLyric();
    t('没歌词：浮层收起、清空', !desk.classList.contains('on') && desk.innerHTML === '');
    set(0); vm.runInContext(`localStorage.setItem('kuro_dockLy','0')`, b);
    b._mDockLyric();
    t('「词」关掉后不显示', !desk.classList.contains('on'));
    vm.runInContext('_mDockPos = { x: 5000, y: -30 }', b); b._mDockPlace(dock);
    t('迷你条拖到界外会被夹回 <main> 里', dock.style.left === '600px' && dock.style.top === '0px' && dock.classList.contains('moved'), JSON.stringify(dock.style));
    vm.runInContext('_mDeskPos = { x: -9, y: 9999 }', b); b._mDeskPlace(desk);
    t('桌面歌词也夹，位置独立存（kuro_deskLyPos）', desk.style.left === '0px' && desk.style.top === '630px' && desk.classList.contains('moved') && /kuro_deskLyPos/.test(music), JSON.stringify(desk.style));
    t('拖动逻辑两处共用一份，真拖了才吞 click', /if \(!moved\) return;[\s\S]{0,400}capture: true, once: true/.test(music) && (music.match(/function _mDragStart/g) || []).length === 1);
    t('CSS：浮层容器不接鼠标、字才接；扫色走 background-clip:text 渐变', /\.mz-desk \{[^}]*pointer-events:none/.test(css) && /\.mz-dl-l \{[^}]*pointer-events:auto/.test(css)
      && /\.mz-dl-l > span \{[^}]*background-clip:text/.test(css) && /var\(--p,0%\)/.test(css));
    t('CSS：有辉光（主题色 drop-shadow）', /\.mz-dl-l \{[^}]*drop-shadow\(0 0 \d+px color-mix/.test(css));
    // 单首放完：没队列、没单子 → 重放，不停
    const aud = { paused: false, currentTime: 99, plays: 0, play() { this.plays++; return Promise.resolve(); }, addEventListener() {} };
    vm.runInContext('_mAudio = null', b); b._setAudio = aud; vm.runInContext('_mAudio = _setAudio; _mNow = { id: 9, name: "x" }; _mQueue = []; _mCtx = null; _mMode = "list"', b);
    b.musicNext(true);
    t('单首放完（无队列无单子）：回到开头重放', aud.currentTime === 0 && aud.plays === 1);
    aud.currentTime = 50; aud.plays = 0;
    b.musicNext();
    t('手动点下一首没得下一首：不重放（保持原行为）', aud.currentTime === 50 && aud.plays === 0);
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
