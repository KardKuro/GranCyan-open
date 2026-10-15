'use strict';
// 手环面板换成「死黑底 + 玻璃卡片 + 只用白」的数据面板（用户发了张深色仪表盘说喜欢，要做在手环上、底色要死黑）。
// 守的是「零报错、只会长得不对」的那几件：
//   换了主题 / 搬进小组件后底色不黑了（.in-hub 会把背景刷成透明）、米纸下头部变成黑底黑字、
//   图里又混进主题强调色、早上的步数拿去跟昨天整天比永远是「跌」、一天上千个心率点直接连成锯齿。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); // 源码是 CRLF
let passed = 0, failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i) + 2); };

const css = read('css/grancyan.css');
const band = read('js/07-band-tts.js');

console.log('\n[底色死黑，哪里都一样]');
const modalRule = (css.match(/\n#bandModal > \.band-panel \{([^}]*)\}/) || [, ''])[1];
t('弹窗里是纯黑底', /background:#000\b/.test(modalRule), modalRule);
t('搬进小组件也是黑的（压得过 .in-hub 的 background:transparent !important）', /\n\.band-panel\.in-hub \{ background:#000 !important; \}/.test(css));
const varRule = (css.match(/\n#bandModal > \.band-panel, \.band-panel\.in-hub \{([^}]*)\}/) || [, ''])[1];
t('面板里把文字 / 边框变量就地改成白的几档（米纸下不会黑底黑字）',
  /--text-primary:#f/.test(varRule) && /--text-muted:rgba\(255,255,255/.test(varRule) && /--border:rgba\(255,255,255/.test(varRule), varRule);
t('浅色自动翻色不碰它', /\\\.band-/.test(read('scripts/gen-light-patch.js').match(/const SKIP = .*/)[0]) && !/\.band-/.test(read('css/light-patch.css')));

console.log('\n[只用白，不跟主题色]');
for (const fn of ['drawBandLine', 'drawBandBars', 'drawBandSleep']) {
  const src = fnSrc(band, fn);
  t(fn + ' 里没有主题强调色', src.length > 0 && !/activeAccent|accentShade|var\(--accent/.test(src));
}
t('accentShade 删干净了（没人用了）', !/accentShade/.test(band));

// 把渲染需要的几段拎出来在沙箱里跑
const helpers = band.slice(band.indexOf('const BAND_IC'), band.indexOf('function renderBandPanel('));
const box = { state: {}, requestAnimationFrame() {}, escHtml: s => String(s), bandBridgeStatus: () => null, console };
const bodyEl = { innerHTML: '' };
box.document = { getElementById: id => id === 'bandBody' ? bodyEl : null };
vm.createContext(box);
vm.runInContext(fnSrc(band, 'bandSleepSessions') + fnSrc(band, 'bandSleepNights') + helpers + fnSrc(band, 'renderBandPanel'), box);

console.log('\n[涨跌小药丸]');
t('涨：↗ +2', /↗ \+2</.test(box._bandDelta(62, 60)));
t('跌：↘ -2', /↘ -2</.test(box._bandDelta(58, 60)));
t('没变：→ 0', /→ 0</.test(box._bandDelta(60, 60)));
t('前一天没数 → 不画药丸', box._bandDelta(60, null) === '' && box._bandDelta(60, undefined) === '');

const DAY = 86400000, today = new Date(2026, 9, 14, 8).getTime();
const week = [0, 1, 2].map(i => ({ TIMESTAMP: today - i * DAY, STEPS: [3100, 9120, 7000][i], HR_RESTING: [60, 62, 61][i], STRESS_AVG: [30, 35, 28][i], CALORIES: [600, 2100, 1900][i], SPO2_AVG: [97, 96, 0][i] }));
box.state.bandData = { ok: true, ageMins: 5, daily: [week[0]], daily7: week, latestHR: [{ HEART_RATE: 71 }],
  hrSeries: [{ TIMESTAMP: 1, HEART_RATE: 58 }, { TIMESTAMP: 2, HEART_RATE: 120 }], stressSeries: [], sleep7: [] };
box.renderBandPanel();
const html = bodyEl.innerHTML;
console.log('\n[卡片里写的是对的]');
t('早上的步数不跟昨天整天比，只摆出昨天的数', /今日步数[\s\S]*?3,100[\s\S]*?昨天 9,120/.test(html) && !/STEPS|↘ -6020/.test(html));
t('卡路里同理', /卡路里[\s\S]*?600[\s\S]*?昨天 2,100/.test(html));
t('静息心率、压力给涨跌', /静息心率[\s\S]*?↘ -2/.test(html) && /压力均值[\s\S]*?↘ -5/.test(html));
t('心率卡写着 24h 最低–最高（平滑后的曲线看不出尖峰，数字得在）', /24h 58–120/.test(html));
t('血氧有数才出那一行', /血氧/.test(html));
box.state.bandData.daily = [{ ...week[0], SPO2_AVG: 0 }];
box.renderBandPanel();
t('血氧是 0 就不画', !/血氧/.test(bodyEl.innerHTML));
// 「前一天」按时间戳找：daily7 里最新那条跟 daily 不是同一天时，不能拿 daily7[1]
box.state.bandData.daily = [week[0]]; box.state.bandData.daily7 = week.slice(1);
box.renderBandPanel();
t('前一天按时间戳找，不按下标', /静息心率[\s\S]*?↘ -2/.test(bodyEl.innerHTML), bodyEl.innerHTML.match(/静息心率[\s\S]{0,200}/)?.[0]);
const meters = [...html.matchAll(/class="band-meter"><i style="width:(\d+)%/g)].map(m => +m[1]);
t('细条都在 0–100% 里', meters.length >= 3 && meters.every(v => v >= 0 && v <= 100), meters);

console.log('\n[心率线：上千个点不连成锯齿]');
const calls = { quad: 0, line: 0 };
const ctx = new Proxy({}, { get: (o, k) => k === 'quadraticCurveTo' ? () => calls.quad++ : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : (k in o ? o[k] : () => {}), set: (o, k, v) => (o[k] = v, true) });
const cv = { clientWidth: 300, clientHeight: 120, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0 }) };
const lb = { window: { devicePixelRatio: 1 }, document: { getElementById: id => id === 'cv' ? cv : (id === 'bandTip' ? { style: {} } : null), createElement: () => ({ style: {} }), body: { appendChild() {} } }, Math, Date };
lb.window = lb; lb.devicePixelRatio = 1;
vm.createContext(lb);
vm.runInContext(helpers + fnSrc(band, '_bandCanvas') + fnSrc(band, '_bandTip') + fnSrc(band, 'drawBandLine'), lb);
const pts = Array.from({ length: 1440 }, (_, i) => ({ t: i * 60000, v: 60 + 20 * Math.sin(i / 90) + (i % 7) }));
lb.drawBandLine('cv', pts, 'bpm');
// 底下的面积和上面的线各描一遍
t('1440 个点按 96 格画（每遍不超过 95 段曲线）', calls.quad > 0 && calls.quad <= 95 * 2, calls.quad);
calls.quad = 0;
lb.drawBandLine('cv', pts.slice(0, 2), 'bpm');
t('只有两个点也照样画', calls.quad === 2, calls.quad);

console.log('\n[搬进小组件那一帧还没宽度]');
// 10-14 headless 实测：从小组件打开，四张图全是 0×0 —— 画的时候面板还没排版，之后也没人再画
cv.clientWidth = 0;
let threw = null; calls.quad = 0;
try { lb.drawBandLine('cv', pts, 'bpm'); } catch (e) { threw = e.message; }
t('零宽不画也不抛错（零宽画胶囊是负半径，会把后面几张图一起拖死）', !threw && calls.quad === 0, threw);
const rs = fnSrc(band, 'renderBandPanel');
t('盯着 bandBody 的宽度，变了就重画', /new ResizeObserver\(/.test(rs) && /\.observe\(box\)/.test(rs) && /box\._bandRedraw\?\.\(\)/.test(rs));
t('只盯一次（每次刷新数据不再叠一个观察者）', /if \(!box\._bandRO && typeof ResizeObserver === 'function'\)/.test(rs));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
