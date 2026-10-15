// 中文语境下的 **加粗**。
//
// 病根是 CommonMark 的 right-flanking 规则：结束的 `**` 前面是标点、后面是文字时，
// 不算闭合。英文写 `**Note:** text` 没事（`**` 后面是空格）；中文写 `**标题：**正文`
// 就炸 —— 而这恰恰是模型最爱用的格式，于是气泡里天天飘星号。
// 用户报的就是这个。
//
// 这份测试**跑真的 marked + 真的补丁源码**（从 13-trash-ctx-ui.js 里抠出来），
// 不在这儿手抄一份正则 —— 手抄的话，源码改坏了这边照样绿（见记忆：扫描必须有对照组）。
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

// ── 取真的补丁函数 ──
const fnSrc = uiSrc.match(/let _cjkStrongInited = false;[\s\S]*?\n\}/);
t('取到了真的 initMarkedCjkStrong（取不到说明被改名/改形，下面的断言全部作废）', !!fnSrc);

const marked = require(path.join(ROOT, 'js', 'lib', 'marked.min.js'));
const parse = s => (marked.parse || marked.marked.parse)(s);

console.log('\n[1] 打补丁之前：确认这个坑真的存在（没有它这份测试就是空的）');
t('★ 补丁前 **内容：**说明 确实漏星号', parse('**内容：**说明').includes('**'));
t('   补丁前英文 **Note:** text 是好的（所以只在中文里踩雷）', !parse('**Note:** text').includes('**'));

// 在沙箱里执行真的补丁源码
if (fnSrc) {
  const box = { marked, console };
  vm.createContext(box);
  vm.runInContext(fnSrc[0] + '\ninitMarkedCjkStrong();', box);
}

console.log('\n[2] 打补丁之后');
// 中文标点结尾 —— 全是模型真会写的格式
const SHOULD_BOLD = [
  '**内容**',
  '这是**内容**好',
  '**内容：**说明',        // 最常见的那个
  '**内容。**后面',
  '**内容，**后面',
  '**内容；**后面',
  '**内容！**后面',
  '**内容？**后面',
  '**内容」**后面',
  '**（内容）**后面',
  '（**内容**）',
  '「**内容**」',
  '**内容**，然后',
  '- **内容**：说明',
  '1. **内容**：说明',
  '**内容**和**第二个**',
];
for (const s of SHOULD_BOLD) {
  const out = parse(s);
  t('加粗生效 ' + JSON.stringify(s), out.includes('<strong>') && !out.includes('**'), out.trim().slice(0, 90));
}

console.log('\n[3] 不该被这条补丁改掉的（放宽过头就会咬到这些）');
const KEEP = [
  ['内侧有空格不渲染（CommonMark 原状）', '**内容 **后面', s => s.includes('**')],
  ['内侧有空格不渲染（前）', '** 内容**后面', s => s.includes('**')],
  ['行内代码里原样保留', '`**内容**`', s => s.includes('<code>**内容**</code>')],
  ['代码块里原样保留', '```\n**内容**\n```', s => s.includes('**内容**')],
  // 注意：`x __init__ y`（前后有空格）本来就该加粗，CommonMark 如此，补丁前后一致。
  // 真正要守的是**词内**下划线 —— snake_case 不能被啃成加粗。
  ['词内下划线不受影响（snake_case 不该变加粗）', 'a__init__b', s => !s.includes('<strong>')],
  ['三星号仍是粗斜体', '***内容***', s => s.includes('<strong>') && s.includes('<em>')],
  ['单星号仍是斜体', '*内容*', s => s.includes('<em>') && !s.includes('<strong>')],
  ['未闭合不渲染', '**内容', s => s.includes('**')],
];
for (const [name, input, ok] of KEEP) {
  const out = parse(input);
  t(name, ok(out), out.trim().slice(0, 100));
}

console.log('\n[4] 接线：补丁必须在启动流程之外也生效');
t('★ 脚本加载时就自调一次（不然页面早期渲染的消息还是漏星号）',
  /\n\s*initMarkedCjkStrong\(\);\s*\n/.test(uiSrc));
// ⚠️ 锚点必须挑**不会被注释命中**的：上面那段说明文字里就引用了这句守卫，
// 用裸字符串 indexOf 会命中注释、位置比真代码还靠前，断言永远假红（踩过）。
// 这里认「行首缩进 + 分号」的真代码行。
t('★ 排在 hljs 守卫之前（塞进 initMarked 的 try 里会被守卫一起跳过）',
  uiSrc.indexOf('function initMarkedCjkStrong') < uiSrc.search(new RegExp('\\n\\s+if \\(!window\\.hljs\\) return;')));
t('有防重复标志（marked.use 会累加，注册两遍没必要）', /_cjkStrongInited/.test(uiSrc));

console.log('\n[5] 前端依赖不许再回到 CDN');
// marked 拉不到 = 所有 markdown 全废且零报错，比这个加粗 bug 严重得多。
// 打包成 exe/APK 之后更要命：那时候可能压根没有代理。
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cdn = (html.match(/<(?:script|link)[^>]+(?:src|href)="https?:\/\/[^"]+"/g) || [])
  .filter(s => !/fonts\.googleapis|fonts\.gstatic/.test(s));   // 字体缺失只影响观感，另算
t('★ index.html 里没有 CDN 引入的运行时库', cdn.length === 0, cdn);
for (const f of ['js/lib/marked.min.js', 'js/lib/highlight.min.js', 'js/lib/katex.min.js',
                 'js/lib/katex-auto-render.min.js', 'js/lib/jszip.min.js', 'js/lib/supabase.min.js',
                 'css/lib/katex.min.css', 'css/lib/atom-one-dark.min.css']) {
  const p = path.join(ROOT, f);
  t('本地文件在且非空 ' + f, fs.existsSync(p) && fs.statSync(p).size > 800);
}
// KaTeX 的字体：CSS 里引用几个，本地就得有几个，少一个就是公式显示成方块
const kcss = fs.readFileSync(path.join(ROOT, 'css', 'lib', 'katex.min.css'), 'utf8');
const want = [...new Set((kcss.match(/fonts\/[A-Za-z0-9_.-]+\.woff2/g) || []))];
const missing = want.filter(w => !fs.existsSync(path.join(ROOT, 'css', 'lib', w)));
t('★ KaTeX 引用的 woff2 字体全部在本地（缺一个公式就是方块）', want.length > 0 && missing.length === 0, missing);
t('KaTeX CSS 里没有本地不存在的 woff/ttf 引用', !/fonts\/[A-Za-z0-9_.-]+\.(?:woff|ttf)\b/.test(kcss));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
