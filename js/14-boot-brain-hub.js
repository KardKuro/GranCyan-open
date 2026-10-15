(async () => {
  const saved = await loadStateFromDB();

  // 🛡️ 安全检查
  try {
    if ((!saved.chats || saved.chats.length === 0)) {
      // 主数据为空：自动挑最完整的一份备份恢复
      const all = (typeof collectBackups === 'function') ? await collectBackups() : [];
      if (all.length > 0) {
        all.sort((a, b) => b.msgCount - a.msgCount || b.chatCount - a.chatCount || (b.ts || '').localeCompare(a.ts || ''));
        const best = all[0];
        console.log('🛡️ 主数据为空，从最完整备份恢复：', best.label, best.ts, best.msgCount + '条');
        /* ⚠️ 按墓碑滤一道。备份是删除**之前**拍的，直接整包塞回去等于把
           已经删掉的对话全部复活 —— 而且是在「主数据为空」这种本来就慌的时刻，
           人根本分不清哪些是找回来的、哪些是诈尸的。（Codex 审出来的。）
           ⚠️ 这里滤的是**启动时自动**恢复。设置里手动点「恢复备份」不滤 ——
              那是人明确要求「把那个时间点的东西拿回来」，包括当时还在的对话。 */
        const tomb = (saved.deletedChats && typeof saved.deletedChats === 'object')
                      ? saved.deletedChats : {};
        const kept = (best.chats || []).filter(c =>
            !(c && c.id != null && Object.prototype.hasOwnProperty.call(tomb, String(c.id))));
        const dropped = (best.chats || []).length - kept.length;
        saved.chats = kept;
        /* ⚠️ 消息数要按 kept 重算，不能用 best.msgCount —— 那是**过滤前**的数。
           被跳过的对话要是占了大头（备份 100 条，其中 90 条在被删的对话里），
           就会显示「恢复 10 个对话 / 100 条消息」，人会以为消息还在别处。 */
        const keptMsg = (typeof chatsMsgCount === 'function') ? chatsMsgCount(kept) : best.msgCount;
        showToast(`✓ 已从备份恢复 ${kept.length} 个对话 / ${keptMsg} 条消息`
          + (dropped ? `（跳过 ${dropped} 个你删掉的）` : ''), 'success', 3500);
      }
    } else {
      // 主数据非空但疑似回退（比高水位安全槽显著变少）：不覆盖用户数据，只提示可手动找回
      const safeMeta = JSON.parse(await idbGet('kuro_safe_meta') || 'null');
      if (safeMeta && typeof chatsMsgCount === 'function') {
        const nowMsg = chatsMsgCount(saved.chats);
        const drop = safeMeta.msgCount - nowMsg;
        if (drop >= 5 && nowMsg < safeMeta.msgCount * 0.8) {
          console.warn('🛡️ 启动检测到疑似对话丢失：', { safe: safeMeta, now: nowMsg });
          showToast(`⚠️ 检测到对话可能丢失（备份里有 ${safeMeta.msgCount} 条，当前 ${nowMsg} 条）。可在 设置→恢复备份 找回`, 'error', 7000);
        }
      }
    }
  } catch (e) {
    console.error('备份安全检查失败:', e);
  }

  if (saved.chats)   state.chats   = saved.chats;
  /* 三道关的第 3 道。configsVer 只在**真的从盘里读到过 configs** 时才落到 state 上：
     读不到就保持出厂的 -1＝「这台机器还没有自己的模型配置」，云端那份（≥0）才压得过它，
     全新设备第一次登录照样能把她的 API Key / 分组整套拉下来。 */
  if (saved.configs) {
    state.configs    = saved.configs;
    state.configsVer = Number(saved.configsVer) || 0;
    /* ⚠️ 基线必须在这儿立起来。不立的话 _lastSavedConfigsJson 还是 null，
       启动后**第一次**改配置时 _doSave 走的是「首次落盘只立基线不 +1」那条分支 ——
       她改的那一下版本号不涨，云端同版本的旧 configs 下一轮照样赢回来，
       于是「改了又弹回去」原样复现，而且一次报错都没有。（Codex 一审逮到的） */
    if (typeof _resyncConfigsBaseline === 'function') _resyncConfigsBaseline();
  }
  state.memories       = saved.memories;
  state.recentMemos    = saved.recentMemos || [];
  state.trash          = saved.trash;
  // 对话墓碑：三道关的第 3 道（漏了就是「删掉的对话刷新后又回来」，零报错）
  state.deletedChats   = (saved.deletedChats && typeof saved.deletedChats === 'object')
                          ? saved.deletedChats : {};
  state.autoMemory     = saved.autoMemory;
  state.background     = saved.background;
  state.brightness     = saved.brightness;
  state.accentColor    = saved.accentColor;
  state.themeTemperature = saved.themeTemperature || 'warm';
  // 自己调的底色 / 字色：三道关的第 3 道（漏了就是「刷新后颜色弹回预设」，零报错）
  state.customBg       = saved.customBg || '';
  state.customText     = saved.customText || '';
  state.echoOpacity    = Number.isFinite(saved.echoOpacity) ? saved.echoOpacity : 1;
  state.fontPreset     = saved.fontPreset || 'simsun';
  state.uiShape        = saved.uiShape || 'soft';
  // 壁纸取色：三道关的第 3 道（漏了就是「开关刷新后自己弹回去」，零报错）
  state.bgAutoTint     = !!saved.bgAutoTint;
  state.bgLegibility   = ['auto', 'on', 'off'].includes(saved.bgLegibility) ? saved.bgLegibility : 'auto';
  state.aiFontSize     = saved.aiFontSize;
  state.userFontSize   = saved.userFontSize;
  state.webSearchApiKey = saved.webSearchApiKey;
  // 这两个以前漏在这里没落回 state：IDB 明明存了，启动却读不进来，
  // 于是每次重开 tenorApiKey 都是空 —— 还没固化成 [[GIF:url]] 的 AI 表情包
  // 重渲染时走无 key 分支，在对话里变成「需配置 Giphy API Key」
  state.tenorApiKey    = saved.tenorApiKey || '';
  state.webSearchProvider = saved.webSearchProvider || 'tavily';
  state.thinkSumKey    = saved.thinkSumKey || '';
  state.voiceApiKey    = saved.voiceApiKey || '';
  state.voiceProvider  = saved.voiceProvider || 'deepgram';
  state.voiceApiBase   = saved.voiceApiBase || '';
  state.voiceModel     = saved.voiceModel || '';
  state.callBg         = saved.callBg || '';
  state.callBgMask     = saved.callBgMask ?? 0.82;
  state.callBgBlur     = saved.callBgBlur ?? 2;
  state.bgBlur         = saved.bgBlur;
  state.uiBlur         = saved.uiBlur;
  state.bandAiEnabled  = saved.bandAiEnabled !== false;
  state.bandAutoFetch  = saved.bandAutoFetch === true;
  state.callDnd        = !!saved.callDnd;
  state.ccMemoryEnabled = !!saved.ccMemoryEnabled;
  state.typingRhythmEnabled = saved.typingRhythmEnabled !== false;
  state.typingDraftPeek = !!saved.typingDraftPeek;
  state.userAvatar     = saved.userAvatar || '';
  state.showUserAvatar = !!saved.showUserAvatar;
  state.inkStream      = saved.inkStream !== false;
  state.inkRate        = +saved.inkRate || 14;
  state.favMessages    = saved.favMessages || [];
  state.favGroups      = saved.favGroups || [];
  state.favGroupsVer   = saved.favGroupsVer || 0;
  state.favGroupOps    = saved.favGroupOps || {};
  state.userName       = saved.userName || '';
  state.userNameAiVisible = saved.userNameAiVisible !== false;
  state.stickerNotes   = saved.stickerNotes || {};
  state.stickerAiOff   = (typeof _nullProto === 'function') ? _nullProto(saved.stickerAiOff) : (saved.stickerAiOff || {});
  state.stickerGroups  = saved.stickerGroups || [];      // 三道关的第 3 道，漏了刷新后分组栏全没
  // 表情名可以叫 __proto__，普通对象装不住这种键（见 12-math-media 的 _nullProto）
  state.stickerGroupOf = (typeof _nullProto === 'function') ? _nullProto(saved.stickerGroupOf) : (saved.stickerGroupOf || {});
  state.stickerGroupsVer = saved.stickerGroupsVer || 0;
  state.stickerGroupOps  = (typeof _nullProto === 'function') ? _nullProto(saved.stickerGroupOps) : (saved.stickerGroupOps || {});
  state.thinkOpen      = !!saved.thinkOpen;              // 三道关的第 3 道，漏了刷新后它的同意就没了
  state.thinkOpenVer   = saved.thinkOpenVer || 0;
  state.brainMemories  = saved.brainMemories || [];
  state.brainRerank    = saved.brainRerank !== false;   // 三道关的第 3 道，漏了开关每次刷新弹回默认
  state.proustMems     = saved.proustMems || [];
  // 旧版本没有记录记忆由谁写下。按当前产品约定，这些未知归属统一交给本地 Claude，
  // 避免升级后突然给十几个模型全部摊开。
  migrateLegacyMemoryOwners();
  // 本地 GPT 以前默认 auto，很多回复因此没有可展示的 reasoning summary。
  // 只迁移一次；用户之后手动改回 auto/off 时不会在下次启动被覆盖。
  const localGpt = state.configs.find(c => c.isLocalGpt);
  if (localGpt && !localGpt.thinkingDefaultMigrated) {
    if (!localGpt.thinkingMode || localGpt.thinkingMode === 'auto') localGpt.thinkingMode = 'always';
    localGpt.thinkingDefaultMigrated = true;
  }
  // 「本地 Claude / 本地 GPT」这个叫法不准：模型不在本机跑，走的是电脑上 CLI 的订阅额度。
  // 只改出厂默认名，她自己起过的名字不碰。
  const RENAME = { '本地 Claude (省Token)': '订阅 Claude', '本地 Claude': '订阅 Claude', '本地 GPT': '订阅 GPT' };
  for (const c of state.configs) {
    if ((c.isLocalClaude || c.isLocalGpt) && RENAME[c.nickname]) c.nickname = RENAME[c.nickname];
  }
  {
    const g = saved.proustGate || {};
    state.proustEnabled = g.enabled !== false;
    state.proustLastAt  = g.lastAt || 0;
    state.proustCount   = g.count || 0;
    state.proustDay     = g.day || '';
    state.proustRecent  = g.recent || [];
  }
  {
    // 偷看屏幕的闸门。这块漏了的话开关每次刷新都弹回关，而且一声不吭（同育儿室那次）
    const p = saved.peekGate || {};
    state.peekEnabled = !!p.enabled;
    state.peekLastAt  = p.lastAt || 0;
    state.peekCount   = p.count || 0;
    state.peekDay     = p.day || '';
    state.movieChimeMin = Number.isFinite(p.movieChimeMin) ? p.movieChimeMin : 4;   // 一起看时插嘴的频率，同一族的设置跟着存
    // 通话里用嗓子打断 / 沉默时主动开口（11-camera-call.js），也是「它自己开口」这一族
    state.callBargeMode = ['auto', 'headset', 'speaker', 'off'].includes(p.callBargeMode) ? p.callBargeMode : 'auto';
    state.callNudgeOff = !!p.callNudgeOff;
  }
  // 生命体征：状态默认开启；自主心跳默认关闭，必须由用户放行。
  state.vitalsOn = saved.vitalsOn !== false;
  state.vitalsHeartbeatOn = !!saved.vitalsHeartbeatOn;
  state.vitalsByModel = (saved.vitalsByModel && typeof saved.vitalsByModel === 'object') ? saved.vitalsByModel : {};
  if (saved.vitalsSleepPref && typeof saved.vitalsSleepPref === 'object') state.vitalsSleepPref = saved.vitalsSleepPref;
  state.dreamsOn = !!saved.dreamsOn;
  state.dreamsByModel = saved.dreamsByModel || {};
  state.dreamGateByModel = saved.dreamGateByModel || {};
  state.dreamMaterialCooldowns = saved.dreamMaterialCooldowns || {};
  state.ttsVoice       = saved.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  state.ttsVoiceZh     = saved.ttsVoiceZh || 'zh-CN-XiaoxiaoNeural';
  state.ttsRate        = parseInt(saved.ttsRate) || 0;
  state.ttsPitch       = parseInt(saved.ttsPitch) || 0;
  state.modelDiaries   = saved.modelDiaries || {};
  state.diaryHandover  = saved.diaryHandover || {};   // 交钥匙托管状态（持久化+上云）
  state.diaryEnabled   = !!saved.diaryEnabled;
  state.diaryDevView   = !!saved.diaryDevView;
  // 开发直查过去是「只写不读」的死变量，diaryUnlocked() 压根没查它，
  // 于是所有人的 IDB 里都躺着一个没人选过的 true —— 那是旧默认值的残渣，不是偏好。
  // 现在开关真生效了，照单全收会让日记本一开面板就全裸。一次性清成关，
  // 之后一切以用户在面板里的选择为准。
  if (!(await idbGet('kuro_diaryDevViewMigrated'))) {
    state.diaryDevView = false;
    await idbSet('kuro_diaryDevView', 'false');
    await idbSet('kuro_diaryDevViewMigrated', '1');
  }
  // 育儿室：开关 + 孩子名字。⚠️ 加新的持久化字段要过三道关——
  // _doSave 的写白名单、loadStateFromDB 的读白名单、这里的赋值。
  // 漏了任何一道，开关都会在刷新后悄悄弹回去，且没有任何报错。
  state.nurseryOn      = !!saved.nurseryOn;
  state.nurseryName    = saved.nurseryName || '';
  state.engawaOn       = !!saved.engawaOn;
  state.errandWorker   = typeof saved.errandWorker === 'string' ? saved.errandWorker : '';
  // 学习卡片：这是三道关里的第 3 道（最容易漏的一道），漏了就是
  // 「卡片明明落盘了，刷新后一张都不剩」，且零报错。
  state.studyOn        = !!saved.studyOn;
  state.studyCards     = Array.isArray(saved.studyCards) ? saved.studyCards : [];
  state.studyGroupSize = Number(saved.studyGroupSize) >= 1 ? Number(saved.studyGroupSize) : 10;
  state.studyGroupIds  = Array.isArray(saved.studyGroupIds) ? saved.studyGroupIds : [];
  state.studyLastKind  = saved.studyLastKind === 'review' ? 'review' : 'new';
  state.studyBook      = (saved.studyBook && typeof saved.studyBook.id === 'string')
    ? { id: saved.studyBook.id, pos: Math.max(0, parseInt(saved.studyBook.pos) || 0) } : null;
  state.studyGone      = (saved.studyGone && typeof saved.studyGone === 'object' && !Array.isArray(saved.studyGone)) ? saved.studyGone : {};
  state.studySeen      = (saved.studySeen && typeof saved.studySeen === 'object' && !Array.isArray(saved.studySeen)) ? saved.studySeen : {};
  // 点歌：同样是三道关，这是第 3 道
  state.musicOn        = !!saved.musicOn;
  // 技能开关（持久化三道关的第 3 道）。存的是「关掉的」，坏数据一律当成全开
  state.skillsOff      = (saved.skillsOff && typeof saved.skillsOff === 'object') ? saved.skillsOff : {};
  state.musicRecent    = Array.isArray(saved.musicRecent) ? saved.musicRecent : [];
  state.musicFav       = Array.isArray(saved.musicFav) ? saved.musicFav : [];
  // 情绪动力学默认开着，所以判据是「不等于 false」，不能写 !!saved.uedOn ——
  // 那样老档里没这个字段就变成关掉了，而且零报错。
  state.uedOn          = saved.uedOn !== false;
  // 共读同步默认开着，所以判据是「不等于 false」，不能写 !!saved.coreadOn ——
  // 那样老档里没这个字段就变成关掉了，而且零报错。
  state.coreadOn       = saved.coreadOn !== false;
  // 错题本 / 公式卡（57-mistakes.js、58-formulas.js）。坏数据当空，别让一条坏记录把整个面板打挂
  state.mistakes       = Array.isArray(saved.mistakes) ? saved.mistakes.filter(m => m && typeof m === 'object' && m.id) : [];
  state.fcards         = (saved.fcards && typeof saved.fcards === 'object' && !Array.isArray(saved.fcards)) ? saved.fcards : {};
  // 生活三件套。两道开关都默认开，所以判据都是「!== false」。
  // 月历那道单独一个，因为它进提示词就等于把身体数据发给模型。
  state.lifeOn         = saved.lifeOn !== false;
  state.lifeCycleShare = saved.lifeCycleShare !== false;
  state.lifeReceipts   = (saved.lifeReceipts && typeof saved.lifeReceipts === 'object') ? saved.lifeReceipts : {};
  state.lifePeriods    = Array.isArray(saved.lifePeriods) ? saved.lifePeriods : [];
  state.lifeAnnivs     = Array.isArray(saved.lifeAnnivs) ? saved.lifeAnnivs : [];
  state.lifePromises   = Array.isArray(saved.lifePromises) ? saved.lifePromises : [];
  state.moments        = Array.isArray(saved.moments) ? saved.moments : [];
  state.bubbleThemes   = Array.isArray(saved.bubbleThemes) ? saved.bubbleThemes : [];
  state.bubbleTheme    = typeof saved.bubbleTheme === 'string' ? saved.bubbleTheme : '';
  state.bubbleThemeBg  = saved.bubbleThemeBg !== false;
  state.musicPlaylists = Array.isArray(saved.musicPlaylists) ? saved.musicPlaylists : [];
  state.musicSearchHist = Array.isArray(saved.musicSearchHist) ? saved.musicSearchHist : [];
  state.musicSyncOps    = (saved.musicSyncOps && typeof saved.musicSyncOps === 'object') ? saved.musicSyncOps : {};
  state.musicLyricTrans = saved.musicLyricTrans !== false;   // 翻译默认开
  state.musicLyricRoma  = !!saved.musicLyricRoma;            // 罗马音默认关
  state.musicVis        = musicVisNorm(saved.musicVis);     // 认得的四种之外一律回落 aurora
  state.musicLyricStyle = musicLyricStyleNorm(saved.musicLyricStyle);
  // 世界书：三道关的第 3 道。过一遍 wbNorm，存了脏值（老版本、手改过的 IDB）也收成合法结构
  state.worldbook      = typeof wbNorm === 'function' ? wbNorm(saved.worldbook) : (saved.worldbook || null);
  state.wishbook       = Array.isArray(saved.wishbook) ? saved.wishbook : [];
  // 网页坞：同上，第 3 道
  state.webDockSrc     = saved.webDockSrc || '';
  state.webDockItems   = Array.isArray(saved.webDockItems) ? saved.webDockItems : [];
  state.webDockRemote  = Array.isArray(saved.webDockRemote) ? saved.webDockRemote : [];
  state.webDockSyncAt  = parseInt(saved.webDockSyncAt) || 0;
  // 旧版 blocks/content 曾为同一张卡各生成一个 askId：界面记得答案，API 历史却说没答。
  // 学习模块已随页面脚本加载；在首次渲染前对齐一次，修复结果跟下一次 save 一起落盘。
  const _studyAskFixed = typeof studyRepairLegacyAskIds === 'function' ? studyRepairLegacyAskIds() : 0;
  if (_studyAskFixed) {
    console.warn(`📇 修复了 ${_studyAskFixed} 条学习卡片历史的提问 ID`);
    setTimeout(() => save(), 0);
  }
  // 选了内置词书就在后台把它载进来：聊天里自动出题走的是同步的 studyGroup()，
  // 书没载好之前它只能看见已有的卡，载好了下一组新词才会从书里补
  if (state.studyBook && typeof studyLoadBook === 'function') studyLoadBook(state.studyBook.id).catch(() => {});
  // 单词卡入口的角标：开机画一次，之后每 5 分钟对一次（答错的词 10 分钟后回来，要能自己冒出来）
  if (typeof studyEntryBadge === 'function') {
    setTimeout(() => { try { studyEntryBadge(); } catch (_) {} }, 0);
    setInterval(() => { try { studyEntryBadge(); } catch (_) {} }, 5 * 60 * 1000);
  }
  // 整份存档定时落硬盘（02-state.js 的 stateSnapshotToDisk），跟 IndexedDB 分开放
  if (typeof stateSnapshotSchedule === 'function') stateSnapshotSchedule();
  state.diaryUnlock    = {};   // 解锁状态是运行时的，重启即重新锁上
  state.diaryReadWant  = {};   // 「下一轮把日记摊给模型看」的待读标记，也是运行时的

  // 修复 ID 计数器（防止冲突）——对话 id / 消息 id / 配置 id 一起播种，别再漏对话 id
  reseedIdCounter();
  // 历史数据里若已有对话撞成同 id，趁 merge 吞掉它之前先修好
  const _dupFixed = dedupeChatIds();
  if (_dupFixed) { reseedIdCounter(); console.warn('🛡️ 修复了 ' + _dupFixed + ' 个撞 id 的对话（防止被同步合并吞掉）'); }
  // 生成途中刷新 / 被 ROM 杀掉：streaming:true 已经落盘，重开后没有任何流在跑，
  // 气泡会永远卡在思考中（停止键也不出）。电脑上的活由 checkLiveAgentRuns 另行接回，它会自己覆写节点。
  const _staleFixed = clearStaleStreaming(state.chats);
  if (_staleFixed) { console.warn('🧹 ' + _staleFixed + ' 条上次没收完的回复已解除「生成中」'); setTimeout(() => save(), 0); }

  // 恢复上次对话
  state.activeChatId = saved.activeChatId
    ? parseInt(saved.activeChatId)
    : state.chats[0]?.id;

  // ── 原来的渲染调用，一行不少 ──
  if (!state.sidebarOpen) document.getElementById('sidebar').classList.add('sidebar-hidden');
  applyThemeTemperature();
  applyFontPreset();
  applyAccentCSS(state.accentColor);
  applyUiShape();
  applyEchoOpacity();
  applyFontSizeCSS();
  renderChatList();
  renderConfigs();
  renderModelPills();
  renderBackground();
  // 异步的（图要从 IDB 捞），不 await —— 让它晚一帧铺上，别拖住整个开机
  if (typeof applyBubbleTheme === 'function') applyBubbleTheme();
  renderMessages();
  renderMemoryBadge();
  renderConvSettingsBar();
  updateHeaderTokenInfo();
  updateInputHint();
  // 伴读书架是整页跳走的，那边的 ✕ / ← 返回 带着 #widgets 回来：摆回小组件，别掉在聊天里
  if (location.hash === '#widgets') {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    openHub('widgets');
  }
  document.getElementById('autoMemoryToggle').checked = state.autoMemory;
  const suaT = document.getElementById('showUserAvatarToggle');
  if (suaT) suaT.checked = !!state.showUserAvatar;
  if (typeof _syncInkSettings === 'function') _syncInkSettings();
  const unI = document.getElementById('userNameInput');
  if (unI) unI.value = state.userName || '';
  const unT = document.getElementById('userNameAiToggle');
  if (unT) unT.checked = state.userNameAiVisible !== false;
  renderUserName();
  const baT = document.getElementById('bandAiToggle');
  if (baT) baT.checked = state.bandAiEnabled !== false;
  const bauT = document.getElementById('bandAutoToggle');
  if (bauT) bauT.checked = state.bandAutoFetch === true;
  const dndT = document.getElementById('callDndToggle');
  if (dndT) dndT.checked = !!state.callDnd;
  // 思考链的糊面：把 body 上那两个类按当前状态挂好（默认不挂＝糊着）
  if (typeof applyThinkVeil === 'function') applyThinkVeil();
  if (typeof applyThinkLang === 'function') applyThinkLang();
  syncTtsSettingsUI();
  renderUserAvatar();
  updateFavBadge();
  checkUser();
  initMarked();
  initScrubber();
  updateGroupBoardBtn();

  // 手环自动同步默认关：没在手环面板里打开「自动同步」就一次都不请求
  // （电脑端那条链路会对连着的手机跑 adb）。定时器照挂，每次进来再看开关，打开后不用刷新页面。
  async function fetchBandData() {
    if (state.bandAutoFetch !== true) return;
    try {
      const r = await fetch(SERVER_BASE + '/api/band-data');
      state.bandData = await r.json();
      const bm = document.getElementById('bandModal');
      if (bm && !bm.classList.contains('hidden')) renderBandPanel();
    } catch {}
  }
  fetchBandData();
  setInterval(fetchBandData, 120000);

  // 电脑操控：上次那个活可能还在电脑上跑（App 被 ROM 杀掉过），把它认回来。
  // 回到前台也查一次 —— 手机上「切出去一会儿再切回来」比重启常见得多。
  if (typeof checkLiveAgentRuns === 'function') {
    setTimeout(checkLiveAgentRuns, 1500);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkLiveAgentRuns();
    });
  }

  // ── 记忆收件箱：把外面写进来的记忆吸收进 brainMemories ──
  // 谁往里写：AI 自己上网的那种离线会话（散步引擎，见 server.js 的 GRANCYAN_STROLL_HOME）。它写不进 IndexedDB
  // ——命令行根本没有页面，而且 IDB 按 origin 隔离——只能扔进服务端的收件箱等这里来取。
  // 服务端那侧的说明见 server.js 的「记忆收件箱」段。

  // 这个页面在收件箱里的身份。ack 是按消费者分开记的：Electron 那份和浏览器那份
  // 是两个 IDB 库，各自都该吸收一遍，不能谁先取到谁独吞（原来那版就是这个毛病）。
  // localStorage 与 IDB 同 origin 同生共死，正好当这个库的身份。
  function inboxConsumerId() {
    const K = 'gc_inbox_consumer';
    try {
      let v = localStorage.getItem(K);
      if (!v || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
        v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(K, v);
      }
      return v;
    } catch {
      // 读不到存储（隐私模式之类）：退回一个固定 id。最坏情况是这个页面和别的
      // 同类页面共用一份 ack，重复吸收由 addBrainMemory 的文本去重兜住。
      return 'c-nostorage';
    }
  }

  // 这座桥上的每一个请求都必须带超时。**每一个**——只给 GET 加超时是不够的：
  // 挂住的如果是 ack，函数就永远进不了 finally，_inboxBusy 永久为 true，
  // 之后每 5 分钟的轮询全部直接 return，收件箱就此静默停摆（零报错）。
  function brainFetch(url, opts, ms = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...(opts || {}), signal: ctl.signal })
      .finally(() => clearTimeout(timer));
  }

  let _inboxBusy = false;   // 防重入：一次挂住的请求不能让 5 分钟后的下一轮叠上来
  async function drainBrainInbox() {
    if (_inboxBusy) return;
    _inboxBusy = true;
    try {
      const consumer = inboxConsumerId();
      const r = await brainFetch(SERVER_BASE + '/api/brain-inbox?consumer=' + encodeURIComponent(consumer));
      if (!r.ok) return;
      const items = (await r.json())?.items || [];
      if (!items.length) return;

      const done = [];
      for (const it of items) {
        // 逐条隔离：一条坏数据不能掀翻整批。外层那个 catch 会让它后面的好记忆
        // 一起进不来，而且下一轮还是同样的顺序、同样地卡在这条上。
        try {
          // 出处拼进正文。收件箱一直收着 source 却在这里丢掉的话，那个参数就是
          // 个假承诺：投递时写了 --source，最后记忆里根本找不到它是哪来的。
          const text = it.source ? `${it.text}（出处：${it.source}）` : it.text;
          // 发号、按文本去重、clamp 全在 addBrainMemory 里，这里不插手。
          if (addBrainMemory({
            text, domain: it.domain,
            importance: it.importance, valence: it.valence, arousal: it.arousal,
          })) done.push(it.id);
        } catch (e) { console.warn('[记忆收件箱] 这条吸收失败，跳过:', it.id, e); }
      }
      if (!done.length) return;

      // ⚠️ 必须等 IDB 真的落盘再 ack。addBrainMemory 里调的 save() 是 **800ms 防抖**
      // （js/02-state.js:149），它返回的时候写盘根本还没开始——这中间关掉窗口，
      // 内存里的记忆没了、服务端却已经销账，这条就永久消失且零报错。
      // 直接调 _doSave() 绕过防抖；它是全量写，多跑一次也无妨。
      try { await _doSave(); }
      catch (e) { console.warn('[记忆收件箱] 落盘失败，这批不销账，下次再来:', e); return; }

      // ack 也要看状态码：fetch 不会因为 500 抛错，不检查的话会一边销账失败
      // 一边报喜，然后每 5 分钟重复弹一次同样的提示。
      const ack = await brainFetch(SERVER_BASE + '/api/brain-inbox/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumer, ids: done }),
      });
      if (!ack.ok) { console.warn('[记忆收件箱] 销账失败 HTTP', ack.status, '——下次会重来一遍'); return; }

      if (typeof renderBrainMemList === 'function') renderBrainMemList();
      showToast(`克克逛回来了，带了 ${done.length} 条记忆`, 'info', 3600);
    } catch (e) {
      if (e && e.name !== 'AbortError') console.warn('[记忆收件箱] 这轮没取成:', e);
    } finally { _inboxBusy = false; }
  }
  // ── 记忆快照：让 AI 出门的时候带着记忆（收件箱的反方向）──
  // 散步会话是个命令行进程，同样读不到这里的 IndexedDB，所以只能由页面主动推出去。
  // 服务端那侧见 server.js 的「记忆快照」段，隐私说明也在那儿。
  // FNV-1a。要的是「实际发出去的内容有没有变」，所以直接对 payload 整串算。
  // 之前用的是「条数 + 首条 id + 总文本长度」，那个太粗：改一个字（长度不变）、
  // 调 importance、钉住/取消钉住、lastAccess 变了导致权重变——全都检测不到，
  // 于是页面会认定「没变」并且**在整个生命周期里再也不推**，零报错。
  function brainHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  let _snapFingerprint = '';
  let _snapBusy = false;   // 同 drain：挂住的 POST 不能让下一轮叠上来，也防旧快照晚到覆盖新的
  async function pushBrainSnapshot() {
    if (_snapBusy) return;
    _snapBusy = true;
    try {
      const now = Date.now();
      const memories = (state.brainMemories || []).map(m => ({
        text: m.text, domain: m.domain, importance: m.importance, pinned: !!m.pinned,
        // 权重在这里算：brainWeight 是这套遗忘曲线的唯一权威，服务端再实现一遍必然漂移
        weight: (typeof brainWeight === 'function') ? brainWeight(m, now) : 0,
        createdAt: m.createdAt,
      }));
      const body = JSON.stringify({ consumer: inboxConsumerId(), memories });
      // 对真正要发的那串算指纹。九百多条约十几万字符，线性走一遍的开销远小于
      // 每 5 分钟白推一次几百 KB。
      const fp = brainHash(body);
      if (fp === _snapFingerprint) return;

      const r = await brainFetch(SERVER_BASE + '/api/brain-snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      // 推成功才记指纹。失败就让下一轮重来——记了指纹却没推上去的话，
      // 记忆要等到下次内容变化才有机会出门，而那可能是好几天以后。
      if (r.ok) _snapFingerprint = fp;
    } catch (e) {
      if (e && e.name !== 'AbortError') console.warn('[记忆快照] 这轮没推成:', e);
    } finally { _snapBusy = false; }
  }

  const _brainSync = () => { drainBrainInbox().finally(pushBrainSnapshot); };
  setTimeout(_brainSync, 2000);
  setInterval(_brainSync, 300000);
})().catch(e => {
  console.error('[启动失败] 本地数据库没有打开，已停止初始化以保护现有数据：', e);
  // checkUser 轮不到了，启动页得自己收，不然下面这条 toast 被盖着谁也看不见
  try { bootSplashDone(); } catch {}
  try { showToast('本地数据暂时打不开，已停止写入保护原数据。请完全关闭 GranCyan 后重开。', 'error', 10000); } catch {}
});
// ── 星空动画 ──
(function initStars() {
  const modal = document.getElementById('authModal');
  const canvas = document.getElementById('starCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let stars = [], W, H, raf;

  function resize() {
    // 按 DPR 开画布，不然高分屏上星星是糊的一团
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeStars(n) {
    stars = [];
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.2 + 0.3,       // 半径 0.3~1.5px
        vx: (Math.random() - 0.5) * 0.20,   // 水平漂移速度
        vy: (Math.random() - 0.5) * 0.14,   // 垂直漂移速度
        alpha: Math.random(),                // 当前透明度
        dAlpha: (Math.random() * 0.008 + 0.003) * (Math.random() < 0.5 ? 1 : -1), // 闪烁方向
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      // 漂移
      s.x += s.vx; s.y += s.vy;
      // 边界环绕
      if (s.x < 0) s.x = W; if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H; if (s.y > H) s.y = 0;
      // 闪烁
      s.alpha += s.dAlpha;
      if (s.alpha >= 1)   { s.alpha = 1;   s.dAlpha *= -1; }
      if (s.alpha <= 0.05){ s.alpha = 0.05; s.dAlpha *= -1; }
      // 绘制
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.alpha.toFixed(3)})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  }

  // 当 modal 显示时才跑动画，隐藏时停掉省性能
  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('hidden')) {
      // 被踢回登录（会话吊销、手动点「去登录」）时播一遍进场；开机那次启动页还盖着，它自己会跳过
      if (!raf && typeof authWallEnter === 'function') authWallEnter();
      resize();
      makeStars(250);
      if (!raf) tick();
    } else {
      cancelAnimationFrame(raf);
      raf = null;
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  // 只在登录框可见时才重建画布：canvas.width 赋值会清空画布，隐藏时也跑会白白触发重绘/闪一下
  window.addEventListener('resize', () => {
    if (modal.classList.contains('hidden')) return;
    resize(); makeStars(180);
  });
})();
// ═══════════════════════════════════════════════════════
// 最近记忆（独立数据）
// ═══════════════════════════════════════════════════════
function addRecentMemo(text) {
  if (!text?.trim()) return;
  if (!state.recentMemos) state.recentMemos = [];
  state.recentMemos.unshift({ id: nextId(), text: text.trim(), createdAt: Date.now(), enabled: true });
  save();
}

function deleteRecentMemo(id) {
  if (!state.recentMemos) return;
  state.recentMemos = state.recentMemos.filter(m => m.id !== id);
  save(); renderRecentMemoList();
  showToast('最近记忆已删除');
}

function toggleRecentMemoEnabled(id) {
  const m = (state.recentMemos || []).find(m => m.id === id);
  if (!m) return;
  m.enabled = m.enabled === false ? true : false;
  save(); renderRecentMemoList();
}

function renderRecentMemoList() {
  if (_currentMemTab !== 'recent') return;
  const el = document.getElementById('memoryList');
  if (!state.recentMemos || !state.recentMemos.length) {
    el.innerHTML = '<div class="memory-empty">暂无最近记忆，在下方输入框添加吧♪(´▽｀)</div>'; return;
  }
  const hits = state.recentMemos.filter(m => memSearchHit(m.text));
  if (!hits.length) { el.innerHTML = memSearchEmptyHtml('最近记忆'); return; }
  el.innerHTML = memSearchCountHtml(hits.length, state.recentMemos.length) + hits.map(m => {
    const isEnabled = m.enabled !== false;
    const date = m.createdAt
      ? new Date(m.createdAt).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
      : '–';
    return `
    <div class="memory-item" id="ritem-${m.id}" style="opacity:${isEnabled?1:0.45}">
      <div style="flex:1;min-width:0">
        <span class="memory-text">${memHi(m.text)}</span>
        <div style="font-size:10px;color:var(--text-muted);margin-top:3px">🕐 ${date}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;align-items:flex-start">
        <button class="mem-toggle${isEnabled?' on':''}" onclick="toggleRecentMemoEnabled(${m.id})"
          title="${isEnabled?'已启用，点一下停用':'已停用，点一下启用'}">${isEnabled?'✓':'禁'}</button>
        <button class="memory-edit-btn" onclick="startEditRecentMemo(${m.id})">✎</button>
        <button class="memory-del" onclick="deleteRecentMemo(${m.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

function startEditRecentMemo(id) {
  const el = document.getElementById('ritem-' + id);
  if (!el) return;
  const mem = (state.recentMemos || []).find(m => m.id === id);
  if (!mem) return;
  el.innerHTML = `
    <div style="width:100%">
      <textarea class="memory-edit-ta" id="redit-${id}">${escHtml(mem.text)}</textarea>
      <div class="memory-edit-btns">
        <button class="mem-cancel-btn" onclick="renderRecentMemoList()">取消</button>
        <button class="mem-save-btn" onclick="saveRecentMemoEdit(${id})">保存</button>
      </div>
    </div>`;
  document.getElementById('redit-' + id)?.focus();
}

function saveRecentMemoEdit(id) {
  const ta = document.getElementById('redit-' + id);
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;
  const mem = (state.recentMemos || []).find(m => m.id === id);
  if (mem) { mem.text = newText; save(); renderRecentMemoList(); showToast('✓ 最近记忆已更新', 'success'); }
}
// ═══════════════════════════════════════════════════════
// 高级记忆 (Ombre-lite)：参考 Ombre-Brain 的情感坐标 + 遗忘曲线 + 相关性浮现
// 每条记忆：重要度(1-10)、效价 valence(-1~1 负面→正面)、唤醒 arousal(0~1 平静→激烈)、
// 领域、钉住(不衰减)、已解决(权重降为 35%)。记忆只会淡去(归档)，不会被衰减删除。
// ═══════════════════════════════════════════════════════
const BRAIN_HALFLIFE_DAYS = 14;   // 基础半衰期：重要度5、无情绪的记忆 14 天权重减半
const BRAIN_PROMPT_BUDGET = 1200; // 注入系统提示的字符预算
const BRAIN_MIN_WEIGHT = 0.05;    // 低于该权重视为"已淡去"，不再注入（UI 里仍可见）

function defaultMemoryOwnerId() {
  return state.configs?.find(c => c.isLocalClaude)?.id
    ?? state.configs?.find(c => /本地\s*claude/i.test(c.nickname || ''))?.id
    ?? state.configs?.[0]?.id
    ?? null;
}

function migrateLegacyMemoryOwners() {
  const ownerId = defaultMemoryOwnerId();
  if (ownerId == null) return false;
  let changed = false;
  for (const m of [...(state.brainMemories || []), ...(state.proustMems || [])]) {
    if (m && m.modelIds == null) { m.modelIds = [ownerId]; changed = true; }
  }
  if (changed) setTimeout(() => save(), 0);
  return changed;
}

// modelIds 数组是逐条授权名单；缺省/null 是旧数据，运行时也按本地 Claude 处理。
// 用字符串比较，兼容旧配置的数字 id 与云端同步后可能出现的字符串 id。
function memoryAllowedForModel(m, modelId) {
  if (!m) return false;
  const ids = m.modelIds == null ? [defaultMemoryOwnerId()].filter(id => id != null) : m.modelIds;
  return ids.some(id => String(id) === String(modelId));
}

function memoryModelAccessHtml(m, kind) {
  if (!state.configs?.length) return '';
  const allowed = state.configs.filter(c => memoryAllowedForModel(m, c.id));
  const accessLabel = allowed.length === 0 ? '未授权模型'
    : allowed.length === 1 ? (allowed[0].nickname || allowed[0].modelName || '1 个模型')
    : `${allowed.length} 个模型`;
  return `<details class="memory-model-access">
    <summary><span class="memory-model-chevron">›</span><span>可用模型</span><strong>${escHtml(accessLabel)}</strong></summary>
    <div class="memory-model-options">
    ${state.configs.map(c => {
      const on = memoryAllowedForModel(m, c.id);
      return `<label class="memory-model-option${on ? ' selected' : ''}" title="${escHtml(c.nickname || c.modelName || '模型')}">
        <input type="checkbox" ${on ? 'checked' : ''} onchange='toggleMemoryModelAccess("${kind}", ${JSON.stringify(String(m.id))}, ${JSON.stringify(String(c.id))}, this.checked, this)'>
        <span>${escHtml(c.nickname || c.modelName || '模型')}</span>
      </label>`;
    }).join('')}
    </div>
  </details>`;
}

function toggleMemoryModelAccess(kind, memoryId, modelId, checked, input = null) {
  const list = kind === 'proust' ? (state.proustMems || []) : (state.brainMemories || []);
  const m = list.find(x => String(x.id) === String(memoryId));
  if (!m) return;
  let ids = m.modelIds == null ? [defaultMemoryOwnerId()].filter(id => id != null) : [...m.modelIds];
  ids = ids.filter((id, i, a) => a.findIndex(x => String(x) === String(id)) === i);
  if (checked && !ids.some(id => String(id) === String(modelId))) ids.push(modelId);
  if (!checked) ids = ids.filter(id => String(id) !== String(modelId));
  m.modelIds = ids;
  save();
  if (input) {
    input.closest('.memory-model-option')?.classList.toggle('selected', checked);
    const details = input.closest('.memory-model-access');
    const allowed = (state.configs || []).filter(c => memoryAllowedForModel(m, c.id));
    const label = allowed.length === 0 ? '未授权模型'
      : allowed.length === 1 ? (allowed[0].nickname || allowed[0].modelName || '1 个模型')
      : `${allowed.length} 个模型`;
    const strong = details?.querySelector('summary strong');
    if (strong) strong.textContent = label;
  }
}

function addBrainMemory(opts) {
  const text = (opts.text || '').trim();
  if (!text) return null;
  state.brainMemories = state.brainMemories || [];
  const dup = state.brainMemories.find(m => m.text.toLowerCase() === text.toLowerCase());
  if (dup) {
    if (opts.modelId != null && dup.modelIds != null && !memoryAllowedForModel(dup, opts.modelId)) dup.modelIds.push(opts.modelId);
    dup.lastAccess = Date.now(); dup.accessCount = (dup.accessCount || 0) + 1; save(); return dup;
  }
  const clamp = (v, lo, hi, d) => { v = parseFloat(v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
  const m = {
    id: nextId(), text,
    domain: (opts.domain || '').trim().slice(0, 12) || '综合',
    importance: clamp(opts.importance, 1, 10, 5),
    valence: clamp(opts.valence, -1, 1, 0),
    arousal: clamp(opts.arousal, 0, 1, 0.3),
    modelIds: [opts.modelId ?? defaultMemoryOwnerId()].filter(id => id != null),
    pinned: !!opts.pinned, resolved: false,
    createdAt: Date.now(), lastAccess: Date.now(), accessCount: 0
  };
  state.brainMemories.unshift(m);
  save(); renderMemoryBadge();
  return m;
}

// 权重 = 重要度 × 遗忘曲线 × 状态修正。情绪越强烈衰减越慢（艾宾浩斯改良版，同 Ombre-Brain）
function brainWeight(m, now = Date.now()) {
  const imp = (m.importance || 5) / 10;
  if (m.pinned) return Math.max(1.2, imp * 1.5); // 钉住：永不衰减，永远够格浮现
  const intensity = Math.min(1, Math.abs(m.valence || 0) * 0.5 + (m.arousal || 0) * 0.5);
  const halfLife = BRAIN_HALFLIFE_DAYS * (0.5 + imp) * (1 + 2 * intensity);
  const days = Math.max(0, now - (m.lastAccess || m.createdAt)) / 86400000;
  const recency = Math.exp(-Math.LN2 * days / halfLife);
  return imp * recency * (m.resolved ? 0.35 : 1) * (1 + 0.4 * intensity);
}

/* ── 检索的第二段：重排（reranker） ──────────────────────────────────
   老的挑选逻辑是单段的：score = 权重 × (1 + 2×相关性)，按 score 排下来塞满 1200 字符预算。
   问题出在"相关性=0 时 score 仍然等于权重"——于是每一轮，不管你在说什么，预算都会被
   几条高重要度的记忆填满。那不是检索，那是把通讯录整本念一遍，而且它挤掉了真正相关的那条。

   现在拆成两段（粗召回 → 重排），这是 IR 里 retriever + cross-encoder 的轻量版：
     第一段 粗召回：见下面 _brainPool——按来源分配名额，凑出候选池。
     第二段 重排  ：改由**相关性主导**（权重只在 0.55~1.0 之间做微调），并且卡三道：
                    · 相关性门限——低于 BRAIN_REL_MIN 的一律不算"被想起"，
                      只留 BRAIN_BG_SLOTS 个名额给权重最高的当背景板（完全不给会显得失忆）
                    · MMR 去冗余——和已选记忆过于雷同的跳过，别让同一件事占三份预算
                    · 预算按需用——没有那么多相关的就少塞，不硬凑满 */
const BRAIN_RERANK_POOL  = 14;    // 粗召回交给重排的候选数
const BRAIN_REL_MIN      = 0.055; // 相关性门限：低于这个不算"被想起"（噪声底线实测在 0.02~0.04）
const BRAIN_BG_SLOTS     = 2;     // 留给"不相关但很重要"的背景名额
const BRAIN_MMR_DUP      = 0.62;  // 与已选记忆的重复度上限
const BRAIN_QUERY_TURNS  = 3;     // 查询取最近几条用户消息
const BRAIN_QUERY_DECAY  = [1, 0.55, 0.3];   // 越早的那条说得越不算数
const BRAIN_REL_SLOTS    = 7;     // 候选池里纯按相关性发的名额（见 _brainPool）
const BRAIN_PIN_SLOTS    = 6;     // 候选池里 pinned 最多占几个（见 _brainPool）
const BRAIN_PIN_BUDGET   = 0.5;   // pinned 最多吃掉多少比例的字符预算（剩下的留给相关记忆）

// 单字要滤虚词（二元组不用，"的雨"这种组合本身就带信息）
const _BRAIN_STOP = new Set('的了是我你他她它在就和有也都不一个这那么呢吧啊被把很还要会对上下去来到说给'.split(''));
function _brainGrams(s) {
  const set = new Set();
  (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(w => { if (w.length > 2) set.add(w); });
  const cjk = String(s).replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    if (i < cjk.length - 1) set.add(cjk.slice(i, i + 2));       // 二元组：精确
    if (!_BRAIN_STOP.has(cjk[i])) set.add(cjk[i]);              // 单字：宽松，接住"雨""累""名字"这种词根
  }
  return set;
}

/* IDF：记忆库里到处都是的字组（"今天""怎么"）几乎不带区分度，罕见的才是信号。
   老实现所有 gram 等权，这是噪音的另一半来源。
   表随记忆库变化重算——key 用 条数+总字数，改写一条记忆几乎必然改变总字数。 */
let _brainIdf = null, _brainIdfKey = '', _brainDocVecs = new Map();
function _brainIdfTable() {
  const mems = state.brainMemories || [];
  const key = mems.length + ':' + mems.reduce((s, m) => s + (m.text || '').length + (m.domain || '').length, 0);
  if (_brainIdf && _brainIdfKey === key) return _brainIdf;
  const df = new Map();
  for (const m of mems) {
    _brainGrams((m.text || '') + ' ' + (m.domain || '')).forEach(g => df.set(g, (df.get(g) || 0) + 1));
  }
  const N = Math.max(1, mems.length);
  const idf = new Map();
  df.forEach((c, g) => idf.set(g, Math.log(1 + N / (1 + c))));
  _brainIdf = idf; _brainIdfKey = key; _brainDocVecs = new Map();   // 文档向量跟着一起失效
  return idf;
}
// 「条数+总字数」认不出等长改写（张三→李四、云端合并进来的等长新版本），IDF 里新词权重一直是 0。
// 按内容哈希再核一次 —— 只在每次检索开头调一遍（_brainIdfTable 本身每条记忆都会调，那里只能用廉价的键）。
let _brainIdfContentKey = '';
function _brainIdfSyncContent() {
  const mems = state.brainMemories || [];
  const ck = mems.length + ':' + _brainVecHash(mems.map(m => (m.text || '') + '\u0000' + (m.domain || '')).join('\u0001'));
  if (ck !== _brainIdfContentKey) { _brainIdf = null; _brainIdfContentKey = ck; }
}
// 一条记忆的向量：{vec: Map<gram, idf>, norm}
function _brainDocVec(m) {
  const idf = _brainIdfTable();
  const ck = m.id + ':' + (m.text || '').length;   // 内容变了由 _brainIdfSyncContent 连同这张表一起清
  const hit = _brainDocVecs.get(ck);
  if (hit) return hit;
  const vec = new Map();
  let sq = 0;
  _brainGrams((m.text || '') + ' ' + (m.domain || '')).forEach(g => {
    const w = idf.get(g) || 0;
    if (w > 0) { vec.set(g, w); sq += w * w; }
  });
  const out = { vec, norm: Math.sqrt(sq) || 1 };
  _brainDocVecs.set(ck, out);
  return out;
}
/* 查询向量：最近 BRAIN_QUERY_TURNS 条用户消息，越近权重越高。
   只取最后一条的话，一句"嗯 那这样呢"会让相关性全线归零 —— 于是又退化成纯权重排序。
   记忆库里从没出现过的 gram 不进查询向量（标准 IR 的 OOV 处理）：它命中不了任何候选，
   却会撑大分母，把所有相关性一起压到门限以下。 */
function _brainQueryVec(chat) {
  const idf = _brainIdfTable();
  const texts = [];
  if (chat?.nodes && chat.headId) {
    let cur = chat.headId, hops = 0;
    while (cur && chat.nodes[cur] && hops++ < 40 && texts.length < BRAIN_QUERY_TURNS) {
      const n = chat.nodes[cur];
      if (n.role === 'user') texts.push(getMsgPlainText(n) || '');
      cur = n.parentId;
    }
  }
  const vec = new Map();
  texts.forEach((t, i) => {
    const decay = BRAIN_QUERY_DECAY[i] ?? 0.2;
    _brainGrams(t).forEach(g => {
      const w = (idf.get(g) || 0) * decay;
      if (w > 0 && w > (vec.get(g) || 0)) vec.set(g, w);   // 取 max：同一个词说三遍不该算三倍
    });
  });
  let sq = 0;
  vec.forEach(w => { sq += w * w; });
  return { vec, norm: Math.sqrt(sq), preview: (texts[0] || '').slice(0, 40) };
}
function _brainCos(q, d) {
  if (!q.norm || !d.norm) return 0;
  let dot = 0;
  // 遍历短的那边
  const [a, b] = q.vec.size <= d.vec.size ? [q.vec, d.vec] : [d.vec, q.vec];
  a.forEach((w, g) => { const o = b.get(g); if (o) dot += w * o; });
  return dot / (q.norm * d.norm);
}

// 文本相关性：IDF 加权余弦（没有向量库时最接近 embedding 的做法）。
// 保留原签名——外部若拿 query 字符串来问，照样能答。
function brainRelevance(m, query) {
  if (!query) return 0;
  const idf = _brainIdfTable();
  const vec = new Map();
  let sq = 0;
  _brainGrams(query).forEach(g => {
    const w = idf.get(g) || 0;
    if (w > 0) { vec.set(g, w); sq += w * w; }
  });
  return _brainCos({ vec, norm: Math.sqrt(sq) }, _brainDocVec(m));
}

// 上一轮到底浮现了什么、为什么——记忆管理面板里能看（调噪音全靠它）
let _lastBrainPick = null;

/* ── 语义路（向量）──
   词法路只认字面：「室友觉得跟机器人聊天很怪」对不上「朋友说我什么都和AI说」，rel=0，排在几百名开外。
   bge-small-zh 能对上（排第 2）。拿近千条记忆样本测了 10 句「字面不像、意思像」的问句：
   词法 top7 命中 4/10，词法 ∪ 向量前 2 = 7/10；字面能对上的对照句 3/3 不变。
   ⚠ 向量分**不能当相关性门限用**：「今天午饭吃什么」和真相关的问句 top1 都在 0.57 上下，
   绝对值分不出有关没关。所以它只发名额（BRAIN_VEC_SLOTS 条，why='vec'），不改 rel、不刷新 lastAccess
   ——否则无关的也被当成「想起」，越刷越常出现，自我强化。
   全程尽力而为：模型/wasm 拉不到、没有 IndexedDB、首轮还没加载完 → 这一路静默缺席，词法照常。
   关掉：localStorage 'gc.brainVec' = 'off'（手机流量党用；首次要下 ~24MB 模型 + ~14MB wasm）。 */
const BRAIN_VEC_SLOTS   = 2;       // 语义路发几个名额
const BRAIN_VEC_SPREAD  = 0.15;    // top1 比中位数高不出这么多 = 问句没内容（「嗯嗯」实测 0.097），这轮不发
const BRAIN_VEC_WAIT_MS = 1500;    // 发送前最多等查询向量多久
const BRAIN_VEC_MODEL   = 'Xenova/bge-small-zh-v1.5';
// 必须用 +esm：dist/transformers.web.min.js 里有裸模块名 'onnxruntime-web/webgpu'，浏览器直接 import 会炸
const BRAIN_VEC_LIB     = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
const BRAIN_VEC_QPREFIX = '为这个句子生成表示以用于检索相关文章：';   // bge-zh 的查询前缀，文档侧不加
const _brainVec = { pipe: null, loading: null, deadUntil: 0, docs: new Map(), db: null, indexing: false, q: null, lock: Promise.resolve() };
// 同一个 ort 会话别并发 run（后台建索引和发送前的查询会撞上）：排队。一批 16 条约半秒，查询最多等这么久
function _brainVecRun(input) {
  const p = _brainVec.lock.then(() => _brainVec.pipe(input, { pooling: 'cls', normalize: true }));
  _brainVec.lock = p.catch(() => {});
  return p;
}

function _brainVecOn() {
  if (typeof indexedDB === 'undefined') return false;
  try { return localStorage.getItem('gc.brainVec') !== 'off'; } catch (_) { return true; }
}
const _brainVecDocText = m => ((m.text || '') + ' ' + (m.domain || '')).slice(0, 500);
function _brainVecHash(s) {   // FNV-1a：只用来判断「这条记忆的文字改没改」
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
// 单独一个库，不碰主库的版本号和 schema
function _brainVecDb() {
  if (_brainVec.db) return _brainVec.db;
  _brainVec.db = new Promise((res, rej) => {
    const r = indexedDB.open('grancyan-brainvec', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('v');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  _brainVec.db.catch(() => { _brainVec.db = null; });
  return _brainVec.db;
}
async function _brainVecLoad() {
  if (_brainVec.pipe) return _brainVec.pipe;
  if (Date.now() < _brainVec.deadUntil) return null;
  if (!_brainVec.loading) {
    _brainVec.loading = (async () => {
      const T = await import(BRAIN_VEC_LIB);
      T.env.allowLocalModels = false;
      // 每个来源配自己的 wasm 路径：同源 server 的 wasm 也走 /api/ort/（jsdelivr 上 28MB，这台机器 65KB/s）；
      // 退到 huggingface.co 的（安卓离线页）用 ort 默认的 jsdelivr。版本号取 transformers 内置 ort 的，对不上加载会失败
      const ortVer = T.env.backends?.onnx?.versions?.web;
      const hosts = [];
      if (/^https?:$/.test(location.protocol)) hosts.push([location.origin + '/api/hf/', ortVer ? `${location.origin}/api/ort/${ortVer}/` : undefined]);
      hosts.push(['https://huggingface.co/', undefined]);
      let pipe = null, lastErr = null;
      for (const [h, wasm] of hosts) {
        T.env.remoteHost = h;
        if (T.env.backends?.onnx?.wasm) {
          T.env.backends.onnx.wasm.wasmPaths = wasm;
          // 推理挪进 ort 自带的 worker：主线程上跑 wasm 一批 16 条要卡 3~6 秒，
          // 近千条记忆首次建索引＝界面冻几分钟（实测 160 条 53 秒、心跳只跳 21 次）
          T.env.backends.onnx.wasm.proxy = true;
        }
        try { pipe = await T.pipeline('feature-extraction', BRAIN_VEC_MODEL, { dtype: 'q8', device: 'wasm' }); break; }
        catch (e) { lastErr = e; }
      }
      if (!pipe) throw lastErr;
      // 旧向量从 IDB 读回来，只认模型名一致的
      try {
        const db = await _brainVecDb();
        await new Promise((res) => {
          const req = db.transaction('v').objectStore('v').openCursor();
          req.onsuccess = () => {
            const c = req.result; if (!c) return res();
            if (c.value?.model === BRAIN_VEC_MODEL) _brainVec.docs.set(c.key, c.value);
            c.continue();
          };
          req.onerror = () => res();
        });
      } catch (_) {}
      _brainVec.pipe = pipe;
      return pipe;
    })().catch(e => {
      console.warn('[记忆·语义路] 模型加载失败，10 分钟内只用词法：', e?.message || e);
      _brainVec.deadUntil = Date.now() + 10 * 60000;
      return null;
    }).finally(() => { _brainVec.loading = null; });
  }
  return _brainVec.loading;
}
// 后台补齐文档向量：一批 16 条，批间让一下主线程。改过字的记忆 hash 对不上会重算。
async function _brainVecIndex() {
  if (_brainVec.indexing || !_brainVec.pipe) return;
  _brainVec.indexing = true;
  try {
    const todo = (state.brainMemories || []).filter(m => {
      const d = _brainVec.docs.get(m.id);
      return m.id != null && m.text && (!d || d.h !== _brainVecHash(_brainVecDocText(m)));
    });
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const out = (await _brainVecRun(batch.map(_brainVecDocText))).tolist();
      const rows = batch.map((m, j) => [m.id, { model: BRAIN_VEC_MODEL, h: _brainVecHash(_brainVecDocText(m)), v: Float32Array.from(out[j]) }]);
      rows.forEach(([id, r]) => _brainVec.docs.set(id, r));
      try {
        const db = await _brainVecDb();
        const tx = db.transaction('v', 'readwrite');
        rows.forEach(([id, r]) => tx.objectStore('v').put(r, id));
      } catch (_) {}
      await new Promise(r => setTimeout(r, 30));
    }
  } catch (e) {
    console.warn('[记忆·语义路] 建索引中断：', e?.message || e);
  } finally { _brainVec.indexing = false; }
}
// 发送前调（buildSystemPrompt 是同步的，只能在外面先 await）：把这一轮的查询向量算好放着。
// 模型还没加载好就只踢一脚让它后台加载，不等——第一轮只有词法，之后才有语义路。
async function brainVecPrepare(chat) {
  if (!_brainVecOn()) return;
  try {
    if (!_brainVec.pipe) { _brainVecLoad().then(p => p && _brainVecIndex()); return; }
    _brainVecIndex();
    const text = _brainVecQueryText(chat);
    if (!text || _brainVec.q?.text === text) return;
    const run = _brainVecRun(BRAIN_VEC_QPREFIX + text)
      .then(o => { _brainVec.q = { text, v: Float32Array.from(o.tolist()[0]) }; });
    await Promise.race([run, new Promise(r => setTimeout(r, BRAIN_VEC_WAIT_MS))]);
  } catch (e) { console.warn('[记忆·语义路] 查询向量失败：', e?.message || e); }
}
function _brainVecQueryText(chat) {
  let cur = chat?.headId, hops = 0;
  while (cur && chat.nodes?.[cur] && hops++ < 40) {
    const n = chat.nodes[cur];
    if (n.role === 'user') return (getMsgPlainText(n) || '').slice(0, 256);
    cur = n.parentId;
  }
  return '';
}
// 给 scored 里语义最近的几条打上 x.vec。只看最新一条用户消息（实测带上前几条反而冲淡）。
function _brainVecMark(scored, chat) {
  const q = _brainVec.q;
  if (!q || !_brainVecOn() || q.text !== _brainVecQueryText(chat)) return 0;
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const all = [];
  scored.forEach(x => {
    const d = _brainVec.docs.get(x.m.id);
    if (d && d.h === _brainVecHash(_brainVecDocText(x.m))) { x.vrel = dot(q.v, d.v); all.push(x.vrel); }
  });
  if (all.length < 8) return 0;
  all.sort((a, b) => b - a);
  if (all[0] - all[all.length >> 1] < BRAIN_VEC_SPREAD) return 0;
  const top = scored.filter(x => !x.m.pinned && x.vrel != null).sort((a, b) => b.vrel - a.vrel).slice(0, BRAIN_VEC_SLOTS);
  top.forEach(x => { x.vec = true; });
  return top.length;
}

/* 第一段：粗召回——按来源分配名额凑候选池。
   以前这里是「pinned 排最前，然后 score 取前 14」，两个毛病都只在库变大后才显形，
   而且**零报错**，症状仅仅是 AI 慢慢开始答非所问：

     · pinned 会把池子吃光。pinned 无条件排最前，钉够 BRAIN_RERANK_POOL(14) 条，
       候选池就全是它们，相关记忆连参赛资格都没有——每轮注入同一批。

     · score = w × (1+2×rel) 里 w 说了算。w 的量级差（1.2 vs 0.6）盖过 rel 的贡献，
       于是高权重的低相关记忆占满池子。库越大越致命：963 条时 pool 只覆盖 1.5%。
       实测过一组：rel=0.155 的正确记忆 score 0.81，rel=0.003 的无关记忆 score 1.22，
       后者排在前面——问「你还记得有机物和沙子那句话吗」召不回那条就叫《有机物与沙子》的记忆。
       注意这跟上面注释里已修的那个不是同一个：两段式重排修的是**重排**，
       **粗召回**一直还是权重主导，只是小库时 pool 覆盖率高、看不出来。

   现在三个来源各拿各的名额，谁也吃不掉别人的：
     pinned  ≤ BRAIN_PIN_SLOTS —— 用户明确要常驻的优先，但限量；钉超了就按相关性挑最贴题的进
     rel     ≤ BRAIN_REL_SLOTS —— 纯按相关性发，保证真正相关的那条进得来
     score     剩下的名额     —— 原逻辑，保住「重要且沾边」的
   名额没用满会自动让给后面的来源，所以池子照样是满的。 */
function _brainPool(scored) {
  // seen 存条目对象本身，不存 m.id：id 万一缺失，所有 undefined 会被当成同一条而互相吞掉
  const seen = new Set();
  const take = (arr, n) => {
    const out = [];
    for (const x of arr) {
      if (out.length >= n) break;
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  };
  const left = () => BRAIN_RERANK_POOL - seen.size;
  // 钉住的按相关性排（不是按权重）——pinned 权重是同一个常数，拿它排等于按数组顺序随机。
  // rel 打平时让最久没被想起的排前面，免得同几条永远占着这 6 个名额。
  const pins = take(scored.filter(x => x.m.pinned)
    .sort((a, b) => (b.rel - a.rel) || ((a.m.lastAccess || 0) - (b.m.lastAccess || 0))),
    Math.min(BRAIN_PIN_SLOTS, left()));
  // 语义路标出来的（_brainVecMark，已排除 pinned、最多 BRAIN_VEC_SLOTS 条）。排在词法 rel 前面：
  // 它们正是词法路 rel≈0、在下面那段永远排不上号的那种
  const vecs = take(scored.filter(x => x.vec).sort((a, b) => b.vrel - a.vrel), left());
  // ⚠ 相关性名额必须排除 pinned，否则钉住的既拿了专属名额、又来分这里的：
  // 13 条高 rel 的 pinned 就能把 6+7 个名额全占了，只剩 1 个给 score，
  // 再被高权重无关记忆抢走 —— 真正相关的普通记忆照样进不来，等于没修。
  const rels = take(scored.filter(x => !x.m.pinned && x.rel > 0).sort((a, b) => b.rel - a.rel),
    Math.min(BRAIN_REL_SLOTS, left()));
  // ⚠ score 名额同样排除 pinned：它们权重是常数 1.5（不衰减），score 天然压过所有普通记忆，
  // 不排除的话这里也会被占光，上面那个 BRAIN_PIN_SLOTS 就形同虚设。
  const rest = take(scored.filter(x => !x.m.pinned).sort((a, b) => b.score - a.score), left());
  // 兜底补位：名额没用满就从所有剩下的（**包括超出配额的 pinned**）按 score 补。
  // 没有这一步，钉住的记忆一旦超过 BRAIN_PIN_SLOTS，多出来的就永远没有出场机会——
  // 哪怕池子还空着。用户亲手钉住的东西不该被静默饿死。
  const fill = take([...scored].sort((a, b) => b.score - a.score), left());
  return [...pins, ...vecs, ...rels, ...rest, ...fill];
}

// 第二段：重排。进来的是粗召回选出的候选，出去的是真正值得占系统提示的那几条。
function _brainRerank(scored) {
  const pool = _brainPool(scored);
  if (!pool.length) return [];
  const wMax = pool.reduce((s, x) => Math.max(s, x.w), 0) || 1;
  // 重排分：相关性主导，权重只做 0.55~1.0 的微调（粗召回里正好反过来）
  pool.forEach(x => { x.rr = x.rel * (0.55 + 0.45 * (x.w / wMax)); });

  const out = [];
  const dupOf = x => out.some(y => !y.m.pinned && _brainCos(_brainDocVec(x.m), _brainDocVec(y.m)) > BRAIN_MMR_DUP);

  pool.filter(x => x.m.pinned).forEach(x => { x.why = 'pinned'; out.push(x); });   // 钉住的不筛不去重
  pool.filter(x => !x.m.pinned && x.rel >= BRAIN_REL_MIN)
      .sort((a, b) => b.rr - a.rr)
      .forEach(x => { if (!dupOf(x)) { x.why = 'rel'; out.push(x); } });
  // 语义路：词法已经收了的不重复收；排在词法 rel 之后、背景之前（预算不够时先让它）
  pool.filter(x => x.vec && !x.m.pinned && x.rel < BRAIN_REL_MIN)
      .sort((a, b) => b.vrel - a.vrel)
      .forEach(x => { if (!dupOf(x)) { x.why = 'vec'; out.push(x); } });
  pool.filter(x => !x.vec && !x.m.pinned && x.rel < BRAIN_REL_MIN)
      .sort((a, b) => b.w - a.w)
      .slice(0, BRAIN_BG_SLOTS)
      .forEach(x => { if (!dupOf(x)) { x.why = 'bg'; out.push(x); } });
  return out;
}

// 挑选要浮现的记忆：粗召回 → 重排 → 按预算截断。
// 真正因为"相关"被想起的记忆会被刷新（lastAccess），越常想起越不容易忘 —— 同 Ombre。
function pickBrainMemories(chat, modelId) {
  const mems = (state.brainMemories || []).filter(m => memoryAllowedForModel(m, modelId));
  if (!mems.length) return [];
  const now = Date.now();
  _brainIdfSyncContent();
  const q = _brainQueryVec(chat);
  let scored = mems.map(m => {
    const w = brainWeight(m, now);
    const rel = _brainCos(q, _brainDocVec(m));
    return { m, w, rel, score: w * (1 + 2 * rel) };
  }).filter(x => x.m.pinned || (x.w >= BRAIN_MIN_WEIGHT && x.score >= BRAIN_MIN_WEIGHT));
  scored.sort((a, b) => (b.m.pinned - a.m.pinned) || (b.score - a.score));
  // 关了重排就没有名额分配，语义路也不标（否则标了没人用，面板上还显示个 vec）
  if (state.brainRerank !== false) _brainVecMark(scored, chat);

  const ranked = state.brainRerank === false ? scored : _brainRerank(scored);

  /* 预算分配。光把候选池修公平还不够 —— ranked 的顺序是 pins 在最前，而记忆平均 175 字，
     6 条钉住的就吃掉 6×195=1170，逼近 1200 的预算上限，后面那条真正相关的一进来就超支、
     直接 break。于是「相关记忆召不回」原样复发，只是从池子层挪到了预算层。
     所以给钉住的记忆单独设一个预算占比上限：超了就**跳过这一条继续看下一条**（不是 break），
     把剩下的字符留给相关记忆。至少保留一条钉住的能进（否则钉住就完全失去意义）。 */
  const picked = [];
  let used = 0, pinUsed = 0, hasPin = false;
  const pinCap = BRAIN_PROMPT_BUDGET * BRAIN_PIN_BUDGET;
  for (const x of ranked) {
    const cost = x.m.text.length + 20;
    if (x.m.pinned && pinUsed + cost > pinCap) {
      // 保底「至少留一条钉住的」，但这条本身也必须装得进配额 —— 否则一条超长的钉住记忆
      // （比如 1100 字）就能借保底之名吃掉整个预算，相关记忆照样被挤出去，等于没修。
      // 装不下的那条就不浮现了：它在记忆面板里依然看得见，而预算该留给这轮真正相关的。
      if (hasPin || cost > pinCap) continue;
    }
    /* 总预算是硬上限，不给「至少留一条」开口子：一条 1200+ 字的记忆本来就不该独占整个
       系统提示，而系统提示吃爆上下文窗口的后果是**静默失忆**（认得人格却不记得刚说过的话）。
       装不下的跳过、不中断：ranked 已经按价值排好序，价值优先体现在「谁先被考虑」，
       而不是「谁装不下就把后面的一起挡住」——否则一条超长记忆能让整轮一条都注入不了。 */
    if (used + cost > BRAIN_PROMPT_BUDGET) continue;
    picked.push(x); used += cost;
    if (x.m.pinned) { pinUsed += cost; hasPin = true; }
  }
  _lastBrainPick = {
    at: now, query: q.preview, used, pool: scored.length,
    reranked: state.brainRerank !== false,
    items: picked.map(x => ({ text: x.m.text, rel: x.rel, vrel: x.vrel, w: x.w, why: x.why || 'score' })),
  };
  // 只刷新"因相关而被想起"的记忆，常驻高权重项不白嫖刷新
  picked.forEach(x => {
    if (x.rel >= BRAIN_REL_MIN) { x.m.lastAccess = now; x.m.accessCount = (x.m.accessCount || 0) + 1; }
  });
  return picked;
}

function brainEmotionEmoji(m) {
  const v = m.valence || 0, a = m.arousal || 0;
  if (v > 0.3) return a > 0.55 ? '🤩' : '😊';
  if (v < -0.3) return a > 0.55 ? '😰' : '😢';
  return a > 0.6 ? '😮' : '😐';
}

function formatBrainForPrompt(picked) {
  return picked.map(x => {
    const m = x.m;
    const flags = [(m.pinned ? '钉' : ''), (m.resolved ? '已解决' : '')].filter(Boolean).join(',');
    return `- [${m.domain}|重要${m.importance}${flags ? '|' + flags : ''}] ${m.text}`;
  }).join('\n');
}

// ── AI 指令入口 ──
// [[BRAIN_ADD: 重要度|效价|唤醒|领域|内容]]（前四段可留空用默认值）
function brainAddFromTag(raw, modelId) {
  const parts = raw.split('|');
  if (parts.length >= 5) {
    return addBrainMemory({ importance: parts[0], valence: parts[1], arousal: parts[2], domain: parts[3], text: parts.slice(4).join('|'), modelId });
  }
  return addBrainMemory({ text: raw, modelId }); // 格式不对就当纯文本收下，别丢
}
function brainFindByMatch(kw, modelId) {
  kw = (kw || '').trim().toLowerCase();
  if (!kw) return null;
  return (state.brainMemories || []).find(m => memoryAllowedForModel(m, modelId)
    && (m.text.toLowerCase().includes(kw) || (m.domain || '').toLowerCase() === kw));
}
function brainPinByMatch(kw, modelId)     { const m = brainFindByMatch(kw, modelId); if (m) { m.pinned = true; save(); } return m; }
function brainResolveByMatch(kw, modelId) { const m = brainFindByMatch(kw, modelId); if (m) { m.resolved = true; save(); } return m; }
function brainDelByMatch(kw, modelId) {
  const m = brainFindByMatch(kw, modelId);
  if (m) {
    state.trash = state.trash || [];
    state.trash.push({ type: 'memory', memoryData: { ...m }, deletedAt: new Date().toISOString() });
    state.brainMemories = state.brainMemories.filter(x => x.id !== m.id);
    save(); renderMemoryBadge();
  }
  return m;
}

// ── 高级记忆 UI ──
// 重排开关 +「上一轮浮现了什么」。后者是调噪音唯一的抓手：
// 系统提示是看不见的，不把挑选结果摊出来，"它怎么老提不相干的事"就永远只能靠猜。
function _brainRerankPanelHtml() {
  const on = state.brainRerank !== false;
  const p = _lastBrainPick;
  const rows = p && p.items.length ? p.items.map(it => {
    const tag = it.why === 'pinned' ? '📌 钉住' : it.why === 'bg' ? '背景'
      : it.why === 'vec' ? `语义 ${(it.vrel ?? 0).toFixed(3)}` : `相关 ${it.rel.toFixed(3)}`;
    const dim = it.why === 'bg' ? 'opacity:.55;' : '';
    return `<div style="${dim}display:flex;gap:6px;font-size:11px;line-height:1.5;padding:2px 0">
      <span style="flex-shrink:0;color:var(--accent);min-width:62px">${tag}</span>
      <span style="color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.text)}</span>
    </div>`;
  }).join('') : `<div style="font-size:11px;color:var(--text-muted)">还没发生过检索——跟它说句话再回来看。</div>`;
  return `
    <div class="settings-section" style="margin-bottom:12px;">
      <div class="section-desc">
        检索分两段：先按 <b>权重×相关性</b> 粗召回，再由 <b>重排</b> 按相关性挑一遍。
        关掉重排就退回旧行为——不管你在说什么，预算都会被几条最重要的记忆填满。
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px;">
        <input type="checkbox" id="brainRerankToggle" ${on ? 'checked' : ''}
          onchange="state.brainRerank=this.checked;save();renderBrainMemList();showToast(this.checked?'✓ 重排已开：只浮现真正相关的':'已关闭：退回按重要度硬塞')"
          style="accent-color:var(--accent);width:14px;height:14px;">
        <span style="font-size:13px;color:var(--text-dim)">相关性重排（过滤检索噪音）</span>
      </label>
      <details style="margin-top:10px">
        <summary style="font-size:11px;color:var(--text-muted);cursor:pointer">
          上一轮浮现了什么${p ? `（候选 ${p.pool} 条 → 用了 ${p.items.length} 条 / ${p.used} 字${p.query ? ' · 「' + escHtml(p.query) + '」' : ''}）` : ''}
        </summary>
        <div style="margin-top:6px">${rows}</div>
      </details>
    </div>`;
}

function renderBrainMemList() {
  if (_currentMemTab !== 'brain') return;
  const el = document.getElementById('memoryList');
  const mems = state.brainMemories || [];
  if (!mems.length) {
    el.innerHTML = `<div class="memory-empty">🌙 还没有高级记忆。<br>AI 会在对话中自动记下带情绪和重要度的事件，<br>越重要、越情绪化的记忆越不容易忘记；久不提起的会慢慢淡去。</div>`;
    return;
  }
  const now = Date.now();
  // 领域标签也进搜索范围：她记得"那条是工作相关的"比记得原话更常见
  const hits = mems.filter(m => memSearchHit(m.text, m.domain));
  if (!hits.length) { el.innerHTML = memSearchEmptyHtml('高级记忆'); return; }
  const sorted = hits.map(m => ({ m, w: brainWeight(m, now) })).sort((a, b) => (b.m.pinned - a.m.pinned) || (b.w - a.w));
  el.innerHTML = _brainRerankPanelHtml() + memSearchCountHtml(hits.length, mems.length) + sorted.map(({ m, w }) => {
    const faded = !m.pinned && w < BRAIN_MIN_WEIGHT;
    const pct = Math.min(100, Math.round(w * 100));
    const date = new Date(m.createdAt).toLocaleDateString('zh-CN');
    return `
    <div class="memory-item" id="bitem-${m.id}" style="opacity:${faded ? 0.4 : 1};flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:13px">${brainEmotionEmoji(m)}</span>
        <span style="font-size:10px;font-weight:700;color:var(--accent);background:var(--accent-soft);border-radius:20px;padding:1px 8px">${memHi(m.domain || '综合')}</span>
        <span style="font-size:10px;color:var(--text-muted)">重要 ${m.importance}/10 · ${date} · 想起 ${m.accessCount || 0} 次</span>
        ${m.pinned ? '<span style="font-size:10px;color:var(--accent)">📌 钉住</span>' : ''}
        ${m.resolved ? '<span style="font-size:10px;color:var(--text-muted)">✓ 已解决</span>' : ''}
        ${faded ? '<span style="font-size:10px;color:var(--text-muted)">🌫 已淡去</span>' : ''}
      </div>
      <span class="memory-text" style="font-size:13px">${memHi(m.text)}</span>
      ${memoryModelAccessHtml(m, 'brain')}
      <div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;height:3px;background:var(--bg-hover);border-radius:2px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--accent);opacity:.7"></div></div>
        <button class="memory-edit-btn" title="${m.pinned ? '取消钉住' : '钉住（永不遗忘）'}" onclick="toggleBrainPin(${m.id})">${m.pinned ? '📌' : '📍'}</button>
        <button class="memory-edit-btn" title="${m.resolved ? '重新打开' : '标记已解决'}" onclick="toggleBrainResolved(${m.id})">${m.resolved ? '↩' : '✓'}</button>
        <button class="memory-edit-btn" onclick="startEditBrainMem(${m.id})">✎</button>
        <button class="memory-del" onclick="deleteBrainMem(${m.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

function toggleBrainPin(id) {
  const m = (state.brainMemories || []).find(m => m.id === id); if (!m) return;
  m.pinned = !m.pinned;
  if (m.pinned) { m.lastAccess = Date.now(); }
  save(); renderBrainMemList();
}
function toggleBrainResolved(id) {
  const m = (state.brainMemories || []).find(m => m.id === id); if (!m) return;
  m.resolved = !m.resolved;
  save(); renderBrainMemList();
}
function deleteBrainMem(id) {
  const m = (state.brainMemories || []).find(m => m.id === id); if (!m) return;
  state.trash = state.trash || [];
  state.trash.push({ type: 'memory', memoryData: { ...m }, deletedAt: new Date().toISOString() });
  state.brainMemories = state.brainMemories.filter(x => x.id !== id);
  save(); renderBrainMemList(); renderMemoryBadge();
  showToast('高级记忆已移入回收站');
}
function startEditBrainMem(id) {
  const el = document.getElementById('bitem-' + id); if (!el) return;
  const m = (state.brainMemories || []).find(m => m.id === id); if (!m) return;
  el.innerHTML = `
    <div style="width:100%">
      <textarea class="memory-edit-ta" id="bedit-${id}">${escHtml(m.text)}</textarea>
      <div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;font-size:11px;color:var(--text-dim);align-items:center">
        <label>重要度 <input type="number" id="bimp-${id}" min="1" max="10" value="${m.importance}" style="width:44px" class="field-input"></label>
        <label>效价 <input type="number" id="bval-${id}" min="-1" max="1" step="0.1" value="${m.valence}" style="width:54px" class="field-input"></label>
        <label>唤醒 <input type="number" id="baro-${id}" min="0" max="1" step="0.1" value="${m.arousal}" style="width:54px" class="field-input"></label>
        <label>领域 <input type="text" id="bdom-${id}" value="${escHtml(m.domain || '')}" style="width:80px" class="field-input"></label>
      </div>
      <div class="memory-edit-btns">
        <button class="mem-cancel-btn" onclick="renderBrainMemList()">取消</button>
        <button class="mem-save-btn" onclick="saveBrainMemEdit(${id})">保存</button>
      </div>
    </div>`;
  document.getElementById('bedit-' + id)?.focus();
}
function saveBrainMemEdit(id) {
  const m = (state.brainMemories || []).find(m => m.id === id); if (!m) return;
  const text = document.getElementById('bedit-' + id)?.value.trim();
  if (!text) return;
  m.text = text;
  const clamp = (v, lo, hi, d) => { v = parseFloat(v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
  m.importance = clamp(document.getElementById('bimp-' + id)?.value, 1, 10, m.importance);
  m.valence = clamp(document.getElementById('bval-' + id)?.value, -1, 1, m.valence);
  m.arousal = clamp(document.getElementById('baro-' + id)?.value, 0, 1, m.arousal);
  m.domain = (document.getElementById('bdom-' + id)?.value || '').trim().slice(0, 12) || m.domain;
  save(); renderBrainMemList();
  showToast('✓ 高级记忆已更新', 'success');
}

/* 关掉 footer 菜单，**并且**把箭头转回去。
   这两件事必须绑在一起 —— 只加 hidden 的话菜单没了、箭头还朝上，
   看起来像「还开着」。原来这一对在四个地方各抄了一遍，
   29-multiselect.js 里 Ctrl 多选要关浮层时就漏了箭头那半边（Codex 审出来的）。
   所以提成函数，谁要关都调它。 */
function closeFooterMenu() {
  document.getElementById('footerMenu')?.classList.add('hidden');
  const chev = document.getElementById('footerMenuChev');
  if (chev) chev.style.transform = '';
}

function toggleFooterMenu(){
  const m = document.getElementById('footerMenu');
  const chev = document.getElementById('footerMenuChev');
  const willOpen = m.classList.contains('hidden');
  m.classList.toggle('hidden');
  if (chev) chev.style.transform = willOpen ? 'rotate(180deg)' : '';
}
// 点击菜单外部自动收起
document.addEventListener('click', (e) => {
  const m = document.getElementById('footerMenu');
  const wp = document.getElementById('widgetsPanel');
  if (wp && !wp.classList.contains('hidden') && !e.target.closest('.sidebar-footer')) {
    wp.classList.add('hidden');
  }
  if (!m || m.classList.contains('hidden')) return;
  if (!e.target.closest('.sidebar-footer')) closeFooterMenu();
});

function toggleFooterLang() {
  const cur = (typeof getLang === 'function' ? getLang() : localStorage.getItem('grancyanLang')) || 'zh';
  const next = cur === 'zh' ? 'en' : 'zh';
  if (typeof setLanguage === 'function') setLanguage(next);
  else { try { localStorage.setItem('grancyanLang', next); } catch(e){} location.reload(); }
}
function initFooterLangVal() {
  const el = document.getElementById('footerLangVal');
  if (!el) return;
  const lang = (typeof getLang === 'function' ? getLang() : localStorage.getItem('grancyanLang')) || 'zh';
  el.textContent = lang === 'en' ? 'EN' : '中';
}
function toggleWidgetsPanel(e) {
  if (e) e.stopPropagation();
  const wp = document.getElementById('widgetsPanel');
  const fm = document.getElementById('footerMenu');
  if (!wp) return;
  wp.classList.toggle('hidden');
  if (fm && !fm.classList.contains('hidden')) closeFooterMenu();
}
document.addEventListener('DOMContentLoaded', initFooterLangVal);

// ═══════════════════════════════════════════════════════
// Hub「大集合」——齿轮打开的 claude.ai 式全屏面板
// 把已有各功能面板临时搬进 hub 右侧内容区（切换/关闭时搬回原 modal），
// 直接复用它们的渲染逻辑，不重写面板内部结构。
// ═══════════════════════════════════════════════════════
const HUB_SECTIONS = {
  settings:  { sel:'#settingsModal > .settings-panel',   home:'settingsModal',   render: renderHubSettings },
  /* ⚠️ render 这里**必须**建目录，别改回 null。
     功能指南实际上只有这一个打开入口 —— 页面里的 toggleHelp() 全是「关闭」
     （✕ 按钮、点背景），没有任何地方用它打开。所以 render 是 null 的时候，
     buildHelpToc() 一次都跑不到，左侧目录就是个空壳，人只看到光秃秃的一条边。
     （用户报的「侧边栏 ui 很久才会出现」就是这个。）
     buildHelpToc 自带 _helpTocBuilt 守卫，重复调用是空操作，放心挂。 */
  help:      { sel:'#helpModal > .help-panel',           home:'helpModal',       render: () => buildHelpToc() },
  memory:    { sel:'#memoryModal > .memory-panel',       home:'memoryModal',     render: () => { _currentMemTab = 'public'; renderMemoryList(); } },
  fav:       { sel:'#favModal > .memory-panel',          home:'favModal',        render: renderFavList },
  band:      { sel:'#bandModal > .memory-panel',         home:'bandModal',       render: renderHubBand },
  credits:   { sel:'#creditsModal > .credits-panel',     home:'creditsModal',    render: null },
  widgets:   { sel:'#widgetsHubHome > .hub-widgets-panel', home:'widgetsHubHome', render: null },
  vitals:    { sel:'#vitalsHubHome > .dreams-panel', home:'vitalsHubHome', render: () => vitalsRenderPanel() },
  dreams:    { sel:'#dreamsHubHome > .dreams-panel', home:'dreamsHubHome', render: () => { dreamRenderSettings(); dreamRenderGallery(); } },
};
let _hubMounted = null;   // { panel, home }
// 从小组件点进生命体征/梦境/手环这种「挂在 hub 里的页」时记下来路：手机上点返回要回小组件，
// 不是回最外层的功能列表。由 openHubSection 的第二个参数带进来，换页即清。
let _hubParent = null;
// 小组件「✕ 回上一级」用的状态（说明见下面 openWidget）。放这么靠前是因为 closeHub / openHubSection 会碰它们
let _widgetOpen = null, _widgetObs = null, _widgetCloseAt = 0, _widgetsScroll = 0, _widgetsBack = false, _widgetsScrollGen = 0;
// 回填逻辑和 ⚙ 入口共用 09 的 refreshSettingsUI —— 这里以前是手抄副本，漏了跑腿/技能开关等一串
function renderHubSettings() { refreshSettingsUI(); }
function renderHubBand() {
  const t = document.getElementById('bandAiToggle'); if (t) t.checked = state.bandAiEnabled !== false;
  const ta = document.getElementById('bandAutoToggle'); if (ta) ta.checked = state.bandAutoFetch === true;
  renderBandPanel();
}
// 把当前挂在 hub 里的面板搬回它原来的 modal
function _hubRestore() {
  if (!_hubMounted) return;
  _hubMounted.panel.classList.remove('in-hub');
  const home = document.getElementById(_hubMounted.home);
  if (home) home.appendChild(_hubMounted.panel);
  _hubMounted = null;
}
const HUB_TITLES = {
  settings:'设置中心', help:'功能指南', memory:'记忆管理',
  fav:'收藏消息', band:'手环数据', credits:'特别鸣谢', widgets:'小组件',
  dreams:'梦境陈列室',
  vitals:'生命体征',
};
function openHubSection(name, parent) {
  const cfg = HUB_SECTIONS[name]; if (!cfg) return;
  _widgetsScrollGen++;
  if (_hubMounted?.home === 'widgetsHubHome') _widgetsSaveScroll();
  const back = name === 'widgets' && _hubParent === 'widgets';
  _hubParent = HUB_SECTIONS[parent] ? parent : null;
  _hubRestore();
  const panel = document.querySelector(cfg.sel);
  const content = document.getElementById('hubContent');
  if (panel && content) {
    panel.classList.add('in-hub');
    content.appendChild(panel);
    content.scrollTop = 0;
    _hubMounted = { panel, home: cfg.home };
  }
  if (cfg.render) { try { cfg.render(); } catch (e) { console.warn('hub render', name, e); } }
  // 退回来的才回到原来的滚动位置；平时点「小组件」照旧从顶上开始
  if (name === 'widgets') { if (back || _widgetsBack) _widgetsRestoreScroll(); _widgetsBack = false; }
  // 从小组件进来的子页，左侧高亮留在「小组件」上，看得出自己在哪一层
  document.querySelectorAll('.hub-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.hub === (_hubParent || name)));
  // 手机端：点进来就是二级页面（整屏 + 顶部标题/返回）
  const title = document.getElementById('hubDetailTitle');
  if (title) title.textContent = HUB_TITLES[name] || '';
  document.getElementById('hubShell')?.classList.add('hub-detail');
}
// 手机端二级页面的「返回」：搬回原 modal，回到功能列表
function hubBackToList() {
  if (_hubParent) { openHubSection(_hubParent); return; }
  _hubRestore();
  document.getElementById('hubShell')?.classList.remove('hub-detail');
  document.querySelectorAll('.hub-nav-btn').forEach(b => b.classList.remove('active'));
}
function openHub(section) {
  closeFooterMenu();
  const wp = document.getElementById('widgetsPanel'); if (wp) wp.classList.add('hidden');
  document.getElementById('hubModal').classList.remove('hidden');
  // 手机端不带 section 进来（齿轮）→ 先给功能列表，让用户自己挑；带了就直接进那一页
  if (isMobileLayout() && !section) { hubBackToList(); return; }
  openHubSection(section || 'settings');
}
function closeHub() {
  _widgetsScrollGen++;
  if (_hubMounted?.home === 'widgetsHubHome') _widgetsSaveScroll();
  _hubParent = null;
  _hubRestore();
  document.getElementById('hubShell')?.classList.remove('hub-detail');
  document.getElementById('hubModal').classList.add('hidden');
}
// 子页右上角的 ✕：从小组件点进来的就退回小组件（用户要的「回上一级」），别的入口照旧关掉回聊天
function hubCloseOrBack() {
  if (_hubParent) openHubSection(_hubParent);
  else closeHub();
}

// ── 小组件的「上一级」──
// 小组件大多是独立弹窗，入口原来写的是 closeHub();openXxx() —— hub 先关了，弹窗的 ✕ 一点
// 就一路掉回聊天。用户要的是 ✕ 退回小组件列表。
// 不去改 30 来个 closeXxx()：它们也被聊天里的卡片、AI 指令、别的面板调用，那些场景关掉就该回聊天。
// 所以只在「从小组件点进去」这一次盯住那个弹窗：它被藏起来、并且藏之前刚点过它的关闭键/遮罩/Esc，
// 才回小组件。弹窗里「填进输入框」「去聊天」这类按钮也会顺手把自己关掉，那种不回（她要去聊天）。
function _widgetsSaveScroll() {
  _widgetsScrollGen++;
  const p = document.querySelector('.hub-widgets-panel');
  if (p) _widgetsScroll = p.scrollTop;
}
function _widgetsRestoreScroll() {
  const p = document.querySelector('.hub-widgets-panel'), want = _widgetsScroll;
  if (!p || !want) return;
  // hub 刚揭开那几帧还在入场动画里，面板高度没撑开，scrollTop 设进去会被夹回 0 ——
  // 所以一帧一帧补，直到站住（数帧不数毫秒：卡的时候一帧能拖几百毫秒，按时间算会提前放弃）
  // 只在被夹回顶上时补，别跟她自己的手指抢；hub 一关（或又开了一轮）就作废，免得把旧位置补到新的一轮上
  let left = 30; const gen = ++_widgetsScrollGen;
  (function tick() {
    if (gen !== _widgetsScrollGen) return;
    if (p.scrollTop < 2) p.scrollTop = want;
    if (--left > 0) requestAnimationFrame(tick);
  })();
}
function _widgetOverlaysShown() {
  return [...document.querySelectorAll('[id$="Modal"]')].filter(m =>
    m.id !== 'hubModal' && !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
}
function openWidget(open) {
  const before = new Set(_widgetOverlaysShown());
  closeHub();
  try { open(); } catch (e) { console.warn('[小组件]', e); }
  // openGallery 这类是 async，但第一句就同步把弹窗揭开了，所以这里同步找得到；
  // 找不到（无缝换窗没对话时只弹个 toast）就不盯，什么也不做。
  const el = _widgetOverlaysShown().find(m => !before.has(m));
  _widgetObs?.disconnect();
  _widgetOpen = el || null; _widgetObs = null; _widgetCloseAt = 0;
  if (!el) return;
  _widgetObs = new MutationObserver(() => {
    if (!el.classList.contains('hidden') && getComputedStyle(el).display !== 'none') return;
    _widgetObs.disconnect(); _widgetObs = null; _widgetOpen = null;
    if (Date.now() - _widgetCloseAt < 1500) { _widgetsBack = true; openHub('widgets'); }
  });
  _widgetObs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
}
function _isCloseCtl(b) {
  // 写了 onclick 的就只认它调的是不是 closeXxx()：编程工作台会话行上的「×」是移入回收站，
  // 长得像关闭键，光看字形会认错
  const call = (b.getAttribute('onclick') || '').trim();
  if (call) return /(^|;)\s*close\w*\(\s*\)\s*;?\s*$/.test(call);
  if (/^[✕×✖xX]$/.test((b.textContent || '').trim())) return true;
  if (/关闭/.test((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || ''))) return true;
  return /(^|[-_\s])close\b/i.test(b.className || '');
}
// 捕获阶段：赶在按钮自己的 onclick 把弹窗藏掉之前记下「这是一次关闭」
document.addEventListener('click', (e) => {
  if (!_widgetOpen) return;
  if (e.target === _widgetOpen) { _widgetCloseAt = Date.now(); return; }   // 点遮罩
  const b = e.target.closest?.('button,[onclick],[role="button"]');
  if (b && _widgetOpen.contains(b) && _isCloseCtl(b)) _widgetCloseAt = Date.now();
}, true);
document.addEventListener('keydown', (e) => { if (_widgetOpen && e.key === 'Escape') _widgetCloseAt = Date.now(); }, true);
// Esc：手机端二级页面先退回列表，其余情况直接关掉 hub
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const hub = document.getElementById('hubModal');
  if (!hub || hub.classList.contains('hidden')) return;
  const shell = document.getElementById('hubShell');
  if (isMobileLayout() && shell?.classList.contains('hub-detail')) hubBackToList();
  else closeHub();
});
// 键盘也能开小组件（ui-polish A34）：卡片是 <div onclick>，Tab 走不到。
// 补 tabindex/role 放在这里而不是写进 HTML —— 入口那几十行的 onclick 有测试逐字盯着，不去碰。
// 功能指南的目录项（buildHelpToc 造的 div）也走同一个 Enter/空格 → click。
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#widgetsHubHome .widget-item').forEach(el => {
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target;
  if (!el?.matches?.('.widget-item[role="button"], .help-toc-item[role="button"]')) return;
  e.preventDefault();
  el.click();
});
