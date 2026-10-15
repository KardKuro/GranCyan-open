'use strict';
// 情绪动力学（用户改进清单第 1 条）
//
// 这套指标的危险之处在于**它永远算得出一个数**。喂给它一堆噪声、
// 一条时间倒着走的曲线、或者中间断了一整夜的曲线，它都会给你五个
// 看着挺像样的百分比 —— 没有任何一处会报错。所以这份测试的重点不是
// 「算得对不对」，是「该说不知道的时候它有没有说不知道」。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const ued = read('js/45-ued.js');
const vitals = read('js/30-vitals.js');
const html = read('index.html');
const css = read('css/grancyan.css');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');
const prompts = read('js/05-prompts-api.js');

function sandbox(opts = {}) {
  const noop = () => {};
  const el = { style: {}, dataset: {}, classList: { contains: () => false, add: noop, remove: noop, toggle: noop },
    innerHTML: '', textContent: '', checked: false };
  const box = {
    state: Object.assign({ uedOn: true, vitalsOn: true }, opts.state || {}),
    save: noop, showToast: noop,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: () => el, querySelectorAll: () => [] },
    vitalsEnabled: () => opts.state?.vitalsOn !== false,
    vitalsActiveConf: () => opts.conf === null ? null : (opts.conf || { id: 'm1', nickname: '克克' }),
    vitalsEnsure: () => opts.v || { history: [] },
    Math, Date, JSON, console, Object, Array, String, Number, Boolean, RegExp, Set, isNaN
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(ued + ';this.UED_DIMS = UED_DIMS; this.UED_MIN_N = UED_MIN_N;'
    + 'this.UED_MAX_GAP_H = UED_MAX_GAP_H; this.UED_BAND_MIN = UED_BAND_MIN;', box);
  return box;
}

const H = 3600000, MIN = 60000;
// 门槛本身从源码里读，别手抄 —— 抄了之后源码改了这条测试还是绿的
const UED_MAX_GAP_H_T = Number(/UED_MAX_GAP_H = ([\d.]+)/.exec(ued)[1]);
// 造一条曲线：从 t0 开始，每 step 分钟一个点，值由 fn 给
function curve(vals, stepMin = 10, t0 = 1700000000000, key = 'mood') {
  return vals.map((v, i) => ({ t: t0 + i * stepMin * MIN, [key]: v }));
}

// 造出走段用的。
// ⚠️ 上下**对称**是有讲究的：只往上冲的话，那几个高点会把均值一起拖高，
//    于是基线自己掉到 home base 下面，整条曲线变成「一直在常态外面」，
//    出走段全乱套。对称之后均值恰好落在基线上，测的才是想测的那件事。
//    （第一版就是没对称，四条断言一起红，而代码本身没问题。）
function cyc(up, down, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(...Array(10).fill(0.5), ...up.map(v => 0.5 + v), ...down.map(v => 0.5 + v));
    out.push(...Array(10).fill(0.5), ...up.map(v => 0.5 - v), ...down.map(v => 0.5 - v));
  }
  return out;
}
// 一步冲到顶，然后一级一级慢慢退回来
const FAST = { up: [0.4], down: [0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05] };
// 一级一级慢慢爬上去，然后一步回到基线
const SLOW = { up: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4], down: [] };

console.log('\n════ 情绪动力学 ════');

// ── 一、该说不知道的时候要说不知道 ─────────────────────────────────────
// 这一节比「算得准不准」重要得多：指标永远算得出个数，
// 拿噪声硬算出来的「性格」是彻头彻尾编的，而且零报错。
console.log('\n[1] 该说不知道的时候要说不知道');
{
  const b = sandbox();
  t('★ 点太少直接返回 null（不硬算）', b.uedFor(curve([0.3, 0.4, 0.5]), 'mood') === null);
  t('★ 空的/坏的输入不炸', b.uedFor(null, 'mood') === null && b.uedFor([], 'mood') === null
    && b.uedFor([{}, {}, {}], 'mood') === null);
  t('刚好够就算得出来', b.uedFor(curve(Array.from({ length: b.UED_MIN_N }, (_, i) => 0.3 + 0.01 * i)), 'mood') !== null);
  // 坏点要被剔掉，而不是变成 NaN 一路传染
  const dirty = curve(Array.from({ length: 20 }, () => 0.5));
  dirty[3].mood = 'abc'; dirty[5].mood = null; dirty[7].t = 'x';
  const m = b.uedFor(dirty, 'mood');
  t('★ 坏点被剔掉，指标不是 NaN', m && Object.values(m).every(x =>
    x === null || Array.isArray(x) || Number.isFinite(x)), m);
  t('剔掉之后 n 少了', m && m.n === 17, m && m.n);
}

// ── 二、常态区间 ───────────────────────────────────────────────────────
console.log('\n[2] 常态区间');
{
  const b = sandbox();
  // 一条几乎不动的曲线：标准差趋近 0
  const flat = b.uedFor(curve(Array.from({ length: 30 }, () => 0.4)), 'mood');
  t('★ 曲线不动的时候常态区间不会窄成一条线', flat.home[1] - flat.home[0] >= b.UED_BAND_MIN * 1.9,
    flat.home);
  // ★ 这才是那道下限真正在防的事
  t('★ 不动的曲线「出走」是 0%（没有下限的话会冲到 100%）', flat.density === 0, flat.density);
  t('起伏是 0', flat.sd === 0);

  // 一条来回摆的曲线
  const wob = [];
  for (let i = 0; i < 40; i++) wob.push(0.5 + (i % 2 ? 0.2 : -0.2));
  const w = b.uedFor(curve(wob), 'mood');
  t('摆得厉害的起伏就大', w.sd > 0.15, w.sd);
  t('常态区间围着均值', Math.abs((w.home[0] + w.home[1]) / 2 - w.mean) < 0.01, { home: w.home, mean: w.mean });
  t('峰谷记下来了', w.peak === 0.7 && w.trough === 0.3, { peak: w.peak, trough: w.trough });
}

// ── 三、上冲 / 回落的不对称 ───────────────────────────────────────────
// 这是整个功能的意义所在。分不出「起得快退得慢」和反过来，就白做了。
console.log('\n[3] 上冲 / 回落');
{
  const b = sandbox();
  const a = b.uedFor(curve(cyc(FAST.up, FAST.down, 4)), 'mood');
  const c = b.uedFor(curve(cyc(SLOW.up, SLOW.down, 4)), 'mood');
  t('★ 起得快退得慢：上冲 > 回落', a.rise > a.recover * 1.5, { rise: a.rise, recover: a.recover });
  t('★ 起得慢退得快：回落 > 上冲', c.recover > c.rise * 1.5, { rise: c.rise, recover: c.recover });
  t('两边都数出了好几段出走', a.episodes >= 3 && c.episodes >= 3, { a: a.episodes, c: c.episodes });
  t('★ 这个不对称能变成一句人话', /起得快、退得慢/.test(b.uedPhrase(a, '情绪') || ''),
    b.uedPhrase(a, '情绪'));
  t('★ 分不出来的时候不硬凑一句话', b.uedPhrase(b.uedFor(curve(Array.from({ length: 30 }, () => 0.4)), 'mood'), '情绪') === null);
  t('★ 出走次数太少就不下结论（两段平均不出性格）',
    b.uedPhrase({ rise: 9, recover: 0.1, episodes: 1 }, '情绪') === null);
}

// ── 四、时间是不均匀的 ─────────────────────────────────────────────────
// 这一节守的是这个功能最容易出错、而且完全不报错的地方。
console.log('\n[4] 时间是不均匀的');
{
  const b = sandbox();
  const shape = cyc(FAST.up, FAST.down, 4);
  // ★ 同样的形状，采样间隔差 6 倍，速率就该差 6 倍。按样本数算的话两边一样。
  const dense = b.uedFor(curve(shape, 5), 'mood');
  const sparse = b.uedFor(curve(shape, 30), 'mood');
  t('★ 速率是按真实时间算的，不是按样本数',
    dense.rise > sparse.rise * 4 && dense.rise < sparse.rise * 8,
    { 每5分钟: dense.rise, 每30分钟: sparse.rise });
  t('形状一样所以起伏一样', Math.abs(dense.sd - sparse.sd) < 1e-9);

  // ★ 中间断了一夜：那一段不许连起来算。
  //   造法：正常跑两轮攒出常态，最后冲到 0.9 —— 然后**断 9 小时**，回来已经好了。
  //   真实里这就是「聊到激动，去睡了，第二天醒来没事了」。
  const base = cyc(FAST.up, FAST.down, 2);
  const mkGap = gapH => {
    const a = curve(base.concat([0.9]), 10);
    const tn = a[a.length - 1].t;
    // ⚠️ 第一个点必须**正好**落在 gapH 上。原来从 i=1 开始，等于在空档上又加了
    //    10 分钟 —— 想测「1.9 小时没超门槛」，实际喂进去的是 2.07 小时，超了。
    //    于是两份都被丢掉，两条断言读数一模一样，看着像功能没做。
    for (let i = 0; i < 12; i++) a.push({ t: tn + gapH * H + i * 10 * MIN, mood: 0.5 });
    return b.uedFor(a, 'mood');
  };
  // 两份只差一件事：那个空档有没有超过门槛。9 小时超了（丢掉），
  // 1.9 小时没超（算进去，而且因为隔得久，会把回落的平均拖慢）。
  const gapd = mkGap(9), contd = mkGap(UED_MAX_GAP_H_T - 0.1);
  t('★ 隔了一夜的那一段不算进回落（算进去的话「睡醒就好了」会被当成「缓了 9 小时」）',
    gapd.recover > contd.recover, { 断了: gapd.recover, 没断: contd.recover });
  t('   对照：没超门槛的那份确实被算进去了（所以平均被拖慢了）',
    contd.recover !== null && contd.recover > 0 && contd.episodes === gapd.episodes + 1,
    { recover: contd.recover, 断了几段: gapd.episodes, 没断几段: contd.episodes });

  // ★ 时间乱序：云同步合并之后可能不是有序的
  const shuffled = curve(shape, 10).slice();
  const straight = b.uedFor(shuffled, 'mood');
  shuffled.reverse();
  const rev = b.uedFor(shuffled, 'mood');
  t('★ 输入乱序也算得对（自己会排一遍）',
    JSON.stringify(straight) === JSON.stringify(rev), { 正: straight.rise, 乱: rev.rise });
}

// ── 五、曲线得留得住 ───────────────────────────────────────────────────
// 指标算得再对，曲线被截断了也是白搭 —— 而且截断这件事一声不吭。
console.log('\n[5] 曲线得留得住');
{
  t('★ 曲线长度够算统计量了（48 个点算标准差是噪声）',
    /VITALS_CURVE_KEEP = (\d+)/.test(vitals) && Number(RegExp.$1) >= 200, RegExp.$1);
  t('往云上传的时候只带一小截', /VITALS_CLOUD_KEEP = \d+/.test(vitals));
  t('★ 合并的时候曲线是**并**不是挑（挑的话手机同步回来会把长曲线截断）',
    /_vitalsUnionHistory\(prev\.history, next\.history\)/.test(vitals));
  // 真跑一遍合并：本地长、云上短，合完不能变短
  const box = { state: {}, Math, Date, JSON, console, Object, Array, String, Number, Boolean, Set, isNaN,
    showToast: () => {}, save: () => {}, document: { getElementById: () => null },
    // 30-vitals.js 末尾挂了个 setInterval 的自主心跳，沙箱里得给它一个假的
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  box.window = box; box.globalThis = box; vm.createContext(box);
  // 30-vitals.js 的判据来自 heartbeat-core.js（页面里排在它前面），沙箱里也得先加载
  vm.runInContext(read('js/heartbeat-core.js'), box);
  vm.runInContext(vitals +';this._mergeVitals = _mergeVitals; this._vitalsUnionHistory = _vitalsUnionHistory;'
    + 'this.vitalsForCloud = vitalsForCloud; this.VITALS_CURVE_KEEP = VITALS_CURVE_KEEP;', box);
  const mk = (n, t0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 60000, mood: 0.5, arousal: 0.3, energy: 0.6, closeness: 0.5, stress: 0.2, bpm: 70 }));
  const local = { m1: { modelId: 'm1', updatedAt: 100, history: mk(200, 1000000) } };
  const cloud = { m1: { modelId: 'm1', updatedAt: 999, history: mk(40, 1000000) } };
  const merged = box._mergeVitals(local, cloud);
  t('★ 云上那份更新，但本地长曲线没被截掉', merged.m1.history.length === 200, merged.m1.history.length);
  // 云上有本地没有的新点，也要进来
  const cloud2 = { m1: { modelId: 'm1', updatedAt: 999, history: mk(5, 9000000) } };
  t('★ 两边的点是并起来的', box._mergeVitals(local, cloud2).m1.history.length === 205,
    box._mergeVitals(local, cloud2).m1.history.length);
  t('★ 同一个时间点不会并出两份', box._vitalsUnionHistory(mk(10, 5), mk(10, 5)).length === 10);
  t('往云上传的确实截短了', box.vitalsForCloud(local).m1.history.length <= 60,
    box.vitalsForCloud(local).m1.history.length);
}

// ── 六、给模型的话 ─────────────────────────────────────────────────────
console.log('\n[6] 给模型的话');
{
  const hist = curve(cyc(FAST.up, FAST.down, 4)).map(h => Object.assign({}, h, { arousal: 0.3, energy: 0.6, closeness: 0.5, stress: 0.2 }));
  const b = sandbox({ v: { history: hist } });
  const p = b.uedPromptFor({ id: 'm1' });
  t('算得出规律就告诉它', /起得快、退得慢/.test(p.volatile), p.volatile);
  t('★ 给的是结论不是数字（数字它只能复述）', !/\d+\s*点\/时|%/.test(p.volatile), p.volatile);
  t('★ 每轮都变的那半在 volatile，不在 stable（不然提示词缓存整段作废）',
    !/起得快/.test(p.stable) && p.stable.length > 0);

  const flat = sandbox({ v: { history: curve(Array.from({ length: 40 }, () => 0.4)).map(h => Object.assign(h, { arousal: 0.4, energy: 0.4, closeness: 0.4, stress: 0.4 })) } });
  const pf = flat.uedPromptFor({ id: 'm1' });
  t('一条规律都算不出来的时候 volatile 是空的', pf.volatile === '', pf);
  // 以前这里断言的是「算不出来连标题都不发」—— 那正是 stable 跟着数据翻的 bug：
  // 订阅 Claude 一翻就整段重开会话，10-01~10-02 实测翻了 12 次。
  t('★ stable 只看开关：算不算得出规律，stable 逐字节相同（不然提示词缓存/会话续传整段作废）',
    pf.stable === p.stable && pf.stable.length > 0, [pf.stable.length, p.stable.length]);

  const off = sandbox({ state: { uedOn: false, vitalsOn: true }, v: { history: hist } });
  t('★ 开关关着就什么都不发', off.uedPromptFor({ id: 'm1' }).volatile === '');
  const noVit = sandbox({ state: { uedOn: true, vitalsOn: false }, v: { history: hist } });
  t('★ 生命体征关了它也跟着不发（数据源都没了）', noVit.uedPromptFor({ id: 'm1' }).volatile === '');
}

// ── 七、面板 ───────────────────────────────────────────────────────────
console.log('\n[7] 面板');
{
  const hist = curve(cyc(FAST.up, FAST.down, 4)).map(h => Object.assign(h, { arousal: 0.3, energy: 0.6, closeness: 0.5, stress: 0.2 }));
  const b = sandbox({ v: { history: hist } });
  let painted = '';
  b.document.getElementById = () => ({ classList: { contains: () => false, toggle: () => {}, remove: () => {} },
    set innerHTML(v) { painted = v; }, get innerHTML() { return painted; }, checked: false });
  b.uedRender();
  t('五个维度都画了', b.UED_DIMS.every(d => painted.includes(d.label)), b.UED_DIMS.map(d => d.label));
  t('画了常态区间的带子', /ued-home/.test(painted));
  t('画了曲线', /ued-line/.test(painted));
  t('★ 抽屉里有那个开关（不然只能看不能关）', /id="uedToggle"/.test(painted));
  // 没有模型配置的时候别炸
  const nc = sandbox({ conf: null });
  nc.document.getElementById = () => ({ classList: { contains: () => false, toggle: () => {} },
    set innerHTML(v) { painted = v; }, get innerHTML() { return painted; } });
  nc.uedRender();
  t('★ 没有模型配置也不炸', /还没有模型配置/.test(painted));
}

// ── 八、接线 ───────────────────────────────────────────────────────────
console.log('\n[8] 接线');
t('脚本挂进了 index.html', /js\/45-ued\.js/.test(html));
t('★ 提示词是独立的 if，不寄生在生命体征那行里',
  /if \(typeof uedPromptFor === 'function'\) \{/.test(prompts));
t('生命体征面板上有入口', /toggleUed\(\)/.test(vitals));
t('★ 面板引用 _uedOpen 时有 typeof 守着（45 排在 30 后面，直接读是 ReferenceError）',
  /typeof _uedOpen !== 'undefined'/.test(vitals));
t('★ 功能指南里写了', /📈 情绪动力学/.test(html) && /常态区间/.test(html));
for (const c of ['ued-box', 'ued-row', 'ued-spark', 'ued-home', 'ued-line', 'ued-nums', 'ued-warn']) {
  t(`.${c} 有样式`, new RegExp('\\.' + c + '[\\s,.:{]').test(css));
}

// ── 九、持久化三道门 ───────────────────────────────────────────────────
console.log('\n[9] 持久化三道门');
t('uedOn ① 启动时读回来', /uedOn:\s*await g\(/.test(core));
t('uedOn ② save() 时写下去', /idbSet\('kuro_uedOn'/.test(stateJs));
t('uedOn ③ 启动时赋进 state', /state\.uedOn\s*=/.test(boot));
// ★ 默认开着的开关，判据必须是「不等于 false」
t('★ 默认开着：老档没这个字段不会变成关掉', /saved\.uedOn !== false/.test(boot));

// ── 十、安卓副本 ───────────────────────────────────────────────────────
console.log('\n[10] 安卓副本');
for (const f of ['js/45-ued.js', 'js/30-vitals.js', 'js/05-prompts-api.js', 'js/01-core.js',
  'js/02-state.js', 'js/14-boot-brain-hub.js', 'index.html', 'css/grancyan.css']) {
  t(`android 副本与 ${f} 一致`, read(f) === read('android/assets/' + f));
}

console.log(`\n════ ${pass} 过 / ${fail} 挂 ════\n`);
process.exit(fail ? 1 : 0);
