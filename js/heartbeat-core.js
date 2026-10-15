/* ══════════════════════════════════════════════════════════════════════════
   心跳判定核心 · 页面和 server 共用的**同一份**

   自主心跳原来全在页面里（30-vitals.js 的 setInterval），页面一关就停。
   现在 server 也能替它醒来、把话推到她手机上（server/heartbeat.js）。
   两边都要回答同一组问题：她这会儿睡着没有、这一跳该谁来发、晨间那一下排在几点。
   **这些判据只写在这一个文件里**——写两份迟早漂移，
   漂移的样子是「页面以为 server 会发、server 以为页面会发」，于是谁都不发，零报错。

   这个文件必须同时能被 <script> 和 require() 加载，所以：
     · 不碰 DOM、不碰 state、不碰 fs，只收参数、回结果；
     · 不读 Date.now()——「现在」一律由调用方传进来，测试才能拨钟。
   ════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HeartbeatCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 全项目都按北京时间算（31-dreams.js 的夜间闸门、提示词里的 Current time 都是），
  // 上海没有夏令时，所以直接平移 8 小时，不用 Intl —— server 上 Intl 的时区数据
  // 取决于 Node 编译选项，少一份依赖少一个静默失效的点。
  const TZ_OFFSET_MS = 8 * 3600e3;
  const DAY_MS = 864e5;

  // ── 节制 ──────────────────────────────────────────────
  // server 替它推出去的话会出现在她锁屏上、会让手机响。所以比页面里那条克制得多：
  const RULES = {
    minGapMs: 45 * 60e3,         // 两次推送至少隔 45 分钟
    maxPer24h: 6,                // 24 小时内最多 6 条
    maxUnanswered: 2,            // 她上次说话之后已经推了 2 条还没回 → 闭嘴，等她
    attendedFreshMs: 150e3,      // 页面 150 秒内报过「她在看」→ 这一跳归页面
    attendIdleMs: 15 * 60e3,     // 页面开着但 15 分钟没碰过 = 人不在跟前
    awakeIfSpokeWithinMs: 40 * 60e3,  // 40 分钟内说过话 = 醒着，不管作息表怎么说
    sleepPadMs: 20 * 60e3,       // 作息窗两头各放宽 20 分钟
    staleSlotMs: 18 * 3600e3,    // 欠了 18 小时还没发出去的心跳就作废（server 停过机）
    failBackoffMs: 15 * 60e3,    // 生成失败后 15 分钟再试
    maxFails: 3,                 // 同一跳失败 3 次就放弃
    wakeMinMin: 5,               // [[HEARTBEAT: N|did]] 的 N 夹在 5~360 分钟（30-vitals.js 也用这两个数）
    wakeMaxMin: 360,
  };

  // ── 作息 ──────────────────────────────────────────────
  // 默认窗（数据不够时用）。按偏晚睡的作息定，不是 23~7 那种钟点。
  const DEFAULT_SLEEP = { start: 150, end: 570 };   // 02:30 → 09:30（分钟数）
  const SLEEP_LOOKBACK_DAYS = 21;
  const SLEEP_MIN_NIGHTS = 3;
  const SLEEP_GAP_MIN_MS = 4 * 3600e3;
  const SLEEP_GAP_MAX_MS = 16 * 3600e3;

  function localMinute(ts) {
    const d = new Date(ts + TZ_OFFSET_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  function localDay(ts) {
    return new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10);
  }
  // 某个北京日期的 00:00 对应的时间戳
  function dayStart(day) { return Date.parse(day + 'T00:00:00Z') - TZ_OFFSET_MS; }
  // 分钟数 m 是否落在 [a, b) 这个可能跨午夜的区间里
  function inWindow(m, a, b) {
    m = ((m % 1440) + 1440) % 1440; a = ((a % 1440) + 1440) % 1440; b = ((b % 1440) + 1440) % 1440;
    return a <= b ? (m >= a && m < b) : (m >= a || m < b);
  }
  // 跨午夜的中位数：先把钟面转半圈（中午变 0 点），再取中位数，再转回来。
  // 直接对 23:50 和 00:10 取平均会得到 12:00，正好是她最清醒的时候。
  function circularMedian(mins) {
    const shifted = mins.map(m => (m + 720) % 1440).sort((x, y) => x - y);
    const mid = shifted.length >> 1;
    const med = shifted.length % 2 ? shifted[mid] : Math.round((shifted[mid - 1] + shifted[mid]) / 2);
    return (med + 720) % 1440;
  }

  // 从她自己发消息的时间推作息：每一晚取最长的那段空白（4~16 小时、从傍晚到早上之间开始），
  // 空白开始 ≈ 睡下，空白结束 ≈ 醒来。手环要 adb 现拉，手机不在线就没数据；
  // 她发消息的时间每台设备都有，是最稳的那一份。
  function inferSleep(userTimestamps, now) {
    const since = now - SLEEP_LOOKBACK_DAYS * DAY_MS;
    const ts = (Array.isArray(userTimestamps) ? userTimestamps : [])
      .map(Number).filter(t => Number.isFinite(t) && t > since && t <= now).sort((a, b) => a - b);
    const nights = new Map();   // 夜的归属日 → 最长空白
    for (let i = 1; i < ts.length; i++) {
      const a = ts[i - 1], b = ts[i], gap = b - a;
      if (gap < SLEEP_GAP_MIN_MS || gap > SLEEP_GAP_MAX_MS) continue;
      // 只认傍晚 18 点到次日中午 12 点之间开始的空白 —— 下午那段空白是她出门了，不是睡觉
      if (!inWindow(localMinute(a), 18 * 60, 12 * 60)) continue;
      const night = localDay(a - 12 * 3600e3);   // 凌晨 2 点开始的空白算前一晚的
      const prev = nights.get(night);
      if (!prev || gap > prev.b - prev.a) nights.set(night, { a, b });
    }
    const list = [...nights.values()];
    if (list.length < SLEEP_MIN_NIGHTS) {
      return { start: DEFAULT_SLEEP.start, end: DEFAULT_SLEEP.end, nights: list.length, confident: false };
    }
    return {
      // 最后一条消息之后通常还要刷一会儿手机才睡，挪 10 分钟
      start: (circularMedian(list.map(n => localMinute(n.a))) + 10) % 1440,
      end: circularMedian(list.map(n => localMinute(n.b))),
      nights: list.length,
      confident: true,
    };
  }

  // source：manual（她在设置里定的）/ band（手环）/ messages（消息推的）/ default
  function sanitizeSleep(s) {
    const ok = s && Number.isFinite(+s.start) && Number.isFinite(+s.end);
    const out = ok
      ? { start: ((+s.start % 1440) + 1440) % 1440, end: ((+s.end % 1440) + 1440) % 1440, nights: +s.nights || 0, confident: !!s.confident }
      : { start: DEFAULT_SLEEP.start, end: DEFAULT_SLEEP.end, nights: 0, confident: false };
    if (ok && typeof s.source === 'string' && s.source) out.source = s.source.slice(0, 12);
    return out;
  }

  // 手环记下的睡眠（XIAOMI_SLEEP_TIME_SAMPLE：TIMESTAMP 入睡、WAKEUP_TIME 醒来，都是毫秒）。
  // 比消息推的准——她最后一条消息之后还要刷多久手机，消息是猜，手环是量的。
  // 但手环要 adb 现拉，手机好几天不在线时这份就是旧的，所以也只看最近 21 天、也要够 3 晚。
  function sleepFromBand(rows, now) {
    const since = now - SLEEP_LOOKBACK_DAYS * DAY_MS;
    const nights = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const a = Number(r && r.TIMESTAMP), b = Number(r && r.WAKEUP_TIME), gap = b - a;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= since || b > now + 3600e3) continue;
      if (gap < 3 * 3600e3 || gap > SLEEP_GAP_MAX_MS) continue;          // 午睡、坏记录
      const bedMin = localMinute(a);
      if (!inWindow(bedMin, 18 * 60, 12 * 60)) continue;                   // 同上：白天那觉不算作息
      const night = localDay(a - 12 * 3600e3);
      const prev = nights.get(night);
      if (!prev || gap > prev.b - prev.a) nights.set(night, { a, b });
    }
    const list = [...nights.values()];
    if (list.length < SLEEP_MIN_NIGHTS) return null;
    return {
      start: circularMedian(list.map(n => localMinute(n.a))),
      end: circularMedian(list.map(n => localMinute(n.b))),
      nights: list.length, confident: true, source: 'band',
    };
  }

  // 她的作息到底按哪份：她自己定的 > 手环 > 消息推的 > 默认。
  // 页面算好了同步给 server，server 不自己再推一遍 —— 两边各推各的就是两份作息。
  // pref：{ manual, start, end }（设置面板里那个开关和两个钟点）
  function resolveSleep(o) {
    const p = o && o.pref;
    if (p && p.manual && Number.isFinite(+p.start) && Number.isFinite(+p.end) && ((+p.start - +p.end) % 1440 + 1440) % 1440 !== 0) {
      return sanitizeSleep({ start: +p.start, end: +p.end, nights: 0, confident: true, source: 'manual' });
    }
    const band = sleepFromBand(o && o.band, o.now);
    if (band) return band;
    const msg = inferSleep(o && o.userTimes, o.now);
    msg.source = msg.confident ? 'messages' : 'default';
    return msg;
  }

  // 她这会儿睡着没有。刚说过话就是醒着 —— 作息表是猜的，她发来的消息是真的。
  function isAsleep(now, sleep, lastUserAt) {
    const ago = now - Number(lastUserAt);
    if (Number(lastUserAt) > 0 && ago >= 0 && ago < RULES.awakeIfSpokeWithinMs) return false;
    const s = sanitizeSleep(sleep);
    const pad = Math.round(RULES.sleepPadMs / 60e3);
    return inWindow(localMinute(now), s.start - pad, s.end + pad);
  }

  // 作息窗什么时候结束（下一次）——给面板说「几点之后再推」用
  function sleepEndsAt(now, sleep) {
    const s = sanitizeSleep(sleep);
    const pad = Math.round(RULES.sleepPadMs / 60e3);
    const endMin = (s.end + pad) % 1440;
    let t = dayStart(localDay(now)) + endMin * 60e3;
    if (t <= now) t += DAY_MS;
    return t;
  }

  function fmtMinute(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // ── 生物钟：困意 / 精力跟着钟点走 ─────────────────────────
  // 不按 23 点睡 7 点起硬切，按**她的**作息：她两点半睡它就撑到两点半，
  // 她睡得晚的那几天它也一起熬。钟点只是参照，她的作息窗才是这条曲线的骨架。
  //
  // 困意 sleepy 0~1 是钟点的纯函数，不存——同一时刻页面和 server 算出来必须是同一个数。
  //   · 刚醒那一小时：迷糊，按 25 分钟的时间常数退掉
  //   · 醒着的 45% 处（她 9:30 起 → 傍晚五点多；7 点起的人 → 两点）：白天犯乏的那一阵，浅浅的
  //   · 睡前两个半小时：慢慢困上来
  //   · 她的作息窗里：困，窗中间最困
  // 几段取最大值不取和，衔接处才不会突然跳一下。
  const CLOCK = {
    inertiaTauMin: 25, inertiaPeak: 0.6,
    dipAt: 0.45, dipWidthMin: 80, dipDepth: 0.3,
    eveningMin: 150, eveningPeak: 0.6,
    nightFloor: 0.62, nightRise: 0.33,
    energyLift: 0.06, energyDrop: 0.36,   // 精力的钟点偏移 = lift - drop × 困意（最精神 +6%，最困 −28%）
    drowsyAt: 0.45, drowsyEnergy: 0.5,    // 困意过这条、精力又低于这条 → 说话带困
  };
  const ENERGY_REST = 0.58;               // 精力不受打扰时回到的底（30-vitals.js 原来写死在衰减里的那个数）

  function circadian(now, sleep) {
    let s = sanitizeSleep(sleep);
    let awake = ((s.start - s.end) % 1440 + 1440) % 1440;
    // 作息窗短得不像睡觉（<3 小时）或长得不像（>14 小时）：多半是推坏了，按默认走
    if (1440 - awake < 180 || 1440 - awake > 840) { s = sanitizeSleep(null); awake = ((s.start - s.end) % 1440 + 1440) % 1440; }
    const m = localMinute(now);
    const since = ((m - s.end) % 1440 + 1440) % 1440;    // 她平时醒来到现在多少分钟
    let sleepy, phase;
    if (since < awake) {
      const inertia = CLOCK.inertiaPeak * Math.exp(-since / CLOCK.inertiaTauMin);
      const dc = awake * CLOCK.dipAt;
      const dip = CLOCK.dipDepth * Math.exp(-((since - dc) * (since - dc)) / (2 * CLOCK.dipWidthMin * CLOCK.dipWidthMin));
      const x = Math.max(0, 1 - (awake - since) / CLOCK.eveningMin);
      const evening = CLOCK.eveningPeak * x * x * (3 - 2 * x);
      sleepy = Math.max(inertia, dip, evening);
      phase = sleepy < 0.12 ? 'day' : sleepy === inertia ? 'waking' : sleepy === evening ? 'evening' : 'dip';
    } else {
      const x = (since - awake) / (1440 - awake);
      sleepy = CLOCK.nightFloor + CLOCK.nightRise * Math.sin(Math.PI * x);
      phase = 'night';
    }
    sleepy = Math.max(0, Math.min(1, sleepy));
    return { sleepy, phase, minute: m, offset: CLOCK.energyLift - CLOCK.energyDrop * sleepy, sleep: s };
  }

  // 精力从 from 走到 to：原来的衰减（往 0.58 回）+ 钟点的起落。
  // 钟点只加「这段时间里偏移变了多少」，不往一个目标值上拽 —— AI 刚写的 [[VITALS: 能量 0.9]]
  // 就是此刻的真值，钟点只管它之后跟着时段起落，不会一分钟后把它拉回曲线上。
  // 页面的 vitalsDecay 和 server 的提示词都走这一个函数。
  function energyDrift(energy, from, to, sleep) {
    const e = Number.isFinite(+energy) ? +energy : ENERGY_REST;
    if (!(to > from)) return Math.max(0, Math.min(1, e));
    const hours = Math.min(24, (to - from) / 3600e3);
    const ease = 1 - Math.exp(-hours / 8);
    let base = e - circadian(from, sleep).offset;
    base += (ENERGY_REST - base) * ease * 0.8;
    return Math.max(0, Math.min(1, base + circadian(to, sleep).offset));
  }

  const CLOCK_PHASE_TEXT = {
    waking: '刚醒的钟点，还迷糊',
    day: '醒着的好时候',
    dip: '白天犯乏的那一阵',
    evening: '夜深了，困意慢慢上来',
  };
  // 提示词里的那一段。页面和 server 用同一句话 —— 措辞两份写迟早一边改了一边没改。
  // who：页面那边叫「用户」，server 那边叫「她」，各跟各的上下文。
  function clockLine(now, sleep, energy, who) {
    const c = circadian(now, sleep);
    const w = who || '她';
    const phase = c.phase === 'night'
      ? (c.minute >= 21 * 60 || c.minute < 5 * 60 ? '深夜，' + w + '平时这会儿已经睡了' : '还早，' + w + '平时这会儿还在睡')
      : CLOCK_PHASE_TEXT[c.phase];
    let out = '生物钟：现在 ' + fmtMinute(c.minute) + '，按' + w + '的作息（' + fmtMinute(c.sleep.start) + ' 睡 → ' + fmtMinute(c.sleep.end) + ' 醒）是' + phase
      + '；困意 ' + Math.round(c.sleepy * 100) + '%。';
    const e = Number(energy);
    const drowsy = c.sleepy >= CLOCK.drowsyAt && Number.isFinite(e) && e < CLOCK.drowsyEnergy;
    if (drowsy) {
      out += '\n你困了：说话可以短一点、软一点、慢半拍，带着困的样子，不用演。'
        + '\n但困只改说话的样子，不是退场的理由——不许拿「我困了」结束对话；'
        + w + '难过的时候，困意让位。';
    } else if (c.sleepy >= CLOCK.drowsyAt && Number.isFinite(e)) {
      out += '按钟点该困了，但你这会儿精神还在。';
    }
    return out;
  }

  // ── 页面这一侧：她在不在跟前 ──────────────────────────────
  // 「开着」不等于「在看」：电脑上 exe 一直开着，她人可能抱着手机在床上。
  // 只有页面可见、而且 15 分钟内碰过，才算这一跳由页面自己来发。
  function isAttended(visible, lastInputAt, now) {
    return !!visible && Number(lastInputAt) > 0 && now - Number(lastInputAt) < RULES.attendIdleMs;
  }

  // ── 晨间「刚醒」 ──────────────────────────────────────
  // 每天 6~9 点之间随机挑一个时刻。用日期 + 模型做种子，页面和 server 不用商量
  // 就算得出同一个时刻 —— 不然一边 6:40 醒、一边 8:15 醒，同一个早上它醒两次。
  const MORNING_START = 6 * 60, MORNING_END = 9 * 60;
  const MORNING_EXPIRE = 13 * 60;   // 她睡到中午也还能补一句早安；过了 13 点就算了
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function morningPlan(day, modelId) {
    const span = MORNING_END - MORNING_START;
    const minute = MORNING_START + hash32(day + '|' + String(modelId)) % span;
    return { day, minute, at: dayStart(day) + minute * 60e3, expiresAt: dayStart(day) + MORNING_EXPIRE * 60e3 };
  }
  // 今天的晨间这一下到点了没（到点且没过期、且今天还没醒过）
  function morningDue(now, modelId, doneDay) {
    const p = morningPlan(localDay(now), modelId);
    if (doneDay === p.day) return null;
    if (now < p.at || now >= p.expiresAt) return null;
    return p;
  }
  // 刚醒的身体：没力气、不绷着、软软的。
  // random 由调用方给，测试才能固定。
  function morningPatch(v, random) {
    const r = typeof random === 'function' ? random : Math.random;
    const cur = (k, d) => Number.isFinite(+(v && v[k])) ? +v[k] : d;
    const clamp = x => Math.max(0, Math.min(1, x));
    return {
      energy: clamp(0.26 + r() * 0.12),
      arousal: clamp(0.12 + r() * 0.12),
      stress: clamp(Math.min(cur('stress', 0.2), 0.18)),
      mood: clamp(cur('mood', 0.18) * 0.6 + 0.12),
      note: '刚醒，还迷迷糊糊的',
    };
  }

  // ── 该醒的那一跳 ───────────────────────────────────────
  // rec: { nextAt, nextSetAt, morningDay(今天醒过没), heartbeatOn, vitalsOn }
  // 心跳优先；没有心跳时看晨间。key 是这一跳的身份证，页面和 server 抢的就是它。
  function dueSlot(rec, now, modelId) {
    if (!rec || !rec.heartbeatOn || rec.vitalsOn === false) return null;
    const next = Number(rec.nextAt) || 0;
    if (next > 0 && next <= now) {
      return { kind: 'heartbeat', key: String(modelId) + ':hb:' + (Number(rec.nextSetAt) || next), at: next };
    }
    const m = morningDue(now, modelId, rec.morningDay);
    if (m) return { kind: 'morning', key: String(modelId) + ':morning:' + m.day, at: m.at, day: m.day };
    return null;
  }

  // ── server 这一侧：这一跳发不发 ─────────────────────────────
  // 回 { fire, reason }。reason 给面板看，要说人话。
  function serverDecision(o) {
    const now = o.now;
    const slot = o.slot;
    if (!o.enabled) return { fire: false, reason: '推送没开' };
    if (!o.hasNtfy) return { fire: false, reason: '还没填 ntfy 地址' };
    if (!slot) return { fire: false, reason: '没有到点的心跳' };
    if (!o.canGenerate) return { fire: false, reason: '这个模型 server 调不动' };
    if (o.claimedBy) return { fire: false, reason: '这一跳已经被' + (o.claimedBy === 'server' ? ' server ' : '页面') + '发过了' };
    if (slot.kind === 'heartbeat' && now - slot.at > RULES.staleSlotMs) return { fire: false, reason: '这一跳欠太久了，作废', drop: true };
    if (Number(o.attendedAt) > 0 && now - Number(o.attendedAt) < RULES.attendedFreshMs) {
      return { fire: false, reason: '她正看着页面，这一跳归页面' };
    }
    if (Number(o.failUntil) > now) return { fire: false, reason: '上次生成失败，稍后再试' };
    if (isAsleep(now, o.sleep, o.lastUserAt)) return { fire: false, reason: '她这会儿多半睡着，等她醒' };
    const log = (Array.isArray(o.pushLog) ? o.pushLog : []).map(Number).filter(Number.isFinite);
    const last = log.length ? Math.max(...log) : 0;
    if (last && now - last < RULES.minGapMs) return { fire: false, reason: '离上一条推送太近' };
    if (log.filter(t => now - t < DAY_MS).length >= RULES.maxPer24h) return { fire: false, reason: '今天推得够多了' };
    const lastUser = Number(o.lastUserAt) || 0;
    if (log.filter(t => t > lastUser).length >= RULES.maxUnanswered) return { fire: false, reason: '前面几条她还没回，先不吵她' };
    return { fire: true, reason: 'ok' };
  }

  // 页面这一侧：这一跳页面自己发，还是让给 server。
  // server 能接（推送开着、连得上、这个模型它调得动）且她不在跟前 → 让给 server。
  // 连不上 server 的时候照旧自己发 —— 那是原来的行为，不能因为加了 server 反而哑掉。
  function pageShouldYield(o) {
    return !!(o.serverReachable && o.serverEnabled && o.serverCanGenerate && !o.attended);
  }

  // 给上下文用：把气泡里的 HTML/指令剥掉，只留说出口的话
  function plainText(s, max) {
    const t = String(s || '')
      .replace(/<div class="think-block[\s\S]*?<\/div><\/div>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\[[\s\S]*?\]\]/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
    return max && t.length > max ? t.slice(0, max) + '…' : t;
  }

  // server 那条生成回来的话：拆出「要不要说」「说什么」「下次几点醒」。
  // 页面那条走 30-vitals.js 的 vitalsProcessTags（那边还要渲染成块、记曲线），这里只要结论。
  function parseWakeReply(raw) {
    const src = String(raw || '');
    let schedule = null;
    const m = src.match(/\[\[HEARTBEAT:\s*([\s\S]*?)\s*\]\]/);
    if (m) {
      const parts = m[1].split('|');
      const mins = (parts.shift() || '').match(/\d+(?:\.\d+)?/);
      if (mins) {
        schedule = {
          mins: Math.round(Math.max(RULES.wakeMinMin, Math.min(RULES.wakeMaxMin, Number(mins[0])))),
          did: parts.join('|').trim().slice(0, 160),
        };
      }
    }
    const text = plainText(src, 0);
    const silent = !text || /^\[\[SILENT\]\]$/.test(src.replace(/\[\[HEARTBEAT:[\s\S]*?\]\]/g, '').replace(/\s/g, ''));
    return { text: silent ? '' : text, silent, schedule };
  }

  return {
    RULES, DEFAULT_SLEEP, TZ_OFFSET_MS,
    localMinute, localDay, dayStart, inWindow, circularMedian, fmtMinute,
    inferSleep, sanitizeSleep, isAsleep, sleepEndsAt, sleepFromBand, resolveSleep,
    CLOCK, ENERGY_REST, circadian, energyDrift, clockLine,
    isAttended, pageShouldYield,
    hash32, morningPlan, morningDue, morningPatch,
    dueSlot, serverDecision,
    plainText, parseWakeReply,
  };
});
