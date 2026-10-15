// 代码预览的「▶ 运行」：同一条消息里的 html / css / js 拼成一页，在沙箱 iframe 里跑。
//
// 用户要的：「运行之后查看的界面，重进之后不存进度」。
// 不存进度靠的是 sandbox 不给 allow-same-origin + 每次 srcdoc 重装；
// 这里守的是拼页逻辑和「关面板要把页面卸掉」（以前只摘 .open，页面在看不见的地方接着跑）。
//
// 跑的是从 13-trash-ctx-ui.js 抠出来的真源码，不手抄。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const uiSrc = fs.readFileSync(path.join(ROOT, 'js', '13-trash-ctx-ui.js'), 'utf8');
const runSrc = uiSrc.match(/function artifactRunKind[\s\S]*?\nfunction buildRunDoc[\s\S]*?\n\}/);
const closeSrc = uiSrc.match(/function closeArtifactPanel\(\) \{[\s\S]*?\n\}/);
t('取到了真的 artifactRunKind … buildRunDoc（取不到＝被改名，下面全部作废）', !!runSrc);
t('取到了真的 closeArtifactPanel', !!closeSrc);
if (!runSrc || !closeSrc) { console.log(`\n❌ ${pass} passed, ${fail} failed`); process.exit(1); }

// ── 假 DOM：一条消息 777 里 html/css/js 三块，另一条 888 里一块 js ──
const arts = {
  h1: { lang: 'html', code: '<!doctype html><html><head><title>x</title></head><body><div id=b></div></body></html>' },
  // $& 放在 css 里：进 <head> 走的是 replace（js 走 slice 拼接，放 js 里测不到替换模式的坑）
  c1: { lang: 'css',  code: '#b{color:red}#b::after{content:"$& $\'"}' },
  j1: { lang: 'js',   code: "b.textContent='hi';var s='</script>';" },
  p1: { lang: 'python', code: 'print(1)' },
  j2: { lang: 'javascript', code: 'console.log(1)' },
};
const where = { h1: '777', c1: '777', j1: '777', p1: '777', j2: '888' };
const frame = { srcdoc: 'OLD PAGE', style: { display: 'block' } };
const panel = { classList: { remove() { panel.open = false; } }, open: true };
const document = {
  querySelector(sel) {
    const id = sel.match(/data-art="([^"]+)"/)[1];
    return { closest: () => ({ dataset: { msgId: where[id] } }) };
  },
  querySelectorAll(sel) {
    const msg = sel.match(/data-msg-id="([^"]+)"/)[1];
    return Object.keys(arts).filter(k => where[k] === msg).map(k => ({ dataset: { art: k } }));
  },
  getElementById(id) { return id === 'artifactFrame' ? frame : id === 'artifactPanel' ? panel : null; },
};
const box = { window: { __artifacts: arts }, document, console };
vm.createContext(box);
vm.runInContext(runSrc[0] + '\n' + closeSrc[0], box);

console.log('\n[1] 点 css 那块：整条消息拼成一页');
const doc = box.buildRunDoc('c1');
t('用的是这条消息里的 html', doc.includes('<div id=b></div>'));
t('css 进了 <head>', /<head><script>[\s\S]*<\/script><style>#b\{color:red\}[^<]*<\/style><title>/.test(doc), doc.slice(0, 120));
t('js 在 </body> 前面', doc.indexOf("b.textContent") > doc.indexOf('<div id=b>') && doc.indexOf("b.textContent") < doc.lastIndexOf('</body>'));
t('★ 代码里的 $& $\' 原样保留（字符串替换会把它们当替换模式吃掉）', doc.includes('content:"$& $\'"'));
t('★ js 里的 </script> 被转义，不会提前截断脚本', doc.includes("'<\\/script>'") && !doc.includes("var s='</script>'"));
t('python 不参与', !doc.includes('print(1)'));

console.log('\n[2] 另一条消息的纯 js：不串到 777 的 html');
const doc2 = box.buildRunDoc('j2');
t('没有别条消息的 html/css', !doc2.includes('id=b') && !doc2.includes('#b{'));
t('给了空白页 + 整页控制台', doc2.includes('<body style="margin:0;background:#0d0d14">') && doc2.includes('var full=true'));
t('带页面时控制台只冒错误', doc.includes('var full=false'));

console.log('\n[3] 沙箱里 localStorage 会抛 SecurityError，垫片换成内存版');
{
  const shim = doc.match(/<script>(\(function\(\)\{[\s\S]*?\}\)\(\);)<\/script>/)[1];
  const win = {};
  Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  const errs = [];
  const sb = { window: win, console: { log() {}, info() {}, warn() {}, error() {} }, document: {} };
  win.addEventListener = () => {};
  vm.createContext(sb);
  try { vm.runInContext(shim, sb); } catch (e) { errs.push(e.message); }
  t('垫片本身不抛', errs.length === 0, errs);
  let ok = false;
  try { win.localStorage.setItem('k', 1); ok = win.localStorage.getItem('k') === '1' && win.localStorage.length === 1; } catch (e) {}
  t('★ 替换后 setItem/getItem 能用', ok);
}

console.log('\n[4] 关面板要把页面卸掉');
box.closeArtifactPanel();
t('面板收起', panel.open === false);
t('★ srcdoc 清空（不然动画/定时器/声音在后台接着跑）', frame.srcdoc === '', frame.srcdoc);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
