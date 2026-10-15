// server/tts-local.js
// 本地情绪声音（CosyVoice3）的管家：按需拉起 Python 推理小服务、闲了关掉、把合成请求转过去。
//
// 为什么是「按需拉起 + 闲了就关」而不是常驻：这台机器是 4050 6GB，Ollama 的 qwen 常驻占着 4G
// （思考翻译要用）。CosyVoice3 fp16 一开就是两个 G 上下，两个都常驻就是在跟显卡赌。
// 所以只在真有人要听本地声音的时候才占，十分钟没人用就把进程杀掉、把显存还回去。
// 代价是冷启动：第一次要等模型加载（见报告里实测的秒数），之后都是热的。
//
// 小服务本身见 scripts/voice/cosy_sidecar.py。它只听 127.0.0.1、端口用系统挑的空端口
// （几个 worktree 的 server 可能同时开着，写死端口会撞），加载完往 stdout 打 `READY <port>`。
//
// 引擎没装 / 起不来 / 合成炸了 → 调用方退回 Edge。这里只负责如实报错，不自己兜底。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULTS = {
    // 引擎目录 / Python 路径都没有内置默认值：没设环境变量 = 本地情绪声音不可用，调用方退回 Edge。
    dir: process.env.GRANCYAN_VOICE_DIR || '',
    python: process.env.GRANCYAN_VOICE_PY || 'python',
    idleMs: (Number(process.env.GRANCYAN_VOICE_IDLE_MIN) || 10) * 60e3,
    bootMs: 180e3,          // 冷启动上限：模型 5G 从机械盘读也该够了
    synthMs: 120e3,         // 单句合成上限
};

// 显存让位：拉起推理进程之前，请 Ollama 把占着显卡的模型先卸下来。
// 2026-10-03 实测这张 6GB 的卡：qwen3.5-9b-q3 占 4.1G，CosyVoice3 加载完 1.9G、加载瞬间还要多 2G，
// 两个塞不下——硬塞的话 Windows 会把显存溢出到共享内存，两边一起慢到不能用。
// 卸下之后思考翻译再要 qwen 时，Ollama 会自己看剩多少显存、把放不下的层放 CPU（翻译慢一点，但不崩）；
// 声音闲置关掉后显存还回去，下次翻译又能整个放进显卡。只在冷启动时做一次。
async function yieldOllama(base) {
    const OLLAMA = (base || process.env.GRANCYAN_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
        const ps = await (await fetch(OLLAMA + '/api/ps', { signal: ac.signal })).json();
        const onGpu = (ps.models || []).filter(m => m.size_vram > 0).map(m => m.name);
        for (const model of onGpu) {
            await fetch(OLLAMA + '/api/generate', {
                method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, keep_alive: 0 }),
            });
        }
        if (onGpu.length) console.log('[本地声音] 请 Ollama 先让出显卡：' + onGpu.join('、'));
        return onGpu;
    } catch (_) { return []; }           // Ollama 没开 / 不理人：不影响，照常起
    finally { clearTimeout(timer); }
}

function create(opts = {}) {
    const o = Object.assign({}, DEFAULTS, opts);
    const paths = {
        root: path.join(o.dir, 'CosyVoice'),
        model: path.join(o.dir, 'models', 'Fun-CosyVoice3-0.5B'),
        voices: path.join(o.dir, 'voices'),
    };
    // 脚本优先用仓库里那份（开发时改了立即生效）；打包后仓库那份在 asar 里，Python 读不到，
    // 用装引擎时拷到引擎目录的那份。
    function sidecarPath() {
        const inRepo = path.join(__dirname, '..', 'scripts', 'voice', 'cosy_sidecar.py');
        if (!inRepo.includes('.asar') && fs.existsSync(inRepo)) return inRepo;
        return path.join(o.dir, 'cosy_sidecar.py');
    }
    const spawnFn = o.spawn || spawn;

    let proc = null, port = 0, booting = null, idleTimer = null, lastErr = '';

    function installed() {
        return fs.existsSync(o.python) && fs.existsSync(path.join(paths.model, 'llm.pt'))
            && fs.existsSync(paths.root) && fs.existsSync(sidecarPath());
    }
    function voices() {
        try {
            return fs.readdirSync(paths.voices)
                .filter(f => /^[a-z0-9][a-z0-9-]{0,39}\.wav$/.test(f) && fs.existsSync(path.join(paths.voices, f.slice(0, -4) + '.txt')))
                .map(f => f.slice(0, -4)).sort();
        } catch (_) { return []; }
    }
    function status() {
        return { installed: installed(), running: !!(proc && port), booting: !!booting, voices: voices(), lastError: lastErr };
    }

    function stop(reason) {
        clearTimeout(idleTimer); idleTimer = null;
        if (proc) {
            console.log('[本地声音] 关掉推理进程（' + (reason || '手动') + '），显存还回去');
            try { proc.stdin.end(); } catch (_) {}      // 小服务读到 stdin EOF 自己退
            const p = proc;
            setTimeout(() => { try { p.kill(); } catch (_) {} }, 3000).unref?.();
        }
        proc = null; port = 0; booting = null;
    }
    function touch() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop('闲了 ' + Math.round(o.idleMs / 60e3) + ' 分钟'), o.idleMs);
        if (idleTimer.unref) idleTimer.unref();
    }

    function boot() {
        if (proc && port) return Promise.resolve(port);
        if (booting) return booting;
        if (!installed()) return Promise.reject(new Error('本地声音引擎没装（' + o.dir + '）'));
        const yieldGpu = o.yieldGpu || yieldOllama;
        booting = Promise.resolve(yieldGpu()).catch(() => {}).then(() => new Promise((resolve, reject) => {
            const t0 = Date.now();
            console.log('[本地声音] 拉起推理进程，加载模型中…');
            const p = spawnFn(o.python, [
                '-u', sidecarPath(), '--root', paths.root, '--model', paths.model, '--voices', paths.voices, '--port', '0', '--watch-stdin'
            ], { cwd: paths.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                 env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
            proc = p;
            let out = '', errTail = '', done = false;
            const finish = (err, prt) => {
                if (done) return; done = true;
                clearTimeout(timer);
                if (err) { lastErr = err.message; if (proc === p) stop('启动失败'); reject(err); }
                else { port = prt; booting = null; lastErr = ''; console.log('[本地声音] 就绪，端口 ' + prt + '，冷启动 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'); touch(); resolve(prt); }
            };
            const timer = setTimeout(() => finish(new Error('本地声音启动超时')), o.bootMs);
            p.stdout.on('data', d => {
                out += d.toString();
                const m = out.match(/READY (\d+)/);
                if (m) finish(null, +m[1]);
            });
            p.stderr.on('data', d => {
                const s = d.toString();
                errTail = (errTail + s).slice(-2000);
                for (const line of s.split(/\r?\n/)) if (/^\[cosy\]/.test(line)) console.log('[本地声音] ' + line.slice(7));
            });
            p.on('error', e => finish(e));
            p.on('exit', code => {
                if (proc === p) { proc = null; port = 0; booting = null; }
                const tail = errTail.trim().split(/\r?\n/).slice(-3).join(' | ');
                finish(new Error('推理进程退出（' + code + '）' + (tail ? '：' + tail : '')));
            });
        }));
        return booting;
    }

    // 合成一句，回 mp3 Buffer。
    // （没做 HTTP 流式：通话那头是按句流水线念的，见 js/11-camera-call.js 的 _callSpeakParts）
    async function synth({ text, voice, instruct, speed }) {
        const prt = await boot();
        touch();
        const body = Buffer.from(JSON.stringify({ text, voice, instruct: instruct || '', speed: speed || 1 }));
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: prt, path: '/tts', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            }, res => {
                if (res.statusCode !== 200) {
                    let s = ''; res.on('data', d => { s += d; });
                    res.on('end', () => {
                        let msg = 'HTTP ' + res.statusCode;
                        try { msg = JSON.parse(s).error || msg; } catch (_) {}
                        reject(new Error(msg));
                    });
                    return;
                }
                const chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => { touch(); resolve(Buffer.concat(chunks)); });
                res.on('error', reject);
            });
            req.setTimeout(o.synthMs, () => req.destroy(new Error('本地声音合成超时')));
            req.on('error', reject);
            req.end(body);
        });
    }

    return { synth, status, stop, boot, installed, voices, paths };
}

module.exports = { create };
