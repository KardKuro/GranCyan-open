/* 记忆桥（U 分区：brain-inbox 收件箱 + brain-snapshot 快照）的最小冒烟。
 * 这块管的是用户的真实记忆，还没搬出 server.js（Phase 2 待搬），是全项目
 * "坏了最疼"的区之一：坏了 = 静默丢她的记忆，或者把私密记忆漏到不该去的地方。
 * 方案原文点名要给它补测试，这是那一条的落地。
 *
 * 手法：把 server.js 里 `const BRAIN_INBOX_DIR` 到 `// 散步看板` 之间那一整段
 * 原样抠出来，在 vm 沙箱里跑——不是抠单个 handler 再手工缝依赖，是把整段的
 * app.get/app.post 调用、辅助函数（inboxSweep / brainActiveConsumers / …）
 * 一起跑起来，用一个假 `app` 接住注册的路由，用一个内存里的假 `fs` 接住所有
 * 读写。**绝不写用户的真实数据目录**——GRANCYAN_INBOX_DIR 指向一个假路径，
 * 而且连 fs 本身都是内存实现，物理上摸不到磁盘。
 *
 * 跑法：node tests/brain-inbox.test.js
 */
const fsReal = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const serverSrc = fsReal.readFileSync(path.join(root, 'server.js'), 'utf8');

const SLICE_FROM = serverSrc.indexOf('const BRAIN_INBOX_DIR');
const SLICE_TO = serverSrc.indexOf('// 散步看板');
if (SLICE_FROM < 0 || SLICE_TO < 0 || SLICE_TO <= SLICE_FROM) {
  console.log('  ✗ 切不出记忆桥那段代码（server.js 结构变了？两个锚点：const BRAIN_INBOX_DIR / // 散步看板）');
  process.exit(1);
}
const BRAIN_SRC = serverSrc.slice(SLICE_FROM, SLICE_TO);

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

// ── 内存里的假 fs：只实现这段代码真的用到的那几个方法。绝不碰真磁盘。 ──
function makeFakeFs() {
  const store = new Map();   // 归一化路径 -> {type:'file'|'dir', content, mtimeMs}
  const sep = path.sep;
  function notFound(op, p) { const e = new Error(`ENOENT: ${op} '${p}'`); e.code = 'ENOENT'; return e; }
  return {
    _store: store,
    mkdirSync(p) { if (!store.has(p)) store.set(p, { type: 'dir', mtimeMs: Date.now() }); },
    existsSync(p) { return store.has(p); },
    writeFileSync(p, data, opts) {
      if (opts && opts.flag === 'wx' && store.has(p)) {
        const e = new Error(`EEXIST: file already exists, open '${p}'`); e.code = 'EEXIST'; throw e;
      }
      store.set(p, { type: 'file', content: String(data), mtimeMs: Date.now() });
    },
    readFileSync(p) {
      const e = store.get(p);
      if (!e || e.type !== 'file') throw notFound('open', p);
      return e.content;
    },
    renameSync(from, to) {
      const e = store.get(from);
      if (!e) throw notFound('rename', from);
      store.delete(from);
      store.set(to, { ...e, mtimeMs: Date.now() });
    },
    unlinkSync(p) {
      if (!store.has(p)) throw notFound('unlink', p);
      store.delete(p);
    },
    rmSync(p) {
      const prefix = p + sep;
      for (const k of [...store.keys()]) { if (k === p || k.startsWith(prefix)) store.delete(k); }
    },
    readdirSync(dir) {
      const prefix = dir + sep;
      const names = new Set();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const seg = k.slice(prefix.length).split(sep)[0];
          if (seg) names.add(seg);
        }
      }
      return [...names];
    },
    statSync(p) {
      const e = store.get(p);
      if (!e) throw notFound('stat', p);
      return { mtimeMs: e.mtimeMs };
    },
    utimesSync(p, atime, mtime) {
      const e = store.get(p);
      if (e) e.mtimeMs = (mtime instanceof Date ? mtime.getTime() : Number(mtime)) || Date.now();
    },
  };
}

// 加载一份"新进程"：给定 env 和一份（可选复用的）假磁盘，把 BRAIN_SRC 跑一遍，
// 用假 app 接住路由注册。复用同一个 fakeFs 能模拟"同一块磁盘、不同环境变量重启"，
// 后面测 GRANCYAN_SNAPSHOT=off 真的会清掉已落盘的旧快照就是靠这个。
function loadBrainModule(envOverrides, sharedFakeFs) {
  const fakeFs = sharedFakeFs || makeFakeFs();
  const routes = {};
  const sandbox = {
    console,
    app: {
      get(p, h) { routes['GET ' + p] = h; },
      post(p, h) { routes['POST ' + p] = h; },
    },
    process: { env: Object.assign({ GRANCYAN_INBOX_DIR: 'FAKE_INBOX_ROOT' }, envOverrides || {}) },
    // server.js 顶部就 require 过一次 fs/path，这段代码里用的是那两个自由变量，
    // 不是自己再 require 一次——所以直接把假 fs / 真 path 摆成沙箱全局，而不是
    // 拦 require()。唯一一处 require('os') 在 GRANCYAN_INBOX_DIR 兜底分支里，
    // 而这里总是显式给了 GRANCYAN_INBOX_DIR，短路掉不会真的走到那一行；
    // require 仍然留一个兜底桩，防着还有别的地方漏看了。
    fs: fakeFs,
    path,
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'os') return { homedir: () => 'FAKE_HOME_NEVER_USED', tmpdir: () => 'FAKE_TMP_NEVER_USED' };
      throw new Error('brain-inbox 测试沙箱没预料到 require(' + name + ')');
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BRAIN_SRC, sandbox, { filename: 'server.js#brain-inbox' });
  return { routes, fakeFs, sandbox };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = c => { res.statusCode = c; return res; };
  res.json = j => { res.body = j; return res; };
  return res;
}
function mkReq({ query, body, ip } = {}) {
  return { query: query || {}, body: body, socket: { remoteAddress: ip || '127.0.0.1' } };
}
function call(routes, key, req) {
  const h = routes[key];
  if (!h) throw new Error('路由没注册: ' + key);
  const res = makeRes();
  h(req, res);
  return res;
}

const INBOX_ITEMS_DIR = path.join('FAKE_INBOX_ROOT', 'items');
const INBOX_ACKS_DIR  = path.join('FAKE_INBOX_ROOT', 'ack');
const SNAPSHOT_DIR    = path.join('FAKE_INBOX_ROOT', 'snapshots');
let idSeq = 0;
// ⚠️ 时间戳必须是"现在"，不能随便写死一个过去的数字——id 里的时间戳会被
// inboxSweep() 拿去跟 INBOX_RETAIN_DAYS（默认 30 天）比较，写死的旧时间戳会让
// 测试数据"够格被清理"，一旦它恰好被某个 consumer ack 过就会在下一次 GET 触发的
// sweep 里被真的删掉——这条踩过一次（下面就是被这坑绊倒又修好的版本）。
const mkId = () => `${Date.now()}-t${idSeq++}`;   // 匹配 INBOX_ID_RE

(async () => {

// ============================================================
// [0] 沙箱本身能跑起来、五条路由都注册了
// ============================================================
{
  const m = loadBrainModule({});
  t('沙箱跑起来了，五条路由都注册了',
    !!m.routes['POST /api/brain-inbox'] && !!m.routes['GET /api/brain-inbox']
    && !!m.routes['POST /api/brain-inbox/ack']
    && !!m.routes['POST /api/brain-snapshot'] && !!m.routes['GET /api/brain-snapshot']);
}

// ============================================================
// [1] brainNotLocal 闸门：所有路由的第一道关，排在任何 fs 写入之前
// 证据：server.js:2428 function brainNotLocal；每条 handler 的第一行
// （2544/2573/2600/2677/2741）都是 `if (brainNotLocal(req, res)) return;`，
// 而各自的第一次 fs 写入分别在 2559/2585/2610/2699 —— 闸门严格排在前面。
// ============================================================
console.log('\n[1] brainNotLocal：非本机直接 403，且排在一切校验/写入之前');
{
  const m = loadBrainModule({});
  const res = call(m.routes, 'GET /api/brain-inbox', mkReq({ ip: '192.168.1.50' }));   // 局域网 IP，没给 consumer
  t('局域网 IP 且 BRAIN_LAN 未开 → 403（不是因为缺 consumer 才 400）',
    res.statusCode === 403 && /只对本机开放/.test(res.body && res.body.error));
  t('403 时没有创建任何 ack 目录（真的没往下走）', m.fakeFs._store.size === 0);

  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = call(m.routes, 'GET /api/brain-inbox', mkReq({ ip }));
    t(`回环地址 ${ip} 能过闸门（不是 403，而是往下走到了缺 consumer 的 400）`,
      r.statusCode === 400 && /consumer/.test(r.body && r.body.error));
  }

  const m2 = loadBrainModule({ GRANCYAN_BRAIN_LAN: 'on' });
  const r2 = call(m2.routes, 'GET /api/brain-inbox', mkReq({ ip: '192.168.1.50' }));
  t('GRANCYAN_BRAIN_LAN=on 时局域网 IP 也能过闸门', r2.statusCode !== 403);
}

// ============================================================
// [2] POST /api/brain-inbox：缺 text 直接 400，不摸文件系统
// 证据：server.js:2547 `if (!text) return res.status(400)...`，
// 排在 2559 `fs.mkdirSync(INBOX_ITEMS, ...)` 之前。
// ============================================================
console.log('\n[2] POST /api/brain-inbox：入站校验 + 真写入');
{
  const m = loadBrainModule({});
  const r1 = call(m.routes, 'POST /api/brain-inbox', mkReq({ body: {} }));
  t('缺 text → 400，且没摸文件系统', r1.statusCode === 400 && /缺少 text/.test(r1.body.error) && m.fakeFs._store.size === 0);

  const r2 = call(m.routes, 'POST /api/brain-inbox', mkReq({ body: { text: '   ' } }));
  t('纯空白 text（trim 后为空）同样 400', r2.statusCode === 400 && /缺少 text/.test(r2.body.error));

  const r3 = call(m.routes, 'POST /api/brain-inbox', mkReq({ body: { text: '今天学会了一个新知识点', domain: '学习' } }));
  t('合法 text → 200 并给回 id', r3.statusCode === 200 && r3.body.ok === true && typeof r3.body.id === 'string');
  const itemPath = path.join(INBOX_ITEMS_DIR, r3.body.id + '.json');
  const saved = m.fakeFs._store.get(itemPath);
  t('真的落盘了（假磁盘上能读到这个文件）', !!saved && saved.type === 'file');
  const parsed = saved && JSON.parse(saved.content);
  t('落盘内容里 text/domain 对得上', parsed && parsed.text === '今天学会了一个新知识点' && parsed.domain === '学习');
}

// ============================================================
// [3] GET /api/brain-inbox：缺/非法 consumer 直接 400，不摸文件系统；
// 合法 consumer 只吐还没 ack 过的条目。
// 证据：server.js:2576 校验排在 2585 的 fs.mkdirSync(ack 目录) 之前。
// ============================================================
console.log('\n[3] GET /api/brain-inbox：入站校验 + 只吐未 ack 的');
{
  const m = loadBrainModule({});
  const r1 = call(m.routes, 'GET /api/brain-inbox', mkReq({}));
  t('缺 consumer → 400，且没摸文件系统', r1.statusCode === 400 && /consumer/.test(r1.body.error) && m.fakeFs._store.size === 0);

  const r2 = call(m.routes, 'GET /api/brain-inbox', mkReq({ query: { consumer: '带斜杠/不合法' } }));
  t('consumer 里带斜杠（不在允许字符集）→ 400', r2.statusCode === 400 && /consumer/.test(r2.body.error));

  // 直接往假磁盘里种两条合法记忆，其中一条预先 ack 掉
  const idA = mkId(), idB = mkId();
  const put = (id, text) => m.fakeFs.writeFileSync(
    path.join(INBOX_ITEMS_DIR, id + '.json'), JSON.stringify({ id, text, domain: '综合', createdAt: Date.now() }));
  put(idA, '记忆A'); put(idB, '记忆B');
  m.fakeFs.mkdirSync(path.join(INBOX_ACKS_DIR, 'consumerX'));
  m.fakeFs.writeFileSync(path.join(INBOX_ACKS_DIR, 'consumerX', idA), '');   // A 已经被 consumerX 收过了

  const r3 = call(m.routes, 'GET /api/brain-inbox', mkReq({ query: { consumer: 'consumerX' } }));
  t('只吐没 ack 过的那条', r3.statusCode === 200 && r3.body.count === 1 && r3.body.items[0].id === idB);

  // 换一个从没露过面的消费者，两条都该给
  const r4 = call(m.routes, 'GET /api/brain-inbox', mkReq({ query: { consumer: 'consumerY' } }));
  t('新消费者两条都拿到', r4.body.count === 2 && new Set(r4.body.items.map(i => i.id)).size === 2);
}

// ============================================================
// [4] POST /api/brain-inbox/ack：入站校验 + 幂等 + 越界 id 被过滤
// 证据：server.js:2602 consumer 校验、2607 `if (!ids.length) return`
// 都排在 2610 `fs.mkdirSync(dir, ...)` 之前——全部合法 id 都过滤掉时
// 连目录都不会建。
// ============================================================
console.log('\n[4] POST /api/brain-inbox/ack：校验 + 幂等 + 越界过滤');
{
  const m = loadBrainModule({});
  const r1 = call(m.routes, 'POST /api/brain-inbox/ack', mkReq({ body: { ids: ['x'] } }));
  t('缺 consumer → 400，不摸文件系统', r1.statusCode === 400 && /consumer/.test(r1.body.error) && m.fakeFs._store.size === 0);

  // 越界：全部 id 都不合法（越权路径 / SQL 注入式字符串 / 数字），过滤后是空数组，
  // 走的是"排在建目录之前"的早退分支
  const r2 = call(m.routes, 'POST /api/brain-inbox/ack',
    mkReq({ body: { consumer: 'c1', ids: ['../../etc/passwd', "'; DROP TABLE x;--", 12345, { hack: 1 }] } }));
  t('★ 全部 id 都不合法 → acked:0，且真的没建 ack 目录（越界 id 没有偷偷落地）',
    r2.statusCode === 200 && r2.body.ok === true && r2.body.acked === 0 && m.fakeFs._store.size === 0);

  const idOk = mkId(), idBad = 'not-an-id';
  const r3 = call(m.routes, 'POST /api/brain-inbox/ack', mkReq({ body: { consumer: 'c1', ids: [idOk, idBad] } }));
  t('★ 合法/非法混在一起，只有合法的被计入 acked', r3.body.acked === 1);
  t('非法 id 没有对应的 ack 文件被建出来', !m.fakeFs._store.has(path.join(INBOX_ACKS_DIR, 'c1', idBad)));
  t('合法 id 的 ack 文件真的建出来了', m.fakeFs._store.has(path.join(INBOX_ACKS_DIR, 'c1', idOk)));

  // 幂等：同一个 id 再 ack 一次，不炸、结果一致，磁盘上还是只有一份
  const before = m.fakeFs._store.size;
  const r4 = call(m.routes, 'POST /api/brain-inbox/ack', mkReq({ body: { consumer: 'c1', ids: [idOk] } }));
  t('★ 重复 ack 同一个 id 不报错、acked 还是 1（幂等）', r4.statusCode === 200 && r4.body.acked === 1);
  t('重复 ack 不会在磁盘上多出条目', m.fakeFs._store.size === before);
}

// ============================================================
// [5] POST /api/brain-snapshot：SNAPSHOT_OFF 排在 consumer/memories 校验之前，
// 且真的会清掉磁盘上已经存在的旧快照（不是只挡新的）。
// 证据：server.js:2678 `if (SNAPSHOT_OFF) return res.status(403)...`
// 排在 2680 的 consumer 校验之前；模块顶层 2632-2637 在 SNAPSHOT_OFF 时
// 对 SNAPSHOT_DIR 做 fs.rmSync。
// mount-guard 已经守了"consumer 缺失/memories 非数组"这两条 400 分支，
// 这里不重复，只测 SNAPSHOT_OFF 这一层，以及过了校验之后真正的写入行为。
// ============================================================
console.log('\n[5] POST /api/brain-snapshot：SNAPSHOT_OFF 优先级 + 真实写入行为');
{
  // 先用正常环境写一份快照，确认磁盘上真的有
  const disk = makeFakeFs();
  const m1 = loadBrainModule({}, disk);
  const authedConsumer = 'c1';
  const okBody = {
    consumer: authedConsumer,
    memories: [
      { id: '不该被落盘的字段', text: '今天天气不错', domain: '综合', weight: 1, pinned: false },
      { text: '不能说的秘密', domain: '情感/亲密', weight: 99 },   // 私密域，必须被过滤掉
      { text: '', domain: '综合' },                                // 空文本，必须被过滤掉
    ],
  };
  const w1 = call(m1.routes, 'POST /api/brain-snapshot', mkReq({ body: okBody }));
  t('正常环境下写入成功，且私密域/空文本被过滤（3 条只留 1 条）', w1.statusCode === 200 && w1.body.count === 1);
  const snapPath = path.join(SNAPSHOT_DIR, authedConsumer + '.json');
  const saved1 = disk._store.get(snapPath);
  t('落盘文件真的存在', !!saved1);
  const parsed1 = saved1 && JSON.parse(saved1.content);
  t('★ 私密域记忆没有出现在落盘内容里', parsed1 && parsed1.memories.every(x => x.text !== '不能说的秘密'));
  t('留下来的那条字段被收口（没有 id 这种只对页面有意义的字段）',
    parsed1 && parsed1.memories[0].text === '今天天气不错' && !('id' in parsed1.memories[0]));

  // 同一块"磁盘"，换一个 SNAPSHOT_OFF=off 的环境重新加载（模拟"重启时打开了这个开关"）
  const m2 = loadBrainModule({ GRANCYAN_SNAPSHOT: 'off' }, disk);
  t('★ 模块一加载（哪怕还没收到任何请求），已落盘的旧快照就被清掉了',
    !disk._store.has(snapPath));

  const w2 = call(m2.routes, 'POST /api/brain-snapshot', mkReq({ body: okBody }));
  t('SNAPSHOT_OFF 时 POST 直接 403，排在 consumer/memories 校验之前',
    w2.statusCode === 403 && /GRANCYAN_SNAPSHOT=off/.test(w2.body.error));
  t('SNAPSHOT_OFF 时哪怕 body 是空对象也是同一个 403（校验顺序在它之后）',
    call(m2.routes, 'POST /api/brain-snapshot', mkReq({ body: {} })).statusCode === 403);
}

// ============================================================
// [5b] SNAPSHOT_MAX：单份快照收多了要截断，不能无限吃内存/磁盘
// ============================================================
{
  const m = loadBrainModule({});
  const many = Array.from({ length: 4001 }, (_, i) => ({ text: 'm' + i, domain: '综合', weight: i }));
  const r = call(m.routes, 'POST /api/brain-snapshot', mkReq({ body: { consumer: 'bulk', memories: many } }));
  t('4001 条喂进去，落盘只留 4000 条（SNAPSHOT_MAX）', r.body.count === 4000);
}

// ============================================================
// [6] GET /api/brain-snapshot：SNAPSHOT_OFF 优先级 + 多份快照按权重合并
// 证据：server.js:2742 SNAPSHOT_OFF 分支排在 2744 的 brainMergeSnapshots() 之前。
// ============================================================
console.log('\n[6] GET /api/brain-snapshot：SNAPSHOT_OFF 优先级 + 权重合并');
{
  const m = loadBrainModule({ GRANCYAN_SNAPSHOT: 'off' });
  const r = call(m.routes, 'GET /api/brain-snapshot', mkReq({}));
  t('SNAPSHOT_OFF 时返回固定的空壳形状，且带 off:true',
    r.statusCode === 200 && r.body.ok === true && r.body.count === 0 && r.body.total === 0
    && r.body.updatedAt === 0 && Array.isArray(r.body.memories) && r.body.memories.length === 0 && r.body.off === true);
}
{
  const m = loadBrainModule({});
  // 直接往假磁盘种两份快照（跳过 POST，更接近"两个不同消费者各自推过一次"）：
  // 同一句话在两份里权重不同，必须留权重高的那份，而不是"先读到的赢"。
  const put = (consumer, memories) => m.fakeFs.writeFileSync(
    path.join(SNAPSHOT_DIR, consumer + '.json'),
    JSON.stringify({ consumer, updatedAt: Date.now(), count: memories.length, memories }));
  put('consumerLow',  [{ text: '重复的记忆', domain: '综合', weight: 1 }, { text: '只有A有', domain: '综合', weight: 5 }]);
  put('consumerHigh', [{ text: '重复的记忆', domain: '综合', weight: 9 }]);

  const r = call(m.routes, 'GET /api/brain-snapshot', mkReq({}));
  const dup = r.body.memories.find(x => x.text === '重复的记忆');
  t('★ 同一句话出现在两份快照里时，合并结果保留 weight 更高的那份', dup && dup.weight === 9);
  t('两份快照按 text 去重后一共 2 条', r.body.total === 2);
  t('不重复的那条也在（两份快照都参与了合并，不是只认一份）',
    r.body.memories.some(x => x.text === '只有A有'));

  const r2 = call(m.routes, 'GET /api/brain-snapshot', mkReq({ query: { limit: '1' } }));
  t('limit 生效：只返回权重最高的 1 条，但 total 仍然是完整计数',
    r2.body.memories.length === 1 && r2.body.memories[0].text === '重复的记忆' && r2.body.total === 2);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

})().catch(e => { console.error('💥 测试文件本身炸了：', e); process.exit(1); });
