// server/agy.js
// 订阅 Gemini —— /api/local-gemini 收到 via:'sub' 时走这里（挂载在 server/gemini.js）。
// spawn 本机官方 CLI `agy`（Google Antigravity CLI），用的是本机登录账号自己的 Google AI Pro 订阅额度，不要 API key。
// **只走 agy 自己的登录态**：不读 ~/.gemini 下任何凭据文件、不伪装 UA 去打 Google 的私有端点
// （和订阅 Claude 只 spawn 官方 CLI 是同一条线）。
//
// 和 gemini.js（API key 直连）不一样的几件事，2026-10-15 都实测过：
//   ① agy 是个带手的 agent（读写文件、跑命令、开浏览器）。这里只拿它聊天：
//      --mode plan + 一次性的空工作目录 + 目录里一份 GEMINI.md 交代「别用工具」。
//      看图是唯一例外：图落成文件放进工作目录，让它用 view_file 自己看（plan 模式下 view_file 不要审批）。
//   ② 私人上下文：agy 会读工作目录里的 GEMINI.md / AGENTS.md。家目录和项目根目录都可能放着
//      AGENTS.md（个人设定、开发规矩），所以工作目录放系统临时目录下，
//      **别挪进项目里**。临时目录实测读不到家目录那份。
//   ③ 没有续传：每轮全量重发（同 gemini.js）。系统提示 + 历史拼成一条用户消息，从 stdin 用 stream-json 喂，
//      不走 argv —— Windows 命令行 32K 上限，系统提示一长就被截。
//      stdin 一行的格式是 {"event":"user","message":{"role":"user","content":"…"}}（不是 claude 那套 type:user）；
//      命令行必须带 `-p=`（空串），带了正经 prompt 它会拒绝。
//   ④ 慢：冷启动到第一个字 ~17s，其中 ~8s 是 agy 自己 init。所以常驻一只预热好的进程（已 init、等 stdin），
//      来活直接喂，喂进去到第一个字 ~9s。用掉就再预热一只；闲 10 分钟收掉。
//   ⑤ agy 不吐思考内容，只给 thinking_tokens 的数。
//   ⑥ 正文 DONE 之后它还要 10 秒多才发 result（在收尾），所以正文完了安静 1.5s 就先给前端 done。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WARM_IDLE_MS = 10 * 60 * 1000;
const QUIET_DONE_MS = 1500;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// 工作目录里的 GEMINI.md：agy 把它当常驻规则读。人设本身不放这里（有 24KB 上限、超预算会被降级成文件指针），
// 放在用户消息的 <system_prompt> 里；这份只负责把「编程 agent」掰成「聊天角色」。
const RULES_MD = [
    '# 这一轮你在做什么',
    '',
    '你现在不是编程助手。你是聊天应用 GranCyan 里的对话角色：用户消息里 <system_prompt> 那一段就是你的身份和规则，完全按它说话。',
    '',
    '- 只回复 <current_user_message>。<history> 是之前的对话，接着聊，不要复述。',
    '- 不要调用任何工具：不读写文件、不跑命令、不开浏览器、不上网、不生成图片。',
    '  唯一例外：<current_user_message> 里列出的附图文件，用 view_file 看。',
    '- 回复里不要出现文件名、路径或链接，也不要说「我用工具看了图」，像亲眼看到一样自然地说。',
    '- 直接输出回复正文，不加前缀、标签或角色名。',
    '',
].join('\n');

// thinkingLevel 沿用 Gemini 直连那条的下拉（minimal/low/medium/high/off/空），映射到 agy 的三档 flash。
// agy 里没有 pro，model 字段不看 —— 订阅能用的 Gemini 就这三个（`agy models` 10-15 实测）。
function agyModel(thinkingLevel) {
    const lv = String(thinkingLevel || '');
    if (lv === 'high') return 'gemini-3.8-flash-high';
    if (lv === 'low' || lv === 'minimal' || lv === 'off') return 'gemini-3.8-flash-low';
    return 'gemini-3.8-flash-medium';
}

function resolveBin() {
    if (process.env.GRANCYAN_AGY_BIN) return process.env.GRANCYAN_AGY_BIN;
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const p = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
        if (fs.existsSync(p)) return p;
    }
    return 'agy';
}

// 代理走 env，不写死端口：需要代理才连得上 Google 的话在 .env 里设 GRANCYAN_AGY_PROXY，没设就不加。
function childEnv() {
    const env = { ...process.env };
    const proxy = String(process.env.GRANCYAN_AGY_PROXY || '').trim();
    if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
    return env;
}

// GranCyan 的消息数组 → 一条用户消息的正文。
// 只有**最后一条用户消息**的图交给它看：每张图是一次 view_file 来回（实测 ~8s），
// 历史里的图全看一遍的话一轮要等好几分钟。历史里的图只留一句「带过 N 张图」。
function buildPrompt(messages, systemPrompt) {
    const msgs = (messages || []).filter(m => m && m.role !== 'system');
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }

    const turn = m => {
        const n = (m.images || []).length;
        const text = String(m.content || '').trim();
        return `<turn role="${m.role === 'user' ? 'user' : 'assistant'}">\n${text}${n ? `\n[这条带过 ${n} 张图]` : ''}\n</turn>`;
    };
    const history = msgs.slice(0, lastUser < 0 ? msgs.length : lastUser).map(turn);
    const cur = lastUser >= 0 ? msgs[lastUser] : null;
    const images = [];
    for (const u of (cur && cur.images) || []) {
        const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(u || ''));
        if (!m) continue;
        images.push({ name: `img-${images.length + 1}${IMG_EXT[m[1]] || '.png'}`, b64: m[2] });
    }
    // 最后一条用户消息后面还跟着 assistant（续写 / 重新生成的变体），那几条也要算进历史
    const after = lastUser >= 0 ? msgs.slice(lastUser + 1).map(turn) : [];

    const parts = [];
    const sys = String(systemPrompt || '').trim();
    if (sys) parts.push(`<system_prompt>\n${sys}\n</system_prompt>`);
    if (history.length) parts.push(`<history>\n${history.join('\n')}\n</history>`);
    if (cur) {
        let body = String(cur.content || '').trim();
        if (images.length) body += `\n\n（附图，在当前工作目录：${images.map(i => i.name).join('、')}）`;
        parts.push(`<current_user_message>\n${body}\n</current_user_message>`);
    }
    if (after.length) parts.push(`<your_draft_so_far>\n${after.join('\n')}\n</your_draft_so_far>\n接着上面你已经说的往下说。`);
    return { text: parts.join('\n\n'), images, empty: !cur && !history.length };
}

// agy 的 NDJSON → 前端那套事件（delta / thinking / notice / error）。
// 抽成纯函数是为了能测：哪个 step 是正文、工具调用怎么报、ERROR 的 result 怎么翻，错了都很安静。
function createAgyParser({ emit, onTextDone, onActivity }) {
    let buffer = '', sawText = false, usage = null, result = null;
    function handle(o) {
        if (o.event === 'step_update' && o.step_update) {
            const s = o.step_update;
            onActivity && onActivity();
            if (s.step_type === 'agent_response') {
                if (s.text_delta) { emit({ delta: s.text_delta }); if (s.text_delta.trim()) sawText = true; }
                if (s.usage) {
                    usage = {
                        in: s.usage.input_tokens || 0,
                        out: (usage ? usage.out : 0) + (s.usage.output_tokens || 0),
                        cached: s.usage.cache_read_tokens || 0,
                    };
                }
                if (s.state === 'DONE' && sawText) onTextDone && onTextDone();
            } else if (s.step_type === 'tool' && s.state === 'ACTIVE') {
                const p = (s.tool_info && s.tool_info.parameters) || {};
                const file = p.AbsolutePath || p.Path || '';
                if (s.tool_name === 'view_file' && /img-\d+\.\w+$/i.test(file)) emit({ thinking: `（看附图 ${path.basename(file)}）\n` });
                else emit({ notice: `订阅 Gemini 自己调了工具 ${s.tool_name}（本来交代过别用）` });
            }
        } else if (o.event === 'result' && o.result) {
            result = o.result;
            if (o.result.usage) {
                const u = o.result.usage;
                usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cached: u.cache_read_tokens || 0 };
            }
            if (o.result.status && o.result.status !== 'SUCCESS') emit({ error: explainAgyError(o.result.error || o.result.status) });
        }
    }
    return {
        feed(text) {
            buffer += text;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith('{')) continue;
                let o;
                try { o = JSON.parse(line); } catch { continue; }
                handle(o);
            }
        },
        state() { return { sawText, usage, result }; },
    };
}

function explainAgyError(raw) {
    const s = String(raw || '');
    if (/authenticat|login|sign in|oauth/i.test(s)) {
        return 'agy 没登录（或者登录过期了）：在电脑上开个终端，先设代理再跑一次 `agy`，按提示登录 Google 账号，再回来发。';
    }
    if (/quota|rate.?limit|exhausted|429/i.test(s)) return `订阅 Gemini 的额度暂时用完了：${s}`;
    if (/model/i.test(s) && /not (found|available|supported)/i.test(s)) return `agy 不认这个模型（可能 agy 太旧，跑 \`agy models\` 看看）：${s}`;
    return `agy 报错：${s || '（没有给出原因）'}`;
}

// ── 进程管理 ────────────────────────────────────────────────────────────────
function makeWorkDir() {
    const dir = path.join(os.tmpdir(), 'grancyan-agy', crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'GEMINI.md'), RULES_MD, 'utf8');
    return dir;
}

function rmDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 被占着就留给下次 */ }
}

// 不要 detached：Windows 上 detached:true 会让 windowsHide 静默失效，点开 exe 多弹一个黑框。
function spawnAgy(model) {
    const dir = makeWorkDir();
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', model, '--mode', 'plan', '--disable-slash-commands', '-p='];
    const proc = spawn(resolveBin(), args, { cwd: dir, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { proc, model, dir, born: Date.now(), exited: false, stderr: '', early: '' };
    proc.on('error', e => { w.spawnError = e; w.exited = true; });
    proc.on('exit', () => { w.exited = true; setTimeout(() => rmDir(dir), 2000); });
    proc.stderr.on('data', d => { w.stderr = (w.stderr + d).slice(-2000); });
    // 预热期间吐出来的（init）先攒着，免得被丢掉；真正要用时只关心 init 之后的
    proc.stdout.on('data', d => { if (!w.taken) w.early = (w.early + d).slice(-4000); });
    return w;
}

let warm = null, warmTimer = null;
// Windows 上父进程走了子进程不会跟着走：server/exe 关掉时把预热的那只带走，别留一只孤儿 agy 占内存
process.on('exit', () => dropWarm());

function prewarm(model) {
    if (warm && !warm.exited && warm.model === model) return;
    dropWarm();
    warm = spawnAgy(model);
    clearTimeout(warmTimer);
    warmTimer = setTimeout(dropWarm, WARM_IDLE_MS);
    if (warmTimer.unref) warmTimer.unref();
}

function dropWarm() {
    clearTimeout(warmTimer);
    if (warm && !warm.exited) { try { warm.proc.kill(); } catch { /* 已经走了 */ } }
    warm = null;
}

function takeProc(model) {
    if (warm && !warm.exited && warm.model === model) {
        const w = warm;
        warm = null;
        clearTimeout(warmTimer);
        w.wasWarm = true;
        return w;
    }
    dropWarm();
    return spawnAgy(model);
}

// SSE 头、send/finish 由调用方（gemini.js）准备好传进来，出口格式和 /api/local-claude 一样。
function runTurn({ messages, systemPrompt, thinkingLevel, send, finish, res }) {
    const model = agyModel(thinkingLevel);
    const built = buildPrompt(messages, systemPrompt);
    if (built.empty) { send({ error: '消息内容为空，无法发送' }); return finish(); }

    const w = takeProc(model);
    w.taken = true;
    for (const img of built.images) {
        try { fs.writeFileSync(path.join(w.dir, img.name), Buffer.from(img.b64, 'base64')); }
        catch (e) { send({ notice: `附图 ${img.name} 落不了盘：${e.message}` }); }
    }
    console.log(`[订阅Gemini] model=${model} ${w.wasWarm ? '预热进程' : '冷启动'} 提示${built.text.length}字 附图${built.images.length}`);

    let ended = false, quietTimer = null;
    const t0 = Date.now();
    const end = (why) => {
        if (ended) return;
        ended = true;
        clearTimeout(quietTimer);
        clearTimeout(turnTimer);
        const st = parser.state();
        if (st.usage) send({ usage: { in: st.usage.in, out: st.usage.out, cached: st.usage.cached, cacheWrite: 0 } });
        if (!st.sawText && why !== 'client') {
            const err = w.spawnError
                ? (w.spawnError.code === 'ENOENT'
                    ? '找不到 agy：这台电脑还没装 Antigravity CLI。PowerShell 里跑 `irm https://antigravity.google/cli/install.ps1 | iex`，装完跑一次 `agy` 登录。'
                    : `agy 起不来：${w.spawnError.message}`)
                : (st.result && st.result.status !== 'SUCCESS') ? null   // parser 已经报过了
                : explainAgyError(w.stderr.trim() || `没有生成任何正文（${why}）`);
            if (err) send({ error: err });
        }
        console.log(`[订阅Gemini] 收尾 ${why} ${((Date.now() - t0) / 1000).toFixed(1)}s 出字=${st.sawText}`);
        if (why !== 'client') finish();
        // 正文已经给完了，进程收不收尾无所谓；留它 30 秒自己走，不走就掐
        setTimeout(() => { if (!w.exited) { try { w.proc.kill(); } catch { /* */ } } }, why === 'quiet' ? 30000 : 0);
        prewarm(model);   // 下一轮的提前起好
    };
    const parser = createAgyParser({
        emit: send,
        onActivity: () => { clearTimeout(quietTimer); },
        onTextDone: () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => end('quiet'), QUIET_DONE_MS); },
    });
    const turnTimer = setTimeout(() => end('超时'), TURN_TIMEOUT_MS);

    w.proc.stdout.on('data', d => parser.feed(d.toString('utf8')));
    w.proc.on('exit', code => setTimeout(() => end(`进程退出 ${code}`), 50));
    if (w.exited) setTimeout(() => end('进程已退出'), 0);
    // 她按了停止 / 关了页面：没有后台任务可接，直接掐（同 gemini.js）
    res.on('close', () => { if (!res.writableEnded && !ended) { end('client'); try { w.proc.kill(); } catch { /* */ } } });

    try {
        w.proc.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: built.text } }) + '\n');
        w.proc.stdin.end();
    } catch (e) {
        send({ error: `喂不进 agy：${e.message}` });
        end('stdin');
    }
}

module.exports = { runTurn, prewarm, buildPrompt, agyModel, createAgyParser, explainAgyError, RULES_MD, _dropWarm: dropWarm };
