/* 删掉的对话不许自己回来。
 *
 * 用户原话：「一些没用的对话我反复删除了十几次又冒出来（明明也去回收站删掉了」。
 * 根因是三条路合起来的，三条都得钉住：
 *   ① deleteSelectedChats（批量删）根本没删云端
 *   ② deleteChat（单个删）即发即忘，失败静默
 *   ③ loadChatsFromCloud 的「清点补漏」每次启动把「本地没有而云端有」的拉回来
 *
 * [1]~[5] 在 vm 里真的跑墓碑逻辑（合并语义容易错，扫源码看不出来）
 * [6]~[9] 扫源码钉住那些「跑不出来但错了就复活」的接线
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const group = n => console.log('\n' + n);

// ── 沙箱：只挖 02-state.js 里的墓碑那一段 ─────────────────
function makeSandbox(initial) {
  const sandbox = {
    console, state: { deletedChats: initial ? JSON.parse(JSON.stringify(initial)) : {} },
    Date, Math, Number, Object, JSON, Infinity,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = read('js/02-state.js');
  const from = src.indexOf('const TOMBSTONE_TTL_DAYS');
  const to = src.indexOf('async function _doSave');
  if (from < 0 || to < 0) throw new Error('02-state.js 里的墓碑段切不出来，锚点变了');
  vm.runInContext(src.slice(from, to), sandbox, { filename: '02-tombstone-slice.js' });
  vm.runInContext('this.__TTL = TOMBSTONE_TTL_DAYS;', sandbox);
  return sandbox;
}

// ══════════════════════════════════════════════════════════
group('[1] 打墓碑 / 查墓碑');

{
  const sb = makeSandbox();
  sb.markChatDeleted(123);
  ok(sb.isChatDeleted(123), '打完就查得到');
  ok(sb.isChatDeleted('123'), '❗数字 id 和字符串 id 是同一条（键统一成字符串）');
  ok(!sb.isChatDeleted(456), '没删过的查不到');
  ok(sb.state.deletedChats['123'].cloud === 'pending', '默认是 pending（云端还没确认删干净）');
}
{
  const sb = makeSandbox();
  sb.markChatDeleted(null);
  sb.markChatDeleted(undefined);
  ok(Object.keys(sb.state.deletedChats).length === 0, 'null / undefined 不打墓碑');
  ok(!sb.isChatDeleted(null) && !sb.isChatDeleted(undefined), 'null / undefined 查出来不算已删');
}
{
  /* ❗对象继承来的属性不能被当成墓碑。用 `in` 或 `obj[k]` 判断的话，
     id 恰好叫 'constructor' / 'toString' 时会永远返回真 —— 那个对话就再也同步不下来了。 */
  const sb = makeSandbox();
  ok(!sb.isChatDeleted('constructor'), '❗constructor 不算已删（原型链上的属性）');
  ok(!sb.isChatDeleted('toString'), '❗toString 不算已删');
  ok(!sb.isChatDeleted('__proto__'), '❗__proto__ 不算已删');
}

// ══════════════════════════════════════════════════════════
group('[2] 云端删干净了才算 done');

{
  const sb = makeSandbox();
  sb.markChatDeleted(1);
  sb.markChatDeleted(2);
  ok(sb.pendingTombstoneIds().sort().join() === '1,2', '两条都在待重试队列里');
  sb.markTombstoneCloudDone(1);
  ok(sb.pendingTombstoneIds().join() === '2', '确认删掉的退出队列');
  ok(sb.isChatDeleted(1), '❗但墓碑还在 —— 云端删了不等于本地可以忘了它');
}

// ══════════════════════════════════════════════════════════
group('[3] ❗过期清理只能清确认删干净的');

{
  const sb = makeSandbox();
  const old = Date.now() - (sb.__TTL + 10) * 864e5;
  sb.state.deletedChats = {
    '1': { at: old, cloud: 'done' },
    '2': { at: old, cloud: 'pending' },
    '3': { at: Date.now(), cloud: 'done' },
  };
  const n = sb.pruneTombstones();
  ok(n === 1, '只清掉 1 条');
  ok(!sb.isChatDeleted(1), '又老又确认删干净的，清掉');
  ok(sb.isChatDeleted(2),
    '❗老但**没**确认删干净的，留着（云端可能还有那行，清了墓碑它就又能回来了）');
  ok(sb.isChatDeleted(3), '新的留着');
}

// ══════════════════════════════════════════════════════════
group('[4] ❗多设备合并：谁的删除都不许被撤销');

{
  const sb = makeSandbox();
  const mine = { '1': { at: 1000, cloud: 'done' } };
  const theirs = { '2': { at: 2000, cloud: 'done' } };
  const m = sb.mergeTombstones(mine, theirs);
  ok(Object.keys(m).sort().join() === '1,2', '❗并集 —— 两台各自删的都算数');
}
{
  /* ❗done 获胜，而且这条**必须收敛**。
     第一版写的是「pending 优先，更保守」，Codex 指出它不收敛：
     云端 pending + 本机刚删成功标 done → 合并变回 pending → 又删一次 → 又标 done
     → 下一轮同步又变 pending …… 无限循环，每轮都真往云端发删除请求。 */
  const sb = makeSandbox();
  const m = sb.mergeTombstones(
    { '1': { at: 1000, cloud: 'done' } },
    { '1': { at: 1000, cloud: 'pending' } });
  ok(m['1'].cloud === 'done',
    '❗一边 done 一边 pending → done（pending 优先会来回翻转，永不收敛）');

  // 收敛性：把合并结果再喂回去，状态不能再变
  const again = sb.mergeTombstones(m, { '1': { at: 1000, cloud: 'pending' } });
  ok(again['1'].cloud === 'done',
    '❗再合一次还是 done —— 这就是「收敛」，少了它就是无限重删');
}
{
  /* ❗墓碑表必须无原型。用 `{}` 的话 t['__proto__'] = {...} 不建 own property，
     而是去设置这个表自己的原型 → 那个 id 打不上墓碑，永远可复活，且零报错。 */
  const sb = makeSandbox();
  sb.markChatDeleted('__proto__');
  ok(sb.isChatDeleted('__proto__'),
    '❗id 是 __proto__ 也能真的打上墓碑（拿 {} 当表的话这里会红）');
  /* ⚠️ 这里**必须**用 JSON.parse 造，不能写对象字面量。
     字面量里的 `__proto__:` 是特殊语法 —— 它设置原型，**不**建 own property，
     那样等于什么都没传进去，断言测的是个空气。（第一版就是这么红的。）
     而 JSON.parse 用的是 CreateDataProperty，产出真正的 own property，
     这也正是云端数据回到本机时走的那条路。 */
  const dirty = JSON.parse('{"__proto__":{"at":1,"cloud":"done"}}');
  ok(Object.prototype.hasOwnProperty.call(dirty, '__proto__'),
    '（前提）JSON.parse 造出来的 __proto__ 是真的 own property');
  const mp = sb.mergeTombstones(dirty, {});
  ok(Object.prototype.hasOwnProperty.call(mp, '__proto__'),
    '❗合并结果里 __proto__ 也是 own property');
  ok(({}).cloud === undefined, '没有污染到全局 Object.prototype');
}
{
  const sb = makeSandbox();
  const m = sb.mergeTombstones(
    { '1': { at: 5000, cloud: 'done' } },
    { '1': { at: 1000, cloud: 'done' } });
  ok(m['1'].at === 1000, '❗at 取更早的（TTL 从第一次删算起，不然墓碑被反复刷新永不过期）');
  ok(m['1'].cloud === 'done', '两边都 done 才是 done');
}
{
  const sb = makeSandbox();
  ok(Object.keys(sb.mergeTombstones(null, null)).length === 0, '两边都空不炸');
  ok(Object.keys(sb.mergeTombstones({ '1': null }, undefined)).length === 0, '脏数据被滤掉');
  const m2 = sb.mergeTombstones({ '1': { cloud: 'done' } }, {});
  ok(Number.isFinite(m2['1'].at), '❗缺 at 字段时补一个有限值（不然 TTL 比较会永远为假）');
}

// ══════════════════════════════════════════════════════════
group('[5] 恢复对话不需要撤墓碑');

{
  const restore = read('js/13-trash-ctx-ui.js');
  /* restoreChatFromTrash 会 `chat.id = nextId()` 发新号，恢复出来的是新 id 的对话，
     跟旧 id 的墓碑不冲突。所以墓碑永不需要撤销 —— 反过来，
     要是有人「顺手」在恢复时删墓碑，旧 id 就重新变得可复活了。 */
  const fn = restore.slice(restore.indexOf('function restoreChatFromTrash'),
                           restore.indexOf('function restoreFavFromTrash'));
  ok(/chat\.id = nextId\(\)/.test(fn), '（前提）恢复时会发新 id');
  ok(!/delete .*deletedChats|markChatRestored|unmarkChatDeleted/.test(fn),
    '❗恢复时**不**撤墓碑（撤了旧 id 就又能复活了）');
}

// ══════════════════════════════════════════════════════════
group('[6] ❗三条复活路径都堵上了');

{
  const core = read('js/01-core.js');

  // 路径③：清点补漏 —— 「本地没有而云端有」被当成漏了拉回来
  const reconcile = core.slice(core.indexOf('清点补漏'), core.indexOf('清点补漏') + 1200);
  ok(/isChatDeleted\(id\)/.test(reconcile),
    '❗清点补漏跳过有墓碑的（这里是复活引擎的正身，光挡 merge 不够）');

  // mergeCloudChats 纯并集，云端有本地没有的一律加回来
  const merge = core.slice(core.indexOf('function mergeCloudChats'),
                           core.indexOf('function mergeCloudChats') + 1400);
  ok(/isChatDeleted\(chat\.id\)/.test(merge), '❗合并时跳过有墓碑的');
  /* ⚠️ 只看 cloudChats 那个循环。函数里 `chatMap.set(chat.id, chat)` 出现两次，
     第一次是把**本地**对话装进 Map（在墓碑检查之前，理所当然），
     扫全函数的话 indexOf 抓到的是那一处，断言会红得莫名其妙。 */
  const cloudLoop = merge.slice(merge.indexOf('cloudChats.forEach'));
  ok(cloudLoop.indexOf('isChatDeleted') < cloudLoop.indexOf('chatMap.set'),
    '❗墓碑检查在写入之前');

  // 别把有墓碑的推回云端
  const push = core.slice(core.indexOf('async function syncChatsToCloud'),
                          core.indexOf('async function syncChatsToCloud') + 1200);
  ok(/isChatDeleted\(chat\.id\)/.test(push), '❗有墓碑的绝不往云端推');
  ok(/retryPendingChatDeletes\(\)/.test(push), '❗每次同步重试没删干净的');
}

// ══════════════════════════════════════════════════════════
group('[7] ❗删除必须真的发生，不能假装成功');

{
  const core = read('js/01-core.js');
  const del = core.slice(core.indexOf('async function deleteChatsFromCloud'),
                         core.indexOf('async function retryPendingChatDeletes'));
  /* cloudRetry 开头是 `if (!navigator.onLine) return;` —— 离线时返回 undefined 不抛错。
     删除走它的话，离线会被当成删成功，墓碑标 done，云端那行却还在。 */
  ok(!/cloudRetry/.test(del),
    '❗删除不走 cloudRetry（它离线时静默返回，会被当成删成功）');
  ok(/navigator\.onLine/.test(del), '离线时直接不试，留给下次');
  ok(/if \(error\)/.test(del),
    '❗查了返回值里的 error —— supabase 的 delete 不 throw，只看异常等于假成功');
  ok(/return done/.test(del) || /done\.push/.test(del),
    '❗返回真正删成功的 id，调用方按它标 done');

  const chats = read('js/03-chats-models.js');
  const purge = chats.slice(chats.indexOf('function purgeDeletedChatsFromCloud'),
                            chats.indexOf('function purgeDeletedChatsFromCloud') + 900);
  ok(/\.catch\(/.test(purge), '❗接了 reject（原来只接成功回调，网络异常时什么都不弹）');
  ok(/markTombstoneCloudDone/.test(purge), '删成功才标 done');
}

// ══════════════════════════════════════════════════════════
group('[8] ❗两个删除入口都要打墓碑 + 删云端');

{
  const chats = read('js/03-chats-models.js');
  const one = chats.slice(chats.indexOf('function deleteChat(id, e)'),
                          chats.indexOf('function purgeDeletedChatsFromCloud'));
  // 2026-10-03：后面多带了 claude.ai 来源（导入的对话删掉后再导不复活），所以认 `(id)` 或 `(id, …)`
  ok(/markChatDeleted\(id[,)]/.test(one), '单个删：打墓碑');
  ok(/purgeDeletedChatsFromCloud\(\[id\]\)/.test(one), '单个删：删云端');
  ok(!/\.then\(\(\{ error \}\) =>/.test(one), '❗不再是即发即忘的老写法');

  const batch = read('js/08-edit-trash.js');
  const many = batch.slice(batch.indexOf('function deleteSelectedChats'),
                           batch.indexOf('state.trashSelectMode = false'));
  /* ❗这条是主因：批量删原来**一行云端删除都没有**，删掉的对话下次启动全回来。 */
  ok(/markChatDeleted\(id\)/.test(many), '❗批量删：打墓碑');
  ok(/purgeDeletedChatsFromCloud\(/.test(many), '❗批量删：删云端（原来完全没有）');
  ok(many.indexOf('const goneIds') < many.indexOf('toggleChatSelectMode()'),
    '❗先把 id 取出来再 toggleChatSelectMode —— 那个函数会 clear() 掉选中集合');
}

// ══════════════════════════════════════════════════════════
group('[9] ❗持久化三道关（漏一道刷新即失，且零报错）');

{
  ok(/idbSet\('kuro_deletedChats'/.test(read('js/02-state.js')),
    '第 1 道：_doSave 写盘');
  ok(/deletedChats:\s*await g\('kuro_deletedChats'/.test(read('js/01-core.js')),
    '第 2 道：loadStateFromDB 读回来');
  ok(/state\.deletedChats\s*=/.test(read('js/14-boot-brain-hub.js')),
    '第 3 道：启动赋值块');
  ok(/deletedChats: \{\}/.test(read('js/02-state.js')),
    'state 初始值里有它');

  // 上云那条：不上云的话另一台会把它推回来，删除只在执行删除的那台生效
  const core = read('js/01-core.js');
  ok(/deletedChats: state\.deletedChats/.test(core), '墓碑进云端 settings');
  ok(/mergeTombstones\(settings\.deletedChats, cloud\.deletedChats\)/.test(core),
    '❗按并集合并再 upsert（直接整包推会把另一台刚记的删除冲掉）');
  const mergeIdx = core.indexOf('mergeTombstones(settings.deletedChats');
  ok(mergeIdx > 0 && mergeIdx < core.indexOf('await pushCloudSettings'),
    '❗合并发生在 upsert 之前');
}

// ══════════════════════════════════════════════════════════
group('[10] ❗Codex 审出来的另外四条写回路径');

{
  const core = read('js/01-core.js');

  // ① manualSyncAll 整包重推，绕过墓碑
  const manual = core.slice(core.indexOf('async function manualSyncAll'),
                            core.indexOf('async function manualSyncAll') + 1400);
  ok(/isChatDeleted\(c\.id\)/.test(manual),
    '❗手动「☁ 同步对话」也滤墓碑 —— 我原来的前提「有墓碑的不该在 state.chats 里」是错的：'
    + '收到别的设备墓碑时本机故意不删本地那份，备份恢复也会把旧 id 塞回来');
  ok(/retryPendingChatDeletes\(\)/.test(manual), '手动同步也先把欠的删除补掉');

  // ② settings 和 chats 并行 → 新设备拉 chats 时墓碑还没到
  const load = core.slice(core.indexOf('async function loadFromCloud'),
                          core.indexOf('async function loadFromCloud') + 1600);
  ok(/await fetchCloudSettings\(\)/.test(load),
    '❗先 await 把 settings（墓碑在里面）拿回来');
  ok(load.indexOf('mergeTombstones') < load.indexOf('profilePromise'),
    '❗墓碑在 chats 开拉之前就合好了（并行的话新设备第一次登录必然漏收）');

  // ③ 合并后要 prune，不然 TTL 永远不生效
  const push = core.slice(core.indexOf('mergeTombstones(settings.deletedChats'),
                          core.indexOf('mergeTombstones(settings.deletedChats') + 700);
  ok(/pruneTombstones\(\)/.test(push),
    '❗并集合并**之后**才 prune（只在本地清的话，下次合并又被云端加回来，TTL 白设）');

  // ④ 启动自动从备份恢复，会把已删的对话整包塞回来
  const boot = read('js/14-boot-brain-hub.js');
  /* ⚠️ 切到「主数据非空」那个 else 分支为止，别写死字节数 ——
     写死的话，往这段里加两行注释就会把断言挤出切片，红得莫名其妙。 */
  const restore = boot.slice(boot.indexOf('主数据为空'), boot.indexOf('主数据非空'));
  ok(/deletedChats/.test(restore) && /filter/.test(restore),
    '❗启动自动恢复按墓碑滤一道（备份是删除之前拍的，直接塞回去等于全部复活）');
  ok(/跳过 \$\{dropped\}/.test(restore) || /dropped/.test(restore),
    '跳过了几个要说一声，别让人以为备份少了东西');
  ok(/chatsMsgCount\(kept\)/.test(restore),
    '❗消息数按过滤**后**的重算（用 best.msgCount 的话会显示"恢复 10 个对话 / 100 条消息"）');
}

// ══════════════════════════════════════════════════════════
group('[11] ❗Codex 二审：done 不是永久保证，拉取要 fail closed');

{
  const core = read('js/01-core.js');

  /* ① done 只证明「删的那一刻没报错」。A 删完标 done 后，还没收到墓碑的 B
        一编辑就把同一个 chat_id 又 upsert 上去；done 不再重试、missing 又跳过它，
        那行一直赖着，等 TTL 到了墓碑被 prune 就复活了。
        清点是唯一能看见「云端到底还有没有」的地方。 */
  const reconcile = core.slice(core.indexOf('清点补漏'), core.indexOf('清点补漏') + 2400);
  ok(/zombies/.test(reconcile) && /markTombstoneCloudPending/.test(reconcile),
    '❗反向清点：云端还留着已删对话的行 → 打回 pending 重删');
  ok(/retryPendingChatDeletes\(\)/.test(reconcile), '打回之后立刻重试删除');

  const st = read('js/02-state.js');
  ok(/function markTombstoneCloudPending/.test(st), 'markTombstoneCloudPending 在');
  ok(/RLS/.test(st) || /零行受影响/.test(st),
    '注释里记下了「DELETE 没 error 也可能是零行受影响」——这才是要事后清点的原因');

  /* ② 预取墓碑失败时必须 fail closed。fetchCloudSettings 出错通常**不抛异常**，
        而是返回 { data:null, error } —— try/catch 接不住。 */
  const load = core.slice(core.indexOf('async function loadFromCloud'),
                          core.indexOf('async function loadFromCloud') + 2000);
  ok(/tombstonesReady/.test(load), '有一个"墓碑到手了没"的显式标志');
  ok(/if \(!tombstonesReady\)[\s\S]{0,200}return;/.test(load),
    '❗拿不到墓碑就这一轮不拉 chats（fail closed，不是照拉）');
  ok(/pre\.error\.code === 'PGRST116'/.test(load),
    '❗新账号没有 profile 行（PGRST116）算正常，别把新用户卡死在"不同步"');
  ok(!/Promise\.resolve\(_preSettings \|\| fetchCloudSettings\(\)\)/.test(load),
    '❗没有"失败了就再并行拉一次"的老写法（那次重拉跟 chats 并行，墓碑照样晚到）');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
