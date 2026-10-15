/* 离线撞号：两台设备都离线、用同一个计数器值各建了一个对话（id 相同、内容完全不同），
 * 联网后 mergeCloudChats 按 id 去重，一方静默覆盖另一方 —— 对话丢了，零报错。
 * 跑法：node tests/offline-id-collision.test.js
 *
 * 修法：同 id 两份若没有任何一条「id 和 timestamp 都相同」的公共消息，就是两个对话，
 * 本机那份换个新号留下（activeChatId / 收藏 / 回收站跟着改）。
 * 反方向同样要钉死：同一个对话在两台设备上各自追加了消息，**不许**被拆成两个。
 *
 * 真跑 01-core.js 里的 mergeCloudChats / _isOfflineIdCollision / _forkLocalChat /
 * reseedIdCounter / nextId、02-state.js 里的墓碑函数、08 里的 getChatLastTimestamp。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const edit = read('js/08-edit-trash.js');

function funcBody(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  throw new Error('函数没闭合 ' + name);
}
function between(src, from, to, file) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`切片锚点没找到: ${file} / ${from} → ${to}`);
  return src.slice(a, b);
}

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const group = n => console.log('\n' + n);

function makeBox(state) {
  const warns = [];
  const box = { state, console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} } };
  box.globalThis = box;
  vm.createContext(box);
  const src = [
    'var _nodeIdCounter = 0;',
    funcBody(core, 'nextId'),
    funcBody(core, 'reseedIdCounter'),
    funcBody(core, '_isOfflineIdCollision'),
    funcBody(core, '_forkLocalChat'),
    funcBody(core, 'mergeCloudChats'),
    funcBody(edit, 'getChatLastTimestamp'),
    funcBody(stateJs, '_blankTombstoneTable'),
    funcBody(stateJs, '_tombstones'),
    funcBody(stateJs, '_tsKey'),
    funcBody(stateJs, 'markChatDeleted'),
    funcBody(stateJs, 'isChatDeleted'),
  ].join('\n');
  vm.runInContext(src, box, { filename: 'offline-id-collision-slice.js' });
  vm.runInContext('reseedIdCounter();', box);   // 模拟启动时播种过
  box.__warns = warns;
  return box;
}

// 造一个对话：msgs = [[节点 id, timestamp, 内容], ...]，按顺序串成一条链
function chat(id, msgs, extra) {
  const nodes = {};
  let parent = null;
  for (const [nid, ts, content] of msgs) {
    nodes[nid] = { id: nid, parentId: parent, role: 'user', content, timestamp: ts };
    parent = nid;
  }
  return Object.assign({ id, title: '对话' + id, nodes, headId: parent }, extra || {});
}
const clone = x => JSON.parse(JSON.stringify(x));
const byContent = (chats, text) => chats.find(c => Object.values(c.nodes || {}).some(n => n.content === text));

// ══════════════════════════════════════════════════════════
group('[1] 离线撞号：两个不同的对话都要留下');
{
  // 两台设备离线时计数器都在 9：各建了对话 10，第一条消息都拿到 11 —— 连消息 id 都撞
  const mine  = chat(10, [[11, 1000, '本机：今天好累'], [12, 1005, '本机：抱抱']]);
  const theirs = chat(10, [[11, 2000, '手机：去超市买什么'], [12, 2003, '手机：牛奶']]);
  const state = { chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] };
  const box = makeBox(state);
  box.mergeCloudChats([clone(theirs)]);
  const S = box.state;
  t('合并后两个对话都在', S.chats.length === 2, S.chats.map(c => c.id));
  const a = byContent(S.chats, '本机：今天好累'), b = byContent(S.chats, '手机：去超市买什么');
  t('本机那份的内容一条没少', a && a.nodes[12].content === '本机：抱抱');
  t('云端那份占原号 10', b && b.id === 10, b && b.id);
  t('本机那份换了新号（不再是 10）', a && a.id !== 10, a && a.id);
  t('新号越过所有现存 id（对话 id 和消息 id）', a && a.id > 12, a && a.id);
  t('两份 id 不同', new Set(S.chats.map(c => c.id)).size === 2);
  t('正在看的对话跟着本机那份走（视图不会突然换成手机的对话）', S.activeChatId === (a && a.id), S.activeChatId);
  t('控制台留了一句说明', box.__warns.some(w => w.includes('离线撞号')));
  // 再拉一次同一份云端数据：已经分开了，不许再分裂出第三个
  box.mergeCloudChats([clone(theirs)]);
  t('幂等：再合并同一份云端数据不会再多出对话', box.state.chats.length === 2, box.state.chats.map(c => c.id));
  // 换号后的对话下次被推上去、又从云端拉回来 → 它自己跟自己，是同一个对话
  if (a) box.mergeCloudChats([clone(a)]);
  t('换号后的对话从云端回来时认得出是自己', !!a && box.state.chats.length === 2);
}
{
  // 消息 id 完全不重叠（一台中途别的东西消耗过计数器）也要认出来
  const mine  = chat(10, [[13, 1000, '本机 A']]);
  const theirs = chat(10, [[11, 2000, '手机 B'], [12, 2001, '手机 C']]);
  const box = makeBox({ chats: [mine], activeChatId: null, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('没有公共消息 id 的两个对话也都留下', box.state.chats.length === 2
    && byContent(box.state.chats, '本机 A') && byContent(box.state.chats, '手机 B'));
}

// ══════════════════════════════════════════════════════════
group('[2] ❗同一个对话在两台设备上各自追加：不许拆成两个');
{
  const base = [[11, 1000, '一起说过的第一句'], [12, 1001, '一起说过的第二句']];
  const mine  = chat(10, base.concat([[13, 3000, '本机后来补的']]));
  const theirs = chat(10, base.concat([[14, 4000, '手机后来补的']]));
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('仍然只有 1 个对话', box.state.chats.length === 1, box.state.chats.map(c => c.id));
  t('id 不变', box.state.chats[0].id === 10);
  t('老规矩：最后消息更新的那份（手机）赢', !!box.state.chats[0].nodes[14]);
  t('activeChatId 不动', box.state.activeChatId === 10);
}
{
  const mine  = chat(10, [[11, 1000, '同一句']]);
  const theirs = chat(10, [[11, 1000, '同一句'], [12, 1500, '云端多一句']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('云端只是比本机新：直接替换，不分叉', box.state.chats.length === 1 && !!box.state.chats[0].nodes[12]);
  const box2 = makeBox({ chats: [clone(theirs)], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box2.mergeCloudChats([clone(mine)]);
  t('云端比本机旧：保留本机，不分叉', box2.state.chats.length === 1 && !!box2.state.chats[0].nodes[12]);
}
{
  // 本机把一条共有消息的内容改了？编辑是另建节点，旧节点 (id,timestamp) 还在 → 仍是同一个
  const mine  = chat(10, [[11, 1000, '原话'], [15, 5000, '编辑后另建的节点']]);
  const theirs = chat(10, [[11, 1000, '原话'], [12, 1200, '手机的回复']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('一边编辑过（另建节点）也还是同一个对话', box.state.chats.length === 1);
}

// ══════════════════════════════════════════════════════════
group('[3] 保守：证据不够就按老规矩');
{
  const mine  = chat(10, []);
  const theirs = chat(10, [[11, 2000, '手机的']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('本机是空对话：不分叉（没东西可丢）', box.state.chats.length === 1 && box.state.chats[0].id === 10);
}
{
  const mine  = chat(10, [[11, 1000, '本机']]);
  const theirs = chat(10, []);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('云端是空对话：不分叉，本机那份留着', box.state.chats.length === 1 && !!box.state.chats[0].nodes[11]);
}
{
  const mine  = chat(10, [[11, 1000, 'a']]); delete mine.nodes[11].timestamp;
  const theirs = chat(10, [[11, 2000, 'b']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.mergeCloudChats([clone(theirs)]);
  t('公共消息缺 timestamp（老数据）：判不了，不分叉', box.state.chats.length === 1);
}
{
  const mine  = chat(10, [[11, 1000, '本机']]);
  const theirs = chat(10, [[11, 2000, '手机']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: {}, trash: [], favMessages: [] });
  box.markChatDeleted(10);
  box.mergeCloudChats([clone(theirs)]);
  t('有墓碑的 id：云端那份照旧被挡，不分叉、不复活', box.state.chats.length === 1
    && box.state.chats[0].nodes[11].content === '本机');
}

// ══════════════════════════════════════════════════════════
group('[4] 新号不撞任何东西');
{
  const mine  = chat(10, [[11, 1000, '本机']]);
  const theirs = chat(10, [[11, 2000, '手机'], [40, 2001, '手机的大号消息']]);
  // 本机计数器此刻停在 60（回收站），同一批里别的设备恰好有个 61 —— 不先 reseed 就会发出 61
  const other = chat(61, [[62, 2500, '同一批里别的对话']]);
  const box = makeBox({ chats: [mine], activeChatId: 10, deletedChats: { 50: { at: 1, cloud: 'pending' } },
    trash: [{ type: 'message', chatId: 99, message: { id: 60, timestamp: 1 } }], favMessages: [] });
  box.mergeCloudChats([clone(theirs), clone(other)]);
  const a = byContent(box.state.chats, '本机');
  t('新号越过这批云端对话的 id / 消息 id(61,62)、墓碑(50)、回收站(60)', a && a.id > 62, a && a.id);
  t('❗所有对话 id 互不相同', new Set(box.state.chats.map(c => c.id)).size === box.state.chats.length,
    box.state.chats.map(c => c.id));
  t('新号不在墓碑里（不会被当成已删、永远不上云）', a && !box.isChatDeleted(a.id));
  t('三个对话都在', box.state.chats.length === 3);
  t('下一个新建对话的号也不撞', box.nextId() > a.id);
}

// ══════════════════════════════════════════════════════════
group('[5] 引用跟着改：收藏 / 回收站');
{
  const mine  = chat(10, [[11, 1000, '本机第一句'], [12, 1010, '本机第二句'], [13, 1020, '本机独有']]);
  const theirs = chat(10, [[11, 2000, '手机第一句'], [12, 2010, '手机第二句']]);
  const favs = [
    { chatId: 10, nodeId: 13, text: '本机独有', time: 1100 },     // 节点只在本机 → 迁
    { chatId: 10, nodeId: 11, text: '本机第一句', time: 1500 },   // 两边都有 11：收藏时间 1500 在本机消息之后、手机消息之前 → 本机的
    { chatId: 10, nodeId: 12, text: '手机第二句', time: 2500 },   // 两边都早于收藏时间 → 分不清，不动
    { chatId: 77, nodeId: 13, text: '别的对话', time: 1 },
  ];
  const trash = [
    { chatId: 10, chatTitle: 'x', message: { id: 19, timestamp: 1030, content: '本机删掉的一句' } },
    { chatId: 10, chatTitle: 'x', message: { id: 12, timestamp: 2010, content: '其实是手机那份的节点' } },
    { type: 'fav', favData: { chatId: 10, nodeId: 11 } },
  ];
  const box = makeBox({ chats: [mine, chat(77, [[78, 500, '她正看着的别的对话']])], activeChatId: 77,
    deletedChats: {}, trash, favMessages: favs });
  box.mergeCloudChats([clone(theirs)]);
  const a = byContent(box.state.chats, '本机独有');
  const F = box.state.favMessages, T = box.state.trash;
  t('只在本机那份里的消息的收藏迁到新号', F[0].chatId === a.id, F[0]);
  t('同号节点：收藏时间能夹出来是本机的 → 迁', F[1].chatId === a.id, F[1]);
  t('同号节点：夹不出来 → 不动', F[2].chatId === 10, F[2]);
  t('别的对话的收藏不动', F[3].chatId === 77);
  t('回收站里从本机这份删的消息 → 迁到新号（恢复时回到对的对话）', T[0].chatId === a.id, T[0]);
  t('回收站里其实是云端那份的同一节点 → 不动', T[1].chatId === 10, T[1]);
  t('回收站里的收藏墓碑不动', T[2].favData.chatId === 10);
  t('activeChatId 不是它的就不动', box.state.activeChatId === 77);
}

// ══════════════════════════════════════════════════════════
group('[6] 推送途中被换号的对话不许按旧号推');
{
  const pushes = [];
  const state = { chats: [], activeChatId: null, deletedChats: {} };
  for (let i = 1; i <= 7; i++) state.chats.push(chat(i * 10, [[i * 10 + 1, 1000 + i, 'c' + i]]));
  const box = {
    state, console: { log() {}, warn() {}, error() {} },
    currentUser: { id: 'u' }, navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {} },
    isChatDeleted: () => false, retryPendingChatDeletes: async () => {},
    cloudRetry: async fn => fn(),
    rawUpsertChats: async rows => {
      pushes.push(rows.map(r => [r.chat_id, r.data.id]));
      // 第一批推的时候，mergeCloudChats 把第 7 个（在第二批里）换了号
      if (pushes.length === 1) state.chats[6].id = 999;
    },
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(funcBody(edit, 'getChatLastTimestamp'), box);
  vm.runInContext(between(core, 'let _pushedFp = null;', 'async function manualSyncAll()', 'js/01-core.js'), box);
  (async () => {
    await box.syncChatsToCloud();
    const all = pushes.flat();
    t('没有任何一行 chat_id 和 data.id 对不上', all.every(([cid, did]) => String(cid) === String(did)), pushes);
    t('其余 6 个照常推了', all.length === 6, all.length);
    finish();
  })().catch(e => { console.error(e); process.exit(1); });
}

function finish() {
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}
