'use strict';
// ==========================================
// 本地 Ollama 模型的中转：/api/ollama/v1/* → 电脑上的 Ollama（127.0.0.1:11434/v1/*）
//
// 为什么中转、不让前端直连 11434（和 think-translate.js 同一个理由）：
//   · 手机上的页面挂在 https://grancyan.app，直连电脑要改 OLLAMA_HOST=0.0.0.0 + OLLAMA_ORIGINS，
//     两处都是静默失效；而且那样 Ollama 就对整个局域网裸奔了，谁都能用。
//   · 挂在 /api 下面 = 自动吃 server.js 那道跨站闸，别的网站借她的浏览器也用不了。
//
// 配法：模型的 API 地址填相对路径 `/api/ollama/v1`，前端按「这台设备连的是哪个 server」
// 自己补全（见 05-prompts-api.js 拼 url 那里的 resolvedBase）—— 同一份配置电脑和手机都能用，
// configs 跨设备同步也不用管。
//
// 只放行两条：chat/completions（聊天）和 models（列模型）。pull/delete 这类管理接口不开。
// ==========================================

const http = require('http');
const runTools = require('./ollama-tools');
const { attach: ziliaoAttach } = require('./xiaoqian-ziliao');

const OLLAMA = (process.env.GRANCYAN_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');

function forward(req, res, subPath, body) {
    const u = new URL(OLLAMA + '/v1/' + subPath);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const up = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname, method: req.method,
        headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': payload.length } : {}),
        },
    }, (upRes) => {
        res.status(upRes.statusCode || 502);
        const ct = upRes.headers['content-type'];
        if (ct) res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        upRes.pipe(res);   // SSE 逐帧透传，不攒
    });
    up.on('error', (e) => {
        if (res.headersSent) { res.end(); return; }
        // Ollama 没开是最常见的情况，说人话
        res.status(502).json({ error: { message: `连不上电脑上的 Ollama（${e.code || e.message}）—— 它开着吗？` } });
    });
    // 她在前端点了停止 / 手机切后台断了：把上游也掐掉，不然显卡还在白白往下生成。
    // 只在「没正常写完」时掐 —— 正常结束也会触发 close。
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    if (payload) up.write(payload);
    up.end();
}

// ---------- 小千的工具回合 ----------
// 小千是带着 search / read / calc 训出来的（见 ollama-tools.js）。GranCyan 前端没有 function calling，
// 所以在中转这层替她跑工具：每一轮照常流式转发正文，模型要调工具就在这里执行、把结果塞回去再问一轮，
// 最多 5 轮。前端看到的是一条普通的流，工具调用以 reasoning 帧出现（落进思考块，不进正文，
// 回填历史时模型不会照着学一个假的「[搜索]」格式）。
// 只给名字是 xiaoqian / cookie（r23 起改名饼干）的模型挂工具；别的 Ollama 模型原样透传。
const XIAOQIAN = /^(xiaoqian|cookie)(:|$)/i;
const MAX_TOOL_ROUNDS = 5;

// 流式打一轮 Ollama，把 content / reasoning 帧实时交给 onDelta，攒下 tool_calls。
function streamRound(body, onDelta, onUpstream) {
    return new Promise((resolve, reject) => {
        const u = new URL(OLLAMA + '/v1/chat/completions');
        const payload = Buffer.from(JSON.stringify({ ...body, stream: true }));
        const up = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        }, (upRes) => {
            if (upRes.statusCode !== 200) {
                let raw = ''; upRes.on('data', c => raw += c);
                upRes.on('end', () => reject(Object.assign(new Error(raw || `HTTP ${upRes.statusCode}`), { status: upRes.statusCode, raw })));
                return;
            }
            let buf = '', content = '';
            const calls = [];
            upRes.setEncoding('utf8');
            upRes.on('data', (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    let j; try { j = JSON.parse(data); } catch { continue; }
                    const d = j.choices?.[0]?.delta || {};
                    if (d.content) { content += d.content; onDelta({ content: d.content }); }
                    const rc = d.reasoning_content || d.reasoning;
                    if (rc) onDelta({ reasoning: rc });
                    for (const tc of d.tool_calls || []) {
                        const k = tc.index ?? calls.length;
                        const c = calls[k] || (calls[k] = { id: tc.id || `call_${k}`, name: '', args: '' });
                        if (tc.id) c.id = tc.id;
                        if (tc.function?.name) c.name += tc.function.name;
                        if (tc.function?.arguments) c.args += typeof tc.function.arguments === 'string'
                            ? tc.function.arguments : JSON.stringify(tc.function.arguments);
                    }
                }
            });
            upRes.on('end', () => resolve({ content, calls: calls.filter(Boolean) }));
            upRes.on('error', reject);
        });
        up.on('error', reject);
        onUpstream(up);
        up.end(payload);
    });
}

const toolLabel = (name, args) => name === 'search' ? `🔎 搜索：${args.q ?? ''}`
    : name === 'read' ? `📖 读网页：${args.url ?? ''}`
    : name === 'calc' ? `🧮 计算：${args.expr ?? ''}` : `🔧 ${name}`;

// 和 js/05-prompts-api.js 的 relocateVolatilePrompt 包的框对应：从开头剥到「以下是用户这一轮说的话】」为止
const VOL_RE = /^【本轮实时信息（系统给你的，不是用户说的话）】[\s\S]*?【实时信息结束，以下是用户这一轮说的话】\s*/;
function stripVolatile(m) {
    if (m?.role !== 'user') return m;
    const c = m.content;
    if (typeof c === 'string') return VOL_RE.test(c) ? { ...m, content: c.replace(VOL_RE, '') } : m;
    if (Array.isArray(c)) return { ...m, content: c
        .map(p => p?.type === 'text' && VOL_RE.test(p.text || '') ? { ...p, text: p.text.replace(VOL_RE, '') } : p)
        .filter(p => !(p?.type === 'text' && p.text === '')) };
    return m;
}

async function xiaoqianWithTools(req, res, body) {
    const wantStream = body.stream !== false;
    // 本地微调模型是照 Modelfile 里那一句固定 SYSTEM 训的，差一个字就跑偏；GranCyan 的系统提示（人设、记忆、
    // 技能，九千多 token，写的是另一个 AI 的人设）一塞进去它就顶替成那个人设、上下文还爆 8192。去掉 system，
    // Ollama 没收到 system 时自动用 Modelfile 那句 —— 和训练逐字一致，这边不用抄一份。
    // 同理，relocateVolatilePrompt 把 system 的实时段（时间、模型、写给聊天 AI 的状态）挪到了最后一条用户消息前，
    // 也得剥掉：不剥的话查资料是拿这段去匹配关键词的，里面有 Claude/模型 字样，饼干每句话都挂「📚 查资料：AI型号.md」
    const noSys = (body.messages || []).filter(m => m?.role !== 'system').map(stripVolatile);
    const { messages: msgs, used: ziliao } = ziliaoAttach(noSys);
    const base = { ...body, tools: body.tools || runTools.TOOLS };
    let current = null, closed = false, started = false;
    res.on('close', () => { if (!res.writableEnded) { closed = true; if (current) current.destroy(); } });

    let allContent = '', allReasoning = '';
    const frame = (delta) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta }] })}\n\n`;
    const start = () => {
        if (started || !wantStream) return;
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
    };
    const emit = (delta) => {
        if (delta.content) allContent += delta.content;
        if (delta.reasoning) allReasoning += delta.reasoning;
        if (!wantStream || closed) return;
        start();
        res.write(frame(delta.reasoning ? { reasoning_content: delta.reasoning } : { content: delta.content }));
    };

    if (ziliao.length) emit({ reasoning: `📚 查资料：${ziliao.join('、')}\n` });

    try {
        for (let round = 0; ; round++) {
            const tools = round < MAX_TOOL_ROUNDS ? base.tools : undefined;   // 最后一轮不给工具，逼它开口
            const r = await streamRound({ ...base, tools, messages: msgs }, emit, (up) => { current = up; });
            if (closed) return;
            if (!r.calls.length || round >= MAX_TOOL_ROUNDS) break;
            msgs.push({ role: 'assistant', content: r.content || '', tool_calls: r.calls.map(c => ({
                id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
            for (const c of r.calls) {
                let args = {};
                try { args = JSON.parse(c.args || '{}'); } catch {}
                emit({ reasoning: (allReasoning && !allReasoning.endsWith('\n') ? '\n' : '') + toolLabel(c.name, args) + '\n' });
                const out = await runTools.runTool(c.name, args);
                if (closed) return;
                const preview = String(out).replace(/\s+/g, ' ').slice(0, 120);
                emit({ reasoning: `　→ ${preview}${String(out).length > 120 ? '…' : ''}\n` });
                msgs.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: String(out) });
            }
        }
    } catch (e) {
        if (closed) return;
        if (!started && !res.headersSent) {
            if (e.status) { res.status(e.status); res.setHeader('Content-Type', 'application/json'); return res.end(e.raw || ''); }
            return res.status(502).json({ error: { message: `连不上电脑上的 Ollama（${e.code || e.message}）—— 它开着吗？` } });
        }
        emit({ content: `\n（出错了：${e.message}）` });
    }
    if (closed) return;
    if (wantStream) { start(); res.end('data: [DONE]\n\n'); return; }
    const message = { role: 'assistant', content: allContent };
    if (allReasoning) message.reasoning_content = allReasoning;
    res.json({ object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: 'stop' }] });
}

function registerOllamaProxy(app) {
    app.post('/api/ollama/v1/chat/completions', (req, res) => {
        if (!req.body || typeof req.body !== 'object' || !req.body.model) {
            return res.status(400).json({ error: { message: '请求体里没有 model' } });
        }
        // Qwen3.5 默认先想再说：一句「早」前面先吐四千多帧 delta.reasoning、content 全空，
        // 手机上看就是干等一两分钟没字。除非她在模型设置里选了「全开思考」（前端发 high），
        // 一律关掉 —— 「不开思考」前端发的是 low，Ollama 照样想，所以也归到 none。
        const body = { ...req.body };
        if (body.reasoning_effort !== 'high') body.reasoning_effort = 'none';
        if (XIAOQIAN.test(body.model)) return xiaoqianWithTools(req, res, body);
        forward(req, res, 'chat/completions', body);
    });
    app.get('/api/ollama/v1/models', (req, res) => forward(req, res, 'models'));
}

module.exports = { registerOllamaProxy, OLLAMA };
