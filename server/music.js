// server/music.js
// 点歌（网易云）—— server.js 拆分 Phase 1 第一块（docs/server-split-plan.md）。
// 逻辑原样搬运，未改一行行为；deps.agent 是 server.js 顶层那个
// `new https.Agent({ rejectUnauthorized:false })`，按方案硬约束 7 显式传入
// （它是不变的稳定对象，不是像 outboundAgent 那样的可变状态，直接传引用即可）。
const axios = require('axios');

// ==========================================
// 🎵 点歌（网易云）
// GET /api/music/search?q=关键词&limit=10 → { songs:[{id,name,artist,album,cover,duration,vip}] }
// GET /api/music/url?id=123              → { url, playable }
// GET /api/music/lyric?id=123            → { lyric, tlyric }
// GET /api/music/stream?id=123           → 直接把音频转发过来（兜底用，见下）
//
// ⚠️ 三个必须注意的地方，每一个都能让"搜得到但放不出声"：
//   ① **绝对不能走代理**。outboundAgent() 开着 v2rayN 时会把请求送出国，
//      网易云对境外 IP 直接不给播放地址——表现是搜索正常、每首歌都"不可播放"。
//   ② 拿到的 302 目标是 **http**，而 App 页面跑在 https://grancyan.app 这个安全源上，
//      直接喂给 <audio> 会被浏览器当混合内容拦掉（静默失败，控制台才有一行）。
//      这里统一改写成 https，实测 m*.music.126.net 支持。
//   ③ 版权不全的歌会 302 到 music.163.com/404，那是个 HTML 不是 mp3。
//      不认出来的话播放器会一直转圈，得当"这首放不了"处理。
// ==========================================
const MUSIC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'Referer': 'https://music.163.com/',
};

function mount(app, deps) {
    // 装配层漏传依赖要在启动时就炸，不能等真实请求打到用它的分支才 502
    // （挂载探针只走校验分支，逮不住漏传——Codex 二轮建议 #4，模板规则）。
    if (!app || !deps || !deps.agent) throw new Error('music.mount: 缺依赖（app/agent）—— 装配层漏传了');
    const { agent } = deps;

    // 国内站点一律直连（见上面 ①）
    const musicAxios = (extra = {}) => ({ headers: { ...MUSIC_HEADERS, ...(extra.headers || {}) }, timeout: 12000, httpsAgent: agent, proxy: false, ...extra });

    async function neteaseSongUrl(id) {
        const r = await axios.get(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`,
            musicAxios({ maxRedirects: 0, validateStatus: s => s >= 200 && s < 400 }));
        let loc = r.headers?.location || '';
        if (!loc || /\/404(\?|$)/.test(loc) || !/\.mp3/i.test(loc)) return null;   // ③ 版权不全
        return loc.replace(/^http:\/\//i, 'https://');                             // ②
    }

    // 用 cloudsearch 而不是老的 search/get/web：后者返回的条目里**没有 al.picUrl**，
    // 封面全是空的（卡片就只剩一块灰底），而且排序更差。
    // 比对歌名/歌手时先抹掉空格标点：「晴天 (Live)」和「晴天」该算同一首
    const _mNorm = s => String(s || '').toLowerCase().replace(/[\s（）()【】\[\]·・,，.。'"'’\-_]/g, '');

    async function neteaseSearch(q, limit) {
        const r = await axios.get('https://music.163.com/api/cloudsearch/pc', musicAxios({
            params: { s: q, type: 1, offset: 0, limit },
        }));
        return (r.data?.result?.songs || []).map(s => ({
            id: s.id,
            name: s.name,
            artist: (s.ar || []).map(a => a.name).filter(Boolean).join('/') || '未知',
            album: s.al?.name || '',
            cover: s.al?.picUrl ? String(s.al.picUrl).replace(/^http:/, 'https:') + '?param=200y200' : '',
            duration: s.dt || 0,
            // fee 只当提示：很多 fee=8 的歌外链照样给，而 fee=0 的老歌反而可能下架。
            // 能不能播一律以 /api/music/url 的结果为准。
            vip: s.fee === 1 || s.fee === 4,
        }));
    }

    app.get('/api/music/search', async (req, res) => {
        const q = String(req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit) || 10, 30);
        if (!q) return res.status(400).json({ error: '缺少 q' });
        try {
            res.json({ songs: await neteaseSearch(q, limit) });
        } catch (e) {
            console.error('[点歌·搜索]', e.message);
            res.status(502).json({ error: '网易云搜索失败: ' + e.message });
        }
    });

    // AI 点歌走这条：搜完**先验一遍能不能播**，返回第一首真的出得了声的。
    // 不做这一步的话，热门歌的第一条经常是没版权的原版（比如周杰伦那些），
    // 卡片出来了、按下播放却一点动静都没有——"AI 给我放首歌"最怕的就是这个。
    // 只验前 6 条（一条约 100ms，并行发），验不出来就退回第一条并标明放不了。
    app.get('/api/music/pick', async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: '缺少 q' });
        try {
            const songs = await neteaseSearch(q, 10);
            if (!songs.length) return res.json({ song: null, songs: [] });
            const head = songs.slice(0, 6);
            const urls = await Promise.all(head.map(s => neteaseSongUrl(s.id).catch(() => null)));
            // 能播的里面再挑最像"用户点的那首"的：热门歌的原版常常没版权，
            // 剩下能播的一堆是翻唱/钢琴版/remix，直接取第一条经常放出一首莫名其妙的歌。
            let best = -1, bestScore = -1e9;
            for (let i = 0; i < head.length; i++) {
                if (!urls[i]) continue;
                const s = head[i];
                const qn = _mNorm(q), nm = _mNorm(s.name);
                let sc = -i * 0.1;                                   // 同分时保持搜索排序
                if (nm && qn === nm) sc += 4;
                else if (nm && qn.includes(nm)) sc += 2;
                for (const a of String(s.artist).split('/')) if (a && qn.includes(_mNorm(a))) sc += 2;
                if (/cover|remix|翻自|翻唱|钢琴|伴奏|纯音乐|改编|吉他|八音盒|dj/i.test(s.name + s.album)) sc -= 3;
                if (sc > bestScore) { bestScore = sc; best = i; }
            }
            const song = best >= 0 ? head[best] : songs[0];
            res.json({ song: { ...song, playable: best >= 0 }, url: best >= 0 ? urls[best] : '', songs });
        } catch (e) {
            console.error('[点歌·挑歌]', e.message);
            res.status(502).json({ error: '点歌失败: ' + e.message });
        }
    });

    app.get('/api/music/url', async (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!id) return res.status(400).json({ error: '缺少 id' });
        try {
            const url = await neteaseSongUrl(id);
            res.json({ url: url || '', playable: !!url });
        } catch (e) {
            console.error('[点歌·取地址]', e.message);
            res.status(502).json({ error: '取播放地址失败: ' + e.message });
        }
    });

    app.get('/api/music/lyric', async (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!id) return res.status(400).json({ error: '缺少 id' });
        try {
            // 逐字歌词（yrc）是网易云自己就带的，只是要多要几个参数——以前只取 lv/tv，
            // 等于把最值钱的那份时轴白扔了。各参数对应关系：
            //   lv 普通 LRC ｜ tv 翻译 ｜ rv 罗马音
            //   yv 逐字 YRC ｜ ytv 逐字版翻译 ｜ yrv 逐字版罗马音
            // 有 yrc 的歌，翻译优先用 ytlrc：它和 yrc 是同一套时间轴（实测行首时间
            // 中位数差 0.000s，而 tlyric 差 0.320s）。挑哪一份在前端 musicLoadLyric 里决定，
            // 这里只负责把六份原样带回去——后端别替前端做选择，不然想改规则得动两处。
            const r = await axios.get('https://music.163.com/api/song/lyric', musicAxios({
                // 值是「歌词版本号」不是开关：1＝只要版本 1，新传的歌（版本>1）会回空串，前端就当成纯音乐给猫咪
                // （实测一首新传的歌就是这样）。-1＝取最新。
                params: { id, lv: -1, kv: -1, tv: -1, rv: -1, yv: -1, ytv: -1, yrv: -1 },
            }));
            const d = r.data || {};
            res.json({
                lyric:    d.lrc?.lyric || '',
                tlyric:   d.tlyric?.lyric || '',
                romalrc:  d.romalrc?.lyric || '',
                yrc:      d.yrc?.lyric || '',
                ytlrc:    d.ytlrc?.lyric || '',
                yromalrc: d.yromalrc?.lyric || '',
                // 纯音乐要认出来，不然前端会把「纯音乐，请欣赏」当成一句歌词铺满整屏
                pureMusic: !!(d.pureMusic || d.lrc?.pureMusic || d.yrc?.pureMusic),
            });
        } catch (e) {
            console.error('[点歌·歌词]', e.message);
            res.status(502).json({ error: '取歌词失败: ' + e.message });
        }
    });

    // ── 从网易云账号导入（把用户「喜欢的音乐」和自己建的歌单拉进来）──
    // 不用登录：公开歌单匿名就能读全（v6/playlist/detail 给全量 trackIds，
    // 但匿名只带前几首的 tracks 详情，其余靠 v3/song/detail 一批 500 首补——实测 1000 首一批也全给，留余量）。
    // 「喜欢的音乐」要是在网易云里设了隐私，这里会拿到 code≠200，前端照实说「要登录」。
    //
    // GET /api/music/netease/user?q=昵称或uid → { user:{id,nickname}, playlists:[{id,name,count,cover,liked}] }
    //   只回她自己建的（creator 是她），收藏的别人歌单不要——她要的是「我创建的」。
    // GET /api/music/netease/playlist?id=123  → { id,name,desc,cover, songs:[{id,name,artist,cover,at}] }
    //   at = 加进这个歌单的时间（毫秒），「喜欢的音乐」拿它当收藏时间，导进来的顺序才和网易云一样。
    const _neCover = (u, px) => u ? String(u).replace(/^http:/, 'https:') + `?param=${px}y${px}` : '';
    const _neSlim = s => ({
        id: s.id, name: s.name || '',
        artist: (s.ar || []).map(a => a.name).filter(Boolean).join('/') || '未知',
        cover: _neCover(s.al?.picUrl, 200),
    });

    app.get('/api/music/netease/user', async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: '缺少 q' });
        try {
            let uid = /^\d{3,}$/.test(q) ? q : '', nickname = '';
            if (!uid) {
                const r = await axios.get('https://music.163.com/api/cloudsearch/pc', musicAxios({ params: { s: q, type: 1002, offset: 0, limit: 10 } }));
                const us = r.data?.result?.userprofiles || [];
                // 昵称完全一致的优先；没有就不猜——拉错一个人的歌单进来比报「找不到」糟得多
                const hit = us.find(u => u.nickname === q) || us.find(u => _mNorm(u.nickname) === _mNorm(q));
                if (!hit) return res.status(404).json({ error: `网易云上没搜到叫「${q}」的用户`, near: us.slice(0, 5).map(u => u.nickname) });
                uid = String(hit.userId); nickname = hit.nickname;
            }
            const r = await axios.get('https://music.163.com/api/user/playlist', musicAxios({ params: { uid, limit: 1000, offset: 0 } }));
            if (r.data?.code !== 200) return res.status(502).json({ error: `网易云不给歌单列表（code ${r.data?.code}）` });
            const mine = (r.data.playlist || []).filter(p => String(p.creator?.userId) === uid);
            if (!nickname) nickname = mine[0]?.creator?.nickname || uid;
            res.json({
                user: { id: uid, nickname },
                playlists: mine.map(p => ({
                    id: String(p.id), name: p.name || '', count: p.trackCount || 0,
                    cover: _neCover(p.coverImgUrl, 240),
                    liked: p.specialType === 5,          // 「XX喜欢的音乐」
                })),
            });
        } catch (e) {
            console.error('[点歌·网易云用户]', e.message);
            res.status(502).json({ error: '读网易云用户失败: ' + e.message });
        }
    });

    app.get('/api/music/netease/playlist', async (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: '缺少 id' });
        try {
            const r = await axios.get('https://music.163.com/api/v6/playlist/detail', musicAxios({ params: { id, n: 100000 } }));
            const pl = r.data?.playlist;
            if (r.data?.code !== 200 || !pl) return res.status(403).json({ error: `网易云不给这个歌单（code ${r.data?.code}），可能设了隐私，要登录才看得到` });
            const tids = (pl.trackIds || []).filter(t => t && t.id != null);
            const byId = new Map();
            for (const s of pl.tracks || []) byId.set(String(s.id), _neSlim(s));
            const need = tids.filter(t => !byId.has(String(t.id)));
            for (let i = 0; i < need.length; i += 500) {
                const c = JSON.stringify(need.slice(i, i + 500).map(t => ({ id: t.id })));
                const d = await axios.post('https://music.163.com/api/v3/song/detail', 'c=' + encodeURIComponent(c),
                    musicAxios({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }));
                for (const s of d.data?.songs || []) byId.set(String(s.id), _neSlim(s));
            }
            // 按 trackIds 的顺序出（网易云里看到的顺序）；详情拿不到的（下架到连元数据都没了）就跳过
            const songs = tids.map(t => byId.get(String(t.id)) && Object.assign({}, byId.get(String(t.id)), { at: +t.at || 0 })).filter(Boolean);
            res.json({ id, name: pl.name || '', desc: pl.description || '', cover: _neCover(pl.coverImgUrl, 240), songs });
        } catch (e) {
            console.error('[点歌·网易云歌单]', e.message);
            res.status(502).json({ error: '读网易云歌单失败: ' + e.message });
        }
    });

    // 兜底通道：万一 CDN 那边不认某台设备（或以后又改回只给 http），
    // 让音频从这台电脑转一手。Range 必须原样转发，否则拖不动进度条。
    app.get('/api/music/stream', async (req, res) => {
        const id = String(req.query.id || '').trim();
        if (!id) return res.status(400).end();
        try {
            const url = await neteaseSongUrl(id);
            if (!url) return res.status(404).json({ error: '这首歌没有可用的播放地址' });
            const up = await axios.get(url, musicAxios({
                responseType: 'stream',
                headers: { ...(req.headers.range ? { Range: req.headers.range } : {}) },
                validateStatus: () => true,
            }));
            res.status(up.status);
            for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                if (up.headers[h]) res.setHeader(h, up.headers[h]);
            }
            up.data.pipe(res);
            up.data.on('error', () => res.destroy());
        } catch (e) {
            console.error('[点歌·转发]', e.message);
            if (!res.headersSent) res.status(502).end();
        }
    });

    // 整首听歌（server/music-profile.js）要拿同一个地址：同样直连、同样认 404，别抄第二份
    return { neteaseSongUrl };
}

module.exports = { mount };
