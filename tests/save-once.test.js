/* 一次 save() 只把对话序列化一遍。跑法：node tests/save-once.test.js
 *
 * 以前一次 save() 周期里，每个对话要被 JSON.stringify 三到四遍：
 *   ① _doSave 写 kuro_chats（整份）
 *   ② 3 秒后 syncChatsToCloud 的 _chatFp 给每个对话算指纹（逐个）
 *   ③ 5 秒后 createBackup → _writeBackup 写备份环（整份）
 *   ④ 推成功的那几个 markPushed 再算一次指纹
 * 这里真的跑生产代码（02-state 的备份段 + SAVE SECTION、01-core 的云推送段），
 * 把沙箱里的 JSON.stringify 换成会数数的版本，数每个对话对象被序列化了几次；
 * 同时钉住「写进 IDB / 备份 / 推上云 / 指纹」的内容跟老写法逐字节一样。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stateSrc = read('js/02-state.js');
const coreSrc = read('js/01-core.js');
const editSrc = read('js/08-edit-trash.js');

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
function between(src, from, to, file) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`切片锚点没找到: ${file} / ${from} → ${to}`);
  return src.slice(a, b);
}
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

const REAL = JSON;

function makeBox() {
  const db = new Map();
  const tracked = new Set();          // 被追踪的对话对象
  const hits = new Map();             // 对话对象 → 被序列化次数
  const bump = c => hits.set(c, (hits.get(c) || 0) + 1);
  const countingJSON = {
    stringify(v, r, s) {
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (tracked.has(v[i])) bump(v[i]); }
      else if (tracked.has(v)) bump(v);
      return REAL.stringify(v, r, s);
    },
    parse: REAL.parse,
  };
  const timers = [];
  let now = 0, seq = 0;
  const pushes = [];
  const ls = new Map();
  const box = {
    JSON: countingJSON,
    console: { log() {}, warn() {}, error() {} },
    state: { chats: [], configs: [], configsVer: 0 },
    idbSet: async (k, v) => { db.set(k, v); },
    idbGet: async k => (db.has(k) ? db.get(k) : null),
    idbDel: async k => { db.delete(k); },
    showToast() {},
    musicVisNorm: v => v || 'aurora',
    musicLyricStyleNorm: v => v || 'scroll',
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + (ms || 0), fn }); return id; },
    clearTimeout: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    currentUser: { id: 'u1' },
    navigator: { onLine: true },
    isChatDeleted: () => false,
    retryPendingChatDeletes: async () => {},
    syncSettingsToCloud: async () => {},
    cloudRetry: async fn => fn(),
    // 推送：用真 JSON 记下请求体（rawUpsertChats 的真身先 stripNullBytes 拷贝再序列化，那一遍本来就是必须的）
    rawUpsertChats: async rows => { pushes.push(REAL.stringify(rows.map(r => ({ chat_id: r.chat_id, data: r.data })))); },
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext('let _saveTimer, _cloudSyncTimer;', box);
  vm.runInContext(funcBody(editSrc, 'getChatLastTimestamp'), box, { filename: '08-edit-trash.js#getChatLastTimestamp' });
  vm.runInContext(between(stateSrc, '// 🛡️ 备份机制', 'async function manualBackup()', 'js/02-state.js'), box,
    { filename: 'js/02-state.js#backup' });
  vm.runInContext(between(stateSrc, '// ── SAVE SECTION ──', 'function estimateTokens(text)', 'js/02-state.js'), box,
    { filename: 'js/02-state.js#SAVE_SECTION' });
  vm.runInContext(between(coreSrc, 'let _pushedFp = null;', 'async function manualSyncAll()', 'js/01-core.js'), box,
    { filename: 'js/01-core.js#cloud-push' });
  // 跑完所有计时器（按到点时间，同一时刻按创建顺序）；异步回调要等它 settle 再取下一个
  async function flush() {
    for (let guard = 0; guard < 50 && timers.length; guard++) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const x = timers.shift();
      now = x.at;
      await x.fn();
      for (let k = 0; k < 20; k++) await Promise.resolve();
    }
  }
  return { box, db, tracked, hits, flush, pushes, ls };
}

function mkChat(id, n, t0) {
  const nodes = {};
  let parent = null;
  for (let i = 1; i <= n; i++) {
    const nid = id * 100 + i;
    nodes[nid] = { id: nid, parentId: parent, role: i % 2 ? 'user' : 'ai', content: '第' + i + '条 "引号" \\ 和   换行', timestamp: t0 + i };
    parent = nid;
  }
  return { id, title: '对话' + id, nodes, headId: parent, isPinned: false, activeModelIds: [], msgLimit: 0 };
}

(async () => {
  console.log('\n[save-once] 一次 save() 周期里每个对话只序列化一遍');
  const h = makeBox();
  const { box, db, tracked, hits } = h;
  box.state.chats = [mkChat(1, 3, 1000), mkChat(2, 2, 2000), mkChat(3, 4, 3000)];
  box.state.chats.forEach(c => tracked.add(c));
  box.save();
  await h.flush();
  const counts = box.state.chats.map(c => hits.get(c) || 0);
  t('第一轮（全部要推）：每个对话恰好序列化 1 次', counts.every(n => n === 1), counts);

  const expectJson = REAL.stringify(box.state.chats);
  t('kuro_chats 与 JSON.stringify(state.chats) 逐字节相同', db.get('kuro_chats') === expectJson);
  t('备份最新槽与 kuro_chats 逐字节相同', db.get('kuro_chats_backup') === expectJson);
  t('高水位安全槽与 kuro_chats 逐字节相同', db.get('kuro_chats_safe') === expectJson);
  const ring = REAL.parse(db.get('kuro_backup_ring') || '[]');
  t('滚动环写了一槽，内容逐字节相同', ring.length === 1 && db.get('kuro_backup_slot_' + ring[0].ts) === expectJson, ring);
  t('环里的计数 = 老算法 chatsMsgCount', ring[0] && ring[0].msgCount === 9 && ring[0].chatCount === 3, ring[0]);
  const meta = REAL.parse(db.get('kuro_safe_meta'));
  t('安全槽 meta 的 size / 计数对得上', meta.size === expectJson.length && meta.msgCount === 9 && meta.chatCount === 3, meta);
  t('三个对话都推上去了', h.pushes.length === 1 && REAL.parse(h.pushes[0]).length === 3);
  const fp = REAL.parse(h.ls.get('kuro_pushedFp'));
  const oldFp = c => (box.getChatLastTimestamp(c) || 0) + ':' + REAL.stringify(c).length;
  t('推送指纹与老算法（lastTs:JSON 长度）逐字相同',
    box.state.chats.every(c => fp[c.id] === oldFp(c)), { fp, want: box.state.chats.map(oldFp) });

  console.log('\n[save-once] 第二轮只改一个对话');
  hits.clear();
  const c2 = box.state.chats[1];
  c2.nodes[299] = { id: 299, parentId: c2.headId, role: 'user', content: '新的一条', timestamp: 2999 };
  c2.headId = 299;
  box.save();
  await h.flush();
  const counts2 = box.state.chats.map(c => hits.get(c) || 0);
  t('第二轮：每个对话仍然只序列化 1 次', counts2.every(n => n === 1), counts2);
  t('只推了改过的那一个', h.pushes.length === 2 && REAL.parse(h.pushes[1]).map(r => r.chat_id).join() === '2', h.pushes[1]);
  t('kuro_chats / 备份都跟上了新内容',
    db.get('kuro_chats') === REAL.stringify(box.state.chats) && db.get('kuro_chats_backup') === db.get('kuro_chats'));

  console.log('\n[save-once] 快照作废时老老实实现算');
  hits.clear();
  box.createBackup();                   // 快照已被上一轮备份用掉 → 必须现算，不能写空/旧的
  box.state.chats[0].title = '备份前改了标题';
  await h.flush();
  t('没有新快照时备份现序列化（内容是当下的）', db.get('kuro_chats_backup') === REAL.stringify(box.state.chats));
  box.save();
  await h.flush();
  box.state.chats = box.state.chats.slice(0, 2); // 整个数组被换掉（比如删对话 / 云端合并）
  box.state.chats.forEach(c => tracked.add(c));
  box.createBackup();
  await h.flush();
  t('数组被换掉后备份不拿旧快照', db.get('kuro_chats_backup') === REAL.stringify(box.state.chats));
  t('数组被换掉后指纹也现算', box._chatJsonLen(box.state.chats[0]) === REAL.stringify(box.state.chats[0]).length);

  console.log('\n[save-once] 拼接法对各种怪数组都和 JSON.stringify 一致');
  const weird = [
    [], [null], [undefined], [function () {}], [{ a: 1 }, null, { b: [1, { c: ' "' }] }],
    // eslint-disable-next-line no-sparse-arrays
    [{ x: 1 }, , { y: 2 }], [{ d: new Date(0) }], [{ n: NaN, i: Infinity, u: undefined }],
  ];
  for (const w of weird) {
    const got = box._serializeChats(w);
    t('≡ ' + REAL.stringify(w).slice(0, 40), got === REAL.stringify(w), got);
  }
  t('非数组也照样（老写法的兜底）', box._serializeChats(null) === 'null' && box._serializeChats({ a: 1 }) === '{"a":1}');

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
