// ============================================================
// 飞行棋（和一个 AI 对飞）
//
// 参考 github.com/lili0926/player：双人飞行棋 + 落格触发事件 + 多个主题版本。
// 骨架沿用猫猫大富翁（js/35-monopoly.js）那一套——小组件入口、localStorage 存档、
// 骰子动画 + 棋子逐格动画 + 看门狗，默认「本地猫猫」零 API 调用，也可以挑一个
// 真实模型让它在回合里吐槽一句。
//
// 为什么不是大富翁换皮：飞行棋的招牌全在这几条，缺一条就不叫飞行棋了——
//   ① 掷 6 才能起飞，且起飞后再掷一次
//   ② 落到自己颜色的格子往前跳 4
//   ③ 落到自己的航线格直飞 12
//   ④ 落到对方飞机头上，把对方那架打回停机坪
//   ⑤ 终点要**精确**走到，多出来的步数原路退回
// 所以位置不是「第几格」而是 step（0=停机坪，1~20=跑道，21~24=自己的终点道），
// 跑道格号由 step 现算（见 _ludoCell）。两人起飞点在环的对角，各走满一圈才进终点道。
//
// 主题版本只换**文案**，不换效果：LUDO_EVENTS 每个主题的效果序列必须一一对应
// （测试里守着这条）。不这么切的话，换个主题就等于换了套平衡，没法验。
// ============================================================

// 20 格环形跑道。6×6 外圈：上边 6 格 → 右边 5 格 → 下边 5 格 → 左边 4 格。
const LUDO_POS = [
  [1,1],[1,2],[1,3],[1,4],[1,5],[1,6],
  [2,6],[3,6],[4,6],[5,6],[6,6],
  [6,5],[6,4],[6,3],[6,2],[6,1],
  [5,1],[4,1],[3,1],[2,1],
];

// 格子类型。start=起飞点，jump=同色跳 4，fly=航线直飞 12，event=事件格，plain=普通格。
// u 是用户，a 是 AI；带后缀的格子只对自家飞机生效，别人踩上去什么也不会发生。
// ⚠️ event 格的个数必须正好等于 LUDO_EFFECTS 的条数（测试守着这条）。
// 少一个就有效果永远触发不到，多一个就会从头绕回去重复用。
const LUDO_CELLS = [
  'start-u','event','jump-u','event','fly-u',
  'event','jump-a','plain','event','jump-u',
  'start-a','event','jump-a','event','fly-a',
  'event','jump-u','plain','event','jump-a',
];

const LUDO_START = { user: 0, ai: 10 };   // 起飞点在环上的格号
const LUDO_GOAL = 24;                      // step 走到这里算一架到家（21~24 是终点道）
const LUDO_PLANES = 2;                     // 每人两架：一架没策略，四架一局太长

// 事件格的效果。八种，环上八个 event 格按格号顺序取用（见 _ludoEventAt）。
// kind: back 退 N / forward 进 N / again 再掷一次 / none 只有叙事
const LUDO_EFFECTS = [
  { kind:'forward', n:3 }, { kind:'back', n:2 }, { kind:'again', n:0 }, { kind:'none', n:0 },
  { kind:'forward', n:2 }, { kind:'back', n:3 }, { kind:'again', n:0 }, { kind:'none', n:0 },
];

// 主题版本：只是给上面八个效果换一套说法。顺序必须和 LUDO_EFFECTS 对齐。
const LUDO_EVENTS = {
  standard: { name:'云端航线', desc:'普通的一局，云好天也好', icons:['✈️','🚁'], texts:[
    '一段顺风，机身轻快地往前窜了 3 格。',
    '穿过一片积云，颠得偏航，退 2 格。',
    '停靠补给站加满油，可以再掷一次。',
    '云隙里看见地面的灯，什么也没发生，只是好看。',
    '塔台给了优先起降，前进 2 格。',
    '雷雨绕行，多飞了一段冤枉路，退 3 格。',
    '气流托了一把，再掷一次。',
    '机翼掠过一群飞鸟，它们让开了。',
  ]},
  couple: { name:'两个人的航线', desc:'一起出门的那种飞法', icons:['💌','🧸'], texts:[
    '她把手搭上来，你忽然飞得很稳，前进 3 格。',
    '为了看她一眼偏了航，退 2 格。',
    '在小机场落地喝了杯热的，可以再掷一次。',
    '云上没有信号，谁也联系不到你们俩。',
    '她说这边近一点，还真的近，前进 2 格。',
    '争论该往哪飞，绕了一大圈，退 3 格。',
    '她把靠窗的位置让给你，再掷一次。',
    '并排飞了一会儿，什么都没说。',
  ]},
  maid: { name:'女仆值班表', desc:'今天的班有点忙', icons:['🎀','🫖'], texts:[
    '茶点准备得分毫不差，被夸了，前进 3 格。',
    '打翻了糖罐，回头收拾，退 2 格。',
    '裁判说休息一下，可以再掷一次。',
    '路过镜子偷偷理了理围裙。',
    '抄近路穿过后廊，前进 2 格。',
    '钥匙忘在楼上，跑一趟，退 3 格。',
    '被塞了一块点心，再掷一次。',
    '走廊很安静，脚步声比平时轻。',
  ]},
  butler: { name:'管家的行程', desc:'一切都该在时间表上', icons:['🕰️','🥂'], texts:[
    '行程提前完成，从容前进 3 格。',
    '临时被叫去处理一桩琐事，退 2 格。',
    '在书房替自己倒了一杯，可以再掷一次。',
    '把座钟对准了整点，误差不超过一秒。',
    '车已经候在门口，前进 2 格。',
    '一份文件签错了地方，重来一遍，退 3 格。',
    '手套换了新的一副，再掷一次。',
    '替谁掖好了毯子，没有惊动她。',
  ]},
};

let _ludo = null;
let _ludoAnimating = false;
// 动画代际。看门狗和正在跑的回合协程都记住自己是第几代：
// AI 连掷 6 时会一个回合接一个回合，上一代的看门狗 5 秒后照样会醒——它只看到共享的
// _ludoAnimating===true，就会把**正在进行的下一代动画**解锁并把回合抢回给用户，
// 于是两个回合并发写同一份局面。带上代际之后，过期的看门狗醒来就自己走开。
// 同理，动画途中关窗口再打开会清锁重新读档，旧协程却还在跑；换代能让它落子前先退出。
let _ludoRun = 0;
const _ludoWait = ms => new Promise(r => setTimeout(r, ms));

// ── 存档 ──
function _ludoFresh(aiId = 'local', theme = 'standard') {
  if (!LUDO_EVENTS[theme]) theme = 'standard';
  return {
    v: 1, aiId, theme, turn: 'user',
    planes: { user: Array(LUDO_PLANES).fill(0), ai: Array(LUDO_PLANES).fill(0) },
    log: ['新的一局。掷出 6 才能起飞，两架都到家就赢。'],
    quip: '停机坪见。我可不打算让你先起飞。',
    over: false, lastRoll: 0, bonus: false, event: '', picking: false,
  };
}
function _ludoSave() { localStorage.setItem('grancyan_ludo', JSON.stringify(_ludo)); }

// 存档校验：**fail closed**。版本号对不代表内容对——localStorage 是用户能直接改的地方，
// 手滑改坏、别的功能写串、旧版本残留都可能留下形状不对的数据。
// 这里不做「尽力修补」，因为修补出来的局面既不是原来那局也不是新的一局；
// 任何一项不合格就整份作废、重开一局，宁可丢一局也不进一个说不清的状态。
//
// ⚠️ 为什么值得这么严：planes.ai 要是空数组，_ludoWin 的 every() 会**恒为 true**，
// AI 一架飞机都没有却直接判赢。这类 fail-open 是零报错的，只会表现成「莫名其妙输了」。
function _ludoValidSave(o) {
  if (!o || typeof o !== 'object' || o.v !== 1) return false;
  if (o.turn !== 'user' && o.turn !== 'ai') return false;
  if (!o.planes || typeof o.planes !== 'object') return false;
  for (const k of ['user', 'ai']) {
    const a = o.planes[k];
    if (!Array.isArray(a) || a.length !== LUDO_PLANES) return false;
    if (!a.every(s => Number.isInteger(s) && s >= 0 && s <= LUDO_GOAL)) return false;
  }
  if (!Array.isArray(o.log) || !o.log.every(x => typeof x === 'string')) return false;
  if (!Number.isInteger(o.lastRoll) || o.lastRoll < 0 || o.lastRoll > 6) return false;
  if (typeof o.over !== 'boolean' || typeof o.bonus !== 'boolean' || typeof o.picking !== 'boolean') return false;
  return true;
}
function _ludoLoad() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('grancyan_ludo')); } catch { }
  if (!_ludoValidSave(raw)) { _ludo = _ludoFresh('local'); _ludoSave(); return; }
  _ludo = raw;
  if (!LUDO_EVENTS[_ludo.theme]) _ludo.theme = 'standard';
  // picking 要**留着**：掷完骰子还没选飞机就关窗口，清掉它等于让这次骰子作废、
  // 可以再掷一次（白捡一个点数）。留着就是回来接着选，和关窗口前一模一样。
  if (_ludo.picking && !_ludoMovable(_ludo.planes, 'user', _ludo.lastRoll).length) _ludo.picking = false;
  // 上次关窗口时停在 AI 回合的话，控制权还给用户——不然进来就是个动不了的死局。
  if (_ludo.turn === 'ai' && !_ludo.over) {
    _ludo.turn = 'user'; _ludo.bonus = false; _ludo.picking = false;
    _ludoAdd('检测到上次停在 AI 回合，控制权已还给你。');
  }
  _ludoSave();
}

function openLudo() { _ludoRun++; _ludoAnimating = false; _ludoLoad(); document.getElementById('ludoModal')?.classList.remove('hidden'); renderLudo(); }
function closeLudo() { document.getElementById('ludoModal')?.classList.add('hidden'); }
// 重新开局也要换代并解锁：动画跑到一半点「重新开局」时，旧协程手里还攥着一个当时有效的
// run，等它从 await 里醒来就会把**上一局的落子**写进新局（新局已经在 _ludo 里了）。
function ludoNew() {
  _ludoRun++; _ludoAnimating = false;
  _ludo = _ludoFresh(document.getElementById('ludoAi')?.value || 'local', _ludo?.theme || 'standard');
  _ludoSave(); renderLudo();
}
function ludoSetAi(id) { _ludo.aiId = id; _ludoSave(); renderLudo(); }
function ludoSetTheme(t) {
  if (!LUDO_EVENTS[t]) return;
  _ludo.theme = t; _ludoAdd(`换到「${LUDO_EVENTS[t].name}」版本。`); _ludoSave(); renderLudo();
}

function _ludoAiName() {
  if (!_ludo || _ludo.aiId === 'local') return '本地猫猫';
  return state.configs?.find(c => String(c.id) === String(_ludo.aiId))?.nickname || 'AI';
}
function _ludoUserName() { return (typeof state !== 'undefined' && state && state.userName) || '你'; }
function _ludoWho(k) { return k === 'user' ? _ludoUserName() : _ludoAiName(); }
function _ludoAdd(s) { _ludo.log.push(s); if (_ludo.log.length > 35) _ludo.log.shift(); }

// ── 位置换算 ──
// step 0 在停机坪、21~24 在自己的终点道，两者都不在环上，返回 -1。
function _ludoCell(k, step) {
  if (step < 1 || step > 20) return -1;
  return (LUDO_START[k] + step - 1) % 20;
}
// 环上第 i 个 event 格用第几号效果（按格号顺序数过去，和 LUDO_EFFECTS 一一对应）
function _ludoEventAt(cell) {
  if (LUDO_CELLS[cell] !== 'event') return -1;
  let n = 0;
  for (let i = 0; i < cell; i++) if (LUDO_CELLS[i] === 'event') n++;
  return n % LUDO_EFFECTS.length;
}

// ── 走子：不写 _ludo，只算不落库 ──
// 只算「这一步会发生什么」，交给 _ludoApply 去落库。分开写是为了 AI 能先试算再挑飞机，
// 也为了测试能直接喂局面进来验规则。
// ⚠️ 说明白：它**不是严格的纯函数**——notes 里的名字经 _ludoWho 读了全局 _ludo。
// 但读到的只影响提示文案，to / again / bump 三个决定局面的值完全由入参算出，
// 所以试算（_ludoPlan 连调好几次）不会有副作用。改这里时别把状态读进那三个值里。
// 返回 { ok, to, hops:[环上格号…], notes:[文字…], again, bump:{k,idx} }
function _ludoResolve(planes, k, idx, d) {
  const step = planes[k][idx];
  const other = k === 'user' ? 'ai' : 'user';
  const notes = [], hops = [];
  let again = false, bump = null;

  if (step === 0) {
    if (d !== 6) return { ok: false };
    // 起飞：直接落在起飞点（step 1），并且按飞行棋的规矩再掷一次
    let to = 1;
    notes.push(`${_ludoWho(k)}掷出 6，一架飞机起飞了。`);
    again = true;
    const land = _ludoSettle(planes, k, other, to, notes, hops);
    return { ok: true, to: land.to, hops, notes, again, bump: land.bump };
  }
  if (step >= LUDO_GOAL) return { ok: false };   // 已经到家的飞机不再动

  let to = step + d;
  if (to > LUDO_GOAL) {
    // 终点要精确落地，多出来的步数原路退回
    to = LUDO_GOAL - (to - LUDO_GOAL);
    notes.push(`步数超过终点 ${step + d - LUDO_GOAL} 步，原路退回到第 ${to} 步。`);
  }
  for (let n = step + 1; n <= Math.min(step + d, 20); n++) { const c = _ludoCell(k, n); if (c >= 0) hops.push(c); }
  if (d === 6) again = true;                     // 掷 6 多一次
  const land = _ludoSettle(planes, k, other, to, notes, hops);
  return { ok: true, to: land.to, hops, notes, again, bump: land.bump };
}

// 落地之后的连锁：同色跳 / 航线，然后结算撞机。
// **每次落骰最多触发一次跳或飞**，跳完不再看新落点是不是又一个同色格——
// 不设这个闸的话，同色格能把飞机一路弹到终点。跳跃/航线越界由 to+4 / to+12 <= 24 兜住，
// 顶到边就干脆不跳（宁可不跳，也不要出现一个说不清的落点）。
function _ludoSettle(planes, k, other, to, notes, hops) {
  const cell = _ludoCell(k, to);
  if (cell >= 0) {
    const type = LUDO_CELLS[cell];
    const mine = k === 'user' ? '-u' : '-a';
    if (type === 'jump' + mine && to + 4 <= LUDO_GOAL) {
      to += 4; notes.push('落在自己的颜色上，往前跳 4 格。');
      for (let n = to - 3; n <= Math.min(to, 20); n++) { const c = _ludoCell(k, n); if (c >= 0) hops.push(c); }
    } else if (type === 'fly' + mine && to + 12 <= LUDO_GOAL) {
      to += 12; notes.push('走上自己的航线，直飞 12 格！');
      const c = _ludoCell(k, to); if (c >= 0) hops.push(c);
    }
  }
  // 撞机：只在跑道上算，终点道里谁也碰不到谁
  let bump = null;
  const finalCell = _ludoCell(k, to);
  if (finalCell >= 0) {
    for (let i = 0; i < planes[other].length; i++) {
      if (planes[other][i] > 0 && planes[other][i] <= 20 && _ludoCell(other, planes[other][i]) === finalCell) {
        bump = { k: other, idx: i };
        notes.push(`撞上${_ludoWho(other)}的飞机，把它打回停机坪。`);
        break;
      }
    }
  }
  return { to, bump };
}

// 把试算结果落进局面，并把事件格的效果也结算掉。
function _ludoApply(k, idx, r) {
  _ludo.planes[k][idx] = r.to;
  if (r.bump) _ludo.planes[r.bump.k][r.bump.idx] = 0;
  r.notes.forEach(_ludoAdd);
  let again = r.again;
  _ludo.event = '';

  const cell = _ludoCell(k, r.to);
  const ev = cell >= 0 ? _ludoEventAt(cell) : -1;
  if (ev >= 0) {
    const eff = LUDO_EFFECTS[ev];
    const text = (LUDO_EVENTS[_ludo.theme] || LUDO_EVENTS.standard).texts[ev];
    _ludo.event = text;
    _ludoAdd(`【事件】${text}`);
    if (eff.kind === 'forward') _ludo.planes[k][idx] = Math.min(LUDO_GOAL, r.to + eff.n);
    else if (eff.kind === 'back') _ludo.planes[k][idx] = Math.max(1, r.to - eff.n);
    else if (eff.kind === 'again') again = true;

    // 事件把飞机挪了位置，就得**按新落点重新结算一次撞机**。
    // 漏了这一步的话会出现「两架飞机同格却相安无事」：比如用户从第 1 步掷 1 落到事件格，
    // 事件再送她前进 3 到第 5 步（跑道格 4），而 AI 正停在它的第 15 步（也是跑道格 4）——
    // 撞机在 _ludoResolve 里按事件**之前**的落点算过了，之后就没人再看一眼。
    // 只补撞机、不重新触发跳跃/航线：事件位移是格子给的，不该再连锁一层。
    const land = _ludo.planes[k][idx];
    const finalCell = _ludoCell(k, land);
    if (land !== r.to && finalCell >= 0) {
      const other = k === 'user' ? 'ai' : 'user';
      for (let i = 0; i < _ludo.planes[other].length; i++) {
        const os = _ludo.planes[other][i];
        if (os > 0 && os <= 20 && _ludoCell(other, os) === finalCell) {
          _ludo.planes[other][i] = 0;
          _ludoAdd(`被事件推着撞上${_ludoWho(other)}的飞机，把它打回停机坪。`);
          break;
        }
      }
    }
  }
  if (_ludo.planes[k][idx] >= LUDO_GOAL) _ludoAdd(`${_ludoWho(k)}有一架飞机到家了。`);
  return again;
}

// ── 谁能动 ──
function _ludoMovable(planes, k, d) {
  const out = [];
  for (let i = 0; i < planes[k].length; i++) if (_ludoResolve(planes, k, i, d).ok) out.push(i);
  return out;
}
function _ludoWin(k) { return _ludo.planes[k].every(s => s >= LUDO_GOAL); }
function _ludoCheck() {
  for (const k of ['user', 'ai']) if (_ludoWin(k)) { _ludo.over = true; _ludoAdd(`${_ludoWho(k)}两架都到家，赢了这一局！`); return true; }
  return false;
}

// AI 挑飞机：能撞就撞 > 能到家 > 能上航线 > 能同色跳 > 起飞 > 走最靠前的那架。
// 纯打分，不调模型（吐槽才调，见 _ludoAskSelectedAi）。
function _ludoPlan(planes, k, d) {
  let best = -1, bestScore = -Infinity;
  for (const i of _ludoMovable(planes, k, d)) {
    const r = _ludoResolve(planes, k, i, d);
    let sc = r.to;
    if (r.bump) sc += 100;
    if (r.to >= LUDO_GOAL) sc += 80;
    if (r.to - planes[k][i] > d + 4) sc += 60;        // 吃到了航线
    else if (r.to - planes[k][i] > d) sc += 40;       // 吃到了同色跳
    if (planes[k][i] === 0) sc += 30;                 // 停机坪里能出来就出来
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

// ── 一句吐槽 ──
// 和大富翁同一条路：选了真实模型才发请求，本地猫猫用预置台词，一次调用也不产生。
function _ludoQuip(kind) {
  const q = {
    roll: ['轮到我了，看骰子给不给面子。', '这一把要是 6，你就麻烦了。'],
    takeoff: ['起飞喽，别眨眼。', '总算等到一个 6。'],
    bump: ['不好意思啊，回停机坪吧。', '撞你这一下，我等很久了。'],
    hit: ['……我的飞机呢。', '行，这笔账记下了。'],
    fly: ['航线归我，先走一步。', '直飞十二格，爽。'],
    home: ['一架到家，还剩一架。', '快了快了。'],
    bad: ['骰子今天是不是不喜欢我。', '又是这种格子。'],
  };
  const a = q[kind] || q.roll;
  _ludo.quip = a[(_ludo.log.length + String(_ludo.aiId || '').length) % a.length];
}
async function _ludoAskSelectedAi(run) {
  if (_ludo.aiId === 'local') return;
  const conf = (state.configs || []).find(c => String(c.id) === String(_ludo.aiId));
  if (!conf || (!conf.apiKey && !conf.isLocalClaude && !conf.isLocalGpt && !conf.isGemini)) return;
  const th = LUDO_EVENTS[_ludo.theme] || LUDO_EVENTS.standard;
  const prompt = `你正在和${_ludoUserName()}玩飞行棋（版本：${th.name}）。你是${_ludoAiName()}，根据刚才的局面用自己的语气吐槽一句，最多30个汉字，不解释规则，不加引号。局面：${_ludo.log.slice(-3).join('；')}；你的两架飞机走到第 ${_ludo.planes.ai.join(' / ')} 步，${_ludoUserName()}的在第 ${_ludo.planes.user.join(' / ')} 步（24 步到家）。`;
  try {
    const r = await streamCompletion(conf, [{ role: 'user', content: prompt }], () => { });
    // 回来之前先确认还是同一局：请求飞了几秒，期间可能已经重新开局或关窗重开了。
    if (run !== undefined && run !== _ludoRun) return;
    const q = String(r.fullText || '').trim().replace(/\[\[[\s\S]*?\]\]/g, '').slice(0, 60);
    if (q) _ludo.quip = q;
  } catch { }
}

// ── 回合 ──
async function ludoRoll() {
  if (_ludo.over || _ludo.turn !== 'user' || _ludo.picking || _ludoAnimating) return;
  const run = ++_ludoRun;
  _ludoAnimating = true; _ludoAnimationWatchdog(run); renderLudo();
  const d = 1 + Math.floor(Math.random() * 6);
  _ludo.lastRoll = d;
  await _ludoRollAnimation(d);
  if (run !== _ludoRun) return;          // 期间被换代（关窗重开 / 看门狗），这一轮作废
  const can = _ludoMovable(_ludo.planes, 'user', d);
  _ludoAdd(`${_ludoUserName()}掷出 ${d}。`);
  if (!can.length) {
    _ludoAdd(d === 6 ? '没有能动的飞机（都到家了）。' : '没有 6，飞机还在停机坪。');
    _ludoAnimating = false; _ludoEndUserTurn(false); return;
  }
  // 只在**真的有得选**的时候才停下来问。两架停在同一步（最常见的是开局都在停机坪）时，
  // 走哪一架的结果一模一样，弹个选择框等于白让用户多点一次。
  const distinct = [...new Map(can.map(i => [_ludo.planes.user[i], i])).values()];
  if (distinct.length === 1) { await _ludoUserMove(distinct[0], d, run); return; }
  _ludo.picking = true; _ludoAnimating = false; _ludoSave(); renderLudo();
}
async function ludoPick(idx) {
  if (!_ludo.picking || _ludoAnimating) return;
  const run = ++_ludoRun;
  _ludo.picking = false; _ludoAnimating = true; _ludoAnimationWatchdog(run); renderLudo();
  await _ludoUserMove(idx, _ludo.lastRoll, run);
}
async function _ludoUserMove(idx, d, run) {
  const r = _ludoResolve(_ludo.planes, 'user', idx, d);
  if (!r.ok) { _ludoAnimating = false; _ludoEndUserTurn(false); return; }
  await _ludoPawnAnimation('user', r.hops);
  if (run !== _ludoRun) return;          // 动画途中被换代，别再落子
  const again = _ludoApply('user', idx, r);
  _ludoAnimating = false;
  _ludoEndUserTurn(again);
}
function _ludoEndUserTurn(again) {
  if (_ludoCheck()) { _ludoSave(); renderLudo(); return; }
  if (again) { _ludo.bonus = true; _ludoAdd('可以再掷一次。'); _ludoSave(); renderLudo(); return; }
  _ludo.bonus = false; _ludo.turn = 'ai';
  _ludoSave(); renderLudo();
  setTimeout(ludoAiTurn, 650);
}

async function ludoAiTurn() {
  if (_ludo.over || _ludo.turn !== 'ai') return;
  const run = ++_ludoRun;
  _ludoAnimating = true; _ludoAnimationWatchdog(run); _ludoQuip('roll'); renderLudo();
  const d = 1 + Math.floor(Math.random() * 6);
  _ludo.lastRoll = d;
  await _ludoRollAnimation(d);
  if (run !== _ludoRun) return;
  _ludoAdd(`${_ludoAiName()}掷出 ${d}。`);
  const idx = _ludoPlan(_ludo.planes, 'ai', d);
  let again = false;
  if (idx < 0) { _ludoAdd('它没有能动的飞机。'); _ludoQuip('bad'); }
  else {
    const before = _ludo.planes.ai[idx];
    const r = _ludoResolve(_ludo.planes, 'ai', idx, d);
    await _ludoPawnAnimation('ai', r.hops);
    if (run !== _ludoRun) return;
    again = _ludoApply('ai', idx, r);
    if (r.bump) _ludoQuip('bump');
    else if (_ludo.planes.ai[idx] >= LUDO_GOAL) _ludoQuip('home');
    else if (before === 0) _ludoQuip('takeoff');
    else if (_ludo.planes.ai[idx] - before > d + 4) _ludoQuip('fly');
    else _ludoQuip('roll');
  }
  _ludoAnimating = false;
  if (_ludoCheck()) { _ludoSave(); renderLudo(); return; }
  if (again && idx >= 0) {
    // 先落盘再等：这 650ms 里关窗口重开的话，不存就会退回到 AI 落子**之前**，
    // 而且 _ludoLoad 会把回合判给用户——等于 AI 白走一步，还倒贴一个回合。
    _ludoAdd(`${_ludoAiName()}可以再掷一次。`);
    _ludoSave(); renderLudo(); setTimeout(ludoAiTurn, 650); return;
  }
  _ludo.turn = 'user'; _ludo.bonus = false;
  // 先把这一回合的结果落盘**再**去要吐槽。模型请求可能要好几秒，这期间关窗口重开
  // 会从旧存档恢复，AI 刚走的那一步就没了。吐槽只是锦上添花，不该拿它当保存时机。
  _ludoSave(); renderLudo();
  await _ludoAskSelectedAi(run);
  if (run !== _ludoRun) return;      // 请求期间重开了局，这句吐槽属于上一局，别写进来
  _ludoSave(); renderLudo();
}

// ── 动画 ──
// WebView 上 anim.finished 有时候永远不 resolve（见大富翁同款注释），所以全都套 race。
async function _ludoRollAnimation(finalFace) {
  const die = document.querySelector('#ludoBody .ludo-die');
  if (!die) return;
  // 点数同时写进文字（兜底）和 data-face（CSS 用它画真正的骰子点）
  const face = n => { die.textContent = '⚀⚁⚂⚃⚄⚅'[n - 1]; die.setAttribute('data-face', n); };
  die.classList.remove('landed'); die.classList.add('rolling');
  for (let i = 0; i < 9; i++) { face(1 + Math.floor(Math.random() * 6)); await _ludoWait(65 + i * 8); }
  face(finalFace);
  die.classList.remove('rolling'); die.classList.add('landed');
  await _ludoWait(260);
}
async function _ludoPawnAnimation(k, hops) {
  if (!hops || !hops.length) return;
  const cells = [...document.querySelectorAll('#ludoBody .ludo-cell')];
  if (cells.length < 20 || !document.body?.appendChild) return;
  const pawn = document.createElement('div');
  pawn.className = 'ludo-moving-pawn';
  pawn.innerHTML = _ludoPlane(k);
  document.body.appendChild(pawn);
  const frames = [];
  for (let n = 0; n < hops.length; n++) {
    const rect = cells[hops[n]]?.getBoundingClientRect();
    if (!rect) continue;
    frames.push({
      left: (rect.left + rect.width / 2 - 15) + 'px',
      top: (rect.top + rect.height / 2 - 15) + 'px',
      // 机头朝着这一格的前进方向，落点放大一下
      transform: `rotate(${_ludoHeading(hops[n])}deg) scale(${n === hops.length - 1 ? 1.3 : 1})`,
    });
  }
  const duration = Math.max(480, hops.length * 170);
  if (frames.length) {
    try {
      const anim = pawn.animate(frames, { duration, easing: 'ease-in-out', fill: 'forwards' });
      await Promise.race([anim.finished, _ludoWait(duration + 250)]);
    } catch { await _ludoWait(duration); }
  }
  pawn.remove();
}
// 动画卡住的话，5 秒后强行解锁——不然整个面板就是个点不动的壳。
function _ludoAnimationWatchdog(run) {
  setTimeout(() => {
    // 过期的看门狗直接走开。不判这一句的话，AI 连掷 6 时上一代的定时器会把**下一代**
    // 正在跑的动画解锁、并把回合抢回给用户，两个回合同时写一份局面。
    if (run !== _ludoRun || !_ludoAnimating) return;
    _ludoRun++;                            // 换代，让还在跑的旧协程落子前自己退出
    _ludoAnimating = false;
    if (_ludo.turn === 'ai') { _ludo.turn = 'user'; _ludo.bonus = false; }
    _ludoAdd('动画超时，已自动解除锁定。');
    _ludoSave(); renderLudo();
  }, 5000);
}

// ── 渲染 ──
// 飞机是俯视剪影，颜色区分阵营（用户＝蓝，AI＝橘红），机头朝着环形跑道的前进方向。
const LUDO_PLANE_PATH = 'M12 1.6c.9 0 1.5 1 1.5 2.3v4.6l8.3 4.9v2.3l-8.3-2.3v4.1l2.3 1.9v1.7L12 20.6 8.2 22.1v-1.7l2.3-1.9v-4.1l-8.3 2.3v-2.3l8.3-4.9V3.9c0-1.3.6-2.3 1.5-2.3z';
function _ludoPlane(k, deg = 0) {
  return `<svg class="ludo-plane ${k === 'user' ? 'u' : 'a'}" viewBox="0 0 24 24" aria-hidden="true"${deg ? ` style="transform:rotate(${deg}deg)"` : ''}><path d="${LUDO_PLANE_PATH}"/></svg>`;
}
// 跑道格 cell 上飞机该朝哪：看下一格在哪个方向（顺时针绕环，机头 0°＝朝上）
function _ludoHeading(cell) {
  const [r1, c1] = LUDO_POS[cell % 20], [r2, c2] = LUDO_POS[(cell + 1) % 20];
  if (c2 > c1) return 90;
  if (r2 > r1) return 180;
  if (c2 < c1) return 270;
  return 0;
}
const LUDO_SVG = {
  start: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M9 7.5v9M15 7.5v9M9 12h6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
  jump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l7-7 7 7M5 19l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fly: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20C6 12 11 8 18 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-dasharray="2.2 3" stroke-linecap="round"/><path d="M15.5 3l5 3.8-4.4 4.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// [图标, 文字]。阵营靠格子的颜色区分，文字里不再重复写名字。
function _ludoCellLabel(i) {
  const t = LUDO_CELLS[i];
  if (t.startsWith('start')) return [LUDO_SVG.start, '起飞'];
  if (t.startsWith('jump')) return [LUDO_SVG.jump, '跳 4'];
  if (t.startsWith('fly')) return [LUDO_SVG.fly, '航线 12'];
  if (t === 'event') return ['<b class="ludo-q">?</b>', '事件'];
  return ['', ''];
}
function _ludoPawnsAt(cell) {
  let s = '';
  for (const k of ['user', 'ai'])
    for (const step of _ludo.planes[k]) if (step > 0 && step <= 20 && _ludoCell(k, step) === cell) s += _ludoPlane(k, _ludoHeading(cell));
  return s;
}
// 停机坪的机位：在坪里＝一架飞机，在跑道上＝显示走到第几步，到家＝对勾
function _ludoHangar(k) {
  return _ludo.planes[k].map(s => s === 0
    ? `<i class="slot in" title="在停机坪">${_ludoPlane(k)}</i>`
    : s >= LUDO_GOAL ? '<i class="slot home" title="已到家">✓</i>'
      : `<i class="slot out" title="在航线上，第 ${s} 步">${s}</i>`).join('');
}
function _ludoRunway(k) {
  let out = '';
  for (let step = 21; step <= LUDO_GOAL; step++) {
    const on = _ludo.planes[k].includes(step);
    out += `<i class="${on ? 'on' : ''}${step === LUDO_GOAL ? ' goal' : ''}">${on ? _ludoPlane(k, 90) : (step === LUDO_GOAL ? '🏁' : '·')}</i>`;
  }
  return out;
}
function _ludoHangarHtml(k, name) {
  return `<div class="ludo-hangar ${k === 'user' ? 'u' : 'a'}"><div class="lh-head">${_ludoPlane(k)}<b>${name}</b></div><div class="lh-slots">${_ludoHangar(k)}</div><small class="lh-steps">第 <b>${_ludo.planes[k].join(' / ')}</b> 步</small></div>`;
}

function renderLudo() {
  const b = document.getElementById('ludoBody');
  if (!b || !_ludo) return;
  const an = _ludoAiName(), th = LUDO_EVENTS[_ludo.theme] || LUDO_EVENTS.standard;
  const canRoll = _ludo.turn === 'user' && !_ludo.over && !_ludo.picking && !_ludoAnimating;
  const movable = _ludo.picking ? _ludoMovable(_ludo.planes, 'user', _ludo.lastRoll) : [];
  const faceN = _ludo.lastRoll || 5;   // 还没掷过时摆个 5 点当装饰

  b.innerHTML = `<div class="ludo-room">
  <div class="ludo-sky" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="ludo-room-title"><span>FLIGHT CHESS · ${escHtml(th.name.toUpperCase())}</span><small>${escHtml(th.desc)}</small></div>
  <div class="ludo-wrap">
    <div class="ludo-toolbar">
      <select id="ludoTheme" onchange="ludoSetTheme(this.value)" aria-label="选择版本">${Object.entries(LUDO_EVENTS).map(([k, v]) => `<option value="${k}" ${k === _ludo.theme ? 'selected' : ''}>${escHtml(v.name)}</option>`).join('')}</select>
      <select id="ludoAi" onchange="ludoSetAi(this.value)" aria-label="选择对手"><option value="local" ${_ludo.aiId === 'local' ? 'selected' : ''}>本地猫猫（不调用 AI）</option>${(state.configs || []).map(c => `<option value="${escHtml(String(c.id))}" ${String(c.id) === String(_ludo.aiId) ? 'selected' : ''}>${escHtml(c.nickname || 'AI')}</option>`).join('')}</select>
      <button onclick="ludoNew()">重新开局</button>
      <span>掷 6 起飞 · 同色跳 4 · 航线飞 12 · 精确到 24 步到家</span>
    </div>
    <div class="ludo-table">
      <div class="ludo-board">
        ${LUDO_CELLS.map((t, i) => {
    const [icon, label] = _ludoCellLabel(i), [r, c] = LUDO_POS[i], pawns = _ludoPawnsAt(i);
    return `<div class="ludo-cell ${t} tone${i % 4}${pawns ? ' occ' : ''}" style="grid-row:${r};grid-column:${c}"><span class="ludo-step">${i}</span><span class="ludo-face">${icon}</span><small>${escHtml(label)}</small><div class="ludo-pawns">${pawns}</div></div>`;
  }).join('')}
        <div class="ludo-center">
          <div class="ludo-radar" aria-hidden="true"></div>
          <div class="ludo-stats">${_ludoHangarHtml('user', escHtml(_ludoUserName()))}${_ludoHangarHtml('ai', escHtml(an))}</div>
          <div class="ludo-runways"><span>终点道</span><div class="ludo-runway u"><em>${_ludoPlane('user')}</em>${_ludoRunway('user')}</div><div class="ludo-runway a"><em>${_ludoPlane('ai')}</em>${_ludoRunway('ai')}</div></div>
          <div class="ludo-roller">
            <div class="ludo-die" onclick="ludoRoll()" data-face="${faceN}">${'⚀⚁⚂⚃⚄⚅'[faceN - 1]}</div>
            <div class="ludo-roll-side">
              <div class="ludo-turn">${_ludo.over ? '本局结束' : _ludo.picking ? '选一架飞机' : _ludo.turn === 'user' ? (_ludo.bonus ? `${escHtml(_ludoUserName())}再掷一次` : `轮到${escHtml(_ludoUserName())}`) : `${escHtml(an)} 正在行动`}</div>
              <button class="ludo-action" id="ludoRollBtn" onclick="ludoRoll()">🎲 掷骰子</button>
            </div>
          </div>
          ${_ludo.picking ? `<div class="ludo-choice"><b>掷出 ${_ludo.lastRoll}，走哪一架？</b>${movable.map(i => `<button class="ludo-action" onclick="ludoPick(${i})">${i + 1} 号机（第 ${_ludo.planes.user[i]} 步）</button>`).join('')}</div>` : ''}
          ${_ludo.event ? `<div class="ludo-event"><small>本轮动态</small><b>${escHtml(_ludo.event)}</b></div>` : ''}
          <div class="ludo-quips"><b>${escHtml(an)}</b><span>${escHtml(_ludo.quip || '')}</span></div>
        </div>
      </div>
    </div>
    <div class="ludo-log"><div class="ludo-log-title">对局记录<small>最新在前 · 可滚动</small></div>${_ludo.log.slice().reverse().map(x => `<div>› ${escHtml(x)}</div>`).join('')}</div>
  </div></div>`;

  // disabled 交给单一判定强制覆盖：模板里再写一遍条件，迟早会和这里长歪。
  const rollBtn = document.getElementById('ludoRollBtn');
  if (rollBtn) rollBtn.disabled = !canRoll;
  const die = b.querySelector('.ludo-die');
  if (die) die.classList.toggle('disabled', !canRoll);
}
