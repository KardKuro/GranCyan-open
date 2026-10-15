// 檐廊（engawa-mcp）接入的回归测试。
//
// 写法上刻意偏向**跑真函数**而不是 src.includes：
// 指令解析、结果格式化、历史回填、流式遮罩全是纯函数，能真跑就别验源码正则
// （源码断言只用在"挂载点在不在"这种没法跑的地方）。
// 尤其回填那条：用的是 05-prompts-api 里真正的 stickerTagForApi，
// **不在这里手抄一份正则** —— 手抄的话，改坏了源码这边照样绿。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// 主体包在 async IIFE 里：并发那条断言必须 await 真的 Promise 交错，
// 顶层 await 在普通 .js 脚本里不合法。
(async () => {

const engawaSrc = fs.readFileSync(path.join(JS, '40-engawa.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(JS, '05-prompts-api.js'), 'utf8');
const renderSrc = fs.readFileSync(path.join(JS, '06-render-msg.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(JS, '01-core.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(JS, '02-state.js'), 'utf8');
const bootSrc = fs.readFileSync(path.join(JS, '14-boot-brain-hub.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'grancyan.css'), 'utf8');

// 真的 escHtml，从 09-appearance-input.js 里抠出来 —— 不手写一个「差不多的」，
// 转义行为差一点，下面那条「回填后不含裸 HTML」就可能假绿。
const escSrc = fs.readFileSync(path.join(JS, '09-appearance-input.js'), 'utf8')
  .match(/function escHtml\(str\)\s*\{[\s\S]*?\n\}/)[0];

const sandbox = {
  console, Date, JSON, Math, String, Number, Array, Object, RegExp,
  state: { engawaOn: true, configs: [] },
  save() {}, showToast() {}, fetch() {}, document: { getElementById: () => null },
  URL,   // _gazeSafeUrl 用它判协议；沙箱里不给的话所有地址都会被判死（假红）
  setTimeout, clearTimeout, Promise,
  _setModelGateVisual() {}, renderModelGate() {}, SERVER_BASE: '',
};
vm.createContext(sandbox);
vm.runInContext(escSrc, sandbox);
vm.runInContext(engawaSrc, sandbox);

// ── [1] 指令解析 ──────────────────────────────────────────
console.log('\n[1] 指令解析');
const P = sandbox.gazeParse;

t('无参数工具', JSON.stringify(P('daily_poem')) === JSON.stringify({ tool: 'daily_poem', args: {} }));
t('主参数名由表补上（模型只写地址，不写 url=）',
  P('web_read https://example.com').args.url === 'https://example.com');
t('rss_read 用 feed_url 而不是 url（参数名各不相同，写错就断链）',
  P('rss_read aeon').args.feed_url === 'aeon');
t('末尾数字当 offset 摘走', (() => {
  const r = P('web_read https://example.com/a 3000');
  return r.args.url === 'https://example.com/a' && r.args.offset === 3000;
})());
t('★ URL 里的数字不被误当 offset 摘掉（要求数字前有空格）', (() => {
  const r = P('web_read https://site.com/2026/08/post-12345');
  return r.args.url === 'https://site.com/2026/08/post-12345' && r.args.offset === undefined;
})());
t('limit 类工具的数字进 limit 不进 offset', P('arxiv_new cs.CL 3').args.limit === 3);
t('历史上的今天默认中文（引擎默认 en）', P('on_this_day').args.lang === 'zh');
t('显式给语言时不被覆盖', P('on_this_day en').args.lang === 'en');
t('大小写不敏感', P('DAILY_POEM').tool === 'daily_poem');
t('未知工具标记为 bad（前端直接回词表，不白跑一趟后端）', P('rm_rf /').bad === true);
t('空指令返回 null', P('   ') === null);

// ── [2] 结果格式化 ────────────────────────────────────────
console.log('\n[2] 结果格式化');
const F = sandbox._gazeFormat;

t('诗：句子 + 出处都在', (() => {
  const f = F('daily_poem', { json: { ok: true, sentence: '接天莲叶无穷碧', author: '杨万里', dynasty: '宋代', title: '晓出净慈寺' } });
  return f.body.includes('接天莲叶无穷碧') && f.body.includes('杨万里') && f.body.includes('宋代');
})());
t('画：图片地址单独出来（给 <img> 用，不混在正文里）', (() => {
  const f = F('daily_art', { json: { ok: true, title: 'Fragment', image_url: 'https://x/y.jpg' } });
  return f.img === 'https://x/y.jpg' && f.body.includes('Fragment');
})());
t('天文图认 image_url，也认引擎万一回的 url', F('apod', { json: { ok: true, url: 'https://a/b.jpg' } }).img === 'https://a/b.jpg');
t('长文没读完时说清还剩多少（模型据此决定要不要接着翻页）', (() => {
  const f = F('web_read', { json: { ok: true, title: 'T', content: 'abc', total_length: 9000 } });
  return /9000/.test(f.body) && /3/.test(f.body);
})());
t('★ 上游坏了照实说，不折叠成空（README：沉默的省略也是谎）', (() => {
  const f = F('apod', { json: { ok: false, error: 'NASA 限频了' } });
  return f.body.includes('NASA 限频了');
})());
t('★ 连不上引擎时错误原样带到正文里', F('daily_poem', { err: '⚠️ 连不上檐廊：boom' }).body.includes('boom'));
t('正文里的 HTML 被转义（画名带尖括号也不破版）', (() => {
  const f = F('daily_art', { json: { ok: true, title: '<script>x</script>' } });
  return !f.body.includes('<script>') && f.body.includes('&lt;script&gt;');
})());

// ── [3] 结果块 → 历史回填 ─────────────────────────────────
// 这一节是整个接入的命脉：模型全靠回填才看得见自己上一轮看到了什么。
// 跑的是 05-prompts-api 里真正的 stickerTagForApi，不是手抄的正则。
console.log('\n[3] 历史回填（跑真的 stickerTagForApi）');

const apiSandbox = { console, Date, JSON, Math, String, Number, Array, Object, RegExp, state: {}, escHtml: sandbox.escHtml };
vm.createContext(apiSandbox);
let stickerFn = null;
try {
  const fnSrc = apiSrc.match(/function stickerTagForApi\(content\)[\s\S]*?\n\}/);
  vm.runInContext(fnSrc[0], apiSandbox);
  stickerFn = apiSandbox.stickerTagForApi;
} catch (e) { /* 下面那条断言会红 */ }

t('取到了真的 stickerTagForApi（取不到说明函数被改名/改形，回填断言全部作废）', typeof stickerFn === 'function');

if (typeof stickerFn === 'function') {
  const blockWithImg = sandbox._gazeBlockHtml('daily_art', 'daily_art', {
    json: { ok: true, title: 'Fragment (Dress Fabric)', artist: 'China', image_url: 'https://i/x.jpg', page_url: 'https://p/1' },
  });
  const back = stickerFn(blockWithImg);

  t('★ 结果块被压回正牌指令格式 [[GAZE: …]]（写成别的格式 = 模型照着学 = 断链）',
    /\[\[GAZE:\s*daily_art\s*\]\]/.test(back), back.slice(0, 120));
  t('结果内容跟着回去了（模型看得见自己看到了什么）', back.includes('Fragment (Dress Fabric)'));
  t('★ 图片地址保留成 [图片 url]，模型下一轮还能引用它', /\[图片 https:\/\/i\/x\.jpg\]/.test(back));
  t('★ 回填后不含裸 HTML 标签（喂裸 <img>/<a> 给模型 = 费 token + 教它写 HTML）',
    !/<img|<a\s|<\/a>|<b>|<div/.test(back), back.match(/<[a-z][^>]*>/gi));
  t('链接压成「文字（地址）」而不是丢掉地址', back.includes('https://p/1'));
  t('HTML 实体还原成真字符', !back.includes('&amp;') && !back.includes('&lt;'));

  // 反向：没有檐廊块的普通文本不该被这条规则动到
  const plain = stickerFn('普通一句话，没有任何块。');
  t('不误伤普通文本', plain.includes('普通一句话'));

  // ── 说话块（[[SAY:]]）发回给模型 ────────────────────────
  // 以前这里**一条规则都没有**：整坨 <div class="think-block…"> 裸 HTML 直接进模型眼里，
  // 又费 token 又教它写 HTML，而且它读不出自己那句到底发出去没有。
  const sayBlock = sandbox._sayBlockHtml('xhs 000000000000000000000003 这个也太好笑了',
    { said: '这个也太好笑了', json: { state: 'submitted', quota: { usedToday: 1, max: 3 } } });
  const sayBack = stickerFn(sayBlock);
  t('★ 说话块压回正牌指令格式 [[SAY: 站 id 话]]（站点和 id 只在 data-say 里，丢了就还原不出）',
    /\[\[SAY:\s*xhs\s+000000000000000000000003\s+这个也太好笑了\s*\]\]/.test(sayBack), sayBack.slice(0, 160));
  t('★ 回执跟着回去（模型得知道自己那句到底发出去没有）',
    /提交/.test(sayBack) && sayBack.includes('这个也太好笑了'));
  t('★ 说话块回填后不含裸 HTML', !/<div|<span|<br>|<b>/.test(sayBack), sayBack.match(/<[a-z][^>]*>/gi));
  t('说话块不会被檐廊那条规则吃掉（两条的 <div 前缀一样，只靠 data-say 和标签文字分）',
    !/\[\[GAZE:/.test(sayBack));

  // 老历史里的块没有 data-say（那时候还没存指令）。不能不管：不管就是裸 HTML 进模型。
  const legacySay = sayBlock.replace(/ data-say="[^"]*"/, '');
  const legacyBack = stickerFn(legacySay);
  t('★ 老的说话块（没有 data-say）也压成人话，不留裸 HTML',
    !/<div|<span|<br>/.test(legacyBack) && legacyBack.includes('这个也太好笑了'), legacyBack.slice(0, 120));

  // ── [3.2] 跨文件契约：回填格式 ↔ 补发判据（Codex 三审要求的）───────
  // server.js 的 carryHasResult 靠「[[GAZE: …]] 后面紧跟一行 看到的:」判断上一轮
  // 到底有没有真拿到东西。那个形状是 **05-prompts-api.js 的 stickerTagForApi 定的**，
  // 两个文件隔着前后端，谁都能单方面改。
  // 各自硬编码一份中文字面量的话，改一边忘另一边 → 判据永远回 false → 补发静默失效
  // → 退回「模型伸了手、手回来是空的」那个原始 bug，而且两边测试**都还是绿的**。
  // 所以这里把真的块 → 真的 stickerTagForApi → 真的 carryHasResult 串起来跑一遍。
  let carryHasResult = null;
  try {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
    const seg = srv.match(/const CARRY_RESULT_RE = [\s\S]*?\nfunction carryHasResult\(text\) \{[^\n]*\n/);
    const box = { String, RegExp };
    vm.createContext(box);
    vm.runInContext(seg[0] + '\nthis.f = carryHasResult;', box);
    carryHasResult = box.f;
  } catch (e) { /* 下面那条断言会红 */ }

  t('取到了真的 carryHasResult（取不到说明 server.js 那段改形了，契约断言作废）',
    typeof carryHasResult === 'function');
  if (typeof carryHasResult === 'function') {
    t('★ 契约：stickerTagForApi 吐出来的 GAZE 回填，carryHasResult 认得（认不得 = 补发静默失效）',
      carryHasResult(back) === true, back.slice(0, 80));
    t('★ 契约：stickerTagForApi 吐出来的 SAY 回执，carryHasResult 也认得',
      carryHasResult(sayBack) === true, sayBack.slice(0, 80));
    // 反向：光有标记词、标签是裸的，不算拿到（Codex 三审：模型写得出「我看到的:」）
    t('★ 裸标签 + 别处一句「我看到的:」不算 —— 标记必须紧跟在标签后面',
      carryHasResult('[[GAZE: xhs]] 等我一下\n\n我看到的: 天上有只鸟') === false);
    t('★ 标签和标记之间隔着正文也不算（那是叙述，不是回填）',
      carryHasResult('[[GAZE: xhs]]\n刷了一下\n看到的:\n东西') === false);
  }
}

// ── [3.3] 全角冒号（Codex 二审逮到的）──────────────────────
// 「刻意不兼容变体」的前提是：写歪了就当没写、原样漏出来——那是**看得见**的失败。
// 全角冒号这条不是：stickerTagForApi 发回历史时会把 [[GAZE：]] 掰成 [[GAZE:]]，
// 于是模型下一轮看见的是正确范例、以为自己写对了，而这一轮的预取压根没执行。
// 前端不报错、模型不知情、用户只看到「它说要看却什么都没看」。
console.log('\n[3.3] 全角冒号也得认（否则指令静默不执行）');
{
  t('★ gazeTagRe 认全角冒号', /\[\[GAZE：\s*xhs\s*\]\]/.test('[[GAZE： xhs]]')
    && '[[GAZE： xhs]]'.replace(sandbox.gazeTagRe(), 'X') === 'X');
  t('★ outTagRe 认全角冒号（两种标签都要）',
    '[[GAZE： xhs]]和[[SAY： xhs a1 好]]'.replace(sandbox.outTagRe(), 'X') === 'X和X');
  t('★ 半角照常认（别为了兼容全角把正牌写法弄坏了）',
    '[[GAZE: xhs]]'.replace(sandbox.outTagRe(), 'X') === 'X');
  t('★ 全角写的指令真的会被解析出来，不是静默丢掉', (() => {
    const hits = [...'[[GAZE： daily_poem]]'.matchAll(sandbox.outTagRe())];
    return hits.length === 1 && hits[0][1] === 'GAZE' && hits[0][2].trim() === 'daily_poem';
  })());
  t('★ 流式打字时全角的裸指令也被遮住（漏了会一闪一闪地露出来）',
    !/\[\[/.test(sandbox.maskStreamingGaze('前[[GAZE： xhs]]后')));
  t('★ 关了功能时全角的裸指令也抹得掉',
    sandbox.applyGazeToText('前[[GAZE： xhs]]后', [], { id: 'x', engawaOn: false }) === '前后');
}

// ── [3.4] 推荐流是谁的（2026-08-23）────────────────────────
// 用户看一眼就说「这推的啥啊，不是我号吧」—— 她是对的。server 那条 axios 一个 cookie
// 都不带，抓回来的是算法给**陌生人**的推荐。实测同一时刻：游客流全是清仓爆款和明星八卦，
// 跟登录号上的推荐完全是两个世界。
//
// 这件事**零报错**：抓取成功、条数正常、结构也对。唯一的征兆是内容不像她 ——
// 只有她本人认得出来，模型完全不知情，会把陌生人的推荐当成她的品味来聊天。
// 所以回落时必须把「这是游客流」摆到台面上，两边（她和模型）都看得见。
console.log('\n[3.4] 推荐流是谁的（游客流必须标出来）');
{
  const feedBlock = (j) => sandbox._gazeFormat('xhs', { json: j }).body;
  const mk = (extra) => Object.assign({
    ok: true, kind: 'xhs_feed', total: 2,
    items: [{ id: 'a1b2c3d4', title: '二维动画我真的渲不动了', author: '汪师傅', likes: '996' }],
  }, extra);

  t('★ 游客流会明说「不是你自己的号」（不说的话用户只能靠内容怪去猜）',
    /游客推荐流/.test(feedBlock(mk({ guest: true }))) && /不是你自己的号/.test(feedBlock(mk({ guest: true }))));
  t('★ 登录态的推荐流不挂这条警示（挂了就是天天喊狼来了）',
    !/游客推荐流/.test(feedBlock(mk({ guest: false }))));
  t('两种情况下笔记 id 都在（模型要靠它点开某一条 / 评论）',
    /a1b2c3d4/.test(feedBlock(mk({ guest: true }))) && /a1b2c3d4/.test(feedBlock(mk({ guest: false }))));

  t('★ 登录判不出来时说「判不出来」，不假装是她的号', (() => {
    const b = feedBlock(mk({ guest: true, whoUnknown: true }));
    return /判不出/.test(b) && !/游客推荐流/.test(b);
  })());
  t('★ 确认登录时显示是以谁的身份看的', /SomeNick/.test(feedBlock(mk({ guest: false, who: 'SomeNick' }))));
  t('★ 登录判据不能用 a[href^="/user/profile/"]（这一页上有 34 个，33 个是推荐卡的作者）',
    !/querySelector\('a\[href\^="\/user\/profile\/"\]'\)/.test(
      fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8').split('xhsExploreFeeds')[1] || ''));

  // server 侧接线。这三条只能验源码（真跑要一个登录着的 Chrome），
  // 但**每一条都对应一种静默失败**，比不验强。
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('★ xhsFeed 先问登录着的浏览器要（不问的话永远是游客流）',
    /xhsExploreFeeds\(\)/.test(srvSrc));
  t('★ 浏览器那条路坏了要回落，不能让整个 [[GAZE: xhs]] 失败',
    /catch[\s\S]{0,200}回落游客流/.test(srvSrc));
  t('★ 两条路都得带 guest 字段 —— 漏一条就分不清这屏是谁的推荐',
    (srvSrc.match(/guest:/g) || []).length >= 2);
  t('★ 走没走通要留痕（这次的 bug 就是靠静默回落藏了一个月）',
    /推荐流走\$\{?/.test(srvSrc) || /\[小红书\] 推荐流走/.test(srvSrc));
  const sbSrc = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8');
  t('★ xhsExploreFeeds 自己不阻塞地等 Chrome（冷启动要 20 秒，挂在这条请求上等于卡死这一轮）',
    /chromeAlive\(\)\) return \{ chromeDown: true \}/.test(sbSrc));
  // Codex 三审：「标明是游客流」对「宁可给点内容」成立，对「修成我的号」不成立 ——
  // 用户的原话是「这推的啥啊，不是我号吧」，端着陌生人的推荐加一行小字，修的是措辞不是内容。
  t('★ 浏览器没跑时**不端游客流上桌**，如实说看不了',
    /chromeDown[\s\S]{0,400}noGuestFallback = true/.test(srvSrc));
  t('★ 那条故意的拒绝不能被「坏了就回落」的 catch 吞掉（吞了就照样是游客流）',
    /catch \(e\) \{[\s\S]{0,120}noGuestFallback\) throw e/.test(srvSrc));
  // ⚠️ 「不许 await」这条只管 **kickXhsChromeUp 这一条路**，范围必须框在它函数体内。
  //   原来后半截是全文搜 `await …ensureChrome`，2026-09-05 加「浏览器」开关时误伤了：
  //   那一档在 spawn 之前**必须** await 一次 ensureChrome（playwright MCP 是启动时连
  //   CDP 的，连不上的话工具压根不出现，不是调用失败），是另一条路上的合法写法。
  //   两条路的取舍正好相反：GAZE 那轮宁可这次没有、也不能卡她 20 秒；
  //   浏览器档宁可等一下、也不能让AI以为自己没有浏览器。全文搜分不出这两者。
  const kickBody = (srvSrc.match(/function kickXhsChromeUp\(\) \{[\s\S]{0,600}?\n\}/) || [''])[0];
  t('★ 拉浏览器是给下一次用的，不 await（await 的话这一轮回复要卡到 20 秒）',
    /\.then\(/.test(kickBody) && !/await/.test(kickBody), kickBody.slice(0, 200));
  t('★ 拉起有冷却（Chrome 装都没装的机器上，每刷一次推荐流就 spawn 一次）',
    /_xhsChromeKickAt[\s\S]{0,120}return;/.test(srvSrc));

  // ── 登录三态：把页面里那段真 JS 抠出来，喂假的 __INITIAL_STATE__ 跑 ──
  // 这段平时跑在 Chrome 里，测试碰不到；但它就是「这是不是用户的号」的唯一判据，
  // 判错的两个方向后果完全不同：报假的 true → 陌生人的推荐被当成她的品味（这次的 bug）；
  // 把「读不到人名」报成 false → UI 说「浏览器没开或没登录」，一句她照着查也查不出毛病的假话。
  const pageJs = (sbSrc.match(/inPage\('https:\/\/www\.xiaohongshu\.com\/explore', `([\s\S]*?)`, \{ wait/) || [])[1];
  t('抠到了页面里那段登录判据（抠不到说明改形了，下面三态断言作废）', !!pageJs);
  if (pageJs) {
    // ⚠️ feeds 必须可控（Codex 六审）：原来这里**写死**喂一条 feed，
    // 于是「内容为空时身份还在不在」这条路一次都没走过 —— 而页面脚本当时
    // 第一件事就是 feeds 空了直接 return null，把已经读到的「没登录」整个吞掉。
    const runWith = (user, feeds) => {
      const box = {
        window: { __INITIAL_STATE__: { user, feed: { feeds: feeds === undefined ? [{ id: 'a1', noteCard: {} }] : feeds } } },
        Array, JSON,
      };
      vm.createContext(box);
      return vm.runInContext(pageJs, box);
    };
    t('★ 确认登录 + 拿到人名 → true', runWith({ loggedIn: true, userInfo: { nickname: 'SomeNick' } }).loggedIn === true);
    t('★ 确认没登录 → false（不是 null —— 这个是真判出来了）',
      runWith({ loggedIn: false, userInfo: {} }).loggedIn === false);
    t('★ 标志读不到 → null（判不出来就说判不出来，别猜）',
      runWith({}).loggedIn === null);
    t('★ 标志为真但人名读不到 → null，**不是 false**（Codex 三审：这一格最容易压扁）',
      runWith({ loggedIn: true, userInfo: {} }).loggedIn === null);
    t('★ Vue ref 形态（{_value}）也认得 —— 小红书两种形态都出现过',
      runWith({ loggedIn: { _value: true }, userInfo: { _value: { nickname: 'SomeNick' } } }).loggedIn === true);
    t('Vue ref 的 false 也是 false（不是「读不到」）',
      runWith({ loggedIn: { _value: false }, userInfo: { _value: {} } }).loggedIn === false);
    t('Vue ref 为真但 userInfo 是空的 → null',
      runWith({ loggedIn: { _value: true }, userInfo: { _value: {} } }).loggedIn === null);

    // ── 内容为空时，身份的事实还在不在（Codex 六审）──────────────
    // 这是同一个 bug 的**上游**：五审我在 xhsExploreFeeds 外层加了「false 无条件带出去」，
    // 但页面脚本内部早就 return null 了，外层守卫根本接不到。
    // 推荐流没加载完、feed 字段改版、filter 全滤掉 —— 都会走到这里。
    t('★ 确认没登录 + 推荐流一条都没有 → 仍旧返回 false（身份不许被空内容吞掉）',
      (runWith({ loggedIn: false, userInfo: {} }, []) || {}).loggedIn === false);
    t('★ 确认没登录 + feed 字段整个不见（页面改版）→ 仍旧返回 false',
      (runWith({ loggedIn: false, userInfo: {} }, null) || {}).loggedIn === false);
    t('★ Vue ref 的 false + 空内容 → 一样带得出去',
      (runWith({ loggedIn: { _value: false }, userInfo: { _value: {} } }, []) || {}).loggedIn === false);
    t('判不出身份 + 内容也空 → 才回 null（这种确实没什么可交代的）',
      runWith({}, []) === null);

    // ── uid 只认稳定来源，不拿 redId 兜底（Codex 七审）────────────
    // redId 是「小红书号」（somenick_01 那种），可以改，是展示 id 不是主键。
    // 拿它兜底 → 页面改版只给 redId 时，uid 被填成一个跟配置里 userId 明确不符的值
    // → meMatch=false → **她自己的号被硬拒成「别人的号」**。正确行为是留空 → 判不出。
    t('★ 只有 redId、没有 userId → uid 留空（不拿可变的小红书号冒充稳定 id）',
      runWith({ loggedIn: true, userInfo: { nickname: 'SomeNick', redId: 'somenick_01' } }).uid === '');
    t('★ 有 userId 就用 userId（redId 同时存在也不干扰）',
      runWith({ loggedIn: true, userInfo: { nickname: 'SomeNick', userId: '0000000000000000000000b0', redId: 'somenick_01' } }).uid === '0000000000000000000000b0');
    t('redId 仍然如实带出来（只是不参与身份判定）',
      runWith({ loggedIn: true, userInfo: { nickname: 'SomeNick', redId: 'somenick_01' } }).redId === 'somenick_01');
    t('确认登录 + 内容空 → null（身份有了但没内容可端，交给外层回落）',
      runWith({ loggedIn: true, userInfo: { nickname: 'SomeNick' } }, []) === null);
  }

  // ── 不可逆动作只做一次（Codex 七审）──────────────────────────
  // ⚠️ 这一组是**源码断言**，跟「断言验行为别验源码正则」那条规矩相反，所以说清理由：
  //    要守的不是某个返回值，是「这段代码里不存在第二次点击」这个**结构性**事实。
  //    行为测试没法证明「不存在」—— 桩一个慢响应只能证明这一种路径下没重复点，
  //    而真正危险的是以后有人**再加一条别的兜底路径**回来。那种改动只有源码断言拦得住。
  //    2026-08-24 的原委：我为一个不存在的 bug（真实原因是用户在同一个 Chrome 里抢鼠标）
  //    加了「250ms×6 没看到请求就补一次真实鼠标点击」的兜底，而判据看的是
  //    Network.responseReceived —— **响应**到没到，不是**请求**发没发出去。
  //    小红书响应慢过 1.5 秒，第一次点击其实已经发出去了，兜底再点一次 → 同一条评论发两遍。
  {
    const sb3 = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8').replace(/\r\n/g, '\n');
    const seg = sb3.match(/async function xhsSay\([\s\S]*?\n\}/);
    t('抠到了真的 xhsSay（抠不到说明改形了，下面的断言作废）', !!seg);
    if (seg) {
      const body = seg[0];
      const clicks = (body.match(/\.btn\.submit'\)\.click\(\)/g) || []).length;
      t('★ 发送按钮**只点一次**（不可逆动作不许重试 —— 重复点 = 同一条评论发两遍，撤不回来）',
        clicks === 1);
      t('★ xhsSay 里不用坐标鼠标事件点发送（它最怕的就是有人同时在抢这个浏览器）',
        !/dispatchMouseEvent/.test(body));
      // 「点完之后没看见请求」只能报错，不能再点。
      const afterClick = body.slice(body.indexOf(".btn.submit').click()"));
      t('★ 点击之后没有任何「再点一次」的分支（posts 为空只许报错，不许补刀）',
        !/click\(\)|dispatchMouseEvent/.test(afterClick.slice(25)));
    }
  }

  // ── xhsSay 到底有没有把耳朵接上（Codex 八审之前，实测逮到的活 bug）─────
  // 2026-08-24：一条真评论发出去了，路由却报「点了发送，但压根没发出 comment/post 请求」，
  // 而且是 notSent —— **确定性的假话**：额度不扣、账本记 notsent，评论真的在外面。
  // 根因：xhsSay 顶上定义了 onEvent、备好了 posts，`withTab(url, fn, { wait: 6500 })`
  // 却没把 onEvent 传进去 —— 监听器一次都没挂上，posts 永远是空的。
  // decideSayOutcome 被单测验到烂熟，可**没有一条断言验过它的输入是从哪来的**。
  // 所以这一组不看源码长相，直接跑真的 xhsSay：桩一个 withTab，在「点发送」那一刻
  // 通过 opts.onEvent 把网络事件喂回去，看它认不认得。不接线的话这里必红。
  {
    const sb5 = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8').replace(/\r\n/g, '\n');
    const grab = (re) => (sb5.match(re) || [])[0] || '';
    const src = [
      grab(/^function notSent\(.*$/m),
      grab(/^function decideSayOutcome\([\s\S]*?\n\}/m),
      grab(/^async function xhsSay\([\s\S]*?\n\}/m),
    ];
    t('抠到了真的 xhsSay / decideSayOutcome（抠不到说明改形了，下面的断言作废）',
      src.every(Boolean));
    if (src.every(Boolean)) {
      // fed = 桩在「点发送」那一刻喂回去的网络事件；resp = 小红书的回包
      const runSay = async (resp, { feed = true, respond = true, boom = '', twice = false } = {}) => {
        let typed = '', clicked = 0, opts = null;
        const box = {
          JSON, String, Error, Object, Array, Promise, Buffer, Number, console: { log() {}, warn() {} },
          sleep: () => Promise.resolve(),
          xhsNoteUrl: (id, tok) => `https://x/${id}?t=${tok}`,
          needToken: (_id, tok) => tok,
          evalIn: async (s, js) => {
            // boom = 在某个阶段扔一个**不带标记**的普通 Error（标签页被关、CDP 断开）
            if (boom === 'pre' && js.includes('hasBtn')) throw new Error('标签页没了');
            if (js.includes("!!document.querySelector('#content-textarea')")) return true;
            if (js.includes("!!document.querySelector('.btn.submit')")) return true;
            if (js.includes('i.click();i.focus()')) return 1;
            if (js.includes('hasBtn')) return { typed, disabled: false, hasBtn: true };
            if (js.includes(".btn.submit').click()")) {
              clicked++;
              // 点击那一下自己抛错 —— **不能证明页面没执行**，所以只能是 unknown
              if (boom === 'click') throw new Error('CDP 断了');
              // 请求发出去了 —— 事件从 CDP 那条线回来，只有接了 onEvent 才收得到
              if (feed && opts && opts.onEvent) {
                opts.onEvent({ method: 'Network.requestWillBeSent',
                  params: { requestId: 'r1', request: { url: 'https://edith.xiaohongshu.com/api/sns/web/v1/comment/post' } } });
                if (respond) {
                  opts.onEvent({ method: 'Network.responseReceived',
                    params: { requestId: 'r1', response: { url: 'https://edith.xiaohongshu.com/api/sns/web/v1/comment/post' } } });
                  opts.onEvent({ method: 'Network.loadingFinished', params: { requestId: 'r1' } });
                }
              }
              return undefined;
            }
            return undefined;
          },
          withTab: async (url, fn, o) => {
            if (boom === 'tab') throw new Error('连不上浏览器');
            opts = o || null;
            const mkSess = async () => ({
              send: async (method, params) => {
                if (method === 'Input.insertText') { typed = params.text; return {}; }
                if (method === 'Network.getResponseBody') return { body: JSON.stringify(resp), base64Encoded: false };
                return {};
              },
            });
            const s = await mkSess();
            // twice = 模拟「以后有人给 withTab 加了重试」。整个 notSent 判定都压在
            //   「fn 只被调用一次」这个没写下来的约定上，所以 xhsSay 必须自己扛住。
            //   ⚠️ 这里**不许** try/catch 吞异常：上一版把它写在 mkSess 之前，
            //      TDZ 报错被 catch 吃掉，第二次调用根本没发生，断言就成了假绿。
            if (twice) await fn(await mkSess());
            return fn(s);
          },
        };
        vm.createContext(box);
        vm.runInContext(src.join('\n'), box);
        vm.runInContext('this.__say = xhsSay;', box);
        try { return { ok: true, r: await box.__say('n1', 'tok', '喂'), clicked }; }
        catch (e) { return { ok: false, err: e.message, notSent: !!e.notSent, unknown: !!e.unknown, clicked }; }
      };

      const good = await runSay({ success: true, data: { comment: { id: 'c9', status: 0 } } });
      t('★★ onEvent 真的接在 withTab 上了（没接的话 posts 永远空，真发出去的评论会被报成「压根没发出」）',
        good.ok === true, good.ok ? '' : good.err);
      t('★★ 接上之后认得出这是发成功了',
        good.ok && good.r.state === 'submitted' && good.r.commentId === 'c9');
      t('★ 全程只点了一次发送', good.clicked === 1);

      const bad = await runSay({ success: false, msg: '被拒了' });
      t('★ 小红书拒了 → notSent（确定没发出去，退额度）',
        bad.ok === false && bad.notSent === true);

      // ⚠️ 点下去之后**再也没有「确定没发出去」这一档**（Codex 八审）。
      // 一个事件都没看见，不等于请求没离开机器 —— 可能是响应丢了、连接断了、事件没来。
      // 报 notSent 就是告诉调用方「可以重发」，而重发 = 同一条评论发两遍。
      const none = await runSay({}, { feed: false });
      t('★★ 一个事件都没看见 → unknown，**不是** notSent（点击不可逆，不许说「确定没发出去」）',
        none.ok === false && none.unknown === true && none.notSent === false, none.err);
      // 这一条保证上面那条不是假绿：确实是「没看见请求」这条路走到底了
      t('★ 而且报的就是「一个 comment/post 请求都没看见」这件事',
        none.ok === false && none.err.includes('一个 comment/post 请求都没看见'), none.err);
      // 看见请求、始终没等到响应 —— 更明显的「可能已经发出去了」
      const inflight = await runSay({}, { respond: false });
      t('★★ 看见请求但没等到响应 → unknown（请求已经离机，最不能退额度的就是这种）',
        inflight.ok === false && inflight.unknown === true && inflight.notSent === false, inflight.err);
      // ⚠️ 上面那条单看 unknown 是**假绿**：一个事件都没收到时也是 unknown。
      // 真正要守的是「它知道请求已经发出去了」—— 而这只有从 requestWillBeSent 建档才办得到。
      t('★★ 而且它知道那个请求真的发出去了（只从 responseReceived 建档的话，这条必红）',
        inflight.ok === false && /发了 1 个请求/.test(inflight.err), inflight.err);

      // ── 阶段闸（Codex 九审）：点击**之前**的意外都确定没发出去，必须退额度 ──
      // 原来这些抛的是不带标记的普通 Error，调用方一律按 unknown 处理 = 白扣一条额度。
      // 方向是安全的（宁可少发不重发），但它是错的，而且错得毫无征兆。
      const preBoom = await runSay({}, { boom: 'pre' });
      t('★★ 点击之前标签页没了 → notSent（确定一个字没发出去，额度退回来）',
        preBoom.ok === false && preBoom.notSent === true && preBoom.unknown === false, preBoom.err);
      const tabBoom = await runSay({}, { boom: 'tab' });
      t('★★ 浏览器压根没连上 → notSent（连标签页都没开，更不可能发出去）',
        tabBoom.ok === false && tabBoom.notSent === true, tabBoom.err);
      // ⚠️ 这条是上面两条的**反面**，缺了它阶段闸就能被写成「一律 notSent」：
      const clickBoom = await runSay({}, { boom: 'click' });
      t('★★ 点击那一下自己抛错 → unknown，**不许**退额度（抛错只说明没拿到回执，那一下可能已经点下去了）',
        clickBoom.ok === false && clickBoom.unknown === true && clickBoom.notSent === false, clickBoom.err);

      // ⚠️ 契约守卫（Codex 十审提的脆弱点）：今天的 withTab 是直着 `await fn(s)`，
      //   没有 race、没有重试，fn 只跑一次 —— 上面那套判定全压在这个事实上。
      //   哪天有人给它加个重试，第二次会在「上一次可能已经发出去了」的情况下再点一下。
      //   所以 xhsSay 自己拦：第二次进来直接 unknown，绝不点第二下。
      const retried = await runSay({ success: true, data: { comment: { id: 'c9', status: 0 } } }, { twice: true });
      t('★★ withTab 要是重试了，第二次绝不再点发送（拆掉守卫的话这里会点两次）',
        retried.clicked === 1, '点了 ' + retried.clicked + ' 次');
      t('★★ 而且第二次的结论是 unknown —— 上一次可能已经发出去了，不许退额度',
        retried.ok === false && retried.unknown === true && retried.notSent === false, retried.err);
    }
  }

  // ── 外带 token 只借这一次，不许写进缓存（Codex 七审）─────────────
  // 原来的写法是「拿到 token 就 rememberToken」，而且排在站点/正文校验**之前**。
  // 失败场景：缓存里本来存着这条笔记的有效 token，调用方抄错一个 → 好的当场被顶掉 →
  // 之后所有不带 token 的 SAY、读笔记跟着一起坏，直到重新刷推荐流。
  // 「本次请求带来的输入」不该在被验证之前改动**跨请求的共享状态**。
  {
    // 2026-08-26 把发送的整套护栏抽进了 sendComment（草稿那条路要复用它，护栏不能有第二份），
    // 路由从此只是薄壳。
    const sb4 = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8').replace(/\r\n/g, '\n');
    // ⚠️⚠️ **路由体和 sendComment 两段都要抠**（2026-08-28 被故障注入逮到）。
    //   我 08-26 把护栏抽进 sendComment 之后，只抠了函数体，还声称「语义没降级」——
    //   那句话是错的：`const tok = ...` 那行留在**路由体**里，于是「非法站点的请求
    //   也能污染 token 缓存」这条注入打进去，测试一条都不红（红 0 命中 0）。
    //   抠一半 = 那一半没人守，而且看不出来。两段拼起来跑，调的是路由 handler。
    const segFn = sb4.match(/    async function sendComment\([\s\S]*?\n    \}\n/);
    const segRoute = sb4.match(/    app\.post\('\/api\/social-browser\/say'[\s\S]*?\n    \}\);\n/);
    t('抠到了真的 sendComment（抠不到说明改形了，下面的断言作废）', !!segFn);
    t('也抠到了真的 say 路由（token 的入口在这儿，只抠函数体会漏掉它）', !!segRoute);
    const seg = segFn && segRoute ? [segRoute[0] + '\n' + segFn[0]] : null;
    if (seg) {
      // 把它依赖的东西全换成桩，看它到底把 token 交给了谁。
      const run = async (reqBody) => {
        const log = { remembered: [], sent: [] };
        let handler = null;
        const box = {
          app: { post: (_p, h) => { handler = h; } },
          console: { log() {}, warn() {} }, JSON, String, Object, Array, Error, Promise, Date, Math,
          notLocal: () => false,
          SAY_ALLOWED_SITES: new Set(['xhs']),
          sayCheck: () => null,
          SAY_SENDERS: {
            xhs: async (id, tok, text) => {
              log.sent.push({ id, tok, text });
              return { state: 'submitted', commentId: 'c1', status: 'ok' };
            },
          },
          SAY_DAILY_MAX: 3,
          _sayBusy: false,
          withSayLock: async (fn) => fn(),
          loadSays: () => ({ says: [] }),
          saveSays: () => {},
          saysToday: () => [],
          today: () => '2026-08-24',
          getToken: (id) => 'CACHED-' + id,
          rememberToken: (id, tok) => { log.remembered.push({ id, tok }); },
        };
        vm.createContext(box);
        vm.runInContext(seg[0], box);
        // 走**路由**进去，不直接调 sendComment —— token 的处理有一半在路由体里。
        const res = {
          code: 200, body: null,
          status(c) { this.code = c; return this; },
          json(o) { this.body = o; return this; },
        };
        await handler({ body: reqBody }, res);
        return { log, res };
      };

      const a = await run({ site: 'xhs', id: 'n1', text: '喂', token: 'EXT-TOKEN' });
      t('★ 外带 token 真的被这一次发送用上了（不然「评论一条旧笔记」永远做不到）',
        a.log.sent.length === 1 && a.log.sent[0].tok === 'EXT-TOKEN');
      t('★ 外带 token **不写回缓存**（抄错一个就把缓存里有效的那个顶掉，之后全跟着坏）',
        a.log.remembered.length === 0, JSON.stringify(a.log.remembered));

      const b2 = await run({ site: 'xhs', id: 'n2', text: '喂' });
      t('★ 不带 token 时照旧用缓存里的（外带只是「优先」，不是「取代」）',
        b2.log.sent.length === 1 && b2.log.sent[0].tok === 'CACHED-n2');
      t('★ 不带 token 的请求也不会去写缓存',
        b2.log.remembered.length === 0);

      const c2 = await run({ site: 'bili', id: 'n3', text: '喂', token: 'EXT-TOKEN' });
      t('★ 站点没过关就被拒的请求，一个字都不许落进缓存（校验之前不动共享状态）',
        c2.res.code === 403 && c2.log.remembered.length === 0 && c2.log.sent.length === 0);
    }
  }

  // ── 生产端：xhsExploreFeeds 自己怎么把三态交出去 ──────────────
  // ⚠️ 这一段是被故障注入逼出来的：下面那组桩测试把 xhsExploreFeeds **整个**换掉了，
  // 于是它内部那道「loggedIn:false 要无条件带出去」的守卫**一行都没人跑** ——
  // 拆掉它，44 条断言照样全绿。桩得越干净，被桩掉的那部分就越没人守。
  {
    const sb2 = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8').replace(/\r\n/g, '\n');
    const seg = sb2.match(/async function xhsExploreFeeds\(\) \{[\s\S]*?\n\}/);
    t('抠到了真的 xhsExploreFeeds（抠不到说明改形了，下面的断言作废）', !!seg);
    if (seg) {
      const mkP = (alive, pageResult) => {
        const box = {
          Array, String, JSON, Object, Promise,
          chromeAlive: async () => alive,
          inPage: async () => pageResult,
        };
        vm.createContext(box);
        vm.runInContext(seg[0] + '\nthis.f = xhsExploreFeeds;', box);
        return box.f();
      };
      t('★ Chrome 没跑 → {chromeDown:true}（回 null 的话调用方分不清「没开」和「读不出来」）',
        (await mkP(false, null)).chromeDown === true);
      // 小红书改一次推荐卡的 id 字段，filter 完 items 就空了。原来的
      // `!items.length → return null` 会把**已经读到的** loggedIn:false 一起抹掉。
      t('★ 确认没登录 + items 被解析空了 → 仍旧把 false 带出去，不压成 null',
        (await mkP(true, { loggedIn: false, who: '', items: [] })) !== null
        && (await mkP(true, { loggedIn: false, who: '', items: [] })).loggedIn === false);
      t('★ 判不出来 + items 空 → 才回 null（这种确实没什么可交代的）',
        (await mkP(true, { loggedIn: null, who: '', items: [] })) === null);
      t('★ 正常情况原样带出（含 uid，身份校验要用）',
        (await mkP(true, { loggedIn: true, who: 'SomeNick', uid: 'u1', items: [{ id: 'a' }] })).uid === 'u1');
    }
  }

  // ── 调用方对三态的**政策**：真跑 xhsFeed，不是看它长什么样 ────────
  // Codex 四审逮到的：判据能产出 false，不等于 xhsFeed 会拿它做对的事。
  // 上一轮我只挡了「浏览器没跑」，可 loggedIn === false 更确定 —— 那是浏览器亲口说
  // 「这不是她的号」，反而被放行了，只标一行小字。117 条断言当时全绿，因为没人验消费端。
  // 所以这里把 xhsFeed 的真源码抠出来，把它依赖的东西全换成桩，看它到底走哪条路。
  {
    const srv2 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
    const seg = srv2.match(/async function xhsFeed\(limit\) \{[\s\S]*?\n\}/);
    t('抠到了真的 xhsFeed（抠不到说明改形了，下面的政策断言作废）', !!seg);
    if (seg) {
      const mk = (browserResult) => {
        let socialGetCalls = 0, kicked = 0;
        const box = {
          console: { log() {}, warn() {} }, Math, Number, JSON, String, Object, Array, Error, Promise, Date,
          process,   // xhsFeed 要读 GRANCYAN_XHS_ME（身份校验），不给的话它会当场炸
          require: () => ({ xhsExploreFeeds: async () => browserResult }),
          socialGet: async () => { socialGetCalls++; return { data: '<html></html>' }; },
          xhsParseState: () => ({}), xhsPickFeeds: () => [{ id: 'guest1', noteCard: {} }],
          xhsRememberToken() {}, kickXhsChromeUp() { kicked++; },
        };
        vm.createContext(box);
        vm.runInContext(seg[0] + '\nthis.f = xhsFeed;', box);
        return { run: () => box.f(12), calls: () => socialGetCalls, kicks: () => kicked };
      };
      const grab = async (h) => { try { return { ok: true, v: await h.run() }; } catch (e) { return { ok: false, e }; } };

      const feedOf = (n, lg, who, uid) => ({
        loggedIn: lg, who: who || '', uid: uid || '',
        items: Array.from({ length: n }, (_, i) => ({ id: 'n' + i, xsecToken: 't', title: '标题' + i, author: 'a', likes: '1' })),
      });

      // ① 浏览器没跑
      let h = mk({ chromeDown: true });
      let r = await grab(h);
      t('★ 浏览器没跑：不抓游客流（抓了就是把陌生人的推荐端上桌）', r.ok === false && h.calls() === 0);
      t('★ 浏览器没跑：顺手去拉它（拉了下一次就是她的号）', h.kicks() === 1);
      t('★ 浏览器没跑：错误里说清了怎么办', r.ok === false && /没在跑|已经在开/.test(r.e.message));

      // ② 浏览器开着、确认没登录（Codex 四审这一条）
      h = mk(feedOf(3, false));
      r = await grab(h);
      t('★ 确认没登录：拒绝，不把游客内容当成她的推荐放行', r.ok === false);
      t('★ 确认没登录：不去拉浏览器（它开着，问题是没登录，拉了也没用）', h.kicks() === 0);
      t('★ 确认没登录：告诉她去哪儿登，而不是只报个错', r.ok === false && /登/.test(r.e.message));

      // ③ 判不出来 → 仍旧放行，但必须标明
      h = mk(feedOf(3, null));
      r = await grab(h);
      t('★ 判不出来：放行（给点内容 > 什么都不给），但 guest + whoUnknown 都要带上',
        r.ok && r.v.guest === true && r.v.whoUnknown === true && r.v.items.length === 3);

      // ④ 昵称对上（默认配的就是昵称）→ **只能算判不出**，不许算确认。
      // ⚠️ 这一条的期望被 Codex 六审改过：以前昵称对上就 guest=false，
      // 等于「把昵称改成 SomeNick 的任何人」都能被确认成她。昵称能改、能重名，
      // 不足以作数 —— 现在最好的结果是 whoUnknown，日志里会告诉她该配哪串 uid。
      // ⚠️ 必须**显式**配成昵称：默认值 2026-08-24 已经换成真 uid 了，
      // 不显式设的话这条会走 uid 分支，测的就不是「昵称模式」了。
      process.env.GRANCYAN_XHS_ME = 'SomeNick';
      h = mk(feedOf(3, true, 'SomeNick', 'realuid0123456789abcdef'));
      r = await grab(h);
      t('★ 昵称对上但配的是昵称：放行、标 whoUnknown，**不算确认**（昵称能改能重名）',
        r.ok && r.v.guest === true && r.v.whoUnknown === true && r.v.who === 'SomeNick');
      delete process.env.GRANCYAN_XHS_ME;

      // ⑤ 浏览器开着但这条路没走通（null）→ 才是游客流该出场的唯一场景
      h = mk(null);
      r = await grab(h);
      t('★ 浏览器开着但读不出来：这才回落游客流，且标 guest',
        r.ok && h.calls() === 1 && r.v.guest === true);

      // ⑥ 登着**别人的**号（Codex 五审）：loggedIn === true 只说明「有号登着」，
      // 不说明「是用户配的那个号」。放行的话，前端 guest:false，整屏陌生人的内容被
      // 当成用户的品味来聊 —— 跟这次要修的原始 bug 一模一样，只是换了个入口。
      // 配的是 uid 模式，所以别人的号要给一个**不同的 uid** —— 只换昵称不够了。
      process.env.GRANCYAN_XHS_ME = 'a1b2c3d4e5f60718';
      h = mk(feedOf(3, true, 'SomebodyElse', 'deadbeefdeadbeef01'));
      r = await grab(h);
      t('★ 登着别人的号：拒绝，不把别人的推荐当成她的（true ≠ 是她）', r.ok === false);
      t('★ 登着别人的号：错误里说清登的是谁、怎么改', r.ok === false && /SomebodyElse/.test(r.e.message));
      t('★ 登着别人的号：不去抓游客流', h.calls() === 0);
      delete process.env.GRANCYAN_XHS_ME;

      // ⑦ 确认没登录 + items 空（Codex 五审）：内容解析失败不该把**身份的事实**抹掉。
      // 小红书改一次推荐卡的 id 字段，filter 完 items 就空了 —— 原来的写法会因此
      // 看不到 loggedIn:false，转头回落游客流。
      h = mk({ loggedIn: false, who: '', uid: '', items: [] });
      r = await grab(h);
      t('★ 确认没登录 + 一条内容都没解析出来：仍旧拒绝，不因为「没内容」就退回游客流',
        r.ok === false && h.calls() === 0);

      // ⑧ 不校验身份（GRANCYAN_XHS_ME 显式设成空）→ 不假装确认过
      process.env.GRANCYAN_XHS_ME = '';
      h = mk(feedOf(3, true, 'SomebodyElse'));
      r = await grab(h);
      t('★ 显式关掉身份校验：放行但标 whoUnknown（不假装确认过，也不拦她）',
        r.ok && r.v.guest === true && r.v.whoUnknown === true && r.v.who === 'SomebodyElse');
      delete process.env.GRANCYAN_XHS_ME;

      // ── 身份校验：uid 优先，昵称不许顶（Codex 六审）──────────────
      // 六审复现的失败场景：别人把昵称改成「SomeNick」，uid 明明是别人的，
      // 但判据写的是 `uid对上 || 昵称对上`，昵称那半把 uid 那半整个抵消了 ——
      // 「五审加了 uid」的安全效果等于零。测试当时只验了「uid 被传出来」
      // 和「昵称对上就放行」，恰好绕开了这一格。
      const MY_UID = 'a1b2c3d4e5f60718';

      // ⑨ 配了 uid 且对得上 → 这才是唯一能拿到「确认」的路
      process.env.GRANCYAN_XHS_ME = MY_UID;
      h = mk(feedOf(3, true, 'SomeNick', MY_UID));
      r = await grab(h);
      t('★ 配了 uid 且对得上：guest=false，确认是她的号',
        r.ok && r.v.guest === false && r.v.whoUnknown === false);

      // ⑩ 配了 uid，昵称一模一样但 uid 不是她 → 必须拒绝（就是 Codex 复现的那条）
      h = mk(feedOf(3, true, 'SomeNick', 'ffffffffffffffff'));
      r = await grab(h);
      t('★ 昵称冒名 + uid 明确不符：拒绝，昵称不许把 uid 的判定顶掉',
        r.ok === false);
      t('★ 昵称冒名：不去抓游客流', h.calls() === 0);

      // ⑪ 配了 uid，但这次页面没读出 uid → 判不出，昵称同样不许顶上来
      h = mk(feedOf(3, true, 'SomeNick', ''));
      r = await grab(h);
      t('★ 配了 uid 但对方 uid 读不到：算判不出（whoUnknown），不拿昵称冒充确认',
        r.ok && r.v.guest === true && r.v.whoUnknown === true);
      delete process.env.GRANCYAN_XHS_ME;

      // ⑫ 昵称模式下的冒名：也不能被确认成她
      process.env.GRANCYAN_XHS_ME = 'SomeNick';
      h = mk(feedOf(3, true, 'SomeNick', 'ffffffffffffffff'));
      r = await grab(h);
      t('★ 昵称模式 + 冒名昵称：也只能是 whoUnknown，绝不能 guest=false',
        r.ok && r.v.guest === true && r.v.whoUnknown === true);
      delete process.env.GRANCYAN_XHS_ME;

      // ⑬ 默认值本身：不配环境变量 = 不校验身份。代码里不内置任何人的 uid，
      // 所以默认情况下谁的号都不能被「确认」，只能是 whoUnknown。
      // 哪天有人往默认值里塞回一个具体的号，这里会红。
      h = mk(feedOf(3, true, 'SomeNick', '0000000000000000000000b0'));
      r = await grab(h);
      t('★ 默认配置（不设环境变量）：不确认任何号，算 whoUnknown',
        r.ok && r.v.guest === true && r.v.whoUnknown === true);
      const srvSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
      t('★ 默认值里没有写死的 uid', /const me = String\(process\.env\.GRANCYAN_XHS_ME \|\| ''\)\.trim\(\);/.test(srvSrc));
    }
  }
}

// ── [3.5] Codex 审出来的四类缺口 ─────────────────────────
// 这一节全部是二审前不存在的场景。加在这里是因为它们都属于「绿着也是错的」那类：
// 原实现每条都能跑、每条都不报错，坏在并发、坏在没有 blocks、坏在上游使坏。
console.log('\n[3.5] 并发 / content 路径 / 上限 / 危险链接');

// ① 危险协议：RSS 条目的 link 由第三方站点完全控制
const S = sandbox._gazeSafeUrl;
t('★ javascript: 链接被判死', S('javascript:alert(1)') === '');
t('★ 大小写和空白绕不过去', S('  JaVaScRiPt:alert(1)  ') === '');
t('★ data: 也判死（内联 HTML 同样能执行脚本）', S('data:text/html,<script>x</script>') === '');
t('http/https 正常放行', S('https://example.com/a') === 'https://example.com/a' && S('http://a.cn') === 'http://a.cn');
t('★ 恶意 link 降级成纯文本，不生成可点的 <a>', (() => {
  const f = F('rss_read', { json: { ok: true, entries: [{ title: 'T', link: 'javascript:alert(1)' }] } });
  return !/<a\s/.test(f.body) && f.body.includes('javascript:alert(1)');   // 文字还在，但不可点
})());
t('★ 恶意图片地址不生成 <img>', sandbox._gazeImgHtml('javascript:alert(1)', '') === '');

// ② 每轮上限：提示词管不住模型，代码得管。
//    验行为不验常量 —— const 不会挂到 vm 的 context 上，读常量只会拿到 undefined。
t('★ 一轮四条指令，只有前两条真的发出去', await (async () => {
  let calls = 0;
  sandbox.fetch = () => { calls++; return Promise.resolve({
    ok: true, json: async () => ({ ok: true, data: { text: '{"ok":true,"sentence":"x"}' } }) }); };
  const rs = await sandbox.prefetchGazeCommands(
    '[[GAZE: daily_poem]][[GAZE: sky_tonight]][[GAZE: apod]][[GAZE: shelf]]', { id: 'x', engawaOn: true });
  // 四条都要有结果（超限的那两条给的是「本轮已达上限」），否则裸标签会漏在气泡里
  return calls === 2 && rs.length === 4
      && /已经看了/.test(rs[2].r.err || '') && /已经看了/.test(rs[3].r.err || '');
})());

// ③ rss_read 的书架名可能带空格
t('★ 书架名带数字结尾不再被切开（Channel 4 不能变成 Channel + limit=4）',
  P('rss_read Channel 4').args.feed_url === 'Channel 4' && P('rss_read Channel 4').args.limit === undefined);
t('web_read 的 offset 摘取不受影响', P('web_read https://a.com/x 500').args.offset === 500);

// ④ content 路径：blocks 为空时不能留裸指令
// 跑真的 processAiCommands（04-memory.js），不是复述逻辑。
const memSrc = fs.readFileSync(path.join(JS, '04-memory.js'), 'utf8');
// ⚠️ 这两条以前是 grep 源码的（/gazeTagRe|\[\[GAZE:/.test(memSrc) 之类），
// 而文件开头就写着「能真跑就别验源码正则」。代价是真的付出来了：
// content 路径退化成只认 GAZE 时它们照绿，重构换个写法反倒假红。现在跑真函数。
// 结果放在 r.json 里，不是 r 上 —— 写错的话檐廊块 body 是空的，
// 而「块在不在」照样绿，只有验正文的断言才逮得住。
const _mkR = (kind, cmd, txt) => ({ kind, cmd, tool: 'daily_poem', r: { json: { sentence: txt } } });
t('★ content 路径真的存在，且填的是结果块不是裸指令', (() => {
  const out = sandbox.applyGazeToText('看看\n[[GAZE: daily_poem]]\n就这些',
    [_mkR('gaze', 'daily_poem', '春眠不觉晓')], { id: 'x', engawaOn: true });
  return !/\[\[GAZE:/.test(out) && /think-block/.test(out);
})());
t('★ 没开功能时裸指令被抹掉，不漏给用户看见', (() => {
  const off = sandbox.applyGazeToText('前[[GAZE: daily_poem]]中[[SAY: xhs abc123ff 好可爱]]后',
    [], { id: 'x', engawaOn: false });
  // 两种标签都要抹干净：只抹 GAZE 的话裸 [[SAY:]] 会漏给用户，还会教模型下一轮接着写
  return off === '前中后';
})());
t('★ GAZE / SAY 混排按出现顺序对号入座（只认 GAZE 的话会吃掉 SAY 那条的结果）', (() => {
  const out = sandbox.applyGazeToText('[[SAY: xhs abc123ff 好可爱]]和[[GAZE: daily_poem]]',
    [{ kind: 'say', cmd: 'xhs abc123ff 好可爱', tool: 'xhs', r: { said: '好可爱', json: { state: 'submitted' } } },
     _mkR('gaze', 'daily_poem', '春眠不觉晓')],
    { id: 'x', engawaOn: true });
  const iSay = out.indexOf('在外面说了一句'), iGaze = out.indexOf('🪟 檐廊');
  // 顺序不能反，而且两块都要在 —— 错位时会变成「檐廊块里装着说话的结果」
  return iSay >= 0 && iGaze >= 0 && iSay < iGaze
      && /好可爱/.test(out) && /春眠不觉晓/.test(out) && !/\[\[/.test(out);
})());
t('★ SAY 的结果走说话块，不被当成檐廊结果渲染（kind 漏传就会）', (() => {
  const out = sandbox.applyGazeToText('[[SAY: xhs abc123ff 好可爱]]',
    [{ kind: 'say', cmd: 'xhs abc123ff 好可爱', tool: 'xhs', r: { said: '好可爱', json: { state: 'submitted' } } }],
    { id: 'x', engawaOn: true });
  return /在外面说了一句/.test(out) && !/🪟 檐廊/.test(out);
})());
t('★ content 路径和 blocks 路径共用同一个实现（各写各的必然漂移）',
  // 只认**调用**（gazeTagRe(）—— 注释里提到这个名字是合理的（那条注释正是在说别用它）
  memSrc.includes('applyGazeToText') && !/gazeTagRe\s*\(/.test(memSrc));
t('★ content 路径从 studyCtx 拿结果（不读全局单槽，否则并发串线）',
  memSrc.includes('studyCtx.gazeResults'));

// ⑤ 并发不串线：两轮 prefetch 交错跑，各自的结果不能互相污染。
// 用桩 fetch 制造「A 先发起、B 后发起但先返回」的真实交错。
t('★ 两个并发预取各拿各的结果，不互相覆盖', await (async () => {
  const calls = [];
  sandbox.fetch = (url, opt) => {
    const tool = JSON.parse(opt.body).tool;
    // B（sky_tonight）故意比 A（daily_poem）先返回，制造交错
    const delay = tool === 'daily_poem' ? 40 : 5;
    calls.push(tool);
    return new Promise(res => setTimeout(() => res({
      ok: true, json: async () => ({ ok: true, data: { text: JSON.stringify({ ok: true, sentence: tool }) } }),
    }), delay));
  };
  const confA = { id: 'A', engawaOn: true }, confB = { id: 'B', engawaOn: true };
  const [ra, rb] = await Promise.all([
    sandbox.prefetchGazeCommands('[[GAZE: daily_poem]]', confA),
    sandbox.prefetchGazeCommands('[[GAZE: sky_tonight]]', confB),
  ]);
  // 各自返回值必须对应各自的指令 —— 用全局单槽的话这里会拿到对方的结果
  return ra.length === 1 && rb.length === 1
      && ra[0].tool === 'daily_poem' && rb[0].tool === 'sky_tonight';
})());

t('★ 回填用传进来的那份结果，不吃全局缓存', (() => {
  const mine = [{ cmd: 'daily_poem', tool: 'daily_poem', r: { json: { ok: true, sentence: '我的诗' } } }];
  sandbox._gazeResultCache = [{ cmd: 'x', tool: 'daily_poem', r: { json: { ok: true, sentence: '别人的诗' } } }];
  const blocks = [{ type: 'text', text: '看 [[GAZE: daily_poem]]' }];
  sandbox._applyGazeToBlocks(blocks, mine);
  return blocks[0].text.includes('我的诗') && !blocks[0].text.includes('别人的诗');
})());

// ⑤b 功能关掉时，blocks 路径也不能留裸指令。
// 二审逮到的：content 路径有 enabled 判断、blocks 路径没有，而渲染层以 blocks 为准，
// 所以关了功能之后模型只要还照着历史写 [[GAZE:]]，用户就会看到裸指令。
t('★ 功能关闭 + 非空 blocks 时，裸指令被抹掉（不是留在气泡里）', (() => {
  sandbox.state.engawaOn = false;
  const blocks = [{ type: 'text', text: '喂 [[GAZE: daily_poem]] 喂' }];
  sandbox._applyGazeToBlocks(blocks, [], { id: 'x', engawaOn: false });
  sandbox.state.engawaOn = true;
  return !blocks[0].text.includes('[[GAZE') && blocks[0].text.includes('喂');
})());
t('功能开着时照常填结果（别把上一条改成一律抹掉）', (() => {
  const blocks = [{ type: 'text', text: '看 [[GAZE: daily_poem]]' }];
  sandbox._applyGazeToBlocks(blocks, [{ cmd: 'daily_poem', tool: 'daily_poem', r: { json: { ok: true, sentence: '有诗' } } }], { id: 'x', engawaOn: true });
  return blocks[0].text.includes('有诗');
})());
t('不传 conf 时沿用旧行为，不误伤老调用点', (() => {
  const blocks = [{ type: 'text', text: '原样 [[GAZE: daily_poem]]' }];
  sandbox._gazeResultCache = [];
  sandbox._applyGazeToBlocks(blocks, []);
  return blocks[0].text.includes('[[GAZE');
})());

// ⑥ SSE 按 id 认领（server.js 的函数，从源码里抠出来跑真的）
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sseSrc = serverSrc.match(/function engawaParseSse\(body, wantId\)[\s\S]*?\n\}/);
t('取到了真的 engawaParseSse', !!sseSrc);
if (sseSrc) {
  const sseBox = { JSON, String };
  vm.createContext(sseBox);
  vm.runInContext(sseSrc[0], sseBox);
  const withNotice =
    'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"真结果"}]}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"x":1}}\n\n';
  t('★ 结果后面跟通知时，认领的是自己那条（取最后一条会拿到通知）',
    sseBox.engawaParseSse(withNotice, 7)?.result?.content?.[0]?.text === '真结果');
  t('★ 通知没有 id，不会被当成结果', sseBox.engawaParseSse(
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n', 7) === null);
  t('不传 wantId 时退回旧行为（拿第一条）',
    sseBox.engawaParseSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n')?.result?.a === 1);
  // 二审第 2 条：只有别人的 id 时必须空手而归 —— 顺手拿一个顶上比空手更坏，
  // 那是把另一个请求的答案安到这次头上，而且完全不报错。
  t('★ 流里只有别人的 id 时返回 null（绝不拿别人的响应顶上）',
    sseBox.engawaParseSse('event: message\ndata: {"jsonrpc":"2.0","id":999,"result":{"a":1}}\n\n', 7) === null);
  t('★ 纯 JSON 对象也核对 id，不直接放行',
    sseBox.engawaParseSse({ jsonrpc: '2.0', id: 999, result: { a: 1 } }, 7) === null
    && sseBox.engawaParseSse({ jsonrpc: '2.0', id: 7, result: { a: 1 } }, 7)?.result?.a === 1);
}

// ⑦ session 失效判定：400 不能一律当失效
const deadSrc = serverSrc.match(/function engawaSessionDead\(r\)[\s\S]*?\n\}/);
t('取到了真的 engawaSessionDead', !!deadSrc);
if (deadSrc) {
  const dBox = { JSON, String };
  vm.createContext(dBox);
  vm.runInContext(deadSrc[0], dBox);
  const D = dBox.engawaSessionDead;
  t('404 判为 session 失效', D({ status: 404, data: '' }) === true);
  t('★ 参数非法的 400 不当 session 失效（否则真实错误被吞掉）',
    D({ status: 400, data: { error: { message: 'Invalid arguments: url is required' } } }) === false);
  t('明说 session 无效的 400 才重握手',
    D({ status: 400, data: 'Bad Request: Missing session ID' }) === true);
  t('200 当然不是失效', D({ status: 200, data: '' }) === false);
}

// ⑧ 裸命令名不存在时的报错方向（二审第 3 条）
// ENGAWA_BIN 是裸命令名时 engawaInstalled() 恒为 true，
// 全靠 spawn 的 error 事件区分「没装」和「装了起不来」，否则会白等满 10 秒、
// 还报一句方向相反的「引擎装了但启动失败」。
t('★ spawn 的 ENOENT 被接住并中断等待（不再傻等 10 秒）',
  /_engawaSpawnErr\s*=\s*e/.test(serverSrc) && /if \(_engawaSpawnErr\)[\s\S]{0,200}return false/.test(serverSrc));
t('★ 错误文案按真实原因分岔（ENOENT → 说"没找到"，不说"装了但起不来"）',
  /_engawaSpawnErr\?\.code === 'ENOENT'/.test(serverSrc));
// ⚠️ 这条原来写成 `_engawaSpawnErr = null;[\s\S]{0,80}try \{[\s\S]{0,120}spawn\(ENGAWA_BIN`，
// 卡在**字符距离**上：2026-09-19 在 spawn 前面插了几行注释和一个分支，断言就红了，
// 而它守的行为一点没变。判据改成问真正要问的那件事 ——
// 「清零这一步，在函数体里排在第一次 spawn 前面」。
// 反面照样红：删掉清零 → indexOf 是 -1；挪到 spawn 后面 → 顺序判假。
const ensureSrc = serverSrc.match(/function ensureEngawaEngine\(\) \{[\s\S]*?\n\}\n/);
t('取到了真的 ensureEngawaEngine', !!ensureSrc);
t('每次拉起前先清掉上一次的失败原因（否则一次失败会永久钉死判断）', (() => {
  if (!ensureSrc) return false;
  const iClear = ensureSrc[0].indexOf('_engawaSpawnErr = null');
  const iSpawn = ensureSrc[0].indexOf('spawn(');
  return iClear >= 0 && iSpawn >= 0 && iClear < iSpawn;
})());

// ⑧.5 别再弹那个关不掉的黑窗口（2026-09-19 复发）
// engawa-mcp.exe 是 console 子系统的入口点，`detached` 起它必然新开一个控制台窗口
// （DETACHED_PROCESS 继承不到父控制台；windowsHide 和它是互斥的 CreateProcess 标志，
// 写了也白写）。而 uvicorn 是常驻的 —— 那个窗口就永远挂在任务栏上。
// 所以这里钉死组合规则，不是钉死某一种写法：**detached 那条路只许交给 pythonw**
// （GUI 子系统，压根不分配控制台）；走 ENGAWA_BIN 那条就必须没有 detached、有 windowsHide。
if (ensureSrc) {
  // 把函数体里每个 spawn(...) 的调用连同它的 options 抠出来逐个问
  const calls = ensureSrc[0].match(/spawn\((?:[^()]|\([^()]*\))*\)/g) || [];
  t('檐廊拉起至少有一处 spawn（锚点没飘）', calls.length >= 1);
  const bad = calls.filter(c => /detached:\s*true/.test(c) && /ENGAWA_BIN/.test(c));
  t('★ detached 不许用在 console 入口上（黑窗口关不掉的真凶）',
    bad.length === 0, bad[0]);
  const conso = calls.filter(c => /ENGAWA_BIN/.test(c));
  t('★ 走 ENGAWA_BIN 的那条必须带 windowsHide（它在非 detached 下才生效）',
    conso.length > 0 && conso.every(c => /windowsHide:\s*true/.test(c)));
  t('★ 有一条走 pythonw 的静默路（拿得到就该走它）',
    calls.some(c => /pyw|pythonw/i.test(c)));
}

// ── [3.6] 收件箱那一栏怎么显示 ────────────────────────────
// 这一栏和别的不一样：**内容是别人写的**（陌生人的昵称、评论、私信）。
// 所以两件事必须验：转义，和「判不出来的别说成判出来了」。
console.log('\n[3.6] 有人回我了');
const _ih = (o) => sandbox._inboxHtml(o);
t('还没查过 → 告诉她去点按钮，不是显示成「没有动静」',
  /还没查过/.test(_ih({ ok: true, never: true, items: [] })));
t('通道没起来 → 照实说读不到（不是「没有动静」）',
  /读不到收件箱/.test(_ih(null)));

const chatUnsure = { ok: true, lastPollAt: 1, items: [
  { kind: 'chat', at: 1, who: '甲', text: '在吗', unread: 0, certain: false, fresh: true } ] };
const chatSure = { ok: true, lastPollAt: 1, items: [
  { kind: 'chat', at: 1, who: '甲', text: '在吗', unread: 2, certain: true, fresh: true } ] };
t('★★ 拿不准是谁发的 → 界面上必须写出来（这是最容易也最贵的一句假话）',
  /拿不准/.test(_ih(chatUnsure)));
t('   而且不许同时挂着「N 条未读」那种确定的说法', !/条未读/.test(_ih(chatUnsure)));
t('确定有未读的才显示未读数（对照组：不能一律显示「拿不准」蒙混过关）',
  /2 条未读/.test(_ih(chatSure)) && !/拿不准/.test(_ih(chatSure)));

t('★ 上次刷失败了要摆在脸上（不摆的话，看板永远显示上一次成功的时间）',
  /没登录/.test(_ih({ ok: true, lastPollAt: 1, lastPollError: '没登录', items: [] })));
t('★ 某一路没读到 → 说清「这块是空的，不是真没有」',
  /不是真没有/.test(_ih({ ok: true, lastPollAt: 1, missing: ['mentions'], items: [] })));
t('自己评论自己的那条要标出来', /这是我自己发的/.test(_ih({ ok: true, lastPollAt: 1, items: [
  { kind: 'mention', at: 1, who: '克克', title: '评论了你的笔记', text: 'hi', self: true, note: {} } ] })));
t('笔记被删了也要标（不然「去回一条」会失败得莫名其妙）',
  /已删除/.test(_ih({ ok: true, lastPollAt: 1, items: [
    { kind: 'mention', at: 1, who: '甲', title: '评论了你的笔记', text: 'hi', note: { id: 'n', title: 't', deleted: true } } ] })));

// ⚠️ 昵称和正文是**陌生人写的**，直接塞进 innerHTML 就是把评论区交给别人当脚本注入口。
const evil = '<img src=x onerror=alert(1)>';
const evilHtml = _ih({ ok: true, lastPollAt: 1, me: { nickname: evil }, lastPollError: evil, missing: [evil], items: [
  { kind: 'chat', at: 1, who: evil, text: evil, unread: 1, certain: true },
  { kind: 'mention', at: 1, who: evil, title: evil, text: evil, note: { id: 'n', title: evil } } ] });
t('★★ 别人写的东西全部转义（昵称、正文、笔记标题、报错、missing 都算）',
  !/<img src=x/.test(evilHtml) && (evilHtml.match(/&lt;img src=x/g) || []).length >= 7,
  (evilHtml.match(/&lt;img src=x/g) || []).length);

// ── [4] 流式遮罩 ──────────────────────────────────────────
console.log('\n[4] 流式遮罩');
const M = sandbox.maskStreamingGaze;
t('完整指令在打字时不裸奔', !M('看看天 [[GAZE: sky_tonight]] 好').includes('[[GAZE'));
t('★ 打了一半的指令也遮住（流式最常见的中间态）', !M('看看天 [[GAZE: sky_ton').includes('[[GAZE'));
t('没有指令时原样返回（别白跑正则）', M('普通文本') === '普通文本');

// ── [5] 挂载点 ────────────────────────────────────────────
// 这些没法跑，只能验源码。漏任何一条都是**零报错**的静默失效。
console.log('\n[5] 挂载点');
t('index.html 引入了 40-engawa.js', html.includes('js/40-engawa.js'));
t('小组件入口在', html.includes('openWidget(openEngawa)') && html.includes('id="engawaModal"'));
t('系统提示进 volatile 段（不是 stable，否则每天诗变了缓存全废）',
  apiSrc.includes('vol += engawaPromptFor()'));
t('★ 只给勾选过的模型注入（没勾的一个 token 都不该烧）',
  apiSrc.includes('engawaEnabledFor(conf)') && engawaSrc.includes('state.engawaOn && conf && conf.engawaOn'));
t('流式遮罩已登记进 _STREAM_MASKS', /_STREAM_MASKS = \[[^\]]*'maskStreamingGaze'/.test(apiSrc));

// 预取和回填必须**三条出口都挂**：非流式、流式、以及 06-render-msg 的重生成路径。
// 漏一条的症状是「有时能用有时不能用」，最难查。
// 数的是**实际调用点**，不是名字出现次数 —— 每处挂载都写成
// `if (typeof fn === 'function') await fn(...)`，名字一处出现两次。
const prefetchHits = (apiSrc.match(/await prefetchGazeCommands\(/g) || []).length
  + (renderSrc.match(/await prefetchGazeCommands\(/g) || []).length;
// 签名是 (blocks, gazeResults, conf)：
//   少了 gazeResults → 退回全局单槽，并发串线；
//   少了 conf        → 功能关闭时裸指令留在 blocks 里漏给用户（二审第 1 条）。
const APPLY_FULL = /_applyGazeToBlocks\(blocks,\s*gazeResults,\s*conf\)/g;
const applyHits = (apiSrc.match(APPLY_FULL) || []).length + (renderSrc.match(APPLY_FULL) || []).length;
const implicitApply = (apiSrc + renderSrc).match(/_applyGazeToBlocks\(blocks\s*(?:,\s*gazeResults\s*)?\)/g) || [];
t('★ 没有任何调用点省略参数（省 results = 并发串线；省 conf = 关闭时漏裸指令）',
  implicitApply.length === 0, implicitApply);
const prefetchThreaded = (apiSrc.match(/await prefetchGazeCommands\(/g) || []).length
  + (renderSrc.match(/await prefetchGazeCommands\(/g) || []).length;
t('★ 三条出口都接住了预取的返回值', prefetchThreaded === 3, prefetchThreaded);
t('★ 预取挂在全部三条出口上', prefetchHits === 3, prefetchHits);
t('★ blocks 回填挂在全部三条出口上（blocks 非空时渲染层完全不看 content）', applyHits === 3, applyHits);

console.log('\n[6] 持久化三道闸（漏一道 = 刷新后开关悄悄弹回去，零报错）');
t('第 1 道：loadStateFromDB 的读白名单', /engawaOn:\s*await g\('kuro_engawaOn'/.test(coreSrc));
t('第 2 道：_doSave 的写白名单', /idbSet\('kuro_engawaOn'/.test(stateSrc));
t('第 3 道：启动赋值块', /state\.engawaOn\s*=\s*!!saved\.engawaOn/.test(bootSrc));

console.log('\n[7] 样式');
t('面板有配套 CSS（按钮排、内容区、图）',
  css.includes('.engawa-actions') && css.includes('.engawa-body') && css.includes('.engawa-img'));
t('走主题变量不写死颜色（用户换主题时跟着变）',
  /\.engawa-card-body\s*\{[^}]*var\(--text-primary\)/.test(css) && !/\.engawa-(actions|body|card)[^{]*\{[^}]*#[0-9a-fA-F]{6}/.test(css));

// ── [8] 桌面与安卓副本一致 ────────────────────────────────
console.log('\n[8] 桌面与安卓副本一致');
const ANDROID_SYNCED = ['40-engawa.js', '04-memory.js', '05-prompts-api.js', '06-render-msg.js',
  '01-core.js', '02-state.js', '14-boot-brain-hub.js',
  '09-appearance-input.js',    // 渲染消毒认 _gazeImgFail（凝视卡片图片挂了的重试）
  '61-errand.js'];             // 跑腿借 gazeCall / _gazeSafeUrl 读网页
const outOfSync = ANDROID_SYNCED.filter(f =>
  !fs.readFileSync(path.join(JS, f)).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f))));
t('android 副本与 js/ 逐字节一致', outOfSync.length === 0, outOfSync);

// 名单本身也要有人看着：js/ 里凡是提到檐廊标识符的文件
// 都得在名单里，漏一个就是「桌面对、APK 错」。
// 匹配标识符不是裸 "gaze"/"engawa"，免得被无关词命中让这条永远绿。
const GAZE_IDENT = /\bgaze[A-Z]\w*|\b_gaze[A-Z]\w*|\bGAZE_[A-Z]|\bengawa[A-Z]\w*|\bmaskStreamingGaze\b|state\.engawaOn|kuro_engawaOn/;
const touched = fs.readdirSync(JS).filter(f => f.endsWith('.js') && GAZE_IDENT.test(fs.readFileSync(path.join(JS, f), 'utf8')));
t('   凡是提到檐廊的文件都在同步名单里', touched.every(f => ANDROID_SYNCED.includes(f)),
  touched.filter(f => !ANDROID_SYNCED.includes(f)));
t('android 的 index.html / css 也同步了',
  fs.readFileSync(path.join(ROOT, 'index.html')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html'))) &&
  fs.readFileSync(path.join(ROOT, 'css/grancyan.css')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/css/grancyan.css'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('测试脚本自己炸了：', e); process.exit(1); });
