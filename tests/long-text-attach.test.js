'use strict';
// 长文本卡（用户消息 >320 字折成「📄 长文本 · 点击展开」）
//
// 2026-10-13：展开后中间空了半屏。正文区 .msg-attach-body 写了 white-space:pre-wrap，
// 可里面装的是 renderUserText 出的 Markdown HTML，外加 06-render-msg.js 模板自己的换行缩进，
// pre-wrap 把这些全画成了空行。顺带：点卡片里的「我的思考」会把整张卡一起收起来。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name); fail++; }
}

const css = read('css/grancyan.css');
const render = read('js/06-render-msg.js');

const body = css.match(/\.msg-attach-body\s*\{([^}]*)\}/);
t('.msg-attach-body 规则还在', !!body);
t('.msg-attach-body 不许 pre-wrap / pre-line（正文已是 HTML，模板空白会变空行）',
  body && !/white-space\s*:\s*pre/.test(body[1]));

const card = render.match(/<div class="msg-attach" onclick="([^"]*)"/);
t('长文本卡有点击收放', !!card);
t('点卡里的 details（我的思考）/引用/链接不连带收起整张卡',
  card && /closest\('[^']*details[^']*'\)/.test(card[1]) && /bubble-quote/.test(card[1]));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
