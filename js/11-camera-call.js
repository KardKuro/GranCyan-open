async function openCamera() {
  const modal = document.getElementById('cameraModal');
  modal.classList.remove('hidden', 'shot');
  document.getElementById('camRetakeBar').style.display = 'none';
  document.querySelector('#cameraModal .cam-bar').style.display = 'flex';
  _camShotData = null;
  await _startCamStream();
}

// 每开一次流 +1、关相机也 +1：getUserMedia 等权限那段里关了相机 / 连点两下翻转，
// 晚回来的那路流一看代数不对就自己关掉——否则没人持有它，摄像头灯一直亮着
let _camGen = 0;

async function _startCamStream() {
  const gen = ++_camGen;
  const hint = document.getElementById('camHint');
  const video = document.getElementById('camVideo');
  hint.style.display = 'block';
  hint.textContent = '正在打开摄像头…';
  try {
    _stopCamStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _camFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    if (gen !== _camGen) { stream.getTracks().forEach(t => t.stop()); return; }
    _camStream = stream;
    video.srcObject = _camStream;
    await video.play().catch(() => {});
    if (gen !== _camGen) return;
    hint.style.display = 'none';
  } catch (e) {
    if (gen !== _camGen) return;
    console.warn('[拍照]', e);
    hint.style.display = 'block';
    hint.innerHTML = '打不开摄像头 (｡•́︿•̀｡)<br><span style="font-size:11px">'
      + escHtml(e.name === 'NotAllowedError' ? '权限被拒了——去系统设置里给 Grancyan 开摄像头权限' : (e.message || String(e)))
      + '</span>';
  }
}

function _stopCamStream() {
  if (!_camStream) return;
  try { _camStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  _camStream = null;
}

function takePhoto() {
  const video = document.getElementById('camVideo');
  if (!_camStream || !video.videoWidth) { showToast('摄像头还没准备好', 'error'); return; }
  const canvas = document.getElementById('camCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  // 前置摄像头镜像一下，不然拍出来字是反的
  if (_camFacing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  _camShotData = canvas.toDataURL('image/jpeg', 0.88);
  document.getElementById('camShot').src = _camShotData;
  document.getElementById('cameraModal').classList.add('shot');
  document.querySelector('#cameraModal .cam-bar').style.display = 'none';
  document.getElementById('camRetakeBar').style.display = 'flex';
}

function retakePhoto() {
  _camShotData = null;
  cancelCrop();
  document.getElementById('cameraModal').classList.remove('shot');
  document.getElementById('camRetakeBar').style.display = 'none';
  document.querySelector('#cameraModal .cam-bar').style.display = 'flex';
}

/* ── 拍完裁剪 ────────────────────────────────────────────────────────
   照片平时用 object-fit:cover 铺满取景框（边上被 CSS 切掉），裁剪时切成 contain
   把整张露全 —— 否则你框住的区域和照片真实像素对不上，裁出来是错位的。
   选框坐标一律存「取景框内的 px」，最后除以缩放比换算回原图像素再 drawImage。 */
let _crop = { x: 0, y: 0, w: 0, h: 0 };

// contain 模式下，照片在取景框里实际占的那块矩形（周围是黑边）
function _camImgRect() {
  const img = document.getElementById('camShot');
  const stage = img.parentElement;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
  const scale = Math.min(sw / nw, sh / nh);
  const w = nw * scale, h = nh * scale;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h, scale };
}

function enterCrop() {
  if (!_camShotData) return;
  document.getElementById('cameraModal').classList.add('cropping');
  document.getElementById('camRetakeBar').style.display = 'none';
  document.getElementById('camCropBar').style.display = 'flex';
  // 等 contain 生效后再量尺寸，不然量到的还是 cover 的布局
  requestAnimationFrame(() => { resetCropBox(); _bindCropDrag(); });
}

function cancelCrop() {
  document.getElementById('cameraModal').classList.remove('cropping');
  document.getElementById('camCropBar').style.display = 'none';
  if (_camShotData) document.getElementById('camRetakeBar').style.display = 'flex';
}

function resetCropBox() {
  const r = _camImgRect();
  // 默认框住中间 80%
  _crop = { x: r.x + r.w * 0.1, y: r.y + r.h * 0.1, w: r.w * 0.8, h: r.h * 0.8 };
  _drawCropBox();
}

function _drawCropBox() {
  const b = document.getElementById('cropBox');
  b.style.left = _crop.x + 'px';
  b.style.top = _crop.y + 'px';
  b.style.width = _crop.w + 'px';
  b.style.height = _crop.h + 'px';
}

function _bindCropDrag() {
  const overlay = document.getElementById('cropOverlay');
  const box = document.getElementById('cropBox');
  if (overlay._cropBound) return;
  overlay._cropBound = true;

  let mode = null, hand = '', sx = 0, sy = 0, start = null;
  const MIN = 44;
  const pt = e => { const t = e.touches?.[0] || e; return { x: t.clientX, y: t.clientY }; };

  const down = e => {
    const h = e.target.closest('.crop-handle');
    if (h) { mode = 'resize'; hand = h.dataset.h; }
    else if (e.target.closest('.crop-box')) mode = 'move';
    else return;
    e.preventDefault();
    const p = pt(e); sx = p.x; sy = p.y; start = { ..._crop };
  };
  const move = e => {
    if (!mode) return;
    e.preventDefault();
    const p = pt(e), dx = p.x - sx, dy = p.y - sy;
    const r = _camImgRect();
    if (mode === 'move') {
      _crop.x = Math.max(r.x, Math.min(start.x + dx, r.x + r.w - start.w));
      _crop.y = Math.max(r.y, Math.min(start.y + dy, r.y + r.h - start.h));
    } else {
      let { x, y, w, h } = start;
      if (hand.includes('w')) { const nx = Math.max(r.x, Math.min(x + dx, x + w - MIN)); w += x - nx; x = nx; }
      if (hand.includes('n')) { const ny = Math.max(r.y, Math.min(y + dy, y + h - MIN)); h += y - ny; y = ny; }
      if (hand.includes('e')) w = Math.max(MIN, Math.min(w + dx, r.x + r.w - x));
      if (hand.includes('s')) h = Math.max(MIN, Math.min(h + dy, r.y + r.h - y));
      _crop = { x, y, w, h };
    }
    _drawCropBox();
  };
  const up = () => { mode = null; };

  overlay.addEventListener('touchstart', down, { passive: false });
  overlay.addEventListener('touchmove', move, { passive: false });
  overlay.addEventListener('touchend', up);
  overlay.addEventListener('mousedown', down);
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function applyCrop() {
  const img = document.getElementById('camShot');
  const r = _camImgRect();
  // 取景框 px → 原图像素
  const sx = Math.round((_crop.x - r.x) / r.scale);
  const sy = Math.round((_crop.y - r.y) / r.scale);
  const sw = Math.round(_crop.w / r.scale);
  const sh = Math.round(_crop.h / r.scale);
  if (sw < 8 || sh < 8) { showToast('框太小了 (・ω・)'); return; }
  const canvas = document.getElementById('camCanvas');
  canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  _camShotData = canvas.toDataURL('image/jpeg', 0.9);
  img.src = _camShotData;
  cancelCrop();
  showToast(`✂ 裁成 ${sw}×${sh}`, 'success');
}

function usePhoto() {
  if (!_camShotData) return;
  addPendingImg({ url: _camShotData, name: 'photo-' + Date.now() + '.jpg' });
  updateComposerBtns();
  closeCamera();
  showToast('📷 照片已加到输入框，写点什么再发给 AI 吧', 'success');
}

async function flipCamera() {
  _camFacing = _camFacing === 'environment' ? 'user' : 'environment';
  await _startCamStream();
}

function closeCamera() {
  _camGen++;            // 还在等权限的那路流作废
  _stopCamStream();
  cancelCrop();
  document.getElementById('cameraModal').classList.add('hidden');
  document.getElementById('cameraModal').classList.remove('shot');
  _camShotData = null;
}

/* ── 语音通话：只有 UI（用户说功能先不做）───────────────────────── */
/* ── 和 AI 语音通话 ───────────────────────────────────────────────────
   一轮的样子：听你说 →（停顿 1.2 秒判定说完）→ Whisper 转写 → 当成一条语音消息
   走正常聊天管线发给当前模型 → AI 回复流式完成 → Edge-TTS 念出来 → 接着听下一句。
   通话内容就是这场对话的正常消息，所以人设/记忆/上下文全都在，挂断后聊天记录里也留着。 */
const _call = {
  on: false, muted: false, phase: '',      // listening / thinking / speaking
  stream: null, ctx: null, analyser: null, rec: null, chunks: [], mime: '',
  speaking: false, silenceAt: 0, startAt: 0, raf: 0, audio: null,
  linger: false,                            // AI 说完再见了，但还在等你回一句
  lingerT: 0,                               // 余韵计时器：挂断/新开一通都得掐掉，不然会挂掉下一通
  gen: 0,                                   // 第几通：openCall/closeCall 各 +1，晚回来的异步一看不是这通就收手
  speakId: 0, speakDone: null,              // 正在念的那句：打断/挂断时作废它、并放行等它念完的那头
  // ↓ 2026-10-12：用嗓子打断 / 我说到哪了 / 沉默时主动开口（见下面「插话」那一大段注释）
  bargeAn: null, bargeBuf: null, bargeRaf: 0, // 盯「我说话时你出没出声」的那个分析器（低平滑，反应快）
  barge: null, bargeHold: false,            // 两段式打断的状态；bargeHold = 候选期间播放先停着
  route: 'unknown', onDev: null,            // 耳机 / 外放（认不出来按外放算，阈值更高）
  say: null,                                // 正在念的那段：念到第几句、哪条消息，打断时据此算你听到了哪儿
  cutCtx: null,                             // 这一句是插着我的话说的：转写回来先看是不是附和
  lead: null, leadT: 0,                     // 你说了「等等」：先停下听，等你下一句一起发（没下文就单发）
  nudge: null,                              // 沉默计时：安静了多久、问过自己几次、开口几次你没回
};
const CALL_SILENCE_MS = 1200;   // 停顿多久算「这句说完了」
const CALL_MIN_MS = 500;        // 太短的当噪音丢掉
const CALL_MAX_MS = 30000;      // 一句最长 30 秒，防止一直说不断句

/* ── 插话：我说着你开口（参考 call_call 的做法，思路参考 LiveKit Agents 的可恢复打断）──
   以前只能点按钮打断，打断了我也不知道自己说到哪。现在：
   ① 两段式打断：我说话时也盯着麦克风（另一个低平滑的分析器）。你一出声（≥ onsetMs）→ 先把播放**暂停**
      并开一台录音机录你 → 在 windowMs 的窗口里看你是不是还在说：窗口结束时最近 120ms 内还有声、
      窗口里累计有声 ≥ 300ms → 确认，剩下的话作废、这台录音机直接当成「听你说」的那台（你开头那几个字不丢）；
      否则（咳嗽、碰麦、我自己的回声）→ 往回倒一点接着放。
      回声的判据就藏在「先暂停」里：停了播放之后回声当场没了，还有声音 = 真是你在说。
   ② 短附和分流：没确认的那一下如果有声够长，转写一下：「等等 / 不对 / 停 / 慢点」这类 → 真停下来听；
      「嗯 / 对 / 是 / 好」这类 → 什么都不做，我接着说。确认了的那句转写回来要是从头到尾只是「嗯嗯对对」，
      也当附和：我从被打断的地方接着往下说，不发新一轮。
   ③ heard_text：按真实播放进度（第几句 + 这句的 currentTime/duration）算你听到了哪儿，
      被打断时记在那条 AI 消息上（n.callCut），下一轮上下文里明说「后面这些 ta 没听到」。
   ④ 沉默时主动开口：你十来秒不出声，让它自己决定说一句还是回 [[SILENT]]（同偷看屏幕那套）。
      一段沉默里最多问自己 4 次、间隔翻倍（12s/24s/48s/96s），开口两次你都没回就不再说了，等你。
   ⑤ 外放 vs 耳机：外放时回声大，开口阈值更高、要说得更久才算（CALL_BARGE_PROFILES）。
   ⚠️ 下面这些阈值**全是猜的**，没有真机外放实测过（音量刻度是 getByteFrequencyData 的 0~255 平均值，
      和听你说话时那个 18 是同一把尺子）。调法见各常量的注释。 */
const CALL_BARGE_PROFILES = {
  // onVol：我在放的时候，你的声音要超过这个才算「开口」（还会被回声底噪抬高，见 echoPad）
  // onsetMs：连续超过多久才算（耳机 40ms ≈ 两三帧；外放要更久，回声尖峰一般很短）
  // windowMs：暂停之后看多久再下结论
  // echoPad：比「我放的时候麦克风里的回声底噪」高出这么多才算你。这把尺子是 dB 刻度
  //          （getByteFrequencyData 把 -100~-30dB 摊到 0~255，约 3.6 格 ≈ 1dB），所以是加不是乘
  headset: { onVol: 22, onsetMs: 40, windowMs: 650, echoPad: 8 },
  speaker: { onVol: 30, onsetMs: 100, windowMs: 800, echoPad: 14 },
};
const CALL_BARGE_VOICED_VOL = 18;    // 候选窗口里（播放已停，没回声了）算「有声」的音量：和听你说话同一档
const CALL_BARGE_RECENT_MS = 120;    // 窗口结束时，最后一次有声在这么久以内 = 你还在说
const CALL_BARGE_MIN_VOICED_MS = 300; // 窗口里累计有声不到这个 = 咳嗽 / 碰麦 / 短附和，不确认
const CALL_BARGE_ECHO_BUMP = 3;      // 认出一次回声误触发后，门槛抬到「那次峰值 + 这么多」
const CALL_BARGE_WARM_MS = 250;      // 每句刚开始放的这一小段只学回声底噪、不触发（底噪还没学到）
const CALL_BARGE_REARM_MS = 250;     // 一次候选作废后，要安静这么久才允许下一次（不然一声「嗯——」能停三回）
const CALL_BARGE_ECHO_ONLY_MS = 150; // 一暂停声音就没了（窗口里有声不到这个，留出房间混响的余量）= 多半是回声：门槛抬到这次的峰值之上
const CALL_BARGE_ECHO_HI_DECAY = 0.9998; // 认出过的回声尖峰每帧忘掉这么一点（60fps 下一秒约 1%）
const CALL_BARGE_ECHO_HI_SPAN = 12;  // 回声尖峰最多比平均底噪高这么多格（≈3dB；再高的就不当回声了）
const CALL_BARGE_REWIND_S = 0.25;    // 没确认、接着放时往回倒一点：被暂停的那个字别只剩半截
const CALL_BARGE_CLS_MIN_MS = 120;   // 没确认的那一下，有声超过这么久才送去转写分流（再短就是噪音，不花这次转写）
const CALL_LEAD_WAIT_MS = 4000;      // 你说了「等等」之后，等你接着说的时间；没下文就把「等等」单独发过去
const CALL_LEAD_MAX_MS = 20000;      // 「等等」最多挂这么久：再晚的下一句就不拼它了
const CALL_CHARS_PER_SEC = 4.5;      // 拿不到音频时长时，按中文 TTS 一秒四五个字估进度
const CALL_HEARD_LAG_CHARS = 1;      // 正念到的那个字算没听全：往回让一个字
const CALL_NUDGE_SILENCE_MS = 12000; // 安静这么久，才问它一次要不要开口（之后每次翻倍）
const CALL_NUDGE_MAX_TRIES = 4;      // 一段沉默里最多问几次（含它决定不说的）——每问一次就是一轮模型调用
const CALL_NUDGE_MAX_UNANSWERED = 2; // 连续主动开口两次你都没回：不再说了，等你

/* 短附和 / 叫停的词表。判法（callClassifyUtterance）：去掉标点空白后，
   整句能完全拆成附和词 → 附和；能拆成「叫停词 + 附和词 + 语气小词」且至少有一个叫停词 → 叫停；
   其他都是正常说话。所以「嗯嗯对」是附和，「等一下哦」是叫停，「等一下我想问你」是正常说话。
   附和词带问号（「嗯？」「啊？」）= 没听懂，算叫停。 */
const CALL_BC_WORDS = ['嗯', '嗯嗯', '嗯哼', '嗯呢', '嗯呐', '对', '对对', '对的', '对啊', '对呀', '是', '是的', '是啊', '是呀',
  '好', '好的', '好啊', '好呀', '好吧', '哦', '噢', '喔', '啊', '行', '可以', '没错', '然后呢', '然后', '哈', '呵', '唔', '昂', '懂', '明白'];
const CALL_STOP_WORDS = ['等等', '等一下', '等下', '等会', '等一等', '稍等', '等', '停', '停下', '打住', '暂停', '不要', '喂',
  '慢点', '慢一点', '慢些', '慢一些', '不对', '不是', '错了', '别说了', '别说', '什么', '啥', '没听清', '听不清', '再说一遍',
  'wait', 'stop', 'holdon'];
const CALL_STOP_FILLERS = ['你', '我', '先', '儿', '啦', '吧', '呀', '哦', '嘛', '了', '呢', '一下', '哎', '诶', '欸', '唉', '那个'];

/* ── AI 主动打给你（callhome 的协议，落在我们自己的 [[...]] 体系里）───────────
   AI 在回复里写 [[DIAL: 理由]] → 这边响铃、弹来电卡（理由写在卡上）。
   接了 → 直接进上面那套通话，AI 先把这条回复念出来，然后正常你来我往。
   不接（90 秒）或拒接 → 这条回复变成语音留言落在聊天里，标成「未接来电」。
   AI 写 [[HANGUP]] → 说完最后一句才收线，并留 18 秒余韵窗口：你这时开口，通话就接着走。 */
let _aiDialReason = null;       // processAiCommands 剥出来的拨号理由
let _aiHangupWanted = false;
const DIAL_RING_MS = 90000;     // 响 90 秒没人接就转留言
const CALL_LINGER_MS = 18000;   // AI 说完再见后，还愿意听你 18 秒
const DIAL_COOLDOWN_MS = 30 * 60 * 1000;   // 同一场对话里，半小时最多打一次——电话贵在稀有
const _incoming = { on: false, nodeId: null, chatId: null, timer: 0, ctx: null, ring: 0, vib: 0 };

// finalize 时调：这条 AI 回复里写了 [[DIAL]] → 该不该真的响铃
async function _maybeAiDial(chat, nodeId) {
  const reason = _aiDialReason;
  _aiDialReason = null;
  const n = chat?.nodes?.[nodeId];
  if (!reason || !n) return;
  if (_call.on || _incoming.on) return;                      // 已经在通话/已经在响了
  if (state.callDnd) {                                        // 勿扰：电话打不进来，但让你知道它想过
    showToast('🔕 勿扰中：' + (n.modelNickname || 'AI') + ' 想打给你');
    return;
  }
  const now = Date.now();
  if (chat.lastDialAt && now - chat.lastDialAt < DIAL_COOLDOWN_MS) return;   // 太密了，忍住
  chat.lastDialAt = now;
  n.dialReason = reason;
  save();
  _showIncoming(chat, nodeId, reason);
}

function _showIncoming(chat, nodeId, reason) {
  const modal = document.getElementById('incomingModal');
  if (!modal) return;
  const n = chat.nodes[nodeId];
  const cfg = state.configs.find(c => c.id === n.modelId) || state.configs[0];
  const label = cfg?.nickname || cfg?.modelName || 'Grancyan';
  document.getElementById('incomingName').textContent = label;
  document.getElementById('incomingReason').textContent = reason;
  const av = document.getElementById('incomingAvatar');
  av.innerHTML = cfg?.avatar
    ? `<img src="${escHtml(cfg.avatar)}" alt="">`
    : escHtml(String(label).trim().charAt(0).toUpperCase() || 'AI');
  _incoming.on = true;
  _incoming.nodeId = nodeId;
  _incoming.chatId = chat.id;
  modal.classList.remove('hidden');
  _ringStart();
  _incoming.timer = setTimeout(() => declineCall(true), DIAL_RING_MS);   // 没人接 → 未接来电
}

// 铃声：两声一组的老式电话音，用 Web Audio 现合成（不塞音频文件进包）
function _ringStart() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    _incoming.ctx = new AC();
    const beep = () => {
      if (!_incoming.on || !_incoming.ctx) return;
      const t0 = _incoming.ctx.currentTime;
      [440, 480].forEach(f => {
        const o = _incoming.ctx.createOscillator(), g = _incoming.ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(_incoming.ctx.destination);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
        g.gain.setValueAtTime(0.12, t0 + 0.9);
        g.gain.linearRampToValueAtTime(0, t0 + 1.0);
        o.start(t0); o.stop(t0 + 1.05);
      });
    };
    beep();
    _incoming.ring = setInterval(beep, 3000);
  } catch {}
  if (navigator.vibrate) {
    navigator.vibrate([600, 400, 600, 1400]);
    _incoming.vib = setInterval(() => navigator.vibrate([600, 400, 600, 1400]), 3000);
  }
}
function _ringStop() {
  clearInterval(_incoming.ring); _incoming.ring = 0;
  clearInterval(_incoming.vib); _incoming.vib = 0;
  if (navigator.vibrate) navigator.vibrate(0);
  try { _incoming.ctx?.close(); } catch {}
  _incoming.ctx = null;
}
function _closeIncoming() {
  clearTimeout(_incoming.timer);
  _ringStop();
  _incoming.on = false;
  document.getElementById('incomingModal')?.classList.add('hidden');
}

// 接了：进通话，AI 先把「打电话时想说的那句」念出来，然后正常你来我往
async function answerCall() {
  const nodeId = _incoming.nodeId, chatId = _incoming.chatId;
  _closeIncoming();
  if (state.activeChatId !== chatId) { switchChat(chatId); }
  const chat = getActiveChat();
  const n = chat?.nodes?.[nodeId];
  await openCall({ speakFirst: n ? (getTtsCleanText(n) || n.content || '') : '', speakNodeId: n ? nodeId : null });
}

// 拒了 / 没接：这条回复变成语音留言，落在聊天里
function declineCall(missed) {
  const nodeId = _incoming.nodeId, chatId = _incoming.chatId;
  _closeIncoming();
  const chat = state.chats.find(c => c.id === chatId);
  const n = chat?.nodes?.[nodeId];
  if (!n) return;
  n.missedCall = true;
  save();
  _invalidateNodeCache?.(nodeId);
  renderMessages();
  showToast(missed ? '📞 未接来电，留言在聊天里' : '📞 已拒接，对方留了言');
  _maybeAiVoice(chat, nodeId);        // 留言得能听：正文送去合成，气泡变语音条
}

function _callStatus(t) {
  const el = document.getElementById('callStatus');
  if (el) el.textContent = t;
}
function _callPhase(p, text) {
  _call.phase = p;
  _callStatus(text);
  const shell = document.querySelector('.call-shell');
  if (shell) shell.classList.toggle('call-listening', p === 'listening' && !_call.muted);
  const av = document.getElementById('callAvatar');
  if (av) av.classList.toggle('speaking', p === 'speaking');
}

async function openCall(opts = {}) {
  const gen = ++_call.gen;
  clearTimeout(_call.lingerT); _call.lingerT = 0; _call.linger = false;
  const modal = document.getElementById('callModal');
  const av = document.getElementById('callAvatar');
  const name = document.getElementById('callName');
  // 叫谁：当前对话里第一个启用的模型（有头像就用头像）
  try {
    const ids = getActiveChatModelIds();
    const cfg = state.configs.find(c => ids.includes(c.id)) || state.configs[0];
    const label = cfg?.nickname || cfg?.modelName || 'Grancyan';
    name.textContent = label;
    av.innerHTML = cfg?.avatar
      ? `<img src="${escHtml(cfg.avatar)}" alt="">`
      : escHtml(String(label).trim().charAt(0).toUpperCase() || 'AI');
  } catch (_) { name.textContent = 'Grancyan'; av.textContent = 'AI'; }
  renderCallBg();
  modal.classList.remove('hidden');
  _callStatus('正在接通…');

  if (!_sttReady()) {
    _callStatus('还没配转写服务（设置 → 🎤 语音输入）');
    return;
  }
  if (!getActiveChat()) { _callStatus('先开一个对话再打电话 (・ω・)'); return; }
  if (typeof ttsWarmLocal === 'function') ttsWarmLocal();   // 本地声音趁接通这几秒先加载模型

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    if (gen !== _call.gen) return;
    _callStatus(e.name === 'NotAllowedError' ? '麦克风权限被拒了' : '打不开麦克风：' + e.message);
    return;
  }
  // 等权限弹窗时就挂了（或又开了一通）：界面已经收了，这里再 on=true 就成了后台偷听还往外发
  if (gen !== _call.gen) { stream.getTracks().forEach(t => t.stop()); return; }
  _call.stream = stream;
  _call.on = true;
  _call.muted = false;
  // 用 AnalyserNode 盯音量做断句（VAD）：说话时音量冲高，停下来 1.2 秒就认为这句说完了
  _call.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = _call.ctx.createMediaStreamSource(_call.stream);
  _call.analyser = _call.ctx.createAnalyser();
  _call.analyser.fftSize = 512;
  src.connect(_call.analyser);
  // 插话用的第二个分析器：平滑压低（默认 0.8 要两三百毫秒才跟上），你一出声 40ms 内就能看见。
  // 断句那个不动——它要的就是平滑，免得字和字之间的小停顿被当成说完了
  _call.bargeAn = _call.ctx.createAnalyser();
  _call.bargeAn.fftSize = 512;
  _call.bargeAn.smoothingTimeConstant = 0.2;
  src.connect(_call.bargeAn);
  _call.barge = callBargeNew(0);
  _call.nudge = callNudgeNew(Date.now());
  _call.say = null; _call.cutCtx = null; _call.lead = null;
  clearTimeout(_call.leadT); _call.leadT = 0;
  // 耳机还是外放：认一次，插拔耳机时再认（认不出来按外放算，宁可难打断一点也别自己打断自己）
  _call.route = 'unknown';
  const reroute = () => _callDetectRoute().then(r => { if (gen === _call.gen) _call.route = r; });
  reroute();
  _call.onDev = reroute;
  try { navigator.mediaDevices.addEventListener?.('devicechange', reroute); } catch {}
  _call.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  // 是你接了它的电话：先让它把「打这通电话想说的那句」念出来，再开始听你说
  if (opts.speakFirst && !(await _callSpeak(opts.speakFirst, { nodeId: opts.speakNodeId }))) return;   // 被打断：那边已经在听了
  if (_call.on && gen === _call.gen) _callListen();
}

// adopt：插话确认了 → 候选期间开的那台录音机直接接过来当「听你说」的这台（你开头那几个字已经在里面了），
// 并且记一笔「这句是插着我的话说的」（cut），转写回来先看是不是附和
function _callListen(adopt) {
  if (!_call.on) return;
  // 旧的那台还在录（合成途中被打断、合成回来又走到这）→ 先拆掉再开新的，
  // 不然 _call.rec 被覆盖，旧 MediaRecorder 没人 stop，在后台一直录
  const old = _call.rec;
  if (old && old !== adopt?.rec) {
    old.ondataavailable = null; old.onstop = null;
    if (old.state === 'recording') { try { old.stop(); } catch {} }
  }
  cancelAnimationFrame(_call.raf);   // VAD 循环也只留一条
  _callBargeDrop(adopt?.rec);        // 插话那套只在我说话时开着；接过来的那台录音机别被它顺手关了
  _call.chunks = adopt?.chunks || [];
  _call.speaking = !!adopt;          // 接过来的时候你正说着
  _call.silenceAt = 0;
  _call.startAt = adopt?.startAt || Date.now();
  _call.cutCtx = adopt?.cut || null;
  if (!adopt && _call.nudge) _call.nudge.quietSince = Date.now();   // 沉默从这一刻重新算
  _call.rec = adopt?.rec || new MediaRecorder(_call.stream, _call.mime ? { mimeType: _call.mime } : undefined);
  _call.rec.ondataavailable = e => { if (e.data?.size) _call.chunks.push(e.data); };
  _call.rec.onstop = () => _callHeard();
  if (!adopt?.rec) _call.rec.start();
  _callPhase('listening', _call.muted ? '已静音' : '在听你说…');
  _callVadLoop();
}

function _callVadLoop() {
  if (!_call.on || _call.phase !== 'listening') return;
  const buf = new Uint8Array(_call.analyser.frequencyBinCount);
  _call.analyser.getByteFrequencyData(buf);
  const vol = buf.reduce((a, b) => a + b, 0) / buf.length;   // 0~255 的平均能量
  const now = Date.now();
  const elapsed = now - _call.startAt;

  if (!_call.muted) {
    if (vol > 18) {                    // 有人在说
      _call.speaking = true;
      _call.silenceAt = 0;
    } else if (_call.speaking) {       // 说过话，现在静下来了
      if (!_call.silenceAt) _call.silenceAt = now;
      if (now - _call.silenceAt > CALL_SILENCE_MS) { _callStopRec(); return; }
    }
    if (_call.speaking && elapsed > CALL_MAX_MS) { _callStopRec(); return; }
  }
  // 安静够久了：问它一句要不要开口（它可以回 [[SILENT]]）。这一帧照样接着听
  if (_callNudgeReady(now)) _callNudge().catch(e => console.warn('[通话] 主动开口失败：', e));
  _call.raf = requestAnimationFrame(_callVadLoop);
}

function _callStopRec() {
  cancelAnimationFrame(_call.raf);
  if (_call.rec?.state === 'recording') { try { _call.rec.stop(); } catch {} }
}

// 一段录音送去转写，回来纯文本（失败抛错）
async function _callStt(blob, mime) {
  const r = await fetch(`${SERVER_BASE}/api/voice-stt?${_sttQuery()}`
    + `&mime=${encodeURIComponent(mime)}&lang=zh`, {
    method: 'POST', headers: { 'Content-Type': mime }, body: blob,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '转写失败');
  return (j.text || '').trim();
}

async function _callHeard() {
  if (!_call.on) return;
  const gen = _call.gen;
  const live = () => _call.on && _call.gen === gen;   // 等转写/等 AI 期间挂了又重拨，别把这轮续到新的一通里
  const dur = Date.now() - _call.startAt;
  const chunks = _call.chunks; _call.chunks = [];
  const cut = _call.cutCtx; _call.cutCtx = null;      // 这句是不是插着我的话说的（是的话我那条已经记了说到哪）
  // 插着我的话说的那句最后没听出东西（太短 / 转写失败 / 空的）：多半是误确认（键盘、电视、旁人说话），
  // 我被打断的那截不能就这么丢了——从断的地方接着说
  const resumeCut = () => { if (!cut || !_callCutRest(cut)) return false; _callResumeCut(cut, gen); return true; };
  if (!chunks.length || dur < CALL_MIN_MS) { if (!resumeCut()) _callListen(); return; }
  _call.linger = false;      // 你在余韵窗口里开口了 → 电话接着打，别挂

  const mime = _call.mime || 'audio/webm';
  const blob = new Blob(chunks, { type: mime });
  _callPhase('thinking', '听清了，正在想…');
  let text;
  try {
    text = await _callStt(blob, mime);
  } catch (e) {
    if (!live()) return;
    if (resumeCut()) return;
    _callStatus('出错了：' + e.message);
    setTimeout(() => { if (live()) _callListen(); }, 1500);
    return;
  }
  if (!live()) return;
  if (!text) {                                          // 只是噪音，接着听
    if (resumeCut()) return;
    _callListen(); return;
  }
  const kind = callClassifyUtterance(text);
  if (cut) {
    // 插着我的话说的，从头到尾只是「嗯嗯对对」：你在附和，不是要我停——从被打断的地方接着往下说
    if (kind === 'backchannel') {
      _callNudgeHeard();                                // 附和也算你回了（主动开口那套别再说「ta 还没回」）
      if (!resumeCut()) _callListen();
      return;
    }
    // 只说了「等等 / 不对」：我已经停了，等你下一句一起发（没下文的话几秒后单发）
    if (kind === 'stop') { _callLeadArm({ text, blob, dur }); _callListen(); return; }
  }
  _callNudgeHeard();                                    // 你开口了：主动开口那套从头计数
  let media = { blob, dur };
  if (_call.lead) {                                     // 前面那句「等等」接在这句话前头一起发（太久以前的就不拼了）
    if (Date.now() - (_call.lead.at || 0) <= CALL_LEAD_MAX_MS) text = _call.lead.text + '，' + text;
    _call.lead = null; clearTimeout(_call.leadT); _call.leadT = 0;
  }
  await _callTurn(text, media, gen);
}

// 你说完了一句：走正常聊天管线发出去 → 等它回 → 念 → 接着听。
// media = { blob, dur }（没有就当打字发）
async function _callTurn(text, media, gen) {
  const live = () => _call.on && _call.gen === gen;
  try {
    // 走正常聊天管线：这句话作为一条语音消息进对话，AI 用完整上下文回你
    const sentAt = Date.now();
    let voice = null;
    if (media?.blob) {
      const audio = await _blobToDataUrl(media.blob);
      const emo = await analyzeVoiceEmotion(media.blob, text, media.dur / 1000);   // 电话里更该听出语气
      voice = { audio, dur: media.dur / 1000, emo };
    }
    // 一起看片：最近一分多钟的画面拼成一张图，跟这句话一起走（没开就什么都不做）
    if (typeof movieAttachForCall === 'function') { try { await movieAttachForCall(); } catch (e) { console.warn('[看片模式]', e); } }
    if (!live()) return;
    // 它正想自己插一句（还在生成）：你开口了，它让——那句作废，你这句接在插嘴之前那条后面
    if (typeof movieChimeYield === 'function') movieChimeYield();
    callNudgeYield();                         // 沉默时它正想开口：同上，让给你
    handleSend(text, voice);

    const ai = await _callWaitAi(sentAt);
    if (!live()) return;
    if (!ai) { _callStatus('AI 没回应…'); _callListen(); return; }
    const wantsHangup = _aiHangupWanted;      // 这条回复里写了 [[HANGUP]]：说完就收线
    _aiHangupWanted = false;
    const spoke = await _callSpeak(getTtsCleanText(ai) || ai.content || '', { nodeId: ai.id, hangup: wantsHangup });
    if (!spoke || !live()) return;            // 被打断了：callInterrupt 那边已经开始听，这里别再开一台
    if (wantsHangup) { _callLinger(live); return; }
    _callListen();
  } catch (e) {
    if (!live()) return;
    _callStatus('出错了：' + e.message);
    setTimeout(() => { if (live()) _callListen(); }, 1500);
  }
}

// 软挂断：不立刻断，先留一段余韵——你这时候再说一句，通话就接着走（callhome 的 lingering window）
function _callLinger(live) {
  _call.linger = true;
  _callListen();
  _callPhase('listening', '他准备挂了…想再说一句还来得及');
  clearTimeout(_call.lingerT);
  _call.lingerT = setTimeout(() => {
    _call.lingerT = 0;
    if (live() && _call.linger && !_call.speaking) { showToast('📞 通话结束'); closeCall(); }
  }, CALL_LINGER_MS);
}

// 等 AI 那边流式回完：轮询到「流起过、现在停了」，或者超时。
// 非流式的模型（比如本地 Claude 走的那条路）压根不会进 _streamControllers，
// 所以也认「节点已经出现且不再变长」这个信号。
function _callWaitAi(afterTs, timeoutMs = 90000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let sawStream = false, lastLen = -1, stableSince = 0;
    const poll = () => {
      if (!_call.on) return resolve(null);
      if (_streamControllers.size > 0) sawStream = true;
      const node = _pickAiNode(afterTs);
      const len = (node?.content || '').length;
      if (len !== lastLen) { lastLen = len; stableSince = Date.now(); }
      const streamDone = sawStream && _streamControllers.size === 0;
      const settled = node && len > 0 && Date.now() - stableSince > 900;   // 内容 0.9 秒没再长
      if (streamDone || settled || Date.now() - t0 > timeoutMs) return resolve(node);
      setTimeout(poll, 200);
    };
    poll();
  });
}
function _pickAiNode(afterTs) {
  const chat = getActiveChat();
  return Object.values(chat?.nodes || {})
    .filter(n => n.role === 'ai' && (n.timestamp || 0) >= afterTs - 500 && (n.content || '').trim())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
}

// AI 说话：走 server.js 的 Edge-TTS（和「🔊 朗读」同一个接口和音色设置）。
// Edge-TTS 要把整段合成完才返回，所以长回复会先干等一会儿——期间给个「正在合成…」，
// 别让用户以为坏了。真的失败时把原因说出来，而不是一句「TTS 挂了」。
// 返回 false = 这句被打断/挂断作废了（打断的那头已经开始听），调用方别再 _callListen
//
// 长回复按句切开、流水线念：第一句合成回来就开始放，放的同时去取下一句。
// 以前是整段合成完才出声——本地情绪声音 RTF 约 0.85，一段 20 秒的回复要先干等 17 秒。
// 短回复（≤30 字）只有一段，和原来完全一样。
const CALL_SPLIT_MIN = 30;
function _callSpeakParts(text) {
  const t = String(text || '').slice(0, 1200);
  if (t.length <= CALL_SPLIT_MIN) return [t];
  const parts = [];
  let cur = '';
  for (const piece of t.split(/(?<=[。！？!?…～~\n])/)) {
    cur += piece;
    if (cur.trim().length >= 10) { parts.push(cur); cur = ''; }   // 太碎的（「嗯。」）并到下一句，一句一请求太亏
  }
  if (cur.trim()) { if (parts.length) parts[parts.length - 1] += cur; else parts.push(cur); }
  return parts.filter(p => p.trim());
}
// 取一段的音频：成功 { url }，失败 { err }，不抛
async function _callFetchPart(text) {
  try {
    const voice = state.ttsVoice || 'zh-CN-XiaoxiaoNeural';
    const r = await fetch(SERVER_BASE + '/api/tts?text=' + encodeURIComponent(text)
      + '&voice=' + encodeURIComponent(voice)
      + '&rate=' + encodeURIComponent(_ttsRateStr())
      + (typeof _ttsStyleParam === 'function' ? _ttsStyleParam(text, voice) : ''));
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('TTS ' + r.status));
    }
    const blob = await r.blob();
    if (!blob.size) throw new Error('合成出来是空的');
    return { url: URL.createObjectURL(blob) };
  } catch (e) { return { err: e }; }
}
// opts.nodeId：念的是哪条 AI 消息（被打断时把「说到哪」记在它身上）；
// opts.full / opts.base：从上次被打断的地方接着念时，text 只是后半截，full 是整段、base 是从第几个字接上
async function _callSpeak(text, opts = {}) {
  if (!text || !_call.on) return _call.on;
  const sid = ++_call.speakId;
  const valid = () => _call.on && sid === _call.speakId;
  _callPhase('speaking', '正在合成语音…');
  const parts = _callSpeakParts(text);
  const say = { sid, parts, i: 0, done: 0, nodeId: opts.nodeId ?? null,
    chatId: opts.chatId ?? (getActiveChat()?.id ?? null),
    full: opts.full ?? String(text), base: opts.base || 0, hangup: !!opts.hangup };
  _call.say = say;
  _callBargeArm();                          // 我说话的时候也听着你（两段式打断）
  // 收尾：这段还归我管（没被打断那头接走）才把插话那套关掉
  const fin = ok => { if (_call.say === say) { _call.say = null; _callBargeDrop(); } return ok; };
  // 合成失败念不下去：没念出来的那截你也没听到，照实记上
  const cutHere = () => _callMarkCut({ chatId: say.chatId, nodeId: say.nodeId, full: say.full,
    n: say.base + callHeardCount(parts, say.done, null) });
  let next = _callFetchPart(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    const got = await next;
    // 下一句趁这句在放的时候取。被打断/挂断就不再取了
    next = i + 1 < parts.length && valid() ? _callFetchPart(parts[i + 1]) : null;
    const drop = () => { if (next) next.then(g => g.url && URL.revokeObjectURL(g.url)); };
    if (got.err) {
      drop();
      if (!valid()) return fin(false);
      cutHere();
      if (i > 0) return fin(true);        // 后面某句念不出来：前面的已经说了，就到这儿
      _callStatus('念不出来：' + got.err.message);
      await new Promise(r => setTimeout(r, 1200));
      return fin(valid());
    }
    // 合成途中被打断了（已经在听你说）/ 挂了：这段不念了
    if (!valid()) { URL.revokeObjectURL(got.url); drop(); return fin(false); }
    say.i = i;
    // 只认连着放完的：中间哪句放不出来（onerror / play 被拒），后面的放完了也不往前推
    if (!(await _callPlay(got.url, valid, () => { if (say.done === i) say.done = i + 1; }))) { drop(); return fin(false); }
  }
  // 念完了：照实记一次——全听到了就摘掉「被打断」标记（接着断的地方念完的那种）；
  // 中间有句没放出来、或者超过 1200 字没念的，也记成没听到
  if (valid()) cutHere();
  return fin(valid());
}
// 放一段；返回 valid()（被打断/挂断 = false）。onEnd：这段真的放完了（不是被暂停/打断）
function _callPlay(url, valid, onEnd) {
  return new Promise(resolve => {
    _callPhase('speaking', '对方正在说…');
    const a = new Audio(url);
    _call.audio = a;
    let fin = false;
    const done = () => {
      if (fin) return;
      fin = true;
      URL.revokeObjectURL(url);
      if (_call.audio === a) _call.audio = null;
      if (_call.speakDone === done) _call.speakDone = null;
      resolve(valid());
    };
    _call.speakDone = done;   // pause() 不触发 onended：打断/挂断时得手动放行，不然这个 promise 永远挂着
    a.onended = () => { if (onEnd) onEnd(); done(); };
    a.onerror = () => { if (valid()) _callStatus('声音放不出来 (´･ω･`)'); done(); };
    // 你正说着（插话的候选窗口里）：这句先别出声，等那边下结论再放（_callBargeResume）
    if (_call.bargeHold) a._held = true;
    else a.play().catch(done);
  });
}

// 它没等你开口、自己说一句（一起看片时的插嘴，见 23-peek.js 的 _movieChime；沉默时主动开口，见 _callNudge）。
// 只在「正在听、你没在说」的时候才开口：先把这台录音收起来（不然它自己的声音会被录进去、
// 当成你说的话发出去），念完再回来听。返回 false = 没念 / 被打断 / 挂了。
async function callSayUnprompted(text, nodeId) {
  if (!text || !_call.on || _call.phase !== 'listening' || _call.speaking) return false;
  const gen = _call.gen;
  const old = _call.rec;
  _call.rec = null;
  if (old) {
    old.onstop = null; old.ondataavailable = null;   // 收起来：别让这台录音停下时走进 _callHeard
    if (old.state === 'recording') { try { old.stop(); } catch {} }
  }
  cancelAnimationFrame(_call.raf);
  _call.chunks = [];
  const spoke = await _callSpeak(text, { nodeId });
  if (spoke && _call.on && _call.gen === gen) _callListen();
  return spoke;
}

// 打断：AI 说到一半不想听了 → 立刻停嘴、马上回来听你说
// 「说到一半」也包括还在合成的那段：作废 speakId，合成回来就不念了
function callInterrupt() {
  if (!_call.on || _call.phase !== 'speaking') return;
  _callCutCommit();                     // 先量你听到了哪儿（得在拿掉 audio 之前）
  _call.speakId++;
  if (_call.audio) { try { _call.audio.pause(); } catch {} _call.audio = null; }
  _call.speakDone?.();
  _callListen();
}

function callToggleMute() {
  if (!_call.on) return;
  _call.muted = !_call.muted;
  _call.stream?.getAudioTracks().forEach(t => (t.enabled = !_call.muted));
  document.querySelector('.call-btn-mute')?.classList.toggle('active', _call.muted);
  if (_call.phase === 'listening') _callPhase('listening', _call.muted ? '已静音' : '在听你说…');
  if (_call.nudge) _call.nudge.quietSince = Date.now();   // 静音那段不算「你安静了」：解除静音别马上被问一句
  showToast(_call.muted ? '麦克风已静音' : '麦克风已打开');
}

function closeCall() {
  _call.on = false;
  _call.gen++; _call.speakId++;        // 等权限 / 等合成的那些异步回来一看不是这通，自己收手
  clearTimeout(_call.lingerT); _call.lingerT = 0; _call.linger = false;
  clearTimeout(_call.leadT); _call.leadT = 0; _call.lead = null;
  cancelAnimationFrame(_call.raf);
  _callBargeDrop();                    // 插话候选开着的那台录音机也得关（不然麦克风灯亮着）
  if (_call.audio) { try { _call.audio.pause(); } catch {} _call.audio = null; }
  _call.speakDone?.();
  if (_call.rec?.state === 'recording') { try { _call.rec.stop(); } catch {} }
  callNudgeYield();                    // 沉默时它正想开口：那句作废
  try { if (_call.onDev) navigator.mediaDevices?.removeEventListener?.('devicechange', _call.onDev); } catch {}
  _call.stream?.getTracks().forEach(t => t.stop());
  if (_call.ctx?.state !== 'closed') { try { _call.ctx?.close(); } catch {} }
  _call.rec = null; _call.stream = null; _call.ctx = null; _call.analyser = null;
  _call.bargeAn = null; _call.onDev = null; _call.say = null; _call.cutCtx = null; _call.nudge = null;
  _call.muted = false;
  if (typeof movieSet === 'function') movieSet(false);   // 挂了就别再拍屏幕
  document.querySelector('.call-btn-mute')?.classList.remove('active');
  document.getElementById('callModal').classList.add('hidden');
}

/* ── 插话（两段式打断）────────────────────────────────────────────── */
// 短附和 / 叫停 / 正常说话 / 空。规则见 CALL_BC_WORDS 上面的注释
function _callSegmentable(s, words) {
  const ok = new Array(s.length + 1).fill(false);
  ok[0] = true;
  for (let i = 0; i < s.length; i++) {
    if (!ok[i]) continue;
    for (const w of words) if (w && s.startsWith(w, i)) ok[i + w.length] = true;
  }
  return ok[s.length];
}
function callClassifyUtterance(text) {
  const raw = String(text || '').trim();
  const s = raw.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!s) return 'empty';
  if (_callSegmentable(s, CALL_BC_WORDS)) return /[?？]\s*$/.test(raw) ? 'stop' : 'backchannel';
  if (CALL_STOP_WORDS.some(w => s.includes(w))
      && _callSegmentable(s, CALL_STOP_WORDS.concat(CALL_BC_WORDS, CALL_STOP_FILLERS))) return 'stop';
  return 'speech';
}

// 你实际听到了几个字：前 done 句整句放完了；cur = { i, t, d } 是正在放的那句（i 必须等于 done 才算）
// 和它的 currentTime / duration。拿不到时长按一秒 CALL_CHARS_PER_SEC 个字估；正念到的那个字不算
function callHeardCount(parts, done, cur) {
  let n = 0;
  const k = Math.max(0, Math.min(done | 0, parts.length));
  for (let j = 0; j < k; j++) n += parts[j].length;
  if (cur && cur.i === k && k < parts.length) {
    const len = parts[k].length;
    const t = Math.max(0, Number(cur.t) || 0), d = Number(cur.d);
    let m;
    if (d > 0 && isFinite(d)) m = t >= d ? len : Math.floor(len * t / d) - CALL_HEARD_LAG_CHARS;
    else m = Math.floor(t * CALL_CHARS_PER_SEC) - CALL_HEARD_LAG_CHARS;
    n += Math.max(0, Math.min(len, m));
  }
  return n;
}

// 耳机还是外放：先看输出设备（默认那个）的名字，认不出再看麦克风的名字；都认不出 = unknown（按外放算）
const CALL_HEADSET_RE = /耳机|耳麦|headphone|headset|earphone|earbud|buds|airpods|bluetooth|蓝牙|hands-?free/i;
function callRouteFromDevices(list) {
  const ds = Array.isArray(list) ? list : [];
  const pick = kind => {
    const xs = ds.filter(d => d && d.kind === kind && d.label);
    return xs.find(d => d.deviceId === 'default') || xs.find(d => d.deviceId === 'communications') || xs[0] || null;
  };
  for (const kind of ['audiooutput', 'audioinput']) {
    const d = pick(kind);
    if (!d) continue;
    if (CALL_HEADSET_RE.test(d.label)) return 'headset';
    if (kind === 'audiooutput') return 'speaker';     // 认得出输出设备、又不像耳机：外放
  }
  return 'unknown';
}
async function _callDetectRoute() {
  try {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return 'unknown';
    return callRouteFromDevices(await md.enumerateDevices());
  } catch { return 'unknown'; }
}
// 设置里的「用嗓子打断」：auto（默认，按认出来的耳机/外放）/ headset / speaker / off（只能点按钮）
function callBargeProfile(mode, route) {
  if (mode === 'off') return null;
  if (mode === 'headset' || (mode !== 'speaker' && route === 'headset')) return CALL_BARGE_PROFILES.headset;
  return CALL_BARGE_PROFILES.speaker;
}

function callBargeNew(echo, echoHi) {
  return { st: 'idle', run: 0, peak: 0, lastT: 0, candAt: 0, lastVoiced: 0, postMs: 0,
    echo: Number(echo) || 0, echoHi: Number(echoHi) || 0, rearmAt: 0, playAt: 0, rec: null, chunks: null, recAt: 0 };
}
/* 两段式打断的状态机，一帧一调。纯函数（只改 b），返回这一帧要做的事：
   'arm'     刚有一帧过门槛 → 先把录音机开起来（等攒够了再开，你开头那几十毫秒就没录上，「停」这种短词容易转错）
   'disarm'  没攒够就静下去了 → 刚开的那台扔掉
   'pause'   你开口了 → 先停播放（录音机已经在录）
   'confirm' 窗口到了你还在说 → 剩下的话作废，开始听你
   'resume'  窗口到了你没在说（咳嗽 / 碰麦 / 回声 / 短附和）→ 接着放
   ''        什么都不做
   playing = 这一帧我真的在出声（回声底噪只在这时候学）
   回声底噪有两层：echo 是跟着走的平均（学得快、忘得也快）；echoHi 是「认出过的回声尖峰」，
   忘得很慢（一秒约 1%）——TTS 念到重音那几下回声会冲高，只靠平均挡不住，会隔一秒误停一次 */
function callBargeStep(b, now, vol, p, playing) {
  const dt = b.lastT ? Math.min(100, Math.max(0, now - b.lastT)) : 16;
  b.lastT = now;
  if (b.st === 'cand') {
    // 播放已经停了：这会儿还有声，就只能是你
    if (vol > CALL_BARGE_VOICED_VOL) { b.postMs += dt; b.lastVoiced = now; }
    if (now - b.candAt < p.windowMs) return '';
    if (now - b.lastVoiced <= CALL_BARGE_RECENT_MS && b.postMs >= CALL_BARGE_MIN_VOICED_MS) { b.st = 'done'; return 'confirm'; }
    // 一暂停声音就没了 = 刚才那下多半是我自己的回声：门槛抬到它的峰值之上，同样响的回声之后就不会再触发
    // （封顶在平均底噪之上 SPAN 格：咳嗽也是「一停就没了」，不封顶的话咳一声门槛就飞上天，之后你正常说话都打断不了）
    if (b.postMs < CALL_BARGE_ECHO_ONLY_MS) b.echoHi = Math.max(b.echoHi, Math.min(b.echo + CALL_BARGE_ECHO_HI_SPAN, b.peak - p.echoPad + CALL_BARGE_ECHO_BUMP));
    b.st = 'idle'; b.run = 0; b.peak = 0; b.rearmAt = now + CALL_BARGE_REARM_MS;
    return 'resume';
  }
  if (b.st !== 'idle') return '';
  const thr = Math.max(p.onVol, playing ? Math.max(b.echo, b.echoHi) + p.echoPad : 0);
  if (playing) {
    if (!b.playAt) b.playAt = now;
    b.echo += (vol - b.echo) * (vol > thr ? 0.02 : 0.1);   // 响的那几帧可能是你，学得慢一点
    b.echoHi *= CALL_BARGE_ECHO_HI_DECAY;
  } else b.playAt = 0;
  const had = b.run > 0;
  if (now < b.rearmAt) {                   // 上一次刚作废：得先安静一会儿
    if (vol > thr) b.rearmAt = now + CALL_BARGE_REARM_MS;
    b.run = 0; b.peak = 0;
    return had ? 'disarm' : '';
  }
  if (vol > thr) { b.run += dt; b.peak = Math.max(b.peak, vol); } else { b.run = 0; b.peak = 0; }
  if (!b.run) return had ? 'disarm' : '';
  // 这句刚开始放（底噪还没学到）/ 还没攒够：先录着，不停
  if (b.run < p.onsetMs || (playing && now - b.playAt < CALL_BARGE_WARM_MS)) return had ? '' : 'arm';
  b.st = 'cand'; b.candAt = now; b.lastVoiced = now; b.postMs = 0;
  return 'pause';
}

function _callBargeVol() {
  const an = _call.bargeAn;
  if (!an) return 0;
  if (!_call.bargeBuf || _call.bargeBuf.length !== an.frequencyBinCount) _call.bargeBuf = new Uint8Array(an.frequencyBinCount);
  const buf = _call.bargeBuf;
  an.getByteFrequencyData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i];
  return buf.length ? s / buf.length : 0;
}
// 我开始说一段：插话状态从头来（回声底噪留着，同一通电话里环境不会突变）
function _callBargeArm() {
  _callBargeDrop();
  _call.barge = callBargeNew(_call.barge ? _call.barge.echo : 0, _call.barge ? _call.barge.echoHi : 0);
  if (_call.bargeAn) _call.bargeRaf = requestAnimationFrame(_callBargeLoop);
}
// 关掉插话那套。keep = 要接过去继续用的那台录音机（别关它）
function _callBargeDrop(keep) {
  cancelAnimationFrame(_call.bargeRaf); _call.bargeRaf = 0;
  const b = _call.barge;
  if (b && b.rec && b.rec !== keep) {
    const r = b.rec;
    r.onstop = null; r.ondataavailable = null;
    if (r.state === 'recording') { try { r.stop(); } catch {} }
  }
  if (b) { b.rec = null; b.chunks = null; b.st = 'idle'; b.run = 0; b.peak = 0; }
  _call.bargeHold = false;
}
function _callBargeLoop() {
  _call.bargeRaf = 0;
  if (!_call.on || _call.phase !== 'speaking' || !_call.bargeAn || !_call.barge) return;
  const b = _call.barge;
  let p = _call.muted ? null : callBargeProfile(state.callBargeMode, _call.route);
  // 一起看片时片子的声音也从喇叭出来：外放下麦克风全是台词，会被当成你在插话。只留按钮（戴耳机不受影响）
  if (p === CALL_BARGE_PROFILES.speaker && typeof _movie !== 'undefined' && _movie.on) p = null;
  if (!p) {
    if (b.st === 'cand') { b.st = 'idle'; _callBargeResume(); }   // 候选途中静音了 / 关掉了：接着放
  } else {
    const act = callBargeStep(b, Date.now(), _callBargeVol(), p, !!_call.audio && !_call.bargeHold);
    if (act === 'arm') _callBargeRecStart();
    else if (act === 'disarm') _callBargeRecDrop();
    else if (act === 'pause') _callBargePause();
    else if (act === 'resume') _callBargeResume();
    else if (act === 'confirm') { _callBargeConfirm(p); return; }
  }
  _call.bargeRaf = requestAnimationFrame(_callBargeLoop);
}
// 你一有声就开录（录的是你从这一刻起说的话）；没攒够就静下去了扔掉
function _callBargeRecStart() {
  const b = _call.barge;
  if (!b || b.rec) return;
  const chunks = [];
  b.chunks = chunks; b.recAt = Date.now();
  try {
    const rec = new MediaRecorder(_call.stream, _call.mime ? { mimeType: _call.mime } : undefined);
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    rec.start();
    b.rec = rec;
  } catch (e) { console.warn('[通话] 插话录音开不起来：', e); }
}
function _callBargeRecDrop() {
  const b = _call.barge;
  const r = b && b.rec;
  if (!r) return;
  b.rec = null; b.chunks = null;
  r.onstop = null; r.ondataavailable = null;
  if (r.state === 'recording') { try { r.stop(); } catch {} }
}
// 第一段：先停嘴（录音机一般在 arm 那一帧就开了，没开的话这会儿补开）
function _callBargePause() {
  _call.bargeHold = true;
  try { _call.audio?.pause(); } catch {}
  _callStatus('嗯？…');
  _callBargeRecStart();
}
// 没确认：往回倒一点接着放；有声够长的话拿去转写，是「等等」这类就真停下来
function _callBargeResume() {
  const b = _call.barge;
  const rec = b.rec, chunks = b.chunks, voiced = b.postMs, sid = _call.speakId;
  const dur = Date.now() - (b.recAt || Date.now());
  b.rec = null; b.chunks = null;
  _call.bargeHold = false;
  const a = _call.audio;
  if (a) {
    if (a._held) a._held = false;
    else { try { a.currentTime = Math.max(0, (Number(a.currentTime) || 0) - CALL_BARGE_REWIND_S); } catch {} }
    try { a.play().catch(() => _call.speakDone?.()); } catch { _call.speakDone?.(); }
  }
  if (_call.phase === 'speaking') _callStatus(a ? '对方正在说…' : '正在合成语音…');
  if (!rec) return;
  rec.onstop = voiced >= CALL_BARGE_CLS_MIN_MS ? () => _callBargeClassify(chunks, sid, dur) : null;
  if (rec.state === 'recording') { try { rec.stop(); } catch {} }
}
async function _callBargeClassify(chunks, sid, dur) {
  if (!chunks || !chunks.length || !_call.on) return;
  const mime = _call.mime || 'audio/webm';
  const blob = new Blob(chunks, { type: mime });
  let text = '';
  try { text = await _callStt(blob, mime); } catch { return; }
  // 转写回来时这段还在念、没被别的打断，才轮得到它拍板
  if (!_call.on || sid !== _call.speakId || _call.phase !== 'speaking') return;
  if (callClassifyUtterance(text) !== 'stop') return;   // 附和 / 没听清 / 别的什么：我接着说
  callInterrupt();
  _callLeadArm({ text, blob, dur });
}
// 第二段：确认了。剩下的话作废；候选期间录的那台接过去当「听你说」的这台
function _callBargeConfirm(p) {
  const b = _call.barge;
  const cut = _callCutCommit();         // 暂停那一刻你听到了哪儿
  const rec = b.rec, chunks = b.chunks, startAt = b.recAt || (b.candAt - p.onsetMs);
  b.rec = null; b.chunks = null;
  _call.speakId++;
  if (_call.audio) { try { _call.audio.pause(); } catch {} _call.audio = null; }
  _call.bargeHold = false;
  _call.speakDone?.();
  if (rec && rec.state === 'recording') _callListen({ rec, chunks, startAt, cut: cut || {} });
  else _callListen();
}

/* ── 说到哪了（heard_text）──────────────────────────────────────────── */
function _callCutNow() {
  const say = _call.say;
  if (!say || say.sid !== _call.speakId) return null;
  const a = _call.audio;
  const cur = a ? { i: say.i, t: a.currentTime, d: a.duration } : null;
  return { chatId: say.chatId, nodeId: say.nodeId, full: say.full, hangup: say.hangup,
    n: say.base + callHeardCount(say.parts, say.done, cur) };
}
// 量一下、记到那条消息上，这段就不归我管了
function _callCutCommit() {
  const c = _callCutNow();
  _call.say = null;
  if (c) _callMarkCut(c);
  return c;
}
function _callCutRest(cut) {
  return cut && cut.full ? String(cut.full).slice(cut.n || 0).trim() : '';
}
function _callFindNode(chatId, nodeId) {
  if (nodeId == null) return null;
  const chats = state.chats || [];
  const c = chats.find(x => x.id === chatId && x.nodes?.[nodeId]) || chats.find(x => x.nodes?.[nodeId]);
  return c ? c.nodes[nodeId] : null;
}
// 在那条 AI 消息上照实记：你听到了前 n 个字。n 到头了 = 其实都听到了 → 摘掉标记
function _callMarkCut(cut) {
  const node = cut && _callFindNode(cut.chatId, cut.nodeId);
  if (!node) return false;
  const full = String(cut.full || '');
  const k = Math.max(0, Math.min(full.length, cut.n | 0));
  if (!full.slice(k).trim()) {
    if (!node.callCut) return false;
    delete node.callCut;
  } else {
    node.callCut = { heard: full.slice(0, k), unheard: full.slice(k), at: Date.now() };
  }
  save();
  _invalidateNodeCache(node.id);
  renderMessages();
  return true;
}
// 你附和完了：从被打断的地方接着往下说
async function _callResumeCut(cut, gen) {
  const live = () => _call.on && _call.gen === gen;
  try {
    const rest = String(cut.full).slice(cut.n || 0);
    const spoke = await _callSpeak(rest, { nodeId: cut.nodeId, chatId: cut.chatId, full: cut.full, base: cut.n || 0, hangup: cut.hangup });
    if (!spoke || !live()) return;
    if (cut.hangup) _callLinger(live);     // 被打断的那条本来写了 [[HANGUP]]：接着念完了，照样进余韵
    else _callListen();
  } catch (e) {
    console.warn('[通话] 接着念失败：', e);
    if (live()) _callListen();
  }
}
// 发给模型的那条 AI 消息前面加这句（05-prompts-api.js 的 buildApiMessages 调）
function callCutNoteForApi(cut) {
  const heard = String(cut?.heard || '').trim(), un = String(cut?.unheard || '').trim();
  if (!un) return '';
  const at = heard ? `说到「…${heard.slice(-40)}」` : '一个字都还没念出来';
  return `【电话里这条你${at}就被 ta 打断了，ta 实际只听到了前面这些。`
    + `后面「${un.slice(0, 300)}${un.length > 300 ? '…' : ''}」ta 没听到——别当 ta 听过】`;
}
// 气泡底下那行小字（06-render-msg.js 调）
function callCutHtml(m) {
  const c = m && m.callCut;
  const un = String(c?.unheard || '').trim();
  if (!un) return '';
  const h = String(c.heard || '').trim();
  const at = h ? `「…${h.slice(-12)}」` : '开头';
  return `<div class="call-cut-note" title="${escHtml('没说出口的：' + un.slice(0, 200))}">📞 电话里说到${escHtml(at)}被打断了 · 后面 ${un.length} 字没说出口</div>`;
}

/* ── 你说了「等等」：我停下来等你下一句 ─────────────────────────────── */
function _callLeadArm(lead) {
  if (!lead.at) lead.at = Date.now();
  _call.lead = lead;
  clearTimeout(_call.leadT);
  const gen = _call.gen;
  _call.leadT = setTimeout(() => {
    _call.leadT = 0;
    const l = _call.lead;
    if (!l || !_call.on || _call.gen !== gen) return;
    if (_call.phase !== 'listening' || _call.speaking) {
      // 你已经接着说了 / 我在念别的：过会儿再看。挂太久就算了（不然「等等，」会拼到很久以后的一句前面，
      // 沉默时主动开口也一直被它挡着）
      if (Date.now() - l.at > CALL_LEAD_MAX_MS) { if (_call.lead === l) _call.lead = null; return; }
      _callLeadArm(l);
      return;
    }
    _call.lead = null;
    const r = _call.rec; _call.rec = null;                       // 空录的这台收起来，别让它停下时走进 _callHeard
    if (r) { r.onstop = null; r.ondataavailable = null; if (r.state === 'recording') { try { r.stop(); } catch {} } }
    cancelAnimationFrame(_call.raf);
    _callNudgeHeard();
    _callPhase('thinking', '听清了，正在想…');
    _callTurn(l.text, l.blob ? { blob: l.blob, dur: l.dur } : null, gen);
  }, CALL_LEAD_WAIT_MS);
}

/* ── 沉默时主动开口 ─────────────────────────────────────────────────── */
let _callNudgePending = null;     // 这一轮是「安静了 N 秒」那一问 → buildSystemPrompt 读一次就清
function callNudgeNew(now) { return { quietSince: now, tries: 0, unanswered: 0, busy: false, ch: null }; }
// 纯判断：这会儿该不该问它一次。第 k 次问要安静满 12s × 2^k
function callNudgeDue(n, now) {
  if (!n || n.busy) return false;
  if (n.unanswered >= CALL_NUDGE_MAX_UNANSWERED || n.tries >= CALL_NUDGE_MAX_TRIES) return false;
  return now - n.quietSince >= CALL_NUDGE_SILENCE_MS * Math.pow(2, n.tries);
}
function _callNudgeHeard() {
  const n = _call.nudge;
  if (n) { n.tries = 0; n.unanswered = 0; n.quietSince = Date.now(); }
}
function _callNudgeReady(now) {
  if (state.callNudgeOff || !_call.nudge) return false;
  if (!_call.on || _call.phase !== 'listening' || _call.speaking || _call.muted || _call.linger || _call.lead) return false;
  if (typeof _movie !== 'undefined' && _movie.on) return false;   // 一起看的时候由插嘴那套管，别两套一起说
  if (typeof _streamControllers !== 'undefined' && _streamControllers.size) return false;
  return callNudgeDue(_call.nudge, now);
}
// 和偷看屏幕 / 一起看插嘴同一套：挂一条「这条不是你说的」peek 消息 → 让它回 → [[SILENT]] 就什么都没发生
async function _callNudge() {
  const n = _call.nudge;
  if (!n || n.busy) return false;
  n.tries++;                          // 先占住这次机会：问不成也算，宁可少问
  const chat = getActiveChat();
  const ids = getActiveChatModelIds();
  const conf = ids.length === 1 ? state.configs.find(c => c.id === ids[0]) : null;
  if (!chat || chat.ended || chat.isGroupChat || !conf) return false;
  const now = Date.now();
  const secs = Math.max(1, Math.round((now - n.quietSince) / 1000));
  const gen = _call.gen;
  n.busy = true;
  if (!chat.nodes) chat.nodes = {};
  const base = chat.headId;
  const msgId = nextId();
  const who = (state.userName || '').trim() || '用户';
  chat.nodes[msgId] = {
    id: msgId, parentId: base, role: 'user', peek: true, callNudge: true,
    content: `（这条不是${who}说的）电话里已经安静了 ${secs} 秒。`,
    tokens: 0, timestamp: now,
  };
  chat.headId = msgId;
  const ch = { chatId: chat.id, msgId, base, cancelled: false };
  n.ch = ch;
  _callNudgePending = { secs, unanswered: n.unanswered };
  save(); renderMessages();
  let wantsHangup = false;
  try {
    await callAPI(conf, getMessagePath(chat, msgId), chat, msgId);
  } catch (e) {
    console.warn('[通话] 主动开口那一轮出错：', e.message);
  } finally {
    wantsHangup = _aiHangupWanted; _aiHangupWanted = false;   // 这一轮写的 [[HANGUP]] 归这一轮，别漏给下一句（出错了也清）
    _callNudgePending = null;
    n.busy = false;
    if (n.ch === ch) n.ch = null;
  }
  // 云同步合并会整个换掉对话对象，按 id 重新找一次
  const cur = (state.chats || []).find(c => c.id === ch.chatId) || chat;
  const ai = Object.values(cur.nodes || {}).find(x => x.parentId === msgId && x.role === 'ai');
  if (!ai) { if (cur.nodes?.[msgId]) _callNudgeDrop(ch); return false; }   // 回了 [[SILENT]]：peekDropSilent 已经收走了
  const text = String(getTtsCleanText(ai) || ai.content || '').trim();
  // 想的这几秒里：你开口了 / 挂了又重拨 / 出错了没说出东西 → 整段收走
  if (ch.cancelled || !text || cur.headId !== ai.id || !_call.on || _call.gen !== gen
      || _call.phase !== 'listening' || _call.speaking) {
    _callNudgeDrop(ch);
    return false;
  }
  n.unanswered++;
  const spoke = await callSayUnprompted(text, ai.id);
  if (spoke && wantsHangup && _call.on && _call.gen === gen) _callLinger(() => _call.on && _call.gen === gen);
  return spoke;
}
// 一次没说出口的主动开口：那条「安静了 N 秒」和它没念出来的回复都从时间线上收走
function _callNudgeDrop(ch) {
  const chat = (state.chats || []).find(c => c.id === ch.chatId);
  if (!chat?.nodes) return;
  const gone = new Set([ch.msgId]);
  Object.values(chat.nodes).forEach(x => { if (x.parentId === ch.msgId) gone.add(x.id); });
  if (gone.has(chat.headId)) chat.headId = ch.base;
  gone.forEach(id => delete chat.nodes[id]);
  save(); renderMessages();
}
// 你开口了 / 挂断：它正想开口的那句让掉（流还在往节点里写，等那轮收完尾 _callNudge 自己删）
function callNudgeYield() {
  const ch = _call.nudge?.ch;
  if (!ch || ch.cancelled) return;      // 让过一次就够了：再掐一次流会掐到你这一轮的回复
  ch.cancelled = true;
  const chat = (state.chats || []).find(c => c.id === ch.chatId);
  if (!chat) return;
  if (chat.headId !== ch.base) chat.headId = ch.base;
  try { if (typeof abortChatStreams === 'function') abortChatStreams(chat); } catch {}
}
// buildSystemPrompt 调它（只进 volatile）
function takeCallNudgeMoment() {
  const p = _callNudgePending;
  _callNudgePending = null;
  if (!p || !_call.on) return '';
  const who = (state.userName || '').trim() || '用户';
  let s = `\n\n[电话 · 安静了一会儿 · 这一轮不是${who}在说话] 最后那条「用户消息」不是 ta 说的，是系统告诉你：`
    + `电话里已经安静了 ${p.secs} 秒——麦克风开着，ta 没出声。`;
  if (p.unanswered > 0) s += `你刚才已经主动开过口了，ta 还没回。`;
  s += `\n要不要开口，你自己决定：想说就像打电话那样自然地说一句（口语，一两句）——接着刚才的话、想到什么说什么、或者就是想叫叫 ta。`
    + `别查岗（「你还在吗」「怎么不说话了」），别催 ta 说话，也别问要不要挂电话。`
    + `\nta 可能在想事情、手上在忙、或者就是想安安静静挂着电话陪着你——这时候安静陪着才对：只回复 [[SILENT]]，这一轮什么都不会发生，ta 也不会知道你想过。`;
  return s;
}

// 通话壁纸：和聊天背景同一套（URL 或本地图 base64，存 state.callBg）
function renderCallBg() {
  const modal = document.getElementById('callModal');
  if (!modal) return;
  modal.style.backgroundImage = state.callBg ? `url('${state.callBg}')` : '';
  modal.classList.toggle('has-bg', !!state.callBg);
  modal.style.setProperty('--call-mask', state.callBgMask ?? 0.82);
  modal.style.setProperty('--call-blur', (state.callBgBlur ?? 2) + 'px');
}
// 打开设置时把壁纸输入框和两个滑块拨到当前值（settings 面板和 hub 里各调一次）
function syncCallBgUI() {
  const inp = document.getElementById('callBgInput');
  if (inp) inp.value = (state.callBg || '').startsWith('data:') ? '（已选本地图片）' : (state.callBg || '');
  const mr = document.getElementById('callMaskRange'), ml = document.getElementById('callMaskLabel');
  if (mr) { mr.value = state.callBgMask ?? 0.82; ml.innerText = (state.callBgMask ?? 0.82).toFixed(2); }
  const br = document.getElementById('callBlurRange'), bl = document.getElementById('callBlurLabel');
  if (br) { br.value = state.callBgBlur ?? 2; bl.innerText = (state.callBgBlur ?? 2).toFixed(1) + 'px'; }
  const mc = document.getElementById('movieChimeSelect');
  if (mc) mc.value = String(state.movieChimeMin ?? 4);
  const bs = document.getElementById('callBargeSelect');
  if (bs) bs.value = state.callBargeMode || 'auto';
  const ns = document.getElementById('callNudgeSelect');
  if (ns) ns.value = state.callNudgeOff ? 'off' : 'on';
}
function setMovieChimeMin(v) {
  state.movieChimeMin = Math.max(0, parseInt(v, 10) || 0);
  save();
}
function setCallBargeMode(v) {
  state.callBargeMode = ['auto', 'headset', 'speaker', 'off'].includes(v) ? v : 'auto';
  save();
}
function setCallNudge(v) {
  state.callNudgeOff = v === 'off';
  save();
}
function updateCallMask(val) {
  state.callBgMask = parseFloat(val);
  document.getElementById('callModal')?.style.setProperty('--call-mask', state.callBgMask);
  save();
}
function updateCallBlur(val) {
  state.callBgBlur = parseFloat(val);
  document.getElementById('callModal')?.style.setProperty('--call-blur', state.callBgBlur + 'px');
  save();
}
function applyCallBgBtn() {
  const val = document.getElementById('callBgInput')?.value.trim();
  // 输入框里显示的是「（已选本地图片）」这个占位提示时，别把提示语当成图片链接存进去
  if (!val || val.startsWith('（')) return;
  state.callBg = val; renderCallBg(); save();
  showToast('✓ 通话壁纸已更新', 'success');
}
function handleCallBgUpload(input) {
  const file = input.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = e => {
    state.callBg = e.target.result;
    renderCallBg(); save();
    showToast('✓ 通话壁纸已更新', 'success');
  };
  r.readAsDataURL(file);
  input.value = '';
}
function clearCallBg() {
  state.callBg = '';
  renderCallBg();
  const inp = document.getElementById('callBgInput');
  if (inp) inp.value = '';
  save();
}

// ── 数学公式输入面板 ──────────────────────────────────────
// 常用符号/模板：label 显示在按钮上，tex 插入到公式输入框（$1 处为光标停留位）
const _MATH_SYMBOLS = [
  { l:'x²', t:'^{2}' }, { l:'xⁿ', t:'^{}' }, { l:'x₁', t:'_{}' },
  { l:'√', t:'\\sqrt{}' }, { l:'ⁿ√', t:'\\sqrt[n]{}' }, { l:'a/b', t:'\\frac{}{}' },
  { l:'∫', t:'\\int_{}^{}' }, { l:'∑', t:'\\sum_{}^{}' }, { l:'∏', t:'\\prod_{}^{}' },
  { l:'lim', t:'\\lim_{x \\to }' }, { l:'∂', t:'\\partial' }, { l:'∇', t:'\\nabla' },
  { l:'∞', t:'\\infty' }, { l:'±', t:'\\pm' }, { l:'×', t:'\\times' }, { l:'÷', t:'\\div' },
  { l:'≤', t:'\\leq' }, { l:'≥', t:'\\geq' }, { l:'≠', t:'\\neq' }, { l:'≈', t:'\\approx' },
  { l:'→', t:'\\to' }, { l:'⇒', t:'\\Rightarrow' }, { l:'∈', t:'\\in' }, { l:'∉', t:'\\notin' },
  { l:'⊂', t:'\\subset' }, { l:'∪', t:'\\cup' }, { l:'∩', t:'\\cap' }, { l:'∀', t:'\\forall' },
  { l:'∃', t:'\\exists' }, { l:'α', t:'\\alpha' }, { l:'β', t:'\\beta' }, { l:'γ', t:'\\gamma' },
  { l:'θ', t:'\\theta' }, { l:'λ', t:'\\lambda' }, { l:'μ', t:'\\mu' }, { l:'π', t:'\\pi' },
  { l:'σ', t:'\\sigma' }, { l:'φ', t:'\\phi' }, { l:'ω', t:'\\omega' }, { l:'Δ', t:'\\Delta' },
  { l:'Ω', t:'\\Omega' }, { l:'vec', t:'\\vec{}' }, { l:'hat', t:'\\hat{}' }, { l:'( )', t:'\\left( \\right)' },
  { l:'[矩阵]', t:'\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
  { l:'{分段', t:'\\begin{cases} a & x>0 \\\\ b & x\\le 0 \\end{cases}' },
];
