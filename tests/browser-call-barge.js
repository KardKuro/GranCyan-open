/* 通话插话的真浏览器冒烟（2026-10-12）。
 *
 * 为什么要真浏览器：tests/call-barge.test.js 里麦克风音量、录音机、播放器全是假的，
 * 验不了这几件只有真 Chromium 才有的事：
 *   1. 低平滑的第二个 AnalyserNode 在真的 Web Audio 里到底多快看见你出声（onset → 暂停的真实延迟）；
 *   2. 真 MediaRecorder 在候选那一刻开录、确认后被「接过去」继续录，停下时真的吐出了数据；
 *   3. 真 HTMLAudioElement 的 pause() / currentTime / play() 恢复，以及按 currentTime/duration 算出来的 heard_text。
 *
 * 做法：生成一段 30 秒的假麦克风 wav（3s 处说 2 秒话、9.5s 处咳一声、13s 处再说 2 秒），
 * 用 --use-file-for-fake-audio-capture 喂给 Chromium。转写、发消息、等 AI 这几步换成页面里的桩
 * （不需要转写服务、不调模型），TTS 换成页面里现做的 6 秒正弦波——
 * 中间那条「VAD → 暂停 → 确认/恢复 → 接过录音机 → 记说到哪」全是真代码在真浏览器里跑。
 *
 * 跑法：node tests/browser-call-barge.js（自己起 127.0.0.1:3730 的 server，跑完关掉）
 * 回声（外放）在这里验不了：headless 没有真扬声器，假麦克风也听不见页面放出来的声音。
 */
const PORT = Number(process.env.GC_PORT || 3730);
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const DEBUG_PORT = 9239;
const CHROME = process.env.CHROME_PATH
  || path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LONG_OK = r => (r.cut.heard + r.cut.unheard) === r.parts.join('');
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: DEBUG_PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

// 假麦克风：48k 单声道 16bit
function makeWav(file) {
  const SR = 48000, LEN = 30;
  const n = SR * LEN;
  const pcm = new Int16Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const speech = (t, t0, t1) => {
    if (t < t0 || t >= t1) return 0;
    const env = Math.min(1, (t - t0) / 0.02, (t1 - t) / 0.02) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * (t - t0)));
    let s = 0;
    const f0 = 170 + 20 * Math.sin(2 * Math.PI * 1.3 * t);
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    return 0.35 * env * s;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0.002 * rnd();
    v += speech(t, 3.0, 5.0);
    v += speech(t, 16.0, 18.0);
    if (t >= 10.5 && t < 10.6) v += 0.45 * rnd();        // 咳一声
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  fs.writeFileSync(file, buf);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-call-barge-'));
  const wav = path.join(tmp, 'mic.wav');
  makeWav(wav);

  const serverReady = () => new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
  let server = null;
  if (!(await serverReady())) {
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), stdio: 'ignore',
      env: { ...process.env, GRANCYAN_PORT: String(PORT), GRANCYAN_PORT_TLS: String(PORT + 1) },
    });
    for (let i = 0; i < 60 && !(await serverReady()); i++) await sleep(250);
    if (!(await serverReady())) throw new Error(`连不上 127.0.0.1:${PORT}，自动启动 server.js 也失败了`);
  }
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + path.join(tmp, 'profile'),
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch {} try { server?.kill(); } catch {} };

  try {
    let targets = null;
    for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await get('/json/list'); } catch {} }
    const page = targets && targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (!page) throw new Error('Chrome 没有打开 index.html');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0; const pend = new Map(); const errors = [];
    ws.on('message', m => {
      const o = JSON.parse(m);
      if (o.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(o.params).slice(0, 300));
      if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => { pend.delete(i); reject(new Error(method + ' 10 秒无响应')); }, 10000);
      pend.set(i, v => { clearTimeout(timer); resolve(v); });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await sleep(3500);

    console.log('\n[1] 页面里有这套函数');
    for (let i = 0; i < 20 && !(await ev(`typeof state !== 'undefined' && typeof callBargeStep === 'function'`)); i++) await sleep(500);
    const loaded = await ev(`typeof callBargeStep === 'function' && typeof _callBargeLoop === 'function' && typeof callClassifyUtterance === 'function'`);
    ok(loaded, '插话那套都挂上了', loaded ? undefined : await ev(`location.href + ' | ' + document.title + ' | ' + (document.body ? document.body.innerText.slice(0, 200) : '')`));
    if (!loaded) throw new Error('页面没加载出来：' + JSON.stringify(errors.slice(0, 3)));

    console.log('\n[2] 真跑一通：你说一句 → 它念 → 咳一声（不该打断）→ 你又开口（该打断）');
    await ev(`(() => {
      const T0 = performance.now();
      const now = () => Math.round(performance.now() - T0);
      const log = window.__log = [];
      const L = (ev, x) => log.push(Object.assign({ ev, t: now() }, x || {}));
      state.callBargeMode = 'headset';
      state.callNudgeOff = true;
      const chat = { id: 'e2e-call', title: 'e2e', headId: 1, nodes: { 1: { id: 1, role: 'ai', content: '开头', timestamp: Date.now() } } };
      state.chats.push(chat); state.activeChatId = chat.id;
      window.__chat = chat;
      const LONG = '今天我去楼下买了你最喜欢的那家奶茶。排队的人好多，等了快二十分钟。回来的路上还下雨了，不过奶茶没洒。';
      window.__LONG = LONG;
      const answers = ['你今天干嘛了', '等一下我想问你个事'];
      let nid = 1000;
      window._sttReady = () => true;
      window._callStt = async blob => { L('stt', { size: blob.size }); return answers.shift() || ''; };
      window.handleSend = (text, voice) => {
        const u = ++nid, a = ++nid;
        chat.nodes[u] = { id: u, parentId: chat.headId, role: 'user', content: text, timestamp: Date.now(), audio: voice && voice.audio };
        chat.nodes[a] = { id: a, parentId: u, role: 'ai', content: LONG, timestamp: Date.now() };
        chat.headId = a;
        L('send', { text, dur: voice && voice.dur, audioLen: voice && voice.audio ? voice.audio.length : 0, aiId: a });
      };
      window._callWaitAi = async () => chat.nodes[chat.headId];
      // TTS：现做一段 6 秒的正弦波（不走 Edge-TTS，不需要联网）
      const tone = secs => {
        const SR = 24000, n = SR * secs, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true);
        d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, SR, true); d.setUint32(28, SR * 2, true);
        d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 330 * i / SR) * 3000), true);
        return new Blob([b], { type: 'audio/wav' });
      };
      window._callFetchPart = async text => { L('tts', { text }); return { url: URL.createObjectURL(tone(6)) }; };
      // 量：插话三个动作发生的时刻、那一刻放到哪了、那一帧的音量
      const wrap = name => { const f = window[name]; window[name] = function () {
        const a = _call.audio; L(name, { cur: a ? +a.currentTime.toFixed(3) : null, dur: a ? a.duration : null, vol: +_callBargeVol().toFixed(1), part: _call.say ? _call.say.i : null });
        return f.apply(this, arguments); }; };
      ['_callBargePause', '_callBargeResume', '_callBargeConfirm'].forEach(wrap);
      // 每一帧的插话音量（只留说话阶段的），用来看 onset → 暂停隔了多久
      const vf = window._callBargeVol; window.__vols = [];
      window._callBargeVol = function () { const v = vf(); if (window.__vols.length < 4000) window.__vols.push([now(), +v.toFixed(1)]); return v; };
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async c => { const s = await gum(c); L('gum', { constraints: c }); return s; };
      openCall();
      return true;
    })()`);
    await sleep(25000);
    const r = await ev(`(() => {
      const chat = window.__chat;
      const ais = Object.values(chat.nodes).filter(n => n.role === 'ai' && n.id > 1000);
      return { log: window.__log, phase: _call.phase, route: _call.route, rec: _call.rec && _call.rec.state,
        cut: ais[0] && ais[0].callCut, parts: _callSpeakParts(window.__LONG), vols: window.__vols };
    })()`);
    const L = r.log;
    const evs = n => L.filter(x => x.ev === n);
    console.log('    事件：' + L.filter(x => x.ev !== 'tts').map(x => `${x.ev}@${x.t}${x.cur != null ? `(放到${x.cur}s 音量${x.vol})` : ''}${x.text ? `「${x.text}」` : ''}`).join(' → '));
    console.log('    认出来的输出：' + r.route);
    const g = evs('gum')[0];
    ok(g && g.constraints.audio.echoCancellation === true && g.constraints.audio.noiseSuppression === true && g.constraints.audio.autoGainControl === true,
      '★ getUserMedia 真的带着回声消除 / 降噪 / 自动增益', g && g.constraints);
    const sends = evs('send');
    ok(sends[0] && sends[0].text === '你今天干嘛了', '第一句：听你说完、发出去了', sends);
    ok(evs('tts').length >= 2, '它开始一句一句念了', evs('tts').length);
    const pauses = evs('_callBargePause'), resumes = evs('_callBargeResume'), confirms = evs('_callBargeConfirm');
    const gt = g ? g.t : 0;
    // 咳嗽：Chrome 的降噪经常直接把 100ms 的噪声吃掉（那就连暂停都不会有）；要是暂停了，必须接着放、不能确认
    const bp = pauses.find(p => p.t - gt > 15000);
    const early = pauses.filter(p => !bp || p.t < bp.t);
    const coughVol = Math.max(0, ...r.vols.filter(([t]) => t - gt > 9500 && t - gt < 12500).map(([, v]) => v));
    console.log(`    咳嗽那段：插话分析器看到的最大音量 ${coughVol.toFixed(1)}，暂停 ${early.length} 次`);
    ok(!confirms.length || (bp && confirms[0].t > bp.t), '★ 咳一声（10.5s 处）没被当成打断', { early, confirms });
    ok(early.every(p => resumes.some(x => x.t > p.t && x.t - p.t >= 640 && x.t - p.t < 900)), '咳嗽要是触发了暂停：≈650ms 后接着放', { early, resumes });
    ok(!!bp, '★ 16s 处你又开口：先暂停', pauses.map(p => p.t - gt));
    const cf = confirms[0];
    ok(cf && bp && cf.t - bp.t >= 640 && cf.t - bp.t < 900, '★ 约 650ms 后确认成打断', cf && bp && cf.t - bp.t);
    // onset → 暂停：从「最后一帧还没声」到暂停那一帧。headless 的 rAF 不是 60fps，一帧就可能超过 40ms，
    // 所以这里量的是上界（声音最早可能在上一帧之后就开始了）
    if (bp) {
      const thr = 22;
      const prev = r.vols.filter(([t, v]) => t < bp.t && v <= thr).pop();
      const frames = r.vols.filter(([t]) => t > bp.t - 1000 && t < bp.t).map(([t]) => t);
      const gaps = frames.slice(1).map((t, i) => t - frames[i]).filter(g => g > 0).sort((x, y) => x - y);
      const lat = prev ? bp.t - prev[0] : null;
      console.log(`    最后一帧还没声 → 暂停：${lat}ms（这台 headless 的帧间隔中位数 ${gaps[gaps.length >> 1]}ms）`);
      ok(lat != null && lat <= 80, '★ 出声到暂停 ≤ 80ms（按帧算的上界）', lat);
    }
    ok(sends[1] && sends[1].text === '等一下我想问你个事', '★ 你说完：这句照常发出去了', sends.map(s => s.text));
    ok(sends[1] && sends[1].dur >= 1.8, '★ 录音从你开口那一刻就在录（接过来的那台，时长 ≈ 2 秒以上）', sends[1] && sends[1].dur);
    ok(sends[1] && sends[1].audioLen > 1000, '真录到了音频数据', sends[1] && sends[1].audioLen);
    const parts = r.parts;
    ok(r.cut && r.cut.unheard && LONG_OK(r), '★ 那条消息标了说到哪（heard + unheard 拼回去就是整段）', r.cut);
    if (r.cut && cf && cf.part != null) {
      const before = parts.slice(0, cf.part).join('').length;
      const est = before + Math.max(0, Math.floor(parts[cf.part].length * cf.cur / cf.dur) - 1);
      ok(r.cut.heard.length === est, `★ heard 截断跟暂停那一刻的真实播放进度对得上（第 ${cf.part + 1} 句放到 ${cf.cur}s / ${cf.dur}s → 共听到 ${r.cut.heard.length} 字）`, { got: r.cut.heard.length, est });
    }
    ok(errors.length === 0, '页面没有未捕获的异常', errors);
    await ev(`closeCall(), true`);
    ws.close();
  } finally {
    cleanup();
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
