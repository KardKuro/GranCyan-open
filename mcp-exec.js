// mcp-exec.js —— 把这台 Windows 电脑暴露成一个 MCP 服务器，供 claude.ai 网页版远程操控。
//
// 挂载方式：server.js 里 require 本文件并调用 maybeMountExecMcp(app, root)。
// **默认不挂**：只有环境变量 EXEC_MCP=on 时才注册路由、生成 token。
// 对外地址：https://<域名>/mcp/<TOKEN>/sse   （TOKEN 即密码，见 .mcp-token）
//
// 同时实现两种 MCP 传输：
//   - Streamable HTTP：POST /mcp/<TOKEN>/sse            （新协议，claude.ai 优先用）
//   - 旧版 SSE：      GET  /mcp/<TOKEN>/sse + POST .../message?id=xxx
//
// 安全模型：TOKEN 在 URL 路径里，等同于这台机器的 shell 密码。泄露 = 别人能在你电脑上执行任意命令。

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_OUTPUT = 30000;     // 单次返回给模型的最大字符数
const TIMEOUT_MS = 120000;    // 命令超时
// 默认工作目录：EXEC_MCP_CWD 指定，没设就用当前用户的主目录
const DEFAULT_CWD = process.env.EXEC_MCP_CWD || require('os').homedir();

// ---------- TOKEN：优先环境变量，否则从 .mcp-token 读，没有就自动生成 ----------
function loadToken(root) {
    if (process.env.EXEC_MCP_TOKEN) return process.env.EXEC_MCP_TOKEN;
    const f = path.join(root, '.mcp-token');
    try {
        const t = fs.readFileSync(f, 'utf8').trim();
        if (t) return t;
    } catch (_) { /* 不存在，往下生成 */ }
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(f, t + '\n', 'utf8');
    return t;
}

// ---------- 高危命令拦截 ----------
// 不是为了防黑客（拿到 TOKEN 的人总有办法绕过），是为了防「模型一时脑抽」把机器格了。
const DANGER = [
    /\bformat\s+[a-z]:/i,
    /\brd\s+\/s\b|\brmdir\s+\/s\b/i,
    /remove-item[^|\n]*\b(c:\\|c:\/|\$env:systemroot|\$env:windir)/i,
    /\brm\s+(-\w*\s+)*-\w*[rf]\w*\s+\/(\s|$)/i,           // rm -rf /
    /\b(shutdown|restart-computer|stop-computer)\b/i,
    /\bdiskpart\b|\bcipher\s+\/w\b|\bvssadmin\s+delete\b/i,
    /\bdel\s+\/[sq]\b[^|\n]*\b(c:\\windows|c:\\program)/i,
];
function dangerHit(cmd) {
    return DANGER.find(re => re.test(cmd));
}

// ---------- 审计日志 ----------
let LOG_FILE = null;
function audit(kind, detail) {
    const line = `[${new Date().toISOString()}] ${kind} ${detail}\n`;
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
    console.log(`[MCP] ${kind} ${detail.slice(0, 200)}`);
}

// ---------- 工具定义 ----------
const TOOLS = [
    {
        name: 'exec_pc',
        description: '在用户的 Windows 电脑上执行终端命令并返回输出。默认 PowerShell，默认工作目录是 EXEC_MCP_CWD（没设就是用户主目录）。可用来跑 git、node、npm、打包脚本等。',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令' },
                cwd: { type: 'string', description: '工作目录，默认 EXEC_MCP_CWD 或用户主目录' },
                shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'powershell(默认) / cmd / bash(Git Bash)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description: '读取电脑上的一个文本文件。可用 offset/limit 只读某一段（大文件必须分段读）。',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: '绝对路径，如 C:\\projects\\GranCyan\\server.js' },
                offset: { type: 'number', description: '起始行号（1 开始），默认 1' },
                limit: { type: 'number', description: '读取行数，默认 400' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'write_file',
        description: '写文件。mode=overwrite 整体覆盖；mode=replace 做精确字符串替换（old_string 必须在文件中唯一出现）。改代码优先用 replace。',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: '绝对路径' },
                mode: { type: 'string', enum: ['overwrite', 'replace'], description: 'overwrite(默认) 或 replace' },
                content: { type: 'string', description: 'mode=overwrite 时的完整新内容' },
                old_string: { type: 'string', description: 'mode=replace 时要被替换的原文（须唯一）' },
                new_string: { type: 'string', description: 'mode=replace 时替换成的新文本' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'list_dir',
        description: '列出目录内容（名称 / 大小 / 修改时间）。',
        inputSchema: {
            type: 'object',
            properties: { dir_path: { type: 'string', description: '目录绝对路径，默认 EXEC_MCP_CWD 或用户主目录' } },
        },
    },
];

// ---------- 工具实现 ----------
function runCommand({ command, cwd, shell }) {
    return new Promise(resolve => {
        const hit = dangerHit(command);
        if (hit) {
            audit('BLOCKED', command);
            return resolve(`⛔ 命令被高危拦截规则挡下（匹配 ${hit}）。\n如果确实需要，请用户本人在电脑上手动执行。`);
        }
        const workdir = cwd && fs.existsSync(cwd) ? cwd : DEFAULT_CWD;
        audit('EXEC', `[${shell || 'powershell'} @ ${workdir}] ${command}`);

        let proc;
        try {
            // windowsHide 三条都要：输出全走管道回 MCP，没有任何理由在用户屏幕上
            // 弹一个黑窗口（exe 里主进程没控制台，不写就必然新开一个）。
            if (shell === 'cmd') {
                proc = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: workdir, windowsVerbatimArguments: true, windowsHide: true });
            } else if (shell === 'bash') {
                proc = spawn('bash', ['-lc', command], { cwd: workdir, windowsHide: true });
            } else {
                // Windows PowerShell 默认按 GBK 输出，中文会变乱码 —— 强制切 UTF-8
                const wrapped = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ' + command;
                proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { cwd: workdir, windowsHide: true });
            }
        } catch (e) {
            return resolve(`启动失败: ${e.message}`);
        }

        const out = [], err = [];
        let done = false;
        const finish = (extra) => {
            if (done) return;
            done = true;
            let text = Buffer.concat(out).toString('utf8');
            const e = Buffer.concat(err).toString('utf8');
            if (e.trim()) text += (text ? '\n--- stderr ---\n' : '') + e;
            if (extra) text += (text ? '\n' : '') + extra;
            if (!text.trim()) text = '(无输出)';
            if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + `\n... [输出过长，已截断，共 ${text.length} 字符]`;
            resolve(text);
        };

        const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} finish(`⏱ 超时 ${TIMEOUT_MS / 1000}s，已终止进程。`); }, TIMEOUT_MS);
        proc.stdout.on('data', c => out.push(c));
        proc.stderr.on('data', c => err.push(c));
        proc.on('error', e => { clearTimeout(timer); finish(`执行错误: ${e.message}`); });
        proc.on('close', code => {
            clearTimeout(timer);
            finish(code === 0 ? '' : `[退出码 ${code}]`);
        });
    });
}

function toolReadFile({ file_path, offset, limit }) {
    const raw = fs.readFileSync(file_path, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, offset || 1);
    const count = limit || 400;
    const slice = lines.slice(start - 1, start - 1 + count);
    const body = slice.map((l, i) => `${start + i}\t${l}`).join('\n');
    const tail = start - 1 + count < lines.length
        ? `\n\n... [共 ${lines.length} 行，本次显示 ${start}–${start + slice.length - 1}]`
        : '';
    return body + tail;
}

function toolWriteFile({ file_path, mode, content, old_string, new_string }) {
    if ((mode || 'overwrite') === 'replace') {
        if (typeof old_string !== 'string' || !old_string) throw new Error('replace 模式必须提供 old_string');
        const raw = fs.readFileSync(file_path, 'utf8');
        const n = raw.split(old_string).length - 1;
        if (n === 0) throw new Error('old_string 在文件中未找到（注意缩进和换行必须完全一致）');
        if (n > 1) throw new Error(`old_string 在文件中出现 ${n} 次，不唯一 —— 请带上更多上下文`);
        fs.writeFileSync(file_path, raw.replace(old_string, new_string ?? ''), 'utf8');
        audit('WRITE', `replace ${file_path}`);
        return `✅ 已替换：${file_path}`;
    }
    if (typeof content !== 'string') throw new Error('overwrite 模式必须提供 content');
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, content, 'utf8');
    audit('WRITE', `overwrite ${file_path} (${content.length} 字符)`);
    return `✅ 已写入：${file_path}（${content.length} 字符）`;
}

function toolListDir({ dir_path }) {
    const d = dir_path || DEFAULT_CWD;
    const rows = fs.readdirSync(d, { withFileTypes: true }).map(e => {
        const p = path.join(d, e.name);
        let size = '', mtime = '';
        try {
            const st = fs.statSync(p);
            size = e.isDirectory() ? '<DIR>' : String(st.size);
            mtime = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
        } catch (_) {}
        return `${mtime}  ${size.padStart(9)}  ${e.name}`;
    });
    return `${d}\n\n${rows.join('\n') || '(空目录)'}`;
}

async function callTool(name, args) {
    args = args || {};
    try {
        switch (name) {
            case 'exec_pc': {
                if (!String(args.command || '').trim()) return '错误：命令不能为空';
                return await runCommand(args);
            }
            case 'read_file': return toolReadFile(args);
            case 'write_file': return toolWriteFile(args);
            case 'list_dir': return toolListDir(args);
            default: return `未知工具: ${name}`;
        }
    } catch (e) {
        return `❌ ${e.message}`;
    }
}

// ---------- JSON-RPC 分发 ----------
async function handleRpc(msg, clientProtocol) {
    const { id, method, params } = msg;
    const ok = result => ({ jsonrpc: '2.0', id, result });

    switch (method) {
        case 'initialize':
            return ok({
                // 回声客户端声明的协议版本，避免版本协商失败
                protocolVersion: (params && params.protocolVersion) || clientProtocol || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'grancyan-pc', version: '1.0.0' },
            });
        case 'tools/list':
            return ok({ tools: TOOLS });
        case 'tools/call': {
            const text = await callTool(params && params.name, params && params.arguments);
            return ok({ content: [{ type: 'text', text }] });
        }
        case 'ping':
            return ok({});
        // claude.ai 会顺手探测这两个，返回空数组比返回 -32601 干净
        case 'resources/list': return ok({ resources: [] });
        case 'prompts/list': return ok({ prompts: [] });
        default:
            if (String(method || '').startsWith('notifications/')) return null; // 通知无需响应
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

// ---------- 挂载到 Express ----------
function mountExecMcp(app, root) {
    const TOKEN = loadToken(root);
    LOG_FILE = path.join(root, 'mcp-exec.log');
    const base = `/mcp/${TOKEN}`;
    const sseConns = new Map();

    const auth = (req, res, next) => {
        if (req.params.token !== TOKEN) { res.status(401).send('Unauthorized'); return; }
        next();
    };

    // --- Streamable HTTP（新协议）---
    app.post('/mcp/:token/sse', auth, async (req, res) => {
        const out = await handleRpc(req.body || {}, req.get('mcp-protocol-version'));
        if (!out) { res.status(202).end(); return; }   // 通知：202 无内容
        res.json(out);
    });

    // --- 旧版 SSE：GET 建长连接，服务端下发 message 端点 ---
    app.get('/mcp/:token/sse', auth, (req, res) => {
        const connId = crypto.randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: endpoint\ndata: ${base}/message?id=${connId}\n\n`);
        const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) {} }, 15000);
        sseConns.set(connId, res);
        req.on('close', () => { clearInterval(ka); sseConns.delete(connId); });
    });

    app.post('/mcp/:token/message', auth, async (req, res) => {
        const sse = sseConns.get(req.query.id);
        if (!sse) { res.status(404).send('No connection'); return; }
        res.status(202).end('ok');   // 先应答 HTTP，结果走 SSE 通道
        const out = await handleRpc(req.body || {}, req.get('mcp-protocol-version'));
        if (out) { try { sse.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`); } catch (_) {} }
    });

    // --- 自检页：浏览器打开能确认 token 对不对 ---
    app.get('/mcp/:token/health', auth, (req, res) => {
        res.json({ ok: true, server: 'grancyan-pc', tools: TOOLS.map(t => t.name) });
    });

    // 注意：token 的任何一部分都不打进 stdout/日志文件 —— 那等于把 shell 密码写进可能被打包的 debug.log。
    console.log(`🛰️  MCP 远程操控已挂载  ->  /mcp/<token>/sse  （token 见 .mcp-token 或 EXEC_MCP_TOKEN）`);
    console.log(`   工具: ${TOOLS.map(t => t.name).join(', ')}   审计日志: mcp-exec.log`);
    return TOKEN;
}

// 默认不挂：这条路由等于把这台电脑的 shell 暴露出去，必须显式设 EXEC_MCP=on 才启用。
// 没开时一条路由都不注册、也不生成 .mcp-token。返回是否挂上了。
function execMcpEnabled(env) {
    return /^(on|1|true|yes)$/i.test(String((env || {}).EXEC_MCP || '').trim());
}
function maybeMountExecMcp(app, root, env = process.env) {
    if (!execMcpEnabled(env)) return false;
    mountExecMcp(app, root);
    return true;
}

module.exports = { mountExecMcp, maybeMountExecMcp, execMcpEnabled };
