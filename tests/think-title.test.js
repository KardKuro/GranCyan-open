'use strict';
// 思考链折叠标题：内心独白版 —— 2026-10-03，来自用户 X 书签里的点子（标题写成它心里那句话，不写「分析了代码结构」）
//
// 会静默出错的地方：
//   · 提示词里还留着旧的「动宾短语」示例 —— 模型照抄示例，标题又变回工作日志，零报错
//   · 叫名字：设置里关了「让 AI 看到我的名字」，标题提示词却把名字塞给 DeepSeek
//   · 长思考只截开头：结尾才是想定的那一下，截掉了标题就只剩「先看看她说了什么」
//   · 收拾结果：模型多吐一行解释 / 带引号 / 带句号，原样挂到标题上
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js/05-prompts-api.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// 按函数自己的右大括号截（源文件是 CRLF，别写死 \n}\n）
function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const m = /\r?\n\}\r?\n/.exec(src.slice(i));
  return m ? src.slice(i, i + m.index + m[0].length) : '';
}
const box = { String };
vm.createContext(box);
vm.runInContext(fn('thinkTitlePrompt') + fn('cleanThinkTitle') + ';this.P=thinkTitlePrompt;this.C=cleanThinkTitle;', box);
const P = box.P, C = box.C;

console.log('\n[1] 提示词');
const p = P('She asked me about dinner again. I should tease her a bit. ' + 'x'.repeat(60), '小明');
t('★ 要第一人称、带情绪的一句心里话', /第一人称/.test(p) && /情绪/.test(p) && /20 字以内/.test(p));
t('★ 不再给「分析了…」当示例（只许出现在「不要」里）', !/如"分析了代码结构"/.test(p) && /不要「分析了」/.test(p));
t('★ 用她的称呼，不叫「用户」', p.includes('回复小明之前') && p.includes('叫「小明」') && /别叫「用户」/.test(p));
t('  没名字时不硬塞「用户」', !P('x'.repeat(80), '').includes('回复用户') && P('x'.repeat(80), '').includes('回复ta之前'));
const long = 'HEAD-' + 'a'.repeat(3000) + '-TAIL';
const pl = P(long, '小明');
t('★ 长思考保留开头和结尾', pl.includes('HEAD-') && pl.includes('-TAIL') && pl.includes('……'), pl.length);
t('  长思考有截断，不整段发出去', pl.length < 2400, pl.length);
const short = '短思考'.repeat(30);
t('  短思考原样带上', P(short, '小明').endsWith(short));

console.log('\n[2] 名字闸门');
const sumFn = fn('summarizeThinking');
t('★ 关了「让 AI 看到名字」就不传名字', /userNameAiVisible !== false/.test(sumFn) && /thinkTitlePrompt\(reasoningText, who\)/.test(sumFn));
t('  结果走 cleanThinkTitle', /cleanThinkTitle\(/.test(sumFn));

console.log('\n[3] 收拾模型回来的那句');
t('★ 只留第一行', C('她又熬夜了，有点心疼\n（这句表达了心疼）') === '她又熬夜了，有点心疼');
t('★ 剥引号和句末标点', C('「她又熬夜了。」') === '她又熬夜了' && C('"终于找到了这个 bug."') === '终于找到了这个 bug');
t('  句中标点留着', C('好想抱抱她，可她在忙') === '好想抱抱她，可她在忙');
t('  太长截断带省略号', C('啊'.repeat(40)) === '啊'.repeat(30) + '…');
t('  空 / null 不炸', C('') === '' && C(null) === '' && C(undefined) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
