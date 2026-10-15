// server/gemini.js
// Gemini 直连 —— 会话栏上和「⚡本地Claude」「✨本地GPT」并排的第三个一键通道。
//
// 和那两个的**根本区别**：那两条走的是本机 CLI 子进程（蹭订阅额度），这条是纯 HTTP
// 直连 Google。由此带来三件必须知道的事，别拿本地 Claude 的经验套：
//   ① 没有会话续传。每轮全量重发历史 —— Gemini 不按会话缓存计费，重发不心疼。
//   ② 没有电脑操控/工具，也就不登记 agent run。流断了接不回来（和本地 GPT 纯聊天同档）。
//   ③ 必须过代理，而且**挑落地**：见 REGION_HINT。
//
// SSE 出口格式和 /api/local-claude 一模一样（delta / thinking / usage / notice / error / done），
// 所以前端那条读流的路整条复用，一个字节都没动。
const axios = require('axios');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const agy = require('./agy');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ── Gemini 专用道 ────────────────────────────────────────────────────────────
// Google 和 Anthropic 对出口 IP 的口味**可能是冲突的**（实测过）：
//   · 某些出口段 → Claude 好，Gemini 被拒
//   · 另一些段   → Gemini 好，claude.ai 判地区拒绝
// 所以「切主代理」是个二选一的死局 —— 修好一个必然打坏另一个。
// 正解是另起一条只给 Gemini 走的道：自己在本机起一个 HTTP 代理常驻 127.0.0.1:<GRANCYAN_GEMINI_LANE_PORT>（默认 10888），
// 出口固定在对 Google 友好的段，**不碰主代理**（那条留给本地 Claude）。
//
// 这里优先探这条道；没起来就回落到通用代理（那样很可能被拒，但至少不是静默失败 ——
// REGION_HINT 会把话说清楚）。探测结果缓存 10 秒，跟通用那套一个节奏。
const GEMINI_LANE_PORT = Number(process.env.GRANCYAN_GEMINI_LANE_PORT) || 10888;
let _laneState = { ok: false, ts: 0 };
let _laneAgent = null;

function probeLane(port) {
    return new Promise(resolve => {
        const s = new net.Socket();
        s.setTimeout(400);
        s.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
    });
}

// 返回 { agent, viaLane }。viaLane 只用来把话说准 —— 同样是被拒，
// 「专用道也被拒」和「压根没走专用道」要她做的事完全不同。
async function geminiAgent(outboundAgent) {
    if (Date.now() - _laneState.ts > 10000) {
        _laneState = { ok: await probeLane(GEMINI_LANE_PORT), ts: Date.now() };
    }
    if (_laneState.ok) {
        if (!_laneAgent) _laneAgent = new HttpsProxyAgent(`http://127.0.0.1:${GEMINI_LANE_PORT}`);
        return { agent: _laneAgent, viaLane: true };
    }
    return { agent: await outboundAgent(), viaLane: false };
}

// ⚠️ 实测：同一个 key、同一分钟，换个节点结果天差地别 ——
//   冷门数据中心段落地 → 400 FAILED_PRECONDITION
//   走优选 CDN 落地的节点 → 200
//   所以这个报错**不是 key 坏了、不是被墙**，是 Google 按出口 IP 拒服务。
//   静默的话看起来就是「Gemini 又开不了」，所以必须把换节点这句话直接摆到她眼前。
// 被拒的两种情形要说两句不同的话 —— 她该做的事完全不同：
//   · 专用道没起来 → 一条命令的事，起它
//   · 专用道起来了还被拒 → 那条道的出口段也不行了，要换段（别再去重启通道）
const REGION_HINT_NO_LANE = 'Google 按出口 IP 拒了这次请求（跟 key 没关系）。'
    + `Gemini 专用道没在跑（本机 127.0.0.1:${GEMINI_LANE_PORT} 上没有代理）—— 把它起起来再发一次，或者给主代理换个对 Google 友好的节点。`
    + '（专用道出口固定在对 Google 友好的段，不动主代理，所以不会影响订阅 Claude 那条。）';
const REGION_HINT_LANE_UP = 'Google 按出口 IP 拒了这次请求（跟 key 没关系）。'
    + '⚠️ 这次**已经**走的是 Gemini 专用道，它也被拒了 —— 说明那条道的出口段也不行了，'
    + '重启通道没用，要换一个出口段。主代理别动，那条是订阅 Claude 在用的。';
// 兼容老调用：不知道走没走专用道时，说回原来那句通用的
const REGION_HINT = 'Google 按出口 IP 拒了这次请求（跟 key 没关系）。'
    + '去代理客户端换一个对 Google 友好的节点再发一次。';

// 免费层的配额分三档（实测）：
//   · Flash 系列 —— 随便聊
//   · Pro 系列   —— 免费额度极小，基本一发就 429
//   · 出图（Nano Banana 那几个，模型名带 image）—— 免费层**一次都不给**，全部 429
// 所以 429 不能一句话打发，得按模型分开说，不然她会对着「换成 Flash」发愣：
// 出图模型本来就是 flash-image。
const QUOTA_HINT_PRO = 'Gemini 免费层的配额用完了。Pro 系列免费额度极小、几乎一发就满，'
    + '换成 Flash 系列（3.6 / 3.8 Flash）能正常聊；或者等一会儿再试。';
const QUOTA_HINT_IMAGE = '出图模型在 Gemini 免费层没有配额 —— 不是额度用完了，是这个档位一次都不给。'
    + '要用 Nano Banana 得给这个 Google 项目开结算（或者换一个付费 key）。聊天用 Flash 系列不受影响。';
// 「🌐 自己联网」这个开关自带一套独立配额，和聊天的不共享。
// 实测对照组：同一个 prompt、同一分钟，关掉开关就不是 429 —— 所以这是 grounding 特有的，
// 不能笼统报成「配额用完了」，那会让她去换模型，换到天亮也没用。
const QUOTA_HINT_SEARCH = 'Gemini 自带的联网检索（google_search）在这个 key 上没有配额 —— 聊天本身是好的，'
    + '是「🌐 自己联网」这个开关单独超了。关掉它就能正常聊；真要联网可以用会话栏右边那个「🔍 联网搜索」，'
    + '那条走的是 GranCyan 自己的搜索 key。';

// 出图模型（Nano Banana 那几个）返回的是 inline base64。直接塞进对话历史的话，
// 一张图就是一两 MB 的 base64 文本进 IndexedDB，翻几次记录就卡死了。
// 所以落盘 + 只把短 URL 发给前端。目录在项目根下，已进 .gitignore。
const IMG_DIR_NAME = 'gemini-out';
// 图的寿命。过期之后对话里那条气泡会变成裂图 —— 所以别设太短，
// 但也不能不清：出图模型一张一两 MB，长期跑下来这个目录会长到几个 G。
const IMG_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// thinking_level 的合法值就这四个 —— 2026-09-21 拿非法值问出来的（传 none/off 是 400，
// 不是静默忽略）。别再凭印象写 'none'。
const THINK_LEVELS = ['minimal', 'low', 'medium', 'high'];

function dataUrlToInline(u) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(u || ''));
    if (!m) return null;
    return { inline_data: { mime_type: m[1], data: m[2] } };
}

// GranCyan 的消息数组 → Gemini 的 contents。
// 两处不能省的整形（省了就是 400，而且报错含糊）：
//   · 开头的 model 消息要丢掉 —— 历史被裁剪时很容易剩一个 assistant 开头
//   · 相邻同角色要合并 —— 群聊模式会连着出好几条 assistant
function buildContents(messages) {
    const out = [];
    for (const m of messages || []) {
        if (!m || m.role === 'system') continue;
        const role = m.role === 'user' ? 'user' : 'model';
        const parts = [];
        const text = String(m.content || '').trim();
        if (text) parts.push({ text });
        for (const img of (m.images || [])) {
            const p = dataUrlToInline(img);
            if (p) parts.push(p);
        }
        if (!parts.length) continue;
        if (!out.length && role === 'model') continue;          // 别让历史以 model 开头
        const last = out[out.length - 1];
        if (last && last.role === role) last.parts.push(...parts);
        else out.push({ role, parts });
    }
    return out;
}

function buildThinkingConfig(level) {
    // 'auto' / 空 = 不传 thinking_level，跟模型自己的默认走；但 includeThoughts 照开，
    // 不然思考链是空的而模型确实想过了 —— 和 5 代那次「display 默认 omitted」同一个坑。
    //
    // ⚠️ 「不想」**不传 minimal**。2026-09-21 端到端实测（打包后的 exe，真发请求）：
    //   gemini-3.8-flash 回 400「Thinking level MINIMAL is not supported for this model」。
    //   minimal 在枚举里合法、却不是每个模型都吃 —— 硬传就是给她一个**必 400 的下拉选项**，
    //   而且报错长得像功能坏了。这一档的收益只是省一点思考 token，不值得拿整轮失败换。
    //   所以「不想」= 只关思考链显示（includeThoughts:false），档位交给模型自己定。
    //   （单元测试碰不出这个 —— 它只验我发了什么，验不了 Google 认不认。）
    if (level === 'off' || level === 'minimal') return { includeThoughts: false };
    if (THINK_LEVELS.includes(level)) return { includeThoughts: true, thinkingLevel: level };
    return { includeThoughts: true };
}

// SSE 解析。**故意抽成独立函数**：这一段（哪个 part 是思考、哪个是正文、出图怎么落盘、
// finishReason 意味着什么）是整条路里最容易错、而且错了最安静的地方 ——
// 埋在 app.post 的回调里就一行测试都写不了，只能靠真发请求碰运气，
// 而「预算被思考吃光」这种分支是碰不出来的（思考长度每轮都不一样）。
// 喂进来的是原始字节文本，吐出去的是前端那套事件（delta / thinking / geminiImages / notice / error）。
function createStreamParser({ model, webSearch, emit, saveImage }) {
    let buffer = '', sawText = false, lastFinish = '', usage = null;
    return {
        feed(text) {
            buffer += text;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                let j;
                try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
                // ⚠️ 流**开始之后**也可能翻车（实测 3.8-flash 高峰期会在第一段思考之后
                //   直接插一个 503 进来）。不认它的话，前端收到的是半截话 + 一个
                //   正常的 done，看上去像模型自己说了一半就不说了。
                if (j.error) {
                    emit({ error: explainError(j.error.code || 0, JSON.stringify(j), model, webSearch) });
                    continue;
                }
                const cand = (j.candidates || [])[0];
                for (const p of ((cand && cand.content && cand.content.parts) || [])) {
                    if (p.text) {
                        // thought 标记决定它进思考链还是进正文。看反了的后果不是报错，
                        // 是模型的内心独白直接当成回复发给她。
                        if (p.thought) emit({ thinking: p.text });
                        else { emit({ delta: p.text }); sawText = true; }
                    } else if (p.inlineData || p.inline_data) {
                        const d = p.inlineData || p.inline_data;
                        try {
                            emit({ geminiImages: [saveImage(d.mimeType || d.mime_type, d.data)] });
                            sawText = true;   // 出图也算有产出，别在末尾报「一个字都没出」
                        } catch (e) {
                            emit({ notice: '图生成好了但存不下来：' + e.message });
                        }
                    }
                }
                if (j.usageMetadata) usage = j.usageMetadata;
                // 正常结束的理由只有 STOP/MAX_TOKENS；其它（SAFETY/RECITATION…）要说出来，
                // 不然就是「它突然不说话了」。
                const fr = cand && cand.finishReason;
                if (fr) lastFinish = fr;
                if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
                    emit({ notice: `这轮被 Gemini 掐断了（finishReason=${fr}）` });
                }
            }
        },
        state() { return { usage, sawText, lastFinish }; },
    };
}

function mount(app, deps) {
    // 装配层漏传依赖要在启动时就炸，不能等真实请求打到这条分支才 502
    const { ROOT, outboundAgent } = deps || {};
    if (typeof outboundAgent !== 'function') throw new Error('server/gemini.js: 缺 outboundAgent');
    if (!ROOT) throw new Error('server/gemini.js: 缺 ROOT');

    const IMG_DIR = path.join(ROOT, IMG_DIR_NAME);

    function sweepOldImages() {
        try {
            const now = Date.now();
            for (const f of fs.readdirSync(IMG_DIR)) {
                const p = path.join(IMG_DIR, f);
                try {
                    if (now - fs.statSync(p).mtimeMs > IMG_MAX_AGE_MS) fs.unlinkSync(p);
                } catch { /* 单个文件删不掉不影响其它 */ }
            }
        } catch { /* 目录还不存在 */ }
    }

    function saveInlineImage(mime, b64) {
        const ext = IMG_EXT[mime] || '.png';
        const id = crypto.randomUUID() + ext;
        fs.mkdirSync(IMG_DIR, { recursive: true });
        fs.writeFileSync(path.join(IMG_DIR, id), Buffer.from(b64, 'base64'));
        return id;
    }

    // 只服务上面那个目录里的文件，文件名是 server 自己生成的 uuid。
    // 正则挡死一切路径成分（`.`/`/`/`\` 都不在字符集里），所以这里不存在越界的可能 ——
    // 不用像 /api/agent-file 那样再解一遍 realpath。
    app.get('/api/gemini-image', (req, res) => {
        const id = String(req.query.id || '');
        if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/i.test(id)) return res.status(400).json({ error: '文件名不合法' });
        const abs = path.join(IMG_DIR, id);
        if (!fs.existsSync(abs)) return res.status(404).json({ error: '图片已经不在了（超过 30 天会自动清掉）' });
        res.sendFile(abs);
    });

    // 她在会话栏切到「走订阅」时前端打一下：先把 agy 起好等着，第一轮少等 ~8s 的 init。
    app.post('/api/agy-prewarm', (req, res) => {
        agy.prewarm(agy.agyModel((req.body || {}).thinkingLevel));
        res.json({ ok: true });
    });

    app.post('/api/local-gemini', async (req, res) => {
        const {
            messages, systemPrompt, model, apiKey,
            thinkingLevel, temp, maxTokens, webSearch, via,
        } = req.body || {};

        // key 两个来源，前端优先：手机上她在设置里填了就用她填的，
        // 没填就落到 .env 的 GEMINI_API_KEY（这台电脑上一次配好，所有客户端都省事）。
        const key = String(apiKey || '').trim() || String(process.env.GEMINI_API_KEY || '').trim();
        const mdl = String(model || '').trim() || 'gemini-3.8-flash';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const send = o => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* 客户端已经走了 */ } };
        const finish = () => { try { send({ done: true }); res.end(); } catch { /* 同上 */ } };

        // 「走订阅」：不用 key，交给本机 agy（server/agy.js）。采样参数和自己联网在那条路上没有，不传。
        if (via === 'sub') {
            if (webSearch) send({ notice: '订阅 Gemini 这条路没有「🌐 自己联网」，这轮按不联网回。' });
            return agy.runTurn({ messages, systemPrompt, thinkingLevel, send, finish, res });
        }

        if (!key) {
            send({ error: 'Gemini 还没有 API key：在项目根目录的 .env 里加一行 GEMINI_API_KEY=…，或者在模型设置里给这条配置填上 key。' });
            return finish();
        }

        const contents = buildContents(messages);
        if (!contents.length) {
            send({ error: '消息内容为空，无法发送' });
            return finish();
        }

        const body = {
            contents,
            generationConfig: {
                thinkingConfig: buildThinkingConfig(thinkingLevel),
                ...(Number(temp) >= 0 ? { temperature: Number(temp) } : {}),
                ...(Number(maxTokens) > 0 ? { maxOutputTokens: Number(maxTokens) } : {}),
            },
        };
        const sys = String(systemPrompt || '').trim();
        if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        // Gemini 自带的联网检索。和 GranCyan 那套「先搜好再塞进 prompt」的联网搜索是两回事：
        // 这个是模型自己决定要不要查、查什么，所以单独一个开关。
        if (webSearch) body.tools = [{ google_search: {} }];

        const ctrl = new AbortController();
        // 纯 HTTP 无状态，接不回来也没有后台任务在跑 —— 客户端一走就该把上游掐掉，
        // 不然她按了停止、配额还在那边继续烧。（本地 Claude 那边相反，那条**不能**跟着 kill。）
        res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

        console.log(`[Gemini] model=${mdl} 历史${contents.length}段 sys=${sys.length} 思考=${thinkingLevel || '默认'}${webSearch ? ' +联网' : ''}`);

        // 收着最后一个 finishReason：这一轮「一个字都没出」的时候，它是唯一能分清
        // 「被安全策略掐了」和「预算被思考吃光了」的东西。没有它只能笼统说一句没出正文。
        let usage = null, sawText = false, lastFinish = '';
        // 优先走 Gemini 专用道（见文件头）。走没走成要记下来 —— 同样是被 Google 拒，
        // 「专用道也被拒」和「专用道没起来」要她做的事完全不同。
        const lane = await geminiAgent(outboundAgent);
        console.log(`[Gemini] 出口：${lane.viaLane ? `专用道 127.0.0.1:${GEMINI_LANE_PORT}` : '通用代理（专用道没起来）'}`);
        try {
            const upstream = await axios.post(
                `${API_BASE}/models/${encodeURIComponent(mdl)}:streamGenerateContent?alt=sse`,
                body,
                {
                    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
                    httpsAgent: lane.agent,
                    proxy: false,                 // agent 已经带了代理，再让 axios 读环境变量会绕两层
                    responseType: 'stream',
                    timeout: 0,                   // 流式：整体不设超时，靠客户端断开来收
                    signal: ctrl.signal,
                    validateStatus: () => true,
                    maxRedirects: 0,
                }
            );

            // 非 200：Google 把错误当**普通 JSON body** 返回（不是 SSE），得整段读完再解。
            if (upstream.status !== 200) {
                const raw = await new Promise(resolve => {
                    let s = '';
                    upstream.data.on('data', c => { s += c.toString('utf8'); });
                    upstream.data.on('end', () => resolve(s));
                    upstream.data.on('error', () => resolve(s));
                });
                send({ error: explainError(upstream.status, raw, mdl, webSearch, lane.viaLane) });
                return finish();
            }

            const parser = createStreamParser({
                model: mdl, webSearch, emit: send,
                saveImage: (mime, b64) => saveInlineImage(mime, b64),
            });
            await new Promise((resolve, reject) => {
                upstream.data.on('data', chunk => parser.feed(chunk.toString('utf8')));
                upstream.data.on('end', resolve);
                upstream.data.on('error', reject);
            });
            ({ usage, sawText, lastFinish } = parser.state());

            if (usage) {
                send({
                    usage: {
                        in: usage.promptTokenCount || 0,
                        out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
                        cached: usage.cachedContentTokenCount || 0,
                        cacheWrite: 0,
                    },
                });
            }
            if (!sawText) {
                // ⚠️ maxOutputTokens 是**思考 + 正文**一起算的，不是只管正文。
                //   实测：同一个问题给 800 → 思考把预算吃光，正文一个字都没排上，
                //   finishReason=MAX_TOKENS；给 4000 → 正常回答。
                //   不说破的话她看到的就是「它想了半天然后一个字不说」，只会以为模型坏了。
                send({
                    error: lastFinish === 'MAX_TOKENS'
                        ? '这轮的回复上限被思考链吃光了，正文一个字都没排上 —— Gemini 的 maxOutputTokens 是'
                            + '「思考 + 正文」一起算的。去模型设置把「最大回复 token」调大（4000 往上），'
                            + '或者把思考深度调到「浅」「不想」。'
                        : `Gemini 没有生成任何正文${lastFinish ? `（finishReason=${lastFinish}）` : ''}。换个模型或者把思考深度调低试试。`,
                });
            }
            console.log(`[Gemini] 完成 model=${mdl} 进 ${usage && usage.promptTokenCount || '?'} 出 ${usage && usage.candidatesTokenCount || '?'} token`);
        } catch (err) {
            if (err.name === 'CanceledError' || err.name === 'AbortError' || ctrl.signal.aborted) {
                // 她自己按的停止 / 关了页面 —— 不是错误，什么都别写（写了前端会当报错弹）
            } else {
                console.error('[Gemini] 失败:', err.message);
                send({ error: 'Gemini 连接失败：' + err.message + '（代理没开或者出口被拒的话，先换个节点）' });
            }
        }
        sweepOldImages();
        finish();
    });
}

// 把 Google 的英文报错翻成「她看了知道下一步该干嘛」的话。
// 光转发原文的话，400 FAILED_PRECONDITION 那句 "User location is not supported"
// 看起来像功能坏了，其实只要换个节点就好。
function explainError(status, raw, model, webSearch, viaLane) {
    let msg = '', reason = '';
    try {
        const j = JSON.parse(raw);
        msg = (j.error && j.error.message) || '';
        reason = (j.error && j.error.status) || '';
    } catch { msg = String(raw || '').slice(0, 300); }
    if (status === 400 && /location is not supported/i.test(msg)) {
        return viaLane === true ? REGION_HINT_LANE_UP
             : viaLane === false ? REGION_HINT_NO_LANE
             : REGION_HINT;   // 不知道走没走专用道（流中途的错误）时说通用那句
    }
    if (status === 429 || reason === 'RESOURCE_EXHAUSTED') {
        return webSearch ? QUOTA_HINT_SEARCH
            : /image|banana/i.test(String(model)) ? QUOTA_HINT_IMAGE
            : QUOTA_HINT_PRO;
    }
    if (status === 404 && /no longer available/i.test(msg)) {
        return `这个模型（${model}）Google 已经不对新用户开放了，换一个新一点的。原文：${msg}`;
    }
    if (status === 401 || status === 403) return `Gemini 拒绝了这个 key（HTTP ${status}）：${msg}`;
    if (status === 503) return `Gemini 这个模型正忙（503）：${msg || '换个模型或者过一会儿再试'}`;
    return `Gemini 报错 HTTP ${status}${reason ? ' ' + reason : ''}：${msg || '（没有给出原因）'}`;
}

// geminiAgent 也给 server/music-profile.js（整首听歌）用：同一条出口规则，别在那边再抄一份
module.exports = { mount, buildContents, buildThinkingConfig, explainError, createStreamParser, geminiAgent, THINK_LEVELS };
