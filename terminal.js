// terminal.js —— 手机端「终端」小组件的后端：在电脑上跑命令，输出流式推回手机。
//
// 挂载：server.js 里 require('./terminal').mountTerminal(app)
// 接口：
//   POST /api/terminal/run   {cmd, shell, cwd, admin}  → SSE 流（out / done / error）
//   POST /api/terminal/kill  {id}                      → 掐掉还在跑的命令
//   GET  /api/terminal/shells                          → 这台机器上哪些 shell 能用
//
// 为什么不是「连到某个已经开着的终端窗口」：
//   Windows 上没有正经办法往别人家的 conhost/Windows Terminal 里塞输入（只能 SendKeys 硬模拟，
//   窗口一失焦就打歪，还会误伤）。所以这里的做法是——我们自己 spawn 一个 shell 来跑，
//   PowerShell / CMD / Git Bash 三选一，每个「终端标签」在手机上是独立的一份 cwd。
//   「不同终端软件 / 不同窗口」的需求就落成这个。
//
// 安全：和 server.js 其他接口一样只在局域网里裸奔（同一个 Wi-Fi 的人能调）。
// 高危命令用 mcp-exec 那套同款正则挡一道，挡的是手滑和模型抽风，不是黑客。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 没指定 cwd（或指定的不存在）时的工作目录：GRANCYAN_TERMINAL_CWD，没设就用当前用户主目录
const TERMINAL_CWD = process.env.GRANCYAN_TERMINAL_CWD || os.homedir();
const TIMEOUT_MS = 10 * 60 * 1000;   // 单条命令最多跑 10 分钟
const MAX_BYTES = 400 * 1024;        // 单条命令回传上限，防止 yes 之类刷爆手机

// 和 mcp-exec.js 同一套（那份是给模型用的，这份是给人用的，各留一份免得互相 require 出环）
const DANGER = [
    /\bformat\s+[a-z]:/i,
    /\brd\s+\/s\b|\brmdir\s+\/s\b/i,
    /remove-item[^|\n]*\b(c:\\|c:\/|\$env:systemroot|\$env:windir)/i,
    /\brm\s+(-\w*\s+)*-\w*[rf]\w*\s+\/(\s|$)/i,
    /\b(shutdown|restart-computer|stop-computer)\b/i,
    /\bdiskpart\b|\bcipher\s+\/w\b|\bvssadmin\s+delete\b/i,
    /\bdel\s+\/[sq]\b[^|\n]*\b(c:\\windows|c:\\program)/i,
];
const dangerHit = cmd => DANGER.find(re => re.test(cmd));

// ── 交互式命令（要 TTY 的那些）────────────────────────────────────────
// 这个终端是「一条命令 spawn 一个 shell、跑完就收工」，没有 PTY、没有键盘回传，
// 所以任何要停在里面等你敲字的程序（claude 的会话界面、裸 python/node REPL、ssh、vim…）
// 在这儿只会卡死或者报错。与其让用户看一堆 "no stdin data received"，不如：
//   claude ——  能救就救：`claude 帮我看看xxx` 自动改写成 `claude -p "帮我看看xxx"`（一次性问答模式）
//   其它 ——   直接说清楚跑不了，别浪费 10 分钟超时。
const INTERACTIVE_ONLY = [
    { re: /^(python|python3|ipython|node|irb|ghci|sqlite3|mysql|psql)\s*$/i, name: 'REPL' },
    { re: /^(ssh|telnet|vim|vi|nano|emacs|top|htop|less|more)\b/i, name: '全屏/交互程序' },
];

// ── claude 命令改写 ────────────────────────────────────────────────────
// claude 的会话界面在这儿开不起来（要 TTY），有提示词就转成 -p 一次性模式。
//
// 2026-07-27 修：以前是「不在白名单里的就把整个 rest 当提示词塞进 -p "..."」，
// 于是任何没被白名单收录的参数都会被吞进提示词里 ——
//   claude -c 我刚才问了什么   →   claude -p "-c 我刚才问了什么"
//                              →   error: unknown option '- 我刚才问了什么'
// 「终端不支持 claude 命令」这个反馈有一半是这个。-c/--continue 尤其可惜：
// 它在 -p 模式下是能用的（claude -p -c "…" 实测能接上上一轮），
// 也就是**手机上本来就能跟 claude 多轮对话**，只是被这个改写堵死了。
//
// 现在改成：先把开头连续的参数和后面的自然语言提示词分开，参数原样保留，
// 只把提示词包进 -p。claude -c 问题 → claude -c -p "问题"。

// 子命令：整条原样放行（claude mcp list / claude update / …）
const CLAUDE_SUBCMDS = /^(mcp|update|doctor|config|agents|install|migrate-installer|setup-token|plugin)\b/i;
// 需要吃掉后面一个值的参数（--model opus 里的 opus 不是提示词）。
// -d/-r/-w 的值是可选的，跟着自然语言时容易误吞，所以不列进来——
// 想传值就写成 --resume=xxx 这种等号形式。
const CLAUDE_VALUE_FLAGS = new Set([
    '--add-dir', '--agent', '--agents', '--allowedtools', '--allowed-tools',
    '--disallowedtools', '--disallowed-tools', '--append-system-prompt',
    '--system-prompt', '--system-prompt-file', '--append-system-prompt-file',
    '--model', '--fallback-model', '--permission-mode', '--permission-prompt-tool',
    '--output-format', '--input-format', '--session-id', '--settings',
    '--mcp-config', '--ide', '-n', '--name',
]);

function rewriteClaude(cmd) {
    const m = cmd.match(/^\s*claude\s*([\s\S]*)$/i);
    if (!m) return { cmd };
    const rest = m[1].trim();

    if (!rest) {
        return {
            note: '⛔ 手机端终端跑不了 claude 的会话界面——它要一个真 TTY，这里每条命令都是一次性 spawn 的（没有键盘回传）。\n'
                + '   想在这儿问 Claude：直接写 `claude 你的问题`，我会用一次性模式（claude -p）帮你跑。\n'
                + '   想接着上一轮聊：`claude -c 你的下一个问题`（-c 在一次性模式下是能用的，多轮没问题）。\n'
                + '   想要完整的交互式会话：用 App 里的「订阅 Claude」模型，那条路是专门为手机做的。\n',
        };
    }
    // 子命令 / 已经自己带了 -p / 只是问版本帮助 —— 都原样跑
    if (CLAUDE_SUBCMDS.test(rest)) return { cmd };
    if (/(^|\s)(-p|--print|--help|-h|--version|-v)(\s|=|$)/i.test(rest)) return { cmd };

    // 从头扫：连续的参数（以及它们的值）算「参数区」，遇到第一个不是参数的词，
    // 从那里到结尾整段都是提示词（原样切片，不重新拼，免得把引号和空格拼坏）。
    const tokenRe = /\S+/g;
    let promptStart = rest.length, tk, expectValue = false;
    while ((tk = tokenRe.exec(rest)) !== null) {
        const word = tk[0];
        if (expectValue) { expectValue = false; continue; }        // 这是上一个参数的值
        if (word[0] !== '-') { promptStart = tk.index; break; }    // 自然语言开始了
        if (word.indexOf('=') < 0 && CLAUDE_VALUE_FLAGS.has(word.toLowerCase())) expectValue = true;
    }
    const flags = rest.slice(0, promptStart).trim();
    let prompt = rest.slice(promptStart).trim();

    if (!prompt) {
        // 全是参数没有问题（claude -c / claude --model opus）——一次性模式必须有提示词，
        // stdin 这边是关着的，不给的话它只会空转然后报错。
        return {
            note: `⛔ \`claude ${flags}\` 没有带问题。这个终端没有 TTY，claude 只能跑一次性模式（-p），\n`
                + `   必须把问题写在同一行：\`claude ${flags} 你想问的东西\`。\n`,
        };
    }
    // 用户自己就写了引号的话先扒掉，免得变成 -p ""问题""
    if (prompt.length > 1 && /^(["']).*\1$/s.test(prompt)) prompt = prompt.slice(1, -1);
    const esc = prompt.replace(/"/g, '\\"');
    const finalCmd = `claude ${flags ? flags + ' ' : ''}-p "${esc}"`;
    return {
        cmd: finalCmd,
        note: `ℹ️ 会话界面要 TTY，这里跑不了 —— 已自动改成一次性模式：${finalCmd}\n`
            + (/(^|\s)(-c|--continue|-r|--resume)(\s|=|$)/i.test(flags)
                ? '' : '   （想接着上一轮聊，下次加个 -c：`claude -c 下一个问题`）\n'),
    };
}

// Git Bash 在哪：Git 不一定装在 Program Files（可能装在别的盘的任意目录），
// 所以别硬猜路径 —— 先问 PATH 上的 git 在哪（<git根>\cmd\git.exe），换算出 <git根>\bin\bash.exe，
// 找不到再退回几个常见位置。
// 注意不能直接用 PATH 上的 bash.exe：Windows 10/11 自带的 WindowsApps\bash.exe 是 WSL 的壳子，
// 跑起来是另一个世界（Linux 文件系统），不是用户想要的 Git Bash。
function findBash() {
    const cands = [];
    // 直接翻 PATH 找 git.exe（别 spawn where.exe——换个父进程它就 ENOENT 了），
    // 找到 <git根>\cmd\git.exe 就能换算出 <git根>\bin\bash.exe
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        try {
            if (fs.existsSync(path.join(dir, 'git.exe'))) {
                cands.push(path.join(path.dirname(dir), 'bin', 'bash.exe'));
            }
        } catch (_) { /* PATH 里有坏目录，跳过 */ }
    }
    cands.push(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
    );
    return cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

const running = new Map();   // id -> child process

// cwd 跟踪：每条命令跑完，让 shell 自己把当前目录打印成一行魔法标记，
// 服务端截下来、从输出里抹掉，再把新 cwd 报给手机。这样 `cd xxx` 在下一条命令里就还在。
// （不用常驻 shell：常驻的话没法可靠判断「这条命令结束了没」，一超时就永远卡住。）
const MARK = '__GC_CWD__';

// 用绝对路径拿 cmd/powershell：server 被别的进程拉起来时 PATH 可能是残的
// （实测 spawn('cmd.exe') 直接 ENOENT），ComSpec/SystemRoot 这两个环境变量则一直都在。
const CMD_EXE = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32\\WindowsPowerShell\\v1.0\\powershell.exe');

// 每个 shell 都是「跑命令 → 先把退出码存下来 → 打印 cwd 标记 → 按存下来的码退出」。
// 顺序很重要：cwd 标记那条 echo 本身也是一条命令，不先把 $? / %ERRORLEVEL% 抢救出来，
// 进程退出码就变成 echo 的 0 —— 结果就是「什么命令都显示成功」。
function buildArgs(shell, cmd, bashExe) {
    if (shell === 'cmd') {
        // cmd.exe 必须走 windowsVerbatimArguments，命令行自己拼、自己包外层引号：
        // 交给 Node 转义的话，它会把整条 /c 参数再包一层引号，cmd 那套非主流的引号规则一撞，
        // 命令里带引号的部分（node -e "..."）就废了，连 /v:on 的延迟展开都不生效
        // （实测 !ERRORLEVEL! 被原样打出来）。
        // set 写成 set "__EC=!ERRORLEVEL!"：不加引号的话 `&` 前的空格会一起存进变量变成 "3 "，
        // exit /b 认不出来，退出码又变回 0。
        const line = `${cmd} & set "__EC=!ERRORLEVEL!" & echo ${MARK}!CD! & exit /b !__EC!`;
        return { exe: CMD_EXE, args: ['/d', '/s', '/v:on', '/c', `"${line}"`], verbatim: true };
    }
    if (shell === 'bash') {
        return {
            exe: bashExe,
            args: ['-lc', `${cmd}; __ec=$?; echo "${MARK}$(pwd -W 2>/dev/null || pwd)"; exit $__ec`],
        };
    }
    // PowerShell 默认按 GBK 吐字节，中文直接乱码 —— 先把输出编码焊成 UTF-8。
    // 退出码：原生 exe 看 $LASTEXITCODE，cmdlet 看 $?（cmdlet 报错时 $LASTEXITCODE 可能还是上一条的）
    const wrapped = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; '
        + `${cmd}\n`
        + '$__ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n'
        + `Write-Output "${MARK}$((Get-Location).Path)"\n`
        + 'exit $__ec';
    return { exe: PS_EXE, args: ['-NoProfile', '-NonInteractive', '-Command', wrapped] };
}

// 管理员：只能另起一个提权进程（UAC 会在电脑上弹窗，得用户本人点「是」）。
// 提权进程是独立的，拿不到它的 stdout，所以把输出重定向到临时文件，跑完再读回来。
// 代价：管理员模式没有流式输出，只有跑完一次性给。
function runAdmin(cmd, cwd, shell, onData, onDone) {
    const tmp = path.join(os.tmpdir(), `gc-term-${Date.now()}.txt`);
    const inner = shell === 'cmd'
        ? `cmd.exe /d /s /c "${cmd.replace(/"/g, '\\"')}" > "${tmp}" 2>&1`
        : `powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd.replace(/"/g, '`"')}" *> "${tmp}"`;
    const launcher = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden -FilePath powershell.exe `
        + `-ArgumentList '-NoProfile','-Command','${inner.replace(/'/g, "''")}'`;

    onData('⏳ 已请求管理员权限——去电脑上点一下 UAC 的「是」。（管理员模式没有实时输出，跑完一次性回来）\n');
    // windowsHide：命令是从手机那头发过来的，电脑这边不该因此弹出黑窗口。
    // （UAC 弹窗不受影响，那是系统自己的。）
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { cwd, windowsHide: true });
    let stderr = '';
    p.stderr.on('data', c => { stderr += c.toString('utf8'); });
    p.on('close', code => {
        let out = '';
        try { out = fs.readFileSync(tmp, 'utf8'); } catch (_) { }
        try { fs.unlinkSync(tmp); } catch (_) { }
        if (out) onData(out);
        if (code !== 0) {
            // UAC 被点了「否」就是这条路：Start-Process 直接抛错
            onData(stderr.trim() ? stderr : '\n⛔ 提权失败（UAC 被拒绝，或者没点）。\n');
        }
        onDone(code, cwd);   // 提权进程的 cd 带不回来，cwd 保持不变
    });
    return p;
}

function mountTerminal(app) {
    const bashExe = findBash();

    app.get('/api/terminal/shells', (req, res) => {
        res.json({
            ok: true,
            shells: [
                { key: 'powershell', label: 'PowerShell', available: true },
                { key: 'cmd', label: 'CMD', available: true },
                { key: 'bash', label: 'Git Bash', available: !!bashExe },
            ],
            defaultCwd: TERMINAL_CWD,
            home: os.homedir(),
        });
    });

    app.post('/api/terminal/run', (req, res) => {
        const { cmd: rawCmd, shell = 'powershell', cwd, admin, id } = req.body || {};
        if (!rawCmd || !String(rawCmd).trim()) return res.status(400).json({ ok: false, msg: '没给命令' });
        if (shell === 'bash' && !bashExe) return res.status(400).json({ ok: false, msg: '这台电脑上没找到 Git Bash' });

        // claude 会话界面 → 一次性模式；其它交互式程序 → 直接讲清楚跑不了
        const rw = rewriteClaude(String(rawCmd));
        let cmd = rw.cmd, preNote = rw.note || '';
        const inter = cmd && INTERACTIVE_ONLY.find(x => x.re.test(cmd.trim()));
        if (inter) {
            preNote = `⛔ \`${cmd.trim()}\` 是${inter.name}，要停在终端里等你敲字——这个终端每条命令都是一次性跑完就退，没法互动。\n`
                + '   带上参数一次跑完就行（比如 python 脚本.py、node -e "…"）。\n';
            cmd = null;
        }

        const workdir = cwd && fs.existsSync(cwd) ? cwd : TERMINAL_CWD;
        const runId = id || String(Date.now());

        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders && res.flushHeaders();
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

        if (preNote) send('out', { text: preNote });
        if (!cmd) {                       // 交互式程序：话说清楚就收工，不 spawn
            send('done', { code: -1, cwd: workdir });
            return res.end();
        }

        const hit = dangerHit(cmd);
        if (hit) {
            console.log(`[终端] 拦截: ${cmd}`);
            send('out', { text: `⛔ 这条命令撞上了高危拦截规则（${hit}）。\n真要跑的话，去电脑上手动执行。\n` });
            send('done', { code: -1, cwd: workdir });
            return res.end();
        }

        console.log(`[终端] ${admin ? '(管理员) ' : ''}[${shell} @ ${workdir}] ${cmd}`);

        let sent = 0, cutOff = false, newCwd = workdir;
        const onData = text => {
            if (cutOff) return;
            // cwd 魔法标记：截下来更新 cwd，别让它出现在用户看到的输出里
            text = text.replace(new RegExp(MARK + '(.*)\\r?\\n?', 'g'), (_, p1) => {
                const d = p1.trim();
                if (d) newCwd = d;
                return '';
            });
            if (!text) return;
            sent += Buffer.byteLength(text);
            if (sent > MAX_BYTES) {
                cutOff = true;
                send('out', { text: '\n… 输出太多，掐了（超过 400KB）。\n' });
                try { running.get(runId)?.kill(); } catch (_) { }
                return;
            }
            send('out', { text });
        };
        const onDone = (code, finalCwd) => {
            clearTimeout(timer);
            running.delete(runId);
            send('done', { code, cwd: finalCwd || newCwd });
            res.end();
        };

        let proc;
        try {
            if (admin) {
                proc = runAdmin(cmd, workdir, shell, onData, onDone);
            } else {
                const { exe, args, verbatim } = buildArgs(shell, cmd, bashExe);
                proc = spawn(exe, args, { cwd: workdir, windowsVerbatimArguments: !!verbatim, windowsHide: true });
                // stdin 立刻关掉 = 给命令一个「没有输入」的信号。手机这边根本没法往里敲字，
                // 留着一个开着的管道只会让读 stdin 的程序干等到超时（claude 那句 "no stdin data
                // received in 3s" 就是这么来的）。关掉之后它们会立刻走「没输入」的分支。
                try { proc.stdin.end(); } catch (_) { }
                proc.stdout.on('data', c => onData(c.toString('utf8')));
                proc.stderr.on('data', c => onData(c.toString('utf8')));
                proc.on('close', code => onDone(code));
            }
            proc.on('error', e => { onData(`\n启动失败: ${e.message}\n`); onDone(-1); });
        } catch (e) {
            send('out', { text: '启动失败: ' + e.message + '\n' });
            send('done', { code: -1, cwd: workdir });
            return res.end();
        }

        running.set(runId, proc);
        send('start', { id: runId, cwd: workdir, shell, admin: !!admin });

        const timer = setTimeout(() => {
            try { proc.kill(); } catch (_) { }
            onData(`\n⏱ 跑了 ${TIMEOUT_MS / 60000} 分钟还没完，掐了。\n`);
        }, TIMEOUT_MS);

        // 手机端把 SSE 断了（关面板/切后台）→ 命令也别在电脑上留着空转。
        // 必须挂在 res 上、而且要看 writableEnded：新版 Node 里 req 的 'close' 在「请求体收完」
        // 就会触发（不只是断连），挂 req 的话每条命令刚 spawn 出来就被自己杀掉——
        // 表现是永远 0 输出、退出码 null。res 的 'close' 才是真·连接结束，
        // 正常跑完时我们已经 res.end()（writableEnded=true），只有客户端提前跑路才 kill。
        res.on('close', () => {
            if (res.writableEnded) return;
            if (running.has(runId)) {
                try { proc.kill(); } catch (_) { }
                running.delete(runId);
                clearTimeout(timer);
            }
        });
    });

    app.post('/api/terminal/kill', (req, res) => {
        const { id } = req.body || {};
        const p = running.get(id);
        if (!p) return res.json({ ok: false, msg: '这条命令已经不在跑了' });
        try { p.kill(); } catch (_) { }
        running.delete(id);
        res.json({ ok: true });
    });

    console.log(`💻 终端接口已挂载 -> /api/terminal/run   （Git Bash: ${bashExe || '没装'}）`);
}

module.exports = { mountTerminal };
