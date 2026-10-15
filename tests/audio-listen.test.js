'use strict';
// 聊天里发音频（用户）：前端 js/66-audio-attach.js 把音频交给电脑上的 Gemini 听，
// 听到的东西变成一份文字附件（server/audio-listen.js）。
//
// 分四块：
//   ① server：MIME 归一、模型 JSON → 文字（时间轴写出界的丢掉、说话类标「原话」、全空当失败）
//   ② 前端判音频：扩展名优先、播放列表 .m3u 不算、大写扩展名照认
//   ③ 前端组装：wav 头和截断、该不该转码、听感只附给音乐、没听成又没听感就报错不硬塞
//   ④ 接线：三个入口都先认音频，发给模型时音频不带行号
// 真 Gemini 那一发不在这里（要 key、要代理、要联网），手法见文件尾。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

(async () => {
  // ── ① server ──
  const S = require(path.join(ROOT, 'server/audio-listen.js'));
  t('mp3 的各种写法都归到 audio/mp3', ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg; charset=x'].every(m => S.geminiMime(m) === 'audio/mp3'));
  t('wav / flac / ogg 归一', S.geminiMime('audio/x-wav') === 'audio/wav' && S.geminiMime('audio/x-flac') === 'audio/flac' && S.geminiMime('audio/ogg') === 'audio/ogg');
  t('Gemini 不认的格式回空（前端该转码的）', S.geminiMime('audio/mp4') === '' && S.geminiMime('audio/webm') === '' && S.geminiMime('') === '');

  const sp = S.formatListen({
    kind: '说话', summary: '她在路上说今天很累', voice: '女声，有点哑', transcript: '今天好累啊[听不清]',
    sections: [{ start: '0:20', label: '叹气' }, { start: '0:00', label: '开口' }, { start: '9:99', label: '坏时间' }, { start: '5:00', label: '出界' }],
    sounds: ['车流声'], guess: '', other: '',
  }, 40);
  t('说话类：原话照写', sp && sp.kind === '说话' && sp.text.includes('原话：\n今天好累啊[听不清]'), sp);
  t('时间线按时间排，出界和写坏的丢掉', sp && /0:00 开口\n0:20 叹气/.test(sp.text) && !sp.text.includes('出界') && !sp.text.includes('坏时间'), sp && sp.text);
  t('空字段不出空行', sp && !/认出来的歌|其他：/.test(sp.text));
  const song = S.formatListen({ kind: '歌曲', summary: '慢情歌', transcript: '讲分手', guess: '《晴天》周杰伦，八成把握' }, 0);
  t('歌曲：歌词写「内容」不写「原话」，认出来的歌带上', song && song.text.includes('内容：\n讲分手') && song.text.includes('认出来的歌：《晴天》'));
  t('只剩类型 = 等于没听，当失败', S.formatListen({ kind: '混合' }, 10) === null && S.formatListen(null) === null);
  const pr = S.buildListenPrompt({ name: 'a.mp3', dur: 65, cut: true });
  t('提示词带时长和「截了一段」', pr.includes('1:05') && pr.includes('只截了前面一段'));
  t('server.js 挂上了', read('server.js').includes("require('./server/audio-listen').mount(app, { outboundAgent })"));

  // 路由：假 app 抓 handler，假 geminiOnce
  console.log('① 路由');
  process.env.GEMINI_API_KEY = 'test-key';
  const _warn = console.warn, _log = console.log;
  console.warn = (...a) => { if (!String(a[0]).startsWith('[听音频')) _warn(...a); };
  console.log = (...a) => { if (!String(a[0]).startsWith('[听音频')) _log(...a); };
  const mkRoute = onceImpl => {
    let h = null;
    S.mount({ post: (p, mw, fn) => { if (p === '/api/audio/listen') h = fn; } }, { outboundAgent: async () => null, geminiOnce: onceImpl, retryMs: 0 });
    return async (ct, body, q = {}) => {
      let code = 200, out = null;
      await h({ headers: { 'content-type': ct }, body, query: q }, { status(c) { code = c; return this; }, json(j) { out = j; } });
      return { code, out };
    };
  };
  const good = JSON.stringify({ kind: '说话', summary: '在说话', transcript: '你好' });
  let n = 0;
  let route = mkRoute(async () => { n++; if (n === 1) throw new Error('Gemini 这个模型正忙（503）：busy'); return { text: good, model: 'm' }; });
  let rr = await route('audio/mpeg', Buffer.alloc(4096));
  t('两个模型都正忙：歇一下再来一轮，第二轮成了', n === 2 && rr.code === 200 && rr.out.kind === '说话', { n, rr });
  n = 0;
  route = mkRoute(async () => { n++; throw new Error('Gemini 报错 HTTP 400：出口 IP 地区不支持'); });
  rr = await route('audio/mpeg', Buffer.alloc(4096));
  t('不是「正忙」的错：不重试，直接报', n === 1 && rr.code === 502 && /出口 IP/.test(rr.out.error), { n, rr });
  n = 0;
  route = mkRoute(async () => { n++; throw new Error('正忙 503'); });
  rr = await route('audio/mpeg', Buffer.alloc(4096));
  t('重试那轮还是忙：只重试一次，报错', n === 2 && rr.code === 502);
  rr = await route('audio/mp4', Buffer.alloc(4096));
  t('Gemini 不认的格式：415，不花调用', rr.code === 415 && n === 2);
  rr = await route('audio/mpeg', Buffer.alloc(10));
  t('空/太小的 body：400', rr.code === 400);
  console.warn = _warn; console.log = _log;

  // ── ②③ 前端 ──
  const src = read('js/66-audio-attach.js');
  const calls = [], toasts = [];
  let fetchImpl = null, decodeOk = true;
  const ctx = {
    console, Blob, Math, setTimeout, Promise, encodeURIComponent, Float32Array, ArrayBuffer, DataView, String, Error,
    SERVER_BASE: 'http://srv',
    _pendingFiles: [], renderPendingFiles() {}, showToast(m) { toasts.push(m); },
    musicSongFeatures: async () => ({ bpm: 120 }), musicSongHint: () => '约 120 BPM',
    fetch: (...a) => { calls.push(a); return fetchImpl(...a); },
  };
  ctx.window = {
    OfflineAudioContext: function () {
      return { decodeAudioData: async () => {
        if (!decodeOk) throw new Error('解不开');
        const d = new Float32Array(22050 * 6).fill(0.5);
        return { length: d.length, numberOfChannels: 1, sampleRate: 22050, duration: 6, getChannelData: () => d };
      } };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '; this.A = { isAudioFile, _audGeminiMime, _audWav, audioListenNote, addAudioFile, AUDIO_CFG };', ctx);
  const A = ctx.A;
  const F = (name, type = '', size = 1000) => ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(8), slice: (a, b) => ({ sliced: [a, b] }) });

  t('常见音频扩展名都认', ['a.mp3', 'b.M4A', 'c.amr', 'd.opus', 'e.flac', 'f.wav'].every(n => A.isAudioFile(F(n))));
  t('MIME 是 audio/* 也认', A.isAudioFile(F('noext', 'audio/x-something')));
  t('播放列表 .m3u（audio/x-mpegurl）不算', !A.isAudioFile(F('list.m3u', 'audio/x-mpegurl')));
  t('视频和源码不算', !A.isAudioFile(F('v.mp4', 'video/mp4')) && !A.isAudioFile(F('app.ts', 'video/vnd.dlna.mpeg-tts')));
  t('m4a/opus 不直发（要转 wav），mp3/flac 直发', A._audGeminiMime(F('a.m4a')) === '' && A._audGeminiMime(F('a.opus')) === '' && A._audGeminiMime(F('a.mp3')) === 'audio/mpeg' && A._audGeminiMime(F('a.flac')) === 'audio/flac');

  // wav：44.1k 1 秒 → 16k，头写对
  const one = new Float32Array(44100).fill(0.25);
  const w = A._audWav(one, 44100, 10 * 1024 * 1024);
  const wb = Buffer.from(await w.blob.arrayBuffer());
  t('wav 头：RIFF/WAVE、16k、单声道、16bit', wb.toString('ascii', 0, 4) === 'RIFF' && wb.toString('ascii', 8, 12) === 'WAVE'
    && wb.readUInt32LE(24) === 16000 && wb.readUInt16LE(22) === 1 && wb.readUInt16LE(34) === 16, [wb.readUInt32LE(24), wb.readUInt16LE(22)]);
  t('wav：1 秒 = 16000 个采样，没截', wb.readUInt32LE(40) === 32000 && wb.length === 44 + 32000 && !w.cut);
  t('wav：采样值对（0.25 → ≈8191）', Math.abs(wb.readInt16LE(44 + 2000) - 8191) <= 1, wb.readInt16LE(44 + 2000));
  const wc = A._audWav(one, 44100, 44 + 2000);
  t('wav：装不下就截，并报 cut', wc.cut && (await wc.blob.arrayBuffer()).byteLength === 44 + 2000);

  // 组装：说话录音，Gemini 听成了 → 不附听感
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '类型：说话\n原话：\n你好', kind: '说话' }) });
  let note = await A.audioListenNote(F('voice.m4a', 'audio/mp4', 5000));
  t('说话：头里有文件名和时长，正文是 Gemini 写的', note.includes('[她发来的音频「voice.m4a」，时长 0:06]') && note.includes('原话：\n你好'), note);
  t('说话：不附波形听感', !note.includes('BPM'));
  t('m4a 转成 wav 发', calls.at(-1)[1].headers['Content-Type'] === 'audio/wav' && /dur=6/.test(calls.at(-1)[0]));

  // 歌：附听感；mp3 小于上限直发原文件
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '类型：歌曲', kind: '歌曲' }) });
  const mp3 = F('song.mp3', 'audio/mpeg', 3000);
  note = await A.audioListenNote(mp3);
  t('歌曲：附上本机听感', note.includes('本机按波形算的听感（粗）：约 120 BPM'));
  t('mp3 原样直发', calls.at(-1)[1].body === mp3 && calls.at(-1)[1].headers['Content-Type'] === 'audio/mpeg' && !/cut=1/.test(calls.at(-1)[0]));
  // 超大 mp3：按字节截，带 cut=1
  await A.audioListenNote(F('long.mp3', 'audio/mpeg', A.AUDIO_CFG.maxBytes + 10));
  t('超大 mp3 截前 14MB 并标 cut=1', calls.at(-1)[1].body.sliced && calls.at(-1)[1].body.sliced[1] === A.AUDIO_CFG.maxBytes && /cut=1/.test(calls.at(-1)[0]));

  // 没听成：有听感 → 退回听感；连解码都失败（没听感）→ 报错
  fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({ error: 'Gemini 503' }) });
  note = await A.audioListenNote(F('song.mp3', 'audio/mpeg', 3000));
  t('没听成但有听感：退回听感并明说没听成', note.includes('没能整段听：Gemini 503') && note.includes('约 120 BPM') && toasts.some(m => m.includes('没听成')));
  decodeOk = false;
  let threw = '';
  try { await A.audioListenNote(F('voice.mp3', 'audio/mpeg', 3000)); } catch (e) { threw = e.message; }
  t('没听成又没听感：报错，不塞一份空的进去', threw.includes('没听成：Gemini 503'), threw);
  threw = '';
  try { await A.audioListenNote(F('x.amr', '', 3000)); } catch (e) { threw = e.message; }
  t('解不开又不能直发：叫她转 mp3', threw.includes('转成 mp3'), threw);
  decodeOk = true;

  // addAudioFile：占位 → 填好；失败 → 占位拿掉
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '类型：哼唱', kind: '哼唱' }) });
  ctx._pendingFiles.length = 0;
  A.addAudioFile(F('hum.wav', 'audio/wav', 3000));
  t('加进来先是「在听」的占位，带 kind', ctx._pendingFiles.length === 1 && ctx._pendingFiles[0].loading && ctx._pendingFiles[0].kind === 'audio');
  await new Promise(r => setTimeout(r, 50));
  t('听完：占位变成内容', !ctx._pendingFiles[0].loading && ctx._pendingFiles[0].content.includes('类型：哼唱') && !('loadingText' in ctx._pendingFiles[0]));
  fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({ error: 'x' }) });
  decodeOk = false;
  ctx._pendingFiles.length = 0;
  A.addAudioFile(F('bad.mp3', 'audio/mpeg', 3000));
  await new Promise(r => setTimeout(r, 50));
  t('失败：占位拿掉，弹提示', ctx._pendingFiles.length === 0 && toasts.at(-1).includes('没听成'));
  decodeOk = true;

  // ── ④ 接线 ──
  const html = read('index.html');
  t('index.html 引了 66-audio-attach.js', html.includes('<script src="./js/66-audio-attach.js"></script>'));
  t('📎 文件的选择框收音频', /id="textFileInput"[\s\S]{0,400}accept="[^"]*audio\/\*[^"]*\.m4a/.test(html));
  const inp = read('js/09-appearance-input.js');
  const up = inp.slice(inp.indexOf('function handleTextFileUpload'), inp.indexOf('function openFileViewer'));
  t('选文件：先认音频再认文档', up.indexOf('isAudioFile') > 0 && up.indexOf('isAudioFile') < up.indexOf('isDocxFile'));
  t('等着听的音频附件可以 ×（文档不行）', inp.includes("f.loading && f.kind !== 'audio' ? '' :"));
  const mm = read('js/12-math-media.js');
  const drop = mm.slice(mm.indexOf("inputBar.addEventListener('drop'"));
  t('拖拽：音频排在视频前（.ogg/.webm 那类别被抽帧抢走）', drop.indexOf('isAudioFile') > 0 && drop.indexOf('isAudioFile') < drop.indexOf('isVideoFile'));
  const paste = mm.slice(mm.lastIndexOf('item.kind === \'file\''), mm.indexOf("inputBar.addEventListener('drop'"));
  t('粘贴：先认音频', paste.indexOf('isAudioFile') > 0 && paste.indexOf('isAudioFile') < paste.indexOf('isDocxFile'));
  const api = read('js/05-prompts-api.js');
  const fb = api.slice(api.indexOf('m.files && m.files.length > 0'), api.indexOf('【用户问题】'));
  t('发给模型：音频不加行号', /fileObj\.kind === 'audio'[\s\S]*?附件音频[\s\S]*?else if/.test(fb));
  t('还在听时拦发送，提示说的是音频', api.includes("f.kind === 'audio') ? '🎧 音频还在听"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// 真 Gemini 手法（2026-10-08 验过）：另起一个 PORT 的 server，
// curl -X POST "http://127.0.0.1:<port>/api/audio/listen?name=x.mp3&dur=30" -H "Content-Type: audio/mpeg" --data-binary @x.mp3
