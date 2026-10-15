// 功能指南（wiki 版）+ 页内查找（Ctrl+F）的回归测试。
// 跑法：node tests/help-wiki-find.test.js
//
// 守两件事：
//   1. 指南别退化回「一长条滚到底」—— 目录、搜索、分节结构和条目覆盖度都得在；
//      而且**目录是按 <h3> 现扫的**，加一节功能不用改 JS，这条契约不能被写死回去。
//   2. Ctrl+F 在 exe 里也要能用。桌面窗口没有浏览器那条查找栏，全靠 27-find.js 自己实现，
//      一旦它挂了/被别的 keydown 监听吃掉，表现是「按了没反应」，没有任何报错。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

const html = read('index.html');
const css = read('css/grancyan.css');
const ui = read('js/13-trash-ctx-ui.js');
const find = read('js/27-find.js');

// 只取 helpModal 那一段，别让页面别处的字混进统计
// ⚠️ 2026-10-10 查出来：原来的结束标记「Changelog Mind Map Modal」早就随更新日志一起删了，
//    indexOf 返回 -1，slice 一路切到文件末尾——mustHave 里的词只要在页面任何地方出现就算过，
//    这一节断言整个是死的。现在用紧跟着的 creditsModal 截断，并断言两头都找得到。
const helpStart = html.indexOf('<div id="helpModal"');
const helpEnd = html.indexOf('<div id="creditsModal"', helpStart);
const helpBlock = html.slice(helpStart, helpEnd);

console.log('\n[1] 指南的 wiki 骨架');
t('指南段两头都切得到（结束标记失效时整份 index.html 会被当成指南）',
  helpStart >= 0 && helpEnd > helpStart && !helpBlock.includes('id="creditsModal"') && !helpBlock.includes('<script'));
t('顶栏 + 目录 + 正文三块都在',
  /class="help-topbar"/.test(helpBlock)
  && /id="helpToc"/.test(helpBlock)
  && /id="helpSection"/.test(helpBlock));
t('有搜索框且接到 filterHelp', /id="helpSearch"[^>]*oninput="filterHelp\(this\.value\)"/.test(helpBlock));
t('清空按钮把输入框一起清掉', /filterHelp\('',\s*true\)/.test(helpBlock));
t('底部那个「在整个页面里找」是按钮，不是一句提示文字（手机没有 Ctrl 键）',
  /class="help-foot-find"[^>]*onclick="toggleHelp\(\);openFindBar\(\)"/.test(helpBlock));

console.log('\n[2] 目录是现扫的，不是写死的');
t('HTML 里的 helpToc 是空壳', /<nav class="help-toc" id="helpToc">\s*<!--/.test(helpBlock));
t('buildHelpToc 按 h3 生成', /querySelectorAll\('h3'\)/.test(ui) && /className = 'help-toc-item'/.test(ui));
t('打开指南时才建目录（别在启动时白跑）', /if \(!m\.classList\.contains\('hidden'\)\) buildHelpToc\(\)/.test(ui));
t('只建一次', /_helpTocBuilt/.test(ui));
t('滚动高亮当前章节，且用 rAF 压过频率',
  /addEventListener\('scroll'/.test(ui) && /requestAnimationFrame/.test(ui));
// 最后一节内容短的话滚到底也顶不到顶部 → 目录末项永远高亮不上，点了像没反应
t('末尾垫了一块空白，最后一节能滚到顶',
  /className = 'help-tail'/.test(ui) && /\.help-tail \{ height:55vh/.test(css));

console.log('\n[3] 指南内搜索');
t('过滤按条目走，不是整段藏', /querySelectorAll\('\.help-row'\)/.test(ui));
t('一节全没命中就把标题也收起来', /h\.style\.display = any \? '' : 'none'/.test(ui));
t('目录里对应那项调暗', /item\.classList\.toggle\('dim', !any\)/.test(ui));
t('命中的词高亮', /className = 'help-hit'/.test(ui) && /\.help-hit \{/.test(css));
// 反复搜索会把同一个文本节点切了又切，不 normalize 的话越切越碎、最后匹配不上跨节点的词
t('清空时把高亮标签拆回去并 normalize', /replaceWith\(document\.createTextNode\(s\.textContent\)\)/.test(ui) && /root\.normalize\(\)/.test(ui));
t('先收集文本节点再改（边走边改 TreeWalker 会迷路）',
  /while \(\(n = w\.nextNode\(\)\)\) nodes\.push\(n\)/.test(ui));
t('正则特殊字符被转义（搜「[[」不该炸）', /function escRe\(s\)/.test(ui));
t('搜不到时给提示', /className = 'help-empty'/.test(ui) && /\.help-empty \{/.test(css));

console.log('\n[4] 指南内容覆盖度');
const heads = helpBlock.match(/<h3>/g) || [];
const rows = helpBlock.match(/class="help-row"/g) || [];
t(`章节数够（${heads.length} 节）`, heads.length >= 16, heads.length);
t(`条目数够（${rows.length} 条）`, rows.length >= 140, rows.length);
// 这些是清单里做完了、但旧指南一个字都没写的功能。漏了等于用户自己都不知道有
const mustHave = ['网页坞', '偷看屏幕', 'Cookie', '拍照', '数学公式', '展开栏',
  'END_CHAT', '表格', '额度', '提示词缓存', '模型分组', '用户名', '页内查找', '看 GitHub',
  '托付钥匙', '拼写', '断线不丢活', '产物回传',
  // 改进清单那一轮做的四件事。做完了不写进指南 = 用户不知道有
  // ⚠️ 这里的每个词都必须是指南里**真实存在的措辞**，不能凭印象写。
  //    上一轮我写的是「每组新词」，而指南里实际写的是「本组新词」——
  //    于是这条断言从加进来的那一刻起就是红的，我却报成了全绿。
  //    关键词写错时的表现和"功能真的没写进指南"一模一样，得靠下面那条对照挡住。
  '无缝换窗', '本组新词', '音标',
  // 2026-10-10 补的一批（09-23 之后做了却没进指南的）
  '翻记忆', '施工单', '跑腿', '相册', '分享对话', '发音频', '启动页', '桌面歌词',
  '手机近况', '生物钟', 'App 关着也能找你', '本地情绪声音', '一起看', '导入 claude.ai'];
const missing = mustHave.filter(k => !helpBlock.includes(k));
t('清单里做完的功能都写进指南了', missing.length === 0, missing);
// 对照：证明这套查法真的会红。上面那条全绿时说明不了什么——
// 万一 helpBlock 切成了空串，`includes` 会对每个词都返回 false…… 那是会红的；
// 但反过来，如果哪天有人把它切成了整个 index.html，那就**永远绿**，
// 这条断言就死了而没人知道。塞一个绝不该出现的词进去，红一次给它看。
t('   对照：查法本身有效（编的词必须找不到）', !helpBlock.includes('紫色大象跳伞'));
// 指令速查表：AI 真认的标签和指南里列的必须对得上，写错一个她照着说就不灵。
// ⚠️ Codex 一审逮到的：原来写了 [[BRAIN_PIN/RESOLVE/DEL: 词]] 这种合并写法，
//    解析器三个正则一个都不匹配，照抄等于标签留在消息里且什么都不发生。
//    而当时的断言只抓 [[ 后的第一段（BRAIN_PIN），正好把它放过去了。
const slashy = [...helpBlock.matchAll(/<code>\[\[[A-Z_]+[^<]*?\/[^<]*?\]\]<\/code>/g)].map(m => m[0]);
t('速查表里没有 A/B 这种合并写法（解析器不认，照抄必失效）', slashy.length === 0, slashy);
const declared = [...helpBlock.matchAll(/<code>\[\[([A-Z_]+)/g)].map(m => m[1]);
const realTags = new Set([...read('js/05-prompts-api.js').matchAll(/\[\[([A-Z_]{3,})/g)].map(m => m[1]));
// ⚠️ 这份名单是「标签定义在哪些文件里」的登记表，加了新标签必须往里补一个 ——
//    不补的话新标签会被判成"速查表里写了个不存在的指令"，红在指南上而不是红在代码上。
// 30-vitals.js 是 2026-09-01 补的：指南里写了 [[VITALS]]，而这份名单没登记它，
// 于是真标签被判成「速查表里写了个不存在的指令」—— 红在指南上，其实是名单漏了。
// 61~64 是 2026-10-10 补的：跑腿/相册/翻记忆/施工单。当时碰巧能过，只因 05 的
// SKILL_DEFS 说明文字里正好提到了标签名。
for (const f of ['04-memory.js', '19-diary.js', '21-nursery.js', '22-study.js', '24-music.js', '33-who-user.js', '10-stickers-voice.js', '11-camera-call.js', '30-vitals.js',
  '61-errand.js', '62-album.js', '63-breath.js', '64-build.js', '68-treasure.js', '71-wishbook.js',
  '40-engawa.js', '51-moments.js', '53-gallery.js', '54-labkit.js', '55-chem.js', '56-sims.js', '58-formulas.js']) {
  for (const m of read('js/' + f).matchAll(/\[\[([A-Z_]{3,})/g)) realTags.add(m[1]);
}
const bogus = declared.filter(d => !realTags.has(d));
t(`速查表里的指令都是真的（列了 ${declared.length} 条）`, bogus.length === 0, bogus);

console.log('\n[5] 页内查找（Ctrl+F）');
t('27-find.js 已挂进页面', /<script src="\.\/js\/27-find\.js"><\/script>/.test(html));
t('拦 Ctrl+F / Cmd+F', /\(e\.ctrlKey \|\| e\.metaKey\) && k === 'f'/.test(find) && /e\.preventDefault\(\)/.test(find));
// 项目里已经有好几处 keydown（Esc 关弹窗、输入框回车发送），冒泡阶段挂会被先吃掉
t('用捕获阶段挂，别被现有监听吃掉', /addEventListener\('keydown', e => \{[\s\S]*\}, true\)/.test(find));
t('查找条开着时 Esc 先关它，不连底下的弹窗一起关',
  /k === 'escape' && bar && bar\.classList\.contains\('show'\)/.test(find) && /e\.stopPropagation\(\)/.test(find));
t('高亮走 CSS Highlight API，不往 DOM 里插标签',
  /CSS\.highlights\.set/.test(find) && /new Highlight\(/.test(find)
  && /::highlight\(gc-find\)/.test(css) && /::highlight\(gc-find-cur\)/.test(css));
t('不支持时降级（老 WebView 里别整个挂掉）', /const SUPPORTED =/.test(find) && /if \(!SUPPORTED\) return;/.test(find));
t('跳过脚本、样式和藏起来的东西', /SKIP_TAGS/.test(find) && /checkVisibility/.test(find));
// ⚠️ Codex 一审逮到的：原来逐个文本节点各找各的，「阅读 <b>GitHub</b> 仓库」里
//    搜「阅读 GitHub」会报无结果，跟正常的页内查找行为对不上。
t('跨 <b>/<code>/<a> 的短语也能命中（拼全文再映射回节点）',
  /function buildIndex\(\)/.test(find) && /function locate\(map, off\)/.test(find)
  && /r\.setEnd\(e\.node, e\.offset \+ 1\)/.test(find));
t('跨块不接起来（不然会搜出根本不存在的短语）',
  /BLOCK_TAGS/.test(find) && /if \(prevBlock && b !== prevBlock\) text \+= '\\n'/.test(find));
// ⚠️ Codex 一审逮到的：切对话/重渲染后 Range 不再指向真东西，计数还在但点「下一个」不动。
//    坑中坑：按 DOM 规范，边界节点被移除时 Range 会**收缩到父节点**，父节点通常还在文档里，
//    所以 startContainer.isConnected 照样是 true —— 拿它判断一条都判不出来（实测漏了）。
t('DOM 变动后自动重搜（盯 MutationObserver，不靠 isConnected）',
  /new MutationObserver/.test(find) && /dirty = true/.test(find)
  && /dirty \|\| hits\.some\(r => r\.collapsed \|\| fold\(r\.toString\(\)\) !== lastQ\)/.test(find)
  && !/!r\.startContainer\.isConnected/.test(find));
t('observer 只在查找栏开着时挂（别常驻盯全页）',
  /function watchDom\(\)/.test(find) && /function unwatchDom\(\)/.test(find)
  && /bar\.classList\.add\('show'\);\s*\n\s*watchDom\(\)/.test(find)
  && /bar\.classList\.remove\('show'\);\s*\n\s*unwatchDom\(\)/.test(find));
// ⚠️ Codex 二审逮到的：查找栏自己也在 body 里，改计数/加 .show 都会被 observer 记一笔，
//    于是每导航一次 dirty 就是 true，下一次点「下一个」必定全文重建索引（长对话直接顿）
t('查找栏自己的改动不算 DOM 变动', /closest\('#gcFindBar'\)\) continue;/.test(find));
t('搜完把自己造的 mutation 记录倒掉', /observer\.takeRecords\(\)/.test(find));
// 这项目切弹窗靠加减 .hidden；不盯 attributes 的话藏起来的命中还能导航、刚露出来的搜不到
t('也盯 class/style/hidden，不只盯 childList',
  /attributeFilter: \['class', 'style', 'hidden'\]/.test(find));
// ⚠️ Codex 二审逮到的：go() 原来收绝对下标。重搜后 hits 整个换掉，当前处之前多冒出
//    一个命中，「下一个」传进来的 cur+1 正好还是原地 —— 看着像点了没反应。
t('go() 收方向不收下标', /function go\(dir\)/.test(find)
  && /go\(e\.shiftKey \? -1 : 1\)/.test(find) && /onclick = \(\) => go\(1\)/.test(find)
  && !/go\(cur \+ 1\)/.test(find) && !/go\(cur - 1\)/.test(find));
t('重搜后按文档位置接续，不按下标',
  /compareBoundaryPoints\(Range\.START_TO_START, anchor\)/.test(find)
  && /search\(input\.value, true\)/.test(find));
// ⚠️ Codex 二审逮到的：`<b>foo</b> <code>bar</code>` 中间那个 " " 是独立文本节点，
//    过滤掉就拼成 "foobar"：搜「foo bar」漏掉，搜「foobar」反而命中屏幕上不存在的词
t('纯空白文本节点也要收（不然相邻标签会粘成一个词）',
  !/!node\.nodeValue\.trim\(\)/.test(find) && /const normWS = s => s\.replace\(\/\\s\/g, ' '\)/.test(find));
t('空白归一化是 1:1 的，别把偏移映射搞错',
  /text \+= normWS\(node\.nodeValue\)/.test(find) && /len: node\.nodeValue\.length/.test(find));
// ⚠️ Codex 三审逮到的：小写也会改长度。'İ'(U+0130) 整串 toLowerCase 变成两个码元，
//    hay 比 text 长，locate() 按原偏移取就取到隔壁字符 —— 命中漏掉、Range 画歪。
t('小写折叠也是 1:1 的（逐码点，长度一变就退回同长度的写法）',
  /const lowerFixed = s =>/.test(find)
  && /for \(const ch of s\)/.test(find)
  && /String\.fromCodePoint\(lo\.codePointAt\(0\)\)/.test(find)
  && /out \+= head\.length === ch\.length \? head : ch;/.test(find)
  && !/text\.toLowerCase\(\)/.test(find));
// ⚠️ Codex 四审逮到的：逐字符折叠丢了 toLowerCase 的**上下文**。希腊文词尾是 ς、词中是 σ，
//    页面上写着 'ος'，搜 'ΟΣ' 逐字符折成 'οσ' 就搜不到了。末尾统一 ς→σ（单码元，长度不变）。
t('希腊文词尾 sigma 归一（不然 ΟΣ 搜不到 ος）',
  /return out\.replace\(\/ς\/g, 'σ'\)/.test(find));
t('搜索词和页面文字过同一道 fold',
  /const fold = s => lowerFixed\(normWS\(s \|\| ''\)\)/.test(find)
  && /lastQ = fold\(q\)/.test(find) && /const hay = lowerFixed\(text\)/.test(find));
t('查找条自己不参与搜索（不然搜索词自己命中自己）', /closest\('#gcFindBar'\)/.test(find));
t('命中数封顶（长对话搜个「的」能命中上万处）', /MAX_HITS/.test(find));
t('输入防抖', /clearTimeout\(debounce\)/.test(find) && /setTimeout\(\(\) => search\(input\.value\), \d+\)/.test(find));
t('到头绕回去而不是卡住', /cur = \(\(i % hits\.length\) \+ hits\.length\) % hits\.length/.test(find));
t('聊天里的命中会直接推动 chatWindow.scrollTop（不只滚虚拟化消息的内部节点）', (() => {
  const start = find.indexOf('function scrollHitIntoView(r)');
  const end = find.indexOf('\n\n  // ── 跳到第 i 处', start);
  if (start < 0 || end < 0) return false;
  const scrollHitIntoView = new Function(find.slice(start, end) + '\nreturn scrollHitIntoView;')();
  let laidOut = false, scrolled = null, nativeScrolls = 0;
  const chatWin = {
    scrollTop: 1000, clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: opts => { scrolled = opts; },
  };
  const wrapper = {
    style: { contentVisibility: '' },
    closest: sel => sel === '#chatWindow' ? chatWin : null,
  };
  const el = {
    closest: sel => sel === '[data-msg-wrapper]' ? wrapper : null,
    scrollIntoView: () => { nativeScrolls++; },
  };
  const range = {
    startContainer: { parentElement: el },
    getBoundingClientRect: () => {
      laidOut = wrapper.style.contentVisibility === 'visible';
      return { top: 700, height: 20 };
    },
  };
  scrollHitIntoView(range);
  return laidOut && wrapper.style.contentVisibility === '' && nativeScrolls === 0
    && scrolled?.behavior === 'smooth' && scrolled.top === 1310;
})());
t('非聊天内容仍交给 scrollIntoView 选择自己的滚动容器', (() => {
  const start = find.indexOf('function scrollHitIntoView(r)');
  const end = find.indexOf('\n\n  // ── 跳到第 i 处', start);
  if (start < 0 || end < 0) return false;
  const scrollHitIntoView = new Function(find.slice(start, end) + '\nreturn scrollHitIntoView;')();
  let opts = null;
  const el = { closest: () => null, scrollIntoView: o => { opts = o; } };
  scrollHitIntoView({ startContainer: { parentElement: el } });
  return opts?.block === 'center' && opts.behavior === 'smooth';
})());
t('关闭时清掉高亮', /function close\(\)[\s\S]{0,200}clearHighlights\(\)/.test(find));
t('给手机留了调用入口（没有 Ctrl 键）', /window\.openFindBar = open/.test(find));
t('查找条样式在，且手机上收窄', /#gcFindBar \{/.test(css) && /#gcFindInput \{ width:150px/.test(css));

console.log('\n[6] 桌面与安卓副本一致');
t('android 副本与 js/ 一致', ['13-trash-ctx-ui.js', '27-find.js', '05-prompts-api.js'].every(f =>
  fs.readFileSync(path.join(ROOT, 'js', f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));
t('android 的 index.html / css 也同步了',
  fs.readFileSync(path.join(ROOT, 'index.html')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html')))
  && fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
