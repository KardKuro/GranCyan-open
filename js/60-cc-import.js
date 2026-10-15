// ═══════════════════════════════════════════════════════
// 导入 claude.ai 的老对话（2026-10-03）
// ═══════════════════════════════════════════════════════
//
// 吃的是 claude.ai 官方导出：设置 → Privacy → Export data，邮件里的 zip，
// 里面那份 conversations.json（直接选 json 也行）。
//
// 官方没有公开格式说明，下面这些是对着社区里几个真实导出的解析器核过的
//（Superkikim/nexus-ai-chat-importer、Rizwan-1211/claude-chat-export、osteele/claude-chat-viewer）：
//   conversations.json = [{ uuid, name, summary?, model?, created_at, updated_at,
//                           current_leaf_message_uuid?, chat_messages: [...] }]
//   message = { uuid, parent_message_uuid?, sender: 'human'|'assistant', text, created_at,
//               content: [{type:'text'|'thinking'|'tool_use'|'tool_result'|'voice_note', ...}],
//               attachments: [{file_name, file_type, file_size, extracted_content}],
//               files: [{file_name, file_uuid?}], files_v2?: [...] }
//
// ⚠️ 几个不显然的地方：
//   · **树结构只在新版导出里有**。parent_message_uuid 新版每条都带（根的父是一个不在
//     本对话里的哨兵 uuid），老版导出没有这个字段 —— 那就只能按数组顺序串成一条直链，
//     重新生成过的旁支会被串进主线里，这一点没法补救，统计里会报出来。
//   · current_leaf_message_uuid（网页上当时停在哪个分支）导出里通常没有。
//     没有就停在**最晚的那条**上：最晚写下的消息必然是叶子，也最像「最后在看的」。
//   · **图片本体不在导出里**。files[] 只有文件名；附件只有 extracted_content（提取出的文字）。
//     文字附件原样保住（进 node.files，接着聊时模型也读得到）；图片在 zip 里找得到就带上，
//     找不到就留一张写明「导出里没有本体」的卡片 —— 宁可明说没了，也不要悄悄少一张图。
//   · 工具调用（搜网页、artifact…）：调用本身折成一行说明，artifact 的正文整段保留成代码块；
//     tool_result（搜出来的网页原文之类）不导，只计数 —— 那是给当时那个模型看的原料，
//     体积大、对她没有阅读价值，带进来还会每轮占上下文。
//
// 去重 / 增量：每个导进来的对话挂 importedFrom.uuid，每个节点挂 ccUuid。
//   同一个 claude.ai 对话再导一次 → 只补这次多出来的消息（她在网页上接着聊过的话），一条不翻倍。
//   导进来又删掉的 → 墓碑上记着 cc（见 02-state.js markChatDeleted），默认不再导回来。
//
// id：一律 nextId()。**不能自己造号**：对话 id / 消息 id 全仓库共用一个计数器，
//   撞号会被 mergeCloudChats 按 id 静默吞掉一整段（2026-07-15 那次对话消失就是这个）。
// 分支：同一父节点下的兄弟按 id 排（switchBranch 里 sort((a,b)=>a.id-b.id)），
//   所以按 created_at 先后发号，兄弟的左右顺序就是网页上的先后顺序。

const CC_SOURCE = 'claude.ai';
// 不支持的块在 message.text 里会被替换成这句英文（content[] 里没有），兜底时要剥掉
const CC_UNSUPPORTED = 'This block is not supported on your current device yet.';
const CC_IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function ccTs(s) {
  const t = typeof s === 'number' ? s : Date.parse(s || '');
  return Number.isFinite(t) ? t : 0;
}

// 代码块围栏：正文里自己带 ``` 的话要用更长的一串，不然 artifact 里的代码会把围栏提前合上
function _ccFence(text) {
  const runs = String(text || '').match(/`{3,}/g) || [];
  const n = runs.reduce((m, r) => Math.max(m, r.length + 1), 3);
  return '`'.repeat(n);
}

function _ccOneLine(s, max) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ── 认文件 ─────────────────────────────────────────────
// 返回对话数组；认不出来就抛一个**说人话**的错，告诉她手里这个是什么、该换哪个。
function ccDetectExport(data) {
  const isConv = x => x && typeof x === 'object' && Array.isArray(x.chat_messages);
  if (Array.isArray(data)) {
    if (!data.length) return [];
    if (data.some(isConv)) return data.filter(isConv);
    if (data.some(x => x && typeof x === 'object' && x.mapping)) {
      throw new Error('这是 ChatGPT 的导出，不是 claude.ai 的');
    }
    // 新版导出先寄来的是一份「下载链接清单」JSON，里面四个链接，对话那个要自己再点下来
    if (JSON.stringify(data).match(/https?:\/\/[^"]+/)) {
      throw new Error('这是一份下载链接清单，不是对话本体。打开它，点里面 conversations 那个链接下载 zip，再选那个 zip');
    }
    throw new Error('认不出这个文件：里面没有 claude.ai 对话（chat_messages）');
  }
  if (data && typeof data === 'object') {
    if (isConv(data)) return [data];
    if (Array.isArray(data.conversations)) return ccDetectExport(data.conversations);
    if (data.mapping) throw new Error('这是 ChatGPT 的导出，不是 claude.ai 的');
    if (JSON.stringify(data).match(/https?:\/\/[^"]+/)) {
      throw new Error('这是一份下载链接清单，不是对话本体。打开它，点里面 conversations 那个链接下载 zip，再选那个 zip');
    }
  }
  throw new Error('认不出这个文件：里面没有 claude.ai 对话（chat_messages）');
}

// ── 单条消息 → 节点内容 ─────────────────────────────────
// 只算内容，不发 id、不接父子。stats 是整次导入共用的计数器（就地累加）。
function _ccToolLine(b, stats) {
  const name = String(b.name || 'tool');
  const inp = (b.input && typeof b.input === 'object') ? b.input : {};
  stats.toolCalls++;
  // 老版 artifact：create / rewrite 带整段正文 —— 这是能保的，整段保
  if (name === 'artifacts') {
    const title = _ccOneLine(inp.title || inp.id || 'artifact', 80);
    const cmd = inp.command || '';
    if ((cmd === 'create' || cmd === 'rewrite') && typeof inp.content === 'string') {
      stats.artifacts++;
      const f = _ccFence(inp.content);
      const lang = (inp.language || (/html/.test(inp.type || '') ? 'html' : /svg/.test(inp.type || '') ? 'svg'
        : /mermaid/.test(inp.type || '') ? 'mermaid' : /markdown/.test(inp.type || '') ? 'markdown' : '')).trim();
      return `📄 **${title}**${cmd === 'rewrite' ? '（重写）' : ''}\n\n${f}${lang}\n${inp.content}\n${f}`;
    }
    if (cmd === 'update') {
      stats.artifacts++;
      const o = String(inp.old_str || ''), n = String(inp.new_str || '');
      const f = _ccFence(o + n);
      return `✏️ 改了 **${title}**\n\n${f}diff\n${o.split('\n').map(l => '- ' + l).join('\n')}\n${n.split('\n').map(l => '+ ' + l).join('\n')}\n${f}`;
    }
    return `> 🔧 artifact：${title}${cmd ? '（' + cmd + '）' : ''}`;
  }
  // 新版文件工具
  if (name === 'create_file' && typeof inp.file_text === 'string') {
    stats.artifacts++;
    const f = _ccFence(inp.file_text);
    const ext = String(inp.path || '').split('.').pop();
    return `📄 **${_ccOneLine(inp.path || '新文件', 120)}**\n\n${f}${/^[a-z0-9]{1,8}$/i.test(ext) ? ext : ''}\n${inp.file_text}\n${f}`;
  }
  if (name === 'str_replace') return `> ✏️ 改了 ${_ccOneLine(inp.path || '文件', 120)}`;
  if (name === 'web_search') return `> 🔎 搜了：${_ccOneLine(inp.query || '', 200)}`;
  if (name === 'web_fetch') return `> 🌐 看了：${_ccOneLine(inp.url || '', 200)}`;
  let arg = '';
  try { arg = _ccOneLine(JSON.stringify(inp), 200); } catch {}
  return `> 🔧 ${_ccOneLine(name, 60)}${arg && arg !== '{}' ? '：' + arg : ''}`;
}

// 返回 { role, content, blocks?, reasoning?, thinkingSummary?, files?, images?, drop }
// drop=true：这条是空的或者只装着工具结果，不建节点，它的孩子挂到它的父亲上。
function ccMessageToNode(msg, ctx, stats) {
  const role = msg.sender === 'human' || msg.sender === 'user' ? 'user' : 'ai';
  const content = Array.isArray(msg.content) ? msg.content : [];
  const segs = [];          // [{type:'text'|'thinking', text}]
  const sums = [];
  const cites = [];
  const pushText = t => {
    t = String(t || '');
    if (!t.trim()) return;
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') last.text += '\n\n' + t;
    else segs.push({ type: 'text', text: t });
  };
  let sawToolResult = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const ty = b.type;
    if (ty === 'text') {
      pushText(String(b.text || '').split(CC_UNSUPPORTED).join('').replace(/\n{3,}/g, '\n\n').trim());
      for (const c of (Array.isArray(b.citations) ? b.citations : [])) {
        const url = c && (c.details?.url || c.url);
        // 只收 http(s)：这串要拼成 markdown 链接，别的 scheme（javascript: 之类）不让它进来
        if (typeof url === 'string' && /^https?:\/\/\S+$/.test(url) && !/[()]/.test(url) && !cites.some(x => x.url === url)) {
          cites.push({ url, title: c.details?.title || c.title || '' });
        }
      }
    } else if (ty === 'thinking' || ty === 'reasoning') {
      const t = String(b.thinking ?? b.text ?? '');
      if (t.trim()) { segs.push({ type: 'thinking', text: t }); stats.thinking++; }
      if (Array.isArray(b.summaries) && b.summaries.length) {
        const s = b.summaries[b.summaries.length - 1];
        if (s && s.summary) sums.push(String(s.summary));
      }
    } else if (ty === 'tool_use') {
      pushText(_ccToolLine(b, stats));
    } else if (ty === 'tool_result') {
      sawToolResult = true;
      stats.toolResults++;
    } else if (ty === 'voice_note') {
      pushText(`🎙 ${b.title ? '**' + _ccOneLine(b.title, 80) + '**\n\n' : ''}${b.text || ''}`);
    } else if (ty) {
      stats.unknownTypes[ty] = (stats.unknownTypes[ty] || 0) + 1;
      pushText(`> ⚠️ 这里原本有一块「${_ccOneLine(ty, 40)}」，导入器不认识，没带过来`);
    }
  }
  // content[] 是空的（老导出 / 某些消息）→ 退回 message.text
  if (!segs.some(s => s.type === 'text') && !sawToolResult) {
    pushText(String(msg.text || '').split(CC_UNSUPPORTED).join('').trim());
  }
  if (cites.length) {
    const lines = cites.map((c, i) => `${i + 1}. [${_ccOneLine(c.title || c.url, 100).replace(/[[\]]/g, '')}](${c.url})`);
    pushText('**来源**\n' + lines.join('\n'));
  }

  // 附件：文字附件原样保住；图片/二进制在 zip 里找得到就带，找不到明说
  const files = [];
  const images = [];
  (Array.isArray(msg.attachments) ? msg.attachments : []).forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    const name = String(a.file_name || '').trim() || `附件${i + 1}.${a.file_type || 'txt'}`;
    const text = typeof a.extracted_content === 'string' ? a.extracted_content : '';
    files.push({ name, content: text || '（claude.ai 的导出里没有这个附件的内容）' });
    stats.attachments++;
  });
  const seenF = new Set();
  [...(Array.isArray(msg.files) ? msg.files : []), ...(Array.isArray(msg.files_v2) ? msg.files_v2 : [])].forEach(f => {
    if (!f || typeof f !== 'object') return;
    const key = f.file_uuid || f.uuid || f.file_name;
    if (!key || seenF.has(key)) return;
    seenF.add(key);
    const name = String(f.file_name || f.file_uuid || '文件');
    const url = ctx.fileMap && (ctx.fileMap.get(f.file_uuid) || ctx.fileMap.get(f.uuid) || ctx.fileMap.get(f.file_name));
    if (url && /^data:image\//.test(url)) { images.push({ url, name }); stats.imagesKept++; return; }
    const isImg = f.file_kind === 'image' || CC_IMG_EXT.test(name);
    files.push({ name, content: `（claude.ai 的导出不含${isImg ? '图片' : '文件'}本体。这里原本是一个${isImg ? '图片' : '文件'}：${name}）`, missing: true });
    stats.filesMissing++;
  });

  const textSegs = segs.filter(s => s.type === 'text');
  const plain = textSegs.map(s => s.text).join('\n\n');
  if (!plain.trim() && !segs.length && !files.length && !images.length) return { role, drop: true };

  if (role === 'user') {
    // 她那边的思考块（极少见）也别丢：并进正文前面
    const think = segs.filter(s => s.type === 'thinking').map(s => s.text).join('\n\n');
    const out = { role, content: plain, drop: false };
    if (think) out.userThinking = think;
    if (files.length) out.files = files;
    if (images.length) out.images = images;
    return out;
  }
  const out = { role, content: plain, blocks: segs.map(s => ({ type: s.type, text: s.text })), drop: false };
  const think = segs.filter(s => s.type === 'thinking').map(s => s.text).join('\n\n');
  if (think) out.reasoning = think;
  // 思考块的标题用 claude.ai 自己写的那句概括（只有一块时才对得上号）
  if (sums.length && segs.filter(s => s.type === 'thinking').length === 1) out.thinkingSummary = sums[sums.length - 1];
  if (files.length) out.files = files;    // AI 侧的附件极少，有就留着（不渲染也不丢数据）
  return out;
}

function ccModelLabel(model) {
  const m = String(model || '').trim();
  if (!m) return 'Claude';
  // claude-3-5-sonnet-20241022 → Claude 3.5 Sonnet；认不出就原样
  const x = m.replace(/-\d{8}$/, '').replace(/^claude-/, '');
  const parts = x.split('-');
  const nums = [], words = [];
  for (const p of parts) (/^\d+$/.test(p) ? nums : words).push(p);
  if (!words.length) return 'Claude ' + nums.join('.');
  const w = words.map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  return ('Claude ' + (/^\d/.test(parts[0]) ? nums.join('.') + ' ' + w : w + (nums.length ? ' ' + nums.join('.') : ''))).trim();
}

function ccChatTitle(conv) {
  const n = _ccOneLine(conv.name, 80);
  if (n && n !== 'Untitled') return n;
  const first = (conv.chat_messages || []).find(m => m && m.sender === 'human');
  const t = first ? _ccOneLine((Array.isArray(first.content) && first.content.find(b => b && b.type === 'text')?.text) || first.text, 24) : '';
  return t || '（无标题）';
}

// ── 一个对话 → 节点树 ─────────────────────────────────
// existing：已经导入过的那个 GranCyan 对话（增量补消息），没有就是 null。
// alloc：发号器。正式导入传 nextId；预览阶段传一个假的计数器（不占真号）。
// 返回 { nodes: {id: node}（只含**新建**的）, headId, mode:'tree'|'linear', stats }
function ccConvertConversation(conv, existing, alloc, ctx, stats) {
  ctx = ctx || {};
  const st = stats || ccNewStats();
  const raw = (Array.isArray(conv.chat_messages) ? conv.chat_messages : []).filter(m => m && typeof m === 'object');
  // uuid 缺了就按位置补一个（只在本次转换内用于接父子；ccUuid 照样记，保证重导可去重）
  const msgs = [];
  const seen = new Set();
  raw.forEach((m, i) => {
    const uuid = String(m.uuid || `${conv.uuid}#${i}`);
    if (seen.has(uuid)) return;           // 同一条出现两次只收一次
    seen.add(uuid);
    msgs.push({ m, uuid, i, ts: ccTs(m.created_at) });
  });
  const tree = msgs.length > 0 && msgs.every(x => x.m.parent_message_uuid !== undefined);
  const byUuid = new Map(msgs.map(x => [x.uuid, x]));
  const parentUuid = new Map();
  msgs.forEach((x, k) => {
    if (tree) {
      const p = x.m.parent_message_uuid;
      parentUuid.set(x.uuid, p && byUuid.has(String(p)) && String(p) !== x.uuid ? String(p) : null);
    } else {
      parentUuid.set(x.uuid, k > 0 ? msgs[k - 1].uuid : null);
    }
  });

  // 已有的 uuid → 节点 id（增量导入时，旧节点当锚）
  const idOf = new Map();
  if (existing && existing.nodes) {
    for (const n of Object.values(existing.nodes)) if (n && n.ccUuid) idOf.set(String(n.ccUuid), n.id);
  }
  // 按时间先后处理：父亲总在孩子前面写下，所以先后顺序天然满足「先有父再有子」；
  // 时间戳乱了 / 父子成环的极端情况，下面的多轮扫描会兜住（成环的那批最后当根处理）
  const order = msgs.slice().sort((a, b) => (a.ts - b.ts) || (a.i - b.i));
  const done = new Set(idOf.keys());       // 已经有着落的 uuid（含被跳过的空消息）
  const alias = new Map();                  // 被跳过的空消息 uuid → 它该挂到的节点 id（null=根）
  const resolve = u => (u == null ? null : idOf.has(u) ? idOf.get(u) : alias.has(u) ? alias.get(u) : undefined);
  const nodes = {};
  let pending = order.filter(x => !done.has(x.uuid));
  let forceRoot = false;
  while (pending.length) {
    const next = [];
    for (const x of pending) {
      const pu = parentUuid.get(x.uuid);
      let pid = resolve(pu);
      if (pid === undefined) {
        if (!forceRoot) { next.push(x); continue; }
        pid = null;                         // 成环 / 父亲永远等不到：当根
      }
      const conv1 = ccMessageToNode(x.m, ctx, st);
      if (conv1.drop) {
        alias.set(x.uuid, pid);
        st.dropped++;
        continue;
      }
      const id = alloc();
      const tsv = x.ts || ccTs(conv.created_at) || 0;
      const node = { id, parentId: pid, role: conv1.role, content: conv1.content, timestamp: tsv, ccUuid: x.uuid };
      const tokText = conv1.content + (conv1.reasoning ? conv1.reasoning : '') + (conv1.userThinking || '');
      node.tokens = typeof estimateTokens === 'function' ? estimateTokens(tokText) : Math.ceil(tokText.length / 4);
      if (conv1.role === 'ai') {
        node.blocks = conv1.blocks;
        if (conv1.reasoning) node.reasoning = conv1.reasoning;
        if (conv1.thinkingSummary) node.thinkingSummary = conv1.thinkingSummary;
        node.modelId = null;
        node.modelNickname = ctx.modelLabel || 'Claude';
      } else if (conv1.userThinking) node.userThinking = conv1.userThinking;
      if (conv1.files) node.files = conv1.files;
      if (conv1.images) node.images = conv1.images;
      nodes[id] = node;
      idOf.set(x.uuid, id);
      st.messages++;
    }
    if (next.length === pending.length) forceRoot = true;   // 一轮没有进展 → 剩下的当根放
    else forceRoot = false;
    pending = next;
  }
  if (!tree && msgs.length > 1) st.linearConvs++;

  // 停在哪：网页当时停的那条（导出里有的话）> 最晚写下的那条叶子
  const all = Object.assign({}, existing ? existing.nodes : {}, nodes);
  const hasKid = new Set();
  for (const n of Object.values(all)) if (n && n.parentId != null) hasKid.add(String(n.parentId));
  const leafOf = id => {                 // 从某个节点一路往下走到最新的孩子
    let cur = id;
    for (let guard = 0; guard < 100000; guard++) {
      const kids = Object.values(all).filter(n => n && String(n.parentId) === String(cur));
      if (!kids.length) return cur;
      kids.sort((a, b) => (b.timestamp - a.timestamp) || (b.id - a.id));
      cur = kids[0].id;
    }
    return cur;
  };
  let headId = null;
  const leafUuid = conv.current_leaf_message_uuid && String(conv.current_leaf_message_uuid);
  if (leafUuid && resolve(leafUuid) != null) headId = leafOf(resolve(leafUuid));
  if (headId == null) {
    let best = null;
    for (const n of Object.values(all)) {
      if (!n || hasKid.has(String(n.id)) || !n.ccUuid) continue;
      if (!best || n.timestamp > best.timestamp || (n.timestamp === best.timestamp && n.id > best.id)) best = n;
    }
    headId = best ? best.id : null;
  }
  return { nodes, headId, mode: tree ? 'tree' : 'linear', stats: st };
}

function ccNewStats() {
  return { messages: 0, thinking: 0, toolCalls: 0, toolResults: 0, artifacts: 0, attachments: 0,
           imagesKept: 0, filesMissing: 0, dropped: 0, linearConvs: 0, unknownTypes: {} };
}

// ── 整份导出 → 计划（不动 state） ─────────────────────────
// 每个对话一个状态：new / update（导过，这次有新消息）/ same（导过，没有新的）/
// deleted（导过又删掉了）/ empty（一条消息都没有）
function ccPlanImport(convs, chats, tombstones, ctx) {
  const byUuid = new Map();
  for (const c of (chats || [])) {
    const u = c && c.importedFrom && c.importedFrom.uuid;
    if (u && !byUuid.has(String(u))) byUuid.set(String(u), c);
  }
  const gone = new Set();
  for (const v of Object.values(tombstones || {})) if (v && typeof v.cc === 'string' && v.cc) gone.add(v.cc);
  const items = [];
  const seenConv = new Set();
  for (const conv of convs) {
    if (!conv || !conv.uuid) continue;
    const uuid = String(conv.uuid);
    if (seenConv.has(uuid)) continue;      // 两份导出里都有的同一个对话（重叠的时间段）只算一次
    seenConv.add(uuid);
    const existing = byUuid.get(uuid) || null;
    let fake = 0;
    const r = ccConvertConversation(conv, existing, () => ++fake, Object.assign({}, ctx, { modelLabel: ccModelLabel(conv.model) }), ccNewStats());
    const added = Object.keys(r.nodes).length;
    let status;
    if (existing) status = added ? 'update' : 'same';
    else if (gone.has(uuid)) status = 'deleted';
    else status = added ? 'new' : 'empty';
    items.push({ conv, uuid, status, existing, added, title: existing ? existing.title : ccChatTitle(conv),
                 at: ccTs(conv.updated_at) || ccTs(conv.created_at), mode: r.mode });
  }
  return items;
}

// ── 落地：真发号、真写进 state.chats ─────────────────────
// includeDeleted：她勾了「之前删掉的也导回来」。返回 { created, updated, stats }。
function ccApplyImport(items, opts) {
  opts = opts || {};
  const ctx = opts.ctx || {};
  const stats = ccNewStats();
  let created = 0, updated = 0, addedMsgs = 0;
  if (typeof reseedIdCounter === 'function') reseedIdCounter();
  const now = Date.now();
  for (const it of items) {
    if (it.status === 'new' || (it.status === 'deleted' && opts.includeDeleted)) {
      const conv = it.conv;
      const chatId = nextId();
      const r = ccConvertConversation(conv, null, nextId, Object.assign({}, ctx, { modelLabel: ccModelLabel(conv.model) }), stats);
      if (!Object.keys(r.nodes).length) continue;
      const chat = {
        id: chatId, title: ccChatTitle(conv), nodes: r.nodes, headId: r.headId,
        isPinned: false, activeModelIds: [], msgLimit: 0, isGroupChat: false,
        totalTokens: Object.values(r.nodes).reduce((s, n) => s + (n.tokens || 0), 0),
        importedFrom: {
          from: CC_SOURCE, uuid: String(conv.uuid), model: conv.model || '',
          createdAt: ccTs(conv.created_at) || null, updatedAt: ccTs(conv.updated_at) || null,
          importedAt: now, mode: r.mode,
        },
      };
      if (conv.summary) chat.importedFrom.summary = String(conv.summary).slice(0, 2000);
      state.chats.push(chat);
      created++; addedMsgs += Object.keys(r.nodes).length;
    } else if (it.status === 'update' && it.existing) {
      const chat = (state.chats || []).find(c => c === it.existing)
        || (state.chats || []).find(c => c.importedFrom && c.importedFrom.uuid === it.uuid);
      if (!chat) continue;
      const r = ccConvertConversation(it.conv, chat, nextId, Object.assign({}, ctx, { modelLabel: ccModelLabel(it.conv.model) }), stats);
      const n = Object.keys(r.nodes).length;
      if (!n) continue;
      Object.assign(chat.nodes, r.nodes);
      // 她在 GranCyan 里接着聊过（当前停的那条不是导进来的）→ 不挪她的位置，新消息作为分支挂着
      const head = chat.nodes[chat.headId];
      if (!head || head.ccUuid) chat.headId = r.headId;
      chat.totalTokens = (chat.totalTokens || 0) + Object.values(r.nodes).reduce((s, x) => s + (x.tokens || 0), 0);
      chat.importedFrom.updatedAt = ccTs(it.conv.updated_at) || chat.importedFrom.updatedAt;
      chat.importedFrom.lastImportAt = now;
      updated++; addedMsgs += n;
    }
  }
  return { created, updated, addedMsgs, stats };
}

// ═══════════════════════════════════════════════════════
// 界面
// ═══════════════════════════════════════════════════════
let _ccPlan = null;          // 预览阶段的计划
let _ccFileMap = null;       // zip 里找到的图片：key(uuid/文件名) → dataURL
let _ccIncludeDeleted = false;
const CC_IMG_MAX = 3 * 1024 * 1024;   // 单张超过 3MB 不内联（会把云同步那一行撑爆），按「没有本体」处理

function openCcImport() {
  document.getElementById('ccImportModal')?.classList.remove('hidden');
  _ccPlan = null; _ccFileMap = null; _ccIncludeDeleted = false;
  ccRenderIntro();
}
function closeCcImport() { document.getElementById('ccImportModal')?.classList.add('hidden'); }

function ccRenderIntro(err) {
  const body = document.getElementById('ccImportBody');
  if (!body) return;
  body.innerHTML = `
    ${err ? `<div class="cc-err">⚠️ ${escHtml(err)}</div>` : ''}
    <div class="cc-steps">
      <div class="cc-step"><b>1</b><span>在 claude.ai 网页：左下角头像 → <b>Settings</b> → <b>Privacy</b> → <b>Export data</b></span></div>
      <div class="cc-step"><b>2</b><span>等邮件（几分钟到一小时），点里面的链接下载。<br><span class="study-dim">如果下下来的是一个小 JSON，里面是几个链接 —— 点 conversations 那个，下载真正的 zip。</span></span></div>
      <div class="cc-step"><b>3</b><span>在这里选那个 <b>zip</b>（或者解压出来的 <b>conversations.json</b>）。可以一次选好几个。</span></div>
    </div>
    <label class="study-go cc-pick">📂 选择导出文件
      <input type="file" accept=".zip,.json,application/zip,application/json" multiple hidden onchange="ccOnFiles(this.files)">
    </label>
    <div class="study-dim cc-note">
      导入的对话左边会挂一个 <span class="cc-badge">claude.ai</span> 标记。重复导入不会翻倍：已经有的只补新消息。<br>
      导出里<b>没有图片本体</b>（只有文件名），文字附件、思考过程、重新生成的分支都能带过来。
    </div>`;
}

async function _ccReadFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.json')) return { texts: [await file.text()], zip: null };
  if (typeof JSZip === 'undefined') throw new Error('解压组件没加载出来（JSZip），先把 zip 解压，选里面的 conversations.json');
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(f => !f.dir && /(^|\/)conversations\.json$/i.test(f.name));
  if (!entries.length) {
    const names = Object.keys(zip.files).filter(n => n.toLowerCase().endsWith('.json')).map(n => n.split('/').pop());
    throw new Error(`这个 zip 里没有 conversations.json${names.length ? '（只有 ' + names.slice(0, 4).join('、') + '）—— 这可能是项目/记忆那一份，换对话那一份' : ''}`);
  }
  const texts = [];
  for (const e of entries) texts.push(await e.async('string'));
  return { texts, zip };
}

// zip 里有没有图片本体（多数导出没有）：按 file_uuid / 文件名去对，只读被引用到的那几张
async function _ccLoadImages(zips, convs) {
  const want = new Set();
  for (const c of convs) for (const m of (c.chat_messages || [])) {
    for (const f of [...(m && m.files || []), ...(m && m.files_v2 || [])]) {
      if (f && f.file_uuid) want.add(String(f.file_uuid));
      if (f && f.file_name) want.add(String(f.file_name));
    }
  }
  const map = new Map();
  if (!want.size) return map;
  for (const zip of zips) {
    for (const e of Object.values(zip.files)) {
      if (e.dir || !CC_IMG_EXT.test(e.name)) continue;
      const base = e.name.split('/').pop();
      const keys = [...want].filter(k => base === k || e.name.includes(k));
      if (!keys.length) continue;
      try {
        const b64 = await e.async('base64');
        if (b64.length * 0.75 > CC_IMG_MAX) continue;
        const ext = base.split('.').pop().toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/' + ext;
        const url = `data:${mime};base64,${b64}`;
        keys.forEach(k => { if (!map.has(k)) map.set(k, url); });
      } catch {}
    }
  }
  return map;
}

async function ccOnFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const body = document.getElementById('ccImportBody');
  if (body) body.innerHTML = `<div class="cc-busy">读取中…（对话多的话要十几秒）</div>`;
  await new Promise(r => setTimeout(r, 30));   // 让「读取中」先画出来，大 JSON 解析会卡住主线程
  try {
    const convs = [], zips = [];
    for (const f of files) {
      const { texts, zip } = await _ccReadFile(f);
      if (zip) zips.push(zip);
      for (const t of texts) {
        let data;
        try { data = JSON.parse(t); } catch (e) { throw new Error(`${f.name} 不是有效的 JSON（${e.message}）`); }
        convs.push(...ccDetectExport(data));
      }
    }
    if (!convs.length) throw new Error('文件里一个对话都没有');
    _ccFileMap = await _ccLoadImages(zips, convs);
    _ccPlan = ccPlanImport(convs, state.chats, state.deletedChats, { fileMap: _ccFileMap });
    ccRenderPlan();
  } catch (e) {
    console.warn('[claude.ai 导入]', e);
    ccRenderIntro(e.message || String(e));
  }
}

function _ccDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ccSetIncludeDeleted(on) { _ccIncludeDeleted = !!on; ccRenderPlan(); }

function ccRenderPlan() {
  const body = document.getElementById('ccImportBody');
  if (!body || !_ccPlan) return;
  const cnt = s => _ccPlan.filter(i => i.status === s).length;
  const nNew = cnt('new'), nUpd = cnt('update'), nSame = cnt('same'), nDel = cnt('deleted'), nEmpty = cnt('empty');
  const todo = nNew + nUpd + (_ccIncludeDeleted ? nDel : 0);
  const linear = _ccPlan.filter(i => i.mode === 'linear' && (i.status === 'new' || i.status === 'update')).length;
  const label = { new: '新', update: '补新消息', same: '已有', deleted: '删过', empty: '空' };
  const list = _ccPlan.slice().sort((a, b) => b.at - a.at).map(i => `
    <div class="cc-row cc-${i.status}${i.status === 'deleted' && _ccIncludeDeleted ? ' cc-on' : ''}">
      <span class="cc-tag">${label[i.status]}</span>
      <span class="cc-title">${escHtml(i.title)}</span>
      <span class="cc-meta">${i.added ? (i.status === 'same' ? '' : '+' + i.added + ' 条 · ') : ''}${_ccDate(i.at)}</span>
    </div>`).join('');
  body.innerHTML = `
    <div class="forge-stats">
      <div class="study-stat"><b>${nNew}</b><span>新对话</span></div>
      <div class="study-stat"><b>${nUpd}</b><span>补新消息</span></div>
      <div class="study-stat"><b>${nSame}</b><span>已经有了</span></div>
      <div class="study-stat"><b>${nDel}</b><span>导过又删掉</span></div>
    </div>
    ${nDel ? `<label class="forge-imgs cc-opt"><input type="checkbox" onchange="ccSetIncludeDeleted(this.checked)"${_ccIncludeDeleted ? ' checked' : ''}> 之前删掉的那 ${nDel} 个也导回来</label>` : ''}
    ${linear ? `<div class="study-dim cc-note">⚠️ 有 ${linear} 个对话是老格式导出（没有分支信息），只能按顺序排成一条线 —— 当时重新生成过的回复会挨着排在一起。</div>` : ''}
    ${nEmpty ? `<div class="study-dim cc-note">${nEmpty} 个空对话（一条消息都没有）会跳过。</div>` : ''}
    <div class="forge-go-row">
      <button class="study-go" onclick="ccDoImport()"${todo ? '' : ' disabled'}>${todo ? `⤓ 导入 ${todo} 个` : '没有要导入的'}</button>
    </div>
    <div class="cc-list">${list}</div>`;
}

function ccDoImport() {
  if (!_ccPlan) return;
  let res;
  try {
    res = ccApplyImport(_ccPlan, { includeDeleted: _ccIncludeDeleted, ctx: { fileMap: _ccFileMap } });
  } catch (e) {
    console.error('[claude.ai 导入] 落地失败', e);
    showToast('导入失败：' + (e.message || e), 'error', 6000);
    return;
  }
  save(); renderChatList();
  if (typeof renderMessages === 'function') renderMessages();
  const s = res.stats;
  const lost = [];
  if (s.filesMissing) lost.push(`${s.filesMissing} 个图片/文件只有名字（导出里没有本体，留了卡片标着）`);
  if (s.toolResults) lost.push(`${s.toolResults} 段工具返回的原文（搜索结果之类）没导，调用本身留了一行说明`);
  const unk = Object.keys(s.unknownTypes);
  if (unk.length) lost.push(`不认识的内容块：${unk.join('、')}（原处留了提示）`);
  const kept = [];
  if (s.thinking) kept.push(`${s.thinking} 段思考`);
  if (s.artifacts) kept.push(`${s.artifacts} 个 artifact/文件正文`);
  if (s.attachments) kept.push(`${s.attachments} 个文字附件`);
  if (s.imagesKept) kept.push(`${s.imagesKept} 张图`);
  const body = document.getElementById('ccImportBody');
  if (body) body.innerHTML = `
    <div class="cc-done">
      <div class="cc-done-big">✓ 新建 ${res.created} 个对话${res.updated ? `，${res.updated} 个补了新消息` : ''}，共 ${res.addedMsgs} 条</div>
      ${kept.length ? `<div>带过来了：${kept.join('、')}</div>` : ''}
      ${lost.length ? `<div class="cc-lost"><b>没带过来的（明说一下）：</b><br>${lost.map(escHtml).join('<br>')}</div>` : ''}
      <div class="study-dim">它们按当时的时间排在对话列表里，挂着 <span class="cc-badge">claude.ai</span> 标记。</div>
      <button class="study-go" onclick="closeCcImport()">好</button>
    </div>`;
  showToast(`✓ 从 claude.ai 导入 ${res.created} 个对话`, 'success', 4000);
  _ccPlan = null; _ccFileMap = null;
}
