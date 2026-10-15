'use strict';
// 编程工作台：把文件拖进来 → 拿到绝对路径（2026-08-28）
//
// 为什么单开一个文件而不是塞进 code-workbench.test.js：那个文件用的是裸 assert，
// 第一条不过就整个中断、一行 ✗ 都不打。fault-inject.js 认的是 ✗ 行，
// 挂上去只会得到一条笼统的「跑到一半炸了」，分不出到底是哪道守住了。
// 这里用 t() 逐条打分，注入才能落到具体那条上。
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
const preload = read('preload.js');
const main = read('electron-main.js');
const core = read('js/01-core.js');
const html = read('index.html');
const css = read('css/grancyan.css');

// ── 一、接线：少任何一环，功能都是静默失效（不报错，就是永远拿不到路径）──────
// 剥掉注释再断言：preload.js 的注释里就写着 nodeIntegration / File.path 在讲
// 「为什么不能用它们」。对全文做匹配等于在守文字而不是守代码 —— 写这条测试的时候
// 就真的被自己的注释喂了一次假绿。
const preloadCode = preload.replace(/^\s*\/\/.*$/gm, '');
t('preload 走 webUtils（File.path 在 Electron 32 已删，照抄网上答案会永远返回 undefined）',
  /webUtils\.getPathForFile/.test(preloadCode));
t('preload 把接口挂在 grancyanDesktop 上', /exposeInMainWorld\('grancyanDesktop'/.test(preloadCode));
t('拿不到路径返回空串，不把异常抛给调用方', /getPathForFile\(file\) \|\| ''/.test(preloadCode));
t('preload 不碰 fs（暴露出去的东西整个页面都能调，包括聊天里渲染的第三方内容）',
  !/require\(['"]node:fs['"]\)|\bfs\./.test(preloadCode));
t('electron-main 真的把 preload 接上了（没接 = 功能整个不存在）',
  /preload: path\.join\(__dirname, 'preload\.js'\)/.test(main));
t('没有为了 preload 去降安全设置',
  !/contextIsolation: false|sandbox: false|nodeIntegration: true/.test(main));

// ── 二、拖歪一次不许赔上整个页面 ─────────────────────────────────────────
// 往没有 drop 处理器的地方拖文件，默认动作是**导航到那个文件**，聊天页当场被换掉。
// 两道各自独立：渲染进程一道、主进程一道。
t('主进程挡住 file: 导航', /url\.startsWith\('file:'\)/.test(main));
t('渲染进程有 window 级拖放兜底', /\['dragover', 'drop'\]\.forEach/.test(core));

// ── 三、提示层的两个「不这么写就会坏」──────────────────────────────────
t('提示层 position:absolute 脱离 grid 流（.cw-overlay 是两列，多一个流内子元素会挤成三格）',
  /\.cw-overlay\.cw-dragging \.cw-dropzone-hint\{position:absolute/.test(css));
t('提示层 pointer-events:none（否则它一出来就成了拖拽目标，自己触发 dragleave 闪成闪灯）',
  /\.cw-dropzone-hint\{position:absolute[^}]*pointer-events:none/.test(css));
t('提示层挂在工作台里', /cw-dropzone-hint/.test(html));
t('dragleave 用配对计数（子元素之间移动也会触发 dragleave）',
  /_cwDragDepth = Math\.max\(0, _cwDragDepth - 1\)/.test(ui));
t('关闭工作台时清掉拖拽状态（拖到一半按 Esc，不清就永远卡在高亮）',
  /_cwDragDepth = 0; document\.getElementById\('codeWorkbenchModal'\)\?\.classList\.remove\('cw-dragging'\)/.test(ui));

// ── 四、真跑逻辑 ────────────────────────────────────────────────────────
const from = ui.indexOf('let _cwDragDepth = 0;');
const to = ui.indexOf('function cwUsageHtml(', from);
t('能提取拖放函数段', from >= 0 && to > from);

const BS = String.fromCharCode(92);           // 一个反斜杠
const P_A = 'D:' + BS + 'code' + BS + 'a.js';
const P_B = 'D:' + BS + 'code' + BS + 'b.js';
const P_SPACE = 'C:' + BS + 'Program Files' + BS + 'x.dll';

function sandbox({ filePathOf, session = { id: 's1' }, value = '' } = {}) {
  const input = {
    value, selectionStart: value.length, selectionEnd: value.length,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    focus() {}
  };
  const toasts = [];
  const box = {
    window: filePathOf ? { grancyanDesktop: { filePathOf } } : {},
    document: { getElementById: id => (id === 'cwInput' ? input : null) },
    showToast: (msg, type) => toasts.push({ msg, type }),
    autoResize: () => {},
    cwSession: () => session,
    Math, input, toasts
  };
  vm.createContext(box);
  vm.runInContext(ui.slice(from, to) +
    '\nthis.hasFiles = cwDragHasFiles; this.quote = cwQuotePath; this.drop = cwHandleDrop;', box);
  return box;
}
const files = list => ({ dataTransfer: { files: list } });
const said = box => box.toasts.map(x => x.msg).join(' | ');

const s1 = sandbox({ filePathOf: f => f.__p });
t('拖的是文件 → 认', s1.hasFiles({ dataTransfer: { types: ['Files'] } }) === true);
t('拖的是选中的文字 → 不认（不该亮放置提示）',
  s1.hasFiles({ dataTransfer: { types: ['text/plain'] } }) === false);
t('普通路径不加引号', s1.quote(P_A) === P_A, s1.quote(P_A));
t('带空格的路径加引号（不加的话 agent 拿到会拆成两个参数，看着贴对了、用起来才错）',
  s1.quote(P_SPACE) === '"' + P_SPACE + '"', s1.quote(P_SPACE));

s1.drop(files([{ name: 'a.js', __p: P_A }]));
t('拖一个 → 路径进输入框', s1.input.value === P_A, s1.input.value);
s1.drop(files([{ name: 'b.js', __p: P_B }]));
t('连着拖两个 → 中间有空格，不粘成一串', s1.input.value === P_A + ' ' + P_B, s1.input.value);

const s2 = sandbox({ filePathOf: f => f.__p });
s2.drop(files([{ name: 'a', __p: P_A }, { name: 'x', __p: P_SPACE }]));
t('一次拖多个 → 逐个按需加引号',
  s2.input.value === P_A + ' "' + P_SPACE + '"', s2.input.value);

// getPathForFile 对「JS 造出来、背后没有磁盘文件」的 File 返回**空字符串**（文档写着，不抛错）。
// 不吭声的话表现就是「拖了没反应」，她只会以为拖歪了，反复重试 —— 又一次静默失败。
const s3 = sandbox({ filePathOf: () => '' });
s3.drop(files([{ name: '截图.png' }]));
t('拿不到路径 → 不往输入框贴空东西', s3.input.value === '', s3.input.value);
t('拿不到路径 → 明确说出来，不装作没发生', /拿不到磁盘路径/.test(said(s3)), said(s3));

// 手机和浏览器里永远拿不到电脑上的路径，这是浏览器安全模型，不是没做。
const s4 = sandbox({});
s4.drop(files([{ name: 'a.js' }]));
t('浏览器/手机 → 说清楚只有桌面 exe 能用', /只在桌面 exe 里能用/.test(said(s4)), said(s4));
t('浏览器/手机 → 不往输入框写东西', s4.input.value === '', s4.input.value);

const s5 = sandbox({ filePathOf: f => f.__p, session: null });
s5.drop(files([{ name: 'a.js', __p: P_A }]));
t('没选会话 → 先让她选，不往不存在的地方贴', /先选一条会话/.test(said(s5)), said(s5));
t('没选会话 → 输入框保持原样', s5.input.value === '', s5.input.value);

// 光标处插入：不是无脑 append
const s6 = sandbox({ filePathOf: f => f.__p, value: '看看 和 这个' });
s6.input.selectionStart = s6.input.selectionEnd = 3;   // 「看看 」之后
s6.drop(files([{ name: 'a.js', __p: P_A }]));
t('从光标处插入，前后各补一个空格且不重复补',
  s6.input.value === '看看 ' + P_A + ' 和 这个', s6.input.value);

// ── 五、桌面与安卓副本一致 ──────────────────────────────────────────────
for (const f of ['js/41-code-workbench.js', 'js/01-core.js']) {
  t('android 副本与 ' + f + ' 一致',
    fs.readFileSync(path.join(ROOT, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets', f))));
}
t('android 副本与 index.html 一致',
  fs.readFileSync(path.join(ROOT, 'index.html')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html'))));
t('android 副本与 css/grancyan.css 一致',
  fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n✅ ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
