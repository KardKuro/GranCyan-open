// server/tts-disk.js
// 短文本 TTS 的磁盘缓存（单词卡的发音用）。
//
// 内存里那层 LRU（server.js 的 _ttsCache）重启就空，于是每次开电脑后第一次点一个词
// 都要等 Edge 现合成 0.6～0.7 秒（2026-09-28 实测）。单词就那么几千个，合成一次存盘，
// 以后永远是读文件；词书的发音还能用 scripts/tts-pregen-book.js 提前整本合成好。
//
// 只收短文本（单词、短例句）：聊天朗读那种几千字的长文不进来，否则磁盘会被念过的对话塞满。
// 文件名 = sha1(缓存键)，键和内存 LRU 同一个（voice|rate|pitch|text），预生成脚本也用这里的 keyOf，
// 两边算出来的必须是同一个文件，否则预生成白做。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTS_DISK_MAX_TEXT = 120;

function keyOf(voice, rate, pitch, text) {
    return voice + '|' + rate + '|' + pitch + '|' + text;
}

function create(dir) {
    const file = key => path.join(dir, crypto.createHash('sha1').update(key, 'utf8').digest('hex') + '.mp3');
    return {
        dir,
        file,
        eligible: text => typeof text === 'string' && text.length > 0 && text.length <= TTS_DISK_MAX_TEXT,
        async get(key) {
            try {
                const buf = await fs.promises.readFile(file(key));
                return buf.length >= 200 ? buf : null;      // 半截文件当没有
            } catch (_) { return null; }
        },
        // 先写临时文件再改名：写到一半进程被杀，留下的是 .tmp 而不是一个会被当成命中的半截 mp3
        async put(key, buf) {
            if (!buf || buf.length < 200) return;
            const dst = file(key), tmp = dst + '.' + process.pid + '.tmp';
            try {
                await fs.promises.mkdir(dir, { recursive: true });
                await fs.promises.writeFile(tmp, buf);
                await fs.promises.rename(tmp, dst);
            } catch (e) {
                console.warn('[TTS 磁盘缓存] 写不进去:', e.message);
                fs.promises.unlink(tmp).catch(() => {});
            }
        },
    };
}

module.exports = { create, keyOf, TTS_DISK_MAX_TEXT };
