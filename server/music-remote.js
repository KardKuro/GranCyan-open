// server/music-remote.js
// 点歌的「设备」：像 Spotify Connect 那样，手机遥控电脑放歌、电脑也能遥控手机。
//
// 电脑 server 当中转站：每台开着 GranCyan 的设备挂一条 SSE 长连接报到，
//   · 正在放歌的那台把状态（哪首、进度、暂停没有、队列……）POST 上来，这里转给其他设备；
//   · 遥控的那台把指令（播放/暂停/切歌/拖进度/点歌……）POST 上来，这里转给被遥控的那台去执行。
// 歌永远在被遥控的那台上真的放，这里一个字节音频都不碰，也**不落盘**——全是内存里的「此刻」。
//
// 为什么不走云端（Supabase）：云同步是秒级到分钟级的，按个暂停要等几秒才响是没法用的。
// 手机本来就连着电脑 server（局域网 / Tailscale），配对码那道闸照常生效（fetch 包装器会带 X-GC-Token）。
//
// 设备身份是前端自己在 localStorage 里生成的随机 id，名字是「电脑」「手机」这种。
// 断线不立刻除名：手机切后台、网络抖一下，连接会断了又连，立刻除名的话遥控那头会闪一下「设备不见了」。
'use strict';

const GRACE_MS = 15000;       // 断线后留多久才算这台真的走了
const PING_MS = 20000;        // SSE 心跳：有些代理/系统 60s 没数据就掐连接

function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
function cleanId(s) { return clip(s, 64).replace(/[^\w.-]/g, ''); }

// 纯内存的设备表。和 HTTP 拆开，测试可以直接驱动它。
function createHub({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const devs = new Map();     // id -> { id, name, kind, streams:Set, st, stAt, target, goneTimer }

    function summary() {
        return [...devs.values()].map(d => ({
            id: d.id, name: d.name, kind: d.kind,
            online: d.streams.size > 0,
            target: d.target || null,
            by: [...devs.values()].filter(x => x.target === d.id).map(x => x.id),
            now: d.st && d.st.song ? { name: clip(d.st.song.name, 80), artist: clip(d.st.song.artist, 60), paused: !!d.st.paused } : null,
        }));
    }
    function send(d, event, data) {
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of d.streams) { try { res.write(line); } catch (e) {} }
    }
    function broadcast(event, data, except) {
        for (const d of devs.values()) if (d.id !== except) send(d, event, data);
    }
    function announce() { broadcast('devices', summary()); }

    function join(id, name, kind, res) {
        id = cleanId(id); if (!id) return null;
        let d = devs.get(id);
        if (!d) { d = { id, name: '', kind: '', streams: new Set(), st: null, stAt: 0, target: null, goneTimer: null }; devs.set(id, d); }
        d.name = clip(name, 24) || '设备';
        d.kind = clip(kind, 12);
        if (d.goneTimer) { clearTimer(d.goneTimer); d.goneTimer = null; }
        d.streams.add(res);
        send(d, 'hello', { you: id, devices: summary() });
        // 新来的这台要能马上看到别人正在放什么（设备菜单里那行「▶ 歌名」）。
        // age = 这份状态是多久以前报的：进度要从「那一刻」往后推，不能当成刚报的
        for (const o of devs.values()) if (o.id !== id && o.st) send(d, 'state', { dev: o.id, st: o.st, age: now() - o.stAt });
        announce();
        return d;
    }
    function leave(id, res) {
        const d = devs.get(cleanId(id)); if (!d) return;
        d.streams.delete(res);
        if (d.streams.size) return;
        announce();   // 先报「掉线了」（online:false），宽限期过了才真的删
        if (d.goneTimer) clearTimer(d.goneTimer);
        d.goneTimer = setTimer(() => {
            if (d.streams.size) return;
            devs.delete(d.id);
            // 它在遥控谁，谁那边的「被遥控中」要撤掉；谁在遥控它，谁要知道它没了
            for (const o of devs.values()) if (o.target === d.id) { o.target = null; send(o, 'gone', { dev: d.id }); }
            announce();
        }, GRACE_MS);
    }
    function setState(id, st) {
        const d = devs.get(cleanId(id)); if (!d) return false;
        d.st = st && typeof st === 'object' ? st : null;
        d.stAt = now();
        broadcast('state', { dev: d.id, st: d.st, age: 0 }, d.id);
        return true;
    }
    function command(from, to, cmd, args) {
        const f = devs.get(cleanId(from)), d = devs.get(cleanId(to));
        if (!d || !d.streams.size) return { ok: false, error: '那台设备不在线' };
        if (f && f.id === d.id) return { ok: false, error: '不能遥控自己' };
        // 发指令的那台在这里已经不挂着它了（被别的设备接管、「released」那条没收到）：
        // 不转发，告诉它退回去——否则它按的每个键都作用在一台已经变成遥控器的设备上
        if (f && f.target !== d.id) return { ok: false, error: '已经不在遥控那台了', detached: true };
        send(d, 'cmd', { from: f ? f.id : '', fromName: f ? f.name : '', cmd: clip(cmd, 24), args: args && typeof args === 'object' ? args : {} });
        return { ok: true };
    }
    function attach(id, to) {
        const d = devs.get(cleanId(id)); if (!d) return { ok: false, error: '先连上再遥控' };
        const t = to ? devs.get(cleanId(to)) : null;
        if (to && (!t || t.id === d.id)) return { ok: false, error: t ? '不能遥控自己' : '那台设备不在线' };
        d.target = t ? t.id : null;
        // 一台设备要么在放歌、要么在当遥控器，不能两样都是（实测：手机遥控着电脑，
        // 电脑再去遥控手机，手机那条遥控没自己断，两台互相当镜像、谁的键都不灵）。
        //   · d 变成遥控器 → 正在遥控 d 的那些松开（d 不放歌了）；
        //   · 被挂上的 t 要当播放器 → t 自己要是正在遥控谁，也松开。
        // 两条可能落在同一台上（两台互相挂），只通知一次。
        if (t) {
            for (const o of devs.values()) {
                if (o.id === d.id || !o.target) continue;
                if (o.target === d.id || o.id === t.id) {
                    const was = o.target;
                    o.target = null;
                    send(o, 'released', { by: d.id, byName: d.name, to: t.id, was });
                }
            }
        }
        announce();
        return { ok: true, st: t ? t.st : null, age: t && t.st ? now() - t.stAt : 0 };
    }
    function ping() { for (const d of devs.values()) for (const res of d.streams) { try { res.write(': ping\n\n'); } catch (e) {} } }
    return { join, leave, setState, command, attach, summary, ping, _devs: devs };
}

function mount(app) {
    if (!app) throw new Error('music-remote.mount: 缺 app —— 装配层漏传了');
    const hub = createHub();
    const beat = setInterval(() => hub.ping(), PING_MS);
    if (beat.unref) beat.unref();

    app.get('/api/music/remote/stream', (req, res) => {
        const id = cleanId(req.query.dev);
        if (!id) return res.status(400).json({ error: 'dev 缺失' });
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        hub.join(id, req.query.name, req.query.kind, res);
        res.on('close', () => hub.leave(id, res));
    });
    app.post('/api/music/remote/state', (req, res) => {
        const b = req.body || {};
        res.json({ ok: hub.setState(b.dev, b.st) });
    });
    app.post('/api/music/remote/cmd', (req, res) => {
        const b = req.body || {};
        const r = hub.command(b.from, b.to, b.cmd, b.args);
        res.status(r.ok ? 200 : 409).json(r);
    });
    app.post('/api/music/remote/attach', (req, res) => {
        const b = req.body || {};
        const r = hub.attach(b.dev, b.to || null);
        res.status(r.ok ? 200 : 409).json(r);
    });
    app.get('/api/music/remote/devices', (req, res) => res.json({ devices: hub.summary() }));
    return hub;
}

module.exports = { mount, createHub, GRACE_MS };
