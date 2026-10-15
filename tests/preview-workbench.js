'use strict';
// 编程工作台 CLI 版式的视觉预览：真的调 41-code-workbench.js 里的渲染函数，
// 真的套 css/grancyan.css，headless Chrome 出一张 PNG。
// 为什么不手写一段假 HTML：手写的话验的是我想象中的结构，
// 渲染函数改坏了照样出好看的图。跑法：node tests/preview-workbench.js
//
// 注意：这个文件里一个反斜杠字面量都不要写（路径分隔符用 path.sep，引号用
// fromCharCode(34)）。这台机器的工具链会把源码里的 \ 静默降成 \，写了就是语法错。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'workbench-cli-preview.png');
const CDP = 9243;
const NL = String.fromCharCode(10);
const fwd = p => p.split(path.sep).join('/');
const PROFILE = path.join(os.tmpdir(), 'gc-preview-' + Date.now());
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ui = fs.readFileSync(path.join(ROOT, 'js/41-code-workbench.js'), 'utf8');

const from = ui.indexOf('function cwRenderMessage');
const to = ui.indexOf('function cwRender(');
if (from < 0 || to < 0 || to <= from) throw new Error('渲染段没找到，函数名可能改了');
const box = {};
vm.createContext(box);
vm.runInContext([
  'var _ESC={"&":"&amp;","<":"&lt;",">":"&gt;"}; _ESC[String.fromCharCode(34)]="&quot;";',
  'function escHtml(s){return String(s).replace(/[&<>"]/g,function(c){return _ESC[c];});}',
  'function cwTimingText(m){return m.thinkMs?("思考 "+(m.thinkMs/1000).toFixed(1)+"s"):"";}',
  ui.slice(from, to),
  'this.msg = cwRenderMessage; this.ev = cwRenderEvent;',
].join(NL), box);

const long = Array.from({ length: 22 }, (_, i) => '      line ' + (i + 1) + ' of the tool output').join(NL);
const diff = [
  'Edit(js/41-code-workbench.js)',
  '@@ -190,7 +190,9 @@',
  '-  return `<article class="cw-msg">`',
  '-    + `<header>…名字…时间…</header>`',
  '+  const mark = m.role === "user" ? ">" : "*";',
  '+  return `<article class="cw-msg ${m.role}">`',
  '+    + `<span class="cw-gutter">${mark}</span>`',
].join(NL);
const feed = [
  box.msg({ role: 'user', content: '把工作台的 feed 改成 CC CLI 那种一条文本流，别用气泡卡片。', at: Date.now() }),
  box.ev({ kind: 'thinking', text: ['先确认现有结构：气泡是 .cw-msg>div 上的 border+background，', '换成 gutter 对齐的话，折叠状态也得一起处理。'].join(NL), at: 1 }, 0),
  box.ev({ kind: 'tool', text: 'Read(css/grancyan.css)' + NL + long, at: 2 }, 1),
  box.ev({ kind: 'tool', text: diff, at: 3 }, 2),
  box.ev({ kind: 'result', text: ['测试通过', '+12 -6', long].join(NL), at: 4 }, 3),
  box.ev({ kind: 'error', text: 'android 副本与 css/grancyan.css 不一致', at: 5 }, 4),
  box.msg({ role: 'assistant', provider: 'claude', content: ['改完了。gutter 是一列，四种标记竖直对齐；', '长输出默认折叠成一行摘要，点那行展开。'].join(NL), at: Date.now(), thinkMs: 8400 }),
  box.msg({ role: 'assistant', provider: 'codex', content: 'Codex 这一侧的回答长这样，标记颜色不同。', at: Date.now() }),
].join('');

const html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<link rel="stylesheet" href="file:///' + fwd(path.join(ROOT, 'css/grancyan.css')) + '">',
  // 全局 body 是 display:flex，容器不给 flex:1 会缩成内容宽（看着像 feed 被挤窄）。
  // 另：别把 feed 塞进 .cw-overlay：那是「侧边栏 + 主区」的两列网格，
  // 直接放进去会落到侧边栏那一列（270px），整条流被挤成面条，看着像样式坏了。
  '<style>html,body{margin:0;background:#070910}.cw-preview{flex:1;width:100%;display:flex;flex-direction:column;min-height:100vh}.cw-feed{flex:1;height:auto;padding:26px 40px}</style>',
  '</head><body><div class="cw-preview"><div class="cw-feed">' + feed + '</div>',
  '<footer class="cw-compose" style="border-top:1px solid #202630">',
  '<button class="cw-attach">＋图片</button>',
  '<div class="cw-input-wrap"><span class="cw-prompt">&gt;</span><textarea rows="2" placeholder="让它直接动手，或输入 / 查看命令……"></textarea></div>',
  '<button id="cwSend">开始做</button>',
  '<div class="cw-compose-meta"><span><kbd>Enter</kbd> 发送</span><span><kbd>Shift Enter</kbd> 换行</span><span><kbd>Esc</kbd> 停止</span><span><kbd>Ctrl O</kbd> CC 链路</span></div>',
  '</footer></div></body></html>',
].join(NL);
const page = path.join(os.tmpdir(), 'gc-preview.html');
fs.writeFileSync(page, html, 'utf8');

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--user-data-dir=' + PROFILE,
  '--window-size=1000,1300', 'file:///' + fwd(page)], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

(async () => {
  let tabs = null;
  for (let i = 0; i < 60 && !tabs; i++) {
    try { tabs = await fetch('http://127.0.0.1:' + CDP + '/json/list').then(r => r.json()); }
    catch { await new Promise(r => setTimeout(r, 300)); }
  }
  const tab = tabs && tabs.find(t => t.type === 'page');
  if (!tab) throw new Error('没找到页面标签');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.on('open', ok); ws.on('error', no); });
  let id = 1; const pend = new Map();
  ws.on('message', d => { const m = JSON.parse(d); const j = pend.get(m.id); if (j) { pend.delete(m.id); m.error ? j.no(new Error(m.error.message)) : j.ok(m.result); } });
  const call = (method, params = {}) => new Promise((ok, no) => { const i = id++; pend.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Page.enable');
  await new Promise(r => setTimeout(r, 1000));
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图已存: ' + OUT);
  cleanup(); process.exit(0);
})().catch(e => { console.error('失败:', e.message); cleanup(); process.exit(1); });
