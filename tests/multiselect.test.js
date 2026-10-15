/* 多选：模型 / 分组一次挑好几个再一起收进新分组，外加 Ctrl 统一激活。
 *
 * 这里分两半：
 *   [1]~[5] 拿 vm 把 03 + 29 真的跑起来，验**搬移语义**（剔除规则、防环、命名）。
 *           这部分是真执行，不是扫源码 —— 剔除规则错了会静默把模型搬到组外面去，
 *           光看源码看不出来。
 *   [6]~[9] 扫源码，钉住那些「跑不出来但错了会出事」的约定（capture 阶段、
 *           兜底桩、passive、挂载点 data 属性）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function group(n) { console.log('\n' + n); }

// ── 造一个能跑 03 分组代码 + 29 搬移代码的沙箱 ────────────────
//
// 只挖出这两个文件里跟分组/多选有关的那些**纯函数**，不去模拟整个 App。
// DOM 全部打桩成空操作：这几段逻辑只动 state.configs，渲染是它们的下游。
function makeSandbox(configs) {
  const toasts = [];
  const sandbox = {
    console,
    state: { configs: configs.map(c => ({ ...c })) },
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
    },
    showToast: (m, t) => toasts.push({ m, t }),
    // 默认一路点「是」—— 合并确认在这些用例里不是被测对象
    confirm: () => true,
    save: () => {},
    renderConfigs: () => {}, renderModelPills: () => {}, renderConvSettingsBar: () => {},
    renderModelMemTab: () => {}, escHtml: s => String(s),
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {}, contains: () => false } }),
      body: { classList: { toggle() {} }, appendChild() {} },
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: true }) },
    setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    appPrompt: async () => '',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 03 里跟分组有关的那一段（从 MODEL_GROUP_FOLD_KEY 到 toggleChatModelGroup 之前）
  const s03 = read('js/03-chats-models.js');
  const from = s03.indexOf('const MODEL_GROUP_FOLD_KEY');
  const to = s03.indexOf('// 本次对话里整组勾上');
  if (from < 0 || to < 0) throw new Error('03 里的分组段落切不出来，锚点变了');
  vm.runInContext(s03.slice(from, to), sandbox, { filename: '03-slice.js' });

  // 29 整个跑。它顶层注册了一堆 document/window 监听，上面已经打桩成空操作
  vm.runInContext(read('js/29-multiselect.js'), sandbox, { filename: '29-multiselect.js' });

  // ⚠️ vm 里顶层 const/let **不会**挂到 context 对象上（只有 var 和函数声明会）。
  //    _mselModels / _mselGroups 都是 const，所以显式导出一份。
  vm.runInContext('this.__exp = { _mselModels, _mselGroups, MSEL_ZONES };', sandbox);
  sandbox.__toasts = toasts;
  return sandbox;
}

const G = (id, nickname, grp) => ({ id, nickname, group: grp || '' });
// 读回「谁在哪个组」，用昵称当键，比对起来一眼能看懂
const layout = sb => Object.fromEntries(sb.state.configs.map(c => [c.nickname, c.group]));

// ══════════════════════════════════════════════════════════
group('[1] 建新分组：名字自动避重');

{
  const sb = makeSandbox([G(1, 'a'), G(2, 'b', '新分组')]);
  ok(sb._mselFreshName() === '新分组 2', '已经有「新分组」时退到「新分组 2」');
}
{
  const sb = makeSandbox([G(1, 'a', '新分组'), G(2, 'b', '新分组 2')]);
  ok(sb._mselFreshName() === '新分组 3', '连着占用就一直往后找');
}
{
  const sb = makeSandbox([G(1, 'a')]);
  ok(sb._mselFreshName() === '新分组', '没占用时就叫「新分组」（小明指定的默认名）');
}

// ══════════════════════════════════════════════════════════
group('[2] 选中的模型一起收进新分组');

{
  const sb = makeSandbox([G(1, 'a'), G(2, 'b'), G(3, 'c')]);
  sb.__exp._mselModels.add(1); sb.__exp._mselModels.add(3);
  const n = sb._mselMoveInto('新分组');
  ok(n === 2, '报的条数是真的搬了几个');
  const L = layout(sb);
  ok(L.a === '新分组' && L.c === '新分组', '选中的两个都进去了');
  ok(L.b === '', '没选的那个原地不动');
  ok(sb.__exp._mselModels.size === 0, '搬完清空选中集合');
}

// ══════════════════════════════════════════════════════════
group('[3] ❗剔除规则一：祖先也被选中的分组不重复搬');

{
  // 选了 A，又选了 A/B。只该搬 A，A/B 是跟着走的
  const sb = makeSandbox([G(1, 'a', 'A'), G(2, 'b', 'A/B')]);
  sb.__exp._mselGroups.add('A'); sb.__exp._mselGroups.add('A/B');
  const n = sb._mselMoveInto('新分组');
  const L = layout(sb);
  ok(L.a === '新分组/A', 'A 搬到了新分组底下');
  ok(L.b === '新分组/A/B', '❗A/B 跟着 A 走，没被当成第二次搬移');
  ok(n === 1, '❗计数只算 A 这一个（不剔的话会多报一个空操作）');
}

// ══════════════════════════════════════════════════════════
group('[4] ❗剔除规则二：组里的模型不被单独拽出来');

{
  // 同时选了分组 A 和 A 里的模型 a。a 应该跟着 A 走，而不是被单独设成「新分组」
  const sb = makeSandbox([G(1, 'a', 'A'), G(2, 'b', 'A')]);
  sb.__exp._mselGroups.add('A');
  sb.__exp._mselModels.add(1);
  const n = sb._mselMoveInto('新分组');
  const L = layout(sb);
  ok(L.a === '新分组/A', '❗a 跟着 A 走，没被拽到组外面');
  ok(L.b === '新分组/A', 'b 也跟着 A 走');
  ok(n === 1, '❗计数只算 A（a 是跟着走的，不单独计）');
}
{
  // 更深一层：选中 A，模型在 A/B 里，也该跟着 A 走
  const sb = makeSandbox([G(1, 'deep', 'A/B/C')]);
  sb.__exp._mselGroups.add('A');
  sb.__exp._mselModels.add(1);
  sb._mselMoveInto('新分组');
  ok(layout(sb).deep === '新分组/A/B/C', '❗孙子层的模型也跟着走，不被拽出来');
}

// ══════════════════════════════════════════════════════════
group('[5] ❗防环：不能把分组移进它自己里面');

{
  const sb = makeSandbox([G(1, 'a', 'A'), G(2, 'b', 'A/B')]);
  sb.__exp._mselGroups.add('A');
  const n = sb._mselMoveInto('A/B');          // 把 A 移进 A 的孩子里
  ok(n === 0, '❗拦住了，一个都没搬');
  const L = layout(sb);
  ok(L.a === 'A' && L.b === 'A/B', '❗configs 一个字节没动（事后没法回滚，必须事前拦）');
  ok(sb.__toasts.some(t => t.t === 'error'), '报了错，不是静默失败');
}
{
  // 移进自己（dest 就是自己）也算环
  const sb = makeSandbox([G(1, 'a', 'A')]);
  sb.__exp._mselGroups.add('A');
  ok(sb._mselMoveInto('A') === 0, '❗dest 就是自己时也拦住');
}

// ══════════════════════════════════════════════════════════
group('[5b] ❗批内重名：选中的两个组不能被静默并成一个');

{
  /* Codex 审出来的反例。已有 A/X 和 B/X，两个都选中，点「建新分组」：
     两个都会落到 `新分组/X`。合并的话人选了两个东西却只剩一个，
     里面的模型还混在一起 —— 而且全程没有任何提示。 */
  const sb = makeSandbox([G(1, 'ax', 'A/X'), G(2, 'bx', 'B/X')]);
  sb.__exp._mselGroups.add('A/X'); sb.__exp._mselGroups.add('B/X');
  const n = sb._mselMoveInto('新分组');
  const L = layout(sb);
  ok(n === 2, '两个都搬了');
  ok(L.ax !== L.bx, '❗两个 X 没有被并成一个（选了两个就该还是两个）');
  ok([L.ax, L.bx].sort().join('|') === ['新分组/X', '新分组/X 2'].sort().join('|'),
    '❗第二个自动避重成「X 2」');
  ok(sb.__toasts.some(t => /自动改名/.test(t.m)), '❗改了名要说一声，别让人自己发现');
}
{
  // 避重要连**已存在**的名字一起躲开，不然躲开了同伴又撞上原住民
  const sb = makeSandbox([
    G(1, 'ax', 'A/X'), G(2, 'bx', 'B/X'), G(3, 'occupied', '新分组/X 2'),
  ]);
  sb.__exp._mselGroups.add('A/X'); sb.__exp._mselGroups.add('B/X');
  sb._mselMoveInto('新分组');
  const L = layout(sb);
  ok(L.occupied === '新分组/X 2', '原住民「X 2」没被动');
  ok([L.ax, L.bx].includes('新分组/X 3'),
    '❗避重跳过了已被占用的「X 2」，退到「X 3」');
}
{
  // 三个同名的也要一路排下去
  const sb = makeSandbox([G(1, 'a', 'P/X'), G(2, 'b', 'Q/X'), G(3, 'c', 'R/X')]);
  ['P/X', 'Q/X', 'R/X'].forEach(p => sb.__exp._mselGroups.add(p));
  sb._mselMoveInto('新');
  const got = Object.values(layout(sb)).sort();
  ok(new Set(got).size === 3, '❗三个同名 → 三个不同落点，一个都没丢');
}
{
  // 跟**已存在**的组撞是另一回事：那条走「问一句，同意就合并」，不该被避重改掉
  const sb = makeSandbox([G(1, 'mover', 'A/X'), G(2, 'sitting', '新分组/X')]);
  sb.__exp._mselGroups.add('A/X');
  sb._mselMoveInto('新分组');
  const L = layout(sb);
  ok(L.mover === '新分组/X' && L.sitting === '新分组/X',
    '❗撞已存在的同名组 → 确认后合并（这条是原有行为，别被避重逻辑改掉）');
}

// ══════════════════════════════════════════════════════════
group('[5c] ❗目标就是其中一个源的父级：不能跟选择顺序有关');

/* Codex 二审给的反例，比 [5b] 深一层：
   已有 A/X 和 B/X，两个都选中，移到 **B**。
   B/X 算出来的落点还是 B/X —— 它根本没动。
   可如果不让「原地不动」的先占位，A/X 会先占掉 B/X，
   轮到 B/X 时反被判成批内互撞、改名成 B/X 2，原住民自己被挤走。
   更糟的是搬移那一步：逐组改写的话，处理源 B/X 时会把 A/X **刚搬过来的**
   那批也一起命中，两个组还是合并了，只是并到了新名字底下。
   而且这些都跟选中顺序有关 —— 所以下面正反两个顺序各跑一遍。 */
function intoParentCase(order) {
  const sb = makeSandbox([G(1, 'ax', 'A/X'), G(2, 'bx', 'B/X')]);
  order.forEach(p => sb.__exp._mselGroups.add(p));
  sb._mselMoveInto('B');
  return layout(sb);
}
{
  const fwd = intoParentCase(['A/X', 'B/X']);
  const rev = intoParentCase(['B/X', 'A/X']);
  ok(fwd.bx === 'B/X', '❗原地不动的 B/X 保持原样，没被挤走改名');
  ok(fwd.ax !== fwd.bx, '❗A/X 没跟 B/X 合并');
  ok(fwd.ax === 'B/X 2', 'A/X 避重成 B/X 2');
  ok(JSON.stringify(fwd) === JSON.stringify(rev),
    '❗正反两种选中顺序结果一样（顺序相关＝逐组改写读到了前一步的产物）');
}
{
  // 同一个坑的另一面：一次搬多个组时，后面的组不能命中前面刚写进去的新路径
  const sb = makeSandbox([G(1, 'a', 'P'), G(2, 'b', 'Q')]);
  sb.__exp._mselGroups.add('P'); sb.__exp._mselGroups.add('Q');
  sb._mselMoveInto('新');
  const L = layout(sb);
  ok(L.a === '新/P' && L.b === '新/Q', '❗各归各位，没有互相串味');
}
{
  // 整组移到它自己的父级下 = 什么都不该变
  const sb = makeSandbox([G(1, 'a', 'A/B')]);
  sb.__exp._mselGroups.add('A/B');
  sb._mselMoveInto('A');
  ok(layout(sb).a === 'A/B', '❗移到自己现在的父级 → 原地不动，不改名');
}

// ══════════════════════════════════════════════════════════
group('[6] 幽灵条目：选中期间东西被删掉');

{
  const sb = makeSandbox([G(1, 'a'), G(2, 'b')]);
  sb.__exp._mselModels.add(1);
  sb.__exp._mselModels.add(99);              // 不存在的 id（模型被 ✕ 掉了）
  sb.__exp._mselGroups.add('早就没了');
  sb._mselPrune();
  ok(!sb.__exp._mselModels.has(99), '死掉的模型 id 被滤掉');
  ok(sb.__exp._mselGroups.size === 0, '不存在的分组路径被滤掉');
  ok(sb.__exp._mselModels.has(1), '活着的留着');
}
{
  const sb = makeSandbox([G(1, 'a')]);
  sb.__exp._mselModels.add(1);
  sb.__exp._mselModels.add(99);
  const n = sb._mselMoveInto('新分组');
  ok(n === 1, '❗报的是真搬了几个，幽灵不计入（不然人看到「已选 2 项」却只进去 1 个）');
}

// ══════════════════════════════════════════════════════════
group('[7] 选中集合存 id / path，不存索引');

{
  const src = read('js/29-multiselect.js');
  ok(/_mselModels\.add\(id\)|_mselModels\.has\(id\)/.test(src),
    '模型存的是 id');
  // 存索引的话删模型会让后面的全部错位，而且是静默错位
  ok(!/_mselModels\.add\(i\)\b/.test(src), '❗没有拿数组下标当模型键的写法');
  ok(/dataset\.mid/.test(src), 'DOM 上带的也是 id（data-mid）');
}

// ══════════════════════════════════════════════════════════
group('[8] Ctrl 激活：必须是 capture 阶段');

{
  const src = read('js/29-multiselect.js');
  // 这几处元素的点击处理全是 inline onclick（冒泡、挂在 target 上）。
  // 挂冒泡的话事件先被 inline handler 吃掉 —— Ctrl+点对话会一边进多选一边切走对话。
  ok(/addEventListener\('click',[\s\S]{0,900}?\},\s*true\)/.test(src),
    '❗click 监听挂在 capture 阶段（挂冒泡会被 inline onclick 抢先）');
  ok(/e\.stopPropagation\(\)/.test(src), 'Ctrl 命中时拦下事件');
  ok(/_mselCloseFloaters\(\)/.test(src),
    '❗capture 里 stopPropagation 会连累所有「点别处关闭」的浮层，集中补了一手');

  /* ❗最要命的是消息右键菜单：它不光留在屏幕上，_ctxNodeId 还指着**上一条**消息。
     右键 A → Ctrl+点 B → 点菜单里的「删除」= 删掉 A。（Codex 审出来的。） */
  ok(/closeMsgContextMenu\(\)/.test(src),
    '❗Ctrl 命中时关掉消息右键菜单（否则 _ctxNodeId 留旧值，可能删错消息）');
  ok(/closePlusMenu\(\)/.test(src) && /closeMathPanel\(\)/.test(src)
    && /closeStickerPanel\(\)/.test(src),
    '加号 / 数学 / 表情面板也一起关');
  ok(/modelDropdownWrap/.test(src) && /footerMenu/.test(src),
    '模型下拉和侧栏底部菜单也关');
  /* ❗footer 菜单和它的箭头是一对。只 add('hidden') 的话菜单没了、箭头还朝上，
     看着像「还开着」。这一对原来在 14 里抄了四遍，我漏了箭头那半边。 */
  ok(/closeFooterMenu\(\)/.test(src),
    '❗走 closeFooterMenu()（连箭头一起复位），别自己 add(\'hidden\')');
  ok(!/getElementById\('footerMenu'\)\?\.classList\.add\('hidden'\)/.test(src),
    '❗没有绕过 closeFooterMenu 自己藏菜单的写法');

  const hub = read('js/14-boot-brain-hub.js');
  ok(/function closeFooterMenu\(\)[\s\S]{0,240}chev\.style\.transform = ''/.test(hub),
    '❗14 里把「关菜单 + 复位箭头」提成了一个函数');
  // 四处抄写收敛掉了 —— 还剩的应该只有 toggleFooterMenu（它要设 rotate，不是复位）
  ok((hub.match(/footerMenuChev/g) || []).length <= 3,
    '❗那一对不再散在四处各抄一遍（散着就是下一个人漏掉半边的原因）');
  ok(/_modelDropdownOpen = false/.test(src),
    '❗下拉的开合标志也要清（不清的话下次要点两下才开）');
  ok(/try \{ fn\(\); \} catch/.test(src),
    '❗逐个 try —— 这些函数散在五个文件里，谁被改名了只该少关一个，不能废掉整条 Ctrl 多选');

  const ctx = read('js/13-trash-ctx-ui.js');
  ok(/function closeMsgContextMenu\(\)[\s\S]{0,200}_ctxNodeId = null/.test(ctx),
    '❗关菜单和清 _ctxNodeId 绑在同一个函数里（分开写迟早漏一个）');
  ok(/ctrlKey \|\| e\.metaKey/.test(src), 'Mac 的 Cmd 也认');
  ok(/e\.button !== 0/.test(src), '只认左键');
}

// ══════════════════════════════════════════════════════════
group('[9] 手机左划 + 挂载点');

{
  const src = read('js/29-multiselect.js');
  ok(/touchend[\s\S]{0,1200}?passive:\s*false/.test(src),
    '❗touchend 用 passive:false（要 preventDefault 吃掉补发的 click）');
  ok(/_mgmSuppress\(\)/.test(src), '划完复用 03 的 suppress，别让补发的 click 展开卡片');
  ok(/dx < dy \* 1\.5/.test(src), '要求横移明显大于纵移（列表是竖着滚的）');
  ok(/MSEL_SWIPE_MIN\s*=\s*\d+/.test(src), '阈值提出来成常量');

  const s03 = read('js/03-chats-models.js');
  ok(/data-mid="\$\{c\.id\}"/.test(s03), '模型卡片带 data-mid');
  ok(/data-cid="\$\{c\.id\}"/.test(s03), '对话条目带 data-cid');
  ok(/data-ti="\$\{i\}"/.test(read('js/13-trash-ctx-ui.js')), '回收站条目带 data-ti');
  ok(/mselBarHtml\(\)/.test(s03), '工具栏接进了 renderConfigs');

  // 兜底桩：29 缺席时不能把整个模型列表带走
  ok(/function _mselHasModel\(\) \{ return false; \}/.test(s03),
    '❗03 里留了兜底桩（29 漏挂时列表照常渲染，只是没有多选）');
  ok(/function _mselIsDesktop\(\) \{ return false; \}/.test(s03),
    '❗桩里不提 Ctrl —— 多选都没有还教人按 Ctrl 是骗人');

  const html = read('index.html');
  ok(/js\/29-multiselect\.js/.test(html), '29 挂进页面了');
  ok(html.indexOf('28-chat-peek.js') < html.indexOf('29-multiselect.js'),
    '29 排在 03 之后（真身覆盖兜底桩靠的就是这个顺序）');
}

// ══════════════════════════════════════════════════════════
group('[10] ❗功能指南的目录：大集合那条路必须建');

{
  const hub = read('js/14-boot-brain-hub.js');
  /* 这是用户报的「侧边栏 ui 很久才会出现」的真身。
     功能指南只有一个打开入口 —— 大集合的 openHubSection('help')；
     页面里的 toggleHelp() 全是关闭（✕、点背景）。所以 render 是 null 的时候
     buildHelpToc() 一次都跑不到，左侧目录就是个 0 项的空壳。
     实测过：修之前 0 项，修之后 18 项。 */
  const helpLine = hub.match(/^\s*help:\s*\{.*$/m)?.[0] || '';
  ok(/render:\s*\(\)\s*=>\s*buildHelpToc\(\)/.test(helpLine),
    '❗HUB_SECTIONS.help.render 会建目录（改回 null 的话目录永远是空的）');
  ok(!/help:[^}]*render:\s*null/.test(hub), '❗没退回 render:null');

  const html = read('index.html');
  /* 钉住「toggleHelp 不是打开入口」这个前提。哪天有人给它加了打开按钮，
     这条会红 —— 那时该重新想想预热和目录的时机，而不是默默让它红着。 */
  const opens = (html.match(/toggleHelp\(\)/g) || []).length;
  ok(opens > 0 && !/onclick="toggleHelp\(\)"[^>]*>\s*(功能指南|📖)/.test(html),
    '（前提）页面上没有「用 toggleHelp 打开指南」的按钮，唯一入口是大集合');
}

// ══════════════════════════════════════════════════════════
group('[11] 顺手清掉的死样式（不是性能修复）');

{
  const css = read('css/grancyan.css');

  /* ⚠️ 判之前必须先把 CSS 注释剥掉。
     这两条断言问的是「有没有这条**声明**」，可块里的注释正解释着「为什么故意不要
     backdrop-filter」—— 直接扫原文的话，注释写得越清楚断言越会把自己绊倒。
     （第一版就是这么红的。同一个坑在 chat-peek 那轮已经踩过两次，这是第三次，
      所以这回不靠「换个正则绕开」，而是从源头去掉注释这个干扰项。） */
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  /* ⚠️ 收**所有**同名块，不是第一个。
     第一版写的是 indexOf(sel+' {') 只取一处，结果自检那条立刻红了 ——
     `.settings-panel` 在 @media 里还有一份，缩进版排在前面，indexOf 命中的是那个空壳。
     而这里要断言的本来就是「**任何一处**都不许把 blur 加回来」，
     媒体查询里偷偷加一条同样会把代价带回来。所以就该全收。 */
  const blocks = sel => {
    const out = [];
    const re = new RegExp('(^|[\\s,}])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'g');
    let m;
    while ((m = re.exec(noComments))) {
      const s = m.index + m[0].length;
      out.push(noComments.slice(s, noComments.indexOf('}', s)));
    }
    return out;
  };
  const noBlur = sel => {
    const bs = blocks(sel);
    return bs.length > 0 && bs.every(b => !/backdrop-filter/.test(b));
  };
  ok(noBlur('#helpModal'),
    '❗#helpModal 的每一处都没有 backdrop-filter（底色九成不透明，模糊看不见却要全屏合成）');
  ok(noBlur('.help-panel'),
    '❗.help-panel 的每一处都没有 backdrop-filter（底色 98% 不透明，纯付账不收货）');
  /* 自检：同一个读法下，别的块该读出 blur 就读得出。
     没有这条的话，正则写错导致「一个块都没收到」也会让上面两条全绿 —— 绿得毫无意义。 */
  ok(blocks('.settings-panel').some(b => /backdrop-filter/.test(b)),
    '（自检）同一读法能读出真的带 blur 的块，说明上面两条不是因为读空了才过');
  ok(/#helpModal\.hidden\.warm/.test(css), '预热态的样式在');
  ok(/display:flex !important;visibility:hidden/.test(css),
    '❗预热的 display 带 !important —— 全局那条 .hidden{display:none!important} '
    + '会静默盖掉它，第一版就是这么白忙的（class 挂上了、代码跑了、高度却是 0）');
  ok(/\.hidden \{ display: none !important; \}/.test(css),
    '（前提）全局确实有那条带 !important 的 .hidden，上面那条才有意义');

  const js = read('js/13-trash-ctx-ui.js');
  ok(/function warmHelpModal/.test(js), '预热函数在');
  ok(/requestIdleCallback/.test(js), '走 idle，不抢 boot 的路');
  ok(/typeof requestIdleCallback === 'function'/.test(js), '老 WebView 没有它时能退回定时器');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
