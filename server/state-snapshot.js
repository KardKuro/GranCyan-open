'use strict';
// ==========================================
// 存档快照落硬盘：页面把 IndexedDB 里的整份存档 POST 过来，按天存成一个 JSON 文件。
//
// 为什么要有：测试时拿真实存档冷启动几十次、每次硬杀，
// IndexedDB 被 Chromium 删库重建。原来的备份（kuro_backup_ring 那套）也存在同一个 IndexedDB 里，
// 跟着一起没了；只存本机的数据最后只能从旧备份和会话记录里一点点捡回来。
// 这份放在硬盘上，跟 IndexedDB 分开，IndexedDB 再出什么事都能整份恢复。
//
//   · 只收本机的请求（pairGate.isLocalReq）：手机走局域网连过来的页面是另一份存档，不能混进来。
//   · 用 GRANCYAN_USER_DATA 起的一次性 exe（测量 / 调试用）不写，空存档别混进来。
//   · 按天一个文件，当天的覆盖；正常的留最近 KEEP 天。
//   · ⚠️ 比最近一份正常快照小了一半以上 → 不覆盖，另存成 -shrunk-时分秒.json。
//     今天这种「存档刚被清空」的状态，正是绝对不能把好快照冲掉的时候。
//     被清空之后每天都会是 shrunk，好的那份就一直不会被轮换掉。
// ==========================================
const fs = require('fs');
const path = require('path');

const KEEP = 14;          // 正常快照留几天
const KEEP_SHRUNK = 7;    // 变小的留几份
const SHRINK_RATIO = 0.5;
const NAME_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const SHRUNK_RE = /^\d{4}-\d{2}-\d{2}-shrunk-\d{6}\.json$/;

function pad(n) { return String(n).padStart(2, '0'); }
function dayOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// 纯逻辑：给定目录里现有的文件和这份的大小，决定写到哪、要删哪些。抽出来好测
function planSnapshot(existing, size, now) {
  const day = dayOf(now);
  const normal = existing.filter(f => NAME_RE.test(f.name)).sort((a, b) => a.name < b.name ? 1 : -1);
  const ref = normal[0];
  const shrunk = !!ref && size < ref.size * SHRINK_RATIO;
  const name = shrunk ? `${day}-shrunk-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json` : `${day}.json`;
  const remove = [];
  if (!shrunk) {
    const days = [...new Set([day, ...normal.map(f => f.name.slice(0, 10))])].sort().reverse();
    const keep = new Set(days.slice(0, KEEP));
    for (const f of normal) if (!keep.has(f.name.slice(0, 10))) remove.push(f.name);
  } else {
    const old = existing.filter(f => SHRUNK_RE.test(f.name)).map(f => f.name).sort().reverse();
    remove.push(...old.slice(KEEP_SHRUNK - 1));
  }
  return { name, shrunk, ref: ref ? ref.name : null, remove };
}

function registerStateSnapshot(app, { root, isLocalReq, express }) {
  const base = path.join(root, 'data-backups', 'state-daily');
  // 走 raw 不走 JSON：整份存档几十 MB，解析一遍再序列化一遍纯属浪费；只校验它是个对象
  app.post('/api/state-snapshot', express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
    if (process.env.GRANCYAN_USER_DATA) return res.json({ ok: false, skipped: 'throwaway-profile' });
    if (!isLocalReq(req)) return res.status(403).json({ error: '存档快照只收本机的' });
    const src = /^[a-z]{1,12}$/.test(String(req.query.src || '')) ? String(req.query.src) : 'web';
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let keys = 0;
    try {
      const o = JSON.parse(buf.toString('utf8'));
      if (!o || typeof o !== 'object' || Array.isArray(o) || !o.data || typeof o.data !== 'object') throw new Error('不是存档快照');
      keys = Object.keys(o.data).length;
    } catch (e) { return res.status(400).json({ error: '快照解析失败: ' + e.message }); }
    try {
      const dir = path.join(base, src);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
        .map(n => ({ name: n, size: fs.statSync(path.join(dir, n)).size }));
      const plan = planSnapshot(existing, buf.length, new Date());
      const tmp = path.join(dir, plan.name + '.tmp');
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(dir, plan.name));
      for (const n of plan.remove) { try { fs.unlinkSync(path.join(dir, n)); } catch (_) {} }
      if (plan.shrunk) console.warn(`[存档快照] 这份比 ${plan.ref} 小了一半以上，另存成 ${plan.name}，没覆盖好的那份`);
      res.json({ ok: true, file: plan.name, shrunk: plan.shrunk, keys, bytes: buf.length });
    } catch (e) {
      console.error('[存档快照] 写盘失败:', e && e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerStateSnapshot, planSnapshot };
