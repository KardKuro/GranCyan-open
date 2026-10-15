// 下载 PhET 交互实验的离线副本到 labkit/phet/（简体中文单文件版），并写 manifest.js。
//
//   node scripts/fetch-phet.js          下载缺的（已有且完整的跳过）
//   node scripts/fetch-phet.js --force  全部重下
//
// 清单只有一份：js/56-sims.js 的 LAB_SIMS（这里用 vm 跑那个文件取出来），别在这里再抄。
// PhET 实验：CC BY 4.0，PhET Interactive Simulations, University of Colorado Boulder, https://phet.colorado.edu
//
// ⚠️ 大文件下载会被静默截断（CDN 回 200 却只给一部分，见记忆 cdn-silent-truncation）：
//    每个文件落盘前验结尾是 </html>，不完整的不算、不写进 manifest。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'labkit', 'phet');
const FORCE = process.argv.includes('--force');

const box = { window: {} };
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', '56-sims.js'), 'utf8') + ';this.LAB_SIMS=LAB_SIMS;this.simOnlineUrl=simOnlineUrl;', box);
const SIMS = box.LAB_SIMS;

const complete = s => /<\/html>\s*$/i.test(s.slice(-2000));

async function fetchOne(sim) {
  const file = path.join(OUT, sim.id + '.html');
  if (!FORCE && fs.existsSync(file) && complete(fs.readFileSync(file, 'utf8'))) return 'have';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(box.simOnlineUrl(sim.id), { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (!complete(text)) throw new Error('下载不完整（' + text.length + ' 字节，没有 </html> 结尾）');
      fs.writeFileSync(file, text);
      return (text.length / 1048576).toFixed(1) + 'MB';
    } catch (e) {
      if (i === 2) return '✗ ' + e.message;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  let next = 0;
  // 并发 3：和她用的是同一个出口，别把带宽吃满（记忆 scan-concurrency-hogs-bandwidth）
  const worker = async () => {
    while (next < SIMS.length) {
      const sim = SIMS[next++];
      const r = await fetchOne(sim);
      console.log((r.startsWith('✗') ? '  ' : '  ✓ ') + sim.zh + '  ' + r);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const have = SIMS.filter(s => {
    const f = path.join(OUT, s.id + '.html');
    return fs.existsSync(f) && complete(fs.readFileSync(f, 'utf8'));
  }).map(s => s.id);
  fs.writeFileSync(path.join(OUT, 'manifest.js'),
    '// 生成物：node scripts/fetch-phet.js。列的是电脑后端上**完整下载了**的实验，前端据此决定用本地还是官网。\n'
    + 'window.LAB_PHET_LOCAL = ' + JSON.stringify(have) + ';\n');
  fs.writeFileSync(path.join(OUT, 'LICENSE.txt'),
    'PhET Interactive Simulations, University of Colorado Boulder, https://phet.colorado.edu\n'
    + 'Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Downloaded unmodified for offline use.\n');
  console.log('完成：' + have.length + '/' + SIMS.length + ' 个离线可用，用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  if (have.length < SIMS.length) process.exitCode = 1;
})();
