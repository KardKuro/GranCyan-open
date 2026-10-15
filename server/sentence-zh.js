'use strict';
// ==========================================
// 例句的中文翻译（需求：「能不能给所有句子加中文翻译」）
//
// 句库 Tatoeba 那边查的时候就只要带中文的句子（trans:lang=cmn），词书的例句基本都有；
// 缺中文的是她自己写的、AI 教词时带的例句 —— 那些一句中文都没有。
// 这些交给电脑上的本地 Ollama 现翻（2026-09-29 实测 9B 翻短句又顺又准，热着 0.7 秒一句，
// 冷启动 20 秒），译文进缓存 sentence-zh.json（键 = 语言 + 原句），/api/example 出门前也会查它。
// 命中缓存不碰模型。Ollama 没开就回空串 + pending，**失败不缓存**，前端下次打开再问
// （和音标那边同一个教训：「没翻成」当成「翻不了」钉死，就再也补不回来了）。
// GPU 只有一块，和思考链翻译共用一条队列。
// ==========================================
const fs = require('fs');
const path = require('path');
const tt = require('./think-translate');

const OLLAMA = (process.env.GRANCYAN_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MAX_TEXTS = 8, MAX_LEN = 400;

function keyOf(lang, text) {
    return (lang === 'de' ? 'de' : 'en') + ':' + String(text || '').replace(/\s+/g, ' ').trim();
}

// 落盘时先把盘上的读回来并进内存：整本预翻的脚本和正在跑的 server 可能同时写这个文件，
// 谁后写谁就把对方新加的整批冲掉，而且一声不吭。先读后并再写（tmp + rename 防写一半）。
function writeMerged(file, mem) {
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
    for (const k of Object.keys(disk)) if (!Object.prototype.hasOwnProperty.call(mem, k)) mem[k] = disk[k];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem));
    fs.renameSync(tmp, file);
}

function createStore(file) {
    let mem = null, timer = null;
    const load = () => {
        if (mem) return mem;
        try { mem = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { mem = {}; }
        return mem;
    };
    const flush = () => {
        clearTimeout(timer); timer = null;
        try { writeMerged(file, load()); } catch (e) { console.warn('[例句翻译] 缓存写不进去:', e.message); }
    };
    return {
        file,
        get(lang, text) { const v = load()[keyOf(lang, text)]; return typeof v === 'string' ? v : ''; },
        put(lang, text, zh) {
            if (!zh) return;
            load()[keyOf(lang, text)] = zh;
            clearTimeout(timer); timer = setTimeout(flush, 2000);
        },
        flush,
    };
}

const SYS = 'You translate example sentences for a Chinese high-school student who is learning the language. '
    + 'Translate the sentence into natural, everyday Simplified Chinese. Keep the meaning exact. '
    + 'Output only the translation on one line: no quotes, no pinyin, no notes.';
const SHOTS = [
    { role: 'user', content: 'I borrowed this book from the library last week.' },
    { role: 'assistant', content: '这本书是我上周从图书馆借的。' },
    { role: 'user', content: 'Ich habe keine Zeit, weil ich arbeiten muss.' },
    { role: 'assistant', content: '我没时间，因为我得工作。' },
];

// 模型偶尔回原文、回一段解释、或者给译文套引号。判据：必须有汉字，长度不离谱。
function cleanZh(src, out) {
    let s = String(out || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
    s = s.replace(/^["“「『'‘]+|["”」』'’]+$/g, '').trim();
    if (!/[一-鿿]/.test(s)) return '';
    if (s.length > String(src).length * 2 + 20) return '';
    return s;
}

async function ollamaOne(text, fetchImpl) {
    const r = await fetchImpl(OLLAMA + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),      // 冷启动 12 秒左右，给足
        body: JSON.stringify({
            model: tt.MODEL, think: false, stream: false, keep_alive: '30m',
            options: { temperature: 0.1, num_ctx: 2048 },
            messages: [{ role: 'system', content: SYS }, ...SHOTS, { role: 'user', content: text }],
        }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const j = await r.json();
    return cleanZh(text, j && j.message && j.message.content);
}

// 缓存有的直接给；没有的逐句排队交给 Ollama。第一次连不上就不再试剩下的（都算 pending）。
async function translate(store, lang, texts, fetchImpl = fetch) {
    const zh = texts.map(t => store.get(lang, t));
    let pending = 0, down = false;
    for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (zh[i] || !t.trim() || tt.mostlyChinese(t)) continue;
        if (down) { pending++; continue; }
        try {
            const out = await tt.enqueue(() => ollamaOne(t, fetchImpl));
            if (out) { zh[i] = out; store.put(lang, t, out); } else pending++;
        } catch (e) {
            down = true; pending++;
            console.warn('[例句翻译] Ollama 没翻成:', e.message);
        }
    }
    return { zh, pending };
}

function mount(app, store) {
    app.post('/api/sentence-zh', async (req, res) => {
        const b = req.body || {};
        const lang = b.lang === 'de' ? 'de' : 'en';
        const texts = (Array.isArray(b.texts) ? b.texts : []).slice(0, MAX_TEXTS).map(t => String(t || '').slice(0, MAX_LEN));
        if (!texts.length) return res.json({ ok: true, zh: [], pending: 0 });
        try { res.json({ ok: true, ...(await translate(store, lang, texts)) }); }
        catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });
}

module.exports = { keyOf, writeMerged, createStore, cleanZh, translate, mount };
