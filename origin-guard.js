'use strict';
// ==========================================
// 「这个请求是不是自己人发的」——**只此一份**。
//
// 为什么单独拎出来：server.js 和 social-browser.js 都要这道闸，
// 而安全判据抄成两份的下场是改一处漏一处 —— 漏的那处不会报错，
// 只会在某天变成一个能用的入口。
//
// 为什么需要这道闸（loopback 不够）：
//   server 上挂着 cors()，恶意网页可以直接 fetch 到 127.0.0.1。
//   请求是**用户自己的浏览器**发的，所以 remoteAddress 本来就是本机，
//   `只允许 127.0.0.1` 一个字都拦不住。2026-08-23 实测复现过：
//   带 Origin: https://evil.example.com 打 /api/social-browser/check，返回 200。
//
// 判据：
//   · 没有 Origin        → 放行。不是浏览器发的（curl / 探针 / 非浏览器客户端），
//                          那种情况下对方已经在本机上了，这道闸本来也不是为它设的。
//   · Origin 在 extra 里 → 放行。给安卓那种「页面挂在虚拟域名下」的客户端留的口子。
//   · loopback           → 放行。
//   · Origin 的 host == 请求的 Host，**且 Host 确实是本机某个网卡地址** → 放行。
//     后半句不能省：DNS rebinding 可以让 Origin 和 Host 都是攻击者的域名，
//     光比「两边一样」是挡不住的（Codex 2026-08-23 逮到的）。
//   · 其余一律拒，包括 Origin 畸形、非 http(s) 协议、以及 "null"。
// ==========================================
const os = require('os');

const bareHost = (h) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');

// 本机地址。每次现取 —— 网卡会热插拔（Tailscale、WSL、VMware 的虚拟网卡都在动），
// 启动时取一次然后缓存的话，切了网就开始误伤，而且是静默的。
function selfAddrs() {
    const out = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
    try {
        for (const list of Object.values(os.networkInterfaces() || {})) {
            for (const ni of list || []) if (ni && ni.address) out.add(String(ni.address).toLowerCase());
        }
    } catch { }
    return out;
}

function makeOriginGuard(extraOrigins) {
    const extra = new Set((extraOrigins || []).filter(Boolean));
    return function originOk(req) {
        const o = req && req.headers && req.headers.origin;
        if (!o) return true;
        if (extra.has(o)) return true;
        let u;
        try { u = new URL(o); } catch { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const h = bareHost(u.hostname);
        if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
        const host = bareHost(String((req.headers.host) || '').replace(/:\d+$/, ''));
        return !!host && h === host && selfAddrs().has(host);
    };
}

// ==========================================
// 「这台设备配过对吗」——给**不是本机**的请求加的第二道闸。
//
// 为什么来源闸不够：Origin 只拦得住**浏览器**（网页改不了自己的 Origin）。
// 局域网 / tailnet 上任何一台设备拿 curl 不带 Origin（或者随手伪造一个
// `Origin: http://127.0.0.1`）打过来，来源闸一律放行 —— 而 /api 后面挂着
// 本地 Claude 的电脑操控（bypassPermissions 跑命令）、偷看屏幕、全部对话。
// 同一个 WiFi 的访客手机、中了毒的智能家电，都够得着。
//
// 判据：
//   · 本机发的（loopback，或者源地址就是本机某块网卡）→ 放行，和以前一样。
//     Electron、电脑浏览器、本机上的引擎/探针全走这条，一个都不用改。
//   · 带了反代头（cf-connecting-ip / x-forwarded-for …）→ **一律当外人**。
//     cloudflared 这类隧道从本机转进来，源地址是 127.0.0.1，不看这些头就等于把公网当本机。
//   · 其余（手机 APK、手机浏览器、tailnet 上的别的机器）→ 必须带配对码：
//     头 X-GC-Token、查询参数 ?gct=、或 cookie gct（带码访问过一次后服务端种下，
//     给 <img>/<audio>/整页跳转这种加不了头的请求用）。
// 配对码存在数据目录的 .pair-token（已 gitignore），电脑端设置里能看到、能换。
// ==========================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉 0/O、1/I/L，手机上照着打不会认错
const PAIR_LEN = 10;                                        // 31^10 ≈ 2^49.5，配上失败限流够用

function newPairToken() {
    let s = '';
    const bytes = crypto.randomBytes(PAIR_LEN * 2);
    for (let i = 0; s.length < PAIR_LEN; i++) {
        const b = bytes[i % bytes.length];
        if (b < 248) s += PAIR_ALPHABET[b % 31];            // 248 = 31*8，拒绝采样免得偏
        if (i > PAIR_LEN * 20) return newPairToken();
    }
    return s;
}
// 手机上照着打：大小写、空格、横杠都不该算错
const normPair = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
const fmtPair = (s) => s.slice(0, 5) + '-' + s.slice(5);

const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip'];

function isLocalReq(req) {
    const h = (req && req.headers) || {};
    if (PROXY_HEADERS.some(k => h[k])) return false;
    let ip = String((req && req.socket && req.socket.remoteAddress) || '').toLowerCase();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (!ip) return false;
    if (ip === '::1' || /^127\./.test(ip)) return true;
    if (ip === '0.0.0.0' || ip === 'localhost') return false;   // 不可能是真的源地址，别让 selfAddrs 里的占位放行
    return selfAddrs().has(ip);
}

function readCookie(req, name) {
    const raw = String((req && req.headers && req.headers.cookie) || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
    return '';
}

// dir：配对码落盘的目录（数据目录，可写）。env GRANCYAN_LAN_OPEN=1 整道闸关掉（拦错了的逃生口）。
function makePairGate({ dir, open = process.env.GRANCYAN_LAN_OPEN === '1', log = console } = {}) {
    const file = path.join(dir || '.', '.pair-token');
    let token = '';
    function load() {
        try { token = normPair(fs.readFileSync(file, 'utf8')); } catch { token = ''; }
        if (token.length !== PAIR_LEN || [...token].some(c => !PAIR_ALPHABET.includes(c))) rotate();
        return token;
    }
    function rotate() {
        token = newPairToken();
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, token + '\n', { mode: 0o600 }); }
        catch (e) { log.warn && log.warn('[配对] 配对码写不进 ' + file + '（这次启动先用内存里的，重启会换）:', e.message); }
        return token;
    }
    load();

    function matches(given) {
        const a = Buffer.from(normPair(given));
        const b = Buffer.from(token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    // 失败限流：同一个源地址 10 分钟里错 20 次就先关 10 分钟门
    const fails = new Map();
    const FAIL_WIN = 10 * 60 * 1000, FAIL_MAX = 20;
    function locked(ip) {
        const f = fails.get(ip);
        if (!f) return false;
        if (Date.now() - f.t > FAIL_WIN) { fails.delete(ip); return false; }
        return f.n >= FAIL_MAX;
    }
    function noteFail(ip) {
        const f = fails.get(ip);
        if (!f || Date.now() - f.t > FAIL_WIN) fails.set(ip, { n: 1, t: Date.now() });
        else f.n++;
        if (fails.size > 1000) fails.delete(fails.keys().next().value);
    }
    let lastWarn = 0;

    // 路由对大小写不敏感（/API/x 也会进 /api/x），还会吃 //、%61 这类写法 —— 规整了再判
    const gated = (p) => {
        let s = String(p || '');
        try { s = decodeURIComponent(s); } catch { return true; }
        s = path.posix.normalize(('/' + s).replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
        return /^\/(api|reading)(\/|$)/i.test(s);
    };

    function middleware(req, res, next) {
        if (open || isLocalReq(req)) return next();
        const ip = String(req.socket && req.socket.remoteAddress || '');
        const fromHeader = req.headers['x-gc-token'];
        const fromQuery = req.query && typeof req.query.gct === 'string' ? req.query.gct : '';
        const fromCookie = readCookie(req, 'gct');
        const given = fromHeader || fromQuery || fromCookie;
        if (given && !locked(ip) && matches(given)) {
            // 头或查询参数带对了：顺手种 cookie，之后同源的 <img>/<audio>/整页跳转不用再带
            if (!fromCookie || !matches(fromCookie)) {
                res.append('Set-Cookie', `gct=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
            }
            return next();
        }
        if (!gated(req.path)) return next();
        if (given) noteFail(ip);
        if (Date.now() - lastWarn > 30000) {
            lastWarn = Date.now();
            log.warn && log.warn(`[配对] 挡下没配对的设备：${ip} ${req.method} ${req.path}${given ? '（配对码不对）' : ''}`
                + `\n    是你自己的手机的话：电脑上 GranCyan 设置里有配对码，填到手机设置的「配对码」。`);
        }
        if (locked(ip)) return res.status(429).json({ error: '配对码错太多次了，过 10 分钟再试', pair: true });
        // 整页打开的（手机浏览器点进书架之类）给个能填码的页面，别甩一坨 JSON
        if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''))) {
            return res.status(401).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>要配对码</title><body style="background:#111;color:#ddd;font:16px sans-serif;padding:24px;max-width:420px;margin:auto">
<h2>这台电脑要配对码</h2><p style="color:#999">电脑上打开 GranCyan → 设置，能看到「手机配对码」。</p>
<form method="get"><input name="gct" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX" style="width:100%;padding:10px;font-size:18px;background:#222;color:#eee;border:1px solid #444;border-radius:6px">
<button style="margin-top:12px;width:100%;padding:12px;font-size:16px;background:#335;color:#fff;border:0;border-radius:6px">连接</button></form></body>`);
        }
        return res.status(401).json({ error: '这台电脑要配对码才让连（电脑上 GranCyan 设置里能看到，填到手机设置的「配对码」）', pair: true });
    }

    return { middleware, isLocalReq, token: () => token, formatted: () => fmtPair(token), rotate, file };
}

module.exports = { makeOriginGuard, selfAddrs, makePairGate, isLocalReq, normPair, newPairToken };
