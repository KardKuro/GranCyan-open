'use strict';
const fs = require('node:fs');

function createFaultLock(lockFile, warn = () => {}) {
  let held = false;
  const readPid = file => {
    try { return Number(fs.readFileSync(file, 'utf8').trim()) || 0; }
    catch { return 0; }
  };
  const pidAlive = p => {
    try { if (!p) return false; process.kill(p, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  };
  const refuse = message => { throw new Error(message); };

  function publish() {
    const tmp = lockFile + '.pending.' + process.pid + '.' + Math.random().toString(16).slice(2);
    fs.writeFileSync(tmp, String(process.pid), { flag: 'wx' });
    try {
      // 唯一的发布动作：锁名可见时，pid 已经在 inode 里，不存在 mkdir/write 的空窗。
      fs.linkSync(tmp, lockFile);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function take() {
    for (let i = 0; i < 3; i++) {
      try {
        publish();
        held = true;
        if (readPid(lockFile) !== process.pid) {
          held = false;
          refuse('❌ 锁刚建好就不是我的了 —— 有别的进程在抢，拒绝启动。');
        }
        return;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }

      const old = readPid(lockFile);
      // 内容读不出来时一律 fail-closed。否则另一个进程刚发布锁、pid 还没写好的窗口会被当死锁抢占。
      if (!old) {
        refuse(`❌ 锁存在但 pid 读不出来，按活锁处理、拒绝抢占：${lockFile}\n确认没有 fault-inject 在跑后，请手工删除这一个锁文件。`);
      }
      if (pidAlive(old)) refuse(`❌ 另一个 fault-inject 正在跑（pid ${old}）。两个一起跑会互相踩源码，拒绝启动。`);

      // 死 pid 才能接管；rename 原子地分出唯一赢家，挪走后再核对没有误伤一把刚易主的新锁。
      const parked = lockFile + '.stale.' + process.pid + '.' + i;
      try { fs.renameSync(lockFile, parked); }
      catch { continue; }
      const got = readPid(parked);
      if (got !== old) {
        try { fs.renameSync(parked, lockFile); } catch {}
        refuse(`❌ 抢占的时候撞上了另一个进程（锁里是 pid ${got}），已归还，拒绝启动。`);
      }
      warn(`⚠ 捡到一把陈旧的锁（pid ${old} 已经不在了），接管。`);
      try { fs.unlinkSync(parked); } catch {}
    }
    refuse('❌ 抢不到锁，拒绝启动。');
  }

  function drop() {
    if (!held) return;
    held = false;
    if (readPid(lockFile) !== process.pid) return;
    try { fs.unlinkSync(lockFile); } catch {}
  }

  return { take, drop };
}

module.exports = { createFaultLock };
