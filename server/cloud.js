// server/cloud.js
// 云同步(I) —— /api/cloud-chats、/api/cloud-profile、/api/cloud-file
// （docs/server-split-plan.md Phase 1 收尾块）。
// 逻辑原样搬运，一字未改。这块管的是用户的真实数据（对话云备份），是全项目
// "坏了最疼"的区之一，所以格外核对过：
//   - 六条路由全部只做**转发**——Authorization/apikey 来自客户端请求头，
//     服务器自己不持有、不缓存任何 Supabase 凭据，也不落盘任何数据。
//   - SUPABASE_URL 来自环境变量（或项目根目录 .env，server.js 顶部加载），在 mount() 里读，
//     顶层零副作用（硬约束 6）。没配 = 中转请求直接失败（502），前端会退回直连；
//     前端没配 Supabase（js/00-config.js）时根本不会发这些请求。
// deps 只有 outboundAgent（六条路由都用，函数形态直传，硬约束 7）。
// mount() 开头校验依赖：漏传就在启动时炸，不留到真实请求才 502
// （挂载探针只走校验分支，逮不住漏传——模板规则，音乐块 Codex 二轮定的）。
const axios = require('axios');

// 云端对话拉取中转：手机直连 Supabase 只有 ~10KB/s，走电脑（局域网 + 电脑侧代理）快几十倍
// 前端带着自己的 Supabase 登录 token 来请求，服务器只做转发，不存任何数据
let SUPABASE_URL = '';

function mount(app, deps) {
    if (!app || !deps || typeof deps.outboundAgent !== 'function') {
        throw new Error('cloud.mount: 缺依赖（app/outboundAgent）—— 装配层漏传了');
    }
    const { outboundAgent } = deps;
    SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');

    app.get('/api/cloud-chats', async (req, res) => {
        const auth = req.headers.authorization;
        const apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        try {
            let url = `${SUPABASE_URL}/rest/v1/chats?select=data,updated_at&order=updated_at.desc`;
            if (req.query.ids) {
                // 按 id 精确补拉（分页收尾清点用）
                const ids = String(req.query.ids).replace(/[^0-9,.\-]/g, '');
                url += `&chat_id=in.(${ids})`;
            } else {
                const limit = parseInt(req.query.limit) || 20;
                const offset = parseInt(req.query.offset) || 0;
                url += `&limit=${limit}&offset=${offset}`;
                if (req.query.since) url += `&updated_at=gt.${encodeURIComponent(req.query.since)}`;
            }
            const response = await axios.get(url, {
                headers: { Authorization: auth, apikey },
                httpsAgent: await outboundAgent(),
                timeout: 120000
            });
            res.json(response.data);
        } catch (e) {
            console.error('[云对话中转]', e.message);
            res.status(502).json({ error: '云端中转失败: ' + e.message });
        }
    });

    // 云端对话推送中转：手机直连 Supabase 上传只有 ~10KB/s，大对话推不动。
    // 上游错误原样透传（比如数据库 statement timeout），前端要靠状态码决定是否降级逐条推
    app.post('/api/cloud-chats', async (req, res) => {
        const auth = req.headers.authorization;
        const apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        try {
            const response = await axios.post(`${SUPABASE_URL}/rest/v1/chats?on_conflict=user_id,chat_id`, req.body, {
                headers: { Authorization: auth, apikey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
                httpsAgent: await outboundAgent(),
                timeout: 120000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                validateStatus: () => true
            });
            if (response.status < 300) return res.status(200).json({ ok: true });
            console.error('[对话推送中转] 上游', response.status, JSON.stringify(response.data).slice(0, 200));
            res.status(response.status).json(response.data);
        } catch (e) {
            console.error('[对话推送中转]', e.message);
            res.status(502).json({ error: '对话推送中转失败: ' + e.message });
        }
    });

    // 设置(profiles)中转：读写都走电脑——手机直连 Supabase 被限速，连 settings 都拉不动，
    // 导致 Giphy Key 等设置永远同步不到手机
    app.get('/api/cloud-profile', async (req, res) => {
        const auth = req.headers.authorization;
        const apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        // ?select=updated_at 只问「云端动过没有」（几十字节）；settings 那一行已经好几 MB，
        // 整包拉太多次会把 Supabase 免费档的出口流量吃爆（2026-10-11 整个项目被停过）。只认白名单里这几种
        let select = ['settings', 'updated_at', 'settings,updated_at'].includes(req.query.select) ? req.query.select : 'settings';
        // 2026-10-14：新前端另外带 ?cols=，只拉 settings 里变了的那几个键（另一台改了一点点，不再整包 4MB）。
        // 老 server 不认 cols、只看 select（前端给的 select 是老白名单里的 updated_at），所以新前端配老 server 也不会多拉。
        // 只认这几种形状：updated_at / settings / 别名:settings->键名，别的一律不认（不让人拿它拼任意查询）
        const cols = typeof req.query.cols === 'string' ? req.query.cols : '';
        if (cols && cols.length <= 4000) {
            const parts = cols.split(',');
            const okPart = p => p === 'updated_at' || p === 'settings'
                || /^[A-Za-z][A-Za-z0-9_]{0,31}:settings->[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p);
            if (parts.length <= 64 && parts.every(okPart)) select = parts.join(',');
        }
        try {
            const response = await axios.get(`${SUPABASE_URL}/rest/v1/profiles?select=${select}`, {
                headers: { Authorization: auth, apikey },
                httpsAgent: await outboundAgent(),
                timeout: 30000,
                validateStatus: () => true
            });
            if (response.status < 300) return res.json(response.data);
            console.error('[设置中转] 读取上游', response.status, JSON.stringify(response.data).slice(0, 300));
            res.status(response.status).json(response.data);
        } catch (e) {
            console.error('[设置中转]', e.message);
            res.status(502).json({ error: '设置中转失败: ' + e.message });
        }
    });
    app.post('/api/cloud-profile', async (req, res) => {
        const auth = req.headers.authorization;
        const apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        try {
            const response = await axios.post(`${SUPABASE_URL}/rest/v1/profiles`, req.body, {
                headers: { Authorization: auth, apikey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
                httpsAgent: await outboundAgent(),
                timeout: 30000,
                validateStatus: () => true
            });
            if (response.status < 300) return res.status(200).json({ ok: true });
            console.error('[设置中转] 写入上游', response.status, JSON.stringify(response.data).slice(0, 300));
            res.status(response.status).json(response.data);
        } catch (e) {
            console.error('[设置中转]', e.message);
            res.status(502).json({ error: '设置中转失败: ' + e.message });
        }
    });

    // 云端文件中转（Supabase Storage stickers 桶）：书架备份等文件走电脑代理，
    // 手机直连 Supabase 太慢。前端带自己的登录 token，服务器只转发不存数据。
    app.post('/api/cloud-file', async (req, res) => {
        const auth = req.headers.authorization, apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        const p = String(req.query.path || '');
        if (!/^[\w.\-/]+$/.test(p) || p.includes('..')) return res.status(400).json({ error: 'path 非法' });
        try {
            const response = await axios.post(`${SUPABASE_URL}/storage/v1/object/stickers/${p}`, req.body, {
                headers: { Authorization: auth, apikey, 'Content-Type': req.headers['content-type'] || 'application/json', 'x-upsert': 'true' },
                httpsAgent: await outboundAgent(),
                timeout: 120000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                validateStatus: () => true
            });
            if (response.status < 300) return res.json({ ok: true });
            console.error('[云文件中转] 上传上游', response.status, JSON.stringify(response.data).slice(0, 200));
            res.status(response.status).json(response.data);
        } catch (e) {
            console.error('[云文件中转]', e.message);
            res.status(502).json({ error: '云文件中转失败: ' + e.message });
        }
    });
    app.get('/api/cloud-file', async (req, res) => {
        const auth = req.headers.authorization, apikey = req.headers.apikey;
        if (!auth || !apikey) return res.status(401).json({ error: '缺少 Authorization / apikey' });
        const p = String(req.query.path || '');
        if (!/^[\w.\-/]+$/.test(p) || p.includes('..')) return res.status(400).json({ error: 'path 非法' });
        try {
            const response = await axios.get(`${SUPABASE_URL}/storage/v1/object/authenticated/stickers/${p}`, {
                headers: { Authorization: auth, apikey },
                httpsAgent: await outboundAgent(),
                timeout: 120000,
                responseType: 'arraybuffer',
                validateStatus: () => true
            });
            if (response.status >= 300) return res.status(response.status).send(Buffer.from(response.data));
            res.set('Content-Type', response.headers['content-type'] || 'application/octet-stream');
            res.send(Buffer.from(response.data));
        } catch (e) {
            console.error('[云文件中转]', e.message);
            res.status(502).json({ error: '云文件中转失败: ' + e.message });
        }
    });
}

module.exports = { mount };
