// ═══════════════════════════════════════════════════════
// 多选：模型 / 分组「一次挑好几个再一起收进新分组」，
//       外加把桌面端**所有**多选场景统一到「Ctrl + 左键」这一个手势。
//
// 两件事写在一个文件里，是因为它们共用同一套东西：一张「哪些元素能多选」的注册表
// （下面的 MSEL_ZONES）。分开写的话，Ctrl 那条逻辑要在四个文件里各抄一遍。
//
// ── 为什么选中状态不进 state ──
// 这是**纯 UI 的瞬时选择**，跟折叠状态一样，刷新就该没了。进了 state 就要过
// 持久化三道白名单（_doSave / loadStateFromDB / 启动赋值块），漏一道刷新即失且零报错；
// 而且「上次关页面时选中了哪三个模型」恢复出来纯属添乱。所以就是俩模块级 Set。
//
// ── 为什么模型存 id、分组存 path ──
// 选中期间可以删模型（卡片上的 ✕ 还在），删完后面的**索引全部前移一位**，
// 存索引的话选中集合会静默指向别的模型 —— 这类错不会报，只会某天把错的模型收进组里。
// 分组没有稳定 id，只能存 path，所以每次用之前都要拿 modelGroupPaths() 滤一遍死路径。
// ═══════════════════════════════════════════════════════

const _mselModels = new Set();   // config.id
const _mselGroups = new Set();   // 分组 path

function _mselCount() { return _mselModels.size + _mselGroups.size; }
function _mselOn() { return _mselCount() > 0; }

/* 选中集合里可能躺着已经不存在的东西：模型被 ✕ 掉、分组被解散/改名。
   每次读之前先对着现状滤一遍 —— 不滤的话「已选 3 项」里有两个是幽灵，
   点建组时它们静默消失，人只会看到「怎么只进去一个」。 */
function _mselPrune() {
  const ids = new Set(state.configs.map(c => c.id));
  [..._mselModels].forEach(id => { if (!ids.has(id)) _mselModels.delete(id); });
  const paths = modelGroupPaths();
  [..._mselGroups].forEach(p => { if (!paths.includes(p)) _mselGroups.delete(p); });
}

function _mselClear() {
  if (!_mselOn()) return;
  _mselModels.clear(); _mselGroups.clear();
  renderConfigs();
}

function toggleMselModel(id) {
  if (_mselModels.has(id)) _mselModels.delete(id); else _mselModels.add(id);
  renderConfigs();
}
function toggleMselGroup(path) {
  path = mgNorm(path);
  if (!path) return;                       // 「未分组」不是一个真分组，收不进别的组里
  if (_mselGroups.has(path)) _mselGroups.delete(path); else _mselGroups.add(path);
  renderConfigs();
}

// 选中态问询 —— 渲染那边用
function _mselHasModel(id) { return _mselModels.has(id); }
function _mselHasGroup(p) { return _mselGroups.has(mgNorm(p)); }

/* 全选 / 全不选：作用在**当前可见的全部模型**上，不含分组。
   分组不一起勾是故意的 —— 「全选然后建组」的意图基本都是「把散着的模型收一收」，
   把分组也勾上会变成「把现有目录结构整个塞进一层新壳里」，那不是人想要的。 */
function mselAllModels() {
  _mselPrune();
  const all = state.configs.map(c => c.id);
  if (all.every(id => _mselModels.has(id))) _mselModels.clear();
  else all.forEach(id => _mselModels.add(id));
  renderConfigs();
}

// ── 建新分组 ──────────────────────────────────────────

/* 「新分组」「新分组 2」「新分组 3」…… 挑第一个没被占的。
   用户要的是「点一下就建好，名字默认新分组」，所以这里**不弹输入框**；
   改名去组头上的 ✎，那条路本来就有。 */
function _mselFreshName() {
  const taken = modelGroupPaths();
  if (!taken.includes('新分组')) return '新分组';
  for (let n = 2; n < 999; n++) if (!taken.includes('新分组 ' + n)) return '新分组 ' + n;
  return '新分组 ' + Date.now();
}

/* 选中的东西一起挪到 dest 底下（dest 为空＝顶层新建）。
   返回真正挪动的条数 —— 调用方拿它报数，别自己数选中集合的大小（见下面两处剔除）。 */
function _mselMoveInto(dest) {
  _mselPrune();
  dest = mgNorm(dest);

  /* ① 选中的分组里，**祖先也被选中**的那些要剔掉。
        选了 A 又选了 A/B 时，只搬 A —— A/B 是 A 的子孙，跟着走。
        不剔的话会搬两次：先把 A 搬到 新分组/A（A/B 顺带变成 新分组/A/B），
        再拿早就不存在的旧路径 'A/B' 去搬，第二次是空操作，但计数会多报一个。 */
  const groups = [..._mselGroups].filter(
    p => ![..._mselGroups].some(q => q !== p && mgUnder(p, q)));

  /* ② 选中的模型里，**所属分组（或其祖先）也被选中**的那些要剔掉。
        同时选了分组 A 和 A 里的模型 M 时：M 本来就在 A 里，跟着 A 走就行。
        不剔的话 M 会被单独设成 dest/M，等于从 A 里被拽了出来 —— 人看到的是
        「我明明整组选中了，怎么有个模型掉到组外面去了」。 */
  const models = [..._mselModels].filter(id => {
    const g = modelGroupOf(state.configs.find(c => c.id === id));
    return !groups.some(p => mgUnder(g, p));
  });

  if (!groups.length && !models.length) return 0;

  /* 撞名字分两种，处理方式**故意不一样**：

     ① 跟目标层里**已经存在**的分组撞 —— 问一句，人点「是」就合并。
        这跟 moveModelGroup 单个搬时的行为一致（那边一次只问一个，这里攒成一句问）。
        语义是「那儿已经有个同名的了，要不要并进去」，合并是个合理选项。

     ② ❗**批内**互撞 —— 自动避重，不问，不合并。
        反例：已有 A/X 和 B/X，两个都选中，点「建新分组」。
        两个都会落到 `新分组/X`，于是两个来源不同的 X 被静默并成一个，
        里面的模型混在一起，而人看到的只是「我选了两个东西，结果只剩一个」。
        这不是「要不要合并」的选择题 —— 人明确选了两个，就该还是两个。
        所以第二个自动变成「X 2」，并在 toast 里说一声。
        （Codex 审出来的：我原来的 clash 只查 modelGroupPaths()，
         那是**搬之前**的世界，看不见「这一批自己人会撞在一起」。）

     判断「撞的是谁」就看它在不在选中集合里：
       · 撞的是**没被选中**的已有分组（原住民）→ 走 ①，问一句
       · 撞的是**同一批的另一个源**            → 走 ②，避重

     ⚠️ 落点必须**全部先算完**，再动 configs。见下面 target 那段和搬移那段的说明。 */
  const paths = modelGroupPaths();
  // 原住民 = 选中集合之外的已存在路径。撞它们才叫「跟别人撞」
  const outsiders = new Set(paths.filter(p => !groups.includes(p)));

  const target = new Map();     // 源路径 → 最终落点
  const used = new Set();       // 本批已经分配出去的落点
  const renamed = [];

  /* ⚠️ 分两轮，第一轮必须是「原地不动」的那些。
     反例（Codex 二审给的）：已有 A/X 和 B/X，两个都选中，移到 B。
     B/X 的落点算出来还是 B/X —— 它根本没动。可如果不让它先占住位子，
     A/X 会先把 B/X 占了，轮到 B/X 时反被判成「批内互撞」改名成 B/X 2，
     原住民自己被挤走。而且选择顺序反过来结果还不一样。 */
  groups.forEach(p => {
    if (mgJoin(dest, mgLeaf(p)) === p) { target.set(p, p); used.add(p); }
  });
  // 第二轮：真要挪的，只避开**本批**已用掉的落点（撞原住民走下面的 confirm）
  groups.forEach(p => {
    if (target.has(p)) return;
    const t0 = mgJoin(dest, mgLeaf(p));
    if (!used.has(t0)) { target.set(p, t0); used.add(t0); return; }
    // 避重时连原住民占的名字一起躲开，不然躲开了同伴又撞上原住民
    let n = 2, t = `${t0} ${n}`;
    while (used.has(t) || outsiders.has(t)) t = `${t0} ${++n}`;
    target.set(p, t); used.add(t);
    renamed.push(`${mgLeaf(p)} → ${mgLeaf(t)}`);
  });

  // 避重之后**仍然**落在原住民身上的，才问那一句
  const clash = groups.filter(p => {
    const t = target.get(p);
    return t !== p && outsiders.has(t);
  }).map(mgLeaf);
  if (clash.length && !confirm(
    `目标那层已经有同名的分组了：${clash.join('、')}\n合并进去？`)) return 0;

  /* ③ 环。dest 在某个被选中的分组**里面**的话，等于把文件夹拖进它自己 ——
        那些 config 的 group 会变成一条没有根的路径，模型从此在列表里消失
        （modelGroupTree 只从 modelGroupPaths 建节点，无主路径进不去任何节点）。
        这条必须在动 configs **之前**拦，事后没法回滚。 */
  const bad = groups.find(p => mgUnder(dest, p));
  if (bad) { showToast(`不能把「${mgLeaf(bad)}」移进它自己里面`, 'error'); return 0; }

  /* ❗一次性映射，**不能**逐组改写。
     每条路径只按它**原来**的值决定去哪，算完再写回。

     反例（Codex 二审给的）：A/X 和 B/X 都选中，移到 B。
     逐组写的话，先把 A/X 的模型改成 B/X；轮到源 B/X 时，
     `mgUnder(g, 'B/X')` 会把**刚搬过来的那批**也一起命中，跟着改成 B/X 2 ——
     两个组还是合并了，只是合并到了一个新名字底下。
     而且第二个组匹配到的是第一个组的产物，结果跟选择顺序有关。

     所以下面读的都是 `snap` / 传进来的原始 q，写回是独立的一步。
     ⚠️ groups 里的元素互不为祖先（上面 ① 已经剔过），所以一条路径最多命中一个 p，
        `for` 里直接 return 是安全的。 */
  const reroute = g => {
    for (const p of groups) if (mgUnder(g, p)) return target.get(p) + g.slice(p.length);
    return null;                                   // 不受这次搬移影响
  };

  // 折叠状态：一次调用，映射函数拿到的 q 就是原始值，不会读到自己刚写的结果
  _remapFoldedGroups(q => reroute(q) ?? q);

  // configs：先按原始 group 全部算完，再统一写回
  const snap = state.configs.map(c => modelGroupOf(c));
  const next = snap.map(reroute);
  state.configs.forEach((c, i) => { if (next[i] !== null) c.group = next[i]; });
  models.forEach(id => {
    const c = state.configs.find(x => x.id === id);
    if (c) c.group = dest;
  });

  _mselModels.clear(); _mselGroups.clear();
  refreshModelGroupUI();
  // 改过名的要说一声，不然人只会发现「怎么多了个叫 X 2 的组」
  if (renamed.length) showToast(`有同名分组，自动改名：${renamed.join('，')}`, 'success');
  return groups.length + models.length;
}

// 右上角那个 🗂：直接建一个叫「新分组」的顶层分组，把选中的全收进去
function mselGroupSelected() {
  const name = _mselFreshName();
  const n = _mselMoveInto(name);
  if (n) showToast(`${n} 项已收进「${name}」，点组名旁的 ✎ 可以改名`, 'success');
}

// 「移到…」：复用分组菜单那套渲染，选一个已有的分组当去处
function mselMoveMenu(x, y) {
  _mselPrune();
  /* 被选中的分组自己和它的子孙不能当去处 —— 那就是把文件夹拖进自己。
     _mselMoveInto 里还有一道同样的拦截，这里只是先把不该点的行藏掉。 */
  const rows = modelGroups()
    .filter(n => n.path && ![..._mselGroups].some(p => mgUnder(n.path, p)))
    .map(n => ({ path: n.path, label: n.name, depth: n.depth, sub: false }));
  rows.unshift({ path: '', label: '⤴ 顶层（未分组）', depth: 1, sub: false });
  rows.push({ path: '__new__', label: '＋ 新建分组…', depth: 1, sub: false, cls: 'mgm-new' });
  _mgmShow(x, y, `把选中的 ${_mselCount()} 项移到`, rows, async v => {
    if (v === '__new__') {
      const name = mgSafeName(await appPrompt('新分组叫什么？', _mselFreshName()));
      if (!name) return;
      const n = _mselMoveInto(name);
      if (n) showToast(`${n} 项已收进「${name}」`, 'success');
      return;
    }
    const n = _mselMoveInto(v);
    if (n) showToast(v ? `${n} 项已移到「${v}」里` : `${n} 项已移回顶层`);
  }, () => {});
}

// ── 顶部那条工具栏 ────────────────────────────────────

/* 摆在 #configList 里当第一个子元素，sticky 吸在列表顶部。
   用户要的是「点模型们右上角一个文件图标分组」—— 所以 🗂 在这条的右端。
   不做成 fixed 底部浮条（现有的批量删除是那样）是因为她明确说了右上角；
   而且模型列表在设置面板里，底部浮条会跟面板自己的按钮打架。 */
function mselBarHtml() {
  if (!_mselOn()) return '';
  _mselPrune();
  if (!_mselOn()) return '';                       // 滤完可能就空了
  const allOn = state.configs.length
    && state.configs.every(c => _mselModels.has(c.id));
  return `
    <div class="msel-bar">
      <span class="msel-count">已选 ${_mselCount()} 项</span>
      <button class="msel-btn" onclick="mselAllModels()"
              title="全选 / 全不选（只作用在模型上，不含分组）">${allOn ? '☐ 全不选' : '☑ 全选'}</button>
      <button class="msel-btn" onclick="mselMoveMenu(event.clientX,event.clientY)"
              title="移到一个已有的分组里">📁 移到…</button>
      <button class="msel-btn primary" onclick="mselGroupSelected()"
              title="新建一个分组，把选中的都收进去">🗂 建新分组</button>
      <button class="msel-btn" onclick="_mselClear()" title="退出多选">✕</button>
    </div>`;
}

// ── 手机：左划选中 ────────────────────────────────────

/* 交互参考画世界 / alight motion：在条目上往左一划就勾上，连划几条就是多选。
   用 document 级委托，不往 03 的模板里塞第四套 ontouch* —— 那边已经挂了长按弹菜单，
   再加一套 inline handler，两边的 suppress 标志会互相踩。

   跟长按不冲突：左划必然产生 touchmove，而 touchmove 会 _mgmTouchCancel() 掉长按计时器。 */
let _mselTouch = null;

/* 判定阈值。45px 是「明确的一划」——比这短的多半是列表滚动时手指的横向抖动。
   还要求横移是纵移的 1.5 倍以上：模型列表是竖着滚的，斜着甩一下不该勾上东西。 */
const MSEL_SWIPE_MIN = 45;

document.addEventListener('touchstart', e => {
  const t = e.touches && e.touches[0];
  if (!t) { _mselTouch = null; return; }
  const el = e.target.closest('.model-card-header[data-mid], .model-group-head[data-g]');
  // 组头里的 ✎ / ⊘ 按钮上划不算 —— 那两个是「这一个组」的操作，不是选择
  if (!el || e.target.closest('.model-group-acts')) { _mselTouch = null; return; }
  const g = el.dataset.g;
  if (el.classList.contains('model-group-head') && !mgNorm(g || '')) { _mselTouch = null; return; }
  _mselTouch = { x: t.clientX, y: t.clientY, el };
}, { passive: true });

document.addEventListener('touchend', e => {
  const st = _mselTouch; _mselTouch = null;
  if (!st) return;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  const dx = st.x - t.clientX, dy = Math.abs(t.clientY - st.y);
  if (dx < MSEL_SWIPE_MIN || dx < dy * 1.5) return;

  /* 划完手指抬起，浏览器还会补一个 click —— 不吃掉的话卡片会跟着展开/折叠。
     复用 03 那边的 suppress（同一个标志位，两边都是「刚用手势干过事，别让 click 生效」），
     它自带 800ms 过期兜底，所以补发的 click 没来也不会卡住下一次正常点击。 */
  _mgmTouchCancel();
  _mgmSuppress();
  e.preventDefault();

  const el = st.el;
  if (el.classList.contains('model-group-head')) toggleMselGroup(el.dataset.g);
  else toggleMselModel(Number(el.dataset.mid));
}, { passive: false });

document.addEventListener('touchcancel', () => { _mselTouch = null; }, { passive: true });

// ── 桌面：Ctrl + 左键 ─────────────────────────────────

/* 需求原话：「各种多选功能我也希望 exe 能按 ctrl 激活」。
   下面这张表就是「各种」的全集 —— 每个场景说清楚：怎么认出它、当前在不在多选态、
   怎么进多选、怎么勾一项、右键提示里管它叫什么。

   ⚠️ 顺序有意义：从最具体的选择器往外排。消息气泡那条 [data-msg-wrapper] 是个大容器，
      排在前面的话，气泡里嵌的任何东西都会被它先抢走。 */
const MSEL_ZONES = [
  {
    what: '模型', sel: '.model-card-header[data-mid]',
    on: () => _mselOn(),
    hit: el => toggleMselModel(Number(el.dataset.mid)),
  },
  {
    what: '分组', sel: '.model-group-head[data-g]',
    on: () => _mselOn(),
    // 「未分组」那一坨的 data-g 是空串，它不是真分组，勾不了
    ok: el => !!mgNorm(el.dataset.g || ''),
    hit: el => toggleMselGroup(el.dataset.g),
  },
  {
    what: '对话', sel: '.chat-item[data-cid]',
    on: () => state.chatSelectMode,
    enter: () => { if (!state.chatSelectMode) toggleChatSelectMode(); },
    hit: el => toggleChatSelection(Number(el.dataset.cid)),
  },
  {
    what: '回收站条目', sel: '.trash-card[data-ti]',
    on: () => state.trashSelectMode,
    enter: () => { if (!state.trashSelectMode) enterTrashSelectMode(); },
    hit: el => toggleTrashSelection(Number(el.dataset.ti)),
  },
  {
    what: '消息', sel: '[data-msg-wrapper]',
    on: () => state.isSelectMode,
    enter: () => { if (!state.isSelectMode) enterSelectMode(); },
    hit: el => toggleMessageSelection(Number(el.getAttribute('data-msg-wrapper'))),
  },
];

/* ⚠️ 在 capture 阶段调 stopPropagation，事件就**到不了 document 的冒泡监听**了。
   而这个项目里「点别处就关掉」的浮层全是那么实现的（六处 document click 冒泡监听），
   所以 Ctrl+点一下，它们会集体赖在屏幕上。这个函数替它们补上那一下。

   ⚠️ 最要命的是 #contextMenu：它不光是留在屏幕上，配套的 _ctxNodeId 还指着**上一条**
      消息。人右键消息 A 开了菜单，Ctrl+点消息 B 进多选，然后回头点菜单里的「删除」——
      删掉的是 A。（Codex 审出来的，我原来只补了分组菜单一个。）

   ⚠️ 每个都先看「它开着吗」再关。closePlusMenu / closeMathPanel 这些会顺带动输入栏布局，
      对着本来就没开的面板调一遍是白折腾，手机上还可能让输入框跳一下。
   ⚠️ 逐个 try —— 这些函数散在五个文件里，将来谁被改名了也只该少关一个，
      不能让整条 Ctrl 多选跟着废掉。 */
function _mselCloseFloaters() {
  const t = fn => { try { fn(); } catch (_) {} };
  const opened = (id, cls) => document.getElementById(id)?.classList.contains(cls);

  t(() => closeModelGroupMenu());
  t(() => { if (document.getElementById('contextMenu')?.style.display === 'flex') closeMsgContextMenu(); });
  t(() => { if (opened('plusMenu', 'open')) closePlusMenu(); });
  t(() => { if (opened('mathPanel', 'open')) closeMathPanel(); });
  t(() => { if (opened('stickerPanel', 'open')) closeStickerPanel(); });
  t(() => {
    const dd = document.getElementById('modelDropdownWrap')?.querySelector('div');
    if (dd && !dd.classList.contains('hidden')) {
      dd.classList.add('hidden');
      // 03 里的开合标志，不清的话下次点按钮会以为还开着，变成要点两下
      if (typeof _modelDropdownOpen !== 'undefined') _modelDropdownOpen = false;
    }
  });
  /* ⚠️ 走 closeFooterMenu()，别自己 add('hidden') ——
     菜单和那个箭头是一对，只藏菜单的话箭头还朝上，看着像「还开着」。
     （我原来就是自己 add 的，漏了箭头，Codex 二审逮到。） */
  t(() => { if (!document.getElementById('footerMenu')?.classList.contains('hidden')) closeFooterMenu(); });
  t(() => document.getElementById('widgetsPanel')?.classList.add('hidden'));
}

function _mselZoneAt(target) {
  for (const z of MSEL_ZONES) {
    const el = target.closest(z.sel);
    if (el && (!z.ok || z.ok(el))) return { z, el };
  }
  return null;
}

/* capture 阶段监听 —— 必须的。这些元素上的点击处理全是 inline onclick（冒泡阶段、
   挂在 target 自己身上），只有在 document 的 capture 里才能赶在它们**之前**拦下来。
   拦不住的话 Ctrl+点对话 = 一边进多选一边切走了对话。 */
document.addEventListener('click', e => {
  if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
  const found = _mselZoneAt(e.target);
  if (!found) return;
  const { z, el } = found;
  e.preventDefault();
  e.stopPropagation();

  _mselCloseFloaters();

  /* 进多选和勾选分两步，因为 enter() 那几个（enterSelectMode 等）会**重渲染整个列表**。
     重渲染之后 el 已经是个游离节点了，但 hit() 只用它身上的 data 属性取 id，
     不碰 DOM，所以先取 id 再进模式也一样 —— 这里顺序无所谓，写成先进后勾更好读。 */
  if (z.enter && !z.on()) z.enter();
  z.hit(el);
}, true);

/* Ctrl 按住时给个「现在点就是多选」的手感：光标变十字，条目微微抬一下。
   只在桌面做（手机没有 Ctrl，也没有 hover）。 */
function _mselCtrlFlag(on) {
  document.body.classList.toggle('msel-ctrl', !!on);
}
document.addEventListener('keydown', e => { if (e.key === 'Control' || e.key === 'Meta') _mselCtrlFlag(true); });
document.addEventListener('keyup', e => { if (e.key === 'Control' || e.key === 'Meta') _mselCtrlFlag(false); });
/* 切走窗口时 keyup 收不到（Alt+Tab、点到别的应用），标志会一直挂着，
   回来以后满屏十字光标。blur 兜一道。 */
window.addEventListener('blur', () => _mselCtrlFlag(false));

// ── 右键：告诉人这里能多选 ────────────────────────────

/* 同一条需求的后半句：「右键弹 ui 说可以多选 ctrl」。
   模型 / 分组那两个场景本来就有右键菜单（选分组），提示直接进那个菜单的底部
   —— 见 _mgmShow 里的 msel-tip。剩下的场景没有右键菜单，弹这个小气泡。 */
let _mselTipTimer = null;

function _mselShowTip(x, y, what) {
  document.getElementById('mselTip')?.remove();
  clearTimeout(_mselTipTimer);
  const d = document.createElement('div');
  d.id = 'mselTip';
  d.innerHTML = `按住 <b>Ctrl</b> 点${escHtml(what)}，可以一次选好几个`;
  document.body.appendChild(d);
  const w = d.offsetWidth || 220, h = d.offsetHeight || 40;
  d.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  d.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  _mselTipTimer = setTimeout(() => d.remove(), 2600);
}

/* 冒泡阶段（不是 capture）。这样跑到这儿的时候，本来就有右键菜单的地方
   已经在自己的 handler 里 preventDefault 过了 —— 用 defaultPrevented 让路，
   免得提示气泡盖在人家菜单上面。 */
document.addEventListener('contextmenu', e => {
  if (e.defaultPrevented) return;
  // 手机长按也会触发 contextmenu，但手机上没有 Ctrl 可按，提了反而添乱
  if (!_mselIsDesktop()) return;
  const found = _mselZoneAt(e.target);
  if (!found || found.z.on()) return;       // 已经在多选里了就不用再教一遍
  e.preventDefault();
  _mselShowTip(e.clientX, e.clientY, found.z.what);
}, false);

/* 「算不算桌面」：认指针精度，不认 UA。exe 里是 Electron，UA 里带 Chrome 也带 Electron，
   拿 UA 分不出手机版 WebView；而 pointer:fine 直接问的是「有没有鼠标那种精确指针」，
   正是「能不能按 Ctrl 点」要的那个条件。 */
function _mselIsDesktop() {
  try { return window.matchMedia('(pointer:fine)').matches; } catch { return true; }
}
