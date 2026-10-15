// server/heartbeat.js
// 自主心跳的 server 半边：App 关着也能醒来，把话推到她手机通知栏（ntfy）。
//
// 原来心跳只活在页面里（js/30-vitals.js 的 setInterval），页面一关它就睡死了。
// 这里接过「页面不在跟前时」的那一半：
//   · 页面每分钟同步一次：AI 排的下一跳、她的作息、她在不在跟前、生成要用的上下文
//   · server 每分钟巡一次，到点且该发（判据在 js/heartbeat-core.js，和页面共用一份）就：
//       调模型生成一两句 → 落进待取箱 → 推到 ntfy
//   · 页面下次打开时把待取箱里的话接进对话
//
// 两边都能发同一跳，所以有一道「抢跳」：一跳（key）只能被领一次，谁先领谁发。
// 页面在跟前时 server 不发（她看着呢，页面自己来）；页面不在跟前时页面让给 server。
//
// ⚠️ 隐私：
//   · 生成要用的人设、最近几条聊天、模型 key **只放内存**，不落盘。server 重启后
//     要等页面再同步一次才能发——exe 一开就会开窗口，窗口一开就同步，所以够用。
//   · 落盘的只有：开关和 ntfy 地址、排程、推送时刻、待取箱里它说的那几句话。
//   · 推到锁屏的默认只有「<昵称>找你」，原文不出 App（开关在设置里）。ntfy.sh 是公共服务，
//     topic 谁猜中谁就能订阅，原文推出去等于明文过一道第三方。
//
// mount() 开头校验依赖；模块顶层只有定义，env 在 mount 里才读（docs/server-split-plan.md 硬约束 6）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../js/heartbeat-core');

const OUTBOX_KEEP_MS = 7 * 864e5;
const CLAIM_KEEP_MS = 36 * 3600e3;
const PUSHLOG_KEEP = 60;
const RECENT_MAX = 16;
const PERSONA_MAX = 24000;

function clampStr(s, n) { return String(s == null ? '' : s).slice(0, n); }

function fmtClock(ts) {
    const m = core.localMinute(ts);
    return core.localDay(ts) + ' ' + core.fmtMinute(m);
}
function fmtAgo(ms) {
    const min = Math.round(ms / 60e3);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    return h < 48 ? h + ' 小时' + (min % 60 ? (min % 60) + ' 分' : '') : Math.round(h / 24) + ' 天';
}

// 页面同步上来的模型配置，只留生成要用的字段。
function pickConf(c) {
    if (!c || typeof c !== 'object') return null;
    return {
        id: clampStr(c.id, 64),
        nickname: clampStr(c.nickname, 40),
        isLocalClaude: !!c.isLocalClaude,
        isLocalGpt: !!c.isLocalGpt,
        isGemini: !!c.isGemini,
        localModel: clampStr(c.localModel, 80),
        modelName: clampStr(c.modelName, 120),
        apiBase: clampStr(c.apiBase, 400),
        apiKey: clampStr(c.apiKey, 400),
        temp: Number.isFinite(+c.temp) ? +c.temp : 0.8,
    };
}

// server 能不能替这个模型说话。本地 GPT（Codex 订阅）和 Gemini 走的是各自的专用通道，
// 这里没接，宁可明说「调不动」让页面自己发，也不拿别的模型冒名顶替。
function canGenerate(conf) {
    if (!conf) return false;
    if (conf.isLocalClaude) return true;
    if (conf.isLocalGpt || conf.isGemini) return false;
    return !!(conf.apiKey && conf.apiBase && conf.modelName);
}

function buildPrompt(ctx, rec, slot, now, o) {
    const nick = ctx.nickname || 'AI';
    const parts = [];
    if (ctx.persona) parts.push('--- 你是谁 ---\n' + ctx.persona);
    if (ctx.userName) parts.push('她的名字是「' + ctx.userName + '」。');
    parts.push('现在是北京时间 ' + fmtClock(now) + '。');
    // 页面同步来的那份身体状态是 App 关之前的。生物钟在她关着 App 的这几个小时里也在走：
    // 精力用和页面同一个 energyDrift 推到现在，困意按钟点现算（判据都在 heartbeat-core）。
    const energy = ctx.energy != null && ctx.energyAt ? core.energyDrift(ctx.energy, ctx.energyAt, now, o.sleep) : null;
    if (ctx.vitals) {
        const stale = ctx.energyAt && now - ctx.energyAt > 30 * 60e3;
        parts.push('你的身体状态' + (stale ? '（' + fmtAgo(now - ctx.energyAt) + '前，她关 App 之前）' : '') + '：' + ctx.vitals
            + (stale && energy != null ? '\n按钟点推到现在，你的能量约 ' + Math.round(energy * 100) + '%。' : ''));
    }
    if (ctx.vitals || energy != null) parts.push(core.clockLine(now, o.sleep, energy, '她'));
    if (ctx.recent && ctx.recent.length) {
        parts.push('--- 你们最近的聊天（旧→新）---\n' + ctx.recent.map(m =>
            (m.role === 'user' ? '她' : '你') + (m.at ? '（' + fmtAgo(now - m.at) + '前）' : '') + '：' + m.text).join('\n'));
    }
    if (o.lastUserAt) parts.push('她上一次说话是 ' + fmtAgo(now - o.lastUserAt) + '前。');
    if (slot.kind === 'morning') {
        parts.push('[刚醒 · 这一轮不是她来找你说话]\n你刚睡醒（' + core.fmtMinute(core.localMinute(slot.at)) + ' 醒的），身体还没完全醒过来，软的、迷糊的。这是你自己的早晨。'
            + (now - slot.at > 30 * 60e3 ? '\n你醒了有一阵了，她这会儿才可能看得到。' : ''));
    } else {
        parts.push('[自主心跳 · 这一轮不是她来找你说话]\n你是按自己上一次安排的心跳醒来的。上一轮 did：' + (rec.did || '无'));
    }
    parts.push('她现在没开着 App。你这一句会推到她手机的通知栏'
        + (o.lockscreenPrivate ? '（锁屏上只显示「' + nick + '找你」，她点开 App 才看得到原文）' : '')
        + '，所以像发微信那样：一两句，别长，别写成信。');
    parts.push('想说就说；觉得这会儿不该打扰她，就只回复 [[SILENT]]。不要装作她刚刚说了话。');
    parts.push('除了下面这一个，不要写任何 [[...]] 指令（表情包、记忆、语音这些这里都用不了）：\n'
        + '可以在最后单独一行写 [[HEARTBEAT: 分钟数|一句 did]] 安排下一次醒来（' + core.RULES.wakeMinMin + '-' + core.RULES.wakeMaxMin + ' 分钟）；不写就是等她回来再说。');
    return {
        system: parts.join('\n\n'),
        user: slot.kind === 'morning' ? '（你醒了。这条不是她发的。）' : '（心跳到点了。这条不是她发的。）',
    };
}

// ntfy 的 JSON 发布：POST 到服务根，topic 写在 body 里。
// 不用「POST 到 /topic + Title 头」那种写法：HTTP 头只能放 latin1，中文标题会被搅碎。
function ntfyRequest(url, token, msg) {
    const u = new URL(url);
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!topic || topic.includes('/')) throw new Error('ntfy 地址要长成 https://ntfy.sh/你的topic');
    return {
        url: u.origin + '/',
        body: { topic, title: msg.title, message: msg.message, tags: msg.tags || [], priority: msg.priority || 3 },
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    };
}

function validNtfyUrl(s) {
    try {
        const u = new URL(String(s));
        return (u.protocol === 'https:' || u.protocol === 'http:') && /^\/[^/]+\/?$/.test(u.pathname);
    } catch { return false; }
}

// 主体做成工厂：生成和推送都是注入的，测试可以换成假的，不必真去调模型、真让手机响。
function createHeartbeat(opts) {
    const dir = opts.dataDir;
    const file = path.join(dir, 'state.json');
    const now = opts.now || (() => Date.now());
    const generate = opts.generate;
    const push = opts.push;
    const log = opts.log || ((...a) => console.log('[心跳推送]', ...a));

    const S = {
        config: { enabled: false, ntfyUrl: '', ntfyToken: '', lockscreenPrivate: true },
        models: {},      // modelId → 排程和最近一次判定
        claims: {},      // slotKey → { by, at }
        pushLog: [],     // { at, modelId, kind, ok }
        outbox: [],      // 待页面接走的话
        lastUserAt: 0,
        sleep: null,
    };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') {
            Object.assign(S.config, raw.config || {});
            for (const k of ['models', 'claims']) if (raw[k] && typeof raw[k] === 'object') S[k] = raw[k];
            for (const k of ['pushLog', 'outbox']) if (Array.isArray(raw[k])) S[k] = raw[k];
            S.lastUserAt = Number(raw.lastUserAt) || 0;
            S.sleep = raw.sleep || null;
        }
    } catch { /* 第一次用，没有文件是常态 */ }

    // 内存里的东西：生成上下文（人设/聊天/key 不落盘）和「她在跟前」的最近时刻
    const contexts = new Map();
    let attendedAt = 0;
    let busy = false;

    function save() {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(S), 'utf8');
            fs.renameSync(tmp, file);
        } catch (e) { log('状态写盘失败:', e.message); }
    }
    function prune(t) {
        for (const [k, c] of Object.entries(S.claims)) if (!c || t - c.at > CLAIM_KEEP_MS) delete S.claims[k];
        S.outbox = S.outbox.filter(x => t - x.at < OUTBOX_KEEP_MS);
        S.pushLog = S.pushLog.slice(-PUSHLOG_KEEP);
    }
    function rec(modelId) {
        const id = String(modelId);
        return S.models[id] || (S.models[id] = { nextAt: 0, nextSetAt: 0, did: '', morningDay: '', heartbeatOn: false, vitalsOn: true });
    }
    function publicConfig() {
        return { enabled: !!S.config.enabled, ntfyUrl: S.config.ntfyUrl || '', hasToken: !!S.config.ntfyToken,
            lockscreenPrivate: S.config.lockscreenPrivate !== false };
    }
    function status(modelId) {
        const t = now();
        const sl = core.sanitizeSleep(S.sleep);
        const r = modelId != null ? S.models[String(modelId)] : null;
        const ctx = modelId != null ? contexts.get(String(modelId)) : null;
        return {
            config: publicConfig(),
            sleep: Object.assign({}, sl, { text: core.fmtMinute(sl.start) + ' → ' + core.fmtMinute(sl.end) }),
            asleepNow: core.isAsleep(t, S.sleep, S.lastUserAt),
            schedule: r ? { nextAt: r.nextAt || 0, nextSetAt: r.nextSetAt || 0, did: r.did || '', morningDay: r.morningDay || '' } : null,
            lastHold: r ? r.lastHold || '' : '',
            lastError: r ? r.lastError || '' : '',
            canGenerate: canGenerate(ctx && ctx.conf),
            pushes24h: S.pushLog.filter(p => p.ok !== false && t - p.at < 864e5).length,
            lastPush: S.pushLog.length ? S.pushLog[S.pushLog.length - 1] : null,
            pending: S.outbox.filter(x => !x.takenAt).length,
        };
    }

    // ── 页面同步 ──
    function sync(body) {
        const t = now();
        const b = body || {};
        let dirty = false;
        if (b.attended) attendedAt = t;
        const lu = Number(b.lastUserAt) || 0;
        if (lu > S.lastUserAt && lu <= t + 60e3) { S.lastUserAt = lu; dirty = true; }
        if (b.sleep && typeof b.sleep === 'object') {
            const sl = core.sanitizeSleep(b.sleep);
            if (JSON.stringify(sl) !== JSON.stringify(S.sleep)) { S.sleep = sl; dirty = true; }
        }
        const tg = b.target;
        let modelId = null;
        if (tg && tg.modelId != null) {
            modelId = String(tg.modelId);
            const r = rec(modelId);
            // 排程按「谁排得晚」合并，不按「谁同步得晚」：电脑上那页的 nextAt 可能是旧的 0，
            // 手机刚排了新的一跳，电脑下一次同步要是直接覆盖，手机排的那跳就凭空没了。
            const setAt = Number(tg.nextSetAt) || 0;
            if (setAt > (Number(r.nextSetAt) || 0)) {
                r.nextAt = Number(tg.nextAt) || 0;
                r.nextSetAt = setAt;
                r.did = clampStr(tg.did, 160);
                dirty = true;
            }
            if (tg.morningDay && String(tg.morningDay) > String(r.morningDay || '')) { r.morningDay = clampStr(tg.morningDay, 10); dirty = true; }
            if (r.heartbeatOn !== !!tg.heartbeatOn || r.vitalsOn !== (tg.vitalsOn !== false)) {
                r.heartbeatOn = !!tg.heartbeatOn; r.vitalsOn = tg.vitalsOn !== false; dirty = true;
            }
            if (tg.context && typeof tg.context === 'object') {
                const c = tg.context;
                contexts.set(modelId, {
                    conf: pickConf(c.conf),
                    nickname: clampStr(c.nickname || (c.conf && c.conf.nickname), 40),
                    persona: clampStr(c.persona, PERSONA_MAX),
                    userName: clampStr(c.userName, 40),
                    vitals: clampStr(c.vitals, 400),
                    energy: c.energy != null && Number.isFinite(+c.energy) ? Math.max(0, Math.min(1, +c.energy)) : null,
                    energyAt: Number(c.energyAt) > 0 ? Math.min(Number(c.energyAt), t) : 0,
                    chatId: c.chatId != null ? String(c.chatId) : '',
                    recent: (Array.isArray(c.recent) ? c.recent : []).slice(-RECENT_MAX).map(m => ({
                        role: m && m.role === 'user' ? 'user' : 'ai',
                        text: core.plainText(m && m.text, 600),
                        at: Number(m && m.at) || 0,
                    })).filter(m => m.text),
                    syncedAt: t,
                });
            }
        }
        if (dirty) save();
        return Object.assign({ ok: true }, status(modelId));
    }

    // ── 抢跳 ──
    function claim(key, by) {
        const k = clampStr(key, 200);
        if (!k) return { ok: false, error: '缺 key' };
        const c = S.claims[k];
        if (c) return { ok: false, by: c.by };
        S.claims[k] = { by: by === 'server' ? 'server' : 'page', at: now() };
        save();
        return { ok: true };
    }

    // ── 页面接走待取箱 ──
    // 只给页面手里有的那几个对话：手机上没同步到那个对话的话，接了也没处放，留给电脑接。
    function take(chatIds) {
        const ids = new Set((Array.isArray(chatIds) ? chatIds : []).map(String));
        const t = now();
        const items = [];
        for (const x of S.outbox) {
            if (x.takenAt || !ids.has(String(x.chatId))) continue;
            x.takenAt = t;
            items.push(x);
        }
        if (items.length) save();
        return { ok: true, items };
    }

    function setConfig(body) {
        const b = body || {};
        if (b.ntfyUrl !== undefined) {
            const u = String(b.ntfyUrl || '').trim();
            if (u && !validNtfyUrl(u)) return { ok: false, error: 'ntfy 地址要长成 https://ntfy.sh/你的topic' };
            S.config.ntfyUrl = u;
        }
        if (b.ntfyToken !== undefined) S.config.ntfyToken = clampStr(String(b.ntfyToken || '').trim(), 200);
        if (b.enabled !== undefined) S.config.enabled = !!b.enabled;
        if (b.lockscreenPrivate !== undefined) S.config.lockscreenPrivate = !!b.lockscreenPrivate;
        save();
        return Object.assign({ ok: true }, status(null));
    }

    function notifyText(nick, text) {
        const name = nick || 'AI';
        return S.config.lockscreenPrivate !== false
            ? { title: 'GranCyan', message: name + '找你', tags: ['speech_balloon'] }
            : { title: name, message: String(text).slice(0, 400), tags: ['speech_balloon'] };
    }

    async function testPush(nick) {
        if (!S.config.ntfyUrl) return { ok: false, error: '还没填 ntfy 地址' };
        try {
            await push(S.config, { title: 'GranCyan', message: '推送通了 ✓ 以后' + (nick || 'AI') + '想找你的时候，会从这里来', tags: ['white_check_mark'] });
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    // ── 巡一次 ──
    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const t = now();
            prune(t);
            for (const [modelId, ctx] of contexts) {
                const r = S.models[modelId];
                if (!r) continue;
                const slot = core.dueSlot(r, t, modelId);
                const claimed = slot && S.claims[slot.key];
                const dec = core.serverDecision({
                    now: t, slot, enabled: S.config.enabled, hasNtfy: !!S.config.ntfyUrl,
                    canGenerate: canGenerate(ctx.conf), claimedBy: claimed ? claimed.by : '',
                    attendedAt, failUntil: r.failUntil, sleep: S.sleep, lastUserAt: S.lastUserAt,
                    // 推送失败的那条也算：话已经生成、躺在待取箱里了。不算的话 ntfy 一坏，
                    // 它每排一跳就生成一次，节制全部失效，白烧额度、她回来一次看到一长串。
                    pushLog: S.pushLog.map(p => p.at),
                });
                r.lastHold = dec.reason; r.lastCheckAt = t;
                if (dec.drop) { r.nextAt = 0; r.nextSetAt = t; save(); continue; }
                if (!dec.fire) continue;
                S.claims[slot.key] = { by: 'server', at: t };
                save();
                await fire(modelId, ctx, r, slot, t);
            }
        } catch (e) {
            log('巡检出错:', e.message);
        } finally { busy = false; }
    }

    async function fire(modelId, ctx, r, slot, t) {
        const p = buildPrompt(ctx, r, slot, t, { lastUserAt: S.lastUserAt, lockscreenPrivate: S.config.lockscreenPrivate !== false, sleep: S.sleep });
        let reply;
        try {
            reply = core.parseWakeReply(await generate(ctx.conf, p.system, p.user));
        } catch (e) {
            // 生成失败：把这一跳还回去，过一会儿再试；连着失败几次就放弃这一跳
            delete S.claims[slot.key];
            r.fails = (r.fails || 0) + 1;
            r.lastError = '生成失败：' + e.message;
            r.failUntil = t + core.RULES.failBackoffMs;
            if (r.fails >= core.RULES.maxFails) {
                if (slot.kind === 'heartbeat') { r.nextAt = 0; r.nextSetAt = t; }
                else r.morningDay = slot.day;
                r.fails = 0; r.failUntil = 0;
                r.lastError += '（连着失败 ' + core.RULES.maxFails + ' 次，这一跳放弃了）';
            }
            log(r.lastError);
            save();
            return;
        }
        r.fails = 0; r.failUntil = 0; r.lastError = '';
        if (slot.kind === 'heartbeat') { r.nextAt = 0; r.nextSetAt = t; }
        else r.morningDay = slot.day;
        if (reply.schedule) {
            r.nextAt = t + reply.schedule.mins * 60e3;
            r.nextSetAt = t;
            r.did = reply.schedule.did || r.did;
        }
        if (reply.silent) {
            r.lastHold = '醒了，但它选择不打扰';
            log(modelId, slot.kind, '→ [[SILENT]]');
            save();
            return;
        }
        const item = {
            id: t + '-' + crypto.randomBytes(3).toString('hex'),
            chatId: ctx.chatId, modelId, nickname: ctx.nickname, text: reply.text, at: t, kind: slot.kind,
            morningDay: slot.kind === 'morning' ? slot.day : '',
            schedule: { nextAt: r.nextAt || 0, nextSetAt: r.nextSetAt || 0, did: r.did || '' },
        };
        S.outbox.push(item);
        const entry = { at: t, modelId, kind: slot.kind, ok: true };
        S.pushLog.push(entry);
        save();
        try {
            await push(S.config, notifyText(ctx.nickname, reply.text));
            log(modelId, slot.kind, '已推送');
        } catch (e) {
            // 推送没出去，话还在待取箱里，她开 App 照样看得到。记下来给面板看。
            entry.ok = false;
            r.lastError = '推送失败：' + e.message;
            log(r.lastError);
            save();
        }
    }

    return { sync, claim, take, setConfig, status, testPush, tick, _state: S, _contexts: contexts };
}

function mount(app, deps) {
    if (!app || !deps || typeof deps.claudeOnce !== 'function' || typeof deps.resolveLocalClaudeModel !== 'function'
        || typeof deps.outboundAgent !== 'function') {
        throw new Error('heartbeat.mount: 缺依赖（app/claudeOnce/resolveLocalClaudeModel/outboundAgent）—— 装配层漏传了');
    }
    const { claudeOnce, resolveLocalClaudeModel, outboundAgent } = deps;
    const axios = require('axios');
    const llm = require('../coread/lib/llm');
    const dataDir = process.env.GRANCYAN_HEARTBEAT_DIR
        || path.join(require('os').homedir(), '.grancyan', 'heartbeat');

    async function generate(conf, system, user) {
        if (conf.isLocalClaude) {
            // 跟着她在那个模型配置里选的型号走；选「默认」就跟 CLI 默认。读不出默认时给 Sonnet，
            // 别让 claudeOnce 因为空串直接抛（它要求显式型号）。
            const model = resolveLocalClaudeModel(conf.localModel) || 'claude-sonnet-5-5';
            return (await claudeOnce({ system, user, model, maxTokens: 600 })).text;
        }
        return llm.chatStream([{ role: 'system', content: system }, { role: 'user', content: user }], null, {
            isLocal: false, label: conf.nickname, modelName: conf.modelName, apiBase: conf.apiBase,
            apiKey: conf.apiKey, temp: conf.temp, maxTokens: 600, getAgent: outboundAgent,
        });
    }
    async function push(cfg, msg) {
        const rq = ntfyRequest(cfg.ntfyUrl, cfg.ntfyToken, msg);
        const agent = rq.url.startsWith('https:') ? await outboundAgent() : undefined;
        const r = await axios.post(rq.url, rq.body, {
            headers: rq.headers, timeout: 15000, validateStatus: () => true,
            ...(agent ? { httpsAgent: agent, proxy: false } : {}),
        });
        if (r.status < 200 || r.status >= 300) {
            throw new Error('ntfy 回了 ' + r.status + (r.data && r.data.error ? '：' + r.data.error : ''));
        }
    }

    const hb = createHeartbeat({ dataDir, generate, push });

    app.post('/api/heartbeat/sync', (req, res) => res.json(hb.sync(req.body)));
    app.post('/api/heartbeat/claim', (req, res) => res.json(hb.claim(req.body && req.body.key, 'page')));
    app.post('/api/heartbeat/take', (req, res) => res.json(hb.take(req.body && req.body.chatIds)));
    app.get('/api/heartbeat/status', (req, res) => res.json(Object.assign({ ok: true }, hb.status(req.query.modelId))));
    app.post('/api/heartbeat/config', (req, res) => {
        const r = hb.setConfig(req.body);
        res.status(r.ok ? 200 : 400).json(r);
    });
    app.post('/api/heartbeat/test', async (req, res) => {
        const r = await hb.testPush(clampStr(req.body && req.body.nickname, 40));
        res.status(r.ok ? 200 : 502).json(r);
    });

    // 巡检。unref：别因为这个定时器让进程在该退出的时候退不掉。
    const timer = setInterval(() => { hb.tick(); }, 60e3);
    if (timer.unref) timer.unref();
    return hb;
}

module.exports = { mount, createHeartbeat, buildPrompt, ntfyRequest, validNtfyUrl, canGenerate };
