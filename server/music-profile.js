// server/music-profile.js
// 「真的听过这首歌」：一首歌第一次一起听时，把整首音频交给 Gemini 听一遍，写一份歌曲档案
// （分段带时间点、情绪走向、乐器、人声、歌词大意），按网易云歌曲 id 存盘，下次不重听。
// 放这首歌期间她说过的关于这首歌的话，换歌时摘一两句存进同一份档案（memos），
// 下次再放同一首，AI 看档案时会带着这些回忆。思路来自 Duetto（avisforevelyn/Duetto）。
//
// 前端（js/24-music.js 的 musicProfile*）只在「歌在放、她又在聊天」时才叫这里分析——
// 后台随便放着、或者歌单里没一起听过的歌，一律不跑。这边再兜一道每日上限，防前端哪天写坏了狂刷。
//
// GET  /api/music/profile?id=123                       → { profile, memos, pending, error? }（只读盘，不分析）
// POST /api/music/profile        {id,name,artist,dur}  → 同上；没档案就当场听（等它听完再回，30~70 秒）
// POST /api/music/profile/memo   {id,name,artist,lines:[{who:'她'|'它',text}]} → { memos, added }
//
// ⚠️ 三个坑，都是实测撞出来的：
//   ① 音频**必须直连**拿（网易云对境外 IP 不给地址，见 server/music.js 文件头 ①），
//      而 Gemini **必须走代理**（geminiAgent，同 server/gemini.js）。两条腿各走各的。
//   ② 时间点别让模型写秒数：2026-10-03 第一发它把「4:04」写成 404 秒，整份时间轴超出歌长。
//      让它写 "m:ss" 字符串、再在这里解析，同一首歌第二发就全对了。normalizeProfile 再夹一道歌长。
//   ③ gemini-3.8-flash 高峰期 503 很常见（同一分钟 3.6-flash 正常）—— 按 MODELS 顺序往下退，
//      只有 503/429/404/5xx 才退，地区被拒/key 坏了换模型也没用，直接报。
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { explainError, geminiAgent } = require('./gemini');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 可以用 .env 的 GEMINI_MUSIC_MODEL 指定一个（逗号隔开多个），不填按这个顺序退
// 2026-10-08 拿掉了 gemini-2.5-flash：Google 不再对新用户开放，退到它只会多等一轮、再拿一句「不开放了」回来
const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];
// inline 请求整包上限 20MB，base64 胀 4/3 —— 原始音频留 14MB（128k 的 mp3 ≈ 14 分钟）
const MAX_AUDIO_BYTES = 14 * 1024 * 1024;
// 一首约 7k token（音频按 32 token/秒算，4 分钟 ≈ 6.6k + 提示词），一天 40 首到顶也就 30 万 token
const MAX_PER_DAY = 40;
// 失败了别每轮重试（每轮聊天都会 ensure 一次）：同一首 10 分钟内直接回上次的错
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const MEMO_MAX = 8;          // 一首歌最多留几句她说过的话（新的挤掉旧的）
const LABELS = ['前奏', '主歌', '预副歌', '副歌', '间奏', '桥段', '尾奏', '独白', '器乐段'];

// "1:05" / "01:05" / "1:02:03" / 65 → 秒；认不出来回 NaN
function parseMmss(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : NaN;
    const s = String(v == null ? '' : v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return +s;
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (!m) return NaN;
    const sec = +m[3];
    if (sec >= 60) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + sec;
}

const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
};

// 模型吐出来的 JSON → 干净的档案。时间一律转成整数秒、夹进 [0, dur]，
// 段落按开始时间排好、end 补成下一段的 start（模型常常漏写或者两段重叠）。
// dur 不知道（0）时只做排序和去负数，不夹上限。
function normalizeProfile(raw, dur) {
    if (!raw || typeof raw !== 'object') return null;
    const D = Number(dur) > 0 ? Math.round(Number(dur)) : 0;
    const cap = t => D ? Math.min(D, t) : t;
    let secs = [];
    for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
        if (!s || typeof s !== 'object') continue;
        const st = parseMmss(s.start);
        if (!Number.isFinite(st)) continue;
        if (D && st >= D) continue;                              // 整段落在歌外面 = 时间轴写错了，丢
        const label = clip(s.label, 8) || '段落';
        secs.push({ start: Math.round(cap(st)), end: parseMmss(s.end), label, note: clip(s.note, 60) });
    }
    secs.sort((a, b) => a.start - b.start);
    // 同一秒起两段的，留第一段
    secs = secs.filter((s, i) => i === 0 || s.start !== secs[i - 1].start);
    for (let i = 0; i < secs.length; i++) {
        const next = secs[i + 1];
        let end = Number.isFinite(secs[i].end) ? Math.round(cap(secs[i].end)) : NaN;
        if (next) end = next.start;                              // 和下一段对齐，别留缝也别重叠
        else if (!Number.isFinite(end) || end <= secs[i].start) end = D || secs[i].start;
        secs[i].end = end;
    }
    const pk = raw.peak && typeof raw.peak === 'object' ? raw.peak : null;
    const pt = pk ? parseMmss(pk.t) : NaN;
    const out = {
        summary: clip(raw.summary, 60),
        mood: clip(raw.mood, 120),
        instruments: (Array.isArray(raw.instruments) ? raw.instruments : []).map(x => clip(x, 16)).filter(Boolean).slice(0, 8),
        vocal: clip(raw.vocal, 60),
        lyricGist: clip(raw.lyricGist, 140),
        sections: secs.slice(0, 24),
        peak: pk && Number.isFinite(pt) && (!D || pt <= D) ? { t: Math.round(pt), note: clip(pk.note, 60) } : null,
    };
    // 什么都没听出来（全空）就当失败，别存一份空档案把这首歌永久占住
    if (!out.summary && !out.mood && !out.sections.length) return null;
    return out;
}

const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function buildAnalyzePrompt({ name, artist, dur }) {
    const D = Number(dur) > 0 ? fmt(Number(dur)) : '';
    return `这是《${clip(name, 60) || '未知'}》（${clip(artist, 60) || '未知歌手'}）的完整音频。请认真从头听到尾，写一份中文的「歌曲档案」，给另一个听不见声音、但要陪人一起听这首歌的 AI 用。

只写你在音频里真的听到的东西；听不出来的就留空，不要凭歌名去编。时间点一律写成 "分:秒" 字符串（如 "1:05"），以音频开头为 0:00${D ? `；整首长 ${D}，别超出` : ''}。

输出 JSON：
{
  "summary": "一句话说这首歌听起来是什么样的（≤40字）",
  "mood": "情绪从头到尾怎么走的（≤80字）",
  "instruments": ["主要乐器/音色，3~8 个"],
  "vocal": "人声：几个人、男女、唱法和质感（纯音乐写空串）",
  "lyricGist": "歌词大意，用自己的话概括，不要大段照抄原词（≤100字；纯音乐写空串）",
  "sections": [
    { "start": "0:00", "end": "0:18", "label": "前奏", "note": "这一段在发生什么：配器、力度、情绪，有人声就说唱的是什么内容（≤50字）" }
  ],
  "peak": { "t": "0:00", "note": "整首最抓人的那一刻（≤40字）" }
}
sections 按时间顺序覆盖整首，label 用：${LABELS.join(' / ')}（同类第二次出现写「主歌2」「副歌2」）。`;
}

// 放这首歌期间的聊天 → 她说过的、值得下次放这首时记起来的话
function buildMemoPrompt({ name, artist, lines }) {
    const talk = lines.map(l => `${l.who === '她' ? '她' : '对方'}：${l.text}`).join('\n');
    return `下面是一段聊天记录，聊的时候正在放《${clip(name, 60)}》（${clip(artist, 60)}）。「她」是听歌的人，「对方」是陪她听歌的 AI。

${talk}

从里面挑出**她**说过的、和这首歌有关的话（对这首歌的感受、想起了什么、喜欢哪一段、这首歌对她意味着什么），
下次再放这首歌时，对方要靠这些记起「上次一起听时她说过什么」。
- 最多 2 条，每条 ≤40 字，用第三人称转述（「她说副歌那句让她想起毕业那年的夏天」），可以保留她的原话片段。
- 只要她说的，不要对方说的；和这首歌无关的闲聊不要。
- 一条都没有就返回空数组，别硬凑。

输出 JSON：{ "memos": ["…"] }`;
}

function normalizeMemos(raw) {
    const arr = raw && Array.isArray(raw.memos) ? raw.memos : Array.isArray(raw) ? raw : [];
    return arr.map(x => clip(typeof x === 'string' ? x : x && x.text, 60)).filter(Boolean).slice(0, 2);
}

// 模型偶尔会在 JSON 外面包一层 ```json …```（哪怕给了 responseMimeType），剥掉再解
function parseJsonLoose(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(s); } catch { /* 往下找第一个 { 到最后一个 } */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 真解不出来 */ } }
    return null;
}

// 照聊天里的乱七八糟消毒一遍：只收 {who,text}，条数和长度都封顶
function cleanLines(lines) {
    return (Array.isArray(lines) ? lines : [])
        .filter(l => l && typeof l.text === 'string' && l.text.trim())
        .slice(-40)
        .map(l => ({ who: l.who === '她' ? '她' : '它', text: clip(l.text, 300) }));
}

// 存储：一首歌一个 JSON。id 只认纯数字（网易云 id），挡死路径穿越。
function createStore(dir) {
    const file = id => path.join(dir, `${id}.json`);
    const okId = id => /^\d{1,20}$/.test(String(id));
    return {
        okId,
        get(id) {
            if (!okId(id)) return null;
            try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
        },
        put(id, rec) {
            if (!okId(id)) throw new Error('id 不合法');
            fs.mkdirSync(dir, { recursive: true });
            const tmp = file(id) + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(rec, null, 1), 'utf8');
            fs.renameSync(tmp, file(id));                         // 先写临时文件再改名：写一半断电不留半截 JSON
        },
    };
}

// 歌曲档案要落在可写目录：exe 打包后 ROOT 可能指进只读 asar（同 coread.db / nursery-saves 的判法）
function profileDir(ROOT) {
    if (process.env.GRANCYAN_MUSIC_PROFILE_DIR) return process.env.GRANCYAN_MUSIC_PROFILE_DIR;
    const ok = ROOT && fs.existsSync(ROOT) && fs.statSync(ROOT).isDirectory() && !ROOT.includes('.asar');
    return ok ? path.join(ROOT, 'music-profiles') : path.join(os.homedir(), '.grancyan', 'music-profiles');
}

function modelChain() {
    const env = String(process.env.GEMINI_MUSIC_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
    return env.length ? env : MODELS;
}

// 一次非流式 generateContent，按模型链往下退。返回 { text, model, usage } 或抛带人话的 Error。
// post 可注入（测试用），默认 axios.post。
// 全退光了报**第一个**模型的错：链尾的模型错法往往是「这个模型没有/不开放」，
// 报它会把真正的原因（第一个模型 503 高峰）盖掉——2026-10-08 就这么被带偏过一次。
async function geminiOnce({ key, parts, agentFor, post, timeout }) {
    const doPost = post || axios.post;
    let firstErr = '';
    const note = e => { if (!firstErr) firstErr = e; };
    for (const model of modelChain()) {
        const lane = await agentFor();
        let r;
        try {
            r = await doPost(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
                contents: [{ role: 'user', parts }],
                generationConfig: { responseMimeType: 'application/json', thinkingConfig: { includeThoughts: false } },
            }, {
                headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
                httpsAgent: lane.agent, proxy: false, timeout: timeout || 180000,
                validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity,
            });
        } catch (e) {
            note('Gemini 连接失败：' + e.message);
            continue;                                             // 网络抖一下，换下一个模型再试一次
        }
        if (r.status === 200) {
            const cand = (r.data && r.data.candidates || [])[0];
            const text = ((cand && cand.content && cand.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
            if (text) return { text, model, usage: r.data.usageMetadata || null };
            note(`Gemini（${model}）没给正文${cand && cand.finishReason ? `（finishReason=${cand.finishReason}）` : ''}`);
            continue;
        }
        const raw = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
        note(explainError(r.status, raw, model, false, lane.viaLane));
        if (!(r.status === 503 || r.status === 429 || r.status === 404 || r.status >= 500)) break;   // 地区/key 的错换模型没用
    }
    throw new Error(firstErr || 'Gemini 没有可用的模型');
}

function mount(app, deps) {
    const { ROOT, agent, outboundAgent, songUrl } = deps || {};
    if (!app || !agent || typeof outboundAgent !== 'function' || typeof songUrl !== 'function') {
        throw new Error('music-profile.mount: 缺依赖（app/agent/outboundAgent/songUrl）—— 装配层漏传了');
    }
    const store = createStore(profileDir(ROOT));
    const inflight = new Map();          // id → Promise（同一首同时只听一遍）
    const failed = new Map();            // id → { at, error }
    let day = '', dayCount = 0;
    const getKey = () => String(process.env.GEMINI_API_KEY || '').trim();
    const agentFor = () => geminiAgent(outboundAgent);

    const view = (id, extra) => {
        const rec = store.get(id);
        return { profile: rec && rec.profile || null, memos: rec && rec.memos || [], name: rec && rec.name || '', ...extra };
    };

    async function analyze(id, name, artist, dur) {
        const key = getKey();
        if (!key) throw new Error('Gemini 还没有 API key（.env 里加 GEMINI_API_KEY=…）');
        const today = new Date().toISOString().slice(0, 10);
        if (day !== today) { day = today; dayCount = 0; }
        if (dayCount >= MAX_PER_DAY) throw new Error(`今天已经整首听过 ${MAX_PER_DAY} 首了，明天再听新的`);
        const url = await songUrl(id);
        if (!url) throw new Error('这首歌在网易云没有可播放的版本，拿不到音频');
        // 直连网易云 CDN（不走代理，见文件头 ①）。Range 封顶，太长的歌只听前 14MB
        const a = await axios.get(url, {
            responseType: 'arraybuffer', httpsAgent: agent, proxy: false, timeout: 60000,
            headers: { Range: `bytes=0-${MAX_AUDIO_BYTES - 1}`, Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
        });
        const buf = Buffer.from(a.data);
        if (buf.length < 50 * 1024) throw new Error('拿到的音频太短，不像一首歌');
        const mime = /audio\/[\w.+-]+/.exec(String(a.headers['content-type'] || ''))?.[0] || 'audio/mpeg';
        dayCount++;
        const t0 = Date.now();
        const r = await geminiOnce({
            key, agentFor,
            parts: [{ inline_data: { mime_type: mime, data: buf.toString('base64') } }, { text: buildAnalyzePrompt({ name, artist, dur }) }],
        });
        const profile = normalizeProfile(parseJsonLoose(r.text), dur);
        if (!profile) throw new Error('Gemini 听完了，但写回来的档案解不出来');
        const old = store.get(id);
        store.put(id, {
            id: String(id), name: clip(name, 80), artist: clip(artist, 80), dur: Math.round(+dur || 0),
            model: r.model, at: Date.now(), profile, memos: old && old.memos || [],
        });
        console.log(`[听歌·档案] 《${name}》 ${r.model} ${Math.round((Date.now() - t0) / 1000)}s 音频 ${Math.round(buf.length / 1024)}KB 进 ${r.usage && r.usage.promptTokenCount || '?'} token`);
        return profile;
    }

    app.get('/api/music/profile', (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!store.okId(id)) return res.status(400).json({ error: 'id 不合法' });
        const f = failed.get(id);
        res.json(view(id, { pending: inflight.has(id), ...(f && Date.now() - f.at < FAIL_COOLDOWN_MS ? { error: f.error } : {}) }));
    });

    app.post('/api/music/profile', async (req, res) => {
        const { id: rawId, name, artist, dur } = req.body || {};
        const id = String(rawId || '').trim();
        if (!store.okId(id)) return res.status(400).json({ error: 'id 不合法' });
        const rec = store.get(id);
        if (rec && rec.profile) return res.json(view(id, { pending: false }));
        const f = failed.get(id);
        if (f && Date.now() - f.at < FAIL_COOLDOWN_MS) return res.json(view(id, { pending: false, error: f.error }));
        let p = inflight.get(id);
        if (!p) {
            p = analyze(id, String(name || ''), String(artist || ''), Number(dur) || 0)
                .then(() => { failed.delete(id); })
                .catch(e => {
                    failed.set(id, { at: Date.now(), error: e.message });
                    console.warn(`[听歌·档案] 《${name}》没听成：${e.message}`);
                })
                .finally(() => inflight.delete(id));
            inflight.set(id, p);
        }
        await p;
        const f2 = failed.get(id);
        res.json(view(id, { pending: false, ...(f2 ? { error: f2.error } : {}) }));
    });

    app.post('/api/music/profile/memo', async (req, res) => {
        const { id: rawId, name, artist } = req.body || {};
        const id = String(rawId || '').trim();
        if (!store.okId(id)) return res.status(400).json({ error: 'id 不合法' });
        const lines = cleanLines(req.body && req.body.lines);
        // 她一句话都没说 → 没什么可记的，不花这次调用
        if (!lines.some(l => l.who === '她')) return res.json({ memos: (store.get(id) || {}).memos || [], added: 0 });
        const key = getKey();
        if (!key) return res.status(503).json({ error: 'Gemini 还没有 API key' });
        try {
            const r = await geminiOnce({ key, agentFor, timeout: 60000, parts: [{ text: buildMemoPrompt({ name, artist, lines }) }] });
            const fresh = normalizeMemos(parseJsonLoose(r.text));
            const rec = store.get(id) || { id, name: clip(name, 80), artist: clip(artist, 80), dur: 0, profile: null, memos: [] };
            const have = new Set((rec.memos || []).map(m => m.text));
            const add = fresh.filter(t => !have.has(t)).map(text => ({ at: Date.now(), text }));
            rec.memos = [...(rec.memos || []), ...add].slice(-MEMO_MAX);
            if (add.length) store.put(id, rec);
            res.json({ memos: rec.memos, added: add.length });
        } catch (e) {
            console.warn('[听歌·回忆] 没摘成：', e.message);
            res.status(502).json({ error: e.message });
        }
    });
}

module.exports = {
    mount, parseMmss, normalizeProfile, normalizeMemos, buildAnalyzePrompt, buildMemoPrompt,
    parseJsonLoose, cleanLines, createStore, geminiOnce, MODELS, MAX_PER_DAY, MEMO_MAX,
};
