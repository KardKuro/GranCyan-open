'use strict';
/* 点歌：手机 ↔ 电脑同步（收藏 / 最近播放 / 搜索记录 / 歌单）——用户要的
 *
 * 云端设置是整包 upsert「最后写入者赢」，这四样必须按条合并、删除留墓碑。
 * 坏了不报错，症状是「另一台上收藏的歌没过来」「删掉的收藏自己又回来了」，
 * 所以这里起两个真沙箱当两台设备，中间夹一个假云端，按真实的推/拉顺序走。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const music = read('js/24-music.js');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

// 一台设备。clockSkew：这台的 Date.now() 比真实时间快/慢多少毫秒
function device(clockSkew) {
  const RealDate = Date;
  const FakeDate = function (...a) { return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + (clockSkew || 0)); };
  FakeDate.now = () => RealDate.now() + (clockSkew || 0);
  const box = {
    state: {}, _saves: 0, save() { box._saves++; }, showToast() {}, console, Math, Date: FakeDate, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set, Promise, Infinity,
    Float32Array, Int32Array, Uint8Array, Int8Array,
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _panel: { innerHTML: '' }, _inp: null,
    document: {
      getElementById: id => id === 'musicBody' ? box._panel : id === 'musicModal' ? { classList: { contains: () => false, toggle() {} }, style: { setProperty() {}, removeProperty() {} } } : id === 'musicSearchIn' ? box._inp : null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fn => { fn(); return 0; }, setInterval() {}, addEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    Audio: function () { this.addEventListener = () => {}; }, Image: function () {}, navigator: { userAgent: 'node' },
    prompt: () => null, confirm: () => true,
    MUSIC_LYRIC_STYLES: ['scroll', 'tilt', 'cinema'], MUSIC_VIS_MODES: ['aurora', 'fluid', 'geo', 'off'],
    musicLyricStyleNorm: s => s || 'scroll',
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(music, box);
  return box;
}
// 假云端 = 一份 settings。push 走的是 syncSettingsToCloud 的真实顺序：先读云端、合并、再整包写回
function makeCloud() { return { s: {} }; }
function push(dev, cloud) {
  const r = dev.musicSyncApply(cloud.s);
  cloud.s = Object.assign({}, cloud.s, JSON.parse(JSON.stringify(r.payload)));   // 过一遍 JSON，和真上云一样
  return r;
}
function pull(dev, cloud) { return dev.musicSyncApply(JSON.parse(JSON.stringify(cloud.s))); }
const ids = arr => (arr || []).map(x => String(x.id));
const S = (id, name) => ({ id, name: name || '歌' + id, artist: 'x', cover: '' });

async function main() {
console.log('\n[1] 收藏：一台加、另一台看得到；删了不复活；删了再加能回来');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  A.musicToggleFav(S(1)); A.musicToggleFav(S(2));
  push(A, cloud); pull(B, cloud);
  t('电脑收藏的两首，手机同步后都有', ids(B.state.musicFav).sort().join() === '1,2', ids(B.state.musicFav));
  B.musicToggleFav(S(1));                       // 手机上取消收藏 1
  push(B, cloud);
  // 电脑这时还拿着旧的那份（有 1），它一推送就是「整包最后写入者赢」的事故现场
  push(A, cloud);
  t('电脑拿着旧副本推送后：手机删掉的那首没被复活（云端）', ids(cloud.s.musicFav).join() === '2', ids(cloud.s.musicFav));
  t('电脑本机也跟着删掉了', ids(A.state.musicFav).join() === '2', ids(A.state.musicFav));
  pull(B, cloud);
  t('手机再拉一次也还是没有', ids(B.state.musicFav).join() === '2');
  A.musicToggleFav(S(1));                       // 电脑上重新收藏
  push(A, cloud); pull(B, cloud);
  t('删了再收藏：两台都回来了', ids(B.state.musicFav).sort().join() === '1,2' && ids(A.state.musicFav).sort().join() === '1,2');
  t('新收藏的排在最前', ids(B.state.musicFav)[0] === '1', ids(B.state.musicFav));
}

console.log('\n[2] 老数据（同步上线前的收藏/歌单，没有加删时间表）第一次同步不丢');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  A.state.musicFav = [{ id: 10, name: 'a', artist: '', cover: '', ts: 1000 }, { id: 11, name: 'b', artist: '', cover: '', ts: 900 }];
  B.state.musicFav = [{ id: 20, name: 'c', artist: '', cover: '', ts: 950 }];
  // 歌的顺序故意和 id 大小不一致：按 id 排的话一眼就乱了
  A.state.musicPlaylists = [{ id: 'pl_old', name: '老歌单', desc: '', cover: '', ts: 500, by: 'me', songs: [S(30), S(1), S(200)] }];
  push(A, cloud); push(B, cloud); pull(A, cloud);
  t('两台各自的老收藏合成一份，谁也没丢', ids(A.state.musicFav).join() === '10,20,11' && ids(B.state.musicFav).join() === '10,20,11', [ids(A.state.musicFav), ids(B.state.musicFav)]);
  const pb = B.state.musicPlaylists[0];
  t('电脑的老歌单到了手机，歌的顺序没乱', pb && pb.name === '老歌单' && ids(pb.songs).join() === '30,1,200', pb && ids(pb.songs));
  t('电脑本机的老歌单顺序也没被合并打乱', ids(A.state.musicPlaylists[0].songs).join() === '30,1,200');
}

console.log('\n[3] 最近播放：两台放过的合在一起，按时间排，最多 30 首');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  for (let i = 0; i < 20; i++) A.musicNoteRecent(S('a' + i));
  // A 在同一毫秒里连记 20 首，逻辑钟会跑到「现在 + 20ms」；B 还没同步过、不知道这件事。
  // 真实里两台放歌至少隔几秒，这里等 50ms 让 B 真的「后放」，不然谁新谁旧看运气
  await new Promise(r => setTimeout(r, 50));
  for (let i = 0; i < 20; i++) B.musicNoteRecent(S('b' + i));
  push(A, cloud); push(B, cloud); pull(A, cloud);
  const r = A.state.musicRecent;
  t('合并后正好 30 首', r.length === 30, r.length);
  t('最新放的那首在最前（手机最后放的 b19）', String(r[0].id) === 'b19', ids(r).slice(0, 3));
  t('按时间从新到旧', r.every((x, i) => !i || r[i - 1].ts >= x.ts));
  A.musicNoteRecent(S('a0'));
  push(A, cloud); pull(B, cloud);
  t('电脑又放了一遍 a0：手机上它顶到最前，不是多一条', String(B.state.musicRecent[0].id) === 'a0' && B.state.musicRecent.filter(x => String(x.id) === 'a0').length === 1);
}

console.log('\n[4] 搜索记录：记、去重、删单条、清空，都能传过去');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  A.musicSearchNote('晴天'); A.musicSearchNote('稻香'); A.musicSearchNote(' 晴天 ');
  t('同一个词再搜是顶到最前，不是多一条', A.state.musicSearchHist.map(x => x.q).join() === '晴天,稻香', A.state.musicSearchHist);
  push(A, cloud); pull(B, cloud);
  t('手机看得到电脑搜过的', B.state.musicSearchHist.map(x => x.q).join() === '晴天,稻香');
  B.musicSearchForget(1);                          // 手机上删掉「稻香」
  push(B, cloud); push(A, cloud);
  t('手机删的那条，电脑推旧副本后也没复活', A.state.musicSearchHist.map(x => x.q).join() === '晴天' && cloud.s.musicSearchHist.map(x => x.q).join() === '晴天');
  B.musicSearchNote('七里香');
  A.musicSearchClearHist();                        // 电脑清空（这时还不知道手机新搜的七里香）
  push(A, cloud); push(B, cloud); pull(A, cloud);
  t('电脑清空后：它见过的都没了，手机后来新搜的「七里香」留着', A.state.musicSearchHist.map(x => x.q).join() === '七里香' && B.state.musicSearchHist.map(x => x.q).join() === '七里香', [A.state.musicSearchHist, B.state.musicSearchHist]);
  for (let i = 0; i < 25; i++) A.musicSearchNote('词' + i);
  push(A, cloud); pull(B, cloud);
  t('最多留 20 条', A.state.musicSearchHist.length === 20 && B.state.musicSearchHist.length === 20);
}

console.log('\n[5] 歌单：新建、改名、删歌单、两边同时加删歌');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  const p = A.musicPlaylistCreate('夜里听', '', 'me');
  A.musicPlaylistAdd(p.id, S(1)); A.musicPlaylistAdd(p.id, S(2)); A.musicPlaylistAdd(p.id, S(3));
  push(A, cloud); pull(B, cloud);
  const pb = () => B.state.musicPlaylists.find(x => x.id === p.id);
  t('电脑建的歌单到了手机', pb() && pb().name === '夜里听' && ids(pb().songs).join() === '1,2,3');
  // 两边同时：电脑加一首 4，手机删掉 2
  A.musicPlaylistAdd(p.id, S(4));
  B.musicPlaylistRemoveSong(p.id, 1);
  push(A, cloud); push(B, cloud); pull(A, cloud);
  const pa = A.state.musicPlaylists.find(x => x.id === p.id);
  t('两边同时改：加的 4 在、删的 2 没了（两台一样）', ids(pa.songs).join() === '1,3,4' && ids(pb().songs).join() === '1,3,4', [ids(pa.songs), ids(pb().songs)]);
  // 改名：手机后改，赢
  // 改名走真函数（_mAsk 在沙箱里接不到输入框，换成直接给答案）
  A._mAsk = async () => '电脑改的'; B._mAsk = async () => '手机后改的';
  await A.musicPlaylistRename(p.id);
  push(A, cloud); pull(B, cloud);
  await B.musicPlaylistRename(p.id);
  push(B, cloud); pull(A, cloud);
  t('名字以后改的那次为准', A.state.musicPlaylists.find(x => x.id === p.id).name === '手机后改的');
  // 删了再加回同一首
  B.musicPlaylistRemoveSong(p.id, 0);
  push(B, cloud); pull(A, cloud);
  A.musicPlaylistAdd(p.id, S(1));
  push(A, cloud); pull(B, cloud);
  t('删掉的歌再加回来：排在最后、两台都有', ids(pb().songs).join() === '3,4,1', ids(pb().songs));
  // 删歌单：电脑删，手机拿着旧副本推送也不复活
  A.musicPlaylistDelete(p.id);
  push(A, cloud); push(B, cloud);
  t('删掉的歌单被旧副本推送后没复活', !cloud.s.musicPlaylists.some(x => x.id === p.id) && !B.state.musicPlaylists.some(x => x.id === p.id));
}

console.log('\n[6] 自定义封面：太大的不上云，另一台收到「不知道」也不会把自己的清掉');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  const p = A.musicPlaylistCreate('有封面', '', 'me');
  push(A, cloud); pull(B, cloud);
  const big = 'data:image/jpeg;base64,' + 'x'.repeat(70000);
  const small = 'data:image/jpeg;base64,' + 'y'.repeat(1000);
  const pa = A.state.musicPlaylists[0]; pa.cover = small; pa.mt = vm.runInContext('_mStamp()', A);
  push(A, cloud); pull(B, cloud);
  t('小封面跟着同步过去', B.state.musicPlaylists[0].cover === small);
  pa.cover = big; pa.mt = vm.runInContext('_mStamp()', A);
  push(A, cloud);
  t('大封面上云时是 null 占位', cloud.s.musicPlaylists[0].cover === null);
  t('电脑自己那张大封面还在', A.state.musicPlaylists[0].cover === big);
  pull(B, cloud);
  t('手机收到 null：留着自己原来那张，不清空', B.state.musicPlaylists[0].cover === small, (B.state.musicPlaylists[0].cover || '').slice(0, 30));
  pull(A, cloud);
  t('电脑拉回云端的 null：大封面也没被清掉', A.state.musicPlaylists[0].cover === big);
}

console.log('\n[7] 时钟：手机的钟慢了 10 分钟，后做的操作照样赢');
{
  const cloud = makeCloud();
  const A = device(0), B = device(-10 * 60 * 1000);
  A.musicToggleFav(S(7));
  push(A, cloud); pull(B, cloud);
  B.musicToggleFav(S(7));                            // 手机（钟慢）后取消收藏
  const d = B.state.musicSyncOps.fav['7'];
  t('手机盖的删除时间 > 电脑那次收藏（跟着见过的最大时间走，不看自己的钟）', d.d > d.a, d);
  push(B, cloud); pull(A, cloud);
  t('电脑那边也取消了', !A.state.musicFav.some(x => String(x.id) === '7'));
}

console.log('\n[8] 收敛：合并过一轮之后再同步，判定「没变化」，不会来回推');
{
  const cloud = makeCloud();
  const A = device(), B = device();
  A.state.musicPlaylists = [{ id: 'pl_x', name: '老', desc: '', cover: '', ts: 500, by: 'me', songs: [S(1), S(2)] }];
  A.musicToggleFav(S(1)); A.musicSearchNote('x'); A.musicNoteRecent(S(9));
  B.musicToggleFav(S(2));
  push(A, cloud); push(B, cloud); pull(A, cloud);
  const r1 = push(A, cloud), r2 = push(B, cloud), r3 = pull(A, cloud), r4 = pull(B, cloud);
  t('两边都同步过之后：再推再拉都是「没变化」', !r1.changed && !r2.changed && !r3.changed && !r4.changed, [r1.changed, r2.changed, r3.changed, r4.changed]);
  const sigOf = d => JSON.stringify([d.state.musicFav, d.state.musicRecent, d.state.musicSearchHist, d.state.musicPlaylists]);
  t('两台的数据一字不差', sigOf(A) === sigOf(B));
  // 合并是对称的：换个先后顺序，结果一样
  const L = { fav: [S(1), S(2)].map((s, i) => Object.assign(s, { ts: 100 + i })), ops: { fav: { '1': { d: 150 } } } };
  const C = { fav: [Object.assign(S(3), { ts: 120 })], ops: { fav: { '2': { d: 90 } } } };
  const m1 = A.musicSyncMerge(L, C), m2 = A.musicSyncMerge(C, L);
  t('merge(本机,云端) 和 merge(云端,本机) 一样', JSON.stringify(m1.fav) === JSON.stringify(m2.fav) && ids(m1.fav).join() === '3,2', ids(m1.fav));
}

console.log('\n[8b] 只拉不推的那条路：本机比云端多，也得推（09-30 真机：电脑 13 首收藏一直没上去）');
{
  const A = device();
  for (let i = 1; i <= 13; i++) A.musicToggleFav(S(i));
  // 云端只有另一台推的 1 首，而且这首电脑也有 → 合并后电脑本机一个字都没变
  const cloudS = { musicFav: [Object.assign(S(1), { ts: A.state.musicFav.find(x => String(x.id) === '1').ts })],
    musicSyncOps: { fav: { '1': { a: A.state.musicFav.find(x => String(x.id) === '1').ts } } } };
  A.musicSyncApply(cloudS);                               // 先把老数据的加入时间折算好（和启动时一样）
  const r = A.musicSyncApply(cloudS);
  t('本机没变化（changed=false）', r.changed === false);
  t('但本机比云端多 → needPush=true', r.needPush === true);
  // 真走一遍 musicSyncPull：它得 save（save 3 秒后推云端）
  A.currentUser = { id: 'u' };
  A.fetchCloudSettings = async () => ({ data: { settings: cloudS }, error: null });
  const saves0 = A._saves;
  await A.musicSyncPull(true);
  t('开面板拉的那一下触发了 save（→ 推云端）', A._saves > saves0, [saves0, A._saves]);
  // 推上去之后再拉：云端和本机一样了，不该再推
  const pushed = Object.assign({}, cloudS, JSON.parse(JSON.stringify(r.payload)));
  const r2 = A.musicSyncApply(pushed);
  t('推过之后再拉：needPush=false，不来回推', r2.needPush === false && r2.changed === false, r2);
  const src = read('js/01-core.js');
  t('启动拉云端时也看 needPush', /_mr\.changed \|\| _mr\.needPush\) save\(\)/.test(src));
}

console.log('\n[9] 搜索记录的界面');
{
  const A = device();
  A.musicSearchNote('晴天'); A.musicSearchNote('<b>坏</b>');
  const h = A._mSearchHtml('');
  t('搜索页没结果时列出「搜过」', /搜过/.test(h) && /mz-hist-chip/.test(h) && /musicSearchFromHist\(0\)/.test(h));
  t('词条转义了', h.includes('&lt;b&gt;坏&lt;/b&gt;') && !h.includes('<b>坏</b>'));
  t('每条有 ×，有「清空」', /musicSearchForget\(1\)/.test(h) && /musicSearchClearHist\(\)/.test(h));
  vm.runInContext('_mResults = [{ id: 1, name: "x", artist: "y", duration: 1000 }]', A);
  t('有搜索结果时不显示搜过', !/搜过/.test(A._mSearchHtml('')));
  vm.runInContext('_mResults = []', A);
  // 点一条 = 把词填回框里再搜一次
  A._inp = { value: '', focus() {}, setSelectionRange() {} };
  let searched = null;
  A.musicSearch = async q => { searched = q; return []; };
  A.musicSearchApple = async () => [];
  await A.musicSearchFromHist(1);
  t('点「晴天」那条：框里填上并搜了', A._inp.value === '晴天' && searched === '晴天', [A._inp.value, searched]);
  t('手动搜索会记进搜索记录（顶到最前）', A.state.musicSearchHist[0].q === '晴天');
}

console.log('\n[10] 接线：持久化三道门、云端推/拉两处、开面板拉一次');
{
  const core = read('js/01-core.js'), st = read('js/02-state.js'), boot = read('js/14-boot-brain-hub.js');
  for (const k of ['musicSearchHist', 'musicSyncOps']) {
    t(`${k}：_doSave 写 IDB`, new RegExp(`idbSet\\('kuro_${k}'`).test(st));
    t(`${k}：loadStateFromDB 读回来`, new RegExp(`${k}:\\s*await g\\('kuro_${k}'`).test(core));
    t(`${k}：启动时赋进 state`, new RegExp(`state\\.${k}\\s*=`).test(boot));
  }
  const push0 = core.slice(core.indexOf('async function syncSettingsToCloud'), core.indexOf('async function syncSettingsToCloud') + 12000);
  t('推送前先和云端合并、把合并结果放进 settings', /musicSyncApply\(cloud\)/.test(push0) && /Object\.assign\(settings, _ms\.payload\)/.test(push0));
  const pullBlk = core.slice(core.indexOf('async function loadFromCloud'));
  t('启动拉云端设置时合并（不是整包替换）', /musicSyncApply\(s\)/.test(pullBlk));
  t('没有整包替换的写法残留', !/state\.music(Fav|Recent|Playlists)\s*=\s*s\./.test(core));
  t('开面板顺手拉一次', /function openMusic\(\)[\s\S]{0,600}musicSyncPull\(\)/.test(music));
  t('CSS 有搜索记录词条的样式', /\.mz-hist-chip \{/.test(read('css/grancyan.css')));
}

}
main().then(() => {
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
