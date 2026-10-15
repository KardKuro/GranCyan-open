// 设置 / 记忆 / 收藏面板的打磨（ui-polish/settings，2026-10-14）
// 守的是几处「看着像样式、其实是功能」的坑：
//   1. 记忆面板的添加框：js 用内联 display:none 在「模型设定 / 普鲁斯特 / CC 互通」页藏它，
//      CSS 里 display 带 !important 就藏不住（往里写的其实进了公开记忆）
//   2. 记忆面板是 flex 竖排、限高 80vh：标签栏 overflow-x:auto → min-height 变 0，内容一多就被压扁到字被切
//   3. 外观页「背景模糊 / 界面磨砂」两根滑杆以前漏在「背景图片」区块外面，间距一会儿 100px 一会儿 20px
//   4. 记忆「启用」药丸、收藏卡按钮不再内联写死靛蓝 / 竖排
const fs = require('fs');
let pass = 0, fail = 0;
function ok(n, v) { if (v) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } }

const css = fs.readFileSync('css/grancyan.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const mem = fs.readFileSync('js/04-memory.js', 'utf8');
const rm = fs.readFileSync('js/06-render-msg.js', 'utf8');
const models = fs.readFileSync('js/03-chats-models.js', 'utf8');

// 取所有「选择器列表里有这一项」的规则的声明块（`.a, .b { … }` 这种合写的也算）
const rulesOf = sel => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(m => m[1].split(',').some(s => s.trim() === sel)).map(m => m[2]);

console.log('\n[1] 记忆添加框藏得住');
const addRow = rulesOf('.memory-add-row');
ok('有 .memory-add-row 的基础规则', addRow.length > 0);
ok('它的 display 不带 !important（否则 js 的内联 display:none 失效）',
  addRow.every(b => !/display\s*:[^;]*!important/.test(b)));
ok('js 仍然靠内联 display 切换添加框（前提没变）', /addRow\.style\.display = 'none'/.test(mem));

console.log('\n[2] 记忆面板的标签栏不被压扁');
ok('除了列表，面板里别的块都不收缩', /\.memory-panel\s*>\s*:not\(\.memory-body\)\s*\{[^}]*flex-shrink\s*:\s*0/.test(css));

console.log('\n[3] 外观页滑杆都在「背景图片」区块里');
(() => {
  const at = html.indexOf('>背景图片</div>');
  const start = html.lastIndexOf('<div class="settings-section">', at);
  let depth = 0, i = start, end = -1;
  const re = /<div\b|<\/div>/g; re.lastIndex = start;
  for (let m; (m = re.exec(html));) { depth += m[0] === '</div>' ? -1 : 1; if (depth === 0) { end = m.index; break; } }
  const sec = end > 0 ? html.slice(start, end) : '';
  ok('找得到「背景图片」区块', at > 0 && start > 0 && end > start);
  ok('遮罩浓度 / 背景模糊 / 界面磨砂 三根滑杆都在区块里',
    ['brightnessRange', 'bgBlurRange', 'uiBlurRange'].every(id => sec.includes(`id="${id}"`)));
})();

console.log('\n[4] 药丸和收藏按钮走 class，不写死靛蓝');
ok('04-memory.js 里一处旧靛蓝都没有', !/rgba\(99,\s*102,\s*241/.test(mem));
ok('「启用」药丸用 .mem-toggle（开着挂 .on）', /class="mem-toggle\$\{isEnabled \? ' on' : ''\}"/.test(mem) && /\.mem-toggle\.on\s*\{/.test(css));
const favBody = (rm.match(/function renderFavList\(\)[\s\S]*?\n\}/) || [''])[0];
ok('收藏卡四个按钮横排在 .fav-acts 里', /class="fav-acts"/.test(favBody) && (favBody.match(/class="fav-act[" ]/g) || []).length === 4);
ok('收藏卡不再用竖排按钮列', !/flex-direction:column/.test(favBody));
ok('模型卡标签里不再夹 emoji', !/field-label">[💭🎯📓]/u.test(models));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
