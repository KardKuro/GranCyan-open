// 生命体征与自主心跳核心回归测试。
// 跑法：node tests/vitals.test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};

const ctx = {
  console, Date, Math, String, Number, Object, Array, JSON, Set, Map,
  setInterval() {},
  setTimeout, clearTimeout,
  state: { vitalsOn: true, vitalsHeartbeatOn: true, vitalsByModel: {} },
  save() {},
  showToast() {},
  escHtml: s => String(s),
  document: { getElementById: () => null },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// 判据来自 heartbeat-core.js（页面里排在 30-vitals.js 前面），沙箱里同样先加载
vm.runInContext(read('heartbeat-core.js'), ctx);
vm.runInContext(read('30-vitals.js'), ctx);

const alice = { id: 'alice', nickname: 'Alice' };
const bob = { id: 'bob', nickname: 'Bob' };

console.log('\n[1] 每个模型有自己的身体');
const av = ctx.vitalsEnsure(alice);
const bv = ctx.vitalsEnsure(bob);
t('默认状态存在', av.modelId === 'alice' && bv.modelId === 'bob');
ctx._vitalsApply('情绪 80|唤醒 60|能量 25|亲近 90|压力 70|备注：刚听完一首喜欢的歌', alice);
t('AI 标签能更新多个状态', av.mood === 0.8 && av.arousal === 0.6 && av.energy === 0.25 && av.closeness === 0.9 && av.stress === 0.7);
t('模型状态不串台', bv.mood !== av.mood && !bv.note);
t('心率在安全范围内', ctx.vitalsHeartBpm(av) >= 48 && ctx.vitalsHeartBpm(av) <= 132);

console.log('\n[2] 心跳护栏和 did 接力');
const before = Date.now();
const scheduled = ctx._vitalsSchedule('999|我在等下一次醒来', alice);
t('超长排程被限制到最大值', scheduled.ok && av.scheduleMins === 360);
t('排程写入 did', av.lastDid === '我在等下一次醒来' && av.nextAt >= before + 359 * 60000);
ctx._vitalsSchedule('1|太快了', alice);
t('过短排程被限制到最小值', av.scheduleMins === 5);

console.log('\n[3] 指令解析、展示与历史回填');
const raw = '我还在想。\\n[[VITALS: 情绪 0.4|能量 0.7]]\\n[[HEARTBEAT: 15|等风停了再醒来]]';
const rendered = ctx.vitalsProcessTags(raw, alice, { isGroupChat: false });
t('生命体征指令被转换为展示块', rendered.includes('生命体征') && rendered.includes('自主心跳'));
const blocks = [{ type: 'text', text: raw }];
ctx._applyVitalsToBlocks(blocks);
t('blocks 路径也转换指令', !blocks[0].text.includes('[[VITALS:') && !blocks[0].text.includes('[[HEARTBEAT:'));
const api = ctx.vitalsTagForApi(rendered);
t('发回模型的是紧凑历史描述', api.includes('[生命体征更新]') && api.includes('[自主心跳]'));
t('流式阶段遮住半截标签', ctx.maskStreamingVitals('嗯 [[VITALS: 情绪 0.4') === '嗯 〔🫀〕');

console.log('\n[4] 开关与群聊边界');
const didBeforeGroup = av.lastDid;
const group = ctx.vitalsProcessTags('[[HEARTBEAT: 15|不应在群里排程]]', alice, { isGroupChat: true });
t('群聊不会创建自主心跳排程', group === '' && av.lastDid === didBeforeGroup);
ctx.state.vitalsOn = false;
t('关闭生命体征后不注入提示词', ctx.vitalsPromptFor(alice) === '');
ctx.state.vitalsOn = true;
ctx.state.vitalsHeartbeatOn = false;
t('关闭自主心跳时不接受排程', ctx.vitalsProcessTags('[[HEARTBEAT: 15|关闭测试]]', alice, { isGroupChat: false }) === '');

console.log('\n[5] 云端合并和提示词');
const merged = ctx._mergeVitals(
  { alice: { modelId: 'alice', mood: 0.1, updatedAt: 10 } },
  { alice: { modelId: 'alice', mood: 0.9, updatedAt: 20 }, bob: { modelId: 'bob', mood: 0.5, updatedAt: 20 } }
);
t('云端合并保留更新较晚的状态', merged.alice.mood === 0.9 && merged.bob.mood === 0.5);
const cloudCopy = ctx.vitalsForCloud({ alice: av });
t('云端副本不携带本机唤醒排程', cloudCopy.alice.nextAt === 0 && cloudCopy.alice.scheduleMins === 0 && av.nextAt > 0);
ctx.state.vitalsHeartbeatOn = true;
const prompt = ctx.vitalsPromptFor(alice);
t('提示词包含当前身体状态和协议', prompt.includes('生命体征') && prompt.includes('VITALS') && prompt.includes('HEARTBEAT'));
// 「她九点四十三去买东西了」这种 did 醒过之后还天天挂在提示词里，模型就当成她每天那个点都去
t('心跳还在等时 did 带着、并标明是几点写的便条', /上一轮接力 did（\d\d:\d\d 写的便条/.test(prompt) && prompt.includes(av.lastDid), prompt.split('\n').find(l => l.includes('did')));
const savedNext = av.nextAt;
av.lastDid = '她九点四十三去买东西了'; av.nextAt = 0;
t('★ 心跳醒过（nextAt 归零）后旧 did 不再进提示词', !ctx.vitalsPromptFor(alice).includes('九点四十三'));
av.nextAt = savedNext;

const core = read('01-core.js');
const cloudSettings = core.match(/const settings = \{([\s\S]*?)\n        \};/)?.[1] || '';
t('自主心跳授权不进入云端 settings', !cloudSettings.includes('vitalsHeartbeatOn') && cloudSettings.includes('vitalsForCloud'));
t('Android 生命体征脚本与桌面一致',
  fs.readFileSync(path.join(ROOT, 'js/30-vitals.js')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js/30-vitals.js'))));

console.log('\n[6] 自动补点：不指望 AI 主动写才有曲线');
// 2026-09-01 的真实故障：曲线整整一周没长过一个点，而所有功能都是好的。
// 这一段守的就是「没人喂它」不再发生。
// ⚠️ const 声明不会挂到 vm 的 context 对象上，`ctx.VITALS_AUTO_GAP_MS` 读出来是
//    undefined —— 拿它去做减法得到 NaN，而 NaN 会走进「时间戳坏掉」那条分支照样补点，
//    于是断言全绿却什么都没测到。必须在上下文里求值取真值。
vm.runInContext(read('45-ued.js'), ctx);
const AUTO_GAP_MS = vm.runInContext('VITALS_AUTO_GAP_MS', ctx);
const UED_GAP_H = vm.runInContext('UED_MAX_GAP_H', ctx);
t('取到的两个常量都是真数字（取不到的话下面几条会假绿）',
  Number.isFinite(AUTO_GAP_MS) && Number.isFinite(UED_GAP_H), AUTO_GAP_MS + ' / ' + UED_GAP_H);

const carol = { id: 'carol', nickname: 'Carol' };
const cv = ctx.vitalsEnsure(carol);
cv.history = [];
t('空曲线时立刻记下第一个点', ctx.vitalsAutoSample(carol) === true && cv.history.length === 1);
t('自动点标了 source=auto（面板和指标要分得出它不是 AI 写的）',
  cv.history[0].source === 'auto', JSON.stringify(cv.history[0]));
t('刚记过就不再记（否则每轮一个点，真信号会被填充物挤出曲线）',
  ctx.vitalsAutoSample(carol) === false && cv.history.length === 1);
// 把最后一点往前推到超过间隔，模拟「过了很久又聊天」。
cv.history[cv.history.length - 1].t = Date.now() - AUTO_GAP_MS - 60000;
t('隔得够久了会补一个新点', ctx.vitalsAutoSample(carol) === true && cv.history.length === 2);

// ★ 跨模块的不变量。这两个数字长在不同文件里，改任何一个都不会报错，
//   但只要间隔 ≥ 断开阈值，自动点就会把曲线切成一段段 —— 起落速率直接算不出来，
//   而屏幕上什么都不会提示。
t('★ 采样间隔必须小于情绪动力学的断开阈值（否则自动点会把曲线切断）',
  AUTO_GAP_MS < UED_GAP_H * 3600000,
  '采样 ' + (AUTO_GAP_MS / 60000) + ' 分钟 vs 断开 ' + (UED_GAP_H * 60) + ' 分钟');

// 关掉总开关就一个点都不该添 —— 她关掉它是不想要这套东西，不是只想少看几个数字。
// ⚠️ 必须先把间隔让开。上一条刚补过点，不推时间的话「离上次太近」这道会先返回 false，
//    开关那道根本轮不到 —— 注入把开关判断整个删掉，这条断言照样绿（故障注入实测红 0）。
ctx.state.vitalsOn = false;
cv.history[cv.history.length - 1].t = Date.now() - AUTO_GAP_MS - 60000;
const nBefore = cv.history.length;
t('生命体征关掉时不补点', ctx.vitalsAutoSample(carol) === false && cv.history.length === nBefore);
ctx.state.vitalsOn = true;

// ★ 挂载点本身也要守。函数写得再对，没人调用就等于没做 —— 而那种情况下
//   上面每一条断言照样全绿（它们都是直接调 vitalsAutoSample 的）。
//   这条走的是真实路径：AI 回复进来 → vitalsProcessTags → 曲线该长一个点。
const erin = { id: 'erin', nickname: 'Erin' };
const ev = ctx.vitalsEnsure(erin);
ev.history = [];
ctx.vitalsProcessTags('就是一句普通回复，一个标签都没有。', erin, { isGroupChat: false });
t('★ 普通一轮回复（AI 一个标签都没写）也会让曲线长一个点',
  ev.history.length === 1 && ev.history[0].source === 'auto',
  JSON.stringify(ev.history));

// AI 自己写了状态的那一轮，不该被自动点再顶一个上去。
const dave = { id: 'dave', nickname: 'Dave' };
const dv = ctx.vitalsEnsure(dave);
dv.history = [];
ctx._vitalsApply('情绪 70|唤醒 40', dave);
const afterAi = dv.history.length;
t('AI 刚写过 [[VITALS]]，同一轮不会再补一个自动点',
  afterAi === 1 && dv.history[0].source === 'ai' && ctx.vitalsAutoSample(dave) === false && dv.history.length === 1);

// 用户：「AI 老是会认错自己的心跳和我的心跳」。
// 生命体征里有它自己的心率，手环那段有她的心率，两段都得写明是谁的。
console.log('\n[认人] 两个心率各自写明是谁的');
const own = ctx.vitalsPromptFor(dave);
t('生命体征里的心率写明是它自己的、不是手环上的', /你自己此刻：心率 \d+ bpm（你的，不是用户手环上的）/.test(own), own.slice(0, 200));
// 2026-10-08：模型会拿自己的数值去推断她
t('生命体征写明它的数值≠用户的状态，用户的状态只看用户自己',
  /不是用户的读数/.test(own) && /用户什么状态，只看用户自己说的话和反应/.test(own) && /别替用户认领/.test(own));
const apiSrc = read('05-prompts-api.js');
const band = apiSrc.slice(apiSrc.indexOf("if (state.bandAiEnabled !== false && state.bandData?.ok)"), apiSrc.indexOf('bandSleepPromptText(bd, bandWho)'));
t('手环那段开头写明是用户的身体、不是 AI 的', /这是\$\{bandWho\}戴着的手环，下面全是\$\{bandWho\}的身体数据，不是你的/.test(band));
t('手环的心率行带上用户名', /\$\{bandWho\}今日: 步数/.test(band) && /\$\{bandWho\}最近心率: /.test(band));
t('「[手环数据」前缀没动（server 的系统提示指纹靠它剥掉这段）',
  band.includes('`\\n\\n[手环数据 - 小米手环') && /\\\[手环数据/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));

console.log('\n[7] 云端副本');
{
  const fay = { id: 'fay', nickname: 'Fay' };
  const fv = ctx.vitalsEnsure(fay);
  t('云端副本不带下一跳的排程时刻', ctx.vitalsForCloud({ fay: Object.assign({}, fv, { nextSetAt: 123 }) }).fay.nextSetAt === 0);
}

console.log('\n[8] 晨间「刚醒」的身体');
{
  const gus = { id: 'gus', nickname: 'Gus' };
  const gv = ctx.vitalsEnsure(gus);
  gv.energy = 0.9; gv.arousal = 0.8;
  const realNow = Date.now;
  const plan = ctx.HeartbeatCore.morningPlan(ctx.HeartbeatCore.localDay(realNow()), 'gus');
  try {
    Date.now = () => plan.at - 60e3;
    // 身体的时间戳也得拨到假时钟上：vitalsEnsure 会按「距 updatedAt 过了多久」衰减。
    // 白天跑时假时钟在过去、衰减量是 0；半夜跑时假时钟在六七个小时之后，
    // 不对齐的话 energy 先被衰减走，这条就只在夜里红（2026-10-07 01:2x 踩到）。
    gv.updatedAt = Date.now();
    ctx.vitalsMorningTick();
    t('没到它醒的时刻，身体不动', gv.energy === 0.9 && !gv.wokeDay);
    Date.now = () => plan.at + 60e3;
    ctx.vitalsMorningTick();
    t('★ 到点了身体换成刚醒的样子', gv.energy < 0.4 && gv.arousal < 0.25 && gv.wokeDay === plan.day, [gv.energy, gv.arousal]);
    t('刚醒记了一个曲线点', gv.history[gv.history.length - 1].source === 'morning');
    gv.energy = 0.9;
    ctx.vitalsMorningTick();
    t('★ 一天只套一次（不然它一上午都醒不过来）', gv.energy === 0.9);
  } finally { Date.now = realNow; }
}

console.log('\n[9] 生物钟：困意 / 精力跟着她的作息走（2026-10-03 clock）');
(async () => {
  const bj = s => Date.parse(s + '+08:00');
  const H = ctx.HeartbeatCore;
  const realNow = Date.now;
  const hal = { id: 'hal', nickname: 'Hal' };
  try {
    ctx.state.vitalsSleepPref = null;
    ctx.state.bandData = null;
    ctx.state.chats = [];
    Date.now = () => bj('2026-10-03T13:00:00');
    const hv = ctx.vitalsEnsure(hal);
    hv.energy = 0.6; hv.updatedAt = Date.now();
    Date.now = () => bj('2026-10-04T04:00:00');
    ctx.vitalsEnsure(hal);
    t('★ 下午一点到凌晨四点（她的作息里该睡了），读状态时精力往下走', hv.energy < 0.45, hv.energy);
    const nightE = hv.energy;
    Date.now = () => bj('2026-10-04T13:00:00');
    ctx.vitalsEnsure(hal);
    t('★ 到了白天又回来（App 关着的那几个小时也算进去了）', hv.energy > nightE + 0.15, [nightE, hv.energy]);

    Date.now = () => bj('2026-10-05T04:00:00');
    ctx.vitalsEnsure(hal);
    ctx._vitalsApply('能量 90', hal);
    Date.now = () => bj('2026-10-05T04:03:00');
    ctx.vitalsEnsure(hal);
    t('★ 不覆盖 AI 自己写的 [[VITALS]]：凌晨它说自己精神 90%，三分钟后还是 90% 上下', Math.abs(hv.energy - 0.9) < 0.01, hv.energy);

    hv.energy = 0.3; hv.updatedAt = Date.now();
    const p = ctx.vitalsPromptFor(hal);
    t('提示词里有生物钟那一句（按用户的作息）', /生物钟：现在 04:03，按用户的作息（02:30 睡 → 09:30 醒）/.test(p), p.match(/生物钟[^\n]*/));
    t('★ 困了：说话带困，但不许拿困退场，用户难过时困意让位', /你困了/.test(p) && /不许拿「我困了」结束对话/.test(p) && /用户难过的时候，困意让位/.test(p));
    Date.now = () => bj('2026-10-05T13:00:00');
    hv.energy = 0.3; hv.updatedAt = Date.now();
    t('白天累了不说成困', !/你困了/.test(ctx.vitalsPromptFor(hal)));

    console.log('  — 作息从哪来');
    t('什么都没有 → 默认窗，并标明是默认', ctx.vitalsSleepWindow().source === 'default');
    // ★ 启动那一阵：对话还没从盘里读出来就有人读了状态。之后对话到了，作息要立刻跟上，
    //   不能被「空表」缓存住半小时（那半小时它按默认窗困，还会把默认窗同步给 server）
    const nodes = {};
    let nid = 0;
    for (let d = 0; d < 6; d++) {
      const day = new Date(Date.parse('2026-09-28') + d * 864e5).toISOString().slice(0, 10);
      const next = new Date(Date.parse('2026-09-29') + d * 864e5).toISOString().slice(0, 10);
      const stamps = [];
      for (let h = 12; h <= 23; h++) stamps.push(bj(day + 'T' + String(h).padStart(2, '0') + ':10:00'));
      stamps.push(bj(next + 'T01:20:00'), bj(next + 'T08:30:00'));
      for (const ts of stamps) { nid++; nodes[nid] = { id: nid, role: 'user', timestamp: ts }; }
    }
    ctx.state.chats = [{ id: 1, nodes }];
    const fromMsgs = ctx.vitalsSleepWindow();
    t('★ 对话晚到了也立刻按她发消息的时间推（空表不缓存）', fromMsgs.source === 'messages' && fromMsgs.start === 90, fromMsgs);
    // 手环数据：近 5 晚凌晨 3:20 睡、10:40 醒
    const sleep7 = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.parse('2026-10-01') + i * 864e5).toISOString().slice(0, 10);
      sleep7.push({ TIMESTAMP: bj(d + 'T03:20:00'), WAKEUP_TIME: bj(d + 'T10:40:00'), TOTAL_DURATION: 440 });
    }
    ctx.state.bandData = { ok: true, sleep7 };
    const fromBand = ctx.vitalsSleepWindow();
    t('★ 有手环就跟手环（换了一批数据立刻重算，不等缓存过期）', fromBand.source === 'band' && fromBand.start === 200 && fromBand.end === 640, fromBand);
    ctx.vitalsSetSleepPref({ manual: true, start: 23 * 60, end: 7 * 60 });
    t('★ 她在设置里定了就按她定的', ctx.vitalsSleepWindow().source === 'manual' && ctx.vitalsSleepWindow().start === 1380);
    t('设置记下改的时刻（跨设备按它挑新的）', ctx.state.vitalsSleepPref.at === Date.now());
    ctx.vitalsSleepTimeChanged('end', '06:45');
    t('拨钟点存成分钟数', ctx.state.vitalsSleepPref.end === 405 && ctx.vitalsSleepWindow().end === 405);
    ctx.vitalsSleepTimeChanged('end', '乱填');
    t('乱填的钟点不存', ctx.state.vitalsSleepPref.end === 405);
    const a = { manual: true, start: 1, end: 2, at: 10 }, b = { manual: false, start: 3, end: 4, at: 20 };
    t('两台设备的设置按改的时刻挑新的', ctx._vitalsSleepPrefNewer(a, b) === b && ctx._vitalsSleepPrefNewer(b, a) === b && ctx._vitalsSleepPrefNewer(a, null) === a);
    const coreSrc = read('01-core.js');
    t('作息设置跟着云同步走（上传带着、两条合并路都按时刻挑）',
      /vitalsSleepPref: state\.vitalsSleepPref \|\| null/.test(cloudSettings)
      && (coreSrc.match(/_vitalsSleepPrefNewer\(/g) || []).length >= 2);
    t('作息设置会落盘、启动时读回来',
      /idbSet\('kuro_vitalsSleepPref'/.test(read('02-state.js')) && /g\('kuro_vitalsSleepPref'/.test(coreSrc)
      && /state\.vitalsSleepPref = saved\.vitalsSleepPref/.test(read('14-boot-brain-hub.js')));
    const panel = ctx._vitalsClockHtml();
    t('面板说得出现在困不困、跟着的是哪份作息', /生物钟/.test(panel) && /23:00 睡 → 06:45 醒（你在这里定的）/.test(panel), panel.slice(0, 300));
    t('手动定作息时有两个钟点可以拨', /id="vitalsSleepStart"/.test(panel) && /id="vitalsSleepEnd"/.test(panel));

    console.log('  — 同步给 server');
    // ★ 真实路径：hbSync 发给 server 的那份作息就是生物钟跟着的那份（不是另推一遍的消息作息），
    //   上下文里带着精力和它的时刻（App 关着时 server 用它把钟点往后推）
    const sent = [];
    ctx.SERVER_BASE = 'http://x';
    ctx.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return { status: 200, json: async () => ({ ok: true }) }; };
    const chat = { id: 9, headId: null, nodes: {} };
    ctx.state.configs = [hal];
    ctx.getActiveChat = () => chat;
    ctx.getActiveChatModelIds = () => ['hal'];
    ctx.getMessagePath = () => [];
    await ctx.hbSync();
    const body = sent[sent.length - 1] || {};
    t('★ 同步上去的作息 = 生物钟用的那份（她手动定的也让 server 夜里按它不吵她）',
      body.sleep && body.sleep.source === 'manual' && body.sleep.end === 405, body.sleep);
    const cx = body.target && body.target.context;
    t('★ 上下文带着精力和它的时刻', cx && cx.energy === hv.energy && cx.energyAt === Date.now(), cx && [cx.energy, cx.energyAt]);
  } finally {
    Date.now = realNow;
    ctx.state.vitalsSleepPref = null;
  }
  console.log('\n[面板] 心率小曲线');
  {
    // 2026-10-09：原来按 0~130 bpm 画，心率在 70~82 之间晃时起伏只占框高的一成，看着是一条平线
    const hist = [70, 82, 74, 80, 71].map((bpm, i) => ({ t: 1000 + i * 60000, bpm, source: i === 2 ? 'ai' : 'auto' }));
    const html = ctx._vitalsSpark({ history: hist });
    const ys = ((html.match(/<polyline points="([^"]+)"/) || [])[1] || '').split(' ').map(p => Number(p.split(',')[1]));
    const range = Math.max(...ys) - Math.min(...ys);
    t('★ 纵轴跟着数据自己的高低走（起伏占满框高大半）', ys.length === 5 && range > 60, ys);
    t('AI 自己写的点单独标出来', (html.match(/vitals-spark-dot ai" style=/g) || []).length === 1, html.slice(0, 200));
    const flat = ctx._vitalsSpark({ history: [{ t: 1, bpm: 75 }, { t: 2, bpm: 76 }] });
    const fy = ((flat.match(/<polyline points="([^"]+)"/) || [])[1] || '').split(' ').map(p => Number(p.split(',')[1]));
    t('几乎不变时不把 1 bpm 的抖动放大成过山车', Math.abs(fy[0] - fy[1]) < 10, fy);
  }
  console.log('\n[面板] 能滚、有 ✕');
  {
    // 2026-10-09：搬进 hub 后面板 height:100%，.hub-content 又是 overflow:hidden，没人滚 ——
    // 1280×900 的桌面上底下的按钮和「App 关着也能找你」够不着
    const css = fs.readFileSync(path.join(ROOT, 'css/grancyan.css'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const shell = (html.match(/<div id="vitalsHubHome"[\s\S]*?<div id="vitalsPanel"/) || [''])[0];
    t('★ 面板外壳带 vitals-panel，在 hub 里自己负责滚',
      /class="dreams-panel vitals-panel"/.test(shell) && /\.vitals-panel\.in-hub\{[^}]*overflow-y:auto/.test(css));
    t('右上角有 ✕，点了回上一级（没有上一级才关 hub，判据在 widget-back.test.js）', /class="vitals-x" onclick="hubCloseOrBack\(\)"/.test(shell));
  }
  console.log('\n[面板] 机械皮');
  {
    // 2026-10-09：电平表是 20 格 LED，亮格按 5% 进位、少 1px 停在格缝里；读数照旧精确
    const m = ctx._vitalsMeter('情绪', 0.58, 'mood', '柔软');
    t('电平表亮到 60%（58 进位），读数还是 058', /width:calc\(60% - 1px\)/.test(m) && /<b>058<\/b>/.test(m), m);
    t('0 的时候一格都不亮', /width:calc\(0% - 1px\)/.test(ctx._vitalsMeter('压力', 0, 'stress')));
    t('心核和走纸心电跟着 bpm 走（60 bpm = 1 秒一拍）',
      /--beat:1\.00s/.test(ctx._vitalsCoreHtml(60)) && /--beat:0\.50s/.test(ctx._vitalsEcgHtml(120)));
    // 监护屏在米纸上留黑：浅色补丁要是又去翻它，深色变量配浅色底，字就看不见了
    const lp = fs.readFileSync(path.join(ROOT, 'css/light-patch.css'), 'utf8');
    t('★ 米纸补丁不碰监护屏', !/\.vitals-(card|bar|spark|did|next)\b/.test(lp));
  }
  console.log('\n[面板] 心核里住着的小家伙');
  {
    // 用户画的两只。Claude 面板住AI，Gemini 住哈基米，别家的模型还是那颗心
    const k = ctx._vitalsPetKind;
    t('订阅 Claude / 订阅 Gemini 认得出来', k({ isLocalClaude: true, modelName: 'claude-local' }) === 'claude' && k({ isGemini: true, modelName: 'gemini' }) === 'gemini');
    t('API 配的按模型名认（claude-opus-5-5、gemini-2.5-pro）', k({ modelName: 'claude-opus-5-5' }) === 'claude' && k({ modelName: 'gemini-2.5-pro' }) === 'gemini');
    t('★ 别家的不乱认（订阅 GPT、deepseek）', k({ isLocalGpt: true, modelName: 'gpt-local' }) === '' && k({ modelName: 'deepseek-chat' }) === '' && k(null) === '');
    const withPet = ctx._vitalsCoreHtml(60, 'claude'), plain = ctx._vitalsCoreHtml(60, '');
    t('Claude 的心核里是它，没有那颗心', /has-pet pet-claude/.test(withPet) && /img\/vitals\/claude\.png/.test(withPet) && !/vitals-heart/.test(withPet), withPet.slice(-200));
    t('认不出来的还是那颗心', /vitals-heart/.test(plain) && !/vitals-pet/.test(plain));
    t('★ 两张图真的在 img/vitals/ 里（漏了就是一个裂图）',
      ['claude', 'gemini'].every(n => fs.existsSync(path.join(ROOT, 'img/vitals', n + '.png')) && fs.existsSync(path.join(ROOT, 'android/assets/img/vitals', n + '.png'))));
  }
  console.log('\n[面板] 选模型的下拉');
  {
    // 2026-10-09：原生 <select> 不跟主题色、没分组，换成自己画的。分组读 modelGroups（03-chats-models.js）
    const kk = { id: 11, nickname: '小克', modelName: 'claude-sonnet-4-6', group: '克克们' };
    const gm = { id: 12, nickname: 'Gemini', modelName: 'gemini', isGemini: true };
    const gpt = { id: 13, nickname: '订阅 GPT', modelName: 'gpt-local', isLocalGpt: true };
    const saved = ctx.state.configs;
    ctx.state.configs = [kk, gm, gpt];
    ctx.modelGroups = () => [{ name: '克克们', path: '克克们', depth: 1, items: [{ c: kk }] }, { name: '', path: '', depth: 0, items: [{ c: gm }, { c: gpt }] }];
    const h = ctx._vitalsPickHtml(kk);
    t('按分组排：组名在，没分组的归到「未分组」', /vitals-pick-group">克克们<b>1<\/b>/.test(h) && /vitals-pick-group">未分组<b>2<\/b>/.test(h) && h.indexOf('克克们') < h.indexOf('未分组'), h.slice(0, 300));
    t('当前选中的那个高亮，三个模型都在', /class="vitals-pick-item on pet-claude" data-id="11"/.test(h) && /data-id="12"/.test(h) && /data-id="13"/.test(h) && (h.match(/vitals-pick-item on/g) || []).length === 1);
    t('圆点按家族上色：Gemini 蓝、GPT 不沾', /vitals-pick-item pet-gemini" data-id="12"/.test(h) && /class="vitals-pick-item" data-id="13"/.test(h));
    t('★ 隐藏的 #vitalsModelSelect 还在、值是当前模型（vitalsActiveConf 从它读）', /<input type="hidden" id="vitalsModelSelect" value="11">/.test(h) && !/<select/.test(h));
    delete ctx.modelGroups;
    const flat = ctx._vitalsPickHtml(gm);
    t('拿不到分组也不炸：一列平铺、不出组头', !/vitals-pick-group/.test(flat) && (flat.match(/vitals-pick-item/g) || []).length === 3);
    ctx.state.configs = saved;
  }
  console.log('\n' + (fail ? '❌' : '✅') + ' ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 测试自己炸了：' + (e && e.stack || e)); process.exit(1); });
