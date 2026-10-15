/* ══════════════════════════════════════════════════════════════════
   发视频给 AI 看
   ──────────────────────────────────────────────────────────────────
   模型不吃视频，只吃图。所以这里做的事是：把视频抽成几张关键帧，
   塞进 _pendingImgs —— 后面发送、渲染、云同步、Anthropic/OpenAI 两种
   格式转换的链路和「选图片」完全一样，一行都不用改。

   ⚠️ 抽帧放在**前端**做（video + canvas），不是 ffmpeg。
   ffmpeg 抽得更准，但它只在 exe 里、以及手机连得上电脑时才有；
   浏览器直接开、或者手机在外面用流量的时候就整个功能没了。
   前端这条路三个运行环境（浏览器 / Electron / 安卓 WebView）全都在。
   ffmpeg 只兜「浏览器压根解不了这个编码」那种情况，见 _serverExtract。

   ⚠️ 为什么不是均匀抽帧。
   均匀抽的话，一段前 20 秒静止、后 3 秒才动的视频，8 张里有 7 张是同一个
   画面 —— token 全烧在废帧上，而真正发生事情的那几秒可能一张都没抽到。
   所以先粗扫算画面变化量，把帧花在「画面变了」的地方（和 ffmpeg 的
   select='gt(scene,0.25)' 是同一个思路）。静止视频再退回均匀采样兜底，
   否则一段访谈只会抽出 1 张。

   ⚠️ 每张 768px 的图大约 1.2k token。8 张就是接近 1 万 token，
   比一般人以为的贵得多，所以帧数必须有上限，而且要把估算显式告诉用户。 */

const VIDEO_CFG = {
  maxFrames: 8,        // 帧数上限。再多 token 就失控了
  targetW: 768,        // 抽出来的帧宽度（长边）
  jpegQ: 0.72,
  probeMax: 220,       // 粗扫最多采样多少个点 —— 两小时的片子不能一秒一停
  probeStep: 0.5,      // 粗扫步长下限（秒）
  probeW: 64,          // 粗扫画布宽，够算变化量就行，越小越快
  probeBudgetMs: 9000, // 粗扫的时间预算。超了就拉大步长，不是砍掉后半段（见 _vidProbe）
  probeMin: 12,        // 无论多慢，剩下的片长至少还要再采这么多点 —— 预算是软的，覆盖是硬的
  probeMaxMiss: 3,     // 粗扫时连着这么多点读不出画面才放弃（孤立失败要跳过去，见 _vidProbe）
  sceneDelta: 0.055,   // 判定「画面变了」的阈值（0~1 的平均像素差）
  minGap: 0.7,         // 选中的帧之间至少隔多久（下限，实际按时长放大，见 _vidPickTimes）
  minFrames: 3,        // 静止视频也至少给这么多张
  maxBytes: 400 * 1024 * 1024,
  tokensPerFrame: 1230 // 720p 一帧的经验值，用来给用户报估算
};

/* ⚠️ 判「这是不是视频」不能只信 file.type。
   Windows 和安卓 WebView 对 .mkv / .avi / .flv 这些常常给**空字符串**的 MIME ——
   而这几个恰恰是浏览器自己解不了、最需要走 ffmpeg 兜底的格式。只看 MIME 的话
   它们既进不了视频分支、也进不了图片分支，被 `return` 悄悄吃掉：用户点了发送，
   界面上什么都没出现，控制台也干干净净。所以扩展名要一起认。 */
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv', '3gp', 'mpg', 'mpeg', 'm2ts', 'ogv'];
/* ⚠️ `.ts` 得单独拎出来：它既是 MPEG Transport Stream，也是 TypeScript 源码，
   而这个项目**本来就支持**把 .ts 源码拖进来当文本附件（12-math-media.js 的 textExts 里有它）。
   一视同仁地认成视频的话，拖一份 .ts 源码进来会被送去抽帧，最后弹「这个视频读不了」——
   一个本来好好的功能就这么被顺手弄坏了。
   所以：只有调用方明说「这里就是在选视频」（文件选择框那条路）时才认它；
   拖拽那条路不认，除非 MIME 明确是 video/*（video/mp2t）。 */
const VIDEO_EXTS_AMBIGUOUS = ['ts'];
function isVideoFile(file, allowAmbiguous) {
  if (!file) return false;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  /* ⚠️ 歧义扩展名要在看 MIME **之前**判掉，而且 MIME 一票都不给它。
     File.type 是操作系统按扩展名猜的，根本没看过文件内容 —— 这台机器上
     `HKLM\SOFTWARE\Classes\.ts` 的 Content Type 就是 `video/vnd.dlna.mpeg-tts`
     （Windows Media Player 注册的，PerceivedType 还是 video）。也就是说拖一份
     TypeScript 源码进来，浏览器报的 MIME 就是 video/ 开头的，
     「MIME 明确是视频才算」这条规则在这里根本不成立，源码照样被当视频吞掉。
     所以拖拽那条路上 .ts 一律先当文本；真的 MPEG-TS 视频走文件选择框
     （index.html 里那个 input 的 accept 写着 .ts，是明确的视频上下文）。 */
  if (VIDEO_EXTS_AMBIGUOUS.includes(ext)) return !!allowAmbiguous;
  if ((file.type || '').startsWith('video/')) return true;
  return VIDEO_EXTS.includes(ext);
}

/* 发送那一刻，从**真正要发出去的**那批图里推出视频说明。
   按帧自己带的 vidId 分组，报的是「第几张图」而不是「依次对应」—— 因为这批图里
   可能还混着普通图片、可能有两段视频、用户也可能删掉了中间某一帧。报下标的话
   这三种情况都不会错位；说「依次对应」则三种全错，且错得毫无征兆。
   返回 null 表示这条消息里没有视频帧。 */
function buildVideoNotes(images) {
  if (!images || !images.length) return null;
  const order = [], groups = new Map();
  images.forEach((img, i) => {
    if (!img || !img.vidId) return;
    if (!groups.has(img.vidId)) { groups.set(img.vidId, []); order.push(img.vidId); }
    groups.get(img.vidId).push({ n: i + 1, t: img.vidT, img });
  });
  if (!order.length) return null;
  return order.map(id => {
    const g = groups.get(id), f = g[0].img;
    return `[本条消息里的第 ${g.map(x => x.n).join('、')} 张图，来自视频「${f.vidName}」` +
           `（时长 ${_vidFmtTime(f.vidDur)}，按画面变化抽帧${f.vidVia === 'ffmpeg' ? '，服务端 ffmpeg' : ''}），` +
           `依次对应 ${g.map(x => _vidFmtTime(x.t)).join(' / ')}]`;
  });
}

function _vidFmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}

/* 跳到指定时间并等这一帧真的画出来。
   ⚠️ 光等 'seeked' 不够：它只保证解码器定位完成，不保证这一帧已经可以画进
   canvas —— 抢跑的话 drawImage 画出来的是上一帧甚至全黑。

   ⚠️ 但 requestVideoFrameCallback **不能单用**，哪怕浏览器支持它。
   它的语义是「有新帧**呈现**了」，而这个 <video> 从来没进过 DOM、也不在播放，
   压根不参与合成 —— 于是 rVFC 永远不回调。实测（headless Chrome，见
   scratchpad/seekprobe.html）：不进 DOM 时 3/3 次都不来，进了 DOM 也只来 1/3 次；
   同一批 seek 里 'seeked' 稳定 10~27ms、双 rAF 稳定 21~31ms 就位。
   最早写成 `if (rVFC) 用它 else 用 rAF`，结果每次 seek 都走满下面那个 3 秒超时
   才继续 —— 帧还是对的（超时的时候画面早绘好了），所以肉眼完全看不出问题，
   只是 8 秒的片子要跑 63 秒，手机上发个三分钟的视频就是几分钟的卡死。
   现在两个一起挂，谁先到算谁（finish 自带去重）。rAF 在后台标签页会停，
   那种情况仍然由 3 秒超时兜底，不会吊死。

   ⚠️ 超时不能无条件当成功。后台 WebView 里 rAF 是停的，如果这时 seek 也还没到位，
   无条件 resolve 会让调用方把**上一帧**画进 canvas —— 几个不同的时间点悄悄拿到
   同一张画面，时间码却各不相同，等于给模型编造事实。所以超时时先验一下
   currentTime 真的落到目标附近、并且有画面可画；没到位就报失败，由调用方跳过
   这一帧（_vidGrab 里 continue）而不是塞一张假的进去。 */
function _vidSeek(video, t) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const fail = e => { if (!done) { done = true; cleanup(); reject(e || new Error('seek 失败')); } };
    const timer = setTimeout(() => {
      const arrived = Math.abs(video.currentTime - Math.max(0, t)) < 0.5 && video.readyState >= 2;
      arrived ? finish() : fail(new Error('seek 超时且没到位'));
    }, 3000);
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', fail);
    }
    function onSeeked() {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => finish());
      requestAnimationFrame(() => requestAnimationFrame(finish));
    }
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', fail, { once: true });
    try { video.currentTime = Math.max(0, t); } catch (e) { fail(e); }
  });
}

/* 把视频元数据读出来。读不到 = 浏览器解不了这个编码，交给上层去兜底。
   注意判据不能只看有没有报错：有些容器（部分 .mov / .mkv）能建起 video 元素、
   甚至能报出 duration，但 videoWidth 是 0，画出来一片黑。所以两个都得验。 */
function _vidLoadMeta(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    /* ⚠️ 每一条失败路径都要把 blob URL 和解码器放掉，超时那条尤其容易漏：
       这时候外层的 finally 还够不着（meta 根本没被赋值），漏了就是几百 MB
       的 blob 挂在那儿不走 —— 连着试几个卡住的大视频，内存就下不来了。 */
    const drop = () => { try { video.src = ''; video.load(); } catch {} URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { cleanup(); drop(); reject(new Error('读取元数据超时')); }, 15000);
    function cleanup() { clearTimeout(timer); video.removeEventListener('loadedmetadata', ok); video.removeEventListener('error', bad); }
    function ok() {
      cleanup();
      if (!video.videoWidth || !video.videoHeight) { drop(); return reject(new Error('没有可解码的画面轨')); }
      if (!isFinite(video.duration) || video.duration <= 0) { drop(); return reject(new Error('读不出时长')); }
      resolve({ video, url });
    }
    function bad() { cleanup(); drop(); reject(new Error('浏览器解不了这个编码')); }
    video.addEventListener('loadedmetadata', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    video.src = url;
  });
}

/* 按实测速度重算粗扫步长。单独拆出来是为了能测 —— _vidProbe 本身要
   <video> + canvas，node 里跑不起来，塞在里面就只能靠正则去"看"它长得对不对，
   而长得对不对和算得对不对是两回事。

   ⚠️ probeMin 这个下限不能省。慢机器上前 6 个点就可能把预算吃光，
   afford 算出来是 0 甚至负数；没有下限的话 step 会变成"剩下的整段"，
   下一轮 t 直接跳到片尾、循环结束 —— 等于只扫了开头几秒就收工，
   正好是这套设计要避免的事，而且照样零报错。
   预算是软目标，"整段都扫到"是硬要求：宁可超时，也不能只看开头。 */
function _vidProbeStep(step, t, duration, elapsedMs, count) {
  const per = elapsedMs / Math.max(1, count);
  const left = VIDEO_CFG.probeBudgetMs - elapsedMs;
  const afford = Math.max(VIDEO_CFG.probeMin, Math.floor(left / Math.max(1, per)));
  return afford < (duration - t) / step ? Math.max(step, (duration - t) / afford) : step;
}

/* 粗扫：每隔一段取一张缩到 64px 的小图，和上一张比平均像素差。
   返回 [{t, delta}]，delta 越大说明画面变得越厉害。 */
async function _vidProbe(video, duration, onProgress) {
  let step = Math.max(VIDEO_CFG.probeStep, duration / VIDEO_CFG.probeMax);
  const w = VIDEO_CFG.probeW;
  const h = Math.max(1, Math.round(w * video.videoHeight / video.videoWidth));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const out = [];
  let prev = null, miss = 0;
  const t0 = performance.now();
  for (let t = 0; t < duration - 0.05; t += step) {
    /* ⚠️ 单个点 seek 失败不能就地收摊。
       _vidSeek 失败的典型原因是「3 秒超时且没到位」——后台标签页里 rAF 停了、
       某一帧解码卡了一下，都可能孤立地发生一次。就地 break 的话：前 20 秒变化大的
       素材已经攒够 8 个候选，_vidPickTimes 认为帧数满了、不会再均匀补帧，
       于是三分钟的视频模型只看得到开头那一段，后面两分多钟凭空消失，还零报错。
       这和这套设计的前提（宁可扫得粗，也要扫完整段）正好相反。
       所以孤立失败跳过继续，只有连着失败才认定解码器真的废了 —— 那时候抛出去，
       让外面转服务端 ffmpeg，也免得每个点都白等三秒超时。 */
    try { await _vidSeek(video, t); miss = 0; }
    catch (e) {
      if (++miss >= VIDEO_CFG.probeMaxMiss) throw new Error('连续多个采样点都读不出画面');
      prev = null;   // 跨过一个洞，下一点不能拿洞另一边的帧算变化量
      continue;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const cur = ctx.getImageData(0, 0, w, h).data;
    let delta = 0;
    if (prev) {
      let sum = 0;
      // 步长 4 = 只比 R 通道。三通道全比精度提升有限，但耗时三倍，
      // 而这只是用来排序找「哪里变了」，不需要精确。
      for (let p = 0; p < cur.length; p += 4) sum += Math.abs(cur[p] - prev[p]);
      delta = sum / (cur.length / 4) / 255;
    }
    out.push({ t, delta });
    prev = cur;
    if (onProgress) onProgress(t / duration);

    /* 采够几个点之后，按**实测**的单点耗时重算步长。
       手机解码比电脑慢一个量级，固定 probeMax 个采样点在慢机器上就是几十秒的冻结。
       ⚠️ 注意这里拉的是步长，不是「超时就 break」—— break 的话后半段一个点都没扫，
       关键帧全挤在开头，长视频的结尾等于没看见。宁可扫得粗，也要扫完整段。 */
    if (out.length === 6) step = _vidProbeStep(step, t, duration, performance.now() - t0, out.length);
  }
  return out;
}

/* 从粗扫结果里挑出要真正抽的时间点。
   先按变化量从大到小拿（那是镜头切换 / 有事发生的位置），彼此至少隔 gap；
   不够 minFrames 就用均匀采样补满 —— 不补的话静止视频只会抽出开头一张。

   ⚠️ gap 必须跟时长一起放大，不能用固定的 0.7 秒。
   手持拍摄 / 走路这种全程都在动的素材，delta 到处都不为零，排前几名的峰值
   完全可能挨在一起 —— 实测一段 3 分钟的片子，8 帧里 5 帧挤在 1:24~1:32 这
   8 秒内，前后各一分钟只各分到 1 张。那正是当初做场景检测要避免的事
   （token 全烧在同一个瞬间上）。除以 maxFrames*2 而不是 maxFrames：
   留一半余量给「确实值得连拍两张」的密集段，只掐掉病态的堆叠。 */
function _vidPickTimes(probes, duration) {
  const gap = Math.max(VIDEO_CFG.minGap, duration / (VIDEO_CFG.maxFrames * 2));
  const picked = [0.06 * Math.min(duration, 1)];   // 开头永远要，作为「这是什么片子」的锚
  const far = t => picked.every(p => Math.abs(p - t) >= gap);

  for (const p of probes.filter(p => p.delta >= VIDEO_CFG.sceneDelta).sort((a, b) => b.delta - a.delta)) {
    if (picked.length >= VIDEO_CFG.maxFrames) break;
    if (far(p.t)) picked.push(p.t);
  }
  /* 补满的位置要按**还差几张**来切，不是按 want 切。
     按 want 切的话开头那个锚点白占一个名额：want=3 时只补得进 2 张，
     位置又落在 1/4、2/4，后半段一张都没有 —— 一段 60 秒的静止视频，
     模型只看得到前 30 秒。取每段的中点，才是真的铺满全片。 */
  const want = Math.min(VIDEO_CFG.maxFrames, Math.max(VIDEO_CFG.minFrames, picked.length));
  const need = want - picked.length;
  /* 两趟：先按 gap 补，还不够就放开 gap 硬补满。
     ⚠️ 第二趟不是保险丝，是必需的。gap 有个 0.7 秒的下限，而极短视频的候选点
     本来就挨得近 —— 3 秒的片子候选 0.75s 离锚点 0.69s，差 0.01 秒被毙掉，
     最后只有 2 帧；1 秒的片子干脆只剩锚点那 1 帧。minFrames 写着 3 却给不出 3，
     不报错，只是模型看到的东西少了一半。第二趟只要求「别跟已有的点重合」。 */
  for (const strict of [true, false]) {
    for (let n = 1; n <= need && picked.length < want; n++) {
      const t = duration * (n - 0.5) / need;
      if (strict ? far(t) : picked.every(p => Math.abs(p - t) > 0.02)) picked.push(t);
    }
  }

  /* ⚠️ 时间轴覆盖兜底。上面那段补帧只在「候选不够 minFrames」时才启动，
     而 gap 只管相邻两帧别挨太近，管不了**名额全被前半段吃光**：
     一段前 90 秒是快剪片头、后 90 秒是正片的视频，8 个高 delta 点全落在前半段
     也完全满足 gap，于是 need 是 0、一帧都不补 —— 粗扫明明扫到了 179 秒，
     模型却只看得见前半段，而且照样零报错、照样答得头头是道。
     所以选完之后再看一眼时间轴本身：哪一段空得离谱（含最后一帧到片尾那段），
     就往那个洞的中点塞一帧，直到没有超标的洞或者名额用完。
     ⚠️ 洞的阈值取 2×duration/maxFrames，正好是 gap 的两倍 —— 于是插进去的点
     离两边各至少一个 gap，不会把上面辛苦维持的最小间隔又破坏掉。 */
  const maxHole = duration / VIDEO_CFG.maxFrames * 2;
  for (let guard = 0; guard < VIDEO_CFG.maxFrames * 3; guard++) {
    picked.sort((a, b) => a - b);
    // 最大的空洞在哪（最后一段算到片尾为止，不然结尾永远是盲区）
    let worst = -1, at = 0;
    for (let i = 0; i < picked.length; i++) {
      const lo = picked[i], hi = i + 1 < picked.length ? picked[i + 1] : duration;
      if (hi - lo > worst) { worst = hi - lo; at = (lo + hi) / 2; }
    }
    if (worst <= maxHole) break;
    if (picked.length < VIDEO_CFG.maxFrames) { picked.push(at); continue; }
    /* ⚠️ 名额满了也得补 —— 这正是要治的那种情况：8 个峰值全在前半段、
       每对都合规，`picked.length < maxFrames` 的写法在这里一次都不会进循环。
       所以挤掉「挨得最紧的那一对」里靠后的那个（开头那个锚点不动，它是
       「这是什么片子」的基准），拿这个名额去填最大的洞。
       只有在「挤掉的间隔确实比要填的洞小」时才换，否则就是白折腾。 */
    let tight = Infinity, idx = -1;
    for (let i = 1; i < picked.length; i++) {
      const d = picked[i] - picked[i - 1];
      if (d < tight) { tight = d; idx = i; }
    }
    if (idx < 0 || tight >= worst) break;
    picked.splice(idx, 1);
    picked.push(at);
  }
  return picked.sort((a, b) => a - b).slice(0, VIDEO_CFG.maxFrames);
}

async function _vidGrab(video, times, onProgress) {
  const w = Math.min(VIDEO_CFG.targetW, video.videoWidth);
  const h = Math.max(1, Math.round(w * video.videoHeight / video.videoWidth));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    try { await _vidSeek(video, times[i]); } catch { continue; }
    ctx.drawImage(video, 0, 0, w, h);
    frames.push({ t: times[i], url: cv.toDataURL('image/jpeg', VIDEO_CFG.jpegQ) });
    if (onProgress) onProgress((i + 1) / times.length);
  }
  return frames;
}

/* 浏览器解不了的编码（常见的是 .mkv、部分 .mov/HEVC、.avi）走电脑上的 ffmpeg。
   ⚠️ 这条路不是随时都在：浏览器直接打开、或者手机不在同一个网里的时候
   server 根本连不上。所以它只是兜底，失败了要给一句人话，不能静默什么都不发生。 */
async function _vidServerExtract(file, onProgress) {
  if (typeof SERVER_BASE === 'undefined') throw new Error('没有可用的后端服务器');
  if (onProgress) onProgress(0.1);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const r = await fetch(`${SERVER_BASE}/api/video-frames?max=${VIDEO_CFG.maxFrames}&w=${VIDEO_CFG.targetW}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file, signal: ctrl.signal
    });
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || ('服务器返回 ' + r.status));
    const j = await r.json();
    if (!j.frames || !j.frames.length) throw new Error('没抽出画面');
    return { frames: j.frames.map(f => ({ t: f.t, url: 'data:image/jpeg;base64,' + f.b64 })), duration: j.duration || 0 };
  } finally { clearTimeout(timer); }
}

/* 正在抽帧的视频数量。抽帧是异步的，快则几百毫秒，慢则几十秒（三分钟的片子、
   或者走服务端 ffmpeg）—— 这期间帧还没进 _pendingImgs。用户选完视频顺手按回车，
   handleSend 快照到的就是一个还没有视频帧的数组：文字先发出去了，帧几秒后才落到
   输入区，滞留到下一条消息。两个视频一前一后完成时更难看，会被拆进两条消息里。
   所以发送前得有一道屏障，见 05-prompts-api.js 的 handleSend。 */
let _vidBusy = 0;
function videoBusyCount() { return _vidBusy; }

async function addVideoFile(file) {
  if (file.size > VIDEO_CFG.maxBytes) {
    showToast(`视频太大了（${(file.size / 1048576).toFixed(0)}MB），上限 ${VIDEO_CFG.maxBytes / 1048576}MB`, 'error', 4000);
    return;
  }
  _vidBusy++;
  try {
    await _addVideoFileInner(file);
  } finally {
    /* ⚠️ 必须是 finally。上面每一条失败路径都是 return 而不是 throw，
       漏一条计数就永远降不回 0 —— 那时候发送会被永久挡死，而且没有任何报错。 */
    _vidBusy = Math.max(0, _vidBusy - 1);
  }
}

async function _addVideoFileInner(file) {
  const tip = (msg) => { try { showToast(msg, 'info', 1600); } catch {} };
  tip('正在读取视频…');

  let frames = [], duration = 0, via = '前端抽帧';
  let meta = null;
  try {
    meta = await _vidLoadMeta(file);
    duration = meta.video.duration;
    tip('正在找关键画面…');
    let tipped = false;   // onProgress 现在每个采样点都回调，toast 只能弹一次
    const probes = await _vidProbe(meta.video, duration, p => {
      if (p > .95 && !tipped) { tipped = true; tip('正在抽帧…'); }
    });
    frames = await _vidGrab(meta.video, _vidPickTimes(probes, duration));
    /* ⚠️ 抽出 0 帧也要当失败抛出去，否则这里静悄悄地不走 ffmpeg 兜底。
       _vidProbe 里 seek 失败是 break、_vidGrab 里是 continue —— 两个都不抛，
       于是「容器能读出 metadata、画面却解不出来」的素材（部分 HEVC 的 .mov、
       某些 .avi）会一路走到底拿到空数组，catch 根本不执行，用户只看到
       「没能抽出画面」。而这恰恰是服务端 ffmpeg 最该接手的一类文件。 */
    if (!frames.length) throw new Error('浏览器解出了信息但一帧都画不出来');
  } catch (e) {
    // 前端解不了 → 试电脑上的 ffmpeg
    try {
      tip('这个格式浏览器解不了，转给电脑处理…');
      const r = await _vidServerExtract(file);
      frames = r.frames; duration = r.duration; via = 'ffmpeg';
    } catch (e2) {
      showToast(`这个视频读不了：${e.message}。转给电脑也没成（${e2.message}）——` +
                `可以先转成 mp4(H.264) 再发`, 'error', 7000);
      return;
    }
  } finally {
    if (meta) { try { meta.video.src = ''; URL.revokeObjectURL(meta.url); } catch {} }
  }

  if (!frames.length) { showToast('没能从这个视频里抽出画面', 'error', 4000); return; }

  const short = file.name.length > 28 ? file.name.slice(0, 25) + '…' : file.name;
  /* 时间码和「哪几张是同一段视频」跟着**每一帧自己**走，不另存一份清单。
     _pendingImgs 是公共的：普通图片、贴图、拍照、粘贴都往里塞，用户还能挨个 × 掉
     单张。另存清单的话，只要顺序一变就整体错位，而且零征兆 —— 模型照样答，
     只是答的是另一秒的事。说明文字在发送那一刻由 buildVideoNotes 现推。
     多带的这几个字段会跟着 images 一起进节点、进云同步，都是纯数据，无副作用。 */
  const vid = '' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  /* ⚠️ 必须**串行** await：addPendingImg 里要解码一次图（拿尺寸），并发跑的话
     谁先解完谁先进数组 —— 帧的顺序一乱，时间码和画面就对不上了，而 buildVideoNotes
     是按数组顺序现推说明文字的，错位后模型照样答，只是答的是另一秒的事（零征兆）。
     抽帧本身已经按 targetW=768 出图，这里基本是 no-op，只为补上 w/h 让预算算得准。 */
  for (const f of frames) {
    await addPendingImg({
      url: f.url, name: `${short} @ ${_vidFmtTime(f.t)}`,
      vidId: vid, vidName: file.name, vidT: f.t, vidDur: duration, vidVia: via
    });
  }

  const kt = (frames.length * VIDEO_CFG.tokensPerFrame / 1000).toFixed(1);
  showToast(`已抽 ${frames.length} 帧（${_vidFmtTime(duration)}）≈ ${kt}k tokens`, 'success', 4200);
}

function handleVideoUpload(input) {
  Array.from(input.files).forEach(f => { if (isVideoFile(f)) addVideoFile(f); });
  input.value = '';
}
