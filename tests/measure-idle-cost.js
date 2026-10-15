/* 空转开销探针：页面**什么都不做**的时候，到底有什么在动、在跑、在画。
 *
 * 为什么要这个：用户报「exe 老是卡住、未响应」，而基线量出来 gpu-process 持续占着
 * 12% 的一个核、renderer 6% —— 她并没有在操作。持续烧 CPU 本身不等于卡死，
 * 但它把余量吃光了：真正干活的时候（发消息、渲染长历史）就没有富余，于是掉帧、未响应。
 *
 * 这里量三样，因为它们指向不同的修法：
 *   ① 正在跑的 CSS/Web 动画  → 改样式（条件触发、或换成合成器属性）
 *   ② 常驻的 timer          → 改逻辑（页面不可见时停、或拉长间隔）
 *   ③ rAF 循环是否一直在转   → 有循环没有停止条件
 *
 * ⚠️ 量的是**空转**：脚本开页面 → 等它安顿 → 什么都不碰 → 采样。
 *   任何在这种状态下还在动的东西，都是白烧的。
 *
 * 跑法：node tests/measure-idle-cost.js
 *   默认自己起一个 server（不碰 3000，免得撞上她正开着的 exe）。
 *   已经有 server 的话：GC_PORT=3000 node tests/measure-idle-cost.js
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const OWN_SERVER = !process.env.GC_PORT;
const PORT = process.env.GC_PORT || 3096;
const CDP = 9237;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
// ⚠️ 每次用全新的 profile 目录。共用的话会撞上「另一个 Chrome 已经占着这个 profile」，
//   症状是页面加载了但函数全 undefined —— 看着像代码坏了。
const PROFILE = path.join(os.tmpdir(), 'gc-idle-' + process.pid + '-' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp(url) {
    const r = await fetch(`http://127.0.0.1:${CDP}${url}`, { method: 'PUT' }).catch(() => null);
    if (r) return r.json();
    return (await fetch(`http://127.0.0.1:${CDP}${url}`)).json();
}

function session(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const waiting = new Map();
        let id = 0;
        ws.on('open', () => resolve({
            send(method, params) {
                const n = ++id;
                ws.send(JSON.stringify({ id: n, method, params: params || {} }));
                return new Promise((res, rej) => waiting.set(n, { res, rej }));
            },
            close() { try { ws.close(); } catch { } },
        }));
        ws.on('message', (m) => {
            const msg = JSON.parse(m);
            const w = waiting.get(msg.id);
            if (!w) return;
            waiting.delete(msg.id);
            if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result);
        });
        ws.on('error', reject);
    });
}

async function evalIn(s, js) {
    const r = await s.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
}

(async () => {
    let server = null;
    if (OWN_SERVER) {
        server = spawn(process.execPath, ['server.js'], {
            cwd: ROOT, stdio: 'ignore',
            env: { ...process.env, GRANCYAN_PORT: String(PORT), GRANCYAN_NO_CHROME_SWEEP: '1' },
        });
        await sleep(3000);
    }

    const chrome = spawn(CHROME, [
        `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        `http://127.0.0.1:${PORT}/`,
    ], { stdio: 'ignore' });

    let s = null;
    try {
        let tabs = null;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            tabs = await cdp('/json/list').catch(() => null);
            if (tabs && tabs.find(t => t.type === 'page' && t.url.includes(String(PORT)))) break;
        }
        const page = tabs.find(t => t.type === 'page' && t.url.includes(String(PORT)));
        if (!page) throw new Error('页面没起来');
        s = await session(page.webSocketDebuggerUrl);
        await s.send('Runtime.enable');

        // 让它把开机那一波跑完再采样。量的是**安顿之后**还在动的东西。
        console.log('等页面安顿（12 秒）…');
        await sleep(12000);

        // ⚠️ 先摆前提：探针用的是全新 profile。如果登录框正显示着，
        //   那星空动画转是**应该**的 —— 拿这种状态当「空转白烧」是误判。
        //   这一段是给我自己的对照组：先证明我量的确实是主界面。
        const stage = await evalIn(s, `(() => {
            const m = document.getElementById('authModal');
            const c = document.getElementById('starCanvas');
            return {
                登录框存在: !!m,
                登录框类名: m ? m.className : null,
                登录框可见: m ? m.getClientRects().length > 0 : null,
                星空画布可见: c ? c.getClientRects().length > 0 : null,
                主界面在: !!document.querySelector('.chat-area, #chatArea, .msg-list'),
            };
        })()`);
        console.log('\n⓪ 前提：现在停在哪个界面');
        for (const [k, v] of Object.entries(stage)) console.log(`   ${k}: ${v}`);

        // 登录靠 Supabase 网络会话，全新 profile 必然停在登录页 —— 而登录页上星空动画
        // **本来就该转**。要量的是主界面，所以走登录成功那条路径把墙收起来
        // （01-core.js 里就是这一句 classList.add('hidden')，observer 监听的正是它）。
        if (stage.登录框可见) {
            console.log('   → 停在登录页。按登录成功那条路径收起墙，再量主界面。');
            await evalIn(s, `document.getElementById('authModal').classList.add('hidden'), 1`);
            await sleep(5000);
            const after = await evalIn(s, `(() => {
                const m = document.getElementById('authModal');
                const c = document.getElementById('starCanvas');
                return { 登录框可见: m.getClientRects().length > 0, 星空画布可见: c ? c.getClientRects().length > 0 : null };
            })()`);
            console.log('   收起后:', JSON.stringify(after));
            if (after.登录框可见) throw new Error('墙没收起来，下面量的还是登录页 —— 停，别拿它当主界面的数');
        }

        console.log('\n① 空转时还在跑的动画:');
        const anims = await evalIn(s, `(() => {
            const list = document.getAnimations().map(a => {
                const t = a.effect && a.effect.target;
                return {
                    name: (a.animationName || (a.effect && a.effect.getKeyframes && '(web-animation)') || '?'),
                    sel: t ? (t.tagName.toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\\s+/).join('.') : '')) : '(无目标)',
                    playState: a.playState,
                    visible: t && t.getClientRects ? t.getClientRects().length > 0 : null,
                };
            });
            const by = {};
            for (const a of list) {
                const k = a.name + ' | ' + a.sel + ' | ' + a.playState + ' | 可见=' + a.visible;
                by[k] = (by[k] || 0) + 1;
            }
            return Object.entries(by).sort((x, y) => y[1] - x[1]);
        })()`);
        if (!anims.length) console.log('   （没有，干净）');
        for (const [k, n] of anims) console.log(`   ${n} 个 · ${k}`);

        // ⚠️ 计时器要在**页面装载之前**打桩才数得全。这里是事后装的，
        //   只能数「从现在起新建的」—— 所以再等一段，看它每分钟新建多少个。
        console.log('\n② 从现在起 20 秒内新建的 timer / rAF:');
        await evalIn(s, `(() => {
            window.__c = { interval: [], timeout: [], raf: 0 };
            const si = window.setInterval, st = window.setTimeout, rf = window.requestAnimationFrame;
            window.setInterval = function (f, d) { window.__c.interval.push(d); return si.apply(this, arguments); };
            window.setTimeout  = function (f, d) { if (d >= 0) window.__c.timeout.push(d); return st.apply(this, arguments); };
            // ⚠️ 按**调用来源**分类，不只数总数。总数只能说明「有东西在转」，
            //   而修的时候要知道是哪个循环 —— 一个页面上好几个 rAF 循环是常态，
            //   多数是正当的（正在播的动画），白烧的只是没有停止条件的那几个。
            window.__c.by = {};
            window.requestAnimationFrame = function () {
                window.__c.raf++;
                const st = (new Error().stack || '').split('\\n').slice(1, 4)
                    .map(l => l.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^\\s)]*\\//, ''))
                    .filter(Boolean).join('  ←  ');
                window.__c.by[st] = (window.__c.by[st] || 0) + 1;
                return rf.apply(this, arguments);
            };
            return 1;
        })()`);
        await sleep(20000);
        const counts = await evalIn(s, `(() => {
            const c = window.__c;
            const tally = (arr) => {
                const m = {};
                for (const d of arr) { const k = (d | 0) + 'ms'; m[k] = (m[k] || 0) + 1; }
                return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
            };
            return { interval: tally(c.interval), timeout: tally(c.timeout), raf: c.raf,
                     timeoutTotal: c.timeout.length, intervalTotal: c.interval.length,
                     rafBy: Object.entries(c.by || {}).sort((a, b) => b[1] - a[1]).slice(0, 8) };
        })()`);
        console.log(`   rAF 调用 ${counts.raf} 次（20 秒内）—— 60fps 常转约 1200 次`);
        console.log(`   新建 setTimeout ${counts.timeoutTotal} 个，setInterval ${counts.intervalTotal} 个`);
        if (counts.timeout.length) console.log('   setTimeout 间隔分布:', counts.timeout.map(([k, n]) => `${k}×${n}`).join(', '));
        if (counts.interval.length) console.log('   setInterval 间隔分布:', counts.interval.map(([k, n]) => `${k}×${n}`).join(', '));
        console.log('\n   rAF 是谁在转（按调用来源）:');
        for (const [st, n] of (counts.rafBy || [])) console.log(`     ${String(n).padStart(5)} 次 · ${st}`);

        console.log('\n③ 这段时间渲染器画了多少帧:');
        const m1 = await s.send('Performance.getMetrics').catch(() => null);
        if (!m1) {
            await s.send('Performance.enable');
        }
        await s.send('Performance.enable').catch(() => { });
        const a1 = (await s.send('Performance.getMetrics')).metrics;
        await sleep(10000);
        const a2 = (await s.send('Performance.getMetrics')).metrics;
        const pick = (arr, n) => { const x = arr.find(m => m.name === n); return x ? x.value : 0; };
        const frames = pick(a2, 'Frames') - pick(a1, 'Frames');
        const script = pick(a2, 'ScriptDuration') - pick(a1, 'ScriptDuration');
        const layout = pick(a2, 'LayoutDuration') - pick(a1, 'LayoutDuration');
        const recalc = pick(a2, 'RecalcStyleDuration') - pick(a1, 'RecalcStyleDuration');
        console.log(`   10 秒空转：画了 ${frames} 帧，JS ${script.toFixed(2)}s，布局 ${layout.toFixed(2)}s，样式重算 ${recalc.toFixed(2)}s`);
        console.log(`   → 空转本该接近 0 帧。${frames > 100 ? '⚠️ 有东西在持续重绘。' : '帧数不高。'}`);
    } finally {
        if (s) s.close();
        try { chrome.kill(); } catch { }
        if (server) { try { server.kill(); } catch { } }
    }
})().catch(e => { console.error('探针挂了:', e.message); process.exit(1); });
