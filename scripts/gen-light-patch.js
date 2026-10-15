// 生成 css/light-patch.css：浅色配色（米纸）的自动翻色补丁。
//
// 为什么要生成：grancyan.css 六千多行，写死的深色底（rgba(13,13,22,.9) 这种）有一百多处、
// 白色半透明的边和浅色字又是几百处。浅底上它们会变成一块块黑补丁 / 直接看不见。
// 手改不现实，也没法逼以后写 css 的人都记得用变量，所以按颜色分档机械翻一遍：
//   · 深色底     → 米纸的三层底色（按原来的明暗挑 底/面/块），透明度照抄
//   · 纯黑大半透明底（弹窗遮罩） → 暖灰遮罩
//   · 白色半透明底/边（深色上提亮用的） → 墨色半透明
//   · 浅色字（不含纯白：纯白几乎都写在强调色按钮上，翻了反而看不见） → 墨色
//   · 纯黑阴影 → 透明度减半
// 输出的每条规则都挂在 html.theme-light 下，只有米纸生效。
//
// grancyan.css 改了之后重跑一次：node scripts/gen-light-patch.js
// 手写的浅色修补在 css/block-theme.css 的 html.theme-light 段，排在这个文件后面，同特异性时它赢。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const SRC = path.join(root, 'css', 'grancyan.css');
const OUT = path.join(root, 'css', 'light-patch.css');

const PROPS = /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|color|fill|stroke|caret-color)$/;
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;

function parseColor(s) {
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
             a: h.length === 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(2) : 1 };
  }
  const m = s.match(/[\d.]+/g).map(Number);
  return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 };
}
const r2 = n => +n.toFixed(3);

function mapColor(str, kind) {
  const c = parseColor(str);
  if (!c) return str;
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const black = max === 0, white = min >= 200;
  if (kind === 'bg') {
    if (black) return c.a >= 0.45 ? `rgba(60,52,40,${r2(c.a * 0.5)})` : str;
    if (max <= 60) {
      const tier = max <= 14 ? 'var(--bg-rgb)' : max <= 24 ? 'var(--lt-surface-rgb)' : 'var(--lt-elev-rgb)';
      return `rgba(${tier},${r2(c.a)})`;
    }
    if (white && c.a < 1) return `rgba(17,17,17,${r2(Math.min(c.a * 0.9, 0.5))})`;
    return str;
  }
  if (kind === 'border') {
    if (white && c.a < 1) return `rgba(17,17,17,${r2(Math.min(Math.max(c.a * 1.4, 0.08), 0.5))})`;
    if (!black && max <= 60) return 'rgba(17,17,17,.14)';
    return str;
  }
  if (kind === 'text') {
    if (min >= 170 && !(min === 255 && c.a === 1)) return `rgba(17,17,17,${r2(Math.max(c.a, 0.55))})`;
    return str;
  }
  if (kind === 'shadow') {
    if (black) return `rgba(0,0,0,${r2(c.a * 0.5)})`;
    if (!black && max <= 30) return `rgba(40,30,10,${r2(c.a * 0.35)})`;
    return str;
  }
  return str;
}
function kindOf(prop) {
  if (prop.startsWith('background')) return 'bg';
  if (prop === 'box-shadow') return 'shadow';
  if (prop === 'color' || prop === 'fill' || prop === 'stroke' || prop === 'caret-color') return prop === 'color' || prop === 'caret-color' ? 'text' : 'bg';
  return 'border';
}

// 极简 css 解析：去注释 → 按大括号切。@media/@supports 递归，@keyframes/@font-face 跳过。
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
function parseBlocks(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const head = s.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
    const body = s.slice(open + 1, j - 1);
    out.push({ head, body });
    i = j;
  }
  return out;
}
// 不翻的：外观面板里其它配色的小样（翻了就不是那个配色的样子了）、遮罩层（js 每次写内联色）、
// 终端和代码块（墨色块本来就是这套风格里的一员，留黑的）、自带夜空场景的天气页
// （底是画出来的夜空、不吃变量，翻了字就是墨色压夜空，看不见）、
// 生命体征那块监护屏（仪器屏幕就该是暗的，和终端一个道理；米纸下的变量在 block-theme.css 里给它换回深色）、
// 点菜单（夜里小馆子的纸菜单，自带一套低饱和深色，不适合翻成浅色）、藏宝地图（同理，夜里的旧地图）、小本子（夜里的旧皮面本子）、
// 空页面的差值大字（描边颜色差值完自己会在浅底上变深，再翻一遍就反过头了）、
// 手环面板（固定死黑底 + 白字白图，哪个主题都一样）。
const SKIP = /swatch|shape-|#bg-mask|#emptyEchoLayer|\.band-|\.term-|#terminalModal|hljs|(^|[\s>+~])pre\b|weather-|\.wx-|\.vitals-(card|hud|pulse|core|heart|readout|bpm|ecg|mood-line|next|spark|groups?|meter|bar|did|caret|pet)\b|\.vc-|\.treasure-|\.wish(book)?-|\.diary-(?!switch)|#diary/;
function prefixSelector(sel) {
  return sel.split(',').map(p => {
    p = p.trim();
    if (!p) return null;
    if (/^:root\b/.test(p) || SKIP.test(p)) return null;
    if (/^html\b/.test(p)) return p.replace(/^html/, 'html.theme-light');
    return 'html.theme-light ' + p;
  }).filter(Boolean).join(',\n');
}
function convertRule(head, body) {
  const decls = [];
  for (const raw of body.split(';')) {
    const k = raw.indexOf(':');
    if (k < 0) continue;
    const prop = raw.slice(0, k).trim().toLowerCase();
    if (!PROPS.test(prop)) continue;
    const val = raw.slice(k + 1).trim();
    const kind = kindOf(prop);
    const nv = val.replace(COLOR_RE, m => mapColor(m, kind));
    if (nv !== val) decls.push(`${prop}:${nv}`);
  }
  if (!decls.length) return '';
  const sel = prefixSelector(head);
  return sel ? `${sel} { ${decls.join(';')}; }\n` : '';
}
function walk(s, indent) {
  let out = '';
  for (const { head, body } of parseBlocks(s)) {
    if (/^@(keyframes|-webkit-keyframes|font-face|import|charset)/.test(head)) continue;
    if (/^@(media|supports|container)/.test(head)) {
      const inner = walk(body, indent + '  ');
      if (inner) out += `${head} {\n${inner}}\n`;
      continue;
    }
    if (head.startsWith('@')) continue;
    out += convertRule(head, body);
  }
  return out;
}

const css = stripComments(fs.readFileSync(SRC, 'utf8'));
const body = walk(css, '');
const header = `/* 自动生成，别手改 —— 改了重跑 node scripts/gen-light-patch.js（说明在那个脚本顶上）。
   来源：css/grancyan.css。只在 html.theme-light（米纸配色）下生效。 */
html.theme-light { --lt-surface-rgb:227,221,210; --lt-elev-rgb:217,210,197; }
`;
fs.writeFileSync(OUT, header + body);
console.log(`light-patch.css: ${body.split('\n').filter(l => l.includes('{') && !l.startsWith('@')).length} 条规则 → ${path.relative(root, OUT)}`);
