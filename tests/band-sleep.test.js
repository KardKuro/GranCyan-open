// 手环睡眠给 AI / 面板的归堆回归测试。
// 跑法：node tests/band-sleep.test.js
//
// 用户：「AI 似乎只能看到手环前一次睡眠而不是前一天睡眠」。
// 真凶：提示词只拿 sleepSummary[0]（ORDER BY TIMESTAMP DESC LIMIT 1），
// 那天下午 15:03 补了个觉，于是 AI 眼里「睡眠」= 那个小睡，前一晚 04:57→11:04 整个看不见；
// 面板上的「😴 昨晚睡眠」也是同一条，显示成了 3h36m。
// 下面的样本就是那天手环库里的真实行（时间按本机时区构造，跟机器时区无关）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};

const band = read('js/07-band-tts.js');
const a = band.indexOf('function bandSleepSessions'), b = band.indexOf('// 把 accent 色');
const ctx = { Date, Math, String, Number, Array, Map, Set, Object };
vm.createContext(ctx);
vm.runInContext(band.slice(a, b), ctx);

const at = (mo, d, h, mi) => new Date(2026, mo - 1, d, h, mi).getTime();
const row = (bed, wake, total, deep = 0, light = 0, rem = 0, awake = 0) => ({
  TIMESTAMP: at(...bed), WAKEUP_TIME: at(...wake), TOTAL_DURATION: total,
  DEEP_SLEEP_DURATION: deep, LIGHT_SLEEP_DURATION: light, REM_SLEEP_DURATION: rem, AWAKE_DURATION: awake,
});
const sleepRecent = [
  row([10, 5, 15, 3], [10, 5, 18, 59], 216, 72, 64, 80, 20),   // 下午补觉 —— 以前 AI 只看得到这条
  row([10, 5, 4, 57], [10, 5, 11, 4], 367, 114, 152, 101, 0),
  row([10, 4, 3, 4], [10, 4, 10, 56], 472, 137, 203, 132, 0),
  row([10, 3, 10, 40], [10, 3, 11, 38], 58),                   // 早上又睡了一段，算 10-02 那晚
  row([10, 3, 4, 4], [10, 3, 7, 23], 140),
  row([10, 2, 2, 56], [10, 2, 10, 55], 474, 163, 164, 147, 5),
  row([10, 1, 4, 23], [10, 1, 12, 49], 463, 163, 202, 98, 43),
  row([9, 30, 4, 43], [9, 30, 13, 53], 522, 162, 250, 110, 28),
  row([9, 29, 3, 46], [9, 29, 10, 29], 403, 117, 177, 109, 0),
  row([9, 28, 3, 39], [9, 28, 11, 0], 406, 138, 224, 44, 35),
];

console.log('\n[1] 归堆：白天小睡单独算，早上补的一段并进前一晚');
const ss = ctx.bandSleepSessions({ sleepRecent });
const nights = ctx.bandSleepNights(ss);
t('下午 15:03 那觉是白天小睡', ss[0].nap === true && ss.filter(s => s.nap).length === 1);
t('最近一晚是 04:57 那段（不是下午的小睡）', nights[0].segs.length === 1 && nights[0].total === 367, JSON.stringify(nights[0]));
t('10-03 凌晨 + 早上补的两段并成一晚', nights[2].segs.length === 2 && nights[2].total === 198, JSON.stringify(nights[2]));
t('一共 8 晚', nights.length === 8, nights.length);

console.log('\n[2] 给 AI 的那段');
const txt = ctx.bandSleepPromptText({ sleepRecent }, '小明');
t('★ 前一晚 04:57→11:04 在里面', txt.includes('10/5 04:57入睡→11:04醒来, 6h7m'), txt);
t('★ 下午那觉标了白天小睡', /10\/5 15:03入睡→18:59醒来, 3h36m \[白天小睡\]/.test(txt), txt);
t('只给最近 7 晚（9/28 那晚不在）', txt.includes('9/29 03:46') && !txt.includes('9/28 03:39'), txt);
t('没分期的段不写一串 0', /10\/3 04:04入睡→07:23醒来, 2h20m$/m.test(txt), txt);
t('平均入睡在凌晨，不是被跨午夜平均成中午', /一般0[2-5]:\d\d左右睡下、1[01]:\d\d左右起/.test(txt), txt);
t('不含空行（server 剥手环段剥到 \\n\\n 为止，有空行后半截会漏进缓存指纹）', !txt.includes('\n\n'));
t('写明是谁的睡眠', txt.startsWith('\n小明最近的睡眠'));

console.log('\n[3] 老 server 没有 sleepRecent 时退回 sleepSummary + sleep7');
const old = { sleepSummary: [sleepRecent[0]], sleep7: sleepRecent.filter(r => r.TOTAL_DURATION > 60).slice(0, 7) };
const oldTxt = ctx.bandSleepPromptText(old, '小明');
t('小睡和前一晚都在，且没重复', oldTxt.includes('[白天小睡]') && oldTxt.includes('04:57入睡') && oldTxt.split('15:03入睡').length === 2, oldTxt);
t('一条睡眠都没有就什么都不写', ctx.bandSleepPromptText({}, '小明') === '');

console.log('\n[4] 接线');
const api = read('js/05-prompts-api.js');
t('提示词走 bandSleepPromptText，不再只拿 sleepSummary[0]', api.includes('bandSleepPromptText(bd, bandWho)') && !api.includes('bd.sleepSummary?.[0]'));
t('面板「昨晚睡眠」用最近一晚的合计', /lastNight = bandSleepNights\(bandSleepSessions\(bd\)\)\[0\]/.test(band) && !band.includes('sl = bd.sleepSummary'));
t('server 吐 sleepRecent', /sleepRecent = sqlRows\(db, "SELECT [^"]+XIAOMI_SLEEP_TIME_SAMPLE WHERE TIMESTAMP > \(SELECT MAX\(TIMESTAMP\)/.test(read('server/band.js'))
  && /sleep7, sleepRecent \}/.test(read('server/band.js')));

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
