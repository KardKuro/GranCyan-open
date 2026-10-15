/* Ombre-Brain 记忆注入器 —— 在 GranCyan 页面的控制台里跑。
 *
 *   粘这一行：
 *     fetch('/scripts/ombre-inject.js').then(r=>r.text()).then(eval)
 *
 *   它只做体检、不写任何东西。看完报告确认无误后再敲：
 *     ombreImport.run()
 *
 * 为什么必须在页面里跑、而不是从命令行写库：
 *   IndexedDB 按 origin 隔离，http://localhost:3000 和 http://127.0.0.1:3000 是**两个库**。
 *   在页面里跑就不用猜——脚本直接报告当前 origin 和这个库里已有多少条记忆，对不上就别执行。
 */
(function () {
  'use strict';
  const SRC = '/scripts/ombre-memories.json';

  const fmt = n => String(n).padStart(4);
  const load = async () => {
    const r = await fetch(SRC, { cache: 'no-store' });
    if (!r.ok) throw new Error(`取不到 ${SRC}（HTTP ${r.status}）——先确认 server 跑的是放着这份 json 的那个项目目录`);
    return r.json();
  };

  // 本地 Claude 的 config id 只有页面里才知道。复用 app 自己的 defaultMemoryOwnerId()
  // （它按 isLocalClaude 标志 / nickname 正则「本地 Claude」找），找不到就退回手工匹配。
  function ownerId() {
    if (typeof defaultMemoryOwnerId === 'function') {
      const id = defaultMemoryOwnerId();
      if (id != null) return id;
    }
    const c = (state.configs || []).find(c => c.isLocalClaude)
      || (state.configs || []).find(c => /本地\s*claude/i.test(c.nickname || ''));
    return c ? c.id : null;
  }

  async function check(quiet) {
    const incoming = await load();
    const cur = state.brainMemories || [];
    // 去重要同时防两个方向：与现有库重复、以及 incoming 自己内部重复
    // （Ombre 里有 11 组同文本的条目，只比对现有库的话它们会成对导进来）。
    const seen = new Set(cur.map(m => (m.text || '').trim().toLowerCase()).filter(Boolean));
    const fresh = [];
    let selfDup = 0;
    for (const m of incoming) {
      const k = m.text.trim().toLowerCase();
      if (seen.has(k)) { continue; }
      seen.add(k); fresh.push(m);
    }
    selfDup = incoming.length - fresh.length - incoming.filter(m =>
      cur.some(c => (c.text || '').trim().toLowerCase() === m.text.trim().toLowerCase())).length;

    // 同 id 会让 UI 的 pin/删除/编辑操作到错的那条（按 id find）。1e9 号段本该和
    // nextId() 完全不相交，这里实测一遍，撞了就地重新发号。
    const curIds = new Set(cur.map(m => m.id));
    const collide = fresh.filter(m => curIds.has(m.id));

    const oid = ownerId();
    const owner = (state.configs || []).find(c => c.id === oid);

    if (!quiet) {
      console.log('%c── Ombre-Brain 导入体检 ──', 'font-weight:700;font-size:13px');
      console.log(`当前 origin      ${location.origin}`);
      console.log(`这个库里已有     ${fmt(cur.length)} 条高级记忆`);
      console.log(`待导入           ${fmt(incoming.length)} 条`);
      console.log(`  去掉重复文本后 ${fmt(fresh.length)} 条会真正新增` +
        (selfDup > 0 ? `（其中 ${selfDup} 条是 Ombre 内部的同文本副本）` : ''));
      console.log(`  id 撞号        ${fmt(collide.length)} 条` + (collide.length ? '（会自动重新发号）' : ''));
      console.log(`归属模型         ${owner ? `${owner.nickname || owner.modelName}（id=${oid}）` : '%c找不到「本地 Claude」配置'}`,
        owner ? '' : 'color:#f66;font-weight:700');
      console.log(`导入后总数       ${fmt(cur.length + fresh.length)} 条`);
      if (!owner) {
        console.log('%c⚠ 没找到本地 Claude 配置，run() 会拒绝执行。先确认这个 origin 是你平时用的那个。',
          'color:#f66');
      } else {
        console.log('%c确认无误就敲：ombreImport.run()', 'color:#6c9;font-weight:700');
      }
    }
    return { incoming, cur, fresh, collide, oid, owner };
  }

  async function run() {
    const { cur, fresh, oid, owner, collide } = await check(true);
    void collide;   // check() 里已经算过，run() 下面按实际 id 再判一次
    if (!owner) { console.error('没找到「本地 Claude」配置，中止。'); return; }
    if (!fresh.length) { console.log('没有新条目，无需导入。'); return; }

    // 先备份。整包 upsert 是「最后写入者赢」，任何一步出岔子都要能原样退回去。
    const backup = JSON.stringify(cur);
    const url = URL.createObjectURL(new Blob([backup], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `brainMemories-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log(`已下载备份：${cur.length} 条原有记忆`);

    let next = Math.max(0, ...cur.map(m => Number(m.id) || 0)) + 1;
    const curIds = new Set(cur.map(m => m.id));
    for (const m of fresh) {
      if (curIds.has(m.id)) m.id = next++;
      curIds.add(m.id);
      m.modelIds = [oid];
      delete m._ombreId; delete m._layer;   // 调试字段，不进库
    }

    // 走 state + save()：持久化有三道白名单（_doSave / loadStateFromDB / 启动赋值），
    // 绕过 save() 直接写 IDB 会在下次刷新时被静默覆盖。
    state.brainMemories = [...cur, ...fresh];
    save();
    if (typeof renderMemoryBadge === 'function') renderMemoryBadge();
    if (typeof renderBrainMemList === 'function') renderBrainMemList();

    console.log(`%c✓ 已导入 ${fresh.length} 条，现在共 ${state.brainMemories.length} 条`,
      'color:#6c9;font-weight:700');
    console.log('刷新页面后再看一眼数量对不对（对得上才算真落盘）。');
    console.log('%c注意：云同步是整包 upsert，这次会把约 680KB 推上去。' +
      '要是同步开始报错或卡住，把备份文件拖回来即可还原。', 'color:#e9a');
  }

  window.ombreImport = { check: () => check(false), run };
  check(false);
})();
