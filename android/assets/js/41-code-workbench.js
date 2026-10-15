'use strict';

let _cw = { version: 1, projects: [], activeProjectId: '', activeSessionId: '', activeProvider: 'codex' };
let _cwSaveTimer = null;
let _cwLoaded = false;     // 至少成功 GET 过一次状态，才允许 PUT（见 cwScheduleSave）
const _cwStreams = new Map();
let _cwRecoverTimer = null;
const _cwAttachments = new Map();
let _cwTraceProvider = '', _cwCommandIndex = 0, _cwUsagePanel = null, _cwThinkTimer = null, _cwThinkStep = 0, _cwTrashOpen = false;
const cwId = p => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const cwProject = () => _cw.projects.find(x => x.id === _cw.activeProjectId) || null;
const cwSession = () => cwProject()?.sessions?.find(x => x.id === _cw.activeSessionId) || null;
const cwFindSession = id => {
  for (const p of _cw.projects || []) {
    const s = (p.sessions || []).find(x => x.id === id);
    if (s) return { p, s };
  }
  return null;
};
const CW_MODELS = {
  codex: [['', '默认 · GPT-5.6 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-5.5', 'GPT-5.5'], ['gpt-5.4', 'GPT-5.4']],
  claude: [['', '默认 · 跟随 CC'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-fable-5', 'Fable 5'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']]
};
const CW_COMMANDS = [
  { name: '/model', desc: '选择这一条项目链路使用的模型' },
  { name: '/usage', desc: '查看本轮 token 与上下文用量' },
  { name: '/compact', desc: '压缩较早对话，保留最近六条原文' },
  { name: '/status', desc: '显示模型、思考模式、目录和会话状态' },
  { name: '/thinking', desc: '切换 自动 / 总是 / 关闭' },
  { name: '/provider', desc: '切换 Claude Code / Codex' },
  { name: '/new', desc: '在当前项目新建一条会话' },
  { name: '/rename', desc: '重命名当前会话：/rename 新名字' },
  { name: '/clear', desc: '清空当前输入，不删除 transcript' },
  { name: '/help', desc: '显示命令与快捷键' }
];
const CW_THINK_LABELS = {
  claude: ['clauding…', '揉一揉上下文…', '沿着代码闻过去…', '把工具线索串起来…'],
  codex: ['thinking…', '翻看工作区…', '推演下一步…', '核对改动边界…']
};

function cwProvider(p = cwProject()) { return p?.provider || _cw.activeProvider || 'codex'; }
function cwModel(p = cwProject()) { return p?.models?.[cwProvider(p)] ?? p?.model ?? ''; }
function cwThinking(p = cwProject()) { return p?.thinkingModes?.[cwProvider(p)] || 'auto'; }
function cwTokenEstimate(s = cwSession()) {
  const chars = (s?.compactSummary || '').length + (s?.messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  return Math.max(0, Math.ceil(chars / 3.2));
}

function cwScheduleSave() {
  // 没从服务端成功读到过状态时，内存里那份是开局的空壳 —— PUT 回去就是拿空壳盖掉全部项目。
  if (!_cwLoaded) return;
  clearTimeout(_cwSaveTimer);
  _cwSaveTimer = setTimeout(() => fetch(SERVER_BASE + '/api/code-workbench/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_cw)
  }).catch(() => {}), 250);
}

function cwIsEmptySession(s) {
  return !!s && s.status !== 'running' && !(s.messages || []).length && !(s.events || []).length && !(_cwAttachments.get(s.id) || []).length;
}
function cwPruneEmptySessions(keepSessionId = '') {
  let changed = false;
  for (const p of _cw.projects || []) {
    const before = (p.sessions || []).length;
    p.sessions = (p.sessions || []).filter(s => s.id === keepSessionId || !cwIsEmptySession(s));
    if (p.sessions.length !== before) changed = true;
  }
  if (changed) cwScheduleSave();
  return changed;
}

async function openCodeWorkbench() {
  document.getElementById('widgetsPanel')?.classList.add('hidden');
  document.getElementById('codeWorkbenchModal')?.classList.remove('hidden');
  let loaded = false;
  try {
    const r = await fetch(SERVER_BASE + '/api/code-workbench/state');
    const d = await r.json();
    if (r.ok && d.ok && d.state && Array.isArray(d.state.projects)) { cwAdoptState(d.state); loaded = true; }
  } catch {}
  // 读失败（断网、服务端读盘出错）时绝不能回写：以前这里无条件 cwScheduleSave，
  // 一次瞬时的 EBUSY 就会把空状态 PUT 回去，所有项目和会话全没了。
  // （之前成功读过的话，内存里那份就是真的，照常用；只有从没读成功过才提示不保存。）
  if (loaded) _cwLoaded = true;
  else if (!_cwLoaded) showToast('工作台记录没读出来，这次的改动不会保存；稍后关掉重开再试。', 'error', 4000);
  _cw.trash = Array.isArray(_cw.trash) ? _cw.trash : [];
  _cw.activeProvider = _cw.activeProvider || cwProject()?.provider || 'codex';
  for (const p of _cw.projects || []) p.provider = p.provider || 'codex';
  cwBindDropZone();
  cwRender(); cwStartThinkingTicker(); if (loaded) cwScheduleSave(); cwRecoverRuns(); document.getElementById('cwInput')?.focus();
}
// 关掉工作台不会断流（设计如此，任务在后台接着跑）。重开时整棵状态树换成服务端那份的话，
// 还在跑的流手里攥的是旧树里的会话对象：回复写进孤儿对象，新树那条永远停在 running，
// 这一轮回复就丢了。所以有活流的会话，把旧对象按 id 嫁接进新树，让流继续写在看得见的地方。
function cwAdoptState(next) {
  for (const id of _cwStreams.keys()) {
    const live = cwFindSession(id)?.s; if (!live) continue;
    for (const p of next.projects || []) {
      const i = (p.sessions || []).findIndex(x => x.id === id);
      if (i >= 0) { p.sessions[i] = live; break; }
    }
  }
  _cw = next;
}

// SSE 脱离不等于后台任务停止。恢复必须是一个持续的、去重的循环：
// 以前只在打开工作台时试一次，首次流或恢复流再次断开后就永远停在 running，
// 用户看到的便是 Codex「工作老是中断」，实际上活还在服务端继续跑。
function cwScheduleRecoverRuns(delay = 1500) {
  if (_cwRecoverTimer) return;
  _cwRecoverTimer = setTimeout(() => {
    _cwRecoverTimer = null;
    cwRecoverRuns();
  }, delay);
}
function closeCodeWorkbench() {
  const active = _cw.activeSessionId;
  document.getElementById('codeWorkbenchModal')?.classList.add('hidden'); cwHideCommandMenu(); cwStopThinkingTicker();
  // 拖到一半按 Esc 关掉工作台的话，dragleave/drop 都不会再来，计数和高亮会永远卡住，
  // 下次打开直接是「一进来就亮着放置提示」。关的时候清干净。
  _cwDragDepth = 0; document.getElementById('codeWorkbenchModal')?.classList.remove('cw-dragging');
  if (cwPruneEmptySessions()) {
    if (active && !cwFindSession(active)) _cw.activeSessionId = '';
    cwScheduleSave();
  }
}

async function cwNewProject() {
  const cwd = await appPrompt('项目目录（电脑上的绝对路径）\n例如：C:\\projects\\GranCyan', cwProject()?.cwd || ''); if (!cwd) return;
  try {
    const r = await fetch(SERVER_BASE + '/api/code-workbench/check-cwd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    const provider = _cw.activeProvider || 'codex';
    const p = { id: cwId('p'), name: d.cwd.split(/[\\/]/).filter(Boolean).pop() || '项目', cwd: d.cwd, provider, model: '', models: { codex: '', claude: '' }, thinkingModes: { codex: 'auto', claude: 'auto' }, sessions: [] };
    _cw.projects.push(p); _cw.activeProjectId = p.id; cwNewSession();
  } catch (e) { showToast(e.message, 'error'); }
}
function cwNewSession() {
  const p = cwProject(); if (!p) return cwNewProject();
  cwPruneEmptySessions();
  const s = { id: cwId('s'), title: '新任务', createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', messages: [], events: [] };
  p.sessions = p.sessions || []; p.sessions.unshift(s); _cw.activeSessionId = s.id; cwScheduleSave(); cwRender();
}
function cwSelectProject(id) { cwPruneEmptySessions(); _cwTrashOpen = false; _cw.activeProjectId = id; const p = cwProject(); if (p) _cw.activeProvider = p.provider || 'codex'; _cw.activeSessionId = p?.sessions?.[0]?.id || ''; _cwUsagePanel = null; cwScheduleSave(); cwRender(); }
function cwSelectSession(id) { cwPruneEmptySessions(id); _cwTrashOpen = false; _cw.activeSessionId = id; _cwUsagePanel = null; cwScheduleSave(); cwRender(); cwRenderAttachments(); }
async function cwRenameSession(id) {
  const found = cwFindSession(id); if (!found) return;
  const value = await appPrompt('修改会话标题', found.s.title || '新任务');
  const title = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!title || title === found.s.title) return;
  found.s.title = title; found.s.updatedAt = Date.now();
  cwScheduleSave(); cwRender(); showToast('会话标题已修改。', 'success');
}
function cwSetProvider(v) {
  if (!['codex', 'claude'].includes(v)) return;
  cwPruneEmptySessions(); _cwTrashOpen = false;
  const old = cwProject();
  _cw.activeProvider = v;
  let p = (_cw.projects || []).find(x => (x.provider || 'codex') === v && (!old || x.cwd === old.cwd));
  if (!p && old) {
    p = { id: cwId('p'), name: old.name, cwd: old.cwd, provider: v, model: '', models: { codex: '', claude: '' }, thinkingModes: { codex: 'auto', claude: 'auto' }, sessions: [] };
    _cw.projects.push(p);
  }
  _cw.activeProjectId = p?.id || '';
  _cw.activeSessionId = p?.sessions?.[0]?.id || '';
  _cwUsagePanel = null; _cwTraceProvider = '';
  if (p && !p.sessions.length) cwNewSession(); else { cwScheduleSave(); cwRender(); }
}

async function cwDeleteSession(id) {
  const found = cwFindSession(id); if (!found) return;
  if (found.s.status === 'running') { showToast('这条任务还在运行，请先停止，再移入回收站。', 'info'); return; }
  const yes = await appPrompt(`把“${found.s.title || '未命名会话'}”移入回收站？\n消息、思考和工具链都可以恢复。\n输入“删除”继续。`, '');
  if (String(yes || '').trim() !== '删除') return;
  _cw.trash = Array.isArray(_cw.trash) ? _cw.trash : [];
  _cw.trash.unshift({ id: cwId('trash'), deletedAt: Date.now(), project: { id: found.p.id, name: found.p.name, cwd: found.p.cwd, provider: found.p.provider || 'codex' }, session: found.s });
  found.p.sessions = found.p.sessions.filter(x => x.id !== id); _cwAttachments.delete(id);
  if (_cw.activeSessionId === id) _cw.activeSessionId = found.p.sessions[0]?.id || '';
  cwScheduleSave(); cwRender(); showToast('会话已移入回收站。', 'success');
}
function cwToggleTrash() { _cwTrashOpen = !_cwTrashOpen; _cwUsagePanel = null; _cwTraceProvider = ''; cwRender(); }
function cwRestoreSession(trashId) {
  const i = (_cw.trash || []).findIndex(x => x.id === trashId); if (i < 0) return;
  const item = _cw.trash[i];
  let p = (_cw.projects || []).find(x => x.id === item.project?.id);
  if (!p) {
    p = { id: item.project?.id || cwId('p'), name: item.project?.name || '恢复的项目', cwd: item.project?.cwd || '', provider: item.project?.provider || 'codex', model: '', models: { codex: '', claude: '' }, thinkingModes: { codex: 'auto', claude: 'auto' }, sessions: [] };
    _cw.projects.push(p);
  }
  item.session.status = item.session.status === 'running' ? 'interrupted' : item.session.status;
  item.session.updatedAt = Date.now(); p.sessions = p.sessions || []; p.sessions.unshift(item.session);
  _cw.trash.splice(i, 1); _cw.activeProvider = p.provider || 'codex'; _cw.activeProjectId = p.id; _cw.activeSessionId = item.session.id; _cwTrashOpen = false;
  cwScheduleSave(); cwRender(); showToast('会话已恢复。', 'success');
}
async function cwDeleteTrashItem(trashId) {
  const item = (_cw.trash || []).find(x => x.id === trashId); if (!item) return;
  const yes = await appPrompt(`彻底删除“${item.session?.title || '未命名会话'}”？\n删除后无法恢复。\n输入“彻底删除”继续。`, '');
  if (String(yes || '').trim() !== '彻底删除') return;
  _cw.trash = _cw.trash.filter(x => x.id !== trashId); cwScheduleSave(); cwRender();
}
async function cwEmptyTrash() {
  const provider = _cw.activeProvider || 'codex';
  const count = (_cw.trash || []).filter(x => (x.project?.provider || 'codex') === provider).length;
  if (!count) return;
  const yes = await appPrompt(`彻底清空当前后端回收站里的 ${count} 条会话？\n输入“清空”继续。`, '');
  if (String(yes || '').trim() !== '清空') return;
  _cw.trash = _cw.trash.filter(x => (x.project?.provider || 'codex') !== provider); cwScheduleSave(); cwRender(); showToast('回收站已清空。', 'success');
}
function cwSetModel(v) { const p = cwProject(); if (!p) return; p.models = p.models || {}; p.models[cwProvider(p)] = v; p.model = v; cwScheduleSave(); cwRender(); }
function cwSetThinking(v) { const p = cwProject(); if (!p || !['auto', 'always', 'off'].includes(v)) return; p.thinkingModes = p.thinkingModes || {}; p.thinkingModes[cwProvider(p)] = v; cwScheduleSave(); cwRender(); }

// CLI 版式：行首一个标记符，正文左对齐平铺，不做气泡卡片。
// 名字和时间不再占一行 —— 它们进 title，鼠标停上去还能看到，但不打断阅读流。
function cwRenderMessage(m) {
  const who = m.role === 'user' ? ((typeof state !== 'undefined' && state && state.userName) || '用户') : (m.provider === 'claude' ? '克克 / Claude' : 'GPT / Codex');
  const files = (m.attachments || []).map(x => `<span class="cw-msg-file">▧ ${escHtml(x.name || '图片')}</span>`).join('');
  const timing = cwTimingText(m);
  const when = new Date(m.at || Date.now()).toLocaleString();
  const mark = m.role === 'user' ? '&gt;' : '⏺';
  return `<article class="cw-msg ${m.role}${m.role !== 'user' && m.provider === 'claude' ? ' claude' : ''}">`
    + `<span class="cw-gutter" title="${escHtml(who)} · ${escHtml(when)}">${mark}</span>`
    + `<div>${files}${escHtml(m.content || '').replace(/\n/g, '<br>')}`
    + `${timing ? `<small class="cw-msg-timing" title="思考时间按进程就绪到首个可观察的思考/工具/正文事件计算">${escHtml(timing)}</small>` : ''}</div></article>`;
}
// 每行一个 span，拼接时**不能**加换行：这些 span 在 CSS 里是 display:block，
// 而外层 pre 是 white-space:pre-wrap。拼换行进去，block 之间那个换行会再渲染一次，
// 每行 diff 都变成双倍行距 —— 不报错，只是看着像排版崩了（2026-08-28 截图才发现）。
function cwDiffLines(text) {
  return String(text || '').split('\n').map(line => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del'
      : line.startsWith('@@') ? 'hunk' : '';
    return `<span${cls ? ` class="cw-diff-${cls}"` : ''}>${escHtml(line)}</span>`;
  }).join('');
}
// 取工具调用的「主参数」，用来拼成 CC 那样的 Read(js/x.js)。
// 注意：这段会被 code-workbench.test.js 抽进 vm sandbox 单独执行，
// 那里没有 cwProject，所以必须 typeof 守卫，否则测试直接 ReferenceError。
const CW_TOOL_ARG_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'prompt'];
function cwToolArg(input) {
  let raw = '';
  for (const k of CW_TOOL_ARG_KEYS) { const v = input?.[k]; if (typeof v === 'string' && v.trim()) { raw = v.trim(); break; } }
  if (!raw) return '';
  const cwd = typeof cwProject === 'function' ? (cwProject()?.cwd || '') : '';
  if (cwd && raw.toLowerCase().startsWith(cwd.toLowerCase())) raw = raw.slice(cwd.length).replace(/^[\\/]+/, '') || '.';
  raw = raw.replace(/\s+/g, ' ');
  return raw.length > 68 ? raw.slice(0, 65) + '…' : raw;
}
function cwToolEventText(tool) {
  const name = String(tool?.name || 'tool'), input = tool?.input || {};
  const arg = cwToolArg(input);
  const head = arg ? `${name}(${arg})` : name;
  const oldText = input.old_string ?? input.oldText ?? input.old_content;
  const newText = input.new_string ?? input.newText ?? input.new_content;
  if (typeof oldText === 'string' || typeof newText === 'string') {
    const removed = String(oldText || '').split('\n').map(x => '- ' + x);
    const added = String(newText || '').split('\n').map(x => '+ ' + x);
    return `${head}\n${removed.concat(added).join('\n')}`;
  }
  const patch = input.patch ?? input.diff;
  if (typeof patch === 'string') return `${head}\n${patch}`;
  return `${head}\n${JSON.stringify(input, null, 2)}`;
}
// 展开状态按事件的时间戳记，cwRender 整块重刷 innerHTML 也不会丢。
const _cwOpenEvents = new Set();
function cwToggleEvent(key, el) {
  const box = el?.closest?.('.cw-event'); if (!box) return;
  // 直接切 class，不走 cwRender —— 重渲染会把 feed 滚到底，展开的东西当场跳走。
  if (box.classList.toggle('open')) _cwOpenEvents.add(key); else _cwOpenEvents.delete(key);
}
function cwEventSummary(kind, body) {
  const lines = body.split('\n');
  if (kind === 'tool' || kind === 'result') {
    const add = lines.filter(l => /^\+(?!\+\+)/.test(l)).length;
    const del = lines.filter(l => /^-(?!--)/.test(l)).length;
    if (add || del) return `+${add} -${del}`;
  }
  return `${lines.length} 行`;
}
function cwRenderEvent(e, idx = 0) {
  const kind = e.kind || 'status';
  const raw = String(e.text || '');
  const nl = raw.indexOf('\n');
  // 统一成「一行标题 + 折叠正文」：工具是 名字(参数)，思考是 Thinking…，其余取首行。
  const title = kind === 'thinking' ? 'Thinking…' : (nl < 0 ? raw : raw.slice(0, nl));
  const body = kind === 'thinking' ? raw : (nl < 0 ? '' : raw.slice(nl + 1));
  const mark = kind === 'thinking' ? '✻' : kind === 'result' ? '⎿' : kind === 'compact' ? '↯' : '⏺';
  const foldable = body.split('\n').length > 6 || body.length > 420;
  const key = `${e.at || 0}:${idx}`;
  const open = !foldable || _cwOpenEvents.has(key);
  const titleHtml = kind === 'tool'
    ? title.replace(/^([^(]*)(\([\s\S]*\))?$/, (_, n, a) => `<b>${escHtml(n)}</b>${a ? `<i>${escHtml(a)}</i>` : ''}`)
    : `<b>${escHtml(title)}</b>`;
  const bodyHtml = kind === 'tool' || kind === 'result' ? cwDiffLines(body) : escHtml(body);
  return `<div class="cw-event ${kind}${open ? ' open' : ''}${foldable ? ' foldable' : ''}">`
    + `<div class="cw-ev-head"><span class="cw-gutter">${mark}</span><span class="cw-ev-name">${titleHtml}</span></div>`
    + (body
      ? (foldable ? `<button class="cw-ev-sub" onclick="cwToggleEvent('${key}', this)">⎿ ${escHtml(cwEventSummary(kind, body))}<em></em></button>` : '')
        + `<pre class="cw-ev-body">${bodyHtml}</pre>`
      : '')
    + `</div>`;
}
// 压缩提示走和事件同一条渲染路径，才能拿到同样的 gutter 对齐和折叠行为。
// 之前这里是手写 HTML（裸 span + 裸 pre），改成 gutter 布局后那份手写标记就对不齐了。
function cwCompactBanner(s) {
  const summary = s && s.compactSummary;
  if (!summary) return '';
  const kept = (s.messages || []).length;
  const gone = s.compactedCount || 0;
  const when = s.compactedAt ? ` · ${new Date(s.compactedAt).toLocaleTimeString()}` : '';
  return cwRenderEvent({ at: 0, kind: 'compact', text: `已压缩${gone ? ` ${gone} 条` : ''}较早对话 · 保留最近 ${kept} 条原文${when}\n${summary}` });
}

function cwRender() {
  const p = cwProject(), s = cwSession();
  const projects = document.getElementById('cwProjects');
  if (!projects) return;
  const visibleProjects = (_cw.projects || []).filter(x => (x.provider || 'codex') === (_cw.activeProvider || 'codex'));
  projects.innerHTML = visibleProjects.map(x => `<button class="cw-project ${x.id === _cw.activeProjectId ? 'active' : ''}" onclick="cwSelectProject('${x.id}')"><b>${escHtml(x.name)}</b><small>${escHtml(x.cwd)}</small></button>`).join('') || '<div class="cw-empty">这个后端还没有项目目录</div>';
  const sessions = document.getElementById('cwSessions');
  if (_cwTrashOpen) {
    const items = (_cw.trash || []).filter(x => (x.project?.provider || 'codex') === (_cw.activeProvider || 'codex'));
    sessions.innerHTML = items.map(x => `<div class="cw-trash-item"><div><b>${escHtml(x.session?.title || '未命名会话')}</b><small>${escHtml(x.project?.name || '')} · ${new Date(x.deletedAt).toLocaleString()}</small></div><button onclick="cwRestoreSession('${x.id}')">恢复</button><button class="danger" onclick="cwDeleteTrashItem('${x.id}')">彻删</button></div>`).join('') || '<div class="cw-empty">回收站是空的</div>';
  } else {
    sessions.innerHTML = (p?.sessions || []).map(x => `<div class="cw-session-wrap ${x.id === _cw.activeSessionId ? 'active' : ''}"><button class="cw-session" onclick="cwSelectSession('${x.id}')"><span>${x.status === 'running' ? '●' : x.status === 'interrupted' ? '◐' : '○'}</span><div><b>${escHtml(x.title)}</b><small>${new Date(x.updatedAt).toLocaleString()}</small></div></button><button class="cw-session-rename" onclick="cwRenameSession('${x.id}')" title="修改标题">✎</button><button class="cw-session-delete" onclick="cwDeleteSession('${x.id}')" title="移入回收站">×</button></div>`).join('');
  }
  document.getElementById('cwTrashToggle')?.classList.toggle('active', _cwTrashOpen);
  const trashCount = document.getElementById('cwTrashCount'); if (trashCount) trashCount.textContent = (_cw.trash || []).filter(x => (x.project?.provider || 'codex') === (_cw.activeProvider || 'codex')).length || '';
  document.getElementById('cwEmptyTrash')?.classList.toggle('hidden', !_cwTrashOpen || !Number(trashCount?.textContent || 0));
  document.getElementById('cwProjectName').textContent = p?.name || '编程工作台';
  document.getElementById('cwCwd').textContent = p?.cwd || '没有项目';
  document.querySelectorAll('[data-cw-provider]').forEach(b => b.classList.toggle('active', b.dataset.cwProvider === (_cw.activeProvider || cwProvider(p))));
  const model = document.getElementById('cwModel');
  if (model) model.innerHTML = (CW_MODELS[cwProvider(p)] || []).map(([v, l]) => `<option value="${v}" ${cwModel(p) === v ? 'selected' : ''}>${l}</option>`).join('');
  const thinking = document.getElementById('cwThinking'); if (thinking) thinking.value = cwThinking(p);
  document.getElementById('cwTraceClaude')?.classList.toggle('active', _cwTraceProvider === 'claude');
  document.getElementById('cwTraceCodex')?.classList.toggle('active', _cwTraceProvider === 'codex');
  const context = document.getElementById('cwContext'); if (context) context.textContent = `≈ ${cwTokenEstimate(s).toLocaleString()} tokens`;
  const feed = document.getElementById('cwFeed');
  if (!s) feed.innerHTML = '<div class="cw-welcome"><b>这里保存真正的编程过程。</b><p>选一个项目，开一条任务。关机之后，对话、工具记录和中断位置都还在。</p></div>';
  else if (_cwUsagePanel) feed.innerHTML = cwUsageHtml(_cwUsagePanel);
  else if (_cwTraceProvider) {
    const items = [...(s.messages || []).filter(m => m.role === 'user' || m.provider === _cwTraceProvider).map(m => ({ ...m, _message: true })),
      ...(s.events || []).filter(e => !e.provider || e.provider === _cwTraceProvider)].sort((a, b) => (a.at || 0) - (b.at || 0));
    feed.innerHTML = `<div class="cw-trace-banner"><span>${_cwTraceProvider === 'claude' ? 'Ctrl+O · Claude Code' : 'Ctrl+T · Codex'} 完整链路：消息、思考、工具、结果按发生顺序展开</span><button class="cw-panel-close" onclick="cwCloseOverlay()" title="关闭（Esc）">✕</button></div>` + items.map(x => x._message ? cwRenderMessage(x) : cwRenderEvent(x)).join('');
  } else {
    // 默认视图 = 对话 + 会话级通知（/compact、/status、错误）。
    // tool/thinking 量太大会淹掉对话，留给 Ctrl+O / Ctrl+T 的完整链路视图。
    // 不显示 status 的话，斜杠命令敲下去毫无回音——看着像命令没生效。
    const notices = (s.events || []).filter(e => e.kind === 'status' || e.kind === 'error');
    const stream = [...(s.messages || []).map(m => ({ ...m, _message: true })), ...notices]
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    feed.innerHTML = cwCompactBanner(s)
      + stream.map(x => x._message ? cwRenderMessage(x) : cwRenderEvent(x)).join('')
      + (s.status === 'running' ? `<div class="cw-thinking-live" id="cwThinkingLive">${cwLiveThinkingText(s, p)}</div>` : '');
  }
  feed.scrollTop = feed.scrollHeight;
  const send = document.getElementById('cwSend'); if (send) { send.disabled = !s; send.textContent = s?.status === 'running' ? '排队' : '开始做'; }
  const stop = document.getElementById('cwStop'); if (stop) { stop.classList.toggle('hidden', s?.status !== 'running'); stop.disabled = !!s?.stopRequested; stop.textContent = s?.stopRequested ? '停止中…' : '停止'; }
  cwRenderAttachments();
}

function cwPushEvent(s, kind, text, provider) {
  if (!s) return;
  s.events = s.events || [];
  s.events.push({ at: Date.now(), kind, provider, text: String(text || '').slice(0, 8000) });
  s.updatedAt = Date.now(); cwScheduleSave();
  if (s.id === _cw.activeSessionId) cwRender();
}
function cwEvent(kind, text, provider = cwProvider()) { cwPushEvent(cwSession(), kind, text, provider); }

function cwFormatDuration(ms) {
  const sec = Math.max(0, Math.floor(Number(ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60), rest = sec % 60;
  if (min < 60) return `${min}m ${rest}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${min % 60}m`;
}
function cwThinkingLabel(p = cwProject()) { const labels = CW_THINK_LABELS[cwProvider(p)] || CW_THINK_LABELS.codex; return labels[_cwThinkStep % labels.length]; }
function cwLiveThinkingText(s = cwSession(), p = cwProject()) {
  const started = s?.runStartedAt || s?.turnStartedAt || Date.now();
  const label = s?.runId ? cwThinkingLabel(p) : '正在启动…';
  return `${label} · 已运行 ${cwFormatDuration(Date.now() - started)}`;
}
function cwTimingText(m, now = Date.now()) {
  const t = m?.timing; if (!t || m.role !== 'assistant') return '';
  const totalEnd = t.endedAt || now;
  const total = Math.max(0, totalEnd - (t.requestedAt || m.at || totalEnd));
  if (!t.endedAt) return `已运行 ${cwFormatDuration(total)}`;
  const parts = [];
  if (Number.isFinite(t.firstActionMs)) parts.push(`${t.firstActionKind === 'thinking' ? '思考约' : '首步'} ${cwFormatDuration(t.firstActionMs)}`);
  parts.push(`总用时 ${cwFormatDuration(total)}`);
  return parts.join(' · ');
}
function cwMarkFirstAction(s, answer, kind) {
  const t = answer?.timing; if (!t || Number.isFinite(t.firstActionMs)) return;
  const now = Date.now();
  t.firstActionAt = now; t.firstActionMs = Math.max(0, now - (t.runStartedAt || s?.runStartedAt || t.requestedAt || answer.at));
  t.firstActionKind = kind;
}
function cwFinishTiming(s, answer) {
  if (!answer?.timing || answer.timing.endedAt) return;
  answer.timing.endedAt = Date.now();
  if (s) { delete s.turnStartedAt; delete s.runStartedAt; }
}
function cwStartThinkingTicker() { clearInterval(_cwThinkTimer); _cwThinkStep = 0; _cwThinkTimer = setInterval(() => { _cwThinkStep++; const el = document.getElementById('cwThinkingLive'); if (el) el.textContent = cwLiveThinkingText(); }, 1000); }
function cwStopThinkingTicker() { clearInterval(_cwThinkTimer); _cwThinkTimer = null; }

async function cwSend() {
  const p = cwProject(), s = cwSession(), input = document.getElementById('cwInput');
  const text = input?.value.trim();
  if (!p || !s || (!text && !(_cwAttachments.get(s.id)?.length))) return;
  if (text.startsWith('/') && await cwExecuteCommand(text)) { input.value = ''; autoResize(input); return; }
  const images = _cwAttachments.get(s.id) || [];
  _cwAttachments.delete(s.id); cwRenderAttachments();
  input.value = ''; autoResize(input);
  if (s.status === 'running') {
    const queued = { id: cwId('m'), role: 'user', content: text || '请查看附图。', at: Date.now(), queued: true,
      attachments: images.map(x => ({ name: x.name, size: x.size })) };
    s.messages.push(queued);
    if (images.length) _cwAttachments.set(queued.id, images);
    s.updatedAt = Date.now(); cwScheduleSave(); cwRender();
    showToast('已追加：当前步骤结束后会在同一会话继续。', 'success');
    return;
  }
  return cwRunTurn(p, s, text || '请查看附图。', null, images);
}

async function cwRunTurn(p, s, text, queuedMessage = null, images = []) {
  // 同一个 renderer 内也先单飞。服务端还有 agentSub 锁，负责挡多窗口/重连竞态；
  // 这里挡双击、Enter 连发以及队列 finally 重入，避免先制造多份空 assistant 壳。
  if (_cwStreams.has(s.id)) {
    if (!queuedMessage && !(s.messages || []).some(m => m.role === 'user' && m.queued)) {
      const queued = { id: cwId('m'), role: 'user', content: text, at: Date.now(), queued: true,
        attachments: images.map(x => ({ name: x.name, size: x.size })) };
      s.messages.push(queued);
      if (images.length) _cwAttachments.set(queued.id, images);
      s.updatedAt = Date.now(); cwScheduleSave(); cwRender();
    }
    return;
  }
  delete s.stopRequested; delete s.stopDispatched;
  if (s.messages.length === 0) s.title = text.replace(/\s+/g, ' ').slice(0, 34);
  if (queuedMessage) delete queuedMessage.queued;
  else {
    queuedMessage = { id: cwId('m'), role: 'user', content: text, at: Date.now(),
      attachments: images.map(x => ({ name: x.name, size: x.size })) };
    s.messages.push(queuedMessage);
  }
  const answer = { id: cwId('m'), role: 'assistant', provider: p.provider, content: '', at: Date.now(), timing: { requestedAt: Date.now() } };
  s.messages.push(answer); s.status = 'running'; s.runId = ''; s.runEventIndex = 0;
  s.turnStartedAt = answer.timing.requestedAt; delete s.runStartedAt;
  s.activeAnswerId = answer.id; s.updatedAt = Date.now(); cwScheduleSave(); cwRender();
  const controller = new AbortController();
  const stream = { controller, provider: p.provider, starting: true, startTimer: null };
  _cwStreams.set(s.id, stream);
  stream.startTimer = setTimeout(() => {
    if (s.status !== 'running' || s.runId || _cwStreams.get(s.id) !== stream) return;
    s.startTimedOut = true;
    controller.abort();
  }, 45000);
  try {
    const endpoint = p.provider === 'claude' ? '/api/local-claude' : '/api/local-gpt';
    const apiMessages = s.messages.slice(0, -1).map(x => ({ role: x.role, content: x.content }));
    if (images.length && apiMessages.length) apiMessages[apiMessages.length - 1].images = images.map(x => x.url);
    const r = await fetch(SERVER_BASE + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ messages: apiMessages, systemPrompt: '你在持久化编程工作台里。直接检查并修改项目，持续汇报关键进展；不要只给建议。' + (s.compactSummary ? '\n\n较早对话的压缩摘要：\n' + s.compactSummary : ''), model: cwModel(p), agent: true, agentCwd: p.cwd, thinkingMode: cwThinking(p), agentSub: 'cw:' + s.id })
    });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    await cwReadRunStream(r, p, s, answer, controller);
  } catch (e) {
    if (s.stopRequested) {
      s.status = 'stopped'; cwPushEvent(s, 'status', '已停止这一轮。', p.provider);
    } else if (s.runId) {
      s.status = 'running'; cwPushEvent(s, 'status', '界面连接已脱离，任务仍在电脑后台运行；回来会自动接上。', p.provider);
      cwScheduleRecoverRuns();
    } else {
      s.status = 'interrupted';
      cwPushEvent(s, 'error', s.startTimedOut
        ? '任务启动超过 45 秒仍未拿到运行凭证，已取消这次空转；可以直接重发。'
        : '连接中断：' + e.message, p.provider);
    }
  } finally {
    if (s.status !== 'running') cwFinishTiming(s, answer);
    clearTimeout(stream.startTimer); delete s.startTimedOut;
    _cwStreams.delete(s.id); delete s.activeAnswerId; delete s.stopRequested; delete s.stopDispatched;
    s.updatedAt = Date.now(); cwScheduleSave(); if (s.id === _cw.activeSessionId) cwRender();
    const next = (s.messages || []).find(m => m.role === 'user' && m.queued);
    if (next && s.status !== 'running' && s.status !== 'stopped') {
      const queuedImages = _cwAttachments.get(next.id) || []; _cwAttachments.delete(next.id);
      setTimeout(() => cwRunTurn(p, s, next.content, next, queuedImages), 0);
    }
  }
}

async function cwReadRunStream(r, p, s, answer, controller) {
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', sawDone = false;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    buf += dec.decode(part.value, { stream: true }); let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const line = (raw.match(/^data:\s*(.*)$/m) || [])[1]; if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
       if (d.runId) { s.runId = d.runId; s.runStartedAt = s.runStartedAt || Date.now(); answer.timing = answer.timing || { requestedAt: answer.at || s.turnStartedAt || Date.now() }; answer.timing.runStartedAt = answer.timing.runStartedAt || s.runStartedAt; const stream = _cwStreams.get(s.id); if (stream) { stream.starting = false; clearTimeout(stream.startTimer); } s.runEventIndex = Math.max(s.runEventIndex || 0, Number(d.resumeFrom) || 0); cwScheduleSave(); if (s.stopRequested) cwDispatchStop(s); }
      else if (d.live) continue;   // 「正在写」草稿帧服务端不进缓冲，算进下标重连会漏事件；工作台也不画它
      else s.runEventIndex = (s.runEventIndex || 0) + 1;
      if (d.delta) { cwMarkFirstAction(s, answer, 'answer'); answer.content += d.delta; s.updatedAt = Date.now(); cwScheduleSave(); if (s.id === _cw.activeSessionId) cwRender(); }
      if (d.thinking) { cwMarkFirstAction(s, answer, 'thinking'); cwPushEvent(s, 'thinking', d.thinking, p.provider); }
      if (d.tool) { cwMarkFirstAction(s, answer, 'tool'); cwPushEvent(s, 'tool', cwToolEventText(d.tool), p.provider); }
      if (d.toolResult) cwPushEvent(s, d.toolResult.isError ? 'error' : 'result', d.toolResult.text, p.provider);
      if (d.notice) cwPushEvent(s, 'status', d.notice, p.provider);
      if (d.error) cwPushEvent(s, 'error', d.error, p.provider);
      if (d.usage) { s.lastUsage = d.usage; cwScheduleSave(); }
      if (d.done) { sawDone = true; s.status = s.stopRequested ? 'stopped' : 'idle'; cwFinishTiming(s, answer); }
    }
  }
  if (!sawDone && s.status === 'running') throw new Error('SSE 连接提前结束');
  if (sawDone) s.runId = '';
}

async function cwRecoverRuns() {
  let runs = [];
  try {
    const r = await fetch(SERVER_BASE + '/api/agent-runs');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    runs = (await r.json()).runs || [];
  } catch {
    // 服务端重启、Wi-Fi 抖动时清单请求本身也会失败；不能因为一次失败就永不再找。
    if ((_cw.projects || []).some(p => (p.sessions || []).some(s => s.status === 'running' && !_cwStreams.has(s.id)))) {
      cwScheduleRecoverRuns(2000);
    }
    return;
  }
  for (const p of _cw.projects || []) for (const s of p.sessions || []) {
    if (s.status !== 'running' || _cwStreams.has(s.id)) continue;
    const run = runs.find(x => x.subId === 'cw:' + s.id || (s.runId && x.id === s.runId));
    if (!run) {
      s.status = 'interrupted'; cwPushEvent(s, 'error', '后台任务已经不在运行列表里，可以从现有记录继续。', p.provider); continue;
    }
    s.runId = run.id;
    const answer = (s.messages || []).find(x => x.id === s.activeAnswerId)
      || [...(s.messages || [])].reverse().find(x => x.role === 'assistant')
      || { id: cwId('m'), role: 'assistant', provider: p.provider, content: '', at: Date.now() };
    if (!s.messages.includes(answer)) s.messages.push(answer);
    const controller = new AbortController(); _cwStreams.set(s.id, { controller, provider: p.provider });
    fetch(SERVER_BASE + '/api/agent-run/' + encodeURIComponent(run.id) + '?from=' + (s.runEventIndex || 0) + '&sub=' + encodeURIComponent('cw:' + s.id), { signal: controller.signal })
      .then(r => { if (!r.ok || !r.body) throw new Error('HTTP ' + r.status); return cwReadRunStream(r, p, s, answer, controller); })
      .catch(e => {
        if (!s.stopRequested) {
          s.status = 'running';
          cwPushEvent(s, 'status', '重挂连接暂时断开，后台任务没有被停止；正在继续重连：' + e.message, p.provider);
        }
      })
      .finally(() => {
        _cwStreams.delete(s.id); delete s.activeAnswerId; delete s.stopRequested; delete s.stopDispatched;
        s.updatedAt = Date.now(); cwScheduleSave(); if (s.id === _cw.activeSessionId) cwRender();
        if (s.status === 'running') cwScheduleRecoverRuns();
      });
  }
}

async function cwStop() {
  const s = cwSession(); if (!s || s.status !== 'running') return;
  s.stopRequested = true; cwScheduleSave(); cwRender();
  if (!s.runId) {
    s.status = 'stopped';
    _cwStreams.get(s.id)?.controller.abort();
    cwPushEvent(s, 'status', '已取消尚未完成的任务启动。', cwFindSession(s.id)?.p?.provider);
    cwScheduleSave(); cwRender();
    return;
  }
  cwDispatchStop(s);
}
async function cwDispatchStop(s) {
  if (!s?.runId || s.stopDispatched) return;
  s.stopDispatched = true;
  try {
    const r = await fetch(SERVER_BASE + '/api/agent-run/' + encodeURIComponent(s.runId) + '/stop', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    s.status = 'stopped'; _cwStreams.get(s.id)?.controller.abort(); cwScheduleSave(); cwRender();
  } catch (e) { delete s.stopDispatched; s.stopRequested = false; cwScheduleSave(); cwRender(); showToast('停止失败：' + e.message, 'error'); }
}
function cwOpenTerminal() { const p = cwProject(); openTerminal(); if (p && _termTab()) { _termTab().cwd = p.cwd; _termSave(); renderTerm(); } }

function cwChooseImages() { document.getElementById('cwImageInput')?.click(); }
function cwImagesChosen(input) { cwAddImageFiles(input?.files); if (input) input.value = ''; }
function cwAddImageFiles(files) {
  const s = cwSession(); if (!s) return;
  const list = _cwAttachments.get(s.id) || [];
  for (const file of [...(files || [])].filter(x => x.type?.startsWith('image/')).slice(0, Math.max(0, 6 - list.length))) {
    if (file.size > 10 * 1024 * 1024) { showToast(file.name + ' 超过 10 MB，没加进去。', 'error'); continue; }
    const reader = new FileReader();
    reader.onload = () => { list.push({ name: file.name || '粘贴的图片', size: file.size, url: reader.result }); _cwAttachments.set(s.id, list); cwRenderAttachments(); };
    reader.readAsDataURL(file);
  }
}
function cwRemoveImage(i) { const s = cwSession(); if (!s) return; const list = _cwAttachments.get(s.id) || []; list.splice(i, 1); if (list.length) _cwAttachments.set(s.id, list); else _cwAttachments.delete(s.id); cwRenderAttachments(); }
function cwRenderAttachments() {
  const el = document.getElementById('cwAttachments'), s = cwSession(); if (!el) return;
  const list = s ? (_cwAttachments.get(s.id) || []) : [];
  el.innerHTML = list.map((x, i) => `<div class="cw-attachment"><img src="${x.url}" alt=""><span>${escHtml(x.name)}</span><button onclick="cwRemoveImage(${i})" title="移除">×</button></div>`).join('');
  el.classList.toggle('hidden', !list.length);
}

// ── 把文件拖进工作台 = 拿到它在磁盘上的绝对路径 ──────────────────────────
//
// 支持直接拖动文件拿到路径。给编程 agent 派活的时候，
// **路径比内容有用**：它自己会 Read，贴内容既烧 token 又会在它改完之后立刻过时。
//
// ⚠️ 规则**故意只有一条、不按文件类型分叉**：拖进来的任何东西（图片、文件夹、
//   一次拖十个）统统贴路径。分叉写法（图片变附件、其余变路径）看着更聪明，
//   代价是她每次拖之前得先在脑子里判一次「这算图片吗」。图片想当图看的入口
//   一个没动：＋图片按钮、Ctrl+V 粘贴，都还在。
//   这里也不存在「改掉原来的东西」—— 工作台此前**根本没有 drop 处理器**，
//   往里拖文件的结果是整页被导航走（那个洞由 01-core.js 的兜底堵上）。
let _cwDragDepth = 0;

// 只认「真的在拖文件」。拖选中的文字、拖聊天里的链接也会触发 dragenter，
// 那些没有 Files，不该亮出放置提示。
function cwDragHasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }

// 绝对路径只能从 preload 拿（见 preload.js 里那段为什么）。这里再包一层 try：
// 手机/浏览器上 window.grancyanDesktop 压根不存在，不能让它把 drop 处理器炸掉。
function cwFilePath(file) {
  try { return window.grancyanDesktop?.filePathOf?.(file) || ''; } catch { return ''; }
}

// Windows 路径带空格的到处都是（C:\Program Files\…）。不加引号的话，贴进去看着是对的，
// 到了 agent 手里被拆成两个参数才错 —— 属于「贴对了、用起来才发现错」的那类坑。
function cwQuotePath(p) { return /[\s"]/.test(p) ? '"' + p.replace(/"/g, '\\"') + '"' : p; }

function cwInsertText(text) {
  const input = document.getElementById('cwInput'); if (!input) return;
  const at = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? at;
  const before = input.value.slice(0, at), after = input.value.slice(end);
  // 前后各补一个空格，但**不重复补**：连着拖三次不补会粘成一长串路径，无脑补则攒出一堆空格。
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  input.value = before + lead + text + tail + after;
  const caret = (before + lead + text).length;
  input.setSelectionRange(caret, caret); input.focus();
  // 只重排高度，**不走 cwInputChanged**：那个函数会顺手判「以 / 开头就弹命令菜单」，
  // 而路径本来就可能以 / 开头，拖一次弹一次命令菜单是纯干扰。
  autoResize(input);
}

function cwHandleDrop(e) {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (!cwSession()) { showToast('先选一条会话，再把文件拖进来。', 'error'); return; }
  if (!window.grancyanDesktop?.filePathOf) {
    // 手机和浏览器里**永远**拿不到电脑上的路径，这是浏览器安全模型，不是没做。
    // 明说，否则表现就是「拖了没反应」，她会以为是拖歪了，一直重试。
    showToast('浏览器和手机上拿不到电脑里的文件路径，这个只在桌面 exe 里能用。', 'error');
    return;
  }
  const paths = [], missed = [];
  for (const f of files) {
    const p = cwFilePath(f);
    if (p) paths.push(cwQuotePath(p)); else missed.push(f.name || '未命名文件');
  }
  if (paths.length) {
    cwInsertText(paths.join(' '));
    showToast(paths.length === 1 ? '路径贴进来了' : `${paths.length} 个路径贴进来了`);
  }
  // 空手而归**必须说出来**。getPathForFile 对「JS 造出来、背后没有磁盘文件」的 File
  // 返回空字符串（文档写着，不抛错），不吭声的话又是一次静默失败。
  if (missed.length) showToast(missed.join('、') + '：拿不到磁盘路径，没贴进去。', 'error');
}

function cwBindDropZone() {
  const zone = document.getElementById('codeWorkbenchModal');
  if (!zone || zone.dataset.dropBound) return;
  zone.dataset.dropBound = '1';
  zone.addEventListener('dragenter', e => {
    if (!cwDragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    _cwDragDepth++; zone.classList.add('cw-dragging');
  });
  zone.addEventListener('dragover', e => {
    if (!cwDragHasFiles(e)) return;
    // dragover 不 preventDefault 的话，这块区域根本不算「可放置」，drop 不会派发。
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', e => {
    if (!cwDragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    // ⚠️ dragleave 在**子元素之间移动时也会触发**。直接 remove 的话，拖着文件从侧栏
    //   划到输入框的一路上提示会疯狂闪。用进出计数配对，归零才算真的离开工作台。
    _cwDragDepth = Math.max(0, _cwDragDepth - 1);
    if (!_cwDragDepth) zone.classList.remove('cw-dragging');
  });
  zone.addEventListener('drop', e => {
    // 这里不判 cwDragHasFiles：工作台内部**任何**放下动作都要吃掉默认行为，
    // 否则漏掉的那一种就是整页被导航走。
    e.preventDefault(); e.stopPropagation();
    _cwDragDepth = 0; zone.classList.remove('cw-dragging');
    cwHandleDrop(e);
  });
}

function cwUsageHtml(data) {
  // 每个面板都必须自带 ✕ —— 它整块替换 feed，没有关闭键的话唯一出路是切会话，看着像卡死。
  const head = t => `<div class="cw-panel-head"><h4>${t}</h4><button class="cw-panel-close" onclick="cwCloseOverlay()" title="关闭（Esc）">✕</button></div>`;
  if (data?.type === 'help') return `<div class="cw-usage-panel">${head('命令与快捷键')}${CW_COMMANDS.map(x => `<div class="cw-help-row"><b>${x.name}</b><span>${x.desc}</span></div>`).join('')}<div class="cw-help-keys">Enter：发送　 Shift+Enter：换行　 Esc：关闭面板　 Ctrl+O：CC 完整链路　 Ctrl+T：Codex 完整链路　 Alt+P：模型　 Alt+T：思考</div></div>`;
  const usage = data?.lastUsage || {};
  // 开源版不查订阅额度（见 cwShowUsage），这里只放一句「去哪看」+ 本轮用量
  const quota = data?.quotaError ? `<div class="cw-usage-detail">${escHtml(data.quotaError)}</div>` : '';
  const turn = [usage.in != null && `输入 ${usage.in}`, usage.cached != null && `缓存 ${usage.cached}`, usage.out != null && `输出 ${usage.out}`, usage.reasoning != null && `思考 ${usage.reasoning}`].filter(Boolean).join(' · ');
  return `<div class="cw-usage-panel">${head(`${data?.provider === 'claude' ? 'Claude Code' : 'Codex'} · 用量`)}${quota}<div class="cw-usage-detail">${turn ? '最近一轮：' + turn + ' tokens<br>' : ''}当前上下文 ≈ ${(data?.tokens || 0).toLocaleString()} tokens（本地估算）<br>消息 ${data?.messages || 0} 条 · 工具/思考事件 ${data?.events || 0} 条</div></div>`;
}
// Esc 和 ✕ 的唯一出口。覆盖层是**分层**的，一次 Esc 只关最上面那层：
// 命令菜单 → 额度/帮助面板 → 完整链路 → 回收站。返回值表示「吃掉了这次 Esc 吗」，
// 调用方靠它决定要不要继续走「Esc 中断任务」——面板开着时那次 Esc 属于面板，不该停任务。
function cwCloseOverlay() {
  const menu = document.getElementById('cwCommandMenu');
  if (menu && !menu.classList.contains('hidden')) { cwHideCommandMenu(); return true; }
  if (_cwUsagePanel) { _cwUsagePanel = null; cwRender(); return true; }
  if (_cwTraceProvider) { _cwTraceProvider = ''; cwRender(); return true; }
  if (_cwTrashOpen) { _cwTrashOpen = false; cwRender(); return true; }
  return false;
}
async function cwShowUsage() {
  const s = cwSession(), provider = cwProvider(); if (!s) return;
  // 再点一次「额度」= 收起（跟 CC 链路 / Codex 链路两个按钮的 toggle 行为对齐）。
  // 从 /help 面板点过来则是切换内容，不是关闭。
  if (_cwUsagePanel && _cwUsagePanel.type !== 'help') { _cwUsagePanel = null; cwRender(); return; }
  // 开源版不查订阅额度（不读 Claude Code / Codex 的登录凭据、不打非公开接口），只给本轮用量；
  // 额度去各自的官方客户端里看
  const quotaError = provider === 'claude' ? '订阅额度请在 Claude Code 里用 /usage 查看' : '订阅额度请在 Codex 里用 /status 查看';
  _cwTraceProvider = ''; _cwUsagePanel = { provider, quotaError, tokens: cwTokenEstimate(s), messages: s.messages?.length || 0, events: s.events?.length || 0, lastUsage: s.lastUsage || null }; cwRender();
}
function cwToggleTrace(provider) { _cwUsagePanel = null; _cwTraceProvider = _cwTraceProvider === provider ? '' : provider; cwRender(); }
function cwHideCommandMenu() { document.getElementById('cwCommandMenu')?.classList.add('hidden'); }
function cwInputChanged(input) {
  autoResize(input); const q = input.value.trim().toLowerCase(), menu = document.getElementById('cwCommandMenu');
  if (!menu || !q.startsWith('/') || q.includes(' ')) return cwHideCommandMenu();
  const hits = CW_COMMANDS.filter(x => x.name.startsWith(q)); _cwCommandIndex = Math.min(_cwCommandIndex, Math.max(0, hits.length - 1));
  menu.innerHTML = hits.map((x, i) => `<button class="cw-command ${i === _cwCommandIndex ? 'active' : ''}" onmousedown="event.preventDefault();cwPickCommand('${x.name}')"><b>${x.name}</b><small>${x.desc}</small></button>`).join('');
  menu.classList.toggle('hidden', !hits.length);
}
function cwPickCommand(name) { const input = document.getElementById('cwInput'); if (!input) return; input.value = name + (['/rename', '/model'].includes(name) ? ' ' : ''); cwHideCommandMenu(); input.focus(); }
function cwInputKeydown(e) {
  const menu = document.getElementById('cwCommandMenu');
  if (!menu?.classList.contains('hidden') && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); _cwCommandIndex = Math.max(0, _cwCommandIndex + (e.key === 'ArrowDown' ? 1 : -1)); cwInputChanged(e.currentTarget); return; }
  if (!menu?.classList.contains('hidden') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); menu.querySelector('.cw-command.active')?.dispatchEvent(new MouseEvent('mousedown')); return; }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    // 分层：先关覆盖层（菜单/面板/链路/回收站），全都没开着才轮到中断任务。
    // 反过来的话，额度面板开着时按 Esc 会把正在跑的任务杀掉，而面板还杵在那儿。
    if (!cwCloseOverlay() && cwSession()?.status === 'running') cwStop();
    return;
  }
  // Enter 直接发送。
  // 下面四道闸**各自独立**，少任何一道都会在某个场景下把半截话甩给 agent。
  if (e.key !== 'Enter') return;
  // ① 输入法组合态：中文打字时按 Enter 是**上屏候选词**，不是发送。
  //   Chromium 桌面上组合中的 keydown 其实报 key='Process'，所以这条看着像多余 ——
  //   但那是实现细节、不是契约（Safari / Firefox / 安卓 WebView 各不相同），
  //   而且失效方向最坏：打到一半的中文被当成一条完整任务发出去，agent 立刻开始动手。
  //   isComposing 是标准里明写的判据；keyCode 229 是老 WebView 的兜底。
  if (e.isComposing || e.keyCode === 229) return;
  // ② Shift+Enter 换行。
  if (e.shiftKey) return;
  // ③ 手机上 Enter 是换行、发送靠按钮 —— 跟主聊天框同一份判据（isMobileComposer）。
  //   手机上要是 Enter 也发送，想写第二行就得先把第一行发出去，多行任务根本没法写。
  //   外接键盘的 Ctrl+Enter 不受这条影响，照样发。
  if (isMobileComposer() && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  cwSend();
}
async function cwExecuteCommand(raw) {
  const [cmd, ...rest] = raw.trim().split(/\s+/), arg = rest.join(' '), p = cwProject(), s = cwSession();
  if (!CW_COMMANDS.some(x => x.name === cmd)) return false;
  if (cmd === '/model') {
    if (arg) { const hit = (CW_MODELS[cwProvider(p)] || []).find(x => x[0] === arg || x[1].toLowerCase() === arg.toLowerCase()); if (!hit) showToast('这个模型不在当前后端列表里。', 'error'); else cwSetModel(hit[0]); }
    else document.getElementById('cwModel')?.focus();
  } else if (cmd === '/usage') cwShowUsage();
  else if (cmd === '/compact') {
    if (s?.status === 'running') showToast('这条任务还在跑，结束后再压缩。', 'info');
    else if (!s || (s.messages || []).length <= 6) showToast('对话还很短，不需要压缩。', 'info');
    else {
      const old = s.messages.slice(0, -6);
      s.compactSummary = old.map(x => `${x.role === 'user' ? '用户' : '助手'}：${x.content}`).join('\n').slice(-6000);
      s.compactedCount = (s.compactedCount || 0) + old.length;
      s.compactedAt = Date.now();
      s.messages = s.messages.slice(-6);
      s.events = (s.events || []).slice(-80);
      // 不再 push status 事件：压缩点在对话最上方，而事件带的是「现在」的时间戳，
      // 会被排到流的最底部，说的却是最早那段——顶部横幅才是它该在的位置。
      s.updatedAt = Date.now(); cwScheduleSave(); cwRender();
    }
  } else if (cmd === '/status') cwPushEvent(s, 'status', `${cwProvider(p)} · ${cwModel(p) || '默认模型'} · 思考 ${cwThinking(p)}\n${p.cwd}\n${s.status}${s.runId ? ' · run ' + s.runId : ''}`, p.provider);
  else if (cmd === '/thinking') { const modes = ['auto', 'always', 'off']; cwSetThinking(arg && modes.includes(arg) ? arg : modes[(modes.indexOf(cwThinking(p)) + 1) % modes.length]); }
  else if (cmd === '/provider') { const v = arg.toLowerCase(); cwSetProvider(v === 'codex' ? 'codex' : ['claude', 'cc'].includes(v) ? 'claude' : cwProvider(p) === 'codex' ? 'claude' : 'codex'); }
  else if (cmd === '/new') cwNewSession();
  else if (cmd === '/rename') { if (s && arg) { s.title = arg.slice(0, 60); cwScheduleSave(); cwRender(); } else showToast('用法：/rename 新名字', 'info'); }
  else if (cmd === '/clear') { const input = document.getElementById('cwInput'); if (input) input.value = ''; }
  else if (cmd === '/help') { _cwTraceProvider = ''; _cwUsagePanel = { type: 'help' }; cwRender(); }
  return true;
}

document.addEventListener('paste', e => {
  if (document.getElementById('codeWorkbenchModal')?.classList.contains('hidden')) return;
  const images = [...(e.clipboardData?.files || [])].filter(x => x.type?.startsWith('image/')); if (images.length) { e.preventDefault(); cwAddImageFiles(images); }
});
document.addEventListener('keydown', e => {
  if (document.getElementById('codeWorkbenchModal')?.classList.contains('hidden')) return;
  // 别人已经认领了这次按键（appPrompt 的 Esc = 取消重命名/删除），或者输入弹窗还开着：
  // 这次 Esc 不是给工作台的。以前冒泡到这里，取消个重命名就把正在跑的任务杀了。
  // appPrompt 在 textarea 上处理完就把弹窗藏了，所以只看「弹窗在不在」不够，defaultPrevented 才是主判据。
  if (e.defaultPrevented || document.getElementById('appPromptModal')?.style.display === 'block') return;
  if (e.key === 'Escape') { e.preventDefault(); if (!cwCloseOverlay() && cwSession()?.status === 'running') cwStop(); }
  else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); cwToggleTrace('claude'); }
  else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); cwToggleTrace('codex'); }
  else if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); document.getElementById('cwModel')?.focus(); }
  else if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); document.getElementById('cwThinking')?.focus(); }
});

async function cwInstallStaged() {
  const installDir = await appPrompt('当前版本目录\n也就是正在运行的 Grancyan.exe 所在文件夹（例如 <项目目录>\\dist\\Grancyan-win32-x64）。', ''); if (!installDir) return;
  const stagingDir = await appPrompt('新版本临时构建目录\n先让 Codex / Claude 运行 npm run pack:exe:alt；新版本通常会出现在 <项目目录>\\dist-new\\Grancyan-win32-x64。', ''); if (!stagingDir) return;
  const yes = await appPrompt('更新器会等你关闭 Grancyan，备份旧版本、换入新版本，再自动重开。\n输入“安装”继续。', '');
  if (String(yes || '').trim() !== '安装') return;
  try {
    const r = await fetch(SERVER_BASE + '/api/code-workbench/install-staged', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installDir, stagingDir, exeName: 'Grancyan.exe' }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); showToast(d.message, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
