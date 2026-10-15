// server/media.js
// 视频抽帧(N) + 表情存图/图片代理(O) —— 两个相邻分区一起搬
// （docs/server-split-plan.md Phase 1 第四块，方案里 N+O 本来就是一步）。
// 逻辑原样搬运，未改一行行为。deps 只有 outboundAgent（O 的两条路由要用，
// 按函数形态直传，硬约束 7）；N 不需要任何 deps。
// fetchRemoteBuffer 来自独立模块 remote-fetch.js，保持原来的"调用点内联 require"
// 关系不变，只是这个文件挪进了 server/ 子目录，相对路径从 './remote-fetch'
// 改成 '../remote-fetch'（指向同一个文件，纯路径调整，不是新增依赖）。
// mount() 开头校验依赖：漏传就在启动时炸，不留到真实请求才 502
// （挂载探针只走校验分支，逮不住漏传——模板规则，音乐块 Codex 二轮定的）。
const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

function mount(app, deps) {
    if (!app || !deps || typeof deps.outboundAgent !== 'function') {
        throw new Error('media.mount: 缺依赖（app/outboundAgent）—— 装配层漏传了');
    }
    const { outboundAgent } = deps;

    // GIF 收藏（下载远程图到本地 stickers/）
    /* 视频抽帧的兜底路。
       主路在前端（js/30-video.js，video + canvas），三个运行环境都能跑，不需要这里。
       只有「浏览器压根解不了这个编码」时才轮到这儿 —— 常见的是 .mkv、部分 HEVC 的
       .mov、老 .avi。所以这个接口不在的时候功能不算坏，只是少了几种格式。

       ⚠️ 用 select='gt(scene,…)' 而不是均匀抽帧，理由和前端那边一样：均匀抽会把
       帧全浪费在静止段上。eq(n,0) 是把第一帧强行留下当锚，不然开头静止的片子
       第一张就丢了。-vsync vfr 必须带，否则 ffmpeg 会把没选中的帧按原帧率补齐，
       select 等于白写。
       时间码靠 showinfo 打进 stderr 再解 pts_time —— 少了它，模型拿到的就是几张
       没有先后关系的散图。 */
    app.post('/api/video-frames', express.raw({ type: '*/*', limit: '400mb' }), async (req, res) => {
        if (!req.body || !req.body.length) return res.status(400).json({ error: '没收到视频数据' });
        const os = require('os');
        const max = Math.min(24, Math.max(1, parseInt(req.query.max, 10) || 8));
        const width = Math.min(1280, Math.max(160, parseInt(req.query.w, 10) || 768));
        // 这个头是客户端给的，畸形的 % 会让 decodeURIComponent 抛 URIError。
        // Express 5 会把它兜成 500 —— 但一个文件名解不开而已，退回默认名接着抽帧就是了，
        // 这个值只用来取扩展名。
        let raw = 'clip';
        try { raw = decodeURIComponent(String(req.headers['x-filename'] || 'clip')); } catch { raw = 'clip'; }
        const ext = (path.extname(raw) || '.bin').replace(/[^.\w]/g, '').slice(0, 8);
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vid-'));
        const src = path.join(work, 'in' + ext);
        /* ⚠️ 清理的生命周期跟**子进程**走，不跟 Promise 走 —— 这两个不是一回事，
           混成一件事正是临时目录泄漏的根源。
           `kill()` 只代表信号发出去了，不代表进程已经退出；Windows 上这一刻 ffmpeg
           通常还攥着 in.mp4 的句柄，rmSync 会抛 EPERM/EBUSY 被 catch 吞掉。而 HTTP
           那边（超时 / 客户端断开）早就走完了，没人会再来删第二次。
           所以：还有活着的子进程时只记账不删，等最后一个 close 到了再真删。
           maxRetries 是同一件事的第二道保险（句柄释放本身也有几十毫秒的延迟）。
           这是常驻进程，漏一次就一直漏到重启为止。 */
        let live = 0, wantCleanup = false;
        const rmNow = () => { try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} };
        const cleanup = () => {
            wantCleanup = true;
            if (live > 0) return;   // 进程还没退，现在删必失败；close 那边会补删
            rmNow();
        };

        /* ⚠️ 子进程必须能被杀掉，而且要挂在「客户端断开」上。
           客户端那边 abort 只是不再等 HTTP —— 服务端的 ffmpeg 照跑，临时目录照占。
           长视频里只有第一帧命中 select 的时候，ffmpeg 仍然会把整段解到结尾；
           坏文件还可能让它彻底卡住，那样连 cleanup 都永远轮不到。 */
        let child = null, closed = false, hardTimer = null, onGiveUp = null;
        /* 不看 child.killed：那个标志只说明「我们发过信号」。进程僵着没死的时候
           还得能再补一刀，否则二级超时之后它就彻底没人管了。对已退出的进程
           kill 是 no-op，重复调用无害。 */
        const kill = () => { if (child) { try { child.kill('SIGKILL'); } catch {} } };

        /* 二级善后。**凡是发了 kill 就要武装它**，因为 kill 只代表信号发出去了：
           送不到的时候（EPERM 那种）Node 会 emit 'error'，进程却好端端活着，
           'close' 于是永远不来 —— 没有这个定时器的话，从此再没人回来看一眼。
           ⚠️ 两处 kill 都要武装：150 秒超时那处，以及**客户端断开**那处。
           只装前者的话，「没到 150 秒就断开 + kill 送不到」这条路仍然是裸的。
           它做的三件事缺一件都留尾巴：补刀、放弃等待并强删、让还挂着的请求收场。 */
        const armHardTimer = () => {
            if (hardTimer) return;   // 幂等：重复 abort / 两处都调都只装一个
            hardTimer = setTimeout(() => {
                hardTimer = null;
                kill();          // 再补一刀，第一刀可能压根没送到
                live = 0;        // 等不到 close 了，别再挂账
                rmNow();         // 删得掉算赚到，删不掉也就这样，至少试过
                if (onGiveUp) onGiveUp();   // 还挂着的 Promise 得有个了断
            }, 5000);
        };
        const disarmHardTimer = () => { clearTimeout(hardTimer); hardTimer = null; };

        const onAbort = () => {
            closed = true;
            kill();
            cleanup();
            if (live > 0) armHardTimer();   // 进程还在 = kill 可能没送到，得留个后手
        };
        req.on('aborted', onAbort);
        res.on('close', () => { if (!res.writableFinished) onAbort(); });

        // 抽帧走完一趟的产物文件名带 pass 前缀，第二趟才不会覆盖第一趟
        const runFfmpeg = (vf, outPat, limit) => new Promise((resolve, reject) => {
            if (closed) return reject(new Error('客户端已断开'));
            const args = ['-v', 'info', '-i', src, '-vf', vf,
                '-vsync', 'vfr', '-q:v', '5', '-frames:v', String(limit),
                path.join(work, outPat)];
            // windowsHide：exe 里没有控制台可继承，不写这个的话每趟抽帧都会新开一个
            // 黑窗口挂在任务栏上（抽帧动辄跑几十秒，肉眼绝对看得见）。
            child = spawn('ffmpeg', args, { windowsHide: true });
            const me = child;
            live++;
            /* ⚠️ 这个记账独立于 Promise 的 settle，而且必须在 once 之外。
               进程真的退出了才是「可以删了」的那一刻：超时/断开那两条路上 HTTP
               早就结束、Promise 早就 settle 了，只有这里还能补上那次删除。

               ⚠️ 只挂 'close'，**不要顺手把 'error' 也挂上**。
               'error' 的语义是「这个子进程出事了」，不是「它退出了」——kill 送不到的时候
               也会 emit error，而那时进程好端端活着还攥着 in.mp4。在 error 上销账就等于
               宣布「可以删了」，删失败被吞掉，counted 又已经翻掉，真正的 close 到了也不再补删。
               spawn 失败会不会漏掉 close？实测这台机器（node v24）：
               `spawn('不存在的程序')` 收到的是 `error:ENOENT -> close:-4058/null`，
               close 照样来。所以 'close' 一个就够，多挂那个只会帮倒忙。 */
            let counted = true;
            me.on('close', () => {
                if (!counted) return;
                counted = false;
                disarmHardTimer();   // 进程真的退了，善后定时器没用了
                onGiveUp = null;
                live = Math.max(0, live - 1);
                if (wantCleanup) cleanup();
            });
            let err = '', timedOut = false, settled = false;
            /* ⚠️ once 只清 timer，**不清 hardTimer**。
               这两个的职责不是一回事：once 管的是「HTTP 这边可以走了」，
               hardTimer 管的是「僵住的进程和它占着的目录还得有人善后」。
               kill 送不到时 Node 会 emit 'error'，下面那个 handler 会 once(reject) ——
               要是顺手把 hardTimer 也清了，就等于 Promise 一 settle 就放弃了善后，
               而那恰恰是进程还活着、最需要善后的时刻。 */
            const once = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
            /* ⚠️ 超时时只标记 + kill，**不能当场 reject**。
               当场 reject 的话，外层 catch 立刻 rmSync 临时目录，而这一刻被杀的
               ffmpeg 在 Windows 上往往还攥着 in.mp4 的句柄 —— 删除失败被 cleanup 的
               catch 吞掉；等 close 真的到了，它只会去 resolve 一个已经 settle 的
               Promise，不会再清理一次。结果就是 gc-vid-* 永久残留，零报错。
               所以等 close 来了再 reject，那时进程真的没了，删得掉。
               hardTimer 是二级保险：万一进程僵死、close 永远不来，也不能把请求吊死。 */
            onGiveUp = () => once(() => reject(new Error('ffmpeg 处理超时，且进程没有退出')));
            const timer = setTimeout(() => {
                timedOut = true;
                kill();
                armHardTimer();   // 发了 kill 就武装善后，见上面 armHardTimer 那段
            }, 150000);
            child.stderr.on('data', d => { err += d; if (err.length > 400000) err = err.slice(-200000); });
            child.on('error', e => once(() => reject(new Error(e.code === 'ENOENT'
                ? '这台电脑上没装 ffmpeg（winget install Gyan.FFmpeg）' : e.message))));
            // ffmpeg 到达 -frames:v 上限时会以非 0 退出，但帧已经写出来了。
            // 所以退出码不作数，只看有没有真的产出文件。
            child.on('close', () => once(() => timedOut
                ? reject(new Error('ffmpeg 处理超时（150 秒）'))
                : resolve(err)));
        });

        const collect = pfx => fs.readdirSync(work).filter(f => f.startsWith(pfx) && f.endsWith('.jpg')).sort();
        const readTimes = s => [...s.matchAll(/pts_time:([0-9.]+)/g)].map(m => parseFloat(m[1]));

        try {
            fs.writeFileSync(src, req.body);
            let info = await runFfmpeg(
                `select='eq(n\\,0)+gt(scene\\,0.25)',scale=${width}:-2,showinfo`, 'a_%03d.jpg', max);
            // 文件名和时间码是靠**下标**对上的，拆散之前先配成对，不然一排序就全错位
            const pair = (fl, tl) => fl.map((f, i) => ({ f, t: tl[i] != null ? tl[i] : 0 }));
            let picked = pair(collect('a_'), readTimes(info));

            const durM = info.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            const duration = durM ? (+durM[1] * 3600 + +durM[2] * 60 + parseFloat(durM[3])) : 0;

            /* 均匀锚点这一趟要在两种情况下跑，缺一种都会让模型只看见片子的一小段：

               ① 抽出来的帧太少。访谈、监控、屏幕录像这类画面变化低于 0.25 的素材，
                  上面那趟只吐得出开头一帧 —— 三分钟的内容模型只看得到第一秒。

               ② 帧数够了，但**全挤在前面**。这条更阴：`-frames:v` 是「凑够就停」，
                  不是「扫完整段再挑最好的几个」。一段前十秒快剪、后面才是正片的视频，
                  第一趟在第十秒就收工交出 8 帧，files.length 是满的，按老判据（< 3）
                  根本不会补 —— 用户看到的是「它给了我 8 张图」，看不到的是这 8 张
                  全来自片头，后面几分钟一眼都没看。前端那条路有同样的病，
                  在 _vidPickTimes 末尾那段一起治的。

               补的时候**锚点优先占位**，场景帧再按原顺序填剩下的名额（且不能贴着锚点）。
               反过来的话名额早被前段的场景帧占满，锚点一个也进不来，等于没补。 */
            const lastT = picked.length ? Math.max(...picked.map(p => p.t)) : 0;
            const frontLoaded = duration > 8 && lastT < duration * 0.6;
            if ((picked.length < 3 || frontLoaded) && duration > 3) {
                const n = Math.min(max, 6);
                const info2 = await runFfmpeg(
                    `fps=${(n / duration).toFixed(4)},scale=${width}:-2,showinfo`, 'b_%03d.jpg', n);
                const anchors = pair(collect('b_'), readTimes(info2));
                if (anchors.length) {
                    const gap = duration / (max * 2);
                    const out = anchors.slice(0, max);
                    for (const p of picked) {
                        if (out.length >= max) break;
                        if (out.every(o => Math.abs(o.t - p.t) >= gap)) out.push(p);
                    }
                    picked = out;
                    info = info2;
                }
            }
            picked.sort((a, b) => a.t - b.t);

            if (!picked.length) {
                const tail = info.split('\n').filter(l => l.trim()).slice(-4).join(' | ');
                cleanup();
                return res.status(422).json({ error: 'ffmpeg 没抽出画面：' + tail.slice(0, 300) });
            }

            const frames = picked.map(p => ({
                t: p.t,
                b64: fs.readFileSync(path.join(work, p.f)).toString('base64')
            }));
            cleanup();
            res.json({ frames, duration });
        } catch (e) {
            kill();
            cleanup();
            if (!closed) res.status(500).json({ error: String(e.message || e) });
        }
    });

    app.post('/api/sticker-save-url', async (req, res) => {
        const { url: gifUrl, name } = req.body;
        if (!gifUrl || !name) return res.status(400).json({ ok: false });
        try {
            const safeName = name.replace(/[^a-zA-Z0-9_\-一-鿿.]/g, '_');
            // 保存目录：GRANCYAN_SAVE_DIR，没设就是用户主目录下的 Pictures/GranCyan
            const saveDir = process.env.GRANCYAN_SAVE_DIR || path.join(require('os').homedir(), 'Pictures', 'GranCyan');
            if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true });
            }
            // Giphy 的图床同样被墙，下载也要走代理
            const { fetchRemoteBuffer } = require('../remote-fetch');
            const response = await fetchRemoteBuffer(gifUrl, {
                httpsAgent: await outboundAgent(), timeout: 15000, maxBytes: 12 * 1024 * 1024,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (response.status >= 400) return res.status(response.status).json({ ok: false, error: '远程图片返回 HTTP ' + response.status });
            const savePath = path.join(saveDir, safeName);
            fs.writeFileSync(savePath, Buffer.from(response.data));
            res.json({ ok: true, file: safeName, path: savePath });
        } catch (e) {
            console.error('[表情包收藏]', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 图片代理下载：前端保存搜到的图片时用（外站图基本都不给 CORS，浏览器直连抓不到 blob，
    // 尤其手机端；这里服务端用 axios+代理拉回来再原样吐给前端，前端拿到 blob 就能传云端表情库）。
    app.get('/api/proxy-image', async (req, res) => {
        const imgUrl = req.query.url;
        if (!imgUrl || !/^https?:\/\//i.test(imgUrl)) return res.status(400).send('missing or invalid url');
        try {
            const { fetchRemoteBuffer } = require('../remote-fetch');
            const response = await fetchRemoteBuffer(imgUrl, {
                httpsAgent: await outboundAgent(),
                timeout: 20000,
                maxBytes: 12 * 1024 * 1024,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': imgUrl }
            });
            if (response.status >= 400) return res.status(response.status).send('upstream ' + response.status);
            res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
            res.set('Access-Control-Allow-Origin', '*');
            res.send(Buffer.from(response.data));
        } catch (e) {
            console.error('[图片代理]', e.message);
            res.status(500).send(e.message);
        }
    });
}

module.exports = { mount };
