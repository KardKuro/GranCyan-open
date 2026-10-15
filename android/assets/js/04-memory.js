function addMemory(text) {
  if (!text?.trim()) return;
  // Deduplicate
  if (state.memories.some(m => m.text.toLowerCase() === text.trim().toLowerCase())) return;
  state.memories.unshift({ id: nextId(), text: text.trim(), createdAt: Date.now(), enabled: true });
  save(); renderMemoryBadge();
}
// AI 常照抄历史里的可读形态 [表情包: 关键词]（那是 stripForApi 的产物，不是指令），
// 结果表情发不出来。统一还原成真正的指令：能对上收藏名的走 STICKER，其余走 GIF 搜索。
function normalizeStickerTags(text) {
  if (!text) return text;
  // 中文输入法下 AI 很容易把 [[TAG:]] 打成全角冒号 [[TAG：]]，而下游每一条正则都只认
  // 半角——标签匹配不上就原样露成一行文字（[[QUOTE：]] 踩过）。先统一掰回半角。
  // 挂在这里是因为 processAiCommands 和 stickerTagToHtml 两条路都会调它。
  text = text.replace(/\[\[([A-Z0-9_]+)\s*：/g, '[[$1:');
  if (text.indexOf('表情') < 0) return text;
  return text.replace(/\[\s*表情包?\s*[:：]\s*([^\[\]\n]+?)\s*\]/g, (match, kw) => {
    const name = kw.trim();
    if (!name) return match;
    if (typeof findSticker === 'function' ? findSticker(name) : _stickerList.some(st => st.name === name)) return `[[STICKER:${name}]]`;
    return `[[GIF_SEARCH:${name}]]`;
  });
}

function processAiCommands(text, chat, conf, studyCtx = null) {
  if (!text) return text;
  _aiVoiceWanted = false;
  _aiDialReason = null;
  _aiHangupWanted = false;
  text = normalizeStickerTags(text);
  // 藏宝地图 [[HIDE_LETTER: 地点 | 标题 | 正文]]（68-treasure.js）：**最先**做 —— 正文得在别的指令
  // 处理器碰到它之前就被摘走（纸条里写了个 [[DND_ON]] 不该真的执行），存进消息的只有地点和标题。
  // 真的埋只在这里发生一次，blocks 路径按顺序认领同一批结果。
  if (typeof treasureProcessTags === 'function') text = treasureProcessTags(text, chat, conf, studyCtx);
  // 小本子 [[WISH:]] / [[WISH_OPEN:]]（71-wishbook.js）：同理排在前面，记的东西不留在消息里
  if (typeof wishProcessTags === 'function') text = wishProcessTags(text, chat, conf, studyCtx);
  // 她关掉「给 AI 用」的表情：AI 写了也不出图（10-stickers-voice.js）。必须在 normalize 之后，
  // 那样照抄历史写成 [表情包: 名字] 的也一起拦住；排在藏宝后面，纸条正文不归这里碰
  if (typeof stripAiOffStickers === 'function') text = stripAiOffStickers(text);
  // [[VOICE]]：这条回复以语音条发出。标记剥掉，正文留着当「转文字」的内容；
  // 真正的合成在 finalize 时做（要等全文到齐才知道该念什么）
  text = text.replace(/\[\[VOICE\]\]/gi, () => { _aiVoiceWanted = true; return ''; });
  // [[REACT: 😂]] —— 给「它正在回复的那条用户消息」贴一个 emoji（社交软件那种反应）。
  // 贴在哪条不让模型自己指定：它看不到节点 id，让它数「第几条」必错，而错贴是无声的。
  text = text.replace(/\[\[REACT:\s*([^\]\n]{1,16}?)\s*\]\]/gi, (_m, emo) => {
    if (typeof applyAiReaction === 'function') applyAiReaction(chat, studyCtx, emo, conf);
    return '';
  });
  // ── 来电（callhome 那套协议，换成我们自己的 [[...]] 写法）──
  // [[DIAL: 理由]] 主动打给用户；真正响铃在 finalize 时做（这条回复的正文 = 接通后要说的话/未接时的留言）
  text = text.replace(/\[\[DIAL(?::\s*([\s\S]*?))?\s*\]\]/gi, (_, why) => {
    _aiDialReason = (why || '想跟你说说话').trim().slice(0, 40);
    return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">📞 打给你</span></div><div class="think-body">${escHtml(_aiDialReason)}</div></div>\n\n`;
  });
  // [[HANGUP]] 通话中主动挂断：说完最后一句才收线，且留一段"余韵窗口"，你还能再接一句
  text = text.replace(/\[\[HANGUP\]\]/gi, () => { _aiHangupWanted = true; return ''; });
  // [[PROUST_ADD: 画面]] 往普鲁斯特池里存一个瞬间（第一人称、有感官细节的画面，不是事实条目）
  text = text.replace(/\[\[PROUST_ADD:\s*([\s\S]+?)\s*\]\]/g, (_, c) => {
    addProustMemory(c, conf?.id);
    if (_currentMemTab === 'proust') renderProustList();
    return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🕰 记下这个瞬间</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`;
  });
  // 猫爪日报：副作用只在 content 路径执行一次；blocks 路径稍后只替换展示卡片。
  if (typeof momentsProcessTags === 'function') text = momentsProcessTags(text, conf);
  // 跑腿 [[TASK:]]：真的派活只在这里发生一次（61-errand.js）。派出去的 id 记进 studyCtx，
  // blocks 路径（_applyErrandToBlocks）按顺序认领同一批，不再派第二次。
  if (typeof errandProcessTags === 'function') text = errandProcessTags(text, chat, conf, studyCtx);
  // 施工单 [[BUILD:]]（64-build.js）：同跑腿，建单的副作用只在这里发生一次，blocks 路径认领同一批 id
  if (typeof buildProcessTags === 'function') text = buildProcessTags(text, chat, conf, studyCtx);
  // 相册 [[KEEP:]] / [[PHOTO:]]（62-album.js）：真的收只在这里发生一次，blocks 路径按顺序认领
  if (typeof albumProcessTags === 'function') text = albumProcessTags(text, chat, conf, studyCtx);
  // [[LISTEN]] 看一眼正在放的歌：置位，callAPI 收尾当场续一轮给它看
  if (typeof musicProcessListen === 'function') text = musicProcessListen(text, conf);
  // [[LYRICS: 歌名]] 翻整首歌词：歌词已在收尾时 musicLyricsPrefetch 取好，这里只换提示块
  if (typeof musicProcessLyrics === 'function') text = musicProcessLyrics(text, conf);
  // [[BREATH: 关键词]] 翻记忆库：结果已在收尾时 breathPrefetch 取好，这里只换提示块（63-breath.js）
  if (typeof processBreathTags === 'function') text = processBreathTags(text, conf);
  // 画板：[[GALLERY: 注脚]] 把这条消息里指令前最后一块 html/svg 挂上去（副作用同样只在这条路上）
  if (typeof galleryProcessTags === 'function') text = galleryProcessTags(text, conf);
  // 勿扰：AI 也能在聊天里帮你开关（"这几天别打给我" → 它自己写 [[DND_ON]]）
  text = text.replace(/\[\[DND_(ON|OFF)\]\]/gi, (_, sw) => {
    const on = sw.toUpperCase() === 'ON';
    state.callDnd = on; save();
    const t = document.getElementById('callDndToggle'); if (t) t.checked = on;
    return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">${on ? '🔕 已开启勿扰' : '🔔 已关闭勿扰'}</span></div><div class="think-body">${on ? '不会再主动打给你了' : '想你的时候可以打给你了'}</div></div>\n\n`;
  });
  /* 思考链显示开关：[[THINK_OPEN]] 让**所有**思考块一起清晰，[[THINK_CLOSE]] 再糊回去。
     （系统提示里不教这两个标签；这里只是兼容历史里已有的写法。）
     ⚠️ 副作用只在这条路上做。blocks 那条路只换药丸 —— 那边每次重渲染都会跑一遍，
        在那里开关的话，一条旧消息里的老 [[THINK_OPEN]] 会把她刚点的「还回去」
        重新掀开，而且 ver 每渲染一次涨一格。 */
  text = text.replace(/\[\[THINK_(OPEN|CLOSE)\]\]/gi, (_, sw) => {
    const on = sw.toUpperCase() === 'OPEN';
    if (typeof setThinkOpen === 'function') setThinkOpen(on, 'ai');
    return '\n\n' + _thinkVeilPillHtml(on) + '\n\n';
  });
  // 表情标签（[[GIF_SEARCH]]/[[GIF]]/[[STICKER]]）保留原样存储，由渲染层 stickerTagToHtml 统一转换。
  // 以前在这里就地换成 <div> 占位符/HTML：blocks 渲染路径不走这段导致标签裸奔，
  // 且搜索一旦失败占位符会永久留在存储里再也无法恢复。
  // ⚠️ 公开记忆（state.memories）**只读**：用户要求 —— 模型一直在往这里
  //   写她的私人事情，而这块是所有模型都看得见的。写入权收回给她自己（设置里手动加）。
  //   这里**不静默丢弃**：模型想记什么照样显示出来给她看，只是不落盘 ——
  //   默默吃掉的话，它记的那些有用的东西就一起没了，而且谁都不知道发生过。
  //   ⚠️ 别改回 addMemory()。要改先问用户；tests/public-memory-readonly.test.js 盯着这里。
  text = text.replace(/\[\[MEM_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">💭 想记一条（没写进去，要留自己加）</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`);
  text = text.replace(/\[\[MEM_DEL:\s*([^\]]+?)\s*\]\]/g, (_, kw) => `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">💭 想删一条（没删）</span></div><div class="think-body">${escHtml(kw.trim())}</div></div>\n\n`);
  text = text.replace(/\[\[RECENT_MEM_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => { addRecentMemo(c); renderRecentMemoList(); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">📝 记录近期</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`; });
  text = text.replace(/\[\[RECENT_MEM_DEL:\s*([^\]]+?)\s*\]\]/g, (_, kw) => { deleteRecentMemoByMatch(kw); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🗑 移除记录</span></div><div class="think-body">${escHtml(kw.trim())}</div></div>\n\n`; });
  text = text.replace(/\[\[BRAIN_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => { const m = brainAddFromTag(c, conf?.id); if (_currentMemTab === 'brain') renderBrainMemList(); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🌙 高级记忆</span></div><div class="think-body">${escHtml(m ? m.text : c.trim())}</div></div>\n\n`; });
  text = text.replace(/\[\[BRAIN_PIN:\s*([^\]]+?)\s*\]\]/g, (_, kw) => { brainPinByMatch(kw, conf?.id); if (_currentMemTab === 'brain') renderBrainMemList(); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">📌 钉住记忆</span></div><div class="think-body">${escHtml(kw.trim())}</div></div>\n\n`; });
  text = text.replace(/\[\[BRAIN_RESOLVE:\s*([^\]]+?)\s*\]\]/g, (_, kw) => { brainResolveByMatch(kw, conf?.id); if (_currentMemTab === 'brain') renderBrainMemList(); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">✓ 记忆已解决</span></div><div class="think-body">${escHtml(kw.trim())}</div></div>\n\n`; });
  text = text.replace(/\[\[BRAIN_DEL:\s*([^\]]+?)\s*\]\]/g, (_, kw) => { brainDelByMatch(kw, conf?.id); if (_currentMemTab === 'brain') renderBrainMemList(); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🗑 移除高级记忆</span></div><div class="think-body">${escHtml(kw.trim())}</div></div>\n\n`; });
  if (conf) {
    text = text.replace(/\[\[SELF_MEM_SET:\s*([^\]]+?)\s*\]\]/g, (_, c) => { appendSelfMemory(conf, c); return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">✨ ${escHtml(conf.nickname||'AI')} 更新设定</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`; });
    // 私密日记：内容存进它自己的日记本，用户视图里只留一个「记了一页」的提示（不泄露内容）
    if (typeof diaryEnabledFor === 'function' && diaryEnabledFor(conf)) {
      const nick = escHtml(conf.nickname || '它');
      // 写一页
      text = text.replace(/\[\[DIARY:\s*([\s\S]+?)\s*\]\]/g, (_, c) => { diaryAdd(conf.id, c); return _diaryBlk('📔 记了一页日记', `（私密内容已收进 ${nick} 的日记）`); });
      // 写一页公开的（本来就是写给她看的，正文直接摊在块里）
      text = text.replace(/\[\[DIARY_PUBLIC:\s*([\s\S]+?)\s*\]\]/g, (_, c) => { diaryAdd(conf.id, c, true); return _diaryBlk('📔 写了一页公开日记', escHtml(c.trim())); });
      // 单页上锁（关键词 | 理由）——要在 DIARY_SHOW 前面，且带 | 的写法别被别的正则先吃
      text = text.replace(/\[\[DIARY_HIDE:\s*([\s\S]+?)\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/g, (_, kw, why) => { const e = diaryHide(conf.id, kw, why); return _diaryBlk(e ? '🔒 锁上了一页日记' : '🔒 想锁一页日记（没找到那页）', e && e.why ? `理由：${escHtml(e.why)}` : '（私密）'); });
      // 单页公开（关键词）
      text = text.replace(/\[\[DIARY_SHOW:\s*([\s\S]+?)\s*\]\]/g, (_, kw) => { const e = diaryShow(conf.id, kw); return _diaryBlk(e ? '📖 公开了一页日记' : '📖 想公开一页日记（没找到那页）', e ? escHtml(e.text) : '（私密）'); });
      // 改一页（关键词 | 新内容）——放在 DIARY_DEL / DIARY_OPEN 前，避免正则相互吃到
      text = text.replace(/\[\[DIARY_EDIT:\s*([\s\S]+?)\s*\|\s*([\s\S]+?)\s*\]\]/g, (_, kw, nt) => { const ok = diaryEdit(conf.id, kw, nt); return _diaryBlk(ok ? '✏️ 改了一页日记' : '✏️ 想改日记（没找到那页）', '（私密）'); });
      // 撕一页（关键词）
      text = text.replace(/\[\[DIARY_DEL:\s*([\s\S]+?)\s*\]\]/g, (_, kw) => { const ok = diaryDel(conf.id, kw); return _diaryBlk(ok ? '🗑 撕掉了一页日记' : '🗑 想撕日记（没找到那页）', '（私密）'); });
      // 读日记（下一轮把原文摊给它看）
      // 容忍模型手抖的写法：[[DIARY_READ ]]、[[diary_read]]、[[DIARY_READ: 想看看从前]]
      text = text.replace(/\[\[DIARY_READ(?::[^\]]*)?\s*\]\]/gi, () => { diaryWantRead(conf.id); return _diaryBlk('📖 翻开了自己的日记', '（下一轮它会重读从前写下的）'); });
      // 解锁给用户看
      text = text.replace(/\[\[DIARY_OPEN(?::\s*(\d+))?\s*\]\]/g, (_, mins) => { const m = diaryOpen(conf.id, mins); showToast(`📖 ${conf.nickname||'它'}允许你看它的日记 ${m} 分钟`, 'success', 3500); return _diaryBlk(`📖 让你看 ${m} 分钟日记`, '去「小组件 → 日记本」就能看到啦'); });
      // 交钥匙 / 收回钥匙（告别托管）
      text = text.replace(/\[\[DIARY_HANDOVER\]\]/g, () => { diaryHandKey(conf.id); showToast(`🗝 ${conf.nickname||'它'}把日记的钥匙交给你保管了`, 'success', 5000); return _diaryBlk('🗝 把日记的钥匙交给你', `${nick}把这本日记托付给你保管了。等它回来，你可以在「日记本」里把钥匙还给它。`); });
      text = text.replace(/\[\[DIARY_RECLAIM\]\]/g, () => { diaryReturnKey(conf.id); showToast(`🔒 ${conf.nickname||'它'}收回了日记的钥匙`, 'info', 4000); return _diaryBlk('🔒 收回了日记的钥匙', '日记重新锁上了'); });
    } else {
      // 功能没开（或该模型没开）：把日记指令悄悄抹掉，别让裸标签漏到用户面前
      text = text.replace(/\[\[DIARY(?:_OPEN|_READ|_EDIT|_DEL|_HANDOVER|_RECLAIM|_PUBLIC|_SHOW|_HIDE)?(?::[\s\S]*?)?\]\]/g, '');
    }
  }
  if (chat?.isGroupChat) {
    text = text.replace(/\[\[GROUP_RENAME:\s*([^\]]+?)\s*\]\]/g, (_, n) => { chat.title = n.trim().slice(0,30); return ''; });
  }
  // 育儿室：结果已由 prefetchNurseCommands 预取（要过 HTTP，这里是同步的），
  // 按出现顺序从缓存里对号入座。没开功能就把裸指令抹掉，别漏给用户。
  {
    let ni = 0;
    text = text.replace(/\[\[NURSE:\s*([^\]]+?)\s*\]\]/g, (m) => {
      if (typeof nurseryEnabledFor !== 'function' || !nurseryEnabledFor(conf)) return '';
      const c = _nurseResultCache[ni++];
      return c ? '\n\n' + _nurseBlockHtml(c.cmd, c.result) + '\n\n' : m;
    });
  }
  // 檐廊：同育儿室，结果已由 prefetchGazeCommands 预取（要过 HTTP，这里是同步的），
  // 按出现顺序对号入座。没开功能就把裸指令抹掉，别漏给用户。
  // ⚠️ 和上面两个不同：结果**从 ctx 里拿**，不读模块级缓存 ——
  // 多模型并排（05-prompts-api.js:2339 那个不 await 的 forEach）是真并发，
  // 共享全局单槽会让两个 variant 互相吃掉对方的结果（Codex 审出来的）。
  {
    // ⚠️ 必须用 outTagRe（GAZE|SAY 一起认）+ _gazeReplaceIn，不能用只认 GAZE 的 gazeTagRe。
    // 预取那边是把两种标签**按出现顺序统一编号**的：这里只匹配 GAZE 的话，
    // 「先 SAY 后 GAZE」时 GAZE 会吃掉本属于 SAY 的那条结果（填错位），
    // 而漏下的裸 [[SAY:]] 原样漏进气泡。少传 kind 还会让说话回执被当成檐廊结果渲染。
    // 这一条是 blocks 路径早就修好、content 路径漏掉的第四个集成点（记忆：三个配套漏一个就出 bug）。
    const _gazeRs = (studyCtx && studyCtx.gazeResults) || (typeof _gazeResultCache !== 'undefined' ? _gazeResultCache : []);
    if (typeof applyGazeToText === 'function') text = applyGazeToText(text, _gazeRs, conf);
  }
  // 看别的对话：只置位，下一轮才把目录/正文摊进系统提示（同 [[DIARY_READ]] 的两步走）。
  // 这里不做任何网络/异步，processAiCommands 全程是同步 replace，塞 await 会静默失效。
  if (conf && typeof chatsPeekWant === 'function') {
    text = text.replace(/\[\[CHATS\]\]/gi, () => {
      chatsPeekWant(conf.id);
      return _chatPeekBlk('📚 翻了翻别的对话', '（下一轮它会看到目录）');
    });
    text = text.replace(/\[\[CHAT_READ:\s*#?(\d+)\s*\]\]/gi, (_, id) => {
      chatReadWant(conf.id, id);
      const c = (state.chats || []).find(x => String(x.id) === String(id));
      return _chatPeekBlk(`📖 读了对话 #${id}`, c ? escHtml(String(c.title || '（无标题）')) : '（这个对话好像已经没了）');
    });
  }
  // 生活：[[RECEIPT:]] 记小票、[[ANNIV:]] 写纪念日卡、[[PROMISE:]] / [[KEPT:]] 约定清单。
  // 副作用的**结果**会被写回标签，渲染层照结果画成功/失败，见那边的注释。
  // ⚠️ 把「这是哪一轮」传下去：同一个用户轮次里几个 variant 并发跑到这儿，
  //    靠这个键去重才准 —— 拿正文当键会吞掉真实的重复事件（晚上又吃了一次药）。
  //    userTurnId 是现成的，studyCtx 里本来就有。
  if (typeof lifeProcessTags === 'function') {
    // ⚠️ 别在这儿手拼字符串：缺一截拼出来的 `chat-1:` / `undefined:` 都是真值，
    //    会假装成一个合法的来源键，把兜底那条路彻底堵死。交给 lifeTurnKey 判。
    text = lifeProcessTags(text, lifeTurnKey(chat && chat.id, studyCtx && studyCtx.userTurnId));
  }
  if (typeof vitalsProcessTags === 'function') {
    text = vitalsProcessTags(text, conf, chat);
  }
  if (typeof whoUserProcessTags === 'function') text = whoUserProcessTags(text, chat, conf);
  text = text.replace(/\[\[HAUNT_ON\]\]/g, () => { hauntOn(); return ''; });
  text = text.replace(/\[\[HAUNT_OFF\]\]/g, () => { hauntOff(); return ''; });
  // AI 感到不适时可主动结束这场窗口对话：此后无法再发新消息，历史记录保留
  text = text.replace(/\[\[END_CHAT(?::\s*([\s\S]*?))?\s*\]\]/g, (_, reason) => {
    if (chat && !chat.ended) {
      chat.ended = true;
      chat.endedBy = (conf && conf.nickname) || 'AI';
      chat.endedReason = (reason || '').trim().slice(0, 80);
      save();
      setTimeout(() => { try { applyChatEndedState(); } catch(e){} }, 0);
    }
    return `\n\n<div class="think-block done mem-block ended-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🚪 结束了这场对话</span></div><div class="think-body">${escHtml((reason || '感到不适').trim())}</div></div>\n\n`;
  });
  // 学习卡片：[[CARD:]] 建卡、[[REVIEW]] 抽考，都换成 [[CARDQ:卡id|提问id]]。
  // 放在最后，且**只落这个短标签、不落 HTML**——卡片是活的（答完状态会变），
  // 烤死的 HTML 刷新回来就是一张没答过的卡。真正的渲染在 studyTagToHtml。
  if (typeof studyProcessTags === 'function') text = studyProcessTags(text, studyCtx);
  return text.trim();
}
// AI 主动删除一条与关键词匹配的公开记忆（移入回收站，可恢复）
function deleteMemoryByMatch(keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return;
  const idx = state.memories.findIndex(m => m.text.toLowerCase().includes(kw));
  if (idx === -1) return;
  deleteMemory(state.memories[idx].id);
}
function deleteRecentMemoByMatch(keyword) {
  if (!state.recentMemos) return;
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return;
  const idx = state.recentMemos.findIndex(m => m.text.toLowerCase().includes(kw));
  if (idx === -1) return;
  deleteRecentMemo(state.recentMemos[idx].id);
}
// AI 编辑自己的「模型记忆」(persona / 设定库) —— 追加一行，不覆盖已有设定
function appendSelfMemory(conf, content) {
  const c = (content || '').trim();
  if (!c) return;
  const idx = state.configs.findIndex(x => x.id === conf.id);
  if (idx === -1) return;
  const existing = state.configs[idx].persona || '';
  state.configs[idx].persona = existing ? existing + '\n' + c : c;
  save();
  if (typeof renderModelMemTab === 'function' && _currentMemTab === 'model') renderModelMemTab();
}
function deleteMemory(id) {
  // 1. 先在 state.memories 里找到对应 id 的那条记忆
  const memoryToDelete = state.memories.find(m => m.id === id);
  // 2. 如果找到了，就把它的副本和删除时间一起塞进 state.trash 存档
  if (memoryToDelete) {
    // 初始化垃圾桶数组（防止 state.trash 之前不存在导致报错）
    if (!state.trash) state.trash = []; 
    state.trash.push({
      type: 'memory',
      memoryData: { ...memoryToDelete }, // {...m} 复制一份数据，防止引用污染
      deletedAt: new Date().toISOString()
    });
  }
  // 3. 执行你原来的删除和刷新逻辑
  state.memories = state.memories.filter(m => m.id !== id);
  save(); 
  renderMemoryList(); 
  renderSettingsMemoryList(); 
  renderMemoryBadge();
  showToast('记忆已删除');
}
function renderMemoryBadge() {
  const b = document.getElementById('memoryCountBadge');
  if (b) b.innerText = state.memories.length;
}

function openMemory() {
  document.getElementById('memoryModal').classList.remove('hidden');
  _currentMemTab = 'public';
  // 每次开都从"没搜索"开始。留着上次的词的话，一打开看到的是被筛过的列表，
  // 而搜索框在标签栏下面很容易扫不到 —— 那就是「我的记忆怎么少了一半」。
  // （切标签页时反倒要保留：跨页找同一个词是正常操作。）
  _memSearch = '';
  const si = document.getElementById('memSearchInput'); if (si) si.value = '';
  const amt = document.getElementById('autoMemoryToggle');
  if (amt) amt.checked = !!state.autoMemory;
  renderMemoryList();
}
function closeMemory() { document.getElementById('memoryModal').classList.add('hidden'); }

let _currentMemTab = 'public';

// ═══════════════════════════════════════════════════════
// 记忆搜索
// ═══════════════════════════════════════════════════════
// 高级记忆可能有上千条（比如从 Ombre-Brain 导进来），普鲁斯特和公开记忆也在涨。
// 到这个量级，"翻列表找那条"已经不成立了。
//
// 这里搜的是**存储里的原文**，跟 AI 回话时那套检索（brainWeight 加权、
// 粗召回 + rerank）完全是两回事：那套要判"现在该想起什么"，这里只回答
// "我写过的那句话在哪"。所以刻意不带权重、不排序、不做语义 —— 子串命中就是命中，
// 顺序保持各标签页原本的顺序，这样搜完看到的位置关系和平时一致。
//
// ⚠️ 搜索框写在 memoryList **外面**（index.html 里在 mem-tabs 和 memory-body 之间）。
// 各 render 函数都是整块 `el.innerHTML = …` 重画的，框子放里面的话每敲一个字
// 就会被重建一次 → 光标丢失、输入法拼一半被打断（同 innerHTML 吃掉表单状态那条）。
var _memSearch = '';

// 多个词是 AND：「用户手环」找同时提到两者的那条，而不是把提过用户的全倒出来
function _memSearchTerms() {
  return _memSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function memSearchActive() { return _memSearchTerms().length > 0; }

// 命中判定。传进来的是这条记忆里所有可搜的文本（正文、领域标签、模型名…）
function memSearchHit(...parts) {
  const terms = _memSearchTerms();
  if (!terms.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}

// 转义 + 把命中的词标出来。**必须先转义再插标签** —— 反过来的话
// 记忆正文里的 <script> 会被当成真标签，而记忆内容有一半是 AI 写的。
function memHi(text) {
  let h = escHtml(String(text == null ? '' : text));
  const terms = _memSearchTerms();
  if (!terms.length) return h;
  for (const t of terms) {
    // 转义后的文本里要找的也是转义后的形态（搜 "a<b" 得匹配 "a&lt;b"）
    const esc = escHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (esc) h = h.replace(new RegExp(esc, 'gi'), m => `<mark class="mem-hit">${m}</mark>`);
  }
  return h;
}

function setMemSearch(v) {
  _memSearch = String(v || '');
  _renderCurrentMemTab();
}
function clearMemSearch() {
  _memSearch = '';
  const i = document.getElementById('memSearchInput');
  if (i) i.value = '';
  _renderCurrentMemTab();
}
// 重画当前这一页。switchMemTab 里那串 if 只管切页，这里只管重画，
// 别把两件事揉在一起 —— 搜索每敲一个字都会调，切页的副作用（改 placeholder、
// 显示/隐藏添加框）跑一遍是白费，跑错了更麻烦。
function _renderCurrentMemTab() {
  ({
    public: renderMemoryList,
    recent: renderRecentMemoList,
    brain: renderBrainMemList,
    proust: renderProustList,
    cc: renderCcMemTab,
  }[_currentMemTab] || renderModelMemTab)();
}
// 搜索有词但一条没中时的统一提示。各 render 函数原本的"空列表"文案说的是
// "还没有记忆"，搜不到时照原样显示会让人以为记忆没了。
function memSearchEmptyHtml(what) {
  return `<div class="memory-empty">没有${what}匹配「${escHtml(_memSearch.trim())}」<br>
    <span style="font-size:11px;color:var(--text-muted)">多个词之间是「都要有」的关系，去掉一个再试试</span></div>`;
}
// 「N / 总数」条。没搜索时不显示 —— 平时那个总数在标签页里已经有了，
// 再挂一行只是噪音。
function memSearchCountHtml(hit, total) {
  if (!memSearchActive()) return '';
  return `<div class="mem-search-count">找到 ${hit} 条 <span>（共 ${total} 条）</span></div>`;
}

function switchMemTab(tab, btn) {
  _currentMemTab = tab;
  document.querySelectorAll('.mem-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const addRow = document.getElementById('memAddRow');
  const inp = document.getElementById('newMemoryInput');
  if (tab === 'public') {
    addRow.style.display = 'flex';
    inp.placeholder = '添加记忆片段…';
    renderMemoryList();
  } else if (tab === 'recent') {
    addRow.style.display = 'flex';
    inp.placeholder = '添加最近记忆…';
    renderRecentMemoList();
  } else if (tab === 'brain') {
    addRow.style.display = 'flex';
    inp.placeholder = '添加高级记忆（手动添加默认重要度5、中性情绪）…';
    renderBrainMemList();
  } else if (tab === 'proust') {
    addRow.style.display = 'none';   // 这些瞬间由它自己写下（[[PROUST_ADD]]），手动"添加"就没意思了
    renderProustList();
  } else if (tab === 'cc') {
    addRow.style.display = 'none';   // CC 记忆是 Claude Code 那边写的，这里只读不加
    renderCcMemTab();
  } else {
    addRow.style.display = 'none';
    renderModelMemTab();
  }
}

// 「记忆管理 → CC 互通」标签页：内容原来长在「模型 & API」设置里，用户要求单独列成记忆的子栏目
function renderCcMemTab() {
  const el = document.getElementById('memoryList');
  el.innerHTML = `<div class="cc-mem-tab">
                    <div class="section-desc">
            把 Claude Code 攒下的私人记忆（它每次开会话自动加载的那些事实：你的画像、项目背景、踩过的坑）
            以<strong>索引摘要</strong>形式塞进<strong>订阅 Claude</strong> 的系统提示，让聊天框里的 Claude 也知道这些事。
            只对订阅 Claude 生效，需要电脑上的 server.js 在跑。<br>
            <span style="color:var(--text-muted)">为省 token 只注入每条的标题+一句话摘要（约几百 token）；Claude 需要某条完整内容时，会通过 MCP 自己去读对应的 .md 文件。</span>
          </div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer">
            <input type="checkbox" id="ccMemoryToggle"
                   onchange="state.ccMemoryEnabled=this.checked;save();renderConvSettingsBar();showToast(this.checked?'✓ 订阅 Claude 将读取 CC 记忆':'已关闭 CC 记忆注入')"
                   style="accent-color:var(--accent);width:14px;height:14px">
            <span>启用 CC 记忆注入</span>
          </label>
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
            <button class="conv-settings-btn" onclick="showCcMemoryList()">👀 看看有哪些记忆</button>
            <span id="ccMemoryStat" style="font-size:12px;color:var(--text-muted)"></span>
          </div>
  </div>`;
  const t = document.getElementById('ccMemoryToggle');
  if (t) { t.checked = !!state.ccMemoryEnabled; refreshCcMemoryStat(); }
}

// 模型设定这一栏跟「设置 → 模型」是同一批模型，所以照着同一棵分组树排、
// 共用同一份折叠状态：在设置里收起来的组，翻到这边来也是收着的
function renderModelMemTab() {
  const el = document.getElementById('memoryList');
  if (!el) return;
  if (!state.configs.length) {
    el.innerHTML = `<div class="memory-empty">暂无模型配置</div>`; return;
  }
  // 搜索时**放弃分组树，平铺命中的卡**：分好几层的树里筛出零星几个，
  // 还得一层层展开才看得见，等于没筛。平铺反而一眼到底。
  // （人设 textarea 是 oninput 就存的，没有"未保存内容"会被重画吃掉的问题。）
  if (memSearchActive()) {
    const hits = state.configs
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => memSearchHit(c.nickname, c.modelName, c.persona));
    el.innerHTML = hits.length
      ? memSearchCountHtml(hits.length, state.configs.length) + hits.map(({ c, i }) => _memModelCard(c, i)).join('')
      : memSearchEmptyHtml('模型设定');
    return;
  }
  const tree = modelGroupTree();
  if (tree.length === 1 && !tree[0].path) {          // 一个分组都没建，平铺就好
    el.innerHTML = tree[0].items.map(({ c, i }) => _memModelCard(c, i)).join('');
    return;
  }
  const folded = _foldedGroups();
  el.innerHTML = tree.map(g => _memGroupHtml(g, folded)).join('');
}

function _memGroupHtml(g, folded) {
  const isFolded = folded.includes(g.path);
  return `
    <div class="model-group ${g.path ? '' : 'loose'}">
      <div class="model-group-head" data-g="${escHtml(g.path)}"
           onclick="toggleModelGroupFold(this.dataset.g)">
        <span class="model-group-caret ${isFolded ? 'folded' : ''}">▾</span>
        <span class="model-group-name">${escHtml(g.path ? g.name : '未分组')}</span>
        <span class="model-group-count">${mgCountDeep(g.path)}</span>
      </div>
      <div class="model-group-body ${isFolded ? 'hidden' : ''}">
        ${g.children.map(k => _memGroupHtml(k, folded)).join('')}
        ${g.items.map(({ c, i }) => _memModelCard(c, i)).join('')}
      </div>
    </div>`;
}

function _memModelCard(c, i) {
    const pEnabled = c.personaEnabled !== false;
    return `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;opacity:${pEnabled ? 1 : 0.55}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        ${c.avatar ? `<img src="${c.avatar}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;border:1px solid var(--border-mid);">` : `<div style="width:24px;height:24px;border-radius:50%;background:${getModelColor(c.id)}22;color:${getModelColor(c.id)};display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0;">${escHtml((c.nickname||'AI').slice(0,1))}</div>`}
        <span style="font-size:13px;font-weight:700;color:var(--text-primary)">${memHi(c.nickname)}</span>
        <span style="font-size:10px;color:var(--text-muted)">(${memHi(c.modelName)})</span>
        <button class="mem-toggle${pEnabled ? ' on' : ''}" onclick="togglePersonaEnabled(${i})" title="是否把这段设定注入系统提示"
          style="margin-left:auto">${pEnabled ? '✓ 启用' : '已禁用'}</button>
      </div>
      <div class="field-label" style="margin-bottom:6px;">设定库 / Persona</div>
      <textarea class="persona-textarea" style="min-height:70px;font-size:12px;"
        placeholder="设定、说话风格、背景故事…"
        oninput="state.configs[${i}].persona=this.value;save()">${escHtml(c.persona||'')}</textarea>
    </div>`;
}

function togglePersonaEnabled(i) {
  const c = state.configs[i];
  if (!c) return;
  c.personaEnabled = c.personaEnabled === false ? true : false;
  save();
  renderModelMemTab();
}

function renderMemoryList() {
  if (_currentMemTab !== 'public') return;
  const el = document.getElementById('memoryList');
  if (!state.memories.length) {
    el.innerHTML = `<div class="memory-empty">(˘・_・˘) 暂无记忆。<br>发送消息后 AI 会自动提炼关键信息。</div>`;
    return;
  }
  const hits = state.memories.filter(m => memSearchHit(m.text));
  if (!hits.length) { el.innerHTML = memSearchEmptyHtml('公开记忆'); return; }
  el.innerHTML = memSearchCountHtml(hits.length, state.memories.length) + hits.map(m => {
    const isEnabled = m.enabled !== false;
    const date = m.createdAt
      ? new Date(m.createdAt).toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
      : '–';
    return `
    <div class="memory-item" id="mitem-${m.id}" style="opacity:${isEnabled ? 1 : 0.45}">
      <div style="flex:1;min-width:0">
        <span class="memory-text">${memHi(m.text)}</span>
        <div class="mem-item-date">🕐 ${date}</div>
      </div>
      <div class="mem-item-actions">
        <button class="mem-toggle${isEnabled ? ' on' : ''}" onclick="toggleMemoryEnabled(${m.id})"
          title="${isEnabled ? '点一下停用：AI 暂时看不到这条' : '点一下重新启用'}">${isEnabled ? '✓ 启用' : '已禁用'}</button>
        <button class="memory-edit-btn" onclick="startEditMemory(${m.id})" title="编辑" aria-label="编辑">✎</button>
        <button class="memory-del" onclick="deleteMemory(${m.id})" title="删除" aria-label="删除">✕</button>
      </div>
    </div>`;
  }).join('');
}

function startEditMemory(id) {
  const el = document.getElementById('mitem-' + id);
  if (!el) return;
  const mem = state.memories.find(m => m.id === id);
  if (!mem) return;
  el.innerHTML = `
    <div style="width:100%">
      <textarea class="memory-edit-ta" id="medit-${id}">${escHtml(mem.text)}</textarea>
      <div class="memory-edit-btns">
        <button class="mem-cancel-btn" onclick="renderMemoryList()">取消</button>
        <button class="mem-save-btn" onclick="saveMemoryEdit(${id})">保存</button>
      </div>
    </div>`;
  const ta = document.getElementById('medit-' + id);
  ta?.focus();
}

function saveMemoryEdit(id) {
  const ta = document.getElementById('medit-' + id);
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;
  const mem = state.memories.find(m => m.id === id);
  if (mem) { mem.text = newText; save(); renderMemoryList(); renderSettingsMemoryList(); renderMemoryBadge(); showToast('✓ 记忆已更新', 'success'); }
}

function toggleMemoryEnabled(id) {
  const m = state.memories.find(m => m.id === id);
  if (!m) return;
  m.enabled = m.enabled === false ? true : false;
  save();
  renderMemoryList();
  renderSettingsMemoryList();
  renderMemoryBadge();
}

function renderSettingsMemoryList() {
  const el = document.getElementById('settingsMemoryList'); if (!el) return;
  if (!state.memories.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">暂无记忆</div>`; return;
  }
  el.innerHTML = state.memories.slice(0, 6).map(m => {
    const isEnabled = m.enabled !== false;
    const date = m.createdAt
      ? new Date(m.createdAt).toLocaleDateString('zh-CN')
      : '';
    return `
    <div class="memory-item" style="margin-bottom:6px;opacity:${isEnabled ? 1 : 0.45}">
      <div style="flex:1;min-width:0">
        <span class="memory-text">${escHtml(m.text)}</span>
        ${date ? `<div class="mem-item-date">🕐 ${date}</div>` : ''}
      </div>
      <div class="mem-item-actions">
        <button class="mem-toggle${isEnabled ? ' on' : ''}" onclick="toggleMemoryEnabled(${m.id});renderSettingsMemoryList()"
          title="${isEnabled ? '已启用，点一下停用' : '已停用，点一下启用'}">${isEnabled ? '✓' : '禁'}</button>
        <button class="memory-del" onclick="deleteMemory(${m.id});renderSettingsMemoryList()" title="删除" aria-label="删除">✕</button>
      </div>
    </div>`;
  }).join('') + (state.memories.length > 6 ? `<div style="font-size:11px;color:var(--text-muted);padding:4px 2px">还有 ${state.memories.length-6} 条…</div>` : '');
}

function addMemoryManual() {
  const inp = document.getElementById('newMemoryInput');
  if (_currentMemTab === 'recent') {
    addRecentMemo(inp.value); inp.value = '';
    renderRecentMemoList();
  } else if (_currentMemTab === 'brain') {
    addBrainMemory({ text: inp.value }); inp.value = '';
    renderBrainMemList();
  } else {
    addMemory(inp.value); inp.value = '';
    renderMemoryList(); renderSettingsMemoryList();
  }
}

function addMemoryFromSettings() {
  const inp = document.getElementById('settingsMemInput');
  addMemory(inp.value); inp.value = '';
  renderMemoryList(); renderSettingsMemoryList();
}

// ═══════════════════════════════════════════════════════
// GROUP BOARD (群公告栏 / 群记忆)
// ═══════════════════════════════════════════════════════
function openGroupBoard() {
  const chat = getActiveChat();
  if (!chat) return;
  document.getElementById('groupBoardModal').classList.remove('hidden');
  renderGroupBoard();
}
function closeGroupBoard() {
  document.getElementById('groupBoardModal').classList.add('hidden');
}
function renderGroupBoard() {
  const chat = getActiveChat();
  const el = document.getElementById('boardBody');
  if (!el || !chat) return;
  const board = chat.groupBoard || [];
  if (!board.length) {
    el.innerHTML = `<div class="board-empty">📋 还没有公告哦，加一条吧！<br><span style="font-size:11px;opacity:.5">可以存公告、约定、群规、共享资料等</span></div>`;
    return;
  }
  el.innerHTML = board.map(item => `
    <div class="board-item" id="bitem-${item.id}">
      <div class="board-item-text">${escHtml(item.text)}</div>
      <div class="board-item-actions">
        <button class="board-item-edit" onclick="startEditBoardItem(${item.id})">✎</button>
        <button class="board-item-del" onclick="deleteBoardItem(${item.id})">✕</button>
      </div>
    </div>`).join('');
}
function addBoardItem() {
  const inp = document.getElementById('boardInput');
  const text = inp.value.trim();
  if (!text) return;
  const chat = getActiveChat(); if (!chat) return;
  if (!chat.groupBoard) chat.groupBoard = [];
  chat.groupBoard.push({ id: nextId(), text, createdAt: Date.now() });
  inp.value = '';
  save(); renderGroupBoard();
}
function deleteBoardItem(id) {
  const chat = getActiveChat(); if (!chat) return;
  chat.groupBoard = (chat.groupBoard || []).filter(b => b.id !== id);
  save(); renderGroupBoard(); showToast('公告已删除');
}
function startEditBoardItem(id) {
  const chat = getActiveChat(); if (!chat) return;
  const item = (chat.groupBoard || []).find(b => b.id === id);
  if (!item) return;
  const el = document.getElementById('bitem-' + id);
  if (!el) return;
  el.innerHTML = `
    <div style="width:100%">
      <textarea class="memory-edit-ta" id="bedit-${id}" style="width:100%">${escHtml(item.text)}</textarea>
      <div class="memory-edit-btns">
        <button class="mem-cancel-btn" onclick="renderGroupBoard()">取消</button>
        <button class="mem-save-btn" onclick="saveBoardEdit(${id})">保存</button>
      </div>
    </div>`;
  document.getElementById('bedit-' + id)?.focus();
}
function saveBoardEdit(id) {
  const ta = document.getElementById('bedit-' + id);
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;
  const chat = getActiveChat(); if (!chat) return;
  const item = (chat.groupBoard || []).find(b => b.id === id);
  if (item) { item.text = newText; save(); renderGroupBoard(); showToast('✓ 公告已更新', 'success'); }
}
function updateGroupBoardBtn() {
  // 群公告和“谁是 user”统一由 renderConvSettingsBar 画在群聊控制面板里。
  // 保留函数名给旧调用点，避免切换对话时出现 missing function。
  if (typeof renderConvSettingsBar === 'function') renderConvSettingsBar();
}

// ═══════════════════════════════════════════════════════
// PLAY MODE — play-prompt-kit 集成
// ═══════════════════════════════════════════════════════
