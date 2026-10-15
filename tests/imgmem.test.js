'use strict';
// 看过一次的图就记住（js/60-imgmem.js + buildApiMessages 接线 + server /api/img-describe）
//
// 这块的失败全是静默的：
//   · 描述换早了 / 换得不稳 —— 回答照样对，只是提示词缓存、订阅 Claude 的会话续传整段作废，
//     只体现在账单上；
//   · 描述没换上 —— 订阅通道上它照旧一转头就忘了那张图，不报错；
//   · 刚发的图被拿去等描述 —— 发图之后干等几秒，看着像网卡了。
// 所以这里尽量跑真代码：buildApiMessages 是从 05-prompts-api.js 里抠出来的原函数。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 05-prompts-api.js 是 CRLF，抠函数时按 LF 找边界
const readLF = p => read(p).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const mem = read('js/60-imgmem.js');
const api = readLF('js/05-prompts-api.js');
const server = readLF('server.js');
const html = read('index.html');

// 抠出真函数：从 `async function buildApiMessages` 到 relocateVolatilePrompt 结束
function extract(src, startSig, endSig) {
  const a = src.indexOf(startSig);
  const b = src.indexOf(endSig, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + startSig);
  return src.slice(a, b);
}
const buildSrc = extract(api, 'async function buildApiMessages(', '// ═══════════════════════════════════════════════════════\n// WEB SEARCH');

const IMG_A = 'data:image/jpeg;base64,' + 'A'.repeat(400);
const IMG_B = 'data:image/jpeg;base64,' + 'B'.repeat(400);

function sandbox(opts = {}) {
  const calls = [];
  const box = {
    state: { chats: opts.chats || [] },
    console: { log() {}, warn() {}, error() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout,
    SERVER_BASE: 'http://srv',
    saves: 0,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (opts.fetchImpl) return opts.fetchImpl(url, init, calls.length);
      return { ok: true, json: async () => ({ ok: true, desc: '一碗红烧牛肉面，上面卧着一个荷包蛋' }) };
    },
    AbortController,
    // buildApiMessages 的依赖：只给它真用得到的，其余都是 typeof 守着的
    buildSystemPrompt: (conf, chat, last, p, out) => { out.stable = 'SYS'; out.volatile = ''; return 'SYS'; },
    estimateTokens: s => Math.ceil(String(s || '').length / 2),
    stickerTagForApi: s => String(s || ''),
    shrinkImgForApi: async url => ({ url, w: 768, h: 432 }),
    imgApiTokens: i => Math.round(i.w * i.h / 750),
    showToast() {},
    _ctxWarnedFor: new Set(),
  };
  box.save = () => { box.saves++; };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(mem + '\n' + buildSrc + '\nthis.buildApiMessages = buildApiMessages;'
    + 'this.imgMemHash = imgMemHash; this.imgMemSplit = imgMemSplit; this.imgMemEnsure = imgMemEnsure;'
    + 'this.imgMemPrepare = imgMemPrepare; this.imgAlbum = imgAlbum; this.imgAlbumFind = imgAlbumFind;'
    + 'this.IMGMEM_RAW_TURNS = IMGMEM_RAW_TURNS;', box);
  box.calls = calls;
  return box;
}
const LOCAL = { id: 'c', nickname: '订阅 Claude', isLocalClaude: true, maxTokens: 999999, maxReplyTokens: 4000 };
const APIC = { id: 'k', nickname: 'Claude API', apiBase: 'https://api.anthropic.com/v1/messages', maxTokens: 999999, maxReplyTokens: 4000 };

const u = (id, content, images) => ({ id, role: 'user', content, timestamp: id, images: images || null });
const a = (id, content) => ({ id, role: 'ai', content, timestamp: id });
const img = (url, extra) => Object.assign({ url, name: 'x.jpg', w: 768, h: 432 }, extra || {});
const hasImagePart = m => Array.isArray(m.content) && m.content.some(p => p.type === 'image' || p.type === 'image_url');
const textOf = m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');

(async () => {
  // ── 一、哈希 ───────────────────────────────────────────────────────
  console.log('\n[1] 哈希');
  {
    const b = sandbox();
    t('同一张图哈希相同', b.imgMemHash(IMG_A) === b.imgMemHash(IMG_A));
    t('不同的图哈希不同', b.imgMemHash(IMG_A) !== b.imgMemHash(IMG_B));
    t('16 位十六进制', /^[0-9a-f]{16}$/.test(b.imgMemHash(IMG_A)), b.imgMemHash(IMG_A));
    t('★ 同步算得出来（不靠 crypto.subtle：安卓 WebView / 非安全上下文里可能没有）',
      !/crypto\.subtle\.digest/.test(mem));
  }

  // ── 二、换不换 ─────────────────────────────────────────────────────
  console.log('\n[2] 哪张发原图、哪张换描述');
  {
    const b = sandbox();
    const withDesc = [img(IMG_A, { desc: '牛肉面' })];
    const noDesc = [img(IMG_B)];
    t('★ 订阅通道：最后一条用户消息的图发原图（这一轮它得真看见）',
      b.imgMemSplit(withDesc, 0, LOCAL).raw.length === 1 && b.imgMemSplit(withDesc, 0, LOCAL).text === '');
    t('★ 订阅通道：历史里有描述的图换成文字（服务端本来就把历史图丢掉，不换就是失忆）',
      b.imgMemSplit(withDesc, 1, LOCAL).raw.length === 0 && /\[图片：牛肉面\]/.test(b.imgMemSplit(withDesc, 1, LOCAL).text));
    t('没描述的历史图原样留着（行为和以前一样）', b.imgMemSplit(noDesc, 5, LOCAL).raw.length === 1);
    const K = b.IMGMEM_RAW_TURNS;
    t('API 通道：最近几条用户消息里的图照发原图', b.imgMemSplit(withDesc, K - 1, APIC).raw.length === 1);
    t('API 通道：更早的换成描述', b.imgMemSplit(withDesc, K, APIC).raw.length === 0);
    t('Gemini 走 API 那套（它的服务端会重发历史图）',
      b.imgMemSplit(withDesc, 1, { isGemini: true }).raw.length === 1);
  }

  // ── 三、补描述 ─────────────────────────────────────────────────────
  console.log('\n[3] 补描述');
  {
    const b = sandbox();
    const n1 = u(1, '你看', [img(IMG_A)]);
    const n2 = u(2, '再看一次', [img(IMG_A)]);
    await Promise.all([b.imgMemEnsure(n1), b.imgMemEnsure(n2)]);
    t('描述写回了图片对象', n1.images[0].desc === '一碗红烧牛肉面，上面卧着一个荷包蛋', n1.images[0]);
    t('哈希也写上了', n1.images[0].hash === b.imgMemHash(IMG_A));
    t('★ 同一张图同时在描述，只打一次请求', b.calls.length === 1, b.calls.length);
    t('两条消息都拿到了描述', n2.images[0].desc === n1.images[0].desc);
    t('请求打到 /api/img-describe，带的是图本身', b.calls[0].url === 'http://srv/api/img-describe' && b.calls[0].body.image === IMG_A);
    const n3 = u(3, '第三次', [img(IMG_A)]);
    await b.imgMemEnsure(n3);
    t('★ 认得的图直接复用旧描述，不再花一次调用', b.calls.length === 1 && n3.images[0].desc === n1.images[0].desc, b.calls.length);
    const before = n1.images[0].desc;
    await b.imgMemEnsure(n1);
    t('★ 有了描述就不再改（改了就是让缓存再废一次）', n1.images[0].desc === before && b.calls.length === 1);

    // 库里早有描述（别的对话里发过）：启动后第一次也不该去请求
    const old = { id: 'c0', nodes: { 9: u(9, '', [img(IMG_B, { hash: sandbox().imgMemHash(IMG_B), desc: '一只橘猫' })]) } };
    const b2 = sandbox({ chats: [old] });
    const n4 = u(4, '', [img(IMG_B)]);
    await b2.imgMemEnsure(n4);
    t('★ 别的对话里描述过的图也认得', n4.images[0].desc === '一只橘猫' && b2.calls.length === 0, b2.calls.length);

    const refuse = sandbox({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, desc: '抱歉，我无法描述这张图片。' }) }) });
    const n5 = u(5, '', [img(IMG_A)]);
    await refuse.imgMemEnsure(n5);
    t('★ 小模型拒答不当描述存下来（存了就永远是这句）', !n5.images[0].desc, n5.images[0].desc);
    await refuse.imgMemEnsure(n5);
    t('失败过的这次运行里不再每轮重打', refuse.calls.length === 1, refuse.calls.length);

    const down = sandbox({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    const n6 = u(6, '', [img(IMG_A)]);
    await down.imgMemEnsure(n6);
    t('server 连不上：不炸，图保持没描述', !n6.images[0].desc);

    const vid = sandbox();
    const nv = Object.assign(u(7, '', [img(IMG_A), img(IMG_B)]), { videoNote: ['以下 2 张是同一段视频'] });
    await vid.imgMemEnsure(nv);
    t('视频抽帧不逐帧描述', vid.calls.length === 0 && !nv.images[0].desc);
  }

  // ── 四、刚发的图不许等 ─────────────────────────────────────────────
  console.log('\n[4] 刚发的图不许等');
  {
    let release;
    const hang = new Promise(r => { release = r; });
    const b = sandbox({ fetchImpl: () => hang.then(() => ({ ok: true, json: async () => ({ ok: true, desc: '晚到的描述' }) })) });
    const p = [u(1, '在吗'), a(2, '在'), u(3, '你看', [img(IMG_A)])];
    const t0 = Date.now();
    await b.imgMemPrepare(p, LOCAL);
    t('★ 最后一条消息里的图：发起描述但不等（发图之后不能干等小模型）', Date.now() - t0 < 200, Date.now() - t0);
    t('描述请求确实发出去了（下一轮要用）', b.calls.length === 1);
    // 下一轮：那张图成了历史，这轮要换文字 → 得等它
    const p2 = [...p, a(4, '好吃'), u(5, '是吧')];
    setTimeout(() => release(), 60);
    const t1 = Date.now();
    await b.imgMemPrepare(p2, LOCAL);
    t('★ 下一轮这张图要换成文字了：等正在跑的那次描述回来', p[2].images[0].desc === '晚到的描述' && Date.now() - t1 >= 40,
      [p[2].images[0].desc, Date.now() - t1]);
    t('等的是同一个请求，没有重打', b.calls.length === 1, b.calls.length);
  }

  // ── 五、真跑 buildApiMessages ──────────────────────────────────────
  console.log('\n[5] 真跑 buildApiMessages');
  {
    // 订阅 Claude：图那一轮 → 下一轮 → 再下一轮
    const b = sandbox();
    const chat = { id: 'c1', nodes: {} };
    const pic = u(3, '你看这个', [img(IMG_A)]);
    const p1 = [u(1, '在吗'), a(2, '在'), pic];
    const r1 = await b.buildApiMessages(p1, LOCAL, false, chat);
    const last1 = r1[r1.length - 1];
    t('★ 发图那一轮：图作为图片发出去', hasImagePart(last1), last1);
    // 等后台描述落地（真实场景里主回复要好几秒，描述早就回来了）
    await new Promise(r => setTimeout(r, 20));
    t('发图那一轮顺手把描述写好了', !!pic.images[0].desc);

    const p2 = [...p1, a(4, '看起来很好吃'), u(5, '是吧')];
    const r2 = await b.buildApiMessages(p2, LOCAL, false, chat);
    const hist2 = r2.find(m => textOf(m).includes('你看这个'));
    t('★ 下一轮：订阅通道上历史图换成了描述文字（不再丢掉）',
      !hasImagePart(hist2) && /\[图片：一碗红烧牛肉面/.test(textOf(hist2)), hist2);
    t('描述排在她那句话前面', textOf(hist2).indexOf('[图片：') < textOf(hist2).indexOf('你看这个'));

    const p3 = [...p2, a(6, '嗯'), u(7, '想吃')];
    const r3 = await b.buildApiMessages(p3, LOCAL, false, chat);
    const hist3 = r3.find(m => textOf(m).includes('你看这个'));
    t('★ 再下一轮：同一条历史消息逐字节相同（缓存 / 会话续传靠这个）',
      JSON.stringify(hist2) === JSON.stringify(hist3), [hist2, hist3]);
    const idx2 = r2.indexOf(hist2), idx3 = r3.indexOf(hist3);
    t('★ 它前面的前缀也逐字节相同', JSON.stringify(r2.slice(0, idx2 + 1)) === JSON.stringify(r3.slice(0, idx3 + 1)));

    // API 通道：最近 K 条里发原图，过了 K 条换描述，翻过去之后稳定
    const bk = sandbox();
    const pic2 = u(3, '这是什么', [img(IMG_B)]);
    let p = [u(1, '嗨'), a(2, '嗨'), pic2];
    await bk.buildApiMessages(p, APIC, false, chat);
    await new Promise(r => setTimeout(r, 20));
    const seen = [];
    let id = 10;
    for (let i = 0; i < bk.IMGMEM_RAW_TURNS + 2; i++) {
      p = [...p, a(id++, '回复' + i), u(id++, '追问' + i)];
      const r = await bk.buildApiMessages(p, APIC, false, chat);
      const h = r.find(m => textOf(m).includes('这是什么'));
      seen.push({ raw: hasImagePart(h), json: JSON.stringify(h) });
    }
    const K = bk.IMGMEM_RAW_TURNS;
    t('API 通道：最近几条里照发原图（她可能还在追问这张图）', seen.slice(0, K - 1).every(s => s.raw), seen.map(s => s.raw));
    t('API 通道：过了几条换成描述', seen.slice(K - 1).every(s => !s.raw), seen.map(s => s.raw));
    t('★ 一张图一辈子只翻一次：翻过去之后每轮一样', seen[K].json === seen[K + 1].json && seen[K - 1].json === seen[K].json);

    // 预算：换成文字之后按文字算，不再按一张图算
    t('裁剪预算里算的是描述文字（接线：shrunkImgsOf 只缩要发原图的那几张）',
      /imgMemSplit/.test(buildSrc) && /estimateTokens\(imgSplitOf\(m\)\.text\)/.test(buildSrc));
  }

  // ── 六、相册 ───────────────────────────────────────────────────────
  console.log('\n[6] 相册');
  {
    const h = sandbox().imgMemHash;
    const chats = [
      { id: 'c1', nodes: { 1: u(1, '', [img(IMG_A, { hash: h(IMG_A), desc: '牛肉面 荷包蛋' })]), 2: a(2, '') } },
      { id: 'c2', nodes: { 5: u(5, '', [img(IMG_A, { hash: h(IMG_A), desc: '牛肉面 荷包蛋' })]), 6: u(6, '', [img(IMG_B)]) } },
    ];
    const b = sandbox({ chats });
    const al = b.imgAlbum();
    t('同一张图只算一条', al.length === 2, al.length);
    t('记了发过几次', al.find(e => e.hash === h(IMG_A)).times === 2);
    t('记的是第一次出现在哪', al.find(e => e.hash === h(IMG_A)).chatId === 'c1');
    t('按描述搜得到', b.imgAlbumFind('荷包蛋').length === 1 && b.imgAlbumFind('猫').length === 0);
  }

  // ── 七、server ─────────────────────────────────────────────────────
  console.log('\n[7] server');
  {
    t('有 /api/img-describe', /app\.post\('\/api\/img-describe'/.test(server));
    t('★ 用的是显式写出来的便宜模型，不跟着 CLI 默认（默认是 Opus）',
      /IMG_DESCRIBE_MODEL\s*=[\s\S]{0,120}claude-haiku/.test(server));
    t('★ claudeOnce 收得下图片（user 可以是内容块数组）',
      /const content = Array\.isArray\(user\) \? user : \[\{ type: 'text', text: String\(user \|\| ''\) \}\];/.test(server));
    // 抠出真的校验函数跑一下
    const fn = extract(server, 'function parseImageDataUrl(', '\n}\n') + '\n}';
    const parse = vm.runInNewContext('(' + fn.replace('function parseImageDataUrl', 'function') + ')');
    t('收 data:image/jpeg;base64', !!parse(IMG_A) && parse(IMG_A).media_type === 'image/jpeg');
    t('★ 不收别的东西（网址、svg、文本）', !parse('https://x/y.png') && !parse('data:image/svg+xml;base64,AAAA') && !parse('data:text/plain;base64,AAAA'));
    t('不收超大的', !parse('data:image/png;base64,' + 'A'.repeat(7000000)));
    t('jpg 写法归一成 image/jpeg（API 只认后者）', parse('data:image/jpg;base64,AAAA').media_type === 'image/jpeg');
  }

  // ── 八、接线 ───────────────────────────────────────────────────────
  console.log('\n[8] 接线');
  t('脚本挂进了 index.html', /js\/60-imgmem\.js/.test(html));
  t('★ buildApiMessages 先补描述再算裁剪', buildSrc.indexOf('imgMemPrepare(') > 0 && buildSrc.indexOf('imgMemPrepare(') < buildSrc.indexOf('for (const m of pathReversed)'));
  for (const f of ['js/60-imgmem.js', 'js/05-prompts-api.js', 'index.html']) {
    t(`android 副本与 ${f} 一致`, fs.existsSync(path.join(ROOT, 'android/assets', f)) && read(f) === read('android/assets/' + f));
  }

  console.log(`\n════ ${pass} 过 / ${fail} 挂 ════\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
