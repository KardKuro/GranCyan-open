const fs = require('fs');
const path = require('path');
const { readSingleSrc } = require('./_src-map');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const src = read('js/30-video.js');
const html = read('index.html');
const api = read('js/05-prompts-api.js');
const input = read('js/09-appearance-input.js');
const media = read('js/12-math-media.js');
// 服务端视频抽帧+图片代理已搬进 server/media.js（docs/server-split-plan.md Phase 1 第四块），
// 经 readSingleSrc('video') 取当前真实位置，逻辑名一条不改，映射表在 tests/_src-map.js 里改。
const server = readSingleSrc('video').text;

console.log('\n[视频抽帧]');

/* 抽帧本身要 <video> + canvas，node 里跑不了（真跑法见
   scratchpad/vidtest.html：headless Chrome + 真视频，那条路验的是「能不能出图」）。
   这里只跑得动纯函数，以及守住几条肉眼看不出来的形状约束。 */

// ── 从真源码里抠出纯函数来跑，不复制逻辑 ────────────────────────────
function fnSrc(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  return null;
}
const cfgSrc = src.slice(src.indexOf('const VIDEO_CFG'), src.indexOf('};', src.indexOf('const VIDEO_CFG')) + 2);
const pickSrc = fnSrc('_vidPickTimes');
const stepSrc = fnSrc('_vidProbeStep');
const notesSrc = fnSrc('buildVideoNotes');
const fmtSrc = fnSrc('_vidFmtTime');
const isVidSrc = fnSrc('isVideoFile');
const lineAt = marker => src.slice(src.indexOf(marker), src.indexOf('\n', src.indexOf(marker)));
const extsSrc = lineAt('const VIDEO_EXTS =');
const ambSrc = lineAt('const VIDEO_EXTS_AMBIGUOUS');
/* ⚠️ 抠不出来的话下面全部静默跳过、文件照样报绿。先断言每一段都抠得出来。
   （改名/改写法把某个函数抠丢过一次，二十条断言凭空消失而文件还是绿的。） */
t('要跑的纯函数全都抠得出来（抠不出来下面的断言全是空跑）',
  !!pickSrc && !!stepSrc && !!notesSrc && !!fmtSrc && !!isVidSrc &&
  /maxFrames/.test(cfgSrc) && /VIDEO_EXTS/.test(extsSrc) && /'ts'/.test(ambSrc));

const CFG = new Function(cfgSrc + '; return VIDEO_CFG;')();
const pick = new Function(cfgSrc + pickSrc + '; return _vidPickTimes;')();
const nextStep = new Function(cfgSrc + stepSrc + '; return _vidProbeStep;')();
const notes = new Function(fmtSrc + notesSrc + '; return buildVideoNotes;')();
const isVid = new Function(extsSrc + ';' + ambSrc + isVidSrc + '; return isVideoFile;')();

const uniform = (dur, n) => Array.from({ length: n }, (_, i) => ({ t: dur * i / n, delta: 0 }));
const minGapOf = a => a.length < 2 ? Infinity : Math.min(...a.slice(1).map((v, i) => v - a[i]));

// 静止视频：没有任何场景峰值，也必须给够 minFrames，不能只剩开头一张
const still = pick(uniform(60, 120), 60);
t('静止视频也补满到 minFrames', still.length >= CFG.minFrames);
t('静止视频的帧是铺开的，不是全挤在开头', still[still.length - 1] > 60 * 0.5);

/* ⚠️ 这条是这个文件存在的主要理由。
   minGap 原本写死 0.7 秒。手持拍摄 / 走路这种全程都在动的素材，delta 到处
   不为零，排前几名的峰值完全可能挨在一起 —— 实测一段 3 分钟的片子，8 帧里
   5 帧挤在 1:24~1:32 这 8 秒内，前后各一分钟只各分到 1 张。不报错、画面也
   都是好的，只有把时间码列出来才看得见。 */
const busy = Array.from({ length: 220 }, (_, i) => ({
  t: i * 180 / 220,
  // 90~100 秒这一段 delta 特别高，够全部挤进 top-8
  delta: (i * 180 / 220 > 90 && i * 180 / 220 < 100) ? 0.9 : 0.2
}));
const busyPick = pick(busy, 180);
t('长视频的帧不会挤成一堆（间隔随时长放大）', minGapOf(busyPick) >= 180 / (CFG.maxFrames * 2) - 0.01);
/* 对照组：把已经删掉的老写法（间隔固定 0.7 秒）照原样跑一遍。
   没有这条的话，上面那句只证明「现在的实现满足一个数值下限」，
   却证明不了「这个下限真的挡住了什么」—— 换成任何一个宽松的规则它也照样绿。
   老规则已经不在源码里了，只能手写重现，这是这个文件里唯一手抄的逻辑。 */
const oldPick = (probes, duration) => {
  const picked = [0.06 * Math.min(duration, 1)];
  const far = t => picked.every(p => Math.abs(p - t) >= 0.7);   // ← 老写法：写死 0.7
  for (const p of probes.filter(p => p.delta >= CFG.sceneDelta).sort((a, b) => b.delta - a.delta)) {
    if (picked.length >= CFG.maxFrames) break;
    if (far(p.t)) picked.push(p.t);
  }
  return picked.sort((a, b) => a - b);
};
t('对照组：固定 0.7 秒的老写法确实挡不住这种堆叠', minGapOf(oldPick(busy, 180)) < 10);
t('短视频不受影响（8 秒的片子间隔下限还是 minGap）',
  minGapOf(pick(uniform(8, 16), 8)) >= CFG.minGap - 0.01);
t('帧数不超上限', busyPick.length <= CFG.maxFrames && still.length <= CFG.maxFrames);

/* ★ 时间轴覆盖：名额不能被前半段吃光。
   ⚠️ gap 只管相邻两帧别挨太近，管不了「8 个高 delta 点全落在前 90 秒」——
   那样完全满足 gap，而补帧那段又只在「候选不够 minFrames」时才启动（need = 0），
   于是一帧都不补：粗扫明明扫完了整段，模型却只看得见前半段，零报错。
   实测服务端那条路上同款问题：一段前 10 秒快剪的 60 秒视频，
   老代码给出的 8 帧是 [0, 0.8, 1, 2, 3, 4, 5, 6] —— 后 54 秒一眼没看。 */
const frontLoaded = Array.from({ length: 180 }, (_, i) => ({
  t: i,                                   // 180 秒，每秒一个采样点
  delta: (i < 90 && i % 12 === 0) ? 0.9 : 0.01   // 高变化点全在前 90 秒，且彼此隔得够远
}));
const flPick = pick(frontLoaded, 180);
t('★ 高变化点全在前半段时，仍然覆盖到后半段', flPick[flPick.length - 1] > 180 * 0.6);
t('★ 覆盖兜底没有把最小间隔破坏掉', minGapOf(flPick) >= 180 / (CFG.maxFrames * 2) - 0.01);
t('覆盖兜底不会超出片长', flPick.every(x => x >= 0 && x <= 180));
/* 对照组：把覆盖兜底那段从真源码里剪掉，其余一字不改。
   没有这条，上面那句只证明「现在覆盖得到」，证明不了是这段在起作用。 */
const pickNoCover = pickSrc.replace(/\n  const maxHole = [\s\S]*\n  \}\n(?=  return)/, '\n');
t('对照组真的剪掉了覆盖兜底（剪失败的话下面是空跑）',
  pickNoCover !== pickSrc && !/maxHole/.test(pickNoCover));
const oldPickFn = new Function(cfgSrc + pickNoCover + '; return _vidPickTimes;')();
t('★ 对照组：没有覆盖兜底时，后半段一帧都没有',
  oldPickFn(frontLoaded, 180).every(x => x < 180 * 0.6));
t('时间点是递增的（时间码要跟画面对得上）', busyPick.every((v, i, a) => i === 0 || v > a[i - 1]));
t('开头永远有一帧作为锚', busyPick[0] < 1 && still[0] < 1);

/* ⚠️ 极短视频。gap 有 0.7 秒的下限，而候选点本来就挨得近：3 秒的片子候选 0.75s
   离锚点 0.69s，差 0.01 秒被毙掉，只剩 2 帧；1 秒的片子干脆只剩锚点那 1 帧。
   minFrames 写着 3 却给不出 3，不报错，只是模型看到的东西少了一半。 */
[1, 2, 3, 5].forEach(d => {
  const p = pick(uniform(d, 8), d);
  t(`${d} 秒的视频也补得满 minFrames`, p.length >= CFG.minFrames);
  t(`${d} 秒的视频抽出来的时间点互不重复`, new Set(p.map(x => x.toFixed(2))).size === p.length);
  t(`${d} 秒的视频不会抽到片尾之外`, p.every(x => x >= 0 && x < d));
});

// ── 视频说明：必须在发送那一刻从真正要发的那批图里现推 ──────────
/* ⚠️ _pendingImgs 是公共的：普通图片、贴图、拍照、粘贴、拖拽都往里塞，
   用户还能挨个 × 掉单张（renderPendingImgs 里的 splice）。
   最早的写法是抽帧时就把「以下图片依次对应时间点：0:00 / 0:02 …」存好，
   下面三种情况全部错位，而且错得毫无征兆 —— 模型照样答，只是答的是另一秒的事。 */
const vf = (id, t, n) => ({ url: 'data:x', vidId: id, vidName: n || 'a.mp4', vidT: t, vidDur: 8, vidVia: '前端抽帧' });
const plain = () => ({ url: 'data:y', name: 'photo.jpg' });

t('没有视频帧时不产生说明（普通发图不该多出一句话）', notes([plain(), plain()]) === null);
t('空数组 / null 都不炸', notes([]) === null && notes(null) === null);

const mixed = notes([plain(), vf('v1', 0), vf('v1', 2), plain()]);
t('混了普通图片时，报的是下标而不是「依次对应」', mixed.length === 1 && /第 2、3 张图/.test(mixed[0]));
t('混了普通图片时不会把普通图算进视频', !/第 1、/.test(mixed[0]) && !/、4 /.test(mixed[0]));

const two = notes([vf('v1', 0), vf('v2', 0, 'b.mp4'), vf('v1', 5), vf('v2', 3, 'b.mp4')]);
t('两段视频各自成组，不会混成一段', two.length === 2);
t('两段视频各自报自己的下标', /第 1、3 张图/.test(two[0]) && /第 2、4 张图/.test(two[1]));
t('两段视频各自报自己的文件名', /a\.mp4/.test(two[0]) && /b\.mp4/.test(two[1]));

// 用户删掉中间一帧：剩下的帧下标要跟着变，时间码要跟着少
const afterDel = notes([vf('v1', 0), vf('v1', 4)]);
t('删掉中间一帧后，下标和时间码同步更新（不会整体错位）',
  /第 1、2 张图/.test(afterDel[0]) && /0:00 \/ 0:04/.test(afterDel[0]) && !/0:02/.test(afterDel[0]));

t('说明里带了时长', /时长 0:08/.test(afterDel[0]));

// ── 视频格式识别：MIME 靠不住 ──────────────────────────────────
/* ⚠️ Windows 和安卓 WebView 对 .mkv / .avi / .flv 常常给空 MIME，
   而这几个恰恰是浏览器解不了、最需要 ffmpeg 兜底的格式。只看 MIME 的话
   它们既进不了视频分支也进不了图片分支，被 return 悄悄吃掉：
   用户选了文件，界面上什么都没出现，控制台干干净净。 */
t('正常 MIME 认得出', isVid({ type: 'video/mp4', name: 'a.mp4' }));
t('空 MIME 的 .mkv 也认得出（这条是这段存在的理由）', isVid({ type: '', name: 'a.mkv' }));
t('空 MIME 的 .avi / .flv / .m2ts 也认得出',
  ['a.avi', 'a.flv', 'a.m2ts'].every(n => isVid({ type: '', name: n })));
t('大写扩展名也认得出', isVid({ type: '', name: 'A.MKV' }));
const oldIsVid = f => (f.type || '').startsWith('video/');   // ← 老判据
t('对照组：只看 MIME 的老判据确实漏掉空 MIME 的 .mkv',
  !oldIsVid({ type: '', name: 'a.mkv' }) && isVid({ type: '', name: 'a.mkv' }));
t('图片和文档不会被误判成视频',
  !isVid({ type: 'image/png', name: 'a.png' }) && !isVid({ type: '', name: 'a.docx' }) &&
  !isVid({ type: '', name: 'noext' }) && !isVid(null));

/* ★ `.ts` 是歧义扩展名：MPEG Transport Stream 和 TypeScript 源码共用它，
   而这个项目**本来就支持**把 .ts 源码拖进来当文本附件（12 里的 textExts 有它）。
   一律认成视频的话，拖一份源码进来会被送去抽帧、最后弹「这个视频读不了」——
   把一个本来好好的功能顺手弄坏了。 */
t('★ 拖拽入口不把 .ts 源码当视频（原本的文本附件功能不能被弄坏）',
  !isVid({ type: '', name: 'app.ts' }) && !isVid({ type: 'text/plain', name: 'app.ts' }) &&
  !isVid({ type: 'application/typescript', name: 'app.ts' }));
/* ★★ 关键的一条：**MIME 是 video/ 也不算**。
   File.type 是操作系统按扩展名猜的，没看过文件内容 —— 这台机器上
   `HKLM\SOFTWARE\Classes\.ts` 的 Content Type 实测就是 `video/vnd.dlna.mpeg-tts`
   （Windows Media Player 注册的）。所以拖一份 TypeScript 源码进来，浏览器报的
   MIME 本身就是 video/ 开头的；「MIME 明确是视频才当视频」这条规则在这里
   完全挡不住，源码照样被吞进抽帧。 */
t('★★ 拖拽 .ts 时 video/* 的 MIME 也不作数（系统按扩展名猜的，没看内容）',
  !isVid({ type: 'video/mp2t', name: 'app.ts' }) &&
  !isVid({ type: 'video/vnd.dlna.mpeg-tts', name: 'app.ts' }));
t('★ 文件选择框那条路仍然收 .ts（真的 MPEG-TS 从这儿进）',
  isVid({ type: 'video/mp2t', name: 'clip.ts' }, true));
// 歧义判断必须排在 MIME 之前，不然上面那条永远挡不住
t('歧义扩展名在看 MIME 之前就判掉了',
  isVidSrc.indexOf('VIDEO_EXTS_AMBIGUOUS') < isVidSrc.indexOf("startsWith('video/')"));
t('★ 文件选择框那条路（明确在选视频）接受空 MIME 的 .ts', isVid({ type: '', name: 'clip.ts' }, true));
t('12-math-media.js 的文本扩展名里确实有 ts（这条冲突不是假想的）',
  /textExts\s*=\s*\[[^\]]*'ts'/.test(media));
t('拖拽入口调 isVideoFile 时没开歧义开关', /isVideoFile\(file\)\s*\)/.test(media));
t('文件选择框入口开了歧义开关', /isVideoFile\(file, true\)/.test(input));
/* 对照组：回到「ts 混在主名单里、没有歧义处理」的老形态，其余一字不改。
   两处都要改回去 —— 只把 ts 放回主名单的话，歧义名单仍然会先把它拦下，
   对照组就成了空跑（这个坑当场踩到过）。 */
const oldExts = extsSrc.replace("'m2ts'", "'ts', 'm2ts'");
const oldAmb = 'const VIDEO_EXTS_AMBIGUOUS = [];';
const oldIsVid2 = new Function(oldExts + ';' + oldAmb + isVidSrc + '; return isVideoFile;')();
t('对照组真的回到了老形态（改失败的话下面是空跑）',
  oldExts !== extsSrc && /'ts'/.test(oldExts) && !/'ts'/.test(oldAmb));
t('对照组：老写法确实会把 .ts 源码当成视频（空 MIME）', oldIsVid2({ type: '', name: 'app.ts' }) === true);
t('★ 对照组：老写法在这台机器的真实 MIME 下也会吞掉 .ts 源码',
  oldIsVid2({ type: 'video/vnd.dlna.mpeg-tts', name: 'app.ts' }) === true);

// ── 形状约束：跑不出来但错了会静默 ──────────────────────────────
/* ⚠️ requestVideoFrameCallback 不能单用。它的语义是「有新帧**呈现**了」，
   而抽帧用的 <video> 从没进过 DOM、也不在播放，压根不参与合成 —— rVFC
   永远不回调。写成 `if (rVFC) 用它 else 用 rAF` 的时候，每次 seek 都要走满
   3 秒超时才继续：帧是对的（超时时画面早绘好了），所以肉眼零征兆，只是
   8 秒的片子跑 63 秒，3 分钟的片子在手机上就是几分钟的卡死。
   实测数据见 scratchpad/seekprobe.html。 */
const seekSrc = fnSrc('_vidSeek');
t('_vidSeek 抠得出来', !!seekSrc);
t('rVFC 和 rAF 是一起挂的，不是二选一（单用 rVFC 会每次 seek 都吃满超时）',
  /requestVideoFrameCallback\(/.test(seekSrc) &&
  /requestAnimationFrame\(/.test(seekSrc) &&
  !/else\s+requestAnimationFrame/.test(seekSrc));
t('seek 有超时兜底，不会把整个流程吊死', /setTimeout\(/.test(seekSrc) && /\},\s*3000\)/.test(seekSrc));
/* ⚠️ 超时不能无条件当成功。后台 WebView 里 rAF 是停的，这时 seek 若也没到位，
   调用方会把**上一帧**画进 canvas —— 几个不同时间点悄悄拿到同一张画面，
   时间码却各不相同，等于给模型编造事实。 */
t('超时前先验真的到位了（否则不同时间点会静默拿到同一张画面）',
  /video\.currentTime[\s\S]{0,80}readyState/.test(seekSrc) && /fail\(new Error/.test(seekSrc));

// ── 粗扫的自适应步长：真跑算术，不是看它长得对不对 ──────────────
/* ⚠️ 慢机器上前 6 个点就把 9 秒预算吃光时，「还能采几个点」算出来是 0 甚至负数。
   没有 probeMin 这个下限的话，step 会变成「剩下的整段」，下一轮 t 直接跳到片尾、
   循环结束 —— 三分钟的视频只扫了开头几秒就收工，关键帧全挤在开头，结尾等于没看见。
   零报错，只有把时间码列出来才看得见。 */
const stepAfter = (elapsed, step0 = 0.82, tNow = 5, dur = 180) => nextStep(step0, tNow, dur, elapsed, 6);
const samplesLeft = (step, tNow = 5, dur = 180) => Math.floor((dur - tNow) / step);
// 6 个点才 60ms（每点 10ms），剩下 213 个点约 2.1 秒，远在 9 秒预算内 → 不该动
t('预算充裕时不动步长', stepAfter(60) === 0.82);
t('预算吃紧时拉大步长（而不是砍掉后半段）', stepAfter(6000) > 0.82);
t('预算已经爆掉时，剩下的片长仍然至少再采 probeMin 个点',
  samplesLeft(stepAfter(99999)) >= CFG.probeMin - 1);
/* 对照组：没有 probeMin 下限的老写法（Math.max(1, afford)），
   预算爆掉时只会再采 1 个点 —— 换句话说后半段整个消失。
   没有这条，上面那句证明不了这个下限真的挡住了什么。 */
const oldStep = (step, tNow, dur, elapsed, count) => {
  const per = elapsed / count, left = CFG.probeBudgetMs - elapsed;
  const afford = Math.max(1, Math.floor(left / Math.max(1, per)));
  return afford < (dur - tNow) / step ? Math.max(step, (dur - tNow) / afford) : step;
};
t('对照组：没有下限的老写法确实会把后半段整个跳过',
  samplesLeft(oldStep(0.82, 5, 180, 99999, 6)) <= 1);
t('步长永远是有限正数（不会变 0 / NaN 把循环卡死）',
  [0.1, 1, 60].every(d => [0, 1, 9000, 1e9].every(e => {
    const s = nextStep(0.5, 0, d, e, 6);
    return isFinite(s) && s > 0;
  })));

/* ── 粗扫遇到孤立的 seek 失败：要跳过去，不能就地收摊 ──────────
   ⚠️ 这条守的是一个自相矛盾：整套设计的前提是「宁可扫得粗，也要扫完整段」
   （见 probeMin 那几条），可 seek 失败一次就 break 的话，前段变化大的素材
   已经攒够 8 个候选、_vidPickTimes 认为不用补帧了 —— 三分钟的视频模型只看得到
   开头，后面两分多钟凭空消失，零报错。 */
const probeSrc = fnSrcA('_vidProbe');
t('_vidProbe 抠得出来（抠不出来下面几条是空跑）', !!probeSrc && /^async /.test(probeSrc));
function makeProbe(failAt, srcOverride) {
  /* ⚠️ 桩的画面必须**随时间不同**。全返回同一张的话 delta 恒为 0，
     「跨过洞之后 delta 重新起算」那条断言就算删掉 prev = null 也照样绿 ——
     那是给自己发的空断言。所以按 seek 到的时间点生成不同像素值。 */
  const pre = `
    let curT = 0;
    const document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => {
        const d = new Uint8Array(w * h * 4);
        d.fill(Math.round(curT * 7) % 200 + 20);   // 每个时间点一个亮度
        return { data: d };
      }
    }) }) };
    const performance = { now: () => 0 };
    const _vidSeek = async (v, t) => {
      if (${JSON.stringify(failAt)}.some(x => Math.abs(x - t) < 1e-6)) throw new Error('seek 失败');
      curT = t;
    };
  `;
  return new Function(pre + cfgSrc + stepSrc + (srcOverride || probeSrc) + '; return _vidProbe;')();
}
const fakeVideo = { videoWidth: 640, videoHeight: 360 };
/* 这几条是异步的，交给文件末尾那个主流程 await —— 自己起一个 IIFE 的话，
   它和打印总结的那个 IIFE 谁先跑完没有保证，计数会漏。 */
const probeChecks = (async () => {
  const full = await makeProbe([])(fakeVideo, 60);
  t('粗扫正常时扫到接近片尾', full.length > 5 && full[full.length - 1].t > 60 * 0.9);
  // 第 3 个采样点失败（孤立一次）：后面照样要扫完
  const hole = await makeProbe([full[2].t])(fakeVideo, 60);
  t('★ 中间孤立失败一次，仍然扫完整段（不是扫到一半收摊）',
    hole[hole.length - 1].t > 60 * 0.9 && hole.length >= full.length - 1);
  t('★ 失败的那个点不会被当成一次采样混进结果',
    !hole.some(p => Math.abs(p.t - full[2].t) < 1e-6));
  /* 洞另一边的第一个点不能拿洞**之前**的帧算变化量 —— 隔了两个步长的两帧
     差得更多，会平白造出一个假峰值，把名额骗到一个其实没发生什么的位置上。
     桩的画面随时间变，所以正常相邻点的 delta > 0，而跨洞那一点必须是 0。 */
  const holeIdx = hole.findIndex(p => p.t > full[2].t);
  t('相邻点的 delta 确实不为零（桩画面随时间变，否则下面那条是空跑）',
    hole.slice(1, holeIdx).every(p => p.delta > 0));
  t('★ 跨过洞之后 delta 重新起算（不拿洞另一边的帧比）',
    holeIdx > 0 && hole[holeIdx].delta === 0);
  const oldHoleProbe = probeSrc.replace('prev = null;   // 跨过一个洞，下一点不能拿洞另一边的帧算变化量', '');
  t('对照组真的剪掉了 prev = null（剪失败的话下面是空跑）', oldHoleProbe !== probeSrc);
  const noReset = await makeProbe([full[2].t], oldHoleProbe)(fakeVideo, 60);
  const noResetIdx = noReset.findIndex(p => p.t > full[2].t);
  t('★ 对照组：不重置的话跨洞那点会造出一个假的变化量',
    noResetIdx > 0 && noReset[noResetIdx].delta > 0);
  // 连续失败到阈值：解码器是真的废了，要抛出去让服务端 ffmpeg 接手
  const dead = makeProbe(full.slice(1, 8).map(p => p.t));
  let threw = false;
  try { await dead(fakeVideo, 60); } catch { threw = true; }
  t('★ 连续多点失败时抛错（好让外面转服务端，也免得每点白等 3 秒超时）', threw);
  const oneMiss = await makeProbe([full[1].t])(fakeVideo, 60);
  t('只失败一次绝不抛错', oneMiss.length > 5);

  /* 对照组：把「跳过去继续」换回原来的 `catch { break; }`，其余一字不改。
     没有这条，上面那句只证明「现在扫得完整段」，证明不了这个改动挡住了什么。 */
  const oldProbe = probeSrc.replace(
    /try \{ await _vidSeek\(video, t\); miss = 0; \}[\s\S]*?\n    \}/,
    'try { await _vidSeek(video, t); } catch { break; }');
  // （`let prev = null, miss = 0` 那行不在替换范围里，留着无害，别拿它当判据）
  t('对照组真的换回了 break（换失败的话下面是空跑）',
    oldProbe !== probeSrc && /catch \{ break; \}/.test(oldProbe) && !/continue;/.test(oldProbe));
  const oldHole = await makeProbe([full[2].t], oldProbe)(fakeVideo, 60);
  t('★ 对照组：老写法失败一次就收摊，后面整段都没扫到',
    oldHole.length === 2 && oldHole[oldHole.length - 1].t < 60 * 0.2);
});

// ── 接线：漏一处功能就整个不在，且零报错 ────────────────────────
t('index.html 挂了 30-video.js', /js\/30-video\.js/.test(html));
t('文件选择框收视频', /id="imgFileInput"[^>]*accept="[^"]*video\/\*/.test(html));
// 系统认不出 MIME 时，只写 video/* 会让 .mkv/.avi 在文件选择框里直接是灰的，
// 用户根本选不中 —— 看起来就像"不支持这个格式"，其实是兜底路径没机会跑
t('accept 里显式列了 .mkv / .avi（不然系统会把它们灰掉）',
  /id="imgFileInput"[^>]*accept="[^"]*\.mkv[^"]*\.avi/.test(html));

t('handleImgUpload 走 isVideoFile 而不是 file.type', /isVideoFile\(file, true\)[\s\S]{0,120}addVideoFile/.test(input));
// 拖拽是另一条独立入口，不接的话拖个视频进去毫无反应
t('拖拽进来的视频也走抽帧', /isVideoFile\(file\)[\s\S]{0,80}addVideoFile\(file\)/.test(media));

/* 时间码只能靠这条文字送到模型手里：帧走的是 m.images，那条链路只取 img.url，
   name 根本不发。漏了的话模型看到的是几张没先后、没间隔的散图。 */
t('videoNote 在发送那一刻从 _pendingImgs 现推（不是抽帧时写死）',
  /videoNote:\s*\(typeof buildVideoNotes === 'function' \? buildVideoNotes\(_pendingImgs\)/.test(api));
t('视频说明排在所有帧**前面**（模型顺着读，先知道这是一段时间序列）',
  /videoNote[\s\S]{0,80}parts\.unshift/.test(api));
// 说明既然是现推的，就不该再留一份会跟数组失同步的快照
t('没有残留的 _pendingVideoNotes 快照', !/_pendingVideoNotes/.test(api) && !/_pendingVideoNotes/.test(src));

// ── 服务端 ffmpeg 兜底 ─────────────────────────────────────────
t('服务端 ffmpeg 兜底路由在', /\/api\/video-frames/.test(server));
t('ffmpeg 没装时给的是人话不是堆栈', /ENOENT[\s\S]{0,200}ffmpeg/i.test(server));
const route = server.slice(server.indexOf("app.post('/api/video-frames'"), server.indexOf("app.post('/api/sticker-save-url'"));
t('兜底路由抠得出来（抠不出来下面三条是空跑）', route.length > 500);
/* 这是常驻进程，子进程漏一个就漏到重启为止。客户端 abort 只是不再等 HTTP，
   服务端的 ffmpeg 照跑、临时目录照占；坏文件让它卡死的话连 cleanup 都轮不到。 */
t('ffmpeg 子进程有超时', /setTimeout\([\s\S]{0,60}kill\(\)/.test(route));
t('客户端断开时杀掉子进程并清临时目录',
  /req\.on\('aborted'/.test(route) && /res\.on\('close'/.test(route) && /kill\(\)[\s\S]{0,40}cleanup\(\)/.test(route));
/* 静止素材（访谈 / 监控 / 屏幕录像）画面变化低于 0.25，scene 那趟只吐得出开头一帧。
   前端有均匀补帧，服务端不补的话同一个功能在两条路上能力不一样，用户还看不出
   自己走的是哪条。 */
t('静止视频有均匀补帧兜底（否则三分钟的访谈只给一帧）', /fps=\$\{/.test(route) && /picked\.length < 3/.test(route));
/* ★ 服务端同款「名额被片头吃光」：`-frames:v` 是凑够就停，不是扫完再挑。
   实测一段前 10 秒快剪、后 50 秒正片的 60 秒视频：
   老代码给的 8 帧是 [0, 0.8, 1, 2, 3, 4, 5, 6]，后 54 秒一眼没看；
   改后是 [0, 4, 10, 20, 30, 40, 50]。 */
t('★ 服务端也判「帧全挤在前面」，不是只判帧数少',
  /frontLoaded\s*=\s*duration > 8 && lastT < duration \* 0\.6/.test(route) &&
  /picked\.length < 3 \|\| frontLoaded/.test(route));
/* 补的时候锚点必须**优先占位**：反过来的话名额早被前段的场景帧占满，
   锚点一个也进不来，等于没补。 */
t('★ 均匀锚点优先占位，场景帧再填余额',
  /const out = anchors\.slice\(0, max\)/.test(route) &&
  /for \(const p of picked\)[\s\S]{0,200}out\.push\(p\)/.test(route));
// 文件名和时间码靠下标对应，拆散排序前必须先配对，否则时间码整体错位
t('文件名和时间码先配对再排序（不然一排序就错位）',
  /const pair = \(fl, tl\)/.test(route) && /picked\.sort\(\(a, b\) => a\.t - b\.t\)/.test(route));

/* ⚠️ 超时清理的时序：kill() 之后不能当场 reject。
   当场 reject 的话外层 catch 立刻 rmSync，而这一刻被杀的 ffmpeg 在 Windows 上
   往往还攥着输入文件的句柄 —— 删除抛 EPERM 被 catch 吞掉；等 close 真的到了，
   它只会去 settle 一个已经 settle 的 Promise，不会再清一次。gc-vid-* 就永久
   留在 %TEMP% 里，零报错，而且这是常驻进程，漏一次漏到重启。 */
t('超时时先 kill 再等 close，不当场 reject',
  /timedOut = true;[\s\S]{0,80}kill\(\)/.test(route) &&
  !/kill\(\);\s*reject\(/.test(route));
t('close 到了才按超时 reject（这才是真的删得掉的时刻）',
  /on\('close'[\s\S]{0,120}timedOut[\s\S]{0,80}reject/.test(route));
t('进程僵死不退出时仍有二级兜底，请求不会被吊死',
  /hardTimer\s*=\s*setTimeout/.test(route));
t('settle 只认第一次（超时和 close 撞车不会重复 settle）', /settled\s*=\s*true/.test(route));
// Windows 上句柄释放有延迟，rmSync 不带重试就是概率性泄漏
t('临时目录删除带重试（Windows 句柄释放有延迟）',
  /rmSync\([\s\S]{0,80}maxRetries/.test(route));
// 这个头是客户端给的，畸形的 % 会让 decodeURIComponent 抛 URIError
t('x-filename 解不开时退回默认名，不让整个请求挂掉',
  /try \{[^}]*decodeURIComponent\(String\(req\.headers\['x-filename'\]/.test(route));

// ── 发送屏障：抽帧没完成时不许把消息发出去 ──────────────────────
/* ⚠️ 抽帧是异步的（三分钟的片子、或走服务端 ffmpeg 时能到几十秒）。用户选完视频
   顺手按回车，handleSend 快照到的 _pendingImgs 里还没有帧 —— 文字先发出去了，
   帧几秒后才落到输入区，滞留成下一条消息的附件。零报错，用户视角是「我明明选了
   视频，它没跟着发出去」。 */
t('handleSend 里有视频抽帧的屏障', /videoBusyCount\(\)\s*>\s*0/.test(api));
/* ⚠️ 屏障还必须排在「空消息就 return」的前面。**只选了视频、一个字没打**的时候
   _pendingImgs 还是空的，那行会先把这次发送吃掉 —— 用户按了回车，界面上什么都
   没有，连「还在抽帧」都看不到。而这恰恰是这个功能最常见的用法。 */
t('★ 屏障排在「空消息就 return」前面（只选视频不打字是最常见的用法）',
  api.indexOf('videoBusyCount()') > 0 &&
  api.indexOf("if (!text && !_pendingImgs.length") > 0 &&
  api.indexOf('videoBusyCount()') < api.indexOf("if (!text && !_pendingImgs.length"));
/* 屏障必须排在 popTypingNote() 前面：那个会结算并清掉打字节奏，
   排在它后面的话，被挡下的这一次就把用户的输入节奏白白吃掉了。 */
/* ⚠️ 锚到真正的调用点，不能锚 'popTypingNote()' 这个裸名字 ——
   上面那段解释屏障的注释里就写着它，indexOf 会命中注释，断言恒假。 */
t('屏障排在 popTypingNote 前面（否则被挡下的这次会白吃掉打字节奏）',
  api.indexOf('videoBusyCount()') > 0 &&
  api.indexOf('popTypingNote(); } catch') > 0 &&
  api.indexOf('videoBusyCount()') < api.indexOf('popTypingNote(); } catch'));
t('被挡下时有提示，不是静默什么都不发生',
  /videoBusyCount\(\)\s*>\s*0[\s\S]{0,160}showToast/.test(api));

/* ⚠️ 清理的生命周期必须跟**子进程**走，不跟 Promise 走。
   kill() 只代表信号发出去了；Windows 上这一刻 ffmpeg 还攥着输入文件的句柄，
   而超时 / 客户端断开这两条路上 HTTP 早就结束了，没人会再来删第二次。 */
t('还有活着的子进程时不当场删，只记账', /wantCleanup = true;[\s\S]{0,120}if \(live > 0\) return/.test(route));
t('子进程 close 时销账并补删（独立于 Promise 的 settle）',
  /me\.on\('close', \(\) => \{[\s\S]{0,220}live = Math\.max\(0, live - 1\)[\s\S]{0,80}if \(wantCleanup\) cleanup\(\)/.test(route));
/* ⚠️ 销账只能挂 'close'，不能顺手把 'error' 也挂上。
   'error' 是「这个子进程出事了」，不是「它退出了」——kill 送不到时也会 emit error，
   而那时进程活得好好的还攥着 in.mp4。在 error 上销账 = 提前宣布「可以删了」，
   删失败被吞掉，幂等标志又已经翻掉，真正的 close 到了也不再补删。
   （spawn 失败会不会没有 close？实测 node v24：`error:ENOENT -> close:-4058`，照样来。） */
t('★ 销账只挂 close，没有挂到 error 上（error ≠ 进程已退出）',
  !/on\('error',\s*drop\)/.test(route) && !/'error',\s*\(\)\s*=>\s*\{\s*if \(!counted\)/.test(route));
t('销账是幂等的', /if \(!counted\) return;[\s\S]{0,60}counted = false/.test(route));
/* 进程僵着没死时还得能再补一刀，所以 kill 里不能有 killed 这道闸。
   ⚠️ 锚到老写法本身，不能写 !/child\.killed/ —— 解释这件事的注释里就有这个词，
   断言会命中注释恒假（本文件里已经踩过一次同样的坑）。 */
t('kill 里没有 killed 那道闸（僵死进程要能补刀）', !/if \(child && !child\.killed\)/.test(route));

// ── 行为测试：把路由 handler 真跑起来验清理时序 ────────────────
/* 上面那几条正则只能证明「代码长得对」。真正要守的是**时序**：
   断开的那一刻不能删（删了也失败），进程 close 之后必须删。
   所以把真 handler 抠出来，注入假的 fs / spawn 跑一遍。 */
function balanced(s, from) {
  let i = s.indexOf('{', from), d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(from, j + 1);
  }
  return null;
}
const hAt = route.indexOf('async (req, res) => {');
const handlerSrc = hAt < 0 ? null : balanced(route, hAt);
t('路由 handler 抠得出来（抠不出来下面全是空跑）', !!handlerSrc && handlerSrc.length > 800);

const { EventEmitter } = require('events');
function runRoute(srcOverride) {
  const log = { rm: 0, kills: 0, spawned: [] };
  const fsStub = {
    mkdtempSync: () => 'X:/fake-gc-vid',
    writeFileSync: () => {},
    readdirSync: () => ['a_001.jpg'],
    readFileSync: () => Buffer.from([0xff, 0xd8, 0xff]),
    rmSync: () => { log.rm++; }
  };
  const spawnStub = () => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { log.kills++; c.killed = true; };
    log.spawned.push(c);
    return c;
  };
  /* 假定时器：150 秒超时和它后面 5 秒的二级兜底，真等是等不起的。
     注入之后这两条路才测得到 —— 而它们恰恰是最难人工复现、最容易埋雷的两条。 */
  const timers = [];
  const setTimeoutStub = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; };
  const clearTimeoutStub = h => { if (h) h.cleared = true; };
  const handler = new Function('fs', 'path', 'spawn', 'require', 'console', 'setTimeout', 'clearTimeout',
    'return ' + (srcOverride || handlerSrc))(fsStub, require('path'), spawnStub, require, console,
      setTimeoutStub, clearTimeoutStub);
  log.timers = timers;
  log.pending = ms => timers.filter(x => x.ms === ms && !x.cleared);
  log.fire = ms => {
    const h = timers.filter(x => x.ms === ms && !x.cleared).pop();
    if (!h) return false;
    h.cleared = true; h.fn(); return true;
  };
  const req = new EventEmitter();
  req.body = Buffer.from('fakevideo');
  req.query = { max: '4', w: '768' };
  req.headers = {};
  const res = new EventEmitter();
  res.writableFinished = false;
  res.statusCode = 0;
  res.status = c => { res.statusCode = c; return res; };
  res.json = j => { res.body = j; res.writableFinished = true; return res; };
  const done = handler(req, res);
  return { log, req, res, done, child: () => log.spawned[log.spawned.length - 1] };
}
const tick = () => new Promise(r => setImmediate(r));
/* fnSrc 抠的是 `function X(`，async 的前缀在它前面，直接 slice 会把 async 丢掉。 */
function fnSrcA(name) {
  const s = fnSrc(name);
  if (!s) return null;
  const at = src.indexOf(s);
  return src.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' + s : s;
}
const addSrc = fnSrcA('addVideoFile');
const innerSrc = fnSrcA('_addVideoFileInner');
const busyDecl = (src.match(/let _vidBusy = 0;/) || [''])[0];
const busyFnSrc = fnSrc('videoBusyCount');
t('addVideoFile / _addVideoFileInner / _vidBusy 都抠得出来（抠不出来下面全是空跑）',
  !!addSrc && !!innerSrc && !!busyDecl && !!busyFnSrc && /^async /.test(innerSrc));

/* 把真源码塞进一个注了桩的作用域里跑。桩只替换「需要浏览器」的那几个函数
   （_vidLoadMeta / _vidProbe / _vidGrab / _vidServerExtract），被测的控制流
   ——什么时候转服务端、计数怎么加减——用的都是真代码。 */
function makeSandbox({ grab, server, loadMeta, inner }) {
  const pre = `
    let _pendingImgs = [];
    const toasts = [];
    let serverCalls = 0;
    function showToast(m, k) { toasts.push({ m: String(m), k }); }
    function renderPendingImgs() {}
    /* 真实的 addPendingImg（js/09-appearance-input.js）要解码一次图片拿尺寸 —— 是异步的。
       这里的延迟**故意反着来**：越靠后的帧解得越快。并发 push 的话帧序必乱，
       只有串行 await 才稳得住。抽帧顺序一乱，时间码就和画面对不上，
       而模型照样会答 —— 只是答的是另一秒的事（零征兆）。 */
    async function addPendingImg(o) {
      const n = _pendingImgs.length;
      await new Promise(r => setTimeout(r, Math.max(0, 20 - n * 7)));
      _pendingImgs.push({ ...o, w: 768, h: 432 });
      renderPendingImgs();
    }
    const URL = { revokeObjectURL() {}, createObjectURL() { return 'blob:x'; } };
    const _vidLoadMeta = ${loadMeta || `(() => Promise.resolve({ video: { duration: 8, src: '' }, url: 'blob:x' }))`};
    const _vidProbe = (() => Promise.resolve([]));
    const _vidPickTimes = (() => [0, 2]);
    const _vidGrab = ${grab};
    const _vidServerExtract = (async (...a) => { serverCalls++; return (${server})(...a); });
  `;
  const post = `; return {
    addVideoFile, videoBusyCount,
    get imgs() { return _pendingImgs; },
    get toasts() { return toasts; },
    get serverCalls() { return serverCalls; }
  };`;
  return new Function(pre + cfgSrc + fmtSrc + busyDecl + busyFnSrc + (inner || innerSrc) + addSrc + post)();
}
const okServer = `(async () => ({ frames: [{ t: 0, url: 'data:srv0' }, { t: 3, url: 'data:srv3' }], duration: 9 }))`;
const grabEmpty = `(async () => [])`;
const grabOk = `(async () => [{ t: 0, url: 'data:fe0' }, { t: 2, url: 'data:fe2' }])`;
const file = { size: 1000, name: 'a.mkv', type: '' };

(async () => {
  await probeChecks();   // 粗扫那几条也是异步的，先跑完再往下

  /* ★ 本轮的核心那条：前端抽出 0 帧时必须转服务端。
     _vidProbe 里 seek 失败是 break、_vidGrab 里是 continue —— 两个都不抛，
     于是「容器能读出 metadata、画面却解不出来」的素材会一路拿到空数组，
     catch 根本不执行，用户只看到「没能抽出画面」。而这恰恰是 ffmpeg 该接手的。 */
  const s1 = makeSandbox({ grab: grabEmpty, server: okServer });
  await s1.addVideoFile(file);
  t('★ 前端抽出 0 帧时转服务端 ffmpeg 兜底', s1.serverCalls === 1);
  t('★ 兜底抽到的帧真的进了 _pendingImgs', s1.imgs.length === 2 && s1.imgs[0].url === 'data:srv0');
  t('★ 兜底的帧标了 ffmpeg 来源和服务端给的时长',
    s1.imgs.every(i => i.vidVia === 'ffmpeg' && i.vidDur === 9));
  t('★ 兜底成功不报错', !s1.toasts.some(x => x.k === 'error'));

  /* 对照组：把那句 throw 从真源码里剪掉，其余一字不改。
     没有这条的话，上面四条只证明「现在的实现会转服务端」，
     却证明不了「是那句 throw 在起作用」—— 换个写法它们也可能照样绿。 */
  const oldInner = innerSrc.replace(/if \(!frames\.length\) throw new Error\([^)]*\);/, '');
  t('对照组的老写法真的剪掉了那句 throw', oldInner.length < innerSrc.length);
  const s2 = makeSandbox({ grab: grabEmpty, server: okServer, inner: oldInner });
  await s2.addVideoFile(file);
  t('对照组：不抛的老写法确实一次服务端都不试', s2.serverCalls === 0 && s2.imgs.length === 0);

  // 前端正常出帧时不该去打扰服务器
  const s3 = makeSandbox({ grab: grabOk, server: okServer });
  await s3.addVideoFile(file);
  t('前端抽得出来时不走服务端', s3.serverCalls === 0 && s3.imgs.length === 2);
  t('前端抽的帧带时间码和视频名', s3.imgs[0].vidT === 0 && s3.imgs[1].vidT === 2 && s3.imgs[0].vidName === 'a.mkv');
  t('同一段视频的帧共用一个 vidId', s3.imgs[0].vidId && s3.imgs[0].vidId === s3.imgs[1].vidId);
  /* ★ 帧序必须严格按时间递增（2026-08-19）。addPendingImg 变成异步之后，
     forEach 里并发 push 就会按「谁先解码完」排序而不是按时间 —— 上面那个 mock
     故意让后面的帧解得更快，正是为了把这种乱序逼出来。
     乱序的后果：buildVideoNotes 按数组顺序现推时间码，说明和画面全部错位，
     而模型照样答得头头是道，只是答的是另一秒的事。 */
  t('★ 帧按时间顺序进 _pendingImgs（异步缩放不许打乱顺序）',
    s3.imgs.every((im, i) => i === 0 || im.vidT > s3.imgs[i - 1].vidT),
    JSON.stringify(s3.imgs.map(i => i.vidT)));
  const s3b = makeSandbox({
    grab: `(async () => [{t:0,url:'d0'},{t:1,url:'d1'},{t:2,url:'d2'},{t:3,url:'d3'},{t:4,url:'d4'}])`,
    server: okServer });
  await s3b.addVideoFile(file);
  t('★ 五帧也不乱（帧越多越容易被并发打乱）',
    s3b.imgs.map(i => i.vidT).join(',') === '0,1,2,3,4',
    s3b.imgs.map(i => i.vidT).join(','));
  t('★ 缩放后的尺寸落在帧上（预算才算得准）',
    s3b.imgs.every(i => i.w === 768 && i.h === 432));

  // 两条路都失败：要报人话，且不能往 _pendingImgs 里塞半截东西
  const s4 = makeSandbox({ grab: grabEmpty, server: `(async () => { throw new Error('连不上'); })` });
  await s4.addVideoFile(file);
  t('前端和服务端都失败时报人话', s4.imgs.length === 0 && s4.toasts.some(x => x.k === 'error' && /连不上/.test(x.m)));

  /* ★ 计数：抽帧期间必须 > 0，否则发送屏障形同虚设；
     结束后必须归 0，否则发送被永久挡死（同样零报错）。 */
  let release;
  const gate = new Promise(r => { release = r; });
  global.__gate = gate;
  const s5 = makeSandbox({
    grab: grabOk, server: okServer,
    loadMeta: `(async () => { await global.__gate; return { video: { duration: 8, src: '' }, url: 'blob:x' }; })`
  });
  t('闲着的时候计数是 0', s5.videoBusyCount() === 0);
  const p5 = s5.addVideoFile(file);
  t('★ 抽帧进行中计数 > 0（发送屏障靠它）', s5.videoBusyCount() === 1);
  release();
  await p5;
  t('★ 抽帧结束后计数归 0', s5.videoBusyCount() === 0);

  // 失败路径也必须归零 —— 上面每条失败路径都是 return 不是 throw，漏一条就永久挡死发送
  t('两条路都失败后计数也归 0（否则发送被永久挡死）', s4.videoBusyCount() === 0);
  const s6 = makeSandbox({ grab: `(async () => { throw new Error('炸了'); })`, server: okServer });
  await s6.addVideoFile(file);
  t('前端抛异常后计数也归 0', s6.videoBusyCount() === 0);
  const s7 = makeSandbox({ grab: grabOk, server: okServer });
  await s7.addVideoFile({ size: 999 * 1024 * 1024 * 1024, name: 'big.mp4', type: 'video/mp4' });
  t('超大文件被挡下后计数也是 0', s7.videoBusyCount() === 0 && s7.imgs.length === 0);

  // 两段视频并发：各自成组，计数正确加减
  const s8 = makeSandbox({ grab: grabOk, server: okServer });
  await Promise.all([s8.addVideoFile({ size: 10, name: 'x.mp4', type: 'video/mp4' }),
                     s8.addVideoFile({ size: 10, name: 'y.mp4', type: 'video/mp4' })]);
  t('两段视频并发处理后计数归 0', s8.videoBusyCount() === 0);
  t('两段视频的帧都在，且分属两个 vidId',
    s8.imgs.length === 4 && new Set(s8.imgs.map(i => i.vidId)).size === 2);

  // ── 服务端清理时序（Codex 两轮都指着这里）────────────────────
  if (handlerSrc) {
    // 正常一趟：close 到了才删，最后帧要发出去
    const a = runRoute();
    await tick();
    a.child().emit('close', 0);
    await a.done;
    t('正常一趟：帧发出去了', a.res.body && a.res.body.frames && a.res.body.frames.length === 1);
    t('正常一趟：临时目录删掉了', a.log.rm >= 1);

    /* ★ 客户端断开：这一刻 ffmpeg 还没退出，删必失败。
       旧写法在这里同步 rmSync 一次就再也不管了 —— 删失败被 catch 吞掉，
       gc-vid-* 永久留在 %TEMP% 里，零报错，而且这是常驻进程，漏一次漏到重启。 */
    const b = runRoute();
    await tick();
    b.res.writableFinished = false;
    b.res.emit('close');                      // 客户端断开
    t('★ 断开时杀了子进程', b.log.kills >= 1);
    t('★ 断开的那一刻不删（进程还攥着句柄，删了也失败）', b.log.rm === 0);
    b.child().emit('close', null);            // 进程真的退出了
    await tick();
    t('★ 进程真的退出之后才补删', b.log.rm >= 1);

    /* 对照组：把 cleanup 换回「不记账、当场删」的老写法，其余一字不改。
       没有这条的话，上面三句只证明「现在的实现是这个时序」，却证明不了
       这个时序真的换掉了什么 —— 那是给自己发的空断言。 */
    const oldCleanup = 'const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} };';
    // ⚠️ 缩进不固定写死：这段现在嵌在 server/media.js 的 mount() 里，比搬迁前多缩进
    // 一层，cleanup 闭合的 `};` 前面空格数会变——用 \s* 认缩进，不认具体几个空格。
    const oldHandler = handlerSrc.replace(/const cleanup = \(\) => \{[\s\S]*?\n\s*\};/, oldCleanup);
    t('对照组真的换掉了 cleanup（换失败的话下面是空跑）',
      oldHandler !== handlerSrc && oldHandler.includes(oldCleanup));
    const b2 = runRoute(oldHandler);
    await tick();
    b2.res.writableFinished = false;
    b2.res.emit('close');
    /* 就是这一下：老写法在**进程还活着**的时刻就去 rmSync 了。真实环境里这一次
       必然失败（Windows 句柄还占着），失败又被 catch 吞掉，然后再没人管。
       新写法在同一时刻是 0 次，把删除推到进程真的退出之后。 */
    t('★ 对照组：老写法在断开的那一刻就去删了（新写法这时是 0 次）',
      b2.log.rm === 1 && b.log.kills >= 1);
    // 让它走完，否则那个 150 秒的超时定时器会一直吊着 node 不退出
    b2.child().emit('close', null);
    await b2.done;

    /* ffmpeg 没装：spawn 阶段失败。桩要照真实生命周期来 —— 实测 node v24 是
       `error:ENOENT -> close:-4058/null`，两个都发。桩只发 error 的话，
       测的就是一个现实里不存在的时序，反而会诱导代码去 error 上销账。 */
    const c = runRoute();
    await tick();
    const e = new Error('spawn ffmpeg ENOENT'); e.code = 'ENOENT';
    c.child().emit('error', e);
    c.child().emit('close', -4058, null);
    await c.done;
    t('★ ffmpeg 没装时也删得掉临时目录', c.log.rm >= 1);
    t('ffmpeg 没装时回的是人话', c.res.statusCode === 500 && /ffmpeg/i.test(String(c.res.body && c.res.body.error)));

    /* ★ kill 送不到时 Node 也会 emit 'error'，而那一刻进程还活着。
       这一条守的就是「不能把 error 当成退出」：error 之后、close 之前，
       临时目录一次都不能删。 */
    const d = runRoute();
    await tick();
    d.res.writableFinished = false;
    d.res.emit('close');                                   // 客户端断开 → 想删
    d.child().emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    await tick();
    t('★ 子进程 error（进程可能还活着）时不删', d.log.rm === 0);
    d.child().emit('close', null, 'SIGKILL');              // 进程这才真的没了
    await tick();
    t('★ 等到真的 close 了才删', d.log.rm >= 1);

    // ── 150 秒超时 + 二级兜底：真等等不起，靠注入的假定时器走这两条路 ──
    /* 正常超时：kill 之后要等 close 才 reject（当场 reject 的话外层 catch
       会在进程还攥着句柄时去删，删不掉且之后没人补） */
    const e1 = runRoute();
    await tick();
    t('150 秒超时定时器挂上了', e1.log.pending(150000).length === 1);
    e1.log.fire(150000);
    t('★ 超时先 kill', e1.log.kills === 1);
    t('★ 超时当场不 reject、不删（等 close）', e1.log.rm === 0 && e1.res.statusCode === 0);
    t('★ 超时后挂上了 5 秒二级兜底', e1.log.pending(5000).length === 1);
    e1.child().emit('close', null, 'SIGKILL');
    await e1.done;
    t('★ close 到了才 reject 并清干净', e1.log.rm >= 1 && e1.res.statusCode === 500);
    t('★ 进程退出后二级兜底被撤掉（不留空转定时器）', e1.log.pending(5000).length === 0);

    /* ★ Codex 第五轮指的那条：kill 送不到时 Node 也会 emit 'error'。
       那一刻进程还活着，如果 error 顺手把二级兜底清了，僵死进程就彻底没人管了。 */
    const e2 = runRoute();
    await tick();
    e2.log.fire(150000);
    e2.child().emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    await tick();
    t('★★ kill 失败的 error 不会撤掉二级兜底（这轮 Codex 指的就是这里）',
      e2.log.pending(5000).length === 1);
    t('error 已经让 HTTP 那边收场了，不吊死', e2.res.statusCode === 500);
    const killsBefore = e2.log.kills;
    e2.log.fire(5000);
    t('★ 二级兜底到点后再补一刀 kill', e2.log.kills === killsBefore + 1);
    t('★ 二级兜底到点后强行删一次（等不到 close 了，至少试过）', e2.log.rm >= 1);

    /* 对照组：把 once 换回「顺手连 hardTimer 一起清」的写法，其余一字不改。
       没有这条，上面那句只证明「现在的实现留着定时器」，证明不了它挡住了什么。 */
    const newOnce = 'const once = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };';
    const oldOnce = 'const once = fn => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(hardTimer); fn(); } };';
    t('对照组：找得到要替换的那行 once（找不到下面是空跑）', handlerSrc.includes(newOnce));
    const e3 = runRoute(handlerSrc.replace(newOnce, oldOnce));
    await tick();
    e3.log.fire(150000);
    e3.child().emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    await tick();
    t('★ 对照组：老写法里 error 一来二级兜底就被撤了（僵死进程从此没人管）',
      e3.log.pending(5000).length === 0);

    /* ★ 断开路径也得武装善后：**没到 150 秒**就断开时，kill 同样可能送不到。
       只在 150 秒那处武装的话，「早断开 + kill 失败 + close 永远不来」这条路是裸的 ——
       进程和 gc-vid-* 从此再没人回来看一眼。 */
    const f1 = runRoute();
    await tick();
    f1.res.writableFinished = false;
    f1.res.emit('close');                     // 远没到 150 秒就断开
    t('★ 断开时也武装了二级善后（kill 可能送不到）', f1.log.pending(5000).length === 1);
    f1.child().emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    await tick();
    t('★ 断开后 error 来了，善后定时器还在', f1.log.pending(5000).length === 1);
    const killsF = f1.log.kills;
    f1.log.fire(5000);
    t('★ 断开路径的善后到点后补刀 + 强删', f1.log.kills === killsF + 1 && f1.log.rm >= 1);
    // 进程正常退出的那种断开，不该留下空转的定时器
    const f2 = runRoute();
    await tick();
    f2.res.writableFinished = false;
    f2.res.emit('close');
    f2.child().emit('close', null, 'SIGKILL');
    await tick();
    t('★ 断开后进程正常退出时，善后定时器被撤掉（不空转）', f2.log.pending(5000).length === 0);
    t('断开后进程退出，临时目录删掉了', f2.log.rm >= 1);
    // 幂等：客户端断开事件可能来两次（aborted + res close）
    const f3 = runRoute();
    await tick();
    f3.req.emit('aborted');
    f3.res.writableFinished = false;
    f3.res.emit('close');
    t('重复 abort 只装一个善后定时器', f3.log.pending(5000).length === 1);
  }

  console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
