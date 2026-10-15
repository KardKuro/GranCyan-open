#!/usr/bin/env node
// mcp-chromecare.js —— 给本地 Claude 的「打理专用浏览器」能力（stdio MCP 服务器）
//
// 需求：聊天里的 Claude 在用户同意的情况下能帮用户清浏览器，「就和终端一样」——
// 终端那边是工具给它、破坏性的事先问用户、用户点头了才动。这里同一个规矩：
// 工具挂上，「先问、等用户说好」写在 BROWSER_NOTE 里（server.js）。
//
// 为什么单开一个 server 而不是塞进 playwright MCP 那边：
//   playwright 只认 CDP，CDP 没有清历史的命令；真正能清的办法是「关掉专用 Chrome → 删 History」，
//   这件事得由 GranCyan 服务端来做（它知道有没有小红书的活正在飞，飞着的时候不许关）。
//   所以这里只是一层壳：把调用转成 POST /api/social-browser/clear-history。
//
// 挂载：server.js 的 mcpConfigFile({ chromecare: 1 })，只在「🌐 浏览器」开着时挂。
// 服务端地址从 GRANCYAN_SERVER 拿（server.js 生成配置时写进 env），用 127.0.0.1 不用 localhost
// （这台机器上 localhost 走 ::1 会被 wslrelay 截胡）。

const SERVER = process.env.GRANCYAN_SERVER || 'http://127.0.0.1:3000';

const TOOLS = [
    {
        name: 'clear_history',
        description: '清掉用户那个专用 Chrome（登录着小红书的那个）的浏览记录：历史、访问过的链接、常去网站、地址栏联想。'
            + 'Cookie 和登录状态不动，清完照样登录着。'
            + '做法是先把那个 Chrome 关掉再删记录文件，所以调完这一轮的 browser_* 工具就断了，下一轮会自动重新打开。'
            + '⚠️ 只在用户明确说了要清 / 同意你清之后才调用。',
        inputSchema: { type: 'object', properties: {} },
    },
];

async function clearHistory() {
    let r;
    try {
        r = await fetch(SERVER + '/api/social-browser/clear-history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        return `连不上 GranCyan 服务端（${SERVER}）：${e.message}`;
    }
    let j = {};
    try { j = await r.json(); } catch (_) { }
    if (j.error) return `没清成：${j.error}`;
    if (!r.ok) return `没清成：HTTP ${r.status}`;
    const lines = [];
    lines.push(j.wasOpen ? '专用浏览器已经关掉了（这一轮的 browser_* 工具从这里开始用不了，下一轮会自动重开）。' : '专用浏览器本来就没开着。');
    lines.push(j.removed && j.removed.length ? `删掉了：${j.removed.join('、')}` : '没有找到要删的记录文件（本来就是空的）。');
    if (j.failed && j.failed.length) lines.push(`⚠️ 这几个删不动（多半是浏览器又被拉起来锁住了），没清干净：${j.failed.join('、')}`);
    else lines.push('浏览记录清干净了，Cookie 和登录没动。');
    return lines.join('\n');
}

const HANDLERS = { clear_history: clearHistory };

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
    const { id, method, params } = msg;
    // 通知（没有 id）不需要也不允许回复
    if (id === undefined || id === null) return;
    if (method === 'initialize') {
        return send({
            jsonrpc: '2.0', id, result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'chromecare', version: '1.0.0' },
            }
        });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
        const fn = HANDLERS[params && params.name];
        if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `没有这个工具：${params && params.name}` } });
        let text;
        try { text = await fn(params.arguments || {}); }
        catch (e) { text = `工具执行出错：${e.message}`; }
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
}

let buf = '';
let inflight = 0;
let stdinDone = false;
// 同 mcp-github.js：stdin 关了也要等手上那条清完再走，不然回复会被连人带走
function maybeExit() { if (stdinDone && inflight === 0) process.exit(0); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        inflight++;
        handle(msg)
            .catch(e => { try { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); } catch (_) { } })
            .finally(() => { inflight--; maybeExit(); });
    }
});
process.stdin.on('end', () => { stdinDone = true; maybeExit(); });
