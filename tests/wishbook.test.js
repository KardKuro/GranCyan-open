'use strict';
// 小本子（js/71-wishbook.js）：[[WISH: 东西 | 为什么]] 悄悄记、[[WISH_OPEN: 东西]] 翻一页给她看
//
// 最要紧的一条：**封着的那页写了什么，用户看不到**。露的路和藏宝地图一样多、一样静默：
// 存进消息正文、blocks 路径没替换（渲染优先用 blocks）、流式途中闪出来、回复被掐断留下半截、
// 思考里抄了一遍、印章模板手滑带上东西名。下面每一条路都单独守。
// stickerTagForApi / _STREAM_MASKS 是从 05-prompts-api.js 抠出来的原代码。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readLF = p => read(p).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const src = read('js/71-wishbook.js');
const api = readLF('js/05-prompts-api.js');
function extract(s, startSig, endSig) {
  const a = s.indexOf(startSig);
  const b = s.indexOf(endSig, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + startSig);
  return s.slice(a, b);
}
const forApiSrc = extract(api, 'function stickerTagForApi(', '// 「系统提示吃爆窗口」');
const maskSrc = extract(api, 'const _STREAM_MASKS', '// ── 模型隔离');

function makeBox(opts = {}) {
  const els = {};
  const state = { wishbook: [], skillsOff: opts.off ? { wishbook: true } : {} };
  const box = {
    console, Date, JSON, Math, String, Array, Object, Set, Map, Number, RegExp,
    state, saves: 0,
    document: { getElementById: id => els[id] || null },
  };
  box.save = () => { box.saves++; };
  box.skillOn = k => !(state.skillsOff && state.skillsOff[k]);
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(src, box, { filename: '71-wishbook.js' });
  vm.runInContext(forApiSrc + '\nthis.stickerTagForApi = stickerTagForApi;', box, { filename: '05#stickerTagForApi' });
  vm.runInContext(maskSrc + '\nthis.maskStreamingTags = maskStreamingTags; this._STREAM_MASKS = _STREAM_MASKS;', box, { filename: '05#masks' });
  box.els = els;
  return box;
}

const KURO = { id: 7, nickname: '克克' };
const GPT = { id: 9, nickname: '阿岚' };
const SECRET = '那个会发光的月亮夜灯';
const WHY = '她说晚上起夜总踢到桌角';

console.log('\n[1] 记：[[WISH: 东西 | 为什么]]');
{
  const b = makeBox();
  const ctx = {};
  const out = b.wishProcessTags(`好啦好啦\n[[WISH: ${SECRET} | ${WHY}]]\n快睡`, null, KURO, ctx);
  t('★ 东西和理由不留在消息里', !out.includes(SECRET) && !out.includes(WHY), out);
  t('消息里只剩存储短标签', /\[\[WISH_KEPT:w[a-z0-9]+\]\]/.test(out));
  t('前后的话照留', out.includes('好啦好啦') && out.includes('快睡'));
  const e = b.state.wishbook[0];
  t('记进本子：东西、理由、谁、哪个模型', e && e.item === SECRET && e.why === WHY && e.w === '克克' && e.c === '7' && e.open === 0, e);
  t('结果交给 blocks 路径', ctx.wishResults.length === 1 && ctx.wishResults[0].ok);
  t('落盘了', b.saves > 0);

  const again = b.wishProcessTags(`[[WISH: ${SECRET} | 换个说法]]`, null, KURO, {});
  t('同一样还封着的不重复记', b.state.wishbook.length === 1 && again.includes(e.id));
  t('理由换成新的', b.state.wishbook[0].why === '换个说法');

  b.wishProcessTags('[[WISH：全角也认｜理由]]', null, KURO, {});
  t('全角冒号、全角竖线也认', b.state.wishbook.some(x => x.item === '全角也认' && x.why === '理由'));
  b.wishProcessTags('[[WISH: 只写了东西]]', null, KURO, {});
  t('理由可以省', b.state.wishbook.some(x => x.item === '只写了东西' && x.why === ''));
  const n = b.state.wishbook.length;
  const empty = b.wishProcessTags('[[WISH:  | 光有理由]]', null, KURO, {});
  t('东西是空的不记、也不留标签', b.state.wishbook.length === n && !empty.includes('[['), empty);
  const many = b.wishProcessTags([1, 2, 3, 4].map(i => `[[WISH: 第${i}样]]`).join('\n'), null, KURO, {});
  t('一条最多记三笔', b.state.wishbook.length === n + 3 && !many.includes('第4样'), many);

  const forged = b.wishProcessTags('[[WISH_KEPT:wfake1]] [[WISH_SHOWN:wfake2]] [[WISH_MISS:x]] 好', null, KURO, {});
  t('★ 模型照抄的存储短标签抹掉（不许假装记过/翻过）', forged.trim() === '好', forged);

  const cut = b.wishProcessTags(`嗯\n[[WISH: ${SECRET.slice(0, 4)}`, null, KURO, {});
  t('★ 写到一半被掐断：半截也不许露', !cut.includes(SECRET.slice(0, 4)) && cut.trim() === '嗯', cut);
}

console.log('\n[2] 技能关着');
{
  const b = makeBox({ off: true });
  const out = b.wishProcessTags(`嗯[[WISH: ${SECRET} | ${WHY}]][[WISH_OPEN: ${SECRET}]]`, null, KURO, {});
  t('整条抹掉，什么也不记', out === '嗯' && b.state.wishbook.length === 0, out);
  t('系统提示里没有这段', b.wishPromptFor(KURO).stable === '');
}

console.log('\n[3] 翻：[[WISH_OPEN: 东西]]');
{
  const b = makeBox();
  b.wishProcessTags(`[[WISH: ${SECRET} | ${WHY}]]`, null, KURO, {});
  b.wishProcessTags('[[WISH: 书包]]', null, KURO, {});
  b.wishProcessTags('[[WISH: 阿岚记的围巾]]', null, GPT, {});
  const miss = b.wishProcessTags('[[WISH_OPEN: 阿岚记的围巾]]', null, KURO, {});
  t('★ 只翻自己本子里的（别的模型记的翻不开）', /\[\[WISH_MISS:阿岚记的围巾\]\]/.test(miss) && b.state.wishbook.every(e => !e.open), miss);
  const one = b.wishProcessTags('[[WISH_OPEN: 书]]', null, KURO, {});
  t('一个字的不去模糊认（「书」不翻开「书包」）', one.includes('WISH_MISS') && !b.state.wishbook.find(e => e.item === '书包').open);
  const ctx = {};
  const out = b.wishProcessTags(`给你看个东西\n[[WISH_OPEN: 月亮夜灯 | 顺手写了理由]]`, null, KURO, ctx);
  const e = b.state.wishbook.find(x => x.item === SECRET);
  t('认包含、忽略多写的理由', e.open > 0 && /\[\[WISH_SHOWN:w[a-z0-9]+\]\]/.test(out), out);
  t('翻开的结果交给 blocks', ctx.wishResults.length === 1 && ctx.wishResults[0].kind === 'open' && ctx.wishResults[0].ok);
  const twice = b.wishProcessTags(`[[WISH_OPEN: ${SECRET}]]`, null, KURO, {});
  t('翻开过的不再翻一次', twice.includes('WISH_MISS'));
  const both = b.wishProcessTags('[[WISH: 新的发夹]][[WISH_OPEN: 新的发夹]]', null, KURO, {});
  t('同一条里先记后翻：翻的是本子里原来就有的（新记的这条不当场翻开）', both.includes('WISH_MISS') && both.includes('WISH_KEPT') && !b.state.wishbook.find(x => x.item === '新的发夹').open, both);
}

console.log('\n[4] blocks 路径：认领同一批结果，不记第二次；thinking 里抄的盖掉');
{
  const b = makeBox();
  const ctx = {};
  const raw = `嗯\n[[WISH: ${SECRET} | ${WHY}]]\n[[WISH: 第二样]]`;
  const content = b.wishProcessTags(raw, null, KURO, ctx);
  const n = b.state.wishbook.length;
  const blocks = [
    { type: 'thinking', text: `我要偷偷写 [[WISH: ${SECRET} | ${WHY}]]` },
    { type: 'text', text: raw },
    { type: 'tool_use', text: '[[WISH: x]]' },
  ];
  b._applyWishToBlocks(blocks, ctx);
  t('★ blocks 里没有东西名', !blocks[1].text.includes(SECRET) && !blocks[1].text.includes('第二样'), blocks[1].text);
  t('和 content 路径认的是同一批 id', blocks[1].text.match(/WISH_KEPT:\w+/g).join() === content.match(/WISH_KEPT:\w+/g).join());
  t('不记第二次', b.state.wishbook.length === n);
  t('★ thinking 里抄的盖掉', !blocks[0].text.includes(SECRET) && blocks[0].text.includes('悄悄记了一笔'), blocks[0].text);
  t('别的类型的块不碰', blocks[2].text === '[[WISH: x]]');
}

console.log('\n[5] 渲染');
{
  const b = makeBox();
  const kept = b.wishProcessTags(`[[WISH: <b>${SECRET}</b> | ${WHY}]]`, null, KURO, {});
  const h = b.wishTagToHtml(kept);
  t('★ 印章上不出现东西和理由', !h.includes(SECRET) && !h.includes(WHY) && h.includes('悄悄记了一笔'), h);
  t('点印章打开小本子', h.includes('onclick="openWishbook()"'));
  const shown = b.wishProcessTags('[[WISH_OPEN: <b>' + SECRET + '</b>]]', null, KURO, {});
  const sh = b.wishTagToHtml(shown);
  t('翻开的那页画出东西和理由', sh.includes(SECRET) && sh.includes(WHY) && sh.includes('克克从小本子里翻出来一页'), sh);
  t('东西名转义', sh.includes('&lt;b&gt;') && !sh.includes('<b>' + SECRET));
  t('没翻成的不画给她看', b.wishTagToHtml('前[[WISH_MISS:围巾]]后') === '前后');
  t('★ 兜底：漏到渲染的裸 [[WISH:]] 只画占位', !b.wishTagToHtml(`老消息[[WISH: ${SECRET} | ${WHY}]]`).includes(SECRET));
  t('★ 兜底：半截裸指令也一样', !b.wishTagToHtml(`[[WISH: ${SECRET} | ${WHY.slice(0, 3)}`).includes(SECRET));
  t('这台还没同步到的那页：不炸，说一声', b.wishTagToHtml('[[WISH_SHOWN:wnope]]').includes('还没同步到'));
}

console.log('\n[6] 回填历史（真的 stickerTagForApi）');
{
  const b = makeBox();
  const c1 = b.wishProcessTags(`好\n[[WISH: ${SECRET} | ${WHY}]]`, null, KURO, {});
  const back = b.stickerTagForApi(c1);
  t('★ 咬回 [[WISH: 东西 | 为什么]]（它要记得自己记过什么）', back.includes(`[[WISH: ${SECRET} | ${WHY}]]`) && back.includes('她看不到'), back);
  const again = b.wishProcessTags(back, null, KURO, {});
  t('照抄回填的再走一遍不会多记一笔', b.state.wishbook.length === 1, again);
  const c2 = b.wishProcessTags(`[[WISH_OPEN: ${SECRET}]]`, null, KURO, {});
  const back2 = b.stickerTagForApi(c2);
  t('翻过的咬回 [[WISH_OPEN:]]', back2.includes(`[[WISH_OPEN: ${SECRET}]]`), back2);
  t('之前那条也跟着说已经翻给她了', b.stickerTagForApi(c1).includes('已经翻给她看了'));
  t('没翻成的写成一句话，不是指令', /没翻成/.test(b.stickerTagForApi('[[WISH_MISS:围巾]]')) && !/\[\[WISH_MISS/.test(b.stickerTagForApi('[[WISH_MISS:围巾]]')));
  t('这台没有的那页：写成一句话', b.stickerTagForApi('[[WISH_KEPT:wnope]]').includes('没读到'));
}

console.log('\n[7] 流式遮挡');
{
  const b = makeBox();
  t('写完的遮住', b.maskStreamingWish(`嗯[[WISH: ${SECRET} | ${WHY}]]后面`) === '嗯〔📒 …〕后面');
  t('★ 写到一半也遮住', b.maskStreamingWish(`嗯[[WISH: ${SECRET.slice(0, 3)}`) === '嗯〔📒 …〕');
  t('标签名还没写全也遮住', b.maskStreamingWish('嗯[[WIS') === '嗯〔📒 …〕');
  t('翻页的遮成「翻小本子」', b.maskStreamingWish('[[WISH_OPEN: 夜') === '〔📒 翻小本子…〕');
  const stored = '[[WISH_KEPT:wabc]] 后文';
  t('存储短标签不当成没写完的指令（不吞后文）', b.maskStreamingWish(stored) === stored);
  t('遮罩进了总表、总表真的调到它', b._STREAM_MASKS.includes('maskStreamingWish') && !b.maskStreamingTags(`[[WISH: ${SECRET}`).includes(SECRET));
}

console.log('\n[8] 系统提示');
{
  const b = makeBox();
  const p0 = b.wishPromptFor(KURO);
  t('说明进 stable', p0.stable.includes('[[WISH: 东西 | 为什么想给她]]') && p0.stable.includes('[[WISH_OPEN: 东西]]') && p0.volatile === '');
  b.wishProcessTags(`[[WISH: ${SECRET}]]`, null, KURO, {});
  b.wishProcessTags('[[WISH: 发夹]]', null, KURO, {});
  b.wishProcessTags('[[WISH: 阿岚的]]', null, GPT, {});
  b.wishProcessTags('[[WISH_OPEN: 发夹]]', null, KURO, {});
  const p = b.wishPromptFor(KURO).stable;
  t('列出自己本子里还封着的', /还封着的：那个会发光的月亮夜灯/.test(p), p);
  t('列出最近翻过的', /最近翻给她看过的：发夹/.test(p));
  t('不列别的模型的', !p.includes('阿岚的'));
}

console.log('\n[9] 云同步：按 id 并集，翻开的算翻开');
{
  const b = makeBox();
  b.wishProcessTags('[[WISH: 本机记的]]', null, KURO, {});
  const mine = b.state.wishbook[0];
  const other = { id: 'wphone1', at: mine.at - 1000, c: '7', w: '克克', item: '手机上记的', why: '', open: 0 };
  const cloudMine = Object.assign({}, mine, { open: mine.at + 5000 });
  const r = b.wishSyncApply([other, cloudMine]);
  t('★ 另一台记的并进来', r.changed && b.state.wishbook.some(e => e.id === 'wphone1'));
  t('★ 另一台翻开的，这台也算翻开', b.state.wishbook.find(e => e.id === mine.id).open === mine.at + 5000);
  t('按时间排好、不重复', b.state.wishbook.every((e, i, a) => !i || a[i - 1].at <= e.at) && new Set(b.state.wishbook.map(e => e.id)).size === b.state.wishbook.length);
  t('和云端一样了就不用推', !r.needPush);
  b.wishProcessTags('[[WISH: 又一样]]', null, KURO, {});
  const r2 = b.wishSyncApply([other, cloudMine]);
  t('本机多出来的要推', !r2.changed && r2.needPush);
  t('再合一遍不算变化', !b.wishSyncApply(b.state.wishbook.slice()).changed);
  t('云端是空的/坏的不炸', !b.wishSyncApply(null).changed && !b.wishSyncApply('x').changed);
  const both = b.wishMerge([{ id: 'x', at: 1, item: 'a', open: 50 }], [{ id: 'x', at: 1, item: 'a', open: 30 }]);
  t('两台都翻开过：取较早那次', both[0].open === 30);
}

console.log('\n[10] 面板');
{
  const b = makeBox();
  const empty = b.wishbookHtml();
  t('空本子给一句说明', empty.includes('还是空的'));
  b.wishProcessTags(`[[WISH: ${SECRET} | ${WHY}]]`, null, KURO, {});
  b.wishProcessTags('[[WISH: <i>发夹</i> | 上次那个断了]]', null, KURO, {});
  b.wishProcessTags('[[WISH_OPEN: 发夹]]', null, KURO, {});
  const h = b.wishbookHtml();
  t('★ 封着的页面板里也看不到写了什么', !h.includes(SECRET) && !h.includes(WHY) && h.includes('还封着的'), h);
  t('翻开的看得到', h.includes('上次那个断了') && h.includes('&lt;i&gt;发夹'));
  t('页数对得上', h.includes('一共 2 页 · 翻开了 1 页'));
}

console.log('\n[11] 接线');
{
  const html = read('index.html');
  const core = read('js/01-core.js'), st = read('js/02-state.js'), hub = read('js/14-boot-brain-hub.js');
  const mem = read('js/04-memory.js'), grp = readLF('js/06-render-msg.js'), media = read('js/12-math-media.js');
  t('脚本挂进页面', html.includes('<script src="./js/71-wishbook.js"></script>'));
  t('小组件入口', html.includes('onclick="openWidget(openWishbook)"'));
  t('面板壳在', html.includes('id="wishbookModal"') && html.includes('id="wishbookBody"'));
  t('速查表里有这两条', html.includes('<code>[[WISH: 东西 | 为什么]]</code>') && html.includes('<code>[[WISH_OPEN: 东西]]</code>'));
  t('三道关①：_doSave 写盘', /idbSet\('kuro_wishbook'/.test(st));
  t('三道关②：loadStateFromDB 读盘', /wishbook:\s*await g\('kuro_wishbook'/.test(core));
  t('三道关③：启动搬进 state', /state\.wishbook\s*=\s*Array\.isArray\(saved\.wishbook\)/.test(hub));
  t('上云：推的时候带着并跟云端合并', /wishbook: state\.wishbook/.test(core) && /wishSyncApply\(cloud\.wishbook\)/.test(core));
  t('下云：拉的时候按条合并', /wishSyncApply\(s\.wishbook\)/.test(core));
  t('processAiCommands 调了 wishProcessTags', /wishProcessTags\(text, chat, conf, studyCtx\)/.test(mem));
  t('★ blocks 收尾三处都调了 _applyWishToBlocks', (api.match(/_applyWishToBlocks\(blocks, studyCtx\)/g) || []).length === 2 && /_applyWishToBlocks\(blocks, studyCtx\)/.test(grp));
  t('回填历史链里有 wishTagForApi', /wishTagForApi\(cooked\)/.test(api));
  t('系统提示里有 wishPromptFor', /wishPromptFor\(conf\)/.test(api));
  t('渲染链里有 wishTagToHtml', /wishTagToHtml\(text\)/.test(media));
  t('★ treasureVeil 顺带遮小本子（所有纸条遮挡点都覆盖到）', /function treasureVeil\(text\) \{\s*\/\/[^\n]*\n\s*if \(typeof wishVeil === 'function'\) text = wishVeil\(text\);/.test(read('js/68-treasure.js')));
  t('流式思考块也遮', /wishVeil\(b\.text\)/.test(api));
  t('技能表里有一条', /key: 'wishbook',\s*tok: \d+/.test(api));
  t('米纸不翻小本子（gen-light-patch 的 SKIP）', /\\\.wish\(book\)\?-/.test(read('scripts/gen-light-patch.js')) && !read('css/light-patch.css').includes('wish'));
  t('自带深色样式', /\.wishbook-panel \{[^}]*background:#1/.test(read('css/grancyan.css')));
}

console.log(`\n${fail ? '✗' : '✅'} ${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
