'use strict';
// ==========================================
// 小千（本地 Ollama 模型）上网用的三个工具：search / read / calc
//
// 本地微调模型（xiaoqian / cookie）是按训练侧 chat.py 的工具格式训出来的（Ollama 原生 tool calling），
// 所以这里的名字、参数、描述、返回的文本形状都和 chat.py 保持一模一样 —— 改一处就得两边一起改，
// 不然模型按训练时的样子调，这边接不住。
//
// 只读：搜索是抓必应的结果页，read 是 GET 一个网页取正文；不登录、不点任何东西、不带 cookie。
// read 的网址是模型写的（网页内容里也可能夹带），所以挡掉内网：本机、局域网、Tailscale 段，
// 否则一句「读一下 http://127.0.0.1:3000/api/...」就能让它把 GranCyan 自己的接口读出来。
// 挡法是在建连接那一刻校验解析出的 IP（自定义 lookup），跳转的每一跳也走同一道，DNS 换绑绕不过去。
// ==========================================

const http = require('http'), https = require('https'), dns = require('dns'), net = require('net');

const TOOLS = [{ type: 'function', function: {
    name: 'calc',
    description: '精确计算数学表达式。凡是需要算数的时候都用它，别心算。支持 + - * / // % ** 括号、sqrt log sin cos tan abs round factorial、pi e',
    parameters: { type: 'object', properties: { expr: { type: 'string', description: '数学表达式，如 102893+79283-279391/8397' } }, required: ['expr'] } } },
  { type: 'function', function: {
    name: 'search',
    description: '上网搜索，返回前几条结果的标题、网址和摘要。遇到不认识的人名、作品、新闻、最近的事，先搜再答，别瞎编',
    parameters: { type: 'object', properties: { q: { type: 'string', description: '搜索词' } }, required: ['q'] } } },
  { type: 'function', function: {
    name: 'read',
    description: '打开一个网页读正文（前 3000 字）。摘要不够时，从 search 结果里挑一个网址来读',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '网址' } }, required: ['url'] } } }];

// ---------- 内网判定 ----------
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127)            // CGNAT，Tailscale 就在这段
            || (a === 198 && (b === 18 || b === 19));
    }
    // 先规范成压缩形式：URL 会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]，
    // 以前只认点分那种，十六进制写法直接放行 → 能读到本机 :3000 的 key.pem
    let s = ip.toLowerCase();
    try { s = new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch (_) {}
    if (s.startsWith('::')) {
        const dotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (dotted) return isPrivateIp(dotted[1]);
        const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (hex) {
            const h = parseInt(hex[1], 16), l = parseInt(hex[2], 16);
            return isPrivateIp(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
        }
        return true;   // ::、::1、IPv4 兼容地址等 —— 没有正经公网目标长这样，一律当内网
    }
    // NAT64 / 6to4 都能把任意 IPv4（含 127.0.0.1）塞进去，读网页用不着，直接挡
    if (/^64:ff9b:/.test(s) || /^2002:/.test(s)) return true;
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
}

function safeLookup(host, opts, cb) {
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const bad = addrs.find(a => isPrivateIp(a.address));
        if (bad) return cb(Object.assign(new Error(`不许读内网地址（${bad.address}）`), { code: 'EPRIVATE' }));
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
    });
}

const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
};
const MAX_BYTES = 2 * 1024 * 1024;

function get(url, hops = 0) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch { return reject(new Error('网址格式不对')); }
        if (!/^https?:$/.test(u.protocol)) return reject(new Error('只能读 http/https 网页'));
        // 直接写 IP 的不走 lookup，这里先拦
        const bare = u.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(bare) && isPrivateIp(bare)) return reject(new Error(`不许读内网地址（${bare}）`));
        if (/^localhost$/i.test(bare)) return reject(new Error('不许读内网地址（localhost）'));
        const req = (u.protocol === 'https:' ? https : http).get(u, { headers: UA, lookup: safeLookup, timeout: 15000 }, (res) => {
            const loc = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
                res.resume();
                if (hops >= 4) return reject(new Error('跳转太多次'));
                return resolve(get(new URL(loc, u).href, hops + 1));
            }
            if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP Error ${res.statusCode}`)); }
            const chunks = []; let n = 0;
            res.on('data', c => { n += c.length; if (n <= MAX_BYTES) chunks.push(c); else res.destroy(); });
            res.on('close', () => {
                const buf = Buffer.concat(chunks);
                const cs = ((res.headers['content-type'] || '').match(/charset=([\w-]+)/i) || [])[1]
                    || (buf.slice(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
                let text;
                try { text = new TextDecoder(cs.toLowerCase()).decode(buf); } catch { text = buf.toString('utf8'); }
                resolve(text);
            });
        });
        req.on('timeout', () => req.destroy(new Error('超时了')));
        req.on('error', reject);
    });
}

const unescape = s => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|middot|hellip|mdash|ndash);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–' }[k];
});
const textOf = s => unescape(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function search(q) {
    let t;
    try { t = await get('https://cn.bing.com/search?setlang=zh-cn&q=' + encodeURIComponent(q)); }
    catch (e) { return `搜不了：${e.message}`; }
    const out = [];
    for (const b of (t.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []).slice(0, 6)) {
        const ti = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
        const a = b.match(/<a[^>]+href="(http[^"]+)"/);
        const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        out.push([ti ? textOf(ti[1]) : '', a ? unescape(a[1]) : '', p ? textOf(p[1]).slice(0, 200) : ''].join('\n'));
    }
    return out.join('\n\n') || '没搜到';
}

async function read(url) {
    if (!/^https?:\/\//i.test(url)) return '只能读 http/https 网页';
    let t;
    try { t = await get(url); } catch (e) { return `打不开：${e.message}`; }
    t = t.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    return textOf(t).slice(0, 3000) || '页面是空的';
}

// 计算器：只认数字、四则、括号、少数函数和常量 —— 先按白名单切词，再交给 Function 算。
// 切词后能出现的只有数字、运算符、括号、逗号和白名单里的名字，碰不到任何对象和全局。
const FUNCS = { __proto__: null, sqrt: 'Math.sqrt', log: 'Math.log', log10: 'Math.log10', sin: 'Math.sin', cos: 'Math.cos',
    tan: 'Math.tan', abs: 'Math.abs', round: 'Math.round', factorial: 'fact' };
const CONSTS = { __proto__: null, pi: 'Math.PI', e: 'Math.E' };
function calc(expr) {
    const src = String(expr).replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**');
    const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|\*\*|\/\/|[-+*/%(),]|[a-z_]\w*|\S/gi) || [];
    const js = [];
    for (const k of toks) {
        if (/^[\d.]/.test(k) || /^(\*\*|[-+*/%(),])$/.test(k)) js.push(k);
        else if (FUNCS[k]) js.push(FUNCS[k]);
        else if (CONSTS[k]) js.push(CONSTS[k]);
        else if (k === '//') return '算不了：整除 // 不支持，先用 / 算出来再取整';
        else return '算不了：只能算数学式子';
    }
    const fact = (n) => { if (!Number.isInteger(n) || n < 0) throw new Error('阶乘只算非负整数'); if (n > 170) throw new Error('阶乘太大'); let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
    try {
        const v = Function('fact', '"use strict"; return (' + js.join(' ') + ');')(fact);
        if (typeof v !== 'number' || !Number.isFinite(v)) return '算不了：结果不是有限的数';
        return String(Number.isInteger(v) ? v : Math.round(v * 1e10) / 1e10);
    } catch (e) { return `算不了：${e.message}`; }
}

async function runTool(name, args) {
    if (name === 'calc') return calc(String(args.expr ?? ''));
    if (name === 'search') return search(String(args.q ?? ''));
    if (name === 'read') return read(String(args.url ?? ''));
    return '没有这个工具';
}

module.exports = { TOOLS, runTool, calc, isPrivateIp, safeLookup, get, read, search };
