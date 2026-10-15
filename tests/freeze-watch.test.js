/* 「是谁冻住了窗口」记录器的测试。
 *
 * 这个工具的产出是**线索**，而假指认比没有指认更糟 —— 它会把人支到完全错误的
 * 方向上查一整天。所以这里守的不只是「能报出卡顿」，还有「不该报的时候不报」，
 * 以及**措辞不许把线索说成结论**（Codex 逮到我第一版写成了「名字就是嫌疑人」）。
 *
 * 最要紧的一条是「事后归因」：卡顿是这样被发现的 —— 主线程被占住 → 占完了 →
 * 定时器这才回来 → 算出延迟。等它回来的时候，罪魁那个请求早就结束了。
 * 第一版只看「此刻在飞」，自测当场打出「当时没有请求在飞，看别处」，
 * 而卡顿正是那个路由造成的。
 *
 * 跑法：node tests/freeze-watch.test.js
 */
const express = require('express');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { mountFreezeWatch } = require(path.join(ROOT, 'server', 'ui-freeze-watch.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const app = express();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    mountFreezeWatch(app);

    app.get('/blocks-the-thread', (req, res) => {
        const end = Date.now() + 400;
        while (Date.now() < end) { }          // 同步死循环 = 真的占住主线程
        res.json({ ok: true });
    });
    app.get('/just-slow', async (req, res) => {
        await sleep(400);                      // 等待，线程是空的
        res.json({ ok: true });
    });

    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(base + p).then(r => r.json());

    try {
        console.log('\n窗口卡住记录器:');

        // ── 对照组先跑：慢 ≠ 卡 ──
        // ⚠️ 这条必须排在前面。放后面的话，前一条的告警还留在 warns 里，
        //   「对照组没有告警」这个判断就永远成立不了 —— 断言会变成假绿。
        await get('/just-slow');
        await sleep(400);
        t('☑ 对照：等 400ms 但不占线程的请求，不算卡（慢和卡是两回事，混为一谈会满屏假警报）',
          warns.length === 0, warns);

        // ── 真的占住线程 ──
        await get('/blocks-the-thread');
        await sleep(400);
        t('★★ 占住主线程 400ms 会被逮到（这就是窗口「未响应」的直接度量）',
          warns.length >= 1, warns.length);
        t('★★ 列出了时间上重叠的那条路由（这是线索，不是指认 —— 见下面那条措辞断言）',
          warns.some(w => w.includes('/blocks-the-thread')), warns[0]);
        t('☑ 对照：没把那个只是慢的路由也拖出来当嫌疑人',
          !warns.some(w => w.includes('/just-slow')), warns[0]);

        // ── 事后归因：报出来的时候请求已经结束了 ──
        const w = await get('/api/freeze-watch');
        t('★★ 战绩里留着最严重的那次，且带着凶手名字（事后归因：报的时候它已经结束了）',
          !!(w.最严重的一次 && w.最严重的一次.who.includes('/blocks-the-thread')),
          w.最严重的一次);
        t('★ 记下的卡顿时长是有意义的量级（几百毫秒，不是 0 也不是荒唐的大数）',
          w.最严重的一次.lag >= 200 && w.最严重的一次.lag < 5000, w.最严重的一次.lag);

        // ── 措辞不许把线索说成结论（Codex 逮到的）──
        // ⚠️ 这条守的是**用词**，不是行为，但它守的东西是真的：
        //   Express 只有起止时间，证明不了谁占了线程。一个在异步等上游 30 秒的请求，
        //   和一个真做了 500ms 同步 fs 的请求，在这张表里长得一模一样。
        //   措辞一旦读起来像指认，就会把人支到错误的方向 —— 那正是这个工具最该避免的事。
        t('★★ 日志说的是「时间上重叠」不是「占住主线程」（凭起止时间证明不了归因）',
          warns.every(w => !w.includes('主线程被占住')) && warns.some(w => w.includes('时间上重叠')),
          warns[0]);
        t('★ 单条请求的时长叫「历时」不叫「占了」（异步等待也会被列出来）',
          warns.some(w => w.includes('历时')) && warns.every(w => !w.includes('（占了')), warns[0]);

        // ── 诊断端点不许把自己算进去（Codex 逮到的）──
        const w2 = await get('/api/freeze-watch');
        t('★★ 查询自己不出现在「此刻在飞」里（不排的话每次查都指认自己）',
          !String(w2.此刻在飞).includes('/api/freeze-watch'), w2.此刻在飞);
        t('★ 战绩里同时给出上界（lag 是下界，别让人当成精确的冻结时长）',
          typeof w2.最严重的一次.upTo === 'number' && w2.最严重的一次.upTo > w2.最严重的一次.lag,
          w2.最严重的一次);
        // ── 它自己不许成为新的挂起原因 ──
        const src = require('fs').readFileSync(path.join(ROOT, 'server', 'ui-freeze-watch.js'), 'utf8');
        t('★★ 采样定时器 unref 了（本来是来查「有东西不肯走」的，别自己变成一个）',
          /timer\.unref\(\)/.test(src));
        t('★ 只听 finish 不够，close 也要听（SSE 断流的记录不清掉，之后每次都会被当成嫌疑人）',
          /res\.on\('close'/.test(src) && /res\.on\('finish'/.test(src));

        // ⚠️ 时钟必须单调。用 Date.now() 的话，系统时钟前跳、笔记本从睡眠恢复，
        //   都会凭空冒出一个巨大的假卡顿（Codex 逮到的）。
        t('★★ 采样用单调时钟 hrtime，不用 Date.now（睡眠恢复会造出假卡顿）',
          src.includes('process.hrtime.bigint()') && !src.includes('let expected = Date.now()'));
        const m = src.match(new RegExp('const SAMPLE_MS = (' + '\\' + 'd+);'));
        t('★ 采样周期明显小于阈值（周期和阈值同量级的话，比阈值略长的阻塞会整个漏掉）',
          !!m && Number(m[1]) * 2 <= 250, m && m[1]);
        // ⚠️ 记录器本身写好了不等于它挂上了。2026-08-28 实犯：我加的那行挂载
        //   被另一个会话覆盖 server.js 时静默抹掉了，而且从没提交过 ——
        //   模块还在、测试还绿，但线上一条日志都不会有。守住那一行。
        const srvSrc = require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const NL = String.fromCharCode(10);
        const noComment = srvSrc.split(NL).filter(l => !l.trim().startsWith('//')).join(NL);
        t('★★ server.js 里真的挂了这个记录器（模块写好≠挂上了，被覆盖掉是静默的）',
          noComment.includes('mountFreezeWatch(app)'));
        // 挂载位置也要守：挂在路由后面的话，它记不到在飞的请求，
        // 卡顿照样报，但永远说「这段时间一个请求都没跑过」—— 又是一次假指认。
        const mountAt = noComment.indexOf('mountFreezeWatch(app)');
        const firstRoute = Math.min(...['app.get(', 'app.post(', 'app.use(express.static']
          .map(k => { const i = noComment.indexOf(k); return i < 0 ? Infinity : i; }));
        t('★★ 而且挂在所有路由之前（挂晚了就记不到在飞的请求，指认永远是空的）',
          mountAt > 0 && mountAt < firstRoute, { 挂载位置: mountAt, 第一个路由: firstRoute });
    } finally {
        console.warn = origWarn;
        srv.closeAllConnections?.();
        await new Promise(r => srv.close(r));
    }

    console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试自己炸了:', e); process.exit(1); });
