// server/audio-listen.js
// 聊天里发音频给 AI。Claude / GPT 都只吃文字和图，自己听不见，
// 所以电脑这边把音频交给 Gemini 听一遍，写成一段「听到了什么」的文字，前端当成附件塞进这条消息
// （js/66-audio-attach.js）。和视频抽帧成图是一个思路：把模型吃不了的东西翻成它吃得了的。
// Gemini 那一套（模型链、代理、JSON 解析、m:ss 时间点）全借 music-profile.js 的，坑也一样，见那边文件头。
//
// POST /api/audio/listen?name=<文件名>&dur=<秒>&cut=<1=只发了前面一段>
//      body = 音频原始字节，Content-Type = 它的 MIME   → { text, kind, model } 或 { error }
const express = require('express');
const { geminiOnce, parseJsonLoose, parseMmss } = require('./music-profile');
const { geminiAgent } = require('./gemini');

// 和 music-profile 同一个口径：inline 整包 20MB，base64 胀 4/3，原始音频留 14MB
const MAX_AUDIO_BYTES = 14 * 1024 * 1024;
// 一段约 32 token/秒，5 分钟 1 万 token。一天 60 段到顶，防前端哪天写坏了狂刷
const MAX_PER_DAY = 60;
const KINDS = ['歌曲', '纯音乐', '说话', '哼唱', '清唱', '环境声', '混合'];
// Gemini 认的音频 MIME（官方列的六种）。别的格式前端会先转成 16k 单声道 wav 再发
const GEMINI_MIMES = ['audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac'];

const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
};
const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// 浏览器报的 MIME 五花八门（audio/mpeg、audio/x-wav、audio/x-flac…），归到 Gemini 那六种；归不进去回 ''
function geminiMime(raw) {
    const m = String(raw || '').split(';')[0].trim().toLowerCase();
    if (/^audio\/(mpeg|mp3|mpeg3|x-mpeg|x-mp3)$/.test(m)) return 'audio/mp3';
    if (/^audio\/(wav|wave|x-wav|vnd\.wave)$/.test(m)) return 'audio/wav';
    if (/^audio\/(flac|x-flac)$/.test(m)) return 'audio/flac';
    if (/^audio\/(aac|x-aac|aacp)$/.test(m)) return 'audio/aac';
    if (/^audio\/(aiff|x-aiff)$/.test(m)) return 'audio/aiff';
    if (/^audio\/ogg$/.test(m)) return 'audio/ogg';
    return GEMINI_MIMES.includes(m) ? m : '';
}

function buildListenPrompt({ name, dur, cut }) {
    const D = Number(dur) > 0 ? fmt(Number(dur)) : '';
    return `她在聊天里发来一段音频${name ? `（文件名「${clip(name, 80)}」）` : ''}${D ? `，长 ${D}` : ''}${cut ? '，太长了只截了前面一段给你' : ''}。
陪她聊天的是另一个听不见声音的 AI，你替它把这段从头听到尾，写成中文给它看。

先判断这是什么：${KINDS.join(' / ')}。然后只写你在音频里真的听到的东西，听不出来的留空，别凭文件名去编。
时间点一律写成 "分:秒" 字符串（如 "1:05"），以音频开头为 0:00${D ? `，别超出 ${D}` : ''}。

输出 JSON：
{
  "kind": "上面七种之一",
  "summary": "一句话：这段听起来是什么（≤50字）",
  "voice": "人声：几个人、男女、语气和情绪、唱法或说话的样子（没有人声写空串）",
  "transcript": "说话/哼唱/清唱：听得清的照原话写下来，听不清的地方写[听不清]（≤1200字）；歌曲：用自己的话概括歌词大意，不要大段照抄（≤150字）；没有人声写空串",
  "mood": "情绪从头到尾怎么走的（≤80字）",
  "sounds": ["主要乐器/音色/背景声，最多 8 个"],
  "sections": [{ "start": "0:00", "label": "这一段叫什么（前奏/主歌/副歌/开口说话/停顿…）", "note": "这一段在发生什么（≤50字）" }],
  "guess": "如果听得出是哪首已有的歌（包括她哼的是哪首），写歌名和把握有多大；认不出就写空串，别硬猜",
  "other": "其他值得那个 AI 知道的：录音环境、音质、有没有杂音、她的状态听起来怎么样（≤80字）"
}
sections 按时间顺序，短的音频（不到半分钟）可以只写一两段或者留空数组。`;
}

// 模型吐的 JSON → 给聊天 AI 看的一段文字。返回 { kind, text }；什么都没听出来回 null
function formatListen(raw, dur) {
    if (!raw || typeof raw !== 'object') return null;
    const D = Number(dur) > 0 ? Math.round(Number(dur)) : 0;
    const kind = KINDS.includes(String(raw.kind || '').trim()) ? String(raw.kind).trim() : clip(raw.kind, 8);
    const secs = [];
    for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
        if (!s || typeof s !== 'object') continue;
        const st = parseMmss(s.start);
        if (!Number.isFinite(st) || (D && st > D)) continue;     // 落在音频外面 = 时间轴写错了，丢
        secs.push({ t: Math.round(st), label: clip(s.label, 10) || '段落', note: clip(s.note, 60) });
    }
    secs.sort((a, b) => a.t - b.t);
    const lines = [];
    const add = (k, v) => { if (v) lines.push(`${k}：${v}`); };
    add('类型', kind);
    add('一句话', clip(raw.summary, 70));
    add('人声', clip(raw.voice, 80));
    add('情绪', clip(raw.mood, 100));
    const sounds = (Array.isArray(raw.sounds) ? raw.sounds : []).map(x => clip(x, 16)).filter(Boolean).slice(0, 8);
    if (sounds.length) add('声音', sounds.join('、'));
    const tr = clip(raw.transcript, 1300);
    if (tr) lines.push(`${/说话|哼唱|清唱/.test(kind) ? '原话' : '内容'}：\n${tr}`);
    if (secs.length) lines.push('时间线：\n' + secs.slice(0, 24).map(s => `${fmt(s.t)} ${s.label}${s.note ? ' — ' + s.note : ''}`).join('\n'));
    add('认出来的歌', clip(raw.guess, 60));
    add('其他', clip(raw.other, 100));
    if (lines.length <= 1 && !secs.length) return null;          // 只剩个「类型」= 等于没听
    return { kind, text: lines.join('\n') };
}

// 两个模型都 503 的情况实测很常见（2026-10-08 晚上五发里撞了两次，隔十几秒再发就好）。
// 她这边是点了发送在干等，所以整条链退光了、而且是「正忙」时，歇几秒再从头来一轮。别的错不重试。
const BUSY_RETRY_MS = 4000;
const isBusy = msg => /正忙|503|high demand|overloaded/i.test(String(msg || ''));

function mount(app, deps) {
    const { outboundAgent } = deps || {};
    const once = (deps && deps.geminiOnce) || geminiOnce;          // 测试注入用
    const retryMs = deps && deps.retryMs != null ? deps.retryMs : BUSY_RETRY_MS;
    if (!app || typeof outboundAgent !== 'function') throw new Error('audio-listen.mount: 缺依赖（app/outboundAgent）');
    let day = '', dayCount = 0;
    app.post('/api/audio/listen', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES + 64 * 1024 }), async (req, res) => {
        const key = String(process.env.GEMINI_API_KEY || '').trim();
        if (!key) return res.status(503).json({ error: 'Gemini 还没有 API key（.env 里加 GEMINI_API_KEY=…）' });
        const buf = Buffer.isBuffer(req.body) ? req.body : null;
        if (!buf || buf.length < 1024) return res.status(400).json({ error: '没收到音频' });
        const mime = geminiMime(req.headers['content-type']);
        if (!mime) return res.status(415).json({ error: `Gemini 不认这个格式（${String(req.headers['content-type'] || '空').split(';')[0]}）` });
        const today = new Date().toISOString().slice(0, 10);
        if (day !== today) { day = today; dayCount = 0; }
        if (dayCount >= MAX_PER_DAY) return res.status(429).json({ error: `今天已经听过 ${MAX_PER_DAY} 段了，明天再听` });
        dayCount++;
        const name = String(req.query.name || '').slice(0, 120);
        const dur = Number(req.query.dur) || 0;
        const t0 = Date.now();
        try {
            const ask = () => once({
                key, agentFor: () => geminiAgent(outboundAgent), timeout: 180000,
                parts: [{ inline_data: { mime_type: mime, data: buf.toString('base64') } },
                        { text: buildListenPrompt({ name, dur, cut: req.query.cut === '1' }) }],
            });
            let r;
            try { r = await ask(); }
            catch (e) {
                if (!isBusy(e.message)) throw e;
                console.warn(`[听音频] 「${name}」Gemini 正忙，${retryMs / 1000}s 后再试一轮`);
                await new Promise(ok => setTimeout(ok, retryMs));
                r = await ask();
            }
            const out = formatListen(parseJsonLoose(r.text), dur);
            if (!out) throw new Error('Gemini 听完了，但写回来的东西解不出来');
            console.log(`[听音频] 「${name}」${out.kind} ${r.model} ${Math.round((Date.now() - t0) / 1000)}s ${Math.round(buf.length / 1024)}KB 进 ${r.usage && r.usage.promptTokenCount || '?'} token`);
            res.json({ text: out.text, kind: out.kind, model: r.model });
        } catch (e) {
            console.warn(`[听音频] 「${name}」没听成：${e.message}`);
            res.status(502).json({ error: e.message });
        }
    });
}

module.exports = { mount, geminiMime, buildListenPrompt, formatListen, MAX_AUDIO_BYTES, GEMINI_MIMES };
