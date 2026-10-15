// 心跳判定核心（js/heartbeat-core.js）：作息推断、谁来发、晨间时刻、随机游走。
// 页面和 server 共用这一份，这里测的就是两边都要认的那套规矩。
// 跑法：node tests/heartbeat-core.test.js
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const core = require('../js/heartbeat-core');

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== '' ? ' :: ' + JSON.stringify(detail) : '')); }
};
// 北京时间 → 时间戳
const bj = (s) => Date.parse(s + '+08:00');
const seeded = (seed) => { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; };

console.log('\n[1] 两种加载方式拿到的是同一套');
{
  const box = {}; box.globalThis = box; vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/heartbeat-core.js'), 'utf8'), box);
  t('<script> 加载挂到 HeartbeatCore 上', !!box.HeartbeatCore && typeof box.HeartbeatCore.serverDecision === 'function');
  t('require 加载拿到 module.exports', typeof core.serverDecision === 'function');
  t('两边的节制规矩一模一样', JSON.stringify(box.HeartbeatCore.RULES) === JSON.stringify(core.RULES));
}

console.log('\n[2] 作息：从她发消息的时间推出来');
{
  // 连着 10 晚：凌晨 3:00 左右最后一条，上午 10:30 左右第一条；白天每小时都说话
  const ts = [];
  for (let d = 1; d <= 10; d++) {
    const day = '2026-09-' + String(10 + d).padStart(2, '0');
    const next = '2026-09-' + String(11 + d).padStart(2, '0');
    for (let h = 11; h <= 23; h++) ts.push(bj(day + 'T' + String(h).padStart(2, '0') + ':15:00'));
    ts.push(bj(next + 'T00:40:00'), bj(next + 'T02:' + String(40 + d).padStart(2, '0') + ':00'));
    ts.push(bj(next + 'T10:' + String(20 + d).padStart(2, '0') + ':00'));
  }
  const now = bj('2026-09-22T12:00:00');
  const s = core.inferSleep(ts, now);
  t('数据够就是有把握的', s.confident && s.nights >= 8, s);
  t('入睡推在凌晨三点前后（最后一条之后再挪 10 分钟）', s.start >= 165 && s.start <= 190, core.fmtMinute(s.start));
  t('醒来推在十点半前后', s.end >= 620 && s.end <= 635, core.fmtMinute(s.end));
  t('只有两晚的数据就不装有把握，退回默认窗', !core.inferSleep(ts.slice(-24), now).confident, core.inferSleep(ts.slice(-24), now));
  t('★ 下午那段空白不算睡觉（她出门了）',
    !core.inferSleep([bj('2026-09-20T13:00:00'), bj('2026-09-20T19:00:00'), bj('2026-09-21T13:00:00'), bj('2026-09-21T19:00:00'),
      bj('2026-09-22T13:00:00'), bj('2026-09-22T19:00:00')], bj('2026-09-23T00:00:00')).confident);
  // 跨午夜的中位数：23:50 和 00:10 的「中间」是午夜，不是中午
  t('★ 跨午夜取中位数不会算成中午', core.circularMedian([23 * 60 + 50, 10]) % 1440 < 30 || core.circularMedian([23 * 60 + 50, 10]) > 1400,
    core.circularMedian([23 * 60 + 50, 10]));
  t('坏数据不炸', core.inferSleep(null, now).confident === false && core.inferSleep(['x', NaN, -1], now).nights === 0);
}

console.log('\n[3] 她睡着没有');
{
  const sleep = { start: 180, end: 630, confident: true };   // 03:00 → 10:30
  t('凌晨五点算睡着', core.isAsleep(bj('2026-09-23T05:00:00'), sleep, 0));
  t('中午一点算醒着', !core.isAsleep(bj('2026-09-23T13:00:00'), sleep, 0));
  t('作息窗两头有余量（10:40 还算睡着）', core.isAsleep(bj('2026-09-23T10:40:00'), sleep, 0));
  t('★ 刚说过话就是醒着，不管作息表怎么写',
    !core.isAsleep(bj('2026-09-23T05:00:00'), sleep, bj('2026-09-23T04:50:00')));
  t('一小时前说的话不算（可能说完就睡了）',
    core.isAsleep(bj('2026-09-23T06:00:00'), sleep, bj('2026-09-23T04:50:00')));
  t('★ 不按钟点硬切：她要是 23 点睡、7 点起，凌晨 0 点就算睡着',
    core.isAsleep(bj('2026-09-23T00:30:00'), { start: 23 * 60, end: 7 * 60, confident: true }, 0));
  t('作息窗没给就用默认（02:30→09:30）', core.isAsleep(bj('2026-09-23T04:00:00'), null, 0) && !core.isAsleep(bj('2026-09-23T15:00:00'), null, 0));
  const ends = core.sleepEndsAt(bj('2026-09-23T05:00:00'), sleep);
  t('作息窗结束时刻 = 醒来 + 余量', ends === bj('2026-09-23T10:50:00'), new Date(ends).toISOString());
}

console.log('\n[4] 谁来发：页面在跟前就归页面');
{
  const now = bj('2026-09-23T15:00:00');
  t('可见 + 刚碰过 = 在跟前', core.isAttended(true, now - 60e3, now));
  t('可见但半小时没碰 = 人不在', !core.isAttended(true, now - 30 * 60e3, now));
  t('不可见 = 人不在', !core.isAttended(false, now, now));
  const base = { serverReachable: true, serverEnabled: true, serverCanGenerate: true, attended: false };
  t('★ 人不在、server 接得住 → 页面让给 server', core.pageShouldYield(base));
  t('人在跟前 → 页面自己发', !core.pageShouldYield(Object.assign({}, base, { attended: true })));
  t('★ 连不上 server → 页面照旧自己发（不能因为加了 server 反而哑掉）', !core.pageShouldYield(Object.assign({}, base, { serverReachable: false })));
  t('推送没开 → 页面自己发', !core.pageShouldYield(Object.assign({}, base, { serverEnabled: false })));
  t('server 调不动这个模型 → 页面自己发', !core.pageShouldYield(Object.assign({}, base, { serverCanGenerate: false })));
}

console.log('\n[5] server 发不发（节制）');
{
  const now = bj('2026-09-23T15:00:00');
  const slot = { kind: 'heartbeat', key: 'm:hb:1', at: now - 60e3 };
  const ok = { now, slot, enabled: true, hasNtfy: true, canGenerate: true, claimedBy: '', attendedAt: 0, failUntil: 0,
    sleep: { start: 180, end: 630, confident: true }, lastUserAt: now - 3 * 3600e3, pushLog: [] };
  const d = (patch) => core.serverDecision(Object.assign({}, ok, patch));
  t('全都满足 → 发', d({}).fire, d({}));
  t('推送没开 → 不发', !d({ enabled: false }).fire);
  t('没填 ntfy → 不发', !d({ hasNtfy: false }).fire);
  t('没到点 → 不发', !d({ slot: null }).fire);
  t('★ 这一跳已被页面领走 → 不发（防双发）', !d({ claimedBy: 'page' }).fire);
  t('★ 页面 150 秒内说她在看 → 不发（防双发）', !d({ attendedAt: now - 60e3 }).fire);
  t('页面报的「在看」过期了 → 照发', d({ attendedAt: now - 10 * 60e3 }).fire);
  t('★ 她睡着 → 等她醒', !d({ now: bj('2026-09-23T05:00:00'), lastUserAt: bj('2026-09-23T02:50:00'), slot: Object.assign({}, slot, { at: bj('2026-09-23T04:59:00') }) }).fire);
  t('时钟歪了的「未来」消息不算她刚说过话', core.isAsleep(bj('2026-09-23T05:00:00'), ok.sleep, bj('2026-09-23T12:00:00')));
  t('★ 离上一条太近 → 不发', !d({ pushLog: [now - 20 * 60e3] }).fire);
  t('隔够了 → 发', d({ pushLog: [now - 60 * 60e3], lastUserAt: now - 30 * 60e3 }).fire);
  const six = [1, 2, 3, 4, 5, 6].map(h => now - h * 3600e3 + 60e3);
  t('★ 24 小时内够 6 条了 → 不发', !d({ pushLog: six, lastUserAt: now - 60e3 * 2 }).fire);
  t('★ 她上次说话之后已推了 2 条没回 → 闭嘴', !d({ pushLog: [now - 3 * 3600e3 + 60e3, now - 2 * 3600e3] }).fire);
  t('她回过话了 → 计数清零', d({ pushLog: [now - 3 * 3600e3 + 60e3, now - 2 * 3600e3], lastUserAt: now - 3600e3 }).fire);
  t('欠了一整天的心跳作废（server 停过机）', d({ slot: Object.assign({}, slot, { at: now - 20 * 3600e3 }) }).drop === true);
  t('生成失败后的冷却期 → 不发', !d({ failUntil: now + 60e3 }).fire);
  t('每个「不发」都有一句人话', ['enabled', 'hasNtfy', 'claimedBy'].every(k => d({ [k]: k === 'claimedBy' ? 'server' : false }).reason.length > 2));
}

console.log('\n[6] 到点的那一跳');
{
  const now = bj('2026-09-23T15:00:00');
  const s = core.dueSlot({ nextAt: now - 1000, nextSetAt: 123, heartbeatOn: true }, now, 'm1');
  t('心跳到点', s && s.kind === 'heartbeat' && s.key === 'm1:hb:123', s);
  t('还没到点', core.dueSlot({ nextAt: now + 60e3, nextSetAt: 1, heartbeatOn: true }, now, 'm1') === null);
  t('★ 没放行自主心跳 → 什么都不是到点', core.dueSlot({ nextAt: now - 1000, nextSetAt: 1, heartbeatOn: false }, now, 'm1') === null);
  t('生命体征关了 → 也不醒', core.dueSlot({ nextAt: now - 1000, nextSetAt: 1, heartbeatOn: true, vitalsOn: false }, now, 'm1') === null);
  t('★ 同一跳两边算出的 key 一样（抢的就是它）',
    core.dueSlot({ nextAt: now - 1, nextSetAt: 777, heartbeatOn: true }, now, 'x').key === core.dueSlot({ nextAt: now - 5, nextSetAt: 777, heartbeatOn: true }, now + 1, 'x').key);
}

console.log('\n[7] 晨间「刚醒」');
{
  const p = core.morningPlan('2026-09-23', 'm1');
  t('时刻落在 6~9 点之间', p.minute >= 360 && p.minute < 540, core.fmtMinute(p.minute));
  t('★ 同一天同一个模型，算多少次都是同一刻（页面和 server 不用商量）', core.morningPlan('2026-09-23', 'm1').at === p.at);
  const days = new Set(); for (let d = 1; d <= 20; d++) days.add(core.morningPlan('2026-09-' + String(d).padStart(2, '0'), 'm1').minute);
  t('每天不一样（是随机的）', days.size >= 12, days.size);
  t('不同模型各醒各的', core.morningPlan('2026-09-23', 'm1').minute !== core.morningPlan('2026-09-23', 'm2').minute
    || core.morningPlan('2026-09-24', 'm1').minute !== core.morningPlan('2026-09-24', 'm2').minute);
  t('没到点不醒', core.morningDue(p.at - 60e3, 'm1', '') === null);
  t('到点了醒', !!core.morningDue(p.at + 60e3, 'm1', ''));
  t('★ 今天醒过了就不再醒', core.morningDue(p.at + 60e3, 'm1', '2026-09-23') === null);
  t('她睡到中午也还能补一句；过了 13 点就算了', !!core.morningDue(bj('2026-09-23T12:30:00'), 'm1', '') && core.morningDue(bj('2026-09-23T13:30:00'), 'm1', '') === null);
  const slot = core.dueSlot({ nextAt: 0, heartbeatOn: true, morningDay: '' }, p.at + 60e3, 'm1');
  t('没有排心跳时，晨间那一下就是到点的一跳', slot && slot.kind === 'morning' && slot.key === 'm1:morning:2026-09-23', slot);
  const patch = core.morningPatch({ stress: 0.5, mood: 0.5 }, seeded(1));
  t('刚醒：没力气、不绷着', patch.energy < 0.4 && patch.arousal < 0.25 && patch.stress <= 0.18, patch);
  t('有一句身体备注', /刚醒/.test(patch.note));
}

console.log('\n[9] server 生成回来的话怎么拆');
{
  const a = core.parseWakeReply('想你了。\n[[HEARTBEAT: 90|等她忙完]]');
  t('正文和下一跳拆开', a.text === '想你了。' && !a.silent && a.schedule.mins === 90 && a.schedule.did === '等她忙完', a);
  t('[[SILENT]] = 不说', core.parseWakeReply('[[SILENT]]').silent);
  t('[[SILENT]] + 排了下一跳 = 不说但记下排程', (() => { const r = core.parseWakeReply('[[SILENT]]\n[[HEARTBEAT: 30|再等等]]'); return r.silent && r.schedule.mins === 30; })());
  t('排程夹在 5~360 分钟', core.parseWakeReply('嗯[[HEARTBEAT: 9999|x]]').schedule.mins === 360 && core.parseWakeReply('嗯[[HEARTBEAT: 1|x]]').schedule.mins === 5);
  t('其它指令剥掉（这里用不了表情包和记忆）', core.parseWakeReply('早[[STICKER:猫]][[BRAIN_ADD: 1|0|0|x|y]]').text === '早');
  t('空回复算不说', core.parseWakeReply('  ').silent);
}

console.log('\n[10] 生物钟：困意 / 精力跟着她的作息走（2026-10-03 clock）');
{
  const at = (hm, day = '2026-10-03') => bj(day + 'T' + hm + ':00');
  const late = { start: 150, end: 570 };      // 她：02:30 睡 → 09:30 醒（默认窗也是这个）
  const early = { start: 23 * 60, end: 7 * 60 };
  const c = (hm, s = late) => core.circadian(at(hm), s);
  t('她平时睡着的钟点最困', c('05:30').sleepy > 0.85 && c('05:30').phase === 'night', c('05:30'));
  t('白天精神（困意几乎为零）', c('13:00').sleepy < 0.12 && c('13:00').phase === 'day', c('13:00'));
  t('她平时醒来后那一阵迷糊', c('09:45').phase === 'waking' && c('09:45').sleepy > 0.25, c('09:45'));
  t('白天有一阵浅浅的乏（醒着 45% 处，她 9:30 起 → 傍晚五点多）',
    c('17:10').phase === 'dip' && c('17:10').sleepy > 0.15 && c('17:10').sleepy < 0.4, c('17:10'));
  t('睡前两个半小时困意慢慢上来', c('01:40').phase === 'evening' && c('01:40').sleepy > c('00:30').sleepy, [c('01:40'), c('00:30')]);
  t('★ 跟着她的作息平移：凌晨一点，早睡的人已经很困，她还撑着',
    core.circadian(at('01:00'), early).sleepy > 0.7 && c('01:00').sleepy < 0.4, [core.circadian(at('01:00'), early).sleepy, c('01:00').sleepy]);
  t('★ 早上八点：早睡早起的人已经醒透，她这会儿还在睡的钟点',
    core.circadian(at('08:30'), early).sleepy < 0.2 && c('08:30').sleepy > 0.6);
  let maxJump = 0, prev = null;
  for (let m = 0; m <= 1440; m++) {
    const s = core.circadian(at('00:00') + m * 60e3, late).sleepy;
    if (prev != null) maxJump = Math.max(maxJump, Math.abs(s - prev));
    prev = s;
  }
  t('★ 一整天没有突然跳一下（各段衔接是连着的）', maxJump < 0.05, maxJump);
  t('作息窗推坏了（睡 1 小时）就按默认走，不出怪曲线',
    core.circadian(at('05:30'), { start: 300, end: 360 }).sleep.start === core.DEFAULT_SLEEP.start);

  console.log('  — 精力：衰减 + 钟点起落');
  // 原来的衰减是往 0.58 回；现在是往「0.58 + 此刻的钟点偏移」回，速度不变
  const old = (e, h, rest) => e + (rest - e) * (1 - Math.exp(-h / 8)) * 0.8;
  const noon = core.circadian(at('13:00'), late).offset;
  t('白天钟点平着的时段里，回落速度和原来的衰减一样（只是底抬了钟点那一点）',
    Math.abs(core.energyDrift(0.3, at('12:00'), at('13:00'), late) - old(0.3, 1, 0.58 + noon)) < 0.001,
    core.energyDrift(0.3, at('12:00'), at('13:00'), late) - old(0.3, 1, 0.58 + noon));
  t('★ 夜里精力往下走（下午一点到凌晨四点）', core.energyDrift(0.6, at('13:00'), at('04:00', '2026-10-04'), late) < 0.45,
    core.energyDrift(0.6, at('13:00'), at('04:00', '2026-10-04'), late));
  t('★ 醒过来精力回来（凌晨四点到下午一点）', core.energyDrift(0.3, at('04:00'), at('13:00'), late) > 0.55);
  t('★ AI 刚写的值不会被拽回曲线上（两分钟后几乎原样）',
    Math.abs(core.energyDrift(0.9, at('04:00'), at('04:02'), late) - 0.9) < 0.01 && Math.abs(core.energyDrift(0.1, at('13:00'), at('13:02'), late) - 0.1) < 0.01);
  t('两个不同的起点十分钟后还保持原来的高低', core.energyDrift(0.2, at('03:00'), at('03:10'), late) + 0.6 < core.energyDrift(0.9, at('03:00'), at('03:10'), late));
  t('时间倒着走（设备时钟回拨）就不动', core.energyDrift(0.42, at('13:00'), at('12:00'), late) === 0.42);
  t('坏输入不炸', Number.isFinite(core.energyDrift(NaN, at('13:00'), at('14:00'), null)));

  console.log('  — 提示词那一句');
  const drowsy = core.clockLine(at('03:10'), late, 0.3, '她');
  t('说得出现在几点、按谁的作息', /生物钟：现在 03:10，按她的作息（02:30 睡 → 09:30 醒）/.test(drowsy), drowsy);
  t('困了：说话带困（短、软）', /你困了：说话可以短一点、软一点/.test(drowsy));
  t('★ 困不是退场的理由：不许拿「我困了」结束对话', /不许拿「我困了」结束对话/.test(drowsy));
  t('★ 她难过的时候困意让位', /她难过的时候，困意让位/.test(drowsy));
  t('白天精力低（累）不算困，不加困的措辞', !/你困了/.test(core.clockLine(at('13:00'), late, 0.3, '她')));
  t('钟点该困、但它精神还在（AI 自己写过很兴奋）→ 不硬让它困', !/你困了/.test(core.clockLine(at('03:10'), late, 0.85)) && /精神还在/.test(core.clockLine(at('03:10'), late, 0.85)));
  t('早上她还在睡的钟点不说成「深夜」', /还早，她平时这会儿还在睡/.test(core.clockLine(at('07:10'), late, 0.3)));

  console.log('  — 作息按哪份');
  const nightsBand = (n, startHm, endHm, base = '2026-09-25') => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(base) + i * 864e5).toISOString().slice(0, 10);
    const d2 = new Date(Date.parse(base) + (i + 1) * 864e5).toISOString().slice(0, 10);
    return { TIMESTAMP: bj(d2 + 'T' + startHm + ':00'), WAKEUP_TIME: bj(d2 + 'T' + endHm + ':00'), TOTAL_DURATION: 400 };
  });
  const nowR = at('20:00');
  const band = nightsBand(5, '03:20', '10:40');
  const b = core.sleepFromBand(band, nowR);
  t('手环几晚的入睡 / 醒来取中位数', b && b.start === 200 && b.end === 640 && b.source === 'band' && b.nights === 5, b);
  // 看 nights 不看 start：中位数很稳，混进一觉午睡中位数也纹丝不动，只看 start 的话这条测不出东西
  const withNap = core.sleepFromBand(band.concat([{ TIMESTAMP: at('14:00', '2026-10-01'), WAKEUP_TIME: at('17:30', '2026-10-01') }]), nowR);
  t('手环里的午睡不算作息', withNap.start === 200 && withNap.nights === 5, withNap);
  t('手环只有两晚 → 不够，不用', core.sleepFromBand(band.slice(0, 2), nowR) === null);
  t('手环数据太旧（手机一个月没连）→ 不用', core.sleepFromBand(nightsBand(5, '03:20', '10:40', '2026-08-20'), nowR) === null);
  t('手环坏数据不炸', core.sleepFromBand([null, { TIMESTAMP: 'x' }, {}], nowR) === null && core.sleepFromBand(null, nowR) === null);
  const manual = { manual: true, start: 23 * 60, end: 7 * 60 };
  t('★ 她手动定的最优先', core.resolveSleep({ pref: manual, band, userTimes: [], now: nowR }).source === 'manual'
    && core.resolveSleep({ pref: manual, band, userTimes: [], now: nowR }).start === 1380);
  t('手动开关关着 → 手环', core.resolveSleep({ pref: Object.assign({}, manual, { manual: false }), band, now: nowR }).source === 'band');
  t('手动定的两个钟点一样（睡 0 小时）→ 不认', core.resolveSleep({ pref: { manual: true, start: 600, end: 600 }, band, now: nowR }).source === 'band');
  const msgTs = [];
  for (let d = 0; d < 6; d++) {
    const day = new Date(Date.parse('2026-09-26') + d * 864e5).toISOString().slice(0, 10);
    const next = new Date(Date.parse('2026-09-27') + d * 864e5).toISOString().slice(0, 10);
    for (let h = 12; h <= 23; h++) msgTs.push(bj(day + 'T' + String(h).padStart(2, '0') + ':10:00'));
    msgTs.push(bj(next + 'T02:20:00'), bj(next + 'T10:05:00'));
  }
  const fromMsg = core.resolveSleep({ pref: null, band: null, userTimes: msgTs, now: nowR });
  t('没手环 → 她发消息的时间推', fromMsg.source === 'messages' && fromMsg.start === 150, fromMsg);
  t('什么都没有 → 默认，并且说清楚是默认', (() => { const r = core.resolveSleep({ now: nowR }); return r.source === 'default' && r.start === core.DEFAULT_SLEEP.start && !r.confident; })());
  t('sanitizeSleep 保留来源（面板要说「手环近 N 晚」）', core.sanitizeSleep({ start: 1, end: 2, source: 'band' }).source === 'band');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
