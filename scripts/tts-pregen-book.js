// 把内置词书整本的发音提前合成好，存进后端的 TTS 磁盘缓存（server/tts-disk.js）。
// 跑法：node scripts/tts-pregen-book.js [书名，默认 gk] [并发，默认 3]
//
// 为什么要预生成：Edge 现合成一个词 0.6～0.7 秒（2026-09-28 实测），读磁盘只要几毫秒。
// 刷卡时前端虽然会预取后面几张，但刚开一组、或者手机隔着网络连电脑时，
// 第一个词还是会撞上现合成。整本合成好之后「第一次」这件事就不存在了。
//
// 已经有文件的词直接跳过，所以随时可以中断、重跑。
// 文件名必须和后端 /api/tts 算出来的一样（同一个 keyOf、同一个目录），不然后端找不到。
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const ttsDisk = require('../server/tts-disk');

const ROOT = process.env.GRANCYAN_ROOT || path.join(__dirname, '..');
const BOOK = process.argv[2] || 'gk';
const CONC = Math.max(1, Math.min(6, Number(process.argv[3]) || 3));
const VOICE = { en: 'en-US-AriaNeural', de: 'de-DE-KatjaNeural' };   // 和 js/22-study.js 的 STUDY_VOICE 一致

const box = { window: {} };
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'wordbooks', BOOK + '.js'), 'utf8'), box);
const book = box.window.GC_WORDBOOKS[BOOK];
const voice = VOICE[book.lang || 'en'];
const disk = ttsDisk.create(path.join(fs.existsSync(ROOT) && !ROOT.includes('.asar') ? ROOT : path.join(os.homedir(), '.grancyan'), 'tts-cache'));

function synth(tts, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('超时')), 20000);
    const { audioStream } = tts.toStream(text, { rate: '+0%', pitch: '+0%' });
    audioStream.on('data', d => chunks.push(d));
    audioStream.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    audioStream.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  const todo = book.words.map(w => w[0]).filter(w => !fs.existsSync(disk.file(ttsDisk.keyOf(voice, '+0%', '+0%', w))));
  console.log(`${book.name}：${book.words.length} 个词，还要合成 ${todo.length} 个 → ${disk.dir}`);
  let done = 0, failed = 0, i = 0;
  const t0 = Date.now();
  async function worker() {
    let tts = null;
    while (i < todo.length) {
      const w = todo[i++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (!tts) { tts = new MsEdgeTTS(); await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {}); }
          const buf = await synth(tts, w);
          if (buf.length < 200) throw new Error('空音频');
          await disk.put(ttsDisk.keyOf(voice, '+0%', '+0%', w), buf);
          done++;
          break;
        } catch (e) {
          try { tts && tts.close && tts.close(); } catch (_) {}
          tts = null;
          if (attempt === 2) { failed++; console.warn('  ✗', w, e.message); }
        }
      }
      if ((done + failed) % 100 === 0) console.log(`  ${done + failed}/${todo.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    try { tts && tts.close && tts.close(); } catch (_) {}
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`完成：新合成 ${done}，失败 ${failed}，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  process.exit(failed ? 1 : 0);
})();
