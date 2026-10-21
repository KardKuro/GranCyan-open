'use strict';
// 公开仓的英文词典只收 open 自己有的字：判断一条词条「在 open 的源码里有没有出处」。
// tests/i18n-en.test.js 的 [1c] 和 scripts/i18n-open-prune.js（从主仓同步词条时裁词典）共用这一份，
// 两边的标准不会漂开。
//
// 为什么要有：主仓的词典比这边多近千条（open 没有的功能，有的还挺私人）。整份拷过来，
// 那些功能的名字和说明就跟着公开出去了。
//
// 语料：js/（不含词典自己和 js/wordbooks 单词书）、server/、coread/、css/、根目录的 js / html。
// 注释不算（注释里随口一句话不该让一条词条混过去）。
// 判据：
//   MAP  —— 原样出现；或者是代码里拼出来的句子（「FLIGHT CHESS · 」+ 版本名），那就每段中文都要在源码里
//           「成段」出现（前后不挨着别的汉字），每段英文词组也要出现。
//           中文不超过两个字的：带了别的字符（「Play 模式」「[[RULE_ADD: 规矩]]」）要原样出现，
//           纯中文的要整词出现（「结果冻成」里不算有「果冻」）。
//   HTML —— 原样出现（功能指南整段）；两个字以内的（单位、拆字标题）得真有一个挂 data-i18n-block 的元素装着它。
//   RULES —— 正则里每一段字面（分组之间的那几截）只要带中文，就得原样出现；
//           中文全在分组里的（「(甲|乙) ×N」），分组里每个带中文的分支都得原样出现。
const fs = require('fs');
const path = require('path');

const CJK = /[一-鿿]/;
const EXT = /\.(js|mjs|cjs|html|css)$/;

function collectFiles(ROOT) {
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      // 单词书是一整本带中文释义的词表，什么字都有，算进来等于不设防
      if (e.isDirectory()) { if (!/node_modules/.test(e.name) && p !== 'js/wordbooks') walk(p); }
      else if (EXT.test(e.name) && p !== 'js/16-i18n-en.js') files.push(p);
    }
  };
  for (const d of ['js', 'server', 'coread', 'css']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  for (const f of fs.readdirSync(ROOT)) if (EXT.test(f)) files.push(f);
  return files;
}

// html 只去 <!-- -->；js / css 去行首起的 /* */、整行的 //、行尾「空格 // 空格」起的注释
function strip(s, f) {
  if (/\.html$/.test(f)) return s.replace(/<!--[\s\S]*?-->/g, ' ');
  return s.replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/[ \t]\/\/ .*$/gm, ' ');
}

function build(ROOT) {
  const files = collectFiles(ROOT);
  let corpus = '';
  for (const f of files) corpus += '\n' + strip(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
  const ent = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const flat = corpus.replace(/\s+/g, ' ');
  // 拼接：'前半句' + '后半句' → 一整句；JS 字符串里的 \n、\" 转义
  const joined = flat.replace(/(['"`])\s*\+\s*(['"`])/g, '').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\s+/g, ' ');
  const shapes = [flat, ent(flat), ent(flat.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')), joined];
  const lit = k => shapes.some(s => s.includes(k));
  // 成段出现：前后不挨着别的汉字
  const whole = k => shapes.some(s => { for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) if (!CJK.test(s[i - 1] || '') && !CJK.test(s[i + k.length] || '')) return true; return false; });
  const latinOf = s => (s.replace(/<[^>]*>/g, ' ').match(/[A-Za-z]{2,}(?: [A-Za-z]{2,})*/g) || []).filter(x => x.length >= 3);

  function mapOk(k) {
    const kk = k.replace(/\s+/g, ' ');
    if (lit(kk) && !(cjkLen(kk) <= 2 && pureZh(kk))) return true;
    const zh = kk.replace(/<[^>]*>/g, ' ').match(/[一-鿿]+/g) || [];
    if (!zh.length) return false;
    if (cjkLen(kk) <= 2) return pureZh(kk) ? zh.every(whole) : false;
    return zh.every(r => r.length < 2 || whole(r)) && zh.some(r => r.length >= 2) && latinOf(kk).every(lit);
  }
  // 两个字以内的整段只会是挂了 data-i18n-block 的单位 / 拆字标题：得真有一个元素挂着它
  function htmlOk(k) {
    const kk = k.replace(/\s+/g, ' ');
    if (cjkLen(kk) <= 2) return /data-i18n-block>/.test(flat) && shapes.some(s => s.includes('data-i18n-block>' + kk + '<'));
    return lit(kk);
  }
  // 正则拆成几截字面：分组、字符类、\d \s 这类、可有可无的字都当分隔。转义的 \( \. 先藏起来，别当成分组
  const SEP = '\u0000';
  const hide = s => s.replace(/\\(.)/g, (m, c) => String.fromCharCode(0xE000 + c.charCodeAt(0)));
  const unhide = s => s.replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xE000));
  function chunks(src) {
    let s = src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\[dDsSwWbB][?*+]?(\{[^}]*\})?/g, SEP);
    s = hide(s);
    const groups = [];
    for (let g = 0; g < 20 && /\([^()]*\)/.test(s); g++) s = s.replace(/\(([^()]*)\)[?*+]?(\{[^}]*\})?/g, (m, inner) => { groups.push(inner); return SEP; });
    s = s.replace(/\[[^\]]*\][?*+]?(\{[^}]*\})?/g, SEP).replace(/[^\u0000][?*]/g, SEP).replace(/\{\d+(,\d*)?\}/g, '').replace(/[.+]/g, m => m === '.' ? SEP : '');
    const alts = groups.flatMap(g => g.replace(/^\?:/, '').split('|')).map(a => unhide(a.replace(/\[[^\]]*\]|[?*+.]/g, '')).trim());
    return { lits: unhide(s).split(SEP).map(x => x.trim()).filter(x => CJK.test(x)), alts };
  }
  // 一截字面里的「整段中文」：连着的汉字和句读，带上紧挨着的括号引号（「新的一局开始啦。沿箭头前进，先达到」
  // 「【本局结束】」各算一段）；间隔号、空格处断开（那里常是拼接的接缝：'新卡' + ' · 这一轮还剩 '）
  const segsOf = s => s.match(/[（）「」『』“”【】]?[一-鿿][一-鿿，。、：；！？]*[（）「」『』“”【】]?/g) || [];
  // 字面里的 emoji / 符号（「⛓」）也得在 open 里出现过
  const symsOf = s => s.replace(/[\x00-\x7f一-鿿，。、：；！？（）「」『』“”【】·…—\s]/g, '');
  function ruleOk(src) {
    const { lits, alts } = chunks(src);
    if (lits.length) {
      // 中文不超过两个字的那截（「，量」「 张」）要连着标点原样出现；更长的，每整段中文都得原样出现
      const ok = lits.every(c => cjkLen(c) <= 2 ? lit(c.replace(/\s+/g, ' ')) : segsOf(c).every(g => cjkLen(g) <= 2 ? (whole(g.replace(/[^一-鿿]/g, '')) && lit(g)) : lit(g)));
      return ok && latinOf(lits.join(' ')).every(lit) && [...symsOf(lits.join(''))].every(ch => flat.includes(ch));
    }
    // 中文全在分组里：每个带中文的分支都得原样出现
    return alts.filter(a => CJK.test(a)).every(a => cjkLen(a) <= 1 || lit(a));
  }
  return { files, flat, mapOk, htmlOk, ruleOk };
}
const cjkLen = s => (s.match(/[一-鿿]/g) || []).length;
// 除了中文只有空白和常见标点
const pureZh = s => !/[^\s一-鿿，。、：；！？…（）「」『』“”‘’·・—\-,.:;!?()]/.test(s);

module.exports = { build };
