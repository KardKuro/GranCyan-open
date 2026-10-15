// 把内置词书整本的例句提前从 Tatoeba 查好，存进后端的例句缓存（example-cache.json）。
// 跑法：node scripts/example-pregen-book.js [书名，默认 gk] [并发，默认 2]
//
// 为什么要预取：Tatoeba 查一个词要 7～11 秒（2026-09-29 实测，走不走代理都一样慢，是它服务器慢），
// 刷卡时虽然会预取后面两张，刚开一组的第一个词、或者连着秒答的时候，例句还是会晚到。
// 整本 3490 词并发 3 大约两个多小时。
//
// 直接挂 server/ipa.js 的真路由跑（假 app 接住路由表），和 server 走的是同一段代码、同一个缓存文件；
// 查过的词直接跳过，随时可以中断、重跑。server 开着也不怕：两边落盘都是先并后写。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { HttpsProxyAgent } = require('https-proxy-agent');

const ROOT = process.env.GRANCYAN_ROOT || path.join(__dirname, '..');
const BOOK = process.argv[2] || 'gk';
const CONC = Math.max(1, Math.min(4, Number(process.argv[3]) || 2));
const PROXY = process.env.GRANCYAN_PROXY === '0' ? null : new HttpsProxyAgent('http://127.0.0.1:' + (process.env.GRANCYAN_PROXY || 10808));

const box = { window: {} };
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'wordbooks', BOOK + '.js'), 'utf8'), box);
const book = box.window.GC_WORDBOOKS[BOOK];
const lang = book.lang || 'en';

const routes = {};
const app = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
require('../server/ipa').mount(app, { ROOT, outboundAgent: async () => PROXY || undefined });
const cacheFile = path.join(ROOT, 'example-cache.json');

function ask(word) {
  return new Promise(resolve => {
    routes['GET /api/example']({ query: { lang, word } }, { json: resolve, status() { return this; } });
  });
}

(async () => {
  let have = {};
  try { have = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const todo = book.words.map(w => w[0]).filter(w => { const v = have[lang + ':' + w.toLowerCase()]; return !(v && Array.isArray(v.list)); });
  console.log(`${book.name}：${book.words.length} 个词，还要查 ${todo.length} 个 → ${cacheFile}`);
  let ok = 0, empty = 0, failed = 0, i = 0;
  const t0 = Date.now();
  async function worker() {
    while (i < todo.length) {
      const w = todo[i++];
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await ask(w);
        if (r && r.ok) break;
        await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));   // 多半是 429，退一退
      }
      if (!r || !r.ok) { failed++; console.warn('  ✗', w, r && r.reason); }
      else if ((r.list || []).length) ok++; else empty++;
      const n = ok + empty + failed;
      if (n % 100 === 0) console.log(`  ${n}/${todo.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await new Promise(res => setTimeout(res, 2500));   // 等 ipa.js 那 2 秒的攒写落盘
  console.log(`完成：有例句 ${ok}，句库里没有 ${empty}，没查成 ${failed}，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  process.exit(failed ? 1 : 0);
})();
