'use strict';
// 编程工作台：覆盖层的关闭出口（用户报的 bug）
// 原状：额度面板整块替换 feed，既没有 ✕ 也不吃 Esc，唯一出路是切会话 —— 看着像卡死。
// 这一套守的东西全是「删掉也不报错、只是关不掉」的，所以每条都真跑 cwCloseOverlay，
// 不做宽泛的字符串包含。
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
const css = read('css/grancyan.css');
const NL = String.fromCharCode(10);

// 真跑 cwUsageHtml + cwCloseOverlay（源码里这两个函数相邻）
const from = ui.indexOf('function cwUsageHtml');
const to = ui.indexOf('async function cwShowUsage');
const box = { console };
vm.createContext(box);
vm.runInContext([
  'var _E={"&":"&amp;","<":"&lt;",">":"&gt;"};',
  'function escHtml(s){return String(s).replace(/[&<>]/g,function(c){return _E[c];});}',
  'var CW_COMMANDS=[{name:"/usage",desc:"看额度"}];',
  'var _cwUsagePanel=null,_cwTraceProvider="",_cwTrashOpen=false;',
  'var renders=0,menuHidden=false,menuOpen=false;',
  'function cwRender(){renders++;}',
  'function cwHideCommandMenu(){menuHidden=true;menuOpen=false;}',
  'var document={getElementById:function(id){',
  '  if(id!=="cwCommandMenu")return null;',
  '  return {classList:{contains:function(c){return c==="hidden"?!menuOpen:false;}}};',
  '}};',
  ui.slice(from, to),
  'this.close=cwCloseOverlay; this.usageHtml=cwUsageHtml;',
  'this.set=function(o){_cwUsagePanel=o.panel!==undefined?o.panel:null;_cwTraceProvider=o.trace||"";',
  '  _cwTrashOpen=!!o.trash;menuOpen=!!o.menu;menuHidden=false;renders=0;};',
  'this.get=function(){return{panel:_cwUsagePanel,trace:_cwTraceProvider,trash:_cwTrashOpen,',
  '  menuHidden:menuHidden,renders:renders};};',
].join(NL), box);

console.log('[1] Esc 分层：一次只关最上面那层');
box.set({ panel: { provider: 'claude' } });
t('额度面板开着时 Esc 关掉它并返回 true（true = 这次 Esc 被吃掉了）',
  box.close() === true && box.get().panel === null);
box.set({ trace: 'claude' });
t('完整链路视图能被关掉', box.close() === true && box.get().trace === '');
box.set({ trash: true });
t('回收站能被关掉', box.close() === true && box.get().trash === false);
box.set({ menu: true, panel: { provider: 'codex' } });
const afterMenu = (box.close(), box.get());
t('命令菜单排在面板上面：先关菜单，面板留着',
  afterMenu.menuHidden === true && afterMenu.panel !== null);

// 这条是整件事的核心：返回 false 才轮到 cwStop。
// 如果 cwCloseOverlay 无脑返回 true，Esc 将永远停不掉任务，且不报错。
console.log('[2] 什么都没开的时候要放行，让 Esc 回到「中断任务」');
box.set({});
t('没有任何覆盖层时返回 false（放行给 cwStop）', box.close() === false);
t('放行时不触发重绘', box.get().renders === 0);

console.log('[3] 两处 Esc 都必须走这个出口');
// 输入框内一处、window 全局一处，少接一处就会出现「焦点在输入框里 Esc 没反应」。
const escSites = ui.match(/!cwCloseOverlay\(\)\s*&&\s*cwSession\(\)\?\.status === 'running'/g) || [];
t('Esc 处理有两处且都是「先关覆盖层，关不掉才停任务」', escSites.length === 2, escSites.length);
t('旧的「Esc 只在 running 时才有反应」写法已经没有了',
  !/e\.key === 'Escape' && cwSession\(\)\?\.status === 'running'/.test(ui));

console.log('[4] 每个面板都自带 ✕');
const usageHtml = box.usageHtml({ provider: 'claude', quota: { plan: 'Max' }, tokens: 10 });
const helpHtml = box.usageHtml({ type: 'help' });
t('额度面板有 ✕ 且绑到 cwCloseOverlay',
  /class="cw-panel-close"[^>]*onclick="cwCloseOverlay\(\)"/.test(usageHtml));
t('帮助面板（/help）也有 ✕',
  /class="cw-panel-close"[^>]*onclick="cwCloseOverlay\(\)"/.test(helpHtml));
t('✕ 和标题在同一行（cw-panel-head），不是浮在正文里',
  /class="cw-panel-head"[^]*?<h4>[^]*?cw-panel-close/.test(usageHtml));
t('链路视图的 banner 上也有 ✕',
  /cw-trace-banner[^]*?class="cw-panel-close"/.test(ui));

console.log('[5] 额度按钮是 toggle —— 再点一次收起');
t('cwShowUsage 开头有「已开则关」的早退',
  /if \(_cwUsagePanel && _cwUsagePanel\.type !== 'help'\) \{ _cwUsagePanel = null;/.test(ui));

console.log('[6] ✕ 的样式真的存在且颜色值合法');
const closeRules = (css.match(/\.cw-panel-close[^{]*\{[^}]*\}/g) || []);
t('.cw-panel-close 有样式规则', closeRules.length >= 1, closeRules.length);
t('✕ 是可点的样子（cursor:pointer）', /cursor:pointer/.test(closeRules.join('')));
// 手滑打错颜色时 CSS 不报错，只是那条声明被整条丢弃（hover 静默失效）。
const hexes = closeRules.join('').match(/#[0-9a-zA-Z]+/g) || [];
const badHex = hexes.filter(h => !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h));
t('所有颜色值都是合法 hex（打错的话浏览器静默丢弃）', badHex.length === 0, badHex);
t('cw-panel-head 让标题和 ✕ 分居两端', /\.cw-panel-head\{[^}]*justify-content:space-between/.test(css));
t('trace banner 改成 flex 才放得下 ✕', /\.cw-trace-banner\{[^}]*display:flex/.test(css));

console.log(NL + (fail ? '失败 ' + fail + ' / ' : '') + '通过 ' + pass);
process.exit(fail ? 1 : 0);
