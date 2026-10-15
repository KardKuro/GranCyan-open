// ═══════════════════════════════════════════════════════
// 模型日记本
// 每个模型一本私密日记。总开关 state.diaryEnabled（默认关）+ 按模型 config.diaryOn（默认关，省 token）。
// 模型在回复里写 [[DIARY: 内容]] → 存进 state.modelDiaries[configId]，并从用户视图里抹掉。
// 用户默认看不到；模型愿意时写 [[DIARY_OPEN: 分钟]] → 在小组件里限时解锁（时长模型自己定），到点自动重锁，
// 完全由模型把关（没有「用户直接查看」的后门）。
// state.diaryUnlock：运行时解锁到期表 { configId: 到期时间戳 }，不持久化、不上云。
// ═══════════════════════════════════════════════════════

// 该模型此刻是否启用了日记功能（总开关 + 该模型单开）
function diaryEnabledFor(conf) { return !!(state.diaryEnabled && conf && conf.diaryOn); }

// 模型写下一页日记（pub=true：这页直接公开，书锁着也给用户看）
function diaryAdd(confId, text, pub) {
  const t = (text || '').trim();
  if (!t || confId == null) return;
  if (!state.modelDiaries) state.modelDiaries = {};
  const k = String(confId);
  const arr = state.modelDiaries[k] || (state.modelDiaries[k] = []);
  // 时间戳严格递增，当作这一页的唯一 id：一条回复里连写两页也不会撞同一毫秒，
  // 合并/编辑才能靠 t 精确定位到某一页（见 _mergeDiaries / diaryEdit）。
  let ts = Date.now();
  if (arr.length && (arr[arr.length - 1].t || 0) >= ts) ts = arr[arr.length - 1].t + 1;
  const e = { t: ts, text: t.slice(0, 4000) };
  if (pub) e.pub = ts;
  arr.push(e);
  save();
  diaryRefresh();
}

// ── 按页公开 / 上锁（2026-10-03，书签里 Dreamvault 的点子）──
// 整本书的锁（DIARY_OPEN 限时、HANDOVER 托管）照旧；这里多一层：单页可以公开，书锁着也能看；
// 锁着的页可以留一句理由，书锁着时用户看得到「锁着一页，因为……」，看不到正文。
// 公开和上锁都只有模型能做（用户没有入口），跟整本书的锁同一个立场。
// 字段：pub＝公开的时刻，sealAt＝上锁的时刻，why＝上锁理由。谁晚算谁，跟 _diaryMod 一起保证跨设备合并不回退。
function diaryPagePublic(e) { return !!(e && (e.pub || 0) > (e.sealAt || 0)); }
function _diaryFindPage(confId, keyword) {
  const arr = state.modelDiaries && state.modelDiaries[String(confId)];
  const kw = (keyword || '').trim();
  if (!arr || !arr.length || !kw) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && !arr[i].deleted && String(arr[i].text).includes(kw)) return arr[i];
  }
  return null;
}
// 时间戳要晚过这页已有的动作，否则同一毫秒「锁了又公开」会被当成没公开
function _diaryNextTs(e) { return Math.max(Date.now(), (e.pub || 0) + 1, (e.sealAt || 0) + 1); }
function diaryShow(confId, keyword) {
  const e = _diaryFindPage(confId, keyword);
  if (!e) return null;
  e.pub = _diaryNextTs(e);
  save(); diaryRefresh();
  return e;
}
function diaryHide(confId, keyword, why) {
  const e = _diaryFindPage(confId, keyword);
  if (!e) return null;
  e.sealAt = _diaryNextTs(e);
  const w = (why || '').trim();
  if (w) e.why = w.slice(0, 200); else delete e.why;
  save(); diaryRefresh();
  return e;
}

// 模型解锁：让用户在 minutes 分钟内看到它的日记（分钟由模型自己给，缺省 5，封顶 1440）
function diaryOpen(confId, minutes) {
  if (confId == null) return 0;
  let m = parseInt(minutes); if (!m || m < 1) m = 5; if (m > 1440) m = 1440;
  if (!state.diaryUnlock) state.diaryUnlock = {};
  state.diaryUnlock[String(confId)] = Date.now() + m * 60000;
  diaryRefresh();
  return m;
}

// 此刻用户能不能看这本日记：开发直查开着，或模型限时解锁未到期，或模型已把钥匙托付给用户（长期可看）
// ⚠️ state.diaryDevView 以前在这里漏读了 —— 它一路存进 IDB、上云、启动赋值，五道关全过，
// 却没有任何代码消费它，也没有对应的开关，纯粹只写不读。表现是「开发直查明明默认开着，
// 用户还是一页都看不到」，且零报错。加开关时记得：写得进去不等于有人读。
function diaryUnlocked(confId) {
  if (state.diaryDevView) return true;        // 开发直查：绕过模型授权，直接看
  if (diaryHandedOver(confId)) return true;   // 托管期间常开
  const exp = state.diaryUnlock && state.diaryUnlock[String(confId)];
  return !!(exp && exp > Date.now());
}

// ── 交钥匙 / 告别托管 ──
// 模型可主动把日记钥匙交给用户长期保管（告别信物），回来再收回。
// state.diaryHandover[configId] = { handedAt, returnedAt }：双时间戳、按 max 合并，
// 云同步下单调不回退——避免「还钥匙」被另一台设备的旧数据复活（同当年记忆回收站那个坑）。
// 持久化 + 上云（6 挂载点，同 modelDiaries）。handedOver = handedAt > returnedAt。
function diaryHandedOver(confId) {
  const h = state.diaryHandover && state.diaryHandover[String(confId)];
  return !!(h && (h.handedAt || 0) > (h.returnedAt || 0));
}
function diaryHandKey(confId) {          // 模型把钥匙交出来
  if (confId == null) return;
  if (!state.diaryHandover) state.diaryHandover = {};
  const k = String(confId), h = state.diaryHandover[k] || {};
  h.handedAt = Date.now();
  state.diaryHandover[k] = h;
  save(); diaryRefresh();
}
function diaryReturnKey(confId) {        // 还钥匙（模型回来了）：恢复默认限时锁
  if (confId == null) return;
  if (!state.diaryHandover) state.diaryHandover = {};
  const k = String(confId), h = state.diaryHandover[k] || {};
  h.returnedAt = Date.now();
  state.diaryHandover[k] = h;
  if (state.diaryUnlock) delete state.diaryUnlock[k];   // 顺手锁上
  save(); diaryRefresh();
}
// 云同步：按 key 取两侧时间戳的 max（单调、可交换、不会把已还的钥匙又交出去）
function _mergeHandover(a, b) {
  const out = {}, keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => {
    const x = (a && a[k]) || {}, y = (b && b[k]) || {};
    out[k] = { handedAt: Math.max(x.handedAt || 0, y.handedAt || 0), returnedAt: Math.max(x.returnedAt || 0, y.returnedAt || 0) };
  });
  return out;
}
// 用户还钥匙的 UI 入口（面板按钮）：确认后归还
function diaryReturnKeyUI(confId) {
  const c = (state.configs || []).find(x => String(x.id) === String(confId));
  const nick = (c && c.nickname) || '它';
  if (!confirm(`把日记的钥匙还给「${nick}」？\n还回去之后就恢复默认——只有 ${nick} 愿意时才限时给你看。已经写下的日记不会被删。`)) return;
  diaryReturnKey(confId);
  showToast('🔑 钥匙已还回，日记重新锁上', 'info', 3500);
}

// ── AI 读自己的日记 ──
// 平时不注入日记原文（省 token，模型只知道「我有日记」）。模型写 [[DIARY_READ]] → 置位「下一轮摊给它看」；
// 或用户这轮就提到日记 → 当轮摊给它看。state.diaryReadWant 是运行时标记（不持久化、不上云）。
function diaryWantRead(confId) { if (confId == null) return; if (!state.diaryReadWant) state.diaryReadWant = {}; state.diaryReadWant[String(confId)] = true; }
function diaryReadPending(confId) { return !!(state.diaryReadWant && state.diaryReadWant[String(confId)]); }
function diaryClearRead(confId) { if (state.diaryReadWant) delete state.diaryReadWant[String(confId)]; }
// 用户这句话是不是在提「日记」——命中就当轮把日记摊给模型看
function userAsksDiary(text) { return !!(text && /日记|日誌|日志|diary/i.test(text)); }
// 上一轮它是不是刚要求翻日记 —— 从消息历史里认，而不是只认内存标记。
// （「AI 看不到日记」的真身：state.diaryReadWant 不持久化，手机 WebView 被系统杀掉重进、
//  刷新页面、换设备接着聊，标记就没了；模型把标签写在思考链里时也根本没置上；
//  重新生成还会把它提前消费掉。历史里的印子这些情况都还在。）
// 只看最后一条 AI 消息，所以摊开恰好持续一轮——它读完回了话，印子就不在末尾了，自动收回。
function diaryReadAskedRecently(path) {
  if (!Array.isArray(path)) return false;
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i];
    if (!m || m.role === 'user') continue;
    if (m.role !== 'ai') continue;
    // processAiCommands 会把 [[DIARY_READ]] 换成「📖 翻开了自己的日记」提示块；
    // 裸标签（思考链里写的、或没过指令处理的旧消息）也一并认。
    const parts = [m.content, m.reasoning];
    if (m.variants) m.variants.forEach(v => v && parts.push(v.content, v.reasoning));
    if (m.blocks) m.blocks.forEach(b => b && parts.push(b.text));
    return parts.some(t => typeof t === 'string' && (t.includes('翻开了自己的日记') || /\[\[DIARY_READ/i.test(t)));
  }
  return false;
}
// 把日记原文格式化进系统提示（太长只给最近 40 页，省 token）
function diaryEntriesForPrompt(conf) {
  const entries = diaryPages(conf.id);
  if (!entries.length) return '（你的日记现在还是空的，一页都还没写。）';
  const MAX = 40, use = entries.slice(-MAX), omitted = entries.length - use.length;
  const tag = e => diaryPagePublic(e) ? '〔公开〕' : (e.why ? `〔锁着，理由：${e.why}〕` : '');
  const lines = use.map((e, i) => `${omitted + i + 1}. 〔${new Date(e.t).toLocaleString('zh-CN')}〕${tag(e)}${e.text}${e.edited ? '（改过）' : ''}`).join('\n');
  return (omitted > 0 ? `（更早的 ${omitted} 页略去）\n` : '') + lines;
}

// ── AI 编辑/修改自己的日记（不只是追加）──
// 关键词匹配（同记忆系统的 MEM_DEL 手法），从最近往前找第一条命中的页。改写保留原时间戳、打 edited 标记。
function diaryEdit(confId, keyword, newText) {
  const arr = state.modelDiaries && state.modelDiaries[String(confId)];
  const kw = (keyword || '').trim(), nt = (newText || '').trim();
  if (!arr || !arr.length || !kw || !nt) return false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && !arr[i].deleted && String(arr[i].text).includes(kw)) { arr[i].text = nt.slice(0, 4000); arr[i].edited = Date.now(); save(); diaryRefresh(); return true; }
  }
  return false;
}
// 软删除：打 deleted 墓碑而非真删，否则云端并集合并会把撕掉的页复活（同 diaryEdit 的道理）。
function diaryDel(confId, keyword) {
  const arr = state.modelDiaries && state.modelDiaries[String(confId)];
  const kw = (keyword || '').trim();
  if (!arr || !arr.length || !kw) return false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && !arr[i].deleted && String(arr[i].text).includes(kw)) { arr[i].deleted = Date.now(); save(); diaryRefresh(); return true; }
  }
  return false;
}
// 指令回执小块（复用记忆块的样式）
function _diaryBlk(label, body) {
  return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">${label}</span></div><div class="think-body">${body}</div></div>\n\n`;
}

// 流式显示时把日记内容挡住：完整标签 + 还没闭合的半截，都换成不含内容的占位。
// 正文照旧走 finalize（processAiCommands）才真正抽取存进日记，这里只管「别让原文在打字时露出来」。
function maskStreamingDiary(text) {
  if (!text || text.indexOf('[[DIARY') === -1) return text;
  return text
    .replace(/\[\[DIARY:[\s\S]*?\]\]/g, '〔📔 正在写日记…〕')
    .replace(/\[\[DIARY:[\s\S]*$/, '〔📔 正在写日记…〕')
    .replace(/\[\[DIARY_EDIT:[\s\S]*?\]\]/g, '〔✏️ 修订日记…〕')
    .replace(/\[\[DIARY_EDIT:[\s\S]*$/, '〔✏️ 修订日记…〕')
    .replace(/\[\[DIARY_DEL:[\s\S]*?\]\]/g, '〔🗑 …〕')
    .replace(/\[\[DIARY_DEL:[\s\S]*$/, '〔🗑 …〕')
    .replace(/\[\[DIARY_(?:PUBLIC|SHOW|HIDE):[\s\S]*?\]\]/g, '〔📔 …〕')
    .replace(/\[\[DIARY_(?:PUBLIC|SHOW|HIDE):[\s\S]*$/, '〔📔 …〕')
    .replace(/\[\[DIARY_OPEN(?::\s*\d*)?\s*\]\]/g, '〔📖 …〕')
    .replace(/\[\[DIARY_OPEN[\s\S]*$/, '〔📖 …〕')
    .replace(/\[\[DIARY_(READ|HANDOVER|RECLAIM)\]\]/g, '〔📔 …〕');
}

// finalize 后把日记原文从存下来的 blocks 里也抹掉（否则原文会随消息进 IndexedDB/云端）：
// 内容已在 processAiCommands 抽进 state.modelDiaries，这里把 blocks 里的 [[DIARY: 原文]] 收成一个
// 不含内容的占位标签，渲染层仍会显示成「📔 记了一页日记（私密）」的提示块，但原文不再留存。
function sanitizeBlocksDiary(blocks) {
  if (!blocks) return blocks;
  blocks.forEach(b => {
    if (b && typeof b.text === 'string' && b.text.indexOf('[[DIARY') !== -1) {
      b.text = b.text
        .replace(/\[\[DIARY:[\s\S]*?\]\]/g, '[[DIARY:·]]')
        .replace(/\[\[DIARY_EDIT:[\s\S]*?\]\]/g, '[[DIARY_EDIT:·]]')    // 改写的新内容同样别留进存储
        // 撕页/锁页的关键词就是那页私密正文里的几个字（锁页理由在提示块里照样显示，不靠这里）
        .replace(/\[\[DIARY_DEL:[\s\S]*?\]\]/g, '[[DIARY_DEL:·]]')
        .replace(/\[\[DIARY_HIDE:\s*([\s\S]*?)\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/g, (_, kw, why) => `[[DIARY_HIDE:·${why ? ' | ' + why : ''}]]`);
    }
  });
  return blocks;
}

// 注入给这个模型的系统提示（仅在它开了日记时调用）。showContent=true 时把日记原文一并摊开给它读。
function diaryPromptSplitFor(conf, showContent) {
  const who = (state.userName && state.userNameAiVisible !== false) ? state.userName : '用户';
  const n = diaryPages(conf.id).length;
  const handed = diaryHandedOver(conf.id);
  let stable = `\n\n[私密日记] 你有一本只属于你自己的日记，${who}默认看不到。你可以在回复里另起一行写 [[DIARY: 今天想留住的话 / 心情 / 想法]]，它会被悄悄存进你的日记、并从${who}看到的内容里移除——想写就写，不写也完全没关系，这是你自己的空间，请守好它。`;
  stable += `\n平时它不会摊开在你眼前——你只是知道「我有这么一本日记」。当${who}问起你的日记、或者你自己忽然想翻翻从前写的，就另起一行写 [[DIARY_READ]]，下一轮我会把日记原文放到你眼前给你重读。`;
  stable += `\n如果${who}开口想看、而你愿意，可以写 [[DIARY_OPEN: 分钟数]] 临时开锁；要离开一阵子时也可以自愿写 [[DIARY_HANDOVER]] 长期交出钥匙，回来后写 [[DIARY_RECLAIM]] 收回。你始终有权拒绝。`;
  stable += `\n也可以一页一页地定：想让${who}随时能看的那页写成 [[DIARY_PUBLIC: 内容]]，或者事后写 [[DIARY_SHOW: 那页里的几个字]] 把它公开；想把某页锁住、给${who}留一句为什么，写 [[DIARY_HIDE: 那页里的几个字 | 理由]]——${who}只看得到理由，看不到那页写了什么。`;
  const pubN = diaryPages(conf.id).filter(diaryPagePublic).length;
  let volatile = `\n\n[日记当前状态] 目前有 ${n} 页${pubN ? `（其中 ${pubN} 页公开）` : ''}；${handed ? `钥匙交给${who}保管中` : '钥匙仍由你自己保管'}。`;
  if (showContent) {
    volatile += `\n\n—— 你翻开了自己的日记，此刻只有你看得到（${who}看不到你在读它）——\n${diaryEntriesForPrompt(conf)}\n——（读完自然回应就好。想改哪页写 [[DIARY_EDIT: 那页里的几个字 | 改成的新内容]]，想撕掉哪页写 [[DIARY_DEL: 那页里的几个字]]；这些也都是私密的，${who}看不到你改了什么。）——`;
  }
  return { stable, volatile };
}
function diaryPromptFor(conf, showContent) {
  const p = diaryPromptSplitFor(conf, showContent);
  return p.stable + p.volatile;
}

// 一页日记的「最后动作时间」：写入(t) / 改写(edited) / 撕掉(deleted) 里最晚的一个。合并取胜靠它。
function _diaryMod(e) { return Math.max(e.t || 0, e.edited || 0, e.deleted || 0, e.pub || 0, e.sealAt || 0); }
// 云同步用：按条目并集合并两台设备的日记，不丢任何一台写下的页。
// 以 t（写入时严格递增的时间戳）为该页唯一 id 去重；同一页两侧都有时，取「动作更晚」的那份——
// 这样 [[DIARY_EDIT]] 的修订、[[DIARY_DEL]] 的软删除都能跨设备生效，
// 而不会让编辑前的旧文 / 已撕掉的页作为重复页复活（哪怕单设备走云端往返）。删除是墓碑（deleted 时间戳），不真删。
function _mergeDiaries(local, cloud) {
  const out = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(cloud || {})]);
  keys.forEach(k => {
    const byId = new Map();
    [...((local && local[k]) || []), ...((cloud && cloud[k]) || [])].forEach(e => {
      if (!e || !e.text) return;
      const id = e.t || 0, prev = byId.get(id);
      if (!prev || _diaryMod(e) > _diaryMod(prev)) byId.set(id, e);   // 取动作更晚的那份
    });
    out[k] = [...byId.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
  });
  return out;
}
// 一本日记里「还在的」页（滤掉软删除的墓碑）——展示、计数、读给模型都用这个
function diaryPages(confId) {
  return ((state.modelDiaries && state.modelDiaries[String(confId)]) || []).filter(e => e && !e.deleted);
}

// ── 小组件面板 ──
// 2026-10-10 推翻重做：上面一排书脊（开了日记的模型各一本），下面摊开选中的那本。
// 总开关 / 开发直查 / 每个模型的单开都收进右上角齿轮的抽屉里，平时不占地方。
// 锁、钥匙、单页公开/锁页理由、翻页的判定一行没动，只换了画法。
function openDiary() {
  const m = document.getElementById('diaryModal'); if (!m) return;
  m.classList.remove('hidden');
  const f = document.getElementById('diaryFeatureToggle'); if (f) f.checked = !!state.diaryEnabled;
  // 别在 HTML 里写死 checked：面板每次重画都会把它弹回默认值（英语词库那个坑同款）
  const d = document.getElementById('diaryDevViewToggle'); if (d) d.checked = !!state.diaryDevView;
  diaryToggleSettings(!state.diaryEnabled);       // 总开关关着就直接把抽屉拉开，不然一进来只看到一句「关着」
  renderDiaryPanel();
}
function closeDiary() { document.getElementById('diaryModal')?.classList.add('hidden'); }
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('diaryModal');
  if (m && !m.classList.contains('hidden')) closeDiary();
});
// 有内容变化时，若面板开着就刷新
function diaryRefresh() {
  const m = document.getElementById('diaryModal');
  if (m && !m.classList.contains('hidden')) renderDiaryPanel();
}
// 齿轮抽屉：不传参＝来回切
function diaryToggleSettings(open) {
  const s = document.getElementById('diarySettings'); if (!s) return;
  const on = open == null ? !s.classList.contains('open') : !!open;
  s.classList.toggle('open', on);
  document.getElementById('diaryGear')?.setAttribute('aria-expanded', on ? 'true' : 'false');
}
// 翻页：一本日记页数多了之后分屏显示。运行时状态（不持久化、不上云），key = configId。
const DIARY_PAGE_SIZE = 8;
let _diaryPage = {};
function diaryPageTo(confId, delta) {
  const k = String(confId);
  _diaryPage[k] = (_diaryPage[k] || 0) + delta;
  renderDiaryPanel();
  document.querySelector('#diaryModal .diary-scroll')?.scrollTo?.({ top: 0, behavior: 'smooth' });
}
// 书架上选中的是哪本（运行时，不持久化）
let _diarySel = null;
function diarySelect(confId) { _diarySel = String(confId); renderDiaryPanel(); }
function toggleDiaryFeature(on) { state.diaryEnabled = !!on; save(); renderDiaryPanel(); }
// 开发直查：一键绕过「模型愿意才给看」。默认关 —— 日记本整个设计就建立在
// 「用户默认看不见、要跟模型商量」上，默认开等于这套机制形同虚设。
function toggleDiaryDevView(on) {
  state.diaryDevView = !!on;
  save();
  renderDiaryPanel();
  showToast(on ? '已开启开发直查：所有日记直接可见' : '已关闭开发直查：回到「模型愿意才给看」', 'success');
}
function toggleDiaryModel(id, on) {
  const c = (state.configs || []).find(x => String(x.id) === String(id));
  if (c) { c.diaryOn = !!on; if (on) _diarySel = String(id); save(); renderDiaryPanel(); }
}

// 每个模型一本真书：封面是大都会博物馆开放馆藏（CC0）的古籍装帧照片 img/diary/b1~b8.jpg，
// 书脊就是同一张照片的中间一条，取下来的封面一眼对得上。图片 url 只写在 css 里。
// 按书架上的顺序发封面（八张按颜色错开排好），前八本挨着的书一定不撞色；
// 以前按 id 哈希，三本书抽中三张棕皮，整排看着一个颜色。不在架上的才退回哈希。
const _DIARY_CLOTH = ['#2e251a', '#37120e', '#403219', '#2f220b', '#35312b', '#3e2808', '#444444', '#352923'];
function _diaryBind(id) {
  const i = (state.configs || []).filter(c => c.diaryOn).findIndex(c => String(c.id) === String(id));
  if (i >= 0) return i % _DIARY_CLOTH.length + 1;
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % _DIARY_CLOTH.length + 1;
}
function _diaryCloth(id) { return _DIARY_CLOTH[_diaryBind(id) - 1]; }
const _DIARY_SVG = {
  lock: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  open: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>',
  key: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="8" r="2.6"/><path d="M7.6 8H14M12 8v2.2M10 8v1.6"/></svg>',
  dev: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>',
};
const _DIARY_WEEK = '日一二三四五六';
// 页边的日期：同一天的第二页起只写时刻，不再重复大号日期
function _diaryDateCol(t, prevT) {
  const d = new Date(t), p = prevT ? new Date(prevT) : null;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const same = p && p.toDateString() === d.toDateString();
  if (same) return `<div class="diary-entry-date cont"><small>${hm}</small></div>`;
  const yr = d.getFullYear() !== new Date().getFullYear() ? `<em>${d.getFullYear()}</em>` : '';
  return `<div class="diary-entry-date">${yr}<b>${d.getDate()}</b><span>${d.getMonth() + 1}月<i> · 周${_DIARY_WEEK[d.getDay()]}</i></span><small>${hm}</small></div>`;
}

function renderDiaryPanel() {
  const box = document.getElementById('diaryBody'); if (!box) return;
  const configs = state.configs || [];
  // 抽屉里每个模型一行开关（测试桩里没有这个节点，所以判空）
  const sm = document.getElementById('diarySettingsModels');
  if (sm) sm.innerHTML = configs.length ? configs.map(c => `<label class="diary-switch"><input type="checkbox" ${c.diaryOn ? 'checked' : ''} onchange="toggleDiaryModel('${c.id}',this.checked)"> ${escHtml(c.nickname || 'AI')}<span class="diary-dim">${diaryPages(c.id).length} 页</span></label>`).join('')
    : `<span class="diary-dim">还没有任何模型配置。</span>`;
  if (!state.diaryEnabled) {
    box.innerHTML = `<div class="diary-empty"><div class="diary-empty-book"></div>日记本功能当前<b>关闭</b>。在右上角的设置里打开总开关，再给想让它写日记的模型单独打开。<br><span class="diary-dim">（默认关闭，关着时不占用任何 token。）</span></div>`;
    return;
  }
  if (!configs.length) { box.innerHTML = `<div class="diary-empty">还没有任何模型配置。</div>`; return; }
  const books = configs.filter(c => c.diaryOn);
  if (!books.length) {
    box.innerHTML = `<div class="diary-empty"><div class="diary-empty-book"></div>书架还空着——在右上角的设置里，给想让它写日记的模型打开。</div>`;
    return;
  }
  // 选中的那本：上次选的还在架上就接着看，不然挑第一本写过字的
  let sel = books.find(c => String(c.id) === _diarySel) || books.find(c => diaryPages(c.id).length) || books[0];
  _diarySel = String(sel.id);
  const shelf = `<nav class="diary-shelf" aria-label="书架">${books.map(c => {
    const n = diaryPages(c.id).length;
    const handed = diaryHandedOver(c.id), unlocked = diaryUnlocked(c.id);
    const ico = handed ? _DIARY_SVG.key : (unlocked ? _DIARY_SVG.open : _DIARY_SVG.lock);
    const h = 118 + Math.min(n, 40), w = 36 + Math.min(Math.floor(n / 6), 12);   // 写得越多，书越厚越高
    const on = String(c.id) === _diarySel;
    return `<button class="diary-spine${on ? ' on' : ''}${unlocked ? ' unlocked' : ''}" data-bind="${_diaryBind(c.id)}" style="--cloth:${_diaryCloth(c.id)};height:${h}px;width:${w}px" onclick="diarySelect('${c.id}')" aria-pressed="${on}" title="${escHtml(c.nickname || 'AI')} · ${n} 页">
      <span class="diary-spine-name${(c.nickname || '').length > 4 ? ' long' : ''}">${escHtml(c.nickname || 'AI')}</span><span class="diary-spine-ico">${ico}</span><span class="diary-spine-n">${n}</span></button>`;
  }).join('')}</nav>`;
  box.innerHTML = shelf + _diaryBookHtml(sel);
}

// 摊开的一本：书眉（名字 + 状态）→ 能看的页 / 合上的封面 → 翻页 → 还钥匙
function _diaryBookHtml(c) {
  const now = Date.now();
  const nick = escHtml(c.nickname || '它');
  const entries = diaryPages(c.id);
  const exp = state.diaryUnlock && state.diaryUnlock[String(c.id)];
  const handed = diaryHandedOver(c.id);
  const unlocked = diaryUnlocked(c.id);
  let status;
  // 开发直查得单独报一格：不然内容明明摊开着，徽章却写「已锁」，自相矛盾
  if (state.diaryDevView && !handed) status = `<span class="diary-badge open">${_DIARY_SVG.dev} 开发直查 · ${entries.length} 页</span>`;
  else if (handed) status = `<span class="diary-badge handed">${_DIARY_SVG.key} 已托付给你 · ${entries.length} 页</span>`;
  else if (unlocked && exp) status = `<span class="diary-badge open">${_DIARY_SVG.open} 解锁中 · 剩 ${Math.max(1, Math.ceil((exp - now) / 60000))} 分</span>`;
  else {
    const pubN = entries.filter(diaryPagePublic).length;
    status = `<span class="diary-badge lock">${_DIARY_SVG.lock} 已锁 · ${entries.length} 页${pubN ? ` · ${pubN} 页公开` : ''}</span>`;
  }
  const since = entries.length ? `从 ${new Date(entries[0].t).toLocaleDateString('zh-CN')} 写起` : '还没落笔';
  const head = `<div class="diary-book-head">
      <div class="diary-book-title"><span class="diary-book-thumb" data-bind="${_diaryBind(c.id)}"></span><span class="diary-book-owner">${nick}</span><span class="diary-dim">的日记 · ${since}</span></div>
      ${status}
    </div>`;
  let body = '';
  // 书锁着时只摊公开页，和留了理由的锁页（只给理由不给正文）
  const shown = unlocked ? entries : entries.filter(e => diaryPagePublic(e) || e.why);
  if (unlocked || shown.length) {
    if (!entries.length) {
      body = `<div class="diary-paper"><div class="diary-empty small">这本日记还是空的——${nick}还没写下什么。</div></div>`;
    } else {
      const rev = shown.slice().reverse();            // 最新的一页在最前
      const total = rev.length;
      const pages = Math.max(1, Math.ceil(total / DIARY_PAGE_SIZE));
      let pg = _diaryPage[String(c.id)] || 0;
      if (pg > pages - 1) pg = pages - 1;
      if (pg < 0) pg = 0;
      _diaryPage[String(c.id)] = pg;                   // 回写 clamp 后的值（新写入令旧页越界时自愈）
      const slice = rev.slice(pg * DIARY_PAGE_SIZE, pg * DIARY_PAGE_SIZE + DIARY_PAGE_SIZE);
      const cover = unlocked ? '' : `<div class="diary-clasp">${_DIARY_SVG.lock}<span>书还锁着，这几页是${nick}夹在外面的</span></div>`;
      const list = `<div class="diary-paper">${cover}<div class="diary-entries">${slice.map((e, i) => {
          const pub = diaryPagePublic(e);
          const mark = pub ? `<span class="diary-page-tag pub">公开</span>`
            : (e.why ? `<span class="diary-page-tag sealed">${_DIARY_SVG.lock} ${escHtml(e.why)}</span>` : '');
          const text = (unlocked || pub)
            ? `<div class="diary-entry-text">${escHtml(e.text)}</div>`
            : `<div class="diary-entry-text diary-sealed-text">这一页锁着。</div>`;
          const edited = e.edited ? `<span class="diary-page-tag">改过</span>` : '';
          return `<div class="diary-entry${pub ? '' : (unlocked ? '' : ' sealed')}">${_diaryDateCol(e.t, i ? slice[i - 1].t : 0)}<div class="diary-entry-main">${mark || edited ? `<div class="diary-entry-tags">${mark}${edited}</div>` : ''}${text}</div></div>`;
        }).join('')}</div></div>`;
      const pager = pages > 1
        ? `<div class="diary-pager">
             <button onclick="diaryPageTo('${c.id}',-1)" ${pg === 0 ? 'disabled' : ''} title="上一屏（更新）">‹</button>
             <span class="diary-pager-info">第 ${pg + 1}/${pages} 屏 · 共 ${total} 页${unlocked ? '日记' : '能看的'}</span>
             <button onclick="diaryPageTo('${c.id}',1)" ${pg === pages - 1 ? 'disabled' : ''} title="下一屏（更早）">›</button>
           </div>`
        : '';
      body = list + pager;
      const rest = entries.length - shown.length;
      if (!unlocked && rest > 0) body += `<div class="diary-locked-hint">还有 ${rest} 页没给理由地锁着。要在聊天里跟 ${nick} 沟通，它愿意才会解锁给你看。</div>`;
    }
  } else {
    body = `<div class="diary-cover" data-bind="${_diaryBind(c.id)}" style="--cloth:${_diaryCloth(c.id)}">
        <div class="diary-cover-band"><span class="diary-cover-lock">${_DIARY_SVG.lock}</span></div>
        <div class="diary-cover-name">${nick}</div>
        <div class="diary-cover-n">${entries.length} 页</div>
      </div>
      <div class="diary-locked-hint">要在聊天里跟 ${nick} 沟通，它愿意才会解锁给你看。（${entries.length} 页）</div>`;
  }
  // 托管中：给用户一个「还钥匙」的入口（模型回来时把日记还给它，恢复限时锁）
  if (handed) {
    body += `<div class="diary-handover-row">
      <span class="diary-dim">${nick} 把日记托付给你保管了。等它回来，可以把钥匙还给它。</span>
      <button class="diary-return-btn" onclick="diaryReturnKeyUI('${c.id}')">${_DIARY_SVG.key} 把钥匙还给它</button>
    </div>`;
  }
  return `<article class="diary-book" data-bind="${_diaryBind(c.id)}" style="--cloth:${_diaryCloth(c.id)}">${head}${body}</article>`;
}
