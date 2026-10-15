/* 逐字歌词（YRC）：解析、翻译配对、三道门、两个后端的字段对齐。
 *
 * 渲染那半边在 tests/browser-music-lyrics.js（要真浏览器才验得了 CSS 裁出来的亮层）。
 * 这里只管**算得对不对**，所以在 vm 沙箱里跑，不需要 DOM。
 *
 * fixture 是真实的网易云返回（Lemon / id=1466598056、晴天 / id=186016）截段，
 * 不是手编的——手编样本会不自觉避开真实数据里的怪东西（行尾空格、空壳翻译、
 * 逐字切分横跨假名），而那些正是会出问题的地方。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSingleSrc } = require('./_src-map');

const root = path.join(__dirname, '..');
const musicSrc = fs.readFileSync(path.join(root, 'js', '24-music.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'js', '01-core.js'), 'utf8');
const stateJs = fs.readFileSync(path.join(root, 'js', '02-state.js'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'js', '14-boot-brain-hub.js'), 'utf8');
// 点歌后端已搬进 server/music.js（docs/server-split-plan.md Phase 1 第一块），
// 经 readSrc('music') 取当前真实位置，逻辑名一条不改，映射表在 tests/_src-map.js 里改。
// music 目前只映射单个文件，不拼接（_src-map.js 明确禁止 join 多文件），直接取那一条。
const musicSrcPart = readSingleSrc('music');   // 单文件条目，多了会当场炸，不会静默取 [0]
const serverMusicSrc = musicSrcPart.text;
const androidJava = fs.readFileSync(
  path.join(root, 'android', 'src', 'com', 'grancyan', 'app', 'CoreadServer.java'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ── 把 24-music.js 真跑起来（纯函数部分不碰 DOM）──
const noop = () => {};
const sandbox = {
  state: {}, console,
  document: { addEventListener: noop, getElementById: () => null,
              querySelectorAll: () => [], createElement: () => ({ getContext: () => null }) },
  // addEventListener 得有：24-music 在顶层挂了 resize（cinema 的镜头重测），
  // 桩里缺这个的话整个文件在 runInContext 那一步就抛，一条测试都跑不起来。
  // 顺手记下挂了什么，下面那条断言要验 resize 真的被注册了。
  window: { _on: {}, addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); } },
  Image: function () {}, performance: { now: () => 0 },
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  fetch: () => Promise.reject(new Error('no net')),
  escHtml: s => String(s), jsAttr: () => '', showToast: noop, save: noop,
  prompt: () => null, SERVER_BASE: '', getActiveChat: () => null, renderMessages: noop,
  DOMParser: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// MUSIC_VIS_MODES / musicVisNorm 的真源在 01-core.js。这里从源码里**抠出那段**注入沙箱，
// 而不是在测试里手抄一份清单——手抄的话测的就是测试自己的副本，真源改了测试照样绿。
const DECLS = [];
for (const [list, fn] of [['MUSIC_VIS_MODES', 'musicVisNorm'],
                          ['MUSIC_LYRIC_STYLES', 'musicLyricStyleNorm']]) {
  const m = core.match(new RegExp(
    `const ${list} = \\[[^\\]]*\\];\\s*function ${fn}\\([^)]*\\)\\s*\\{[^}]*\\}`));
  assert.ok(m, `01-core.js 里没找到 ${list} / ${fn} 的定义`);
  // const 是词法声明，不会挂到沙箱对象上（跟 var / function 不一样），要显式导出
  DECLS.push(m[0] + `\nglobalThis.${list} = ${list};\nglobalThis.${fn} = ${fn};`);
}
vm.runInContext(DECLS.join('\n'), sandbox, { filename: '01-core.js#decls' });
vm.runInContext(musicSrc, sandbox, { filename: '24-music.js' });

test('点歌提示把最近播放拆进 volatile，不打穿稳定缓存', () => {
  // 「最近放过的歌」属于点歌那半，跟「AI 点歌」开关走（10-11 起听歌那半常开）
  sandbox.state.musicOn = true;
  sandbox.state.musicRecent = [{ name: '夜曲', artist: '周杰伦' }];
  const first = sandbox.musicPromptFor();
  sandbox.state.musicRecent = [{ name: '晴天', artist: '周杰伦' }];
  const second = sandbox.musicPromptFor();
  assert.equal(first.stable, second.stable);
  assert.match(first.volatile, /夜曲/);
  assert.match(second.volatile, /晴天/);
  assert.doesNotMatch(first.stable, /最近放过的歌/);
});

// 真实截段
const YRC = '[830,4980](830,380,0)夢(1210,330,0)な(1540,200,0)ら(1740,430,0)ば(2170,430,0)ど(2600,250,0)れ(2850,280,0)ほ(3130,330,0)ど(3460,480,0)よ(3940,270,0)か(4210,90,0)っ(4300,200,0)た(4500,460,0)で(4960,130,0)し(5090,230,0)ょ(5320,490,0)う\n'
  + '[6370,4890](6370,280,0)未(6650,630,0)だ(7280,510,0)に(7790,170,0)あ(7960,120,0)な(8080,510,0)た(8590,520,0)の(9110,210,0)こ(9320,500,0)と(9820,170,0)を(9990,550,0)夢(10540,180,0)に(10720,150,0)み(10870,390,0)る\n'
  + '[11780,5240](11780,450,0)忘(12230,340,0)れ(12570,200,0)た(12770,810,0)物(13580,350,0)を(13930,250,0)取(14180,450,0)り(14630,370,0)に(15000,550,0)帰(15550,380,0)る(15930,150,0)よ(16080,290,0)う(16370,650,0)に';
// yrc 开头真的长这样：几行 JSON 元数据混在歌词里
const YRC_WITH_META = '{"t":0,"c":[{"tx":"作词: "},{"tx":"米津玄師"}]}\n{"t":0,"c":[{"tx":"作曲: "}]}\n' + YRC;
const YTLRC = '[00:00.830]如果这一切都是梦境该有多好\n[00:06.370]至今仍能与你在梦中相遇\n[00:11.780]如同取回遗忘之物一般';
const YROMA = '[00:00.830]yu me na ra ba do re ho do yo ka tta de sho u \n[00:06.370]i ma da ni a na ta no ko to wo yu me ni mi ru \n[00:11.780]wa su re ta mo no wo to ri ni ka e ru yo u ni ';
// 晴天的 tlyric 就是这样：有时间标签、没有文字。不能当成"有翻译"
const EMPTY_TLYRIC = '[00:00.950]\n[00:01.950]\n[00:02.950]\n[00:03.950]';

test('YRC 逐字解析：切分、时间、拼回原句', () => {
  const lines = sandbox._mParseWordLyric(YRC);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].words.length, 16);
  assert.equal(lines[0].txt, '夢ならばどれほどよかったでしょう');
  assert.equal(lines[0].words.map(w => w.txt).join(''), lines[0].txt);
  assert.equal(lines[0].t, 0.83);
  assert.equal(+(lines[0].end).toFixed(3), 5.81);          // 830 + 4980 ms
  assert.equal(lines[0].words[0].t, 0.83);
  assert.equal(+(lines[0].words[0].end).toFixed(3), 1.21); // 830 + 380 ms
  for (const l of lines) {
    assert.ok(l.end > l.t);
    l.words.forEach((w, i) => {
      assert.ok(w.end >= w.t);
      if (i) assert.ok(w.t >= l.words[i - 1].t, '行内字必须按时间升序');
    });
  }
});

test('YRC 头部的 JSON 元数据不会被当成歌词', () => {
  const lines = sandbox._mParseWordLyric(YRC_WITH_META);
  assert.equal(lines.length, 3, '三行歌词，元数据不计入');
  assert.ok(!lines.some(l => /"t"\s*:|作词/.test(l.txt)));
});

test('QQ音乐 QRC 和 YRC 同构，共用一个解析器', () => {
  const q = sandbox._mParseWordLyric('[1000,2000](1000,500,0)Hel(1500,500,0)lo (2000,1000,0)world');
  assert.equal(q.length, 1);
  assert.equal(q[0].txt, 'Hello world');
  assert.equal(q[0].words.length, 3);
  assert.equal(q[0].t, 1);
  assert.equal(q[0].end, 3);
});

test('LRC 小数秒按位数缩放（.5/.50/.500 都是半秒）', () => {
  // 老代码一律 /1000，两位的厘秒会被当毫秒——.50 算成 0.05 秒，
  // 整首歌高亮提前小半秒，肉眼只觉得"有点抢"，查不出来。
  const l = sandbox._mParseLrc('[00:12.5]a\n[00:12.50]b\n[00:12.500]c\n[01:02.25]d');
  // Array.from 而不是 l.map：沙箱里造的数组原型来自另一个 realm，
  // deepStrictEqual 连原型一起比，值对了也会红。
  assert.deepEqual(Array.from(l, x => x.t), [12.5, 12.5, 12.5, 62.25]);
});

test('一行挂多个时间标签会展开成多行', () => {
  const l = sandbox._mParseLrc('[00:10.00][01:20.00][02:30.00]副歌一句');
  assert.equal(l.length, 3);
  assert.deepEqual(Array.from(l, x => x.t), [10, 80, 150]);
  assert.ok(l.every(x => x.txt === '副歌一句'));
});

test('翻译/罗马音按时间就近配对', () => {
  const lines = sandbox._mParseWordLyric(YRC);
  sandbox._mAttachAlt(lines, YTLRC, 'tr');
  sandbox._mAttachAlt(lines, YROMA, 'ro');
  assert.equal(lines[0].tr, '如果这一切都是梦境该有多好');
  assert.equal(lines[1].tr, '至今仍能与你在梦中相遇');
  assert.match(lines[0].ro, /^yu me na ra ba/);
  assert.ok(lines.every(l => l.tr !== l.txt), '翻译不该等于原文');
});

test('空壳翻译（只有时间标签没有文字）不产生任何翻译', () => {
  // 网易云对中文歌常返回这种：969 字节，一句真翻译都没有。
  // 按字节长度判断"有没有翻译"的话，每句下面都会挂一条空行。
  const lines = sandbox._mParseWordLyric(YRC);
  sandbox._mAttachAlt(lines, EMPTY_TLYRIC, 'tr');
  assert.ok(lines.every(l => !l.tr));
});

test('时间轴差太远的翻译不硬配', () => {
  const lines = sandbox._mParseWordLyric(YRC);
  const far = '[00:40.000]这句差了四十秒';
  sandbox._mAttachAlt(lines, far, 'tr');
  assert.ok(lines.every(l => !l.tr), '差 0.6s 以上就不配，宁可没有也不要错行');
});

// ── 以下五条是 Codex 审查逮出来的，每条都对应一个真实会踩的场景 ──

test('逐字歌词里的普通括号不会吞掉整行', () => {
  // 和声标记 (Oh)、括号注释在英文歌里遍地都是。字的文本必须取到
  // "下一个合法时间元组"为止；写成 [^(]* 的话这里会切出空串，整行被丢。
  const l = sandbox._mParseWordLyric('[1000,3000](1000,1000,0)Yeah (2000,1000,0)(Oh)');
  assert.equal(l.length, 1);
  assert.equal(l[0].txt, 'Yeah (Oh)');
  assert.equal(l[0].words.length, 2);
  assert.equal(l[0].words[1].txt, '(Oh)');
  // 整行只有一个带括号的字也要活下来
  const only = sandbox._mParseWordLyric('[1000,2000](1000,2000,0)(Oh)');
  assert.equal(only.length, 1, '整行只有 (Oh) 时不能被丢掉');
  assert.equal(only[0].txt, '(Oh)');
});

test('一条翻译只能贴给一行（不许复制给多行）', () => {
  // 主歌词拆行、翻译合行时会撞上：两行都在 0.6s 内选中同一条翻译，
  // 于是同一句翻译连着显示两遍。实测 Lemon 就中招（42 条配到 44 行）。
  const lines = [
    { t: 1.0, txt: 'a', words: [] },
    { t: 1.4, txt: 'b', words: [] },
  ];
  sandbox._mAttachAlt(lines, '[00:01.200]只有一条翻译', 'tr');
  const used = lines.filter(l => l.tr);
  assert.equal(used.length, 1, '只能贴给一行');
  assert.equal(used[0].tr, '只有一条翻译');
});

test('多条翻译按顺序一对一贴，不串行', () => {
  const lines = [
    { t: 1.0, txt: 'a', words: [] },
    { t: 2.0, txt: 'b', words: [] },
    { t: 3.0, txt: 'c', words: [] },
  ];
  sandbox._mAttachAlt(lines, '[00:01.000]一\n[00:02.000]二\n[00:03.000]三', 'tr');
  assert.deepEqual(Array.from(lines, l => l.tr), ['一', '二', '三']);
});

test('翻译比主歌词少时，多出来的行没有翻译而不是乱配', () => {
  const lines = [
    { t: 1.0, txt: 'a', words: [] },
    { t: 2.0, txt: 'b', words: [] },
    { t: 30.0, txt: 'c', words: [] },
  ];
  sandbox._mAttachAlt(lines, '[00:01.000]一\n[00:02.000]二', 'tr');
  assert.equal(lines[0].tr, '一');
  assert.equal(lines[1].tr, '二');
  assert.equal(lines[2].tr, undefined, '差 28 秒的那行不该硬配');
});

test('与原文相同的翻译也要被消费掉，不能顺延给下一行', () => {
  // "配上了"和"值得显示"是两件事。不消费的话，这条会错位贴给下一行。
  const lines = [
    { t: 1.0, txt: 'Hello', words: [] },
    { t: 1.4, txt: 'World', words: [] },
  ];
  sandbox._mAttachAlt(lines, '[00:01.000]Hello', 'tr');
  assert.equal(lines[0].tr, undefined, '和原文相同 → 不显示');
  assert.equal(lines[1].tr, undefined, '但也不许顺延贴给下一行');
});

test('WebVTT 的 cue identifier 不限于纯数字', () => {
  // 标准允许 `chorus` 这种命名 cue。按"过滤纯数字行"来做的话，
  // cue 名字会被当成歌词，混出一句 "chorus 第一句"。
  const vtt = 'WEBVTT\n\nchorus\n00:00:12.000 --> 00:00:15.000\n第一句';
  const l = sandbox._mParseVtt(vtt);
  assert.equal(l.length, 1);
  assert.equal(l[0].txt, '第一句');
});

test('WebVTT 解析（注释说支持就得真支持）', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:12.000 --> 00:00:15.000\n第一句\n\n2\n00:00:15.500 --> 00:00:18.000\n<c>第二句</c>';
  const l = sandbox._mParseVtt(vtt);
  assert.equal(l.length, 2);
  assert.equal(l[0].t, 12);
  assert.equal(l[0].end, 15);
  assert.equal(l[0].txt, '第一句', 'cue 编号行不能混进歌词');
  assert.equal(l[1].txt, '第二句', '内联标记 <c> 要去掉');
  assert.equal(sandbox._mSniffLyric(vtt).length, 2, '嗅探认得出 VTT');
  // 逗号小数点（部分工具导出成 SRT 风格）也要认
  assert.equal(sandbox._mParseVtt('00:00:01,500 --> 00:00:02,000\nx')[0].t, 1.5);
});

// 下面两条是真的把异步时序跑一遍，不是匹配源码字符串——
// 二审明确指出：只 assert.match 源码的话，这段时序问题根本捕获不到。
function mkAudioStub() {
  return { src: '', paused: true, duration: 0, currentTime: 0,
           play: async () => {}, pause() { this.paused = true; },
           addEventListener() {}, removeAttribute() { this.src = ''; }, load() {} };
}

test('停止之后，在途的 musicPlay 必须整趟作废', async () => {
  // 时序：play(A) 卡在取地址 → 用户按停止 → A 的地址才回来。
  // 不作废的话，旧的这一趟会接着跑到 `_mCoverTint(_mNow.cover)`，
  // 而 _mNow 已经是 null → 直接 TypeError。
  sandbox._mNow = null;
  sandbox._mAudio = mkAudioStub();
  let releaseUrl;
  const origFetch = sandbox.musicFetchUrl;
  sandbox.musicFetchUrl = () => new Promise(r => { releaseUrl = r; });
  try {
    const inflight = sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: 'http://x/a.jpg' });
    sandbox.musicStop();
    assert.equal(sandbox._mNow, null, '停止后立刻就该是 null');
    releaseUrl('http://cdn/a.mp3');
    await inflight;                       // 不抛异常才算过
    assert.equal(sandbox._mNow, null, '在途的那趟不许把 _mNow 复活');
  } finally {
    sandbox.musicFetchUrl = origFetch;
  }
});

test('play() 期间按停止，恢复后不许继续跑（会 musicNoteRecent(null)）', async () => {
  // musicPlay 里有两处 await，各需要一道代际校验，**两道缺一不可**：
  // 只让 A 卡在取地址的话，取地址那道就把它拦下了，play() 那道等于没测。
  // 这一条专门让 A 过了取地址、卡在 play() 上，才区分得开。
  sandbox._mNow = null;
  let releasePlay;
  const audio = mkAudioStub();
  audio.play = () => new Promise(r => { releasePlay = r; });
  sandbox._mAudio = audio;
  const origFetch = sandbox.musicFetchUrl;
  const origLoad = sandbox.musicLoadLyric;
  const origTint = sandbox._mCoverTint;
  sandbox.musicFetchUrl = async () => 'http://cdn/a.mp3';
  sandbox.musicLoadLyric = async () => {};
  sandbox._mCoverTint = () => {};
  try {
    const inflight = sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: 'http://x/a.jpg' });
    await new Promise(r => setTimeout(r, 0));
    assert.ok(releasePlay, '没走到 play()，这条测试没测到东西');
    sandbox.musicStop();
    releasePlay();
    await inflight;                    // 少了校验就会在 musicNoteRecent(null) 抛
    assert.equal(sandbox._mNow, null);
  } finally {
    sandbox.musicFetchUrl = origFetch;
    sandbox.musicLoadLyric = origLoad;
    sandbox._mCoverTint = origTint;
  }
});

test('切歌导致旧 play() 被 abort 时，不许弹「自动播放被拦」的假提示', async () => {
  // 换 a.src 会让上一首的 play() 以 AbortError 拒绝。那不是浏览器拦截，
  // 是用户自己换的歌——照报的话，每次切歌都弹一条莫名其妙的提示。
  sandbox._mNow = null;
  let rejectPlay;
  const audio = mkAudioStub();
  audio.play = () => new Promise((_, rej) => { rejectPlay = rej; });
  sandbox._mAudio = audio;
  const toasts = [];
  const origToast = sandbox.showToast;
  const origFetch = sandbox.musicFetchUrl;
  const origLoad = sandbox.musicLoadLyric;
  const origTint = sandbox._mCoverTint;
  sandbox.showToast = msg => { toasts.push(String(msg)); };
  sandbox.musicFetchUrl = async () => 'http://cdn/a.mp3';
  sandbox.musicLoadLyric = async () => {};
  sandbox._mCoverTint = () => {};
  try {
    const playA = sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: '' });
    await new Promise(r => setTimeout(r, 0));
    assert.ok(rejectPlay, '没走到 play()，这条测试没测到东西');
    sandbox.musicStop();                       // 用户主动停止 → 代际推进
    rejectPlay(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await playA;
    assert.deepEqual(toasts, [], '用户主动切歌/停止时不该有任何提示');
  } finally {
    sandbox.showToast = origToast;
    sandbox.musicFetchUrl = origFetch;
    sandbox.musicLoadLyric = origLoad;
    sandbox._mCoverTint = origTint;
  }
});

test('但真的被浏览器拦截时，提示还是要出来', async () => {
  // 上一条的反面对照：没有切歌，就是浏览器不让自动播放——这时必须报。
  // 只测"不弹"的话，把 _mPlayFailed 整个删掉测试也是绿的。
  sandbox._mNow = null;
  const audio = mkAudioStub();
  audio.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
  sandbox._mAudio = audio;
  const toasts = [];
  const origToast = sandbox.showToast;
  const origFetch = sandbox.musicFetchUrl;
  const origLoad = sandbox.musicLoadLyric;
  const origTint = sandbox._mCoverTint;
  sandbox.showToast = msg => { toasts.push(String(msg)); };
  sandbox.musicFetchUrl = async () => 'http://cdn/a.mp3';
  sandbox.musicLoadLyric = async () => {};
  sandbox._mCoverTint = () => {};
  try {
    await sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: '' });
    assert.equal(toasts.length, 1, '正常的自动播放拦截必须提示');
    assert.match(toasts[0], /自动播放/);
  } finally {
    sandbox.showToast = origToast;
    sandbox.musicFetchUrl = origFetch;
    sandbox.musicLoadLyric = origLoad;
    sandbox._mCoverTint = origTint;
  }
});

test('切歌时，旧的 musicPlay 不许再去请求歌词（否则会废掉新歌的请求）', async () => {
  // 旧调用如果恢复后还去 musicLoadLyric，它拿到的 token 比新歌还大，
  // 新歌的歌词响应会被判成过期 → B 在放，却一直没有歌词。
  sandbox._mNow = null;
  sandbox._mAudio = mkAudioStub();
  const asked = [];
  const origFetch = sandbox.musicFetchUrl;
  const origLoad = sandbox.musicLoadLyric;
  const origTint = sandbox._mCoverTint;
  sandbox.musicLoadLyric = async id => { asked.push(String(id)); };
  sandbox._mCoverTint = () => {};
  let releaseA;
  sandbox.musicFetchUrl = () => new Promise(r => { releaseA = r; });
  try {
    const playA = sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: '' });
    await new Promise(r => setTimeout(r, 0));
    // B 直接带 url 进来（AI 点歌那条路就是这样），不经过 musicFetchUrl
    await sandbox.musicPlay({ id: 'B', name: 'B', artist: '', cover: '' }, 'http://cdn/b.mp3');
    releaseA('http://cdn/a.mp3');
    await playA;
    // 最狠的一条：旧调用恢复后会跑 `_mNow.url = src` 和 `a.src = src`，
    // 而此时 _mNow 已经是 B——旧歌的地址会被塞进 B，
    // 表现是**界面显示 B、实际出 A 的声**，且完全不报错。
    assert.equal(sandbox._mAudio.src, 'http://cdn/b.mp3', '音频源不许被旧歌覆盖');
    assert.equal(sandbox._mNow.url, 'http://cdn/b.mp3', '_mNow.url 不许被旧歌覆盖');
    assert.deepEqual(asked, ['B'], '只有 B 该请求歌词，A 那趟已经作废');
    assert.equal(String(sandbox._mNow.id), 'B', '正在放的还是 B');
  } finally {
    sandbox.musicFetchUrl = origFetch;
    sandbox.musicLoadLyric = origLoad;
    sandbox._mCoverTint = origTint;
  }
});

test('手动贴的歌词不许被在途的自动请求盖掉', async () => {
  // 会去手动贴歌词，多半就是因为自动那份还没回来或者配错了。
  // 网易云的响应晚一步回来把人刚贴的东西冲掉，是最气人的一种静默失败。
  sandbox._mNow = { id: 'A', name: 'A', artist: '', cover: '' };
  let releaseFetch;
  const origFetch = sandbox.fetch;
  const origPrompt = sandbox.prompt;
  sandbox.fetch = () => new Promise(r => { releaseFetch = r; });
  try {
    const loading = sandbox.musicLoadLyric('A');
    await new Promise(r => setTimeout(r, 0));
    sandbox.prompt = () => '[00:01.000]我自己贴的';
    await sandbox.musicPasteLyric();
    assert.equal(sandbox._mLyric.lines[0].txt, '我自己贴的');
    releaseFetch({ json: async () => ({ lyric: '[00:01.000]网上下来的' }) });
    await loading;
    assert.equal(sandbox._mLyric.lines[0].txt, '我自己贴的', '在途的自动歌词不许覆盖手动贴的');
  } finally {
    sandbox.fetch = origFetch;
    sandbox.prompt = origPrompt;
  }
});

test('切歌时立刻作废旧封面取色（B 在放、配色却是 A 的）', async () => {
  // _mTintReq 只在 _mCoverTint 里推进，而那是 play() 之后才调的。
  // 切到 B 后 B 还卡在取地址时，A 的图片加载完成 → 代际仍然成立 → 把 A 的色刷上去。
  sandbox._mNow = null;
  sandbox._mAudio = mkAudioStub();
  const loaded = [];
  const origImage = sandbox.Image;
  const origFetch = sandbox.musicFetchUrl;
  const origLoad = sandbox.musicLoadLyric;
  sandbox.musicLoadLyric = async () => {};
  // 假 Image：记下回调，手动控制什么时候"加载完成"
  sandbox.Image = function () { loaded.push(this); };
  let releaseB;
  sandbox.musicFetchUrl = () => new Promise(r => { releaseB = r; });
  try {
    // A 正常播起来，触发一次取色（图片挂着不 load）
    await sandbox.musicPlay({ id: 'A', name: 'A', artist: '', cover: 'http://x/a.jpg' }, 'http://cdn/a.mp3');
    const imgA = loaded[loaded.length - 1];
    assert.ok(imgA && typeof imgA.onload === 'function', 'A 应该起了一个取色任务');
    // 切到 B，B 卡在取地址
    const playB = sandbox.musicPlay({ id: 'B', name: 'B', artist: '', cover: 'http://x/b.jpg' });
    await new Promise(r => setTimeout(r, 0));
    // 此时 A 的图片才加载完 —— 必须被判过期。
    // ⚠️ 哨兵不能用 null：沙箱里 getContext() 返回 null，取色会抛进 catch 而 catch 里
    // 正好写 `_mTint = null`——断言 `=== null` 于是永远成立，哪怕代际校验被整个删掉。
    // 用一个绝不会被写出来的值，才分得清"回调没跑"和"回调跑了但失败了"。
    sandbox._mTint = 'SENTINEL';
    imgA.onload();
    assert.equal(sandbox._mTint, 'SENTINEL', 'A 的取色回调必须整个不执行，而不是执行了但失败');
    if (releaseB) releaseB('http://cdn/b.mp3');
    await playB;   // 别让它在 finally 恢复桩函数之后才继续跑，会污染后面的用例
  } finally {
    sandbox.Image = origImage;
    sandbox.musicFetchUrl = origFetch;
    sandbox.musicLoadLyric = origLoad;
  }
});

test('慢响应不许盖掉新歌的歌词/配色（切歌竞态）', () => {
  // 连着切歌时先发的请求可能后回来。没有作废机制的话：放着 B、屏幕上是 A 的词。
  assert.match(musicSrc, /const seq = \+\+_mLyricReq;/);
  assert.match(musicSrc, /if \(seq !== _mLyricReq \|\| !_mNow \|\| String\(_mNow\.id\) !== String\(id\)\) return;/);
  assert.match(musicSrc, /const seq = \+\+_mTintReq;/);
  assert.match(musicSrc, /img\.onload = \(\) => \{\s*if \(seq !== _mTintReq\) return;/);
  assert.match(musicSrc, /img\.onerror = \(\) => \{ if \(seq !== _mTintReq\) return;/);
  // 必须限定在 musicStop 的函数体里：musicPlay 开头现在也有一模一样的
  // `_mLyricReq++; _mTintReq++;`，全文匹配的话，把 musicStop 里那行删掉测试照样绿。
  const stopBody = musicSrc.match(/function musicStop\(\)[\s\S]*?\n\}/);
  assert.ok(stopBody, '找不到 musicStop 函数体');
  assert.match(stopBody[0], /_mPlayReq\+\+; _mLyricReq\+\+; _mTintReq\+\+;/,
    'musicStop 要同时作废播放/歌词/取色三条在途链路');
});

test('纯音乐识别（标记和文本两条路）', () => {
  assert.ok(sandbox._mIsPureMusic({ pureMusic: true }, [{ txt: '随便' }]));
  assert.ok(sandbox._mIsPureMusic({}, sandbox._mParseLrc('[00:00.00]纯音乐，请欣赏')));
  assert.ok(!sandbox._mIsPureMusic({}, sandbox._mParseWordLyric(YRC)));
});

// ── 纯音乐的猫咪、「音」「译」角标（用户）──
// 真跑 musicLoadLyric → _mPaintLyric，DOM 只桩两个节点：歌词框和角标框。
function mkLyDom() {
  const mk = () => ({ innerHTML: '', scrollTop: 0, classList: { toggle: noop }, addEventListener: noop, dataset: {} });
  const els = { musicLyric: mk(), mzLyOpts: mk() };
  const orig = sandbox.document.getElementById;
  sandbox.document.getElementById = id => els[id] || null;
  return { els, restore: () => { sandbox.document.getElementById = orig; } };
}
async function loadLy(id, resp) {
  const origFetch = sandbox.fetch;
  sandbox.fetch = async () => ({ ok: !(resp && resp.error), json: async () => resp });
  try { await sandbox.musicLoadLyric(id); } finally { sandbox.fetch = origFetch; }
}

test('纯音乐显示猫咪那句，切到别的歌就不再显示', async () => {
  const dom = mkLyDom();
  try {
    sandbox._mNow = { id: 'P1', name: '纯音乐', artist: '', cover: '' };
    await loadLy('P1', { lyric: '[00:00.00]纯音乐，请欣赏', pureMusic: true });
    assert.equal(sandbox._mLyric, null, '「纯音乐，请欣赏」不能当成歌词');
    assert.ok(dom.els.musicLyric.innerHTML.includes('本曲已被猫咪啃掉歌词(=^. .^=)∫'), dom.els.musicLyric.innerHTML);
    // 只有文本、没有标记（另一个后端/老接口）也认
    sandbox._mNow = { id: 'P2', name: '纯音乐2', artist: '', cover: '' };
    await loadLy('P2', { lyric: '[00:00.00]纯音乐，请欣赏' });
    assert.ok(dom.els.musicLyric.innerHTML.includes('猫咪'), '只靠文本认出来的纯音乐也要是猫咪');
    // 网易云答了、但一个字都没有也没打标（KLYN 那种，用户）：也是猫咪
    sandbox._mNow = { id: 'E1', name: 'KLYN', artist: '', cover: '' };
    await loadLy('E1', { lyric: '', tlyric: '', yrc: '', pureMusic: false });
    assert.ok(dom.els.musicLyric.innerHTML.includes('猫咪'), '网易云一个字都没有的也要是猫咪：' + dom.els.musicLyric.innerHTML);
    // 只有制作名单、没有真词（斩杀时刻，真实响应原样）：也是猫咪
    sandbox._mNow = { id: 'C1', name: '斩杀时刻', artist: '', cover: '' };
    await loadLy('C1', { lyric: '作词 : 所长sama\n作曲 : 所长sama\n编曲 : 所长sama\n编曲/制作/混音：所长sama\n出品人：所长sama\n\n', yrc: '', pureMusic: false });
    assert.ok(dom.els.musicLyric.innerHTML.includes('猫咪'), '只有制作名单的要是猫咪：' + dom.els.musicLyric.innerHTML);
    // 对照：名单里夹着一句真词，不能被当成纯音乐
    assert.ok(!sandbox._mOnlyCredits('作词 : 某某\n[00:10.00]真的有一句词'), '夹真词不算名单');
    // 换成一首取歌词失败的歌（server 502）：得是「没有歌词」，不能沿用上一首的猫咪
    sandbox._mNow = { id: 'N1', name: '没词', artist: '', cover: '' };
    await loadLy('N1', { error: '取歌词失败: timeout' });
    assert.ok(dom.els.musicLyric.innerHTML.includes('没有歌词'), dom.els.musicLyric.innerHTML);
    assert.ok(!dom.els.musicLyric.innerHTML.includes('猫咪'), '取失败不是猫咪');
    // 断网（fetch 直接抛）：也是「没有歌词」
    sandbox._mNow = { id: 'N3', name: '断网', artist: '', cover: '' };
    { const of = sandbox.fetch; sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
      try { await sandbox.musicLoadLyric('N3'); } finally { sandbox.fetch = of; } }
    assert.ok(dom.els.musicLyric.innerHTML.includes('没有歌词') && !dom.els.musicLyric.innerHTML.includes('猫咪'), '断网不是猫咪');
    // 有字但格式认不出：不许拿猫咪盖过去
    sandbox._mNow = { id: 'G1', name: '乱码', artist: '', cover: '' };
    await loadLy('G1', { lyric: 'just some text without timestamps' });
    assert.ok(!dom.els.musicLyric.innerHTML.includes('猫咪'), '有字解析不出不是猫咪');
    // 只有逐字那份有字（也解析不出）：同理，两份时轴都要看
    sandbox._mNow = { id: 'G2', name: '逐字乱码', artist: '', cover: '' };
    await loadLy('G2', { lyric: '', yrc: 'garbage yrc' });
    assert.ok(!dom.els.musicLyric.innerHTML.includes('猫咪'), '逐字那份有字就不是猫咪：' + dom.els.musicLyric.innerHTML);
    // 纯音乐的慢响应在切歌后才回来：不许把猫咪贴到新歌上
    sandbox._mNow = { id: 'P3', name: 'x', artist: '', cover: '' };
    const origFetch = sandbox.fetch; let release;
    sandbox.fetch = () => new Promise(r => { release = r; });
    const p = sandbox.musicLoadLyric('P3');
    sandbox._mNow = { id: 'N2', name: 'y', artist: '', cover: '' };
    release({ json: async () => ({ lyric: '', pureMusic: true }) });
    await p; sandbox.fetch = origFetch;
    sandbox._mPaintLyric();
    assert.ok(!dom.els.musicLyric.innerHTML.includes('猫咪'), '过期的纯音乐判定不许落到新歌上');
  } finally { dom.restore(); }
});

test('「音」「译」角标：有罗马音/翻译才出，状态跟设置走', async () => {
  const dom = mkLyDom();
  const keep = { tr: sandbox.state.musicLyricTrans, ro: sandbox.state.musicLyricRoma };
  try {
    delete sandbox.state.musicLyricTrans; delete sandbox.state.musicLyricRoma;
    sandbox._mNow = { id: 'J1', name: 'Lemon', artist: '米津玄師', cover: '' };
    await loadLy('J1', {
      lyric: '[00:01.00]夢ならばどれほどよかったでしょう\n[00:05.00]未だにあなたのことを夢にみる',
      tlyric: '[00:01.00]如果这一切都是梦境该有多好\n[00:05.00]至今仍能与你在梦中相遇',
      romalrc: '[00:01.00]yume naraba dore hodo yokatta deshou\n[00:05.00]imada ni anata no koto wo yume ni miru',
    });
    const opts = () => dom.els.mzLyOpts.innerHTML;
    const btn = ch => (opts().match(new RegExp(`<button[^>]*>${ch}</button>`)) || [''])[0];
    assert.ok(btn('音') && btn('译'), '日语歌两个都要有：' + opts());
    // 默认：翻译开、罗马音关（和 ⋮ 里那两个开关同一份默认值）
    assert.match(btn('译'), /class="mz-ly-opt on"/);
    assert.doesNotMatch(btn('音'), / on"/);
    assert.ok(!dom.els.musicLyric.innerHTML.includes('ly-ro'), '罗马音默认不显示');
    assert.match(btn('音'), /musicToggleLyricOpt\('musicLyricRoma',false\)/);
    assert.match(btn('译'), /musicToggleLyricOpt\('musicLyricTrans',true\)/);
    // 拨成「音开、译关」，重画后两边都跟上
    sandbox.state.musicLyricRoma = true; sandbox.state.musicLyricTrans = false;
    sandbox._mPaintLyric();
    assert.match(btn('音'), /class="mz-ly-opt on"/);
    assert.doesNotMatch(btn('译'), / on"/);
    assert.ok(dom.els.musicLyric.innerHTML.includes('yume naraba'), '开了罗马音歌词里要有');
    assert.ok(!dom.els.musicLyric.innerHTML.includes('如果这一切'), '关了翻译歌词里不能有');
    // 中文歌：没有罗马音也没有翻译 → 角标一个都不出
    sandbox._mNow = { id: 'C1', name: '稻香', artist: '周杰伦', cover: '' };
    await loadLy('C1', { lyric: '[00:01.00]对这个世界如果你有太多的抱怨', tlyric: '', romalrc: '' });
    assert.equal(opts(), '', '中文歌不出角标');
    // 只有翻译的英文歌：只出「译」
    sandbox._mNow = { id: 'E1', name: 'x', artist: '', cover: '' };
    await loadLy('E1', { lyric: '[00:01.00]Hello from the other side', tlyric: '[00:01.00]来自另一边的问候' });
    assert.ok(btn('译') && !btn('音'), '只有翻译就只出「译」：' + opts());
    // 纯音乐也不出
    sandbox._mNow = { id: 'P9', name: 'x', artist: '', cover: '' };
    await loadLy('P9', { lyric: '', pureMusic: true });
    assert.equal(opts(), '', '纯音乐不出角标');
  } finally {
    dom.restore();
    sandbox.state.musicLyricTrans = keep.tr; sandbox.state.musicLyricRoma = keep.ro;
    if (keep.tr === undefined) delete sandbox.state.musicLyricTrans;
    if (keep.ro === undefined) delete sandbox.state.musicLyricRoma;
  }
});

test('「音」「译」是按钮（点它不许顺带切沉浸全屏）、放在歌词框外面（不跟着滚）', () => {
  assert.match(musicSrc, /<div class="music-lyric" id="musicLyric"><\/div><div class="mz-ly-opts" id="mzLyOpts"><\/div>/);
  assert.match(musicSrc, /`<button type="button" class="mz-ly-opt/);
  assert.match(musicSrc, /function _mTapIgnored\(ev\) \{[^}]*closest\('button/);
  assert.match(css, /\.mz-ly-opts \{ position:absolute;/);
  assert.match(css, /\.mz-ly-wrap \{ position:relative; \}/);
});

test('贴歌词的格式嗅探', () => {
  assert.equal(sandbox._mSniffLyric(YRC).length, 3);
  assert.equal(sandbox._mSniffLyric('[00:10.00]一句').length, 1);
  assert.equal(sandbox._mSniffLyric('[1000,2000](1000,500,0)Hi').length, 1);
  assert.equal(sandbox._mSniffLyric(''), null);
  assert.equal(sandbox._mSniffLyric('这就是一段普通文字，没有时间轴'), null);
});

test('逐字歌词缺失时回落到行级，不是变成「没有歌词」', () => {
  // 冷门歌、老歌、翻唱绝大多数只有行级歌词。只认 yrc 的话它们全都没词了。
  assert.equal(sandbox._mParseWordLyric('').length, 0);
  assert.ok(sandbox._mParseLrc('[00:01.00]有词').length === 1);
  assert.match(musicSrc, /const wbw = yrc\.length > 0;/);
  assert.match(musicSrc, /const lines = wbw \? yrc : _mParseLrc\(j\.lyric\)/);
});

test('有 yrc 时翻译优先取 ytlrc（和 yrc 同一套时间轴）', () => {
  assert.match(musicSrc, /_mAttachAlt\(lines, \(wbw && j\.ytlrc\) \|\| j\.tlyric, 'tr'\)/);
  assert.match(musicSrc, /_mAttachAlt\(lines, \(wbw && j\.yromalrc\) \|\| j\.romalrc, 'ro'\)/);
});

test('歌词显示偏好过了三道门', () => {
  for (const key of ['musicLyricTrans', 'musicLyricRoma', 'musicVis']) {
    const idbKey = 'kuro_' + key;
    assert.match(stateJs, new RegExp(`idbSet\\('${idbKey}'`), `${key} 漏了第 1 道（_doSave 写盘）`);
    assert.match(core, new RegExp(`${key}:\\s*await g\\('${idbKey}'`), `${key} 漏了第 2 道（loadStateFromDB 读回）`);
    assert.match(boot, new RegExp(`state\\.${key}\\s*=`), `${key} 漏了第 3 道（启动赋值）`);
  }
});

test('开关从 state 现读，不写死默认值', () => {
  // 面板是 innerHTML 整块重画的：写死 checked/默认值的话，每次重画都弹回默认，
  // 人以为"设置没保存"。（study 那边的组大小踩过同款。）
  assert.match(musicSrc, /_mOptOn\('musicLyricTrans', true\)/);
  assert.match(musicSrc, /_mOptOn\('musicLyricRoma', false\)/);
  assert.ok(!/checked="checked"/.test(musicSrc));
});

test('两个后端给出同一份歌词字段（漏一个就是桌面对、手机错）', () => {
  // 手机独立跑时走 CoreadServer.java 的 localhost:8080，连着电脑时走 server.js。
  // 两边字段不一致的表现是"电脑上有逐字歌词、手机上没有"，而且两边都不报错。
  for (const p of ['lv=-1', 'tv=-1', 'rv=-1', 'yv=-1', 'ytv=-1', 'yrv=-1']) {
    assert.ok(androidJava.includes(p), `Java 侧漏了参数 ${p}`);
  }
  for (const p of ['lv: -1', 'tv: -1', 'rv: -1', 'yv: -1', 'ytv: -1', 'yrv: -1']) {
    assert.ok(serverMusicSrc.includes(p), `${musicSrcPart.file} 漏了参数 ${p}`);
  }
  for (const f of ['lyric', 'tlyric', 'romalrc', 'yrc', 'ytlrc', 'yromalrc', 'pureMusic']) {
    assert.match(serverMusicSrc, new RegExp(`${f}:`), `${musicSrcPart.file} 没返回 ${f}`);
    assert.ok(androidJava.includes(`"${f}"`), `Java 侧没返回 ${f}`);
  }
  // 前端读的每一个字段，两个后端都得给
  for (const f of ['yrc', 'ytlrc', 'yromalrc', 'romalrc', 'tlyric', 'lyric']) {
    assert.ok(musicSrc.includes('j.' + f), `前端没用上 ${f}（那后端给了也白给）`);
  }
});

test('逐字渲染与流光的样式都在', () => {
  assert.match(css, /\.ly-w::after\s*\{[^}]*content:attr\(data-c\)/);
  assert.match(css, /\.ly-w::after\s*\{[^}]*width:calc\(var\(--p,0\) \* 100%\)/);
  assert.match(css, /\.music-ly-line:not\(\.on\) \.ly-w::after\s*\{[^}]*display:none/);
  assert.match(css, /\.ly-tr\s*\{/);
  assert.match(css, /\.ly-ro\s*\{/);
  assert.match(css, /\.music-vis\s*\{[^}]*position:absolute/);
  assert.match(css, /\.music-vis\.on\s*\{[^}]*opacity:1/);
  assert.match(indexHtml, /<canvas id="musicVis"/);
});

test('没接 Web Audio 频谱是故意的，别哪天顺手加回来', () => {
  // 把跨域的 <audio> 接进 MediaElementAudioSourceNode 会让整条链路静音：
  // 歌照放、进度条照走、控制台一声不吭。这个代价换一点频谱不值。
  assert.ok(!/createMediaElementSource/.test(musicSrc), '不要接 Web Audio 频谱（见文件内注释）');
  assert.match(musicSrc, /没有接 Web Audio 的频谱/);
});

test('rAF 有开有关（暂停和关面板都要停）', () => {
  assert.match(musicSrc, /cancelAnimationFrame\(_mRaf\)/);
  assert.match(musicSrc, /cancelAnimationFrame\(_mVisRaf\)/);
  assert.match(musicSrc, /function closeMusic\(\)[\s\S]{0,300}_mLyricLoopSync\(\); _mVisSync\(\)/);
});

// ============================================================
// 沉浸背景：四种模式 + 封面流体层
// ============================================================

test('背景模式清单只有一份真源', () => {
  // 出事方式：在 24-music 里另抄一份 ['aurora','fluid',...]，
  // 加了新模式却漏改持久化那三道关 —— 选了存不住，刷新弹回 aurora，零报错。
  const list = sandbox.MUSIC_VIS_MODES;
  assert.deepEqual(Array.from(list), ['aurora', 'fluid', 'geo', 'off']);
  // 三道关必须调 musicVisNorm，不许各自写 === 'off' ? 'off' : 'aurora' 那种字面量判断
  assert.match(stateJs, /kuro_musicVis[^\n]*musicVisNorm\(state\.musicVis\)/,
    '_doSave 没走 musicVisNorm（新模式会被存成 aurora）');
  assert.match(boot, /state\.musicVis\s*=\s*musicVisNorm\(saved\.musicVis\)/,
    '启动赋值没走 musicVisNorm（新模式会在启动时被改掉）');
  assert.match(core, /musicVis:\s*await g\('kuro_musicVis'/, 'loadStateFromDB 里没读 musicVis');
  // 对照组：确认这三处不是恰好含着旧的写死判断
  assert.ok(!/musicVis === 'off' \? 'off' : 'aurora'/.test(stateJs + boot),
    '还留着写死的两值判断，新模式存不住');
  // 名字/图标表要盖满每一种，不然按钮会显示 undefined
  for (const m of list) {
    assert.ok(sandbox._mVisNames[m], `_mVisNames 缺 ${m}`);
    assert.ok(sandbox._mVisIcons[m], `_mVisIcons 缺 ${m}`);
  }
});

test('musicVisNorm 挡掉脏值', () => {
  const n = sandbox.musicVisNorm;
  assert.equal(n('fluid'), 'fluid');
  assert.equal(n('geo'), 'geo');
  assert.equal(n('off'), 'off');
  // 脏值/旧值/没存过 → 回落，而不是原样放行
  for (const bad of [undefined, null, '', 'sparkle', 'AURORA', 0, {}]) {
    assert.equal(n(bad), 'aurora', `${JSON.stringify(bad)} 应该回落 aurora`);
  }
});

test('点一圈能回到原点，四种都轮得到', () => {
  const seen = [];
  sandbox.state.musicVis = 'aurora';
  for (let i = 0; i < 4; i++) { sandbox.musicCycleVis(); seen.push(sandbox.state.musicVis); }
  assert.deepEqual(seen, ['fluid', 'geo', 'off', 'aurora'], '轮换顺序不对或没回绕');
  // 存的是脏值时也要能点动（否则 indexOf 返回 -1 会卡在同一个模式上）
  sandbox.state.musicVis = '不认识的值';
  sandbox.musicCycleVis();
  assert.equal(sandbox.state.musicVis, 'aurora', '脏值起步应该落到清单第一个');
});

test('封面流体：同一张封面不重复堆层（幂等）', () => {
  // _mVisSync 每次 _mPaint 都会调 _mFluidSet；不幂等的话每次播放状态一变就多叠一层 <img>
  const kids = [];
  const box = {
    get children() { return kids; },
    get firstChild() { return kids[0] || null; },
    appendChild(n) { kids.push(n); return n; },
    removeChild(n) { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); return n; },
    set innerHTML(v) { if (v === '') kids.length = 0; },
    get innerHTML() { return ''; },
  };
  sandbox.document.getElementById = id => (id === 'musicFluid' ? box : null);
  sandbox.document.createElement = () => ({ className: '', appendChild: noop,
                                            classList: { add: noop } });
  let downscales = 0;
  const realDown = sandbox._mDownscale;
  sandbox._mDownscale = () => { downscales++; return new Promise(() => {}); };  // 永不 resolve：只数调用
  sandbox._mFluidUrl = null;

  sandbox._mFluidSet('http://x/a.jpg');
  sandbox._mFluidSet('http://x/a.jpg');
  sandbox._mFluidSet('http://x/a.jpg');
  assert.equal(downscales, 1, '同一张封面被重复处理了');
  sandbox._mFluidSet('http://x/b.jpg');
  assert.equal(downscales, 2, '换封面时没有重新处理');

  sandbox._mDownscale = realDown;
  sandbox.document.getElementById = () => null;
  sandbox.document.createElement = () => ({ getContext: () => null });
});

test('停止播放要把封面层清掉', () => {
  // 不清的话，停了之后沉浸背景底下还挂着上一首的封面
  assert.match(musicSrc, /function musicStop\(\)[\s\S]{0,400}_mFluidSet\(null\)/);
});

test('封面流体的两个防闪烁措施都在（抄 folia 抄全）', () => {
  // 1. 模糊源要先缩小：大图纹理分块上传 = 栅格闪烁
  assert.match(musicSrc, /_mDownscale\(url, 384\)/, '没有把模糊源缩小到 384px');
  // 2. 淡入动在外层 div，不能动带 blur 的 img
  assert.match(css, /\.music-fluid-layer\s*\{[^}]*transition:opacity/);
  assert.match(css, /\.music-fluid-img\s*\{[^}]*filter:blur\(40px\)/);
  // 对照组：blur 那层自己不能带 opacity 过渡，否则每帧重新光栅化模糊
  const imgRule = css.match(/\.music-fluid-img\s*\{([^}]*)\}/);
  assert.ok(imgRule && !/transition/.test(imgRule[1]),
    '.music-fluid-img 不该有 transition —— 动模糊层的透明度会每帧重画模糊');
  // 白底封面糊完是一片亮白，必须有压暗层，否则歌词直接看不见
  assert.match(css, /\.music-fluid::before\s*\{[^}]*rgba\(6,6,10/);
  assert.match(indexHtml, /<div id="musicFluid"/);
});

test('_mDownscale 跨域拿不到像素时回落 null 而不是抛', async () => {
  // 网易云图床现在给 CORS 头，但哪天不给了不能整块背景崩掉
  const calls = [];
  sandbox.document.createElement = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: noop, imageSmoothingEnabled: false }),
    toDataURL: () => { throw new Error('SecurityError: tainted canvas'); },
  });
  sandbox.Image = function () { calls.push(this); };
  const p = sandbox._mDownscale('http://x/a.jpg', 384);
  const img = calls[0];
  img.naturalWidth = 800; img.naturalHeight = 800;
  img.onload();
  assert.equal(await p, null, '被污染的 canvas 应该回落 null，让调用方改用原图');

  // 加载失败也是 null，不是挂住
  const p2 = sandbox._mDownscale('http://x/b.jpg', 384);
  calls[1].onerror();
  assert.equal(await p2, null);

  sandbox.Image = function () {};
  sandbox.document.createElement = () => ({ getContext: () => null });
});

test('几何背景按歌 id 播种（同一首歌图案稳定）', () => {
  // 用 Math.random 的话每次刷新面板图形全变，看着像 bug。
  // ⚠️ 这里必须验**行为**：第一版写的是 /_mGeoBuild\([^)]*Math\.random/ 这种字符串正则，
  // 而真把 `const rnd = _mSeedRand(seed)` 换成 `const rnd = Math.random` 它照样绿——
  // 函数签名没变，正则压根碰不到。对照组逮出来的假绿。
  const g1 = JSON.stringify(sandbox._mGeoBuild(42));
  const g2 = JSON.stringify(sandbox._mGeoBuild(42));
  const g3 = JSON.stringify(sandbox._mGeoBuild(43));
  assert.equal(g1, g2, '同一首歌两次进来图案必须完全一样');
  assert.notEqual(g1, g3, '换一首歌要换一套图案');
  assert.match(musicSrc, /function _mSeedRand\(seed\)/);
  const r1 = sandbox._mSeedRand(12345), r2 = sandbox._mSeedRand(12345), r3 = sandbox._mSeedRand(999);
  const a = [r1(), r1(), r1()], b = [r2(), r2(), r2()], c = [r3(), r3(), r3()];
  assert.deepEqual(a, b, '同一个种子应该出同一串');
  assert.notDeepEqual(a, c, '不同种子应该出不同串');
  for (const v of a) { assert.ok(v >= 0 && v < 1, '随机数越界: ' + v); }
  // 形状表要成形（数量、归一化坐标）
  const shapes = sandbox._mGeoBuild(42);
  assert.equal(shapes.length, 14);
  for (const s of shapes) {
    assert.ok(s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1, '坐标不是归一化的');
    assert.ok(['circle', 'square', 'tri', 'cross'].includes(s.k));
    assert.ok(s.r > 0 && s.r < 0.2);
  }
});

test('两层背景互斥，fluid 模式下 canvas 的 rAF 不许跑', () => {
  // 同时亮着 = 白画一层；canvas rAF 在 fluid 模式还转 = 白烧 CPU
  assert.match(musicSrc, /const canvasOn = live && state\.musicVis !== 'fluid'/);
  assert.match(musicSrc, /const fluidOn = live && state\.musicVis === 'fluid'/);
  assert.match(musicSrc, /if \(!canvasOn && _mVisRaf\)/);
});

test('Luminous 字效：切字才动 class，样式限定在当前行', () => {
  // 每帧动 classList 的话，一句 30 个字就是每秒 1800 次样式写入
  assert.match(musicSrc,
    /if \(cur !== _mWordCur\)[\s\S]{0,400}classList\.toggle\('ly-now', k === cur\)/);
  assert.match(musicSrc, /classList\.toggle\('ly-done', k < cur\)/);
  // 切行时旧行的 class 不清，所以样式必须限定在 .on 里，
  // 否则上一句会永远卡着一个放大的字
  assert.match(css, /\.music-ly-line\.on \.ly-w\.ly-now\s*\{[^}]*transform:scale/);
  assert.match(css, /\.music-ly-line\.on \.ly-w\.ly-done::after\s*\{/);
  assert.match(css, /@keyframes lyRipple/);
  const bare = css.match(/^\.ly-w\.ly-now\s*\{/m);
  assert.ok(!bare, '.ly-w.ly-now 不能不限定行就写 transform（上一句会卡住放大的字）');
  // 动效要认 reduced-motion
  assert.match(css, /prefers-reduced-motion:reduce\)\{[\s\S]{0,200}\.ly-w\.ly-now \{ transform:none/);
});

// ============================================================
// Tilt 错落排版
// ============================================================

// 造一条指定字数的逐字歌词
function mkWordLine(text, msPer) {
  let s = '[0,' + (text.length * (msPer || 250)) + ']';
  [...text].forEach((c, i) => { s += '(' + (i * (msPer || 250)) + ',' + ((msPer || 250) - 10) + ',0)' + c; });
  return sandbox._mParseWordLyric(s)[0];
}

test('切段一个字都不能丢（错位了会点亮到别的段去）', () => {
  // .ly-w 的 DOM 顺序必须仍然和 line.words 一一对应，_mSyncWords 才能继续用
  // getElementsByClassName（文档顺序）。少一个、多一个、顺序变了，
  // 症状都是"高亮跑到别的段"——看得见，但一行报错都没有。
  const L = mkWordLine('這是一句很長的歌詞用來測試切分會不會把字弄丟掉啊');
  for (let seed = 1; seed <= 60; seed++) {
    const segs = sandbox._mTiltSplit(L, seed * 137);
    const flat = [];
    for (const s of segs) for (const w of s.words) flat.push(w.txt);
    assert.equal(flat.join(''), L.txt, `seed=${seed} 文本对不上`);
    assert.equal(flat.length, L.words.length, `seed=${seed} 字数对不上`);
    // 顺序也要一致，不能只是集合相同
    assert.deepEqual(flat, Array.from(L.words, w => w.txt), `seed=${seed} 顺序变了`);
  }
});

test('整句最多一段是斜体大字', () => {
  const L = mkWordLine('夢ならばどれほどよかったでしょう');
  for (let seed = 1; seed <= 80; seed++) {
    const n = sandbox._mTiltSplit(L, seed * 977).filter(s => s.tilt).length;
    assert.ok(n <= 1, `seed=${seed} 出了 ${n} 段斜体`);
  }
});

test('同一句每次进来排版一样，不同句不一样', () => {
  // 用 Math.random 的话每次开面板整篇重排，看着像 bug
  const L = mkWordLine('夢ならばどれほどよかったでしょう');
  assert.equal(JSON.stringify(sandbox._mTiltSplit(L, 555)),
               JSON.stringify(sandbox._mTiltSplit(L, 555)), '同种子两次结果不一样');
  assert.notEqual(JSON.stringify(sandbox._mTiltSplit(L, 555)),
                  JSON.stringify(sandbox._mTiltSplit(L, 556)), '相邻种子排版完全相同');
});

test('段数真的会变（这条逮到过 RNG 把段数锁死）', () => {
  // ⚠️ 出事经过：_mSeedRand 是裸 LCG，相邻种子的**第一个**输出几乎线性
  //（种子差 1，输出只差 1664525/2^32 ≈ 0.0004）。而段数只取前一两个随机数，
  // 于是 32 字长句跑 200 个种子**全是 2 段**，3/4 段一次都没出现——
  // 零报错，只是 Tilt 永远只有一种样子。修法是进 LCG 前先做雪崩混合。
  const long = mkWordLine('這是一句很長的歌詞用來測試切分是不是真的會分成好幾段落下來看看');
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) seen.add(sandbox._mTiltSplit(long, seed * 137).length);
  assert.ok(seen.size >= 2, `长句 300 个种子只切出 ${[...seen]} 段，段数被锁死了`);
  // 短句要明显更少段——不是纯随机，得跟字数走
  const short = mkWordLine('夢ならば');
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const shortN = [], longN = [];
  for (let seed = 1; seed <= 200; seed++) {
    shortN.push(sandbox._mTiltSplit(short, seed * 137).length);
    longN.push(sandbox._mTiltSplit(long, seed * 137).length);
  }
  assert.ok(avg(longN) > avg(shortN) + 0.4,
    `长句平均 ${avg(longN).toFixed(2)} 段 vs 短句 ${avg(shortN).toFixed(2)} 段，没跟字数走`);
});

test('_mSeedRand 的前几个输出必须打散（不只是最终分布）', () => {
  // 直接验根因：相邻种子的第 1 个输出要拉得开
  const first = [];
  for (let s = 1; s <= 40; s++) first.push(sandbox._mSeedRand(s)());
  let maxGap = 0;
  for (let i = 1; i < first.length; i++) maxGap = Math.max(maxGap, Math.abs(first[i] - first[i - 1]));
  assert.ok(maxGap > 0.2,
    `相邻种子第一个随机数最大只差 ${maxGap.toFixed(5)}，说明种子没被打散`);
  // 确定性不能因此丢掉
  assert.equal(sandbox._mSeedRand(42)(), sandbox._mSeedRand(42)());
});

test('没有逐字时轴的整句歌词也能切', () => {
  // 老歌只有行级 LRC，words 是空的——不能因此炸掉或者切成空段
  const l = sandbox._mParseLrc('[00:01.00]今天天气不错，我们出去走走吧，顺便吃个饭')[0];
  const segs = sandbox._mTiltSplit(l, 12345);
  assert.ok(segs.length >= 1);
  assert.equal(segs.map(s => s.txt).join(''), l.txt, '整句切分把文本弄丢了');
  for (const s of segs) assert.ok(s.txt.length > 0, '切出了空段');
});

test('Tilt 不劈词：叠字、虚词、假名都不从中间切（用户：截图「就这样一点 / 点的腐烂吧」）', () => {
  const cases = {
    '就这样一点点的腐烂吧': ['一点点'],
    '我们一起走过的那些日子': ['走过的'],
    '夢ならばどれほどよかったでしょう': ['よかった', 'でしょう'],
    '慢慢地慢慢地忘记你': ['慢慢地'],
    // ICU 不认识的成语/新词会碎成单字（「也|一|无|是|处的」「倒霉|蛋」）
    '哪怕存在着也一无是处的我啊': ['一无是处'],
    '或许我就是那个倒霉蛋吧': ['倒霉蛋'],
    '只想要这一次的拥抱': ['这一次'],
    '我想再一次抱紧你': ['再一次'],
  };
  for (const [t, keep] of Object.entries(cases)) {
    for (const words of [mkWordLine(t).words, []]) {
      for (let seed = 1; seed <= 120; seed++) {
        const segs = sandbox._mTiltSplit({ t: 0, txt: t, words }, seed * 137).map(s => s.txt);
        assert.equal(segs.join(''), t, `${t} seed=${seed} 文本丢了`);
        for (const w of keep) {
          assert.ok(segs.some(s => s.includes(w)), `${t} seed=${seed} 把「${w}」劈开了：${segs.join(' / ')}`);
        }
        for (const s of segs) assert.ok(s.replace(/\s+/g, '').length >= 2, `${t} seed=${seed} 落单了一个字：${segs.join(' / ')}`);
      }
    }
  }
  // 不劈词也不能矫枉过正成「整句不切」：假名长句唯一的词边界离中点很远，也得切得开
  // （修完劈词后 Lemon 那句 120 个种子全是 1 段，browser-music-lyrics.js 才抓出来）
  const lemon = '夢ならばどれほどよかったでしょう';
  for (const words of [mkWordLine(lemon).words, []]) {
    let multi = 0;
    for (let seed = 1; seed <= 120; seed++) if (sandbox._mTiltSplit({ t: 0, txt: lemon, words }, seed * 137).length >= 2) multi++;
    assert.ok(multi >= 60, `${words.length ? '逐字' : '行级'}：120 个种子里只有 ${multi} 个切成了多段`);
  }
  // 行级歌词的英文：空格要留着，不能拼成「Icanfeelit」
  const en = 'I can feel it coming in the air tonight';
  for (let seed = 1; seed <= 60; seed++) {
    const segs = sandbox._mTiltSplit({ t: 0, txt: en, words: [] }, seed * 137);
    assert.equal(segs.map(s => s.txt).join(''), en, `seed=${seed} 英文空格丢了`);
    for (const s of segs) assert.ok(!/^\s/.test(s.txt), `seed=${seed} 段以空格开头`);
  }
  // 中文没有斜体字面，伪斜体会把字硬拉斜；宋体那种是系统层拉的，font-synthesis 关不掉，
  // 所以斜体单独一个 class，只挂在不含中日韩字的段上（用户：截图「这样的我有」还是斜的）
  const it = sandbox._mTiltItalic;
  assert.equal(it({ tilt: true, txt: '这样的我有', words: [] }), false);
  assert.equal(it({ tilt: true, txt: '', words: [{ txt: 'よかった' }] }), false);
  assert.equal(it({ tilt: true, txt: 'feel it 你', words: [] }), false, '中英混排也不能斜');
  assert.equal(it({ tilt: true, txt: 'coming in the air', words: [] }), true);
  assert.equal(it({ tilt: false, txt: 'coming in the air', words: [] }), false);
  assert.doesNotMatch(css, /\.ly-seg-tilt\s*\{[^}]*font-style:italic/, '放大段不能无差别斜体');
  assert.match(css, /\.ly-seg-it\s*\{[^}]*font-style:italic/);
  assert.match(musicSrc, /_mTiltItalic\(s\) \? ' ly-seg-it'/, '渲染没走 _mTiltItalic');
});

test('排版样式：三道关 + 轮换 + 样式表', () => {
  assert.deepEqual(Array.from(sandbox.MUSIC_LYRIC_STYLES), ['scroll', 'tilt', 'cinema']);
  assert.match(stateJs, /kuro_musicLyricStyle[^\n]*musicLyricStyleNorm\(state\.musicLyricStyle\)/,
    '_doSave 没走 musicLyricStyleNorm');
  assert.match(boot, /state\.musicLyricStyle\s*=\s*musicLyricStyleNorm\(saved\.musicLyricStyle\)/,
    '启动赋值没走 musicLyricStyleNorm');
  assert.match(core, /musicLyricStyle:\s*await g\('kuro_musicLyricStyle'/, 'loadStateFromDB 里没读');
  const n = sandbox.musicLyricStyleNorm;
  assert.equal(n('tilt'), 'tilt');
  for (const bad of [undefined, null, '', 'TILT', 'fancy', 0]) assert.equal(n(bad), 'scroll');
  // 轮换
  sandbox.state.musicLyricStyle = 'scroll';
  sandbox.musicCycleLyricStyle(); assert.equal(sandbox.state.musicLyricStyle, 'tilt');
  sandbox.musicCycleLyricStyle(); assert.equal(sandbox.state.musicLyricStyle, 'cinema');
  sandbox.musicCycleLyricStyle(); assert.equal(sandbox.state.musicLyricStyle, 'scroll');
  // 名字/图标表：缺一个的话按钮会秃一块，而且不报错
  for (const s of sandbox.MUSIC_LYRIC_STYLES) {
    assert.ok(sandbox._mStyleNames[s], `_mStyleNames 缺 ${s}`);
    assert.ok(sandbox._mStyleIcons[s], `_mStyleIcons 缺 ${s}`);
  }
  // CSS：段是 block（不然 .ly-w 换行会乱），非当前句要收成一行
  assert.match(css, /\.ly-tilt \.ly-main\s*\{[^}]*flex-direction:column/);
  assert.match(css, /\.ly-seg\s*\{[^}]*margin-left:calc\(var\(--ind,0\) \* 100%\)/);
  assert.match(css, /\.ly-seg-it\s*\{[^}]*font-style:italic/);
  assert.match(css, /\.ly-tilt \.music-ly-line:not\(\.on\) \.ly-seg\s*\{[^}]*margin-left:0/);
  assert.match(css, /@keyframes lySegIn/);
});

test('Cinema：逐词 1:1、hero 唯一、同种子稳定', () => {
  const mk = txts => ({ t: 12.5, txt: txts.join(''), words: txts.map(t => ({ t: 0, end: 1, txt: t })) });
  const l = mk(['Lately', ', ', 'did ', 'you ', 'ever ', 'feel ', 'the ', 'weight']);

  // 1:1 —— 这是整个 cinema 最要紧的一条。span 数或顺序一旦和 line.words 对不上，
  // _mSyncWords 点亮就跑到别的字上去了：看得见，但一行报错都没有。
  const j = sandbox._mCineJit(l, 12500);
  assert.equal(j.length, l.words.length, 'span 数和 words 数对不上');
  assert.equal(j.map(x => x.txt).join(''), l.txt, '逐词映射把文本弄丢了');

  // hero 唯一，且落在最长的词上（这里是 'weight' / 'Lately'，都是 6 个字符）
  assert.equal(j.filter(x => x.hero).length, 1, 'hero 不是恰好一个');
  const heroTxt = j.find(x => x.hero).txt.trim();
  const maxLen = Math.max(...l.words.map(w => w.txt.trim().length));
  assert.equal(heroTxt.length, maxLen, `hero 不是最长的词（挑中了 ${heroTxt}）`);
  assert.equal(j.find(x => x.hero).sc, 1.46, 'hero 没吃到 cadenza 的 1.46');

  // 同种子必须完全一样，否则每开一次面板整篇重排，看着像 bug
  assert.deepEqual(sandbox._mCineJit(l, 12500), j, '同种子排版不稳定');
  assert.notDeepEqual(sandbox._mCineJit(l, 99991), j, '换了种子排版没变（种子没生效？）');

  // 空白词不许抖也不许转，否则词距会被转歪
  for (const x of j) if (/^\s*$/.test(x.txt)) {
    assert.equal(x.dy, 0); assert.equal(x.rot, 0); assert.equal(x.sc, 1); assert.equal(x.ov, 0);
  }
  // 首词不许往左压，不然整句左边缺一块
  assert.equal(j[0].ov, 0, '首词被往左压了');

  // 没有逐字时轴时也要有错落（普通 LRC 占大多数，退化成一坨平字就白做了）
  const plain = sandbox._mCineJit({ t: 3, txt: '近来 你是否深陷泥沼', words: [] }, 3000);
  assert.ok(plain.length > 1, '纯文本行没切出词');
  assert.equal(plain.map(x => x.txt).join(''), '近来 你是否深陷泥沼', '纯文本切分把字弄丢了');
  assert.ok(plain.some(x => x.dy !== 0), '纯文本行完全没抖动');

  // 段数很多的行：hero 仍然唯一（蓄水池抽样写错的话会挑出 0 个或多个）
  for (let s = 0; s < 60; s++) {
    const got = sandbox._mCineJit(mk('aa bb cc dd ee ff'.split(/(?= )/)), s);
    assert.equal(got.filter(x => x.hero).length, 1, `种子 ${s} 挑出的 hero 不是一个`);
  }
});

test('Cinema：CSS 盖得住滚动模式那套', () => {
  // 这几条全是"不写就静默失效"的：特异性不够时旧规则赢，
  // 效果是字号/位移回到滚动模式的样子，但一行报错都没有。
  assert.match(css, /\.ly-cine \.ly-main,\s*\.ly-cine \.music-ly-line\.on \.ly-main\s*\{[^}]*width:max-content/,
    'ly-main 没有 width:max-content —— 镜头 clamp 会算歪');
  assert.match(css, /\.ly-cine \.ly-main,\s*\.ly-cine \.music-ly-line\.on \.ly-main\s*\{[^}]*white-space:nowrap/);
  // --sc 必须走 font-size 而不是 transform:scale。
  // 走 transform 的话放大不进布局，.ly-main 的 rect 还是没放大前的宽度，
  // _mCineFollow 判成"放得下"就不推镜头，句尾被裁掉且零报错（踩过）。
  const wRule = css.match(/\.ly-cine \.ly-w\s*\{([^}]*)\}/);
  assert.ok(wRule, '没有 cinema 版的 .ly-w 规则');
  assert.ok(/font-size:calc\(1em \* var\(--sc,1\)\)/.test(wRule[1]),
    '--sc 没走 font-size —— 放大不进布局，镜头跟随会算歪');
  assert.ok(!/transform:[^;]*scale\(var\(--sc/.test(wRule[1]),
    '--sc 又跑回 transform:scale 了');
  // .ly-now 的 transform 必须重写并带上 --dy/--rot，否则唱到哪个字哪个字跳回原位；
  // 但**不能**再乘 --sc（那份已经在 font-size 里，乘两遍当前字会突然暴涨）
  const now = css.match(/\.ly-cine \.music-ly-line\.on \.ly-w\.ly-now\s*\{([^}]*)\}/);
  assert.ok(now, '没有 cinema 版的 .ly-now 规则');
  for (const v of ['--dy', '--rot']) {
    assert.ok(now[1].includes(v), `.ly-now 的 transform 丢了 ${v}，当前字会跳回原位`);
  }
  assert.ok(!now[1].includes('--sc'), '.ly-now 又把 --sc 乘了一遍');
  assert.ok(/z-index:\s*5/.test(now[1]), '当前字没提 z-index —— 字互相压着时读不出来');
  // ♪ 必须被 3 个 class 的选择器盖掉，否则大字模式下它照样冒出来还占宽度
  assert.match(css, /\.ly-cine \.music-ly-line\.on \.ly-main::before[^{]*\{[^}]*content:none/,
    '♪ 的覆盖规则特异性不够，会输给 .music-ly-line.on .ly-main::before');
  // 只留当前句
  assert.match(css, /\.ly-cine \.music-ly-line\s*\{[^}]*position:absolute/);
  assert.match(css, /\.ly-cine \.music-ly-line\.on\s*\{[^}]*opacity:1/);
});

// 下面这批全是 codex 逮出来的，每条都是"看得见但零报错"的那种。
test('Cinema：codex 逮到的四条', () => {
  // ① cinema 下不许再走滚动模式的 scrollTo。
  // .music-lyric 是 position:relative，absolute 子元素照样算进它的滚动区，
  // overflow:hidden 拦不住程序化滚动 —— 滚了就把居中的那一句推出画面。
  const sync = musicSrc.match(/function _mSyncLyricLine\(time\)\s*\{[\s\S]*?\n\}/);
  assert.ok(sync, '没找到 _mSyncLyricLine');
  assert.ok(/_mCineOn\(\)/.test(sync[0]), '_mSyncLyricLine 没有分 cinema 的支');
  assert.ok(/scrollTop\s*=\s*0/.test(sync[0]), 'cinema 分支没清 scrollTop（从滚动模式切过来会带着旧的滚动位置）');
  // scrollTo 必须落在 else 里，不能两条路都走
  // （09-30 起滚动抽成 _mLyAnchor，切行、重画、改尺寸三处共用；重画/改尺寸那条入口 _mLyReanchor 自己挡 cinema）
  const [ifArm, elseArm = ''] = sync[0].split(/\}\s*else\s*\{/);
  assert.ok(/_mLyAnchor\(|scrollTo/.test(elseArm), '滚动不在 else 分支里 —— cinema 也会被滚');
  assert.ok(!/_mLyAnchor\(|scrollTo\(/.test(ifArm.slice(ifArm.indexOf('_mCineOn()'))), 'cinema 分支里也在滚');
  const re = musicSrc.match(/function _mLyReanchor\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(re && /_mCineOn\(\)\) return/.test(re[0]), '_mLyReanchor 没挡 cinema —— 重画会把居中那句滚出画面');

  // ② 没有逐字时轴的歌不许被压暗（_mSyncWords 对它们直接 return，--p 永远是 0）
  assert.ok(/ly-wbw/.test(musicSrc), '_mPaintLyric 没打 ly-wbw 标记');
  assert.match(css, /\.ly-cine\.ly-wbw \.ly-main[^{]*\{[^}]*color:rgba\(255,255,255,\.36\)/,
    '压暗没有限定在 .ly-wbw 里 —— 普通 LRC 会一直是灰的');
  const mainRule = css.match(/\.ly-cine \.ly-main,\s*\.ly-cine \.music-ly-line\.on \.ly-main\s*\{([^}]*)\}/);
  assert.ok(mainRule && !/color:rgba\(255,255,255,\.36\)/.test(mainRule[1]),
    '压暗还留在无条件的 .ly-main 规则里');
  // 行级歌词也要有一次镜头归位，否则长句句尾永久被裁
  assert.ok(/if \(!_mLyric\.wbw\) _mCineFollow\(/.test(sync[0]),
    '行级歌词切行时没补 _mCineFollow');

  // ③ 容器尺寸变了要重测。全屏切换和 resize 都得有入口。
  assert.ok(/function _mCineRemeasure\(\)/.test(musicSrc), '没有 _mCineRemeasure');
  // 验的是"真的注册上了"而不是"源码里有这行字"——正则那种改个写法就绕过去了
  assert.ok(sandbox.window._on.resize && sandbox.window._on.resize.length,
    'resize 没有接上重测（窗口变宽/手机转屏后镜头会停在旧位置）');
  const full = musicSrc.match(/function musicToggleLyricsFull\([\s\S]*?\n\}/);
  assert.ok(full && /_mCineRemeasure\(\)/.test(full[0]),
    '进/退全屏没有重测镜头 —— 旧尺寸算的 translateX 会一直挂着');

  // ④ 短句必须居中，不能只清 transform（.ly-main 是 max-content 且左对齐，清了就贴左）
  const follow = musicSrc.match(/function _mCineFollow\([\s\S]*?\n\}/);
  assert.ok(follow, '没找到 _mCineFollow');
  assert.ok(!/transform\s*=\s*''/.test(follow[0]),
    '还在用清空 transform 来处理短句 —— 会缩在最左边');
  assert.ok(/cur < 0 \|\| cur >= spans\.length/.test(follow[0]),
    '_mCineFollow 没处理"没有当前字"的情况（行级歌词传的是 -1）');

  // ⑥（二审逮到的）行号不变时重绘，行级歌词的镜头位移不能丢。
  // 切「译/A」、暂停继续都会走 musicRefresh → _mPaintLyric 重建 DOM，inline transform 没了；
  // 而 _mSyncLyricLine 会因行号没变提前 return、_mSyncWords 对非 wbw 直接 return ——
  // 两条补救路都断了，居中的短句会贴回最左边。逐字歌词靠 _mWordCur=-1 逃过一劫。
  const paint = musicSrc.match(/function _mPaintLyric\(\)[\s\S]*?\n\}/);
  assert.ok(paint, '没找到 _mPaintLyric');
  assert.ok(/cineOn && !_mLyric\.wbw.*_mCineRemeasure\(\)/.test(paint[0]),
    '_mPaintLyric 重绘后没给行级歌词重测镜头（短句会贴回最左边）');

  // ⑤ reduced-motion 下当前字不许再跳（cinema 那条 4 class 的规则会盖掉通用的 transform:none）
  const rm = css.match(/@media\(prefers-reduced-motion:reduce\)\{[^}]*\.ly-cine[\s\S]*?\n\}/);
  assert.ok(rm, 'reduced-motion 块里没有 cinema 的覆盖');
  assert.ok(/\.ly-cine \.music-ly-line\.on \.ly-w\.ly-now\s*\{[^}]*transform:translateY/.test(rm[0]),
    'reduced-motion 下 cinema 的当前字还会缩放');
  assert.ok(!/scale\(1\.14\)/.test(rm[0]), 'reduced-motion 下还留着 scale(1.14)');
});

test('桌面与安卓副本一致', () => {
  for (const rel of [['js', '24-music.js'], ['js', '01-core.js'], ['js', '02-state.js'],
                     ['js', '14-boot-brain-hub.js'], ['css', 'grancyan.css']]) {
    const desktop = fs.readFileSync(path.join(root, ...rel), 'utf8');
    const mobile = fs.readFileSync(path.join(root, 'android', 'assets', ...rel), 'utf8');
    assert.equal(mobile, desktop, `android 副本与 ${rel.join('/')} 不一致（跑 android/build.ps1）`);
  }
  const deskHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const mobHtml = fs.readFileSync(path.join(root, 'android', 'assets', 'index.html'), 'utf8');
  assert.equal(mobHtml, deskHtml, 'android 的 index.html 也要同步');
});
