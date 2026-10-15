'use strict';
// 听歌：把正在放的歌算成速度/亮暗/起伏/调性，递给 AI（用户）
//
// 分三块：
//   ① 特征本身 —— 用合成信号喂 musicSongFeatures，答案是造出来的，所以能严格对：
//      点击音轨的 BPM、低沉正弦 vs 高频噪声的亮度、前轻后响的起伏、C 大调 / A 小调和弦进行。
//   ② 接线 —— _mListen 在切歌后回来的结果不许盖到新歌头上；命中缓存不再下载。
//   ③ 提示词 —— 「正在放」和听感只进 volatile，stable 里不许出现歌名（否则每换一首歌缓存全废）。
//
// 真实歌曲的校准（8 首，BPM 先验中心 120→100 的依据）是在本地另做的，没放进来：
// 要联网下歌，而且结果只能人看着判断对不对。所以**先验中心这个数这里锁不住**
// （故障注入改回 120 仍然全绿——点击音轨没有倍速歧义），改它要回去重跑那 8 首。
// 「细网格 → 拍子取两格」那条（2026-09-27，《彩色复活券》66→132）同样锁不住：合成的八分音符
// 点击怎么加重音都复现不出真歌「两拍处比一拍处还高」的形状，新旧代码结果一样。
// 真歌在 _tmp/songfeat（8 首校准 + cs/ 下 6 个翻唱版），`node oct.js . cs` 重跑。
//
// 切歌作废有三层（解码后、每批 tick、写结果前），故意叠着的；单拆一层这里不会红，
// 三层一起拆才红（2026-09-26 注入验过）。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const music = fs.readFileSync(path.join(ROOT, 'js/24-music.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// ── 特征那一段单独抠出来跑 ──
// 不用 vm：vm 沙箱里每次 Math.sqrt 都要过全局拦截器，一万帧的 FFT 慢十倍，整套测试会拖很久。
const A0 = 'const _M_FEAT_SR', A1 = 'function musicToggle()';
t('锚点各只有一处', music.split(A0).length === 2 && music.split(A1).length === 2);
const featSrc = music.slice(music.indexOf(A0), music.indexOf(A1));
const F = new Function('localStorage', 'window', 'fetch',
  featSrc + '; return { musicSongFeatures, musicSongHint, musicSongTags, _mArcText };')(
  { getItem: () => null, setItem() {} }, {}, null);

const SR = 22050;
function signal(sec, fn) { const d = new Float32Array(Math.round(sec * SR)); for (let i = 0; i < d.length; i++) d[i] = fn(i / SR, i); return d; }
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
// 每拍一个 30ms 的噪声脉冲，指数衰减
const clicks = (bpm, sec, amp = 0.5) => signal(sec, (tm) => {
  const ph = tm % (60 / bpm);
  return ph < 0.03 ? amp * rnd() * Math.exp(-ph * 120) : 0;
});
const tones = (freqs, tm, amp) => freqs.reduce((s, f) => s + Math.sin(2 * Math.PI * f * tm), 0) * amp / freqs.length;
const hz = n => 440 * 2 ** ((n - 69) / 12);        // MIDI 音高 → Hz
const chords = (prog, sec) => signal(sec, tm => tones(prog[Math.floor(tm) % prog.length].map(hz), tm, 0.4));

(async () => {
  // ── ① 特征 ──
  t('不到 5 秒不算', (await F.musicSongFeatures(new Float32Array(SR * 4), SR)) === null);

  for (const bpm of [100, 128, 76]) {
    const f = await F.musicSongFeatures(clicks(bpm, 30), SR);
    t(`点击音轨 ${bpm} BPM 算得出来（±3%）且置信度过线`, f && Math.abs(f.bpm - bpm) / bpm <= 0.03 && f.bpmConf >= 0.3, f && { bpm: f.bpm, conf: f.bpmConf });
  }
  // 没有节拍：持续的和弦长音
  const pad = await F.musicSongFeatures(signal(20, tm => tones([220, 277, 330], tm, 0.3)), SR);
  t('持续长音没有拍子 → 提示「拍子不明显」', pad && F.musicSongHint(pad).includes('拍子不明显'), pad && { bpm: pad.bpm, conf: pad.bpmConf });

  const dark = await F.musicSongFeatures(signal(15, tm => tones([110, 165, 220], tm, 0.4)), SR);
  const brightF = await F.musicSongFeatures(signal(15, () => 0.3 * rnd()), SR);
  t('低沉正弦的亮度 < 白噪声', dark && brightF && dark.bright < brightF.bright, [dark?.bright, brightF?.bright]);
  t('低沉 → 偏暗；白噪声 → 很亮', F.musicSongHint(dark).includes('偏暗') && F.musicSongHint(brightF).includes('很亮'),
    [F.musicSongHint(dark), F.musicSongHint(brightF)]);

  // 起伏：前 15 秒轻（-20dB），后 15 秒响
  const cres = await F.musicSongFeatures(signal(30, tm => (tm < 15 ? 0.05 : 0.5) * rnd()), SR);
  t('前轻后响 → 起伏很大', cres && cres.lra >= 9, cres && cres.lra);
  t('前轻后响 → 走势是「越往后越满」', cres && F.musicSongHint(cres).includes('越往后越满'), cres && { arc: cres.arc, hint: F.musicSongHint(cres) });
  const flat = await F.musicSongFeatures(signal(30, () => 0.3 * rnd()), SR);
  t('一直一样响 → 整首响度很平', flat && flat.lra < 4 && F.musicSongHint(flat).includes('很平'), flat && flat.lra);
  // 片头片尾的静音不许算进起伏
  const padded = new Float32Array(SR * 40); padded.set(signal(20, () => 0.3 * rnd()), SR * 10);
  const pf = await F.musicSongFeatures(padded, SR);
  t('片头片尾 10 秒静音被剪掉，不把起伏撑大', pf && pf.lra < 4, pf && pf.lra);

  // 调性：I-IV-V-I 和 i-iv-V-i
  const cMaj = await F.musicSongFeatures(chords([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], 24), SR);
  t('C 大调和弦进行 → C 大调', cMaj && cMaj.key === 'C 大调', cMaj && { key: cMaj.key, conf: cMaj.keyConf, mode: cMaj.modeConf });
  const aMin = await F.musicSongFeatures(chords([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]], 24), SR);
  t('A 小调和弦进行 → A 小调', aMin && aMin.key === 'A 小调', aMin && { key: aMin.key, conf: aMin.keyConf, mode: aMin.modeConf });

  // tick：每批都调，抛错能中途放弃
  let ticks = 0;
  await F.musicSongFeatures(clicks(100, 20), SR, async () => { ticks++; });
  t('tick 按批调用（20 秒 ≈ 860 帧 → ≥4 次）', ticks >= 4, ticks);
  let aborted = false;
  try { await F.musicSongFeatures(clicks(100, 20), SR, async () => { throw new Error('切歌了'); }); } catch (e) { aborted = e.message === '切歌了'; }
  t('tick 抛错 → 整个计算中止并把错抛出去', aborted);

  t('走势：开头轻中间满结尾收', F._mArcText([-9, -8, 0, -1, -1, 0, -9, -10]).includes('中间推到最满'));
  t('走势：前面满后面收', F._mArcText([0, -1, -2, -3, -5, -6, -7, -9]).includes('后面渐渐收'));
  t('走势：平的不硬凑', F._mArcText([0, -1, -1, 0, -1, -1, 0, -1]) === '');
  const tagF = { bpm: 90, bpmConf: 0.6, pulse: 30, bright: 2000, lra: 12, key: 'F 大调', keyConf: 0.1, modeConf: 0.2 };
  t('面板标签是短的', F.musicSongTags(tagF) === '🎧 90 BPM · 偏亮 · 起伏大 · F大调', F.musicSongTags(tagF));
  t('起音太弱（pulse<10）时 bpmConf 再高也算散拍', F.musicSongTags({ ...tagF, pulse: 3 }).includes('散拍') && F.musicSongHint({ ...tagF, pulse: 3 }).includes('拍子不明显'));

  // ── ② 接线：整份 24-music.js 丢进 vm，喂一个假的 fetch / OfflineAudioContext ──
  const store = {};
  let fetches = 0, release = null;
  const audio = clicks(100, 8);                     // 短样本：vm 里慢，8 秒够了
  const box = {
    state: {}, console,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    addEventListener() {}, setTimeout: (fn) => { fn(); return 0; }, AbortController,
    fetch: async () => { fetches++; if (release) await release; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
    escHtml: s => String(s ?? ''), showToast() {}, save() {},
  };
  box.window = {
    addEventListener() {},
    OfflineAudioContext: class { decodeAudioData() { return Promise.resolve({ length: audio.length, numberOfChannels: 1, sampleRate: SR, getChannelData: () => audio }); } },
  };
  vm.createContext(box);
  vm.runInContext(music, box);
  vm.runInContext('_mPaint = function(){}', box);

  vm.runInContext(`_mNow = { id: 1, name: 'A', artist: 'x', url: 'https://cdn/a.mp3' }; _mPlayReq = 5;`, box);
  await vm.runInContext('_mListen(_mNow, 5)', box);
  t('正常放完：_mNow.feat 填上了，带 hint', !!vm.runInContext('_mNow.feat && _mNow.feat.hint', box), vm.runInContext('_mNow.feat', box));
  t('结果进了本地缓存', !!JSON.parse(store.kuro_musicFeat || '{}')['1']);

  // 切歌：下载途中 _mPlayReq 变了、_mNow 换成了别的歌
  let open; release = new Promise(r => { open = r; });
  vm.runInContext(`_mNow = { id: 2, name: 'B', artist: 'x', url: 'https://cdn/b.mp3' }; _mPlayReq = 6;`, box);
  const p = vm.runInContext('_mListen(_mNow, 6)', box);
  vm.runInContext(`_mNow = { id: 3, name: 'C', artist: 'x', url: 'https://cdn/c.mp3' }; _mPlayReq = 7;`, box);
  open(); await p; release = null;
  t('切歌后回来的结果不盖到新歌上', !vm.runInContext('_mNow.feat', box));
  t('被作废的那首也不进缓存', !JSON.parse(store.kuro_musicFeat || '{}')['2']);

  // 再点第一首：命中缓存，不再下载
  const before = fetches;
  vm.runInContext(`_mNow = { id: 1, name: 'A', artist: 'x', url: 'https://cdn/a.mp3' }; _mPlayReq = 8;`, box);
  await vm.runInContext('_mListen(_mNow, 8)', box);
  t('同一首再放：命中缓存、不再下载', fetches === before && !!vm.runInContext('_mNow.feat', box), { fetches, before });

  t('musicPlay 在 play() 之后接了 _mListen', /_mCoverTint\(_mNow\.cover\);\s*_mListen\(_mNow, seq\);/.test(music));

  // ── ③ 提示词 ──
  vm.runInContext(`_mAudio = { paused: false, currentTime: 65, duration: 240 };`, box);
  // 2026-09-26 起按需：平时只报「有歌在放」，AI 写了 [[LISTEN]]（置位）才摊开一次，细节在 lookup-chain.test.js
  const idle = vm.runInContext('musicPromptFor({ id: 1 })', box);
  t('没要听：只报有歌在放、不带歌名', idle.volatile.includes('[有歌在放]') && !/A-x/.test(idle.volatile), idle.volatile.slice(0, 200));
  const want = `state.musicListenWant = { '1': true }; musicPromptFor({ id: 1 })`;
  const pr = vm.runInContext(want, box);
  t('volatile 里有「正在放」和歌名、进度', pr.volatile.includes('正在放] A-x') && pr.volatile.includes('1:05 / 4:00'), pr.volatile.slice(0, 200));
  t('volatile 里有听感', pr.volatile.includes('听感（按音频算的）：') && pr.volatile.includes('BPM'), pr.volatile.slice(0, 300));
  t('stable 里没有歌名（不然每换一首缓存全废）', !pr.stable.includes('[正在放]') && !/A-x/.test(pr.stable));
  t('stable 里告诉 AI 这是算出来的、别说自己听见了', pr.stable.includes('别说成你亲耳听到了'));
  vm.runInContext(`_mAudio.paused = true;`, box);
  t('暂停时标出来', vm.runInContext(want, box).volatile.includes('（暂停中）'));
  t('暂停时平时那行也标', vm.runInContext('musicPromptFor({ id: 1 })', box).volatile.includes('（暂停中）'));
  vm.runInContext(`_mNow = null;`, box);
  t('没在放歌就没有「正在放」', !vm.runInContext('musicPromptFor({ id: 1 })', box).volatile.includes('在放'));

  console.log(fail ? `\n❌ ${pass} passed, ${fail} failed` : `\n✅ ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
