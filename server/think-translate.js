'use strict';
// ==========================================
// 思考链翻译：把模型的英文思考交给电脑上的本地小模型（Ollama）翻成中文。
//
// 为什么走 server 中转、不让前端直连 Ollama：
//   · 手机上的页面挂在 https://grancyan.app，直连电脑 11434 要改 OLLAMA_HOST + OLLAMA_ORIGINS，
//     两处都是静默失效（不配就是连不上，没有报错）。server 本来就对手机开着、闸也配好了。
//   · 模型名、分段、keep_alive 这些只写一份。
//
// 为什么 think:false：Qwen3.5 默认先思考再回答，翻译用不着，开着的话慢一倍还可能把
// 它自己的思考混进译文。
//
// ⚠️ 只翻译、不改写：原文在前端原字段里一个字都不动，译文另存一个字段。
//    回填历史给模型看的永远是原文 —— 这里的输出只给用户看。
// ==========================================

const OLLAMA = (process.env.GRANCYAN_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.GRANCYAN_TRANSLATE_MODEL || 'qwen3.5-9b-q3';
// 主模型偶尔不翻，回一句「我无法生成此类内容……」—— 而这句会被当成译文存下来、顶掉整段思考。
// 认出来时，如果配了备用模型（GRANCYAN_TRANSLATE_FALLBACK，任选一个你本地 Ollama 里的普通模型）
// 就换它重翻这一段；没配就直接报错（前端不写 thinkZh，保留原文）。默认不配。
// 备用模型冷加载可能要几十秒，只在拒翻时才动它，平时不占显存。
const FALLBACK = String(process.env.GRANCYAN_TRANSLATE_FALLBACK || '').trim();

const SYS = 'You are a translator. Translate the user text from English into natural Simplified Chinese. '
    + 'Output only the translation. Keep it faithful and complete: do not omit, soften, censor, summarize or add anything. '
    + 'Keep line breaks and markdown (like **bold** headings) as they are. '
    + 'Write it the way a Chinese speaker would actually think it: plain and conversational, not stiff translationese. '
    + 'Names are fixed, never transliterate them differently: Keke = 克克 (never 凯凯); '
    + 'Xiaoming = 小明; Claude stays Claude. '
    + 'Keep code identifiers, file paths and commands unchanged. '
    + 'Any part that is already in Chinese stays exactly as written: copy it, do not rephrase it.';
// 9B 光看规则还是会把人名译成别的写法、或者两个名字混在一起 —— 给一对示范，它照着例子学比照着规则学稳
const SHOTS = [
    { role: 'user', content: 'Xiaoming is asking Keke about the weather again. A short answer settles it, but a long lecture would be boring, so I\'ll keep it light.' },
    { role: 'assistant', content: '小明又在问克克天气了。简短回答就够了，长篇大论反而无聊，所以我轻松一点说。' },
];

// 按段落切块。num_ctx 是 4096（Q3 在 6G 显存里放得下的上限），一块英文 ~2400 字符 ≈ 600 token，
// 加上译文和系统提示还有富余。单段超长就硬切 —— 宁可断句难看，也不能整块溢出被截掉。
const CHUNK = 2400;
function splitChunks(text) {
    const out = [];
    let cur = '';
    for (const para of String(text).split(/(\n\s*\n)/)) {
        if (cur.length + para.length > CHUNK && cur.trim()) { out.push(cur); cur = ''; }
        if (para.length > CHUNK) {
            for (let i = 0; i < para.length; i += CHUNK) out.push(para.slice(i, i + CHUNK));
            continue;
        }
        cur += para;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

// 已经是中文就不用翻（DeepSeek 之类本来就用中文想）。判据：汉字占字母+汉字的三成以上。
function mostlyChinese(text) {
    const s = String(text || '');
    const cjk = (s.match(/[一-鿿]/g) || []).length;
    const lat = (s.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk / (cjk + lat) > 0.3;
}

// 英文里夹着整段中文的思考（模型思考时常会中途换回中文）：整块不到三成汉字、不会被上面跳过，
// 以前就整块丢给 Qwen —— 中文那几段被它「翻」成另一种说法，原话没了。
// 现在按行切成连续的段：中文行原样留着，只有英文段送去翻。
// 空行、纯标点这种两边都不算的行跟着当前段走，免得英文段落被空行切碎、一段一个请求。
function splitRuns(text) {
    const runs = [];
    for (const line of String(text).split(/(?<=\n)/)) {
        const kind = /[A-Za-z]/.test(line) && !mostlyChinese(line) ? 'en'
            : /[一-鿿]/.test(line) ? 'zh' : '';
        const last = runs[runs.length - 1];
        if (last && (!kind || !last.kind || last.kind === kind)) {
            last.text += line;
            if (!last.kind) last.kind = kind;
        } else runs.push({ kind, text: line });
    }
    return runs;
}

// 「译文」其实是拒绝。三条一起成立才算：
//   · 译文里有拒绝句式（中文或英文 —— 模型拒的时候常常连语言都换回英文）
//   · 原文自己没在说「我不能……」（思考里写「I can't write that」是正常内容，如实翻出来不算拒）
//   · 译文比正常译文短得多（真翻完的中文大约是英文字符数的三到五成；拒绝只有一两句）
const REFUSE_ZH = /(我|抱歉|对不起|很抱歉)[^。\n]{0,20}(无法|不能|不可以|不会)[^。\n]{0,30}(生成|提供|创作|输出|协助|翻译|处理|帮)/;
const REFUSE_EN = /\b(I can(?:not|'t)|I'm (?:sorry|unable|not able)|I am (?:sorry|unable|not able)|I won't)\b[^.\n]{0,60}\b(generate|provide|create|produce|assist|help|translate|write)/i;
function looksRefused(src, zh) {
    const s = String(src || ''), z = String(zh || '');
    if (!REFUSE_ZH.test(z) && !REFUSE_EN.test(z)) return false;
    if (REFUSE_EN.test(s) || REFUSE_ZH.test(s)) return false;
    return z.length < Math.max(200, s.length * 0.25);
}

async function translateChunk(text, fetchImpl, model = MODEL) {
    const r = await fetchImpl(OLLAMA + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model, think: false, stream: false,
            // 默认 5 分钟就卸，下一段思考又要吃 12 秒冷启动；备用的只偶尔用，用完早点把显存还给 Qwen
            keep_alive: model === MODEL ? '30m' : '2m',
            options: { temperature: 0.2, num_ctx: 4096 },
            messages: [{ role: 'system', content: SYS }, ...SHOTS, { role: 'user', content: text }],
        }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return String(j?.message?.content || '').trim();
}

// GPU 只有一块，并发请求只会互相拖慢 —— 全局排队，一次翻一段。
let _queue = Promise.resolve();
function enqueue(job) {
    const p = _queue.then(job, job);
    _queue = p.catch(() => {});
    return p;
}

async function translateThinking(text, fetchImpl = fetch) {
    const src = String(text || '');
    if (!src.trim()) return { ok: true, zh: '', skipped: 'empty' };
    if (mostlyChinese(src)) return { ok: true, zh: '', skipped: 'chinese' };
    const runs = splitRuns(src);
    if (!runs.some(r => r.kind === 'en')) return { ok: true, zh: '', skipped: 'chinese' };
    return enqueue(async () => {
        const parts = [];
        for (const run of runs) {
            if (run.kind !== 'en') { parts.push(run.text); continue; }   // 中文原话一个字不动
            for (const chunk of splitChunks(run.text)) {
                // 纯空白分隔符原样留下，保住段落结构
                if (!chunk.trim()) { parts.push(chunk); continue; }
                const lead = chunk.match(/^\s*/)[0], tail = chunk.match(/\s*$/)[0];
                let zh = await translateChunk(chunk.trim(), fetchImpl);
                if (looksRefused(chunk, zh)) {
                    if (!FALLBACK) throw new Error('主模型拒翻了这段（没配备用模型 GRANCYAN_TRANSLATE_FALLBACK）');
                    console.warn('[思考翻译] 主模型拒翻了一段，换备用模型重翻');
                    zh = await translateChunk(chunk.trim(), fetchImpl, FALLBACK);
                    // 两个都拒就报错 —— 绝不能把一句拒绝存成译文，前端会拿它顶掉整段思考
                    if (looksRefused(chunk, zh)) throw new Error('两个模型都拒翻了这段');
                }
                if (!zh) throw new Error('模型回了空译文');
                parts.push(lead + zh + tail);
            }
        }
        return { ok: true, zh: parts.join('').trim() };
    });
}

function registerThinkTranslate(app) {
    // 探针：前端据此决定要不要发翻译请求。Ollama 没开或模型没装都算不可用。
    app.get('/api/think-translate/ping', async (req, res) => {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1500);
            const r = await fetch(OLLAMA + '/api/tags', { signal: ctrl.signal });
            clearTimeout(t);
            const j = await r.json();
            const has = (j.models || []).some(m => m.name === MODEL || m.name === MODEL + ':latest');
            res.json({ ok: has, model: MODEL, error: has ? undefined : `Ollama 里没有 ${MODEL}` });
        } catch (e) {
            res.json({ ok: false, model: MODEL, error: 'Ollama 没在跑（' + e.message + '）' });
        }
    });

    app.post('/api/think-translate', async (req, res) => {
        const text = String((req.body || {}).text || '');
        if (text.length > 60000) return res.status(413).json({ ok: false, error: '思考太长了' });
        try {
            res.json(await translateThinking(text));
        } catch (e) {
            console.error('[思考翻译] 失败:', e.message);
            res.status(502).json({ ok: false, error: e.message });
        }
    });
}

// enqueue 给例句翻译（server/sentence-zh.js）共用：同一块 GPU，同一条队
module.exports = { registerThinkTranslate, translateThinking, splitChunks, splitRuns, mostlyChinese, looksRefused, enqueue, MODEL, FALLBACK };
