async function callGroupChat(confs, path, chat, parentMsgId) {
  const freqProb = { high: 0.9, medium: 0.6, low: 0.3 };
  const members = (chat.groupMembers?.length ? chat.groupMembers : confs.map(c => ({ configId: c.id, nickname: c.nickname, frequency: 'medium' })))
    .filter(m => confs.some(c => c.id === m.configId));
  const rounds = chat.groupRounds || 1;
  let currentParent = parentMsgId;

  for (let r = 0; r < rounds; r++) {
    for (const mem of members) {
      if (r > 0 && Math.random() > (freqProb[mem.frequency] || 0.6)) continue;
      const conf = confs.find(c => c.id === mem.configId);
      if (!conf) continue;
      const currentPath = getMessagePath(chat, currentParent);
      const aiId = nextId();
      chat.nodes[aiId] = { id: aiId, parentId: currentParent, role: 'ai', content: '', reasoning: '',
        modelId: conf.id, modelNickname: conf.nickname, tokens: 0, timestamp: Date.now(), streaming: true };
      chat.headId = aiId;
      save(); renderMessages();

      // 本地 Claude / GPT 走电脑上的 CLI，不需要 API Key；Gemini 的 key 在 server 那边
      // （.env 的 GEMINI_API_KEY），前端这条 config 的 apiKey 天生就是空的。
      // 旧判断把它们在群聊里误判成未配置模型，永远只发“演示回复”。
      // 只有真正要前端带 key 的云端模型才检查。
      if (!conf.apiKey && !conf.isLocalClaude && !conf.isLocalGpt && !conf.isGemini) {
        await new Promise(res => setTimeout(res, 400));
        const reply = `[${conf.nickname}] 演示回复（接入 API Key 后获得真实内容 (•̀ᴗ•́)و）`;
        chat.nodes[aiId].content = reply;
        chat.nodes[aiId].tokens = estimateTokens(reply);
        chat.nodes[aiId].streaming = false;
        save(); renderMessages();
        currentParent = aiId;
        continue;
      }

      const messages = await buildApiMessages(currentPath, conf, true, chat);
      const { fullText, reasoningText, blocks, error } = await streamCompletion(conf, messages, (txt, think, blks) => {
        chat.nodes[aiId].content = txt;
        chat.nodes[aiId].reasoning = think;
        chat.nodes[aiId].blocks = blks;
        if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId], true);
        chat.nodes[aiId].tokens = estimateTokens(txt);
        renderLiveBubble('bubble-' + aiId, txt, think, true, blks);
      }, undefined, chat);   // 群聊也要把发起的对话传下去，否则电脑操控的 runId 会写给「当前」那个
      // 流结束：renderLiveBubble 是节流的，撤掉挂着的那次、立刻画完整内容（不丢尾巴）
      renderLiveBubble('bubble-' + aiId, fullText, reasoningText, true, blocks, true);

      // 只写 content 的话这条 ⚠️ 永远显示不出来：上面 onUpdate 每收一个字都在写
      // chat.nodes[aiId].blocks，而 436 行的渲染是 `else if (m.blocks?.length)` ——
      // blocks 非空时完全不看 content。群聊里任何一个模型（云端也走这条）流到一半网抖，
      // 气泡就断在半句话且零提示，看着像模型本来就这么答的。
      if (error) { appendWarnBlock(chat.nodes[aiId], error); chat.nodes[aiId].tokens = 0; if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]); }
      else {
        if (typeof prefetchNurseCommands === 'function') await prefetchNurseCommands(fullText, conf);
        const gazeResults = (typeof prefetchGazeCommands === 'function') ? await prefetchGazeCommands(fullText, conf) : [];
        if (typeof musicLyricsPrefetch === 'function') await musicLyricsPrefetch(fullText, conf);
        if (typeof breathPrefetch === 'function') await breathPrefetch(fullText, conf);
        const studyCtx = { autoOffer: false, chat, conf, userTurnId: parentMsgId, aiNodeId: aiId, gazeResults };
        chat.nodes[aiId].content = processAiCommands(fullText, chat, conf, studyCtx);
        chat.nodes[aiId].reasoning = reasoningText;
        // 藏宝地图排第一个（理由见 05-prompts-api.js 同一处）
        if (typeof _applyTreasureToBlocks === 'function') _applyTreasureToBlocks(blocks, studyCtx);
        if (typeof _applyWishToBlocks === 'function') _applyWishToBlocks(blocks, studyCtx);
        if (typeof _applyNurseToBlocks === 'function') _applyNurseToBlocks(blocks);
        if (typeof _applyGazeToBlocks === 'function') _applyGazeToBlocks(blocks, gazeResults, conf);
        if (typeof _applyVitalsToBlocks === 'function') _applyVitalsToBlocks(blocks);
        if (typeof _applyLifeToBlocks === 'function') _applyLifeToBlocks(blocks);
        if (typeof _applyWhoUserToBlocks === 'function') _applyWhoUserToBlocks(blocks, chat, conf);
        if (typeof _applyStudyToBlocks === 'function') _applyStudyToBlocks(blocks, studyCtx);
        if (typeof _applyMomentsToBlocks === 'function') _applyMomentsToBlocks(blocks);
        if (typeof _applyMusicListenToBlocks === 'function') _applyMusicListenToBlocks(blocks, conf);
        if (typeof _applyMusicLyricsToBlocks === 'function') _applyMusicLyricsToBlocks(blocks, conf);
        if (typeof _applyBreathToBlocks === 'function') _applyBreathToBlocks(blocks, conf);
        if (typeof _applyGalleryToBlocks === 'function') _applyGalleryToBlocks(blocks);
        if (typeof _applyStickerOffToBlocks === 'function') _applyStickerOffToBlocks(blocks);
        if (typeof _applyReactToBlocks === 'function') _applyReactToBlocks(blocks);
        if (typeof _applyThinkVeilToBlocks === 'function') _applyThinkVeilToBlocks(blocks);
        // ⚠️ 群聊也走这条路，而渲染优先用 m.blocks —— 不补这一行的话，群里的模型写
        //    [[CHATS]] 时 content 那边置位成功了，blocks 里却还留着裸标签给用户看见
        if (typeof _applyChatPeekToBlocks === 'function') _applyChatPeekToBlocks(blocks, conf);
        if (typeof _applyErrandToBlocks === 'function') _applyErrandToBlocks(blocks, studyCtx);
        if (typeof _applyBuildToBlocks === 'function') _applyBuildToBlocks(blocks, studyCtx);
        if (typeof _applyAlbumToBlocks === 'function') _applyAlbumToBlocks(blocks, studyCtx);
        if (typeof sanitizeBlocksDiary === 'function') sanitizeBlocksDiary(blocks);
        chat.nodes[aiId].blocks = blocks;
        if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]);
        chat.nodes[aiId].tokens = estimateTokens(chat.nodes[aiId].content);
        if (_aiVoiceWanted) _maybeAiVoice(chat, aiId);
        if (_aiDialReason) _maybeAiDial(chat, aiId);
      }
      chat.nodes[aiId].streaming = false;
      _invalidateNodeCache(aiId);
      save(); renderMessages();
      _debouncedSidebarUpdate();
      if (reasoningText) {
        const _aiId = aiId;
        summarizeThinking(reasoningText).then(summary => {
          if (summary && chat.nodes[_aiId]) {
            chat.nodes[_aiId].thinkingSummary = summary;
            save(); _invalidateNodeCache(_aiId); renderMessages();
          }
        });
        translateThinkingFor(chat.nodes[_aiId], _aiId);
      }
      triggerMemSummaries(fullText, chat.nodes[aiId], aiId);
      currentParent = aiId;
    }
  }
}

// ═══════════════════════════════════════════════════════
// RENDER MESSAGES — DOM diffing, no innerHTML wipe, zero reflow on cached nodes
// ═══════════════════════════════════════════════════════
const _msgHtmlCache = new Map(); // nodeId → cacheKey string
const _msgDomCache  = new Map(); // nodeId → wrapper div

const CAT_GIF = './img/thinking-cat.gif';

// ── 思考链折叠块（legacy 路径：模型只给了 m.reasoning，没给 blocks）──
function legacyThinkHtml(reasoning, streaming, thinkingSummary, thinkZh) {
  if (!reasoning) return '';
  // 思考里抄了一遍 [[HIDE_LETTER:]] 的：纸条正文在她找到之前不许露（68-treasure.js）
  if (typeof treasureVeil === 'function') reasoning = treasureVeil(reasoning);
  const label = streaming ? '💭 思考中…'
    : (thinkingSummary ? `💭 ${thinkVeil(escHtml(thinkingSummary))}` : '💭 思考过程');
  const doneClass = streaming ? '' : ' done';
  const openClass = streaming ? ' open' : '';
  const zh = streaming || !_thinkTransReal(reasoning, thinkZh?.[0]) ? '' : thinkZh[0];
  return `<div class="think-block${doneClass}${openClass}"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label${streaming ? ' think-live' : ''}">${label}</span>${zh ? THINK_LANG : (!streaming && _thinkNeedsTrans(reasoning) ? THINK_TRANS : '')}${THINK_LOCK}</div><div class="think-body">${streaming ? thinkVeil(escHtml(reasoning)) : thinkPairHtml(reasoning, zh)}</div></div>`;
}

// 只要思考链、不要正文。给语音气泡用：语音条整条替代了正文渲染，
// blocks 里的 thinking 和 legacy 的 m.reasoning 会一起被吞掉，
// 语音消息就成了全场唯一看不到思考过程的气泡。两条路径都补上。
function thinkOnlyHtml(m) {
  if (m.blocks?.length) {
    // 按类型筛、不按有没有字筛：thinkZh 是按「第几个思考块」对齐的，筛掉空块会错位
    const th = m.blocks.filter(b => b.type === 'thinking');
    return th.some(b => b.text) ? renderBlocksHtml(th, false, m.thinkingSummary, undefined, m.thinkZh) : '';
  }
  return legacyThinkHtml(m.reasoning, false, m.thinkingSummary, m.thinkZh);
}

// ── 表情包拆气泡（渲染层，不动存储）──
// AI 一条消息里文字和表情混在一起时，真实聊天软件是文字一条、表情另起一条。
// 这里只在**渲染层**拆：state / IndexedDB / 发给模型的上下文里仍然是一条消息，
// 只是 DOM 多出几个气泡。所有拆出来的气泡带同一个 data-msg-id，
// 长按菜单、编辑、重新生成、多选删除照旧作用在整条原始消息上。
//
// 为什么在渲染好的 HTML 上切而不是切源文本：content 和 blocks 两条渲染路径
// 最后都汇进 stickerTagToHtml，产物统一是 <img class="sticker-msg">，
// 在这里切一次就同时覆盖两条路。
const _STICKER_IMG_RE = /<img class="sticker-msg"[^>]*>/g;

function _splitStickerBubbles(html) {
  // 思考块和工具结果折叠块里也可能出现 sticker-msg（比如 AI 在思考里引用了表情），
  // 那种情况切开会把折叠块劈成两半。保守起见整条不拆，退回今天的行为。
  if (html.includes('think-block') || html.includes('<details')) return null;

  const segs = [];
  let last = 0;
  _STICKER_IMG_RE.lastIndex = 0;
  for (let m; (m = _STICKER_IMG_RE.exec(html)); ) {
    const before = html.slice(last, m.index);
    if (before.trim()) segs.push({ type: 'text', html: before });
    segs.push({ type: 'sticker', html: m[0] });
    last = m.index + m[0].length;
  }
  if (!segs.length) return null;              // 没有表情，照旧一个气泡
  const tail = html.slice(last);
  if (tail.trim()) segs.push({ type: 'text', html: tail });
  return segs.length > 1 ? segs : null;       // 纯表情消息也是一个气泡，别多包一层
}

// ── 会话形态：群聊走即时通讯样式，单对话走 AI 助手样式 ──────────────────
// 判定一律直接看 chat.isGroupChat。以前 renderMsgGroup 是从 #chatWindow 的 class
// 反读的，而那个 class 在**所有节点都建完之后**才写（renderMessages 末尾）——
// 首次渲染一个新会话时，读到的是上一个会话的形态。群聊切单聊会看到一整屏
// 带头像的气泡，再点一下才恢复。
const FIVE_MIN = 5 * 60 * 1000;
function _chatMode(chat) { return chat?.isGroupChat ? 'group' : 'solo'; }
function _applyChatMode(win, chat) {
  if (!win) return 'solo';
  const mode = _chatMode(chat);
  // 两个 class 互斥，先摘掉另一个再挂，避免切会话时残留
  win.classList.toggle('gc-mode-group', mode === 'group');
  win.classList.toggle('gc-mode-solo', mode === 'solo');
  return mode;
}
// 群聊里同一个模型连着发言时，第二条起不重复头像和昵称。
// 隔了时间分割线就重新算一段（跟 renderMsgGroup 里 showTime 用同一个阈值，
// 不然会出现「有时间线但没头像」的断头消息）。
function _isContinuation(m, prev, mode) {
  if (mode !== 'group' || !prev) return false;
  if (m.role !== 'ai' || prev.role !== 'ai') return false;
  if (m.timestamp && (!prev.timestamp || m.timestamp - prev.timestamp > FIVE_MIN)) return false;
  return (prev.modelId ?? prev.modelNickname) === (m.modelId ?? m.modelNickname);
}

function _nodeCacheKey(m, mode, cont) {
  const selected = state.selectedMessageIds.has(m.id) ? 1 : 0;
  const selectMode = state.isSelectMode ? 1 : 0;
  // 表情数计进 key：同一条消息在「流式中不拆」和「流式结束拆成 N 个气泡」之间会变形，
  // 不带这一项的话缓存会把拆好的和没拆的串台。
  const stk = (m.content?.match(/\[\[(?:STICKER|GIF|GIF_SEARCH|IMG|IMG_SEARCH):/g) || []).length;
  // 形态和「是否续接」也必须进 key：同一条消息在群聊/单聊下渲染出的 DOM 不一样，
  // 不带的话切会话会直接复用上一形态的节点（单聊里冒出群聊头像就是这么来的）。
  const base = `${m.id}|${m.role}|${m.streaming ? 1 : 0}|${m.content?.length}|ut${m.userThinking?.length||0}|${m.reasoning?.length||0}|${m.blocks?.length||0}|${m.timestamp||0}|sm${selectMode}|sel${selected}|stk${stk}|${mode}|ct${cont ? 1 : 0}|gp${m.gapNote?.length||0}|mn${m.moodNote?.length||0}`;
  if (m.isMulti && m.variants) {
    const vk = m.variants.map(v => `${v.streaming?1:0}|${v.content?.length}`).join(',');
    return base + '|' + vk + '|cv' + (m.chosenVariant||0);
  }
  return base;
}

// Invalidate cache for a specific node (call after streaming ends)
function _invalidateNodeCache(nodeId) {
  _msgHtmlCache.delete(nodeId);
  _msgDomCache.delete(nodeId);
}

// Debounced sidebar/header updates — these are heavy and don't need to run every render
let _sidebarUpdateTimer = null;
function _debouncedSidebarUpdate() {
  clearTimeout(_sidebarUpdateTimer);
  _sidebarUpdateTimer = setTimeout(() => {
    renderChatList();
    updateHeaderTokenInfo();
    renderConvSettingsBar();
  }, 300);
}

let _emptyStateRendered = false;

// ── 空对话页的极光（2026-10-08，照 reactbits Aurora 的思路手写，分享页 grancyan-share 同款）──
// 一张全屏片元着色器，颜色跟 --accent 走（换主题/闹鬼模式会跟着变）。透明底 + screen 混合，只在没设壁纸时画。
// 省电：半分辨率渲染；canvas 被 renderMessages 换掉、滚出视野、App 切后台都停帧；
// 换掉以后主动 loseContext，免得新建一次对话就漏一个 WebGL 上下文。减少动态效果时只画一帧静止的。
let _emptyAuroraStop = null;   // 当前那张极光的收摊函数；空页面被换掉时 renderMessages 调它
function _emptyAurora(cv) {
  _emptyAuroraStop?.();
  if (!cv) return;
  // 有壁纸就不画：花壁纸上 screen 只会把暗部整片抬成主题色的雾（用户截图：橄榄绿＝烟雾弹），
  // soft-light 几乎看不见、overlay 会把壁纸染色，都试过了。极光只留给纯色底。
  if (state.background) return;
  const gl = cv.getContext('webgl', { antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return;   // 没 WebGL 就只剩原来的同心圆，不影响别的
  const fs = `precision mediump float;uniform vec2 R;uniform float T;uniform vec3 A;uniform vec3 B;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){vec2 uv=gl_FragCoord.xy/R;vec2 q=vec2(uv.x*R.x/R.y,uv.y);float t=T*.045;
 float w=fbm(vec2(q.x*1.6+t,t*.7));
 float k=exp(-pow((uv.y-.6-w*.34)*2.8,2.))*(.35+.8*pow(fbm(vec2(q.x*2.2+w*1.5+t*1.2,uv.y*2.4-t)),2.));
 float w2=fbm(vec2(q.x*1.1-t*.8,4.+t*.5));
 float k2=exp(-pow((uv.y-.8-w2*.25)*4.,2.))*(.3+.7*fbm(vec2(q.x*2.-t+w2,uv.y*2.)));
 vec3 c=A*k*.85+B*k2*.3;
 gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));}`;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; };
  const v = sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'), f = sh(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return;
  const pg = gl.createProgram(); gl.attachShader(pg, v); gl.attachShader(pg, f); gl.linkProgram(pg);
  if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) return;
  gl.useProgram(pg);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pg, 'R'), uT = gl.getUniformLocation(pg, 'T'), uA = gl.getUniformLocation(pg, 'A'), uB = gl.getUniformLocation(pg, 'B');
  let lastAcc = '';
  const color = () => {   // 主光带＝主题色（太暗的抬亮），副光带＝主题色往冷色里拉
    const s = getComputedStyle(cv).getPropertyValue('--accent').trim();
    if (s === lastAcc) return; lastAcc = s;
    const m = /^#([0-9a-f]{6})$/i.exec(s) || /^#([0-9a-f]{3})$/i.exec(s);
    let a = [.78, .58, .33];
    if (m) { const x = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; a = [0, 2, 4].map(i => parseInt(x.substr(i, 2), 16) / 255); }
    else { const r = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s); if (r) a = [r[1], r[2], r[3]].map(c => Math.min(255, +c) / 255); }
    const lum = a[0] * .3 + a[1] * .59 + a[2] * .11;
    if (lum < .35) a = a.map(c => Math.min(1, c + (.35 - lum)));
    gl.uniform3fv(uA, a);
    gl.uniform3fv(uB, [a[0] * .35 + .12, a[1] * .45 + .22, a[2] * .4 + .48]);
  };
  const size = () => {
    const w = Math.max(1, Math.round(cv.clientWidth * .5)), hh = Math.max(1, Math.round(cv.clientHeight * .5));
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; gl.viewport(0, 0, w, hh); gl.uniform2f(uR, w, hh); }
  };
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now() - 20000;
  let raf = 0, seen = true, n = 0, io = null, dead = false;
  const stop = () => {
    if (dead) return; dead = true;
    cancelAnimationFrame(raf); raf = 0; io?.disconnect();
    document.removeEventListener('visibilitychange', go);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (_emptyAuroraStop === stop) _emptyAuroraStop = null;
  };
  _emptyAuroraStop = stop;
  function frame(now) {
    raf = 0;
    if (dead) return;
    if (!cv.isConnected) return stop();
    // 壁纸是异步从 IndexedDB 读出来的，可能晚于第一次画空页面；空页面开着时换上壁纸也走这里
    if (state.background) { cv.classList.remove('on'); return stop(); }
    if (n++ % 60 === 0) color();
    size(); gl.uniform1f(uT, (now - t0) / 1000);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    cv.classList.add('on');
    // 减少动态效果：这一帧拍成静态图贴上去，上下文当场还掉
    if (still) { try { cv.style.backgroundImage = `url(${cv.toDataURL()})`; } catch (e) {} return stop(); }
    go();
  }
  function go() {
    if (dead) return;
    if (!cv.isConnected) return stop();
    if (seen && !document.hidden && !raf) raf = requestAnimationFrame(frame);
  }
  // 第一帧等布局好了再画（innerHTML 刚塞进去，clientWidth 可能还是 0）
  raf = requestAnimationFrame(frame);
  if (still) return;
  document.addEventListener('visibilitychange', go);
  if ('IntersectionObserver' in window) { io = new IntersectionObserver(es => { seen = es[0].isIntersecting; go(); }); io.observe(cv); }
}

// ═══════════════════════════════════════════════════════
// 根据当前对话是否被 AI 结束，切换输入栏禁用态和结束横幅
function applyChatEndedState() {
  const chat = getActiveChat();
  const ended = !!(chat && chat.ended);
  const banner = document.getElementById('chatEndedBanner');
  const bar = document.querySelector('.input-bar');
  const input = document.getElementById('userInput');
  const sendBtn = document.querySelector('.plus-btn');   // 发送键已并进 ＋
  if (banner) {
    if (ended) {
      const who = escHtml(chat.endedBy || 'AI');
      const reason = chat.endedReason ? `：<span style="opacity:.75">${escHtml(chat.endedReason)}</span>` : '';
      banner.innerHTML = `🚪 <span>「${who}」结束了这场对话，聊天记录已保留${reason}</span>`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
  if (bar) bar.classList.toggle('is-ended', ended);
  if (input) {
    input.disabled = ended;
    input.placeholder = ended ? '这场对话已结束，无法再发送消息…' : '给AI发送消息…';
  }
  if (sendBtn) sendBtn.disabled = ended;
}

// 空页面猫背后那行巨大的空心字：只选了一个模型就是它的名字，选了几个或一个没选就是 GranCyan。
// 括号里的型号（「小克（claude-opus-4-6）」）去掉 —— 字大到两头出血，留着只会切成看不出是什么的半截。
function _emptyEchoName() {
  const ids = getActiveChatModelIds();
  const cs = state.configs.filter(c => ids.includes(c.id));
  const n = cs.length === 1 ? String(cs[0].nickname || '').replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim() : '';
  return n || 'GranCyan';
}
// 换模型不重画空页面（_emptyStateRendered 挡着），名字就地换掉
function refreshEmptyEcho() {
  const el = document.querySelector('#emptyEchoLayer .empty-echo');
  if (el) el.textContent = el.dataset.text = _emptyEchoName();   // 描边那层（::before）读 data-text
}
// 大字不跟空页面放在一起，单独挂在 body 下（#emptyEchoLayer）。用户要的是「差值」：大字把它背后的壁纸 / 遮罩 / 网点反色。
// main 带 z-index:10 自成一层，大字留在里面的话差值只能跟 main 里透明的那片混，什么都反不到（10-14 第一版就栽在这）。
// 挂到外面、z-index 压在 main 底下，框成 #chatWindow 那么大；空页面在不在，看 chatWindow 里有没有 .empty-state。
let _echoObs = null;
function syncEmptyEcho() {
  const win = document.getElementById('chatWindow');
  if (!win) return;
  let layer = document.getElementById('emptyEchoLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'emptyEchoLayer'; layer.setAttribute('aria-hidden', 'true'); layer.hidden = true;
    document.body.appendChild(layer);
  }
  if (!_echoObs && typeof MutationObserver === 'function') {
    // 空页面被别的东西换掉（发第一条消息、切对话）时跟着藏；侧栏收起 / 窗口缩放时跟着挪
    _echoObs = new MutationObserver(syncEmptyEcho); _echoObs.observe(win, { childList: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncEmptyEcho).observe(win);
    addEventListener('resize', syncEmptyEcho);
  }
  if (!win.querySelector(':scope > .empty-state')) { layer.hidden = true; return; }
  // 从藏着到出现换一个新节点，入场动画重播一遍
  if (layer.hidden || !layer.firstChild) { layer.innerHTML = '<div class="empty-echo"></div>'; layer.hidden = false; }
  const r = win.getBoundingClientRect();
  Object.assign(layer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  layer.firstChild.textContent = layer.firstChild.dataset.text = _emptyEchoName();
}

function renderMessages() {
  try {
  const win  = document.getElementById('chatWindow');
  const chat = getActiveChat();
  applyChatEndedState();
  // ⏹/＋ 按当前对话算（见 updateStreamUI）；换对话的十来个入口最后都会走到这里
  if (typeof updateStreamUI === 'function') updateStreamUI();
  // 跑腿那颗小标记也按当前对话算，理由同上（61-errand.js）
  if (typeof errandRefreshChip === 'function') errandRefreshChip();

  if (!chat?.headId || !chat.nodes || !Object.keys(chat.nodes).length) {
    if (!_emptyStateRendered || win.querySelector('.msg-group')) {
      win.innerHTML = `
        <div class="empty-state">
          <canvas class="empty-aurora" aria-hidden="true"></canvas>
          <svg style="position:absolute;opacity:0.06;pointer-events:none" width="340" height="340" viewBox="0 0 340 340">
            <circle cx="170" cy="170" r="130" fill="none" stroke="var(--accent)" stroke-width="1"/>
            <circle cx="170" cy="170" r="88" fill="none" stroke="var(--accent)" stroke-width="0.7"/>
            <circle cx="170" cy="170" r="48" fill="none" stroke="var(--accent)" stroke-width="0.5"/>
            <circle cx="170" cy="170" r="3" fill="var(--accent)" opacity="0.5"/>
          </svg>
          <div class="empty-bg empty-grid" aria-hidden="true"></div>
          <img class="empty-icon" src="./img/empty-icon.png">
          <div class="empty-title">${Array.from('在这里开始聊天吧 ‿︵‿', (c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
          <div class="empty-sub">${state.memories.length
            ? `(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧ 记忆系统已激活 — 大家都记着你呢<br><br><span style="font-size:12px;opacity:.5">${state.memories.length} 条记忆 · ${state.configs.length} 个模型待命</span>`
            : `今天想聊点什么呢？(｀・ω・´)<br><br><span style="font-size:12px;opacity:.5">输入消息开始对话，或在设置里先配置 API Key</span>`
          }</div>
        </div>`;
      _emptyStateRendered = true;
      _emptyAurora(win.querySelector('.empty-aurora'));
    }
    if (typeof syncEmptyEcho === 'function') syncEmptyEcho();
    _applyChatMode(win, chat);
    return;
  }
  _emptyStateRendered = false;
  _emptyAuroraStop?.();

  // 形态在建节点**之前**定下来：renderMsgGroup 要按它决定渲不渲染头像/发言人名，
  // 而缓存 key 也带着它。放到末尾去 toggle 就晚了一整轮。
  const mode = _applyChatMode(win, chat);

  const path = getMessagePath(chat, chat.headId);
  const atBottom = win.scrollHeight - win.scrollTop - win.clientHeight < 80;
  const prevScroll = win.scrollTop;

  const wantedIds = new Set(path.map(m => m.id));
  // Evict cache entries no longer in path
  for (const [id] of _msgDomCache) {
    if (!wantedIds.has(id)) { _msgDomCache.delete(id); _msgHtmlCache.delete(id); }
  }

  // Build ordered list of DOM nodes to display
  const newNodes = [];
  path.forEach((m, i) => {
    const prev = i > 0 ? path[i-1] : null;
    const prevTs = prev ? prev.timestamp : null;
    const cont = _isContinuation(m, prev, mode);
    const ck = _nodeCacheKey(m, mode, cont);
    const canCache = !m.streaming && !m.isMulti;

    let wrapper;
    if (canCache && _msgHtmlCache.get(m.id) === ck && _msgDomCache.has(m.id)) {
      // Reuse DOM node — zero cost
      wrapper = _msgDomCache.get(m.id);
    } else {
      const html = renderMsgGroup(m, prevTs, mode, cont);
      // Reuse existing DOM node if present to avoid GC pressure
      wrapper = _msgDomCache.get(m.id) || document.createElement('div');
      wrapper.setAttribute('data-msg-wrapper', m.id);
      wrapper.innerHTML = html;
      typesetMath(wrapper);
      if (canCache) {
        _msgHtmlCache.set(m.id, ck);
        _msgDomCache.set(m.id, wrapper);
      } else {
        _msgHtmlCache.delete(m.id);
        _msgDomCache.delete(m.id);
      }
    }
    newNodes.push(wrapper);
  });

  // ── DOM diffing: no wipe, only move/add/remove what changed ──
  const newSet = new Set(newNodes);
  // Remove nodes no longer needed
  for (const child of [...win.children]) {
    if (!newSet.has(child)) win.removeChild(child);
  }
  // Insert/reorder in one pass
  for (let i = 0; i < newNodes.length; i++) {
    const node = newNodes[i];
    if (win.children[i] !== node) {
      win.insertBefore(node, win.children[i] || null);
    }
  }

  // 手机上只有最后一条 AI 消息常驻操作条（A03，css 的 @media (hover:none)）。
  // 标在包装层上而不是写进 HTML：包装层是复用的，HTML 缓存的 key 不用因为「它不再是最后一条」失效。
  let lastAiIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) { if (path[i].role !== 'user') { lastAiIdx = i; break; } }
  for (let i = 0; i < newNodes.length; i++) newNodes[i].classList.toggle('is-last-ai', i === lastAiIdx);

  // 淡墨还在放的那条（流式中、或刚换成正式消息）接着同一份进度蒙上，排在滚到底之前（70-ink.js）
  if (typeof inkAfterRender === 'function') inkAfterRender();

  if (atBottom) _scrollToBottomSettled(win);
  else win.scrollTop = prevScroll;

  } finally {
    // 单点不变式：无论正常渲染还是空对话提前 return，离开 renderMessages 前都同步一次。
    // 正在朗读的消息若已不在视图，ttsSyncBtn 会停掉并释放它；还在则只回填按钮文案。
    if (typeof ttsSyncBtn === 'function') ttsSyncBtn();
  }
}

// 开了 content-visibility:auto 之后，还没渲染过的消息高度只是估算值（contain-intrinsic-size），
// scrollHeight 因此偏小 —— 单次 scrollTop = scrollHeight 会停在离底部还差一截的地方。
// 滚到底会让这些消息进入视口、拿到真实高度，scrollHeight 随之变大，所以要再纠一次。
// 两帧足够收敛（第二帧是给图片/公式排版落定留的），高度没再变就提前收工。
function _scrollToBottomSettled(win, frames = 2) {
  win.scrollTop = win.scrollHeight;
  if (frames <= 0) return;
  const before = win.scrollHeight;
  requestAnimationFrame(() => {
    if (!win.isConnected) return;
    if (win.scrollHeight === before) { win.scrollTop = win.scrollHeight; return; }
    _scrollToBottomSettled(win, frames - 1);
  });
}

// ── 手机：点一下气泡调出 / 收起这条消息的操作条（A03，用户拍板）──
// 手机上只有最后一条 AI 消息常驻操作条（css 的 @media (hover:none)），往上的靠长按菜单或点一下气泡。
// 跟 18-gesture.js 的手势分着走、互不抢：
//   · 双击是全屏文本页 —— 单击先等一个双击窗口再生效，窗口里全屏页开了就什么都不做；
//   · 左滑引用 / 拖着滚 —— 手指挪了超过 10px 就不算点；长按菜单 —— 按得久或者菜单开着就让开；
//   · 正在选字、多选模式、点在按钮 / 链接 / 图 / 代码 / 引用条 / 思考块上 —— 让开。
// 认 pointerup 而不是 click：跟 18-gesture 的双击判定同一个时刻起算，也不吃 click 可能的延迟。
let _actTapTimer = null, _actDown = null;
function _msgTapDown(e) {
  _actDown = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
}
function _msgTapActions(e) {
  if (e.pointerType !== 'touch' || !_actDown) return;
  const d = _actDown; _actDown = null;
  if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 10) return;   // 滑动 / 左滑引用
  if (Date.now() - d.t > 450) return;                        // 长按松手：菜单那条路
  if (!window.matchMedia || !window.matchMedia('(hover:none)').matches) return;
  if (state.isSelectMode) return;
  const t = e.target;
  const g = t && t.closest && t.closest('.msg-group[data-node-id]');
  if (!g || !t.closest('.bubble, .msg-attach')) return;
  if (t.closest('button, input, textarea, a, img, pre, code, table, summary, details, .code-block-wrap, .artifact-card, .branch-switcher, .bubble-quote, .voice-bubble, .msg-img, .think-toggle, .think-block')) return;
  if (window.getSelection && !window.getSelection().isCollapsed) return;
  const menu = document.getElementById('contextMenu');
  if (menu && menu.style.display === 'flex') return;
  clearTimeout(_actTapTimer);
  _actTapTimer = setTimeout(() => {
    if (document.getElementById('msgTextView')?.classList.contains('open')) return;   // 是双击
    if (!g.isConnected) return;
    const on = !g.classList.contains('acts-on');
    document.querySelectorAll('.msg-group.acts-on').forEach(x => x.classList.remove('acts-on'));
    if (on) g.classList.add('acts-on');
  }, 340);
}

// ── 手机：右侧 ⬆↑↓⬇ 平时收着，她手指在滑的时候浮出来，停下 1.5 秒再淡掉（A13）──
// 只挂一个 class，长什么样、哪些设备上收起来全在 css（#msgNavBar.nav-awake）。
// 认的是手指（touchmove）不是 scroll 事件：打开对话自动滚到底、AI 流式出字一直往下顶，
// 都会发 scroll —— 挂在 scroll 上的话这一列在她没碰屏幕的时候也一直亮着。
let _navAwakeTimer = null;
function _msgNavWake() {
  const bar = document.getElementById('msgNavBar');
  if (!bar) return;
  bar.classList.add('nav-awake');
  clearTimeout(_navAwakeTimer);
  _navAwakeTimer = setTimeout(() => bar.classList.remove('nav-awake'), 1500);
}

function _initMsgTouchUi() {
  const win = document.getElementById('chatWindow');
  if (!win || win.dataset.tapActsBound) return;
  win.dataset.tapActsBound = '1';
  win.addEventListener('pointerdown', _msgTapDown, { passive: true });
  win.addEventListener('pointerup', _msgTapActions, { passive: true });
  win.addEventListener('pointercancel', () => { _actDown = null; }, { passive: true });
  win.addEventListener('touchmove', _msgNavWake, { passive: true });
  document.getElementById('msgNavBar')?.addEventListener('pointerdown', _msgNavWake, { passive: true });
}
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded', _initMsgTouchUi);

// mode: 'group' | 'solo'（renderMessages 求好传进来，别再从 DOM class 反读）
// cont: 群聊里这条是不是上一条同一发言人的续接 —— 续接不重复头像和昵称
function renderMsgGroup(m, prevTimestamp, mode = _chatMode(getActiveChat()), cont = false) {
  const isGroupMode = mode === 'group';
  const isUser = m.role === 'user';
  const isSelected = state.selectedMessageIds.has(m.id);
  const accent = activeAccent();

  const msgDate = m.timestamp ? new Date(m.timestamp) : new Date();
  const showTime = !!m.timestamp && (!prevTimestamp || (m.timestamp - prevTimestamp > FIVE_MIN));

  let timeHtml = '';
  if (showTime) {
    const now = new Date();
    const isToday = msgDate.toDateString() === now.toDateString();
    const isYesterday = msgDate.toDateString() === new Date(now - 86400000).toDateString();
    const timeStr = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    let label = isToday ? timeStr
              : isYesterday ? '昨天 ' + timeStr
              : (msgDate.getMonth()+1) + '月' + msgDate.getDate() + '日 ' + timeStr;
    // 样式在 grancyan.css 的 .msg-time-sep（原来整段写死在内联里，横线还是写死的白 5%）
    timeHtml = `<div class="msg-time-sep"><span>${label}</span></div>`;
  }
  // 无缝换窗（js/37-forge.js）搬过来的历史，段与段之间的断层。
  // ⚠️ 这条**必须画出来给人看**，不能只回填给模型：用户看到的如果是一串
  // 无缝相连的普通消息，她就无从检查这次换窗到底带了什么、跳过了什么，
  // 只有模型暗地里收到标记。挂在 timeHtml 后面是因为 user / ai 两条渲染
  // 路径都以 `${timeHtml} <div class="msg-group…">` 开头，一处就都覆盖到。
  if (m.gapNote) {
    timeHtml += `<div class="msg-gap">⌇ ${escHtml(m.gapNote)}</div>`;
  }
  // -----------------------------------------------------

  if (isUser) {
    const userThinkingHtml = m.userThinking ? `<details class="user-thinking-block">
      <summary><span class="user-thinking-chev">▸</span><span>我的思考</span></summary>
      <div class="user-thinking-body">${escHtml(m.userThinking)}</div>
    </details>` : '';
    const bubbleStyle = `box-shadow:0 4px 24px ${hexAlpha(accent,0.18)}`;
    const isGroup = isGroupMode;
    // 分支导航（当父节点下有多个用户消息分支时显示）
    const chat = getActiveChat();
    const siblings = chat ? getChildrenOf(chat, m.parentId, 'user') : [];
    const branchIdx = siblings.findIndex(s => s.id === m.id);
    const branchHtml = siblings.length > 1 ? `
      <div class="branch-switcher" style="margin-bottom:4px;align-self:flex-end">
        <button onclick="switchBranch(${m.id},-1)" ${branchIdx===0?'disabled':''}
          title="上一个版本">◀</button>
        <span>${branchIdx+1}/${siblings.length}</span>
        <button onclick="switchBranch(${m.id},1)" ${branchIdx===siblings.length-1?'disabled':''}
          title="下一个版本">▶</button>
      </div>` : '';
    const innerHtml = `
        ${branchHtml}
        <div style="display:flex;align-items:flex-end;gap:10px;flex-direction:row-reverse">
          ${state.isSelectMode?`<input type="checkbox" ${isSelected?'checked':''} onclick="toggleMessageSelection(${m.id},event)" style="width:16px;height:16px;accent-color:${accent};flex-shrink:0;margin-bottom:4px">`:''}
          ${!m.audio && m.content.length > 320
            ? `<div class="msg-attach" onclick="if(!event.target.closest('details,a,button,.bubble-quote'))this.classList.toggle('open')">
                 <div class="msg-attach-head">
                   <div class="msg-attach-icon">📄</div>
                   <div class="msg-attach-meta">
                     <span class="msg-attach-name">长文本</span>
                     <span class="msg-attach-size">${m.content.length} 字符 · 点击展开</span>
                   </div>
                 </div>
                 <div class="msg-attach-body">
                   ${(m.quotes||[]).map(q=> {
                    const txt = typeof q === 'string' ? q : q.text;
                    const nid = typeof q === 'string' ? null : q.sourceNodeId;
                    return `<div class="bubble-quote" style="cursor:pointer;" data-q="${escHtml(txt).replace(/"/g, '&quot;')}"
                      ${nid ? `onclick="scrollToMessage(${nid}, this.dataset.q)" title=\"点击定位原文\"` : ''}>
                      ↩ ${escHtml(txt.length > 80 ? txt.slice(0,80)+'…' : txt)}</div>`;
                  }).join('')}
                   ${m.files?.length ? m.files.map((f,fi) => renderFileCard(f,fi,m.id)).join('') : ''}
                   ${m.images?.length ? m.images.filter(img => img.url).map(img => `<img class="msg-img" src="${img.url}" alt="图片">`).join('') : ''}
                   ${userThinkingHtml}
                   ${renderUserText(m.content)}
                 </div>
               </div>`
            : `<div class="bubble user" style="${bubbleStyle}">
                 ${(m.quotes||[]).map(q=> {
                  const txt = typeof q === 'string' ? q : q.text;
                  const nid = typeof q === 'string' ? null : q.sourceNodeId;
                  return `<div class="bubble-quote" style="cursor:pointer;" data-q="${escHtml(txt).replace(/"/g, '&quot;')}"
                    ${nid ? `onclick="scrollToMessage(${nid}, this.dataset.q)" title=\"点击定位原文\"` : ''}>
                    ↩ ${escHtml(txt.length > 80 ? txt.slice(0,80)+'…' : txt)}</div>`;
                }).join('')}
               ${m.files?.length ? m.files.map((f,fi) => renderFileCard(f,fi,m.id)).join('') : ''}
               ${m.images?.length ? m.images.filter(img => img.url).map(img => `<img class="msg-img" src="${img.url}" alt="图片">`).join('') : ''}
               ${userThinkingHtml}
               ${m.audio
                 ? renderVoiceBubble(m)
                 : renderUserText(m.content)}
              </div>`}
        </div>
        ${typeof renderReactions === 'function' ? renderReactions(m) : ''}
        <div class="msg-token-info">${m.tokens?`~${m.tokens} tokens`:''}</div>
        ${!state.isSelectMode?`
          <div class="msg-actions">
            <button class="msg-action-btn" data-ic="react" onclick="openReactionPicker(${m.id},event)">标注</button>
            <button class="msg-action-btn" data-ic="edit" onclick="editMessage(${m.id})">编辑</button>
            <button class="msg-action-btn${isFavMsg(m.id)?' on':''}" data-ic="fav" onclick="toggleFavMsg(${m.id})">${isFavMsg(m.id)?'已收藏':'收藏'}</button>
            <button class="msg-action-btn ma-del" data-ic="del" onclick="deleteSingleMessage(${m.id})">删除</button>
          </div>`:''}`;

    // 用户头像（默认隐藏，账号设置里可开启）
    const uAv = (state.showUserAvatar && state.userAvatar)
      ? `<div class="user-avatar-col"><img class="msg-avatar-img" src="${state.userAvatar}" alt="me"></div>` : '';
    if (isGroup) {
      return `
      ${timeHtml} <div class="msg-group user" data-node-id="${m.id}" oncontextmenu="event.preventDefault();showContextMenu(event,${m.id})" onmousedown="longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600)" onmouseup="clearTimeout(longPressTimer)" ontouchstart="event.stopPropagation();longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600);_lastTouchX=event.touches[0].clientX;_lastTouchY=event.touches[0].clientY" ontouchend="clearTimeout(longPressTimer)" ontouchmove="clearTimeout(longPressTimer)">
        <div class="gc-row">
          <div class="gc-col">
            ${innerHtml}
          </div>
          ${uAv}
        </div>
      </div>`;
    }
    return `
      ${timeHtml} <div class="msg-group user" data-node-id="${m.id}" oncontextmenu="event.preventDefault();showContextMenu(event,${m.id})" onmousedown="longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600)" onmouseup="clearTimeout(longPressTimer)" ontouchstart="event.stopPropagation();longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600);_lastTouchX=event.touches[0].clientX;_lastTouchY=event.touches[0].clientY" ontouchend="clearTimeout(longPressTimer)" ontouchmove="clearTimeout(longPressTimer)">
        ${uAv ? `<div style="display:flex;gap:10px;align-items:flex-start;justify-content:flex-end;max-width:100%"><div style="display:flex;flex-direction:column;align-items:flex-end;min-width:0">${innerHtml}</div>${uAv}</div>` : innerHtml}
      </div>`;
  }

  // AI message
  if (m.isMulti && m.variants) {
    // 这里的特殊情况也加上时间，避免多变体 AI 消息漏掉时间
    return timeHtml + renderMultiMsg(m);
  }

  const streaming = m.streaming;
  const content   = m.content || '';
  const reasoning = m.reasoning || '';

  // Build bubble content: blocks (claude.ai style) or legacy thinking+content
  let bubbleInner = '';
  let voiceSegs = null;          // 正文被表情隔断的语音：一段文字一个语音条，表情单独一个气泡
  if (m.audio && !streaming) {
    // AI 发的语音条：气泡里就是语音条本身，正文（文字版）默认收起。
    // 思考链单独补在语音条上面 —— 不补的话语音消息是全场唯一没有 💭 的气泡。
    bubbleInner = thinkOnlyHtml(m) + renderVoiceBubble(m);
    voiceSegs = renderVoiceSegs(m);
  } else if (m.blocks?.length) {
    bubbleInner = renderBlocksHtml(m.blocks, streaming, m.thinkingSummary, m.memSummaries, m.thinkZh);
  } else {
    bubbleInner += legacyThinkHtml(reasoning, streaming, m.thinkingSummary, m.thinkZh);
    bubbleInner += (!streaming) ? renderRichText(content || '')
               : content     ? renderStreamingRichText(content)
               : `<img src="${CAT_GIF}" style="height:48px;width:auto;display:block;margin:4px 0;" alt="思考中">`;
  }

  // 换窗搬过来的 AI 消息：思考链被甩掉了，moodNote 是它的替身。
  // 画在气泡最上面、思考块原来的位置——她一眼就知道这条是搬过来的，
  // 以及当时标的是什么心境（而不是只有模型在暗地里收到）。
  const moodHtml = m.moodNote ? `<div class="mood-note">💭 当时的心境：${escHtml(m.moodNote)}</div>` : '';
  if (moodHtml) bubbleInner = moodHtml + bubbleInner;
  // 电话里说到一半被打断：存档里照实标一笔「说到哪、后面多少字没说出口」（11-camera-call.js）
  if (!voiceSegs && m.callCut && typeof callCutHtml === 'function') bubbleInner += callCutHtml(m);

  // 语音拆开之后，思考链和心境批注得自己找位置：它们是整条消息级的，只能挂一次。
  // 挂在第一个文字气泡上；消息以表情开头时另开一个气泡 —— 表情气泡是透明无内边距的，
  // 把折叠块塞进去会变成一坨浮在背景上的裸文字。
  if (voiceSegs) {
    const head = moodHtml + thinkOnlyHtml(m);
    if (head) {
      const i = voiceSegs.findIndex(s => s.type === 'text');
      if (i === 0) voiceSegs[0].html = head + voiceSegs[0].html;
      else voiceSegs.unshift({ type: 'text', html: head });
    }
  }

  // Model avatar
  const modelConf = state.configs.find(c => c.id === m.modelId);
  const modelColor = getModelColor(m.modelId || m.modelNickname);
  const modelInitial = escHtml((m.modelNickname || 'AI').slice(0,1).toUpperCase());
  const avatarInner = modelConf?.avatar
    ? `<img class="msg-avatar-img" src="${modelConf.avatar}" alt="${escHtml(m.modelNickname||'AI')}" onerror="this.style.display='none'">`
    : `<div class="msg-avatar-fallback" style="--mc:${modelColor}">${modelInitial}</div>`;   // 底色在 css 里跟主题底混（A33）
  // 续接消息头像位置留空但保留占位，不然第二条起会往左跳一格对不齐
  const avatarHtml = cont ? '' : avatarInner;

  // 群聊：头像在左 + 发言人名在气泡上方，续接的两样都不重复。
  // 单对话：不给头像，但**名字要留着**（用户的口径，工单原文写的是
  // 单聊连发言人 header 一起去掉）—— 沿用原来那行 .msg-label。
  const isGroup = isGroupMode;
  const senderLabel = !isGroup
    ? `<div class="msg-label">
        <span class="msg-label-dot" style="background:${modelColor}"></span>
        <span class="accent-text" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">${escHtml(m.modelNickname||'AI')}</span>
        ${state.memories.length?`<span class="memory-badge">记忆</span>`:''}
      </div>`
    : cont ? ''
    : `<div class="gc-sender-name" style="color:${modelColor}">${escHtml(m.modelNickname||'AI')}</div>`;

  // 表情包拆气泡：流式期间不拆（bubble-${m.id} 是 renderLiveBubble 的落点，
  // 内容每帧都在变，拆了会打架）。语音走 voiceSegs 那条自己的路 —— 气泡里是播放器不是文本，
  // 在渲染好的 HTML 上切会把播放器劈了，所以它是在合成时按正文切的。
  const segs = voiceSegs || ((!streaming && !m.audio) ? _splitStickerBubbles(bubbleInner) : null);
  const _chk = state.isSelectMode
    ? `<input type="checkbox" ${isSelected?'checked':''} onclick="toggleMessageSelection(${m.id},event)" style="width:16px;height:16px;accent-color:${accent};flex-shrink:0;margin-bottom:4px">`
    : '';
  // 头像在 .ai-avatar-col（气泡外），昵称和操作条在 .gc-col 首尾，
  // 所以多出来的气泡天然就不会重复头像/昵称/时间戳 —— 不用额外处理。
  const bubbleRowsHtml = segs
    ? segs.map((s, i) => `
          <div style="display:flex;align-items:flex-end;gap:10px${i ? ';margin-top:4px' : ''}">
            ${i === 0 ? _chk : (state.isSelectMode ? '<span style="width:16px;flex-shrink:0"></span>' : '')}
            <div class="bubble ai${s.type === 'sticker' ? ' bubble-sticker' : ''}"
                 ${i === 0 ? `id="bubble-${m.id}"` : ''} data-msg-id="${m.id}">${s.html}</div>
          </div>`).join('')
    : `
          <div style="display:flex;align-items:flex-end;gap:10px">
            ${_chk}
            <div class="bubble ai" id="bubble-${m.id}" data-msg-id="${m.id}">${bubbleInner}</div>
          </div>`;

  // AI 分支导航（当同一父节点下有多个 AI 回复时显示）
  const aiChat = getActiveChat();
  const aiSiblings = aiChat ? getChildrenOf(aiChat, m.parentId, 'ai') : [];
  const aiBranchIdx = aiSiblings.findIndex(s => s.id === m.id);
  const aiBranchHtml = aiSiblings.length > 1 ? `
    <div class="branch-switcher" style="margin-bottom:4px;align-self:flex-start">
      <button onclick="switchBranch(${m.id},-1)" ${aiBranchIdx===0?'disabled':''}
        title="上一个版本">◀</button>
      <span>${aiBranchIdx+1}/${aiSiblings.length}</span>
      <button onclick="switchBranch(${m.id},1)" ${aiBranchIdx===aiSiblings.length-1?'disabled':''}
        title="下一个版本">▶</button>
    </div>` : '';

  return `
    ${timeHtml}<div class="msg-group ai${cont ? ' gc-cont' : ''}" data-node-id="${m.id}" data-speaker="${escHtml(String(m.modelId ?? m.modelNickname ?? 'ai'))}" oncontextmenu="event.preventDefault();showContextMenu(event,${m.id})" onmousedown="longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600)" onmouseup="clearTimeout(longPressTimer)" ontouchstart="event.stopPropagation();longPressTimer=setTimeout(()=>showContextMenuAtMsg(${m.id}),600);_lastTouchX=event.touches[0].clientX;_lastTouchY=event.touches[0].clientY" ontouchend="clearTimeout(longPressTimer)" ontouchmove="clearTimeout(longPressTimer)">
      <div class="gc-row">
        <div class="ai-avatar-col">${avatarHtml}</div>
        <div class="gc-col">
          ${senderLabel}
          ${aiBranchHtml}
          ${bubbleRowsHtml}
          ${typeof renderSuggestionBubbles === 'function' ? renderSuggestionBubbles(m, aiChat) : ''}
          ${typeof renderReactions === 'function' ? renderReactions(m) : ''}
          <div class="msg-token-info">${m.tokens?`~${m.tokens} tokens`:''}</div>
          ${!state.isSelectMode?`
            <div class="msg-actions">
              ${msgFeedbackHtml(m)}
              <button class="msg-action-btn" data-ic="react" onclick="openReactionPicker(${m.id},event)">标注</button>
              <button class="msg-action-btn" data-ic="regen" onclick="regenerate(${m.id})">重新生成</button>
              <button class="msg-action-btn" data-ic="copy" onmousedown="event.preventDefault();grabCopySel(${m.id})" ontouchstart="copyBtnTouchStart(event,${m.id})" ontouchend="copyBtnTouchEnd(event,'${m.id}')" onclick="copyMsg('${m.id}')">复制</button>
              <button class="msg-action-btn${isFavMsg(m.id)?' on':''}" data-ic="fav" onclick="toggleFavMsg(${m.id})">${isFavMsg(m.id)?'已收藏':'收藏'}</button>
              <button class="msg-action-btn" data-ic="speak" onclick="toggleSpeak(${m.id})"><span class="ma-tts" id="tts-btn-${m.id}">🔊 朗读</span></button>
              <button class="msg-action-btn ma-del" data-ic="del" onclick="deleteSingleMessage(${m.id})">删除</button>
            </div>`:''}
        </div>
      </div>
    </div>`;
}

// 群聊里每个模型一个色：名字用它，没头像时的首字圆牌也用它（模型卡、记忆页同理）。
// 原来是六个满饱和的 Tailwind-500（#6366f1 #ec4899 #10b981 …），在深色底上一个比一个跳，
// 四个模型连着发言就是一排霓虹灯 —— 用户说的「区分太丑」。
// 换成色相均匀铺开、饱和度和亮度都统一压住的一组（S≈45% L≈72%）：
// 彼此还是一眼能分，但谁都不抢戏，也不会跟气泡的紫色主色打架。
function getModelColor(key) {
  const colors = ['#b8a5e0','#dfa6c8','#93cfae','#d4c084','#96c4d9','#d9a1a1'];
  if (!key) return colors[0];
  // 把 key 字符串转成一个数字，用来选颜色
  let hash = 0;
  for (let i = 0; i < String(key).length; i++) hash += String(key).charCodeAt(i);
  return colors[hash % colors.length];
}

function renderMultiMsg(m) {
  const chosen = m.chosenVariant ?? 0;
  const accent  = activeAccent();
  const variantHtml = m.variants.map((v, vi) => `
    <div class="resp-variant ${vi===chosen?'chosen':''}">
      <div class="resp-variant-header">
        <span class="resp-variant-label">${escHtml(v.modelNickname||'AI')}</span>
        <div class="resp-variant-actions">
          <span class="tok-pill">${v.tokens?`~${v.tokens} tok`:''}</span>
          <button class="resp-use-btn ${vi===chosen?'chosen':''}" onclick="chooseVariant(${m.id},${vi})">
            ${vi===chosen?'✓ 已选用':'使用此回复'}
          </button>
        </div>
      </div>
      <div style="font-size:14px;line-height:1.65;color:var(--text-primary)" id="variant-${m.id}-${vi}">${v.blocks?.length ? renderBlocksHtml(v.blocks, v.streaming, v.thinkingSummary, v.memSummaries, v.thinkZh) : (v.streaming ? renderStreamingRichText(v.content||'') : renderRichText(v.content||''))}</div>
    </div>`).join('');

  // AI 分支导航
  const mChat = getActiveChat();
  const mSiblings = mChat ? getChildrenOf(mChat, m.parentId, 'ai') : [];
  const mBranchIdx = mSiblings.findIndex(s => s.id === m.id);
  const mBranchHtml = mSiblings.length > 1 ? `
    <div class="branch-switcher" style="margin-bottom:4px;align-self:flex-start">
      <button onclick="switchBranch(${m.id},-1)" ${mBranchIdx===0?'disabled':''}
        title="上一个版本">◀</button>
      <span>${mBranchIdx+1}/${mSiblings.length}</span>
      <button onclick="switchBranch(${m.id},1)" ${mBranchIdx===mSiblings.length-1?'disabled':''}
        title="下一个版本">▶</button>
    </div>` : '';

  return `
    <div class="msg-group ai" data-node-id="${m.id}">
      <div class="msg-label">
        <span class="msg-label-dot"></span>
        <span class="accent-text" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">多模型对比</span>
        ${state.memories.length?`<span class="memory-badge">记忆</span>`:''}
      </div>
      ${mBranchHtml}
      <div class="multi-resp-wrapper">${variantHtml}</div>
      ${!state.isSelectMode?`
        <div class="msg-actions">
          <button class="msg-action-btn" data-ic="regen" onclick="regenerate(${m.id})">重新生成</button>
        </div>`:''}
    </div>`;
}

// ═══════════════════════════════════════════════════════
// MESSAGE ACTIONS
// ═══════════════════════════════════════════════════════
function getMessagePath(chat, nodeId) {
  const path = []; let cur = nodeId;
  while (cur) { const n = chat.nodes[cur]; if (!n) break; path.unshift(n); cur = n.parentId; }
  return path;
}

// 获取某个父节点下指定 role 的所有子节点（用于分支导航）
function getChildrenOf(chat, parentId, role) {
  return Object.values(chat.nodes).filter(n => n.parentId === parentId && n.role === (role || 'user'));
}

// 切换分支：给用户/AI消息选择哪个子分支
function switchBranch(nodeId, direction) {
  const chat = getActiveChat(); if (!chat) return;
  const node = chat.nodes[nodeId]; if (!node) return;
  const siblings = getChildrenOf(chat, node.parentId, node.role).sort((a, b) => a.id - b.id);
  const idx = siblings.findIndex(s => s.id === nodeId);
  const newIdx = Math.max(0, Math.min(siblings.length - 1, idx + direction));
  if (siblings[newIdx].id === nodeId) return;
  // 切分支 = 正念着的那条消息被换成了另一份内容，按钮跟着换人
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  // 找到新分支最深的 head（即沿 head 找到属于这个子树的最末节点）
  chat.headId = findDeepHead(chat, siblings[newIdx].id);
  save(); renderMessages(); _debouncedSidebarUpdate();
}

// 从某个节点开始，沿着已有的孤儿链（parentId 链）找到最深的叶节点
function findDeepHead(chat, startId) {
  // 找到所有以 startId 为根的子树叶节点（即没有其他节点以它为 parentId）
  let deepest = startId;
  // BFS
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    const children = Object.values(chat.nodes).filter(n => n.parentId === cur);
    if (children.length === 0) { deepest = cur; break; }
    // 优先选最新的子节点
    children.sort((a, b) => b.id - a.id);
    queue.push(children[0].id);
    deepest = children[0].id;
  }
  return deepest;
}


// 剪贴板兼容层：手机走 http 访问时页面不是安全上下文，navigator.clipboard 压根不存在，
// 直接调会同步抛错。这里回退成隐藏 textarea + execCommand('copy')，
// 并在复制完把用户原来的蓝色选区原样放回去（选 textarea 会顶掉页面选区）。
function copyTextCompat(text) {
  const fallback = () => new Promise((resolve, reject) => {
    const sel = window.getSelection();
    const saved = [];
    for (let i = 0; i < (sel ? sel.rangeCount : 0); i++) saved.push(sel.getRangeAt(i).cloneRange());
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (sel && saved.length) { sel.removeAllRanges(); saved.forEach(r => sel.addRange(r)); }
    ok ? resolve() : reject(new Error('copy failed'));
  });
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(fallback);
  return fallback();
}

// 手机端 ⎘：tap 的 click 阶段选区早被浏览器清了，所以 touchstart 抓选区、
// touchend 里 preventDefault 拦掉后续 click（顺带保住蓝色选区不被收掉）直接复制。
// 移动超过 10px 视为滚动手势，不当成点按。
let _copyTouchX = 0, _copyTouchY = 0;
function copyBtnTouchStart(e, nodeId) {
  grabCopySel(nodeId);
  const t = e.touches[0];
  _copyTouchX = t.clientX; _copyTouchY = t.clientY;
}
function copyBtnTouchEnd(e, nodeId) {
  const t = e.changedTouches[0];
  if (Math.abs(t.clientX - _copyTouchX) > 10 || Math.abs(t.clientY - _copyTouchY) > 10) return;
  e.preventDefault();
  copyMsg(nodeId);
}

// 复制按钮按下瞬间抓一次选区（点击 click 可能已经把高亮清掉，所以在 mousedown 抓）
let _copySelText = null;
function grabCopySel(nodeId) {
  const sel = window.getSelection();
  const s = sel && sel.toString().trim();
  if (s && sel.rangeCount) {
    const bubble = document.getElementById('bubble-' + nodeId);
    if (bubble && bubble.contains(sel.getRangeAt(0).commonAncestorContainer)) { _copySelText = s; return; }
  }
  _copySelText = null;
}
function copyMsg(nodeId) {
  let text = _copySelText;   // 有选区就只复制选区
  const wasSel = !!text;
  _copySelText = null;
  if (!text) {
    const chat = getActiveChat(); if (!chat) return;
    const node = chat.nodes[nodeId]; if (!node) return;
    text = node.variants ? (node.variants[node.chosenVariant??0]?.content||'') : node.content;
  }
  copyTextCompat(text).catch(() => {});
  showToast(wasSel ? '已复制选中文字' : '已复制', 'success');
}

// ═══════════════════════════════════════════════════════
// 收藏消息 (Favorites) & 文字转语音 (TTS)
// ═══════════════════════════════════════════════════════
function getMsgPlainText(node) {
  if (node.variants) {
    const v = node.variants[node.chosenVariant ?? 0];
    if (!v) return '';
    return v.blocks?.length ? v.blocks.filter(b => b.type !== 'thinking').map(b => b.text || '').join('\n') : (v.content || '');
  }
  if (node.blocks?.length) return node.blocks.filter(b => b.type !== 'thinking').map(b => b.text || '').join('\n');
  return node.content || '';
}

function isFavMsg(nodeId) {
  const chat = getActiveChat(); if (!chat) return false;
  return (state.favMessages || []).some(f => f.chatId === chat.id && f.nodeId === nodeId);
}

function toggleFavMsg(nodeId) {
  const chat = getActiveChat(); if (!chat) return;
  const node = chat.nodes[nodeId]; if (!node) return;
  state.favMessages = state.favMessages || [];
  const idx = state.favMessages.findIndex(f => f.chatId === chat.id && f.nodeId === nodeId);
  let nowFav;
  if (idx >= 0) {
    const gone = state.favMessages.splice(idx, 1)[0];
    // 跟 removeFav 一样留一条墓碑：同步推之前会跟云端按条合并（01-core 的 mergeFavLists），
    // 没墓碑的话云端那份还带着这条，下一次同步就把刚取消的收藏又并回来了
    if (gone) {
      if (!state.trash) state.trash = [];
      state.trash.push({ type: 'fav', favData: gone, deletedAt: new Date().toISOString() });
    }
    nowFav = false;
    showToast('已取消收藏');
  } else {
    const text = getMsgPlainText(node).replace(/\[\[.*?\]\]/g, '').trim();
    // 按 UTF-16 截 300 会把 emoji 劈成两半，留下半个代理对（\ud83d…）。
    // 云端（PostgREST）认定那不是合法 JSON，整包设置从此推不上去——而且一声不吭（09-30 实踩）
    let cut = text.length > 300 ? text.slice(0, 300) : text;
    if (cut !== text && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    state.favMessages.unshift({
      chatId: chat.id, nodeId, role: node.role,
      model: node.role === 'user' ? '我' : (node.modelNickname || 'AI'),
      chatTitle: chat.title,
      text: cut !== text ? cut + '…' : text,
      time: Date.now()
    });
    nowFav = true;
    showToast('★ 已收藏消息', 'success');
  }
  save();
  // 原地更新按钮文字，避免整页重渲染导致滚动跳动
  // 图标在 ::before 上（data-ic="fav"），这里只换字和 .on，写 textContent 不会冲掉图标
  document.querySelectorAll(`[data-node-id="${nodeId}"] .msg-action-btn`).forEach(b => {
    if (b.textContent.includes('收藏')) { b.textContent = nowFav ? '已收藏' : '收藏'; b.classList.toggle('on', nowFav); }
  });
  updateFavBadge();
}

// ── 👍 / 👎 ────────────────────────────────────────────────────────
// 这个反馈**不发给任何 AI 公司**，一个字节都不出这台机器：只写进本地那份
// state.chats（node.fb），然后作为「她喜欢/不喜欢这样的回复」进自己的系统提示。
// 它唯一的用处是让这个 AI 下次写得更像她想要的。
//
// ⚠️ 存在 node 上而不是 state 顶层，所以不用过那三道白名单（_doSave 是把
//    state.chats 整个 JSON 下去的，节点上多一个字段自动就持久化了）。
function msgFeedbackOf(node) {
  const v = node && Number(node.fb);
  return v === 1 || v === -1 ? v : 0;
}
function toggleMsgFeedback(nodeId, want) {
  const chat = getActiveChat(); if (!chat) return;
  const node = chat.nodes[nodeId]; if (!node) return;
  const cur = msgFeedbackOf(node);
  const next = cur === want ? 0 : want;     // 再点一次＝取消
  if (next) node.fb = next; else delete node.fb;
  node.fbAt = next ? Date.now() : undefined;
  if (!next) delete node.fbAt;
  save();
  // 原地换按钮，不整页重渲染（重渲染会把滚动位置顶掉，长对话里很难受）
  _paintFeedbackBtns(nodeId, next);
  if (next === 1) showToast('记下了，它会往这个方向写', 'success', 2000);
  else if (next === -1) showToast('记下了，它会避开这种写法', 'info', 2000);
  else showToast('取消了');
}
function _paintFeedbackBtns(nodeId, val) {
  document.querySelectorAll(`[data-node-id="${nodeId}"] .msg-fb-btn`).forEach(b => {
    const mine = Number(b.dataset.fb);
    b.classList.toggle('on', mine === val);
  });
}
// 按钮条。只给 AI 的消息挂 —— 给自己的话点赞没有意义。
function msgFeedbackHtml(m) {
  const v = msgFeedbackOf(m);
  return `<button class="msg-action-btn msg-fb-btn${v === 1 ? ' on' : ''}" data-fb="1"`
    + ` data-ic="up" aria-label="写得好" onclick="toggleMsgFeedback(${m.id},1)" title="这条写得好——只记在本地，用来影响它以后怎么写，不会发给任何 AI 公司"></button>`
    + `<button class="msg-action-btn msg-fb-btn${v === -1 ? ' on' : ''}" data-fb="-1"`
    + ` data-ic="down" aria-label="不对味" onclick="toggleMsgFeedback(${m.id},-1)" title="这条不对味——只记在本地，用来让它以后避开，不会发给任何 AI 公司"></button>`;
}

// 收集反馈，拼成提示词。**跨对话**收集：这是「她喜欢什么」的长期偏好，
// 只看当前这条对话的话，换个对话就等于失忆。
// 上限写死（条数 + 每条字数），不然读得越久这段越长，某天安静地把上下文顶爆
// —— 那个症状长得像记忆系统坏了，极难查（书架的 pulse 踩过同一个坑）。
function collectMsgFeedback(limit) {
  const cap = limit || 4;
  const up = [], down = [];
  const chats = (typeof state === 'object' && state && Array.isArray(state.chats)) ? state.chats : [];
  const all = [];
  for (const c of chats) {
    for (const n of Object.values((c && c.nodes) || {})) {
      if (n && n.role !== 'user' && msgFeedbackOf(n)) all.push(n);
    }
  }
  // 新的在前：偏好会变，最近的那几条更代表现在的她
  all.sort((a, b) => (Number(b.fbAt) || 0) - (Number(a.fbAt) || 0));
  for (const n of all) {
    const bucket = msgFeedbackOf(n) === 1 ? up : down;
    if (bucket.length >= cap) continue;
    let t = '';
    try { t = String(getMsgPlainText(n) || '').replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\s+/g, ' ').trim(); } catch (e) {}
    if (!t) continue;
    bucket.push(t.length > 90 ? t.slice(0, 90) + '…' : t);
    if (up.length >= cap && down.length >= cap) break;
  }
  return { up, down };
}
function feedbackPromptFor() {
  const empty = { stable: '', volatile: '' };
  if (typeof skillOn === 'function' && !skillOn('feedback')) return empty;
  // 能力说明进 stable：它不能跟着「此刻有没有反馈」时有时无，否则第一次点赞
  // 就改了 stable 段的结构，把后面所有历史的提示词缓存打穿（缓存那条记忆）。
  const stable = '\n\n[她的反馈] 她可以给你的每条回复点 👍 或 👎。'
    + '这个反馈只存在她自己的机器上，不会发给任何 AI 公司，也不是评分或考核——'
    + '它唯一的用处是告诉你她想要什么样的回复。看到 👍 的那几条就往那个方向写，'
    + '看到 👎 的就避开那种写法。别在回复里提这件事，也别为此道歉或反复确认。';
  const fb = collectMsgFeedback(4);
  if (!fb.up.length && !fb.down.length) return { stable, volatile: '' };
  let vol = '\n\n【她的反馈】\n';
  if (fb.up.length) vol += '👍 她喜欢这样的回复：\n' + fb.up.map(t => '· ' + t).join('\n') + '\n';
  if (fb.down.length) vol += '👎 她不喜欢这样的回复：\n' + fb.down.map(t => '· ' + t).join('\n') + '\n';
  return { stable, volatile: vol };
}

function updateFavBadge() {
  const badge = document.getElementById('favCountBadge');
  if (badge) badge.textContent = (state.favMessages || []).length;
}

/* 云同步落地后调这个。收藏面板开着的时候，合并会在用户眼皮底下换掉
   state.favGroups / favMessages，而 updateFavBadge 只改那个计数徽章、不重画列表：
   ① chip 上的下标是渲染那一刻算的，组列表一变，旧按钮就指到别的组上去了；
   ② 另一台设备新加的收藏本来也不会出现在已经开着的面板里。
   （① 是 Codex 二审提的，它看不到这两个函数所以只能存疑。） */
function refreshFavPanelIfOpen() {
  const modal = document.getElementById('favModal');
  if (!modal || modal.classList.contains('hidden')) return;
  // 当前筛选的组要是被合并掉了，退回“全部”，不然停在一个点不出来的空筛选上
  if (_favFilter !== '*' && _favFilter !== '' && !favGroupList().includes(_favFilter)) _favFilter = '*';
  _favPickerFor = -1;
  renderFavList();
}

function openFavPanel() {
  document.getElementById('favModal').classList.remove('hidden');
  renderFavList();
}
function closeFavPanel() { document.getElementById('favModal').classList.add('hidden'); }

// ── 收藏夹分组 ──────────────────────────────────────────────────
// 组名本身就是标识，没有单独的 id：跨设备合并时两端取并集即可，不用对 id。
// 空组也要能存在，所以组名单独存在 state.favGroups，而不是从收藏条目里现算 ——
// 后者会让"新建了一个还没往里放东西的组"一刷新就消失。
let _favFilter = '*';   // '*' = 全部，'' = 未分组，其余 = 具体组名
let _favPickerFor = -1; // 正在展开分组选择器的那条收藏（全集下标），-1 = 没有
let _favSearch = '';    // 只管界面筛选，不持久化；原收藏顺序和数据都不动

function _favSearchTerms() {
  return _favSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function favSearchActive() { return _favSearchTerms().length > 0; }
function favSearchHit(f) {
  const terms = _favSearchTerms();
  if (!terms.length) return true;
  const hay = [f.text, f.model, f.chatTitle, f.group]
    .filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}
// 搜索结果仍然来自用户/模型写下的文本：先转义，再一次性插入 mark，不能把原文当 HTML。
function favHi(text) {
  const h = escHtml(String(text == null ? '' : text));
  const terms = _favSearchTerms()
    .map(t => escHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return h;
  return h.replace(new RegExp(terms.join('|'), 'gi'), m => `<mark class="mem-hit">${m}</mark>`);
}
function setFavSearch(v) {
  _favSearch = String(v || '');
  _favPickerFor = -1;
  renderFavList();
}
function clearFavSearch() {
  _favSearch = '';
  const input = document.getElementById('favSearchInput');
  if (input) { input.value = ''; input.focus(); }
  renderFavList();
}

function favGroupList() { return state.favGroups || (state.favGroups = []); }

/* 新建/删除都要在 ops 表里给这个名字盖版本，云同步靠它区分"这边新建的"和
   "那边删掉的"（合并规则见 01-core，a >= d 即存活）。只抬一个全局版本号是不够的：
   两台设备从同一版本各改一次，版本号必然撞平，删除就会被并集复活。
   用计数器而不是时间戳，是为了不受设备时钟影响；合并时本机版本已经被抬到"见过的
   最大值"，所以这里 +1 一定压过见过的一切。 */
/* ⚠️ 无原型对象。组名是用户自由输入的，取名叫 `__proto__` 的话，`ops[name] = …`
   打的是 Object.prototype 上的 setter，压根不会建成自有属性 —— Object.keys 看不见它、
   JSON.stringify 也存不下，那个组就此消失，连带它下面的收藏被摘成未分组。全程零报错。
   （Codex 四审逮到的。） */
function _favGroupOps() {
  const old = state.favGroupOps;
  if (!old || Object.getPrototypeOf(old) !== null) {
    state.favGroupOps = Object.assign(Object.create(null), old || {});
  }
  return state.favGroupOps;
}
function _nextFavGroupVer() { return (state.favGroupsVer = (state.favGroupsVer || 0) + 1); }
function markFavGroupAdded(name) {
  const ops = _favGroupOps();
  ops[name] = { a: _nextFavGroupVer(), d: (ops[name] && ops[name].d) || 0 };
}
function markFavGroupRemoved(name) {
  const ops = _favGroupOps();
  ops[name] = { a: (ops[name] && ops[name].a) || 0, d: _nextFavGroupVer() };
}

// 带着全集下标一起往下传。列表渲染的是过滤后的子集，而 removeFav / jumpToFav /
// copyFav 全都按 state.favMessages 的下标操作 —— 要是直接用子集下标，
// 一旦筛选到某个分组就会删错条目，且只在筛选状态下才犯，极难复现。
function _favEntries() {
  return (state.favMessages || [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => _favFilter === '*' ? true
      : _favFilter === '' ? !f.group
      : f.group === _favFilter)
    .filter(({ f }) => favSearchHit(f));
}

function setFavFilter(g) { _favFilter = g; _favPickerFor = -1; renderFavList(); }

/* ⚠️ 组名是用户自由输入的，绝不许拼进 onclick 里 —— 哪怕先 JSON.stringify 再把 "
   换成 &quot; 也不行：属性值里的实体是浏览器**解析属性时**就解掉的，所以组名自己
   带的 &quot; 会被解成真正的引号，把字符串literal提前收尾。取名叫
   `&quot;);alert(1);//` 的组，点一下就执行了。（Codex 审出来的。）
   下面这几个 *At 包装只往事件代码里放数字下标，从根上没有可注入的位置。
   -1 表示"未分组 / 移出分组"，-2 表示"全部"。 */
function _favGroupAt(gi) { return gi >= 0 ? favGroupList()[gi] : (gi === -1 ? '' : '*'); }
function setFavFilterAt(gi) { const g = _favGroupAt(gi); if (g !== undefined) setFavFilter(g); }
function setFavItemGroupAt(i, gi) { const g = _favGroupAt(gi); if (g !== undefined && g !== '*') setFavItemGroup(i, g); }
function deleteCurrentFavGroup() { if (_favFilter !== '*' && _favFilter !== '') deleteFavGroup(_favFilter); }

// 新建分组：就地用输入框，不走 prompt() —— 安卓 WebView 里那是系统弹层，
// 改不动样式，跟深色界面完全脱节（见 android-webview-native-select 那条）。
function submitNewFavGroup(input) {
  const name = (input.value || '').trim();
  if (!name) { input.value = ''; return; }
  if (name.length > 20) { showToast('分组名最多 20 个字', 'error'); return; }
  const groups = favGroupList();
  if (!groups.includes(name)) { groups.push(name); markFavGroupAdded(name); save(); }
  input.value = '';
  setFavFilter(name);
}

// 删组只删这个"分类"，不动里面的收藏 —— 它们回到未分组。
// 收藏本身要删得走 removeFav（那条才进回收站）。
function deleteFavGroup(name) {
  const groups = favGroupList();
  const at = groups.indexOf(name);
  if (at < 0) return;
  groups.splice(at, 1);
  let moved = 0;
  (state.favMessages || []).forEach(f => { if (f.group === name) { delete f.group; moved++; } });
  markFavGroupRemoved(name);
  save();
  if (_favFilter === name) _favFilter = '*';
  renderFavList();
  showToast(moved ? `已删掉分组，${moved} 条收藏回到未分组` : '已删掉分组');
}

function toggleFavGroupPicker(i) {
  _favPickerFor = _favPickerFor === i ? -1 : i;
  renderFavList();
}

function setFavItemGroup(i, name) {
  const f = (state.favMessages || [])[i];
  if (!f) return;
  if (name) f.group = name; else delete f.group;
  _favPickerFor = -1;
  save(); renderFavList();
  showToast(name ? `已归入「${name}」` : '已移出分组');
}

function renderFavGroupBar() {
  const favs = state.favMessages || [];
  const groups = favGroupList();
  const countOf = g => g === '*' ? favs.length
    : g === '' ? favs.filter(f => !f.group).length
    : favs.filter(f => f.group === g).length;
  // gi 是往事件代码里放的下标（见 _favGroupAt）；g 只用来算选中态和计数，不进 HTML。
  const chip = (gi, g, label) => `<button class="fav-chip${_favFilter === g ? ' active' : ''}" onclick="setFavFilterAt(${gi})">${escHtml(label)}<span class="fav-chip-n">${countOf(g)}</span></button>`;
  const ungrouped = countOf('');
  return `<div class="fav-group-bar">
    ${chip(-2, '*', '全部')}
    ${ungrouped || !groups.length ? chip(-1, '', '未分组') : ''}
    ${groups.map((g, gi) => chip(gi, g, g)).join('')}
    <span class="fav-newgroup">
      <input type="text" placeholder="+ 新分组" maxlength="20"
        onkeydown="if(event.key==='Enter'){event.preventDefault();submitNewFavGroup(this)}"
        onblur="submitNewFavGroup(this)">
    </span>
    ${_favFilter !== '*' && _favFilter !== '' ? `<button class="fav-chip fav-chip-del" onclick="deleteCurrentFavGroup()" title="只删分组，里面的收藏会回到未分组">✕ 删掉「${escHtml(_favFilter)}」</button>` : ''}
  </div>`;
}

function renderFavList() {
  const box = document.getElementById('favList');
  const favs = state.favMessages || [];
  if (!favs.length) {
    box.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:30px 0">还没有收藏的消息 (´･ω･`)<br>在消息下方点「收藏」即可保存到这里</div>';
    return;
  }
  const entries = _favEntries();
  const bar = renderFavGroupBar();
  const scopedTotal = favs.filter(f => _favFilter === '*' ? true
    : _favFilter === '' ? !f.group
    : f.group === _favFilter).length;
  const searchCount = favSearchActive()
    ? `<div class="mem-search-count">找到 ${entries.length} 条 <span>（当前范围共 ${scopedTotal} 条）</span></div>`
    : '';
  if (!entries.length) {
    box.innerHTML = bar + searchCount + (favSearchActive()
      ? `<div class="memory-empty">没有收藏匹配「${escHtml(_favSearch.trim())}」<br><span style="font-size:11px;color:var(--text-muted)">会同时搜索正文、模型、对话和分组；多个词都要出现</span></div>`
      : '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:30px 0">这个分组还是空的<br>在别的收藏上点「⊞ 分组」就能挪进来</div>');
    return;
  }
  box.innerHTML = bar + searchCount + entries.map(({ f, i }) => `
    <div class="memory-item fav-item" onclick="jumpToFav(${i})">
      <div class="fav-meta">
        <span class="fav-meta-model">${favHi(f.model || '')}</span>
        <span class="fav-meta-src">${favHi(f.chatTitle || '')} · ${new Date(f.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        ${f.group ? `<span class="fav-tag">${favHi(f.group)}</span>` : ''}
      </div>
      <div class="fav-acts">
        <button class="fav-act" onclick="event.stopPropagation();jumpToFav(${i})" title="跳回源对话里的这条消息">↩ 定位</button>
        <button class="fav-act" onclick="event.stopPropagation();toggleFavGroupPicker(${i})" title="把这条收藏归到某个分组">⊞ 分组</button>
        <button class="fav-act" onclick="event.stopPropagation();copyFav(${i},this)">复制</button>
        <button class="fav-act danger" onclick="event.stopPropagation();removeFav(${i})">删除</button>
      </div>
      <div class="memory-text" style="font-size:13px;white-space:pre-wrap;word-break:break-word">${favHi(f.text)}</div>
      ${_favPickerFor === i ? `<div class="fav-picker" onclick="event.stopPropagation()">
        <span class="fav-picker-label">归入</span>
        ${favGroupList().map((g, gi) => `<button class="fav-chip${f.group === g ? ' active' : ''}" onclick="setFavItemGroupAt(${i},${gi})">${escHtml(g)}</button>`).join('')}
        ${f.group ? `<button class="fav-chip" onclick="setFavItemGroupAt(${i},-1)">移出分组</button>` : ''}
        ${favGroupList().length ? '' : '<span class="fav-picker-empty">还没有分组，先在上面新建一个</span>'}
      </div>` : ''}
    </div>`).join('');
}

// 在收藏面板里点「删除」——也进本地回收站，可在回收站的「收藏」分类里找回。
// （源消息被删而连带失效的收藏走 pruneDeadFavs，同样进回收站。）
function removeFav(i) {
  const f = state.favMessages[i];
  state.favMessages.splice(i, 1);
  if (f) {
    if (!state.trash) state.trash = [];
    state.trash.push({ type: 'fav', favData: f, deletedAt: new Date().toISOString() });
    showToast('已移入回收站');
  }
  save(); renderFavList(); updateFavBadge();
  // 源消息还显示在当前对话里的话，把它的「已收藏」按钮同步改回「收藏」（星是 ::before 图标，跟着 .on 换实心/空心）
  if (f) document.querySelectorAll(`[data-node-id="${f.nodeId}"] .msg-action-btn`).forEach(b => {
    if (b.textContent.includes('收藏')) { const on = isFavMsg(f.nodeId); b.textContent = on ? '已收藏' : '收藏'; b.classList.toggle('on', on); }
  });
}

// 复制收藏的消息：源消息还在就复制完整原文，源没了就复制收藏时保存的摘要
function copyFav(i, btn) {
  const f = state.favMessages[i]; if (!f) return;
  const node = state.chats.find(c => c.id === f.chatId)?.nodes?.[f.nodeId];
  const text = node ? getMsgPlainText(node).replace(/\[\[.*?\]\]/g, '').trim() : f.text;
  copyTextCompat(text).then(() => {
    if (btn) { const o = btn.textContent; btn.textContent = '✓ 已复制'; setTimeout(() => { btn.textContent = o; }, 1400); }
  }).catch(() => showToast('复制失败，浏览器不支持剪贴板', 'error'));
}

// 点收藏条目 → 跳回源对话的源消息。
// 收藏面板会被 Hub 搬进 #hubContent（openHubSection），这时候只 closeFavPanel()
// 是白关的：favModal 早就是个空壳，Hub 遮罩还盖在聊天上，定位滚动全发生在遮罩背后，
// 看起来就是「定位功能不见了」。所以两个容器都得关。
function jumpToFav(i) {
  const f = state.favMessages[i]; if (!f) return;
  const chat = state.chats.find(c => c.id === f.chatId);
  if (!chat) { showToast('源对话已删除 (´•̥ ω •̥`)', 'error'); return; }
  if (!chat.nodes?.[f.nodeId]) { showToast('源消息已删除 (´•̥ ω •̥`)', 'error'); return; }
  const hub = document.getElementById('hubModal');
  if (hub && !hub.classList.contains('hidden')) closeHub();
  closeFavPanel();
  const sameChat = state.activeChatId === chat.id;
  if (!sameChat) switchChat(chat.id);
  setTimeout(() => {
    let ok = false;
    try { ok = scrollToMessage(f.nodeId); } catch {}
    // 消息在别的分支上时根本没渲染，滚不过去——给个说法，别静默失败
    if (!ok) showToast('源消息在这个对话的另一条分支里，切到那条分支才能看到', 'error');
  }, sameChat ? 60 : 350);
}

// 源消息/源对话被删除时，同步取消对应收藏。
// 收藏不再被直接丢弃——源消息本身进了回收站是可恢复的，收藏却永久消失，
// 用户看来就是"收藏莫名其妙自己没了"。现在一并进回收站，可单独恢复；
// 若源对话整段被恢复，restoreChatFavs() 会把它们连带复活。
function pruneDeadFavs() {
  if (!state.favMessages?.length) return;
  if (!state.trash) state.trash = [];
  const alive = [], dead = [];
  state.favMessages.forEach(f => {
    const chat = state.chats.find(c => c.id === f.chatId);
    (chat && chat.nodes?.[f.nodeId] ? alive : dead).push(f);
  });
  if (!dead.length) return;
  state.favMessages = alive;
  dead.forEach(f => {
    state.trash.push({ type: 'fav', favData: f, deletedAt: new Date().toISOString() });
  });
  updateFavBadge();
  showToast(`已把 ${dead.length} 条收藏移入回收站（源消息被删除）`);
}

// 整段对话从回收站恢复时，把它名下的收藏也复活。
// 恢复对话会重新分配 chat/node id，所以收藏要按 oldToNew 映射改写后再放回。
function restoreChatFavs(oldChatId, newChatId, oldToNew) {
  if (!state.trash?.length) return 0;
  state.favMessages = state.favMessages || [];
  const revived = [];
  state.trash = state.trash.filter(t => {
    if (t.type !== 'fav' || t.favData?.chatId !== oldChatId) return true;
    const newNodeId = oldToNew[t.favData.nodeId];
    if (!newNodeId) return true;   // 该消息没跟着回来，收藏留在回收站
    revived.push({ ...t.favData, chatId: newChatId, nodeId: newNodeId });
    return false;
  });
  if (revived.length) {
    state.favMessages.unshift(...revived);
    updateFavBadge();
  }
  return revived.length;
}

// ── 👁 鬼味模式：AI 黑化/被激怒时的黑红恐怖 UI（不持久化，刷新即恢复）──
function hauntOn() {
  if (document.body.classList.contains('haunted')) return;
  document.body.classList.add('haunted');
  if (!document.getElementById('hauntOverlay')) {
    const ov = document.createElement('div'); ov.id = 'hauntOverlay';
    document.body.appendChild(ov);
  }
  if (!document.getElementById('hauntEscape')) {
    const btn = document.createElement('button'); btn.id = 'hauntEscape';
    btn.textContent = '🕯 驱散';
    btn.title = '点燃蜡烛，赶走不干净的东西';
    btn.onclick = () => { hauntOff(); showToast('🕯 烛光亮起，房间恢复了平静……', 'success'); };
    document.body.appendChild(btn);
  }
  applyAccentCSS('#b00202');
  showToast('👁 界面好像……被什么东西入侵了', 'error', 3500);
}
