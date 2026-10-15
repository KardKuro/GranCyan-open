const fs = require('fs');
const vm = require('vm');
const js = fs.readFileSync('js/32-pomodoro.js', 'utf8');
const java = fs.readFileSync('android/src/com/grancyan/app/FocusBridge.java', 'utf8');
const main = fs.readFileSync('android/src/com/grancyan/app/MainActivity.java', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
let pass = 0, fail = 0;
function ok(name, value) { if (value) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } }

const data = new Map();
let locked = 0, unlocked = 0;
const sandbox = {
  console, Date, Math,
  localStorage: { getItem:k => data.get(k) || null, setItem:(k,v) => data.set(k,String(v)), removeItem:k => data.delete(k) },
  window: { GrancyanFocus: { available:() => true, lock:() => locked++, unlock:() => unlocked++, locked:() => locked > unlocked } },
  navigator: {}, document: { getElementById:() => null }, showToast() {},
  setInterval:() => 1, clearInterval() {}, setTimeout:() => 1, clearTimeout() {},
};
vm.createContext(sandbox); vm.runInContext(js, sandbox);
console.log('\n[锁手机番茄钟]');
ok('入口和脚本挂载', /openWidget\(openPomodoro\)/.test(html) && /js\/32-pomodoro\.js/.test(html));
ok('开始时写结束时间并请求锁定', (sandbox.pomoSetMinutes(1), sandbox.pomoStart(), locked === 1 && Number(data.get('grancyan_pomo_end')) > Date.now()));
ok('分钟设置限制在 1–180', (sandbox.pomoFinish(), sandbox.pomoSetMinutes(999), sandbox._pomoMinutes === 180));
ok('支持输入自定义分钟并用回车确认', /id="pomoCustom"[^>]+min="1"[^>]+max="180"/.test(js) && /ev\.key !== 'Enter'/.test(js));
ok('功能页装修成深夜专注书房', /pomo-window/.test(js) && /pomo-lamp/.test(js) && /FOCUS ROOM/.test(js));
ok('完成时清存储并解除锁定', unlocked > 0 && !data.has('grancyan_pomo_end'));
ok('时钟按 mm:ss 显示', sandbox.pomoClock(61000) === '01:01');
ok('Android 桥调用系统 Lock Task', /startLockTask\(\)/.test(java) && /stopLockTask\(\)/.test(java));
ok('锁定时保持屏幕常亮', /FLAG_KEEP_SCREEN_ON/.test(java));
ok('系统返回键在锁定时回番茄面板', /onBackPressed[\s\S]*?focusBridge\.locked\(\)[\s\S]*?openPomodoro/.test(main));
ok('提前结束必须长按两秒', /setTimeout\([\s\S]*?pomoFinish\(\)[\s\S]*?2000\)/.test(js));
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
