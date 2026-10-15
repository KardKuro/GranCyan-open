'use strict';
// 订阅 GPT 的流式通道：用 `codex app-server` 跑一轮，但对外**装成 `codex exec --json` 那个进程**。
//
// 为什么要装：/api/local-gpt 那条路围着 exec 的进程长了一圈东西 —— JSONL 解析、空闲计时、
// 活的登记和 taskkill /T、续传索引、close 里的收尾。exec 只在一整条消息写完才吐（item.completed），
// 没有逐字增量；逐字只有 app-server 给（item/agentMessage/delta）。整条路重写风险太大，
// 所以这里把 app-server 的 JSON-RPC 翻译回 exec 的那几行 JSONL，再多吐一种 {"type":"item.delta"}。
// 路由那边除了认 item.delta，别的一行不用动；app-server 走不通就原样退回 exec。
//
// ⚠️ app-server **没有** --ignore-user-config（只有 exec 有，2026-10-07 翻 0.153 二进制确认）。
//    它会读 $CODEX_HOME/config.toml —— 用户自己 Codex 的配置：priority 档（更费额度）、
//    node_repl / 文档 MCP（每轮多拉起进程、多塞工具）、notify 钩子（每轮结束拉起 computer-use）。
//    所以：认得的几项逐个压掉；**有不认得的配置就不走这条路**（codexAppConfigCheck），
//    宁可不流式，也不悄悄把她新加的东西带进 GranCyan。
//    注意 `mcp_servers={}` 压不掉表（实测照样拉起），只能按名字逐个 enabled=false。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const fs = require('fs');
const path = require('path');

// 认得、并且下面会压掉 / 每轮显式给值盖掉的顶层配置。
// 加新的之前先确认它在这里**真的被盖住了**，别只是加进名单让检查放行。
const NEUTRALIZED = new Set([
    'approvals_reviewer',      // 路由每轮 -c approvals_reviewer="auto_review"
    'approval_policy',         // thread/start 显式 never
    'sandbox_mode',            // thread/start 显式 sandbox
    'service_tier',            // -c service_tier="default"
    'model',                   // thread/start 显式 model
    'model_reasoning_effort',  // 路由每轮 -c
    'model_reasoning_summary', // 路由每轮 -c
    'model_verbosity',         // 路由每轮 -c
    'notify',                  // -c notify=[]
    'mcp_servers',             // 按名字逐个 enabled=false
    'projects',                // 只是信任级别；聊天/操控的 cwd 里有 .codex/ 会另外判
    'windows',                 // 子键另判（WATCHED_SUB）；sandbox 由 -c windows.sandbox="unelevated" 盖掉
    'features',                // 子键另判（WATCHED_SUB）；hooks 由 --disable hooks 关掉
    'hooks',                   // 只是 hooks.json 的信任哈希；hooks 功能关了就不生效
    'plugins',                 // 插件开关；路由每轮 --disable plugins，整个插件系统不起
    'marketplaces',            // 插件来源，同上
    'tui', 'desktop',          // 只管 Codex 自己的界面
    'shell_environment_policy',// 只给 shell 多设一个 node_repl 信任用的环境变量，无副作用
    'sandbox_workspace_write', // 她那边只有 network_access=true，路由本来就这么设
]);
// 这两张表连子键也只放行认得的：新加一个 feature 开关就可能改掉行为
const WATCHED_SUB = {
    features: new Set(['hooks', 'js_repl']),   // hooks 被 --disable 盖掉；js_repl 在 0.153 已移除
    windows: new Set(['sandbox']),
};

// 极简 TOML 扫描：只要「顶层键名」和「每个 [mcp_servers.X] 的 X」，够判就行，不求解析值
function scanCodexConfig(text) {
    const top = new Set(), mcp = new Set(), sub = new Set();
    const unq = s => s.replace(/^['"]|['"]$/g, '');
    let table = null;   // 当前表的路径（数组）；null = 还在顶层
    for (let raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/^\s+/, '');
        if (!line || line.startsWith('#')) continue;
        const h = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/);
        if (h) {
            table = (h[1].match(/'[^']*'|"[^"]*"|[^.\s]+/g) || []).map(unq);
            top.add(table[0] || '');
            if (table[0] === 'mcp_servers' && table[1]) mcp.add(table[1]);
            if (WATCHED_SUB[table[0]] && table[1]) sub.add(table[0] + '.' + table[1]);
            continue;
        }
        const k = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=/);
        if (!k) continue;
        const kp = [...(table || []), ...unq(k[1]).split('.')];
        if (!table) top.add(kp[0]);
        if (kp[0] === 'mcp_servers' && kp[1]) mcp.add(kp[1]);
        if (WATCHED_SUB[kp[0]] && kp[1]) sub.add(kp[0] + '.' + kp[1]);
    }
    return { top: [...top], mcp: [...mcp], sub: [...sub] };
}

// 这台机器上走 app-server 安不安全。{ ok, reason, mcp }
function codexAppConfigCheck(codexHome, cwd) {
    let text = '';
    try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: '读不了 config.toml：' + e.message, mcp: [] }; }
    const { top, mcp, sub } = scanCodexConfig(text);
    const unknown = top.filter(k => !NEUTRALIZED.has(k))
        .concat(sub.filter(s => { const [t, k] = s.split('.'); return !WATCHED_SUB[t].has(k); }));
    if (unknown.length) return { ok: false, reason: 'config.toml 里有没见过的配置：' + unknown.join(', '), mcp };
    // 受信任的项目目录里的 .codex/config.toml 也会被读（exec 加了 --ignore-user-config 也一样，不算新风险，
    // 但这条路是「只放行认得的」，这里同样按不认得处理）
    if (cwd && fs.existsSync(path.join(cwd, '.codex', 'config.toml'))) {
        return { ok: false, reason: `工作目录有 .codex/config.toml（${cwd}）`, mcp };
    }
    return { ok: true, reason: '', mcp };
}

// exec 的参数 → { launch: app-server 启动参数, resumeId, sandbox, cwd, images, model }
function translateExecArgs(execArgs, mcpNames) {
    const a = execArgs.slice();
    const out = { resumeId: '', sandbox: '', cwd: '', images: [], model: '', pass: [] };
    let i = 0;
    if (a[0] === 'exec') i = 1;
    if (a[i] === 'resume') { out.resumeId = a[i + 1] || ''; i += 2; }
    for (; i < a.length; i++) {
        const x = a[i];
        if (x === '--config' || x === '-c' || x === '--enable' || x === '--disable') { out.pass.push(x, a[++i]); continue; }
        if (x === '--sandbox' || x === '-s') { out.sandbox = a[++i]; continue; }
        if (x === '--cd' || x === '-C') { out.cwd = a[++i]; continue; }
        if (x === '--image' || x === '-i') { out.images.push(a[++i]); continue; }
        if (x === '--model' || x === '-m') { out.model = a[++i]; continue; }
        if (x === '--color') { i++; continue; }
        // --json / --ignore-user-config / --skip-git-repo-check / '-'：app-server 用不上
    }
    const passText = out.pass.join(' ');
    const cfg = k => ((passText.match(new RegExp('(?:^| )' + k + '="([a-z]+)"')) || [])[1] || '');
    out.effort = cfg('model_reasoning_effort');
    out.summary = cfg('model_reasoning_summary');
    const mcpOff = [];
    for (const n of mcpNames || []) {
        // 路由自己配了的（比如 GRANCYAN_GPT_FREERIDE=1 补的 freeride）别反手关掉
        if (passText.includes(`mcp_servers.${n}.`)) continue;
        mcpOff.push('--config', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(n) ? n : JSON.stringify(n)}.enabled=false`);
    }
    out.launch = ['app-server', '--config', 'service_tier="default"', '--config', 'notify=[]',
        '--config', 'windows.sandbox="unelevated"', '--disable', 'hooks', ...mcpOff, ...out.pass];
    return out;
}

function mapItem(it) {
    if (!it || typeof it !== 'object') return null;
    switch (it.type) {
        case 'agentMessage': return { id: it.id, type: 'agent_message', text: it.text || '' };
        // exec 的 reasoning.text 就是摘要；v2 拆成了数组，按段落拼回去
        case 'reasoning': return { id: it.id, type: 'reasoning', text: (it.summary || []).join('\n\n') };
        case 'commandExecution': return { id: it.id, type: 'command_execution', command: it.command || '',
            aggregated_output: it.aggregatedOutput || '',
            status: it.status === 'failed' || it.status === 'declined' || (it.exitCode != null && it.exitCode !== 0) ? 'failed' : 'completed' };
        case 'fileChange': return { id: it.id, type: 'file_change', changes: it.changes };
        case 'userMessage': return null;
        default: return { id: it.id, type: String(it.type || 'unknown') };
    }
}

// 跟 spawn 返回的进程长得一样：stdout / stderr / stdin / pid / kill / 'close' / 'error'
function spawnCodexApp(exePath, execArgs, opts, check) {
    const t = translateExecArgs(execArgs, check && check.mcp);
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    let prompt = '';
    let child;
    try { child = spawn(exePath, t.launch, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) {
        proc.stderr = new PassThrough(); proc.pid = undefined; proc.kill = () => false;
        proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
        setImmediate(() => proc.emit('error', err));
        return proc;
    }
    proc.pid = child.pid;
    proc.kill = sig => child.kill(sig);
    proc.stderr = child.stderr;
    child.stdin.on('error', () => {});
    const line = obj => { try { proc.stdout.write(JSON.stringify(obj) + '\n'); } catch {} };
    const fail = msg => { try { child.stderr.emit('data', Buffer.from('[app-server] ' + msg + '\n')); } catch {} };

    let rpcId = 0, threadId = '', exitCode = null, closed = false;
    const pending = new Map();
    const rpc = (method, params) => new Promise((res, rej) => {
        const id = ++rpcId; pending.set(id, { res, rej });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const turnUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    let promptReady, turnDone;
    const promptP = new Promise(r => promptReady = r);
    const doneP = new Promise(r => turnDone = r);
    const finish = code => {
        if (exitCode === null) exitCode = code;
        try { child.stdin.end(); } catch {}
        // app-server 收到 stdin 关闭就退；3 秒还不退就硬杀（windows 上 kill 只杀它自己，它没有子进程要等）
        setTimeout(() => { if (!closed) try { child.kill(); } catch {} }, 3000);
        turnDone();
    };

    let buf = '';
    child.stdout.on('data', d => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const raw = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!raw) continue;
            let m; try { m = JSON.parse(raw); } catch { continue; }
            if (m.id != null && !m.method) {                       // 我们发出去那几个请求的回包
                const q = pending.get(m.id); pending.delete(m.id);
                if (q) m.error ? q.rej(new Error(m.error.message || JSON.stringify(m.error))) : q.res(m.result);
                continue;
            }
            if (m.id != null && m.method) {                        // 它反过来问我们（审批之类）：approvalPolicy=never 下不该有，有就拒
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'GranCyan 不处理 ' + m.method } }) + '\n');
                fail('拒绝了服务端请求 ' + m.method);
                continue;
            }
            const p = m.params || {};
            if (p.threadId && threadId && p.threadId !== threadId) continue;
            switch (m.method) {
                case 'item/agentMessage/delta':
                    if (p.delta) line({ type: 'item.delta', item_id: p.itemId, delta: p.delta });
                    break;
                case 'item/started': { const it = mapItem(p.item); if (it) line({ type: 'item.started', item: it }); break; }
                case 'item/completed': { const it = mapItem(p.item); if (it) line({ type: 'item.completed', item: it }); break; }
                case 'thread/tokenUsage/updated': {
                    const l = (p.tokenUsage || {}).last || {};
                    turnUsage.input_tokens += l.inputTokens || 0;
                    turnUsage.cached_input_tokens += l.cachedInputTokens || 0;
                    turnUsage.output_tokens += l.outputTokens || 0;
                    turnUsage.reasoning_output_tokens += l.reasoningOutputTokens || 0;
                    break;
                }
                case 'error': {
                    // 会自己重试的只当过程提示（路由那边认 Reconnecting 前缀，不会当成这轮失败）；
                    // 不重试的会跟着一个 failed 的 turn/completed，在那儿报，别报两遍
                    const msg = (p.error || {}).message || '';
                    if (p.willRetry && msg) line({ type: 'error', message: 'Reconnecting… ' + msg });
                    break;
                }
                case 'turn/completed': {
                    const turn = p.turn || {};
                    line({ type: 'turn.completed', usage: turnUsage });
                    if (turn.status === 'failed') {
                        line({ type: 'turn.failed', error: { message: (turn.error || {}).message || 'Codex 执行失败' } });
                        finish(1);
                    } else finish(0);
                    break;
                }
            }
        }
    });

    proc.stdin = new Writable({
        write(c, _e, cb) { prompt += c.toString('utf8'); cb(); },
        final(cb) { promptReady(); cb(); },
    });

    child.on('error', err => proc.emit('error', err));
    child.on('close', code => {
        closed = true;
        for (const q of pending.values()) q.rej(new Error('app-server 退出了'));
        pending.clear();
        turnDone();
        // 没走到 turn/completed 就没了（被 taskkill、自己崩）：照实报非 0，路由按「异常退出」收尾
        const c = exitCode !== null ? exitCode : (code || 1);
        setImmediate(() => { proc.stdout.end(); proc.emit('close', c); });
    });

    (async () => {
        await rpc('initialize', { clientInfo: { name: 'grancyan', title: 'GranCyan', version: '1' }, capabilities: null });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
        const common = { model: t.model || null, approvalPolicy: 'never', sandbox: t.sandbox || 'workspace-write' };
        const r = t.resumeId
            ? await rpc('thread/resume', { threadId: t.resumeId, ...common })
            : await rpc('thread/start', { ...common, cwd: t.cwd || opts.cwd || null });
        threadId = (r && r.thread && r.thread.id) || t.resumeId;
        line({ type: 'thread.started', thread_id: threadId });
        await promptP;
        const input = [{ type: 'text', text: prompt, text_elements: [] }, ...t.images.map(f => ({ type: 'localImage', path: f }))];
        // 深度和思考摘要必须每轮显式给：-c 里的 model_reasoning_summary 在 app-server 下不生效
        //（实测 turn_context 里是 auto，思考链整段空白）
        await rpc('turn/start', { threadId, input, effort: t.effort || null, summary: t.summary || null });
        await doneP;
    })().catch(e => {
        if (closed) return;
        fail(e.message);
        finish(1);
    });

    return proc;
}

module.exports = { spawnCodexApp, codexAppConfigCheck, scanCodexConfig, translateExecArgs, mapItem, NEUTRALIZED };
