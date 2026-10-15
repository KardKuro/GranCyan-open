const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const render = read('js/06-render-msg.js');
const state = read('js/02-state.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/grancyan.css');

// 判据要框在函数体内。全文 grep 会把别处的同名调用、甚至注释里提到的写法
// 一起算进去 —— 上一版就是这么误报的（注释里写了「不走 prompt()」，断言当成了真的在用）。
function fnBody(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}
const noComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log('\n[收藏夹分组]');
t('有分组条和归类选择器', /function renderFavGroupBar\(/.test(render) && /function setFavItemGroup\(/.test(render));
t('能新建、能切换筛选', /function submitNewFavGroup\(/.test(render) && /function setFavFilter\(/.test(render));
t('分组名单独存着（不然新建的空组一刷新就没）', /state\.favGroups \|\| \(state\.favGroups = \[\]\)/.test(render));

// 这条是这个功能最容易出错的地方，单独守：
// 列表渲染的是过滤后的子集，但 removeFav/jumpToFav/copyFav 都按 state.favMessages
// 的下标操作。要是把子集下标传下去，筛选到某个分组时就会删错条目 —— 不筛选时
// 一切正常，所以手点很难撞上。
console.log('\n[下标陷阱]');
t('取下标在过滤之前', /\.map\(\(f, i\) => \(\{ f, i \}\)\)[\s\S]{0,80}\.filter\(/.test(render));
t('列表渲染解构出全集下标，而不是子集位置', /entries\.map\(\(\{ f, i \}\)/.test(render));
// 反过来验：渲染块里不该再出现"直接对收藏数组按位置取下标"的写法。
const favRenderBlock = (render.match(/function renderFavList\(\)[\s\S]*?\n\}/) || [''])[0];
t('渲染块里挑不出按位置下标遍历收藏的写法', favRenderBlock.length > 0 && !/favs\.map\(\(f, ?i\)/.test(favRenderBlock));

console.log('\n[删组的语义]');
const delBody = noComments(fnBody(render, 'deleteFavGroup'));
t('删分组只摘掉分类，不动收藏本身',
  delBody.length > 0 && /delete f\.group/.test(delBody) && !/favMessages\.splice/.test(delBody));
t('收藏真要删仍然走 removeFav（进回收站）', /function removeFav\(i\)[\s\S]*?state\.trash\.push\(\{ type: 'fav'/.test(render));

console.log('\n[持久化五道关]');
t('favGroups 有 state 默认值', /favGroups: \[\]/.test(state));
t('favGroups 写入 IndexedDB', state.includes('state.favGroups') && state.includes('kuro_favGroups'));
t('favGroups 从 IndexedDB 读回', core.includes("kuro_favGroups"));
t('favGroups 进入云同步 push', /favGroups: state\.favGroups/.test(core));
t('favGroups 启动时落回 state', boot.includes('state.favGroups') && boot.includes('saved.favGroups'));
// favGroupsVer 是 favGroups 的伴生字段（合并要靠它定谁新），五道关一样得走全。
t('favGroupsVer 有 state 默认值', /favGroupsVer: 0/.test(state));
t('favGroupsVer 写入 IndexedDB', state.includes('kuro_favGroupsVer'));
t('favGroupsVer 从 IndexedDB 读回', core.includes('kuro_favGroupsVer'));
t('favGroupsVer 进入云同步 push', /favGroupsVer: state\.favGroupsVer/.test(core));
t('favGroupsVer 启动时落回 state', boot.includes('state.favGroupsVer') && boot.includes('saved.favGroupsVer'));
// 版本号必须跟设备时钟脱钩：用时间戳的话，一台机器时钟快一年就能长期压住另一台。
t('版本号是计数器不是时间戳', /function _nextFavGroupVer\(\)[^\n]*favGroupsVer[^\n]*\+ 1/.test(render)
  && !/favGroupsVer\s*=\s*new Date/.test(render));
// ops 表也是同步状态，五道关一样得走全。
t('favGroupOps 有 state 默认值', /favGroupOps: \{\}/.test(state));
t('favGroupOps 写入 IndexedDB', state.includes('kuro_favGroupOps'));
t('favGroupOps 从 IndexedDB 读回', core.includes('kuro_favGroupOps'));
t('favGroupOps 进入云同步 push', /favGroupOps: state\.favGroupOps/.test(core));
t('favGroupOps 启动时落回 state', boot.includes('state.favGroupOps') && boot.includes('saved.favGroupOps'));
/* 新建和删除必须盖在**各自的名字**上，不能只抬一个全局版本号 —— 两台设备从同一版本
   各改一次，全局版本号必然撞平，删除就会被并集复活（Codex 三审给的序列）。 */
t('新建和删除各自在 ops 表里盖版本',
  noComments(fnBody(render, 'submitNewFavGroup')).includes('markFavGroupAdded(name)')
  && noComments(fnBody(render, 'deleteFavGroup')).includes('markFavGroupRemoved(name)'));

/* 云端合并的真实行为测试。合并语义错在哪，正则断言一个字都看不出来 —— 这里把源码
   那段抠出来 new Function 真跑。前后错过两版，两版都是"删了又活"，见 01-core 的注释。 */
console.log('\n[云端合并的语义]');
const mergeSrc = (core.match(/const _fgOps = Object\.create\(null\);[\s\S]*?(?=\s*updateFavBadge\(\))/) || [''])[0];
t('合并逻辑抠得出来（抠不出来说明源码结构变了，下面几条就没意义了）', mergeSrc.length > 0);
const runMerge = (local, cloud) => {
  const state = JSON.parse(JSON.stringify(local));
  const s = JSON.parse(JSON.stringify(cloud));
  new Function('state', 's', mergeSrc)(state, s);
  return state;
};
// 按"某个名字在第 v 版被新建/删除"造状态，省得每条用例手写 ops 表
const dev = (ver, ops, favs) => ({
  favGroupsVer: ver, favMessages: favs || [],
  favGroupOps: ops || {},
  favGroups: Object.keys(ops || {}).filter(n => ops[n].a >= ops[n].d)
});
if (mergeSrc) {
  // 1. 本机刚删掉「工作」，云端还是旧的。删除必须挺住。
  const del = runMerge(
    dev(6, { 灵感: { a: 1, d: 0 }, 工作: { a: 2, d: 6 } }),
    dev(5, { 灵感: { a: 1, d: 0 }, 工作: { a: 2, d: 0 } }));
  t('本机删掉的组不会被云端复活', !del.favGroups.includes('工作'));

  // 2. 反过来：云端删的，本机是旧的，该同步过来。
  const rem = runMerge(
    dev(5, { 灵感: { a: 1, d: 0 }, 工作: { a: 2, d: 0 } }),
    dev(6, { 灵感: { a: 1, d: 0 }, 工作: { a: 2, d: 6 } }));
  t('另一台设备删掉的组会同步过来', !rem.favGroups.includes('工作'));
  t('收下更高的版本号（不然下次编辑抬不过对方）', rem.favGroupsVer === 6);

  /* 3. ⚠️ 这条是 Codex 三审给的序列，前一版就死在这里：
     同在 v5，A 删「甲」→v6，B 新建「乙」→v6。两边版本号撞平，
     "整包 LWW + 平局取并集"会把「甲」原样并回来。 */
  const raceA = runMerge(
    dev(6, { 甲: { a: 5, d: 6 } }),                        // A：删了「甲」
    dev(6, { 甲: { a: 5, d: 0 }, 乙: { a: 6, d: 0 } }));   // B：同版本新建了「乙」
  const raceB = runMerge(
    dev(6, { 甲: { a: 5, d: 0 }, 乙: { a: 6, d: 0 } }),
    dev(6, { 甲: { a: 5, d: 6 } }));
  t('并发「一边删、一边新建」不会复活被删的组', !raceA.favGroups.includes('甲'));
  t('同时另一边新建的组不能丢', raceA.favGroups.includes('乙'));
  t('两台设备收敛到完全相同的一份（顺序也一样）',
    JSON.stringify(raceA.favGroups) === JSON.stringify(raceB.favGroups));

  // 4. 删掉之后又重新建同名的组，得能建回来（2P-Set 会永久拉黑，那是错的）。
  const readd = runMerge(
    dev(8, { 甲: { a: 8, d: 6 } }),
    dev(6, { 甲: { a: 5, d: 6 } }));
  t('删掉后重新建同名的组能建回来', readd.favGroups.includes('甲'));

  /* 5. 老数据迁移：升级后本机和云端都没有 ops 表。旧行为是无条件并集，
     迁移必须零变化，云端已有的空组不能凭空消失。 */
  const legacy = runMerge(
    { favGroups: [], favMessages: [] },
    { favGroups: ['以前建的空组'], favMessages: [] });
  t('老数据升级不丢云端的空组', legacy.favGroups.includes('以前建的空组'));
  // 但补迁移不能把已经有墓碑的名字救活
  const legacyDead = runMerge(
    dev(6, { 甲: { a: 5, d: 6 } }),
    { favGroups: ['甲'], favMessages: [] });
  t('迁移补名字时不会救活已经删掉的组', !legacyDead.favGroups.includes('甲'));

  // 6. 收藏上挂着的组名（老数据、或对面的收藏先到）要补进列表，否则筛不出来。
  const keep = runMerge(
    { favGroups: [], favMessages: [{ group: '要回头看' }, {}] },
    { favGroups: [], favMessages: [] });
  t('收藏上挂着的组名补得进列表', keep.favGroups.includes('要回头看'));
  // 反过来：组被删了，另一台设备的收藏还挂着旧组名，得摘掉。
  // 不摘的话那条收藏顶着一个点不出来的标签，"未分组"也筛不到它，等于失踪。
  const stale = runMerge(
    dev(6, { 甲: { a: 5, d: 6 } }, [{ group: '甲' }]),
    dev(5, { 甲: { a: 5, d: 0 } }));
  t('组删掉后，收藏上残留的旧组名会被摘掉', !stale.favMessages[0].group);

  // 7. 同一次推送来回：不该抖。
  const same = runMerge(
    dev(5, { 灵感: { a: 1, d: 0 } }),
    dev(5, { 灵感: { a: 1, d: 0 } }));
  t('两边完全一致时原样不动', JSON.stringify(same.favGroups) === JSON.stringify(['灵感']));

  /* 8. 组名叫 `__proto__`：普通 {} 上 `ops[name] = …` 打的是原型 setter，属性根本
     建不成，组就此消失、下面的收藏还被摘成未分组，全程零报错。造用例必须用计算属性
     写键，否则对象字面量自己先把它吞了 —— 所以先立个对照组证明这个用例真的在测东西。 */
  const protoOps = Object.create(null);
  protoOps['__proto__'] = { a: 3, d: 0 };
  // 危险的是**赋值**（走原型 setter），不是计算属性字面量（那个反而建得出自有属性）。
  const plainOps = {};
  plainOps['__proto__'] = { a: 3, d: 0 };
  t('对照组：往普通对象上赋值 __proto__ 确实存不住',
    Object.keys(plainOps).length === 0 && Object.keys(protoOps).length === 1);
  const protoMerged = runMerge(
    { favGroupsVer: 3, favGroupOps: protoOps, favGroups: ['__proto__'], favMessages: [{ group: '__proto__' }] },
    { favGroupsVer: 3, favGroupOps: Object.create(null), favGroups: [], favMessages: [] });
  t('组名叫 __proto__ 也能活过一次云合并', protoMerged.favGroups.includes('__proto__'));
  t('__proto__ 组下面的收藏不会被摘成未分组', protoMerged.favMessages[0].group === '__proto__');
  // 写入侧同理：markFavGroupAdded 必须真的建出自有属性
  const protoAddSrc = (render.match(/function _favGroupOps\(\)[\s\S]*?function markFavGroupRemoved[\s\S]*?\n\}/) || [''])[0];
  const protoState = new Function('state',
    protoAddSrc + 'markFavGroupAdded("__proto__"); return state;')({ favGroupsVer: 0 });
  t('新建名叫 __proto__ 的组能落进 ops 表', Object.keys(protoState.favGroupOps).includes('__proto__'));
  t('__proto__ 的 ops 能被 JSON 存下来（不然刷新就没）',
    Object.keys(JSON.parse(JSON.stringify(protoState.favGroupOps))).includes('__proto__'));

  // 9. 收下高版本之后，本机再编辑必须还能压过对方（计数器的意义）。
  const bumped = runMerge(dev(1, { 甲: { a: 1, d: 0 } }), dev(99, { 甲: { a: 1, d: 0 } }));
  const markSrc = (render.match(/function _favGroupOps\(\)[\s\S]*?function markFavGroupRemoved[\s\S]*?\n\}/) || [''])[0];
  const nextVer = new Function('state', markSrc + 'markFavGroupAdded("新"); return state.favGroupsVer;')(bumped);
  t('收下高版本后本机下次编辑仍能压过对方', nextVer > 99);
}

console.log('\n[输入与显示]');
// 安卓 WebView 里 prompt() 是系统弹层，样式改不动，跟深色界面完全脱节。
const newGroupBody = noComments(fnBody(render, 'submitNewFavGroup'));
t('新建分组不走系统 prompt()', newGroupBody.length > 0 && !/\bprompt\(/.test(newGroupBody));
t('组名显示前转义（组名是用户输入，会进 innerHTML）',
  /class="fav-tag">\$\{(?:escHtml|favHi)\(f\.group\)\}/.test(render)
  && /function favHi\(text\)[\s\S]{0,100}escHtml\(/.test(render));
t('分组条的组名也转义', /fav-chip[\s\S]{0,200}escHtml\(label\)/.test(render));
t('分组样式在（含空组和标签）', /\.fav-group-bar/.test(css) && /\.fav-chip/.test(css) && /\.fav-tag/.test(css));

/* 组名进 onclick 的注入。escHtml 只保护"看得见的文本"，救不了旁边的 JS 代码。
   原来的写法是 JSON.stringify(g) 之后把 " 换成 &quot; —— 不够：属性值里的实体是
   浏览器**解析属性时**就解掉的，组名自己带的 &quot; 会变回真引号提前收尾。
   取名 `&quot;);alert(1);//` 的组，点一下就执行 alert。（Codex 审出来的。） */
console.log('\n[组名不许进事件代码]');
// 先立对照组：判据必须能判旧写法有罪、判新写法无罪，不然这条断言等于没写。
const decodeAttr = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const escapesOk = fn => ['&quot;);alert(1);//', "Don't", 'A&amp;B', '正常'].every(n => {
  try { return eval('(' + decodeAttr(fn(n)) + ')') === n; } catch { return false; }
});
const oldWay = v => JSON.stringify(v).replace(/"/g, '&quot;');
const jsAttrSrc = (read('js/09-appearance-input.js').match(/function jsAttr\(v\)[\s\S]*?\n\}/) || [''])[0];
t('对照组：旧的"只换双引号"写法确实过不了这个判据', !escapesOk(oldWay));
t('jsAttr 挡得住注入，也不会改坏含 & 和 \' 的名字',
  jsAttrSrc.length > 0 && escapesOk(new Function('return ' + jsAttrSrc + '; ')()));

// 反过来验：分组这两个渲染函数的事件属性里，挑不出任何一处把组名拼进去的写法。
// 现在一律只放数字下标（setFavFilterAt / setFavItemGroupAt / deleteCurrentFavGroup）。
const favUiSrc = noComments(fnBody(render, 'renderFavGroupBar') + fnBody(render, 'renderFavList'));
const onclickArgs = (favUiSrc.match(/on(?:click|keydown|blur)="[^"]*"/g) || []);
t('分组 UI 的事件代码里挑不出组名变量', onclickArgs.length > 0
  && !onclickArgs.some(a => /JSON\.stringify|jsAttr|escHtml|\$\{g\}|\$\{name\}|\$\{_favFilter\}/.test(a)));
t('改用只传下标的包装函数', ['setFavFilterAt', 'setFavItemGroupAt', 'deleteCurrentFavGroup']
  .every(f => new RegExp('function ' + f + '\\(').test(render)));
/* 下标只在渲染那一刻有效。云同步会在面板开着的时候换掉 state.favGroups，
   不重画的话旧 chip 就指到别的组上去了 —— updateFavBadge 只改计数徽章，不重画列表。 */
t('云同步落地后会重画开着的收藏面板', /function refreshFavPanelIfOpen\(/.test(render)
  && /updateFavBadge\(\);\s*\n\s*if \(typeof refreshFavPanelIfOpen/.test(core));
t('重画时把已经不存在的筛选退回全部',
  noComments(fnBody(render, 'refreshFavPanelIfOpen')).includes("_favFilter = '*'"));

// 同款写法在别处也有（歌名来自网易云 API、书签名/设备名同理），一并扫掉。
// 歌那处的 onclick 还是单引号包裹的，一个 Don't 就能把属性提前收尾。
const allJs = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js'));
const legacy = allJs.filter(f => /JSON\.stringify\([^)]*\)\.replace\(\/"\/g/.test(read('js/' + f)));
t('全项目挑不出"JSON.stringify 完只换双引号"的残留', legacy.length === 0);
if (legacy.length) legacy.forEach(f => console.log('      残留: js/' + f));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
