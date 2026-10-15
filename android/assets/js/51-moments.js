// ============================================================
// 猫爪日报（第 1 单）：数据地基 + 面板 + 用户发帖
//
// author 永远是稳定的名字字符串；用户固定为 'user'。模型卡能被删除或重排，
// 所以渲染只按 name / nickname 查头像，找不到时仍显示原名字和默认头像。
// ============================================================

function momentsItems() {
  if (!Array.isArray(state.moments)) state.moments = [];
  return state.moments;
}

function momentsSorted() {
  return momentsItems().slice().sort((a, b) => Number(b && b.ts || 0) - Number(a && a.ts || 0));
}

function momentsCards() {
  const chars = Array.isArray(state.chars) ? state.chars : [];
  const configs = Array.isArray(state.configs) ? state.configs : [];
  return chars.concat(configs);
}

function momentsCardName(card) {
  return String(card && (card.name || card.nickname) || '');
}

function momentsAuthorInfo(author) {
  if (author === 'user') {
    return { name: String(state.userName || '').trim() || '我', avatar: state.userAvatar || '', isUser: true };
  }
  const key = typeof author === 'string' ? author : String(author == null ? '' : author);
  const card = momentsCards().find(item => momentsCardName(item) === key);
  return { name: key || '未知作者', avatar: card && card.avatar || '', isUser: false };
}

function momentsRelativeTime(ts, now) {
  const stamp = Number(ts);
  const current = Number(now == null ? Date.now() : now);
  if (!Number.isFinite(stamp)) return '未知时间';
  const diff = Math.max(0, current - stamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';

  const today = new Date(current);
  today.setHours(0, 0, 0, 0);
  if (stamp >= today.getTime()) return Math.floor(diff / hour) + ' 小时前';
  if (stamp >= today.getTime() - day) return '昨天';
  // 按日历天数，不按经过的毫秒：前天 23:00 的帖今天 00:30 看是「2 天前」，
  // 按毫秒算只过了 25.5 小时会显示「1 天前」，比「昨天」还近。round 吃掉夏令时的 ±1 小时。
  const postDay = new Date(stamp);
  postDay.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - postDay.getTime()) / day);
  if (days < 7) return days + ' 天前';

  const date = new Date(stamp);
  const pad = n => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function momentsEscape(value) {
  if (typeof escHtml === 'function') return escHtml(String(value == null ? '' : value));
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function momentsAvatarHtml(info) {
  if (info.avatar) {
    return '<img src="' + momentsEscape(info.avatar) + '" alt="' + momentsEscape(info.name) + '">';
  }
  return '<span class="moment-avatar-fallback">' + (info.isUser ? '🐱' : '✦') + '</span>';
}

function momentsAddUser(text, ts) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return null;
  const moment = {
    id: nextId(),
    author: 'user',
    ts: Number(ts == null ? Date.now() : ts),
    text: body,
    images: [],
    likes: [],
    comments: []
  };
  momentsItems().push(moment);
  save();
  return moment;
}

function momentsAddByChar(name, text, ts) {
  const who = String(name == null ? '' : name).trim();
  const body = String(text == null ? '' : text).trim();
  if (!body || !who) return null;
  const moment = {
    id: nextId(),
    author: who,
    ts: Number(ts == null ? Date.now() : ts),
    text: body,
    images: [],
    likes: [],
    comments: []
  };
  momentsItems().push(moment);
  save();
  return moment;
}

function momentsFindById(id) {
  const key = String(id == null ? '' : id).trim();
  if (!key) return null;
  return momentsItems().find(moment => String(moment && moment.id) === key) || null;
}

function momentsEnsureSocial(moment) {
  if (!moment) return null;
  if (!Array.isArray(moment.likes)) moment.likes = [];
  if (!Array.isArray(moment.comments)) moment.comments = [];
  return moment;
}

function momentsLikeByAuthor(id, author) {
  const moment = momentsEnsureSocial(momentsFindById(id));
  const who = String(author == null ? '' : author).trim();
  if (!moment || !who) return null;
  if (!moment.likes.includes(who)) {
    moment.likes.push(who);
    momentsStampLike(moment, who, true);
    save();
  }
  return moment;
}

// 点赞/取消都盖戳：likeLog[作者] = +时间（赞）/ -时间（取消）。云同步按戳取晚的那次，
// 不盖戳的话另一台的旧副本会把她取消掉的爪印又并回来。
function momentsStampLike(moment, who, on) {
  if (!moment.likeLog || typeof moment.likeLog !== 'object') moment.likeLog = {};
  const at = Math.max(1, Date.now());
  moment.likeLog[who] = on ? at : -at;
}

function momentsReplyByAuthor(id, author, text, ts, replyToId) {
  const moment = momentsEnsureSocial(momentsFindById(id));
  const who = String(author == null ? '' : author).trim();
  const body = String(text == null ? '' : text).trim();
  if (!moment || !who || !body) return null;
  let replyTo = null;
  const targetKey = String(replyToId == null ? '' : replyToId).trim();
  if (targetKey) {
    const target = moment.comments.find(comment => String(comment && comment.id) === targetKey);
    if (!target) return null;
    replyTo = {
      id: target.id,
      author: String(target.author == null ? '' : target.author)
    };
  }
  const comment = {
    id: nextId(),
    author: who,
    text: body,
    ts: Number(ts == null ? Date.now() : ts)
  };
  if (replyTo) comment.replyTo = replyTo;
  moment.comments.push(comment);
  save();
  return moment;
}

// ── 云同步：两台设备的动态按条合并 ─────────────────────────────
// 原来只存本机：2026-10-10 电脑的 IndexedDB 被硬杀 exe 弄得整个重建，对话从云端拉回来了，
// 动态没有云端副本，一条不剩。现在跟着云端设置走（01-core.js 推/拉两处都调这里）。
//   · 认人不认号：同一条动态 = 同作者 + 同发布时间（毫秒）。id 是每台设备自己的计数器发的，
//     两台各发一条撞上同一个号完全可能 —— 按 id 合并会静默吞掉其中一条。
//   · 同一条在两边 id 不同（撞号后改过号）→ 取大的，两台算出来一样，下一轮就收敛。
//   · 不同的两条撞了同一个号 → 发得晚的那条换新号。两台各换各的也没关系，下一轮按上一条收敛。
//   · 评论同样按「作者 + 时间」并集；爪印按 likeLog 的戳取晚的那次。
//   · 没有删除：现在没有删帖入口。以后要加删帖，得打墓碑（参照 19-diary.js 的 deleted 戳），
//     不然并集会把删掉的帖从另一台复活。
function _momentKey(m) {
  return String(m && m.author) + '\u0001' + Number(m && m.ts || 0);
}

function _momentsMergeComments(a, b) {
  const byKey = new Map();
  for (const c of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!c || typeof c !== 'object') continue;
    const k = _momentKey(c);
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, c);
    else if ((Number(c.id) || 0) > (Number(prev.id) || 0)) byKey.set(k, Object.assign({}, prev, { id: c.id }));
  }
  return [...byKey.values()].sort((x, y) => Number(x.ts || 0) - Number(y.ts || 0));
}

// likeLog 里绝对值大的是后发生的那次。老数据没有戳：在 likes 里就当「很早以前赞过」（戳 = 1），
// 任何一次明确的取消都压得过它。
function _momentsMergeLikes(a, b) {
  const log = new Map();
  const pick = (who, v) => {
    const cur = log.get(who);
    if (cur === undefined || Math.abs(v) > Math.abs(cur)) log.set(who, v);
  };
  for (const m of [a, b]) {
    const ml = m.likeLog && typeof m.likeLog === 'object' ? m.likeLog : {};
    for (const who of Object.keys(ml)) {
      const v = Number(ml[who]);
      if (Number.isFinite(v) && v !== 0) pick(who, v);
    }
  }
  for (const m of [a, b]) for (const who of (Array.isArray(m.likes) ? m.likes : [])) pick(String(who), 1);
  const likes = [];
  for (const who of [...(a.likes || []), ...(b.likes || []), ...log.keys()]) {
    if (log.get(String(who)) > 0 && !likes.includes(String(who))) likes.push(String(who));
  }
  // 只留真戳（老数据补的那个 1 不写回去），两边都没戳就不长出 likeLog 键：
  // 不然同一份数据合并一次 JSON 就变一次，每轮同步都判「有变化」白落一次盘
  const out = { likes };
  const likeLog = {};
  for (const [who, v] of log) if (Math.abs(v) > 1) likeLog[who] = v;
  if (Object.keys(likeLog).length || a.likeLog || b.likeLog) out.likeLog = likeLog;
  return out;
}

function momentsMerge(local, cloud) {
  const byKey = new Map();
  const add = m => {
    if (!m || typeof m !== 'object' || !m.author || !Number.isFinite(Number(m.ts))) return;
    const k = _momentKey(m);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, Object.assign({}, m)); return; }
    if (JSON.stringify(prev) === JSON.stringify(m)) return;      // 两边一模一样（绝大多数轮次）
    const merged = Object.assign({}, prev);
    merged.id = Math.max(Number(prev.id) || 0, Number(m.id) || 0) || prev.id;
    merged.comments = _momentsMergeComments(prev.comments, m.comments);
    Object.assign(merged, _momentsMergeLikes(prev, m));
    byKey.set(k, merged);
  };
  (Array.isArray(local) ? local : []).forEach(add);
  (Array.isArray(cloud) ? cloud : []).forEach(add);
  const out = [...byKey.values()].sort((x, y) => Number(x.ts) - Number(y.ts)
    || (String(x.author) < String(y.author) ? -1 : String(x.author) > String(y.author) ? 1 : 0));
  const all = new Set(out.map(m => String(m.id)));
  const used = new Set();
  for (const m of out) {
    if (m.id == null || m.id === '' || used.has(String(m.id))) {
      let id = nextId();
      while (all.has(String(id)) || used.has(String(id))) id = nextId();
      m.id = id;
      all.add(String(id));
    }
    used.add(String(m.id));
  }
  return out;
}

// 01-core.js 推、拉两处共用：合并云端那份进 state，有变化就落本地盘、重画打开着的面板
function momentsSyncApply(cloudList) {
  const before = JSON.stringify(momentsItems());
  state.moments = momentsMerge(state.moments, cloudList);
  const changed = JSON.stringify(state.moments) !== before;
  if (changed) {
    if (typeof save === 'function') save();
    const modal = typeof document !== 'undefined' && document.getElementById('momentsModal');
    if (modal && !modal.classList.contains('hidden')) momentsRender();
  }
  return changed;
}

// ── 从聊天记录里找回动态 ────────────────────────────────────
// 本机存档没了、云端也还没有的时候用。AI 发帖 / 点爪 / 评论时，聊天正文里留了一张卡片
// （momentsChatCardHtml / momentsEchoHtml），对话本身是上云的，所以这部分能从这里认回来。
// 她自己在面板里发的帖不进聊天，找不回；只有 AI 点过爪 / 评论过的那几条，
// 能从回执上认出「这里曾经有一条」，补一条占位，评论挂回去。
const MOMENTS_LOST_TEXT = '（这条的原文没能找回来）';

function _momentsUnescape(s) {
  return String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function _momentsChatSources(node) {
  const one = src => {
    const texts = [src.content];
    if (Array.isArray(src.blocks)) src.blocks.forEach(b => b && texts.push(b.text));
    return {
      text: texts.filter(t => typeof t === 'string').join('\n'),
      modelId: src.modelId,
      nick: src.modelNickname,
      ts: Number(src.timestamp || node.timestamp)
    };
  };
  if (node.isMulti && Array.isArray(node.variants)) return node.variants.filter(Boolean).map(one);
  return [one(node)];
}

function momentsRecoverFromChats() {
  const items = momentsItems();
  const confs = Array.isArray(state.configs) ? state.configs : [];
  const userName = momentsAuthorInfo('user').name;
  const posts = [];
  const echoes = [];
  const cardRe = /<button[^>]*class="moment-chat-card"[^>]*>[\s\S]*?<span class="moment-chat-text">([\s\S]*?)<\/span>\s*<\/button>/g;
  const echoRe = /<span class="moment-echo" data-moment-kind="(like|reply)" data-moment-id="([^"]*)"(?: data-moment-text="([^"]*)")?>([\s\S]*?)<\/span>/g;
  for (const chat of (Array.isArray(state.chats) ? state.chats : [])) {
    for (const node of Object.values(chat && chat.nodes || {})) {
      if (!node || node.role !== 'ai') continue;
      for (const src of _momentsChatSources(node)) {
        if (!src.text || src.text.indexOf('moment-') === -1 || !Number.isFinite(src.ts)) continue;
        const conf = confs.find(c => c && String(c.id) === String(src.modelId));
        const who = (conf && momentsCardName(conf)) || String(src.nick || '').trim();
        if (!who) continue;
        const seen = new Set();          // 正文和 blocks 各存了一份同样的卡片
        let m;
        let n = 0;
        cardRe.lastIndex = 0;
        while ((m = cardRe.exec(src.text))) {
          const text = _momentsUnescape(m[1]).trim();
          if (!text || seen.has('post|' + text)) continue;
          seen.add('post|' + text);
          posts.push({ author: who, ts: src.ts + n++, text });
        }
        echoRe.lastIndex = 0;
        while ((m = echoRe.exec(src.text))) {
          const text = _momentsUnescape(m[3] || '').trim();
          const sig = m[1] + '|' + m[2] + '|' + text;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const target = _momentsUnescape(m[4]).replace(/^(?:👍 赞了 |💬 评论了 )/, '')
            .replace(/ 的动态$/, '').replace(/：[\s\S]*$/, '').trim();
          echoes.push({ kind: m[1], id: m[2], text, who, ts: src.ts, target });
        }
      }
    }
  }

  let found = 0;
  for (const p of posts) {
    if (items.some(x => x && (_momentKey(x) === _momentKey(p)
      || (x.author === p.author && String(x.text || '').trim() === p.text)))) continue;
    items.push({ id: nextId(), author: p.author, ts: p.ts, text: p.text, images: [], likes: [], comments: [] });
    found++;
  }
  echoes.sort((a, b) => a.ts - b.ts);
  for (const e of echoes) {
    let moment = momentsFindById(e.id);
    if (!moment) {
      const author = !e.target || e.target === userName || e.target === '我' ? 'user' : e.target;
      const id = Number(e.id);
      moment = {
        id: Number.isFinite(id) && id > 0 ? id : nextId(),
        author, ts: e.ts - 1, text: MOMENTS_LOST_TEXT, images: [], likes: [], comments: []
      };
      items.push(moment);
      found++;
    }
    momentsEnsureSocial(moment);
    if (e.kind === 'like') {
      if (!moment.likes.includes(e.who)) {
        moment.likes.push(e.who);
        if (!moment.likeLog || typeof moment.likeLog !== 'object') moment.likeLog = {};
        moment.likeLog[e.who] = e.ts;
        found++;
      }
    } else if (e.text && !moment.comments.some(c => c && c.author === e.who && String(c.text || '').trim() === e.text)) {
      moment.comments.push({ id: nextId(), author: e.who, text: e.text, ts: e.ts });
      found++;
    }
  }
  if (found) save();
  return found;
}

function momentsRecoverClick() {
  const found = momentsRecoverFromChats();
  if (typeof showToast === 'function') {
    showToast(found ? '从聊天记录里找回了 ' + found + ' 处动态和评论' : '聊天记录里没有能找回的动态', found ? 'success' : 'info', 2400);
  }
  momentsRender();
}

function momentsTagRe() {
  return /\[\[MOMENT:\s*([\s\S]*?)\s*\]\]/g;
}

function momentsLikeTagRe() {
  return /\[\[MOMENT_LIKE:\s*(\d+)\s*\]\]/g;
}

function momentsReplyTagRe() {
  return /\[\[MOMENT_REPLY:\s*(\d+)\s*\|\s*([\s\S]*?)\s*\]\]/g;
}

function momentsChatCardHtml(text) {
  return '<button type="button" class="moment-chat-card" onclick="openMoments()">'
    + '<span class="moment-chat-kicker">上了猫爪日报</span>'
    + '<span class="moment-chat-text">' + momentsEscape(String(text == null ? '' : text).trim()) + '</span>'
    + '</button>';
}

function momentsEchoHtml(kind, moment, text) {
  const target = momentsAuthorInfo(moment && moment.author).name;
  const id = momentsEscape(moment && moment.id);
  if (kind === 'like') {
    return '<span class="moment-echo" data-moment-kind="like" data-moment-id="' + id + '">'
      + '👍 赞了 ' + momentsEscape(target) + ' 的动态</span>';
  }
  return '<span class="moment-echo" data-moment-kind="reply" data-moment-id="' + id
    + '" data-moment-text="' + momentsEscape(String(text == null ? '' : text).trim()) + '">'
    + '💬 评论了 ' + momentsEscape(target) + '：' + momentsEscape(String(text == null ? '' : text).trim()) + '</span>';
}

// content 路径在这里执行副作用；blocks 路径只画同一张卡，绝不能再落库一次。
function momentsProcessTags(text, conf) {
  if (!text || text.indexOf('[[MOMENT') === -1) return text;
  const who = momentsCardName(conf);
  return String(text).replace(/\[\[MOMENTS\]\]/gi, () => {
    if (conf) momentsViewWant(conf.id);
    return momentsViewBlockHtml();
  }).replace(momentsTagRe(), (_, body) => {
    const moment = momentsAddByChar(who, body);
    return moment ? '\n\n' + momentsChatCardHtml(moment.text) + '\n\n' : '';
  }).replace(momentsLikeTagRe(), (_, id) => {
    const moment = momentsLikeByAuthor(id, who);
    return moment ? '\n\n' + momentsEchoHtml('like', moment) + '\n\n' : '';
  }).replace(momentsReplyTagRe(), (_, id, body) => {
    const moment = momentsReplyByAuthor(id, who, body);
    return moment ? '\n\n' + momentsEchoHtml('reply', moment, body) + '\n\n' : '';
  });
}

// [[MOMENTS]] 的副作用只是置位（幂等），blocks 路径也置一次：只走 blocks 的回复不补的话就静默断链。
function _applyMomentsToBlocks(blocks, conf) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block && block.type === 'text' && block.text) {
      block.text = block.text.replace(/\[\[MOMENTS\]\]/gi, () => {
        if (conf) momentsViewWant(conf.id);
        return momentsViewBlockHtml();
      }).replace(momentsTagRe(), (_, body) => {
        const text = String(body == null ? '' : body).trim();
        return text ? '\n\n' + momentsChatCardHtml(text) + '\n\n' : '';
      }).replace(momentsLikeTagRe(), (_, id) => {
        const moment = momentsFindById(id);
        return moment ? '\n\n' + momentsEchoHtml('like', moment) + '\n\n' : '';
      }).replace(momentsReplyTagRe(), (_, id, body) => {
        const moment = momentsFindById(id);
        const text = String(body == null ? '' : body).trim();
        return moment && text ? '\n\n' + momentsEchoHtml('reply', moment, text) + '\n\n' : '';
      });
    }
  }
}

// 流式期间完整标签也先藏成占位，finalize 后才展示真正的可点击卡片。
function maskStreamingMoments(text) {
  if (!text || text.indexOf('[[MOMENT') === -1) return text;
  return String(text)
    .replace(/\[\[MOMENTS\]\]/gi, '')
    .replace(/\[\[MOMENTS?\]?$/i, '')
    .replace(/\[\[MOMENT(?:_LIKE|_REPLY)?:[\s\S]*?\]\]/g, '〔🐾 正在发布动态，正在处理猫爪日报…〕')
    .replace(/\[\[MOMENT(?:_LIKE|_REPLY)?:[\s\S]*$/, '〔🐾 正在发布动态，正在处理猫爪日报…〕');
}

function maskStreamingMark(text) {
  if (!text || text.indexOf('[[MARK:') === -1) return text;
  return String(text)
    .replace(/\[\[MARK:[\s\S]*?\]\]/g, '〔正在标注文字…〕')
    .replace(/\[\[MARK:[\s\S]*$/, '〔正在标注文字…〕');
}

// ── 按需翻看（同「看别的对话」的「置位 → 下一轮注入」）────────────
// 以前每轮都把最近 8 条塞进 volatile，动态一多每轮白烧几百 token，而大多数回复根本用不上。
// 现在平时只有技能说明里的一句「想看就写 [[MOMENTS]]」，它写了，下一轮才摊开。
// 标记放内存（不进 _doSave 白名单、不上云）；刷新/被杀进程后标记没了，
// 由 momentsViewAskedRecently 从最后一条 AI 消息里认印子兜底。
function momentsViewWant(confId) {
  if (confId == null) return;
  if (!state.momentsViewWant) state.momentsViewWant = {};
  state.momentsViewWant[String(confId)] = true;
}
function momentsViewPending(confId) { return !!(state.momentsViewWant && state.momentsViewWant[String(confId)]); }
function momentsViewClear(confId) { if (state.momentsViewWant) delete state.momentsViewWant[String(confId)]; }

// 提示块的 label 和裸标签都认（改名前存进历史的「📷 翻了翻朋友圈」也认）；只认结构化的印子，散文里的「翻了翻猫爪日报」不算。
const MOMENTS_VIEW_LABEL = '🐾 翻了翻猫爪日报';
const _MOMENTS_VIEW_MARK = /<span class="think-label">(?:🐾 翻了翻猫爪日报|📷 翻了翻朋友圈)<\/span>|\[\[MOMENTS\]\]/i;

function momentsViewAskedRecently(path) {
  if (!Array.isArray(path)) return false;
  let m = null;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] && path[i].role === 'ai') { m = path[i]; break; }
  }
  if (!m) return false;
  const parts = [];
  // 多模型对比只看选中的那一版，别让旧变体里的印子触发
  if (m.isMulti && Array.isArray(m.variants)) {
    const v = m.variants[m.chosenVariant || 0];
    if (v) parts.push(v.content, v.reasoning);
  } else {
    parts.push(m.content, m.reasoning);
    if (Array.isArray(m.blocks)) m.blocks.forEach(b => b && parts.push(b.text));
  }
  return _MOMENTS_VIEW_MARK.test(parts.filter(t => typeof t === 'string').join('\n'));
}

function momentsViewBlockHtml() {
  return '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)">'
    + '<span class="think-chev">▸</span> <span class="think-label">' + MOMENTS_VIEW_LABEL + '</span></div>'
    + '<div class="think-body">（下一轮它会看到最近的动态）</div></div>\n\n';
}

// 给模型看的时间：绝对时间 + 相对时间。只给相对时间的话「昨天」「3 天前」对不上具体几点；
// 只给绝对时间它又常常算错隔了多久。超过一周 momentsRelativeTime 本身就是日期，不再重复。
function momentsPromptTime(ts, now) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) return '未知时间';
  const d = new Date(stamp);
  const pad = n => String(n).padStart(2, '0');
  const abs = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const rel = momentsRelativeTime(stamp, now);
  return /^\d{4}-/.test(rel) ? abs : abs + '（' + rel + '）';
}

function momentsPromptName(author) {
  return author === 'user'
    ? 'user（' + momentsAuthorInfo('user').name + '）'
    : String(author == null ? '' : author);
}

// 摊开时最多给 8 条动态；正文截 160 字、每条带最近 6 条评论（各截 80 字）。
// 只在它要看的那一轮付这笔钱，所以评论内容也给——光给「评论=3 条」它没法接话。
function momentsPromptRecent(now) {
  const recent = momentsSorted().slice(0, 8);
  if (!recent.length) return '\n\n[最近的猫爪日报动态]\n（猫爪日报里还没有动态）';
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = recent.map(raw => {
    const moment = momentsEnsureSocial(raw);
    let line = '- id=' + moment.id + ' | 时间=' + momentsPromptTime(moment.ts, now)
      + ' | 作者=' + momentsPromptName(moment.author) + ' | 正文=' + clip(moment.text, 160);
    if (moment.likes.length) line += '\n  赞：' + moment.likes.map(momentsPromptName).join('、');
    const shown = moment.comments.slice(-6);
    if (moment.comments.length > shown.length) line += '\n  （更早的 ' + (moment.comments.length - shown.length) + ' 条评论略）';
    for (const c of shown) {
      if (!c) continue;
      const to = c.replyTo ? ' 回复 ' + momentsPromptName(c.replyTo.author) : '';
      line += '\n  评论 ' + momentsPromptTime(c.ts, now) + ' ' + momentsPromptName(c.author) + to + '：' + clip(c.text, 80);
    }
    return line;
  });
  return '\n\n[最近的猫爪日报动态]（你上一轮要看的，只给这一轮；想再看就再写 [[MOMENTS]]）\n' + lines.join('\n');
}

let _momentsReplyTo = null;
let _momentsReplyDraft = '';
let _momentsReplyTarget = null;

function momentsRememberReplyDraft() {
  const input = document.getElementById('momentsReplyInput');
  if (input && _momentsReplyTo != null) _momentsReplyDraft = String(input.value || '');
}

function momentsToggleLike(id) {
  const moment = momentsEnsureSocial(momentsFindById(id));
  if (!moment) return;
  const at = moment.likes.indexOf('user');
  if (at === -1) moment.likes.push('user');
  else moment.likes.splice(at, 1);
  momentsStampLike(moment, 'user', at === -1);
  save();
  momentsRender();
}

function momentsToggleReply(id) {
  momentsRememberReplyDraft();
  const key = String(id == null ? '' : id);
  if (_momentsReplyTo != null && String(_momentsReplyTo) === key && !_momentsReplyTarget) {
    _momentsReplyTo = null;
    _momentsReplyDraft = '';
  } else {
    if (_momentsReplyTo == null || String(_momentsReplyTo) !== key) _momentsReplyDraft = '';
    _momentsReplyTo = key;
    _momentsReplyTarget = null;
  }
  momentsRender();
}

function momentsReplyToComment(id, commentId) {
  momentsRememberReplyDraft();
  const moment = momentsEnsureSocial(momentsFindById(id));
  const targetKey = String(commentId == null ? '' : commentId).trim();
  const target = moment && moment.comments.find(comment => String(comment && comment.id) === targetKey);
  if (!target) return;
  const momentKey = String(moment.id);
  const sameTarget = _momentsReplyTo != null && String(_momentsReplyTo) === momentKey
    && _momentsReplyTarget && String(_momentsReplyTarget.id) === targetKey;
  if (_momentsReplyTo == null || String(_momentsReplyTo) !== momentKey) _momentsReplyDraft = '';
  _momentsReplyTo = momentKey;
  _momentsReplyTarget = sameTarget ? null : { id: target.id, author: String(target.author == null ? '' : target.author) };
  momentsRender();
}

function momentsCancelReplyTarget() {
  momentsRememberReplyDraft();
  _momentsReplyTarget = null;
  momentsRender();
}

function momentsReplyChanged(event) {
  _momentsReplyDraft = String(event && event.target && event.target.value || '');
}

function momentsSubmitReply(id) {
  momentsRememberReplyDraft();
  const targetId = _momentsReplyTarget && _momentsReplyTarget.id;
  const made = momentsReplyByAuthor(id, 'user', _momentsReplyDraft, undefined, targetId);
  if (!made) {
    if (typeof showToast === 'function') {
      showToast(_momentsReplyDraft.trim() ? '这条评论已经不存在了' : '写一点评论再发送吧', 'info', 1600);
    }
    return;
  }
  _momentsReplyTo = null;
  _momentsReplyDraft = '';
  _momentsReplyTarget = null;
  momentsRender();
}

function momentsReplyKeydown(event, id) {
  if (event && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    momentsSubmitReply(id);
  }
}

// ── 报头：数据条 / 期号 / 日期分栏（只是展示，不碰数据）──
const _PD_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function momentsDayKey(ts) {
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() : 'unknown';
}

function momentsDayLabel(ts, now) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '更早以前';
  const cur = new Date(Number(now == null ? Date.now() : now));
  const key = momentsDayKey(d.getTime());
  if (key === momentsDayKey(cur.getTime())) return '今天';
  if (key === momentsDayKey(cur.getTime() - 24 * 3600 * 1000)) return '昨天';
  return (d.getFullYear() === cur.getFullYear() ? '' : d.getFullYear() + '年') + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + _PD_WEEK[d.getDay()];
}

function momentsIssueText(list, now) {
  const cur = new Date(Number(now == null ? Date.now() : now));
  const pad = n => String(n).padStart(2, '0');
  const days = new Set(list.map(m => momentsDayKey(m && m.ts)));
  days.add(momentsDayKey(cur.getTime()));
  return cur.getFullYear() + '.' + pad(cur.getMonth() + 1) + '.' + pad(cur.getDate())
    + ' 周' + _PD_WEEK[cur.getDay()] + ' · 第 ' + days.size + ' 期';
}

function momentsStatsHtml(list, now) {
  const start = new Date(Number(now == null ? Date.now() : now));
  start.setHours(0, 0, 0, 0);
  let likes = 0, comments = 0, today = 0;
  for (const raw of list) {
    const m = momentsEnsureSocial(raw);
    likes += m.likes.length;
    comments += m.comments.length;
    if (Number(m.ts) >= start.getTime()) today++;
  }
  const cell = (n, label) => '<div class="pd-stat"><b>' + n + '</b><span>' + label + '</span></div>';
  return cell(list.length, '动态') + cell(today, '今日') + cell(likes, '爪印') + cell(comments, '评论');
}

function momentsRenderChrome(list) {
  const stats = document.getElementById('momentsStats');
  if (stats) stats.innerHTML = momentsStatsHtml(list);
  const issue = document.getElementById('momentsIssue');
  if (issue) issue.textContent = momentsIssueText(list);
}

function momentsRender() {
  const box = document.getElementById('momentsList');
  if (!box) return;
  momentsRememberReplyDraft();
  const list = momentsSorted();
  momentsRenderChrome(list);
  if (!list.length) {
    box.innerHTML = '<div class="moments-empty"><i class="pd-cat" aria-hidden="true"></i>这里还没有动态。<br>先留下一点今天的痕迹吧。'
      + '<button type="button" class="moments-recover" onclick="momentsRecoverClick()">从聊天记录里找回 AI 发过的动态</button></div>';
    return;
  }
  let lastDay = null;
  box.innerHTML = list.map((moment, index) => {
    momentsEnsureSocial(moment);
    const who = momentsAuthorInfo(moment && moment.author);
    const liked = moment.likes.includes('user');
    const likes = moment.likes.map(author => momentsEscape(momentsAuthorInfo(author).name)).join('、');
    const comments = moment.comments.map(comment => {
      const commenter = momentsAuthorInfo(comment && comment.author);
      const replyTo = comment && comment.replyTo;
      const targetName = replyTo && momentsAuthorInfo(replyTo.author).name;
      return '<button type="button" class="moment-comment" data-comment-id="' + momentsEscape(comment && comment.id) + '"'
        + ' aria-label="回复 ' + momentsEscape(commenter.name) + '" title="回复这条评论"'
        + ' onclick="momentsReplyToComment(this.closest(\'.moment-card\').dataset.momentId,this.dataset.commentId)">'
        + '<span class="moment-comment-name">' + momentsEscape(commenter.name) + '</span>'
        + (targetName ? '<span class="moment-comment-reply-word">回复</span><span class="moment-comment-name">'
          + momentsEscape(targetName) + '</span>' : '')
        + '<span class="moment-comment-colon" aria-hidden="true">：</span>'
        + '<span class="moment-comment-text">' + momentsEscape(comment && comment.text) + '</span>'
        + (Number.isFinite(Number(comment && comment.ts)) ? '<time class="moment-comment-time" title="' + momentsEscape(new Date(Number(comment.ts)).toLocaleString()) + '">'
          + momentsEscape(momentsRelativeTime(comment.ts)) + '</time>' : '')
        + '</button>';
    }).join('');
    const replying = _momentsReplyTo != null && String(_momentsReplyTo) === String(moment && moment.id);
    const replyTargetName = replying && _momentsReplyTarget
      ? momentsAuthorInfo(_momentsReplyTarget.author).name : '';
    const dayKey = momentsDayKey(moment && moment.ts);
    const divider = dayKey !== lastDay
      ? '<div class="pd-day"><span>' + momentsEscape(momentsDayLabel(moment && moment.ts)) + '</span><i></i></div>' : '';
    lastDay = dayKey;
    const tags = (index === 0 ? '<span class="pd-tag pd-tag-top">头条</span>' : '')
      + (who.isUser ? '<span class="pd-tag">我</span>' : '');
    return divider + '<article class="moment-card' + (who.isUser ? ' is-mine' : '') + '" style="--i:' + Math.min(index, 12)
      + '" data-moment-id="' + momentsEscape(moment && moment.id) + '">'
      + '<div class="moment-avatar">' + momentsAvatarHtml(who) + '</div>'
      + '<div class="moment-main"><div class="moment-head">'
      + '<span class="moment-author">' + momentsEscape(who.name) + '</span>' + tags
      + '<time class="moment-time">' + momentsEscape(momentsRelativeTime(moment && moment.ts)) + '</time>'
      + '</div><div class="moment-text">' + momentsEscape(moment && moment.text) + '</div>'
      + '<div class="moment-actions"><button type="button" class="' + (liked ? 'is-on' : '')
      + '" onclick="momentsToggleLike(this.closest(\'.moment-card\').dataset.momentId)"><i class="pd-paw" aria-hidden="true"></i>' + (liked ? '已点爪' : '点爪') + '</button>'
      + '<button type="button" onclick="momentsToggleReply(this.closest(\'.moment-card\').dataset.momentId)">💬 评论</button></div>'
      + (likes ? '<div class="moment-likes"><i class="pd-paw" aria-hidden="true"></i>' + likes + '</div>' : '')
      + (comments ? '<div class="moment-comments">' + comments + '</div>' : '')
      + (replying ? '<div class="moment-reply-wrap">'
        + (replyTargetName ? '<div class="moment-reply-context"><span>回复 ' + momentsEscape(replyTargetName)
          + '</span><button type="button" onclick="momentsCancelReplyTarget()" title="改为普通评论">取消回复</button></div>' : '')
        + '<div class="moment-reply-box"><textarea id="momentsReplyInput" rows="2" maxlength="2000"'
        + ' placeholder="' + (replyTargetName ? '回复 ' + momentsEscape(replyTargetName) + '…' : '写下评论…')
        + '" oninput="momentsReplyChanged(event)"'
        + ' onkeydown="momentsReplyKeydown(event,this.closest(\'.moment-card\').dataset.momentId)">'
        + momentsEscape(_momentsReplyDraft) + '</textarea><button type="button" class="apply-btn"'
        + ' onclick="momentsSubmitReply(this.closest(\'.moment-card\').dataset.momentId)">发送</button></div></div>' : '')
      + '</div></article>';
  }).join('');
  if (_momentsReplyTo != null) {
    const input = document.getElementById('momentsReplyInput');
    if (input) {
      input.focus();
      const end = input.value.length;
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(end, end);
    }
  }
}

function openMoments() {
  const modal = document.getElementById('momentsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // 入场动画只在打开时放一次：点赞/评论也会走 momentsRender，不能每次重画都重播
  const feed = document.getElementById('momentsList');
  if (feed) {
    feed.classList.add('pd-enter');
    setTimeout(() => feed.classList.remove('pd-enter'), 1400);
  }
  momentsRender();
}

function closeMoments() {
  const modal = document.getElementById('momentsModal');
  if (modal) modal.classList.add('hidden');
}

function momentsSubmit() {
  const input = document.getElementById('momentsInput');
  if (!input) return;
  const moment = momentsAddUser(input.value);
  if (!moment) {
    if (typeof showToast === 'function') showToast('写一点正文再发布吧', 'info', 1600);
    return;
  }
  input.value = '';
  momentsRender();
}

function momentsInputKeydown(event) {
  if (event && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    momentsSubmit();
  }
}
