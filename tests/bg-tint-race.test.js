/* 壁纸取色 / 亮度判断是异步的，晚回来的旧结果不许盖掉新壁纸。
 *
 * 先设外链壁纸 A（走代理，慢），马上换本地图 B（快）：B 先完成、A 后完成，
 * 以前 A 的结果照样写进 _bgTintCache 并着色 → 界面按 A 的主色，背景却是 B。
 * 取色途中关掉自动取色，也会被晚到的结果染上色。applyBgLegibility 同理。
 * vm 里真跑 09 的 applyBgTint / applyBgLegibility，取色函数换成手动放行的 promise。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', '09-appearance-input.js'), 'utf8');
function funcBody(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const tick = () => new Promise(r => setTimeout(r, 5));

function makeCtx() {
  const pending = {};   // src → resolve
  const applied = [];
  const bodyCls = new Set();
  const ctx = vm.createContext({
    state: { bgAutoTint: true, background: '', accentColor: '#c89555', bgLegibility: 'auto' },
    _bgTintCache: { src: '', hex: '' },
    document: { getElementById: () => null, body: { classList: { toggle: (c, on) => { on ? bodyCls.add(c) : bodyCls.delete(c); } } } },
    applyAccentCSS: hex => applied.push(hex),
    _pickTintFromImage: s => new Promise(r => { pending['tint:' + s] = r; }),
    _pickBgLuminance: s => new Promise(r => { pending['lum:' + s] = r; }),
    _maskedLuminance: x => x, BG_LUM_CEILING: 0.5,
    console: { warn() {} }, showToast() {},
  });
  vm.runInContext(funcBody(src, 'async function applyBgTint(') + '\n' + funcBody(src, 'async function applyBgLegibility('), ctx);
  return { ctx, pending, applied, bodyCls };
}

(async () => {
  console.log('\n【一】取色：慢的旧壁纸后回来');
  {
    const { ctx, pending, applied } = makeCtx();
    vm.runInContext('state.background = "A"; applyBgTint();', ctx);
    vm.runInContext('state.background = "B"; applyBgTint();', ctx);
    pending['tint:B']('#0000ff'); await tick();
    pending['tint:A']('#ff0000'); await tick();
    t('最后着的是 B 的颜色', applied[applied.length - 1] === '#0000ff', applied);
    t('缓存记的是 B', vm.runInContext('_bgTintCache.src', ctx) === 'B');
  }
  {
    const { ctx, pending, applied } = makeCtx();
    vm.runInContext('state.background = "A"; applyBgTint(); state.bgAutoTint = false;', ctx);
    pending['tint:A']('#ff0000'); await tick();
    t('取色途中关了自动取色：不再染色', !applied.includes('#ff0000'), applied);
  }
  {
    const { ctx, pending, applied } = makeCtx();
    vm.runInContext('state.background = "A"; applyBgTint();', ctx);
    pending['tint:A']('#ff0000'); await tick();
    t('对照组：没换壁纸时照常着色', applied[applied.length - 1] === '#ff0000', applied);
  }

  console.log('\n【二】亮度判断：慢的旧壁纸后回来');
  {
    const { ctx, pending, bodyCls } = makeCtx();
    vm.runInContext('state.background = "A"; applyBgLegibility();', ctx);
    vm.runInContext('state.background = "B"; applyBgLegibility();', ctx);
    pending['lum:B'](0.1); await tick();       // B 是深色，不用加底衬
    pending['lum:A'](0.9); await tick();       // A 是浅色，晚回来
    t('B 是深色：没被 A 套上底衬', !bodyCls.has('bg-light-boost'));
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
