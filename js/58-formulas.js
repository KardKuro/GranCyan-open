// ============================================================
// 学习工具箱 ⑤：公式卡（数学公式 / 物理公式 / 化学方程式）+ 聊天里的 [[FCARD: 正面 | 背面]]
//
// 内置卡组在 js/labdata/formulas.js（手写，第一次打开才加载）；她自己加的卡、每张卡的进度
// 存在 state.fcards = { prog: { id: {step, due, n} }, custom: [{id, deck:'我的', front, back}] }
// （IndexedDB 的 kuro_fcards，三道持久化白名单都登记过）。
// 复习节奏和错题本同一套阶梯（1/2/4/7/15/30 天，MISTAKE_LADDER）：会 → 往后排；模糊 → 明天；不会 → 回到第一格。
//
// 聊天里：AI 讲到一条值得记的公式时写 [[FCARD: 正面 | 背面]]，气泡里是一张能翻的卡，
// 她点「＋ 收进公式卡」才真的加进去 —— 加不加是她的事，所以副作用挂在她的点击上，不在渲染里。
// ============================================================

const FCARD_DECKS = ['数学', '物理', '化学', '我的'];
const FCARD_NEW_PER_ROUND = 10;

const fcardLoadData = () => (typeof _chemScript === 'function'
  ? _chemScript('./js/labdata/formulas.js', () => typeof LAB_FORMULAS !== 'undefined')
  : Promise.resolve());

function _fcState() {
  if (typeof state !== 'object' || !state) return { prog: {}, custom: [] };
  if (!state.fcards || typeof state.fcards !== 'object' || Array.isArray(state.fcards)) state.fcards = {};
  const f = state.fcards;
  if (!f.prog || typeof f.prog !== 'object') f.prog = {};
  if (!Array.isArray(f.custom)) f.custom = [];
  return f;
}
function _fcEsc(s) {
  return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fcardAll() {
  const base = typeof LAB_FORMULAS !== 'undefined' ? LAB_FORMULAS : [];
  return base.concat(_fcState().custom);
}

// LaTeX 里的汉字（化学方程式的「浓」「高温」「催化剂」）包进 \text{}：
// KaTeX 在数学模式里遇到汉字会一张卡报一串 warning，严格模式下还会画成红字。
// 已经在 \text{…} 里的不重复包。
function fcardTex(s) {
  return String(s || '').replace(/\$([^$]+)\$/g, (m, tex) => {
    // 已有的 \text{…} 整段先抠走，处理完再放回 —— 不然里面的汉字会被再包一层
    const keep = [];
    let t = tex.replace(/\\text\{[^}]*\}/g, x => { keep.push(x); return '\u0000' + (keep.length - 1) + '\u0000'; });
    t = t.replace(/[一-鿿（）]+/g, run => '\\text{' + run + '}');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
    return '$' + t + '$';
  });
}

function _fcRich(s) {
  const tex = fcardTex(s);
  return typeof renderRichText === 'function' ? renderRichText(tex) : _fcEsc(tex);
}

// 复习节奏：沿用错题本那套阶梯
function fcardGrade(id, grade, now) {
  now = now || Date.now();
  const L = typeof MISTAKE_LADDER !== 'undefined' ? MISTAKE_LADDER : [1, 2, 4, 7, 15, 30];
  const DAY = 86400000;
  const p = _fcState().prog[id] || { step: -1, due: 0, n: 0 };     // 新卡 step = -1，第一次「会」落到第一格
  if (grade === 2) {                       // 会：往后排一格
    p.step = Math.min(p.step + 1, L.length - 1);
    p.due = now + L[p.step] * DAY;
  } else {                                 // 模糊：原地不动、明天再见；不会：回到第一格、明天再见
    p.step = grade === 0 ? 0 : Math.max(0, p.step);
    p.due = now + DAY;
  }
  p.n = (p.n || 0) + 1;
  p.last = now;
  _fcState().prog[id] = p;
  try { save(); } catch (e) {}
  return p;
}

// 这一轮要刷的：先到期的（按到期早晚），再补几张没见过的
function fcardQueue(deck, now) {
  now = now || Date.now();
  const prog = _fcState().prog;
  const cards = fcardAll().filter(c => !deck || c.deck === deck);
  const due = cards.filter(c => prog[c.id] && prog[c.id].due <= now).sort((a, b) => prog[a.id].due - prog[b.id].due);
  const fresh = cards.filter(c => !prog[c.id]).slice(0, FCARD_NEW_PER_ROUND);
  return due.concat(fresh);
}

// ── 面板 ─────────────────────────────────────────────────────
let _fcDeck = '数学', _fcMode = 'review', _fcQueue = [], _fcFlip = false, _fcDone = 0;

function openFormulas(deck) {
  const modal = document.getElementById('formulaModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (FCARD_DECKS.includes(deck)) _fcDeck = deck;
  const body = document.getElementById('formulaBody');
  if (body && !body.innerHTML) body.innerHTML = '<div class="chem-wait">加载中…</div>';
  fcardLoadData().then(() => { fcardStart(); }).catch(e => { if (body) body.innerHTML = '<div class="chem-wait">' + _fcEsc(e.message) + '</div>'; });
}
function closeFormulas() {
  const m = document.getElementById('formulaModal');
  if (m) m.classList.add('hidden');
}
function fcardSetDeck(d) { if (FCARD_DECKS.includes(d)) { _fcDeck = d; fcardStart(); } }
function fcardSetMode(m) { _fcMode = m === 'sheet' ? 'sheet' : m === 'add' ? 'add' : 'review'; fcardStart(); }
function fcardStart() {
  _fcQueue = fcardQueue(_fcDeck);
  _fcFlip = false;
  _fcDone = 0;
  fcardRender();
}
function fcardFlip() { _fcFlip = true; fcardRender(); }
function fcardAnswer(g) {
  const c = _fcQueue[0];
  if (!c) return;
  fcardGrade(c.id, Number(g));
  _fcQueue.shift();
  // 不会的这一轮末尾再见一次（只再见一次，不然一张卡能卡住整轮）
  if (Number(g) === 0 && !c._again) _fcQueue.push(Object.assign({}, c, { _again: true }));
  _fcDone++;
  _fcFlip = false;
  fcardRender();
}

function fcardRender() {
  const body = document.getElementById('formulaBody');
  if (!body) return;
  const all = fcardAll();
  const prog = _fcState().prog, now = Date.now();
  let h = '<div class="mk-bar">' + FCARD_DECKS.map(d => {
    const n = all.filter(c => c.deck === d).length;
    const due = all.filter(c => c.deck === d && prog[c.id] && prog[c.id].due <= now).length;
    return '<button type="button" class="mk-f' + (d === _fcDeck ? ' on' : '') + '" onclick="fcardSetDeck(' + _fcEsc(JSON.stringify(d)) + ')">' + d + ' ' + n + (due ? ' · ' + due + ' 到期' : '') + '</button>';
  }).join('')
    + '<span class="fc-modes">' + [['review', '刷卡'], ['sheet', '公式表'], ['add', '＋ 加一张']].map(([k, l]) =>
      '<button type="button" class="mk-f' + (k === _fcMode ? ' on' : '') + '" onclick="fcardSetMode(\'' + k + '\')">' + l + '</button>').join('') + '</span></div>';

  if (_fcMode === 'sheet') {
    const cards = all.filter(c => c.deck === _fcDeck);
    h += cards.length ? '<div class="fc-sheet">' + cards.map(c => '<div class="fc-row"><div class="fc-row-f">' + _fcEsc(c.front) + '</div><div class="fc-row-b">'
      + _fcRich(c.back) + (c.note ? '<div class="fc-note">' + _fcEsc(c.note) + '</div>' : '') + '</div>'
      + (c.deck === '我的' ? '<button type="button" class="mk-del" onclick="fcardDropCustom(' + _fcEsc(JSON.stringify(c.id)) + ')">删掉</button>' : '') + '</div>').join('') + '</div>'
      : '<div class="gc-empty"><div class="gc-empty-icon"><svg viewBox="0 0 24 24"><path d="M17 4H7l6 8-6 8h10"/></svg></div>'
        + '<div class="gc-empty-title">「我的」还是空的</div>'
        + '<div class="gc-empty-desc">聊天里 AI 递的公式卡点「＋ 收进公式卡」，或者上面「＋ 加一张」。</div></div>';
  } else if (_fcMode === 'add') {
    h += '<div class="mk-detail"><select id="fcNewDeck" class="pt-mode">' + FCARD_DECKS.map(d => '<option' + (d === '我的' ? ' selected' : '') + '>' + d + '</option>').join('') + '</select>'
      + '<input id="fcNewFront" class="pt-search fc-in" placeholder="正面：公式叫什么（比如「动能定理」）">'
      + '<textarea id="fcNewBack" class="mk-note" rows="3" placeholder="背面：公式本身。数学式用 $…$ 包起来，比如 $W_{合}=\\Delta E_k$"></textarea>'
      + '<div class="mk-actions"><button type="button" class="apply-btn mk-ok" onclick="fcardSaveNew()">加进去</button></div></div>';
  } else {
    const c = _fcQueue[0];
    if (!c) {
      h += '<div class="chem-wait">' + (_fcDone ? '这一轮刷完了 ✓ 刷了 ' + _fcDone + ' 张' : '「' + _fcDeck + '」现在没有到期的卡了') + '<br><small>想再看看可以切到「公式表」</small></div>';
    } else {
      const p = prog[c.id];
      h += '<div class="fc-stage"><div class="fc-meta">' + (c._again ? '再来一次' : p ? '复习' : '新卡') + ' · 这一轮还剩 ' + _fcQueue.length + ' 张</div>'
        + '<div class="fc-card' + (_fcFlip ? ' flipped' : '') + '"' + (_fcFlip ? '' : ' onclick="fcardFlip()"') + '>'
        + '<div class="fc-front">' + _fcEsc(c.front) + '</div>'
        + (_fcFlip ? '<div class="fc-back">' + _fcRich(c.back) + (c.note ? '<div class="fc-note">' + _fcEsc(c.note) + '</div>' : '') + '</div>' : '<div class="fc-hint">先在心里默一遍，点一下翻面</div>')
        + '</div>'
        + (_fcFlip ? '<div class="fc-grade"><button type="button" class="apply-btn mk-bad" onclick="fcardAnswer(0)">不会</button>'
          + '<button type="button" class="apply-btn" onclick="fcardAnswer(1)">模糊</button>'
          + '<button type="button" class="apply-btn mk-ok" onclick="fcardAnswer(2)">会</button></div>' : '')
        + '</div>';
    }
  }
  body.innerHTML = h;
  try { typesetMath(body); } catch (e) {}
}

function fcardSaveNew() {
  const f = document.getElementById('fcNewFront'), b = document.getElementById('fcNewBack'), d = document.getElementById('fcNewDeck');
  const card = fcardAddCustom(f && f.value, b && b.value, d && d.value);
  if (!card) { if (typeof showToast === 'function') showToast('正面和背面都要写', 'info', 1600); return; }
  if (typeof showToast === 'function') showToast('加好了', 'success', 1200);
  _fcDeck = card.deck;
  _fcMode = 'sheet';
  fcardStart();
}

function fcardAddCustom(front, back, deck) {
  const fr = String(front || '').trim().slice(0, 80), bk = String(back || '').trim().slice(0, 1200);
  if (!fr || !bk) return null;
  const st = _fcState();
  // 同样的正面反面已经收过了就别再收一张
  const dup = st.custom.find(c => c.front === fr && c.back === bk);
  if (dup) return dup;
  const card = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), deck: FCARD_DECKS.includes(deck) ? deck : '我的', front: fr, back: bk };
  st.custom.push(card);
  try { save(); } catch (e) {}
  return card;
}
function fcardDropCustom(id) {
  const st = _fcState();
  const i = st.custom.findIndex(c => c.id === id);
  if (i < 0) return;
  if (typeof confirm === 'function' && !confirm('删掉这张卡？')) return;
  st.custom.splice(i, 1);
  delete st.prog[id];
  try { save(); } catch (e) {}
  fcardRender();
}

// ── 聊天里：[[FCARD: 正面 | 背面]] ──
// 正面不许有竖线；背面到 ]] 为止（LaTeX 里的 | 绝对值会写在背面，所以只按第一个竖线切）
function fcardTagRe() { return /\[\[FCARD:\s*([^\]|]{1,80}?)\s*\|\s*([\s\S]{1,1200}?)\s*\]\]/g; }

function fcardTagToHtml(text) {
  if (!text || text.indexOf('[[FCARD') < 0) return text;
  return String(text).replace(fcardTagRe(), (m, front, back) => {
    const tex = fcardTex(back);
    // 背面原样塞进 data 属性（点收藏时读），显示用的那份留给外层 renderRichText 排版 —— 这里在它的
    // stickerTagToHtml 阶段，公式早已被抠成占位符，所以直接把 $…$ 放进 HTML 里，等 typesetMath 排
    return '\n\n<div class="fc-chat" data-front="' + _fcEsc(front) + '" data-back="' + _fcEsc(back).replace(/\n/g, '&#10;') + '">'
      + '<div class="fc-chat-f">📐 ' + _fcEsc(front) + '</div><div class="fc-chat-b">' + _fcEsc(tex).replace(/\n/g, '<br>') + '</div>'
      + '<button type="button" class="fc-chat-add" onclick="fcardAddFromChat(this)">＋ 收进公式卡</button></div>\n\n';
  });
}

function fcardAddFromChat(btn) {
  const box = btn && btn.closest ? btn.closest('.fc-chat') : null;
  if (!box) return;
  const card = fcardAddCustom(box.getAttribute('data-front'), box.getAttribute('data-back'), '我的');
  if (!card) return;
  btn.textContent = '✓ 收好了';
  btn.disabled = true;
  if (typeof showToast === 'function') showToast('收进公式卡「我的」了', 'success', 1400);
}

function maskStreamingFcard(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return String(text).replace(fcardTagRe(), '〔📐〕').replace(/\[\[FCARD\b[^\]]*$/, '〔…〕');
}
