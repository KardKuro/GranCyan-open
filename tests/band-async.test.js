/* 手环这条链路不许阻塞 UI 线程。
 *
 * 用户报「exe 老是卡住、未响应」，查到根因在这儿：
 *
 *   electron-main.js 里是 `require('./server.js')` —— server 跑在 **Electron 主进程**，
 *   和窗口消息循环同一根线程。而 server/band.js 用 execFileSync 同步调 adb，
 *   前端 `setInterval(fetchBandData, 120000)`、冷却 60 秒 < 120 秒，
 *   于是**每 2 分钟**在 UI 线程上跑一整套：devices / pidof / stat / 两条 broadcast /
 *   最多 6 轮 stat 轮询 / 最后 adb pull 一个 18.5 MB 的库。手机还是 WiFi 连的。
 *
 *   现场记录器抓到 20 次卡顿，间隔 118~132 秒，主进程「响应=NO」而 CPU 只有 0.2%
 *   （不是在算，是卡在等子进程），且常成对出现、相隔 8~9 秒 —— 广播那段、pull 那段。
 *
 * 实测同一个 2 秒的子进程：同步调 → 事件循环冻 2040ms；异步调 → 冻 11ms。
 * 那个数字就是窗口冻住的时长。
 *
 * 跑法：node tests/band-async.test.js
 */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'band.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

// 注释里当然会提到 execFileSync（讲的就是为什么不能用它）。只看代码。
const CODE = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

console.log('\n手环链路不许冻住窗口:');

t('★★ band.js 的代码里一处 execFileSync 都没有（它跑在 Electron 主进程，同步=窗口冻住）',
  !/execFileSync/.test(CODE), (CODE.match(/.*execFileSync.*/) || [])[0]);
t('☑ 对照：剥完注释还剩着实打实的代码（剥成空的话上面那条是假绿）',
  CODE.length > 2000 && /execFile\(/.test(CODE), CODE.length);

// ⚠️ 光看「有没有 execFileSync」不够。真正会静默失效的是**漏掉一个 await**：
//   adbCmd/adbOut 现在返回 Promise，漏 await 的话 `if (!adbCmd(...))` 里
//   那个 Promise 恒为真值 —— 判断永远走「成功」分支，pull 失败也报成功，
//   零报错，而且只在真出错时才暴露。
const CALLS = [...CODE.matchAll(/(?<!\w)(adbCmd|adbOut|adbDeviceState|remoteDbMtime)\s*\(/g)];
const defLines = new Set(['function adbCmd', 'function adbOut', 'function adbDeviceState', 'function remoteDbMtime']);
const missing = [];
for (const m of CALLS) {
    const line = CODE.slice(CODE.lastIndexOf('\n', m.index) + 1, CODE.indexOf('\n', m.index));
    if ([...defLines].some(d => line.includes(d))) continue;   // 定义那行不算调用
    if (!/await\s+(adbCmd|adbOut|adbDeviceState|remoteDbMtime)\s*\(/.test(line)) missing.push(line.trim());
}
t('★★ 每一个 adb 调用点都带着 await（漏一个就返回 Promise，判断恒为真、失败被吞掉）',
  missing.length === 0, missing);
t('☑ 对照：确实数到了调用点（数到 0 的话上面那条什么都没守）',
  CALLS.length >= 10, CALLS.length);

// ── 机制验证：同步 vs 异步，量的是事件循环延迟 = 窗口冻住的时长 ──
// ⚠️ 停表之前必须先让出一次事件循环。不让的话，同步那组的采样回调根本轮不到执行，
//   量出来是 0ms —— 看着像「同步也不卡」，把结论完全弄反（写这条测试时实犯）。
function watch() {
    let max = 0, expected = Date.now() + 50;
    const timer = setInterval(() => { const n = Date.now(); max = Math.max(max, n - expected); expected = n + 50; }, 50);
    return {
        async stop() {
            await new Promise(r => setTimeout(r, 0));
            clearInterval(timer);
            return max;
        },
    };
}

(async () => {
    const NODE = process.execPath;
    const SLEEP = ['-e', 'setTimeout(()=>{},1200)'];
    try { execFileSync(NODE, ['-e', '0']); } catch { }        // 预热，别让冷启动算进第一组

    let w = watch();
    try { execFileSync(NODE, SLEEP, { timeout: 15000 }); } catch { }
    const syncLag = await w.stop();

    w = watch();
    await new Promise(r => execFile(NODE, SLEEP, { timeout: 15000 }, () => r()));
    const asyncLag = await w.stop();

    console.log(`     （实测：同步冻 ${syncLag}ms，异步冻 ${asyncLag}ms）`);
    t('☑ 前提：同步调子进程确实会把事件循环冻住（不成立的话下面那条不说明任何事）',
      syncLag > 800, syncLag);
    t('★★ 换成异步之后事件循环基本不受影响 —— 这就是窗口不再「未响应」的原因',
      asyncLag < 200, asyncLag);

    console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试自己炸了:', e); process.exit(1); });
