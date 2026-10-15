'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'fault-inject.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grancyan-fault-lock-'));
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); fail++; }
}
function worker(lock, log, extra = {}) {
  const env = Object.assign({}, process.env, {
    GRANCYAN_FAULT_INJECT_LOCK: lock,
    GRANCYAN_FAULT_INJECT_HOLD_MS: '350',
    GRANCYAN_FAULT_INJECT_PUBLISH_DELAY_MS: '220'
  }, extra);
  const child = spawn(process.execPath, [script, '--lock-probe=' + log], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { out += b; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, out })));
  return { child, done };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    console.log('\n【故障注入锁】');
    {
      const lock = path.join(tmp, 'atomic.lock');
      const log = path.join(tmp, 'atomic.log');
      const w = worker(lock, log);
      let sawEmpty = false;
      const until = Date.now() + 500;
      while (Date.now() < until) {
        if (fs.existsSync(lock)) {
          let body = '';
          try { body = fs.readFileSync(lock, 'utf8').trim(); } catch {}
          if (!/^\d+$/.test(body)) sawEmpty = true;
          if (/^\d+$/.test(body)) break;
        }
        await wait(3);
      }
      const r = await w.done;
      t('★ 锁名一出现就已经带着 pid（没有 mkdir/write 的空窗）', !sawEmpty && r.code === 0, { sawEmpty, code: r.code, out: r.out });
    }

    {
      const lock = path.join(tmp, 'race.lock');
      const log = path.join(tmp, 'race.log');
      const a = worker(lock, log);
      await wait(20);
      const b = worker(lock, log);
      const [ra, rb] = await Promise.all([a.done, b.done]);
      const enters = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(x => x.startsWith('enter ')) : [];
      t('★ 两个进程同时启动，最多一个进入临界区', enters.length === 1, { enters, codes: [ra.code, rb.code] });
    }

    {
      const lock = path.join(tmp, 'invalid.lock');
      const log = path.join(tmp, 'invalid.log');
      fs.writeFileSync(lock, '');
      const r = await worker(lock, log, { GRANCYAN_FAULT_INJECT_HOLD_MS: '0' }).done;
      const entered = fs.existsSync(log) && /enter /.test(fs.readFileSync(log, 'utf8'));
      t('★ pid 读不出来时 fail-closed，不抢占也不删除证据', r.code !== 0 && !entered && fs.existsSync(lock), { code: r.code, out: r.out });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + (fail ? '✗ ' + fail + ' 条没过' : '✓ 全过') + '（共 ' + (pass + fail) + ' 条）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
