'use strict';
// 通话：用嗓子打断 / 短附和分流 / heard_text / 沉默时主动开口（2026-10-12，书签 call_call 那套）
// 跑法：node tests/call-barge.test.js
//
// 一、纯逻辑：附和分流词表、heard_text 截断、两段式打断状态机、沉默计时、耳机/外放识别
// 二、在 vm 里整份跑 js/11-camera-call.js：假时钟 + 假麦克风音量 + 假录音机 + 假播放器，
//     一帧一帧推，走真的 _callBargeLoop → 暂停 → 确认/恢复 → _callHeard → 发出去 那条路
// 三、接线：05 把「被打断」写进上下文、06 把它画在气泡上、设置能存能读回来、安卓副本一致
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CC = read('js/11-camera-call.js');
const PK = read('js/23-peek.js');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function funcBody(s, name) {
  let i = s.indexOf('function ' + name + '(');
  if (i < 0) return '';
  if (s.slice(i - 6, i) === 'async ') i -= 6;
  let p = 0, k = s.indexOf('(', i);
  for (; k < s.length; k++) { if (s[k] === '(') p++; else if (s[k] === ')' && --p === 0) break; }
  let d = 0, started = false;
  for (let j = k; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}

/* ── 沙箱：整份 11-camera-call.js + 一套假的浏览器 ── */
function makeBox(opt = {}) {
  const T = { now: 1_000_000, seq: 0, timers: [], rafs: [] };
  const recs = [], audios = [], sends = [], stt = [], tts = [], apiCalls = [], aborted = [];
  const sttQueue = [];
  const FakeDate = class extends Date { static now() { return T.now; } };
  class FakeAudio {
    constructor(src) { this.src = src; this.currentTime = 0; this.duration = 4; this.paused = true; this.plays = 0; audios.push(this); }
    play() { this.paused = false; this.plays++; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class FakeRec {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; recs.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state !== 'recording') return;
      this.state = 'inactive';
      Promise.resolve().then(() => { this.ondataavailable?.({ data: { size: 5 } }); this.onstop?.(); });
    }
  }
  FakeRec.isTypeSupported = () => true;
  const analysers = [];
  class AC {
    constructor() { this.state = 'running'; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      const an = { fftSize: 0, smoothingTimeConstant: 0.8, frequencyBinCount: 8,
        getByteFrequencyData(buf) { const v = box.__mic(); for (let i = 0; i < buf.length; i++) buf[i] = v; } };
      analysers.push(an);
      return an;
    }
    close() { this.state = 'closed'; }
  }
  const tracks = [{ enabled: true, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const chat = { id: 'c1', headId: 1, nodes: { 1: { id: 1, role: 'ai', content: '开头', timestamp: 0 } } };
  let idc = 100;
  const classList = () => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)), toggle: (x, on) => (on ? s.add(x) : s.delete(x)), contains: x => s.has(x) }; };
  const els = { callModal: { classList: classList(), style: { setProperty() {} } }, callAvatar: { classList: classList(), innerHTML: '' }, callName: { textContent: '' }, callStatus: { textContent: '' } };
  const box = {
    __mic: () => 2,
    __reply: '好的',
    __devices: opt.devices || [],
    Date: FakeDate, Math, Promise, JSON, String, Number, Object, Array, Set, Map, Uint8Array, console, isFinite, RegExp, Error,
    setTimeout: (fn, ms) => { const id = ++T.seq; T.timers.push({ id, at: T.now + (ms || 0), fn }); return id; },
    clearTimeout: id => { T.timers = T.timers.filter(x => x.id !== id); },
    requestAnimationFrame: fn => { const id = ++T.seq; T.rafs.push({ id, fn }); return id; },
    cancelAnimationFrame: id => { T.rafs = T.rafs.filter(x => x.id !== id); },
    navigator: { mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => box.__devices } },
    MediaRecorder: FakeRec, Audio: FakeAudio, AudioContext: AC,
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o?.type; this.size = 5; } },
    URL: { createObjectURL: () => 'blob:' + (++T.seq), revokeObjectURL() {} },
    document: { getElementById: id => els[id] || null, querySelector: () => null },
    state: { configs: [{ id: 'm1', nickname: '克克' }], ttsVoice: '', userName: '小明', chats: [chat], callBargeMode: opt.mode || 'auto' },
    getActiveChatModelIds: () => ['m1'], getActiveChat: () => chat, nextId: () => ++idc,
    getMessagePath: () => [], _streamControllers: new Set(),
    save() {}, renderMessages() {}, _invalidateNodeCache() {}, showToast() {}, escHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    renderCallBg() {}, _sttReady: () => true, _sttQuery: () => '', _ttsRateStr: () => '+0%', SERVER_BASE: '',
    _blobToDataUrl: async () => 'data:audio', analyzeVoiceEmotion: async () => null,
    getTtsCleanText: n => n.content,
    abortChatStreams: c => aborted.push(c.id),
    handleSend(text, voice) {
      const u = ++idc, a = ++idc;
      chat.nodes[u] = { id: u, parentId: chat.headId, role: 'user', content: text, timestamp: T.now, audio: voice?.audio };
      chat.nodes[a] = { id: a, parentId: u, role: 'ai', content: box.__reply, timestamp: T.now };
      chat.headId = a;
      sends.push({ text, voice, aiId: a });
    },
    // 沉默那一问：真的 buildSystemPrompt 只调 takeCallNudgeMoment，这里也只调它
    callAPI: async (conf, p, c, parentId) => {
      const prompt = box.takeCallNudgeMoment();
      apiCalls.push({ parentId, prompt, node: { ...c.nodes[parentId] } });
      if (box.__apiGate) await box.__apiGate;
      const aiId = ++idc;
      c.nodes[aiId] = { id: aiId, parentId, role: 'ai', content: box.__nudgeReply, timestamp: T.now };
      c.headId = aiId;
      box.peekDropSilent(c, aiId);
    },
    fetch: async (url) => {
      if (url.includes('/api/voice-stt')) {
        stt.push(url);
        const text = sttQueue.length ? sttQueue.shift() : '';
        return { ok: true, json: async () => ({ text }) };
      }
      tts.push(decodeURIComponent((url.match(/text=([^&]*)/) || [])[1] || ''));
      return { ok: true, blob: async () => ({ size: 100 }) };
    },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(CC + '\n' + funcBody(PK, 'peekDropSilent'), box);
  // 等 AI 回完那段是轮询，这里直接给最新那条
  box._callWaitAi = async () => chat.nodes[chat.headId];
  // 推时间：每 step 毫秒一帧（先到点的定时器，再跑这一帧的 rAF）
  async function run(ms, step = 16) {
    const end = T.now + ms;
    while (T.now < end) {
      T.now += Math.min(step, end - T.now);
      for (;;) {
        const due = T.timers.filter(x => x.at <= T.now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        T.timers = T.timers.filter(x => x !== due);
        due.fn();
        await flush(2);
      }
      const fr = T.rafs.splice(0);
      for (const r of fr) r.fn(T.now);
      await flush(2);
    }
  }
  const C = () => vm.runInContext('_call', box);
  const recording = () => recs.filter(r => r.state === 'recording');
  const playing = () => audios.filter(a => !a.paused);
  const connect = async () => { await box.openCall(); await flush(); };
  // 走真实路径说一句：有声 → 静 1.2 秒 → 停录 → 转写 → 发出去 → 等它回 → 开始念
  const say = async (text, ms = 900) => {
    sttQueue.push(text);
    box.__mic = () => 40; await run(ms);
    box.__mic = () => 2; await run(1400);
    await flush();
  };
  return { box, T, run, C, recs, audios, sends, stt, sttQueue, tts, apiCalls, aborted, chat, recording, playing, connect, say, analysers };
}

const ex = (box, code) => vm.runInContext(code, box);

(async () => {
  const { box: P } = makeBox();      // 纯函数直接从这个沙箱里拿
  const cls = s => P.callClassifyUtterance(s);

  console.log('\n[1] 短附和 / 叫停 分流');
  t('★ 嗯 / 嗯嗯 / 对 / 是 / 好 → 附和（我接着说）', ['嗯', '嗯嗯', '对', '是', '好'].every(s => cls(s) === 'backchannel'));
  t('带标点、叠词也认得：嗯。/ 对对对 / 好的好的 / 嗯，对', ['嗯。', '对对对', '好的好的', '嗯，对'].every(s => cls(s) === 'backchannel'));
  t('★ 等等 / 不对 / 停 / 慢点 → 叫停（真停下来听）', ['等等', '不对', '停', '慢点'].every(s => cls(s) === 'stop'));
  t('「等」「不要」「喂喂？」也是叫停；「好吧」是附和', ['等', '不要', '喂喂？', '等我一下'].every(s => cls(s) === 'stop') && cls('好吧') === 'backchannel');
  t('叫停带语气词也认得：等一下哦 / 停停停！/ 慢一点啦 / 等等，不对', ['等一下哦', '停停停！', '慢一点啦', '等等，不对'].every(s => cls(s) === 'stop'));
  t('★ 附和词带问号（嗯？啊？）= 没听懂 → 叫停', cls('嗯？') === 'stop' && cls('啊?') === 'stop');
  t('叫停词后面有正经内容 → 正常说话（照常发给它）', cls('等一下我想问你个事') === 'speech' && cls('不对吧你昨天不是这么说的') === 'speech');
  t('附和词夹在正经话里 → 正常说话', cls('好的那我们明天去吧') === 'speech' && cls('嗯我觉得可以试试') === 'speech');
  t('空的 / 只有标点 → empty', cls('') === 'empty' && cls('。。') === 'empty' && cls('  ') === 'empty');
  const BC = ex(P, 'CALL_BC_WORDS'), ST = ex(P, 'CALL_STOP_WORDS');
  t('★ 词表是常量，任务单点名的词都在', ['嗯', '嗯嗯', '对', '是', '好'].every(w => BC.includes(w)) && ['等等', '不对', '停', '慢点'].every(w => ST.includes(w)));
  t('附和词表里每一个单说都是附和', BC.every(w => cls(w) === 'backchannel'), BC.filter(w => cls(w) !== 'backchannel'));
  t('叫停词表里每一个单说都是叫停', ST.every(w => cls(w) === 'stop'), ST.filter(w => cls(w) !== 'stop'));
  t('两张表不重叠（不然一个词既让我接着说又让我停）', !BC.some(w => ST.includes(w)));

  console.log('\n[2] heard_text：按播放进度算听到了几个字');
  const parts = ['今天天气很好。', '我们去公园吧。', '你想去吗？'];   // 7 + 7 + 5
  const hc = (d, c) => P.callHeardCount(parts, d, c);
  t('一句都没放完、也没在放 → 0', hc(0, null) === 0);
  t('第一句放完、第二句还在合成 → 7', hc(1, null) === 7);
  t('★ 第二句放到一半（2s/4s）→ 7 + 一半往回让一个字 = 9', hc(1, { i: 1, t: 2, d: 4 }) === 9, hc(1, { i: 1, t: 2, d: 4 }));
  t('刚开始放（t=0）不算负数', hc(1, { i: 1, t: 0, d: 4 }) === 7);
  t('放到头了（t≥d）整句都算', hc(1, { i: 1, t: 4, d: 4 }) === 14);
  t('拿不到时长（Infinity / NaN）按一秒 4.5 字估', hc(1, { i: 1, t: 1, d: Infinity }) === 10 && hc(1, { i: 1, t: 1, d: NaN }) === 10);
  t('cur 不是正在放的那句 → 不算进去', hc(1, { i: 0, t: 2, d: 4 }) === 7);
  t('估出来超过这句长度也封顶', hc(2, { i: 2, t: 100, d: Infinity }) === 19);
  t('done 超过句数也不越界', hc(9, null) === 19);

  console.log('\n[3] 两段式打断的状态机（纯函数，一帧 16ms）');
  const HS = ex(P, 'CALL_BARGE_PROFILES.headset'), SP = ex(P, 'CALL_BARGE_PROFILES.speaker');
  // 喂一段音量序列：fn(x) → { vol, playing }，x 是这一段里第几毫秒（第一帧 x=0，离上一段最后一帧 16ms）。
  // 每个状态机自带一只连续的钟；返回这一段里发生的事 [{at: x, act}]
  function feed(b, p, ms, fn) {
    const out = [];
    for (let x = 0; x < ms; x += 16) {
      b.__clk = (b.__clk || 0) + 16;
      const f = fn(x);
      const act = P.callBargeStep(b, b.__clk, f.vol, p, f.playing);
      if (act && act !== 'arm' && act !== 'disarm') out.push({ at: x, act });
    }
    return out;
  }
  {
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }), 0);           // 我先说了一秒，你没出声
    const ev = feed(b, HS, 900, () => ({ vol: 40, playing: b.st === 'idle' }), 1016);
    t('★ 耳机：你一开口，约 40ms 内先暂停（第 3 帧）', ev[0]?.act === 'pause' && ev[0].at + 16 <= 48, ev);
    t('★ 一直说着 → 约 650ms 后确认', ev[1]?.act === 'confirm' && ev[1].at - ev[0].at >= HS.windowMs && ev[1].at - ev[0].at <= HS.windowMs + 32, ev);
  }
  {
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }), 0);
    const ev = feed(b, HS, 1000, x => ({ vol: x < 100 ? 40 : 4, playing: b.st === 'idle' }), 1016);
    t('★ 咳嗽一下（100ms 就停）→ 暂停后接着放，不确认', ev.map(e => e.act).join() === 'pause,resume', ev);
  }
  {
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }), 0);
    const ev = feed(b, HS, 1000, x => ({ vol: x < 300 ? 40 : 4, playing: b.st === 'idle' }), 1016);
    t('短附和（300ms 的「嗯」）→ 也不确认，接着放（由转写去分流）', ev.map(e => e.act).join() === 'pause,resume', ev);
  }
  {
    // 外放回声：我在放的时候麦克风里一直有 35 的回声，一暂停就没了
    const b = P.callBargeNew(0);
    let paused = false;
    const ev = feed(b, SP, 3000, () => { const pl = b.st === 'idle'; return { vol: pl ? 35 : 3, playing: pl }; }, 0);
    t('★ 外放回声：最多误停一次（一停回声就没了 → 认出是回声）', ev.filter(e => e.act === 'pause').length <= 1, ev);
    t('误停那次没被确认成打断', !ev.some(e => e.act === 'confirm'));
    const ev2 = feed(b, SP, 1200, () => ({ vol: b.st === 'idle' ? 60 : 50, playing: b.st === 'idle' }), 3016);
    t('★ 学过回声之后，你真开口（比回声响）照样能打断', ev2[0]?.act === 'pause' && ev2.some(e => e.act === 'confirm'), ev2);
  }
  {
    // 外放回声更像真的：平时 20，念到重音那几下冲到 42（160ms），每 600ms 一下；一暂停就没了
    const b = P.callBargeNew(0);
    const ev = feed(b, SP, 6000, x => { const pl = b.st === 'idle'; return { vol: pl ? (x % 600 < 160 ? 42 : 20) : 3, playing: pl }; });
    t('★ 外放回声有尖峰：认出一次之后门槛记住尖峰，6 秒里最多误停两次', ev.filter(e => e.act === 'pause').length <= 2, ev);
    const ev2 = feed(b, SP, 1200, () => ({ vol: b.st === 'idle' ? 62 : 50, playing: b.st === 'idle' }));
    t('记住尖峰之后，你真开口照样能打断', ev2.some(e => e.act === 'confirm'), ev2);
  }
  {
    // 咳一声也是「一停就没了」：别因此把门槛抬上天
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }));
    feed(b, HS, 1000, x => ({ vol: x < 100 ? 70 : 4, playing: b.st === 'idle' }));
    const ev = feed(b, HS, 1000, () => ({ vol: 40, playing: b.st === 'idle' }));
    t('★ 咳了很响的一声之后，正常音量开口照样能打断', ev[0]?.act === 'pause' && ev.some(e => e.act === 'confirm'), { ev, echoHi: b.echoHi });
  }
  {
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }));
    const acts = [];
    for (let x = 0; x < 200; x += 16) { b.__clk += 16; const a = P.callBargeStep(b, b.__clk, x < 16 ? 40 : 4, HS, true); if (a) acts.push(a); }
    t('★ 一有声先开录（arm），没攒够就静了扔掉（disarm）——你开头那几十毫秒不丢', acts.join() === 'arm,disarm', acts);
  }
  {
    const bH = P.callBargeNew(0), bS = P.callBargeNew(0);
    feed(bH, HS, 1000, () => ({ vol: 4, playing: true }), 0);
    feed(bS, SP, 1000, () => ({ vol: 4, playing: true }), 0);
    const eH = feed(bH, HS, 300, () => ({ vol: 26, playing: true }), 1016);
    const eS = feed(bS, SP, 300, () => ({ vol: 26, playing: true }), 1016);
    t('★ 外放阈值更高：同样 26 的音量，耳机算开口、外放不算', eH[0]?.act === 'pause' && eS.length === 0, { eH, eS });
    const bS2 = P.callBargeNew(0);
    feed(bS2, SP, 1000, () => ({ vol: 4, playing: true }), 0);
    const eS2 = feed(bS2, SP, 1500, () => ({ vol: 45, playing: bS2.st === 'idle' }), 1016);
    t('★ 外放要说得更久：有声满 100ms 才暂停、800ms 窗口才确认', eS2[0]?.act === 'pause' && eS2[0].at + 16 >= SP.onsetMs && eS2[0].at < SP.onsetMs && eS2[1]?.act === 'confirm' && eS2[1].at - eS2[0].at >= SP.windowMs, eS2);
    t('外放参数确实比耳机保守', SP.onVol > HS.onVol && SP.onsetMs > HS.onsetMs && SP.windowMs > HS.windowMs && SP.echoPad > HS.echoPad);
  }
  {
    const b = P.callBargeNew(0);
    const ev = feed(b, HS, 400, () => ({ vol: 40, playing: true }), 0);
    t('每句刚开始放的 250ms 不触发（底噪还没学到）', ev[0]?.act === 'pause' && ev[0].at >= ex(P, 'CALL_BARGE_WARM_MS'), ev);
  }
  {
    const b = P.callBargeNew(0);
    feed(b, HS, 1000, () => ({ vol: 4, playing: true }), 0);
    // 第一下没确认（接着放了）；紧跟着又出声 → 还在「得先安静 250ms」里，不触发；安静够了再出声 → 才触发第二次
    const loud = x => x < 100 || (x >= 700 && x < 850) || (x >= 1300 && x < 1400);
    const ev = feed(b, HS, 2000, x => ({ vol: loud(x) ? 40 : 4, playing: b.st === 'idle' }));
    const pz = ev.filter(e => e.act === 'pause');
    t('一次作废后要先安静一会儿才再次触发（不会一声停好几回）', pz.length === 2 && ev[1].act === 'resume' && pz[1].at >= 1300, ev);
  }
  {
    const b = P.callBargeNew(0);
    const ev = feed(b, HS, 1000, () => ({ vol: 40, playing: false }), 0);
    t('我还在合成（没出声）时你开口：一样能打断', ev[0]?.act === 'pause' && ev[0].at <= 48 && ev.some(e => e.act === 'confirm'), ev);
  }

  console.log('\n[4] 耳机 / 外放 / 设置');
  const rt = ds => P.callRouteFromDevices(ds);
  t('默认输出是耳机 → headset', rt([{ kind: 'audiooutput', deviceId: 'default', label: '默认 - 耳机 (Realtek Audio)' }, { kind: 'audiooutput', deviceId: 'x', label: '扬声器 (Realtek Audio)' }]) === 'headset');
  t('默认输出是扬声器 → speaker（哪怕列表里还有耳机）', rt([{ kind: 'audiooutput', deviceId: 'default', label: '默认 - 扬声器 (Realtek Audio)' }, { kind: 'audiooutput', deviceId: 'x', label: '耳机 (USB)' }]) === 'speaker');
  t('蓝牙 / AirPods → headset', rt([{ kind: 'audiooutput', deviceId: 'default', label: 'AirPods Pro' }]) === 'headset');
  t('没有输出设备名、麦克风是耳麦 → headset', rt([{ kind: 'audiooutput', deviceId: 'default', label: '' }, { kind: 'audioinput', deviceId: 'default', label: 'Headset Microphone' }]) === 'headset');
  t('什么名字都拿不到（手机 WebView 常见）→ unknown', rt([{ kind: 'audioinput', deviceId: 'default', label: '' }]) === 'unknown' && rt(null) === 'unknown');
  const prof = (m, r) => P.callBargeProfile(m, r);
  t('★ 认不出来按外放算（宁可难打断，别自己打断自己）', prof('auto', 'unknown') === SP && prof(undefined, 'unknown') === SP);
  t('auto + 耳机 → 耳机参数；手动选了外放就按外放', prof('auto', 'headset') === HS && prof('speaker', 'headset') === SP && prof('headset', 'speaker') === HS);
  t('设成关 → 不用嗓子打断', prof('off', 'headset') === null);

  console.log('\n[5] 沉默计时');
  {
    const n = P.callNudgeNew(0);
    t('安静 12 秒前不问', !P.callNudgeDue(n, 11999));
    t('★ 安静满 12 秒问一次', P.callNudgeDue(n, 12000));
    n.tries = 1;
    t('★ 问过一次：要安静满 24 秒才问第二次（间隔翻倍）', !P.callNudgeDue(n, 23999) && P.callNudgeDue(n, 24000));
    n.tries = 4;
    t('一段沉默里最多问 4 次', !P.callNudgeDue(n, 1e9));
    n.tries = 1; n.unanswered = 2;
    t('★ 连续开口两次你都没回 → 不再问', !P.callNudgeDue(n, 1e9));
    n.unanswered = 0; n.busy = true;
    t('正在问的时候不重复问', !P.callNudgeDue(n, 1e9));
  }

  console.log('\n[6] 「被打断」写进上下文 / 画在气泡上');
  {
    const note = P.callCutNoteForApi({ heard: '今天天气很好。我们去', unheard: '公园吧。你想去吗？' });
    t('★ 上下文里说清楚说到哪、后面哪些没听到', /说到「…今天天气很好。我们去」/.test(note) && /公园吧。你想去吗？/.test(note) && /没听到/.test(note) && /别当 ta 听过/.test(note), note);
    t('一个字都没念出来也说清楚', /一个字都还没念出来/.test(P.callCutNoteForApi({ heard: '', unheard: '你好' })));
    t('其实都听到了（unheard 空）→ 不加', P.callCutNoteForApi({ heard: '你好', unheard: '  ' }) === '');
    const html = P.callCutHtml({ callCut: { heard: '<b>前面</b>', unheard: '<script>x</script>' } });
    t('气泡上的小字转义了（不开 HTML 口子）', html.includes('call-cut-note') && !html.includes('<script>') && !html.includes('<b>'), html);
    t('没被打断的消息不画', P.callCutHtml({}) === '' && P.callCutHtml(null) === '');
  }

  /* ═════════ 二、整份跑：真的帧循环 ═════════ */
  const LONG = '今天我去楼下买了你最喜欢的那家奶茶。排队的人好多，等了快二十分钟。回来的路上还下雨了，不过奶茶没洒。';
  // 接通 → 你说一句 → 它回 LONG → 第一句开始放
  async function speakingBox(opt) {
    const c = makeBox(opt);
    c.box.__reply = LONG;
    await c.connect();
    await c.say('你今天干嘛了');
    await c.run(32);
    return c;
  }

  console.log('\n[7] 用嗓子打断：确认');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    t('先决条件：在念第一句', c.C().phase === 'speaking' && c.playing().length === 1, { ph: c.C().phase, n: c.playing().length });
    t('★ getUserMedia 开了回声消除 / 降噪 / 自动增益', /echoCancellation: true, noiseSuppression: true, autoGainControl: true/.test(funcBody(CC, 'openCall')));
    t('插话那个分析器是低平滑的（反应快）', c.analysers[1] && c.analysers[1].smoothingTimeConstant <= 0.3);
    const a = c.playing()[0];
    a.currentTime = 2; a.duration = 4;              // 第一句放了一半
    await c.run(1000);                              // 再放一会儿（学一下底噪）
    a.currentTime = 2;
    const recsBefore = c.recs.length;
    c.box.__mic = () => 40;                         // 你开口了
    await c.run(16);
    t('★ 第一帧有声就开录了（还没攒够、还没暂停）——你开头那几十毫秒也在录音里', c.recs.length === recsBefore + 1 && !a.paused, { recs: c.recs.length - recsBefore, paused: a.paused });
    await c.run(32);
    t('★ 40ms 左右先暂停', a.paused === true && c.C().bargeHold === true);
    t('★ 暂停的同时开了一台录音机录你', c.recs.length === recsBefore + 1 && c.recs[c.recs.length - 1].state === 'recording');
    const bargeRec = c.recs[c.recs.length - 1];
    t('还没确认：剩下的话没作废', c.C().phase === 'speaking' && !ai.callCut);
    await c.run(700);
    t('★ 一直在说 → 确认：开始听你', c.C().phase === 'listening');
    t('★ 候选期间开的那台录音机直接接过来（你开头那几个字没丢）', c.C().rec === bargeRec && bargeRec.state === 'recording' && c.recording().length === 1);
    const k0 = Math.floor(c.box._callSpeakParts(LONG)[0].length / 2) - 1;   // 第一句放了一半，正念到的那个字不算
    t('★ 那条消息照实标了：听到第一句的一半，后面没听到', ai.callCut && ai.callCut.heard === LONG.slice(0, k0) && ai.callCut.unheard === LONG.slice(k0), ai.callCut);
    t('剩下的句子不再念、也不再去合成', c.playing().length === 0);
    const ttsN = c.tts.length;
    c.sttQueue.push('我想问一下明天几点出门');
    c.box.__mic = () => 2; await c.run(1400); await c.run(32);
    t('★ 你说完了：这句照常发出去', c.sends.length === 2 && c.sends[1].text === '我想问一下明天几点出门' && !!c.sends[1].voice?.audio, c.sends.map(s => s.text));
    t('录音时长从你开口那一刻算起', c.sends[1].voice.dur > 0.6, c.sends[1].voice?.dur);
    t('发出去之后它的回复照常念', c.tts.length > ttsN);
  }

  console.log('\n[8] 用嗓子打断：没确认（咳嗽 / 碰麦）');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    await c.run(800);
    const a = c.playing()[0];
    a.currentTime = 1.5;
    const plays = a.plays;
    c.box.__mic = () => 40; await c.run(64);
    c.box.__mic = () => 2; await c.run(800);
    t('★ 暂停过、又接着放了', a.paused === false && a.plays === plays + 1);
    t('接着放时往回倒了一点（被暂停的字不只剩半截）', Math.abs(a.currentTime - 1.25) < 1e-9, a.currentTime);
    t('★ 没当成打断：还在说、没开始听你', c.C().phase === 'speaking' && !ai.callCut);
    t('太短的那一下不花转写', c.stt.length === 1, c.stt.length);
    t('候选那台录音机关掉了（没在后台一直录）', c.recording().length === 0, c.recording().length);
  }

  console.log('\n[9] 短附和：嗯 → 我接着说；等等 → 真停下来听');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    await c.run(800);
    const a = c.playing()[0];
    c.sttQueue.push('嗯');
    c.box.__mic = () => 40; await c.run(250);
    c.box.__mic = () => 2; await c.run(700); await c.run(32);
    t('短短一声送去转写分流了', c.stt.length === 2, c.stt.length);
    t('★ 「嗯」→ 我接着说：没停、没发新一轮、没标被打断', c.C().phase === 'speaking' && a.paused === false && c.sends.length === 1 && !ai.callCut);
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    await c.run(800);
    const a = c.playing()[0];
    a.currentTime = 2; a.duration = 4;
    c.sttQueue.push('等等');
    c.box.__mic = () => 40; await c.run(250);
    c.box.__mic = () => 2; await c.run(700); await c.run(32);
    t('★ 「等等」→ 真停下来：开始听你', c.C().phase === 'listening' && a.paused === true);
    t('★ 停下的那一刻照实标了说到哪', ai.callCut && ai.callCut.unheard.length > 0 && LONG.startsWith(ai.callCut.heard), ai.callCut);
    t('「等等」本身先不发：等你下一句', c.sends.length === 1 && !!c.C().lead);
    c.sttQueue.push('明天几点');
    await c.say('明天几点', 600);
    c.sttQueue.length = 0;
    t('★ 你接着说了：「等等」接在这句前面一起发', c.sends.length === 2 && c.sends[1].text === '等等，明天几点', c.sends.map(s => s.text));
    t('lead 用掉就清了', !c.C().lead && !c.C().leadT);
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(800);
    c.sttQueue.push('不对');
    c.box.__mic = () => 40; await c.run(250);
    c.box.__mic = () => 2; await c.run(700); await c.run(32);
    t('「不对」之后你没再说话', c.C().phase === 'listening' && c.sends.length === 1);
    await c.run(ex(c.box, 'CALL_LEAD_WAIT_MS') + 100);
    t('★ 等了几秒没下文：把「不对」单独发过去（它好问你哪儿不对）', c.sends.length === 2 && c.sends[1].text === '不对' && !!c.sends[1].voice?.audio, c.sends.map(s => s.text));
  }

  console.log('\n[10] 确认了，但从头到尾只是「嗯嗯嗯对对」→ 从断的地方接着说');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    await c.run(800);
    const a = c.playing()[0];
    a.currentTime = 2; a.duration = 4;
    c.box.__mic = () => 40; await c.run(800);
    t('先决条件：确认成打断了、标了说到哪', c.C().phase === 'listening' && !!ai.callCut);
    const cutAt = ai.callCut.heard.length;
    const ttsN = c.tts.length;
    c.sttQueue.push('嗯嗯嗯，对对');
    c.box.__mic = () => 2; await c.run(1400); await c.run(32);
    t('★ 没发新一轮', c.sends.length === 1, c.sends.map(s => s.text));
    t('★ 从被打断的那个字接着念', c.C().phase === 'speaking' && c.tts.length > ttsN && LONG.slice(cutAt).startsWith(c.tts[ttsN]), { got: c.tts[ttsN], want: LONG.slice(cutAt) });
    // 把剩下的念完
    for (let i = 0; i < 6 && c.C().phase === 'speaking'; i++) {
      const p = c.playing()[0];
      if (p) { p.paused = true; p.onended(); }
      await c.run(32);
    }
    t('★ 剩下的念完了：「被打断」的标记摘掉（你现在整段都听到了）', c.C().phase === 'listening' && !ai.callCut, ai.callCut);
  }

  console.log('\n[10b] 边界：一个字都没念出来就被打断 / 误确认 / 「等等」挂太久 / [[HANGUP]] 那条被附和打断');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    c.C().nudge.unanswered = 1;
    c.box.__mic = () => 40; await c.run(1100);      // 第一句刚开始放就开口（currentTime 还是 0）
    t('先决条件：确认了、标的是一个字都没听到', c.C().phase === 'listening' && ai.callCut && ai.callCut.heard === '', ai.callCut);
    c.sttQueue.push('嗯嗯嗯');
    c.box.__mic = () => 2; await c.run(1400); await c.run(32);
    t('附和也算你回过了（主动开口不再说「ta 还没回」）', c.C().nudge.unanswered === 0);
    for (let i = 0; i < 6 && c.C().phase === 'speaking'; i++) { const p = c.playing()[0]; if (p) { p.paused = true; p.onended(); } await c.run(32); }
    t('★ 从头接着念完了：「被打断」标记也摘掉（不再写着一个字都没听到）', c.C().phase === 'listening' && !ai.callCut, ai.callCut);
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(800);
    c.box.__mic = () => 40; await c.run(800);
    t('先决条件：确认成打断了', c.C().phase === 'listening');
    const ttsN = c.tts.length;
    c.sttQueue.push('');                            // 键盘声 / 电视：转写出来是空的
    c.box.__mic = () => 2; await c.run(1400); await c.run(32);
    t('★ 误确认（转写是空的）：我没被白白打断——从断的地方接着说', c.C().phase === 'speaking' && c.tts.length > ttsN && c.sends.length === 1, { ph: c.C().phase, tts: c.tts.length - ttsN });
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(800);
    c.sttQueue.push('不对');
    c.box.__mic = () => 40; await c.run(250);
    c.box.__mic = () => 2; await c.run(700); await c.run(32);
    t('先决条件：「不对」之后在听、挂着 lead', c.C().phase === 'listening' && !!c.C().lead);
    c.sttQueue.push('');                            // 接着出了一长段声，转写是空的
    c.box.__mic = () => 40; await c.run(5000);
    c.box.__mic = () => 2; await c.run(1400);
    t('那段转写是空的、什么都没发', c.sends.length === 1);
    await c.run(ex(c.box, 'CALL_LEAD_WAIT_MS') + 200);
    t('★ 「不对」没被卡死：计时器自己续上了，最后还是单独发了出去', c.sends.length === 2 && c.sends[1].text === '不对', c.sends.map(x => x.text));
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(32);
    c.box.callInterrupt();
    ex(c.box, "_call.lead = { text: '等等', at: Date.now() - 30000 }");
    await c.say('明天几点');
    t('★ 「等等」挂了半分钟以上：下一句不再拼它', c.sends[1] && c.sends[1].text === '明天几点', c.sends.map(x => x.text));
  }
  {
    const c = makeBox({ mode: 'headset' });
    c.box.__reply = LONG;
    await c.connect();
    ex(c.box, '_aiHangupWanted = true');
    await c.say('那我先去睡啦');
    await c.run(32);
    await c.run(800);
    c.box.__mic = () => 40; await c.run(800);
    c.sttQueue.push('嗯嗯');
    c.box.__mic = () => 2; await c.run(1400); await c.run(32);
    for (let i = 0; i < 6 && c.C().phase === 'speaking'; i++) { const p = c.playing()[0]; if (p) { p.paused = true; p.onended(); } await c.run(32); }
    t('★ 写了 [[HANGUP]] 的那条被附和打断、接着念完：照样进余韵（不会一直挂着不收线）', c.C().linger === true, { linger: c.C().linger, ph: c.C().phase });
  }
  {
    const c = makeBox();
    c.box.__nudgeReply = '[[SILENT]]';
    await c.connect();
    await c.run(11000);
    c.box.callToggleMute(); await c.run(60000); c.box.callToggleMute();
    await c.run(2000);
    t('★ 解除静音后不会马上被问一句（静音那段不算你安静）', c.apiCalls.length === 0, c.apiCalls.length);
    await c.run(10500);
    t('解除静音后安静满 12 秒才问', c.apiCalls.length === 1, c.apiCalls.length);
  }

  console.log('\n[11] 按钮打断也记说到哪；静音 / 关掉时不用嗓子打断');
  {
    const c = await speakingBox({ mode: 'headset' });
    const ai = c.chat.nodes[c.sends[0].aiId];
    let p = c.playing()[0];
    p.paused = true; p.onended(); await c.run(32);   // 第一句念完
    p = c.playing()[0];
    p.currentTime = 1; p.duration = 2;              // 第二句念了一半
    c.box.callInterrupt();
    const parts = c.box._callSpeakParts(LONG);
    const want = parts[0].length + Math.floor(parts[1].length / 2) - 1;
    t('★ 按钮打断：听到 = 第一句 + 第二句的一半', ai.callCut && ai.callCut.heard.length === want, { got: ai.callCut?.heard.length, want });
    t('按钮还在、打断后在听', c.C().phase === 'listening');
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(800);
    c.box.callToggleMute();
    const a = c.playing()[0];
    c.box.__mic = () => 40; await c.run(900);
    t('★ 静音时出声不打断', a.paused === false && c.C().phase === 'speaking');
  }
  {
    const c = await speakingBox({ mode: 'off' });
    await c.run(800);
    const a = c.playing()[0];
    c.box.__mic = () => 40; await c.run(900);
    t('★ 设置成「只能点按钮」时出声不打断', a.paused === false && c.C().phase === 'speaking');
  }
  {
    const c = await speakingBox({ mode: 'speaker' });
    c.box._movie = { on: true };
    await c.run(800);
    const a = c.playing()[0];
    c.box.__mic = () => 60; await c.run(1200);
    t('★ 外放 + 一起看片：片子的声音不当成你插话（只留按钮）', a.paused === false && c.C().phase === 'speaking');
    const c2 = await speakingBox({ mode: 'headset' });
    c2.box._movie = { on: true };
    await c2.run(800);
    c2.box.__mic = () => 60; await c2.run(1200);
    t('戴耳机一起看片：照样能用嗓子打断', c2.C().phase === 'listening');
  }
  {
    const c = await speakingBox({ mode: 'headset' });
    await c.run(800);
    c.box.__mic = () => 40; await c.run(48);
    const bargeRec = c.recs[c.recs.length - 1];
    c.box.closeCall();
    t('★ 候选窗口里挂断：那台录音机关了（麦克风灯不常亮）', bargeRec.state === 'inactive' && c.recording().length === 0);
    await c.run(1000);
    t('挂断之后帧循环不再跑', c.T.rafs.length === 0, c.T.rafs.length);
  }

  console.log('\n[12] 耳机/外放：接通时认一次');
  {
    const c = makeBox({ devices: [{ kind: 'audiooutput', deviceId: 'default', label: '默认 - 耳机 (USB Audio)' }] });
    await c.connect(); await c.run(16);
    t('认出了耳机', c.C().route === 'headset');
    const c2 = makeBox({ devices: [] });
    await c2.connect(); await c2.run(16);
    t('认不出来 = unknown（按外放算）', c2.C().route === 'unknown');
  }

  console.log('\n[13] 沉默时主动开口');
  {
    const c = makeBox();
    c.box.__nudgeReply = '[[SILENT]]';
    await c.connect();
    await c.run(11500);
    t('安静 11.5 秒：还没问', c.apiCalls.length === 0);
    await c.run(700);
    t('★ 安静满 12 秒：问它一次', c.apiCalls.length === 1, c.apiCalls.length);
    const q = c.apiCalls[0];
    t('问的那条不是你说的（peek 标记，不算你的消息）', q.node.peek === true && q.node.callNudge === true && /不是小明说的/.test(q.node.content) && /安静了 12 秒/.test(q.node.content), q.node);
    t('★ 提示里允许它不说话（[[SILENT]]），并且说清别查岗', /\[\[SILENT\]\]/.test(q.prompt) && /别查岗/.test(q.prompt) && /安静了 12 秒/.test(q.prompt), q.prompt);
    t('★ 它选了不说：那条和回复都悄悄收走、什么都没念', !Object.values(c.chat.nodes).some(n => n.callNudge) && c.chat.headId === 1 && c.tts.length === 0);
    t('提示读一次就清', c.box.takeCallNudgeMoment() === '');
    await c.run(11000);
    t('★ 不到 24 秒不问第二次', c.apiCalls.length === 1, c.apiCalls.length);
    await c.run(1500);
    t('满 24 秒问第二次', c.apiCalls.length === 2, c.apiCalls.length);
  }
  {
    const c = makeBox();
    c.box.__nudgeReply = '刚才说到哪了，你那边下雨了吗';
    await c.connect();
    await c.run(12100); await c.run(32);
    t('它决定开口：念出来了', c.apiCalls.length === 1 && c.C().phase === 'speaking' && c.tts.length >= 1, { api: c.apiCalls.length, ph: c.C().phase });
    let p = c.playing()[0]; if (p) { p.paused = true; p.onended(); } await c.run(32);
    t('念完回来听', c.C().phase === 'listening');
    await c.run(23000);
    t('刚念完就又安静：没到 24 秒不再说', c.apiCalls.length === 1);
    await c.run(1500); await c.run(32);
    t('第二次开口', c.apiCalls.length === 2 && c.C().phase === 'speaking');
    t('第二次的提示里说了「你刚才已经主动开过口了」', /已经主动开过口了/.test(c.apiCalls[1].prompt));
    p = c.playing()[0]; if (p) { p.paused = true; p.onended(); } await c.run(32);
    await c.run(400000);
    t('★ 连续开口两次你都没回：不再说了，等你（再安静多久都不问）', c.apiCalls.length === 2, c.apiCalls.length);
    await c.say('嗯我刚才在洗碗');
    t('你一开口：计数清零', c.C().nudge.unanswered === 0 && c.C().nudge.tries === 0);
    const p2 = c.playing()[0]; if (p2) { p2.paused = true; p2.onended(); } await c.run(32);
    await c.run(12200); await c.run(32);
    t('★ 之后安静 12 秒又可以问了', c.apiCalls.length === 3, c.apiCalls.length);
  }
  {
    const c = makeBox();
    c.box.__nudgeReply = '我在想你';
    let release; c.box.__apiGate = new Promise(r => { release = r; });
    await c.connect();
    await c.run(12100);
    t('先决条件：正在问', c.apiCalls.length === 1 && c.C().nudge.busy);
    await c.say('我回来了');
    release(); await c.run(64);
    t('★ 它还在想的时候你开口了：那句让掉（流被掐、没念出来）', c.aborted.includes('c1') && !c.tts.includes('我在想你'), c.tts);
    t('那条「安静了 N 秒」从时间线上收走了', !Object.values(c.chat.nodes).some(n => n.callNudge));
    t('你这句照常发出去了', c.sends.some(s => s.text === '我回来了'));
  }
  {
    const c = makeBox();
    c.box.__nudgeReply = '在吗';
    c.box.state.callNudgeOff = true;
    await c.connect(); await c.run(30000);
    t('★ 设置里关了：不主动开口', c.apiCalls.length === 0);
    const c2 = makeBox(); c2.box.__nudgeReply = '在吗';
    await c2.connect(); c2.box.callToggleMute(); await c2.run(30000);
    t('静音时不主动开口', c2.apiCalls.length === 0);
    const c3 = makeBox(); c3.box.__nudgeReply = '在吗';
    c3.box._movie = { on: true };
    await c3.connect(); await c3.run(30000);
    t('一起看片时不主动开口（插嘴那套管）', c3.apiCalls.length === 0);
  }

  /* ═════════ 三、接线 ═════════ */
  console.log('\n[14] 接线');
  const api = read('js/05-prompts-api.js'), rm = read('js/06-render-msg.js'), st = read('js/02-state.js'), boot = read('js/14-boot-brain-hub.js');
  const html = read('index.html');
  const bam = api.slice(api.indexOf('async function buildApiMessages('), api.indexOf('function msgSentStamp'));
  t('★ 发给模型时：被打断的 AI 消息前面带上 callCutNoteForApi', /m\.role === 'ai' && m\.callCut/.test(bam) && /callCutNoteForApi\(m\.callCut\)/.test(bam));
  t('★ 沉默那一问的提示只进 volatile', /vol \+= takeCallNudgeMoment\(\)/.test(api) && !/base \+= takeCallNudgeMoment/.test(api));
  t('电话模式提示里告诉它会被打断、附和不会发过来', /随时开口打断你/.test(api) && /附和不会发给你/.test(api));
  t('★ 气泡上画「被打断」那行', /callCutHtml\(m\)/.test(rm));
  t('★ 两个设置跟着存、刷新后读回来', /callBargeMode: state\.callBargeMode/.test(st) && /callNudgeOff: !!state\.callNudgeOff/.test(st)
    && /state\.callBargeMode = .*p\.callBargeMode/.test(boot) && /state\.callNudgeOff = !!p\.callNudgeOff/.test(boot));
  t('设置面板里有这两个选项', /id="callBargeSelect"/.test(html) && /id="callNudgeSelect"/.test(html) && /onchange="setCallBargeMode\(this\.value\)"/.test(html));
  t('打断按钮还在', /onclick="callInterrupt\(\)"/.test(html));
  t('一起看插嘴念的时候带上消息 id（被打断也能标）', /callSayUnprompted\(text, ai\.id\)/.test(PK));
  t('android 副本与 js/ 一致', ['js/11-camera-call.js', 'js/05-prompts-api.js', 'js/06-render-msg.js', 'js/23-peek.js', 'js/02-state.js', 'js/14-boot-brain-hub.js',
    'css/grancyan.css', 'css/light-patch.css', 'index.html'].every(f =>
    fs.existsSync(path.join(ROOT, 'android/assets', f)) && fs.readFileSync(path.join(ROOT, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets', f)))));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
