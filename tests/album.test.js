'use strict';
// 它的相册（js/62-album.js）：[[ALBUM:]] 收照片写第一印象、[[PHOTO:]] 把以前的照片翻出来
//
// 这块的失败全是静默的：
//   · blocks 路径再收一次 —— 第一印象被第二次的覆盖、收藏时间漂移，没人看得出来；
//   · 回填历史写成别的样子 —— 模型照着历史学，下一轮写出解析不了的格式，翻照片静默失灵；
//   · 翻到了别的模型从没见过的对话里的图 —— 不报错，只是串了。
// 所以尽量跑真代码：stickerTagForApi 是从 05-prompts-api.js 里抠出来的原函数。
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

const mem = read('js/60-imgmem.js');
const album = read('js/62-album.js');
const api = readLF('js/05-prompts-api.js');
function extract(src, startSig, endSig) {
  const a = src.indexOf(startSig);
  const b = src.indexOf(endSig, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + startSig);
  return src.slice(a, b);
}
const forApiSrc = extract(api, 'function stickerTagForApi(', '// 「系统提示吃爆窗口」');
const maskSrc = extract(api, 'const _STREAM_MASKS', 'function maskStreamingTags(');

const IMG_A = 'data:image/jpeg;base64,' + 'A'.repeat(300);
const IMG_B = 'data:image/jpeg;base64,' + 'B'.repeat(300);
const IMG_C = 'data:image/jpeg;base64,' + 'C'.repeat(300);
const IMG_D = 'data:image/jpeg;base64,' + 'D'.repeat(300);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function sandbox(chats, opts = {}) {
  const box = {
    state: { chats, skillsOff: opts.skillsOff || {} },
    console: { log() {}, warn() {}, error() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout, escHtml: esc, saves: 0,
  };
  box.save = () => { box.saves++; };
  box.skillOn = k => !(box.state.skillsOff && box.state.skillsOff[k]);
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(mem + '\n' + album + '\n' + forApiSrc + '\n' + maskSrc
    + '\nthis.imgMemHash = imgMemHash; this.albumProcessTags = albumProcessTags; this._applyAlbumToBlocks = _applyAlbumToBlocks;'
    + 'this.albumTagToHtml = albumTagToHtml; this.albumTagForApi = albumTagForApi; this.albumPromptFor = albumPromptFor;'
    + 'this.albumFind = albumFind; this.albumOf = albumOf; this.albumAll = albumAll; this.albumUnkeep = albumUnkeep;'
    + 'this.maskStreamingAlbum = maskStreamingAlbum; this.stickerTagForApi = stickerTagForApi; this._STREAM_MASKS = _STREAM_MASKS;'
    + 'this.albumInvalidate = albumInvalidate;', box);
  return box;
}

const KURO = { id: 'k1', nickname: '克克' };
const OTHER = { id: 'g2', nickname: '小千' };
const img = (url, extra) => Object.assign({ url, name: 'x.jpg' }, extra || {});
// 一个对话：她发图 → 某个模型回
function chatWith(id, conf, userImages, extra) {
  const nodes = {
    1: Object.assign({ id: 1, role: 'user', content: '你看', images: userImages, timestamp: 1000 + id }, extra || {}),
    2: { id: 2, parentId: 1, role: 'ai', content: '', modelId: conf.id, timestamp: 2000 + id },
  };
  return { id, nodes };
}
const ctxOf = (chat, userTurnId = 1) => ({ chat, userTurnId, aiNodeId: 2 });

(async () => {
  console.log('\n[1] 收：[[ALBUM:]]');
  {
    const chat = chatWith(1, KURO, [img(IMG_A), img(IMG_B)]);
    const b = sandbox([chat]);
    const ctx = ctxOf(chat);
    const out = b.albumProcessTags('好看！\n[[ALBUM: 你笑得眼睛都没了]]', chat, KURO, ctx);
    const [ia, ib] = chat.nodes[1].images;
    t('一行 ALBUM = 这条的图全收', !!(ia.kept && ia.kept.k1 && ib.kept && ib.kept.k1));
    t('印象记在图上', ia.kept.k1.note === '你笑得眼睛都没了' && ia.kept.k1.who === '克克');
    t('收的时候补上了哈希', ia.hash === b.imgMemHash(IMG_A));
    t('换成存储短标签，带两张的哈希', out.includes(`[[ALBUM_KEPT:${ia.hash},${ib.hash}|你笑得眼睛都没了]]`), out);
    t('原指令不留在正文里', !/\[\[ALBUM\s*:/.test(out));
    t('落盘了', b.saves > 0);

    // 第二次收同一张：第一印象只有一次
    const at0 = ia.kept.k1.at;
    b.albumProcessTags('[[ALBUM: 第二次看]]', chat, KURO, ctx);
    t('再收不覆盖第一印象', ia.kept.k1.note === '你笑得眼睛都没了' && ia.kept.k1.at === at0);
    // 另一个模型收同一张：各是各的
    b.albumProcessTags('[[ALBUM: 小千的印象]]', chat, OTHER, ctx);
    t('别的模型收同一张，各记各的', ia.kept.g2 && ia.kept.g2.note === '小千的印象' && ia.kept.k1.note === '你笑得眼睛都没了');
  }
  {
    const chat = chatWith(2, KURO, [img(IMG_A), img(IMG_B)]);
    const b = sandbox([chat]);
    b.albumProcessTags('[[ALBUM: 第一张]]\n[[ALBUM: 第二张]]\n[[ALBUM：第三行，没有对应的图]]', chat, KURO, ctxOf(chat));
    const [ia, ib] = chat.nodes[1].images;
    t('几行 ALBUM 按顺序对应第几张', ia.kept.k1.note === '第一张' && ib.kept.k1.note === '第二张');
  }
  {
    const chat = chatWith(3, KURO, null);
    const b = sandbox([chat]);
    const out = b.albumProcessTags('[[ALBUM: 想收]]', chat, KURO, ctxOf(chat));
    t('这条没图：存成空哈希（卡片照实说没收到）', out.includes('[[ALBUM_KEPT:|想收]]'), out);
  }
  {
    // 群聊：它回的是另一个模型的话，往上找她那条
    const chat = chatWith(4, KURO, [img(IMG_A)]);
    chat.nodes[3] = { id: 3, parentId: 2, role: 'ai', content: '', modelId: 'k1' };
    const b = sandbox([chat]);
    b.albumProcessTags('[[ALBUM: 群里也能收]]', chat, KURO, ctxOf(chat, 2));
    t('parent 是别的模型时往上找到她那条', chat.nodes[1].images[0].kept && chat.nodes[1].images[0].kept.k1.note === '群里也能收');
  }
  {
    const chat = chatWith(5, KURO, [img(IMG_A)], { videoNote: ['0s'] });
    const b = sandbox([chat]);
    b.albumProcessTags('[[ALBUM: 视频]]', chat, KURO, ctxOf(chat));
    t('视频抽帧不收', !chat.nodes[1].images[0].kept);
  }
  {
    const chat = chatWith(6, KURO, [img(IMG_A)]);
    const b = sandbox([chat], { skillsOff: { album: true } });
    const out = b.albumProcessTags('嗯[[ALBUM: 关着]][[PHOTO: 猫]]', chat, KURO, ctxOf(chat));
    t('技能关着：指令抹掉、不收', out === '嗯' && !chat.nodes[1].images[0].kept, out);
  }

  console.log('\n[2] 翻：[[PHOTO:]]');
  // 三个对话：c1 AI聊过（收了 A，B 没收但有描述），c2 只有小千聊过（D 有描述）
  const c1 = chatWith(11, KURO, [img(IMG_A, { desc: '一碗红烧牛肉面，卧着荷包蛋' }), img(IMG_B, { desc: '窗台上睡着一只橘猫' })]);
  const c2 = chatWith(12, OTHER, [img(IMG_D, { desc: '海边的落日，橘猫剪影' })]);
  const b = sandbox([c1, c2]);
  b.albumProcessTags('[[ALBUM: 那天你说饿到发抖]]', c1, KURO, Object.assign(ctxOf(c1), { userTurnId: 1 }));
  // 只收 A：改成一行一张
  delete c1.nodes[1].images[1].kept;
  b.albumInvalidate();
  const hA = b.imgMemHash(IMG_A), hB = b.imgMemHash(IMG_B), hD = b.imgMemHash(IMG_D);
  t('按自己写的印象翻得到', b.albumFind(KURO, '饿到发抖')?.hash === hA);
  t('按画面翻得到（收过的）', b.albumFind(KURO, '荷包蛋')?.hash === hA);
  t('没收、但跟它聊过的对话里的图也翻得到', b.albumFind(KURO, '橘猫 窗台')?.hash === hB);
  t('没跟它聊过的对话里的图翻不到（不串）', b.albumFind(KURO, '落日') === null);
  t('小千翻得到自己对话里的', b.albumFind(OTHER, '落日')?.hash === hD);
  t('#编号翻得到', b.albumFind(KURO, '#' + hA.slice(0, 8))?.hash === hA);
  t('#编号后面跟着说明也认', b.albumFind(KURO, `#${hA.slice(0, 8)}（一碗面）`)?.hash === hA);
  t('别的模型的编号翻不到', b.albumFind(KURO, '#' + hD.slice(0, 8)) === null);
  t('空格分词，全部命中才算', b.albumFind(KURO, '橘猫 荷包蛋') === null);

  const ctx = ctxOf(c1);
  const out = b.albumProcessTags('想起来了\n[[PHOTO: 荷包蛋]]\n还有\n[[PHOTO: 不存在的东西]]', c1, KURO, ctx);
  t('翻到的存成 hash', out.includes(`[[ALBUM_REF:${hA}|荷包蛋]]`), out);
  t('没翻到的存成空 hash', out.includes('[[ALBUM_REF:|不存在的东西]]'));
  const many = b.albumProcessTags('[[PHOTO: 荷包蛋]][[PHOTO: 荷包蛋]][[PHOTO: 荷包蛋]][[PHOTO: 荷包蛋]]', c1, KURO, ctxOf(c1));
  t('一条回复最多翻 3 张', (many.match(/\[\[ALBUM_REF:[0-9a-f]+\|/g) || []).length === 3, many);

  console.log('\n[3] blocks 路径：认领同一批结果，不再收第二次');
  {
    const chat = chatWith(21, KURO, [img(IMG_C, { desc: '一束向日葵' })]);
    const bb = sandbox([chat]);
    const ctx2 = ctxOf(chat);
    const content = bb.albumProcessTags('[[PHOTO: 向日葵]] 嗯 [[ALBUM: 金灿灿的]]', chat, KURO, ctx2);
    const k = chat.nodes[1].images[0].kept.k1, saves = bb.saves;
    const blocks = [{ type: 'text', text: '[[PHOTO: 向日葵]] 嗯' }, { type: 'thinking', text: '[[ALBUM: 不该动]]' }, { type: 'text', text: '[[ALBUM: 金灿灿的]]' }];
    bb._applyAlbumToBlocks(blocks, ctx2);
    t('blocks 里换成和 content 一样的标签', blocks[0].text.includes('[[ALBUM_REF:') && blocks[2].text.includes('[[ALBUM_KEPT:'), blocks);
    t('两条路结果一致', content.replace(/\s+/g, '') === (blocks[0].text + blocks[2].text).replace(/\s+/g, ''), [content, blocks]);
    t('不是 text 的块不碰', blocks[1].text === '[[ALBUM: 不该动]]');
    t('没有再收一次（时间、落盘都没动）', chat.nodes[1].images[0].kept.k1 === k && bb.saves === saves);
  }

  console.log('\n[4] 渲染');
  {
    const html = b.albumTagToHtml(`[[ALBUM_KEPT:${hA}|那天你说<b>饿</b>]]`);
    t('收藏卡里有那张图（msg-img，点了能放大）', html.includes(`class="msg-img album-thumb" src="${IMG_A}"`), html);
    t('印象转义了', html.includes('那天你说&lt;b&gt;饿&lt;/b&gt;') && !html.includes('<b>'));
    t('没收到的卡片照实说', b.albumTagToHtml('[[ALBUM_KEPT:|想收]]').includes('这条里没有能收的照片'));
    const ref = b.albumTagToHtml(`说着\n[[ALBUM_REF:${hA}|荷包蛋]]`);
    t('翻出来的照片画成原图', ref.includes(`src="${IMG_A}"`) && ref.includes('album-recall'), ref);
    t('配上它当时写的印象', ref.includes('那天你说饿到发抖'));
    t('没翻到的照实说', b.albumTagToHtml('[[ALBUM_REF:|向日葵]]').includes('相册里没翻到'));
    t('哈希对不上（图被删了）也不炸', b.albumTagToHtml('[[ALBUM_REF:0123456789abcdef|x]]').includes('已经不在了'));
    const evil = b.albumTagToHtml('[[ALBUM_REF:|"><img src=x onerror=alert(1)>]]');
    t('关键词里的 HTML 被转义', !evil.includes('<img src=x'), evil);
  }

  console.log('\n[5] 回填历史：咬回正牌指令');
  {
    const stored = `嗯\n\n[[ALBUM_KEPT:${hA}|饿到发抖]]\n\n[[ALBUM_REF:${hA}|荷包蛋]]\n\n[[ALBUM_REF:|向日葵]]`;
    const back = b.stickerTagForApi(stored);
    t('收藏咬回 [[ALBUM: 印象]]', back.includes('[[ALBUM: 饿到发抖]]'), back);
    t('ALBUM_REF → [[PHOTO: #编号（画面）]]', back.includes(`[[PHOTO: #${hA.slice(0, 8)}（一碗红烧牛肉面，卧着荷包蛋）]]`), back);
    t('没翻到的 → [[PHOTO: 词（没翻到）]]', back.includes('[[PHOTO: 向日葵（没翻到）]]'), back);
    t('只有收藏、没有翻照片的那条也咬回（快速判断别漏了 ALBUM_KEPT）',
      b.albumTagForApi(`嗯[[ALBUM_KEPT:${hA}|只收不翻]]`) === '嗯[[ALBUM: 只收不翻]]');
    t('只有收藏的那条也画得出卡片', b.albumTagToHtml(`[[ALBUM_KEPT:${hA}|只收不翻]]`).includes('album-kept'));
    t('回填里不留存储短标签',!/KEPT|ALBUM_REF/.test(back));
    // 模型照着历史原样抄一遍，必须还是同一张（历史就是教材）
    const again = b.albumProcessTags(back.match(/\[\[PHOTO: #[^\]]+\]\]/)[0], c1, KURO, ctxOf(c1));
    t('照抄回填的写法翻出来的还是同一张', again.includes(`[[ALBUM_REF:${hA}|`), again);
    const again2 = b.albumProcessTags('[[PHOTO: 荷包蛋（没翻到）]]', c1, KURO, ctxOf(c1));
    t('照抄「（没翻到）」也不妨碍按词搜', again2.includes(`[[ALBUM_REF:${hA}|`), again2);
  }

  console.log('\n[6] 系统提示');
  {
    const p = b.albumPromptFor(KURO);
    t('说明进 stable', p.stable.includes('[[ALBUM:') && p.stable.includes('[[PHOTO:') && p.volatile === '');
    t('目录里有它收的那张（编号 + 印象 + 画面）', p.stable.includes(`#${hA.slice(0, 8)} · `) && p.stable.includes('饿到发抖') && p.stable.includes('荷包蛋'), p.stable);
    t('目录里没有没收的图', !p.stable.includes(hB.slice(0, 8)));
    t('别的模型的相册不进来', !b.albumPromptFor(OTHER).stable.includes(hA.slice(0, 8)));
    t('相册空的模型只有说明', !b.albumPromptFor(OTHER).stable.includes('你的相册（'));
    const off = sandbox([c1], { skillsOff: { album: true } });
    t('技能关着一个字都不进', off.albumPromptFor(KURO).stable === '');
    // 目录有上限
    const imgs = Array.from({ length: 25 }, (_, i) => img('data:image/png;base64,' + String(i).repeat(50), { kept: { k1: { at: i + 1, note: 'n' + i } } }));
    const big = sandbox([chatWith(31, KURO, imgs)]);
    const lines = big.albumPromptFor(KURO).stable.split('\n').filter(l => /^#[0-9a-f]{8} · /.test(l));
    t('目录最多 20 张、新收的在前', lines.length === 20 && lines[0].includes('n24'), lines.length);
  }

  console.log('\n[7] 面板数据 / 拿掉');
  {
    const all = b.albumAll();
    t('相册面板列出收藏', all.length === 1 && all[0].note === '那天你说饿到发抖' && all[0].confId === 'k1', all.map(e => [e.confId, e.note, e.hash.slice(0, 6)]));
    b.albumUnkeep(hA, 'k1');
    t('拿掉只摘标记，图还在', !c1.nodes[1].images[0].kept && c1.nodes[1].images[0].url === IMG_A);
    t('拿掉后相册空了', b.albumAll().length === 0 && b.albumOf('k1').length === 0);
  }

  console.log('\n[7b] 老图（没存 hash）每张只算一次哈希');
  {
    const imgs = Array.from({ length: 5 }, (_, i) => img('data:image/png;base64,' + String(i).repeat(2000)));
    const bx = sandbox([chatWith(41, KURO, imgs)]);
    let calls = 0;
    const real = bx.imgMemHash;
    vm.runInContext('imgMemHash = function (u) { __count(); return __real(u); };', Object.assign(bx, { __count: () => calls++, __real: real }));
    for (let k = 0; k < 4; k++) { bx.albumInvalidate(); bx.albumPromptFor(KURO); bx.albumFind(KURO, '随便'); }
    t('扫了 4 轮，5 张老图一共只算 5 次', calls === 5, calls);
    t('扫描不往图上写 hash（只读）', imgs.every(x => !x.hash));
  }

  console.log('\n[8] 流式遮挡');
  {
    t('写完的 ALBUM 遮住', b.maskStreamingAlbum('嗯[[ALBUM: 好看]]') === '嗯〔📷 收进相册…〕');
    t('没写完的 PHOTO 遮住', b.maskStreamingAlbum('想起来[[PHOTO: 荷包') === '想起来〔📷 翻相册…〕');
    t('标签名写完、冒号还没来也遮住', b.maskStreamingAlbum('嗯[[ALBUM') === '嗯〔📷 收进相册…〕');
    const stored = `嗯\n[[ALBUM_KEPT:${hA}|好看]]\n后面的话`;
    t('存储短标签不当成没写完的指令（不吞后文）', b.maskStreamingAlbum(stored) === stored);
    t('遮罩进了总表',b._STREAM_MASKS.includes('maskStreamingAlbum'));
  }

  console.log('\n[9] 接线');
  {
    const memjs = read('js/04-memory.js');
    const render = read('js/12-math-media.js');
    const grp = read('js/06-render-msg.js');
    const html = read('index.html');
    t('processAiCommands 调了 albumProcessTags', /albumProcessTags\(text, chat, conf, studyCtx\)/.test(memjs));
    t('三处 blocks 收尾都认领了（单聊、重新生成、群聊）',
      (api.match(/_applyAlbumToBlocks\(blocks, studyCtx\)/g) || []).length === 2 && /_applyAlbumToBlocks\(blocks, studyCtx\)/.test(grp));
    t('渲染层挂了', /albumTagToHtml\(text\)/.test(render));
    t('回填链挂了', /albumTagForApi\(cooked\)/.test(api));
    t('系统提示挂了', /albumPromptFor\(conf\)/.test(api));
    t('技能开关里有相册', /key: 'album'/.test(api));
    t('index.html 加载了 62-album.js', html.includes('<script src="./js/62-album.js"></script>'));
    t('小组件里有入口', html.includes('openWidget(openAlbum)'));
    t('面板容器在', html.includes('id="albumModal"') && html.includes('id="albumList"'));
    // 渲染消毒：面板按钮的函数名别撞拒绝名单（delete*/remove*/clear*…）
    t('拿掉按钮的函数名过得了消毒', !/^(delete|remove|clear|wipe|reset)/.test('albumUnkeep'));
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
