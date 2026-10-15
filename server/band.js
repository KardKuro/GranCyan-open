// server/band.js
// 手环数据 — ADB 拉取 + 本地 SQLite 读取（docs/server-split-plan.md Phase 1 第三块）。
// deps：ROOT（装配校验用）；可选 env（测试注入用，默认 process.env）。
// 默认关：没设 GRANCYAN_BAND_DB_REMOTE 时一条 adb 都不跑。
//
// doctor 检查项（registerDoctorCheck('band', ...)）随分区一起搬进 mount()，
// 留在原相对位置（ADB_EXE 定义之后）——这是 doctor 注册制第一次实战检验。
// 注册器本身仍是同一个共享单例 server/doctor-registry.js（Node 模块缓存保证
// 这里 require 到的和 server.js 里 require 到的是同一个对象），不必经 deps 传。
//
// mount() 开头校验依赖：漏传就在启动时炸，不留到真实请求才 502
// （挂载探针只走校验分支，逮不住漏传——模板规则，音乐块 Codex 二轮定的）。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const initSqlJs = require('sql.js');
const { register: registerDoctorCheck, ok: dOk, warn: dWarn, exists: dExists } = require('./doctor-registry');

// adb 的位置：GRANCYAN_ADB 指定；没设就去 PATH 上找（Android SDK platform-tools 装好后一般都在 PATH 里）。
// 找不到时返回裸名字，下面的 existsSync 判成 adb-missing，doctor 会提示。
function findAdb() {
    if (process.env.GRANCYAN_ADB) return process.env.GRANCYAN_ADB;
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    for (const d of String(process.env.PATH || '').split(path.delimiter)) {
        if (!d) continue;
        const p = path.join(d, exe);
        try { if (fs.existsSync(p)) return p; } catch (_) { }
    }
    return exe;
}
const ADB_EXE = findAdb();

function mount(app, deps) {
    if (!app || !deps || !deps.ROOT) {
        throw new Error('band.mount: 缺依赖（app/ROOT）—— 装配层漏传了');
    }
    // ROOT 只留着做装配校验；拉下来的库不再写进项目根目录（见下面 DB_LOCAL）。
    const env = deps.env || process.env;

    // ⚠️ 默认关。手环链路会对连着的手机跑 adb（拉起 App、发广播、pull 数据库），
    //    所以必须显式配置手机上导出文件的路径才启用：GRANCYAN_BAND_DB_REMOTE。
    //    没配的时候 /api/band-data 直接回「未启用」，一条 adb 都不跑。
    const DB_REMOTE = String(env.GRANCYAN_BAND_DB_REMOTE || '').trim();
    const BAND_ENABLED = !!DB_REMOTE;

    // doctor 检查项：没启用就只说没启用；启用了再看 adb 在不在（手环数据链路，非核心）
    registerDoctorCheck('band', () => !BAND_ENABLED
        ? dOk('手环数据未启用（要用的话设 GRANCYAN_BAND_DB_REMOTE，见 README）')
        : dExists(ADB_EXE)
            ? dOk('adb 在 —— 手环数据链路可用')
            : dWarn(`adb 不在 ${ADB_EXE} —— 手环数据拉不了（不影响其它功能）。装 platform-tools（放进 PATH）或设环境变量 GRANCYAN_ADB 指到 adb.exe。`));
    // 拉下来的库放数据目录（GRANCYAN_BAND_DIR，默认 ~/.grancyan/band），不放项目根目录 ——
    // 那是健康数据，不该躺在源码树里。目录在第一次真的要 pull 时才建。
    const BAND_DIR = String(env.GRANCYAN_BAND_DIR || '').trim()
        || path.join(require('os').homedir(), '.grancyan', 'band');
    const DB_LOCAL = path.join(BAND_DIR, 'Gadgetbridge.db');

    let bandCache = { data: null, pulledAt: 0 };
    const PULL_COOLDOWN = 60000;

    // ⚠️ 以前这条链路上六种完全不同的故障（adb 没装 / 没连手机 / 没授权 / Gadgetbridge 被杀 /
    //    意图开关没开 / pull 失败）全被压成同一句「暂无手环数据，请确认手机已通过USB连接」。
    //    结果就是每隔一阵子「手环怎么又不可用了」，而前端一点线索都给不出来，每次都得手工
    //    从 adb 一路查到 GB 设置。这里把卡在哪一步、以及该去动什么，原样记下来递给前端。
    let bandLastFail = null;   // { stage, msg, hint }
    let bandLastWarn = null;   // 不致命但值得说的（比如导出没触发，用的是手机上的旧文件）
    function bandFail(stage, msg, hint) {
        bandLastFail = { stage, msg, hint };
        console.warn('[手环] 卡在', stage, '—', msg);
        return bandCache.data;   // 有旧数据就先顶着，前端会同时看到「数据是旧的」和原因
    }

    // adb devices 的设备行长这样：`<serial>\tdevice` / `\tunauthorized` / `\toffline`
    // ⚠️ 2026-09-15：这里**必须挑一台、并把 serial 记进 bandSerial**，后面每条 adb 都要带 `-s`。
    //   同一台手机 USB 插着、无线调试又连着的时候，`adb devices` 会列出**两行**
    //   （`ABC123XYZ0000` 和 `192.168.1.100:34115`，同一台 Pixel、同一个 GB 进程号），
    //   而不带 `-s` 的 `adb shell …` 会直接报 `more than one device/emulator` 并以非 0 退出。
    //   于是 adbOut 返回空串 → pidof 判成「GB 没在跑」→ am start 也失败 → 报 `gb-not-running`，
    //   提示还叫人去手机上开 Gadgetbridge、关电池优化 —— 而手机侧一点问题都没有。
    //   前面那几道诊断闸全绿，因为 `adb devices` 本身不需要选设备，唯独它不受影响。
    //   挑法：只认 `device` 状态的；USB（serial 里没有 `:`）优先于无线 —— pull 18.5MB 快得多。
    async function adbDeviceState() {
        if (!fs.existsSync(ADB_EXE)) return { state: 'adb-missing' };
        const out = await adbOut('devices');
        if (!out) return { state: 'adb-dead' };
        const lines = out.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
        if (!lines.length) { bandSerial = null; return { state: 'no-device' }; }
        const devs = lines.map(l => {
            const cols = l.split(/\s+/);
            return { state: cols[1] || 'unknown', serial: cols[0] };
        });
        const ready = devs.filter(d => d.state === 'device');
        // 一台都没就绪：把第一台的状态原样递下去，unauthorized/offline 的提示照旧
        if (!ready.length) { bandSerial = null; return devs[0]; }
        const pick = ready.find(d => !d.serial.includes(':')) || ready[0];
        bandSerial = pick.serial;
        if (ready.length > 1)
            console.log('[手环] 连着', ready.length, '台设备，选用', bandSerial);
        return pick;
    }

    function sqlRows(db, sql) {
        const r = db.exec(sql);
        if (!r.length) return [];
        return r[0].values.map(row => {
            const obj = {};
            r[0].columns.forEach((c, i) => obj[c] = row[i]);
            return obj;
        });
    }

    // ⚠️⚠️ 这两个**必须是异步的**，2026-08-28 查「exe 老是未响应」查到这儿：
    //
    //   这个 server 是 electron-main.js 里 `require('./server.js')` 起来的 ——
    //   它跑在 **Electron 主进程**里，和窗口消息循环同一根线程。
    //   于是 execFileSync 阻塞的不是「一个后台任务」，是**整个窗口**。
    //
    //   而前端 `setInterval(fetchBandData, 120000)`，冷却是 60 秒 < 120 秒，
    //   所以每次轮询都真的跑全套：devices / pidof / stat / 两条 broadcast /
    //   最多 6 轮 stat 轮询 / 最后 adb pull 一个 **18.5 MB** 的库。
    //   手机还是 WiFi 连的（无线 adb 慢起来没底，execFileSync 的 timeout 是 10 秒）。
    //   现场记录器抓到的正是这个形状：每 ~2 分钟一次，主进程「响应=NO」
    //   而 CPU 只有 0.2%（不是在算，是卡在等子进程），
    //   而且常常成对出现、相隔 8~9 秒 —— 先卡广播那段，再卡 pull 那段。
    //
    //   改成 execFile（异步）之后，等 adb 的时候事件循环是空的，窗口照常响应。
    //   ⚠️ 别退回同步：这里省下的不是「后台快一点」，是用户的窗口不冻。
    // ⚠️ maxBuffer 两个都要给。原来的同步版 adbCmd 写的是 `stdio: 'ignore'` ——
    //   **根本不收输出**，所以没有缓冲上限这回事。换成 execFile 之后默认是管道，
    //   上限 1MB，超了 Node 会直接把子进程杀掉并以 maxBuffer 错误返回。
    //   而 `adb pull` 走的正是 adbCmd，拉的是 18.5 MB 的库、带进度输出 ——
    //   于是表现成 `pull-failed`「拉不下来」，跟手机真没连上长得一模一样。
    //   （Codex 逮到的：我第一版只给 adbOut 加了 maxBuffer，注释还贴在错的那个函数上。）
    const ADB_MAXBUF = 64 * 1024 * 1024;
    // adbDeviceState() 每轮挑定的那台手机；null = 还没挑过/一台都没就绪
    let bandSerial = null;
    // 这几条命令是对 adb server 本身说的，不针对某台设备，带 `-s` 没意义
    const ADB_GLOBAL_CMDS = new Set(['devices', 'connect', 'disconnect', 'kill-server', 'start-server', 'version']);
    function withSerial(args) {
        if (!bandSerial || ADB_GLOBAL_CMDS.has(args[0])) return args;
        return ['-s', bandSerial, ...args];
    }
    // ⚠️ windowsHide 两个都要给。exe 里 Electron 主进程没有控制台，spawn 一个 console
    //   子系统的程序（adb.exe 就是）时 Windows 会**给它新开一个**黑窗口。更麻烦的是
    //   `adb` 任何一条命令都会顺手拉起常驻的 adb server 守护进程，那个守护进程继承着
    //   这个窗口活下去 —— 窗口于是永远不关，跟檐廊那个是同一类（见 server.js 里
    //   engawaPythonw 上方的注释）。终端里 `node server.js` 跑的时候看不出来，
    //   因为那时有控制台可继承，不会新开窗。
    function adbCmd(...args) {
        return new Promise(resolve => {
            execFile(ADB_EXE, withSerial(args), { timeout: 10000, maxBuffer: ADB_MAXBUF, windowsHide: true }, (err) => {
                if (err) { console.warn('[adb] 失败:', args.join(' '), '->', err.message); resolve(false); }
                else resolve(true);
            });
        });
    }
    function adbOut(...args) {
        return new Promise(resolve => {
            execFile(ADB_EXE, withSerial(args), { timeout: 10000, maxBuffer: ADB_MAXBUF, windowsHide: true }, (err, stdout) => {
                resolve(err ? '' : String(stdout || '').trim());
            });
        });
    }
    const GB_PKG = 'nodomain.freeyourgadget.gadgetbridge';
    // 手机上那份导出库（GRANCYAN_BAND_DB_REMOTE）的最后修改时间（epoch 秒），0 = 取不到
    async function remoteDbMtime() {
        const out = await adbOut('shell', 'stat', '-c', '%Y', DB_REMOTE);
        return parseInt(out, 10) || 0;
    }

    // sql.js 的 wasm 只实例化一次。以前每趟 pull 都 initSqlJs() 一遍，每两分钟重编译一次 wasm。
    // 失败了把缓存清掉，下次还能重试，别把一次失败永久记住。
    let sqlJsPromise = null;
    function getSqlJs() {
        if (!sqlJsPromise) sqlJsPromise = initSqlJs().catch(e => { sqlJsPromise = null; throw e; });
        return sqlJsPromise;
    }

    // 单飞：一趟 pull 要十几秒（广播 + 最多 12 秒等导出 + 拉 18.5MB），而前端轮询、面板打开、
    // 手动刷新都会进来。以前并发进来就是几条 adb pull 同时往同一个 Gadgetbridge.db 里写，
    // 读到的是被另一条写了一半的库。现在在飞的那趟没结束之前，后来的都等它的结果。
    let pullInflight = null;
    function pullBandData(force) {
        if (pullInflight) return pullInflight;
        pullInflight = pullBandDataOnce(force).finally(() => { pullInflight = null; });
        return pullInflight;
    }

    async function pullBandDataOnce(force) {
        const now = Date.now();
        try { fs.mkdirSync(BAND_DIR, { recursive: true }); }
        catch (e) { return bandFail('local-dir', '数据目录建不了：' + BAND_DIR + '（' + e.message + '）', '设 GRANCYAN_BAND_DIR 指到一个可写目录'); }
        if (!force && bandCache.data && now - bandCache.pulledAt < PULL_COOLDOWN) {
            return bandCache.data;
        }
        // 先把「手机到底连没连上」查清楚，别等到 pull 失败才笼统地喊一句没数据
        const dev = await adbDeviceState();
        if (dev.state === 'adb-missing')
            return bandFail('adb-missing', 'adb 不在 ' + ADB_EXE, '装一份 platform-tools（放进 PATH），或者设环境变量 GRANCYAN_ADB 指到 adb.exe');
        if (dev.state === 'adb-dead')
            return bandFail('adb-dead', 'adb devices 没有任何输出', 'adb 起不来，先试 adb kill-server 再重来');
        if (dev.state === 'no-device')
            return bandFail('no-device', '一台设备都没连上', '插上 USB 线，手机上选「传输文件」，并确认开发者选项里的 USB 调试是开的');
        if (dev.state === 'unauthorized')
            return bandFail('unauthorized', '手机还没授权这台电脑', '看手机屏幕，弹出的「允许 USB 调试吗」点允许（勾上一律允许省得每次问）');
        if (dev.state !== 'device')
            return bandFail('device-' + dev.state, '设备状态是 ' + dev.state, '拔了重插；还不行就在手机上把 USB 调试关掉再打开');

        // Gadgetbridge 常被系统杀后台，进程一死广播就没人收、定时自动导出也停摆 —— 先确认活着
        if (!await adbOut('shell', 'pidof', GB_PKG)) {
            console.log('[手环] Gadgetbridge 未运行，正在拉起…');
            await adbCmd('shell', 'am', 'start', '-n', GB_PKG + '/.activities.ControlCenterv2');
            await new Promise(r => setTimeout(r, 4000));
            if (!await adbOut('shell', 'pidof', GB_PKG))
                return bandFail('gb-not-running', 'Gadgetbridge 拉不起来', '手机上手动打开一次 Gadgetbridge，并给它关掉电池优化（这个 ROM 杀后台很凶）');
        }
        const mtimeBefore = await remoteDbMtime();
        // 正确的 Intent API 动作名是 ACTIVITY_SYNC / TRIGGER_EXPORT，
        // 且需在 GB 设置 → 开发者选项 → 意图接口 中允许「活动同步触发器」「数据库导出」
        await adbCmd('shell', 'am', 'broadcast', '-a', GB_PKG + '.command.ACTIVITY_SYNC', '-p', GB_PKG);
        await adbCmd('shell', 'am', 'broadcast', '-a', GB_PKG + '.command.TRIGGER_EXPORT', '-p', GB_PKG);
        // 等导出真正落盘（文件 mtime 变化），最多 12 秒；超时就退而求其次用旧文件
        let exported = false;
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 2000));
            if (await remoteDbMtime() > mtimeBefore) { exported = true; break; }
        }
        // 这一步不致命（手机上还有上次导出的文件），但得说出来 —— 否则数据一直是旧的没人知道
        bandLastWarn = exported ? null : {
            stage: 'export-not-triggered',
            msg: '广播发出去了，但手机上的导出文件没更新',
            hint: 'Gadgetbridge → 设置 → 开发者选项 → 意图接口，把「活动同步触发器」和「数据库导出」打开',
        };
        if (!exported) console.warn('[手环] 触发导出后文件未更新（检查 GB 意图接口开关），使用手机上的现有文件');
        if (!await adbCmd('pull', DB_REMOTE, DB_LOCAL))
            return bandFail('pull-failed', '拉不下来 ' + DB_REMOTE, '对一下 GRANCYAN_BAND_DB_REMOTE 和 Gadgetbridge 里设的自动导出路径是不是同一个');
        try {
            const SQL = await getSqlJs();
            const buf = fs.readFileSync(DB_LOCAL);
            const db = new SQL.Database(buf);
            const daily = sqlRows(db, "SELECT TIMESTAMP,STEPS,HR_RESTING,HR_MAX,HR_MIN,HR_AVG,STRESS_AVG,CALORIES,SPO2_AVG FROM XIAOMI_DAILY_SUMMARY_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 1");
            const latestHR = sqlRows(db, "SELECT TIMESTAMP,HEART_RATE,STEPS,STRESS,SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 ORDER BY TIMESTAMP DESC LIMIT 1");
            const recentActivity = sqlRows(db, "SELECT TIMESTAMP,STEPS,HEART_RATE,STRESS,SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 OR STEPS>0 ORDER BY TIMESTAMP DESC LIMIT 10");
            const sleepSummary = sqlRows(db, "SELECT TIMESTAMP,WAKEUP_TIME,TOTAL_DURATION,DEEP_SLEEP_DURATION,LIGHT_SLEEP_DURATION,REM_SLEEP_DURATION,AWAKE_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 1");
            // 图表用序列（前端手环面板）。activity 表 TIMESTAMP 是秒，daily/sleep 表是毫秒。
            // 按最新样本往前取 24h，数据不新鲜时图表也能看到最后一段
            const hrSeries = sqlRows(db, "SELECT TIMESTAMP,HEART_RATE FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000");
            const stressSeries = sqlRows(db, "SELECT TIMESTAMP,STRESS FROM XIAOMI_ACTIVITY_SAMPLE WHERE STRESS>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000");
            const stepsSeries = sqlRows(db, "SELECT TIMESTAMP,STEPS FROM XIAOMI_ACTIVITY_SAMPLE WHERE STEPS>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000");
            const daily7 = sqlRows(db, "SELECT TIMESTAMP,STEPS,HR_RESTING,HR_MAX,HR_MIN,HR_AVG,STRESS_AVG,CALORIES,SPO2_AVG FROM XIAOMI_DAILY_SUMMARY_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 7");
            const sleep7 = sqlRows(db, "SELECT TIMESTAMP,WAKEUP_TIME,TOTAL_DURATION,DEEP_SLEEP_DURATION,LIGHT_SLEEP_DURATION,REM_SLEEP_DURATION,AWAKE_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE WHERE TOTAL_DURATION>60 ORDER BY TIMESTAMP DESC LIMIT 7");
            // 给 AI 的睡眠记录：最近一条往前 9 天的每一段，含白天小睡和不到一小时的补觉（前端按「哪一晚」归堆）
            const sleepRecent = sqlRows(db, "SELECT TIMESTAMP,WAKEUP_TIME,TOTAL_DURATION,DEEP_SLEEP_DURATION,LIGHT_SLEEP_DURATION,REM_SLEEP_DURATION,AWAKE_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE WHERE TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_SLEEP_TIME_SAMPLE)-9*86400000 ORDER BY TIMESTAMP DESC LIMIT 40");
            db.close();
            bandCache = { data: { daily, latestHR, recentActivity, sleepSummary, hrSeries, stressSeries, stepsSeries, daily7, sleep7, sleepRecent }, pulledAt: now, dbMtime: (await remoteDbMtime()) * 1000 };
            bandLastFail = null;   // 这一趟走通了，把上次卡在哪忘掉
            console.log('[手环] 数据已更新, 今日步数:', daily[0]?.STEPS ?? '?');
            return bandCache.data;
        } catch (e) {
            return bandFail('db-read-failed', '读 Gadgetbridge.db 失败：' + e.message, '文件可能没导完或者表结构变了；手机上手动导出一次再试');
        }
    }

    app.get('/api/band-data', async (req, res) => {
        if (!BAND_ENABLED) {
            return res.json({ ok: false, stage: 'not-configured', msg: '手环数据未启用',
                hint: '电脑端设环境变量 GRANCYAN_BAND_DB_REMOTE（手机上 Gadgetbridge 导出数据库的路径）后重启 server' });
        }
        const data = await pullBandData(req.query.force === '1');
        if (!data) {
            const f = bandLastFail || { stage: 'unknown', msg: '暂无手环数据', hint: '确认手机已通过 USB 连接' };
            return res.json({ ok: false, ...f });
        }
        // 数据新鲜度按手机上导出文件的时间算（比 pulledAt 更真实：pull 成功但导出没跑时能暴露出来）
        const ageMins = Math.round((Date.now() - (bandCache.dbMtime || bandCache.pulledAt)) / 60000);
        // 有数据但这趟没拉成（手机拔了之类）→ 数据是旧的，得让前端说出来是为什么
        res.json({ ok: true, ageMins, stale: bandLastFail || undefined, warn: bandLastWarn || undefined, ...data });
    });
}

module.exports = { mount };
