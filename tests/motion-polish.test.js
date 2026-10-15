// 动效打磨（2026-10-08）的回归测试。跑法：node tests/motion-polish.test.js
//
// 守的都是**静默失效**——界面看着正常、控制台不报错：
//   · 空页面极光换成消息列表时没收摊：每进一次空对话就漏一个 WebGL 上下文，
//     安卓 WebView 攒到十几个就开始丢最老的上下文（别的 canvas 一起黑掉）
//   · 「思考中」流光挂到了思考完的标题上：概括那句会一直闪
//   · 减少动态效果时流光/逐字进场还在跑
// 屏幕上真的扫光、真的还掉上下文，是在 headless 里量的（isContextLost / animationName），
// 这里只守源码里那几根线别被人剪断。

const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

const render = read('js/06-render-msg.js');
const api = read('js/05-prompts-api.js');
const css = read('css/grancyan.css');

console.log('── 空页面极光 ──');
const rm = render.slice(render.indexOf('function renderMessages()'));
const emptyBranch = rm.slice(0, rm.indexOf('_emptyStateRendered = false;'));
t('空页面画出来时挂上极光', /_emptyAurora\(win\.querySelector\('\.empty-aurora'\)\)/.test(emptyBranch));
t('换成消息列表时收摊（不收＝每进一次空对话漏一个 WebGL 上下文）',
  /_emptyStateRendered = false;\s*\n\s*_emptyAuroraStop\?\.\(\);/.test(rm));
const fn = render.slice(render.indexOf('function _emptyAurora('), render.indexOf('\n}\n', render.indexOf('function _emptyAurora(')));
t('新开一张之前先收掉上一张', /^function _emptyAurora\(cv\) \{\s*\n\s*_emptyAuroraStop\?\.\(\);/.test(fn));
const bgGuard = fn.indexOf('if (state.background) return;'), glAt = fn.indexOf("getContext('webgl'");
t('有壁纸不画（花壁纸上只会糊成一团雾），而且是在拿 WebGL 上下文之前就退',
  bgGuard > 0 && glAt > 0 && bgGuard < glAt, { bgGuard, glAt });
t('壁纸晚到（异步读 IndexedDB / 开着空页面换壁纸）也会收摊',
  /function frame\([\s\S]*?if \(state\.background\) \{ cv\.classList\.remove\('on'\); return stop\(\); \}/.test(fn));
t('收摊真的还上下文', /loseContext\(\)/.test(fn));
t('canvas 被换掉自己也能发现', /cv\.isConnected/.test(fn));
t('切后台停帧', /document\.hidden/.test(fn) && /visibilitychange/.test(fn));
t('减少动态效果只画一帧', /prefers-reduced-motion: reduce/.test(fn) && /if \(still\)[^\n]*stop\(\)/.test(fn));

console.log('── 「思考中」流光 ──');
const liveRender = (render.match(/think-label\$\{streaming \? ' think-live' : ''\}/g) || []).length;
const liveApi = (api.match(/think-label\$\{(?:isActive|streaming) \? ' think-live' : ''\}/g) || []).length;
t('三处「💭 思考中…」都带 think-live，且只在流式时', liveRender === 1 && liveApi === 2, { liveRender, liveApi });
const bare = (render + api).match(/<span class="think-label think-live">/g);
t('没有写死 think-live 的（写死＝思考完也一直闪）', !bare);
t('流光只挂在 .think-live 上', /\.think-label\.think-live\s*\{[^}]*animation:thinkShine/.test(css)
  && !/\.think-block:not\(\.done\)[^{]*\{[^}]*thinkShine/.test(css));

console.log('── 减少动态效果 ──');
const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\}\s*\}|@media \(prefers-reduced-motion: reduce\) \{[^\n]*\}/g) || [];
const r = reduced.join('\n');
t('流光关掉', /\.think-label\.think-live\s*\{\s*animation:none/.test(r));
t('标题逐字进场关掉', /\.empty-title span[^{]*\{\s*animation:none/.test(r));
t('消息进场退回近乎瞬间', /\.msg-group\s*\{\s*animation-name:bubble-in;animation-duration:\.01s/.test(r));

console.log(fail ? `\n❌ ${pass} passed, ${fail} failed` : `\n✅ ${pass} passed`);
process.exit(fail ? 1 : 0);
