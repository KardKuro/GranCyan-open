// server/tts.js
// Edge 神经语音 TTS 代理（L 分区，docs/server-split-plan.md Phase 2 批次 A）。
// 逻辑原样搬运，未改一行行为。这块不需要任何 deps——不打网络代理、不摸 ROOT，
// 唯一的外部依赖是 npm 包 msedge-tts，顶层 require（失败就禁用端点，跟原来一样）。
let _MsEdgeTTS = null, _OUTPUT_FORMAT = null;
try {
    const m = require('msedge-tts');
    _MsEdgeTTS = m.MsEdgeTTS;
    _OUTPUT_FORMAT = m.OUTPUT_FORMAT;
} catch (e) {
    console.warn('⚠️ msedge-tts 未安装，/api/tts 将不可用：' + e.message);
}
// 合成一次，把整段 mp3 收进 Buffer（聊天长度文本很短，缓冲开销可忽略）。
// Edge TTS 的 WebSocket 偶尔 ECONNRESET，所以外层做重试。
function synthEdgeTTS(text, voice, rate) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const chunks = [];
        const tts = new _MsEdgeTTS();
        tts.setMetadata(voice, _OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
            .then(() => {
                const { audioStream } = tts.toStream(text, { rate });
                audioStream.on('data', d => chunks.push(d));
                audioStream.on('close', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
                audioStream.on('error', e => { if (!settled) { settled = true; reject(e); } });
            })
            .catch(e => { if (!settled) { settled = true; reject(e); } });
    });
}

function mount(app, deps) {
    if (!app) {
        throw new Error('tts.mount: 缺依赖（app）—— 装配层漏传了');
    }

    app.get('/api/tts', async (req, res) => {
        if (!_MsEdgeTTS) return res.status(501).json({ error: 'msedge-tts 未安装' });
        const text = (req.query.text || '').toString();
        const voice = (req.query.voice || 'zh-CN-XiaoxiaoNeural').toString();
        let rate = (req.query.rate || '+0%').toString();
        if (!text.trim()) return res.status(400).json({ error: '缺少 text' });
        if (text.length > 2000) return res.status(400).json({ error: 'text 过长（上限 2000 字符）' });
        // rate 只允许 +/-数字% 形式，防注入
        if (!/^[+-]?\d{1,3}%$/.test(rate)) rate = '+0%';
        // 只允许合法的 voice ShortName（字母数字连字符），防 SSML 注入
        if (!/^[A-Za-z0-9\-]+$/.test(voice)) return res.status(400).json({ error: '非法 voice' });
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const buf = await synthEdgeTTS(text, voice, rate);
                if (!buf || buf.length < 200) throw new Error('空音频');
                res.set('Content-Type', 'audio/mpeg');
                res.set('Cache-Control', 'no-store');
                return res.end(buf);
            } catch (e) {
                lastErr = e;
                console.warn('[Edge-TTS] 第 ' + (attempt + 1) + ' 次失败: ' + e.message);
            }
        }
        console.error('[Edge-TTS] 合成失败:', lastErr && lastErr.message);
        if (!res.headersSent) res.status(502).json({ error: 'TTS 合成失败: ' + (lastErr && lastErr.message) });
    });
}

module.exports = { mount };
