'use strict';
// 麦克风 / 摄像头 / 通话的「异步回来晚了」那一类竞态（2026-09-27 review 挑出来的一串）
//
// 共同形状：await getUserMedia / fetch 期间，用户已经松手、关相机、挂电话、按打断了，
// 但 await 回来的那段代码不知道，照样把流挂上去、开录、开播 —— 结果是
// 麦克风灯常亮、后台偷录、60 秒后自动发出去一条语音、下一通电话被上一通的计时器挂掉。
// 全部零报错，界面看着一切正常。
//
// 这里在 vm 里真跑 js/10-stickers-voice.js、js/11-camera-call.js 里的函数（funcBody 切出来），
// getUserMedia / fetch / play() 都换成测试手里攥着的 promise，想让它什么时候回来就什么时候回来。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SV = read('js/10-stickers-voice.js');
const CC = read('js/11-camera-call.js');

// 切出整个函数（含 async 前缀）；源码里找不到就返回空串，让下面的「切得出」断言红
function funcBody(s, name) {
  let i = s.indexOf('function ' + name + '(');
  if (i < 0) return '';
  if (s.slice(i - 6, i) === 'async ') i -= 6;
  // 先跳过参数表：openCall(opts = {}) 的默认值里就有一对花括号
  let p = 0, k = s.indexOf('(', i);
  for (; k < s.length; k++) { if (s[k] === '(') p++; else if (s[k] === ')' && --p === 0) break; }
  let d = 0, started = false;
  for (let j = k; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
// 切出 `const X = { ... };` 这样的对象字面量，改成 var 让测试从外面读得到
function objDecl(s, name) {
  const head = 'const ' + name + ' = {';
  const i = s.indexOf(head);
  if (i < 0) return '';
  let d = 0;
  for (let j = i + head.length - 1; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}') { d--; if (d === 0) return 'var ' + s.slice(i + 6, j + 1) + ';'; }
  }
  return '';
}

// 源码顶层所有 `const CALL_XXX = …;`（含跨行的对象 / 数组 / 正则）原样搬进沙箱，改成 var
function callConsts() {
  const names = [...CC.matchAll(/^const (CALL_[A-Z_]+) = /gm)].map(m => m[1]);
  return names.map(n => {
    const i = CC.search(new RegExp('^const ' + n + ' = ', 'm'));
    let d = 0;
    for (let j = i; j < CC.length; j++) {
      const ch = CC[j];
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
      else if (ch === ';' && d === 0) return 'var ' + CC.slice(i + 6, j + 1);
    }
    return '';
  }).join('\n');
}

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function deferred() { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; }

// 假时钟：setTimeout 只记账，advance 才触发
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
// 假流：每条 track 记自己被 stop 了几次
let _sid = 0;
function mkStream(tag) {
  const tracks = [{ stopped: 0, enabled: true, stop() { this.stopped++; } }];
  return { id: ++_sid, tag, tracks, getTracks: () => tracks, getAudioTracks: () => tracks };
}
const live = s => s.tracks.some(tr => !tr.stopped);
function fakeGum() {
  const calls = [];
  const fn = (constraints) => {
    const d = deferred();
    calls.push({ constraints, stream: mkStream(constraints?.video?.facingMode), res: () => d.res(calls.find(c => c.p === d.p).stream), rej: e => d.rej(e), p: d.p });
    return d.p;
  };
  return { fn, calls };
}
function fakeRecorderClass(list) {
  class R {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; list.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 5 } });
      this.stopResult = this.onstop?.();
    }
  }
  R.isTypeSupported = () => true;
  return R;
}
const classList = () => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)), contains: x => s.has(x), toggle: (x, on) => (on ? s.add(x) : s.delete(x)), _s: s }; };

(async () => {
  /* ═════════ 一、按住说话：权限还没回来就松手 / 连按两下 ═════════ */
  function voiceBox() {
    const clock = fakeClock();
    const gum = fakeGum();
    const recs = [];
    const btnH = {}, docH = {};
    const btn = { classList: classList(), textContent: '', dataset: {}, addEventListener: (ty, f) => { btnH[ty] = f; } };
    const box = {
      navigator: { mediaDevices: { getUserMedia: gum.fn } },
      MediaRecorder: fakeRecorderClass(recs),
      document: { readyState: 'complete', getElementById: id => (id === 'voiceHoldBtn' ? btn : null), addEventListener: (ty, f) => { docH[ty] = f; } },
      showToast: m => box.__toasts.push(m), __toasts: [],
      _sttReady: () => true,
      _finishVoiceRecording: mime => box.__finished.push(mime), __finished: [],
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date, Math, console,
    };
    vm.createContext(box);
    vm.runInContext('var _rec = null, _recChunks = [], _recStream = null, _recStartAt = 0, _recCancelled = false, _recMaxTimer = null;'
      + 'var _recStarting = false, _recReleased = false; var VOICE_MAX_SEC = 60;'
      + funcBody(SV, '_voiceHoldBtn') + funcBody(SV, 'startVoiceRecording') + funcBody(SV, 'stopVoiceRecording')
      + '(' + funcBody(SV, 'initVoiceHold') + ')();', box);
    const down = () => btnH.mousedown({ clientY: 100 });
    const up = () => docH.mouseup({});
    return { box, clock, gum, recs, btnH, docH, down, up };
  }
  t('funcBody 切得出录音那几个函数', ['startVoiceRecording', 'stopVoiceRecording', 'initVoiceHold'].every(n => funcBody(SV, n).length > 50));

  console.log('\n【一·对照】正常按住 → 录 → 松手发出去');
  {
    const v = voiceBox();
    v.down(); v.gum.calls[0].res(); await flush();
    t('流回来后开录', v.recs.length === 1 && v.recs[0].state === 'recording');
    v.up(); await flush();
    t('松手：录音停了、转写那步被叫到一次', v.recs[0].state === 'inactive' && v.box.__finished.length === 1);
    t('松手：麦克风关了', !live(v.gum.calls[0].stream));
  }

  console.log('\n【一·A】轻点一下（或松手去点权限弹窗），流才回来');
  {
    const v = voiceBox();
    v.down(); v.up();
    v.gum.calls[0].res(); await flush();
    t('松手之后流才回来：不开录', v.recs.length === 0, v.recs.length);
    t('那路麦克风当场关掉', !live(v.gum.calls[0].stream));
    t('没挂 60 秒自动发送的计时器', v.clock.pending() === 0, v.clock.pending());
    v.clock.advance(61000); await flush();
    t('61 秒后也没自动转写发出去', v.box.__finished.length === 0, v.box.__finished.length);
  }

  console.log('\n【一·B】权限没回来前连按两下');
  {
    const v = voiceBox();
    v.down(); v.down();
    v.gum.calls.forEach(c => c.res()); await flush();
    t('同一时间最多一台录音机', v.recs.filter(r => r.state === 'recording').length <= 1, v.recs.length);
    const alive = v.gum.calls.filter(c => live(c.stream));
    t('活着的流最多一路、而且就是在录的那路', alive.length <= 1 && (!alive.length || alive[0].stream === v.box._recStream), alive.length);
    v.up(); await flush();
    t('松手后所有拿到过的麦克风都关了', v.gum.calls.every(c => !live(c.stream)), v.gum.calls.map(c => live(c.stream)));
  }

  console.log('\n【一·C】等权限时来电/系统手势打断（touchcancel）');
  {
    const v = voiceBox();
    v.btnH.touchstart({ preventDefault() {}, touches: [{ clientY: 0 }] });
    v.btnH.touchcancel();
    v.gum.calls[0].res(); await flush();
    t('touchcancel 后流回来：不开录', v.recs.length === 0, v.recs.length);
    t('touchcancel 后流回来：麦克风关掉', !live(v.gum.calls[0].stream));
  }

  console.log('\n【一·D】松手了又在权限回来前重新按住');
  {
    const v = voiceBox();
    v.down(); v.up(); v.down();
    v.gum.calls.forEach(c => c.res()); await flush();
    t('按着的那次照常开录', v.recs.length >= 1 && v.recs[v.recs.length - 1].state === 'recording');
    v.up(); await flush();
    t('松手后所有麦克风都关了', v.gum.calls.every(c => !live(c.stream)));
  }

  console.log('\n【一·E】权限被拒不能把按钮卡死');
  {
    const v = voiceBox();
    v.down(); v.gum.calls[0].rej(Object.assign(new Error('no'), { name: 'NotAllowedError' })); await flush();
    t('拒了有提示', v.box.__toasts.some(m => m.includes('权限')));
    v.up(); v.down();
    t('再按一次会重新申请麦克风', v.gum.calls.length === 2, v.gum.calls.length);
  }

  /* ═════════ 二、语音气泡：A 的晚到 AbortError 不许误杀 B ═════════ */
  function playBox() {
    const revoked = [], audios = [];
    let n = 0;
    class FakeAudio {
      constructor(src) { this.src = src; this._d = deferred(); audios.push(this); }
      play() { return this._d.p; }
      pause() { this.paused = true; }
    }
    const box = {
      getActiveChat: () => ({ nodes: { a: { audio: 'data:audio/webm;base64,AA' }, b: { audio: 'data:audio/webm;base64,BB' } } }),
      _dataUrlToBlob: s => ({ s }),
      URL: { createObjectURL: () => 'blob:' + (++n), revokeObjectURL: u => revoked.push(u) },
      Audio: FakeAudio,
      document: { querySelectorAll: () => [] },
      showToast() {}, console,
    };
    vm.createContext(box);
    vm.runInContext('var _voiceAudio = null, _voiceObjUrl = null;' + funcBody(SV, 'playVoiceMsg'), box);
    return { box, revoked, audios };
  }
  const mkEl = () => ({ classList: classList() });
  t('funcBody 切得出 playVoiceMsg', funcBody(SV, 'playVoiceMsg').length > 50);

  console.log('\n【二】播 A 时点 B，A 的 play() 晚一步被 AbortError 打回来');
  {
    const p = playBox();
    const elA = mkEl(), elB = mkEl();
    p.box.playVoiceMsg('a', elA);
    p.box.playVoiceMsg('b', elB);
    const [A, B] = p.audios;
    A._d.rej(Object.assign(new Error('abort'), { name: 'AbortError' })); await flush();
    t('B 还是当前在播的那条', p.box._voiceAudio === B);
    t('B 的 blob url 没被 A 收走', !p.revoked.includes(B.src), p.revoked);
    t('B 的气泡还亮着 playing', elB.classList.contains('playing'));
    t('A 自己的 url 收掉了', p.revoked.includes(A.src));
    B.onended(); await flush();
    t('B 播完：全局清空、url 收掉、气泡熄灭', p.box._voiceAudio === null && p.revoked.includes(B.src) && !elB.classList.contains('playing'));
  }
  console.log('\n【二·同一条】同一个气泡连点两下');
  {
    const p = playBox();
    const el = mkEl();
    p.box.playVoiceMsg('a', el);
    p.box.playVoiceMsg('a', el);
    const [A1, A2] = p.audios;
    A1._d.rej(new Error('abort')); await flush();
    t('第二次播放的气泡没被第一次的收尾熄灭', el.classList.contains('playing'));
    t('第二次的 url 活着', !p.revoked.includes(A2.src));
  }

  /* ═════════ 三、面板切换：输入栏的 z-index 不许被上一个面板的尾巴清掉 ═════════ */
  console.log('\n【三】关一个面板 50ms 后开另一个（加号菜单 → 表情面板）');
  {
    const clock = fakeClock();
    const rafQ = [];
    const wrap = { style: {}, classList: classList(), offsetHeight: 60, getBoundingClientRect: () => ({ bottom: 780 }) };
    const box = {
      _isMobile: () => true, _plusInputWrap: () => wrap,
      requestAnimationFrame: f => rafQ.push(f), innerHeight: 800, Math,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(funcBody(SV, '_liftInput') + funcBody(SV, '_dropInput'), box);
    const flushRaf = () => { while (rafQ.length) rafQ.shift()(); };
    const panel = { offsetHeight: 300 };
    box._liftInput(panel); flushRaf();
    t('开面板：输入栏浮到 502', wrap.style.zIndex === '502');
    box._dropInput();
    clock.advance(50);
    box._liftInput(panel); flushRaf();
    clock.advance(400);
    t('新面板开着时 z-index 仍是 502（没被上一个的 240ms 尾巴清掉）', wrap.style.zIndex === '502', wrap.style.zIndex);
    t('过渡动画也没被清掉', !!wrap.style.transition, wrap.style.transition);
    box._dropInput(); clock.advance(400);
    t('对照：真关掉之后 240ms 照常清回去', wrap.style.zIndex === '');
  }

  /* ═════════ 四、语音情绪：解码抛了也得关 AudioContext ═════════ */
  console.log('\n【四】analyzeVoiceEmotion 解码失败');
  {
    const ctxs = [];
    let decodeOk = false;
    class AC {
      constructor() { this.closed = 0; ctxs.push(this); }
      decodeAudioData() {
        return decodeOk ? Promise.resolve({ getChannelData: () => new Float32Array(10), sampleRate: 16000 })
          : Promise.reject(new Error('EncodingError'));
      }
      close() { this.closed++; return Promise.resolve(); }
    }
    const box = { console: { warn() {}, log() {} }, Math, Float32Array };
    box.window = box; box.AudioContext = AC;
    vm.createContext(box);
    vm.runInContext(funcBody(SV, 'analyzeVoiceEmotion'), box);
    const blob = { arrayBuffer: async () => new ArrayBuffer(8) };
    const r = await box.analyzeVoiceEmotion(blob, 'x', 1);
    t('解码失败返回 null', r === null);
    t('解码失败也把 AudioContext 关了', ctxs[0].closed === 1, ctxs[0].closed);
    decodeOk = true;
    await box.analyzeVoiceEmotion(blob, 'x', 1);
    t('对照：解码成功只关一次', ctxs[1].closed === 1, ctxs[1].closed);
  }

  /* ═════════ 五、相机：等权限时关相机 / 连点翻转 ═════════ */
  function camBox() {
    const gum = fakeGum();
    const els = {
      camHint: { style: {}, textContent: '', innerHTML: '' },
      camVideo: { srcObject: null, play: () => Promise.resolve() },
      cameraModal: { classList: classList() },
    };
    const box = {
      navigator: { mediaDevices: { getUserMedia: gum.fn } },
      document: { getElementById: id => els[id] },
      cancelCrop() {}, escHtml: s => s, console: { warn() {} },
    };
    vm.createContext(box);
    vm.runInContext("var _camStream = null, _camFacing = 'environment', _camShotData = null, _camGen = 0;"
      + funcBody(CC, '_startCamStream') + funcBody(CC, '_stopCamStream') + funcBody(CC, 'flipCamera') + funcBody(CC, 'closeCamera'), box);
    return { box, gum, els };
  }
  t('funcBody 切得出相机那几个函数', ['_startCamStream', '_stopCamStream', 'flipCamera', 'closeCamera'].every(n => funcBody(CC, n).length > 30));

  console.log('\n【五·对照】正常打开');
  {
    const c = camBox();
    const p = c.box._startCamStream(); c.gum.calls[0].res(); await p;
    t('流挂上了、提示收了', c.box._camStream === c.gum.calls[0].stream && c.els.camVideo.srcObject === c.box._camStream && c.els.camHint.style.display === 'none');
    t('流没被误关', live(c.gum.calls[0].stream));
  }
  console.log('\n【五·A】权限弹窗还在，先点了取消');
  {
    const c = camBox();
    const p = c.box._startCamStream();
    c.box.closeCamera();
    c.gum.calls[0].res(); await p;
    t('晚回来的流当场关掉（摄像头灯灭）', !live(c.gum.calls[0].stream));
    t('关掉的相机不再持有流', c.box._camStream === null && c.els.camVideo.srcObject === null);
  }
  for (const order of ['先回先到', '后发先到']) {
    console.log(`\n【五·B】连点两下翻转（${order}）`);
    const c = camBox();
    const p1 = c.box.flipCamera(), p2 = c.box.flipCamera();
    const [g1, g2] = c.gum.calls;
    if (order === '先回先到') { g1.res(); await flush(); g2.res(); }
    else { g2.res(); await flush(); g1.res(); }
    await Promise.all([p1, p2]);
    const alive = c.gum.calls.filter(x => live(x.stream));
    t('只剩一路活着的流', alive.length === 1, alive.length);
    t('活着的是最后一次翻转要的那路、并且挂在 video 上', alive[0] === g2 && c.box._camStream === g2.stream && c.els.camVideo.srcObject === g2.stream);
  }

  /* ═════════ 六、通话 ═════════ */
  function callBox() {
    const clock = fakeClock();
    const gum = fakeGum();
    const recs = [], audios = [], toasts = [], revoked = [];
    let urlN = 0;
    const tts = [];            // 每次 /api/tts 的 deferred，测试自己决定什么时候回
    const els = {
      callModal: { classList: classList() }, callAvatar: { classList: classList(), innerHTML: '', textContent: '' },
      callName: { textContent: '' }, callStatus: { textContent: '' },
    };
    class FakeAudio {
      constructor(src) { this.src = src; audios.push(this); }
      play() { this.playing = true; if (box.__autoEnd) Promise.resolve().then(() => this.onended?.()); return Promise.resolve(); }
      pause() { this.paused = true; }
    }
    class AC {
      constructor() { this.state = 'running'; }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 4, getByteFrequencyData() {} }; }
      close() { this.state = 'closed'; }
    }
    const box = {
      __autoEnd: true, __ai: { role: 'ai', content: '好的' },
      navigator: { mediaDevices: { getUserMedia: gum.fn } },
      MediaRecorder: fakeRecorderClass(recs), Audio: FakeAudio, AudioContext: AC,
      Blob: class { constructor(parts, o) { this.parts = parts; this.type = o?.type; this.size = 5; } },
      URL: { createObjectURL: () => 'blob:tts' + (++urlN), revokeObjectURL: u => revoked.push(u) },
      document: { getElementById: id => els[id] || null, querySelector: () => null },
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      showToast: m => toasts.push(m), escHtml: s => s, renderCallBg() {},
      save() {}, renderMessages() {}, _invalidateNodeCache() {},
      state: { configs: [{ id: 1, nickname: '克克' }], ttsVoice: '' },
      getActiveChatModelIds: () => [1], getActiveChat: () => ({ nodes: {} }),
      _sttReady: () => true, _sttQuery: () => '', _ttsRateStr: () => '+0%', SERVER_BASE: '',
      _blobToDataUrl: async () => 'data:x', analyzeVoiceEmotion: async () => null,
      handleSend() {}, getTtsCleanText: n => n.content,
      _callWaitAi: async () => box.__ai,
      fetch: async (url) => {
        if (url.includes('/api/voice-stt')) return { ok: true, json: async () => ({ text: '你好' }) };
        const d = deferred(); tts.push(d); return d.p;
      },
      Date, Math, Uint8Array, console,
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(objDecl(CC, '_call')
      + 'var CALL_SILENCE_MS = 1200, CALL_MIN_MS = 500, CALL_MAX_MS = 30000, CALL_LINGER_MS = 18000, CALL_SPLIT_MIN = 30; var _aiHangupWanted = false;'
      // 2026-10-12 插话 / 说到哪 / 沉默开口那批常量和函数：上面这几个函数现在会调到它们
      + callConsts() + 'var _callNudgePending = null;'
      + ['openCall', 'closeCall', '_callListen', '_callVadLoop', '_callStopRec', '_callHeard', '_callSpeak', '_callSpeakParts', '_callFetchPart', '_callPlay', 'callInterrupt', '_callPhase', '_callStatus',
         '_callStt', '_callTurn', '_callLinger', '_callBargeArm', '_callBargeDrop', '_callBargeLoop', '_callBargePause', '_callBargeResume',
         '_callBargeClassify', '_callBargeConfirm', '_callBargeVol', 'callBargeNew', 'callBargeStep', 'callBargeProfile', '_callDetectRoute',
         'callRouteFromDevices', '_callCutNow', '_callCutCommit', '_callCutRest', '_callFindNode', '_callMarkCut', '_callResumeCut', '_callLeadArm',
         'callClassifyUtterance', '_callSegmentable', 'callHeardCount', 'callNudgeNew', 'callNudgeDue', '_callNudgeHeard', '_callNudgeReady',
         '_callNudge', '_callNudgeDrop', 'callNudgeYield', '_callBargeRecStart', '_callBargeRecDrop']
        .map(n => funcBody(CC, n)).join('\n'), box);
    const ttsOk = d => d.res({ ok: true, blob: async () => ({ size: 100 }) });
    // 一通接好的电话（不念开场白）
    const connect = async () => { const p = box.openCall(); gum.calls[gum.calls.length - 1].res(); await p; await flush(); };
    // 走真实路径说完一句：VAD 判定说完 → rec.stop() → onstop → _callHeard
    const sayOne = () => { box._call.startAt = Date.now() - 2000; const r = box._call.rec; box._callStopRec(); return r.stopResult; };
    const recording = () => recs.filter(r => r.state === 'recording');
    return { box, clock, gum, recs, audios, toasts, tts, ttsOk, connect, sayOne, recording, revoked };
  }
  t('_call 对象切得出来', objDecl(CC, '_call').length > 50);

  console.log('\n【六·对照】正常接通 → 挂断');
  {
    const c = callBox();
    await c.connect();
    t('接通：在听、一台录音机在录', c.box._call.on === true && c.recording().length === 1 && c.box._call.phase === 'listening');
    c.box.closeCall();
    t('挂断：麦克风关了、没有在录的', !live(c.gum.calls[0].stream) && c.recording().length === 0);
  }

  console.log('\n【六·A】权限弹窗还在就挂断');
  {
    const c = callBox();
    const p = c.box.openCall();
    c.box.closeCall();
    c.gum.calls[0].res(); await p; await flush();
    t('晚回来的麦克风当场关掉', !live(c.gum.calls[0].stream));
    t('通话没有被重新点亮（不在后台偷听）', c.box._call.on === false, c.box._call.on);
    t('没开录音机', c.recs.length === 0, c.recs.length);
  }
  console.log('\n【六·A2】权限没回来前连点两次打电话');
  {
    const c = callBox();
    const p1 = c.box.openCall(), p2 = c.box.openCall();
    c.gum.calls.forEach(x => x.res()); await Promise.all([p1, p2]); await flush();
    t('只剩一路麦克风活着、就是通话在用的那路', c.gum.calls.filter(x => live(x.stream)).length === 1 && live(c.box._call.stream));
    t('只有一台在录', c.recording().length === 1, c.recording().length);
  }

  console.log('\n【六·B】AI 说了 [[HANGUP]] 进余韵，这时你手动挂断又马上重拨');
  {
    const c = callBox();
    await c.connect();
    c.box._aiHangupWanted = true;
    const heard = c.sayOne();
    await flush(); c.ttsOk(c.tts[0]); await heard; await flush();
    t('进了余韵窗口', c.box._call.linger === true && c.clock.pending() >= 1);
    c.box.closeCall();
    await c.connect();
    t('新的一通不带着上一通的余韵标记', c.box._call.linger === false, c.box._call.linger);
    c.clock.advance(18001); await flush();
    t('18 秒后新的一通还在（没被上一通的计时器挂掉）', c.box._call.on === true, c.box._call.on);
    t('没弹「通话结束」', !c.toasts.includes('📞 通话结束'), c.toasts);
  }
  console.log('\n【六·B 对照】余韵里不说话，18 秒后照常挂断');
  {
    const c = callBox();
    await c.connect();
    c.box._aiHangupWanted = true;
    const heard = c.sayOne();
    await flush(); c.ttsOk(c.tts[0]); await heard; await flush();
    c.clock.advance(18001); await flush();
    t('余韵到点挂断', c.box._call.on === false && c.toasts.includes('📞 通话结束'));
  }

  console.log('\n【六·C】AI 还在合成语音（fetch 没回）就按了打断');
  {
    const c = callBox();
    await c.connect();
    const heard = c.sayOne();
    let settled = false; heard.then(() => { settled = true; });
    await flush();
    t('走到了合成那一步', c.tts.length === 1 && c.box._call.phase === 'speaking');
    c.box.callInterrupt();
    t('打断后马上在听', c.box._call.phase === 'listening' && c.recording().length === 1);
    const r1 = c.box._call.rec;
    c.ttsOk(c.tts[0]); await flush(); await flush();
    t('打断时开的那台一直录着（刚开口的话没被重开录音机丢掉）', c.box._call.rec === r1 && r1.state === 'recording');
    t('合成晚回来：不念了', c.audios.length === 0, c.audios.length);
    t('还在听（phase 没被抢回 speaking）', c.box._call.phase === 'listening', c.box._call.phase);
    t('只有一台录音机在录（没有被覆盖掉、后台一直录的那台）', c.recording().length === 1, c.recording().length);
    t('在录的就是 _call.rec', c.recording()[0] === c.box._call.rec);
    t('这一轮收尾了（等念完的 promise 没挂死）', settled);
  }
  console.log('\n【六·D】AI 念到一半按了打断');
  {
    const c = callBox();
    c.box.__autoEnd = false;             // play() 之后不自己结束，模拟正念着
    await c.connect();
    const heard = c.sayOne();
    let settled = false; heard.then(() => { settled = true; });
    await flush(); c.ttsOk(c.tts[0]); await flush();
    t('正在念', c.audios.length === 1 && c.audios[0].playing && c.box._call.phase === 'speaking');
    c.box.callInterrupt();
    const r1 = c.box._call.rec;
    await flush();
    t('停嘴了', c.audios[0].paused === true);
    t('打断时开的那台一直录着（刚开口的话没被重开录音机丢掉）', c.box._call.rec === r1 && r1.state === 'recording');
    t('这一轮收尾了（pause 不触发 onended 也放行）', settled);
    t('只有一台在录、就是 _call.rec', c.recording().length === 1 && c.recording()[0] === c.box._call.rec, c.recording().length);
    t('还在听', c.box._call.phase === 'listening');
  }
  console.log('\n【六·E】AI 念到一半直接挂断');
  {
    const c = callBox();
    c.box.__autoEnd = false;
    await c.connect();
    const heard = c.sayOne();
    let settled = false; heard.then(() => { settled = true; });
    await flush(); c.ttsOk(c.tts[0]); await flush();
    c.box.closeCall(); await flush();
    t('挂断也放行这一轮', settled);
    t('挂断后没有在录的', c.recording().length === 0);
  }
  console.log('\n【六·H】接来电：开场白还在合成就按了打断');
  {
    const c = callBox();
    const p = c.box.openCall({ speakFirst: '想你了' });
    let settled = false; p.then(() => { settled = true; });
    c.gum.calls[0].res(); await flush();
    t('在合成开场白', c.tts.length === 1 && c.box._call.phase === 'speaking');
    c.box.callInterrupt();
    const r1 = c.box._call.rec;
    c.ttsOk(c.tts[0]); await flush(); await flush();
    t('开场白不念了', c.audios.length === 0);
    t('打断时开的那台一直录着、只有它在录', c.box._call.rec === r1 && r1.state === 'recording' && c.recording().length === 1);
    t('openCall 收尾了', settled);
  }

  console.log('\n【六·G】_callListen 被连叫两次（兜底：不管上游哪条路漏了）');
  {
    const c = callBox();
    await c.connect();
    const first = c.box._call.rec;
    c.box._callListen();
    t('旧的那台停了', first.state === 'inactive');
    t('只有一台在录、就是 _call.rec', c.recording().length === 1 && c.recording()[0] === c.box._call.rec && c.box._call.rec !== first);
    t('旧那台停下时没有把半句话当成一轮送去转写', first.stopResult === undefined, typeof first.stopResult);
  }

  console.log('\n【六·F 对照】不打断：念完接着听下一句');
  {
    const c = callBox();
    await c.connect();
    const heard = c.sayOne();
    await flush(); c.ttsOk(c.tts[0]); await heard; await flush();
    t('念了一遍', c.audios.length === 1);
    t('念完回来听、只有一台在录', c.box._call.phase === 'listening' && c.recording().length === 1 && c.recording()[0] === c.box._call.rec);
  }

  // 长回复按句流水线念（本地情绪声音 RTF≈0.85，整段合成完再出声要先干等十几秒）
  const LONG = '今天我去楼下买了你最喜欢的那家奶茶。排队的人好多，等了快二十分钟。回来的路上还下雨了，不过奶茶没洒。';
  console.log('\n【六·I】长回复：第一句回来就开始念，同时去取下一句');
  {
    const c = callBox();
    c.box.__autoEnd = false;
    c.box.__ai = { role: 'ai', content: LONG };
    await c.connect();
    const heard = c.sayOne();
    await flush();
    const n = c.box._callSpeakParts(LONG).length;
    t('切成了好几句、每句都不碎', n >= 3 && c.box._callSpeakParts(LONG).every(p => p.trim().length >= 10), c.box._callSpeakParts(LONG));
    t('切完拼回去一字不差', c.box._callSpeakParts(LONG).join('') === LONG);
    t('先只取第一句', c.tts.length === 1);
    c.ttsOk(c.tts[0]); await flush(); await flush();
    t('★ 第一句回来就开始念（不等后面的）', c.audios.length === 1 && c.audios[0].playing === true);
    t('★ 念第一句的同时已经在取第二句', c.tts.length === 2, c.tts.length);
    c.ttsOk(c.tts[1]); await flush();
    t('第二句取回来了也不抢着念（一句一句来）', c.audios.length === 1);
    c.audios[0].onended(); await flush(); await flush();
    t('第一句念完接着念第二句', c.audios.length === 2 && c.audios[1].playing === true);
    for (let i = 2; i < n; i++) { c.ttsOk(c.tts[i]); await flush(); c.audios[i - 1].onended(); await flush(); await flush(); }
    c.audios[n - 1].onended(); await heard; await flush(); await flush();
    t('★ 全部念完、每句一个请求', c.audios.length === n && c.tts.length === n, { a: c.audios.length, t: c.tts.length });
    t('念完回来听', c.box._call.phase === 'listening');
  }
  console.log('\n【六·J】长回复念到第一句时打断：后面的不念、已取回的音频回收');
  {
    const c = callBox();
    c.box.__autoEnd = false;
    c.box.__ai = { role: 'ai', content: LONG };
    await c.connect();
    const heard = c.sayOne();
    let settled = false; heard.then(() => { settled = true; });
    await flush(); c.ttsOk(c.tts[0]); await flush(); await flush();
    t('正在念第一句、第二句在取', c.audios.length === 1 && c.tts.length === 2);
    c.box.callInterrupt(); await flush();
    c.ttsOk(c.tts[1]); await flush(); await flush();
    t('★ 打断后第二句回来了也不念', c.audios.length === 1, c.audios.length);
    t('★ 不再去取第三句', c.tts.length === 2, c.tts.length);
    t('★ 第二句的音频被回收（不漏 blob）', c.revoked.includes('blob:tts2'), c.revoked);
    t('这一轮收尾了', settled);
    t('在听', c.box._call.phase === 'listening');
  }
  console.log('\n【六·K】短回复照旧一次合成（≤30 字不切）');
  {
    const c = callBox();
    t('短回复只有一段', c.box._callSpeakParts('好的，我知道啦。那你早点睡哦。').length === 1);
  }

  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
