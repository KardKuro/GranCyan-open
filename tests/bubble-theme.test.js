'use strict';
// 气泡主题：导入 KakaoTalk 的 .ktheme（用户清单第 2 条）
//
// 这份测试**自己造 zip**，不去读本机收集的那些真主题包。
// 理由：依赖用户本机的文件的话，换台机器或者她挪走文件夹，测试就变成
// 静默跳过或者假绿 —— 而"假绿"正是这个仓库反复吃过的亏。
// 造包用的是真的 deflate + 真的 zip 结构，所以走的还是同一条解析路径。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function main() {
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const bub = read('js/43-bubble.js');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/grancyan.css');
const html = read('index.html');

// ── 造一个真 zip ───────────────────────────────────────────────────────
// 手写 zip：本地文件头 + 数据 + 中央目录 + EOCD。压缩用真的 deflateRaw，
// 这样 DecompressionStream('deflate-raw') 那条路是真的被走过的。
function makeZip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = f.store ? raw : zlib.deflateRawSync(raw);
    const method = f.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(cd, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// 只要头对就够 —— 解析器只从 IHDR 读宽高，从不解码像素
function fakePng(w, h, padBytes = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(padBytes, 0x5a)]);
}

const THEME_CSS = (bgColor) => `
MessageCellStyle-Send
{
    -ios-background-image: 'chatroomBubbleSend01.png' 34px 31px;
    -ios-title-edgeinsets: 20px 16px 10px 18px;  /* top, left, bottom, right */
    -ios-text-color: #df88f3;
}
MessageCellStyle-Receive
{
    -ios-background-image: 'chatroomBubbleReceive01.png' 12px 9px;
    -ios-title-edgeinsets: 11px 14px 9px 15px;
    -ios-text-color: #303030;
}
BackgroundStyle-ChatRoom
{
    background-color: ${bgColor};
    -ios-background-image: 'chatroomBgImage.png';
}
`;

function makeKtheme(opts = {}) {
  return makeZip([
    { name: 'KakaoTalkTheme.css', data: THEME_CSS(opts.bg === undefined ? '#FFDEDE' : opts.bg) },
    { name: 'Images/chatroomBubbleSend01@3x.png', data: fakePng(300, 200) },
    { name: 'Images/chatroomBubbleReceive01@3x.png', data: fakePng(180, 120) },
    { name: 'Images/chatroomBgImage@3x.png', data: fakePng(400, 800, opts.bgPad || 0) }
  ]);
}

// ── 沙箱 ───────────────────────────────────────────────────────────────
function sandbox() {
  const idb = new Map();
  const styleEl = { id: '', textContent: '' };
  const bodyCls = new Set();
  const els = {};
  const box = {
    state: {},
    _saves: 0, _toasts: [],
    save() { box._saves++; },
    showToast(m) { box._toasts.push(m); },
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    async idbSet(k, v) { idb.set(k, v); },
    async idbGet(k) { return idb.has(k) ? idb.get(k) : null; },
    async idbDel(k) { idb.delete(k); },
    confirm: () => box._confirm !== false,
    document: {
      getElementById: id => (id === 'bubbleThemeVars' ? (box._styleMounted ? styleEl : null) : (els[id] || null)),
      createElement: () => styleEl,
      head: { appendChild: () => { box._styleMounted = true; } },
      body: {
        classList: {
          add: (...c) => c.forEach(x => bodyCls.add(x)),
          remove: (...c) => c.forEach(x => bodyCls.delete(x)),
          toggle: (c, on) => (on ? bodyCls.add(c) : bodyCls.delete(c)),
          contains: c => bodyCls.has(c)
        }
      }
    },
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    DataView, Uint8Array, ArrayBuffer, TextDecoder, Blob, Response, DecompressionStream, btoa,
    setTimeout, Array_from: Array.from
  };
  box.window = box;
  box._idb = idb; box._style = styleEl; box._cls = bodyCls; box._els = els;
  vm.createContext(box);
  // const 声明不会挂到 vm 的全局对象上（只有 var/function 会），所以显式导出一份
  vm.runInContext(bub + ';this.__t = { _bkEntries, _bkB64, _bkSlice, _bkParseCss, _bkPngSize, _bkVars, _bkIndex, _bkStore, _bkLoad, _bkKey, _bkColor, _bkRgb, _bkFade };', box);
  return box;
}

const toBuf = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

console.log('\n气泡主题 — zip 解析');
{
  const b = sandbox();
  const zip = makeKtheme();
  const entries = b.__t._bkEntries(toBuf(zip));
  t('中央目录读得出全部 4 个条目', entries.length === 4, entries.map(e => e.name));
  t('条目名是 utf-8 解出来的', entries[0].name === 'KakaoTalkTheme.css', entries[0].name);
  t('压缩方式是 deflate（8）', entries[0].method === 8, entries[0].method);

  let threw = '';
  try { b.__t._bkEntries(toBuf(Buffer.from('这不是个 zip'))); } catch (e) { threw = e.message; }
  t('不是 zip 会明确报错而不是返回空数组', /EOCD/.test(threw), threw);
}

console.log('\n气泡主题 — cap 换算');
{
  const b = sandbox();
  // caps 只给左和上；右下 = 剩下的减掉中间那一个可拉伸点
  const s = b.__t._bkSlice([34, 31], { w: 300, h: 200 }, 3);
  t('left = 34×3', s.left === 102, s);
  t('top = 31×3', s.top === 93, s);
  t('right = 宽 − left − scale', s.right === 300 - 102 - 3, s);
  t('bottom = 高 − top − scale', s.bottom === 200 - 93 - 3, s);

  // 没有可拉伸区的包画不出来，必须挡掉而不是画出一坨
  t('caps 大到没有拉伸区时返回 null', b.__t._bkSlice([100, 100], { w: 200, h: 150 }, 3) === null);
  t('caps 是负数时返回 null', b.__t._bkSlice([-5, 10], { w: 200, h: 150 }, 1) === null);
}

console.log('\n气泡主题 — 颜色的三种野写法');
{
  const b = sandbox();
  const c = (v) => b.__t._bkColor(v, 'FB');
  // 下面三种在用户那 38 个包里都真出现过
  t('#df88f3 原样收下', c('#df88f3') === '#df88f3');
  t('FFFFFF 不带 # 也认（帕恰狗的底色）', c('FFFFFF') === '#FFFFFF', c('FFFFFF'));
  t('rgb(74, 56, 42) 也认（딸기 토끼쿠우 的字色）', c('rgb(74, 56, 42)') === 'rgb(74, 56, 42)', c('rgb(74, 56, 42)'));
  t('rgba 带小数也认', c('rgba(1,2,3,.5)') === 'rgba(1,2,3,.5)', c('rgba(1,2,3,.5)'));
  t('空的 # 退兜底（脑子流水）', c('#') === 'FB', c('#'));
  t('空字符串退兜底', c('') === 'FB' && c(undefined) === 'FB');
  t('认不出来的东西退兜底而不是原样塞进 css', c('url(evil)') === 'FB', c('url(evil)'));
}

console.log('\n气泡主题 — 由字色派生出淡两档');
{
  const b = sandbox();
  const { _bkRgb, _bkFade } = b.__t;
  // 歌名、时间、次要说明这些走 --text-muted / --text-dim，得由主题字色派生
  t('#df88f3 拆得出 rgb', String(_bkRgb('#df88f3')) === '223,136,243', _bkRgb('#df88f3'));
  t('三位简写也拆得出（#000 是真主题在用的写法）', String(_bkRgb('#000')) === '0,0,0', _bkRgb('#000'));
  t('八位带 alpha 的取前六位', String(_bkRgb('#df88f3cc')) === '223,136,243', _bkRgb('#df88f3cc'));
  t('rgb() 形式也拆得出', String(_bkRgb('rgb(74, 56, 42)')) === '74,56,42', _bkRgb('rgb(74, 56, 42)'));
  t('淡一档是同色加 alpha', _bkFade('#df88f3', 0.72) === 'rgba(223,136,243,0.72)', _bkFade('#df88f3', 0.72));
  // 认不出来时原样退回：宁可淡一档没生效，也不能吐一个非法颜色 ——
  // 非法值会让整条声明作废，字直接退回浅色，在浅气泡上还是看不见
  t('认不出来的颜色原样退回，不吐非法值', _bkFade('currentColor', 0.5) === 'currentColor', _bkFade('currentColor', 0.5));

  const vars = b.__t._bkVars({ send: { slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 1, pad: [1, 1, 1, 1], color: '#df88f3', src: 'x' },
                         recv: { slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 1, pad: [1, 1, 1, 1], color: '#303030', src: 'x' },
                         bgColor: '#fff', bgSrc: '', pixel: false });
  t('两侧的 soft/faint 都写出来了',
    ['send', 'recv'].every(k => vars.includes(`--bub-${k}-soft:`) && vars.includes(`--bub-${k}-faint:`)), vars.slice(0, 0));
}

console.log('\n气泡主题 — 解一个完整的包');
{
  const b = sandbox();
  const t1 = await b.parseKtheme(toBuf(makeKtheme()), '糖果系');
  t('send 图取到了 @3x', t1.send.scale === 3, t1.send.scale);
  t('send 是 data URL', t1.send.src.startsWith('data:image/png;base64,'));
  t('send 字色取自 -ios-text-color', t1.send.color === '#df88f3', t1.send.color);
  t('recv 字色取自它自己那一节', t1.recv.color === '#303030', t1.recv.color);
  // edgeinsets 是 top left bottom right，css padding 是 top right bottom left
  t('padding 顺序换对了（左右调过来）', t1.send.pad.join() === '20,18,10,16', t1.send.pad);
  t('底色读到了', t1.bgColor === '#FFDEDE', t1.bgColor);
  t('背景图也收进来了', t1.bgSrc.startsWith('data:image/png;base64,'));

  // 有几个真主题（脑子流水、딸기 토끼쿠우）这里写的就是个空 '#'，
  // 直接拿去用会画出透明底 —— 零报错，看着就是"背景没换"
  const t2 = await b.parseKtheme(toBuf(makeKtheme({ bg: '#' })), '脑子流水');
  t('底色是空的 # 时兜底', /^#[0-9a-f]{6}$/i.test(t2.bgColor), t2.bgColor);

  // ⚠️ 真撞过：sanitize 之后「糖果系」和「简线条」都是 '___'
  const t3 = await b.parseKtheme(toBuf(makeKtheme()), '简线条');
  t('同名会撞的两个主题 id 不同', t1.id !== t3.id, [t1.id, t3.id]);
  t('名字原样留着，不 sanitize', t3.name === '简线条', t3.name);

  let bad = '';
  try {
    await b.parseKtheme(toBuf(makeZip([{ name: 'readme.txt', data: 'hi' }])), 'x');
  } catch (e) { bad = e.message; }
  t('包里没有主题 css 会报错', /KakaoTalkTheme\.css/.test(bad), bad);

  // 图缺一半的包不能算导入成功，否则列表里会多一条点了没反应的
  let half = '';
  try {
    await b.parseKtheme(toBuf(makeZip([
      { name: 'KakaoTalkTheme.css', data: THEME_CSS('#fff') },
      { name: 'Images/chatroomBubbleSend01@3x.png', data: fakePng(300, 200) }
    ])), 'x');
  } catch (e) { half = e.message; }
  t('只有一半气泡图的包被拒', /读不出来/.test(half), half);
}

console.log('\n气泡主题 — base64 分块');
{
  const b = sandbox();
  // 背景图动辄 800KB。String.fromCharCode.apply 一次喂这么多参数会爆栈，
  // 所以必须分块 —— 这条测的就是"真的分了"。
  const big = new Uint8Array(900 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  let ok = true, out = '';
  try { out = b.__t._bkB64(big); } catch (e) { ok = false; out = e.message; }
  t('900KB 不爆栈', ok, out.slice ? out.slice(0, 60) : out);
  t('转出来的 base64 长度对得上', ok && out.length === Math.ceil(big.length / 3) * 4, ok && out.length);
  t('内容和 Node 的 base64 一致', ok && out === Buffer.from(big).toString('base64'));
}

console.log('\n气泡主题 — 导入');
{
  const b = sandbox();
  const mkFile = (name, buf) => ({ name, arrayBuffer: async () => toBuf(buf) });

  await b.importBubbleFiles({ files: [mkFile('糖果系.ktheme', makeKtheme())], value: '' });
  t('导入一个 .ktheme 之后索引里有一条', b.state.bubbleThemes.length === 1, b.state.bubbleThemes);
  t('图本体没塞进 state', JSON.stringify(b.state).indexOf('data:image') < 0);
  t('图本体在 IDB 单独一条', [...b._idb.keys()].some(k => k.startsWith('kuro_bubtheme_')), [...b._idb.keys()]);
  t('导入完存了盘', b._saves > 0);

  // 用户的「糖果.zip」就是这样：一个 zip 裹着三个 ktheme
  b.state.bubbleThemes = [];
  const inner = makeZip([
    { name: '0_PIXEL 01.ktheme', data: makeKtheme(), store: true },
    { name: '0_PIXEL 02.ktheme', data: makeKtheme(), store: true }
  ]);
  await b.importBubbleFiles({ files: [mkFile('糖果.zip', inner)], value: '' });
  t('zip 里裹着的 ktheme 会被递归解出来', b.state.bubbleThemes.length === 2, b.state.bubbleThemes.map(x => x.name));
  t('内层主题的名字取自 zip 里的条目名',
    b.state.bubbleThemes.map(x => x.name).sort().join() === '0_PIXEL 01,0_PIXEL 02',
    b.state.bubbleThemes.map(x => x.name));

  // 38 个主题攒下来几十 MB，IDB 配额是会满的。写盘失败时如果索引已经加了，
  // 列表里就留下一条点了没反应的死条目 —— 所以顺序必须是「先写盘、后进索引」。
  {
    const b2 = sandbox();
    b2.idbSet = async () => { throw new Error('QuotaExceededError'); };
    vm.createContext(b2);
    b2._toasts.length = 0;
    await b2.importBubbleFiles({ files: [mkFile('兔子.ktheme', makeKtheme())], value: '' });
    t('IDB 写不进去时不在索引里留死条目', (b2.state.bubbleThemes || []).length === 0, b2.state.bubbleThemes);
    t('并且报出来', /一个都没导进来/.test(b2._toasts.join()), b2._toasts);
  }

  // 安卓版主题资源名被混淆，解出来是一堆 res/1r.png，认不回去。
  // 与其静默塞一堆废图，不如直说 —— 而且要说清楚该去找哪个版本。
  b._toasts.length = 0;
  const before = b.state.bubbleThemes.length;
  await b.importBubbleFiles({ files: [mkFile('彩虹熊.apk', makeKtheme())], value: '' });
  t('.apk 被拒，列表没变长', b.state.bubbleThemes.length === before);
  t('.apk 的提示说了一个都没进来', /一个都没导进来/.test(b._toasts.join()), b._toasts);
}

console.log('\n气泡主题 — 生效与撤销');
{
  const b = sandbox();
  const mkFile = (name, buf) => ({ name, arrayBuffer: async () => toBuf(buf) });
  await b.importBubbleFiles({ files: [mkFile('糖果系.ktheme', makeKtheme())], value: '' });
  const id = b.state.bubbleThemes[0].id;

  await b.applyBubbleTheme(id);
  t('套上之后 body 有 has-bubble-theme', b._cls.has('has-bubble-theme'), [...b._cls]);
  t('默认连背景一起换', b._cls.has('has-bubble-bg'), [...b._cls]);
  t('变量写进了 style 标签', /--bub-send-src:url\("data:image/.test(b._style.textContent));

  // 这条是真正的集成断言：css 里 var() 用到的每个名字，js 都得真的写出来。
  // 少一个的话就是"气泡没变样"——零报错，最难查的那种。
  const block = css.slice(css.indexOf('气泡主题（导入的 .ktheme）'));
  const used = [...new Set([...block.matchAll(/var\((--bub-[a-z-]+)/g)].map(m => m[1]))];
  const missing = used.filter(v => b._style.textContent.indexOf(v + ':') < 0);
  t('css 里用到的 --bub-* 变量 js 全都写了', missing.length === 0, { used, missing });

  b.toggleBubbleThemeBg(false);
  t('取消勾选后背景那层撤掉，气泡还在',
    !b._cls.has('has-bubble-bg') && b._cls.has('has-bubble-theme'), [...b._cls]);

  await b.toggleBubbleThemePixel(id, true);
  t('勾像素风 → pixelated', /--bub-render:pixelated/.test(b._style.textContent));
  await b.toggleBubbleThemePixel(id, false);
  t('取消 → auto', /--bub-render:auto/.test(b._style.textContent));

  await b.applyBubbleTheme('');
  t('换回默认会清空变量', b._style.textContent === '', b._style.textContent.slice(0, 40));
  t('换回默认会摘掉两个 class', !b._cls.has('has-bubble-theme') && !b._cls.has('has-bubble-bg'), [...b._cls]);

  // 索引里有、IDB 里没有：不能变成一条点了没反应的死条目
  await b.applyBubbleTheme(id);
  b._idb.delete(b.__t._bkKey(id));
  b._toasts.length = 0;
  await b.applyBubbleTheme(id);
  t('数据丢了的主题会被自己从索引里摘掉', b.state.bubbleThemes.length === 0, b.state.bubbleThemes);
  t('并且告诉用户', /丢了/.test(b._toasts.join()), b._toasts);
  t('body 上的 class 也跟着撤干净', !b._cls.has('has-bubble-theme'), [...b._cls]);
}

console.log('\n气泡主题 — 删除');
{
  const b = sandbox();
  const mkFile = (name, buf) => ({ name, arrayBuffer: async () => toBuf(buf) });
  await b.importBubbleFiles({ files: [mkFile('兔子.ktheme', makeKtheme())], value: '' });
  const id = b.state.bubbleThemes[0].id;
  await b.applyBubbleTheme(id);

  b._confirm = false;
  await b.deleteBubbleTheme(id);
  t('confirm 点取消就不删', b.state.bubbleThemes.length === 1);

  b._confirm = true;
  await b.deleteBubbleTheme(id);
  t('确认后索引里没了', b.state.bubbleThemes.length === 0);
  t('IDB 里那份图也删了', !b._idb.has(b.__t._bkKey(id)), [...b._idb.keys()]);
  t('删的正好是在用的那个 → 自动退回默认', b.state.bubbleTheme === '' && !b._cls.has('has-bubble-theme'));
}

console.log('\n气泡主题 — 三道持久化闸口');
{
  for (const f of ['bubbleThemes', 'bubbleTheme', 'bubbleThemeBg']) {
    const key = 'kuro_' + f;
    // 这三处漏一处就是"刷新之后设置回到默认"，而且一声不吭
    t(f + ' 在 01-core 的读取名单里', core.indexOf(key) >= 0);
    t(f + ' 在 02-state 的 _doSave 里', new RegExp("idbSet\\('" + key + "'").test(stateJs));
    t(f + ' 在 14-boot 的赋值块里', new RegExp('state\\.' + f + '\\s*=').test(boot));
  }
  t('开机时会去套用主题', /applyBubbleTheme\(\)/.test(boot));
}

console.log('\n气泡主题 — 挂载点');
{
  t('index.html 引了 43-bubble.js', html.indexOf('js/43-bubble.js') >= 0);
  t('设置里有导入按钮', html.indexOf('importBubbleFiles(this)') >= 0);
  t('设置里有主题列表的挂点', html.indexOf('id="bubbleThemeList"') >= 0);
  t('文件选择器收 .ktheme 和 .zip', /accept="\.ktheme,\.zip"/.test(html));
  t('可以一次选多个', /id="bubbleFileInput"[^>]*multiple/.test(html));

  // ⚠️ 这条守的是级联顺序。气泡那一块和 solo 模式那几条权重相同（1-6-1），
  //    全靠"写在后面"取胜。有人把它挪到前面去的话，气泡会静默保持默认样子。
  const iBub = css.indexOf('气泡主题（导入的 .ktheme）');
  // 只认行首的真选择器 —— 用裸字符串搜的话，会命中我自己在注释里提到的那句
  const solo = [...css.matchAll(/^body\.bg-light-boost #chatWindow\.gc-mode-solo/gm)];
  const iSolo = solo.length ? solo[solo.length - 1].index : -1;
  t('气泡那块 css 排在 solo 模式那几条后面', iSolo > 0 && iBub > iSolo, { iBub, iSolo });
  // 光查「文件里出现过 :not(.bubble-sticker)」太松：漏掉其中一条照样绿，
  // 而漏掉的那条会把贴纸也套上气泡皮 —— 贴纸本来是 padding:0 background:none 的。
  // 所以逐条选择器查：凡是点到 .bubble 的，都得带上排除。
  const cssBlock = css.slice(iBub);
  const selectors = [...cssBlock.matchAll(/^body\.has-bubble-(?:theme|bg)[^{]*/gm)].map(m => m[0]);
  const naked = selectors.filter(s => /\.bubble(\.|[\s,])/.test(s))
                         .flatMap(s => s.split(',').map(x => x.trim()))
                         .filter(x => /\.bubble(\.|[\s]|$)/.test(x) && !/:not\(\.bubble-sticker\)/.test(x));
  t('每一条点到气泡的规则都排除了贴纸', selectors.length > 0 && naked.length === 0, naked);

  // background-attachment:local 会把定位区域算成「整段聊天记录」，
  // cover 于是按几千像素的历史高度缩放，聊天越长壁纸拉得越离谱。
  // 短对话里完全看不出来 —— 典型的静默错。
  const bgBlock = (css.match(/body\.has-bubble-bg #chatWindow\s*\{[^}]*\}/) || [''])[0];
  t('找得到聊天区铺底的规则', bgBlock.length > 0);
  t('铺底没用 background-attachment:local', !/background-attachment/.test(bgBlock), bgBlock);
  t('链接药丸在浅色气泡上翻成浅底', /has-bubble-theme[^{]*a\[href\^="http"\]/.test(css));

  // ⚠️ 这条守的是 2026-08-29 那个「淡淡的绿矩形」的真根因。
  // 原来的选择器要求 .msg-group.ai / .msg-group.user 做祖先，落在别的壳里的气泡
  // 整条规则不匹配 —— .bubble.ai 自带的 backdrop-filter:blur(16px) 原样活着，
  // 把壁纸按气泡的边框盒糊出一个矩形，从气泡图的透明边距里露出来。
  // 零报错，而且只在「有壁纸 + 气泡不在那个壳里」时才看得见。
  const themed = selectors.filter(s => /has-bubble-theme/.test(s));
  t('气泡规则不依赖 .msg-group 祖先', themed.length > 0 && themed.every(s => !s.includes('.msg-group')),
    themed.filter(s => s.includes('.msg-group')));

  // 主题的图就是气泡本身，别的东西不许再往这个盒子上画。竞争者有：
  // 行内 style（阴影）、solo 模式更高权重的选择器、bg-light-boost 的补底。
  // 尤其 `border:none` 是简写，会**连 border-image 一起重置** —— 不 important 的话
  // solo 模式下气泡图直接不显示（实测过）。
  // 只看「气泡盒子本身」那几条规则 —— 内部子元素（think-body、代码、链接药丸）
  // 的背景不该也不能 important，把它们算进来这条断言就永远红。
  const rules = [...cssBlock.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
  const boxRules = rules.filter(r => r.sel.split(',')
    .every(s => /\.bubble\.(?:user|ai):not\(\.bubble-sticker\)\s*$/.test(s.trim())));
  t('找得到气泡盒子那几条规则', boxRules.length >= 3, boxRules.length);
  for (const p of ['background', 'backdrop-filter', 'box-shadow', 'border-image-source', 'padding']) {
    const hits = boxRules.flatMap(r =>
      [...r.body.matchAll(new RegExp('^\\s*' + p + ':\\s*([^;]+)', 'gm'))].map(m => m[1].trim()));
    t(p + ' 一律 !important', hits.length > 0 && hits.every(h => /!important/.test(h)), hits);
  }
  // 气泡内部一大票元素按 --text-* 上色，那套是浅字配深底。
  // 不重定义的话，浅色气泡上歌名、时间、次要说明全是白的。
  // ⚠️ 不能只查「出现过」：send / recv 两侧各有一份，坏掉一侧另一侧照样让断言绿。
  //    2026-08-29 故障注入实测逮到过这条假绿（只坏 recv，断言不红）。
  //    所以两份都要取出来逐个看。
  for (const v of ['--text-primary', '--text-secondary', '--text-muted', '--text-dim']) {
    const hits = [...cssBlock.matchAll(new RegExp(v + ':\\s*([^;]+);', 'g'))].map(m => m[1].trim());
    t(v + ' 收发两侧都重定义成主题色',
      hits.length === 2 && hits.every(h => h.startsWith('var(--bub-')), hits);
  }
  // 这两个把颜色写死在规则里，变量救不到 —— 用户截图里看不见的正是它们
  t('think-body / user-thinking-body 单独点名了',
    /\.think-body/.test(cssBlock) && /\.user-thinking-body/.test(cssBlock));
  // border-width 吃掉 caps 的话，一行字的气泡会从 37px 撑到 70px
  t('用的是 border-image-width 而不是 border-width 吃 caps',
    /border-image-width:\s*var\(--bub-send-bw\)/.test(css) && /border-width:\s*0\s*!important/.test(css));
}

console.log('');
console.log(pass + ' 通过，' + fail + ' 失败');
if (fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
