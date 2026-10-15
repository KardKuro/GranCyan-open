// ============================================================
// 学习工具箱 ④：错题本
//
// 两个入口：
//   · 聊天里长按 / 右键一条消息 →「📕 错题本」：她发的题（文字 + 图）当题目，
//     AI 那条回复当解析。点的是 AI 的回复也行，题目往上找它回的那条。
//   · 面板里「＋ 新建」：拍照 / 选图 / 手打。
// 复习：先只看题、自己再做一遍，做完再点「看解析」；做对了往后排，没做对明天再来。
// 间隔 1 → 2 → 4 → 7 → 15 → 30 天，第六次做对算掌握（和单词卡的艾宾浩斯节点同一个思路）。
//
// 存在 state.mistakes（IndexedDB 的 kuro_mistakes，三道持久化白名单都登记过）。
// 图片存的是进输入框时已经缩到 768 长边的那份，一题一两百 KB。
// ============================================================

const MISTAKE_LADDER = [1, 2, 4, 7, 15, 30];      // 天
const MISTAKE_SUBJECTS = ['数学', '物理', '化学', '生物', '英语', '语文', '其他'];
const MISTAKE_WHY = ['审题不清', '概念没懂', '计算失误', '方法没想到', '粗心', '不会'];
const DAY_MS = 86400000;

function _mkList() {
  if (typeof state !== 'object' || !state) return [];
  if (!Array.isArray(state.mistakes)) state.mistakes = [];
  return state.mistakes;
}
function _mkEsc(s) {
  return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 按关键词猜科目。猜不出就「其他」，她在面板里一点就能改
function mistakeGuessSubject(text) {
  const s = String(text || '');
  if (/[a-zA-Z]{4,}.*[a-zA-Z]{4,}.*[a-zA-Z]{4,}/.test(s) && !/[=+\-*/^]|sin|cos|log/.test(s) && /[.,?!]/.test(s)) return '英语';
  if (/化学|摩尔|mol\b|溶液|离子|氧化|还原|方程式|元素|化合价|有机|酸|碱|盐|沉淀|电解/.test(s)) return '化学';
  if (/物理|速度|加速度|力|电场|磁场|电流|电压|电阻|动量|能量|功率|波|光|牛顿|重力|摩擦/.test(s)) return '物理';
  if (/细胞|基因|遗传|蛋白质|DNA|光合|呼吸作用|生态|酶/.test(s)) return '生物';
  if (/函数|方程|不等式|数列|三角|向量|概率|导数|几何|sin|cos|tan|log|\\frac|\^|√|∫|集合|椭圆|抛物线|双曲线/.test(s)) return '数学';
  if (/文言|作文|阅读|古诗|修辞|病句|成语/.test(s)) return '语文';
  return '其他';
}

// 下次复习时间。ok=true 往后排一格，ok=false 回到第一格（明天）
function mistakeSchedule(m, ok, now) {
  now = now || Date.now();
  if (ok) {
    m.step = (m.step || 0) + 1;
    if (m.step >= MISTAKE_LADDER.length) { m.mastered = now; m.due = 0; }
    else m.due = now + MISTAKE_LADDER[m.step] * DAY_MS;
  } else {
    m.step = 0;
    m.mastered = 0;
    m.due = now + MISTAKE_LADDER[0] * DAY_MS;
  }
  (m.log = m.log || []).push({ ts: now, ok: !!ok });
  return m;
}

function mistakeIsDue(m, now) {
  return !!m && !m.mastered && (m.due || 0) <= (now || Date.now());
}
function mistakeDueCount(now) {
  return _mkList().filter(m => mistakeIsDue(m, now)).length;
}

function mistakeAdd(fields, now) {
  now = now || Date.now();
  const q = String((fields && fields.q) || '').trim();
  const imgs = Array.isArray(fields && fields.imgs) ? fields.imgs.filter(u => typeof u === 'string' && /^data:image\//.test(u)).slice(0, 6) : [];
  if (!q && !imgs.length) return null;
  const m = {
    id: 'mk' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    at: now,
    subject: MISTAKE_SUBJECTS.includes(fields.subject) ? fields.subject : mistakeGuessSubject(q + ' ' + (fields.a || '')),
    q, imgs,
    a: String((fields && fields.a) || '').trim(),
    why: [], note: '',
    step: 0, due: now + MISTAKE_LADDER[0] * DAY_MS, mastered: 0, log: [],
    from: fields && fields.from ? String(fields.from) : ''
  };
  _mkList().unshift(m);
  try { save(); } catch (e) {}
  return m;
}

// 从聊天消息收进错题本。返回新建的那条（或 null）
function mistakeFromNode(nodeId) {
  const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
  const node = chat && chat.nodes ? chat.nodes[nodeId] : null;
  if (!node) return null;
  const textOf = n => (n && n.variants ? (n.variants[n.chosenVariant ?? 0] || {}).content || '' : (n && n.content) || '');
  let qNode, aNode;
  if (node.role === 'user') {
    qNode = node;
    // 解析：当前这条分支上紧跟着它的那条 AI 回复
    const path = typeof getMessagePath === 'function' ? getMessagePath(chat, chat.headId) : [];
    const i = path.findIndex(n => n && n.id === node.id);
    aNode = i >= 0 ? path.slice(i + 1).find(n => n && n.role === 'assistant') : null;
    if (!aNode) aNode = Object.values(chat.nodes).find(n => n && n.parentId === node.id && n.role === 'assistant') || null;
  } else {
    aNode = node;
    qNode = node.parentId != null ? chat.nodes[node.parentId] : null;
    if (qNode && qNode.role !== 'user') qNode = null;
  }
  const q = _mkStripTags(textOf(qNode));
  const imgs = (qNode && Array.isArray(qNode.images) ? qNode.images : []).map(x => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
  const a = _mkStripTags(textOf(aNode));
  return mistakeAdd({ q, imgs, a, from: chat.id + ':' + nodeId });
}

// 收进来的文字里去掉 App 自己的指令标签和卡片 HTML（错题本里只要题和讲解）
function _mkStripTags(s) {
  return String(s || '')
    .replace(/<div class="think-block[\s\S]*?<\/div><\/div>/g, '')
    .replace(/\[\[(?!PLOT|ELEM|MOL)[A-Z_]+(?::[^\]]*)?\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ctxAddMistake() {
  const id = typeof _ctxNodeId !== 'undefined' ? _ctxNodeId : null;   // 先抄下来：关菜单会把它清空
  if (typeof closeMsgContextMenu === 'function') closeMsgContextMenu();
  if (id == null) return;
  const m = mistakeFromNode(id);
  if (!m) { if (typeof showToast === 'function') showToast('这条收不进去（没有题目文字也没有图）', 'info', 2000); return; }
  if (typeof showToast === 'function') showToast('📕 收进错题本了（' + m.subject + '），明天提醒你再做一遍', 'success', 2600);
}

// ── 面板 ─────────────────────────────────────────────────────
let _mkFilter = 'due', _mkOpen = '', _mkShowAns = false, _mkNew = null;

function openMistakes(id) {
  const modal = document.getElementById('mistakeModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  _mkOpen = id || '';
  _mkShowAns = false;
  _mkNew = null;
  if (!id && !_mkList().some(m => mistakeIsDue(m))) _mkFilter = 'all';
  mistakeRender();
}
function closeMistakes() {
  const m = document.getElementById('mistakeModal');
  if (m) m.classList.add('hidden');
}
function mistakeSetFilter(f) { _mkFilter = String(f); _mkOpen = ''; mistakeRender(); }
function mistakeOpen(id) { _mkOpen = String(id); _mkShowAns = false; mistakeRender(); }
function mistakeBack() { _mkOpen = ''; _mkNew = null; mistakeRender(); }

function _mkWhen(m, now) {
  now = now || Date.now();
  if (m.mastered) return '已掌握';
  const d = Math.ceil(((m.due || 0) - now) / DAY_MS);
  if (d <= 0) return '今天该做';
  return d === 1 ? '明天' : d + ' 天后';
}

function mistakeRender() {
  const body = document.getElementById('mistakeBody');
  if (!body) return;
  if (_mkNew) { body.innerHTML = _mkNewForm(); return; }
  const list = _mkList();
  if (_mkOpen) {
    const m = list.find(x => x.id === _mkOpen);
    if (m) { body.innerHTML = _mkDetail(m); try { typesetMath(body); } catch (e) {} return; }
    _mkOpen = '';
  }
  const now = Date.now();
  const due = list.filter(m => mistakeIsDue(m, now)).length;
  const filters = [['due', '该做的 ' + due], ['all', '全部 ' + list.length]].concat(
    MISTAKE_SUBJECTS.filter(s => list.some(m => m.subject === s)).map(s => [s, s]));
  let h = '<div class="mk-bar">' + filters.map(([k, l]) => '<button type="button" class="mk-f' + (k === _mkFilter ? ' on' : '')
    + '" onclick="mistakeSetFilter(' + _mkEsc(JSON.stringify(k)) + ')">' + _mkEsc(l) + '</button>').join('')
    + '<button type="button" class="apply-btn mk-new" onclick="mistakeNew()">＋ 新建</button></div>';
  const shown = list.filter(m => _mkFilter === 'all' ? true : _mkFilter === 'due' ? mistakeIsDue(m, now) : m.subject === _mkFilter);
  if (!shown.length) {
    // 一道都没有时走公共空状态 .gc-empty（ui-polish A27）；只是筛选后空，还是一行小字
    h += list.length
      ? '<div class="chem-wait">' + (_mkFilter === 'due' ? '今天没有该做的错题了 ✓' : '这一栏是空的') + '</div>'
      : '<div class="gc-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24"><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z"/><path d="M6 3v18M10 8h5M10 12h5"/></svg></div>'
        + '<div class="gc-empty-title">还没有错题</div>'
        + '<div class="gc-empty-desc">聊天里长按（电脑上右键）一条消息，点「📕 错题本」就能收进来；也可以点上面的「＋ 新建」拍一道。</div></div>';
  } else {
    h += '<div class="mk-list">' + shown.map(m => '<button type="button" class="mk-item' + (mistakeIsDue(m, now) ? ' due' : '') + (m.mastered ? ' done' : '')
      + '" onclick="mistakeOpen(' + _mkEsc(JSON.stringify(m.id)) + ')">'
      + (m.imgs && m.imgs[0] ? '<img class="mk-thumb" src="' + _mkEsc(m.imgs[0]) + '" alt="">' : '<span class="mk-thumb mk-thumb-txt">' + _mkEsc(m.subject.slice(0, 1)) + '</span>')
      + '<span class="mk-item-txt"><b>' + _mkEsc((m.q || '（只有图）').replace(/\s+/g, ' ').slice(0, 60)) + '</b>'
      + '<small><i class="mk-sub">' + _mkEsc(m.subject) + '</i>' + (m.why && m.why.length ? ' · ' + _mkEsc(m.why.join('、')) : '') + ' · ' + _mkWhen(m, now) + '</small></span></button>').join('') + '</div>';
  }
  body.innerHTML = h;
}

function _mkDetail(m) {
  const rich = s => (typeof renderRichText === 'function' ? renderRichText(s) : _mkEsc(s).replace(/\n/g, '<br>'));
  let h = '<div class="mk-detail"><div class="mk-dhead"><button type="button" class="mk-back" onclick="mistakeBack()">‹ 返回</button>'
    + '<select class="pt-mode" onchange="mistakeSetField(' + _mkEsc(JSON.stringify(m.id)) + ',\'subject\',this.value)">'
    + MISTAKE_SUBJECTS.map(s => '<option' + (s === m.subject ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>'
    + '<span class="mk-when">' + _mkWhen(m) + ' · 做对 ' + (m.log || []).filter(x => x.ok).length + ' 次</span></div>';
  h += '<div class="mk-q">' + (m.q ? '<div class="mk-qtxt">' + rich(m.q) + '</div>' : '')
    + (m.imgs || []).map(u => '<img class="mk-img" src="' + _mkEsc(u) + '" alt="题目图片" onclick="showMistakeImg(this)">').join('') + '</div>';
  h += '<div class="mk-why"><span>错在哪：</span>' + MISTAKE_WHY.map(w => '<button type="button" class="mk-f' + ((m.why || []).includes(w) ? ' on' : '')
    + '" onclick="mistakeToggleWhy(' + _mkEsc(JSON.stringify(m.id)) + ',' + _mkEsc(JSON.stringify(w)) + ')">' + w + '</button>').join('') + '</div>';
  h += '<textarea class="mk-note" placeholder="自己的笔记：这题的坑在哪、下次怎么想到……" onchange="mistakeSetField(' + _mkEsc(JSON.stringify(m.id)) + ',\'note\',this.value)">' + _mkEsc(m.note || '') + '</textarea>';
  if (m.a) {
    h += _mkShowAns
      ? '<div class="mk-ans"><div class="mk-ans-t">解析</div>' + rich(m.a) + '</div>'
      : '<button type="button" class="mk-reveal" onclick="mistakeReveal()">先自己再做一遍，做完了点这里看解析</button>';
  }
  h += '<div class="mk-actions"><button type="button" class="apply-btn mk-ok" onclick="mistakeGrade(' + _mkEsc(JSON.stringify(m.id)) + ',1)">✓ 这次做对了</button>'
    + '<button type="button" class="apply-btn mk-bad" onclick="mistakeGrade(' + _mkEsc(JSON.stringify(m.id)) + ',0)">✗ 还是不会</button>'
    + '<button type="button" class="apply-btn" onclick="mistakeAskAi(' + _mkEsc(JSON.stringify(m.id)) + ')">问 AI</button>'
    + '<button type="button" class="mk-del" onclick="mistakeDrop(' + _mkEsc(JSON.stringify(m.id)) + ')">删掉</button></div></div>';
  return h;
}

function mistakeReveal() { _mkShowAns = true; mistakeRender(); }

function mistakeSetField(id, key, val) {
  const m = _mkList().find(x => x.id === id);
  if (!m || !['subject', 'note'].includes(key)) return;
  m[key] = key === 'subject' ? (MISTAKE_SUBJECTS.includes(val) ? val : m.subject) : String(val || '').slice(0, 4000);
  try { save(); } catch (e) {}
}
function mistakeToggleWhy(id, w) {
  const m = _mkList().find(x => x.id === id);
  if (!m || !MISTAKE_WHY.includes(w)) return;
  m.why = m.why || [];
  const i = m.why.indexOf(w);
  if (i >= 0) m.why.splice(i, 1); else m.why.push(w);
  try { save(); } catch (e) {}
  mistakeRender();
}
function mistakeGrade(id, ok) {
  const m = _mkList().find(x => x.id === id);
  if (!m) return;
  mistakeSchedule(m, !!ok);
  try { save(); } catch (e) {}
  if (typeof showToast === 'function') showToast(m.mastered ? '掌握了 ✓ 这题不会再排进复习' : ok ? '做对了，' + _mkWhen(m) + '再来' : '没关系，明天再做一遍', 'success', 1800);
  // 做完一题自动去下一道该做的
  const next = _mkList().find(x => x.id !== id && mistakeIsDue(x));
  _mkOpen = next ? next.id : '';
  _mkShowAns = false;
  mistakeRender();
}
// 叫 drop 不叫 delete：渲染消毒会拔掉 onclick 里 delete*/remove* 开头的函数
// （面板不走消毒，但别在这儿开个会被误伤的名字）
function mistakeDrop(id) {
  if (typeof confirm === 'function' && !confirm('删掉这道错题？')) return;
  const L = _mkList();
  const i = L.findIndex(x => x.id === id);
  if (i >= 0) L.splice(i, 1);
  try { save(); } catch (e) {}
  _mkOpen = '';
  mistakeRender();
}
function showMistakeImg(img) {
  const lb = document.getElementById('imgLightbox'), li = document.getElementById('lightboxImg');
  if (!lb || !li || !img) return;
  li.src = img.src;
  lb.classList.remove('hidden');
}

// 问 AI：题目图片塞进输入框的附件，文字填进去；不替她发
function mistakeAskAi(id) {
  const m = _mkList().find(x => x.id === id);
  if (!m) return;
  if (typeof addPendingImg === 'function') for (const u of (m.imgs || [])) addPendingImg({ url: u, name: 'mistake.jpg' });
  const input = document.getElementById('userInput');
  if (input) {
    input.value = '这道' + m.subject + '题我之前做错了' + ((m.why || []).length ? '（' + m.why.join('、') + '）' : '') + '，帮我再讲一遍思路：\n' + (m.q || '');
    try { autoResize(input); } catch (e) {}
    try { updateComposerBtns(); } catch (e) {}
    input.focus();
  }
  closeMistakes();
}

// ── 新建 ──
function mistakeNew() { _mkNew = { subject: '', q: '', a: '', imgs: [] }; mistakeRender(); }
function _mkNewForm() {
  const n = _mkNew;
  return '<div class="mk-detail"><div class="mk-dhead"><button type="button" class="mk-back" onclick="mistakeBack()">‹ 返回</button><b>新建一道错题</b></div>'
    + '<select id="mkNewSub" class="pt-mode"><option value="">科目（不选就自动猜）</option>' + MISTAKE_SUBJECTS.map(s => '<option' + (s === n.subject ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>'
    + '<div class="mk-imgs">' + n.imgs.map((u, i) => '<span class="mk-img-wrap"><img class="mk-img" src="' + _mkEsc(u) + '"><button type="button" onclick="mistakeNewDropImg(' + i + ')">✕</button></span>').join('')
    + '<label class="mk-add-img">📷 加图<input type="file" accept="image/*" multiple style="display:none" onchange="mistakeNewPick(this)"></label></div>'
    + '<textarea id="mkNewQ" class="mk-note" rows="4" placeholder="题目（有图可以不写，或者写一句题干要点）">' + _mkEsc(n.q) + '</textarea>'
    + '<textarea id="mkNewA" class="mk-note" rows="4" placeholder="正确答案 / 解析（可以先空着，之后问 AI）">' + _mkEsc(n.a) + '</textarea>'
    + '<div class="mk-actions"><button type="button" class="apply-btn mk-ok" onclick="mistakeNewSave()">收进错题本</button></div></div>';
}
function _mkNewSync() {
  if (!_mkNew) return;
  const q = document.getElementById('mkNewQ'), a = document.getElementById('mkNewA'), s = document.getElementById('mkNewSub');
  if (q) _mkNew.q = q.value;
  if (a) _mkNew.a = a.value;
  if (s) _mkNew.subject = s.value;
}
function mistakeNewPick(input) {
  _mkNewSync();
  const files = Array.from((input && input.files) || []).slice(0, 6);
  Promise.all(files.map(f => new Promise(res => {
    const r = new FileReader();
    r.onload = e => {
      const url = e.target.result;
      // 和聊天附件同一道缩图（768 长边）：错题本常年存着，原图会把 IndexedDB 撑得很胖
      if (typeof shrinkImgForApi === 'function') shrinkImgForApi(url).then(x => res(x.url)).catch(() => res(url));
      else res(url);
    };
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  }))).then(urls => {
    if (!_mkNew) return;
    _mkNew.imgs = _mkNew.imgs.concat(urls.filter(Boolean)).slice(0, 6);
    mistakeRender();
  });
}
function mistakeNewDropImg(i) { _mkNewSync(); if (_mkNew) _mkNew.imgs.splice(i, 1); mistakeRender(); }
function mistakeNewSave() {
  _mkNewSync();
  const n = _mkNew;
  if (!n) return;
  const m = mistakeAdd({ q: n.q, a: n.a, imgs: n.imgs, subject: n.subject });
  if (!m) { if (typeof showToast === 'function') showToast('题目和图片至少要有一个', 'info', 1800); return; }
  _mkNew = null;
  _mkOpen = '';
  _mkFilter = 'all';
  if (typeof showToast === 'function') showToast('📕 收好了（' + m.subject + '）', 'success', 1600);
  mistakeRender();
}
