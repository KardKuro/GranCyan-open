/* 「是谁冻住了窗口」记录器
 *
 * 背景：反馈「exe 老是卡住、未响应」。现场记录器抓到一次，
 * 数据是这样的 —— 主进程**响应=NO，CPU 只有 0.4%**，renderer 17%、GPU 18%，
 * 内存充足。CPU 接近 0 却不响应 = 不是在算什么，是**被阻塞**。
 *
 * 而 electron-main.js 里是 `require('./server.js')` —— 整个 HTTP 服务器就跑在
 * Electron 主进程里，和窗口消息循环同一根线程。于是任何一个路由处理器里的
 * 同步活（同步 fs、spawnSync、大 JSON.parse）超过两百毫秒，窗口就是「未响应」。
 * server.js 里同步 fs 有 90 处，spawnSync 有 1 处。靠读代码去猜是哪一处，
 * 是在 90 个嫌疑人里抽签。
 *
 * 所以让它自己说：
 *   · 每 50ms 量一次事件循环延迟（单调时钟）。事件循环停摆 = 窗口没响应，
 *     这是直接度量不是代理指标。
 *   · 停摆的那一段时间里，把**时间上重叠**的请求列出来。
 *
 * ⚠️⚠️ 它给的是**线索，不是结论**。Express 只有每个请求的起止时间，
 *   凭这个证明不了谁占了线程 —— 一个在异步等上游 30 秒的请求，
 *   和一个真的做了 500ms 同步 fs 的请求，在这张表里长得一样。
 *   （Codex 逮到我第一版的措辞写成了指认：「名字就是嫌疑人」「占住主线程多久」。
 *    我自己定的规矩是「假指认比没有指认更糟」，那就不许用会被读成指认的词。）
 *   真要钉死是哪一行，还得拿这个线索去做定向测量。
 *
 * ⚠️ 报出来的 lag 是**下界**：阻塞若紧跟某次采样之后开始，那段空档不计入，
 *   所以真实值在 [lag, lag+50ms]，而且比阈值略长的阻塞可能整个漏掉。
 *
 * ⚠️ 这东西不修 bug，自己必须极便宜，否则就成了新的病因：
 *   一个 50ms 的 timer + 一个 Map，没有 I/O，卡住时才写日志。
 */
'use strict';

const LAG_MS = Number(process.env.GRANCYAN_FREEZE_LAG_MS || 250);
const SAMPLE_MS = 50;

const inflight = new Map();      // id -> { method, url, started }
const recent = [];               // 最近结束的，用来事后归因
const RECENT_KEEP = 40;
let seq = 0;
let worst = { lag: 0, at: null, who: null };

// ⚠️ 不能只看「此刻在飞」。
//   卡顿是这样被发现的：主线程被占住 → 占完了 → 定时器这才回来 → 算出延迟。
//   等它回来的时候，罪魁那个请求早就结束、从 inflight 里删掉了。
//   第一版就是这么写的，自测当场露馅：明明是那个同步路由干的，
//   它却打「当时没有请求在飞，看别处」。所以要问的是「这段时间里谁在跑」：
//   拿卡顿窗口 [from, to] 去和每个请求的 [开始, 结束] 求交集，刚结束的也算。
//
// ⚠️⚠️ 但**时间上重叠 ≠ 就是它干的**（Codex 逮到我在这儿吹过头了）。
//   反例：请求 A 在异步等上游 30 秒，期间请求 B 做了 500ms 同步文件操作 ——
//   A 和 B 都会被列出来，而 A 一个 CPU 周期都没占。更糟的是卡顿要是来自
//   Electron 主进程自己的活（不是路由），只要当时恰好有个 SSE 挂着，
//   它也会被列进来。
//   Express 的起止时间根本不足以证明谁占了线程。所以这里给的是**线索不是结论**，
//   措辞必须诚实：叫「时间上重叠」，时长叫「历时」而不是「占了」。
//   我自己定的规矩是「假指认比没有指认更糟」—— 那就不许用会被读成指认的词。
function whoDuring(from, to, exceptId) {
    const hits = [];
    for (const [id, r] of inflight) {
        // 诊断端点自己不算。它在响应还没 finish 的时候读这张表，
        // 不排掉的话每次查询都会把自己列成嫌疑人（Codex 逮到的）。
        if (id === exceptId) continue;
        if (r.started <= to) hits.push({ ...r, ended: null });
    }
    for (const r of recent) {
        if (r.started <= to && r.ended >= from) hits.push(r);
    }
    if (!hits.length) return '（这段时间没有请求在跑 —— 那就不是路由干的，去看主进程自己的活）';
    return hits
        .sort((a, b) => a.started - b.started)
        .map(r => {
            const dur = (r.ended || Date.now()) - r.started;
            return `${r.method} ${r.url}（历时 ${dur}ms${r.ended ? '' : '，还没结束'}）`;
        })
        .join(' / ');
}

function describeInflight(exceptId) {
    const rows = [...inflight.entries()].filter(([id]) => id !== exceptId).map(([, r]) => r);
    if (!rows.length) return '（此刻没有别的请求在飞）';
    const now = Date.now();
    return rows
        .sort((a, b) => a.started - b.started)
        .map(r => `${r.method} ${r.url}（已经跑了 ${now - r.started}ms）`)
        .join(' / ');
}

function mountFreezeWatch(app) {
    // ── 谁在飞 ──
    app.use((req, res, next) => {
        const id = ++seq;
        const rec = { method: req.method, url: req.originalUrl || req.url, started: Date.now() };
        inflight.set(id, rec);
        req.__freezeWatchId = id;   // 诊断端点靠它把自己排掉
        // ⚠️ 必须同时听 finish 和 close。只听 finish 的话，客户端中途断开
        //   （SSE 长流、页面刷新）那条记录永远留在表里，之后每次卡住都会把它
        //   当成嫌疑人打出来 —— 一个假指认比没有指认更糟。
        let done = false;
        const clear = () => {
            if (done) return;
            done = true;
            inflight.delete(id);
            recent.push({ ...rec, ended: Date.now() });
            if (recent.length > RECENT_KEEP) recent.shift();
        };
        res.on('finish', clear);
        res.on('close', clear);
        next();
    });

    // ── 事件循环延迟 ──
    // 原理：约好 SAMPLE_MS 之后回来。真回来的时候晚了多少，就是主线程没空理事件循环的时间。
    //
    // ⚠️ 用**单调时钟**（hrtime），不用 Date.now()。系统时钟前跳、笔记本从睡眠恢复，
    //   都会让 Date.now() 的差值凭空冒出一个巨大的「卡顿」（Codex 逮到的）。
    //   单调时钟不受这些影响。
    //
    // ⚠️ 测出来的 lag 是**下界，不是精确值**（同样是 Codex 逮到的）：
    //   一次阻塞如果紧跟在某次采样之后开始，采样点本来就还有 SAMPLE_MS 才到期，
    //   那部分不计入 lag。所以真实阻塞时长在 [lag, lag + SAMPLE_MS] 之间，
    //   而且**比阈值略长一点的阻塞可能整个漏掉**。
    //   采样周期压到 50ms 是为了缩小这个盲区（原来 100ms，盲区和阈值同量级）。
    //   报数的时候把上界一起打出来，别让人把 lag 当成准确的冻结时长。
    const hr = () => Number(process.hrtime.bigint() / 1000000n);
    let expected = hr() + SAMPLE_MS;
    const timer = setInterval(() => {
        const now = hr();
        const lag = now - expected;
        expected = now + SAMPLE_MS;
        if (lag < LAG_MS) return;
        // 卡顿窗口是 [上一次采样, 现在]。往前多留 SAMPLE_MS，别把刚好卡在
        // 边界上开始的那个请求漏掉。这里用墙钟，因为请求的起止记的是墙钟。
        const wall = Date.now();
        const who = whoDuring(wall - lag - SAMPLE_MS, wall);
        if (lag > worst.lag) worst = { lag, upTo: lag + SAMPLE_MS, at: new Date(wall).toISOString(), who };
        console.warn(`[窗口卡住] 事件循环停了 ${lag}~${lag + SAMPLE_MS}ms —— 时间上重叠的请求（线索，不是结论）：${who}`);
    }, SAMPLE_MS);
    // ⚠️ unref：这个 timer 不许成为「进程退不掉」的理由。
    //   本来是来查卡顿的，别自己变成一个新的挂起原因。
    if (typeof timer.unref === 'function') timer.unref();

    // 查看战绩，不用翻日志
    app.get('/api/freeze-watch', (req, res) => {
        res.json({
            ok: true,
            阈值ms: LAG_MS,
            采样周期ms: SAMPLE_MS,
            最严重的一次: worst.lag ? worst : null,
            // ⚠️ 排掉这次查询自己 —— 它此刻正在飞，不排的话每次查都会把自己列进去。
            此刻在飞: describeInflight(req.__freezeWatchId),
            说明: [
                'lag 是事件循环停摆的时长下界，真实值在 [lag, lag+采样周期]；比阈值略长的阻塞可能整个漏掉。',
                '列出的请求是**时间上重叠**的，不是证明它占了线程 —— 异步等待中的请求也会被列出来。当线索用，别当结论。',
                'server 跑在 Electron 主进程里，所以事件循环停摆 = 窗口没响应。',
            ],
        });
    });

    console.log(`[窗口卡住] 记录器已挂载，超过 ${LAG_MS}ms 就点名`);
}

module.exports = { mountFreezeWatch, describeInflight };
