// server/extract-doc.js
// 文档文本提取（R 分区，docs/server-split-plan.md Phase 2 批次 A）。
// 逻辑原样搬运，未改一行行为。这块不需要任何 deps——不打网络代理、不摸 ROOT，
// officeparser/word-extractor 都是纯本地解析（无外部依赖，不用装 Office/LibreOffice，
// 不 spawn 子进程），顶层直接 require；express 同样纯 npm，顶层直接 require。
// _wordExtractor 是解析器工具类的实例化（跟 server.js 里 `agent = new https.Agent(...)`
// 一样是稳定对象构造，不做 I/O，留顶层不违反硬约束 6）。
const express = require('express');
const officeparser = require('officeparser');
const WordExtractor = require('word-extractor');
const _wordExtractor = new WordExtractor();

// officeparser 只吃 Office Open XML 那一代（docx/pptx/xlsx…）。老式 .doc 是**完全不同**的东西：
// Word 97-2003 的 OLE2 复合文档，它直接摆手说 "supports docx, pptx, … only"。
// 所以按**文件头字节**分流，而不是按后缀 —— 后缀经常是错的（"论文.doc" 里躺着 docx / rtf 很常见），
// 认字节既能救老 .doc，也能顺手救一批「后缀和真实格式对不上」的文件。
function sniffDocKind(buf) {
    if (!buf || buf.length < 8) return '';
    const h = buf.subarray(0, 8);
    // D0CF11E0A1B11AE1 = OLE2 复合文档：Word 97-2003 的 .doc（也含老 .xls/.ppt）
    if (h[0] === 0xD0 && h[1] === 0xCF && h[2] === 0x11 && h[3] === 0xE0 &&
        h[4] === 0xA1 && h[5] === 0xB1 && h[6] === 0x1A && h[7] === 0xE1) return 'ole2';
    if (h[0] === 0x50 && h[1] === 0x4B && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07)) return 'zip';  // docx/pptx/xlsx/odt…
    if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
    return '';
}

function mount(app, deps) {
    if (!app) {
        throw new Error('extract-doc.mount: 缺依赖（app）—— 装配层漏传了');
    }

    app.post('/api/extract-doc', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
        let ext = (req.query.ext || '').replace('.', '').toLowerCase();
        const buf = req.body;
        const kind = sniffDocKind(buf);
        try {
            let text = '';
            if (kind === 'ole2') {
                // 老式 .doc 交给 word-extractor（纯 JS 读 OLE2，无外部依赖，不用装 Office/LibreOffice）
                const d = await _wordExtractor.extract(buf);
                // 论文类文档的内容经常不只在正文里：脚注、尾注、文本框都可能有货，一并带上。
                // 页眉页脚不要 —— 那是每页重复的版面家具，混进正文只会污染上下文。
                text = ['getBody', 'getFootnotes', 'getEndnotes', 'getTextboxes']
                    .map(m => { try { return d[m]() || ''; } catch { return ''; } })
                    .filter(s => s.trim()).join('\n');
            } else {
                // 字节说了算：后缀对不上时按真实格式重定 fileType，
                // 否则 officeparser 会拿错的 fileType 去解析，报一堆看不懂的错
                if (kind === 'rtf') ext = 'rtf';
                else if (kind === 'pdf') ext = 'pdf';
                else if (kind === 'zip' && (!ext || ext === 'doc')) ext = 'docx';
                const result = await officeparser.parseOffice(buf, ext ? { fileType: ext } : {});
                text = typeof result === 'string' ? result
                    : (typeof result?.toText === 'function' ? result.toText() : String(result || ''));
            }
            text = text.replace(/\r\n?/g, '\n').trim();
            if (!text) return res.status(400).json({ ok: false, error: '未提取到文本，可能是扫描件/图片型PDF' });
            res.json({ ok: true, text });
        } catch (e) {
            console.error('[extract-doc]', kind || 'unknown', e.message);
            let msg = e.message || '未知错误';
            // officeparser 那句 "Sorry, OfficeParser currently supports docx, … only" 又长又是英文，
            // 自带重复的 [OfficeParser]: 前缀，而且现在已经会误导人（老 .doc 这边已经支持了）。换人话。
            if (/OfficeParser currently supports/i.test(msg)) {
                msg = `认不出这个文件的格式（${ext || '无后缀'}）。支持 doc、docx、pptx、xlsx、odt、pdf、rtf、md、html、csv。`
                    + '如果文件本身没问题，多半是没下载完整，或者后缀被改过。';
            }
            // 前端会自己加「文档解析失败」前缀，这里只说原因，别让两层叠成「文档解析失败: 文档解析失败: …」
            res.status(400).json({ ok: false, error: msg });
        }
    });
}

module.exports = { mount };
