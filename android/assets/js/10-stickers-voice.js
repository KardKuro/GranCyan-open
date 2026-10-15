// 会有两轮同时在飞：启动时 12-math-media.js 末尾无条件跑一轮（那会儿 currentUser 还是 null），
// checkUser() 认出登录后再跑一轮。两轮的 Promise.all 谁先谁后**不由发起顺序决定**——
// 局域网 server 拉得慢的时候，先发的那轮反而后落地，把已经拿到云端收藏的结果覆盖成没有云端的旧货。
// 而状态是各自的 loadCloudStickers 内部写的，会跟列表对不上：列表是失败那轮的、状态是成功那轮的
// → 收藏栏空着、banner 还不吭声，正是这次要修的病本身。
// 所以：一轮一个号，只有最新那轮能提交；列表和状态必须由同一轮一起写进去（原子）。
let _stickerLoadGen = 0;
async function loadStickers() {
  const gen = ++_stickerLoadGen;
  const [cloud, server, builtin, packs] = await Promise.all([
    loadCloudStickers(), loadServerStickers(), loadBuiltinStickers(), loadPackStickers()
  ]);
  if (gen !== _stickerLoadGen) return;   // 有更新的一轮已经落地了，这轮的结果作废
  _cloudStickerState = cloud.state;
  // 包的元信息（名字/图标）和它的表情必须同一轮一起落地，跟列表/状态是一个道理：
  // 标签栏画的是 _stickerPacks，格子画的是 _stickerList，两者对不上就会出现「有栏点进去是空的」。
  _stickerPacks = packs.packs;
  const merged = new Map();
  // 内置表情打在 APK 里，离线可用、永远秒开，同名时必须赢过局域网/云端 URL
  // 包里的表情不参与按 name 去重（key 带包名）：它跟收藏重名时该在自己那一栏里照样显示，
  // 被吞掉的话症状是「某一栏莫名少几张」，而那一栏本来就是按文件夹一一对应的。
  // 电脑 stickers/ 里的自带库也要排在云端前面：自带的那批在云端也可能传过同名副本，
  // 云端先到就把它们全抢成「收藏」，自带库那栏反而空了（实际出现过：自带的全跑进了收藏）。
  // 收藏（custom）照旧排在云端后面，两边同名时仍以云端那份为准。
  const serverLib = server.filter(s => !s.custom), serverFav = server.filter(s => s.custom);
  for (const s of [...builtin, ...packs.items, ...serverLib, ...cloud.items, ...serverFav]) {
    // 包里的用**文件名**（带扩展名）当键，不能用 name —— name 是去了扩展名的显示名，
    // 同一个包里放了 爱心.gif 和 爱心.png 就会撞成一个键，静静吞掉一张（Codex 审出来的）。
    const key = s.source === 'pack' ? `pack:${s.pack}/${s.file}` : s.name;
    if (!merged.has(key)) merged.set(key, s);
  }
  _stickerList = Array.from(merged.values());
  console.log(`[表情包] 已加载 ${_stickerList.length} 个（云端${cloud.items.length} 服务器${server.length} 内置${builtin.length} 包${packs.items.length}/${packs.packs.length}组）`
    + (_cloudStickerState.ok ? '' : ` ⚠️ 云端没拉到：${_cloudStickerState.reason} ${_cloudStickerState.detail}`));
  // 谁提交谁负责重绘。以前重绘全靠调用方在 `await loadStickers()` 后面自己补一句，
  // 加了 generation 之后这就漏风了：作废那轮的调用方照样往下重绘（画的是旧状态），
  // 而真正提交的那轮如果调用方没写重绘，界面就永远停在旧画面。两头都错，还都不报错。
  // 标签栏也归这轮负责：包是磁盘扫出来的，可能这一轮才多出一个文件夹 —— 只重画格子的话，
  // 新包的表情已经在 _stickerList 里了，栏却还没有，点不进去也看不见。
  if (typeof renderStickerTabs === 'function') renderStickerTabs();
  if (typeof renderLocalStickers === 'function' && _stickerTab !== 'search') renderLocalStickers();
}

async function loadServerStickers() {
  try {
    const res = await fetch(SERVER_BASE + '/api/stickers');
    const list = await res.json();
    // custom=true 的收藏住在 stickers-fav/，自带库住在 stickers/（见 server.js /api/stickers）
    return list.map(s => ({
      ...s,
      url: SERVER_BASE + (s.custom ? '/stickers-fav/' : '/stickers/') + encodeURIComponent(s.file),
      source: 'server'
    }));
  } catch(e) { return []; }
}

// APK 内置表情包（build.ps1 打包时把 stickers/ 复制进 assets 并生成 manifest）
async function loadBuiltinStickers() {
  if (!IS_APP) return [];
  try {
    const res = await fetch('/stickers/manifest.json');
    const list = await res.json();
    return list.map(s => ({ ...s, url: '/stickers/' + encodeURIComponent(s.file), source: 'builtin' }));
  } catch(e) { return []; }
}

// 表情包「包」= stickers-packs/<包id>/ 一个文件夹一栏（文件夹里放图 + 可选的 pack.json）。
// 两个来源都要拉、本地优先：
//   /stickers-packs/packs.json  打进 APK 的快照，离线可用（build.ps1 生成）
//   SERVER_BASE /api/sticker-packs  电脑上实时列目录 —— 用户新建的文件夹不重新打包也能在手机上看到
// 同 id 的包以本地那份为准（URL 不依赖局域网，断网也显示得出来），
// 但**服务器那份多出来的表情要补进去**：只认本地会让「新加的图看不见」，只认服务器则一断网整栏空。
async function loadPackStickers() {
  const sources = [];
  if (IS_APP) sources.push(fetch('/stickers-packs/packs.json').then(r => r.json()).then(p => ({ from: 'app', packs: p })).catch(() => null));
  sources.push(fetch(SERVER_BASE + '/api/sticker-packs').then(r => r.json()).then(p => ({ from: 'server', packs: p })).catch(() => null));
  const got = (await Promise.all(sources)).filter(Boolean);
  const packMap = new Map();   // id → { meta, items:Map(file→item) }
  for (const g of got) {
    const base = g.from === 'app' ? '' : SERVER_BASE;
    for (const p of (Array.isArray(g.packs) ? g.packs : [])) {
      if (!p || !p.id) continue;
      const dirUrl = `${base}/stickers-packs/${encodeURIComponent(p.id)}/`;
      let entry = packMap.get(p.id);
      if (!entry) {
        entry = { meta: { id: p.id, name: p.name || p.id, desc: p.desc || '', iconUrl: p.icon ? dirUrl + encodeURIComponent(p.icon) : '' }, items: new Map() };
        packMap.set(p.id, entry);
      }
      for (const it of (p.items || [])) {
        if (entry.items.has(it.file)) continue;      // 先到的（本地那份）赢
        entry.items.set(it.file, {
          name: it.name, desc: it.desc || it.name, emoji: '🖼',
          file: it.file, url: dirUrl + encodeURIComponent(it.file),
          source: 'pack', pack: p.id, packName: entry.meta.name
        });
      }
    }
  }
  const packs = [], items = [];
  for (const [, entry] of packMap) {
    packs.push({ ...entry.meta, count: entry.items.size });
    items.push(...entry.items.values());
  }
  return { packs, items };
}

// 云端表情包（Supabase Storage 的 stickers 桶，按 用户id/文件名 存放，登录后全设备同步）
// 返回 { items, state } 而不是直接写 _cloudStickerState：状态必须和它对应的那份列表
// 一起交给 loadStickers 原子落地，否则并发两轮会出现「列表是失败那轮的、状态是成功那轮的」。
// 三种结局含义完全不同，必须分开报给用户看：
//   ok         拉到了
//   logged-out 掉登录了（session 刷不动的时候会静悄悄变成这个）
//   error      列表请求失败或 8 秒超时（网络/代理）
// 谁都别再默默 return [] 了 —— 那正是「收藏全丢了」这个错觉的来源。
async function loadCloudStickers() {
  if (!currentUser) {
    return { items: [], state: { ok: false, reason: 'logged-out', detail: '' } };
  }
  try {
    // 手机直连 Supabase 可能被限速到 10 秒以上，别让它拖住 loadStickers 的 Promise.all
    const { data, error } = await Promise.race([
      supabaseClient.storage.from(STICKER_BUCKET).list(currentUser.id, { limit: 500 }),
      new Promise(res => setTimeout(() => res({ data: null, error: { message: '超时 (8s)' } }), 8000))
    ]);
    if (error) {
      console.warn('[表情包] 云端列表失败:', error.message);
      return { items: [], state: { ok: false, reason: 'error', detail: error.message } };
    }
    const items = (data || [])
      .filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f.name))
      .map(f => {
        const base = f.name.replace(/\.[^.]+$/, '');
        const { data: pub } = supabaseClient.storage.from(STICKER_BUCKET).getPublicUrl(currentUser.id + '/' + f.name);
        return { name: base, desc: base, emoji: '☁️', file: f.name, url: pub.publicUrl, source: 'cloud' };
      });
    return { items, state: { ok: true, reason: '', detail: '' } };
  } catch(e) {
    console.warn('[表情包] 云端加载异常:', e.message);
    return { items: [], state: { ok: false, reason: 'error', detail: e.message } };
  }
}

// 上传一张表情：已登录优先存云端，失败或未登录回退本地服务器
async function uploadStickerBlob(fileName, blob) {
  const safeName = fileName.replace(/[^a-zA-Z0-9_\-一-鿿.]/g, '_');
  let cloudErr = '';
  if (currentUser) {
    const { error } = await supabaseClient.storage.from(STICKER_BUCKET)
      .upload(currentUser.id + '/' + safeName, blob, { upsert: true, contentType: blob.type || 'image/png' });
    if (!error) return { ok: true, where: '云端', degraded: false };
    cloudErr = error.message;
    console.warn('[表情包] 云端上传失败，尝试本地服务器:', cloudErr);
  }
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const res = await fetch(SERVER_BASE + '/api/sticker-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName, data: b64 })
    });
    // 登录着却落到这条路 = 云端存不进去，这张图只在这台电脑上，手机看不到。
    // 说成一句轻飘飘的「已收藏到本地服务器」等于把同步失败藏起来了，必须点破。
    // degraded 是给调用方判 toast 颜色用的 —— 别让谁去解析 where 那句中文。
    if (res.ok) return currentUser
      ? { ok: true, where: '本地（云端没存上，其它设备看不到）', degraded: true }
      : { ok: true, where: '本地服务器', degraded: false };
  } catch(e) {}
  return { ok: false, error: cloudErr || '未登录账号，且本地服务器不可用' };
}

async function deleteCloudSticker(file) {
  if (!currentUser) return;
  if (!confirm('从云端删除这个表情？（所有设备都会消失）')) return;
  const { error } = await supabaseClient.storage.from(STICKER_BUCKET).remove([currentUser.id + '/' + file]);
  if (error) { showToast('删除失败: ' + error.message, 'error'); return; }
  showToast('已从云端删除', 'success');
  await loadStickers();
  if (_stickerTab !== 'search') renderLocalStickers();
}

/* ── 「这张不给 AI 用」（2026-10-12）────────────────────────────────
   键跟备注一样是表情名（s.name），同步走同一条云端设置；合并规则见 01-core.js 的 _mergeStickerAiOff。
   关掉的那张：系统提示的表情清单里没有它（05-prompts-api.js），AI 照着历史写了它的标签也不出图
   （stripAiOffStickers）。她自己发不受影响 —— 用户消息不经过这两处。 */
function stickerAiOff(name) {
  const m = state.stickerAiOff;
  if (!m || !Object.prototype.hasOwnProperty.call(m, name)) return false;
  const v = m[name];
  return !!(v && typeof v === 'object' ? v.off : v);
}
function setStickerAiOff(name, off) {
  state.stickerAiOff = (typeof _nullProto === 'function') ? _nullProto(state.stickerAiOff) : (state.stickerAiOff || {});
  const v = typeof _bumpGroupVer === 'function' ? _bumpGroupVer() : 0;
  // 打开也记一条（off:false）而不是删键：删掉的话另一台设备的旧「关」会在合并时原样回来
  state.stickerAiOff[name] = { off: !!off, v };
}
/* AI 写了一张被关掉的表情：标签直接抹掉，不出图。
   只在 AI 回复落盘那一刻做（processAiCommands + blocks 那条路 + 流式遮挡），**不在渲染层做** ——
   渲染层同时画历史，在那里拦的话，关掉之前 AI 发过的那些老消息会全变成裸标签。
   [表情包: 名字] 那种可读形态由调用方先过 normalizeStickerTags 掰成 [[STICKER:]] 再进来。 */
function stripAiOffStickers(text) {
  if (!text || text.indexOf('[[STICKER') < 0 || typeof findSticker !== 'function') return text;
  return text.replace(/\[\[STICKER:\s*([^\]]+?)\s*\]\]/g, (m, ref) => {
    const s = findSticker(ref);
    return s && stickerAiOff(s.name) ? '' : m;
  });
}
function _applyStickerOffToBlocks(blocks) {
  if (!blocks || !blocks.length) return;
  for (const b of blocks) {
    if (b.type === 'text' && b.text && (b.text.indexOf('[[STICKER') >= 0 || b.text.indexOf('表情') >= 0)) {
      b.text = stripAiOffStickers(normalizeStickerTags(b.text));
    }
  }
}
// 流式时也别让它闪一下再消失。先 normalize 跟渲染层看到的是同一份（stickerTagToHtml 开头也做这一步）
function maskStreamingStickerOff(text) {
  if (!text || (text.indexOf('[[STICKER') < 0 && text.indexOf('表情') < 0)) return text;
  return stripAiOffStickers(normalizeStickerTags(text));
}

// 给收藏的表情包备注一个 AI 看的名字/含义（例如"疑惑猫猫——我不太理解时发这个"）
// 「不给 AI 用」的开关也放在这个弹窗里（手机上 ✏️ 常驻，桌面悬停出来）
async function editStickerNote(name) {
  state.stickerNotes = state.stickerNotes || {};
  const cur = state.stickerNotes[name] || '';
  const wasOff = stickerAiOff(name);
  const check = { label: '不给 AI 用（AI 看不到、也发不出这张；你自己照样能发）', checked: wasOff };
  const note = await appPrompt(`给表情「${name}」备注一个 AI 看的名字/含义\n（留空则清除备注）`, cur, { check });
  if (note === null) return;
  const noteChanged = note.trim() !== cur;
  if (note.trim()) state.stickerNotes[name] = note.trim();
  else delete state.stickerNotes[name];
  if (check.checked !== wasOff) {
    setStickerAiOff(name, check.checked);
    showToast(check.checked ? '✓ 这张不给 AI 用了' : '✓ 这张重新给 AI 用了', 'success');
  } else if (noteChanged) {
    showToast(note.trim() ? '✓ 已备注，AI 之后会按这个理解这个表情' : '已清除备注', note.trim() ? 'success' : 'info');
  }
  save();
  renderLocalStickers();
}

const _isMobile = () => isMobileLayout();

/* ── 手机端 TIM 式输入栏 ────────────────────────────────────────────
   空框时 ⤢ 和 ➤ 没意义，先收起来：.has-content 挂在 .input-bar 上，
   剩下的排布/显隐全交给 CSS（见 media query）。麦克风常驻，打字时也不收。
   「有内容」不只看文字——带了图片/文件却没打字也得能发出去，所以三个都算。      */
function updateComposerBtns() {
  const bar = document.querySelector('.input-bar');
  const inp = document.getElementById('userInput');
  if (!bar || !inp) return;
  const has = !!(inp.value.trim()
    || (typeof _pendingImgs !== 'undefined' && _pendingImgs.length)
    || (typeof _pendingFiles !== 'undefined' && _pendingFiles.length));
  bar.classList.toggle('has-content', has);
  // 这里原来有句「一有内容就退出语音模式」，结果是打了字就根本进不去语音模式。
  // 用户要的是：文字打到一半也能去按语音，字还留着（语音转写完追加在后面）。
  const vb = document.getElementById('voiceBtn');
  if (vb) vb.classList.toggle('open', bar.classList.contains('voice-mode'));
}

// ＋ 一键两用：空框时开「添加内容」面板，一有内容就是发送键（TIM 式，见 .plus-btn 的 CSS）
function plusOrSend() {
  const bar = document.querySelector('.input-bar');
  if (bar?.classList.contains('has-content')) handleSend();
  else togglePlusMenu();
}

// 语音模式：输入框让位给「按住 说话」。已经打了的字不会丢——转写出来的文字追加在后面。
function toggleVoiceMode() {
  const bar = document.querySelector('.input-bar');
  if (!bar) return;
  const on = !bar.classList.contains('voice-mode');
  bar.classList.toggle('voice-mode', on);
  if (on) { closeStickerPanel(); closePlusMenu(); closeMathPanel(); document.getElementById('userInput')?.blur(); }
  else { setTimeout(() => document.getElementById('userInput')?.focus(), 30); }
  updateComposerBtns();
}

/* ── 语音输入（按住说话 → Groq Whisper 转写 → 文字追加进输入框）─────────
   录音在浏览器里做（MediaRecorder），音频原样 POST 给 server.js 的 /api/voice-stt，
   由它带着用户的 Groq Key 转发给 Whisper —— key 不进网页请求的 URL 之外的地方，
   和 Giphy/Tavily 是同一套「前端存 key、server 转发」的老规矩。
   手机端走电脑中转（SERVER_BASE），所以手机上也能用。                        */
// 转写服务的参数（服务商 / key / 自定义端点），两处调用（按住说话、语音通话）共用
function _sttQuery() {
  const p = state.voiceProvider || 'deepgram';
  let q = `key=${encodeURIComponent(state.voiceApiKey || '')}&provider=${encodeURIComponent(p)}`;
  if (p === 'custom') {
    q += `&base=${encodeURIComponent(state.voiceApiBase || '')}`
       + `&model=${encodeURIComponent(state.voiceModel || '')}`;
  }
  return q;
}
// 配好了没：key 必填；custom 还得有 base 和模型名
function _sttReady() {
  if (!state.voiceApiKey) return false;
  if ((state.voiceProvider || 'deepgram') === 'custom')
    return !!(state.voiceApiBase && state.voiceModel);
  return true;
}

let _rec = null, _recChunks = [], _recStream = null, _recStartAt = 0, _recCancelled = false, _recMaxTimer = null;
// 等麦克风权限那段（getUserMedia 还没回来）：_rec 还是 null，光靠它判断会漏掉两种情况——
// 轻点一下就松手（或松手去点权限弹窗）→ 流回来后照样开录，录满 60 秒自己转写发出去；
// 连按两下 → 第二路流把第一路顶掉，第一路麦克风再也没人关。
let _recStarting = false, _recReleased = false;
const VOICE_MAX_SEC = 60;   // 录音本体要跟着 chat 一起推到云端，别让手滑录出个巨无霸

function _voiceHoldBtn() { return document.getElementById('voiceHoldBtn'); }

async function startVoiceRecording() {
  if (_rec) return;
  // 上一次按下的权限请求还在路上又按住了：沿用那一路，算这次按住的
  if (_recStarting) { _recReleased = false; return; }
  if (!_sttReady()) {
    showToast('先去「设置 → 🎤 语音输入」选个转写服务并填 Key');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { showToast('这个环境拿不到麦克风 (´･ω･`)'); return; }
  _recStarting = true; _recReleased = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    _recStarting = false;
    showToast(e.name === 'NotAllowedError' ? '麦克风权限被拒了，去系统设置里放行' : '打不开麦克风：' + e.message);
    return;
  }
  _recStarting = false;
  // 流回来之前已经松手/取消了：这路麦克风当场关掉，不开录
  if (_recReleased || _rec) { stream.getTracks().forEach(t => t.stop()); _recReleased = false; return; }
  _recStream = stream;
  // webm/opus 是 Chrome/WebView 的默认；有的机型只给 mp4/ogg，让浏览器自己挑它支持的
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  _recChunks = [];
  _recCancelled = false;
  _rec = new MediaRecorder(_recStream, mime ? { mimeType: mime } : undefined);
  _rec.ondataavailable = e => { if (e.data?.size) _recChunks.push(e.data); };
  _rec.onstop = () => _finishVoiceRecording(mime || 'audio/webm');
  _rec.start();
  _recStartAt = Date.now();
  _recMaxTimer = setTimeout(() => {
    if (_rec) { showToast(`录满 ${VOICE_MAX_SEC} 秒，先发这一段`); stopVoiceRecording(false); }
  }, VOICE_MAX_SEC * 1000);
  const btn = _voiceHoldBtn();
  if (btn) { btn.classList.add('recording'); btn.textContent = '松手 发送 · 上滑取消'; }
  if (navigator.vibrate) navigator.vibrate(15);
}

function stopVoiceRecording(cancel) {
  if (!_rec) { if (_recStarting) _recReleased = true; return; }   // 还在等权限：记一笔，流回来就关
  clearTimeout(_recMaxTimer);
  _recCancelled = !!cancel;
  try { _rec.stop(); } catch {}
  _recStream?.getTracks().forEach(t => t.stop());
  _rec = null; _recStream = null;
  const btn = _voiceHoldBtn();
  if (btn) { btn.classList.remove('recording'); btn.textContent = '按住 说话'; }
}

async function _finishVoiceRecording(mime) {
  const durMs = Date.now() - _recStartAt;
  const chunks = _recChunks; _recChunks = [];
  if (_recCancelled) { showToast('取消了'); return; }
  if (durMs < 400 || !chunks.length) { showToast('太短了，没听清 (・ω・)'); return; }
  const blob = new Blob(chunks, { type: mime });
  const btn = _voiceHoldBtn();
  if (btn) { btn.classList.add('transcribing'); btn.textContent = '转写中…'; }
  try {
    const r = await fetch(`${SERVER_BASE}/api/voice-stt?${_sttQuery()}`
      + `&mime=${encodeURIComponent(mime)}&lang=zh`, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: blob,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '转写失败');
    const text = (j.text || '').trim();
    if (!text) { showToast('没听出内容 (´･ω･`)'); return; }
    // 发一条真的语音消息：录音本体存进节点（气泡里能播），content 就是转写文本（AI 直接读）。
    // 注意用 customText 这条路 —— 输入框里已经打了一半的字原样留着，不会被清掉。
    const audio = await _blobToDataUrl(blob);
    const emo = await analyzeVoiceEmotion(blob, text, durMs / 1000);   // 语气：让 AI 听得出你是累了还是在撒娇
    handleSend(text, { audio, dur: durMs / 1000, emo });
  } catch (e) {
    showToast('语音转写失败：' + e.message);
  } finally {
    if (btn) { btn.classList.remove('transcribing'); btn.textContent = '按住 说话'; }
  }
}

function _blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/* ── 语音情绪：hervoice 的思路，搬进浏览器 ─────────────────────────────
   hervoice（Python + librosa + Whisper）的做法是：抽基频 F0 均值/方差、RMS 能量、
   停顿比例、节奏、时长，再把「文字 + 这些数」丢给一个 LLM 判情绪。
   关键在于——判情绪的本来就是 LLM，而我们对话里坐着的就是 LLM。
   所以不必多养一个 Python 服务、也不必多花一次 API 调用：特征用 Web Audio 现算
   （自相关求基频），描述拼进消息标注，让 AI 自己去体会语气。
   绝对数值受麦克风和嗓音影响，所以还会和「你自己的历史基线」比——跟自己比才作数。 */
const VOICE_BASE_KEY = 'kuro_voiceBaseline';   // 只存本地：换个麦克风/换台设备，基线就该重新长

async function analyzeVoiceEmotion(blob, text, durSec) {
  try {
    // 16k 足够：语音基频最高也就 500Hz 左右，采样率越低自相关越省
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ sampleRate: 16000 });
    let buf;
    // 解码抛了也得关：AudioContext 是有数量上限的稀缺资源，漏几个之后连通话都开不了
    try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
    finally { ctx.close?.(); }
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    if (d.length < sr * 0.3) return null;                    // 太短，算不出东西

    const FRAME = 1024, HOP = 512;
    const rms = [];
    for (let i = 0; i + FRAME <= d.length; i += HOP) {
      let s = 0;
      for (let j = i; j < i + FRAME; j++) s += d[j] * d[j];
      rms.push(Math.sqrt(s / FRAME));
    }
    if (rms.length < 4) return null;

    // 停顿比例：静音阈值取「响亮帧（90 分位）的 18%」。
    // hervoice 原本用「20 分位 ×1.5」，但那条规则在能量均匀的声音上会翻车——
    // 20 分位本身就接近平均值，×1.5 后比谁都高，于是整段都被判成静音（实测 pause=1.0）。
    const sorted = [...rms].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const silTh = Math.max(p90 * 0.18, 0.008);
    const pause = rms.filter(v => v < silTh).length / rms.length;
    const energy = rms.reduce((a, b) => a + b, 0) / rms.length;

    // 基频只在「响的帧」上算，且最多取 40 帧——自相关不便宜，够用就行
    const voiceTh = Math.max(silTh, p90 * 0.3);
    const voiced = [];
    for (let k = 0; k < rms.length; k++) if (rms[k] > voiceTh) voiced.push(k);
    const step = Math.max(1, Math.floor(voiced.length / 40));
    const f0s = [];
    for (let k = 0; k < voiced.length; k += step) {
      const f = _f0Autocorr(d.subarray(voiced[k] * HOP, voiced[k] * HOP + FRAME), sr);
      if (f) f0s.push(f);
    }
    const f0 = f0s.length ? f0s.reduce((a, b) => a + b, 0) / f0s.length : 0;
    const f0sd = f0s.length > 1
      ? Math.sqrt(f0s.reduce((a, b) => a + (b - f0) ** 2, 0) / f0s.length) : 0;

    // 语速：中文按字算，正常 3.5~5.5 字/秒
    const chars = (text || '').replace(/\s/g, '').length;
    const rate = durSec > 0.5 ? chars / durSec : 0;

    const feat = {
      f0: Math.round(f0), f0sd: Math.round(f0sd),
      rms: +energy.toFixed(4), pause: +pause.toFixed(2), rate: +rate.toFixed(1),
      dur: +durSec.toFixed(1),
    };
    feat.hint = _voiceHint(feat, _voiceBaseline());
    _voiceBaselineUpdate(feat);
    return feat;
  } catch (e) {
    console.warn('[语音情绪] 算不出来，跳过：', e.message);   // 情绪是锦上添花，失败不该拦住发消息
    return null;
  }
}

// 自相关求基频：找 60~500Hz 对应的滞后里相关性最高的那个；相关性太低说明是清音/噪音。
// 两个坑都踩过：
//   ① 归一化必须只用「重叠那一段」的能量。拿整帧能量去除，滞后越大分子项越少、
//      分数越小，于是系统性地偏向短滞后（= 偏高的频率），120Hz 会被测成 231Hz。
//   ② 倍频错误：谐波强的时候，半个周期处的相关性也很高。所以选中一个滞后后，
//      再看看它的 2 倍、3 倍处是不是同样强——是的话，那个更长的才是真基周期。
function _f0Autocorr(frame, sr) {
  const N = frame.length;
  const minLag = Math.floor(sr / 500), maxLag = Math.min(Math.floor(sr / 60), N - 1);
  if (maxLag <= minLag) return 0;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += frame[i];
  mean /= N;
  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, e0 = 0, e1 = 0;
    for (let i = 0; i + lag < N; i++) {
      const a = frame[i] - mean, b = frame[i + lag] - mean;
      s += a * b; e0 += a * a; e1 += b * b;
    }
    corr[lag] = s / Math.sqrt(e0 * e1 + 1e-9);
  }
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (corr[lag] > best) best = corr[lag];
  if (best < 0.3) return 0;                        // 没有明显周期 = 清音/噪音

  // 取「从短到长第一个接近最强的峰」= 基周期。
  // 不能直接取全局最大：周期信号在 2T、3T 处的相关性天然也接近 1，
  // 谁最大全看噪声，一不留神就把周期拉长一倍、频率算成一半（实测 300Hz 被测成 203Hz）。
  // 而谐波造成的假峰（T/2 附近）通常是负相关，扫不到它头上。
  let bestLag = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= best * 0.9 && corr[lag] > corr[lag - 1] && corr[lag] >= corr[lag + 1]) { bestLag = lag; break; }
  }
  if (!bestLag) return 0;
  // 抛物线插值：滞后是整数采样，300Hz 在 16k 下只有 53 个点，±1 个点就是 ±5Hz
  const y0 = corr[bestLag - 1], y1 = corr[bestLag], y2 = corr[bestLag + 1];
  const denom = 2 * (2 * y1 - y0 - y2);
  const shift = denom ? (y2 - y0) / denom : 0;
  return sr / (bestLag + Math.max(-1, Math.min(1, shift)));
}

// 基线：你自己最近的平均嗓音（指数滑动平均）。攒够 3 条才敢拿来做「比平时…」的判断。
function _voiceBaseline() {
  try { return JSON.parse(localStorage.getItem(VOICE_BASE_KEY) || 'null'); } catch { return null; }
}
function _voiceBaselineUpdate(f) {
  const b = _voiceBaseline() || { n: 0, f0: 0, rms: 0, rate: 0 };
  const a = b.n < 3 ? 0.5 : 0.2;                     // 前几条学得快一点，之后稳住
  const mix = (o, v) => (b.n ? o * (1 - a) + v * a : v);
  const next = {
    n: Math.min(b.n + 1, 99),
    f0: +mix(b.f0, f.f0 || b.f0).toFixed(1),
    rms: +mix(b.rms, f.rms).toFixed(4),
    rate: +mix(b.rate, f.rate || b.rate).toFixed(2),
  };
  try { localStorage.setItem(VOICE_BASE_KEY, JSON.stringify(next)); } catch {}
}

// 把几个数翻译成人话。有基线就说「比平时…」，没有就用绝对档位。
// 只给"可能"，不下断言——真正判情绪的是对话里的 AI，它还看得到说了什么。
function _voiceHint(f, b) {
  const parts = [];
  const useBase = b && b.n >= 3 && b.f0 > 0;
  const cmp = (v, base, hi, lo, hiTxt, loTxt) => {
    if (!v) return null;
    if (useBase && base > 0) {
      if (v > base * 1.15) return hiTxt;
      if (v < base * 0.85) return loTxt;
      return null;
    }
    if (v > hi) return hiTxt;
    if (v < lo) return loTxt;
    return null;
  };
  const pitch  = cmp(f.f0, b?.f0, 240, 140, '音高偏高', '音高偏低');
  const loud   = cmp(f.rms, b?.rms, 0.08, 0.025, '声音偏响', '声音偏轻');
  const speed  = cmp(f.rate, b?.rate, 5.5, 3.0, '语速偏快', '语速偏慢');
  if (pitch) parts.push(pitch);
  if (f.f0sd > 35) parts.push('起伏大');            // 正常说话的基频标准差大概 20~50Hz
  else if (f.f0sd && f.f0sd < 12) parts.push('语调平');
  if (loud) parts.push(loud);
  if (speed) parts.push(speed);
  if (f.pause > 0.45) parts.push('停顿多');
  else if (f.pause < 0.15) parts.push('几乎没停顿');

  // 猜一手（hervoice 给 LLM 的那几条启发式，规则化）
  let guess = '';
  const high = pitch === '音高偏高', low = pitch === '音高偏低';
  const soft = loud === '声音偏轻', loudy = loud === '声音偏响';
  const slow = speed === '语速偏慢', fast = speed === '语速偏快';
  if ((low || soft) && (f.pause > 0.45 || slow)) guess = '可能有点累/情绪低';
  else if (high && f.f0sd > 35 && (loudy || fast)) guess = '可能挺兴奋/开心';
  else if (loudy && fast && f.f0sd > 35) guess = '可能有点激动或急';
  else if (high && f.dur < 3) guess = '短促上扬，可能在撒娇/开玩笑';
  else if (soft && slow && !high) guess = '可能在轻声说、或者不太有劲';
  if (!parts.length) return '';                       // 平平无奇就别硬凑，省 token
  return parts.join('、') + (guess ? ' —— ' + guess : '');
}

/* ── 语音消息气泡 ──────────────────────────────────────────────
   发出去的是真录音：气泡里能播；转写文字默认收起，点「转文字」才展开。
   （AI 那边不受影响 —— 它读的是 m.content，本来就是转写文本。）        */
// 语音条展开的那段文字：AI 发的语音里可能带 [[GIF:]] / [[STICKER:]] 等标签
// （它就是把正文念了一遍，正文里有什么标签这里就有什么）。以前这里是 escHtml，
// 标签被原样打成一长串裸文本 —— 就是用户截图里那条 [[GIF:https://…giphy.gif|cat blush cute shy]]。
// 走和普通气泡同一条渲染路（renderRichText → stickerTagToHtml），表情才会真的显示出来。
// 用户自己的语音是转写文本，不该有标签，继续按纯文本转义，别给它开 HTML 口子。
// ⚠️ 两条路的 white-space 也必须分开（.voice-text.rich，见 css）：AI 这条出的是
// marked 的 HTML，段落之间那个 \n 在 pre-wrap 下会变成真实空行，每段之间白多 19px。
function voiceTextHtml(m) {
  const raw = m.content || '（没听出内容）';
  if (m.role !== 'ai') return escHtml(raw);
  try { return renderRichText(raw); } catch (e) { return escHtml(raw); }
}

// pi（part index）给拆开的多段语音用：那时候一条消息上挂着好几个语音条，
// 时长、正文、DOM id 都得各算各的，不能再共用 m.audioDur / voiceText-<id> 这一份。
function renderVoiceBubble(m, pi) {
  const part = (typeof pi === 'number') ? m.voiceParts?.[pi] : null;
  const dur = Math.max(1, Math.round((part ? part.dur : m.audioDur) || 1));
  const bars = Math.min(22, Math.max(6, Math.round(dur * 1.6)));   // 时长越长，波形越长
  const label = m.role === 'ai' ? '看文字' : '转文字';   // AI 发的是自己的话，不是"转"出来的
  const sfx = part ? `-${pi}` : '';
  // 未接来电横幅、听感提示是整条消息级的，只跟着第一个语音条走，拆开后不许每条都印一遍
  const isTail = !!part && pi !== _firstVoicePart(m);
  return `
    ${(!isTail && m.missedCall) ? `<div class="voice-missed">📞 未接来电 · ${escHtml(m.dialReason || '想跟你说说话')}</div>` : ''}
    <div class="voice-msg" onclick="playVoiceMsg(${m.id}, this, ${part ? pi : -1})" title="点一下播放">
      <span class="voice-play-ico">▶</span>
      <span class="voice-wave">${'<i></i>'.repeat(bars)}</span>
      <span class="voice-dur">${dur}″</span>
    </div>
    <div class="voice-text-toggle" data-label="${label}" onclick="toggleVoiceText('${m.id}${sfx}', this)">${label}</div>
    <div class="voice-text${m.role === 'ai' ? ' rich' : ''}" id="voiceText-${m.id}${sfx}" style="display:none">${
      part ? voicePartTextHtml(part) : voiceTextHtml(m)}${
      (!isTail && m.voiceEmo?.hint) ? `<div class="voice-emo">🎧 ${escHtml(m.voiceEmo.hint)}</div>` : ''}</div>`;
}

// ── 语音拆段：表情包不埋在展开正文里，单独站在语音条下面 ─────────────
// 用户的口径：「语音（文字）/ 表情包（单独在语音条下面而不是展开下面）/ 语音（文字），
// 如果中间有卡片间隔，就让语音拆成好几个」。
// 拆是在**合成那一刻**拆的，不是渲染层拆：每段文字各跑一次 Edge-TTS，
// 于是第二个语音条点下去念的就是第二段，而不是从头把整条重放一遍。
// 存储上仍然是一个节点（content / blocks / 发给模型的上下文都没动），只是多了 n.voiceParts。
const _VOICE_SPLIT_RE = /\[\[(?:STICKER|GIF|GIF_SEARCH):[^\]]*\]\]/g;

function _splitVoiceSegs(raw) {
  const segs = [];
  let last = 0;
  _VOICE_SPLIT_RE.lastIndex = 0;
  for (let m; (m = _VOICE_SPLIT_RE.exec(raw)); ) {
    const before = raw.slice(last, m.index);
    if (before.trim()) segs.push({ type: 'text', text: before });
    segs.push({ type: 'sticker', tag: m[0] });
    last = m.index + m[0].length;
  }
  if (!segs.length) return null;                       // 没有表情，照旧整条一段
  const tail = raw.slice(last);
  if (tail.trim()) segs.push({ type: 'text', text: tail });
  // 只有一段文字（表情全在开头或结尾）也值得拆 —— 那正是「表情单独在语音条下面」那一条。
  // 但一段文字都没有的纯表情消息本来就不该变成语音，交回老路。
  return segs.some(s => s.type === 'text') ? segs : null;
}

// 第一个文字段的下标。思考链、未接来电横幅这些「整条消息级」的东西挂在它上面，
// 消息以表情开头时不至于挂进一个没有背景的表情气泡里。
function _firstVoicePart(m) {
  return (m.voiceParts || []).findIndex(p => p.type === 'text');
}

function voicePartTextHtml(part) {
  try { return renderRichText(part.raw || part.text || ''); }
  catch (e) { return escHtml(part.raw || part.text || ''); }
}

// 渲染层要的形状，和 _splitStickerBubbles 一致：{type, html}[]，一段一个气泡。
// 返回 null = 这条语音不拆，走原来的单气泡。
// 表情解析不出来时顶上的中性占位，和 12-math-media.js 里处理旧占位 div 的样子保持一致。
const _VOICE_STICKER_FALLBACK = '<span style="color:var(--text-muted);font-size:12px;">[表情包]</span>';

function renderVoiceSegs(m) {
  const parts = m.voiceParts;
  if (!Array.isArray(parts) || parts.length < 2) return null;
  const segs = [];
  // 这里必须是 for 不是 forEach：下面「解析不出图就整条不拆」要真的从函数返回，
  // 而 forEach 回调里的 return 只跳过当前这一项，函数照样往下走。（2026-09-04 实栽，
  // 补的那条断言当场逮到。）
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === 'sticker') {
      const html = stickerTagToHtml(p.tag || '');
      // 收藏里找不到这个名字时 stickerTagToHtml 原样吐回 [[STICKER:xxx]]（12-math-media.js 那个
      // return match）。直接让它成气泡的话，透明无内边距的表情气泡里会浮着一行裸标签文字。
      //
      // 判据要认**真的渲染出元素**，不能图省事：
      //  · 「结果里还有没有 [[STICKER:]]」会误伤正常情况 —— 真出图时标签原文常被写进 alt/title。
      //  · 「有没有尖括号」挡不住 [[STICKER:<3]] 这种名字，它原样吐回来也带着 <。
      // 出图是 <img>，GIF_SEARCH 还没搜到时是占位 <span>（正常，会被后续渲染替换）。
      if (/<(?:img|span|div)\b/i.test(html)) segs.push({ type: 'sticker', html });
      // 没解析出来就给个中性占位，**不能整条退回单气泡** —— 这时候 voiceParts 已经合成好了，
      // 而 m.audio 只存着第一段，退回去用户就只听得到前半句。
      else if (html.trim()) segs.push({ type: 'sticker', html: _VOICE_STICKER_FALLBACK });
    } else {
      segs.push({ type: 'text', html: renderVoiceBubble(m, i) });
    }
  }
  return segs.length > 1 ? segs : null;
}

/* ── AI 自己发语音条 ───────────────────────────────────────────
   AI 在回复开头写 [[VOICE]] → processAiCommands 剥掉标记、置位 _aiVoiceWanted，
   这里把正文送去 Edge-TTS 合成，audio 挂回节点，气泡就变成语音条（文字默认收起）。
   通话中不合成：那边本来就会把回复念出来，再挂一条语音是重复的。          */
let _aiVoiceWanted = false;
async function _maybeAiVoice(chat, nodeId) {
  const n = chat?.nodes?.[nodeId];
  if (!n || n.audio) return;
  if (typeof _call !== 'undefined' && _call.on) return;
  const text = getTtsCleanText(n).slice(0, 800);
  if (!text) return;
  try {
    // 正文里夹着表情包 → 拆成好几段，一段文字一条语音条，表情单独站在中间。
    // 拆失败（某一段合成炸了/一段文字都不剩）就整条按老路合成一遍，不留半截状态。
    const parts = await _synthVoiceParts(n);
    if (parts) {
      n.voiceParts = parts;
      const first = parts[_firstVoicePart({ voiceParts: parts })];
      n.audio = first.audio;            // 别处一律用 m.audio 认「这是语音消息」，必须挂上
      n.audioDur = first.dur;
    } else {
      const blob = await _ttsBlob(text);
      n.audio = await _blobToDataUrl(blob);
      n.audioDur = await _audioDuration(blob);
    }
    save();
    _invalidateNodeCache(nodeId);
    renderMessages();
  } catch (e) {
    console.warn('[AI 语音] 合成失败，退回文字：', e.message);   // 合成不了就当普通文字消息，不打扰用户
  }
}

// 一次 TTS 请求，返回 mp3 blob
async function _ttsBlob(text) {
  const voice = state.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  const url = SERVER_BASE + '/api/tts?text=' + encodeURIComponent(text)
    + '&voice=' + encodeURIComponent(voice)
    + '&rate=' + encodeURIComponent(_ttsRateStr())
    + _ttsStyleParam(text, voice);       // 本地情绪声音：一段一段各挑各的语气
  const r = await fetch(url);
  if (!r.ok) throw new Error('TTS ' + r.status);
  const blob = await r.blob();
  if (!blob.size) throw new Error('空音频');
  return blob;
}

// 按表情切段并逐段合成。返回 voiceParts 或 null（= 不该拆／拆不成，交回整条合成那条路）。
// 800 字是整条的预算，不是每段的 —— 按段各切 800 会让带表情的消息偷偷变成三倍长。
async function _synthVoiceParts(n) {
  const segs = _splitVoiceSegs(getMsgPlainText(n));
  if (!segs) return null;
  let budget = 800;
  const parts = [];
  for (const s of segs) {
    if (s.type === 'sticker') { parts.push({ type: 'sticker', tag: s.tag }); continue; }
    const clean = cleanTtsText(s.text);
    if (!clean) continue;                        // 这一段清完什么都不剩（纯标记），丢掉不发声
    // 预算不够念完这一段 → 整条不拆，回老路。
    // 以前这里是 slice(0, budget) 然后 budget<=0 就 break，两个都是坑：
    // slice 会把话截成半句（还可能切在 UTF-16 代理对中间），break 更糟 ——
    // 剩下的表情和正文全留在 segs 里没进 parts，而渲染层完全以 voiceParts 为准，
    // 它们会从界面上凭空消失。老路至少把全文留在展开正文里。
    if (clean.length > budget) return null;
    budget -= clean.length;
    let blob;
    // 某一段合成炸了（TTS 500 / 网断）就整条放弃拆分，让调用方走老路合成一遍。
    // 不能让异常冒出去 —— 外层 catch 只会打日志，那条消息就彻底没有语音了。
    try {
      blob = await _ttsBlob(clean);
      parts.push({
        type: 'text', raw: s.text.trim(), text: clean,
        audio: await _blobToDataUrl(blob), dur: await _audioDuration(blob),
      });
    } catch (e) {
      console.warn('[AI 语音] 分段合成失败，整条回退老路：', e.message);
      return null;
    }
  }
  // 拆完只剩一个气泡（比如表情在末尾又被丢掉了）就没必要拆，回老路省一次重复合成的风险
  return parts.filter(p => p.type === 'text').length && parts.length > 1 ? parts : null;
}
// 拿音频时长（合成出来的 mp3 没有现成的秒数，得让浏览器解一下头）
function _audioDuration(blob) {
  return new Promise(res => {
    const u = URL.createObjectURL(blob);
    const a = new Audio(u);
    const done = d => { URL.revokeObjectURL(u); res(d); };
    a.onloadedmetadata = () => done(isFinite(a.duration) && a.duration > 0 ? a.duration : 2);
    a.onerror = () => done(2);
    setTimeout(() => done(2), 3000);
  });
}

// 录音在节点里存的是 data URL（要落盘、要跟着对话整包上云），但 Chrome 不让 <audio> 直接吃 data URL
// （MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check）——播放前先还原成 Blob，走 blob: URL。
function _dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/^data:([^;]+)/) || [, 'audio/webm'])[1];
  const bin = atob(b64 || '');
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

let _voiceAudio = null;
let _voiceObjUrl = null;
// pi ≥ 0：拆开的第 pi 段，播它自己那截音频（每段是单独合成的，不是从整条里切出来的）
function playVoiceMsg(id, el, pi) {
  const chat = getActiveChat();
  const m = chat?.nodes?.[id];
  const src = (pi >= 0 && m?.voiceParts?.[pi]?.audio) || m?.audio;
  if (!src) return;
  if (_voiceAudio) { _voiceAudio.pause(); _voiceAudio = null; }
  if (_voiceObjUrl) { URL.revokeObjectURL(_voiceObjUrl); _voiceObjUrl = null; }
  document.querySelectorAll('.voice-msg.playing').forEach(e => e.classList.remove('playing'));
  let url;
  try {
    url = src.startsWith('data:') ? URL.createObjectURL(_dataUrlToBlob(src)) : src;
  } catch (e) { showToast('这条语音坏了 (´･ω･`)'); return; }
  const a = new Audio(url);
  _voiceAudio = a; _voiceObjUrl = url;
  el.classList.add('playing');
  // 收尾只管自己这一条：切到 B 时 A 被 pause，A 的 play() 晚一步 AbortError 进来，
  // 要是去清全局，清掉的就是正在播的 B（B 的 url 被 revoke，直接哑掉）
  const done = () => {
    if (url !== src) URL.revokeObjectURL(url);   // 只收自己 createObjectURL 出来的
    if (_voiceAudio !== a) return;
    el.classList.remove('playing');
    _voiceAudio = null; _voiceObjUrl = null;
  };
  a.onended = done;
  a.onerror = () => { const mine = _voiceAudio === a; done(); if (mine) showToast('这条语音播不了 (´･ω･`)'); };
  a.play().catch(() => done());
}

function toggleVoiceText(id, el) {
  const box = document.getElementById('voiceText-' + id);
  if (!box) return;
  const show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  el.textContent = show ? '收起文字' : (el.dataset.label || '转文字');
}

// 「按住说话」的按压手势：按下开录、松手转写、往上滑一截取消（和微信/TIM 一个手感）
(function initVoiceHold() {
  const bind = () => {
    const btn = _voiceHoldBtn();
    if (!btn || btn._vBound) return;
    btn._vBound = true;
    let startY = 0;
    const down = e => { startY = (e.touches?.[0] || e).clientY; startVoiceRecording(); };
    const move = e => {
      if (!_rec) return;
      const y = (e.touches?.[0] || e).clientY;
      const cancelling = startY - y > 70;      // 上滑超过 70px = 要取消
      btn.textContent = cancelling ? '松手 取消 ✕' : '松手 发送 · 上滑取消';
      btn.dataset.cancel = cancelling ? '1' : '';
    };
    const up = () => { if (_rec || _recStarting) stopVoiceRecording(btn.dataset.cancel === '1'); btn.dataset.cancel = ''; };
    btn.addEventListener('touchstart', e => { e.preventDefault(); down(e); }, { passive: false });
    btn.addEventListener('touchmove', move, { passive: true });
    btn.addEventListener('touchend', up);
    btn.addEventListener('touchcancel', () => stopVoiceRecording(true));
    btn.addEventListener('mousedown', down);          // 电脑端也能按住说话
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

document.addEventListener('DOMContentLoaded', () => { try { updateComposerBtns(); } catch {} });

/* ── 手机端：面板 = 键盘（TIM 式）────────────────────────────────────
   表情面板 / 加号面板都长在屏幕最底下那块「键盘位」上，输入栏被顶到面板正上方，
   面板开着的时候输入框和发送键还在手边（不是一张盖住半个屏幕的浮层）。
   抬输入栏只能用 margin-bottom，不能用 transform —— 面板是 input-bar-wrap 的
   fixed 子元素，祖先一旦 transform 就变成它的包含块，bottom:0 会跟着输入栏一起跑。*/
function _plusInputWrap() { return document.querySelector('.input-bar-wrap'); }

/* 手机端打开面板前，先把它从 .input-bar 里挪到 body 上 —— 这不是洁癖，是必须的：
   .input-bar 有 backdrop-filter:blur(24px)，带滤镜的祖先会成为 fixed 后代的「包含块」，
   于是面板的 bottom:0 不再是「屏幕底边」而是「输入栏的底边」，面板整个往上长到屏幕中间去
   （用户在手机上看到的就是这个）。电脑端面板是 absolute、要贴着按钮弹，所以只在手机端搬，
   关掉再原位放回去。*/
function _portalOut(el) {
  if (!el || !_isMobile() || el.parentNode === document.body) return;
  el._gcHome = el.parentNode;
  el._gcNext = el.nextSibling;
  document.body.appendChild(el);
}
function _portalHome(el) {
  if (!el || !el._gcHome || el.parentNode !== document.body) return;
  el._gcHome.insertBefore(el, el._gcNext);
  el._gcHome = null; el._gcNext = null;
}

function _liftInput(panelEl) {
  if (!_isMobile() || !panelEl) return;
  requestAnimationFrame(() => {
    const wrap = _plusInputWrap();
    if (!wrap) return;
    // 刚关的面板留了个 240ms 后清 z-index 的尾巴（切面板 = 先关再开，中间只隔 50ms）；
    // 不掐掉它，输入栏就被清回遮罩底下，第一下点发送只是关了面板
    clearTimeout(wrap._dropT); wrap._dropT = 0;
    // 抬多高 ≠ 面板多高：输入栏本来就没贴着屏幕底边（底下还有一截 padding/空隙），
    // 直接抬一个面板的高度就会多顶出那一截，输入栏和面板之间空一条缝。
    // 所以先把已有抬升清掉、不带动画量一次「天然离屏幕底还有多远」，再减掉它。
    const h = panelEl.offsetHeight;
    wrap.style.transition = 'none';
    wrap.style.marginBottom = '';
    void wrap.offsetHeight;
    const gapBelow = Math.round(window.innerHeight - wrap.getBoundingClientRect().bottom);
    void wrap.offsetHeight;
    wrap.style.transition = 'margin-bottom .22s cubic-bezier(0.22,1,0.36,1)';
    wrap.classList.add('panel-open');   // 收掉输入栏底部内边距，和面板贴严
    wrap._gcLift = Math.max(0, h - gapBelow);
    wrap.style.marginBottom = wrap._gcLift + 'px';
    wrap.style.zIndex = '502';   // 面板 501、遮罩 500 —— 输入栏永远浮在最上面
  });
}
function _dropInput() {
  const wrap = _plusInputWrap();
  if (!wrap) return;
  wrap.classList.remove('panel-open');
  if (!wrap.style.marginBottom) return;
  wrap.style.marginBottom = '';
  clearTimeout(wrap._dropT);
  wrap._dropT = setTimeout(() => { wrap._dropT = 0; wrap.style.zIndex = ''; wrap.style.transition = ''; }, 240);
}

/* 手机⇄电脑断点一跨，键盘位上的面板全部当场收干净。
   手机态开着表情面板直接把窗口拉宽：面板已搬到 body、输入栏被 margin-bottom 抬着、遮罩还亮，
   而电脑端 .closing 没有动画、animationend 永远不来 —— 输入栏就悬在屏幕中间、底下一片暗（用户截图）。
   反方向（电脑端开着再拉窄）面板留在带滤镜的 .input-bar 里，fixed 也会长歪。两头都不救场，直接收。*/
function _resetKeyboardPanels() {
  const sp = document.getElementById('stickerPanel');
  if (sp) {
    sp.classList.remove('open', 'closing');
    sp.style.transform = ''; sp.style.transition = '';
    _portalHome(sp);
  }
  document.getElementById('stickerOverlay')?.classList.remove('open');
  closePlusMenu(); closeMathPanel(); closeFancyPanel();
  const wrap = _plusInputWrap();
  if (wrap) {
    clearTimeout(wrap._dropT); wrap._dropT = 0;
    wrap.classList.remove('panel-open');
    wrap.style.marginBottom = ''; wrap.style.zIndex = ''; wrap.style.transition = '';
  }
  _syncEmojiBtn();
  if (typeof updateComposerBtns === 'function') updateComposerBtns();
}
if (window.matchMedia) {
  window.matchMedia('(max-width: 768px), (max-height: 500px) and (orientation: landscape)')
    .addEventListener('change', _resetKeyboardPanels);
}

/* ── Plus Menu ── */
function togglePlusMenu() {
  const menu = document.getElementById('plusMenu');
  const btn = document.querySelector('.plus-btn');
  const overlay = document.getElementById('plusOverlay');
  const isOpen = menu.classList.contains('open');
  if (isOpen) { closePlusMenu(); return; }
  closeStickerPanel(); closeMathPanel();            // 几个面板抢同一块地方，不能一起开
  _portalOut(menu);                                 // 手机端：先搬出 .input-bar（滤镜坑，见上面）
  menu.classList.add('open');
  btn.classList.add('open');
  if (_isMobile()) {
    overlay.classList.add('open');
    document.getElementById('userInput')?.blur();   // 收键盘，面板顶上来
    _liftInput(menu);
  }
}
function closePlusMenu() {
  const menu = document.getElementById('plusMenu');
  const btn = document.querySelector('.plus-btn');
  const overlay = document.getElementById('plusOverlay');
  if (!menu?.classList.contains('open')) return;
  menu.classList.remove('open');
  btn.classList.remove('open');
  overlay.classList.remove('open');
  _portalHome(menu);
  _dropInput();
}
function plusMenuAction(type) {
  closePlusMenu();
  switch(type) {
    case 'image': document.getElementById('imgFileInput').click(); break;
    case 'file': document.getElementById('textFileInput').click(); break;
    case 'camera': setTimeout(() => openCamera(), 50); break;
    case 'call': setTimeout(() => openCall(), 50); break;
    case 'sticker': setTimeout(() => toggleStickerPanel(), 50); break;
    case 'math': setTimeout(() => toggleMathPanel(), 50); break;
    case 'fancy': setTimeout(() => toggleFancyPanel(), 50); break;
  }
}
document.addEventListener('click', e => {
  const menu = document.getElementById('plusMenu');
  if (!menu?.classList.contains('open')) return;
  // 手机端面板被搬到 body 上了，光判断 .plus-menu-wrap 会把「点面板自己」也当成点外面
  if (!e.target.closest('.plus-menu-wrap') && !e.target.closest('#plusMenu')) closePlusMenu();
});
// 手机端：抓住顶部把手往下拉即可收起加号菜单（表情包面板同款手势），输入栏跟着面板走
(function initPlusMenuDrag() {
  let startY = null, curY = 0, menuEl = null, panelH = 0;
  function onStart(e) {
    menuEl = document.getElementById('plusMenu');
    if (!menuEl) return;
    startY = e.touches[0].clientY; curY = 0;
    panelH = (_plusInputWrap()?._gcLift) ?? menuEl.offsetHeight;   // 抬升量按 _liftInput 算过的来
    menuEl.style.transition = 'none';
    const wrap = _plusInputWrap(); if (wrap) wrap.style.transition = 'none';
  }
  function onMove(e) {
    if (startY == null) return;
    curY = Math.max(0, e.touches[0].clientY - startY);
    menuEl.style.transform = 'translateY(' + curY + 'px)';
    const wrap = _plusInputWrap();
    if (wrap && wrap.style.marginBottom) wrap.style.marginBottom = Math.max(0, panelH - curY) + 'px';
    e.preventDefault();
  }
  function onEnd() {
    if (startY == null) return;
    menuEl.style.transition = 'transform .2s ease';
    const wrap = _plusInputWrap();
    if (wrap) wrap.style.transition = 'margin-bottom .2s ease';
    if (curY > 60) closePlusMenu();
    else if (wrap && wrap.style.marginBottom) wrap.style.marginBottom = panelH + 'px';
    menuEl.style.transform = '';
    startY = null; curY = 0;
  }
  function bind() {
    const zones = [document.getElementById('plusMenuHandle'), document.querySelector('#plusMenu .plus-menu-title')];
    zones.forEach(z => {
      if (!z) return;
      z.addEventListener('touchstart', onStart, { passive: true });
      z.addEventListener('touchmove', onMove, { passive: false });
      z.addEventListener('touchend', onEnd);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// 表情按钮跟着面板走：面板开着就显示键盘图标（再点一下收面板、回键盘），和 TIM 一致
function _syncEmojiBtn() {
  const panel = document.getElementById('stickerPanel');
  const btn = document.getElementById('emojiBtn');
  if (btn) btn.classList.toggle('open', !!panel?.classList.contains('open'));
}

function toggleStickerPanel() {
  const panel = document.getElementById('stickerPanel');
  const isOpen = panel.classList.contains('open');
  if (isOpen) { closeStickerPanel(); document.getElementById('userInput')?.focus(); return; }
  closePlusMenu(); closeMathPanel();                  // 几个面板抢同一块地方
  _portalOut(panel);                                 // 手机端：搬出 .input-bar（滤镜坑）
  document.querySelector('.input-bar')?.classList.remove('voice-mode');
  renderStickerTabs();
  renderStickerView();
  panel.classList.remove('closing');
  panel.classList.add('open');
  _syncEmojiBtn();
  updateComposerBtns();
  if (_isMobile()) {
    document.getElementById('stickerOverlay').classList.add('open');
    document.getElementById('userInput')?.blur();    // 收键盘，面板占它的位置
    _liftInput(panel);
    _initStickerDrag(panel);
  } else if (_stickerTab === 'search') {
    setTimeout(() => document.getElementById('stickerSearchInput')?.focus(), 100);
  }
}

function closeStickerPanel() {
  const panel = document.getElementById('stickerPanel');
  if (!panel?.classList.contains('open')) return;
  const overlay = document.getElementById('stickerOverlay');
  if (_isMobile()) {
    panel.classList.add('closing');
    overlay.classList.remove('open');
    _dropInput();
    panel.addEventListener('animationend', function handler() {
      panel.classList.remove('open', 'closing');
      panel.style.transform = '';
      panel.removeEventListener('animationend', handler);
      _portalHome(panel);
      _syncEmojiBtn();
    }, { once: true });
  } else {
    panel.classList.remove('open');
    overlay.classList.remove('open');
  }
  _syncEmojiBtn();
}

// 手机端点回输入框 = 要打字 → 面板让位给键盘（TIM 就是这个手感）
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('userInput')?.addEventListener('focus', () => {
    if (!_isMobile()) return;
    closeStickerPanel();
    closePlusMenu();
    closeMathPanel();
  });
});

/* ── 拍照：手机、电脑同一套 ─────────────────────────────────────────
   走 getUserMedia 拿摄像头（App 里是 https://grancyan.app，算安全源；WebView 侧
   在 MainActivity.onPermissionRequest 里放行 CAMERA）。抓到的帧转成 dataURL，
   直接塞进 _pendingImgs —— 后面发消息的链路和「选图片」完全一样，不用另开一路。*/
let _camStream = null, _camFacing = 'environment', _camShotData = null;

