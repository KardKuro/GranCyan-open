// 短消息气泡被自己的百分比 max-width 挤扁（用户：一个字「好」歪到气泡右边）。
//
// 病根：用户气泡外面裹着两三层「随内容缩放」的 flex 包裹层（06-render-msg.js），
// max-width 写成百分比的话，是按最近那层包裹层算的 —— 而那层的宽度又是气泡撑出来的，
// 于是气泡被卡成「自己宽度的 70%」。用真实数据量过：「好」气泡 39px、文字区 2px；
// 改成按 .msg-group 算（容器单位 cqi）之后是 56px，字在正中。
//
// 这份是静态断言：布局本身在 headless Chrome 里验过，但那要真数据和跑着的 server，
// 放不进测试套件。这里守的是「那三条规则不许回退成百分比」+「容器还在」。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css/grancyan.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// 找「选择器完全等于 sel」的规则里的 max-width 值（可能有多条，全收）
function maxWidthsOf(sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].trim().replace(/\s+/g, ' ') !== sel) continue;
    const mw = m[2].match(/max-width\s*:\s*([^;]+)/);
    if (mw) out.push(mw[1].trim());
  }
  return out;
}

t('.msg-group 是 inline-size 容器（cqi 才有东西可以量）',
  /\.msg-group\s*\{[^}]*container-type\s*:\s*inline-size/.test(css));

for (const sel of [
  '.msg-group .bubble',
  '#chatWindow.gc-mode-group .bubble',
  '#chatWindow.gc-mode-solo .msg-group.user .bubble.user',
]) {
  const v = maxWidthsOf(sel);
  t(`「${sel}」有 max-width`, v.length > 0, v);
  t(`「${sel}」的 max-width 用 cqi、不用 %`, v.length > 0 && v.every(x => /cqi/.test(x) && !/%/.test(x)), v);
}

console.log(fail ? `\n❌ ${pass} passed, ${fail} failed` : `\n✅ ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
