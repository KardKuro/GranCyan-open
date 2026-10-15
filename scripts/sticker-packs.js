/* 表情包分组（stickers-packs/<id>/）的目录扫描。
   两个地方要用同一套规则，所以逻辑只放这一份：
     server.js 的 /api/sticker-packs   —— 电脑上实时列目录
     android/build.ps1                 —— 打包时把结果冻成 assets/stickers-packs/packs.json
   两边各写一份的话，「哪些文件算表情」这种小规则迟早会漂（比如一边过滤了 `_` 开头一边没过滤），
   症状是同一个包在手机上和电脑上张数不一样，而两边代码单看都对。

   CLI: node scripts/sticker-packs.js <stickers-packs 目录> <输出的 packs.json> */
const fs = require('fs');
const path = require('path');

const STK_RE = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

function scanPacks(rootDir) {
  let dirs;
  try {
    dirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { return []; }
  return dirs.map(id => {
    const dir = path.join(rootDir, id);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf-8')); } catch (e) {}
    const descOf = new Map((meta.items || []).map(i => [i.file, i.desc]));
    // `_` 开头的是包自己的资产（_icon.png），不当表情列出来
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => STK_RE.test(f) && !f.startsWith('_')); } catch (e) {}
    files.sort((a, b) => a.localeCompare(b, 'zh'));
    return {
      id,
      name: meta.name || id,
      icon: meta.icon || null,
      desc: meta.desc || '',
      items: files.map(f => {
        const base = f.replace(/\.[^.]+$/, '');
        return { name: base, file: f, desc: descOf.get(f) || base };
      })
    };
  }).filter(p => p.items.length);
}

module.exports = { scanPacks };

if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('用法: node scripts/sticker-packs.js <stickers-packs 目录> <输出 packs.json>');
    process.exit(2);
  }
  const packs = scanPacks(src);
  fs.writeFileSync(out, JSON.stringify(packs, null, 2), 'utf-8');
  console.log(`packs.json: ${packs.length} 个分组，共 ${packs.reduce((n, p) => n + p.items.length, 0)} 个表情`);
}
