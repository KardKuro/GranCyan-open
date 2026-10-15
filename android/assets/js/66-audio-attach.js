/* ══════════════════════════════════════════════════════════════════
   发音频给 AI 听
   ──────────────────────────────────────────────────────────────────
   Claude / GPT 都听不见，只吃文字和图。所以和视频抽帧成图一个思路：把音频翻成文字。
   两层，和点歌的「听歌」那套一样（js/24-music.js）：
     ① 本机算的：解码后跑 musicSongFeatures，速度/亮暗/起伏/调性。粗，只对音乐有意义。
     ② 电脑上的 Gemini 从头听一遍（server/audio-listen.js）：是什么、谁在说/唱、原话、情绪、时间线。
   结果是一份文字附件，进 _pendingFiles —— 后面发送、存盘、云同步、各家格式转换都和发文档一样，
   一行不用改；只有 buildApiMessages 那里给 kind:'audio' 免了行号。

   ⚠️ 全走 SERVER_BASE（电脑那台），Gemini 的 key 在电脑的 .env 里。电脑连不上时只剩 ①，
      而 ① 对说话录音没意义 —— 那种情况直接报错，不塞一份空洞的「听感」进去装作听过。
   ⚠️ Gemini 只认六种音频 MIME（wav/mp3/aiff/aac/ogg/flac）。m4a/opus/wma/amr 这些先在浏览器里
      解码、转成 16k 单声道 wav 再发 —— Gemini 自己也会降到 16k 单声道，所以不丢东西。
      代价是 wav 体积大：14MB 只装得下 7 分多钟，再长就截前面一段，并且明说截了。 */

const AUDIO_CFG = {
  maxBytes: 14 * 1024 * 1024,    // 和 server/audio-listen.js 的 MAX_AUDIO_BYTES 一致（inline 20MB 扣掉 base64 膨胀）
  maxFileBytes: 120 * 1024 * 1024, // 再大解码就要吃掉几百 MB 内存了，手机上直接崩
  wavSr: 16000,
};
// 扩展名要一起认：.amr/.opus/.wma 在 Windows 和安卓 WebView 上常常报空 MIME（同 30-video.js 的教训）
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'amr', 'aif', 'aiff', 'caf', 'mka'];
function isAudioFile(file) {
  if (!file) return false;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (AUDIO_EXTS.includes(ext)) return true;
  const t = (file.type || '').toLowerCase();
  return t.startsWith('audio/') && !/mpegurl|scpls|x-ms-wax|x-ms-wvx/.test(t);   // 播放列表文件也报 audio/*，那是文本
}

// 不转码能直接给 Gemini 的格式 → 发出去的 Content-Type；不能的回 ''
function _audGeminiMime(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  const map = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff' };
  return map[ext] || '';
}

function _audFmt(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Float32 单声道 → 16k 16bit wav。降采样用区间平均（盒式滤波），够 Gemini 听，不追求 hi-fi。
// maxBytes 装不下就截前面，返回 { blob, cut }
function _audWav(d, sr, maxBytes) {
  const tsr = AUDIO_CFG.wavSr, ratio = sr / tsr;
  const full = Math.floor(d.length / ratio);
  const n = Math.min(full, Math.floor((maxBytes - 44) / 2));
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, tsr, true); v.setUint32(28, tsr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b && k < d.length; k++) s += d[k];
    const x = Math.max(-1, Math.min(1, s / (b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return { blob: new Blob([buf], { type: 'audio/wav' }), cut: n < full };
}

// 本机解码：拿时长、单声道采样，算不出来回 null（浏览器解不了这个编码）
async function _audDecode(file) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const sr = typeof _M_FEAT_SR !== 'undefined' ? _M_FEAT_SR : 22050;
  try {
    const buf = await new OAC(1, 1, sr).decodeAudioData(await file.arrayBuffer());
    const n = buf.length, ch = buf.numberOfChannels, d = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const x = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] += x[i] / ch; }
    return { d, sr: buf.sampleRate, dur: buf.duration };
  } catch (e) {
    console.warn('[听音频] 浏览器解不开：', e && e.message || e);
    return null;
  }
}

// 一个文件 → 给 AI 看的那段文字。progress(s) 用来改附件条上的小字
async function audioListenNote(file, progress) {
  if (file.size > AUDIO_CFG.maxFileBytes) throw new Error(`「${file.name}」太大了（${Math.round(file.size / 1048576)}MB），剪一段再发`);
  progress && progress('解码中…');
  const dec = await _audDecode(file);
  // ① 本机听感：只对音乐有意义，先算着，后面看 Gemini 说这是什么再决定要不要附上
  let hint = '';
  if (dec && typeof musicSongFeatures === 'function') {
    try {
      const f = await musicSongFeatures(dec.d, dec.sr, () => new Promise(r => setTimeout(r, 0)));
      if (f && typeof musicSongHint === 'function') hint = musicSongHint(f);
    } catch (e) { /* 算不出来就不附 */ }
  }
  // ② 要发给 Gemini 的那份
  let body = null, ct = '', cut = false;
  const raw = _audGeminiMime(file);
  if (raw && file.size <= AUDIO_CFG.maxBytes) { body = file; ct = raw; }
  else if (raw === 'audio/mpeg') { body = file.slice(0, AUDIO_CFG.maxBytes); ct = raw; cut = true; }   // mp3 按帧存，截字节不坏
  else if (dec) { const wv = _audWav(dec.d, dec.sr, AUDIO_CFG.maxBytes); body = wv.blob; ct = 'audio/wav'; cut = wv.cut; }
  else throw new Error(`「${file.name}」这个格式解不开，转成 mp3 再发`);
  const dur = dec ? dec.dur : 0;
  progress && progress('Gemini 在听…');
  let j = null, err = '';
  try {
    const qs = `name=${encodeURIComponent(file.name || '')}&dur=${Math.round(dur)}${cut ? '&cut=1' : ''}`;
    const r = await fetch(`${SERVER_BASE}/api/audio/listen?${qs}`, { method: 'POST', headers: { 'Content-Type': ct }, body });
    j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.text) err = (j && j.error) || ('HTTP ' + r.status);
  } catch (e) { err = '连不上电脑（' + (e.message || e) + '）'; }

  const head = `[她发来的音频「${file.name}」${dur ? `，时长 ${_audFmt(dur)}` : ''}]`;
  if (err) {
    // 没听成：音乐还能靠本机那几个数撑一下，别的（说话录音）给几个数等于骗它，直接报错
    if (!hint) throw new Error('没听成：' + err);
    showToast('🎧 Gemini 没听成，只附上本机算的听感：' + err, 'info', 4500);
    return `${head}\n（没能整段听：${err}。下面只有本机按波形算的几个数，听不出唱了什么、是不是人声）\n听感：${hint}`;
  }
  const musical = /歌曲|纯音乐|哼唱|清唱|混合/.test(j.kind || '');
  return `${head}\n（你自己听不见原声；下面是另一个模型从头听过一遍写的${cut ? '，太长只听了前面一段' : ''}）\n${j.text}`
    + (musical && hint ? `\n本机按波形算的听感（粗）：${hint}` : '');
}

// 所有入口（📎 文件、拖拽、粘贴）都走这里
function addAudioFile(file) {
  const ph = { name: '🎧 ' + (file.name || '音频'), content: '', loading: true, loadingText: '在听…', kind: 'audio' };
  _pendingFiles.push(ph);
  renderPendingFiles();
  audioListenNote(file, s => { ph.loadingText = s; if (_pendingFiles.includes(ph)) renderPendingFiles(); })
    .then(text => {
      ph.content = text; ph.loading = false; delete ph.loadingText;
      if (_pendingFiles.includes(ph)) renderPendingFiles();   // 等的时候被 × 掉了就算了
    })
    .catch(e => {
      const i = _pendingFiles.indexOf(ph);
      if (i >= 0) _pendingFiles.splice(i, 1);                  // indexOf 为 -1 时别 splice(-1,1) 删到别人
      renderPendingFiles();
      showToast('🎧 ' + (e.message || e), 'error', 4500);
    });
}
