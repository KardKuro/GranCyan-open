'use strict';
// 淡墨出字（js/70-ink.js）的接线。效果本身（排队慢放、重画接得上、收尾放完才出页脚）
// 在 tests/browser-ink.js 里用真浏览器量；这里守的是「哪根线断了也不报错，只是效果悄悄没了」的那几处：
//   · 画气泡 / 收尾 / renderMessages 三个挂点
//   · 开关和速度的持久化（三道关 + 云端）
//   · 拖窗口的全局关动画开关不许碰淡墨
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const ink = read('js/70-ink.js');
const api = read('js/05-prompts-api.js');
const msg = read('js/06-render-msg.js');
const html = read('index.html');
const css = read('css/grancyan.css');
const core = read('js/01-core.js');
const st = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');

console.log('[挂点]');
const paint = api.slice(api.indexOf('function _paintLiveBubble('), api.indexOf('function clearAgentRunRefs('));
t('★ _paintLiveBubble 的 blocks 分支画完就蒙（早退之前）', /_patchLiveBubble\(bubble, renderBlocksHtml\(blocks, streaming\)\);\n\s*if \(typeof inkPaint === 'function'\) inkPaint\(elId, streaming\);[^\n]*\n\s*return;/.test(paint));
t('★ _paintLiveBubble 的旧路径也蒙（排在 typesetMath 之后）', /typesetMath\(bubble\);\n\s*if \(typeof inkPaint === 'function'\) inkPaint\(elId, streaming\);/.test(paint));
const live = api.slice(api.indexOf('function renderLiveBubble('), api.indexOf('function _patchLiveBubble('));
t('★ renderLiveBubble 收尾那次告诉淡墨「写完了」', /_paintLiveBubble\(elId, fullText, reasoningText, streaming, blocks\);\n[^\n]*\n\s*if \(typeof inkEnd === 'function'\) inkEnd\(elId\);\n\s*return;/.test(live));
const rm = msg.slice(msg.indexOf('function renderMessages()'), msg.indexOf('function _scrollToBottomSettled('));
t('★ renderMessages 换完节点重新蒙，而且排在滚到底之前', rm.indexOf('inkAfterRender()') > 0 && rm.indexOf('inkAfterRender()') < rm.indexOf('if (atBottom)'));
t('脚本挂上了', /<script src="\.\/js\/70-ink\.js"><\/script>/.test(html));

console.log('\n[开关和速度]');
t('外观里有开关和速度下拉', /id="inkStreamToggle"[^>]*onchange="state\.inkStream=this\.checked;save\(\)"/.test(html) && /id="inkRateSelect"[^>]*onchange="state\.inkRate=\+this\.value;save\(\)"/.test(html));
t('★ 默认值：开、每秒 14 字', /inkStream: true, inkRate: 14/.test(st));
t('★ 落盘', /idbSet\('kuro_inkStream'/.test(st) && /idbSet\('kuro_inkRate'/.test(st));
t('★ 读盘（缺省按开）', /inkStream:\s+await g\('kuro_inkStream', true\)/.test(core) && /inkRate:\s+await g\('kuro_inkRate', 14\)/.test(core));
t('★ 启动赋值（没存过＝开）', /state\.inkStream\s+= saved\.inkStream !== false;/.test(boot) && /state\.inkRate\s+= \+saved\.inkRate \|\| 14;/.test(boot));
t('云端设置带上、拉回来也认', /inkStream: state\.inkStream !== false,/.test(core) && /state\.inkStream = s\.inkStream \?\? state\.inkStream;/.test(core));
t('关着 / 系统减少动态效果时不起进度', /state\.inkStream === false\) return false/.test(ink) && /prefers-reduced-motion: reduce/.test(ink)
  && /if \(!streaming \|\| !inkEnabled\(\)\) return;/.test(ink));

console.log('\n[样式]');
t('★ 没轮到的字和块 display:none（不占高度，跟底跟的是墨）', /\.ink-hide, span\.ink-wait \{ display:none !important; \}/.test(css));
t('★ 延时走 --ink-d（负数＝换了节点从半路接着演）', /span\.ink-f, \.ink-atom \{ animation:ink-in 1680ms [^;]*var\(--ink-d,0ms\) both; \}/.test(css));
t('★ 拖窗口的全局关动画开关碰不到淡墨（延时也得 !important 抢回来）',
  /body\.resize-anim-stopper span\.ink-f, body\.resize-anim-stopper \.ink-atom \{[^}]*animation-name:ink-in !important;[^}]*animation-delay:var\(--ink-d,0ms\) !important;/.test(css));
t('页脚字显完再出来', /\.msg-group\.ink-busy \.msg-token-info/.test(css));

console.log('\n[几条不变式]');
t('★ 离开只认明确信号（切走/切后台），不拿两帧间隔猜', /visibilitychange/.test(ink) && /st\.awayAt/.test(ink) && !/gap > INK_AWAY_MS/.test(ink));
t('★ 失焦也算离开（exe 被盖住不算 hidden，rAF 照跑），回焦/回前台按离开时刻补 awayAt',
  /window\.addEventListener\('blur'[^\n]*!document\.hasFocus\(\)\) _inkLeave\(\)/.test(ink) && /window\.addEventListener\('focus', _inkBack\)/.test(ink)
  && /document\.hidden \? _inkLeave\(\) : _inkBack\(\)/.test(ink) && /st\.awayAt = st\.awayAt \? Math\.min\(st\.awayAt, t\) : t/.test(ink));
t('★ 写完了墨还在放：补光标，放完 / 收工时拿掉', /cursor\.dataset\.inkCur = '1'/.test(ink) && /cursor\.dataset\.inkCur && st\.R >= st\.L\) cursor\.remove\(\)/.test(ink)
  && /function _inkFinish[\s\S]{0,200}\[data-ink-cur\]/.test(ink));
t('后台回来每帧最多按 0.1 秒算',/Math\.min\(0\.1, gap \/ 1000\)/.test(ink));
t('表情不劈成两半', /0xD800 && code <= 0xDBFF/.test(ink));
t('思考框不蒙', /_INK_SKIP = '\.think-block/.test(ink));
t('收工时揭干净（等着的字、藏着的块、整块淡入都撤）', /function _inkFinish[\s\S]{0,200}_inkUnveil\(el, true\)/.test(ink));
t('★ 摘 class 不留空属性（不然 _patchLiveBubble 每次整条换掉）', /if \(!on && el\.getAttribute\('class'\) === ''\) el\.removeAttribute\('class'\)/.test(ink)
  && !/classList\.(toggle|remove)\('ink-hide'/.test(ink));
t('★ 页脚连离开页面的旧节点一起摘（切到空对话时收的工）', /for \(const el of \[\.\.\.st\.els, \.\.\.els\]\)/.test(ink));
t('★ 流回调里同步跑的 inkPaint 出错不往外冒', /function inkPaint[\s\S]{0,200}try \{[\s\S]*?\} catch \(e\) \{\n\s*console\.warn\('\[淡墨\]'/.test(ink));
t('找回电脑上的活：整条重放的那段不慢放', /inkFlush\('bubble-' \+ aiId, 2000\)/.test(api));
t('积压多时每帧上限跟着速度涨', /Math\.min\(Math\.max\(4, speed \* 0\.1\)/.test(ink));

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
