// 整份存档落硬盘（server/state-snapshot.js + 02-state.js 的 stateSnapshotToDisk）。
// 2026-10-10 IndexedDB 被硬杀 exe 弄得整个重建，原来那套备份也在同一个 IndexedDB 里，跟着没了。
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const express = require('express');
const ROOT = path.resolve(__dirname, '..');
const { registerStateSnapshot, planSnapshot } = require(path.join(ROOT, 'server/state-snapshot.js'));
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

(async () => {
  console.log('\n[落盘规则]');
  const now = new Date(2026, 9, 10, 15, 30, 5);
  let p = planSnapshot([], 1000, now);
  t('第一份就叫当天的日期', p.name === '2026-10-10.json' && !p.shrunk);
  p = planSnapshot([{ name: '2026-10-10.json', size: 1000 }], 1200, now);
  t('同一天再存一份覆盖当天那个', p.name === '2026-10-10.json' && p.remove.length === 0);
  p = planSnapshot([{ name: '2026-10-09.json', size: 30e6 }, { name: '2026-10-10.json', size: 30e6 }], 2e6, now);
  t('★ 存档被清空（小了一半以上）→ 另存成 shrunk，不覆盖好的那份', p.shrunk && p.name === '2026-10-10-shrunk-153005.json' && p.remove.length === 0);
  const many = Array.from({ length: 16 }, (_, i) => ({ name: `2026-09-${String(10 + i).padStart(2, '0')}.json`, size: 1000 }));
  p = planSnapshot(many, 1000, now);
  t('正常的只留最近 14 天，删最老的', p.remove.length === 3 && p.remove.includes('2026-09-10.json') && !p.remove.includes('2026-09-25.json'));
  p = planSnapshot([{ name: '2026-09-01.json', size: 30e6 }, ...Array.from({ length: 9 }, (_, i) => ({ name: `2026-10-0${i + 1}-shrunk-000000.json`, size: 10 }))], 10, now);
  t('★ 清空之后天天都是 shrunk：好的那份一直不被轮换掉，shrunk 的只留 7 份', p.shrunk && !p.remove.includes('2026-09-01.json') && p.remove.length === 3);

  console.log('\n[接口]');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-snap-'));
  let local = true;
  const app = express();
  app.use(express.json({ limit: '1mb' }));      // 跟 server.js 一样有全局 JSON 解析，确认 raw 那条不被它截走
  registerStateSnapshot(app, { root, isLocalReq: () => local, express });
  const srv = app.listen(0, '127.0.0.1'); await new Promise(r => srv.on('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/state-snapshot?src=exe`;
  const post = async body => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }); return { status: r.status, j: await r.json() }; };
  const big = JSON.stringify({ v: 1, data: { kuro_chats: 'x'.repeat(3e6), kuro_studyCards: '[]' } });   // 比全局 JSON 的 1mb 上限大
  let r = await post(big);
  const dir = path.join(root, 'data-backups', 'state-daily', 'exe');
  const today = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  t('★ 整份存档写进 data-backups/state-daily/exe/当天.json，内容原样', r.status === 200 && r.j.ok && today.length === 1 && fs.readFileSync(path.join(dir, today[0]), 'utf8') === big);
  r = await post(JSON.stringify({ v: 1, data: { kuro_chats: '[]' } }));
  t('★ 接口层面：清空后的小存档不覆盖当天的好快照', r.j.shrunk && fs.readFileSync(path.join(dir, today[0]), 'utf8') === big);
  t('没有残留的 .tmp', !fs.readdirSync(dir).some(n => n.endsWith('.tmp')));
  r = await post('不是 JSON');
  t('不是存档快照的东西 → 400，不落盘', r.status === 400);
  local = false;
  r = await post(big);
  t('★ 不是本机的请求（手机走局域网）→ 403', r.status === 403);
  local = true;
  process.env.GRANCYAN_USER_DATA = path.join(root, 'throwaway');
  const before = fs.readdirSync(dir).length;
  r = await post(big);
  t('★ 一次性存档起的 exe 不写', r.j.skipped === 'throwaway-profile' && fs.readdirSync(dir).length === before);
  delete process.env.GRANCYAN_USER_DATA;
  // 连接关干净再往下走：fetch 留着 keep-alive 长连接时直接 process.exit，
  // Windows 上 libuv 偶尔断言崩（UV_HANDLE_CLOSING，src\win\async.c），断言全绿退出码却非 0
  srv.closeAllConnections();
  await new Promise(r => srv.close(r));
  fs.rmSync(root, { recursive: true, force: true });

  console.log('\n[页面 / 接线]');
  const st = fs.readFileSync(path.join(ROOT, 'js/02-state.js'), 'utf8');
  const skip = new RegExp(st.match(/const STATE_SNAPSHOT_SKIP = \/(.+)\/;/)[1]);
  t('滚动槽和聊天备份槽不带（跟 kuro_chats 重复），别的都带',
    skip.test('kuro_backup_slot_2026-10-10T03:15:52.098Z') && skip.test('kuro_chats_backup') && skip.test('kuro_chats_safe')
    && !skip.test('kuro_chats') && !skip.test('kuro_studyCards') && !skip.test('kuro_backup_ring'));
  t('只在电脑本机的页面上跑', /if \(typeof location === 'undefined' \|\| !\/\^\(127\\\.0\\\.0\\\.1\|localhost\)\$\/\.test\(location\.hostname\)\) return/.test(st));
  t('★ 存档还没读进来（没有 kuro_chats）时不存', /if \(!data\.kuro_chats\) return/.test(st));
  const boot = fs.readFileSync(path.join(ROOT, 'js/14-boot-brain-hub.js'), 'utf8');
  t('★ 启动时挂上定时快照', /stateSnapshotSchedule\(\);/.test(boot));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('★ server.js 注册了快照接口，只收本机', /registerStateSnapshot\(app, \{ root: ROOT, isLocalReq: req => pairGate\.isLocalReq\(req\), express \}\)/.test(server));
  t('Android 副本与 js/02-state.js、14-boot-brain-hub.js 一致', ['02-state.js', '14-boot-brain-hub.js'].every(f =>
    fs.readFileSync(path.join(ROOT, 'js', f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;   // 不用 process.exit：让事件循环自己收完再退（原因见上面关连接那段）
})().catch(e => { console.error(e); process.exitCode = 1; });
