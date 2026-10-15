/* ═══ 消息 emoji 标注（reactions）════════════════════════════════════
   用户和 AI 都能给某条消息贴 emoji，像社交软件那样在气泡下面排成一行小药丸。
   数据挂在消息节点上：m.reactions = [{ e, by, id, who, t }]
     e    emoji 本身
     by   'user' | 'ai'
     id   AI 的**模型 id**（conf.id）—— 身份和去重都认它
     who  AI 的昵称，只用来显示。昵称不能当身份：群里两个模型可以同名，
          而一个模型改了名还是同一个它。拿昵称去重的话，前者第二个模型贴不上（被当成重复），
          后者改名后能把同一个 emoji 再贴一遍。（Codex 审出来的）
     t    时间戳（同一个 emoji 多人贴时按先后排）
   节点跟着对话一起存，不用过 state 的三道白名单（那是给 settings 字段准备的）。   */

const REACT_QUICK = ['❤️', '😂', '👍', '🥺', '😭', '🤔', '🔥', '✨', '🫂', '👀', '💯', '😤'];

function _reactList(m) { return Array.isArray(m && m.reactions) ? m.reactions : []; }

// 同一个 emoji 聚成一颗药丸，保留「谁贴的」用来显示 tooltip 和判断自己点没点过
function _reactGroups(m) {
  const out = [];
  for (const r of _reactList(m)) {
    if (!r || !r.e) continue;
    let g = out.find(x => x.e === r.e);
    if (!g) { g = { e: r.e, n: 0, mine: false, whos: [] }; out.push(g); }
    g.n++;
    if (r.by === 'user') { g.mine = true; g.whos.push('你'); }
    else g.whos.push(r.who || 'AI');
  }
  return out;
}

function renderReactions(m) {
  const groups = _reactGroups(m);
  // 容器一直在（哪怕是空的）：贴第一个 emoji 时只要填这一个格子就行，
  // 不用整条消息重画 —— 重画会打断流式气泡、清掉展开状态，还会把滚动位置顶跑。
  return `<div class="react-row" id="react-row-${m.id}">${groups.map(g => `
    <button type="button" class="react-pill${g.mine ? ' mine' : ''}" onclick="toggleReaction(${m.id},${jsAttr(g.e)})"
            title="${escHtml(g.whos.join('、'))}">
      <span class="react-emo">${escHtml(g.e)}</span>${g.n > 1 ? `<span class="react-n">${g.n}</span>` : ''}
    </button>`).join('')}</div>`;
}

// 只重画一条消息的那一行。找不到容器（消息还没渲染 / 被折叠）就整页重画兜底。
function _refreshReactionRow(nodeId) {
  const chat = getActiveChat();
  const m = chat && chat.nodes && chat.nodes[nodeId];
  if (!m) return;
  const row = document.getElementById('react-row-' + nodeId);
  if (!row) { if (typeof renderMessages === 'function') renderMessages(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = renderReactions(m);
  row.innerHTML = tmp.firstElementChild.innerHTML;
}

function toggleReaction(nodeId, emoji) {
  const chat = getActiveChat();
  const m = chat && chat.nodes && chat.nodes[nodeId];
  if (!m || !emoji) return;
  const list = _reactList(m).slice();
  const i = list.findIndex(r => r.e === emoji && r.by === 'user');
  if (i >= 0) list.splice(i, 1);
  else list.push({ e: emoji, by: 'user', who: '', t: Date.now() });
  m.reactions = list;
  save();
  _refreshReactionRow(nodeId);
  closeReactionPicker();
}

// AI 贴的那一份。同一个模型对同一条消息贴同一个 emoji 只算一次（重复写指令不该叠成一堆）。
// 认的是模型 id 不是昵称；老记录没有 id，才退回按昵称比。
function addAiReaction(chat, nodeId, emoji, id, who) {
  const m = chat && chat.nodes && chat.nodes[nodeId];
  if (!m || !emoji) return false;
  const list = _reactList(m).slice();
  const same = r => r.id != null && id != null ? String(r.id) === String(id) : (r.who || '') === (who || '');
  if (list.some(r => r.e === emoji && r.by === 'ai' && same(r))) return false;
  list.push({ e: emoji, by: 'ai', id: id == null ? null : String(id), who: who || 'AI', t: Date.now() });
  m.reactions = list;
  return true;
}

/* 模型写的 [[REACT: 😂]] 落在哪条消息上：它正在回复的那条用户发言（studyCtx.userTurnId）。
   为什么不让模型自己指定 id —— 它看不到节点 id，让它数「第几条」必错，而错贴是无声的：
   emoji 会出现在一条毫不相干的老消息上，没人会去查。 */
function applyAiReaction(chat, studyCtx, emoji, conf) {
  const target = studyCtx && studyCtx.userTurnId;
  if (!target) return;
  const who = (conf && (conf.nickname || conf.name)) || 'AI';
  const id = conf && conf.id != null ? conf.id : null;
  if (addAiReaction(chat, target, emoji.trim(), id, who)) {
    // save() 由调用方那一轮的收尾负责；这里只把界面点亮
    setTimeout(() => _refreshReactionRow(target), 0);
  }
}

// 流式期间把没写完的指令遮住，别让 [[REACT: 之类的裸标签在气泡里一闪一闪
function maskStreamingReact(text) {
  if (!text || text.indexOf('[[REACT') === -1) return text;
  return text
    .replace(/\[\[REACT:[\s\S]*?\]\]/gi, '')
    .replace(/\[\[REACT:?[\s\S]*$/i, '');
}

/* blocks 那条渲染路径不看 node.content，所以标签得在这里再抹一遍。
   这里只抹不执行：贴 emoji 的副作用已经在 processAiCommands（content 那条路）里做过了，
   再执行一次就是同一个 emoji 贴两遍。*/
function _applyReactToBlocks(blocks) {
  if (!blocks || !blocks.length) return;
  for (const b of blocks) {
    if (b.type === 'text' && b.text && b.text.indexOf('[[REACT') !== -1) {
      b.text = b.text.replace(/\[\[REACT:\s*[^\]]{0,16}?\s*\]\]/gi, '');
    }
  }
}

/* ── 思考链那把锁的三个配套 ─────────────────────────────────────
   药丸两条渲染路径共用这一份，免得 content 和 blocks 长得不一样。 */
function _thinkVeilPillHtml(on) {
  const label = on ? '\u{1f513} 让你看得清了' : '\u{1f512} 又调回模糊了';
  const body  = on ? '从现在起那块内容对你是清晰的，包括这之前的每一处'
                   : '那块内容重新模糊了 \u2014\u2014 想看的话再问我';
  return `<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">\u25b8</span> <span class="think-label">${label}</span></div><div class="think-body">${body}</div></div>`;
}

function maskStreamingThinkVeil(text) {
  if (!text || text.indexOf('[[THINK_') === -1) return text;
  return text
    .replace(/\[\[THINK_(OPEN|CLOSE)\]\]/gi, '')
    .replace(/\[\[THINK_?[A-Z]*$/i, '');
}

/* blocks 那条渲染路径不看 node.content，所以标签得在这里再换一遍。
   这里**只换成药丸、不执行开关** —— 执行的那一下已经在 processAiCommands 里做过了。
   在这儿执行的话，她往回滚屏幕、或者任何一次重渲染，都会把一条旧消息里的
   [[THINK_OPEN]] 重新跑一遍，把她刚还回去的锁又掀开（而且零报错）。 */
function _applyThinkVeilToBlocks(blocks) {
  if (!blocks || !blocks.length) return;
  for (const b of blocks) {
    if (b.type === 'text' && b.text && b.text.indexOf('[[THINK_') !== -1) {
      b.text = b.text.replace(/\[\[THINK_(OPEN|CLOSE)\]\]/gi,
        (_, sw) => '\n\n' + _thinkVeilPillHtml(sw.toUpperCase() === 'OPEN') + '\n\n');
    }
  }
}

// 回填给模型时的可读形态：让它知道这条消息上已经有谁贴了什么
function reactionsForApi(m) {
  const groups = _reactGroups(m);
  if (!groups.length) return '';
  return '\n[这条消息上的 emoji 标注: ' + groups.map(g => `${g.e}×${g.n}(${g.whos.join('、')})`).join('，') + ']';
}

/* ── 选择器 ──────────────────────────────────────────────────────── */
let _reactPickerFor = null;
function openReactionPicker(nodeId, ev, anchorRect) {
  if (ev) ev.stopPropagation();
  const box = document.getElementById('reactPicker');
  if (!box) return;
  if (_reactPickerFor === nodeId && !box.classList.contains('hidden')) { closeReactionPicker(); return; }
  _reactPickerFor = nodeId;
  const chat = getActiveChat();
  const m = chat && chat.nodes && chat.nodes[nodeId];
  const mine = new Set(_reactList(m).filter(r => r.by === 'user').map(r => r.e));
  box.innerHTML = REACT_QUICK.map(e => `
      <button type="button" class="react-pick${mine.has(e) ? ' on' : ''}" onclick="toggleReaction(${nodeId},${jsAttr(e)})">${escHtml(e)}</button>`).join('') +
    `<button type="button" class="react-pick react-pick-more" onclick="pickCustomReaction(${nodeId})" title="打一个别的">＋</button>`;
  box.classList.remove('hidden');
  // 贴着触发它的那颗按钮放，再夹回视口里 —— 屏幕边上的消息会把浮层顶出去一半
  const r = anchorRect || (ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null);
  box.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = r ? r.left : (innerWidth - w) / 2;
    let top = r ? r.top - h - 8 : innerHeight / 2;
    if (left + w > innerWidth - 8) left = innerWidth - w - 8;
    if (left < 8) left = 8;
    if (top < 8) top = r ? Math.min(r.bottom + 8, innerHeight - h - 8) : 8;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.visibility = '';
  });
}
function closeReactionPicker() {
  document.getElementById('reactPicker')?.classList.add('hidden');
  _reactPickerFor = null;
}
async function pickCustomReaction(nodeId) {
  closeReactionPicker();
  const e = await appPrompt('打一个 emoji 贴在这条消息上：', '');
  if (e && e.trim()) toggleReaction(nodeId, e.trim().slice(0, 8));
}
document.addEventListener('click', ev => {
  const box = document.getElementById('reactPicker');
  if (!box || box.classList.contains('hidden')) return;
  if (!box.contains(ev.target)) closeReactionPicker();
});
