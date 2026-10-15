'use strict';
// 点歌：在收藏 / 歌单里找歌 + 列表行上的 ＋ 改成小菜单（用户）
//
// 守的都是静默失效：
//   · 筛出来的行点下去放错歌（onclick 用了筛选后的下标，而 musicPlayFav / musicPlaylistPlaySong 认的是原列表下标）
//   · 中文输入法拼到一半就开始筛 / 整面板重画 → 拼音被吞
//   · 筛到一半切歌，整面板重画把光标弄丢
//   · 行上的 ＋ 又退回「列出全部歌单让她填序号」的大弹窗
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

const music = read('js/24-music.js');
const css = read('css/grancyan.css');

function sandbox() {
  const els = { musicBody: { innerHTML: '' }, mzLqRows: { innerHTML: '' }, mzDrawerBody: { scrollTop: 500 } };
  const box = {
    state: {},
    save: () => {},
    showToast: () => {},
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    renderMessages: () => {},
    _els: els,
    document: {
      getElementById: id => id === 'musicModal' ? { classList: { contains: () => false } } : (els[id] || null),
      querySelector: sel => (sel === '#musicModal .mz-panel' && box._host) ? {} : null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({})
    },
    confirm: () => true,
    setTimeout: () => {}, setInterval: () => {}, addEventListener: () => {}, requestAnimationFrame: () => {},
    Audio: function () { this.addEventListener = () => {}; },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node' },
    Math, Date, JSON, console, RegExp, Object, Array, String, Number, Boolean, Set, Promise
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(music, box);
  // 函数声明会盖掉字面量里的同名属性，mock 必须放在加载之后
  box.musicRefresh = () => { box._refreshed = (box._refreshed || 0) + 1; };
  box.musicPlay = s => { box._played = s; };
  box._mPop = (anchor, title, items) => { box._pop = { anchor, title, items }; };
  box.appPrompt = (msg) => { box._asked = msg; return Promise.resolve(null); };
  return box;
}

const S = (id, name, artist) => ({ id, name, artist: artist || '', cover: '' });
const favs = () => [S(1, '夜曲', '周杰伦'), S(2, '晴天', '周杰伦'), S(3, 'Remedy', 'RealSounds'),
  S(4, '晚安喵', '艾索'), S(5, '夜、萤火虫和你', 'AniFace'), ...Array.from({ length: 10 }, (_, i) => S(100 + i, '填充' + i, 'X'))];

console.log('\n[1] 筛选本身');
{
  const b = sandbox();
  b.state.musicFav = favs();
  b._mListQ = '';
  t('没输东西 → 全部都在，下标原样', b._mListQMatch(b.state.musicFav).length === 15);
  b._mListQ = '周杰伦';
  t('按歌手筛', b._mListQMatch(b.state.musicFav).map(([s]) => s.id).join() === '1,2');
  b._mListQ = '夜 周杰伦';
  t('几个词＝都得对上', b._mListQMatch(b.state.musicFav).map(([s]) => s.id).join() === '1');
  b._mListQ = 'remedy';
  t('不分大小写', b._mListQMatch(b.state.musicFav).map(([s]) => s.id).join() === '3');
  b._mListQ = '夜萤火虫';
  t('标点/空白归一（「夜、萤火虫」打「夜萤火虫」也找得到）', b._mListQMatch(b.state.musicFav).map(([s]) => s.id).join() === '5');
  b._mListQ = '晚安喵';
  t('★ 带回来的是原列表里的下标，不是筛完后的第几个', b._mListQMatch(b.state.musicFav)[0][1] === 3);
}

console.log('\n[2] 收藏页：筛出来点哪首放哪首');
{
  const b = sandbox();
  b.state.musicFav = favs();
  b._mTab = 'fav';
  b._mListQ = '晚安';
  const h = b._mFavRows();
  t('只画了对上的那首', h.includes('晚安喵') && !h.includes('夜曲'));
  t('写了找到几首', h.includes('找到 1 首'));
  const m = h.match(/musicPlayFav\((\d+)\)/);
  t('★ 行上的 onclick 用原下标 3', m && m[1] === '3', m && m[1]);
  b.musicPlayFav(+m[1]);
  t('真点下去放的就是晚安喵', b._played && b._played.name === '晚安喵', b._played);
  b._mListQ = '没有这首';
  t('一首都没对上 → 说一声，不是空白', b._mFavRows().includes('这里没有'));
  b._mListQ = '';
  t('搜索框只在 ≥10 首时出现', b._mRenderFav().includes('id="musicListQ"'));
  b.state.musicFav = favs().slice(0, 3);
  t('三首就不摆搜索框', !b._mRenderFav().includes('id="musicListQ"'));
}

console.log('\n[3] 歌单详情：筛出来点哪首放哪首、删哪首');
{
  const b = sandbox();
  b.state.musicPlaylists = [{ id: 'p1', name: '深夜', desc: '', cover: '', songs: favs(), ts: 1, by: 'me', sops: {} }];
  b._mTab = 'lists'; b._mViewList = 'p1';
  b._mListQ = 'remedy';
  const h = b._mListRows(b._mListById('p1'));
  const m = h.match(/musicPlaylistPlaySong\('p1',(\d+)\)/), rm = h.match(/musicPlaylistRemoveSong\('p1',(\d+)\)/);
  t('★ 播放用原下标 2', m && m[1] === '2', m && m[1]);
  t('★ 删除也用原下标 2（错了会删掉别的歌）', rm && rm[1] === '2', rm && rm[1]);
  b.musicPlaylistRemoveSong('p1', +rm[1]);
  t('真删掉的是 Remedy', !b._mListById('p1').songs.some(s => s.name === 'Remedy') && b._mListById('p1').songs.length === 14);
  t('详情页有搜索框', b._mRenderListDetail(b._mListById('p1')).includes('id="musicListQ"'));
  b.musicOpenList('p1');
  t('换个歌单打开 → 框清空', b._mListQ === '');
}

console.log('\n[4] 打字');
{
  const b = sandbox();
  b.state.musicFav = favs();
  b._mTab = 'fav';
  b._mRowCap = 800;
  b._mListQInput({ isComposing: true, target: { value: 'ye' } });
  t('★ 组字中、拼音字母一首都对不上 → 列表先不动（不闪「没有」）', b._mListQ === '' && b._els.mzLqRows.innerHTML === '');
  b._mListQInput({ isComposing: true, target: { value: 'rem' } });
  t('★ 组字中但对得上 → 照样筛（安卓 Gboard 打英文一直挂着组字，等上屏的话手机上就不动了）',
    b._mListQ === 'rem' && b._els.mzLqRows.innerHTML.includes('Remedy') && !b._els.mzLqRows.innerHTML.includes('夜曲'));
  b._mListQInput({ target: { value: '晴天' } });
  t('上屏了就筛，只换行区', b._mListQ === '晴天' && b._els.mzLqRows.innerHTML.includes('晴天') && !b._els.mzLqRows.innerHTML.includes('夜曲'));
  t('★ 打字不整面板重画（重画会把输入框换掉）', !b._refreshed);
  t('分段画的行数归位、滚回顶上', b._mRowCap === 200 && b._els.mzDrawerBody.scrollTop === 0);
  t('compositionend 也接着筛', /oncompositionend="_mListQInput\(event\)"/.test(music));
  const ev = { key: 'Escape', target: { value: '晴天' }, preventDefault() {}, stopPropagation() { this.stopped = true; } };
  b._mListQKey(ev);
  t('Esc 先清框，不往外冒去关面板', ev.target.value === '' && ev.stopped && b._mListQ === '');
  const ev2 = { key: 'Escape', target: { value: '' }, preventDefault() {}, stopPropagation() { this.stopped = true; } };
  b._mListQKey(ev2);
  t('框里已经空了 → Esc 照常往外冒', !ev2.stopped);
}

console.log('\n[5] 整面板重画时把光标还回去');
{
  const rf = music.slice(music.indexOf('function musicRefresh('), music.indexOf('\nfunction musicPlayLast('));
  const iBefore = rf.indexOf("document.getElementById('musicListQ')"), iPaint = rf.indexOf('body.innerHTML = h;');
  t('重画前记下光标（必须在 innerHTML 之前，之后框已经是新的了）', iBefore > 0 && iBefore < iPaint, { iBefore, iPaint });
  t('重画后还回去', /lq2\.focus\([^)]*\);\s*lq2\.setSelectionRange\(lqSel\[0\], lqSel\[1\]\)/.test(rf.slice(iPaint)));
}

console.log('\n[6] 行上的 ＋：小菜单，不是填序号');
{
  const b = sandbox();
  b.state.musicPlaylists = [{ id: 'a', name: '好听的歌', songs: [], ts: 1, sops: {} }, { id: 'b', name: '梦核', songs: [S(9, 'x')], ts: 1, sops: {} }];
  b._host = true;
  const anchor = {};
  b.musicAddToPlaylist(S(9, 'JEREMIAD'), anchor);
  t('★ 有按钮可挂 → 弹小菜单', b._pop && b._pop.anchor === anchor && !b._asked, b._asked);
  const items = (b._pop && b._pop.items) || [];
  t('菜单里每个歌单一行 + 新建', items.length === 3 && items[2].label.includes('新建'));
  t('已经在里面的那个歌单标灰', items.length === 3 && items[1].dim === true && items[0].dim === false);
  if (items[0]) items[0].fn();
  t('点一下就放进去了', b._mListById('a').songs.some(s => s.id === 9));
  b._pop = null; b._host = false;
  b.musicAddToPlaylist(S(9, 'JEREMIAD'));
  t('没按钮可挂的调用方 → 还是老的填序号兜底', !b._pop && /填序号/.test(b._asked || ''));
  t('收藏页的 ＋ 把按钮自己传进去', /musicAddToPlaylist\(_mFavs\(\)\[\$\{i\}\],this\)/.test(music));
  t('搜索页的 ＋ 把按钮自己传进去', /musicAddFromList\(\$\{i\},this\)/.test(music));
}

console.log('\n[7] 样式 + 安卓副本');
t('.mz-lq 有样式', /\.mz-drawer \.mz-lq \{/.test(css));
for (const f of ['js/24-music.js', 'css/grancyan.css']) {
  t(`android 副本与 ${f} 一致`, read(f) === read('android/assets/' + f));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
