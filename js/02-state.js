let state = {
  chats: [ { id: nextId(), title: '崭新の对话', nodes: {}, headId: null,
              isPinned: false, activeModelIds: null, msgLimit: 0,
              isGroupChat: false, totalTokens: 0 } ],
  activeChatId: null,
  configs: [ { id: 1, nickname: '聪明助手', modelName: 'deepseek-chat', apiKey: '',
                apiBase: 'https://api.deepseek.com/v1', temp: 0.7,
                maxTokens: 2048, maxReplyTokens: 1024,
                avatar: '', persona: '', thinkingMode: 'auto' },
              { id: 2, nickname: '订阅 Claude', modelName: 'claude-local', apiKey: '',
                apiBase: 'http://127.0.0.1:8000', temp: 0.7,
                maxTokens: 8000, maxReplyTokens: 4096,
                avatar: '', persona: '', thinkingMode: 'auto', isLocalClaude: true },
              { id: 3, nickname: '订阅 GPT', modelName: 'gpt-local', apiKey: '',
                apiBase: 'http://127.0.0.1:3000', temp: 0.7,
                maxTokens: 8000, maxReplyTokens: 4096,
                avatar: '', persona: '', thinkingMode: 'always', thinkingDefaultMigrated: true, isLocalGpt: true } ],
  // ⚠️ Gemini 那条**故意不放在这张默认表里**，由 ensureGeminiConfig() 在她第一次点
  //   「✦ Gemini」时才建。放进来的话，全新安装的第一个对话 activeModelIds 是 null
  //   = 全选所有 config，发一句话会同时收到四份回复 —— 多出来的那份谁都没要。

  /* configs 的跨设备版本号。**逻辑计数器，不是时间戳** —— 时钟快的那台会长期压住
     另一台，favGroups / stickerGroups 两处注释里都躺着这个坑，别改成 Date.now()。
     每次 configs 真的变了（_doSave 里按内容比对）+1，云端合并时大的赢。

     初值 **-1 而不是 0**，这一位专门表示「这台机器还没有自己的 configs」：
     从 IDB 读到过就至少是 0，云端任何一份（≥0）都压得过 -1，所以全新设备
     第一次登录仍然能把云端那套模型配置整包拉下来。写成 0 的话，新设备会被
     出厂默认的三条空配置卡住，永远拉不到她真正的 API Key。 */
  configsVer: -1,
  memories: [], recentMemos: [], autoMemory: false,
  moments: [],
  background: '', brightness: 0.88, bgBlur: 3, uiBlur: 28, accentColor: '#c89555', bgAutoTint: false,
  // 浅色壁纸的文字底衬：'auto'（按合成亮度自动判）/ 'on' / 'off'
  bgLegibility: 'auto',
  themeTemperature: 'warm', fontPreset: 'simsun', uiShape: 'soft',
  // 自己调的背景色 / 字色，'' = 跟色温预设走。见 effectiveTheme()
  customBg: '', customText: '',
  // 空页面那个差值大字的透明度，0~1，1 = 原样
  echoOpacity: 1,
  aiFontSize: 17, userFontSize: 17, webSearchApiKey: '', tenorApiKey: '', thinkSumKey: '', voiceApiKey: '', voiceProvider: 'deepgram', voiceApiBase: '', voiceModel: '', callBg: '',
  sidebarOpen: !isMobileLayout(),
  isSelectMode: false, selectedMessageIds: new Set(),
  chatSelectMode: false, selectedChatIds: new Set(),
  trashFilter: 'all',
  convSettingsOpen: false, trash: [],
  // 删掉的对话 id → 墓碑。见文件里 markChatDeleted 那段的长注释
  deletedChats: {},
  // 手环数据自动同步：默认关（电脑端那条链路会对连着的手机跑 adb）。只存本机、不上云 ——
  // 开不开取决于这台设备连的是哪个 server，换台设备不该跟着开。
  bandAutoFetch: false,
  bandAiEnabled: true, ccMemoryEnabled: false, callDnd: false, userAvatar: '', showUserAvatar: false, inkStream: true, inkRate: 14, favMessages: [], favGroups: [], favGroupsVer: 0, favGroupOps: {},
  typingRhythmEnabled: true, typingDraftPeek: false,
  userName: '', userNameAiVisible: true, stickerNotes: {},
  // 「这张不给 AI 用」：表情名 → { off, v }。没有这一条 = 给 AI 用（老数据零变化）。见 10-stickers-voice.js
  stickerAiOff: {},
  // 表情包分组：用户自建的那些栏（磁盘上的包不在这里，那是 stickers-packs/ 扫出来的）
  stickerGroups: [], stickerGroupOf: {}, stickerGroupsVer: 0, stickerGroupOps: {},
  /* 思考链默认糊着：false 才是出厂状态。
     ver 是逻辑计数器（跨设备合并用，不是时间戳，见 _mergeThinkOpen）。 */
  thinkOpen: false, thinkOpenVer: 0,
  brainMemories: [],
  // 普鲁斯特池：瞬间本身，加上几个闸门的计数（谁、什么时候、今天想起过几次）
  proustMems: [], proustEnabled: true, proustLastAt: 0, proustCount: 0, proustDay: '', proustRecent: [], proustLastActive: 0,
  // 偷看屏幕：默认关（会一直拍你的屏幕，必须你自己点开），外加冷却/今天看过几次
  peekEnabled: false, peekLastAt: 0, peekCount: 0, peekDay: '',
  movieChimeMin: 4,             // 通话一起看时它自己插嘴：最多几分钟一次（0 = 不插嘴，下限 2 分钟写死在 23-peek.js）
  callBargeMode: 'auto',        // 通话里用嗓子打断：auto（认耳机/外放）/ headset / speaker / off（只能点按钮）
  callNudgeOff: false,          // 通话里你安静十来秒，它可以自己决定开不开口；true = 不主动开口
  // 生命体征：每个模型各有自己的情绪/身体状态。状态默认开；自主心跳会主动发消息，默认必须手动放行。
  vitalsOn: true, vitalsHeartbeatOn: false, vitalsByModel: {},
  // 生物钟跟着的作息：manual=false 时从手环/消息推；at 是改设置的时刻，跨设备按它挑新的
  vitalsSleepPref: { manual: false, start: 150, end: 570, at: 0 },
  // 梦境独立于聊天/记忆：梦与闸门按模型隔离，永不进入普通检索或摘要。
  dreamsOn: false, dreamsByModel: {}, dreamGateByModel: {}, dreamMaterialCooldowns: {},
  ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsVoiceZh: 'zh-CN-XiaoxiaoNeural', ttsRate: 0, ttsPitch: 0,
  /* 技能开关：存「关掉的」而不是「开着的」（见 05-prompts-api.js 的 SKILL_DEFS）。
     默认空对象 = 全开，老数据不用迁移，将来新增的技能也自动是开的。
     ⚠️ 持久化三道关：这里的初值、_doSave 的写、loadStateFromDB 的读、14 的启动赋值，
     漏一道就是「设置里关掉了、刷新回来又全开」，而且零报错。 */
  skillsOff: {},
  wishbook: [],
  // 世界书（60-worldbook.js）：条目聊到了才翻出来。跟着云同步走（按条合并，带墓碑）
  worldbook: { on: true, budget: 2000, depth: 2, ver: 0, entries: [], del: {} },
  // 跑腿（61-errand.js）：谁来跑。'' = 自动（DeepSeek 优先，其次 Gemini），'deepseek' 或某个配置的 id。
  // 只存本机，不上云：配置 id 在另一台设备上不一定对得上同一个东西。
  errandWorker: '',
};
let _saveTimer, _cloudSyncTimer;

// 🛡️ 备份机制：多槽滚动 + 防回退 + 高水位安全槽
// 事故背景（2026-07-15）：以前只有一个槽 kuro_chats_backup，且只要 length>0 就写。
// 当本地对话数因 bug 骤减，那份唯一的好备份会被"变小后的快照"覆盖，救不回来。
// 现在三层防御：
//   ① 滚动环 kuro_backup_ring：保留最近 N 份带时间戳的快照（时间旅行）。
//   ② 高水位安全槽 kuro_chats_safe：只被"更完整（消息数≥）"的快照替换，回退时打死不覆盖。
//   ③ 防回退：新状态比高水位显著变少时，不写滚动槽、只告警，避免把好备份冲成小的。
// kuro_chats_backup / kuro_backup_time 保留为"最新滚动槽"，兼容旧的 restore/showInfo 入口。
const BACKUP_RING_MAX = 6;      // 滚动环保留几份
const BACKUP_REGRESS_RATIO = 0.8;  // 新消息数 < 高水位 * 0.8 视为可疑
const BACKUP_REGRESS_MIN_DROP = 5; // 且绝对少了 >=5 条消息才算（避免小改动误报）
let _backupTimer = null;
let _lastBackupWarnAt = 0;

function chatsMsgCount(chats) {
  return (chats || []).reduce((s, c) => s + Object.keys(c && c.nodes || {}).length, 0);
}

// 把一份快照写进滚动环，并裁掉超出 N 的旧槽
async function _pushBackupRing(ts, json, meta) {
  await idbSet('kuro_backup_slot_' + ts, json);
  let ring;
  try { ring = JSON.parse(await idbGet('kuro_backup_ring') || '[]'); } catch { ring = []; }
  if (!Array.isArray(ring)) ring = [];
  ring = ring.filter(r => r && r.ts !== ts);
  ring.unshift({ ts, chatCount: meta.chatCount, msgCount: meta.msgCount, size: json.length });
  while (ring.length > BACKUP_RING_MAX) {
    const drop = ring.pop();
    if (drop && drop.ts) { try { await idbDel('kuro_backup_slot_' + drop.ts); } catch {} }
  }
  await idbSet('kuro_backup_ring', JSON.stringify(ring));
}

// 核心写入：手动/自动共用。manual=true 时无视回退保护、必写滚动槽（用户显式意图）。
// snap：_doSave 刚拍下的那份（见 SAVE SECTION 的 _serializeChats）。给了就直接用它的
// 字符串和计数，省掉整份对话再序列化一遍；没给（手动备份 / 快照对不上）就现算。
async function _writeBackup(chats, { manual = false, snap = null } = {}) {
  if (!chats || chats.length === 0) return { skipped: true };
  const json = snap ? snap.json : JSON.stringify(chats);
  const msgCount = snap ? snap.msgCount : chatsMsgCount(chats);
  const chatCount = snap ? snap.chatCount : chats.length;
  const now = new Date().toISOString();

  // 读高水位安全槽
  let safe = null;
  try { safe = JSON.parse(await idbGet('kuro_safe_meta') || 'null'); } catch { safe = null; }

  // 判回退：和高水位比，消息显著变少、或整段对话丢失
  let regressed = false;
  if (safe) {
    const msgDrop = safe.msgCount - msgCount;
    const chatDrop = safe.chatCount - chatCount;
    regressed =
      (msgDrop >= BACKUP_REGRESS_MIN_DROP && msgCount < safe.msgCount * BACKUP_REGRESS_RATIO) ||
      (chatDrop >= 1 && msgDrop >= BACKUP_REGRESS_MIN_DROP);
  }

  if (regressed && !manual) {
    // 打死不覆盖好备份：只告警（限流），高水位安全槽和最新滚动槽都保持原样
    const nowMs = Date.now();
    if (nowMs - _lastBackupWarnAt > 60000) {
      _lastBackupWarnAt = nowMs;
      if (typeof showToast === 'function') {
        showToast(`⚠️ 检测到对话可能异常减少（${safe.msgCount}→${msgCount} 条），已冻结自动备份保护好数据。可在设置→恢复备份 找回`, 'error', 6000);
      }
      console.warn('🛡️ 备份回退保护触发：', { safe, now: { chatCount, msgCount } });
    }
    return { regressed: true, safe, now: { chatCount, msgCount } };
  }

  // 正常/增长/手动：写最新滚动槽 + 环
  await idbSet('kuro_chats_backup', json);
  await idbSet('kuro_backup_time', now);
  await _pushBackupRing(now, json, { chatCount, msgCount });

  // 高水位安全槽：只被更完整的快照替换（消息数 >= 现有），回退时永不降级
  if (!safe || msgCount >= safe.msgCount) {
    await idbSet('kuro_chats_safe', json);
    await idbSet('kuro_safe_meta', JSON.stringify({ ts: now, chatCount, msgCount, size: json.length }));
  }
  return { written: true, chatCount, msgCount };
}

function createBackup() {
  clearTimeout(_backupTimer);
  _backupTimer = setTimeout(async () => {
    try {
      const snap = _chatsSnapFor(state.chats);
      await _writeBackup(state.chats, { manual: false, snap });
      if (snap) snap.json = null;   // 用完就放掉：整份对话可能 10MB+，别在内存里一直多攥一份
    }
    catch (e) { console.warn('备份失败:', e); }
  }, 5000); // 5秒后备份
}

// 💾 整份存档落硬盘（server/state-snapshot.js 收，存到 data-backups/state-daily/）
// 上面那套备份存在同一个 IndexedDB 里——2026-10-10 IndexedDB 被硬杀 exe 弄得整个重建时它跟着一起没了，
// 只存本机的猫爪日报、梦、单词卡最后是从 8 月的旧备份里一点点捡回来的。这份跟 IndexedDB 分开放。
// 只在电脑本机的页面上跑（手机连过来的话 server 也会拒，但几十 MB 白传一趟不值）。
// 滚动槽 / 聊天备份槽跟 kuro_chats 是重复的，不带。
// kuro_cloud_cache / kuro_cloud_vermemo 是云端设置的本机缓存和指纹表（01-core 的 _cloudCacheFlush），云端就有，不带。
const STATE_SNAPSHOT_SKIP = /^kuro_(backup_slot_|chats_backup$|chats_safe$|cloud_cache$|cloud_vermemo$)/;
async function stateSnapshotToDisk() {
  if (typeof location === 'undefined' || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return { skipped: 'not-local' };
  const db = await openDB();
  const data = await new Promise((res, rej) => {
    const out = {}, st = db.transaction(STORE).objectStore(STORE);
    const r = st.openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      if (typeof c.key === 'string' && !STATE_SNAPSHOT_SKIP.test(c.key)) out[c.key] = c.value;
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
  // 存档还没读进来（刚启动 / 读失败）时 kuro_chats 都没有，这种快照没意义
  if (!data.kuro_chats) return { skipped: 'no-chats' };
  const src = /Electron/i.test(navigator.userAgent || '') ? 'exe' : 'web';
  const body = JSON.stringify({ v: 1, at: new Date().toISOString(), src, data });
  const r = await fetch('/api/state-snapshot?src=' + src, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  if (!r.ok) return { skipped: 'http-' + r.status };   // 旧 exe 还没这个接口时是 404，安静跳过
  return r.json();
}
function stateSnapshotSchedule() {
  const run = () => stateSnapshotToDisk().then(r => {
    if (r && r.shrunk) console.warn('💾 存档快照比上一份小了一半以上，另存了一份，没覆盖好的那份:', r.file);
  }).catch(e => console.warn('💾 存档快照没存上:', e && e.message));
  setTimeout(run, 90 * 1000);              // 启动 90 秒后（存档读完、云端拉完）存一份
  setInterval(run, 6 * 60 * 60 * 1000);    // 之后每 6 小时一份，同一天的覆盖
}

function save(){
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 800); // 800ms debounce — less thrashing
  createBackup(); // 同时触发备份
}

// ═══════════════════════════════════════════════════════
// BACKUP & RESTORE FUNCTIONS
// ═══════════════════════════════════════════════════════
async function manualBackup() {
  try {
    if (!state.chats || state.chats.length === 0) {
      showToast('⚠️ 没有聊天记录需要备份', 'error', 2500);
      return;
    }
    // 手动备份是用户显式意图：无视回退保护，必写滚动槽
    await _writeBackup(state.chats, { manual: true });
    showToast(`✓ 已备份 ${state.chats.length} 个对话`, 'success', 2500);
  } catch (e) {
    console.error('手动备份失败:', e);
    showToast('✕ 备份失败: ' + e.message, 'error', 3000);
  }
}

// 汇总所有可用备份来源（最新槽 + 高水位安全槽 + 滚动环），按完整度排序，
// 每个来源附带解析出的 chats、时间、消息/对话数。
async function collectBackups() {
  const out = [];
  const seenTs = new Set();
  const add = async (json, ts, label) => {
    if (!json) return;
    try {
      const chats = JSON.parse(json);
      if (!Array.isArray(chats) || chats.length === 0) return;
      const key = (ts || '') + '|' + json.length;
      if (seenTs.has(key)) return;
      seenTs.add(key);
      out.push({ label, ts, chats, chatCount: chats.length, msgCount: chatsMsgCount(chats), size: json.length });
    } catch {}
  };
  await add(await idbGet('kuro_chats_backup'), await idbGet('kuro_backup_time'), '最新');
  await add(await idbGet('kuro_chats_safe'), (JSON.parse(await idbGet('kuro_safe_meta') || 'null') || {}).ts, '安全槽(最完整)');
  let ring = [];
  try { ring = JSON.parse(await idbGet('kuro_backup_ring') || '[]'); } catch {}
  for (const r of (Array.isArray(ring) ? ring : [])) {
    await add(await idbGet('kuro_backup_slot_' + r.ts), r.ts, '滚动槽');
  }
  return out;
}

async function restoreFromBackup() {
  const all = await collectBackups();
  if (all.length === 0) {
    showToast('⚠️ 未找到备份数据', 'error', 2500);
    return;
  }

  // 默认恢复"最完整"的一份：消息数优先，其次对话数，其次最近时间
  all.sort((a, b) => b.msgCount - a.msgCount || b.chatCount - a.chatCount || (b.ts || '').localeCompare(a.ts || ''));
  const best = all[0];
  const timeStr = best.ts ? new Date(best.ts).toLocaleString('zh-CN') : '未知时间';

  if (!confirm(`确定从备份恢复聊天记录吗？\n\n将恢复最完整的一份【${best.label}】\n备份时间: ${timeStr}\n对话 ${best.chatCount} 个 · 消息 ${best.msgCount} 条\n（共 ${all.length} 份备份可用）\n\n⚠️ 这会替换当前的聊天记录！`)) {
    return;
  }

  try {
    const backupChats = best.chats;
    if (!backupChats || backupChats.length === 0) {
      showToast('⚠️ 备份数据为空', 'error', 2500);
      return;
    }

    state.chats = backupChats;
    state.activeChatId = backupChats[0]?.id || null;

    // 重新计算ID计数器——对话 id / 消息 id / 配置 id 一起播种（别再漏对话 id），并修掉撞 id 的对话
    _nodeIdCounter = 0;
    reseedIdCounter();
    if (dedupeChatIds()) reseedIdCounter();

    await _doSave(); // 立即保存
    renderChatList();
    renderMessages();
    showToast(`✓ 已恢复 ${backupChats.length} 个对话`, 'success', 3000);
  } catch (e) {
    console.error('恢复失败:', e);
    showToast('✕ 恢复失败: ' + e.message, 'error', 3000);
  }
}

async function showBackupInfo() {
  const infoEl = document.getElementById('backupInfo');
  const all = await collectBackups();

  if (all.length === 0) {
    infoEl.innerHTML = '📭 暂无备份数据';
    infoEl.style.display = 'block';
    setTimeout(() => { infoEl.style.display = 'none'; }, 5000);
    return;
  }

  const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) : '未知';

  // 最完整的一份高亮在最上（恢复时默认就是它）
  const sorted = [...all].sort((a, b) => b.msgCount - a.msgCount || (b.ts || '').localeCompare(a.ts || ''));
  const best = sorted[0];
  // 时间线按时间倒序列出所有槽
  const byTime = [...all].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  try {
    const rows = byTime.map(b => {
      const star = b === best ? '⭐ ' : '　';
      return `${star}<b>${b.label}</b> · ${fmt(b.ts)} · ${b.chatCount}话/${b.msgCount}条 · ${(b.size / 1024).toFixed(1)}KB`;
    }).join('<br>');

    infoEl.innerHTML = `
      📊 <b>备份信息</b>（共 ${all.length} 份，⭐=恢复时默认取的最完整一份）<br>
      ${rows}
    `;
    infoEl.style.display = 'block';
  } catch (e) {
    infoEl.innerHTML = '⚠️ 备份数据损坏';
    infoEl.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════════
// TOAST NOTIFICATION
// ═══════════════════════════════════════════════════════
function showToast(msg, type = 'info', duration = 2200) {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  // 底色/边框/阴影全在 css 的 .toast 里走 token（--bg-rgb / --solid-a / --shadow-pop），这里不写内联颜色。
  // 类型 class 只挂认得的几种，别把调用方随手传的字符串当 class 塞进去；
  // 有两处传的是 'warn'（css 只认 warning，以前那两条一直是没颜色的普通提示）
  if (type === 'warn') type = 'warning';
  t.className = 'toast' + (/^(success|error|warning)$/.test(type) ? ' ' + type : '');
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toast-out .25s ease both';
    setTimeout(() => t.remove(), 280);
  }, duration);
}

// window.prompt() 在 Electron 桌面版和安卓 WebView 里都不可用（静默失败），
// 所有输入弹窗统一走这个自定义模态框。用法：const v = await appPrompt(提示, 默认值);
// 取消时返回 null（与原生 prompt 语义一致）。Enter 确定，Shift+Enter 换行，Esc 取消。
// 可选第三个参数 { check: { label, checked } }：输入框下面多一个勾选框，
// 按确定时把勾选结果写回 check.checked（返回值仍然是那段文字，老调用方不受影响）。
function appPrompt(message, defaultVal = '', opts = null) {
  return new Promise(resolve => {
    let wrap = document.getElementById('appPromptModal');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'appPromptModal';
      wrap.innerHTML = `
        <div class="gc-dialog-backdrop" id="appPromptBackdrop">
          <div class="gc-dialog" role="dialog" aria-modal="true" aria-labelledby="appPromptMsg" onclick="event.stopPropagation()">
            <div id="appPromptMsg" class="gc-dialog-msg"></div>
            <textarea id="appPromptInput" class="gc-dialog-input" rows="2"></textarea>
            <label id="appPromptCheckRow" class="gc-dialog-check" style="display:none">
              <input type="checkbox" id="appPromptCheck">
              <span id="appPromptCheckLabel"></span>
            </label>
            <div class="gc-dialog-actions">
              <button id="appPromptCancel" class="gc-btn">取消</button>
              <button id="appPromptOk" class="gc-btn primary">确定</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(wrap);
    }
    const input = wrap.querySelector('#appPromptInput');
    wrap.querySelector('#appPromptMsg').textContent = message;
    input.value = defaultVal ?? '';
    // 长默认值自动给大一点的编辑区
    input.rows = (String(defaultVal || '').length > 120 || String(defaultVal || '').includes('\n')) ? 10 : 2;
    // 弹窗是复用的：每次都要显式重置勾选行，不然上一个调用方的勾选框会留在下一个弹窗里
    const check = opts && opts.check;
    // 找不到勾选行（测试替身 / 哪天模板被改）时当它不存在，别让整个弹窗跟着炸
    const checkRow = wrap.querySelector('#appPromptCheckRow'), checkBox = wrap.querySelector('#appPromptCheck');
    const checkLabel = wrap.querySelector('#appPromptCheckLabel');
    if (checkRow) checkRow.style.display = check ? 'flex' : 'none';
    if (checkLabel) checkLabel.textContent = check ? (check.label || '') : '';
    if (checkBox) checkBox.checked = !!(check && check.checked);
    wrap.style.display = 'block';
    const done = (val) => {
      if (check && checkBox && val !== null) check.checked = checkBox.checked;
      wrap.style.display = 'none';
      input.onkeydown = null;
      wrap.querySelector('#appPromptBackdrop').onclick = null;
      resolve(val);
    };
    wrap.querySelector('#appPromptOk').onclick = () => done(input.value);
    wrap.querySelector('#appPromptCancel').onclick = () => done(null);
    wrap.querySelector('#appPromptBackdrop').onclick = () => done(null);
    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// ═══════════════════════════════════════════════════════
// 对话墓碑：记住「这个对话是被**故意**删掉的」
//
// 不记的话，删掉的对话会自己回来 —— 原话「一些没用的对话我反复删除了十几次
// 又冒出来（明明也去回收站删掉了」。机制是三条路合起来的：
//
//   ① deleteSelectedChats（批量删）**根本没删云端**，只删本地；
//   ② deleteChat（单个删）虽然删云端，但是即发即忘、失败只在控制台，
//      离线/token 过期时删不掉，人完全看不出来；
//   ③ loadChatsFromCloud 的「清点补漏」每次启动都把
//      **本地没有而云端有**的对话当成「漏了」主动拉回来。
//
// 于是「本地删掉」在 ③ 眼里跟「同步时漏了」长得一模一样，删一次拉回来一次。
// 这不是同步不稳定 —— 是系统**根本没有办法表达「这个我不要了」**。
// 墓碑就是那个表达。日记（19-diary.js）和收藏（01-core.js）早就各有一套，
// 只有对话没有，所以只有对话会复活。
//
// ⚠️ 墓碑**不需要撤销**：restoreChatFromTrash 恢复时会 `chat.id = nextId()` 发新号，
//    恢复出来的是个新 id 的对话，跟旧 id 的墓碑不冲突。别为了「恢复要不要删墓碑」
//    去改那边 —— 那样反而会让旧 id 重新变得可复活。
//
// ⚠️ cloud 字段是「云端那行删干净了没」，不是「本地删了没」。
//    'pending' 的会在每次同步时重试，删成功才变 'done'。
//    **只有 'done' 的墓碑才允许过期清理** —— 云端还留着的话，
//    清掉墓碑就等于把复活开关又打开了。
// ═══════════════════════════════════════════════════════

// 墓碑保留多久（天）。只对 cloud:'done' 的生效
const TOMBSTONE_TTL_DAYS = 180;

/* ⚠️ 墓碑表必须是**无原型**的对象（Object.create(null)），不能用 `{}`。
   用 `{}` 的话 `t['__proto__'] = {...}` 不会建一个 own property，
   而是去**设置这个表自己的原型** —— 于是 id 为 '__proto__' 的对话
   打墓碑打不上（hasOwnProperty 查出来是 false），那个对话永远可复活，
   而且全程零报错。对话 id 是 nextId() 发的数字，正常不会撞上，
   但墓碑表会从云端读回来，脏数据不该能让防线静默失效。（Codex 审出来的。） */
function _blankTombstoneTable() { return Object.create(null); }

function _tombstones() {
  const t = state.deletedChats;
  if (!t || typeof t !== 'object') {
    state.deletedChats = _blankTombstoneTable();
    return state.deletedChats;
  }
  /* ⚠️ 光在「表不存在」时建无原型表是不够的 —— 真实路径上这张表几乎**总是**
     从 IndexedDB / 云端 JSON.parse 回来的，那是个有原型的普通对象。
     于是 markChatDeleted('__proto__') 又变回「设置原型」而不是建 own property。
     所以这里做一次性归一：发现原型不是 null 就搬进无原型表。
     （JSON.parse 本身是安全的 —— 它用 CreateDataProperty，`{"__proto__":…}`
      会成为货真价实的 own property，所以搬的时候不会丢。） */
  if (Object.getPrototypeOf(t) !== null) {
    const fresh = _blankTombstoneTable();
    for (const k of Object.keys(t)) fresh[k] = t[k];
    state.deletedChats = fresh;
    return fresh;
  }
  return t;
}

// id 统一成字符串当键 —— 对话 id 是数字，但 JSON 对象的键本来就是字符串，
// 存的时候和读的时候不统一的话，`in` 判断会静默失效（数字 1 和 "1" 是两个键）
function _tsKey(id) { return String(id); }

/* cc：这个对话要是从 claude.ai 导进来的，墓碑上顺手记它在 claude.ai 的 uuid。
   不记的话，删掉之后再导一次同一份导出，它会拿一个新 id 回来 —— 墓碑只认 id，挡不住
   （见 60-cc-import.js 的 ccPlanImport）。调用方不传就去 state.chats 里找一眼
  （批量删是先打墓碑再删本地，找得到；单个删是先删本地，所以那边显式传）。 */
function markChatDeleted(id, cloudDone, cc) {
  if (id == null) return;
  if (!cc) {
    const c = (state.chats || []).find(x => x && String(x.id) === _tsKey(id));
    cc = c && c.importedFrom && c.importedFrom.uuid;
  }
  const t = { at: Date.now(), cloud: cloudDone ? 'done' : 'pending' };
  if (typeof cc === 'string' && cc) t.cc = cc;
  _tombstones()[_tsKey(id)] = t;
}

function isChatDeleted(id) {
  return id != null && Object.prototype.hasOwnProperty.call(_tombstones(), _tsKey(id));
}

// 云端那行确认删掉了
function markTombstoneCloudDone(id) {
  const t = _tombstones()[_tsKey(id)];
  if (t) t.cloud = 'done';
}

/* 把墓碑打回「还没删干净」。
   ⚠️ done 只能证明**删的那一刻**请求没报错，不能保证云端从此一直没有那行：
      A 删掉并标 done 之后，还没收到墓碑的 B 一编辑就把同一个 chat_id 又 upsert 上去了。
      于是云端同时存在「done 墓碑」和「那行数据」，而 done 不再重试、清点又跳过它 ——
      等 180 天后墓碑被 prune，那行就复活了。
      所以清点时一旦发现「本地有墓碑、云端却还有这行」，就打回 pending 重删。
      （Codex 二审给的场景。另外 Supabase 的 DELETE 没有 error 也可能是 RLS 下
       零行受影响，所以「事后清点确认」本身就是必要的，不能只信删除那一下。） */
function markTombstoneCloudPending(id) {
  const t = _tombstones()[_tsKey(id)];
  if (t) t.cloud = 'pending';
}

// 还没确认删干净的，等着下次同步重试
function pendingTombstoneIds() {
  const t = _tombstones();
  return Object.keys(t).filter(k => t[k] && t[k].cloud !== 'done');
}

/* 墓碑并集合并（多设备）。两台设备各自删掉的都算数，谁也别把谁的删除撤销掉。

   ⚠️ cloud 字段合并时 **done 获胜**。
      我第一版写的是「pending 优先，更保守」—— 那是错的，它**不收敛**：
      云端是 pending、本机刚删成功标了 done，合并又变回 pending
      → 于是再删一次 → 又标 done → 下一轮同步又被合成 pending → 无限循环，
      而且每一轮都真的往云端发删除请求。（Codex 审出来的，我的「保守」推理错了。）
      done 是 deleteChatsFromCloud 查过返回值里的 error 之后才给的，是实证；
      要是不信任它，该去把删除接口的确认做扎实，而不能让旧的 pending 永久压住新的确认。

   at 取更早的那个：TTL 从**第一次删**算起，不然墓碑会被反复「刷新」而永不过期。

   ⚠️ 拿到别的设备的墓碑后，**不会**自动删掉本机那份对话。
      对话是这个 App 里最贵的数据，让一条同步下来的记录去删它，
      风险远大于收益（墓碑错一次就是真丢东西）。这里只保证两件事：
      ① 本机不会再把它推回云端（syncChatsToCloud 里那道 isChatDeleted）；
      ② 它不会因为云端还留着而在本机复活。
      本机那份要不要留，人自己删 —— 而这次删了就不会再回来了。 */
function mergeTombstones(mine, theirs) {
  const out = _blankTombstoneTable();
  for (const src of [theirs || {}, mine || {}]) {
    if (!src || typeof src !== 'object') continue;
    // 用 Object.keys 而不是 for...in：只要 own property，别把原型链上的东西当墓碑
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (!v || typeof v !== 'object') continue;
      const prev = out[k];
      const at = Math.min(prev?.at ?? Infinity, typeof v.at === 'number' ? v.at : Date.now());
      out[k] = {
        at: Number.isFinite(at) ? at : Date.now(),
        // done 获胜 —— 见上面那段，pending 优先会导致来回翻转、永不收敛
        cloud: (prev?.cloud === 'done' || v.cloud === 'done') ? 'done' : 'pending',
      };
      // claude.ai 来源记号跟着走：丢了它，另一台设备再导同一份导出就会把删掉的导回来
      const cc = (typeof v.cc === 'string' && v.cc) ? v.cc : prev?.cc;
      if (cc) out[k].cc = cc;
    }
  }
  return out;
}

/* 过期清理。⚠️ 只清 cloud:'done' 的 —— 'pending' 意味着云端可能还留着那行，
   清掉墓碑它下次就又被「清点补漏」拉回来了。宁可让墓碑一直留着。 */
function pruneTombstones() {
  const t = _tombstones();
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 864e5;
  let n = 0;
  for (const k of Object.keys(t)) {
    const v = t[k];
    // 带 cc 的（claude.ai 导进来又删掉的）不过期：它挡的不是云端那行，是「再导一次」，
    // 那份导出 zip 半年后照样躺在她硬盘里。一条几十字节，留着不费事。
    if (v && v.cc) continue;
    if (v && v.cloud === 'done' && typeof v.at === 'number' && v.at < cutoff) { delete t[k]; n++; }
  }
  return n;
}

// ── SAVE SECTION ── 落盘这一段的起点。tests/moments.test.js 和
// tests/chat-tombstone.test.js 用 vm 抠这一段单独跑，锚的就是这行注释。
// _doSave 依赖下面那个模块级基线变量，从 `async function _doSave()` 起切会把它
// 切掉 → ReferenceError（2026-09-22 真栽了一次）。往这段里加东西请加在这行之后。
/* configs 上一次落盘时的样子。版本号在**写盘这一道**上按内容比对来推，
   而不是散在 updateC / addC / deleteC / ensureGeminiConfig / setGeminiModel /
   setLocalClaudeThinking … 每个改 configs 的地方各自 +1 ——
   那种写法漏一处就是一个静默失效的入口（分组改了但 ver 没涨 → 云端旧值照样赢），
   而写盘是所有改动的必经之路，从这里推天然漏不掉。 */
let _lastSavedConfigsJson = null;

/* 云同步把 state.configs 换成了云端那份时必须调一次。
   不调的话基线还停在换之前，下一次 _doSave 一比对发现「内容变了」就又 +1 ——
   这台机器明明一个字都没改，ver 却凭空涨到比对方高，于是**永远压着**另一台，
   对方真实的改动再也传不过来。换配置和重置基线必须成对出现。 */
function _resyncConfigsBaseline() {
  _lastSavedConfigsJson = JSON.stringify(state.configs);
}

/* 接受了「不是本机编辑出来的」那份 configs（云端更新的一份、或者下面合并出来的一份）
   之后必须调这个，而且必须在 state.configsVer 已经定好之后调。
   只写 configs 那两个键、不走 save()：save() 是 800ms 防抖 + 顺手做整份备份，
   而这里发生在启动那几秒的异步云同步里 —— 她这时候很可能正在切页面/关窗口，
   防抖没到点就等于**内存里换了、盘上还是旧的**，下次启动从盘里读回旧值，
   「改了又弹回去」原样复现，而且一次报错都没有。
   基线重置写在函数里而不是交给调用方，是因为顺序反了（先落盘后重置）同样静默：
   _doSave 会把这份「拉下来的」当成「我改的」凭空 +1，这台就永远压着另一台。 */
async function _persistConfigs() {
  _resyncConfigsBaseline();
  try {
    await Promise.all([
      idbSet('kuro_configs',    _lastSavedConfigsJson),
      idbSet('kuro_configsVer', String(state.configsVer | 0)),
    ]);
  } catch (e) {
    console.warn('configs 快照落盘失败:', e);
  }
}

/* 规范化序列化：键名排序，所以「同一份配置、字段写入顺序不同」不会被当成两份。
   下面的合并全靠它做判等和定序，两台设备必须算出**一模一样的字符串**。 */
function _cfgCanon(v) {
  if (Array.isArray(v)) return '[' + v.map(_cfgCanon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + _cfgCanon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// 「填了多少」——空串 / null / undefined / false 都算没填。
function _cfgFilled(c) {
  let n = 0;
  for (const k of Object.keys(c || {})) {
    const v = c[k];
    if (v === '' || v == null || v === false) continue;
    n++;
  }
  return n;
}

/* configs 的对称合并。**只在版本号打平而内容不同时用**（平局裁决）。
   单一逻辑计数器没有平局裁决：两台设备都从 v5 各改一次变成 v6，严格大于不成立，
   于是各自保留本地 —— 双方永远看不见对方那次改动。这不是抖动，是静默互不可见。
   给版本挂第二键（例如 writerId）能裁决，但那等于「某台设备恒赢」，
   赢的那台随手改一下就吃掉另一台真实的配置，比现在更糟。
   所以这里是**内容裁决**：两边跑同一个纯函数、得到同一个结果，谁都不特殊。
   三条规则都必须对称、且只依赖两份内容本身：
     1) 按 id 取并集 —— 一边新加的模型不会因为另一边没有就消失（她的 Gemini）；
     2) 同 id 两份不同：先比「填了多少字段」，空白的工厂配置打不过配好的那份
        （她的真实症状正是空 apiKey、maxTokens 弹回 8000 把配好的冲掉）；
        并列时比规范化 JSON 的字符串大小 —— 语义上无意义，但确定，两台算出来一致；
     3) 按 id 排序输出 —— 顺序也必须由内容决定。否则两边 JSON 不同，
        下一轮又判成「内容不同」再合一次，永远收敛不了。
   ⚠️ 已知取舍：并集会让「在一台上删掉的配置」从另一台复活。
      要彻底治得上墓碑（favGroupOps 那套逐条 ops 表）。这里不上，因为删配置是
      低频手动动作、复活了一眼就看得见、再删一次即可；而丢一条配好的 API Key
      是静默的、事后极难查的损失。两害取轻。 */
function _mergeConfigs(localList, cloudList) {
  const both = (Array.isArray(localList) ? localList : []).concat(Array.isArray(cloudList) ? cloudList : []);
  const pick = (x, y) => {
    const jx = _cfgCanon(x), jy = _cfgCanon(y);
    if (jx === jy) return x;
    const fx = _cfgFilled(x), fy = _cfgFilled(y);
    if (fx !== fy) return fx > fy ? x : y;
    return jx > jy ? x : y;
  };
  const byId = new Map();
  for (const c of both) {
    if (!c || typeof c !== 'object') continue;
    const id = c.id;
    byId.set(id, byId.has(id) ? pick(byId.get(id), c) : c);
  }
  return Array.from(byId.values())
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
}

/* ── 对话一次 save 只序列化一遍 ──
   以前一次 save() 要把整份 state.chats 序列化三遍，推上云的那几个还要再多一遍：
     ① _doSave 写 kuro_chats                      —— JSON.stringify(state.chats)
     ② 3 秒后 syncChatsToCloud 给**每个**对话算指纹 —— _chatFp 里 JSON.stringify(chat).length
     ③ 5 秒后 createBackup → _writeBackup 写备份环 —— 又一遍 JSON.stringify(chats)
     ④ 推成功的那几个 markPushed 再算一次指纹
   对话是这个 App 里最大的一块（10MB+），手机上每一遍都是一次主线程卡顿。
   现在 _doSave 逐个对话 stringify 再拼成数组：JSON 数组本来就是 '[' + 各元素逗号连接 + ']'，
   元素序列化成 undefined 的（空洞 / undefined / 函数）写 null —— 拼出来和
   JSON.stringify(state.chats) **逐字节相同**（tests/save-once.test.js 钉着）。
   顺手记下整份 JSON 和每个对话的长度，②③④ 直接拿来用。
   ⚠️ 语义：②③④ 用的是「上一次 _doSave 落盘那一刻」的样子，而不是它们各自计时器到点那一刻。
      只有「_doSave 之后、没再 save() 就改了对话」时两者才有差（典型是流式输出中途）——
      那些改动本来也还没落盘，等下一次 save 重新拍快照再推、再备份。
      备份因此和 kuro_chats 是同一份字节。数组被整个换掉 / 条数变了就认为快照作废、现算。 */
let _chatsSnap = null;   // { arr, json, lens: WeakMap<chat, JSON 长度>, chatCount, msgCount }

function _serializeChats(chats) {
  _chatsSnap = null;                       // 中途抛了也别留着上一份冒充这一份
  if (!Array.isArray(chats)) return JSON.stringify(chats);
  const n = chats.length;
  const parts = new Array(n);
  const lens = new WeakMap();
  let msgCount = 0;
  for (let i = 0; i < n; i++) {            // 故意不用 map：map 会跳过空洞，join 出来就不是 null 了
    const c = chats[i];
    const s = JSON.stringify(c);
    parts[i] = s === undefined ? 'null' : s;
    if (c && typeof c === 'object') lens.set(c, parts[i].length);
    msgCount += Object.keys(c && c.nodes || {}).length;   // 与 chatsMsgCount 同一个算法
  }
  const json = '[' + parts.join(',') + ']';
  _chatsSnap = { arr: chats, json, lens, chatCount: n, msgCount };
  return json;
}

// 快照还对得上这个数组（同一个数组、条数没变、字符串还没被备份用掉）就返回它，否则 null
function _chatsSnapFor(arr) {
  const s = _chatsSnap;
  return (s && s.json != null && s.arr === arr && Array.isArray(arr) && s.chatCount === arr.length) ? s : null;
}

// 单个对话 JSON 的长度（云同步指纹 _chatFp 用）。快照里有就取快照的，没有就现算
function _chatJsonLen(chat) {
  const s = _chatsSnap;
  if (s && s.arr === state.chats && chat && typeof chat === 'object' && s.lens.has(chat)) return s.lens.get(chat);
  return JSON.stringify(chat).length;
}

async function _doSave() {
  /* ⚠️ 必须排在 idbSet 之前：configsVer 要和它描述的那份 configs 同一批落盘。
     第一次 save 只立基线不 +1（_lastSavedConfigsJson === null），
     否则每次启动都会凭空涨一版，把另一台设备真实的改动压掉。 */
  const _cfgJson = JSON.stringify(state.configs);
  if (_lastSavedConfigsJson !== null && _cfgJson !== _lastSavedConfigsJson) {
    state.configsVer = Math.max(0, state.configsVer | 0) + 1;
  }
  /* ⚠️ -1（「这台机器还没有自己的 configs」）**不许被无关的 save 抬成 0**。
     以前这里有一条 `else if (ver < 0) ver = 0`，后果是：全新设备还没拉到云端，
     任何一个不相干的功能（换个主题、存条记忆）触发一次 save 就把哨兵消费掉，
     而老数据的云端 ver 也是 0 —— 严格大于不成立，三条工厂空配置就把她真实的
     API Key 永久挡在外面。哨兵只能由「她真的改了 configs」这一件事升级
     （上面那条分支从 -1 直接升到 1）。（Codex 一审逮到的反向场景） */
  _lastSavedConfigsJson = _cfgJson;

  try {
    await Promise.all([
      idbSet('kuro_chats',       _serializeChats(state.chats)),   // ≡ JSON.stringify(state.chats)，顺手拍快照
      idbSet('kuro_configs',     _cfgJson),
      idbSet('kuro_configsVer',  String(state.configsVer | 0)),
      idbSet('kuro_memories',    JSON.stringify(state.memories)),
      idbSet('kuro_recentMemos', JSON.stringify(state.recentMemos)),
      idbSet('kuro_trash',       JSON.stringify(state.trash)),
      idbSet('kuro_deletedChats',JSON.stringify(state.deletedChats || {})),
      idbSet('kuro_autoMemory',  JSON.stringify(state.autoMemory)),
      idbSet('kuro_bg',          state.background),
      idbSet('kuro_brightness',  String(state.brightness)),
      idbSet('kuro_accent',      state.accentColor),
      idbSet('kuro_themeTemperature', state.themeTemperature || 'warm'),
      idbSet('kuro_customBg',    state.customBg || ''),
      idbSet('kuro_customText',  state.customText || ''),
      // 别在这里调 _echoOpacityVal：它在 SAVE SECTION 外面，moments.test 只切这一段跑，调了就整个 _doSave 抛错
      idbSet('kuro_echoOpacity', String(Number.isFinite(+state.echoOpacity) ? +state.echoOpacity : 1)),
      idbSet('kuro_fontPreset',  state.fontPreset || 'simsun'),
      idbSet('kuro_uiShape',     state.uiShape || 'soft'),
      idbSet('kuro_bgAutoTint',  JSON.stringify(!!state.bgAutoTint)),
      idbSet('kuro_bgLegibility', state.bgLegibility || 'auto'),
      idbSet('kuro_aiFontSize',  String(state.aiFontSize)),
      idbSet('kuro_userFontSize',String(state.userFontSize)),
      idbSet('kuro_bgBlur',      String(state.bgBlur ?? 3)),
      idbSet('kuro_uiBlur',      String(state.uiBlur ?? 28)),
      idbSet('kuro_webSearchKey',state.webSearchApiKey || ''),
      idbSet('kuro_webSearchProvider',state.webSearchProvider || 'tavily'),
      idbSet('kuro_tenorKey',    state.tenorApiKey || ''),
      idbSet('kuro_thinkSumKey', state.thinkSumKey || ''),
      idbSet('kuro_voiceKey',    state.voiceApiKey || ''),
      idbSet('kuro_voiceProvider', state.voiceProvider || 'deepgram'),
      idbSet('kuro_voiceBase',   state.voiceApiBase || ''),
      idbSet('kuro_voiceModel',  state.voiceModel || ''),
      idbSet('kuro_callBg',      state.callBg || ''),
      idbSet('kuro_callBgMask',  JSON.stringify(state.callBgMask ?? 0.82)),
      idbSet('kuro_callBgBlur',  JSON.stringify(state.callBgBlur ?? 2)),
      idbSet('kuro_activeChat',  String(state.activeChatId)),
      idbSet('kuro_bandAi',      JSON.stringify(state.bandAiEnabled !== false)),
      idbSet('kuro_bandAuto',    JSON.stringify(state.bandAutoFetch === true)),
      idbSet('kuro_callDnd',     JSON.stringify(!!state.callDnd)),
      idbSet('kuro_ccMemory',    JSON.stringify(!!state.ccMemoryEnabled)),
      idbSet('kuro_typingRhythm_on', JSON.stringify(state.typingRhythmEnabled !== false)),
      idbSet('kuro_typingDraftPeek', JSON.stringify(!!state.typingDraftPeek)),
      idbSet('kuro_userAvatar',  state.userAvatar || ''),
      idbSet('kuro_showUserAvatar', JSON.stringify(!!state.showUserAvatar)),
      idbSet('kuro_inkStream', JSON.stringify(state.inkStream !== false)),
      idbSet('kuro_inkRate', JSON.stringify(+state.inkRate || 14)),
      idbSet('kuro_favMsgs',     JSON.stringify(state.favMessages || [])),
      idbSet('kuro_favGroups',   JSON.stringify(state.favGroups || [])),
      idbSet('kuro_favGroupsVer', String(state.favGroupsVer || 0)),
      idbSet('kuro_favGroupOps', JSON.stringify(state.favGroupOps || {})),
      idbSet('kuro_userName',    state.userName || ''),
      idbSet('kuro_userNameAi',  JSON.stringify(state.userNameAiVisible !== false)),
      idbSet('kuro_stickerNotes',JSON.stringify(state.stickerNotes || {})),
      idbSet('kuro_stickerAiOff',JSON.stringify(state.stickerAiOff || {})),
      idbSet('kuro_stickerGroups', JSON.stringify(state.stickerGroups || [])),
      idbSet('kuro_stickerGroupOf',JSON.stringify(state.stickerGroupOf || {})),
      idbSet('kuro_stickerGroupsVer', String(state.stickerGroupsVer || 0)),
      idbSet('kuro_stickerGroupOps', JSON.stringify(state.stickerGroupOps || {})),
      idbSet('kuro_thinkOpen',   JSON.stringify(!!state.thinkOpen)),
      idbSet('kuro_thinkOpenVer',String(state.thinkOpenVer || 0)),
      idbSet('kuro_brainMems',   JSON.stringify(state.brainMemories || [])),
      idbSet('kuro_brainRerank', JSON.stringify(state.brainRerank !== false)),
      // 网页坞：清单地址 + 手动加的条目 + 上次拉到的远端清单（离线也得有东西可点）
      idbSet('kuro_webDockSrc',   state.webDockSrc || ''),
      idbSet('kuro_webDockItems', JSON.stringify(state.webDockItems || [])),
      idbSet('kuro_webDockRemote',JSON.stringify(state.webDockRemote || [])),
      idbSet('kuro_webDockSyncAt',String(state.webDockSyncAt || 0)),
      idbSet('kuro_proustMems',  JSON.stringify(state.proustMems || [])),
      idbSet('kuro_proustGate',  JSON.stringify({
        enabled: state.proustEnabled !== false, lastAt: state.proustLastAt || 0,
        count: state.proustCount || 0, day: state.proustDay || '', recent: state.proustRecent || [],
      })),
      idbSet('kuro_peekGate',    JSON.stringify({
        enabled: !!state.peekEnabled, lastAt: state.peekLastAt || 0,
        count: state.peekCount || 0, day: state.peekDay || '',
        movieChimeMin: state.movieChimeMin ?? 4,
        callBargeMode: state.callBargeMode || 'auto', callNudgeOff: !!state.callNudgeOff,
      })),
      idbSet('kuro_vitalsOn',    JSON.stringify(state.vitalsOn !== false)),
      idbSet('kuro_vitalsHeartbeatOn', JSON.stringify(!!state.vitalsHeartbeatOn)),
      idbSet('kuro_vitalsByModel', JSON.stringify(state.vitalsByModel || {})),
      idbSet('kuro_vitalsSleepPref', JSON.stringify(state.vitalsSleepPref || null)),
      idbSet('kuro_dreamsOn', JSON.stringify(!!state.dreamsOn)),
      idbSet('kuro_dreamsByModel', JSON.stringify(state.dreamsByModel || {})),
      idbSet('kuro_dreamGateByModel', JSON.stringify(state.dreamGateByModel || {})),
      idbSet('kuro_dreamMaterialCooldowns', JSON.stringify(state.dreamMaterialCooldowns || {})),
      idbSet('kuro_ttsVoice',    state.ttsVoice || 'zh-CN-XiaoxiaoNeural'),
      idbSet('kuro_ttsVoiceZh',  state.ttsVoiceZh || 'zh-CN-XiaoxiaoNeural'),
      idbSet('kuro_ttsRate',     String(state.ttsRate || 0)),
      idbSet('kuro_ttsPitch',    String(state.ttsPitch || 0)),
      idbSet('kuro_modelDiaries',JSON.stringify(state.modelDiaries || {})),
      idbSet('kuro_diaryHandover',JSON.stringify(state.diaryHandover || {})),
      idbSet('kuro_diaryEnabled',JSON.stringify(!!state.diaryEnabled)),
      idbSet('kuro_diaryDevView',JSON.stringify(!!state.diaryDevView)),
      // 育儿室：开关和孩子名字都得存。漏了的话刷新一次开关就悄悄弹回去，
      // 而且没有任何报错——AI 只会说"我看不到育儿室"，极难往这边想。
      idbSet('kuro_nurseryOn',   JSON.stringify(!!state.nurseryOn)),
      idbSet('kuro_nurseryName', state.nurseryName || ''),
      // 檐廊：只有一个总开关（没有状态、没有存档，引擎是只读的）
      idbSet('kuro_engawaOn',    JSON.stringify(!!state.engawaOn)),
      // 跑腿：谁来跑（三道关的第 1 道，另两道在 loadStateFromDB 和 14 的启动赋值）
      idbSet('kuro_errandWorker', state.errandWorker || ''),
      // 学习卡片：开关 + 全部卡片（含 SRS 进度和每次作答记录）。
      // 卡片丢了等于学习进度归零，比开关弹回去严重得多。
      idbSet('kuro_studyOn',     JSON.stringify(!!state.studyOn)),
      idbSet('kuro_studyCards',  JSON.stringify(state.studyCards || [])),
      // 分组投放：每组多少个新词 + 当前这一组是哪几张。组不存的话，
      // 每次刷新都会重新挑一组，学到一半换一批词，一组永远学不完。
      idbSet('kuro_studyGroupSize', JSON.stringify(state.studyGroupSize ?? 10)),
      idbSet('kuro_studyGroupIds',  JSON.stringify(state.studyGroupIds || [])),
      // 复习/新词的交替游标。不存的话每次启动都从复习开始，
      // 「聊几句就关」的用法下新词能连着好几天发不出来（见 studyPick 的注释）
      idbSet('kuro_studyLastKind',  state.studyLastKind || 'new'),
      // 内置词书：选了哪本 + 取到第几个词。pos 不存的话每次启动从头取，
      // 删掉的书词会一个个冒回来
      idbSet('kuro_studyBook',      JSON.stringify(state.studyBook || null)),
      // 单词卡跨设备同步：删词的墓碑（上云）+ 上次同步完每张卡的指纹（只存本机，见 studySyncApply）。
      // 墓碑不存的话刷新后删掉的词会被另一台同步回来；指纹不存的话每次启动都把全部卡当成「刚改过」
      idbSet('kuro_studyGone',      JSON.stringify(state.studyGone || {})),
      idbSet('kuro_studySeen',      JSON.stringify(state.studySeen || {})),
      // 点歌：开关 + 最近听过（只存元数据，播放地址是有时效的，存了也没用）
      idbSet('kuro_musicOn',     JSON.stringify(!!state.musicOn)),
      idbSet('kuro_skillsOff',   JSON.stringify(state.skillsOff || {})),
      idbSet('kuro_musicRecent', JSON.stringify(state.musicRecent || [])),
      idbSet('kuro_musicFav',   JSON.stringify(state.musicFav || [])),
      idbSet('kuro_uedOn',          JSON.stringify(state.uedOn !== false)),
      idbSet('kuro_coreadOn',       JSON.stringify(state.coreadOn !== false)),
      // 学习工具箱：错题本（带题目图片，会比较大）和公式卡的进度 / 自己加的卡
      idbSet('kuro_mistakes',       JSON.stringify(state.mistakes || [])),
      idbSet('kuro_fcards',         JSON.stringify(state.fcards || {})),
      idbSet('kuro_lifeOn',         JSON.stringify(state.lifeOn !== false)),
      idbSet('kuro_lifeCycleShare', JSON.stringify(state.lifeCycleShare !== false)),
      idbSet('kuro_lifeReceipts',   JSON.stringify(state.lifeReceipts || {})),
      idbSet('kuro_lifePeriods',    JSON.stringify(state.lifePeriods || [])),
      idbSet('kuro_lifeAnnivs',     JSON.stringify(state.lifeAnnivs || [])),
      idbSet('kuro_lifePromises',   JSON.stringify(state.lifePromises || [])),
      idbSet('kuro_moments',        JSON.stringify(state.moments || [])),
      idbSet('kuro_bubbleThemes',   JSON.stringify(state.bubbleThemes || [])),
      idbSet('kuro_bubbleTheme',    JSON.stringify(state.bubbleTheme || '')),
      idbSet('kuro_bubbleThemeBg',  JSON.stringify(state.bubbleThemeBg !== false)),
      idbSet('kuro_musicPlaylists', JSON.stringify(state.musicPlaylists || [])),
      // 点歌的搜索记录 + 跨设备同步的加/删时间表（墓碑）。时间表不存的话，
      // 刷新后删掉的收藏会被另一台同步回来——删了又活
      idbSet('kuro_musicSearchHist', JSON.stringify(state.musicSearchHist || [])),
      idbSet('kuro_musicSyncOps',    JSON.stringify(state.musicSyncOps || {})),
      // 歌词显示偏好 + 沉浸背景。不存的话每次开面板都弹回默认，等于没这几个开关
      idbSet('kuro_musicLyricTrans', JSON.stringify(state.musicLyricTrans !== false)),
      idbSet('kuro_musicLyricRoma',  JSON.stringify(!!state.musicLyricRoma)),
      idbSet('kuro_musicVis',        JSON.stringify(musicVisNorm(state.musicVis))),
      idbSet('kuro_musicLyricStyle', JSON.stringify(musicLyricStyleNorm(state.musicLyricStyle))),
      // 世界书（60-worldbook.js）：设置 + 条目 + 墓碑整包一个 key。三道关的第 1 道
      idbSet('kuro_worldbook',     JSON.stringify(state.worldbook || {})),
      // 小本子（71-wishbook.js）。三道关的第 1 道
      idbSet('kuro_wishbook',      JSON.stringify(state.wishbook || [])),
    ]);
  } catch (e) {
    console.warn('保存失败:', e);
    showToast('(つ´ω`)つ 保存失败，请检查浏览器存储权限', 'error', 4000);
  }
  if (typeof syncSettingsToCloud === 'function') {
    clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(async () => {
      try {
        await syncSettingsToCloud();
        await syncChatsToCloud();
      } catch (e) {
        console.warn('云同步失败:', e);
      }
    }, 3000);
  }
}


// ═══════════════════════════════════════════════════════
// TOKEN ESTIMATION (rough: 1 token ≈ 4 chars for Chinese/English mix)
// ═══════════════════════════════════════════════════════
function estimateTokens(text) {
  if (!text) return 0;
  // CJK chars cost ~1 token each, latin ~4 chars per token
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

function getChatTotalTokens(chat) {
  if (!chat?.nodes) return 0;
  return Object.values(chat.nodes).reduce((s, n) => {
    if (n.variants) return s + n.variants.reduce((vs, v) => vs + (v.tokens||0), 0);
    return s + (n.tokens || estimateTokens(n.content || ''));
  }, 0);
}

function updateInputTokenEstimate() {
  const txt = document.getElementById('userInput').value;
  const thinking = document.getElementById('userThinkingInput')?.value || '';
  const el  = document.getElementById('inputTokenEstimate');
  if (!txt.trim() && !thinking.trim()) { el.innerText = ''; return; }
  el.innerText = `≈ ${estimateTokens(txt) + estimateTokens(thinking)} tokens`;
}

function updateHeaderTokenInfo() {
  const chat = getActiveChat();
  const el   = document.getElementById('headerTokenInfo');
  if (!chat) { el.innerText = ''; return; }
  
  const t = getChatTotalTokens(chat);
  
  // 1. 创建一个高亮包裹的 Token 文本
  const highlightedToken = `<span class="token-highlight">${fmtTokens(t)}</span>`;
  
  // 完整的 20 句随机提示语（将原先的 fmtTokens(t) 替换为 highlightedToken）
  const warnings = [
    `注意看！你已经消耗了 ${highlightedToken}，该悠着点了o(一︿一+)o`,
    `悄悄告诉你，已经用了 ${highlightedToken} 啦，省着点用哦(～￣▽￣)～`,
    `警报！Token 消耗已达 ${highlightedToken}，钱包在流泪o(╥﹏╥)o`,
    `算力也是宝，当前已用 ${highlightedToken}，且用且珍惜(｀・ω・´)`,
    `报告主人，累计消耗 ${highlightedToken}，休息一下如何？_(:з运行∠)_`,
    `好家伙，不知不觉就跑了 ${highlightedToken}，你是懂聊天的(⊙o⊙)`,
    `进度条警告！已消耗 ${highlightedToken}，稍微收敛一下下嘛（^人^）`,
    `大脑过热中！当前对话已花掉 ${highlightedToken}，缓一缓呗(ノДT)`,
    `咳咳， ${highlightedToken} 已经随风而去，省着点花哈(￣▽￣)～■`,
    `大数据显示你已经聊了 ${highlightedToken}，准备开启节能模式吗？`,
    `高能预警！累计 ${highlightedToken} 已蒸发，收网收网！(｀∀´)Ψ`,
    `滴滴——检测到 ${highlightedToken} 消耗，地主家也没有余粮啦(ノ_<)`,
    `今天的对话含金量极高，已经烧掉 ${highlightedToken} 啦！`,
    `别聊啦别聊啦， ${highlightedToken} 过去，CPU要冒烟了！(>_<)`,
    `你瞧，这雀跃的数字已经到了 ${highlightedToken}，要不点个赞？(๑•̀ㅂ•́)و✧`,
    `温馨提示：当前消费 ${highlightedToken}，勤俭节约是美德(✿◡‿◡)`,
    `已经吐出 ${highlightedToken} 了，再聊服务器就要抗议了(ง ᵒ̌皿ᵒ̌)ง`,
    `摸摸钱包， ${highlightedToken} 的分量可不轻呢，且聊且珍惜！`,
    `打住打住！ ${highlightedToken} 已经离你而去，理智聊天呀(＃°Д°)`,
    `叮！今日Token消费额度已达 ${highlightedToken}，请注意查收账单~`
  ];

  // 随机选择数组中的某一项
  if (t > 0) {
    const randomIndex = Math.floor(Math.random() * warnings.length);
    // 2. 这里必须使用 innerHTML 才能让标签生效
    el.innerHTML = warnings[randomIndex];
  } else {
    el.innerHTML = '';
  }
}
function fmtTokens(n) {
  if (n >= 1000) return (n/1000).toFixed(1) + 'k tokens';
  return n + ' tokens';
}

// ═══════════════════════════════════════════════════════
// ACCENT / THEME
// ═══════════════════════════════════════════════════════
// 当前「实际生效」的强调色。开了壁纸取色时它是从壁纸里挑出来的颜色，
// 跟 state.accentColor（手选色，永远原样保留）不是一回事。
// 有些地方把颜色直接烤进 inline style（气泡、回收站卡、手环图表…），
// 那些地方必须读这个，读 state.accentColor 会和 CSS 变量对不上。
var _activeAccent = '';
function activeAccent() { return _activeAccent || state.accentColor || '#c89555'; }
// 强调色实心底上该写白字还是深字。按 WCAG 相对亮度：琥珀金、靛蓝、电光蓝这些暗一点的
// 照旧白字（和以前一模一样）；薄荷青、酸性荧光绿、壁纸取出来的浅色这类亮色换成当前底色，
// 不然白字直接看不见。阈值偏向白字，只有真亮的才换。
function accentOnColor(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  if (L <= 0.45) return '#fff';
  // 深色配色用当前底色（薄荷巧克力下正好是黑巧 #2a1818）；米纸的底是浅的，换成墨黑
  return document.documentElement.classList.contains('theme-light') ? '#111111' : 'var(--bg-base)';
}
function applyAccentCSS(color) {
  _activeAccent = color;
  document.documentElement.style.setProperty('--accent', color);
  const r = parseInt(color.slice(1,3),16);
  const g = parseInt(color.slice(3,5),16);
  const b = parseInt(color.slice(5,7),16);
  document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.15)`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.25)`);
  // 这两个以前只在 :root 里写死成金色，换了强调色也不跟 —— 描边和悬停底一直是金的
  document.documentElement.style.setProperty('--accent-border', `rgba(${r},${g},${b},0.32)`);
  document.documentElement.style.setProperty('--accent-hover', `rgba(${r},${g},${b},0.22)`);
  document.documentElement.style.setProperty('--on-accent', accentOnColor(r, g, b));
  // css 里一堆 rgba(var(--accent-rgb, 99,102,241), .x)（查找高亮、引用高亮、帮助搜索框…）
  // 以前没人设它，全都一直是后备的靛蓝色，跟主题色不搭
  document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
  document.getElementById('dynamic-accent-styles').innerHTML = `
    .accent-text { color: ${color} !important; }
    input[type=range]::-webkit-slider-thumb { background: ${color} !important; }
    input[type=range]::-moz-range-thumb     { background: ${color} !important; }
    .input-bar.has-content .plus-btn { background: ${color} !important; border-color: ${color} !important; }
    .expand-send-btn { background: ${color} !important; }
    .msg-label-dot  { background: ${color} !important; }
    .bubble.ai      { border-left-color: ${color} !important; }
    .chat-item.active { background: rgba(${r},${g},${b},0.12) !important; }
    .add-model-btn  { color: ${color} !important; background: rgba(${r},${g},${b},0.12) !important; border-color: rgba(${r},${g},${b},0.25) !important; }
    .stream-cursor  { background: ${color} !important; }
    .resp-variant.chosen { border-left-color: ${color} !important; }
    .model-pill.active   { color: ${color} !important; background: rgba(${r},${g},${b},0.15) !important; border-color: ${color} !important; }
    .bubble.user { background: rgba(${r},${g},${b},0.14) !important; border-color: rgba(${r},${g},${b},0.28) !important; border-right-color: rgba(${r},${g},${b},0.6) !important; }
    ::-webkit-scrollbar-thumb { background: rgba(${r},${g},${b},0.35) !important; }
    #scrubberThumb { background: rgba(${r},${g},${b},0.4) !important; }
    
    /* 📥 新增：让回收站卡片跟随当前主题色微调外观 */
    .trash-card {
      border-color: rgba(${r},${g},${b},0.15) !important; /* 主题色 15% 透明度的优雅边框 */
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05);
    }
    /* 鼠标悬停卡片时的微光呼吸感加深 */
    .trash-card:hover {
      border-color: rgba(${r},${g},${b},0.45) !important; /* 悬停时边框主题色加深到 45% */
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3), 0 0 12px rgba(${r},${g},${b},0.15); /* 淡淡的主题色背光 */
      background: rgba(var(--bg-rgb), 0.6) !important; /* 悬停时背景稍稍加深（跟色温走，以前写死蓝黑） */
    }
    /* 📥 新增：一键清空按钮的微光悬停动态效果（移到大括号外面并排摆放） */
    .trash-clear-btn:hover {
      background: rgba(239, 68, 68, 0.18) !important; /* 悬停时红色背景稍微变深 */
      border-color: #ef4444 !important; /* 边框变成扎实的亮红色 */
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.25) !important; /* 淡淡的红色警告流光 */
    }
    /* 📥 新增：回收站“恢复”按钮悬停动效 —— 背景充能、主题色边框亮起 */
    .trash-item-recover:hover {
      background: var(--accent) !important; /* 悬停时变成实心主题色 */
      color: var(--on-accent) !important; /* 强调色底上的字（暗色强调色是白字，亮的换深字） */
      border-color: var(--accent) !important;
      box-shadow: 0 0 10px var(--accent-glow); /* 散发当前主题色的微光 */
    }
    /* 📥 新增：回收站“⨉ 销毁”按钮悬停动效 —— 亮红警告流光 */
    .trash-item-delete:hover {
      background: rgba(239, 68, 68, 0.2) !important; /* 悬停时红色背景加深 */
      border-color: #ef4444 !important; /* 边框变成明亮的警告红 */
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.3) !important; /* 淡淡的红光 */
    }
    /* 📥 新增：“⚙ 批量管理”按钮悬停 —— 主题色微亮 */
    .trash-batch-manage-btn:hover {
      background: rgba(255, 255, 255, 0.06) !important;
      border-color: var(--accent) !important; /* 边框亮起主题色 */
      color: var(--text-primary) !important;
      box-shadow: 0 0 8px var(--accent-glow) !important;
    }
    
    /* 📥 新增：“批量恢复”功能按钮悬停 —— 注入实心主题色 */
    .trash-batch-recover:hover {
      background: var(--accent) !important;
      color: var(--on-accent) !important;
      border-color: var(--accent) !important;
      box-shadow: 0 0 10px var(--accent-glow) !important;
    }
    
    /* 📥 新增：“批量彻底删除”按钮悬停 —— 亮红警告流光 */
    .trash-batch-delete:hover {
      background: rgba(239, 68, 68, 0.2) !important; /* 悬停时红色背景加深 */
      border-color: #ef4444 !important; /* 边框变成明亮的警告红 */
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.3) !important; /* 淡淡的红光 */
    }
    
    /* 📥 新增：“取消”按钮悬停 —— 干净的白边高亮 */
    .trash-batch-cancel:hover {
      background: rgba(255, 255, 255, 0.08) !important;
      border-color: rgba(255, 255, 255, 0.4) !important;
      color: var(--text-primary) !important;
    }
    `;
}
function setAccent(color) {
  state.accentColor = color;
  // 手动选色 = 明确表态要这个颜色。此时还开着壁纸取色的话，选完会被壁纸的色盖回去，
  // 表现成「点了没反应」——所以直接把取色关掉，并说一声，别让人以为色板坏了。
  if (state.bgAutoTint) {
    state.bgAutoTint = false;
    const t = document.getElementById('bgAutoTintToggle'); if (t) t.checked = false;
    showToast('已关闭壁纸取色，改用你选的颜色', 'success');
  }
  applyAccentCSS(color); save();
  if (typeof syncCustomToneUI === 'function') syncCustomToneUI();   // 「自定义」那个色块跟着显示现在的强调色
  renderChatList(); renderMessages();
}

const THEME_TEMPERATURES = {
  cool: {
    accent:'#6366f1', bgBase:'#09090f', bgSurface:'#0f0f18', bgElevated:'#16161f', bgHover:'#1e1e2c',
    textPrimary:'#e4e4f0', textMuted:'#7a7a98', textDim:'#8888aa', textSecondary:'#a8a8c4', mask:'9,9,15'
  },
  warm: {
    accent:'#c89555', bgBase:'#0d0c0b', bgSurface:'#141210', bgElevated:'#1b1815', bgHover:'#25211d',
    textPrimary:'#eee8df', textMuted:'#91877d', textDim:'#aaa096', textSecondary:'#c1b7ab', mask:'13,12,11'
  },
  // 酸性：荧光绿配纯黑，对比拉到最满。底色是真正的 #000 而不是近黑 ——
  // 这套风格全靠极限对比撑着，底一灰就散了。
  // 绿只该出现在强调位（标签/进度/当前项），正文仍然是白的：
  // 这是配色表管不到的分寸，靠 css 里 html.ui-acid 那段守着。
  acid: {
    accent:'#c8ff00', bgBase:'#000000', bgSurface:'#0b0b0b', bgElevated:'#141414', bgHover:'#1e1e1e',
    textPrimary:'#ffffff', textMuted:'#8a8a8a', textDim:'#9a9a9a', textSecondary:'#d4d4d4', mask:'0,0,0'
  },
  // 墨块 / 米纸：参考 Haiku 5.5 宣传片那套（米白纸 + 墨黑块 + 电光蓝块）。
  // 墨块是深色版，块和底一黑一更黑；米纸是原片的样子，整套里唯一的浅色。
  // 配「色块」形状才是完整的样子，单独用也成立。
  ink: {
    accent:'#3640f2', bgBase:'#0c0c0c', bgSurface:'#161616', bgElevated:'#1f1f1f', bgHover:'#2a2a2a',
    textPrimary:'#efece5', textMuted:'#8c877e', textDim:'#a6a197', textSecondary:'#cfcac0', mask:'12,12,12'
  },
  // 浅色要多管两样：边框（:root 里写死的是白色半透明，浅底上等于没有）和 light 标记
  // ——css 里 html.theme-light 那段靠它把写死成深色的主界面件翻过来。
  paper: {
    accent:'#2f3be6', bgBase:'#efece5', bgSurface:'#e3ddd2', bgElevated:'#d9d2c5', bgHover:'#cfc7b8',
    textPrimary:'#111111', textMuted:'#6e685e', textDim:'#4f4a42', textSecondary:'#2b2823', mask:'239,236,229',
    border:'rgba(17,17,17,0.10)', borderMid:'rgba(17,17,17,0.20)', light:true
  },
  // 薄荷巧克力：参考图是 #744444 可可棕底 + #2ef0ff 薄荷青笔画。
  // 底色压暗成黑巧，#744444 本色留给 css 里的顶光和小样；正文是带点薄荷的奶白。
  // 薄荷青太亮，实心强调色按钮上的白字看不清 —— cls 挂上的 html.theme-mintchoc
  // 那段（css/mint-choc.css）把它们换成巧克力色的字。
  mintchoc: {
    accent:'#2ef0ff', bgBase:'#2a1818', bgSurface:'#352020', bgElevated:'#432828', bgHover:'#523131',
    textPrimary:'#e4fbfa', textMuted:'#9e7d77', textDim:'#bf9e98', textSecondary:'#b9e6e8', mask:'42,24,24',
    cls:'theme-mintchoc'
  },
  // 石墨：参考 maneater meme 那种平面设计。整片是暖一点的中性灰 + 上浓下淡的网点，
  // 唯一的亮色是 #c9e141 柠绿，比酸性的 #c8ff00 柔、只点在一两处；橄榄做次级。
  // 网点、橄榄边和黑块划屏在 css/graphite.css 和 themeSwap 里。
  graphite: {
    accent:'#c9e141', bgBase:'#252624', bgSurface:'#2e302d', bgElevated:'#3b3d3a', bgHover:'#474946',
    textPrimary:'#eceee6', textMuted:'#8d918a', textDim:'#a5a99f', textSecondary:'#cdd1c6', mask:'37,38,36',
    cls:'theme-graphite'
  },
  // 暮紫：参考 Écoute Chérie 那种平面设计。深梅紫的纸 + 颗粒，四角银色卷草，
  // 金色只做强调（原片后半段金线是画面里唯一亮的东西）。纸、画框在 css/dusk.css。
  dusk: {
    accent:'#e2b04a', bgBase:'#1c1320', bgSurface:'#261a2a', bgElevated:'#312235', bgHover:'#3d2b42',
    textPrimary:'#f1e8ef', textMuted:'#9a8a9c', textDim:'#b4a4b5', textSecondary:'#d6c9d6', mask:'28,19,32',
    cls:'theme-dusk'
  }
};
const FONT_PRESETS = {
  // Cormorant 只覆盖拉丁字母和数字；中文会自然落到用户选择的中文字体。
  // 这也是 1.0 原本的字体顺序，避免英文/数字被宋体字形接管。
  simsun: `'Cormorant Garamond', SimSun, '宋体', 'Songti SC', STSong, 'Noto Serif SC', serif`,
  stsong: `'Cormorant Garamond', STSong, '华文宋体', 'Songti SC', 'Noto Serif SC', SimSun, serif`,
  noto: `'Cormorant Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', STSong, SimSun, serif`
};
function _syncAppearancePresetUI() {
  document.querySelectorAll('[data-theme-temperature]').forEach(el => el.classList.toggle('active', el.dataset.themeTemperature === state.themeTemperature));
  document.querySelectorAll('[data-font-preset]').forEach(el => el.classList.toggle('active', el.dataset.fontPreset === state.fontPreset));
  document.querySelectorAll('[data-ui-shape]').forEach(el => el.classList.toggle('active', el.dataset.uiShape === state.uiShape));
}
// ── 自己调背景色 / 字色（用户：背景、字、强调色都要能单独调）──────────
// 只让人挑一个基色，其余几级照预设的比例推出来：底色往亮（浅底往暗）提 3%/6%/10% 出
// surface/elevated/hover，字色往底色退 20%/30%/42% 出 secondary/dim/muted（暖色预设量出来的比例）。
// 色温预设还是底子：没调的那样照旧跟预设，专属样式（暮紫的纸、石墨的网点）也照旧挂着。
// 读遮罩色、明暗的地方都要走这里，直接读 THEME_TEMPERATURES 就看不到自己调的底色。
function _isHex6(c) { return /^#[0-9a-fA-F]{6}$/.test(c || ''); }
function _hexToRgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function _mixHex(a, b, t) {
  const A = _hexToRgb(a), B = _hexToRgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function _hexLum(h) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = _hexToRgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function effectiveTheme() {
  const name = THEME_TEMPERATURES[state.themeTemperature] ? state.themeTemperature : 'warm';
  const preset = THEME_TEMPERATURES[name], t = Object.assign({}, preset);
  const bg = _isHex6(state.customBg) ? state.customBg : '', fg = _isHex6(state.customText) ? state.customText : '';
  if (bg) {
    const light = _hexLum(bg) > 0.4, lift = light ? '#000000' : '#ffffff';
    t.bgBase = bg; t.bgSurface = _mixHex(bg, lift, .03); t.bgElevated = _mixHex(bg, lift, .06); t.bgHover = _mixHex(bg, lift, .10);
    t.mask = _hexToRgb(bg).join(',');
    t.light = light;
    if (light) { t.border = 'rgba(17,17,17,0.10)'; t.borderMid = 'rgba(17,17,17,0.20)'; }
    else { delete t.border; delete t.borderMid; }
    // 底的明暗翻了、字又没自己调：预设的字色会和底糊成一片，借一套明暗对得上的字
    if (!fg && light !== !!preset.light) {
      const ref = THEME_TEMPERATURES[light ? 'paper' : 'warm'];
      t.textPrimary = ref.textPrimary; t.textSecondary = ref.textSecondary; t.textDim = ref.textDim; t.textMuted = ref.textMuted;
    }
  }
  if (fg) {
    t.textPrimary = fg; t.textSecondary = _mixHex(fg, t.bgBase, .20);
    t.textDim = _mixHex(fg, t.bgBase, .30); t.textMuted = _mixHex(fg, t.bgBase, .42);
  }
  return t;
}
// 空页面差值大字（#emptyEchoLayer）的透明度。用户：「可不可以自己对这个大字调透明度」
function _echoOpacityVal() {
  const v = parseFloat(state.echoOpacity);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
function applyEchoOpacity() {
  const v = _echoOpacityVal();
  document.documentElement.style.setProperty('--echo-opacity', String(v));
  const r = document.getElementById('echoOpacityRange'); if (r) r.value = v;
  const l = document.getElementById('echoOpacityLabel'); if (l) l.innerText = Math.round(v * 100) + '%';
}
function setEchoOpacity(v) { state.echoOpacity = parseFloat(v); applyEchoOpacity(); save(); }
// which: 'bg' | 'text'；color 传 '' = 回到跟预设
function setCustomTone(which, color) {
  const key = which === 'bg' ? 'customBg' : which === 'text' ? 'customText' : '';
  if (!key || (color && !_isHex6(color))) return;
  state[key] = color || '';
  applyThemeTemperature();
  applyAccentCSS(activeAccent());   // 亮强调色上的字跟底色和明暗走（--on-accent）
  save();
}
function syncCustomToneUI() {
  const t = effectiveTheme();
  [['customBgColor', state.customBg, t.bgBase], ['customTextColor', state.customText, t.textPrimary]].forEach(([id, own, shown]) => {
    const inp = document.getElementById(id); if (inp) inp.value = own || shown;
    const reset = document.querySelector(`[data-tone-reset="${id}"]`); if (reset) reset.hidden = !own;
  });
  const acc = document.getElementById('customColor'); if (acc && _isHex6(state.accentColor)) acc.value = state.accentColor;
}
function applyThemeTemperature() {
  const name = THEME_TEMPERATURES[state.themeTemperature] ? state.themeTemperature : 'warm';
  state.themeTemperature = name;
  const preset = THEME_TEMPERATURES[name], t = effectiveTheme(), root = document.documentElement;
  root.style.setProperty('--bg-base', t.bgBase); root.style.setProperty('--bg-surface', t.bgSurface);
  root.style.setProperty('--bg-elevated', t.bgElevated); root.style.setProperty('--bg-hover', t.bgHover);
  root.style.setProperty('--text-primary', t.textPrimary); root.style.setProperty('--text-muted', t.textMuted);
  root.style.setProperty('--text-dim', t.textDim); root.style.setProperty('--text-secondary', t.textSecondary);
  // 没写边框的配色回落到 :root 的默认值（removeProperty），切回深色时不会留着浅色的边
  if (t.border) root.style.setProperty('--border', t.border); else root.style.removeProperty('--border');
  if (t.borderMid) root.style.setProperty('--border-mid', t.borderMid); else root.style.removeProperty('--border-mid');
  root.style.setProperty('--bg-rgb', t.mask);
  root.classList.toggle('theme-light', !!t.light);
  // 自带专属样式的配色（薄荷巧克力）挂自己的类；切走时别的配色的类全摘掉
  Object.values(THEME_TEMPERATURES).forEach(x => { if (x.cls) root.classList.toggle(x.cls, x === preset); });
  root.style.colorScheme = t.light ? 'light' : 'dark';
  const mask = document.getElementById('bg-mask'); if (mask) mask.style.background = `rgba(${t.mask},${state.brightness})`;
  _syncAppearancePresetUI();
  syncCustomToneUI();
  // 遮罩色跟着色温变，合成后的背景亮度也就变了 —— auto 挡得重新判一次
  if (typeof applyBgLegibility === 'function') applyBgLegibility();
}
// 换色温 / 形状时，新样子从刚才点的地方画圆扩开（平面设计里常见的转场）。
// 用 View Transitions：旧画面截一张垫底，新画面按圆形遮罩长出来。浏览器不支持、系统开了「减少动态效果」、
// 窗口在后台时直接换，跟以前一样。
let _themeSwapXY = null;
if (typeof document !== 'undefined' && document.addEventListener)
  document.addEventListener('pointerdown', e => { _themeSwapXY = [e.clientX, e.clientY]; }, true);
// how === 'wipe'：换成石墨时不画圆，新画面从点的那一侧一刀切地横推过来（006 里黑块划屏那招），边缘不羽化。
function themeSwap(apply, how) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reduce || document.hidden) { apply(); return; }
  const [x, y] = _themeSwapXY || [innerWidth / 2, innerHeight / 2];
  _themeSwapXY = null;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const clipPath = how === 'wipe'
    ? (x > innerWidth / 2 ? ['inset(0 0 0 100%)', 'inset(0 0 0 0)'] : ['inset(0 100% 0 0)', 'inset(0 0 0 0)'])
    : [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`];
  const vt = document.startViewTransition(apply);
  vt.ready.then(() => document.documentElement.animate(
    { clipPath },
    how === 'wipe'
      ? { duration: 420, easing: 'cubic-bezier(.75,0,.2,1)', pseudoElement: '::view-transition-new(root)' }
      : { duration: 480, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }
  )).catch(() => {});
}
function setThemeTemperature(name) {
  if (!THEME_TEMPERATURES[name]) return;
  themeSwap(() => _setThemeTemperature(name), name === 'graphite' ? 'wipe' : undefined);
}
function _setThemeTemperature(name) {
  state.themeTemperature = name;
  state.accentColor = THEME_TEMPERATURES[name].accent;
  // 点预设 = 要这一整套，跟强调色一样，自己调过的底色和字色也回到预设
  state.customBg = ''; state.customText = '';
  state.bgAutoTint = false;
  const tint = document.getElementById('bgAutoTintToggle'); if (tint) tint.checked = false;
  applyThemeTemperature(); applyAccentCSS(state.accentColor); save();
  renderChatList(); renderMessages();
}
function applyFontPreset() {
  const name = FONT_PRESETS[state.fontPreset] ? state.fontPreset : 'simsun';
  state.fontPreset = name;
  document.documentElement.style.setProperty('--font', FONT_PRESETS[name]);
  _syncAppearancePresetUI();
}
function setFontPreset(name) {
  if (!FONT_PRESETS[name]) return;
  state.fontPreset = name; applyFontPreset(); save();
}

// ── 界面形状：外观里的第三个维度，和色温/字体各切各的 ──────────────
//
// 和色温的区别：色温改颜色变量，这个只改形状（切角）。两者正交，四种组合都成立。
//
// 关掉的时候不是拿 CSS 盖住 —— augmented-ui 整个库都靠属性选择器
// [data-augmented-ui] 生效，所以关掉时直接把这个属性摘掉，全库选择器失配，
// 一条 clip-path 都不会算，等于没装。形状写在惰性属性 data-aug 里备着。
// 这么做还有个好处：clip-path 会裁掉 box-shadow、且和 border-radius 互斥，
// 摘干净才能保证切回柔和时和从前一模一样。
const UI_SHAPES = {
  soft:       { label: '柔和' },   // 圆角，一直以来的样子
  industrial: { label: '工业' },   // 切角描边
  acid:       { label: '酸性' },   // 切角 + 半调网点 / 双斜杠标签 / 分段条那一套
  block:      { label: '色块' },   // 直角实心块 + 等宽小标签 + 超宽粗体，样式全在 css/block-theme.css
  choco:      { label: '巧克力' }  // 压格子的巧克力板 + 模具斜边 + 她的气泡被咬一口，样式全在 css/choco-shape.css
};
// 形状表：选择器 → augmented-ui 的形状串。集中写在这里，HTML 一行都不用改，
// 想加/撤哪个部件改这张表就行。个别要特殊形状的节点可以自带 data-aug 覆盖。
//
// 这一版只铺设置面板，聊天区一律不碰。
const AUG_SHAPES = {
  // 面板故意不带 border：它是半透明 + backdrop-filter，交给 aug 画边框会把
  // 毛玻璃盖掉。只切角、留着原生 border —— 角上被裁出的缺口正好是工业味。
  '.settings-panel':    'tl-clip tr-clip bl-clip br-clip',
  // both = border + inlay。只写 border 的话 --aug-inlay-bg 不生效，按钮会变成
  // 完全透明的一层描边，选中态也跟着看不见 —— 截图比对时栽过。
  '.appearance-choice': 'tl-clip br-clip both',
  '.settings-close':    'tl-clip br-clip both',
  '.stab':              'tl-clip tr-clip'
};
// 按开关状态挂上/摘掉 data-augmented-ui。
// 幂等，动态渲染出新节点后可以随便再调一次。
function syncAugShapeAttrs(root) {
  // 工业和酸性要切角；柔和和色块不挂（色块要的是方方正正的直角，切了角就不是块了）。
  // 具体切多少由 css 里各自那段给 --aug-* 赋值。
  const on = state.uiShape === 'industrial' || state.uiShape === 'acid';
  const scope = root || document;
  Object.keys(AUG_SHAPES).forEach(sel => {
    scope.querySelectorAll(sel).forEach(el => {
      if (on) el.setAttribute('data-augmented-ui', el.getAttribute('data-aug') || AUG_SHAPES[sel]);
      else el.removeAttribute('data-augmented-ui');
    });
  });
  // 自带 data-aug 但不在表里的散件
  scope.querySelectorAll('[data-aug]').forEach(el => {
    if (on) el.setAttribute('data-augmented-ui', el.getAttribute('data-aug'));
    else el.removeAttribute('data-augmented-ui');
  });
}
function applyUiShape() {
  const name = UI_SHAPES[state.uiShape] ? state.uiShape : 'soft';
  state.uiShape = name;
  const root = document.documentElement;
  root.classList.toggle('ui-industrial', name === 'industrial');
  root.classList.toggle('ui-acid', name === 'acid');
  root.classList.toggle('ui-block', name === 'block');
  root.classList.toggle('ui-choco', name === 'choco');
  syncAugShapeAttrs();
  _syncAppearancePresetUI();
}
function setUiShape(name) {
  if (!UI_SHAPES[name]) return;
  themeSwap(() => { state.uiShape = name; applyUiShape(); save(); });
}

// ═══════════════════════════════════════════════════════
// FONT SIZE (AI / User bubble text size, like official AI UIs)
// ═══════════════════════════════════════════════════════
function applyFontSizeCSS() {
  document.documentElement.style.setProperty('--ai-font-size', state.aiFontSize + 'px');
  document.documentElement.style.setProperty('--user-font-size', state.userFontSize + 'px');
}
function setAiFontSize(val) {
  state.aiFontSize = parseFloat(val); applyFontSizeCSS(); save();
  const lbl = document.getElementById('aiFontSizeLabel'); if (lbl) lbl.innerText = val + 'px';
}
function setUserFontSize(val) {
  state.userFontSize = parseFloat(val); applyFontSizeCSS(); save();
  const lbl = document.getElementById('userFontSizeLabel'); if (lbl) lbl.innerText = val + 'px';
}

// ═══════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  document.getElementById('sidebar').classList.toggle('sidebar-hidden', !state.sidebarOpen);
  document.getElementById('mobile-overlay').style.display =
    (state.sidebarOpen && isMobileLayout()) ? 'block' : 'none';
}
// 1. 创建媒体查询监听器 —— 必须和 CSS 移动端断点完全一致（含手机横屏矮屏），
//    否则横屏(宽916>768)会被误判成桌面端，强制展开 fixed 侧栏盖住整个聊天区
const mobileMq = window.matchMedia('(max-width: 768px), (max-height: 500px) and (orientation: landscape)');

function handleBreakpointChange() {
  const s = document.getElementById('sidebar');
  if (!s) return;
  const overlay = document.getElementById('mobile-overlay');

  if (mobileMq.matches) {
    // 【手机竖屏 / 手机横屏 / 电脑端拉小】移动布局：侧栏收起，避免盖住聊天区
    if (state.sidebarOpen) {
      state.sidebarOpen = false;
      s.classList.add('sidebar-hidden');
    }
    if (overlay) overlay.style.display = 'none';
  } else {
    // 【桌面布局】侧栏展开、遮罩隐藏
    if (!state.sidebarOpen) {
      state.sidebarOpen = true;
      s.classList.remove('sidebar-hidden');
    }
    if (overlay) overlay.style.display = 'none';
  }
}

// 2. 绑定监听（只在断点临界交替时触发，平时拖动或滚动绝不触发）
mobileMq.addEventListener('change', handleBreakpointChange);

// 3. 页面初始化时手动触发一次，确保初始状态正确
handleBreakpointChange();

// ── 手机端手势：在侧栏或遮罩上向左滑动即可收起侧栏 ──
(function initSidebarSwipe() {
  let startX = 0, startY = 0, tracking = false;
  const onStart = e => {
    if (!isMobileLayout() || !state.sidebarOpen) { tracking = false; return; }
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    tracking = true;
  };
  const onMove = e => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) * 1.5) { tracking = false; return; }  // 以纵向滚动为主，放弃手势
    if (dx < -50) { tracking = false; toggleSidebar(); }
  };
  const onEnd = () => { tracking = false; };
  ['sidebar', 'mobile-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
  });
})();

// ═══════════════════════════════════════════════════════
// CHATS
// ═══════════════════════════════════════════════════════
