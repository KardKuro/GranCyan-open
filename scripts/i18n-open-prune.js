'use strict';
// 从主仓同步英文词典时用：把一份完整的词典按 open 自己的源码裁一遍，再写成 js/16-i18n-en.js。
//   node scripts/i18n-open-prune.js <主仓的 16-i18n-en.js> [输出，默认 js/16-i18n-en.js]
// 判据在 tests/_i18n-scope.js（和 tests/i18n-en.test.js 的 [1c] 同一份）：
// 在 open 源码里找不到出处的词条（open 没有的功能）整条拿掉；词条段里的 // 注释也拿掉
// （主仓的注释会点名那边独有的功能），只留 @@NEW@@ 这几个插入标记。
// 裁完记得：跑 tests/i18n-en.test.js、把 js/16-i18n-en.js 拷进 android/assets/js/、开英文界面爬一遍看有没有漏翻。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { build } = require('../tests/_i18n-scope');

const [src, outArg] = process.argv.slice(2);
if (!src) { console.error('用法：node scripts/i18n-open-prune.js <完整词典> [输出]'); process.exit(2); }
const out = outArg || path.join(ROOT, 'js', '16-i18n-en.js');
const S = build(ROOT);
// 作者的账号名不进词典（open 的源码里本来就没有这句，这里再挡一道）；
// 「好的 设置 取消」是测试里假模型吐的回复，被爬虫当成界面字收进去的
const NEVER = k => /KardKuro/.test(k) || k === '好的 设置 取消';

const keep = [], dropped = { MAP: [], HTML: [], RULES: [] }, kept = { MAP: 0, HTML: 0, RULES: 0 };
let sec = null, skipping = false;
for (const l of fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
  if (l.includes('/*MAP-BEGIN*/')) sec = 'MAP'; else if (l.includes('/*HTML-BEGIN*/')) sec = 'HTML'; else if (/^RULES:\s*\[/.test(l.trim())) sec = 'RULES';
  if (/\/\*(MAP|HTML)-END\*\//.test(l) || (sec === 'RULES' && /^\s*\]\s*,?\s*$/.test(l))) { keep.push(l); sec = null; continue; }
  const t = l.trim();
  if (skipping) { if (/^\}\],?$/.test(t)) skipping = false; continue; }   // 多行函数规则的身子跟着头一起走
  if (sec && t.startsWith('//')) { if (t.includes('@@')) keep.push(l); continue; }
  if ((sec === 'MAP' || sec === 'HTML') && t.startsWith('"')) {
    let k; try { k = Object.keys(JSON.parse('{' + t.replace(/,$/, '') + '}'))[0]; } catch (e) { keep.push(l); continue; }
    const ok = !NEVER(k) && (sec === 'MAP' ? S.mapOk(k) : S.htmlOk(k));
    if (ok) { keep.push(l); kept[sec]++; } else dropped[sec].push(k);
    continue;
  }
  if (sec === 'RULES' && t.startsWith('[/^')) {
    const m = t.match(/^\[\/(.*?)\/[a-z]*,\s/);
    const ok = m && S.ruleOk(m[1]);
    if (ok) { keep.push(l); kept.RULES++; } else { dropped.RULES.push(m ? m[1] : t); if (!/\],?\s*$/.test(t)) skipping = true; }
    continue;
  }
  keep.push(l);
}
fs.writeFileSync(out, keep.join('\n'));
console.log('留下', kept, '拿掉', { MAP: dropped.MAP.length, HTML: dropped.HTML.length, RULES: dropped.RULES.length });
if (process.argv.includes('--dropped')) console.log(JSON.stringify(dropped, null, 1));
