'use strict';
// 编程工作台：Enter 直接发送（用户要的）
//
// 单开文件的理由同 workbench-drop.test.js：code-workbench.test.js 用裸 assert，
// 第一条不过就整个中断、一行 ✗ 都不打，挂进 fault-inject.js 分不出是哪道守住的。
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

const ui = read('js/41-code-workbench.js');
const core = read('js/01-core.js');
const chat = read('js/13-trash-ctx-ui.js');
const html = read('index.html');

// ── 一、判据只有一份 ────────────────────────────────────────────────────
// 主聊天框和工作台共用 isMobileComposer()。抄第二份的话两处迟早漂移，
// 而漂移的表现是「同一个软件里回车行为不一样」—— 查之前还得先想到有两份。
const chatCode = chat.replace(/^\s*\/\/.*$/gm, '');
t('主聊天框改成调用共享判据', /const isMobile = isMobileComposer\(\);/.test(chatCode));
t('主聊天框不再留着自己那份内联判据（留着就是两份，改一处等于没改）',
  !/ontouchstart' in window && window\.innerWidth <= 900/.test(chatCode));
t('工作台用的是同一个函数，没抄第二份', /isMobileComposer\(\)/.test(ui));
t('共享判据定义在 01-core.js（两边都在它之后加载）', /function isMobileComposer\(\)/.test(core));

// ── 二、真跑判据本身 ────────────────────────────────────────────────────
const coreFrom = core.indexOf('function isMobileComposer()');
const coreTo = core.indexOf('\n}', coreFrom) + 2;
t('能提取判据函数', coreFrom >= 0 && coreTo > coreFrom);
const MOBILE_SRC = core.slice(coreFrom, coreTo);

function mobileIs(ua, { touch = false, width = 1600 } = {}) {
  const box = { navigator: { userAgent: ua }, window: { innerWidth: width } };
  if (touch) box.window.ontouchstart = null;
  vm.createContext(box);
  vm.runInContext(MOBILE_SRC + '\nthis.r = isMobileComposer();', box);
  return box.r;
}
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Electron/43';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile Safari/537.36';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/605';
t('桌面 → Enter 发送', mobileIs(UA_WIN) === false);
t('安卓 → Enter 换行', mobileIs(UA_ANDROID) === true);
t('iPad → Enter 换行', mobileIs(UA_IPAD) === true);
t('触摸屏 + 窄窗口 → 按手机处理', mobileIs(UA_WIN, { touch: true, width: 800 }) === true);
// 这条守着「别跟 isMobileLayout() 合并」：那个是 CSS 布局断点（≤768px），
// 拿它判 Enter 的话，电脑上把窗口拉窄一点回车就突然不发送了，而且毫无提示。
t('桌面把窗口拉窄（无触摸）→ 回车照样发送，不跟着 CSS 断点走',
  mobileIs(UA_WIN, { width: 500 }) === false);

// ── 三、真跑 cwInputKeydown ─────────────────────────────────────────────
const from = ui.indexOf('function cwInputKeydown(e) {');
const to = ui.indexOf('async function cwExecuteCommand(', from);
t('能提取键盘处理函数', from >= 0 && to > from);

function kb({ menuHidden = true, ua = UA_WIN, status = 'idle', overlayOpen = false } = {}) {
  const calls = { sent: 0, stopped: 0, picked: 0, changed: 0, hidden: 0, closedOverlay: 0 };
  const menu = {
    classList: { contains: c => (c === 'hidden' ? menuHidden : false), add: () => { menuHidden = true; calls.hidden++; } },
    querySelector: () => ({ dispatchEvent: () => calls.picked++ })
  };
  const box = {
    navigator: { userAgent: ua }, window: { innerWidth: 1600 },
    document: { getElementById: id => (id === 'cwCommandMenu' ? menu : null) },
    cwSend: () => calls.sent++,
    cwStop: () => calls.stopped++,
    cwSession: () => ({ status }),
    // Escape 现在是两级的：先关浮层，没浮层可关才去停任务。返回值就是「我关掉东西了吗」，
    // 少了这个 stub 整个文件会直接 ReferenceError 崩掉，一行 ✓ 都打不出来。
    cwCloseOverlay: () => { if (!overlayOpen) return false; overlayOpen = false; calls.closedOverlay++; return true; },
    cwInputChanged: () => calls.changed++,
    cwHideCommandMenu: () => { menuHidden = true; calls.hidden++; },
    MouseEvent: function (type) { this.type = type; },
    Math, calls
  };
  vm.createContext(box);
  vm.runInContext(MOBILE_SRC + ui.slice(from, to) + '\nvar _cwCommandIndex = 0;\nthis.key = cwInputKeydown;', box);
  return box;
}
const ev = (key, opts = {}) => Object.assign({
  key, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0,
  prevented: false, currentTarget: {},
  preventDefault() { this.prevented = true; }, stopPropagation() {}
}, opts);

// ① 主路径
let b = kb(); let e = ev('Enter'); b.key(e);
t('桌面 Enter → 发送', b.calls.sent === 1);
t('桌面 Enter → preventDefault（否则发出去的同时输入框里还多一个换行）', e.prevented === true);

// ② Shift+Enter 换行：既不能发，也**不能** preventDefault —— 拦了就换不了行
b = kb(); e = ev('Enter', { shiftKey: true }); b.key(e);
t('Shift+Enter → 不发送', b.calls.sent === 0);
t('Shift+Enter → 不拦默认行为（拦了就永远换不了行）', e.prevented === false);

// ③ 输入法组合态：中文打字按 Enter 是上屏候选词。
//   失效方向最坏 —— 打到一半的中文被当成完整任务发出去，agent 立刻开始动手。
b = kb(); e = ev('Enter', { isComposing: true }); b.key(e);
t('输入法组合中 → 不发送（选词的那次回车不许误发）', b.calls.sent === 0);
t('输入法组合中 → 不拦（拦了候选词就上不了屏）', e.prevented === false);
b = kb(); b.key(ev('Enter', { keyCode: 229 }));
t('keyCode 229（老 WebView 的组合态）→ 不发送', b.calls.sent === 0);

// ④ 手机
b = kb({ ua: UA_ANDROID }); e = ev('Enter'); b.key(e);
t('手机 Enter → 不发送，留给换行', b.calls.sent === 0);
t('手机 Enter → 不拦', e.prevented === false);
b = kb({ ua: UA_ANDROID }); b.key(ev('Enter', { ctrlKey: true }));
t('手机接外接键盘 Ctrl+Enter → 照样发', b.calls.sent === 1);
b = kb(); b.key(ev('Enter', { ctrlKey: true }));
t('桌面 Ctrl+Enter → 照旧能发（不动老肌肉记忆）', b.calls.sent === 1);
b = kb(); b.key(ev('Enter', { metaKey: true }));
t('Cmd+Enter → 照样发', b.calls.sent === 1);

// ⑤ 斜杠命令菜单开着的时候，Enter 是「选中这条命令」，绝不能变成发送
b = kb({ menuHidden: false }); e = ev('Enter'); b.key(e);
t('命令菜单开着 → Enter 选命令', b.calls.picked === 1);
t('命令菜单开着 → Enter 不发送（不然 /help 会被当成任务派出去）', b.calls.sent === 0);

// ⑥ 其它键不受影响
b = kb(); b.key(ev('a'));
t('普通字符 → 不发送', b.calls.sent === 0);
b = kb({ status: 'running' }); e = ev('Escape'); b.key(e);
t('Escape 仍然停止任务，没被 Enter 分支吃掉', b.calls.stopped === 1);
// Escape 的两级：浮层开着时它只是「关掉这个面板」。要是这一级漏了，
// 用户想收起面板会顺手把正在跑的活掐掉 —— 而且掐得悄无声息。
b = kb({ status: 'running', overlayOpen: true }); b.key(ev('Escape'));
t('浮层开着 → Escape 只关浮层', b.calls.closedOverlay === 1);
t('浮层开着 → Escape 不停任务（收面板不该顺手掐掉正在跑的活）', b.calls.stopped === 0);
b = kb(); b.key(ev('ArrowDown'));
t('方向键仍然只走菜单分支', b.calls.sent === 0);

// ── 四、提示文案要跟真实行为一致 ────────────────────────────────────────
t('工作台底部写了 Enter 发送', /<kbd>Enter<\/kbd> 发送/.test(html));
t('写了 Shift Enter 换行', /<kbd>Shift Enter<\/kbd> 换行/.test(html));
// 手机上 Enter 不发送，这两条提示就是错的 —— 必须能被窄屏样式摘掉。
t('这两条挂了 cw-key-desktop，手机上不显示（否则提示在手机上说谎）',
  (html.match(/class="cw-key-desktop"/g) || []).length === 2);
t('窄屏样式真的把它们藏了', /\.cw-compose-meta \.cw-key-desktop\{display:none\}/.test(read('css/grancyan.css')));

// ── 五、桌面与安卓副本一致 ──────────────────────────────────────────────
for (const f of ['js/41-code-workbench.js', 'js/01-core.js', 'js/13-trash-ctx-ui.js', 'index.html', 'css/grancyan.css']) {
  t('android 副本与 ' + f + ' 一致',
    fs.readFileSync(path.join(ROOT, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets', f))));
}

console.log(`\n✅ ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
