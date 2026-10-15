'use strict';
/* 点歌：从网易云账号导入「喜欢的音乐」和自建歌单
 *
 * 两半：
 *   [S] server/music.js 的两条路由——axios 换成假的网易云，验「只要她自己建的」
 *       「顺序跟 trackIds 走」「匿名只给几首详情时其余靠 song/detail 补」「昵称不精确就不猜」。
 *   [F] 24-music.js 的合并——两个真沙箱当电脑和手机，中间夹假云端，验导入后同步收敛、
 *       再导一次不重复、这边删掉的不被导入复活。
 * 静默失败的样子：歌单里顺序乱了、同一个歌单出现两份、删了的收藏过一会儿又回来。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const music = fs.readFileSync(path.join(root, 'js/24-music.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

// ── [S] 假网易云 ──
const UID = '1234567890';
const tracks = n => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, at: 1700000000000 + (n - i) * 1000 }));   // 新喜欢的在前
const fakeSong = id => ({ id, name: '歌' + id, ar: [{ name: '甲' }, { name: '乙' }], al: { picUrl: 'http://p1.music.126.net/x/' + id + '.jpg' } });
const NE = {
  users: [{ userId: 1, nickname: '测试用户的粉丝' }, { userId: +UID, nickname: '测试用户' }],
  playlists: [
    { id: 55, name: '最新建的', trackCount: 1, specialType: 0, creator: { userId: +UID, nickname: '测试用户' }, coverImgUrl: '' },
    { id: 11, name: '测试用户喜欢的音乐', trackCount: 5, specialType: 5, creator: { userId: +UID, nickname: '测试用户' }, coverImgUrl: 'http://p1/c11.jpg' },
    { id: 22, name: '梦核', trackCount: 3, specialType: 0, creator: { userId: +UID, nickname: '测试用户' }, coverImgUrl: 'http://p1/c22.jpg' },
    { id: 33, name: '别人的歌单', trackCount: 9, specialType: 0, creator: { userId: 777 }, coverImgUrl: '' },
  ],
  detail: {
    11: { name: '测试用户喜欢的音乐', trackIds: tracks(5), tracks: [fakeSong(1000)] },
    55: { name: '最新建的', trackIds: [{ id: 5555, at: 1 }], tracks: [fakeSong(5555)] },
    22: { name: '梦核', description: '怪', trackIds: [{ id: 2003, at: 5 }, { id: 2001, at: 6 }, { id: 2002, at: 7 }, { id: 2999, at: 8 }], tracks: [] },
  },
  calls: [], all: [],
};
const axios = require(require.resolve('axios', { paths: [root] }));
const realGet = axios.get, realPost = axios.post;
axios.get = async (url, cfg) => {
  NE.calls.push(['get', url, cfg && cfg.params, cfg && cfg.proxy]);
  NE.all.push([url, cfg && cfg.proxy]);
  const p = (cfg && cfg.params) || {};
  if (url.endsWith('/api/cloudsearch/pc')) return { data: { result: { userprofiles: NE.users.filter(u => u.nickname.includes(p.s)) } } };
  if (url.endsWith('/api/user/playlist')) return { data: { code: 200, playlist: NE.playlists } };
  if (url.endsWith('/api/v6/playlist/detail')) {
    const d = NE.detail[p.id];
    return { data: d ? { code: 200, playlist: d } : { code: 401 } };
  }
  throw new Error('没料到的 GET ' + url);
};
axios.post = async (url, body, cfg) => {
  NE.calls.push(['post', url, body]);
  NE.all.push([url, cfg && cfg.proxy]);
  if (url.endsWith('/api/v3/song/detail')) {
    const want = JSON.parse(decodeURIComponent(String(body).replace(/^c=/, ''))).map(x => x.id);
    // 故意倒着回、而且 2999 当成下架到连元数据都没了
    return { data: { songs: want.filter(id => id !== 2999).reverse().map(fakeSong) } };
  }
  throw new Error('没料到的 POST ' + url);
};
const routes = {};
require(path.join(root, 'server/music.js')).mount({ get: (p, fn) => { routes[p] = fn; }, post() {} }, { agent: {} });
function call(p, query) {
  return new Promise(ok => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { ok({ code: this.code, body: b }); } };
    routes[p]({ query }, res);
  });
}

// ── [F] 设备沙箱（同 music-sync.test.js）──
function device(fetchImpl, ask) {
  const box = {
    state: {}, _saves: 0, _toasts: [], save() { box._saves++; }, showToast(m, k) { box._toasts.push([k, m]); },
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set, Promise, Infinity,
    Float32Array, Int32Array, Uint8Array, Int8Array, encodeURIComponent,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _panel: { innerHTML: '' },
    document: {
      getElementById: id => id === 'musicBody' ? box._panel : id === 'musicModal' ? { classList: { contains: () => false, toggle() {} }, style: { setProperty() {}, removeProperty() {} } } : null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); } },
    setTimeout: fn => { fn(); return 0; }, setInterval() {}, addEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    Audio: function () { this.addEventListener = () => {}; }, Image: function () {}, navigator: { userAgent: 'node' },
    prompt: () => null, confirm: () => true, appPrompt: ask || (async () => null),
    fetch: fetchImpl || (async () => { throw new Error('没接 fetch'); }),
    SERVER_BASE: 'http://pc:3000',
    MUSIC_LYRIC_STYLES: ['scroll', 'tilt', 'cinema'], MUSIC_VIS_MODES: ['aurora', 'fluid', 'geo', 'off'],
    musicLyricStyleNorm: s => s || 'scroll',
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(music, box);
  return box;
}
function push(dev, cloud) {
  const r = dev.musicSyncApply(cloud.s);
  cloud.s = Object.assign({}, cloud.s, JSON.parse(JSON.stringify(r.payload)));
  return r;
}
function pull(dev, cloud) { return dev.musicSyncApply(JSON.parse(JSON.stringify(cloud.s))); }
const ids = arr => (arr || []).map(x => String(x.id));
const ne = (id, at) => ({ id, name: '歌' + id, artist: 'x', cover: 'https://c/' + id, at });

// 把 server 路由直接当 fetch 用：前端拿到的就是后端真吐出来的东西
async function routeFetch(url) {
  const u = new URL(url);
  const r = await call(u.pathname, Object.fromEntries(u.searchParams));
  return { ok: r.code < 400, status: r.code, json: async () => JSON.parse(JSON.stringify(r.body)) };
}

async function main() {
  console.log('\n[S1] 用户：昵称精确匹配、只回她自己建的、认出「喜欢的音乐」、不走代理');
  {
    const r = await call('/api/music/netease/user', { q: '测试用户' });
    t('找到的是昵称完全一致的那个（不是排在前面的粉丝号）', r.code === 200 && r.body.user.id === UID, r.body);
    t('别人建的歌单不在里面', r.body.playlists.map(p => p.id).join() === '55,11,22', r.body.playlists);
    t('喜欢的音乐标了 liked，普通歌单没标', r.body.playlists[1].liked === true && r.body.playlists[2].liked === false);
    t('封面改成 https 并带尺寸', r.body.playlists[2].cover === 'https://p1/c22.jpg?param=240y240', r.body.playlists[2].cover);
    const miss = await call('/api/music/netease/user', { q: '测试用' });
    t('昵称不精确 → 404 并给出像的，不瞎猜一个', miss.code === 404 && miss.body.near.length === 2, miss);
    const byId = await call('/api/music/netease/user', { q: UID });
    t('直接给 uid 也行，昵称从歌单创建者上取', byId.code === 200 && byId.body.user.nickname === '测试用户', byId.body.user);
  }

  console.log('\n[S2] 歌单：顺序跟 trackIds、详情缺的批量补、带 at、下架的跳过');
  {
    const r = await call('/api/music/netease/playlist', { id: '22' });
    t('顺序和网易云一样（song/detail 倒着回也不影响）', ids(r.body.songs).join() === '2003,2001,2002', ids(r.body.songs));
    t('连元数据都没了的那首跳过', !ids(r.body.songs).includes('2999'));
    t('每首带着加入时间 at', r.body.songs.map(s => s.at).join() === '5,6,7', r.body.songs);
    t('歌手拼成 甲/乙、封面 https', r.body.songs[0].artist === '甲/乙' && /^https:.*\?param=200y200$/.test(r.body.songs[0].cover), r.body.songs[0]);
    t('简介带回来了', r.body.desc === '怪');
    NE.calls.length = 0;
    const big = Array.from({ length: 1234 }, (_, i) => ({ id: 5000 + i, at: i }));
    NE.detail[44] = { name: '大', trackIds: big, tracks: [fakeSong(5000)] };
    const b = await call('/api/music/netease/playlist', { id: '44' });
    const posts = NE.calls.filter(c => c[0] === 'post');
    t('1233 首缺详情 → 分 3 批补（每批 ≤500）', posts.length === 3, posts.length);
    t('1234 首一首不少', b.body.songs.length === 1234, b.body.songs.length);
    const priv = await call('/api/music/netease/playlist', { id: '99' });
    t('网易云不给（隐私）→ 403 并说要登录', priv.code === 403 && /登录/.test(priv.body.error), priv);
    const bad = await call('/api/music/netease/playlist', { id: '1;drop' });
    t('id 不是数字直接 400', bad.code === 400);
    const kinds = new Set(NE.all.map(c => c[0].replace(/^.*\/api\//, '')));
    t('搜用户/列歌单/歌单详情/歌曲详情四种请求全都 proxy:false（走代理网易云就不给东西）',
      kinds.size === 4 && NE.all.every(c => c[1] === false), NE.all.filter(c => c[1] !== false).map(c => c[0]));
  }

  console.log('\n[F1] 喜欢的音乐 → 收藏：按喜欢时间排、和原有收藏交错、再导一次不重复');
  {
    const A = device();
    A.musicToggleFav({ id: 1, name: '原有', artist: 'y', cover: '' });     // 这边自己收藏的，时间是现在
    const n = A.musicNeteaseMergeFav([ne(10, 3000), ne(11, 2000), ne(12, 1000)]);
    t('三首都进来了', n === 3, n);
    t('原有那首最新排最前，导入的按喜欢时间新→旧', ids(A.state.musicFav).join() === '1,10,11,12', ids(A.state.musicFav));
    t('收藏时间就是网易云的喜欢时间', A.state.musicFav[1].ts === 3000, A.state.musicFav[1]);
    t('存进去的只有五个字段（at 不跟进 IndexedDB）', Object.keys(A.state.musicFav[1]).sort().join() === 'artist,cover,id,name,ts', Object.keys(A.state.musicFav[1]));
    t('再导一次：0 首', A.musicNeteaseMergeFav([ne(10, 3000), ne(11, 2000), ne(12, 1000)]) === 0);
    t('id 数字/字符串混着来也不重复', A.musicNeteaseMergeFav([ne('10', 3000)]) === 0);
    const B = device();
    B.state.musicFav = [{ id: 5, name: '中间那首', artist: '', cover: '', ts: 2500 }];
    B.musicNeteaseMergeFav([ne(10, 3000), ne(12, 1000)]);
    t('和原有收藏按时间交错（本地马上就是这个顺序，不用等同步）', ids(B.state.musicFav).join() === '10,5,12', ids(B.state.musicFav));
  }

  console.log('\n[F2] 这边取消过的收藏：比网易云那次喜欢晚 → 不复活；早 → 回来');
  {
    const A = device();
    A.musicToggleFav({ id: 20, name: 'a', artist: '', cover: '' }); A.musicToggleFav({ id: 20 });   // 现在取消的
    const n1 = A.musicNeteaseMergeFav([ne(20, 1000)]);
    t('在这边亲手删的（删得比喜欢晚）不被导入复活', n1 === 0 && !ids(A.state.musicFav).includes('20'), ids(A.state.musicFav));
    const late = Date.now() + 10 * 60 * 1000;                                                         // 之后又在网易云里重新喜欢了
    const n2 = A.musicNeteaseMergeFav([ne(20, late)]);
    t('网易云里后来又喜欢了 → 回来', n2 === 1 && ids(A.state.musicFav).includes('20'));
  }

  console.log('\n[F3] 同步：电脑导完，手机同步后一样；两边都判等收敛，没有来回抖');
  {
    const cloud = { s: {} };
    const A = device(), B = device();
    B.musicToggleFav({ id: 99, name: '手机上收的', artist: '', cover: '' });
    push(B, cloud);
    const likes = Array.from({ length: 300 }, (_, i) => ne(3000 + i, 1700000000000 - i * 1000));
    A.musicNeteaseMergeFav(likes);
    const pl = A.musicNeteaseMergeList({ id: 22, name: '梦核', desc: '怪', cover: 'https://c', songs: [ne(2003), ne(2001), ne(2002)] });
    push(A, cloud); pull(B, cloud);
    t('手机收藏 = 手机那首 + 300 首', B.state.musicFav.length === 301, B.state.musicFav.length);
    t('手机上的收藏顺序和电脑合并后一样', ids(B.state.musicFav).join() === ids(A.state.musicFav).join());
    const bl = B.state.musicPlaylists.find(p => p.id === 'ne_22');
    t('手机上有 ne_22 这个歌单，顺序和网易云一样', bl && ids(bl.songs).join() === '2003,2001,2002', bl && ids(bl.songs));
    t('歌单名/简介/封面带过来了', bl && bl.name === '梦核' && bl.desc === '怪' && bl.cover === 'https://c');
    const r1 = push(A, cloud), r2 = pull(B, cloud), r3 = push(B, cloud);
    t('再来一轮：两边都没变化（收敛）', !r1.changed && !r2.changed && !r3.changed, [r1.changed, r2.changed, r3.changed]);
    t('导入那台第一次合并后本地也不用改（本地排序 = 合并排序）', pl.created === true);
  }

  console.log('\n[F4] 歌单再导一次：同一个歌单补新歌、不重建、这边删的不补、这边改的名不被盖');
  {
    const A = device();
    A.musicNeteaseMergeList({ id: 22, name: '梦核', songs: [ne(1), ne(2), ne(3)] });
    const p = A.state.musicPlaylists.find(x => x.id === 'ne_22');
    p.name = '我改的名';
    A.musicPlaylistRemoveSong('ne_22', 1);                       // 删掉 2
    const m = A.musicNeteaseMergeList({ id: 22, name: '梦核', songs: [ne(1), ne(2), ne(3), ne(4)] });
    t('没冒出第二个歌单', A.state.musicPlaylists.filter(x => x.id === 'ne_22').length === 1 && m.created === false);
    t('只补了新的那首 4；删掉的 2 没回来', m.n === 1 && ids(p.songs).join() === '1,3,4', ids(p.songs));
    t('她改的名字没被网易云的盖掉', p.name === '我改的名');
    A.musicPlaylistDelete('ne_22');
    const m2 = A.musicNeteaseMergeList({ id: 22, name: '梦核', songs: [ne(1)] });
    const cloud = { s: {} }; push(A, cloud);
    t('歌单删了再导 = 主动要回来：重建，而且同步后是活的', m2.created && (cloud.s.musicPlaylists || []).some(x => x.id === 'ne_22'), cloud.s.musicPlaylists);
  }

  console.log('\n[F5] 整条导入：真路由当后端，按钮点下去的效果');
  {
    const urls = [];
    const A = device(async u => { urls.push(u); return routeFetch(u); }, async () => '测试用户');
    A.GrancyanBand = {};             // 装成在安卓 App 里：这时 musicApiBase() 指向手机自带的 localhost:8080
    await A.musicNeteaseImport();
    t('在安卓 App 里也走电脑 server（自带代理没有这两条路由）', urls.length === 4 && urls.every(u => u.startsWith('http://pc:3000/api/music/netease/')), urls);
    t('喜欢的 5 首进了收藏', A.state.musicFav.length === 5, ids(A.state.musicFav));
    t('建了两个歌单、顺序和网易云一样（新建的在前），喜欢的音乐没被当成歌单', A.state.musicPlaylists.map(p => p.name).join() === '最新建的,梦核', A.state.musicPlaylists.map(p => p.name));
    t('记住了昵称，下次默认填它', A.localStorage.getItem('gc_music_ne_user') === '测试用户');
    t('收尾报了成功数', A._toasts.some(([k, m]) => k === 'success' && /收藏 \+5 首，新歌单 2 个/.test(m)), A._toasts.slice(-1));
    await A.musicNeteaseImport();
    t('再点一次：什么都不多', A.state.musicFav.length === 5 && A.state.musicPlaylists.length === 2 && A._toasts.some(([, m]) => /收藏 \+0 首，新歌单 0 个，歌单里 \+0 首/.test(m)));
    const B = device(async () => { throw new TypeError('Failed to fetch'); }, async () => 'x');
    await B.musicNeteaseImport();
    t('电脑没开：报错并提示要连电脑，不假装成功', B._toasts.some(([k, m]) => k === 'error' && /电脑/.test(m)), B._toasts);
    let sent = 0;
    const C = device(async () => { sent++; throw new Error('不该发'); }, async () => null);
    await C.musicNeteaseImport();
    t('取消输入框：一个请求都不发、不弹错', sent === 0 && C._toasts.length === 0, C._toasts);
  }

  console.log('\n[F6] 收藏页一次画上千行：心形判定不逐行扫收藏');
  {
    const A = device();
    A.musicNeteaseMergeFav(Array.from({ length: 1500 }, (_, i) => ne(i + 1, i + 1)));
    let scans = 0;
    const orig = A._mFavs;
    A._mFavs = function () { scans++; return orig(); };
    vm.runInContext('_mTab = "fav"', A);
    const h = A.musicSectionsHtml();
    const scansOne = scans;
    const rows = x => (x.match(/music-fav on/g) || []).length;
    t('1500 首只先画 200 行，全是实心，底下有「再显示」', rows(h) === 200 && /再显示 300 首（共 1500 首）/.test(h), rows(h));
    t('续一段 → 500 行；普通重画（切歌/点心）不把它截回去', (A._mMoreRows(), rows(A.musicSectionsHtml())) === 500);
    t('点第 450 行播的是第 450 首（下标没因为分段错位）', /musicPlayFav\(449\)/.test(A.musicSectionsHtml()));
    A.musicSetTab('lists'); A.musicSetTab('fav');
    t('切页签再回来：归位到 200 行', rows(A.musicSectionsHtml()) === 200);
    const pl = A.musicNeteaseMergeList({ id: 9, name: '大歌单', songs: Array.from({ length: 910 }, (_, i) => ne(i + 1)) });
    A.musicSetTab('lists'); A.musicOpenList(pl.p.id);
    const dh = A.musicSectionsHtml();
    t('910 首的歌单详情也分段', (dh.match(/musicPlaylistPlaySong/g) || []).length === 400 && /共 910 首/.test(dh), (dh.match(/musicPlaylistPlaySong/g) || []).length);
    let more = 0; const el = { scrollTop: 900, clientHeight: 500, scrollHeight: 1600, querySelector: () => ({}) };
    const om = A._mMoreRows; A._mMoreRows = () => { more++; };
    A._mDrawerScroll(el); el.scrollTop = 0; A._mDrawerScroll(el); el.scrollTop = 900; el.querySelector = () => null; A._mDrawerScroll(el);
    A._mMoreRows = om;
    t('滚到离底 300 以内才自动续；没有更多了就不续', more === 1, more);
    t('一次重画只取了几次收藏表（不是每行一次）', scansOne < 10, scansOne);
  }

  axios.get = realGet; axios.post = realPost;
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
