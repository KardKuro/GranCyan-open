'use strict';
// 学习工具箱 ①：聊天里画图 [[PLOT:]] + GeoGebra 面板（js/54-labkit.js）
//
// 这个功能最容易「看着对、其实错」的地方有三处，测试主要守它们：
//   1) 算错：省略乘号、-x^2、负数开立方、log 的底 —— 画出来一条光滑的曲线，
//      只是不是题里那条。肉眼很难发现，学生会照着错图理解题目。
//   2) 安全：表达式是编译成 JS 跑的。模型的回复里可能带着网页上的提示注入，
//      只要能拼出一个白名单外的标识符，就是在这个能调电脑操控的页面里执行代码。
//   3) 断链：标签三件套（渲染 / 回填 / 流式遮罩）+ 挂载时机，漏一个就是裸标签或空盒子，零报错。
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

const src = read('js/54-labkit.js');
const box = {
  console, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, Error, RegExp,
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  SERVER_BASE: 'http://192.168.1.5:3000'
};
vm.createContext(box);
vm.runInContext(src + ';this.plotParse=plotParse;this._plEnv=_plEnv;this.plotAutoBox=plotAutoBox;this._plCompile=_plCompile;'
  + 'this._plFn=_plFn;this._PL_H=_PL_H;this.plotTagToHtml=plotTagToHtml;this.plotTagForApi=plotTagForApi;'
  + 'this.maskStreamingPlot=maskStreamingPlot;this.plotToGgb=plotToGgb;this._ggbSources=_ggbSources;this._PL_CMDS=_PL_CMDS;', box);

// 解析失败返回 NaN 而不是抛出去：抛出去整个测试进程就崩了，一条 ✗ 都打不出来，
// 看着像「没有失败」（故障注入时就这么漏过两条）。
const ev = (s, x) => {
  try {
    const c = box._plCompile(s, { vars: new Set(['x']) });
    return box._plFn(c.code, ['x'])(x, {}, {}, {}, box._PL_H);
  } catch (e) { return NaN; }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('\n[1] 算得对（错了画出来也是一条光滑曲线，看不出来）');
t('★ 省略乘号：2x^2-3x+1 在 x=2 是 3', near(ev('2x^2-3x+1', 2), 3), ev('2x^2-3x+1', 2));
t('★ -x^2 是 -(x²)，不是 (-x)²', near(ev('-x^2', 3), -9), ev('-x^2', 3));
t('★ 3sin(x) / xsin(x)：数字和粘连的名字都能切开', near(ev('3sin(x)', Math.PI / 2), 3) && near(ev('xsin(x)', Math.PI / 2), Math.PI / 2));
t('★ ln / lg / log(底,真数) / log_2 —— 课本的对数写法', near(ev('ln(e)', 0), 1) && near(ev('lg(100)', 0), 2)
  && near(ev('log(2,8)', 0), 3) && near(ev('log_2(8)', 0), 3));
t('★ 单参数 log(x) 是自然对数（GeoGebra 的约定，转过去两边画的是同一条）', near(ev('log(e^2)', 0), 2), ev('log(e^2)', 0));
t('★ 负数开立方：x^(1/3) 在 x=-8 是 -2（不是 NaN，否则左半边整段消失）', near(ev('x^(1/3)', -8), -2), ev('x^(1/3)', -8));
t('  负数开平方还是 NaN（不能为了画出来乱补）', Number.isNaN(ev('x^(1/2)', -4)));
t('★ 分段：If(x<0,-x,x^2) 和连写的 0<x<2', ev('If(x<0,-x,x^2)', -2) === 2 && ev('If(0<x<2,1,0)', 1) === 1 && ev('If(0<x<2,1,0)', 3) === 0);
t('  |x-3|、sqrt 9、30°、e^x、2pi', ev('|x-3|', 1) === 2 && ev('sqrt 9', 0) === 3 && near(ev('30°', 0), Math.PI / 6)
  && near(ev('e^x', 1), Math.E) && near(ev('2pi', 0), 2 * Math.PI));
t('  全角符号、²、× 都认', near(ev('x²＋2×x', 3), 15) && near(ev('（x−1）', 3), 2));
t('  乘方右结合：2^3^2 = 512', ev('2^3^2', 0) === 512);

console.log('\n[2] 安全：编译出来的代码里只可能有白名单里的东西');
const evil = ['alert(1)', 'constructor', 'x.constructor', '__proto__', 'this', 'window', 'globalThis', 'Function("a")',
  'process', 'fetch(1)', 'x[0]', '`a`', 'x;alert(1)', 'eval(1)', 'Math.random()', 'setTimeout(x)', 'import("a")', 'S', 'U', 'H'];
const leaked = [];
for (const e of evil) {
  try { box._plCompile(e, { vars: new Set(['x']) }); leaked.push(e); } catch (_) { /* 拒绝才对 */ }
}
t('★ 白名单外的名字、点号、方括号、反引号、分号一律拒绝', leaked.length === 0, leaked);
{
  const inputs = ['2x^2-3x+1', 'If(0<x<2,sin x,lg(x))', 'log_2(x)+|x|', 'a x^2 + f(x) + x(A)'];
  const allowed = /^(?:Math\.[a-zA-Z0-9]+|H\.[a-z]+|S\["[A-Za-z_][A-Za-z0-9_]*"\]|U\["[A-Za-z_][A-Za-z0-9_]*'{0,2}"\]|P\["[A-Za-z_][A-Za-z0-9_]*"\]\.[XY]|x|y|t|Infinity)$/;
  const bad = [];
  for (const s of inputs) {
    const c = box._plCompile(s, { vars: new Set(['x']), nums: new Set(['a']), funcs: new Set(['f']), points: new Set(['A']) });
    const words = c.code.replace(/"[^"]*"/g, m => m).match(/[A-Za-z_$][\w$.]*(?:\["[^"]*"\](?:\.[XY])?)?/g) || [];
    for (const w of words) if (!allowed.test(w)) bad.push(s + ' → ' + w);
    if (/[;`\[\]{}=]/.test(c.code.replace(/\["[^"]*"\]/g, '').replace(/===|!==|<=|>=/g, ''))) bad.push(s + ' 有可疑符号 ' + c.code);
  }
  t('★ 生成代码里的每个标识符都在白名单里（Math.* / H.* / S[] U[] P[] / x y t）', bad.length === 0, bad);
}
{
  const p = box.plotParse('Text("<img src=x onerror=alert(1)>", (1,1))\nf(x)=x');
  t('  Text 的字只当数据存着（画的时候用 SVG 文字，不走 innerHTML）', p.items.some(i => i.k === 'text' && i.str.includes('<img')) && /display: 'internal'/.test(src));
}
t('  点名/函数名不合规就拒绝（不让奇怪的名字进 S[]/U[] 的键）', box.plotParse('f-1(x)=x').errors.length === 1);

console.log('\n[3] 解析成作图计划');
const P1 = box.plotParse('# 二次函数\na=Slider(-3,3,0.1,1)\nf(x)=a x^2-2x\nA=(1,f(1))\nB=(3,0)\nSegment(A,B)\nM=Midpoint(A,B)\nc: x^2/4+y^2=1\nx=2\ny=2x+1\nCircle(B,1.5)\nPolygon((0,0),(2,0),(1,2))\nTangent(1,f)\nIntegral(f,0,2)\nText("顶点",A)\nSetColor(f,"red")\nIntersect(f,c)\ny>x\nfoo bar');
const kinds = P1.items.map(i => i.k);
t('★ 标题取自 # 行', P1.title === '二次函数', P1.title);
t('★ 各种指令都认成对应的东西',
  ['num', 'fn', 'point', 'seg', 'mid', 'implicit', 'vline', 'circle', 'poly', 'tangent', 'integral', 'text'].every(k => kinds.includes(k)), kinds);
t('★ y=2x+1 是函数，c: x²/4+y²=1 是隐函数，x=2 是竖线',
  P1.items.find(i => i.k === 'fn' && !i.name) && P1.items.find(i => i.k === 'implicit' && i.name === 'c') && P1.items.find(i => i.k === 'vline'));
t('★ 不支持的三行各自报错、不连累别的行', P1.errors.length === 3 && /Intersect/.test(P1.errors[0].why) && /不等式/.test(P1.errors[1].why), P1.errors);
t('  依赖滑块的点不能拖（A=(1,f(1))），纯数字的点能拖', P1.items.find(i => i.name === 'A').free === false && P1.items.find(i => i.name === 'B').free === true);
t('  SetColor 落到那个对象上', P1.items.find(i => i.name === 'f').color === '#ff6b6b');
t('  Slider 没名字要报错', box.plotParse('Slider(0,1)').errors.length === 1);
t('  ZoomIn 直接定视野', JSON.stringify(box.plotParse('ZoomIn(-1,-2,3,4)\ny=x').bbox) === '[-1,-2,3,4]');
{
  const p = box.plotParse('a=Slider(0,4,0.5,2)\nf(x)=a x^2\ng(x)=f\'(x)\nh(x)=f(x)+1');
  const env = box._plEnv(p);
  t('★ 滑块初值进环境：f(3) = 2·9', near(env.U.f(3), 18), env.U.f(3));
  t('★ 导数 f\'(x) = 2ax：f\'(3) ≈ 12', Math.abs(env.U["f'"](3) - 12) < 1e-4, env.U["f'"](3));
  t('  函数能引用前面定义的函数', near(p.items.find(i => i.name === 'h').f(3, env.S, env.U, env.P, box._PL_H), 19));
  const env2 = box._plEnv(p, () => 1);
  t('  挂载后滑块值从外面读（拉滑块曲线才会动）', near(env2.U.f(3), 9));
}
{
  const p = box.plotParse('A=(1,2)\nB=(5,4)\nM=Midpoint(A,B)\nP=(x(M), 0)');
  const env = box._plEnv(p);
  t('  中点和 x(M) 取坐标', near(env.P.M.X(), 3) && near(env.P.M.Y(), 3) && near(env.P.P.X(), 3));
}

console.log('\n[4] 视野');
{
  const b = box.plotAutoBox(box.plotParse('y=tan(x)'));
  t('★ tan 这种一采样就上万的，视野不被撑爆（y 范围 < 60）', b[3] - b[1] < 60 && b[3] > b[1], b);
  const b2 = box.plotAutoBox(box.plotParse('A=(10,10)\nB=(14,12)'));
  t('  点都在框里', b2[0] < 10 && b2[2] > 14 && b2[1] < 10 && b2[3] > 12, b2);
  const b3 = box.plotAutoBox(box.plotParse('Circle((0,0),3)'));
  t('  圆整个在框里', b3[0] <= -3 && b3[2] >= 3 && b3[1] <= -3 && b3[3] >= 3, b3);
  t('  几何图保持横纵比例（圆不画成椭圆）', box.plotParse('Circle((0,0),3)').aspect === true && box.plotParse('y=x^2').aspect === false);
}

console.log('\n[5] 标签三件套');
{
  const h = box.plotTagToHtml('看这个：\n[[PLOT:\n# 标题 "引号"\ny=x^2\n\nA=(1,1)\n]]\n完');
  t('★ 渲染成占位盒子，源码在 data-src 里', /class="plot-box" data-src="/.test(h));
  t('★ 换行转成 &#10;（源码里有空行时 marked 不会把盒子截断）', !/data-src="[^"]*\n/.test(h) && /&#10;&#10;/.test(h));
  t('  引号被转义，标题取 # 行', /&quot;引号&quot;/.test(h) && /📈 标题/.test(h));
  t('  前后留空行（占位是 div，否则 marked 把后面的正文吞进 HTML 块）', /\n\n<div class="plot-box"/.test(h) && /<\/div>\n\n/.test(h));
  const u = box.plotTagToHtml('[[PLOT: f(x)=If(x&lt;0,-x,x)]]');
  t('★ 用户消息那条路（先被 escHtml 过）也能还原成 <', /If\(x&lt;0/.test(u) && !/&amp;lt;/.test(u), u.slice(0, 120));
}
{
  const ok = '[[PLOT: y=x^2]]';
  t('★ 回填：画得出来的原样留着（历史就是教材）', box.plotTagForApi('a ' + ok + ' b') === 'a ' + ok + ' b');
  const bad = box.plotTagForApi('[[PLOT: y=x^2\nIntersect(f,g)]]');
  t('★ 回填：没画出来的行要告诉模型（不然它永远不知道自己写错了）', /\[这张图有 1 行没画出来：「Intersect\(f,g\)」/.test(bad), bad);
}
t('★ 流式：写完的标签遮成 〔📈〕', box.maskStreamingPlot('a [[PLOT: y=x]] b') === 'a 〔📈〕 b');
t('★ 流式：写到一半的也遮住（不露半截指令）', box.maskStreamingPlot('看 [[PLOT:\ny=x^2') === '看 〔📈 画图中…〕'
  && box.maskStreamingPlot('看 [[PL') === '看 〔📈 画图中…〕');
t('  没有标签的原样返回', box.maskStreamingPlot('[[STICKER:猫]]') === '[[STICKER:猫]]');

console.log('\n[6] 转到 GeoGebra');
t('★ log_2(x) 翻成 GeoGebra 的 log(2, x)；# 行丢掉；; 分行', JSON.stringify(box.plotToGgb('# t\nf(x)=log_2(x)+1\nA=(1,2); B=(3,4)'))
  === JSON.stringify(['f(x)=log(2, x)+1', 'A=(1,2)', 'B=(3,4)']));
{
  const s = box._ggbSources();
  t('★ 先找电脑上的离线包，官网垫底（国内直连官网常超时）', /\/labkit\/geogebra\/deployggb\.js$/.test(s[0].js) && /web3d\/$/.test(s[0].codebase)
    && /geogebra\.org/.test(s[s.length - 1].js), s);
}
t('  没写 ZoomIn 的图，转过去时带上气泡里的视野', /cmds\.push\('ZoomIn\(' \+ plotAutoBox\(plan\)/.test(src));

console.log('\n[7] 接线（漏一处就是裸标签 / 空盒子，零报错）');
const media = read('js/12-math-media.js');
const prompts = read('js/05-prompts-api.js');
const input = read('js/09-appearance-input.js');
const html = read('index.html');
const css = read('css/grancyan.css');
t('★ 渲染层 stickerTagToHtml 调 plotTagToHtml（content 和 blocks 两条路都经过它）',
  /function stickerTagToHtml[\s\S]*?plotTagToHtml\(text\)[\s\S]*?return text;\s*\n\}/.test(media));
t('★ 回填链里有 plotTagForApi', /cooked = typeof plotTagForApi === 'function' \? plotTagForApi\(cooked\) : cooked;/.test(prompts));
t('★ 流式遮罩登记进 _STREAM_MASKS', /const _STREAM_MASKS = \[[^\]]*'maskStreamingPlot'/.test(prompts));
{
  const fn = input.slice(input.indexOf('function typesetMath(el)'), input.indexOf('function hexAlpha'));
  const iMount = fn.indexOf('plotMountIn(el)'), iEarly = fn.indexOf("typeof renderMathInElement !== 'function') return;");
  t('★ typesetMath 里挂图，而且在 KaTeX 没加载就早退的那行之前', iMount > 0 && iEarly > iMount, { iMount, iEarly });
}
t('★ 页面加载 54-labkit.js', /<script src="\.\/js\/54-labkit\.js"><\/script>/.test(html));
t('★ 画图板面板和「学习」架子上的入口', /id="ggbModal"/.test(html) && /id="ggbHost"/.test(html) && /onclick="openWidget\(openGeoGebra\)"/.test(html)
  && /<span>学习<\/span>[\s\S]*?openWidget\(openStudy\)[\s\S]*?openWidget\(openGeoGebra\)/.test(html));
t('  CSS 有 plot-box / 手势开关 / GeoGebra 反色', /\.plot-box\{/.test(css) && /\.plot-box\.plot-grab \.plot-jxg\{touch-action:none/.test(css)
  && /\.ggb-panel \.ggb-host\{filter:invert/.test(css));
t('★ 按钮函数名不撞渲染消毒的黑名单（reset*/delete* 会被拔掉 onclick）',
  !/^(reset|delete|remove|clear|set)/.test('plotReset') && /onclick="plotReset\(this\)"/.test(src) && /onclick="plotOpenGgb\(this\)"/.test(src));

console.log('\n[8] 提示词和能认的指令对得上');
const skillLine = (prompts.match(/if \(skillOn\('plot'\)\) base \+= `([\s\S]*?)`;/) || [])[1] || '';
t('★ 画图技能在开关表里、提示词在 buildSystemPrompt 里', /\{ key: 'plot',\s+tok: \d+,/.test(prompts) && skillLine.length > 200);
{
  const taught = ['Slider', 'Segment', 'Line', 'Ray', 'Vector', 'Circle', 'Polygon', 'Midpoint', 'Angle', 'Curve', 'Integral', 'Tangent', 'Text', 'ZoomIn', 'SetColor'];
  const missing = taught.filter(c => !skillLine.includes(c + '('));
  t('  教给模型的指令都写进了提示词', missing.length === 0, missing);
  const unknown = taught.filter(c => !box._PL_CMDS.includes(c.toLowerCase()));
  t('★ 提示词里教的每条指令解析器都认（教了却画不出来，它会以为是自己写错了）', unknown.length === 0, unknown);
  // 把提示词里的示例一条条喂给解析器
  const examples = ['f(x)=x^2-2x+1', 'y=2x+1', 'x=3', 'c: x^2/4+y^2=1', 'A=(1,2)', 'a=Slider(-5,5,0.1,1)', 'B=(3,0)', 'C=(0,3)',
    'Segment(A,B)', 'Line(A,B)', 'Ray(A,B)', 'Vector(A,B)', 'Circle(A,2)', 'Circle(A,B)', 'Circle(A,B,C)', 'Polygon(A,B,C)', 'M=Midpoint(A,B)',
    'Angle(A,B,C)', 'Curve(cos(t),sin(t),t,0,2pi)', 'Integral(f,0,2)', 'Tangent(1,f)', 'Text("顶点",A)', 'ZoomIn(-5,-5,5,5)', 'SetColor(f,"red")',
    'g(x)=If(x<0,-x,x^2)', 'h(x)=ln(x)+lg(x)+log(2,x)+sqrt(x)+|x|', "k(x)=f'(x)", 'P=(x(A),0)'];
  const p = box.plotParse(examples.join('\n'));
  t('★ 提示词里的写法全都能解析（一行错都没有）', p.errors.length === 0, p.errors);
  t('  提示词里交代了不支持交点和不等式', /不支持交点和不等式/.test(skillLine));
}

console.log('\n[9] 打包：大件不进 git / exe / APK，小库跟着 APK 走');
const pkg = read('package.json');
t('★ exe 两条打包命令都忽略 labkit/（GeoGebra 50MB，进 asar 白胖）', (pkg.match(/--ignore=\\"\^\/labkit\(\$\|\/\)\\"/g) || []).length === 2);
t('★ .gitignore 有 labkit/', /^labkit\/$/m.test(read('.gitignore')));
t('★ JSXGraph 放在 js/lib（APK 离线也能画）', fs.existsSync(path.join(ROOT, 'js/lib/jsxgraphcore.js')) && fs.existsSync(path.join(ROOT, 'js/lib/jsxgraph.css'))
  && /s\.src = '\.\/js\/lib\/jsxgraphcore\.js'/.test(src));
t('  服务端静态闸没挡 /labkit（只挡 /api 以外的私密目录）', !/labkit/.test((read('server.js').match(/const STATIC_DENY_DIR = [^\n]*/) || [''])[0]));
{
  const a = path.join(ROOT, 'android/assets/js/54-labkit.js');
  t('★★ android 副本与 js/54-labkit.js 字节一致', fs.existsSync(a) && fs.readFileSync(a, 'utf8') === src);
}

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
