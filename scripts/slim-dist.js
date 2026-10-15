// 打包后瘦身：Electron 会把 Chromium 全套语言包（50 多个 .pak，共 ~46 MB）
// 原样塞进 dist/locales，而 Grancyan 只用得到中文和英文。
// electron-packager 没有筛语言的开关（--ignore 只作用于 app 源码，管不到
// Electron 运行时自己的文件），所以在 pack:exe 后面挂这一步。
//
// 只删 locales/*.pak。不碰 LICENSES.chromium.html（19 MB）——那是许可证
// 原文，自用无所谓，但要是哪天分发出去就得带着，省这点不值当。
// 也不碰 dxcompiler.dll：GPU 着色器路径要用，删了某些机器会白屏。
const fs = require('fs');
const path = require('path');

// 保留常用语种（要求：稳一手，别为了几十 MB 把将来可能用到的砍光）。
// 多留这几个约多占 6 MB，相对省下来的 40 MB 完全划算。
const KEEP = new Set([
  'zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak',
  'ja.pak', 'ko.pak', 'fr.pak', 'de.pak', 'ru.pak', 'es.pak',
]);
// 输出目录可以传进来（`node scripts/slim-dist.js dist-new`）。默认还是 dist，
// pack:exe 的行为一个字没变。
// 加这个参数的由来：dist/Grancyan-win32-x64 会被一种查不出来的 cwd 型锁锁住
//（子目录全能改名、只有根不行；Restart Manager 和 PEB 扫描都指不出是谁），
// 这时只能 --out 到别处打包，而瘦身这一步不该因此白跑。
const outDir = process.argv[2] || 'dist';
const dir = path.join(__dirname, '..', outDir, 'Grancyan-win32-x64', 'locales');

if (!fs.existsSync(dir)) {
  console.log('[slim] 没找到 locales 目录，跳过（打包失败了？）');
  process.exit(0);
}

let freed = 0, removed = 0, kept = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.pak')) continue;
  if (KEEP.has(f)) { kept.push(f); continue; }
  const p = path.join(dir, f);
  freed += fs.statSync(p).size;
  fs.unlinkSync(p);
  removed++;
}

console.log(`[slim] locales: 删掉 ${removed} 个语言包，省 ${(freed / 1024 / 1024).toFixed(1)} MB；保留 ${kept.join(', ') || '（无！）'}`);
if (!kept.length) console.warn('[slim] ⚠️ 一个语言包都没保住，界面文字可能出问题——检查 KEEP 里的文件名');
