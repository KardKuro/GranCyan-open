// server/stt.js
// 语音输入转写代理（M 分区，docs/server-split-plan.md Phase 2 批次 A）。
// 逻辑原样搬运，未改一行行为。deps 只有 outboundAgent（非国内服务商走它选代理，
// 函数形态直传，硬约束 7）；axios/express 都是纯 npm 依赖，顶层直接 require。
// FormData / Blob / URLSearchParams 是 Node 全局（跟原来在 server.js 里一样，不用 require）。
const axios = require('axios');
const express = require('express');

// 按住说话 / 语音通话：前端 MediaRecorder 录音 → 这里转发给转写服务 → 回文本
// POST /api/voice-stt?key=<Key>&provider=groq|siliconflow|custom&mime=…&lang=zh
//      （provider=custom 时再带 base=<.../v1> 和 model=<模型名>）
//      body = 原始音频字节
//
// 这几家用的都是同一套 OpenAI 兼容接口（multipart 传 file + model 到 /audio/transcriptions），
// 所以换服务商只是换 baseURL 和模型名。之所以做成可切换：Groq 注册可能卡在
// 「邮箱不属于任何组织」，而硅基流动国内手机号就能注册、还直连不用梯子。
// 大多数家用的是同一套 OpenAI 兼容接口（multipart 传 file + model 到 /audio/transcriptions），
// 换服务商只是换 baseURL 和模型名。ElevenLabs 和 Deepgram 是例外，各自要一个小适配器（见下）。
const STT_PROVIDERS = {
    groq:        { kind: 'openai',     base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo',      label: 'Groq' },
    openai:      { kind: 'openai',     base: 'https://api.openai.com/v1',      model: 'whisper-1',                   label: 'OpenAI' },
    elevenlabs:  { kind: 'elevenlabs', base: 'https://api.elevenlabs.io/v1',   model: 'scribe_v1',                   label: 'ElevenLabs' },
    deepgram:    { kind: 'deepgram',   base: 'https://api.deepgram.com/v1',    model: 'nova-3',                      label: 'Deepgram' },
    siliconflow: { kind: 'openai',     base: 'https://api.siliconflow.cn/v1',  model: 'FunAudioLLM/SenseVoiceSmall', label: '硅基流动' },
    custom:      { kind: 'openai' },   // 用户自填 base + model
};

function mount(app, deps) {
    if (!app || !deps || typeof deps.outboundAgent !== 'function') {
        throw new Error('stt.mount: 缺依赖（app/outboundAgent）—— 装配层漏传了');
    }
    const { outboundAgent } = deps;

    app.post('/api/voice-stt', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
        const key = String(req.query.key || '');
        if (!key) return res.status(400).json({ error: '还没填语音转写的 API Key（设置 → 🎤 语音输入）' });
        if (!req.body || !req.body.length) return res.status(400).json({ error: '没收到音频' });

        const pid = String(req.query.provider || 'groq');
        const preset = STT_PROVIDERS[pid] || STT_PROVIDERS.custom;
        const base  = (preset.base  || String(req.query.base  || '')).replace(/\/$/, '');
        const model =  preset.model || String(req.query.model || '');
        if (!/^https?:\/\//.test(base) || !model) {
            return res.status(400).json({ error: '转写服务没配好：需要 base URL 和模型名' });
        }

        const mime = String(req.query.mime || 'audio/webm').split(';')[0];
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
        const lang = String(req.query.lang || '');
        // 国内的服务直连更快，别绕代理；国外的走 outboundAgent() 探测到的代理
        const domestic = /siliconflow\.cn|aliyuncs\.com|bigmodel\.cn|volces\.com/.test(base);
        const agent = domestic ? undefined : await outboundAgent();

        try {
            let url, body, headers, pick;
            if (preset.kind === 'elevenlabs') {
                // ElevenLabs Scribe：xi-api-key 头 + multipart(file, model_id)，回包里取 .text
                url = `${base}/speech-to-text`;
                const form = new FormData();
                form.append('file', new Blob([req.body], { type: mime }), `voice.${ext}`);
                form.append('model_id', model);
                if (lang) form.append('language_code', lang);
                body = form;
                headers = { 'xi-api-key': key };
                pick = d => d?.text;
            } else if (preset.kind === 'deepgram') {
                // Deepgram：Authorization: Token xxx + 原始音频字节直接当 body，
                // 文本埋在 results.channels[0].alternatives[0].transcript
                const qs = new URLSearchParams({ model, smart_format: 'true' });
                if (lang) qs.set('language', lang);
                url = `${base}/listen?${qs}`;
                body = req.body;
                headers = { Authorization: `Token ${key}`, 'Content-Type': mime };
                pick = d => d?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
            } else {
                // OpenAI 兼容（Groq / OpenAI / 硅基流动 / 自定义）
                url = `${base}/audio/transcriptions`;
                const form = new FormData();
                form.append('file', new Blob([req.body], { type: mime }), `voice.${ext}`);
                form.append('model', model);
                form.append('response_format', 'json');
                if (lang) form.append('language', lang);
                body = form;
                headers = { Authorization: `Bearer ${key}` };
                pick = d => d?.text;
            }

            const r = await axios.post(url, body, { headers, httpsAgent: agent, timeout: 60000 });
            const text = String(pick(r.data) || '').trim();
            console.log(`[语音转写|${preset.label || pid}] ${(req.body.length / 1024).toFixed(0)}KB ${ext} → ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
            res.json({ text });
        } catch (e) {
            const d = e.response?.data;
            const detail = d?.error?.message || d?.message || d?.detail?.message
                || (typeof d === 'string' ? d.slice(0, 200) : '') || e.message;
            console.error('[语音转写]', pid, detail);
            res.status(502).json({ error: '转写失败：' + detail });
        }
    });
}

module.exports = { mount };
