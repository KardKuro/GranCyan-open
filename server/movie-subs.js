'use strict';
// ==========================================
// 看片字幕：通话里「🎬 一起看」开着时，从屏幕上认字幕，压成两三句「刚才演到哪了」。
//
//   POST /api/movie-subs/start   开始认（一起看打开时前端调）
//   POST /api/movie-subs/stop    停（一起看关掉 / 挂断）
//   GET  /api/movie-subs         → { ok, on, recap, recent:[{at,text}], error? }
//                                  顺带算一次「前端还在」，90 秒没人问就自己停
//
// 为什么是 OCR、不是别的（2026-10-03 比过三条路）：
//   · 播放器内嵌字幕：PotPlayer / 浏览器各家各样，拿不到统一的接口。
//   · 通话麦克风 STT：电话开着回声消除 + 降噪，电影声音本来就会被压掉；戴耳机更是一点都录不到。
//     真要听电影得抓系统回放（WASAPI loopback），ffmpeg 不带，还要每段花一次转写钱。
//   · OCR：Windows 自带 Windows.Media.Ocr，这台机器装着 zh-Hans-CN，不花钱、不出电脑、
//     屏幕下半截一张认一次约 0.4 秒。看片的人大多开着字幕（中文片也有硬字幕），够用。
//   所以选 OCR。认不准的代价只是前情少几句，不会说错话——提示里明说了「可能有错字」。
//
// 字幕怎么从一屏字里挑出来（pickSubtitle）：只看屏幕下半截、水平居中、字够大的行。
//   终端/编辑器的字、任务栏、默认大小的弹幕都比字幕小（实测 1080p 下 ≈ 屏高 2.3%，字幕 ≥ 3%）。
//
// 前情（recap）：攒够 6 句新台词、离上次压缩过了 1 分钟，就交给本地 Ollama 的 Qwen
//   把「旧前情 + 新台词」压成新的两三句。和思考翻译共用一条 GPU 队列。Ollama 没开就只给原句。
//
// ⚠️ 截图和台词都只在内存里：截屏在 PowerShell 进程里认完就丢（不落盘），台词停了就清，
//    日志里只打句数、不打内容。这是用户的屏幕。
// ⚠️ 截屏 + OCR 写在同一个脚本里实测 Defender 不拦（和 server.js 偷看屏幕那次不同：
//    那次是「读键鼠时间 + 截屏」「截屏 + 转 base64」两种组合被 AMSI 判恶意）。
//    这里不碰键鼠、不吐图片，只吐认出来的字。真被拦了会在 error 里说「被杀毒软件拦截」。
// ==========================================

const { enqueue, looksRefused, MODEL, FALLBACK } = require('./think-translate');
const OLLAMA = (process.env.GRANCYAN_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const EVERY_MS = 4000;          // 多久认一次（字幕一句大概停 2~5 秒，4 秒会漏一些，前情够用）
const IDLE_STOP_MS = 90000;     // 90 秒没人来取 = 前端没了（刷新/崩了），自己停，别一直拍
const KEEP_MS = 10 * 60 * 1000; // 原句只留最近 10 分钟
const KEEP_MAX = 150;
const RECAP_MIN_NEW = 6;        // 攒够这么多句新台词才压一次
const RECAP_GAP_MS = 60000;     // 两次压缩至少隔一分钟
const RECENT_MAX = 8;           // 随前情一起给的最近原句
const RECENT_MS = 3 * 60 * 1000;

// 字幕的样子（都是相对屏幕的比例）
const SUB_MIN_H = 0.026;        // 字高下限：比这小的是界面字/代码/弹幕
const SUB_MAX_DX = 0.25;        // 行中心离屏幕中线最多这么远（窗口化播放器常常偏左）
const SUB_MIN_Y = 0.5;          // 只认下半截

// 注意：这段是 JS 模板字符串，里面不能出现反引号和 ${（PowerShell 的转义符恰好是反引号）
const PS_SUBS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('zh-Hans-CN')))
if (-not $eng) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $eng) { @{ fatal = 'no-ocr-language' } | ConvertTo-Json -Compress; exit 2 }
$every = [int]$env:SUB_EVERY_MS
$parent = [int]$env:SUB_PARENT
$band = 0.5
while ($true) {
  try { $null = [System.Diagnostics.Process]::GetProcessById($parent) } catch { break }
  $t0 = [Environment]::TickCount
  $out = @()
  try {
    foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
      $b = $scr.Bounds
      $top = [int]($b.Height * (1 - $band)); $hh = $b.Height - $top
      $bmp = New-Object System.Drawing.Bitmap($b.Width, $hh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y + $top, 0, 0, $bmp.Size)
      $g.Dispose()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
      $ms.Position = 0
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms))) ([Windows.Graphics.Imaging.BitmapDecoder])
      $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
      $sb.Dispose(); $ms.Dispose()
      foreach ($l in $res.Lines) {
        $x0 = 1e9; $x1 = 0; $y0 = 1e9; $y1 = 0
        foreach ($w in $l.Words) { $r = $w.BoundingRect
          if ($r.X -lt $x0) { $x0 = $r.X }; if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }
          if ($r.Y -lt $y0) { $y0 = $r.Y }; if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height } }
        $out += @{ text = $l.Text; cx = [math]::Round(($x0 + $x1) / 2 / $b.Width, 3); y = [math]::Round(($top + $y0) / $b.Height, 3); h = [math]::Round(($y1 - $y0) / $b.Height, 4) }
      }
    }
    @{ ms = [Environment]::TickCount - $t0; lines = $out } | ConvertTo-Json -Compress -Depth 4
  } catch {
    @{ err = [string]$_.Exception.Message } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds $every
}
`;

// OCR 认中文会在每个字中间插空格（「你 根 本 不 知 道」），先挤掉
const CJK = '\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g');
function cleanOcr(s) {
    return String(s || '').replace(CJK_GAP, '').replace(/\s+/g, ' ').trim();
}

// 像一句话（有字），而不是一串数字/符号/代码
function looksLikeSpeech(s) {
    const cjk = (s.match(/[一-鿿]/g) || []).length;
    const lat = (s.match(/[A-Za-z]/g) || []).length;
    const all = s.replace(/\s/g, '').length;
    if (cjk < 2 && lat < 4) return false;
    if (/[{};=<>$\\/]|=>|\(\)/.test(s)) return false;                  // 代码/路径的味道
    return (cjk + lat) / Math.max(1, all) >= 0.6;
}

// 一次采样认出来的所有行 → 这一刻的字幕（没有就 ''）。两行字幕按从上到下拼起来。
function pickSubtitle(lines) {
    const cand = (Array.isArray(lines) ? lines : [])
        .filter(l => l && Number(l.h) >= SUB_MIN_H && Math.abs(Number(l.cx) - 0.5) <= SUB_MAX_DX && Number(l.y) >= SUB_MIN_Y)
        .map(l => ({ y: Number(l.y), text: cleanOcr(l.text) }))
        .filter(l => l.text.length >= 2 && looksLikeSpeech(l.text))
        .sort((a, b) => a.y - b.y)
        .slice(-2);                                                     // 字幕最多两行，取最靠下的
    return cand.map(l => l.text).join(' ').slice(0, 120);
}

// 同一句字幕会被连拍好几次，OCR 每次还可能差一两个字 —— 当成同一句
function _norm(s) { return String(s || '').replace(/[^一-鿿A-Za-z0-9]/g, '').toLowerCase(); }
function sameLine(a, b) {
    const x = _norm(a), y = _norm(b);
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const bag = new Map();
    for (const c of x) bag.set(c, (bag.get(c) || 0) + 1);
    let common = 0;
    for (const c of y) { const n = bag.get(c); if (n) { common++; bag.set(c, n - 1); } }
    return common / Math.max(x.length, y.length) >= 0.75;
}

const RECAP_SYS = '你在帮一个正在看片的人记住剧情进展。下面给你「之前的前情」和之后屏幕上出现的字幕台词。'
    + '台词是 OCR 从屏幕上认出来的，可能有错字，也可能混进弹幕或界面文字——明显不像台词的忽略掉。'
    + '用两三句简体中文概括到目前为止发生了什么：谁和谁、在说什么事、情绪或冲突走向。'
    + '只根据给你的内容写，台词里看不出来的情节、人名不要编。不知道人名就说「男主」「一个女人」这样。'
    + '只输出概括本身，不加标题、不加前缀、不超过 120 字。';

function create(opts = {}) {
    const spawnImpl = opts.spawnImpl || require('child_process').spawn;
    const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    const now = opts.now || Date.now;
    const log = opts.log || ((...a) => console.log('[看片字幕]', ...a));
    const everyMs = opts.everyMs || EVERY_MS;
    const disabled = !!opts.disabled;
    const platform = opts.platform || process.platform;
    const q = opts.enqueue || enqueue;

    const st = {
        on: false, child: null, gen: 0, lastPoll: 0, error: '',
        lines: [],                // [{ at, text }]
        recap: '', recapAt: 0,    // recapAt = 前情已经覆盖到的最后一句的时间
        recapBusy: false, recapTriedAt: 0,
        samples: 0,
    };

    function reset() {
        st.lines = []; st.recap = ''; st.recapAt = 0; st.recapBusy = false; st.recapTriedAt = 0;
        st.error = ''; st.samples = 0;
    }

    function feed(sample) {
        if (!st.on || !sample) return;
        if (sample.err) { st.error = 'OCR 失败：' + String(sample.err).slice(0, 120); return; }
        if (sample.fatal) { st.error = sample.fatal === 'no-ocr-language' ? '这台电脑没有可用的 OCR 语言包' : String(sample.fatal); return; }
        st.samples++;
        const text = pickSubtitle(sample.lines);
        if (!text) return;
        const t = now();
        const last = st.lines[st.lines.length - 1];
        if (last && sameLine(last.text, text)) {
            // 同一句：认得更全的那次留下（字幕逐字打出来、或者前一次被挡了半截）
            const a = _norm(text).length, b = _norm(last.text).length;
            if (a > b || (a === b && text.length > last.text.length)) last.text = text;
            return;
        }
        st.lines.push({ at: t, text });
        const cut = t - KEEP_MS;
        while (st.lines.length && (st.lines[0].at < cut || st.lines.length > KEEP_MAX)) st.lines.shift();
        maybeRecap();
    }

    async function ollamaRecap(user, model) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
            const r = await fetchImpl(OLLAMA + '/api/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
                body: JSON.stringify({
                    model, think: false, stream: false, keep_alive: model === MODEL ? '30m' : '2m',
                    options: { temperature: 0.2, num_ctx: 4096 },
                    messages: [{ role: 'system', content: RECAP_SYS }, { role: 'user', content: user }],
                }),
            });
            if (!r.ok) throw new Error('Ollama ' + r.status);
            const j = await r.json();
            return String(j?.message?.content || '').trim();
        } finally { clearTimeout(timer); }
    }

    function maybeRecap() {
        if (st.recapBusy) return null;
        const fresh = st.lines.filter(l => l.at > st.recapAt);
        if (fresh.length < RECAP_MIN_NEW) return null;
        if (now() - st.recapTriedAt < RECAP_GAP_MS) return null;
        st.recapBusy = true;
        st.recapTriedAt = now();
        const gen = st.gen;
        const upTo = fresh[fresh.length - 1].at;
        const user = `之前的前情：${st.recap || '（刚开始看，还没有）'}\n\n之后的台词：\n` + fresh.map(l => '· ' + l.text).join('\n');
        return q(async () => {
            let out = await ollamaRecap(user, MODEL);
            if (looksRefused(user, out)) out = await ollamaRecap(user, FALLBACK);
            if (looksRefused(user, out)) throw new Error('两个模型都拒了');
            return out;
        }).then(out => {
            if (gen !== st.gen || !st.on) return;             // 压的途中停了/重开了，这份作废
            out = String(out || '').replace(/^(前情|概括|总结)[:：]\s*/, '').trim().slice(0, 200);
            if (!out) return;
            st.recap = out; st.recapAt = upTo;
            log(`前情更新（并进 ${fresh.length} 句）`);
        }).catch(e => {
            log('压前情失败（只给原句）：' + e.message);
        }).finally(() => { if (gen === st.gen) st.recapBusy = false; });
    }

    function start() {
        st.lastPoll = now();
        if (disabled) return { ok: false, on: false, error: '服务端已关闭屏幕读取（GRANCYAN_PEEK=off）' };
        if (platform !== 'win32') return { ok: false, on: false, error: '认字幕目前只支持 Windows' };
        if (st.on) return { ok: true, on: true };
        st.gen++; reset();
        const gen = st.gen;
        let child;
        try {
            child = spawnImpl('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-STA',
                '-EncodedCommand', Buffer.from(PS_SUBS, 'utf16le').toString('base64'),
            ], {
                windowsHide: true,
                env: { ...process.env, SUB_EVERY_MS: String(everyMs), SUB_PARENT: String(process.pid) },
            });
        } catch (e) {
            return { ok: false, on: false, error: '起不来：' + e.message };
        }
        st.on = true; st.child = child;
        let buf = '', errBuf = '';
        child.stdout.setEncoding?.('utf8');
        child.stdout.on('data', d => {
            if (gen !== st.gen) return;                  // 停了/重开了：旧进程晚到的输出不算
            buf += String(d);
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                try { feed(JSON.parse(line)); } catch { /* 半截/进度信息，跳过 */ }
            }
        });
        child.stderr?.on('data', d => { if (errBuf.length < 4000) errBuf += String(d); });
        child.on('error', e => { if (gen === st.gen) st.error = '起不来：' + e.message; });
        child.on('exit', code => {
            if (gen !== st.gen) return;
            st.child = null;
            if (st.on) {
                st.on = false;
                st.error = /malicious content|恶意内容/.test(errBuf) ? '脚本被杀毒软件拦截了（AMSI）'
                    : st.error || `认字幕的进程退出了（${code}）`;
                log(st.error);
            }
        });
        log('开始认字幕');
        return { ok: true, on: true };
    }

    function stop() {
        const was = st.on;
        st.gen++;
        st.on = false;
        if (st.child) { try { st.child.kill(); } catch {} st.child = null; }
        reset();                                   // 台词不留：停了就清
        if (was) log('停了');
        return { ok: true, on: false };
    }

    function view() {
        st.lastPoll = now();
        const t = now();
        const recent = st.lines.filter(l => l.at > st.recapAt && l.at > t - RECENT_MS).slice(-RECENT_MAX)
            .map(l => ({ ago: Math.max(0, Math.round((t - l.at) / 1000)), text: l.text }));
        return { ok: true, on: st.on, recap: st.recap, recent, samples: st.samples, error: st.error || undefined };
    }

    // 前端没了（刷新、崩了、手机锁屏）就别一直拍
    function watchdog() {
        if (st.on && now() - st.lastPoll > IDLE_STOP_MS) { log('90 秒没人来取，自己停了'); stop(); }
    }

    return { start, stop, view, feed, watchdog, maybeRecap, _st: st };
}

function mount(app, opts = {}) {
    const subs = create({ disabled: String(process.env.GRANCYAN_PEEK || '').toLowerCase() === 'off', ...opts });
    const wd = setInterval(() => subs.watchdog(), 15000);
    wd.unref?.();
    process.on('exit', () => subs.stop());
    app.post('/api/movie-subs/start', (req, res) => res.json(subs.start()));
    app.post('/api/movie-subs/stop', (req, res) => res.json(subs.stop()));
    app.get('/api/movie-subs', (req, res) => res.json(subs.view()));
    return subs;
}

module.exports = { mount, create, pickSubtitle, cleanOcr, sameLine, looksLikeSpeech, PS_SUBS,
    SUB_MIN_H, RECAP_MIN_NEW, RECAP_GAP_MS, IDLE_STOP_MS };
