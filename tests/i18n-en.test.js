// 英文界面（设置 → 外观 → 语言 → English）：词典 js/16-i18n-en.js + 机制 js/16-misc.js（2026-10-21）
//
// 守四件事：
//   [1] 词典本身：MAP / HTML 两段是合法 JSON、没有重复 key、英文里没有中文；RULES 都是能编译的 ^ 开头正则，
//       $n 不越界、字面里带中文（光有捕获组的规则会把别的句子吃掉）。
//       [1c] 公开仓专有：词典里的每条都得在 open 自己的源码里找得到（不把 open 没有的功能带出来）。
//   [2] 机制：整句 / 压平空白 / 剥符号 / 规则 四种查法；整段换（功能指南）；中英文挨着的地方补空格。
//   [3] 消息正文不翻：气泡、引用、思考正文、记忆正文里刚好是词典里的词（「删除」「好的」）也原样留着；
//       流式输出改气泡时一个规则都不跑；跳过容器里的界面零件（思考块标题）照翻。
//   [4] index.html 的静态中文覆盖率（文字节点 + placeholder/title/aria-label + 功能指南整段）。
// 跑法：node tests/i18n-en.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function ok(n, v, extra) { if (v) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); } }
const CJK = /[一-鿿]/;
const CJK_OK = /简体中文|[人皿一口益]/g;   // 语言名本身、颜文字里的字（(人´∀｀) (^人^) (ง ᵒ̌皿ᵒ̌)ง）

// ═══ [1] 词典 ═══
console.log('\n[1] 词典 js/16-i18n-en.js');
const dictSrc = read('js/16-i18n-en.js').replace(/\r\n/g, '\n');
function section(name) {
  const a = dictSrc.indexOf(`/*${name}-BEGIN*/`), b = dictSrc.indexOf(`/*${name}-END*/`);
  if (a < 0 || b < a) return null;
  return dictSrc.slice(a + name.length + 10, b);
}
function parseSection(name) {
  const body = section(name);
  if (body == null) return { err: '找不到 ' + name + '-BEGIN/END' };
  try { return { obj: JSON.parse(body.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*)}\s*$/, '$1}')), body }; }
  catch (e) { return { err: e.message }; }
}
const P = { MAP: parseSection('MAP'), HTML: parseSection('HTML') };
for (const name of ['MAP', 'HTML']) {
  const p = P[name];
  ok(`${name} 段去掉注释后是合法 JSON`, !p.err, p.err);
  if (p.err) continue;
  // 一行一条 "k":"v",（别的测试按 JSON.stringify(k)+':' 找词条，形状不能乱）
  const lines = p.body.split('\n').map(l => l.trim()).filter(l => l && l !== '{' && l !== '}' && !l.startsWith('//'));
  const shape = lines.filter(l => { try { const o = JSON.parse('{' + l.replace(/,$/, '') + '}'); return Object.keys(o).length !== 1; } catch (e) { return true; } });
  ok(`${name} 段一行一条 "中文":"English",`, shape.length === 0, shape.slice(0, 3));
  const seen = new Map(), dups = [];
  for (const l of lines) { let k; try { k = Object.keys(JSON.parse('{' + l.replace(/,$/, '') + '}'))[0]; } catch (e) { continue; } if (seen.has(k)) dups.push(k); seen.set(k, 1); }
  ok(`${name} 没有重复 key（JSON.parse 会悄悄留后一条，前一条白写）`, dups.length === 0, dups.slice(0, 5));
  const bad = Object.entries(p.obj).filter(([k, v]) => typeof v !== 'string' || !v.trim() || CJK.test(v.replace(CJK_OK, '')));
  ok(`${name} 的英文里没有中文、没有空串`, bad.length === 0, bad.slice(0, 5));
  const noZh = Object.keys(p.obj).filter(k => !CJK.test(k));
  ok(`${name} 的 key 都带中文（不带中文的永远查不到）`, noZh.length === 0, noZh.slice(0, 5));
}
if (!P.HTML.err) {
  const tagBad = Object.entries(P.HTML.obj).filter(([k, v]) => (k.match(/<[^>]+>/g) || []).join('') !== (v.match(/<[^>]+>/g) || []).join(''));
  ok('HTML 段：英文里的标签和中文一模一样（只换字）', tagBad.length === 0, tagBad.slice(0, 2).map(x => x[0].slice(0, 80)));
}
// GranCyan-open 的词典是从主仓那份按 open 自己的源码裁出来的（open 没有的功能那几百条拿掉了），门槛比主仓低
ok('MAP 至少 2500 条（整批翻译还在）', !P.MAP.err && Object.keys(P.MAP.obj).length >= 2500, !P.MAP.err && Object.keys(P.MAP.obj).length);
ok('HTML 段有功能指南的整段（≥ 250）', !P.HTML.err && Object.keys(P.HTML.obj).length >= 250, !P.HTML.err && Object.keys(P.HTML.obj).length);

// ═══ [1c] 公开仓的词典只收 open 自己有的字 ═══
// 主仓的词典比这边多近千条（open 没有的功能，有的还挺私人）。整份拷过来，那些功能的名字和说明就跟着公开出去了。
// 所以守着：每条词条在 open 自己的源码里都得有出处。判据在 tests/_i18n-scope.js，
// 从主仓同步词条时用 scripts/i18n-open-prune.js 先裁一遍（同一份判据），这条红了就是多拷了。
console.log('\n[1c] 词典只收 open 源码里有的字');
{
  const S = require('./_i18n-scope').build(ROOT);
  ok(`语料够大（${S.files.length} 个源码文件）`, S.files.length > 100 && S.flat.length > 1e6, S.files.length);
  const mapOut = P.MAP.err ? ['(MAP 解析失败)'] : Object.keys(P.MAP.obj).filter(k => !S.mapOk(k));
  ok('MAP 的每个 key 都在 open 源码里有出处', mapOut.length === 0, mapOut.slice(0, 5));
  const htmlOut = P.HTML.err ? ['(HTML 解析失败)'] : Object.keys(P.HTML.obj).filter(k => !S.htmlOk(k));
  ok('HTML 段的每段都在 open 源码里原样出现过', htmlOut.length === 0, htmlOut.slice(0, 3).map(s => s.slice(0, 60)));
  const ruleOut = [];
  for (const l of dictSrc.split('\n')) { const m = l.trim().match(/^\[\/(\^.*?)\/[a-z]*,\s/); if (m && !S.ruleOk(m[1])) ruleOut.push(m[1]); }
  ok('RULES 每一截带中文的字面都在 open 源码里出现过', ruleOut.length === 0, ruleOut.slice(0, 5));
  // 词条段里的注释也会公开出去：主仓的注释会点名那边独有的功能，裁的时候整行拿掉了，只留 @@ 插入标记
  const secs = [section('MAP') || '', section('HTML') || '', dictSrc.slice(dictSrc.indexOf('RULES: ['))];
  const cmt = secs.flatMap(s => s.split('\n')).map(l => l.trim()).filter(l => l.startsWith('//') && !l.includes('@@'));
  ok('词条段里没有注释（只留 @@ 插入标记）', cmt.length === 0, cmt.slice(0, 3));
  // 她的账号名不进公开仓的词典（主仓有一条「欢迎 <账号> 回家」）
  ok('词典里没有写死她的账号名', !/KardKuro/.test(dictSrc));
}

// 跑一遍文件本身（RULES 是 JS 正则字面量，跑不起来就说明有一条写坏了）
let DICT = null;
try { const ctx = { GRANCYAN_I18N_FORCE: true }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(dictSrc, ctx); DICT = ctx.GRANCYAN_I18N_EN; } catch (e) { ok('词典文件能执行', false, e.message); }
// 中文界面（平时用的）不该建这张几百 KB 的表
{
  const z = { localStorage: { getItem: () => 'zh' } }; z.window = z; vm.createContext(z);
  try { vm.runInContext(dictSrc, z); } catch (e) {}
  const e = { localStorage: { getItem: () => 'en' } }; e.window = e; vm.createContext(e);
  try { vm.runInContext(dictSrc, e); } catch (x) {}
  ok('中文界面不建词典，英文界面才建', z.GRANCYAN_I18N_EN === undefined && !!(e.GRANCYAN_I18N_EN && e.GRANCYAN_I18N_EN.MAP));
}
ok('词典挂在 window.GRANCYAN_I18N_EN（MAP / HTML / RULES）', DICT && DICT.MAP && DICT.HTML && Array.isArray(DICT.RULES));
if (DICT) {
  const rb = [];
  for (const r of DICT.RULES) {
    const [re, to] = r || [];
    const why = !(re instanceof RegExp) && !(re && re.constructor && re.constructor.name === 'RegExp') ? '不是正则'
      : /[gy]/.test(re.flags) ? '带 g/y（test 有状态，会隔一次失灵）'
      : !re.source.startsWith('^') ? '没有 ^ 锚'
      : (typeof to !== 'string' && typeof to !== 'function') ? '替换不是字符串'
      : (typeof to === 'string' && CJK.test(to)) ? '替换里有中文'
      : (typeof to === 'string' && [...to.matchAll(/\$(\d+)/g)].some(m => +m[1] > (re.source.match(/\((?!\?)/g) || []).length)) ? '$n 越界'
      : (typeof to === 'string' && (re.source.replace(/\((?:\?:)?[^)]*\)[*+?]?/g, '').match(/[一-鿿]/g) || []).length < 1) ? '字面里一个中文字都没有（太松，会吃掉别的句子）'
      : '';
    if (why) rb.push(why + ' ' + (re && re.source));
  }
  ok(`RULES ${DICT.RULES.length} 条都能编译、^ 开头、不带 g、$n 不越界、替换里没中文、字面带中文`, rb.length === 0, rb.slice(0, 5));
  ok('RULES 至少 400 条（带数字 / 名字的 toast 和面板）', DICT.RULES.length >= 400, DICT.RULES.length);
}

// ═══ 迷你 DOM：够 16-misc.js 用就行（TreeWalker / closest / matches / querySelector / innerHTML / MutationObserver）═══
function makeDom() {
  const VOID = { BR: 1, IMG: 1, INPUT: 1, HR: 1 };
  class Node_ {
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get previousSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return i > 0 ? p.childNodes[i - 1] : null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
  }
  class Text_ extends Node_ {
    constructor(v) { super(); this.nodeType = 3; this.nodeName = '#text'; this._v = v; this.parentNode = null; }
    get nodeValue() { return this._v; }
    set nodeValue(v) { const old = this._v; this._v = v; if (old !== v) doc._mut({ type: 'characterData', target: this }); }
    get textContent() { return this._v; }
  }
  function parseSel(sel) {
    return sel.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const o = { tag: null, cls: [], attr: [] };
      const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)\]/g; let m;
      while ((m = re.exec(s))) { if (m[1]) o.tag = m[1].toUpperCase(); else if (m[2]) o.cls.push(m[2]); else o.attr.push(m[3]); }
      return o;
    });
  }
  class El_ extends Node_ {
    constructor(tag, attrs) { super(); this.nodeType = 1; this.nodeName = tag.toUpperCase(); this.attrs = Object.assign({}, attrs || {}); this.childNodes = []; this.parentNode = null; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    setAttribute(k, v) { const old = this.attrs[k]; this.attrs[k] = String(v); if (old !== String(v)) doc._mut({ type: 'attributes', target: this, attributeName: k }); }
    get className() { return this.attrs.class || ''; }
    append(...ns) { for (const n of ns) { n.parentNode = this; this.childNodes.push(n); } return this; }
    _matchOne(o) {
      if (o.tag && o.tag !== this.nodeName) return false;
      const cl = this.className.split(/\s+/);
      if (o.cls.some(c => !cl.includes(c))) return false;
      if (o.attr.some(a => !this.hasAttribute(a))) return false;
      return true;
    }
    matches(sel) { return parseSel(sel).some(o => this._matchOne(o)); }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    closest(sel) { let e = this; while (e && e.nodeType === 1) { if (e.matches(sel)) return e; e = e.parentNode; } return null; }
    _desc(out) { for (const c of this.childNodes) if (c.nodeType === 1) { out.push(c); c._desc(out); } return out; }
    querySelectorAll(sel) { return this._desc([]).filter(e => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    get innerHTML() {
      return this.childNodes.map(c => c.nodeType === 3 ? c._v : `<${c.nodeName.toLowerCase()}${Object.entries(c.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${VOID[c.nodeName] ? '' : c.innerHTML + `</${c.nodeName.toLowerCase()}>`}`).join('');
    }
    set innerHTML(h) {
      const removed = this.childNodes; this.childNodes = [];
      const stack = [this]; const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g; let m;
      while ((m = re.exec(h))) {
        const top = stack[stack.length - 1];
        if (m[3] !== undefined) top.append(new Text_(m[3]));
        else if (m[0][1] === '/') stack.pop();
        else { const at = {}; for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) at[a[1]] = a[2]; const e = new El_(m[1], at); top.append(e); if (!VOID[e.nodeName]) stack.push(e); }
      }
      doc._mut({ type: 'childList', target: this, addedNodes: this.childNodes.slice(), removedNodes: removed });
    }
  }
  const doc = {
    readyState: 'complete', nodeType: 9, _obs: [],
    _mut(rec) { for (const o of this._obs) o._q.push(Object.assign({ addedNodes: [], removedNodes: [] }, rec)); },
    createTreeWalker(root, what, filter) {
      // 前序遍历：FILTER_REJECT 剪掉整棵，FILTER_SKIP 只跳过自己
      const list = [];
      (function walk(n) {
        for (const c of n.childNodes || []) {
          const shown = (c.nodeType === 1 && (what & 1)) || (c.nodeType === 3 && (what & 4));
          let r = 1;
          if (shown && filter && filter.acceptNode) r = filter.acceptNode(c);
          else if (!shown) r = 3;
          if (r === 1) list.push(c);
          if (r !== 2 && c.nodeType === 1) walk(c);
        }
      })(root);
      let i = 0; return { nextNode: () => list[i++] || null };
    },
    getElementById() { return null; },
    addEventListener() {},
  };
  const html = new El_('html'); const body = new El_('body'); html.append(body); html.parentNode = doc;
  doc.documentElement = html; doc.body = body;
  class MO { constructor(cb) { this.cb = cb; this._q = []; } observe() { doc._obs.push(this); } flush() { const q = this._q; this._q = []; if (q.length) this.cb(q); } }
  return { doc, El: (t, a, ...kids) => new El_(t, a).append(...kids.map(k => typeof k === 'string' ? new Text_(k) : k)), T: v => new Text_(v), MO };
}

function bootMisc(dict, lang) {
  const dom = makeDom();
  const store = { grancyanLang: lang || 'en' };
  const ctx = {
    document: dom.doc, MutationObserver: dom.MO,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    location: { reload() {} }, setTimeout: () => 0, console,
    confirm: m => m, alert: m => m, prompt: m => m,
  };
  ctx.window = ctx;
  if (dict) ctx.GRANCYAN_I18N_EN = dict;
  vm.createContext(ctx);
  return { ctx, dom, run: () => vm.runInContext(read('js/16-misc.js'), ctx) };
}

// ═══ [2] 机制 ═══
console.log('\n[2] 查法');
let spyCalls = 0;
const spy = { source: '^好的(.*)$', flags: '', test() { spyCalls++; return false; }, exec() { spyCalls++; return null; } };
const TD = {
  MAP: { '删除': 'Delete', '好的': 'OK', '设置': 'Settings', '思考过程': 'Reasoning', '名称': 'Name', '切换界面语言 （简体中文 / English）': 'Switch language', '点': 'Tap', '里打开': 'to open it', '编辑': 'Edit', '搜索': 'Search' },
  HTML: { '先点 <b>设置</b> 再说': 'First tap <b>Settings</b>, then talk' },
  RULES: [[/^已删除 (\d+) 条$/, 'Deleted $1'], [/^🗑 ([\s\S]*)$/, 'Bin: $1'], [/^点一下([\s\S]+)$/, 'Tap $1'], [spy, 'x'],
    [/^已添加到云端[:：]/, 'Added to the cloud:'],                       // 没写 $ 锚：后面那截要留着
    [/^(十[一二]?|[一二三])号$/, function (m, d) { return 'No.' + d.length; }],   // 带分支：「十」不是每次都有
    [/^对话「([\s\S]*?)」已恢复$/, 'Conversation "$1" restored'],     // 引号里是她起的名字
    [/^([\s\S]*?)在听$/, '$1 listening'],                              // 宽规则：填进去的查不到就别出半截
    [/^(\d+)块$/, 'A$1'], [/^3块$/, 'B'],                                 // 两条都中：按词典里的先后
  ],
};
const t1 = bootMisc(TD); t1.run();
const L = s => t1.ctx.__i18n.lookup(s, true);
ok('整句', L('删除') === 'Delete');
ok('换行缩进压成一个空格再查', L('切换界面语言\n      （简体中文 / English）') === 'Switch language', L('切换界面语言\n      （简体中文 / English）'));
ok('剥开头 emoji：「🗑 删除」', L('🗑 删除') === '🗑 Delete', L('🗑 删除'));
ok('剥结尾冒号并换成英文的：「名称：」', L('名称：') === 'Name:', L('名称：'));
ok('开头的「，」换成英文逗号', L('，设置') === ', Settings', L('，设置'));
ok('规则：已删除 3 条', L('已删除 3 条') === 'Deleted 3');
ok('规则里填进去的中文也翻（点一下设置 → Tap Settings）', L('点一下设置') === 'Tap Settings', L('点一下设置'));
ok('剥符号后整句查得到的，先于宽规则（「🗑 删除」不让 ^🗑 (.*) 抢走）', L('🗑 删除') === '🗑 Delete', L('🗑 删除'));
ok('没写 $ 锚的规则只换匹配到的那段，后面的文件名留着', L('已添加到云端: cat.png') === 'Added to the cloud: cat.png', L('已添加到云端: cat.png'));
ok('带分支的规则不会被预筛误杀（「三号」里没有「十」也要试）', L('三号') === 'No.1', L('三号'));
ok('引号里的名字原样放回（她起的标题叫「设置」也不翻）', L('对话「设置」已恢复') === 'Conversation "设置" restored', L('对话「设置」已恢复'));
ok('宽规则填进去的那段查不到 → 整句留中文（不出「我一直 listening」）', L('我一直在听') === null, L('我一直在听'));
ok('两条规则都中时按词典里的先后（分桶不改顺序）', L('3块') === 'A3', L('3块'));
ok('查不到返回 null（不乱翻）', L('一句词典里没有的话') === null);
ok('英文模式以外 i18nText 原样返回', (() => { const z = bootMisc(TD, 'zh'); z.run(); return z.ctx.i18nText('删除') === '删除'; })());

console.log('\n[2b] 整段换 + 补空格');
{
  const { dom, ctx } = t1;
  const blk = dom.El('div', { class: 'help-desc' }, '先点 ', dom.El('b', {}, '设置'), ' 再说');
  const frag = dom.El('p', {}, '点', dom.El('b', {}, '设置'), '里打开');
  const inp = dom.El('input', { placeholder: '搜索', title: '编辑' });
  dom.doc.body.append(blk, frag, inp);
  ctx.__i18n.translateTree(dom.doc.body);
  ok('功能指南整段按 innerHTML 换成英文', blk.innerHTML === 'First tap <b>Settings</b>, then talk', blk.innerHTML);
  ok('被 <b> 切开的半句，英文之间补上空格', frag.textContent === 'Tap Settings to open it', frag.textContent);
  ok('placeholder / title 也翻', inp.getAttribute('placeholder') === 'Search' && inp.getAttribute('title') === 'Edit', inp.attrs);
}

// ═══ [3] 消息正文不翻 ═══
console.log('\n[3] 消息正文 / 她和 AI 写的内容不翻');
const MSG_CASES = () => {
  const b = bootMisc(TD); const { dom } = b;
  const think = dom.El('div', { class: 'think-block' },
    dom.El('div', { class: 'think-toggle' }, dom.El('span', { class: 'think-label' }, '思考过程')),
    dom.El('div', { class: 'think-body' }, '设置'));
  const aiBubble = dom.El('div', { class: 'bubble ai' }, think, dom.El('p', {}, '好的'), dom.El('p', {}, '删除'));
  const userBubble = dom.El('div', { class: 'bubble user' }, '删除');
  const quote = dom.El('div', { class: 'bubble-quote' }, '设置');
  const mem = dom.El('span', { class: 'memory-text' }, '好的');
  const custom = dom.El('div', { 'data-no-i18n': '' }, '设置', dom.El('span', { title: '删除' }, 'x'));
  const longMsg = dom.El('div', { class: 'msg-attach' }, dom.El('div', { class: 'msg-attach-meta' }, '设置'), dom.El('div', { class: 'msg-attach-body' }, '删除'));
  const sumToggle = dom.El('div', { class: 'think-toggle' }, dom.El('span', { class: 'think-label' }, '💭 ', dom.El('span', { 'data-no-i18n': '' }, '设置')));
  const aiBubble2 = dom.El('div', { class: 'bubble ai' }, sumToggle);
  const actions = dom.El('div', { class: 'msg-actions' }, dom.El('button', {}, '编辑'), dom.El('button', {}, '删除'));
  dom.doc.body.append(aiBubble, userBubble, quote, mem, custom, actions, longMsg, aiBubble2);
  b.run();   // boot：整页翻一遍 + 开观察器
  return { b, dom, think, aiBubble, userBubble, quote, mem, custom, actions, longMsg, sumToggle };
};
{
  const { b, dom, think, aiBubble, userBubble, quote, mem, custom, actions, longMsg, sumToggle } = MSG_CASES();
  ok('超过 320 字画成附件卡的长消息，正文原样', longMsg.childNodes[1].textContent === '删除', longMsg.textContent);
  ok('思考块标题上模型写的概括原样（标题那行照翻，概括挂了 data-no-i18n）', sumToggle.textContent === '💭 设置', sumToggle.textContent);
  ok('AI 回复正文里的「好的」「删除」原样', aiBubble.childNodes[1].textContent === '好的' && aiBubble.childNodes[2].textContent === '删除', aiBubble.textContent);
  ok('她发的「删除」原样', userBubble.textContent === '删除');
  ok('思考正文原样', think.childNodes[1].textContent === '设置');
  ok('引用原样', quote.textContent === '设置');
  ok('记忆正文原样', mem.textContent === '好的');
  ok('挂 data-no-i18n 的容器整棵不翻（连 title 也不翻）', custom.childNodes[0].textContent === '设置' && custom.childNodes[1].getAttribute('title') === '删除');
  ok('气泡外面的操作按钮照翻', actions.textContent === 'EditDelete', actions.textContent);
  ok('气泡里的界面零件（思考块标题）照翻', think.childNodes[0].textContent === 'Reasoning', think.childNodes[0].textContent);
  // 流式：气泡每帧改字 / 整块重画
  spyCalls = 0;
  const p = aiBubble.childNodes[1];
  p.childNodes[0].nodeValue = '好的，我在';             // characterData
  p.innerHTML = '好的 删除';                             // childList（流式重画）
  const obs = dom.doc._obs[0]; obs && obs.flush();
  ok('流式改字后气泡里还是中文', p.textContent === '好的 删除', p.textContent);
  ok('流式改气泡时一条规则都没跑（不每帧跑 RULES）', spyCalls === 0, spyCalls);
  // 对照：同样的变动发生在气泡外面，会被翻、规则也会被试
  const out = dom.El('div', {}, 'x'); dom.doc.body.append(out);
  out.innerHTML = '删除'; out.innerHTML = '好的呀'; obs && obs.flush();
  ok('对照：气泡外的新节点照翻', out.textContent === '好的呀' || out.textContent === 'OK', out.textContent);
  ok('对照：气泡外查不到的字会去试规则', spyCalls > 0, spyCalls);
}
// 选择器和渲染层对得上：气泡、引用、思考正文这几个 class 还是 06-render-msg.js 里画的那几个
{
  const misc = read('js/16-misc.js'), rm = read('js/06-render-msg.js');
  const no = (misc.match(/var NO_I18N = ([^;]+);/) || [])[1] || '';
  for (const c of ['bubble', 'bubble-quote', 'think-body', 'user-thinking-body'])
    ok(`跳过名单里有 .${c}，渲染层也真的画这个 class`, no.includes(`'.${c}`) || no.includes(`,.${c}`) ? new RegExp(`class="${c}[ "]`).test(rm) : false);
}

// ═══ [3b] 几处得在代码里配合的 ═══
console.log('\n[3b] 代码里配合英文界面的几处');
{
  const cw = read('js/41-code-workbench.js');
  // 英文提示叫她输 delete / permanently delete / clear，校验那头只认中文的话就永远删不掉
  ok('工作台「输入 删除 继续」也认 delete', /\[\s*'删除',\s*'delete'\s*\]\.includes\(/.test(cw));
  ok('工作台「输入 彻底删除 继续」也认 permanently delete', /\[\s*'彻底删除',\s*'permanently delete'\s*\]\.includes\(/.test(cw));
  ok('工作台「输入 清空 继续」也认 clear', /\[\s*'清空',\s*'clear'\s*\]\.includes\(/.test(cw));
  const r = DICT ? DICT.RULES.filter(([re]) => /输入“(删除|彻底删除|清空)”继续/.test(re.source)) : [];
  ok('对应的三条英文提示里叫她输的正是这三个词', r.length === 3 && r.every(([re, to]) => /"(delete|permanently delete|clear)"/.test(String(to))), r.map(x => String(x[1])));
  // 一个字一个 span 拆开的大标题：拆之前先整句翻（不然单字查不到，或者被单字词条翻成别的意思）
  ok('空对话的大标题先 i18nText 再拆字', /Array\.from\(typeof i18nText === 'function' \? i18nText\('在这里开始聊天吧/.test(read('js/06-render-msg.js')));
  ok('空对话的大标题词典里有', !!DICT && Object.prototype.hasOwnProperty.call(DICT.MAP, '在这里开始聊天吧 ‿︵‿'));
  // （主仓还守着天气页的报纸背景先整句翻；open 的天气页没有那张报纸）
  const rm = read('js/06-render-msg.js'), pa = read('js/05-prompts-api.js'), cm = read('js/03-chats-models.js');
  ok('思考概括包在 data-no-i18n 里（两处画法都包了）', [rm, pa].every(x => x.includes('💭 <span data-no-i18n>${thinkVeil(escHtml(thinkingSummary))}</span>')));
  ok('消息上的模型昵称、群聊发言人挂 data-no-i18n', /class="accent-text" data-no-i18n/.test(rm) && /class="gc-sender-name" data-no-i18n/.test(rm));
  ok('侧栏和顶栏的对话标题不进词典（只有默认标题照翻）', /<span data-no-i18n>\$\{escHtml\(c\.title === '崭新の对话'/.test(cm) && /id="currentChatTitle" data-no-i18n/.test(read('index.html')));
}

// ═══ [4] index.html 静态覆盖率 ═══
console.log('\n[4] index.html 静态中文覆盖率');
{
  const html = read('index.html');
  const t = bootMisc(DICT || TD); t.run();
  const look = s => t.ctx.__i18n.lookup(s, true);
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, '').replace(/<pre\b[\s\S]*?<\/pre>/gi, '');
  // 功能指南的整段（.help-desc）按整段算，里面的碎片不单算
  const blocks = [];
  let noBlocks = body.replace(/<div class="help-desc"[^>]*>([\s\S]*?)<\/div><\/div>/g, (m, inner) => { blocks.push(inner.replace(/\s+/g, ' ').trim()); return '</div>'; });
  // 挂 data-i18n-block 的（小组件页拆成一个字一个 span 的标题、键帽字）也按整段算：按同名标签配平找到它的 innerHTML
  const dib = [];
  for (let m, re = /<(\w+)\b[^>]*\bdata-i18n-block\b[^>]*>/g; (m = re.exec(noBlocks));) {
    const tag = m[1], start = m.index + m[0].length, tr = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'); tr.lastIndex = start;
    let depth = 1, end = -1;
    for (let x; (x = tr.exec(noBlocks));) { depth += x[1] ? -1 : 1; if (!depth) { end = x.index; break; } }
    if (end > 0) dib.push([m.index, end, noBlocks.slice(start, end).replace(/\s+/g, ' ').trim()]);
  }
  for (const [a, b, inner] of dib.reverse()) { blocks.push(inner); noBlocks = noBlocks.slice(0, a) + noBlocks.slice(b); }
  const ent = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const items = new Set();
  for (const s of noBlocks.split(/<[^>]*>/)) { const v = ent(s).trim(); if (v && CJK.test(v)) items.add(v); }
  for (const m of noBlocks.matchAll(/\s(placeholder|title|aria-label)\s*=\s*("([^"]*)"|'([^']*)')/g)) { const v = ent(m[3] ?? m[4]).trim(); if (CJK.test(v)) items.add(v); }
  const miss = [...items].filter(s => look(s) == null);
  const cov = 1 - miss.length / Math.max(1, items.size);
  console.log(`    文字 / 属性 ${items.size} 条，没翻 ${miss.length} 条（${(cov * 100).toFixed(1)}%）` + (miss.length ? '：' + miss.slice(0, 8).map(s => JSON.stringify(s.slice(0, 30))).join(' ') : ''));
  ok('index.html 静态文字 + 属性覆盖率 ≥ 97%', cov >= 0.97, { cov: +cov.toFixed(3), miss: miss.length });
  const H = (DICT && DICT.HTML) || {};
  const bmiss = blocks.filter(b => CJK.test(b) && !Object.prototype.hasOwnProperty.call(H, b));
  const bcov = 1 - bmiss.length / Math.max(1, blocks.length);
  console.log(`    功能指南整段 ${blocks.length} 段，没翻 ${bmiss.length} 段（${(bcov * 100).toFixed(1)}%）`);
  ok('功能指南整段覆盖率 ≥ 95%', blocks.length > 200 && bcov >= 0.95, { blocks: blocks.length, miss: bmiss.length, first: bmiss[0] && bmiss[0].slice(0, 80) });
  ok('词典在机制前面加载（index.html 里 16-i18n-en.js 排在 16-misc.js 前）', (() => { const a = html.indexOf('./js/16-i18n-en.js'), b = html.indexOf('./js/16-misc.js'); return a > 0 && b > a; })());
  ok('词典只在选了 English 时才载（中文界面连下载带解析都省掉）', html.includes("if (localStorage.getItem('grancyanLang') === 'en') document.write('<script src=\"./js/16-i18n-en.js\"><\\/script>')"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
