'use strict';
// 点歌：收藏 + 歌单（用户要的第 7 条）
//
// 这个文件尽量**真跑函数**而不是拿正则去源码里找字符串。
// 找字符串的断言只能证明"我写过这行"，证明不了它还работает——
// 改个变量名它照样绿。所以除了"三道门装没装"这种确实只能查源码的，
// 其余一律在 vm 里把函数抠出来真的调一遍。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
// 有一节要 await（建歌单是异步的），整份包进 async main
async function main() {
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const music = read('js/24-music.js');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');
const mathMedia = read('js/12-math-media.js');
const css = read('css/grancyan.css');

// ── 沙箱：把 24-music.js 整个丢进去跑 ──────────────────────────────────
// 它顶层只有函数声明和 var，没有立即执行的副作用，可以整份加载。
function sandbox() {
  const toasts = [];
  const box = {
    state: {},
    save: () => { box._saved = (box._saved || 0) + 1; },
    showToast: (m, type) => toasts.push({ m, type }),
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    musicRefresh: () => { box._refreshed = (box._refreshed || 0) + 1; },
    renderMessages: () => {},
    getActiveChat: () => box._chat || null,
    // 面板要真的画出来才测得到。给一个能收 innerHTML 的假 body，
    // 其余元素一律 null —— musicRefresh 对缺元素本来就是宽容的。
    _panel: { innerHTML: '' },
    document: {
      getElementById: id => {
        if (id === 'musicBody') return box._panel;
        if (id === 'musicModal') return { classList: { contains: () => false } };
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,X' })
    },
    prompt: (...a) => { box._asked = (box._asked || []).concat([a[0]]); return box._answer; },
    confirm: () => box._confirm !== false,
    setTimeout: () => {},
    setInterval: () => {},
    addEventListener: () => {},        // 文件顶层有几个立即注册的监听器
    requestAnimationFrame: () => {},
    Audio: function () { this.addEventListener = () => {}; },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node' },
    Image: function () {},
    FileReader: function () {},
    Math, Date, JSON, console, RegExp, Object, Array, String, Number, Boolean,
    toasts
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(music, box);
  // ⚠️ 必须在这之后覆盖：24-music.js 里的  是函数声明，
  //    执行时会盖掉 box 字面量里的同名属性。放在前面等于没 mock，
  //    调到真函数 → fetch 未定义 → 异常被 catch 吞掉 → 歌单建出来但一首歌都没有。
  box.musicPick = q => {
    box._picked = (box._picked || []).concat([q]);
    return Promise.resolve({ song: { id: 'x' + box._picked.length, name: q, artist: 'A', cover: '' } });
  };
  return box;
}

const S = (id, name, artist) => ({ id, name, artist: artist || '歌手', cover: '' });

// ── 一、收藏 ───────────────────────────────────────────────────────────
console.log('\n[1] 收藏');
{
  const b = sandbox();
  b.musicToggleFav(S(1, '夜曲'));
  t('收藏一首 → 进收藏夹', b.state.musicFav.length === 1);
  t('musicIsFav 认得出来', b.musicIsFav(1) === true);
  // 网易云的 id 有时是数字有时是字符串。用 === 比的话同一首歌能被收藏两次，
  // 收藏夹里出现两条一模一样的，而且第二次点心还是灭的。
  t('id 是字符串也认得（"1" 和 1 是同一首）', b.musicIsFav('1') === true);
  b.musicToggleFav(S('1', '夜曲'));
  t('再点一次 → 取消收藏，不是攒出第二条', b.state.musicFav.length === 0);

  b.musicToggleFav(S(2, '晴天'));
  const kept = Object.keys(b.state.musicFav[0]);
  t('存进去的只有精简字段，没把整个搜索结果拖进 IndexedDB',
    kept.every(k => ['id', 'name', 'artist', 'cover', 'ts'].includes(k)), kept);

  b.musicToggleFav(null);
  t('song 是 null 时不炸也不写脏数据', b.state.musicFav.length === 1);
  b.musicToggleFav({ name: '没有 id 的歌' });
  t('没有 id 的东西不许进收藏夹', b.state.musicFav.length === 1);
}

// ── 二、歌单增删改 ─────────────────────────────────────────────────────
console.log('\n[2] 歌单增删改');
{
  const b = sandbox();
  const p = b.musicPlaylistCreate('深夜', '睡不着的时候', 'me');
  t('建得出歌单', !!p && p.name === '深夜');
  t('简介存下来了', p.desc === '睡不着的时候');
  t('进了 state.musicPlaylists', b.state.musicPlaylists.length === 1);

  t('空名字建不出来（不许攒出一个没名字的歌单）', b.musicPlaylistCreate('   ', '', 'me') === null);
  t('空名字也没写进 state', b.state.musicPlaylists.length === 1);

  t('加歌成功', b.musicPlaylistAdd(p.id, S(1, '夜曲')) === true);
  t('同一首不重复进', b.musicPlaylistAdd(p.id, S('1', '夜曲')) === false);
  t('歌单里就一首', p.songs.length === 1);
  b.musicPlaylistAdd(p.id, S(2, '晴天'));

  b.musicPlaylistRemoveSong(p.id, 0);
  t('删掉第一首后剩下的是第二首', p.songs.length === 1 && String(p.songs[0].id) === '2');

  // 名字/简介可编辑（用户明确要的）
  b._answer = '午夜';
  await b.musicPlaylistRename(p.id);
  t('改得了名字', p.name === '午夜');
  b._answer = null;                  // prompt 返回 null = 她按了取消
  await b.musicPlaylistRename(p.id);
  t('取消改名 → 名字不动', p.name === '午夜');
  b._answer = '   ';
  await b.musicPlaylistRename(p.id);
  t('改成空名字被挡住（不然歌单会变成一个看不见的条目）', p.name === '午夜');

  b._answer = '睡前听';
  await b.musicPlaylistEditDesc(p.id);
  t('改得了简介', p.desc === '睡前听');
  b._answer = '';
  await b.musicPlaylistEditDesc(p.id);
  t('简介可以清空（跟名字不同，简介本来就允许没有）', p.desc === '');

  b._confirm = false;
  b.musicPlaylistDelete(p.id);
  t('确认框点了取消 → 歌单还在', b.state.musicPlaylists.length === 1);
  b._confirm = true;
  b.musicPlaylistDelete(p.id);
  t('确认了才真删', b.state.musicPlaylists.length === 0);
}

// ── 三、AI 建歌单的指令解析 ────────────────────────────────────────────
console.log('\n[3] AI 建歌单：[[PLAYLIST:]]');
{
  const b = sandbox();
  let r = b._mParsePlaylistSpec('深夜 | 睡不着的时候 | 夜曲 周杰伦 / 晴天 周杰伦');
  t('三段式解析出名字', r.name === '深夜');
  t('解析出简介', r.desc === '睡不着的时候');
  t('解析出两首歌', r.songs.length === 2 && r.songs[0] === '夜曲 周杰伦');

  r = b._mParsePlaylistSpec('深夜 | 夜曲 / 晴天');
  t('两段式（省掉简介）也认', r.name === '深夜' && r.songs.length === 2);
  t('省掉简介时简介是空的，不会把歌名当简介', r.desc === '');

  r = b._mParsePlaylistSpec('多 | x | ' + Array.from({ length: 40 }, (_, i) => '歌' + i).join(' / '));
  t('一次最多 20 首（不然它一口气点两百首，每首都是一次网络请求）', r.songs.length === 20);

  r = b._mParsePlaylistSpec('空的 | 简介 | ');
  t('一首歌都没有时 songs 是空的（调用方据此拒绝建）', r.songs.length === 0);

  // 正则真的能命中带元字符的名字。这条是冲着转义写的：
  // 少一层转义的话，C++ 这种名字会让固化步骤悄悄失配，
  // 于是标签永远换不掉 → 每渲染一次就多建一个同名歌单。
  const raw = 'C++ 的歌 | 简介 | 夜曲';
  const re = new RegExp('\\[\\[PLAYLIST:\\s*' + raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\]\\]', 'g');
  t('带正则元字符的歌单名也能被固化正则命中',
    ('前 [[PLAYLIST: ' + raw + ']] 后').replace(re, '<T>') === '前 <T> 后');
}

// ── 三点五、建完必须把标签固化掉 ───────────────────────────────────────
// [[PLAYLIST:]] 是「去建一个」，[[PLIST:id]] 是「已经建好了，画出来就行」。
// 建完不换掉的话，这条消息每渲染一次就再建一个同名歌单 —— 翻一次历史
// 就翻出一串，而且一声不响。
//
// 这一节是**故障注入逼出来的**：把固化那句换成空操作，上面那些断言全绿。
// 只测解析器不测接线，等于没测。
console.log('\n[3.5] 建完把标签固化掉');
{
  const b = sandbox();
  b.state.musicOn = true;
  const raw = '深夜 | 睡不着 | 夜曲 / 晴天';
  // 一份「聊天记录」，里面就存着那条待办标签
  const node = { content: '给你攒了个歌单 [[PLAYLIST: ' + raw + ']]', blocks: null, variants: null };
  b._chat = { nodes: { n1: node } };

  await b.resolvePlaylistBuild('nonexistent-el', raw);

  t('真的去搜了两首歌', (b._picked || []).length === 2, b._picked);
  t('歌单建出来了', b.state.musicPlaylists.length === 1);
  t('两首都进了歌单', b.state.musicPlaylists[0].songs.length === 2);
  t('★ 待办标签被换成了已完成标签（漏了这步 = 每次渲染都重建一个）',
    /\[\[PLIST:/.test(node.content), node.content);
  t('★ 原来那条 [[PLAYLIST:]] 不留在记录里', !/\[\[PLAYLIST:/.test(node.content), node.content);
  t('固化写进去的 id 就是刚建那个歌单的',
    node.content.includes(b.state.musicPlaylists[0].id), node.content);

  // 再渲染一次：现在只应该画出来，不该再建第二个
  b.musicPlaylistTagToHtml(node.content);
  t('★ 再渲染一次不会又建一个（同名歌单只此一个）', b.state.musicPlaylists.length === 1);
}

// ── 四、三个配套一个都不能少 ───────────────────────────────────────────
// 一条 [[指令]] 要活，得同时有：提示词告诉模型、渲染层认得、回填历史给模型看。
// 漏任何一个都不报错，只是行为怪：不写 → 它不知道能用；不认 → 裸标签漏在气泡里；
// 不回填 → 它看不见自己建过，反复建同名歌单。
console.log('\n[4] 三个配套');
{
  const b = sandbox();
  b.state.musicOn = true;

  // ① 提示词
  b.state.musicPlaylists = [{ id: 'a', name: '深夜', desc: '', songs: [{ id: 1 }], ts: 1, by: 'ai' }];
  const prompt = b.musicPromptFor();
  t('① 提示词里写了 [[PLAYLIST:]]', prompt.stable.includes('[[PLAYLIST:'));
  t('① 提示词讲了三段怎么隔开', prompt.stable.includes('|') && prompt.stable.includes('/'));
  t('① 提示词写了 20 首上限（跟代码里的截断对得上）', /20\s*首/.test(prompt.stable));
  t('① 已有歌单报给模型了（不然它反复建同名的）', prompt.volatile.includes('深夜'));
  t('① 已有歌单进的是 volatile 段，不是 stable（进 stable 会把提示词缓存打废）',
    !prompt.stable.includes('深夜'));

  // ② 渲染层：已建好的歌单标签 → 卡片
  const html = b.musicPlaylistTagToHtml('前面 [[PLIST:a|深夜|]] 后面');
  t('② PLIST 标签渲染成卡片', html.includes('music-pl-card-chat'));
  t('② 卡片上有歌单名', html.includes('深夜'));
  t('② 渲染完不留裸标签', !html.includes('[[PLIST:'));

  // 歌单被她删掉之后，历史消息里的标签不能留一张坏卡片
  const gone = b.musicPlaylistTagToHtml('[[PLIST:zzz|没了的歌单|]]');
  t('② 歌单已删 → 说一句它没了，不是半张空卡片', gone.includes('已删除'));
  t('② 歌单已删也不留裸标签', !gone.includes('[[PLIST:'));

  // ③ 回填历史
  const back = b.musicTagForApi('[[PLIST:a|深夜|睡前]] 和 [[PLAYLIST: 新的 | x | 歌]]');
  t('③ 建好的歌单回填成人话', back.includes('建了个歌单') && back.includes('深夜'));
  t('③ 在途的也回填', back.includes('建歌单') && back.includes('新的'));
  t('③ 回填后不留裸标签给模型看（它会照着历史学格式）',
    !back.includes('[[PLIST:') && !back.includes('[[PLAYLIST:'));

  // ④ 流式遮罩
  const masked = b.maskStreamingMusic('正在写 [[PLAYLIST: 深夜 | x | 歌');
  t('④ 流式打字时半截指令不漏在气泡里', !masked.includes('[[PLAYLIST:'));
  t('④ 遮罩换成了给人看的字', masked.includes('整理歌单'));
}

// ── 四点五、面板真的画得出来 ───────────────────────────────────────────
// 上面测的都是纯函数。但面板是 innerHTML 全量重画的，
// 里面的模板字符串引用了一堆函数——少定义一个就是运行时 ReferenceError，
// 表现是「点开小组件一片空白」，而纯函数测试全绿。
console.log('\n[4.5] 面板渲染');
{
  const b = sandbox();
  b.state.musicFav = [{ id: 1, name: '夜曲', artist: '周杰伦', cover: '' }];
  b.state.musicPlaylists = [{ id: 'p1', name: '深夜', desc: '睡不着', cover: '', songs: [{ id: 2, name: '晴天', artist: '周杰伦' }], ts: 1, by: 'ai' }];

  let err = null;
  try { b.musicSetTab('search'); } catch (e) { err = e; }
  t('搜索页画得出来，不抛错', !err, err && String(err));
  t('搜索页有三个页签', (b._panel.innerHTML.match(/music-tab/g) || []).length >= 3);

  err = null;
  try { b.musicSetTab('fav'); } catch (e) { err = e; }
  t('收藏页画得出来，不抛错', !err, err && String(err));
  t('收藏页列出了收藏的歌', b._panel.innerHTML.includes('夜曲'));

  err = null;
  try { b.musicSetTab('lists'); } catch (e) { err = e; }
  t('歌单页画得出来，不抛错', !err, err && String(err));
  t('歌单页列出了歌单', b._panel.innerHTML.includes('深夜'));

  err = null;
  try { b.musicOpenList('p1'); } catch (e) { err = e; }
  t('歌单详情画得出来，不抛错', !err, err && String(err));
  t('详情里有歌单里的歌', b._panel.innerHTML.includes('晴天'));
  t('详情里有简介', b._panel.innerHTML.includes('睡不着'));

  // 歌单在详情页开着的时候被删掉：不能白屏，得退回列表
  b.state.musicPlaylists = [];
  err = null;
  try { b.musicRefresh(); } catch (e) { err = e; }
  t('歌单被删了还停在详情页 → 不白屏也不抛错', !err, err && String(err));
  t('自动退回歌单列表', b._panel.innerHTML.includes('还没有歌单'));

  // 换页签要把详情页状态清掉，不然从别的页签回来还停在某个歌单里
  b.state.musicPlaylists = [{ id: 'p2', name: 'A', desc: '', cover: '', songs: [], ts: 1, by: 'me' }];
  b.musicOpenList('p2');
  b.musicSetTab('lists');
  t('换页签会退出歌单详情（否则回来时停在莫名其妙的地方）',
    !b._panel.innerHTML.includes('所有歌单'));
}

// ── 五、渲染入口真的接上了 ─────────────────────────────────────────────
console.log('\n[5] 接线');
t('渲染层调的是包含歌单的那个入口（musicTagToHtmlAll）',
  /musicTagToHtmlAll\(text\)/.test(mathMedia));
t('musicTagToHtmlAll 里两条都走（单曲 + 歌单）',
  /musicTagToHtmlAll[\s\S]{0,160}musicPlaylistTagToHtml\(musicTagToHtml\(/.test(music));

// ── 六、持久化三道门 ───────────────────────────────────────────────────
// 这个项目踩过：加了 state 字段只改一处，刷新就没，而且零报错。
// 三道门缺任何一道，功能在当次会话里都完全正常，关掉软件才发现东西没了。
console.log('\n[6] 持久化三道门');
for (const f of ['musicFav', 'musicPlaylists']) {
  t(`${f} ① 启动时从 IDB 读回来`, new RegExp(`${f}:\\s*await g\\(`).test(core));
  t(`${f} ② save() 时写下去`, new RegExp(`idbSet\\('kuro_${f}'`).test(stateJs));
  t(`${f} ③ 启动时赋进 state`, new RegExp(`state\\.${f}\\s*=`).test(boot));
}

// ── 七、样式 ───────────────────────────────────────────────────────────
console.log('\n[7] 样式');
for (const cls of ['music-tabs', 'music-tab', 'music-pl-grid', 'music-pl-card', 'music-pl-cover',
  'music-pl-head', 'music-pl-card-chat', 'music-pl-back', 'music-pl-new']) {
  t(`.${cls} 有样式`, new RegExp('\\.' + cls + '[\\s,.:{]').test(css));
}
// 写死颜色的话换主题时只有这几块不跟着变，看着像没加载完
const plCss = (css.match(/\.music-pl-[\s\S]*?$/) || [''])[0];
t('歌单样式走主题变量，没写死背景色', /var\(--/.test(plCss));

// ── 八、桌面与安卓副本一致 ─────────────────────────────────────────────
// android/assets 是 build.ps1 的产物，但仓库里存着一份。两份漂了的话，
// 手机上的行为跟电脑上不一样，而且没有任何报错。
console.log('\n[8] 桌面与安卓副本一致');
for (const f of ['js/24-music.js', 'js/01-core.js', 'js/02-state.js', 'js/14-boot-brain-hub.js',
  'js/12-math-media.js', 'css/grancyan.css']) {
  t(`android 副本与 ${f} 一致`, read(f) === read('android/assets/' + f));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试自己炸了:', e); process.exit(1); });
