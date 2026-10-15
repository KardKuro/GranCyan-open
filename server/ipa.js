// server/ipa.js
// 音标查询（学习卡片用）—— server.js 拆分 Phase 1 第二块（docs/server-split-plan.md）。
// 逻辑原样搬运，未改一行行为。deps 两个：
//   ROOT          —— server.js 顶部的 `process.env.GRANCYAN_ROOT || __dirname`，
//                     稳定字符串，直传，不必包成 getter。
//   outboundAgent —— server.js 的代理选择函数，本来就是函数，保持函数形态传递
//                     （硬约束 7），调用点里仍然是 `await outboundAgent()`。
// mount() 开头校验依赖：漏传就在启动时炸，不留到真实请求才 502
// （挂载探针只走校验分支，逮不住漏传——模板规则，音乐块 Codex 二轮定的）。
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sentenceZh = require('./sentence-zh');

function mount(app, deps) {
    if (!app || !deps || !deps.ROOT || typeof deps.outboundAgent !== 'function') {
        throw new Error('ipa.mount: 缺依赖（app/ROOT/outboundAgent）—— 装配层漏传了');
    }
    const { ROOT, outboundAgent } = deps;

    // ── 音标查询（学习卡片用）──
    // 两个语言两个源，都是免费无 key 的：
    //   en → api.dictionaryapi.dev，直接给 /ˈæp.əl/
    //   de → de.wiktionary 的 wikitext，抠 {{Lautschrift|tɪʃ}} 模板
    // 为什么不让 AI 顺手写在 [[CARD:]] 里：那条协议是**按位置**解析的，
    // 加第五段就得先确定第四段（例句）在不在，模型漏一格整张卡就错位
    // —— 指令格式一错位就静默断链（见 grancyan2-tag-format-imitation）。
    // 音标是查得到的客观事实，交给词典比交给模型稳，也不占对话 token。
    // ⚠️ 硬约束 6：顶层零副作用——这段路径计算摸了 fs.existsSync(ROOT)，
    // 必须等 mount() 真的被调用（拿到 deps.ROOT）才算，不能留在模块顶层。
    const IPA_CACHE_FILE = path.join(
        fs.existsSync(ROOT) && !ROOT.includes('.asar') ? ROOT : path.join(require('os').homedir(), '.grancyan'),
        'ipa-cache.json'
    );
    // 缓存语义在 v2 变了：v1 时代「空串」既可能是"词典里真没有"，也可能是
    // 一次 429/超时被 fetchIpaEn 吞成了空串（见下面那两个函数的注释）。
    // 分不清就只能全部作废——真查不到的那几个重查一次也就是几秒，
    // 而被网络抖动误杀的二十几个词从此能补上了。非空的音标照旧留着。
    const IPA_CACHE_VERSION = 2;
    let _ipaCache = null;
    function ipaCache() {
        if (_ipaCache) return _ipaCache;
        try { _ipaCache = JSON.parse(fs.readFileSync(IPA_CACHE_FILE, 'utf-8')); }
        catch { _ipaCache = {}; }
        if (_ipaCache.__v !== IPA_CACHE_VERSION) {
            let dropped = 0;
            for (const k of Object.keys(_ipaCache)) {
                if (k !== '__v' && !_ipaCache[k]) { delete _ipaCache[k]; dropped++; }
            }
            _ipaCache.__v = IPA_CACHE_VERSION;
            if (dropped) console.log(`[音标] 缓存升级到 v${IPA_CACHE_VERSION}，丢弃 ${dropped} 条存疑的"查不到"`);
            ipaCacheSave();
        }
        return _ipaCache;
    }
    let _ipaSaveTimer = null;
    function ipaCacheSave() {
        // 批量补音标时一次能查上百个词，逐个落盘纯属浪费；攒 2 秒写一次
        clearTimeout(_ipaSaveTimer);
        _ipaSaveTimer = setTimeout(() => {
            try {
                fs.mkdirSync(path.dirname(IPA_CACHE_FILE), { recursive: true });
                fs.writeFileSync(IPA_CACHE_FILE, JSON.stringify(_ipaCache));
            } catch (e) { console.warn('[音标] 缓存写不进去:', e.message); }
        }, 2000);
    }

    // 查词形：德语卡的正面按约定带冠词（der Tisch），可冠词是查不到词条的。
    // 尾部标点也要剥：用户词库里会有「hallo!」「tschüss!」这种，Wiktionary 的
    // 页面名不含感叹号，带着查回来的是 missingtitle。
    function ipaLookupForm(lang, word) {
        let w = String(word || '').trim();
        if (lang === 'de') w = w.replace(/^(der|die|das|ein|eine|einen|dem|den|des)\s+/i, '');
        return w.replace(/[!！?？.。,，;；:：]+$/, '').trim();
    }

    // ⚠️ 「查不到」和「没查成」必须分开。
    // 端点那层的约定是：**返回空串 = 词典里确实没有，会被永久缓存**；抛错 = 这次没查成，
    // 不写缓存、下次还能再试。原来这两个函数把 HTTP 非 200 一律 `return ''`，
    // 于是 dictionaryapi.dev 一次限流（批量补音标时串行打上百个词，很容易 429）
    // 就把那一批词全部永久钉死成"没有音标"——按多少次「补音标」都补不回来，
    // 而且一声不吭。实测 27 个补不到的词里，二十个是这么来的（policy /
    // process / role / research 这些，现在单查全都有音标）。
    class IpaLookupFailed extends Error {}

    // 从 Wiktionary 抠 wikitext。找不到词条返回 null（不是失败），查询本身挂了就抛。
    async function fetchWikitext(host, page) {
        const r = await axios.get(`https://${host}/w/api.php`, {
            params: { action: 'parse', page, prop: 'wikitext', format: 'json', formatversion: 2 },
            httpsAgent: await outboundAgent(), timeout: 15000, validateStatus: () => true,
            headers: { 'User-Agent': 'GranCyan/2.2 (personal study app)' },
        });
        // 404 跟 missingtitle 一样是"没这个词条"（明确的答案，可以缓存）；
        // 429/5xx/超时是"没查成"，必须抛——这两件事混在一起正是下面要修的那个 bug。
        if (r.status === 404) return null;
        if (r.status !== 200) throw new IpaLookupFailed(`${host} HTTP ${r.status}`);
        const d = r.data;
        const code = d && d.error && d.error.code;
        if (code === 'missingtitle') return null;          // 真的没这个词条
        if (code) throw new IpaLookupFailed(`${host} ${code}`);
        // ⚠️ HTTP 200 不等于查成了。中间代理插一页 HTML、返回 `{}`、被墙截胡改写……
        // 都是 200，而 `d?.parse?.wikitext || ''` 会把这些一律变成空串，上层
        // 再把空串当成"词典里确实没有"永久写进缓存 —— 就是本次要修的那个 bug
        // 换个入口原样复发。**结构不对就是没查成**，抛出去，别缓存。
        if (typeof (d && d.parse && d.parse.wikitext) !== 'string') {
          throw new IpaLookupFailed(`${host} 响应里没有 parse.wikitext`);
        }
        return d.parse.wikitext;
    }

    async function fetchIpaEn(word) {
        // 词组（give up）没有独立词条，逐词查了拼起来。**缺一个就整体作废**：
        // 「give up」只显示 /ɡɪv/ 比没有音标更糟，那是在教错读法。
        if (/\s/.test(word)) {
            const parts = word.split(/\s+/).filter(Boolean);
            if (parts.length > 4) return '';
            const each = [];
            for (const p of parts) {
                const one = await fetchIpaEn(p);
                if (!one) return '';
                each.push(one.replace(/^\/|\/$/g, ''));
            }
            return '/' + each.join(' ') + '/';
        }

        const r = await axios.get('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()),
            { httpsAgent: await outboundAgent(), timeout: 15000, validateStatus: () => true });
        if (r.status === 200 && Array.isArray(r.data)) {
            for (const entry of r.data) {
                if (entry.phonetic) return entry.phonetic;
                for (const p of entry.phonetics || []) if (p.text) return p.text;
            }
            // 200 但一个音标都没有（subscription 就是这样：有释义没读音），落到下面兜底
        } else if (r.status !== 404) {
            // 404 是这个源明确说"没这个词"，还能往下兜底；其余状态码是没查成
            throw new IpaLookupFailed(`dictionaryapi HTTP ${r.status}`);
        }

        // 兜底 en.wiktionary。dictionaryapi.dev 的覆盖有洞（subscription / freelance /
        // profit / trigger 都是有词条没读音），Wiktionary 这几个全有。
        const wt = await fetchWikitext('en.wiktionary.org', word.toLowerCase());
        if (!wt) return '';
        const m = wt.match(/\{\{IPA\|en\|([^}|]+)/);
        const ipa = m && m[1].trim();
        return ipa && /^\/.*\/$/.test(ipa) ? ipa : (ipa ? '/' + ipa.replace(/^\/|\/$/g, '') + '/' : '');
    }

    async function fetchIpaDe(word) {
        // 只认德语区块的 Lautschrift。de.wiktionary 是多语种词典，同名页面下常常
        // 压根没有德语义项：`land` 页面只有南非荷兰语/英语/冰岛语…，原来那个
        // 全文正则会把 Afrikaans 的 /lɑnt/ 当成德语音标交出去。德语的 Land 在
        // 首字母大写的另一个页面上（/lant/）——**错的音标比没有更难发现**。
        // 候选顺序：原样 → 首字母大写（德语名词一律大写，词库里常漏）。
        const cands = [word];
        const cap = word.charAt(0).toUpperCase() + word.slice(1);
        if (cap !== word) cands.push(cap);

        for (const cand of cands) {
            const wt = await fetchWikitext('de.wiktionary.org', cand);
            if (!wt) continue;
            // 切到德语那一段：`== Land ({{Sprache|Deutsch}}) ==` 到下一个同级标题为止
            const head = wt.match(/^==[^=\n]*\{\{Sprache\|Deutsch\}\}[^=\n]*==\s*$/m);
            if (!head) continue;
            const from = head.index + head[0].length;
            const nextIdx = wt.slice(from).search(/^==[^=\n]*\{\{Sprache\|/m);
            const section = nextIdx < 0 ? wt.slice(from) : wt.slice(from, from + nextIdx);
            // 第一个非空的 Lautschrift 就是标准发音；后面那些多是变格形和方言
            const m = section.match(/\{\{Lautschrift\|([^}|]+)\}\}/);
            const ipa = m && m[1].trim();
            if (ipa) return '/' + ipa + '/';
        }
        return '';
    }

    app.get('/api/ipa', async (req, res) => {
        const lang = req.query.lang === 'de' ? 'de' : 'en';
        const form = ipaLookupForm(lang, req.query.word);
        if (!form) return res.json({ ok: false, ipa: '', reason: 'empty' });

        const key = lang + ':' + form.toLowerCase();
        const cache = ipaCache();
        // 查不到也缓存（存空串）：一个词典里没有的词，重试一百次还是没有。
        // 不缓存失败的话，「补音标」按钮每按一次就把那几十个查不到的词重打一遍外网。
        if (Object.prototype.hasOwnProperty.call(cache, key)) {
            return res.json({ ok: true, ipa: cache[key], cached: true });
        }
        try {
            const ipa = lang === 'de' ? await fetchIpaDe(form) : await fetchIpaEn(form);
            cache[key] = ipa;
            ipaCacheSave();
            res.json({ ok: true, ipa });
        } catch (e) {
            // 网络错误**不写缓存** —— 这跟"词典里没这个词"是两回事，
            // 缓存了的话一次断网就把这个词永久钉死成"没有音标"。
            console.warn('[音标]', lang, form, e.message);
            res.json({ ok: false, ipa: '', reason: e.message });
        }
    });

    // ── 例句查询（刷单词的「语境」用）──
    // 源是 Tatoeba（CC BY 2.0 FR），英/德原句 + 人工中文翻译。选它不选 dictionaryapi 的
    // example：那边只有英文、覆盖一半，而背单词时「看不懂的例句」和没有一样。
    // 缓存语义照抄音标那边：{ex:''} = 句库里确实没有，永久缓存；抛错 = 没查成，不缓存。
    const EX_CACHE_FILE = path.join(path.dirname(IPA_CACHE_FILE), 'example-cache.json');
    let _exCache = null, _exSaveTimer = null;
    function exCache() {
        if (_exCache) return _exCache;
        try { _exCache = JSON.parse(fs.readFileSync(EX_CACHE_FILE, 'utf-8')); } catch { _exCache = {}; }
        return _exCache;
    }
    // 先并盘上的再写：整本预取的脚本（scripts/example-pregen-book.js）可能和 server 同时在写
    function exCacheSave() {
        clearTimeout(_exSaveTimer);
        _exSaveTimer = setTimeout(() => {
            try { sentenceZh.writeMerged(EX_CACHE_FILE, _exCache); }
            catch (e) { console.warn('[例句] 缓存写不进去:', e.message); }
        }, 2000);
    }
    // 句库没配中文的句子，译文在另一个缓存里（server/sentence-zh.js）；出门前补上
    const zhStore = sentenceZh.createStore(path.join(path.dirname(IPA_CACHE_FILE), 'sentence-zh.json'));
    sentenceZh.mount(app, zhStore);
    function withZh(lang, got) {
        const list = (got.list || []).map(x => x.zh ? x : { ...x, zh: zhStore.get(lang, x.ex) });
        return { ...got, list, zh: got.zh || (got.ex ? zhStore.get(lang, got.ex) : '') };
    }

    // 从 Tatoeba 返回里挑几句（一个词可以有好几个例句）。sort=words 已经是短句在前；
    // 再掐掉太短的（"Run!" 没有语境）和太长的（入门水平看不下去）。
    // **简体翻译优先**：cmn 里简繁混着，繁体只作兜底。挑的顺序就是优先级：
    // 合适长度+简体 → 合适长度+繁体 → 任意长度+简体 → 任意长度+繁体 → 没翻译的。
    // 同一句（大小写/标点不同的重复投稿）只要一次。
    function pickExamples(rows, n) {
        const zhOf = (r, script) => {
            for (const t of (r.translations || []).flat()) if (t && t.lang === 'cmn' && (!script || t.script === script)) return t.text;
            return '';
        };
        const words = r => String(r.text || '').split(/\s+/).filter(Boolean).length;
        const fit = rows.filter(r => words(r) >= 4 && words(r) <= 14);
        const out = [], seen = new Set();
        const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const take = (r, zh) => {
            const k = norm(r.text);
            if (!k || seen.has(k) || out.length >= n) return;
            seen.add(k); out.push({ ex: r.text, zh });
        };
        for (const pool of [fit, rows]) {
            for (const script of ['Hans', '']) for (const r of pool) { const zh = zhOf(r, script); if (zh) take(r, zh); }
        }
        for (const r of rows) take(r, '');
        return out;
    }
    function pickExample(rows) {
        return pickExamples(rows, 1)[0] || { ex: '', zh: '' };
    }
    const EX_MAX = 3;

    async function fetchExample(lang, form) {
        const r = await axios.get('https://api.tatoeba.org/unstable/sentences', {
            params: { lang: lang === 'de' ? 'deu' : 'eng', q: '=' + form, 'trans:lang': 'cmn',
                      sort: 'words', limit: 20, showtrans: 'matching' },
            httpsAgent: await outboundAgent(), timeout: 15000, validateStatus: () => true,
            headers: { 'User-Agent': 'GranCyan/2.6 (personal study app)' },
        });
        if (r.status !== 200) throw new IpaLookupFailed(`tatoeba HTTP ${r.status}`);
        // 同音标那边的教训：200 不等于查成了，结构不对就是没查成
        if (!r.data || !Array.isArray(r.data.data)) throw new IpaLookupFailed('tatoeba 响应里没有 data');
        const list = pickExamples(r.data.data, EX_MAX);
        // ex/zh 是第一句，留着给只认一句的老前端
        return { ex: list[0] ? list[0].ex : '', zh: list[0] ? list[0].zh : '', list };
    }

    app.get('/api/example', async (req, res) => {
        const lang = req.query.lang === 'de' ? 'de' : 'en';
        const form = ipaLookupForm(lang, req.query.word);
        if (!form || /\s/.test(form) && form.split(/\s+/).length > 4) return res.json({ ok: false, ex: '', zh: '', reason: 'empty' });
        const key = lang + ':' + form.toLowerCase();
        const cache = exCache();
        // 老缓存（只存了一句、没有 list）当没查过：重查一次才有好几句
        const old = Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
        if (old && Array.isArray(old.list)) return res.json({ ok: true, ...withZh(lang, old), cached: true });
        try {
            const got = await fetchExample(lang, form);
            cache[key] = got;
            exCacheSave();
            res.json({ ok: true, ...withZh(lang, got) });
        } catch (e) {
            console.warn('[例句]', lang, form, e.message);
            res.json({ ok: false, ex: '', zh: '', reason: e.message });
        }
    });
}

module.exports = { mount };
